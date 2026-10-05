import { readFileSync } from 'node:fs'
import type { Address, Hex } from 'viem'
import { escrowDeployment } from '@fermata/sdk'

export type ServiceConfig = {
  serviceId: Hex
  /** Upstream origin, e.g. https://vendor.fermata.test:8443 (must match the on-chain originHash). */
  upstream: string
  /** Agent request headers forwarded upstream (lower-case). Default: content-type, accept. */
  forwardHeaders?: string[]
  /** Upstream credential held by the gateway, sent as `header: value of env var` (redacted in proofs). */
  upstreamAuth?: { header: string; env: string }
  /** Example path for discovery (`/openapi.json`). */
  examplePath?: string
  summary?: string
  /** How the service appears as a paid tool on the gateway's MCP endpoint (default: `call_<label>` with a raw `path`). */
  tool?: { name: string; description?: string; path: string }
  /** Added by self-serve onboarding: skipped with a warning (not fatal) if it no longer checks out. */
  onboarded?: boolean
  /** Unprotected fallback: plain `tempo` charge paid straight to the vendor, no proof. */
  tempo?: { amount: string; recipient: Address }
}

export type GatewayConfig = {
  port: number
  host: string
  realm: string
  rpc: string
  escrow: Address
  attestorUrl: string
  storageDir: string
  sweepIntervalMs: number
  /** Public "try it" demo (enabled with GATEWAY_PUBLIC=1). */
  demo?: import('./public.ts').DemoConfig
  /** First block to scan for vendor scores (the escrow's deploy block). */
  fromBlock?: number
  services: ServiceConfig[]
}

/** The deploy block recorded in the SDK's deployments.json for this escrow address, if any. */
function deployBlockOf(escrow: Address): number | undefined {
  return (['moderato', 'anvil'] as const).map(escrowDeployment).find((d) => d && d.address.toLowerCase() === escrow.toLowerCase())?.deployBlock
}

/** `gateway.config.json` (path from GATEWAY_CONFIG) with env overrides for deployment specifics. */
export function loadConfig(path = process.env.GATEWAY_CONFIG ?? 'gateway.config.json'): GatewayConfig {
  const file = JSON.parse(readFileSync(path, 'utf8')) as Partial<GatewayConfig>
  const cfg: GatewayConfig = {
    port: Number(process.env.GATEWAY_PORT ?? file.port ?? 4300),
    host: process.env.GATEWAY_HOST ?? file.host ?? '127.0.0.1',
    realm: process.env.GATEWAY_REALM ?? file.realm ?? 'localhost',
    rpc: process.env.TEMPO_RPC_URL ?? file.rpc ?? 'https://rpc.moderato.tempo.xyz',
    escrow: (process.env.FERMATA_ESCROW ?? file.escrow) as Address,
    attestorUrl: process.env.ATTESTOR_URL ?? file.attestorUrl ?? 'http://127.0.0.1:7048',
    storageDir: process.env.GATEWAY_STORAGE ?? file.storageDir ?? 'storage/calls',
    sweepIntervalMs: Number(process.env.GATEWAY_SWEEP_MS ?? file.sweepIntervalMs ?? 10_000),
    fromBlock: 0,
    services: file.services ?? [],
    demo: file.demo,
  }
  if (!cfg.escrow) throw new Error('escrow address missing (FERMATA_ESCROW or config.escrow)')
  // Scan escrow events from its deploy block, not genesis (Moderato is ~38M blocks deep).
  cfg.fromBlock = Number(process.env.GATEWAY_FROM_BLOCK || file.fromBlock || deployBlockOf(cfg.escrow) || 0)
  if (cfg.services.length === 0) throw new Error('no services configured')
  for (const s of cfg.services) {
    // The prover redacts only these headers' values from the presentation (prove.rs).
    if (s.upstreamAuth && !['authorization', 'cookie', 'proxy-authorization'].includes(s.upstreamAuth.header.toLowerCase())) {
      throw new Error(`service ${s.serviceId}: upstreamAuth.header ${s.upstreamAuth.header} would appear in every proof; use Authorization, Cookie or Proxy-Authorization`)
    }
  }
  return cfg
}
