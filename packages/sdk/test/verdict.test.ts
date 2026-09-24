import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { domainSeparator, hashStruct, type Address, type Hex } from 'viem'
import { Outcome, fermataDomain, signVerdict, verdictDigest, verdictTypes, type Verdict } from '../src/verdict.ts'

// Output of the Rust signer (spikes/proof-path `verify --vector`), shared with contracts/test/Vectors.t.sol.
const vector = JSON.parse(readFileSync(new URL('../../../contracts/test/fixtures/verdict-vector.json', import.meta.url), 'utf8'))
const escrow = vector.domain.verifying_contract as Address
const chainId = vector.domain.chain_id as number
const verdict: Verdict = {
  callId: vector.verdict.call_id,
  serviceId: vector.verdict.service_id,
  requestHash: vector.verdict.request_hash,
  predicateHash: vector.verdict.predicate_hash,
  outcome: vector.verdict.outcome,
  presentationHash: vector.verdict.presentation_hash,
  responseHash: vector.verdict.response_hash,
  issuedAt: BigInt(vector.verdict.issued_at),
}

describe('EIP-712 verdict (viem == Rust == Solidity)', () => {
  it('domain separator, struct hash and digest match the Rust vector', () => {
    expect(domainSeparator({ domain: fermataDomain(chainId, escrow) })).toBe(vector.domainSeparator)
    expect(hashStruct({ data: verdict, primaryType: 'Verdict', types: verdictTypes })).toBe(vector.structHash)
    expect(verdictDigest(chainId, escrow, verdict)).toBe(vector.digest)
  })

  it('viem signature is byte-identical to the Rust signature', async () => {
    const account = privateKeyToAccount(vector.privateKey as Hex)
    expect(account.address.toLowerCase()).toBe(vector.signer)
    const sig = await signVerdict(account, chainId, escrow, verdict)
    expect(sig).toBe(vector.signatureBytes)
    expect(sig.length).toBe(2 + 65 * 2)
  })

  it('outcome codes are fixed', () => {
    expect(Outcome.Delivered).toBe(1)
    expect(Outcome.Failed).toBe(2)
  })
})
