// Public mode (GATEWAY_PUBLIC=1): a "try it" endpoint for the hosted testnet demo. Visitors press a
// button; a server-side demo agent pays the gateway with the real `fermata` method (hold on-chain,
// TLSNotary proof, settle), exactly as any agent would. Visitors need no wallet.
//
//   GET  /demo/status        → what can be tried, whether a call is running, today's budget
//   POST /demo/call {kind}   → one paid call; 429 when rate-limited or busy, 503 when read-only
//
// Limits: one call per IP per `perIpSeconds`, one call in flight at a time (proving is serialised
// anyway), `dailyCap` calls per UTC day. A balance guard tops the demo agent and the relayer up from
// the testnet faucet when low; if that fails the demo turns read-only instead of failing calls.
import type { Context, Hono } from 'hono'
import type { Address, Hex } from 'viem'
import { clientIp, DailyCap, RateLimiter } from './limits.ts'

export type DemoKind = { serviceId: Hex; path: string; label: string; description: string }

export type DemoConfig = {
  kinds: Record<string, DemoKind>
  perIpSeconds?: number
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
  trustProxy?: boolean
  now?: () => number
  log?: (m: string) => void
}

export function publicRoutes(app: Hono, deps: DemoDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((m: string) => console.log(`[demo] ${m}`))
  const perIp = new RateLimiter(1, (deps.config.perIpSeconds ?? 20) * 1000, now)
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
    clientIp(c.req.raw.headers, (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress, !!deps.trustProxy)

  app.get('/demo/status', async (c) => {
    await guard().catch(() => undefined)
    return c.json({
      enabled: true,
      readOnly: readOnly ?? null,
      busy: !!busy,
      remainingToday: daily.remaining(),
      perIpSeconds: deps.config.perIpSeconds ?? 20,
      payer: deps.wallets.find((w) => w.name === 'demo agent')?.address ?? null,
      kinds: Object.entries(deps.config.kinds).map(([id, k]) => ({ id, label: k.label, description: k.description, serviceId: k.serviceId, path: k.path })),
    })
  })

  app.post('/demo/call', async (c) => {
    const { kind } = ((await c.req.json().catch(() => ({}))) ?? {}) as { kind?: string }
    const k = kind ? deps.config.kinds[kind] : undefined
    if (!k) return c.json({ error: `unknown kind; one of ${Object.keys(deps.config.kinds).join(', ')}` }, 400)
    await guard().catch(() => undefined)
    if (readOnly) return c.json({ error: readOnly }, 503)
    if (busy) return c.json({ error: 'another visitor’s call is being proved; try again in a few seconds', retryAfterMs: 3000 }, 429)
    const wait = perIp.take(ip(c))
    if (wait) return c.json({ error: `one call per ${deps.config.perIpSeconds ?? 20} s per visitor`, retryAfterMs: wait }, 429)
    if (!daily.take()) return c.json({ error: 'today’s demo budget is used up; the scoreboard and past calls stay available' }, 429)
    busy = kind
    try {
      const r = await deps.pay(k.serviceId, k.path)
      log(`${kind}: HTTP ${r.status} ${r.outcome ?? ''} ${r.callId ?? ''}`)
      return c.json({ kind, ...r })
    } catch (e) {
      return c.json({ kind, error: (e as Error).message.slice(0, 300) }, 502)
    } finally {
      busy = undefined
    }
  })
}
