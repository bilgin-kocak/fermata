// Public mode (GATEWAY_PUBLIC=1): a "try it" endpoint for the hosted testnet demo. Visitors press a
// button; a server-side demo agent pays the gateway with the real `fermata` method (hold on-chain,
// TLSNotary proof, settle), exactly as any agent would. Visitors need no wallet.
//
//   GET  /demo/status        → what can be tried, whether a call is running, today's budget
//   POST /demo/call {kind}   → one paid call; 429 when rate-limited or busy, 503 when read-only
//
// Limits: one call per IP per `perIpSeconds` (60) and `perIpPerDay` (15) a day, one call in flight at a time (proving is serialised
// anyway), `dailyCap` calls per UTC day. A balance guard tops the demo agent and the relayer up from
// the testnet faucet when low; if that fails the demo turns read-only instead of failing calls.
import type { Context, Hono } from 'hono'
import type { Address, Hex } from 'viem'
import { clientIp, DailyCap, RateLimiter } from './limits.ts'

export type DemoKind = { serviceId: Hex; path: string; label: string; description: string }

export type DemoConfig = {
  kinds: Record<string, DemoKind>
  perIpSeconds?: number
  /** Calls per visitor per day (default 15). */
  perIpPerDay?: number
  dailyCap?: number
  /** Below this (token base units) the guard tops up; default 1.00. */
  minBalance?: string
}

export type DemoResult = { status: number; callId?: Hex; outcome?: string | null; holdTx?: Hex; settleTx?: Hex | null; body?: string }

export type DemoDeps = {
  config: DemoConfig
  /** Pays one call through the gateway as the demo agent. */
  pay: (serviceId: Hex, path: string) => Promise<DemoResult>
  /** Wallets whose balances the guard watches (the demo agent and the relayer). */
  wallets: { name: string; address: Address }[]
  balance: (address: Address) => Promise<bigint>
  /** Testnet faucet; false when unavailable. */
  topUp: (address: Address) => Promise<boolean>
  /** Proxies appending to X-Forwarded-For in front of the gateway (see clientIp). */
  trustProxy?: boolean | number
  clientIpHeader?: string
  now?: () => number
  log?: (m: string) => void
  /** The example path of a served service (set by the gateway): lets visitors try onboarded services. */
  examplePath?: (serviceId: Hex) => string | undefined
}

export function publicRoutes(app: Hono, deps: DemoDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((m: string) => console.log(`[demo] ${m}`))
  const perIpSeconds = deps.config.perIpSeconds ?? 60
  const perIp = new RateLimiter(1, perIpSeconds * 1000, now)
  const perIpDay = new RateLimiter(deps.config.perIpPerDay ?? 15, 86_400_000, now)
  const daily = new DailyCap(deps.config.dailyCap ?? 500, now)
  const minBalance = BigInt(deps.config.minBalance ?? '1000000')
  let busy: string | undefined
  let readOnly: string | undefined
  let lastGuard = 0

  /** Checks balances at most once a minute; tops up when low; read-only if that fails. */
  async function guard(): Promise<void> {
    if (now() - lastGuard < 60_000) return
    lastGuard = now()
    const low: string[] = []
    for (const w of deps.wallets) {
      let bal = await deps.balance(w.address).catch(() => -1n)
      if (bal >= 0n && bal < minBalance) {
        log(`${w.name} ${w.address} low (${bal}); asking the testnet faucet`)
        if (await deps.topUp(w.address).catch(() => false)) bal = await deps.balance(w.address).catch(() => -1n)
      }
      if (bal < minBalance) low.push(`${w.name} balance ${bal < 0n ? 'unreadable' : 'low'}`)
    }
    readOnly = low.length ? `demo paused: ${low.join(', ')}; the faucet could not top it up` : undefined
  }

  const ip = (c: Context) =>
    clientIp(c.req.raw.headers, (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress, deps.trustProxy ?? false, deps.clientIpHeader)

  app.get('/demo/status', async (c) => {
    await guard().catch(() => undefined)
    return c.json({
      enabled: true,
      readOnly: readOnly ?? null,
      busy: !!busy,
      remainingToday: daily.remaining(),
      perIpSeconds,
      payer: deps.wallets.find((w) => w.name === 'demo agent')?.address ?? null,
      kinds: Object.entries(deps.config.kinds).map(([id, k]) => ({ id, label: k.label, description: k.description, serviceId: k.serviceId, path: k.path })),
    })
  })

  app.post('/demo/call', async (c) => {
    const { kind, serviceId } = ((await c.req.json().catch(() => ({}))) ?? {}) as { kind?: string; serviceId?: Hex }
    // Either a configured demo kind, or any served service at its example path (onboarded vendors).
    const path = serviceId && /^0x[0-9a-fA-F]{64}$/.test(serviceId) ? deps.examplePath?.(serviceId) : undefined
    const k = kind ? (Object.hasOwn(deps.config.kinds, kind) ? deps.config.kinds[kind] : undefined) : path !== undefined ? { serviceId: serviceId!, path, label: 'service', description: '' } : undefined
    if (!k) return c.json({ error: `unknown kind; one of ${Object.keys(deps.config.kinds).join(', ')}, or a served serviceId` }, 400)
    await guard().catch(() => undefined)
    if (readOnly) return c.json({ error: readOnly }, 503)
    if (busy) return c.json({ error: 'another visitor’s call is being proved; try again in a few seconds', retryAfterMs: 3000 }, 429)
    const visitor = ip(c)
    const wait = perIp.take(visitor)
    if (wait) return c.json({ error: `one call per ${perIpSeconds} s per visitor`, retryAfterMs: wait }, 429)
    const waitDay = perIpDay.take(visitor)
    if (waitDay) return c.json({ error: 'you have used today’s demo calls; the scoreboard and past calls stay available', retryAfterMs: waitDay }, 429)
    if (!daily.take()) return c.json({ error: 'today’s demo budget is used up; the scoreboard and past calls stay available' }, 429)
    busy = kind ?? serviceId
    try {
      const r = await deps.pay(k.serviceId, k.path)
      log(`${kind ?? 'service'} for ${visitor} (x-forwarded-for: ${c.req.header('x-forwarded-for') ?? '-'}; x-real-ip: ${c.req.header('x-real-ip') ?? '-'}): HTTP ${r.status} ${r.outcome ?? ''} ${r.callId ?? ''}`)
      return c.json({ kind: kind ?? 'service', ...r })
    } catch (e) {
      return c.json({ kind, error: (e as Error).message.slice(0, 300) }, 502)
    } finally {
      busy = undefined
    }
  })
}
