import { describe, expect, it } from 'vitest'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { aggregateScores, fetchEscrowLogs, serviceLabelOf, wilsonLower, type EscrowLog } from '../src/scores.ts'
import { serviceId } from '../src/serviceId.ts'

const owner = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const A = serviceId(owner, 'quote-ok')
const B = serviceId(owner, 'quote-500')
const agents = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000a2'] as Address[]
const ZERO = `0x${'00'.repeat(32)}` as Hex
const tx = (s: string) => keccak256(toHex(s))
let n = 0
const call = () => tx(`call-${n++}`)

function calls(svc: Hex, outcomes: ('released' | 'failed' | 'timeout' | 'open')[], agent = agents[0]!): EscrowLog[] {
  const logs: EscrowLog[] = []
  for (const o of outcomes) {
    const id = call()
    const b = BigInt(10 + n)
    logs.push({ eventName: 'Held', blockNumber: b, transactionHash: tx(`h${id}`), args: { callId: id, serviceId: svc, agent, amount: 10_000n } })
    if (o === 'released') logs.push({ eventName: 'Released', blockNumber: b + 1n, transactionHash: tx(`s${id}`), args: { callId: id, serviceId: svc, amount: 10_000n, fee: 50n, presentationHash: tx(`p${id}`) } })
    if (o === 'failed') logs.push({ eventName: 'Refunded', blockNumber: b + 1n, transactionHash: tx(`s${id}`), args: { callId: id, serviceId: svc, amount: 10_000n, presentationHash: tx(`p${id}`) } })
    if (o === 'timeout') logs.push({ eventName: 'Refunded', blockNumber: b + 1n, transactionHash: tx(`s${id}`), args: { callId: id, serviceId: svc, amount: 10_000n, presentationHash: ZERO } })
  }
  return logs
}

describe('wilsonLower', () => {
  it('matches the textbook values and ranks volume over luck', () => {
    expect(wilsonLower(0, 0)).toBe(0)
    expect(wilsonLower(3, 3)).toBeCloseTo(0.4385, 3)
    expect(wilsonLower(950, 1000)).toBeCloseTo(0.9346, 3)
    expect(wilsonLower(950, 1000)).toBeGreaterThan(wilsonLower(3, 3))
    expect(wilsonLower(5, 10)).toBeCloseTo(0.2366, 3)
  })
})

describe('aggregateScores', () => {
  it('counts releases, proven failures, timeouts, open holds and distinct agents per service', () => {
    const logs: EscrowLog[] = [
      { eventName: 'ServiceRegistered', blockNumber: 1n, transactionHash: tx('r'), args: { serviceId: A, owner, token: owner, payout: agents[1]!, verifier: owner, pricePerCall: 10_000n, settlementWindow: 120 } },
      ...calls(A, ['released', 'released', 'released', 'failed', 'timeout', 'open']),
      ...calls(A, ['released'], agents[1]),
      ...calls(B, ['failed', 'failed']),
    ]
    const [a, b] = aggregateScores(logs.reverse()) // any input order
    expect(a!.serviceId).toBe(A)
    expect(a).toMatchObject({ held: 7, released: 4, provenFailures: 1, timeouts: 1, open: 1, settled: 6, distinctAgents: 2, payout: agents[1], verifier: owner, pricePerCall: 10_000n, registeredBlock: 1n })
    // proven outcomes only: 4 released of 5 proven; the timeout is counted but not held against the vendor
    expect(a!.deliveryRate).toBeCloseTo(4 / 5)
    expect(a!.score).toBeCloseTo(wilsonLower(4, 5))
    expect(a!.releasedAmount).toBe(40_000n)
    expect(a!.refundedAmount).toBe(20_000n)
    expect(b).toMatchObject({ held: 2, released: 0, provenFailures: 2, deliveryRate: 0, score: 0 })
  })

  it('timeouts alone (e.g. a stranger holding calls and never presenting them) do not sink a vendor', () => {
    const [s] = aggregateScores([...calls(A, ['released', 'released']), ...calls(A, Array(10).fill('timeout'))])
    expect(s).toMatchObject({ released: 2, timeouts: 10, deliveryRate: 1 })
    expect(s!.score).toBeCloseTo(wilsonLower(2, 2))
  })

  it('ignores a settlement seen twice (overlapping scans)', () => {
    const logs = calls(A, ['released'])
    const [s] = aggregateScores([...logs, logs[1]!])
    expect(s).toMatchObject({ released: 1, settled: 1, open: 0 })
  })

  it('a service with no settled calls has no rate and scores 0', () => {
    const [s] = aggregateScores(calls(A, ['open']))
    expect(s).toMatchObject({ deliveryRate: null, score: 0, open: 1 })
  })
})

describe('fetchEscrowLogs', () => {
  it('reads in chunks and halves the chunk when the RPC refuses a range', async () => {
    const ranges: [bigint, bigint][] = []
    const client = {
      getBlockNumber: async () => 999n,
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        if (toBlock - fromBlock + 1n > 250n) throw new Error('range too large')
        ranges.push([fromBlock, toBlock])
        return fromBlock === 0n ? [{ eventName: 'Held', blockNumber: 5n, transactionHash: tx('x'), args: { callId: tx('c'), serviceId: A, agent: agents[0], amount: 1n } }, { eventName: 'FeeBpsUpdated', blockNumber: 6n, transactionHash: tx('y'), args: {} }] : []
      },
    }
    const { logs, toBlock } = await fetchEscrowLogs(client as never, owner, 0n, { chunk: 1000n })
    expect(toBlock).toBe(999n)
    expect(logs).toHaveLength(1) // non-scoring events are dropped
    expect(ranges[0]).toEqual([0n, 249n])
    expect(ranges.at(-1)![1]).toBe(999n)
  })
})

describe('serviceLabelOf', () => {
  it('reads the printable label', () => {
    expect(serviceLabelOf(A)).toBe('quote-ok')
    expect(serviceLabelOf(`0x${'11'.repeat(20)}${'00'.repeat(12)}` as Hex)).toBeUndefined()
  })
})
