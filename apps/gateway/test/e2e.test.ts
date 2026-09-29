// End to end through the whole stack: an agent pays with `fermata` via mppx/client → gateway → escrow
// hold → attestor proves the vendor over TLSNotary → verdict → settle → proved response + receipt.
// Runs against a stack that is already up (scripts/e2e-gateway.sh starts one on Anvil; on Moderato
// start the same services and set the env below). FERMATA_E2E_CHAIN=anvil lets the test fast-forward
// time for the timeout case; on moderato it waits for the window.
//
//   GATEWAY_URL, TEMPO_RPC_URL, FERMATA_ESCROW, VERIFIER_ADDRESS, FUNDER_PRIVATE_KEY,
//   SERVICE_OK, SERVICE_500, SERVICE_HANG
import { describe, expect, it } from 'vitest'
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { createPublicClient, createWalletClient, http, isAddressEqual, keccak256, parseEventLogs, zeroHash, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { fermata, fermataEscrowAbi, reconcile, tempoChain, tip20Abi, TOKENS } from '@fermata/sdk'

const env = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`${k} is not set — run scripts/e2e-gateway.sh`)
  return v
}
const enabled = !!process.env.GATEWAY_URL
const onAnvil = (process.env.FERMATA_E2E_CHAIN ?? 'anvil') === 'anvil'

describe.skipIf(!enabled)('fermata end to end', () => {
  const gw = env('GATEWAY_URL')
  const rpc = env('TEMPO_RPC_URL')
  const escrow = env('FERMATA_ESCROW') as Address
  const token = TOKENS.pathUSD as Address
  const chain = tempoChain(rpc)
  const client = createPublicClient({ chain, transport: http(rpc) })
  const agent = privateKeyToAccount(generatePrivateKey())
  const wallet = createWalletClient({ account: agent, chain, transport: http(rpc) })
  const funder = createWalletClient({ account: privateKeyToAccount(env('FUNDER_PRIVATE_KEY') as Hex), chain, transport: http(rpc) })
  const mppx = Mppx.create({
    methods: [fermata({ wallet, client: client as never, trustedVerifiers: [env('VERIFIER_ADDRESS') as Address], escrows: [escrow] })],
    polyfill: false,
  })
  const pay = (serviceId: string) => mppx.fetch(`${gw}/s/${serviceId}/v1/quote?symbol=BTC-USD`, { headers: { accept: 'application/json' } })
  const receiptOf = (res: Response) => Receipt.fromResponse(res) as Receipt.Receipt & Record<string, any>
  let startBlock = 0n

  it('funds a fresh agent', async () => {
    startBlock = await client.getBlockNumber()
    const hash = await funder.writeContract({ address: token, abi: tip20Abi, functionName: 'transfer', args: [agent.address, 200_000n] })
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe('success')
  })

  it('DELIVERED: the vendor is paid, the agent gets the proved quote', async () => {
    const res = await pay(env('SERVICE_OK'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { price: unknown }
    expect(typeof body.price).toBe('number')
    const r = receiptOf(res)
    expect(r).toMatchObject({ method: 'fermata', status: 'success', outcome: 'DELIVERED' })
    const settle = await client.getTransactionReceipt({ hash: r.txHash })
    const [released] = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Released', logs: settle.logs })
    expect(released?.args.callId).toBe(r.callId)
    expect(released?.args.presentationHash).toBe(r.presentationHash)
    const proof = new Uint8Array(await (await fetch(`${gw}/proofs/${r.callId}`)).arrayBuffer())
    expect(keccak256(proof)).toBe(r.presentationHash)
    const moves = await reconcile(client as never, { token, callId: r.callId, fromBlock: startBlock })
    expect(moves.map((m) => m.amount)).toEqual([10_000n, 9_950n, 50n])
    expect(isAddressEqual(moves[0]!.from, agent.address)).toBe(true)
  }, 120_000)

  it('FAILED: the vendor answered 500, the agent is refunded', async () => {
    const res = await pay(env('SERVICE_500'))
    expect(res.status).toBe(500)
    const r = receiptOf(res)
    expect(r.outcome).toBe('FAILED')
    const moves = await reconcile(client as never, { token, callId: r.callId, fromBlock: startBlock })
    expect(moves.map((m) => [m.amount, m.to.toLowerCase()])).toEqual([
      [10_000n, escrow.toLowerCase()],
      [10_000n, agent.address.toLowerCase()],
    ])
  }, 120_000)

  it('no answer: no verdict, and the gateway sweeper refunds the agent after the window', async () => {
    const res = await pay(env('SERVICE_HANG'))
    expect(res.status).toBe(504)
    const r = receiptOf(res)
    expect(r.outcome).toBe('AWAITING_TIMEOUT')
    const call = (await (await fetch(`${gw}/calls/${r.callId}`)).json()) as { status: string; deadline: string }
    expect(call.status).toBe('awaiting-timeout')
    if (onAnvil) {
      await client.request({ method: 'evm_increaseTime' as never, params: [Number(BigInt(call.deadline) - (await client.getBlock()).timestamp) + 1] as never })
      await client.request({ method: 'evm_mine' as never, params: [] as never })
    }
    let status = call.status
    for (let i = 0; i < 90 && status !== 'timed-out'; i++) {
      await new Promise((ok) => setTimeout(ok, 2_000))
      status = ((await (await fetch(`${gw}/calls/${r.callId}`)).json()) as { status: string }).status
    }
    expect(status).toBe('timed-out')
    const moves = await reconcile(client as never, { token, callId: r.callId, fromBlock: startBlock })
    expect(moves.map((m) => m.amount)).toEqual([10_000n, 10_000n])
    const done = (await (await fetch(`${gw}/calls/${r.callId}`)).json()) as { timeoutTx: Hex }
    const [refunded] = parseEventLogs({ abi: fermataEscrowAbi, eventName: 'Refunded', logs: (await client.getTransactionReceipt({ hash: done.timeoutTx })).logs })
    expect(refunded?.args.presentationHash).toBe(zeroHash)
  }, 300_000)
})
