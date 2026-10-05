// Treasury & payouts — live state of the payout engine, read from GET /api/payouts (and the
// { t: 'payout' } WebSocket push). Nothing here is computed client-side except formatting and
// the countdown to the server's own `endsAt`; when the server is unknown or unreachable every
// value is "—" and a plain status line says why.
import { useState } from 'react'
import type { PayoutCluster, PayoutMode, PayoutRecord, PayoutsOverview } from '@shared/payouts'
import { useNow } from '@/lib/hooks'
import { CONN_TEXT } from '@/lib/store'
import { fmtSol, usePayouts } from '@/lib/payouts'
import { fmtInt } from '@/lib/format'
import { AccountLink, Ago, CopyButton, Countdown, Head, Key, TxLink } from './bits'
import { DASH, clusterLabel, fmtInk, fmtUtc, fmtUtcTime, periodStatus, ruleRows } from './format'
import { WalletCheck } from './WalletCheck'
import './treasury.css'

/** After a failed refresh, keep showing the last server snapshot for this long (then "—"). */
export const FRESH_MS = 60_000
/** Only correct the countdown for the viewer's clock when it is clearly wrong. */
const SKEW_MIN_MS = 30_000
/** The server re-reads the balance every 60 s; older than this is marked stale. */
const BALANCE_STALE_MS = 5 * 60_000

/** Same words as the WebSocket status line (src/lib/store.ts). */
export const UNREACHABLE = CONN_TEXT.offline

type View = 'loading' | 'unreachable' | PayoutMode

/** The overview to display (null = show "—") and which state the section is in. */
export function usePayoutView() {
  const { overview, overviewAt, overviewError } = usePayouts()
  const now = useNow(5000)
  const fresh = overview != null && overviewAt != null && now - overviewAt < FRESH_MS
  const data = overviewError ? (fresh ? overview : null) : overview
  const view: View = data ? data.mode : overviewError ? 'unreachable' : 'loading'
  return { data, view, overviewAt, failing: !!overviewError, now }
}

function Strip({ view, failing, at, everyHours, emptyPool }: { view: View; failing: boolean; at: number | null; everyHours: number | undefined; emptyPool: boolean }) {
  let led = 'led'
  let label: string | null = null
  let text: string
  switch (view) {
    case 'loading':
      text = CONN_TEXT.connecting
      led = 'led pulse'
      break
    case 'unreachable':
      text = UNREACHABLE
      led = 'led tre-led-err'
      break
    case 'off':
      label = 'Payouts not started'
      text = 'the payout pool has not been funded yet.'
      break
    case 'dryrun':
      label = 'Payouts not started'
      text = 'periods are planned on the server, no SOL is sent yet.'
      led = 'led white'
      break
    case 'live':
      label = 'Payouts live'
      text = emptyPool
        ? 'the treasury holds no spendable SOL above the reserve this period.'
        : everyHours ? `the pool is paid in SOL from the treasury wallet every ${everyHours} h.` : 'the pool is paid in SOL from the treasury wallet.'
      led = 'led on'
      break
  }
  const known = view !== 'loading' && view !== 'unreachable'
  return (
    <div className={`tre-strip tre-v-${view}`}>
      <span className={led} aria-hidden="true" />
      <p className="tre-strip-t" role="status">
        {label && <b>{label}</b>}
        {label ? ' — ' : ''}
        {text}
        {known && failing && <span className="tre-warn"> Last refresh failed — retrying.</span>}
      </p>
      {known && <Ago ts={at} prefix="synced" />}
    </div>
  )
}

function TreasuryCard({ o, now }: { o: PayoutsOverview | null; now: number }) {
  const t = o?.treasury
  const [showFull, setShowFull] = useState(false)
  const cl = clusterLabel(o?.cluster)
  const stale = !!t && t.balanceSol != null && (t.stale || (t.updatedAt != null && now - t.updatedAt > BALANCE_STALE_MS))
  // No treasury wallet on the server yet (payouts not started): one clean empty state, no dashes.
  if (o && !t?.address) {
    return (
      <div className="panel tre-card tre-off">
        <Head k="T" title="Treasury wallet" meta={cl ?? 'solana'} />
        <div className="tre-body">
          <p className="tre-off-h">Not funded yet</p>
          <p className="tre-off-p">The treasury address and its live SOL balance are published here when payouts start.</p>
        </div>
      </div>
    )
  }
  return (
    <div className="panel tre-card">
      <Head k="T" title="Treasury wallet" meta={cl ?? 'solana'} />
      <div className="tre-body">
        <span className="label">balance</span>
        <span className="tre-big num">{fmtSol(t?.balanceSol)}</span>
        <span className="tre-sub">
          {t && t.updatedAt == null ? <span className="tre-ago">{t.address ? 'not read yet' : DASH}</span> : <Ago ts={t?.updatedAt} />}
          {stale && (
            <span className="tag tre-stale" title="The latest balance read from the Solana RPC failed. This is the last known balance.">
              stale
            </span>
          )}
        </span>
        <div className="tre-addr">
          <span className="label">address</span>
          {t?.address ? (
            <span className="tre-addr-r">
              <Key value={t.address} />
              <CopyButton text={t.address} what="treasury address" onResult={(ok) => setShowFull(!ok)} />
              <AccountLink address={t.address} cluster={o?.cluster} />
            </span>
          ) : (
            <span className="mono tre-dim">{o ? 'Published here when payouts start' : DASH}</span>
          )}
        </div>
        {showFull && t?.address && (
          <input readOnly className="tre-full mono" value={t.address} aria-label="Treasury address" onFocus={(e) => e.currentTarget.select()} />
        )}
      </div>
    </div>
  )
}

function NextCard({ o, view, skew }: { o: PayoutsOverview | null; view: View; skew: number }) {
  const p = o?.period ?? null
  return (
    <div className="panel tre-card">
      <Head k="N" title={view === 'dryrun' ? 'Next period close' : 'Next payout'} meta={p ? fmtUtcTime(p.endsAt) : DASH} />
      <div className="tre-body">
        <span className="label">time left</span>
        {p ? <Countdown to={p.endsAt} skew={skew} /> : <span className="tre-big num">{DASH}</span>}
        <span className="tre-sub num">{p ? fmtUtc(p.endsAt) : DASH}</span>
        <div className="tre-kvs">
          <div className="kv">
            <span>period</span>
            <span className="num">{p?.id ?? DASH}</span>
          </div>
          <div className="kv">
            <span>started</span>
            <span className="num">{p ? fmtUtc(p.startsAt) : DASH}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function PoolCard({ o, view }: { o: PayoutsOverview | null; view: View }) {
  const p = o?.period ?? null
  return (
    <div className="panel tre-card tre-card-hot">
      <Head k="E" title="Estimated pool" meta="this period" />
      <div className="tre-body">
        <span className="label">if the period closed now</span>
        <span className="tre-big num hot">{fmtSol(p?.estPoolSol)}</span>
        <span className="tre-sub">{view === 'dryrun' ? 'calculated only — no transfer while in verification' : 'final amount is set when the period closes'}</span>
        <div className="tre-kvs">
          <div className="kv">
            <span>credits this period</span>
            <span className="num">{fmtInk(p?.inkSoFar)}</span>
          </div>
          <div className="kv">
            <span>verified wallets</span>
            <span className="num">{p ? fmtInt(p.wallets) : DASH}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function OffCard() {
  return (
    <div className="panel tre-card tre-off">
      <Head k="P" title="Payout period" meta="not started" />
      <div className="tre-body">
        <p className="tre-off-h">Payouts not started</p>
        <p className="tre-off-p">
          The payout pool has not been funded yet. When payouts start, this panel shows the next payout time (UTC), the credits earned in the current period and
          the estimated pool.
        </p>
      </div>
    </div>
  )
}

function Rules({ o }: { o: PayoutsOverview | null }) {
  const rows = ruleRows(o?.rules ?? null)
  return (
    <div className="panel tre-rules">
      <Head k="R" title="Payout rules" meta={o ? 'server settings' : DASH} />
      <table className="tre-rt">
        <caption className="sr-only">Payout rules, as configured on the LUSCA server</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k}>
              <th scope="row">{r.k}</th>
              <td>
                <span className="tre-rv">{r.v}</span>
                {r.d && <span className="tre-rd">{r.d}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TxCell({ rec, cluster }: { rec: PayoutRecord; cluster?: PayoutCluster }) {
  const [all, setAll] = useState(false)
  if (!rec.txs.length) return <span className="tre-dim">{rec.status === 'dryrun' ? 'no transfer' : DASH}</span>
  const shown = all ? rec.txs : rec.txs.slice(0, 2)
  return (
    <span className="tre-txs">
      {shown.map((s) => (
        <TxLink key={s} sig={s} cluster={cluster} />
      ))}
      {rec.txs.length > 2 && (
        <button type="button" className="tre-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? 'show fewer' : `+${rec.txs.length - 2} more`}
        </button>
      )}
    </span>
  )
}

function History({ o }: { o: PayoutsOverview | null }) {
  const rows = o?.history ?? []
  return (
    <div className="panel tre-hist">
      <Head k="H" title="Payout history" meta="newest first" />
      <table className="tre-table">
        <caption className="sr-only">Closed payout periods, newest first</caption>
        <thead>
          <tr>
            <th scope="col">period</th>
            <th scope="col">closed (UTC)</th>
            <th scope="col" className="r">
              pool
            </th>
            <th scope="col" className="r">
              credits
            </th>
            <th scope="col" className="r">
              wallets
            </th>
            <th scope="col">status</th>
            <th scope="col">transactions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const st = periodStatus(r.status)
            return (
              <tr key={r.id}>
                <th scope="row" className="num" data-l="period">
                  {r.id}
                </th>
                <td className="num" data-l="closed (UTC)">
                  {fmtUtc(r.closedAt).replace(' UTC', '')}
                </td>
                <td className="num r" data-l="pool">
                  {fmtSol(r.poolSol)}
                </td>
                <td className="num r" data-l="credits">
                  {fmtInk(r.ink)}
                </td>
                <td className="num r" data-l="wallets">
                  {fmtInt(r.wallets)}
                </td>
                <td data-l="status">
                  <span className={`tre-st tre-st-${st.tone}`}>{st.text}</span>
                </td>
                <td data-l="transactions">
                  <TxCell rec={r} cluster={o?.cluster} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {!rows.length && <p className="tre-empty mono">{o ? 'No payout period has closed yet.' : DASH}</p>}
    </div>
  )
}

/** The whole "Treasury & payouts" block (status, live cards, rules, history, wallet lookup). */
export function TreasuryPayouts() {
  const { data, view, overviewAt, failing, now } = usePayoutView()
  const skewRaw = data && overviewAt != null ? data.at - overviewAt : 0
  const skew = Math.abs(skewRaw) > SKEW_MIN_MS ? skewRaw : 0
  return (
    <div className="tre">
      <Strip view={view} failing={failing} at={overviewAt} everyHours={data?.rules.everyHours} emptyPool={data?.period?.estPoolSol === 0} />
      <div className="tre-grid">
        <TreasuryCard o={data} now={now} />
        {view === 'off' ? (
          <OffCard />
        ) : (
          <>
            <NextCard o={data} view={view} skew={skew} />
            <PoolCard o={data} view={view} />
          </>
        )}
      </div>
      <History o={data} />
      <div className="tre-grid2">
        <Rules o={data} />
        <WalletCheck cluster={data?.cluster} />
      </div>
    </div>
  )
}
