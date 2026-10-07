// scripts/codex/pull_corpus.py against the export service on a local HTTP server: first pull, nothing
// re-downloaded on the second run, resume of a broken download, pruned archives kept, wrong token, the
// token never printed. Skipped (with a note) when no Python 3 is on PATH.
//   npx tsx server/export/_pull_test.ts
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createExport } from './index.ts'
import { makeData, quiet } from './_fixture.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PULLER = path.join(ROOT, 'scripts', 'codex', 'pull_corpus.py')

let passed = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (e) {
    console.error(`FAIL ${name}\n${(e as Error).stack}`)
    process.exitCode = 1
  }
}

function findPython(): string[] | null {
  for (const cmd of [['python3'], ['python'], ['py', '-3']]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim() === '3') return cmd
  }
  return null
}

const py = findPython()
if (!py) {
  console.log('skip pull_corpus.py tests: no Python 3 on PATH')
  process.exit(0)
}

const TOKEN = `pull-${randomBytes(24).toString('hex')}`
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const tmp = fs.mkdtempSync(path.join(tmpdir(), 'lusca-pull-'))
const { dir, archives } = await makeData(path.join(tmp, 'data'))
const out = path.join(tmp, 'corpus')
const exp = createExport({ dataDir: dir, token: TOKEN, log: quiet, datasetMaxMB: 350, datasetKeep: 3, warmupMs: -1, manifestTtlMs: 0 })
const seen: { path: string; range: string | null; gzip: boolean }[] = []
const srv = http.createServer((req, res) => {
  const p = new URL(req.url ?? '/', 'http://x').pathname.replace(/\/+$/, '')
  if (p.startsWith('/api/export/file/')) seen.push({ path: decodeURIComponent(p.slice(17)), range: (req.headers.range as string) ?? null, gzip: /gzip/.test(String(req.headers['accept-encoding'] ?? '')) })
  void exp.handle(req, res, p, '127.0.0.1')
})
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`

/** The puller as a child process (async: the export server runs in this process and must keep answering). */
function exec(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(py![0], [...py!.slice(1), PULLER, ...args], { env: { ...process.env, LUSCA_EXPORT_TOKEN: '', ...env } })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (out += d))
    const t = setTimeout(() => c.kill(), 120_000)
    c.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, out })
    })
  })
}
const run = (args: string[] = [], env: Record<string, string> = { LUSCA_EXPORT_TOKEN: TOKEN }) =>
  exec(['--base', base, '--out', out, '--secrets', path.join(tmp, 'none.env'), '--wait-complete', '0', '--reserve-gb', '0', ...args], env)

await test('first run pulls every artifact, verified, into the layout', async () => {
  const m = await exp.manifest()
  const r = await run()
  assert.equal(r.code, 0, r.out)
  for (const a of m.artifacts) {
    const f = path.join(out, ...a.path.split('/'))
    assert.ok(fs.existsSync(f), a.path)
    assert.equal(sha(fs.readFileSync(f)), a.sha256, a.path)
  }
  const state = JSON.parse(fs.readFileSync(path.join(out, 'state.json'), 'utf8')) as { artifacts: Record<string, { sha256: string }> }
  assert.equal(Object.keys(state.artifacts).length, m.artifacts.length)
  assert.ok(fs.existsSync(path.join(out, 'manifest.json')))
  assert.ok(seen.filter((s) => s.path.startsWith('web/')).every((s) => s.gzip), 'web archives travel gzip-compressed')
  assert.ok(!fs.readdirSync(path.join(out, 'web')).some((n) => n.endsWith('.part')), 'no leftovers')
  assert.ok(!r.out.includes(TOKEN), 'token never printed')
})

await test('second run downloads nothing', async () => {
  const before = seen.length
  const r = await run()
  assert.equal(r.code, 0, r.out)
  assert.equal(seen.length, before, 'no file requests')
  assert.match(r.out, /pulled 0 \(0\.0 MB\)/)
})

await test('a broken download resumes with a Range request', async () => {
  const rel = `web/${archives[1]}`
  const f = path.join(out, 'web', archives[1])
  const full = fs.readFileSync(f)
  fs.rmSync(f)
  fs.writeFileSync(`${f}.part`, full.subarray(0, 1000))
  fs.writeFileSync(`${f}.part.json`, JSON.stringify({ sha256: sha(full), path: rel }))
  const state = JSON.parse(fs.readFileSync(path.join(out, 'state.json'), 'utf8'))
  delete state.artifacts[rel]
  fs.writeFileSync(path.join(out, 'state.json'), JSON.stringify(state))
  const before = seen.length
  const r = await run(['--only', 'web'])
  assert.equal(r.code, 0, r.out)
  const reqs = seen.slice(before)
  assert.deepEqual(reqs.map((s) => [s.path, s.range]), [[rel, 'bytes=1000-']])
  assert.ok(fs.readFileSync(f).equals(full))
  assert.ok(!fs.existsSync(`${f}.part`) && !fs.existsSync(`${f}.part.json`))
})

await test('a part file of another version is discarded, a corrupt local copy is replaced', async () => {
  const f = path.join(out, 'web', archives[0])
  const good = fs.readFileSync(f)
  fs.writeFileSync(f, Buffer.alloc(good.length, 0x41)) // same size, wrong bytes
  const state = JSON.parse(fs.readFileSync(path.join(out, 'state.json'), 'utf8'))
  delete state.artifacts[`web/${archives[0]}`] // a lost state.json entry forces a re-hash
  fs.writeFileSync(path.join(out, 'state.json'), JSON.stringify(state))
  fs.writeFileSync(`${f}.part`, 'stale')
  fs.writeFileSync(`${f}.part.json`, JSON.stringify({ sha256: '0'.repeat(64) }))
  const r = await run(['--only', 'web'])
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.readFileSync(f).equals(good))
})

await test('archives pruned on the server stay on the PC', async () => {
  fs.rmSync(path.join(dir, archives[0]))
  const r = await run()
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(path.join(out, 'web', archives[0])))
})

await test('wrong or missing token: exit 1, no token in the output', async () => {
  let r = await run([], { LUSCA_EXPORT_TOKEN: `${TOKEN}x` })
  assert.equal(r.code, 1)
  assert.match(r.out, /HTTP 401/)
  assert.ok(!r.out.includes(TOKEN))
  r = await run([], {})
  assert.equal(r.code, 1)
  assert.match(r.out, /LUSCA_EXPORT_TOKEN is not set/)
})

await test('the token is read from the secrets file; --init-token adds one without printing it', async () => {
  const env = path.join(tmp, 'secrets.env')
  fs.writeFileSync(env, `OTHER=1\n# comment\nLUSCA_EXPORT_TOKEN="${TOKEN}"\n`)
  const dry = await exec(['--base', base, '--out', out, '--secrets', env, '--wait-complete', '0', '--reserve-gb', '0', '--dry-run'], {})
  assert.equal(dry.code, 0, dry.out)
  let r = spawnSync(py![0], [...py!.slice(1), PULLER, '--secrets', path.join(tmp, 'x.env'), '--init-token'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const fresh = path.join(tmp, 'fresh.env')
  fs.writeFileSync(fresh, 'OTHER=1')
  r = spawnSync(py![0], [...py!.slice(1), PULLER, '--secrets', fresh, '--init-token'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const line = fs.readFileSync(fresh, 'utf8').split('\n').find((l) => l.startsWith('LUSCA_EXPORT_TOKEN='))!
  const value = line.slice('LUSCA_EXPORT_TOKEN='.length)
  assert.ok(value.length >= 32)
  assert.ok(!`${r.stdout}${r.stderr}`.includes(value), 'value not printed')
  assert.match(fs.readFileSync(fresh, 'utf8'), /^OTHER=1\nLUSCA_EXPORT_TOKEN=[A-Za-z0-9_-]{32,}\n$/)
  r = spawnSync(py![0], [...py!.slice(1), PULLER, '--secrets', fresh, '--init-token'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.equal(fs.readFileSync(fresh, 'utf8').split('\n').filter((l) => l.startsWith('LUSCA_EXPORT_TOKEN=')).length, 1, 'left unchanged')
})

await test('a second run while one holds the lock exits 1', async () => {
  fs.writeFileSync(path.join(out, '.pull.lock'), '1 now\n')
  const r = await run()
  assert.equal(r.code, 1)
  assert.match(r.out, /another pull is running/)
  fs.rmSync(path.join(out, '.pull.lock'))
})

await new Promise<void>((r) => srv.close(() => r()))
exp.stop()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
