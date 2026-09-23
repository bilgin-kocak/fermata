// Probe 2 client B: a vanilla tempo client. Local leg: asserts the 402 carries both methods and that
// the client selects `tempo`; stops before paying (tempo's credential needs the Moderato RPC).
// Moderato leg (MODERATO=1): pays for real with a faucet-funded key and prints the tx hash.
import assert from 'node:assert/strict'
import { Challenge, Receipt } from 'mppx'
import { Mppx, tempo } from 'mppx/client'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions } from 'viem/tempo'
import { tempoModerato } from 'viem/chains'
import { BASE } from './common.ts'

const body = JSON.stringify({ symbol: 'BTC-USD' })
// 1. plain fetch, no Accept-Payment → both challenges
const plain = await fetch(`${BASE}/quote`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
assert.equal(plain.status, 402)
const challenges = Challenge.fromResponseList(plain)
const methods = challenges.map((c) => c.method).sort()
console.log('402 challenges:', methods, 'WWW-Authenticate values:', plain.headers.get('www-authenticate')?.split(', Payment ').length)
assert.deepEqual(methods, ['probe', 'tempo'])

// 2. vanilla tempo client: selection only (local) or full payment (Moderato)
const account = privateKeyToAccount(generatePrivateKey())
let selected: string | undefined
const moderato = process.env.MODERATO === '1'
const m = Mppx.create({
  methods: [tempo.charge({ account })],
  polyfill: false,
  acceptPaymentPolicy: 'never',
  async onChallenge(challenge, { createCredential }) {
    selected = challenge.method
    if (moderato) return createCredential()
    throw new Error('SELECTED') // local leg: stop before paying (tempo's credential needs the RPC)
  },
})
if (moderato) {
  const client = createClient({ chain: tempoModerato, transport: http() })
  await Actions.faucet.fundSync(client, { account })
  const res = await m.fetch(`${BASE}/quote`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
  assert.equal(res.status, 200)
  const receipt = Receipt.fromResponse(res) as Receipt.Receipt & { unprotected?: boolean }
  console.log('tempo payment:', receipt, `https://explore.testnet.tempo.xyz/tx/${receipt.reference}`)
  assert.equal(receipt.method, 'tempo'); assert.equal(receipt.unprotected, true)
} else {
  const err = await m.fetch(`${BASE}/quote`, { method: 'POST', body, headers: { 'content-type': 'application/json' } }).then(() => undefined, (e: Error) => e)
  console.log('vanilla client selected:', selected, '(stopped before paying on the local leg:', err?.message, ')')
  assert.equal(selected, 'tempo'); assert.match(String(err?.message), /SELECTED/)
}
console.log('OK: vanilla tempo client sees both challenges and falls back to tempo')
