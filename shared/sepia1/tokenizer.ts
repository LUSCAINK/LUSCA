// SEPIA-1 tokenizer: byte-level BPE with the code-aware pre-tokenizer of docs/SEPIA-1.md §2.3.
// Pure TypeScript, no dependencies; one encoder for the server, the browser and the desktop CLI.
//
// It reads a Hugging Face tokenizer.json (models/sepia-1-tokenizer/tokenizer.json, trained by
// scripts/tokenizer/train.py) and reproduces `tokenizers` 0.20.3 token for token:
//
//   text ─▶ special tokens split out (leftmost, longest) ─▶ stage 1 regex (pieces)
//        ─▶ stage 2: long hex literals cut into "0x" + 4-digit groups
//        ─▶ UTF-8 bytes ─▶ GPT-2 byte-to-unicode map ─▶ BPE merges (lowest rank first, leftmost on ties)
//
// The stage 1 pattern is read from tokenizer.json, so it cannot drift from the trained file. Its
// \p{L} and \p{N} classes are replaced by the exact code-point sets Oniguruma uses in tokenizers
// 0.20.3 (unicode-classes.ts, measured by scripts/tokenizer/unicode_classes.py), so the result does
// not depend on which Unicode version the JavaScript engine knows. Stage 2 is written out here
// because its Oniguruma anchors (\A, \z, \G) have no JavaScript equivalent; the parity test
// (scripts/tokenizer/_test.ts) fails on any difference from the Python tokenizer.

import { ONIG_L, ONIG_N } from './unicode-classes.ts'

export interface TokenizerJsonLike {
  added_tokens: { id: number; content: string; special: boolean }[]
  pre_tokenizer: { type: string; pretokenizers?: { type: string; pattern?: { Regex?: string; String?: string } }[] }
  model: { type: string; vocab: Record<string, number>; merges: (string | [string, string])[] }
}

export interface Token {
  id: number
  /** The token's bytes as text (may be a partial UTF-8 sequence; then shown with U+FFFD). */
  text: string
  bytes: number
  special: boolean
}

/** Expected stage 2 pattern; a tokenizer.json with another one is refused (the code below implements this one). */
export const STAGE2_PATTERN = '\\A ?0[xX](?=[0-9a-fA-F]{9,}\\z)|\\G(?<=[0-9a-fA-FxX])[0-9a-fA-F]{1,4}'
const LONG_HEX = /^ ?0[xX][0-9a-fA-F]{9,}$/

/** GPT-2 bytes_to_unicode: printable bytes map to themselves, the rest to U+0100 onward. */
function byteMaps(): { toChar: string[]; toByte: Map<string, number> } {
  const bs: number[] = []
  for (let b = 33; b <= 126; b++) bs.push(b)
  for (let b = 161; b <= 172; b++) bs.push(b)
  for (let b = 174; b <= 255; b++) bs.push(b)
  const cs = bs.slice()
  let n = 0
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b)
      cs.push(256 + n)
      n++
    }
  }
  const toChar: string[] = new Array(256)
  const toByte = new Map<string, number>()
  bs.forEach((b, i) => {
    const c = String.fromCharCode(cs[i])
    toChar[b] = c
    toByte.set(c, b)
  })
  return { toChar, toByte }
}

/** Binary min-heap of numbers (rank · 2^36 + position). */
class NumHeap {
  private a: number[] = []
  get size(): number {
    return this.a.length
  }
  push(v: number): void {
    const a = this.a
    a.push(v)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p] <= v) break
      a[i] = a[p]
      i = p
    }
    a[i] = v
  }
  pop(): number {
    const a = this.a
    const top = a[0]
    const last = a.pop() as number
    if (a.length > 0) {
      let i = 0
      const n = a.length
      for (;;) {
        const l = 2 * i + 1
        if (l >= n) break
        const r = l + 1
        const c = r < n && a[r] < a[l] ? r : l
        if (a[c] >= last) break
        a[i] = a[c]
        i = c
      }
      a[i] = last
    }
    return top
  }
}

const POS = 2 ** 36

export class Sepia1Tokenizer {
  readonly vocabSize: number
  readonly specials: ReadonlyMap<string, number>
  private readonly vocab: Map<string, number>
  private readonly idToToken: string[]
  private readonly ranks: Map<string, number>
  private readonly stage1: RegExp
  private readonly toChar: string[]
  private readonly toByte: Map<string, number>
  private readonly specialIds: Set<number>
  private readonly specialList: string[]
  private cache = new Map<string, number[]>()
  private readonly utf8 = new TextEncoder()

  constructor(json: TokenizerJsonLike) {
    if (json.model?.type !== 'BPE') throw new Error('tokenizer.json: model is not BPE')
    const pts = json.pre_tokenizer?.pretokenizers ?? []
    const s1 = pts[0]?.pattern?.Regex
    const s2 = pts[1]?.pattern?.Regex
    if (json.pre_tokenizer?.type !== 'Sequence' || !s1 || s2 !== STAGE2_PATTERN || pts[2]?.type !== 'ByteLevel') {
      throw new Error('tokenizer.json: not the SEPIA-1 pre-tokenizer')
    }
    this.stage1 = new RegExp(pinUnicodeClasses(s1), 'gu')
    const { toChar, toByte } = byteMaps()
    this.toChar = toChar
    this.toByte = toByte
    this.vocab = new Map(Object.entries(json.model.vocab))
    const specials = new Map<string, number>()
    for (const t of json.added_tokens) {
      this.vocab.set(t.content, t.id)
      if (t.special) specials.set(t.content, t.id)
    }
    this.specials = specials
    this.specialIds = new Set(specials.values())
    this.specialList = [...specials.keys()].sort((a, b) => b.length - a.length)
    this.vocabSize = this.vocab.size
    this.idToToken = new Array(this.vocabSize)
    for (const [t, id] of this.vocab) this.idToToken[id] = t
    this.ranks = new Map()
    json.model.merges.forEach((m, i) => {
      const [a, b] = typeof m === 'string' ? splitMerge(m) : m
      this.ranks.set(a + ' ' + b, i)
    })
  }

  /** Token ids for `text`. Special-token strings in the text become their ids (as in Hugging Face `encode`) unless `allowSpecial` is false. */
  encode(text: string, opts: { allowSpecial?: boolean } = {}): number[] {
    const out: number[] = []
    this.encodeInto(text, opts.allowSpecial !== false, out, null)
    return out
  }

  /** Tokens with their text, for display. */
  tokens(text: string, opts: { allowSpecial?: boolean } = {}): Token[] {
    const ids: number[] = []
    const toks: Token[] = []
    this.encodeInto(text, opts.allowSpecial !== false, ids, toks)
    return toks
  }

  /** Number of tokens (same as encode(text).length). */
  count(text: string): number {
    return this.encode(text).length
  }

  /** The pre-tokenizer's pieces, in order (stage 1 and 2; special tokens are not split out here). */
  preTokenize(text: string): string[] {
    const out: string[] = []
    const re = this.stage1
    re.lastIndex = 0
    let last = 0
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m.index > last) pushStage2(out, text.slice(last, m.index))
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      pushStage2(out, m[0])
      last = m.index + m[0].length
    }
    if (last < text.length) pushStage2(out, text.slice(last))
    return out
  }

  /** Bytes of the given ids, concatenated (special tokens included as their text). */
  decodeBytes(ids: readonly number[]): Uint8Array {
    const parts: number[] = []
    for (const id of ids) {
      const t = this.idToToken[id]
      if (t === undefined) throw new Error(`unknown token id ${id}`)
      if (this.specialIds.has(id)) {
        for (const b of this.utf8.encode(t)) parts.push(b)
        continue
      }
      for (const ch of t) {
        const b = this.toByte.get(ch)
        if (b === undefined) throw new Error(`token ${id} is not byte-level`)
        parts.push(b)
      }
    }
    return Uint8Array.from(parts)
  }

  /** Text of the given ids. Invalid UTF-8 (only possible for a cut sequence) becomes U+FFFD; a leading BOM is kept. */
  decode(ids: readonly number[]): string {
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(this.decodeBytes(ids))
  }

  idToString(id: number): string | undefined {
    return this.idToToken[id]
  }

  private encodeInto(text: string, allowSpecial: boolean, out: number[], toks: Token[] | null): void {
    if (!allowSpecial || this.specialList.length === 0) {
      this.encodeOrdinary(text, out, toks)
      return
    }
    // Special tokens are split out first, leftmost then longest (Hugging Face added-token matching).
    let segStart = 0
    let pos = 0
    for (;;) {
      const at = text.indexOf('<|', pos)
      if (at < 0) break
      const hit = this.specialList.find((s) => text.startsWith(s, at))
      if (!hit) {
        pos = at + 1
        continue
      }
      this.encodeOrdinary(text.slice(segStart, at), out, toks)
      const id = this.specials.get(hit) as number
      out.push(id)
      toks?.push({ id, text: hit, bytes: this.utf8.encode(hit).length, special: true })
      pos = segStart = at + hit.length
    }
    this.encodeOrdinary(text.slice(segStart), out, toks)
  }

  private encodeOrdinary(text: string, out: number[], toks: Token[] | null): void {
    if (text.length === 0) return
    const dec = toks ? new TextDecoder('utf-8', { ignoreBOM: true }) : null
    for (const piece of this.preTokenize(text)) {
      for (const id of this.bpe(piece)) {
        out.push(id)
        if (toks && dec) {
          const t = this.idToToken[id]
          toks.push({ id, text: dec.decode(this.decodeBytes([id])), bytes: t.length, special: false })
        }
      }
    }
  }

  private bpe(piece: string): number[] {
    const hit = this.cache.get(piece)
    if (hit) return hit
    const bytes = this.utf8.encode(piece)
    const n = bytes.length
    const sym: string[] = new Array(n)
    for (let i = 0; i < n; i++) sym[i] = this.toChar[bytes[i]]
    let ids: number[]
    if (n === 1) {
      ids = [this.vocab.get(sym[0]) as number]
    } else {
      const next = new Int32Array(n)
      const prev = new Int32Array(n)
      const alive = new Uint8Array(n).fill(1)
      for (let i = 0; i < n; i++) {
        next[i] = i + 1 < n ? i + 1 : -1
        prev[i] = i - 1
      }
      const heap = new NumHeap()
      for (let i = 0; i + 1 < n; i++) {
        const r = this.ranks.get(sym[i] + ' ' + sym[i + 1])
        if (r !== undefined) heap.push(r * POS + i)
      }
      while (heap.size > 0) {
        const v = heap.pop()
        const r = Math.floor(v / POS)
        const i = v - r * POS
        if (!alive[i]) continue
        const j = next[i]
        if (j < 0) continue
        if (this.ranks.get(sym[i] + ' ' + sym[j]) !== r) continue // stale
        sym[i] = sym[i] + sym[j]
        alive[j] = 0
        const k = next[j]
        next[i] = k
        if (k >= 0) prev[k] = i
        const p = prev[i]
        if (p >= 0) {
          const rp = this.ranks.get(sym[p] + ' ' + sym[i])
          if (rp !== undefined) heap.push(rp * POS + p)
        }
        if (k >= 0) {
          const rk = this.ranks.get(sym[i] + ' ' + sym[k])
          if (rk !== undefined) heap.push(rk * POS + i)
        }
      }
      ids = []
      for (let i = 0; i >= 0; i = next[i]) {
        const id = this.vocab.get(sym[i])
        if (id === undefined) throw new Error('BPE produced a symbol outside the vocabulary')
        ids.push(id)
      }
    }
    if (this.cache.size > 50_000) this.cache.clear()
    this.cache.set(piece, ids)
    return ids
  }
}

/**
 * Replaces \p{L} and \p{N} in a regex source with explicit code-point ranges (inside a character
 * class: the ranges; outside: a class of them). Any other \p / \P property is refused.
 */
export function pinUnicodeClasses(src: string): string {
  const sets: Record<string, string> = { L: ONIG_L, N: ONIG_N }
  let out = ''
  let inClass = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      const n = src[i + 1]
      if (n === 'p' || n === 'P') {
        const m = /^\{(\w+)\}/.exec(src.slice(i + 2))
        const set = m && n === 'p' ? sets[m[1]] : undefined
        if (!m || set === undefined) throw new Error(`tokenizer.json: unsupported Unicode property at ${i}`)
        out += inClass ? set : `[${set}]`
        i += 1 + m[0].length
        continue
      }
      out += c + (n ?? '')
      i++
      continue
    }
    if (c === '[' && !inClass) inClass = true
    else if (c === ']' && inClass) inClass = false
    out += c
  }
  return out
}

function splitMerge(m: string): [string, string] {
  const i = m.indexOf(' ', 1)
  return [m.slice(0, i), m.slice(i + 1)]
}

function pushStage2(out: string[], piece: string): void {
  if (!LONG_HEX.test(piece)) {
    out.push(piece)
    return
  }
  const x = piece.indexOf('x') >= 0 ? piece.indexOf('x') : piece.indexOf('X')
  out.push(piece.slice(0, x + 1))
  for (let i = x + 1; i < piece.length; i += 4) out.push(piece.slice(i, i + 4))
}
