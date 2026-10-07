// Corpus export tests: a synthetic data dir (rotated archives, code index, a real chain store), the export
// service behind a local HTTP server. No internet.
//   npx tsx server/export/_test.ts
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash, randomBytes } from 'node:crypto'
import { createChainStore } from '../chain/store.ts'
import { createExport, parseRange, type ExportApi, type ExportManifest } from './index.ts'
import { OSEC, P1, P2, P3, SHARED, big, makeData, quiet, solKeep } from './_fixture.ts'
import { buildShard, readKeptIndex, committedEnds, countEmails } from './kept.ts'

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

const TOKEN = 't'.repeat(8) + randomBytes(24).toString('hex') // 56 characters
const NL = String.fromCharCode(10)
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const tmp = fs.mkdtempSync(path.join(tmpdir(), 'lusca-export-'))
let dirs = 0
const freshDir = () => {
  const d = path.join(tmp, `d${dirs++}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

async function serve(exp: ExportApi): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname.replace(/\/+$/, '')
    void exp.handle(req, res, p, String(req.headers['x-test-ip'] ?? '10.0.0.1'))
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) }
}

function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

const auth = { Authorization: `Bearer ${TOKEN}` }
const linesOf = (gz: Buffer) =>
  zlib
    .gunzipSync(gz)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

// ─── unit ───────────────────────────────────────────────────────────────────

await test('parseRange: single ranges, suffix, open end, unsatisfiable', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=95-200', 100), { start: 95, end: 99 })
  assert.equal(parseRange('bytes=100-', 100), 'bad')
  assert.equal(parseRange('bytes=5-2', 100), 'bad')
  assert.equal(parseRange('bytes=0-1,5-6', 100), null)
  assert.equal(parseRange('items=0-1', 100), null)
  assert.equal(parseRange(undefined, 100), null)
})

await test('countEmails: linear on long alphanumeric runs; NatSpec tags and import paths are not emails', () => {
  assert.equal(countEmails('/// @author Jane <jane.doe@example.org>' + NL + '/// @notice x' + NL + 'import "@openzeppelin/contracts/a.sol";'), 1)
  assert.equal(countEmails('contact: security@protocol.xyz, ops@a.io'), 2)
  assert.equal(countEmails('a@b'), 0)
  const t0 = Date.now()
  assert.equal(countEmails('a'.repeat(400_000) + '@' + 'b'.repeat(400_000)), 0)
  assert.equal(countEmails(randomBytes(300_000).toString('hex')), 0)
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`)
})

await test('off without a token, or with a short one', async () => {
  const dir = freshDir()
  for (const token of [null, 'short-token']) {
    const exp = createExport({ dataDir: dir, token, log: quiet, datasetMaxMB: 350, datasetKeep: 3, warmupMs: -1 })
    assert.equal(exp.enabled, false)
    const s = await serve(exp)
    const r = await get(`${s.url}/api/export/manifest`, { Authorization: `Bearer ${token}` })
    assert.equal(r.status, 404)
    await s.close()
    exp.stop()
  }
})

// ─── the full service ───────────────────────────────────────────────────────

const { dir, archives } = await makeData(freshDir())
const exp = createExport({ dataDir: dir, token: TOKEN, log: quiet, datasetMaxMB: 350, datasetKeep: 3, warmupMs: -1, manifestTtlMs: 0, openRebuildMs: 0, mbPerSec: 64 })
const srv = await serve(exp)
let manifest: ExportManifest

await test('auth: 401 without or with a wrong token; lockout after 10 failures', async () => {
  let r = await get(`${srv.url}/api/export/manifest`)
  assert.equal(r.status, 401)
  assert.match(String(r.headers['www-authenticate']), /Bearer/)
  r = await get(`${srv.url}/api/export/manifest`, { Authorization: `Bearer ${TOKEN.slice(0, -1)}x` })
  assert.equal(r.status, 401)
  r = await get(`${srv.url}/api/export/manifest`, { Authorization: TOKEN })
  assert.equal(r.status, 401, 'token without the Bearer scheme')
  for (let i = 0; i < 10; i++) await get(`${srv.url}/api/export/manifest`, { 'x-test-ip': '10.9.9.9' })
  r = await get(`${srv.url}/api/export/manifest`, { ...auth, 'x-test-ip': '10.9.9.9' })
  assert.equal(r.status, 429, 'locked out even with the right token')
  r = await get(`${srv.url}/api/export/manifest`, { ...auth, 'x-test-ip': '10.9.9.8' })
  assert.equal(r.status, 200, 'other addresses unaffected')
  r = await get(`${srv.url}/api/export/manifest`, auth, 'POST')
  assert.equal(r.status, 405)
})

await test('manifest: archives, code index, kept code; nothing else', async () => {
  const r = await get(`${srv.url}/api/export/manifest`, { ...auth, 'Accept-Encoding': 'gzip' })
  assert.equal(r.status, 200)
  assert.equal(r.headers['cache-control'], 'private, no-store')
  const body = r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body
  manifest = JSON.parse(body.toString('utf8')) as ExportManifest
  assert.equal(manifest.complete, true, `pending: ${manifest.pending.join(', ')}`)
  const paths = manifest.artifacts.map((a) => a.path)
  for (const a of archives) assert.ok(paths.includes(`web/${a}`), a)
  assert.ok(!paths.some((p) => p.includes('dataset.jsonl')), 'active dataset is not exported')
  assert.ok(!paths.some((p) => /secret|salt|ledger|stray/.test(p)), 'no private or unlisted files')
  assert.ok(paths.includes('code-index/index.json'))
  assert.ok(paths.includes('code-index/Uniswap__v2-core.1.0.jsonl.gz'))
  assert.ok(paths.includes('kept-code/files-000001.jsonl.gz'))
  assert.ok(paths.includes('kept-code/contracts-000001.jsonl.gz'))
  assert.ok(paths.includes('kept-code/idls-000001.jsonl.gz'))
  assert.ok(paths.includes('kept-code/refs.jsonl.gz') && paths.includes('kept-code/current.jsonl.gz'))
  assert.equal(manifest.retention.datasetKeep, 3)
  const a0 = manifest.artifacts.find((a) => a.path === `web/${archives[0]}`)!
  const raw = fs.readFileSync(path.join(dir, archives[0]))
  assert.equal(a0.bytes, raw.length)
  assert.equal(a0.sha256, sha(raw))
  assert.equal(a0.immutable, true)
  assert.deepEqual(a0.meta, { pages: 50, tokens: 6000 })
  const sealed = manifest.artifacts.filter((a) => a.kind === 'kept-files')
  assert.ok(sealed.length >= 2, `two records over ≥ 2 shards (${sealed.length})`)
  assert.equal(sealed[0].immutable, true, 'first shard is sealed')
  assert.equal(sealed.at(-1)!.immutable, false, 'the open shard is not')
  assert.equal(manifest.totals.artifacts, manifest.artifacts.length)
  const etag = r.headers.etag as string
  const r304 = await get(`${srv.url}/api/export/manifest`, { ...auth, 'If-None-Match': etag })
  assert.equal(r304.status, 304)
})

await test('file: full download matches the manifest; HEAD; ranges; If-Match; If-Range', async () => {
  const a = manifest.artifacts.find((x) => x.path === `web/${archives[1]}`)!
  const raw = fs.readFileSync(path.join(dir, archives[1]))
  let r = await get(`${srv.url}/api/export/file/${a.path}`, auth)
  assert.equal(r.status, 200)
  assert.equal(Number(r.headers['content-length']), raw.length)
  assert.equal(r.headers.etag, `"${a.sha256}"`)
  assert.equal(r.headers['x-content-sha256'], a.sha256)
  assert.equal(sha(r.body), a.sha256)
  r = await get(`${srv.url}/api/export/file/${a.path}`, auth, 'HEAD')
  assert.equal(r.status, 200)
  assert.equal(r.body.length, 0)
  assert.equal(Number(r.headers['content-length']), raw.length)
  r = await get(`${srv.url}/api/export/file/${a.path}`, { ...auth, Range: 'bytes=100-' })
  assert.equal(r.status, 206)
  assert.equal(r.headers['content-range'], `bytes 100-${raw.length - 1}/${raw.length}`)
  assert.ok(r.body.equals(raw.subarray(100)))
  r = await get(`${srv.url}/api/export/file/${a.path}`, { ...auth, Range: 'bytes=100-', 'If-Range': '"stale"' })
  assert.equal(r.status, 200, 'If-Range mismatch → the whole file')
  assert.equal(r.body.length, raw.length)
  r = await get(`${srv.url}/api/export/file/${a.path}`, { ...auth, Range: `bytes=${raw.length}-` })
  assert.equal(r.status, 416)
  r = await get(`${srv.url}/api/export/file/${a.path}`, { ...auth, 'If-Match': '"0000"' })
  assert.equal(r.status, 412)
  r = await get(`${srv.url}/api/export/file/${a.path}`, { ...auth, 'If-Match': `"${a.sha256}"` })
  assert.equal(r.status, 200)
})

await test('file: gzip transport of a .jsonl archive, plain bytes and sha unchanged', async () => {
  const a = manifest.artifacts.find((x) => x.path === `web/${archives[0]}`)!
  const r = await get(`${srv.url}/api/export/file/${a.path}`, { ...auth, 'Accept-Encoding': 'gzip' })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-encoding'], 'gzip')
  assert.equal(r.headers['content-length'], undefined)
  assert.equal(Number(r.headers['x-content-length']), a.bytes)
  const plain = zlib.gunzipSync(r.body)
  assert.equal(sha(plain), a.sha256)
  // a Range request is never compressed (resume continues the plain bytes)
  const r2 = await get(`${srv.url}/api/export/file/${a.path}`, { ...auth, 'Accept-Encoding': 'gzip', Range: 'bytes=10-' })
  assert.equal(r2.status, 206)
  assert.equal(r2.headers['content-encoding'], undefined)
})

await test('file: bad, traversal and unknown paths never touch other files', async () => {
  for (const p of ['web/..%2Fauth.secret', 'web%2F..%2Fauth.secret', '..%2Fauth.secret', 'auth.secret', 'code-index/..', 'other/x.jsonl']) {
    const r = await get(`${srv.url}/api/export/file/${p}`, auth)
    assert.ok(r.status === 400 || r.status === 404, `${p} → ${r.status}`)
    assert.ok(!r.body.toString('utf8').includes('SECRET'), p)
  }
  const r = await get(`${srv.url}/api/export/file/web/dataset.jsonl`, auth)
  assert.equal(r.status, 404)
  const r2 = await get(`${srv.url}/api/export/file/code-index/stray.0.0.jsonl.gz`, auth)
  assert.equal(r2.status, 404)
})

await test('kept code: per-file records, first occurrence only, licenses, emails counted, IDLs, refs, current', async () => {
  const dl = async (p: string) => {
    const a = manifest.artifacts.find((x) => x.path === p)
    assert.ok(a, p)
    const r = await get(`${srv.url}/api/export/file/${p}`, auth)
    assert.equal(r.status, 200, p)
    assert.equal(sha(r.body), a.sha256, `${p} sha`)
    assert.equal(r.body.length, a.bytes)
    return linesOf(r.body)
  }
  const files = (await Promise.all(manifest.artifacts.filter((a) => a.kind === 'kept-files').map((a) => dl(a.path)))).flat()
  const shared = files.filter((f) => f.sha256 === sha(SHARED))
  assert.equal(shared.length, 1, 'shared file exported once')
  assert.equal(shared[0].address, P1)
  assert.equal(shared[0].path, 'src/math.rs')
  assert.equal(shared[0].license, 'Apache-2.0')
  assert.equal(shared[0].licenseTier, 'permissive')
  assert.equal(shared[0].emails, 1)
  assert.equal(shared[0].text, SHARED, 'verified text unchanged')
  assert.equal(shared[0].verifiedBy, 'osec')
  assert.equal(shared[0].chain, 'solana')
  assert.equal(shared[0].keptAt, new Date(Date.UTC(2026, 9, 7, 8, 0, 0)).toISOString())
  const busl = files.filter((f) => f.license === 'BUSL-1.1')
  assert.equal(busl.length, 2)
  assert.ok(busl.every((f) => f.licenseTier === 'source-available'))
  for (const f of files) for (const k of ['sha256', 'bytes', 'lang', 'path', 'chain', 'address', 'compiler', 'verifiedBy', 'match', 'license', 'keptAt', 'text']) assert.ok(k in f, k)

  const contracts = (await Promise.all(manifest.artifacts.filter((a) => a.kind === 'kept-contracts').map((a) => dl(a.path)))).flat()
  assert.equal(contracts.length, 2)
  const c2 = contracts.find((c) => c.address === P2)!
  assert.deepEqual(
    (c2.files as { path: string; sha256: string }[]).map((f) => f.path),
    ['programs/amm/src/util.rs', 'src/big2.rs'],
  )
  assert.equal((c2.files as { sha256: string }[])[0].sha256, sha(SHARED), 'the contract still lists the shared file')
  assert.equal(c2.repo, OSEC.repo)
  assert.equal(c2.commit, OSEC.commit)

  const idls = (await Promise.all(manifest.artifacts.filter((a) => a.kind === 'kept-idls').map((a) => dl(a.path)))).flat()
  assert.deepEqual(idls.map((i) => i.programId).sort(), [P1, P2])
  assert.deepEqual(idls[0].idl, { version: '0.1.0', name: 'amm', instructions: [{ name: 'swap', accounts: [], args: [] }] })

  const refs = await dl('kept-code/refs.jsonl.gz')
  const sharedRefs = refs.find((x) => x.sha256 === sha(SHARED))!
  assert.deepEqual(
    (sharedRefs.carriers as { address: string; path: string; current: boolean }[]).map((c) => [c.address, c.path, c.current]),
    [
      [P1, 'src/math.rs', true],
      [P2, 'programs/amm/src/util.rs', true],
    ],
  )
  const current = await dl('kept-code/current.jsonl.gz')
  assert.deepEqual(current.map((c) => c.address).sort(), [P1, P2])
  assert.ok(current.every((c) => /^kept-code\/contracts-\d{6}\.jsonl\.gz$/.test(String(c.contracts))))
})

await test('kept code: sealed shards stay byte-identical as the store grows; superseded records stay listed', async () => {
  const before = new Map(manifest.artifacts.map((a) => [a.path, a.sha256]))
  const sealedBefore = manifest.artifacts.filter((a) => a.immutable && a.kind.startsWith('kept-')).map((a) => a.path)
  assert.ok(sealedBefore.length >= 1)
  // the store keeps more: a new program and a re-read of P1 with new code (supersedes its record)
  const st = createChainStore({ dataDir: dir, log: quiet, saveDelayMs: 0, maxShardBytes: 64 * 1024, diskReserveBytes: 0 })
  const t1 = Date.UTC(2026, 9, 7, 9, 0, 0)
  assert.equal((await st.process(solKeep(P3, 'c3', [{ path: 'src/lib.rs', text: big('three') }], t1))).verdict, 'kept')
  assert.equal((await st.process(solKeep(P1, 'c1b', [{ path: 'src/math.rs', text: SHARED }, { path: 'src/big1.rs', text: big('one-v2') }], t1 + 1000))).verdict, 'kept')
  st.flush()
  await st.close()
  const m2 = await exp.manifest()
  assert.equal(m2.complete, true)
  for (const p of sealedBefore) {
    const a = m2.artifacts.find((x) => x.path === p)
    assert.ok(a, `${p} still listed`)
    assert.equal(a.sha256, before.get(p), `${p} unchanged`)
  }
  const contracts = (
    await Promise.all(
      m2.artifacts
        .filter((a) => a.kind === 'kept-contracts')
        .map(async (a) => linesOf((await get(`${srv.url}/api/export/file/${a.path}`, auth)).body)),
    )
  ).flat()
  assert.equal(contracts.filter((c) => c.address === P1).length, 2, 'both records of P1 are exported')
  const current = linesOf((await get(`${srv.url}/api/export/file/kept-code/current.jsonl.gz`, auth)).body)
  const p1 = current.find((c) => c.address === P1)!
  assert.equal(p1.readAt, Date.UTC(2026, 9, 7, 9, 0, 1), 'current points at the newer record')
  const refs = linesOf((await get(`${srv.url}/api/export/file/kept-code/refs.jsonl.gz`, auth)).body)
  const carriers = refs.find((x) => x.sha256 === sha(SHARED))!.carriers as { address: string; current: boolean }[]
  assert.deepEqual(
    carriers.map((c) => [c.address, c.current]),
    [
      [P1, false],
      [P2, true],
      [P1, true],
    ],
  )
  manifest = m2
})

await test('kept code: rebuilt artifacts are byte-identical (deterministic gzip members)', async () => {
  const exp2 = createExport({ dataDir: dir, token: TOKEN, log: quiet, datasetMaxMB: 0, datasetKeep: 0, warmupMs: -1, lruBytes: 0 })
  const m = await exp2.manifest()
  const s2 = await serve(exp2)
  for (const a of m.artifacts.filter((x) => x.kind.startsWith('kept-'))) {
    assert.equal(a.sha256, manifest.artifacts.find((x) => x.path === a.path)?.sha256, `${a.path}: same sha in a fresh process`)
    const head = await get(`${s2.url}/api/export/file/${a.path}`, auth, 'HEAD')
    assert.equal(head.status, 200)
    assert.equal(Number(head.headers['content-length']), a.bytes, `${a.path}: HEAD answers from the manifest`)
    assert.equal(head.headers.etag, `"${a.sha256}"`)
    const r = await get(`${s2.url}/api/export/file/${a.path}`, auth)
    assert.equal(r.status, 200)
    assert.equal(sha(r.body), a.sha256, `${a.path}: rebuilt on demand (no cache) with the listed bytes`)
    const part = await get(`${s2.url}/api/export/file/${a.path}`, { ...auth, Range: 'bytes=7-' })
    assert.ok(part.body.equals(r.body.subarray(7)), `${a.path}: ranges over rebuilt members`)
  }
  assert.equal(m.retention.note, 'web-text archives are not pruned on this server')
  await s2.close()
  exp2.stop()
})

await test('kept code: the open shard is read only up to its committed end', async () => {
  const idx = readKeptIndex(dir)!
  const open = idx.open!
  const end = committedEnds(idx).get(open)!
  const file = path.join(dir, 'chain', 'shards', open)
  // an append in flight: bytes past the committed end (not yet in items.json)
  fs.appendFileSync(file, zlib.gzipSync('{"partial":'))
  const b = await buildShard(file, end, () => false)
  assert.ok(b.contracts.records >= 1)
  const m = await exp.manifest()
  assert.equal(m.complete, true)
  const a = m.artifacts.find((x) => x.path === `kept-code/contracts-${open.slice(6, 12)}.jsonl.gz`)!
  assert.equal(a.meta?.shardBytes, end)
  fs.truncateSync(file, end)
})

await test('limits: per-address request cap and concurrent downloads', async () => {
  const exp3 = createExport({ dataDir: dir, token: TOKEN, log: quiet, datasetMaxMB: 0, datasetKeep: 0, warmupMs: -1, perIpPerMin: 3, mbPerSec: 0.1 })
  const s3 = await serve(exp3)
  for (let i = 0; i < 3; i++) assert.equal((await get(`${s3.url}/api/export/manifest`, auth)).status, 200)
  const r = await get(`${s3.url}/api/export/manifest`, auth)
  assert.equal(r.status, 429)
  assert.ok(Number(r.headers['retry-after']) > 0)
  await s3.close()
  exp3.stop()

  // one download at a time per address: a second one while the first streams is refused
  const d = freshDir()
  const name = 'dataset-20261007T060000000Z.jsonl'
  fs.writeFileSync(path.join(d, name), randomBytes(1024 * 1024).toString('hex'))
  const exp4 = createExport({ dataDir: d, token: TOKEN, log: quiet, datasetMaxMB: 0, datasetKeep: 0, warmupMs: -1, maxStreamsPerIp: 1, mbPerSec: 0.25 })
  await exp4.manifest()
  const s4 = await serve(exp4)
  let first: http.ClientRequest | null = null
  const firstStarted = new Promise<number>((resolve) => {
    first = http.request(`${s4.url}/api/export/file/web/${name}`, { headers: auth }, (res) => {
      resolve(res.statusCode ?? 0)
      res.resume()
    })
    first.on('error', () => {})
    first.end()
  })
  assert.equal(await firstStarted, 200)
  const second = await get(`${s4.url}/api/export/file/web/${name}`, auth)
  assert.equal(second.status, 429)
  const other = await get(`${s4.url}/api/export/manifest`, { ...auth, 'x-test-ip': '10.0.0.2' })
  assert.equal(other.status, 200, 'the manifest is not a download')
  ;(first as unknown as http.ClientRequest).destroy()
  await new Promise((r) => setTimeout(r, 100))
  const third = await get(`${s4.url}/api/export/file/web/${name}`, { ...auth, Range: 'bytes=0-99' })
  assert.equal(third.status, 206, 'slot released when the first download was aborted')
  await s4.close()
  exp4.stop()
})

await test('disk: the export writes nothing to the data dir', async () => {
  const list = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(d, e.name)).map((x) => `${e.name}/${x}`) : [e.name]))
  const before = list(dir).sort()
  await exp.manifest()
  for (const a of manifest.artifacts) await get(`${srv.url}/api/export/file/${a.path}`, auth)
  assert.deepEqual(list(dir).sort(), before)
})

await srv.close()
exp.stop()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
