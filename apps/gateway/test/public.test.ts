import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { DailyCap, RateLimiter, clientIp } from '../src/limits.ts'
import { publicRoutes, type DemoDeps } from '../src/public.ts'

const sid = `0x${'ab'.repeat(32)}` as Hex
const agent = '0x00000000000000000000000000000000000000a1' as Address
const relayer = '0x00000000000000000000000000000000000000b2' as Address

function setup(over: Partial<DemoDeps> = {}) {
  let t = Date.parse('2026-10-03T10:00:00Z')
  const balances = new Map<string, bigint>([[agent, 5_000_000n], [relayer, 5_000_000n]])
  const paid: string[] = []
  let release: (() => void) | undefined
  const deps: DemoDeps = {
    config: { kinds: { reliable: { serviceId: sid, path: '/v1/quote?symbol=BTC-USD', label: 'Reliable', description: 'answers' } }, perIpSeconds: 20, dailyCap: 3 },
    wallets: [{ name: 'demo agent', address: agent }, { name: 'relayer', address: relayer }],
    balance: async (a) => balances.get(a) ?? 0n,
    topUp: async () => false,
    trustProxy: true,
    now: () => t,
    log: () => {},
    pay: async (s, p) => {
      paid.push(`${s}${p}`)
      if (over.pay === undefined && (globalThis as { hold?: boolean }).hold) await new Promise<void>((r) => (release = r))
      return { status: 200, callId: `0x${'01'.repeat(32)}`, outcome: 'DELIVERED', settleTx: `0x${'02'.repeat(32)}` }
    },
    ...over,
  }
  const app = new Hono()
  publicRoutes(app, deps)
  const call = (ip: string, kind = 'reliable') =>
    app.request('/demo/call', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${ip}, 10.0.0.1` }, body: JSON.stringify({ kind }) })
  return { app, call, paid, balances, advance: (ms: number) => (t += ms), release: () => release?.() }
}

describe('limits', () => {
  it('RateLimiter: one per window per key, tells how long to wait', () => {
    let t = 0
    const rl = new RateLimiter(1, 20_000, () => t)
    expect(rl.take('a')).toBe(0)
    expect(rl.take('a')).toBe(20_000)
    expect(rl.take('b')).toBe(0)
    t = 20_000
    expect(rl.take('a')).toBe(0)
  })
  it('DailyCap resets at UTC midnight', () => {
    let t = Date.parse('2026-10-03T23:59:00Z')
    const cap = new DailyCap(2, () => t)
    expect([cap.take(), cap.take(), cap.take()]).toEqual([true, true, false])
    t = Date.parse('2026-10-04T00:00:01Z')
    expect(cap.take()).toBe(true)
    expect(cap.remaining()).toBe(1)
  })
  it('clientIp trusts X-Forwarded-For only behind our own proxy', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })
    expect(clientIp(h, '127.0.0.1', true)).toBe('203.0.113.7')
    expect(clientIp(h, '127.0.0.1', false)).toBe('127.0.0.1')
  })
})

describe('public demo routes', () => {
  it('status lists the kinds, the payer and today’s budget', async () => {
    const { app } = setup()
    const s = (await (await app.request('/demo/status')).json()) as Record<string, any>
    expect(s).toMatchObject({ enabled: true, readOnly: null, busy: false, remainingToday: 3, payer: agent })
    expect(s.kinds[0]).toMatchObject({ id: 'reliable', serviceId: sid })
  })

  it('pays a call as the demo agent and returns the outcome', async () => {
    const { call, paid } = setup()
    const res = await call('203.0.113.1')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ kind: 'reliable', outcome: 'DELIVERED', status: 200 })
    expect(paid).toEqual([`${sid}/v1/quote?symbol=BTC-USD`])
  })

  it('rejects unknown kinds', async () => {
    expect((await setup().call('1.1.1.1', 'nope')).status).toBe(400)
  })

  it('one call per visitor per window; other visitors are not affected', async () => {
    const { call, advance } = setup()
    expect((await call('203.0.113.1')).status).toBe(200)
    const again = await call('203.0.113.1')
    expect(again.status).toBe(429)
    expect(((await again.json()) as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0)
    expect((await call('203.0.113.2')).status).toBe(200)
    advance(20_000)
    expect((await call('203.0.113.1')).status).toBe(200)
  })

  it('one call in flight at a time', async () => {
    ;(globalThis as { hold?: boolean }).hold = true
    const s = setup()
    const first = s.call('203.0.113.1')
    await new Promise((r) => setTimeout(r, 10))
    const second = await s.call('203.0.113.2')
    expect(second.status).toBe(429)
    expect(((await second.json()) as { error: string }).error).toContain('being proved')
    s.release()
    expect((await first).status).toBe(200)
    ;(globalThis as { hold?: boolean }).hold = false
  })

  it('daily cap', async () => {
    const { call } = setup()
    for (const ip of ['1.0.0.1', '1.0.0.2', '1.0.0.3']) expect((await call(ip)).status).toBe(200)
    const over = await call('1.0.0.4')
    expect(over.status).toBe(429)
    expect(((await over.json()) as { error: string }).error).toContain('budget')
  })

  it('low balance: tops up from the faucet when it can, goes read-only when it cannot', async () => {
    const funded = setup({ topUp: async (a) => (funded.balances.set(a, 9_000_000n), true) })
    funded.balances.set(agent, 10n)
    expect((await funded.call('1.0.0.1')).status).toBe(200)
    expect(funded.balances.get(agent)).toBe(9_000_000n)

    const dry = setup()
    dry.balances.set(relayer, 10n)
    const res = await dry.call('1.0.0.1')
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('relayer balance low')
    expect(dry.paid).toEqual([])
    const s = (await (await dry.app.request('/demo/status')).json()) as { readOnly: string }
    expect(s.readOnly).toContain('paused')
  })

  it('a payment error is reported, and the next visitor can still call', async () => {
    let fail = true
    const s = setup({ pay: async () => { if (fail) throw new Error('hold reverted'); return { status: 200, outcome: 'DELIVERED' } } })
    const bad = await s.call('1.0.0.1')
    expect(bad.status).toBe(502)
    fail = false
    expect((await s.call('1.0.0.2')).status).toBe(200)
  })
})
