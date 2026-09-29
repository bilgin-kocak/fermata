import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canonicalOrigin, notaryKeyHash, originHash, predicateHash } from '../src/hashes.ts'

// Vectors shared with apps/attestor/src/hashes.rs (values from `cast keccak`).
describe('registration hashes', () => {
  it('originHash matches the attestor', () => {
    expect(originHash('https://vendor.fermata.test:8443')).toBe('0x99d1433da9b4903068a8548272ad3128e24be018828f8b1f14282b37b8261f29')
    expect(originHash('https://Vendor.Fermata.Test:8443/')).toBe(originHash('https://vendor.fermata.test:8443'))
  })

  it('canonicalises like the attestor', () => {
    expect(canonicalOrigin('https://api.example.com:443')).toBe('https://api.example.com')
    for (const bad of ['http://a.com', 'https://a.com/x', 'https://a.com?q', 'https://u@a.com', 'https://', 'https://a.com:99999']) {
      expect(() => canonicalOrigin(bad), bad).toThrow()
    }
  })

  it('notaryKeyHash matches the attestor', () => {
    expect(notaryKeyHash('0x02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27')).toBe(
      '0x138b5a9c7e4489edde45496ce6770b6d91d5a0bcebb81ead85a3704242008aff',
    )
    expect(() => notaryKeyHash('0x1234')).toThrow()
  })

  it('predicateHash of the demo predicate matches the verdict fixture', () => {
    const bytes = readFileSync(new URL('../../../apps/attestor/predicates/quote-v1.json', import.meta.url))
    const fixture = JSON.parse(readFileSync(new URL('../../../contracts/test/fixtures/attest-vector.json', import.meta.url), 'utf8'))
    expect(predicateHash(bytes)).toBe(fixture.predicateHash)
  })
})
