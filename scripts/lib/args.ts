/** Tiny `--key value` / `--flag` parser shared by the repo scripts. */
export function parseArgs(argv = process.argv.slice(2)): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

export type ChainName = 'anvil' | 'moderato'

export function chainArg(args: Record<string, string | true>): ChainName {
  const chain = args.chain ?? 'anvil'
  if (chain !== 'anvil' && chain !== 'moderato') throw new Error(`--chain must be anvil or moderato, got ${String(chain)}`)
  return chain
}

export function rpcFor(chain: ChainName, args: Record<string, string | true>): string {
  if (typeof args.rpc === 'string') return args.rpc
  if (chain === 'moderato') return process.env.TEMPO_RPC_URL || 'https://rpc.moderato.tempo.xyz'
  return process.env.ANVIL_RPC_URL || 'http://127.0.0.1:8545'
}

/** Loads ./.env (repo root) if present; never overrides variables already set. */
export function loadDotEnv(path = new URL('../../.env', import.meta.url)): void {
  try {
    process.loadEnvFile(path)
  } catch {
    // no .env: fine for anvil runs
  }
}
