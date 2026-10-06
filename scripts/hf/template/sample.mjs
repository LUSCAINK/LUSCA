#!/usr/bin/env node
// SEPIA-0 inference in Node.js, no dependencies.
//
//   node sample.mjs "The validator" --n 240 --temperature 0.8 --seed 7
//
// Same arithmetic and sampling as the LUSCA server (shared/sepia/model.mjs and
// POST /api/generate): float32 weights and activations, prompt CRLF/CR → LF and
// cut to 200 characters, n clamped to 1..600 (default 240), temperature clamped
// to 0.05..2 (default 0.8), the last 16 prompt symbols (left-padded with
// newline) as context. With --seed the generator is mulberry32, so
// `python inference.py` prints the same text for the same seed; without it,
// Math.random is used, as on the server.
//
// Also usable as a module:
//   import { loadSepia, generate, logits, mulberry32 } from './sample.mjs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** id 0 = '\n', ids 1..95 = printable ASCII 32..126 (' ' .. '~'). */
export const VOCAB = '\n' + Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')
export const NL = 0
export const SP = 1

// ─── weights ────────────────────────────────────────────────────────────────

/**
 * Minimal safetensors reader (F32 tensors).
 * @param {string | URL} file
 * @returns {{ tensors: Record<string, { shape: number[], data: Float32Array }>, metadata: Record<string, string> }}
 */
export function readSafetensors(file) {
  const buf = readFileSync(file)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const n = Number(dv.getBigUint64(0, true))
  const header = JSON.parse(buf.toString('utf8', 8, 8 + n))
  const metadata = header.__metadata__ ?? {}
  delete header.__metadata__
  /** @type {Record<string, { shape: number[], data: Float32Array }>} */
  const tensors = {}
  for (const [name, info] of Object.entries(header)) {
    if (info.dtype !== 'F32') throw new Error(`${name}: dtype ${info.dtype} is not supported`)
    const [begin, end] = info.data_offsets
    const data = new Float32Array((end - begin) / 4)
    for (let i = 0; i < data.length; i++) data[i] = dv.getFloat32(8 + n + begin + i * 4, true)
    tensors[name] = { shape: info.shape, data }
  }
  return { tensors, metadata }
}

/**
 * logits = tanh(concat_t emb[ids_t] @ W1 + b1) @ W2 + b2   (matrices are [in, out])
 * @param {string | URL} [file] defaults to model.safetensors next to this script
 */
export function loadSepia(file = new URL('./model.safetensors', import.meta.url)) {
  const { tensors: t, metadata } = readSafetensors(file)
  const [V, E] = t.emb.shape
  const H = t.W1.shape[1]
  const T = t.W1.shape[0] / E
  return {
    T, E, H, V, metadata,
    emb: t.emb.data, W1: t.W1.data, b1: t.b1.data, W2: t.W2.data, b2: t.b2.data,
    xe: new Float32Array(T * E), h: new Float32Array(H), lg: new Float32Array(V),
  }
}

/**
 * Logits for one context of T ids (oldest first). Returns a view overwritten by the next call.
 * @param {ReturnType<typeof loadSepia>} m
 * @param {ArrayLike<number>} ctx
 */
export function logits(m, ctx) {
  const { T, E, H, V, emb, W1, b1, W2, b2, xe, h, lg } = m
  for (let t = 0; t < T; t++) xe.set(emb.subarray(ctx[t] * E, ctx[t] * E + E), t * E)
  h.set(b1)
  for (let i = 0; i < T * E; i++) {
    const a = xe[i]
    const wo = i * H
    for (let j = 0; j < H; j++) h[j] += a * W1[wo + j]
  }
  for (let j = 0; j < H; j++) h[j] = Math.tanh(h[j])
  lg.set(b2)
  for (let i = 0; i < H; i++) {
    const a = h[i]
    const wo = i * V
    for (let j = 0; j < V; j++) lg[j] += a * W2[wo + j]
  }
  return lg
}

// ─── vocabulary (same mapping as shared/sepia/model.mjs encode) ─────────────

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
setRange(0xdc00, 0xdfff, DROP) // low surrogates: a character beyond the BMP becomes ONE space

/**
 * Text → vocabulary ids (NFKD, symbol folding, whitespace tidying as in the LUSCA corpus).
 * @param {string} text
 * @param {boolean} [keepTrailing] keep trailing spaces/newlines (prompts)
 * @returns {Uint8Array}
 */
export function encode(text, keepTrailing = false) {
  let s = typeof text === 'string' ? text : String(text ?? '')
  try {
    s = s.normalize('NFKD')
  } catch {
    /* lone surrogates etc. — fall back to the raw string */
  }
  const out = new Uint8Array(s.length)
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
  return out.slice(0, n)
}

/** @param {ArrayLike<number>} ids */
export function decode(ids) {
  let s = ''
  for (let i = 0; i < ids.length; i++) s += VOCAB[ids[i]] ?? ' '
  return s
}

// ─── sampling ───────────────────────────────────────────────────────────────

/** Seedable PRNG (mulberry32), floats in [0, 1). @param {number} seed */
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

/**
 * Prompt + n sampled characters, with /api/generate's input handling.
 * @param {ReturnType<typeof loadSepia>} m
 * @param {string} prompt
 * @param {{ n?: number, temperature?: number, rand?: () => number }} [o]
 */
export function generate(m, prompt = '', o = {}) {
  const p0 = String(prompt ?? '').replace(/\r\n?/g, '\n').slice(0, 200)
  const n = Math.min(600, Math.max(1, Math.round(Number(o.n ?? 240))))
  const temperature = Math.min(2, Math.max(0.05, Number(o.temperature ?? 0.8)))
  const rand = o.rand ?? Math.random
  const { T, V } = m
  const p = encode(p0, true)
  const ctx = new Uint8Array(T).fill(NL)
  const k = Math.min(T, p.length)
  ctx.set(p.subarray(p.length - k), T - k)
  const out = new Uint8Array(n)
  const temp = Math.max(1e-3, temperature)
  const probs = new Float64Array(V)
  for (let i = 0; i < n; i++) {
    const lg = logits(m, ctx)
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
  return p0 + decode(out)
}

function main() {
  const args = process.argv.slice(2)
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`)
    if (i < 0) return def
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: node sample.mjs [prompt] [--n 240] [--temperature 0.8] [--seed S] [--weights model.safetensors]')
    return
  }
  const n = Number(opt('n', 240))
  const temperature = Number(opt('temperature', 0.8))
  const seed = opt('seed', null)
  const weights = opt('weights', null)
  const m = loadSepia(weights ? resolve(weights) : undefined)
  const rand = seed !== null ? mulberry32(Number(seed)) : Math.random
  process.stdout.write(generate(m, args[0] ?? '', { n, temperature, rand }) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
