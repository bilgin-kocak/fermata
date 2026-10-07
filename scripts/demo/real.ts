// pnpm demo:real [--chain anvil|moderato]
//
// Fermata against real third-party APIs, not our mock vendor: the running stack registers
// registry.npmjs.org (and api.coinbase.com with REAL_VENDORS=npm,coinbase). The vendor's TLS session
// is proved with TLSNotary and its certificate checked against Mozilla's root program.
//   1 release  npm answers mppx's dist-tags              → DELIVERED → vendor paid
//   2 refund   npm's genuine 404 for a missing package   → FAILED    → agent refunded
//   3 MCP      the same vendor as an MCP tool, paid by fermata-mcp
//   4 Coinbase spot price (only if the stack registered it)
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createWalletClient, http, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tip20Abi } from 'fermata-sdk'
import { chain, client, fundedAgent, gw, link, receiptOf, short, stack, table, TOKEN } from './lib.ts'

const real = (stack as typeof stack & { real?: { npm?: Hex; coinbase?: Hex } }).real ?? {}
if (!real.npm) throw new Error('the running stack has no real vendor: restart it with REAL_VENDORS=npm (the default)')

type Row = { case: string; pass: boolean; outcome: string; callId: string; tx: string; notes: string[] }
const rows: Row[] = []
const agent = await fundedAgent(100_000n)
console.log(`demo:real on ${stack.chain} — gateway ${stack.gateway}, agent ${agent.account.address}\n`)

/** The proof re-verified offline, its server name and status read back from the revealed transcript. */
async function verified(callId: string) {
  const v = await gw<{ ok: boolean; checks: { name: string; ok: boolean }[]; transcript: { request: string; response: string } }>(`/proofs/${callId}/verify`, { method: 'POST' })
  const host = /\r\nhost: ([^\r\n]+)/i.exec(v.transcript?.request ?? '')?.[1]
  const status = /^HTTP\/1\.1 (\d{3})/.exec(v.transcript?.response ?? '')?.[1]
  const body = (v.transcript?.response ?? '').split('\r\n\r\n').slice(1).join('\r\n\r\n')
  return { ok: v.ok, host, status, body }
}

async function http402(name: string, service: Hex, path: string, expect: 'DELIVERED' | 'FAILED') {
  const row: Row = { case: name, pass: true, outcome: '-', callId: '-', tx: '-', notes: [] }
  const check = (ok: boolean, note: string) => {
    if (!ok) row.pass = false
    row.notes.push(`${ok ? '✓' : '✗'} ${note}`)
  }
  try {
    const res = await agent.pay(service, path)
    const rc = receiptOf(res)
    const text = await res.text()
    Object.assign(row, { outcome: rc.outcome ?? '?', callId: rc.callId, tx: link(rc.txHash) })
    check(rc.outcome === expect, `verdict ${rc.outcome} (vendor HTTP ${res.status}: ${text.slice(0, 70)})`)
    const v = await verified(rc.callId)
    check(v.ok, 'proof re-verified offline: every hash matches the chain, certificate chains to a Mozilla root')
    check(!!v.host, `notarized server: ${v.host}, HTTP ${v.status}`)
    const rec = await gw<{ match: boolean; expected: string }>(`/reconcile/${rc.callId}`)
    check(rec.match, `reconciled by memo: ${rec.expected}`)
  } catch (e) {
    check(false, (e as Error).message)
  }
  rows.push(row)
  console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${name}\n${row.notes.map((n) => `      ${n}`).join('\n')}\n`)
}

await http402('1 release — registry.npmjs.org answers', real.npm, '/-/package/mppx/dist-tags', 'DELIVERED')
await http402("2 refund — npm's genuine 404", real.npm, '/-/package/no-such-package-fermata-zz/dist-tags', 'FAILED')

// ------------------------------------------------------------------ 3 (and 4): over MCP
const funderKey = (stack.chain === 'anvil' ? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' : process.env.DEPLOYER_PRIVATE_KEY) as Hex
const agentKey = generatePrivateKey()
const funder = createWalletClient({ account: privateKeyToAccount(funderKey), chain, transport: http(stack.rpc) })
await client.waitForTransactionReceipt({
  hash: await funder.writeContract({ address: TOKEN, abi: tip20Abi, functionName: 'transfer', args: [privateKeyToAccount(agentKey).address, 100_000n] }),
})
const mcp = new Client({ name: 'demo-real', version: '0.0.0' })
await mcp.connect(
  new StdioClientTransport({
    command: 'node_modules/.bin/tsx',
    args: ['apps/mcp/src/index.ts'],
    env: { ...(process.env as Record<string, string>), FERMATA_GATEWAY: stack.gateway, FERMATA_AGENT_KEY: agentKey, TEMPO_RPC_URL: stack.rpc, FERMATA_ESCROW: stack.escrow, FERMATA_TRUSTED_VERIFIERS: stack.verifier },
    stderr: 'ignore',
  }),
)
type ToolResult = { content: { text: string }[]; isError?: boolean; _meta?: Record<string, any> }
async function viaMcp(name: string, tool: string, args: Record<string, string>) {
  const row: Row = { case: name, pass: true, outcome: '-', callId: '-', tx: '-', notes: [] }
  const r = (await mcp.callTool({ name: tool, arguments: args })) as ToolResult
  const call = r._meta?.['org.fermata/call']
  Object.assign(row, { outcome: call?.outcome ?? '?', callId: call?.callId ?? '-', tx: call?.settleTx ?? '-' })
  row.pass = call?.status === 'released' && !r.isError
  row.notes.push(`${row.pass ? '✓' : '✗'} ${tool}(${JSON.stringify(args)}) → ${r.content.map((c) => c.text).join(' | ').slice(0, 160)}`)
  if (call?.callId) {
    const v = await verified(call.callId)
    row.pass &&= v.ok
    row.notes.push(`${v.ok ? '✓' : '✗'} proof re-verified offline (server ${v.host})`)
  }
  rows.push(row)
  console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${name}\n${row.notes.map((n) => `      ${n}`).join('\n')}\n`)
}
await viaMcp('3 MCP — npm as a paid tool', 'npm_latest_version', { package: 'viem' })
if (real.coinbase) await viaMcp('4 MCP — Coinbase spot price', 'get_spot_price', { pair: 'BTC-USD' })
await mcp.close()

console.log(table(['case', 'result', 'outcome', 'callId', 'settle / refund tx'], rows.map((r) => [r.case, r.pass ? 'PASS' : 'FAIL', r.outcome, r.callId.length > 2 ? short(r.callId) : '-', r.tx])))
console.log(`\n${rows.filter((r) => r.pass).length}/${rows.length} passed against real vendors on ${stack.chain}`)
process.exit(rows.every((r) => r.pass) ? 0 : 1)
