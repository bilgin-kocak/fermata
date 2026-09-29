// One real round trip per outcome against the deployed FermataEscrow:
//   DELIVERED  hold → settle(DELIVERED verdict) → vendor gets price − fee, treasury gets the fee
//   FAILED     hold → settle(FAILED verdict)    → agent refunded in full
//   TIMEOUT    hold → claimTimeout reverts inside the window → window passes → claimTimeout refunds
// Each run registers a fresh service (window 30 s) and funds a fresh agent. Every token movement is
// then reconciled from TransferWithMemo logs by callId alone.
//
//   pnpm escrow:roundtrip --chain anvil|moderato [--rpc URL]
//
// Roles. moderato: keys from .env — DEPLOYER funds the fresh agent, VENDOR registers the service and
// is paid, RELAYER submits settle/claimTimeout, VERIFIER signs verdicts (no funds needed).
// anvil: anvil dev accounts (0 funds, 2 vendor, 4 relayer) and a fresh verifier key.
//
// Milestone 1 scope: verdicts are signed by the script's verifier key over placeholder presentation
// and response hashes; the TLSNotary proof path (Milestone 2) produces real ones.
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  sha256,
  toHex,
  zeroHash,
  type Address,
  type Hex,
  type LocalAccount,
  type TransactionReceipt,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  escrowDeployment,
  explorerTx,
  fermataEscrowAbi,
  Outcome,
  requestHash,
  serviceId,
  signVerdict,
  TOKENS,
  type Verdict,
} from '@fermata/sdk'
import { chainArg, loadDotEnv, parseArgs, rpcFor } from './lib/args.ts'
import { feesPaid, memoMovements, signPermit, tempoChain, tip20Abi, toJson, type Movement } from './lib/tempo.ts'

loadDotEnv()
const args = parseArgs()
const chainName = chainArg(args)
const rpc = rpcFor(chainName, args)
const onAnvil = chainName === 'anvil'
const chain = tempoChain(rpc)
const pub = createPublicClient({ chain, transport: http(rpc) })
const wallet = (account: LocalAccount) => createWalletClient({ account, chain, transport: http(rpc) })

const PRICE = 10_000n // 0.01 pathUSD
const WINDOW = 30 // seconds
const AGENT_FUNDS = 250_000n // 3 holds + fees for 3 hold transactions, with room to spare
const TOKEN = TOKENS.pathUSD as Address
const PREDICATE =
  '{"version":1,"status":[200],"maxBodyBytes":4096,"contentType":"application/json","jsonSchema":{"type":"object","required":["price","timestamp"],"properties":{"price":{"type":"number"},"timestamp":{"type":"number"}}}}'
const ANVIL_KEYS = {
  funder: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  vendor: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  relayer: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const

function key(name: string): Hex {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set: run 'pnpm keys:init' and fund the printed addresses`)
  return value as Hex
}
const funder = privateKeyToAccount(onAnvil ? ANVIL_KEYS.funder : key('DEPLOYER_PRIVATE_KEY'))
const vendor = privateKeyToAccount(onAnvil ? ANVIL_KEYS.vendor : key('VENDOR_PRIVATE_KEY'))
const relayer = privateKeyToAccount(onAnvil ? ANVIL_KEYS.relayer : key('RELAYER_PRIVATE_KEY'))
const verifier = privateKeyToAccount(
  (process.env.VERIFIER_PRIVATE_KEY as Hex | undefined) || (onAnvil ? generatePrivateKey() : key('VERIFIER_PRIVATE_KEY')),
)
const agent = privateKeyToAccount(generatePrivateKey())

const deployment = escrowDeployment(chainName)
if (!deployment) throw new Error(`no FermataEscrow deployment for ${chainName}: run 'pnpm escrow:deploy --chain ${chainName}'`)
const escrow = deployment.address

// ------------------------------------------------------------------------------------ helpers

type Row = { case: string; step: string; from: Address; tx: Hex; block: bigint; gasUsed: bigint; fees: Movement[] }
const rows: Row[] = []
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
}
const eq = (a: Address, b: Address) => isAddressEqual(a, b)
const units = (n: bigint) => `${n} (${(Number(n) / 1e6).toFixed(6)} USD)`

async function send(caseName: string, step: string, account: LocalAccount, request: object): Promise<TransactionReceipt> {
  const hash = await wallet(account).writeContract(request as never)
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${caseName}/${step} reverted: ${hash}`)
  const fees = feesPaid(receipt)
  rows.push({ case: caseName, step, from: account.address, tx: hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed, fees })
  const fee = fees.map((f) => `${f.amount} ${tokenName(f.token)}`).join(' + ') || 'none'
  console.log(`  ${step.padEnd(14)} gas ${String(receipt.gasUsed).padStart(9)}  fee ${fee.padEnd(18)} ${onAnvil ? hash : explorerTx(hash)}`)
  return receipt
}

function tokenName(token: Address): string {
  const found = Object.entries(TOKENS).find(([, a]) => eq(a, token))
  return found ? found[0] : token
}

const balance = (who: Address) => pub.readContract({ address: TOKEN, abi: tip20Abi, functionName: 'balanceOf', args: [who] })
const latestTimestamp = async () => (await pub.getBlock({ blockTag: 'latest' })).timestamp

function sameMovements(actual: Movement[], expected: Omit<Movement, 'token'>[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((m, i) => {
      const e = expected[i]!
      return eq(m.token, TOKEN) && eq(m.from, e.from) && eq(m.to, e.to) && m.amount === e.amount
    })
  )
}

async function expectRevert(name: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : undefined
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.signature ?? 'unknown'
    throw err
  }
  throw new Error(`${name}: expected a revert`)
}

async function hold(caseName: string, sid: Hex) {
  const callId = keccak256(randomBytes(32))
  const reqHash = requestHash(sid, 'POST', '/v1/quote', '{"symbol":"BTC-USD"}')
  const deadline = (await latestTimestamp()) + 600n
  const { v, r, s } = await signPermit(pub, TOKEN, agent, escrow, PRICE, deadline)
  const receipt = await send(caseName, 'hold', agent, {
    address: escrow,
    abi: fermataEscrowAbi,
    functionName: 'hold',
    args: [callId, sid, reqHash, deadline, v, r, s],
  })
  const [held] = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Held', logs: receipt.logs })
  check(
    !!held && held.args.callId === callId && eq(held.args.agent, agent.address) && held.args.amount === PRICE,
    `Held(callId, agent, ${PRICE})`,
  )
  check(sameMovements(memoMovements(receipt, callId), [{ from: agent.address, to: escrow, amount: PRICE }]), 'hold: agent → escrow, memo = callId')
  return { callId, reqHash, receipt }
}

async function verdictFor(callId: Hex, sid: Hex, reqHash: Hex, outcome: Outcome) {
  const verdict: Verdict = {
    callId,
    serviceId: sid,
    requestHash: reqHash,
    predicateHash: sha256(toHex(PREDICATE)),
    outcome,
    // Milestone 1 placeholders; Milestone 2 hashes the real presentation and response bytes.
    presentationHash: keccak256(toHex(`m1-roundtrip:presentation:${callId}`)),
    responseHash: keccak256(toHex(`m1-roundtrip:response:${callId}`)),
    issuedAt: await latestTimestamp(),
  }
  return { verdict, signature: await signVerdict(verifier, chain.id, escrow, verdict) }
}

async function statusOf(callId: Hex) {
  const h = await pub.readContract({ address: escrow, abi: fermataEscrowAbi, functionName: 'getHold', args: [callId] })
  return ['None', 'Held', 'Released', 'Refunded', 'TimedOut'][h.status]
}

// ---------------------------------------------------------------------------------------- run

const chainId = await pub.getChainId()
if (chainId !== 42431) throw new Error(`expected chain 42431 at ${rpc}, got ${chainId}`)
const code = await pub.getCode({ address: escrow })
if (!code || code === '0x') throw new Error(`no code at ${escrow} on ${rpc}: redeploy with 'pnpm escrow:deploy --chain ${chainName}'`)
const [treasury, feeBps] = await Promise.all([
  pub.readContract({ address: escrow, abi: fermataEscrowAbi, functionName: 'treasury' }),
  pub.readContract({ address: escrow, abi: fermataEscrowAbi, functionName: 'feeBps' }),
])
const fee = (PRICE * BigInt(feeBps)) / 10_000n
const startBlock = await pub.getBlockNumber()
const escrowBefore = await balance(escrow)
console.log(`FermataEscrow ${escrow} on ${chainName} (fee ${feeBps} bps, treasury ${treasury})`)
console.log(`agent ${agent.address} (fresh), vendor ${vendor.address}, relayer ${relayer.address}, verifier ${verifier.address}`)

console.log('\nsetup')
const sid = serviceId(vendor.address, `rt-${Date.now().toString(36)}`)
await send('setup', 'register', vendor, {
  address: escrow,
  abi: fermataEscrowAbi,
  functionName: 'registerService',
  args: [
    sid,
    vendor.address,
    TOKEN,
    PRICE,
    WINDOW,
    verifier.address,
    sha256(toHex(PREDICATE)),
    keccak256(toHex('m1-roundtrip:origin')),
    keccak256(toHex('m1-roundtrip:notary')),
  ],
})
await send('setup', 'fund agent', funder, { address: TOKEN, abi: tip20Abi, functionName: 'transfer', args: [agent.address, AGENT_FUNDS] })

const cases: { name: string; callId: Hex; expected: Omit<Movement, 'token'>[] }[] = []

// --- DELIVERED
console.log('\nDELIVERED')
{
  const { callId, reqHash } = await hold('DELIVERED', sid)
  const { verdict, signature } = await verdictFor(callId, sid, reqHash, Outcome.Delivered)
  const [payoutBefore, treasuryBefore] = await Promise.all([balance(vendor.address), balance(treasury)])
  const receipt = await send('DELIVERED', 'settle', relayer, {
    address: escrow,
    abi: fermataEscrowAbi,
    functionName: 'settle',
    args: [callId, verdict, signature],
  })
  const [released] = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Released', logs: receipt.logs })
  check(
    !!released && released.args.amount === PRICE && released.args.fee === fee && released.args.presentationHash === verdict.presentationHash,
    `Released(amount ${PRICE}, fee ${fee}, presentationHash)`,
  )
  const expected = [
    { from: escrow, to: vendor.address, amount: PRICE - fee },
    ...(fee > 0n ? [{ from: escrow, to: treasury, amount: fee }] : []),
  ]
  check(sameMovements(memoMovements(receipt, callId), expected), `settle: escrow → vendor ${PRICE - fee}, escrow → treasury ${fee}, memo = callId`)
  const [payoutAfter, treasuryAfter] = await Promise.all([balance(vendor.address), balance(treasury)])
  check(payoutAfter - payoutBefore === PRICE - fee, `vendor balance +${PRICE - fee}`)
  if (!eq(treasury, relayer.address)) check(treasuryAfter - treasuryBefore === fee, `treasury balance +${fee}`)
  check((await statusOf(callId)) === 'Released', 'status Released')
  cases.push({ name: 'DELIVERED', callId, expected: [{ from: agent.address, to: escrow, amount: PRICE }, ...expected] })
}

// --- FAILED
console.log('\nFAILED')
{
  const { callId, reqHash } = await hold('FAILED', sid)
  const { verdict, signature } = await verdictFor(callId, sid, reqHash, Outcome.Failed)
  const agentBefore = await balance(agent.address)
  const receipt = await send('FAILED', 'settle', relayer, {
    address: escrow,
    abi: fermataEscrowAbi,
    functionName: 'settle',
    args: [callId, verdict, signature],
  })
  const [refunded] = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Refunded', logs: receipt.logs })
  check(
    !!refunded && refunded.args.amount === PRICE && refunded.args.presentationHash === verdict.presentationHash,
    'Refunded(amount, presentationHash ≠ 0)',
  )
  const expected = [{ from: escrow, to: agent.address, amount: PRICE }]
  check(sameMovements(memoMovements(receipt, callId), expected), 'settle: escrow → agent (full price, no fee), memo = callId')
  check((await balance(agent.address)) - agentBefore === PRICE, `agent balance +${PRICE}`)
  check((await statusOf(callId)) === 'Refunded', 'status Refunded')
  cases.push({ name: 'FAILED', callId, expected: [{ from: agent.address, to: escrow, amount: PRICE }, ...expected] })
}

// --- TIMEOUT
console.log('\nTIMEOUT')
{
  const { callId } = await hold('TIMEOUT', sid)
  const early = await expectRevert('claimTimeout inside the window', () =>
    pub.simulateContract({ account: relayer, address: escrow, abi: fermataEscrowAbi, functionName: 'claimTimeout', args: [callId] }),
  )
  check(early === 'WindowOpen', `claimTimeout inside the window reverts (${early})`)
  const deadline = await pub.readContract({ address: escrow, abi: fermataEscrowAbi, functionName: 'settlementDeadline', args: [callId] })
  if (onAnvil) {
    await pub.request({ method: 'evm_increaseTime' as never, params: [WINDOW + 1] as never })
    await pub.request({ method: 'evm_mine' as never, params: [] as never })
  } else {
    process.stdout.write(`  waiting for a block after the deadline ${deadline}`)
    while ((await latestTimestamp()) <= deadline) {
      process.stdout.write('.')
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
    process.stdout.write('\n')
  }
  const agentBefore = await balance(agent.address)
  const receipt = await send('TIMEOUT', 'claimTimeout', relayer, {
    address: escrow,
    abi: fermataEscrowAbi,
    functionName: 'claimTimeout',
    args: [callId],
  })
  const [refunded] = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Refunded', logs: receipt.logs })
  check(!!refunded && refunded.args.amount === PRICE && refunded.args.presentationHash === zeroHash, 'Refunded(amount, presentationHash = 0)')
  const expected = [{ from: escrow, to: agent.address, amount: PRICE }]
  check(sameMovements(memoMovements(receipt, callId), expected), 'claimTimeout: escrow → agent, memo = callId')
  check((await balance(agent.address)) - agentBefore === PRICE, `agent balance +${PRICE}`)
  check((await statusOf(callId)) === 'TimedOut', 'status TimedOut')
  cases.push({ name: 'TIMEOUT', callId, expected: [{ from: agent.address, to: escrow, amount: PRICE }, ...expected] })
}

// --- reconciliation: an accountant with nothing but the token's TransferWithMemo logs
console.log('\nreconciliation by memo (TransferWithMemo logs only)')
for (const c of cases) {
  const logs = await pub.getContractEvents({
    address: TOKEN,
    abi: tip20Abi,
    eventName: 'TransferWithMemo',
    args: { memo: c.callId },
    fromBlock: startBlock,
  })
  const found = logs.map((l) => ({ token: l.address, from: l.args.from!, to: l.args.to!, amount: l.args.amount! }))
  check(sameMovements(found, c.expected), `${c.name.padEnd(9)} ${c.callId.slice(0, 10)}…: ${found.map((m) => `${m.amount}`).join(' → ')}`)
}
check((await balance(escrow)) === escrowBefore, 'escrow balance back to its starting value (nothing left held)')

// --- summary
console.log('\ngas and fees')
for (const r of rows) {
  const fees = r.fees.map((f) => `${f.amount} ${tokenName(f.token)}`).join(' + ') || '-'
  console.log(`  ${r.case.padEnd(9)} ${r.step.padEnd(14)} ${String(r.gasUsed).padStart(9)} gas  ${fees}`)
}
const agentFees = rows.filter((r) => eq(r.from, agent.address)).flatMap((r) => r.fees).reduce((sum, f) => sum + f.amount, 0n)
console.log(`  agent: paid ${units(PRICE)} for the delivered call (vendor ${PRICE - fee}, treasury ${fee}), refunded twice,`)
console.log(`         and paid ${units(agentFees)} in transaction fees for its 3 holds`)

mkdirSync(new URL('../out/', import.meta.url), { recursive: true })
const outFile = new URL(`../out/escrow-roundtrip-${chainName}.json`, import.meta.url)
writeFileSync(
  outFile,
  toJson(
    {
      chain: chainName,
      escrow,
      serviceId: sid,
      agent: agent.address,
      price: PRICE,
      feeBps,
      window: WINDOW,
      cases: cases.map((c) => ({ name: c.name, callId: c.callId })),
      transactions: rows.map((r) => ({ ...r, explorer: onAnvil ? undefined : explorerTx(r.tx) })),
      failures,
      finishedAt: new Date().toISOString(),
    },
    2,
  ),
)
console.log(`\nwrote ${outFile.pathname}`)
if (failures.length > 0) {
  console.error(`ROUNDTRIP FAILED: ${failures.length} check(s): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('ROUNDTRIP OK: DELIVERED, FAILED and TIMEOUT settled and reconciled by memo')
