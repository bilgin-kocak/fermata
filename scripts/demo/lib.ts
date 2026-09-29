// Shared by the demo scripts: the running stack (out/demo/stack.json), clients, a funded agent paying
// through mppx with the `fermata` method, and formatting helpers.
import { readFileSync } from 'node:fs'
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { fermata, tempoChain, tip20Abi, TOKENS } from '@fermata/sdk'
import { loadDotEnv, parseArgs } from '../lib/args.ts'

loadDotEnv()
export const args = parseArgs()

export type Stack = {
  chain: 'anvil' | 'moderato'
  rpc: string
  escrow: Address
  gateway: string
  attestor: string
  verifier: Address
  explorer: string | null
  services: { quote: Hex; ok: Hex; e500: Hex; hang: Hex }
}

export const stack: Stack = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../out/demo/stack.json', import.meta.url), 'utf8'))
  } catch {
    throw new Error('no demo stack: run `bash scripts/demo-stack.sh up --chain anvil` first')
  }
})()
if (typeof args.chain === 'string' && args.chain !== stack.chain) {
  throw new Error(`the running stack is on ${stack.chain}, not ${args.chain}: restart it with --chain ${args.chain}`)
}

export const TOKEN = TOKENS.pathUSD as Address
export const chain = tempoChain(stack.rpc)
export const client = createPublicClient({ chain, transport: http(stack.rpc) })
export const link = (hash?: string | null) => (!hash ? '-' : stack.explorer ? `${stack.explorer}/tx/${hash}` : hash)
export const short = (h: string) => `${h.slice(0, 10)}…`
export const receiptOf = (res: Response) => Receipt.fromResponse(res) as Receipt.Receipt & Record<string, any>

/** A fresh agent, funded from anvil dev account 0 or (moderato) the deployer key in .env. */
export async function fundedAgent(amount: bigint) {
  const funderKey = (stack.chain === 'anvil'
    ? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    : process.env.DEPLOYER_PRIVATE_KEY) as Hex | undefined
  if (!funderKey) throw new Error('DEPLOYER_PRIVATE_KEY is not set (it funds the demo agent)')
  const funder = createWalletClient({ account: privateKeyToAccount(funderKey), chain, transport: http(stack.rpc) })
  const account = privateKeyToAccount(generatePrivateKey())
  const hash = await funder.writeContract({ address: TOKEN, abi: tip20Abi, functionName: 'transfer', args: [account.address, amount] })
  const r = await client.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`funding reverted: ${hash}`)
  const wallet = createWalletClient({ account, chain, transport: http(stack.rpc) })
  const mppx = Mppx.create({
    methods: [fermata({ wallet, client: client as never, trustedVerifiers: [stack.verifier], escrows: [stack.escrow] })],
    polyfill: false,
  })
  const pay = (service: Hex, path = '/v1/quote?symbol=BTC-USD') =>
    mppx.fetch(`${stack.gateway}/s/${service}${path}`, { headers: { accept: 'application/json' } })
  return { account, wallet, pay, fundTx: hash, fundBlock: r.blockNumber }
}

export async function gw<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${stack.gateway}${path}`, init)
  return (await res.json()) as T
}

/** Fixed-width table. */
export function table(head: string[], rows: (string | number)[][]) {
  const cells = [head, ...rows.map((r) => r.map(String))]
  const w = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)))
  const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i]!)).join('  ')
  return [line(head), w.map((n) => '-'.repeat(n)).join('  '), ...cells.slice(1).map(line)].join('\n')
}

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
