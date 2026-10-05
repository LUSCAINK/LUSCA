// Small, dependency-free helpers shared by the crawler modules.
import { createHash } from 'node:crypto'

/** Page site owners land on from the user-agent string (env LUSCA_BOT_URL overrides). */
export const DEFAULT_BOT_URL = 'https://lusca.ink/docs/ethics'

/**
 * Header-safe text for the UA comment: printable ASCII only (fetch throws on header
 * values outside latin-1, and control chars would split the header), without
 * ( ) ; " \ which would break the comment structure.
 */
function uaText(s: string | undefined): string {
  return (s ?? '').replace(/[^\x20-\x7e]|[()";\\]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * "LuscaBot/0.1 (+<url>; <contact or 'data agent'>; respects robots.txt)".
 * A url that is not http(s) falls back to DEFAULT_BOT_URL.
 */
export function buildUserAgent(botUrl?: string, contact?: string): string {
  let url = uaText(botUrl)
  if (!/^https?:\/\/\S+$/i.test(url)) url = DEFAULT_BOT_URL
  const c = uaText(contact).slice(0, 120)
  return `LuscaBot/0.1 (+${url}; ${c || 'data agent'}; respects robots.txt)`
}

/**
 * Value for the `From:` request header, which RFC 9110 §10.1.2 defines as a mailbox:
 * the contact when it is an e-mail address ("mailto:" prefix allowed), else null
 * (a URL contact still appears in the user-agent comment).
 */
export function fromHeaderFor(contact?: string): string | null {
  const c = uaText(contact).replace(/^mailto:/i, '')
  return /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(c) && c.length <= 254 ? c : null
}

/** env LUSCA_BOT_CONTACT: takedown / abuse contact (e-mail or URL) shown in the UA; '' = none. */
export const BOT_CONTACT = uaText(process.env.LUSCA_BOT_CONTACT)
export const USER_AGENT = buildUserAgent(process.env.LUSCA_BOT_URL, BOT_CONTACT)
/** `From:` header sent with every crawler request when LUSCA_BOT_CONTACT is an e-mail address. */
export const BOT_FROM = fromHeaderFor(BOT_CONTACT)

/** Identification headers for every request LuscaBot sends (robots.txt and pages). */
export function botHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': USER_AGENT }
  if (BOT_FROM) h.From = BOT_FROM
  return { ...h, ...extra }
}

/** Token robots.txt groups are matched against (robots-parser lowercases + strips "/version"). */
export const ROBOTS_UA = 'LuscaBot'
/**
 * Agents of AI-training crawlers whose robots.txt opt-outs also bind LuscaBot (its
 * pages train SEPIA). robots.txt group names are matched case-insensitively.
 */
export const AI_TRAINING_UAS = [
  'GPTBot',
  'CCBot',
  'Google-Extended',
  'ClaudeBot',
  'anthropic-ai',
  'Applebot-Extended',
  'meta-externalagent',
  'Bytespider',
  'PerplexityBot',
  'cohere-ai',
  'Amazonbot',
]
/** Largest delay setTimeout honours. */
export const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Promise-based sleep that resolves early (never rejects) when `signal` aborts,
 * so a stopping crawler never waits out a long politeness pause.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0) || signal?.aborted) return Promise.resolve()
  // setTimeout turns anything above 2^31-1 ms into a 1 ms timer (TimeoutOverflowWarning).
  ms = Math.min(ms, MAX_TIMER_MS)
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/** 1234567 → "1,234,567" */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

export function fmtKB(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

/**
 * A private copy of `s` that no longer pins a larger parent string.
 *
 * V8 represents substrings (slice, trim, regex captures, JSON.parse values,
 * readline lines, node-html-parser text) as views that keep the whole parent
 * alive, and template literals as trees referencing their parts. Kept
 * long-term, a 420-char excerpt pins the full 60k-char page text and a title
 * can pin a 300 KB HTML document — measured at ~35 KB of retained heap per
 * crawled page before this was applied to everything the crawler keeps
 * (records, the title index, trace rings).
 *
 * Concatenating forces a flat copy of the characters; slicing that copy back
 * yields a string whose only parent is the n+1-char copy.
 */
export function own(s: string): string {
  return s.length === 0 ? '' : (' ' + s).slice(1)
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + '…'
}

/** "https://docs.chain.link/vrf/v2-5?x=1" → "docs.chain.link/vrf/v2-5?x=1" (for human traces). */
export function shortUrl(url: string, n = 72): string {
  let s = url.replace(/^https?:\/\//i, '')
  if (s.endsWith('/')) s = s.slice(0, -1)
  return truncate(s, n)
}

export function sha1hex(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

/** Stable page id: first 16 hex chars of sha1(normalized url). */
export function pageIdFor(normalizedUrl: string): string {
  return sha1hex(normalizedUrl).slice(0, 16)
}

/**
 * 52-bit numeric hash of a string (two FNV-1a lanes). Used for the "seen" set so
 * it stores numbers instead of full URL strings (≈5x less memory). Collision odds
 * at 1M urls are ~1e-4, which is acceptable for a crawl frontier.
 */
export function hash52(s: string): number {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a ^= c
    a = Math.imul(a, 0x01000193)
    b ^= c
    b = Math.imul(b, 0x01000193) ^ (b >>> 13)
  }
  return (b >>> 12) * 0x100000000 + (a >>> 0)
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** Fixed-capacity ring buffer; `newest(n)` returns newest-first. */
export class Ring<T> {
  private buf: (T | undefined)[]
  private head = 0
  private len = 0
  readonly cap: number
  constructor(cap: number) {
    this.cap = cap
    this.buf = new Array(cap)
  }
  push(x: T): void {
    this.buf[this.head] = x
    this.head = (this.head + 1) % this.cap
    if (this.len < this.cap) this.len++
  }
  get size(): number {
    return this.len
  }
  newest(n: number): T[] {
    const out: T[] = []
    const k = Math.min(Math.max(0, Math.floor(n)), this.len)
    for (let i = 1; i <= k; i++) {
      out.push(this.buf[(this.head - i + this.cap) % this.cap] as T)
    }
    return out
  }
}
