import { keccak256, sha256, size, toHex, type Hex } from 'viem'

/**
 * Canonical HTTPS origin: `https://` + lower-case DNS host + `:port` unless 443. Rejects anything
 * that is not a bare origin (other schemes, paths, queries, user info). Same rules as the Rust
 * attestor's `Origin::parse`.
 */
export function canonicalOrigin(origin: string): string {
  const m = /^https:\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/.exec(origin)
  if (!m) throw new Error(`not a bare https origin: ${origin}`)
  const host = m[1]!.toLowerCase()
  const port = m[2] === undefined ? 443 : Number(m[2])
  if (port < 1 || port > 65535) throw new Error(`bad port in ${origin}`)
  return port === 443 ? `https://${host}` : `https://${host}:${port}`
}

/** `originHash = keccak256(canonical origin)` — what `registerService` stores and the attestor checks. */
export function originHash(origin: string): Hex {
  return keccak256(toHex(canonicalOrigin(origin)))
}

/** `notaryKeyHash = keccak256(33-byte compressed SEC1 notary verifying key)`. */
export function notaryKeyHash(compressedKey: Hex): Hex {
  if (size(compressedKey) !== 33) throw new Error(`expected a 33-byte compressed key, got ${size(compressedKey)} bytes`)
  return keccak256(compressedKey)
}

/** `predicateHash = sha256(predicate JSON bytes exactly as registered)` — never re-serialise. */
export function predicateHash(predicate: string | Uint8Array): Hex {
  return sha256(typeof predicate === 'string' ? new TextEncoder().encode(predicate) : predicate)
}
