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
import { getService } from './escrow.ts'
import { fermataMethod } from './method.ts'
import { isTrustedService } from './serviceId.ts'
import { signPermit } from './tip20.ts'

export type FermataClientOptions = {
  /** The agent's wallet (a local account: it signs the EIP-2612 permit). */
  wallet: WalletClient<Transport, Chain, Account>
  client: PublicClient
  /** Verifier keys the agent accepts (Fermata's). A service settled by anyone else is refused. */
  trustedVerifiers: readonly Address[]
  /** Escrow deployments the agent accepts. */
  escrows: readonly Address[]
  /** Permit validity (seconds of chain time). Default 600. */
  permitTtl?: number
  /** Called after the hold is mined. */
  onHold?: (hold: { callId: Hex; serviceId: Hex; txHash: Hex; amount: bigint }) => void
}

/**
 * Client side of the `fermata` method for `mppx/client`: pays a `fermata` challenge by holding the
 * price in the escrow (permit + `hold` in one transaction from the agent's wallet). Before any money
 * moves it checks that the escrow and chain are expected, that the service is settled by a trusted
 * verifier in the challenged token, and that the challenged amount is the registered price.
 *
 * The challenge's requestHash is not re-derived here: if a gateway named another request, no proof
 * could ever match it, and the hold can only end in a timeout refund.
 */
export function fermata(opts: FermataClientOptions) {
  return Method.toClient(fermataMethod, {
    async createCredential({ challenge }) {
      const r = challenge.request
      const callId = r.callId as Hex | undefined
      if (!callId) throw new Error('fermata challenge carries no callId')
      const escrow = r.escrow as Address
      if (!opts.escrows.some((e) => isAddressEqual(e, escrow))) throw new Error(`untrusted escrow ${escrow}`)
      const chainId = await opts.client.getChainId()
      if (r.chainId !== chainId) throw new Error(`challenge is for chain ${r.chainId}, client is on ${chainId}`)

      const service = await getService(opts.client, escrow, r.serviceId as Hex)
      if (isAddressEqual(service.token, zeroAddress)) throw new Error(`unknown service ${r.serviceId}`)
      if (!isTrustedService(service, { trustedVerifiers: opts.trustedVerifiers, expectedToken: r.currency as Address })) {
        throw new Error(`service ${r.serviceId} is settled by ${service.verifier}, not a trusted verifier (or pays in another token)`)
      }
      const amount = BigInt(r.amount)
      if (amount !== service.pricePerCall) throw new Error(`challenged amount ${amount} ≠ registered price ${service.pricePerCall}`)

      const account = opts.wallet.account as LocalAccount
      const deadline = (await opts.client.getBlock()).timestamp + BigInt(opts.permitTtl ?? 600)
      const { v, r: sr, s } = await signPermit(opts.client, service.token, account, escrow, amount, deadline)
      const txHash = await opts.wallet.writeContract({
        address: escrow,
        abi: fermataEscrowAbi,
        functionName: 'hold',
        args: [callId, r.serviceId as Hex, r.requestHash as Hex, deadline, v, sr, s],
      })
      const receipt = await opts.client.waitForTransactionReceipt({ hash: txHash })
      if (receipt.status !== 'success') throw new Error(`hold transaction reverted: ${txHash}`)
      opts.onHold?.({ callId, serviceId: r.serviceId as Hex, txHash, amount })
      return Credential.serialize({ challenge, payload: { type: 'hold', txHash, callId } })
    },
  })
}
