import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { Credential, Receipt } from 'mppx'
import { discovery } from 'mppx/hono'
import { Mppx, tempo } from 'mppx/server'
import { isAddressEqual, parseEventLogs, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { aggregateScores, fermataEscrowAbi, fermataServer, MODERATO, originHash, requestHash, serviceLabelOf, type EscrowLog } from '@fermata/sdk'
import type { Attestor, ProvedResponse } from './attestor.ts'
import { toVerdict, type GatewayChain } from './chain.ts'
import type { GatewayConfig, ServiceConfig } from './config.ts'
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
}

/** JSON-safe copy (bigints as decimal strings). */
const plain = <T>(v: T): unknown => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)))

type Service = ServiceConfig & { price: bigint; token: Hex; window: number }

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

/** Checks every configured service against the chain and the attestor; refuses to start on mismatch. */
/** A configured service checked against the chain: registered, settled by this attestor, same origin. */
async function checkService(deps: GatewayDeps, signer: Address, cfg: ServiceConfig): Promise<Service> {
  const s = await deps.chain.service(cfg.serviceId)
  if (isAddressEqual(s.token, zeroAddress)) throw new Error(`service ${cfg.serviceId} is not registered on ${deps.chain.escrow}`)
  if (!isAddressEqual(s.verifier, signer)) throw new Error(`service ${cfg.serviceId} is settled by ${s.verifier}, not this attestor (${signer})`)
  if (originHash(cfg.upstream) !== s.originHash) throw new Error(`service ${cfg.serviceId}: upstream ${cfg.upstream} is not the registered origin`)
  return { ...cfg, price: s.pricePerCall, token: s.token, window: s.settlementWindow }
}

/** Checks every configured service against the chain and the attestor; refuses to start on mismatch. */
export async function loadServices(deps: GatewayDeps): Promise<Map<string, Service>> {
  const health = await deps.attestor.health()
  if (!isAddressEqual(health.escrow, deps.chain.escrow)) throw new Error(`attestor serves escrow ${health.escrow}, gateway ${deps.chain.escrow}`)
  if (health.chainId !== deps.chain.chainId) throw new Error(`attestor on chain ${health.chainId}, gateway on ${deps.chain.chainId}`)
  const out = new Map<string, Service>()
  for (const cfg of deps.config.services) {
    try {
      out.set(cfg.serviceId.toLowerCase(), await checkService(deps, health.signer, cfg))
    } catch (e) {
      if (!cfg.onboarded) throw e
      ;(deps.log ?? console.warn)(`onboarded service ${cfg.serviceId} skipped: ${(e as Error).message}`)
    }
  }
  return out
}

export async function createGateway(deps: GatewayDeps) {
  const log = deps.log ?? ((m: string) => console.log(`[gateway] ${m}`))
  const services = await loadServices(deps)
  const { chain, store, attestor } = deps
  const fermataHandler = fermataServer({ client: deps.publicClient, escrow: chain.escrow })
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
  async function fulfil(
    svc: Service,
    req: { method: string; target: string; headers: Headers; body: Uint8Array },
    credential: { challenge: { request: unknown }; payload: unknown },
  ): Promise<{ response: Response; record: CallRecord }> {
    const callId = (credential.challenge.request as { callId: Hex }).callId
    const holdTx = (credential.payload as { txHash: Hex }).txHash
    const rh = requestHash(svc.serviceId, req.method, req.target, req.body)
    const hold = await chain.hold(callId)
    const now = new Date().toISOString()
    let record = await store.put({
      callId, serviceId: svc.serviceId, method: req.method, target: req.target, requestHash: rh, holdTx, agent: hold.agent,
      deadline: hold.deadline.toString(), status: 'held', createdAt: now, updatedAt: now,
    })

    const result = await attestor.attest({
      callId, url: `${svc.upstream}${req.target}`, method: req.method, headers: upstreamHeaders(svc, req.headers), body: Buffer.from(req.body).toString('utf8'),
    })

    if (result.kind !== 'verdict') {
      // No transcript (vendor silent, TLS failure, notary/prover down) or a failed binding check:
      // never a verdict. Only claimTimeout can end the hold; the sweeper sends it after the window.
      const detail = result.kind === 'rejected' ? `${result.check}: ${result.detail}` : result.detail
      console.error(`[gateway] call ${callId} has NO VERDICT (${result.kind}: ${detail}); awaiting timeout at ${hold.deadline}`)
      record = await store.update(callId, { status: 'awaiting-timeout', error: `${result.kind}: ${detail}` })
      const response = Response.json(
        { error: result.kind, detail, callId, status: 'awaiting-timeout', refundAfter: hold.deadline.toString(), reclaim: 'claimTimeout(callId) on the escrow after refundAfter' },
        { status: result.kind === 'rejected' ? 502 : 504 },
      )
      return { response, record }
    }

    record = await store.update(callId, {
      outcome: result.signed.outcome,
      failures: result.signed.failures,
      verdict: result.signed.verdict,
      signature: result.signed.signatureBytes,
      presentationHash: result.presentationHash,
      proveMs: result.proveMs,
      notaryBytes: result.notaryBytes,
      signer: result.signed.signer,
    })
    record = await settleVerdict(record)
    return { response: provedToResponse(result.response), record }
  }

  const app = new Hono()

  const paid = async (c: import('hono').Context) => {
    const sidParam = c.req.param('serviceId') ?? ''
    const svc = services.get(sidParam.toLowerCase())
    if (!svc) return c.json({ error: `unknown service ${sidParam}` }, 404)
    const url = new URL(c.req.url)
    const prefix = `/s/${sidParam}`
    const target = (url.pathname.slice(prefix.length) || '/') + url.search
    const method = c.req.method.toUpperCase()
    const body = new Uint8Array(await c.req.raw.clone().arrayBuffer())
    const rh = requestHash(svc.serviceId, method, target, body)

    const r = await offers(svc, rh)(c.req.raw)
    if (r.status === 402) return r.challenge

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
        settlementWindow: s.window, escrow: chain.escrow, chainId: chain.chainId, unprotectedFallback: s.tempo ?? null,
      })),
    ),
  )
  // Vendor scores from the escrow's own events (the same code as `pnpm scores`): refreshed at most
  // every 5 s, reading only blocks not yet seen.
  const scoreState: { logs: EscrowLog[]; next: bigint; at: number; pending?: Promise<void> } = { logs: [], next: BigInt(deps.config.fromBlock ?? 0), at: 0 }
  const refreshScores = async () => {
    if (Date.now() - scoreState.at < 5_000) return
    scoreState.pending ??= (async () => {
      try {
        const { logs, toBlock } = await chain.escrowLogs(scoreState.next)
        scoreState.logs.push(...logs)
        scoreState.next = toBlock + 1n
        scoreState.at = Date.now()
      } finally {
        scoreState.pending = undefined
      }
    })()
    await scoreState.pending
  }
  app.get('/scores', async (c) => {
    await refreshScores()
    const scores = aggregateScores(scoreState.logs).map((s) => {
      const svc = services.get(s.serviceId.toLowerCase())
      return {
        ...s,
        label: serviceLabelOf(s.serviceId) ?? null,
        known: !!svc,
        upstream: svc?.upstream ?? null,
        summary: svc?.summary ?? null,
        tool: svc ? toolFor(svc).name : null,
        fewCalls: s.settled < 20,
      }
    })
    return c.json(plain({
      escrow: chain.escrow, chainId: chain.chainId, scannedTo: scoreState.next - 1n, method: 'Wilson 95 % lower bound of released / settled, from ServiceRegistered/Held/Released/Refunded events only',
      recompute: 'pnpm scores --chain <anvil|moderato> --escrow <escrow>',
      caveats: ['Only calls paid through Fermata count.', 'A vendor could pay itself to inflate its score; distinct agents are shown for that reason.'],
      scores,
    }))
  })

  app.get('/calls', async (c) => c.json(await store.list()))
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
  app.get('/info', (c) =>
    c.json({
      chainId: chain.chainId,
      escrow: chain.escrow,
      explorer: deps.explorer === undefined ? (deps.config.rpc.includes('moderato') ? MODERATO.explorer : null) : deps.explorer,
      services: services.size,
    }),
  )

  app.get('/events', async (c) => {
    const since = BigInt(c.req.query('since') ?? '0')
    return c.json(plain(await chain.events(since)))
  })

  const receiptLogs = async (hash?: Hex) =>
    hash ? (await deps.publicClient.getTransactionReceipt({ hash }).catch(() => undefined))?.logs ?? [] : []

  /** An accountant's view of one call: every TIP-20 movement tagged with its callId, checked against the outcome. */
  app.get('/reconcile/:callId', async (c) => {
    const record = await store.get(c.req.param('callId')).catch(() => undefined)
    if (!record) return c.json({ error: 'unknown call' }, 404)
    const svc = services.get(record.serviceId.toLowerCase())!
    const holdReceipt = await deps.publicClient.getTransactionReceipt({ hash: record.holdTx }).catch(() => undefined)
    const movements = await chain.movements(svc.token as Address, record.callId, holdReceipt?.blockNumber ?? 0n)
    const eq = (a: string, b?: string) => !!b && a.toLowerCase() === b.toLowerCase()
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
    return c.json(plain({ callId: record.callId, status: record.status, token: svc.token, expected, match, movements }))
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
  async function addService(input: ServiceConfig) {
    const cfg = { ...input, onboarded: true }
    const { signer } = await attestor.health()
    services.set(cfg.serviceId.toLowerCase(), await checkService(deps, signer, cfg))
    if (deps.configPath) {
      const { readFileSync, writeFileSync } = await import('node:fs')
      const { existsSync } = await import('node:fs')
      const file = (existsSync(deps.configPath) ? JSON.parse(readFileSync(deps.configPath, 'utf8')) : {}) as { services?: ServiceConfig[] }
      file.services = [...(file.services ?? []).filter((s) => s.serviceId.toLowerCase() !== cfg.serviceId.toLowerCase()), cfg]
      writeFileSync(deps.configPath, `${JSON.stringify(file, null, 2)}\n`)
    }
    log(`service ${cfg.serviceId} added (${cfg.upstream})`)
  }
  if (deps.onboard) {
    const ob = deps.onboard
    onboardRoutes(app, { ...ob, register: (input) => ob.register(input, addService) })
  }

  if (deps.demo) publicRoutes(app, { ...deps.demo, examplePath: (sid) => services.get(sid.toLowerCase())?.examplePath })
  else app.all('/demo/*', (c) => c.json({ enabled: false, error: 'public demo mode is off (GATEWAY_PUBLIC=1)' }, 404))

  const mcp = mcpHandler({
    app, services, escrow: chain.escrow, chainId: chain.chainId, secretKey: deps.secretKey, realm: deps.config.realm,
    explorer: deps.explorer === undefined ? (deps.config.rpc.includes('moderato') ? MODERATO.explorer : null) : deps.explorer,
    fermataHandler, fulfil: fulfil as never,
  })
  app.all('/mcp', (c) => mcp(c.req.raw))

  app.get('/llms.txt', (c) =>
    c.text(
      [
        '# Fermata gateway',
        'Paid API proxy: pay with the `fermata` MPP method (escrowed, released only on a TLSNotary proof of delivery) or `tempo` (unprotected).',
        ...[...services.values()].map((s) => `- ${s.summary ?? 'service'}: ANY /s/${s.serviceId}${s.examplePath ?? '/'}`),
        'GET /services, GET /calls/:callId, GET /proofs/:callId (re-verify offline with `fermata-attest verify --offline`).',
        'MCP: POST /mcp (Streamable HTTP) — every service is a paid tool (MPP `fermata` method via _meta["org.paymentauth/credential"]); free tools fermata_call, fermata_verify, fermata_reconcile.',
      ].join('\n'),
    ),
  )
  discovery(app as never, mppx as never, {
    routes: [...services.values()].map((s) => ({
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
      if (FINAL.includes(record.status) || record.status === 'held') continue
      const hold = await chain.hold(record.callId)
      if (hold.status !== 1) {
        await store.update(record.callId, { status: 'closed', error: `finalised on-chain elsewhere (status ${hold.status})` })
        continue
      }
      if (now <= hold.deadline) {
        if (record.status === 'settle-pending') await settleVerdict(record)
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

  return { app, services, sweep, mppx, addService }
}
