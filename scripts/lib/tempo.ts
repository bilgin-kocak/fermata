// Tempo helpers shared by the repo scripts: chain definition, TIP-20 ABI (with its errors, so bubbled
// precompile reverts decode), EIP-2612 permits, and fee / memo extraction from receipts.
import {
  decodeEventLog,
  defineChain,
  domainSeparator,
  isAddressEqual,
  parseAbi,
  parseSignature,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
} from 'viem'
import { MODERATO, TEMPO } from '@fermata/sdk'

/** Moderato (42431) and Anvil's Tempo emulation share the chain id. Fees are paid in USD stablecoins. */
export function tempoChain(rpc: string) {
  return defineChain({
    id: MODERATO.id,
    name: 'Tempo Moderato',
    nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: 'Tempo Explorer', url: MODERATO.explorer } },
  })
}

/** Subset of tempo-std ITIP20 used by the scripts (signatures as in contracts/src/interfaces/ITIP20.sol). */
export const tip20Abi = parseAbi([
  'function name() view returns (string)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Approval(address indexed owner, address indexed spender, uint256 amount)',
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
  'error ContractPaused()',
  'error InsufficientAllowance()',
  'error InsufficientBalance(uint256 currentBalance, uint256 expectedBalance, address token)',
  'error InvalidRecipient()',
  'error PolicyForbids()',
  'error PermitExpired()',
  'error InvalidSignature()',
])

const permitTypes = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

/**
 * Signs an EIP-2612 permit for a TIP-20 token. The domain is rebuilt from the token's name and
 * checked against the token's own DOMAIN_SEPARATOR, so a wrong assumption fails here, not on-chain.
 */
export async function signPermit(
  client: PublicClient,
  token: Address,
  owner: LocalAccount,
  spender: Address,
  value: bigint,
  deadline: bigint,
): Promise<{ v: number; r: Hex; s: Hex }> {
  const [name, nonce, onChain, chainId] = await Promise.all([
    client.readContract({ address: token, abi: tip20Abi, functionName: 'name' }),
    client.readContract({ address: token, abi: tip20Abi, functionName: 'nonces', args: [owner.address] }),
    client.readContract({ address: token, abi: tip20Abi, functionName: 'DOMAIN_SEPARATOR' }),
    client.getChainId(),
  ])
  const domain = { name, version: '1', chainId, verifyingContract: token } as const
  if (domainSeparator({ domain }) !== onChain) throw new Error(`permit domain mismatch for ${token} (name ${name})`)
  const signature = await owner.signTypedData({
    domain,
    types: permitTypes,
    primaryType: 'Permit',
    message: { owner: owner.address, spender, value, nonce, deadline },
  })
  const { r, s, v } = parseSignature(signature)
  return { v: Number(v), r, s }
}

export type Movement = { token: Address; from: Address; to: Address; amount: bigint }

function decodeTip20(log: { data: Hex; topics: [Hex, ...Hex[]] | [] }) {
  try {
    return decodeEventLog({ abi: tip20Abi, data: log.data, topics: log.topics })
  } catch {
    return undefined
  }
}

/** Transaction fees in a receipt: TIP-20 `Transfer`s to Tempo's FeeManager. */
export function feesPaid(receipt: TransactionReceipt): Movement[] {
  return receipt.logs.flatMap((log) => {
    const ev = decodeTip20(log)
    if (ev?.eventName !== 'Transfer' || !isAddressEqual(ev.args.to, TEMPO.feeManager)) return []
    return [{ token: log.address, from: ev.args.from, to: ev.args.to, amount: ev.args.amount }]
  })
}

/**
 * Token movements tagged with `memo` in a receipt. Each `TransferWithMemo` must directly follow the
 * `Transfer` it annotates (same token, from, to and amount); anything else throws.
 */
export function memoMovements(receipt: TransactionReceipt, memo: Hex): Movement[] {
  const out: Movement[] = []
  receipt.logs.forEach((log, i) => {
    const ev = decodeTip20(log)
    if (ev?.eventName !== 'TransferWithMemo' || ev.args.memo !== memo) return
    const prev = i > 0 ? receipt.logs[i - 1] : undefined
    const t = prev && isAddressEqual(prev.address, log.address) ? decodeTip20(prev) : undefined
    if (
      t?.eventName !== 'Transfer' ||
      !isAddressEqual(t.args.from, ev.args.from) ||
      !isAddressEqual(t.args.to, ev.args.to) ||
      t.args.amount !== ev.args.amount
    ) {
      throw new Error(`TransferWithMemo at log ${log.logIndex} is not preceded by its Transfer`)
    }
    out.push({ token: log.address, from: ev.args.from, to: ev.args.to, amount: ev.args.amount })
  })
  return out
}

/** Every TIP-20 `Transfer` in a receipt, fees included. */
export function transfers(receipt: TransactionReceipt): Movement[] {
  return receipt.logs.flatMap((log) => {
    const ev = decodeTip20(log)
    if (ev?.eventName !== 'Transfer') return []
    return [{ token: log.address, from: ev.args.from, to: ev.args.to, amount: ev.args.amount }]
  })
}

/** JSON.stringify that prints bigints as decimal strings. */
export const toJson = (value: unknown, space?: number) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), space)
