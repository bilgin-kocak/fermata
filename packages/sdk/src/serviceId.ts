import { concat, getAddress, isAddressEqual, pad, size, slice, toHex, type Address, type Hex } from 'viem'

/**
 * serviceId = owner address (20 bytes) ‖ 12-byte label. The escrow only lets the owner register an
 * id that starts with its own address, so ids cannot be squatted.
 * `label`: a string (UTF-8, ≤ 12 bytes, right-padded with zeros) or hex (≤ 12 bytes, left-padded).
 */
export function serviceId(owner: Address, label: string | Hex): Hex {
  const raw = label.startsWith('0x') ? (label as Hex) : toHex(new TextEncoder().encode(label))
  if (size(raw) > 12) throw new Error(`service label longer than 12 bytes: ${label}`)
  const label12 = label.startsWith('0x') ? pad(raw, { size: 12 }) : pad(raw, { size: 12, dir: 'right' })
  return concat([getAddress(owner), label12])
}

/** The registrant that owns `id` (its first 20 bytes). */
export function serviceOwner(id: Hex): Address {
  return getAddress(slice(id, 0, 20))
}

/** Minimal shape of `FermataEscrow.getService`. */
export type ServiceRecord = {
  owner: Address
  settlementWindow: number
  payout: Address
  token: Address
  verifier: Address
  pricePerCall: bigint
  predicateHash: Hex
  originHash: Hex
  notaryKeyHash: Hex
}

/**
 * Agent-side check before holding money: the service must be settled by a verifier the agent
 * trusts (Fermata's key). A vendor that registers its own verifier could approve its own deliveries.
 */
export function isTrustedService(service: Pick<ServiceRecord, 'verifier' | 'token'>, opts: {
  trustedVerifiers: readonly Address[]
  expectedToken?: Address
}): boolean {
  const verifierOk = opts.trustedVerifiers.some((v) => isAddressEqual(v, service.verifier))
  const tokenOk = opts.expectedToken === undefined || isAddressEqual(opts.expectedToken, service.token)
  return verifierOk && tokenOk
}
