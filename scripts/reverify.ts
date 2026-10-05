// pnpm reverify --call 0x… [--gateway URL] [--rpc URL] [--escrow 0x…]
//
// Re-verify one call's proof yourself, offline, trusting the gateway for nothing. Every expected value
// comes from the chain: the Held event (requestHash), getService (predicateHash, originHash,
// notaryKeyHash) and the Released/Refunded event (presentationHash). The gateway only serves bytes,
// and each is checked before use: the presentation's keccak256 must equal the on-chain
// presentationHash, the predicate's sha256 the on-chain predicateHash. Then `fermata-attest verify
// --offline` checks the notary's signature and the server certificate, recomputes requestHash,
// originHash and notaryKeyHash from the presentation, re-runs the predicate, and must reach the
// outcome the escrow paid out on.
//
// Needs the attestor binary once: (cd apps/attestor && cargo +1.95.0 build --release)
// --gateway defaults to the running demo stack (out/demo/stack.json), else the live demo.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPublicClient, http, keccak256, parseEventLogs, type Address, type Hex } from 'viem'
import { escrowDeployment, fermataEscrowAbi, getService, MODERATO, originHash, predicateHash, tempoChain } from '@fermata/sdk'
import { loadDotEnv, parseArgs } from './lib/args.ts'

const LIVE = 'https://fermata-production-9378.up.railway.app'
const ZERO32 = `0x${'00'.repeat(32)}`

loadDotEnv()
const args = parseArgs()
const callId = String(args.call ?? '') as Hex
if (!/^0x[0-9a-fA-F]{64}$/.test(callId)) throw new Error('usage: pnpm reverify --call 0x<callId> [--gateway URL] [--rpc URL] [--escrow 0x…]')

const stackFile = new URL('../out/demo/stack.json', import.meta.url)
const stack = existsSync(stackFile) ? (JSON.parse(readFileSync(stackFile, 'utf8')) as { gateway?: string; rpc?: string; escrow?: Address }) : undefined
const gateway = (typeof args.gateway === 'string' ? args.gateway : stack?.gateway ?? LIVE).replace(/\/$/, '')
const rpc = typeof args.rpc === 'string' ? args.rpc : stack?.gateway === gateway && stack.rpc ? stack.rpc : MODERATO.rpcUrl
// The escrow is never taken from the gateway: the repo's deployment record, or yours.
const escrow = (typeof args.escrow === 'string' ? args.escrow : stack?.gateway === gateway && stack.escrow ? stack.escrow : escrowDeployment('moderato')?.address) as Address
const bin = process.env.FERMATA_ATTEST_BIN ?? new URL('../apps/attestor/target/release/fermata-attest', import.meta.url).pathname
if (!existsSync(bin)) throw new Error(`no offline verifier at ${bin}: (cd apps/attestor && cargo +1.95.0 build --release), or set FERMATA_ATTEST_BIN`)

const client = createPublicClient({ chain: tempoChain(rpc), transport: http(rpc) })
const ok = (cond: boolean, what: string) => {
  console.log(`${cond ? '✓' : '✗'} ${what}`)
  if (!cond) process.exitCode = 1
  return cond
}
const get = async (p: string) => {
  const res = await fetch(`${gateway}${p}`)
  if (!res.ok) throw new Error(`GET ${gateway}${p}: HTTP ${res.status}`)
  return res
}

console.log(`re-verifying ${callId}\n  gateway ${gateway} (serves bytes only)\n  chain   ${rpc}, escrow ${escrow}\n`)

// 1. From the chain: the hold (the gateway only tells us which transaction to look at).
const record = (await (await get(`/calls/${callId}`)).json()) as { holdTx: Hex }
const holdReceipt = await client.getTransactionReceipt({ hash: record.holdTx })
const held = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Held', logs: holdReceipt.logs }).find(
  (l) => l.address.toLowerCase() === escrow.toLowerCase() && l.args.callId.toLowerCase() === callId.toLowerCase(),
)
if (!ok(!!held, `Held(${callId.slice(0, 10)}…) in ${record.holdTx.slice(0, 10)}…, block ${holdReceipt.blockNumber}`)) process.exit(1)
const { serviceId, requestHash } = held!.args
const svc = await getService(client as never, escrow, serviceId)

// 2. From the chain: how the escrow settled it (one bounded log query, under the RPC's range cap).
const head = await client.getBlockNumber()
const toBlock = holdReceipt.blockNumber + 99_999n < head ? holdReceipt.blockNumber + 99_999n : head
const settled = (
  await Promise.all(
    (['Released', 'Refunded'] as const).map((eventName) =>
      client.getContractEvents({ address: escrow, abi: fermataEscrowAbi, eventName, args: { callId }, fromBlock: holdReceipt.blockNumber, toBlock }),
    ),
  )
).flat()[0]
if (!ok(!!settled, settled ? `${settled.eventName} in ${settled.transactionHash.slice(0, 10)}…` : 'not settled on-chain yet')) process.exit(1)
const onchainPresentation = (settled!.args as { presentationHash: Hex }).presentationHash
if (onchainPresentation.toLowerCase() === ZERO32) {
  console.log('\nRefunded by timeout: no proof exists for this call, so there is nothing to re-verify (and none was needed).')
  process.exit(0)
}

// 3. Bytes from the gateway, each checked against the chain before use.
const dir = mkdtempSync(path.join(tmpdir(), 'fermata-reverify-'))
const presentation = new Uint8Array(await (await get(`/proofs/${callId}`)).arrayBuffer())
ok(keccak256(presentation) === onchainPresentation.toLowerCase(), `presentation keccak256 = on-chain presentationHash ${onchainPresentation.slice(0, 10)}…`)
writeFileSync(path.join(dir, 'call.tlsn'), presentation)
const predicate = new Uint8Array(await (await get(`/predicates/${svc.predicateHash}`)).arrayBuffer())
ok(predicateHash(predicate) === svc.predicateHash.toLowerCase(), `predicate sha256 = on-chain predicateHash ${svc.predicateHash.slice(0, 10)}…`)
writeFileSync(path.join(dir, 'predicate.json'), predicate)
const services = (await (await get('/services')).json()) as { serviceId: string; upstream: string }[]
const upstream = services.find((s) => s.serviceId.toLowerCase() === serviceId.toLowerCase())?.upstream
ok(!!upstream && originHash(upstream) === svc.originHash, `origin ${upstream} = on-chain originHash ${svc.originHash.slice(0, 10)}…`)
// Mock vendors use the demo's dev CA (fetched; it only widens which certificates are accepted);
// real vendors must chain to Mozilla's roots.
const trust = upstream && new URL(upstream).hostname === 'vendor.fermata.test'
  ? (writeFileSync(path.join(dir, 'ca.pem'), await (await get('/ca.pem')).text()), ['--ca', path.join(dir, 'ca.pem')])
  : ['--roots', 'mozilla']
if (process.exitCode) process.exit(1)

// 4. The offline verifier: notary signature, certificate, every hash recomputed, the predicate re-run.
let out: Record<string, unknown>
try {
  out = JSON.parse(execFileSync(bin, [
    'verify', '--offline', '--presentation', path.join(dir, 'call.tlsn'), ...trust, '--call-id', callId,
    '--predicate', path.join(dir, 'predicate.json'), '--service-id', serviceId, '--request-hash', requestHash,
    '--origin-hash', svc.originHash, '--notary-key-hash', svc.notaryKeyHash,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
} catch (e) {
  console.log(`✗ fermata-attest verify --offline failed:\n${(e as { stderr?: string }).stderr ?? (e as Error).message}`)
  process.exit(1)
}
const outcome = out.outcome === 1 || out.outcome === 'DELIVERED' ? 'DELIVERED' : out.outcome === 2 || out.outcome === 'FAILED' ? 'FAILED' : String(out.outcome)
ok(out.ok === true, 'notary signature, certificate chain and the recomputed requestHash, originHash, notaryKeyHash all check out')
ok((outcome === 'DELIVERED') === (settled!.eventName === 'Released'), `the predicate re-run says ${outcome}; the escrow ${settled!.eventName === 'Released' ? 'released' : 'refunded'}`)
console.log(`\n${process.exitCode ? 'MISMATCH' : 'VERIFIED'}: ${callId} (${outcome}), checked against the chain, not the gateway's word.`)
