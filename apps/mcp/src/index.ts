#!/usr/bin/env node
// fermata-mcp: Fermata for MCP agents. A local stdio MCP server (what Claude Code / Claude Desktop
// launch) that connects to a Fermata gateway's MCP endpoint and re-exposes its tools. Paid tools are
// paid with the agent's own testnet wallet through the `fermata` MPP method (mppx McpClient): the
// price is held in the escrow on Tempo, released to the vendor only if a TLSNotary proof of its HTTPS
// answer passes the delivery check, refunded on a proven failure or after the window without proof.
//
// With no settings at all (`npx -y fermata-mcp`) it pays the public live demo on Tempo Moderato
// testnet from a testnet wallet it creates and funds itself.
//
// Env (testnet only — the key is a Tempo Moderato / Anvil key, never a mainnet key):
//   FERMATA_GATEWAY            gateway base URL                     (default: the live demo)
//   FERMATA_AGENT_KEY          agent private key (0x…)              (default: a testnet wallet in
//                              ~/.fermata/agent-key, created once and funded from the Moderato faucet)
//   TEMPO_RPC_URL              RPC                                  (default https://rpc.moderato.tempo.xyz)
//   FERMATA_ESCROW             escrow(s) the agent trusts, comma-separated (default: deployments.json, FERMATA_NETWORK)
//   FERMATA_NETWORK            anvil | moderato                     (default moderato)
//   FERMATA_TRUSTED_VERIFIERS  verifier address(es) the agent trusts (never taken from a gateway; default:
//                              the live demo's verifier, and only when the gateway is the live demo)
//   FERMATA_MAX_PRICE          max price per call, base units       (default 100000 = 0.10)
//   FERMATA_BUDGET             max total held per session           (default 1000000 = 1.00)
//   FERMATA_MAX_WINDOW         longest settlement window accepted, seconds (default 3600)
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpClient } from 'mppx/mcp/client'
import { createPublicClient, createWalletClient, getAddress, http, isAddressEqual, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { escrowDeployment, fermata, getHold, HoldStatus, reclaim, tempoChain, tip20Abi, TOKENS, type EscrowNetwork } from 'fermata-sdk'
import pkg from '../package.json' with { type: 'json' }

const log = (m: string) => process.stderr.write(`[fermata-mcp] ${m}\n`) // stdout is the MCP channel
const env = (k: string, d?: string) => process.env[k] || d
const required = (k: string) => env(k) ?? (log(`${k} is not set`), process.exit(2))
const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean).map((a) => getAddress(a))

/** The public live demo on Tempo Moderato: the default gateway, and the verifier pinned for it. */
export const LIVE_DEMO = {
  gateway: 'https://fermata-production-9378.up.railway.app',
  verifier: '0xb8718ad26e9ae0058b8b1a369295b374d99af599' as Address,
}
const MODERATO_CHAIN_ID = 42431

export type BridgeConfig = {
  gateway: string
  /** Absent: a testnet wallet is created (see testnetAgentKey). */
  agentKey?: Hex
  rpc: string
  escrows: Address[]
  trustedVerifiers: Address[]
  maxPrice: bigint
  budget: bigint
  /** Longest settlement window accepted, in seconds. */
  maxWindow: number
}

export function configFromEnv(): BridgeConfig {
  const network = (env('FERMATA_NETWORK', 'moderato') as EscrowNetwork)
  const escrows = env('FERMATA_ESCROW') ?? escrowDeployment(network)?.address
  if (!escrows) throw new Error(`no escrow: set FERMATA_ESCROW (no ${network} deployment in deployments.json)`)
  const gateway = env('FERMATA_GATEWAY', LIVE_DEMO.gateway)!.replace(/\/$/, '')
  // The verifier the agent trusts is never taken from a gateway: it is configured, or pinned here for
  // the live demo only.
  const verifiers = env('FERMATA_TRUSTED_VERIFIERS') ?? (gateway === LIVE_DEMO.gateway ? LIVE_DEMO.verifier : required('FERMATA_TRUSTED_VERIFIERS'))
  return {
    gateway,
    agentKey: env('FERMATA_AGENT_KEY') as Hex | undefined,
    rpc: env('TEMPO_RPC_URL', 'https://rpc.moderato.tempo.xyz')!,
    escrows: list(escrows),
    trustedVerifiers: list(verifiers),
    maxPrice: BigInt(env('FERMATA_MAX_PRICE', '100000')!),
    budget: BigInt(env('FERMATA_BUDGET', '1000000')!),
    maxWindow: Number(env('FERMATA_MAX_WINDOW', '3600')),
  }
}

const text = (t: string) => ({ type: 'text' as const, text: t })
/** How long a paid call may take, from the payment to the vendor's proven answer (proving and settling included). */
const PAID_CALL_TIMEOUT_MS = 180_000
/** One tool call's holds and decline reason: AsyncLocalStorage follows the call through mppx's payment flow. */
type PaidCall = { holds: { callId: Hex; holdTx: Hex }[]; declined?: string }
const paidCall = new AsyncLocalStorage<PaidCall>()

/**
 * No FERMATA_AGENT_KEY: a testnet wallet kept in ~/.fermata/agent-key (created once, readable only by
 * you) and topped up from the Tempo Moderato faucet when it runs low. Refused on any other chain: an
 * auto-created key must never hold real funds.
 */
export async function testnetAgentKey(rpc: string, file = path.join(homedir(), '.fermata', 'agent-key')): Promise<Hex> {
  const client = createPublicClient({ chain: tempoChain(rpc), transport: http(rpc) })
  const chainId = await client.getChainId()
  if (chainId !== MODERATO_CHAIN_ID) {
    throw new Error(`FERMATA_AGENT_KEY is not set, and a wallet is only created automatically on Tempo Moderato testnet (chain ${MODERATO_CHAIN_ID}; this RPC is chain ${chainId})`)
  }
  let key: Hex
  if (existsSync(file)) {
    key = readFileSync(file, 'utf8').trim() as Hex
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${file} does not hold a private key (0x and 64 hex characters): fix or delete it`)
  }
  else {
    key = generatePrivateKey()
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${key}\n`, { mode: 0o600 })
    log(`created a testnet wallet in ${file}`)
  }
  const address = privateKeyToAccount(key).address
  const balance = await client.readContract({ address: TOKENS.pathUSD as Address, abi: tip20Abi, functionName: 'balanceOf', args: [address] })
  if (balance < 1_000_000n) {
    log(`funding ${address} from the Moderato testnet faucet`)
    try {
      const hashes = (await client.request({ method: 'tempo_fundAddress' as never, params: [address] as never })) as Hex[]
      if (hashes[0]) await client.waitForTransactionReceipt({ hash: hashes[0], timeout: 60_000 })
    } catch (e) {
      log(`the faucet failed (${(e as Error).message}); paid calls will fail until ${address} holds testnet pathUSD`)
    }
  }
  return key
}

/**
 * Returns the MCP server (not yet connected to a transport) and `ready`. The wallet (see
 * testnetAgentKey) and the gateway connection are set up in parallel in the background, so the MCP
 * handshake is answered at once: MCP clients give up on a slow start (Claude Code after 30 s).
 * `tools/list` waits for the gateway only; a paid call waits for both.
 */
export function createBridge(cfg: BridgeConfig) {
  const chain = tempoChain(cfg.rpc)
  const client = createPublicClient({ chain, transport: http(cfg.rpc) })
  let held = 0n
  let calls = 0
  // Error text goes back to the model: keep an RPC URL's path and query (an API key?) out of it.
  const rpcOrigin = new URL(cfg.rpc).origin
  const explain = (e: unknown) => {
    const m = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)
    return cfg.rpc === rpcOrigin ? m : m.split(cfg.rpc).join(`${rpcOrigin}/…`)
  }

  const upstream = new Client({ name: 'fermata-mcp', version: pkg.version })
  const connected = upstream.connect(new StreamableHTTPClientTransport(new URL(`${cfg.gateway}/mcp`))).catch((e: Error) => {
    throw new Error(`cannot reach the Fermata gateway at ${cfg.gateway}/mcp (${e.message})`)
  })
  const agent = (cfg.agentKey ? Promise.resolve(cfg.agentKey) : testnetAgentKey(cfg.rpc)).then((key) => {
    const account = privateKeyToAccount(key)
    const wallet = createWalletClient({ account, chain, transport: http(cfg.rpc) })
    const method = fermata({
      wallet,
      client,
      trustedVerifiers: cfg.trustedVerifiers,
      escrows: cfg.escrows,
      maxAmount: cfg.maxPrice,
      maxSettlementWindow: cfg.maxWindow,
      onHold: ({ callId, txHash }) => {
        paidCall.getStore()?.holds.push({ callId, holdTx: txHash })
        log(`held ${callId} (hold tx ${txHash})`)
      },
    })
    const paying = McpClient.wrap(upstream, {
      methods: [
        {
          ...method,
          // The amount reserved by the spending guard is given back when no hold is made (an untrusted
          // service, a wrong price, an unfunded wallet…), so failed attempts don't use up the budget.
          createCredential: async (args: Parameters<typeof method.createCredential>[0]) => {
            try {
              const credential = await method.createCredential(args)
              calls++
              return credential
            } catch (e) {
              held -= BigInt(args.challenge.request.amount)
              throw e
            }
          },
        },
      ],
      // Spending guard: a per-call cap and a per-session budget, checked (and reserved) before any money moves.
      onPaymentRequired: (challenge) => {
        const decline = (why: string) => {
          log(`declined: ${why}`)
          const call = paidCall.getStore()
          if (call) call.declined = why
          return false
        }
        if (challenge.method !== 'fermata') return decline(`the gateway asks for ${challenge.method}, not fermata`)
        // A canonical positive integer only: a negative or malformed price must never move the budget.
        const raw = (challenge.request as { amount?: unknown }).amount
        if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) return decline(`malformed price ${JSON.stringify(raw)}`)
        const amount = BigInt(raw)
        if (amount > cfg.maxPrice) return decline(`price ${amount} is above FERMATA_MAX_PRICE ${cfg.maxPrice}`)
        if (held + amount > cfg.budget) return decline(`price ${amount} would exceed this session's FERMATA_BUDGET (${held} of ${cfg.budget} already held)`)
        held += amount
        return true
      },
    })
    return { account, wallet, paying }
  })
  const ready = Promise.all([connected, agent]).then(([, a]) => a)

  const server = new Server({ name: 'fermata', version: pkg.version }, {
    capabilities: { tools: {} },
    instructions:
      'Tools marked as paid cost a small testnet stablecoin amount per call, paid with Fermata: the money is held in escrow on Tempo and only released to the vendor if a TLSNotary proof shows the vendor really delivered; a proven failure or no answer is refunded to you automatically. Before paying, fermata_vendor_scores shows every vendor\u2019s proven delivery record (from on-chain events) so you can pick a reliable one. Each paid result names its callId; fermata_verify re-checks the proof offline, fermata_reconcile shows the on-chain movements. If a paid call fails after your payment was held, the error names its callId: fermata_call shows its state, and fermata_reclaim refunds it once its settlement window has passed.',
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await connected
    const { tools } = await upstream.listTools()
    return {
      tools: [
        ...tools,
        {
          name: 'fermata_wallet',
          description: "Free. The agent's testnet wallet: address, pathUSD balance, and what this session has held so far against its budget.",
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'fermata_reclaim',
          description:
            'Free (gas only). Refunds one of your payments that is still held after its settlement window, for example after a paid call failed with an error naming its callId: sends claimTimeout, and the escrow returns the money to your wallet.',
          inputSchema: { type: 'object' as const, properties: { callId: { type: 'string', description: 'the call to refund: 0x and 64 hex characters' } }, required: ['callId'] },
        },
      ],
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params
    const { account, wallet, paying } = await ready
    const failed = (why: string): CallToolResult => ({ content: [text(`Fermata: ${why}`)], isError: true })
    if (name === 'fermata_wallet') {
      try {
        const balance = await client.readContract({ address: TOKENS.pathUSD as Address, abi: tip20Abi, functionName: 'balanceOf', args: [account.address] })
        const info = { address: account.address, pathUSD: Number(balance) / 1e6, paidCallsThisSession: calls, heldThisSession: Number(held) / 1e6, budget: Number(cfg.budget) / 1e6, maxPricePerCall: Number(cfg.maxPrice) / 1e6 }
        return { content: [text(JSON.stringify(info, null, 2))], structuredContent: info }
      } catch (e) {
        return failed(explain(e))
      }
    }
    if (name === 'fermata_reclaim') {
      const callId = String((args as { callId?: unknown } | undefined)?.callId ?? '')
      if (!/^0x[0-9a-fA-F]{64}$/.test(callId)) return failed('callId must be 0x followed by 64 hex characters')
      try {
        for (const escrow of cfg.escrows) {
          const hold = await getHold(client, escrow, callId as Hex)
          if (hold.status === HoldStatus.None) continue
          if (!isAddressEqual(hold.agent, account.address)) return failed(`call ${callId} was paid by ${hold.agent}, not by this wallet`)
          const receipt = await reclaim(wallet, client, escrow, callId as Hex)
          log(`reclaimed ${callId} (tx ${receipt.transactionHash})`)
          return { content: [text(`Refunded: call ${callId} returned ${Number(hold.amount) / 1e6} pathUSD to ${account.address} (claimTimeout tx ${receipt.transactionHash}).`)] }
        }
        return failed(`no hold for call ${callId} in ${cfg.escrows.join(', ')}`)
      } catch (e) {
        return failed(explain(e))
      }
    }
    const paid: PaidCall = { holds: [] }
    // The money may already be held when a call fails (a timeout, a lost retry, a gateway that
    // rejected the hold): say so, with what to do about it.
    const stillHeld = () =>
      paid.holds
        .map((h) => ` Your payment for call ${h.callId} is held in escrow (hold tx ${h.holdTx}): fermata_call shows its state, and if it is never settled, fermata_reclaim refunds it once its settlement window has passed.`)
        .join('')
    try {
      const result = (await paidCall.run(paid, () =>
        paying.callTool({ name, arguments: args }, undefined, { timeout: PAID_CALL_TIMEOUT_MS }),
      )) as CallToolResult & { receipt?: { reference?: string } }
      const call = (result._meta?.['org.fermata/call'] ?? undefined) as { callId: string; status: string } | undefined
      if (call) log(`${name}: call ${call.callId.slice(0, 10)} ${call.status}`)
      const { receipt: _receipt, ...rest } = result
      // An error result without a Fermata call record: the gateway will not settle a hold it doesn't know.
      if (result.isError && !call && paid.holds.length) {
        log(`${name}: error result after holding ${paid.holds.map((h) => h.callId).join(', ')}`)
        return { ...rest, content: [...(rest.content ?? []), text(stillHeld().trim())] } as CallToolResult
      }
      return rest as CallToolResult
    } catch (e) {
      const why = paid.declined ? `payment declined: ${paid.declined}` : explain(e)
      if (paid.holds.length) log(`${name}: failed after holding ${paid.holds.map((h) => h.callId).join(', ')}: ${why}`)
      return failed(why + stillHeld())
    }
  })

  return { server, upstream, ready }
}

// Started directly (not imported by a test): compare real paths, so a path with spaces (URL-encoded in
// import.meta.url) or behind a symlink (macOS /tmp → /private/tmp) still counts.
const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (entry === realpathSync(fileURLToPath(import.meta.url)) || entry.endsWith('fermata-mcp')) {
  const cfg = configFromEnv()
  const { server, upstream, ready } = createBridge(cfg)
  // The MCP client closing stdin ends the session. Exit then: the gateway's open event stream would
  // otherwise keep this process (and npx) alive.
  const stop = () => {
    setTimeout(() => process.exit(0), 2_000).unref()
    void upstream.close().finally(() => process.exit(0))
  }
  process.stdin.once('end', stop)
  process.stdin.once('close', stop)
  ready.then(
    ({ account }) => log(`ready: gateway ${cfg.gateway}, agent ${account.address}, cap ${cfg.maxPrice}/call, budget ${cfg.budget}`),
    (e: Error) => {
      log(`cannot start: ${e.message}`)
      process.exit(1)
    },
  )
  await server.connect(new StdioServerTransport())
}
