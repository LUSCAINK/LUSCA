// LUSCA Lens: anyone pastes a Solana program id or an Ethereum / Base / Arbitrum contract address;
// the chain agents' own readers read it on-chain and Lens returns a deterministic, cited report.
//
//   GET /api/lens/:chain/:address   → LensAnswer (cache, else one read)
//   GET /api/lens/detect/:address   → LensDetect (0x address: eth_getCode on the three EVM chains)
//   GET /api/lens/recent            → LensRecent[] (public strip, newest first)
//   GET /api/lens/status            → LensStatus
//
// Guards: strict validation · per-IP sliding windows (fresh reads 5/min and 40/h, cached answers
// 60/min, detect 12/min) · at most 3 reads at once (6 more wait ≤ 20 s, then 503) · in-flight
// dedupe (one read per address however many ask) · cache in memory (100) and on disk (<data>/lens/
// cache, 600 files) for 15 min · its own daily slice of every RPC / registry budget
// (<data>/lens/budget.json; defaults 15 % of the agents' limits, LUSCA_LENS_*), charged on top of the
// shared budget, so on-demand reads can never take more than the slice from the chain agents and the
// shared limit (the Helius budget) is never exceeded.
//
// SEPIA-1: the read is judged by the chain store's own evaluateRead(); a new verified item that the
// rules keep is handed to the same store (discovery source 'lens') and the feed, like an agent read.
// Nothing else is written: rejected verdicts are reported, not counted.

import fs from 'node:fs'
import path from 'node:path'
import type { ChainEvent, ChainId, ChainRead, Verdict } from '../../shared/chain.ts'
import type { LensAnswer, LensDataset, LensDetect, LensRecent, LensReport, LensStatus } from '../../shared/lens.ts'
import { isSolanaAddress } from '../../shared/base58.ts'
import { BudgetError, RpcError, redact, type BudgetKey, type RpcCtx } from '../chain/rpc.ts'
import { readSolana as defaultReadSolana } from '../chain/solana.ts'
import { readEvm as defaultReadEvm, normalizeEvmAddress, hexToBytes, type EvmChain, type EvmReadResult } from '../chain/evm.ts'
import { parseOsecStatus, type OsecStatus } from '../chain/solana/osec.ts'
import { programAddresses, UPGRADEABLE_LOADER, LOADER_LABEL } from '../chain/solana/layout.ts'
import type { ChainStore, KeepInput } from '../chain/store.ts'
import { scanElf, type ElfScan } from './elf-syscalls.ts'
import { buildEvmReport, buildSolanaReport, type EvmPart } from './report.ts'
import type { ProvenanceIndex } from './provenance.ts'

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

export const LENS_CHAIN_IDS: readonly ChainId[] = ['solana', 'ethereum', 'base', 'arbitrum']
const EVM: readonly EvmChain[] = ['ethereum', 'base', 'arbitrum']
const EVM_RE = /^0x[0-9a-fA-F]{40}$/

export interface LensLimits {
  /** Daily slice per budget key. */
  budget: Record<BudgetKey, number>
  freshPerMin: number
  freshPerHour: number
  /** Fresh reads per IP (IPv6: per /64) per UTC day: no single client can drain the day's slice. */
  freshPerDay: number
  /** Share of each daily slice that may be spent in one clock hour (many clients together cannot drain the day in an hour). */
  hourShare: number
  cachedPerMin: number
  detectPerMin: number
  detectPerHour: number
  detectPerDay: number
  concurrency: number
  queue: number
  queueWaitMs: number
  cacheTtlMs: number
  /** Cache life of a report whose registry could not be asked (verified: 'unknown'). */
  unknownTtlMs: number
  /** Cache life of a detect answer (code / no code per chain). */
  detectTtlMs: number
  memCache: number
  diskCache: number
  readTimeoutMs: number
  recent: number
  /** New SEPIA-1 items Lens may hand to the chain store per UTC day (count and source bytes). */
  keepPerDay: number
  keepBytesPerDay: number
  /** Lens stops handing items to the store once it is this full (the rest is the agents' headroom). */
  keepMaxFill: number
}

export const DEFAULT_LENS_LIMITS: LensLimits = {
  budget: { solana: 1200, 'solana-discovery': 0, ethereum: 2250, base: 2250, arbitrum: 2250, sourcify: 2000, osec: 2000 },
  freshPerMin: 5,
  freshPerHour: 40,
  freshPerDay: 100,
  hourShare: 0.25,
  cachedPerMin: 60,
  detectPerMin: 12,
  detectPerHour: 60,
  detectPerDay: 200,
  concurrency: 3,
  queue: 6,
  queueWaitMs: 20_000,
  cacheTtlMs: 15 * 60_000,
  unknownTtlMs: 60_000,
  detectTtlMs: 6 * 3_600_000,
  memCache: 100,
  diskCache: 600,
  readTimeoutMs: 60_000,
  recent: 24,
  keepPerDay: 50,
  keepBytesPerDay: 16 * 1024 * 1024,
  keepMaxFill: 0.8,
}

export interface LensDeps {
  /** The chain agents' network layer (shared budgets, endpoint gates). */
  rpc: RpcCtx
  store: Pick<ChainStore, 'item' | 'evaluate' | 'process' | 'full'> & Partial<Pick<ChainStore, 'summary'>>
  /** Into the chain feed + broadcast (agents.record). */
  record: (ev: ChainEvent) => void
  /** The chain feed, newest first (a prior verdict on the address). */
  feed: (limit: number) => ChainEvent[]
  provenance: Pick<ProvenanceIndex, 'lookup' | 'repoCommit' | 'stats'>
  dataDir: string
  log: Log
  readSolana?: typeof defaultReadSolana
  readEvm?: typeof defaultReadEvm
  /** Handed each program executable a Lens read fetched (READ THE BINARY: no extra RPC). */
  onSolanaElf?: (read: ChainRead, elf: Uint8Array) => void
  limits?: Partial<LensLimits>
  now?: () => number
}

export interface LensRouteResult {
  status: number
  json: string
  headers?: Record<string, string>
}

export interface Lens {
  route(p: string, ip: string): Promise<LensRouteResult>
  read(chain: ChainId, address: string, ip: string): Promise<LensAnswer>
  detect(address: string, ip: string): Promise<LensDetect>
  recent(): LensRecent[]
  status(): LensStatus
  stop(): Promise<void>
}

export class LensError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterS: number | null = null,
  ) {
    super(message)
    this.name = 'LensError'
  }
}

/** Sliding-window per-key limiter (same contract as server/http.ts createLimiter). */
export function createWindow(windowMs: number, max: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>()
  return {
    take(key: string): number {
      const t = now()
      const ts = (hits.get(key) ?? []).filter((x) => x > t - windowMs)
      if (ts.length >= max) {
        hits.set(key, ts)
        return ts[0] + windowMs - t
      }
      ts.push(t)
      hits.set(key, ts)
      if (hits.size > 20_000) for (const [k, v] of hits) if (!v.length || v[v.length - 1] <= t - windowMs) hits.delete(k)
      return 0
    },
    /** Give back the newest hit of `key` (a request that did not cost a read). */
    refund(key: string) {
      const ts = hits.get(key)
      if (ts?.length) ts.pop()
    },
  }
}

/** Validated (chain, address) → canonical address, or a LensError(400). */
export function validateTarget(chain: string, address: string): { chain: ChainId; address: string } {
  if (!(LENS_CHAIN_IDS as readonly string[]).includes(chain)) throw new LensError(400, 'chain must be solana, ethereum, base or arbitrum')
  const a = address.trim()
  if (chain === 'solana') {
    if (!isSolanaAddress(a)) throw new LensError(400, 'not a Solana address (base58, 32 bytes)')
    return { chain: 'solana', address: a }
  }
  if (!EVM_RE.test(a)) throw new LensError(400, 'not an EVM address (0x followed by 40 hex characters)')
  return { chain: chain as ChainId, address: a.toLowerCase() }
}

const DAY = 86_400_000
const key = (chain: ChainId, a: string) => `${chain}:${chain === 'solana' ? a : a.toLowerCase()}`

function writeAtomic(file: string, data: string, sync = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, data)
    if (sync) fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

/** Calls reserved on disk ahead of use: a hard kill can never lose a charged call. */
const RESERVE = 16

/**
 * The daily slice of the shared budgets Lens may use (persisted, resets 00:00 UTC). Write-ahead: the
 * file always holds at least the calls charged (a block of RESERVE is written before the calls in it
 * are made), so after a hard kill the restored count is ≥ the last one shown, never lower.
 */
/** This hour's fair share of a Lens slice is used up (a BudgetError, so the readers stop the read the same way). */
export class SliceHourError extends BudgetError {
  readonly hourly = true
}

const HOUR = 3_600_000

function createSlice(limits: Record<BudgetKey, number>, file: string, now: () => number, hourShare = 1) {
  let day = Math.floor(now() / DAY)
  // fair share per clock hour (memory only: a restart can only lower what was spent this hour)
  let hour = Math.floor(now() / HOUR)
  let hourUsed: Partial<Record<BudgetKey, number>> = {}
  const hourCap = (k: BudgetKey) => Math.max(1, Math.ceil(limits[k] * hourShare))
  let used: Partial<Record<BudgetKey, number>> = {}
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { day?: number; used?: Record<string, number> }
    if (j.day === day && j.used) for (const [k, v] of Object.entries(j.used)) if (k in limits && Number.isFinite(v) && v > 0) used[k as BudgetKey] = Math.floor(v)
  } catch {
    /* first day */
  }
  let onDisk: Partial<Record<BudgetKey, number>> = { ...used }
  let dirty = false
  const write = (v: Partial<Record<BudgetKey, number>>) => {
    writeAtomic(file, JSON.stringify({ day, used: v }), true)
    onDisk = { ...v }
  }
  const roll = () => {
    const d = Math.floor(now() / DAY)
    if (d !== day) {
      day = d
      used = {}
      onDisk = {}
      dirty = true
    }
    const h = Math.floor(now() / HOUR)
    if (h !== hour) {
      hour = h
      hourUsed = {}
    }
  }
  /** Why `n` more calls of `k` cannot be made now: the day's slice, this hour's share, or null. */
  const why = (k: BudgetKey, n = 1): 'day' | 'hour' | null => {
    roll()
    if ((used[k] ?? 0) + n > limits[k]) return 'day'
    if ((hourUsed[k] ?? 0) + n > hourCap(k)) return 'hour'
    return null
  }
  return {
    why,
    can: (k: BudgetKey, n = 1) => why(k, n) === null,
    charge(k: BudgetKey) {
      const w = why(k, 1)
      if (w === 'day') throw new BudgetError(k)
      if (w === 'hour') throw new SliceHourError(k)
      const next = (used[k] ?? 0) + 1
      if (next > (onDisk[k] ?? 0)) write({ ...used, ...onDisk, [k]: Math.min(limits[k], next + RESERVE - 1) }) // throws: the call is not made
      used[k] = next
      hourUsed[k] = (hourUsed[k] ?? 0) + 1
      dirty = true
    },
    usage() {
      roll()
      const out: Record<string, { used: number; limit: number }> = {}
      for (const k of Object.keys(limits) as BudgetKey[]) if (limits[k] > 0) out[k] = { used: used[k] ?? 0, limit: limits[k] }
      return out
    },
    /** Write the exact counts (≥ every count shown so far). */
    flush() {
      if (!dirty) return
      dirty = false
      try {
        write({ ...used })
      } catch {
        dirty = true
      }
    },
  }
}

/** A per-UTC-day counter set persisted with fsync + rename (Lens keeps per day). */
function createDayCounter(file: string, now: () => number) {
  let day = Math.floor(now() / DAY)
  let v = { items: 0, bytes: 0 }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { day?: number; items?: number; bytes?: number }
    if (j.day === day) v = { items: Math.max(0, Math.floor(Number(j.items) || 0)), bytes: Math.max(0, Math.floor(Number(j.bytes) || 0)) }
  } catch {
    /* first day */
  }
  const roll = () => {
    const d = Math.floor(now() / DAY)
    if (d !== day) {
      day = d
      v = { items: 0, bytes: 0 }
    }
  }
  return {
    get() {
      roll()
      return { ...v }
    },
    add(items: number, bytes: number) {
      roll()
      v = { items: v.items + items, bytes: v.bytes + bytes }
      writeAtomic(file, JSON.stringify({ day, ...v }), true)
    },
  }
}

interface Counter {
  rpc: number
  http: number
  /** set when the read passed its deadline: no more calls, nothing handed to the store */
  dead: boolean
}

const URLISH = /https?:|www\.|:\/\/|\.(?:com|io|xyz|net|org|app|gg|me|co|fi|finance|ink|site|online|top|vip|cc|link|click|claims?)\b|t\.me|discord|telegram|@/i

/** A name fit for a public list: plain identifier-like text, no links or handles, at most 48 characters; else null. */
export function safeName(name: string | null | undefined): string | null {
  if (!name) return null
  const n = name.trim()
  if (!n || n.length > 48 || URLISH.test(n) || !/^[\w .()+:/-]+$/.test(n)) return null
  return n
}

export function createLens(d: LensDeps): Lens {
  const L: LensLimits = { ...DEFAULT_LENS_LIMITS, ...d.limits, budget: { ...DEFAULT_LENS_LIMITS.budget, ...d.limits?.budget } }
  const now = d.now ?? Date.now
  const readSolana = d.readSolana ?? defaultReadSolana
  const readEvm = d.readEvm ?? defaultReadEvm
  const dir = path.join(d.dataDir, 'lens')
  const cacheDir = path.join(dir, 'cache')
  const recentFile = path.join(dir, 'recent.json')
  const slice = createSlice(L.budget, path.join(dir, 'budget.json'), now, L.hourShare)
  const keeps = createDayCounter(path.join(dir, 'keeps.json'), now)

  const freshMin = createWindow(60_000, L.freshPerMin, now)
  const freshHour = createWindow(3_600_000, L.freshPerHour, now)
  const freshDay = createWindow(DAY, L.freshPerDay, now)
  const cachedMin = createWindow(60_000, L.cachedPerMin, now)
  const detectMin = createWindow(60_000, L.detectPerMin, now)
  const detectHour = createWindow(3_600_000, L.detectPerHour, now)
  const detectDay = createWindow(DAY, L.detectPerDay, now)
  const listMin = createWindow(60_000, 120, now)
  /** Take one hit from each window in order; on a refusal give back the ones already taken. */
  function takeAll(ip: string, ws: { w: ReturnType<typeof createWindow>; msg: string }[]) {
    for (let i = 0; i < ws.length; i++) {
      const wait = ws[i].w.take(ip)
      if (wait > 0) {
        for (let k = 0; k < i; k++) ws[k].w.refund(ip)
        throw new LensError(429, ws[i].msg, Math.ceil(wait / 1000))
      }
    }
  }
  const FRESH = [
    { w: freshMin, msg: `too many Lens reads from this address: at most ${L.freshPerMin} a minute` },
    { w: freshHour, msg: `too many Lens reads from this address this hour (at most ${L.freshPerHour})` },
    { w: freshDay, msg: `too many Lens reads from this address today (at most ${L.freshPerDay} a day)` },
  ]
  const DETECT = [
    { w: detectMin, msg: 'too many Lens requests — slow down' },
    { w: detectHour, msg: 'too many chain lookups from this address this hour' },
    { w: detectDay, msg: 'too many chain lookups from this address today' },
  ]
  const refundFresh = (ip: string) => FRESH.forEach((x) => x.w.refund(ip))

  const mem = new Map<string, { at: number; json: string; report: LensReport }>()
  const inflight = new Map<string, Promise<LensReport>>()
  const detectCache = new Map<string, { at: number; v: LensDetect }>()
  let active = 0
  const waiters: (() => void)[] = []
  let diskWrites = 0

  let recent: LensRecent[] = []
  let reads = 0
  try {
    const j = JSON.parse(fs.readFileSync(recentFile, 'utf8')) as { recent?: LensRecent[]; reads?: number }
    if (Array.isArray(j.recent))
      recent = j.recent
        .filter((r) => r && typeof r.address === 'string')
        .slice(0, L.recent)
        // the same rule as remember(): a name only for verified code, and only a plain one
        .map((r) => ({ ...r, name: r.chain === 'solana' || (r.verified && r.verified !== 'unknown') ? safeName(r.name) : null }))
    if (Number.isFinite(j.reads)) reads = Math.max(0, Math.floor(j.reads!))
  } catch {
    /* none yet */
  }

  // ─── cache ────────────────────────────────────────────────────────────────

  const cacheFile = (k: string) => path.join(cacheDir, `${k.replace(':', '-')}.json`)

  function cacheGet(k: string): { at: number; json: string; report: LensReport } | null {
    const m = mem.get(k)
    if (m && now() - m.at < L.cacheTtlMs) {
      mem.delete(k)
      mem.set(k, m)
      return m
    }
    if (m) mem.delete(k)
    try {
      const raw = fs.readFileSync(cacheFile(k), 'utf8')
      const j = JSON.parse(raw) as { at: number; report: LensReport }
      if (j && typeof j.at === 'number' && j.report?.v === 1 && now() - j.at < L.cacheTtlMs) {
        const e = { at: j.at, json: '', report: j.report }
        memPut(k, e)
        return e
      }
    } catch {
      /* miss */
    }
    return null
  }

  function memPut(k: string, e: { at: number; json: string; report: LensReport }) {
    mem.set(k, e)
    while (mem.size > L.memCache) mem.delete(mem.keys().next().value!)
  }

  function cachePut(k: string, report: LensReport) {
    // a report whose registry could not be asked lives one minute (it ages out of the 15-minute TTL)
    const at = report.summary.verified === 'unknown' ? now() - L.cacheTtlMs + L.unknownTtlMs : now()
    memPut(k, { at, json: '', report })
    try {
      writeAtomic(cacheFile(k), JSON.stringify({ at, report }))
      if (++diskWrites % 25 === 0) pruneDisk()
    } catch (e) {
      d.log('warn', `lens cache write failed: ${(e as Error).message}`)
    }
  }

  function pruneDisk() {
    try {
      const files = fs
        .readdirSync(cacheDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ f, t: fs.statSync(path.join(cacheDir, f)).mtimeMs }))
      const cutoff = now() - L.cacheTtlMs * 4
      files.sort((a, b) => b.t - a.t)
      files.forEach((x, i) => {
        if (i >= L.diskCache || x.t < cutoff) fs.rmSync(path.join(cacheDir, x.f), { force: true })
      })
    } catch {
      /* nothing to prune */
    }
  }

  // ─── concurrency ──────────────────────────────────────────────────────────

  async function acquire() {
    if (active < L.concurrency) {
      active++
      return
    }
    if (waiters.length >= L.queue) throw new LensError(503, 'Lens is busy with other reads — retry in a few seconds', 3)
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        clearTimeout(t)
        active++
        resolve()
      }
      const t = setTimeout(() => {
        const i = waiters.indexOf(go)
        if (i >= 0) waiters.splice(i, 1)
        reject(new LensError(503, 'Lens is busy with other reads — retry in a few seconds', 3))
      }, L.queueWaitMs)
      waiters.push(go)
    })
  }

  function release() {
    active = Math.max(0, active - 1)
    const w = waiters.shift()
    if (w) w()
  }

  // ─── the budgeted context of one read ─────────────────────────────────────

  function ctxFor(cnt: Counter, onJson?: (url: string, j: unknown) => void): RpcCtx {
    const keyOf = (chain: ChainId): BudgetKey => (chain === 'solana' ? 'solana' : (chain as EvmChain))
    return {
      call(chain, method, params, o) {
        if (cnt.dead) return Promise.reject(new LensError(504, 'the read took too long'))
        // the shared budget first: a call the shared layer would refuse is not charged to the slice
        if (!d.rpc.canSpend(chain, 1, false)) return Promise.reject(new BudgetError(keyOf(chain)))
        slice.charge(keyOf(chain))
        cnt.rpc++
        return d.rpc.call(chain, method, params, { ...o, discovery: false })
      },
      async fetchJson(url, o) {
        if (cnt.dead) throw new LensError(504, 'the read took too long')
        const host = o?.host ?? (/^https?:\/\/([^/]+\.)?sourcify\.dev\b/i.test(url) ? 'sourcify' : /^https?:\/\/([^/]+\.)?osec\.io\b/i.test(url) ? 'osec' : null)
        if (host) {
          const u = d.rpc.usage()[host]
          if (u && u.used >= u.limit) throw new BudgetError(host)
          slice.charge(host)
        }
        cnt.http++
        const j = await d.rpc.fetchJson(url, o)
        onJson?.(url, j)
        return j
      },
      usage: () => d.rpc.usage(),
      canSpend: (chain, n = 1, discovery = false) => slice.can(keyOf(chain), n) && d.rpc.canSpend(chain, n, discovery),
    }
  }

  // ─── SEPIA-1 dataset status ───────────────────────────────────────────────

  function before(chain: ChainId, address: string): LensDataset['before'] {
    const it = d.store.item(chain, address)
    if (it) return { verdict: 'kept', reason: `kept in the chain index (found via ${it.item.via})`, at: it.item.readAt, via: it.item.via }
    const a = chain === 'solana' ? address : address.toLowerCase()
    const ev = d.feed(200).find((e) => e.chain === chain && (chain === 'solana' ? e.address === a : e.address.toLowerCase() === a))
    return ev ? { verdict: ev.verdict, reason: ev.reason, at: ev.ts, via: ev.via } : null
  }

  /** Why Lens may not hand one more item to the chain store now, or null. */
  function keepRefusal(bytes: number): string | null {
    const full = d.store.full()
    if (full) return `the chain store is full (${full})`
    const sum = d.store.summary?.()
    if (sum && sum.capBytes > 0 && sum.bytes >= sum.capBytes * L.keepMaxFill)
      return `the chain store is ${Math.round((sum.bytes / sum.capBytes) * 100)} % full; the rest is kept for the chain agents`
    const k = keeps.get()
    if (k.items >= L.keepPerDay) return `Lens has added its ${L.keepPerDay} items for today (UTC)`
    if (k.bytes + bytes > L.keepBytesPerDay) return `Lens has added its ${Math.round(L.keepBytesPerDay / 1048576)} MB of source for today (UTC)`
    return null
  }

  async function judge(input: Omit<KeepInput, 'agent' | 'via'>, cnt: Counter): Promise<LensDataset> {
    const r = input.read
    const prior = before(r.chain, r.address)
    const ev = d.store.evaluate(input)
    let verdict: Verdict = ev.verdict
    let reason = ev.reason
    let added = false
    if (ev.verdict === 'kept') {
      const bytes = (input.sources ?? []).reduce((s, f) => s + f.text.length, 0)
      const no = cnt.dead ? 'the read ran past its deadline' : keepRefusal(bytes)
      if (no) {
        verdict = 'error'
        reason = `passes the SEPIA-1 rules but was not stored: ${no}. The chain agents may still keep it.`
      } else {
        const res = await d.store.process({ ...input, agent: 'lens', via: 'lens' })
        verdict = res.verdict
        reason = res.reason
        added = res.verdict === 'kept'
        if (added) {
          keeps.add(1, res.item?.sourceBytes ?? bytes)
          const ts = now()
          d.record({
            id: `${ts.toString(36)}-lens`,
            ts,
            agent: 'lens',
            chain: r.chain,
            address: r.address,
            name: safeName(r.name),
            kind: r.kind,
            via: 'lens',
            verdict: 'kept',
            reason: res.reason,
            idl: r.idl !== null || !!input.idlJson,
            verifiedBy: r.verified?.by ?? null,
            sourceFiles: input.sources?.length || r.sources.length,
            sourceBytes: res.item?.sourceBytes ?? 0,
          })
        }
      }
    }
    return { address: r.address, before: prior, verdict, reason, added }
  }

  // ─── reads ────────────────────────────────────────────────────────────────

  async function readSol(address: string, cnt: Counter): Promise<LensReport> {
    const t0 = now()
    let osec: OsecStatus | null = null
    let elf: ElfScan | null = null
    const ctx = ctxFor(cnt, (url, j) => {
      if (/osec\.io\/status\//.test(url)) osec = parseOsecStatus(j)
    })
    const held: { b: Uint8Array | null } = { b: null }
    const res = await readSolana(address, ctx, {
      onElf: (b) => {
        elf = scanElf(b)
        if (d.onSolanaElf) held.b = b
      },
    })
    const r = res.read
    if (held.b && d.onSolanaElf) {
      try {
        d.onSolanaElf(r, held.b)
      } catch {
        /* never fails the Lens read */
      }
    }
    const notes: string[] = []
    if (r.kind === 'token-mint') notes.push('a token mint is not a program: Lens reads programs and contracts')
    const pda = r.loader === LOADER_LABEL[UPGRADEABLE_LOADER] ? programAddresses(address).programData : null
    const dataset = await judge({ read: r, idlJson: res.idlJson }, cnt)
    return buildSolanaReport(
      { read: r, idlJson: res.idlJson, elf, osec, programDataAddress: pda },
      { ms: now() - t0, rpcCalls: cnt.rpc, registryCalls: cnt.http, provenance: d.provenance, dataset, notes },
    )
  }

  function deployBlockOf(j: unknown): number | null {
    const b = Number((j as { deployment?: { blockNumber?: unknown } } | null)?.deployment?.blockNumber)
    return Number.isFinite(b) && b > 0 ? b : null
  }

  async function readOneEvm(chain: EvmChain, address: string, cnt: Counter): Promise<EvmPart & { raw: EvmReadResult }> {
    let block: number | null = null
    const ctx = ctxFor(cnt, (url, j) => {
      if (/sourcify\.dev\/server\/v2\/contract\//.test(url)) block = deployBlockOf(j) ?? block
    })
    const raw = await readEvm(chain, address, ctx)
    return { read: raw.read, abiJson: raw.abiJson, sources: raw.sources, profile: raw.profile, deployBlock: block, raw }
  }

  async function readEvmReport(chain: EvmChain, address: string, cnt: Counter): Promise<LensReport> {
    const t0 = now()
    const self = await readOneEvm(chain, address, cnt)
    let impl: (EvmPart & { raw: EvmReadResult }) | null = null
    const notes: string[] = []
    const target = self.read.proxy?.implementation
    if (target && normalizeEvmAddress(target) && target.toLowerCase() !== address.toLowerCase()) {
      try {
        impl = await readOneEvm(chain, target, cnt)
      } catch (e) {
        if (e instanceof BudgetError) notes.push('implementation not read: Lens daily budget used up')
        else notes.push(`implementation not read: ${redact((e as Error).message).slice(0, 140)}`)
      }
    }
    const code = impl ?? self
    const dataset = await judge({
      read: code.read,
      abiJson: code.raw.abiJson,
      sources: code.raw.sources,
      sourceBundleHash: code.raw.sourceBundleHash,
      boilerplate: code.raw.profile?.boilerplate ?? null,
    }, cnt)
    return buildEvmReport(chain, self, impl, { ms: now() - t0, rpcCalls: cnt.rpc, registryCalls: cnt.http, provenance: d.provenance, dataset, notes })
  }

  function errorOf(e: unknown): LensError {
    if (e instanceof LensError) return e
    if (e instanceof SliceHourError)
      return new LensError(503, `Lens has used this hour's share of its daily ${e.key} budget; it frees up at the next full hour (UTC)`, Math.ceil((HOUR - (now() % HOUR)) / 1000))
    if (e instanceof BudgetError) return new LensError(503, `the daily ${e.key} read budget is used up; it resets at 00:00 UTC`, Math.ceil((DAY - (now() % DAY)) / 1000))
    if (e instanceof RpcError) {
      const what = /^sourcify/.test(e.message) ? 'Sourcify' : /^osec/.test(e.message) ? 'the OtterSec registry' : 'the chain RPC'
      return new LensError(e.transient ? 503 : 502, `${what} did not answer usably (${redact(e.message).slice(0, 120)}) — nothing was guessed; retry later`, e.transient ? 10 : null)
    }
    const m = redact(e instanceof Error ? e.message : String(e)).slice(0, 160)
    if (/^Sourcify lookup failed/.test(m)) return new LensError(503, `${m} — retry later`, 10)
    return new LensError(502, `read failed: ${m}`)
  }

  function remember(rep: LensReport) {
    reads++
    if (rep.kind === 'program' || rep.kind === 'contract') {
      // the public strip names only code the SEPIA-1 rules kept (or already hold) — on EVM it must also
      // be verified on Sourcify; on Solana the rules keep only an OtterSec build or an on-chain IDL, whose
      // name the upgrade authority wrote — and only a plain name: anything else shows its address (a
      // name chosen by whoever deploys is not a public billboard)
      const v = rep.summary.verified
      const okVerdict = rep.dataset.verdict === 'kept' || rep.dataset.verdict === 'duplicate' || rep.dataset.before?.verdict === 'kept'
      const name = okVerdict && (rep.chain === 'solana' || (v && v !== 'unknown')) ? safeName(rep.name) : null
      recent = [
        { chain: rep.chain, address: rep.address, name, kind: rep.kind, verified: v, at: rep.readAt || now() },
        ...recent.filter((r) => !(r.chain === rep.chain && r.address === rep.address)),
      ].slice(0, L.recent)
    }
    try {
      writeAtomic(recentFile, JSON.stringify({ reads, recent }), true)
    } catch (e) {
      d.log('warn', `lens recent.json save failed: ${(e as Error).message}`)
    }
    slice.flush()
  }

  async function read(chainRaw: ChainId, addressRaw: string, ip: string): Promise<LensAnswer> {
    const { chain, address } = validateTarget(chainRaw, addressRaw)
    const k = key(chain, address)
    const hit = cacheGet(k)
    if (hit) {
      const w = cachedMin.take(ip)
      if (w > 0) throw new LensError(429, 'too many Lens requests — slow down', Math.ceil(w / 1000))
      return { report: hit.report, cached: true, fresh: hit.at + L.cacheTtlMs }
    }
    const running = inflight.get(k)
    if (running) {
      const w = cachedMin.take(ip)
      if (w > 0) throw new LensError(429, 'too many Lens requests — slow down', Math.ceil(w / 1000))
      const report = await running
      return { report, cached: true, fresh: now() + L.cacheTtlMs }
    }
    takeAll(ip, FRESH)
    // every slice a read needs, before any call: a read that cannot finish is not started
    const budgetKey: BudgetKey = chain === 'solana' ? 'solana' : chain
    const need = chain === 'solana' ? 1 : 3
    const registry: BudgetKey = chain === 'solana' ? 'osec' : 'sourcify'
    const ru = d.rpc.usage()[registry]
    const short = slice.why(budgetKey, need) ? budgetKey : !d.rpc.canSpend(chain, need) ? budgetKey : slice.why(registry, 1) || (ru && ru.used >= ru.limit) ? registry : null
    if (short) {
      refundFresh(ip)
      throw errorOf(slice.why(short, short === budgetKey ? need : 1) === 'hour' ? new SliceHourError(short) : new BudgetError(short))
    }
    const cnt: Counter = { rpc: 0, http: 0, dead: false }
    const p = (async () => {
      await acquire()
      // the slot is held until the read itself settles, also after a timeout answered the caller
      const work = chain === 'solana' ? readSol(address, cnt) : readEvmReport(chain as EvmChain, address, cnt)
      void work.then(release, release)
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              cnt.dead = true // no further calls, nothing handed to the store
              reject(new LensError(504, 'the read took too long — retry in a minute'))
            }, L.readTimeoutMs)
            timer.unref?.()
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
        work.catch(() => {})
      }
    })()
    inflight.set(k, p)
    try {
      const report = await p
      cachePut(k, report)
      remember(report)
      return { report, cached: false, fresh: now() + (report.summary.verified === 'unknown' ? L.unknownTtlMs : L.cacheTtlMs) }
    } catch (e) {
      slice.flush()
      const le = errorOf(e)
      // busy / an endpoint down / budget: the caller got no read, so it costs no read
      if (le.status === 503) refundFresh(ip)
      throw le
    } finally {
      inflight.delete(k)
    }
  }

  async function detect(addressRaw: string, ip: string): Promise<LensDetect> {
    const a = addressRaw.trim()
    if (isSolanaAddress(a as unknown)) return { address: a, chains: [{ chain: 'solana', code: null, bytes: null }] }
    if (!EVM_RE.test(a)) throw new LensError(400, 'not a Solana or EVM address')
    const addr = a.toLowerCase()
    const c = detectCache.get(addr)
    // chains that answered are remembered (code or no code); only the ones that did not are asked again
    const known = c && now() - c.at < L.detectTtlMs ? c.v.chains.filter((x) => x.code !== null) : []
    const ask = EVM.filter((ch) => !known.some((x) => x.chain === ch))
    if (!ask.length) return { address: addr, chains: EVM.map((ch) => known.find((x) => x.chain === ch)!) }
    takeAll(ip, DETECT)
    const cnt: Counter = { rpc: 0, http: 0, dead: false }
    const ctx = ctxFor(cnt)
    const asked = await Promise.all(
      ask.map(async (chain) => {
        try {
          const code = hexToBytes(await ctx.call(chain, 'eth_getCode', [addr, 'latest'], { timeoutMs: 6000, maxBytes: 256 * 1024 }))
          return { chain, code: code ? code.length > 0 : null, bytes: code ? code.length : null }
        } catch {
          return { chain, code: null, bytes: null }
        }
      }),
    )
    slice.flush()
    const chains = EVM.map((ch) => known.find((x) => x.chain === ch) ?? asked.find((x) => x.chain === ch)!)
    const v: LensDetect = { address: addr, chains }
    if (chains.some((x) => x.code !== null)) {
      detectCache.delete(addr)
      detectCache.set(addr, { at: c && known.length ? c.at : now(), v })
      if (detectCache.size > 5000) detectCache.delete(detectCache.keys().next().value!)
    }
    return v
  }

  const status = (): LensStatus => ({ budget: slice.usage(), keeps: { items: keeps.get().items, limit: L.keepPerDay }, inFlight: active, cached: mem.size, index: d.provenance.stats() })

  function ok(v: unknown, headers?: Record<string, string>): LensRouteResult {
    return { status: 200, json: JSON.stringify(v), headers }
  }

  async function route(p: string, ip: string): Promise<LensRouteResult> {
    try {
      if (p === '/api/lens/recent' || p === '/api/lens/status') {
        const w = listMin.take(ip)
        if (w > 0) throw new LensError(429, 'too many Lens requests — slow down', Math.ceil(w / 1000))
        return ok(p === '/api/lens/recent' ? { reads, recent } : status(), { 'Cache-Control': 'public, max-age=5' })
      }
      const dm = /^\/api\/lens\/detect\/([^/]{1,64})$/.exec(p)
      if (dm) return ok(await detect(decodeSeg(dm[1]), ip))
      const m = /^\/api\/lens\/([a-z]{1,16})\/([^/]{1,64})$/.exec(p)
      if (!m) throw new LensError(404, 'not found')
      const ans = await read(m[1] as ChainId, decodeSeg(m[2]), ip)
      return ok(ans, { 'Cache-Control': 'public, max-age=60' })
    } catch (e) {
      const le = errorOf(e)
      return { status: le.status, json: JSON.stringify({ error: le.message }), headers: le.retryAfterS ? { 'Retry-After': String(le.retryAfterS) } : undefined }
    }
  }

  return {
    route,
    read,
    detect,
    recent: () => recent.slice(),
    status,
    async stop() {
      slice.flush()
    },
  }
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    throw new LensError(400, 'address is not valid')
  }
}
