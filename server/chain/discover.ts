// Chain discovery: where the chain agents' candidates come from. Nobody hands them addresses.
//
//   1. block sampling  Solana: getSlot → getBlock(slot − lag) on the discovery RPC (free public
//                      endpoint, own budget) every LUSCA_CHAIN_SOL_BLOCK_S (90 s); programs invoked by
//                      the block's transactions (top-level + inner, v0 lookup-table accounts resolved),
//                      natives / SPL core skipped. EVM (ethereum, base, arbitrum): eth_getBlockByNumber
//                      ('latest', true) every LUSCA_CHAIN_EVM_BLOCK_S (60 s): contracts called with
//                      calldata (token transfer traffic down-weighted) + contracts created by the block.
//                      Creations are queued only CREATION_DELAY (6 h) after their block: read minutes
//                      after deployment they are almost never verified yet.
//   2. registries      Sourcify v2 recently verified contracts per EVM chain and the OtterSec list of
//                      verified Solana programs, every LUSCA_CHAIN_REGISTRY_MIN (30 min), ≤ 1 req/s.
//   3. web corpus      new lines of <dataDir>/dataset.jsonl (persisted offset, rotation-aware): explorer
//                      links, declare_id!, addresses named as programs / contracts (discover/extract.ts).
//                      LUSCA_CHAIN_CORPUS=0 turns it off; LUSCA_CHAIN_CORPUS_BACKLOG_MB limits the first
//                      pass over an existing file (0 = whole file, read slowly).
//   4. links           pushed by the agents (proxy → implementation) through push().
//
// Candidates land in a per-chain frontier (discover/frontier.ts): max-heap by score with aging, cap
// LUSCA_CHAIN_FRONTIER_CAP (5 000) per chain, nothing re-read within 7 days. State (queues, seen
// map, corpus offset, registry cursors) is saved to <dataDir>/chain/frontier.json (tmp + rename)
// every 2 min and on stop, and restored on start (also right after a slow corpus step, so a slow line
// is never replayed after a restart). Sampling never runs on a used-up budget.

import fs from 'node:fs'
import path from 'node:path'
import type { ChainId, FoundVia, Verdict } from '../../shared/chain.ts'
import { BudgetError, RpcError, type EvmChain, type RpcCtx } from './rpc.ts'
import { ChainFrontier, VIAS, type FrontierConfig, type FrontierJson, type PushResult } from './discover/frontier.ts'
import { parseSolanaBlock, requiredTxVersion, type SolanaBlockActivity } from './discover/solblock.ts'
import { parseEvmBlock, type EvmBlockActivity } from './discover/evmblock.ts'
import { emptyExtractCounters, extractMentions, type ExtractCounters } from './discover/extract.ts'
import { CorpusTail, sanitizeCorpusState } from './discover/corpus.ts'
import {
  REGISTRY_SCORE,
  SOURCIFY_PAGE,
  emptyRegistryState,
  osecListUrl,
  parseOsecPage,
  parseSourcifyList,
  sanitizeRegistryState,
  sourcifyListUrl,
  sourcifyScores,
  type RegistryState,
} from './discover/registry.ts'

export interface Candidate {
  chain: ChainId
  address: string
  via: FoundVia
  score: number
  hint?: string
}

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

export const CHAINS: readonly ChainId[] = ['solana', 'ethereum', 'base', 'arbitrum']
export const EVM_CHAINS: readonly EvmChain[] = ['ethereum', 'base', 'arbitrum']

export interface DiscoveryConfig {
  /** Solana block sample interval, ms */
  solBlockMs: number
  /** EVM block sample interval per chain, ms */
  evmBlockMs: number
  /** registry poll interval, ms */
  registryMs: number
  blocks: boolean
  registries: boolean
  corpus: boolean
  /** first pass over an existing dataset.jsonl: bytes before the end (0 = whole file) */
  corpusBacklogBytes: number
  corpusChunkBytes: number
  /** corpus step spacing while behind / when caught up, ms */
  corpusBusyMs: number
  corpusIdleMs: number
  saveMs: number
  /** delay before the first sample of each source, ms */
  startDelayMs: number
  /** maxSupportedTransactionVersion sent with getBlock (raised automatically on -32015) */
  solTxVersion: number
  /** Sourcify pages per chain per poll (newest first, stops at already-taken rows) */
  sourcifyPages: number
  /** OtterSec list pages per poll */
  osecPages: number
  frontier: Partial<FrontierConfig>
}

function intEnv(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return def
  const v = Number(raw)
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : def
}

export function discoveryConfigFromEnv(): DiscoveryConfig {
  return {
    solBlockMs: intEnv('LUSCA_CHAIN_SOL_BLOCK_S', 90, 10, 86_400) * 1000,
    evmBlockMs: intEnv('LUSCA_CHAIN_EVM_BLOCK_S', 60, 10, 86_400) * 1000,
    registryMs: intEnv('LUSCA_CHAIN_REGISTRY_MIN', 30, 5, 10_080) * 60_000,
    blocks: true,
    registries: true,
    corpus: process.env.LUSCA_CHAIN_CORPUS?.trim() !== '0',
    corpusBacklogBytes: intEnv('LUSCA_CHAIN_CORPUS_BACKLOG_MB', 0, 0, 1_000_000) * 1048576,
    corpusChunkBytes: 1 << 20,
    corpusBusyMs: 2_000,
    corpusIdleMs: 20_000,
    saveMs: 120_000,
    startDelayMs: 5_000,
    solTxVersion: intEnv('LUSCA_CHAIN_SOL_TX_VERSION', 1, 0, 255),
    sourcifyPages: 3,
    osecPages: 8,
    frontier: { cap: intEnv('LUSCA_CHAIN_FRONTIER_CAP', 5000, 100, 100_000) },
  }
}

/** Score of one block observation (summed into the frontier with aging). */
export const blockScore = (txs: number): number => Math.log2(1 + Math.max(0, txs))
const TOKEN_SHARE = 0.6
const TOKEN_FACTOR = 0.25
const CREATION_SCORE = 1.5
const LINK_SCORE = 8
/** A created contract is offered this long after its block (time for its author to verify it). */
export const CREATION_DELAY_MS = 6 * 3_600_000
/** Creations waiting at most, per chain (oldest dropped). */
const DEFERRED_MAX = 1000
/** A corpus step slower than this saves the state right away. */
const SLOW_STEP_MS = 1000

export interface Discovery {
  start(): void
  stop(): Promise<void>
  next(chain: ChainId): Candidate | null
  push(c: Candidate): void
  /** `verdict` 'unverified' / 'error' gives the address a short ttl (frontier.ts SOFT_VERDICTS). */
  markRead(chain: ChainId, address: string, verdict?: Verdict): void
  stats(): Record<string, number>
  /** one round of each source, for tests and the live check */
  run: {
    solana(): Promise<SolanaBlockActivity | null>
    evm(chain: EvmChain): Promise<EvmBlockActivity | null>
    registries(): Promise<void>
    corpus(): Promise<{ lines: number; caughtUp: boolean }>
  }
  save(): void
}

interface SavedState {
  v: 1
  savedAt: number
  chains: Partial<Record<ChainId, FrontierJson>>
  corpus: unknown
  registry: RegistryState
  counters: Record<string, number>
  /** contract creations waiting for CREATION_DELAY: [chain, address, notBefore, hint] */
  deferred?: [EvmChain, string, number, string][]
}

const MB = 1048576

export function createDiscovery(opts: {
  rpc: RpcCtx
  dataDir: string
  log: Log
  config?: Partial<DiscoveryConfig>
  now?: () => number
}): Discovery {
  const cfg: DiscoveryConfig = { ...discoveryConfigFromEnv(), ...opts.config }
  const rpc = opts.rpc
  const log = opts.log
  const now = opts.now ?? Date.now
  const dir = path.join(opts.dataDir, 'chain')
  const file = path.join(dir, 'frontier.json')

  const frontiers = new Map<ChainId, ChainFrontier>(CHAINS.map((c) => [c, new ChainFrontier(c, cfg.frontier)]))
  let registry: RegistryState = emptyRegistryState()
  const xc: ExtractCounters = emptyExtractCounters()
  const counters: Record<string, number> = {}
  const inc = (k: string, n = 1) => {
    counters[k] = (counters[k] ?? 0) + n
  }
  let solTxVersion = cfg.solTxVersion
  let dirty = false
  /** contract creations waiting to be offered, oldest first */
  const deferred = new Map<EvmChain, { address: string; notBefore: number; hint: string }[]>(EVM_CHAINS.map((c) => [c, []]))

  // ── restore ──
  let corpusState = null as ReturnType<typeof sanitizeCorpusState>
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const j = JSON.parse(raw) as Partial<SavedState>
    const t = now()
    let rows = 0
    if (j && typeof j === 'object' && j.chains && typeof j.chains === 'object') {
      for (const c of CHAINS) rows += frontiers.get(c)!.load(j.chains[c], t)
    }
    corpusState = sanitizeCorpusState(j?.corpus)
    registry = sanitizeRegistryState(j?.registry)
    if (j?.counters && typeof j.counters === 'object') {
      for (const [k, v] of Object.entries(j.counters)) if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && k.length < 64) counters[k] = v
    }
    if (Array.isArray(j?.deferred)) {
      for (const r of j.deferred) {
        if (!Array.isArray(r) || !EVM_CHAINS.includes(r[0]) || typeof r[1] !== 'string' || typeof r[2] !== 'number' || !Number.isFinite(r[2])) continue
        const arr = deferred.get(r[0])!
        if (arr.length < DEFERRED_MAX) arr.push({ address: r[1], notBefore: Math.min(r[2], t + CREATION_DELAY_MS), hint: typeof r[3] === 'string' ? r[3].slice(0, 160) : '' })
      }
    }
    log('info', `chain discovery: restored ${rows} queued candidates`)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      log('warn', `chain discovery: frontier.json unreadable (${(e as Error).message?.slice(0, 120)}); starting fresh`)
      try {
        fs.renameSync(file, `${file}.bad`)
      } catch {
        /* nothing to move aside */
      }
    }
  }
  const tail = new CorpusTail(opts.dataDir, corpusState, { chunkBytes: cfg.corpusChunkBytes, backlogBytes: cfg.corpusBacklogBytes })

  // ── frontier access ──
  const pushResultCount = (via: FoundVia, r: PushResult) => {
    if (r === 'added') inc(`found.${via}`)
    else if (r === 'bumped') inc('bumps')
    else if (r === 'seen') inc('skipped.seen')
    else if (r === 'dropped') inc('dropped')
  }

  /** Discovery's own sources: an address being read right now is not queued again. */
  function offer(c: Candidate): PushResult {
    const f = frontiers.get(c.chain)
    if (!f) return 'invalid'
    const r = f.push(c, now())
    pushResultCount(c.via, r)
    if (r === 'added' || r === 'bumped') dirty = true
    return r
  }

  // ── error logging (first, then at most every 10 min per source) ──
  const errSeen = new Map<string, { n: number; at: number }>()
  function fail(source: string, e: unknown) {
    if (e instanceof BudgetError) {
      inc('budgetWaits')
      return
    }
    if (e instanceof RpcError && e.kind === 'closed') return
    inc('errors')
    const s = errSeen.get(source) ?? { n: 0, at: 0 }
    s.n++
    const t = now()
    if (s.n === 1 || t - s.at > 600_000) {
      log('warn', `chain discovery ${source}: ${(e as Error)?.message ?? String(e)}${s.n > 1 ? ` (${s.n} errors so far)` : ''}`)
      s.at = t
    }
    errSeen.set(source, s)
  }

  // ── 1. block sampling ──
  async function sampleSolana(): Promise<SolanaBlockActivity | null> {
    if (!rpc.canSpend('solana', 2, true)) {
      inc('budgetWaits')
      return null
    }
    const tip = await rpc.call('solana', 'getSlot', [{ commitment: 'finalized' }], { discovery: true })
    if (typeof tip !== 'number' || !Number.isSafeInteger(tip) || tip < 100) throw new Error('getSlot: unexpected result')
    let slot = tip - (2 + Math.floor(Math.random() * 6))
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!rpc.canSpend('solana', 1, true)) {
        inc('budgetWaits')
        return null
      }
      let block: unknown
      try {
        block = await rpc.call(
          'solana',
          'getBlock',
          [slot, { encoding: 'json', transactionDetails: 'full', maxSupportedTransactionVersion: solTxVersion, rewards: false, commitment: 'finalized' }],
          { discovery: true, timeoutMs: 15_000, maxBytes: 10 * MB },
        )
      } catch (e) {
        if (e instanceof RpcError && e.kind === 'rpc') {
          const need = e.code === -32015 ? requiredTxVersion(e.message) : null
          if (need !== null && need > solTxVersion) {
            log('info', `chain discovery: Solana blocks carry transaction version ${need}; sampling with maxSupportedTransactionVersion ${need}`)
            solTxVersion = need
            continue
          }
          // -32004 block not available, -32007 slot skipped, -32009 missing in long-term storage
          if (e.code === -32004 || e.code === -32007 || e.code === -32009) {
            slot--
            continue
          }
        }
        if (e instanceof RpcError && e.kind === 'too-large') {
          inc('blocks.tooLarge') // a peak block over the 10 MB cap: take the one before
          slot--
          continue
        }
        throw e
      }
      if (block === null) {
        slot-- // skipped slot
        continue
      }
      const act = parseSolanaBlock(block, slot)
      inc('blocks.solana')
      let natives = 0
      for (const v of act.natives.values()) natives += v.txs
      inc('natives', natives)
      for (const [pid, v] of act.programs) {
        offer({ chain: 'solana', address: pid, via: 'block', score: blockScore(v.txs), hint: `invoked by ${v.txs} tx in slot ${slot}` })
      }
      return act
    }
    return null
  }

  async function sampleEvm(chain: EvmChain): Promise<EvmBlockActivity | null> {
    if (!rpc.canSpend(chain, 1, true)) {
      inc('budgetWaits')
      return null
    }
    const block = await rpc.call(chain, 'eth_getBlockByNumber', ['latest', true], { discovery: true, timeoutMs: 10_000, maxBytes: 10 * MB })
    if (!block) return null
    const act = parseEvmBlock(block)
    inc(`blocks.${chain}`)
    const n = act.number ?? 0
    for (const [lower, v] of act.calls) {
      const tokenish = v.token / v.txs > TOKEN_SHARE
      offer({ chain, address: lower, via: 'block', score: blockScore(v.txs) * (tokenish ? TOKEN_FACTOR : 1), hint: `called by ${v.txs} tx in block ${n}` })
    }
    // creations wait CREATION_DELAY before they are offered (verified by then, or not worth a read yet)
    const t = now()
    const wait = deferred.get(chain)!
    for (const a of act.creations) {
      inc('creations')
      wait.push({ address: a, notBefore: t + CREATION_DELAY_MS, hint: `created in block ${n}` })
      dirty = true
    }
    if (wait.length > DEFERRED_MAX) wait.splice(0, wait.length - DEFERRED_MAX)
    releaseDeferred(chain, t)
    return act
  }

  /** Offer the creations whose delay is over. */
  function releaseDeferred(chain: EvmChain, t: number) {
    const wait = deferred.get(chain)!
    let k = 0
    while (k < wait.length && wait[k].notBefore <= t) {
      const d = wait[k++]
      offer({ chain, address: d.address, via: 'block', score: CREATION_SCORE, hint: d.hint })
    }
    if (k) {
      wait.splice(0, k)
      dirty = true
    }
  }

  // ── 2. registries ──
  async function pollRegistries(): Promise<void> {
    for (const chain of EVM_CHAINS) {
      try {
        await pollSourcify(chain)
      } catch (e) {
        fail(`sourcify ${chain}`, e)
      }
    }
    try {
      await pollOsec()
    } catch (e) {
      fail('osec', e)
    }
    registry.lastPollAt = now()
    dirty = true
  }

  async function pollSourcify(chain: EvmChain) {
    const last = registry.sourcify[chain] ?? 0
    let newest = last
    let after: number | undefined
    try {
      for (let page = 0; page < cfg.sourcifyPages; page++) {
        const j = await rpc.fetchJson(sourcifyListUrl(chain, after), { host: 'sourcify', maxBytes: 2 * MB, timeoutMs: 10_000 })
        const rows = parseSourcifyList(j)
        if (!rows.length) break
        for (const r of rows) newest = Math.max(newest, r.matchId)
        const fresh = rows.filter((r) => r.matchId > last)
        inc('registry.sourcify', fresh.length)
        for (const s of sourcifyScores(fresh)) offer({ chain, address: s.address, via: 'registry', score: s.score, hint: s.hint })
        // first poll ever: newest page only; later: page back until rows already taken
        if (last === 0 || fresh.length < rows.length || rows.length < SOURCIFY_PAGE) break
        after = rows[rows.length - 1].matchId
      }
    } finally {
      registry.sourcify[chain] = newest // pages already taken stay taken if a later page fails
    }
  }

  async function pollOsec() {
    for (let i = 0; i < cfg.osecPages; i++) {
      const page = registry.osec.nextPage || 1
      const j = await rpc.fetchJson(osecListUrl(page), { host: 'osec', maxBytes: 1 * MB, timeoutMs: 10_000 })
      const p = parseOsecPage(j)
      if (!p) throw new Error('OtterSec list: unexpected response')
      inc('registry.osec', p.programs.length)
      for (const pid of p.programs) offer({ chain: 'solana', address: pid, via: 'registry', score: REGISTRY_SCORE.osec, hint: 'OtterSec verified build' })
      registry.osec.totalPages = p.totalPages
      if (page >= p.totalPages || p.programs.length === 0) {
        registry.osec.nextPage = 1
        registry.osec.sweeps++
        break // one full sweep per poll at most
      }
      registry.osec.nextPage = page + 1
    }
  }

  // ── 3. web corpus ──
  const MAYBE_ADDR_RE = /0x[0-9a-fA-F]{40}|solscan\.io|explorer\.solana\.com|solana\.fm|orb\.helius|solanabeach|etherscan\.io|basescan\.org|arbiscan\.io|blockscout\.com|declare_id|rogram|rotocol|idl|IDL|eployed|uthority|erified/
  function onCorpusLine(line: string) {
    if (!MAYBE_ADDR_RE.test(line)) return
    let j: { text?: unknown; url?: unknown; title?: unknown; host?: unknown }
    try {
      j = JSON.parse(line)
    } catch {
      inc('corpus.bad')
      return
    }
    if (!j || typeof j !== 'object') return
    const mentions = extractMentions(
      {
        text: typeof j.text === 'string' ? j.text : '',
        url: typeof j.url === 'string' ? j.url : '',
        title: typeof j.title === 'string' ? j.title : '',
        host: typeof j.host === 'string' ? j.host : '',
      },
      xc,
    )
    for (const m of mentions) offer({ chain: m.chain, address: m.address, via: 'web', score: m.score, hint: m.hint })
  }

  let corpusBehind = 0
  async function corpusStep(): Promise<{ lines: number; caughtUp: boolean }> {
    const t0 = Date.now()
    const r = await tail.step(onCorpusLine)
    corpusBehind = r.behind
    if (r.rotated) log('info', 'chain discovery: dataset.jsonl rotated; finishing the archive, then the new file')
    if (r.lines || r.rotated) dirty = true
    // a slow step is saved at once: after a restart the tail must not replay (and stall on) it again
    if (r.lines && Date.now() - t0 > SLOW_STEP_MS) save()
    return { lines: r.lines, caughtUp: r.caughtUp }
  }

  // ── persistence ──
  function save() {
    const t = now()
    for (const f of frontiers.values()) f.prune(t)
    const state: SavedState = {
      v: 1,
      savedAt: t,
      chains: Object.fromEntries(CHAINS.map((c) => [c, frontiers.get(c)!.toJSON()])),
      corpus: tail.state(),
      registry,
      counters: { ...counters, ...prefixed(xc) },
      deferred: EVM_CHAINS.flatMap((c) => deferred.get(c)!.map((d) => [c, d.address, d.notBefore, d.hint] as [EvmChain, string, number, string])),
    }
    try {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(state))
      fs.renameSync(tmp, file)
      dirty = false
    } catch (e) {
      log('warn', `chain discovery: frontier.json save failed: ${(e as Error).message?.slice(0, 160)}`)
    }
  }
  // extraction counters are cumulative across restarts too
  for (const k of Object.keys(xc) as (keyof ExtractCounters)[]) {
    const saved = counters[`skipped.${k}`]
    if (typeof saved === 'number') xc[k] = saved
    delete counters[`skipped.${k}`]
  }
  function prefixed(c: ExtractCounters): Record<string, number> {
    const o: Record<string, number> = {}
    for (const [k, v] of Object.entries(c)) o[`skipped.${k}`] = v
    return o
  }

  // ── loops ──
  let started = false
  let stopped = false
  const timers = new Set<NodeJS.Timeout>()
  const busy = new Set<Promise<unknown>>()
  const jitter = (ms: number) => Math.round(ms * (0.9 + Math.random() * 0.2))

  /** Run body after firstMs, then again after the delay it returns (fallbackMs after a failure). */
  function loop(name: string, firstMs: number, fallbackMs: number, body: () => Promise<number>) {
    const schedule = (ms: number) => {
      if (stopped) return
      const t = setTimeout(() => {
        timers.delete(t)
        if (stopped) return
        const p: Promise<void> = body()
          .catch((e: unknown) => {
            fail(name, e)
            return fallbackMs
          })
          .then((nextMs) => {
            busy.delete(p)
            schedule(nextMs)
          })
        busy.add(p)
      }, Math.max(0, ms))
      t.unref?.()
      timers.add(t)
    }
    schedule(firstMs)
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      const d = cfg.startDelayMs
      const step = Math.min(4_000, d) // sources start staggered, not all at once
      if (cfg.blocks) {
        loop('solana', d, cfg.solBlockMs, async () => {
          await sampleSolana().catch((e: unknown) => fail('solana block', e))
          return jitter(cfg.solBlockMs)
        })
        EVM_CHAINS.forEach((chain, i) => {
          loop(chain, d + step * (i + 1), cfg.evmBlockMs, async () => {
            await sampleEvm(chain).catch((e: unknown) => fail(`${chain} block`, e))
            return jitter(cfg.evmBlockMs)
          })
        })
      }
      if (cfg.registries) {
        // after a restart the next poll keeps its schedule (never sooner than the start delay, never later than one interval)
        const since = Math.max(0, now() - registry.lastPollAt)
        loop('registries', Math.max(d + 6 * step, cfg.registryMs - since), cfg.registryMs, async () => {
          await pollRegistries()
          return jitter(cfg.registryMs)
        })
      }
      if (cfg.corpus) {
        loop('corpus', d + step / 2, cfg.corpusIdleMs, async () => {
          const r = await corpusStep()
          return r.caughtUp ? cfg.corpusIdleMs : cfg.corpusBusyMs
        })
      }
      loop('save', cfg.saveMs, cfg.saveMs, async () => {
        if (dirty) save()
        return cfg.saveMs
      })
      log(
        'info',
        `chain discovery: block sampling (Solana every ${Math.round(cfg.solBlockMs / 1000)} s, EVM every ${Math.round(cfg.evmBlockMs / 1000)} s), registries every ${Math.round(cfg.registryMs / 60_000)} min, web corpus ${cfg.corpus ? 'on' : 'off'}`,
      )
    },

    async stop() {
      if (stopped) return
      stopped = true
      for (const t of timers) clearTimeout(t)
      timers.clear()
      await Promise.allSettled([...busy])
      save()
    },

    next(chain) {
      const f = frontiers.get(chain)
      if (!f) return null
      const c = f.pop(now())
      if (c) dirty = true
      return c
    },

    /** From the agents: links (proxy → implementation) and candidates handed back unread. */
    push(c) {
      const f = frontiers.get(c?.chain)
      if (!f || !VIAS.includes(c.via)) return
      const score = Number.isFinite(c.score) && c.score > 0 ? c.score : c.via === 'link' ? LINK_SCORE : 1
      // a candidate coming back from an agent is in flight: release it first
      f.markInflightDone(c.address)
      const r = f.push({ address: c.address, via: c.via, score, hint: c.hint }, now())
      pushResultCount(c.via, r)
      if (r === 'added' || r === 'bumped') dirty = true
    },

    markRead(chain, address, verdict) {
      const f = frontiers.get(chain)
      if (!f) return
      f.markRead(address, now(), verdict)
      dirty = true
    },

    stats() {
      const s: Record<string, number> = {}
      let seen = 0
      let inflight = 0
      for (const [c, f] of frontiers) {
        s[c] = f.size
        seen += f.seenSize
        inflight += f.inflightSize
      }
      s.seen = seen
      s.inflight = inflight
      s.deferred = EVM_CHAINS.reduce((n, c) => n + deferred.get(c)!.length, 0)
      for (const v of VIAS) s[`found.${v}`] = counters[`found.${v}`] ?? 0
      for (const [k, v] of Object.entries(counters)) if (!(k in s)) s[k] = v
      for (const [k, v] of Object.entries(prefixed(xc))) s[k] = v
      const ts = tail.state()
      s['corpus.lines'] = ts.lines
      s['corpus.mb'] = Math.round((ts.bytes / MB) * 10) / 10
      s['corpus.behindMb'] = Math.round((corpusBehind / MB) * 10) / 10
      s['osec.sweeps'] = registry.osec.sweeps
      return s
    },

    run: {
      solana: sampleSolana,
      evm: sampleEvm,
      registries: pollRegistries,
      corpus: corpusStep,
    },
    save,
  }
}
