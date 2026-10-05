// Formatting for the treasury & payouts views. Every input is a value the server sent;
// null / non-finite inputs render as "—", never as a guessed number.
import type { PayoutCluster, PayoutRules, PeriodStatus, WalletPayoutRow } from '@shared/payouts'

export const DASH = '—'

const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v)

/** INK with two decimals, tabular. */
export function fmtInk(v: number | null | undefined): string {
  return ok(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : DASH
}

/** Exact SOL amount for rules ("0.05 SOL", "5 SOL", "0.001 SOL"): no padding, no rounding. */
export function fmtSolExact(v: number | null | undefined): string {
  return ok(v) ? `${v.toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL` : DASH
}

/** 0.5 → "50%". */
export function fmtShare(v: number | null | undefined): string {
  return ok(v) ? `${(v * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%` : DASH
}

/** A value already in percent (0–100) → "12.34%". */
export function fmtPct(v: number | null | undefined): string {
  return ok(v) ? `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}%` : DASH
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "2026-10-05 12:00 UTC" */
export function fmtUtc(ts: number | null | undefined): string {
  if (!ok(ts)) return DASH
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
}

/** "12:00 UTC" */
export function fmtUtcTime(ts: number | null | undefined): string {
  if (!ok(ts)) return DASH
  const d = new Date(ts)
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
}

/** Countdown "3:07:05" (h:mm:ss); never negative. */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  return `${h}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`
}

/** "12s ago", "4m ago", "2h ago", "3d ago". */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** "7xKX…a9Fq" */
export function shortKey(a: string, head = 4, tail = 4): string {
  return a.length > head + tail + 1 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a
}

export function clusterLabel(c: PayoutCluster | undefined): string | null {
  if (c === 'devnet') return 'devnet'
  if (c === 'custom') return 'custom rpc'
  return null
}

/** Payout times of day for a period length, e.g. 12 → "00:00 and 12:00 UTC". */
export function fmtSchedule(everyHours: number | null | undefined): string {
  if (!ok(everyHours) || everyHours <= 0) return DASH
  const n = 24 / everyHours
  if (Number.isInteger(n) && n >= 1 && n <= 6) {
    const times = Array.from({ length: n }, (_, i) => `${pad2(i * everyHours)}:00`)
    if (times.length === 1) return `${times[0]} UTC`
    return `${times.slice(0, -1).join(', ')} and ${times[times.length - 1]} UTC`
  }
  return 'aligned to UTC'
}

/** Human status for a closed period. dryrun periods were calculated but never sent. */
export function periodStatus(s: PeriodStatus): { text: string; tone: 'ok' | 'hot' | 'dim' | 'err' } {
  switch (s) {
    case 'done':
      return { text: 'paid', tone: 'ok' }
    case 'sending':
      return { text: 'sending', tone: 'hot' }
    case 'planned':
      return { text: 'planned', tone: 'dim' }
    case 'dryrun':
      return { text: 'planned — no transfer', tone: 'dim' }
    case 'failed':
      return { text: 'failed', tone: 'err' }
  }
  return { text: String(s), tone: 'dim' }
}

export function walletRowStatus(s: WalletPayoutRow['status']): { text: string; tone: 'ok' | 'hot' | 'dim' | 'err' } {
  switch (s) {
    case 'sent':
      return { text: 'paid', tone: 'ok' }
    case 'pending':
      return { text: 'pending', tone: 'hot' }
    case 'carried':
      return { text: 'carried over', tone: 'dim' }
    case 'dryrun':
      return { text: 'planned — no transfer', tone: 'dim' }
  }
  return { text: String(s), tone: 'dim' }
}

/** Rule rows rendered from the server's PayoutRules (never hardcoded). */
export function ruleRows(r: PayoutRules | null): { k: string; v: string; d?: string }[] {
  return [
    {
      k: 'payout period',
      v: r ? `every ${r.everyHours} h` : DASH,
      d: r ? fmtSchedule(r.everyHours) : undefined,
    },
    {
      k: 'payout pool',
      v: r ? `min(${fmtSolExact(r.maxSol)}, ${fmtShare(r.share)} × (treasury balance − ${fmtSolExact(r.reserveSol)} reserve − estimated fees))` : DASH,
      d: r ? `the reserve is kept for network fees and rent and is never paid out` : undefined,
    },
    {
      k: 'split',
      v: 'by INK earned in the period',
      d: 'among verified wallets only',
    },
    {
      k: 'per-wallet cap',
      v: r ? `${fmtSolExact(r.maxWalletSol)} per wallet per period` : DASH,
      d: r ? 'the excess carries to the next period' : undefined,
    },
    {
      k: 'minimum payout',
      v: r ? fmtSolExact(r.minSol) : DASH,
      d: r ? 'below it, the wallet’s INK carries over to the next period' : undefined,
    },
    {
      k: 'paid in',
      v: 'SOL, from the treasury wallet',
    },
    {
      k: 'who is paid',
      v: 'wallets proven by a signed message',
      d: 'one plain-text message, not a transaction; it costs nothing. LUSCA never asks for transactions, private keys or seed phrases',
    },
    {
      k: 'funding',
      v: 'creator fees from the owner’s token, routed to the treasury wallet',
      d: 'LUSCA does not launch tokens',
    },
  ]
}
