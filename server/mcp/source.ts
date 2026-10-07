// LUSCA MCP: where the tools read from. Every tool goes through one McpSource, so the same tools run
// against the live modules in production (localSource), against lusca.ink's public API during local QA
// (remoteSource, env LUSCA_MCP_UPSTREAM, never set in production) and against fixtures in tests.
//
// Nothing here starts new work of its own: the local source answers from the stores the REST API already
// serves (chain feed and stats, radar events, control entries, atlas items) and sends Lens reads through
// server/lens with its cache, per-address limits and daily budget slice, exactly like GET /api/lens/*.

import type { ChainEvent, ChainId, ChainIndexItem, ChainRead, ChainStats } from '../../shared/chain.ts'
import type { RadarEvent, RadarKind, RadarPage } from '../../shared/radar.ts'
import type { RadarCodeDiff } from '../../shared/radarDiff.ts'
import type { ControlEntry, ControlPage, ControlSummary } from '../../shared/control.ts'
import type { AtlasItem } from '../../shared/atlas.ts'
import type { LensAnswer } from '../../shared/lens.ts'
import type { CodeIndexStats } from '../../shared/codebase.ts'
import type { Stats } from '../../shared/protocol.ts'

/** A feature the tool needs is switched off on this server, or the upstream did not answer. Shown to the model as a tool error. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly status = 503,
    readonly retryAfterS: number | null = null,
  ) {
    super(message)
    this.name = 'SourceError'
  }
}

/** Corpus and network numbers (no payout amounts). Each part is null when that module is off. */
export interface SourceStats {
  corpus: Pick<Stats, 'pages' | 'tokens' | 'domains' | 'pagesPerMin' | 'tokensPerMin'> & { heldPages: number | null; heldTokens: number | null } | null
  network: { neurons: number; gflops: number; jobsDone: number; jobsVerified: number } | null
  chain: Pick<ChainStats, 'reads' | 'kept' | 'programs' | 'contracts' | 'idls' | 'verified' | 'sourceBytes' | 'byChain' | 'rejected' | 'updatedAt'> | null
  code: { repos: number; files: number; bytes: number; updatedAt: number | null } | null
  audits: { ok: number; failed: number } | null
}

export interface RadarQuery {
  chain?: ChainId
  kind?: RadarKind
  known?: boolean
  limit: number
}

/** Lens answer or its refusal (status ≠ 200: { error } with an optional Retry-After). */
export type LensResult = { ok: true; answer: LensAnswer } | { ok: false; status: number; error: string; retryAfterS: number | null }

export interface McpSource {
  /** Where this source reads from, for logs and the docs page ('local' | the upstream origin). */
  readonly kind: string
  stats(): Promise<SourceStats>
  /** Chain feed, newest first, with call traces (≤ 50). */
  feed(limit: number): Promise<ChainEvent[]>
  /** One kept item and its stored read (no RPC); null when not kept. */
  chainItem(chain: ChainId, address: string): Promise<{ item: ChainIndexItem; read: ChainRead } | null>
  lens(chain: ChainId, address: string, ip: string): Promise<LensResult>
  radarList(q: RadarQuery): Promise<RadarPage>
  radarGet(id: string): Promise<RadarEvent | null>
  /** Source diff of one verified EVM upgrade (computed once, cached by server/radar/code-diff.ts). */
  radarDiff(id: string): Promise<RadarCodeDiff | null>
  controlGet(chain: ChainId, address: string): Promise<ControlEntry | null>
  controlList(q: { controller: string; limit: number }): Promise<ControlPage>
  controlSummary(): Promise<ControlSummary>
  atlasItem(chain: ChainId, address: string): Promise<AtlasItem | null>
}

// ─── local: the live modules of this server ─────────────────────────────────

type Route = { status: number; json: string; headers?: Record<string, string> }

/** The parts of the hub's modules (server/http.ts Modules) the tools read. All optional: a missing one is a SourceError. */
export interface LocalModules {
  chain?: { stats(): ChainStats; feed(limit: number): ChainEvent[]; item(chain: ChainId, address: string): { item: ChainIndexItem; read: ChainRead } | null } | null
  code?: { stats(): CodeIndexStats } | null
  lens?: { route(p: string, ip: string): Promise<Route> } | null
  radar?: { list(q: { chain?: ChainId; kind?: RadarKind; known?: boolean; sort?: 'new'; limit?: number }): RadarPage; get(id: string): RadarEvent | null } | null
  radarDiff?: { get(id: string): Promise<{ json: string; ready: boolean } | null> } | null
  control?: { summary(): ControlSummary; list(q: { controller?: string; limit?: number }): ControlPage; get(chain: ChainId, address: string): ControlEntry | null } | null
  atlas?: { route(p: string): Route } | null
}

export interface LocalExtras {
  /** Hub stats (server/http.ts buildStats). */
  stats?: () => Stats
  /** Gradient audits of the trainer (modelInfo().audits). */
  audits?: () => { ok: number; failed: number } | null
}

function need<T>(v: T | null | undefined, what: string): T {
  if (!v) throw new SourceError(`${what} is not available on this server`)
  return v
}

function parseRoute<T>(r: Route): { status: number; body: T | { error?: string } } {
  try {
    return { status: r.status, body: JSON.parse(r.json) as T }
  } catch {
    return { status: 500, body: { error: 'unreadable answer' } }
  }
}

export function localSource(getModules: () => LocalModules | null, extras: LocalExtras = {}): McpSource {
  const mods = () => {
    const m = getModules()
    if (!m) throw new SourceError('the server is starting — retry in a few seconds')
    return m
  }
  return {
    kind: 'local',
    async stats() {
      const m = mods()
      const s = (() => {
        try {
          return extras.stats?.() ?? null
        } catch {
          return null
        }
      })()
      const cs = (() => {
        try {
          return m.chain?.stats() ?? null
        } catch {
          return null
        }
      })()
      const code = (() => {
        try {
          return m.code?.stats() ?? null
        } catch {
          return null
        }
      })()
      const audits = (() => {
        try {
          return extras.audits?.() ?? null
        } catch {
          return null
        }
      })()
      return statsOf(s, cs, code, audits)
    },
    async feed(limit) {
      return need(mods().chain, 'the chain feed').feed(Math.min(50, limit))
    },
    async chainItem(chain, address) {
      return need(mods().chain, 'the chain index').item(chain, address)
    },
    async lens(chain, address, ip) {
      const lens = need(mods().lens, 'LUSCA Lens')
      const r = await lens.route(`/api/lens/${chain}/${encodeURIComponent(address)}`, ip)
      const { status, body } = parseRoute<LensAnswer>(r)
      if (status === 200) return { ok: true, answer: body as LensAnswer }
      const ra = Number(r.headers?.['Retry-After'])
      return { ok: false, status, error: (body as { error?: string }).error ?? `Lens answered ${status}`, retryAfterS: Number.isFinite(ra) && ra > 0 ? ra : null }
    },
    async radarList(q) {
      return need(mods().radar, 'the upgrade radar').list({ chain: q.chain, kind: q.kind, known: q.known, sort: 'new', limit: q.limit })
    },
    async radarGet(id) {
      return need(mods().radar, 'the upgrade radar').get(id)
    },
    async radarDiff(id) {
      const d = mods().radarDiff
      if (!d) return null
      const r = await d.get(id)
      if (!r) return null
      try {
        return JSON.parse(r.json) as RadarCodeDiff
      } catch {
        return null
      }
    },
    async controlGet(chain, address) {
      return need(mods().control, 'the control map').get(chain, address)
    },
    async controlList(q) {
      return need(mods().control, 'the control map').list({ controller: q.controller, limit: q.limit })
    },
    async controlSummary() {
      return need(mods().control, 'the control map').summary()
    },
    async atlasItem(chain, address) {
      const atlas = need(mods().atlas, 'the code atlas')
      const r = parseRoute<AtlasItem>(atlas.route(`/api/atlas/item/${chain}/${address}`))
      if (r.status === 404) return null
      if (r.status !== 200) throw new SourceError((r.body as { error?: string }).error ?? `the atlas answered ${r.status}`, r.status)
      return r.body as AtlasItem
    },
  }
}

function statsOf(s: Stats | null, cs: ChainStats | null, code: CodeIndexStats | null, audits: { ok: number; failed: number } | null): SourceStats {
  return {
    corpus: s
      ? { pages: s.pages, tokens: s.tokens, domains: s.domains, pagesPerMin: s.pagesPerMin, tokensPerMin: s.tokensPerMin, heldPages: s.heldPages ?? null, heldTokens: s.heldTokens ?? null }
      : null,
    network: s ? { neurons: s.neurons, gflops: s.gflops, jobsDone: s.jobsDone, jobsVerified: s.jobsVerified } : null,
    chain: cs
      ? { reads: cs.reads, kept: cs.kept, programs: cs.programs, contracts: cs.contracts, idls: cs.idls, verified: cs.verified, sourceBytes: cs.sourceBytes, byChain: cs.byChain, rejected: cs.rejected, updatedAt: cs.updatedAt }
      : null,
    code: code ? { repos: code.repos.filter((r) => r.status === 'ok').length, files: code.files, bytes: code.bytes, updatedAt: code.updatedAt } : null,
    audits,
  }
}

// ─── remote: lusca.ink's public API (local QA only) ─────────────────────────

export interface RemoteOptions {
  /** Upstream origin, e.g. https://lusca.ink. */
  base: string
  /** Minimum spacing between upstream requests (default 1100 ms: at most ~1 request per second). */
  spacingMs?: number
  /** Answers are reused this long (default 30 s). */
  cacheMs?: number
  timeoutMs?: number
  fetch?: typeof fetch
}

/**
 * Reads the same answers from a LUSCA server's public REST API, one request at a time with a spacing
 * (polite to the upstream) and a short cache. For local QA against production data; production itself
 * uses localSource.
 */
export function remoteSource(o: RemoteOptions): McpSource {
  const base = o.base.replace(/\/+$/, '')
  const spacing = o.spacingMs ?? 1100
  const ttl = o.cacheMs ?? 30_000
  const timeout = o.timeoutMs ?? 25_000
  const f = o.fetch ?? fetch
  const cache = new Map<string, { at: number; v: { status: number; body: unknown; retryAfterS: number | null } }>()
  let chain: Promise<unknown> = Promise.resolve()
  let last = 0
  let queued = 0

  async function get<T>(path: string): Promise<{ status: number; body: T; retryAfterS: number | null }> {
    const hit = cache.get(path)
    if (hit && Date.now() - hit.at < ttl) return hit.v as { status: number; body: T; retryAfterS: number | null }
    if (queued >= 24) throw new SourceError('the upstream queue is full — retry in a few seconds', 503, 5)
    queued++
    const run = chain.then(async () => {
      const wait = last + spacing - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      last = Date.now()
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), timeout)
      try {
        const r = await f(base + path, { headers: { Accept: 'application/json', 'User-Agent': 'lusca-mcp-dev (local QA)' }, signal: ac.signal })
        const text = await r.text()
        let body: unknown = null
        try {
          body = JSON.parse(text)
        } catch {
          body = { error: `upstream answered ${r.status}` }
        }
        const ra = Number(r.headers.get('retry-after'))
        const v = { status: r.status, body, retryAfterS: Number.isFinite(ra) && ra > 0 ? ra : null }
        if (r.status === 200 || r.status === 404) cache.set(path, { at: Date.now(), v })
        while (cache.size > 300) cache.delete(cache.keys().next().value as string)
        return v
      } finally {
        clearTimeout(t)
        last = Date.now()
      }
    })
    chain = run.catch(() => {})
    try {
      return (await run) as { status: number; body: T; retryAfterS: number | null }
    } catch (e) {
      throw new SourceError(`the upstream did not answer (${(e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message})`)
    } finally {
      queued--
    }
  }
  const ok = async <T>(path: string, what: string): Promise<T> => {
    const r = await get<T>(path)
    if (r.status !== 200) throw new SourceError(`${what}: ${(r.body as { error?: string })?.error ?? `upstream answered ${r.status}`}`, r.status, r.retryAfterS)
    return r.body
  }
  const orNull = async <T>(path: string, what: string): Promise<T | null> => {
    const r = await get<T>(path)
    if (r.status === 404) return null
    if (r.status !== 200) throw new SourceError(`${what}: ${(r.body as { error?: string })?.error ?? `upstream answered ${r.status}`}`, r.status, r.retryAfterS)
    return r.body
  }
  const enc = encodeURIComponent

  return {
    kind: base,
    async stats() {
      const soft = async <T>(p: string): Promise<T | null> => {
        try {
          const r = await get<T>(p)
          return r.status === 200 ? r.body : null
        } catch {
          return null
        }
      }
      const s = await soft<{ stats: Stats }>('/api/stats')
      const cs = await soft<ChainStats>('/api/chain/stats')
      const code = await soft<CodeIndexStats>('/api/code/stats')
      const health = await soft<{ model?: { audits?: { ok: number; failed: number } } }>('/api/health')
      return statsOf(s?.stats ?? null, cs, code, health?.model?.audits ?? null)
    },
    async feed(limit) {
      return ok<ChainEvent[]>(`/api/chain/feed?limit=${Math.min(50, limit)}&scan=1`, 'chain feed')
    },
    async chainItem(c, address) {
      return orNull<{ item: ChainIndexItem; read: ChainRead }>(`/api/chain/item/${c}/${enc(address)}`, 'chain item')
    },
    async lens(c, address) {
      const r = await get<LensAnswer | { error?: string }>(`/api/lens/${c}/${enc(address)}`)
      if (r.status === 200) return { ok: true, answer: r.body as LensAnswer }
      return { ok: false, status: r.status, error: (r.body as { error?: string })?.error ?? `upstream answered ${r.status}`, retryAfterS: r.retryAfterS }
    },
    async radarList(q) {
      const p = new URLSearchParams({ limit: String(q.limit), sort: 'new' })
      if (q.chain) p.set('chain', q.chain)
      if (q.kind) p.set('kind', q.kind)
      if (q.known) p.set('known', '1')
      return ok<RadarPage>(`/api/radar?${p}`, 'radar')
    },
    async radarGet(id) {
      return orNull<RadarEvent>(`/api/radar/${enc(id)}`, 'radar event')
    },
    async radarDiff(id) {
      return orNull<RadarCodeDiff>(`/api/radar/${enc(id)}/diff`, 'radar diff')
    },
    async controlGet(c, address) {
      return orNull<ControlEntry>(`/api/control/${c}/${enc(address)}`, 'control')
    },
    async controlList(q) {
      return ok<ControlPage>(`/api/control/items?controller=${enc(q.controller)}&limit=${q.limit}`, 'control list')
    },
    async controlSummary() {
      return ok<ControlSummary>('/api/control/summary', 'control summary')
    },
    async atlasItem(c, address) {
      return orNull<AtlasItem>(`/api/atlas/item/${c}/${enc(address)}`, 'atlas')
    },
  }
}
