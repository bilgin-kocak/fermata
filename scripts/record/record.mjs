// Raw footage for the video (docs/DEMO.md), recorded headless with Playwright against a running demo
// stack. Nothing here is edited or sped up: the clips are the real run, to be cut and voiced later.
//
//   bash scripts/demo-stack.sh up --chain anvil
//   PW_CORE_DIR=/path/with/node_modules/playwright-core CHROMIUM=/path/to/chrome \
//     node scripts/record/record.mjs [--clips load,drawer,recon,cases] [--calls 100] [--theme dark|light] [--chain anvil]
//
// playwright-core is deliberately not a repo dependency: install it anywhere (`npm i playwright-core`
// in a scratch directory) and point PW_CORE_DIR at that directory. Clips land in out/video/*.webm
// (git-ignored), stills in out/video/stills/*.png.
//
// Clips run in this order, so the load clip starts on a fresh stack and its dashboard shows exactly
// the N load calls (run it right after `demo-stack.sh up`):
//
//   load    dashboard-load.webm      the Live tab for the whole `pnpm demo:load --calls N` run
//   drawer  drawer-reverify.webm     a released call's proof drawer → Re-verify; then a refunded call
//   recon   reconciliation.webm      the Reconciliation tab: every call's movements by memo
//   cases   terminal-cases.webm      `pnpm demo:cases` captured with its real timing, replayed in a terminal page
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'out/video')
const STILLS = join(OUT, 'stills')
mkdirSync(STILLS, { recursive: true })

const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const clips = opt('clips', 'load,drawer,recon,cases').split(',')
const calls = opt('calls', '100')
const theme = opt('theme', 'dark')
const chain = opt('chain', 'anvil')

const require = createRequire(process.env.PW_CORE_DIR ? pathToFileURL(join(process.env.PW_CORE_DIR, '/')) : import.meta.url)
const { chromium } = require('playwright-core')
const stack = JSON.parse(readFileSync(join(ROOT, 'out/demo/stack.json'), 'utf8'))
const DASH = `${stack.gateway}/dashboard/`
const SIZE = { width: 1280, height: 720 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined })

/** Records one clip: a fresh context with video on, `fn(page)`, then the file is renamed to `name`. */
async function clip(name, fn) {
  const ctx = await browser.newContext({ viewport: SIZE, colorScheme: theme, recordVideo: { dir: OUT, size: SIZE } })
  const page = await ctx.newPage()
  const t0 = Date.now()
  try {
    await fn(page)
  } finally {
    const video = page.video()
    await ctx.close()
    const file = join(OUT, `${name}.webm`)
    renameSync(await video.path(), file)
    console.log(`${name}.webm  ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  }
}
const still = (page, name) => page.screenshot({ path: join(STILLS, `${name}.png`) })

/** Runs a pnpm script, echoing its output; resolves with the output chunks and their times (ms from start). */
function run(args) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const chunks = []
    const p = spawn('pnpm', ['-s', ...args], { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '0' } })
    const on = (d) => {
      process.stdout.write(d)
      chunks.push({ t: Date.now() - t0, s: d.toString() })
    }
    p.stdout.on('data', on)
    p.stderr.on('data', on)
    p.on('error', reject)
    p.on('close', (code) => resolve({ code, chunks, ms: Date.now() - t0 }))
  })
}

/** A slow, smooth scroll of `selector` (or the window) so the viewer can read along. */
async function scroll(page, selector, px, ms) {
  const steps = Math.max(1, Math.round(ms / 40))
  for (let i = 0; i < steps; i++) {
    await page.evaluate(
      ([sel, dy]) => (sel ? document.querySelector(sel)?.scrollBy(0, dy) : window.scrollBy(0, dy)),
      [selector, px / steps],
    )
    await sleep(40)
  }
}

// ----------------------------------------------------------------------------------------- load
if (clips.includes('load')) {
  await clip('dashboard-load', async (page) => {
    await page.goto(`${DASH}#live`)
    await page.waitForSelector('.tiles')
    await sleep(2500)
    await still(page, 'load-start')
    const running = run(['demo:load', '--calls', calls, '--chain', chain])
    let n = 0
    const timer = setInterval(() => void still(page, `load-${String(++n).padStart(2, '0')}`).catch(() => {}), 30_000)
    const { code } = await running
    clearInterval(timer)
    await sleep(5000) // two dashboard polls after the last settle
    await still(page, 'load-end')
    if (code !== 0) console.error(`demo:load exited ${code}`)
  })
}

// --------------------------------------------------------------------------------------- drawer
if (clips.includes('drawer')) {
  await clip('drawer-reverify', async (page) => {
    await page.goto(`${DASH}#live`)
    await page.waitForSelector('tr.clickable')
    await sleep(1500)
    for (const [label, name] of [
      ['Released', 'drawer-released'],
      ['Refunded (verified failure)', 'drawer-refunded'],
    ]) {
      const row = page.locator('tr.clickable', { hasText: label }).first()
      if (!(await row.count())) continue
      await row.hover()
      await sleep(600)
      await row.click()
      await page.waitForSelector('.drawer')
      await sleep(2000)
      await scroll(page, '.drawer', 700, 4000)
      // the drawer re-verifies silently on open; click once that is done (button back to idle)
      const btn = page.getByRole('button', { name: 'Re-verify offline', exact: true })
      await btn.waitFor()
      await btn.scrollIntoViewIfNeeded()
      await sleep(800)
      for (let attempt = 0; ; attempt++) {
        await btn.click()
        try {
          await page.waitForSelector('.checks', { timeout: 10_000 })
          break
        } catch (e) {
          if (attempt >= 2) throw e
        }
      }
      await page.locator('.checks').scrollIntoViewIfNeeded()
      await sleep(3500)
      await still(page, name)
      await scroll(page, '.drawer', 900, 4000)
      await sleep(1500)
      await page.keyboard.press('Escape')
      await sleep(1200)
    }
  })
}

// ---------------------------------------------------------------------------------------- recon
if (clips.includes('recon')) {
  await clip('reconciliation', async (page) => {
    await page.goto(`${DASH}#reconciliation`)
    await page.waitForSelector('table')
    await sleep(2500)
    await still(page, 'reconciliation')
    await scroll(page, null, 2400, 12_000)
    await sleep(1500)
    await scroll(page, null, 100_000, 3000) // to the one-command check in the footer
    await sleep(3000)
    await still(page, 'reconciliation-footer')
  })
}

// ---------------------------------------------------------------------------------------- cases
if (clips.includes('cases')) {
  const cmd = `pnpm demo:cases --chain ${chain}`
  const { code, chunks, ms } = await run(['demo:cases', '--chain', chain])
  writeFileSync(join(OUT, 'terminal-cases.json'), JSON.stringify({ cmd, code, ms, chunks }, null, 1))
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0d0d0d;color:#e6e6e0;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace}
    .bar{height:28px;background:#1a1a19;display:flex;align-items:center;gap:8px;padding:0 12px;color:#898781;font-size:12px}
    .bar i{width:11px;height:11px;border-radius:50%;background:#2c2c2a;display:inline-block}
    pre{margin:0;padding:12px 16px;white-space:pre;overflow:hidden;height:calc(100% - 52px)}
    .p{color:#3987e5}.ok{color:#0ca30c}.bad{color:#e06a6a}</style>
    <div class="bar"><i></i><i></i><i></i><span>fermata — ${esc(chain)}</span></div><pre id="t"></pre>
    <script>
    const chunks=${JSON.stringify(chunks)}; const t=document.getElementById('t'); let text='';
    const paint=()=>{t.innerHTML='<span class="p">$</span> ${esc(cmd)}\\n'+text.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[c])
      .replace(/\\bPASS\\b|✓/g,m=>'<span class="ok">'+m+'</span>').replace(/\\bFAIL\\b|✗/g,m=>'<span class="bad">'+m+'</span>');
      t.scrollTop=t.scrollHeight};
    paint(); for(const c of chunks) setTimeout(()=>{text+=c.s;paint()},800+c.t);
    </script>`
  writeFileSync(join(OUT, 'terminal-cases.html'), html)
  await clip('terminal-cases', async (page) => {
    await page.goto(pathToFileURL(join(OUT, 'terminal-cases.html')).href)
    await sleep(800 + ms + 4000)
    await still(page, 'terminal-cases')
  })
  if (code !== 0) throw new Error(`demo:cases exited ${code}`)
}

await browser.close()
