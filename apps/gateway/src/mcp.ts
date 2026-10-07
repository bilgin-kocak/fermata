// MCP endpoint of the gateway (`POST /mcp`, Streamable HTTP, stateless). Every registered service is a
// paid MCP tool: a call without payment gets an MPP challenge for the `fermata` method (MCP error
// -32042, mppx's MCP transport); the agent holds the price in the escrow and retries with the
// credential in `_meta["org.paymentauth/credential"]`; the gateway then proves the vendor's answer
// with TLSNotary and settles exactly as on the HTTP route — release on DELIVERED, refund on FAILED,
// timeout refund when there is no transcript. Four free tools expose the vendor scores, the call
// record, the offline re-verification and the reconciliation by memo.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Hono } from 'hono'
import { Credential, Mcp } from 'mppx'
import { Mppx, Transport } from 'mppx/server'
import { requestHash } from 'fermata-sdk'
import type { Hex } from 'viem'
import type { CallRecord } from './store.ts'

export type ToolConfig = {
  /** MCP tool name, e.g. `get_quote`. */
  name: string
  description?: string
  /** Request target with `{param}` placeholders, e.g. `/v1/quote?symbol={symbol}`. Tool calls are GETs. */
  path: string
}

type McpService = { serviceId: Hex; price: bigint; token: Hex; window: number; summary?: string; tool?: ToolConfig; onboarded?: boolean }

/** Names a service may not take: the free tools, and the namespace they live in. */
export const isReservedToolName = (name: string) => name.startsWith('fermata_')

export type McpDeps = {
  app: Hono
  services: Map<string, McpService>
  escrow: Hex
  chainId: number
  explorer: string | null
  secretKey: string
  realm: string
  fermataHandler: unknown
  fulfil: (
    svc: never,
    req: { method: string; target: string; headers: Headers; body: Uint8Array },
    credential: { challenge: { request: unknown }; payload: unknown },
  ) => Promise<{ response: Response; record: CallRecord }>
  /** True while proving is saturated: new payers are turned away before they pay. */
  saturated?: () => boolean
}

/** The label packed into a serviceId (owner ‖ 12-byte label), when it is printable. */
export function serviceLabel(serviceId: Hex): string {
  const hex = serviceId.slice(42).replace(/(00)+$/, '')
  const text = Buffer.from(hex, 'hex').toString('latin1')
  return /^[\x20-\x7e]+$/.test(text) ? text : serviceId.slice(0, 10)
}

const params = (path: string) => [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)

/** The tool a service is exposed as. Default: `call_<label>` taking a raw request `path`. */
export function toolFor(svc: McpService): ToolConfig {
  if (svc.tool) return svc.tool
  return { name: `call_${serviceLabel(svc.serviceId).replace(/[^a-zA-Z0-9_]/g, '_')}`, path: '{path}' }
}

export function targetFor(tool: ToolConfig, args: Record<string, unknown>): string {
  const target = tool.path.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = args[k]
    if (typeof v !== 'string' || v === '') throw new Error(`missing argument "${k}"`)
    return tool.path === '{path}' ? v : encodeURIComponent(v)
  })
  if (!target.startsWith('/')) throw new Error('the request path must start with "/"')
  return target
}

const FREE_TOOLS: Tool[] = [
  {
    name: 'fermata_vendor_scores',
    description:
      "Free. Every vendor's proven delivery record, computed only from on-chain escrow events: calls released, refunded on a proven failure, refunded on timeout, distinct agents, and a score (Wilson 95 % lower bound of the delivery rate). Use it to pick the most reliable service before paying; each service lists its MCP tool name.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fermata_call',
    description: 'Free. The record of a Fermata call: status (held, released, refunded, awaiting-timeout, timed-out), outcome, transactions, proof hash.',
    inputSchema: { type: 'object', properties: { callId: { type: 'string', description: '0x… call id from a paid tool result' } }, required: ['callId'] },
  },
  {
    name: 'fermata_verify',
    description: "Free. Re-verifies a call's TLSNotary proof with the attestor's offline verifier (no signing key) and compares every hash with the chain. This runs on the gateway; to check without it, download /proofs/<callId> and run `fermata-attest verify --offline` yourself.",
    inputSchema: { type: 'object', properties: { callId: { type: 'string' } }, required: ['callId'] },
  },
  {
    name: 'fermata_reconcile',
    description: "Free. The call's TIP-20 movements on Tempo, found by memo = callId, checked against its outcome.",
    inputSchema: { type: 'object', properties: { callId: { type: 'string' } }, required: ['callId'] },
  },
]

const text = (t: string) => ({ type: 'text' as const, text: t })

export function mcpHandler(deps: McpDeps) {
  const pay = Mppx.create({
    secretKey: deps.secretKey,
    realm: deps.realm,
    methods: [deps.fermataHandler as never],
    transport: Transport.mcpSdk(),
  })
  // Computed per request: services onboarded while running appear at once. The first service to
  // claim a name keeps it (configured services load first), so a later listing can never take over
  // a tool agents already pay, and no service can shadow a free tool.
  const toolMap = () => {
    const tools = new Map<string, McpService>()
    for (const svc of deps.services.values()) {
      const name = toolFor(svc).name
      const current = tools.get(name)
      if (!isReservedToolName(name) && (!current || (current.onboarded && !svc.onboarded))) tools.set(name, svc)
    }
    return tools
  }
  const link = (tx?: string | null) => (tx && deps.explorer ? `${deps.explorer}/tx/${tx}` : tx ?? null)

  const listTools = (): Tool[] => [
    ...[...toolMap().entries()].map(([name, svc]) => {
      const tool = toolFor(svc)
      const names = params(tool.path)
      return {
        name,
        description: [
          // Vendor-written text reaches the agent's model: quote it and say whose words they are.
          svc.onboarded
            ? `Third-party API listed through self-serve onboarding. Its description, written by the vendor and not reviewed by Fermata: ${JSON.stringify(tool.description ?? svc.summary ?? '')}.`
            : (tool.description ?? svc.summary ?? `Paid call to service ${svc.serviceId}`),
          `Costs ${Number(svc.price) / 1e6} (TIP-20 ${svc.token}) per call, paid with the \`fermata\` MPP method: held in escrow on Tempo and released to the vendor only if a TLSNotary proof of its HTTPS answer passes the delivery check; refunded automatically on a proven failure, or after ${svc.window} s if there is no proof.`,
        ].filter(Boolean).join(' '),
        inputSchema: {
          type: 'object' as const,
          properties: Object.fromEntries(names.map((n) => [n, { type: 'string', description: n === 'path' ? 'request target, e.g. /v1/quote?symbol=BTC-USD' : n }])),
          required: names,
        },
        _meta: { 'org.fermata/serviceId': svc.serviceId },
      }
    }),
    ...FREE_TOOLS,
  ]

  async function freeTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name === 'fermata_vendor_scores') {
      const res = await deps.app.request('/scores')
      const body = (await res.json()) as { scores: { label: string | null; tool: string | null; released: number; settled: number; deliveryRate: number | null; score: number; provenFailures: number; timeouts: number; distinctAgents: number; fewCalls: boolean }[] }
      const lines = body.scores.map((s) => `${s.tool ?? s.label ?? '?'}: ${s.released}/${s.settled} delivered${s.deliveryRate === null ? '' : ` (${(s.deliveryRate * 100).toFixed(0)} %)`}, score ${(s.score * 100).toFixed(1)} %, ${s.provenFailures} proven failures, ${s.timeouts} timeouts, ${s.distinctAgents} agents${s.fewCalls ? ', few calls' : ''}`)
      return { content: [text(lines.join('\n') || 'no calls yet')], structuredContent: body as unknown as Record<string, unknown>, isError: !res.ok }
    }
    const callId = String(args.callId ?? '')
    if (!/^0x[0-9a-fA-F]{64}$/.test(callId)) return { content: [text('callId must be a 0x-prefixed 32-byte hex string')], isError: true }
    const route = name === 'fermata_call' ? `/calls/${callId}` : name === 'fermata_verify' ? `/proofs/${callId}/verify` : `/reconcile/${callId}`
    const res = await deps.app.request(route, { method: name === 'fermata_verify' ? 'POST' : 'GET' })
    const body = await res.json()
    return { content: [text(JSON.stringify(body, null, 2))], structuredContent: body as Record<string, unknown>, isError: !res.ok }
  }

  async function paidTool(svc: McpService, args: Record<string, unknown>, meta: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const target = targetFor(toolFor(svc), args)
    const body = new Uint8Array()
    const rh = requestHash(svc.serviceId, 'GET', target, body)
    if (!meta?.[Mcp.credentialMetaKey] && deps.saturated?.()) {
      return { content: [text('busy: other calls are being proved; nothing was charged, retry in a few seconds')], isError: true }
    }
    const offer = { amount: svc.price.toString(), currency: svc.token, escrow: deps.escrow, chainId: deps.chainId, serviceId: svc.serviceId, requestHash: rh }
    const r = await pay.compose([deps.fermataHandler, offer] as never)({ _meta: meta } as never)
    if (r.status === 402) throw r.challenge

    const raw = meta?.[Mcp.credentialMetaKey]
    if (!raw) throw new Error('paid without a credential')
    const credential = typeof raw === 'string' ? Credential.deserialize(raw) : Credential.deserialize(Credential.serialize(raw as never))
    const { response, record } = await deps.fulfil(svc as never, { method: 'GET', target, headers: new Headers({ accept: 'application/json' }), body }, credential)
    const vendorBody = await response.text()
    const settled =
      record.status === 'released' ? `DELIVERED → released to the vendor (settle tx ${link(record.settleTx)})`
      : record.status === 'refunded' ? `FAILED (${(record.failures ?? []).join('; ')}) → refunded to you (tx ${link(record.settleTx)})`
      : record.status === 'awaiting-timeout' ? `no proof (${record.error}) → no verdict; the hold is refunded after the settlement window (claimTimeout)`
      : `${record.outcome ?? 'no outcome'} → ${record.status}${record.error ? ` (${record.error})` : ''}`
    const fermata = {
      callId: record.callId,
      status: record.status,
      outcome: record.outcome ?? null,
      vendorStatus: response.status,
      holdTx: link(record.holdTx),
      settleTx: link(record.settleTx),
      presentationHash: record.presentationHash ?? null,
      proof: `/proofs/${record.callId}`,
    }
    const result: CallToolResult = {
      content: [
        text(`Vendor answered HTTP ${response.status}:\n${vendorBody}`),
        text(`Fermata call ${record.callId}: ${settled}. Re-verify the proof with fermata_verify.`),
      ],
      isError: record.status !== 'released',
      _meta: { 'org.fermata/call': fermata },
    }
    return r.withReceipt(result as never) as CallToolResult
  }

  return async (req: Request): Promise<Response> => {
    const server = new Server({ name: 'fermata-gateway', version: '0.1.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {}, _meta } = request.params
      if (FREE_TOOLS.some((t) => t.name === name)) return freeTool(name, args)
      const svc = toolMap().get(name)
      if (!svc) return { content: [text(`unknown tool ${name}`)], isError: true }
      return paidTool(svc, args, _meta as Record<string, unknown> | undefined)
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(req)
  }
}
