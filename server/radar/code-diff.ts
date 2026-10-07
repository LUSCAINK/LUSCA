// RADAR DIFF: the source change behind an EVM upgrade. For an upgrade whose old and new implementations
// are both verified on Sourcify, both source sets are fetched (once ever per chain + implementation,
// cached on disk), the changed files are diffed and the functions they touch listed (server/radar/
// source-diff.ts). Computed on the first request (single-flight) and by a small background backfill.
//
// Budget: its own daily Sourcify slice (LUSCA_RADAR_DIFF_CALLS, default 120; a 30 % hourly share),
// charged on top of the shared Sourcify limit and never below its 10 % floor. A viewer can trigger at most
// two Sourcify calls per upgrade, ever. Everything under <data>/radar/{sources,diffs}.

import fs from 'node:fs'
import path from 'node:path'
import type { ChainId } from '../../shared/chain.ts'
import type { RadarEvent } from '../../shared/radar.ts'
import { diffable, type RadarCodeDiff } from '../../shared/radarDiff.ts'
import { BudgetError, RpcError, redact, type ChainRpc } from '../chain/rpc.ts'
import { createRadarBudget, writeFileDurable, type RadarBudget } from './budget.ts'
import { diffSources, type SourceSet } from './source-diff.ts'

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

const CHAIN_IDS: Partial<Record<ChainId, number>> = { ethereum: 1, base: 8453, arbitrum: 42161 }
const SOURCIFY_MAX_BYTES = 12 * 1024 * 1024
const SOURCIFY_TIMEOUT_MS = 25_000
const MEM_CAP = 60
const SOFT_TTL = 60_000
const NONE_RETRY_MS = 3 * 86_400_000
const BACKFILL_FIRST_MS = 90_000
const BACKFILL_EVERY_MS = 30 * 60_000
const BACKFILL_PER_PASS = 8
const ADDR_RE = /^0x[0-9a-f]{40}$/

interface CachedSources {
  chain: ChainId
  address: string
  fetchedAt: number
  /** null: Sourcify has no verified match. */
  sources: SourceSet | null
  compiler: string | null
  name: string | null
}

export interface RadarDiffService {
  start(): void
  stop(): Promise<void>
  /** GET /api/radar/:id/diff answer; null when the radar has no such event. `ready`: final (long cache). */
  get(id: string): Promise<{ json: string; ready: boolean } | null>
}

export interface RadarDiffOptions {
  rpc: Pick<ChainRpc, 'fetchJson' | 'usage'>
  radar: { get(id: string): RadarEvent | null; list(q: { kind?: 'upgrade'; limit?: number; cursor?: string }): { items: RadarEvent[]; next: string | null } }
  dataDir: string
  log: Log
  /** Daily Sourcify calls for diffs. */
  limit?: number
  backfill?: boolean
  now?: () => number
}

const errMsg = (e: unknown) => redact(e instanceof Error ? e.message : String(e)).slice(0, 160)

export function createRadarDiff(o: RadarDiffOptions): RadarDiffService {
  const now = o.now ?? Date.now
  const dir = path.join(o.dataDir, 'radar')
  const srcDir = path.join(dir, 'sources')
  const diffDir = path.join(dir, 'diffs')
  const budget: RadarBudget = createRadarBudget({ sourcify: Math.max(0, Math.floor(o.limit ?? 120)) }, path.join(dir, 'diff-budget.json'), now, 0.3)
  const mem = new Map<string, { json: string; ready: boolean; at: number }>()
  const inflight = new Map<string, Promise<RadarCodeDiff>>()
  const srcInflight = new Map<string, Promise<CachedSources>>()
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const remember = (id: string, v: { json: string; ready: boolean }) => {
    mem.delete(id)
    mem.set(id, { ...v, at: now() })
    while (mem.size > MEM_CAP) mem.delete(mem.keys().next().value as string)
  }
  const diffFile = (id: string) => path.join(diffDir, `${id.replace(/[^a-z0-9-]/g, '')}.json`)
  const srcFile = (chain: ChainId, addr: string) => path.join(srcDir, `${chain}-${addr}.json`)
  const readJson = <T>(f: string): T | null => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8')) as T
    } catch {
      return null
    }
  }

  function sharedRoom(): boolean {
    const u = o.rpc.usage().sourcify
    if (!u) return true
    return u.limit - u.used - 1 >= Math.ceil(u.limit * 0.1)
  }

  async function sources(chain: ChainId, addr0: string): Promise<CachedSources> {
    const addr = addr0.toLowerCase()
    if (!ADDR_RE.test(addr)) throw new Error('not an EVM address')
    const f = srcFile(chain, addr)
    const hit = readJson<CachedSources>(f)
    if (hit && (hit.sources || now() - hit.fetchedAt < NONE_RETRY_MS)) return hit
    const key = `${chain}:${addr}`
    const run = srcInflight.get(key)
    if (run) return run
    const p = (async () => {
      const chainId = CHAIN_IDS[chain]
      if (!chainId) throw new Error(`not an EVM chain: ${chain}`)
      if (!sharedRoom()) throw new BudgetError('sourcify')
      budget.charge('sourcify')
      let j: unknown
      try {
        j = await o.rpc.fetchJson(`https://sourcify.dev/server/v2/contract/${chainId}/${addr}?fields=sources,sourceIds,compilation`, {
          host: 'sourcify',
          maxBytes: SOURCIFY_MAX_BYTES,
          timeoutMs: SOURCIFY_TIMEOUT_MS,
        })
      } catch (e) {
        if (e instanceof RpcError && e.kind === 'http' && e.status === 404) j = null
        else throw e
      }
      const r = (j && typeof j === 'object' ? j : null) as {
        match?: unknown
        sources?: Record<string, { content?: unknown } | null> | null
        sourceIds?: Record<string, unknown> | null
        compilation?: { compiler?: unknown; compilerVersion?: unknown; name?: unknown } | null
      } | null
      let set: SourceSet | null = null
      if (r && (r.match === 'exact_match' || r.match === 'match') && r.sources && typeof r.sources === 'object') {
        const ids = r.sourceIds && typeof r.sourceIds === 'object' ? Object.keys(r.sourceIds) : []
        const paths = (ids.length ? ids.filter((x) => Object.hasOwn(r.sources as object, x)) : Object.keys(r.sources)).sort()
        set = {}
        for (const p2 of paths) {
          const c = r.sources[p2]?.content
          if (typeof c === 'string') set[p2] = c
        }
        if (!Object.keys(set).length) set = null
      }
      const comp = r?.compilation ?? {}
      const out: CachedSources = {
        chain,
        address: addr,
        fetchedAt: now(),
        sources: set,
        compiler: [comp.compiler, comp.compilerVersion].filter((x) => typeof x === 'string' && x).join(' ') || null,
        name: typeof comp.name === 'string' ? comp.name.slice(0, 120) : null,
      }
      try {
        writeFileDurable(f, JSON.stringify(out))
      } catch (e) {
        o.log('warn', `radar diff: source cache write failed: ${errMsg(e)}`)
      }
      return out
    })()
    srcInflight.set(key, p)
    try {
      return await p
    } finally {
      srcInflight.delete(key)
    }
  }

  function shell(e: RadarEvent): RadarCodeDiff {
    return {
      id: e.id,
      chain: e.chain,
      address: e.address,
      name: e.name,
      block: e.block,
      tx: e.tx,
      ts: e.ts,
      oldImpl: e.before?.implementation ?? null,
      newImpl: e.after?.implementation ?? null,
      oldVerified: e.before?.verified ?? null,
      newVerified: e.after?.verified ?? null,
      oldCompiler: null,
      newCompiler: null,
      state: 'unavailable',
      reason: null,
      files: [],
      unchangedFiles: 0,
      functions: [],
      totals: { files: 0, add: 0, del: 0 },
      truncated: null,
      computedAt: null,
    }
  }

  async function compute(e: RadarEvent): Promise<RadarCodeDiff> {
    const d = shell(e)
    if (e.chain === 'solana') return { ...d, reason: 'Solana program: source not published on-chain. The facts above are what the radar read.' }
    if (e.kind !== 'upgrade' || !d.oldImpl || !d.newImpl) return { ...d, reason: 'A code diff needs an upgrade with both implementations known.' }
    if (e.state === 'pending') return { ...d, state: 'pending', reason: 'The radar is still reading this upgrade.' }
    if (!diffable(e)) {
      const side = !String(d.oldVerified).startsWith('sourcify') ? 'old' : 'new'
      return { ...d, reason: `The ${side} implementation has no verified source on Sourcify, so there is no source to compare.` }
    }
    try {
      const [a, b] = [await sources(e.chain, d.oldImpl), await sources(e.chain, d.newImpl)]
      if (!a.sources || !b.sources) return { ...d, reason: `Sourcify returned no source files for the ${!a.sources ? 'old' : 'new'} implementation.` }
      const r = diffSources(a.sources, b.sources, undefined, b.name ?? e.name)
      return {
        ...d,
        oldCompiler: a.compiler,
        newCompiler: b.compiler,
        state: 'ready',
        reason: r.files.length ? null : 'The two implementations have identical source files.',
        files: r.files,
        unchangedFiles: r.unchangedFiles,
        functions: r.functions,
        totals: r.totals,
        truncated: r.truncated,
        computedAt: now(),
      }
    } catch (err) {
      if (err instanceof BudgetError) {
        const hour = budget.why('sourcify') === 'hour'
        return { ...d, state: 'pending', reason: hour ? 'The Sourcify share for this hour is used; the diff is fetched in the next hour.' : 'The Sourcify budget for today is used; the diff is fetched after 00:00 UTC.' }
      }
      o.log('warn', `radar diff ${e.id}: ${errMsg(err)}`)
      return { ...d, state: 'pending', reason: 'Sourcify could not be reached; the diff is retried on the next request.' }
    }
  }

  async function get(id: string): Promise<{ json: string; ready: boolean } | null> {
    const m = mem.get(id)
    if (m && (m.ready || now() - m.at < SOFT_TTL)) return { json: m.json, ready: m.ready }
    const disk = fs.existsSync(diffFile(id)) ? readJson<RadarCodeDiff>(diffFile(id)) : null
    if (disk) {
      const v = { json: JSON.stringify(disk), ready: true }
      remember(id, v)
      return v
    }
    const e = o.radar.get(id)
    if (!e) return null
    let run = inflight.get(id)
    if (!run) {
      run = compute(e)
      inflight.set(id, run)
      run.finally(() => inflight.delete(id)).catch(() => {})
    }
    const d = await run
    const final = d.state === 'ready' || (d.state === 'unavailable' && e.state !== 'pending')
    if (d.state === 'ready') {
      try {
        writeFileDurable(diffFile(id), JSON.stringify(d))
      } catch (err) {
        o.log('warn', `radar diff: cache write failed: ${errMsg(err)}`)
      }
    }
    const v = { json: JSON.stringify(d), ready: final && d.state === 'ready' }
    remember(id, v)
    budget.flush()
    return v
  }

  async function backfillPass(): Promise<void> {
    let done = 0
    let cursor: string | undefined
    for (let page = 0; page < 5 && done < BACKFILL_PER_PASS && !stopped; page++) {
      const r = o.radar.list({ kind: 'upgrade', limit: 100, cursor })
      for (const e of r.items) {
        if (stopped || done >= BACKFILL_PER_PASS) break
        if (!diffable(e) || e.state === 'pending' || fs.existsSync(diffFile(e.id))) continue
        if (!budget.can('sourcify', 2) || !sharedRoom()) return
        const v = await get(e.id).catch(() => null)
        done++
        if (v && !v.ready) continue
        await new Promise((res) => setTimeout(res, 2_000).unref?.())
      }
      if (!r.next) break
      cursor = r.next
    }
    if (done) o.log('info', `radar diff: backfill computed ${done} diff${done === 1 ? '' : 's'}`)
  }

  return {
    start() {
      if (timer || stopped || o.backfill === false) return
      const loop = (ms: number) => {
        timer = setTimeout(() => {
          backfillPass()
            .catch((e) => o.log('warn', `radar diff backfill: ${errMsg(e)}`))
            .finally(() => !stopped && loop(BACKFILL_EVERY_MS))
        }, ms)
        timer.unref?.()
      }
      loop(BACKFILL_FIRST_MS)
    },
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      await Promise.allSettled([...inflight.values()])
      budget.flush()
    },
    get,
  }
}
