// LUSCA hub: REST API, production static hosting and the /ws broadcast socket.
//
// server/index.ts creates the hub first (so its `emit` can be handed to the
// crawler / trainer / coordinator), then binds the modules and listens.
// Everything here is defensive: a throwing module degrades one field of one
// response, never the process.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { ClientMsg, Hello, ModelInfo, SectorInfo, ServerMsg, Stats } from '../shared/protocol.ts'
import { SECTORS } from '../shared/sectors.ts'
import type { PayoutsOverview, WalletPayouts } from '../shared/payouts.ts'
import type { CodeIndexStats } from '../shared/codebase.ts'
import type { ChainEvent, ChainId, ChainIndexItem, ChainRead, ChainStats } from '../shared/chain.ts'
import { RADAR_KINDS, type RadarEvent, type RadarKind, type RadarPage } from '../shared/radar.ts'
import { isSolanaAddress } from '../shared/base58.ts'
import type { Auth } from './auth/auth.ts'
import { handleModelRoute, type WeightsExporter } from './model/export.ts'
import { handleProofRoute, type PreviewSource } from './proofs/http.ts'
import type { ProofsApi } from './proofs/index.ts'
import { SPAWN_TTL_MS, type CoordinatorApi, type CrawlerApi, type Emit, type NeuronConn, type TrainerApi } from './contracts.ts'
import type { LuscaCoordinator } from './neurons/coordinator.ts'
import { parseV6 } from './ingest/netguard.ts'
import { BOT_CONTACT, BOT_FROM, ROBOTS_UA, USER_AGENT } from './ingest/util.ts'
import { playerFile, resolveShare } from './share/cards.ts'

/** GET /api/bot: who LuscaBot is and where site owners reach its operator (env LUSCA_BOT_CONTACT). */
const BOT_INFO = { userAgent: USER_AGENT, robotsToken: ROBOTS_UA, contact: BOT_CONTACT || null, from: BOT_FROM }

// ─── logging ────────────────────────────────────────────────────────────────

const useColor = !process.env.NO_COLOR && (!!process.stdout.isTTY || (!!process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0'))
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
export const ansi = {
  orange: (s: string) => paint('38;2;255;77;0', s),
  dim: (s: string) => paint('2', s),
  bold: (s: string) => paint('1', s),
  red: (s: string) => paint('31', s),
  yellow: (s: string) => paint('33', s),
}

function stamp() {
  return ansi.dim(new Date().toISOString().slice(11, 19))
}

export const log = {
  info: (tag: string, ...a: unknown[]) => console.log(stamp(), ansi.orange(`[${tag}]`), ...a),
  warn: (tag: string, ...a: unknown[]) => console.warn(stamp(), ansi.yellow(`[${tag}]`), ...a),
  error: (tag: string, ...a: unknown[]) => console.error(stamp(), ansi.red(`[${tag}]`), ...a),
}

/** Log a recurring failure at most once per 30 s per key (e.g. a stats() that throws every tick). */
const lastLogged = new Map<string, number>()
function logThrottled(key: string, err: unknown) {
  const now = Date.now()
  if ((lastLogged.get(key) ?? 0) + 30_000 > now) return
  lastLogged.set(key, now)
  log.error('hub', `${key}:`, err instanceof Error ? (err.stack ?? err.message) : err)
}

function safe<T>(key: string, fn: () => T, fallback: T): T {
  try {
    const v = fn()
    return v === undefined || v === null ? fallback : v
  } catch (e) {
    logThrottled(key, e)
    return fallback
  }
}

// ─── types / defaults ───────────────────────────────────────────────────────

export type HubCoordinator = CoordinatorApi & Partial<Pick<LuscaCoordinator, 'ledger' | 'balance' | 'linkDevice'>>

/** Read side of the payout engine (server/payouts). */
export interface HubPayouts {
  overview(): PayoutsOverview
  wallet(address: string): WalletPayouts
}

export interface Modules {
  crawler: CrawlerApi
  trainer: TrainerApi
  coordinator: HubCoordinator
  /** Wallet sign-in (server/auth). Without it /api/auth/* answers 503. */
  auth?: Pick<Auth, 'issueNonce' | 'verify'>
  /** Payout engine. Without it /api/payouts* answers 503. */
  payouts?: HubPayouts
  /** Protocol code index (server/codebase). Without it /api/code/stats answers 503. */
  code?: { stats(): CodeIndexStats }
  /** Chain agents (server/chain): stored reads only. Without it /api/chain/* answers 503. */
  chain?: HubChain
  /** SEPIA-0 weights export (server/model). Without it /api/model/* answers 503. */
  model?: WeightsExporter
  /** Contribution epochs (server/proofs). Without it /api/proofs* answers 503. */
  proofs?: { api: ProofsApi; preview: PreviewSource | null }
  /** LUSCA Lens (server/lens): validates, limits, caches and answers /api/lens/* itself. Without it 503. */
  lens?: { route(p: string, ip: string): Promise<{ status: number; json: string; headers?: Record<string, string> }> } | null
  /** UPGRADE RADAR (server/radar): stored events only. Without it /api/radar* answers 503. */
  radar?: HubRadar | null
}

/** Read side of the upgrade radar: every answer comes from stored events, no RPC. */
export interface HubRadar {
  list(q: { chain?: ChainId; kind?: RadarKind; other?: boolean; known?: boolean; sort?: 'new' | 'priority'; limit?: number; cursor?: string }): RadarPage
  get(id: string): RadarEvent | null
}

/** Read side of the chain agents (server/chain/index.ts): every answer comes from stored data, no RPC. */
export interface HubChain {
  stats(): ChainStats
  feed(limit: number): ChainEvent[]
  items(q: { chain?: ChainId; limit?: number; cursor?: string }): { items: ChainIndexItem[]; next: string | null }
  item(chain: ChainId, address: string): { item: ChainIndexItem; read: ChainRead } | null
}

export interface HubOptions {
  /** Built client (vite build output). Served when it contains index.html. */
  distDir: string | null
  /** Serve dist/ even when NODE_ENV=development. */
  forceStatic?: boolean
  /**
   * Trust X-Forwarded-For for client IPs (behind a reverse proxy). 0 / false = never.
   * N ≥ 1 = walking X-Forwarded-For from the right, skip entries inside `trustedProxies`
   * (our own proxy hops) and take the N-th untrusted entry as the client — with 1 that
   * is "rightmost untrusted". Honoured only for requests whose socket peer is itself
   * inside `trustedProxies`. See resolveClientAddress().
   */
  trustProxy?: boolean | number
  /**
   * Reverse-proxy addresses: IPs, CIDR ranges (IPv4 + IPv6) or the keywords `loopback`,
   * `private` (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7, fe80::/10) and
   * `cloudflare` (Cloudflare's published edge ranges). Empty → `loopback` + `private`.
   */
  trustedProxies?: string[]
  /** Extra allowed CORS origins in addition to localhost ones. */
  corsOrigins?: string[]
  /** Socket / buffer / stream caps (defaults: DEFAULT_HUB_LIMITS, sized for a 2 GB instance). */
  limits?: Partial<HubLimits>
  /** Response security headers. */
  security?: {
    /** Content-Security-Policy: 'on' (default), 'report' (Report-Only) or 'off'. */
    csp?: 'on' | 'report' | 'off'
    /** Strict-Transport-Security max-age in seconds for https requests (0 = no header). */
    hstsMaxAge?: number
  }
  /** Extra health checks (ledger, checkpoint, disk) merged into /api/health. */
  health?: () => HealthReport
}

export interface HubLimits {
  /** WebSocket clients in total. */
  maxClients: number
  /** WebSocket clients per client address (IPv6: per /64). */
  maxClientsPerIp: number
  /** Bytes queued on all sockets together before non-essential traffic is shed and jobs are deferred. */
  totalBufferBytes: number
  /** Per-socket backlog beyond which a client is terminated (plus the size of a neuron job in flight). */
  hardBufferBytes: number
  /** Broadcast stream budget per client in bytes/s (0 = unlimited); trace/discover are dropped first. */
  wsMaxBytesPerSec: number
  /** Per-address requests per minute to /api/ledger, /api/neurons and /api/agents/:id/traces. */
  readsPerMin: number
  /** Event-loop delay p99 (ms) above which /api/health reports degraded. */
  lagP99Ms: number
}

/** Defaults sized for Render Standard (1 CPU / 2 GB). */
export const DEFAULT_HUB_LIMITS: HubLimits = {
  maxClients: 1_000,
  maxClientsPerIp: 16,
  totalBufferBytes: 128 * 1024 * 1024,
  hardBufferBytes: 8 * 1024 * 1024,
  wsMaxBytesPerSec: 24 * 1024,
  readsPerMin: 120,
  lagP99Ms: 500,
}

export interface HealthReport {
  /** Short machine-readable codes, e.g. 'ledger-save-failing'. Empty when healthy. */
  degraded: string[]
  /** Details shown under `checks` in /api/health. */
  checks?: Record<string, unknown>
}

export interface Hub {
  emit: Emit
  bind(m: Modules): void
  listen(port: number, host?: string): Promise<number>
  close(): Promise<void>
  clientCount(): number
  server: http.Server
}

const ZERO_CRAWL: ReturnType<CrawlerApi['stats']> = {
  pages: 0, tokens: 0, bytes: 0, domains: 0, frontier: 0, rejected: 0, dupes: 0, errors: 0,
  agentsActive: 0, agentsTotal: 0, pagesPerMin: 0, tokensPerMin: 0, uptime: 0,
}
const ZERO_NEURONS: ReturnType<CoordinatorApi['stats']> = { neurons: 0, gflops: 0, jobsDone: 0, jobsVerified: 0, inkIssued: 0 }
const EMPTY_TRAIN = { version: 0, gpuSteps: 0, serverSteps: 0, gpuSamples: 0, contributors24h: 0, audits: { ok: 0, failed: 0 }, gpuStepsPerMin: 0 }
const EMPTY_MODEL: ModelInfo = { name: 'SEPIA-0', params: 0, arch: '—', vocab: 0, step: 0, loss: 0, val: null, corpusChars: 0, stepsPerSec: 0, ...EMPTY_TRAIN }

/** ModelInfo with the training-network counters (trainer.trainStats) merged in. */
function modelInfo(t: TrainerApi): ModelInfo {
  const info = t.info()
  let stats: Partial<ModelInfo> = {}
  try {
    stats = typeof t.trainStats === 'function' ? (t.trainStats() ?? {}) : {}
  } catch {
    stats = {}
  }
  return { ...EMPTY_TRAIN, ...info, ...stats }
}
const emptySectors = (): SectorInfo[] => SECTORS.map((s) => ({ id: s.id, pages: 0, tokens: 0, frontier: 0, agents: 0 }))

// ─── limits ─────────────────────────────────────────────────────────────────

const BODY_LIMIT = 16 * 1024
const WS_MAX_PAYLOAD = 1024 * 1024        // inbound; dedupe results are a few KB, train results ~500 KB (base64 f16 gradient)
// Per-socket backlog caps (soft / hard) and the all-clients total come from HubLimits.
// The soft cap (skip non-essential / snapshot messages for that client) is min(4 MB, hard / 2).
const SLOW_CLIENT_MS = 30_000             // continuously above the soft cap this long → terminate
const JOB_ALLOWANCE_MS = 120_000          // a neuron job this recent raises that socket's caps by its size
const HEARTBEAT_MS = 30_000
const STATS_MS = 1_000
const HEALTH_TICK_MS = 10_000
const HEALTH_CACHE_MS = 1_000
const LOOP_WINDOW_MS = 60_000             // event-loop delay percentiles are reported over this window
const LOOP_RESOLUTION_MS = 20
const READ_CACHE_MS = 2_000               // /api/ledger, /api/neurons, traces: shared snapshot this old at most
const READ_CACHE_MAX = 64
const PAYOUTS_CACHE_MS = 5_000            // /api/payouts and /api/payouts/wallet/:address
const CODE_STATS_CACHE_MS = 10_000        // /api/code/stats (the index changes once per repository)
const CHAIN_CACHE_MS = 2_000              // /api/chain/stats, /feed, /items (a chain agent reads every ~20 s at most)
const CHAIN_ITEM_CACHE_MS = 30_000        // /api/chain/item/:chain/:address (one stored record; disk read)
const CHAIN_IDS = new Set<ChainId>(['solana', 'ethereum', 'base', 'arbitrum'])
const RADAR_CACHE_MS = 2_000              // /api/radar, /api/radar/:id (events change as reads finish)
const RADAR_ID_RE = /^[a-z]{3}-[a-z0-9]{6,20}$/
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const CHAIN_CURSOR_RE = /^\d{1,16}\.[a-z]{1,16}\.[A-Za-z0-9]{20,64}$/
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/ // browser / desktop neuron device ids (as the coordinator accepts them)
const NON_ESSENTIAL = new Set<ServerMsg['t']>(['trace', 'agent', 'discover', 'reject'])
/**
 * Per-client stream budget: a message of type t is sent only if the client's byte bucket
 * stays at or above STREAM_RESERVE[t] × burst afterwards. Trace / discover need half the
 * bucket left, so they are the first to go; snapshots may overdraw. Unlisted types: 0.
 * 'ink' is always delivered (charged, never withheld): a browser neuron credits its INK
 * and paces its job loop on its own 'ink' event. Direct messages (hello, job, neuron.ok,
 * account, error) bypass the bucket.
 */
const STREAM_RESERVE: Partial<Record<ServerMsg['t'], number>> = {
  trace: 0.5,
  discover: 0.5,
  reject: 0.35,
  agent: 0.2,
  chain: 0.2, // chain agents' reads (≤ 4/s); the /chain page backfills from /api/chain/feed
  radar: 0.1, // code changes caught by the radar (≤ 8 KB each); /radar backfills from /api/radar
  stats: -0.5,
  neurons: -0.5,
  ink: Number.NEGATIVE_INFINITY,
}
const STREAM_BURST_S = 2                   // bucket holds this many seconds of budget
/** Snapshots replaced by the next one: skipped (not queued) for a backed-up client. */
const SNAPSHOT = new Set<ServerMsg['t']>(['stats', 'neurons'])
const DIRECT_ONLY = new Set<ServerMsg['t']>(['job', 'neuron.ok', 'account'])
const AGENT_COALESCE_MS = 100             // 'agent' snapshots: latest per agent id within this window
const SEND_BUDGET_PER_SEC = 60_000        // ws sends/s across clients before non-essential traffic is sampled out
const HELLO_CACHE_MS = 1_000
const GENERATE_CONCURRENCY = 2
const GENERATE_TIMEOUT_MS = 20_000
const MSG_RATE = 30                        // inbound ws messages per second (sustained)
const MSG_BURST = 90
const SPAWNS_PER_IP_LIVE = 2               // spawned agents per IP within SPAWN_TTL_MS (they retire after it)
const SPAWNS_PER_HOUR = 10                 // all clients together

/** Sliding-window per-key limiter. take() → 0 when allowed (and recorded), else ms until allowed. */
function createLimiter(windowMs: number, max: number) {
  const hits = new Map<string, number[]>()
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs
    for (const [k, ts] of hits) if (!ts.length || ts[ts.length - 1] <= cutoff) hits.delete(k)
  }, 60_000)
  sweep.unref?.()
  const live = (key: string, now: number) => {
    const ts = (hits.get(key) ?? []).filter((t) => t > now - windowMs)
    hits.set(key, ts)
    return ts
  }
  return {
    /** ms until a take() would be allowed (0 = now); records nothing. */
    check(key: string): number {
      const now = Date.now()
      const ts = live(key, now)
      return ts.length >= max ? ts[0] + windowMs - now : 0
    },
    take(key: string): number {
      const now = Date.now()
      const ts = live(key, now)
      if (ts.length >= max) return ts[0] + windowMs - now
      ts.push(now)
      return 0
    },
    stop: () => clearInterval(sweep),
  }
}

/** Limiter key for an address: IPv4-mapped IPv6 unwrapped, IPv6 reduced to its /64 (one subscriber). */
export function ipKey(raw: string): string {
  let ip = raw.trim().replace(/^\[|\]$/g, '')
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(ip)) ip = ip.slice(7)
  if (isIP(ip) === 6) {
    const h = parseV6(ip)
    if (h) return `${h.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
  }
  return ip || 'unknown'
}

// ─── proxy trust (X-Forwarded-For) ──────────────────────────────────────────

/** A parsed address: IPv4 as 4 bytes, IPv6 as 16 (IPv4-mapped IPv6 is folded to IPv4). */
export interface Addr {
  v: 4 | 6
  b: Uint8Array
  text: string
}

/** A CIDR range (`bits` leading bits of `b` must match). */
export interface Cidr {
  v: 4 | 6
  b: Uint8Array
  bits: number
  src: string
}

const PROXY_KEYWORDS: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  // Not routable on the public internet, so only infrastructure (a PaaS load balancer) can be the peer.
  private: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7', 'fe80::/10'],
  // https://www.cloudflare.com/ips/ — only for a service that sits behind Cloudflare.
  cloudflare: [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
    '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
    '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
  ],
}
export const DEFAULT_TRUSTED_PROXIES = ['loopback', 'private']
/** X-Forwarded-For entries examined at most (from the right). */
const MAX_XFF_WALK = 32

/** Parse "1.2.3.4", "1.2.3.4:5678", "[2001:db8::1]:443", "::ffff:1.2.3.4", "fe80::1%eth0". */
export function parseAddr(raw: string): Addr | null {
  let s = raw.trim()
  if (!s) return null
  const bracket = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(s)
  if (bracket) s = bracket[1]
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(s)) s = s.slice(0, s.lastIndexOf(':'))
  s = s.replace(/%[\w.-]*$/, '')
  const fam = isIP(s)
  if (fam === 4) {
    const b = Uint8Array.from(s.split('.').map(Number))
    return { v: 4, b, text: Array.from(b).join('.') }
  }
  if (fam !== 6) return null
  const h = parseV6(s)
  if (!h) return null
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    const b = Uint8Array.of(h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff)
    return { v: 4, b, text: Array.from(b).join('.') }
  }
  const b = new Uint8Array(16)
  h.forEach((x, i) => {
    b[2 * i] = x >> 8
    b[2 * i + 1] = x & 0xff
  })
  return { v: 6, b, text: s.toLowerCase() }
}

/** Parse "10.0.0.0/8", "2001:db8::/32" or a bare address (a /32 or /128). */
export function parseCidr(raw: string): Cidr | null {
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(raw.trim())
  if (!m) return null
  const a = parseAddr(m[1])
  if (!a) return null
  const max = a.v === 4 ? 32 : 128
  let bits = m[2] === undefined ? max : Number(m[2])
  if (a.v === 4 && m[1].includes(':') && m[2] !== undefined) bits -= 96 // ::ffff:10.0.0.0/104 → 10.0.0.0/8
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null
  return { v: a.v, b: a.b, bits, src: raw.trim() }
}

/** Expand keywords and parse every entry; unparseable entries are returned in `invalid`. */
export function parseTrustedProxies(list: readonly string[]): { ranges: Cidr[]; invalid: string[]; keywords: string[]; explicit: string[] } {
  const ranges: Cidr[] = []
  const invalid: string[] = []
  const keywords: string[] = []
  const explicit: string[] = []
  for (const raw of list) {
    const s = raw.trim()
    if (!s) continue
    const kw = PROXY_KEYWORDS[s.toLowerCase()]
    if (kw) {
      keywords.push(s.toLowerCase())
      for (const r of kw) ranges.push(parseCidr(r)!)
      continue
    }
    const c = parseCidr(s)
    if (c) {
      ranges.push(c)
      explicit.push(c.src)
    } else invalid.push(s)
  }
  return { ranges, invalid, keywords, explicit }
}

export function inCidr(a: Addr, c: Cidr): boolean {
  if (a.v !== c.v) return false
  for (let i = 0, bits = c.bits; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff
    if ((a.b[i] & mask) !== (c.b[i] & mask)) return false
  }
  return true
}

export function inRanges(a: Addr | null, ranges: readonly Cidr[]): boolean {
  return !!a && ranges.some((c) => inCidr(a, c))
}

const CLOUDFLARE_RANGES = parseTrustedProxies(['cloudflare']).ranges

/**
 * The client address of a request (normalized text, not yet reduced by ipKey).
 *
 * Each proxy APPENDS the address it received the connection from, so X-Forwarded-For
 * read right-to-left is the chain that ends at our socket peer. Only when the peer is a
 * trusted proxy (and hops > 0) is the header read at all. Walking it from the right,
 * entries inside `trusted` are our own proxy hops and are skipped; the `hops`-th
 * untrusted entry is the client (hops = 1: rightmost untrusted). Entries further left
 * were written by the client and are never used. When the header runs out, or holds
 * an unparseable entry, the leftmost entry examined so far is the answer.
 */
export function resolveClientAddress(peerRaw: string | undefined, xff: string | string[] | undefined, hops: number, trusted: readonly Cidr[]): string {
  const peer = parseAddr(peerRaw ?? '')
  if (!peer) return (peerRaw ?? '').replace(/^::ffff:/i, '') || 'unknown'
  if (hops <= 0 || !inRanges(peer, trusted)) return peer.text
  const list = (Array.isArray(xff) ? xff.join(',') : (xff ?? '')).split(',')
  let pick = peer.text
  let untrusted = 0
  for (let i = list.length - 1, seen = 0; i >= 0 && seen < MAX_XFF_WALK; i--) {
    const s = list[i].trim()
    if (!s) continue
    seen++
    const a = parseAddr(s)
    if (!a) break // garbage: nothing to its left can be attributed to a proxy we trust
    pick = a.text
    if (inRanges(a, trusted)) continue
    if (++untrusted >= hops) break
  }
  return pick
}

/** Header value(s) as one string, truncated for logging. */
function headerForLog(v: string | string[] | undefined, max: number): string {
  if (v === undefined) return '-'
  const s = Array.isArray(v) ? v.join(', ') : v
  // eslint-disable-next-line no-control-regex -- keep log lines single-line and printable
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, '?')
  return clean.length > max ? `${clean.slice(0, max)}…(${clean.length} chars)` : clean
}

class HttpError extends Error {
  status: number
  headers?: Record<string, string>
  constructor(status: number, message: string, headers?: Record<string, string>) {
    super(message)
    this.status = status
    this.headers = headers
  }
}

// ─── static files ───────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
}
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|manifest\+json|wasm)|image\/svg\+xml|model\/gltf\+json)/

/** In-memory gzip cache for static assets (keyed by path, invalidated by mtime/size). */
const gzCache = new Map<string, { mtimeMs: number; size: number; gz: Buffer }>()
let gzBytes = 0
const GZ_CACHE_MAX = 64 * 1024 * 1024

function gzipCached(file: string, st: fs.Stats): Promise<Buffer> {
  const hit = gzCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return Promise.resolve(hit.gz)
  return fs.promises.readFile(file).then(
    (buf) =>
      new Promise<Buffer>((resolve, reject) =>
        zlib.gzip(buf, { level: 6 }, (err, gz) => {
          if (err) return reject(err)
          if (hit) gzBytes -= hit.gz.length
          if (gz.length < GZ_CACHE_MAX / 4) {
            while (gzBytes + gz.length > GZ_CACHE_MAX && gzCache.size) {
              const [k, v] = gzCache.entries().next().value as [string, { gz: Buffer }]
              gzCache.delete(k)
              gzBytes -= v.gz.length
            }
            gzCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, gz })
            gzBytes += gz.length
          }
          resolve(gz)
        }),
      ),
  )
}

function acceptsGzip(req: http.IncomingMessage): boolean {
  const ae = req.headers['accept-encoding']
  return typeof ae === 'string' && /\bgzip\b/.test(ae)
}

// ─── hub ────────────────────────────────────────────────────────────────────

interface Client {
  id: string
  ws: WebSocket
  ip: string
  alive: boolean
  conn: NeuronConn
  tokens: number
  refillAt: number
  dropped: number
  connectedAt: number
  /** Since when the socket has been continuously above the soft cap (0 = not). */
  overSoftSince: number
  /** Stream budget bucket (bytes) and when it was last refilled. */
  budget: number
  budgetAt: number
  /** Broadcast messages withheld by the stream budget. */
  throttled: number
  /** Size and time of the last neuron job sent: the backlog it creates is expected, not a stall. */
  jobBytes: number
  jobAt: number
  /** The /scan page is open on this socket ('chain.scan'): chain events arrive with their call trace and decoded fields. */
  scan: boolean
}

export function createHub(opts: HubOptions): Hub {
  const L: HubLimits = { ...DEFAULT_HUB_LIMITS, ...Object.fromEntries(Object.entries(opts.limits ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) }
  const HARD_BUFFER = Math.max(1024 * 1024, L.hardBufferBytes)
  const SOFT_BUFFER = Math.min(4 * 1024 * 1024, Math.floor(HARD_BUFFER / 2))
  const TOTAL_BUFFER_LIMIT = Math.max(HARD_BUFFER, L.totalBufferBytes)
  const STREAM_RATE = Math.max(0, L.wsMaxBytesPerSec) // bytes/s, 0 = unlimited
  const STREAM_BURST = STREAM_RATE * STREAM_BURST_S
  const cspMode = opts.security?.csp ?? 'on'
  const hstsMaxAge = Math.max(0, Math.floor(opts.security?.hstsMaxAge ?? 31_536_000))
  let modules: Modules | null = null
  const clients = new Set<Client>()
  const perIp = new Map<string, number>()
  const spawnLimit = createLimiter(10_000, 1)
  const spawnLiveLimit = createLimiter(SPAWN_TTL_MS, SPAWNS_PER_IP_LIVE)
  const spawnGlobalLimit = createLimiter(60 * 60_000, SPAWNS_PER_HOUR)
  const generateLimit = createLimiter(60_000, 30)
  const pagesLimit = createLimiter(60_000, 60)
  const helloLimit = createLimiter(60_000, 60)
  const statsLimit = createLimiter(60_000, 120)
  const wsConnectLimit = createLimiter(10_000, 20)
  const readLimit = createLimiter(60_000, Math.max(1, Math.floor(L.readsPerMin)))
  const modelLimit = createLimiter(60_000, 30) // /api/model/* per address (responses are cacheable for 10 min)
  const authLimit = createLimiter(60_000, 30) // /api/auth/* per address (server/auth adds its own per-route caps)
  const proofLimit = createLimiter(60_000, 30) // POST /api/proofs/* lookups per address (apart from sign-in)
  const limiters = [spawnLimit, spawnLiveLimit, spawnGlobalLimit, generateLimit, pagesLimit, helloLimit, statsLimit, wsConnectLimit, readLimit, authLimit, proofLimit]
  let generating = 0
  let shuttingDown = false
  let statsTimer: NodeJS.Timeout | null = null
  let heartbeatTimer: NodeJS.Timeout | null = null
  let healthTimer: NodeJS.Timeout | null = null
  let agentTimer: NodeJS.Timeout | null = null
  let throttledTotal = 0
  const pendingAgents = new Map<number, ServerMsg>()
  let totalBuffered = 0
  let sendWindowAt = 0
  let sendWindowCount = 0
  let helloCache: { at: number; json: string } | null = null
  let loopbackOnly = false
  const startedAt = Date.now()

  const corsExtra = new Set((opts.corsOrigins ?? []).map((o) => o.trim().replace(/\/$/, '')).filter(Boolean))
  const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d{1,5})?$/i
  const LOCAL_HOST_HEADER = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|[a-z0-9-]+\.localhost)(:\d{1,5})?$/i
  const trustHops = typeof opts.trustProxy === 'number' ? Math.max(0, Math.floor(opts.trustProxy)) : opts.trustProxy ? 1 : 0
  const proxyList = (opts.trustedProxies ?? []).map((s) => s.trim()).filter(Boolean)
  const trust = parseTrustedProxies(proxyList.length ? proxyList : DEFAULT_TRUSTED_PROXIES)
  const trustsCloudflare = trust.keywords.includes('cloudflare')
  let proxyObserved = false

  const distDir = opts.distDir ? path.resolve(opts.distDir) : null
  const staticEnabled = !!distDir && (opts.forceStatic || process.env.NODE_ENV !== 'development')
  let distCheck = { at: 0, ok: false }
  function distReady(): boolean {
    if (!staticEnabled || !distDir) return false
    const now = Date.now()
    if (now - distCheck.at > 2_000) distCheck = { at: now, ok: fs.existsSync(path.join(distDir, 'index.html')) }
    return distCheck.ok
  }

  // ── payload builders ──

  function buildStats(): Stats {
    if (!modules) return { ...ZERO_CRAWL, ...ZERO_NEURONS }
    const m = modules
    return { ...ZERO_CRAWL, ...safe('crawler.stats', () => m.crawler.stats(), ZERO_CRAWL), ...safe('coordinator.stats', () => m.coordinator.stats(), ZERO_NEURONS) }
  }

  function buildSectors(): SectorInfo[] {
    if (!modules) return emptySectors()
    const m = modules
    return safe('crawler.sectors', () => m.crawler.sectors(), emptySectors())
  }

  function buildHello(): Hello {
    const m = modules
    if (!m) {
      return {
        t: 'hello', mode: 'live', serverTime: Date.now(), agents: [], stats: buildStats(), sectors: emptySectors(), domains: [],
        recent: [], traces: [], loss: [], model: EMPTY_MODEL, samples: [], neurons: [],
      }
    }
    return {
      t: 'hello',
      mode: 'live',
      serverTime: Date.now(),
      agents: safe('crawler.agents', () => m.crawler.agents(), []),
      stats: buildStats(),
      sectors: buildSectors(),
      domains: safe('crawler.domains', () => m.crawler.domains(), []),
      recent: safe('crawler.recent', () => m.crawler.recent(60), []),
      traces: safe('crawler.traces', () => m.crawler.traces(120), []),
      loss: safe('trainer.lossHistory', () => m.trainer.lossHistory(), []),
      model: safe('trainer.info', () => modelInfo(m.trainer), EMPTY_MODEL),
      samples: safe('trainer.samples', () => m.trainer.samples(), []),
      neurons: safe('coordinator.neurons', () => m.coordinator.neurons(), []),
    }
  }

  /** Serialized hello, rebuilt at most once per second and shared by REST and every ws greeting. */
  function helloJson(): string {
    const now = Date.now()
    if (helloCache && now - helloCache.at < HELLO_CACHE_MS && modules) return helloCache.json
    const json = JSON.stringify(buildHello())
    helloCache = { at: now, json }
    return json
  }

  // ── websocket fan-out ──

  /** Bytes of a recent neuron job still allowed on top of a socket's caps (the coordinator sends one only to an idle socket). */
  function jobAllowance(c: Client, now: number): number {
    return c.jobBytes && now - c.jobAt < JOB_ALLOWANCE_MS ? c.jobBytes : 0
  }

  /** false (and the client is terminated) when its backlog is past the hard cap. */
  function checkHard(c: Client, buffered: number, now: number): boolean {
    if (buffered <= HARD_BUFFER + jobAllowance(c, now)) return true
    log.warn('ws', `terminating ${c.id} (${c.ip}): ${(buffered / 1048576).toFixed(1)} MB backlog`)
    c.ws.terminate()
    return false
  }

  function sendRaw(c: Client, data: string) {
    if (c.ws.readyState !== WebSocket.OPEN) return
    if (!checkHard(c, c.ws.bufferedAmount, Date.now())) return
    c.ws.send(data, (err) => {
      if (err) logThrottled('ws.send', err)
    })
  }

  function sendTo(c: Client, msg: ServerMsg) {
    let data: string
    try {
      data = JSON.stringify(msg)
    } catch (e) {
      logThrottled(`serialize(${msg.t})`, e)
      return
    }
    sendRaw(c, data)
    if (msg.t === 'job') {
      c.jobBytes = data.length // base64 + ASCII ids: length = bytes
      c.jobAt = Date.now()
    }
  }

  /** Per-client stream budget (token bucket in bytes). true = send it and charge `cost`. */
  function spend(c: Client, cost: number, reserve: number, now: number): boolean {
    if (STREAM_RATE <= 0) return true
    c.budget = Math.min(STREAM_BURST, c.budget + ((now - c.budgetAt) / 1000) * STREAM_RATE)
    c.budgetAt = now
    // A snapshot bigger than the whole bucket still goes out whenever the bucket is full.
    if (c.budget - cost >= reserve * STREAM_BURST || (reserve <= 0 && c.budget >= STREAM_BURST)) {
      c.budget -= cost
      return true
    }
    c.throttled++
    throttledTotal++
    return false
  }

  /** Account `cost` sends in the current 1 s window; false when the window budget is spent. */
  function budget(cost: number, essential: boolean): boolean {
    const now = Date.now()
    if (now - sendWindowAt >= 1000) {
      sendWindowAt = now
      sendWindowCount = 0
    }
    if (!essential && sendWindowCount + cost > SEND_BUDGET_PER_SEC) return false
    sendWindowCount += cost
    return true
  }

  /** `only`: the clients this message is for (default: every client). */
  function broadcast(msg: ServerMsg, only?: (c: Client) => boolean) {
    if (clients.size === 0) return
    const n = only ? [...clients].filter(only).length : clients.size
    if (n === 0) return
    const skippable = NON_ESSENTIAL.has(msg.t)
    const snapshot = SNAPSHOT.has(msg.t)
    // Shared CPU / memory pressure: sample out the live trace stream rather than stall the event loop.
    if (skippable && (totalBuffered > TOTAL_BUFFER_LIMIT || !budget(n, false))) return
    if (!skippable) budget(n, true)
    const data = JSON.stringify(msg) // serialize once for every client
    const cost = STREAM_RATE > 0 ? Buffer.byteLength(data) : 0
    const reserve = STREAM_RESERVE[msg.t] ?? 0
    const now = Date.now()
    for (const c of clients) {
      if (only && !only(c)) continue
      if (c.ws.readyState !== WebSocket.OPEN) continue
      const buffered = c.ws.bufferedAmount
      if (!checkHard(c, buffered, now)) continue
      if ((skippable || snapshot) && buffered > SOFT_BUFFER) {
        c.dropped++
        continue
      }
      if (!spend(c, cost, reserve, now)) continue
      c.ws.send(data, (err) => {
        if (err) logThrottled('ws.send', err)
      })
    }
  }

  function flushAgents() {
    agentTimer = null
    const list = [...pendingAgents.values()]
    pendingAgents.clear()
    for (const m of list) {
      try {
        broadcast(m)
      } catch (e) {
        logThrottled('broadcast(agent)', e)
      }
    }
  }

  const emit: Emit = (msg) => {
    try {
      if (!msg || typeof msg !== 'object' || shuttingDown) return
      if (DIRECT_ONLY.has(msg.t)) return // per-connection replies are never broadcast
      if (msg.t === 'payout') dropPayoutCache() // a period closed or a payout tx confirmed
      if (clients.size === 0) return
      if (msg.t === 'agent') {
        // An agent emits several snapshots per state change: send only the latest per window.
        pendingAgents.set(msg.agent.id, msg)
        if (!agentTimer) {
          agentTimer = setTimeout(flushAgents, AGENT_COALESCE_MS)
          agentTimer.unref?.()
        }
        return
      }
      if (msg.t === 'chain' && (msg.event?.trace || msg.event?.scan)) {
        // the call trace and decoded fields are for /scan; every other page gets the lean event
        const { trace: _t, scan: _s, ...lean } = msg.event
        broadcast({ t: 'chain', event: lean }, (c) => !c.scan)
        broadcast(msg, (c) => c.scan)
        return
      }
      if (msg.t === 'radar' && msg.event?.trace) {
        // the radar's calls are for /scan; /radar and every other page get the event without them
        const { trace: _t, ...lean } = msg.event
        broadcast({ t: 'radar', event: lean }, (c) => !c.scan)
        broadcast(msg, (c) => c.scan)
        return
      }
      broadcast(msg)
    } catch (e) {
      logThrottled(`broadcast(${(msg as { t?: string })?.t})`, e)
    }
  }

  // permessage-deflate for large frames only (the ~200 KB hello, snapshots); small stream
  // messages stay raw. No context takeover keeps per-socket zlib memory flat. Clients that do
  // not offer the extension (the neuron CLI) are unaffected.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD,
    perMessageDeflate: {
      threshold: 4096,
      zlibDeflateOptions: { level: 3 },
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      concurrencyLimit: 4,
    },
    clientTracking: false,
  })
  wss.on('error', (e) => log.error('ws', e))

  function rawToString(data: RawData): string {
    if (Buffer.isBuffer(data)) return data.toString('utf8')
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
    return Buffer.from(data).toString('utf8')
  }

  function takeToken(c: Client): boolean {
    const now = Date.now()
    c.tokens = Math.min(MSG_BURST, c.tokens + ((now - c.refillAt) / 1000) * MSG_RATE)
    c.refillAt = now
    if (c.tokens < 1) return false
    c.tokens -= 1
    return true
  }

  function onConnection(ws: WebSocket, ip: string) {
    const id = randomUUID()
    const client: Client = {
      id,
      ws,
      ip,
      alive: true,
      conn: {
        id,
        ip,
        send: (msg) => sendTo(client, msg),
        // Under server-wide buffer pressure every socket reports as backed up, so no jobs are issued.
        buffered: () => (totalBuffered > TOTAL_BUFFER_LIMIT ? Number.MAX_SAFE_INTEGER : ws.bufferedAmount),
        close: (code, reason) => {
          try {
            ws.close(code, reason)
          } catch {
            ws.terminate()
          }
        },
      },
      tokens: MSG_BURST,
      refillAt: Date.now(),
      dropped: 0,
      connectedAt: Date.now(),
      overSoftSince: 0,
      // The hello is not charged: the stream starts with a full bucket.
      budget: STREAM_BURST,
      budgetAt: Date.now(),
      throttled: 0,
      jobBytes: 0,
      jobAt: 0,
      scan: false,
    }
    clients.add(client)
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1)

    ws.on('error', (e) => logThrottled('ws.client', e))
    // Liveness is proven only by answering pings: a client that writes but never reads still gets reaped.
    ws.on('pong', () => {
      client.alive = true
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      if (!takeToken(client)) {
        // A client hammering far beyond the sustained rate is cut off.
        if (client.tokens < -MSG_BURST) ws.close(1008, 'rate limit')
        client.tokens -= 0.5
        return
      }
      let msg: unknown
      try {
        msg = JSON.parse(rawToString(data))
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      const t = (msg as { t?: unknown }).t
      switch (t) {
        case 'neuron.register':
        case 'job.request':
        case 'job.result':
        case 'train.result':
        case 'neuron.leave':
        case 'account.watch': // any page following its own ledger account (no register needed)
          if (modules) {
            const m = modules
            safe('coordinator.handle', () => m.coordinator.handle(client.conn, msg as ClientMsg), undefined)
          }
          return
        case 'chain.scan': // the /scan page: chain events with their call trace from now on (or not)
          client.scan = (msg as { on?: unknown }).on === true
          return
        default:
          return // 'ping' and unknown messages are ignored
      }
    })
    ws.on('close', () => {
      clients.delete(client)
      const n = (perIp.get(ip) ?? 1) - 1
      if (n <= 0) perIp.delete(ip)
      else perIp.set(ip, n)
      if (modules) {
        const m = modules
        safe('coordinator.disconnect', () => m.coordinator.disconnect(client.conn), undefined)
      }
    })

    sendRaw(client, helloJson())
  }

  // ── http ──

  function clientIp(req: http.IncomingMessage): string {
    return ipKey(resolveClientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for'], trustHops, trust.ranges))
  }

  /** Socket peer is a proxy we take X-Forwarded-* headers from. */
  function fromTrustedProxy(req: http.IncomingMessage): boolean {
    return trustHops > 0 && inRanges(parseAddr(req.socket.remoteAddress ?? ''), trust.ranges)
  }

  /**
   * Once per process, on the first request that carries X-Forwarded-For: log what the proxy
   * sent and what we made of it, so the hop count can be confirmed on the real deployment.
   */
  function observeProxy(req: http.IncomingMessage) {
    if (proxyObserved || req.headers['x-forwarded-for'] === undefined) return
    proxyObserved = true
    try {
      const h = req.headers
      const peerRaw = req.socket.remoteAddress ?? 'unknown'
      const resolved = resolveClientAddress(peerRaw, h['x-forwarded-for'], trustHops, trust.ranges)
      log.info(
        'proxy',
        `first forwarded request: remoteAddress=${peerRaw} x-forwarded-for="${headerForLog(h['x-forwarded-for'], 200)}" ` +
          `x-forwarded-proto=${headerForLog(h['x-forwarded-proto'], 20)} cf-connecting-ip=${headerForLog(h['cf-connecting-ip'], 60)} ` +
          `true-client-ip=${headerForLog(h['true-client-ip'], 60)} x-real-ip=${headerForLog(h['x-real-ip'], 60)} → client ${resolved} (key ${ipKey(resolved)})`,
      )
      if (trustHops === 0) {
        log.warn('proxy', 'X-Forwarded-For is present but LUSCA_TRUST_PROXY=0: every visitor is keyed on the proxy address, so per-IP limits are site-wide')
      } else if (!fromTrustedProxy(req)) {
        log.warn('proxy', `peer ${peerRaw} is outside LUSCA_TRUSTED_PROXIES, so X-Forwarded-For is ignored — add its range if it is your proxy`)
      } else if (!trustsCloudflare && inRanges(parseAddr(resolved), CLOUDFLARE_RANGES)) {
        log.warn('proxy', `the client resolved to a Cloudflare edge address (${resolved}): raise LUSCA_TRUST_PROXY by one, or add "cloudflare" to LUSCA_TRUSTED_PROXIES`)
      } else if (inRanges(parseAddr(resolved), trust.ranges)) {
        log.warn('proxy', `the client resolved to a trusted proxy address (${resolved}): X-Forwarded-For holds no untrusted hop — check LUSCA_TRUSTED_PROXIES`)
      }
    } catch (e) {
      logThrottled('proxy.observe', e)
    }
  }

  // ── security headers ──

  /** The request reached the outside of our proxy chain over TLS. */
  function viaHttps(req: http.IncomingMessage): boolean {
    if ((req.socket as TLSSocket).encrypted) return true
    if (!fromTrustedProxy(req)) return false
    const xfp = req.headers['x-forwarded-proto']
    const first = (Array.isArray(xfp) ? xfp[0] : (xfp ?? '')).split(',')[0].trim().toLowerCase()
    return first === 'https'
  }

  const CSP_BASE = [
    "default-src 'self'",
    "script-src 'self'",
    // React and three.js write inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ]

  // X player cards: /play/* pages run inside an iframe on x.com / twitter.com (the post's player).
  const PLAYER_ANCESTORS = "frame-ancestors 'self' https://x.com https://*.x.com https://twitter.com https://*.twitter.com"
  const isPlayerPath = (req: http.IncomingMessage) => (req.url ?? '/').split('?')[0].startsWith('/play/')

  function cspFor(req: http.IncomingMessage): string {
    // 'self' covers same-origin ws:/wss: only in CSP3 browsers: name the socket origin explicitly too.
    // Over HTTPS only wss: is ever used, so plain ws: is left out there.
    const host = req.headers.host ?? ''
    const sockets = viaHttps(req) ? `wss://${host}` : `ws://${host} wss://${host}`
    const connect = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(host) ? `connect-src 'self' ${sockets}` : "connect-src 'self'"
    const base = isPlayerPath(req) ? CSP_BASE.map((d) => (d.startsWith('frame-ancestors') ? PLAYER_ANCESTORS : d)) : CSP_BASE
    return [...base, connect].join('; ')
  }

  function applySecurityHeaders(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    // player pages are framed by X; everything else stays same-origin only
    if (!isPlayerPath(req)) res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (hstsMaxAge > 0 && viaHttps(req)) res.setHeader('Strict-Transport-Security', `max-age=${hstsMaxAge}; includeSubDomains`)
    if (cspMode !== 'off') res.setHeader(cspMode === 'report' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', cspFor(req))
  }

  // ── health ──

  const loopMon = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS })
  let loopWindowAt = Date.now()
  let loopLast: { p50Ms: number; p99Ms: number; maxMs: number } | null = null
  let healthCache: { at: number; json: string } | null = null
  let lastDegraded = ''

  /** Delay beyond the sampling interval, in ms (the histogram records whole tick intervals). */
  const lagMs = (ns: number) => Math.max(0, Math.round(ns / 1e6 - LOOP_RESOLUTION_MS))

  function loopStats() {
    const now = Date.now()
    const cur = loopMon.count > 0 ? { p50Ms: lagMs(loopMon.percentile(50)), p99Ms: lagMs(loopMon.percentile(99)), maxMs: lagMs(loopMon.max) } : null
    if (now - loopWindowAt >= LOOP_WINDOW_MS) {
      loopLast = cur
      loopMon.reset()
      loopWindowAt = now
    }
    const pick = (k: 'p50Ms' | 'p99Ms' | 'maxMs') => Math.max(cur?.[k] ?? 0, loopLast?.[k] ?? 0)
    return { p50Ms: pick('p50Ms'), p99Ms: pick('p99Ms'), maxMs: pick('maxMs'), windowS: LOOP_WINDOW_MS / 1000 }
  }

  function buildHealth() {
    const mem = process.memoryUsage()
    const degraded: string[] = []
    const eventLoop = loopStats()
    if (eventLoop.p99Ms > L.lagP99Ms) degraded.push('event-loop-lag')
    let checks: Record<string, unknown> = {}
    if (opts.health) {
      const extra = safe<HealthReport>('health', () => opts.health!(), { degraded: [] })
      degraded.push(...(Array.isArray(extra.degraded) ? extra.degraded : []))
      checks = { ...(extra.checks ?? {}) }
    }
    if (!modules) degraded.push('starting')
    if (shuttingDown) degraded.push('shutting-down')
    let throttledClients = 0
    for (const c of clients) if (c.throttled > 0) throttledClients++
    return {
      ok: !!modules && !shuttingDown,
      status: degraded.length ? 'degraded' : 'ok',
      degraded,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      clients: clients.size,
      stats: buildStats(),
      model: modules ? safe('trainer.info', () => modelInfo(modules!.trainer), EMPTY_MODEL) : EMPTY_MODEL,
      memory: { rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576), externalMB: Math.round((mem.external + mem.arrayBuffers) / 1048576) },
      checks: {
        ...checks,
        eventLoop: { ...eventLoop, limitMs: L.lagP99Ms },
        sockets: {
          bufferedMB: Math.round((totalBuffered / 1048576) * 10) / 10,
          limitMB: Math.round(TOTAL_BUFFER_LIMIT / 1048576),
          streamKBps: Math.round(STREAM_RATE / 1024),
          throttledMsgs: throttledTotal,
          throttledClients,
        },
      },
      node: process.version,
      ts: Date.now(),
    }
  }

  /** Health JSON, rebuilt at most once per second; logs whenever the degraded set changes. */
  function healthJson(): string {
    const now = Date.now()
    if (healthCache && now - healthCache.at < HEALTH_CACHE_MS) return healthCache.json
    const h = buildHealth()
    const key = h.degraded.join(',')
    if (key !== lastDegraded) {
      if (key) log.warn('health', `degraded: ${key}`)
      else if (lastDegraded) log.info('health', 'recovered')
      lastDegraded = key
    }
    const json = JSON.stringify(h)
    healthCache = { at: now, json }
    return json
  }

  // ── cached read endpoints ──

  const readCache = new Map<string, { at: number; json: string }>()

  /** Serialized `build()`, shared by every caller for `ttl` ms (default READ_CACHE_MS). */
  function cachedJson(key: string, build: () => unknown, ttl = READ_CACHE_MS): string {
    const now = Date.now()
    const hit = readCache.get(key)
    if (hit && now - hit.at < ttl) return hit.json
    const json = JSON.stringify(build())
    readCache.delete(key)
    readCache.set(key, { at: now, json })
    while (readCache.size > READ_CACHE_MAX) readCache.delete(readCache.keys().next().value as string)
    return json
  }

  function dropPayoutCache() {
    for (const k of [...readCache.keys()]) if (k.startsWith('payouts')) readCache.delete(k)
  }

  /** server/auth throws errors carrying an HTTP status; pass those through as HttpError. */
  function authCall<T>(fn: () => T): T {
    try {
      return fn()
    } catch (e) {
      const status = (e as { status?: unknown })?.status
      if (typeof status === 'number' && status >= 400 && status < 600) {
        throw new HttpError(status, ((e as Error).message || 'request refused').slice(0, 200), status === 429 ? { 'Retry-After': '60' } : undefined)
      }
      throw e
    }
  }

  /** Same-host, localhost, or explicitly configured origin. */
  function originAllowed(origin: string, hostHeader: string | undefined): boolean {
    const o = origin.trim().replace(/\/$/, '')
    if (LOCAL_ORIGIN.test(o) || corsExtra.has(o)) return true
    try {
      return !!hostHeader && new URL(o).host.toLowerCase() === hostHeader.toLowerCase()
    } catch {
      return false
    }
  }

  /** Bound to loopback: refuse foreign Host headers (DNS rebinding). */
  function hostAllowed(req: http.IncomingMessage): boolean {
    if (!loopbackOnly) return true
    const h = req.headers.host
    return !h || LOCAL_HOST_HEADER.test(h)
  }

  function applyCors(req: http.IncomingMessage, res: http.ServerResponse) {
    const origin = req.headers.origin
    if (!origin) return
    if (LOCAL_ORIGIN.test(origin) || corsExtra.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Max-Age', '600')
    }
  }

  function limit(lim: ReturnType<typeof createLimiter>, req: http.IncomingMessage, what: string) {
    const wait = lim.take(clientIp(req))
    if (wait > 0) throw new HttpError(429, `too many ${what} requests — slow down`, { 'Retry-After': String(Math.ceil(wait / 1000)) })
  }

  function requireJson(req: http.IncomingMessage) {
    // A cross-site form / no-cors fetch can only send text/plain, urlencoded or multipart
    // without a CORS preflight; insisting on JSON forces the preflight we refuse.
    const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (ct !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json')
  }

  function sendJson(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    let data: string
    try {
      data = JSON.stringify(body)
    } catch {
      status = 500
      data = '{"error":"serialization failed"}'
    }
    sendJsonText(req, res, status, data, headers)
  }

  function sendJsonText(req: http.IncomingMessage, res: http.ServerResponse, status: number, data: string, headers: Record<string, string> = {}) {
    const base: Record<string, string | number> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    }
    if (data.length > 8192 && acceptsGzip(req)) {
      zlib.gzip(data, { level: 5 }, (err, gz) => {
        if (res.writableEnded || res.destroyed) return
        if (err) {
          res.writeHead(status, { ...base, 'Content-Length': Buffer.byteLength(data) })
          res.end(data)
          return
        }
        res.writeHead(status, { ...base, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': gz.length })
        res.end(gz)
      })
      return
    }
    res.writeHead(status, { ...base, 'Content-Length': Buffer.byteLength(data) })
    res.end(data)
  }

  /** Immutable JSON (closed proof epochs): gzipped once per ETag, then served from memory. */
  const immutableGz = new Map<string, Promise<Buffer>>()
  function sendImmutableJson(req: http.IncomingMessage, res: http.ServerResponse, text: string, etag: string, headers: Record<string, string>) {
    const base: Record<string, string | number> = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ETag: etag, ...headers }
    if (text.length <= 8192 || !acceptsGzip(req)) {
      res.writeHead(200, { ...base, 'Content-Length': Buffer.byteLength(text) })
      res.end(text)
      return
    }
    let gz = immutableGz.get(etag)
    if (!gz) {
      gz = new Promise<Buffer>((resolve, reject) => zlib.gzip(text, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out))))
      immutableGz.set(etag, gz)
      gz.catch(() => immutableGz.delete(etag))
      while (immutableGz.size > 4) immutableGz.delete(immutableGz.keys().next().value as string)
    }
    gz.then(
      (buf) => {
        if (res.writableEnded || res.destroyed) return
        res.writeHead(200, { ...base, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': buf.length })
        res.end(buf)
      },
      () => {
        if (res.writableEnded || res.destroyed) return
        res.writeHead(200, { ...base, 'Content-Length': Buffer.byteLength(text) })
        res.end(text)
      },
    )
  }

  function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // Oversized bodies are rejected with 413 but still drained (so the client
      // reliably reads the response) up to a hard cap, beyond which we hang up.
      const DRAIN_CAP = 1024 * 1024
      const chunks: Buffer[] = []
      let size = 0
      let done = false
      const tooLarge = () => {
        done = true
        reject(new HttpError(413, `body exceeds ${BODY_LIMIT} bytes`, { Connection: 'close' }))
      }
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (done) {
          if (size > DRAIN_CAP) req.destroy()
          return
        }
        if (size > BODY_LIMIT) return tooLarge()
        chunks.push(chunk)
      })
      const declared = Number(req.headers['content-length'] ?? 0)
      if (declared > BODY_LIMIT) {
        tooLarge() // the data listener keeps draining and hangs up past DRAIN_CAP
        return
      }
      req.on('end', () => {
        if (done) return
        done = true
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text.trim()) return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new HttpError(400, 'invalid JSON body'))
        }
      })
      req.on('error', (e) => {
        if (done) return
        done = true
        reject(e)
      })
    })
  }

  function requireModules(): Modules {
    if (!modules) throw new HttpError(503, 'server is starting')
    return modules
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const method = req.method ?? 'GET'
    const p = url.pathname.replace(/\/+$/, '') || '/'
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Content-Length': 0 })
      res.end()
      return
    }
    const allow = (methods: string[]) => {
      if (!methods.includes(method)) throw new HttpError(405, 'method not allowed', { Allow: methods.join(', ') })
    }

    if (p === '/api/hello') {
      allow(['GET', 'HEAD'])
      limit(helloLimit, req, 'hello')
      return sendJsonText(req, res, 200, helloJson())
    }

    if (p === '/api/health') {
      // Always 200 while the process serves (the platform health check); problems are listed in `degraded`.
      // Not rate-limited: the platform's checker must never see a 429. Cached for 1 s instead.
      allow(['GET', 'HEAD'])
      return sendJsonText(req, res, 200, healthJson())
    }

    if (p === '/api/bot') {
      // Crawler identity for /privacy, /terms and the docs: LUSCA_BOT_CONTACT feeds the
      // user-agent, the From: header and this published takedown contact at once.
      allow(['GET', 'HEAD'])
      limit(statsLimit, req, 'stats')
      return sendJson(req, res, 200, BOT_INFO, { 'Cache-Control': 'public, max-age=300' })
    }

    if (p === '/api/stats') {
      allow(['GET', 'HEAD'])
      limit(statsLimit, req, 'stats')
      return sendJson(req, res, 200, { stats: buildStats(), sectors: buildSectors() })
    }

    const traceMatch = /^\/api\/agents\/(\d{1,6})\/traces$/.exec(p)
    if (traceMatch) {
      allow(['GET', 'HEAD'])
      const m = requireModules()
      limit(readLimit, req, 'read')
      const id = Number(traceMatch[1])
      const n = Math.min(200, Math.max(1, Number(url.searchParams.get('n')) || 200))
      return sendJsonText(req, res, 200, cachedJson(`traces:${id}:${n}`, () => safe('crawler.agentTraces', () => m.crawler.agentTraces(id, n), [])))
    }

    if (p === '/api/pages') {
      allow(['GET', 'HEAD'])
      const m = requireModules()
      limit(pagesLimit, req, 'page search')
      const sRaw = url.searchParams.get('sector')
      let sector: number | null = null
      if (sRaw !== null && sRaw !== '') {
        const s = Number(sRaw)
        if (!Number.isInteger(s) || s < 0 || s > 7) throw new HttpError(400, 'sector must be an integer 0..7')
        sector = s
      }
      const q = (url.searchParams.get('q') ?? '').slice(0, 200)
      const n = Math.min(200, Math.max(1, Number(url.searchParams.get('n')) || 200))
      return sendJson(req, res, 200, safe('crawler.searchPages', () => m.crawler.searchPages(q, sector, n), []))
    }

    if (p === '/api/generate') {
      allow(['POST'])
      requireJson(req)
      const m = requireModules()
      const body = (await readJsonBody(req)) as { prompt?: unknown; n?: unknown; temperature?: unknown }
      if (!body || typeof body !== 'object') throw new HttpError(400, 'expected a JSON object')
      if (body.prompt !== undefined && typeof body.prompt !== 'string') throw new HttpError(400, 'prompt must be a string')
      const prompt = (typeof body.prompt === 'string' ? body.prompt : '').replace(/\r\n?/g, '\n').slice(0, 200)
      const nRaw = body.n === undefined ? 240 : Number(body.n)
      if (!Number.isFinite(nRaw)) throw new HttpError(400, 'n must be a number')
      const n = Math.min(600, Math.max(1, Math.round(nRaw)))
      const tRaw = body.temperature === undefined ? 0.8 : Number(body.temperature)
      if (!Number.isFinite(tRaw)) throw new HttpError(400, 'temperature must be a number')
      const temperature = Math.min(2, Math.max(0.05, tRaw))

      const wait = generateLimit.take(clientIp(req))
      if (wait > 0) throw new HttpError(429, 'too many generations — slow down', { 'Retry-After': String(Math.ceil(wait / 1000)) })
      if (generating >= GENERATE_CONCURRENCY) throw new HttpError(503, 'SEPIA is busy — retry in a moment', { 'Retry-After': '1' })
      generating++
      let timer: NodeJS.Timeout | undefined
      try {
        const out = await Promise.race([
          Promise.resolve().then(() => m.trainer.generate(prompt, n, temperature)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new HttpError(504, 'generation timed out')), GENERATE_TIMEOUT_MS)
          }),
        ])
        if (!out || typeof out.text !== 'string') throw new HttpError(500, 'generation failed')
        return sendJson(req, res, 200, { text: out.text, ms: Number.isFinite(out.ms) ? out.ms : 0 })
      } finally {
        if (timer) clearTimeout(timer)
        generating--
      }
    }

    if (p === '/api/spawn') {
      allow(['POST'])
      requireJson(req)
      const m = requireModules()
      const body = (await readJsonBody(req)) as { name?: unknown; owner?: unknown; sector?: unknown }
      if (!body || typeof body !== 'object') throw new HttpError(400, 'expected a JSON object')
      const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : ''
      if (!/^[a-z0-9-]{2,16}$/.test(name)) throw new HttpError(400, 'name must be 2–16 chars of a-z, 0-9 or -')
      const sector = Number(body.sector)
      if (!Number.isInteger(sector) || sector < 0 || sector > 7) throw new HttpError(400, 'sector must be an integer 0..7')
      let owner: string | null = null
      if (typeof body.owner === 'string') {
        // eslint-disable-next-line no-control-regex -- stripping control characters is the point
        owner = body.owner.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 64) || null
      } else if (body.owner !== undefined && body.owner !== null) {
        throw new HttpError(400, 'owner must be a string or null')
      }
      const ip = clientIp(req)
      const retry = (ms: number) => ({ 'Retry-After': String(Math.ceil(ms / 1000)) })
      const wait = spawnLimit.check(ip)
      if (wait > 0) throw new HttpError(429, `one spawn per 10 s — retry in ${Math.ceil(wait / 1000)} s`, retry(wait))
      const waitLive = spawnLiveLimit.check(ip)
      if (waitLive > 0) {
        throw new HttpError(429, `at most ${SPAWNS_PER_IP_LIVE} live spawned agents per address (they retire after ${Math.round(SPAWN_TTL_MS / 3_600_000)} h) — retry in ${Math.ceil(waitLive / 60_000)} min`, retry(waitLive))
      }
      const waitGlobal = spawnGlobalLimit.check('*')
      if (waitGlobal > 0) throw new HttpError(429, `the spawn budget for this hour is used up — retry in ${Math.ceil(waitGlobal / 60_000)} min`, retry(waitGlobal))
      let agent
      try {
        agent = m.crawler.spawn(name, owner, sector)
      } catch (e) {
        const code = (e as { code?: unknown })?.code
        const msg = ((e as Error)?.message || 'spawn failed').slice(0, 200)
        if (code === 'name-taken') throw new HttpError(409, msg)
        if (code === 'cap') throw new HttpError(429, msg, { 'Retry-After': '600' })
        throw new HttpError(400, msg)
      }
      // Budgets are charged only for spawns that happened.
      spawnLimit.take(ip)
      spawnLiveLimit.take(ip)
      spawnGlobalLimit.take('*')
      log.info('spawn', `${name} → arm ${SECTORS[sector]?.roman ?? sector}${owner ? ` (owner ${owner.slice(0, 12)})` : ''}`)
      return sendJson(req, res, 200, agent)
    }

    if (p === '/api/ledger') {
      allow(['GET', 'HEAD'])
      const m = requireModules()
      limit(readLimit, req, 'read')
      const wallet = url.searchParams.get('wallet')
      if (wallet) {
        const acc = m.coordinator.balance ? safe('coordinator.balance', () => m.coordinator.balance!(wallet.slice(0, 128)), null) : null
        return sendJson(req, res, 200, { wallet, account: acc })
      }
      // The leaderboard sorts every account: build it at most once per READ_CACHE_MS for everyone.
      return sendJsonText(req, res, 200, cachedJson('ledger', () => {
        const snap = m.coordinator.ledger ? safe('coordinator.ledger', () => m.coordinator.ledger!(), null) : null
        return snap ?? { updatedAt: Date.now(), totals: null, leaderboard: [] }
      }))
    }

    if (p === '/api/neurons') {
      allow(['GET', 'HEAD'])
      const m = requireModules()
      limit(readLimit, req, 'read')
      return sendJsonText(req, res, 200, cachedJson('neurons', () => safe('coordinator.neurons', () => m.coordinator.neurons(), [])))
    }

    // ── wallet sign-in (one signed message; no transaction) ──
    // Every /api route is behind the Origin guard in onRequest (CSRF / DNS rebinding).

    if (p === '/api/auth/nonce') {
      allow(['GET'])
      const m = requireModules()
      if (!m.auth) throw new HttpError(503, 'wallet sign-in is not available on this server')
      limit(authLimit, req, 'sign-in')
      const auth = m.auth
      const wallet = url.searchParams.get('wallet')
      if (!isSolanaAddress(wallet)) throw new HttpError(400, 'wallet must be a Solana address (base58, 32 bytes)')
      const out = authCall(() => auth.issueNonce(wallet, req.headers.host, clientIp(req)))
      return sendJson(req, res, 200, out)
    }

    if (p === '/api/auth/verify') {
      allow(['POST'])
      requireJson(req)
      const m = requireModules()
      if (!m.auth) throw new HttpError(503, 'wallet sign-in is not available on this server')
      limit(authLimit, req, 'sign-in')
      const auth = m.auth
      const body = await readJsonBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected a JSON object')
      const out = authCall(() => auth.verify(body, clientIp(req)))
      log.info('auth', `wallet verified ${out.wallet.slice(0, 4)}…${out.wallet.slice(-4)}`)
      return sendJson(req, res, 200, out)
    }

    // Right after sign-in: this device's current-period credits move to the verified wallet (the
    // same move a verified neuron.register makes), so the panel shows them on the wallet at once.
    if (p === '/api/auth/link-device') {
      allow(['POST'])
      requireJson(req)
      const m = requireModules()
      const coord = m.coordinator
      if (!coord.linkDevice) throw new HttpError(503, 'wallet sign-in is not available on this server')
      limit(authLimit, req, 'sign-in')
      const body = (await readJsonBody(req)) as { token?: unknown; deviceId?: unknown } | null
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected a JSON object')
      if (typeof body.deviceId !== 'string' || !DEVICE_ID_RE.test(body.deviceId)) throw new HttpError(400, 'deviceId must match [A-Za-z0-9_-]{6,64}')
      const ip = clientIp(req)
      const out = safe('coordinator.linkDevice', () => coord.linkDevice!(body.token, body.deviceId, ip), null)
      if (!out) throw new HttpError(401, 'session token is invalid or expired — verify the wallet again')
      return sendJson(req, res, 200, out)
    }

    // ── SOL payouts (read-only) ──

    if (p === '/api/payouts') {
      allow(['GET', 'HEAD'])
      const m = requireModules()
      if (!m.payouts) throw new HttpError(503, 'payouts are not available on this server')
      limit(readLimit, req, 'read')
      const payouts = m.payouts
      return sendJsonText(req, res, 200, cachedJson('payouts', () => payouts.overview(), PAYOUTS_CACHE_MS))
    }

    const walletMatch = /^\/api\/payouts\/wallet\/([^/]{1,64})$/.exec(p)
    if (walletMatch) {
      allow(['GET', 'HEAD'])
      const m = requireModules()
      if (!m.payouts) throw new HttpError(503, 'payouts are not available on this server')
      limit(readLimit, req, 'read')
      let address: string
      try {
        address = decodeURIComponent(walletMatch[1])
      } catch {
        throw new HttpError(400, 'wallet must be a Solana address (base58, 32 bytes)')
      }
      if (!isSolanaAddress(address)) throw new HttpError(400, 'wallet must be a Solana address (base58, 32 bytes)')
      const payouts = m.payouts
      return sendJsonText(req, res, 200, cachedJson(`payouts:w:${address}`, () => payouts.wallet(address), PAYOUTS_CACHE_MS))
    }

    // ── protocol code index (what SEPIA-1 will read; read-only) ──

    if (p === '/api/code/stats') {
      allow(['GET', 'HEAD'])
      const m = requireModules()
      if (!m.code) throw new HttpError(503, 'the code index is not available on this server')
      limit(readLimit, req, 'read')
      const code = m.code
      return sendJsonText(req, res, 200, cachedJson('code:stats', () => code.stats(), CODE_STATS_CACHE_MS))
    }

    // ── chain agents (programs / contracts they found and read; stored data only, no RPC here) ──

    if (p === '/api/chain/stats' || p === '/api/chain/feed' || p === '/api/chain/items' || p.startsWith('/api/chain/item/')) {
      allow(['GET', 'HEAD'])
      const m = requireModules()
      if (!m.chain) throw new HttpError(503, 'chain agents are not available on this server')
      limit(readLimit, req, 'read')
      const chainApi = m.chain
      const shortCache = { 'Cache-Control': 'public, max-age=5' }

      if (p === '/api/chain/stats') {
        return sendJsonText(req, res, 200, cachedJson('chain:stats', () => chainApi.stats(), CHAIN_CACHE_MS), shortCache)
      }

      if (p === '/api/chain/feed') {
        const raw = url.searchParams.get('limit')
        const n = raw === null || raw === '' ? 50 : Number(raw)
        if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit must be an integer from 1 to 200')
        const lim = Math.min(200, n)
        // ?scan=1: with each read's call trace and decoded fields (the /scan page; ≤ 50 events, ≤ 8 KB each)
        const withScan = url.searchParams.get('scan') === '1'
        if (withScan) {
          const ls = Math.min(50, lim)
          return sendJsonText(req, res, 200, cachedJson(`chain:feed:scan:${ls}`, () => chainApi.feed(ls), CHAIN_CACHE_MS), shortCache)
        }
        const lean = () => chainApi.feed(lim).map(({ trace: _t, scan: _s, ...ev }) => ev)
        return sendJsonText(req, res, 200, cachedJson(`chain:feed:${lim}`, lean, CHAIN_CACHE_MS), shortCache)
      }

      if (p === '/api/chain/items') {
        const chainQ = url.searchParams.get('chain') || ''
        if (chainQ && !CHAIN_IDS.has(chainQ as ChainId)) throw new HttpError(400, 'chain must be solana, ethereum, base or arbitrum')
        const rawLimit = url.searchParams.get('limit')
        const n = rawLimit === null || rawLimit === '' ? 50 : Number(rawLimit)
        if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit must be an integer from 1 to 200')
        const lim = Math.min(200, n)
        const cursor = url.searchParams.get('cursor') || ''
        if (cursor && !CHAIN_CURSOR_RE.test(cursor)) throw new HttpError(400, 'cursor is not one this server issued')
        const q = { chain: (chainQ || undefined) as ChainId | undefined, limit: lim, cursor: cursor || undefined }
        return sendJsonText(req, res, 200, cachedJson(`chain:items:${chainQ}:${lim}:${cursor}`, () => chainApi.items(q), CHAIN_CACHE_MS), shortCache)
      }

      const itemMatch = /^\/api\/chain\/item\/([a-z]{1,16})\/([^/]{1,64})$/.exec(p)
      if (!itemMatch) throw new HttpError(404, 'not found')
      const chain = itemMatch[1] as ChainId
      if (!CHAIN_IDS.has(chain)) throw new HttpError(400, 'chain must be solana, ethereum, base or arbitrum')
      let address: string
      try {
        address = decodeURIComponent(itemMatch[2])
      } catch {
        throw new HttpError(400, 'address is not valid for this chain')
      }
      if (chain === 'solana' ? !isSolanaAddress(address) : !EVM_ADDRESS_RE.test(address)) throw new HttpError(400, 'address is not valid for this chain')
      const key = `chain:item:${chain}:${chain === 'solana' ? address : address.toLowerCase()}`
      const json = cachedJson(key, () => chainApi.item(chain, address), CHAIN_ITEM_CACHE_MS)
      if (json === 'null') {
        readCache.delete(key) // a miss is not cached: the address may be kept a moment later
        throw new HttpError(404, 'not in the kept index')
      }
      return sendJsonText(req, res, 200, json, { 'Cache-Control': 'public, max-age=30' })
    }

    // ── proof of contribution: epoch headers, public leaves, your own Merkle paths (server/proofs) ──
    if (p === '/api/proofs' || p.startsWith('/api/proofs/')) {
      const m = requireModules()
      if (!m.proofs) throw new HttpError(503, 'contribution proofs are not available on this server')
      const post = method === 'POST'
      limit(post ? proofLimit : readLimit, req, post ? 'proof lookup' : 'read')
      if (post) requireJson(req)
      const body = post ? await readJsonBody(req) : null
      const proofs = m.proofs
      const out = authCall(() => handleProofRoute(proofs.api, proofs.preview, p, method, url.searchParams, body))
      if (out) {
        const cache: Record<string, string> = out.maxAge ? { 'Cache-Control': `public, max-age=${out.maxAge}` } : {}
        if (out.text !== undefined && out.etag) {
          if (req.headers['if-none-match'] === out.etag) {
            res.writeHead(304, { ...cache, ETag: out.etag })
            return res.end()
          }
          return sendImmutableJson(req, res, out.text, out.etag, cache)
        }
        return sendJson(req, res, out.status, out.body, cache)
      }
    }

    // ── UPGRADE RADAR: code changes caught live (server/radar; stored events only, no RPC here) ──
    if (p === '/api/radar' || p.startsWith('/api/radar/')) {
      allow(['GET', 'HEAD'])
      const m = requireModules()
      if (!m.radar) throw new HttpError(503, 'the upgrade radar is not available on this server')
      limit(readLimit, req, 'read')
      const radar = m.radar
      const shortCache = { 'Cache-Control': 'public, max-age=3' }
      if (p === '/api/radar') {
        const chainQ = url.searchParams.get('chain') || ''
        if (chainQ && !CHAIN_IDS.has(chainQ as ChainId)) throw new HttpError(400, 'chain must be solana, ethereum, base or arbitrum')
        const kindQ = url.searchParams.get('kind') || ''
        if (kindQ && !(RADAR_KINDS as readonly string[]).includes(kindQ)) throw new HttpError(400, `kind must be one of ${RADAR_KINDS.join(', ')}`)
        const knownQ = url.searchParams.get('known') || ''
        if (knownQ && knownQ !== '1' && knownQ !== '0') throw new HttpError(400, 'known must be 1 or 0')
        const otherQ = url.searchParams.get('other') || ''
        if (otherQ && otherQ !== '1' && otherQ !== '0') throw new HttpError(400, 'other must be 1 or 0')
        const rawLimit = url.searchParams.get('limit')
        const n = rawLimit === null || rawLimit === '' ? 50 : Number(rawLimit)
        if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit must be an integer from 1 to 100')
        const cursor = url.searchParams.get('cursor') || ''
        if (cursor && !RADAR_ID_RE.test(cursor)) throw new HttpError(400, 'cursor is not one this server issued')
        const sortQ = url.searchParams.get('sort') || 'new'
        if (sortQ !== 'new' && sortQ !== 'priority') throw new HttpError(400, 'sort must be new or priority')
        const q = {
          chain: (chainQ || undefined) as ChainId | undefined,
          kind: (kindQ || undefined) as RadarKind | undefined,
          other: otherQ === '1',
          known: knownQ === '1',
          sort: sortQ as 'new' | 'priority',
          limit: Math.min(100, n),
          cursor: cursor || undefined,
        }
        const key = `radar:${chainQ}:${kindQ}:${otherQ}:${knownQ}:${sortQ}:${q.limit}:${cursor}`
        return sendJsonText(req, res, 200, cachedJson(key, () => radar.list(q), RADAR_CACHE_MS), shortCache)
      }
      const id = p.slice('/api/radar/'.length)
      if (!RADAR_ID_RE.test(id)) throw new HttpError(404, 'not found')
      const json = cachedJson(`radar:item:${id}`, () => radar.get(id), RADAR_CACHE_MS)
      if (json === 'null') {
        readCache.delete(`radar:item:${id}`)
        throw new HttpError(404, 'no radar event with this id')
      }
      return sendJsonText(req, res, 200, json, shortCache)
    }

    // ── LUSCA Lens: on-demand reads of one program / contract (server/lens; its own limits and budget) ──
    if (p.startsWith('/api/lens/')) {
      allow(['GET', 'HEAD'])
      const m = requireModules()
      if (!m.lens) throw new HttpError(503, 'LUSCA Lens is not available on this server')
      const r = await m.lens.route(p, clientIp(req))
      return sendJsonText(req, res, r.status, r.json, r.headers)
    }

    // ── SEPIA-0 weights export: newest checkpoint as safetensors + manifest (server/model/export.ts) ──
    if (p.startsWith('/api/model/')) {
      const m = requireModules()
      if (!m.model) throw new HttpError(503, 'the weights export is not available on this server')
      if (await handleModelRoute(p, req, res, { exporter: m.model, take: (r) => modelLimit.take(clientIp(r)) })) return
    }

    throw new HttpError(404, 'not found')
  }

  /** Client routes as declared in src/App.tsx (first segment → allowed extra segments). */
  const CLIENT_ROUTES: Record<string, number> = { live: 0, node: 0, sepia: 0, earn: 0, privacy: 0, terms: 0, scan: 0, radar: 0, agents: 1, docs: 1, chain: 2, lens: 2 }
  function isClientRoute(segs: string[]): boolean {
    if (segs.length === 0) return true
    const first = segs[0].toLowerCase() // react-router matches case-insensitively
    return Object.prototype.hasOwnProperty.call(CLIENT_ROUTES, first) && segs.length - 1 <= CLIENT_ROUTES[first]
  }

  // ── share links: X reads the player-card tags, people are sent on to the page ──
  const SHARES: Record<string, { title: string; description: string; player: string; image: string; page: string }> = {
    scan: {
      title: 'LUSCA Scan · live',
      description: 'LUSCA chain agents reading Solana programs and EVM contracts, call by call. Solana reads through Helius.',
      player: '/play/scan',
      image: '/play/scan-card.jpg',
      page: '/scan',
    },
  }
  const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const radarGetter = () => (modules?.radar ? (id: string) => modules!.radar!.get(id) : null)

  function serveShare(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed', { Allow: 'GET, HEAD' })
    const m = /^\/r\/([a-z0-9-]{1,32})\/?$/.exec(url.pathname)
    // feed cards (server/share/cards.ts): /r/radar, /r/radar/:id (stored events only), /r/lens/:chain/:address
    const s = (m ? SHARES[m[1]] : undefined) ?? resolveShare(url.pathname, radarGetter())
    if (!s) throw new HttpError(404, 'not found')
    const host = String(req.headers.host ?? '').toLowerCase()
    const origin = canonicalHost ? `https://${canonicalHost}` : `${viaHttps(req) ? 'https' : 'http'}://${/^[a-z0-9.-]+(:\d{1,5})?$/.test(host) ? host : 'localhost'}`
    // X's crawler reads the tags and must not be sent away; people go straight to the page
    const bot = /twitterbot|facebookexternalhit|slackbot|discordbot|telegrambot|linkedinbot|whatsapp/i.test(String(req.headers['user-agent'] ?? ''))
    const tags = [
      ['name', 'twitter:card', 'player'],
      ['name', 'twitter:site', '@lusca_ai'],
      ['name', 'twitter:title', s.title],
      ['name', 'twitter:description', s.description],
      ['name', 'twitter:player', origin + s.player],
      ['name', 'twitter:player:width', '480'],
      ['name', 'twitter:player:height', '480'],
      ['name', 'twitter:image', origin + s.image],
      ['property', 'og:type', 'website'],
      ['property', 'og:title', s.title],
      ['property', 'og:description', s.description],
      ['property', 'og:url', origin + s.page],
      ['property', 'og:image', origin + s.image],
    ]
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${attr(s.title)}</title>
<meta name="description" content="${attr(s.description)}">
${tags.map(([k, n, v]) => `<meta ${k}="${n}" content="${attr(v)}">`).join('\n')}
<link rel="canonical" href="${attr(origin + s.page)}">${bot ? '' : `
<meta http-equiv="refresh" content="0; url=${attr(s.page)}">`}
</head><body style="background:#050505;color:#ecebe6;font:15px system-ui,sans-serif;padding:32px"><a style="color:#ff4d00" href="${attr(s.page)}">${attr(origin.replace(/^https?:\/\//, '') + s.page)}</a></body></html>`
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'public, max-age=300', Vary: 'User-Agent' })
    res.end(method === 'HEAD' ? undefined : html)
  }

  async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const method = req.method ?? 'GET'
    if (!distReady() || !distDir) {
      if (url.pathname === '/' && (method === 'GET' || method === 'HEAD')) {
        const html = `<!doctype html><meta charset="utf-8"><title>LUSCA server</title>
<body style="background:#0b0b0c;color:#ecebe6;font:15px/1.6 system-ui,sans-serif;padding:48px">
<h1 style="color:#ff4d00;letter-spacing:.08em">LUSCA</h1>
<p>The LUSCA server is running. The web client is not built here.</p>
<ul><li>Dev: <code>npm run dev</code> and open <a style="color:#ff4d00" href="http://localhost:5173">localhost:5173</a></li>
<li>Production: <code>npm run build</code>, then restart this server.</li>
<li>API: <a style="color:#ff4d00" href="/api/hello">/api/hello</a> · <a style="color:#ff4d00" href="/api/health">/api/health</a> · socket <code>/ws</code></li></ul></body>`
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' })
        res.end(method === 'HEAD' ? undefined : html)
        return
      }
      throw new HttpError(404, 'not found')
    }
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed', { Allow: 'GET, HEAD' })

    let rel: string
    try {
      rel = decodeURIComponent(url.pathname)
    } catch {
      throw new HttpError(400, 'bad path')
    }
    if (rel.includes('\0')) throw new HttpError(400, 'bad path')
    // feed-card players: /play/radar/:id and /play/lens/:chain/:address are one static page each
    const pf = playerFile(url.pathname, radarGetter())
    if (pf === null) throw new HttpError(404, 'not found')
    if (pf) rel = pf
    let file = path.resolve(distDir, '.' + path.posix.normalize('/' + rel))
    if (file !== distDir && !file.startsWith(distDir + path.sep)) throw new HttpError(403, 'forbidden')

    let st: fs.Stats | null = null
    try {
      st = await fs.promises.stat(file)
      if (st.isDirectory()) {
        file = path.join(file, 'index.html')
        st = await fs.promises.stat(file)
      }
    } catch {
      st = null
    }
    let status = 200
    if (!st || !st.isFile()) {
      // SPA fallback (no extension, or the browser asks for html). Known client routes get 200;
      // anything else still gets the client shell so its NotFound page renders, but under a real
      // 404 so search engines and scanners do not treat arbitrary URLs as pages.
      const segs = rel.split('/').filter(Boolean)
      if (segs.some((s) => s.startsWith('.'))) throw new HttpError(404, 'not found')
      const ext = path.extname(rel)
      const wantsHtml = (req.headers.accept ?? '').includes('text/html')
      if (ext && !wantsHtml) throw new HttpError(404, 'not found')
      if (!isClientRoute(segs)) status = 404
      file = path.join(distDir, 'index.html')
      try {
        st = await fs.promises.stat(file)
      } catch {
        throw new HttpError(404, 'not found')
      }
    }

    const ext = path.extname(file).toLowerCase()
    const type = MIME[ext] ?? 'application/octet-stream'
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
    const immutable = /[\\/]assets[\\/]/.test(file.slice(distDir.length)) && ext !== '.html'
    const headers: Record<string, string | number> = {
      'Content-Type': type,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'no-cache' : 'public, max-age=300',
      ETag: etag,
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      'X-Content-Type-Options': 'nosniff',
    }
    if (status === 200 && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    if (status !== 200) {
      // a 404 page is not a cacheable representation of this URL
      headers['Cache-Control'] = 'no-store'
      delete headers.ETag
      delete headers['Last-Modified']
    }
    const compress = COMPRESSIBLE.test(type) && st.size > 1024 && acceptsGzip(req)
    if (compress) {
      const gz = await gzipCached(file, st)
      res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': gz.length })
      res.end(method === 'HEAD' ? undefined : gz)
      return
    }
    res.writeHead(status, { ...headers, 'Content-Length': st.size })
    if (method === 'HEAD') {
      res.end()
      return
    }
    const stream = fs.createReadStream(file)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  // LUSCA_CANONICAL_HOST (e.g. lusca.ink): page requests that arrive on the platform hostname
  // (*.onrender.com) get a 301 to the canonical host, so visitors, share links and the wallet
  // sign-in message all use one domain. API, WebSocket and health requests are never redirected.
  const canonicalHost = (process.env.LUSCA_CANONICAL_HOST ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const shouldCanonicalize = (req: http.IncomingMessage, isApi: boolean) => {
    if (!canonicalHost || isApi || (req.method !== 'GET' && req.method !== 'HEAD')) return false
    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
    return host !== canonicalHost && host.endsWith('.onrender.com')
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      let url: URL
      try {
        url = new URL(req.url ?? '/', 'http://localhost')
      } catch {
        url = new URL('http://localhost/')
      }
      try {
        observeProxy(req)
        applySecurityHeaders(req, res)
        if (!hostAllowed(req)) throw new HttpError(421, 'unexpected Host header')
        applyCors(req, res)
        const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/')
        if (shouldCanonicalize(req, isApi) && url.pathname !== '/ws') {
          res.writeHead(301, { Location: `https://${canonicalHost}${url.pathname}${url.search}`, 'Cache-Control': 'public, max-age=3600' })
          res.end()
          return
        }
        // A foreign page must not drive the API from a visitor's browser (CSRF / DNS rebinding);
        // same-host, localhost and configured origins are fine, a missing Origin (curl, CLI) too.
        if (isApi && req.method !== 'OPTIONS' && req.headers.origin && !originAllowed(req.headers.origin, req.headers.host)) {
          throw new HttpError(403, 'origin not allowed')
        }
        if (isApi) await handleApi(req, res, url)
        else if (url.pathname === '/ws') throw new HttpError(426, 'websocket upgrade required', { Upgrade: 'websocket' })
        else if (url.pathname.startsWith('/r/')) serveShare(req, res, url)
        else await serveStatic(req, res, url)
      } catch (e) {
        const he = e instanceof HttpError ? e : null
        if (!he) logThrottled(`http ${req.method} ${url.pathname}`, e)
        if (res.headersSent || res.destroyed) {
          res.destroy()
          return
        }
        const status = he?.status ?? 500
        sendJson(req, res, status, { error: he?.message ?? 'internal error' }, he?.headers ?? {})
      }
    })()
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 15_000
  server.keepAliveTimeout = 5_000
  server.on('clientError', (err, socket) => {
    if ((err as NodeJS.ErrnoException).code === 'ECONNRESET' || !socket.writable) {
      socket.destroy()
      return
    }
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy())
    let pathname = ''
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      /* fallthrough → 404 */
    }
    const reject = (code: number, text: string) => {
      try {
        socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      } catch {
        /* ignore */
      }
      socket.destroy()
    }
    if (pathname !== '/ws') return reject(404, 'Not Found')
    if (shuttingDown) return reject(503, 'Service Unavailable')
    if (!hostAllowed(req)) return reject(421, 'Misdirected Request')
    // WebSockets are not covered by CORS: check Origin here (no Origin = Node CLI neuron, allowed).
    const origin = req.headers.origin
    if (origin && !originAllowed(origin, req.headers.host)) return reject(403, 'Forbidden')
    observeProxy(req)
    const ip = clientIp(req)
    if (clients.size >= L.maxClients || (perIp.get(ip) ?? 0) >= L.maxClientsPerIp) return reject(503, 'Service Unavailable')
    if (wsConnectLimit.take(ip) > 0) return reject(429, 'Too Many Requests')
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        try {
          onConnection(ws, ip)
        } catch (e) {
          logThrottled('ws.connection', e)
          ws.terminate()
        }
      })
    } catch (e) {
      logThrottled('ws.upgrade', e)
      socket.destroy()
    }
  })

  function startTimers() {
    if (statsTimer) return
    statsTimer = setInterval(() => {
      // Slow-client accounting: total backlog (shared pressure) and per-client time above SOFT_BUFFER.
      const now = Date.now()
      let total = 0
      for (const c of clients) {
        const b = c.ws.bufferedAmount
        total += b
        if (b <= SOFT_BUFFER + jobAllowance(c, now)) c.overSoftSince = 0
        else if (!c.overSoftSince) c.overSoftSince = now
        else if (now - c.overSoftSince > SLOW_CLIENT_MS) {
          log.warn('ws', `terminating ${c.id} (${c.ip}): ${(b / 1048576).toFixed(1)} MB backlog for over ${SLOW_CLIENT_MS / 1000} s`)
          c.ws.terminate()
        }
      }
      totalBuffered = total
      if (clients.size === 0) return
      emit({ t: 'stats', stats: buildStats(), sectors: buildSectors() })
    }, STATS_MS)
    heartbeatTimer = setInterval(() => {
      for (const c of clients) {
        if (!c.alive) {
          c.ws.terminate()
          continue
        }
        c.alive = false
        try {
          c.ws.ping()
        } catch {
          c.ws.terminate()
        }
      }
    }, HEARTBEAT_MS)
    // Health is evaluated on a timer too, so a degraded state is logged even when nobody polls.
    loopMon.enable()
    healthTimer = setInterval(() => {
      try {
        healthJson()
      } catch (e) {
        logThrottled('health', e)
      }
    }, HEALTH_TICK_MS)
    healthTimer.unref?.()
  }

  function logStartup() {
    const mb = (n: number) => `${Math.round(n / 1048576)} MB`
    log.info(
      'hub',
      `caps: ${L.maxClients} sockets (${L.maxClientsPerIp} per address) · backlog ${mb(SOFT_BUFFER)} soft / ${mb(HARD_BUFFER)} hard per socket, ` +
        `${mb(TOTAL_BUFFER_LIMIT)} total · stream ${STREAM_RATE > 0 ? `${Math.round(STREAM_RATE / 1024)} KB/s per client` : 'unlimited'} · ` +
        `CSP ${cspMode} · HSTS ${hstsMaxAge > 0 ? `${hstsMaxAge} s on https` : 'off'}`,
    )
    if (trust.invalid.length) log.warn('proxy', `LUSCA_TRUSTED_PROXIES: ignoring unparseable entries: ${trust.invalid.map((s) => JSON.stringify(s)).join(', ')}`)
    if (trustHops > 0) {
      const what = [...trust.keywords, ...trust.explicit]
      log.info('proxy', `X-Forwarded-For trusted from ${what.join(', ') || 'nothing (no valid range!)'} · client = untrusted hop #${trustHops} from the right · the first forwarded request is logged`)
    } else {
      log.info('proxy', 'X-Forwarded-For ignored (LUSCA_TRUST_PROXY=0): clients are keyed on the socket address')
    }
  }

  return {
    emit,
    server,
    bind(m: Modules) {
      modules = m
    },
    clientCount: () => clients.size,
    listen(port: number, host?: string) {
      return new Promise<number>((resolve, reject) => {
        const onError = (e: Error) => {
          server.off('listening', onListening)
          reject(e)
        }
        const onListening = () => {
          server.off('error', onError)
          // Bound to loopback only: Host headers are checked against local names (DNS rebinding).
          loopbackOnly = !!host && /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|::1|\[::1\])$/i.test(host)
          server.on('error', (e) => log.error('http', e))
          startTimers()
          logStartup()
          const addr = server.address()
          resolve(typeof addr === 'object' && addr ? addr.port : port)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        if (host) server.listen(port, host)
        else server.listen(port)
      })
    },
    async close() {
      if (shuttingDown) return
      shuttingDown = true
      if (statsTimer) clearInterval(statsTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (healthTimer) clearInterval(healthTimer)
      loopMon.disable()
      readCache.clear()
      if (agentTimer) clearTimeout(agentTimer)
      agentTimer = null
      pendingAgents.clear()
      for (const l of limiters) l.stop()
      for (const c of clients) {
        try {
          c.ws.close(1001, 'server shutting down')
        } catch {
          c.ws.terminate()
        }
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          for (const c of clients) c.ws.terminate()
          server.closeAllConnections?.()
          resolve()
        }, 2_000)
        t.unref?.()
        wss.close(() => undefined)
        server.close(() => {
          clearTimeout(t)
          resolve()
        })
        server.closeIdleConnections?.()
      })
    },
  }
}
