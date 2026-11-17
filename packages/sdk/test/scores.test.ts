import { describe, expect, it } from 'vitest'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { aggregateScores, failureClass, fetchEscrowLogs, provenStatus, serviceLabelOf, wilsonLower, type EscrowLog } from '../src/scores.ts'
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

  it('client errors (proven 4xx) are reported, not ranked: a griefer\'s bad requests do not sink a vendor', () => {
    const good = calls(A, Array(20).fill('released'))
    const before = aggregateScores(good)[0]!
    const grief = calls(A, Array(10).fill('failed'), agents[1])
    const griefIds = new Set(grief.filter((l) => l.eventName === 'Refunded').map((l) => l.args.callId))
    const classify = (id: Hex) => (griefIds.has(id) ? ('client' as const) : undefined)
    const after = aggregateScores([...good, ...grief], classify)[0]!
    expect(after).toMatchObject({ provenFailures: 10, clientErrors: 10, vendorFailures: 0, unclassified: 0, deliveryRate: 1 })
    expect(after.score).toBe(before.score)
    // Without classification the same failures count, as before.
    expect(aggregateScores([...good, ...grief])[0]).toMatchObject({ unclassified: 10, deliveryRate: 20 / 30 })
  })

  it('a vendor failure (5xx, broken answer) still lowers the score', () => {
    const logs = [...calls(A, Array(20).fill('released')), ...calls(A, ['failed'])]
    const failed = logs.filter((l) => l.eventName === 'Refunded').map((l) => l.args.callId)
    const s = aggregateScores(logs, (id) => (failed.includes(id) ? 'vendor' : undefined))[0]!
    expect(s).toMatchObject({ vendorFailures: 1, clientErrors: 0, deliveryRate: 20 / 21 })
  })

  it('failureClass: 4xx is the client\'s, anything else (5xx, 200 with a wrong body) the vendor\'s', () => {
    expect([404, 400, 429, 500, 200, 302].map(failureClass)).toEqual(['client', 'client', 'client', 'vendor', 'vendor', 'vendor'])
    expect(failureClass(null)).toBeUndefined()
    expect(provenStatus('HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\n\r\nno')).toBe(404)
    expect(provenStatus('garbage')).toBeNull()
  })

  it('a hold seen twice (overlapping scans) counts once', () => {
    const logs = calls(A, ['open'])
    expect(aggregateScores([...logs, ...logs])[0]).toMatchObject({ held: 1, open: 1 })
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
