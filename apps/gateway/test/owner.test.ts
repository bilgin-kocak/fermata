import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { checkOwner, ownerInstructions, txtNamesPayout, wellKnownNamesPayout } from '../src/owner.ts'

const payout = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const other = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address
const publicDns = async () => ['93.184.216.34']
const noTxt = async () => {
  throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' })
}
const noFile = async () => {
  throw new Error('HTTP 404')
}

describe('ownership proof matching', () => {
  it('a TXT record must name exactly this payout (any case, a record split in chunks is joined)', () => {
    expect(txtNamesPayout([['fermata-payout=', payout.toLowerCase()]], payout)).toBe(true)
    expect(txtNamesPayout([['v=spf1 -all'], [`fermata-payout=${payout}`]], payout)).toBe(true)
    expect(txtNamesPayout([[`fermata-payout=${other}`]], payout)).toBe(false)
    expect(txtNamesPayout([[`fermata-payout=${payout} extra`]], payout)).toBe(false)
    expect(txtNamesPayout([], payout)).toBe(false)
  })

  it('the well-known file must hold {"payout": <this payout>}', () => {
    expect(wellKnownNamesPayout(JSON.stringify({ payout }), payout)).toBe(true)
    expect(wellKnownNamesPayout(JSON.stringify({ payout: other }), payout)).toBe(false)
    expect(wellKnownNamesPayout('not json', payout)).toBe(false)
    expect(wellKnownNamesPayout(JSON.stringify({ payout: 'nope' }), payout)).toBe(false)
    expect(wellKnownNamesPayout('null', payout)).toBe(false)
  })

  it('tells the lister exactly what to publish', () => {
    expect(ownerInstructions('api.example.com', payout)).toEqual({
      dns: { name: '_fermata.api.example.com', type: 'TXT', value: `fermata-payout=${payout}` },
      wellKnown: { url: 'https://api.example.com/.well-known/fermata.json', body: JSON.stringify({ payout }) },
    })
  })
})

describe('checkOwner', () => {
  const now = () => Date.parse('2026-11-18T10:00:00Z')

  it('verifies by DNS first, at _fermata.<exact host>', async () => {
    const asked: string[] = []
    const r = await checkOwner('api.example.com', payout, { resolveTxt: async (n) => (asked.push(n), [[`fermata-payout=${payout}`]]), resolve: publicDns, fetchWellKnown: noFile, now })
    expect(r).toEqual({ verified: true, method: 'dns', checkedAt: '2026-11-18T10:00:00.000Z', detail: `TXT _fermata.api.example.com names ${payout}` })
    expect(asked).toEqual(['_fermata.api.example.com'])
  })

  it('falls back to the well-known file', async () => {
    const r = await checkOwner('api.example.com', payout, { resolveTxt: noTxt, resolve: publicDns, fetchWellKnown: async () => JSON.stringify({ payout }), now })
    expect(r).toMatchObject({ verified: true, method: 'well-known' })
  })

  it('a proof for another payout does not count, and the reasons for both ways are given', async () => {
    const r = await checkOwner('api.example.com', payout, {
      resolveTxt: async () => [[`fermata-payout=${other}`]],
      resolve: publicDns,
      fetchWellKnown: async () => JSON.stringify({ payout: other }),
      now,
    })
    expect(r.verified).toBe(false)
    expect(r.detail).toContain('does not say fermata-payout=')
    expect(r.detail).toContain('does not contain {"payout"')
  })

  it('never fetches the well-known file from a private address, and never throws', async () => {
    let fetched = false
    const r = await checkOwner('api.example.com', payout, {
      resolveTxt: noTxt,
      resolve: async () => ['10.0.0.5'],
      fetchWellKnown: async () => ((fetched = true), JSON.stringify({ payout })),
      now,
    })
    expect(fetched).toBe(false)
    expect(r).toMatchObject({ verified: false })
    expect(r.detail).toMatch(/no TXT record at _fermata.api.example.com; .*non-public address/)
  })

  it('a DNS failure that is not "no record" is reported as such, and a slow lookup times out', async () => {
    const r = await checkOwner('api.example.com', payout, { resolveTxt: async () => Promise.reject(Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' })), resolve: publicDns, fetchWellKnown: noFile, now })
    expect(r.detail).toMatch(/DNS lookup of _fermata.api.example.com failed \(SERVFAIL\)/)
  })
})

describe('fetchWellKnown (a local HTTPS server with a throwaway CA)', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const https = await import('node:https')
  const { fetchWellKnown } = await import('../src/owner.ts')
  const dir = mkdtempSync(path.join(tmpdir(), 'fermata-owner-'))
  const sh = (...a: string[]) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' })
  sh('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=test CA')
  sh('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=api.example.test')
  execFileSync('bash', ['-c', 'printf "subjectAltName=DNS:api.example.test" > ext.cnf'], { cwd: dir })
  sh('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '1', '-extfile', 'ext.cnf')
  const ca = [readFileSync(path.join(dir, 'ca.pem'), 'utf8')]
  let reply: (res: import('node:http').ServerResponse) => void = (res) => res.end()
  const server = https.createServer({ key: readFileSync(path.join(dir, 'leaf.key')), cert: readFileSync(path.join(dir, 'leaf.pem')) }, (req, res) => {
    if (req.url !== '/.well-known/fermata.json') return void res.writeHead(404).end()
    reply(res)
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as { port: number }).port
  const t = { url: new URL('https://api.example.test/'), origin: 'https://api.example.test', host: 'api.example.test', target: '/', addresses: ['127.0.0.1'] }
  const get = () => fetchWellKnown(t, { ca, port })

  it('returns the body of a 200 (chunked or not)', async () => {
    reply = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ payout }))
    expect(JSON.parse(await get())).toEqual({ payout })
    reply = (res) => (res.writeHead(200, { 'content-type': 'application/json' }), res.write('{"payout":'), res.end(`"${payout}"}`))
    expect(JSON.parse(await get())).toEqual({ payout })
  })

  it('refuses redirects, other statuses and large files', async () => {
    reply = (res) => res.writeHead(302, { location: 'https://evil.example/' }).end()
    await expect(get()).rejects.toThrow(/redirects are not followed/)
    reply = (res) => res.writeHead(500).end()
    await expect(get()).rejects.toThrow(/HTTP 500/)
    reply = (res) => res.writeHead(200).end('x'.repeat(5000))
    await expect(get()).rejects.toThrow(/larger than 4096 bytes/)
  })

  it('checks the certificate: a server it does not trust is refused', async () => {
    await expect(fetchWellKnown(t, { port })).rejects.toThrow() // Mozilla's roots only: the test CA is unknown
    server.close()
  })
})
