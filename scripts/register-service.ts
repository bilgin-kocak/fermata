// Registers a vendor service on the escrow with the attestor's registration hashes, and appends it to
// a gateway config file.
//
//   pnpm service:register --chain anvil|moderato --label quote --upstream https://vendor.fermata.test:8443 \
//     --notary-public-key 0x02… --verifier 0x… [--predicate apps/attestor/predicates/quote-v1.json] \
//     [--price 10000] [--window 120] [--config gateway.config.json] [--tempo-amount 0.01] [--rpc URL]
//
// The vendor key is VENDOR_PRIVATE_KEY (moderato) or anvil dev account 2; payouts go to the vendor.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  escrowDeployment,
  fermataEscrowAbi,
  getService,
  notaryKeyHash,
  originHash,
  predicateHash,
  serviceId,
  tempoChain,
  TOKENS,
} from '@fermata/sdk'
import { chainArg, loadDotEnv, parseArgs, rpcFor } from './lib/args.ts'

loadDotEnv()
const args = parseArgs()
const chainName = chainArg(args)
const rpc = rpcFor(chainName, args)
const str = (k: string, d?: string) => {
  const v = args[k]
  if (typeof v === 'string') return v
  if (d !== undefined) return d
  throw new Error(`--${k} is required`)
}
const vendorKey = (chainName === 'anvil'
  ? '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
  : process.env.VENDOR_PRIVATE_KEY) as Hex | undefined
if (!vendorKey) throw new Error('VENDOR_PRIVATE_KEY is not set')
const vendor = privateKeyToAccount(vendorKey)
const escrow = (typeof args.escrow === 'string' ? args.escrow : escrowDeployment(chainName)?.address) as Address
if (!escrow) throw new Error(`no escrow deployment for ${chainName}`)

const chain = tempoChain(rpc)
const client = createPublicClient({ chain, transport: http(rpc) })
const wallet = createWalletClient({ account: vendor, chain, transport: http(rpc) })

const upstream = str('upstream')
const predicate = readFileSync(str('predicate', 'apps/attestor/predicates/quote-v1.json'))
const sid = serviceId(vendor.address, str('label'))
const params = {
  payout: vendor.address,
  token: TOKENS.pathUSD as Address,
  price: BigInt(str('price', '10000')),
  window: Number(str('window', '120')),
  verifier: str('verifier') as Address,
  predicateHash: predicateHash(predicate),
  originHash: originHash(upstream),
  notaryKeyHash: notaryKeyHash(str('notary-public-key') as Hex),
}

const existing = await getService(client, escrow, sid)
if (isAddressEqual(existing.token, zeroAddress)) {
  const hash = await wallet.writeContract({
    address: escrow,
    abi: fermataEscrowAbi,
    functionName: 'registerService',
    args: [sid, params.payout, params.token, params.price, params.window, params.verifier, params.predicateHash, params.originHash, params.notaryKeyHash],
  })
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`registerService reverted: ${hash}`)
  console.error(`registered ${sid} (${upstream}) in ${hash}`)
} else {
  if (existing.originHash !== params.originHash || existing.notaryKeyHash !== params.notaryKeyHash || !isAddressEqual(existing.verifier, params.verifier)) {
    throw new Error(`service ${sid} already registered with different parameters (services are immutable; pick another --label)`)
  }
  console.error(`service ${sid} already registered`)
}

const configPath = str('config', 'gateway.config.json')
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : { escrow, services: [] }
config.escrow = escrow
config.services = (config.services as { serviceId: string }[]).filter((s) => s.serviceId.toLowerCase() !== sid.toLowerCase())
config.services.push({
  serviceId: sid,
  upstream,
  examplePath: str('example-path', '/v1/quote?symbol=BTC-USD'),
  summary: str('summary', `${str('label')} (${upstream})`),
  ...(typeof args['tempo-amount'] === 'string' ? { tempo: { amount: args['tempo-amount'], recipient: vendor.address } } : {}),
  ...(typeof args['upstream-auth-env'] === 'string' ? { upstreamAuth: { header: 'Authorization', env: args['upstream-auth-env'] } } : {}),
})
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
console.log(sid)
