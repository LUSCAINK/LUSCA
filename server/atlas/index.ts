// CODE ATLAS: a map of every program and contract the chain agents have kept.
// Reads only what the chain index already stores (ABI names, IDL instructions, source file stems): NO RPC, no
// registry calls, so it costs nothing from the daily budgets. Background build: features → MinHash → kNN →
// clusters + labels → force layout warm-started from <data>/atlas/layout.json. New kept items are placed next to
// their nearest neighbour between full builds, so dots never jump.
//
// REST: GET /api/atlas -> AtlasMap (columnar, quantized 0..10000) ; GET /api/atlas/item/:chain/:address -> AtlasItem
import fs from 'node:fs'
import path from 'node:path'
import type { ChainId, ChainIndexItem, ChainRead } from '../../shared/chain.ts'
import type { AtlasItem, AtlasMap } from '../../shared/atlas.ts'
import { ATLAS_CHAINS } from '../../shared/atlas.ts'
import { clusters, featuresOf, frameOf, knn, labelClusters, layout, minhash, nearest, quantize, rng, type AtlasNode, type Edge, type Frame } from './core.ts'

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

export interface AtlasSource {
  items(q: { chain?: ChainId; limit?: number; cursor?: string }): { items: ChainIndexItem[]; next: string | null }
  item(chain: ChainId, address: string): { item: ChainIndexItem; read: ChainRead } | null
}

export interface AtlasOptions {
  source: AtlasSource
  dataDir: string
  log: Log
  /** Most points mapped (newest kept first beyond it). */
  maxPoints?: number
  /** Check for newly kept items this often, ms. */
  refreshMs?: number
  /** Full rebuild (kNN, clusters, warm layout) at most this often, ms. */
  rebuildMs?: number
  startDelayMs?: number
}

export interface Atlas {
  start(): void
  stop(): Promise<void>
  /** Bring the map up to date now (tests, tools). */
  refresh(full?: boolean): void
  route(p: string): { status: number; json: string; headers?: Record<string, string> }
  map(): AtlasMap
}

const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a)
const keyOf = (chain: ChainId, address: string) => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`

export function createAtlas(o: AtlasOptions): Atlas {
  const log = o.log
  const maxPoints = o.maxPoints ?? 6000
  const refreshMs = o.refreshMs ?? 15_000
  const rebuildMs = o.rebuildMs ?? 20 * 60_000
  const dir = path.join(o.dataDir, 'atlas')
  const layoutFile = path.join(dir, 'layout.json')

  let nodes: AtlasNode[] = []
  const index = new Map<string, number>()
  let edges: Edge[][] = []
  let pos: Float64Array = new Float64Array(0)
  let frame: Frame | undefined
  let cl: number[] = []
  let labels: string[] = []
  let builtAt = 0
  let lastFull = 0
  let addedSinceFull = 0
  let version = 0
  let mapCache: { v: number; json: string; map: AtlasMap } | null = null
  const itemCache = new Map<string, { at: number; json: string }>()
  let timer: NodeJS.Timeout | null = null
  let startTimer: NodeJS.Timeout | null = null
  let stopped = false

  function loadPrev(): Map<string, [number, number]> {
    const m = new Map<string, [number, number]>()
    try {
      const j = JSON.parse(fs.readFileSync(layoutFile, 'utf8')) as { v: number; pos: Record<string, [number, number]> }
      if (j?.v === 1 && j.pos) for (const [k, p] of Object.entries(j.pos)) if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) m.set(k, [p[0], p[1]])
    } catch { /* first boot */ }
    return m
  }
  function savePrev() {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const out: Record<string, [number, number]> = {}
      nodes.forEach((nd, i) => { out[nd.key] = [Math.round(pos[2 * i] * 1000) / 1000, Math.round(pos[2 * i + 1] * 1000) / 1000] })
      const tmp = `${layoutFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, pos: out }))
      fs.renameSync(tmp, layoutFile)
    } catch (e) { log('warn', `atlas: layout save failed: ${(e as Error)?.message ?? e}`) }
  }

  /** Every kept item, newest first, capped. */
  function listAll(): ChainIndexItem[] {
    const out: ChainIndexItem[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 1000 && out.length < maxPoints; guard++) {
      const page = o.source.items({ limit: 200, cursor })
      out.push(...page.items)
      if (!page.next) break
      cursor = page.next
    }
    return out.slice(0, maxPoints)
  }

  function nodeOf(it: ChainIndexItem): AtlasNode | null {
    const r = o.source.item(it.chain, it.address)
    if (!r) return null
    const tokens = featuresOf(r.read)
    return { key: keyOf(it.chain, it.address), chain: it.chain, address: it.address, name: it.name ?? r.read.name ?? null, tokens, sig: minhash(tokens), verifiedBy: it.verifiedBy, firstSeen: it.firstSeen }
  }

  function full(all: ChainIndexItem[]) {
    const t0 = Date.now()
    const keep: AtlasNode[] = []
    for (const it of [...all].reverse()) { // oldest first: a stable order for the layout
      const k = keyOf(it.chain, it.address)
      const had = index.get(k)
      const nd = had != null ? nodes[had] : nodeOf(it)
      if (nd) keep.push(nd)
    }
    const prev = loadPrev()
    nodes.forEach((nd, i) => prev.set(nd.key, [pos[2 * i], pos[2 * i + 1]]))
    nodes = keep
    index.clear()
    nodes.forEach((nd, i) => index.set(nd.key, i))
    edges = knn(nodes)
    cl = clusters(edges)
    labels = labelClusters(nodes, cl)
    pos = layout(nodes, edges, prev)
    frame = frameOf(pos)
    lastFull = Date.now()
    addedSinceFull = 0
    builtAt = Date.now()
    version++
    itemCache.clear()
    savePrev()
    log('info', `atlas: mapped ${nodes.length} items in ${labels.length} clusters (${Date.now() - t0} ms)`)
  }

  function incremental(fresh: ChainIndexItem[]) {
    const rand = rng(nodes.length * 2654435761)
    const add: AtlasNode[] = []
    for (const it of [...fresh].reverse()) { const nd = nodeOf(it); if (nd) add.push(nd) }
    if (!add.length) return
    const grown = new Float64Array((nodes.length + add.length) * 2)
    grown.set(pos)
    for (const nd of add) {
      const i = nodes.length
      nodes.push(nd)
      index.set(nd.key, i)
      const e = nearest(nodes, i, 10)
      edges.push(e)
      const nn = e[0]
      const a = rand() * Math.PI * 2, r = 0.5 + rand() * 0.6
      if (nn) {
        grown[2 * i] = grown[2 * nn.j] + Math.cos(a) * r
        grown[2 * i + 1] = grown[2 * nn.j + 1] + Math.sin(a) * r
        cl.push(nn.w >= 0.3 ? cl[nn.j] : -1)
      } else {
        grown[2 * i] = Math.cos(a) * 3
        grown[2 * i + 1] = Math.sin(a) * 3
        cl.push(-1)
      }
    }
    pos = grown
    addedSinceFull += add.length
    builtAt = Date.now()
    version++
  }

  function refresh(forceFull = false) {
    if (stopped) return
    try {
      const all = listAll()
      const fresh = all.filter((it) => !index.has(keyOf(it.chain, it.address)))
      const due = Date.now() - lastFull > rebuildMs && (addedSinceFull > 0 || fresh.length > 0)
      if (forceFull || !lastFull || due || addedSinceFull + fresh.length > Math.max(25, nodes.length * 0.08)) full(all)
      else if (fresh.length) incremental(fresh)
    } catch (e) {
      log('warn', `atlas: refresh failed: ${(e as Error)?.message ?? e}`)
    }
  }

  function map(): AtlasMap {
    if (mapCache && mapCache.v === version) return mapCache.map
    const { x, y } = quantize(pos, frame)
    const count = labels.length
    const cx = new Array(count).fill(0), cy = new Array(count).fill(0), cn = new Array(count).fill(0)
    cl.forEach((c, i) => { if (c >= 0) { cx[c] += x[i]; cy[c] += y[i]; cn[c]++ } })
    const byChain: Record<string, number> = {}
    for (const nd of nodes) byChain[nd.chain] = (byChain[nd.chain] ?? 0) + 1
    const m: AtlasMap = {
      v: version,
      builtAt,
      n: nodes.length,
      chains: ATLAS_CHAINS,
      byChain,
      clusters: labels.map((label, id) => ({ id, label, n: cn[id], x: cn[id] ? Math.round(cx[id] / cn[id]) : 5000, y: cn[id] ? Math.round(cy[id] / cn[id]) : 5000 })).filter((c) => c.n > 0),
      x,
      y,
      c: nodes.map((nd) => Math.max(0, ATLAS_CHAINS.indexOf(nd.chain))),
      k: cl.slice(0, nodes.length),
      name: nodes.map((nd) => (nd.name ? nd.name.slice(0, 32) : '')),
      a: nodes.map((nd) => nd.address),
      vf: nodes.map((nd) => (nd.verifiedBy ? 1 : 0)),
      t: nodes.map((nd) => Math.floor(nd.firstSeen / 1000)),
      e: nodes.map((_, i) => { const nn = edges[i]?.[0]; return nn && nn.w >= 0.3 ? nn.j : -1 }),
    }
    mapCache = { v: version, json: JSON.stringify(m), map: m }
    return m
  }

  function itemOf(chain: ChainId, address: string): AtlasItem | null {
    const i = index.get(keyOf(chain, address))
    if (i == null) return null
    const nd = nodes[i]
    const rel = nearest(nodes, i, 6, 32)
    const here = new Set(nd.tokens)
    const fnName = (t: string) => t.slice(t.indexOf(':') + 1)
    const isName = (t: string) => /^(fn|ix|ev):/.test(t)
    return {
      chain: nd.chain,
      address: nd.address,
      name: nd.name,
      verifiedBy: nd.verifiedBy,
      cluster: cl[i] ?? -1,
      clusterLabel: cl[i] >= 0 ? labels[cl[i]] ?? null : null,
      functions: nd.tokens.filter((t) => t.startsWith('fn:') || t.startsWith('ix:')).length,
      events: nd.tokens.filter((t) => t.startsWith('ev:')).length,
      sample: nd.tokens.filter((t) => t.startsWith('fn:') || t.startsWith('ix:')).slice(0, 12).map(fnName),
      relatives: rel.map((e) => {
        const o2 = nodes[e.j]
        const there = new Set(o2.tokens)
        return {
          chain: o2.chain,
          address: o2.address,
          name: o2.name,
          similarity: Math.round(e.w * 100),
          shared: nd.tokens.filter((t) => there.has(t) && isName(t)).length,
          onlyHere: nd.tokens.filter((t) => !there.has(t) && isName(t)).slice(0, 6).map(fnName),
          onlyThere: o2.tokens.filter((t) => !here.has(t) && isName(t)).slice(0, 6).map(fnName),
        }
      }),
    }
  }

  const CACHE = { 'Cache-Control': 'public, max-age=10' }
  function route(p: string): { status: number; json: string; headers?: Record<string, string> } {
    if (p === '/api/atlas') {
      map()
      return { status: 200, json: mapCache!.json, headers: CACHE }
    }
    const m = /^\/api\/atlas\/item\/(solana|ethereum|base|arbitrum)\/([A-Za-z0-9]{20,64})$/.exec(p)
    if (!m) return { status: 404, json: JSON.stringify({ error: 'not found' }) }
    const key = `${version}:${keyOf(m[1] as ChainId, m[2])}`
    const hit = itemCache.get(key)
    if (hit) return { status: 200, json: hit.json, headers: CACHE }
    const it = itemOf(m[1] as ChainId, m[2])
    if (!it) return { status: 404, json: JSON.stringify({ error: 'not on the atlas yet' }) }
    const json = JSON.stringify(it)
    if (itemCache.size > 2000) itemCache.clear()
    itemCache.set(key, { at: Date.now(), json })
    return { status: 200, json, headers: CACHE }
  }

  return {
    start() {
      if (timer || stopped) return
      startTimer = setTimeout(() => {
        refresh()
        timer = setInterval(() => refresh(), refreshMs)
        timer.unref?.()
      }, o.startDelayMs ?? 5_000)
      startTimer.unref?.()
    },
    async stop() {
      stopped = true
      if (startTimer) clearTimeout(startTimer)
      if (timer) clearInterval(timer)
    },
    refresh,
    route,
    map,
  }
}

export { shortAddr }
