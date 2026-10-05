// INK and payout wording, shared by the landing page, the manual and the legal pages.
// The rules are read from the running server (GET /api/payouts → rules); until it
// answers, the documented server defaults (env LUSCA_PAYOUT_*) are shown and labelled
// as defaults. Nothing here estimates an amount.
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import type { PayoutMode, PayoutRules, PayoutsOverview } from '@shared/payouts'
import { refreshPayouts, usePayouts, usePayoutStore } from '@/lib/payouts'

/** One sentence, used verbatim wherever INK is defined. */
export const INK_LINE = 'INK — points for verified GPU work. Each payout period, the payout pool is split by INK and paid in SOL to verified wallets.'

/** Server defaults (server/payouts, env LUSCA_PAYOUT_*). Shown only until /api/payouts answers. */
export const DEFAULT_PAYOUT_RULES: PayoutRules = {
  everyHours: 12,
  share: 0.5,
  reserveSol: 0.05,
  maxSol: 5,
  maxWalletSol: 1,
  minSol: 0.001,
}

export interface RulesView {
  rules: PayoutRules
  /** true when the values came from this server's /api/payouts */
  fromServer: boolean
  mode: PayoutMode | null
  overview: PayoutsOverview | null
  /** true when /api/payouts has failed and no overview has arrived yet */
  failed: boolean
}

export function usePayoutRules(): RulesView {
  const { overview, overviewError } = usePayouts()
  // A tab opened in the background skips the first fetch; ask again as soon as it becomes visible.
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden && !usePayoutStore.getState().overview) refreshPayouts()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  return overview
    ? { rules: overview.rules, fromServer: true, mode: overview.mode, overview, failed: false }
    : { rules: DEFAULT_PAYOUT_RULES, fromServer: false, mode: null, overview: null, failed: !!overviewError }
}

/** "5 SOL", "0.05 SOL", "0.001 SOL" — the rule values without trailing zeros. */
export function solAmt(v: number): string {
  return `${Number(v.toFixed(9)).toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL`
}

export function pct(v: number): string {
  return `${Number((v * 100).toFixed(4))}%`
}

/** "00:00 and 12:00 UTC" for 12 h; "every 7 h from 00:00 UTC" when the period does not divide a day. */
export function boundaries(everyHours: number): string {
  if (!(everyHours > 0) || 24 % everyHours !== 0) return `every ${everyHours} h from 00:00 UTC`
  const hs: string[] = []
  for (let h = 0; h < 24; h += everyHours) hs.push(`${String(h).padStart(2, '0')}:00`)
  if (hs.length === 1) return `${hs[0]} UTC`
  return `${hs.slice(0, -1).join(', ')} and ${hs[hs.length - 1]} UTC`
}

/** Plain status of the payout engine on this server. `failed`: /api/payouts errored (otherwise a null mode means it is still loading). */
export function payoutStatus(mode: PayoutMode | null, failed = false): string {
  if (mode === 'live') return 'Payouts running'
  if (mode === 'dryrun') return 'Payouts not started — periods are planned on the server, no SOL is sent yet'
  if (mode === 'off') return 'Payouts not started — the payout pool has not been funded yet'
  if (failed) return 'Payout status unavailable — /api/payouts did not respond'
  return 'Checking payout status…'
}

/** End a status line as a sentence without doubling the ellipsis. */
export function sentence(s: string): string {
  return s.endsWith('…') ? s : `${s}.`
}

/** The payout rules as a list. `compact` drops the source line. */
export function PayoutRulesList({ view, compact = false }: { view: RulesView; compact?: boolean }) {
  const r = view.rules
  return (
    <>
      <ul className="dlist payout-rules">
        <li>
          <b>Period:</b> every {r.everyHours} h, aligned to {boundaries(r.everyHours)}.
        </li>
        <li>
          <b>Pool:</b> min({solAmt(r.maxSol)}, {pct(r.share)} × (treasury balance − {solAmt(r.reserveSol)} reserve − estimated fees)).
        </li>
        <li>
          <b>Split:</b> by INK earned in that period among verified wallets.
        </li>
        <li>
          <b>Cap:</b> at most {solAmt(r.maxWalletSol)} per wallet per period; the excess carries to the next period.
        </li>
        <li>
          <b>Dust floor:</b> below {solAmt(r.minSol)}, the wallet’s INK carries over to the next period.
        </li>
        <li>
          <b>Paid</b> in SOL from the treasury wallet, only to wallets proven by a signed message.
        </li>
      </ul>
      {!compact && (
        <p className="payout-src mono">
          {view.fromServer
            ? `Values read from this server (GET /api/payouts) · ${payoutStatus(view.mode)}.`
            : 'Server defaults shown (env LUSCA_PAYOUT_*); the running server has not answered yet.'}{' '}
          Live treasury balance and payout history: <Link to="/earn">Rewards</Link>.
        </p>
      )}
    </>
  )
}
