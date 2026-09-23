// Probe 2 server: one 402 offering the built-in `tempo` charge (Moderato) and the custom `probe` charge.
import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Credential, Errors, Receipt, Store } from 'mppx'
import { Method } from 'mppx'
import { discovery } from 'mppx/hono'
import { Mppx, tempo } from 'mppx/server'
import { privateKeyToAccount } from 'viem/accounts'
import { BASE, ESCROW_PLACEHOLDER, PATH_USD, PORT, SECRET_KEY, SERVICE_ID, fakeHold, probe, requestHash } from './common.ts'

const store = Store.memory()
const throwPlain = process.env.PROBE_THROW_PLAIN === '1'

const probeServer = Method.toServer(probe, {
  // Runs on the 402 pass (no credential) and again on the paid pass: echo the credential's callId
  // so the recomputed challenge equals the one the client paid for.
  request({ credential, request }) {
    return { ...request, callId: (credential?.challenge.request as { callId?: string } | undefined)?.callId ?? randomUUID() }
  },
  // Route-binding check: everything except the per-challenge callId.
  stableBinding: (r) => ({ amount: r.amount, currency: r.currency, serviceId: r.serviceId, requestHash: r.requestHash }),
  async validate({ credential, request }) {
    const callId = credential.challenge.request.callId
    if (!callId) throw new Errors.VerificationFailedError({ reason: 'challenge carries no callId' })
    if (credential.payload.callId !== callId) throw new Errors.VerificationFailedError({ reason: 'credential callId != challenge callId' })
    if (credential.payload.txHash !== fakeHold(callId)) throw new Errors.VerificationFailedError({ reason: 'no Held event for this callId' })
    if (throwPlain) throw new Error('plain error (documents the 500 mapping)')
    return { challenge: credential.challenge, credential, details: { callId }, intent: 'charge', method: 'probe', request, source: credential.source } as never
  },
  async broadcast({ credential }) {
    const callId = credential.challenge.request.callId!
    const ok = await Store.tryClaim(store as never, `call:${callId}`, Date.parse(credential.challenge.expires!))
    if (!ok) throw new Errors.VerificationFailedError({ reason: 'callId already used' })
    return { method: 'probe', reference: credential.payload.txHash, status: 'success', timestamp: new Date().toISOString() }
  },
})

const vendor = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000002')
const tempoCharge = tempo.charge({ testnet: true, recipient: vendor.address })
const mppx = Mppx.create({ secretKey: SECRET_KEY, realm: 'localhost', methods: [tempoCharge, probeServer] })

const app = new Hono()
app.post('/quote', async (c) => {
  const body = await c.req.raw.clone().text()
  const rh = requestHash(SERVICE_ID, 'POST', '/quote', body)
  // per-request compose: probe's route options carry the requestHash; tempo keeps its own options
  const paid = mppx.compose(
    [tempoCharge, { amount: '0.01' }],
    [probeServer, { amount: '10000', currency: PATH_USD, recipient: ESCROW_PLACEHOLDER, serviceId: SERVICE_ID, requestHash: rh }],
  )
  const r = await paid(c.req.raw)
  if (r.status === 402) return r.challenge
  let symbol = 'BTC-USD'
  try { symbol = JSON.parse(body).symbol ?? symbol } catch {}
  const res = r.withReceipt(c.json({ price: 64231.5, symbol, timestamp: Math.floor(Date.now() / 1000) }))
  // Fermata receipt: add callId / outcome after settlement; tempo-paid calls are tagged unprotected.
  let callId: string | undefined
  try { callId = (Credential.fromRequest(c.req.raw).challenge.request as { callId?: string }).callId } catch {}
  const base = Receipt.fromResponse(res)
  const receipt = base.method === 'probe' ? { ...base, callId, outcome: 'DELIVERED' } : { ...base, unprotected: true }
  res.headers.set('Payment-Receipt', Receipt.serialize(receipt as never))
  return res
})
// Discovery: a representative composed handler (zero requestHash) carries both offers' metadata.
const discoveryHandler = mppx.compose(
  [tempoCharge, { amount: '0.01' }],
  [probeServer, { amount: '10000', currency: PATH_USD, recipient: ESCROW_PLACEHOLDER, serviceId: SERVICE_ID, requestHash: '0x' + '00'.repeat(32) }],
)
discovery(app, mppx, {
  routes: [{ handler: discoveryHandler as never, method: 'POST', path: '/quote', summary: 'Quote (paid: tempo unprotected, or probe escrowed)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { symbol: { type: 'string' } } } } } } }],
  serviceInfo: { name: 'fermata-spike', description: 'Milestone S probe 2' } as never,
})
app.get('/llms.txt', (c) => c.text('# fermata spike\nPOST /quote — paid quote endpoint (MPP: tempo or probe method).\n'))
serve({ fetch: app.fetch, port: PORT }, () => console.log(`server ready on ${BASE} (throwPlain=${throwPlain})`))
