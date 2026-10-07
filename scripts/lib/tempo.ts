// Script helpers. The Tempo / TIP-20 helpers live in the SDK (packages/sdk/src/tip20.ts).
export { feesPaid, memoMovements, signPermit, tempoChain, tip20Abi, transfers, type Movement } from 'fermata-sdk'

/** JSON.stringify that prints bigints as decimal strings. */
export const toJson = (value: unknown, space?: number) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), space)
