import { describe, expect, it } from 'vitest'
import { Challenge, Errors } from 'mppx'
import { encodeAbiParameters, encodeEventTopics, keccak256, pad, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { fermataEscrowAbi } from '../src/abi.ts'
import { fermata } from '../src/client.ts'
import { fermataServer } from '../src/server.ts'

const escrow = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address
const token = '0x20C0000000000000000000000000000000000000' as Address
const verifier = '0x00000000000000000000000000000000000000Ve'.replace('Ve', 'a1') as Address
const serviceId = pad('0xbe', { size: 32, dir: 'right' })
const requestHash = keccak256(toHex('GET /v1/quote'))
const callId = keccak256(toHex('call-1'))
const agent = '0x000000000000000000000000000000000000a9e1' as Address
const txHash = keccak256(toHex('hold-tx'))

function heldLog(over: Partial<{ callId: Hex; serviceId: Hex; requestHash: Hex; amount: bigint; address: Address }> = {}) {
  const topics = encodeEventTopics({
    abi: fermataEscrowAbi,
    eventName: 'Held',
    args: { callId: over.callId ?? callId, serviceId: over.serviceId ?? serviceId, agent },
  })
  return {
    address: over.address ?? escrow,
    topics,
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [over.amount ?? 10_000n, over.requestHash ?? requestHash]),
    blockNumber: 1n, blockHash: pad('0x1', { size: 32 }), logIndex: 0, transactionHash: txHash, transactionIndex: 0, removed: false,
  }
}

function fakeClient(opts: { logs?: unknown[]; status?: 'success' | 'reverted'; holdStatus?: number; service?: Partial<Record<string, unknown>> } = {}) {
  return {
    getTransactionReceipt: async () => ({ status: opts.status ?? 'success', logs: opts.logs ?? [heldLog()], transactionHash: txHash }),
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'getHold'
        ? { status: opts.holdStatus ?? 1, deadline: 2_000_000_000n }
        : { token, verifier, pricePerCall: 10_000n, ...opts.service },
    getChainId: async () => 42431,
    getBlock: async () => ({ timestamp: 1_700_000_000n }),
  } as never
}

const request = { amount: '10000', currency: token, escrow, chainId: 42431, serviceId, requestHash, callId }

function credential(over: Partial<{ callId: Hex; escrow: Address }> = {}) {
  const challenge = Challenge.from({
    id: 'x', realm: 'test', method: 'fermata', intent: 'charge',
    request: { ...request, escrow: over.escrow ?? escrow },
  } as never)
  return { challenge, payload: { type: 'hold' as const, txHash, callId: over.callId ?? callId } } as never
}

async function validate(client: never, cred = credential()) {
  return fermataServer({ client, escrow }).validate!({ credential: cred, request } as never)
}

describe('fermata server method', () => {
  it('mints a callId per challenge and echoes it on the paid pass', async () => {
    const server = fermataServer({ client: fakeClient(), escrow })
    const a = (await server.request!({ request: { ...request, callId: undefined } } as never)) as { callId: string }
    const b = (await server.request!({ request: { ...request, callId: undefined } } as never)) as { callId: string }
    expect(a.callId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(a.callId).not.toBe(b.callId)
    const echoed = (await server.request!({ request, credential: credential() } as never)) as { callId: string }
    expect(echoed.callId).toBe(callId)
  })

  it('binds route fields but not the callId', () => {
    const bind = fermataServer({ client: fakeClient(), escrow }).stableBinding!
    expect(bind({ ...request, callId: '0x01' } as never)).toEqual(bind({ ...request, callId: '0x02' } as never))
    expect(bind(request as never)).not.toEqual(bind({ ...request, requestHash: keccak256('0x00') } as never))
  })

  it('accepts a matching hold', async () => {
    const v = await validate(fakeClient())
    expect((v.details as { agent: string }).agent.toLowerCase()).toBe(agent)
  })

  it.each([
    ['reverted hold tx', fakeClient({ status: 'reverted' }), /reverted/],
    ['no Held event', fakeClient({ logs: [] }), /no Held event/],
    ['Held from another contract', fakeClient({ logs: [heldLog({ address: token })] }), /no Held event/],
    ['another callId', fakeClient({ logs: [heldLog({ callId: keccak256('0x02') })] }), /no Held event/],
    ['another service', fakeClient({ logs: [heldLog({ serviceId: keccak256('0x03') })] }), /another service/],
    ['another request', fakeClient({ logs: [heldLog({ requestHash: keccak256('0x04') })] }), /another request/],
    ['another amount', fakeClient({ logs: [heldLog({ amount: 1n })] }), /amount/],
    ['hold already settled', fakeClient({ holdStatus: 2 }), /no longer open/],
  ])('rejects %s with a 402', async (_, client, reason) => {
    const err = await validate(client).catch((e) => e)
    expect(err).toBeInstanceOf(Errors.VerificationFailedError)
    expect(String(err.message)).toMatch(reason)
  })

  it('rejects a credential for another callId or escrow', async () => {
    await expect(validate(fakeClient(), credential({ callId: keccak256('0x09') }))).rejects.toThrow(/callId/)
    await expect(validate(fakeClient(), credential({ escrow: token }))).rejects.toThrow(/another escrow/)
  })

  it('claims each callId once', async () => {
    const server = fermataServer({ client: fakeClient(), escrow })
    const receipt = await server.broadcast!({ credential: credential(), request } as never)
    expect(receipt.reference).toBe(txHash)
    await expect(server.broadcast!({ credential: credential(), request } as never)).rejects.toThrow(/already used/)
  })
})

describe('fermata client method', () => {
  const wallet = { account: privateKeyToAccount(pad('0x01', { size: 32 })), writeContract: async () => { throw new Error('must not pay') } } as never
  const challenge = (over: Partial<typeof request> = {}) =>
    Challenge.from({ id: 'x', realm: 'test', method: 'fermata', intent: 'charge', request: { ...request, ...over } } as never)
  const create = (client: never, c = challenge()) =>
    fermata({ wallet, client, trustedVerifiers: [verifier], escrows: [escrow] }).createCredential({ challenge: c } as never)

  it.each([
    ['an untrusted escrow', fakeClient(), challenge({ escrow: token }), /untrusted escrow/],
    ['another chain', fakeClient(), challenge({ chainId: 1 }), /chain/],
    ['an unknown service', fakeClient({ service: { token: '0x0000000000000000000000000000000000000000' } }), challenge(), /unknown service/],
    ['an untrusted verifier', fakeClient({ service: { verifier: agent } }), challenge(), /trusted verifier/],
    ['another token', fakeClient(), challenge({ currency: agent }), /trusted verifier|token/],
    ['a price mismatch', fakeClient(), challenge({ amount: '20000' }), /registered price/],
  ])('refuses %s before any money moves', async (_, client, c, reason) => {
    await expect(create(client, c)).rejects.toThrow(reason)
  })
})
