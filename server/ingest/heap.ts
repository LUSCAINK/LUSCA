// Binary max-heap keyed by a numeric priority. Used for every frontier queue.

export class MaxHeap<T> {
  private a: T[] = []
  private readonly prio: (x: T) => number

  constructor(prio: (x: T) => number) {
    this.prio = prio
  }

  get size(): number {
    return this.a.length
  }

  peek(): T | undefined {
    return this.a[0]
  }

  push(x: T): void {
    this.a.push(x)
    this.up(this.a.length - 1)
  }

  pop(): T | undefined {
    const a = this.a
    if (a.length === 0) return undefined
    const top = a[0]
    const last = a.pop() as T
    if (a.length > 0) {
      a[0] = last
      this.down(0)
    }
    return top
  }

  /**
   * Bounded insert: when the heap already holds `cap` items, the new item replaces
   * the current minimum only if it is better. O(n) scan for the min (leaves only),
   * which is fine for the small per-host caps used by the frontier.
   * Returns the evicted item (or the rejected new item), or null if nothing was dropped.
   */
  pushBounded(x: T, cap: number): { dropped: T | null; inserted: boolean } {
    if (this.a.length < cap) {
      this.push(x)
      return { dropped: null, inserted: true }
    }
    const a = this.a
    // The minimum of a max-heap is always among the leaves: indices floor(n/2)..n-1.
    let mi = -1
    let mv = Infinity
    for (let i = a.length >> 1; i < a.length; i++) {
      const v = this.prio(a[i])
      if (v < mv) {
        mv = v
        mi = i
      }
    }
    if (mi < 0 || this.prio(x) <= mv) return { dropped: x, inserted: false }
    const dropped = a[mi]
    a[mi] = x
    this.up(mi)
    return { dropped, inserted: true }
  }

  values(): readonly T[] {
    return this.a
  }

  private up(i: number): void {
    const a = this.a
    const x = a[i]
    const px = this.prio(x)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.prio(a[p]) >= px) break
      a[i] = a[p]
      i = p
    }
    a[i] = x
  }

  private down(i: number): void {
    const a = this.a
    const n = a.length
    const x = a[i]
    const px = this.prio(x)
    for (;;) {
      const l = 2 * i + 1
      if (l >= n) break
      const r = l + 1
      let c = l
      if (r < n && this.prio(a[r]) > this.prio(a[l])) c = r
      if (this.prio(a[c]) <= px) break
      a[i] = a[c]
      i = c
    }
    a[i] = x
  }
}
