import { Method, z, type Receipt } from 'mppx'
import type { Hex } from 'viem'

/**
 * The `fermata` MPP payment method (intent `charge`): instead of paying the vendor, the agent holds
 * the price in `FermataEscrow`; the gateway proves the vendor's response with TLSNotary and settles
 * on a signed verdict (release to the vendor, or refund).
 *
 * Challenge: escrow + chain, serviceId, the requestHash of this exact HTTP request, a server-minted
 * callId, amount (base units) and currency (TIP-20). Credential: the hold transaction hash.
 */
export const fermataMethod = Method.from({
  name: 'fermata',
  intent: 'charge',
  schema: {
    request: z.object({
      /** Price in token base units (string of digits), equal to the service's pricePerCall. */
      amount: z.string(),
      /** TIP-20 token address. */
      currency: z.string(),
      escrow: z.string(),
      chainId: z.number(),
      serviceId: z.string(),
      requestHash: z.string(),
      /** Minted by the server's `request` hook (the schema is parsed before the hook runs). */
      callId: z.optional(z.string()),
    }),
    credential: {
      payload: z.object({ type: z.literal('hold'), txHash: z.string(), callId: z.string() }),
    },
  },
})

export type FermataRequest = z.output<(typeof fermataMethod)['schema']['request']>

/**
 * The Payment-Receipt of a call paid with `fermata`: mppx's receipt plus the call's Fermata fields.
 * Read it with `Receipt.fromResponse(res) as FermataReceipt`.
 */
export type FermataReceipt = Receipt.Receipt & {
  callId: Hex
  holdTx: Hex
  /** The release or refund transaction, once the call is settled. */
  txHash: Hex | null
  presentationHash: Hex | null
  /** `AWAITING_TIMEOUT`: no proof, so the escrow refunds the agent once the settlement window closes. */
  outcome: 'DELIVERED' | 'FAILED' | 'AWAITING_TIMEOUT' | null
}
