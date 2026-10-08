import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from 'viem'
import { fermataEscrowAbi } from './abi.ts'
import type { AnyPublicClient, AnyWalletClient } from './clients.ts'
import { scanBlocks } from './logs.ts'
import { tip20Abi, type Movement } from './tip20.ts'

/** `FermataEscrow.Status`. Anything but None is final except Held. */
export const HoldStatus = { None: 0, Held: 1, Released: 2, Refunded: 3, TimedOut: 4 } as const
export type HoldStatus = (typeof HoldStatus)[keyof typeof HoldStatus]

export function getHold(client: AnyPublicClient, escrow: Address, callId: Hex) {
  return (client as PublicClient).readContract({ address: escrow, abi: fermataEscrowAbi, functionName: 'getHold', args: [callId] })
}

export function getService(client: AnyPublicClient, escrow: Address, serviceId: Hex) {
  return (client as PublicClient).readContract({ address: escrow, abi: fermataEscrowAbi, functionName: 'getService', args: [serviceId] })
}

/**
 * What an accountant sees for one call without any Fermata indexer: every TIP-20 movement whose
 * `TransferWithMemo` memo is `callId`, in chain order (hold, then release/refund). Scans
 * [fromBlock, toBlock] in chunks, so pass the hold's block as `fromBlock` (and the settlement's
 * block as `toBlock` when known) to keep it to one query.
 *
 * Anyone can send a transfer carrying any memo, so a caller checking an outcome should only count
 * the legs into and out of the escrow.
 */
export async function reconcile(
  anyClient: AnyPublicClient,
  opts: { token: Address; callId: Hex; fromBlock?: bigint; toBlock?: bigint },
): Promise<(Movement & { txHash: Hex; blockNumber: bigint })[]> {
  const client = anyClient as PublicClient
  const head = await client.getBlockNumber()
  const toBlock = opts.toBlock !== undefined && opts.toBlock < head ? opts.toBlock : head // never past the head
  const found: (Movement & { txHash: Hex; blockNumber: bigint; logIndex: number })[] = []
  await scanBlocks(opts.fromBlock ?? 0n, toBlock, async (fromBlock, to) => {
    const logs = await client.getContractEvents({ address: opts.token, abi: tip20Abi, eventName: 'TransferWithMemo', args: { memo: opts.callId }, fromBlock, toBlock: to })
    for (const l of logs) {
      found.push({ token: l.address, from: l.args.from!, to: l.args.to!, amount: l.args.amount!, txHash: l.transactionHash, blockNumber: l.blockNumber, logIndex: l.logIndex })
    }
  })
  return found
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
    .map(({ logIndex: _, ...m }) => m)
}

/**
 * Agent-side timeout refund: `claimTimeout(callId)` once the settlement window has passed. Anyone
 * may send it; the money always goes to the agent, so an agent never depends on the gateway.
 */
export async function reclaim(
  anyWallet: AnyWalletClient,
  anyClient: AnyPublicClient,
  escrow: Address,
  callId: Hex,
) {
  const wallet = anyWallet as WalletClient<Transport, Chain, Account>
  const client = anyClient as PublicClient
  const hold = await getHold(client, escrow, callId)
  if (hold.status !== HoldStatus.Held) throw new Error(`call ${callId} is not held (status ${hold.status})`)
  const now = (await client.getBlock()).timestamp
  if (now <= hold.deadline) throw new Error(`settlement window open until ${hold.deadline} (chain time ${now})`)
  const hash = await wallet.writeContract({ address: escrow, abi: fermataEscrowAbi, functionName: 'claimTimeout', args: [callId] })
  return client.waitForTransactionReceipt({ hash })
}
