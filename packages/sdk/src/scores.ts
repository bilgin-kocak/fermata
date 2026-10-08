// Vendor delivery scores, computed from the escrow's own events and nothing else, so anyone can
// recompute them from an RPC: ServiceRegistered, Held, Released, Refunded.
//
// A Refunded event with presentationHash ≠ 0 is a *proven* failure (a verdict backed by a TLSNotary
// presentation); presentationHash = 0 is a timeout refund (no proof arrived inside the window).
// The delivery rate counts proven outcomes only (released vs proven failures): a timeout proves
// nothing about the vendor, since anyone can hold a call and never present it. Ranking uses the
// Wilson score lower bound (95 %) of that rate, so a vendor with 3/3 does not outrank one with
// 950/1000. A ranking should only include services whose verifier it trusts (ServiceRegistered
// carries it): a service that names itself as verifier can sign "deliveries" with no proof.
//
// Limits (shown wherever scores are shown): only calls paid through Fermata count, and a vendor can
// pay itself to inflate its score; distinct agents are reported for that reason.
import { type Address, type Hex, type PublicClient } from 'viem'
import type { AnyPublicClient } from './clients.ts'
import { fermataEscrowAbi } from './abi.ts'
import { scanBlocks } from './logs.ts'

const ZERO32 = `0x${'00'.repeat(32)}`

export type EscrowLog =
  | { eventName: 'ServiceRegistered'; blockNumber: bigint; transactionHash: Hex; args: { serviceId: Hex; owner: Address; token: Address; payout: Address; verifier: Address; pricePerCall: bigint; settlementWindow: number } }
  | { eventName: 'Held'; blockNumber: bigint; transactionHash: Hex; args: { callId: Hex; serviceId: Hex; agent: Address; amount: bigint } }
  | { eventName: 'Released'; blockNumber: bigint; transactionHash: Hex; args: { callId: Hex; serviceId: Hex; amount: bigint; fee: bigint; presentationHash: Hex } }
  | { eventName: 'Refunded'; blockNumber: bigint; transactionHash: Hex; args: { callId: Hex; serviceId: Hex; amount: bigint; presentationHash: Hex } }

export type ServiceScore = {
  serviceId: Hex
  /** From ServiceRegistered (absent if registration predates the scanned range). */
  owner?: Address
  payout?: Address
  /** Who signs this service's verdicts. A ranking should only trust verifiers it knows. */
  verifier?: Address
  pricePerCall?: bigint
  registeredBlock?: bigint
  held: number
  released: number
  /** Refunded with a presentation: the vendor's own answer failed the delivery check. */
  provenFailures: number
  /** Refunded by claimTimeout: no proof inside the settlement window. */
  timeouts: number
  /** Held, not yet settled. */
  open: number
  settled: number
  /**
   * released / (released + provenFailures): the share of PROVEN outcomes that were deliveries, or null
   * before the first one. Timeouts are shown but not counted: anyone can hold a call directly and
   * never present it, so a timeout says nothing provable about the vendor.
   */
  deliveryRate: number | null
  /** Wilson 95 % lower bound of the delivery rate (0 with no proven outcome): the ranking key. */
  score: number
  distinctAgents: number
  releasedAmount: bigint
  refundedAmount: bigint
  firstCallBlock?: bigint
  lastCallBlock?: bigint
}

/** Wilson score interval lower bound for `successes` out of `n` (z = 1.96 → 95 %). */
export function wilsonLower(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0
  const p = successes / n
  const z2 = z * z
  const centre = p + z2 / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return Math.max(0, (centre - margin) / (1 + z2 / n))
}

/** Aggregates escrow logs (any order) into one score per service, best first. */
export function aggregateScores(logs: readonly EscrowLog[]): ServiceScore[] {
  const sorted = [...logs].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0))
  const by = new Map<string, ServiceScore & { agents: Set<string>; settledCalls: Set<string> }>()
  const get = (serviceId: Hex) => {
    const key = serviceId.toLowerCase()
    let s = by.get(key)
    if (!s) {
      s = { serviceId, held: 0, released: 0, provenFailures: 0, timeouts: 0, open: 0, settled: 0, deliveryRate: null, score: 0, distinctAgents: 0, releasedAmount: 0n, refundedAmount: 0n, agents: new Set(), settledCalls: new Set() }
      by.set(key, s)
    }
    return s
  }
  for (const log of sorted) {
    const s = get(log.args.serviceId)
    switch (log.eventName) {
      case 'ServiceRegistered':
        Object.assign(s, { owner: log.args.owner, payout: log.args.payout, verifier: log.args.verifier, pricePerCall: log.args.pricePerCall, registeredBlock: log.blockNumber })
        break
      case 'Held':
        s.held++
        s.agents.add(log.args.agent.toLowerCase())
        s.firstCallBlock ??= log.blockNumber
        s.lastCallBlock = log.blockNumber
        break
      case 'Released':
      case 'Refunded': {
        const call = log.args.callId.toLowerCase()
        if (s.settledCalls.has(call)) break // a call settles once; ignore duplicates from overlapping scans
        s.settledCalls.add(call)
        if (log.eventName === 'Released') {
          s.released++
          s.releasedAmount += log.args.amount
        } else {
          if (log.args.presentationHash.toLowerCase() === ZERO32) s.timeouts++
          else s.provenFailures++
          s.refundedAmount += log.args.amount
        }
        break
      }
    }
  }
  const out: ServiceScore[] = []
  for (const { agents, settledCalls, ...s } of by.values()) {
    s.settled = s.released + s.provenFailures + s.timeouts
    s.open = Math.max(0, s.held - s.settled)
    const proven = s.released + s.provenFailures
    s.deliveryRate = proven ? s.released / proven : null
    s.score = wilsonLower(s.released, proven)
    s.distinctAgents = agents.size
    out.push(s)
  }
  return out.sort((a, b) => b.score - a.score || b.settled - a.settled)
}

/**
 * Reads the escrow's scoring events in chunks (some RPCs cap the getLogs range), halving the chunk
 * on an error. Returns the logs and the last block scanned.
 */
export async function fetchEscrowLogs(
  anyClient: AnyPublicClient,
  escrow: Address,
  fromBlock: bigint,
  opts: { toBlock?: bigint; chunk?: bigint } = {},
): Promise<{ logs: EscrowLog[]; toBlock: bigint }> {
  const client = anyClient as PublicClient
  const toBlock = opts.toBlock ?? (await client.getBlockNumber())
  const logs: EscrowLog[] = []
  await scanBlocks(fromBlock, toBlock, async (from, to) => {
    const batch = await client.getContractEvents({ address: escrow, abi: fermataEscrowAbi, fromBlock: from, toBlock: to })
    for (const l of batch) {
      if (['ServiceRegistered', 'Held', 'Released', 'Refunded'].includes(l.eventName)) {
        logs.push({ eventName: l.eventName, blockNumber: l.blockNumber, transactionHash: l.transactionHash, args: l.args } as EscrowLog)
      }
    }
  }, opts.chunk)
  return { logs, toBlock }
}

/** The label packed into a serviceId, when printable (owner ‖ 12-byte label). */
export function serviceLabelOf(serviceId: Hex): string | undefined {
  const hex = serviceId.slice(42).replace(/(00)+$/, '')
  if (!hex) return undefined
  const text = (hex.match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join('')
  return /^[\x20-\x7e]+$/.test(text) ? text : undefined
}
