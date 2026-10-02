// Self-serve vendor onboarding (public mode). A vendor pastes an API URL; the gateway
//   1. checks the URL is safe to fetch (https, port 443, a DNS name resolving only to public
//      addresses: this endpoint must not become a way to reach the server's private network);
//   2. probes the host against TLSNotary's TLS profile (TLS 1.2, AES-128-GCM, P-256, Mozilla roots)
//      and takes one sample response over HTTP/1.1;
//   3. drafts the delivery predicate from that sample (status, content type, size, JSON keys);
//   4. on confirmation, registers the service on-chain with the operator key, writes the predicate
//      for the attestor and adds the service to the running gateway.
//
//   POST /onboard/probe    {url}                                   → sample + drafted predicate
//   POST /onboard/register {url, label, payout, price?, predicate} → serviceId, tx, endpoint, MCP tool
import { lookup } from 'node:dns/promises'
import { isIP, connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, rootCertificates, type TLSSocket } from 'node:tls'
import type { Context, Hono } from 'hono'
import { isAddress, type Address, type Hex } from 'viem'
import { clientIp, DailyCap, RateLimiter } from './limits.ts'

// ------------------------------------------------------------------ 1. which URLs may be fetched

/** True for addresses on the public internet; false for private, loopback, link-local, CGNAT,
 *  multicast, reserved, unspecified and the IPv6 equivalents (incl. IPv4-mapped). */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number]
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 192 && b === 0) return false // 192.0.0.0/24, 192.0.2.0/24 (documentation)
    if (a === 198 && (b === 18 || b === 19)) return false
    return true
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase()
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)
    if (mapped) return isPublicAddress(mapped[1]!)
    if (v === '::' || v === '::1') return false
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff') || v.startsWith('2001:db8')) return false
    return true
  }
  return false
}

export type Resolver = (host: string) => Promise<string[]>
export const dnsResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

export type SafeTarget = { url: URL; origin: string; host: string; target: string; addresses: string[] }

/** Throws a vendor-readable reason unless `raw` is an https URL on port 443 whose DNS name resolves
 *  only to public addresses. */
export async function guardUrl(raw: string, resolve: Resolver = dnsResolver): Promise<SafeTarget> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('not a valid URL')
  }
  if (url.protocol !== 'https:') throw new Error('the URL must be https://')
  if (url.port && url.port !== '443') throw new Error('only port 443 is supported')
  if (url.username || url.password) throw new Error('credentials in the URL are not allowed')
  const host = url.hostname.toLowerCase()
  if (isIP(host.replace(/^\[|\]$/g, ''))) throw new Error('use a DNS name, not an IP address (TLSNotary needs a server name)')
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.internal') || host === 'localhost') throw new Error('the host must be a public DNS name')
  const addresses = await resolve(host).catch(() => [] as string[])
  if (addresses.length === 0) throw new Error(`${host} does not resolve`)
  const bad = addresses.filter((a) => !isPublicAddress(a))
  if (bad.length) throw new Error(`${host} resolves to a non-public address (${bad[0]}); only public APIs can be onboarded`)
  return { url, origin: `https://${host}`, host, target: (url.pathname || '/') + url.search, addresses }
}

// ------------------------------------------------------------------ 2. probe: TLS profile + sample

export type Sample = {
  status: number
  contentType: string | null
  bodyBytes: number
  body: string
  json: unknown
  tls: { protocol: string | null; cipher: string; group: string | null; issuer: string | null }
}

const TLSN_CIPHERS = 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256'
const MAX_BYTES = 16_000

/** HTTP CONNECT tunnel (when the gateway itself sits behind an egress proxy). */
async function tunnel(proxyUrl: string, host: string): Promise<Socket> {
  const p = new URL(proxyUrl)
  const socket = netConnect({ host: p.hostname, port: Number(p.port || 80) })
  await new Promise<void>((ok, fail) => (socket.once('connect', ok), socket.once('error', fail)))
  socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`)
  const head = await new Promise<string>((ok, fail) => {
    let buf = ''
    const onData = (d: Buffer) => {
      buf += d.toString('latin1')
      if (buf.includes('\r\n\r\n')) (socket.off('data', onData), ok(buf))
    }
    socket.on('data', onData)
    socket.once('error', fail)
  })
  if (!/^HTTP\/1\.[01] 200/.test(head)) throw new Error(`egress proxy refused ${host}: ${head.split('\r\n')[0]}`)
  return socket
}

function decodeChunked(body: Buffer): Buffer {
  const out: Buffer[] = []
  let i = 0
  while (i < body.length) {
    const eol = body.indexOf('\r\n', i)
    if (eol < 0) break
    const size = parseInt(body.subarray(i, eol).toString('latin1'), 16)
    if (!size) break
    out.push(body.subarray(eol + 2, eol + 2 + size))
    i = eol + 2 + size + 2
  }
  return Buffer.concat(out)
}

/** One HTTP/1.1 GET over TLSNotary's TLS profile, verified against Mozilla's roots (Node's bundle). */
export async function probeVendor(t: SafeTarget, opts: { proxy?: string; timeoutMs?: number } = {}): Promise<Sample> {
  const raw = opts.proxy ? await tunnel(opts.proxy, t.host) : undefined
  const socket: TLSSocket = tlsConnect({
    ...(raw ? { socket: raw } : { host: t.addresses[0], port: 443 }), // pinned to the address we checked
    servername: t.host,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    ciphers: TLSN_CIPHERS,
    ecdhCurve: 'prime256v1',
    ca: [...rootCertificates],
    rejectUnauthorized: true,
  })
  const timeout = setTimeout(() => socket.destroy(new Error('the vendor did not answer within the time limit')), opts.timeoutMs ?? 10_000)
  try {
    await new Promise<void>((ok, fail) => (socket.once('secureConnect', ok), socket.once('error', (e) => fail(tlsReason(e)))))
    const key = socket.getEphemeralKeyInfo() as { name?: string } | null
    const cert = socket.getPeerCertificate()
    const tls = { protocol: socket.getProtocol(), cipher: socket.getCipher().standardName ?? socket.getCipher().name, group: key?.name ?? null, issuer: [cert?.issuer?.O ?? cert?.issuer?.CN ?? null].flat()[0] ?? null }
    socket.write(`GET ${t.target} HTTP/1.1\r\nHost: ${t.host}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nUser-Agent: fermata-onboarding/0.1\r\nConnection: close\r\n\r\n`)
    const chunks: Buffer[] = []
    let total = 0
    await new Promise<void>((ok, fail) => {
      socket.on('data', (d: Buffer) => {
        total += d.length
        if (total > MAX_BYTES + 8192) socket.destroy(new Error(`the response is larger than the prover's ${MAX_BYTES / 1000} KB budget`))
        else chunks.push(d)
      })
      socket.once('end', ok)
      socket.once('close', ok)
      socket.once('error', fail)
    })
    const buf = Buffer.concat(chunks)
    const sep = buf.indexOf('\r\n\r\n')
    if (sep < 0) throw new Error('no HTTP/1.1 response')
    const head = buf.subarray(0, sep).toString('latin1').split('\r\n')
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? '')?.[1])
    if (!status) throw new Error('no HTTP/1.1 status line')
    const header = (name: string) => head.find((l) => l.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? null
    let body: Buffer = buf.subarray(sep + 4)
    if (header('transfer-encoding')?.toLowerCase().includes('chunked')) body = decodeChunked(body)
    if (header('content-encoding') && header('content-encoding') !== 'identity') throw new Error('the server compresses its response; TLSNotary needs an uncompressed one')
    if (body.length > MAX_BYTES) throw new Error(`the response is larger than the prover's ${MAX_BYTES / 1000} KB budget`)
    const text = body.toString('utf8')
    let json: unknown = undefined
    try {
      json = JSON.parse(text)
    } catch {
      // not JSON: the predicate checks status, type and size only
    }
    return { status, contentType: header('content-type'), bodyBytes: body.length, body: text.slice(0, 2000), json, tls }
  } finally {
    clearTimeout(timeout)
    socket.destroy()
  }
}

function tlsReason(e: Error & { code?: string }): Error {
  const msg = e.message || String(e)
  if (/handshake failure|no shared cipher|wrong version|unsupported protocol|alert/i.test(msg))
    return new Error(`TLS profile mismatch: the server does not offer TLS 1.2 with AES-128-GCM on P-256, the only profile TLSNotary supports (${msg})`)
  if (/certificate|self.signed|issuer|CERT/i.test(msg + (e.code ?? ''))) return new Error(`the certificate does not chain to a Mozilla root (${e.code ?? msg})`)
  return new Error(msg)
}

// ------------------------------------------------------------------ 3. the delivery predicate

export type Predicate = {
  version: 1
  status: number[]
  maxBodyBytes: number
  contentType?: string
  jsonSchema?: { type: 'object'; required: string[]; properties: Record<string, { type: string }> }
}

const jsonType = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? 'number' : typeof v)

/** The predicate a sample suggests: its status, content type, ≈ 2× its size, and its top-level JSON keys. */
export function draftPredicate(s: Sample): Predicate {
  const p: Predicate = { version: 1, status: [s.status], maxBodyBytes: Math.min(MAX_BYTES, Math.max(1024, s.bodyBytes * 2)) }
  const ct = s.contentType?.split(';')[0]?.trim().toLowerCase()
  if (ct) p.contentType = ct
  if (s.json && typeof s.json === 'object' && !Array.isArray(s.json)) {
    const entries = Object.entries(s.json as Record<string, unknown>).slice(0, 32)
    p.jsonSchema = { type: 'object', required: entries.map(([k]) => k), properties: Object.fromEntries(entries.map(([k, v]) => [k, { type: jsonType(v) }])) }
  }
  return p
}

/** Validates a (possibly vendor-edited) predicate and returns its canonical bytes. */
export function canonicalPredicate(input: unknown): Uint8Array {
  const p = input as Predicate
  const fail = (m: string) => {
    throw new Error(`invalid predicate: ${m}`)
  }
  if (!p || typeof p !== 'object' || p.version !== 1) fail('version must be 1')
  if (!Array.isArray(p.status) || p.status.length === 0 || p.status.some((x) => !Number.isInteger(x) || x < 100 || x > 599)) fail('status must list HTTP codes')
  if (!Number.isInteger(p.maxBodyBytes) || p.maxBodyBytes < 1 || p.maxBodyBytes > MAX_BYTES) fail(`maxBodyBytes must be 1–${MAX_BYTES}`)
  if (p.contentType !== undefined && (typeof p.contentType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(p.contentType))) fail('contentType must be a media type')
  const out: Record<string, unknown> = { version: 1, status: p.status, maxBodyBytes: p.maxBodyBytes }
  if (p.contentType) out.contentType = p.contentType
  if (p.jsonSchema) {
    const js = p.jsonSchema
    const types = ['string', 'number', 'boolean', 'object', 'array', 'null']
    if (js.type !== 'object' || !Array.isArray(js.required) || typeof js.properties !== 'object') fail('jsonSchema must be {type:"object", required, properties}')
    for (const [k, v] of Object.entries(js.properties)) if (!types.includes(v?.type)) fail(`property ${k} has an unsupported type`)
    if (js.required.some((k) => typeof k !== 'string' || !(k in js.properties))) fail('every required key needs a property type')
    out.jsonSchema = { type: 'object', required: js.required, properties: Object.fromEntries(Object.entries(js.properties).map(([k, v]) => [k, { type: v.type }])) }
  }
  return new TextEncoder().encode(JSON.stringify(out))
}

/** Why `sample` would fail `p` (empty = it passes): the same checks the attestor runs. */
export function checkSample(p: Predicate, s: Sample): string[] {
  const f: string[] = []
  if (!p.status.includes(s.status)) f.push(`status ${s.status} not in [${p.status.join(', ')}]`)
  if (s.bodyBytes > p.maxBodyBytes) f.push(`body ${s.bodyBytes} B > ${p.maxBodyBytes} B`)
  if (p.contentType && !(s.contentType ?? '').toLowerCase().startsWith(p.contentType)) f.push(`content type ${s.contentType} is not ${p.contentType}`)
  if (p.jsonSchema) {
    const v = s.json as Record<string, unknown> | undefined
    if (!v || typeof v !== 'object' || Array.isArray(v)) f.push('body is not a JSON object')
    else {
      for (const k of p.jsonSchema.required) if (!(k in v)) f.push(`required key "${k}" missing`)
      for (const [k, t] of Object.entries(p.jsonSchema.properties)) if (k in v && jsonType(v[k]) !== t.type) f.push(`key "${k}" is ${jsonType(v[k])}, not ${t.type}`)
    }
  }
  return f
}

// ------------------------------------------------------------------ 4. routes

export type RegisterInput = { origin: string; examplePath: string; label: string; payout: Address; price: bigint; predicate: Uint8Array; summary: string; toolName: string }
export type Registered = { serviceId: Hex; txHash: Hex; endpoint: string; tool: string }

export type OnboardDeps = {
  resolve?: Resolver
  probe: (t: SafeTarget) => Promise<Sample>
  /** Writes the predicate, registers on-chain, adds the service to the running gateway. */
  register: (input: RegisterInput) => Promise<Registered>
  trustProxy?: boolean
  now?: () => number
  perIpProbesPerHour?: number
  perIpRegistrationsPerDay?: number
  registrationsPerDay?: number
}

export function onboardRoutes(app: Hono, deps: OnboardDeps) {
  const now = deps.now ?? Date.now
  const probes = new RateLimiter(deps.perIpProbesPerHour ?? 20, 3_600_000, now)
  const regsPerIp = new RateLimiter(deps.perIpRegistrationsPerDay ?? 3, 86_400_000, now)
  const regs = new DailyCap(deps.registrationsPerDay ?? 20, now)
  const ip = (c: Context) =>
    clientIp(c.req.raw.headers, (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress, !!deps.trustProxy)
  const bad = (c: Context, e: unknown, status: 400 | 422 = 422) => c.json({ error: (e as Error).message.slice(0, 400) }, status)

  app.post('/onboard/probe', async (c) => {
    const { url } = ((await c.req.json().catch(() => ({}))) ?? {}) as { url?: string }
    const wait = probes.take(ip(c))
    if (wait) return c.json({ error: 'too many checks from this address; try again later', retryAfterMs: wait }, 429)
    let t: SafeTarget
    try {
      t = await guardUrl(String(url ?? ''), deps.resolve)
    } catch (e) {
      return bad(c, e, 400)
    }
    try {
      const sample = await deps.probe(t)
      const predicate = draftPredicate(sample)
      return c.json({ ok: true, origin: t.origin, examplePath: t.target, sample, predicate, warnings: sample.status >= 400 ? [`the sample answered HTTP ${sample.status}; register a URL that answers successfully`] : [] })
    } catch (e) {
      return c.json({ ok: false, origin: t.origin, error: (e as Error).message.slice(0, 400) }, 422)
    }
  })

  app.post('/onboard/register', async (c) => {
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { url?: string; label?: string; payout?: string; price?: string; predicate?: unknown; summary?: string; toolName?: string }
    const label = String(b.label ?? '').trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{1,11}$/.test(label)) return bad(c, new Error('label: 2–12 characters, a–z, 0–9 and -'), 400)
    if (!b.payout || !isAddress(b.payout)) return bad(c, new Error('payout must be an address'), 400)
    const price = BigInt(Math.round(Number(b.price ?? '0.01') * 1e6))
    if (price < 1000n || price > 1_000_000n) return bad(c, new Error('price must be 0.001–1.00'), 400)
    const toolName = String(b.toolName ?? `call_${label.replace(/-/g, '_')}`)
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(toolName)) return bad(c, new Error('tool name: lower case letters, digits and _'), 400)
    let predicate: Uint8Array
    let t: SafeTarget
    try {
      predicate = canonicalPredicate(b.predicate)
      t = await guardUrl(String(b.url ?? ''), deps.resolve)
    } catch (e) {
      return bad(c, e, 400)
    }
    const wait = regsPerIp.take(ip(c))
    if (wait) return c.json({ error: 'registration limit for this address reached; try tomorrow', retryAfterMs: wait }, 429)
    if (!regs.take()) return c.json({ error: 'today’s registration budget is used up' }, 429)
    try {
      // The URL must still answer, and its answer must pass the predicate being registered.
      const sample = await deps.probe(t)
      const failures = checkSample(JSON.parse(new TextDecoder().decode(predicate)) as Predicate, sample)
      if (failures.length) return c.json({ error: `the vendor's current answer would fail this predicate: ${failures.join('; ')}` }, 422)
      const summary = String(b.summary ?? '').slice(0, 200) || `${t.host} (onboarded)`
      return c.json({ ok: true, ...(await deps.register({ origin: t.origin, examplePath: t.target, label, payout: b.payout as Address, price, predicate, summary, toolName })) })
    } catch (e) {
      return bad(c, e)
    }
  })
}
