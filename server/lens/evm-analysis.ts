// Source-side analysis of a verified EVM contract for Lens. Pure functions, no I/O, deterministic:
//
//   · ABI functions grouped by mutability (state-changing / payable / view)
//   · privileged functions: ABI functions whose definition in the verified source is guarded by an
//     access-control modifier (onlyOwner, onlyRole(…), auth, requiresAuth, any modifier whose body
//     checks msg.sender) or checks msg.sender itself (require / if / assert, _checkOwner(), hasRole(…,
//     msg.sender), wards[msg.sender]) or calls an internal helper that does — cited by file:line
//   · hash / crypto primitives in the source (keccak256, sha256, ripemd160, ecrecover, ECDSA,
//     EIP-1271, EIP-712, Merkle proofs, precompile calls: modexp, BN254, blake2f, KZG point
//     evaluation, P-256) — cited by file:line
//
// Line numbers are those of the verified file: comments are blanked with their newlines kept and
// string literals emptied before matching (server/chain/evm-source.ts stripSolidity 'lines').
//
// Cost on hostile input (anyone can verify a contract): every run of whitespace is compacted to one
// character before any pattern runs (a map keeps the original line numbers), no pattern has two
// unbounded quantifiers that can match the same characters, and the whole analysis of one contract
// spends from a fixed work budget (characters scanned). When the budget runs out the analysis stops
// and the report says "not completed": no partial or guessed list is shown.

import type { LensPrimitive, LensPrivileged, PrimitiveGroup } from '../../shared/lens.ts'
import { langOfPath, stripSolidity } from '../chain/evm-source.ts'

export interface SourceFile {
  path: string
  text: string
}

/** The source analysis of one contract ran out of its work budget. */
export class AnalysisLimit extends Error {
  readonly why: string
  constructor(why: string) {
    super(why)
    this.why = why
    this.name = 'AnalysisLimit'
  }
}

/**
 * Characters (scanned or matched over) one contract's analysis may spend. Real bundles cost ~11–17 units
 * per source byte (measured over every Solidity repository of the code index), so a 6 MB bundle (the
 * readers' cap) needs ~100 M: the limit leaves 4× headroom and stops hostile nesting in ~0.3 s.
 */
export const ANALYSIS_BUDGET = 400_000_000
/** Wall-clock backstop for the same analysis (the budget above is the deterministic limit). */
export const ANALYSIS_MAX_MS = 8_000

export class Work {
  private used = 0
  private readonly t0 = Date.now()
  readonly limit: number
  readonly maxMs: number
  constructor(limit = ANALYSIS_BUDGET, maxMs = ANALYSIS_MAX_MS) {
    this.limit = limit
    this.maxMs = maxMs
  }
  spend(n: number) {
    this.used += n
    if (this.used > this.limit) throw new AnalysisLimit('source too large to analyse within the fixed work budget')
    if ((this.used & 0xfff) < n && Date.now() - this.t0 > this.maxMs) throw new AnalysisLimit('source analysis took too long')
  }
  get spent() {
    return this.used
  }
}

const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12

/**
 * `s` with every whitespace run collapsed to one character ('\n' when the run held a newline, else
 * ' '), and `map[i]` = index in `s` of compacted character i (map[length] = s.length).
 */
export function compactWs(s: string): { text: string; map: Int32Array } {
  const map = new Int32Array(s.length + 1)
  const parts: string[] = []
  let n = 0
  let run = 0
  let i = 0
  while (i < s.length) {
    if (!isWs(s.charCodeAt(i))) {
      i++
      continue
    }
    if (i > run) {
      parts.push(s.slice(run, i))
      for (let k = run; k < i; k++) map[n++] = k
    }
    const st = i
    let nl = false
    while (i < s.length && isWs(s.charCodeAt(i))) {
      if (s.charCodeAt(i) === 10) nl = true
      i++
    }
    parts.push(nl ? '\n' : ' ')
    map[n++] = nl ? s.indexOf('\n', st) : st
    run = i
  }
  if (s.length > run) {
    parts.push(s.slice(run))
    for (let k = run; k < s.length; k++) map[n++] = k
  }
  map[n] = s.length
  return { text: parts.join(''), map: map.subarray(0, n + 1) }
}

// ─── ABI ─────────────────────────────────────────────────────────────────────

interface AbiItem {
  type?: unknown
  name?: unknown
  inputs?: unknown
  stateMutability?: unknown
  constant?: unknown
  payable?: unknown
}

function canon(p: { type?: unknown; components?: unknown }, depth = 0): string {
  const t = typeof p?.type === 'string' ? p.type : '?'
  if (t.startsWith('tuple') && depth < 16) {
    const comps = Array.isArray(p.components) ? (p.components as { type?: unknown; components?: unknown }[]) : []
    return `(${comps.map((c) => canon(c, depth + 1)).join(',')})${t.slice(5)}`
  }
  return t
}

export function sigOf(e: AbiItem): string {
  const ins = Array.isArray(e.inputs) ? (e.inputs as { type?: unknown; components?: unknown }[]) : []
  return `${typeof e.name === 'string' ? e.name : ''}(${ins.map((p) => canon(p)).join(',')})`
}

/** ABI functions by mutability, in ABI order (legacy `constant` / `payable` flags honored). */
export function groupAbi(abi: unknown): { write: string[]; payable: string[]; view: string[]; events: string[] } {
  const out = { write: [] as string[], payable: [] as string[], view: [] as string[], events: [] as string[] }
  if (!Array.isArray(abi)) return out
  const seen = new Set<string>()
  for (const e of abi as AbiItem[]) {
    if (!e || typeof e !== 'object' || typeof e.name !== 'string' || !e.name) continue
    const s = sigOf(e)
    if (e.type === 'event') {
      if (!seen.has(`e:${s}`)) out.events.push(s)
      seen.add(`e:${s}`)
      continue
    }
    if (e.type !== 'function' || seen.has(s)) continue
    seen.add(s)
    const m = typeof e.stateMutability === 'string' ? e.stateMutability : e.constant === true ? 'view' : e.payable === true ? 'payable' : 'nonpayable'
    if (m === 'view' || m === 'pure') out.view.push(s)
    else if (m === 'payable') out.payable.push(s)
    else out.write.push(s)
  }
  return out
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const LIB_PATH = /openzeppelin|(^|\/)(@?solmate|@?solady|forge-std|ds-test)(\/|$)/i

function lineAt(starts: number[], idx: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= idx) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function lineStarts(s: string): number[] {
  const out = [0]
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1)
  return out
}

/** Index after the block that opens at `open` ('{'), or -1. */
function blockEnd(s: string, open: number, w: Work): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 123) depth++
    else if (c === 125) {
      depth--
      if (depth === 0) {
        w.spend(i + 1 - open)
        return i + 1
      }
    }
  }
  w.spend(s.length - open)
  return -1
}

/** Index after the parenthesized group that opens at `open` ('('), or -1. */
function parenEnd(s: string, open: number, w?: Work): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 40) depth++
    else if (c === 41) {
      depth--
      if (depth === 0) {
        w?.spend(i + 1 - open)
        return i + 1
      }
    }
  }
  w?.spend(s.length - open)
  return -1
}

// Every pattern below runs on whitespace-compacted text (compactWs), so `\s?` stands for any run of
// whitespace, and every other repetition is bounded: nothing can backtrack over a long run.
const SENDER = String.raw`(?:msg\.sender|_msgSender\(\s?\))`
const OPERAND = String.raw`(?:address|payable)?\s?\(?\s?[A-Za-z_$][\w$]{0,63}(?:\s?\.\s?[A-Za-z_$][\w$]{0,63}){0,6}(?:\s?\([^()]{0,120}\))?\s?\)?`
/**
 * Caller checks in a body. Comparisons keep their other operand (group `rhs` / `lhs`): a comparison
 * with a parameter or local of the function itself (`msg.sender != from`) is a user's own permission,
 * not a privileged role, and is skipped by authAt(). The `lhs` form only starts at a token boundary.
 */
const AUTH_RE = new RegExp(
  [
    String.raw`${SENDER}\s?[!=]=\s?(?<rhs>${OPERAND})`,
    String.raw`(?<![\w$.])(?<lhs>${OPERAND})\s?[!=]=\s?${SENDER}`,
    String.raw`\b(?:require|assert|if)\s?\(\s?!?\s?[A-Za-z_$][\w$]{0,63}(?:\.[A-Za-z_$][\w$]{0,63}){0,6}\s?\[\s?${SENDER}\s?\]\s?(?:==|!=|\)|,|&&|\|\|)`,
    String.raw`\b_?check(?:Owner|Role|Admin|Auth|Authorized|Caller|Sender|Governance|Guardian|Operator)\w{0,40}\s?\(`,
    String.raw`\b_?(?:onlyOwner|onlyAdmin|requireOwner|requireAdmin|authorize|auth)\s?\(`,
    String.raw`\bhasRole\s?\([^;]{0,240}?${SENDER}`,
    String.raw`\bisAuthorized\s?\(\s?${SENDER}`,
    String.raw`\bcanCall\s?\(\s?${SENDER}`,
  ].join('|'),
  'g',
)
/** Modifier names that are access control by name (used when their definition is not in the bundle). */
const AUTH_NAME = /^(only[A-Z_]\w*|auth|requiresAuth|ifAdmin|isAuthorized|authorized|restricted|onlyRole)$/
/** Internal helpers whose name says they check the caller (`_auth`, `_checkOwner`, `_onlyGovernance`, `_requireCallerIsAdmin`…). */
const HELPER_NAME = /^_*(auth|authorize\w*|only\w+|check\w*(owner|admin|role|auth|caller|sender|governance|guardian|operator|permission|access)\w*|require\w*(owner|admin|role|auth|caller|sender|governance|guardian|operator)\w*|assert\w*(owner|admin|role|caller|sender)\w*|ensure\w*(owner|admin|role|caller|sender)\w*)$/i

/** Names declared in a parameter list ('address from, uint256[] memory ids' → from, ids). */
function paramNames(list: string): Set<string> {
  const out = new Set<string>()
  let depth = 0
  let cur = ''
  for (const c of `${list},`) {
    if (c === '(') depth++
    else if (c === ')') depth--
    if (c === ',' && depth === 0) {
      // the trailing identifier of a declaration with at least two tokens (no regex: linear on any input)
      const t = cur.trim()
      let k = t.length
      while (k > 0 && /[\w$]/.test(t[k - 1])) k--
      if (k < t.length && /[A-Za-z_$]/.test(t[k]) && /\s/.test(t)) out.add(t.slice(k))
      cur = ''
    } else cur += c
  }
  return out
}

/** Locals declared in a body ('address owner_ = …', '(uint a, address b) = …'). Body is whitespace-compacted. */
function localNames(body: string): Set<string> {
  const out = new Set<string>()
  const re = /\b(?:address|bool|bytes\d{0,2}|u?int\d{0,3}|string|[A-Z][\w$]{0,63})(?:\s?\[\s?\d{0,10}\s?\])?\s(?:memory\s|storage\s|calldata\s|payable\s)?([a-z_$][\w$]{0,63})\s?[=;,)]/g
  for (let m = re.exec(body); m; m = re.exec(body)) out.add(m[1])
  return out
}

const operandBase = (op: string): string => {
  let s = op.trim()
  for (let i = 0; i < 3; i++) {
    const w = /^(?:address|payable)\s*\(\s*([\s\S]*)\)$/.exec(s)
    if (!w) break
    s = w[1].trim()
  }
  s = s.replace(/^\(\s*/, '')
  return /^[A-Za-z_$][\w$]*/.exec(s)?.[0] ?? ''
}

/** First caller check in a body that is not against the function's own parameters / locals, or null. */
function authAt(body: string, own: Set<string>, w: Work): number | null {
  w.spend(body.length * 4)
  AUTH_RE.lastIndex = 0
  for (let m = AUTH_RE.exec(body); m; m = AUTH_RE.exec(body)) {
    const op = m.groups?.rhs ?? m.groups?.lhs
    if (op !== undefined) {
      const base = operandBase(op)
      if (!base || own.has(base) || base === 'tx' || base === 'msg' || /^(0x0*|0)$/.test(base)) continue
    }
    return m.index
  }
  return null
}

interface FnDef {
  name: string
  file: string
  line: number
  header: string
  params: Set<string>
  body: string
  bodyStart: number
  visible: boolean
  lib: boolean
}

interface FileScan {
  path: string
  /** comment-free, whitespace-compacted text */
  code: string
  /** line (1-based, in the verified file) of an index in `code` */
  lineOf: (i: number) => number
  fns: FnDef[]
  modifiers: { name: string; body: string; params: Set<string> }[]
}

const FN_RE = /\bfunction\s([A-Za-z_$][\w$]{0,127})\s?\(/g
const MOD_RE = /\bmodifier\s([A-Za-z_$][\w$]{0,127})\s?(\(|\{)/g

/** Comment-free text of a Solidity / Yul file, whitespace-compacted, with its line map. */
function prepSolidity(text: string, w: Work): { code: string; lineOf: (i: number) => number } {
  w.spend(text.length * 3)
  const orig = stripSolidity(text, 'lines')
  const starts = lineStarts(orig)
  const { text: code, map } = compactWs(orig)
  return { code, lineOf: (i: number) => lineAt(starts, map[Math.max(0, Math.min(i, map.length - 1))]) }
}

function scanSolidity(f: SourceFile, w: Work): FileScan {
  const { code, lineOf } = prepSolidity(f.text, w)
  const lib = LIB_PATH.test(f.path)
  const fns: FnDef[] = []
  const modifiers: FileScan['modifiers'] = []
  MOD_RE.lastIndex = 0
  w.spend(code.length * 2)
  for (let m = MOD_RE.exec(code); m; m = MOD_RE.exec(code)) {
    let i = m.index + m[0].length - 1
    let params = new Set<string>()
    if (code[i] === '(') {
      const pe = parenEnd(code, i, w)
      if (pe < 0) continue
      params = paramNames(code.slice(i + 1, pe - 1))
      i = pe
    }
    const open = code.indexOf('{', i)
    const semi = code.indexOf(';', i)
    if (open < 0 || (semi >= 0 && semi < open)) continue
    const end = blockEnd(code, open, w)
    if (end < 0) continue
    const body = code.slice(open, end)
    w.spend(body.length * 2)
    for (const l of localNames(body)) params.add(l)
    modifiers.push({ name: m[1], body, params })
    MOD_RE.lastIndex = end
  }
  FN_RE.lastIndex = 0
  for (let m = FN_RE.exec(code); m; m = FN_RE.exec(code)) {
    const po = m.index + m[0].length - 1
    const pe = parenEnd(code, po, w)
    if (pe < 0) continue
    // header ends at the body '{' or a ';' (no body), whichever comes first outside parentheses
    let i = pe
    let depth = 0
    let open = -1
    for (; i < code.length; i++) {
      const c = code.charCodeAt(i)
      if (c === 40) depth++
      else if (c === 41) depth--
      else if (depth === 0 && c === 123) {
        open = i
        break
      } else if (depth === 0 && c === 59) break
    }
    w.spend(i - pe + 1)
    if (open < 0) {
      FN_RE.lastIndex = i + 1
      continue
    }
    const end = blockEnd(code, open, w)
    if (end < 0) continue
    const header = code.slice(pe, open)
    const body = code.slice(open, end)
    const params = paramNames(code.slice(po + 1, pe - 1))
    // named return values are locals too
    const ret = /\breturns\s?\(/.exec(header)
    if (ret) {
      const rs = header.indexOf('(', ret.index)
      const re = parenEnd(header, rs, w)
      if (re > rs) for (const n of paramNames(header.slice(rs + 1, re - 1))) params.add(n)
    }
    w.spend(body.length * 2 + header.length)
    for (const l of localNames(body)) params.add(l)
    fns.push({
      name: m[1],
      file: f.path,
      line: lineOf(m.index),
      header,
      params,
      body,
      bodyStart: open,
      visible: !/\b(internal|private)\b/.test(header),
      lib,
    })
    FN_RE.lastIndex = open + 1
  }
  return { path: f.path, code, lineOf, fns, modifiers }
}

/** Vyper: `def name(` blocks with their decorators; the body is the indented lines that follow. */
function scanVyper(f: SourceFile, w: Work): FnDef[] {
  w.spend(f.text.length * 3)
  const lines = f.text.replace(/\r\n?/g, '\n').split('\n')
  const out: FnDef[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^def\s+([A-Za-z_]\w*)\s*\(/.exec(lines[i])
    if (!m) continue
    const decos: string[] = []
    for (let k = i - 1; k >= 0 && /^@/.test(lines[k]); k--) decos.push(lines[k].trim())
    const body: string[] = []
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k].trim() && !/^\s/.test(lines[k])) break
      body.push(lines[k].replace(/#.*$/, ''))
    }
    out.push({
      name: m[1],
      file: f.path,
      line: i + 1,
      header: decos.join(' '),
      params: new Set(),
      body: body.join('\n'),
      bodyStart: 0,
      visible: decos.some((d) => /^@(external|public)\b/.test(d)),
      lib: false,
    })
  }
  return out
}

const VY_AUTH = /assert\s+(?:msg\.sender\s*(?:==|!=|in)\s*self\.|self\.[\w.]+\s*(?:==|!=)\s*msg\.sender|self\.\w+\[\s*msg\.sender\s*\])|\bself\._?(?:check|only)\w*\s*\(/

/** First line of a match inside a body, trimmed for display. */
function snippet(body: string, idx: number): string {
  const ls = body.lastIndexOf('\n', idx) + 1
  let le = body.indexOf('\n', idx)
  if (le < 0) le = body.length
  const s = body.slice(ls, le).trim().replace(/\s+/g, ' ')
  return s.length > 90 ? `${s.slice(0, 87)}…` : s
}

const paramCount = (sig: string) => {
  const inner = sig.slice(sig.indexOf('(') + 1, -1)
  if (!inner) return 0
  let depth = 0
  let n = 1
  for (const c of inner) {
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) n++
  }
  return n
}

const callRe = (name: string) => new RegExp(String.raw`(?<![\w$.])${name.replace(/\$/g, '\\$')}\s*\(`)

/**
 * ABI functions guarded in the verified source. `abiFns` are canonical signatures; a definition
 * matches by name (and by parameter count when the name is overloaded).
 */
export function findPrivileged(files: SourceFile[], abiFns: string[], w: Work = new Work()): LensPrivileged[] {
  const byName = new Map<string, string[]>()
  for (const s of abiFns) {
    const n = s.slice(0, s.indexOf('('))
    const l = byName.get(n) ?? []
    l.push(s)
    byName.set(n, l)
  }
  if (!byName.size) return []
  const sol = files.filter((f) => ['solidity', 'yul'].includes(langOfPath(f.path))).map((f) => scanSolidity(f, w))
  const vy = files.filter((f) => langOfPath(f.path) === 'vyper').flatMap((f) => scanVyper(f, w))

  // internal helpers named as caller checks that check the caller (one level)
  const authHelpers = new Set<string>()
  for (const s of sol) for (const f of s.fns) if (!f.visible && HELPER_NAME.test(f.name) && authAt(f.body, f.params, w) !== null) authHelpers.add(f.name)
  // modifiers that check the caller, directly or through such a helper
  const authMods = new Set<string>()
  const defined = new Set<string>()
  for (const s of sol)
    for (const m of s.modifiers) {
      defined.add(m.name)
      w.spend(m.body.length * (authHelpers.size + 1))
      if (authAt(m.body, m.params, w) !== null || [...authHelpers].some((h) => callRe(h).test(m.body))) authMods.add(m.name)
    }

  const found: (LensPrivileged & { lib: boolean })[] = []
  const take = (f: FnDef, guard: string, line: number, sigs: string[], params: number | null) => {
    const sig = (params !== null ? sigs.find((s) => paramCount(s) === params) : null) ?? sigs[0]
    found.push({ fn: sig, guard: guard.length > 90 ? `${guard.slice(0, 87)}…` : guard, file: f.file, line, lib: f.lib })
  }

  for (const s of sol) {
    for (const f of s.fns) {
      if (!f.visible) continue
      const sigs = byName.get(f.name)
      if (!sigs) continue
      const defStart = s.code.lastIndexOf('function', f.bodyStart)
      const po = s.code.indexOf('(', defStart)
      const pe = parenEnd(s.code, po, w)
      const inner = po >= 0 && pe > po ? s.code.slice(po + 1, pe - 1).trim() : ''
      const params = inner ? paramCount(`f(${inner})`) : 0
      // modifiers in the header
      let guarded = false
      const MODCALL = /\b([A-Za-z_$][\w$]{0,127})\s?(\([^)]{0,200}\))?/g
      w.spend(f.header.length * 2)
      for (let m = MODCALL.exec(f.header); m; m = MODCALL.exec(f.header)) {
        const nm = m[1]
        if (/^(public|external|internal|private|view|pure|payable|virtual|override|returns|memory|calldata|storage|constant)$/.test(nm)) {
          if (nm === 'returns' || nm === 'override') {
            const after = f.header.indexOf('(', m.index)
            if (after >= 0 && after - m.index - nm.length < 3) MODCALL.lastIndex = Math.max(MODCALL.lastIndex, parenEnd(f.header, after, w))
          }
          continue
        }
        if (authMods.has(nm) || (!defined.has(nm) && AUTH_NAME.test(nm))) {
          take(f, `${nm}${m[2] ? m[2].replace(/\s+/g, ' ') : ''}`, f.line, sigs, params)
          guarded = true
          break
        }
      }
      if (guarded) continue
      const at = authAt(f.body, f.params, w)
      if (at !== null) {
        take(f, snippet(f.body, at), s.lineOf(f.bodyStart + at), sigs, params)
        continue
      }
      w.spend(f.body.length * authHelpers.size)
      for (const h of authHelpers) {
        const hm = callRe(h).exec(f.body)
        if (hm) {
          take(f, `${h}(…)`, s.lineOf(f.bodyStart + hm.index), sigs, params)
          break
        }
      }
    }
  }
  for (const f of vy) {
    if (!f.visible) continue
    const sigs = byName.get(f.name)
    if (!sigs) continue
    const m = VY_AUTH.exec(f.body)
    if (!m) continue
    const before = f.body.slice(0, m.index).split('\n').length
    take(f, snippet(f.body, m.index), f.line + before, sigs, null)
  }
  // one row per ABI function: the author's definition first, then library code
  found.sort((a, b) => Number(a.lib) - Number(b.lib) || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
  const seen = new Set<string>()
  const out: LensPrivileged[] = []
  for (const f of found) {
    if (seen.has(f.fn)) continue
    seen.add(f.fn)
    out.push({ fn: f.fn, guard: f.guard, file: f.file, line: f.line })
  }
  return out.sort((a, b) => (a.fn < b.fn ? -1 : a.fn > b.fn ? 1 : 0))
}

// ─── primitives ──────────────────────────────────────────────────────────────

interface PrimRule {
  name: string
  group: PrimitiveGroup
  /** a use in the source (literal prefix, bounded: linear on any input) */
  re?: RegExp
  /** or a call to this precompile address: staticcall / call with it as the address argument */
  precompile?: number
  langs: ('solidity' | 'vyper')[]
}

export const PRIM_RULES: PrimRule[] = [
  { name: 'Keccak-256 (keccak256)', group: 'hash', re: /\bkeccak256\s?\(/g, langs: ['solidity', 'vyper'] },
  { name: 'SHA-256 (sha256, precompile 0x02)', group: 'hash', re: /\bsha256\s?\(/g, langs: ['solidity', 'vyper'] },
  { name: 'RIPEMD-160 (ripemd160, precompile 0x03)', group: 'hash', re: /\bripemd160\s?\(/g, langs: ['solidity'] },
  { name: 'ecrecover (secp256k1, precompile 0x01)', group: 'signature', re: /\becrecover\s?\(/g, langs: ['solidity', 'vyper'] },
  { name: 'ECDSA signature recovery (ECDSA.recover)', group: 'signature', re: /\bECDSA\s?\.\s?(?:try)?[Rr]ecover\w{0,40}\s?\(/g, langs: ['solidity'] },
  { name: 'EIP-1271 contract signatures (isValidSignature)', group: 'signature', re: /\bisValidSignature(?:Now)?\s?\(/g, langs: ['solidity'] },
  { name: 'EIP-712 typed-data hashing', group: 'signature', re: /\b_hashTypedDataV4\s?\(|\btoTypedDataHash\s?\(|\bhashTypedData\s?\(/g, langs: ['solidity'] },
  { name: 'Merkle proof verification', group: 'hash', re: /\bMerkleProof(?:Lib)?\s?\.\s?(?:verify|verifyCalldata|multiProofVerify|processProof)\w{0,40}\s?\(/g, langs: ['solidity'] },
  { name: 'modexp (precompile 0x05)', group: 'zk', precompile: 0x05, langs: ['solidity'] },
  { name: 'BN254 point addition (precompile 0x06)', group: 'zk', precompile: 0x06, langs: ['solidity'] },
  { name: 'BN254 scalar multiplication (precompile 0x07)', group: 'zk', precompile: 0x07, langs: ['solidity'] },
  { name: 'BN254 pairing check (precompile 0x08)', group: 'zk', precompile: 0x08, langs: ['solidity'] },
  { name: 'BLAKE2b compression F (precompile 0x09)', group: 'hash', precompile: 0x09, langs: ['solidity'] },
  { name: 'KZG point evaluation (EIP-4844, precompile 0x0a)', group: 'zk', precompile: 0x0a, langs: ['solidity'] },
  { name: 'P-256 signature verification (RIP-7212, precompile 0x100)', group: 'signature', precompile: 0x100, langs: ['solidity'] },
  { name: 'BN254 ecadd / ecmul (Vyper builtins)', group: 'zk', re: /\bec(?:add|mul)\s*\(/g, langs: ['vyper'] },
]

const MAX_CITES = 4
const CALL_RE = /\b(?:staticcall|call)\s?\(/g
const ADDR_CALL_RE = /\baddress\s?\(\s?(0x[0-9a-fA-F]{1,64}|\d{1,6})\s?\)\s?\.\s?staticcall\b/g

/** A numeric literal (hex or decimal), or null. */
function literal(s: string): number | null {
  const t = s.trim()
  if (/^0x[0-9a-fA-F]{1,64}$/.test(t)) {
    const v = t.replace(/^0x0*/, '')
    return v.length > 6 ? null : v ? parseInt(v, 16) : 0
  }
  return /^\d{1,6}$/.test(t) ? Number(t) : null
}

/** Second argument of the call whose '(' is at `open`, read at most 400 characters ahead; null if not found. */
function secondArg(code: string, open: number): string | null {
  let depth = 0
  let start = -1
  const end = Math.min(code.length, open + 400)
  for (let i = open; i < end; i++) {
    const c = code.charCodeAt(i)
    if (c === 40) depth++
    else if (c === 41) {
      depth--
      if (depth === 0) return start >= 0 ? code.slice(start, i) : null
    } else if (c === 44 && depth === 1) {
      if (start < 0) start = i + 1
      else return code.slice(start, i)
    }
  }
  return null
}

/** Primitives used in the sources, with up to 4 citations each (the author's files before library files). */
export function findPrimitives(files: SourceFile[], w: Work = new Work()): LensPrimitive[] {
  const hits = new Map<string, { rule: PrimRule; at: { file: string; line: number; lib: boolean }[]; count: number }>()
  const byAddr = new Map(PRIM_RULES.filter((r) => r.precompile !== undefined).map((r) => [r.precompile!, r]))
  const hit = (rule: PrimRule, file: string, line: number, lib: boolean) => {
    const h = hits.get(rule.name) ?? { rule, at: [], count: 0 }
    h.count++
    // up to MAX_CITES of the author's files and of library files each; the author's are listed first
    if (h.at.reduce((n, x) => n + (x.lib === lib ? 1 : 0), 0) < MAX_CITES) h.at.push({ file, line, lib })
    hits.set(rule.name, h)
  }
  for (const f of files) {
    const lang = langOfPath(f.path)
    if (lang !== 'solidity' && lang !== 'vyper' && lang !== 'yul') continue
    let code: string
    let lineOf: (i: number) => number
    if (lang === 'vyper') {
      w.spend(f.text.length * 2)
      code = f.text.replace(/\r\n?/g, '\n').replace(/#[^\n]*/g, '')
      const starts = lineStarts(code)
      lineOf = (i) => lineAt(starts, i)
    } else ({ code, lineOf } = prepSolidity(f.text, w))
    const lib = LIB_PATH.test(f.path)
    const l = lang === 'yul' ? 'solidity' : lang
    for (const rule of PRIM_RULES) {
      if (!rule.re || !rule.langs.includes(l)) continue
      w.spend(code.length)
      rule.re.lastIndex = 0
      for (let m = rule.re.exec(code); m; m = rule.re.exec(code)) {
        if (m[0].length === 0) rule.re.lastIndex++
        // a declaration ('function isValidSignature(…)' in an interface) is not a use
        if (/\b(function|event|error)\s+$/.test(code.slice(Math.max(0, m.index - 24), m.index))) continue
        hit(rule, f.path, lineOf(m.index), lib)
      }
    }
    if (l !== 'solidity') continue
    // precompile calls: Yul staticcall(gas(), 0x08, …) / call(…, 0x05, …), and address(0x05).staticcall(…)
    w.spend(code.length * 2)
    CALL_RE.lastIndex = 0
    for (let m = CALL_RE.exec(code); m; m = CALL_RE.exec(code)) {
      w.spend(400)
      const a = secondArg(code, m.index + m[0].length - 1)
      const v = a === null ? null : literal(a)
      const rule = v === null ? undefined : byAddr.get(v)
      if (rule) hit(rule, f.path, lineOf(m.index), lib)
    }
    ADDR_CALL_RE.lastIndex = 0
    for (let m = ADDR_CALL_RE.exec(code); m; m = ADDR_CALL_RE.exec(code)) {
      const v = literal(m[1])
      const rule = v === null ? undefined : byAddr.get(v)
      if (rule) hit(rule, f.path, lineOf(m.index), lib)
    }
  }
  const out: LensPrimitive[] = []
  for (const r of PRIM_RULES) {
    const h = hits.get(r.name)
    if (!h) continue
    const at = h.at.sort((a, b) => Number(a.lib) - Number(b.lib)).slice(0, MAX_CITES).map(({ file, line }) => ({ file, line }))
    out.push({ name: r.name, group: r.group, via: 'source', at, count: h.count })
  }
  return out
}
