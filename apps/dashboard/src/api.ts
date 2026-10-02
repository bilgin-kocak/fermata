export type Info = { chainId: number; escrow: string; explorer: string | null; services: number }

export type CallStatus = 'held' | 'released' | 'refunded' | 'settle-pending' | 'awaiting-timeout' | 'timed-out' | 'closed'

export type Call = {
  callId: string
  serviceId: string
  method: string
  target: string
  requestHash: string
  holdTx: string
  agent?: string
  deadline: string
  status: CallStatus
  outcome?: 'DELIVERED' | 'FAILED'
  failures?: string[]
  verdict?: Record<string, unknown>
  signature?: string
  signer?: string
  presentationHash?: string
  settleTx?: string
  timeoutTx?: string
  proveMs?: number
  notaryBytes?: { sent: number; received: number }
  error?: string
  createdAt: string
  updatedAt: string
}

export type EscrowEvent = { event: 'Held' | 'Released' | 'Refunded'; callId: string; serviceId: string; blockNumber: string; txHash: string; args: Record<string, string> }

export type Service = {
  serviceId: string
  endpoint: string
  upstream: string
  price: string
  token: string
  settlementWindow: number
  escrow: string
  unprotectedFallback: { amount: string; recipient: string } | null
}

export type VendorScore = {
  serviceId: string
  label: string | null
  known: boolean
  upstream: string | null
  summary: string | null
  tool: string | null
  held: number
  released: number
  provenFailures: number
  timeouts: number
  open: number
  settled: number
  deliveryRate: number | null
  score: number
  distinctAgents: number
  fewCalls: boolean
}
export type Scores = { escrow: string; chainId: number; scannedTo: string; method: string; recompute: string; caveats: string[]; scores: VendorScore[] }

export type DemoKind = { id: string; label: string; description: string; serviceId: string; path: string }
export type DemoStatus = { enabled: boolean; readOnly: string | null; busy: boolean; remainingToday: number; perIpSeconds: number; payer: string | null; kinds: DemoKind[] }
export type DemoResult = { kind: string; status?: number; callId?: string; outcome?: string | null; holdTx?: string; settleTx?: string | null; body?: string; error?: string; retryAfterMs?: number }

export type Movement = { token: string; from: string; to: string; amount: string; txHash: string; blockNumber: string }
export type Reconciliation = { callId: string; status: CallStatus; token: string; expected: string; match: boolean; movements: Movement[] }

export type Check = { name: string; recomputed: string | null; onchain: string | null; ok: boolean }
export type Reverify = {
  callId: string
  ok: boolean
  checks: Check[]
  transcript: { request: string; response: string }
  notaryKey: string
  sessionTime: number
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string; detail?: string }).detail ?? (body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

export const api = {
  info: () => json<Info>('/info'),
  calls: () => json<Call[]>('/calls'),
  events: () => json<EscrowEvent[]>('/events?since=0'),
  services: () => json<Service[]>('/services'),
  scores: () => json<Scores>('/scores'),
  demoStatus: () => fetch('/demo/status').then((r) => (r.ok ? (r.json() as Promise<DemoStatus>) : null)),
  demoCall: async (kind: string): Promise<DemoResult> => {
    const res = await fetch('/demo/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) })
    return { kind, ...((await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as object) } as DemoResult
  },
  reconcile: (callId: string) => json<Reconciliation>(`/reconcile/${callId}`),
  reverify: (callId: string) => json<Reverify>(`/proofs/${callId}/verify`, { method: 'POST' }),
  proofUrl: (callId: string) => `/proofs/${callId}`,
}
