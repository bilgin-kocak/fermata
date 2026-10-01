// Fermata gateway entry point.
//   GATEWAY_CONFIG=gateway.config.json RELAYER_PRIVATE_KEY=0x… GATEWAY_SECRET_KEY=… pnpm -F @fermata/gateway start
// Env: TEMPO_RPC_URL, FERMATA_ESCROW, ATTESTOR_URL, GATEWAY_PORT/HOST/REALM/STORAGE/SWEEP_MS override the
// config file; GATEWAY_UPSTREAM_CA (vendor CA PEM) and GATEWAY_RESOLVE ("host:port=ip:port,…") are
// only used by the unprotected `tempo` fallback, which calls the vendor directly.
import { readFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { Agent, fetch as undiciFetch } from 'undici'
import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoChain } from '@fermata/sdk'
import { createGateway } from './app.ts'
import { HttpAttestor } from './attestor.ts'
import { ViemChain } from './chain.ts'
import { loadConfig } from './config.ts'
import { CallStore } from './store.ts'

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

const resolve = new Map(
  (process.env.GATEWAY_RESOLVE ?? '')
    .split(',')
    .filter(Boolean)
    .map((r) => r.split('=') as [string, string]),
)
const dispatcher = new Agent({
  connect: {
    ca: process.env.GATEWAY_UPSTREAM_CA ? readFileSync(process.env.GATEWAY_UPSTREAM_CA) : undefined,
    lookup: (hostname, options, cb) => {
      const target = [...resolve.entries()].find(([k]) => k.split(':')[0] === hostname)?.[1]?.split(':')[0]
      // Node ≥ 22.21 asks for { all: true } (Happy Eyeballs) and then expects an address list.
      if (target && (options as { all?: boolean }).all) return (cb as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: target, family: 4 }])
      if (target) return (cb as (e: null, a: string, f: number) => void)(null, target, 4)
      return import('node:dns').then((dns) => dns.lookup(hostname, options, cb as never))
    },
  },
})

const gateway = await createGateway({
  config,
  chain: new ViemChain(publicClient, relayer, config.escrow, chainId),
  publicClient: publicClient as never,
  attestor: new HttpAttestor(config.attestorUrl),
  store: new CallStore(config.storageDir),
  secretKey: required('GATEWAY_SECRET_KEY'),
  dashboardDir: process.env.GATEWAY_DASHBOARD_DIR ?? new URL('../../dashboard/dist', import.meta.url).pathname,
  explorer: process.env.GATEWAY_EXPLORER === undefined ? undefined : process.env.GATEWAY_EXPLORER || null,
  fetchUpstream: async (url, init) => (await undiciFetch(url, { ...(init as object), dispatcher })) as unknown as Response,
})

setInterval(() => {
  gateway.sweep().catch((e) => console.error(`[gateway] sweep failed: ${(e as Error).message}`))
}, config.sweepIntervalMs).unref()

serve({ fetch: gateway.app.fetch, port: config.port, hostname: config.host }, () => {
  console.log(
    `[gateway] listening on http://${config.host}:${config.port} — escrow ${config.escrow} (chain ${chainId}), relayer ${relayer.account.address}, ${gateway.services.size} service(s), attestor ${config.attestorUrl}`,
  )
})
