// Per-chain candidate frontier: a max-heap by score with aging, a cap, and a seen map.
//
// Score = sum of one part per source (block activity, registry, web mentions, links). Repeated finds
// by the same source add to its part up to a per-source cap (PART_CAP), so a program active in every
// sampled block cannot outgrow everything else; independent sources add up, so code that is busy
// on-chain AND verified AND named on the web ranks first.
// Aging: every part halves each halfLife. Because all entries decay at the same rate, ordering by
//     ln(score) + λ·t      (λ = ln2 / halfLife, t = time of the last bump)
// is fixed over time, so the heap never needs re-sorting: a candidate found again is bumped
// (parts decayed to now, the new find added, t = now) and re-pushed; stale heap nodes are skipped by
// version. Over the cap the lowest-ranked 10 % are evicted. A candidate read within ttl (7 days) is
// not queued again; one read longer ago (seen entries are kept seenKeep, 21 days) enters at half
// weight. A read that decided nothing final (verdict 'unverified' or 'error': the source may be
// verified later, the endpoint may have been down) is "soft": it may be read again after softTtl
// (12 h), and a registry find (newly verified) bypasses it at once at full weight. pop() hands a
// candidate out and marks it in flight until markRead() (or inflightMs passes), so two agents on one
// chain never get the same address.

import type { ChainId, FoundVia } from '../../../shared/chain.ts'
import { isSolanaAddress } from '../../../shared/base58.ts'
import { MaxHeap } from '../../ingest/heap.ts'
import { isEvmAddress, toChecksumAddress } from './keccak.ts'
import { isSystemAddress } from './evmblock.ts'

export interface FrontierCandidate {
  chain: ChainId
  address: string
  via: FoundVia
  score: number
  hint?: string
}

export interface FrontierConfig {
  cap: number
  halfLifeMs: number
  ttlMs: number
  /** ttl of a soft read (unverified / error) */
  softTtlMs: number
  seenKeepMs: number
  seenCap: number
  inflightMs: number
  /** cap of each source's part of the score */
  partCap: Record<FoundVia, number>
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

export const PART_CAP: Readonly<Record<FoundVia, number>> = { block: 8, registry: 8, web: 8, link: 12 }

export const DEFAULT_FRONTIER: FrontierConfig = {
  cap: 5000,
  halfLifeMs: 6 * HOUR,
  ttlMs: 7 * DAY,
  softTtlMs: 12 * HOUR,
  seenKeepMs: 21 * DAY,
  // ≥ 7 × the reads a chain can afford per day (Solana ≈ 4–8k, each EVM chain ≈ 5k), so the 7-day
  // rule holds for the busiest addresses (≈ 100 bytes per row)
  seenCap: 60_000,
  inflightMs: 15 * 60_000,
  partCap: { ...PART_CAP },
}

export const VIAS: readonly FoundVia[] = ['block', 'registry', 'web', 'link']

type Parts = Partial<Record<FoundVia, number>>
type Hints = Partial<Record<FoundVia, string>>

interface Entry {
  address: string
  t: number
  parts: Parts
  hints: Hints
  ver: number
}

interface Node {
  k: string
  p: number
  ver: number
}

export type PushResult = 'added' | 'bumped' | 'seen' | 'inflight' | 'invalid' | 'dropped'

/** Serialized frontier: queue rows [address, t, parts, hints] and seen rows [key, lastRead, soft?]. */
export interface FrontierJson {
  q: [string, number, Parts, Hints?][]
  seen: ([string, number] | [string, number, 1])[]
}

/** Verdicts after which an address is worth reading again soon (soft seen mark). */
export const SOFT_VERDICTS: ReadonlySet<string> = new Set(['unverified', 'error'])

const EPOCH = 1_700_000_000_000
const sum = (p: Parts) => (p.block ?? 0) + (p.registry ?? 0) + (p.web ?? 0) + (p.link ?? 0)
/** Source with the largest part (ties: the order of VIAS). */
function topVia(p: Parts): FoundVia {
  let best: FoundVia = 'block'
  let v = -1
  for (const k of VIAS) {
    const x = p[k] ?? 0
    if (x > v) {
      v = x
      best = k
    }
  }
  return best
}
const r3 = (x: number) => Math.round(x * 1000) / 1000

/** Canonical address for `chain` (EVM: EIP-55; Solana: as given) or null when malformed. */
export function normalizeAddress(chain: ChainId, address: unknown): { key: string; display: string } | null {
  if (typeof address !== 'string') return null
  const a = address.trim()
  if (chain === 'solana') return isSolanaAddress(a) ? { key: a, display: a } : null
  if (!isEvmAddress(a)) return null
  const lower = a.toLowerCase()
  if (isSystemAddress(lower)) return null
  return { key: lower, display: toChecksumAddress(lower) }
}

export class ChainFrontier {
  readonly chain: ChainId
  private readonly cfg: FrontierConfig
  private readonly lambda: number
  private map = new Map<string, Entry>()
  private heap = new MaxHeap<Node>((n) => n.p)
  /** key → last read (ms), oldest first */
  private seen = new Map<string, number>()
  /** keys of `seen` whose last read was soft (unverified / error) */
  private soft = new Set<string>()
  private inflight = new Map<string, number>()
  private ver = 0

  constructor(chain: ChainId, cfg: Partial<FrontierConfig> = {}) {
    this.chain = chain
    this.cfg = { ...DEFAULT_FRONTIER, ...cfg, partCap: { ...PART_CAP, ...cfg.partCap } }
    this.lambda = Math.LN2 / this.cfg.halfLifeMs
  }

  get size(): number {
    return this.map.size
  }

  get seenSize(): number {
    return this.seen.size
  }

  get inflightSize(): number {
    return this.inflight.size
  }

  private prio(e: Entry): number {
    return Math.log(Math.max(sum(e.parts), 1e-9)) + this.lambda * (e.t - EPOCH)
  }

  private decay(e: Entry, now: number): number {
    return Math.pow(2, -(now - e.t) / this.cfg.halfLifeMs)
  }

  private candidate(e: Entry, now: number): FrontierCandidate {
    const via = topVia(e.parts)
    const out: FrontierCandidate = { chain: this.chain, address: e.address, via, score: Math.round(sum(e.parts) * this.decay(e, now) * 100) / 100 }
    const hint = e.hints[via]
    if (hint) out.hint = hint
    return out
  }

  /** Read within its ttl (soft reads: softTtl). */
  private fresh(key: string, now: number): boolean {
    const last = this.seen.get(key)
    if (last === undefined) return false
    return now - last < (this.soft.has(key) ? this.cfg.softTtlMs : this.cfg.ttlMs)
  }

  private forget(key: string): void {
    this.seen.delete(key)
    this.soft.delete(key)
  }

  private capSeen(): void {
    while (this.seen.size > this.cfg.seenCap) {
      const first = this.seen.keys().next().value
      if (first === undefined) break
      this.forget(first)
    }
  }

  /** Last read of an address (ms) or null. */
  lastRead(address: string): number | null {
    const n = normalizeAddress(this.chain, address)
    return n ? (this.seen.get(n.key) ?? null) : null
  }

  has(address: string): boolean {
    const n = normalizeAddress(this.chain, address)
    return !!n && this.map.has(n.key)
  }

  push(c: { address: string; via: FoundVia; score: number; hint?: string }, now: number): PushResult {
    const n = normalizeAddress(this.chain, c.address)
    if (!n || !Number.isFinite(c.score) || c.score <= 0 || !VIAS.includes(c.via)) return 'invalid'
    const since = this.inflight.get(n.key)
    if (since !== undefined) {
      if (now - since < this.cfg.inflightMs) return 'inflight'
      this.inflight.delete(n.key)
    }
    let last = this.seen.get(n.key)
    if (last !== undefined && c.via === 'registry' && this.soft.has(n.key)) {
      // read before it was verified (or while an endpoint was down): the registry now lists it
      this.forget(n.key)
      last = undefined
    }
    if (last !== undefined && this.fresh(n.key, now)) return 'seen'
    const cap = this.cfg.partCap[c.via]
    let add = Math.min(c.score, cap)
    if (last !== undefined) add *= 0.5 // read before (more than ttl ago): lower priority than new code
    const hint = typeof c.hint === 'string' && c.hint ? c.hint.slice(0, 160) : undefined
    const cur = this.map.get(n.key)
    if (cur) {
      const f = this.decay(cur, now)
      for (const k of VIAS) if (cur.parts[k] !== undefined) cur.parts[k] = cur.parts[k]! * f
      cur.parts[c.via] = Math.min(cap, (cur.parts[c.via] ?? 0) + add)
      if (hint) cur.hints[c.via] = hint
      cur.t = now
      cur.ver = ++this.ver
      this.heap.push({ k: n.key, p: this.prio(cur), ver: cur.ver })
      this.maybeCompact()
      return 'bumped'
    }
    const e: Entry = { address: n.display, t: now, parts: { [c.via]: add }, hints: hint ? { [c.via]: hint } : {}, ver: ++this.ver }
    this.map.set(n.key, e)
    this.heap.push({ k: n.key, p: this.prio(e), ver: e.ver })
    if (this.map.size > this.cfg.cap) this.evict()
    return this.map.has(n.key) ? 'added' : 'dropped'
  }

  /** Best candidate (removed from the queue, marked in flight), or null. */
  pop(now: number): FrontierCandidate | null {
    for (;;) {
      const node = this.heap.pop()
      if (!node) return null
      const e = this.map.get(node.k)
      if (!e || e.ver !== node.ver) continue
      this.map.delete(node.k)
      if (this.fresh(node.k, now)) continue
      this.inflight.set(node.k, now)
      return this.candidate(e, now)
    }
  }

  /** The address was read: not queued again within ttl (softTtl after an unverified / error verdict). */
  markRead(address: string, now: number, verdict?: string): void {
    const n = normalizeAddress(this.chain, address)
    if (!n) return
    this.inflight.delete(n.key)
    this.map.delete(n.key) // its heap node goes stale
    this.forget(n.key)
    this.seen.set(n.key, now)
    if (verdict && SOFT_VERDICTS.has(verdict)) this.soft.add(n.key)
    this.capSeen()
  }

  /** Release an in-flight mark (a candidate handed back unread). */
  markInflightDone(address: string): void {
    const n = normalizeAddress(this.chain, address)
    if (n) this.inflight.delete(n.key)
  }

  /** Drop old seen rows and expired in-flight marks; compact the heap. */
  prune(now: number): void {
    for (const [k, t] of this.seen) {
      if (now - t <= this.cfg.seenKeepMs) break // insertion order = read order
      this.forget(k)
    }
    for (const [k, t] of this.inflight) if (now - t >= this.cfg.inflightMs) this.inflight.delete(k)
    this.maybeCompact()
  }

  /** Current queue, best first (for tests / inspection). */
  peekAll(now: number): FrontierCandidate[] {
    return [...this.map.values()].sort((a, b) => this.prio(b) - this.prio(a)).map((e) => this.candidate(e, now))
  }

  private evict(): void {
    const keep = Math.floor(this.cfg.cap * 0.9)
    const all = [...this.map.entries()].sort((a, b) => this.prio(a[1]) - this.prio(b[1]))
    for (let i = 0; i < all.length - keep; i++) this.map.delete(all[i][0])
    this.rebuild()
  }

  private maybeCompact(): void {
    if (this.heap.size > 2 * this.map.size + 256) this.rebuild()
  }

  private rebuild(): void {
    this.heap = new MaxHeap<Node>((n) => n.p)
    for (const [k, e] of this.map) this.heap.push({ k, p: this.prio(e), ver: e.ver })
  }

  toJSON(): FrontierJson {
    const q: FrontierJson['q'] = []
    for (const e of this.map.values()) {
      const parts: Parts = {}
      for (const k of VIAS) if (e.parts[k] !== undefined) parts[k] = r3(e.parts[k]!)
      q.push(Object.keys(e.hints).length ? [e.address, e.t, parts, e.hints] : [e.address, e.t, parts])
    }
    return { q, seen: [...this.seen.entries()].map(([k, t]) => (this.soft.has(k) ? [k, t, 1] : [k, t])) }
  }

  /** Restore from toJSON() output; malformed rows are skipped. Returns rows restored. */
  load(j: unknown, now: number): number {
    if (!j || typeof j !== 'object') return 0
    const o = j as Partial<FrontierJson>
    let n = 0
    if (Array.isArray(o.seen)) {
      const rows = (o.seen as unknown[])
        .filter((r): r is [string, number, unknown?] => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'number' && Number.isFinite(r[1]))
        .filter((r) => now - r[1] <= this.cfg.seenKeepMs && r[1] <= now + DAY)
        .sort((a, b) => a[1] - b[1])
      for (const [k, t, soft] of rows) {
        const norm = normalizeAddress(this.chain, k)
        if (!norm) continue
        this.forget(norm.key)
        this.seen.set(norm.key, t)
        if (soft === 1) this.soft.add(norm.key)
      }
      this.capSeen()
    }
    if (Array.isArray(o.q)) {
      for (const r of o.q) {
        if (!Array.isArray(r)) continue
        const [address, t, rawParts, rawHints] = r as unknown[]
        const norm = normalizeAddress(this.chain, address)
        if (!norm || typeof t !== 'number' || !Number.isFinite(t) || !rawParts || typeof rawParts !== 'object') continue
        const parts: Parts = {}
        const hints: Hints = {}
        for (const k of VIAS) {
          const v = (rawParts as Record<string, unknown>)[k]
          if (typeof v === 'number' && v > 0 && Number.isFinite(v)) parts[k] = Math.min(v, this.cfg.partCap[k])
          const h = rawHints && typeof rawHints === 'object' ? (rawHints as Record<string, unknown>)[k] : undefined
          if (typeof h === 'string' && h) hints[k] = h.slice(0, 160)
        }
        if (!(sum(parts) > 0)) continue
        if (this.fresh(norm.key, now)) continue
        this.map.set(norm.key, { address: norm.display, t: Math.min(t, now), parts, hints, ver: ++this.ver })
        n++
      }
      if (this.map.size > this.cfg.cap) this.evict()
      else this.rebuild()
    }
    return n
  }
}
