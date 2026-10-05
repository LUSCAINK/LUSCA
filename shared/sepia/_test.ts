// Tests + measurements for the SEPIA-0 distributed-training core.
// Run: npx tsx shared/sepia/_test.ts
//
// Env: SEPIA_REFERENCE=<path to a pre-extraction model.mjs> also compares
//      lossAndGrad bit-for-bit against that file's SepiaModel.forward.
//      LUSCA_DATA (server/data) — text batches come from <LUSCA_DATA>/dataset.jsonl
//      (first ~6 MB); without it, from the repository's own Markdown/TS sources.
// Exits non-zero on any failure.
import {
  Adam,
  GRAD_BYTES,
  SEPIA,
  SepiaModel,
  batchPass,
  cosine,
  decodeGrad,
  encodeChars,
  encodeGrad,
  f16ToF32,
  f32ToF16,
  l2,
  lossAndGrad,
  lossOnly,
  makeBuffers,
  mulberry32,
  paramLayout,
  relErr,
  roundTripF16,
  trainFlops,
  type Dims,
} from './index.mjs'
import { encode as serverEncode } from '../../server/trainer/model.mjs'

// shared/ is also type-checked with browser-only types (tsconfig.app.json), so
// Node APIs are reached through a dynamic import and a narrow local type.
interface NodeFs {
  readFileSync(p: URL, enc: 'utf8'): string
  existsSync(p: URL): boolean
  openSync(p: URL, flags: string): number
  readSync(fd: number, buf: Uint8Array, off: number, len: number, pos: number): number
  closeSync(fd: number): void
  readdirSync(p: URL): string[]
}
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as NodeFs
type Proc = { env: Record<string, string | undefined>; cwd(): string; exit(code: number): never }
const proc = (globalThis as unknown as { process: Proc }).process
const slash = (p: string) => p.split('\\').join('/')
const CWD = new URL(`file:///${slash(proc.cwd()).replace(/^\//, '')}/`)
/** A filesystem path (absolute, Windows drive or relative to the cwd) → file: URL. */
const fileUrl = (p: string, dir = false) => {
  const s = slash(p) + (dir && !p.endsWith('/') ? '/' : '')
  return /^[A-Za-z]:\//.test(s) ? new URL(`file:///${s}`) : new URL(s, CWD)
}

let failures = 0
function ok(cond: boolean, msg: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`)
  if (!cond) failures++
}
const ROOT = new URL('../../', import.meta.url)
const N = SEPIA.params
const T = SEPIA.ctx
const V = SEPIA.vocab

// ─── 1. Layout ──────────────────────────────────────────────────────────────
{
  const L = paramLayout()
  let off = 0
  let shapesOk = true
  for (const t of SEPIA.layout) {
    shapesOk &&= t.offset === off && t.length === t.shape.reduce((a, b) => a * b, 1)
    off += t.length
  }
  ok(
    shapesOk && off === N && N === 187104 && L.total === N && SEPIA.layout[1].offset === L.W1 && SEPIA.layout[4].offset === L.b2,
    `layout: ${SEPIA.layout.map((t) => `${t.name}[${t.shape.join('×')}]@${t.offset}`).join(' ')} = ${N} params`,
  )
}

// ─── Real text ──────────────────────────────────────────────────────────────
function loadTexts(): { texts: string[]; source: string } {
  const env = proc.env.LUSCA_DATA
  const dataDir = env ? fileUrl(env, true) : new URL('server/data/', ROOT)
  const file = new URL('dataset.jsonl', dataDir)
  if (fs.existsSync(file)) {
    const fd = fs.openSync(file, 'r')
    const buf = new Uint8Array(6 * 1024 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const lines = new TextDecoder().decode(buf.subarray(0, n)).split('\n')
    lines.pop() // possibly truncated
    const texts: string[] = []
    for (const l of lines) {
      try {
        const t = JSON.parse(l)?.text
        if (typeof t === 'string') texts.push(t)
      } catch {
        /* skip */
      }
    }
    if (texts.length > 0) return { texts, source: `${decodeURIComponent(file.pathname)} (${texts.length} docs)` }
  }
  const texts: string[] = []
  for (const dir of ['.', 'server', 'shared', 'src/lib']) {
    const d = new URL(`${dir}/`, ROOT)
    for (const f of fs.readdirSync(d)) {
      if (/\.(md|ts)$/.test(f)) texts.push(fs.readFileSync(new URL(f, d), 'utf8'))
    }
  }
  return { texts, source: `repository sources (${texts.length} files)` }
}
const { texts, source } = loadTexts()
console.log(`text source: ${source}`)

// ─── 2. encodeChars ≡ worker encode ─────────────────────────────────────────
{
  let same = true
  let chars = 0
  const probes = [...texts.slice(0, 400), 'The “bridge” — EIP‑4844 costs 0.5 ETH… café\tok\r\n\n\n\nend 🚀 x', '  lead\n', '']
  for (const s of probes) {
    const a = encodeChars(s)
    const b = serverEncode(s)
    chars += a.length
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) same = false
  }
  ok(same, `encodeChars ≡ worker encode() on ${probes.length} texts (${chars.toLocaleString()} ids)`)
}

// Corpus stream: documents joined by '\n', as ids.
const corpus = (() => {
  const parts = texts.map((t) => encodeChars(t)).filter((a) => a.length >= 48)
  const total = parts.reduce((s, a) => s + a.length + 1, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
    out[o++] = 0
  }
  return out
})()
console.log(`corpus: ${corpus.length.toLocaleString()} ids`)

function batch(B: number, rand: () => number) {
  const x = new Uint8Array(B * T)
  const y = new Uint8Array(B)
  for (let b = 0; b < B; b++) {
    const s = Math.floor(rand() * (corpus.length - T - 1))
    x.set(corpus.subarray(s, s + T), b * T)
    y[b] = corpus[s + T]
  }
  return { x, y }
}

const rand = mulberry32(20261005)
const model = new SepiaModel()
model.init(rand)

// ─── 3. lossAndGrad ≡ SepiaModel.forward (and the legacy file if given) ─────
{
  const { x, y } = batch(64, rand)
  // Non-trivial weights: a few Adam steps on real batches first.
  const adam = new Adam(N)
  for (let s = 0; s < 30; s++) {
    const b = batch(64, rand)
    model.forward(b.x, b.y, 64, true)
    adam.step(model.params, model.grads, 3e-3, 1)
  }
  const P = model.params as Float32Array
  const g = new Float32Array(N)
  const la = lossAndGrad(P, x, y, 64, g)
  const lm = model.forward(x, y, 64, true)
  const bitEq = la === lm && g.every((v, i) => Object.is(v, model.grads[i]))
  ok(bitEq, `lossAndGrad ≡ SepiaModel.forward bit-for-bit (loss ${la.toFixed(6)})`)
  ok(lossOnly(P, x, y, 64) === la, 'lossOnly ≡ lossAndGrad loss')

  const ref = proc.env.SEPIA_REFERENCE
  if (ref) {
    const refUrl = fileUrl(ref)
    const legacy = await import(/* @vite-ignore */ refUrl.href)
    const lm2 = new legacy.SepiaModel()
    lm2.load(P)
    const ll = lm2.forward(x, y, 64, true)
    let maxAbs = 0
    for (let i = 0; i < N; i++) maxAbs = Math.max(maxAbs, Math.abs(g[i] - lm2.grads[i]))
    const ids = legacy.encode(texts[0] ?? 'x')
    const encSame = ids.length === encodeChars(texts[0] ?? 'x').length
    ok(ll === la && maxAbs === 0 && encSame, `lossAndGrad ≡ legacy ${refUrl.pathname.split('/').pop()} (loss Δ ${Math.abs(ll - la)}, max |Δgrad| ${maxAbs})`)
  }
  // Batch-size independence of the scratch: a big call then a small one.
  const big = batch(300, rand)
  lossAndGrad(P, big.x, big.y, 300, new Float32Array(N))
  const g2 = new Float32Array(N)
  ok(lossAndGrad(P, x, y, 64, g2) === la && g2.every((v, i) => v === g[i]), 'reused (larger) scratch gives identical results')
  let threw = 0
  const bad = x.slice()
  bad[5] = 96
  for (const f of [
    () => lossAndGrad(P, bad, y, 64, g2),
    () => lossAndGrad(P.subarray(1), x, y, 64, g2),
    () => lossAndGrad(P, x, y, 65, g2),
    () => lossAndGrad(P, x, y, 64, new Float32Array(5)),
  ]) {
    try {
      f()
    } catch {
      threw++
    }
  }
  ok(threw === 4, 'rejects out-of-vocab ids and wrong sizes')
}

// ─── 4. Finite-difference gradcheck of lossAndGrad ──────────────────────────
// Analytic: float32 lossAndGrad. Numeric: central differences of the SAME
// batchPass in float64 at the same (float32-representable) parameters.
{
  const P = Float32Array.from(model.params)
  for (let i = SEPIA.layout[2].offset; i < N; i++) P[i] += (rand() - 0.5) * 0.2 // non-trivial biases/W2
  const B = 16
  const { x, y } = batch(B, rand)
  const g = new Float32Array(N)
  lossAndGrad(P, x, y, B, g)
  const P64 = Float64Array.from(P)
  const dims: Dims = { T, E: SEPIA.emb, H: SEPIA.hidden, V, layout: paramLayout() }
  const bufs = makeBuffers(Float64Array, B, T, SEPIA.emb, SEPIA.hidden, V)
  const eps = 1e-5
  let worst = 0
  let bad = 0
  let probes = 0
  for (const t of SEPIA.layout) {
    const idxs: number[] = []
    if (t.name === 'emb') idxs.push(x[0] * SEPIA.emb, x[0] * SEPIA.emb + 5) // rows actually looked up
    while (idxs.length < 24) idxs.push(t.offset + Math.floor(rand() * t.length))
    let tw = 0
    for (const i of idxs) {
      const o = P64[i]
      P64[i] = o + eps
      const lp = batchPass(dims, P64, null, x, y, B, bufs)
      P64[i] = o - eps
      const lm = batchPass(dims, P64, null, x, y, B, bufs)
      P64[i] = o
      const num = (lp - lm) / (2 * eps)
      const err = Math.abs(num - g[i])
      const tol = 2e-3 * Math.max(Math.abs(num), Math.abs(g[i])) + 2e-7
      if (err > tol) {
        bad++
        console.log(`    ${t.name}[${i - t.offset}] analytic ${g[i].toExponential(4)} numeric ${num.toExponential(4)}`)
      }
      const mag = Math.abs(num) + Math.abs(g[i])
      if (mag > 1e-6) tw = Math.max(tw, err / mag)
      probes++
    }
    worst = Math.max(worst, tw)
    console.log(`    ${t.name.padEnd(3)} max rel err ${tw.toExponential(2)}`)
  }
  ok(bad === 0, `finite-difference gradcheck: ${probes} probes over 5 tensors, worst rel err ${worst.toExponential(2)} (float32 analytic vs float64 numeric)`)
}

// ─── 5. f16 codec ───────────────────────────────────────────────────────────
{
  // Exhaustive: every non-NaN half survives f16 → f32 → f16.
  const all = new Uint16Array(65536)
  for (let i = 0; i < 65536; i++) all[i] = i
  const back = f32ToF16(f16ToF32(all))
  let rt = 0
  for (let i = 0; i < 65536; i++) {
    const isNaN16 = (i & 0x7c00) === 0x7c00 && (i & 0x3ff) !== 0
    if (isNaN16 ? (back[i] & 0x7c00) === 0x7c00 && (back[i] & 0x3ff) !== 0 : back[i] === i) rt++
  }
  ok(rt === 65536, `f16 → f32 → f16 exact for all 65,536 bit patterns (${rt})`)

  // Rounding vs the engine's own IEEE binary16 rounding (Math.f16round) when present.
  const r = mulberry32(7)
  const xs = new Float32Array(1_000_000)
  for (let i = 0; i < xs.length; i++) {
    const mag = 2 ** (r() * 60 - 34) // 2^-34 … 2^26: subnormals, normals, overflow
    xs[i] = (r() < 0.5 ? -1 : 1) * mag
  }
  xs.set([0, -0, 1, 65504, 65519.99, 65520, 2 ** -24, 2 ** -25, 3 * 2 ** -25, 2 ** -14, Infinity, -Infinity, NaN], 0)
  const h = f16ToF32(f32ToF16(xs))
  const f16round = (Math as unknown as { f16round?: (x: number) => number }).f16round
  if (f16round) {
    let mism = 0
    for (let i = 0; i < xs.length; i++) if (!Object.is(h[i], f16round(xs[i]))) mism++
    ok(mism === 0, `f32ToF16 rounding ≡ Math.f16round on ${xs.length.toLocaleString()} values incl. subnormals/ties/overflow (${mism} mismatches)`)
  }
  let maxRel = 0
  for (let i = 0; i < xs.length; i++) {
    const a = Math.abs(xs[i])
    if (a >= 2 ** -14 && a <= 65504) maxRel = Math.max(maxRel, Math.abs(h[i] - xs[i]) / a)
  }
  ok(maxRel <= 2 ** -11, `f16 max relative error in the normal range ${maxRel.toExponential(3)} (bound 2^-11 = ${(2 ** -11).toExponential(3)})`)
  const pw = roundTripF16(model.params as Float32Array)
  console.log(`    weights after f16 transfer: rel L2 err ${relErr(pw, model.params as Float32Array).toExponential(3)}`)
}

// ─── 6. Gradient codec ──────────────────────────────────────────────────────
{
  const P = model.params as Float32Array
  for (const B of [64, 1024]) {
    const { x, y } = batch(B, rand)
    const g = new Float32Array(N)
    lossAndGrad(P, x, y, B, g)
    const bytes = encodeGrad(g)
    const d = decodeGrad(bytes)
    const again = encodeGrad(g)
    let maxRel = 0
    for (const t of SEPIA.layout) {
      let m = 0
      for (let i = t.offset; i < t.offset + t.length; i++) m = Math.max(m, Math.abs(g[i]))
      for (let i = t.offset; i < t.offset + t.length; i++) {
        if (Math.abs(g[i]) >= m * 2 ** -28) maxRel = Math.max(maxRel, Math.abs(d[i] - g[i]) / Math.abs(g[i]))
      }
    }
    ok(
      bytes.length === GRAD_BYTES && again.every((v, i) => v === bytes[i]) && maxRel <= 2 ** -11,
      `grad codec B=${B}: ${bytes.length.toLocaleString()} bytes, cosine ${cosine(d, g).toFixed(9)}, rel L2 err ${relErr(d, g).toExponential(3)}, max elem rel err ${maxRel.toExponential(3)}, deterministic`,
    )
  }
  const g = new Float32Array(N)
  g[10] = NaN
  g[200000 - 20000] = Infinity
  g[3000] = 1e-3
  const d = decodeGrad(encodeGrad(g))
  ok(Number.isNaN(d[10]) && d[180000] === Infinity && Math.abs(d[3000] - 1e-3) < 1e-6, 'grad codec preserves NaN/Inf (finiteness check sees them)')
  const z = decodeGrad(encodeGrad(new Float32Array(N)))
  ok(l2(z) === 0, 'grad codec: all-zero gradient round-trips')
  let threw = 0
  for (const b of [new Uint8Array(GRAD_BYTES - 1), new Uint8Array(GRAD_BYTES)]) {
    try {
      decodeGrad(b) // second: zero scale header
    } catch {
      threw++
    }
  }
  ok(threw === 2, 'decodeGrad rejects wrong length and a zero scale header')
}

// ─── 7. FLOPs ───────────────────────────────────────────────────────────────
{
  const { emb: E, hidden: H } = SEPIA
  ok(trainFlops(1) === 6 * (T * E * H + H * V) && trainFlops(1) === 1_105_920, `trainFlops(B) = 6·B·(T·E·H + H·V) = 1,105,920·B → B=64 ${(trainFlops(64) / 1e9).toFixed(4)} GFLOP, B=4096 ${(trainFlops(4096) / 1e9).toFixed(3)} GFLOP`)
}

// ─── 8. Audit calibration on real batches (honest vs dishonest) ─────────────
{
  const P = model.params as Float32Array
  const Pq = roundTripF16(P)
  console.log('audit calibration (weights after 30 Adam steps on real text):')
  for (const B of [256, 1024]) {
    const { x, y } = batch(B, rand)
    const gFull = new Float32Array(N)
    const lFull = lossAndGrad(Pq, x, y, B, gFull)
    const gF32 = new Float32Array(N)
    lossAndGrad(P, x, y, B, gF32)
    const sub = (n: number, from: number) => {
      const g = new Float32Array(N)
      const l = lossAndGrad(Pq, x.subarray(from * T, (from + n) * T), y.subarray(from, from + n), n, g)
      return { g, l }
    }
    const s64 = sub(64, 0)
    const s128 = sub(128, 64)
    const other = batch(B, rand)
    const gOther = new Float32Array(N)
    lossAndGrad(Pq, other.x, other.y, B, gOther)
    console.log(
      `    B=${B}: cos(full@f16 weights, full@f32 weights) ${cosine(gFull, gF32).toFixed(6)} relErr ${relErr(gFull, gF32).toExponential(2)} | ` +
        `cos(sub64, full) ${cosine(s64.g, gFull).toFixed(4)} cos(sub128, full) ${cosine(s128.g, gFull).toFixed(4)} | ` +
        `cos(full of a DIFFERENT batch, full) ${cosine(gOther, gFull).toFixed(4)} | loss full ${lFull.toFixed(4)} sub64 ${s64.l.toFixed(4)} | ‖g‖ ${l2(gFull).toFixed(4)}`,
    )
  }
}

// ─── 9. CPU throughput ──────────────────────────────────────────────────────
{
  const P = model.params as Float32Array
  const g = new Float32Array(N)
  console.log('CPU lossAndGrad throughput (this machine, single thread):')
  for (const B of [64, 256, 1024]) {
    const { x, y } = batch(B, rand)
    lossAndGrad(P, x, y, B, g) // warm-up
    const reps = B === 64 ? 30 : B === 256 ? 10 : 4
    const t0 = performance.now()
    for (let i = 0; i < reps; i++) lossAndGrad(P, x, y, B, g)
    const ms = (performance.now() - t0) / reps
    const t1 = performance.now()
    for (let i = 0; i < reps; i++) lossOnly(P, x, y, B)
    const fms = (performance.now() - t1) / reps
    console.log(
      `    B=${String(B).padStart(4)}: ${ms.toFixed(1)} ms/batch → ${(trainFlops(B) / ms / 1e6).toFixed(2)} GFLOP/s (fwd only ${fms.toFixed(1)} ms) · encodeGrad+decodeGrad ${(() => {
        const t = performance.now()
        decodeGrad(encodeGrad(g))
        return (performance.now() - t).toFixed(1)
      })()} ms`,
    )
  }
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
proc.exit(failures === 0 ? 0 : 1)
