// This browser's own ledger account on the LUSCA server, and its last benchmark.
//
// Account: the server keeps every credit in its ledger (accounts keyed wallet:<address> for a
// verified wallet, else device:<deviceId>). On every socket (re)connect, and whenever the
// verified wallet sign-in changes, this module sends { t: 'account.watch', device, auth }; the
// server answers with { t: 'account', scope, account, at } and pushes a fresh one whenever that
// account or its escrow changes. `useAccount` mirrors the latest answer, so the saved totals are
// on screen right after a reload. Server values only: until the first answer for the current
// identity arrives, `loaded` is false and the UI shows "—". A wallet-scope answer also carries
// this browser's device account (`device`): credits earned before the wallet was verified stay
// there and are shown next to the wallet total instead of disappearing from the panel.
//
// Device id: the anonymous id the ledger uses when no wallet is verified (localStorage
// 'lusca.deviceId'). It is created only when a neuron starts (neuronDeviceId); watching the
// account of a browser that never ran one sends no id.
//
// Last run: the last finished benchmark on this browser (localStorage 'lusca.lastRun.v1'), so
// the tier, GPU and score stay visible after a reload until the next benchmark replaces them.
import { create } from 'zustand'
import { ZONES } from '@shared/protocol'
import type { AccountView, ClientMsg, ServerMsg, Zone } from '@shared/protocol'
import { bus } from './bus'
import { send } from './live'
import { useLive } from './store'
import { authToken, useWallet, verifiedWallet } from './wallet'

// ─── device id ──────────────────────────────────────────────────────────────

const DEVICE_ID_KEY = 'lusca.deviceId'
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/
let deviceIdCache: string | null = null

function randomHex(n: number): string {
  const bytes = new Uint8Array(Math.ceil(n / 2))
  try {
    crypto.getRandomValues(bytes)
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, n)
}

/** This browser's device id if it already has one (never creates one), else null. */
export function storedDeviceId(): string | null {
  if (deviceIdCache) return deviceIdCache
  let id: string | null = null
  try {
    id = localStorage.getItem(DEVICE_ID_KEY)
  } catch {
    id = null
  }
  if (!id || !DEVICE_ID_RE.test(id)) return null
  deviceIdCache = id
  return id
}

/**
 * Stable anonymous id for this browser (localStorage, falls back to a per-session id). The
 * coordinator keys the ledger by it when no wallet is verified, so balances survive reloads.
 * Matches /^[A-Za-z0-9_-]{6,64}$/.
 */
export function neuronDeviceId(): string {
  const have = storedDeviceId()
  if (have) return have
  const id = `web-${randomHex(16)}`
  try {
    localStorage.setItem(DEVICE_ID_KEY, id)
  } catch {
    /* storage unavailable: per-session id */
  }
  deviceIdCache = id
  // A new id is a new ledger identity: follow it (after the caller's own work).
  queueMicrotask(() => {
    if (!authToken()) watch()
  })
  return id
}

// ─── account ────────────────────────────────────────────────────────────────

export type AccountScope = 'wallet' | 'device' | null

export interface AccountState {
  /** Ledger identity the server resolved for this browser (null = none: no sign-in, no device id). */
  scope: AccountScope
  /** The account; null with a resolved scope = no ledger entry yet (0 credits). */
  account: AccountView | null
  /**
   * Wallet scope only: this browser's device account, where credits earned before the wallet was
   * verified stay (earlier payout periods; current-period ones move to the wallet when it is
   * linked). null otherwise or when the device has none.
   */
  deviceAccount: AccountView | null
  /** Server time (ms) of the last 'account' message, null before the first one. */
  at: number | null
  /**
   * false until the first 'account' answer for the current identity. Kept across reconnects
   * (the last server values stay, `at` says when they were sent); reset when the identity
   * changes (wallet verified, switched or signed out, or a device id is created).
   */
  loaded: boolean
}

export const useAccount = create<AccountState>(() => ({ scope: null, account: null, deviceAccount: null, at: null, loaded: false }))

type AccountMsg = Extract<ServerMsg, { t: 'account' }>
type WatchMsg = Extract<ClientMsg, { t: 'account.watch' }>

/** A downgraded answer (e.g. the sign-in was not accepted) is applied after this long. */
const HOLD_MS = 2500

/** Identity the last watch asked for. */
let asked: { scope: AccountScope; wallet: string | null } = { scope: null, wallet: null }
let curKey: string | null = null
let held: { scope: AccountScope; account: AccountView | null; device: AccountView | null; at: number } | null = null
let holdTimer: ReturnType<typeof setTimeout> | null = null

const rank = (s: AccountScope) => (s === 'wallet' ? 2 : s === 'device' ? 1 : 0)

function dropHeld() {
  held = null
  if (holdTimer !== null) clearTimeout(holdTimer)
  holdTimer = null
}

/** Follow this browser's account: the verified wallet if any, else the device. Safe to repeat. */
function watch() {
  const auth = authToken()
  const wallet = auth ? verifiedWallet() : null
  const device = storedDeviceId()
  const scope: AccountScope = auth && wallet ? 'wallet' : device ? 'device' : null
  const key = scope === 'wallet' ? `wallet:${wallet}` : scope === 'device' ? `device:${device}` : 'none'
  if (key !== curKey) {
    // Another identity: nothing shown so far belongs to it.
    curKey = key
    useAccount.setState({ scope: null, account: null, deviceAccount: null, at: null, loaded: false })
  }
  asked = { scope, wallet }
  dropHeld()
  const msg: WatchMsg = { t: 'account.watch', device, auth }
  send(msg) // socket closed: the next 'hello' sends it again
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** A well-formed AccountView, or null. */
function readView(v: unknown): AccountView | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.kind !== 'wallet' && o.kind !== 'device') return null
  if (o.wallet !== null && typeof o.wallet !== 'string') return null
  const f = (k: string) => num(o[k])
  const ink = f('ink')
  const jobs = f('jobs')
  const verified = f('verified')
  const failed = f('failed')
  if (ink === null || jobs === null || verified === null || failed === null) return null
  return {
    kind: o.kind,
    wallet: o.kind === 'wallet' ? (o.wallet as string | null) : null,
    ink,
    pendingInk: f('pendingInk') ?? 0,
    periodInk: f('periodInk') ?? 0,
    jobs,
    verified,
    failed,
    flops: f('flops') ?? 0,
    firstSeen: f('firstSeen') ?? 0,
    lastSeen: f('lastSeen') ?? 0,
  }
}

function applyAccount(scope: AccountScope, account: AccountView | null, device: AccountView | null, at: number) {
  useAccount.setState({ scope, account, deviceAccount: scope === 'wallet' ? device : null, at, loaded: true })
}

/**
 * One socket delivers in order, so an answer to an earlier watch (another identity) can only
 * arrive before the answer to the current one. A watch never resolves to a higher scope than it
 * asked for (no sign-in → never a wallet) nor to another wallet, so those are stale and dropped.
 * A lower scope (the sign-in was not accepted) is held briefly: the current answer replaces it if
 * it arrives, otherwise the held one is what the server resolved and is applied.
 */
function onAccount(m: AccountMsg) {
  const scope = m.scope
  if (scope !== 'wallet' && scope !== 'device' && scope !== null) return
  const account = m.account === null ? null : readView(m.account)
  if (m.account !== null && !account) return // malformed: keep what we have
  const device = m.device === undefined || m.device === null ? null : readView(m.device)
  const at = num(m.at) ?? Date.now()
  const r = rank(scope)
  const want = rank(asked.scope)
  if (r === want && (scope !== 'wallet' || !account || account.wallet === asked.wallet)) {
    dropHeld()
    applyAccount(scope, account, device, at)
    return
  }
  if (r > want || scope === 'wallet') return
  held = { scope, account, device, at }
  if (holdTimer === null) {
    holdTimer = setTimeout(() => {
      holdTimer = null
      const h = held
      held = null
      if (!h) return
      asked = { scope: h.scope, wallet: null } // later pushes for it apply at once
      applyAccount(h.scope, h.account, h.device, h.at)
    }, HOLD_MS)
  }
}

bus.on('account', (m) => {
  try {
    onAccount(m)
  } catch {
    /* malformed message: ignore */
  }
})

// Every server greeting means a (re)connected socket: the watch is per connection.
bus.on('hello', () => watch())

// Wallet verified, switched or signed out: follow the account credits now go to.
useWallet.subscribe((s, prev) => {
  const tok = s.status === 'verified' ? (s.session?.token ?? null) : null
  const before = prev.status === 'verified' ? (prev.session?.token ?? null) : null
  if (tok !== before) watch()
})

// Loaded after the greeting (e.g. the Node page chunk): watch on the open socket now.
if (useLive.getState().conn === 'live') watch()

// ─── last benchmark ─────────────────────────────────────────────────────────

const LAST_RUN_KEY = 'lusca.lastRun.v1'

export interface LastRun {
  zone: Zone
  /** Median GFLOPS of the benchmark. */
  gflops: number
  /** Adapter label of the GPU the benchmark ran on; null for a CPU run. */
  gpu: string | null
  backend: 'webgpu' | 'cpu'
  /** When it finished (ms epoch, this browser's clock). */
  at: number
}

function validRun(v: unknown): LastRun | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const zone = ZONES.find((z) => z.zone === o.zone)?.zone
  const gflops = num(o.gflops)
  const at = num(o.at)
  if (!zone || gflops === null || gflops < 0 || at === null || at <= 0) return null
  if (o.backend !== 'webgpu' && o.backend !== 'cpu') return null
  const gpu = typeof o.gpu === 'string' && o.gpu.trim() ? o.gpu.slice(0, 200) : null
  return { zone, gflops, gpu: o.backend === 'webgpu' ? gpu : null, backend: o.backend, at }
}

function readLastRun(): LastRun | null {
  try {
    const raw = localStorage.getItem(LAST_RUN_KEY)
    if (raw === null) return null
    const run = validRun(JSON.parse(raw))
    if (!run) localStorage.removeItem(LAST_RUN_KEY) // corrupt or from an older format
    return run
  } catch {
    return null
  }
}

const useLastRunStore = create<{ run: LastRun | null }>(() => ({ run: typeof window === 'undefined' ? null : readLastRun() }))

/** Last finished benchmark on this browser (localStorage), null if none. Updates when a new one finishes. */
export function useLastRun(): LastRun | null {
  return useLastRunStore((s) => s.run)
}

/** The same, outside React. */
export function lastRun(): LastRun | null {
  return useLastRunStore.getState().run
}

/** Remember a finished benchmark (called by the neuron, src/lib/gpu/neuron.ts). */
export function recordLastRun(run: LastRun): void {
  const ok = validRun(run)
  if (!ok) return
  useLastRunStore.setState({ run: ok })
  try {
    localStorage.setItem(LAST_RUN_KEY, JSON.stringify(ok))
  } catch {
    /* storage unavailable: kept for this page only */
  }
}

// Another tab of this browser finished a benchmark, or created the device id.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === LAST_RUN_KEY || e.key === null) useLastRunStore.setState({ run: readLastRun() })
    if (e.key === DEVICE_ID_KEY && !deviceIdCache && storedDeviceId() && !authToken()) watch()
  })
}
