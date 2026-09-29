import { createHash } from 'node:crypto'
import { Method, z } from 'mppx'

export const PATH_USD = '0x20c0000000000000000000000000000000000000'
export const SERVICE_ID = '0x0000000000000000000000000000000000000000000000000000000000000001'
export const ESCROW_PLACEHOLDER = '0x0000000000000000000000000000000000000fe1'
export const SECRET_KEY = 'spike-probe-secret-key-at-least-32-bytes-long!!'
export const PORT = 4242
export const BASE = `http://127.0.0.1:${PORT}`

/** The custom method: challenge carries escrow/serviceId/callId/requestHash; credential carries the hold tx hash. */
export const probe = Method.from({
  name: 'probe',
  intent: 'charge',
  schema: {
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      recipient: z.string(),
      serviceId: z.string(),
      requestHash: z.string(),
      // minted by the server's `request` hook (schema is parsed before the hook runs → optional)
      callId: z.optional(z.string()),
    }),
    credential: { payload: z.object({ type: z.literal('hold'), txHash: z.string(), callId: z.string() }) },
  },
})

export function sha256hex(...parts: (Buffer | string)[]) {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return '0x' + h.digest('hex')
}

/** requestHash = sha256(serviceId ‖ METHOD ‖ target ‖ sha256(body)), no separators. */
export function requestHash(serviceIdHex: string, method: string, target: string, body: string) {
  const bodyHash = createHash('sha256').update(body).digest()
  return sha256hex(Buffer.from(serviceIdHex.slice(2), 'hex'), method.toUpperCase(), target, bodyHash)
}

/** Stand-in for an on-chain hold: the "tx hash" is derived from a shared secret and the callId. */
export function fakeHold(callId: string) {
  return sha256hex('spike-hold:', callId)
}
