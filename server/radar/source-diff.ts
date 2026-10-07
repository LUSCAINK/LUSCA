// Source diff of two verified source sets (Solidity / Vyper): unified diff of the changed files and the
// functions they touch, access checks flagged. Pure: no I/O.

import type { DiffFile, DiffFunction, DiffHunk, DiffLine } from '../../shared/radarDiff.ts'

export type SourceSet = Record<string, string>

export const DIFF_MAX_BYTES = 200_000
const CONTEXT = 3
/** Edit distance past which a file is shown as replaced (Myers is O(N·D)). */
const MAX_D = 6000

const normEol = (s: string) => s.replace(/\r\n?/g, '\n')
const splitLines = (s: string): string[] => {
  const t = normEol(s)
  const out = t.split('\n')
  if (out.length > 1 && out[out.length - 1] === '') out.pop()
  return out
}

// ── access checks ──
const AC_RE =
  /\bonly[A-Z_][\w$]*|\brequiresAuth\b|msg\.sender\s*[!=]=|[!=]=\s*msg\.sender\b|_msgSender\(\)\s*[!=]=|[!=]=\s*_msgSender\(\)|\b_checkOwner\s*\(|\b_checkRole\s*\(|\b_onlyOwner\s*\(|\bhasRole\s*\(|\bisAuthorized\s*\(|\b_authorizeUpgrade\b/
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/
/** The line holds an access check (comments excluded). */
export function isAccessLine(s: string): boolean {
  if (COMMENT_LINE.test(s)) return false
  const code = s.replace(/\/\/.*$/, '')
  return AC_RE.test(code)
}

// ── line diff (Myers) ──
type Op = { t: ' ' | '+' | '-'; o: number; n: number } // 0-based indexes; -1 when absent

export function diffLines(a: string[], b: string[]): Op[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  const mid = myers(A, B)
  const ops: Op[] = []
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', o: i, n: i })
  for (const m of mid) ops.push({ t: m.t, o: m.o < 0 ? -1 : m.o + pre, n: m.n < 0 ? -1 : m.n + pre })
  for (let i = 0; i < suf; i++) ops.push({ t: ' ', o: a.length - suf + i, n: b.length - suf + i })
  return ops
}

function myers(a: string[], b: string[]): Op[] {
  const N = a.length
  const M = b.length
  if (N === 0) return b.map((_, j) => ({ t: '+' as const, o: -1, n: j }))
  if (M === 0) return a.map((_, i) => ({ t: '-' as const, o: i, n: -1 }))
  const max = Math.min(N + M, MAX_D)
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < N && y < M && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= N && y >= M) {
        found = d
        break
      }
    }
    if (found >= 0) break
  }
  if (found < 0) {
    // too far apart: replaced
    return [...a.map((_, i) => ({ t: '-' as const, o: i, n: -1 })), ...b.map((_, j) => ({ t: '+' as const, o: -1, n: j }))]
  }
  const ops: Op[] = []
  let x = N
  let y = M
  for (let d = found; d > 0; d--) {
    const vv = trace[d]
    const k = x - y
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1
    const px = vv[off + prevK]
    const py = px - prevK
    while (x > px && y > py) {
      x--
      y--
      ops.push({ t: ' ', o: x, n: y })
    }
    if (x === px) {
      y--
      ops.push({ t: '+', o: -1, n: y })
    } else {
      x--
      ops.push({ t: '-', o: x, n: -1 })
    }
  }
  while (x > 0 && y > 0) {
    x--
    y--
    ops.push({ t: ' ', o: x, n: y })
  }
  return ops.reverse()
}

// ── Solidity structure ──
/** Same length, same newlines: comments blanked (and string literals too when `strings`). */
export function maskSource(src: string, strings: boolean): string {
  const out = src.split('')
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' '
    } else if (c === '/' && d === '*') {
      out[i++] = ' '
      out[i++] = ' '
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' '
        i++
      }
      if (i < n) {
        out[i++] = ' '
        out[i++] = ' '
      }
    } else if (c === '"' || c === "'") {
      const q = c
      i++
      while (i < n && src[i] !== q && src[i] !== '\n') {
        if (src[i] === '\\') {
          if (strings) out[i] = ' '
          i++
        }
        if (strings && i < n && src[i] !== '\n') out[i] = ' '
        i++
      }
      i++
    } else i++
  }
  return out.join('')
}

export interface SolFn {
  key: string
  sig: string
  kind: DiffFunction['kind']
  contract: string | null
  line: number
  endLine: number
  /** Header + body, comments removed, whitespace collapsed (what "modified" compares). */
  text: string
  access: string | null
}

const DROP_WORDS = new Set(['memory', 'calldata', 'storage', 'indexed'])
function paramTypes(params: string): string {
  if (!params.trim()) return ''
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of params) {
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  return parts
    .map((p) => {
      const toks = p.trim().split(/\s+/).filter((t) => t && !DROP_WORDS.has(t))
      if (toks.length > 1 && /^[A-Za-z_$][\w$]*$/.test(toks[toks.length - 1]) && toks[toks.length - 1] !== 'payable') toks.pop()
      return toks.join(' ').replace(/\s*payable$/, '')
    })
    .join(',')
}

const lineAt = (starts: number[], pos: number) => {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

const ACCESS_MOD = /\b(only[A-Z_][\w$]*(?:\s*\([^)]*\))?|requiresAuth\b)/g

/** Functions, modifiers, constructors of one Solidity file, with their access checks. */
export function solFunctions(src0: string): SolFn[] {
  const src = normEol(src0)
  const noComments = maskSource(src, false)
  const mask = maskSource(src, true)
  const starts = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1)
  // contract spans
  const contracts: { name: string; at: number }[] = []
  for (const m of mask.matchAll(/\b(?:contract|library|interface)\s+([A-Za-z_$][\w$]*)/g)) contracts.push({ name: m[1], at: m.index ?? 0 })
  const contractAt = (pos: number) => {
    let c: string | null = null
    for (const x of contracts) if (x.at <= pos) c = x.name
    return c
  }
  const out: SolFn[] = []
  const re = /\b(function\s+([A-Za-z_$][\w$]*)|modifier\s+([A-Za-z_$][\w$]*)|constructor|fallback|receive)\s*\(/g
  for (const m of mask.matchAll(re)) {
    const at = m.index ?? 0
    const open = at + m[0].length - 1
    let depth = 0
    let close = -1
    for (let i = open; i < mask.length; i++) {
      if (mask[i] === '(') depth++
      else if (mask[i] === ')' && --depth === 0) {
        close = i
        break
      }
    }
    if (close < 0) continue
    // header to '{' or ';'
    let j = close + 1
    let pd = 0
    while (j < mask.length) {
      const ch = mask[j]
      if (ch === '(') pd++
      else if (ch === ')') pd--
      else if (pd === 0 && (ch === '{' || ch === ';')) break
      j++
    }
    let end = j
    if (mask[j] === '{') {
      let bd = 0
      for (let i = j; i < mask.length; i++) {
        if (mask[i] === '{') bd++
        else if (mask[i] === '}' && --bd === 0) {
          end = i
          break
        }
      }
    }
    const kind: DiffFunction['kind'] = m[2] ? 'function' : m[3] ? 'modifier' : (m[1] as 'constructor' | 'fallback' | 'receive')
    const name = m[2] ?? m[3] ?? m[1]
    const sig = `${name}(${paramTypes(mask.slice(open + 1, close))})`
    const contract = contractAt(at)
    const header = mask.slice(close + 1, j)
    let access: string | null = null
    const mods = [...header.matchAll(ACCESS_MOD)].map((x) => x[1].replace(/\s+/g, ' '))
    if (mods.length) access = mods.join(' ')
    if (!access && mask[j] === '{') {
      const bodyLines = src.slice(j, end + 1).split('\n').slice(0, 12)
      const hit = bodyLines.find((l) => isAccessLine(l))
      if (hit) access = hit.trim().replace(/\s+/g, ' ').slice(0, 80)
    }
    out.push({
      key: `${contract ?? ''}.${sig}`,
      sig,
      kind,
      contract,
      line: lineAt(starts, at),
      endLine: lineAt(starts, end),
      text: noComments.slice(at, end + 1).replace(/\s+/g, ' ').trim(),
      access,
    })
  }
  return out
}

// ── file pairing and the whole diff ──
const isSol = (p: string) => /\.sol$/i.test(p)
const base = (p: string) => p.split('/').pop() ?? p
/** Libraries after the protocol's own files. */
const libRank = (p: string) => (/(^|\/)(lib|node_modules|@openzeppelin|openzeppelin-contracts|forge-std|solmate|solady)(\/|-|@)/i.test(p) ? 1 : 0)

export interface SourceDiffResult {
  files: DiffFile[]
  functions: DiffFunction[]
  unchangedFiles: number
  totals: { files: number; add: number; del: number }
  truncated: string | null
}

/** `main`: the compiled contract's name; its file is listed first. */
export function diffSources(oldSet: SourceSet, newSet: SourceSet, maxBytes = DIFF_MAX_BYTES, main: string | null = null): SourceDiffResult {
  const oldPaths = Object.keys(oldSet)
  const newPaths = Object.keys(newSet)
  const oldNorm = new Map(oldPaths.map((p) => [p, normEol(oldSet[p])]))
  const newNorm = new Map(newPaths.map((p) => [p, normEol(newSet[p])]))
  const pairs: { oldPath: string | null; newPath: string | null }[] = []
  const usedOld = new Set<string>()
  let unchanged = 0
  for (const p of newPaths) {
    if (oldNorm.has(p)) {
      usedOld.add(p)
      if (oldNorm.get(p) === newNorm.get(p)) unchanged++
      else pairs.push({ oldPath: p, newPath: p })
    }
  }
  const restOld = oldPaths.filter((p) => !usedOld.has(p))
  const restNew = newPaths.filter((p) => !oldNorm.has(p))
  // moved files (another import path, a library version in the path): same file name, the longest
  // common path suffix first
  const seg = (p: string) => p.split('/')
  const suffix = (x: string, y: string) => {
    const a = seg(x)
    const b = seg(y)
    let k = 0
    while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++
    return k
  }
  const cands: { o: string; n: string; score: number }[] = []
  for (const n of restNew) for (const op of restOld) if (base(op) === base(n)) cands.push({ o: op, n, score: suffix(op, n) })
  cands.sort((x, y) => y.score - x.score || x.n.localeCompare(y.n))
  const pairedNew = new Set<string>()
  for (const c of cands) {
    if (usedOld.has(c.o) || pairedNew.has(c.n)) continue
    usedOld.add(c.o)
    pairedNew.add(c.n)
    if (oldNorm.get(c.o) === newNorm.get(c.n)) unchanged++
    else pairs.push({ oldPath: c.o, newPath: c.n })
  }
  for (const p of restNew) if (!pairedNew.has(p)) pairs.push({ oldPath: null, newPath: p })
  for (const p of restOld) if (!usedOld.has(p)) pairs.push({ oldPath: p, newPath: null })
  pairs.sort((x, y) => {
    const px = (x.newPath ?? x.oldPath) as string
    const py = (y.newPath ?? y.oldPath) as string
    const mx = main && base(px) === `${main}.sol` ? 0 : 1
    const my = main && base(py) === `${main}.sol` ? 0 : 1
    return mx - my || libRank(px) - libRank(py) || (x.oldPath && x.newPath ? 0 : 1) - (y.oldPath && y.newPath ? 0 : 1) || px.localeCompare(py)
  })

  let bytes = 0
  let cutFiles = 0
  let totalAdd = 0
  let totalDel = 0
  const files: DiffFile[] = []
  const oldFns: { fn: SolFn; file: string; fileId: string }[] = []
  const newFns: { fn: SolFn; file: string; fileId: string }[] = []
  pairs.forEach((pr, fi) => {
    const id = `f${fi + 1}`
    const a = pr.oldPath ? splitLines(oldNorm.get(pr.oldPath) as string) : []
    const b = pr.newPath ? splitLines(newNorm.get(pr.newPath) as string) : []
    const ops = diffLines(a, b)
    const add = ops.filter((x) => x.t === '+').length
    const del = ops.filter((x) => x.t === '-').length
    totalAdd += add
    totalDel += del
    const path = (pr.newPath ?? pr.oldPath) as string
    const nf = pr.newPath && isSol(pr.newPath) ? solFunctions(newNorm.get(pr.newPath) as string) : []
    const of = pr.oldPath && isSol(pr.oldPath) ? solFunctions(oldNorm.get(pr.oldPath) as string) : []
    for (const fn of nf) newFns.push({ fn, file: path, fileId: id })
    for (const fn of of) oldFns.push({ fn, file: pr.oldPath as string, fileId: id })
    const ctxOf = (newLine: number | null, oldLine: number | null): string | null => {
      const inFn = (list: SolFn[], ln: number | null) => (ln == null ? undefined : list.filter((f) => f.line <= ln && f.endLine >= ln && f.kind !== 'modifier').pop() ?? list.filter((f) => f.line <= ln && f.endLine >= ln).pop())
      const f = inFn(nf, newLine) ?? inFn(of, oldLine)
      return f ? `${f.contract ? `${f.contract}.` : ''}${f.sig}` : null
    }
    // hunks
    const hunks: DiffHunk[] = []
    const changed: number[] = []
    ops.forEach((op, i) => op.t !== ' ' && changed.push(i))
    let k = 0
    while (k < changed.length) {
      const s = Math.max(0, changed[k] - CONTEXT)
      let e = Math.min(ops.length - 1, changed[k] + CONTEXT)
      while (k + 1 < changed.length && changed[k + 1] - CONTEXT <= e + 1) {
        k++
        e = Math.min(ops.length - 1, changed[k] + CONTEXT)
      }
      k++
      const lines: DiffLine[] = []
      let firstO: number | null = null
      let firstN: number | null = null
      let oc = 0
      let nc = 0
      let firstChange: { o: number | null; n: number | null } | null = null
      for (let i = s; i <= e; i++) {
        const op = ops[i]
        const s2 = op.t === '-' ? a[op.o] : b[op.n]
        const l: DiffLine = { t: op.t, o: op.o >= 0 ? op.o + 1 : null, n: op.n >= 0 ? op.n + 1 : null, s: s2.length > 400 ? `${s2.slice(0, 400)}…` : s2 }
        if (isAccessLine(s2)) l.ac = 1
        if (op.o >= 0) {
          oc++
          if (firstO == null) firstO = op.o + 1
        }
        if (op.n >= 0) {
          nc++
          if (firstN == null) firstN = op.n + 1
        }
        if (op.t !== ' ' && !firstChange) firstChange = { o: l.o, n: l.n }
        lines.push(l)
      }
      hunks.push({
        id: `${id}h${hunks.length + 1}`,
        oldStart: firstO ?? 0,
        oldLines: oc,
        newStart: firstN ?? 0,
        newLines: nc,
        ctx: firstChange ? ctxOf(firstChange.n ?? null, firstChange.o ?? null) : null,
        lines,
      })
    }
    // size bound
    const kept: DiffHunk[] = []
    let omittedH = 0
    let omittedL = 0
    for (const h of hunks) {
      const sz = h.lines.reduce((acc, l) => acc + l.s.length + 28, 80)
      if (bytes + sz > maxBytes) {
        omittedH++
        omittedL += h.lines.length
        continue
      }
      bytes += sz
      kept.push(h)
    }
    if (omittedH) cutFiles++
    files.push({
      id,
      path,
      oldPath: pr.oldPath && pr.newPath && pr.oldPath !== pr.newPath ? pr.oldPath : null,
      status: pr.oldPath && pr.newPath ? 'modified' : pr.newPath ? 'added' : 'removed',
      add,
      del,
      hunks: kept,
      omitted: omittedH ? { hunks: omittedH, lines: omittedL } : null,
    })
  })

  // functions: compared by contract + signature across the changed files
  const oldBy = new Map(oldFns.map((x) => [x.fn.key, x]))
  const newBy = new Map(newFns.map((x) => [x.fn.key, x]))
  const hunkFor = (fileId: string, side: 'o' | 'n', from: number, to: number): string | null => {
    const f = files.find((x) => x.id === fileId)
    if (!f) return null
    for (const h of f.hunks) for (const l of h.lines) if (l.t !== ' ' && (side === 'n' ? l.n : l.o) != null) {
      const ln = (side === 'n' ? l.n : l.o) as number
      if (ln >= from && ln <= to) return h.id
    }
    return null
  }
  const functions: DiffFunction[] = []
  for (const [key, x] of newBy) {
    const prev = oldBy.get(key)
    if (prev && prev.fn.text === x.fn.text) continue
    const change = prev ? 'modified' : 'added'
    const fd: DiffFunction = {
      sig: x.fn.sig,
      kind: x.fn.kind,
      change,
      at: `${base(x.file)}:${x.fn.line}`,
      file: x.file,
      line: x.fn.line,
      access: x.fn.access,
      hunk: hunkFor(x.fileId, 'n', x.fn.line, x.fn.endLine),
    }
    if (prev && prev.fn.access !== x.fn.access) fd.accessBefore = prev.fn.access
    functions.push(fd)
  }
  for (const [key, x] of oldBy) {
    if (newBy.has(key)) continue
    functions.push({
      sig: x.fn.sig,
      kind: x.fn.kind,
      change: 'removed',
      at: `${base(x.file)}:${x.fn.line}`,
      file: x.file,
      line: x.fn.line,
      access: x.fn.access,
      hunk: hunkFor(x.fileId, 'o', x.fn.line, x.fn.endLine),
    })
  }
  const order = { added: 0, modified: 1, removed: 2 }
  const mainFirst = (f: DiffFunction) => (main && base(f.file) === `${main}.sol` ? 0 : 1)
  functions.sort((p, q) => order[p.change] - order[q.change] || mainFirst(p) - mainFirst(q) || (q.access ? 1 : 0) - (p.access ? 1 : 0) || libRank(p.file) - libRank(q.file) || p.file.localeCompare(q.file) || p.line - q.line)

  const omittedTotal = files.reduce((s, f) => s + (f.omitted?.lines ?? 0), 0)
  return {
    files,
    functions: functions.slice(0, 300),
    unchangedFiles: unchanged,
    totals: { files: files.length, add: totalAdd, del: totalDel },
    truncated: omittedTotal
      ? `Diff cut at ${Math.round(maxBytes / 1000)} KB: ${omittedTotal.toLocaleString('en-US')} lines in ${cutFiles} file${cutFiles === 1 ? '' : 's'} not shown. Counts above are complete.`
      : null,
  }
}
