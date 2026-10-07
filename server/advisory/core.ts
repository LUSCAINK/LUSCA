// ADVISORY CHECK core: source normalization + hashing, version ordering and ranges, OpenZeppelin header parsing.
// Pure functions (no I/O): shared by the regeneration scripts (scripts/advisory/*) and the server module.
import { createHash } from 'node:crypto'

/** Line endings and a leading BOM are the only differences ignored: everything else must be byte-identical. */
export function normalizeSource(text: string): string {
  let t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (t.indexOf('\r') >= 0) t = t.replace(/\r\n?/g, '\n')
  return t
}

/** sha256 of the normalized UTF-8 text, first 32 hex chars (128 bits). */
export function fileHash(text: string): string {
  return createHash('sha256').update(normalizeSource(text), 'utf8').digest('hex').slice(0, 32)
}

// ── versions (semver 2.0 ordering, enough for npm release tags and solc versions) ──
export interface Ver { major: number; minor: number; patch: number; pre: (string | number)[] }

export function parseVer(s: string): Ver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s.trim())
  if (!m) return null
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : []
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre }
}

export function cmpVer(a: string | Ver, b: string | Ver): number {
  const x = typeof a === 'string' ? parseVer(a) : a
  const y = typeof b === 'string' ? parseVer(b) : b
  if (!x || !y) return String(a).localeCompare(String(b))
  if (x.major !== y.major) return x.major - y.major
  if (x.minor !== y.minor) return x.minor - y.minor
  if (x.patch !== y.patch) return x.patch - y.patch
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0)
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    if (typeof p === 'number' && typeof q === 'number') return p - q
    if (typeof p === 'number') return -1
    if (typeof q === 'number') return 1
    return p < q ? -1 : 1
  }
  return 0
}

/** One affected range as OSV publishes it: introduced (inclusive) .. fixed (exclusive) or lastAffected (inclusive). */
export interface VerRange { introduced: string; fixed?: string | null; lastAffected?: string | null }

export function inRange(v: string, r: VerRange): boolean {
  if (r.introduced !== '0' && cmpVer(v, r.introduced) < 0) return false
  if (r.fixed && cmpVer(v, r.fixed) >= 0) return false
  if (r.lastAffected && cmpVer(v, r.lastAffected) > 0) return false
  return true
}

export const inAnyRange = (v: string, rs: VerRange[]) => rs.some((r) => inRange(v, r))

export function rangeLabel(r: VerRange): string {
  const lo = r.introduced === '0' ? '' : `>= ${r.introduced}`
  const hi = r.fixed ? `< ${r.fixed}` : r.lastAffected ? `<= ${r.lastAffected}` : ''
  return [lo, hi].filter(Boolean).join(', ') || 'all versions'
}

// ── OpenZeppelin file headers ──
// "// OpenZeppelin Contracts (last updated v4.9.0) (token/ERC20/ERC20.sol)"   (4.5 and later)
// "// OpenZeppelin Contracts v4.4.1 (token/ERC20/ERC20.sol)"                  (4.4)
// "// OpenZeppelin Contracts Upgradeable / "OpenZeppelin Contracts (last updated v5.0.0) (...)"
export interface OzHeader { version: string; path: string }
// Only spaces and tabs around the tokens: `\s` would also span newlines, and with the `m` flag a run of blank lines
// would then be rescanned from every line start (quadratic on a crafted source).
const HEADER_RE = /^[ \t]*\/\/[ \t]*OpenZeppelin Contracts(?: Upgradeable)?(?:[ \t]*\(last updated v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\)|[ \t]+v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))[ \t]*\(([^)\s]+\.sol)\)/m
/** A flattened source carries one header per OpenZeppelin file; more than this many is not a real flattened source. */
export const MAX_HEADERS = 400

/** The OpenZeppelin header of a source file, looked for in its first 600 characters (after the SPDX line). */
export function ozHeader(text: string): OzHeader | null {
  const m = HEADER_RE.exec(text.slice(0, 600))
  if (!m) return null
  return { version: m[1] ?? m[2], path: m[3] }
}

/** Every OpenZeppelin header in a source, in order, with its character offset and 1-based line (at most MAX_HEADERS). */
export function ozHeaders(text: string, max = MAX_HEADERS): (OzHeader & { at: number; line: number })[] {
  const re = new RegExp(HEADER_RE.source, 'gm')
  const out: (OzHeader & { at: number; line: number })[] = []
  let line = 1, pos = 0
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0
    // headers come in offset order: count newlines forward from the previous one (one pass over the text)
    for (let i = text.indexOf('\n', pos); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) line++
    pos = at
    out.push({ version: m[1] ?? m[2], path: m[3], at, line })
    if (out.length >= max) break
  }
  return out
}

// ── code view: comments and whitespace removed, offsets kept ──
/**
 * The code of a Solidity source with comments and all whitespace removed, plus each kept character's offset in the
 * original text: markers are compared on this view, so formatting and comments never decide a match. One linear pass.
 */
export function codeView(text: string): { code: string; pos: Int32Array } {
  const n = text.length
  const pos = new Int32Array(n)
  const parts: string[] = []
  let k = 0, run = -1
  const flush = (end: number) => {
    if (run < 0) return
    parts.push(text.slice(run, end))
    for (let j = run; j < end; j++) pos[k++] = j
    run = -1
  }
  const space = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i)
    if (c === 47 /* / */ && (text.charCodeAt(i + 1) === 47 || text.charCodeAt(i + 1) === 42)) {
      flush(i)
      if (text.charCodeAt(i + 1) === 47) { const e = text.indexOf('\n', i); i = e < 0 ? n : e }
      else { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 1 }
      continue
    }
    if (space(c)) { flush(i); continue }
    if (c === 34 || c === 39) { // a string literal: no comment starts inside it; its whitespace is dropped like the rest
      if (run < 0) run = i
      for (i++; i < n; i++) {
        const d = text.charCodeAt(i)
        if (d === 10 || d === c) break
        if (space(d)) { flush(i); continue }
        if (run < 0) run = i
        if (d === 92 /* \ */ && i + 1 < n && text.charCodeAt(i + 1) !== 10) i++
      }
      if (i >= n || text.charCodeAt(i) === 10) flush(i) // unterminated: the string ends with its line
      else if (run < 0) run = i // the closing quote
      continue
    }
    if (run < 0) run = i
  }
  flush(n)
  return { code: parts.join(''), pos: pos.subarray(0, k) }
}

/** Code markers of an advisory's fix, compared on the code view (no comments, no whitespace). */
export interface FixMarker {
  /** Every one of these is in the code before the fix (e.g. the branch the fix removed). */
  all?: string[]
  /** At least one of these is in the code before the fix. */
  any?: string[]
  /** None of these is in the code before the fix (e.g. the check the fix added). */
  none?: string[]
  /** The evidence line: the first of these found (default: the first `all` / `any` marker found). */
  at?: string[]
}

const squash = (s: string) => s.replace(/\s+/g, '')

/** Whether a source still has the code the fix changed, and the 1-based line of the evidence marker (null if none). */
export function fixCheck(text: string, fix: FixMarker): { pre: boolean; line: number | null; marker: string | null } {
  const { code, pos } = codeView(text)
  const has = (m: string) => code.indexOf(squash(m)) >= 0
  const pre = (fix.all ?? []).every(has) && (!fix.any?.length || fix.any.some(has)) && !(fix.none ?? []).some(has)
  for (const m of fix.at ?? [...(fix.all ?? []), ...(fix.any ?? [])]) {
    const at = code.indexOf(squash(m))
    if (at < 0) continue
    return { pre, line: lineOf(text, pos[at]), marker: m }
  }
  return { pre, line: null, marker: null }
}

/** 1-based line of a character offset (one forward scan). */
export function lineOf(text: string, at: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) line++
  return line
}

// ── solc versions ──
/** "v0.8.19+commit.7dd6d404" | "0.8.19" | "vyper:0.3.10" → "0.8.19" (Solidity only; null otherwise). */
export function solcVersionOf(compiler: string | null | undefined): string | null {
  if (!compiler) return null
  if (/vyper/i.test(compiler)) return null
  const m = /(?:^|[^\d.])v?(0\.\d{1,2}\.\d{1,2})(?:[+-]|$)/.exec(compiler.trim()) ?? /^v?(0\.\d{1,2}\.\d{1,2})/.exec(compiler.trim())
  return m ? m[1] : null
}

// ── compact index lists ──
/** Sorted integer list → ranges "3-7,9,12-14". */
export function packIdx(list: number[]): string {
  const s = [...new Set(list)].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < s.length; ) {
    let j = i
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++
    out.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`)
    i = j + 1
  }
  return out.join(',')
}

export function unpackIdx(s: string): number[] {
  if (!s) return []
  const out: number[] = []
  for (const part of s.split(',')) {
    const [a, b] = part.split('-').map(Number)
    if (b === undefined) out.push(a)
    else for (let i = a; i <= b; i++) out.push(i)
  }
  return out
}
