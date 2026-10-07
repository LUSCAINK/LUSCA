// @ts-check
// CODE SEARCH — query worker (worker_threads). Holds a view of the index (the builder's SharedArrayBuffer
// segments, shared without a copy, plus the file / item tables from its deltas) and runs one query at a time.
// The main thread terminates the worker when a query exceeds its hard time budget (a regex can backtrack for
// ever) and starts a fresh one: the index lives in shared memory, so a new worker is ready in milliseconds.
//
// In:  { type: 'delta', delta }  (applied in order)    { type: 'query', id, q }
// Out: { type: 'result', id, result }   { type: 'error', id, message }
import { parentPort } from 'node:worker_threads'
import { escapeRe, isLibPath, pathMatcher, requiredRuns, sigBit, trigramsOf } from './common.mjs'

const port = /** @type {import('node:worker_threads').MessagePort} */ (parentPort)

/** @type {SharedArrayBuffer[]} */ const textSegs = []
/** @type {Int32Array[]} */ const sigSegs = []
/** @type {{ chain: string; address: string; name: string | null; readAt: number; files: Set<number> }[]} */ const items = []
/** @type {string[]} */ const paths = []
/** @type {{ id: number; seg: number; off: number; len: number; sseg: number; soff: number; sbits: number; lg: number; lang: string; lines: number; ci: boolean; idl: boolean; lib: boolean; refs: [number, number][] }[]} */
const files = []
let gen = 0

function apply(/** @type {any} */ d) {
  for (const s of d.segs) {
    if (s.kind === 'text') textSegs[s.idx] = s.sab
    else sigSegs[s.idx] = new Int32Array(s.sab)
  }
  for (const [id, p] of d.paths) paths[id] = p
  for (const it of d.items) {
    const cur = items[it.id]
    if (cur) {
      cur.name = it.name
      cur.readAt = it.readAt
    } else items[it.id] = { chain: it.chain, address: it.address, name: it.name, readAt: it.readAt, files: new Set() }
  }
  for (const f of d.files) files[f.id] = { ...f, lg: Math.log2(f.sbits), lib: f.ci, refs: [] }
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
    if (!f.lib && isLibPath(paths[pid] ?? '')) f.lib = true
  }
  gen++
  matchCache.clear()
}

// ─── query ───────────────────────────────────────────────────────────────────

const NL = String.fromCharCode(10)
const MAX_COUNT = 20_000 // matching lines counted before the totals become lower bounds
const SOFT_MS = 1_100 // stop scanning (totals become lower bounds) past this; the main thread kills at its hard budget
const SHOW_HITS = 4 // matching lines shown per file
const CTX = 2
const LINE_MAX = 320
const PAGE_FILES = 10
const ALSO_IN = 8
const IDL_SHOW = 12
const IDL_ENTRIES = 6

/** @type {Map<string, any>} */
const matchCache = new Map()

const decode = (/** @type {{ seg: number; off: number; len: number }} */ f) => Buffer.from(textSegs[f.seg], f.off, f.len).toString('utf8')

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
  /** @type {{ n: number; hits: [number, number][] }[]} */
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
      const end = Math.min(at + Math.max(1, m[0].length), lineEnd < 0 ? s.length : lineEnd)
      cur.hits.push([at - lineStart, Math.max(at - lineStart + 1, end - lineStart)])
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
function blocksOf(/** @type {string} */ s, /** @type {{ n: number; hits: [number, number][] }[]} */ hl) {
  const all = s.split('\n')
  /** @type {{ n: number; text: string; hits: [number, number][] }[][]} */
  const blocks = []
  /** @type {{ n: number; text: string; hits: [number, number][] }[] | null} */
  let cur = null
  let curEnd = 0
  const hitAt = new Map(hl.map((h) => [h.n, h.hits]))
  for (const h of hl) {
    const from = Math.max(1, h.n - CTX)
    const to = Math.min(all.length, h.n + CTX)
    if (cur && from <= curEnd + 1) {
      for (let n = curEnd + 1; n <= to; n++) cur.push({ n, ...windowLine(all[n - 1] ?? '', hitAt.get(n) ?? []) })
      curEnd = Math.max(curEnd, to)
    } else {
      cur = []
      for (let n = from; n <= to; n++) cur.push({ n, ...windowLine(all[n - 1] ?? '', hitAt.get(n) ?? []) })
      curEnd = to
      blocks.push(cur)
    }
  }
  return blocks
}

/**
 * @param {{ q: string; re: boolean; case: boolean; chain: string | null; custom: boolean; path: string | null; lang: string | null; offset: number }} q
 */
function run(q) {
  const t0 = Date.now()
  const deadline = t0 + SOFT_MS
  const flags = `gm${q.case ? '' : 'i'}`
  const rx = new RegExp(q.re ? q.q : escapeRe(q.q), flags)
  const tris = trigramsOf(q.re ? requiredRuns(q.q) : [q.q])
  const ck = JSON.stringify([q.q, q.re, q.case, q.chain, q.custom, q.path, q.lang])
  let m = matchCache.get(ck)
  if (!m) {
    const pm = pathMatcher(q.path)
    /** @type {{ fid: number; count: number; lines: { n: number; hits: [number, number][] }[]; refs: [number, number][] }[]} */
    const hitsList = []
    let total = 0
    let capped = false
    let scannedFiles = 0
    let scannedBytes = 0
    let ofFiles = 0
    let ofBytes = 0
    /** @type {{ fid: number; count: number; lines: { n: number; hits: [number, number][] }[]; refs: [number, number][] }[]} */
    const idlHits = []
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
      if (q.custom && f.lib) continue
      let refs = f.refs
      if (q.chain) refs = refs.filter((r) => items[r[0]]?.chain === q.chain)
      if (pm) refs = refs.filter((r) => pm(paths[r[1]] ?? ''))
      if (!refs.length) continue
      if (!sigHas(f, tris)) continue
      if (capped) continue
      if (!f.idl) {
        scannedFiles++
        scannedBytes += f.len
      }
      const r = matchText(decode(f), rx, f.idl ? IDL_ENTRIES : SHOW_HITS, MAX_COUNT - total, deadline)
      if (r.count) {
        ;(f.idl ? idlHits : hitsList).push({ fid: f.id, count: r.count, lines: r.lines, refs })
        if (!f.idl) total += r.count
      }
      if (r.stopped || total >= MAX_COUNT || Date.now() > deadline) capped = true
    }
    const distinct = (/** @type {[number, number][]} */ refs) => new Set(refs.map((r) => r[0])).size
    hitsList.sort((a, b) => distinct(b.refs) - distinct(a.refs) || b.count - a.count || a.fid - b.fid)
    idlHits.sort((a, b) => b.count - a.count || a.fid - b.fid)
    /** @type {Set<number>} */
    const contracts = new Set()
    for (const h of hitsList) for (const r of h.refs) contracts.add(r[0])
    /** @type {Record<string, number>} */
    const chains = {}
    for (const iid of contracts) {
      const c = items[iid]?.chain
      if (c) chains[c] = (chains[c] ?? 0) + 1
    }
    const programs = new Set()
    for (const h of idlHits) for (const r of h.refs) programs.add(r[0])
    m = {
      hitsList,
      idlHits,
      total: { matches: total, files: hitsList.length, contracts: contracts.size, chains, programs: programs.size, capped },
      scanned: { files: scannedFiles, bytes: scannedBytes, ofFiles, ofBytes },
    }
    matchCache.set(ck, m)
    while (matchCache.size > 6) matchCache.delete(/** @type {string} */ (matchCache.keys().next().value))
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

  // one page of file results, grouped by their primary contract
  const page = m.hitsList.slice(q.offset, q.offset + PAGE_FILES)
  /** @type {Map<number, any>} */
  const groups = new Map()
  for (const h of page) {
    const f = files[h.fid]
    const [piid, ppid] = primaryOf(h.refs)
    /** @type {Record<string, number>} */
    const chains = {}
    const seen = new Set()
    /** @type {any[]} */
    const also = []
    for (const [iid, pid] of h.refs) {
      if (seen.has(iid)) continue
      seen.add(iid)
      const c = items[iid].chain
      chains[c] = (chains[c] ?? 0) + 1
      if (iid !== piid && also.length < ALSO_IN) also.push({ ...item(iid), path: paths[pid] })
    }
    const g = groups.get(piid) ?? { item: item(piid), files: [] }
    g.files.push({
      id: f.id,
      path: paths[ppid],
      lang: ['solidity', 'vyper', 'yul'].includes(f.lang) ? f.lang : 'other',
      lines: f.lines,
      matches: h.count,
      blocks: blocksOf(decode(f), h.lines),
      moreMatches: Math.max(0, h.count - h.lines.length),
      shared: { contracts: seen.size, chains },
      library: f.lib,
      alsoIn: also,
    })
    groups.set(piid, g)
  }

  const idl = m.idlHits.slice(0, IDL_SHOW).map((/** @type {any} */ h) => {
    const f = files[h.fid]
    const all = decode(f).split('\n')
    const [piid] = primaryOf(h.refs)
    return {
      item: item(piid),
      sharedPrograms: new Set(h.refs.map((/** @type {[number, number]} */ r) => r[0])).size,
      entries: h.lines.map((/** @type {{ n: number; hits: [number, number][] }} */ l) => {
        const text = all[l.n - 1] ?? ''
        const sp = text.indexOf(' ')
        const kind = sp > 0 ? text.slice(0, sp) : 'entry'
        const rest = sp > 0 ? text.slice(sp + 1) : text
        const w = windowLine(rest, l.hits.map(([a, b]) => [Math.max(0, a - sp - 1), Math.max(0, b - sp - 1)]))
        return { kind, text: w.text, hits: w.hits.filter(([a, b]) => b > a) }
      }),
      moreEntries: Math.max(0, h.count - h.lines.length),
    }
  })

  const nextOff = q.offset + PAGE_FILES
  return {
    total: m.total,
    scanned: m.scanned,
    groups: [...groups.values()],
    idl: q.offset ? [] : idl,
    next: nextOff < m.hitsList.length ? nextOff : null,
    gen,
    workerMs: Date.now() - t0,
  }
}

port.on('message', (/** @type {any} */ msg) => {
  if (msg?.type === 'delta') apply(msg.delta)
  else if (msg?.type === 'query') {
    try {
      port.postMessage({ type: 'result', id: msg.id, result: run(msg.q) })
    } catch (e) {
      port.postMessage({ type: 'error', id: msg.id, message: /** @type {Error} */ (e)?.message ?? String(e) })
    }
  }
})
port.postMessage({ type: 'up' })
