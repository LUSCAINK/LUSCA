// UPGRADE RADAR: catches, live, the moment on-chain code changes, and reports what changed.
//
//   Solana   logsSubscribe(mentions: upgradeable loader, loader v4) over the Helius standard WebSocket
//            (wss derived from LUSCA_SOLANA_RPC; the public websocket locally) ─▶ loader log lines
//            ("Deployed / Upgraded program <id>", "New authority …", "Closed Program <id>") ─▶ wait a
//            few seconds (deploy scripts upgrade again and again: folded into one event) ─▶ read the
//            program with the chain agents' reader (code hash, authority, IDL, OtterSec, ELF syscalls)
//            ─▶ compare with what LUSCA had (the radar's last snapshot, else the chain agents' kept item)
//            Socket down ▶ budgeted polling of the loader's signatures (getSignaturesForAddress +
//            getTransaction for the transactions that land alone in their slot)
//   EVM      eth_getLogs over all addresses for Upgraded / AdminChanged / BeaconUpgraded, bounded block
//            windows (halved when the provider refuses, resumed from a persisted cursor) on the radar's
//            own endpoints ─▶ per (tx, proxy): did the address have code one block earlier (deploy vs
//            upgrade), previous implementation / beacon from storage one block earlier, the sender
//            ─▶ upgrades: both implementations read (getCode + Sourcify) and diffed (ABI functions,
//            admin-only functions with file:line, Lens's analyser under its work cap)
//            ─▶ deployments of one implementation within an hour fold into one event
//
// Budgets: its own slice of every shared budget (Helius 'solana', EVM reads, Sourcify, OtterSec),
// charged on top of the shared limit, never below a 10 % floor of it (the chain agents keep the rest),
// and a per-hour share; the log endpoints have their own daily budget. Backfill (first start only,
// never again): a separate hard-capped allowance. Everything persisted under <data>/radar (persist.ts).
//
// Env: LUSCA_RADAR=0 (off) · LUSCA_RADAR_BACKFILL=0 · LUSCA_RADAR_SOL_CALLS · LUSCA_RADAR_EVM_CALLS ·
//      LUSCA_RADAR_HTTP_CALLS · LUSCA_RADAR_LOG_CALLS · LUSCA_RADAR_ETH_LOGS / _BASE_LOGS / _ARB_LOGS
//      (comma lists of log endpoints) · LUSCA_RADAR_SOLANA_WS (explicit websocket URL)

import path from 'node:path'
import type { ChainId, ChainRead } from '../../shared/chain.ts'
import type { RadarEvent, RadarKind, RadarPage, RadarSide, RadarStatus } from '../../shared/radar.ts'
import { BudgetError, RpcError, providerOfUrl, redact, registerSecretUrl, type BudgetKey, type ChainRpc, type RpcCtx } from '../chain/rpc.ts'
import { OSEC_UNAVAILABLE, readSolana as defaultReadSolana } from '../chain/solana.ts'
import { readEvm as defaultReadEvm } from '../chain/evm.ts'
import { programAddresses } from '../chain/solana/layout.ts'
import { createTraceRecorder } from '../chain/trace.ts'
import { inCodeIndex, type ChainStore } from '../chain/store.ts'
import { safeName } from '../lens/index.ts'
import { AnalysisLimit, Work, findPrivileged } from '../lens/evm-analysis.ts'
import { scanElf, solanaPrimitives } from '../lens/elf-syscalls.ts'
import { createRadarBudget, type RadarBudget } from './budget.ts'
import { diffSnapshots, sideOf, snapshotOfRead, type Snapshot } from './diff.ts'
import { DEFAULT_LOG_ENDPOINTS, RangeLimitError, createEvmPool, wsUrlOf, type EvmChain, type EvmPool } from './net.ts'
import {
  LOADER_V4,
  RADAR_TOPICS,
  UPGRADEABLE_LOADER,
  classifyProxyGroup,
  groupFacts,
  groupProxyLogs,
  headlineOf,
  interestingActions,
  loaderCandidates,
  parseLoaderLogs,
  parseProxyLog,
  priorityOf,
  setAuthorityTargets,
  txSigners,
  wordAddress,
  type LoaderAction,
  type ProxyTxGroup,
  type SigInfo,
} from './parse.ts'
import { createEventLog, createSnapshotStore, loadState, saveState, type RadarState } from './persist.ts'
import { createLoaderSubscription, type LoaderSubscription, type LogsNotification } from './solana-ws.ts'

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

export const EVM_CHAINS: EvmChain[] = ['ethereum', 'base', 'arbitrum']
const DAY = 86_400_000
const EVENT_CAP = 5000
const SNAPSHOT_CAP = 4000
const WS_EVENT_MAX = 8 * 1024

/** Average block time (block-height time estimates) and the widest getLogs window tried. */
const BLOCK_MS: Record<EvmChain, number> = { ethereum: 12_000, base: 2_000, arbitrum: 250 }
const MAX_WINDOW: Record<EvmChain, number> = { ethereum: 1000, base: 500, arbitrum: 5000 }
/** Blocks kept behind the head (reorg margin). */
const CONFIRM: Record<EvmChain, number> = { ethereum: 2, base: 10, arbitrum: 40 }
const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const SLOT_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'

export interface RadarTiming {
  /** Wait after a Solana loader action before reading (more actions on the program reset it, up to the max). */
  solDelayMs: number
  solMaxDelayMs: number
  /** Another change of the same program / proxy within this window folds into the same event. */
  coalesceMs: number
  /** Deployments of one implementation within this window fold into one event. */
  deployAggMs: number
  evmPollMs: number
  /** Polling of loader signatures while the websocket is down. */
  solPollMs: number
  /** The websocket counts as down after this long without being open. */
  wsDownMs: number
  /** First backfill step after start. */
  backfillDelayMs: number
  /** Pause between backfill requests. */
  backfillGapMs: number
}

export const DEFAULT_TIMING: RadarTiming = {
  solDelayMs: 12_000,
  solMaxDelayMs: 60_000,
  coalesceMs: 15 * 60_000,
  deployAggMs: 60 * 60_000,
  evmPollMs: 45_000,
  solPollMs: 30_000,
  wsDownMs: 60_000,
  backfillDelayMs: 25_000,
  backfillGapMs: 1_500,
}

export interface RadarOptions {
  rpc: ChainRpc
  store: Pick<ChainStore, 'item' | 'keptAt'>
  dataDir: string
  log: Log
  broadcast: (msg: { t: 'radar'; event: RadarEvent }) => void
  /** LUSCA_SOLANA_RPC (Helius in production): its websocket is derived from it; '' / null → the public RPC. */
  solanaRpcUrl?: string | null
  solanaWsUrl?: string | null
  logEndpoints?: Partial<Record<EvmChain, string[]>>
  chains?: { solana?: boolean; evm?: EvmChain[] }
  limits?: Record<string, number>
  backfill?: boolean
  timing?: Partial<RadarTiming>
  fetch?: typeof fetch
  /** For tests: a ws-compatible WebSocket class. */
  WebSocketImpl?: unknown
  readSolana?: typeof defaultReadSolana
  readEvm?: typeof defaultReadEvm
  now?: () => number
}

export interface RadarListQuery {
  chain?: ChainId
  kind?: RadarKind
  known?: boolean
  /** 'priority': most significant first (known protocols, bigger diffs), then newest. Default: newest first. */
  sort?: 'new' | 'priority'
  limit?: number
  cursor?: string
}

export interface Radar {
  start(): void
  stop(): Promise<void>
  list(q: RadarListQuery): RadarPage
  get(id: string): RadarEvent | null
  status(): RadarStatus
  /** Feed one websocket notification (tests). */
  ingestSolanaLogs(n: LogsNotification, via?: string): void
  /** Feed raw eth_getLogs entries (tests). */
  ingestEvmLogs(chain: EvmChain, logs: unknown[], o?: { backfill?: boolean; head?: { n: number; ts: number } }): Promise<void>
  /** Resolves when no Solana / EVM work is queued or running (tests). */
  idle(): Promise<void>
}

const errMsg = (e: unknown) => redact(e instanceof Error ? e.message : String(e)).slice(0, 140)
const hex = (n: number) => `0x${Math.max(0, n).toString(16)}`
const SOL_LOADERS = [UPGRADEABLE_LOADER, LOADER_V4]

interface SolPending {
  program: string
  kind: RadarKind
  sigs: string[]
  slot: number | null
  firstAt: number
  timer: NodeJS.Timeout | null
  eventId: string
  newAuthority?: string | null
  signers?: string[]
  blockTime: number | null
  via: string
  backfill: boolean
}

interface EvmTask {
  eventId: string
  chain: EvmChain
  /** 'upgrade': read both implementations and diff · 'name': read the implementation for its name and surface. */
  type: 'upgrade' | 'name'
  newImpl: string
  prevImpl: string | null
  prio: number
  backfill: boolean
}

export function createRadar(o: RadarOptions): Radar {
  const now = o.now ?? Date.now
  const T: RadarTiming = { ...DEFAULT_TIMING, ...o.timing }
  const log: Log = (l, m) => o.log(l, redact(m))
  const readSolana = o.readSolana ?? defaultReadSolana
  const readEvm = o.readEvm ?? defaultReadEvm
  const dir = path.join(o.dataDir, 'radar')
  const solOn = o.chains?.solana !== false
  const evmOn: EvmChain[] = o.chains?.evm ?? EVM_CHAINS
  const backfillOn = o.backfill !== false

  // ── budgets ──
  const shared = o.rpc.usage()
  const pct = (k: string, p: number, min: number) => Math.max(min, Math.floor((shared[k]?.limit ?? 0) * p))
  const limits: Record<string, number> = {
    solana: pct('solana', 0.15, 100),
    ethereum: pct('ethereum', 0.1, 100),
    base: pct('base', 0.1, 100),
    arbitrum: pct('arbitrum', 0.1, 100),
    sourcify: pct('sourcify', 0.15, 50),
    osec: pct('osec', 0.15, 50),
    'logs-ethereum': 20_000,
    'logs-base': 20_000,
    'logs-arbitrum': 20_000,
    ...o.limits,
  }
  const budget: RadarBudget = createRadarBudget(limits, path.join(dir, 'budget.json'), now, 0.15)
  // the first-start backfill: a one-time hard-capped allowance (no hourly share)
  const bfBudget: RadarBudget = createRadarBudget(
    {
      solana: 700,
      osec: 200,
      ethereum: 300,
      base: 300,
      arbitrum: 300,
      sourcify: 300,
      'logs-ethereum': 60,
      'logs-base': 240,
      'logs-arbitrum': 400,
      'checks-ethereum': 1500,
      'checks-base': 1500,
      'checks-arbitrum': 1500,
    },
    path.join(dir, 'backfill-budget.json'),
    now,
    1,
  )
  const budgetOf = (bf: boolean) => (bf ? bfBudget : budget)

  /** Room left in the shared budget above the floor kept for the chain agents. */
  function sharedRoom(key: BudgetKey, n = 1): boolean {
    const u = o.rpc.usage()[key]
    if (!u) return true
    return u.limit - u.used - n >= Math.ceil(u.limit * 0.1)
  }

  /** The chain agents' network layer, charged to the radar's slice first. */
  function sharedCtx(bf: boolean): RpcCtx {
    const b = budgetOf(bf)
    const keyOf = (chain: ChainId): BudgetKey => (chain === 'solana' ? 'solana' : chain)
    return {
      call(chain, method, params, opts) {
        const k = keyOf(chain)
        if (!sharedRoom(k)) return Promise.reject(new BudgetError(k))
        try {
          b.charge(k)
        } catch (e) {
          return Promise.reject(e)
        }
        return o.rpc.call(chain, method, params, { ...opts, discovery: false })
      },
      async fetchJson(url, opts) {
        const host = opts?.host ?? (/^https?:\/\/([^/]+\.)?sourcify\.dev\b/i.test(url) ? 'sourcify' : /^https?:\/\/([^/]+\.)?osec\.io\b/i.test(url) ? 'osec' : null)
        if (host) {
          if (!sharedRoom(host)) throw new BudgetError(host)
          b.charge(host)
        }
        return o.rpc.fetchJson(url, opts)
      },
      usage: () => o.rpc.usage(),
      canSpend: (chain, n = 1, discovery = false) => b.can(keyOf(chain), n) && o.rpc.canSpend(chain, n, discovery),
    }
  }
  const canSol = (bf: boolean, n = 1) => budgetOf(bf).can('solana', n) && sharedRoom('solana', n)

  // ── storage ──
  const evlog = createEventLog(path.join(dir, 'events.jsonl'), EVENT_CAP, log)
  const snapshots = createSnapshotStore(path.join(dir, 'snapshots.json'), SNAPSHOT_CAP, log, now)
  const state: RadarState = loadState(path.join(dir, 'state.json'))
  const stateFile = path.join(dir, 'state.json')
  let stateDirty = false
  let stateUrgent = false
  let stateSavedAt = 0
  /** urgent: an EVM cursor moved (saved at the next flush); otherwise at most every 10 s. */
  const markState = (urgent = false) => {
    stateDirty = true
    if (urgent) stateUrgent = true
  }

  const events = new Map<string, RadarEvent>()
  let sorted: RadarEvent[] | null = null
  const latestByKey = new Map<string, string>()
  /** The full before-snapshot of recent events (to diff again when a change folds into them). */
  const beforeSnaps = new Map<string, Snapshot | null>()
  let seq = 0

  for (const e of evlog.load()) {
    // a read cut short by a restart says so instead of staying "reading…" forever
    if (e.state === 'pending') {
      e.state = 'partial'
      if (!e.notes.includes('not read: the server restarted before the read')) e.notes = [...e.notes, 'not read: the server restarted before the read']
      e.headline = headlineOf(e)
    }
    events.set(e.id, e)
  }
  for (const e of [...events.values()].sort((a, b) => a.seenAt - b.seenAt)) latestByKey.set(keyOfEvent(e), e.id)

  function keyOfEvent(e: RadarEvent): string {
    if (e.proxies) return `${e.chain}:agg:${e.kind}:${e.after?.implementation ?? e.after?.beacon ?? e.address}`
    const g = e.kind === 'admin_change' ? 'admin' : e.kind === 'beacon_upgrade' ? 'beacon' : e.kind === 'authority_change' ? 'auth' : 'code'
    return `${e.chain}:${e.address}:${g}`
  }

  function list(): RadarEvent[] {
    if (!sorted) sorted = [...events.values()].sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1))
    return sorted
  }

  function newId(chain: ChainId): string {
    seq = (seq + 1) % 1296
    return `${chain.slice(0, 3)}-${now().toString(36)}${seq.toString(36).padStart(2, '0')}`
  }

  function trim() {
    // the coalescing index follows the stored events (bounded with them)
    if (latestByKey.size > EVENT_CAP * 3) {
      latestByKey.clear()
      for (const e of [...events.values()].sort((x, y) => x.seenAt - y.seenAt)) latestByKey.set(keyOfEvent(e), e.id)
    }
    if (events.size <= EVENT_CAP + 100) return
    const all = list()
    for (const e of all.slice(EVENT_CAP)) {
      events.delete(e.id)
      beforeSnaps.delete(e.id)
    }
    sorted = null
  }

  /** Store a new version of an event, persist it, broadcast it. */
  function put(ev: RadarEvent, broadcast = true) {
    ev.updatedAt = now()
    ev.headline = headlineOf(ev)
    ev.priority = priorityOf(ev)
    ev.notes = [...new Set(ev.notes)].slice(0, 12)
    events.set(ev.id, ev)
    latestByKey.set(keyOfEvent(ev), ev.id)
    sorted = null
    evlog.append(ev)
    trim()
    while (beforeSnaps.size > 600) beforeSnaps.delete(beforeSnaps.keys().next().value!)
    if (broadcast) {
      try {
        o.broadcast({ t: 'radar', event: compact(ev, true) })
      } catch (e) {
        log('warn', `radar broadcast: ${errMsg(e)}`)
      }
    }
  }

  function blankEvent(chain: ChainId, kind: RadarKind, address: string, x: Partial<RadarEvent>): RadarEvent {
    const t = now()
    return {
      id: newId(chain),
      chain,
      kind,
      address,
      name: null,
      known: false,
      knownWhy: null,
      ts: t,
      seenAt: t,
      slot: null,
      block: null,
      tx: null,
      count: 1,
      actor: null,
      actorRole: null,
      before: null,
      after: null,
      diff: null,
      headline: '',
      priority: 0,
      via: '',
      state: 'pending',
      notes: [],
      updatedAt: t,
      ...x,
    }
  }

  function knownWhy(chain: ChainId, addrs: (string | null | undefined)[]): string | null {
    for (const a of addrs) {
      if (!a) continue
      try {
        if (o.store.keptAt(chain, a) !== null) return 'kept in the chain index'
      } catch {
        /* the index is not readable now: not known */
      }
    }
    return null
  }

  // ════════════════════════════════════════════════════════════════════════
  // Solana
  // ════════════════════════════════════════════════════════════════════════

  const solPending = new Map<string, SolPending>()
  const solQueue: (SolPending | { auth: true; sig: string; slot: number | null; newAuthority: string | null; via: string; backfill: boolean; blockTime: number | null })[] = []
  const seenSigs = new Set<string>()
  let solBusy = false
  let notAttributed = 0
  const solVia = { ws: '', poll: '' }

  function seenSig(sig: string): boolean {
    if (seenSigs.has(sig)) return true
    seenSigs.add(sig)
    if (seenSigs.size > 6000) for (const s of [...seenSigs].slice(0, 1000)) seenSigs.delete(s)
    return false
  }

  /** One loader transaction (from the websocket, the polling fallback or the backfill). */
  function onSolanaTx(sig: string, slot: number | null, err: unknown, logs: string[], via: string, backfill: boolean, blockTime: number | null, signers?: string[]) {
    if (err) return
    const acts = interestingActions(parseLoaderLogs(logs))
    if (!acts.length) return
    if (seenSig(sig)) return
    const auths = acts.filter((a) => a.type === 'authority')
    const progs = acts.filter((a): a is LoaderAction & { program: string } => !!a.program)
    if (!progs.length) {
      const a = auths[auths.length - 1]
      if (a && solQueue.length < 400) {
        solQueue.push({ auth: true, sig, slot, newAuthority: a.newAuthority ?? null, via, backfill, blockTime })
        pumpSol()
      }
      return
    }
    const newAuthority = auths.length ? (auths[auths.length - 1].newAuthority ?? null) : undefined
    for (const program of [...new Set(progs.map((p) => p.program))]) {
      const types = progs.filter((p) => p.program === program).map((p) => p.type)
      const kind: RadarKind = types.includes('closed') ? 'close' : types.includes('deployed') ? 'deploy' : 'upgrade'
      notePending(program, kind, sig, slot, via, backfill, blockTime, newAuthority, signers?.length ? signers : undefined)
    }
  }

  function notePending(program: string, kind: RadarKind, sig: string, slot: number | null, via: string, backfill: boolean, blockTime: number | null, newAuthority?: string | null, signers?: string[]) {
    const key = `solana:${program}`
    const p = solPending.get(key)
    if (p) {
      const fresh = !p.sigs.includes(sig)
      if (fresh) p.sigs.push(sig)
      if (p.sigs.length > 50) p.sigs.shift()
      p.slot = Math.max(p.slot ?? 0, slot ?? 0) || p.slot
      // deploy then upgrade in one burst is still the deployment; a close wins; an upgrade beats an authority change
      if (kind === 'close' || (kind === 'deploy' && p.kind !== 'close') || (kind === 'upgrade' && p.kind === 'authority_change')) p.kind = kind
      if (newAuthority !== undefined) p.newAuthority = newAuthority
      if (signers) p.signers = signers
      if (blockTime) p.blockTime = Math.max(p.blockTime ?? 0, blockTime)
      const ev = events.get(p.eventId)
      if (ev) {
        if (fresh) ev.count += 1
        ev.tx = sig
        ev.kind = p.kind
        put(ev)
      }
      if (p.timer && !backfill) {
        clearTimeout(p.timer)
        const wait = Math.max(0, Math.min(T.solDelayMs, p.firstAt + T.solMaxDelayMs - now()))
        p.timer = setTimeout(() => enqueueSol(key), wait)
        p.timer.unref?.()
      }
      return
    }
    if (solPending.size >= 500) return
    // a change of a program changed moments ago folds into that event (deploy scripts upgrade repeatedly)
    const recentId = latestByKey.get(`solana:${program}:${kind === 'authority_change' ? 'auth' : 'code'}`)
    const recent = recentId ? events.get(recentId) : undefined
    const ts = blockTime ?? now()
    let ev: RadarEvent
    if (recent && recent.kind !== 'close' && kind !== 'close' && Math.abs(ts - recent.ts) < T.coalesceMs && beforeSnaps.has(recent.id) && !!recent.backfill === backfill) {
      ev = recent
      ev.count += 1
      ev.tx = sig
      ev.slot = slot ?? ev.slot
      ev.ts = Math.max(ev.ts, ts)
      ev.state = 'pending'
      if (kind === 'deploy') ev.kind = 'deploy'
    } else {
      ev = blankEvent('solana', kind, program, { tx: sig, slot, ts, via, backfill: backfill || undefined })
    }
    put(ev)
    const np: SolPending = { program, kind: ev.kind, sigs: [sig], slot, firstAt: now(), timer: null, eventId: ev.id, newAuthority, signers, blockTime, via, backfill }
    solPending.set(key, np)
    if (backfill) enqueueSol(key)
    else {
      np.timer = setTimeout(() => enqueueSol(key), T.solDelayMs)
      np.timer.unref?.()
    }
  }

  function enqueueSol(key: string) {
    const p = solPending.get(key)
    if (!p) return
    solPending.delete(key)
    if (p.timer) clearTimeout(p.timer)
    p.timer = null
    solQueue.push(p)
    pumpSol()
  }

  function pumpSol() {
    if (solBusy || stopped) return
    const next = solQueue.shift()
    if (!next) {
      wake()
      return
    }
    solBusy = true
    const run = 'auth' in next ? resolveAuthority(next) : readProgramEvent(next)
    run
      .catch((e) => log('warn', `radar solana: ${errMsg(e)}`))
      .finally(() => {
        solBusy = false
        pumpSol()
      })
  }

  /** What LUSCA knew of a program before this change: the radar's snapshot, else the chain agents' kept item. */
  function priorSolana(program: string): { snap: Snapshot; from: RadarSide['from'] } | null {
    const s = snapshots.get(`solana:${program}`)
    if (s) return { snap: s, from: 'radar' }
    try {
      const it = o.store.item('solana', program)
      if (it) {
        const snap = snapshotOfRead(it.read, { registryAsked: !!it.read.codeHash && !it.read.notes.some((n) => n.startsWith(OSEC_UNAVAILABLE)), at: it.item.readAt })
        return { snap, from: 'chain-index' }
      }
    } catch {
      /* not readable now */
    }
    return null
  }

  async function readProgramEvent(p: SolPending) {
    const ev = events.get(p.eventId)
    if (!ev) return
    const ctx = sharedCtx(p.backfill)
    const tracer = createTraceRecorder(ctx, { provider: (k) => o.rpc.provider(k), address: p.program })
    const notes: string[] = []
    let prior: { snap: Snapshot | null; from: RadarSide['from'] }
    if (beforeSnaps.has(ev.id)) {
      const s = beforeSnaps.get(ev.id) ?? null
      prior = { snap: s, from: ev.before?.from ?? 'radar' }
    } else {
      // a deployment has no before (a closed program id cannot be deployed again)
      const pr = p.kind === 'deploy' ? null : priorSolana(p.program)
      prior = pr ?? { snap: null, from: 'radar' }
      beforeSnaps.set(ev.id, prior.snap)
    }
    let after: Snapshot | null = null
    let read: ChainRead | null = null
    if (canSol(p.backfill)) {
      try {
        let prims: string[] | null = null
        const res = await readSolana(p.program, tracer.ctx, {
          onElf: (elf) => {
            try {
              prims = solanaPrimitives(scanElf(elf)).map((x) => x.name)
            } catch {
              prims = null
            }
          },
        })
        read = res.read
        const asked = !!read.codeHash && !read.notes.some((n) => n.startsWith(OSEC_UNAVAILABLE))
        after = snapshotOfRead(read, { primitives: read.codeHash ? (prims ?? []) : null, registryAsked: asked, at: now() })
        if (read.kind !== 'program') notes.push(read.kind === 'empty' ? 'no account at this address now' : `not a program now (${read.kind})`)
        if (read.notes.some((n) => /program closed/i.test(n))) notes.push('program closed: its program data account is gone')
      } catch (e) {
        notes.push(`program not read: ${e instanceof BudgetError ? 'radar budget used up for now' : errMsg(e)}`)
      }
    } else notes.push('program not read: radar budget used up for now')

    // who signed: the transaction, when the budget allows; else the authority
    let actor: string | null = null
    let role: RadarEvent['actorRole'] = null
    let blockTime = p.blockTime
    if (p.signers?.length) {
      actor = p.signers[0]
      role = 'signer'
    } else if (canSol(p.backfill) && p.sigs.length) {
      try {
        const tx = await tracer.ctx.call('solana', 'getTransaction', [p.sigs[p.sigs.length - 1], { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], { timeoutMs: 8000, maxBytes: 1048576 })
        const signers = txSigners(tx)
        if (signers.length) {
          actor = signers[0]
          role = 'signer'
          if (signers.length > 1) notes.push(`${signers.length} signers: ${signers.slice(0, 3).join(', ')}${signers.length > 3 ? ' …' : ''}`)
        }
        const bt = Number((tx as { blockTime?: unknown } | null)?.blockTime)
        if (Number.isFinite(bt) && bt > 0) blockTime = bt * 1000
      } catch (e) {
        if (!(e instanceof BudgetError)) notes.push(`transaction not read: ${errMsg(e)}`)
      }
    }
    if (!actor && after?.authority) {
      actor = after.authority
      role = 'authority'
    }

    const why = knownWhy('solana', [p.program]) ?? (read?.verified?.repo && inCodeIndex(read.verified.repo) ? 'OtterSec build repository is in the code index' : null) ?? prior.snap?.known ?? null
    if (after) {
      after.known = why
      snapshots.put(`solana:${p.program}`, after)
      try {
        if (read?.loader === 'bpf-upgradeable' || read?.lastDeploySlot !== null) snapshots.setProgramData(programAddresses(p.program).programData, p.program)
      } catch {
        /* not a valid key: nothing to map */
      }
    }
    const cur = events.get(p.eventId)
    if (!cur) return
    cur.kind = p.kind
    cur.known = !!why
    cur.knownWhy = why
    const verified = read?.verified ?? null
    cur.name = why || verified || read?.idl ? safeName(read?.name ?? prior.snap?.name ?? null) : null
    cur.before = prior.snap ? sideOf(prior.snap, prior.from) : null
    cur.after = after ? sideOf(after, 'read') : cur.after
    cur.diff = after ? diffSnapshots(prior.snap, after) : cur.diff
    cur.actor = actor
    cur.actorRole = role
    if (blockTime) cur.ts = blockTime
    cur.state = after ? 'read' : 'partial'
    if (p.kind === 'authority_change' && p.newAuthority !== undefined && after && (after.authority ?? null) !== (p.newAuthority ?? null)) {
      notes.push(`the transaction set ${p.newAuthority ?? 'no authority'}; the program now reads ${after.authority ?? 'no authority'} (changed again since)`)
    }
    if (p.backfill) notes.push('found by the first-start backfill: the state shown after is the state read now')
    if (prior.from === 'chain-index' && prior.snap) notes.push(`before: as the chain agents read it on ${new Date(prior.snap.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`)
    if (!prior.snap && p.kind === 'upgrade') notes.push('first time LUSCA sees this program: no earlier state to compare')
    cur.notes = [...cur.notes.filter((n) => !/^(program not read|transaction not read|not read: the server)/.test(n)), ...notes]
    const calls = tracer.calls()
    if (calls.length) cur.trace = calls.slice(0, 12)
    put(cur)
  }

  /** "New authority …" without a program in the same transaction: find which program it was for. */
  async function resolveAuthority(t: { sig: string; slot: number | null; newAuthority: string | null; via: string; backfill: boolean; blockTime: number | null }) {
    if (!canSol(t.backfill, 2)) return
    const ctx = sharedCtx(t.backfill)
    let tx: unknown
    try {
      tx = await ctx.call('solana', 'getTransaction', [t.sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], { timeoutMs: 8000, maxBytes: 1048576 })
    } catch {
      return
    }
    const targets = setAuthorityTargets(tx)
    const signers = txSigners(tx)
    const bt = Number((tx as { blockTime?: unknown } | null)?.blockTime)
    const blockTime = Number.isFinite(bt) && bt > 0 ? bt * 1000 : t.blockTime
    for (const target of targets.slice(0, 2)) {
      let program = snapshots.programOfData(target)
      if (!program && canSol(t.backfill)) {
        // the program account holds its programdata address at byte 4: one indexed lookup on the loader
        try {
          const res = await ctx.call(
            'solana',
            'getProgramAccounts',
            [UPGRADEABLE_LOADER, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: 36 }, { memcmp: { offset: 4, bytes: target } }] }],
            { timeoutMs: 10_000, maxBytes: 65_536 },
          )
          const first = Array.isArray(res) ? (res[0] as { pubkey?: unknown } | undefined) : undefined
          if (first && typeof first.pubkey === 'string') {
            program = first.pubkey
            snapshots.setProgramData(target, program)
          }
        } catch {
          /* not answerable here (public RPC): not attributed */
        }
      }
      if (!program) {
        notAttributed++
        continue
      }
      notePending(program, 'authority_change', t.sig, t.slot, t.via, t.backfill, blockTime, t.newAuthority, signers)
    }
  }

  // ── websocket + polling fallback ──
  const solanaHttp = o.solanaRpcUrl?.trim() || 'https://api.mainnet-beta.solana.com'
  const wsUrl = o.solanaWsUrl?.trim() || wsUrlOf(solanaHttp)
  if (wsUrl) registerSecretUrl(wsUrl)
  const wsProvider = providerOfUrl(solanaHttp, 'Solana RPC')
  solVia.ws = `${wsProvider === 'Solana public RPC' ? 'Solana public' : wsProvider} websocket`
  solVia.poll = `${o.rpc.provider('solana')} · loader signatures`
  let sub: LoaderSubscription | null = null
  let lastSolPoll = 0
  let polling = false

  function ingestNotification(n: LogsNotification, via = solVia.ws) {
    if (n.signature && /^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(n.signature)) {
      if (state.solanaSig !== n.signature) {
        state.solanaSig = n.signature
        markState()
      }
    }
    onSolanaTx(n.signature, n.slot, n.err, n.logs, via, false, null)
  }

  /** Loader signatures newer than the last seen one, then the transactions that land alone in their slot. */
  async function pollSolana() {
    if (polling || stopped) return
    polling = true
    lastSolPoll = now()
    try {
      if (!canSol(false, 2)) return
      const ctx = sharedCtx(false)
      const until = state.solanaSig ?? undefined
      const page = (await ctx.call('solana', 'getSignaturesForAddress', [UPGRADEABLE_LOADER, { limit: until ? 1000 : 300, ...(until ? { until } : {}), commitment: 'confirmed' }], { timeoutMs: 10_000, maxBytes: 2 * 1048576 })) as SigInfo[] | null
      if (!Array.isArray(page) || !page.length) return
      state.solanaSig = page[0].signature
      markState()
      for (const c of loaderCandidates(page).slice(0, 15)) {
        if (stopped || !canSol(false)) break
        if (seenSigs.has(c.signature)) continue
        try {
          const tx = (await ctx.call('solana', 'getTransaction', [c.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], { timeoutMs: 8000, maxBytes: 1048576 })) as { meta?: { err?: unknown; logMessages?: unknown } } | null
          const logs = Array.isArray(tx?.meta?.logMessages) ? (tx!.meta!.logMessages as string[]) : []
          onSolanaTx(c.signature, c.slot, tx?.meta?.err ?? null, logs, solVia.poll, false, c.blockTime ? c.blockTime * 1000 : null, txSigners(tx))
        } catch (e) {
          if (e instanceof BudgetError) break
        }
      }
    } catch (e) {
      if (!(e instanceof BudgetError)) log('warn', `radar solana polling: ${errMsg(e)}`)
    } finally {
      polling = false
    }
  }

  /** Events the first-start backfill found on a chain. */
  const backfilled = (c: ChainId) => {
    let n = 0
    for (const e of events.values()) if (e.chain === c && e.backfill) n++
    return n
  }

  // ── Solana backfill (first start only) ──
  async function backfillSolana() {
    if (state.backfill.solana) return
    state.backfill.solana = { started: now(), done: false, fromTs: null, events: 0, note: null }
    saveState(stateFile, state, log)
    const ctx = sharedCtx(true)
    const target = now() - DAY
    let before: string | undefined
    let pages = 0
    let txs = 0
    let oldest: number | null = null
    let note: string | null = null
    try {
      while (!stopped && pages < 40) {
        if (!bfBudget.can('solana', 2) || !sharedRoom('solana', 2)) {
          note = 'stopped at the backfill budget'
          break
        }
        let page: SigInfo[] | null = null
        for (let attempt = 1; ; attempt++) {
          try {
            page = (await ctx.call('solana', 'getSignaturesForAddress', [UPGRADEABLE_LOADER, { limit: 1000, ...(before ? { before } : {}), commitment: 'confirmed' }], { timeoutMs: 15_000, maxBytes: 2 * 1048576 })) as SigInfo[] | null
            break
          } catch (e) {
            if (!(e instanceof RpcError && e.transient) || attempt >= 4) throw e
            await sleep(5_000 * attempt)
          }
        }
        if (!Array.isArray(page) || !page.length) break
        pages++
        before = page[page.length - 1].signature
        const bt = page[page.length - 1].blockTime
        if (pages === 1 && !state.solanaSig) state.solanaSig = page[0].signature
        // coverage: up to the oldest transaction actually inspected (the whole page when all its candidates were)
        let whole = true
        for (const c of loaderCandidates(page)) {
          if (stopped || txs >= 260 || !bfBudget.can('solana', 1)) {
            whole = false
            break
          }
          if (seenSigs.has(c.signature)) continue
          txs++
          try {
            const tx = (await ctx.call('solana', 'getTransaction', [c.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], { timeoutMs: 8000, maxBytes: 1048576 })) as { meta?: { err?: unknown; logMessages?: unknown } } | null
            const logs = Array.isArray(tx?.meta?.logMessages) ? (tx!.meta!.logMessages as string[]) : []
            onSolanaTx(c.signature, c.slot, tx?.meta?.err ?? null, logs, `${o.rpc.provider('solana')} · loader signatures (backfill)`, true, c.blockTime ? c.blockTime * 1000 : null, txSigners(tx))
            if (c.blockTime) oldest = c.blockTime * 1000
          } catch (e) {
            if (e instanceof BudgetError) break
            if (e instanceof RpcError && e.transient) await sleep(2_000) // rate limited: slow down
          }
          await sleep(250)
        }
        if (whole && bt) oldest = bt * 1000
        if (txs >= 260) {
          note = 'stopped at the backfill cap (260 transactions inspected)'
          break
        }
        if (oldest !== null && oldest <= target) break
        await sleep(T.backfillGapMs)
      }
      if (!note && oldest !== null && oldest > target) note = `stopped at the backfill cap (${pages} pages of loader signatures)`
    } catch (e) {
      note = `stopped: ${errMsg(e)}`
    }
    state.backfill.solana = { started: state.backfill.solana.started, done: true, fromTs: oldest, events: backfilled('solana'), note }
    saveState(stateFile, state, log)
    log('info', `radar: Solana backfill done (${pages} signature pages, ${txs} transactions inspected${note ? `; ${note}` : ''})`)
  }

  // ════════════════════════════════════════════════════════════════════════
  // EVM
  // ════════════════════════════════════════════════════════════════════════

  const pools = new Map<EvmChain, EvmPool>()
  for (const c of evmOn) {
    pools.set(
      c,
      createEvmPool({
        chain: c,
        urls: o.logEndpoints?.[c]?.length ? o.logEndpoints[c]! : DEFAULT_LOG_ENDPOINTS[c],
        charge: (n) => budget.charge(`logs-${c}`, n),
        fetch: o.fetch,
        now,
      }),
    )
  }
  const evmState = new Map<EvmChain, { window: number; head: { n: number; ts: number } | null; timer: NodeJS.Timeout | null; busy: boolean; lastOk: number | null }>()
  for (const c of evmOn) evmState.set(c, { window: Math.max(20, Math.floor(MAX_WINDOW[c] / 4)), head: null, timer: null, busy: false, lastOk: null })
  const evmQueue: EvmTask[] = []
  /** Calls per JSON-RPC batch, per chain (Base's public endpoint takes 10 at most; learned from its refusal). */
  const batchSize = new Map<EvmChain, number>()
  let evmBusy = false

  async function headOf(chain: EvmChain, charge?: (n: number) => void): Promise<{ n: number; ts: number }> {
    const b = (await pools.get(chain)!.call('eth_getBlockByNumber', ['latest', false], { maxBytes: 4 * 1048576, charge })) as { number?: unknown; timestamp?: unknown } | null
    const n = typeof b?.number === 'string' ? parseInt(b.number, 16) : NaN
    const ts = typeof b?.timestamp === 'string' ? parseInt(b.timestamp, 16) * 1000 : NaN
    if (!Number.isFinite(n) || !Number.isFinite(ts)) throw new RpcError('bad-json', `${chain} radar: malformed block`)
    return { n, ts }
  }

  function scheduleEvm(chain: EvmChain, ms: number) {
    const st = evmState.get(chain)!
    if (stopped) return
    if (st.timer) clearTimeout(st.timer)
    st.timer = setTimeout(() => void tickEvm(chain), ms)
    st.timer.unref?.()
  }

  async function tickEvm(chain: EvmChain) {
    const st = evmState.get(chain)!
    if (st.busy || stopped) return
    st.busy = true
    let next = T.evmPollMs
    try {
      const head = await headOf(chain)
      st.head = head
      const safe = head.n - CONFIRM[chain]
      let cursor = state.cursors[chain]
      if (!Number.isFinite(cursor) || cursor <= 0) {
        cursor = safe - 1
        state.cursors[chain] = cursor
        markState()
      }
      // after a long stop, catch up at most 6 h of blocks (the gap is noted in the log, not filled)
      const maxGap = Math.ceil((6 * 3_600_000) / BLOCK_MS[chain])
      if (safe - cursor > maxGap) {
        log('warn', `radar ${chain}: ${safe - cursor} blocks behind; skipping to the last 6 h`)
        cursor = safe - maxGap
      }
      const from = cursor + 1
      if (from > safe) return
      const to = Math.min(safe, from + st.window - 1)
      let logs: unknown
      try {
        logs = await pools.get(chain)!.call('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), topics: [RADAR_TOPICS] }], { timeoutMs: 20_000, maxBytes: 16 * 1048576 })
      } catch (e) {
        if (e instanceof RangeLimitError) {
          st.window = Math.max(1, Math.floor(st.window / 2))
          next = 2_000
          return
        }
        throw e
      }
      if (!Array.isArray(logs)) throw new RpcError('bad-json', `${chain} radar: eth_getLogs answer is not a list`)
      await ingestEvm(chain, logs, { backfill: false, head })
      state.cursors[chain] = to
      markState(true)
      st.lastOk = now()
      st.window = Math.min(MAX_WINDOW[chain], Math.ceil(st.window * 1.25) + 1)
      if (to < safe) next = 1_500 // catching up
    } catch (e) {
      if (!(e instanceof BudgetError)) log('warn', `radar ${chain}: ${errMsg(e)}`)
      next = e instanceof BudgetError ? 5 * 60_000 : T.evmPollMs
    } finally {
      st.busy = false
      scheduleEvm(chain, next)
    }
  }

  const tsOf = (chain: EvmChain, block: number, raw: unknown, head: { n: number; ts: number } | null): { ts: number; estimated: boolean } => {
    const t = typeof raw === 'string' && /^0x[0-9a-f]+$/i.test(raw) ? parseInt(raw, 16) * 1000 : 0
    if (t > 0) return { ts: t, estimated: false }
    if (head) return { ts: head.ts - (head.n - block) * BLOCK_MS[chain], estimated: true }
    return { ts: now(), estimated: true }
  }

  /** eth_getLogs entries → events: classification calls (budgeted, batched), aggregation, enrichment tasks. */
  async function ingestEvm(chain: EvmChain, rawLogs: unknown[], x: { backfill: boolean; head: { n: number; ts: number } | null }) {
    const tsRaw = new Map<string, unknown>()
    const parsed = []
    for (const r of rawLogs) {
      const l = parseProxyLog(r)
      if (!l) continue
      parsed.push(l)
      tsRaw.set(l.tx, (r as { blockTimestamp?: unknown }).blockTimestamp)
    }
    if (!parsed.length) return
    const groups = groupProxyLogs(parsed)
    const pool = pools.get(chain)
    const b = budgetOf(x.backfill)
    // the backfill keeps its window calls apart from its classification calls: coverage first
    const ck = x.backfill ? `checks-${chain}` : `logs-${chain}`

    /** Calls in batches (the size adapts to the provider's batch limit); a failed or unaffordable call answers null. */
    async function batched(calls: { method: string; params: unknown[] }[], what: string): Promise<({ result: unknown } | { error: string } | null)[]> {
      const out: ({ result: unknown } | { error: string } | null)[] = calls.map(() => null)
      if (!pool) return out
      let i = 0
      while (i < calls.length) {
        const size = batchSize.get(chain) ?? 10
        const chunk = calls.slice(i, i + size)
        if (!b.can(ck, chunk.length)) break
        try {
          const res = await pool.batch(chunk, { charge: (n) => b.charge(ck, n), maxBytes: 4 * 1048576 })
          res.forEach((r, k) => (out[i + k] = r))
          i += chunk.length
          // a backfill spreads its batches out (public endpoints rate-limit bursts)
          if (x.backfill && i < calls.length) await sleep(400)
        } catch (e) {
          if (e instanceof BudgetError) break
          const m = /(?:maximum|max|limit(?:ed)? (?:to|of)?)\D{0,20}(\d{1,3})\D{0,12}(?:calls|requests|items)?[^.]*batch|batch[^.]*?(\d{1,3})/i.exec((e as Error).message ?? '')
          if (/batch/i.test((e as Error).message ?? '') && size > 1) {
            const n = Number(m?.[1] ?? m?.[2])
            batchSize.set(chain, Number.isFinite(n) && n >= 1 && n < size ? n : Math.max(1, Math.floor(size / 2)))
            continue
          }
          log('warn', `radar ${chain} ${what}: ${errMsg(e)}`)
          break
        }
      }
      return out
    }

    // 1. did the address have code one block earlier? (not needed when the admin was set from none in the same tx)
    const existed = new Map<string, boolean | null>()
    const delegated = new Set<string>()
    const toCheck = groups.filter((g) => {
      const f = groupFacts(g)
      return (f.implementation || f.beacon) && !f.adminFromNone
    })
    if (toCheck.length) {
      const res = await batched(
        toCheck.map((g) => ({ method: 'eth_getCode', params: [g.address, hex(g.block - 1)] })),
        'code check',
      )
      res.forEach((r, k) => {
        if (r && 'result' in r && typeof r.result === 'string') {
          existed.set(toCheck[k].key, r.result.length > 2 && r.result !== '0x0')
          // EIP-7702: an account delegating to code (0xef0100 ‖ address) is an EOA, not a deployed proxy
          if (/^0xef0100[0-9a-fA-F]{40}$/.test(r.result)) delegated.add(toCheck[k].key)
        }
      })
    }

    // 2. for proxies that existed: previous implementation / beacon one block earlier, and the sender
    const prev = new Map<string, { impl?: string | null; beacon?: string | null; sender?: string | null }>()
    const existing = groups.filter((g) => existed.get(g.key) === true || (!groupFacts(g).implementation && !groupFacts(g).beacon))
    if (existing.length) {
      const calls: { method: string; params: unknown[]; key: string; what: 'impl' | 'beacon' | 'sender' }[] = []
      for (const g of existing.slice(0, 60)) {
        const f = groupFacts(g)
        if (f.implementation) calls.push({ method: 'eth_getStorageAt', params: [g.address, SLOT_IMPL, hex(g.block - 1)], key: g.key, what: 'impl' })
        if (f.beacon) calls.push({ method: 'eth_getStorageAt', params: [g.address, SLOT_BEACON, hex(g.block - 1)], key: g.key, what: 'beacon' })
        calls.push({ method: 'eth_getTransactionByHash', params: [g.tx], key: g.key, what: 'sender' })
      }
      const res = await batched(calls.map(({ method, params }) => ({ method, params })), 'previous state')
      res.forEach((r, k) => {
        const c = calls[k]
        const p = prev.get(c.key) ?? {}
        if (r && 'result' in r) {
          if (c.what === 'impl') p.impl = wordAddress(r.result)
          else if (c.what === 'beacon') p.beacon = wordAddress(r.result)
          else {
            const from = (r.result as { from?: unknown } | null)?.from
            p.sender = typeof from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(from) ? from.toLowerCase() : null
          }
        }
        prev.set(c.key, p)
      })
      // a beacon (it emits Upgraded itself) keeps its implementation outside the EIP-1967 slot: ask it, one block earlier
      const beaconLike = existing.filter((g) => groupFacts(g).implementation && prev.get(g.key)?.impl === null).slice(0, 10)
      if (beaconLike.length) {
        const r2 = await batched(
          beaconLike.map((g) => ({ method: 'eth_call', params: [{ to: g.address, data: '0x5c60da1b' }, hex(g.block - 1)] })),
          'beacon implementation',
        )
        r2.forEach((r, k) => {
          const a = r && 'result' in r ? wordAddress(r.result) : null
          if (a) prev.get(beaconLike[k].key)!.impl = a
        })
      }
    }

    // 3. events
    const via = `eth_getLogs · ${pool?.provider() ?? 'RPC'}${x.backfill ? ' (backfill)' : ''}`
    for (const g of groups) {
      const f = groupFacts(g)
      const ex = existed.has(g.key) ? existed.get(g.key)! : null
      const kind = classifyProxyGroup(g, ex)
      const { ts, estimated } = tsOf(chain, g.block, tsRaw.get(g.tx), x.head)
      const p = prev.get(g.key)
      if (kind === 'deploy' || (ex === null && (kind === 'upgrade' || kind === 'beacon_upgrade'))) {
        aggregate(chain, kind, g, f, ts, estimated, via, x.backfill, ex === null && kind !== 'deploy')
        continue
      }
      // an EIP-7702 account setting its first implementation (smart-wallet setup): a deployment, folded like one
      if (kind === 'upgrade' && delegated.has(g.key) && p && p.impl === null) {
        aggregate(chain, 'deploy', g, f, ts, estimated, via, x.backfill, false, 'includes EIP-7702 delegated accounts setting their first implementation (the slot was empty one block earlier)')
        continue
      }
      const k = `${chain}:${g.address}:${kind === 'admin_change' ? 'admin' : kind === 'beacon_upgrade' ? 'beacon' : 'code'}`
      const recentId = latestByKey.get(k)
      const recent = recentId ? events.get(recentId) : undefined
      let ev: RadarEvent
      if (recent && recent.kind === kind && Math.abs(ts - recent.ts) < T.coalesceMs && recent.tx !== g.tx && !!recent.backfill === x.backfill) {
        ev = recent
        ev.count += 1
      } else if (recent && recent.tx === g.tx && recent.kind === kind) {
        continue // the same transaction seen twice (window overlap)
      } else {
        ev = blankEvent(chain, kind, g.address, { via, backfill: x.backfill || undefined, ts })
        ev.before = { at: null, from: 'event', codeHash: null, authority: null, upgradeable: null, verified: 'unknown', name: null, surfaceCount: null }
      }
      ev.tx = g.tx
      ev.block = g.block
      ev.ts = Math.max(ev.ts, ts)
      if (estimated && chain === 'arbitrum') ev.notes.push('time estimated from block height')
      const before = ev.before!
      const after: RadarSide = { at: null, from: 'event', codeHash: null, authority: ev.after?.authority ?? null, upgradeable: true, verified: 'unknown', name: null, surfaceCount: null, ...(ev.after ?? {}) }
      if (kind === 'upgrade') {
        if (p && 'impl' in p) before.implementation = p.impl ?? null
        after.implementation = f.implementation
        if (before.implementation === null) ev.notes.push('no implementation in the EIP-1967 slot one block earlier (a beacon, or a non-standard proxy)')
      }
      if (kind === 'beacon_upgrade') {
        if (p && 'beacon' in p) before.beacon = p.beacon ?? null
        after.beacon = f.beacon
      }
      if (f.admin) {
        if (ev.count === 1) before.authority = f.admin.previous
        after.authority = f.admin.next
      }
      ev.after = after
      ev.actor = p?.sender ?? ev.actor ?? (f.admin?.next ?? null)
      ev.actorRole = p?.sender ? 'sender' : ev.actor ? 'admin' : null
      const why = knownWhy(chain, [g.address, f.implementation, before.implementation])
      ev.known = !!why
      ev.knownWhy = why
      ev.state = kind === 'upgrade' ? 'pending' : 'read'
      if (kind === 'admin_change') ev.diff = { code: 'unknown', authority: f.admin && f.admin.previous !== f.admin.next ? 'changed' : 'same', verified: 'unknown', surface: null, added: null, removed: null, guardsAdded: null, guardsRemoved: null, primitivesAdded: null, primitivesRemoved: null }
      put(ev)
      if (kind === 'upgrade' && f.implementation) queueEvm({ eventId: ev.id, chain, type: 'upgrade', newImpl: f.implementation, prevImpl: before.implementation ?? null, prio: (why ? 100 : 50) + (x.backfill ? -30 : 0), backfill: x.backfill })
    }
  }

  /** Deployments (and unchecked Upgraded events) of one implementation / beacon within an hour: one event. */
  function aggregate(chain: EvmChain, kind: RadarKind, g: ProxyTxGroup, f: ReturnType<typeof groupFacts>, ts: number, estimated: boolean, via: string, backfill: boolean, unchecked: boolean, note?: string) {
    const target = f.implementation ?? f.beacon ?? g.address
    const k = `${chain}:agg:${kind}:${target}`
    const id = latestByKey.get(k)
    let ev = id ? events.get(id) : undefined
    if (ev && ev.proxies && Math.abs(ts - ev.ts) < T.deployAggMs && !!ev.backfill === backfill) {
      if (ev.proxies.sample.includes(g.address) && ev.tx === g.tx) return
      if (!ev.proxies.sample.includes(g.address)) {
        ev.proxies.n += 1
        if (ev.proxies.sample.length < 6) ev.proxies.sample.push(g.address)
      }
      ev.count += 1
      ev.tx = g.tx
      ev.block = Math.max(ev.block ?? 0, g.block)
      ev.ts = Math.max(ev.ts, ts)
      put(ev)
      return
    }
    ev = blankEvent(chain, kind, g.address, { via, backfill: backfill || undefined, ts, tx: g.tx, block: g.block })
    ev.proxies = { n: 1, sample: [g.address] }
    ev.after = { at: null, from: 'event', codeHash: null, authority: f.admin?.next ?? null, upgradeable: true, verified: 'unknown', name: null, surfaceCount: null, implementation: f.implementation, ...(f.beacon ? { beacon: f.beacon } : {}) }
    // the event's facts are complete as caught; reading the implementation (name, surface) only adds to them
    ev.state = 'read'
    if (note) ev.notes.push(note)
    if (unchecked) ev.notes.push('not checked whether these proxies had code one block earlier (radar budget, or the endpoint no longer serves that block’s state): each is a deployment or an upgrade')
    if (estimated && chain === 'arbitrum') ev.notes.push('time estimated from block height')
    const why = knownWhy(chain, [g.address, f.implementation])
    ev.known = !!why
    ev.knownWhy = why
    put(ev)
    if (f.implementation) queueEvm({ eventId: ev.id, chain, type: 'name', newImpl: f.implementation, prevImpl: null, prio: why ? 40 : 5, backfill })
  }

  function queueEvm(t: EvmTask) {
    const i = evmQueue.findIndex((q) => q.prio < t.prio)
    if (i < 0) evmQueue.push(t)
    else evmQueue.splice(i, 0, t)
    while (evmQueue.length > 300) {
      const dropped = evmQueue.pop()!
      const ev = events.get(dropped.eventId)
      if (ev && ev.state === 'pending') {
        ev.state = 'partial'
        ev.notes.push('implementation not read: radar queue full')
        put(ev, false)
      }
    }
    pumpEvm()
  }

  function pumpEvm() {
    if (evmBusy || stopped) return
    const t = evmQueue.shift()
    if (!t) {
      wake()
      return
    }
    evmBusy = true
    enrichEvm(t)
      .catch((e) => log('warn', `radar ${t.chain} read: ${errMsg(e)}`))
      .finally(() => {
        evmBusy = false
        pumpEvm()
      })
  }

  const SCAN_WORK = 30_000_000
  const SCAN_MS = 250

  /** An implementation as the radar knows it (cached by address: an implementation's code does not change). */
  async function implSnap(chain: EvmChain, addr: string, ctx: RpcCtx, bf: boolean, notes: string[]): Promise<Snapshot | null> {
    const key = `impl:${chain}:${addr}`
    const cached = snapshots.get(key)
    if (cached && cached.verified !== 'unknown') return cached
    const b = budgetOf(bf)
    if (!b.can(chain, 2) || !sharedRoom(chain, 2)) {
      notes.push(`implementation ${addr.slice(0, 10)}… not read: radar budget used up for now`)
      return cached
    }
    const sfyOk = b.can('sourcify') && sharedRoom('sourcify')
    try {
      const r = await readEvm(chain, addr, ctx, { skipSourcify: () => !sfyOk })
      let guards: Snapshot['guards'] = null
      if (r.sources.length && r.read.abi) {
        let bytes = 0
        for (const f of r.sources) bytes += f.text.length
        if (bytes <= 1_500_000) {
          try {
            guards = findPrivileged(r.sources, r.read.abi.functions, new Work(SCAN_WORK, SCAN_MS)).map((p) => ({ fn: p.fn, guard: p.guard, at: `${p.file.split('/').pop()}:${p.line}` }))
          } catch (e) {
            if (!(e instanceof AnalysisLimit)) log('warn', `radar analysis: ${errMsg(e)}`)
            notes.push('admin-only functions not analysed (work cap)')
          }
        } else notes.push('admin-only functions not analysed (source over 1.5 MB)')
      }
      const s = snapshotOfRead(r.read, { guards, registryAsked: sfyOk, at: now() })
      if (r.read.kind !== 'contract') notes.push(`implementation ${addr.slice(0, 10)}… has no code now`)
      snapshots.put(key, s)
      return s
    } catch (e) {
      notes.push(`implementation ${addr.slice(0, 10)}… not read: ${e instanceof BudgetError ? 'radar budget used up for now' : errMsg(e)}`)
      return cached
    }
  }

  function implSide(s: Snapshot | null, impl: string | null | undefined, base: RadarSide | null, from: RadarSide['from']): RadarSide {
    const side: RadarSide = s ? sideOf(s, from) : { at: null, from: 'event', codeHash: null, authority: null, upgradeable: true, verified: 'unknown', name: null, surfaceCount: null }
    side.implementation = impl ?? null
    side.authority = base?.authority ?? null
    side.upgradeable = true
    if (base?.beacon !== undefined) side.beacon = base.beacon
    return side
  }

  async function enrichEvm(t: EvmTask) {
    const ev = events.get(t.eventId)
    if (!ev) return
    const ctx = sharedCtx(t.backfill)
    const tracer = createTraceRecorder(ctx, { provider: (k) => o.rpc.provider(k), address: t.newImpl })
    const notes: string[] = []
    const after = await implSnap(t.chain, t.newImpl, tracer.ctx, t.backfill, notes)
    const before = t.type === 'upgrade' && t.prevImpl && t.prevImpl !== t.newImpl ? await implSnap(t.chain, t.prevImpl, tracer.ctx, t.backfill, notes) : null
    const cur = events.get(t.eventId)
    if (!cur) return
    cur.after = implSide(after, t.newImpl, cur.after, after ? 'read' : 'event')
    if (t.type === 'upgrade') {
      if (t.prevImpl) cur.before = implSide(before, t.prevImpl, cur.before, before ? 'read' : 'event')
      cur.diff = after && before ? diffSnapshots(before, after) : after && t.prevImpl === t.newImpl ? { ...diffSnapshots(after, after) } : null
      if (t.prevImpl === t.newImpl) notes.push('the same implementation was set again')
    }
    const why = cur.knownWhy ?? knownWhy(t.chain, [cur.address, t.newImpl, t.prevImpl])
    cur.known = !!why
    cur.knownWhy = why
    const verified = after && (after.verified === 'sourcify-full' || after.verified === 'sourcify-partial')
    cur.name = verified ? safeName(after?.name ?? null) : (cur.name ?? null)
    cur.state = t.type === 'name' ? 'read' : after && (!t.prevImpl || before) ? 'read' : 'partial'
    cur.notes = [...cur.notes.filter((n) => !/^implementation .* not read/.test(n)), ...notes]
    const calls = tracer.calls()
    if (calls.length) cur.trace = calls.slice(0, 12)
    put(cur, t.type === 'upgrade' || cur.known)
    await sleep(t.backfill ? 600 : 250)
  }

  // ── EVM backfill (first start only) ──
  async function backfillEvm(chain: EvmChain) {
    if (state.backfill[chain]) return
    const pool = pools.get(chain)!
    const charge = (n: number) => bfBudget.charge(`logs-${chain}`, n)
    let head: { n: number; ts: number }
    try {
      head = await headOf(chain, charge)
    } catch (e) {
      log('warn', `radar ${chain} backfill: ${errMsg(e)} (retried at the next start)`)
      return
    }
    state.backfill[chain] = { started: now(), done: false, fromTs: null, events: 0, note: null }
    saveState(stateFile, state, log)
    const start = Number.isFinite(state.cursors[chain]) && state.cursors[chain] > 0 ? state.cursors[chain] : head.n - CONFIRM[chain]
    const target = start - Math.ceil(DAY / BLOCK_MS[chain])
    let to = start
    let window = MAX_WINDOW[chain]
    let calls = 0
    let note: string | null = null
    let failures = 0
    while (!stopped && to > target) {
      if (!bfBudget.can(`logs-${chain}`, 1)) {
        note = 'stopped at the backfill budget'
        break
      }
      const from = Math.max(target, to - window + 1)
      try {
        calls++
        const logs = await pool.call('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), topics: [RADAR_TOPICS] }], { timeoutMs: 25_000, maxBytes: 16 * 1048576, charge })
        if (Array.isArray(logs)) await ingestEvm(chain, logs, { backfill: true, head })
        to = from - 1
        failures = 0
        window = Math.min(MAX_WINDOW[chain], window + Math.ceil(window / 4))
      } catch (e) {
        if (e instanceof RangeLimitError) window = Math.max(1, Math.floor(window / 2))
        else if (e instanceof BudgetError) {
          note = 'stopped at the backfill budget'
          break
        } else if (e instanceof RpcError && e.transient && ++failures <= 6) {
          // rate limits and cooling endpoints: wait longer each time, then the same window again
          await sleep(15_000 * failures)
        } else {
          note = `stopped: ${errMsg(e)}`
          break
        }
      }
      await sleep(T.backfillGapMs)
    }
    const fromTs = head.ts - (head.n - (to + 1)) * BLOCK_MS[chain]
    state.backfill[chain] = { started: state.backfill[chain].started, done: true, fromTs, events: backfilled(chain), note: note ?? (to > target ? 'partial' : null) }
    saveState(stateFile, state, log)
    log('info', `radar: ${chain} backfill done (${calls} eth_getLogs windows${note ? `; ${note}` : ''})`)
  }

  // ════════════════════════════════════════════════════════════════════════
  // lifecycle, views
  // ════════════════════════════════════════════════════════════════════════

  let stopped = false
  let started = false
  const timers: NodeJS.Timeout[] = []
  let waiters: (() => void)[] = []
  function wake() {
    if (solBusy || evmBusy || solQueue.length || evmQueue.length || solPending.size) return
    const w = waiters
    waiters = []
    for (const f of w) f()
  }
  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  function flushAll(force = false) {
    evlog.flush(() => list().slice(0, EVENT_CAP))
    snapshots.flush(force)
    if (force || (stateDirty && (stateUrgent || now() - stateSavedAt >= 10_000))) {
      stateDirty = false
      stateUrgent = false
      stateSavedAt = now()
      saveState(stateFile, state, log)
    }
    budget.flush()
    bfBudget.flush()
  }

  function compact(ev: RadarEvent, withTrace: boolean): RadarEvent {
    const c: RadarEvent = { ...ev, notes: ev.notes.slice(0, 4) }
    const capList = (l: { items: string[]; more: number } | null, n: number) => (l ? { items: l.items.slice(0, n), more: l.more + Math.max(0, l.items.length - n) } : null)
    if (c.diff) c.diff = { ...c.diff, added: capList(c.diff.added, 12), removed: capList(c.diff.removed, 12), guardsAdded: c.diff.guardsAdded?.slice(0, 6) ?? null, guardsRemoved: c.diff.guardsRemoved?.slice(0, 6) ?? null }
    if (c.proxies) c.proxies = { n: c.proxies.n, sample: c.proxies.sample.slice(0, 4) }
    if (!withTrace) delete c.trace
    else if (c.trace) c.trace = c.trace.slice(0, 10)
    let size = Buffer.byteLength(JSON.stringify(c))
    if (size > WS_EVENT_MAX && c.trace) {
      delete c.trace
      size = Buffer.byteLength(JSON.stringify(c))
    }
    if (size > WS_EVENT_MAX && c.diff) {
      c.diff = { ...c.diff, added: capList(c.diff.added, 3), removed: capList(c.diff.removed, 3), guardsAdded: c.diff.guardsAdded?.slice(0, 2) ?? null, guardsRemoved: c.diff.guardsRemoved?.slice(0, 2) ?? null }
      c.notes = c.notes.slice(0, 1)
    }
    return c
  }

  let statusCache: { at: number; v: RadarStatus } | null = null
  function status(): RadarStatus {
    if (statusCache && now() - statusCache.at < 2000) return statusCache.v
    const since = now() - DAY
    const byKind: Partial<Record<RadarKind, number>> = {}
    const byChain: Partial<Record<ChainId, number>> = {}
    let total = 0
    let unchecked = 0
    for (const e of list()) {
      if (e.ts < since) break
      total++
      if (e.proxies && e.kind !== 'deploy') unchecked++
      else byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
      byChain[e.chain] = (byChain[e.chain] ?? 0) + 1
    }
    const sources: RadarStatus['sources'] = {}
    if (solOn) {
      const open = sub?.state() === 'open'
      const pollingNow = !open && lastSolPoll > 0 && now() - lastSolPoll < T.solPollMs * 3
      sources.solana = { via: open ? solVia.ws : pollingNow ? solVia.poll : `${solVia.ws} (connecting)`, up: open || pollingNow, lastAt: sub?.lastAt() ?? null }
    }
    for (const c of evmOn) {
      const st = evmState.get(c)!
      const pool = pools.get(c)!
      sources[c] = { via: `eth_getLogs · ${pool.provider()}`, up: pool.up() && st.lastOk !== null && now() - st.lastOk < T.evmPollMs * 4, lastAt: st.lastOk }
    }
    const backfill: RadarStatus['backfill'] = {}
    for (const [k, v] of Object.entries(state.backfill)) backfill[k as ChainId] = { done: v.done, fromTs: v.fromTs, events: v.events, note: v.note }
    const usage = { ...budget.usage() }
    const v: RadarStatus = { sources, last24h: { total, byKind, byChain, unchecked }, backfill, budget: usage, stored: events.size, updatedAt: now() }
    statusCache = { at: now(), v }
    return v
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      const flushTimer = setInterval(() => flushAll(false), 1500)
      flushTimer.unref?.()
      timers.push(flushTimer)
      if (solOn && wsUrl) {
        sub = createLoaderSubscription({ url: wsUrl, loaders: SOL_LOADERS, onLogs: (n) => ingestNotification(n), log, WebSocketImpl: o.WebSocketImpl as never, now })
        sub.start()
        const pollTimer = setInterval(() => {
          const down = sub?.downSince()
          if (down !== null && down !== undefined && now() - down > T.wsDownMs && now() - lastSolPoll >= T.solPollMs) void pollSolana()
        }, 5_000)
        pollTimer.unref?.()
        timers.push(pollTimer)
      }
      evmOn.forEach((c, i) => scheduleEvm(c, 3_000 + i * 4_000))
      if (backfillOn) {
        const bt = setTimeout(async () => {
          // never again after the first start: each chain's backfill is marked started before its first call
          const jobs: Promise<void>[] = []
          if (solOn) jobs.push(backfillSolana().catch((e) => log('warn', `radar Solana backfill: ${errMsg(e)}`)))
          for (const c of evmOn) jobs.push(backfillEvm(c).catch((e) => log('warn', `radar ${c} backfill: ${errMsg(e)}`)))
          await Promise.all(jobs)
        }, T.backfillDelayMs)
        bt.unref?.()
        timers.push(bt)
      }
      log(
        'info',
        `upgrade radar: Solana via ${solOn ? solVia.ws : 'off'}; EVM eth_getLogs via ${evmOn.map((c) => `${c} ${pools.get(c)!.provider()}`).join(', ') || 'off'}; ${events.size} stored events${
          backfillOn && !Object.keys(state.backfill).length ? '; first-start backfill in ~25 s' : ''
        }`,
      )
    },
    async stop() {
      if (stopped) return
      stopped = true
      for (const t of timers) {
        clearInterval(t)
        clearTimeout(t)
      }
      for (const p of solPending.values()) if (p.timer) clearTimeout(p.timer)
      for (const st of evmState.values()) if (st.timer) clearTimeout(st.timer)
      sub?.stop()
      for (const p of pools.values()) p.close()
      flushAll(true)
    },
    list(q) {
      const lim = Math.max(1, Math.min(100, q.limit ?? 50))
      let all = list()
      if (q.chain) all = all.filter((e) => e.chain === q.chain)
      if (q.kind) all = all.filter((e) => e.kind === q.kind)
      if (q.known) all = all.filter((e) => e.known)
      if (q.sort === 'priority') all = [...all].sort((a, b) => b.priority - a.priority || b.ts - a.ts || (a.id < b.id ? 1 : -1))
      let start = 0
      if (q.cursor) {
        const i = all.findIndex((e) => e.id === q.cursor)
        start = i >= 0 ? i + 1 : all.length
      }
      const page = all.slice(start, start + lim)
      const next = start + lim < all.length && page.length ? page[page.length - 1].id : null
      return { items: page.map((e) => compact(e, false)), next, status: status() }
    },
    get: (id) => events.get(id) ?? null,
    status,
    ingestSolanaLogs: (n, via) => ingestNotification(n, via),
    ingestEvmLogs: (chain, logs, x = {}) => ingestEvm(chain, logs, { backfill: !!x.backfill, head: x.head ?? null }),
    idle() {
      return new Promise<void>((resolve) => {
        waiters.push(resolve)
        // pending Solana actions wait for their timer: run them now
        for (const k of [...solPending.keys()]) enqueueSol(k)
        wake()
        pumpSol()
        pumpEvm()
      })
    },
  }
}

export type { RadarEvent }
