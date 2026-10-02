// pnpm demo:onboard [--chain anvil|moderato]   (needs the stack in public mode: PUBLIC=1 demo-stack.sh up)
//
// Self-serve onboarding end to end, through the public API only, against a real third-party API:
//   1 probe a real vendor (registry.npmjs.org): TLSNotary-compatible, a drafted delivery rule
//   2 refuse URLs that would reach the server's own network (SSRF guard)
//   3 register it on-chain with the drafted rule; it is served, listed and exposed over MCP at once
//   4 a paid test call is proved and released; 5 it shows on the vendor scoreboard; 6 the proof re-verifies
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { randomBytes } from 'node:crypto'
import { gw, link, stack, table } from './lib.ts'

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${stack.gateway}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}
const rows: [string, boolean, string][] = []
const check = (name: string, ok: boolean, note: string) => {
  rows.push([name, ok, note])
  console.log(`${ok ? '✓' : '✗'} ${name}: ${note}`)
}

const url = 'https://registry.npmjs.org/-/package/viem/dist-tags'
const probe = await post('/onboard/probe', { url })
check('probe a real vendor', probe.status === 200 && probe.body.ok, probe.body.ok ? `${probe.body.sample.tls.protocol} ${probe.body.sample.tls.cipher} ${probe.body.sample.tls.group}, HTTP ${probe.body.sample.status}, rule requires ${JSON.stringify(probe.body.predicate.jsonSchema?.required)}` : probe.body.error)

const refused = await Promise.all(['http://registry.npmjs.org/', 'https://127.0.0.1/', 'https://localhost/', 'https://registry.npmjs.org:8443/'].map((u) => post('/onboard/probe', { url: u })))
check('refuse unsafe URLs', refused.every((r) => r.status === 400), refused.map((r) => r.body.error).join(' | '))

const label = `viem-${randomBytes(2).toString('hex')}`
const payout = `0x${randomBytes(20).toString('hex')}`
const reg = await post('/onboard/register', { url, label, payout, price: '0.01', summary: 'Latest published versions of viem on npm', toolName: 'viem_versions', predicate: probe.body.predicate })
check('register on-chain', reg.status === 200 && reg.body.ok, reg.body.ok ? `${reg.body.serviceId.slice(0, 18)}… tx ${link(reg.body.txHash)}` : reg.body.error)

const services = await gw<{ serviceId: string }[]>('/services')
const mcp = new Client({ name: 'demo-onboard', version: '0.0.0' })
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${stack.gateway}/mcp`)))
const tools = (await mcp.listTools()).tools.map((t) => t.name)
await mcp.close()
check('served, listed and on MCP at once', services.some((s) => s.serviceId === reg.body.serviceId) && tools.includes('viem_versions'), `/services has it; MCP tools include viem_versions`)

const call = await post('/demo/call', { serviceId: reg.body.serviceId })
check('paid test call released', call.body.outcome === 'DELIVERED', `HTTP ${call.body.status} ${call.body.outcome ?? call.body.error} settle ${link(call.body.settleTx)}`)

await new Promise((r) => setTimeout(r, 6000)) // the scoreboard refreshes every 5 s
const scores = await gw<{ scores: { serviceId: string; released: number; settled: number; tool: string }[] }>('/scores')
const mine = scores.scores.find((s) => s.serviceId.toLowerCase() === String(reg.body.serviceId).toLowerCase())
check('on the vendor scoreboard', mine?.released === 1, mine ? `${mine.tool}: ${mine.released}/${mine.settled} delivered` : 'missing')

const verify = await post(`/proofs/${call.body.callId}/verify`, {})
check('proof re-verified offline', verify.body.ok === true, (verify.body.checks ?? []).map((c: { name: string; ok: boolean }) => `${c.ok ? '✓' : '✗'}${c.name}`).join(' '))

console.log(`\n${table(['step', 'result'], rows.map(([n, ok]) => [n, ok ? 'PASS' : 'FAIL']))}`)
console.log(`\n${rows.filter((r) => r[1]).length}/${rows.length} passed on ${stack.chain}`)
process.exit(rows.every((r) => r[1]) ? 0 : 1)
