import { readFileSync } from 'node:fs'
import type { Address, Hex } from 'viem'

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
  services: ServiceConfig[]
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
    services: file.services ?? [],
  }
  if (!cfg.escrow) throw new Error('escrow address missing (FERMATA_ESCROW or config.escrow)')
  if (cfg.services.length === 0) throw new Error('no services configured')
  return cfg
}
