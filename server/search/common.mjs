// @ts-check
// CODE SEARCH — helpers shared by the builder worker (build.mjs), the query workers (query.mjs) and the
// main thread (index.ts, through common.d.mts). Plain JS: tsx does not reliably transpile .ts worker files.

/** Library code by path: what custom=1 leaves out (plus files also in the protocol code index). */
export const LIB_PATH_RE =
  /(^|\/)(@openzeppelin(-upgradeable)?|openzeppelin-contracts(-upgradeable)?|openzeppelin-solidity|@rari-capital|solmate|@?solady|forge-std|ds-test|zos-lib|erc721a(-upgradeable)?|node_modules|lib|libs|@uniswap|@chainlink|@layerzerolabs|@aave|@gnosis\.pm|@safe-global|hardhat|@prb|@api3|@pythnetwork|@balancer-labs|@ensdomains|@account-abstraction|@thirdweb-dev|@manifoldxyz|@limitbreak|closedsea|operator-filter-registry)\//i

export const isLibPath = (/** @type {string} */ p) => LIB_PATH_RE.test(p)

/** ASCII lower-case table (bytes). Non-ASCII bytes stay as they are. */
export const LOWER = new Uint8Array(256)
for (let i = 0; i < 256; i++) LOWER[i] = i >= 65 && i <= 90 ? i | 32 : i

/** Trigram signature bits for a file with `distinct` distinct trigrams (≈ 8 bits per trigram, power of two). */
export function sigBitsFor(/** @type {number} */ distinct) {
  let bits = 256
  const want = Math.max(256, distinct * 8)
  while (bits < want && bits < 1 << 22) bits <<= 1
  return bits
}

/** Bit of a trigram code (24-bit, lower-cased bytes) in a signature of 2^lg bits. */
export const sigBit = (/** @type {number} */ t, /** @type {number} */ lg) => (Math.imul(t, 0x9e3779b1) >>> (32 - lg)) >>> 0

/** Trigram codes (lower-cased ASCII bytes; trigrams with a non-ASCII byte are skipped) of each run, deduplicated. */
export function trigramsOf(/** @type {string[]} */ runs) {
  /** @type {Set<number>} */
  const out = new Set()
  for (const r of runs) {
    const b = Buffer.from(r, 'utf8')
    for (let i = 0; i + 2 < b.length; i++) {
      if (b[i] > 127 || b[i + 1] > 127 || b[i + 2] > 127) continue
      out.add((LOWER[b[i]] << 16) | (LOWER[b[i + 1]] << 8) | LOWER[b[i + 2]])
    }
  }
  return [...out]
}

const PUNCT_ESC = new Set('.^$|?*+()[]{}\\/-:,=!<>#&~\'"`@%;_ '.split(''))
const QUANT_RE = /^\{(\d+)(,(\d*))?\}/

/** Index just past the character class that starts at `i` ('['). */
function skipClass(/** @type {string} */ p, /** @type {number} */ i) {
  let j = i + 1
  if (p[j] === '^') j++
  if (p[j] === ']') j++
  while (j < p.length && p[j] !== ']') j += p[j] === '\\' ? 2 : 1
  return j + 1
}

/** Index just past the group that starts at `i` ('('). */
function skipGroup(/** @type {string} */ p, /** @type {number} */ i) {
  let depth = 0
  let j = i
  while (j < p.length) {
    const c = p[j]
    if (c === '\\') j += 2
    else if (c === '[') j = skipClass(p, j)
    else {
      if (c === '(') depth++
      else if (c === ')') {
        depth--
        if (depth === 0) return j + 1
      }
      j++
    }
  }
  return j
}

/** Length of the quantifier at `i` (0 if none), and whether it allows zero repetitions / is unbounded. */
function quantAt(/** @type {string} */ p, /** @type {number} */ i) {
  const c = p[i]
  let len = 0
  let zero = false
  let unbounded = false
  if (c === '*') [len, zero, unbounded] = [1, true, true]
  else if (c === '+') [len, zero, unbounded] = [1, false, true]
  else if (c === '?') [len, zero, unbounded] = [1, true, false]
  else if (c === '{') {
    const m = QUANT_RE.exec(p.slice(i))
    if (m) {
      len = m[0].length
      zero = Number(m[1]) === 0
      unbounded = m[2] !== undefined && m[3] === ''
      if (!unbounded && m[3]) unbounded = Number(m[3]) > 64
    }
  }
  if (len && p[i + len] === '?') len++
  return { len, zero, unbounded }
}

/** True when the pattern has a '|' outside every group and class. */
function topLevelAlternation(/** @type {string} */ p) {
  let i = 0
  while (i < p.length) {
    const c = p[i]
    if (c === '\\') i += 2
    else if (c === '[') i = skipClass(p, i)
    else if (c === '(') i = skipGroup(p, i)
    else if (c === '|') return true
    else i++
  }
  return false
}

/**
 * Literal strings every match of the regex must contain (conservative: groups, classes and escapes like
 * \w end a run; an optional character is dropped). Runs shorter than 3 characters are left out.
 */
export function requiredRuns(/** @type {string} */ p) {
  if (topLevelAlternation(p)) return []
  /** @type {string[]} */
  const runs = []
  let cur = ''
  const flush = () => {
    if (cur.length >= 3) runs.push(cur)
    cur = ''
  }
  let i = 0
  while (i < p.length) {
    const c = p[i]
    /** @type {string | null} */
    let lit = null
    let next = i + 1
    if (c === '\\') {
      const e = p[i + 1]
      if (e !== undefined && PUNCT_ESC.has(e)) {
        lit = e
        next = i + 2
      } else {
        flush()
        // \xHH, \uHHHH, \u{…}, \p{…}, \cX, \d …
        if (e === 'x') next = i + 4
        else if (e === 'u') next = p[i + 2] === '{' ? p.indexOf('}', i) + 1 || p.length : i + 6
        else if (e === 'p' || e === 'P') next = p[i + 2] === '{' ? p.indexOf('}', i) + 1 || p.length : i + 2
        else if (e === 'c') next = i + 3
        else next = i + 2
        const q = quantAt(p, next)
        i = next + q.len
        continue
      }
    } else if (c === '[') {
      flush()
      next = skipClass(p, i)
      i = next + quantAt(p, next).len
      continue
    } else if (c === '(') {
      flush()
      next = skipGroup(p, i)
      i = next + quantAt(p, next).len
      continue
    } else if (c === '.' || c === '^' || c === '$' || c === ')' || c === '|') {
      flush()
      i = next + (c === '.' ? quantAt(p, next).len : 0)
      continue
    } else if ((c === '*' || c === '+' || c === '?') && !cur) {
      i++
      continue
    } else if (c === '{' && QUANT_RE.test(p.slice(i))) {
      i += quantAt(p, i).len
      continue
    } else lit = c
    const q = quantAt(p, next)
    if (q.len) {
      if (!q.zero) cur += lit
      flush()
      i = next + q.len
      continue
    }
    cur += lit
    i = next
  }
  flush()
  return runs
}

/**
 * Why a regex is refused before it runs (null = accepted): backreferences and quantified groups that
 * themselves contain a quantifier or an alternation (the shapes that backtrack exponentially).
 * The query workers still run every regex under a hard time budget.
 */
export function refuseRegex(/** @type {string} */ p) {
  if (/\\[1-9]|\\k</.test(p)) return 'backreferences are not supported'
  /** @type {{ quant: boolean; alt: boolean }[]} */
  const stack = []
  let i = 0
  while (i < p.length) {
    const c = p[i]
    if (c === '\\') {
      i += 2
      const q = quantAt(p, i)
      if (q.len && stack.length) stack[stack.length - 1].quant = true
      i += q.len
      continue
    }
    if (c === '[') {
      i = skipClass(p, i)
      const q = quantAt(p, i)
      if (q.len && stack.length) stack[stack.length - 1].quant = true
      i += q.len
      continue
    }
    if (c === '(') {
      stack.push({ quant: false, alt: false })
      i++
      continue
    }
    if (c === '|') {
      if (stack.length) stack[stack.length - 1].alt = true
      i++
      continue
    }
    if (c === ')') {
      const g = stack.pop()
      i++
      const q = quantAt(p, i)
      if (g && q.len && q.unbounded && (g.quant || g.alt)) return 'nested quantifiers such as (a+)+ or (a|b)* can take exponential time — rewrite without the outer repetition'
      if (q.len && stack.length) stack[stack.length - 1].quant = true
      if (g?.quant && stack.length) stack[stack.length - 1].quant = true
      i += q.len
      continue
    }
    const q = quantAt(p, i + 1)
    if (q.len && stack.length) stack[stack.length - 1].quant = true
    i += 1 + q.len
  }
  return null
}

/** Escape a literal for new RegExp. */
export const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** Path filter → predicate. Plain text: case-insensitive substring. With * or ?: glob (a pattern without / also matches the file name). */
export function pathMatcher(/** @type {string | null | undefined} */ glob) {
  const g = (glob ?? '').trim()
  if (!g) return null
  if (!/[*?]/.test(g)) {
    const low = g.toLowerCase()
    return (/** @type {string} */ p) => p.toLowerCase().includes(low)
  }
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*'
        i++
        if (g[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += escapeRe(c)
  }
  const rx = new RegExp(`^(?:.*/)?${re}$`, 'i')
  return (/** @type {string} */ p) => rx.test(p)
}
