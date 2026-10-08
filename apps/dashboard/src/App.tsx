import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type Call, type DemoResult, type DemoStatus, type EscrowEvent, type Info, type Predicate, type ProbeResult, type Reconciliation, type RegisterResult, type Reverify, type Scores, type Service } from './api.ts'
import { STATUS, age, bytes, serviceLabel, short, usd } from './format.ts'

type Tab = 'live' | 'vendors' | 'onboard' | 'use' | 'reconciliation' | 'services'

/** The public live demo: the gateway fermata-mcp uses when it is given no settings. */
const LIVE_DEMO = 'https://fermata-production-9378.up.railway.app'

function usePoll<T>(load: () => Promise<T>, ms: number) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let alive = true
    const tick = () =>
      load()
        .then((d) => alive && (setData(d), setError(undefined)))
        .catch((e: Error) => alive && setError(e.message))
    tick()
    const id = setInterval(tick, ms)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [load, ms])
  return { data, error }
}

/** The fermata sign (𝄐), drawn so it renders without a music font. */
function Fermata() {
  return (
    <svg className="glyph" viewBox="0 0 40 24" width="34" height="21" aria-label="fermata" role="img">
      <path d="M3 21 A17 17 0 0 1 37 21" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="20" cy="17.5" r="3.4" fill="currentColor" />
    </svg>
  )
}

function TxLink({ hash, info }: { hash?: string | null; info?: Info }) {
  if (!hash) return <span className="muted">—</span>
  return info?.explorer ? (
    <a className="mono" href={`${info.explorer}/tx/${hash}`} target="_blank" rel="noreferrer" title={hash}>
      {short(hash)}
    </a>
  ) : (
    <span className="mono" title={hash}>
      {short(hash)}
    </span>
  )
}

function StatusChip({ status }: { status: Call['status'] }) {
  const s = STATUS[status]
  return (
    <span className={`chip ${s.role}`}>
      <span className="mark" aria-hidden>
        {s.icon}
      </span>
      {s.label}
    </span>
  )
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? '')
  const system = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  const current = theme || system
  const flip = () => {
    const next = current === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('fermata-theme', next)
    } catch {
      /* private mode */
    }
    setTheme(next)
  }
  return (
    <button onClick={flip} aria-label="Toggle light and dark mode" title="Toggle light / dark">
      {current === 'dark' ? '☀︎ Light' : '☾ Dark'}
    </button>
  )
}

function Tiles({ calls, services }: { calls: Call[]; services?: Service[] }) {
  const price = new Map(services?.map((s) => [s.serviceId.toLowerCase(), BigInt(s.price)]))
  const count = (...st: Call['status'][]) => calls.filter((c) => st.includes(c.status)).length
  const released = calls.filter((c) => c.status === 'released')
  const vendorPaid = released.reduce((sum, c) => sum + (price.get(c.serviceId.toLowerCase()) ?? 0n), 0n)
  const refundedValue = calls
    .filter((c) => c.status === 'refunded' || c.status === 'timed-out')
    .reduce((sum, c) => sum + (price.get(c.serviceId.toLowerCase()) ?? 0n), 0n)
  const proved = calls.filter((c) => c.proveMs)
  const meanProve = proved.length ? proved.reduce((s, c) => s + (c.proveMs ?? 0), 0) / proved.length : 0
  const mpc = calls.filter((c) => c.notaryBytes)
  const meanMpc = mpc.length ? mpc.reduce((s, c) => s + c.notaryBytes!.sent + c.notaryBytes!.received, 0) / mpc.length : 0
  const tiles = [
    { label: 'Calls held', value: String(calls.length), sub: `${count('held', 'settle-pending')} in flight` },
    { label: 'Released to vendor', value: String(released.length), sub: `${usd(vendorPaid)} pathUSD (fee incl.)` },
    { label: 'Refunded to agent', value: String(count('refunded', 'timed-out')), sub: `${usd(refundedValue)} pathUSD` },
    { label: 'Awaiting timeout', value: String(count('awaiting-timeout')), sub: 'no proof, no verdict' },
    { label: 'Mean prove time', value: meanProve ? `${(meanProve / 1000).toFixed(2)} s` : '—', sub: 'MPC-TLS per call' },
    { label: 'Mean MPC traffic', value: meanMpc ? bytes(meanMpc) : '—', sub: 'prover ↔ notary per call' },
  ]
  return (
    <div className="tiles">
      {tiles.map((t) => (
        <div className="tile" key={t.label}>
          <div className="label">{t.label}</div>
          <div className="value">{t.value}</div>
          <div className="sub">{t.sub}</div>
        </div>
      ))}
    </div>
  )
}

/** Public mode: buttons that make a real paid call through the demo agent (POST /demo/call). */
function TryIt({ status, calls, info, onOpen }: { status: DemoStatus; calls: Call[]; info?: Info; onOpen: (c: Call) => void }) {
  const [running, setRunning] = useState<string>()
  const [result, setResult] = useState<DemoResult>()
  const run = async (kind: string) => {
    setRunning(kind)
    setResult(undefined)
    try {
      setResult(await api.demoCall(kind))
    } finally {
      setRunning(undefined)
    }
  }
  const call = result?.callId ? calls.find((c) => c.callId === result.callId) : undefined
  const disabled = !!running || !!status.readOnly || status.busy
  return (
    <div className="panel tryit">
      <h2>
        Try it <span className="muted">a real paid call on {info?.explorer ? 'Tempo testnet' : 'the local chain'}, paid by our demo agent</span>
      </h2>
      {status.readOnly ? <div className="note" style={{ margin: 14 }}>{status.readOnly}</div> : null}
      <div className="tryit-grid">
        {status.kinds.map((k) => (
          <button key={k.id} className="tryit-btn" disabled={disabled} onClick={() => void run(k.id)} aria-busy={running === k.id}>
            <b>{running === k.id ? 'Proving…' : k.label}</b>
            <span className="muted">{k.description}</span>
          </button>
        ))}
      </div>
      {running ? <div className="note" style={{ margin: 14 }}>Holding the price in escrow, proving the vendor's answer with TLSNotary, settling… (a few seconds; the silent vendor waits for its 30 s window)</div> : null}
      {result ? (
        <div className="note" style={{ margin: 14 }} role="status">
          {result.error ? (
            <span>{result.error}</span>
          ) : (
            <>
              <b>{result.outcome === 'DELIVERED' ? '✓ Released to the vendor' : result.outcome === 'FAILED' ? '↩ Refunded to the agent (proven failure)' : '⏳ No proof: the contract refunds the agent once the window closes'}</b>
              {' · '}
              {result.outcome ? <>vendor answered HTTP {result.status}</> : <>the vendor never answered (gateway HTTP {result.status})</>}
              {result.callId ? <> · call <span className="mono">{short(result.callId)}</span></> : null}
              {' · '}hold <TxLink hash={result.holdTx} info={info} />
              {result.settleTx ? <> · settle <TxLink hash={result.settleTx} info={info} /></> : null}
              {call ? (
                <>
                  {' · '}
                  <button onClick={() => onOpen(call)}>Open the proof</button>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <footer className="foot" style={{ padding: '0 14px 12px' }}>
        One call per visitor every {status.perIpSeconds} s · {status.remainingToday} demo calls left today (all visitors) · payer {status.payer ? short(status.payer) : '—'} ·{' '}
        <a href="#use">pay on proof from your own agent →</a>
      </footer>
    </div>
  )
}

function LiveTab({ calls, events, info, onOpen }: { calls: Call[]; events: EscrowEvent[]; info?: Info; onOpen: (c: Call) => void }) {
  const now = Date.now()
  const rows = [...calls].reverse()
  return (
    <div className="grid-live">
      <div className="panel">
        <h2>
          Calls <span className="muted">{calls.length}</span>
        </h2>
        {rows.length === 0 ? (
          <div className="empty">No paid calls yet. Run <span className="mono">pnpm demo:cases</span> or <span className="mono">pnpm demo:agent</span>.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Call</th>
                <th className="hide-sm">Service</th>
                <th className="hide-sm">Prove</th>
                <th className="hide-sm">Settle tx</th>
                <th className="hide-sm">Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.callId} className="clickable" onClick={() => onOpen(c)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(c)}>
                  <td>
                    <StatusChip status={c.status} />
                  </td>
                  <td className="mono">{short(c.callId)}</td>
                  <td className="hide-sm ink2">{serviceLabel(c.serviceId)}</td>
                  <td className="hide-sm num">{c.proveMs ? `${(c.proveMs / 1000).toFixed(2)} s` : '—'}</td>
                  <td className="hide-sm">
                    <TxLink hash={c.settleTx ?? c.timeoutTx} info={info} />
                  </td>
                  <td className="muted num hide-sm">{age(c.createdAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="panel">
        <h2>
          Escrow events <span className="muted">on-chain</span>
        </h2>
        {events.length === 0 ? (
          <div className="empty">Waiting for Held / Released / Refunded…</div>
        ) : (
          <ul className="feed">
            {[...events].reverse().slice(0, 60).map((e) => (
              <li key={`${e.txHash}-${e.event}-${e.callId}`}>
                <span className="ev">{e.event}</span>
                <span className="mono">{short(e.callId)}</span>
                <span className="muted num">#{e.blockNumber}</span>
                <span>
                  {e.event === 'Released' ? `${usd(e.args.amount ?? 0)} (fee ${usd(e.args.fee ?? 0)})` : `${usd(e.args.amount ?? 0)}`}{' '}
                  {e.event === 'Refunded' && e.args.presentationHash === `0x${'0'.repeat(64)}` ? <span className="muted">timeout</span> : null}{' '}
                  <TxLink hash={e.txHash} info={info} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function splitHttp(raw: string) {
  const i = raw.indexOf('\r\n\r\n')
  const head = i < 0 ? raw : raw.slice(0, i)
  const body = i < 0 ? '' : raw.slice(i + 4)
  try {
    return { head, body: JSON.stringify(JSON.parse(body), null, 2) }
  } catch {
    return { head, body }
  }
}

function CallDrawer({ call, info, onClose }: { call: Call; info?: Info; onClose: () => void }) {
  const [re, setRe] = useState<Reverify>()
  const [reError, setReError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [checkedAt, setCheckedAt] = useState<string>()
  const hasProof = !!call.presentationHash
  const run = useCallback(
    async (showChecks: boolean) => {
      setBusy(true)
      try {
        setRe(await api.reverify(call.callId))
        setReError(undefined)
        if (showChecks) setCheckedAt(new Date().toLocaleTimeString())
      } catch (e) {
        setReError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [call.callId],
  )
  // Re-verify once per opened call, not on every dashboard poll (onClose is a new function each render).
  useEffect(() => {
    if (hasProof) void run(false)
  }, [hasProof, run])
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])
  const req = re ? splitHttp(re.transcript.request) : undefined
  const res = re ? splitHttp(re.transcript.response) : undefined
  const v = call.verdict as Record<string, string | number> | undefined
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`Call ${call.callId}`}>
        <header>
          <h3>Call {short(call.callId)}</h3>
          <StatusChip status={call.status} />
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <section>
          <dl className="kv">
            <dt>Call id</dt>
            <dd className="mono">{call.callId}</dd>
            <dt>Service</dt>
            <dd>
              {serviceLabel(call.serviceId)} <span className="muted mono">{short(call.serviceId)}</span>
            </dd>
            <dt>Request</dt>
            <dd className="mono">
              {call.method} {call.target}
            </dd>
            <dt>Outcome</dt>
            <dd>
              {call.outcome ?? '—'}
              {call.failures?.length ? <span className="ink2"> · {call.failures.join('; ')}</span> : null}
            </dd>
            <dt>Hold</dt>
            <dd>
              <TxLink hash={call.holdTx} info={info} />
            </dd>
            <dt>{call.timeoutTx ? 'Timeout refund' : 'Settle'}</dt>
            <dd>
              <TxLink hash={call.settleTx ?? call.timeoutTx} info={info} />
            </dd>
            {call.proveMs ? (
              <>
                <dt>Prove</dt>
                <dd className="num">
                  {(call.proveMs / 1000).toFixed(2)} s{call.notaryBytes ? ` · ${bytes(call.notaryBytes.sent + call.notaryBytes.received)} MPC traffic` : ''}
                </dd>
              </>
            ) : null}
            {call.error ? (
              <>
                <dt>Note</dt>
                <dd className="ink2">{call.error}</dd>
              </>
            ) : null}
          </dl>
        </section>

        {!hasProof ? (
          <section>
            <div className="note">
              No transcript exists for this call (the vendor never answered, or the proof could not bind to the hold), so no verdict was
              ever signed. The only exit is the on-chain timeout: after the settlement window anyone can call{' '}
              <span className="mono">claimTimeout</span>, and the money goes back to the agent.
            </div>
          </section>
        ) : (
          <>
            <section>
              <h4>Proof</h4>
              <dl className="kv">
                <dt>Presentation</dt>
                <dd className="mono">{call.presentationHash}</dd>
                <dt>Notary key</dt>
                <dd className="mono">{re?.notaryKey ?? '…'}</dd>
                <dt>TLS session</dt>
                <dd className="num">{re ? new Date(re.sessionTime * 1000).toISOString() : '…'}</dd>
                <dt>Verifier</dt>
                <dd className="mono">{call.signer ?? '—'}</dd>
                <dt>Signature</dt>
                <dd className="mono">{call.signature ?? '—'}</dd>
                {v ? (
                  <>
                    <dt>Verdict</dt>
                    <dd className="mono">
                      outcome {String(v.outcome)} · requestHash {short(String(v.request_hash))} · issuedAt {String(v.issued_at)}
                    </dd>
                  </>
                ) : null}
              </dl>
              <div className="row-actions" style={{ marginTop: 12 }}>
                <button className="primary" onClick={() => void run(true)} disabled={busy}>
                  {busy ? 'Re-verifying…' : 'Re-verify offline'}
                </button>
                <a href={api.proofUrl(call.callId)} download={`${call.callId}.tlsn`}>
                  <button>Download proof</button>
                </a>
              </div>
              {reError ? <p className="bad">{reError}</p> : null}
            </section>

            {checkedAt && re ? (
              <section>
                <h4>
                  Re-verification{' '}
                  <span className={re.ok ? 'ok' : 'bad'}>{re.ok ? '✓ every hash matches the chain' : '✗ mismatch'}</span>{' '}
                  <span className="muted">at {checkedAt}</span>
                </h4>
                <div className="panel">
                  <table className="checks">
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>Recomputed from the proof</th>
                        <th className="hide-sm">On-chain</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {re.checks.map((k) => (
                        <tr key={k.name}>
                          <td>{k.name}</td>
                          <td className="mono">{short(k.recomputed, 8)}</td>
                          <td className="mono hide-sm">{short(k.onchain, 8)}</td>
                          <td className={k.ok ? 'ok' : 'bad'}>{k.ok ? '✓' : '✗'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}

            {req && res ? (
              <>
                <section>
                  <h4>Revealed request (auth values stay hidden: *)</h4>
                  <pre className="transcript">{req.head}</pre>
                </section>
                <section>
                  <h4>Revealed response</h4>
                  <pre className="transcript">
                    {res.head}
                    {'\n\n'}
                    {res.body}
                  </pre>
                </section>
              </>
            ) : null}
          </>
        )}
      </aside>
    </>
  )
}

function ReconciliationTab({ calls, info }: { calls: Call[]; info?: Info }) {
  const [recs, setRecs] = useState<Record<string, Reconciliation | string>>({})
  const recent = useMemo(() => [...calls].reverse().slice(0, 30), [calls])
  // Each row is checked once per status, three at a time, newest first. Rows already queued are not
  // queued again when the call list refreshes (every 2 s), so requests never pile up.
  const queued = useRef(new Set<string>())
  useEffect(() => {
    const todo = recent.filter((c) => {
      const done = recs[c.callId]
      const key = `${c.callId}:${c.status}`
      if ((done && typeof done !== 'string' && done.status === c.status) || queued.current.has(key)) return false
      queued.current.add(key)
      return true
    })
    const worker = async () => {
      for (let c = todo.shift(); c; c = todo.shift()) {
        const r = await api.reconcile(c.callId).catch((e: Error) => e.message)
        setRecs((m) => ({ ...m, [c.callId]: r }))
        if (typeof r === 'string') queued.current.delete(`${c.callId}:${c.status}`) // retry on the next refresh
      }
    }
    for (let i = 0; i < 3; i++) void worker()
  }, [recent]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="panel">
      <h2>
        Reconciliation by memo
        <span className="muted" style={{ fontWeight: 400 }}>
          every movement is a TIP-20 <span className="mono">TransferWithMemo</span> with memo = callId
        </span>
      </h2>
      {recent.length === 0 ? <div className="empty">No calls yet.</div> : null}
      <table>
        <tbody>
          {recent.map((c) => {
            const r = recs[c.callId]
            return (
              <tr key={c.callId}>
                <td style={{ width: '32%' }}>
                  <div className="mono">{short(c.callId)}</div>
                  <StatusChip status={c.status} />
                  {r && typeof r !== 'string' ? (
                    <div className={r.match ? 'ok' : 'bad'} style={{ marginTop: 4 }}>
                      {r.match ? '✓ matches the outcome' : '✗ does not match'}
                    </div>
                  ) : null}
                </td>
                <td>
                  {!r ? (
                    <span className="muted">loading…</span>
                  ) : typeof r === 'string' ? (
                    <span className="bad">{r}</span>
                  ) : (
                    <>
                      <div className="muted" style={{ marginBottom: 4 }}>
                        expected: {r.expected}
                      </div>
                      {r.movements.map((m, i) => (
                        <div key={i} className="num">
                          <span className="mono">{short(m.from, 4)}</span> → <span className="mono">{short(m.to, 4)}</span>{' '}
                          <strong>{usd(m.amount)}</strong> <TxLink hash={m.txHash} info={info} />
                        </div>
                      ))}
                      {r.ignored ? (
                        <div className="muted" style={{ marginTop: 4 }}>
                          {r.ignored} transfer{r.ignored === 1 ? '' : 's'} by others reusing this memo ignored (not to or from the escrow)
                        </div>
                      ) : null}
                    </>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <footer className="foot" style={{ padding: '0 14px 12px' }}>
        Check it yourself:{' '}
        <span className="mono">
          cast logs --from-block &lt;hold block&gt; --to-block &lt;settle block&gt; --address &lt;pathUSD&gt; 'TransferWithMemo(address,address,uint256,bytes32)' '' '' &lt;callId&gt; --rpc-url &lt;rpc&gt;
        </span>{' '}
        (keep the range under 100,000 blocks: Moderato's limit per query)
      </footer>
    </div>
  )
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(x === 1 || x === 0 ? 0 : 1)} %`)

/** Self-serve onboarding (public mode): check → review the delivery rule → register on-chain. */
function OnboardTab({ info }: { info?: Info }) {
  const [url, setUrl] = useState('https://registry.npmjs.org/-/package/viem/dist-tags')
  const [label, setLabel] = useState('')
  const [payout, setPayout] = useState('')
  const [price, setPrice] = useState('0.01')
  const [summary, setSummary] = useState('')
  const [probe, setProbe] = useState<ProbeResult>()
  const [pred, setPred] = useState<Predicate>()
  const [result, setResult] = useState<RegisterResult>()
  const [test, setTest] = useState<DemoResult>()
  const [busy, setBusy] = useState<string>()
  const check = async () => {
    setBusy('check')
    setProbe(undefined)
    setResult(undefined)
    setTest(undefined)
    try {
      const p = await api.probe(url)
      setProbe(p)
      setPred(p.predicate)
    } finally {
      setBusy(undefined)
    }
  }
  const toggleKey = (k: string) => {
    if (!pred?.jsonSchema || !probe?.predicate?.jsonSchema) return
    const all = probe.predicate.jsonSchema
    const on = pred.jsonSchema.required.includes(k)
    const required = on ? pred.jsonSchema.required.filter((x) => x !== k) : all.required.filter((x) => x === k || pred.jsonSchema!.required.includes(x))
    setPred({ ...pred, jsonSchema: { type: 'object', required, properties: Object.fromEntries(required.map((x) => [x, all.properties[x]!])) } })
  }
  const register = async () => {
    setBusy('register')
    try {
      setResult(await api.register({ url, label, payout, price, summary, predicate: pred }))
    } finally {
      setBusy(undefined)
    }
  }
  const tryIt = async () => {
    setBusy('try')
    try {
      setTest(await api.demoCall('service', result?.serviceId))
    } finally {
      setBusy(undefined)
    }
  }
  const origin = typeof location === 'undefined' ? '' : location.origin
  return (
    <div className="panel onboard">
      <h2>
        List your API <span className="muted">get paid on proof — agents pay into escrow, released when TLSNotary proves you delivered</span>
      </h2>
      <div className="onboard-body">
        <label>
          1 · Your API's URL (a GET that returns your normal answer)
          <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/v1/quote?symbol=BTC-USD" />
        </label>
        <div className="row-actions">
          <button className="primary" disabled={!!busy || !url} onClick={() => void check()}>
            {busy === 'check' ? 'Checking…' : 'Check compatibility'}
          </button>
        </div>
        {probe && !probe.ok ? <div className="note bad-note">✗ {probe.error}</div> : null}
        {probe?.ok && probe.sample ? (
          <>
            <div className="note">
              <b>✓ TLSNotary-compatible.</b> {probe.sample.tls.protocol} · {probe.sample.tls.cipher} · {probe.sample.tls.group} · certificate by {probe.sample.tls.issuer ?? '—'} · HTTP {probe.sample.status} · {probe.sample.contentType ?? 'no content type'} · {probe.sample.bodyBytes} bytes
              {probe.warnings?.length ? <div className="bad">{probe.warnings.join(' ')}</div> : null}
            </div>
            <pre className="transcript">{probe.sample.body}</pre>
            <div>
              <h4 style={{ margin: '12px 0 6px' }}>2 · Delivery rule (checked on every proved answer)</h4>
              <ul className="rule">
                <li>HTTP status is {pred?.status.join(' or ')}</li>
                {pred?.contentType ? <li>Content type is {pred.contentType}</li> : null}
                <li>Body is at most {pred?.maxBodyBytes} bytes</li>
                {probe.predicate?.jsonSchema ? (
                  <li>
                    JSON object with these keys (untick optional ones):
                    <div className="keys">
                      {probe.predicate.jsonSchema.required.map((k) => (
                        <label key={k} className="key">
                          <input type="checkbox" checked={!!pred?.jsonSchema?.required.includes(k)} onChange={() => toggleKey(k)} /> <span className="mono">{k}</span>{' '}
                          <span className="muted">{probe.predicate!.jsonSchema!.properties[k]!.type}</span>
                        </label>
                      ))}
                    </div>
                  </li>
                ) : null}
              </ul>
            </div>
            <h4 style={{ margin: '12px 0 6px' }}>3 · Register on {info?.explorer ? 'Tempo testnet' : 'the local chain'}</h4>
            <div className="onboard-grid">
              <label>
                Short name (2–12: a–z, 0–9, -)
                <input value={label} onChange={(e) => setLabel(e.target.value.toLowerCase())} placeholder="my-api" maxLength={12} />
              </label>
              <label>
                Payout address (where you are paid)
                <input className="mono" value={payout} onChange={(e) => setPayout(e.target.value.trim())} placeholder="0x…" />
              </label>
              <label>
                Price per call (pathUSD)
                <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
              </label>
              <label>
                What it does (shown to agents)
                <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Latest version of an npm package" maxLength={200} />
              </label>
            </div>
            <div className="row-actions">
              <button className="primary" disabled={!!busy || !label || !payout} onClick={() => void register()}>
                {busy === 'register' ? 'Registering on-chain…' : 'Register'}
              </button>
            </div>
          </>
        ) : null}
        {result?.error ? <div className="note bad-note">✗ {result.error}</div> : null}
        {result?.ok ? (
          <div className="note">
            <b>✓ Registered.</b> Service <span className="mono">{short(result.serviceId)}</span> · tx <TxLink hash={result.txHash} info={info} /> · MCP tool{' '}
            <span className="mono">{result.tool}</span>
            <pre className="transcript" style={{ marginTop: 8 }}>{`// agents (mppx): one line, pay on proof
const res = await mppx.fetch('${origin}${result.endpoint}')

# Claude Code: every service, yours included, is a paid MCP tool
${origin === LIVE_DEMO ? 'claude mcp add fermata -- npx -y fermata-mcp' : `claude mcp add fermata -e FERMATA_GATEWAY=${origin} -e FERMATA_TRUSTED_VERIFIERS=0x… -e FERMATA_AGENT_KEY=0x… -- npx -y fermata-mcp`}`}</pre>
            <div className="row-actions" style={{ marginTop: 8 }}>
              <button disabled={!!busy} onClick={() => void tryIt()}>
                {busy === 'try' ? 'Proving…' : 'Make a paid test call'}
              </button>
              {test ? (
                <span>
                  {test.error ? `✗ ${test.error}` : `${test.outcome === 'DELIVERED' ? '✓ Released to you' : test.outcome === 'FAILED' ? '↩ Refunded (your answer failed the rule)' : '⏳ No proof'} · HTTP ${test.status}`} {test.settleTx ? <TxLink hash={test.settleTx} info={info} /> : null}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      <footer className="foot" style={{ padding: '0 14px 12px' }}>
        Testnet only. Your API must be public HTTPS on port 443 and speak TLS 1.2 with AES-128-GCM on P-256 (TLSNotary's profile); private and internal addresses are refused.
        Registration is done by the Fermata operator on your behalf; payments go to your payout address.
      </footer>
    </div>
  )
}

/** A code block with a copy button. */
function Snippet({ code, label, prose }: { code: string; label?: string; prose?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = () =>
    navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => undefined)
  return (
    <div>
      {label ? <div className="snippet-label">{label}</div> : null}
      <div className={prose ? 'snippet prose' : 'snippet'}>
        <pre className="transcript">{code}</pre>
        <button className="copy" onClick={() => void copy()} aria-label={`Copy ${label ?? 'the code'}`}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

/** How to pay on proof from your own agent: the two npm packages, filled in for this gateway. */
function UseTab({ info, services, demo }: { info?: Info; services?: Service[]; demo?: DemoStatus | null }) {
  const origin = typeof location === 'undefined' ? '' : location.origin
  const live = origin === LIVE_DEMO
  const moderato = !!info?.explorer
  const rpc = moderato ? 'https://rpc.moderato.tempo.xyz' : '<this chain’s RPC URL>'
  const escrow = info?.escrow ?? '0x…'
  const verifier = services?.find((s) => s.verifier)?.verifier ?? '0x…'
  const reliable = demo?.kinds.find((k) => k.id === 'reliable')
  const paidUrl = reliable ? `${origin}/s/${reliable.serviceId}${reliable.path}` : `${origin}${services?.[0]?.endpoint ?? '/s/<serviceId>'}/…`

  const mcpAdd = live
    ? 'claude mcp add fermata -- npx -y fermata-mcp'
    : `claude mcp add fermata \\
  -e FERMATA_GATEWAY=${origin} \\
  -e FERMATA_TRUSTED_VERIFIERS=${verifier} \\
  -e FERMATA_ESCROW=${escrow} \\
  -e TEMPO_RPC_URL=${rpc} \\
  -e FERMATA_AGENT_KEY=0x… \\
  -- npx -y fermata-mcp`
  const sdk = `import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { fermata, tempoChain, type FermataReceipt } from 'fermata-sdk'

const chain = tempoChain('${rpc}')
const account = privateKeyToAccount(process.env.AGENT_KEY as Hex)
const wallet = createWalletClient({ account, chain, transport: http() })
const client = createPublicClient({ chain, transport: http() })

const mppx = Mppx.create({
  methods: [
    fermata({
      wallet,
      client,
      escrows: ['${escrow}'],
      trustedVerifiers: ['${verifier}'],
    }),
  ],
  polyfill: false,
})

// Held in escrow, then released to the vendor on proof, or refunded to you.
const url = '${paidUrl}'
const res = await mppx.fetch(url)
const receipt = Receipt.fromResponse(res) as FermataReceipt
console.log(res.status, receipt.outcome, receipt.callId) // 200 DELIVERED 0x…`

  return (
    <div className="panel">
      <h2>
        Use Fermata in your agent <span className="muted">two npm packages · MIT · testnet</span>
      </h2>
      <div className="use">
        <div className="use-grid">
          <section className="use-card">
            <h3>
              Claude and other MCP agents <a className="mono" href="https://www.npmjs.com/package/fermata-mcp" target="_blank" rel="noreferrer">fermata-mcp</a>
            </h3>
            <Snippet label="Claude Code" code={mcpAdd} />
            <p>
              {live
                ? 'No settings needed: it pays this demo’s tools from a testnet wallet it creates in ~/.fermata/agent-key and funds from Tempo’s testnet faucet.'
                : 'Point it at this gateway with your own funded testnet key.'}{' '}
              Every service here becomes a paid tool, next to free tools for vendor scores, proof re-verification, reconciliation, your wallet and refunds
              (<span className="mono">fermata_reclaim</span>).
            </p>
            {live ? (
              <Snippet
                label="Claude Desktop: claude_desktop_config.json"
                code={'{\n  "mcpServers": {\n    "fermata": { "command": "npx", "args": ["-y", "fermata-mcp"] }\n  }\n}'}
              />
            ) : null}
            <Snippet prose label="Then ask Claude" code="Get the BTC price with get_quote_reliable, then try get_quote_broken, and verify both calls." />
          </section>
          <section className="use-card">
            <h3>
              TypeScript agents <a className="mono" href="https://www.npmjs.com/package/fermata-sdk" target="_blank" rel="noreferrer">fermata-sdk</a>
            </h3>
            <Snippet label="Install" code="npm install fermata-sdk mppx@~0.11.0 viem" />
            <p>
              The <span className="mono">fermata</span> payment method for <a href="https://github.com/wevm/mppx" target="_blank" rel="noreferrer">mppx</a>. Before any money
              moves it checks the escrow and the verifier against your lists, the registered price, and your caps (<span className="mono">maxAmount</span>,{' '}
              <span className="mono">maxSettlementWindow</span>).
            </p>
            <Snippet label="Pay one call on this gateway" code={sdk} />
            {moderato ? (
              <Snippet
                label="Fund a testnet key (Tempo faucet)"
                code={`curl -s https://rpc.moderato.tempo.xyz -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tempo_fundAddress","params":["<your address>"]}'`}
              />
            ) : null}
          </section>
        </div>
        <div className="note">
          <b>Selling an API?</b> {demo?.enabled ? <a href="#onboard">List your API</a> : 'List your API'} registers it in a few clicks: agents then pay it on proof, and its
          record appears on the <a href="#vendors">Vendors</a> board. Building your own gateway: <span className="mono">fermataServer()</span> in fermata-sdk is the server side
          of the method.
        </div>
        <div className="links">
          <a href="https://github.com/bilgin-kocak/fermata#use-it-in-your-project" target="_blank" rel="noreferrer">Guide on GitHub</a>
          <a href="https://github.com/bilgin-kocak/fermata/tree/main/packages/sdk#readme" target="_blank" rel="noreferrer">SDK reference</a>
          <a href="https://github.com/bilgin-kocak/fermata/tree/main/apps/mcp#readme" target="_blank" rel="noreferrer">MCP server reference</a>
          <a href="/llms.txt" target="_blank" rel="noreferrer">llms.txt</a>
          <a href="/openapi.json" target="_blank" rel="noreferrer">OpenAPI</a>
        </div>
      </div>
      <footer className="foot" style={{ padding: '0 14px 12px' }}>
        Testnet only, unaudited. The escrow and verifier above are this demo’s, read from its on-chain service records. In your agent they are your own allow-lists: an agent
        never pays a verifier just because a gateway names it, so pin them from a source you trust, and pay only gateways you trust.
      </footer>
    </div>
  )
}

/** Every vendor's proven delivery record, from on-chain escrow events only (GET /scores). */
function VendorsTab({ scores, info }: { scores?: Scores; info?: Info }) {
  if (!scores) return <div className="empty">Loading…</div>
  const rows = scores.scores
  return (
    <div className="panel">
      <h2>
        Vendor scores <span className="muted">proven delivery, from on-chain events</span>
      </h2>
      {rows.length === 0 ? (
        <div className="empty">No calls yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Vendor</th>
              <th>Delivered</th>
              <th>Score</th>
              <th className="hide-sm">Proven failures</th>
              <th className="hide-sm">Timeouts</th>
              <th className="hide-sm">Agents</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr key={s.serviceId}>
                <td className="num muted">{i + 1}</td>
                <td>
                  <div>
                    {s.tool ?? s.label ?? short(s.serviceId, 8)}
                    {s.fewCalls ? <span className="badge" style={{ marginLeft: 8 }}>few calls</span> : null}
                  </div>
                  <div className="mono muted origin" title={s.serviceId}>
                    {s.upstream ?? short(s.serviceId, 8)}
                  </div>
                </td>
                <td className="num">
                  {s.released}/{s.settled} <span className="muted hide-sm">({pct(s.deliveryRate)})</span>
                  {s.open ? <div className="muted">{s.open} open</div> : null}
                </td>
                <td className="num">
                  <b>{pct(s.score)}</b>
                </td>
                <td className="hide-sm num">{s.provenFailures}</td>
                <td className="hide-sm num">{s.timeouts}</td>
                <td className="hide-sm num">{s.distinctAgents}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <footer className="foot" style={{ padding: '0 14px 12px' }}>
        Score = Wilson 95 % lower bound of delivered ÷ settled, so 3/3 does not outrank 950/1000. Proven failure = refunded on the
        vendor's own proved answer; timeout = no proof in the window. {scores.caveats.join(' ')} Recompute it from the chain:{' '}
        <span className="mono">{scores.recompute.replace('<escrow>', scores.escrow)}</span>
        {info?.explorer ? (
          <>
            {' '}· escrow <a href={`${info.explorer}/address/${scores.escrow}`}>{short(scores.escrow)}</a>
          </>
        ) : null}
      </footer>
    </div>
  )
}

function ServicesTab({ services, info }: { services?: Service[]; info?: Info }) {
  if (!services) return <div className="empty">Loading…</div>
  return (
    <div className="panel">
      <h2>Registered services</h2>
      <table>
        <thead>
          <tr>
            <th>Service</th>
            <th className="hide-sm">Upstream</th>
            <th>Price</th>
            <th className="hide-sm">Window</th>
            <th className="hide-sm">Fallback</th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => (
            <tr key={s.serviceId}>
              <td>
                <div>{serviceLabel(s.serviceId)}</div>
                <div className="mono muted">{short(s.serviceId, 8)}</div>
              </td>
              <td className="hide-sm mono">{s.upstream}</td>
              <td className="num">{usd(s.price)} pathUSD</td>
              <td className="hide-sm num">{s.settlementWindow} s</td>
              <td className="hide-sm">{s.unprotectedFallback ? `tempo ${s.unprotectedFallback.amount} (unprotected)` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="foot" style={{ padding: '0 14px 12px' }}>
        Escrow {info?.explorer ? <a href={`${info.explorer}/address/${info.escrow}`}>{info.escrow}</a> : <span className="mono">{info?.escrow}</span>}
      </footer>
    </div>
  )
}

export function App() {
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || 'live')
  const [open, setOpen] = useState<Call>()
  const info = usePoll(api.info, 30_000).data
  const { data: calls = [], error } = usePoll(api.calls, 2_000)
  const events = usePoll(api.events, 2_000).data ?? []
  const services = usePoll(api.services, 30_000).data
  const scores = usePoll(api.scores, 10_000).data
  const demo = usePoll(api.demoStatus, 5_000).data
  useEffect(() => {
    location.hash = tab
  }, [tab])
  // In-page links (#use, #onboard, #vendors) switch tabs.
  useEffect(() => {
    const follow = () => setTab((location.hash.slice(1) as Tab) || 'live')
    addEventListener('hashchange', follow)
    return () => removeEventListener('hashchange', follow)
  }, [])
  const openCall = open ? (calls.find((c) => c.callId === open.callId) ?? open) : undefined
  const chainName = info ? (info.explorer ? 'Tempo Moderato' : 'Anvil (Tempo emulation)') : '…'
  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <Fermata />
          <h1>Fermata</h1>
          <span className="tag">pay on proof</span>
        </div>
        <span className="badge">
          <span className="dot" style={{ background: error ? 'var(--critical)' : undefined }} />
          {error ? 'gateway unreachable' : chainName}
        </span>
        <span className="badge mono" title={info?.escrow}>
          escrow {short(info?.escrow)}
        </span>
        <ThemeToggle />
      </header>
      <Tiles calls={calls} services={services} />
      <nav className="tabs" role="tablist">
        {(
          [
            ['live', 'Live'],
            ['vendors', 'Vendors'],
            ...(demo?.enabled ? ([['onboard', 'List your API']] as const) : []),
            ['use', 'Use it'],
            ['reconciliation', 'Reconciliation'],
            ['services', 'Services'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === 'live' && demo?.enabled ? <TryIt status={demo} calls={calls} info={info} onOpen={setOpen} /> : null}
      {tab === 'live' ? <LiveTab calls={calls} events={events} info={info} onOpen={setOpen} /> : null}
      {tab === 'reconciliation' ? <ReconciliationTab calls={calls} info={info} /> : null}
      {tab === 'vendors' ? <VendorsTab scores={scores} info={info} /> : null}
      {tab === 'onboard' && demo?.enabled ? <OnboardTab info={info} /> : null}
      {tab === 'use' ? <UseTab info={info} services={services} demo={demo} /> : null}
      {tab === 'services' ? <ServicesTab services={services} info={info} /> : null}
      <footer className="foot">
        A disclosed Fermata verifier signs each verdict; every verdict points at a TLSNotary presentation anyone can download and
        re-verify offline. The proof shows what the vendor's server sent, not that the data is correct.
      </footer>
      {openCall ? <CallDrawer call={openCall} info={info} onClose={() => setOpen(undefined)} /> : null}
    </div>
  )
}
