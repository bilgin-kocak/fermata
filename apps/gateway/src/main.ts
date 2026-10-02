// Fermata gateway entry point.
//   GATEWAY_CONFIG=gateway.config.json RELAYER_PRIVATE_KEY=0x… GATEWAY_SECRET_KEY=… pnpm -F @fermata/gateway start
// Env: TEMPO_RPC_URL, FERMATA_ESCROW, ATTESTOR_URL, GATEWAY_PORT/HOST/REALM/STORAGE/SWEEP_MS override the
// config file; GATEWAY_UPSTREAM_CA (vendor CA PEM) and GATEWAY_RESOLVE ("host:port=ip:port,…") are
// only used by the unprotected `tempo` fallback, which calls the vendor directly.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { fetch as undiciFetch } from 'undici'
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { fermata, fermataEscrowAbi, originHash, predicateHash, serviceId as makeServiceId, tempoChain, tip20Abi, TOKENS } from '@fermata/sdk'
import { probeVendor } from './onboard.ts'
import type { ServiceConfig } from './config.ts'
import { createGateway } from './app.ts'
import { HttpAttestor } from './attestor.ts'
import { ViemChain } from './chain.ts'
import { loadConfig } from './config.ts'
import { CallStore } from './store.ts'
import { parseResolve, upstreamDispatcher } from './upstream.ts'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

const config = loadConfig()
const chainDef = tempoChain(config.rpc)
const publicClient = createPublicClient({ chain: chainDef, transport: http(config.rpc) })
const relayer = createWalletClient({ account: privateKeyToAccount(required('RELAYER_PRIVATE_KEY') as Hex), chain: chainDef, transport: http(config.rpc) })
const chainId = await publicClient.getChainId()

const dispatcher = upstreamDispatcher(
  parseResolve(process.env.GATEWAY_RESOLVE),
  process.env.GATEWAY_UPSTREAM_CA ? readFileSync(process.env.GATEWAY_UPSTREAM_CA) : undefined,
)

const attestor = new HttpAttestor(config.attestorUrl)

// Public "try it" mode: a server-side demo agent pays this gateway with the real `fermata` method.
let self: { request: (url: string, init?: RequestInit) => Response | Promise<Response> } | undefined
async function demoDeps() {
  if (process.env.GATEWAY_PUBLIC !== '1') return undefined
  if (!config.demo) throw new Error('GATEWAY_PUBLIC=1 needs a `demo` section in the gateway config')
  const agent = privateKeyToAccount(required('DEMO_AGENT_PRIVATE_KEY') as Hex)
  const wallet = createWalletClient({ account: agent, chain: chainDef, transport: http(config.rpc) })
  const { signer } = await attestor.health()
  const mppx = Mppx.create({
    methods: [fermata({ wallet, client: publicClient as never, trustedVerifiers: [signer], escrows: [config.escrow] })],
    polyfill: false,
    fetch: ((url: string, init?: RequestInit) => self!.request(url, init)) as never,
  })
  const token = TOKENS.pathUSD as Address
  return {
    config: config.demo,
    trustProxy: process.env.GATEWAY_TRUST_PROXY === '1',
    wallets: [
      { name: 'demo agent', address: agent.address },
      { name: 'relayer', address: relayer.account.address },
    ],
    balance: (address: Address) => publicClient.readContract({ address: token, abi: tip20Abi, functionName: 'balanceOf', args: [address] }),
    topUp: async (address: Address) => {
      const hashes = (await publicClient.request({ method: 'tempo_fundAddress' as never, params: [address] as never })) as Hex[]
      if (!Array.isArray(hashes) || hashes.length === 0) return false
      await publicClient.waitForTransactionReceipt({ hash: hashes[0]!, timeout: 30_000 })
      return true
    },
    pay: async (serviceId: Hex, path: string) => {
      const res = await mppx.fetch(`http://${config.realm}/s/${serviceId}${path}`, { headers: { accept: 'application/json' } })
      const rc = Receipt.fromResponse(res) as Receipt.Receipt & Record<string, unknown>
      return { status: res.status, callId: rc.callId as Hex, outcome: (rc.outcome as string) ?? null, holdTx: rc.holdTx as Hex, settleTx: (rc.txHash as Hex) ?? null, body: (await res.text()).slice(0, 500) }
    },
  }
}

// Self-serve onboarding (public mode): the operator key registers vendors' services on-chain.
function onboardDeps() {
  if (process.env.GATEWAY_PUBLIC !== '1') return undefined
  const predicateDir = required('ONBOARD_PREDICATE_DIR') // also passed to the attestor as a --predicate path
  mkdirSync(predicateDir, { recursive: true })
  const operator = createWalletClient({ account: privateKeyToAccount((process.env.ONBOARD_OPERATOR_PRIVATE_KEY || required('RELAYER_PRIVATE_KEY')) as Hex), chain: chainDef, transport: http(config.rpc) })
  return {
    trustProxy: process.env.GATEWAY_TRUST_PROXY === '1',
    probe: (t: Parameters<typeof probeVendor>[0]) => probeVendor(t, { proxy: process.env.FERMATA_UPSTREAM_PROXY || undefined }),
    register: async (
      input: { origin: string; examplePath: string; label: string; payout: Address; price: bigint; predicate: Uint8Array; summary: string; toolName: string },
      add: (cfg: ServiceConfig) => Promise<void>,
    ) => {
      const sid = makeServiceId(operator.account.address, input.label)
      const existing = await publicClient.readContract({ address: config.escrow, abi: fermataEscrowAbi, functionName: 'getService', args: [sid] })
      if (existing.token !== '0x0000000000000000000000000000000000000000') throw new Error(`label "${input.label}" is taken; pick another`)
      const reference = await publicClient.readContract({ address: config.escrow, abi: fermataEscrowAbi, functionName: 'getService', args: [config.services[0]!.serviceId] })
      const { signer } = await attestor.health()
      const ph = predicateHash(input.predicate)
      writeFileSync(path.join(predicateDir, `${input.label}-${ph.slice(2, 10)}.json`), input.predicate)
      const txHash = await operator.writeContract({
        address: config.escrow,
        abi: fermataEscrowAbi,
        functionName: 'registerService',
        args: [sid, input.payout, TOKENS.pathUSD as Address, input.price, 120, signer, ph, originHash(input.origin), reference.notaryKeyHash],
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
      if (receipt.status !== 'success') throw new Error(`registration reverted: ${txHash}`)
      await add({ serviceId: sid, upstream: input.origin, examplePath: input.examplePath, summary: input.summary, tool: { name: input.toolName, description: input.summary, path: input.examplePath } })
      return { serviceId: sid, txHash, endpoint: `/s/${sid}${input.examplePath}`, tool: input.toolName }
    },
  }
}

const gateway = await createGateway({
  config,
  chain: new ViemChain(publicClient, relayer, config.escrow, chainId),
  publicClient: publicClient as never,
  attestor,
  store: new CallStore(config.storageDir),
  secretKey: required('GATEWAY_SECRET_KEY'),
  dashboardDir: process.env.GATEWAY_DASHBOARD_DIR ?? new URL('../../dashboard/dist', import.meta.url).pathname,
  explorer: process.env.GATEWAY_EXPLORER === undefined ? undefined : process.env.GATEWAY_EXPLORER || null,
  fetchUpstream: async (url, init) => (await undiciFetch(url, { ...(init as object), dispatcher })) as unknown as Response,
  demo: await demoDeps(),
  onboard: onboardDeps(),
  // onboarded services are persisted here (demo-stack merges them back into the config at start)
  configPath: process.env.ONBOARD_SERVICES_FILE ?? process.env.GATEWAY_CONFIG ?? 'gateway.config.json',
})
self = gateway.app

setInterval(() => {
  gateway.sweep().catch((e) => console.error(`[gateway] sweep failed: ${(e as Error).message}`))
}, config.sweepIntervalMs).unref()

serve({ fetch: gateway.app.fetch, port: config.port, hostname: config.host }, () => {
  console.log(
    `[gateway] listening on http://${config.host}:${config.port} — escrow ${config.escrow} (chain ${chainId}), relayer ${relayer.account.address}, ${gateway.services.size} service(s), attestor ${config.attestorUrl}`,
  )
})
