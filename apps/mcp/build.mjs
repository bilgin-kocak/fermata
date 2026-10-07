// Bundles fermata-mcp into one file with no runtime dependencies: `npx -y fermata-mcp` then downloads
// one small package instead of ~100, and the server starts well inside an MCP client's startup timeout
// (Claude Code waits 30 s). The licenses of the bundled packages go to dist/THIRD-PARTY-NOTICES.txt.
import { build } from 'esbuild'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, 'dist')
rmSync(dist, { recursive: true, force: true })

const { metafile } = await build({
  absWorkingDir: here,
  entryPoints: ['src/index.ts'],
  outfile: path.join(dist, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  legalComments: 'none',
  metafile: true,
  // Bundled CommonJS dependencies (ajv) call require(): give them a real one inside this ES module.
  banner: { js: "import { createRequire as __fermataRequire } from 'node:module'; const require = __fermataRequire(import.meta.url);" },
  logLevel: 'warning',
})

// The innermost node_modules/<name> (or node_modules/@scope/<name>) directory of each bundled file.
const dirs = new Set()
for (const input of Object.keys(metafile.inputs)) {
  const abs = path.resolve(here, input)
  const i = abs.lastIndexOf(`${path.sep}node_modules${path.sep}`)
  if (i < 0) continue // this package or the workspace's fermata-sdk (same license)
  const rest = abs.slice(i + 14).split(path.sep)
  dirs.add(abs.slice(0, i + 14) + (rest[0].startsWith('@') ? `${rest[0]}${path.sep}${rest[1]}` : rest[0]))
}
const notices = [...dirs]
  .map((dir) => {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\..*)?$/i.test(f))
    const text = file ? readFileSync(path.join(dir, file), 'utf8').trim() : `License: ${pkg.license ?? 'see the package'} (the package ships no license file)`
    return { id: `${pkg.name}@${pkg.version}`, license: pkg.license, text }
  })
  .sort((a, b) => a.id.localeCompare(b.id))
writeFileSync(
  path.join(dist, 'THIRD-PARTY-NOTICES.txt'),
  `fermata-mcp's dist/index.js bundles the following packages, under their own licenses:\n\n` +
    notices.map((n) => `${'='.repeat(72)}\n${n.id} (${n.license})\n${'='.repeat(72)}\n\n${n.text}\n`).join('\n'),
)
console.log(`dist/index.js: ${(metafile.outputs[Object.keys(metafile.outputs)[0]].bytes / 1024).toFixed(0)} KB, ${notices.length} bundled packages: ${notices.map((n) => `${n.id} (${n.license})`).join(', ')}`)
