import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { canonicalPredicate, checkSample, draftPredicate, guardUrl, isPublicAddress, onboardRoutes, type OnboardDeps, type RegisterInput, type Sample } from '../src/onboard.ts'

const sample = (over: Partial<Sample> = {}): Sample => ({
  status: 200, contentType: 'application/json; charset=utf-8', bodyBytes: 54, body: '{"latest":"0.12.0","main":"x"}', json: { latest: '0.12.0', main: 'x' },
  tls: { protocol: 'TLSv1.2', cipher: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', group: 'prime256v1', issuer: 'Google Trust Services' }, ...over,
})
const resolver = (map: Record<string, string[]>) => async (h: string) => map[h] ?? []

describe('isPublicAddress', () => {
  it.each([
    ['8.8.8.8', true], ['104.16.0.1', true], ['2606:4700::6810:1', true],
    ['10.0.0.1', false], ['127.0.0.1', false], ['169.254.169.254', false], ['172.16.5.4', false], ['172.31.255.255', false],
    ['192.168.1.1', false], ['100.64.0.1', false], ['0.0.0.0', false], ['224.0.0.1', false], ['192.0.2.1', false], ['198.18.0.1', false],
    ['::1', false], ['::', false], ['fd00::1', false], ['fe80::1', false], ['::ffff:10.0.0.1', false], ['::ffff:8.8.8.8', true], ['2001:db8::1', false],
  ])('%s → %s', (ip, ok) => expect(isPublicAddress(ip)).toBe(ok))
})

describe('guardUrl', () => {
  const r = resolver({ 'api.example.com': ['93.184.216.34'], 'internal.example.com': ['10.1.2.3'], 'mixed.example.com': ['93.184.216.34', '127.0.0.1'], 'meta.example.com': ['169.254.169.254'] })
  it('accepts a public https API and keeps path + query', async () => {
    const t = await guardUrl('https://api.example.com/v1/x?y=1', r)
    expect(t).toMatchObject({ origin: 'https://api.example.com', host: 'api.example.com', target: '/v1/x?y=1', addresses: ['93.184.216.34'] })
  })
  it.each([
    ['http://api.example.com/', 'https'],
    ['https://api.example.com:8443/', 'port 443'],
    ['https://93.184.216.34/', 'DNS name'],
    ['https://[2606:4700::1]/', 'DNS name'],
    ['https://localhost/', 'public DNS name'],
    ['https://printer.local/', 'public DNS name'],
    ['https://user:pw@api.example.com/', 'credentials'],
    ['https://internal.example.com/', 'non-public'],
    ['https://mixed.example.com/', 'non-public'],
    ['https://meta.example.com/latest/meta-data', 'non-public'],
    ['https://nowhere.example.com/', 'does not resolve'],
    ['not a url', 'valid URL'],
  ])('rejects %s', async (url, why) => {
    await expect(guardUrl(url, r)).rejects.toThrow(why)
  })
})

describe('predicates', () => {
  it('drafts status, media type, ≈2× size and the top-level JSON keys', () => {
    expect(draftPredicate(sample())).toEqual({
      version: 1, status: [200], maxBodyBytes: 1024, contentType: 'application/json',
      jsonSchema: { type: 'object', required: ['latest', 'main'], properties: { latest: { type: 'string' }, main: { type: 'string' } } },
    })
    expect(draftPredicate(sample({ json: undefined, contentType: 'text/plain', bodyBytes: 9000 }))).toEqual({ version: 1, status: [200], maxBodyBytes: 16000, contentType: 'text/plain' })
  })
  it('canonical bytes are stable and validated', () => {
    const p = draftPredicate(sample())
    expect(new TextDecoder().decode(canonicalPredicate(p))).toBe('{"version":1,"status":[200],"maxBodyBytes":1024,"contentType":"application/json","jsonSchema":{"type":"object","required":["latest","main"],"properties":{"latest":{"type":"string"},"main":{"type":"string"}}}}')
    expect(() => canonicalPredicate({ ...p, version: 2 })).toThrow('version')
    expect(() => canonicalPredicate({ ...p, status: [] })).toThrow('status')
    expect(() => canonicalPredicate({ ...p, maxBodyBytes: 99_999 })).toThrow('maxBodyBytes')
    expect(() => canonicalPredicate({ ...p, contentType: 'json; drop table' })).toThrow('media type')
    expect(() => canonicalPredicate({ ...p, jsonSchema: { type: 'object', required: ['nope'], properties: {} } })).toThrow('required')
  })
  it('checkSample applies the attestor’s checks', () => {
    const p = draftPredicate(sample())
    expect(checkSample(p, sample())).toEqual([])
    expect(checkSample(p, sample({ status: 404 }))).toEqual(['status 404 not in [200]'])
    expect(checkSample(p, sample({ json: { latest: 1 } })).join()).toContain('"main" missing')
    expect(checkSample(p, sample({ json: { latest: 1, main: 'x' } })).join()).toContain('"latest" is number')
  })
})

describe('onboarding routes', () => {
  function setup(over: Partial<OnboardDeps> = {}) {
    const registered: RegisterInput[] = []
    const app = new Hono()
    onboardRoutes(app, {
      resolve: resolver({ 'registry.npmjs.org': ['104.16.0.34'], 'evil.example.com': ['10.0.0.5'] }),
      probe: async () => sample(),
      register: async (i) => (registered.push(i), { serviceId: `0x${'aa'.repeat(32)}`, txHash: `0x${'bb'.repeat(32)}`, endpoint: '/s/0xaa/x', tool: i.toolName }),
      trustProxy: true,
      ...over,
    })
    const post = (route: string, body: unknown, ip = '203.0.113.9') =>
      app.request(route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) })
    return { post, registered }
  }
  const good = { url: 'https://registry.npmjs.org/-/package/mppx/dist-tags', label: 'npm-tags2', payout: '0x00000000000000000000000000000000000000a9', price: '0.02', predicate: draftPredicate(sample()) }

  it('probe returns the sample and the drafted predicate', async () => {
    const res = await setup().post('/onboard/probe', { url: good.url })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, origin: 'https://registry.npmjs.org', examplePath: '/-/package/mppx/dist-tags', predicate: { status: [200] } })
  })
  it('probe refuses private targets before any connection', async () => {
    let probed = false
    const res = await setup({ probe: async () => ((probed = true), sample()) }).post('/onboard/probe', { url: 'https://evil.example.com/' })
    expect(res.status).toBe(400)
    expect(probed).toBe(false)
  })
  it('register: re-probes, checks the sample against the predicate, then registers', async () => {
    const s = setup()
    const res = await s.post('/onboard/register', good)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, tool: 'call_npm_tags2' })
    expect(s.registered[0]).toMatchObject({ origin: 'https://registry.npmjs.org', examplePath: '/-/package/mppx/dist-tags', label: 'npm-tags2', price: 20_000n })
  })
  it('register refuses a predicate the vendor’s current answer fails', async () => {
    const s = setup({ probe: async () => sample({ status: 503 }) })
    const res = await s.post('/onboard/register', good)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toContain('status 503')
    expect(s.registered).toEqual([])
  })
  it.each([
    [{ label: 'X' }, 'label'], [{ label: 'way-too-long-label' }, 'label'], [{ payout: '0x12' }, 'payout'],
    [{ price: '5' }, 'price'], [{ price: '0' }, 'price'], [{ toolName: 'Bad Name' }, 'tool name'], [{ predicate: { version: 9 } }, 'predicate'],
  ])('register validates %o', async (patch, why) => {
    const res = await setup().post('/onboard/register', { ...good, ...patch })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain(why)
  })
  it('rate-limits registrations per address', async () => {
    const s = setup({ perIpRegistrationsPerDay: 1 })
    expect((await s.post('/onboard/register', good)).status).toBe(200)
    expect((await s.post('/onboard/register', { ...good, label: 'other' })).status).toBe(429)
    expect((await s.post('/onboard/register', { ...good, label: 'third' }, '198.51.100.1')).status).toBe(200)
  })
  it.each([['get_quote'], ['fermata_call'], ['fermata_anything']])('refuses to take over the tool name %s, without spending the rate limit', async (toolName) => {
    const s = setup({ toolTaken: (n) => n === 'get_quote', perIpRegistrationsPerDay: 1 })
    const res = await s.post('/onboard/register', { ...good, toolName })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('taken')
    expect(s.registered).toEqual([])
    expect((await s.post('/onboard/register', good)).status).toBe(200) // the one daily registration is still there
  })
  it('two simultaneous listings cannot claim the same tool name (even behind a slow DNS lookup)', async () => {
    const slowDns = async (h: string) => (await new Promise((ok) => setTimeout(ok, 20)), h === 'registry.npmjs.org' ? ['104.16.0.34'] : [])
    const s = setup({ resolve: slowDns })
    const [a, b] = await Promise.all([
      s.post('/onboard/register', { ...good, toolName: 'npm_tags' }),
      s.post('/onboard/register', { ...good, label: 'other', toolName: 'npm_tags' }, '198.51.100.1'),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(s.registered).toHaveLength(1)
  })
})
