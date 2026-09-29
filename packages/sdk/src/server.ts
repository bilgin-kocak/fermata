import { randomBytes } from 'node:crypto'
import { Errors, Method, Store } from 'mppx'
import { isAddressEqual, parseEventLogs, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { fermataEscrowAbi } from './abi.ts'
import { HoldStatus, getHold } from './escrow.ts'
import { fermataMethod } from './method.ts'

const fail = (reason: string): never => {
  throw new Errors.VerificationFailedError({ reason })
}
const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export type FermataServerOptions = {
  client: PublicClient
  escrow: Address
  /** Replay store; one claim per callId. Defaults to an in-memory store. */
  store?: Store.AtomicStore
}

/**
 * Server side of the `fermata` method, for a gateway (or a vendor hosting the method itself).
 * - `request` mints a fresh callId per challenge and echoes it on the paid pass;
 * - `stableBinding` binds a credential to this route's serviceId, requestHash, price, token and
 *   escrow, but not to the per-challenge callId;
 * - `validate` accepts only a successful hold transaction on this escrow whose `Held` event has this
 *   callId, serviceId, requestHash and amount, and whose hold is still open;
 * - `broadcast` claims the callId once (replay protection) and returns the receipt.
 * Every rejection is a `VerificationFailedError` (HTTP 402), never a 500.
 */
export function fermataServer({ client, escrow, store = Store.memory() }: FermataServerOptions) {
  return Method.toServer(fermataMethod, {
    request({ credential, request }) {
      const echoed = (credential?.challenge.request as { callId?: string } | undefined)?.callId
      return { ...request, callId: echoed ?? toHex(randomBytes(32)) }
    },
    stableBinding: (r) => ({
      amount: r.amount,
      currency: r.currency.toLowerCase(),
      escrow: r.escrow.toLowerCase(),
      chainId: r.chainId,
      serviceId: r.serviceId.toLowerCase(),
      requestHash: r.requestHash.toLowerCase(),
    }),
    async validate({ credential, request }) {
      const challenged = credential.challenge.request
      const callId = challenged.callId ?? fail('challenge carries no callId')
      if (!sameHex(credential.payload.callId, callId)) fail('credential callId does not match the challenge')
      if (!isAddressEqual(challenged.escrow as Address, escrow)) fail('challenge names another escrow')

      const receipt = await client
        .getTransactionReceipt({ hash: credential.payload.txHash as Hex })
        .catch(() => fail(`hold transaction ${credential.payload.txHash} not found`))
      if (receipt.status !== 'success') fail('hold transaction reverted')
      const held = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Held', logs: receipt.logs }).find(
        (l) => isAddressEqual(l.address, escrow) && sameHex(l.args.callId, callId),
      )
      if (!held) return fail('no Held event for this callId in the hold transaction')
      if (!sameHex(held.args.serviceId, challenged.serviceId)) fail('hold is for another service')
      if (!sameHex(held.args.requestHash, challenged.requestHash)) fail('hold is for another request')
      if (held.args.amount !== BigInt(challenged.amount)) fail('held amount differs from the price')

      const hold = await getHold(client, escrow, callId as Hex)
      if (hold.status !== HoldStatus.Held) fail(`hold is no longer open (status ${hold.status})`)

      return {
        challenge: credential.challenge,
        credential,
        details: { callId, agent: held.args.agent, holdTx: receipt.transactionHash, deadline: hold.deadline },
        intent: 'charge',
        method: 'fermata',
        request: request as never,
        source: credential.source,
      }
    },
    async broadcast({ credential }) {
      const callId = credential.challenge.request.callId!
      const expires = Date.parse(credential.challenge.expires ?? '') || Date.now() + 3_600_000
      if (!(await Store.tryClaim(store as never, `fermata:call:${callId.toLowerCase()}`, expires))) {
        fail('callId already used')
      }
      return { method: 'fermata', reference: credential.payload.txHash, status: 'success', timestamp: new Date().toISOString() }
    },
  })
}
