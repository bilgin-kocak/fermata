import {
  BaseError,
  ContractFunctionRevertedError,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem'
import { fermataEscrowAbi, getHold, getService, reconcile, type Verdict } from '@fermata/sdk'

export type TxResult = { ok: true; txHash: Hex } | { ok: false; error: string; txHash?: Hex }

/** Everything the gateway reads from / writes to the chain (a fake in unit tests). */
export interface GatewayChain {
  readonly chainId: number
  readonly escrow: Address
  service(serviceId: Hex): Promise<Awaited<ReturnType<typeof getService>>>
  hold(callId: Hex): Promise<Awaited<ReturnType<typeof getHold>>>
  now(): Promise<bigint>
  settle(callId: Hex, verdict: Verdict, signature: Hex): Promise<TxResult>
  claimTimeout(callId: Hex): Promise<TxResult>
  /** Escrow Held/Released/Refunded events from `fromBlock`, oldest first. */
  events(fromBlock: bigint): Promise<EscrowEvent[]>
  /** The call's TIP-20 movements, by memo (SDK `reconcile`). */
  movements(token: Address, callId: Hex, fromBlock: bigint): Promise<{ token: Address; from: Address; to: Address; amount: bigint; txHash: Hex; blockNumber: bigint }[]>
}

export type EscrowEvent = {
  event: 'Held' | 'Released' | 'Refunded'
  callId: Hex
  serviceId: Hex
  blockNumber: bigint
  txHash: Hex
  args: Record<string, unknown>
}

/** Attestor verdict JSON (snake_case, from Rust) → the escrow's Verdict struct. */
export function toVerdict(v: Record<string, unknown>): Verdict {
  return {
    callId: v.call_id as Hex,
    serviceId: v.service_id as Hex,
    requestHash: v.request_hash as Hex,
    predicateHash: v.predicate_hash as Hex,
    outcome: v.outcome as 1 | 2,
    presentationHash: v.presentation_hash as Hex,
    responseHash: v.response_hash as Hex,
    issuedAt: BigInt(v.issued_at as number),
  }
}

function reason(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.shortMessage
    return e.shortMessage
  }
  return (e as Error).message
}

/**
 * viem implementation. Writes go through one relayer wallet, strictly one at a time, so nonces never
 * race between concurrent calls and the sweeper.
 */
export class ViemChain implements GatewayChain {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly client: PublicClient,
    readonly relayer: WalletClient<Transport, Chain, Account>,
    readonly escrow: Address,
    readonly chainId: number,
  ) {}

  service(serviceId: Hex) {
    return getService(this.client, this.escrow, serviceId)
  }

  hold(callId: Hex) {
    return getHold(this.client, this.escrow, callId)
  }

  async now() {
    return (await this.client.getBlock()).timestamp
  }

  private write(functionName: 'settle' | 'claimTimeout', args: readonly unknown[]): Promise<TxResult> {
    const run = async (): Promise<TxResult> => {
      try {
        const txHash = await this.relayer.writeContract({ address: this.escrow, abi: fermataEscrowAbi, functionName, args } as never)
        const receipt = await this.client.waitForTransactionReceipt({ hash: txHash })
        return receipt.status === 'success' ? { ok: true, txHash } : { ok: false, txHash, error: 'transaction reverted' }
      } catch (e) {
        return { ok: false, error: reason(e) }
      }
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  settle(callId: Hex, verdict: Verdict, signature: Hex) {
    return this.write('settle', [callId, verdict, signature])
  }

  async events(fromBlock: bigint): Promise<EscrowEvent[]> {
    const logs = await this.client.getContractEvents({ address: this.escrow, abi: fermataEscrowAbi, fromBlock, toBlock: 'latest' })
    return logs
      .filter((l) => ['Held', 'Released', 'Refunded'].includes(l.eventName))
      .map((l) => {
        const args = l.args as Record<string, unknown>
        return {
          event: l.eventName as EscrowEvent['event'],
          callId: args.callId as Hex,
          serviceId: args.serviceId as Hex,
          blockNumber: l.blockNumber,
          txHash: l.transactionHash,
          args,
        }
      })
  }

  movements(token: Address, callId: Hex, fromBlock: bigint) {
    return reconcile(this.client, { token, callId, fromBlock })
  }

  claimTimeout(callId: Hex) {
    return this.write('claimTimeout', [callId])
  }
}
