// Creates .env from .env.example (mode 600) and fills every empty *_PRIVATE_KEY with a fresh
// TESTNET key. Never overwrites a value that is already set, so it is safe to re-run.
// Prints the address of every key and the faucet command for the ones that pay fees.
//   pnpm keys:init
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isHex, size, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { MODERATO } from '@fermata/sdk'

const root = new URL('../', import.meta.url)
const envUrl = new URL('.env', root)
const example = readFileSync(new URL('.env.example', root), 'utf8').split('\n')
const existed = existsSync(envUrl)
const lines = existed ? readFileSync(envUrl, 'utf8').split('\n') : [...example]
const assignment = /^([A-Z0-9_]+)=(.*)$/

// Variables listed in .env.example but missing from an older .env are appended.
const present = new Set(lines.map((l) => assignment.exec(l)?.[1]).filter(Boolean))
const missing = example.filter((l) => {
  const name = assignment.exec(l)?.[1]
  return name !== undefined && !present.has(name)
})
if (missing.length > 0) lines.push('', '# added by pnpm keys:init from .env.example', ...missing)

const created: string[] = []
for (let i = 0; i < lines.length; i++) {
  const m = assignment.exec(lines[i]!)
  if (!m || !m[1]!.endsWith('_PRIVATE_KEY') || m[2]!.trim() !== '') continue
  lines[i] = `${m[1]}=${generatePrivateKey()}`
  created.push(m[1]!)
}

writeFileSync(envUrl, lines.join('\n'), { mode: 0o600 })
chmodSync(envUrl, 0o600)

const env = new Map(
  lines.flatMap((l) => {
    const m = assignment.exec(l)
    return m ? [[m[1]!, m[2]!.trim()] as const] : []
  }),
)
console.log(`${existed ? 'updated' : 'created'} .env (mode 600); new keys: ${created.join(', ') || 'none'}\n`)
const addresses = new Map<string, string>()
for (const [name, value] of env) {
  if (!name.endsWith('_PRIVATE_KEY') || value === '') continue
  if (!isHex(value) || size(value as Hex) !== 32) {
    console.log(`${name.padEnd(22)} (not a 32-byte hex key — fix it by hand)`)
    continue
  }
  const address = privateKeyToAccount(value as Hex).address
  addresses.set(name, address)
  console.log(`${name.padEnd(22)} ${address}${created.includes(name) ? '  (new)' : ''}`)
}

const rpc = env.get('TEMPO_RPC_URL') || MODERATO.rpcUrl
const payers = ['DEPLOYER_PRIVATE_KEY', 'VENDOR_PRIVATE_KEY', 'RELAYER_PRIVATE_KEY', 'AGENT_PRIVATE_KEY']
console.log('\nFund the fee-paying keys from the Moderato testnet faucet (the verifier needs no funds):')
for (const name of payers) {
  const address = addresses.get(name)
  if (address) console.log(`  cast rpc tempo_fundAddress ${address} --rpc-url ${rpc}`)
}
