// pnpm demo:cases [--chain anvil|moderato] — the definition of done: the three canonical cases end to
// end through the running demo stack, a pass/fail table with explorer links, exit 0 only if all pass.
//   1 release                  vendor answers → proof passes → vendor paid (price − fee), treasury fee
//   2 verified-failure refund  vendor answers an authenticated 500 → proof fails → agent refunded
//   3 timeout refund           vendor never answers → no verdict → after the window, refunded
import { keccak256, parseEventLogs, zeroHash, type Hex } from 'viem'
import { fermataEscrowAbi } from '@fermata/sdk'
import { client, fundedAgent, gw, link, receiptOf, short, sleep, stack, table } from './lib.ts'

type Result = { case: string; pass: boolean; outcome: string; callId: string; txs: string[]; notes: string[] }
const results: Result[] = []
const agent = await fundedAgent(100_000n)
console.log(`demo:cases on ${stack.chain} — gateway ${stack.gateway}, escrow ${stack.escrow}, agent ${agent.account.address}\n`)

async function run(name: string, fn: (r: Result) => Promise<void>) {
  const r: Result = { case: name, pass: true, outcome: '-', callId: '-', txs: [], notes: [] }
  const check = (ok: boolean, note: string) => {
    if (!ok) r.pass = false
    r.notes.push(`${ok ? '✓' : '✗'} ${note}`)
  }
  ;(r as Result & { check: typeof check }).check = check
  try {
    await fn(r)
  } catch (e) {
    r.pass = false
    r.notes.push(`✗ ${(e as Error).message}`)
  }
  results.push(r)
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${name}\n${r.notes.map((n) => `      ${n}`).join('\n')}\n`)
}
const check = (r: Result, ok: boolean, note: string) => (r as Result & { check: (o: boolean, n: string) => void }).check(ok, note)

async function reconciled(r: Result, callId: Hex, expected: bigint[]) {
  // A load-balanced RPC (Moderato) can answer from a node a block behind the settle tx: retry briefly.
  const ok = (x: { match: boolean; movements: { amount: string }[] }) => x.match && x.movements.map((m) => BigInt(m.amount)).join() === expected.join()
  let rec = await gw<{ match: boolean; movements: { amount: string }[] }>(`/reconcile/${callId}`)
  for (let i = 0; i < 10 && !ok(rec); i++) {
    await sleep(1_500)
    rec = await gw(`/reconcile/${callId}`)
  }
  check(r, rec.match && rec.movements.map((m) => BigInt(m.amount)).join() === expected.join(), `reconciled by memo: ${rec.movements.map((m) => m.amount).join(' → ')}`)
}

await run('1 release (vendor delivers)', async (r) => {
  const res = await agent.pay(stack.services.ok)
  const rc = receiptOf(res)
  r.callId = rc.callId; r.outcome = rc.outcome
  const body = (await res.json()) as { price?: number }
  check(r, res.status === 200 && typeof body.price === 'number', `agent got the proved quote (HTTP ${res.status}, price ${body.price})`)
  check(r, rc.outcome === 'DELIVERED', `verdict ${rc.outcome}`)
  const settle = await client.waitForTransactionReceipt({ hash: rc.txHash })
  const [released] = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Released', logs: settle.logs })
  check(r, !!released && released.args.amount - released.args.fee === 9_950n && released.args.fee === 50n, 'Released: vendor 9,950, treasury 50 (0.5 %)')
  const proof = new Uint8Array(await (await fetch(`${stack.gateway}/proofs/${rc.callId}`)).arrayBuffer())
  check(r, keccak256(proof) === released?.args.presentationHash, 'downloaded proof hashes to the on-chain presentationHash')
  const rv = await gw<{ ok: boolean }>(`/proofs/${rc.callId}/verify`, { method: 'POST' })
  check(r, rv.ok, 'offline re-verification matches every on-chain hash')
  await reconciled(r, rc.callId, [10_000n, 9_950n, 50n])
  r.txs = [rc.holdTx, rc.txHash]
})

await run('2 verified-failure refund (authenticated 500)', async (r) => {
  const res = await agent.pay(stack.services.e500)
  const rc = receiptOf(res)
  r.callId = rc.callId; r.outcome = rc.outcome
  check(r, res.status === 500 && rc.outcome === 'FAILED', `vendor's proved 500 returned, verdict ${rc.outcome}`)
  const settle = await client.waitForTransactionReceipt({ hash: rc.txHash })
  const [refunded] = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Refunded', logs: settle.logs })
  check(r, !!refunded && refunded.args.amount === 10_000n && refunded.args.presentationHash !== zeroHash, 'Refunded in full, backed by a presentation')
  await reconciled(r, rc.callId, [10_000n, 10_000n])
  r.txs = [rc.holdTx, rc.txHash]
})

await run('3 timeout refund (vendor never answers)', async (r) => {
  const res = await agent.pay(stack.services.hang)
  const rc = receiptOf(res)
  r.callId = rc.callId; r.outcome = 'TIMEOUT'
  check(r, res.status === 504 && rc.outcome === 'AWAITING_TIMEOUT', `no transcript → no verdict (HTTP ${res.status})`)
  let call = await gw<{ status: string; deadline: string; timeoutTx?: Hex }>(`/calls/${rc.callId}`)
  // Wait out the window in real time. On Anvil, mine a block every 2 s (at wall-clock time) so chain
  // time moves; warping it ahead instead would put later TLS sessions "before" their holds, and the
  // attestor's session-time check would fail every call on this stack from then on.
  process.stdout.write('      waiting for the settlement window')
  for (let i = 0; i < 120 && call.status !== 'timed-out'; i++) {
    await sleep(2_000)
    if (stack.chain === 'anvil') await client.request({ method: 'evm_mine' as never, params: [] as never })
    process.stdout.write('.')
    call = await gw(`/calls/${rc.callId}`)
  }
  process.stdout.write('\n')
  check(r, call.status === 'timed-out', `gateway sweeper sent claimTimeout (${call.status})`)
  if (call.timeoutTx) {
    const logs = (await client.waitForTransactionReceipt({ hash: call.timeoutTx })).logs
    const [refunded] = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Refunded', logs })
    check(r, refunded?.args.presentationHash === zeroHash, 'Refunded with presentationHash 0 (timeout)')
  }
  await reconciled(r, rc.callId, [10_000n, 10_000n])
  r.txs = [rc.holdTx, call.timeoutTx ?? '']
})

console.log(table(['case', 'result', 'outcome', 'callId', 'hold tx', 'settle / refund tx'], results.map((r) => [r.case, r.pass ? 'PASS' : 'FAIL', r.outcome, r.callId === '-' ? '-' : short(r.callId), link(r.txs[0]), link(r.txs[1])])))
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} cases passed on ${stack.chain}`)
process.exit(passed === results.length ? 0 : 1)
