// Live treasury + payout state from the server (GET /api/payouts, /api/payouts/wallet/:address).
// Real data only: until the server answers, every field stays null and the UI shows "—".
import { useEffect } from 'react'
import { create } from 'zustand'
import type { PayoutCluster, PayoutsOverview, WalletPayouts } from '@shared/payouts'

const OVERVIEW_MS = 15_000
const WALLET_MS = 20_000

interface WalletEntry {
  data: WalletPayouts | null
  at: number | null
  error: string | null
}

interface PayoutState {
  overview: PayoutsOverview | null
  overviewAt: number | null
  overviewError: string | null
  wallets: Record<string, WalletEntry>
}

export const usePayoutStore = create<PayoutState>(() => ({
  overview: null,
  overviewAt: null,
  overviewError: null,
  wallets: {},
}))

/** Apply an overview pushed over the WebSocket ({ t: 'payout' }). */
export function ingestPayoutOverview(overview: PayoutsOverview): void {
  usePayoutStore.setState({ overview, overviewAt: Date.now(), overviewError: null })
}

/** A non-OK HTTP answer. `retryAfterMs` is set when the server sent Retry-After (e.g. on 429). */
class HttpError extends Error {
  readonly status: number
  readonly retryAfterMs: number | null
  constructor(status: number, retryAfterMs: number | null) {
    super(`HTTP ${status}`)
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    const ra = Number(res.headers.get('retry-after'))
    throw new HttpError(res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null)
  }
  return (await res.json()) as T
}

/** Rate limited: retry after the server's Retry-After (1–15 s) and keep the current data. */
function rateLimitDelay(e: unknown): number | null {
  if (!(e instanceof HttpError) || e.status !== 429) return null
  return Math.min(15_000, Math.max(1_000, e.retryAfterMs ?? 3_000))
}

/** Report an error only after this many consecutive failures; the first one retries quickly. */
const FAILS_BEFORE_ERROR = 2
const QUICK_RETRY_MS = 3_000

const hidden = () => typeof document !== 'undefined' && document.hidden

// ─── overview poller (ref-counted) ──────────────────────────────────────────

let overviewSubs = 0
let overviewTimer: ReturnType<typeof setTimeout> | null = null
let overviewInflight = false
let overviewFails = 0

function scheduleOverview(delay: number): void {
  if (overviewTimer) clearTimeout(overviewTimer)
  overviewTimer = overviewSubs > 0 ? setTimeout(runOverview, delay) : null
}

async function runOverview(): Promise<void> {
  overviewTimer = null
  if (overviewInflight) return
  // Background tabs still make the first request, so the page is complete when it is shown;
  // after that, hidden tabs pause and catch up on visibilitychange.
  if (hidden() && usePayoutStore.getState().overview) return scheduleOverview(OVERVIEW_MS)
  overviewInflight = true
  let next = OVERVIEW_MS
  try {
    ingestPayoutOverview(await getJson<PayoutsOverview>('/api/payouts'))
    overviewFails = 0
  } catch (e) {
    const wait = rateLimitDelay(e)
    if (wait != null) next = wait
    else {
      overviewFails++
      if (overviewFails >= FAILS_BEFORE_ERROR) usePayoutStore.setState({ overviewError: e instanceof Error ? e.message : 'unreachable' })
      else next = QUICK_RETRY_MS
    }
  } finally {
    overviewInflight = false
    scheduleOverview(next)
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    const { overviewAt } = usePayoutStore.getState()
    if (overviewSubs > 0 && (overviewAt == null || Date.now() - overviewAt > OVERVIEW_MS)) scheduleOverview(0)
    for (const [address, n] of walletSubs) {
      const at = usePayoutStore.getState().wallets[address]?.at
      if (n > 0 && (at == null || Date.now() - at > WALLET_MS)) scheduleWallet(address, 0)
    }
  })
}

/** Fetch the overview now (e.g. right after a wallet is verified). */
export function refreshPayouts(): void {
  if (overviewSubs > 0) scheduleOverview(0)
}

/** Subscribe the calling component to the treasury / period / history overview. */
export function usePayouts(): Pick<PayoutState, 'overview' | 'overviewAt' | 'overviewError'> {
  useEffect(() => {
    overviewSubs++
    if (overviewSubs === 1) scheduleOverview(0)
    return () => {
      overviewSubs--
      if (overviewSubs === 0 && overviewTimer) {
        clearTimeout(overviewTimer)
        overviewTimer = null
      }
    }
  }, [])
  const overview = usePayoutStore((s) => s.overview)
  const overviewAt = usePayoutStore((s) => s.overviewAt)
  const overviewError = usePayoutStore((s) => s.overviewError)
  return { overview, overviewAt, overviewError }
}

// ─── per-wallet poller (ref-counted per address) ────────────────────────────

const walletSubs = new Map<string, number>()
const walletTimers = new Map<string, ReturnType<typeof setTimeout>>()
const walletInflight = new Set<string>()
const walletFails = new Map<string, number>()

function setWallet(address: string, patch: Partial<WalletEntry>): void {
  usePayoutStore.setState((s) => {
    const prev = s.wallets[address] ?? { data: null, at: null, error: null }
    return { wallets: { ...s.wallets, [address]: { ...prev, ...patch } } }
  })
}

function scheduleWallet(address: string, delay: number): void {
  const t = walletTimers.get(address)
  if (t) clearTimeout(t)
  walletTimers.delete(address)
  if ((walletSubs.get(address) ?? 0) > 0) walletTimers.set(address, setTimeout(() => void runWallet(address), delay))
}

async function runWallet(address: string): Promise<void> {
  walletTimers.delete(address)
  if (walletInflight.has(address)) return
  if (hidden() && usePayoutStore.getState().wallets[address]?.data) return scheduleWallet(address, WALLET_MS)
  walletInflight.add(address)
  let next = WALLET_MS
  try {
    const data = await getJson<WalletPayouts>(`/api/payouts/wallet/${encodeURIComponent(address)}`)
    setWallet(address, { data, at: Date.now(), error: null })
    walletFails.delete(address)
  } catch (e) {
    const wait = rateLimitDelay(e)
    if (wait != null) next = wait
    else {
      const fails = (walletFails.get(address) ?? 0) + 1
      walletFails.set(address, fails)
      // A 4xx (other than 429) is a definite answer; anything else gets one quick retry first.
      const definite = e instanceof HttpError && e.status >= 400 && e.status < 500
      if (definite || fails >= FAILS_BEFORE_ERROR) setWallet(address, { error: e instanceof Error ? e.message : 'unreachable' })
      else next = QUICK_RETRY_MS
    }
  } finally {
    walletInflight.delete(address)
    scheduleWallet(address, next)
  }
}

/** Fetch one wallet's standing now (e.g. right after it was verified). */
export function refreshWalletPayouts(address: string): void {
  if ((walletSubs.get(address) ?? 0) > 0) scheduleWallet(address, 0)
}

/** Subscribe to one wallet's current-period standing and payout history. Pass null to skip. */
export function useWalletPayouts(address: string | null): WalletEntry {
  useEffect(() => {
    if (!address) return
    const n = (walletSubs.get(address) ?? 0) + 1
    walletSubs.set(address, n)
    if (n === 1) scheduleWallet(address, 0)
    return () => {
      const left = (walletSubs.get(address) ?? 1) - 1
      if (left > 0) return void walletSubs.set(address, left)
      walletSubs.delete(address)
      const t = walletTimers.get(address)
      if (t) clearTimeout(t)
      walletTimers.delete(address)
    }
  }, [address])
  const entry = usePayoutStore((s) => (address ? s.wallets[address] : undefined))
  return entry ?? EMPTY
}

const EMPTY: WalletEntry = { data: null, at: null, error: null }

// ─── explorer links + formatting ────────────────────────────────────────────

const clusterQuery = (c: PayoutCluster | undefined) => (c === 'devnet' ? '?cluster=devnet' : '')

export function solscanTx(signature: string, cluster?: PayoutCluster): string {
  return `https://solscan.io/tx/${signature}${clusterQuery(cluster)}`
}

export function solscanAccount(address: string, cluster?: PayoutCluster): string {
  return `https://solscan.io/account/${address}${clusterQuery(cluster)}`
}

/** SOL with sensible precision: 4 decimals under 10, 2 above. null → "—". */
export function fmtSol(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const d = Math.abs(v) < 10 ? 4 : 2
  return `${v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })} SOL`
}
