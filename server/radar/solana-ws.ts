// Solana logsSubscribe on the loaders (standard WebSockets: Helius on every plan, or the public RPC
// locally). One socket, one subscription per loader, a ping every 25 s, reconnect with backoff. The
// radar falls back to polling loader signatures while the socket is down (server/radar/index.ts).

import WebSocket from 'ws'
import { redact } from '../chain/rpc.ts'

export interface LogsNotification {
  signature: string
  slot: number | null
  err: unknown
  logs: string[]
  /** The loader whose subscription delivered it. */
  loader: string
}

export interface LoaderSubscription {
  start(): void
  stop(): void
  /** 'open': subscribed and receiving · 'connecting' · 'down' (failed, retrying). */
  state(): 'open' | 'connecting' | 'down'
  /** When the last notification (or subscription ack) arrived. */
  lastAt(): number | null
  /** Since when the socket has not been usable (null while open). */
  downSince(): number | null
}

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

export function createLoaderSubscription(o: {
  url: string
  loaders: string[]
  onLogs: (n: LogsNotification) => void
  log: Log
  /** For tests. */
  WebSocketImpl?: typeof WebSocket
  now?: () => number
}): LoaderSubscription {
  const WS = o.WebSocketImpl ?? WebSocket
  const now = o.now ?? Date.now
  let ws: WebSocket | null = null
  let st: 'open' | 'connecting' | 'down' = 'down'
  let stopped = true
  let retry = 0
  let reconnectTimer: NodeJS.Timeout | null = null
  let pingTimer: NodeJS.Timeout | null = null
  let staleTimer: NodeJS.Timeout | null = null
  let last: number | null = null
  let down: number | null = now()
  let id = 0
  /** request id → loader, subscription id → loader */
  const pending = new Map<number, string>()
  const subs = new Map<number, string>()
  let warned = 0

  const setDown = () => {
    if (st !== 'down') down = now()
    st = 'down'
  }

  function cleanup() {
    if (pingTimer) clearInterval(pingTimer)
    if (staleTimer) clearInterval(staleTimer)
    pingTimer = staleTimer = null
    pending.clear()
    subs.clear()
    if (ws) {
      ws.removeAllListeners()
      ws.on('error', () => {})
      try {
        ws.terminate()
      } catch {
        /* already closed */
      }
      ws = null
    }
  }

  function schedule() {
    if (stopped) return
    retry = Math.min(retry + 1, 8)
    const ms = Math.min(60_000, 1000 * 2 ** (retry - 1)) * (0.75 + Math.random() * 0.5)
    reconnectTimer = setTimeout(connect, ms)
    reconnectTimer.unref?.()
  }

  function connect() {
    reconnectTimer = null
    if (stopped) return
    cleanup()
    st = 'connecting'
    let sock: WebSocket
    try {
      sock = new WS(o.url, { handshakeTimeout: 10_000, maxPayload: 4 * 1048576, headers: { 'user-agent': 'LUSCA-radar/1.0 (+https://lusca.ink)' } })
    } catch (e) {
      setDown()
      o.log('warn', `radar websocket: ${redact((e as Error).message)}`)
      schedule()
      return
    }
    ws = sock
    sock.on('open', () => {
      for (const loader of o.loaders) {
        const rid = ++id
        pending.set(rid, loader)
        sock.send(JSON.stringify({ jsonrpc: '2.0', id: rid, method: 'logsSubscribe', params: [{ mentions: [loader] }, { commitment: 'confirmed' }] }))
      }
      pingTimer = setInterval(() => {
        try {
          sock.ping()
        } catch {
          /* closing */
        }
      }, 25_000)
      pingTimer.unref?.()
      // a socket that says nothing for 3 minutes is replaced (the upgradeable loader is busy every few seconds)
      staleTimer = setInterval(() => {
        if (last !== null && now() - last > 180_000) {
          o.log('warn', 'radar websocket: no notification for 3 min, reconnecting')
          setDown()
          cleanup()
          schedule()
        }
      }, 30_000)
      staleTimer.unref?.()
    })
    sock.on('message', (data) => {
      let j: { id?: unknown; result?: unknown; error?: { message?: unknown }; method?: unknown; params?: { subscription?: unknown; result?: { context?: { slot?: unknown }; value?: { signature?: unknown; err?: unknown; logs?: unknown } } } }
      try {
        j = JSON.parse(String(data))
      } catch {
        return
      }
      if (typeof j.id === 'number' && pending.has(j.id)) {
        const loader = pending.get(j.id)!
        pending.delete(j.id)
        if (typeof j.result === 'number') {
          subs.set(j.result, loader)
          st = 'open'
          down = null
          retry = 0
          last = now()
        } else {
          o.log('warn', `radar websocket: logsSubscribe refused: ${redact(String(j.error?.message ?? 'no reason')).slice(0, 160)}`)
        }
        return
      }
      if (j.method !== 'logsNotification' || !j.params) return
      const v = j.params.result?.value
      if (!v || typeof v.signature !== 'string' || !Array.isArray(v.logs)) return
      last = now()
      const slot = Number(j.params.result?.context?.slot)
      try {
        o.onLogs({
          signature: v.signature,
          slot: Number.isFinite(slot) ? slot : null,
          err: v.err ?? null,
          logs: v.logs.filter((x): x is string => typeof x === 'string').slice(0, 400),
          loader: subs.get(Number(j.params.subscription)) ?? o.loaders[0],
        })
      } catch (e) {
        o.log('error', `radar websocket handler: ${(e as Error)?.message ?? e}`)
      }
    })
    sock.on('error', (e) => {
      if (now() - warned > 60_000) {
        warned = now()
        o.log('warn', `radar websocket error: ${redact((e as Error).message ?? String(e))}`)
      }
    })
    sock.on('close', () => {
      setDown()
      cleanup()
      schedule()
    })
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      connect()
    },
    stop() {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      cleanup()
      setDown()
    },
    state: () => st,
    lastAt: () => last,
    downSince: () => (st === 'open' ? null : down),
  }
}
