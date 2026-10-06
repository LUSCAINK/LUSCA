// Live connection to the LUSCA server (WebSocket /ws).
//
// Real data only. The store is filled by the server's 'hello' snapshot and the
// stream after it; there is no fallback feed. While the server cannot be reached
// the store is empty, `conn` is 'unreachable' and the UI shows "—" with the line
// "Can't reach the LUSCA server — reconnecting…". When a live link drops, every
// server-derived value is cleared at once so nothing stale is shown as current.
//
// Bandwidth: a tab that stays hidden for VITE_LUSCA_HIDDEN_CLOSE_S (default 60 s)
// closes its socket and stops retrying; it reconnects the moment it is visible
// again (the server re-sends the full 'hello' snapshot, and a running neuron
// re-registers on it). Reconnect delays carry ±VITE_LUSCA_RECONNECT_JITTER
// (default 0.5 = ±50 %) random jitter so a server restart is not met by every
// tab at the same instant.
//
// Reload: a tab that was earning when it was reloaded (sessionStorage AUTORESUME_KEY)
// loads the neuron at boot and resumes once the server answers (resumeEarning in
// src/components/node/flow.ts), whichever page it reloads on.
import type { ClientMsg, ServerMsg } from '@shared/protocol'
import type { PayoutsOverview } from '@shared/payouts'
import { bus } from './bus'
import { ingestChainEvent } from './chain'
import { ingestPayoutOverview } from './payouts'
import { useLive } from './store'

function envNum(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

/** Close the socket after this long in a hidden tab. 0 disables. */
const HIDDEN_CLOSE_MS = envNum(import.meta.env.VITE_LUSCA_HIDDEN_CLOSE_S, 60, 0, 86_400) * 1000
/** Reconnect delay is multiplied by a random factor in [1 - J, 1 + J]. */
const JITTER = envNum(import.meta.env.VITE_LUSCA_RECONNECT_JITTER, 0.5, 0, 0.9)
/** Never park while GPU job traffic is this recent: an unanswered job counts as a failure. */
const JOB_GRACE_MS = 15_000
/** A socket that has not opened by then is abandoned and retried. */
const OPEN_TIMEOUT_MS = 6000

let ws: WebSocket | null = null
let started = false
let retry = 0
let reconnectTimer: number | null = null
let hiddenTimer: number | null = null
let parked = false // socket closed on purpose because the tab is hidden
let lastJobAt = -Infinity

function dispatch(msg: ServerMsg) {
  // chain agents' reads (src/lib/chain.ts) keep their own store, like payouts
  if (msg.t === 'chain') ingestChainEvent(msg.event)
  else useLive.getState().apply(msg)
  bus.emit(msg)
}

/** Server data is gone (or was never there): empty the store and say why. */
function goDark(conn: 'connecting' | 'unreachable') {
  const st = useLive.getState()
  if (st.conn === 'live') st.clear()
  if (st.conn !== conn) st.setConn(conn)
}

/** { t: 'payout', overview } — narrow guard, independent of the ServerMsg union. */
function isPayoutMsg(m: { t: string }): m is { t: 'payout'; overview: PayoutsOverview } {
  const o = (m as { overview?: unknown }).overview
  return m.t === 'payout' && !!o && typeof o === 'object'
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}

function withJitter(ms: number): number {
  return Math.max(250, Math.round(ms * (1 + JITTER * (2 * Math.random() - 1))))
}

function scheduleReconnect(ms: number) {
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    connect()
  }, ms)
}

function connect() {
  // parked (hidden tab): the visibility handler reconnects; one socket at a time
  if (parked) return
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return
  let opened = false
  let sock: WebSocket
  try {
    sock = new WebSocket(wsUrl())
  } catch {
    goDark('unreachable')
    retry = Math.min(retry + 1, 6)
    scheduleReconnect(withJitter(1000 * 2 ** Math.min(retry, 4)))
    return
  }
  ws = sock
  const giveUp = window.setTimeout(() => {
    if (!opened) sock.close()
  }, OPEN_TIMEOUT_MS)

  sock.onopen = () => {
    opened = true
    window.clearTimeout(giveUp)
    retry = 0
  }
  sock.onmessage = (ev) => {
    let raw: unknown
    try {
      raw = JSON.parse(ev.data as string)
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object' || typeof (raw as { t?: unknown }).t !== 'string') return
    const msg = raw as { t: string }
    if (isPayoutMsg(msg)) {
      ingestPayoutOverview(msg.overview)
      bus.emit(msg as unknown as ServerMsg)
      return
    }
    const m = msg as ServerMsg
    if (m.t === 'job') lastJobAt = performance.now()
    dispatch(m)
    // the snapshot is in the store before anything reads the link as live
    if (m.t === 'hello' && useLive.getState().conn !== 'live') useLive.getState().setConn('live')
  }
  sock.onclose = () => {
    window.clearTimeout(giveUp)
    // a socket replaced by a newer one (e.g. closed while parking) must not touch state
    if (ws !== sock) return
    ws = null
    if (parked) {
      goDark('connecting') // hidden tab: reconnect when visible again
      return
    }
    goDark('unreachable')
    retry = Math.min(retry + 1, 6)
    // 2, 4, 8, 16, 16 … s (± jitter)
    scheduleReconnect(withJitter(1000 * 2 ** Math.min(retry, 4)))
  }
  sock.onerror = () => sock.close()
}

// ─── hidden-tab parking ─────────────────────────────────────

function park() {
  hiddenTimer = null
  if (parked || !document.hidden) return
  // a neuron finishing a job in the background: wait for it rather than fail the job
  if (performance.now() - lastJobAt < JOB_GRACE_MS) {
    hiddenTimer = window.setTimeout(park, JOB_GRACE_MS)
    return
  }
  parked = true
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  // onclose sees `parked` and does not schedule a retry
  if (ws) ws.close(1000, 'tab hidden')
  else goDark('connecting')
}

function onVisibility() {
  if (document.hidden) {
    if (HIDDEN_CLOSE_MS > 0 && !parked && hiddenTimer === null) hiddenTimer = window.setTimeout(park, HIDDEN_CLOSE_MS)
    return
  }
  if (hiddenTimer !== null) {
    window.clearTimeout(hiddenTimer)
    hiddenTimer = null
  }
  if (parked) {
    parked = false
    retry = 0
    connect()
  }
}

// ─── resume after a reload ──────────────────────────────────
/**
 * sessionStorage flag: this tab is earning. Set when earning starts or is resumed, cleared by
 * an explicit pause or stop (not by the automatic pause while the tab is hidden).
 */
export const AUTORESUME_KEY = 'lusca.autoresume'

/**
 * This page load reloaded the same tab. A duplicated or restored tab also inherits the
 * sessionStorage flag, but it must not start a second neuron on the same GPU and device id.
 */
function wasReload(): boolean {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    if (nav) return nav.type === 'reload'
    return (performance as Performance & { navigation?: { type: number } }).navigation?.type === 1 // older engines
  } catch {
    return false
  }
}

function resumeAfterReload() {
  let on = false
  try {
    on = sessionStorage.getItem(AUTORESUME_KEY) === '1'
    // not a reload (duplicated / restored tab, new navigation): this tab never started earning
    if (on && !wasReload()) {
      sessionStorage.removeItem(AUTORESUME_KEY)
      on = false
    }
  } catch {
    on = false
  }
  if (!on) return
  // loaded only when needed: the neuron's GPU code stays out of the main bundle
  import('@/components/node/flow').then(
    (m) => m.resumeEarning(),
    () => {
      /* chunk failed to load: the Start button still works */
    },
  )
}

export function startLive() {
  if (started) return
  started = true
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility() // opened in a background tab: start the clock now
  }
  connect()
  resumeAfterReload()
}

export function send(msg: ClientMsg): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (msg.t === 'job.request' || msg.t === 'job.result' || msg.t === 'train.result') lastJobAt = performance.now()
    ws.send(JSON.stringify(msg))
    return true
  }
  return false
}

export function isLive() {
  return useLive.getState().conn === 'live'
}
