// Per-host politeness state: one in-flight request per host, a minimum interval
// of max(2000 ms, Crawl-delay ≤ 60 s) between requests (measured from the end of
// the previous request), and timed backoff after errors / robots failures.

export const MIN_HOST_INTERVAL_MS = 2000
export const ERROR_BACKOFF_MS = 5 * 60_000
export const ERRORS_BEFORE_BACKOFF = 3
/** Crawl-delay is honoured up to this (robots.ts treats > 1 h as disallow-all). */
export const MAX_CRAWL_DELAY_MS = 60_000

export interface HostState {
  host: string
  inFlight: boolean
  /** earliest time (ms epoch) the next request may start */
  nextAt: number
  crawlDelayMs: number
  consecutiveErrors: number
  blockedUntil: number
  blockReason: string | null
  requests: number
}

export class HostTable {
  private map = new Map<string, HostState>()

  get(host: string): HostState {
    let s = this.map.get(host)
    if (!s) {
      s = { host, inFlight: false, nextAt: 0, crawlDelayMs: 0, consecutiveErrors: 0, blockedUntil: 0, blockReason: null, requests: 0 }
      this.map.set(host, s)
    }
    return s
  }

  peek(host: string): HostState | undefined {
    return this.map.get(host)
  }

  intervalMs(host: string): number {
    return Math.max(MIN_HOST_INTERVAL_MS, this.get(host).crawlDelayMs)
  }

  isReady(host: string, now = Date.now()): boolean {
    const s = this.map.get(host)
    if (!s) return true
    return !s.inFlight && now >= s.nextAt && now >= s.blockedUntil
  }

  /** ms epoch when the host can next be used (Infinity while a request is in flight). */
  readyAt(host: string): number {
    const s = this.map.get(host)
    if (!s) return 0
    if (s.inFlight) return Infinity
    return Math.max(s.nextAt, s.blockedUntil)
  }

  isBlocked(host: string, now = Date.now()): boolean {
    const s = this.map.get(host)
    return !!s && now < s.blockedUntil
  }

  /** Atomically claim the host (JS is single-threaded: check + set in one tick). */
  tryAcquire(host: string, now = Date.now()): boolean {
    const s = this.get(host)
    if (s.inFlight || now < s.nextAt || now < s.blockedUntil) return false
    s.inFlight = true
    return true
  }

  /** Release after a request finished; the next request waits at least the host interval. */
  release(host: string, chargeInterval = true): void {
    const s = this.get(host)
    s.inFlight = false
    if (chargeInterval) {
      s.requests++
      s.nextAt = Math.max(s.nextAt, Date.now() + this.intervalMs(host))
    }
  }

  setCrawlDelay(host: string, ms: number): void {
    const s = this.get(host)
    s.crawlDelayMs = Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_CRAWL_DELAY_MS) : 0
  }

  recordSuccess(host: string): void {
    const s = this.get(host)
    s.consecutiveErrors = 0
  }

  /** Returns true when this error tripped a backoff. */
  recordError(host: string, reason: string): boolean {
    const s = this.get(host)
    s.consecutiveErrors++
    if (s.consecutiveErrors >= ERRORS_BEFORE_BACKOFF) {
      s.consecutiveErrors = 0
      this.block(host, ERROR_BACKOFF_MS, `${ERRORS_BEFORE_BACKOFF} consecutive errors (${reason})`)
      return true
    }
    return false
  }

  block(host: string, ms: number, reason: string): void {
    const s = this.get(host)
    s.blockedUntil = Math.max(s.blockedUntil, Date.now() + ms)
    s.blockReason = reason
  }
}
