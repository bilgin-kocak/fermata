// Abuse limits for the public endpoints (demo calls, onboarding). In-memory: one gateway process.

/** At most `max` hits per key per `windowMs` (sliding window). */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns 0, or returns the ms to wait (no hit recorded). */
  take(key: string): number {
    const t = this.now()
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs)
    if (recent.length >= this.max) {
      this.hits.set(key, recent)
      return this.windowMs - (t - recent[0]!)
    }
    recent.push(t)
    this.hits.set(key, recent)
    if (this.hits.size > 10_000) this.prune(t)
    return 0
  }

  private prune(t: number) {
    for (const [k, v] of this.hits) if (v.every((h) => t - h >= this.windowMs)) this.hits.delete(k)
  }
}

/** A counter that resets every UTC day. */
export class DailyCap {
  private day = ''
  private used = 0
  constructor(
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  private roll() {
    const d = new Date(this.now()).toISOString().slice(0, 10)
    if (d !== this.day) {
      this.day = d
      this.used = 0
    }
  }

  take(): boolean {
    this.roll()
    if (this.used >= this.max) return false
    this.used++
    return true
  }

  remaining(): number {
    this.roll()
    return this.max - this.used
  }
}

/** The client's IP: the first X-Forwarded-For hop when behind our own proxy (Caddy), else the socket. */
export function clientIp(headers: Headers, socketIp: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (xff) return xff
  }
  return socketIp ?? 'unknown'
}
