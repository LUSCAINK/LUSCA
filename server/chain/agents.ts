// The chain agents' loop, with every dependency injected (index.ts wires the real ones; tests use stubs).
//
// Each agent: best candidate of its chain from discovery → read over RPC → evaluate → keep or reject
// (store) → mark read → feed event → proxy implementations back into discovery (via 'link').
// ≥ 4 s between reads per agent, paced so the day's budget lasts until 00:00 UTC; an agent waits in
// state 'waiting-budget' when a budget it needs is used up.
//
// A failure of an endpoint (RPC, Sourcify or OtterSec timing out, refusing, rate limiting, answering
// garbage) says nothing about the address: the candidate goes back into the frontier without using
// up its retry, and after a few such failures in a row the endpoint's breaker opens: the agents that
// need it pause (state 'error') with exponential backoff (1 → 30 min), then one probe read decides.
// Kept code read within the last week is not read again (nothing to learn, budget saved).

import type { ChainAgentInfo, ChainEvent, ChainId, ChainIndexItem, ChainRead, ChainStats, FoundVia, ReadKind, Verdict } from '../../shared/chain.ts'
import { BudgetError, RpcError, redact, type BudgetKey, type RpcCtx } from './rpc.ts'
import { itemKey, shortAddr, type ChainStore } from './store.ts'

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void
export type EvmChain = 'ethereum' | 'base' | 'arbitrum'

/** Same shape as server/chain/discover.ts Candidate. */
export interface ChainCandidate {
  chain: ChainId
  address: string
  via: FoundVia
  score: number
  hint?: string
}

/** Same shape as createDiscovery()'s result. */
export interface DiscoveryLike {
  start(): void
  stop(): Promise<void>
  next(chain: ChainId): ChainCandidate | null
  push(c: ChainCandidate): void
  /** `verdict` lets the frontier give a non-final read (unverified, error) a shorter time before it is read again. */
  markRead(chain: ChainId, address: string, verdict?: Verdict): void
  stats(): Record<string, number>
}

export type ReadSolanaFn = (
  address: string,
  ctx: RpcCtx,
  opts?: { skipOsec?: (codeHash: string) => boolean },
) => Promise<{ read: ChainRead; idlJson: unknown | null }>
export type ReadEvmFn = (
  chain: EvmChain,
  address: string,
  ctx: RpcCtx,
  opts?: { skipSourcify?: (codeHash: string) => boolean },
) => Promise<{
  read: ChainRead
  abiJson: unknown | null
  sources: { path: string; text: string }[]
  sourceBundleHash: string | null
  /** The reader's own boilerplate verdict (server/chain/evm-source.ts profileEvmSources), when it made one. */
  profile?: { boilerplate: string | null } | null
}>

/** RpcCtx plus the optional budget helpers of createRpc() (pacing is skipped without them). */
export type AgentRpc = RpcCtx & {
  remaining?(key: BudgetKey): number
  msUntilReset?(): number
}

export interface ChainAgentsDeps {
  rpc: AgentRpc
  discovery: DiscoveryLike
  readSolana: ReadSolanaFn
  readEvm: ReadEvmFn
  store: ChainStore
  broadcast: (msg: { t: 'chain'; event: ChainEvent }) => void
  log: Log
  agents?: { id: string; chain: ChainId }[]
  /** Minimum time between two reads of one agent, ms (default 4000). */
  minGapMs?: number
  /** Wait when discovery has no candidate, ms (default 15000). */
  idleMs?: number
  /** Re-check interval while a budget is used up, ms (default 60000). */
  budgetWaitMs?: number
  /** Pause after 5 errors in a row, ms (default 60000). */
  errorPauseMs?: number
  /** Spread each budget over the rest of the UTC day (default true). */
  pace?: boolean
  /** Delay before the first read, ms (default 0). */
  startDelayMs?: number
  /** Broadcast rate, events / s (default 4). */
  broadcastPerSec?: number
  /** Endpoint failures in a row that open its breaker (default 3). */
  breakerFails?: number
  /** First pause of an open breaker, ms (default 60 000); doubles up to breakerMaxMs. */
  breakerBaseMs?: number
  /** Longest pause of an open breaker, ms (default 30 min). */
  breakerMaxMs?: number
  /** Endpoint failures one candidate may go back into the frontier for before it is set aside (default 4). */
  endpointRetries?: number
  now?: () => number
}

export interface ChainAgents {
  start(): void
  stop(): Promise<void>
  stats(): ChainStats
  feed(limit: number): ChainEvent[]
  items(q: { chain?: ChainId; limit?: number; cursor?: string }): { items: ChainIndexItem[]; next: string | null }
  item(chain: ChainId, address: string): { item: ChainIndexItem; read: ChainRead } | null
  /** Seed the feed ring (oldest first) — index.ts restores the persisted feed. */
  restoreFeed(events: ChainEvent[]): void
  /** An event from outside the agents' loop (a Lens read handed to the store): into the feed and the broadcast. */
  record(ev: ChainEvent): void
}

export const DEFAULT_AGENTS: { id: string; chain: ChainId }[] = [
  { id: 'sol-1', chain: 'solana' },
  { id: 'sol-2', chain: 'solana' },
  { id: 'eth-1', chain: 'ethereum' },
  { id: 'base-1', chain: 'base' },
  { id: 'arb-1', chain: 'arbitrum' },
]

const FEED_MAX = 500
/** Failures worth one more try when a reader wraps the network error in a plain Error. */
const TRANSIENT_RE = /timed out|timeout|network error|rate limited|HTTP (429|5\d\d)|unavailable/i
const BROADCAST_QUEUE_MAX = 40
const MAX_GAP_MS = 10 * 60_000
/** Kept code read more recently than this is not read again. */
const KEPT_FRESH_MS = 7 * 24 * 3_600_000
/** Prefix server/chain/solana.ts writes when OtterSec could not be asked. */
const OSEC_UNAVAILABLE_PREFIX = 'OtterSec status unavailable'

/** Endpoints the agents depend on (budget keys double as endpoint names). */
type Endpoint = 'solana' | EvmChain | 'sourcify' | 'osec'

interface Breaker {
  /** endpoint failures in a row */
  fails: number
  /** paused until (ms); 0 = closed */
  openUntil: number
  /** next pause length */
  backoffMs: number
  /** a probe read is under way (half-open) */
  probing: boolean
}

/**
 * The endpoint a read failure belongs to, or null when it is about the address itself (malformed
 * account, response over the size cap, a JSON-RPC error for these params).
 */
export function endpointOfFailure(e: unknown, chain: ChainId): Endpoint | null {
  const own: Endpoint = chain === 'solana' ? 'solana' : (chain as EvmChain)
  if (!(e instanceof RpcError)) {
    const m = e instanceof Error ? e.message : String(e)
    return /^Sourcify lookup failed/.test(m) ? 'sourcify' : null
  }
  const ep: Endpoint = /^sourcify GET/.test(e.message) ? 'sourcify' : /^osec GET/.test(e.message) ? 'osec' : own
  if (e.kind === 'timeout' || e.kind === 'network' || e.kind === 'bad-json') return ep
  if (e.kind === 'http') {
    const st = e.status ?? 0
    return st === 401 || st === 403 || st === 408 || st === 429 || st >= 500 ? ep : null
  }
  if (e.kind === 'rpc' && e.transient) return ep // rate limited, internal error, node busy
  return null
}

interface AgentRun {
  info: ChainAgentInfo
  /** EMA of calls charged to each budget key per read. */
  ema: Partial<Record<BudgetKey, number>>
  errorsInRow: number
}

interface PaceKey {
  key: BudgetKey
  /** Agents drawing on this budget. */
  share: number
  /** Fraction kept for discovery (block sampling, registry polling). */
  reserve: number
  /** Initial calls per read. */
  init: number
}

export function createChainAgentsWith(d: ChainAgentsDeps): ChainAgents {
  const now = d.now ?? Date.now
  const log = d.log
  const agentsSpec = d.agents ?? DEFAULT_AGENTS
  const minGapMs = Math.max(0, d.minGapMs ?? 4000)
  const idleMs = Math.max(10, d.idleMs ?? 15_000)
  const budgetWaitMs = Math.max(10, d.budgetWaitMs ?? 60_000)
  const errorPauseMs = Math.max(10, d.errorPauseMs ?? 60_000)
  const pace = d.pace ?? true
  const startDelayMs = Math.max(0, d.startDelayMs ?? 0)
  const perSec = Math.max(1, d.broadcastPerSec ?? 4)
  const breakerFails = Math.max(1, d.breakerFails ?? 3)
  const breakerBaseMs = Math.max(10, d.breakerBaseMs ?? 60_000)
  const breakerMaxMs = Math.max(breakerBaseMs, d.breakerMaxMs ?? 30 * 60_000)
  const endpointRetries = Math.max(0, d.endpointRetries ?? 4)

  const runs: AgentRun[] = agentsSpec.map((a) => {
    const saved = d.store.summary().agents[a.id]
    return {
      info: { id: a.id, chain: a.chain, state: 'idle', current: null, reads: saved?.reads ?? 0, kept: saved?.kept ?? 0, lastAt: saved?.lastAt ?? null },
      ema: {},
      errorsInRow: 0,
    }
  })
  const solAgents = runs.filter((r) => r.info.chain === 'solana').length
  const evmAgents = runs.length - solAgents

  const feedRing: ChainEvent[] = [] // oldest first
  const queue: ChainEvent[] = []
  let flushTimer: NodeJS.Timeout | null = null
  const inFlight = new Set<string>()
  const retries = new Map<string, number>()
  const epRetries = new Map<string, number>()
  const breakers = new Map<Endpoint, Breaker>()
  let started = false
  let stopping = false
  const loops: Promise<void>[] = []
  const wakers = new Set<() => void>()
  let evSeq = 0

  function paceKeys(chain: ChainId): PaceKey[] {
    if (chain === 'solana') {
      return [
        { key: 'solana', share: Math.max(1, solAgents), reserve: 0, init: 4 },
        { key: 'osec', share: Math.max(1, solAgents), reserve: 0.2, init: 1 },
      ]
    }
    return [
      { key: chain, share: 1, reserve: 0.15, init: 2 },
      { key: 'sourcify', share: Math.max(1, evmAgents), reserve: 0.2, init: 1 },
    ]
  }

  /** Sleep that ends early on stop(). */
  function sleep(ms: number): Promise<void> {
    if (stopping || ms <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t)
        wakers.delete(done)
        resolve()
      }
      const t = setTimeout(done, ms)
      wakers.add(done)
    })
  }

  const yieldNow = () => new Promise<void>((r) => setImmediate(r))

  function usageOf(key: BudgetKey): { used: number; limit: number } | null {
    return d.rpc.usage()[key] ?? null
  }

  /**
   * ms to wait before the next read so every budget this agent draws on lasts the rest of the UTC day;
   * Infinity when a budget cannot afford one more read now.
   */
  function paceGap(run: AgentRun): number {
    if (!pace || !d.rpc.msUntilReset) return minGapMs
    const left = d.rpc.msUntilReset()
    let gap = minGapMs
    for (const pk of paceKeys(run.info.chain)) {
      const u = usageOf(pk.key)
      if (!u || u.limit <= 0) continue
      const perRead = run.ema[pk.key] ?? pk.init
      if (perRead <= 0.05) continue
      const forReads = u.limit * (1 - pk.reserve) - u.used
      if (forReads < perRead) return Infinity
      gap = Math.max(gap, (left * perRead * pk.share) / forReads)
    }
    return Math.min(gap, MAX_GAP_MS)
  }

  /** Budget that stops this agent from reading now, or null. */
  function blockedBudget(run: AgentRun): BudgetKey | null {
    const chain = run.info.chain
    const need = Math.ceil((run.ema[chain === 'solana' ? 'solana' : chain] ?? (chain === 'solana' ? 4 : 2)) + 1)
    if (!d.rpc.canSpend(chain, need)) return chain === 'solana' ? 'solana' : chain
    if (chain !== 'solana') {
      // without Sourcify nothing on an EVM chain can be verified
      const u = usageOf('sourcify')
      if (u && u.used >= u.limit) return 'sourcify'
    }
    if (paceGap(run) === Infinity) return chain === 'solana' ? 'solana' : chain
    return null
  }

  function setState(run: AgentRun, state: ChainAgentInfo['state'], current: string | null = run.info.current) {
    run.info.state = state
    run.info.current = current
  }

  // ─── endpoint breakers ─────────────────────────────────────────────────────

  const breakerOf = (ep: Endpoint): Breaker => {
    let b = breakers.get(ep)
    if (!b) {
      b = { fails: 0, openUntil: 0, backoffMs: breakerBaseMs, probing: false }
      breakers.set(ep, b)
    }
    return b
  }

  function endpointFailed(ep: Endpoint, msg: string) {
    const b = breakerOf(ep)
    b.fails++
    b.probing = false
    if (b.fails < breakerFails) return
    b.openUntil = now() + b.backoffMs
    log('warn', `chain agents: ${ep} unavailable (${b.fails} failures in a row, last: ${redact(msg).slice(0, 120)}) — reads that need it pause ${Math.round(b.backoffMs / 1000)} s`)
    b.backoffMs = Math.min(breakerMaxMs, b.backoffMs * 2)
  }

  function endpointOk(ep: Endpoint) {
    const b = breakers.get(ep)
    if (!b) return
    if (b.fails >= breakerFails) log('info', `chain agents: ${ep} answers again; reads resume`)
    breakers.delete(ep)
  }

  const endpointsOf = (chain: ChainId): Endpoint[] => (chain === 'solana' ? ['solana', 'osec'] : [chain as EvmChain, 'sourcify'])

  /**
   * An open breaker this agent's reads depend on: wait until `until`. Once the pause is over, one
   * agent gets to probe (half-open); the others keep waiting for its result.
   */
  function blockedEndpoint(run: AgentRun): { ep: Endpoint; until: number } | null {
    const t = now()
    for (const ep of endpointsOf(run.info.chain)) {
      const b = breakers.get(ep)
      if (!b || b.fails < breakerFails) continue
      if (b.openUntil > t) return { ep, until: b.openUntil }
      if (b.probing) return { ep, until: t + Math.min(budgetWaitMs, breakerBaseMs) }
    }
    for (const ep of endpointsOf(run.info.chain)) {
      const b = breakers.get(ep)
      if (b && b.fails >= breakerFails) b.probing = true
    }
    return null
  }

  /** The probe ended without a verdict on the endpoint (no candidate, skipped): let another agent probe. */
  function releaseProbe(run: AgentRun) {
    for (const ep of endpointsOf(run.info.chain)) {
      const b = breakers.get(ep)
      if (b) b.probing = false
    }
  }

  // ─── feed + broadcast ──────────────────────────────────────────────────────

  function emit(ev: ChainEvent) {
    feedRing.push(ev)
    if (feedRing.length > FEED_MAX) feedRing.splice(0, feedRing.length - FEED_MAX)
    queue.push(ev)
    if (queue.length > BROADCAST_QUEUE_MAX) queue.splice(0, queue.length - BROADCAST_QUEUE_MAX)
    if (!flushTimer) pump()
  }

  function pump() {
    const ev = queue.shift()
    if (!ev) {
      flushTimer = null
      return
    }
    try {
      d.broadcast({ t: 'chain', event: ev })
    } catch (e) {
      log('warn', `chain broadcast failed: ${(e as Error).message}`)
    }
    flushTimer = setTimeout(pump, Math.ceil(1000 / perSec))
    flushTimer.unref?.()
  }

  function makeEvent(
    run: AgentRun,
    c: ChainCandidate,
    o: { kind: ReadKind; name: string | null; verdict: Verdict; reason: string; idl: boolean; verifiedBy: 'osec' | 'sourcify' | null; sourceFiles: number; sourceBytes: number; address?: string },
  ): ChainEvent {
    const ts = now()
    return {
      id: `${ts.toString(36)}-${(++evSeq).toString(36)}`,
      ts,
      agent: run.info.id,
      chain: run.info.chain,
      address: o.address ?? c.address,
      name: o.name,
      kind: o.kind,
      via: c.via,
      verdict: o.verdict,
      reason: redact(o.reason).slice(0, 200),
      idl: o.idl,
      verifiedBy: o.verifiedBy,
      sourceFiles: o.sourceFiles,
      sourceBytes: o.sourceBytes,
    }
  }

  // ─── one read ──────────────────────────────────────────────────────────────

  async function readOne(run: AgentRun, c: ChainCandidate): Promise<'ok' | 'budget' | 'closed'> {
    const chain = run.info.chain
    const counts: Partial<Record<BudgetKey, number>> = {}
    const ctx = countingCtx(counts)
    setState(run, 'reading', c.address)
    let read: ChainRead
    let extras: {
      idlJson?: unknown | null
      abiJson?: unknown | null
      sources?: { path: string; text: string }[]
      sourceBundleHash?: string | null
      boilerplate?: string | null
    }
    const selfKey = itemKey(chain, c.address)
    try {
      if (chain === 'solana') {
        // program binary already kept: the read is a duplicate either way, so OtterSec is not asked
        const r = await d.readSolana(c.address, ctx, { skipOsec: (h) => d.store.seenCode(h) !== null })
        read = r.read
        extras = { idlJson: r.idlJson }
      } else {
        // bytecode already kept, or already judged boilerplate / unverified at another address: the
        // verdict is known, so the registry is not asked. Boilerplate is a property of the bytecode
        // (registry clones of ERC1967Proxy included); 'unverified' is not when the registry itself
        // just listed this address as verified
        const skipSourcify = (h: string) => {
          if (d.store.seenCode(h) !== null) return true
          const r = d.store.seenRejected?.(h)
          if (!r || r.key === selfKey) return false
          return r.verdict === 'boilerplate' || c.via !== 'registry'
        }
        const r = await d.readEvm(chain, c.address, ctx, { skipSourcify })
        read = r.read
        extras = { abiJson: r.abiJson, sources: r.sources, sourceBundleHash: r.sourceBundleHash, boilerplate: r.profile?.boilerplate ?? null }
      }
    } catch (e) {
      learn(run, counts)
      if (e instanceof BudgetError) {
        // nothing was decided about this candidate: back into the frontier
        d.discovery.push(c)
        return 'budget'
      }
      if ((e instanceof RpcError && e.kind === 'closed') || stopping) {
        d.discovery.push(c)
        return 'closed'
      }
      const msg = redact(e instanceof Error ? e.message : String(e))
      const ep = endpointOfFailure(e, chain)
      let retry: boolean
      if (ep) {
        // the endpoint failed, not the address: back into the frontier without using up its retry
        endpointFailed(ep, msg)
        retry = requeueForEndpoint(c)
        // the other endpoints of this read answered
        for (const k of Object.keys(counts) as BudgetKey[]) if (k !== ep && k !== 'solana-discovery' && (counts[k] ?? 0) > 0) endpointOk(k as Endpoint)
      } else {
        const transient = e instanceof RpcError ? e.transient : TRANSIENT_RE.test(e instanceof Error ? e.message : String(e))
        retry = requeueOrMark(c, transient, 'error')
        run.errorsInRow++
      }
      d.store.countError(run.info.id, chain)
      run.info.reads++
      run.info.lastAt = now()
      emit(makeEvent(run, c, { kind: 'account', name: null, verdict: 'error', reason: `${msg}${retry ? ' — will retry' : ''}`, idl: false, verifiedBy: null, sourceFiles: 0, sourceBytes: 0 }))
      setState(run, 'error', null)
      return 'ok'
    }
    learn(run, counts)
    await yieldNow()

    // OtterSec could not be asked: an endpoint failure (or its budget), not a fact about the program
    const osecNote = chain === 'solana' ? read.notes.find((n) => n.startsWith(OSEC_UNAVAILABLE_PREFIX)) : undefined
    const osecBudget = !!osecNote && /budget/i.test(osecNote)
    const hasIdl = read.idl !== null || (extras.idlJson !== undefined && extras.idlJson !== null)
    // the read went through: its chain's RPC answered (every read starts with an account / code fetch)
    endpointOk(chain === 'solana' ? 'solana' : chain)
    for (const k of Object.keys(counts) as BudgetKey[]) {
      if (k === 'solana-discovery' || (counts[k] ?? 0) === 0) continue
      if (k === 'osec' && osecNote) continue
      endpointOk(k as Endpoint)
    }
    if (osecBudget && read.kind === 'program' && !hasIdl) {
      // without OtterSec and without an IDL nothing can be decided: wait for the budget reset
      d.discovery.push(c)
      return 'budget'
    }
    if (osecNote && !osecBudget) endpointFailed('osec', osecNote)

    const res = await d.store.process({ agent: run.info.id, via: c.via, read, ...extras })
    // nothing was decided about this program (OtterSec failed, no IDL): back into the frontier
    const osecRetry = res.retry === true && !!osecNote
    const retry = osecRetry ? requeueForEndpoint(c) : requeueOrMark(c, res.retry === true, res.verdict)
    run.info.reads++
    run.info.lastAt = now()
    if (res.verdict === 'kept') run.info.kept++
    run.errorsInRow = res.verdict === 'error' && !osecRetry ? run.errorsInRow + 1 : 0

    // links: the implementation behind a proxy is the code worth reading
    if (read.proxy?.implementation && chain !== 'solana' && read.proxy.implementation.toLowerCase() !== c.address.toLowerCase()) {
      d.discovery.push({ chain, address: read.proxy.implementation, via: 'link', score: c.score + 1, hint: `implementation of ${shortAddr(c.address)}` })
    }

    const srcFiles = extras.sources?.length || read.sources.length
    const srcBytes = res.item?.sourceBytes ?? (extras.sources?.length ? extras.sources.reduce((s, f) => s + Buffer.byteLength(f.text ?? '', 'utf8'), 0) : read.sources.reduce((s, f) => s + f.bytes, 0))
    emit(
      makeEvent(run, c, {
        kind: read.kind,
        name: read.name,
        verdict: res.verdict,
        reason: `${res.reason}${retry ? ' — will retry' : ''}`,
        idl: hasIdl,
        verifiedBy: read.verified?.by ?? null,
        sourceFiles: srcFiles,
        sourceBytes: srcBytes,
        address: read.address || c.address,
      }),
    )
    setState(run, res.verdict === 'error' ? 'error' : 'idle', null)
    return 'ok'
  }

  /** A transient failure goes back into the frontier once (at half its score); anything else is marked read. */
  function requeueOrMark(c: ChainCandidate, transient: boolean, verdict: Verdict): boolean {
    const k = `${c.chain}:${c.address}`
    const tries = retries.get(k) ?? 0
    if (transient && tries < 1) {
      retries.set(k, tries + 1)
      if (retries.size > 2000) retries.delete(retries.keys().next().value!)
      d.discovery.push({ ...c, score: c.score * 0.5 })
      return true
    }
    retries.delete(k)
    epRetries.delete(k)
    d.discovery.markRead(c.chain, c.address, verdict)
    return false
  }

  /**
   * An endpoint failed during this candidate's read: back into the frontier at its score, without
   * using up its retry. A candidate that keeps meeting failures (endpointRetries) is set aside as
   * an 'error' read (the frontier offers it again after a short time).
   */
  function requeueForEndpoint(c: ChainCandidate): boolean {
    const k = `${c.chain}:${c.address}`
    const tries = epRetries.get(k) ?? 0
    if (tries < endpointRetries) {
      epRetries.set(k, tries + 1)
      if (epRetries.size > 2000) epRetries.delete(epRetries.keys().next().value!)
      d.discovery.push(c)
      return true
    }
    epRetries.delete(k)
    retries.delete(k)
    d.discovery.markRead(c.chain, c.address, 'error')
    return false
  }

  /** Update the per-read call EMA from the usage delta around one read. */
  function learn(run: AgentRun, counts: Partial<Record<BudgetKey, number>>) {
    for (const pk of paceKeys(run.info.chain)) {
      const prev = run.ema[pk.key] ?? pk.init
      run.ema[pk.key] = prev * 0.8 + (counts[pk.key] ?? 0) * 0.2
    }
  }

  /** The RPC context handed to one read: the shared one, counting this read's calls per budget. */
  function countingCtx(counts: Partial<Record<BudgetKey, number>>): RpcCtx {
    const bump = (k: BudgetKey | null) => {
      if (k) counts[k] = (counts[k] ?? 0) + 1
    }
    return {
      call(chain, method, params, o) {
        bump(chain === 'solana' ? (o?.discovery ? 'solana-discovery' : 'solana') : chain)
        return d.rpc.call(chain, method, params, o)
      },
      fetchJson(url, o) {
        bump(o?.host ?? (/^https?:\/\/([^/]+\.)?sourcify\.dev\b/i.test(url) ? 'sourcify' : /^https?:\/\/([^/]+\.)?osec\.io\b/i.test(url) ? 'osec' : null))
        return d.rpc.fetchJson(url, o)
      },
      usage: () => d.rpc.usage(),
      canSpend: (chain, n, discovery) => d.rpc.canSpend(chain, n, discovery),
    }
  }

  async function loop(run: AgentRun) {
    if (startDelayMs) await sleep(startDelayMs + runs.indexOf(run) * 750)
    while (!stopping) {
      const why = d.store.full()
      if (why) {
        setState(run, 'idle', null)
        await sleep(Math.max(idleMs, 60_000))
        continue
      }
      const blocked = blockedBudget(run)
      if (blocked) {
        setState(run, 'waiting-budget', null)
        const reset = d.rpc.msUntilReset?.() ?? budgetWaitMs
        await sleep(Math.min(budgetWaitMs, reset + 1000))
        continue
      }
      const down = blockedEndpoint(run)
      if (down) {
        setState(run, 'error', null)
        await sleep(Math.max(10, Math.min(budgetWaitMs, down.until - now())))
        continue
      }
      const c = d.discovery.next(run.info.chain)
      if (!c) {
        releaseProbe(run)
        setState(run, 'idle', null)
        await sleep(idleMs)
        continue
      }
      // kept code read within the week: nothing new to learn from reading it again
      const keptAt = d.store.keptAt?.(run.info.chain, c.address) ?? null
      if (keptAt !== null && now() - keptAt < KEPT_FRESH_MS) {
        d.discovery.markRead(run.info.chain, c.address, 'kept')
        releaseProbe(run)
        await yieldNow()
        continue
      }
      const key = `${run.info.chain}:${run.info.chain === 'solana' ? c.address : c.address.toLowerCase()}`
      if (inFlight.has(key)) {
        // the other agent of this chain is reading it right now
        releaseProbe(run)
        await yieldNow()
        continue
      }
      inFlight.add(key)
      const t0 = now()
      let out: 'ok' | 'budget' | 'closed'
      try {
        out = await readOne(run, c)
      } catch (e) {
        // a bug in a reader or the store must not kill the agent
        log('error', `${run.info.id}: ${redact((e as Error)?.stack ?? String(e))}`)
        setState(run, 'error', null)
        run.errorsInRow++
        out = 'ok'
      } finally {
        inFlight.delete(key)
        releaseProbe(run)
      }
      if (out === 'closed') break
      if (out === 'budget') {
        setState(run, 'waiting-budget', null)
        await sleep(budgetWaitMs)
        continue
      }
      if (run.errorsInRow >= 5) {
        setState(run, 'error', null)
        log('warn', `${run.info.id}: ${run.errorsInRow} errors in a row — pausing ${Math.round(errorPauseMs / 1000)} s`)
        run.errorsInRow = 0
        await sleep(errorPauseMs)
        continue
      }
      const gap = paceGap(run)
      const wait = (gap === Infinity ? minGapMs : gap) - (now() - t0)
      await sleep(Math.max(0, wait))
      await yieldNow()
    }
    setState(run, 'idle', null)
  }

  // ─── API ───────────────────────────────────────────────────────────────────

  function stats(): ChainStats {
    const s = d.store.summary()
    const byChain: Record<string, { reads: number; kept: number }> = {}
    for (const [k, v] of Object.entries(s.byChain)) byChain[k] = { reads: v.reads, kept: v.kept }
    let frontier: Record<string, number> = {}
    try {
      frontier = { ...d.discovery.stats() }
    } catch {
      frontier = {}
    }
    // pauses the client explains: storage cap reached, an endpoint unavailable (value: resume time, ms)
    if (d.store.full()) frontier.storeFull = 1
    const t = now()
    for (const [ep, b] of breakers) if (b.fails >= breakerFails && b.openUntil > t) frontier[`unavailable.${ep}`] = b.openUntil
    return {
      agents: runs.map((r) => ({ ...r.info })),
      reads: s.reads,
      kept: s.kept,
      rejected: s.rejected,
      programs: s.programs,
      contracts: s.contracts,
      idls: s.idls,
      verified: s.verified,
      sourceBytes: s.sourceBytes,
      byChain,
      frontier,
      budget: d.rpc.usage(),
      updatedAt: now(),
    }
  }

  return {
    start() {
      if (started) return
      started = true
      stopping = false
      for (const r of runs) loops.push(loop(r))
    },
    async stop() {
      stopping = true
      for (const w of [...wakers]) w()
      await Promise.allSettled(loops)
      loops.length = 0
      started = false
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      queue.length = 0
    },
    stats,
    feed(limit: number) {
      const n = Math.max(1, Math.min(200, Math.floor(limit) || 50))
      return feedRing.slice(-n).reverse()
    },
    items: (q) => d.store.items(q),
    item: (chain, address) => d.store.item(chain, address),
    record: (ev) => emit({ ...ev, reason: redact(ev.reason).slice(0, 200) }),
    restoreFeed(events: ChainEvent[]) {
      const ok = events.filter((e) => e && typeof e.id === 'string' && typeof e.ts === 'number')
      feedRing.unshift(...ok.slice(-FEED_MAX))
      if (feedRing.length > FEED_MAX) feedRing.splice(0, feedRing.length - FEED_MAX)
    },
  }
}
