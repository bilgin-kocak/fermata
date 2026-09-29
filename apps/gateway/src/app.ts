import { Hono } from 'hono'
import { Credential, Receipt } from 'mppx'
import { discovery } from 'mppx/hono'
import { Mppx, tempo } from 'mppx/server'
import { isAddressEqual, zeroAddress, type Hex, type PublicClient } from 'viem'
import { fermataServer, originHash, requestHash } from '@fermata/sdk'
import type { Attestor, ProvedResponse } from './attestor.ts'
import { toVerdict, type GatewayChain } from './chain.ts'
import type { GatewayConfig, ServiceConfig } from './config.ts'
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
}

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
export async function loadServices(deps: GatewayDeps): Promise<Map<string, Service>> {
  const health = await deps.attestor.health()
  if (!isAddressEqual(health.escrow, deps.chain.escrow)) throw new Error(`attestor serves escrow ${health.escrow}, gateway ${deps.chain.escrow}`)
  if (health.chainId !== deps.chain.chainId) throw new Error(`attestor on chain ${health.chainId}, gateway on ${deps.chain.chainId}`)
  const out = new Map<string, Service>()
  for (const cfg of deps.config.services) {
    const s = await deps.chain.service(cfg.serviceId)
    if (isAddressEqual(s.token, zeroAddress)) throw new Error(`service ${cfg.serviceId} is not registered on ${deps.chain.escrow}`)
    if (!isAddressEqual(s.verifier, health.signer)) throw new Error(`service ${cfg.serviceId} is settled by ${s.verifier}, not this attestor (${health.signer})`)
    if (originHash(cfg.upstream) !== s.originHash) throw new Error(`service ${cfg.serviceId}: upstream ${cfg.upstream} is not the registered origin`)
    out.set(cfg.serviceId.toLowerCase(), { ...cfg, price: s.pricePerCall, token: s.token, window: s.settlementWindow })
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

    const callId = (credential.challenge.request as { callId: Hex }).callId
    const holdTx = (credential.payload as { txHash: Hex }).txHash
    const hold = await chain.hold(callId)
    const now = new Date().toISOString()
    let record = await store.put({
      callId, serviceId: svc.serviceId, method, target, requestHash: rh, holdTx, agent: hold.agent,
      deadline: hold.deadline.toString(), status: 'held', createdAt: now, updatedAt: now,
    })

    const result = await attestor.attest({
      callId, url: `${svc.upstream}${target}`, method, headers: upstreamHeaders(svc, c.req.raw.headers), body: Buffer.from(body).toString('utf8'),
    })

    if (result.kind !== 'verdict') {
      // No transcript (vendor silent, TLS failure, notary/prover down) or a failed binding check:
      // never a verdict. Only claimTimeout can end the hold; the sweeper sends it after the window.
      const detail = result.kind === 'rejected' ? `${result.check}: ${result.detail}` : result.detail
      console.error(`[gateway] call ${callId} has NO VERDICT (${result.kind}: ${detail}); awaiting timeout at ${hold.deadline}`)
      record = await store.update(callId, { status: 'awaiting-timeout', error: `${result.kind}: ${detail}` })
      const res = r.withReceipt(
        Response.json(
          { error: result.kind, detail, callId, status: 'awaiting-timeout', refundAfter: hold.deadline.toString(), reclaim: 'claimTimeout(callId) on the escrow after refundAfter' },
          { status: result.kind === 'rejected' ? 502 : 504 },
        ),
      )
      return withFermataReceipt(res, record)
    }

    record = await store.update(callId, {
      outcome: result.signed.outcome,
      failures: result.signed.failures,
      verdict: result.signed.verdict,
      signature: result.signed.signatureBytes,
      presentationHash: result.presentationHash,
      proveMs: result.proveMs,
    })
    record = await settleVerdict(record)
    return withFermataReceipt(r.withReceipt(provedToResponse(result.response)), record)
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
  app.get('/llms.txt', (c) =>
    c.text(
      [
        '# Fermata gateway',
        'Paid API proxy: pay with the `fermata` MPP method (escrowed, released only on a TLSNotary proof of delivery) or `tempo` (unprotected).',
        ...[...services.values()].map((s) => `- ${s.summary ?? 'service'}: ANY /s/${s.serviceId}${s.examplePath ?? '/'}`),
        'GET /services, GET /calls/:callId, GET /proofs/:callId (re-verify offline with `fermata-attest verify --offline`).',
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

  /** One sweep: retry pending settlements inside the window; claimTimeout after it. */
  async function sweep() {
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

  return { app, services, sweep, mppx }
}
