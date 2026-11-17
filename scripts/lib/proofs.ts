// Re-verifying a call's proof offline, trusting the gateway for nothing but bytes: shared by
// `pnpm reverify` (one call, every check printed) and `pnpm scores --proofs` (each proven failure's
// HTTP status, to tell the agent's 4xx from the vendor's failures).
//
// Every expected value comes from the chain (the caller passes them); each byte from the gateway is
// checked before use: the presentation's keccak256 must equal the on-chain presentationHash and the
// predicate's sha256 the on-chain predicateHash. Then `fermata-attest verify --offline` checks the
// notary's signature and the server certificate, recomputes requestHash, originHash and
// notaryKeyHash, and re-runs the predicate.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { keccak256, type Hex } from 'viem'
import { originHash, predicateHash, provenStatus } from 'fermata-sdk'

export const attestBin = () => process.env.FERMATA_ATTEST_BIN ?? new URL('../../apps/attestor/target/release/fermata-attest', import.meta.url).pathname

export function requireAttestBin(): string {
  const bin = attestBin()
  if (!existsSync(bin)) throw new Error(`no offline verifier at ${bin}: (cd apps/attestor && cargo +1.95.0 build --release), or set FERMATA_ATTEST_BIN`)
  return bin
}

/** What the chain says about a call and its service (never taken from the gateway). */
export type OnChain = {
  callId: Hex
  serviceId: Hex
  requestHash: Hex
  presentationHash: Hex
  service: { predicateHash: Hex; originHash: Hex; notaryKeyHash: Hex }
}

export type Check = { ok: boolean; what: string }
export type ProofResult = {
  checks: Check[]
  /** All checks passed, the offline verifier included. */
  ok: boolean
  outcome?: 'DELIVERED' | 'FAILED' | string
  /** The proven HTTP status (null: the answer was not HTTP; undefined: not verified). */
  status?: number | null
  error?: string
}

/** A small cache of what every proof of one gateway needs (services, predicates, the demo CA). */
export function gatewayFiles(gateway: string) {
  const base = gateway.replace(/\/$/, '')
  const memo = new Map<string, Promise<unknown>>()
  const get = async (p: string) => {
    const res = await fetch(`${base}${p}`)
    if (!res.ok) throw new Error(`GET ${base}${p}: HTTP ${res.status}`)
    return res
  }
  const once = <T>(key: string, f: () => Promise<T>) => {
    if (!memo.has(key)) memo.set(key, f())
    return memo.get(key) as Promise<T>
  }
  return {
    base,
    get,
    presentation: async (callId: Hex) => new Uint8Array(await (await get(`/proofs/${callId}`)).arrayBuffer()),
    predicate: (hash: Hex) => once(`p:${hash}`, async () => new Uint8Array(await (await get(`/predicates/${hash}`)).arrayBuffer())),
    services: () => once('services', async () => (await (await get('/services')).json()) as { serviceId: string; upstream: string }[]),
    ca: () => once('ca', async () => (await get('/ca.pem')).text()),
  }
}

/** Checks one call's proof offline against the chain. Never throws for a bad proof: see `ok`. */
export async function verifyProof(files: ReturnType<typeof gatewayFiles>, onchain: OnChain, bin = requireAttestBin()): Promise<ProofResult> {
  const checks: Check[] = []
  const check = (ok: boolean, what: string) => (checks.push({ ok, what }), ok)
  const done = (extra: Partial<ProofResult> = {}): ProofResult => ({ checks, ok: checks.every((c) => c.ok), ...extra })
  const dir = mkdtempSync(path.join(tmpdir(), 'fermata-proof-'))
  try {
    const presentation = await files.presentation(onchain.callId)
    check(keccak256(presentation) === onchain.presentationHash.toLowerCase(), `presentation keccak256 = on-chain presentationHash ${onchain.presentationHash.slice(0, 10)}…`)
    writeFileSync(path.join(dir, 'call.tlsn'), presentation)
    const predicate = await files.predicate(onchain.service.predicateHash)
    check(predicateHash(predicate) === onchain.service.predicateHash.toLowerCase(), `predicate sha256 = on-chain predicateHash ${onchain.service.predicateHash.slice(0, 10)}…`)
    writeFileSync(path.join(dir, 'predicate.json'), predicate)
    const upstream = (await files.services()).find((s) => s.serviceId.toLowerCase() === onchain.serviceId.toLowerCase())?.upstream
    check(!!upstream && originHash(upstream) === onchain.service.originHash, `origin ${upstream} = on-chain originHash ${onchain.service.originHash.slice(0, 10)}…`)
    if (checks.some((c) => !c.ok)) return done()
    // Mock vendors use the demo's dev CA (fetched; it only widens which certificates are accepted);
    // real vendors must chain to Mozilla's roots.
    const trust = new URL(upstream!).hostname === 'vendor.fermata.test'
      ? (writeFileSync(path.join(dir, 'ca.pem'), await files.ca()), ['--ca', path.join(dir, 'ca.pem')])
      : ['--roots', 'mozilla']
    const out = JSON.parse(execFileSync(bin, [
      'verify', '--offline', '--presentation', path.join(dir, 'call.tlsn'), ...trust, '--call-id', onchain.callId,
      '--predicate', path.join(dir, 'predicate.json'), '--service-id', onchain.serviceId, '--request-hash', onchain.requestHash,
      '--origin-hash', onchain.service.originHash, '--notary-key-hash', onchain.service.notaryKeyHash,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as Record<string, unknown>
    const outcome = out.outcome === 1 || out.outcome === 'DELIVERED' ? 'DELIVERED' : out.outcome === 2 || out.outcome === 'FAILED' ? 'FAILED' : String(out.outcome)
    check(out.ok === true, 'notary signature, certificate chain and the recomputed requestHash, originHash, notaryKeyHash all check out')
    return done({ outcome, status: provenStatus(String(out.response ?? '')) })
  } catch (e) {
    const error = (e as { stderr?: string }).stderr || (e as Error).message
    check(false, `offline verification: ${error.trim().split('\n').slice(-1)[0]}`)
    return done({ error })
  }
}
