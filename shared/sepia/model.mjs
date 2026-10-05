// @ts-check
/**
 * SEPIA-0 core — vocabulary, a character-level MLP language model with a
 * hand-written backward pass, the Adam optimizer, the LR schedule and sampling.
 *
 * Plain, dependency-free JavaScript (ESM) on purpose: the SAME file runs in the
 * server's training worker thread (server/trainer/worker.mjs — tsx does not
 * reliably transpile .ts workers), the server main thread (audits, sampling),
 * browsers and Web Workers (contributed gradients) and the desktop CLI. It uses
 * no Node or DOM APIs. Types for TypeScript callers live in model.d.mts; the
 * distributed-training API (lossAndGrad, codecs, FLOP count) is in index.mjs.
 *
 * Architecture (Bengio et al. 2003 / Karpathy's "makemore" MLP):
 *
 *   ids[T] ──emb(V×E)──▶ x[T·E] ──W1(T·E×H)+b1──▶ tanh ──▶ h[H] ──W2(H×V)+b2──▶ logits[V]
 *   loss = mean over the batch of  −log softmax(logits)[target]
 *
 * All parameters live in ONE flat typed array (`params`) with fixed offsets, so
 * the optimizer, gradient clipping and checkpointing are single loops/copies.
 * Weight matrices are stored row-major as [in][out] so every hot inner loop
 * walks memory contiguously.
 */

export const CTX = 16
export const EMB = 24
export const HIDDEN = 384
export const VOCAB_SIZE = 96

/** id 0 = '\n', ids 1..95 = printable ASCII 32..126 (' ' .. '~'). */
export const VOCAB = '\n' + Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')
export const NL = 0
export const SP = 1

// ─── Vocabulary mapping ─────────────────────────────────────────────────────
// Lookup over the whole BMP: value ≥ 0 is a vocab id, −1 means "drop the code
// unit". Text is NFKD-normalized first, which already folds accents (é → e +
// combining mark, dropped below), ligatures, full-width forms, NBSP, '…' → '...'.
const DROP = -1
const MAP = new Int8Array(65536).fill(SP) // default: unknown symbol → space
for (let c = 32; c <= 126; c++) MAP[c] = c - 31
for (let c = 0; c < 32; c++) MAP[c] = DROP // C0 controls
MAP[10] = NL
MAP[9] = SP
MAP[11] = NL
MAP[12] = NL
for (let c = 127; c <= 159; c++) MAP[c] = DROP // DEL + C1 controls
MAP[0x85] = NL
MAP[0x2028] = NL
MAP[0x2029] = NL
/** @param {string} chars @param {number} id */
const setAll = (chars, id) => {
  for (let i = 0; i < chars.length; i++) MAP[chars.charCodeAt(i)] = id
}
/** @param {number} a @param {number} b @param {number} id */
const setRange = (a, b, id) => {
  for (let c = a; c <= b; c++) MAP[c] = id
}
setAll('‘’‚‛′‵ʼʹ´＇', "'".charCodeAt(0) - 31)
setAll('“”„‟″‶«»ʺ＂', '"'.charCodeAt(0) - 31)
setAll('‐‑‒–—―−⁃﹘﹣－⸺⸻', '-'.charCodeAt(0) - 31)
setAll('•‣●▪∙·', '*'.charCodeAt(0) - 31)
setAll('×', 'x'.charCodeAt(0) - 31)
setAll('­﻿', DROP) // soft hyphen, BOM
setRange(0x200b, 0x200f, DROP) // zero-width chars, LRM/RLM
setRange(0x2060, 0x2064, DROP)
setRange(0x0300, 0x036f, DROP) // combining diacritics (after NFKD)
setRange(0x1ab0, 0x1aff, DROP)
setRange(0x1dc0, 0x1dff, DROP)
setRange(0x20d0, 0x20ff, DROP)
setRange(0xfe00, 0xfe0f, DROP) // variation selectors
setRange(0xfe20, 0xfe2f, DROP)
setRange(0xdc00, 0xdfff, DROP) // low surrogates: an astral char (emoji…) becomes ONE space via its high surrogate

/**
 * Map text onto the 96-symbol vocabulary. Whitespace is tidied: runs of spaces
 * collapse to one, spaces are trimmed around newlines, at most one blank line
 * is kept, and leading whitespace is dropped.
 * @param {string} text
 * @param {boolean} [keepTrailing] keep trailing spaces/newlines (prompts: "The validator ")
 * @returns {Uint8Array}
 */
export function encode(text, keepTrailing = false) {
  let s = typeof text === 'string' ? text : String(text ?? '')
  try {
    s = s.normalize('NFKD')
  } catch {
    /* lone surrogates etc. — fall back to the raw string */
  }
  const out = new Uint8Array(s.length) // every code unit yields ≤ 1 id
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const id = MAP[s.charCodeAt(i)]
    if (id === DROP) continue
    if (id === SP) {
      if (n === 0 || out[n - 1] === SP || out[n - 1] === NL) continue
    } else if (id === NL) {
      if (n > 0 && out[n - 1] === SP) n--
      if (n === 0) continue
      if (n >= 2 && out[n - 1] === NL && out[n - 2] === NL) continue
    }
    out[n++] = id
  }
  if (!keepTrailing) while (n > 0 && (out[n - 1] === SP || out[n - 1] === NL)) n--
  return out.slice(0, n) // exact-size copy so the oversized scratch can be freed
}

/** @param {ArrayLike<number>} ids @returns {string} */
export function decode(ids) {
  let s = ''
  for (let i = 0; i < ids.length; i++) s += VOCAB[ids[i]] ?? ' '
  return s
}

// ─── Randomness ─────────────────────────────────────────────────────────────

/**
 * Small, fast, seedable PRNG (mulberry32). Returns floats in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Standard normal via Box–Muller. @param {() => number} rand */
function gauss(rand) {
  let u = 0
  while (u <= 1e-12) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

// ─── Model ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Float32ArrayConstructor | Float64ArrayConstructor} ArrCtor
 * @typedef {Float32Array | Float64Array} FArr
 * @typedef {{ T?: number, E?: number, H?: number, V?: number, Arr?: ArrCtor }} ModelConfig
 * @typedef {{ emb: number, W1: number, b1: number, W2: number, b2: number, total: number }} Layout
 */

/** @param {ModelConfig} [cfg] @returns {Layout} */
export function paramLayout(cfg = {}) {
  const T = cfg.T ?? CTX
  const E = cfg.E ?? EMB
  const H = cfg.H ?? HIDDEN
  const V = cfg.V ?? VOCAB_SIZE
  const emb = 0
  const W1 = emb + V * E
  const b1 = W1 + T * E * H
  const W2 = b1 + H
  const b2 = W2 + H * V
  return { emb, W1, b1, W2, b2, total: b2 + V }
}

/** Exact trainable parameter count. @param {ModelConfig} [cfg] */
export function paramCount(cfg = {}) {
  return paramLayout(cfg).total
}

export class SepiaModel {
  /** @param {ModelConfig} [cfg] */
  constructor(cfg = {}) {
    this.T = cfg.T ?? CTX
    this.E = cfg.E ?? EMB
    this.H = cfg.H ?? HIDDEN
    this.V = cfg.V ?? VOCAB_SIZE
    /** @type {ArrCtor} */
    this.Arr = cfg.Arr ?? Float32Array
    this.layout = paramLayout(this)
    this.size = this.layout.total
    /** @type {FArr} */
    this.params = new this.Arr(this.size)
    /** @type {FArr} */
    this.grads = new this.Arr(this.size)
    /** @type {Map<number, Buffers>} */
    this._bufs = new Map()
  }

  /**
   * Fresh initialisation. Embeddings ~ N(0,1); W1 ~ N(0, 1/fan_in) so tanh
   * pre-activations start at unit scale (Kaiming/LeCun for tanh without
   * normalisation layers); W2 is tiny so the initial softmax is ≈ uniform and
   * the loss starts at ≈ ln(96) = 4.564 instead of a confidently-wrong spike.
   * @param {() => number} rand
   */
  init(rand) {
    const { params: P, layout: L, T, E, H, V } = this
    P.fill(0)
    for (let i = 0; i < V * E; i++) P[L.emb + i] = gauss(rand)
    const s1 = 1 / Math.sqrt(T * E)
    for (let i = 0; i < T * E * H; i++) P[L.W1 + i] = gauss(rand) * s1
    const s2 = 0.1 / Math.sqrt(H)
    for (let i = 0; i < H * V; i++) P[L.W2 + i] = gauss(rand) * s2
  }

  /** Copy weights in (length must match). @param {ArrayLike<number>} src */
  load(src) {
    if (!src || src.length !== this.size) throw new Error(`param size mismatch: got ${src?.length}, want ${this.size}`)
    this.params.set(src)
  }

  /**
   * Per-batch-size scratch buffers (allocated once, reused every step).
   * @param {number} B
   * @returns {Buffers}
   */
  _buf(B) {
    let b = this._bufs.get(B)
    if (!b) {
      b = makeBuffers(this.Arr, B, this.T, this.E, this.H, this.V)
      this._bufs.set(B, b)
    }
    return b
  }

  /**
   * Forward pass, and if `backward` the full backward pass, on a batch.
   * When backward is true, `this.grads` is OVERWRITTEN with dLoss/dParams of
   * the mean loss over the batch.
   * @param {Uint8Array} X contexts, B×T ids row-major
   * @param {Uint8Array} Y targets, B ids
   * @param {number} B batch size
   * @param {boolean} backward
   * @returns {number} mean cross-entropy (nats per char)
   */
  forward(X, Y, B, backward) {
    return batchPass(this, this.params, backward ? this.grads : null, X, Y, B, this._buf(B))
  }

  /**
   * Logits for a single context (B = 1 forward pass, no gradient).
   * @param {Uint8Array} ctx T ids
   * @returns {FArr} a view of length V (overwritten by the next call)
   */
  logits(ctx) {
    const { T, E, H, V, layout: L, params: P } = this
    const { xe, h, lg } = this._buf(1)
    for (let t = 0; t < T; t++) xe.set(P.subarray(L.emb + ctx[t] * E, L.emb + ctx[t] * E + E), t * E)
    h.set(P.subarray(L.b1, L.W2))
    matmulAcc(xe, T * E, P.subarray(L.W1, L.b1), h, H, 1, T * E, H)
    for (let j = 0; j < H; j++) h[j] = Math.tanh(h[j])
    lg.set(P.subarray(L.b2, L.total))
    matmulAcc(h, H, P.subarray(L.W2, L.b2), lg, V, 1, H, V)
    return lg.subarray(0, V)
  }
}

/** @typedef {{ xe: FArr, h: FArr, dh: FArr, lg: FArr, dxe: FArr }} Buffers */
/** @typedef {{ T: number, E: number, H: number, V: number, layout: Layout }} Dims */

/**
 * Scratch buffers for a batch of (up to) B rows. A set allocated for a larger
 * B serves any smaller batch: the passes only touch the first B rows.
 * @param {ArrCtor} Arr @param {number} B
 * @param {number} T @param {number} E @param {number} H @param {number} V
 * @returns {Buffers}
 */
export function makeBuffers(Arr, B, T, E, H, V) {
  return {
    xe: new Arr(B * T * E), // concatenated embeddings
    h: new Arr(B * H), // tanh activations
    dh: new Arr(B * H), // grad wrt hidden PRE-activation
    lg: new Arr(B * V), // logits → (backward) dlogits
    dxe: new Arr(B * T * E), // dL/d(concatenated embeddings)
  }
}

/**
 * THE forward (+ optional backward) pass — the single implementation used by
 * SepiaModel.forward, lossAndGrad/lossOnly (index.mjs), server audits and
 * contributed CPU gradients.
 * @param {Dims} dims
 * @param {FArr} P params (dims.layout.total)
 * @param {FArr | null} G gradient output (OVERWRITTEN) or null for loss only
 * @param {Uint8Array} X contexts, B×T ids row-major
 * @param {Uint8Array} Y targets, B ids
 * @param {number} B batch size
 * @param {Buffers} bufs scratch for ≥ B rows
 * @returns {number} mean cross-entropy (nats per char)
 */
export function batchPass(dims, P, G, X, Y, B, bufs) {
  const { T, E, H, V, layout: L } = dims
  const backward = G !== null
  const TE = T * E
  const { xe, h, dh, lg, dxe } = bufs
  const emb = P.subarray(L.emb, L.W1)
  const W1 = P.subarray(L.W1, L.b1)
  const b1 = P.subarray(L.b1, L.W2)
  const W2 = P.subarray(L.W2, L.b2)
  const b2 = P.subarray(L.b2, L.total)

  // 1. embedding lookup: xe[b] = concat_t emb[X[b,t]]
  for (let b = 0; b < B; b++) {
    for (let t = 0; t < T; t++) {
      const c = X[b * T + t]
      xe.set(emb.subarray(c * E, c * E + E), b * TE + t * E)
    }
  }

  // 2. hidden: h = tanh(xe · W1 + b1)
  for (let b = 0; b < B; b++) h.set(b1, b * H)
  matmulAcc(xe, TE, W1, h, H, B, TE, H)
  for (let i = 0; i < B * H; i++) h[i] = Math.tanh(h[i])

  // 3. logits = h · W2 + b2, then softmax cross-entropy. In backward mode lg
  //    is overwritten in place with dlogits = (softmax − onehot) / B.
  for (let b = 0; b < B; b++) lg.set(b2, b * V)
  matmulAcc(h, H, W2, lg, V, B, H, V)
  let loss = 0
  const invB = 1 / B
  for (let b = 0; b < B; b++) {
    const lo = b * V
    let max = -Infinity
    for (let k = 0; k < V; k++) if (lg[lo + k] > max) max = lg[lo + k]
    let sum = 0
    for (let k = 0; k < V; k++) sum += Math.exp(lg[lo + k] - max)
    const y = Y[b]
    loss += Math.log(sum) + max - lg[lo + y]
    if (backward) {
      const inv = invB / sum
      for (let k = 0; k < V; k++) lg[lo + k] = Math.exp(lg[lo + k] - max) * inv
      lg[lo + y] -= invB
    }
  }
  loss *= invB
  if (G === null) return loss

  G.fill(0)
  const gEmb = G.subarray(L.emb, L.W1)
  const gW1 = G.subarray(L.W1, L.b1)
  const gb1 = G.subarray(L.b1, L.W2)
  const gW2 = G.subarray(L.W2, L.b2)
  const gb2 = G.subarray(L.b2, L.total)

  // 4. output layer: db2 = Σ dlog; dW2 = hᵀ·dlog; dh = dlog·W2ᵀ;
  //    then through tanh: dpre = dh ⊙ (1 − h²)   (stored in dh)
  for (let b = 0; b < B; b++) {
    const lo = b * V
    for (let k = 0; k < V; k++) gb2[k] += lg[lo + k]
  }
  matmulBack(h, H, lg, V, W2, gW2, dh, B, H, V)
  for (let i = 0; i < B * H; i++) dh[i] *= 1 - h[i] * h[i]

  // 5. hidden layer: db1 = Σ dpre; dW1 = xeᵀ·dpre; dxe = dpre·W1ᵀ;
  //    then scatter-add dxe into the embedding rows that were looked up.
  for (let b = 0; b < B; b++) {
    const ho = b * H
    for (let j = 0; j < H; j++) gb1[j] += dh[ho + j]
  }
  matmulBack(xe, TE, dh, H, W1, gW1, dxe, B, TE, H)
  for (let b = 0; b < B; b++) {
    for (let t = 0; t < T; t++) {
      const eo = X[b * T + t] * E
      const so = b * TE + t * E
      for (let e = 0; e < E; e++) gEmb[eo + e] += dxe[so + e]
    }
  }
  return loss
}

// ─── Dense kernels ──────────────────────────────────────────────────────────
// Register-blocked over 4 batch rows: each weight row is loaded once per 4
// examples instead of once per example, which roughly halves the time of the
// memory-bound W1 passes in V8 (measured 1.7–1.8×).

/**
 * out[b][j] += Σ_i x[b][i] · W[i][j]      (W is [I][J] row-major)
 * @param {FArr} x B×xs  @param {number} xs row stride of x
 * @param {FArr} W I×J
 * @param {FArr} out B×os  @param {number} os row stride of out
 * @param {number} B @param {number} I @param {number} J
 */
function matmulAcc(x, xs, W, out, os, B, I, J) {
  let b = 0
  for (; b + 4 <= B; b += 4) {
    const x0 = b * xs, x1 = x0 + xs, x2 = x1 + xs, x3 = x2 + xs
    const o0 = b * os, o1 = o0 + os, o2 = o1 + os, o3 = o2 + os
    for (let i = 0; i < I; i++) {
      const a0 = x[x0 + i], a1 = x[x1 + i], a2 = x[x2 + i], a3 = x[x3 + i]
      const wo = i * J
      for (let j = 0; j < J; j++) {
        const w = W[wo + j]
        out[o0 + j] += a0 * w
        out[o1 + j] += a1 * w
        out[o2 + j] += a2 * w
        out[o3 + j] += a3 * w
      }
    }
  }
  for (; b < B; b++) {
    const x0 = b * xs, o0 = b * os
    for (let i = 0; i < I; i++) {
      const a0 = x[x0 + i]
      const wo = i * J
      for (let j = 0; j < J; j++) out[o0 + j] += a0 * W[wo + j]
    }
  }
}

/**
 * Backward of out = x·W given g = dL/dout:
 *   gW[i][j] += Σ_b x[b][i] · g[b][j]        (accumulates)
 *   dx[b][i]  = Σ_j W[i][j] · g[b][j]        (overwrites)
 * @param {FArr} x B×xs  @param {number} xs
 * @param {FArr} g B×gs  @param {number} gs
 * @param {FArr} W I×J   @param {FArr} gW I×J
 * @param {FArr} dx B×xs
 * @param {number} B @param {number} I @param {number} J
 */
function matmulBack(x, xs, g, gs, W, gW, dx, B, I, J) {
  let b = 0
  for (; b + 4 <= B; b += 4) {
    const x0 = b * xs, x1 = x0 + xs, x2 = x1 + xs, x3 = x2 + xs
    const g0 = b * gs, g1 = g0 + gs, g2 = g1 + gs, g3 = g2 + gs
    for (let i = 0; i < I; i++) {
      const a0 = x[x0 + i], a1 = x[x1 + i], a2 = x[x2 + i], a3 = x[x3 + i]
      const wo = i * J
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0
      for (let j = 0; j < J; j++) {
        const q0 = g[g0 + j], q1 = g[g1 + j], q2 = g[g2 + j], q3 = g[g3 + j]
        const w = W[wo + j]
        gW[wo + j] += a0 * q0 + a1 * q1 + a2 * q2 + a3 * q3
        s0 += w * q0
        s1 += w * q1
        s2 += w * q2
        s3 += w * q3
      }
      dx[x0 + i] = s0
      dx[x1 + i] = s1
      dx[x2 + i] = s2
      dx[x3 + i] = s3
    }
  }
  for (; b < B; b++) {
    const x0 = b * xs, g0 = b * gs
    for (let i = 0; i < I; i++) {
      const a0 = x[x0 + i]
      const wo = i * J
      let s0 = 0
      for (let j = 0; j < J; j++) {
        const q0 = g[g0 + j]
        gW[wo + j] += a0 * q0
        s0 += W[wo + j] * q0
      }
      dx[x0 + i] = s0
    }
  }
}

// ─── Optimizer & schedule ───────────────────────────────────────────────────

export class Adam {
  /**
   * @param {number} n parameter count
   * @param {ArrCtor} [Arr]
   * @param {{ beta1?: number, beta2?: number, eps?: number }} [o]
   */
  constructor(n, Arr = Float32Array, o = {}) {
    this.beta1 = o.beta1 ?? 0.9
    this.beta2 = o.beta2 ?? 0.99
    this.eps = o.eps ?? 1e-8
    /** @type {FArr} */
    this.m = new Arr(n)
    /** @type {FArr} */
    this.v = new Arr(n)
    /** number of updates applied (bias-correction counter) */
    this.t = 0
  }

  /**
   * One Adam update with global grad-norm clipping. If the gradient norm is
   * not finite the update is skipped entirely (weights and moments untouched).
   * @param {FArr} P params
   * @param {FArr} G grads
   * @param {number} lr
   * @param {number} clip max global L2 norm
   * @returns {number} the pre-clip gradient norm (NaN/Infinity → update skipped)
   */
  step(P, G, lr, clip) {
    let ss = 0
    for (let i = 0; i < G.length; i++) ss += G[i] * G[i]
    const norm = Math.sqrt(ss)
    if (!Number.isFinite(norm)) return norm
    const scale = norm > clip ? clip / norm : 1
    this.t++
    const { beta1: b1, beta2: b2, eps, m, v } = this
    const c1 = 1 / (1 - Math.pow(b1, this.t))
    const c2 = 1 / (1 - Math.pow(b2, this.t))
    const ob1 = 1 - b1
    const ob2 = 1 - b2
    for (let i = 0; i < P.length; i++) {
      const g = G[i] * scale
      const mi = (m[i] = b1 * m[i] + ob1 * g)
      const vi = (v[i] = b2 * v[i] + ob2 * g * g)
      P[i] -= (lr * mi * c1) / (Math.sqrt(vi * c2) + eps)
    }
    return norm
  }
}

export const LR_MAX = 3e-3
export const LR_MIN = 3e-4
export const WARMUP_STEPS = 200
export const DECAY_STEPS = 30_000

/**
 * Linear warmup to LR_MAX over WARMUP_STEPS, cosine decay to LR_MIN over the
 * next DECAY_STEPS, then hold at LR_MIN.
 * @param {number} step 0-based index of the update about to be applied
 */
export function lrAt(step) {
  if (step < WARMUP_STEPS) return (LR_MAX * (step + 1)) / WARMUP_STEPS
  const p = (step - WARMUP_STEPS) / DECAY_STEPS
  if (p >= 1) return LR_MIN
  return LR_MIN + 0.5 * (LR_MAX - LR_MIN) * (1 + Math.cos(Math.PI * p))
}

// ─── Sampling ───────────────────────────────────────────────────────────────

/**
 * Autoregressively sample `n` characters after `prompt`.
 * @param {SepiaModel} model
 * @param {string} prompt
 * @param {number} n
 * @param {number} temperature > 0
 * @param {() => number} rand
 * @returns {string} prompt + continuation
 */
export function generateText(model, prompt, n, temperature, rand) {
  const { T, V } = model
  const p = encode(prompt, true)
  const ctx = new Uint8Array(T).fill(NL)
  const k = Math.min(T, p.length)
  ctx.set(p.subarray(p.length - k), T - k)
  const out = new Uint8Array(Math.max(0, n | 0))
  const temp = Math.max(1e-3, temperature)
  const probs = new Float64Array(V)
  for (let i = 0; i < out.length; i++) {
    const lg = model.logits(ctx)
    let max = -Infinity
    for (let c = 0; c < V; c++) if (lg[c] > max) max = lg[c]
    let sum = 0
    for (let c = 0; c < V; c++) sum += probs[c] = Math.exp((lg[c] - max) / temp)
    let r = rand() * sum
    let id = V - 1
    for (let c = 0; c < V; c++) {
      r -= probs[c]
      if (r <= 0) {
        id = c
        break
      }
    }
    out[i] = id
    ctx.copyWithin(0, 1)
    ctx[T - 1] = id
  }
  return prompt + decode(out)
}
