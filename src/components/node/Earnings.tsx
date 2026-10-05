import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ZONES } from '@shared/protocol'
import type { AccountView } from '@shared/protocol'
import type { PayoutCluster } from '@shared/payouts'
import { useAccount, useLastRun } from '@/lib/account'
import { useNeuron } from '@/lib/gpu'
import { useNow, useSampled } from '@/lib/hooks'
import { fmtSol, refreshWalletPayouts, solscanAccount, solscanTx, usePayouts, useWalletPayouts } from '@/lib/payouts'
import { shortAddr, useWallet } from '@/lib/wallet'
import { DASH, fmtDur, fmtInt } from '@/lib/format'
import { PHASE_TEXT, STEP_NAMES, UNREACHABLE_TEXT, serverState, startEarning, usePhase } from './flow'
import type { Phase } from './flow'

/** After a failed payout refresh, keep showing the last server answer for this long. */
const PAYOUT_FRESH_MS = 60_000
import { deviceName, fmtG, fmtInk, scrollToId } from './util'

/** The saved ledger account as the panels show it. */
interface Saved {
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
}

/** Totals for an identity the ledger has no account for yet: nothing earned so far. */
function emptyAccount(kind: 'wallet' | 'device', wallet: string | null): AccountView {
  return { kind, wallet, ink: 0, pendingInk: 0, periodInk: 0, jobs: 0, verified: 0, failed: 0, flops: 0, firstSeen: 0, lastSeen: 0 }
}

/** This browser's saved account from the server ('account' pushes), gated on the connection. */
function useSaved(live: boolean): Saved {
  const scope = useAccount((s) => s.scope)
  const account = useAccount((s) => s.account)
  const loaded = useAccount((s) => s.loaded)
  const verifiedAddr = useWallet((s) => (s.status === 'verified' ? (s.session?.wallet ?? null) : null))
  if (!live) return { acct: null, loading: false, to: null, addr: null }
  if (!loaded) return { acct: null, loading: true, to: null, addr: null }
  if (!scope) return { acct: null, loading: false, to: null, addr: null }
  const acct = account ?? emptyAccount(scope, scope === 'wallet' ? verifiedAddr : null)
  const addr = scope === 'wallet' ? shortAddr(acct.wallet ?? verifiedAddr) : null
  return { acct, loading: false, to: addr ? `wallet ${addr}` : 'this device', addr }
}

/** "just now", "3 min ago", "5 h ago", "2 d ago". */
function ago(ts: number, now: number): string {
  const s = Math.max(0, (now - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

function ledClass(phase: Phase): string {
  if (phase === 'earning' || phase === 'starting') return 'led on pulse'
  if (phase === 'paused' || phase === 'waiting') return 'led white pulse'
  if (phase === 'stopped') return 'led white'
  return 'led'
}

/** The one primary action. Start earning → Starting… → Earning · pause → Paused · resume. */
export function StartButton({ className = '' }: { className?: string }) {
  const { phase, step } = usePhase()
  const live = useSampled((s) => s.conn === 'live', 300)
  const { pause, resume } = useNeuron.getState()
  const cls = `btn lg nd-go ${className}`
  if (phase === 'earning') {
    return (
      <button type="button" className={`${cls} primary nd-go-on`} onClick={() => pause()} aria-label="Earning. Press to pause.">
        <span className="led nd-go-led" aria-hidden="true" />
        earning · pause
      </button>
    )
  }
  if (phase === 'paused') {
    return (
      <button type="button" className={`${cls} nd-go-paused`} onClick={() => resume()} aria-label="Paused. Press to resume.">
        <span className="led white pulse" aria-hidden="true" />
        paused · resume
      </button>
    )
  }
  if (phase === 'starting') {
    return (
      <button type="button" className={`${cls} primary nd-go-busy`} disabled aria-busy="true">
        starting… {step}/4
      </button>
    )
  }
  if (phase === 'waiting' || !live) {
    // Jobs come from the server and only the server awards credits: nothing to start without it.
    return (
      <button type="button" className={`${cls} nd-go-wait`} disabled title={UNREACHABLE_TEXT}>
        <span className="led white pulse" aria-hidden="true" />
        waiting for server
      </button>
    )
  }
  return (
    <button type="button" className={`${cls} primary`} onClick={() => void startEarning()}>
      {phase === 'error' ? 'try again' : phase === 'stopped' ? 'start earning again' : 'start earning'} <span aria-hidden="true">→</span>
    </button>
  )
}

/** Five small bars, the current tier lit. */
function TierBars({ zone }: { zone: string | null }) {
  const at = ZONES.findIndex((z) => z.zone === zone)
  return (
    <span className="tbars" aria-hidden="true">
      {ZONES.map((z, i) => (
        <i key={z.zone} className={i === at ? 'on' : at >= 0 && i < at ? 'past' : undefined} />
      ))}
    </span>
  )
}

/** "05:12 UTC" for a ms-epoch time. */
function utcHm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}

function fmtPct(p: number): string {
  if (!Number.isFinite(p)) return DASH
  return `${p < 1 && p > 0 ? p.toFixed(2) : p.toFixed(1)} %`
}

/** Verify / verified row: who receives SOL for this device's work. */
function WalletLine({ cluster }: { cluster: PayoutCluster | undefined }) {
  const w = useWallet()
  const verified = w.status === 'verified' && w.session ? w.session.wallet : null
  const busy = w.status === 'verifying' || w.connecting
  const act = () => void (w.status === 'connected' ? w.verify() : w.connect())

  if (verified) {
    return (
      <div className="ep-wallet ep-wallet-ok">
        <div className="ep-wallet-v">
          <a className="mono" href={solscanAccount(verified, cluster)} target="_blank" rel="noopener noreferrer" title={verified}>
            {shortAddr(verified)}
          </a>
          <span className="tag hot">Verified</span>
        </div>
        <p className="ep-note">SOL payouts for this device’s credits go to this wallet.</p>
      </div>
    )
  }
  return (
    <div className="ep-wallet">
      <button type="button" className="btn primary ep-verify" onClick={act} disabled={busy}>
        {busy ? 'check your wallet…' : w.status === 'connected' ? `verify ${shortAddr(w.address)} to receive SOL` : 'Verify wallet to receive SOL'}
      </button>
      <p className="ep-note">Credits accrue to this device. Verify a wallet to receive SOL payouts.</p>
      <p className="ep-note ep-fine">You sign one plain-text message. It is not a transaction and costs nothing.</p>
      {w.error && (
        <p className="ep-err" role="alert">
          {w.error}
          {!w.available && (
            <>
              {' '}
              <a href="https://phantom.com/" target="_blank" rel="noopener noreferrer">
                phantom.com →
              </a>
            </>
          )}
        </p>
      )}
    </div>
  )
}

/** Real payout state from GET /api/payouts and /api/payouts/wallet/:address. "—" when unknown. */
function PayoutBlock() {
  const { overview, overviewAt, overviewError } = usePayouts()
  const session = useWallet((s) => (s.status === 'verified' ? s.session : null))
  const addr = session?.wallet ?? null
  const wallet = useWalletPayouts(addr)
  const conn = useSampled((s) => s.conn, 500)
  const now = useNow(1000)

  // After a failed refresh, keep the last server snapshot for up to a minute, then hide it
  // rather than present old values as current.
  const ovFresh = overview != null && overviewAt != null && now - overviewAt < PAYOUT_FRESH_MS
  const ov = overviewError ? (ovFresh ? overview : null) : overview
  const wpFresh = wallet.data != null && wallet.at != null && now - wallet.at < PAYOUT_FRESH_MS
  const wp = addr ? (wallet.error ? (wpFresh ? wallet.data : null) : wallet.data) : null
  const on = !!ov && ov.mode !== 'off'
  const period = on ? ov.period : null
  // Server clock minus client clock, so the countdown matches the server's period boundary.
  const skew = ov && overviewAt ? ov.at - overviewAt : 0
  const left = period ? period.endsAt - (now + skew) : null
  const cluster = ov?.cluster

  let status: string | null = null
  if (!ov) status = overviewError ? (serverState(conn) === 'live' ? 'Payout status is unavailable right now.' : UNREACHABLE_TEXT) : 'Loading payout status…'
  else if (ov.mode === 'off') status = 'Payouts not started — the payout pool has not been funded yet.'
  else if (ov.mode === 'dryrun') status = 'Payouts not started — periods are planned on the server, no SOL is sent yet.'

  const paidTxs = wp ? wp.history.filter((r) => r.tx && r.status === 'sent').slice(0, 3) : []
  const share = wp?.period ?? null

  return (
    <div className="earn-pay" aria-labelledby="ep-h">
      <div className="ep-head mono">
        <span id="ep-h">SOL payouts</span>
        <span className={`ep-mode ${on ? 'ep-mode-on' : ''}`}>{!ov ? DASH : ov.mode === 'off' ? 'not started' : ov.mode === 'dryrun' ? 'dry run' : 'live'}</span>
      </div>
      {status && (
        <p className="ep-status" role="status">
          {status}
        </p>
      )}
      {(on || wp) && (
        <dl className="ep-rows">
          {on && (
          <>
          <div className="ep-row">
            <dt className="label">{ov.mode === 'dryrun' ? 'next period close' : 'next payout'}</dt>
            <dd className="ep-v num">{left == null ? DASH : left > 0 ? `in ${fmtDur(left / 1000)}` : 'closing now'}</dd>
            <dd className="ep-sub mono">{period ? `at ${utcHm(period.endsAt)} · every ${ov.rules.everyHours} h` : DASH}</dd>
          </div>
          <div className="ep-row">
            <dt className="label">pool this period</dt>
            <dd className="ep-v num">{period ? fmtSol(period.estPoolSol) : DASH}</dd>
            <dd className="ep-sub mono">estimate · if the period closed now</dd>
          </div>
          <div className="ep-row">
            <dt className="label">your credits this period</dt>
            <dd className="ep-v num">{share ? fmtInk(share.ink) : DASH}</dd>
            <dd className="ep-sub mono">{addr ? 'verified wallet' : 'verified wallets only'}</dd>
          </div>
          <div className="ep-row">
            <dt className="label">your est. share</dt>
            <dd className="ep-v num">{share ? `${fmtPct(share.sharePct)} · ${fmtSol(share.estSol)}` : DASH}</dd>
            <dd className="ep-sub mono">estimate · changes until the period closes</dd>
          </div>
          </>
          )}
          <div className="ep-row">
            <dt className="label">sol paid so far</dt>
            <dd className="ep-v num">{wp ? fmtSol(wp.paidSol) : DASH}</dd>
            <dd className="ep-sub mono">
              {paidTxs.length > 0
                ? paidTxs.map((r, i) => (
                    <span key={r.tx}>
                      {i > 0 && ' · '}
                      <a href={solscanTx(r.tx!, cluster)} target="_blank" rel="noopener noreferrer" title={`${r.periodId} · ${fmtSol(r.sol)}`}>
                        tx {r.tx!.slice(0, 6)}…
                      </a>
                    </span>
                  ))
                : wp
                  ? 'no payouts yet'
                  : DASH}
            </dd>
          </div>
          <div className="ep-row">
            <dt className="label">your credits all-time</dt>
            <dd className="ep-v num">{wp ? fmtInk(wp.totalInk) : DASH}</dd>
            <dd className="ep-sub mono">{addr ? 'credited to this wallet' : 'verified wallets only'}</dd>
          </div>
        </dl>
      )}
      <WalletLine cluster={cluster} />
    </div>
  )
}

/**
 * What the GPU is doing for SEPIA right now: this session's training counts, and the saved
 * account's confirmed and escrowed credits. Real values only.
 */
function TrainingBlock({ live, phase, step, saved }: { live: boolean; phase: Phase; step: number; saved: Saved }) {
  const task = useNeuron((s) => s.task)
  const trainBackend = useNeuron((s) => s.trainBackend)
  const trainNote = useNeuron((s) => s.trainNote)
  const test = useNeuron((s) => s.trainSelfTest)
  const trainJobs = useNeuron((s) => s.trainJobs)
  const samples = useNeuron((s) => s.trainSamples)
  const applied = useNeuron((s) => s.gradsApplied)
  const stale = useNeuron((s) => s.gradsStale)
  const last = useNeuron((s) => s.lastTrain)
  const ink = useNeuron((s) => s.ink)
  const pending = useNeuron((s) => s.inkPending)
  const forfeited = useNeuron((s) => s.inkForfeited)

  const acct = saved.acct

  let doing: string
  if (!live) doing = 'Not connected to the LUSCA server. No training work runs until it answers.'
  else if (phase === 'idle' || phase === 'stopped' || phase === 'error')
    doing = `Not running. Press Start earning to compute SEPIA training gradients${trainJobs > 0 ? ' again' : ''}.`
  else if (phase === 'paused') doing = 'Paused. A job already in flight finishes; no new training work starts until you resume.'
  else if (phase === 'starting' && step < 4) doing = 'Detecting and benchmarking the GPU before the first training batch.'
  else if (task === 'train' && last) doing = `Training SEPIA: computing gradients on batches of ${last.batch.toLocaleString('en-US')} 16-character windows.`
  else if (task === 'train') doing = 'Training SEPIA: computing gradients on a batch of 16-character windows.'
  else if (task === 'sim') doing = 'Running a near-duplicate check on newly collected pages (dedupe job).'
  else if (last) doing = `Training SEPIA: computing gradients on batches of ${last.batch.toLocaleString('en-US')} 16-character windows. Waiting for the next batch.`
  else if (trainBackend) doing = 'Waiting for the first training batch from the server.'
  else doing = 'Checking the GPU trainer against the reference implementation before the first training batch.'

  return (
    <div className="earn-train" aria-labelledby="et-h">
      <div className="ep-head mono">
        <span id="et-h">SEPIA training</span>
        <span className={`ep-mode ${trainBackend === 'webgpu' ? 'ep-mode-on' : ''}`}>
          {trainBackend === 'webgpu' ? 'gpu · webgpu' : trainBackend === 'cpu' ? 'cpu path' : DASH}
        </span>
      </div>
      <p className="et-doing" aria-live="polite">
        {doing}
      </p>
      {trainBackend === 'cpu' && trainNote && <p className="ep-note et-cpu">Gradients are computed on the CPU because {trainNote}.</p>}
      {trainBackend === 'webgpu' && test && (
        <p className="ep-note ep-fine mono">
          self-test vs CPU reference · cosine {test.cosine.toFixed(6)} · rel. error {test.relErr.toExponential(1)}
        </p>
      )}
      <dl className="et-rows">
        <div className="ep-row">
          <dt className="label">training jobs</dt>
          <dd className="ep-v num">{live ? fmtInt(trainJobs) : DASH}</dd>
          <dd className="ep-sub mono">{live ? `${fmtInt(samples)} windows · this session` : DASH}</dd>
        </div>
        <div className="ep-row">
          <dt className="label">gradients applied</dt>
          <dd className="ep-v num">{live ? fmtInt(applied) : DASH}</dd>
          <dd className="ep-sub mono">
            {live ? (stale > 0 ? `this session · ${fmtInt(stale)} verified, too old to apply` : 'this session · merged into SEPIA by the server') : DASH}
          </dd>
        </div>
        <div className="ep-row">
          <dt className="label">credits confirmed</dt>
          <dd className="ep-v num">{acct ? fmtInk(acct.ink) : DASH}</dd>
          <dd className="ep-sub mono">{acct ? (ink > 0 ? `all-time · +${fmtInk(ink)} this session` : 'all-time · counts toward payouts') : saved.loading ? 'loading…' : DASH}</dd>
        </div>
        <div className="ep-row">
          <dt className="label">credits pending audit</dt>
          <dd className="ep-v num">{acct ? fmtInk(acct.pendingInk) : DASH}</dd>
          <dd className={`ep-sub mono ${forfeited > 0 ? 'et-err' : ''}`}>
            {acct
              ? forfeited > 0
                ? `${fmtInk(forfeited)} forfeited this session by a failed audit`
                : pending > 0
                  ? `${fmtInk(pending)} from this session · held until the next full audit passes`
                  : 'held until the next full audit passes'
              : saved.loading
                ? 'loading…'
                : DASH}
          </dd>
        </div>
      </dl>
      <p className="ep-note ep-fine">
        Every gradient is checked against the server’s own computation on part of the batch, and some are fully recomputed (your first three, then a random
        share). Training credits stay pending until your next full audit passes; a failed audit forfeits all pending credits. Only confirmed credits count. Credits are your share of the payout pool. Payouts are made in SOL.
      </p>
    </div>
  )
}

/** Live "Your earnings" panel: the most important thing on the page once you start. */
export function EarningsPanel() {
  const { phase, step } = usePhase()
  const ink = useNeuron((s) => s.ink)
  const lastTrain = useNeuron((s) => s.lastTrain)
  const verified = useNeuron((s) => s.verified)
  const failed = useNeuron((s) => s.failed)
  const zone = useNeuron((s) => s.zone)
  const bench = useNeuron((s) => s.bench)
  const det = useNeuron((s) => s.detect)
  const backend = useNeuron((s) => s.backend)
  const lastJob = useNeuron((s) => s.lastJob)
  const error = useNeuron((s) => s.error)
  const prog = useNeuron((s) => s.benchProgress)
  const verifiedAddr = useWallet((s) => (s.status === 'verified' ? (s.session?.wallet ?? null) : null))
  const conn = useSampled((s) => s.conn, 500)
  const lastRun = useLastRun()
  const now = useNow(15_000)
  const { pause, resume, stop } = useNeuron.getState()

  const srv = serverState(conn)
  const live = srv === 'live'
  const saved = useSaved(live)
  const acct = saved.acct
  const active = phase === 'earning' || phase === 'paused' || phase === 'waiting'
  const hasCredits = !!acct && (acct.ink > 0 || acct.pendingInk > 0)
  const zinfo = ZONES.find((z) => z.zone === zone)
  const cpu = backend === 'cpu' || bench?.backend === 'cpu'
  const gpu = det || bench ? deviceName(det, cpu) : null
  const benchPct = phase === 'starting' && step === 2 && prog ? Math.max(0, Math.min(100, prog.pct)) : 0

  // Until a benchmark runs on this page, tier / GPU / speed come from this browser's last finished one.
  const lastSub = lastRun ? `last benchmark · ${ago(lastRun.at, now)}` : null
  const lastZinfo = !zinfo && lastRun ? ZONES.find((z) => z.zone === lastRun.zone) : undefined
  const lastGpu = !gpu && lastRun ? (lastRun.backend === 'cpu' ? 'CPU' : lastRun.gpu) : null
  const tier = zinfo ?? lastZinfo

  const total = acct ? fmtInk(acct.ink) : DASH
  let totalSub: ReactNode
  if (!live) totalSub = srv === 'connecting' ? 'connecting to the LUSCA server…' : UNREACHABLE_TEXT
  else if (saved.loading) totalSub = `loading your credits…${ink > 0 ? ` · +${fmtInk(ink)} this session` : ''}`
  // No ledger identity yet (no wallet sign-in, no device id): one is created when the neuron starts.
  else if (!acct) totalSub = `no account on this browser yet · created when you start earning${ink > 0 ? ` · +${fmtInk(ink)} this session` : ''}`
  else {
    const parts = ['confirmed']
    if (acct.pendingInk > 0) parts.push(`${fmtInk(acct.pendingInk)} pending audit`)
    if (ink > 0) parts.push(`+${fmtInk(ink)} this session`)
    totalSub = (
      <>
        {parts.join(' · ')} · credited to {saved.addr ? <>wallet <span className="earn-ink-addr">{saved.addr}</span></> : 'this device'}
      </>
    )
  }
  const totalLabel = acct
    ? `${total} credits confirmed${acct.pendingInk > 0 ? `, ${fmtInk(acct.pendingInk)} pending audit` : ''}, credited to ${saved.to}`
    : saved.loading
      ? 'loading your credits'
      : live
        ? 'no account on this browser yet'
        : 'credits unavailable'

  // New credits on a verified wallet: refresh its period standing (throttled; the server caches 5 s).
  // Keyed on this session's credits and on the server's account pushes. The first account answer
  // is not a change: the payout block fetches on mount.
  const lastRefresh = useRef(0)
  const prevAcct = useRef<string | null>(null)
  const acctKey = acct && acct.kind === 'wallet' ? `${acct.ink}|${acct.pendingInk}|${acct.periodInk}` : null
  useEffect(() => {
    const prev = prevAcct.current
    prevAcct.current = acctKey
    const pushed = prev != null && acctKey != null && prev !== acctKey
    if (!verifiedAddr || !(pushed || ink > 0)) return
    const t = Date.now()
    if (t - lastRefresh.current < 10_000) return
    lastRefresh.current = t
    refreshWalletPayouts(verifiedAddr)
  }, [ink, acctKey, verifiedAddr])

  return (
    <section id="earnings" className={`earn earn-${phase}`} aria-labelledby="earn-h">
      <div className="panel-head earn-head">
        <span>
          <span className="hot">■</span>&nbsp;&nbsp;<b id="earn-h">Your earnings</b>
        </span>
        <span className={`earn-pill earn-pill-${phase}`} role="status" aria-live="polite">
          <span className={ledClass(phase)} aria-hidden="true" />
          {phase === 'starting' ? `starting · ${step}/4` : PHASE_TEXT[phase]}
        </span>
      </div>

      <div className="earn-ink">
        <div className="label">Your credits</div>
        {/* --ink-ch sizes the number so long totals (12,345.67) fit the panel; see .earn-ink-v */}
        <div
          className={`earn-ink-v num ${hasCredits ? 'earn-ink-has' : ''}`}
          style={{ '--ink-ch': total.length } as CSSProperties}
          aria-label={totalLabel}
        >
          {total}
          <span className="earn-ink-u">credits</span>
        </div>
        <div className="earn-ink-sub mono">{totalSub}</div>
      </div>

      <div className="earn-msg" aria-live="polite">
        {phase === 'idle' &&
          (live ? (
            hasCredits || (acct && acct.jobs > 0) ? (
              <p>
                <b>Not running on this page.</b> Your saved credits are shown above. Press <b>Start earning</b> to continue; the GPU check and benchmark take
                about 15 seconds.
              </p>
            ) : (
              <p>
                <b>Not earning yet.</b> Press <b>Start earning</b>. Detecting and benchmarking your GPU takes about 15 seconds, then verified jobs begin.
              </p>
            )
          ) : (
            <p>
              <b>Not earning yet.</b> Jobs come from the LUSCA server, which is not answering right now. Start earning becomes available when it does.
            </p>
          ))}
        {phase === 'starting' && (
          <div className="earn-prog">
            <div className="earn-prog-h mono">
              <span>
                step {step} of 4 · {STEP_NAMES[step - 1]}
              </span>
              {step === 2 && <span className="num">{Math.round(benchPct)}%</span>}
            </div>
            <ol className="earn-prog-bar" aria-hidden="true">
              {STEP_NAMES.map((n, i) => (
                <li key={n} className={i + 1 < step ? 'done' : i + 1 === step ? 'now' : undefined}>
                  {i + 1 === step && step === 2 ? <i style={{ transform: `scaleX(${benchPct / 100})` }} /> : null}
                </li>
              ))}
            </ol>
          </div>
        )}
        {phase === 'earning' && (
          <p className="earn-mode earn-mode-live">
            <span className="led on pulse" aria-hidden="true" />
            Live. Your GPU computes SEPIA training gradients; the server checks every result before it awards credits.
          </p>
        )}
        {phase === 'waiting' && (
          <p className="earn-mode">
            <span className="led white pulse" aria-hidden="true" />
            Waiting for the LUSCA server. No jobs run and no credits are counted until it answers; work resumes on its own.
          </p>
        )}
        {phase === 'paused' && (
          <p>
            <b>Paused.</b> Press Resume to continue. Work also pauses by itself while this tab is hidden.
          </p>
        )}
        {phase === 'stopped' && (
          <p>
            <b>Stopped.</b> Press Start earning to continue.
          </p>
        )}
        {phase === 'error' && (
          <p className="earn-err" role="alert">
            {error ?? 'Something went wrong.'} Press Try again.
          </p>
        )}
      </div>

      {(active || lastTrain || hasCredits) && <TrainingBlock live={live} phase={phase} step={step} saved={saved} />}

      <PayoutBlock />

      <dl className="earn-grid">
        <div className="et">
          <dt className="label">jobs verified</dt>
          <dd className="et-v num">{acct ? fmtInt(acct.verified) : DASH}</dd>
          <dd className="et-sub mono">{acct ? `all-time · ${fmtInt(verified)} this session` : saved.loading ? 'loading…' : 'checked by the server'}</dd>
        </div>
        <div className="et">
          <dt className="label">jobs failed</dt>
          {/* all-time count; red only while this session has failures (a current problem) */}
          <dd className={`et-v num ${acct && failed > 0 ? 'et-err' : ''}`}>{acct ? fmtInt(acct.failed) : DASH}</dd>
          <dd className="et-sub mono">{acct ? `all-time · ${fmtInt(failed)} this session` : saved.loading ? 'loading…' : 'rejected by the server'}</dd>
        </div>
        <div className="et">
          <dt className="label">your tier</dt>
          <dd className="et-v">
            <span className="et-tier">{tier ? tier.zone : DASH}</span>
            <TierBars zone={tier?.zone ?? null} />
          </dd>
          <dd className="et-sub mono">{zinfo ? `×${zinfo.bonus.toFixed(2)} credit bonus` : lastZinfo ? lastSub : 'set by the benchmark'}</dd>
        </div>
        <div className="et">
          <dt className="label">gpu</dt>
          <dd className="et-v et-txt" title={(gpu ?? lastGpu) || undefined}>
            {gpu ?? lastGpu ?? DASH}
          </dd>
          <dd className="et-sub mono">
            {gpu ? (cpu ? 'cpu path' : det?.isFallback ? 'software adapter' : 'webgpu') : lastGpu ? lastSub : 'found when you start'}
          </dd>
        </div>
        <div className="et">
          <dt className="label">speed</dt>
          <dd className="et-v num">
            {bench ? fmtG(bench.gflops) : lastRun ? fmtG(lastRun.gflops) : DASH}
            {(bench || lastRun) && <span className="et-u">GFLOPS</span>}
          </dd>
          <dd className="et-sub mono">{bench ? 'benchmark score' : lastRun ? lastSub : 'measured when you start'}</dd>
        </div>
        <div className="et">
          <dt className="label">last job</dt>
          <dd className="et-v num">
            {lastTrain && Number.isFinite(lastTrain.gflopsEff) ? fmtG(lastTrain.gflopsEff) : lastJob ? fmtG(lastJob.gflopsEff) : DASH}
            {(lastTrain || lastJob) && <span className="et-u">GFLOPS</span>}
          </dd>
          <dd className="et-sub mono">
            {lastTrain
              ? `gradient · B=${lastTrain.batch} · ${lastTrain.ms.toFixed(lastTrain.ms < 10 ? 1 : 0)} ms`
              : lastJob
                ? `${lastJob.rows}×${lastJob.cols}×${lastJob.dim} · ${lastJob.ms.toFixed(lastJob.ms < 10 ? 1 : 0)} ms`
                : 'effective speed'}
          </dd>
        </div>
      </dl>

      {active && (
        <div className="earn-ctl">
          {phase === 'paused' ? (
            <button type="button" className="btn primary lg" onClick={() => resume()}>
              resume
            </button>
          ) : (
            <button type="button" className="btn lg" onClick={() => pause()}>
              pause
            </button>
          )}
          <button type="button" className="btn lg dc-stop" onClick={() => void stop()}>
            stop
          </button>
        </div>
      )}

      <div className="earn-foot mono">
        <span>{live ? 'connected to the LUSCA server' : srv === 'connecting' ? 'connecting to the LUSCA server…' : UNREACHABLE_TEXT}</span>
        <Link to="/earn">how rewards are paid →</Link>
      </div>
    </section>
  )
}

/** Slim fixed bar that keeps your earnings and Pause / Stop in reach once the panel scrolls away. */
export function EarnStrip() {
  const { phase, step } = usePhase()
  const verified = useNeuron((s) => s.verified)
  const failed = useNeuron((s) => s.failed)
  const zone = useNeuron((s) => s.zone)
  const live = useSampled((s) => s.conn === 'live', 500)
  const { acct } = useSaved(live)
  const { pause, resume, stop } = useNeuron.getState()
  const [away, setAway] = useState(false)

  useEffect(() => {
    const el = document.getElementById('earnings')
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setAway(!e.isIntersecting), { rootMargin: '-60px 0px 0px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const show = away && (phase === 'earning' || phase === 'paused' || phase === 'waiting' || phase === 'starting')
  if (!show) return null
  const zinfo = ZONES.find((z) => z.zone === zone)
  return (
    <div className={`estrip estrip-${phase}`} role="region" aria-label="Your earnings, summary">
      <button
        type="button"
        className="estrip-main"
        onClick={() => scrollToId('earnings')}
        aria-label={`${acct ? `Your credits: ${fmtInk(acct.ink)}` : 'Your credits: unavailable'}. ${fmtInt(verified)} jobs verified this session. Show your earnings panel.`}
      >
        <span className={ledClass(phase)} aria-hidden="true" />
        <span className="estrip-st mono">{phase === 'starting' ? `starting · ${step}/4` : PHASE_TEXT[phase]}</span>
        <span className="estrip-ink num">
          {acct ? fmtInk(acct.ink) : DASH}
          <small>credits</small>
        </span>
        <span className="estrip-kv mono">
          {fmtInt(verified)} verified{failed > 0 ? ` · ${fmtInt(failed)} failed` : ''} this session
        </span>
        {zinfo && (
          <span className="estrip-kv estrip-tier mono">
            {zinfo.zone} · ×{zinfo.bonus.toFixed(2)}
          </span>
        )}
      </button>
      <div className="estrip-ctl">
        {(phase === 'earning' || phase === 'waiting') && (
          <button type="button" className="btn" onClick={() => pause()}>
            pause
          </button>
        )}
        {phase === 'paused' && (
          <button type="button" className="btn primary" onClick={() => resume()}>
            resume
          </button>
        )}
        {phase !== 'starting' && (
          <button type="button" className="btn dc-stop" onClick={() => void stop()}>
            stop
          </button>
        )}
      </div>
    </div>
  )
}
