import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Hex } from 'viem'

/** Life of one paid call at the gateway. Final: released, refunded, timed-out, closed. */
export type CallStatus =
  | 'held' // hold verified, proving
  | 'released' // DELIVERED verdict settled: vendor paid
  | 'refunded' // FAILED verdict settled: agent refunded
  | 'settle-pending' // verdict signed, settle tx failed; retried while the window is open
  | 'awaiting-timeout' // no verdict (no transcript / binding check failed): only claimTimeout can end it
  | 'timed-out' // claimTimeout sent by the sweeper
  | 'closed' // finalised by someone else (e.g. the agent's own reclaim)

export type CallRecord = {
  callId: Hex
  serviceId: Hex
  method: string
  target: string
  requestHash: Hex
  holdTx: Hex
  agent?: Hex
  deadline: string // unix seconds (string: JSON-safe bigint)
  status: CallStatus
  outcome?: 'DELIVERED' | 'FAILED'
  failures?: string[]
  verdict?: unknown
  signature?: Hex
  presentationHash?: Hex
  settleTx?: Hex
  timeoutTx?: Hex
  proveMs?: number
  error?: string
  createdAt: string
  updatedAt: string
}

export const FINAL: readonly CallStatus[] = ['released', 'refunded', 'timed-out', 'closed']

/** One JSON file per call under `dir`, written atomically (temp file + rename). */
export class CallStore {
  constructor(readonly dir: string) {}

  private file(callId: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(callId)) throw new Error(`bad callId ${callId}`)
    return path.join(this.dir, `${callId.toLowerCase()}.json`)
  }

  async put(record: CallRecord): Promise<CallRecord> {
    await mkdir(this.dir, { recursive: true })
    const next = { ...record, updatedAt: new Date().toISOString() }
    const file = this.file(record.callId)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`)
    await rename(tmp, file)
    return next
  }

  async update(callId: Hex, patch: Partial<CallRecord>): Promise<CallRecord> {
    const current = await this.get(callId)
    if (!current) throw new Error(`no call ${callId}`)
    return this.put({ ...current, ...patch })
  }

  async get(callId: string): Promise<CallRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.file(callId), 'utf8'))
    } catch {
      return undefined
    }
  }

  async list(): Promise<CallRecord[]> {
    let names: string[] = []
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
    const records = await Promise.all(names.map((n) => this.get(n.slice(0, -5))))
    return records.filter((r): r is CallRecord => !!r).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
}
