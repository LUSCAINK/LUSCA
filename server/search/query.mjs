// @ts-check
// CODE SEARCH — query worker (worker_threads). Holds a view of the index (the builder's SharedArrayBuffer
// segments, shared without a copy, plus the file / item tables from its deltas) and runs one query at a time.
// The main thread terminates the worker when a query exceeds its hard time budget (a regex can backtrack for
// ever) and starts a fresh one: the index lives in shared memory, so a new worker is ready in milliseconds.
//
// In:  { type: 'delta', delta }  (applied in order)    { type: 'query', id, q }
// Out: { type: 'result', id, result }   { type: 'error', id, message }
import zlib from 'node:zlib'
import { parentPort } from 'node:worker_threads'
import { escapeRe, isLibPath, pathMatcher, requiredRuns, shownPath, sigBit, trigramsOf } from './common.mjs'

const port = /** @type {import('node:worker_threads').MessagePort} */ (parentPort)

/** @type {SharedArrayBuffer[]} */ const textSegs = []
/** @type {Int32Array[]} */ const sigSegs = []
/** @type {{ chain: string; address: string; name: string | null; readAt: number; files: Set<number> }[]} */ const items = []
/** @type {string[]} */ const paths = []
/** Library path (@openzeppelin, lib/, node_modules/ …) per path id: library status belongs to a (contract, path) reference, not to a file. */
/** @type {boolean[]} */ const pathLib = []
/** @type {{ id: number; seg: number; off: number; len: number; clen: number; sseg: number; soff: number; sbits: number; lg: number; lang: string; lines: number; ci: boolean; idl: boolean; refs: [number, number][] }[]} */
const files = []
let gen = 0

function apply(/** @type {any} */ d) {
  for (const s of d.segs) {
    if (s.kind === 'text') textSegs[s.idx] = s.sab
    else sigSegs[s.idx] = new Int32Array(s.sab)
  }
  for (const [id, p] of d.paths) {
    paths[id] = p
    pathLib[id] = isLibPath(p)
  }
  for (const it of d.items) {
    const cur = items[it.id]
    if (cur) {
      cur.name = it.name
      cur.readAt = it.readAt
    } else items[it.id] = { chain: it.chain, address: it.address, name: it.name, readAt: it.readAt, files: new Set() }
  }
  // only what a query needs (the content hash stays with the builder)
  for (const f of d.files) files[f.id] = { id: f.id, seg: f.seg, off: f.off, len: f.len, clen: f.clen, sseg: f.sseg, soff: f.soff, sbits: f.sbits, lg: Math.log2(f.sbits), lang: f.lang, lines: f.lines, ci: f.ci, idl: f.idl, refs: [] }
  for (const iid of d.drop) {
    const it = items[iid]
    if (!it) continue
    for (const fid of it.files) {
      const f = files[fid]
      if (f) f.refs = f.refs.filter((r) => r[0] !== iid)
    }
    it.files.clear()
  }
  for (const [fid, iid, pid] of d.refs) {
    const f = files[fid]
    const it = items[iid]
    if (!f || !it) continue
    f.refs.push([iid, pid])
    it.files.add(fid)
  }
  for (const fid of d.ci ?? []) if (files[fid]) files[fid].ci = true
  gen++
  matchCache.clear()
}

// ─── query ───────────────────────────────────────────────────────────────────

const NL = String.fromCharCode(10)
const MAX_COUNT = 20_000 // matching lines counted before the totals become lower bounds
const SOFT_MS = 900 // stop scanning (totals become lower bounds) past this; the main thread kills at its hard budget
const SHOW_HITS = 4 // matching lines shown per file
const CTX = 2
const LINE_MAX = 320
const PAGE_FILES = 10
const ALSO_IN = 8
const IDL_SHOW = 12
const IDL_ENTRIES = 6
const MATCH_CACHE = 8

/**
 * Per query (filters included): the matching files in result order, as typed arrays — file id, matching lines,
 * kept contracts in the filter — and the totals. Lines and snippets are recomputed for the page asked for,
 * so a query that matches 16 000 files keeps about 200 KB here, not the lines of every file.
 * @type {Map<string, { fids: Int32Array; counts: Int32Array; idlFids: Int32Array; idlCounts: Int32Array; total: any; scanned: any }>}
 */
const matchCache = new Map()


const decode = (/** @type {{ seg: number; off: number; clen: number }} */ f) => zlib.inflateRawSync(Buffer.from(textSegs[f.seg], f.off, f.clen)).toString('utf8')

/** Every file passes the signature test for all trigrams (no false negatives; rare false positives). */
function sigHas(/** @type {any} */ f, /** @type {number[]} */ tris) {
  if (!tris.length) return true
  const w = sigSegs[f.sseg]
  const base = f.soff >>> 2
  for (const t of tris) {
    const bit = sigBit(t, f.lg)
    if ((w[base + (bit >>> 5)] & (1 << (bit & 31))) === 0) return false
  }
  return true
}

/**
 * Matching lines of one string: count + the first `keep` lines with their match ranges.
 * @returns {{ count: number; lines: { n: number; hits: [number, number][] }[]; stopped: boolean }}
 */
function matchText(/** @type {string} */ s, /** @type {RegExp} */ rx, /** @type {number} */ keep, /** @type {number} */ budgetLeft, /** @type {number} */ deadline) {
  rx.lastIndex = 0
  let count = 0
  /** @type {{ n: number; hits: [number, number][]; more?: [number, number, number][] }[]} */
  const lines = []
  let line = 1
  let pos = 0 // scanned for '\n' up to here
  let lineStart = 0
  let lastLine = 0
  let m
  let k = 0
  while ((m = rx.exec(s))) {
    const at = m.index
    while (true) {
      const nl = s.indexOf(NL, pos)
      if (nl < 0 || nl >= at) break
      line++
      lineStart = nl + 1
      pos = nl + 1
    }
    if (line !== lastLine) {
      count++
      lastLine = line
      if (lines.length < keep) lines.push({ n: line, hits: [] })
    }
    const cur = lines.length && lines[lines.length - 1].n === line ? lines[lines.length - 1] : null
    if (cur && cur.hits.length < 8) {
      const lineEnd = s.indexOf(NL, at)
      const mEnd = at + Math.max(1, m[0].length)
      const end = Math.min(mEnd, lineEnd < 0 ? s.length : lineEnd)
      cur.hits.push([at - lineStart, Math.max(at - lineStart + 1, end - lineStart)])
      // a match that runs over several lines: highlight its continuation (up to 12 lines)
      if (lineEnd >= 0 && mEnd > lineEnd + 1) {
        let ls = lineEnd + 1
        for (let n = line + 1; ls < mEnd && n <= line + 12; n++) {
          const le = s.indexOf(NL, ls)
          const e = Math.min(mEnd, le < 0 ? s.length : le)
          let a = ls
          while (a < e && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++
          if (e > a) (cur.more ??= []).push([n, a - ls, e - ls])
          if (le < 0) break
          ls = le + 1
        }
      }
    }
    // standard non-overlapping matching (a regex may span lines; a match counts on the line where it starts)
    if (m[0].length === 0) rx.lastIndex = at + 1
    if (count >= budgetLeft) return { count, lines, stopped: true }
    if ((++k & 255) === 0 && Date.now() > deadline) return { count, lines, stopped: true }
  }
  return { count, lines, stopped: false }
}

/** A long line cut to a window around its first match, ranges shifted to the window. */
function windowLine(/** @type {string} */ text, /** @type {[number, number][]} */ hits) {
  if (text.length <= LINE_MAX) return { text, hits }
  const first = hits[0]?.[0] ?? 0
  const start = Math.max(0, Math.min(first - 80, text.length - LINE_MAX))
  const end = Math.min(text.length, start + LINE_MAX)
  const pre = start > 0 ? '…' : ''
  const out = pre + text.slice(start, end) + (end < text.length ? '…' : '')
  /** @type {[number, number][]} */
  const h = []
  for (const [a, b] of hits) {
    const x = Math.max(a, start)
    const y = Math.min(b, end)
    if (y > x) h.push([x - start + pre.length, y - start + pre.length])
  }
  return { text: out, hits: h }
}

/** Snippet blocks: each matching line with CTX lines around it, merged when they touch. */
function blocksOf(/** @type {string} */ s, /** @type {{ n: number; hits: [number, number][]; more?: [number, number, number][] }[]} */ hl) {
  const all = s.split(NL)
  /** @type {{ n: number; text: string; hits: [number, number][] }[][]} */
  const blocks = []
  /** @type {{ n: number; text: string; hits: [number, number][] }[] | null} */
  let cur = null
  let curEnd = 0
  /** @type {Map<number, [number, number][]>} */
  const hitAt = new Map()
  const add = (/** @type {number} */ n, /** @type {[number, number]} */ r) => {
    const a = hitAt.get(n)
    if (a) a.push(r)
    else hitAt.set(n, [r])
  }
  for (const h of hl) {
    for (const r of h.hits) add(h.n, r)
    for (const [n, a, b] of h.more ?? []) add(n, [a, b])
  }
  const row = (/** @type {number} */ n) => ({ n, ...windowLine(all[n - 1] ?? '', hitAt.get(n) ?? []) })
  for (const h of hl) {
    const last = h.more?.length ? h.more[h.more.length - 1][0] : h.n
    const from = Math.max(1, h.n - CTX)
    const to = Math.min(all.length, Math.max(h.n + CTX, last + 1))
    if (cur && from <= curEnd + 1) {
      for (let n = curEnd + 1; n <= to; n++) cur.push(row(n))
      curEnd = Math.max(curEnd, to)
    } else {
      cur = []
      for (let n = from; n <= to; n++) cur.push(row(n))
      curEnd = to
      blocks.push(cur)
    }
  }
  return blocks
}

const item = (/** @type {number} */ iid) => {
  const it = items[iid]
  return { chain: it.chain, address: it.address, name: it.name }
}
/** The contract a shared file is listed under: the most recently kept one (a named one first). */
const primaryOf = (/** @type {[number, number][]} */ refs) => {
  let best = refs[0]
  for (const r of refs) {
    const a = items[r[0]]
    const b = items[best[0]]
    if ((!!a.name && !b.name) || (!!a.name === !!b.name && a.readAt > b.readAt)) best = r
  }
  return best
}

/** The refs of a file left by the chain and path filters and, with custom, the refs under a non-library path. */
function refsIn(/** @type {any} */ f, /** @type {string | null} */ chain, /** @type {((p: string) => boolean) | null} */ pm, custom = false) {
  let refs = f.refs
  if (chain) refs = refs.filter((/** @type {[number, number]} */ r) => items[r[0]]?.chain === chain)
  if (pm) refs = refs.filter((/** @type {[number, number]} */ r) => pm(paths[r[1]] ?? ''))
  if (custom) refs = refs.filter((/** @type {[number, number]} */ r) => !pathLib[r[1]])
  return refs
}

/** Library status of a file from its references: every one under a library path, and how many contracts include it under one. */
function libOf(/** @type {[number, number][]} */ refs) {
  const libItems = new Set()
  let every = refs.length > 0
  for (const [iid, pid] of refs) {
    if (pathLib[pid]) libItems.add(iid)
    else every = false
  }
  return { library: every, libraryContracts: libItems.size }
}

/** Distinct paths a file has across its references. */
function pathCountOf(/** @type {[number, number][]} */ refs) {
  const n = new Set()
  for (const r of refs) n.add(r[1])
  return n.size
}
const distinctItems = (/** @type {[number, number][]} */ refs) => {
  if (refs.length < 2) return refs.length
  const set = new Set()
  for (const r of refs) set.add(r[0])
  return set.size
}

/** Scan the index for one query: matching files in result order (most shared first) and honest totals. */
function scan(/** @type {any} */ q, /** @type {RegExp} */ rx, /** @type {number[]} */ tris, /** @type {number} */ deadline) {
  const pm = pathMatcher(q.path)
  /** @type {number[]} */ const hf = []
  /** @type {number[]} */ const hc = []
  /** @type {number[]} */ const hd = []
  /** @type {number[]} */ const idf = []
  /** @type {number[]} */ const idc = []
  /** @type {Set<number>} */ const contracts = new Set()
  /** @type {Set<number>} */ const programs = new Set()
  let total = 0
  let capped = false
  let scannedFiles = 0
  let scannedBytes = 0
  let ofFiles = 0
  let ofBytes = 0
  const wantIdl = (!q.chain || q.chain === 'solana') && !q.lang && !q.path
  const wantCode = q.chain !== 'solana'
  for (const f of files) {
    if (!f || !f.refs.length) continue
    if (f.idl ? !wantIdl : !wantCode) continue
    if (!f.idl) {
      ofFiles++
      ofBytes += f.len
    }
    if (q.lang && f.lang !== q.lang && !(q.lang === 'other' && !['solidity', 'vyper', 'yul'].includes(f.lang))) continue
    if (q.custom && f.ci) continue
    const refs = refsIn(f, q.chain, pm, q.custom)
    if (!refs.length) continue
    if (!sigHas(f, tris)) continue
    if (capped) continue
    if (!f.idl) {
      scannedFiles++
      scannedBytes += f.len
    }
    const r = matchText(decode(f), rx, 0, f.idl ? Infinity : MAX_COUNT - total, deadline)
    if (r.count) {
      if (f.idl) {
        idf.push(f.id)
        idc.push(r.count)
        for (const x of refs) programs.add(x[0])
      } else {
        hf.push(f.id)
        hc.push(r.count)
        hd.push(distinctItems(refs))
        total += r.count
        for (const x of refs) contracts.add(x[0])
      }
    }
    if (r.stopped || total >= MAX_COUNT || Date.now() > deadline) capped = true
  }
  const order = Array.from(hf.keys()).sort((a, b) => hd[b] - hd[a] || hc[b] - hc[a] || hf[a] - hf[b])
  const iorder = Array.from(idf.keys()).sort((a, b) => idc[b] - idc[a] || idf[a] - idf[b])
  /** @type {Record<string, number>} */
  const chains = {}
  for (const iid of contracts) {
    const c = items[iid]?.chain
    if (c) chains[c] = (chains[c] ?? 0) + 1
  }
  return {
    fids: Int32Array.from(order, (i) => hf[i]),
    counts: Int32Array.from(order, (i) => hc[i]),
    idlFids: Int32Array.from(iorder, (i) => idf[i]),
    idlCounts: Int32Array.from(iorder, (i) => idc[i]),
    total: { matches: total, files: hf.length, contracts: contracts.size, chains, programs: programs.size, idlFiles: idf.length, capped },
    scanned: { files: scannedFiles, bytes: scannedBytes, ofFiles, ofBytes },
  }
}

/**
 * @param {{ q: string; re: boolean; case: boolean; chain: string | null; custom: boolean; path: string | null; lang: string | null; offset: number }} q
 */
function run(q) {
  const t0 = Date.now()
  const flags = `gm${q.case ? '' : 'i'}`
  const rx = new RegExp(q.re ? q.q : escapeRe(q.q), flags)
  const tris = trigramsOf(q.re ? requiredRuns(q.q) : [q.q])
  const ck = JSON.stringify([q.q, q.re, q.case, q.chain, q.custom, q.path, q.lang])
  let m = matchCache.get(ck)
  if (m) {
    matchCache.delete(ck)
    matchCache.set(ck, m)
  } else {
    m = scan(q, rx, tris, t0 + SOFT_MS)
    matchCache.set(ck, m)
    while (matchCache.size > MATCH_CACHE) matchCache.delete(/** @type {string} */ (matchCache.keys().next().value))
  }
  const pm = pathMatcher(q.path)
  // the page's own lines: each file of the page is matched again (at most PAGE_FILES files), within what is left
  // of the soft budget plus a little (the main thread stops the worker at its hard budget)
  const pageDeadline = Math.max(t0 + SOFT_MS, Date.now()) + 250

  // one page of file results, grouped by their primary contract
  const end = Math.min(m.fids.length, q.offset + PAGE_FILES)
  /** @type {Map<number, any>} */
  const groups = new Map()
  for (let k = q.offset; k < end; k++) {
    const f = files[m.fids[k]]
    const count = m.counts[k]
    const refs = refsIn(f, q.chain, pm, q.custom)
    if (!refs.length) continue
    const text = decode(f)
    const lines = matchText(text, rx, SHOW_HITS, Infinity, pageDeadline).lines
    const [piid, ppid] = primaryOf(refs)
    /** @type {Record<string, number>} */
    const chains = {}
    const seen = new Set()
    /** @type {any[]} */
    const also = []
    for (const [iid, pid] of refs) {
      if (seen.has(iid)) continue
      seen.add(iid)
      const c = items[iid].chain
      chains[c] = (chains[c] ?? 0) + 1
      if (iid !== piid && also.length < ALSO_IN) also.push({ ...item(iid), path: shownPath(paths[pid]) })
    }
    const lib = libOf(f.refs)
    const g = groups.get(piid) ?? { item: item(piid), files: [] }
    g.files.push({
      id: f.id,
      path: shownPath(paths[ppid]),
      lang: ['solidity', 'vyper', 'yul'].includes(f.lang) ? f.lang : 'other',
      lines: f.lines,
      matches: count,
      blocks: blocksOf(text, lines),
      moreMatches: Math.max(0, count - lines.length),
      shared: { contracts: seen.size, chains, total: refs === f.refs ? seen.size : distinctItems(f.refs) },
      library: lib.library,
      libraryContracts: lib.libraryContracts,
      pathCount: pathCountOf(f.refs),
      codeIndex: f.ci,
      alsoIn: also,
    })
    groups.set(piid, g)
  }

  // IDL documents: IDL_SHOW per page, on the same cursor as the files
  const page = Math.floor(q.offset / PAGE_FILES)
  const iFrom = page * IDL_SHOW
  const iEnd = Math.min(m.idlFids.length, iFrom + IDL_SHOW)
  /** @type {any[]} */
  const idl = []
  for (let k = iFrom; k < iEnd; k++) {
    const f = files[m.idlFids[k]]
    const count = m.idlCounts[k]
    const text = decode(f)
    const all = text.split('\n')
    const lines = matchText(text, rx, IDL_ENTRIES, Infinity, pageDeadline).lines
    const [piid] = primaryOf(f.refs)
    idl.push({
      item: item(piid),
      sharedPrograms: distinctItems(f.refs),
      entries: lines.map((/** @type {{ n: number; hits: [number, number][] }} */ l) => {
        const text = all[l.n - 1] ?? ''
        const sp = text.indexOf(' ')
        const kind = sp > 0 ? text.slice(0, sp) : 'entry'
        const rest = sp > 0 ? text.slice(sp + 1) : text
        const w = windowLine(rest, l.hits.map(([a, b]) => [Math.max(0, a - sp - 1), Math.max(0, b - sp - 1)]))
        return { kind, text: w.text, hits: w.hits.filter(([a, b]) => b > a) }
      }),
      moreEntries: Math.max(0, count - lines.length),
    })
  }

  const nextOff = q.offset + PAGE_FILES
  return {
    total: m.total,
    scanned: m.scanned,
    groups: [...groups.values()],
    idl,
    idlFrom: iFrom,
    next: nextOff < m.fids.length || iEnd < m.idlFids.length ? nextOff : null,
    gen,
    workerMs: Date.now() - t0,
  }
}

/** Every kept contract that includes one unique file (the full "also in" list), at most 500. */
function fileRefs(/** @type {number} */ id) {
  const f = files[id]
  if (!f || f.idl || !f.refs.length) return { gen, file: null }
  const seen = new Set()
  /** @type {{ chain: string; address: string; name: string | null; path: string }[]} */
  const list = []
  /** @type {Record<string, number>} */
  const chains = {}
  for (const [iid, pid] of f.refs) {
    if (seen.has(iid)) continue
    seen.add(iid)
    const it = items[iid]
    chains[it.chain] = (chains[it.chain] ?? 0) + 1
    list.push({ chain: it.chain, address: it.address, name: it.name, path: shownPath(paths[pid]) })
  }
  const order = ['ethereum', 'base', 'arbitrum', 'solana']
  list.sort((a, b) => order.indexOf(a.chain) - order.indexOf(b.chain) || (a.name ?? '~').localeCompare(b.name ?? '~') || a.address.localeCompare(b.address))
  return { gen, file: { id, lines: f.lines, bytes: f.len, contracts: list.length, chains, list: list.slice(0, 500), more: Math.max(0, list.length - 500) } }
}

const SOURCE_MAX = 600_000

/**
 * One unique file's text (at most SOURCE_MAX characters) with the contract it is listed under, and, with a query,
 * the matching lines of that file (at most 2 000, ranges included; a match over several lines marks each of them).
 */
function sourceOf(/** @type {number} */ id, /** @type {any} */ q) {
  const f = files[id]
  if (!f || f.idl || !f.refs.length) return { gen, source: null }
  const text = decode(f)
  const [piid, ppid] = primaryOf(f.refs)
  /** @type {{ n: number; hits: [number, number][] }[]} */
  const marks = []
  let more = 0
  let matchesCount = 0
  if (q) {
    const rx = new RegExp(q.re ? q.q : escapeRe(q.q), `gm${q.case ? '' : 'i'}`)
    const r = matchText(text, rx, 2000, Infinity, Date.now() + SOFT_MS)
    /** @type {Map<number, [number, number][]>} */
    const at = new Map()
    const add = (/** @type {number} */ n, /** @type {[number, number]} */ h) => {
      const a = at.get(n)
      if (a) a.push(h)
      else at.set(n, [h])
    }
    for (const l of r.lines) {
      for (const h of l.hits) add(l.n, h)
      for (const [n, a, b] of l.more ?? []) add(n, [a, b])
    }
    for (const [n, hits] of [...at].sort((a, b) => a[0] - b[0])) marks.push({ n, hits })
    more = Math.max(0, r.count - r.lines.length)
    matchesCount = r.count
  }
  return {
    gen,
    marks,
    moreMarks: more,
    matches: matchesCount,
    source: {
      id,
      path: shownPath(paths[ppid]),
      lang: ['solidity', 'vyper', 'yul'].includes(f.lang) ? f.lang : 'other',
      lines: f.lines,
      bytes: f.len,
      item: item(piid),
      contracts: new Set(f.refs.map((r) => r[0])).size,
      library: libOf(f.refs).library,
      libraryContracts: libOf(f.refs).libraryContracts,
      codeIndex: f.ci,
      text: text.length > SOURCE_MAX ? text.slice(0, SOURCE_MAX) : text,
      truncated: text.length > SOURCE_MAX,
    },
  }
}

port.on('message', (/** @type {any} */ msg) => {
  if (msg?.type === 'delta') apply(msg.delta)
  else if (msg?.type === 'query') {
    try {
      port.postMessage({ type: 'result', id: msg.id, result: msg.q.file !== undefined ? fileRefs(msg.q.file) : msg.q.source !== undefined ? sourceOf(msg.q.source, msg.q.q) : run(msg.q) })
    } catch (e) {
      port.postMessage({ type: 'error', id: msg.id, message: /** @type {Error} */ (e)?.message ?? String(e) })
    }
  }
})
port.postMessage({ type: 'up' })
