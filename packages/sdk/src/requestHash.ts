import { concat, sha256, toHex, type Hex } from 'viem'

/**
 * requestHash = sha256(serviceId ‖ METHOD ‖ request-target ‖ sha256(body)), no separators.
 * - serviceId: 32 raw bytes
 * - METHOD: upper-case ASCII (unambiguous: methods are [A-Z]+ and targets start with "/")
 * - request-target: verbatim from the request line (origin-form, including "?query")
 * - body: the raw bytes as sent (no JSON canonicalisation in v1); empty body → sha256("")
 * Identical in Rust (attestor), Solidity (tests) and here.
 */
export function requestHash(serviceId: Hex, method: string, target: string, body: string | Uint8Array = ''): Hex {
  if (!target.startsWith('/')) throw new Error(`request-target must be origin-form ("/…"), got ${target}`)
  const bodyBytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return sha256(concat([serviceId, toHex(method.toUpperCase()), toHex(target), sha256(bodyBytes)]))
}
