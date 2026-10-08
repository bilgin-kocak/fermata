import { Credential, Method } from 'mppx'
import {
  isAddressEqual,
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem'
import { fermataEscrowAbi } from './abi.ts'
import type { AnyPublicClient, AnyWalletClient } from './clients.ts'
import { getService } from './escrow.ts'
import { fermataMethod } from './method.ts'
import { isTrustedService } from './serviceId.ts'
import { signPermit } from './tip20.ts'

export type FermataClientOptions = {
  /** The agent's wallet (a local account: it signs the EIP-2612 permit), on any chain definition. */
  wallet: AnyWalletClient
  client: AnyPublicClient
  /** Verifier keys the agent accepts (Fermata's). A service settled by anyone else is refused. */
  trustedVerifiers: readonly Address[]
  /** Escrow deployments the agent accepts. */
  escrows: readonly Address[]
  /** Highest price per call the agent pays, in token base units. Default: no cap. */
  maxAmount?: bigint
  /**
   * Longest settlement window the agent accepts, in seconds (default 3600): when a call is never
   * settled, its money stays held that long before the timeout refund.
   */
  maxSettlementWindow?: number
  /** Permit validity (seconds of chain time). Default 600. */
  permitTtl?: number
  /**
   * Called after the hold is mined, e.g. to keep the callId for `reclaim` should the paid call then
   * fail. Errors it throws are ignored: the hold's credential must still reach the gateway.
   */
  onHold?: (hold: { callId: Hex; serviceId: Hex; txHash: Hex; amount: bigint; escrow: Address }) => void
}

/**
 * Client side of the `fermata` method for `mppx/client`: pays a `fermata` challenge by holding the
 * price in the escrow (permit + `hold` in one transaction from the agent's wallet). Before any money
 * moves it checks that the escrow and chain are expected, that the service is settled by a trusted
 * verifier in the challenged token, that the challenged amount is the registered price, and that the
 * price and the settlement window are within the agent's limits.
 *
 * What it cannot check: a challenge is not bound to the URL being fetched, and its requestHash is not
 * re-derived here. A server that relays a gateway's challenge can make the agent pay, at a trusted
 * service's registered price, for a request of the relay's choosing; and a trusted verifier does not
 * vouch for every service that names it. Pay only challenges from gateways you trust.
 */
// One hold at a time per agent account: each hold signs a permit with the token's current nonce and
// sends a transaction with the account's next nonce, so two concurrent payments would collide on both.
const holdQueues = new Map<string, Promise<unknown>>()
function oneAtATime<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (holdQueues.get(key) ?? Promise.resolve()).then(task, task)
  const settled = run.then(() => undefined, () => undefined)
  holdQueues.set(key, settled)
  void settled.then(() => holdQueues.get(key) === settled && holdQueues.delete(key))
  return run
}

export function fermata(opts: FermataClientOptions): Method.Client<typeof fermataMethod> {
  const client = opts.client as PublicClient
  const wallet = opts.wallet as WalletClient<Transport, Chain, Account>
  // This agent's holds by callId. A gateway that challenges again with the same callId (its RPC did
  // not show the hold yet, or the paid retry was lost) gets the same hold back: a second hold would
  // revert with CallIdUsed and leave the first one to the timeout refund.
  const holds = new Map<string, { txHash: Hex; escrow: Address; serviceId: string; requestHash: string; amount: string }>()
  return Method.toClient(fermataMethod, {
    async createCredential({ challenge }) {
      const r = challenge.request
      const callId = r.callId as Hex | undefined
      if (!callId) throw new Error('fermata challenge carries no callId')
      const escrow = r.escrow as Address
      if (!opts.escrows.some((e) => isAddressEqual(e, escrow))) throw new Error(`untrusted escrow ${escrow}`)
      const chainId = await client.getChainId()
      if (r.chainId !== chainId) throw new Error(`challenge is for chain ${r.chainId}, client is on ${chainId}`)

      const prior = holds.get(callId.toLowerCase())
      if (prior) {
        const same = isAddressEqual(prior.escrow, escrow) && prior.serviceId === r.serviceId.toLowerCase() && prior.requestHash === r.requestHash.toLowerCase() && prior.amount === r.amount
        if (!same) throw new Error(`call ${callId} is already held (hold ${prior.txHash}) for other terms`)
        return Credential.serialize({ challenge, payload: { type: 'hold', txHash: prior.txHash, callId } })
      }

      const service = await getService(client, escrow, r.serviceId as Hex)
      if (isAddressEqual(service.token, zeroAddress)) throw new Error(`unknown service ${r.serviceId}`)
      if (!isTrustedService(service, { trustedVerifiers: opts.trustedVerifiers, expectedToken: r.currency as Address })) {
        throw new Error(`service ${r.serviceId} is settled by ${service.verifier}, not a trusted verifier (or pays in another token)`)
      }
      const amount = BigInt(r.amount)
      if (amount !== service.pricePerCall) throw new Error(`challenged amount ${amount} ≠ registered price ${service.pricePerCall}`)
      if (opts.maxAmount !== undefined && amount > opts.maxAmount) throw new Error(`price ${amount} is above maxAmount ${opts.maxAmount}`)
      const maxWindow = opts.maxSettlementWindow ?? 3600
      if (service.settlementWindow > maxWindow) {
        throw new Error(`service ${r.serviceId} keeps an unsettled payment held for ${service.settlementWindow} s, above maxSettlementWindow (${maxWindow} s)`)
      }

      const account = wallet.account as LocalAccount
      const txHash = await oneAtATime(account.address.toLowerCase(), async () => {
        const deadline = (await client.getBlock()).timestamp + BigInt(opts.permitTtl ?? 600)
        const { v, r: sr, s } = await signPermit(client, service.token, account, escrow, amount, deadline)
        const hash = await wallet.writeContract({
          address: escrow,
          abi: fermataEscrowAbi,
          functionName: 'hold',
          args: [callId, r.serviceId as Hex, r.requestHash as Hex, deadline, v, sr, s],
        })
        const receipt = await client.waitForTransactionReceipt({ hash }).catch((e: Error) => {
          throw new Error(
            `hold ${hash} for call ${callId} was sent but not confirmed (${e.message}). If it is mined and the call is never settled, reclaim it after the settlement window: reclaim(wallet, client, ${escrow}, ${callId})`,
          )
        })
        if (receipt.status !== 'success') throw new Error(`hold transaction reverted: ${hash}`)
        return hash
      })
      holds.set(callId.toLowerCase(), { txHash, escrow, serviceId: r.serviceId.toLowerCase(), requestHash: r.requestHash.toLowerCase(), amount: r.amount })
      if (holds.size > 1000) holds.delete(holds.keys().next().value!)
      try {
        opts.onHold?.({ callId, serviceId: r.serviceId as Hex, txHash, amount, escrow })
      } catch {
        // ignored: the hold is mined, and its credential must still reach the gateway
      }
      return Credential.serialize({ challenge, payload: { type: 'hold', txHash, callId } })
    },
  })
}
