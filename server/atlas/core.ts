// CODE ATLAS core: features → MinHash → nearest neighbours → clusters + labels → deterministic 2D layout.
// Pure functions (no I/O), so the layout is reproducible from the same reads and the same previous positions.
import type { ChainId, ChainRead } from '../../shared/chain.ts'

export const MINHASH_K = 64

/** Feature tokens of one read: ABI function / event names (EVM), IDL instruction / account names (Solana), shape tokens. */
export function featuresOf(read: Pick<ChainRead, 'chain' | 'kind' | 'abi' | 'idl' | 'proxy' | 'loader' | 'upgradeable' | 'sources'> & Partial<Pick<ChainRead, 'programBytes' | 'securityTxt'>>): string[] {
  const out = new Set<string>()
  const nameOf = (s: string) => s.split('(')[0].trim()
  for (const f of read.abi?.functions ?? []) { const n = nameOf(f); if (n) out.add(`fn:${n}`) }
  for (const e of read.abi?.events ?? []) { const n = nameOf(e); if (n) out.add(`ev:${n}`) }
  for (const ix of read.idl?.instructions ?? []) if (ix?.name) out.add(`ix:${ix.name}`)
  for (const a of read.idl?.accounts ?? []) if (a) out.add(`acct:${a}`)
  if (read.proxy) out.add(`proxy:${read.proxy.standard}`)
  if (read.chain === 'solana') {
    out.add(read.idl ? 'sol:idl' : 'sol:no-idl')
    if (read.loader) out.add(`loader:${read.loader}`)
    if (read.upgradeable != null) out.add(read.upgradeable ? 'sol:upgradeable' : 'sol:immutable')
    if (read.securityTxt) out.add('sol:security.txt')
    // programs without an IDL: size band (half-octaves) keeps builds of one codebase together
    if (!read.idl && read.programBytes && read.programBytes > 0) out.add(`size:${Math.round(Math.log2(read.programBytes) * 2)}`)
  }
  // source file stems (OtterSec-verified programs without an IDL still share crate layouts)
  for (const s of read.sources ?? []) {
    const stem = (s.path.split('/').pop() ?? '').replace(/\.[a-z]+$/i, '')
    if (stem && stem.length > 2 && !/^(lib|mod|main|index)$/i.test(stem)) out.add(`file:${stem}`)
  }
  if (out.size === 0) out.add(`kind:${read.kind}`)
  return [...out].sort()
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}
function mix(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  return (x ^ (x >>> 16)) >>> 0
}
const SEEDS = Array.from({ length: MINHASH_K }, (_, i) => mix(0x9e3779b9 + i * 0x632be5ab))

export function minhash(tokens: string[]): Uint32Array {
  const sig = new Uint32Array(MINHASH_K).fill(0xffffffff)
  for (const t of tokens) {
    const h = fnv1a(t)
    for (let i = 0; i < MINHASH_K; i++) { const v = mix(h ^ SEEDS[i]); if (v < sig[i]) sig[i] = v }
  }
  return sig
}

export function minhashSim(a: Uint32Array, b: Uint32Array): number {
  let m = 0
  for (let i = 0; i < MINHASH_K; i++) if (a[i] === b[i]) m++
  return m / MINHASH_K
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1
  const sa = new Set(a)
  let inter = 0
  for (const t of b) if (sa.has(t)) inter++
  return inter / (a.length + b.length - inter)
}

export interface AtlasNode { key: string; chain: ChainId; address: string; name: string | null; tokens: string[]; sig: Uint32Array; verifiedBy: 'osec' | 'sourcify' | null; firstSeen: number }
export interface Edge { j: number; w: number }

/** k nearest neighbours of every node: MinHash candidates, re-ranked by exact Jaccard. */
export function knn(nodes: AtlasNode[], k = 10, candidates = 24): Edge[][] {
  const n = nodes.length
  const out: Edge[][] = []
  for (let i = 0; i < n; i++) out.push(nearest(nodes, i, k, candidates))
  return out
}

/** Nearest neighbours of node i among nodes (all others). */
export function nearest(nodes: AtlasNode[], i: number, k = 10, candidates = 24, sig = nodes[i].sig, tokens = nodes[i].tokens): Edge[] {
  const n = nodes.length
  const top: Edge[] = [] // ascending by w, length ≤ candidates
  for (let j = 0; j < n; j++) {
    if (j === i) continue
    const w = minhashSim(sig, nodes[j].sig)
    if (w <= 0) continue
    if (top.length < candidates) { top.push({ j, w }); if (top.length === candidates) top.sort((a, b) => a.w - b.w || b.j - a.j) }
    else if (w > top[0].w) { top[0] = { j, w }; top.sort((a, b) => a.w - b.w || b.j - a.j) }
  }
  return top
    .map((e) => ({ j: e.j, w: jaccard(tokens, nodes[e.j].tokens) }))
    .filter((e) => e.w > 0)
    .sort((a, b) => b.w - a.w || a.j - b.j)
    .slice(0, k)
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Weighted label propagation on the kNN graph, fixed order → cluster id per node (-1: too small to name). */
export function clusters(edges: Edge[][], minSize = 4, rounds = 20): number[] {
  const n = edges.length
  const label = Array.from({ length: n }, (_, i) => i)
  for (let r = 0; r < rounds; r++) {
    let changed = 0
    for (let i = 0; i < n; i++) {
      const score = new Map<number, number>()
      score.set(label[i], 0.5) // a little inertia keeps it stable
      for (const e of edges[i]) if (e.w >= 0.2) score.set(label[e.j], (score.get(label[e.j]) ?? 0) + e.w)
      let best = label[i], bestS = -1
      for (const [l, s] of score) if (s > bestS || (s === bestS && l < best)) { best = l; bestS = s }
      if (best !== label[i]) { label[i] = best; changed++ }
    }
    if (!changed) break
  }
  const size = new Map<number, number>()
  for (const l of label) size.set(l, (size.get(l) ?? 0) + 1)
  // renumber big clusters by size (desc), then first index
  const big = [...size.entries()].filter(([, s]) => s >= minSize).sort((a, b) => b[1] - a[1] || a[0] - b[0])
  const id = new Map(big.map(([l], i) => [l, i]))
  return label.map((l) => id.get(l) ?? -1)
}

const SIGNATURES: { label: string; all: string[] }[] = [
  { label: 'ERC-4337 account', all: ['fn:validateUserOp'] },
  { label: 'ERC-4337 paymaster', all: ['fn:validatePaymasterUserOp'] },
  { label: 'Safe multisig', all: ['fn:execTransaction', 'fn:getOwners'] },
  { label: 'Uniswap V3 pool', all: ['fn:slot0', 'fn:swap', 'fn:flash'] },
  { label: 'Uniswap V2 pair', all: ['fn:getReserves', 'fn:swap', 'fn:skim'] },
  { label: 'DEX router', all: ['fn:swapExactTokensForTokens'] },
  { label: 'ERC-4626 vault', all: ['fn:convertToAssets', 'fn:previewDeposit'] },
  { label: 'ERC-1155', all: ['fn:balanceOfBatch', 'fn:safeBatchTransferFrom'] },
  { label: 'ERC-721', all: ['fn:ownerOf', 'fn:safeTransferFrom'] },
  { label: 'ERC-20', all: ['fn:transfer', 'fn:approve', 'fn:allowance', 'fn:balanceOf'] },
  { label: 'proxy', all: ['fn:upgradeToAndCall'] },
  { label: 'proxy', all: ['proxy:eip1967'] },
  { label: 'minimal proxy', all: ['proxy:eip1167'] },
  { label: 'beacon proxy', all: ['proxy:beacon'] },
]

const display = (t: string) => t.slice(t.indexOf(':') + 1)

/** Names of every cluster: a known interface when most members carry it, plus the most distinctive shared names. */
export function labelClusters(nodes: AtlasNode[], cl: number[]): string[] {
  const n = nodes.length
  const df = new Map<string, number>()
  for (const nd of nodes) for (const t of nd.tokens) df.set(t, (df.get(t) ?? 0) + 1)
  const count = cl.reduce((m, c) => Math.max(m, c + 1), 0)
  const members: number[][] = Array.from({ length: count }, () => [])
  cl.forEach((c, i) => { if (c >= 0) members[c].push(i) })
  return members.map((ms) => {
    const sets = ms.map((i) => new Set(nodes[i].tokens))
    const has = (t: string) => sets.reduce((s, x) => s + (x.has(t) ? 1 : 0), 0)
    const sig = SIGNATURES.find((s) => sets.filter((x) => s.all.every((t) => x.has(t))).length >= ms.length * 0.5)
    const sol = ms.filter((i) => nodes[i].chain === 'solana').length >= ms.length * 0.5
    let head = sig?.label ?? null
    if (!head && sol) {
      const noIdl = has('sol:no-idl') >= ms.length * 0.5
      if (noIdl) {
        const imm = has('sol:immutable') >= ms.length * 0.5
        const sizes = ms.map((i) => nodes[i].tokens.find((t) => t.startsWith('size:'))).filter((t): t is string => !!t).map((t) => Number(t.slice(5))).sort((a, b) => a - b)
        const kb = sizes.length >= ms.length * 0.5 ? Math.round(2 ** (sizes[sizes.length >> 1] / 2) / 1024) : 0
        head = `Solana · no IDL${imm ? ' · immutable' : ''}${kb ? ` · ~${kb} KB` : ''}`
      }
    }
    const local = new Map<string, number>()
    for (const x of sets) for (const t of x) if (/^(fn|ix|ev):/.test(t)) local.set(t, (local.get(t) ?? 0) + 1)
    const skip = new Set(sig?.all ?? [])
    const ranked = [...local.entries()]
      .filter(([t, c]) => c >= ms.length * 0.4 && !skip.has(t))
      .map(([t, c]) => ({ t, s: (c / ms.length) * Math.log((n + 1) / (df.get(t) ?? 1)) * (t.startsWith('ev:') ? 0.6 : 1) }))
      .sort((a, b) => b.s - a.s || (a.t < b.t ? -1 : 1))
    const names: string[] = []
    for (const r of ranked) {
      const d = display(r.t)
      if (d.length > 22 || names.some((x) => x.toLowerCase() === d.toLowerCase())) continue
      names.push(d)
      if (names.length >= (head ? 1 : 2)) break
    }
    const pre = !head && sol ? 'Solana · ' : ''
    if (head) return names.length ? `${head} · ${names[0]}` : head
    return names.length ? pre + names.join(' · ') : sol ? 'Solana programs' : 'mixed'
  })
}

/**
 * Force-directed layout on the kNN graph: springs along edges (weighted by similarity), short-range repulsion on a
 * grid, weak gravity. Fixed seed; nodes with a previous position start there, new nodes start next to their nearest
 * placed neighbour, so a re-layout moves dots only a little.
 */
export function layout(nodes: AtlasNode[], edges: Edge[][], prev: Map<string, [number, number]>, iterations?: number, seed = 0x1a5ca): Float64Array {
  const n = nodes.length
  const pos = new Float64Array(n * 2)
  const rand = rng(seed)
  const placed = new Uint8Array(n)
  let warm = 0
  for (let i = 0; i < n; i++) {
    const p = prev.get(nodes[i].key)
    if (p) { pos[2 * i] = p[0]; pos[2 * i + 1] = p[1]; placed[i] = 1; warm++ }
  }
  const R0 = Math.sqrt(n) * 1.1 + 4
  // cold start: a random projection of the IDF-weighted feature set (seeded per token) — similar sets land close,
  // unrelated ones spread as an organic cloud instead of a lattice
  const df = new Map<string, number>()
  for (const nd of nodes) for (const t of nd.tokens) df.set(t, (df.get(t) ?? 0) + 1)
  const gauss = (t: string): [number, number] => {
    const r = rng(fnv1a(t))
    const u = Math.max(1e-9, r()), v = r()
    const m = Math.sqrt(-2 * Math.log(u))
    return [m * Math.cos(2 * Math.PI * v), m * Math.sin(2 * Math.PI * v)]
  }
  const proj = (nd: AtlasNode): [number, number] => {
    let x = 0, y = 0, norm = 0
    for (const t of nd.tokens) {
      const w = Math.log((n + 1) / (df.get(t) ?? 1)) + 0.05
      const [gx, gy] = gauss(t)
      x += gx * w; y += gy * w; norm += w * w
    }
    const k = norm > 0 ? R0 / 2.6 / Math.sqrt(norm) : 0
    return [x * k, y * k]
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      if (placed[i]) continue
      const e = warm ? edges[i].find((x) => placed[x.j]) : undefined
      const a = rand() * Math.PI * 2
      if (e) {
        const r = 0.4 + rand() * 0.6
        pos[2 * i] = pos[2 * e.j] + Math.cos(a) * r
        pos[2 * i + 1] = pos[2 * e.j + 1] + Math.sin(a) * r
        placed[i] = 1
      } else if (pass === 1 || !warm) {
        const [x, y] = proj(nodes[i])
        pos[2 * i] = x + Math.cos(a) * 0.3
        pos[2 * i + 1] = y + Math.sin(a) * 0.3
        placed[i] = 1
      }
    }
  }
  const iters = iterations ?? (warm > n * 0.8 ? 50 : 160)
  const disp = new Float64Array(n * 2)
  const cell = 1.0 // repulsion radius
  for (let it = 0; it < iters; it++) {
    const temp = (warm > n * 0.8 ? 0.2 : 0.6) * (1 - it / iters) + 0.02
    disp.fill(0)
    // springs
    for (let i = 0; i < n; i++) {
      for (const e of edges[i]) {
        const j = e.j
        const dx = pos[2 * j] - pos[2 * i], dy = pos[2 * j + 1] - pos[2 * i + 1]
        const d = Math.hypot(dx, dy) + 1e-9
        const rest = 0.5 + (1 - e.w) * 3
        const f = 0.08 * e.w * (d - rest) / d
        disp[2 * i] += dx * f; disp[2 * i + 1] += dy * f
        disp[2 * j] -= dx * f * 0.5; disp[2 * j + 1] -= dy * f * 0.5
      }
    }
    // repulsion on a grid
    const grid = new Map<string, number[]>()
    for (let i = 0; i < n; i++) {
      const k = `${Math.floor(pos[2 * i] / cell)},${Math.floor(pos[2 * i + 1] / cell)}`
      const g = grid.get(k); if (g) g.push(i); else grid.set(k, [i])
    }
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(pos[2 * i] / cell), cy = Math.floor(pos[2 * i + 1] / cell)
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        const g = grid.get(`${cx + ox},${cy + oy}`)
        if (!g) continue
        for (const j of g) {
          if (j <= i) continue
          let dx = pos[2 * i] - pos[2 * j], dy = pos[2 * i + 1] - pos[2 * j + 1]
          let d = Math.hypot(dx, dy)
          if (d >= cell) continue
          if (d < 1e-6) { const a = ((i * 7919 + j * 104729) % 6283) / 1000; dx = Math.cos(a) * 1e-3; dy = Math.sin(a) * 1e-3; d = 1e-3 }
          const f = 0.3 * (cell - d) / cell / d
          disp[2 * i] += dx * f; disp[2 * i + 1] += dy * f
          disp[2 * j] -= dx * f; disp[2 * j + 1] -= dy * f
        }
      }
    }
    // gravity + capped step
    for (let i = 0; i < n; i++) {
      disp[2 * i] -= pos[2 * i] * 0.002
      disp[2 * i + 1] -= pos[2 * i + 1] * 0.002
      const dx = disp[2 * i], dy = disp[2 * i + 1]
      const d = Math.hypot(dx, dy)
      const s = d > temp ? temp / d : 1
      pos[2 * i] += dx * s; pos[2 * i + 1] += dy * s
    }
  }
  return pos
}

export interface Frame { cx: number; cy: number; span: number }

/** The quantization frame of a layout: bounds' centre and a uniform span (robust to a few outliers). */
export function frameOf(pos: Float64Array): Frame {
  const n = pos.length / 2
  if (!n) return { cx: 0, cy: 0, span: 1 }
  const xs = Array.from({ length: n }, (_, i) => pos[2 * i]).sort((a, b) => a - b)
  const ys = Array.from({ length: n }, (_, i) => pos[2 * i + 1]).sort((a, b) => a - b)
  const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))]
  const x0 = q(xs, 0.005), x1 = q(xs, 0.995), y0 = q(ys, 0.005), y1 = q(ys, 0.995)
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, span: Math.max(x1 - x0, y1 - y0, 1e-6) * 1.08 }
}

/** Quantize positions to 0..Q in a frame (kept between full builds so new dots never rescale the map). */
export function quantize(pos: Float64Array, frame: Frame = frameOf(pos), Q = 10000): { x: number[]; y: number[] } {
  const n = pos.length / 2
  const x: number[] = [], y: number[] = []
  for (let i = 0; i < n; i++) {
    x.push(Math.max(0, Math.min(Q, Math.round(Q / 2 + ((pos[2 * i] - frame.cx) / frame.span) * Q))))
    y.push(Math.max(0, Math.min(Q, Math.round(Q / 2 + ((pos[2 * i + 1] - frame.cy) / frame.span) * Q))))
  }
  return { x, y }
}
