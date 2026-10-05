// @ts-check
/**
 * SEPIA-0 distributed-training core — the ONE implementation of the model math
 * used by the server (its own training, audits of contributed gradients), the
 * browser (CPU fallback + reference for the WebGPU kernels) and the desktop CLI.
 * Pure ESM, no dependencies, no Node/DOM APIs. Types: index.d.mts.
 *
 *   lossAndGrad / lossOnly   mean cross-entropy (+ gradient) for a batch, using
 *                            exactly the forward/backward of SepiaModel.forward
 *   f32ToF16 / f16ToF32      IEEE-754 binary16 conversion (round-to-nearest-even)
 *   encodeGrad / decodeGrad  gradient wire format (per-tensor power-of-two scale + f16)
 *   cosine / l2              audit metrics (float64 accumulation)
 *   trainFlops               FLOPs of one forward+backward pass
 */

import { CTX, EMB, HIDDEN, VOCAB_SIZE, batchPass, encode, makeBuffers, paramLayout } from './model.mjs'

export * from './model.mjs'

const LAYOUT = paramLayout()
const T = CTX
const E = EMB
const H = HIDDEN
const V = VOCAB_SIZE

/**
 * Model constants and the exact layout of the flat parameter vector. Matrices
 * are row-major [in][out]; W1's input is the concatenation of the T context
 * embeddings (position-major: row t·E + e).
 */
export const SEPIA = Object.freeze({
  ctx: T,
  emb: E,
  hidden: H,
  vocab: V,
  params: LAYOUT.total,
  layout: Object.freeze([
    Object.freeze({ name: 'emb', offset: LAYOUT.emb, length: V * E, shape: Object.freeze([V, E]) }),
    Object.freeze({ name: 'W1', offset: LAYOUT.W1, length: T * E * H, shape: Object.freeze([T * E, H]) }),
    Object.freeze({ name: 'b1', offset: LAYOUT.b1, length: H, shape: Object.freeze([H]) }),
    Object.freeze({ name: 'W2', offset: LAYOUT.W2, length: H * V, shape: Object.freeze([H, V]) }),
    Object.freeze({ name: 'b2', offset: LAYOUT.b2, length: V, shape: Object.freeze([V]) }),
  ]),
})

const N = LAYOUT.total
const DIMS = { T, E, H, V, layout: LAYOUT }

/**
 * Text → vocabulary ids, identical to the server corpus ingest (worker.mjs
 * calls encode(text) with keepTrailing = false).
 * @param {string} text
 * @returns {Uint8Array}
 */
export function encodeChars(text) {
  return encode(text)
}

// ─── Loss / gradient ────────────────────────────────────────────────────────

/** Float32 scratch, grown to the largest batch seen (shared by every call). */
let scratch = makeBuffers(Float32Array, 0, T, E, H, V)
let scratchRows = 0

/** @param {number} B */
function bufsFor(B) {
  if (B > scratchRows) {
    scratch = makeBuffers(Float32Array, B, T, E, H, V)
    scratchRows = B
  }
  return scratch
}

/** Drop the scratch buffers (≈ 6.5 KB per batch row) until the next call. */
export function releaseScratch() {
  scratch = makeBuffers(Float32Array, 0, T, E, H, V)
  scratchRows = 0
}

/**
 * @param {Float32Array} params @param {Uint8Array} x @param {Uint8Array} y @param {number} B
 */
function checkBatch(params, x, y, B) {
  if (!(params instanceof Float32Array) || params.length !== N) throw new Error(`params: want Float32Array(${N})`)
  if (!Number.isInteger(B) || B < 1) throw new Error(`batch: bad size ${B}`)
  if (!x || x.length < B * T) throw new Error(`x: want ${B * T} ids, got ${x?.length}`)
  if (!y || y.length < B) throw new Error(`y: want ${B} ids, got ${y?.length}`)
  // An out-of-range id would read another tensor's weights through the
  // embedding lookup — reject instead of computing something meaningless.
  for (let i = 0; i < B * T; i++) if (x[i] >= V) throw new Error(`x[${i}] = ${x[i]} is outside the vocabulary`)
  for (let i = 0; i < B; i++) if (y[i] >= V) throw new Error(`y[${i}] = ${y[i]} is outside the vocabulary`)
}

/**
 * Mean cross-entropy over the batch and its exact gradient (same arithmetic,
 * same order, same float32 storage as SepiaModel.forward(X, Y, B, true)).
 * @param {Float32Array} params SEPIA.params values
 * @param {Uint8Array} x B×ctx context ids, row-major
 * @param {Uint8Array} y B target ids
 * @param {number} B batch size
 * @param {Float32Array} gradOut SEPIA.params values, OVERWRITTEN with d(mean loss)/d(params)
 * @returns {number} mean cross-entropy (nats per character)
 */
export function lossAndGrad(params, x, y, B, gradOut) {
  checkBatch(params, x, y, B)
  if (!(gradOut instanceof Float32Array) || gradOut.length !== N) throw new Error(`gradOut: want Float32Array(${N})`)
  return batchPass(DIMS, params, gradOut, x, y, B, bufsFor(B))
}

/**
 * Mean cross-entropy over the batch (forward pass only).
 * @param {Float32Array} params @param {Uint8Array} x @param {Uint8Array} y @param {number} B
 * @returns {number}
 */
export function lossOnly(params, x, y, B) {
  checkBatch(params, x, y, B)
  return batchPass(DIMS, params, null, x, y, B, bufsFor(B))
}

/**
 * FLOPs of one forward + backward pass over B examples, counting the dense
 * matrix products only (multiply + add = 2 FLOPs), the standard convention:
 *   forward   2·B·(T·E·H + H·V)       xe·W1, h·W2
 *   backward  4·B·(T·E·H + H·V)       dW = xᵀ·g and dx = g·Wᵀ for both layers
 *   total     6·B·(T·E·H + H·V) = 6·B·(384·384 + 384·96) = 1,105,920·B
 * Element-wise work (tanh, softmax, bias, embedding gather/scatter) adds
 * ≈ 3,300·B more (0.3%) and is not counted.
 * @param {number} B
 * @returns {number}
 */
export function trainFlops(B) {
  return 6 * B * (T * E * H + H * V)
}

// ─── Half precision ─────────────────────────────────────────────────────────

const f32Tmp = new Float32Array(1)
const u32Tmp = new Uint32Array(f32Tmp.buffer)

/**
 * float32 bit pattern → binary16 bit pattern, round-to-nearest-even; overflow
 * → ±Inf, NaN stays NaN, values below half the smallest subnormal → ±0.
 * @param {number} x uint32 bits
 * @returns {number}
 */
function halfBits(x) {
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  let mant = x & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0)
  const e = exp - 112 // rebias 127 → 15
  if (e >= 0x1f) return sign | 0x7c00
  if (e <= 0) {
    if (e < -10) return sign
    mant |= 0x800000
    const shift = 14 - e // 14..24
    let r = mant >>> shift
    const rem = mant & ((1 << shift) - 1)
    const half = 1 << (shift - 1)
    if (rem > half || (rem === half && (r & 1))) r++
    return sign | r
  }
  let r = (e << 10) | (mant >>> 13)
  const rem = mant & 0x1fff
  if (rem > 0x1000 || (rem === 0x1000 && (r & 1))) r++ // a carry into the exponent is correct (→ next binade / Inf)
  return sign | r
}

/**
 * @param {Float32Array} a
 * @returns {Uint16Array}
 */
export function f32ToF16(a) {
  const n = a.length
  const out = new Uint16Array(n)
  const u = new Uint32Array(a.buffer, a.byteOffset, n)
  for (let i = 0; i < n; i++) out[i] = halfBits(u[i])
  return out
}

/** @type {Float32Array | null} */
let HALF_TABLE = null
function halfTable() {
  if (HALF_TABLE) return HALF_TABLE
  const t = new Float32Array(65536)
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1
    const e = (h >>> 10) & 0x1f
    const m = h & 0x3ff
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15)
  }
  return (HALF_TABLE = t)
}

/**
 * @param {Uint16Array} u
 * @returns {Float32Array}
 */
export function f16ToF32(u) {
  const t = halfTable()
  const n = u.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = t[u[i]]
  return out
}

/**
 * Parameters exactly as a client sees them after the f16 weight transfer
 * (f16ToF32(f32ToF16(params))). Audits must recompute against THIS, not the
 * float32 master copy.
 * @param {Float32Array} params
 * @returns {Float32Array}
 */
export function roundTripF16(params) {
  return f16ToF32(f32ToF16(params))
}

// ─── Gradient wire format ───────────────────────────────────────────────────
//
//   bytes [0, 4·K)        K = SEPIA.layout.length (5) float32 LE decode factors,
//                         one per tensor in layout order (powers of two)
//   bytes [4·K, 4·K+2·N)  N = SEPIA.params binary16 LE values  g[i] / factor[t]
//
// Each tensor is scaled by a power of two chosen from the exponent bits of its
// largest finite |g|, so that value lands in [2^14, 2^15): scaling is exact,
// the only rounding is the single f32 → f16 step (relative error ≤ 2^-11 for
// every element within 2^-28 of the tensor's max), the result is bit-identical
// on every engine, and non-finite inputs stay non-finite (Inf/NaN in f16) so
// the receiver's finiteness check sees them.

const K = SEPIA.layout.length
const HEADER = 4 * K
export const GRAD_BYTES = HEADER + 2 * N

/**
 * @param {Float32Array} g gradient, SEPIA.params values
 * @returns {Uint8Array} GRAD_BYTES bytes
 */
export function encodeGrad(g) {
  if (!(g instanceof Float32Array) || g.length !== N) throw new Error(`grad: want Float32Array(${N})`)
  const bytes = new Uint8Array(GRAD_BYTES)
  const dv = new DataView(bytes.buffer)
  const u = new Uint32Array(g.buffer, g.byteOffset, N)
  for (let k = 0; k < K; k++) {
    const { offset, length } = SEPIA.layout[k]
    let maxBits = 0 // |x| ordering == bit ordering for finite non-negative floats
    for (let i = offset; i < offset + length; i++) {
      const a = u[i] & 0x7fffffff
      if (a < 0x7f800000 && a > maxBits) maxBits = a
    }
    // maxabs ∈ [2^(ex−127), 2^(ex−126)) → multiply by 2^(141−ex) to land in [2^14, 2^15).
    const ex = maxBits === 0 ? 127 : Math.max(1, maxBits >>> 23)
    const shift = 141 - ex
    const mul = 2 ** shift
    dv.setFloat32(4 * k, 2 ** -shift, true)
    for (let i = offset; i < offset + length; i++) {
      f32Tmp[0] = g[i] * mul // exact: power-of-two scale inside float32 range
      dv.setUint16(HEADER + 2 * i, halfBits(u32Tmp[0]), true)
    }
  }
  return bytes
}

/**
 * @param {Uint8Array} bytes encodeGrad() output
 * @returns {Float32Array} gradient (non-finite entries preserved)
 */
export function decodeGrad(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== GRAD_BYTES) {
    throw new Error(`grad payload: want ${GRAD_BYTES} bytes, got ${bytes?.length}`)
  }
  const t = halfTable()
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(N)
  for (let k = 0; k < K; k++) {
    const { offset, length } = SEPIA.layout[k]
    const f = dv.getFloat32(4 * k, true)
    if (!Number.isFinite(f) || f <= 0) throw new Error(`grad payload: bad scale for ${SEPIA.layout[k].name}`)
    for (let i = offset; i < offset + length; i++) out[i] = t[dv.getUint16(HEADER + 2 * i, true)] * f
  }
  return out
}

// ─── Metrics ────────────────────────────────────────────────────────────────

/**
 * Cosine similarity with float64 accumulation. 0 if either vector is all
 * zeros; NaN if either contains a non-finite value (treat NaN as a failure).
 * @param {Float32Array} a @param {Float32Array} b
 * @returns {number}
 */
export function cosine(a, b) {
  if (a.length !== b.length) throw new Error(`cosine: length ${a.length} ≠ ${b.length}`)
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    ab += x * y
    aa += x * x
    bb += y * y
  }
  if (!Number.isFinite(ab + aa + bb)) return NaN
  if (aa === 0 || bb === 0) return 0
  return ab / Math.sqrt(aa * bb)
}

/**
 * Euclidean norm with float64 accumulation.
 * @param {Float32Array} a
 * @returns {number}
 */
export function l2(a) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * a[i]
  return Math.sqrt(s)
}

/**
 * ‖a − b‖ / ‖b‖ (b = reference), float64 accumulation. Infinity if b is zero
 * and a is not; NaN on non-finite input.
 * @param {Float32Array} a @param {Float32Array} b
 * @returns {number}
 */
export function relErr(a, b) {
  if (a.length !== b.length) throw new Error(`relErr: length ${a.length} ≠ ${b.length}`)
  let d = 0
  let r = 0
  for (let i = 0; i < a.length; i++) {
    const e = a[i] - b[i]
    d += e * e
    r += b[i] * b[i]
  }
  if (!Number.isFinite(d + r)) return NaN
  if (r === 0) return d === 0 ? 0 : Infinity
  return Math.sqrt(d / r)
}
