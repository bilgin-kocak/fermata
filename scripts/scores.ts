// pnpm scores [--chain anvil|moderato] [--rpc URL] [--escrow 0x…] [--from-block N] [--json]
//
// Vendor delivery scores recomputed straight from the chain: no gateway, no database. Reads the
// escrow's ServiceRegistered / Held / Released / Refunded events and ranks services by the Wilson
// 95 % lower bound of their delivery rate (packages/sdk/src/scores.ts). The gateway's /scores and
// the dashboard's Vendors tab run the same code; this is how anyone checks them.
import { createPublicClient, http, type Address } from 'viem'
import { aggregateScores, escrowDeployment, fetchEscrowLogs, serviceLabelOf, tempoChain } from '@fermata/sdk'
import { chainArg, loadDotEnv, parseArgs, rpcFor } from './lib/args.ts'
import { toJson } from './lib/tempo.ts'

loadDotEnv()
const args = parseArgs()
const chain = chainArg(args)
const rpc = rpcFor(chain, args)
const deployment = escrowDeployment(chain)
const escrow = (typeof args.escrow === 'string' ? args.escrow : (process.env.FERMATA_ESCROW || deployment?.address)) as Address | undefined
if (!escrow) throw new Error(`no escrow: pass --escrow (no ${chain} deployment in deployments.json)`)
const fromBlock = BigInt(typeof args['from-block'] === 'string' ? args['from-block'] : (deployment?.address.toLowerCase() === escrow.toLowerCase() ? deployment.deployBlock : 0))

const client = createPublicClient({ chain: tempoChain(rpc), transport: http(rpc) })
const { logs, toBlock } = await fetchEscrowLogs(client as never, escrow, fromBlock)
const scores = aggregateScores(logs)

if (args.json) {
  console.log(toJson({ chain, escrow, fromBlock, toBlock, scores }, 2))
} else {
  const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)} %`)
  const rows = scores.map((s, i) => [
    String(i + 1),
    serviceLabelOf(s.serviceId) ?? `${s.serviceId.slice(0, 10)}…`,
    `${s.released}/${s.settled}`,
    pct(s.deliveryRate),
    pct(s.score),
    String(s.provenFailures),
    String(s.timeouts),
    String(s.open),
    String(s.distinctAgents),
    s.settled < 20 ? 'few calls' : '',
  ])
  const head = ['#', 'service', 'released', 'delivery', 'score (Wilson 95 % low)', 'proven failures', 'timeouts', 'open', 'agents', '']
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i]!)).join('  ')
  console.log(`vendor scores on ${chain}, escrow ${escrow}, blocks ${fromBlock}–${toBlock} (${logs.length} events)\n`)
  console.log([line(head), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map(line)].join('\n'))
  console.log('\nOnly calls paid through Fermata count; a vendor could pay itself, so distinct agents are shown.')
}
