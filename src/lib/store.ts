import { create } from 'zustand'
import type {
  AgentInfo,
  DomainInfo,
  FrontierPick,
  Hello,
  InkEvent,
  LossPoint,
  ModelInfo,
  NeuronInfo,
  PageRecord,
  SectorInfo,
  ServerMsg,
  Stats,
  Trace,
} from '@shared/protocol'

/**
 * Connection to the LUSCA server (src/lib/live.ts).
 *  - connecting: no answer yet (first load, or a hidden tab reconnecting)
 *  - live:       the server's hello has been applied; the store mirrors the server
 *  - unreachable: the server cannot be reached; the client keeps retrying
 * Only 'live' carries data. Outside it the store is empty and every live number
 * must render "—" (see `useIsLive`, `fmtInt` and `CONN_TEXT`).
 */
export type ConnState = 'connecting' | 'live' | 'unreachable'

const UNREACHABLE_TEXT = "Can't reach the LUSCA server — reconnecting…"

/** One status line per connection state; the same words everywhere in the UI. */
export const CONN_TEXT: Record<ConnState, string> & { /** @deprecated use `unreachable` */ offline: string } = {
  live: 'Live from the LUSCA server',
  connecting: 'Connecting to the LUSCA server…',
  unreachable: UNREACHABLE_TEXT,
  offline: UNREACHABLE_TEXT,
}

/** Short badge label per connection state. */
export const CONN_LABEL: Record<ConnState, string> = {
  live: 'LIVE',
  connecting: 'CONNECTING',
  unreachable: 'UNREACHABLE',
}

export interface RejectEvent {
  agentId: number
  url: string
  host: string
  reason: string
  score: number | null
  ts: number
}

export interface DiscoverEvent {
  agentId: number
  from: string
  picks: FrontierPick[]
  total: number
  ts: number
}

export interface LiveState {
  conn: ConnState
  serverTime: number
  agents: AgentInfo[]
  stats: Stats
  sectors: SectorInfo[]
  domains: Record<string, DomainInfo>
  pages: PageRecord[]            // newest first
  rejects: RejectEvent[]         // newest first
  discovers: DiscoverEvent[]     // newest first
  traces: Trace[]                // newest first (global)
  agentTraces: Record<number, Trace[]> // newest first per agent
  loss: LossPoint[]
  model: ModelInfo
  samples: { step: number; text: string }[]
  neurons: NeuronInfo[]
  ink: InkEvent[]                // newest first
  selectedAgent: number | null
  setSelectedAgent: (id: number | null) => void
  setConn: (c: ConnState) => void
  apply: (msg: ServerMsg) => void
  reset: (hello: Hello) => void
  /** Drop every server-derived value (the link is down: nothing stale may look current). */
  clear: () => void
}

const CAP_PAGES = 300
const CAP_TRACES = 400
const CAP_AGENT_TRACES = 80
const CAP_EVENTS = 200
const CAP_LOSS = 2000

// Placeholders for the typed fields while there is no server data. They are never
// shown as values: consumers gate on `conn === 'live'` and render "—" otherwise.
export const emptyStats: Stats = {
  pages: 0, tokens: 0, bytes: 0, domains: 0, frontier: 0, rejected: 0, dupes: 0, errors: 0,
  agentsActive: 0, agentsTotal: 0, pagesPerMin: 0, tokensPerMin: 0, uptime: 0,
  neurons: 0, gflops: 0, jobsDone: 0, jobsVerified: 0, inkIssued: 0,
}

export const emptyModel: ModelInfo = {
  name: 'SEPIA-0', params: 0, arch: '—', vocab: 0, step: 0, loss: 0, val: null, corpusChars: 0, stepsPerSec: 0,
  version: 0, gpuSteps: 0, serverSteps: 0, gpuSamples: 0, contributors24h: 0, audits: { ok: 0, failed: 0 }, gpuStepsPerMin: 0,
}

function cap<T>(arr: T[], item: T, n: number): T[] {
  const next = [item, ...arr]
  if (next.length > n) next.length = n
  return next
}

const EMPTY_DATA = {
  serverTime: 0,
  agents: [] as AgentInfo[],
  stats: emptyStats,
  sectors: [] as SectorInfo[],
  domains: {} as Record<string, DomainInfo>,
  pages: [] as PageRecord[],
  rejects: [] as RejectEvent[],
  discovers: [] as DiscoverEvent[],
  traces: [] as Trace[],
  agentTraces: {} as Record<number, Trace[]>,
  loss: [] as LossPoint[],
  model: emptyModel,
  samples: [] as { step: number; text: string }[],
  neurons: [] as NeuronInfo[],
  ink: [] as InkEvent[],
}

export const useLive = create<LiveState>((set, get) => ({
  conn: 'connecting',
  ...EMPTY_DATA,
  selectedAgent: null,
  setSelectedAgent: (id) => set({ selectedAgent: id }),
  setConn: (conn) => set({ conn }),
  clear: () => set({ ...EMPTY_DATA }),

  reset: (h) => {
    const agentTraces: Record<number, Trace[]> = {}
    for (const tr of h.traces) {
      const list = (agentTraces[tr.agentId] ??= [])
      if (list.length < CAP_AGENT_TRACES) list.push(tr)
    }
    const domains: Record<string, DomainInfo> = {}
    for (const d of h.domains) domains[d.host] = d
    set({
      serverTime: h.serverTime,
      agents: h.agents,
      stats: h.stats,
      sectors: h.sectors,
      domains,
      pages: h.recent.slice(0, CAP_PAGES),
      rejects: [],
      discovers: [],
      traces: h.traces.slice(0, CAP_TRACES),
      agentTraces,
      loss: h.loss.slice(-CAP_LOSS),
      model: h.model,
      samples: h.samples,
      neurons: h.neurons,
      ink: [],
    })
  },

  apply: (msg) => {
    switch (msg.t) {
      case 'hello':
        get().reset(msg)
        return
      case 'agent': {
        const agents = get().agents.slice()
        const i = agents.findIndex((a) => a.id === msg.agent.id)
        if (i >= 0) agents[i] = msg.agent
        else agents.push(msg.agent)
        set({ agents })
        return
      }
      case 'trace': {
        const tr = msg.trace
        const at = get().agentTraces
        set({
          traces: cap(get().traces, tr, CAP_TRACES),
          agentTraces: { ...at, [tr.agentId]: cap(at[tr.agentId] ?? [], tr, CAP_AGENT_TRACES) },
        })
        return
      }
      case 'page':
        set({ pages: cap(get().pages, msg.page, CAP_PAGES) })
        return
      case 'reject':
        set({ rejects: cap(get().rejects, { agentId: msg.agentId, url: msg.url, host: msg.host, reason: msg.reason, score: msg.score, ts: msg.ts }, CAP_EVENTS) })
        return
      case 'discover':
        set({ discovers: cap(get().discovers, { agentId: msg.agentId, from: msg.from, picks: msg.picks, total: msg.total, ts: msg.ts }, CAP_EVENTS) })
        return
      case 'domain':
        set({ domains: { ...get().domains, [msg.domain.host]: msg.domain } })
        return
      case 'stats':
        set({ stats: msg.stats, sectors: msg.sectors })
        return
      case 'loss': {
        const loss = get().loss.slice()
        loss.push(msg.point)
        if (loss.length > CAP_LOSS) loss.splice(0, loss.length - CAP_LOSS)
        set({ loss, model: msg.model })
        return
      }
      case 'sample':
        set({ samples: [{ step: msg.step, text: msg.text }, ...get().samples].slice(0, 30) })
        return
      case 'neurons':
        set({ neurons: msg.neurons })
        return
      case 'ink':
        set({ ink: cap(get().ink, msg.event, CAP_EVENTS) })
        return
      default:
        return
    }
  },
}))
