import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Budget, isNonceError, lockFile, plainError, withNonceRetry } from '../src/guard.ts'

describe('Budget', () => {
  it('reserves before paying, refuses past the limit, and gives back cancelled and refunded payments', () => {
    const b = new Budget(30n)
    expect(b.reserve(10n)).toBe(true)
    expect(b.reserve(10n)).toBe(true)
    expect(b.reserve(20n)).toBe(false) // 20 + 20 > 30
    b.cancel(10n) // that hold was never made
    expect([b.held, b.net, b.left]).toEqual([10n, 10n, 20n])
    b.refund(10n) // a proven failure came back
    expect([b.held, b.refunded, b.net, b.left]).toEqual([10n, 10n, 0n, 30n])
    expect(b.reserve(30n)).toBe(true)
  })

  it('never refunds more than was held, and refuses non-positive amounts', () => {
    const b = new Budget(10n)
    b.reserve(5n)
    b.refund(50n)
    expect([b.refunded, b.net]).toEqual([5n, 0n])
    expect(b.reserve(0n)).toBe(false)
    expect(b.reserve(-1n)).toBe(false)
    b.cancel(99n)
    expect(b.held).toBe(0n)
  })
})

describe('withNonceRetry', () => {
  const nonce = Object.assign(new Error('Nonce provided for the transaction is lower than the current nonce'), { shortMessage: 'nonce too low' })
  const noWait = async () => {}

  it('retries a taken nonce (up to 3 sends) and returns the first success', async () => {
    let n = 0
    const r = await withNonceRetry(async () => {
      if (++n < 3) throw nonce
      return 'sent'
    }, 3, noWait)
    expect([r, n]).toEqual(['sent', 3])
  })

  it('never retries anything else, and gives up after 3 nonce errors', async () => {
    let n = 0
    await expect(withNonceRetry(async () => { n++; throw new Error('transfer amount exceeds balance') }, 3, noWait)).rejects.toThrow(/balance/)
    expect(n).toBe(1)
    n = 0
    await expect(withNonceRetry(async () => { n++; throw nonce }, 3, noWait)).rejects.toThrow()
    expect(n).toBe(3)
  })

  it('treats "already known" as not retryable: our own hold may already be pending', () => {
    expect(isNonceError(new Error('already known'))).toBe(false)
    expect(isNonceError(new Error('replacement transaction underpriced'))).toBe(true)
  })
})

describe('lockFile', () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), 'fermata-lock-'))

  it('a second holder waits until the first releases', async () => {
    const file = path.join(dir(), 'w.lock')
    const order: string[] = []
    const release = await lockFile(file)
    const second = lockFile(file, { pollMs: 10 }).then((r) => (order.push('second'), r))
    await new Promise((ok) => setTimeout(ok, 50))
    order.push('first done')
    release()
    ;(await second)()
    expect(order).toEqual(['first done', 'second'])
    expect(existsSync(file)).toBe(false)
  })

  it('takes over a stale lock (a crashed session) and gives up on a live one after the timeout', async () => {
    const file = path.join(dir(), 'w.lock')
    writeFileSync(file, '99999 crashed\n')
    const old = (Date.now() - 600_000) / 1000
    utimesSync(file, old, old)
    ;(await lockFile(file, { staleMs: 1_000 }))()
    const held = await lockFile(file)
    await expect(lockFile(file, { timeoutMs: 50, pollMs: 10 })).rejects.toThrow(/another fermata-mcp session/)
    held()
  })
})

describe('plainError', () => {
  it('turns common failures into one sentence with the next step', () => {
    expect(plainError('transfer amount exceeds balance', { wallet: '0xabc' })).toMatch(/0xabc.*not hold enough testnet pathUSD.*Nothing was paid/)
    expect(plainError('service 0x12 is settled by 0x34, not a trusted verifier (or pays in another token)')).toMatch(/FERMATA_TRUSTED_VERIFIERS/)
    expect(plainError('untrusted escrow 0x56')).toMatch(/FERMATA_ESCROW/)
    expect(plainError('payment declined: price 200000 is above FERMATA_MAX_PRICE 100000')).toMatch(/Raise FERMATA_MAX_PRICE/)
    expect(plainError("only 10 s of the hold's settlement window are left (15 s needed to prove and settle)")).toMatch(/fermata_reclaim/)
    expect(plainError('cannot reach the Fermata gateway at https://g/mcp (fetch failed)', { gateway: 'https://g' })).toMatch(/cannot be reached right now/)
    expect(plainError('something else entirely')).toBe('something else entirely')
  })
})
