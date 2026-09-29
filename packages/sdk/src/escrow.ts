import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from 'viem'
import { fermataEscrowAbi } from './abi.ts'
import { tip20Abi, type Movement } from './tip20.ts'

/** `FermataEscrow.Status`. Anything but None is final except Held. */
export const HoldStatus = { None: 0, Held: 1, Released: 2, Refunded: 3, TimedOut: 4 } as const
export type HoldStatus = (typeof HoldStatus)[keyof typeof HoldStatus]

export function getHold(client: PublicClient, escrow: Address, callId: Hex) {
  return client.readContract({ address: escrow, abi: fermataEscrowAbi, functionName: 'getHold', args: [callId] })
}

export function getService(client: PublicClient, escrow: Address, serviceId: Hex) {
  return client.readContract({ address: escrow, abi: fermataEscrowAbi, functionName: 'getService', args: [serviceId] })
}

/**
 * What an accountant sees for one call without any Fermata indexer: every TIP-20 movement whose
 * `TransferWithMemo` memo is `callId`, in chain order (hold, then release/refund).
 */
export async function reconcile(
  client: PublicClient,
  opts: { token: Address; callId: Hex; fromBlock?: bigint; toBlock?: bigint },
): Promise<(Movement & { txHash: Hex; blockNumber: bigint })[]> {
  const logs = await client.getContractEvents({
    address: opts.token,
    abi: tip20Abi,
    eventName: 'TransferWithMemo',
    args: { memo: opts.callId },
    fromBlock: opts.fromBlock ?? 0n,
    toBlock: opts.toBlock ?? 'latest',
  })
  return logs
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
    .map((l) => ({
      token: l.address,
      from: l.args.from!,
      to: l.args.to!,
      amount: l.args.amount!,
      txHash: l.transactionHash,
      blockNumber: l.blockNumber,
    }))
}

/**
 * Agent-side timeout refund: `claimTimeout(callId)` once the settlement window has passed. Anyone
 * may send it; the money always goes to the agent, so an agent never depends on the gateway.
 */
export async function reclaim(
  wallet: WalletClient<Transport, Chain, Account>,
  client: PublicClient,
  escrow: Address,
  callId: Hex,
) {
  const hold = await getHold(client, escrow, callId)
  if (hold.status !== HoldStatus.Held) throw new Error(`call ${callId} is not held (status ${hold.status})`)
  const now = (await client.getBlock()).timestamp
  if (now <= hold.deadline) throw new Error(`settlement window open until ${hold.deadline} (chain time ${now})`)
  const hash = await wallet.writeContract({ address: escrow, abi: fermataEscrowAbi, functionName: 'claimTimeout', args: [callId] })
  return client.waitForTransactionReceipt({ hash })
}
