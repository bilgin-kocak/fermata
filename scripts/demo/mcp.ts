// pnpm demo:mcp [--chain anvil|moderato]
//
// An MCP agent session against the running demo stack, through the same stdio server Claude Code
// launches (apps/mcp, `fermata-mcp`): a fresh funded agent wallet lists the tools, buys a quote from
// a reliable vendor (released), one from a broken vendor (refunded), re-verifies the first proof
// offline and reconciles the second by memo. Prints each tool result and a pass/fail table.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createWalletClient, http, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { feesPaid, tip20Abi } from '@fermata/sdk'
import { chain, client, stack, table, TOKEN } from './lib.ts'

// ---------------------------------------------------------------- a fresh agent wallet, funded
const funderKey = (stack.chain === 'anvil' ? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' : process.env.DEPLOYER_PRIVATE_KEY) as Hex | undefined
if (!funderKey) throw new Error('DEPLOYER_PRIVATE_KEY is not set (it funds the demo agent)')
const agentKey = generatePrivateKey()
const funder = createWalletClient({ account: privateKeyToAccount(funderKey), chain, transport: http(stack.rpc) })
const fundTx = await funder.writeContract({ address: TOKEN, abi: tip20Abi, functionName: 'transfer', args: [privateKeyToAccount(agentKey).address, 200_000n] })
await client.waitForTransactionReceipt({ hash: fundTx })

// ---------------------------------------------------------------- the agent's MCP server (stdio)
const mcp = new Client({ name: 'demo-agent', version: '0.0.0' })
await mcp.connect(
  new StdioClientTransport({
    command: 'node_modules/.bin/tsx',
    args: ['apps/mcp/src/index.ts'],
    env: {
      ...(process.env as Record<string, string>),
      FERMATA_GATEWAY: stack.gateway,
      FERMATA_AGENT_KEY: agentKey,
      TEMPO_RPC_URL: stack.rpc,
      FERMATA_ESCROW: stack.escrow,
      FERMATA_TRUSTED_VERIFIERS: stack.verifier,
      FERMATA_BUDGET: '20000', // two calls; the third is declined by the spending guard
    },
    stderr: 'inherit',
  }),
)

type Result = { content: { type: string; text: string }[]; isError?: boolean; _meta?: Record<string, any>; structuredContent?: Record<string, any> }
const show = (title: string, r: Result) => {
  console.log(`\n▶ ${title}${r.isError ? '   (isError)' : ''}`)
  for (const c of r.content) console.log(c.text.split('\n').map((l) => `  ${l}`).join('\n'))
}
const call = async (name: string, args: Record<string, unknown> = {}) => (await mcp.callTool({ name, arguments: args })) as Result

const { tools } = await mcp.listTools()
console.log(`demo:mcp on ${stack.chain}: agent ${privateKeyToAccount(agentKey).address}\ntools: ${tools.map((t) => t.name).join(', ')}`)

const wallet0 = await call('fermata_wallet')
show('fermata_wallet', wallet0)
const ok = await call('get_quote_reliable', { symbol: 'BTC-USD' })
show('get_quote_reliable { symbol: "BTC-USD" }', ok)
const bad = await call('get_quote_broken', { symbol: 'ETH-USD' })
show('get_quote_broken { symbol: "ETH-USD" }', bad)
const okId = ok._meta?.['org.fermata/call']?.callId
const badId = bad._meta?.['org.fermata/call']?.callId
const verify = await call('fermata_verify', { callId: okId })
console.log(`\n▶ fermata_verify { callId: ${okId?.slice(0, 10)}… }\n  ok: ${verify.structuredContent?.ok}  ${(verify.structuredContent?.checks ?? []).map((c: { name: string; ok: boolean }) => `${c.ok ? '✓' : '✗'} ${c.name}`).join('  ')}`)
const recon = await call('fermata_reconcile', { callId: badId })
console.log(`\n▶ fermata_reconcile { callId: ${badId?.slice(0, 10)}… }\n  ${recon.structuredContent?.expected} → match: ${recon.structuredContent?.match}`)
const over = await call('get_quote_reliable', { symbol: 'SOL-USD' })
show('get_quote_reliable { symbol: "SOL-USD" }  — over the session budget', over)
const wallet1 = await call('fermata_wallet')
show('fermata_wallet', wallet1)
await mcp.close()

const spent = Math.round((wallet0.structuredContent!.pathUSD - wallet1.structuredContent!.pathUSD) * 1e6)
let gas = 0n
for (const r of [ok, bad]) {
  const holdTx = r._meta?.['org.fermata/call']?.holdTx?.split('/').pop() as Hex | undefined
  if (holdTx) gas += feesPaid(await client.getTransactionReceipt({ hash: holdTx })).reduce((s, f) => s + f.amount, 0n)
}
const checks: [string, boolean][] = [
  ['paid tool released on a proven delivery', ok._meta?.['org.fermata/call']?.status === 'released' && !ok.isError],
  ['paid tool refunded on a proven 500', bad._meta?.['org.fermata/call']?.status === 'refunded' && !!bad.isError],
  ['proof re-verified offline against the chain', verify.structuredContent?.ok === true],
  ['refund reconciled by memo = callId', recon.structuredContent?.match === true],
  ['spending guard declines a call over budget', !!over.isError && !over._meta],
  ['agent paid one call (10000) + gas, the refund came back', BigInt(spent) - gas === 10_000n],
]
console.log(`\n${table(['check', 'result'], checks.map(([k, v]) => [k, v ? 'PASS' : 'FAIL']))}`)
console.log(`\nagent spent ${spent / 1e6} pathUSD = 0.01 for the released call + ${Number(gas) / 1e6} gas for two holds; the refunded call cost only gas`)
process.exit(checks.every(([, v]) => v) ? 0 : 1)
