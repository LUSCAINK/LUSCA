// The frontier: per-sector priority queues. Inside each sector, URLs are kept in
// one binary max-heap per host, so a pick can choose the best URL among the
// hosts that are *ready* right now (politeness) in O(#hosts in sector) instead
// of popping and re-pushing a single sector-wide heap past cooling hosts.
import { MaxHeap } from './heap.ts'
import { hash52 } from './util.ts'

export interface QueueEntry {
  url: string // fetch url
  key: string // normalized identity
  host: string
  sector: number
  depth: number
  priority: number
  why: string
  parent: string | null
  seed: boolean
  /** Redirect hops already followed before this entry was (re)queued — caps requeue ping-pong. */
  hops?: number
}

export const PER_HOST_CAP = 400
export const GLOBAL_CAP = 60_000
const SEEN_COMPACT_AT = 1_500_000

export type PushResult = 'ok' | 'seen' | 'queued' | 'host-cap' | 'global-cap'

export class Frontier {
  private sectors: Map<string, MaxHeap<QueueEntry>>[] = []
  private sectorCounts: number[] = []
  private hostCounts = new Map<string, number>()
  private queued = new Set<number>() // hash52(key) of everything currently queued
  private seen = new Set<number>() // hash52(key) of everything ever queued or fetched
  private total = 0
  private readonly onHostChange: (host: string) => void

  constructor(sectorCount: number, onHostChange: (host: string) => void) {
    for (let i = 0; i < sectorCount; i++) {
      this.sectors.push(new Map())
      this.sectorCounts.push(0)
    }
    this.onHostChange = onHostChange
  }

  size(): number {
    return this.total
  }

  sectorSize(s: number): number {
    return this.sectorCounts[s] ?? 0
  }

  hostSize(host: string): number {
    return this.hostCounts.get(host) ?? 0
  }

  queuedHosts(): IterableIterator<string> {
    return this.hostCounts.keys()
  }

  hasSeen(key: string): boolean {
    return this.seen.has(hash52(key))
  }

  markSeen(key: string): void {
    this.seen.add(hash52(key))
    if (this.seen.size > SEEN_COMPACT_AT) this.compactSeen()
  }

  /**
   * Bound memory on very long runs: keep only what is queued right now (plus
   * whatever the caller re-marks, e.g. stored pages). Old fetched-but-not-stored
   * URLs may be re-discovered later, which is harmless.
   */
  private compactSeen(): void {
    this.seen = new Set(this.queued)
  }

  /**
   * Enqueue. `force` (seeds / periodic re-seed) bypasses the seen check but never
   * duplicates an entry that is still queued.
   */
  push(e: QueueEntry, force = false): PushResult {
    const h = hash52(e.key)
    if (this.queued.has(h)) return 'queued'
    if (!force && this.seen.has(h)) return 'seen'
    if (this.total >= GLOBAL_CAP && !force) return 'global-cap'
    const sec = this.sectors[e.sector] ?? this.sectors[0]
    let heap = sec.get(e.host)
    if (!heap) {
      heap = new MaxHeap<QueueEntry>((x) => x.priority)
      sec.set(e.host, heap)
    }
    const hostCount = this.hostCounts.get(e.host) ?? 0
    if (hostCount >= PER_HOST_CAP) {
      // Host is full: replace this sector-heap's worst entry if the new one is better.
      const r = heap.pushBounded(e, Math.max(0, heap.size))
      if (!r.inserted || !r.dropped || r.dropped === e) {
        if (heap.size === 0) sec.delete(e.host)
        return 'host-cap'
      }
      const dh = hash52(r.dropped.key)
      this.queued.delete(dh)
      this.seen.delete(dh) // evicted: allow it to be rediscovered later
      this.queued.add(h)
      this.seen.add(h)
      this.onHostChange(e.host)
      return 'ok'
    }
    heap.push(e)
    this.queued.add(h)
    this.markSeen(e.key)
    this.total++
    this.sectorCounts[e.sector] = (this.sectorCounts[e.sector] ?? 0) + 1
    this.hostCounts.set(e.host, hostCount + 1)
    this.onHostChange(e.host)
    return 'ok'
  }

  private popFrom(sector: number, host: string): QueueEntry | null {
    const sec = this.sectors[sector]
    const heap = sec?.get(host)
    if (!heap) return null
    const e = heap.pop()
    if (heap.size === 0) sec.delete(host)
    if (!e) return null
    this.queued.delete(hash52(e.key))
    this.total--
    this.sectorCounts[sector]--
    const c = (this.hostCounts.get(host) ?? 1) - 1
    if (c <= 0) this.hostCounts.delete(host)
    else this.hostCounts.set(host, c)
    this.onHostChange(host)
    return e
  }

  /** Best (highest-priority) entry in `sector` whose host is ready, popped. */
  pickFrom(sector: number, isReady: (host: string) => boolean): QueueEntry | null {
    const sec = this.sectors[sector]
    if (!sec) return null
    let bestHost: string | null = null
    let bestP = -Infinity
    for (const [host, heap] of sec) {
      const top = heap.peek()
      if (!top || top.priority <= bestP) continue
      if (!isReady(host)) continue
      bestP = top.priority
      bestHost = host
    }
    return bestHost === null ? null : this.popFrom(sector, bestHost)
  }

  /** Best ready entry across all sectors except `exclude` (work stealing). */
  pickAny(exclude: number, isReady: (host: string) => boolean): QueueEntry | null {
    let best: { sector: number; host: string } | null = null
    let bestP = -Infinity
    const readyCache = new Map<string, boolean>()
    for (let s = 0; s < this.sectors.length; s++) {
      if (s === exclude) continue
      for (const [host, heap] of this.sectors[s]) {
        const top = heap.peek()
        if (!top || top.priority <= bestP) continue
        let r = readyCache.get(host)
        if (r === undefined) {
          r = isReady(host)
          readyCache.set(host, r)
        }
        if (!r) continue
        bestP = top.priority
        best = { sector: s, host }
      }
    }
    return best ? this.popFrom(best.sector, best.host) : null
  }

  /**
   * Remove every queued entry matching `pred` (e.g. hosts that were just
   * denylisted). Removed URLs stay "seen", so they are not rediscovered. O(queued).
   * Returns the number removed.
   */
  dropWhere(pred: (e: QueueEntry) => boolean): number {
    let dropped = 0
    const touched = new Set<string>()
    for (let s = 0; s < this.sectors.length; s++) {
      const sec = this.sectors[s]
      for (const [host, heap] of [...sec]) {
        const all = heap.values()
        if (!all.some(pred)) continue
        const keep: QueueEntry[] = []
        for (const e of all) {
          if (pred(e)) {
            this.queued.delete(hash52(e.key))
            dropped++
            this.total--
            this.sectorCounts[s]--
            const c = (this.hostCounts.get(host) ?? 1) - 1
            if (c <= 0) this.hostCounts.delete(host)
            else this.hostCounts.set(host, c)
            touched.add(host)
          } else keep.push(e)
        }
        if (keep.length === 0) {
          sec.delete(host)
          continue
        }
        const next = new MaxHeap<QueueEntry>((x) => x.priority)
        for (const e of keep) next.push(e)
        sec.set(host, next)
      }
    }
    for (const h of touched) this.onHostChange(h)
    return dropped
  }

  /** The queued host that becomes ready soonest. */
  nextReady(readyAt: (host: string) => number): { host: string; at: number } | null {
    let best: { host: string; at: number } | null = null
    for (const host of this.hostCounts.keys()) {
      const at = readyAt(host)
      if (!best || at < best.at) best = { host, at }
    }
    return best
  }
}
