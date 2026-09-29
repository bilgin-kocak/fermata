import type { CallStatus } from './api.ts'

export const short = (h?: string | null, n = 6) => (!h ? '—' : h.length <= 2 + 2 * n ? h : `${h.slice(0, 2 + n)}…${h.slice(-4)}`)

/** Token base units (6 decimals) → "0.0100". */
export const usd = (units: string | number | bigint, digits?: number) => {
  const v = Number(units) / 1e6
  return v.toFixed(digits ?? (v !== 0 && Math.abs(v) < 0.001 ? 6 : 4))
}

export const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)

export const bytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} B`)

export function age(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
}

/** serviceId = owner (20 bytes) ‖ 12-byte label; show the label when it is printable ASCII. */
export function serviceLabel(serviceId: string) {
  const hex = serviceId.slice(42).replace(/(00)+$/, '')
  const text = hex.match(/../g)?.map((b) => String.fromCharCode(parseInt(b, 16))).join('') ?? ''
  return /^[\x20-\x7e]+$/.test(text) ? text : short(serviceId)
}

/** Status → reserved status role + icon + label (never color alone). */
export const STATUS: Record<CallStatus, { role: 'good' | 'warning' | 'serious' | 'critical' | 'neutral'; icon: string; label: string }> = {
  held: { role: 'neutral', icon: '●', label: 'Held — proving' },
  released: { role: 'good', icon: '✓', label: 'Released' },
  refunded: { role: 'serious', icon: '↩', label: 'Refunded (verified failure)' },
  'settle-pending': { role: 'warning', icon: '⟳', label: 'Settle pending' },
  'awaiting-timeout': { role: 'warning', icon: '⏳', label: 'No proof — awaiting timeout' },
  'timed-out': { role: 'serious', icon: '⏱', label: 'Refunded (timeout)' },
  closed: { role: 'neutral', icon: '■', label: 'Closed' },
}
