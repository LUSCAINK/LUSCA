// Network layer of the chain agents: JSON-RPC to Solana / EVM endpoints and polite JSON GETs to the
// verified-source registries (Sourcify, OtterSec), all under daily budgets.
//
//   endpoint            budget key          default limit / UTC day   used for
//   LUSCA_SOLANA_RPC    solana              8 000                     program reads (may embed an API key)
//   discovery RPC       solana-discovery    3 000                     block sampling (free public RPC)
//   ethereum/base/arb   <chain>             15 000 each               reads + block sampling
//   sourcify.dev        sourcify            5 000, ≤ 1 req/s          verified sources
//   verify.osec.io      osec                5 000, ≤ 1 req/s          verified builds
//
// Every endpoint: ≤ 2 requests in flight, 8 s timeout, response size capped while streaming (the
// request is aborted past the cap), a short cool-down after HTTP 429. Usage is persisted in
// <dataDir>/chain/budget.json and resets at 00:00 UTC. Endpoint URLs never appear in errors or
// logs: they can carry API keys (redact()).

import fs from 'node:fs'
import path from 'node:path'
import type { ChainId } from '../../shared/chain.ts'

export interface RpcCtx {
  call(chain: ChainId, method: string, params: unknown[], opts?: { discovery?: boolean; timeoutMs?: number; maxBytes?: number }): Promise<unknown>
  fetchJson(url: string, opts?: { timeoutMs?: number; maxBytes?: number; host?: 'sourcify' | 'osec' }): Promise<unknown>
  usage(): Record<string, { used: number; limit: number }>
  canSpend(chain: ChainId, n?: number, discovery?: boolean): boolean
}

export type EvmChain = 'ethereum' | 'base' | 'arbitrum'
export type BudgetKey = 'solana' | 'solana-discovery' | EvmChain | 'sourcify' | 'osec'
export const BUDGET_KEYS: BudgetKey[] = ['solana', 'solana-discovery', 'ethereum', 'base', 'arbitrum', 'sourcify', 'osec']

export const DEFAULT_ENDPOINTS: { solanaDiscovery: string } & Record<EvmChain, string> = {
  solanaDiscovery: 'https://api.mainnet-beta.solana.com',
  ethereum: 'https://ethereum-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
}

export const DEFAULT_LIMITS: Record<BudgetKey, number> = {
  solana: 8000,
  'solana-discovery': 3000,
  ethereum: 15000,
  base: 15000,
  arbitrum: 15000,
  sourcify: 5000,
  osec: 5000,
}

const MB = 1048576
const DAY = 86_400_000

/** Response caps by method when the caller gives none (programdata ≤ 12 MB arrives base64 inside JSON). */
const METHOD_MAX_BYTES: Record<string, number> = {
  getBlock: 10 * MB,
  getAccountInfo: 17 * MB,
  getMultipleAccounts: 17 * MB,
  eth_getBlockByNumber: 10 * MB,
  eth_getBlockReceipts: 10 * MB,
}
const DEFAULT_RPC_MAX_BYTES = 4 * MB
const DEFAULT_HTTP_MAX_BYTES = 8 * MB

export type RpcErrorKind = 'rpc' | 'http' | 'timeout' | 'network' | 'too-large' | 'bad-json' | 'host' | 'closed'

/** Any failure of call() / fetchJson(). The message names the endpoint by chain or registry, never by URL. */
export class RpcError extends Error {
  /** JSON-RPC error code (kind 'rpc'). */
  readonly code: number | null
  /** HTTP status (kind 'http'). */
  readonly status: number | null
  /** Worth retrying later (timeouts, network errors, 429 / 5xx, provider rate limits). */
  readonly transient: boolean
  /** Parsed error body of a non-2xx registry response (e.g. Sourcify's 404 JSON), when small and JSON. */
  readonly body: unknown
  constructor(readonly kind: RpcErrorKind, message: string, o: { code?: number | null; status?: number | null; transient?: boolean; body?: unknown } = {}) {
    super(redact(message))
    this.name = 'RpcError'
    this.code = o.code ?? null
    this.status = o.status ?? null
    this.transient = o.transient ?? false
    this.body = o.body ?? null
  }
}

/** The daily budget of `key` is used up (resets 00:00 UTC). Nothing was sent. */
export class BudgetError extends Error {
  constructor(readonly key: BudgetKey) {
    super(`daily ${key} budget used up`)
    this.name = 'BudgetError'
  }
}

export const isBudgetError = (e: unknown): e is BudgetError => e instanceof BudgetError

// ─── redaction ───────────────────────────────────────────────────────────────

const secrets = new Set<string>()

/** Remember the secret-bearing parts of an endpoint URL (the URL, query values, credentials, long path segments). */
export function registerSecretUrl(url: string | undefined | null): void {
  if (!url) return
  secrets.add(url)
  try {
    const u = new URL(url)
    for (const v of u.searchParams.values()) if (v.length >= 6) secrets.add(v)
    if (u.username) secrets.add(u.username)
    if (u.password) secrets.add(u.password)
    for (const seg of u.pathname.split('/')) if (seg.length >= 16) secrets.add(seg)
  } catch {
    /* not a URL: the whole string is the secret */
  }
}

/** Strip URLs and registered secrets from a message meant for logs, errors or the public feed. */
export function redact(msg: string): string {
  let s = String(msg)
  for (const sec of secrets) if (sec && s.includes(sec)) s = s.split(sec).join('[redacted]')
  s = s.replace(/\b(?:https?|wss?):\/\/[^\s'"<>)]+/gi, '[url]')
  s = s.replace(/(api[-_]?key|token|secret)=([^\s&'"]+)/gi, '$1=[redacted]')
  return s.length > 300 ? `${s.slice(0, 297)}…` : s
}

// ─── helpers ─────────────────────────────────────────────────────────────────

export interface RpcOptions {
  /** Solana endpoint for program reads (Helius on Render; holds a key). Falls back to the discovery endpoint. */
  solanaRpc?: string
  /** Solana endpoint for block sampling (default: the free public mainnet RPC). */
  solanaDiscoveryRpc?: string
  evmRpcs?: Partial<Record<EvmChain, string>>
  limits?: Partial<Record<BudgetKey, number>>
  /** Persist today's usage in <dataDir>/chain/budget.json (none = memory only). */
  dataDir?: string
  /** Requests in flight per endpoint (default 2). */
  maxInFlight?: number
  /** Minimum spacing between request starts on one RPC endpoint, ms (default 120). */
  minGapMs?: number
  /** Minimum spacing between requests to one registry host, ms (default 1000). */
  httpGapMs?: number
  /** Default timeout, ms (default 8000). */
  timeoutMs?: number
  fetch?: typeof fetch
  now?: () => number
  log?: (lvl: 'info' | 'warn' | 'error', msg: string) => void
}

/** createRpc's result: RpcCtx plus the knobs index.ts needs. */
export interface ChainRpc extends RpcCtx {
  /** Budget a call on `chain` is charged to. */
  budgetKey(chain: ChainId, discovery?: boolean): BudgetKey
  /** Calls left today on `key`. */
  remaining(key: BudgetKey): number
  /** ms until the next 00:00 UTC (budget reset). */
  msUntilReset(): number
  /** Write budget.json now. */
  flush(): void
  /** Abort waits and in-flight requests; persist usage. */
  close(): Promise<void>
}

interface Gate {
  active: number
  waiters: (() => void)[]
  nextStart: number
  cooldownUntil: number
  strikes: number
}

const newGate = (): Gate => ({ active: 0, waiters: [], nextStart: 0, cooldownUntil: 0, strikes: 0 })

const USER_AGENT = 'LUSCA-chain-agents/1.0 (+https://lusca.ink)'

function hostKeyOf(url: string, explicit?: 'sourcify' | 'osec'): 'sourcify' | 'osec' | null {
  let host: string
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    host = u.hostname.toLowerCase()
  } catch {
    return null
  }
  if (explicit) return explicit
  if (host === 'sourcify.dev' || host.endsWith('.sourcify.dev')) return 'sourcify'
  if (host === 'osec.io' || host.endsWith('.osec.io')) return 'osec'
  return null
}

// ─── factory ─────────────────────────────────────────────────────────────────

export function createRpc(opts: RpcOptions): ChainRpc {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  const maxInFlight = Math.max(1, opts.maxInFlight ?? 2)
  const minGapMs = Math.max(0, opts.minGapMs ?? 120)
  const httpGapMs = Math.max(0, opts.httpGapMs ?? 1000)
  const defTimeout = Math.max(100, opts.timeoutMs ?? 8000)

  const discoveryUrl = opts.solanaDiscoveryRpc?.trim() || DEFAULT_ENDPOINTS.solanaDiscovery
  const endpoints: Record<'solana' | 'solana-discovery' | EvmChain, string> = {
    solana: opts.solanaRpc?.trim() || discoveryUrl,
    'solana-discovery': discoveryUrl,
    ethereum: opts.evmRpcs?.ethereum?.trim() || DEFAULT_ENDPOINTS.ethereum,
    base: opts.evmRpcs?.base?.trim() || DEFAULT_ENDPOINTS.base,
    arbitrum: opts.evmRpcs?.arbitrum?.trim() || DEFAULT_ENDPOINTS.arbitrum,
  }
  for (const u of Object.values(endpoints)) registerSecretUrl(u)

  const limits: Record<BudgetKey, number> = { ...DEFAULT_LIMITS }
  for (const k of BUDGET_KEYS) {
    const v = opts.limits?.[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) limits[k] = Math.floor(v)
  }

  const budgetFile = opts.dataDir ? path.join(opts.dataDir, 'chain', 'budget.json') : null
  const dayOf = (t: number) => Math.floor(t / DAY)
  let day = dayOf(now())
  let used: Record<BudgetKey, number> = zeroUsage()
  let dirty = false
  let closed = false
  const closing = new AbortController()
  const gates = new Map<string, Gate>()
  let rpcId = 0

  loadBudget()
  const flushTimer = budgetFile
    ? setInterval(() => {
        if (dirty) flush()
      }, 15_000)
    : null
  flushTimer?.unref?.()

  function zeroUsage(): Record<BudgetKey, number> {
    return Object.fromEntries(BUDGET_KEYS.map((k) => [k, 0])) as Record<BudgetKey, number>
  }

  function loadBudget() {
    if (!budgetFile) return
    try {
      const j = JSON.parse(fs.readFileSync(budgetFile, 'utf8')) as { day?: number; used?: Record<string, number> }
      if (j && j.day === day && j.used && typeof j.used === 'object') {
        for (const k of BUDGET_KEYS) {
          const v = j.used[k]
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) used[k] = Math.floor(v)
        }
      }
    } catch {
      /* no file yet, or unreadable: start the day at zero */
    }
  }

  function flush() {
    if (!budgetFile) return
    dirty = false
    try {
      fs.mkdirSync(path.dirname(budgetFile), { recursive: true })
      const tmp = `${budgetFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ day, used, savedAt: now() }))
      fs.renameSync(tmp, budgetFile)
    } catch (e) {
      log('warn', `budget.json save failed: ${redact((e as Error).message)}`)
    }
  }

  function roll() {
    const d = dayOf(now())
    if (d !== day) {
      day = d
      used = zeroUsage()
      dirty = true
    }
  }

  const budgetKey = (chain: ChainId, discovery = false): BudgetKey => (chain === 'solana' ? (discovery ? 'solana-discovery' : 'solana') : chain)

  function canSpendKey(key: BudgetKey, n = 1): boolean {
    roll()
    return used[key] + Math.max(0, n) <= limits[key]
  }

  function charge(key: BudgetKey) {
    roll()
    if (used[key] + 1 > limits[key]) throw new BudgetError(key)
    used[key]++
    dirty = true
  }

  function gateOf(key: string): Gate {
    let g = gates.get(key)
    if (!g) gates.set(key, (g = newGate()))
    return g
  }

  function sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      if (closing.signal.aborted) return reject(new RpcError('closed', 'chain network layer closed'))
      const t = setTimeout(() => {
        closing.signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(t)
        reject(new RpcError('closed', 'chain network layer closed'))
      }
      closing.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async function acquire(g: Gate, max: number, gapMs: number) {
    while (g.active >= max) {
      if (closed) throw new RpcError('closed', 'chain network layer closed')
      await new Promise<void>((r) => g.waiters.push(r))
    }
    if (closed) throw new RpcError('closed', 'chain network layer closed')
    g.active++
    try {
      const t = now()
      const start = Math.max(t, g.nextStart, g.cooldownUntil)
      g.nextStart = start + gapMs
      await sleep(start - t)
    } catch (e) {
      release(g)
      throw e
    }
  }

  function release(g: Gate) {
    g.active = Math.max(0, g.active - 1)
    const w = g.waiters.shift()
    if (w) w()
  }

  function strike(g: Gate) {
    g.strikes = Math.min(g.strikes + 1, 6)
    g.cooldownUntil = now() + Math.min(60_000, 2_000 * 2 ** (g.strikes - 1))
  }

  /** One HTTP exchange with a timeout and a streamed size cap; returns the body bytes and status. */
  async function exchange(
    label: string,
    url: string,
    init: RequestInit,
    timeoutMs: number,
    maxBytes: number,
  ): Promise<{ status: number; body: Buffer }> {
    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ac.abort()
    }, timeoutMs)
    const onClose = () => ac.abort()
    closing.signal.addEventListener('abort', onClose, { once: true })
    try {
      let res: Response
      try {
        res = await fetchFn(url, { ...init, signal: ac.signal })
      } catch (e) {
        throw netError(label, e, timedOut, timeoutMs)
      }
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes && !res.headers.get('content-encoding')) {
        ac.abort()
        throw new RpcError('too-large', `${label}: response larger than ${fmtBytes(maxBytes)}`)
      }
      const chunks: Uint8Array[] = []
      let total = 0
      if (res.body) {
        const reader = res.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > maxBytes) {
              ac.abort()
              reader.cancel().catch(() => {})
              throw new RpcError('too-large', `${label}: response larger than ${fmtBytes(maxBytes)}`)
            }
            chunks.push(value)
          }
        } catch (e) {
          if (e instanceof RpcError) throw e
          throw netError(label, e, timedOut, timeoutMs)
        }
      }
      return { status: res.status, body: Buffer.concat(chunks, total) }
    } finally {
      clearTimeout(timer)
      closing.signal.removeEventListener('abort', onClose)
    }
  }

  function netError(label: string, e: unknown, timedOut: boolean, timeoutMs: number): RpcError {
    if (closed) return new RpcError('closed', `${label}: closed`)
    if (timedOut) return new RpcError('timeout', `${label}: timed out after ${Math.round(timeoutMs / 100) / 10} s`, { transient: true })
    const cause = (e as { cause?: { code?: string } })?.cause
    const code = cause?.code ?? (e as { code?: string })?.code
    return new RpcError('network', `${label}: network error${code ? ` (${String(code).slice(0, 40)})` : ''}`, { transient: true })
  }

  async function call(
    chain: ChainId,
    method: string,
    params: unknown[],
    o: { discovery?: boolean; timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<unknown> {
    if (closed) throw new RpcError('closed', 'chain network layer closed')
    const key = budgetKey(chain, o.discovery === true)
    const endpointKey = key as 'solana' | 'solana-discovery' | EvmChain
    const url = endpoints[endpointKey]
    const safeMethod = /^[A-Za-z0-9_]{1,64}$/.test(method) ? method : 'method'
    const label = `${chain}${key === 'solana-discovery' ? ' discovery' : ''} rpc ${safeMethod}`
    const timeoutMs = Math.max(100, o.timeoutMs ?? defTimeout)
    const maxBytes = Math.max(1024, o.maxBytes ?? METHOD_MAX_BYTES[method] ?? DEFAULT_RPC_MAX_BYTES)
    if (!canSpendKey(key)) throw new BudgetError(key)
    const g = gateOf(`rpc:${endpointKey}`)
    await acquire(g, maxInFlight, minGapMs)
    try {
      charge(key)
      const id = ++rpcId
      const { status, body } = await exchange(
        label,
        url,
        {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        },
        timeoutMs,
        maxBytes,
      )
      if (status === 429) {
        strike(g)
        throw new RpcError('http', `${label}: rate limited (HTTP 429)`, { status, transient: true })
      }
      if (status < 200 || status >= 300) {
        if (status >= 500) strike(g)
        throw new RpcError('http', `${label}: HTTP ${status}`, { status, transient: status >= 500 || status === 408 })
      }
      let j: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }
      try {
        j = JSON.parse(body.toString('utf8'))
      } catch {
        throw new RpcError('bad-json', `${label}: response is not JSON`, { transient: true })
      }
      if (!j || typeof j !== 'object') throw new RpcError('bad-json', `${label}: malformed response`, { transient: true })
      if (j.error) {
        const code = typeof j.error.code === 'number' ? j.error.code : null
        const msg = typeof j.error.message === 'string' ? j.error.message.slice(0, 200) : 'error'
        const limited = code === -32005 || code === 429 || /rate.?limit|too many|exceeded|capacity/i.test(msg)
        if (limited) strike(g)
        throw new RpcError('rpc', `${label}: ${msg}${code !== null ? ` (${code})` : ''}`, {
          code,
          transient: limited || code === -32603 || /timeout|timed out|busy|unavailable/i.test(msg),
        })
      }
      if (j.id !== undefined && j.id !== id) throw new RpcError('bad-json', `${label}: response id mismatch`, { transient: true })
      g.strikes = 0
      return j.result === undefined ? null : j.result
    } finally {
      release(g)
    }
  }

  async function fetchJson(url: string, o: { timeoutMs?: number; maxBytes?: number; host?: 'sourcify' | 'osec' } = {}): Promise<unknown> {
    if (closed) throw new RpcError('closed', 'chain network layer closed')
    const key = hostKeyOf(url, o.host)
    if (!key) throw new RpcError('host', 'registry request to an unsupported host')
    const label = `${key} GET`
    const timeoutMs = Math.max(100, o.timeoutMs ?? defTimeout)
    const maxBytes = Math.max(1024, o.maxBytes ?? DEFAULT_HTTP_MAX_BYTES)
    if (!canSpendKey(key)) throw new BudgetError(key)
    const g = gateOf(`http:${key}`)
    await acquire(g, 1, httpGapMs)
    try {
      charge(key)
      const { status, body } = await exchange(
        label,
        url,
        { method: 'GET', redirect: 'follow', headers: { accept: 'application/json', 'user-agent': USER_AGENT } },
        timeoutMs,
        maxBytes,
      )
      if (status < 200 || status >= 300) {
        if (status === 429 || status >= 500) strike(g)
        let parsed: unknown = null
        if (body.length <= 65536) {
          try {
            parsed = JSON.parse(body.toString('utf8'))
          } catch {
            parsed = null
          }
        }
        throw new RpcError('http', `${label}: HTTP ${status}`, { status, transient: status === 429 || status >= 500 || status === 408, body: parsed })
      }
      try {
        const v = JSON.parse(body.toString('utf8'))
        g.strikes = 0
        return v
      } catch {
        throw new RpcError('bad-json', `${label}: response is not JSON`)
      }
    } finally {
      release(g)
    }
  }

  function usage(): Record<string, { used: number; limit: number }> {
    roll()
    const out: Record<string, { used: number; limit: number }> = {}
    for (const k of BUDGET_KEYS) out[k] = { used: used[k], limit: limits[k] }
    return out
  }

  return {
    call,
    fetchJson,
    usage,
    canSpend: (chain, n = 1, discovery = false) => canSpendKey(budgetKey(chain, discovery), n),
    budgetKey,
    remaining: (key) => {
      roll()
      return Math.max(0, limits[key] - used[key])
    },
    msUntilReset: () => DAY - (now() % DAY),
    flush,
    async close() {
      if (closed) return
      closed = true
      closing.abort()
      if (flushTimer) clearInterval(flushTimer)
      for (const g of gates.values()) {
        const ws = g.waiters.splice(0)
        for (const w of ws) w()
      }
      flush()
    },
  }
}

function fmtBytes(n: number): string {
  return n >= MB ? `${Math.round((n / MB) * 10) / 10} MB` : `${Math.round(n / 1024)} KB`
}
