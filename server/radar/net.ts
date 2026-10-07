// The radar's EVM log endpoints: eth_getLogs across all addresses needs an endpoint that serves it
// (PublicNode refuses address-less queries), so the radar keeps its own short list per chain, with a
// breaker per endpoint and failover. Every call is charged to the radar's budget first. URLs never
// leave this file: errors and status name the provider (rpc.ts providerOfUrl / redact()).

import { RpcError, providerOfUrl, redact, registerSecretUrl } from '../chain/rpc.ts'

export type EvmChain = 'ethereum' | 'base' | 'arbitrum'

/** Public endpoints that answer address-less eth_getLogs and historical state (checked 2026-10). */
export const DEFAULT_LOG_ENDPOINTS: Record<EvmChain, string[]> = {
  ethereum: ['https://rpc.mevblocker.io', 'https://eth.drpc.org'],
  base: ['https://mainnet.base.org', 'https://base.drpc.org'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org'],
}

/** The provider refused the block range (too wide / too many results): halve the window. */
export class RangeLimitError extends Error {
  constructor(message: string) {
    super(redact(message))
    this.name = 'RangeLimitError'
  }
}

/** Unmistakable range / result-size refusals (Infura's "more than 10000 results" comes with -32005, a rate-limit code elsewhere). */
const RANGE_EXPLICIT_RE =
  /block range|range (?:is )?too (?:large|wide|big)|range limit|limited to (?:a )?\d+|more than \d+ (?:results|logs|blocks)|\d+ results|too many (?:results|logs|blocks)|exceed(?:s|ed)? (?:the )?(?:max(?:imum)? )?(?:block )?range|response size|query timeout|block limit|blocks? (?:are )?allowed|max(?:imum)? (?:block )?range/i
/** Rate limits and plan capacity: transient (strike the endpoint, fail over, back off), never a narrower window. */
const RATE_RE = /rate.?limit|too many requests|capacity|compute units|throughput|request limit|requests? per|credits|quota|daily limit|temporarily unavailable/i
/** Broader range wording, tried after the rate-limit check. */
const RANGE_RE = /range|limited to|too many|exceed|more than \d+|response size|query timeout|block limit|blocks? (?:are )?allowed/i

/** How to handle a provider's refusal: 'range' (halve the window), 'rate' (transient: strike, fail over, back off), null (other). */
export function refusalKind(msg: string, code: number | null): 'range' | 'rate' | null {
  if (RANGE_EXPLICIT_RE.test(msg)) return 'range'
  if (code === -32005 || code === 429 || RATE_RE.test(msg)) return 'rate'
  if (RANGE_RE.test(msg)) return 'range'
  return null
}
const USER_AGENT = 'LUSCA-radar/1.0 (+https://lusca.ink)'

interface Endpoint {
  url: string
  provider: string
  strikes: number
  openUntil: number
  lastOk: number | null
}

export interface EvmPool {
  call(method: string, params: unknown[], o?: { timeoutMs?: number; maxBytes?: number; charge?: (n: number) => void }): Promise<unknown>
  /** One HTTP request, several calls; each answer is { result } or { error }. Charged per call. */
  batch(calls: { method: string; params: unknown[] }[], o?: { timeoutMs?: number; maxBytes?: number; charge?: (n: number) => void }): Promise<({ result: unknown } | { error: string })[]>
  /** Provider of the endpoint in use ('MEV Blocker', 'Base public RPC' …). */
  provider(): string
  up(): boolean
  lastOk(): number | null
  close(): void
}

const NAMES: [RegExp, string][] = [
  [/mevblocker/i, 'MEV Blocker'],
  [/drpc\.org$/i, 'dRPC'],
]

export function createEvmPool(o: {
  chain: EvmChain
  urls: string[]
  /** Charge n calls to the radar budget (throws when they do not fit). */
  charge: (n: number) => void
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}): EvmPool {
  const fetchFn = o.fetch ?? globalThis.fetch
  const now = o.now ?? Date.now
  const eps: Endpoint[] = o.urls
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .map((url) => {
      registerSecretUrl(url)
      let host = ''
      try {
        host = new URL(url).hostname
      } catch {
        /* checked above */
      }
      const named = NAMES.find(([re]) => re.test(host))?.[1]
      return { url, provider: named ?? providerOfUrl(url, `${o.chain} RPC`), strikes: 0, openUntil: 0, lastOk: null }
    })
  const closing = new AbortController()
  let id = 0

  const pick = (): Endpoint => {
    const t = now()
    const open = eps.find((e) => e.openUntil <= t)
    if (open) return open
    if (!eps.length) throw new RpcError('host', `${o.chain} radar: no log endpoint configured`)
    throw new RpcError('network', `${o.chain} radar: every log endpoint is cooling down`, { transient: true })
  }
  const strike = (e: Endpoint) => {
    e.strikes = Math.min(e.strikes + 1, 7)
    e.openUntil = now() + Math.min(300_000, 5_000 * 2 ** (e.strikes - 1))
  }

  async function post(e: Endpoint, body: unknown, timeoutMs: number, maxBytes: number): Promise<unknown> {
    const ac = new AbortController()
    const onClose = () => ac.abort()
    closing.signal.addEventListener('abort', onClose, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ac.abort()
    }, timeoutMs)
    const label = `${o.chain} radar ${e.provider}`
    try {
      let res: Response
      try {
        res = await fetchFn(e.url, {
          method: 'POST',
          redirect: 'error',
          signal: ac.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
          body: JSON.stringify(body),
        })
      } catch {
        throw new RpcError(timedOut ? 'timeout' : 'network', `${label}: ${timedOut ? 'timed out' : 'network error'}`, { transient: true })
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
              throw new RangeLimitError(`${label}: response larger than ${Math.round(maxBytes / 1024)} KB`)
            }
            chunks.push(value)
          }
        } catch (err) {
          if (err instanceof RangeLimitError) throw err
          throw new RpcError(timedOut ? 'timeout' : 'network', `${label}: ${timedOut ? 'timed out' : 'network error'}`, { transient: true })
        }
      }
      const text = Buffer.concat(chunks, total).toString('utf8')
      let j: unknown = null
      try {
        j = JSON.parse(text)
      } catch {
        j = null
      }
      if (res.status === 429) throw new RpcError('http', `${label}: rate limited (HTTP 429)`, { status: 429, transient: true })
      if (res.status < 200 || res.status >= 300) {
        // a range refusal can come with a 4xx status (Base answers 413)
        const err = (j as { error?: { message?: unknown; code?: unknown } } | null)?.error
        const msg = String(err?.message ?? '')
        const rk = msg ? refusalKind(msg, typeof err?.code === 'number' ? err.code : null) : null
        if (rk === 'range') throw new RangeLimitError(`${label}: ${msg.slice(0, 160)}`)
        throw new RpcError('http', `${label}: HTTP ${res.status}${rk === 'rate' ? ' (rate limited)' : ''}`, {
          status: res.status,
          transient: rk === 'rate' || res.status >= 500 || res.status === 408 || res.status === 403,
        })
      }
      if (j === null) throw new RpcError('bad-json', `${label}: response is not JSON`, { transient: true })
      return j
    } finally {
      clearTimeout(timer)
      closing.signal.removeEventListener('abort', onClose)
    }
  }

  function rpcError(e: Endpoint, err: { code?: unknown; message?: unknown }): Error {
    const msg = typeof err.message === 'string' ? err.message.slice(0, 200) : 'error'
    const code = typeof err.code === 'number' ? err.code : null
    const rk = refusalKind(msg, code)
    if (rk === 'range') return new RangeLimitError(`${o.chain} radar ${e.provider}: ${msg}`)
    const limited = rk === 'rate'
    return new RpcError('rpc', `${o.chain} radar ${e.provider}: ${msg}${code !== null ? ` (${code})` : ''}`, { code, transient: limited || code === -32603 })
  }

  async function withFailover<T>(n: number, fn: (e: Endpoint) => Promise<T>, charge: (n: number) => void = o.charge): Promise<T> {
    let lastErr: unknown = null
    for (let attempt = 0; attempt < Math.max(1, eps.length); attempt++) {
      const e = pick()
      charge(n)
      try {
        const v = await fn(e)
        e.strikes = 0
        e.lastOk = now()
        return v
      } catch (err) {
        if (err instanceof RangeLimitError) throw err
        lastErr = err
        if (err instanceof RpcError && (err.transient || err.kind === 'http')) {
          strike(e)
          continue
        }
        throw err
      }
    }
    throw lastErr instanceof Error ? lastErr : new RpcError('network', `${o.chain} radar: no endpoint answered`, { transient: true })
  }

  return {
    call(method, params, opts = {}) {
      return withFailover(1, async (e) => {
        const j = (await post(e, { jsonrpc: '2.0', id: ++id, method, params }, opts.timeoutMs ?? o.timeoutMs ?? 10_000, opts.maxBytes ?? 8 * 1048576)) as {
          result?: unknown
          error?: { code?: unknown; message?: unknown }
        }
        if (j && typeof j === 'object' && j.error) throw rpcError(e, j.error)
        return j?.result ?? null
      }, opts.charge)
    },
    batch(calls, opts = {}) {
      if (!calls.length) return Promise.resolve([])
      return withFailover(calls.length, async (e) => {
        const base = id
        id += calls.length
        const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: base + i + 1, method: c.method, params: c.params }))
        const j = await post(e, body, opts.timeoutMs ?? o.timeoutMs ?? 12_000, opts.maxBytes ?? 4 * 1048576)
        if (!Array.isArray(j)) {
          const err = (j as { error?: { code?: unknown; message?: unknown } } | null)?.error
          throw err ? rpcError(e, err) : new RpcError('bad-json', `${o.chain} radar ${e.provider}: batch answer is not a list`, { transient: true })
        }
        const byId = new Map<number, { result?: unknown; error?: { message?: unknown } }>()
        for (const r of j as { id?: unknown; result?: unknown; error?: { message?: unknown } }[]) if (typeof r?.id === 'number') byId.set(r.id, r)
        return calls.map((_, i) => {
          const r = byId.get(base + i + 1)
          if (!r) return { error: 'no answer' }
          if (r.error) return { error: redact(String(r.error.message ?? 'error')).slice(0, 120) }
          return { result: r.result ?? null }
        })
      }, opts.charge)
    },
    provider: () => {
      const t = now()
      return (eps.find((e) => e.openUntil <= t) ?? eps[0])?.provider ?? `${o.chain} RPC`
    },
    up: () => eps.some((e) => e.openUntil <= now()),
    lastOk: () => Math.max(0, ...eps.map((e) => e.lastOk ?? 0)) || null,
    close: () => closing.abort(),
  }
}

/** ws(s):// URL of an http(s) Solana RPC endpoint (Helius standard WebSockets share host and key). */
export function wsUrlOf(httpUrl: string): string | null {
  try {
    const u = new URL(httpUrl)
    if (u.protocol === 'https:') u.protocol = 'wss:'
    else if (u.protocol === 'http:') u.protocol = 'ws:'
    else if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null
    return u.toString()
  } catch {
    return null
  }
}
