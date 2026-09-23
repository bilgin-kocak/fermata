// Probe 3: fund a fresh agent, sign an EIP-2612 permit for PullProbe, call pull() (permit +
// transferFromWithMemo in one tx), read the TransferWithMemo log back by memo, report fees.
// Usage: tsx script/probe.ts --chain anvil|moderato [--rpc URL] [--deployer-pk 0x..]
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi, domainSeparator, decodeEventLog,
  getContractAddress, keccak256, toHex, type Hex, type Address,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : []).filter(Boolean))
const chainName = args.chain ?? 'anvil'
const rpc = args.rpc ?? (chainName === 'moderato' ? 'https://rpc.moderato.tempo.xyz' : 'http://127.0.0.1:8546')
const explorer = chainName === 'moderato' ? 'https://explore.testnet.tempo.xyz' : undefined
const PATH_USD: Address = '0x20c0000000000000000000000000000000000000'
const FEE_SINK = '0xfeec000000000000000000000000000000000000'
const chain = defineChain({ id: 42431, name: chainName, nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 6 }, rpcUrls: { default: { http: [rpc] } } })

const tip20 = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function nonces(address) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
])
const pullAbi = parseAbi([
  'function pull(address token, address from, uint256 amount, bytes32 memo, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'event Pulled(address indexed token, address indexed from, uint256 amount, bytes32 indexed memo)',
])

const pub = createPublicClient({ chain, transport: http(rpc) })
// deployer / relayer: anvil dev account 0 locally, MODERATO_PK on testnet
const deployerPk = (args['deployer-pk'] ?? process.env.MODERATO_PK ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as Hex
const deployer = privateKeyToAccount(deployerPk)
const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) })
const agentPk = generatePrivateKey()
const agent = privateKeyToAccount(agentPk)
const log = (o: unknown) => console.log(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))

// 1. fund the fresh agent (needs pathUSD for the hold AND for its own fees if it ever sends txs)
if (chainName === 'moderato') {
  const hashes = await pub.request({ method: 'tempo_fundAddress' as never, params: [agent.address] as never })
  log({ step: 'faucet', agent: agent.address, txHashes: hashes })
  for (const h of hashes as Hex[]) await pub.waitForTransactionReceipt({ hash: h })
} else {
  const h = await wallet.writeContract({ address: PATH_USD, abi: tip20, functionName: 'transfer', args: [agent.address, 1_000_000_000n] })
  await pub.waitForTransactionReceipt({ hash: h })
  log({ step: 'fund-from-dev0', agent: agent.address, tx: h })
}

// 2. deploy PullProbe
const artifact = JSON.parse(readFileSync(new URL('../out/PullProbe.sol/PullProbe.json', import.meta.url), 'utf8'))
const deployHash = await wallet.deployContract({ abi: pullAbi, bytecode: artifact.bytecode.object as Hex })
const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash })
const probe = deployRcpt.contractAddress ?? getContractAddress({ from: deployer.address, nonce: BigInt(await pub.getTransactionCount({ address: deployer.address })) - 1n })
log({ step: 'deploy', probe, tx: deployHash, explorer: explorer && `${explorer}/tx/${deployHash}` })

// 3. permit (EIP-2612, domain from the token itself)
const [name, sep, nonce, symbol, decimals] = await Promise.all([
  pub.readContract({ address: PATH_USD, abi: tip20, functionName: 'name' }),
  pub.readContract({ address: PATH_USD, abi: tip20, functionName: 'DOMAIN_SEPARATOR' }),
  pub.readContract({ address: PATH_USD, abi: tip20, functionName: 'nonces', args: [agent.address] }),
  pub.readContract({ address: PATH_USD, abi: tip20, functionName: 'symbol' }),
  pub.readContract({ address: PATH_USD, abi: tip20, functionName: 'decimals' }),
])
const domain = { name, version: '1', chainId: 42431, verifyingContract: PATH_USD } as const
const computed = domainSeparator({ domain })
if (computed !== sep) throw new Error(`DOMAIN_SEPARATOR mismatch: token ${sep} vs computed ${computed} (name=${JSON.stringify(name)})`)
log({ step: 'domain', name, symbol, decimals, domainSeparator: sep, nonce })
const amount = 10_000n // 0.01 pathUSD
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
const sig = await agent.signTypedData({
  domain,
  types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  primaryType: 'Permit',
  message: { owner: agent.address, spender: probe, value: amount, nonce, deadline },
})
const r = `0x${sig.slice(2, 66)}` as Hex, s = `0x${sig.slice(66, 130)}` as Hex, v = Number.parseInt(sig.slice(130, 132), 16)
const memo = keccak256(toHex(randomBytes(16))) // callId
const [agentBefore, relayerBefore, relayerAlphaBefore] = await Promise.all([
  pub.readContract({ address: PATH_USD, abi: tip20, functionName: 'balanceOf', args: [agent.address] }),
  pub.readContract({ address: PATH_USD, abi: tip20, functionName: 'balanceOf', args: [deployer.address] }),
  pub.readContract({ address: '0x20c0000000000000000000000000000000000001', abi: tip20, functionName: 'balanceOf', args: [deployer.address] }),
])

// 4. pull (relayer pays gas; agent's permit authorises the pull)
const pullHash = await wallet.writeContract({ address: probe, abi: pullAbi, functionName: 'pull', args: [PATH_USD, agent.address, amount, memo, deadline, v, r, s] })
const rcpt = await pub.waitForTransactionReceipt({ hash: pullHash })
if (rcpt.status !== 'success') throw new Error('pull reverted')

// 5. read the memo back from logs, by memo topic, bounded to the receipt block
const memoLogs = await pub.getContractEvents({ address: PATH_USD, abi: tip20, eventName: 'TransferWithMemo', args: { memo }, fromBlock: rcpt.blockNumber, toBlock: rcpt.blockNumber })
if (memoLogs.length !== 1) throw new Error(`expected 1 TransferWithMemo with memo, got ${memoLogs.length}`)
const m = memoLogs[0].args
const eq = (a?: string, b?: string) => a?.toLowerCase() === b?.toLowerCase()
if (!eq(m.from, agent.address) || !eq(m.to, probe) || m.amount !== amount) throw new Error(`TransferWithMemo args mismatch: ${JSON.stringify({ from: m.from, to: m.to, amount: String(m.amount) })}`)

// 6. fee observation: any Transfer to the fee sink in this receipt
const fees = rcpt.logs.flatMap((l) => {
  try { const d = decodeEventLog({ abi: tip20, data: l.data, topics: l.topics }); return d.eventName === 'Transfer' && (d.args as { to: string }).to.toLowerCase() === FEE_SINK ? [{ token: l.address, amount: (d.args as { amount: bigint }).amount }] : [] } catch { return [] }
})
const [agentAfter, relayerAfter, relayerAlphaAfter, nonceAfter] = await Promise.all([
  pub.readContract({ address: PATH_USD, abi: tip20, functionName: 'balanceOf', args: [agent.address] }),
  pub.readContract({ address: PATH_USD, abi: tip20, functionName: 'balanceOf', args: [deployer.address] }),
  pub.readContract({ address: '0x20c0000000000000000000000000000000000001', abi: tip20, functionName: 'balanceOf', args: [deployer.address] }),
  pub.readContract({ address: PATH_USD, abi: tip20, functionName: 'nonces', args: [agent.address] }),
])
const tx = await pub.getTransaction({ hash: pullHash })
log({
  step: 'pull', tx: pullHash, explorer: explorer && `${explorer}/tx/${pullHash}`, block: rcpt.blockNumber, gasUsed: rcpt.gasUsed, txType: tx.type,
  memo, memoLog: { from: m.from, to: m.to, amount: m.amount },
  agentDelta: agentAfter - agentBefore, relayerPathUsdDelta: relayerAfter - relayerBefore, relayerAlphaUsdDelta: relayerAlphaAfter - relayerAlphaBefore,
  feeTransfers: fees, nonceAfter, feeTokenSet: false,
})
console.log(`OK: TransferWithMemo memo=${memo} agent -${amount} pathUSD; fees ${fees.map((f) => `${f.amount} from ${f.token}`).join(', ') || 'none in logs'}`)
