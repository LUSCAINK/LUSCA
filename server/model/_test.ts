// Tests for server/model/export.ts (SEPIA-0 checkpoint → safetensors → manifest, cache, routes).
// Run: npx tsx server/model/_test.ts [--no-trainer]
//
//   1. synthetic checkpoint (same layout as trainer.ts encodeCheckpoint) → readCheckpoint →
//      toSafetensors → parseSafetensors: every weight bit-identical, shapes, metadata
//   2. header alignment for every padding case, space padding, contiguous data_offsets
//   3. manifest fields, determinism, no contributor keys exported
//   4. malformed inputs rejected
//   5. cached builder: TTL, unchanged-file reuse, single flight, failure caching
//   6. handleModelRoute over a real HTTP server: 200 / 304 / HEAD / 405 / 429 / 503
//   7. (unless --no-trainer) a checkpoint written by the real trainer's own save path
// Exits non-zero on any failure.
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LossPoint, ServerMsg } from '../../shared/protocol.ts'
import { CTX, EMB, HIDDEN, SepiaModel, VOCAB, VOCAB_SIZE, mulberry32, paramCount } from '../../shared/sepia/model.mjs'
import {
  MANIFEST_ROUTE,
  NoCheckpointError,
  WEIGHTS_ROUTE,
  buildExport,
  createWeightsExporter,
  handleModelRoute,
  parseCheckpoint,
  parseSafetensors,
  readCheckpoint,
  toSafetensors,
  type CheckpointData,
  type WeightsExporter,
} from './export.ts'

const NO_TRAINER = process.argv.includes('--no-trainer')
const N = paramCount()
let failures = 0
function ok(cond: boolean, msg: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`)
  if (!cond) failures++
}
async function throwsAsync(fn: () => Promise<unknown>, re: RegExp, msg: string) {
  try {
    await fn()
    ok(false, `${msg} (no error)`)
  } catch (e) {
    ok(re.test(e instanceof Error ? e.message : String(e)), `${msg} → ${(e as Error).message}`)
  }
}
function throws(fn: () => unknown, re: RegExp, msg: string) {
  try {
    fn()
    ok(false, `${msg} (no error)`)
  } catch (e) {
    ok(re.test(e instanceof Error ? e.message : String(e)), `${msg} → ${(e as Error).message}`)
  }
}
const bitsEqual = (a: Float32Array, b: Float32Array) => {
  if (a.length !== b.length) return false
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length)
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length)
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false
  return true
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

// ─── synthetic checkpoint (mirror of trainer.ts encodeCheckpoint) ───────────

interface Synth {
  step: number
  params: Float32Array
  history: [number, number, number, number, number][]
  savedAt: number
  train?: unknown
  header?: Record<string, unknown>
}

function synthCheckpoint(s: Synth): Buffer {
  const header = {
    version: 1,
    name: 'SEPIA-0',
    T: CTX,
    E: EMB,
    H: HIDDEN,
    V: VOCAB_SIZE,
    nParams: N,
    step: s.step,
    adamT: s.step,
    historyCount: s.history.length,
    samples: [{ step: s.step, text: 'The validator signs' }],
    savedAt: s.savedAt,
    train: s.train,
    ...s.header,
  }
  const hj = Buffer.from(JSON.stringify(header), 'utf8')
  const pre = 8 + 4 + hj.length
  const dataOff = pre + ((8 - (pre % 8)) % 8)
  const histOff = dataOff + 3 * N * 4
  const histOffAligned = histOff + ((8 - (histOff % 8)) % 8)
  const buf = Buffer.alloc(histOffAligned + s.history.length * 40)
  buf.write('SEPIACK1', 0, 'latin1')
  buf.writeUInt32LE(hj.length, 8)
  hj.copy(buf, 12)
  const r = mulberry32(99)
  const m = Float32Array.from({ length: N }, () => r() - 0.5)
  const v = Float32Array.from({ length: N }, () => r() * 1e-3)
  let off = dataOff
  for (const a of [s.params, m, v]) {
    Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(buf, off)
    off += a.byteLength
  }
  const rows = new Float64Array(s.history.flat())
  Buffer.from(rows.buffer).copy(buf, histOffAligned)
  return buf
}

function randomParams(seed: number): Float32Array {
  const r = mulberry32(seed)
  // Includes values that stress the encoding: signed zero, subnormals, large magnitudes.
  const p = Float32Array.from({ length: N }, () => (r() - 0.5) * 6)
  p[0] = -0
  p[1] = 1e-42
  p[2] = -3.4e38
  p[N - 1] = 123456.789
  return p
}

const SAVED_AT = Date.UTC(2026, 9, 5, 12, 0, 0)
const HIST: [number, number, number, number, number][] = Array.from({ length: 37 }, (_, i) => {
  const step = (i + 1) * 25
  return [step, 4.5 - i * 0.05, i % 10 === 9 ? 4.4 - i * 0.05 : Number.NaN, step * 64, SAVED_AT - (37 - i) * 1000]
})
const TRAIN = {
  gpuSteps: 120,
  serverSteps: 805,
  gpuSamples: 245_760,
  auditsOk: 41,
  auditsFailed: 3,
  rejected: 2,
  stale: 1,
  samplesSeen: 297_280,
  contributors: [
    ['neuronKeyAlpha', SAVED_AT - 60_000],
    ['neuronKeyBravo', SAVED_AT - 25 * 3600_000], // older than 24 h: not counted
    ['neuronKeyCharlie', SAVED_AT - 5_000],
  ],
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'lusca-model-export-'))
  try {
    await unitTests(dir)
    await exporterTests(dir)
    await routeTests(dir)
    if (!NO_TRAINER) await trainerTest()
    else console.log('skip trainer save-path test (--no-trainer)')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  // exitCode, not process.exit(): exiting while fetch's keep-alive sockets are closing trips a libuv
  // assertion on Windows (exit 127 instead of 0).
  process.exitCode = failures ? 1 : 0
}

// ─── 1–4: format ────────────────────────────────────────────────────────────

async function unitTests(dir: string) {
  const params = randomParams(7)
  const file = path.join(dir, 'sepia.ckpt')
  await writeFile(file, synthCheckpoint({ step: 925, params, history: HIST, savedAt: SAVED_AT, train: TRAIN }))

  // 1. checkpoint → CheckpointData
  const ck = await readCheckpoint(file)
  ok(ck.format === 1 && ck.version === 925 && ck.step === 925 && ck.adamT === 925, `header: format ${ck.format}, version ${ck.version}, step ${ck.step}`)
  ok(ck.savedAt === SAVED_AT && ck.nParams === N && ck.historyCount === 37, 'savedAt, nParams, historyCount')
  ok(bitsEqual(ck.params, params), `all ${N} params bit-identical (incl. -0, subnormal, ±3.4e38)`)
  ok(ck.loss === HIST[36][1], `loss = newest history row (${ck.loss})`)
  ok(ck.val === HIST[29][2], `val = newest non-NaN val (${ck.val})`)
  const c = ck.counters
  ok(
    c !== null && c.gpuSteps === 120 && c.serverSteps === 805 && c.gpuSamples === 245_760 && c.samplesSeen === 297_280 && c.auditsOk === 41 && c.auditsFailed === 3 && c.rejected === 2 && c.stale === 1,
    'GPU pipeline counters',
  )
  ok(c?.contributors24h === 2, `contributors in the 24 h before the save: ${c?.contributors24h} (one older key ignored)`)
  const shapes = ck.tensors.map((t) => `${t.name}[${t.shape.join('x')}]@${t.offset}`).join(' ')
  ok(shapes === `emb[96x24]@0 W1[384x384]@2304 b1[384]@149760 W2[384x96]@150144 b2[96]@187008`, `tensor map: ${shapes}`)
  ok(ck.tensors.every((t) => t.data.buffer === ck.params.buffer), 'tensors are views of the flat parameter vector')

  // 2. safetensors round trip + layout
  const meta = { name: 'SEPIA-0', vocab: VOCAB, note: 'ünïcödé "quoted"\n' }
  const st = toSafetensors(ck.tensors, meta)
  const back = parseSafetensors(st)
  ok(back.tensors.map((t) => t.name).join(',') === 'emb,W1,b1,W2,b2', 'tensor order preserved')
  ok(back.tensors.every((t, i) => t.shape.join() === ck.tensors[i].shape.join() && bitsEqual(t.data, ck.tensors[i].data)), 'parse back: shapes and every weight bit-identical')
  ok(JSON.stringify(back.metadata) === JSON.stringify(meta), 'metadata round trip (newline, quotes, non-ASCII)')
  const hl = Number(st.readBigUInt64LE(0))
  ok(hl === back.headerLength && (8 + hl) % 8 === 0, `header length ${hl}, data starts at ${8 + hl} (8-byte aligned)`)
  ok(st.length === 8 + hl + N * 4, `file size ${st.length} = 8 + ${hl} + ${N}·4`)
  ok(Buffer.compare(st.subarray(8 + hl), Buffer.from(params.buffer)) === 0, 'data section == the flat float32 parameter vector, byte for byte')
  const rawHeader = st.toString('utf8', 8, 8 + hl)
  const parsedHeader = JSON.parse(rawHeader) as Record<string, { data_offsets?: number[] }>
  ok(Object.keys(parsedHeader)[0] === '__metadata__', '__metadata__ first in the header')
  const offs = ['emb', 'W1', 'b1', 'W2', 'b2'].map((k) => parsedHeader[k].data_offsets!.join('-')).join(' ')
  ok(offs === '0-9216 9216-599040 599040-600576 600576-748032 748032-748416', `contiguous data_offsets: ${offs}`)

  let alignOk = true
  const padSeen = new Set<number>()
  for (let k = 0; k < 24; k++) {
    const b = toSafetensors([{ name: 'x', shape: [3], data: new Float32Array([1, 2, 3]) }], { k: 'y'.repeat(k) })
    const h = Number(b.readBigUInt64LE(0))
    const json = JSON.stringify({ __metadata__: { k: 'y'.repeat(k) }, x: { dtype: 'F32', shape: [3], data_offsets: [0, 12] } })
    const pad = h - Buffer.byteLength(json)
    padSeen.add(pad)
    const padding = b.subarray(8 + Buffer.byteLength(json), 8 + h)
    if ((8 + h) % 8 !== 0 || pad < 0 || pad > 7 || !padding.every((x) => x === 0x20) || b.readFloatLE(8 + h + 8) !== 3) alignOk = false
  }
  ok(alignOk && padSeen.size === 8, `alignment for every padding length (0–7 spaces seen: ${[...padSeen].sort().join(',')})`)

  // 3. bundle + manifest
  const bundle = buildExport(ck)
  ok(bundle.sha256 === sha(bundle.safetensors) && bundle.bytes === bundle.safetensors.length, `sha256 ${bundle.sha256.slice(0, 16)}…, ${bundle.bytes} bytes`)
  ok(buildExport(ck).sha256 === bundle.sha256, 'deterministic: same checkpoint → same bytes')
  ok(buildExport(ck, { license: 'CC-BY-4.0' }).sha256 !== bundle.sha256, 'license is part of the metadata')
  const sm = parseSafetensors(bundle.safetensors).metadata
  ok(
    sm.name === 'SEPIA-0' && sm.vocab === VOCAB && sm.vocab.length === 96 && sm.step === '925' && sm.version === '925' && sm.ctx === '16' && sm.emb === '24' && sm.hidden === '384' && sm.activation === 'tanh' && sm.license === 'MIT',
    'safetensors metadata: name, vocab (96 chars), step, dims, license',
  )
  ok(sm.saved_at === new Date(SAVED_AT).toISOString(), `metadata saved_at ${sm.saved_at}`)
  const mf = bundle.manifest
  const required = ['name', 'params', 'arch', 'vocab', 'ctx', 'version', 'step', 'loss', 'val', 'sha256', 'bytes', 'updatedAt', 'license']
  ok(required.every((k) => k in mf), `manifest has ${required.join(', ')}`)
  ok(
    mf.name === 'SEPIA-0' && mf.params === 187_104 && mf.vocab === 96 && mf.ctx === 16 && mf.step === 925 && mf.version === 925 && mf.loss === ck.loss && mf.val === ck.val,
    'manifest values',
  )
  ok(mf.arch === 'char-MLP · ctx 16 · emb 24 · hidden 384 · tanh', `arch "${mf.arch}"`)
  ok(mf.sha256 === bundle.sha256 && mf.bytes === bundle.bytes && mf.updatedAt === new Date(SAVED_AT).toISOString() && mf.license === 'MIT', 'manifest sha256 / bytes / updatedAt / license')
  ok(mf.training?.gpuSamples === 245_760 && mf.training.audits.ok === 41 && mf.training.audits.failed === 3 && mf.training.contributors24h === 2, 'manifest training counters')
  ok(!/neuronKey/.test(bundle.manifestJson) && !/neuronKey/.test(bundle.safetensors.toString('latin1', 0, 4096)), 'contributor keys are not exported (count only)')
  ok(mf.tensors.every((t, i) => t.data_offsets.join() === Object.values(parsedHeader).slice(1)[i].data_offsets!.join()), 'manifest tensor offsets match the file header')

  // mapping check: a model loaded from the safetensors tensors in file order computes the same logits
  const mA = new SepiaModel()
  mA.load(ck.params)
  const flat = new Float32Array(N)
  let o = 0
  for (const t of parseSafetensors(bundle.safetensors).tensors) {
    flat.set(t.data, o)
    o += t.data.length
  }
  const mB = new SepiaModel()
  mB.load(flat)
  const ctx = new Uint8Array(16).map((_, i) => (i * 7) % 96)
  ok(bitsEqual(mA.logits(ctx).slice() as Float32Array, mB.logits(ctx).slice() as Float32Array), 'concatenating the file tensors in order reproduces the parameter vector (identical logits)')

  // pre-GPU checkpoint: no counters
  const old = parseCheckpoint(synthCheckpoint({ step: 10, params, history: HIST.slice(0, 2), savedAt: SAVED_AT }))
  ok(old.counters === null && buildExport(old).manifest.training === null, 'checkpoint without GPU counters → counters null, manifest.training null')
  const noVal = parseCheckpoint(synthCheckpoint({ step: 10, params, history: [[25, 4.4, Number.NaN, 1600, SAVED_AT]], savedAt: SAVED_AT }))
  ok(noVal.loss === 4.4 && noVal.val === null, 'no validation point yet → val null')

  // 4. malformed inputs
  const good = synthCheckpoint({ step: 925, params, history: HIST, savedAt: SAVED_AT, train: TRAIN })
  const bad = Buffer.from(good)
  bad.write('XEPIACK1', 0, 'latin1')
  throws(() => parseCheckpoint(bad), /bad magic/, 'bad magic rejected')
  throws(() => parseCheckpoint(good.subarray(0, good.length - 8)), /truncated/, 'truncated body rejected')
  throws(() => parseCheckpoint(synthCheckpoint({ step: 1, params, history: [], savedAt: 0, header: { version: 2 } })), /unsupported checkpoint format/, 'unknown format rejected')
  throws(() => parseCheckpoint(synthCheckpoint({ step: 1, params, history: [], savedAt: 0, header: { nParams: N - 1 } })), /nParams/, 'inconsistent nParams rejected')
  const nanParams = params.slice()
  nanParams[5000] = Number.NaN
  throws(() => parseCheckpoint(synthCheckpoint({ step: 1, params: nanParams, history: [], savedAt: 0 })), /non-finite weight at index 5000/, 'NaN weight rejected')
  await throwsAsync(() => readCheckpoint(path.join(dir, 'missing.ckpt')), /no SEPIA-0 checkpoint/, 'missing file → NoCheckpointError')
  throws(() => toSafetensors([{ name: 'x', shape: [2, 2], data: new Float32Array(3) }]), /holds 4 values/, 'shape/data mismatch rejected')
  throws(() => toSafetensors([{ name: 'x', shape: [1], data: new Float32Array(1) }], { a: 1 as unknown as string }), /must be strings/, 'non-string metadata rejected')
  throws(() => toSafetensors([{ name: 'x', shape: [1], data: new Float32Array(1) }, { name: 'x', shape: [1], data: new Float32Array(1) }]), /duplicate/, 'duplicate tensor name rejected')
  const gap = toSafetensors([{ name: 'a', shape: [2], data: new Float32Array(2) }, { name: 'b', shape: [2], data: new Float32Array(2) }])
  const gh = Number(gap.readBigUInt64LE(0))
  const tampered = Buffer.from(gap)
  tampered.write(gap.toString('utf8', 8, 8 + gh).replace('"data_offsets":[8,16]', '"data_offsets":[4,12]'), 8, 'utf8')
  throws(() => parseSafetensors(tampered), /gap or overlap/, 'overlapping data_offsets rejected')
  const huge = Buffer.from(gap)
  huge.writeBigUInt64LE(BigInt(gap.length), 0)
  throws(() => parseSafetensors(huge), /header length out of range/, 'header length beyond the file rejected')
}

// ─── 5: cached builder ──────────────────────────────────────────────────────

async function exporterTests(dir: string) {
  const file = path.join(dir, 'cache.ckpt')
  const p1 = randomParams(11)
  await writeFile(file, synthCheckpoint({ step: 100, params: p1, history: HIST, savedAt: SAVED_AT, train: TRAIN }))
  let clock = 1_000_000
  let reads = 0
  let stats = 0
  const ex = createWeightsExporter({
    ckptPath: file,
    now: () => clock,
    stat: async (f) => {
      stats++
      const { stat } = await import('node:fs/promises')
      return stat(f)
    },
    read: async (f) => {
      reads++
      return readCheckpoint(f)
    },
  })
  ok(ex.peek() === null, 'no bundle before the first request')
  const [a, b] = await Promise.all([ex.get(), ex.get()])
  ok(a === b && reads === 1, `concurrent first requests share one build (reads ${reads})`)
  clock += 5 * 60_000
  await writeFile(file, synthCheckpoint({ step: 200, params: randomParams(12), history: HIST, savedAt: SAVED_AT + 1, train: TRAIN }))
  await utimes(file, new Date(), new Date(Date.now() + 5000))
  const c = await ex.get()
  ok(c === a && c.step === 100 && reads === 1 && stats === 1, 'within 10 min: served from memory, checkpoint not re-read')
  clock += 6 * 60_000
  const d = await ex.get()
  ok(d.step === 200 && reads === 2 && d.sha256 !== a.sha256, `after 10 min: changed checkpoint rebuilt (step ${d.step})`)
  clock += 11 * 60_000
  const e = await ex.get()
  ok(e === d && reads === 2 && stats === 3, 'after 10 min with an unchanged file (mtime + size): same bundle, no re-read')

  // damaged file after a good build: keep serving the previous bundle
  await writeFile(file, Buffer.from('garbage that is not a checkpoint'))
  clock += 11 * 60_000
  const f = await ex.get()
  ok(f === d && reads === 3, 'damaged checkpoint: previous bundle kept')

  // never had a checkpoint: failure cached for 60 s
  let stats2 = 0
  const missing = createWeightsExporter({
    ckptPath: path.join(dir, 'nope.ckpt'),
    now: () => clock,
    stat: async (f) => {
      stats2++
      const { stat } = await import('node:fs/promises')
      return stat(f)
    },
  })
  await throwsAsync(() => missing.get(), /no SEPIA-0 checkpoint/, 'missing checkpoint → NoCheckpointError')
  await throwsAsync(() => missing.get(), /no SEPIA-0 checkpoint/, 'second request inside 60 s → cached error')
  ok(stats2 === 1, `missing file stat'ed once in 60 s (${stats2})`)
  ok(await missing.get().then(() => false, (e: unknown) => e instanceof NoCheckpointError), 'the error is a NoCheckpointError (routes answer 503)')
  ex.invalidate()
  ok(ex.peek() === null, 'invalidate() drops the cache')
}

// ─── 6: routes ──────────────────────────────────────────────────────────────

async function routeTests(dir: string) {
  const file = path.join(dir, 'route.ckpt')
  await writeFile(file, synthCheckpoint({ step: 4321, params: randomParams(21), history: HIST, savedAt: SAVED_AT, train: TRAIN }))
  let wait = 0
  let exporter: WeightsExporter = createWeightsExporter({ ckptPath: file })
  const server = http.createServer((req, res) => {
    void (async () => {
      const p = new URL(req.url ?? '/', 'http://localhost').pathname
      const handled = await handleModelRoute(p, req, res, { exporter, take: () => wait })
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end('{"error":"not found"}')
      }
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const r1 = await fetch(base + WEIGHTS_ROUTE)
    const body = new Uint8Array(await r1.arrayBuffer())
    const digest = sha(body)
    ok(r1.status === 200 && r1.headers.get('content-type') === 'application/octet-stream', `GET weights → ${r1.status} ${r1.headers.get('content-type')}`)
    ok(r1.headers.get('etag') === `"${digest}"`, `ETag = sha256 of the body (${digest.slice(0, 12)}…)`)
    ok(r1.headers.get('cache-control') === 'public, max-age=600', `Cache-Control: ${r1.headers.get('cache-control')}`)
    ok(r1.headers.get('content-disposition') === 'attachment; filename="sepia-0-step-4321.safetensors"', `Content-Disposition: ${r1.headers.get('content-disposition')}`)
    ok(Number(r1.headers.get('content-length')) === body.length && parseSafetensors(body).tensors.length === 5, 'body is a valid safetensors file')
    const r2 = await fetch(base + WEIGHTS_ROUTE, { headers: { 'If-None-Match': `W/"${digest}", "other"` } })
    ok(r2.status === 304 && r2.headers.get('etag') === `"${digest}"`, `If-None-Match → ${r2.status}`)
    const r3 = await fetch(base + WEIGHTS_ROUTE, { method: 'HEAD' })
    ok(r3.status === 200 && Number(r3.headers.get('content-length')) === body.length && (await r3.arrayBuffer()).byteLength === 0, 'HEAD → headers only')
    const r4 = await fetch(base + MANIFEST_ROUTE)
    const mf = (await r4.json()) as Record<string, unknown>
    ok(r4.status === 200 && /application\/json/.test(r4.headers.get('content-type') ?? '') && r4.headers.get('cache-control') === 'public, max-age=600', 'GET manifest → JSON, public max-age=600')
    ok(mf.name === 'SEPIA-0' && mf.step === 4321 && mf.version === 4321 && mf.sha256 === digest && mf.bytes === body.length && mf.license === 'MIT' && mf.ctx === 16 && mf.vocab === 96, 'manifest describes exactly the served file')
    const r5 = await fetch(base + MANIFEST_ROUTE, { headers: { 'If-None-Match': r4.headers.get('etag') ?? '' } })
    ok(r5.status === 304, `manifest If-None-Match → ${r5.status}`)
    const r6 = await fetch(base + WEIGHTS_ROUTE, { method: 'POST' })
    ok(r6.status === 405 && r6.headers.get('allow') === 'GET, HEAD', `POST → ${r6.status}, Allow: ${r6.headers.get('allow')}`)
    const r7 = await fetch(base + '/api/model/other')
    ok(r7.status === 404, 'other /api/model path → not handled (false)')
    wait = 1500
    const r8 = await fetch(base + MANIFEST_ROUTE)
    ok(r8.status === 429 && r8.headers.get('retry-after') === '2', `rate limited → ${r8.status}, Retry-After ${r8.headers.get('retry-after')}`)
    wait = 0
    exporter = createWeightsExporter({ ckptPath: path.join(dir, 'absent.ckpt') })
    const r9 = await fetch(base + WEIGHTS_ROUTE)
    const e9 = (await r9.json()) as { error?: string }
    ok(r9.status === 503 && r9.headers.get('retry-after') === '60' && /no SEPIA-0 checkpoint/.test(e9.error ?? ''), `no checkpoint → ${r9.status} "${e9.error}"`)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

// ─── 7: the trainer's own save path ─────────────────────────────────────────

async function trainerTest() {
  const { createTrainer } = await import('../trainer/trainer.ts')
  const dir = await mkdtemp(path.join(tmpdir(), 'lusca-model-trainer-'))
  const root = fileURLToPath(new URL('../../', import.meta.url))
  try {
    // Real text from this repository as the corpus (no network).
    const files = ['README.md', 'DESIGN.md', 'CONTRIBUTING.md', 'CHANGELOG.md', ...(await readdir(path.join(root, 'docs'))).map((f) => path.join('docs', f))]
    const docs: string[] = []
    for (const f of files) {
      try {
        const t = await readFile(path.join(root, f), 'utf8')
        for (let i = 0; i < t.length; i += 2000) docs.push(t.slice(i, i + 2000))
      } catch {
        /* optional file */
      }
    }
    const points: LossPoint[] = []
    const emit = (m: ServerMsg) => {
      if (m.t === 'loss') points.push(m.point)
    }
    const trainer = createTrainer({ dataDir: dir, emit })
    trainer.start()
    for (const d of docs) trainer.feed(d)
    const t0 = Date.now()
    while (Date.now() - t0 < 120_000 && !(points.length && points[points.length - 1].step >= 100)) await new Promise((r) => setTimeout(r, 200))
    ok(points.length > 0, `trainer trained on ${docs.length} repository chunks: ${points.length} loss points, step ${points.at(-1)?.step ?? 0}`)
    await trainer.stop()
    const ck: CheckpointData = await readCheckpoint(path.join(dir, 'sepia.ckpt'))
    const last = points.filter((p) => p.step <= ck.step).at(-1)
    ok(ck.step >= (last?.step ?? 0) && ck.step > 0, `trainer checkpoint decodes: step ${ck.step}, ${ck.historyCount} history rows`)
    ok(last !== undefined && ck.loss === last.loss, `checkpoint loss ${ck.loss} = newest emitted point ${last?.loss}`)
    ok(ck.counters !== null && ck.counters.serverSteps + ck.counters.gpuSteps === ck.step, `counters present: ${ck.counters?.serverSteps} server + ${ck.counters?.gpuSteps} GPU steps = ${ck.step}`)
    const bundle = buildExport(ck)
    const parsed = parseSafetensors(bundle.safetensors)
    const flat = new Float32Array(N)
    let o = 0
    for (const t of parsed.tensors) {
      flat.set(t.data, o)
      o += t.data.length
    }
    ok(bitsEqual(flat, ck.params), `trainer weights → safetensors → parse: bit-identical (${bundle.bytes} bytes, sha256 ${bundle.sha256.slice(0, 12)}…)`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

