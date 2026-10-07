// @ts-check
// CODE SEARCH — helpers shared by the builder worker (build.mjs), the query workers (query.mjs) and the
// main thread (index.ts, through common.d.mts). Plain JS: tsx does not reliably transpile .ts worker files.

/** Library code by path: what custom=1 leaves out (plus files also in the protocol code index). */
export const LIB_PATH_RE =
  /(^|\/)(@openzeppelin(-upgradeable)?|openzeppelin-contracts(-upgradeable)?|openzeppelin-solidity|@rari-capital|solmate|@?solady|forge-std|ds-test|zos-lib|erc721a(-upgradeable)?|node_modules|lib|libs|@uniswap|@chainlink|@layerzerolabs|@aave|@gnosis\.pm|@safe-global|hardhat|@prb|@api3|@pythnetwork|@balancer-labs|@ensdomains|@account-abstraction|@thirdweb-dev|@manifoldxyz|@limitbreak|closedsea|operator-filter-registry)\//i

export const isLibPath = (/** @type {string} */ p) => LIB_PATH_RE.test(p)

/** A path as results show it: an absolute home directory from the verified metadata is cut to its project part. */
export const HOME_RE = /^(?:\/(?:Users|home)\/[^/]+|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+)[\\/]/
export const shownPath = (/** @type {string} */ p) => (HOME_RE.test(p) ? `…/${p.replace(HOME_RE, '')}` : p)

/** ASCII lower-case table (bytes). Non-ASCII bytes stay as they are. */
export const LOWER = new Uint8Array(256)
for (let i = 0; i < 256; i++) LOWER[i] = i >= 65 && i <= 90 ? i | 32 : i

/** Trigram signature bits for a file with `distinct` distinct trigrams (4 to 8 bits per trigram, a power of two). */
export function sigBitsFor(/** @type {number} */ distinct) {
  let bits = 256
  const want = Math.max(256, distinct * 4)
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

/** Length of the quantifier at `i` (0 if none), whether it allows zero repetitions / is unbounded, and its upper count. */
function quantAt(/** @type {string} */ p, /** @type {number} */ i) {
  const c = p[i]
  let len = 0
  let zero = false
  let unbounded = false
  let max = 1
  if (c === '*') [len, zero, unbounded, max] = [1, true, true, Infinity]
  else if (c === '+') [len, zero, unbounded, max] = [1, false, true, Infinity]
  else if (c === '?') [len, zero, unbounded, max] = [1, true, false, 1]
  else if (c === '{') {
    const m = QUANT_RE.exec(p.slice(i))
    if (m) {
      len = m[0].length
      zero = Number(m[1]) === 0
      unbounded = m[2] !== undefined && m[3] === ''
      max = unbounded ? Infinity : m[3] ? Number(m[3]) : Number(m[1])
      if (!unbounded && m[3]) unbounded = Number(m[3]) > 64
    }
  }
  if (len && p[i + len] === '?') len++
  return { len, zero, unbounded, max }
}

/** A quantified group that contains a quantifier or an alternation may repeat at most this often. */
const NESTED_MAX = 8
/** Open-ended repeats (*, +, {n,}) of a character class / . / \w … one after another with no literal between. */
const RUN_MAX = 3
/** Open-ended repeats of . in one pattern. */
const DOTS_MAX = 4

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

/** Kinds of a repeated atom, for the overlap test of refuseRegex: w s d (\w \s \d), W S D (negations), . (any), c (a class), g (a group). */
const DISJOINT = new Set(['w|s', 'w|W', 's|d', 's|S', 'd|W', 'd|D'])
const overlaps = (/** @type {string} */ a, /** @type {string} */ b) => a === b || !(DISJOINT.has(`${a}|${b}`) || DISJOINT.has(`${b}|${a}`))

/**
 * Why a regex is refused before it runs (null = accepted): backreferences; a quantified group that itself
 * contains a quantifier or an alternation and may repeat more than NESTED_MAX times ((a+)+, (a|b)*, (\w+\s?){64});
 * more than RUN_MAX open-ended repeats that can match the same characters with no required literal between them
 * (\w*\w*\w*\w*, .*.*.*.*); more than DOTS_MAX open-ended .* / .+ in the whole pattern. These are the shapes that
 * backtrack exponentially or with a high polynomial. The query workers still run every regex under a hard time
 * budget, and an address whose patterns keep running out of time is paused (index.ts).
 */
export function refuseRegex(/** @type {string} */ p) {
  if (/\\[1-9]|\\k</.test(p)) return 'backreferences are not supported'
  /** @type {{ quant: boolean; alt: boolean }[]} */
  const stack = []
  /** @type {string[]} */
  let seg = [] // kinds of the open-ended repeats since the last required literal
  let dots = 0
  /** An open-ended repeat of an atom of this kind. */
  const repeat = (/** @type {string} */ kind) => {
    if (kind === '.') dots++
    if (dots > DOTS_MAX) return `more than ${DOTS_MAX} open-ended .* or .+ in one pattern can take polynomial time — anchor them with literal text`
    seg.push(kind)
    if (seg.filter((k) => overlaps(k, kind)).length > RUN_MAX)
      return 'several open-ended repeats that can match the same text in a row (like \\w*\\w*\\w*\\w* or .*.*.*.*) can take polynomial time — put literal text between them'
    return null
  }
  let i = 0
  while (i < p.length) {
    const c = p[i]
    if (c === '\\') {
      const e = p[i + 1] ?? ''
      let next = i + 2
      if (e === 'x') next = i + 4
      else if (e === 'u') next = p[i + 2] === '{' ? p.indexOf('}', i) + 1 || p.length : i + 6
      else if (e === 'p' || e === 'P') next = p[i + 2] === '{' ? p.indexOf('}', i) + 1 || p.length : i + 2
      else if (e === 'c') next = i + 3
      const q = quantAt(p, next)
      if (q.len && stack.length) stack[stack.length - 1].quant = true
      const kind = 'wsdWSD'.includes(e) && e ? e : e === 'p' || e === 'P' ? 'c' : null
      if (e === 'b' || e === 'B') {
        // an assertion: neither a repeat nor a literal
      } else if (kind) {
        if (q.unbounded) {
          const why = repeat(kind)
          if (why) return why
        }
      } else if (!q.len || !q.zero) seg = [] // a required literal (\. \( \x41 …) ends the run
      i = next + q.len
      continue
    }
    if (c === '[') {
      i = skipClass(p, i)
      const q = quantAt(p, i)
      if (q.len && stack.length) stack[stack.length - 1].quant = true
      if (q.unbounded) {
        const why = repeat('c')
        if (why) return why
      }
      i += q.len
      continue
    }
    if (c === '(') {
      stack.push({ quant: false, alt: false })
      i++
      if (p[i] === '?') {
        // (?: (?= (?! (?<= (?<! (?<name>
        if (p[i + 1] === '<' && p[i + 2] !== '=' && p[i + 2] !== '!') {
          const gt = p.indexOf('>', i)
          i = gt < 0 ? p.length : gt + 1
        } else i += p[i + 1] === '<' ? 3 : 2
      }
      continue
    }
    if (c === '|') {
      if (stack.length) stack[stack.length - 1].alt = true
      seg = []
      i++
      continue
    }
    if (c === ')') {
      const g = stack.pop()
      i++
      const q = quantAt(p, i)
      if (g && q.len && q.max > NESTED_MAX && (g.quant || g.alt))
        return 'a repeated group that holds a repeat or an alternation, such as (a+)+, (a|b)* or (\\w+\\s?){64}, can take exponential time — rewrite without the outer repetition'
      if (q.len && stack.length) stack[stack.length - 1].quant = true
      if (g?.quant && stack.length) stack[stack.length - 1].quant = true
      if (q.unbounded) {
        const why = repeat('g')
        if (why) return why
      }
      i += q.len
      continue
    }
    const q = quantAt(p, i + 1)
    if (q.len && stack.length) stack[stack.length - 1].quant = true
    if (c === '.') {
      if (q.unbounded) {
        const why = repeat('.')
        if (why) return why
      }
    } else if (c !== '^' && c !== '$' && (!q.len || !q.zero)) seg = [] // a required literal character ends the run
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
