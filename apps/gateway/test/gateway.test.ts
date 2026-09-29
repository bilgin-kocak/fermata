import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Challenge, Credential, Method, Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Address, type Hex } from 'viem'
import { fermataEscrowAbi, fermataMethod, originHash, requestHash, serviceId as makeServiceId } from '@fermata/sdk'
import { createGateway } from '../src/app.ts'
import type { AttestInput, AttestResult, Attestor } from '../src/attestor.ts'
import type { GatewayChain, TxResult } from '../src/chain.ts'
import type { GatewayConfig } from '../src/config.ts'
import { CallStore } from '../src/store.ts'

const escrow = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address
const token = '0x20C0000000000000000000000000000000000000' as Address
const signer = '0x00000000000000000000000000000000000051a9' as Address
const vendor = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const agent = '0x000000000000000000000000000000000000a9e1' as Address
const sid = makeServiceId(vendor, 'quote')
const upstream = 'https://vendor.fermata.test:8443'
const BASE = 'http://gw.test'

type Hold = { status: number; deadline: bigint; agent: Address; serviceId: Hex; requestHash: Hex }

class FakeChain implements GatewayChain {
  chainId = 42431
  escrow = escrow
  holds = new Map<string, Hold>()
  receipts = new Map<string, { callId: Hex; serviceId: Hex; requestHash: Hex; amount: bigint }>()
  settled: { callId: Hex; outcome: number }[] = []
  timeouts: Hex[] = []
  settleFails = 0
  time = 1_000n
  verifier = signer
  origin = originHash(upstream)

  async service(_: Hex) {
    return { owner: vendor, settlementWindow: 120, payout: vendor, token, verifier: this.verifier, pricePerCall: 10_000n, predicateHash: `0x${'44'.repeat(32)}` as Hex, originHash: this.origin, notaryKeyHash: `0x${'55'.repeat(32)}` as Hex }
  }
  async hold(callId: Hex) {
    const h = this.holds.get(callId.toLowerCase())
    return { agent: h?.agent ?? agent, serviceId: h?.serviceId ?? sid, requestHash: h?.requestHash ?? (`0x${'00'.repeat(32)}` as Hex), amount: 10_000n, heldAt: 900n, deadline: h?.deadline ?? 0n, feeBps: 50, status: h?.status ?? 0 }
  }
  async now() {
    return this.time
  }
  async settle(callId: Hex, verdict: { outcome: number }): Promise<TxResult> {
    if (this.settleFails > 0) {
      this.settleFails--
      return { ok: false, error: 'RecipientBlocked' }
    }
    this.settled.push({ callId, outcome: verdict.outcome })
    this.holds.get(callId.toLowerCase())!.status = verdict.outcome === 1 ? 2 : 3
    return { ok: true, txHash: keccak256(toHex(`settle-${callId}`)) }
  }
  async claimTimeout(callId: Hex): Promise<TxResult> {
    this.timeouts.push(callId)
    this.holds.get(callId.toLowerCase())!.status = 4
    return { ok: true, txHash: keccak256(toHex(`timeout-${callId}`)) }
  }
  /** What the `fermata` method reads to validate a credential. */
  publicClient() {
    return {
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const h = this.receipts.get(hash)
        if (!h) throw new Error('not found')
        const topics = encodeEventTopics({ abi: fermataEscrowAbi, eventName: 'Held', args: { callId: h.callId, serviceId: h.serviceId, agent } })
        const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [h.amount, h.requestHash])
        return { status: 'success', transactionHash: hash, logs: [{ address: escrow, topics, data, blockNumber: 1n, logIndex: 0, transactionHash: hash, transactionIndex: 0, blockHash: hash, removed: false }] }
      },
      readContract: async ({ args }: { args: [Hex] }) => this.hold(args[0]),
    } as never
  }
}

class FakeAttestor implements Attestor {
  calls: AttestInput[] = []
  next: (input: AttestInput) => AttestResult = () => ({ kind: 'no-transcript', detail: 'unset' })
  async attest(input: AttestInput) {
    this.calls.push(input)
    return this.next(input)
  }
  async health() {
    return { signer, escrow, chainId: 42431 }
  }
  async presentation(callId: Hex) {
    return callId.startsWith('0x') ? new Uint8Array([1, 2, 3]) : undefined
  }
}

const verdict = (callId: Hex, outcome: 1 | 2, response: { status: number; body: string }): AttestResult => ({
  kind: 'verdict',
  presentationHash: keccak256(toHex(`presentation-${callId}`)),
  proveMs: 1234,
  signed: {
    verdict: { call_id: callId, service_id: sid, request_hash: `0x${'33'.repeat(32)}`, predicate_hash: `0x${'44'.repeat(32)}`, outcome, presentation_hash: keccak256(toHex(`presentation-${callId}`)), response_hash: `0x${'66'.repeat(32)}`, issued_at: 1000 },
    outcome: outcome === 1 ? 'DELIVERED' : 'FAILED',
    failures: outcome === 1 ? [] : ['status 500 not in [200]'],
    signatureBytes: `0x${'ab'.repeat(65)}`,
    signer,
  },
  response: {
    status: response.status,
    headers: [['content-type', 'application/json'], ['content-length', String(response.body.length)], ['connection', 'close']],
    bodyBase64: Buffer.from(response.body).toString('base64'),
  },
})

let chain: FakeChain
let attestor: FakeAttestor
let store: CallStore
let gw: Awaited<ReturnType<typeof createGateway>>
let lastCredential: string | undefined

const config = (over: Partial<GatewayConfig> = {}): GatewayConfig => ({
  port: 0, host: '127.0.0.1', realm: 'gw.test', rpc: 'http://unused', escrow, attestorUrl: 'http://unused',
  storageDir: '', sweepIntervalMs: 1000,
  services: [{ serviceId: sid, upstream, examplePath: '/v1/quote?symbol=BTC-USD', upstreamAuth: { header: 'Authorization', env: 'VENDOR_TOKEN' }, tempo: { amount: '0.01', recipient: vendor } }],
  ...over,
})

async function build(over: Partial<GatewayConfig> = {}) {
  store = new CallStore(mkdtempSync(path.join(tmpdir(), 'fermata-gw-')))
  return createGateway({
    config: { ...config(over), storageDir: store.dir }, chain, publicClient: chain.publicClient(), attestor, store,
    secretKey: 'unit-test-secret-key-at-least-32-bytes!!', env: { VENDOR_TOKEN: 'Bearer vendor-secret' }, log: () => {},
  })
}

/** An agent paying with `fermata`: the "hold" is recorded in the fake chain. */
function agentFetch() {
  const holdClient = Method.toClient(fermataMethod, {
    async createCredential({ challenge }) {
      const r = challenge.request
      const txHash = keccak256(toHex(`hold-${r.callId}`))
      chain.receipts.set(txHash, { callId: r.callId as Hex, serviceId: r.serviceId as Hex, requestHash: r.requestHash as Hex, amount: BigInt(r.amount) })
      chain.holds.set(r.callId!.toLowerCase(), { status: 1, deadline: 1_120n, agent, serviceId: r.serviceId as Hex, requestHash: r.requestHash as Hex })
      lastCredential = Credential.serialize({ challenge, payload: { type: 'hold', txHash, callId: r.callId! } })
      return lastCredential
    },
  })
  const m = Mppx.create({ methods: [holdClient], polyfill: false, fetch: ((url: string, init: RequestInit) => gw.app.request(url, init)) as never })
  return (p: string, init?: RequestInit) => m.fetch(`${BASE}${p}`, init)
}

const receiptOf = (res: Response) => Receipt.fromResponse(res) as Receipt.Receipt & Record<string, unknown>

beforeEach(async () => {
  chain = new FakeChain()
  attestor = new FakeAttestor()
  gw = await build()
})

describe('gateway', () => {
  it('answers 402 with a fermata offer bound to this exact request, plus the unprotected tempo fallback', async () => {
    const res = await gw.app.request(`${BASE}/s/${sid}/v1/quote?symbol=BTC-USD`)
    expect(res.status).toBe(402)
    const challenges = Challenge.fromResponseList(res)
    expect(challenges.map((c) => c.method).sort()).toEqual(['fermata', 'tempo'])
    const f = challenges.find((c) => c.method === 'fermata')!.request as Record<string, unknown>
    expect(f.requestHash).toBe(requestHash(sid, 'GET', '/v1/quote?symbol=BTC-USD'))
    expect(f).toMatchObject({ amount: '10000', currency: token, escrow, chainId: 42431, serviceId: sid })
    expect(f.callId).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('DELIVERED: proves, settles, returns the proved response and a receipt with the settle tx', async () => {
    attestor.next = (i) => verdict(i.callId, 1, { status: 200, body: '{"price":1}' })
    const res = await agentFetch()(`/s/${sid}/v1/quote?symbol=BTC-USD`, { headers: { accept: 'application/json', authorization: 'agent-secret' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ price: 1 })
    const r = receiptOf(res)
    expect(r).toMatchObject({ method: 'fermata', status: 'success', outcome: 'DELIVERED' })
    expect(r.txHash).toBe(keccak256(toHex(`settle-${r.callId}`)))
    expect(chain.settled).toEqual([{ callId: r.callId, outcome: 1 }])
    const call = attestor.calls[0]!
    expect(call.url).toBe(`${upstream}/v1/quote?symbol=BTC-USD`)
    expect(call.headers).toEqual({ accept: 'application/json', authorization: 'Bearer vendor-secret' })
    expect((await store.get(r.callId as string))?.status).toBe('released')
    expect(await (await gw.app.request(`${BASE}/calls/${r.callId}`)).json()).toMatchObject({ status: 'released', outcome: 'DELIVERED' })
  })

  it('FAILED: returns the proved 500 and refunds', async () => {
    attestor.next = (i) => verdict(i.callId, 2, { status: 500, body: '{"error":"boom"}' })
    const res = await agentFetch()(`/s/${sid}/v1/quote?symbol=BTC-USD`)
    expect(res.status).toBe(500)
    const r = receiptOf(res)
    expect(r.outcome).toBe('FAILED')
    expect(chain.settled[0]?.outcome).toBe(2)
    expect((await store.get(r.callId as string))?.status).toBe('refunded')
  })

  it('no transcript: never settles, 504, then the sweeper refunds after the window', async () => {
    attestor.next = () => ({ kind: 'no-transcript', detail: 'vendor never answered' })
    const res = await agentFetch()(`/s/${sid}/v1/quote?symbol=BTC-USD`)
    expect(res.status).toBe(504)
    const r = receiptOf(res)
    expect(r.outcome).toBe('AWAITING_TIMEOUT')
    expect(chain.settled).toEqual([])
    expect(await gw.sweep()).toEqual([]) // window still open
    chain.time = 1_121n
    expect(await gw.sweep()).toEqual([r.callId])
    expect((await store.get(r.callId as string))?.status).toBe('timed-out')
  })

  it('binding check failed: 502, awaiting timeout, no verdict', async () => {
    attestor.next = () => ({ kind: 'rejected', check: 'origin', detail: 'wrong server' })
    const res = await agentFetch()(`/s/${sid}/v1/quote?symbol=BTC-USD`)
    expect(res.status).toBe(502)
    expect(chain.settled).toEqual([])
    expect((await store.get(receiptOf(res).callId as string))?.status).toBe('awaiting-timeout')
  })

  it('a failed settle stays pending and the sweeper retries it inside the window', async () => {
    chain.settleFails = 1
    attestor.next = (i) => verdict(i.callId, 1, { status: 200, body: '{}' })
    const res = await agentFetch()(`/s/${sid}/v1/quote?symbol=BTC-USD`)
    const callId = receiptOf(res).callId as Hex
    expect((await store.get(callId))?.status).toBe('settle-pending')
    await gw.sweep()
    expect((await store.get(callId))?.status).toBe('released')
  })

  it('refuses a replayed credential and a credential reused on another request', async () => {
    attestor.next = (i) => verdict(i.callId, 1, { status: 200, body: '{}' })
    const pay = agentFetch()
    await pay(`/s/${sid}/v1/quote?symbol=BTC-USD`)
    const cred = lastCredential!
    const replay = await gw.app.request(`${BASE}/s/${sid}/v1/quote?symbol=BTC-USD`, { headers: { authorization: cred } })
    expect(replay.status).toBe(402)
    expect(attestor.calls).toHaveLength(1)
  })

  it('binds an unused credential to the request it was issued for', async () => {
    attestor.next = (i) => verdict(i.callId, 1, { status: 200, body: '{}' })
    agentFetch() // installs the paying client
    const holdClient = Method.toClient(fermataMethod, {
      async createCredential({ challenge }) {
        const r = challenge.request
        const txHash = keccak256(toHex(`hold-${r.callId}`))
        chain.receipts.set(txHash, { callId: r.callId as Hex, serviceId: r.serviceId as Hex, requestHash: r.requestHash as Hex, amount: BigInt(r.amount) })
        chain.holds.set(r.callId!.toLowerCase(), { status: 1, deadline: 1_120n, agent, serviceId: r.serviceId as Hex, requestHash: r.requestHash as Hex })
        return Credential.serialize({ challenge, payload: { type: 'hold', txHash, callId: r.callId! } })
      },
    })
    const m = Mppx.create({ methods: [holdClient], polyfill: false })
    const c402 = await gw.app.request(`${BASE}/s/${sid}/v1/quote?symbol=BTC-USD`, { headers: { 'accept-payment': 'fermata/charge' } })
    const cred = (await m.createCredential(c402))!
    const other = await gw.app.request(`${BASE}/s/${sid}/v1/quote?symbol=ETH-USD`, { headers: { authorization: cred } })
    expect(other.status).toBe(402) // another requestHash: rejected before any proving
    expect(attestor.calls).toHaveLength(0)
    const own = await gw.app.request(`${BASE}/s/${sid}/v1/quote?symbol=BTC-USD`, { headers: { authorization: cred } })
    expect(own.status).toBe(200)
  })

  it('refuses to start when the on-chain verifier or origin does not match', async () => {
    chain.verifier = agent
    await expect(build()).rejects.toThrow(/not this attestor/)
    chain.verifier = signer
    chain.origin = originHash('https://evil.example')
    await expect(build()).rejects.toThrow(/not the registered origin/)
  })

  it('serves services, proofs, discovery', async () => {
    expect(await (await gw.app.request(`${BASE}/services`)).json()).toMatchObject([{ serviceId: sid, price: '10000', endpoint: `/s/${sid}` }])
    const proof = await gw.app.request(`${BASE}/proofs/0x${'11'.repeat(32)}`)
    expect(new Uint8Array(await proof.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect((await gw.app.request(`${BASE}/openapi.json`)).status).toBe(200)
    expect(await (await gw.app.request(`${BASE}/llms.txt`)).text()).toContain(`/s/${sid}`)
    expect((await gw.app.request(`${BASE}/s/0x${'99'.repeat(32)}/x`)).status).toBe(404)
  })
})
