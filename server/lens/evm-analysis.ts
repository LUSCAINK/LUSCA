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

import type { LensPrimitive, LensPrivileged, PrimitiveGroup } from '../../shared/lens.ts'
import { langOfPath, stripSolidity } from '../chain/evm-source.ts'

export interface SourceFile {
  path: string
  text: string
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
function blockEnd(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 123) depth++
    else if (c === 125) {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** Index after the parenthesized group that opens at `open` ('('), or -1. */
function parenEnd(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 40) depth++
    else if (c === 41) {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

const SENDER = String.raw`(?:msg\.sender|_msgSender\(\s*\))`
// bounded repetitions: the pattern is tried at every position of a body, so nothing in it may scan far
const OPERAND = String.raw`(?:address|payable)?\s*\(?\s*[A-Za-z_$][\w$]{0,63}(?:\s*\.\s*[A-Za-z_$][\w$]{0,63}){0,6}(?:\s*\([^()]{0,120}\))?\s*\)?`
/**
 * Caller checks in a body. Comparisons keep their other operand (group `rhs` / `lhs`): a comparison
 * with a parameter or local of the function itself (`msg.sender != from`) is a user's own permission,
 * not a privileged role, and is skipped by authAt().
 */
const AUTH_RE = new RegExp(
  [
    String.raw`${SENDER}\s*[!=]=\s*(?<rhs>${OPERAND})`,
    String.raw`(?<lhs>${OPERAND})\s*[!=]=\s*${SENDER}`,
    String.raw`\b(?:require|assert|if)\s*\(\s*!?\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\[\s*${SENDER}\s*\]\s*(?:==|!=|\)|,|&&|\|\|)`,
    String.raw`\b_?check(?:Owner|Role|Admin|Auth|Authorized|Caller|Sender|Governance|Guardian|Operator)\w*\s*\(`,
    String.raw`\b_?(?:onlyOwner|onlyAdmin|requireOwner|requireAdmin|authorize|auth)\s*\(`,
    String.raw`\bhasRole\s*\([^;]{0,240}${SENDER}`,
    String.raw`\bisAuthorized\s*\(\s*${SENDER}`,
    String.raw`\bcanCall\s*\(\s*${SENDER}`,
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
      const m = /([A-Za-z_$][\w$]*)\s*$/.exec(cur.trim())
      if (m && cur.trim().split(/\s+/).length > 1) out.add(m[1])
      cur = ''
    } else cur += c
  }
  return out
}

/** Locals declared in a body ('address owner_ = …', '(uint a, address b) = …'). */
function localNames(body: string): Set<string> {
  const out = new Set<string>()
  const re = /\b(?:address|bool|bytes\d*|u?int\d*|string|[A-Z][\w$]*)(?:\s*\[\s*\d*\s*\])?\s+(?:memory\s+|storage\s+|calldata\s+|payable\s+)?([a-z_$][\w$]*)\s*[=;,)]/g
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
function authAt(body: string, own: Set<string>): number | null {
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
  code: string
  starts: number[]
  fns: FnDef[]
  modifiers: { name: string; body: string; params: Set<string> }[]
}

const FN_RE = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g
const MOD_RE = /\bmodifier\s+([A-Za-z_$][\w$]*)\s*(\(|\{)/g

function scanSolidity(f: SourceFile): FileScan {
  const code = stripSolidity(f.text, 'lines')
  const starts = lineStarts(code)
  const lib = LIB_PATH.test(f.path)
  const fns: FnDef[] = []
  const modifiers: FileScan['modifiers'] = []
  MOD_RE.lastIndex = 0
  for (let m = MOD_RE.exec(code); m; m = MOD_RE.exec(code)) {
    let i = m.index + m[0].length - 1
    let params = new Set<string>()
    if (code[i] === '(') {
      const pe = parenEnd(code, i)
      if (pe < 0) continue
      params = paramNames(code.slice(i + 1, pe - 1))
      i = pe
    }
    const open = code.indexOf('{', i)
    const semi = code.indexOf(';', i)
    if (open < 0 || (semi >= 0 && semi < open)) continue
    const end = blockEnd(code, open)
    if (end < 0) continue
    const body = code.slice(open, end)
    for (const l of localNames(body)) params.add(l)
    modifiers.push({ name: m[1], body, params })
    MOD_RE.lastIndex = end
  }
  FN_RE.lastIndex = 0
  for (let m = FN_RE.exec(code); m; m = FN_RE.exec(code)) {
    const po = m.index + m[0].length - 1
    const pe = parenEnd(code, po)
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
    if (open < 0) {
      FN_RE.lastIndex = i + 1
      continue
    }
    const end = blockEnd(code, open)
    if (end < 0) continue
    const header = code.slice(pe, open)
    const body = code.slice(open, end)
    const params = paramNames(code.slice(po + 1, pe - 1))
    // named return values are locals too
    const ret = /\breturns\s*\(/.exec(header)
    if (ret) {
      const rs = header.indexOf('(', ret.index)
      const re = parenEnd(header, rs)
      if (re > rs) for (const n of paramNames(header.slice(rs + 1, re - 1))) params.add(n)
    }
    for (const l of localNames(body)) params.add(l)
    fns.push({
      name: m[1],
      file: f.path,
      line: lineAt(starts, m.index),
      header,
      params,
      body,
      bodyStart: open,
      visible: !/\b(internal|private)\b/.test(header),
      lib,
    })
    FN_RE.lastIndex = open + 1
  }
  return { path: f.path, code, starts, fns, modifiers }
}

/** Vyper: `def name(` blocks with their decorators; the body is the indented lines that follow. */
function scanVyper(f: SourceFile): FnDef[] {
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
export function findPrivileged(files: SourceFile[], abiFns: string[]): LensPrivileged[] {
  const byName = new Map<string, string[]>()
  for (const s of abiFns) {
    const n = s.slice(0, s.indexOf('('))
    const l = byName.get(n) ?? []
    l.push(s)
    byName.set(n, l)
  }
  if (!byName.size) return []
  const sol = files.filter((f) => ['solidity', 'yul'].includes(langOfPath(f.path))).map(scanSolidity)
  const vy = files.filter((f) => langOfPath(f.path) === 'vyper').flatMap(scanVyper)

  // internal helpers named as caller checks that check the caller (one level)
  const authHelpers = new Set<string>()
  for (const s of sol) for (const f of s.fns) if (!f.visible && HELPER_NAME.test(f.name) && authAt(f.body, f.params) !== null) authHelpers.add(f.name)
  // modifiers that check the caller, directly or through such a helper
  const authMods = new Set<string>()
  const defined = new Set<string>()
  for (const s of sol)
    for (const m of s.modifiers) {
      defined.add(m.name)
      if (authAt(m.body, m.params) !== null || [...authHelpers].some((h) => callRe(h).test(m.body))) authMods.add(m.name)
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
      const pe = parenEnd(s.code, po)
      const inner = po >= 0 && pe > po ? s.code.slice(po + 1, pe - 1).trim() : ''
      const params = inner ? paramCount(`f(${inner})`) : 0
      // modifiers in the header
      let guarded = false
      const MODCALL = /\b([A-Za-z_$][\w$]*)\s*(\([^)]*\))?/g
      for (let m = MODCALL.exec(f.header); m; m = MODCALL.exec(f.header)) {
        const nm = m[1]
        if (/^(public|external|internal|private|view|pure|payable|virtual|override|returns|memory|calldata|storage|constant)$/.test(nm)) {
          if (nm === 'returns' || nm === 'override') {
            const after = f.header.indexOf('(', m.index)
            if (after >= 0 && after - m.index - nm.length < 3) MODCALL.lastIndex = Math.max(MODCALL.lastIndex, parenEnd(f.header, after))
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
      const at = authAt(f.body, f.params)
      if (at !== null) {
        take(f, snippet(f.body, at), lineAt(s.starts, f.bodyStart + at), sigs, params)
        continue
      }
      for (const h of authHelpers) {
        const hm = callRe(h).exec(f.body)
        if (hm) {
          take(f, `${h}(…)`, lineAt(s.starts, f.bodyStart + hm.index), sigs, params)
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
  re: RegExp
  langs: ('solidity' | 'vyper')[]
}

const PRECOMPILE = (hex: string) => String.raw`(?:0x0*${hex}|${parseInt(hex, 16)})`
const STATICCALL_TO = (hex: string) =>
  new RegExp(String.raw`\b(?:staticcall|call)\s*\(\s*[^,()]*(?:\([^()]*\))?[^,()]*,\s*${PRECOMPILE(hex)}\s*,|\baddress\s*\(\s*${PRECOMPILE(hex)}\s*\)\s*\.\s*staticcall`, 'g')

export const PRIM_RULES: PrimRule[] = [
  { name: 'Keccak-256 (keccak256)', group: 'hash', re: /\bkeccak256\s*\(/g, langs: ['solidity', 'vyper'] },
  { name: 'SHA-256 (sha256, precompile 0x02)', group: 'hash', re: /\bsha256\s*\(/g, langs: ['solidity', 'vyper'] },
  { name: 'RIPEMD-160 (ripemd160, precompile 0x03)', group: 'hash', re: /\bripemd160\s*\(/g, langs: ['solidity'] },
  { name: 'ecrecover (secp256k1, precompile 0x01)', group: 'signature', re: /\becrecover\s*\(/g, langs: ['solidity', 'vyper'] },
  { name: 'ECDSA signature recovery (ECDSA.recover)', group: 'signature', re: /\bECDSA\s*\.\s*(?:try)?[Rr]ecover\w*\s*\(/g, langs: ['solidity'] },
  { name: 'EIP-1271 contract signatures (isValidSignature)', group: 'signature', re: /\bisValidSignature(?:Now)?\s*\(/g, langs: ['solidity'] },
  { name: 'EIP-712 typed-data hashing', group: 'signature', re: /\b_hashTypedDataV4\s*\(|\btoTypedDataHash\s*\(|\bhashTypedData\s*\(/g, langs: ['solidity'] },
  { name: 'Merkle proof verification', group: 'hash', re: /\bMerkleProof(?:Lib)?\s*\.\s*(?:verify|verifyCalldata|multiProofVerify|processProof)\w*\s*\(/g, langs: ['solidity'] },
  { name: 'modexp (precompile 0x05)', group: 'zk', re: STATICCALL_TO('05'), langs: ['solidity'] },
  { name: 'BN254 point addition (precompile 0x06)', group: 'zk', re: STATICCALL_TO('06'), langs: ['solidity'] },
  { name: 'BN254 scalar multiplication (precompile 0x07)', group: 'zk', re: STATICCALL_TO('07'), langs: ['solidity'] },
  { name: 'BN254 pairing check (precompile 0x08)', group: 'zk', re: STATICCALL_TO('08'), langs: ['solidity'] },
  { name: 'BLAKE2b compression F (precompile 0x09)', group: 'hash', re: STATICCALL_TO('09'), langs: ['solidity'] },
  { name: 'KZG point evaluation (EIP-4844, precompile 0x0a)', group: 'zk', re: STATICCALL_TO('0a'), langs: ['solidity'] },
  { name: 'P-256 signature verification (RIP-7212, precompile 0x100)', group: 'signature', re: STATICCALL_TO('100'), langs: ['solidity'] },
  { name: 'BN254 ecadd / ecmul (Vyper builtins)', group: 'zk', re: /\bec(?:add|mul)\s*\(/g, langs: ['vyper'] },
]

const MAX_CITES = 4

/** Primitives used in the sources, with up to 4 citations each (the author's files before library files). */
export function findPrimitives(files: SourceFile[]): LensPrimitive[] {
  const hits = new Map<string, { rule: PrimRule; at: { file: string; line: number; lib: boolean }[]; count: number }>()
  for (const f of files) {
    const lang = langOfPath(f.path)
    if (lang !== 'solidity' && lang !== 'vyper' && lang !== 'yul') continue
    const code = lang === 'vyper' ? f.text.replace(/\r\n?/g, '\n').replace(/#[^\n]*/g, '') : stripSolidity(f.text, 'lines')
    const starts = lineStarts(code)
    const lib = LIB_PATH.test(f.path)
    const l = lang === 'yul' ? 'solidity' : lang
    for (const rule of PRIM_RULES) {
      if (!rule.langs.includes(l)) continue
      rule.re.lastIndex = 0
      for (let m = rule.re.exec(code); m; m = rule.re.exec(code)) {
        if (m[0].length === 0) rule.re.lastIndex++
        // a declaration ('function isValidSignature(…)' in an interface) is not a use
        if (/\b(function|event|error)\s+$/.test(code.slice(Math.max(0, m.index - 24), m.index))) continue
        const h = hits.get(rule.name) ?? { rule, at: [], count: 0 }
        h.count++
        h.at.push({ file: f.path, line: lineAt(starts, m.index), lib })
        hits.set(rule.name, h)
      }
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
