// Probe 2 error-mapping check: with PROBE_THROW_PLAIN=1 the server's validate throws a plain Error →
// mppx maps it to HTTP 500 internal-payment-error (not 402). Documents why VerificationFailedError is mandatory.
import assert from 'node:assert/strict'
import { Credential, Method } from 'mppx'
import { Mppx } from 'mppx/client'
import { BASE, fakeHold, probe } from './common.ts'

const probeClient = Method.toClient(probe, {
  async createCredential({ challenge }) {
    const callId = challenge.request.callId!
    return Credential.serialize({ challenge, payload: { type: 'hold', txHash: fakeHold(callId), callId } })
  },
})
const m = Mppx.create({ methods: [probeClient], polyfill: false })
const body = JSON.stringify({ symbol: 'BTC-USD' })
const c402 = await fetch(`${BASE}/quote`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'accept-payment': 'probe/charge' } })
const cred = await m.createCredential(c402)
const res = await fetch(`${BASE}/quote`, { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: cred! } })
const problem = await res.json()
console.log('plain Error in validate →', res.status, problem.type)
assert.equal(res.status, 500); assert.match(problem.type, /internal-payment-error/)
console.log('OK: a plain Error becomes 500; VerificationFailedError is required for a 402')
