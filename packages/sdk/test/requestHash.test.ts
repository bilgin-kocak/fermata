import { describe, expect, it } from 'vitest'
import { pad, sha256 } from 'viem'
import { requestHash } from '../src/requestHash.ts'

describe('requestHash', () => {
  it('matches the Rust attestor and Solidity for the spike request', () => {
    const serviceId = pad('0x01', { size: 32 })
    expect(requestHash(serviceId, 'POST', '/v1/quote', '{"symbol":"BTC-USD"}')).toBe(
      '0xe8b23a0b9ea8101a4a0173a94062d4c5a197bc08b706e069c58eafccc47444b7',
    )
  })

  it('upper-cases the method, keeps the query, hashes an empty body as sha256("")', () => {
    const id = pad('0x02', { size: 32 })
    expect(requestHash(id, 'get', '/v1/quote?symbol=BTC')).toBe(requestHash(id, 'GET', '/v1/quote?symbol=BTC', ''))
    expect(requestHash(id, 'GET', '/v1/quote?symbol=BTC')).not.toBe(requestHash(id, 'GET', '/v1/quote'))
    expect(sha256(new Uint8Array())).toBe('0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(requestHash(id, 'POST', '/x', new TextEncoder().encode('{}'))).toBe(requestHash(id, 'POST', '/x', '{}'))
  })

  it('rejects absolute-form targets', () => {
    expect(() => requestHash(pad('0x01', { size: 32 }), 'GET', 'https://host/x')).toThrow()
  })
})
