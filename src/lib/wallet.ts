// Solana wallet binding + ownership proof (Phantom, or any wallet exposing window.solana).
//
// Flow: connect → GET /api/auth/nonce?wallet= → provider.signMessage(<plain-text sign-in
// message>) → POST /api/auth/verify → { token, wallet, expiresAt } kept in localStorage.
// The signed message is plain text, not a transaction, and costs nothing. LUSCA never asks
// for a transaction, a private key or a seed phrase. A wallet is only needed to receive SOL
// payouts; earning INK on a device needs none.
//
// States: 'none' (no address) → 'connected' (address known, not verified) → 'verifying' →
// 'verified' (a valid sign-in token for that address). The GPU neuron registers with the token
// (src/lib/gpu/neuron.ts), which is what links its INK to the wallet.
import { create } from 'zustand'
import type { AuthNonce, AuthSession, AuthVerifyRequest } from '@shared/payouts'
import { base58Encode, isSolanaAddress } from '@shared/base58'
import { refreshPayouts, refreshWalletPayouts } from '@/lib/payouts'

/** Re-exported for callers that validate addresses (32-byte base58 Solana public keys only). */
export { isSolanaAddress }

const ADDRESS_KEY = 'lusca.wallet'
const SESSION_KEY = 'lusca.walletAuth'
/** A stored token this close to expiry is treated as expired. */
const EXPIRY_MARGIN_MS = 60_000
// ─── provider ───────────────────────────────────────────────────────────────

type KeyLike = { toString(): string } | string | null | undefined

interface SolProvider {
  isPhantom?: boolean
  publicKey?: KeyLike
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: KeyLike } | undefined | void>
  disconnect(): Promise<void>
  signMessage?(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array } | Uint8Array>
  on?(ev: string, fn: (...a: unknown[]) => void): void
}

declare global {
  interface Window {
    solana?: SolProvider
    phantom?: { solana?: SolProvider }
  }
}

function provider(): SolProvider | null {
  if (typeof window === 'undefined') return null
  return window.phantom?.solana ?? window.solana ?? null
}

function keyText(k: unknown): string | null {
  if (k == null) return null
  try {
    const s = typeof k === 'string' ? k : String((k as { toString(): string }).toString())
    return s.trim() || null
  } catch {
    return null
  }
}

/** The 64 signature bytes from Phantom's `{ signature }` or a bare Uint8Array. */
function signatureBytes(out: unknown): Uint8Array | null {
  const raw = out instanceof Uint8Array ? out : (out as { signature?: unknown } | null)?.signature
  if (raw instanceof Uint8Array) return raw
  if (Array.isArray(raw) && raw.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) return Uint8Array.from(raw as number[])
  return null
}

// ─── storage (every access guarded: private windows / blocked storage) ─────

function readAddress(): string | null {
  try {
    const v = localStorage.getItem(ADDRESS_KEY)
    if (v === null) return null
    if (isSolanaAddress(v)) return v
    localStorage.removeItem(ADDRESS_KEY) // malformed or tampered: drop it
  } catch {
    /* storage unavailable */
  }
  return null
}

function writeAddress(a: string | null): void {
  try {
    if (a) localStorage.setItem(ADDRESS_KEY, a)
    else localStorage.removeItem(ADDRESS_KEY)
  } catch {
    /* storage unavailable */
  }
}

function sessionValid(s: AuthSession | null | undefined, address: string | null): s is AuthSession {
  return (
    !!s &&
    typeof s.token === 'string' &&
    s.token.length > 0 &&
    s.token.length < 4096 &&
    isSolanaAddress(s.wallet) &&
    s.wallet === address &&
    typeof s.expiresAt === 'number' &&
    s.expiresAt - EXPIRY_MARGIN_MS > Date.now()
  )
}

/** A stored token is restored only while unexpired and only for the stored address. */
function readSession(address: string | null): AuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (raw === null) return null
    const s = JSON.parse(raw) as AuthSession
    if (sessionValid(s, address)) return { token: s.token, wallet: s.wallet, expiresAt: s.expiresAt }
    localStorage.removeItem(SESSION_KEY)
  } catch {
    try {
      localStorage.removeItem(SESSION_KEY)
    } catch {
      /* storage unavailable */
    }
  }
  return null
}

function writeSession(s: AuthSession | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify({ token: s.token, wallet: s.wallet, expiresAt: s.expiresAt }))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* storage unavailable: the session lasts for this page only */
  }
}

// ─── REST ───────────────────────────────────────────────────────────────────

async function api<T>(url: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new Error("Can't reach the LUSCA server. Try again when it is back.")
  }
  if (!res.ok) {
    let detail = ''
    try {
      const j = (await res.json()) as { error?: unknown; msg?: unknown; message?: unknown }
      const d = j?.error ?? j?.msg ?? j?.message
      if (typeof d === 'string') detail = d.slice(0, 200)
    } catch {
      /* not JSON */
    }
    if (res.status === 404) throw new Error('Wallet verification is not available on this server yet.')
    if (res.status === 429) throw new Error(`Too many verification attempts. ${detail || 'Wait a minute and try again.'}`)
    if (res.status >= 500) throw new Error(`The LUSCA server could not verify the wallet right now (HTTP ${res.status}). Try again shortly.`)
    throw new Error(detail ? `Verification failed: ${detail}` : `Verification failed (HTTP ${res.status}).`)
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new Error('The LUSCA server sent an unreadable reply. Try again.')
  }
}

function errorCode(e: unknown): number | null {
  const c = (e as { code?: unknown } | null)?.code
  return typeof c === 'number' ? c : null
}

function describe(e: unknown, what: 'connect' | 'sign'): string {
  if (errorCode(e) === 4001 || /reject|declin|denied|cancel/i.test(e instanceof Error ? e.message : String(e))) {
    return what === 'connect' ? 'Connection request declined. Nothing was linked.' : 'Signature request declined. Nothing was linked.'
  }
  const msg = e instanceof Error ? e.message : String(e)
  return msg.slice(0, 240) || (what === 'connect' ? 'The wallet did not connect.' : 'Verification failed.')
}

export const NO_WALLET_MSG = 'No Solana wallet found in this browser. Install Phantom to receive SOL payouts. Earning credits on this device needs no wallet.'
export const NO_SIGN_MSG =
  'This wallet cannot sign messages, so it cannot be verified here. Use Phantom (or another wallet with message signing). Credits keep accruing to this device.'

// ─── store ──────────────────────────────────────────────────────────────────

export type WalletStatus = 'none' | 'connected' | 'verifying' | 'verified'

export interface WalletState {
  status: WalletStatus
  /** Connected (or restored) Solana address; verified only when `status === 'verified'`. */
  address: string | null
  /** Sign-in token for `address`, present only when verified. */
  session: AuthSession | null
  /** A Solana wallet provider is injected in this browser. */
  available: boolean
  /** The wallet's connect prompt is open. */
  connecting: boolean
  error: string | null
  /** Connect the wallet, then verify it (one signed message). */
  connect: () => Promise<void>
  /** Verify the connected wallet: fetch a nonce, sign the sign-in message, exchange it for a token. */
  verify: () => Promise<void>
  /** Forget the address and the token. */
  disconnect: () => Promise<void>
  /** Drop the token (e.g. the server refused it); the address stays, unverified. */
  invalidate: (reason?: string) => void
  clearError: () => void
}

const initialAddress = typeof window === 'undefined' ? null : readAddress()
const initialSession = typeof window === 'undefined' ? null : readSession(initialAddress)

let attempt = 0 // bumped by every verify / disconnect / account change: stale async results are ignored
let expiryTimer: ReturnType<typeof setTimeout> | null = null
const bound = new WeakSet<object>()

export const useWallet = create<WalletState>((set, get) => {
  /** Adopt a (validated) address; a different address drops any verification. */
  const adopt = (address: string) => {
    const s = get()
    if (address === s.address && s.status !== 'none') return
    writeAddress(address)
    if (s.session && s.session.wallet !== address) writeSession(null)
    set({ address, session: s.session?.wallet === address ? s.session : null, status: s.session?.wallet === address ? 'verified' : 'connected' })
  }

  const fail = (my: number, error: string) => {
    if (my !== attempt) return
    const s = get()
    // A failed re-verification keeps a still-valid token for the same address.
    const keep = sessionValid(s.session, s.address) ? s.session : null
    set({ status: keep ? 'verified' : s.address ? 'connected' : 'none', session: keep, connecting: false, error })
  }

  return {
    status: initialSession ? 'verified' : initialAddress ? 'connected' : 'none',
    address: initialAddress,
    session: initialSession,
    available: !!provider(),
    connecting: false,
    error: null,

    connect: async () => {
      const s = get()
      if (s.connecting || s.status === 'verifying') return
      const p = provider()
      set({ available: !!p })
      if (!p) {
        set({ error: NO_WALLET_MSG })
        return
      }
      bindProvider(p)
      set({ connecting: true, error: null })
      let address: string | null
      try {
        const r = await p.connect()
        address = keyText((r as { publicKey?: KeyLike } | undefined)?.publicKey) ?? keyText(p.publicKey)
      } catch (e) {
        set({ connecting: false, error: describe(e, 'connect') })
        return
      }
      if (!isSolanaAddress(address)) {
        // not a Solana public key: ignore it entirely (never stored, never sent)
        set({ connecting: false, error: 'The wallet did not return a Solana address. Nothing was saved.' })
        return
      }
      set({ connecting: false })
      adopt(address)
      if (get().status !== 'verified') await get().verify()
    },

    verify: async () => {
      if (get().status === 'verifying') return
      const my = ++attempt
      const p = provider()
      set({ available: !!p })
      if (!p) return fail(my, NO_WALLET_MSG)
      bindProvider(p)
      set({ status: 'verifying', error: null })
      try {
        // Sign with the account the wallet has open right now.
        let address = keyText(p.publicKey)
        if (!address) {
          const r = await p.connect()
          address = keyText((r as { publicKey?: KeyLike } | undefined)?.publicKey) ?? keyText(p.publicKey)
        }
        if (my !== attempt) return
        if (!isSolanaAddress(address)) return fail(my, 'The wallet did not return a Solana address. Nothing was saved.')
        if (address !== get().address) {
          writeAddress(address)
          writeSession(null)
          set({ address, session: null })
        }
        if (typeof p.signMessage !== 'function') return fail(my, NO_SIGN_MSG)

        const n = await api<AuthNonce>(`/api/auth/nonce?wallet=${encodeURIComponent(address)}`)
        if (my !== attempt) return
        // The message must name this page's host and this wallet on its first two lines (the dev
        // proxy rewrites Host, so only the shape is checked under `vite dev`).
        const lines = typeof n?.message === 'string' ? n.message.split('\n') : []
        const HEAD = ' wants you to sign in with your Solana account:'
        const hostOk = lines[0] === `${location.host}${HEAD}` || (import.meta.env.DEV && typeof lines[0] === 'string' && lines[0].endsWith(HEAD))
        const header = hostOk && lines[1] === address
        if (!n || typeof n.nonce !== 'string' || typeof n.message !== 'string' || !header || !n.message.includes(n.nonce)) {
          return fail(my, 'The server sent an unexpected sign-in message. Nothing was signed.')
        }

        let out: unknown
        try {
          out = await p.signMessage(new TextEncoder().encode(n.message), 'utf8')
        } catch (e) {
          return fail(my, describe(e, 'sign'))
        }
        if (my !== attempt) return
        const sig = signatureBytes(out)
        if (!sig || sig.length !== 64) return fail(my, 'The wallet returned an unexpected signature. Nothing was linked.')

        const req: AuthVerifyRequest = { wallet: address, nonce: n.nonce, signature: base58Encode(sig) }
        const sess = await api<AuthSession>('/api/auth/verify', req)
        if (my !== attempt) return
        if (!sessionValid(sess, address)) return fail(my, 'The server returned an invalid sign-in. Try again.')

        const session: AuthSession = { token: sess.token, wallet: sess.wallet, expiresAt: sess.expiresAt }
        writeSession(session)
        set({ status: 'verified', session, error: null })
        scheduleExpiry(session)
        refreshWalletPayouts(address)
        refreshPayouts()
      } catch (e) {
        fail(my, describe(e, 'sign'))
      }
    },

    disconnect: async () => {
      attempt++
      writeSession(null)
      writeAddress(null)
      clearExpiry()
      set({ status: 'none', address: null, session: null, connecting: false, error: null })
      try {
        await provider()?.disconnect()
      } catch {
        /* the wallet may already be disconnected */
      }
    },

    invalidate: (reason) => {
      const s = get()
      if (!s.session && s.status !== 'verifying') {
        if (reason) set({ error: reason })
        return
      }
      attempt++
      writeSession(null)
      clearExpiry()
      set({ status: s.address ? 'connected' : 'none', session: null, error: reason ?? null })
    },

    clearError: () => set({ error: null }),
  }
})

// ─── provider events + token expiry ─────────────────────────────────────────

function onAccountChanged(pk: unknown): void {
  const next = keyText(pk)
  const s = useWallet.getState()
  if (next && next === s.address) return // same account (some wallets re-emit): keep the verification
  attempt++ // any verification in flight belongs to the old account
  writeSession(null)
  clearExpiry()
  if (next && isSolanaAddress(next)) {
    writeAddress(next)
    useWallet.setState({ status: 'connected', address: next, session: null, connecting: false, error: null })
  } else {
    writeAddress(null)
    useWallet.setState({ status: 'none', address: null, session: null, connecting: false })
  }
}

function bindProvider(p: SolProvider): void {
  if (bound.has(p) || typeof p.on !== 'function') return
  bound.add(p)
  try {
    p.on('accountChanged', onAccountChanged)
  } catch {
    /* provider without events */
  }
}

function clearExpiry(): void {
  if (expiryTimer !== null) clearTimeout(expiryTimer)
  expiryTimer = null
}

/** Drop the verification when the token expires (timers cap at ~24.8 days, so re-arm). */
function scheduleExpiry(s: AuthSession): void {
  clearExpiry()
  const left = s.expiresAt - EXPIRY_MARGIN_MS - Date.now()
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null
      const cur = useWallet.getState().session
      if (!cur || cur.token !== s.token) return
      if (cur.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return scheduleExpiry(cur)
      useWallet.getState().invalidate('Your wallet sign-in expired. Verify the wallet again to keep receiving SOL.')
    },
    Math.max(0, Math.min(left, 2_000_000_000)),
  )
}

if (typeof window !== 'undefined') {
  if (initialSession) scheduleExpiry(initialSession)
  const p = provider()
  if (p) {
    bindProvider(p)
    // Silent reconnect (never prompts) so account switches are noticed; only for a returning wallet.
    if (initialAddress) {
      p.connect({ onlyIfTrusted: true })
        .then((r) => {
          const k = keyText((r as { publicKey?: KeyLike } | undefined)?.publicKey) ?? keyText(p.publicKey)
          if (k && k !== useWallet.getState().address) onAccountChanged(k)
        })
        .catch(() => {
          /* not trusted yet: the stored state stands until the user connects */
        })
    }
  } else {
    // Some wallets inject after the page scripts run.
    window.addEventListener('load', () => useWallet.setState({ available: !!provider() }), { once: true })
  }
}

// ─── helpers for other modules ──────────────────────────────────────────────

/** The sign-in token while the wallet is verified and the token unexpired, else null. */
export function authToken(): string | null {
  const s = useWallet.getState()
  return s.status === 'verified' && sessionValid(s.session, s.address) ? s.session.token : null
}

/** The verified wallet address, or null. */
export function verifiedWallet(): string | null {
  const s = useWallet.getState()
  return s.status === 'verified' && sessionValid(s.session, s.address) ? s.session.wallet : null
}

export function shortAddr(a: string | null): string {
  if (!a) return '—'
  return `${a.slice(0, 4)}…${a.slice(-4)}`
}
