import type { Account, PublicClient, Transport, WalletClient } from 'viem'

// viem clients on any chain definition: tempoChain(), or viem's own tempoModerato, whose formatters
// change some return types so that its clients are not assignable to the plain PublicClient. The SDK
// reads only fields every Tempo chain definition shares, and narrows these to PublicClient inside.

/** A viem public client on any chain definition. */
export type AnyPublicClient = PublicClient<Transport, any>
/** A viem wallet client with an account, on any chain definition. */
export type AnyWalletClient = WalletClient<Transport, any, Account>
