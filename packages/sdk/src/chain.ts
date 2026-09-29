import type { Address, Hex } from 'viem'

/** Tempo Moderato testnet (chain id 42431). Anvil's Tempo emulation uses the same chain id. */
export const MODERATO = {
  id: 42431,
  rpcUrl: 'https://rpc.moderato.tempo.xyz',
  explorer: 'https://explore.testnet.tempo.xyz',
} as const

/** Testnet stablecoins (TIP-20, 6 decimals). pathUSD is Fermata's default currency. */
export const TOKENS = {
  pathUSD: '0x20C0000000000000000000000000000000000000',
  AlphaUSD: '0x20C0000000000000000000000000000000000001',
  BetaUSD: '0x20C0000000000000000000000000000000000002',
  ThetaUSD: '0x20C0000000000000000000000000000000000003',
} as const satisfies Record<string, Address>

/** Tempo system addresses used by Fermata. */
export const TEMPO = {
  feeManager: '0xfeEC000000000000000000000000000000000000',
  tip403Registry: '0x403c000000000000000000000000000000000000',
  receivePolicyGuard: '0xB10C000000000000000000000000000000000000',
} as const satisfies Record<string, Address>

export const explorerTx = (hash: Hex) => `${MODERATO.explorer}/tx/${hash}`
export const explorerAddress = (address: Address) => `${MODERATO.explorer}/address/${address}`
