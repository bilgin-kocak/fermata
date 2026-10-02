// pnpm fund [--chain moderato] [--rpc URL]
//
// Tops up every fee-paying key in .env from the Tempo testnet faucet (`tempo_fundAddress`, FACTS §4)
// and prints each address with its pathUSD balance. Testnet only: the faucet mints test tokens.
import { createPublicClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoChain, tip20Abi, TOKENS } from '@fermata/sdk'
import { chainArg, loadDotEnv, parseArgs, rpcFor } from './lib/args.ts'

loadDotEnv()
const args = parseArgs()
const chain = chainArg({ chain: 'moderato', ...args })
const rpc = rpcFor(chain, args)
const client = createPublicClient({ chain: tempoChain(rpc), transport: http(rpc) })

const KEYS = ['DEPLOYER_PRIVATE_KEY', 'VENDOR_PRIVATE_KEY', 'RELAYER_PRIVATE_KEY', 'DEMO_AGENT_PRIVATE_KEY', 'ONBOARD_OPERATOR_PRIVATE_KEY', 'AGENT_PRIVATE_KEY']
const wallets = KEYS.flatMap((k) => (process.env[k] ? [{ name: k.replace('_PRIVATE_KEY', '').toLowerCase(), address: privateKeyToAccount(process.env[k] as Hex).address }] : []))
if (wallets.length === 0) throw new Error('no keys in .env: run pnpm keys:init first')

const balance = (a: Address) => client.readContract({ address: TOKENS.pathUSD as Address, abi: tip20Abi, functionName: 'balanceOf', args: [a] })
let failed = 0
for (const w of wallets) {
  try {
    const hashes = (await client.request({ method: 'tempo_fundAddress' as never, params: [w.address] as never })) as Hex[]
    if (hashes?.[0]) await client.waitForTransactionReceipt({ hash: hashes[0], timeout: 60_000 })
    console.log(`funded  ${w.name.padEnd(16)} ${w.address}  ${Number(await balance(w.address)) / 1e6} pathUSD`)
  } catch (e) {
    failed++
    console.log(`FAILED  ${w.name.padEnd(16)} ${w.address}  ${(e as Error).message.split('\n')[0]}`)
  }
}
process.exit(failed ? 1 : 0)
