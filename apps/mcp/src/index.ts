#!/usr/bin/env -S npx tsx
// fermata-mcp: Fermata for MCP agents. A local stdio MCP server (what Claude Code / Claude Desktop
// launch) that connects to a Fermata gateway's MCP endpoint and re-exposes its tools. Paid tools are
// paid with the agent's own testnet wallet through the `fermata` MPP method (mppx McpClient): the
// price is held in the escrow on Tempo, released to the vendor only if a TLSNotary proof of its HTTPS
// answer passes the delivery check, refunded on a proven failure or after the window without proof.
//
// Env (testnet only — the key is a Tempo Moderato / Anvil key, never a mainnet key):
//   FERMATA_GATEWAY            gateway base URL                     (default http://127.0.0.1:4300)
//   FERMATA_AGENT_KEY          agent private key (0x…)              (required)
//   TEMPO_RPC_URL              RPC                                  (default https://rpc.moderato.tempo.xyz)
//   FERMATA_ESCROW             escrow(s) the agent trusts, comma-separated (default: deployments.json, FERMATA_NETWORK)
//   FERMATA_NETWORK            anvil | moderato                     (default moderato)
//   FERMATA_TRUSTED_VERIFIERS  verifier address(es) the agent trusts (required; never taken from the gateway)
//   FERMATA_MAX_PRICE          max price per call, base units       (default 100000 = 0.10)
//   FERMATA_BUDGET             max total held per session           (default 1000000 = 1.00)
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpClient } from 'mppx/mcp/client'
import { createPublicClient, createWalletClient, getAddress, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { escrowDeployment, fermata, tempoChain, tip20Abi, TOKENS, type EscrowNetwork } from '@fermata/sdk'

const log = (m: string) => process.stderr.write(`[fermata-mcp] ${m}\n`) // stdout is the MCP channel
const env = (k: string, d?: string) => process.env[k] || d
const required = (k: string) => env(k) ?? (log(`${k} is not set`), process.exit(2))
const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean).map((a) => getAddress(a))

export type BridgeConfig = {
  gateway: string
  agentKey: Hex
  rpc: string
  escrows: Address[]
  trustedVerifiers: Address[]
  maxPrice: bigint
  budget: bigint
}

export function configFromEnv(): BridgeConfig {
  const network = (env('FERMATA_NETWORK', 'moderato') as EscrowNetwork)
  const escrows = env('FERMATA_ESCROW') ?? escrowDeployment(network)?.address
  if (!escrows) throw new Error(`no escrow: set FERMATA_ESCROW (no ${network} deployment in deployments.json)`)
  return {
    gateway: env('FERMATA_GATEWAY', 'http://127.0.0.1:4300')!.replace(/\/$/, ''),
    agentKey: required('FERMATA_AGENT_KEY') as Hex,
    rpc: env('TEMPO_RPC_URL', 'https://rpc.moderato.tempo.xyz')!,
    escrows: list(escrows),
    trustedVerifiers: list(required('FERMATA_TRUSTED_VERIFIERS')),
    maxPrice: BigInt(env('FERMATA_MAX_PRICE', '100000')!),
    budget: BigInt(env('FERMATA_BUDGET', '1000000')!),
  }
}

const text = (t: string) => ({ type: 'text' as const, text: t })

/** Connects to the gateway and returns an MCP server (not yet connected to a transport). */
export async function createBridge(cfg: BridgeConfig) {
  const chain = tempoChain(cfg.rpc)
  const client = createPublicClient({ chain, transport: http(cfg.rpc) })
  const account = privateKeyToAccount(cfg.agentKey)
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpc) })
  let held = 0n
  let calls = 0

  const upstream = new Client({ name: 'fermata-mcp', version: '0.1.0' })
  await upstream.connect(new StreamableHTTPClientTransport(new URL(`${cfg.gateway}/mcp`)))
  const paying = McpClient.wrap(upstream, {
    methods: [fermata({ wallet: wallet as never, client: client as never, trustedVerifiers: cfg.trustedVerifiers, escrows: cfg.escrows })],
    // Spending guard: a per-call cap and a per-session budget, checked before any money moves.
    onPaymentRequired: (challenge) => {
      const amount = BigInt((challenge.request as { amount: string }).amount)
      if (challenge.method !== 'fermata') return false
      if (amount > cfg.maxPrice || held + amount > cfg.budget) {
        log(`declined ${challenge.method} payment of ${amount} (cap ${cfg.maxPrice}, held ${held}/${cfg.budget})`)
        return false
      }
      held += amount
      calls++
      return true
    },
  })

  const server = new Server({ name: 'fermata', version: '0.1.0' }, {
    capabilities: { tools: {} },
    instructions:
      'Tools marked as paid cost a small testnet stablecoin amount per call, paid with Fermata: the money is held in escrow on Tempo and only released to the vendor if a TLSNotary proof shows the vendor really delivered; a proven failure or no answer is refunded to you automatically. Before paying, fermata_vendor_scores shows each vendor's proven delivery record (from on-chain events) so you can pick a reliable one. Each paid result names its callId; fermata_verify re-checks the proof offline, fermata_reconcile shows the on-chain movements.',
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await upstream.listTools()
    return {
      tools: [
        ...tools,
        {
          name: 'fermata_wallet',
          description: "Free. The agent's testnet wallet: address, pathUSD balance, and what this session has held so far against its budget.",
          inputSchema: { type: 'object' as const, properties: {} },
        },
      ],
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params
    if (name === 'fermata_wallet') {
      const balance = await client.readContract({ address: TOKENS.pathUSD as Address, abi: tip20Abi, functionName: 'balanceOf', args: [account.address] })
      const info = { address: account.address, pathUSD: Number(balance) / 1e6, paidCallsThisSession: calls, heldThisSession: Number(held) / 1e6, budget: Number(cfg.budget) / 1e6, maxPricePerCall: Number(cfg.maxPrice) / 1e6 }
      return { content: [text(JSON.stringify(info, null, 2))], structuredContent: info }
    }
    try {
      const result = (await paying.callTool({ name, arguments: args })) as CallToolResult & { receipt?: { reference?: string } }
      const call = (result._meta?.['org.fermata/call'] ?? undefined) as { callId: string; status: string } | undefined
      if (call) log(`${name}: call ${call.callId.slice(0, 10)} ${call.status}`)
      const { receipt: _receipt, ...rest } = result
      return rest as CallToolResult
    } catch (e) {
      const err = e as { code?: number; message?: string }
      const why = err.code === -32042 ? 'payment declined by the spending guard (FERMATA_MAX_PRICE / FERMATA_BUDGET) or the payment method' : err.message
      return { content: [text(`Fermata: ${why}`)], isError: true }
    }
  })

  return { server, upstream, account }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fermata-mcp')) {
  const cfg = configFromEnv()
  const { server, account } = await createBridge(cfg)
  await server.connect(new StdioServerTransport())
  log(`ready: gateway ${cfg.gateway}, agent ${account.address}, cap ${cfg.maxPrice}/call, budget ${cfg.budget}`)
}
