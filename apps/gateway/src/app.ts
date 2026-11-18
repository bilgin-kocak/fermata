import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { Credential, Receipt } from 'mppx'
import { discovery } from 'mppx/hono'
import { Mppx, tempo } from 'mppx/server'
import { isAddressEqual, parseEventLogs, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { aggregateScores, eventually, failureClass, provenStatus, fermataEscrowAbi, fermataServer, MODERATO, originHash, predicateHash, requestHash, serviceLabelOf, type EscrowLog } from 'fermata-sdk'
import type { AttestResult, Attestor, ProvedResponse } from './attestor.ts'
import { toVerdict, type GatewayChain } from './chain.ts'
import type { GatewayConfig, ServiceConfig } from './config.ts'
import { clientIp, RateLimiter } from './limits.ts'
import { mcpHandler, toolFor } from './mcp.ts'
import { onboardRoutes, type OnboardDeps, type Registered, type RegisterInput } from './onboard.ts'
import { publicRoutes, type DemoDeps } from './public.ts'
import { FINAL, type CallRecord, type CallStore } from './store.ts'

export type GatewayDeps = {
  config: GatewayConfig
  chain: GatewayChain
  /** Used by the `fermata` method to read the agent's hold transaction. */
  publicClient: PublicClient
  attestor: Attestor
  store: CallStore
  /** mppx HMAC secret (≥ 32 bytes). */
  secretKey: string
  env?: Record<string, string | undefined>
  /** Upstream fetch for the unprotected `tempo` fallback (needs the vendor's CA). */
  fetchUpstream?: (url: string, init: RequestInit) => Promise<Response>
  log?: (msg: string) => void
  /** Built dashboard (apps/dashboard/dist), served at /dashboard. */
  dashboardDir?: string
  /** Explorer base URL for links (Moderato: https://explore.testnet.tempo.xyz; none on Anvil). */
  explorer?: string | null
  /** Public "try it" mode (hosted demo); off when absent. */
  demo?: DemoDeps
  /** Self-serve onboarding (public mode); off when absent. `register` is wired up by the caller. */
  onboard?: Omit<OnboardDeps, 'register'> & { register: (input: RegisterInput, add: (cfg: ServiceConfig) => Promise<void>) => Promise<Registered> }
  /** Where `addService` persists onboarded services (the gateway config file). */
  configPath?: string
  /**
   * What a third party needs to re-verify a proof offline (`pnpm reverify`): the vendor CA the mock
   * vendors' certificates chain to (served at /ca.pem) and the directories holding the predicates
   * (served at /predicates/:hash; the caller checks the hash against the chain).
   */
  verifierFiles?: { caPath?: string; predicateDirs: string[] }
}

/** JSON-safe copy (bigints as decimal strings). */
const plain = <T>(v: T): unknown => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)))

type Service = ServiceConfig & { price: bigint; token: Hex; window: number; verifier: Address; notaryKeyHash: Hex }

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade', 'proxy-connection', 'te', 'trailer'])
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex

/** The vendor's response as proved by the attestor, returned to the agent byte for byte. */
export function provedToResponse(p: ProvedResponse): Response {
  if (p.status == null) {
    return Response.json({ error: 'upstream response is not HTTP', detail: p.error }, { status: 502 })
  }
  const headers = new Headers()
  for (const [k, v] of p.headers ?? []) if (!HOP_BY_HOP.has(k.toLowerCase())) headers.append(k, v)
  const body = [204, 304].includes(p.status) ? null : Buffer.from(p.bodyBase64 ?? '', 'base64')
  return new Response(body, { status: p.status, headers })
}

/** A call this gateway accepted that never got an answer from the vendor (not the attestor's failure). */
export function isNoAnswer(r: CallRecord): boolean {
  if (r.noAnswer !== undefined) return r.noAnswer
  // Records from before `noAnswer` existed: a vendor-side no-transcript, never marked recoverable.
  return (r.status === 'awaiting-timeout' || r.status === 'timed-out') && !!r.error?.startsWith('no-transcript') && r.recoverable === undefined
}

/** A configured service checked against the chain: registered, settled by this attestor, same origin. */
async function checkService(deps: GatewayDeps, signer: Address, cfg: ServiceConfig): Promise<Service> {
  const s = await deps.chain.service(cfg.serviceId)
  if (isAddressEqual(s.token, zeroAddress)) throw new Error(`service ${cfg.serviceId} is not registered on ${deps.chain.escrow}`)
  if (!isAddressEqual(s.verifier, signer)) throw new Error(`service ${cfg.serviceId} is settled by ${s.verifier}, not this attestor (${signer})`)
  if (originHash(cfg.upstream) !== s.originHash) throw new Error(`service ${cfg.serviceId}: upstream ${cfg.upstream} is not the registered origin`)
  return { ...cfg, price: s.pricePerCall, token: s.token, window: s.settlementWindow, verifier: s.verifier, notaryKeyHash: s.notaryKeyHash }
}

/** Checks every configured service against the chain and the attestor; refuses to start on mismatch. */
export async function loadServices(deps: GatewayDeps): Promise<Map<string, Service>> {
  const health = await deps.attestor.health()
  if (!isAddressEqual(health.escrow, deps.chain.escrow)) throw new Error(`attestor serves escrow ${health.escrow}, gateway ${deps.chain.escrow}`)
  if (health.chainId !== deps.chain.chainId) throw new Error(`attestor on chain ${health.chainId}, gateway on ${deps.chain.chainId}`)
  // Checked 8 at a time (each is an RPC read; a hosted demo collects listings), kept in config order:
  // configured services first, so they keep their MCP tool names.
  const checked: (Service | undefined)[] = []
  for (let i = 0; i < deps.config.services.length; i += 8) {
    const batch = deps.config.services.slice(i, i + 8)
    checked.push(...(await Promise.all(batch.map(async (cfg) => {
      try {
        return await checkService(deps, health.signer, cfg)
      } catch (e) {
        if (!cfg.onboarded) throw e
        ;(deps.log ?? console.warn)(`onboarded service ${cfg.serviceId} skipped: ${(e as Error).message}`)
        return undefined
      }
    }))))
  }
  const out = new Map<string, Service>()
  for (const s of checked) if (s) out.set(s.serviceId.toLowerCase(), s)
  return out
}

export async function createGateway(deps: GatewayDeps) {
  const log = deps.log ?? ((m: string) => console.log(`[gateway] ${m}`))
  const services = await loadServices(deps)
  const { chain, store, attestor } = deps
  const env = (name: string) => deps.env?.[name] ?? process.env[name]
  const publicMode = env('GATEWAY_PUBLIC') === '1'
  // A paid request must leave this much of the hold's window to prove and settle (capped at a third
  // of the window): otherwise the agent gets the answer and the settlement misses the window.
  const minRemainingSeconds = Number(env('GATEWAY_MIN_REMAINING_S') ?? 15)
  const fermataHandler = fermataServer({ client: deps.publicClient, escrow: chain.escrow, secretKey: deps.secretKey, minRemainingSeconds })
  const tempoHandler = tempo.charge({ testnet: true } as never)
  const mppx = Mppx.create({ secretKey: deps.secretKey, realm: deps.config.realm, methods: [fermataHandler, tempoHandler] })

  const offers = (svc: Service, rh: Hex) => {
    const list: [unknown, Record<string, unknown>][] = [
      [fermataHandler, { amount: svc.price.toString(), currency: svc.token, escrow: chain.escrow, chainId: chain.chainId, serviceId: svc.serviceId, requestHash: rh }],
    ]
    if (svc.tempo) list.push([tempoHandler, { amount: svc.tempo.amount, recipient: svc.tempo.recipient }])
    return mppx.compose(...(list as never as Parameters<typeof mppx.compose>))
  }

  const upstreamHeaders = (svc: Service, incoming: Headers) => {
    const headers: Record<string, string> = {}
    for (const name of svc.forwardHeaders ?? ['content-type', 'accept']) {
      const v = incoming.get(name)
      if (v) headers[name] = v
    }
    if (svc.upstreamAuth) {
      const secret = (deps.env ?? process.env)[svc.upstreamAuth.env]
      if (secret) headers[svc.upstreamAuth.header.toLowerCase()] = secret
    }
    return headers
  }

  const withFermataReceipt = (res: Response, record: CallRecord) => {
    const base = Receipt.fromResponse(res)
    const receipt = {
      ...base,
      callId: record.callId,
      holdTx: record.holdTx,
      txHash: record.settleTx ?? null,
      presentationHash: record.presentationHash ?? null,
      outcome: record.outcome ?? (record.status === 'awaiting-timeout' ? 'AWAITING_TIMEOUT' : null),
      status: base.status,
    }
    res.headers.set('Payment-Receipt', Receipt.serialize(receipt as never))
    res.headers.set('X-Fermata-Call', record.callId)
    res.headers.set('X-Fermata-Status', record.status)
    return res
  }

  async function settleVerdict(record: CallRecord): Promise<CallRecord> {
    const result = await chain.settle(record.callId, toVerdict(record.verdict as Record<string, unknown>), record.signature!)
    if (result.ok) {
      log(`call ${record.callId.slice(0, 10)} ${record.outcome} settled in ${result.txHash}`)
      return store.update(record.callId, { status: record.outcome === 'DELIVERED' ? 'released' : 'refunded', settleTx: result.txHash, error: undefined })
    }
    log(`call ${record.callId.slice(0, 10)} settle failed: ${result.error}`)
    return store.update(record.callId, { status: 'settle-pending', error: `settle: ${result.error}` })
  }

  /**
   * After a valid `fermata` credential: record the hold, prove the vendor's answer, settle the verdict.
   * Shared by the HTTP route and the MCP endpoint. Returns the proved vendor response (or the
   * no-verdict error) and the call record.
   */
  // Calls this process is proving right now. A 'held' record outside this set was interrupted (a
  // restart mid-proof): the sweeper treats it like awaiting-timeout, so the agent is still refunded.
  const inFlight = new Set<string>()
  // Proofs are serialised in the attestor: past this many in flight, new payers get 503 before paying.
  const maxInFlight = Number(deps.env?.GATEWAY_MAX_IN_FLIGHT ?? process.env.GATEWAY_MAX_IN_FLIGHT ?? 4)
  const saturated = () => inFlight.size >= maxInFlight

  async function fulfil(
    svc: Service,
    req: { method: string; target: string; headers: Headers; body: Uint8Array },
    credential: { challenge: { request: unknown }; payload: unknown },
  ): Promise<{ response: Response; record: CallRecord; replayed?: boolean }> {
    const callId = (credential.challenge.request as { callId: Hex }).callId
    // One credential pays for one call. mppx's replay store is in memory, so after a restart the call
    // record on disk is what refuses a credential that was already served.
    const existing = await store.get(callId)
    if (existing) {
      const response = Response.json({ error: 'call already served', detail: 'this hold was already redeemed: one credential pays for one call', callId, status: existing.status }, { status: 409 })
      return { response, record: existing, replayed: true }
    }
    inFlight.add(callId.toLowerCase())
    try {
      return await prove(svc, req, credential, callId)
    } finally {
      inFlight.delete(callId.toLowerCase())
    }
  }

  async function prove(
    svc: Service,
    req: { method: string; target: string; headers: Headers; body: Uint8Array },
    credential: { challenge: { request: unknown }; payload: unknown },
    callId: Hex,
  ): Promise<{ response: Response; record: CallRecord }> {
    const holdTx = (credential.payload as { txHash: Hex }).txHash
    const rh = requestHash(svc.serviceId, req.method, req.target, req.body)
    // The credential was just validated; a lagging or failing RPC must not stop the record being
    // written (without it the sweeper could never claim this hold's timeout refund).
    const hold = await eventually(() => chain.hold(callId), (h) => h.status !== 0, 6).catch(() => undefined)
    const now = new Date().toISOString()
    let record = await store.put({
      callId, serviceId: svc.serviceId, method: req.method, target: req.target, requestHash: rh, holdTx, agent: hold?.agent,
      deadline: (hold?.deadline ?? 0n).toString(), status: 'held', createdAt: now, updatedAt: now,
    })

    const result = await attestor.attest({
      callId, url: `${svc.upstream}${req.target}`, method: req.method, headers: upstreamHeaders(svc, req.headers), body: Buffer.from(req.body).toString('utf8'),
      ...(svc.notary ? { notary: svc.notary } : {}),
    })

    if (result.kind !== 'verdict') {
      // No transcript (vendor silent, TLS failure, notary/prover down) or a failed binding check:
      // never a verdict. Only claimTimeout can end the hold; the sweeper sends it after the window.
      const detail = result.kind === 'rejected' ? `${result.check}: ${result.detail}` : result.detail
      console.error(`[gateway] call ${callId} has NO VERDICT (${result.kind}: ${detail}); awaiting timeout at ${hold?.deadline ?? '?'}`)
      const recoverable = result.kind === 'no-transcript' && !!result.retryable
      const noAnswer = result.kind === 'no-transcript' && !result.retryable
      record = await store.update(callId, { status: 'awaiting-timeout', error: `${result.kind}: ${detail}`, noAnswer, ...(recoverable ? { recoverable, recoverTries: 0 } : {}) })
      const response = Response.json(
        { error: result.kind, detail, callId, status: 'awaiting-timeout', refundAfter: hold?.deadline.toString() ?? null, reclaim: 'claimTimeout(callId) on the escrow after refundAfter' },
        { status: result.kind === 'rejected' ? 502 : 504 },
      )
      return { response, record }
    }

    record = await settleVerdict(await recordVerdict(callId, result))
    return { response: provedToResponse(result.response), record }
  }

  /**
   * Stores a signed verdict as `settle-pending` in the same write: if the process dies before the
   * settle is mined, the sweeper still settles it inside the window (a `held` record would only be
   * refunded by timeout, though the vendor delivered).
   */
  function recordVerdict(callId: Hex, result: Extract<AttestResult, { kind: 'verdict' }>) {
    return store.update(callId, {
      status: 'settle-pending',
      outcome: result.signed.outcome,
      failures: result.signed.failures,
      verdict: result.signed.verdict,
      signature: result.signed.signatureBytes,
      presentationHash: result.presentationHash,
      proveMs: result.proveMs,
      notaryBytes: result.notaryBytes,
      signer: result.signed.signer,
      vendorStatus: result.response.status,
      error: undefined,
      recoverable: undefined,
      noAnswer: undefined,
    })
  }

  /**
   * A call left without a verdict because the attestor failed (not the vendor): the presentation may
   * be stored, so ask the attestor to verify it again and settle while the window is open. Up to 3 tries.
   */
  async function recover(record: CallRecord) {
    const tries = (record.recoverTries ?? 0) + 1
    const result = await attestor.verify(record.callId)
    if (result.kind === 'verdict') {
      log(`call ${record.callId.slice(0, 10)} recovered: stored proof verified (${result.signed.outcome})`)
      await settleVerdict(await recordVerdict(record.callId, result))
    } else if (result.kind === 'missing' || result.kind === 'rejected') {
      await store.update(record.callId, { recoverable: false, recoverTries: tries })
    } else {
      await store.update(record.callId, { recoverable: tries < 3, recoverTries: tries })
    }
  }

  // The attestor's MPC-TLS budget for the request it sends (4096 bytes with headers): a larger request,
  // or a body that is not UTF-8 text, can never be proved, so it is refused before anyone pays for it.
  const maxRequestBytes = Number(env('GATEWAY_MAX_REQUEST_BYTES') ?? 2048)
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  function provable(target: string, body: Uint8Array): { status: 413 | 415; error: string } | undefined {
    if (Buffer.byteLength(target) + body.byteLength > maxRequestBytes) {
      return { status: 413, error: `request too large to prove: path, query and body must total at most ${maxRequestBytes} bytes` }
    }
    try {
      utf8.decode(body)
    } catch {
      return { status: 415, error: 'request body must be UTF-8 text: binary bodies cannot be proved' }
    }
    return undefined
  }

  const app = new Hono()
  // Errors as JSON (the dashboard shows `error`), never Hono's plain-text 500.
  app.onError((e, c) => {
    log(`${c.req.method} ${c.req.path} failed: ${e.message}`)
    return c.json({ error: (e as { shortMessage?: string }).shortMessage ?? 'internal error' }, 500)
  })

  // Request bodies are read in full before any payment check: cap them.
  const tooLarge = (c: import('hono').Context) => c.json({ error: 'request body too large' }, 413)
  app.use('/s/*', bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }))
  app.use('/mcp', bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }))
  app.use('/onboard/*', bodyLimit({ maxSize: 16 * 1024, onError: tooLarge }))
  app.use('/demo/*', bodyLimit({ maxSize: 16 * 1024, onError: tooLarge }))
  // Public mode: unpaid requests still cost RPC reads (a made-up hold tx is polled for seconds) and
  // proof re-verification costs CPU, so both are rate-limited per visitor.
  if (publicMode) {
    const trustProxy = Number(env('GATEWAY_TRUST_PROXY') ?? 0)
    const ipHeader = env('GATEWAY_CLIENT_IP_HEADER') || undefined
    const ip = (c: import('hono').Context) =>
      clientIp(c.req.raw.headers, (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress, trustProxy, ipHeader)
    const limit = (limiter: RateLimiter) => async (c: import('hono').Context, next: () => Promise<void>) => {
      const socketIp = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress
      // In-process requests (the MCP endpoint's free tools, the demo agent) have no socket: they are
      // limited where they enter (/mcp, /demo/call), not here, or every MCP user would share one bucket.
      if (!socketIp) return next()
      // A client on this machine with no proxy in front (local development). Behind a proxy the socket
      // is the proxy's, often loopback, so it is never exempt then.
      if (!trustProxy && /^(?:127\.|::1$|::ffff:127\.)/.test(socketIp)) return next()
      const wait = limiter.take(ip(c))
      if (wait > 0) return c.json({ error: 'too many requests; slow down', retryAfterMs: wait }, 429, { 'Retry-After': String(Math.ceil(wait / 1000)) })
      await next()
    }
    const paidRequests = limit(new RateLimiter(Number(env('GATEWAY_RATE_PER_MIN') ?? 120), 60_000))
    app.use('/s/*', paidRequests)
    app.use('/mcp', paidRequests)
    app.use('/proofs/:callId/verify', limit(new RateLimiter(Number(env('GATEWAY_VERIFY_RATE_PER_MIN') ?? 10), 60_000)))
  }

  const paid = async (c: import('hono').Context) => {
    const sidParam = c.req.param('serviceId') ?? ''
    const svc = services.get(sidParam.toLowerCase())
    if (!svc) return c.json({ error: `unknown service ${sidParam}` }, 404)
    const url = new URL(c.req.url)
    const prefix = `/s/${sidParam}`
    const target = (url.pathname.slice(prefix.length) || '/') + url.search
    const method = c.req.method.toUpperCase()
    const body = new Uint8Array(await c.req.raw.clone().arrayBuffer())
    const unprovable = provable(target, body)
    if (unprovable) return c.json({ error: unprovable.error }, unprovable.status)
    const rh = requestHash(svc.serviceId, method, target, body)

    // Admission control: refuse new payers (no credential yet) while proving is saturated, so no one
    // holds money for a call that would only wait out its window. Valid paid credentials are always
    // served; an invalid one gets 503 rather than a fresh challenge while saturated.
    const paying = /^payment /i.test(c.req.header('authorization') ?? '')
    if (saturated() && !paying) {
      return c.json({ error: 'busy: other calls are being proved; retry in a few seconds' }, 503, { 'Retry-After': '5' })
    }
    const r = await offers(svc, rh)(c.req.raw)
    if (r.status === 402) {
      if (paying && saturated()) return c.json({ error: 'busy: other calls are being proved; retry in a few seconds' }, 503, { 'Retry-After': '5' })
      return r.challenge
    }

    const credential = Credential.fromRequest(c.req.raw)
    if (credential.challenge.method !== 'fermata') {
      // Unprotected fallback: the vendor was paid directly; no escrow, no proof.
      const upstream = await (deps.fetchUpstream ?? fetch)(`${svc.upstream}${target}`, {
        method,
        headers: upstreamHeaders(svc, c.req.raw.headers),
        body: ['GET', 'HEAD'].includes(method) ? undefined : body,
      })
      const res = r.withReceipt(new Response(upstream.body, { status: upstream.status, headers: upstream.headers }))
      res.headers.set('Payment-Receipt', Receipt.serialize({ ...Receipt.fromResponse(res), unprotected: true } as never))
      return res
    }

    const { response, record } = await fulfil(svc, { method, target, headers: c.req.raw.headers, body }, credential)
    return withFermataReceipt(r.withReceipt(response), record)
  }
  app.all('/s/:serviceId', paid)
  app.all('/s/:serviceId/*', paid)

  app.get('/services', (c) =>
    c.json(
      [...services.values()].map((s) => ({
        serviceId: s.serviceId, endpoint: `/s/${s.serviceId}`, upstream: s.upstream, price: s.price.toString(), token: s.token,
        settlementWindow: s.window, verifier: s.verifier, escrow: chain.escrow, chainId: chain.chainId, unprotectedFallback: s.tempo ?? null,
        notary: { keyHash: s.notaryKeyHash, label: s.notaryLabel ?? null }, legacy: !!s.legacy, listing: listingOf(s),
      })),
    ),
  )
  // The escrow's events since its deploy block, shared by the vendor scores (the same code as
  // `pnpm scores`) and the live feed: refreshed at most every 2 s, in chunks, reading only blocks not
  // yet seen, so dashboards polling /events cost one small getLogs per refresh, not one per viewer.
  const logCache: { logs: EscrowLog[]; next: bigint; at: number; pending?: Promise<void> } = { logs: [], next: BigInt(deps.config.fromBlock ?? 0), at: 0 }
  const refreshLogs = async () => {
    if (Date.now() - logCache.at < 2_000) return
    logCache.pending ??= (async () => {
      try {
        const { logs, toBlock } = await chain.escrowLogs(logCache.next)
        logCache.logs.push(...logs)
        if (toBlock + 1n > logCache.next) logCache.next = toBlock + 1n
        logCache.at = Date.now()
      } finally {
        logCache.pending = undefined
      }
    })()
    await logCache.pending
  }
  // Only services whose verdicts this gateway's attestor signs are ranked: a service registered with
  // its own key as verifier could "release" calls with no proof at all.
  const { signer: attestorSigner } = await attestor.health()
  app.get('/scores', async (c) => {
    await refreshLogs()
    // This gateway's records: the proven HTTP status of each failure (to tell the agent's 4xx from the
    // vendor's failures) and the calls it accepted that never got an answer.
    const records = await store.list()
    const statusOf = new Map(records.filter((r) => r.vendorStatus !== undefined).map((r) => [r.callId.toLowerCase(), r.vendorStatus]))
    const accepted = new Map<string, { accepted: number; noAnswer: number }>()
    for (const r of records) {
      const a = accepted.get(r.serviceId.toLowerCase()) ?? { accepted: 0, noAnswer: 0 }
      a.accepted++
      if (isNoAnswer(r)) a.noAnswer++
      accepted.set(r.serviceId.toLowerCase(), a)
    }
    const all = aggregateScores(logCache.logs, (callId) => failureClass(statusOf.get(callId.toLowerCase())))
    const scores = all.filter((s) => s.verifier && isAddressEqual(s.verifier, attestorSigner)).map((s) => {
      const svc = services.get(s.serviceId.toLowerCase())
      const a = accepted.get(s.serviceId.toLowerCase()) ?? { accepted: 0, noAnswer: 0 }
      const noAnswerRate = a.accepted ? a.noAnswer / a.accepted : null
      return {
        ...s,
        label: serviceLabelOf(s.serviceId) ?? null,
        known: !!svc,
        upstream: svc?.upstream ?? null,
        summary: svc?.summary ?? null,
        tool: svc && !svc.legacy ? toolFor(svc).name : null,
        legacy: !!svc?.legacy,
        notary: svc ? { keyHash: svc.notaryKeyHash, label: svc.notaryLabel ?? null } : null,
        listing: svc ? listingOf(svc) : null,
        fewCalls: s.settled < 20,
        accepted: a.accepted,
        noAnswer: a.noAnswer,
        noAnswerRate,
        oftenNoAnswer: a.accepted >= 5 && (noAnswerRate ?? 0) >= 0.2,
      }
    })
    return c.json(plain({
      escrow: chain.escrow, chainId: chain.chainId, scannedTo: logCache.next - 1n, verifier: attestorSigner,
      method: 'Wilson 95 % lower bound of released / (released + proven vendor failures), from ServiceRegistered/Held/Released/Refunded events; each proven failure is classified by the HTTP status its public proof shows (4xx: the client\'s, not ranked); timeouts are shown but not ranked',
      recompute: `pnpm scores --chain <anvil|moderato> --escrow ${chain.escrow} --verifier ${attestorSigner} --proofs <this gateway's URL>`,
      caveats: [
        'Only calls paid through Fermata count.',
        `Only services settled by this attestor (${attestorSigner}) are ranked; ${all.length - scores.length} other service(s) on this escrow are not.`,
        'Proven 4xx failures are shown, not ranked: an agent can cause them with bad input.',
        'Timeouts are shown but not ranked: anyone can hold a call and never present it.',
        'No-answer counts are this gateway\'s own records of calls it accepted: a vendor that never answers leaves no transcript to prove.',
        'A vendor could pay itself to inflate its score; distinct agents are shown for that reason.',
      ],
      scores,
    }))
  })

  /**
   * Proven statuses for refunds recorded before the gateway kept them: read once, in the background,
   * from the stored proofs (offline re-verification), so old 4xx refunds stop counting against vendors.
   */
  async function backfillStatuses(limit = 500): Promise<number> {
    const missing = (await store.list()).filter((r) => r.status === 'refunded' && r.presentationHash && r.vendorStatus === undefined).slice(-limit)
    const predicates = new Map<string, Hex>()
    let done = 0
    for (const r of missing) {
      try {
        const key = r.serviceId.toLowerCase()
        if (!predicates.has(key)) predicates.set(key, (await chain.service(r.serviceId)).predicateHash)
        const re = await attestor.reverify({ callId: r.callId, serviceId: r.serviceId, predicateHash: predicates.get(key)! })
        if ('error' in re) continue
        if (String(re.presentationHash).toLowerCase() !== r.presentationHash!.toLowerCase()) continue
        await store.update(r.callId, { vendorStatus: provenStatus(String(re.response ?? '')) })
        done++
      } catch {
        // best effort: an unreadable proof stays unclassified (ranked as a vendor failure)
      }
    }
    if (done) log(`backfilled the proven status of ${done} refunded call(s)`)
    return done
  }

  // Newest `limit` calls (default 500), oldest first as before.
  app.get('/calls', async (c) => {
    const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? 500) || 500), 5_000)
    return c.json(await store.list(limit))
  })
  app.get('/calls/:callId', async (c) => {
    const record = await store.get(c.req.param('callId')).catch(() => undefined)
    return record ? c.json(record) : c.json({ error: 'unknown call' }, 404)
  })
  app.get('/proofs/:callId', async (c) => {
    const id = c.req.param('callId').replace(/\.tlsn$/, '') as Hex
    const bytes = /^0x[0-9a-fA-F]{64}$/.test(id) ? await attestor.presentation(id) : undefined
    if (!bytes) return c.json({ error: 'no presentation for this call' }, 404)
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${id}.tlsn"` } })
  })
  // Inputs for an independent offline re-verification. Neither needs trusting: the caller checks a
  // predicate's sha256 against the service's on-chain predicateHash, and the CA only lets the
  // verifier accept the mock vendors' certificates (real vendors chain to Mozilla's roots).
  app.get('/ca.pem', (c) => {
    const ca = deps.verifierFiles?.caPath
    return ca && existsSync(ca) ? c.body(readFileSync(ca, 'utf8'), 200, { 'content-type': 'application/x-pem-file' }) : c.json({ error: 'no vendor CA here' }, 404)
  })
  app.get('/predicates/:hash', (c) => {
    const want = c.req.param('hash').toLowerCase().replace(/\.json$/, '')
    if (!/^0x[0-9a-f]{64}$/.test(want)) return c.json({ error: 'predicate hash: 0x + 64 hex' }, 400)
    for (const dir of deps.verifierFiles?.predicateDirs ?? []) {
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        const bytes = readFileSync(path.join(dir, name))
        if (predicateHash(bytes).toLowerCase() === want) return c.body(bytes.toString('utf8'), 200, { 'content-type': 'application/json' })
      }
    }
    return c.json({ error: 'no predicate with this hash' }, 404)
  })

  app.get('/info', (c) =>
    c.json({
      chainId: chain.chainId,
      escrow: chain.escrow,
      explorer: deps.explorer === undefined ? (deps.config.rpc.includes('moderato') ? MODERATO.explorer : null) : deps.explorer,
      services: services.size,
    }),
  )

  /** The newest `limit` (default 200) Held/Released/Refunded events from block `since`, oldest first (from the event cache). */
  app.get('/events', async (c) => {
    const since = BigInt(c.req.query('since') ?? '0')
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 200) || 200, 1), 1000)
    await refreshLogs()
    const events = logCache.logs
      .filter((l) => l.eventName !== 'ServiceRegistered' && l.blockNumber >= since)
      .slice(-limit)
      .map((l) => {
        const args = l.args as { callId: Hex; serviceId: Hex }
        return { event: l.eventName, callId: args.callId, serviceId: args.serviceId, blockNumber: l.blockNumber, txHash: l.transactionHash, args: l.args }
      })
    return c.json(plain(events))
  })

  const receiptOf = (hash?: Hex) => (hash ? deps.publicClient.getTransactionReceipt({ hash }).catch(() => undefined) : Promise.resolve(undefined))
  const receiptLogs = async (hash?: Hex) => (await receiptOf(hash))?.logs ?? []

  /** An accountant's view of one call: every TIP-20 movement tagged with its callId, checked against the outcome. */
  // A final call's movements never change: answer it from memory after the first scan.
  const reconciled = new Map<string, unknown>()
  app.get('/reconcile/:callId', async (c) => {
    const record = await store.get(c.req.param('callId')).catch(() => undefined)
    if (!record) return c.json({ error: 'unknown call' }, 404)
    const cacheKey = `${record.callId.toLowerCase()}:${record.status}`
    if (reconciled.has(cacheKey)) return c.json(reconciled.get(cacheKey))
    const svc = services.get(record.serviceId.toLowerCase())
    if (!svc) return c.json({ error: 'service no longer served' }, 404)
    // Scan from the hold's block to the settlement's: one getLogs (the RPC caps the range). Without a
    // known settlement, at most one window's worth of blocks.
    const [holdReceipt, finalReceipt] = await Promise.all([receiptOf(record.holdTx), receiptOf(record.settleTx ?? record.timeoutTx)])
    if (!holdReceipt) return c.json({ error: 'hold receipt not available from the RPC; try again' }, 503)
    const toBlock = finalReceipt?.blockNumber ?? holdReceipt.blockNumber + 99_999n
    const all = await chain.movements(svc.token as Address, record.callId, holdReceipt.blockNumber, toBlock)
    const eq = (a: string, b?: string) => !!b && a.toLowerCase() === b.toLowerCase()
    // Anyone can send a transfer carrying this memo, even into the escrow: only the agent's hold and
    // the escrow's own payouts count (the escrow only ever pays out with the settled call's memo).
    const ownHold = (m: { from: string; to: string; txHash: string }) => eq(m.to, chain.escrow) && (record.agent ? eq(m.from, record.agent) : eq(m.txHash, record.holdTx))
    const movements = all.filter((m) => eq(m.from, chain.escrow) || ownHold(m))
    const holdOk = movements.length > 0 && eq(movements[0]!.to, chain.escrow) && movements[0]!.amount === svc.price
    const rest = movements.slice(1)
    const settledTotal = rest.reduce((sum, m) => sum + m.amount, 0n)
    const settled = rest.every((m) => eq(m.from, chain.escrow)) && settledTotal === svc.price
    const toAgent = rest.length === 1 && eq(rest[0]!.to, record.agent)
    const expected =
      record.status === 'released' ? 'hold → vendor (price − fee) + treasury (fee)'
      : record.status === 'refunded' || record.status === 'timed-out' ? 'hold → refund to the agent'
      : 'hold only (still in escrow)'
    const match =
      holdOk &&
      (record.status === 'released' ? settled && !toAgent
        : record.status === 'refunded' || record.status === 'timed-out' ? settled && toAgent
        : rest.length === 0)
    const body = plain({ callId: record.callId, status: record.status, token: svc.token, expected, match, movements, ignored: all.length - movements.length })
    if (FINAL.includes(record.status) && match) reconciled.set(cacheKey, body)
    return c.json(body)
  })

  /** Re-verify a call's proof offline (attestor, no key) and compare every hash with the chain. */
  app.post('/proofs/:callId/verify', async (c) => {
    const record = await store.get(c.req.param('callId')).catch(() => undefined)
    if (!record) return c.json({ error: 'unknown call' }, 404)
    const onchainSvc = await chain.service(record.serviceId)
    const re = await attestor.reverify({ callId: record.callId, serviceId: record.serviceId, predicateHash: onchainSvc.predicateHash })
    if ('error' in re) return c.json(re, 422)
    const held = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Held', logs: await receiptLogs(record.holdTx) }).find((l) => l.args.callId === record.callId)
    const settleLogs = await receiptLogs(record.settleTx)
    const released = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Released', logs: settleLogs })[0]
    const refunded = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Refunded', logs: settleLogs })[0]
    const settledEvent = released ?? refunded
    const onchain = {
      requestHash: held?.args.requestHash ?? null,
      originHash: onchainSvc.originHash,
      notaryKeyHash: onchainSvc.notaryKeyHash,
      predicateHash: onchainSvc.predicateHash,
      presentationHash: settledEvent?.args.presentationHash ?? null,
      outcome: released ? 'DELIVERED' : refunded ? 'FAILED' : null,
    }
    const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
    const checks = [
      { name: 'presentationHash', recomputed: re.presentationHash, onchain: onchain.presentationHash, ok: same(re.presentationHash, onchain.presentationHash) },
      { name: 'requestHash', recomputed: re.requestHash, onchain: onchain.requestHash, ok: same(re.requestHash, onchain.requestHash) },
      { name: 'originHash', recomputed: re.originHash, onchain: onchain.originHash, ok: same(re.originHash, onchain.originHash) },
      { name: 'notaryKeyHash', recomputed: re.notaryKeyHash, onchain: onchain.notaryKeyHash, ok: same(re.notaryKeyHash, onchain.notaryKeyHash) },
      { name: 'predicateHash', recomputed: re.predicateHash, onchain: onchain.predicateHash, ok: same(re.predicateHash, onchain.predicateHash) },
      { name: 'outcome', recomputed: re.outcome, onchain: onchain.outcome, ok: re.outcome === onchain.outcome },
      { name: 'callId header', recomputed: re.callHeader ?? null, onchain: record.callId, ok: re.callHeaderMatches },
    ]
    return c.json(plain({ callId: record.callId, ok: checks.every((k) => k.ok), checks, transcript: { request: re.request, response: re.response }, notaryKey: re.notaryKey, sessionTime: re.sessionTime }))
  })

  if (deps.dashboardDir && existsSync(deps.dashboardDir)) {
    app.get('/', (c) => c.redirect('/dashboard/'))
    app.get('/dashboard', (c) => c.redirect('/dashboard/'))
    app.use('/dashboard/*', serveStatic({ root: deps.dashboardDir, rewriteRequestPath: (p) => p.replace(/^\/dashboard/, '') }))
  }

  /** Adds a service registered while running (onboarding): the same chain checks as at startup,
   *  then it is served, listed, scored and exposed over MCP at once, and persisted to the config. */
  /**
   * Who listed a service: the gateway's operator (configured services, e.g. the demo's), or a lister
   * through self-serve onboarding, with whether that lister proved control of the API's host.
   */
  function listingOf(svc: Service) {
    if (!svc.onboarded) return { by: 'operator' as const }
    return { by: 'lister' as const, ownerVerified: !!svc.owner?.verified, method: svc.owner?.method ?? null, checkedAt: svc.owner?.checkedAt ?? null, detail: svc.owner?.detail ?? null }
  }

  /** Writes one service's config back to the gateway config file (onboarded services live there). */
  async function persist(serviceId: Hex, update: (cfg: ServiceConfig | undefined) => ServiceConfig) {
    if (!deps.configPath) return
    const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
    const file = (existsSync(deps.configPath) ? JSON.parse(readFileSync(deps.configPath, 'utf8')) : {}) as { services?: ServiceConfig[] }
    const current = (file.services ?? []).find((s) => s.serviceId.toLowerCase() === serviceId.toLowerCase())
    file.services = [...(file.services ?? []).filter((s) => s.serviceId.toLowerCase() !== serviceId.toLowerCase()), update(current)]
    writeFileSync(deps.configPath, `${JSON.stringify(file, null, 2)}\n`)
  }

  /**
   * Re-checks the ownership proof of verified self-serve listings older than `maxAgeMs` (a day): a
   * proof that is gone turns the listing to "owner not verified", with the date. The service stays
   * served (its terms are on-chain); only its label changes. Returns how many changed.
   */
  async function recheckOwners(maxAgeMs = 86_400_000): Promise<number> {
    const check = deps.onboard?.checkOwner
    if (!check) return 0
    let changed = 0
    for (const svc of services.values()) {
      if (!svc.onboarded || !svc.owner?.verified || Date.now() - Date.parse(svc.owner.checkedAt) < maxAgeMs) continue
      const { payout } = await chain.service(svc.serviceId)
      const owner = await check(new URL(svc.upstream).hostname, payout)
      const next = owner.verified ? owner : { ...owner, detail: `the ${svc.owner.method === 'dns' ? 'DNS TXT record' : '.well-known file'} proof is gone: ${owner.detail}` }
      if (!owner.verified) {
        changed++
        log(`service ${svc.serviceId.slice(0, 10)}: ownership proof no longer found; labelled "owner not verified"`)
      }
      svc.owner = next
      await persist(svc.serviceId, (cfg) => ({ ...(cfg ?? svc), owner: next }))
    }
    return changed
  }

  async function addService(input: ServiceConfig) {
    const cfg = { ...input, onboarded: true }
    const { signer } = await attestor.health()
    // Registered a moment ago: a lagging node may not show it yet. Wait for it, then check it once.
    await eventually(() => deps.chain.service(cfg.serviceId), (s) => !isAddressEqual(s.token, zeroAddress), 6, 1_000).catch(() => undefined)
    services.set(cfg.serviceId.toLowerCase(), await checkService(deps, signer, cfg))
    await persist(cfg.serviceId, () => cfg)
    log(`service ${cfg.serviceId} added (${cfg.upstream})`)
  }
  if (deps.onboard) {
    const ob = deps.onboard
    onboardRoutes(app, {
      ...ob,
      register: (input) => ob.register(input, addService),
      toolTaken: (name) => [...services.values()].some((s) => toolFor(s).name === name),
    })
  }

  if (deps.demo) publicRoutes(app, { ...deps.demo, examplePath: (sid) => services.get(sid.toLowerCase())?.examplePath, priceOf: (sid) => services.get(sid.toLowerCase())?.price })
  else app.all('/demo/*', (c) => c.json({ enabled: false, error: 'public demo mode is off (GATEWAY_PUBLIC=1)' }, 404))

  const mcp = mcpHandler({
    app, services, escrow: chain.escrow, chainId: chain.chainId, secretKey: deps.secretKey, realm: deps.config.realm,
    explorer: deps.explorer === undefined ? (deps.config.rpc.includes('moderato') ? MODERATO.explorer : null) : deps.explorer,
    fermataHandler, fulfil: fulfil as never, saturated, provable,
  })
  app.all('/mcp', (c) => mcp(c.req.raw))

  app.get('/llms.txt', (c) =>
    c.text(
      [
        '# Fermata gateway',
        'Paid API proxy: pay with the `fermata` MPP method (escrowed, released only on a TLSNotary proof of delivery) or `tempo` (unprotected).',
        ...[...services.values()].filter((s) => !s.legacy).map((s) => `- ${s.summary ?? 'service'}: ANY /s/${s.serviceId}${s.examplePath ?? '/'}`),
        'GET /services, GET /calls/:callId, GET /proofs/:callId (re-verify offline with `fermata-attest verify --offline`).',
        'MCP: POST /mcp (Streamable HTTP) — every service is a paid tool (MPP `fermata` method via _meta["org.paymentauth/credential"]); free tools fermata_call, fermata_verify, fermata_reconcile, fermata_vendor_scores.',
      ].join('\n'),
    ),
  )
  discovery(app as never, mppx as never, {
    routes: [...services.values()].filter((s) => !s.legacy).map((s) => ({
      handler: offers(s, ZERO_HASH) as never,
      method: 'GET',
      path: `/s/${s.serviceId}${(s.examplePath ?? '/').split('?')[0]}`,
      summary: s.summary ?? 'Paid call (fermata: escrowed, pay on proof; tempo: unprotected)',
    })),
    serviceInfo: { name: 'fermata-gateway', description: 'Pay on proof: escrowed machine payments released on TLSNotary evidence' } as never,
  } as never)

  /**
   * One sweep: retry pending settlements inside the window; claimTimeout after it. Sweeps never overlap:
   * a caller that arrives mid-sweep shares it. Otherwise a tick that starts while the previous one still
   * waits for its claimTimeout receipt sees the hold finalised and marks the call `closed`.
   */
  let sweeping: Promise<string[]> | undefined
  function sweep(): Promise<string[]> {
    sweeping ??= sweepOnce().finally(() => {
      sweeping = undefined
    })
    return sweeping
  }

  async function sweepOnce() {
    const now = await chain.now()
    const done: string[] = []
    for (const record of await store.list()) {
      // A call being proved right now is this process's: never settle or claim it from here too.
      if (FINAL.includes(record.status) || inFlight.has(record.callId.toLowerCase())) continue
      const hold = await chain.hold(record.callId)
      if (hold.status === 0) {
        // Not visible yet: an RPC node behind the one that showed the hold. Never final from one read;
        // only a record whose hold has not appeared for an hour is given up.
        if (Date.now() - Date.parse(record.createdAt) > 3_600_000) {
          await store.update(record.callId, { status: 'closed', error: 'hold not found on-chain for over an hour (escrow status 0)' })
        }
        continue
      }
      if (hold.status !== 1) {
        // Finalised by someone else (anyone may settle a signed verdict or claim a timeout).
        const status = hold.status === 2 ? 'released' : hold.status === 3 ? 'refunded' : hold.status === 4 ? 'timed-out' : 'closed'
        await store.update(record.callId, { status, error: `finalised on-chain by another transaction (escrow status ${hold.status})` })
        continue
      }
      if (now <= hold.deadline) {
        if (record.status === 'settle-pending') await settleVerdict(record)
        else if (record.status === 'awaiting-timeout' && record.recoverable) await recover(record)
        continue
      }
      const result = await chain.claimTimeout(record.callId)
      if (result.ok) {
        log(`call ${record.callId.slice(0, 10)} timed out: agent refunded in ${result.txHash}`)
        await store.update(record.callId, { status: 'timed-out', timeoutTx: result.txHash })
        done.push(record.callId)
      } else {
        log(`call ${record.callId.slice(0, 10)} claimTimeout failed: ${result.error}`)
      }
    }
    return done
  }

  return { app, services, sweep, mppx, addService, warmLogs: refreshLogs, backfillStatuses, recheckOwners }
}
