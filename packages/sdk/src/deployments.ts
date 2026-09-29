import type { Address, Hex } from 'viem'
import deployments from './deployments.json' with { type: 'json' }

export type EscrowNetwork = 'anvil' | 'moderato'

export type EscrowDeployment = {
  chainId: number
  address: Address
  deployTx: Hex
  deployBlock: number
  deployGasUsed: number
  deployer: Address
  owner: Address
  treasury: Address
  feeBps: number
  deployedAt: string
  explorer?: string
}

/** The FermataEscrow deployment recorded for `network`, if any (written by scripts/export-deployment.ts). */
export function escrowDeployment(network: EscrowNetwork): EscrowDeployment | undefined {
  const networks = deployments.FermataEscrow.networks as Record<string, EscrowDeployment | undefined>
  return networks[network]
}
