import { Challenge, Errors, Method, Store } from 'mppx'
import { isAddressEqual, parseEventLogs, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { fermataEscrowAbi } from './abi.ts'
import type { AnyPublicClient } from './clients.ts'
import { HoldStatus, getHold } from './escrow.ts'
import { eventually } from './eventually.ts'
import { fermataMethod } from './method.ts'

const fail = (reason: string): never => {
  throw new Errors.VerificationFailedError({ reason })
}
const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export type FermataServerOptions = {
  /** A viem public client on the escrow's chain (any chain definition). */
  client: AnyPublicClient
  escrow: Address
  /** The mppx HMAC secret of the server using this method (the same `secretKey` as `Mppx.create`). */
  secretKey: string
  /**
   * Replay store: each callId is claimed once. Defaults to an in-memory store, which protects one
   * process only: when more than one instance serves the same escrow, pass a shared store.
   */
  store?: Store.AtomicStore
  /** How long to look for a hold the RPC does not show yet (a node behind the agent's), in ms. Default 6000. */
  lagToleranceMs?: number
}

/**
 * Server side of the `fermata` method, for a gateway (or a vendor hosting the method itself).
 * - `request` mints a fresh callId per challenge and echoes it on the paid pass, but only from a
 *   challenge this server signed: callIds and hold txs are public on-chain, so echoing any callId
 *   a caller names would let a stranger obtain a valid challenge for someone else's hold and
 *   redeem it first;
 * - `stableBinding` binds a credential to this route's serviceId, requestHash, price, token and
 *   escrow, but not to the per-challenge callId;
 * - `validate` accepts only a successful hold transaction on this escrow whose `Held` event has this
 *   callId, serviceId, requestHash and amount, and whose hold is still open;
 * - `broadcast` claims the callId once (replay protection) and returns the receipt.
 * Every rejection is a `VerificationFailedError` (HTTP 402), never a 500.
 */
export function fermataServer({ client: anyClient, escrow, secretKey, store = Store.memory(), lagToleranceMs = 6_000 }: FermataServerOptions): Method.Server<typeof fermataMethod> {
  const client = anyClient as PublicClient
  const tries = Math.max(1, Math.round(lagToleranceMs / 500))
  return Method.toServer(fermataMethod, {
    request({ credential, request }) {
      const signedByUs = !!credential && Challenge.verify(credential.challenge, { secretKey })
      const echoed = signedByUs ? (credential.challenge.request as { callId?: string }).callId : undefined
      return { ...request, callId: echoed ?? toHex(crypto.getRandomValues(new Uint8Array(32))) }
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

      const receipt = await eventually(() => client.getTransactionReceipt({ hash: credential.payload.txHash as Hex }), undefined, tries).catch(() =>
        fail(`hold transaction ${credential.payload.txHash} not found`),
      )
      if (receipt.status !== 'success') fail('hold transaction reverted')
      const held = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Held', logs: receipt.logs }).find(
        (l) => isAddressEqual(l.address, escrow) && sameHex(l.args.callId, callId),
      )
      if (!held) return fail('no Held event for this callId in the hold transaction')
      if (!sameHex(held.args.serviceId, challenged.serviceId)) fail('hold is for another service')
      if (!sameHex(held.args.requestHash, challenged.requestHash)) fail('hold is for another request')
      if (held.args.amount !== BigInt(challenged.amount)) fail('held amount differs from the price')

      const hold = await eventually(() => getHold(client, escrow, callId as Hex), (h) => h.status !== HoldStatus.None, tries)
      if (hold.status !== HoldStatus.Held) fail(`hold is no longer open (status ${hold.status})`)
      const { timestamp } = await client.getBlock()
      if (timestamp > hold.deadline) fail(`the hold's settlement window closed at ${hold.deadline}: reclaim it with claimTimeout`)

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
