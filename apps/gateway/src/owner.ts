// Listing ownership: before a self-serve listing is paid to a payout address, the lister can prove it
// controls the API's host, in one of two ways:
//
//   DNS    a TXT record at `_fermata.<host>` whose value is `fermata-payout=<payout address>`;
//   HTTPS  `https://<host>/.well-known/fermata.json` containing `{"payout": "<payout address>"}`.
//
// The proof must name the exact payout the listing asks to be paid to (a proof for another address
// does not count), and the host must match exactly (a record for example.com does not prove
// api.example.com). What it proves: control of the host's DNS or web root when it was checked, not
// who wrote the API. Unverified listings are allowed unless the gateway requires a proof, and are
// labelled as such wherever the listing appears.
import { resolveTxt } from 'node:dns/promises'
import { connect as tlsConnect, rootCertificates, type TLSSocket } from 'node:tls'
import { isAddress, isAddressEqual, type Address } from 'viem'
import { decodeChunked, guardUrl, tunnel, type Resolver, type SafeTarget } from './onboard.ts'

export type OwnerMethod = 'dns' | 'well-known'

/** The outcome of an ownership check, as stored with the listing. */
export type OwnerProof = {
  verified: boolean
  method?: OwnerMethod
  /** ISO time of the check. */
  checkedAt: string
  /** What was found (or why each way failed), for the lister. */
  detail: string
}

/** What the lister has to publish, for the payout it chose. */
export function ownerInstructions(host: string, payout: Address) {
  return {
    dns: { name: `_fermata.${host}`, type: 'TXT', value: `fermata-payout=${payout}` },
    wellKnown: { url: `https://${host}/.well-known/fermata.json`, body: JSON.stringify({ payout }) },
  }
}

export type TxtResolver = (name: string) => Promise<string[][]>

/** True when one of the TXT records says `fermata-payout=<payout>` (a record split in chunks is joined). */
export function txtNamesPayout(records: string[][], payout: Address): boolean {
  return records.some((chunks) => {
    const m = /^fermata-payout=(0x[0-9a-fA-F]{40})$/.exec(chunks.join('').trim())
    return !!m && isAddress(m[1]!) && isAddressEqual(m[1] as Address, payout)
  })
}

/** True when a `.well-known/fermata.json` body names `payout`. */
export function wellKnownNamesPayout(body: string, payout: Address): boolean {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return false
  }
  const p = (json as { payout?: unknown } | null)?.payout
  return typeof p === 'string' && isAddress(p) && isAddressEqual(p as Address, payout)
}

const WELL_KNOWN_MAX = 4096
const TIMEOUT_MS = 5_000

const timeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`${what} timed out after ${ms / 1000} s`)), ms).unref?.())])

/**
 * GET https://<host>/.well-known/fermata.json: only from an address the SSRF guard accepted (or
 * through the gateway's egress proxy), certificate checked against Mozilla's roots, no redirects,
 * at most 4 KB. Returns the body of a 200, or throws a reason.
 */
export async function fetchWellKnown(
  t: SafeTarget,
  opts: { proxy?: string; timeoutMs?: number; /** tests only */ ca?: string[]; /** tests only */ port?: number } = {},
): Promise<string> {
  const raw = opts.proxy ? await tunnel(opts.proxy, t.host) : undefined
  const socket: TLSSocket = tlsConnect({
    ...(raw ? { socket: raw } : { host: t.addresses[0], port: opts.port ?? 443 }),
    servername: t.host,
    ca: opts.ca ?? [...rootCertificates],
    rejectUnauthorized: true,
  })
  const timer = setTimeout(() => socket.destroy(new Error('no answer in time')), opts.timeoutMs ?? TIMEOUT_MS)
  try {
    await new Promise<void>((ok, fail) => (socket.once('secureConnect', ok), socket.once('error', fail)))
    socket.write(`GET /.well-known/fermata.json HTTP/1.1\r\nHost: ${t.host}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`)
    const chunks: Buffer[] = []
    let total = 0
    await new Promise<void>((ok, fail) => {
      socket.on('data', (d: Buffer) => {
        total += d.length
        if (total > WELL_KNOWN_MAX + 4096) socket.destroy(new Error(`larger than ${WELL_KNOWN_MAX} bytes`))
        else chunks.push(d)
      })
      socket.once('end', ok)
      socket.once('close', ok)
      socket.once('error', fail)
    })
    const buf = Buffer.concat(chunks)
    const sep = buf.indexOf('\r\n\r\n')
    if (sep < 0) throw new Error('no HTTP response')
    const head = buf.subarray(0, sep).toString('latin1').split('\r\n')
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? '')?.[1])
    if (status >= 300 && status < 400) throw new Error(`HTTP ${status}: redirects are not followed; serve the file at this exact URL`)
    if (status !== 200) throw new Error(`HTTP ${status || '?'}`)
    let body: Buffer = buf.subarray(sep + 4)
    if (head.some((l) => /^transfer-encoding:.*chunked/i.test(l))) body = decodeChunked(body)
    if (body.length > WELL_KNOWN_MAX) throw new Error(`larger than ${WELL_KNOWN_MAX} bytes`)
    return body.toString('utf8')
  } finally {
    clearTimeout(timer)
    socket.destroy()
  }
}

export type OwnerCheckDeps = {
  resolveTxt?: TxtResolver
  /** The SSRF guard's resolver (tests). */
  resolve?: Resolver
  fetchWellKnown?: (t: SafeTarget) => Promise<string>
  now?: () => number
}

/** Checks both proofs for `host` naming `payout`: DNS first, then the well-known file. Never throws. */
export async function checkOwner(host: string, payout: Address, deps: OwnerCheckDeps = {}): Promise<OwnerProof> {
  const checkedAt = new Date((deps.now ?? Date.now)()).toISOString()
  const name = `_fermata.${host}`
  let dns: string
  try {
    const records = await timeout((deps.resolveTxt ?? resolveTxt)(name), TIMEOUT_MS, 'DNS lookup')
    if (txtNamesPayout(records, payout)) return { verified: true, method: 'dns', checkedAt, detail: `TXT ${name} names ${payout}` }
    dns = records.length ? `TXT ${name} does not say fermata-payout=${payout}` : `no TXT record at ${name}`
  } catch (e) {
    const code = (e as { code?: string }).code
    dns = code === 'ENOTFOUND' || code === 'ENODATA' ? `no TXT record at ${name}` : `DNS lookup of ${name} failed (${(e as Error).message})`
  }
  let wellKnown: string
  try {
    const t = await guardUrl(`https://${host}/.well-known/fermata.json`, deps.resolve)
    const body = await (deps.fetchWellKnown ?? fetchWellKnown)(t)
    if (wellKnownNamesPayout(body, payout)) return { verified: true, method: 'well-known', checkedAt, detail: `https://${host}/.well-known/fermata.json names ${payout}` }
    wellKnown = `https://${host}/.well-known/fermata.json does not contain {"payout": "${payout}"}`
  } catch (e) {
    wellKnown = `https://${host}/.well-known/fermata.json: ${(e as Error).message}`
  }
  return { verified: false, checkedAt, detail: `${dns}; ${wellKnown}` }
}
