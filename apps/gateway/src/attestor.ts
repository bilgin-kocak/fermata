import type { Hex } from 'viem'

export type AttestInput = { callId: Hex; url: string; method: string; headers: Record<string, string>; body: string }

export type ProvedResponse = {
  status: number | null
  headers?: [string, string][]
  bodyBase64?: string
  rawBase64?: string
  error?: string
}

export type SignedVerdict = {
  verdict: Record<string, unknown> & { outcome: number }
  outcome: 'DELIVERED' | 'FAILED'
  failures: string[]
  signatureBytes: Hex
  signer: Hex
}

export type AttestResult =
  | { kind: 'verdict'; signed: SignedVerdict; presentationHash: Hex; response: ProvedResponse; proveMs?: number; notaryBytes?: { sent: number; received: number } }
  | { kind: 'no-transcript'; detail: string }
  | { kind: 'rejected'; check: string; detail: string }

export type Reverified = Record<string, unknown> & {
  presentationHash: Hex
  requestHash: Hex | null
  originHash: Hex
  notaryKeyHash: Hex
  predicateHash: Hex | null
  outcome: 'DELIVERED' | 'FAILED' | null
  callHeaderMatches: boolean
}

export interface Attestor {
  attest(input: AttestInput): Promise<AttestResult>
  /** Offline re-verification of the stored presentation (no key, no chain). */
  reverify(input: { callId: Hex; serviceId: Hex; predicateHash: Hex }): Promise<Reverified | { error: string; check?: string; detail?: string }>
  health(): Promise<{ signer: Hex; escrow: Hex; chainId: number }>
  presentation(callId: Hex): Promise<Uint8Array | undefined>
}

/** Client for `fermata-attest serve`. */
export class HttpAttestor implements Attestor {
  constructor(readonly baseUrl: string) {}

  async attest(input: AttestInput): Promise<AttestResult> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/attest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        // Proving is serialised in the attestor; past this the call is left to its timeout refund.
        signal: AbortSignal.timeout(Number(process.env.ATTEST_TIMEOUT_MS ?? 90_000)),
      })
    } catch (e) {
      return { kind: 'no-transcript', detail: `attestor unreachable: ${(e as Error).message}` }
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, any>
    if (res.status === 200 && json.verdict) {
      return { kind: 'verdict', signed: json.verdict, presentationHash: json.presentationHash, response: json.response ?? { status: null }, proveMs: json.prove?.proveMs, notaryBytes: json.prove?.notaryBytes }
    }
    if (res.status === 422) return { kind: 'rejected', check: String(json.check), detail: String(json.detail) }
    return { kind: 'no-transcript', detail: String(json.detail ?? json.error ?? `attestor HTTP ${res.status}`) }
  }

  async reverify(input: { callId: Hex; serviceId: Hex; predicateHash: Hex }) {
    const res = await fetch(`${this.baseUrl}/v1/reverify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    return (await res.json()) as Reverified | { error: string }
  }

  async health() {
    const res = await fetch(`${this.baseUrl}/healthz`)
    if (!res.ok) throw new Error(`attestor /healthz HTTP ${res.status}`)
    return (await res.json()) as { signer: Hex; escrow: Hex; chainId: number }
  }

  async presentation(callId: Hex) {
    const res = await fetch(`${this.baseUrl}/v1/presentations/${callId}`)
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined
  }
}
