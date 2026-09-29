// Milestone 2 live run: hold → real TLSNotary proof of the vendor → attestor verdict → settle.
// Started by scripts/e2e-attest.sh (Anvil, escrow, three demo vendors, notary, `fermata-attest serve`).
//
//   DELIVERED  vendor answers 200 JSON        → attestor DELIVERED → settle → Released (vendor paid)
//   FAILED     vendor answers authenticated 500 → attestor FAILED  → settle → Refunded
//   NO PROOF   vendor never answers           → attestor 502 no-transcript, no verdict → claimTimeout
// plus: an old presentation cannot settle a new hold (check 6), and a downloaded presentation
// re-verifies offline against the hashes read from the chain.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  zeroHash,
  type Address,
  type Hex,
  type LocalAccount,
  type TransactionReceipt,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  escrowDeployment,
  fermataEscrowAbi,
  notaryKeyHash,
  originHash,
  predicateHash,
  requestHash,
  serviceId,
  TOKENS,
  type Verdict,
} from '@fermata/sdk'
import { memoMovements, signPermit, tempoChain, tip20Abi } from './lib/tempo.ts'

const env = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set (run scripts/e2e-attest.sh)`)
  return v
}
const rpc = env('ANVIL_RPC_URL')
const attestor = env('ATTESTOR_URL')
const attestBin = env('ATTEST_BIN')
const ca = env('VENDOR_CA')
const predicatePath = env('PREDICATE')
const notaryKey = env('NOTARY_PUBLIC_KEY') as Hex
const ports = { ok: env('VENDOR_OK_PORT'), e500: env('VENDOR_500_PORT'), hang: env('VENDOR_HANG_PORT') }
const TARGET = '/v1/quote?symbol=BTC-USD'
const PRICE = 10_000n
const WINDOW = 120
const TOKEN = TOKENS.pathUSD as Address

const chain = tempoChain(rpc)
const pub = createPublicClient({ chain, transport: http(rpc) })
const wallet = (a: LocalAccount) => createWalletClient({ account: a, chain, transport: http(rpc) })
const funder = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const vendor = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
const relayer = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a')
const agent = privateKeyToAccount(generatePrivateKey())
const escrow = escrowDeployment('anvil')!.address
const predicate = (await import('node:fs')).readFileSync(predicatePath)

const failures: string[] = []
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
}

async function send(account: LocalAccount, request: object): Promise<TransactionReceipt> {
  const hash = await wallet(account).writeContract(request as never)
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`reverted: ${hash}`)
  return receipt
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${attestor}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

const health = (await (await fetch(`${attestor}/healthz`)).json()) as { signer: Address }
const verifier = health.signer as Address
console.log(`escrow ${escrow}, attestor ${attestor} (signer ${verifier}), agent ${agent.address}`)

async function register(label: string, port: string): Promise<Hex> {
  const sid = serviceId(vendor.address, label)
  await send(vendor, {
    address: escrow,
    abi: fermataEscrowAbi,
    functionName: 'registerService',
    args: [sid, vendor.address, TOKEN, PRICE, WINDOW, verifier, predicateHash(predicate), originHash(`https://vendor.fermata.test:${port}`), notaryKeyHash(notaryKey)],
  })
  return sid
}

async function hold(sid: Hex): Promise<Hex> {
  const callId = keccak256(randomBytes(32))
  const deadline = (await pub.getBlock()).timestamp + 600n
  const { v, r, s } = await signPermit(pub, TOKEN, agent, escrow, PRICE, deadline)
  const receipt = await send(agent, {
    address: escrow,
    abi: fermataEscrowAbi,
    functionName: 'hold',
    args: [callId, sid, requestHash(sid, 'GET', TARGET), deadline, v, r, s],
  })
  check(memoMovements(receipt, callId).length === 1, `held ${callId.slice(0, 10)}… (agent → escrow, memo = callId)`)
  return callId
}

const attestBody = (callId: Hex, port: string) => ({
  callId,
  url: `https://vendor.fermata.test:${port}${TARGET}`,
  method: 'GET',
  headers: { accept: 'application/json', authorization: 'Bearer e2e-secret-token' },
})

function toVerdict(v: any): Verdict {
  return {
    callId: v.call_id, serviceId: v.service_id, requestHash: v.request_hash, predicateHash: v.predicate_hash,
    outcome: v.outcome, presentationHash: v.presentation_hash, responseHash: v.response_hash, issuedAt: BigInt(v.issued_at),
  }
}

async function settle(callId: Hex, signed: any) {
  return send(relayer, { address: escrow, abi: fermataEscrowAbi, functionName: 'settle', args: [callId, toVerdict(signed.verdict), signed.signatureBytes] })
}

await send(funder, { address: TOKEN, abi: tip20Abi, functionName: 'transfer', args: [agent.address, 250_000n] })
const sidOk = await register('e2e-ok', ports.ok)
const sid500 = await register('e2e-500', ports.e500)
const sidHang = await register('e2e-hang', ports.hang)

// ------------------------------------------------------------------ DELIVERED
console.log('\nDELIVERED (vendor answers 200)')
const callOk = await hold(sidOk)
const t0 = Date.now()
const ok = await post('/v1/attest', attestBody(callOk, ports.ok))
console.log(`  attest HTTP ${ok.status} in ${Date.now() - t0} ms (prove ${ok.json.prove?.proveMs} ms, ${ok.json.prove?.presentationBytes} B)`)
check(ok.status === 200 && ok.json.verdict?.outcome === 'DELIVERED', `attestor verdict DELIVERED (${JSON.stringify(ok.json.verdict?.failures ?? ok.json)})`)
const proved = JSON.parse(Buffer.from(ok.json.response?.bodyBase64 ?? '', 'base64').toString() || '{}')
check(ok.json.response?.status === 200 && typeof proved.price === 'number', `attestor returns the proved response (${ok.json.response?.status}, price ${proved.price})`)
const rOk = await settle(callOk, ok.json.verdict)
const [released] = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Released', logs: rOk.logs })
check(released?.args.presentationHash === ok.json.presentationHash, 'Released with the attestor presentationHash')
check(memoMovements(rOk, callOk).length === 2, 'settle: escrow → vendor + treasury, memo = callId')

// offline re-verification by a third party: download the proof, compare with on-chain hashes
const proof = new Uint8Array(await (await fetch(`${attestor}/v1/presentations/${callOk}`)).arrayBuffer())
check(keccak256(proof) === released?.args.presentationHash, 'downloaded presentation hashes to the on-chain presentationHash')
const proofFile = `out/presentation-${callOk}.tlsn`
writeFileSync(proofFile, proof)
const svc = await pub.readContract({ address: escrow, abi: fermataEscrowAbi, functionName: 'getService', args: [sidOk] })
const offline = JSON.parse(
  execFileSync(attestBin, [
    'verify', '--offline', '--presentation', proofFile, '--ca', ca, '--call-id', callOk, '--predicate', predicatePath,
    '--service-id', sidOk, '--request-hash', requestHash(sidOk, 'GET', TARGET), '--origin-hash', svc.originHash, '--notary-key-hash', svc.notaryKeyHash,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
)
check(offline.ok === true && offline.outcome === 'DELIVERED', 'offline re-verification: same outcome, all hashes match the chain')
check(!offline.request.includes('e2e-secret-token') && !Buffer.from(proof).includes('e2e-secret-token'), 'Authorization value is not in the public proof')

// replay: the same presentation must not unlock another hold (check 6)
const callReplay = await hold(sidOk)
let replayError = ''
try {
  execFileSync(attestBin, ['verify', '--presentation', proofFile, '--ca', ca, '--call-id', callReplay, '--predicate', predicatePath, '--rpc', rpc, '--escrow', escrow], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VERIFIER_PRIVATE_KEY: '0x' + '0b'.repeat(32) },
  })
} catch (e) {
  replayError = String((e as { stderr?: string }).stderr ?? e)
}
check(/Call check failed/.test(replayError), `old proof for a new hold is refused (${replayError.match(/\w+ check failed[^\n]*/)?.[0] ?? 'no error!'})`)

// ------------------------------------------------------------------ FAILED
console.log('\nFAILED (vendor answers an authenticated 500)')
const call500 = await hold(sid500)
const bad = await post('/v1/attest', attestBody(call500, ports.e500))
check(bad.status === 200 && bad.json.verdict?.outcome === 'FAILED', `attestor verdict FAILED (${(bad.json.verdict?.failures ?? []).join('; ')})`)
const r500 = await settle(call500, bad.json.verdict)
const [refunded] = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Refunded', logs: r500.logs })
check(!!refunded && refunded.args.presentationHash === bad.json.presentationHash && isAddressEqual(refunded.args.agent, agent.address), 'Refunded to the agent with the presentationHash')

// ------------------------------------------------------------------ NO TRANSCRIPT → timeout
console.log('\nNO PROOF (vendor never answers)')
const callHang = await hold(sidHang)
const hang = await post('/v1/attest', attestBody(callHang, ports.hang))
check(hang.status === 502 && hang.json.error === 'no-transcript' && !hang.json.verdict, `attestor refuses to sign without a transcript (HTTP ${hang.status})`)
await pub.request({ method: 'evm_increaseTime' as never, params: [WINDOW + 1] as never })
await pub.request({ method: 'evm_mine' as never, params: [] as never })
for (const callId of [callHang, callReplay]) {
  const r = await send(relayer, { address: escrow, abi: fermataEscrowAbi, functionName: 'claimTimeout', args: [callId] })
  const [ev] = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Refunded', logs: r.logs })
  check(ev?.args.presentationHash === zeroHash, `claimTimeout ${callId.slice(0, 10)}… refunds the agent (presentationHash 0)`)
}

if (failures.length) {
  console.error(`\nATTEST E2E FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nATTEST E2E OK: DELIVERED released, FAILED refunded, no transcript → no verdict → timeout refund')
