// What the Node page panels show of this browser's saved account (src/lib/account.ts) and of
// this session.
//
// Saved: the server's ledger totals for the identity it resolved (verified wallet, else this
// device), gated on the connection, "—" while unknown.
//
// This session: what this page's neuron counted since the panels began following the current
// ledger identity. That is the page load, or the moment the wallet sign-in changed (verified,
// switched, signed out), so a session figure never belongs to another account than the all-time
// total beside it.
import { create } from 'zustand'
import type { AccountView } from '@shared/protocol'
import { useAccount } from '@/lib/account'
import { useNeuron } from '@/lib/gpu'
import { shortAddr, useWallet } from '@/lib/wallet'

// ─── saved account ──────────────────────────────────────────────────────────

/** The saved ledger account as the panels show it. */
export interface Saved {
  /**
   * Server totals, all-time for the identity the server resolved (verified wallet, else this
   * device). null while unknown: server unreachable, its first answer for the current identity
   * not in yet, or no identity it can key. A resolved identity without an account is a real zero.
   */
  acct: AccountView | null
  /** Connected, waiting for the server's first answer for the current identity. */
  loading: boolean
  /** "this device" / "wallet AbCd…WxYz" (null while unknown). */
  to: string | null
  /** The short wallet address in `to` (base58 is case-sensitive: never uppercase it). */
  addr: string | null
  /**
   * Wallet scope: what stays on this browser's device account (credits earned before the wallet
   * was verified), null when nothing does. Not part of `acct`.
   */
  rest: AccountView | null
}

/** Totals for an identity the ledger has no account for yet: nothing earned so far. */
function emptyAccount(kind: 'wallet' | 'device', wallet: string | null): AccountView {
  return { kind, wallet, ink: 0, pendingInk: 0, periodInk: 0, jobs: 0, verified: 0, failed: 0, flops: 0, firstSeen: 0, lastSeen: 0 }
}

/** This browser's saved account from the server ('account' pushes), gated on the connection. */
export function useSaved(live: boolean): Saved {
  const scope = useAccount((s) => s.scope)
  const account = useAccount((s) => s.account)
  const device = useAccount((s) => s.deviceAccount)
  const loaded = useAccount((s) => s.loaded)
  const verifiedAddr = useWallet((s) => (s.status === 'verified' ? (s.session?.wallet ?? null) : null))
  if (!live) return { acct: null, loading: false, to: null, addr: null, rest: null }
  if (!loaded) return { acct: null, loading: true, to: null, addr: null, rest: null }
  if (!scope) return { acct: null, loading: false, to: null, addr: null, rest: null }
  const acct = account ?? emptyAccount(scope, scope === 'wallet' ? verifiedAddr : null)
  const addr = scope === 'wallet' ? shortAddr(acct.wallet ?? verifiedAddr) : null
  // 0.01 is the smallest amount the panel shows
  const rest = scope === 'wallet' && device && (device.ink >= 0.005 || device.pendingInk >= 0.005) ? device : null
  return { acct, loading: false, to: addr ? `wallet ${addr}` : 'this device', addr, rest }
}

/** "just now", "3 min ago", "5 h ago", "2 d ago". */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, (now - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

// ─── this session ───────────────────────────────────────────────────────────

export interface SessionCounts {
  /** Confirmed credits (INK) counted from the server's verdicts. */
  ink: number
  /** Verified jobs the ledger counts already: dedupe jobs, and gradients whose escrow a full audit released. */
  confirmed: number
  /** Every verified job, including gradients still pending audit. */
  verified: number
  failed: number
  jobs: number
  flops: number
}

const ZERO: SessionCounts = { ink: 0, confirmed: 0, verified: 0, failed: 0, jobs: 0, flops: 0 }

/** The neuron's page-lifetime counters when the current identity began. */
const useBase = create<SessionCounts>(() => ZERO)

function counters(): SessionCounts {
  const s = useNeuron.getState()
  return { ink: s.ink, confirmed: Math.max(0, s.verified - s.trainHeld), verified: s.verified, failed: s.failed, jobs: s.jobs, flops: s.flops }
}

// The account store drops `loaded` exactly when the identity changes: count this session from here.
useAccount.subscribe((s, prev) => {
  if (prev.loaded && !s.loaded) useBase.setState(counters())
})

const round2 = (n: number) => Math.round(n * 100) / 100

/** This session's counts for the identity the panels show. */
export function useSession(): SessionCounts {
  const base = useBase()
  const ink = useNeuron((s) => s.ink)
  const verified = useNeuron((s) => s.verified)
  const held = useNeuron((s) => s.trainHeld)
  const failed = useNeuron((s) => s.failed)
  const jobs = useNeuron((s) => s.jobs)
  const flops = useNeuron((s) => s.flops)
  return {
    ink: Math.max(0, round2(ink - base.ink)),
    confirmed: Math.max(0, verified - held - base.confirmed),
    verified: Math.max(0, verified - base.verified),
    failed: Math.max(0, failed - base.failed),
    jobs: Math.max(0, jobs - base.jobs),
    flops: Math.max(0, flops - base.flops),
  }
}
