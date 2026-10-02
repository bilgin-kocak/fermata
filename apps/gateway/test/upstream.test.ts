import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetch } from 'undici'
import { parseResolve, pinnedLookup, upstreamDispatcher } from '../src/upstream.ts'

describe('pinned lookup (GATEWAY_RESOLVE)', () => {
  const lookup = pinnedLookup(parseResolve('vendor.fermata.test:8843=127.0.0.1:8843'))
  const call = (host: string, options: { all?: boolean }) =>
    new Promise<unknown[]>((ok, fail) => lookup(host, options, (err, ...rest) => (err ? fail(err) : ok(rest))))

  it('answers a pinned host with one address', async () => {
    expect(await call('vendor.fermata.test', {})).toEqual(['127.0.0.1', 4])
  })

  it('answers { all: true } with an address list (Node ≥ 22.21 Happy Eyeballs)', async () => {
    expect(await call('vendor.fermata.test', { all: true })).toEqual([[{ address: '127.0.0.1', family: 4 }]])
  })

  it('defers other hosts to DNS', async () => {
    const [address] = await call('localhost', {})
    expect(typeof address).toBe('string')
  })
})

describe('upstream dispatcher', () => {
  let server: Server
  let port: number
  beforeAll(async () => {
    server = createServer((_req, res) => res.end('ok'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('connects to a pinned hostname through undici', async () => {
    const dispatcher = upstreamDispatcher(parseResolve(`vendor.fermata.test:${port}=127.0.0.1:${port}`))
    const res = await fetch(`http://vendor.fermata.test:${port}/v1/quote`, { dispatcher })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    await dispatcher.close()
  })
})
