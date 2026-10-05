// Small shared pieces for the treasury views: copy button, explorer links, live clocks.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PayoutCluster } from '@shared/payouts'
import { useNow } from '@/lib/hooks'
import { solscanAccount, solscanTx } from '@/lib/payouts'
import { DASH, fmtAge, fmtCountdown, shortKey } from './format'

/** Panel header in the site idiom: orange index letter, bold title, right-hand meta. */
export function Head({ k, title, meta }: { k: string; title: string; meta?: ReactNode }) {
  return (
    <div className="panel-head">
      <span>
        <span className="hot">{k}</span>&nbsp;&nbsp;<b>{title}</b>
      </span>
      {meta != null && <span className="tre-meta">{meta}</span>}
    </div>
  )
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const done = document.execCommand('copy')
    document.body.removeChild(ta)
    return done
  } catch {
    return false
  }
}

/** Copy button with a short confirmation; falls back to execCommand when the Clipboard API is unavailable. */
export function CopyButton({ text, what, onResult }: { text: string; what: string; onResult?: (ok: boolean) => void }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className={`tre-copy ${state === 'ok' ? 'ok' : ''} ${state === 'fail' ? 'fail' : ''}`}
      aria-label={`Copy ${what}`}
      onClick={async () => {
        const ok = await copyText(text)
        setState(ok ? 'ok' : 'fail')
        onResult?.(ok)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setState('idle'), 1600)
      }}
    >
      <span aria-live="polite">{state === 'ok' ? 'copied' : state === 'fail' ? 'copy failed' : 'copy'}</span>
    </button>
  )
}

/** Short base58 key; the full value shows on hover and is read out to screen readers. */
export function Key({ value, className }: { value: string; className?: string }) {
  return (
    <span className={`tre-key mono ${className ?? ''}`} title={value}>
      <span aria-hidden="true">{shortKey(value)}</span>
      <span className="sr-only">{value}</span>
    </span>
  )
}

export function AccountLink({ address, cluster, children }: { address: string; cluster?: PayoutCluster; children?: ReactNode }) {
  return (
    <a className="tre-ext mono" href={solscanAccount(address, cluster)} target="_blank" rel="noopener noreferrer" aria-label={`View ${shortKey(address)} on Solscan (opens in a new tab)`}>
      {children ?? 'solscan'}
      <span aria-hidden="true">↗</span>
    </a>
  )
}

export function TxLink({ sig, cluster }: { sig: string; cluster?: PayoutCluster }) {
  return (
    <a className="tre-ext tre-tx mono" href={solscanTx(sig, cluster)} target="_blank" rel="noopener noreferrer" title={sig} aria-label={`Transaction ${shortKey(sig)} on Solscan (opens in a new tab)`}>
      {shortKey(sig)}
      <span aria-hidden="true">↗</span>
    </a>
  )
}

/** "updated 12s ago" — ticks every second. */
export function Ago({ ts, prefix = 'updated' }: { ts: number | null | undefined; prefix?: string }) {
  const now = useNow(1000)
  if (ts == null || !Number.isFinite(ts)) return <span className="tre-ago">{DASH}</span>
  return (
    <span className="tre-ago num">
      {prefix} {fmtAge(now - ts)}
    </span>
  )
}

/** Live countdown to a server timestamp. At zero it waits for the server instead of guessing. */
export function Countdown({ to, skew }: { to: number; skew: number }) {
  const now = useNow(1000)
  const left = to - (now + skew)
  return (
    <>
      <span className="tre-big num" role="timer" aria-live="off">
        {fmtCountdown(left)}
      </span>
      {left <= 0 && <span className="tre-sub">period closing — waiting for the server</span>}
    </>
  )
}
