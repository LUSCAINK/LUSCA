// 64-bit SimHash over word 3-shingles, with a 4×16-bit band LSH index.
//
// 64-bit values are carried as two unsigned 32-bit lanes (hi, lo) — no BigInt in
// the hot path. Hash = true 64-bit FNV-1a (prime 2^40 + 0x1b3, computed with
// 32-bit limb arithmetic) followed by a murmur-style finalizer so every output
// bit is well mixed (SimHash quality depends on independent, unbiased bits).

export interface Sim64 {
  hi: number
  lo: number
}

const TWO32 = 4294967296

/** FNV-1a 64 of a string's UTF-16 code units, finalized. */
export function fnv1a64(s: string): Sim64 {
  // offset basis 0xcbf29ce484222325
  let hi = 0xcbf29ce4
  let lo = 0x84222325
  for (let i = 0; i < s.length; i++) {
    lo = (lo ^ s.charCodeAt(i)) >>> 0
    // (hi:lo) * (2^40 + 435) mod 2^64
    const lo435 = lo * 435 // < 2^41, exact in a double
    const carry = Math.floor(lo435 / TWO32)
    const newLo = lo435 >>> 0
    const newHi = (Math.imul(hi, 435) + carry + (lo << 8)) >>> 0
    hi = newHi
    lo = newLo
  }
  // finalizer (fmix32 on each lane, cross-mixed)
  hi ^= lo >>> 16
  hi = Math.imul(hi, 0x85ebca6b) >>> 0
  lo ^= hi >>> 13
  lo = Math.imul(lo, 0xc2b2ae35) >>> 0
  hi ^= lo >>> 16
  hi = Math.imul(hi, 0x27d4eb2f) >>> 0
  lo ^= hi >>> 15
  return { hi: hi >>> 0, lo: lo >>> 0 }
}

const WORD_RE = /[a-z0-9]+/g

/** SimHash of the text's word 3-shingles (falls back to unigrams for very short texts). */
export function simhash64(text: string, maxWords = 25_000): Sim64 {
  const words: string[] = []
  const lower = text.toLowerCase()
  WORD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WORD_RE.exec(lower)) !== null) {
    words.push(m[0])
    if (words.length >= maxWords) break
  }
  const v = new Int32Array(64)
  const addHash = (h: Sim64) => {
    let lo = h.lo
    let hi = h.hi
    for (let b = 0; b < 32; b++) {
      v[b] += lo & 1 ? 1 : -1
      v[32 + b] += hi & 1 ? 1 : -1
      lo >>>= 1
      hi >>>= 1
    }
  }
  if (words.length < 3) {
    for (const w of words) addHash(fnv1a64(w))
  } else {
    for (let i = 0; i + 2 < words.length; i++) addHash(fnv1a64(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]))
  }
  let lo = 0
  let hi = 0
  for (let b = 0; b < 32; b++) {
    if (v[b] > 0) lo |= 1 << b
    if (v[32 + b] > 0) hi |= 1 << b
  }
  return { hi: hi >>> 0, lo: lo >>> 0 }
}

function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return Math.imul(x, 0x01010101) >>> 24
}

export function hamming(a: Sim64, b: Sim64): number {
  return popcount32((a.hi ^ b.hi) >>> 0) + popcount32((a.lo ^ b.lo) >>> 0)
}

export function simToHex(s: Sim64): string {
  return s.hi.toString(16).padStart(8, '0') + s.lo.toString(16).padStart(8, '0')
}

export function simFromHex(hex: string): Sim64 | null {
  if (!/^[0-9a-f]{16}$/i.test(hex)) return null
  return { hi: parseInt(hex.slice(0, 8), 16) >>> 0, lo: parseInt(hex.slice(8), 16) >>> 0 }
}

/** "9f3a…c01e" */
export function simShort(s: Sim64): string {
  const h = simToHex(s)
  return `${h.slice(0, 4)}…${h.slice(-4)}`
}

interface SimEntry {
  sim: Sim64
  ref: string // page id
}

/**
 * Near-duplicate index. Bands: lo&0xffff, lo>>>16, hi&0xffff, hi>>>16.
 * By pigeonhole, any two hashes within hamming distance ≤ 3 agree exactly on at
 * least one of the 4 bands, so the bucket lookup is exact for threshold 3.
 */
export class SimIndex {
  private entries: SimEntry[] = []
  private buckets = new Map<number, number[]>() // (band<<16 | value) → entry indices

  get size(): number {
    return this.entries.length
  }

  private static bandKeys(s: Sim64): number[] {
    return [
      (0 << 16) | (s.lo & 0xffff),
      ((1 << 16) | (s.lo >>> 16)) >>> 0,
      ((2 << 16) | (s.hi & 0xffff)) >>> 0,
      ((3 << 16) | (s.hi >>> 16)) >>> 0,
    ]
  }

  add(sim: Sim64, ref: string): void {
    const idx = this.entries.length
    this.entries.push({ sim, ref })
    for (const k of SimIndex.bandKeys(sim)) {
      const b = this.buckets.get(k)
      if (b) b.push(idx)
      else this.buckets.set(k, [idx])
    }
  }

  /** Forget all but the newest `keep` entries (bounds memory on an endless crawl). */
  retainNewest(keep: number): void {
    if (this.entries.length <= keep) return
    const kept = this.entries.slice(this.entries.length - Math.max(0, keep))
    this.entries = []
    this.buckets = new Map()
    for (const e of kept) this.add(e.sim, e.ref)
  }

  /** Closest entry within `maxDist` using the LSH buckets, or null. */
  findNear(sim: Sim64, maxDist = 3): { ref: string; dist: number } | null {
    let best: { ref: string; dist: number } | null = null
    const checked = new Set<number>()
    for (const k of SimIndex.bandKeys(sim)) {
      const b = this.buckets.get(k)
      if (!b) continue
      for (const idx of b) {
        if (checked.has(idx)) continue
        checked.add(idx)
        const e = this.entries[idx]
        const d = hamming(sim, e.sim)
        if (d <= maxDist && (!best || d < best.dist)) best = { ref: e.ref, dist: d }
      }
    }
    return best
  }

  /**
   * True nearest distance (for the human trace). Linear scan, but bounded to the
   * newest `limit` entries so it stays well under a millisecond.
   */
  nearestDistance(sim: Sim64, limit = 20_000): { ref: string; dist: number } | null {
    let best: { ref: string; dist: number } | null = null
    const start = Math.max(0, this.entries.length - limit)
    for (let i = this.entries.length - 1; i >= start; i--) {
      const e = this.entries[i]
      const d = hamming(sim, e.sim)
      if (!best || d < best.dist) {
        best = { ref: e.ref, dist: d }
        if (d === 0) break
      }
    }
    return best
  }
}
