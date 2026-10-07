// pnpm demo:agent --calls N [--service quote|ok|e500|hang] [--chain anvil|moderato]
// pnpm demo:load  --calls 100                     (= demo:agent --service quote --load)
//
// A fresh agent buys N quotes through the gateway with the `fermata` method (mppx/client), one after
// the other, and prints the brief's table (callId, outcome, txHash) and totals: held / released /
// refunded / fee paid / wall-clock. With --load it also collects, from the gateway's call records and
// the chain: prove time, MPC bandwidth per call and gas per call, and writes out/demo/load-<chain>.json.
import { mkdirSync, writeFileSync } from 'node:fs'
import { parseEventLogs, type Hex } from 'viem'
import { feesPaid, fermataEscrowAbi, tip20Abi } from 'fermata-sdk'
import { args, client, fundedAgent, gw, link, receiptOf, short, stack, table, TOKEN } from './lib.ts'

const calls = Number(args.calls ?? 10)
const serviceKey = (typeof args.service === 'string' ? args.service : 'quote') as keyof typeof stack.services
const service = stack.services[serviceKey]
if (!service) throw new Error(`--service must be one of ${Object.keys(stack.services).join(', ')}`)
const load = args.load === true
const symbols = ['BTC-USD', 'ETH-USD', 'SOL-USD']
const PRICE = 10_000n

const funding = BigInt(calls) * 60_000n + 100_000n
const agent = await fundedAgent(funding)
console.log(`demo:agent on ${stack.chain}: ${calls} call(s) to ${serviceKey} (${short(service)}), agent ${agent.account.address}\n`)

type Row = { n: number; callId: Hex; status: number; outcome: string; holdTx?: Hex; settleTx?: Hex | null; ms: number; body: string }
const rows: Row[] = []
const t0 = Date.now()
for (let i = 1; i <= calls; i++) {
  const start = Date.now()
  let row: Row
  try {
    const res = await agent.pay(service, `/v1/quote?symbol=${symbols[i % symbols.length]}`)
    const rc = receiptOf(res)
    const text = await res.text()
    row = { n: i, callId: rc.callId, status: res.status, outcome: rc.outcome ?? '?', holdTx: rc.holdTx, settleTx: rc.txHash, ms: Date.now() - start, body: text.slice(0, 60) }
  } catch (e) {
    row = { n: i, callId: '0x' as Hex, status: 0, outcome: `ERROR ${(e as Error).message.slice(0, 60)}`, ms: Date.now() - start, body: '' }
  }
  rows.push(row)
  console.log(`${String(i).padStart(3)}  ${row.outcome.padEnd(16)} ${row.callId.length > 2 ? short(row.callId) : '-'}  HTTP ${row.status}  ${String(row.ms).padStart(6)} ms  ${link(row.settleTx)}`)
}
const wall = Date.now() - t0

// ------------------------------------------------------------------ totals from the chain
let escrowFee = 0n
let gasFees = 0n
let holdGas: bigint[] = []
let settleGas: bigint[] = []
for (const r of rows) {
  if (r.holdTx) {
    const hr = await client.getTransactionReceipt({ hash: r.holdTx })
    holdGas.push(hr.gasUsed)
    gasFees += feesPaid(hr).reduce((s, f) => s + f.amount, 0n)
  }
  if (r.settleTx) {
    const sr = await client.getTransactionReceipt({ hash: r.settleTx })
    settleGas.push(sr.gasUsed)
    for (const ev of parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Released', logs: sr.logs })) escrowFee += ev.args.fee
  }
}
const count = (o: string) => rows.filter((r) => r.outcome === o).length
const released = count('DELIVERED')
const refunded = count('FAILED')
const awaiting = count('AWAITING_TIMEOUT')
const balance = await client.readContract({ address: TOKEN, abi: tip20Abi, functionName: 'balanceOf', args: [agent.account.address] })
const usd = (u: bigint) => `${(Number(u) / 1e6).toFixed(6)} USD`
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]! : 0)
const lat = rows.map((r) => r.ms)

console.log(`\n${table(['#', 'callId', 'outcome', 'HTTP', 'ms', 'settle tx'], rows.map((r) => [r.n, r.callId.length > 2 ? r.callId : '-', r.outcome, r.status, r.ms, link(r.settleTx)]))}`)
console.log(`\ntotals (${stack.chain})`)
console.log(table(['held', 'released', 'refunded', 'awaiting timeout', 'escrow fee paid', 'gas paid by agent', 'agent spent', 'wall-clock', 'per call p50 / p90'], [[
  rows.filter((r) => r.holdTx).length, released, refunded, awaiting, usd(escrowFee), usd(gasFees), usd(funding - balance),
  `${(wall / 1000).toFixed(1)} s`, `${pct(lat, 50)} / ${pct(lat, 90)} ms`,
]]))
if (awaiting > 0) console.log(`(${awaiting} call(s) had no transcript; the gateway sweeper refunds them after the window)`)

if (load) {
  const records = await Promise.all(rows.filter((r) => r.callId.length > 2).map((r) => gw<Record<string, any>>(`/calls/${r.callId}`)))
  const prove = records.map((r) => Number(r.proveMs)).filter((x) => x > 0)
  const mpc = records.map((r) => (r.notaryBytes ? Number(r.notaryBytes.sent) + Number(r.notaryBytes.received) : 0)).filter((x) => x > 0)
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const summary = {
    chain: stack.chain,
    calls,
    service: serviceKey,
    outcomes: { delivered: released, failed: refunded, awaitingTimeout: awaiting, errors: rows.filter((r) => r.outcome.startsWith('ERROR')).length },
    wallClockSeconds: wall / 1000,
    perCallMs: { p50: pct(lat, 50), p90: pct(lat, 90), max: Math.max(...lat) },
    proveMs: { p50: pct(prove, 50), p90: pct(prove, 90), max: Math.max(0, ...prove), mean: Math.round(mean(prove)) },
    mpcBytesPerCall: { mean: Math.round(mean(mpc)), total: mpc.reduce((a, b) => a + b, 0) },
    gasPerCall: { holdMean: Number(holdGas.reduce((a, b) => a + b, 0n) / BigInt(Math.max(1, holdGas.length))), settleMean: Number(settleGas.reduce((a, b) => a + b, 0n) / BigInt(Math.max(1, settleGas.length))) },
    feesUsd: { escrowFee: Number(escrowFee) / 1e6, gasPaidByAgent: Number(gasFees) / 1e6 },
    finishedAt: new Date().toISOString(),
  }
  console.log(`\nload statistics\n${JSON.stringify(summary, null, 2)}`)
  mkdirSync(new URL('../../out/demo/', import.meta.url), { recursive: true })
  writeFileSync(new URL(`../../out/demo/load-${stack.chain}.json`, import.meta.url), `${JSON.stringify({ summary, rows }, null, 2)}\n`)
}
process.exit(rows.some((r) => r.outcome.startsWith('ERROR')) ? 1 : 0)
