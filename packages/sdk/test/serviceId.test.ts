import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { isTrustedService, serviceId, serviceOwner } from '../src/serviceId.ts'

const vendor = getAddress('0x2222222222222222222222222222222222222222')

describe('serviceId', () => {
  it('is the owner address followed by a 12-byte label', () => {
    expect(serviceId(vendor, '0x222222222222222222222222')).toBe(`0x${'22'.repeat(32)}`)
    const id = serviceId(vendor, 'quote')
    expect(id.length).toBe(66)
    expect(id.toLowerCase().startsWith(vendor.toLowerCase())).toBe(true)
    expect(id.slice(42)).toBe(`71756f7465${'00'.repeat(7)}`) // "quote", right-padded
    expect(serviceOwner(id)).toBe(vendor)
  })

  it('rejects labels longer than 12 bytes', () => {
    expect(() => serviceId(vendor, 'thirteen-byte')).toThrow()
  })

  it('isTrustedService checks the verifier (and optionally the token)', () => {
    const fermata = getAddress('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf')
    const pathUSD = getAddress('0x20c0000000000000000000000000000000000000')
    const service = { verifier: fermata, token: pathUSD }
    expect(isTrustedService(service, { trustedVerifiers: [fermata] })).toBe(true)
    expect(isTrustedService(service, { trustedVerifiers: [vendor] })).toBe(false)
    expect(isTrustedService(service, { trustedVerifiers: [fermata], expectedToken: vendor })).toBe(false)
  })
})
