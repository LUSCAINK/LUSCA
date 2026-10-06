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
import type { ChainEvent, ChainId, Verdict } from '../../shared/chain.ts'
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
  cachedPerMin: number
  detectPerMin: number
  concurrency: number
  queue: number
  queueWaitMs: number
  cacheTtlMs: number
  memCache: number
  diskCache: number
  readTimeoutMs: number
  recent: number
}

export const DEFAULT_LENS_LIMITS: LensLimits = {
  budget: { solana: 1200, 'solana-discovery': 0, ethereum: 2250, base: 2250, arbitrum: 2250, sourcify: 750, osec: 750 },
  freshPerMin: 5,
  freshPerHour: 40,
  cachedPerMin: 60,
  detectPerMin: 12,
  concurrency: 3,
  queue: 6,
  queueWaitMs: 20_000,
  cacheTtlMs: 15 * 60_000,
  memCache: 100,
  diskCache: 600,
  readTimeoutMs: 60_000,
  recent: 24,
}

export interface LensDeps {
  /** The chain agents' network layer (shared budgets, endpoint gates). */
  rpc: RpcCtx
  store: Pick<ChainStore, 'item' | 'evaluate' | 'process' | 'full'>
  /** Into the chain feed + broadcast (agents.record). */
  record: (ev: ChainEvent) => void
  /** The chain feed, newest first (a prior verdict on the address). */
  feed: (limit: number) => ChainEvent[]
  provenance: Pick<ProvenanceIndex, 'lookup' | 'repoCommit' | 'stats'>
  dataDir: string
  log: Log
  readSolana?: typeof defaultReadSolana
  readEvm?: typeof defaultReadEvm
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

/** The daily slice of the shared budgets Lens may use (persisted, resets 00:00 UTC). */
function createSlice(limits: Record<BudgetKey, number>, file: string, now: () => number) {
  let day = Math.floor(now() / DAY)
  let used: Partial<Record<BudgetKey, number>> = {}
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { day?: number; used?: Record<string, number> }
    if (j.day === day && j.used) for (const [k, v] of Object.entries(j.used)) if (k in limits && Number.isFinite(v) && v > 0) used[k as BudgetKey] = Math.floor(v)
  } catch {
    /* first day */
  }
  let dirty = false
  const roll = () => {
    const d = Math.floor(now() / DAY)
    if (d !== day) {
      day = d
      used = {}
      dirty = true
    }
  }
  return {
    can(k: BudgetKey, n = 1) {
      roll()
      return (used[k] ?? 0) + n <= limits[k]
    },
    charge(k: BudgetKey) {
      roll()
      if ((used[k] ?? 0) + 1 > limits[k]) throw new BudgetError(k)
      used[k] = (used[k] ?? 0) + 1
      dirty = true
    },
    usage() {
      roll()
      const out: Record<string, { used: number; limit: number }> = {}
      for (const k of Object.keys(limits) as BudgetKey[]) if (limits[k] > 0) out[k] = { used: used[k] ?? 0, limit: limits[k] }
      return out
    },
    flush() {
      if (!dirty) return
      dirty = false
      try {
        writeAtomic(file, JSON.stringify({ day, used }), true)
      } catch {
        dirty = true
      }
    },
  }
}

interface Counter {
  rpc: number
  http: number
}

export function createLens(d: LensDeps): Lens {
  const L: LensLimits = { ...DEFAULT_LENS_LIMITS, ...d.limits, budget: { ...DEFAULT_LENS_LIMITS.budget, ...d.limits?.budget } }
  const now = d.now ?? Date.now
  const readSolana = d.readSolana ?? defaultReadSolana
  const readEvm = d.readEvm ?? defaultReadEvm
  const dir = path.join(d.dataDir, 'lens')
  const cacheDir = path.join(dir, 'cache')
  const recentFile = path.join(dir, 'recent.json')
  const slice = createSlice(L.budget, path.join(dir, 'budget.json'), now)

  const freshMin = createWindow(60_000, L.freshPerMin, now)
  const freshHour = createWindow(3_600_000, L.freshPerHour, now)
  const cachedMin = createWindow(60_000, L.cachedPerMin, now)
  const detectMin = createWindow(60_000, L.detectPerMin, now)
  const listMin = createWindow(60_000, 120, now)

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
    if (Array.isArray(j.recent)) recent = j.recent.filter((r) => r && typeof r.address === 'string').slice(0, L.recent)
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
    const at = now()
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
        slice.charge(keyOf(chain))
        cnt.rpc++
        return d.rpc.call(chain, method, params, { ...o, discovery: false })
      },
      async fetchJson(url, o) {
        const host = o?.host ?? (/^https?:\/\/([^/]+\.)?sourcify\.dev\b/i.test(url) ? 'sourcify' : /^https?:\/\/([^/]+\.)?osec\.io\b/i.test(url) ? 'osec' : null)
        if (host) slice.charge(host)
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

  async function judge(input: Omit<KeepInput, 'agent' | 'via'>): Promise<LensDataset> {
    const r = input.read
    const prior = before(r.chain, r.address)
    const ev = d.store.evaluate(input)
    let verdict: Verdict = ev.verdict
    let reason = ev.reason
    let added = false
    if (ev.verdict === 'kept') {
      const full = d.store.full()
      if (full) {
        verdict = 'error'
        reason = `would be kept, but the chain store is full (${full}): not stored`
      } else {
        const res = await d.store.process({ ...input, agent: 'lens', via: 'lens' })
        verdict = res.verdict
        reason = res.reason
        added = res.verdict === 'kept'
        if (added) {
          const ts = now()
          d.record({
            id: `${ts.toString(36)}-lens`,
            ts,
            agent: 'lens',
            chain: r.chain,
            address: r.address,
            name: r.name,
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

  async function readSol(address: string): Promise<LensReport> {
    const t0 = now()
    const cnt: Counter = { rpc: 0, http: 0 }
    let osec: OsecStatus | null = null
    let elf: ElfScan | null = null
    const ctx = ctxFor(cnt, (url, j) => {
      if (/osec\.io\/status\//.test(url)) osec = parseOsecStatus(j)
    })
    const res = await readSolana(address, ctx, { onElf: (b) => (elf = scanElf(b)) })
    const r = res.read
    const notes: string[] = []
    if (r.kind === 'token-mint') notes.push('a token mint is not a program: Lens reads programs and contracts')
    const pda = r.loader === LOADER_LABEL[UPGRADEABLE_LOADER] ? programAddresses(address).programData : null
    const dataset = await judge({ read: r, idlJson: res.idlJson })
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

  async function readEvmReport(chain: EvmChain, address: string): Promise<LensReport> {
    const t0 = now()
    const cnt: Counter = { rpc: 0, http: 0 }
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
    })
    return buildEvmReport(chain, self, impl, { ms: now() - t0, rpcCalls: cnt.rpc, registryCalls: cnt.http, provenance: d.provenance, dataset, notes })
  }

  function errorOf(e: unknown): LensError {
    if (e instanceof LensError) return e
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
      recent = [
        { chain: rep.chain, address: rep.address, name: rep.name, kind: rep.kind, verified: rep.summary.verified, at: rep.readAt || now() },
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
    const w1 = freshMin.take(ip)
    if (w1 > 0) throw new LensError(429, 'too many Lens reads from this address — at most 5 a minute', Math.ceil(w1 / 1000))
    const w2 = freshHour.take(ip)
    if (w2 > 0) {
      freshMin.refund(ip)
      throw new LensError(429, 'too many Lens reads from this address this hour', Math.ceil(w2 / 1000))
    }
    const budgetKey: BudgetKey = chain === 'solana' ? 'solana' : chain
    if (!slice.can(budgetKey, chain === 'solana' ? 1 : 3) || !d.rpc.canSpend(chain, chain === 'solana' ? 1 : 3)) {
      freshMin.refund(ip)
      freshHour.refund(ip)
      throw errorOf(new BudgetError(budgetKey))
    }
    const p = (async () => {
      await acquire()
      try {
        let timer: NodeJS.Timeout | undefined
        const work = chain === 'solana' ? readSol(address) : readEvmReport(chain as EvmChain, address)
        try {
          return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new LensError(504, 'the read took too long — retry in a minute')), L.readTimeoutMs)
              timer.unref?.()
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
          work.catch(() => {})
        }
      } finally {
        release()
      }
    })()
    inflight.set(k, p)
    try {
      const report = await p
      cachePut(k, report)
      remember(report)
      return { report, cached: false, fresh: now() + L.cacheTtlMs }
    } catch (e) {
      slice.flush()
      throw errorOf(e)
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
    if (c && now() - c.at < L.cacheTtlMs) return c.v
    const w = detectMin.take(ip)
    if (w > 0) throw new LensError(429, 'too many Lens requests — slow down', Math.ceil(w / 1000))
    const cnt: Counter = { rpc: 0, http: 0 }
    const ctx = ctxFor(cnt)
    const chains = await Promise.all(
      EVM.map(async (chain) => {
        try {
          const code = hexToBytes(await ctx.call(chain, 'eth_getCode', [addr, 'latest'], { timeoutMs: 6000, maxBytes: 256 * 1024 }))
          return { chain, code: code ? code.length > 0 : null, bytes: code ? code.length : null }
        } catch {
          return { chain, code: null, bytes: null }
        }
      }),
    )
    slice.flush()
    const v: LensDetect = { address: addr, chains }
    if (chains.every((x) => x.code !== null)) {
      detectCache.set(addr, { at: now(), v })
      if (detectCache.size > 2000) detectCache.delete(detectCache.keys().next().value!)
    }
    return v
  }

  const status = (): LensStatus => ({ budget: slice.usage(), inFlight: active, cached: mem.size, index: d.provenance.stats() })

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
