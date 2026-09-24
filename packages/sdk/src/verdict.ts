import { hashTypedData, type Address, type Hex, type LocalAccount } from 'viem'

/** Verdict outcomes, as stored in `Verdict.outcome` (0 is invalid). */
export const Outcome = { Delivered: 1, Failed: 2 } as const
export type Outcome = (typeof Outcome)[keyof typeof Outcome]

/** The verifier's EIP-712 decision about one call (mirrors `FermataEscrow.Verdict`). */
export type Verdict = {
  callId: Hex
  serviceId: Hex
  requestHash: Hex
  predicateHash: Hex
  outcome: Outcome
  presentationHash: Hex
  responseHash: Hex
  issuedAt: bigint
}

export const verdictTypes = {
  Verdict: [
    { name: 'callId', type: 'bytes32' },
    { name: 'serviceId', type: 'bytes32' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'predicateHash', type: 'bytes32' },
    { name: 'outcome', type: 'uint8' },
    { name: 'presentationHash', type: 'bytes32' },
    { name: 'responseHash', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
  ],
} as const

/** EIP-712 domain of one escrow deployment: ("Fermata", "1", chainId, escrow). */
export function fermataDomain(chainId: number, escrow: Address) {
  return { name: 'Fermata', version: '1', chainId, verifyingContract: escrow } as const
}

export function verdictTypedData(chainId: number, escrow: Address, verdict: Verdict) {
  return {
    domain: fermataDomain(chainId, escrow),
    types: verdictTypes,
    primaryType: 'Verdict',
    message: verdict,
  } as const
}

/** The digest `FermataEscrow.verdictDigest(verdict)` returns on that deployment. */
export function verdictDigest(chainId: number, escrow: Address, verdict: Verdict): Hex {
  return hashTypedData(verdictTypedData(chainId, escrow, verdict))
}

/**
 * Signs a verdict: 65-byte r ‖ s ‖ v with v ∈ {27, 28} and low s, the only form the escrow accepts
 * (64-byte EIP-2098 signatures are rejected).
 */
export function signVerdict(account: LocalAccount, chainId: number, escrow: Address, verdict: Verdict): Promise<Hex> {
  return account.signTypedData(verdictTypedData(chainId, escrow, verdict))
}
