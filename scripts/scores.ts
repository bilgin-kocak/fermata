// pnpm scores [--chain anvil|moderato] [--rpc URL] [--escrow 0x…] [--verifier 0x…] [--from-block N] [--proofs GATEWAY] [--json]
//
// Vendor delivery scores recomputed straight from the chain: no gateway, no database. Reads the
// escrow's ServiceRegistered / Held / Released / Refunded events and ranks services by the Wilson
// 95 % lower bound of their delivery rate (packages/sdk/src/scores.ts). The gateway's /scores and
// the dashboard's Vendors tab run the same code; this is how anyone checks them. --verifier keeps only
// services settled by that verifier, as the gateway does with its own attestor (shown on /scores).
//
// --proofs <gateway URL> classifies each proven failure by the HTTP status its proof shows: it
// downloads the presentation, checks it against the on-chain presentationHash and verifies it offline
// (as `pnpm reverify` does). A 4xx is the agent's request (reported, not ranked); a proof that does
// not verify stays unclassified, which counts against the vendor. Needs the attestor binary.
import { existsSync, readFileSync } from 'node:fs'
import { createPublicClient, http, type Address, type Hex } from 'viem'
import { aggregateScores, escrowDeployment, failureClass, fetchEscrowLogs, getService, serviceLabelOf, tempoChain, type FailureClass } from 'fermata-sdk'
import { chainArg, loadDotEnv, parseArgs, rpcFor } from './lib/args.ts'
import { gatewayFiles, requireAttestBin, verifyProof } from './lib/proofs.ts'
import { toJson } from './lib/tempo.ts'

loadDotEnv()
const args = parseArgs()
const chain = chainArg(args)
// A running demo stack (scripts/demo-stack.sh) on this chain supplies the defaults: its Anvil listens on
// 8549, not 8545, and in public mode it may run its own escrow.
const stackFile = new URL('../out/demo/stack.json', import.meta.url)
const stack = existsSync(stackFile) ? (JSON.parse(readFileSync(stackFile, 'utf8')) as { chain?: string; rpc?: string; escrow?: string }) : undefined
const fromStack = stack?.chain === chain ? stack : undefined
const rpc = typeof args.rpc !== 'string' && chain === 'anvil' && !process.env.ANVIL_RPC_URL && fromStack?.rpc ? fromStack.rpc : rpcFor(chain, args)
const deployment = escrowDeployment(chain)
const escrow = (typeof args.escrow === 'string' ? args.escrow : (process.env.FERMATA_ESCROW || fromStack?.escrow || deployment?.address)) as Address | undefined
if (!escrow) throw new Error(`no escrow: pass --escrow (no ${chain} deployment in deployments.json)`)
const fromBlock = BigInt(typeof args['from-block'] === 'string' ? args['from-block'] : (deployment?.address.toLowerCase() === escrow.toLowerCase() ? deployment.deployBlock : 0))

const client = createPublicClient({ chain: tempoChain(rpc), transport: http(rpc) })
const { logs, toBlock } = await fetchEscrowLogs(client as never, escrow, fromBlock)
const verifier = typeof args.verifier === 'string' ? args.verifier.toLowerCase() : undefined
const ZERO32 = `0x${'00'.repeat(32)}`

// --proofs: the class of each proven failure, from its proof verified offline against the chain.
const classes = new Map<string, FailureClass>()
let unverified = 0
if (typeof args.proofs === 'string') {
  const bin = requireAttestBin()
  const files = gatewayFiles(args.proofs)
  const requestHashOf = new Map(logs.filter((l) => l.eventName === 'Held').map((l) => [l.args.callId.toLowerCase(), (l.args as { requestHash?: Hex }).requestHash]))
  const registered = new Map(logs.filter((l) => l.eventName === 'ServiceRegistered').map((l) => [l.args.serviceId.toLowerCase(), l.args.verifier.toLowerCase()]))
  const failures = logs.filter((l) => l.eventName === 'Refunded' && l.args.presentationHash.toLowerCase() !== ZERO32 && (!verifier || registered.get(l.args.serviceId.toLowerCase()) === verifier))
  const services = new Map<string, Awaited<ReturnType<typeof getService>>>()
  for (const l of failures) {
    if (l.eventName !== 'Refunded') continue
    const key = l.args.serviceId.toLowerCase()
    if (!services.has(key)) services.set(key, await getService(client as never, escrow, l.args.serviceId))
    const requestHash = requestHashOf.get(l.args.callId.toLowerCase())
    const r = requestHash
      ? await verifyProof(files, { callId: l.args.callId, serviceId: l.args.serviceId, requestHash, presentationHash: l.args.presentationHash, service: services.get(key)! }, bin)
      : undefined
    const cls = r?.ok ? failureClass(r.status) : undefined
    if (cls) classes.set(l.args.callId.toLowerCase(), cls)
    else unverified++
  }
  if (!args.json) console.log(`classified ${classes.size} of ${failures.length} proven failure(s) from their proofs (${files.base})${unverified ? `; ${unverified} did not verify and count against the vendor` : ''}\n`)
}
const scores = aggregateScores(logs, (callId) => classes.get(callId.toLowerCase())).filter((s) => !verifier || s.verifier?.toLowerCase() === verifier)

if (args.json) {
  console.log(toJson({ chain, escrow, fromBlock, toBlock, classified: classes.size, unverified, scores }, 2))
} else {
  const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)} %`)
  const rows = scores.map((s, i) => [
    String(i + 1),
    serviceLabelOf(s.serviceId) ?? `${s.serviceId.slice(0, 10)}…`,
    `${s.released}/${s.released + s.vendorFailures + s.unclassified}`,
    pct(s.deliveryRate),
    pct(s.score),
    String(s.vendorFailures),
    String(s.unclassified),
    String(s.clientErrors),
    String(s.timeouts),
    String(s.open),
    String(s.distinctAgents),
    s.settled < 20 ? 'few calls' : '',
  ])
  const head = ['#', 'service', 'released', 'delivery', 'score (Wilson 95 % low)', 'vendor failures', 'unclassified', 'client errors (4xx)', 'timeouts', 'open', 'agents', '']
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i]!)).join('  ')
  console.log(`vendor scores on ${chain}, escrow ${escrow}, blocks ${fromBlock}–${toBlock} (${logs.length} events)\n`)
  console.log([line(head), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map(line)].join('\n'))
  console.log('\nThe rate counts proven outcomes only: timeouts and client errors are shown, not ranked; unclassified failures')
  console.log(`count against the vendor${typeof args.proofs === 'string' ? '' : ' (pass --proofs <gateway URL> to classify them from their proofs)'}. Only calls paid through Fermata count;`)
  console.log(`a vendor could pay itself, so distinct agents are shown.${verifier ? '' : ' Pass --verifier <the gateway attestor> to rank only services it settles.'}`)
}
