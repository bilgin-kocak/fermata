// Probe 2 client A: pays through the custom `probe` method (plugin), then replays the credential.
import assert from 'node:assert/strict'
import { Credential, Receipt } from 'mppx'
import { Method } from 'mppx'
import { Mppx } from 'mppx/client'
import { BASE, fakeHold, probe } from './common.ts'

const probeClient = Method.toClient(probe, {
  async createCredential({ challenge }) {
    const callId = challenge.request.callId
    if (!callId) throw new Error('challenge has no callId')
    return Credential.serialize({ challenge, payload: { type: 'hold', txHash: fakeHold(callId), callId } })
  },
})
const m = Mppx.create({ methods: [probeClient], polyfill: false })
const body = JSON.stringify({ symbol: 'BTC-USD' })

const res1 = await m.fetch(`${BASE}/quote`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
assert.equal(res1.status, 200, `expected 200, got ${res1.status}: ${await res1.text()}`)
const r1 = Receipt.fromResponse(res1) as Receipt.Receipt & { callId?: string; outcome?: string }
console.log('call 1:', res1.status, JSON.stringify(r1))
assert.equal(r1.method, 'probe'); assert.equal(r1.status, 'success'); assert.ok(r1.callId, 'receipt has callId'); assert.equal(r1.outcome, 'DELIVERED')
assert.equal(r1.reference, fakeHold(r1.callId!), 'reference == hold tx hash')

const res2 = await m.fetch(`${BASE}/quote`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
const r2 = Receipt.fromResponse(res2) as Receipt.Receipt & { callId?: string }
assert.equal(res2.status, 200); assert.notEqual(r2.callId, r1.callId, 'second call gets a fresh callId')
console.log('call 2:', res2.status, 'fresh callId', r2.callId)

// Replay: re-send the exact credential of call 1 (recovered from the challenge it paid).
const c402 = await fetch(`${BASE}/quote`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'accept-payment': 'probe/charge' } })
assert.equal(c402.status, 402)
const cred1 = await m.createCredential(c402)
const paid = await fetch(`${BASE}/quote`, { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: cred1! } })
assert.equal(paid.status, 200)
const replay = await fetch(`${BASE}/quote`, { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: cred1! } })
const problem = await replay.json()
console.log('replay:', replay.status, problem.type)
assert.equal(replay.status, 402); assert.match(problem.type, /verification-failed/)
console.log('OK: probe client paid via the custom method; receipt carries callId; replay rejected')
