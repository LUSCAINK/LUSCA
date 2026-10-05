// Bundle the desktop neuron (scripts/neuron.ts + shared/ + server/auth/ed25519.ts + ws) into ONE
// dependency-free ESM file: dist/neuron.mjs, served by the hub at /neuron.mjs.
//
//   node scripts/build-neuron.mjs [--out dist/neuron.mjs] [--server wss://lusca.ink/ws]
//
// Runs with plain `node neuron.mjs --auth <token>` on Node ≥ 20 (no npm install, no tsx).
// The bundled build defaults --server to wss://lusca.ink/ws (override with --server here, or
// LUSCA_WS / --server at run time). Run it AFTER `vite build`: vite empties dist/.
//
// Uses esbuild (installed with tsx). ws's optional native add-ons (bufferutil, utf-8-validate)
// stay external: ws loads them in try/catch and falls back to plain JS when they are missing.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, def) {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1]
    if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1)
  }
  return def
}

const out = path.resolve(ROOT, arg('--out', 'dist/neuron.mjs'))
const server = arg('--server', process.env.LUSCA_NEURON_SERVER || 'wss://lusca.ink/ws')
if (!/^wss?:\/\/[^\s"'`\\]+$/.test(server)) {
  console.error(`build-neuron: --server must be a ws:// or wss:// url, got ${server}`)
  process.exit(2)
}

let commit = 'unknown'
try {
  commit = execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || commit
} catch {
  /* not a git checkout */
}
const buildId = `${new Date().toISOString().slice(0, 10)}+${commit}`

const banner = [
  '#!/usr/bin/env node',
  '// LUSCA desktop neuron — trains SEPIA and runs dedupe jobs on this CPU for https://lusca.ink',
  `// Build ${buildId}. Single file, no dependencies: node neuron.mjs --auth <token>  (Node ≥ 20)`,
  '// Source: https://github.com/LUSCAINK/LUSCA (scripts/neuron.ts) · rebuild: npm run build:neuron',
  "import { createRequire as __luscaCreateRequire } from 'node:module';",
  'const require = __luscaCreateRequire(import.meta.url);',
].join('\n')

const t0 = Date.now()
const result = await build({
  entryPoints: [path.join(ROOT, 'scripts/neuron.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['bufferutil', 'utf-8-validate'],
  define: {
    __LUSCA_DEFAULT_WS__: JSON.stringify(server),
    __LUSCA_BUILD__: JSON.stringify(buildId),
  },
  banner: { js: banner },
  legalComments: 'inline',
  minify: false,
  sourcemap: false,
  metafile: true,
  logLevel: 'warning',
})

const code = fs.readFileSync(out)
const sha = crypto.createHash('sha256').update(code).digest('hex')
const inputs = Object.keys(result.metafile.inputs).length
console.log(`build-neuron: ${path.relative(ROOT, out)} · ${(code.length / 1024).toFixed(1)} KB · ${inputs} modules · server ${server} · build ${buildId} · ${Date.now() - t0} ms`)
console.log(`build-neuron: sha256 ${sha}`)
fs.writeFileSync(out + '.sha256', `${sha}  neuron.mjs\n`)
