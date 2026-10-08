import { describe, expect, it } from 'vitest'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { fermata } from '../src/client.ts'
import { getHold, getService, reconcile } from '../src/escrow.ts'
import { fermataServer } from '../src/server.ts'
import { tempoChain } from '../src/tip20.ts'

// Types only: clients built on viem's own tempoModerato (whose formatters change some return types)
// and on tempoChain() are both accepted. Nothing here touches the network.
describe('viem clients', () => {
  it('accepts clients on viem tempoModerato and on tempoChain()', () => {
    const account = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
    for (const chain of [tempoModerato, tempoChain('http://127.0.0.1:1')]) {
      const client = createPublicClient({ chain, transport: http('http://127.0.0.1:1') })
      const wallet = createWalletClient({ account, chain, transport: http('http://127.0.0.1:1') })
      expect(fermata({ wallet, client, trustedVerifiers: [], escrows: [] }).name).toBe('fermata')
      expect(fermataServer({ client, escrow: account.address, secretKey: 'k' }).name).toBe('fermata')
      expect([typeof getHold, typeof getService, typeof reconcile]).toEqual(['function', 'function', 'function'])
      void (() => [getHold(client, account.address, '0x00'), getService(client, account.address, '0x00'), reconcile(client, { token: account.address, callId: '0x00' })])
    }
  })
})
