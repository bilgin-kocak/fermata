import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Challenge, Credential, Method, Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { McpClient } from 'mppx/mcp/client'
import { Client as McpSdkClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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
  async events(_: bigint) {
    return this.settled.map((x) => ({ event: x.outcome === 1 ? 'Released' : 'Refunded', callId: x.callId, serviceId: sid, blockNumber: 2n, txHash: keccak256(toHex(`settle-${x.callId}`)), args: {} })) as never
  }
  scoringLogs: import('@fermata/sdk').EscrowLog[] = []
  async escrowLogs(fromBlock: bigint) {
    return { logs: this.scoringLogs.filter((l) => l.blockNumber >= fromBlock), toBlock: 100n }
  }
  async movements(_: Address, callId: Hex) {
    const tx = keccak256(toHex('m'))
    const hold = { token, from: agent, to: escrow, amount: 10_000n, txHash: tx, blockNumber: 1n }
    const s = this.settled.find((x) => x.callId === callId)
    if (!s) return [hold]
    return s.outcome === 1
      ? [hold, { ...hold, from: escrow, to: vendor, amount: 9_950n }, { ...hold, from: escrow, to: signer, amount: 50n }]
      : [hold, { ...hold, from: escrow, to: agent, amount: 10_000n }]
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
  async reverify(input: { callId: Hex }) {
    return { presentationHash: keccak256(toHex(`presentation-${input.callId}`)), requestHash: null, originHash: originHash(upstream), notaryKeyHash: `0x${'55'.repeat(32)}`, predicateHash: `0x${'44'.repeat(32)}`, outcome: 'DELIVERED', callHeaderMatches: true } as never
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

/** The agent's `fermata` method: the "hold" is recorded in the fake chain. */
function holdMethod() {
  return Method.toClient(fermataMethod, {
    async createCredential({ challenge }) {
      const r = challenge.request
      const txHash = keccak256(toHex(`hold-${r.callId}`))
      chain.receipts.set(txHash, { callId: r.callId as Hex, serviceId: r.serviceId as Hex, requestHash: r.requestHash as Hex, amount: BigInt(r.amount) })
      chain.holds.set(r.callId!.toLowerCase(), { status: 1, deadline: 1_120n, agent, serviceId: r.serviceId as Hex, requestHash: r.requestHash as Hex })
      lastCredential = Credential.serialize({ challenge, payload: { type: 'hold', txHash, callId: r.callId! } })
      return lastCredential
    },
  })
}

/** An agent paying with `fermata` over HTTP. */
function agentFetch() {
  const m = Mppx.create({ methods: [holdMethod()], polyfill: false, fetch: ((url: string, init: RequestInit) => gw.app.request(url, init)) as never })
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

  it('reconciles a released call by memo and lists escrow events', async () => {
    attestor.next = (i) => verdict(i.callId, 1, { status: 200, body: '{}' })
    const callId = receiptOf(await agentFetch()(`/s/${sid}/v1/quote?symbol=BTC-USD`)).callId as Hex
    const rec = (await (await gw.app.request(`${BASE}/reconcile/${callId}`)).json()) as { match: boolean; movements: unknown[] }
    expect(rec.match).toBe(true)
    expect(rec.movements).toHaveLength(3)
    const events = (await (await gw.app.request(`${BASE}/events?since=0`)).json()) as { event: string; callId: string }[]
    expect(events).toEqual([expect.objectContaining({ event: 'Released', callId })])
    expect(await (await gw.app.request(`${BASE}/info`)).json()).toMatchObject({ chainId: 42431, escrow })
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

/** An MCP client on the gateway's /mcp endpoint; `pay` wraps it with the agent's `fermata` method. */
async function mcpClient(pay = true) {
  const client = new McpSdkClient({ name: 'test-agent', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: ((url: string, init: RequestInit) => gw.app.request(String(url), init)) as never }))
  return pay ? McpClient.wrap(client, { methods: [holdMethod()] }) : client
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean; _meta?: Record<string, any>; receipt?: Record<string, unknown> }

describe('gateway MCP endpoint', () => {
  it('lists every service as a paid tool plus the free fermata_* tools', async () => {
    const { tools } = await (await mcpClient(false)).listTools()
    expect(tools.map((t) => t.name)).toEqual(['call_quote', 'fermata_vendor_scores', 'fermata_call', 'fermata_verify', 'fermata_reconcile'])
    const quote = tools[0]!
    expect(quote.inputSchema).toMatchObject({ required: ['path'] })
    expect(quote.description).toContain('released to the vendor only if a TLSNotary proof')
  })

  it('a configured tool fills its path template and binds the challenge to that exact request', async () => {
    gw = await build({ services: [{ ...config().services[0]!, tool: { name: 'get_quote', path: '/v1/quote?symbol={symbol}' } }] })
    const client = await mcpClient(false)
    expect((await client.listTools()).tools[0]).toMatchObject({ name: 'get_quote', inputSchema: { required: ['symbol'] } })
    const err = await client.callTool({ name: 'get_quote', arguments: { symbol: 'ETH USD' } }).catch((e: unknown) => e as { code: number; data: { challenges: { method: string; request: Record<string, unknown> }[] } })
    expect((err as { code: number }).code).toBe(-32042)
    const challenge = (err as { data: { challenges: { method: string; request: Record<string, unknown> }[] } }).data.challenges[0]!
    expect(challenge.method).toBe('fermata')
    expect(challenge.request.requestHash).toBe(requestHash(sid, 'GET', '/v1/quote?symbol=ETH%20USD'))
    expect(chain.settled).toEqual([])
  })

  it('DELIVERED: the agent pays over MCP, the call is proved, released and the result carries the receipt', async () => {
    attestor.next = (i) => verdict(i.callId, 1, { status: 200, body: '{"price":1}' })
    const res = (await (await mcpClient()).callTool({ name: 'call_quote', arguments: { path: '/v1/quote?symbol=BTC-USD' } })) as unknown as ToolResult
    expect(res.isError).toBe(false)
    expect(res.content[0]!.text).toContain('{"price":1}')
    const call = res._meta!['org.fermata/call']
    expect(call).toMatchObject({ status: 'released', outcome: 'DELIVERED', vendorStatus: 200 })
    expect(res.receipt).toMatchObject({ method: 'fermata', status: 'success' })
    expect(chain.settled).toEqual([{ callId: call.callId, outcome: 1 }])
    expect(attestor.calls[0]!.url).toBe(`${upstream}/v1/quote?symbol=BTC-USD`)
    expect(attestor.calls[0]!.headers).toMatchObject({ authorization: 'Bearer vendor-secret' })
  })

  it('FAILED: a proven 500 comes back as a tool error and the agent is refunded', async () => {
    attestor.next = (i) => verdict(i.callId, 2, { status: 500, body: '{"error":"boom"}' })
    const res = (await (await mcpClient()).callTool({ name: 'call_quote', arguments: { path: '/v1/quote?symbol=BTC-USD' } })) as unknown as ToolResult
    expect(res.isError).toBe(true)
    expect(res.content[1]!.text).toContain('refunded to you')
    expect(res._meta!['org.fermata/call']).toMatchObject({ status: 'refunded', outcome: 'FAILED', vendorStatus: 500 })
    expect(chain.settled[0]?.outcome).toBe(2)
  })

  it('no transcript: no verdict, awaiting timeout, nothing settled', async () => {
    attestor.next = () => ({ kind: 'no-transcript', detail: 'vendor never answered' })
    const res = (await (await mcpClient()).callTool({ name: 'call_quote', arguments: { path: '/v1/quote?symbol=BTC-USD' } })) as unknown as ToolResult
    expect(res.isError).toBe(true)
    expect(res._meta!['org.fermata/call']).toMatchObject({ status: 'awaiting-timeout', outcome: null })
    expect(chain.settled).toEqual([])
  })

  it('a credential cannot be replayed for a second call', async () => {
    attestor.next = (i) => verdict(i.callId, 1, { status: 200, body: '{"price":1}' })
    await (await mcpClient()).callTool({ name: 'call_quote', arguments: { path: '/v1/quote?symbol=BTC-USD' } })
    const plain = await mcpClient(false)
    const replay = await plain
      .callTool({ name: 'call_quote', arguments: { path: '/v1/quote?symbol=BTC-USD' }, _meta: { 'org.paymentauth/credential': Credential.deserialize(lastCredential!) } })
      .catch((e: { code: number }) => e)
    expect((replay as { code: number }).code).toBeLessThan(0)
    expect(chain.settled).toHaveLength(1)
  })

  it('free tools: call record, offline re-verify and reconciliation by memo', async () => {
    attestor.next = (i) => verdict(i.callId, 1, { status: 200, body: '{"price":1}' })
    const client = await mcpClient()
    const paid = (await client.callTool({ name: 'call_quote', arguments: { path: '/v1/quote?symbol=BTC-USD' } })) as unknown as ToolResult
    const callId = paid._meta!['org.fermata/call'].callId
    const record = (await client.callTool({ name: 'fermata_call', arguments: { callId } })) as unknown as ToolResult & { structuredContent: Record<string, unknown> }
    expect(record.structuredContent).toMatchObject({ status: 'released' })
    const recon = (await client.callTool({ name: 'fermata_reconcile', arguments: { callId } })) as unknown as ToolResult & { structuredContent: Record<string, unknown> }
    expect(recon.structuredContent).toMatchObject({ match: true })
    const bad = (await client.callTool({ name: 'fermata_call', arguments: { callId: 'nope' } })) as unknown as ToolResult
    expect(bad.isError).toBe(true)
  })
})

describe('vendor scores', () => {
  it('GET /scores aggregates on-chain events, labels known services and states its caveats', async () => {
    const other = makeServiceId(agent, 'stranger')
    const held = (callId: Hex, svc: Hex, block: bigint) => ({ eventName: 'Held' as const, blockNumber: block, transactionHash: callId, args: { callId, serviceId: svc, agent, amount: 10_000n } })
    const c1 = keccak256(toHex('c1')), c2 = keccak256(toHex('c2')), c3 = keccak256(toHex('c3'))
    chain.scoringLogs = [
      held(c1, sid, 1n), { eventName: 'Released', blockNumber: 2n, transactionHash: c1, args: { callId: c1, serviceId: sid, amount: 10_000n, fee: 50n, presentationHash: c1 } },
      held(c2, sid, 3n), { eventName: 'Refunded', blockNumber: 4n, transactionHash: c2, args: { callId: c2, serviceId: sid, amount: 10_000n, presentationHash: `0x${'00'.repeat(32)}` } },
      held(c3, other, 5n),
    ]
    const body = (await (await gw.app.request(`${BASE}/scores`)).json()) as { scores: Record<string, unknown>[]; caveats: string[]; scannedTo: string }
    expect(body.scannedTo).toBe('100')
    expect(body.caveats.join(' ')).toContain('pay itself')
    const mine = body.scores.find((s) => s.serviceId === sid)!
    expect(mine).toMatchObject({ known: true, label: 'quote', upstream, released: 1, timeouts: 1, settled: 2, deliveryRate: 0.5, fewCalls: true, distinctAgents: 1 })
    expect(body.scores.find((s) => s.serviceId === other)).toMatchObject({ known: false, label: 'stranger', open: 1, deliveryRate: null })
  })

  it('MCP fermata_vendor_scores summarises the same numbers for an agent', async () => {
    const c1 = keccak256(toHex('m1'))
    chain.scoringLogs = [
      { eventName: 'Held', blockNumber: 1n, transactionHash: c1, args: { callId: c1, serviceId: sid, agent, amount: 10_000n } },
      { eventName: 'Released', blockNumber: 2n, transactionHash: c1, args: { callId: c1, serviceId: sid, amount: 10_000n, fee: 50n, presentationHash: c1 } },
    ]
    const res = (await (await mcpClient(false)).callTool({ name: 'fermata_vendor_scores', arguments: {} })) as unknown as ToolResult
    expect(res.content[0]!.text).toContain('call_quote: 1/1 delivered (100 %)')
  })
})


describe('addService (onboarding)', () => {
  it('serves, lists, exposes over MCP and persists a service registered while running', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs')
    const cfgPath = path.join(mkdtempSync(path.join(tmpdir(), 'fermata-cfg-')), 'gateway.config.json')
    writeFileSync(cfgPath, JSON.stringify({ escrow, services: config().services }))
    store = new CallStore(mkdtempSync(path.join(tmpdir(), 'fermata-gw-')))
    gw = await createGateway({
      config: { ...config(), storageDir: store.dir }, chain, publicClient: chain.publicClient(), attestor, store,
      secretKey: 'unit-test-secret-key-at-least-32-bytes!!', env: { VENDOR_TOKEN: 'Bearer vendor-secret' }, log: () => {}, configPath: cfgPath,
    })
    const npm = makeServiceId(vendor, 'npm-tags')
    chain.origin = originHash('https://registry.npmjs.org') // FakeChain reports this origin for every id
    await gw.addService({ serviceId: npm, upstream: 'https://registry.npmjs.org', examplePath: '/-/package/mppx/dist-tags', tool: { name: 'npm_latest_version', path: '/-/package/{package}/dist-tags' } })
    expect(((await (await gw.app.request(`${BASE}/services`)).json()) as { serviceId: string }[]).map((s) => s.serviceId)).toContain(npm)
    expect((await (await mcpClient(false)).listTools()).tools.map((t) => t.name)).toContain('npm_latest_version')
    const persisted = JSON.parse(readFileSync(cfgPath, 'utf8')) as { services: { serviceId: string }[] }
    expect(persisted.services.map((s) => s.serviceId)).toEqual([sid, npm])
    // the chain checks still apply: a wrong origin is refused
    await expect(gw.addService({ serviceId: npm, upstream: 'https://evil.example.com' })).rejects.toThrow('not the registered origin')
  })
})
