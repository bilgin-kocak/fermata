import { describe, expect, it } from 'vitest'
import { keccak256, toHex, type Hex } from 'viem'
import { ViemChain } from '../src/chain.ts'

const escrow = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const callId = keccak256(toHex('c')) as Hex
const verdict = { callId, serviceId: callId, requestHash: callId, predicateHash: callId, outcome: 1 as const, presentationHash: callId, responseHash: callId, issuedAt: 1n }

function fakes(wait: (a: { hash: Hex; timeout?: number }) => Promise<{ status: string }>) {
  const order: string[] = []
  const relayer = { writeContract: async ({ functionName }: { functionName: string }) => (order.push(functionName), keccak256(toHex(`${functionName}-${order.length}`))) }
  const client = { waitForTransactionReceipt: wait }
  return { order, chain: new ViemChain(client as never, relayer as never, escrow, 42431, 25) }
}

describe('ViemChain writes', () => {
  it('a receipt that does not come within the timeout fails the write (with its tx hash) instead of blocking the queue', async () => {
    const timeouts: (number | undefined)[] = []
    const { chain } = fakes(({ timeout }) => {
      timeouts.push(timeout)
      return new Promise((_, no) => setTimeout(() => no(new Error('Timed out while waiting for transaction')), timeout))
    })
    const r = await chain.settle(callId, verdict, '0x01')
    expect(r).toMatchObject({ ok: false, txHash: expect.stringMatching(/^0x/), error: expect.stringMatching(/Timed out/) })
    expect(timeouts).toEqual([25])
  })

  it('enqueue shares the write queue: a registration from the relayer key never runs between a write and its receipt', async () => {
    let release: () => void = () => {}
    const { chain, order } = fakes(() => new Promise((ok) => (release = () => ok({ status: 'success' }))))
    const settle = chain.settle(callId, verdict, '0x01')
    const register = chain.enqueue(async () => order.push('registerService'))
    await new Promise((ok) => setTimeout(ok, 10))
    expect(order).toEqual(['settle']) // waiting for the settle's receipt
    release()
    expect(await settle).toMatchObject({ ok: true })
    await register
    expect(order).toEqual(['settle', 'registerService'])
  })
})
