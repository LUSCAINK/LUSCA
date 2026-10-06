// LUSCA crawler — the eight arms and their suckers.
//
// Each agent runs: seek → fetch → parse → taste → dedupe → store (or reject /
// error) → seek … forever, against the live web, politely:
//   • robots.txt per origin (1 h cache; 4xx = allow all; 5xx/timeout = pause host 10 min)
//   • ≤ 1 request in flight per host, ≥ max(2000 ms, Crawl-delay ≤ 60 s) between
//     requests — including robots.txt and every redirect hop on the same host
//   • 12 s timeout, text/html only, 2 MB body cap, redirects re-checked against robots,
//     and a redirect to an unknown host goes through new-domain admission
//   • only public addresses (netguard.ts), rel=nofollow/ugc/sponsored links are not followed
//   • 3 consecutive errors → host backoff 5 min
// Accepted pages are appended to <dataDir>/dataset.jsonl and handed to the trainer,
// unless the page opts out of AI training: TDMRep header/meta, robots "noai", a
// robots.txt group for an AI-training crawler (GPTBot, CCBot, ClaudeBot, … see
// util.ts AI_TRAINING_UAS) disallowing it, or Content-Signal ai-train=no (robots.txt
// directive or response header). Links into such pages are not queued at all.
//   • <dataDir>/denylist.json (denylist.ts): hosts / URL prefixes never fetched,
//     re-read every 60 s; matching queued URLs are dropped on change
//   • accusation boards (bitcointalk Scam Accusations / Reputation) and forum user
//     profiles are never stored
import { encode, setMergeCacheSize } from 'gpt-tokenizer'
import { SPAWN_TTL_MS, type CrawlerApi, type CrawlerOptions, type Emit, type SpawnErrorCode } from '../contracts.ts'
import type { AgentInfo, AgentState, DomainInfo, FrontierPick, PageRecord, SectorInfo, ServerMsg, Stats, Trace } from '../../shared/protocol.ts'
import { AGENT_NAMES, ROMAN, SECTORS, agentCode, sectorForHost } from '../../shared/sectors.ts'
import { vectorize, VEC_DIM } from '../../shared/vectorize.ts'
import { b64ToF32, f32ToB64 } from '../../shared/b64.ts'
import { extract, type Extracted } from './extract.ts'
import { describeFetchError, fetchOnce, PAGE_TIMEOUT_MS, type FetchOnceResult } from './fetcher.ts'
import { Frontier, type QueueEntry } from './frontier.ts'
import { HostTable } from './hosts.ts'
import { phraseHits, taste, type TasteResult } from './lexicon.ts'
import { parseContentSignal, RobotsCache, ROBOTS_TTL_MS, ROBOTS_UNAVAILABLE_PAUSE_MS } from './robots.ts'
import { SimIndex, simFromHex, simhash64, simShort, simToHex, type Sim64 } from './simhash.ts'
import { DatasetWriter, emptyArchived, ensureDir, loadDataset, loadState, saveState, type ArchivedTotals, type DatasetLine } from './store.ts'
import { accusationBoard, isBlockedHost, normalizeUrl, pathPenalty, pathWords, skipReason, type NormUrl } from './url.ts'
import { denylistPath, denylistReloadMs, DenylistFile, isDenylisted, isDenylistedUrl } from './denylist.ts'
import { clamp, errMsg, fmtInt, fmtKB, fmtSec, own, pageIdFor, Ring, sha1hex, shortUrl, sleep, truncate } from './util.ts'

// gpt-tokenizer memoizes BPE merges in a 100k-entry LRU keyed by substrings of
// the input; each key is a V8 slice that pins its whole page text, which kept
// hundreds of page texts alive on a long crawl. Uncached counting costs ~0.6 ms
// more per page (measured), so the cache is switched off for this process.
setMergeCacheSize(0)

// ── tunables ──────────────────────────────────────────────────────────────
const MAX_AGENTS = 64
const ACCEPT_SCORE = 0.35
const MIN_TOKENS = 80
const MAX_TEXT_CHARS = 60_000
const NEAR_DUP_HAMMING = 3
const MAX_NEW_LINKS_PER_PAGE = 60
const NEW_DOMAIN_MIN_PRIORITY = 0.55
const KNOWN_HOST_MIN_PRIORITY = 0.15
const MAX_ADMITTED_HOSTS = 250
// New-domain admission is rate limited (token bucket) and capped per page so the
// 250-host budget is spent over ~an hour on the best candidates, not in the first minute.
const ADMIT_BURST = 12
const ADMIT_REFILL_MS = 15_000
const MAX_NEW_DOMAINS_PER_PAGE = 3
const MAX_DEPTH = 12
// pages kept in memory for search/recent/vectors (env LUSCA_MEMORY_PAGES for small instances)
const MEMORY_PAGES = Math.max(1000, Math.min(200_000, Number(process.env.LUSCA_MEMORY_PAGES) || 20_000))
// Dedupe memory (ids, titles, content hashes, simhashes) is a sliding window over the
// newest pages: ~400 B/page, so an endless crawl (~1M pages/day) stays bounded.
const MAX_DEDUPE_PAGES = 400_000
const DEDUPE_EVICT_CHUNK = 20_000
const MAX_SEMANTIC_DUPS = 50_000
const EVICT_CHUNK = 256
const EXCERPT_CHARS = 420
const GLOBAL_TRACES = 2000
const AGENT_TRACES = 200
const STAGGER_MS = 6000
const RESEED_EVERY_MS = 20 * 60_000
const STATE_SAVE_EVERY_MS = 30_000
const MAX_REDIRECTS = 5
const REDIRECT_HOST_WAIT_MS = 4000
// An agent sleeps through a politeness pause up to this long itself; a longer
// one (big Crawl-delay) hands the URL back to the frontier and the host's nextAt
// is charged on release.
const MAX_INLINE_WAIT_MS = 10_000
const RATE_WINDOW_MS = 60_000
const MIN_DISTINCT_TERMS = 3
const RETIRE_CHECK_MS = 60_000
const MAX_HEADER_OPTOUT_HOSTS = 5000

/** Minimum dwell per state at pace 1 (ms) so humans can follow each sucker. */
const DWELL: Partial<Record<AgentState, number>> = {
  seek: 450,
  parse: 650,
  taste: 950,
  dedupe: 550,
  store: 700,
  reject: 700,
  error: 900,
}

interface AgentRt {
  info: AgentInfo
  traces: Ring<Trace>
  loop: Promise<void> | null
  /** Spawned agents retire at this time (0 = never, genesis). */
  retireAt: number
  retired: boolean
  /** The agent loop has fully exited (a retired slot may only be reused then). */
  loopDone: boolean
}

interface DomainRec {
  info: DomainInfo
  scoreSum: number
}

interface PickResult {
  entry: QueueEntry | null
  stolen: boolean
  stolenNote: string
  waitMs: number
  waitReason: string
  waitHost: string | null
}

/** Result of a politeness / robots gate inside fetchStage. */
type Gate = { kind: 'ok' } | { kind: 'defer' } | { kind: 'stop' } | { kind: 'fail'; reason: string }

type FetchOutcome =
  | { kind: 'page'; res: FetchOnceResult; finalUrl: string; final: NormUrl; redirects: number; totalMs: number }
  | { kind: 'reject'; reason: string; url: string; host: string; data?: Trace['data'] }
  | { kind: 'error'; reason: string; url: string; host: string; data?: Trace['data'] }
  | { kind: 'skip'; reason: string } // requeued / aborted — not counted

interface LinkCand {
  norm: NormUrl
  priority: number
  why: string
  known: boolean
}

/** Optional knobs beyond the contract (server/index.ts maps env vars onto these). */
export interface CrawlerExtraOptions {
  /** Rotate dataset.jsonl into a dataset-<stamp>.jsonl archive past this size (MB). 0 = never. Default 2048. */
  datasetMaxMB?: number
  /** Keep at most this many archives, deleting the oldest. 0 = keep all (default). */
  datasetKeep?: number
}

export function createIngest(opts: CrawlerOptions & CrawlerExtraOptions): CrawlerApi {
  const genesisCount = clamp(Math.floor(Number(opts.agents) || 24), 1, MAX_AGENTS)
  const pace = Number.isFinite(opts.pace) && opts.pace >= 0 ? opts.pace : 1
  const dataDir = opts.dataDir

  // Never let a consumer's exception escape into an agent loop.
  const emit: Emit = (msg: ServerMsg) => {
    try {
      opts.emit(msg)
    } catch (e) {
      console.warn('[crawler] emit failed:', errMsg(e))
    }
  }

  // ── state ───────────────────────────────────────────────────────────────
  const hosts = new HostTable()
  const robots = new RobotsCache()
  const denylist = new DenylistFile(denylistPath(dataDir))
  // Hosts that answered a page with "Content-Signal: ai-train=no" → until (ms epoch).
  // Only used to stop queueing more of their URLs; every page is still judged on its own.
  const headerOptOut = new Map<string, number>()
  // Totals of pages in rotated-out dataset archives (persisted in ingest-state.json).
  let archived: ArchivedTotals = emptyArchived(SECTORS.length)
  const maxMB = opts.datasetMaxMB === undefined ? 2048 : Number(opts.datasetMaxMB)
  const writer = new DatasetWriter(dataDir, {
    maxBytes: Number.isFinite(maxMB) && maxMB > 0 ? maxMB * 1024 * 1024 : 0,
    keepArchives: Number(opts.datasetKeep) || 0,
    sectors: SECTORS.length,
    onRotate: async ({ totals: t }) => {
      archived.pages += t.pages
      archived.tokens += t.tokens
      archived.bytes += t.bytes
      archived.files++
      for (let i = 0; i < SECTORS.length; i++) {
        archived.sectorPages[i] = (archived.sectorPages[i] ?? 0) + (t.sectorPages[i] ?? 0)
        archived.sectorTokens[i] = (archived.sectorTokens[i] ?? 0) + (t.sectorTokens[i] ?? 0)
      }
      // Persist right away: these pages are no longer reloaded from dataset.jsonl.
      await saveState(dataDir, persistedState())
    },
  })
  const simIndex = new SimIndex()
  const contentHashes = new Set<string>()
  const storedIds = new Set<string>()
  const titleById = new Map<string, string>()
  const records: PageRecord[] = [] // oldest → newest, capped at MEMORY_PAGES
  const vecs: Float32Array[] = [] // parallel to records
  const hay: string[] = [] // parallel to records: lowercased search text, built once per page
  const recordById = new Map<string, PageRecord>()
  const semanticDups = new Set<string>()
  const domains = new Map<string, DomainRec>()
  const seedHosts = new Set<string>()
  const seedPrefixes = new Map<string, { prefix: string; sector: number }[]>()
  const sectorPages = new Array<number>(SECTORS.length).fill(0)
  const sectorTokens = new Array<number>(SECTORS.length).fill(0)
  const globalTraces = new Ring<Trace>(GLOBAL_TRACES)
  const rateWindow: { ts: number; tokens: number }[] = []
  const agents: AgentRt[] = []
  const domainEmitAt = new Map<string, number>()
  const domainTimers = new Map<string, NodeJS.Timeout>()
  const timers: NodeJS.Timeout[] = []

  const totals = { pages: 0, tokens: 0, bytes: 0, rejected: 0, dupes: 0, errors: 0 }
  let admittedHosts = 0
  let admitTokens = ADMIT_BURST
  let admitRefillAt = Date.now()
  let started = false
  let running = false
  let startedAt = 0
  let stateDirty = false
  let stopCtl = new AbortController()
  let initPromise: Promise<void> = Promise.resolve()
  let stopPromise: Promise<void> | null = null

  const frontier = new Frontier(SECTORS.length, (host) => touchDomain(host))

  // ── domains ─────────────────────────────────────────────────────────────
  function domainSnapshot(d: DomainRec): DomainInfo {
    return { ...d.info, frontier: frontier.hostSize(d.info.host) }
  }

  function emitDomain(host: string): void {
    const d = domains.get(host)
    if (!d) return
    domainEmitAt.set(host, Date.now())
    emit({ t: 'domain', domain: domainSnapshot(d) })
  }

  /** Throttled (≤ 1/s per host, trailing edge) domain update. */
  function touchDomain(host: string): void {
    const d = domains.get(host)
    if (!d) return
    d.info.frontier = frontier.hostSize(host)
    if (!running) return
    const now = Date.now()
    const last = domainEmitAt.get(host) ?? 0
    if (now - last >= 1000) {
      emitDomain(host)
    } else if (!domainTimers.has(host)) {
      const t = setTimeout(() => {
        domainTimers.delete(host)
        emitDomain(host)
      }, 1000 - (now - last))
      t.unref?.()
      domainTimers.set(host, t)
    }
  }

  function addDomain(host: string, sector: number, discovered: boolean): DomainRec {
    let d = domains.get(host)
    if (d) return d
    d = {
      info: { host, sector, pages: 0, tokens: 0, frontier: 0, avgScore: 0, firstSeen: Date.now(), discovered },
      scoreSum: 0,
    }
    domains.set(host, d)
    if (discovered) admittedHosts++
    touchDomain(host)
    return d
  }

  function refillAdmitTokens(): void {
    const now = Date.now()
    if (admitTokens >= ADMIT_BURST) admitRefillAt = now
    const add = Math.floor((now - admitRefillAt) / ADMIT_REFILL_MS)
    if (add > 0) {
      admitTokens = Math.min(ADMIT_BURST, admitTokens + add)
      admitRefillAt += add * ADMIT_REFILL_MS
    }
  }

  function takeAdmitToken(): boolean {
    refillAdmitTokens()
    if (admitTokens < 1) return false
    admitTokens--
    return true
  }

  /**
   * Why an unknown host may NOT be admitted via a redirect (same gates as a
   * discovered link: blocklist, new-domain priority floor, 250-host budget,
   * admission rate limit), or null when it may. Does not consume a token.
   */
  function redirectAdmissionBlock(n: NormUrl, priority: number): string | null {
    if (domains.has(n.host)) return null
    if (isBlockedHost(n.host, n.path)) return 'blocked host'
    if (priority < NEW_DOMAIN_MIN_PRIORITY) return `priority ${priority.toFixed(2)} below the new-domain floor ${NEW_DOMAIN_MIN_PRIORITY.toFixed(2)}`
    if (admittedHosts >= MAX_ADMITTED_HOSTS) return `new-domain budget spent (${MAX_ADMITTED_HOSTS})`
    refillAdmitTokens()
    if (admitTokens < 1) return 'new-domain admission rate limit'
    return null
  }

  /** Admit an unknown redirect target (after robots allowed it): discovered, host prior 0.5. */
  function commitRedirectAdmission(host: string, fromSector: number): boolean {
    if (domains.has(host)) return true
    if (admittedHosts >= MAX_ADMITTED_HOSTS || !takeAdmitToken()) return false
    addDomain(host, sectorForHost(host, fromSector), true)
    return true
  }

  function hostPrior(host: string): number {
    const d = domains.get(host)
    if (d && !d.info.discovered) return SECTORS[d.info.sector]?.prior ?? 0.5
    return 0.5
  }

  /** Which arm a URL belongs to: longest seed path prefix on that host, else the host's arm. */
  function urlSector(host: string, path: string, fallback: number): number {
    const prefixes = seedPrefixes.get(host)
    if (prefixes) {
      let best: { prefix: string; sector: number } | null = null
      for (const p of prefixes) {
        const under = p.prefix === '/' || path === p.prefix || path.startsWith(p.prefix.endsWith('/') ? p.prefix : p.prefix + '/')
        if (under && (!best || p.prefix.length > best.prefix.length)) best = p
      }
      if (best) return best.sector
    }
    const d = domains.get(host)
    if (d) return d.info.sector
    return sectorForHost(host, fallback)
  }

  // ── seeds ───────────────────────────────────────────────────────────────
  function initSeedHosts(): void {
    const bySeedHost = new Map<string, number[]>()
    for (const s of SECTORS) {
      for (const raw of s.seeds) {
        const n = normalizeUrl(raw)
        if (!n) continue
        seedHosts.add(n.host)
        const list = seedPrefixes.get(n.host) ?? []
        let prefix = n.path || '/'
        if (prefix.length > 1 && prefix.endsWith('/')) prefix = prefix.slice(0, -1)
        list.push({ prefix, sector: s.id })
        seedPrefixes.set(n.host, list)
        const secs = bySeedHost.get(n.host) ?? []
        if (!secs.includes(s.id)) secs.push(s.id)
        bySeedHost.set(n.host, secs)
      }
    }
    for (const [host, secs] of bySeedHost) {
      const sector = secs.length === 1 ? secs[0] : sectorForHost(host, secs[0])
      addDomain(host, sector, false)
    }
  }

  function enqueueSeeds(): number {
    let n = 0
    for (const s of SECTORS) {
      for (const raw of s.seeds) {
        const norm = normalizeUrl(raw)
        if (!norm) continue
        // The operator denylist overrides the hard-coded seeds.
        if (isDenylisted(norm.host, norm.path, norm.search)) continue
        const r = frontier.push(
          {
            url: norm.fetchUrl,
            key: norm.key,
            host: norm.host,
            sector: s.id,
            depth: 0,
            priority: 1,
            why: `seed · arm ${s.roman} ${s.name}`,
            parent: null,
            seed: true,
          },
          true,
        )
        if (r === 'ok') n++
      }
    }
    return n
  }

  // ── agents ──────────────────────────────────────────────────────────────
  function makeAgent(sector: number, slot: number, name: string, origin: 'genesis' | 'spawned', owner: string | null): AgentRt {
    const id = agents.length
    const rt: AgentRt = {
      info: {
        id,
        code: agentCode(sector, slot),
        name,
        sector,
        slot,
        state: 'idle',
        since: Date.now(),
        url: null,
        host: null,
        title: null,
        pages: 0,
        tokens: 0,
        rejected: 0,
        errors: 0,
        lastScore: null,
        origin,
        owner,
      },
      traces: new Ring<Trace>(AGENT_TRACES),
      loop: null,
      retireAt: origin === 'spawned' ? Date.now() + SPAWN_TTL_MS : 0,
      retired: false,
      loopDone: false,
    }
    agents.push(rt)
    return rt
  }

  /** Re-use a retired spawned agent's slot (ids stay stable and agents[] stays ≤ MAX_AGENTS). */
  function reviveSlot(rt: AgentRt, sector: number, slot: number, name: string, owner: string | null): void {
    rt.info = {
      ...rt.info,
      code: agentCode(sector, slot),
      name,
      sector,
      slot,
      state: 'idle',
      since: Date.now(),
      url: null,
      host: null,
      title: null,
      pages: 0,
      tokens: 0,
      rejected: 0,
      errors: 0,
      lastScore: null,
      origin: 'spawned',
      owner,
    }
    rt.traces = new Ring<Trace>(AGENT_TRACES)
    rt.loop = null
    rt.retireAt = Date.now() + SPAWN_TTL_MS
    rt.retired = false
    rt.loopDone = false
  }

  const liveAgents = () => agents.filter((a) => !a.retired)

  function retireExpired(): void {
    const now = Date.now()
    for (const rt of agents) {
      if (rt.retired || !rt.retireAt || rt.retireAt > now) continue
      rt.retired = true
      trace(rt, rt.info.id, 'idle', `retired after ${Math.round(SPAWN_TTL_MS / 3_600_000)} h — spawned agents are temporary`)
      if (!rt.loop) rt.loopDone = true
    }
  }

  for (let i = 0; i < genesisCount; i++) {
    makeAgent(i % 8, Math.floor(i / 8), AGENT_NAMES[i % AGENT_NAMES.length], 'genesis', null)
  }

  function emitAgent(rt: AgentRt): void {
    emit({ t: 'agent', agent: { ...rt.info } })
  }

  function setState(rt: AgentRt, state: AgentState, patch?: Partial<Pick<AgentInfo, 'url' | 'host' | 'title'>>): void {
    rt.info.state = state
    rt.info.since = Date.now()
    if (patch) Object.assign(rt.info, patch)
    emitAgent(rt)
  }

  function trace(rt: AgentRt | null, agentId: number, step: AgentState, msg: string, data?: Trace['data']): void {
    // Messages are template strings built from slices of page HTML/text: copy them so the
    // trace rings (thousands of entries) never pin whole documents (see own()).
    const t: Trace = { agentId, ts: Date.now(), step, msg: own(msg) }
    if (data) {
      const d: NonNullable<Trace['data']> = {}
      for (const k in data) {
        const v = data[k]
        d[k] = typeof v === 'string' ? own(v) : v
      }
      t.data = d
    }
    globalTraces.push(t)
    rt?.traces.push(t)
    emit({ t: 'trace', trace: t })
  }

  const tr = (rt: AgentRt, step: AgentState, msg: string, data?: Trace['data']) => trace(rt, rt.info.id, step, msg, data)

  async function dwell(state: AgentState, since: number): Promise<void> {
    const min = (DWELL[state] ?? 0) * pace
    if (min <= 0) return
    const left = min - (Date.now() - since)
    if (left > 0) await sleep(left, stopCtl.signal)
  }

  async function reject(rt: AgentRt, reason: string, url: string, host: string, score: number | null, data?: Trace['data']): Promise<void> {
    const t0 = Date.now()
    rt.info.rejected++
    totals.rejected++
    stateDirty = true
    setState(rt, 'reject')
    emit({ t: 'reject', agentId: rt.info.id, url, host, reason, score, ts: t0 })
    tr(rt, 'reject', reason, { url, host, score, ...(data ?? {}) })
    await dwell('reject', t0)
  }

  async function fail(rt: AgentRt, reason: string, url: string, host: string, data?: Trace['data']): Promise<void> {
    const t0 = Date.now()
    rt.info.errors++
    totals.errors++
    stateDirty = true
    setState(rt, 'error')
    tr(rt, 'error', reason, { url, host, ...(data ?? {}) })
    await dwell('error', t0)
  }

  // ── seek ────────────────────────────────────────────────────────────────
  function pickFor(sector: number): PickResult {
    const now = Date.now()
    const ready = (h: string) => hosts.isReady(h, now)
    const none: PickResult = { entry: null, stolen: false, stolenNote: '', waitMs: 0, waitReason: '', waitHost: null }

    let entry = frontier.pickFrom(sector, ready)
    if (entry) {
      hosts.tryAcquire(entry.host, now)
      return { ...none, entry }
    }
    const ownEmpty = frontier.sectorSize(sector) === 0
    entry = frontier.pickAny(sector, ready)
    if (entry) {
      hosts.tryAcquire(entry.host, now)
      return { ...none, entry, stolen: true, stolenNote: ownEmpty ? 'own arm empty' : 'own arm cooling' }
    }
    const next = frontier.nextReady((h) => hosts.readyAt(h))
    if (!next) return { ...none, waitMs: 2000, waitReason: 'frontier empty — waiting for new links' }
    if (!Number.isFinite(next.at)) {
      return { ...none, waitMs: 500, waitReason: `every queued host busy · waiting on ${next.host}`, waitHost: next.host }
    }
    const waitMs = clamp(next.at - now, 150, 3000)
    const hs = hosts.peek(next.host)
    let why = 'politeness interval'
    if (hs && hs.blockedUntil > now) why = `backoff: ${hs.blockReason ?? 'paused'}`
    else if (hs && hs.crawlDelayMs > 2000) why = 'robots.txt host delay'
    return { ...none, waitMs, waitReason: `host cooling ${fmtSec(waitMs)} (${why}) · next ${next.host}`, waitHost: next.host }
  }

  // ── fetch (robots + redirects) ──────────────────────────────────────────
  async function ensureRobots(rt: AgentRt, url: string, host: string): Promise<{ ok: true; fetched: boolean } | { ok: false; reason: string }> {
    let origin: string
    try {
      origin = new URL(url).origin
    } catch {
      return { ok: false, reason: 'bad url' }
    }
    const r = await robots.ensure(origin, stopCtl.signal)
    if (r === null) return { ok: true, fetched: false }
    if (!r.ok) {
      if (!running) return { ok: false, reason: 'stopping' }
      hosts.block(host, ROBOTS_UNAVAILABLE_PAUSE_MS, `robots.txt unavailable (${r.reason})`)
      return { ok: false, reason: `robots.txt unavailable (${r.reason}) — host paused 10 min` }
    }
    hosts.setCrawlDelay(host, r.crawlDelayMs)
    const cd = r.crawlDelayMs > 0 ? ` · host delay ${fmtSec(r.crawlDelayMs)}` : ''
    const cs = r.contentSignal ? ` · content-signal ${truncate(r.contentSignal, 60)}` : ''
    tr(rt, 'fetch', `robots.txt ${r.status} for ${host} · ${r.allowAll ? 'allow all' : 'rules loaded'}${cd}${cs} · ${r.ms} ms`, {
      host,
      status: r.status,
      crawlDelayMs: r.crawlDelayMs,
      ms: r.ms,
      ...(r.contentSignal ? { contentSignal: r.contentSignal } : {}),
    })
    return { ok: true, fetched: true }
  }

  async function acquireWithin(host: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (running) {
      if (hosts.tryAcquire(host)) return true
      if (Date.now() >= deadline) return false
      await sleep(100, stopCtl.signal)
    }
    return false
  }

  async function fetchStage(rt: AgentRt, e: QueueEntry): Promise<FetchOutcome> {
    const held = new Set<string>([e.host]) // pickFor already holds e.host
    const requested = new Set<string>() // hosts we actually sent a request to (interval is charged only for those)
    // End time of this stage's previous request per host: robots.txt GETs and every
    // redirect hop wait max(2000 ms, Crawl-delay) after it, like any other request.
    const lastReq = new Map<string, number>()
    const hopsBefore = Math.max(0, Math.floor(e.hops ?? 0))
    const originOf = (u: string) => {
      try {
        return new URL(u).origin
      } catch {
        return ''
      }
    }
    const stopping: FetchOutcome = { kind: 'skip', reason: 'stopping' }

    /** Wait out the host interval since this stage's last request to `host` (or ask to defer it). */
    async function polite(host: string): Promise<Gate> {
      const last = lastReq.get(host)
      if (last === undefined) return { kind: 'ok' }
      const wait = last + hosts.intervalMs(host) - Date.now()
      if (wait <= 0) return { kind: 'ok' }
      if (wait > MAX_INLINE_WAIT_MS) return { kind: 'defer' }
      setState(rt, 'sleep')
      const why = hosts.get(host).crawlDelayMs > 2000 ? 'robots.txt host delay' : 'politeness interval'
      tr(rt, 'sleep', `host cooling ${fmtSec(wait)} (${why} · ${host})`, { host, ms: wait })
      await sleep(wait, stopCtl.signal)
      if (!running) return { kind: 'stop' }
      setState(rt, 'fetch')
      return { kind: 'ok' }
    }

    /** Make sure robots.txt for the origin of `url` is known; a fresh fetch counts as a request to `host`. */
    async function robotsFor(url: string, host: string): Promise<Gate> {
      const origin = originOf(url)
      if (!robots.has(origin)) {
        const g = await polite(host)
        if (g.kind !== 'ok') return g
      }
      const cached = robots.has(origin)
      const r = await ensureRobots(rt, url, host)
      if (!cached) {
        requested.add(host)
        lastReq.set(host, Date.now())
      }
      if (!r.ok) return running ? { kind: 'fail', reason: r.reason } : { kind: 'stop' }
      return { kind: 'ok' }
    }

    /** Hand the current URL back to the frontier (long Crawl-delay); release() charges the host's nextAt. */
    const defer = (url: string, key: string, host: string, hops: number): FetchOutcome => {
      frontier.push({ ...e, url, key, host, sector: urlSector(host, normalizeUrl(url)?.path ?? '/', e.sector), hops }, true)
      return { kind: 'skip', reason: `host delay ${fmtSec(hosts.intervalMs(host))} on ${host} · requeued` }
    }

    try {
      // Operator denylist: never send anything to a listed host, not even for robots.txt
      // (the frontier is purged when the list changes; this catches the rest).
      if (isDenylistedUrl(e.url)) return { kind: 'skip', reason: `${e.host} is on the operator denylist · dropped` }
      const g0 = await robotsFor(e.url, e.host)
      if (g0.kind === 'stop') return stopping
      if (g0.kind === 'fail') return { kind: 'error', reason: g0.reason, url: e.url, host: e.host }
      if (g0.kind === 'defer') return defer(e.url, e.key, e.host, hopsBefore)
      if (!robots.isAllowed(e.url)) return { kind: 'reject', reason: 'blocked by robots.txt', url: e.url, host: e.host }

      const t0 = Date.now()
      let url = e.url
      let key = e.key
      let host = e.host
      let redirects = 0
      for (;;) {
        const g = await polite(host)
        if (g.kind === 'stop') return stopping
        if (g.kind === 'defer') return defer(url, key, host, hopsBefore + redirects)
        // Re-checked per request: the list may have changed during robots.txt / a politeness wait.
        if (isDenylistedUrl(url)) return { kind: 'skip', reason: `${host} is on the operator denylist · dropped` }

        let res: FetchOnceResult
        requested.add(host)
        try {
          // 12 s budget per request (each redirect hop is its own request).
          res = await fetchOnce(url, AbortSignal.any([stopCtl.signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]))
        } catch (err) {
          lastReq.set(host, Date.now())
          const info = describeFetchError(err)
          if (info.aborted || !running) return stopping
          const tripped = hosts.recordError(host, info.msg)
          return {
            kind: 'error',
            reason: `GET failed — ${info.msg}${tripped ? ' · host backed off 5 min' : ''}`,
            url,
            host,
            data: { ms: Date.now() - t0, code: info.code },
          }
        }
        lastReq.set(host, Date.now())

        if (res.kind === 'redirect' && res.location) {
          redirects++
          if (hopsBefore + redirects > MAX_REDIRECTS) return { kind: 'error', reason: `too many redirects (> ${MAX_REDIRECTS})`, url, host }
          const n = normalizeUrl(res.location)
          if (!n) return { kind: 'reject', reason: `redirect to non-fetchable url`, url, host, data: { status: res.status } }
          const skip = skipReason(n)
          if (skip) return { kind: 'reject', reason: `redirect to ${skip} (${shortUrl(n.fetchUrl, 48)})`, url, host }
          // An unknown host is admitted exactly like a discovered link — checked before
          // any request goes to it, committed once its robots.txt allows the target.
          const unknown = !domains.has(n.host)
          if (unknown) {
            const why = redirectAdmissionBlock(n, e.priority)
            if (why) return { kind: 'reject', reason: `redirect to unadmitted host ${n.host} (${why})`, url, host, data: { status: res.status } }
          }
          if (n.host !== host && !held.has(n.host)) {
            if (!(await acquireWithin(n.host, REDIRECT_HOST_WAIT_MS))) {
              if (!running) return stopping
              if (unknown || hopsBefore + redirects >= MAX_REDIRECTS) return { kind: 'skip', reason: `redirect → ${n.host} busy · dropped` }
              // Known target host busy/cooling: hand the URL back to the frontier instead of hammering it.
              const pr = frontier.push({
                ...e,
                url: n.fetchUrl,
                key: n.key,
                host: n.host,
                sector: urlSector(n.host, n.path, e.sector),
                priority: Math.max(0, e.priority - 0.01),
                hops: hopsBefore + redirects,
              })
              return { kind: 'skip', reason: `redirect → ${n.host} busy · ${pr === 'ok' ? 'requeued' : `not requeued (${pr})`}` }
            }
            held.add(n.host)
          }
          // New origin (other host, or http → https): its own robots.txt applies.
          if (originOf(n.fetchUrl) !== originOf(url)) {
            const gr = await robotsFor(n.fetchUrl, n.host)
            if (gr.kind === 'stop') return stopping
            if (gr.kind === 'fail') return { kind: 'error', reason: gr.reason, url: n.fetchUrl, host: n.host }
            if (gr.kind === 'defer') {
              if (unknown) return { kind: 'skip', reason: `redirect → ${n.host} cooling · dropped` }
              return defer(n.fetchUrl, n.key, n.host, hopsBefore + redirects)
            }
          }
          if (!robots.isAllowed(n.fetchUrl)) {
            return { kind: 'reject', reason: `blocked by robots.txt (redirect → ${shortUrl(n.fetchUrl, 48)})`, url: n.fetchUrl, host: n.host }
          }
          if (unknown) {
            if (!commitRedirectAdmission(n.host, e.sector)) {
              return { kind: 'reject', reason: `redirect to unadmitted host ${n.host} (new-domain budget / rate limit)`, url, host }
            }
            const d = domains.get(n.host)
            tr(rt, 'fetch', `admitted new domain ${n.host} via redirect → arm ${ROMAN[d?.info.sector ?? e.sector]}`, { host: n.host, sector: d?.info.sector ?? e.sector })
          }
          frontier.markSeen(n.key)
          url = n.fetchUrl
          key = n.key
          host = n.host
          continue
        }

        if (res.kind === 'http-error' || res.kind === 'redirect') {
          const st = res.status
          if (st === 429 || st === 503) {
            const pause = clamp(res.retryAfterMs ?? 60_000, 60_000, 30 * 60_000)
            hosts.block(host, pause, `HTTP ${st}`)
          }
          let tripped = false
          if (st >= 500 || st === 429 || st === 403) tripped = hosts.recordError(host, `HTTP ${st}`)
          else hosts.recordSuccess(host)
          return {
            kind: 'error',
            reason: `GET ${st}${st === 404 ? ' · not found' : st === 403 ? ' · forbidden' : st === 429 ? ' · rate limited, host paused' : ''}${tripped ? ' · host backed off 5 min' : ''}`,
            url,
            host,
            data: { status: st, ms: res.ms },
          }
        }

        hosts.recordSuccess(host)
        if (res.kind === 'non-html') {
          return { kind: 'reject', reason: `non-html (${res.contentType || 'unknown'})`, url, host, data: { status: res.status } }
        }
        const final = normalizeUrl(url)
        if (!final) return { kind: 'reject', reason: 'unusable final url', url, host }
        return { kind: 'page', res, finalUrl: url, final, redirects, totalMs: Date.now() - t0 }
      }
    } finally {
      for (const h of held) hosts.release(h, requested.has(h))
    }
  }

  // ── links → frontier ────────────────────────────────────────────────────
  function enqueueLinks(ex: Extracted, from: NormUrl, fromSector: number, depth: number, pageScore: number): { picks: FrontierPick[]; total: number; newDomains: string[]; optOut: number } {
    const out = { picks: [] as FrontierPick[], total: 0, newDomains: [] as string[], optOut: 0 }
    if (depth > MAX_DEPTH) return out
    const cands = new Map<string, LinkCand>()
    for (const l of ex.links) {
      // rel="nofollow" / "ugc" / "sponsored": user-posted or paid links are never followed
      // (on Discourse forums these are exactly the spam vectors for new-domain admission).
      if (l.nofollow) continue
      const n = normalizeUrl(l.url)
      if (!n || n.key === from.key || cands.has(n.key)) continue
      if (skipReason(n)) continue
      if (frontier.hasSeen(n.key)) continue
      const known = domains.has(n.host)
      if (!known && isBlockedHost(n.host, n.path)) continue
      // Don't waste a frontier slot on a URL the host's (cached) robots.txt already forbids.
      if (!robots.isAllowed(n.fetchUrl)) continue
      // …nor fetch pages whose text could never be kept: the site opted out of AI
      // training (Content-Signal ai-train=no or an AI-crawler disallow) for this URL.
      const hdrUntil = headerOptOut.get(n.host)
      if ((hdrUntil !== undefined && hdrUntil > Date.now()) || robots.aiTrainSignal(n.fetchUrl)?.value === 'no' || robots.trainingOptOut(n.fetchUrl)) {
        out.optOut++
        continue
      }

      const a = phraseHits(l.text)
      const p = phraseHits(pathWords(n.path))
      const anchorW = a.weight + 0.6 * p.weight
      const anchorScore = 1 - Math.exp(-anchorW / 1.2)
      const prior = hostPrior(n.host)
      const pen = pathPenalty(n)
      const priority = clamp(0.45 * anchorScore + 0.25 * pageScore + 0.2 * prior + 0.1 / (1 + depth) - (pen?.amount ?? 0), 0, 1)
      if (known ? priority < KNOWN_HOST_MIN_PRIORITY : priority < NEW_DOMAIN_MIN_PRIORITY) continue

      const bits: string[] = []
      if (l.text) bits.push(`anchor '${truncate(l.text, 40)}'`)
      if (p.best && (!a.best || p.weight > a.weight)) bits.push(`path '${p.best}'`)
      bits.push(`parent ${pageScore.toFixed(2)}`)
      bits.push(`host prior ${prior.toFixed(2)}`)
      bits.push(`depth ${depth}`)
      if (pen) bits.push(`−${pen.amount.toFixed(2)} ${pen.label}`)
      if (!known) bits.push('new domain')
      cands.set(n.key, { norm: n, priority, why: bits.join(' · '), known })
    }

    const sorted = [...cands.values()].sort((x, y) => y.priority - x.priority).slice(0, MAX_NEW_LINKS_PER_PAGE)
    for (const c of sorted) {
      const n = c.norm
      if (!domains.has(n.host)) {
        if (admittedHosts >= MAX_ADMITTED_HOSTS || out.newDomains.length >= MAX_NEW_DOMAINS_PER_PAGE || !takeAdmitToken()) continue
        addDomain(n.host, sectorForHost(n.host, fromSector), true)
        out.newDomains.push(n.host)
      }
      const r = frontier.push({
        url: n.fetchUrl,
        key: n.key,
        host: n.host,
        sector: urlSector(n.host, n.path, fromSector),
        depth,
        priority: c.priority,
        why: c.why,
        parent: from.fetchUrl,
        seed: false,
      })
      if (r !== 'ok') continue
      out.total++
      if (out.picks.length < 6) out.picks.push({ url: n.fetchUrl, score: Math.round(c.priority * 100) / 100, why: c.why })
    }
    return out
  }

  // ── store ───────────────────────────────────────────────────────────────
  /**
   * Bound the dedupe memory of an endless crawl: forget ids, titles, content
   * hashes and simhashes of all but the newest MAX_DEDUPE_PAGES pages (Sets and
   * Maps iterate in insertion order, so the first keys are the oldest). A page
   * older than the window may be stored again if it is ever re-crawled.
   */
  function trimDedupe(): void {
    const t0 = Date.now()
    const dropOldest = (c: Set<string> | Map<string, unknown>, keep: number) => {
      let n = c.size - keep
      if (n <= 0) return
      for (const k of c.keys()) {
        if (n-- <= 0) break
        c.delete(k)
      }
    }
    dropOldest(storedIds, MAX_DEDUPE_PAGES)
    dropOldest(titleById, MAX_DEDUPE_PAGES)
    dropOldest(contentHashes, MAX_DEDUPE_PAGES)
    simIndex.retainNewest(MAX_DEDUPE_PAGES)
    console.log(`[crawler] dedupe window trimmed to the newest ${fmtInt(MAX_DEDUPE_PAGES)} pages (${Date.now() - t0} ms)`)
  }

  function remember(rec: PageRecord, vec: Float32Array, sim: Sim64, hash: string, key: string | null): void {
    records.push(rec)
    vecs.push(vec)
    hay.push(`${rec.title}\n${rec.url}\n${rec.terms.join(' ')}\n${rec.excerpt}`.toLowerCase())
    recordById.set(rec.id, rec)
    // Evict the oldest in chunks (amortized O(1); a per-page shift() is O(n) and
    // would make reloading a large dataset quadratic).
    if (records.length > MEMORY_PAGES + EVICT_CHUNK) {
      const drop = records.length - MEMORY_PAGES
      const old = records.splice(0, drop)
      vecs.splice(0, drop)
      hay.splice(0, drop)
      for (const o of old) recordById.delete(o.id)
    }
    storedIds.add(rec.id)
    titleById.set(rec.id, rec.title)
    simIndex.add(sim, rec.id)
    if (hash) contentHashes.add(hash)
    if (storedIds.size > MAX_DEDUPE_PAGES + DEDUPE_EVICT_CHUNK) trimDedupe()
    if (key) frontier.markSeen(key)
    totals.pages++
    totals.tokens += rec.tokens
    totals.bytes += rec.bytes
    if (rec.sector >= 0 && rec.sector < SECTORS.length) {
      sectorPages[rec.sector]++
      sectorTokens[rec.sector] += rec.tokens
    }
    // Live pages always come from an admitted host (step() refuses anything else), so this
    // only creates domain records when reloading a dataset written by an earlier run.
    const d = domains.get(rec.host) ?? addDomain(rec.host, sectorForHost(rec.host, rec.sector), !seedHosts.has(rec.host))
    d.info.pages++
    d.info.tokens += rec.tokens
    d.scoreSum += rec.score
    d.info.avgScore = Math.round((d.scoreSum / d.info.pages) * 1000) / 1000
    touchDomain(rec.host)
  }

  // ── operator denylist ───────────────────────────────────────────────────
  /**
   * Hide stored pages of denylisted URLs from search / recent / GPU jobs (the
   * in-memory views; dataset.jsonl is not rewritten). Order is preserved.
   */
  function hideDeniedPages(): number {
    let w = 0
    for (let r = 0; r < records.length; r++) {
      const rec = records[r]
      if (isDenylistedUrl(rec.url)) {
        if (recordById.get(rec.id) === rec) recordById.delete(rec.id)
        continue
      }
      if (w !== r) {
        records[w] = rec
        vecs[w] = vecs[r]
        hay[w] = hay[r]
      }
      w++
    }
    const n = records.length - w
    records.length = w
    vecs.length = w
    hay.length = w
    return n
  }

  /** Re-read denylist.json; on a change drop matching queued URLs and hide matching pages. */
  function reloadDenylist(force = false): void {
    const r = denylist.reload(force)
    if (!r.changed && !force) return
    const dropped = frontier.dropWhere((q) => isDenylistedUrl(q.url))
    const hidden = hideDeniedPages()
    if (r.changed || dropped || hidden) {
      console.log(`[crawler] denylist ${denylist.path}: ${r.size} entr${r.size === 1 ? 'y' : 'ies'} · dropped ${fmtInt(dropped)} queued URLs · hid ${fmtInt(hidden)} stored pages`)
    }
  }

  // ── the agent loop ──────────────────────────────────────────────────────
  async function step(rt: AgentRt): Promise<void> {
    const a = rt.info

    // SEEK
    const tSeek = Date.now()
    setState(rt, 'seek', { url: null, host: null, title: null })
    const pick = pickFor(a.sector)
    if (!pick.entry) {
      setState(rt, 'sleep')
      tr(rt, 'sleep', pick.waitReason, { ms: pick.waitMs, host: pick.waitHost })
      await sleep(pick.waitMs, stopCtl.signal)
      return
    }
    const e = pick.entry
    try {
      a.url = e.url
      a.host = e.host
      emitAgent(rt)
      const steal = pick.stolen ? ` · stolen from arm ${ROMAN[e.sector]} (${pick.stolenNote})` : ''
      tr(rt, 'seek', `picked ${shortUrl(e.url, 64)} · priority ${e.priority.toFixed(2)} — ${e.why}${steal}`, {
        url: e.url,
        host: e.host,
        priority: Math.round(e.priority * 1000) / 1000,
        depth: e.depth,
        sector: e.sector,
        stolen: pick.stolen,
      })
      await dwell('seek', tSeek)
      if (!running) {
        hosts.release(e.host, false)
        return
      }
      // FETCH (fetchStage owns and releases the host lock)
      setState(rt, 'fetch', { url: e.url, host: e.host })
    } catch (err) {
      hosts.release(e.host, false)
      throw err
    }
    const fetched = await fetchStage(rt, e)

    if (fetched.kind === 'skip') {
      if (running && fetched.reason !== 'stopping') tr(rt, 'fetch', fetched.reason)
      return
    }
    if (fetched.kind === 'error') return fail(rt, fetched.reason, fetched.url, fetched.host, fetched.data)
    if (fetched.kind === 'reject') return reject(rt, fetched.reason, fetched.url, fetched.host, null, fetched.data)

    const { res, final, finalUrl, redirects, totalMs } = fetched
    const via = redirects > 0 ? ` · ${redirects} redirect${redirects > 1 ? 's' : ''} → ${shortUrl(finalUrl, 48)}` : ''
    tr(rt, 'fetch', `GET ${res.status} · ${fmtKB(res.bytes)}${res.truncated ? ' (capped)' : ''} · ${fmtInt(totalMs)} ms${via}`, {
      status: res.status,
      kb: Math.round(res.bytes / 1024),
      ms: totalMs,
      redirects,
      url: finalUrl,
    })

    // PARSE
    const tParse = Date.now()
    setState(rt, 'parse', { url: finalUrl, host: final.host })
    let ex: Extracted
    try {
      ex = extract(res.html, finalUrl)
    } catch (err) {
      return reject(rt, `unparseable html (${truncate(errMsg(err), 60)})`, finalUrl, final.host, null)
    }
    if (!ex.title) ex.title = shortUrl(finalUrl, 80)
    ex.title = own(ex.title) // kept in records + the title index: must not pin the HTML
    a.title = ex.title
    frontier.markSeen(final.key)
    let canonKey: string | null = null
    if (ex.canonical) {
      const cn = normalizeUrl(ex.canonical)
      if (cn && cn.host === final.host) {
        canonKey = cn.key
        frontier.markSeen(cn.key)
      }
    }
    const xr = (res.xRobotsTag ?? '').toLowerCase()
    const noindex = ex.noindex || xr.includes('noindex') || xr.includes('none')
    const nofollow = ex.nofollow || xr.includes('nofollow') || xr.includes('none')
    // Text-and-data-mining reservations: accepted text trains SEPIA, so these opt-outs bind us.
    const tdmHeader = (res.tdmReservation ?? '').trim() === '1'
    const tdmReserved = ex.tdmReserved || tdmHeader || /(^|[\s,])noai($|[\s,])/.test(xr)
    const aiOptOut = tdmReserved ? null : robots.trainingOptOut(finalUrl)
    // Content-Signal (contentsignals.org) from the response header or robots.txt: either "ai-train=no" opts out.
    const csHeader = parseContentSignal(res.contentSignal)['ai-train'] ?? null
    const csRobots = robots.aiTrainSignal(finalUrl)
    const aiTrainNo = csHeader === 'no' || csRobots?.value === 'no'
    if (csHeader === 'no') {
      headerOptOut.delete(final.host) // re-insert: Map order = age order for the trim below
      headerOptOut.set(final.host, Date.now() + ROBOTS_TTL_MS)
      if (headerOptOut.size > MAX_HEADER_OPTOUT_HOSTS) headerOptOut.delete(headerOptOut.keys().next().value as string)
    }
    // Accusation boards name and accuse real people: never stored, their links not followed.
    const board = accusationBoard(final.host, ex.text)

    const prior = hostPrior(final.host)
    const tasted: TasteResult = taste(ex.text, prior)
    const pageSector = urlSector(final.host, final.path, e.sector)
    const disc = nofollow || board ? { picks: [], total: 0, newDomains: [] as string[], optOut: 0 } : enqueueLinks(ex, final, pageSector, e.depth + 1, tasted.score)
    const relNofollow = nofollow ? 0 : ex.links.reduce((n, l) => n + (l.nofollow ? 1 : 0), 0)
    emitAgent(rt)
    const newDom = disc.newDomains.length ? ` · ${disc.newDomains.length} new domain${disc.newDomains.length > 1 ? 's' : ''}` : ''
    const optOutStr = disc.optOut ? ` · ${fmtInt(disc.optOut)} AI-opt-out links skipped` : ''
    tr(
      rt,
      'parse',
      `extracted ${fmtInt(ex.words)} words · ${fmtInt(ex.links.length)} links · title '${truncate(ex.title, 64)}' · +${fmtInt(disc.total)} to frontier${newDom}${nofollow ? ' · nofollow' : ''}${relNofollow ? ` · ${fmtInt(relNofollow)} rel=nofollow skipped` : ''}${optOutStr}`,
      { words: ex.words, links: ex.links.length, newLinks: disc.total, newDomains: disc.newDomains.length, relNofollow, optOutLinks: disc.optOut },
    )
    for (const h of disc.newDomains) {
      const d = domains.get(h)
      tr(rt, 'parse', `admitted new domain ${h} → arm ${ROMAN[d?.info.sector ?? pageSector]}`, { host: h, sector: d?.info.sector ?? pageSector })
    }
    emit({ t: 'discover', agentId: a.id, from: finalUrl, picks: disc.picks, total: disc.total, ts: Date.now() })
    await dwell('parse', tParse)
    if (!running) return

    // TASTE
    const tTaste = Date.now()
    a.lastScore = Math.round(tasted.score * 1000) / 1000
    setState(rt, 'taste')
    const label = tasted.score >= 0.75 ? 'strong' : tasted.score >= 0.55 ? 'good' : tasted.score >= ACCEPT_SCORE ? 'fair' : 'weak'
    const termStr = tasted.top.length ? tasted.top.slice(0, 3).map(([t, n]) => `${t} ×${n}`).join(', ') : 'no crypto terms'
    const text = ex.text.length > MAX_TEXT_CHARS ? ex.text.slice(0, MAX_TEXT_CHARS) : ex.text
    let tokens = 0
    const keepable = tasted.score >= ACCEPT_SCORE && tasted.distinct >= MIN_DISTINCT_TERMS && !noindex && !tdmReserved && !aiOptOut && !aiTrainNo && !board
    if (keepable && text.length > 0) {
      try {
        tokens = encode(text).length
      } catch {
        tokens = Math.round(text.length / 4)
      }
    }
    tr(rt, 'taste', `tasted ${tasted.score.toFixed(2)} — ${label}: ${termStr}`, {
      score: Math.round(tasted.score * 1000) / 1000,
      hitsPer1000: Math.round(tasted.hitsPer1000 * 10) / 10,
      words: tasted.words,
      distinct: tasted.distinct,
      core: tasted.core,
      tokens,
      terms: tasted.terms.join(', '),
    })
    await dwell('taste', tTaste)
    if (!running) return
    if (noindex) return reject(rt, 'dropped — page asks noindex (meta robots)', finalUrl, final.host, tasted.score)
    if (tdmReserved) {
      return reject(rt, `dropped — TDM rights reserved (${tdmHeader ? 'tdm-reservation header' : ex.tdmReserved ? 'tdm-reservation / noai meta' : 'X-Robots-Tag noai'})`, finalUrl, final.host, tasted.score)
    }
    if (aiTrainNo) {
      return reject(rt, 'dropped — AI-training opt-out (content-signal)', finalUrl, final.host, tasted.score, {
        source: csHeader === 'no' ? 'header' : 'robots.txt',
        contentSignal: csHeader === 'no' ? truncate(res.contentSignal ?? '', 160) : (csRobots?.raw ?? null),
      })
    }
    if (aiOptOut) return reject(rt, `dropped — TDM rights reserved (robots.txt disallows ${aiOptOut})`, finalUrl, final.host, tasted.score)
    if (board) return reject(rt, `dropped — accusation board (${board}) · posts about named people are not collected`, finalUrl, final.host, tasted.score)
    if (ex.words < 20) return reject(rt, `dropped — no readable text (${ex.words} words; JS-rendered page?)`, finalUrl, final.host, tasted.score)
    if (tasted.score < ACCEPT_SCORE) {
      return reject(rt, `dropped — low relevance ${tasted.score.toFixed(2)} (needs ${ACCEPT_SCORE.toFixed(2)})`, finalUrl, final.host, tasted.score)
    }
    if (tasted.distinct < MIN_DISTINCT_TERMS) {
      return reject(rt, `dropped — too few distinct crypto terms (${tasted.distinct}, needs ${MIN_DISTINCT_TERMS})`, finalUrl, final.host, tasted.score)
    }
    if (tokens < MIN_TOKENS) return reject(rt, `dropped — too thin: ${tokens} tokens (needs ${MIN_TOKENS})`, finalUrl, final.host, tasted.score, { tokens })
    if (!domains.has(final.host)) return reject(rt, `dropped — ${final.host} was never admitted`, finalUrl, final.host, tasted.score)
    // The denylist may have changed while this page was in flight.
    if (isDenylistedUrl(finalUrl)) return reject(rt, `dropped — ${final.host} is on the operator denylist`, finalUrl, final.host, tasted.score)

    // DEDUPE
    const tDedupe = Date.now()
    setState(rt, 'dedupe')
    const id = pageIdFor(final.key)
    if (storedIds.has(id) || (canonKey && storedIds.has(pageIdFor(canonKey)))) {
      await dwell('dedupe', tDedupe)
      return reject(rt, `revisit — already in dataset (harvested ${disc.total} new links)`, finalUrl, final.host, tasted.score)
    }
    const hash = sha1hex(text)
    if (contentHashes.has(hash)) {
      totals.dupes++
      await dwell('dedupe', tDedupe)
      return reject(rt, 'dropped — exact duplicate of a stored page', finalUrl, final.host, tasted.score, { hamming: 0 })
    }
    const sim = simhash64(text)
    const near = simIndex.findNear(sim, NEAR_DUP_HAMMING)
    if (near) {
      totals.dupes++
      const t = titleById.get(near.ref) ?? near.ref
      tr(rt, 'dedupe', `simhash ${simShort(sim)} · nearest hamming ${near.dist} → near-duplicate`, { simhash: simToHex(sim), hamming: near.dist })
      await dwell('dedupe', tDedupe)
      return reject(rt, `dropped — near-duplicate of '${truncate(t, 60)}' (hamming ${near.dist})`, finalUrl, final.host, tasted.score, {
        hamming: near.dist,
        dupOf: near.ref,
      })
    }
    const nearest = simIndex.nearestDistance(sim)
    tr(rt, 'dedupe', `simhash ${simShort(sim)} · nearest hamming ${nearest ? nearest.dist : 64} → unique`, {
      simhash: simToHex(sim),
      hamming: nearest ? nearest.dist : 64,
    })
    await dwell('dedupe', tDedupe)
    if (!running) return

    // STORE
    const tStore = Date.now()
    setState(rt, 'store')
    const vec = vectorize(ex.title + '\n' + text)
    const rec: PageRecord = {
      id,
      url: finalUrl,
      host: final.host,
      title: ex.title,
      sector: pageSector,
      agentId: a.id,
      depth: e.depth,
      score: Math.round(tasted.score * 1000) / 1000,
      tokens,
      bytes: res.bytes,
      links: ex.links.length,
      simhash: simToHex(sim),
      terms: tasted.terms,
      excerpt: own(text.slice(0, EXCERPT_CHARS)), // a bare slice would pin the full text
      ts: Date.now(),
    }
    remember(rec, vec, sim, hash, final.key)
    rateWindow.push({ ts: rec.ts, tokens })
    prunedRate(rec.ts) // keep the window bounded even when stats() is never polled
    a.pages++
    a.tokens += tokens
    const line: DatasetLine = {
      id: rec.id,
      url: rec.url,
      host: rec.host,
      title: rec.title,
      sector: rec.sector,
      score: rec.score,
      tokens: rec.tokens,
      terms: rec.terms,
      ts: rec.ts,
      text,
      agentId: rec.agentId,
      depth: rec.depth,
      bytes: rec.bytes,
      links: rec.links,
      simhash: rec.simhash,
      hash,
      vec: f32ToB64(vec),
      // What the opt-out checks saw at fetch time (a stored page passed all of them).
      prov: {
        robotsStatus: robots.statusFor(finalUrl),
        robotsAllowed: true,
        tdm: false,
        aiTrain: csHeader === 'yes' || csRobots?.value === 'yes' ? 'yes' : null,
      },
    }
    void writer.append(line)
    try {
      opts.onText(text, rec)
    } catch (err) {
      console.warn('[crawler] onText failed:', errMsg(err))
    }
    emit({ t: 'page', page: rec })
    tr(rt, 'store', `+${fmtInt(tokens)} tokens → dataset #${fmtInt(totals.pages)}`, { tokens, pages: totals.pages, id: rec.id })
    emitAgent(rt)
    await dwell('store', tStore)
  }

  async function runAgent(rt: AgentRt, delay: number): Promise<void> {
    await sleep(delay, stopCtl.signal)
    while (running && !rt.retired) {
      try {
        await step(rt)
      } catch (err) {
        // A bug in one step must never kill the sucker (or the process).
        console.warn(`[crawler] agent ${rt.info.code} step failed:`, err)
        try {
          rt.info.errors++
          totals.errors++
          setState(rt, 'error')
          tr(rt, 'error', `internal error — ${truncate(errMsg(err), 100)}`)
        } catch {
          /* ignore */
        }
        await sleep(1500, stopCtl.signal)
      }
    }
    try {
      setState(rt, 'idle', { url: null, host: null })
    } catch {
      /* ignore */
    }
  }

  function launch(rt: AgentRt, delay: number): void {
    rt.loopDone = false
    rt.loop = runAgent(rt, delay)
      .catch((err) => console.warn('[crawler] agent loop crashed:', err))
      .finally(() => {
        rt.loopDone = true
      })
  }

  // ── persistence ─────────────────────────────────────────────────────────
  async function loadPersisted(): Promise<void> {
    ensureDir(dataDir)
    const t0 = Date.now()
    const { ok, bad } = await loadDataset(writer.path, (l) => {
      const n = normalizeUrl(l.url)
      const key = n ? n.key : null
      if (storedIds.has(l.id)) return
      const text = l.text ?? ''
      let vec: Float32Array | null = null
      if (typeof l.vec === 'string') {
        try {
          const v = b64ToF32(l.vec)
          if (v.length === VEC_DIM) vec = v
        } catch {
          vec = null
        }
      }
      if (!vec) vec = vectorize((l.title ?? '') + '\n' + text)
      const sim = (l.simhash && simFromHex(l.simhash)) || simhash64(text)
      const hash = typeof l.hash === 'string' ? l.hash : sha1hex(text)
      const sector = Number.isInteger(l.sector) && l.sector >= 0 && l.sector < SECTORS.length ? l.sector : sectorForHost(l.host, 5)
      const rec: PageRecord = {
        id: l.id,
        url: l.url,
        host: l.host,
        title: own(typeof l.title === 'string' && l.title ? l.title : shortUrl(l.url, 80)),
        sector,
        agentId: Number.isInteger(l.agentId) ? (l.agentId as number) : 0,
        depth: Number.isFinite(l.depth) ? (l.depth as number) : 0,
        score: Number.isFinite(l.score) ? l.score : 0,
        tokens: l.tokens,
        bytes: Number.isFinite(l.bytes) ? (l.bytes as number) : 0,
        links: Number.isFinite(l.links) ? (l.links as number) : 0,
        simhash: simToHex(sim),
        terms: Array.isArray(l.terms) ? l.terms.filter((t) => typeof t === 'string').slice(0, 6) : [],
        excerpt: own(text.slice(0, EXCERPT_CHARS)),
        ts: Number.isFinite(l.ts) ? l.ts : Date.now(),
      }
      remember(rec, vec, sim, hash, key)
      writer.noteExisting(rec)
    })
    if (ok || bad) console.log(`[crawler] reloaded ${fmtInt(ok)} pages from dataset.jsonl${bad ? ` (${bad} corrupt lines skipped)` : ''} in ${Date.now() - t0} ms`)
    const st = await loadState(dataDir)
    if (st) {
      totals.rejected = st.rejected
      totals.errors = st.errors
      totals.dupes = st.dupes
      for (const id of st.semanticDups) semanticDups.add(id)
      if (st.archived && st.archived.pages > 0) {
        // Pages in rotated-out archives still count towards the lifetime totals.
        archived = { ...emptyArchived(SECTORS.length), ...st.archived }
        totals.pages += archived.pages
        totals.tokens += archived.tokens
        totals.bytes += archived.bytes
        for (let i = 0; i < SECTORS.length; i++) {
          archived.sectorPages[i] = archived.sectorPages[i] ?? 0
          archived.sectorTokens[i] = archived.sectorTokens[i] ?? 0
          sectorPages[i] += archived.sectorPages[i]
          sectorTokens[i] += archived.sectorTokens[i]
        }
        console.log(`[crawler] +${fmtInt(archived.pages)} pages in ${archived.files} rotated dataset archive(s) counted in totals`)
      }
    }
  }

  function persistedState() {
    return {
      rejected: totals.rejected,
      errors: totals.errors,
      dupes: totals.dupes,
      semanticDups: [...semanticDups].slice(-20_000),
      archived,
    }
  }

  async function init(): Promise<void> {
    // The denylist must be active before any seed is queued or any page reloaded.
    reloadDenylist(true)
    initSeedHosts()
    await loadPersisted()
    const hidden = hideDeniedPages()
    if (hidden > 0) console.log(`[crawler] denylist: ${fmtInt(hidden)} reloaded pages hidden from search / recent / GPU jobs`)
    enqueueSeeds()
    for (const d of domains.values()) touchDomain(d.info.host)
    const denyEvery = denylistReloadMs()
    if (denyEvery > 0) {
      const denyTimer = setInterval(() => {
        try {
          reloadDenylist()
        } catch (e) {
          console.warn('[crawler] denylist reload failed:', errMsg(e))
        }
      }, denyEvery)
      denyTimer.unref?.()
      timers.push(denyTimer)
    }
    const reseed = setInterval(() => {
      try {
        const n = enqueueSeeds()
        if (n > 0) console.log(`[crawler] re-seeded ${n} hub pages`)
      } catch (e) {
        console.warn('[crawler] reseed failed:', errMsg(e))
      }
    }, RESEED_EVERY_MS)
    reseed.unref?.()
    timers.push(reseed)
    const saver = setInterval(() => {
      if (!stateDirty) return
      stateDirty = false
      void saveState(dataDir, persistedState())
    }, STATE_SAVE_EVERY_MS)
    saver.unref?.()
    timers.push(saver)
    const retirer = setInterval(() => {
      try {
        retireExpired()
      } catch (e) {
        console.warn('[crawler] retire check failed:', errMsg(e))
      }
    }, RETIRE_CHECK_MS)
    retirer.unref?.()
    timers.push(retirer)
  }

  function prunedRate(now: number): { pages: number; tokens: number } {
    while (rateWindow.length && now - rateWindow[0].ts > RATE_WINDOW_MS) rateWindow.shift()
    let tokens = 0
    for (const r of rateWindow) tokens += r.tokens
    return { pages: rateWindow.length, tokens }
  }

  function agentFor(id: number | undefined, sector: number | undefined): AgentRt | null {
    if (id !== undefined && agents[id]) return agents[id]
    if (sector !== undefined) {
      const same = agents.find((x) => x.info.sector === sector)
      if (same) return same
    }
    return agents[0] ?? null
  }

  // ── public API ──────────────────────────────────────────────────────────
  const api: CrawlerApi = {
    start(): void {
      if (started) return
      started = true
      running = true
      startedAt = Date.now()
      stopCtl = new AbortController()
      initPromise = init()
        .catch((e) => console.warn('[crawler] init failed (continuing with seeds):', errMsg(e)))
        .then(() => {
          if (!running) return
          if (frontier.size() === 0) enqueueSeeds()
          const n = agents.length
          agents.forEach((rt, i) => launch(rt, Math.round((i / Math.max(1, n)) * STAGGER_MS)))
        })
    },

    stop(): Promise<void> {
      if (stopPromise) return stopPromise
      if (!started) return Promise.resolve()
      running = false
      stopCtl.abort()
      for (const t of timers) clearInterval(t)
      for (const t of domainTimers.values()) clearTimeout(t)
      domainTimers.clear()
      stopPromise = (async () => {
        try {
          await initPromise
          const loops = agents.map((a) => a.loop).filter((p): p is Promise<void> => !!p)
          await Promise.race([Promise.allSettled(loops), sleep(15_000)])
          await writer.flush()
          await saveState(dataDir, persistedState())
        } catch (e) {
          console.warn('[crawler] stop error:', errMsg(e))
        }
      })()
      return stopPromise
    },

    agents(): AgentInfo[] {
      return liveAgents().map((a) => ({ ...a.info }))
    },

    stats(): Pick<Stats, 'pages' | 'tokens' | 'bytes' | 'domains' | 'frontier' | 'rejected' | 'dupes' | 'errors' | 'agentsActive' | 'agentsTotal' | 'pagesPerMin' | 'tokensPerMin' | 'uptime' | 'heldPages' | 'heldTokens' | 'heldBytes' | 'heldUncounted' | 'heldUncountedBytes'> {
      const now = Date.now()
      const rate = prunedRate(now)
      let active = 0
      const live = liveAgents()
      for (const a of live) if (a.info.state !== 'idle' && a.info.state !== 'sleep') active++
      const held = writer.held()
      return {
        heldPages: held.pages,
        heldTokens: held.tokens,
        heldBytes: held.bytes,
        heldUncounted: held.uncounted,
        heldUncountedBytes: held.uncountedBytes,
        pages: totals.pages,
        tokens: totals.tokens,
        bytes: totals.bytes,
        domains: domains.size,
        frontier: frontier.size(),
        rejected: totals.rejected,
        dupes: totals.dupes,
        errors: totals.errors,
        agentsActive: active,
        agentsTotal: live.length,
        pagesPerMin: rate.pages,
        tokensPerMin: rate.tokens,
        uptime: startedAt ? Math.floor((now - startedAt) / 1000) : 0,
      }
    },

    sectors(): SectorInfo[] {
      return SECTORS.map((s) => ({
        id: s.id,
        pages: sectorPages[s.id],
        tokens: sectorTokens[s.id],
        frontier: frontier.sectorSize(s.id),
        agents: agents.reduce((n, a) => n + (!a.retired && a.info.sector === s.id ? 1 : 0), 0),
      }))
    },

    domains(): DomainInfo[] {
      return [...domains.values()]
        .map(domainSnapshot)
        .sort((x, y) => y.pages - x.pages || y.frontier - x.frontier || x.firstSeen - y.firstSeen)
    },

    recent(n: number): PageRecord[] {
      const k = clamp(Math.floor(n) || 0, 0, records.length)
      const out: PageRecord[] = []
      for (let i = records.length - 1; i >= records.length - k; i--) out.push(records[i])
      return out
    },

    traces(n: number): Trace[] {
      return globalTraces.newest(clamp(Math.floor(n) || 0, 0, GLOBAL_TRACES))
    },

    agentTraces(id: number, n: number): Trace[] {
      const rt = agents[id]
      if (!rt) return []
      return rt.traces.newest(clamp(Math.floor(n) || 0, 0, AGENT_TRACES))
    },

    searchPages(q: string, sector: number | null, n: number): PageRecord[] {
      const limit = clamp(Math.floor(n) || 0, 0, 1000)
      const terms = String(q ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 8)
      const sec = sector !== null && Number.isInteger(sector) && sector >= 0 && sector < SECTORS.length ? sector : null
      const out: PageRecord[] = []
      for (let i = records.length - 1; i >= 0 && out.length < limit; i--) {
        const r = records[i]
        if (sec !== null && r.sector !== sec) continue
        if (terms.length) {
          const h = hay[i] ?? ''
          if (!terms.every((t) => h.includes(t))) continue
        }
        out.push(r)
      }
      return out
    },

    spawn(name: string, owner: string | null, sector: number): AgentInfo {
      const spawnError = (code: SpawnErrorCode, msg: string) => Object.assign(new Error(msg), { code })
      const live = liveAgents()
      if (live.length >= MAX_AGENTS) throw spawnError('cap', `agent limit reached (${MAX_AGENTS})`)
      const sec = Number.isInteger(sector) && sector >= 0 && sector < SECTORS.length ? sector : 0
      let handle = String(name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '')
        .slice(0, 16)
      if (!handle) handle = AGENT_NAMES[agents.length % AGENT_NAMES.length]
      // Names are unique among live agents (no impersonating a genesis sucker).
      if (live.some((a) => a.info.name.toLowerCase() === handle)) throw spawnError('name-taken', `an agent named "${handle}" already exists`)
      const slot = live.reduce((m, a) => (a.info.sector === sec ? Math.max(m, a.info.slot + 1) : m), 0)
      const ownerClean = owner == null ? null : String(owner).slice(0, 64) || null
      let rt: AgentRt
      if (agents.length < MAX_AGENTS) rt = makeAgent(sec, slot, handle, 'spawned', ownerClean)
      else {
        const free = agents.find((a) => a.retired && a.loopDone && a.info.origin === 'spawned')
        if (!free) throw spawnError('cap', `agent limit reached (${MAX_AGENTS}) — a retiring agent frees its slot shortly`)
        reviveSlot(free, sec, slot, handle, ownerClean)
        rt = free
      }
      emitAgent(rt)
      trace(rt, rt.info.id, 'idle', `spawned on arm ${ROMAN[sec]} ${SECTORS[sec].name} at slot ${slot + 1}${ownerClean ? ` by ${ownerClean}` : ''}`, {
        sector: sec,
        slot,
      })
      if (running) {
        // Wait for init if it is still loading the dataset, then join the hunt.
        void initPromise.then(() => {
          if (running && !rt.loop) launch(rt, 300)
        })
      }
      return { ...rt.info }
    },

    vectorCount(): number {
      return vecs.length
    },

    vectors(offset: number, n: number): { ids: string[]; vecs: Float32Array[] } {
      const count = vecs.length
      const k = clamp(Math.floor(n) || 0, 0, count)
      const ids: string[] = []
      const out: Float32Array[] = []
      if (count === 0 || k === 0) return { ids, vecs: out }
      const start = (((Math.floor(offset) || 0) % count) + count) % count
      for (let i = 0; i < k; i++) {
        const idx = (start + i) % count
        ids.push(records[idx].id)
        out.push(vecs[idx])
      }
      return { ids, vecs: out }
    },

    newestVectors(n: number): { ids: string[]; vecs: Float32Array[] } {
      const count = vecs.length
      const k = clamp(Math.floor(n) || 0, 0, count)
      const ids: string[] = []
      const out: Float32Array[] = []
      for (let i = count - 1; i >= count - k; i--) {
        ids.push(records[i].id)
        out.push(vecs[i])
      }
      return { ids, vecs: out }
    },

    markSemanticDup(pageId: string, dupOfId: string, sim: number): void {
      try {
        if (!pageId || semanticDups.has(pageId)) return
        semanticDups.add(pageId)
        if (semanticDups.size > MAX_SEMANTIC_DUPS) {
          // oldest first (insertion order); only the newest 20k are persisted anyway
          let n = semanticDups.size - MAX_SEMANTIC_DUPS + 5_000
          for (const k of semanticDups) {
            if (n-- <= 0) break
            semanticDups.delete(k)
          }
        }
        totals.dupes++
        stateDirty = true
        const page = recordById.get(pageId)
        const dupTitle = titleById.get(dupOfId) ?? dupOfId
        const rt = agentFor(page?.agentId, page?.sector)
        const simStr = Number.isFinite(sim) ? sim.toFixed(2) : '?'
        trace(rt, rt?.info.id ?? 0, 'dedupe', `neurons flagged semantic near-dup of '${truncate(dupTitle, 60)}' (cos ${simStr})`, {
          pageId,
          dupOfId,
          sim: Number.isFinite(sim) ? Math.round(sim * 1000) / 1000 : null,
        })
      } catch (e) {
        console.warn('[crawler] markSemanticDup failed:', errMsg(e))
      }
    },
  }

  return api
}
