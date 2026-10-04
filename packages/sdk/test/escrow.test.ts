import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { reconcile } from '../src/escrow.ts'

const token = '0x20C0000000000000000000000000000000000000' as Address
const callId = `0x${'ca'.repeat(32)}` as Hex
const addr = (n: number) => `0x${String(n).padStart(40, '0')}` as Address
const tx = (n: number) => `0x${String(n).padStart(64, '0')}` as Hex

describe('reconcile', () => {
  it('scans past the RPC getLogs range cap and returns the movements in chain order', async () => {
    const ranges: [bigint, bigint][] = []
    const client = {
      getBlockNumber: async () => 249_999n,
      getContractEvents: async ({ fromBlock, toBlock, args }: { fromBlock: bigint; toBlock: bigint; args: { memo: Hex } }) => {
        if (toBlock - fromBlock + 1n > 100_000n) throw new Error('query exceeds max block range 100000') // Moderato
        expect(args.memo).toBe(callId)
        ranges.push([fromBlock, toBlock])
        return [
          { address: token, args: { from: addr(2), to: addr(9), amount: 9_950n }, transactionHash: tx(2), blockNumber: 200_001n, logIndex: 1 },
          { address: token, args: { from: addr(1), to: addr(2), amount: 10_000n }, transactionHash: tx(1), blockNumber: 10n, logIndex: 0 },
          { address: token, args: { from: addr(2), to: addr(8), amount: 50n }, transactionHash: tx(2), blockNumber: 200_001n, logIndex: 0 },
        ].filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
      },
    }
    const moves = await reconcile(client as never, { token, callId })
    expect(ranges[0]![0]).toBe(0n)
    expect(ranges.at(-1)![1]).toBe(249_999n)
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBe(ranges[i - 1]![1] + 1n)
    expect(moves.map((m) => m.amount)).toEqual([10_000n, 50n, 9_950n])
    expect(moves[0]).toMatchObject({ from: addr(1), to: addr(2), txHash: tx(1), blockNumber: 10n })
  })
})
