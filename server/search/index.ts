// CODE SEARCH: grep every verified source file and Solana IDL the chain agents kept, in milliseconds.
//
//   chain store shards ─▶ builder worker (build.mjs): dedupe files by content hash, copy each unique file once
//   into shared memory, trigram signature per file, gzip snapshot under <data>/search
//        ─▶ deltas ─▶ 2 query workers (query.mjs): trigram prefilter → literal / regex scan → grouped results
//
// Reads only what the chain store already holds: NO RPC, no registry calls, nothing from the daily budgets.
// Safety: a regex is checked first (no backreferences, no quantified groups that repeat a quantifier or an
// alternation), then runs in a query worker that is terminated when it passes the hard time budget; at most
// 2 queries run at once (a short queue, then 'busy'); results are cached per normalized query; each address
// gets 20 uncached searches a minute.
//
// REST: GET /api/search?q=&re=1&case=1&chain=&custom=1&path=&lang=&cursor= -> SearchResult
//       GET /api/search/file?id= -> { file: SearchFileRefs }   (every kept contract that includes one unique file)
//       GET /api/search/source?id=&q=&re=&case= -> { source: SearchSourceFile, marks, moreMarks }  (one unique file's text, ≤ 600 000 characters)
//       GET /api/search/stats -> SearchStats
// Module API (MCP): search(query: SearchQuery): Promise<SearchResult> ; file(id): Promise<SearchFileRefs | null> ;
//                   source(id): Promise<SearchSourceFile | null> ; stats(): SearchStats
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ChainId, ChainIndexItem } from '../../shared/chain.ts'
import { SEARCH_LANGS, type SearchFileRefs, type SearchLang, type SearchQuery, type SearchResult, type SearchSourceFile, type SearchStats } from '../../shared/search.ts'
import { refuseRegex } from './common.mjs'

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

export interface SearchSource {
  items(q: { chain?: ChainId; limit?: number; cursor?: string }): { items: ChainIndexItem[]; next: string | null }
}

export interface CodeSearchOptions {
  source: SearchSource
  dataDir: string
  log: Log
  /** Unique source bytes held in memory at most, MB (default 192; LUSCA_SEARCH_MAX_MB). */
  maxMb?: number
  /** Look for newly kept items this often, ms (default 60 s). */
  syncMs?: number
  startDelayMs?: number
  /** Hard time budget of one query, ms (default 1500): past it the query worker is terminated. */
  hardMs?: number
  /** Uncached searches per address per minute (default 20). */
  perIpPerMin?: number
  /** Snapshot save debounce after changes, ms (default 120 s). */
  saveDelayMs?: number
  /** The builder worker exits after this long with nothing to do and nothing unsaved, ms (default 30 s); the next change starts it again from the deltas the main thread keeps. */
  builderIdleMs?: number
}

export interface CodeSearch {
  start(): void
  stop(): Promise<void>
  /** Run one query (validated, cached, bounded). Never throws for bad input: the result carries `error`. */
  search(q: SearchQuery): Promise<SearchResult>
  /** Every kept contract that includes one unique file (SearchFileHit.id), at most 500; null when unknown. */
  file(id: number): Promise<SearchFileRefs | null>
  /** The text of one unique file (at most 600 000 characters) and, with a query, its matching lines; null when unknown. */
  source(id: number, q?: SearchQuery | null): Promise<{ source: SearchSourceFile; marks: { n: number; hits: [number, number][] }[]; moreMarks: number; matches: number } | null>
  stats(): SearchStats
  /** HTTP: /api/search and /api/search/stats. */
  route(p: string, params: URLSearchParams, ip: string): Promise<{ status: number; json: string; headers?: Record<string, string> }>
  /** Resolves when the builder has nothing left to do (tests, tools). */
  idle(): Promise<void>
  /** Write the snapshot now (tests, tools). */
  save(): Promise<void>
  /** V8 heap in use per worker (builder first), bytes. */
  heaps(): Promise<number[]>
}

const MB = 1048576
const CHAINS: ChainId[] = ['solana', 'ethereum', 'base', 'arbitrum']
const CACHE_MAX = 300
const CACHE_MAX_BYTES = 24 * MB
const CACHE_TTL_MS = 10 * 60_000
const POOL = 2
const QUEUE_MAX = 12
const QUEUE_WAIT_MS = 4000

interface NormQuery { q: string; re: boolean; case: boolean; chain: ChainId | null; custom: boolean; path: string | null; lang: SearchLang | null; offset: number }
interface Job { id: number; q: NormQuery | { file: number } | { source: number; q: NormQuery | null }; resolve: (r: WorkerOut) => void; queuedAt: number; timer: NodeJS.Timeout | null }
type WorkerOut = { ok: true; result: Record<string, unknown> } | { ok: false; code: 'timeout' | 'busy' | 'invalid'; message: string }
interface QW { w: Worker; job: Job | null; dead: boolean }

type BuilderStats = Omit<SearchStats, 'ready' | 'rss' | 'gen' | 'state'> & { state: SearchStats['state'] }

/** Validate a query. Returns the normalized query, or the reason it cannot run. */
export function normalizeQuery(raw: SearchQuery): { ok: true; q: NormQuery } | { ok: false; code: 'invalid' | 'refused'; message: string } {
  const q = String(raw.q ?? '').replace(/[\r\n\t]+/g, ' ')
  if (q.trim().length < 2) return { ok: false, code: 'invalid', message: 'type at least 2 characters' }
  if (q.length > 200) return { ok: false, code: 'invalid', message: 'a query is at most 200 characters' }
  const re = !!raw.re
  const cs = !!raw.case
  if (re) {
    const why = refuseRegex(q)
    if (why) return { ok: false, code: 'refused', message: why }
    let rx: RegExp
    try {
      rx = new RegExp(q, `gm${cs ? '' : 'i'}`)
    } catch (e) {
      return { ok: false, code: 'invalid', message: `not a valid regular expression: ${(e as Error).message.replace(/^Invalid regular expression: /, '')}`.slice(0, 200) }
    }
    rx.lastIndex = 0
    if (rx.test('')) return { ok: false, code: 'refused', message: 'this pattern matches the empty string (it would match every line) — make it require at least one character' }
  }
  const chain = raw.chain && (CHAINS as string[]).includes(raw.chain) ? raw.chain : null
  const lang = raw.lang && (SEARCH_LANGS as readonly string[]).includes(raw.lang) ? raw.lang : null
  const p = raw.path ? String(raw.path).trim().slice(0, 120) : ''
  let offset = 0
  if (raw.cursor) {
    if (!/^\d{1,6}$/.test(String(raw.cursor))) return { ok: false, code: 'invalid', message: 'invalid cursor' }
    offset = Number(raw.cursor)
  }
  return { ok: true, q: { q, re, case: cs, chain, custom: !!raw.custom, path: p || null, lang, offset } }
}

/** SearchQuery from URL parameters. */
export function queryFromParams(sp: URLSearchParams): SearchQuery {
  const flag = (k: string) => /^(1|true|yes|on)$/i.test(sp.get(k) ?? '')
  return {
    q: sp.get('q') ?? '',
    re: flag('re'),
    case: flag('case'),
    chain: (sp.get('chain') as ChainId | null) || null,
    custom: flag('custom'),
    path: sp.get('path'),
    lang: (sp.get('lang') as SearchLang | null) || null,
    cursor: sp.get('cursor'),
  }
}

export function createCodeSearch(o: CodeSearchOptions): CodeSearch {
  const log = o.log
  const maxBytes = Math.max(1, o.maxMb ?? 192) * MB
  const syncMs = o.syncMs ?? 60_000
  const hardMs = o.hardMs ?? 1500
  const perIp = o.perIpPerMin ?? 20
  const buildUrl = new URL('./build.mjs', import.meta.url)
  const queryUrl = new URL('./query.mjs', import.meta.url)

  let builder: Worker | null = null
  let builderMeta: unknown = null
  let builderExit: NodeJS.Timeout | null = null
  let retiring: Worker | null = null
  const builderIdleMs = o.builderIdleMs ?? 30_000
  const replay: unknown[] = []
  let gen = 0
  let bstats: BuilderStats | null = null
  let state: SearchStats['state'] = 'loading'
  const pool: QW[] = []
  const queue: Job[] = []
  let jobSeq = 0
  let started = false
  let stopped = false
  let syncTimer: NodeJS.Timeout | null = null
  let startTimer: NodeJS.Timeout | null = null
  let lastSig = ''
  let idleWaiters: (() => void)[] = []
  let busyBuilding = false
  let saveWaiters: (() => void)[] = []
  const cache = new Map<string, { at: number; json: string; status: number }>()
  let cacheBytes = 0
  /** LRU of answered queries, bounded by entries and by bytes. */
  function cachePut(key: string, e: { at: number; json: string; status: number }) {
    const old = cache.get(key)
    if (old) {
      cacheBytes -= old.json.length
      cache.delete(key)
    }
    cache.set(key, e)
    cacheBytes += e.json.length
    while (cache.size > CACHE_MAX || cacheBytes > CACHE_MAX_BYTES) {
      const k = cache.keys().next().value as string
      cacheBytes -= cache.get(k)!.json.length
      cache.delete(k)
    }
  }
  const hits = new Map<string, number[]>()
  let statsCache: { at: number; json: string } | null = null

  // ─── workers ───────────────────────────────────────────────────────────────

  function spawnBuilder(restore: boolean) {
    const w = new Worker(buildUrl, { resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 16 } })
    builder = w
    w.unref()
    w.on('message', (m: { type: string; [k: string]: unknown }) => {
      if (m.type === 'delta') {
        replay.push(m.delta)
        gen++
        for (const q of pool) if (!q.dead) q.w.postMessage({ type: 'delta', delta: m.delta })
      } else if (m.type === 'stats') {
        bstats = m.stats as BuilderStats
        if (m.meta) builderMeta = m.meta
        state = bstats.state
        statsCache = null
      } else if (m.type === 'log') log(m.lvl as 'info', String(m.msg))
      else if (m.type === 'idle') {
        busyBuilding = false
        const ws = idleWaiters
        idleWaiters = []
        for (const f of ws) f()
        // nothing to do and nothing unsaved: let the builder go (its memory with it) until the next change
        if (!m.dirty && !stopped) {
          if (builderExit) clearTimeout(builderExit)
          builderExit = setTimeout(() => {
            builderExit = null
            if (builder !== w || busyBuilding) return
            retiring = w
            builder = null
            void w.terminate()
          }, builderIdleMs)
          builderExit.unref?.()
        }
      } else if (m.type === 'saved') {
        const ws = saveWaiters
        saveWaiters = []
        for (const f of ws) f()
      } else if (m.type === 'loaded') {
        if (m.snapshot) log('info', 'code search: snapshot loaded — searchable now, catching up with the chain store')
      }
    })
    w.on('error', (e) => log('error', `code search builder: ${e.stack ?? e.message}`))
    w.on('exit', (code) => {
      if (stopped || retiring === w) return
      log('warn', `code search builder exited (${code}) — search keeps the index it has; the next change starts a new one`)
      if (builder === w) builder = null
      busyBuilding = false
      lastSig = ''
    })
    const base = { dataDir: o.dataDir, maxBytes, saveDelayMs: o.saveDelayMs ?? 120_000 }
    if (restore) w.postMessage({ type: 'restore', ...base, deltas: replay, meta: builderMeta })
    else w.postMessage({ type: 'init', ...base })
  }

  function spawnQuery(): QW {
    const w = new Worker(queryUrl, { resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8 } })
    w.unref()
    const qw: QW = { w, job: null, dead: false }
    for (const d of replay) w.postMessage({ type: 'delta', delta: d })
    w.on('message', (m: { type: string; id: number; result?: Record<string, unknown>; message?: string }) => {
      const job = qw.job
      if (!job || job.id !== m.id) return
      if (job.timer) clearTimeout(job.timer)
      qw.job = null
      if (m.type === 'result') job.resolve({ ok: true, result: m.result! })
      else job.resolve({ ok: false, code: 'invalid', message: (m.message ?? 'query failed').slice(0, 200) })
      pump()
    })
    w.on('error', (e) => log('warn', `code search query worker: ${e.message}`))
    w.on('exit', () => {
      qw.dead = true
      const job = qw.job
      qw.job = null
      if (job) {
        if (job.timer) clearTimeout(job.timer)
        job.resolve({ ok: false, code: 'timeout', message: 'the search stopped' })
      }
      const i = pool.indexOf(qw)
      if (i >= 0) pool.splice(i, 1)
      if (!stopped) {
        pool.push(spawnQuery())
        pump()
      }
    })
    return qw
  }

  function pump() {
    while (queue.length) {
      const free = pool.find((q) => !q.dead && !q.job)
      if (!free) return
      const job = queue.shift()!
      if (Date.now() - job.queuedAt > QUEUE_WAIT_MS) {
        job.resolve({ ok: false, code: 'busy', message: 'search is busy — try again in a few seconds' })
        continue
      }
      free.job = job
      job.timer = setTimeout(() => {
        if (free.job !== job) return
        free.job = null
        job.resolve({ ok: false, code: 'timeout', message: `the search passed its ${(hardMs / 1000).toFixed(1)} s time budget and was stopped — make the pattern more specific` })
        free.dead = true
        void free.w.terminate() // the exit handler starts a fresh worker on the same shared index
      }, hardMs)
      free.w.postMessage({ type: 'query', id: job.id, q: job.q })
    }
  }

  function runJob(q: NormQuery | { file: number } | { source: number; q: NormQuery | null }): Promise<WorkerOut> {
    if (queue.length >= QUEUE_MAX) return Promise.resolve({ ok: false, code: 'busy', message: 'search is busy — try again in a few seconds' })
    return new Promise((resolve) => {
      queue.push({ id: ++jobSeq, q, resolve, queuedAt: Date.now(), timer: null })
      pump()
    })
  }

  // ─── sync with the chain store ─────────────────────────────────────────────

  function syncNow() {
    const entries: [string, ChainId, string, string | null, string, number][] = []
    let cursor: string | undefined
    let guard = 0
    let maxAt = 0
    let sum = 0
    do {
      const pg = o.source.items({ limit: 200, cursor })
      for (const it of pg.items) {
        if (it.chain === 'solana' ? !it.idl : it.sourceFiles <= 0) continue
        const key = `${it.chain}:${it.chain === 'solana' ? it.address : it.address.toLowerCase()}`
        entries.push([key, it.chain, it.address, it.name, it.kind, it.readAt])
        maxAt = Math.max(maxAt, it.readAt)
        sum = (sum + (it.readAt % 1_000_003)) % 2_147_483_647
      }
      cursor = pg.next ?? undefined
    } while (cursor && ++guard < 10_000)
    const sig = `${entries.length}:${maxAt}:${sum}`
    if (sig === lastSig) return
    lastSig = sig
    busyBuilding = true
    if (builderExit) {
      clearTimeout(builderExit)
      builderExit = null
    }
    if (!builder) spawnBuilder(true)
    builder!.postMessage({ type: 'sync', items: entries })
  }

  // ─── public ────────────────────────────────────────────────────────────────

  function stats(): SearchStats {
    const b = bstats
    return {
      ready: !!b && (b.state === 'ready' || b.uniqueFiles > 0),
      state: started ? state : 'off',
      contracts: b?.contracts ?? 0,
      programs: b?.programs ?? 0,
      fileRefs: b?.fileRefs ?? 0,
      uniqueFiles: b?.uniqueFiles ?? 0,
      lines: b?.lines ?? 0,
      bytes: b?.bytes ?? 0,
      rawBytes: b?.rawBytes ?? 0,
      diskBytes: b?.diskBytes ?? 0,
      sharedBytes: b?.sharedBytes ?? 0,
      rss: process.memoryUsage().rss,
      byChain: b?.byChain ?? {},
      top: b?.top ?? [],
      partial: b?.partial ?? null,
      builtAt: b?.builtAt ?? null,
      gen,
    }
  }

  const emptyResult = (q: NormQuery | null, raw: SearchQuery, error: SearchResult['error'], ms = 0): SearchResult => ({
    q: q?.q ?? String(raw.q ?? ''),
    re: q?.re ?? !!raw.re,
    case: q?.case ?? !!raw.case,
    total: { matches: 0, files: 0, contracts: 0, chains: {}, programs: 0, capped: false },
    scanned: { files: 0, bytes: 0, ofFiles: 0, ofBytes: 0 },
    groups: [],
    idl: [],
    next: null,
    gen,
    ms,
    cached: false,
    error,
  })

  async function search(raw: SearchQuery): Promise<SearchResult> {
    const t0 = performance.now()
    const n = normalizeQuery(raw)
    if (!n.ok) return emptyResult(null, raw, { code: n.code, message: n.message })
    const q = n.q
    if (!stats().ready) return emptyResult(q, raw, { code: 'not-ready', message: 'the search index is being built — try again in a minute' })
    const out = await runJob(q)
    const ms = Math.round(performance.now() - t0)
    if (!out.ok) return emptyResult(q, raw, { code: out.code, message: out.message }, ms)
    const r = out.result as unknown as Omit<SearchResult, 'q' | 're' | 'case' | 'ms' | 'cached' | 'error' | 'next'> & { next: number | null; workerMs: number }
    return {
      q: q.q,
      re: q.re,
      case: q.case,
      total: r.total,
      scanned: r.scanned,
      groups: r.groups,
      idl: r.idl,
      next: r.next === null ? null : String(r.next),
      gen: r.gen,
      ms,
      cached: false,
      error: null,
    }
  }

  async function file(id: number): Promise<SearchFileRefs | null> {
    if (!Number.isSafeInteger(id) || id < 0 || !stats().ready) return null
    const out = await runJob({ file: id })
    if (!out.ok) return null
    return (out.result as { file: SearchFileRefs | null }).file
  }

  async function source(id: number, raw?: SearchQuery | null): Promise<{ source: SearchSourceFile; marks: { n: number; hits: [number, number][] }[]; moreMarks: number; matches: number } | null> {
    if (!Number.isSafeInteger(id) || id < 0 || !stats().ready) return null
    const n = raw && raw.q ? normalizeQuery(raw) : null
    let out = await runJob({ source: id, q: n && n.ok ? n.q : null })
    // the query ran out of time on this file: send the text without marks rather than nothing
    if (!out.ok && n && n.ok && out.code === 'timeout') out = await runJob({ source: id, q: null })
    if (!out.ok) return null
    const r = out.result as { source: SearchSourceFile | null; marks: { n: number; hits: [number, number][] }[]; moreMarks: number; matches: number }
    return r.source ? { source: r.source, marks: r.marks, moreMarks: r.moreMarks, matches: r.matches } : null
  }

  const cacheKey = (q: NormQuery) => `${gen}|${JSON.stringify([q.q, q.re, q.case, q.chain, q.custom, q.path, q.lang, q.offset])}`

  function takeIp(ip: string): number {
    const now = Date.now()
    const ts = (hits.get(ip) ?? []).filter((t) => t > now - 60_000)
    if (ts.length >= perIp) {
      hits.set(ip, ts)
      return ts[0] + 60_000 - now
    }
    ts.push(now)
    hits.set(ip, ts)
    if (hits.size > 5_000) for (const [k, v] of hits) if (!v.length || v[v.length - 1] <= now - 60_000) hits.delete(k)
    return 0
  }

  async function route(p: string, params: URLSearchParams, ip: string): Promise<{ status: number; json: string; headers?: Record<string, string> }> {
    if (p === '/api/search/stats') {
      const now = Date.now()
      if (!statsCache || now - statsCache.at > 5000) statsCache = { at: now, json: JSON.stringify(stats()) }
      return { status: 200, json: statsCache.json, headers: { 'Cache-Control': 'public, max-age=5' } }
    }
    if (p === '/api/search/file') {
      const raw = params.get('id') ?? ''
      if (!/^\d{1,7}$/.test(raw)) return { status: 400, json: JSON.stringify({ error: 'id must be a file id from a search result' }) }
      const key = `${gen}|file|${raw}`
      const hit = cache.get(key)
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { status: hit.status, json: hit.json, headers: { 'Cache-Control': 'public, max-age=60' } }
      const wait = takeIp(ip)
      if (wait > 0) return { status: 429, json: JSON.stringify({ error: `${perIp} searches a minute per address — wait ${Math.ceil(wait / 1000)} s` }), headers: { 'Retry-After': String(Math.ceil(wait / 1000)) } }
      const f = await file(Number(raw))
      const json = JSON.stringify(f ? { file: f } : { error: 'no such file in the index (it may have been rebuilt: search again)' })
      const status = f ? 200 : 404
      cachePut(key, { at: Date.now(), json, status })
      return { status, json, headers: f ? { 'Cache-Control': 'public, max-age=60' } : undefined }
    }
    if (p === '/api/search/source') {
      // not kept in the server cache (a file can be large): the worker inflates it in a few ms; browsers cache it
      const raw = params.get('id') ?? ''
      if (!/^\d{1,7}$/.test(raw)) return { status: 400, json: JSON.stringify({ error: 'id must be a file id from a search result' }) }
      const wait = takeIp(ip)
      if (wait > 0) return { status: 429, json: JSON.stringify({ error: `${perIp} searches a minute per address — wait ${Math.ceil(wait / 1000)} s` }), headers: { 'Retry-After': String(Math.ceil(wait / 1000)) } }
      const src = await source(Number(raw), params.get('q') ? queryFromParams(params) : null)
      if (!src) return { status: 404, json: JSON.stringify({ error: 'no such file in the index (it may have been rebuilt: search again)' }) }
      return { status: 200, json: JSON.stringify(src), headers: { 'Cache-Control': 'public, max-age=300' } }
    }
    if (p !== '/api/search') return { status: 404, json: JSON.stringify({ error: 'not found' }) }
    const raw = queryFromParams(params)
    const n = normalizeQuery(raw)
    if (!n.ok) return { status: 400, json: JSON.stringify(emptyResult(null, raw, { code: n.code, message: n.message })) }
    const key = cacheKey(n.q)
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      cachePut(key, hit)
      const j = JSON.parse(hit.json) as SearchResult
      j.cached = true
      return { status: hit.status, json: JSON.stringify(j), headers: { 'Cache-Control': 'public, max-age=60' } }
    }
    const wait = takeIp(ip)
    if (wait > 0) {
      return {
        status: 429,
        json: JSON.stringify(emptyResult(n.q, raw, { code: 'busy', message: `${perIp} searches a minute per address — wait ${Math.ceil(wait / 1000)} s` })),
        headers: { 'Retry-After': String(Math.ceil(wait / 1000)) },
      }
    }
    const r = await search(raw)
    const status = !r.error ? 200 : r.error.code === 'invalid' || r.error.code === 'refused' ? 400 : 503
    const json = JSON.stringify(r)
    // results and timeouts are cached (a pattern that timed out is not run again for a while); busy / not-ready are not
    if (!r.error || r.error.code === 'timeout') {
      cachePut(key, { at: Date.now(), json, status })
    }
    return { status, json, headers: status === 200 ? { 'Cache-Control': 'public, max-age=60' } : undefined }
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      state = 'loading'
      spawnBuilder(false)
      for (let i = 0; i < POOL; i++) pool.push(spawnQuery())
      const tick = () => {
        try {
          syncNow()
        } catch (e) {
          log('warn', `code search sync: ${(e as Error).message}`)
        }
      }
      startTimer = setTimeout(() => {
        tick()
        syncTimer = setInterval(tick, syncMs)
        syncTimer.unref?.()
      }, o.startDelayMs ?? 5000)
      startTimer.unref?.()
      log('info', `code search: index cap ${Math.round(maxBytes / MB)} MB, ${POOL} query workers, ${hardMs} ms per query`)
    },
    async stop() {
      if (stopped) return
      stopped = true
      if (startTimer) clearTimeout(startTimer)
      if (syncTimer) clearInterval(syncTimer)
      if (builderExit) clearTimeout(builderExit)
      for (const j of queue.splice(0)) j.resolve({ ok: false, code: 'busy', message: 'the server is stopping' })
      await Promise.all(pool.map((q) => q.w.terminate().catch(() => 0)))
      if (builder) await builder.terminate().catch(() => 0)
    },
    search,
    file,
    source,
    stats,
    route,
    idle() {
      if (!busyBuilding) return Promise.resolve()
      return new Promise((r) => idleWaiters.push(r))
    },
    async heaps() {
      const ws = [builder, ...pool.map((q) => q.w)]
      const hs = await Promise.all(ws.map((w) => (w ? w.getHeapStatistics().catch(() => null) : null)))
      return hs.map((h) => (h ? h.used_heap_size : 0))
    },
    save() {
      // no builder: it left with nothing unsaved
      if (!builder) return Promise.resolve()
      return new Promise((r) => {
        saveWaiters.push(r)
        builder!.postMessage({ type: 'save' })
      })
    },
  }
}

/** Disk use of the snapshot directory (bytes). */
export function searchDiskBytes(dataDir: string): number {
  try {
    return fs.readdirSync(path.join(dataDir, 'search')).reduce((s, n) => s + fs.statSync(path.join(dataDir, 'search', n)).size, 0)
  } catch {
    return 0
  }
}
