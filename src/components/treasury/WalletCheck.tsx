// "Check a wallet": read-only lookup of any Solana address against GET /api/payouts/wallet/:address.
// The address is validated locally (base58, 32 bytes) before anything is requested; it is not
// stored and never put in the page URL.
import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { isSolanaAddress } from '@shared/base58'
import type { PayoutCluster, WalletPayouts } from '@shared/payouts'
import { useNow } from '@/lib/hooks'
import { fmtSol, useWalletPayouts } from '@/lib/payouts'
import { CONN_TEXT } from '@/lib/store'
import { useWallet } from '@/lib/wallet'
import { AccountLink, Ago, Head, Key, TxLink } from './bits'
import { DASH, fmtInk, fmtPct, fmtUtc, walletRowStatus } from './format'

const FRESH_MS = 60_000

function errorText(err: string): string {
  // HTTP 4xx other than rate limiting: the server answered but has nothing for this address.
  if (/^HTTP 4\d\d$/.test(err) && err !== 'HTTP 429') return `The server returned no payout data for this address (${err}).`
  return CONN_TEXT.offline
}

function Result({ address, cluster }: { address: string; cluster?: PayoutCluster }) {
  const entry = useWalletPayouts(address)
  const now = useNow(5000)
  const fresh = entry.data != null && entry.at != null && now - entry.at < FRESH_MS
  const d: WalletPayouts | null = entry.error ? (fresh ? entry.data : null) : entry.data
  const status = d ? null : entry.error ? errorText(entry.error) : 'Reading this wallet from the LUSCA server…'
  // Signed the sign-in message in this browser (the server marks it verified once work is linked).
  const signedHere = useWallet((s) => s.status === 'verified' && s.session?.wallet === address)

  return (
    <div className="tre-wr" aria-live="polite" aria-busy={!d && !entry.error}>
      <div className="tre-wr-top">
        <span className="tre-addr-r">
          <Key value={address} />
          <AccountLink address={address} cluster={cluster} />
        </span>
        {d ? (
          <span className={`tag ${d.verified || signedHere ? 'hot' : ''}`}>{d.verified ? 'verified' : signedHere ? 'signed in' : 'no linked work'}</span>
        ) : (
          <span className="tag">{DASH}</span>
        )}
      </div>

      {status && <p className="tre-wr-status mono">{status}</p>}

      {d && (
        <p className="tre-wr-note">
          {d.verified ? (
            'This wallet is verified and has verified GPU work linked to it. It receives its share of each payout.'
          ) : signedHere ? (
            <>
              This wallet is verified in this browser. No verified GPU work is linked to it yet: it gets a share of payouts once a device earns INK while it
              is verified. <Link to="/node">Start earning →</Link>
            </>
          ) : (
            <>
              No verified GPU work is linked to this wallet yet, so it has no share in payouts. To link one you own, verify it on{' '}
              <Link to="/node">Start earning</Link> (one plain-text message, not a transaction, costs nothing), then run a device while it is verified.
            </>
          )}
        </p>
      )}

      <dl className="tre-wstats">
        <div>
          <dt className="label">INK this period</dt>
          <dd className="num">{d ? (d.period ? fmtInk(d.period.ink) : 'payouts not started') : DASH}</dd>
        </div>
        <div>
          <dt className="label">estimated share</dt>
          <dd className="num">
            {d?.period ? (
              <>
                {fmtSol(d.period.estSol)} <span className="tre-dim">· {fmtPct(d.period.sharePct)}</span>
              </>
            ) : d ? (
              'payouts not started'
            ) : (
              DASH
            )}
          </dd>
          {d?.period && <dd className="tre-wstats-n">if the period closed now</dd>}
        </div>
        <div>
          <dt className="label">SOL paid, lifetime</dt>
          <dd className="num hot">{fmtSol(d?.paidSol)}</dd>
        </div>
        <div>
          <dt className="label">INK, lifetime</dt>
          <dd className="num">{fmtInk(d?.totalInk)}</dd>
        </div>
      </dl>

      <table className="tre-table tre-wt">
        <caption className="sr-only">Payouts to this wallet, newest first</caption>
        <thead>
          <tr>
            <th scope="col">period</th>
            <th scope="col">closed (UTC)</th>
            <th scope="col" className="r">
              INK
            </th>
            <th scope="col" className="r">
              SOL
            </th>
            <th scope="col">status</th>
            <th scope="col">transaction</th>
          </tr>
        </thead>
        <tbody>
          {(d?.history ?? []).map((r) => {
            const st = walletRowStatus(r.status)
            return (
              <tr key={`${r.periodId}-${r.tx ?? r.status}`}>
                <th scope="row" className="num" data-l="period">
                  {r.periodId}
                </th>
                <td className="num" data-l="closed (UTC)">
                  {fmtUtc(r.closedAt).replace(' UTC', '')}
                </td>
                <td className="num r" data-l="INK">
                  {fmtInk(r.ink)}
                </td>
                <td className="num r" data-l="SOL">
                  {fmtSol(r.sol)}
                </td>
                <td data-l="status">
                  <span className={`tre-st tre-st-${st.tone}`}>{st.text}</span>
                </td>
                <td data-l="transaction">{r.tx ? <TxLink sig={r.tx} cluster={cluster} /> : <span className="tre-dim">{DASH}</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {d && !d.history.length && <p className="tre-empty mono">No payouts to this wallet yet.</p>}
      {d && (
        <p className="tre-wr-foot">
          <Ago ts={entry.at} />
        </p>
      )}
    </div>
  )
}

export function WalletCheck({ cluster }: { cluster?: PayoutCluster }) {
  const [draft, setDraft] = useState('')
  const [address, setAddress] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const id = useId()

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const v = draft.trim()
    if (!v) return setErr('Paste a Solana address.')
    if (!isSolanaAddress(v)) return setErr('Not a Solana address. Expected a base58 public key of 32–44 characters.')
    setErr(null)
    setAddress(v)
  }

  return (
    <div className="panel tre-wallet">
      <Head k="W" title="Check a wallet" meta="read-only" />
      <div className="tre-body">
        <form className="tre-form" onSubmit={submit} noValidate>
          <label htmlFor={`${id}-a`} className="label">
            Solana address
          </label>
          <div className="tre-form-row">
            <input
              id={`${id}-a`}
              className="tre-input mono"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                if (err) setErr(null)
              }}
              placeholder="base58 public key"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={64}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? `${id}-e` : `${id}-h`}
            />
            <button type="submit" className="btn primary tre-go">
              Check
            </button>
          </div>
          {err ? (
            <p id={`${id}-e`} className="tre-err mono" role="alert">
              {err}
            </p>
          ) : (
            <p id={`${id}-h`} className="tre-help">
              Shows the wallet’s INK this period, its estimated share, SOL paid and payout history. Nothing is signed and nothing is stored.
            </p>
          )}
        </form>
        {address && <Result key={address} address={address} cluster={cluster} />}
      </div>
    </div>
  )
}
