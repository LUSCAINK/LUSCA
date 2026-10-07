// Chain agents on the client: REST helpers for /api/chain/* and a small store fed by the
// WebSocket { t: 'chain', event } stream (hooked in src/lib/live.ts, like payouts).
//
// Real data only. Everything here comes from what the server has stored; nothing is read
// from a chain by the browser. Until the server answers, stats are null and the UI shows "—".
import { useEffect } from 'react'
import { create } from 'zustand'
import type { ChainEvent, ChainId, ChainIndexItem, ChainRead, ChainStats, FoundVia, ReadKind, Verdict } from '@shared/chain'
import { fmtAgo } from './format'
import { useLive } from './store'
import { NAV_N } from '@/lib/nav'

// ─── vocabulary ─────────────────────────────────────────────────────────────

export const CHAINS: readonly ChainId[] = ['solana', 'ethereum', 'base', 'arbitrum']

export const CHAIN_LABEL: Record<ChainId, string> = {
  solana: 'Solana',
  ethereum: 'Ethereum',
  base: 'Base',
  arbitrum: 'Arbitrum',
}

export const CHAIN_SHORT: Record<ChainId, string> = {
  solana: 'SOL',
  ethereum: 'ETH',
  base: 'BASE',
  arbitrum: 'ARB',
}

export function isChainId(v: unknown): v is ChainId {
  return typeof v === 'string' && (CHAINS as readonly string[]).includes(v)
}

export const chainLabel = (c: string) => (isChainId(c) ? CHAIN_LABEL[c] : c ? c.charAt(0).toUpperCase() + c.slice(1) : '—')

export const VERDICT_LABEL: Record<Verdict, string> = {
  kept: 'kept',
  duplicate: 'duplicate',
  boilerplate: 'boilerplate',
  unverified: 'unverified',
  'token-mint': 'token mint',
  'not-code': 'not code',
  error: 'error',
}

/** What each verdict means, in one line (feed legend, tooltips). */
export const VERDICT_TEXT: Record<Verdict, string> = {
  kept: 'Verified source or an on-chain IDL, not seen before, not a template. Stored as training data.',
  duplicate: 'Same bytecode or the same source as something already kept.',
  boilerplate:
    'Library or template code with little custom code: token and NFT templates, standard proxies. A proxy’s implementation is read separately.',
  unverified: 'No published source and no on-chain IDL. Only counted; read again later in case the source gets verified.',
  'token-mint': 'A Solana token mint: token supply, decimals and authorities, not a program.',
  'not-code': 'An ordinary account, a closed program, or an address with no code.',
  error: 'The read failed (an endpoint did not answer, or the answer was unusable). Not a judgement of the address; it is read again later.',
}

export const VERDICTS: readonly Verdict[] = ['kept', 'duplicate', 'boilerplate', 'unverified', 'token-mint', 'not-code', 'error']

export const VIA_LABEL: Record<FoundVia, string> = {
  block: 'block',
  registry: 'registry',
  web: 'web',
  link: 'link',
  lens: 'lens',
}

/** How an address was found: the agents' four ways in, plus a Lens read that passed the same rules. */
export const VIA_TEXT: Record<FoundVia, string> = {
  block: 'Called in a recent block',
  registry: 'Listed as verified: Sourcify (newest first) or the OtterSec verified-programs registry',
  web: 'Mentioned on a page the web agents kept',
  link: 'Linked from another contract (proxy to implementation)',
  lens: 'Read on request with LUSCA Lens, kept under the same rules as an agent read',
}

export const VIAS: readonly FoundVia[] = ['block', 'registry', 'web', 'link']

export const KIND_LABEL: Record<ReadKind, string> = {
  program: 'program',
  contract: 'contract',
  'token-mint': 'token mint',
  account: 'account',
  empty: 'no code',
}

export function verifiedLabel(by: 'osec' | 'sourcify' | null | undefined, match?: 'full' | 'partial' | null): string {
  if (by === 'osec') return 'OtterSec verified build'
  if (by === 'sourcify') return match === 'full' ? 'Sourcify full match' : match === 'partial' ? 'Sourcify partial match' : 'Sourcify'
  return '—'
}

export const verifiedShort = (by: 'osec' | 'sourcify' | null | undefined) => (by === 'osec' ? 'OtterSec' : by === 'sourcify' ? 'Sourcify' : '—')

/** "1 file" / "3 files". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** Keys the server adds to ChainStats.frontier next to the per-chain queue sizes (pauses the page explains). */
export const STORE_FULL_KEY = 'storeFull'
export const UNAVAILABLE_PREFIX = 'unavailable.'

/** An agent between two reads is pacing itself to the daily budget, not out of work. */
export const PACED_WINDOW_MS = 15 * 60_000

/** Position of /chain in the primary navigation (src/components/shell/Shell.tsx NAV). */
export const CHAIN_NAV_N = NAV_N.chain

// ─── time ───────────────────────────────────────────────────────────────────

/** "12s ago" / "just now" / "—". */
export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—'
  const a = fmtAgo(ts, now)
  return a === 'now' ? 'just now' : `${a} ago`
}

const p2 = (n: number) => String(n).padStart(2, '0')

/** "2026-10-05 21:43:10 UTC" / "—". */
export function fmtUtc(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`
}

/** "10-05 21:43" (UTC), compact for tables. */
export function fmtUtcShort(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  return `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
}

// ─── addresses & explorers ──────────────────────────────────────────────────

const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM_RE = /^0x[0-9a-fA-F]{40}$/

export function validAddress(chain: ChainId, address: string): boolean {
  return chain === 'solana' ? SOL_RE.test(address) : EVM_RE.test(address)
}

/** "So1a…xyz9" / "0x12ab…cd34". */
export function shortAddress(a: string | null | undefined, head = 4, tail = 4): string {
  if (!a) return '—'
  const h = a.startsWith('0x') ? head + 2 : head
  return a.length > h + tail + 1 ? `${a.slice(0, h)}…${a.slice(-tail)}` : a
}

const EXPLORER: Record<ChainId, { name: string; base: string; account: string; block: string }> = {
  solana: { name: 'Solscan', base: 'https://solscan.io', account: '/account/', block: '/block/' },
  ethereum: { name: 'Etherscan', base: 'https://etherscan.io', account: '/address/', block: '/block/' },
  base: { name: 'Basescan', base: 'https://basescan.org', account: '/address/', block: '/block/' },
  arbitrum: { name: 'Arbiscan', base: 'https://arbiscan.io', account: '/address/', block: '/block/' },
}

export const explorerName = (c: ChainId) => EXPLORER[c].name

/** Explorer link for a valid address on its chain, else null. */
export function explorerUrl(chain: ChainId, address: string): string | null {
  if (!validAddress(chain, address)) return null
  const e = EXPLORER[chain]
  return `${e.base}${e.account}${address}`
}

export function explorerBlockUrl(chain: ChainId, n: number | null): string | null {
  if (n == null || !Number.isSafeInteger(n) || n < 0) return null
  const e = EXPLORER[chain]
  return `${e.base}${e.block}${n}`
}

/** In-site detail route for an indexed address. */
export const itemPath = (chain: ChainId, address: string) => `/chain/${chain}/${encodeURIComponent(address)}`

// ─── REST ───────────────────────────────────────────────────────────────────

/** 'unavailable': the server answers but does not serve this (404 / 501 / 503 / not JSON). 'unreachable': no answer. */
export type ChainLoadError = 'unavailable' | 'unreachable'

export class ChainHttpError extends Error {
  readonly status: number
  readonly retryAfterMs: number | null
  constructor(status: number, retryAfterMs: number | null = null) {
    super(`HTTP ${status}`)
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export function classifyError(e: unknown): ChainLoadError {
  return e instanceof ChainHttpError && (e.status === 404 || e.status === 501 || e.status === 503) ? 'unavailable' : 'unreachable'
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal })
  if (!res.ok) {
    const ra = Number(res.headers.get('retry-after'))
    throw new ChainHttpError(res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null)
  }
  try {
    return await res.json()
  } catch {
    throw new ChainHttpError(404) // an HTML fallback page: the route is not served here
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function isStats(v: unknown): v is ChainStats {
  return isObj(v) && Array.isArray(v.agents) && typeof v.reads === 'number' && typeof v.kept === 'number'
}

function isEvent(v: unknown): v is ChainEvent {
  return (
    isObj(v) &&
    typeof v.id === 'string' &&
    typeof v.ts === 'number' &&
    typeof v.agent === 'string' &&
    isChainId(v.chain) &&
    typeof v.address === 'string' &&
    typeof v.verdict === 'string'
  )
}

function isItem(v: unknown): v is ChainIndexItem {
  return isObj(v) && isChainId(v.chain) && typeof v.address === 'string'
}

export async function fetchChainStats(signal?: AbortSignal): Promise<ChainStats> {
  const body = await getJson('/api/chain/stats', signal)
  if (!isStats(body)) throw new ChainHttpError(404)
  return body
}

export async function fetchChainFeed(limit = 200, signal?: AbortSignal): Promise<ChainEvent[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit)))
  const body = await getJson(`/api/chain/feed?limit=${n}`, signal)
  if (!Array.isArray(body)) throw new ChainHttpError(404)
  return body.filter(isEvent)
}

export interface ItemsPage {
  items: ChainIndexItem[]
  next: string | null
}

export async function fetchChainItems(q: { chain?: ChainId | null; limit?: number; cursor?: string | null }, signal?: AbortSignal): Promise<ItemsPage> {
  const p = new URLSearchParams()
  if (q.chain) p.set('chain', q.chain)
  p.set('limit', String(Math.max(1, Math.min(200, Math.floor(q.limit ?? 50)))))
  if (q.cursor) p.set('cursor', q.cursor)
  const body = await getJson(`/api/chain/items?${p.toString()}`, signal)
  if (!isObj(body) || !Array.isArray(body.items)) throw new ChainHttpError(404)
  return { items: body.items.filter(isItem), next: typeof body.next === 'string' && body.next ? body.next : null }
}

/** One stored item and its read. null = not in the kept index (404). */
export async function fetchChainItem(chain: ChainId, address: string, signal?: AbortSignal): Promise<{ item: ChainIndexItem; read: ChainRead } | null> {
  let body: unknown
  try {
    body = await getJson(`/api/chain/item/${chain}/${encodeURIComponent(address)}`, signal)
  } catch (e) {
    if (e instanceof ChainHttpError && e.status === 404) return null
    throw e
  }
  if (!isObj(body) || !isItem(body.item) || !isObj(body.read)) return null
  return body as unknown as { item: ChainIndexItem; read: ChainRead }
}

// ─── store ──────────────────────────────────────────────────────────────────

const CAP_FEED = 200

export interface ChainState {
  stats: ChainStats | null
  statsAt: number | null
  statsError: ChainLoadError | null
  /** newest first: REST snapshot merged with the WebSocket stream */
  feed: ChainEvent[]
  feedAt: number | null
  feedError: ChainLoadError | null
  /** kept events received over the socket since the page loaded (the index offers a refresh) */
  keptSeq: number
  keptByChain: Partial<Record<ChainId, number>>
}

export const useChain = create<ChainState>(() => ({
  stats: null,
  statsAt: null,
  statsError: null,
  feed: [],
  feedAt: null,
  feedError: null,
  keptSeq: 0,
  keptByChain: {},
}))

function mergeFeed(cur: ChainEvent[], incoming: ChainEvent[]): ChainEvent[] {
  if (!incoming.length) return cur
  const seen = new Set<string>()
  const out: ChainEvent[] = []
  for (const e of [...incoming, ...cur]) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  out.sort((a, b) => b.ts - a.ts)
  if (out.length > CAP_FEED) out.length = CAP_FEED
  return out
}

/** One read pushed over the WebSocket ({ t: 'chain', event }). */
export function ingestChainEvent(ev: unknown): void {
  if (!isEvent(ev)) return
  const st = useChain.getState()
  // the stream may repeat what the REST snapshot already holds
  for (let i = 0; i < Math.min(st.feed.length, 40); i++) if (st.feed[i].id === ev.id) return
  const next: Partial<ChainState> = { feed: mergeFeed(st.feed, [ev]) }
  if (ev.verdict === 'kept') {
    next.keptSeq = st.keptSeq + 1
    next.keptByChain = { ...st.keptByChain, [ev.chain]: (st.keptByChain[ev.chain] ?? 0) + 1 }
  }
  // the agent card's "last activity" follows the stream; counts and state come from the next stats poll
  if (st.stats) {
    const i = st.stats.agents.findIndex((a) => a.id === ev.agent)
    if (i >= 0 && (st.stats.agents[i].lastAt ?? 0) < ev.ts) {
      const agents = st.stats.agents.slice()
      agents[i] = { ...agents[i], lastAt: ev.ts }
      next.stats = { ...st.stats, agents }
    }
  }
  useChain.setState(next)
}

// ─── pollers (ref-counted: run only while a chain view is mounted) ──────────

const STATS_MS = 8_000
const FEED_STALE_MS = 30_000
const QUICK_RETRY_MS = 3_000
const MAX_BACKOFF_MS = 120_000
const FAILS_BEFORE_ERROR = 2

let subs = 0
let statsTimer: ReturnType<typeof setTimeout> | null = null
let statsInflight = false
let statsFails = 0
let feedInflight = false
let unsubConn: (() => void) | null = null

const hidden = () => typeof document !== 'undefined' && document.hidden

function scheduleStats(ms: number) {
  if (statsTimer) clearTimeout(statsTimer)
  statsTimer = subs > 0 ? setTimeout(runStats, ms) : null
}

async function runStats(): Promise<void> {
  statsTimer = null
  if (statsInflight || subs === 0) return
  // a hidden tab pauses after the first answer and catches up on visibilitychange
  if (hidden() && useChain.getState().stats) return
  statsInflight = true
  let next = STATS_MS
  try {
    const stats = await fetchChainStats()
    statsFails = 0
    useChain.setState({ stats, statsAt: Date.now(), statsError: null })
  } catch (e) {
    const ra = e instanceof ChainHttpError && e.status === 429 ? Math.min(15_000, Math.max(1_000, e.retryAfterMs ?? 3_000)) : null
    if (ra != null) next = ra
    else {
      statsFails++
      if (statsFails >= FAILS_BEFORE_ERROR) {
        useChain.setState({ statsError: classifyError(e) })
        next = Math.min(MAX_BACKOFF_MS, STATS_MS * 2 ** (statsFails - FAILS_BEFORE_ERROR))
      } else next = QUICK_RETRY_MS
    }
  } finally {
    statsInflight = false
    scheduleStats(next)
  }
}

async function runFeed(): Promise<void> {
  if (feedInflight) return
  feedInflight = true
  try {
    const list = await fetchChainFeed(CAP_FEED)
    useChain.setState((s) => ({ feed: mergeFeed(s.feed, list), feedAt: Date.now(), feedError: null }))
  } catch (e) {
    useChain.setState({ feedError: classifyError(e) })
  } finally {
    feedInflight = false
  }
}

function onVisible() {
  if (hidden() || subs === 0) return
  const { statsAt, feedAt } = useChain.getState()
  if (statsAt == null || Date.now() - statsAt >= STATS_MS) scheduleStats(0)
  if (feedAt == null || Date.now() - feedAt >= FEED_STALE_MS) void runFeed()
}

function subscribe(): () => void {
  subs++
  if (subs === 1) {
    scheduleStats(0)
    const { feedAt, feedError } = useChain.getState()
    if (feedAt == null || feedError || Date.now() - feedAt >= FEED_STALE_MS) void runFeed()
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    // the socket came back: the stream had a gap, refill it from the stored feed
    let prev = useLive.getState().conn
    unsubConn = useLive.subscribe((s) => {
      if (s.conn === prev) return
      const was = prev
      prev = s.conn
      if (s.conn === 'live' && was !== 'live') {
        void runFeed()
        scheduleStats(0)
      }
    })
  }
  return () => {
    subs = Math.max(0, subs - 1)
    if (subs === 0) {
      if (statsTimer) clearTimeout(statsTimer)
      statsTimer = null
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
      unsubConn?.()
      unsubConn = null
    }
  }
}

/** Keep chain stats polled and the feed filled while the calling view is mounted. */
export function useChainLive(): void {
  useEffect(() => subscribe(), [])
}

/** Retry now (the "retry" button on an error line). */
export function refreshChain(): void {
  if (subs === 0) return
  statsFails = 0
  scheduleStats(0)
  void runFeed()
}
