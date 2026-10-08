// Winternitz one-time signatures (WOTS, w = 16) over SHA-256, for the /exposure demo. Everything runs in the
// browser through WebCrypto (crypto.subtle.digest); no key, message or signature leaves the page.
//
// Parameters: n = 32 bytes (SHA-256), w = 16 (one base-16 digit per chain).
//   message digest  SHA-256(message) = 64 base-16 digits (len1 = 64)
//   checksum        C = Σ (15 − digit) over those 64 digits, at most 960 = 0x3c0, written as 3 base-16 digits (len2 = 3)
//   chains          len = 67; chain i starts at sk_i = SHA-256(seed ‖ u16(i)) and takes 15 steps
//   one step        x ← SHA-256(u16(i) ‖ u8(j) ‖ x) for step j of chain i (the chain index and step are mixed in,
//                   as XMSS and SLH-DSA do with their hash addresses, so equal values on two chains never collide)
//   public key      the 67 chain ends, hashed into 32 bytes
//   signature       for each chain, the value after `digit` steps: 67 × 32 = 2,144 bytes
//   verify          walk each signature value the remaining 15 − digit steps, hash the 67 ends, compare
//
// The checksum is what makes one signature safe: raising any message digit (walking a chain further, which
// anyone can do) lowers the checksum, which would need a chain walked backwards, i.e. a SHA-256 preimage.
// A second signature with the same key reveals lower positions on some chains, and the two together can
// cover messages that were never signed. `forgeChance` counts that exactly; `forge` searches for one.
//
// This is a teaching implementation of the core scheme (no per-key public seed, no Merkle tree of many
// one-time keys). Standardised hash-based schemes (XMSS, RFC 8391; SLH-DSA, FIPS 205) build on it.

export const WOTS = { n: 32, w: 16, len1: 64, len2: 3, len: 67, steps: 15 } as const

/** Number of SHA-256 calls made by this module since load (the demo reports its own work). */
export let hashCount = 0

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('WebCrypto (crypto.subtle) is not available in this context')
  return c.subtle
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  hashCount++
  return new Uint8Array(await subtle().digest('SHA-256', data as Uint8Array<ArrayBuffer>))
}

const enc = new TextEncoder()
export const utf8 = (s: string) => enc.encode(s)

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Walk chain `i` from position `from` to position `to` (0 ≤ from ≤ to ≤ 15). */
export async function chain(x: Uint8Array, i: number, from: number, to: number): Promise<Uint8Array> {
  let v = x
  const buf = new Uint8Array(3 + WOTS.n)
  buf[0] = (i >> 8) & 0xff
  buf[1] = i & 0xff
  for (let j = from; j < to; j++) {
    buf[2] = j
    buf.set(v, 3)
    v = await sha256(buf)
  }
  return v
}

/** The 67 digits a message is signed as: 64 digest digits, then the 3 checksum digits. */
export function digitsOfDigest(digest: Uint8Array): number[] {
  if (digest.length !== WOTS.n) throw new Error('digest must be 32 bytes')
  const d: number[] = []
  for (const b of digest) d.push(b >> 4, b & 15)
  let c = 0
  for (const x of d) c += WOTS.steps - x
  d.push((c >> 8) & 15, (c >> 4) & 15, c & 15)
  return d
}

export const messageDigits = async (message: string | Uint8Array) => digitsOfDigest(await sha256(typeof message === 'string' ? utf8(message) : message))

export interface WotsKeyPair {
  /** 32-byte private seed; the 67 chain starts are derived from it. */
  seed: Uint8Array
  /** The 67 chain ends (position 15). */
  ends: Uint8Array[]
  /** SHA-256 of the 67 chain ends: the 32-byte public key. */
  publicKey: Uint8Array
}

export interface WotsSignature {
  /** The 67 digits signed (position revealed on each chain). */
  digits: number[]
  /** One 32-byte value per chain, at position digits[i]. */
  values: Uint8Array[]
}

const secretOf = (seed: Uint8Array, i: number) => sha256(concat([seed, new Uint8Array([(i >> 8) & 0xff, i & 0xff])]))

export async function generate(seed?: Uint8Array): Promise<WotsKeyPair> {
  const s = seed ?? globalThis.crypto.getRandomValues(new Uint8Array(WOTS.n))
  if (s.length !== WOTS.n) throw new Error('seed must be 32 bytes')
  const ends = await Promise.all(Array.from({ length: WOTS.len }, async (_, i) => chain(await secretOf(s, i), i, 0, WOTS.steps)))
  return { seed: s, ends, publicKey: await sha256(concat(ends)) }
}

export async function sign(kp: WotsKeyPair, message: string | Uint8Array): Promise<WotsSignature> {
  const digits = await messageDigits(message)
  const values = await Promise.all(digits.map(async (d, i) => chain(await secretOf(kp.seed, i), i, 0, d)))
  return { digits, values }
}

/** The 67 chain ends a signature leads to for a message (the verifier's half of the work). */
export async function endsFrom(message: string | Uint8Array, values: Uint8Array[]): Promise<Uint8Array[]> {
  if (values.length !== WOTS.len || values.some((v) => v.length !== WOTS.n)) throw new Error('a signature is 67 values of 32 bytes')
  const digits = await messageDigits(message)
  return Promise.all(digits.map((d, i) => chain(values[i], i, d, WOTS.steps)))
}

export async function verify(publicKey: Uint8Array, message: string | Uint8Array, values: Uint8Array[]): Promise<boolean> {
  let ends: Uint8Array[]
  try {
    ends = await endsFrom(message, values)
  } catch {
    return false
  }
  const pk = await sha256(concat(ends))
  if (pk.length !== publicKey.length) return false
  let diff = 0
  for (let i = 0; i < pk.length; i++) diff |= pk[i] ^ publicKey[i]
  return diff === 0
}

export const signatureBytes = (sig: WotsSignature) => concat(sig.values)

// ─── reuse: what two or more signatures with one key give away ───────────────

/** For each chain, the lowest position any of the signatures revealed, and its value. */
export interface Revealed {
  step: number
  value: Uint8Array
}

export function lowestRevealed(sigs: WotsSignature[]): Revealed[] {
  if (!sigs.length) return []
  return Array.from({ length: WOTS.len }, (_, i) => {
    let best = sigs[0]
    for (const s of sigs) if (s.digits[i] < best.digits[i]) best = s
    return { step: best.digits[i], value: best.values[i] }
  })
}

/**
 * Exact probability that the digest of one random message (the 64 digest digits uniform, the checksum derived
 * from them) lands on or above every revealed position, i.e. can be signed by walking the revealed values
 * forward. Includes the messages already signed (each has probability 16^-64).
 */
export function coverChance(lowest: number[]): number {
  if (lowest.length !== WOTS.len) throw new Error('need 67 positions')
  // dp[c] = probability that the checksum part so far equals c
  let dp = new Float64Array(WOTS.len1 * WOTS.steps + 1)
  dp[0] = 1
  for (let i = 0; i < WOTS.len1; i++) {
    const next = new Float64Array(dp.length)
    for (let c = 0; c < dp.length; c++) {
      const p = dp[c]
      if (p === 0) continue
      for (let d = lowest[i]; d <= WOTS.steps; d++) next[c + WOTS.steps - d] += p / WOTS.w
    }
    dp = next
  }
  let total = 0
  for (let c = 0; c < dp.length; c++) {
    if (dp[c] === 0) continue
    if (((c >> 8) & 15) >= lowest[64] && ((c >> 4) & 15) >= lowest[65] && (c & 15) >= lowest[66]) total += dp[c]
  }
  return total
}

/**
 * Chance that one random message is forgeable from what the signatures revealed, leaving out the messages
 * already signed. 0 for a single signature: covering its own digits only, the checksum forbids anything else.
 */
export function forgeChance(sigs: WotsSignature[]): number {
  if (!sigs.length) return 0
  const signed = new Set(sigs.map((s) => s.digits.join(','))).size
  const p = coverChance(lowestRevealed(sigs).map((r) => r.step)) - signed * Math.pow(WOTS.w, -WOTS.len1)
  // below this the float residue is the signed messages themselves, not a forgery
  return p < 1e-60 ? 0 : p
}

/** A signature for `message` built only from revealed values, or null when a digit sits below what was revealed. */
export async function forgeFrom(lowest: Revealed[], message: string | Uint8Array): Promise<WotsSignature | null> {
  const digits = await messageDigits(message)
  if (digits.some((d, i) => d < lowest[i].step)) return null
  const values = await Promise.all(digits.map((d, i) => chain(lowest[i].value, i, lowest[i].step, d)))
  return { digits, values }
}

export interface ForgeResult {
  found: { message: string; signature: WotsSignature } | null
  tries: number
  ms: number
}

/**
 * Try messages `${prefix}${k}` for k = 0, 1, … until one is covered by the revealed positions, the try budget
 * runs out, `deadlineMs` passes, or `signal` aborts. Hashes in batches so the page stays responsive.
 */
export async function forge(
  lowest: Revealed[],
  prefix: string,
  opts: { maxTries: number; deadlineMs: number; signal?: AbortSignal; onProgress?: (tries: number) => void; batch?: number },
): Promise<ForgeResult> {
  const t0 = performance.now()
  const batch = opts.batch ?? 256
  const low = lowest.map((r) => r.step)
  let tries = 0
  while (tries < opts.maxTries && performance.now() - t0 < opts.deadlineMs && !opts.signal?.aborted) {
    const n = Math.min(batch, opts.maxTries - tries)
    const msgs = Array.from({ length: n }, (_, k) => `${prefix}${tries + k}`)
    const digs = await Promise.all(msgs.map((m) => messageDigits(m)))
    tries += n
    for (let k = 0; k < n; k++) {
      if (digs[k].every((d, i) => d >= low[i])) {
        const signature = await forgeFrom(lowest, msgs[k])
        if (signature) return { found: { message: msgs[k], signature }, tries: tries - n + k + 1, ms: performance.now() - t0 }
      }
    }
    opts.onProgress?.(tries)
    await new Promise((r) => setTimeout(r, 0))
  }
  return { found: null, tries, ms: performance.now() - t0 }
}
