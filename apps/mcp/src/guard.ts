// The pieces of fermata-mcp's spending guard and payment path that are worth testing on their own:
// the session budget, retrying a hold whose nonce was taken, a lock so sessions sharing one wallet
// send holds one at a time, and plain-language errors for the model.
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'

/**
 * Per-session budget. `reserve` before paying (false: over budget), `cancel` when no hold was made,
 * `refund` when a held payment came back (a proven failure, or a reclaim). Refunded money can be spent
 * again; a call awaiting its timeout refund stays reserved until it is reclaimed.
 */
export class Budget {
  private reserved = 0n
  private returned = 0n
  constructor(readonly limit: bigint) {}

  reserve(amount: bigint): boolean {
    if (amount <= 0n || this.net + amount > this.limit) return false
    this.reserved += amount
    return true
  }

  /** The payment was never made (declined by the SDK, the transaction failed): give the reservation back. */
  cancel(amount: bigint) {
    this.reserved -= amount < this.reserved ? amount : this.reserved
  }

  /** A held payment was refunded to the wallet. */
  refund(amount: bigint) {
    const room = this.reserved - this.returned
    this.returned += amount < room ? amount : room
  }

  /** Everything held this session (refunds included). */
  get held() {
    return this.reserved
  }
  get refunded() {
    return this.returned
  }
  /** What counts against the limit: held and not refunded. */
  get net() {
    return this.reserved - this.returned
  }
  get left() {
    return this.limit - this.net
  }
}

/**
 * A transaction refused because its nonce was taken: another sender on the same wallet got there first,
 * and ours was never accepted, so sending it again with a fresh nonce cannot pay twice. ("already
 * known" is not one: it can mean our own hold is already pending, and a second would revert.)
 */
export function isNonceError(e: unknown): boolean {
  const m = `${(e as { shortMessage?: string })?.shortMessage ?? ''} ${(e as Error)?.message ?? String(e)}`
  return /nonce too low|nonce has already been used|replacement transaction underpriced/i.test(m)
}

/** Runs `send`, again (up to `attempts` in all) only when it failed on a nonce, after a short random wait. */
export async function withNonceRetry<T>(send: () => Promise<T>, attempts = 3, wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms))): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await send()
    } catch (e) {
      if (i >= attempts || !isNonceError(e)) throw e
      await wait(150 + Math.floor(Math.random() * 350))
    }
  }
}

/**
 * An advisory lock file (created with O_EXCL), held while one payment is sent, so two fermata-mcp
 * sessions on the same wallet do not race for its nonce. A lock older than `staleMs` (a crashed
 * session) is taken over. Returns the release function.
 */
export async function lockFile(file: string, opts: { timeoutMs?: number; staleMs?: number; pollMs?: number } = {}): Promise<() => void> {
  const { timeoutMs = 60_000, staleMs = 120_000, pollMs = 100 } = opts
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const until = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(file, 'wx', 0o600)
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
      closeSync(fd)
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          if (readFileSync(file, 'utf8').startsWith(`${process.pid} `)) unlinkSync(file)
        } catch {
          // already gone (taken over as stale): nothing to release
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(file).mtimeMs > staleMs) unlinkSync(file) // a crashed holder
      } catch {
        // released between the two calls: try again
      }
      if (Date.now() > until) throw new Error(`another fermata-mcp session has been paying from this wallet for over ${Math.round(timeoutMs / 1000)} s (lock ${file})`)
      await new Promise((ok) => setTimeout(ok, pollMs))
    }
  }
}

/** One plain sentence, with the next step, for the errors an agent is likely to meet. */
export function plainError(message: string, ctx: { wallet?: string; gateway?: string } = {}): string {
  const m = message
  const wallet = ctx.wallet ? ` (${ctx.wallet})` : ''
  if (/insufficient (?:funds|balance)|exceeds balance|InsufficientBalance|transfer amount exceeds/i.test(m)) {
    return `the wallet${wallet} does not hold enough testnet pathUSD for this call. Restart fermata-mcp to top up the automatic wallet from the faucet, or fund your own key. Nothing was paid.`
  }
  if (/not a trusted verifier/i.test(m)) {
    return `this service is settled by a verifier you have not trusted, so nothing was paid. Add it to FERMATA_TRUSTED_VERIFIERS only if you trust that operator. (${m})`
  }
  if (/untrusted escrow/i.test(m)) return `the gateway asked for payment into an escrow you have not trusted, so nothing was paid. Set FERMATA_ESCROW to trust it. (${m})`
  if (/above (?:maxAmount|FERMATA_MAX_PRICE)/i.test(m)) return `the price is above your per-call cap, so nothing was paid. Raise FERMATA_MAX_PRICE to allow it. (${m})`
  if (/FERMATA_BUDGET/.test(m)) return `this session's budget is used up, so nothing was paid. Raise FERMATA_BUDGET or start a new session. (${m})`
  if (/maxSettlementWindow/.test(m)) return `the service would hold your payment longer than FERMATA_MAX_WINDOW allows, so nothing was paid. (${m})`
  if (/settlement window are left|window closed/i.test(m)) {
    return `the gateway refused the payment: too little of its settlement window was left to prove and settle. The money is held; reclaim it with fermata_reclaim once the window has passed. (${m})`
  }
  if (/cannot reach the Fermata gateway|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(m)) {
    return `the Fermata gateway${ctx.gateway ? ` at ${ctx.gateway}` : ''} cannot be reached right now; try again in a minute. (${m})`
  }
  if (/another fermata-mcp session/.test(m)) return `${m}. Give each session its own FERMATA_AGENT_KEY to pay in parallel.`
  return m
}
