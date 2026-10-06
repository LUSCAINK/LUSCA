// Chain agents: the web agents' loop applied to on-chain code. Nobody hands them addresses.
//
//   discovery (block sampling · Sourcify / OtterSec registries · web corpus · links)
//      ─▶ per-chain frontier ─▶ agents sol-1, sol-2, eth-1, base-1, arb-1
//      ─▶ read over RPC (solana.ts / evm.ts) ─▶ evaluate (store.ts) ─▶ kept → <data>/chain shards
//      ─▶ feed event (ring of 500, persisted) ─▶ WS broadcast { t: 'chain' } (≤ 4/s)
//
// Env: LUSCA_CHAIN_AGENTS=0 (all off; stored data still served) · LUSCA_CHAIN_MAX_MB (100)
//      LUSCA_SOLANA_RPC (program reads, Helius on Render; never logged) · LUSCA_SOLANA_DISCOVERY_RPC
//      LUSCA_ETH_RPC · LUSCA_BASE_RPC · LUSCA_ARB_RPC
//      LUSCA_CHAIN_SOL_CALLS (8000/day) · LUSCA_CHAIN_SOL_DISCOVERY_CALLS (3000/day)
//      LUSCA_CHAIN_EVM_CALLS (15000/day per chain) · LUSCA_CHAIN_HTTP_CALLS (5000/day per registry)
//      LUSCA_LENS=0 (Lens off) · LUSCA_LENS_SOL_CALLS / LUSCA_LENS_EVM_CALLS / LUSCA_LENS_HTTP_CALLS (Lens's
//      daily slice, charged on top of the shared budgets; default 15 % of the limits above) — server/lens
//
// The REST routes read stored data only (stats / feed / items / item): no RPC per request.

import path from 'node:path'
import type { ChainEvent, ChainId, ChainIndexItem, ChainRead, ChainStats } from '../../shared/chain.ts'
import { createRpc, redact, type BudgetKey, type ChainRpc } from './rpc.ts'
import { createChainStore, readJson, writeJsonAtomic } from './store.ts'
import { createChainAgentsWith, DEFAULT_AGENTS, type ChainAgents, type DiscoveryLike } from './agents.ts'
import { createDiscovery } from './discover.ts'
import { readSolana } from './solana.ts'
import { readEvm } from './evm.ts'
import { createLens, DEFAULT_LENS_LIMITS, type Lens } from '../lens/index.ts'
import { createProvenanceIndex } from '../lens/provenance.ts'

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

export interface ChainAgentsApi {
  start(): void
  stop(): Promise<void>
  stats(): ChainStats
  feed(limit: number): ChainEvent[]
  items(q: { chain?: ChainId; limit?: number; cursor?: string }): { items: ChainIndexItem[]; next: string | null }
  item(chain: ChainId, address: string): { item: ChainIndexItem; read: ChainRead } | null
  /** LUSCA Lens (server/lens): on-demand reads with the same readers, its own budget slice; null when LUSCA_LENS=0. */
  lens: Lens | null
}

function intEnv(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return def
  const v = Number(raw)
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : def
}

const FEED_SAVE_MS = 15_000

export function createChainAgents(opts: {
  solanaRpc: string
  solanaDiscoveryRpc?: string
  evmRpcs?: Partial<Record<'ethereum' | 'base' | 'arbitrum', string>>
  dataDir: string
  log: (lvl: 'info' | 'warn' | 'error', msg: string) => void
  broadcast: (msg: { t: 'chain'; event: ChainEvent }) => void
}): ChainAgentsApi {
  const log: Log = (lvl, msg) => opts.log(lvl, redact(msg))
  const enabled = !/^(0|false|no|off)$/i.test(process.env.LUSCA_CHAIN_AGENTS?.trim() ?? '')
  const env = (k: string) => process.env[k]?.trim() || undefined

  const store = createChainStore({ dataDir: opts.dataDir, log, maxMb: intEnv('LUSCA_CHAIN_MAX_MB', 100, 1, 10_000) })

  const evmCalls = intEnv('LUSCA_CHAIN_EVM_CALLS', 15_000, 0, 10_000_000)
  const httpCalls = intEnv('LUSCA_CHAIN_HTTP_CALLS', 5000, 0, 1_000_000)
  const limits: Record<BudgetKey, number> = {
    solana: intEnv('LUSCA_CHAIN_SOL_CALLS', 8000, 0, 10_000_000),
    'solana-discovery': intEnv('LUSCA_CHAIN_SOL_DISCOVERY_CALLS', 3000, 0, 10_000_000),
    ethereum: evmCalls,
    base: evmCalls,
    arbitrum: evmCalls,
    sourcify: httpCalls,
    osec: httpCalls,
  }

  // the caller decides (server/index.ts drops a devnet / testnet LUSCA_SOLANA_RPC); '' → public mainnet
  const solanaReadRpc = opts.solanaRpc?.trim() || undefined
  const dedicatedSolana = !!solanaReadRpc
  const rpc: ChainRpc = createRpc({
    solanaRpc: solanaReadRpc,
    solanaDiscoveryRpc: opts.solanaDiscoveryRpc?.trim() || env('LUSCA_SOLANA_DISCOVERY_RPC'),
    evmRpcs: {
      ethereum: opts.evmRpcs?.ethereum?.trim() || env('LUSCA_ETH_RPC'),
      base: opts.evmRpcs?.base?.trim() || env('LUSCA_BASE_RPC'),
      arbitrum: opts.evmRpcs?.arbitrum?.trim() || env('LUSCA_ARB_RPC'),
    },
    limits,
    dataDir: opts.dataDir,
    log,
  })

  const discovery: DiscoveryLike = enabled
    ? createDiscovery({ rpc, dataDir: opts.dataDir, log })
    : { start() {}, stop: async () => {}, next: () => null, push() {}, markRead() {}, stats: () => ({}) }

  const agents: ChainAgents = createChainAgentsWith({
    rpc,
    discovery,
    readSolana,
    readEvm,
    store,
    broadcast: opts.broadcast,
    log,
    agents: DEFAULT_AGENTS,
    // let the server finish booting and discovery sample its first blocks
    startDelayMs: 20_000,
  })

  // LUSCA Lens: on-demand reads through the same network layer, under its own daily slice of every
  // budget (LUSCA_LENS_SOL_CALLS / _EVM_CALLS / _HTTP_CALLS; default 15 % of the agents' limits)
  const lensOn = !/^(0|false|no|off)$/i.test(process.env.LUSCA_LENS?.trim() ?? '')
  const provenance = createProvenanceIndex({ dataDir: opts.dataDir, log: (l, m) => log(l, m) })
  const pct = (n: number) => Math.floor(n * 0.15)
  const lensEvm = intEnv('LUSCA_LENS_EVM_CALLS', pct(evmCalls), 0, 10_000_000)
  const lensHttp = intEnv('LUSCA_LENS_HTTP_CALLS', pct(httpCalls), 0, 1_000_000)
  const lens: Lens | null = lensOn
    ? createLens({
        rpc,
        store,
        record: (ev) => agents.record(ev),
        feed: (n) => agents.feed(n),
        provenance,
        dataDir: opts.dataDir,
        log,
        limits: {
          budget: {
            ...DEFAULT_LENS_LIMITS.budget,
            solana: intEnv('LUSCA_LENS_SOL_CALLS', pct(limits.solana), 0, 10_000_000),
            ethereum: lensEvm,
            base: lensEvm,
            arbitrum: lensEvm,
            sourcify: lensHttp,
            osec: lensHttp,
          },
        },
      })
    : null

  // the feed survives restarts (newest 200 events)
  const feedFile = path.join(opts.dataDir, 'chain', 'feed.json')
  const savedFeed = readJson<ChainEvent[]>(feedFile)
  if (Array.isArray(savedFeed)) agents.restoreFeed(savedFeed.slice().reverse())
  let feedTimer: NodeJS.Timeout | null = null
  let savedTop: string | null = agents.feed(1)[0]?.id ?? null
  const saveFeed = () => {
    const top = agents.feed(1)[0]?.id ?? null
    if (top === savedTop) return
    savedTop = top
    try {
      writeJsonAtomic(feedFile, agents.feed(200))
    } catch (e) {
      log('warn', `feed.json save failed: ${(e as Error).message}`)
    }
  }

  let started = false
  let stopped = false

  return {
    start() {
      if (started || stopped) return
      started = true
      if (lens) provenance.start() // code-index hashes for Lens provenance (background, incremental)
      if (!enabled) {
        log('info', 'chain agents off (LUSCA_CHAIN_AGENTS=0); stored chain data is still served')
        return
      }
      const full = store.full()
      if (full) log('warn', `chain store: ${full} — agents stay idle`)
      discovery.start()
      agents.start()
      feedTimer = setInterval(saveFeed, FEED_SAVE_MS)
      feedTimer.unref?.()
      log(
        'info',
        `chain agents: ${DEFAULT_AGENTS.map((a) => a.id).join(', ')} (first read in ~20 s); Solana program reads via ${
          dedicatedSolana ? 'LUSCA_SOLANA_RPC' : 'the public RPC (LUSCA_SOLANA_RPC unset)'
        }`,
      )
    },
    async stop() {
      if (stopped) return
      stopped = true
      if (feedTimer) clearInterval(feedTimer)
      await provenance.stop()
      await lens?.stop()
      const agentsDone = agents.stop() // wakes sleeping agents; in-flight reads end with the RPC close below
      await rpc.close()
      await agentsDone
      await discovery.stop().catch((e: unknown) => log('warn', `discovery stop: ${(e as Error)?.message ?? e}`))
      await store.close()
      saveFeed()
    },
    // switched off: no agent is listed (the page says the agents are not running); stored data stays
    stats: () => (enabled ? agents.stats() : { ...agents.stats(), agents: [] }),
    feed: (limit) => agents.feed(limit),
    items: (q) => agents.items(q),
    item: (chain, address) => agents.item(chain, address),
    lens,
  }
}
