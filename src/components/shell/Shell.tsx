import { useEffect, useState } from 'react'
import { NavLink, Link, Outlet, useLocation } from 'react-router-dom'
import { Logo } from './Logo'
import { Boot } from './Boot'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ConnBadge, connLed } from '@/components/ui/conn'
import { useLive, CONN_TEXT } from '@/lib/store'
import { useConn } from '@/lib/hooks'
import { useWallet, shortAddr, NO_WALLET_MSG } from '@/lib/wallet'
import { useSonar } from '@/lib/sonar'
import { fmtCompact, fmtClock, fmtGflops, fmtInt } from '@/lib/format'
import './shell.css'

export const NAV = [
  { to: '/live', label: 'Live', n: '01' },
  { to: '/node', label: 'Start earning', n: '02' },
  { to: '/earn', label: 'Rewards', n: '03' },
  { to: '/agents', label: 'Agents', n: '04' },
  { to: '/chain', label: 'Chain', n: '05' },
  { to: '/sepia', label: 'Model', n: '06' },
  { to: '/docs', label: 'Docs', n: '07' },
]

/** Legal pages: status bar (desktop/tablet) and the menu drawer (mobile). */
export const LEGAL = [
  { to: '/privacy', label: 'Privacy', n: 'L1' },
  { to: '/terms', label: 'Terms', n: 'L2' },
]

const VERIFY_HINT = 'Sign one plain-text message to receive SOL payouts. It is not a transaction and costs nothing.'

/** Phones never inject a wallet into the system browser; the wallet app's own browser does. */
const isMobileUA = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
const MOBILE_NO_WALLET = 'No Solana wallet in this browser. Open LUSCA in the Phantom app to verify a wallet. Earning credits on this device needs no wallet.'

/** Install / open-in-wallet links shown with the no-wallet error. */
function NoWalletLinks({ className }: { className?: string }) {
  const mobile = isMobileUA()
  const openIn =
    typeof location !== 'undefined'
      ? `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`
      : null
  return (
    <span className={className}>
      {mobile && openIn && (
        <a href={openIn} rel="noopener noreferrer">
          Open in Phantom →
        </a>
      )}
      <a href="https://phantom.com/download" target="_blank" rel="noopener noreferrer">
        Get Phantom →
      </a>
    </span>
  )
}

/**
 * Top-bar wallet control: Connect wallet → Verify → Verified (short address), with disconnect.
 * Verification is one signed plain-text message and is only needed to receive SOL payouts.
 */
function BarWallet() {
  const { status, address, connecting, error, available, connect, verify, disconnect, clearError } = useWallet()
  const short = shortAddr(address)
  const noWallet = !available && error === NO_WALLET_MSG
  return (
    <div className="bar-wallet">
      {status === 'none' && (
        <button className="btn ghost bar-wallet-btn" onClick={() => void connect()} disabled={connecting}>
          {connecting ? 'CONNECTING…' : 'CONNECT WALLET'}
        </button>
      )}
      {status === 'connected' && (
        <button className="btn ghost bar-wallet-btn" onClick={() => void verify()} title={VERIFY_HINT}>
          VERIFY <span className="num dim">{short}</span>
        </button>
      )}
      {status === 'verifying' && (
        <button className="btn ghost bar-wallet-btn" disabled title="Approve the sign-in message in your wallet.">
          VERIFYING…
        </button>
      )}
      {status === 'verified' && (
        <span className="bar-wallet-ok" title={`Verified wallet ${address ?? ''}`}>
          <span className="led on" aria-hidden="true" /> VERIFIED <span className="num">{short}</span>
        </span>
      )}
      {status !== 'none' && (
        <button className="bar-wallet-x" onClick={() => void disconnect()} aria-label="Disconnect wallet" title="Disconnect wallet">
          ×
        </button>
      )}
      {error && (
        <div className="wallet-err" role="alert">
          <span>
            {noWallet && isMobileUA() ? MOBILE_NO_WALLET : error}
            {noWallet && <NoWalletLinks className="wallet-err-links" />}
          </span>
          <button className="wallet-err-x" onClick={clearError} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  )
}

/** Menu-drawer wallet items (mobile), same states as the top-bar control. */
function NavWallet() {
  const { status, address, connecting, error, available, connect, verify, disconnect, clearError } = useWallet()
  const short = shortAddr(address)
  const noWallet = !available && error === NO_WALLET_MSG
  const errText = noWallet && isMobileUA() ? MOBILE_NO_WALLET : error
  return (
    <>
      {status === 'none' && (
        <button className="nav-item" onClick={() => void connect()} disabled={connecting}>
          <span className="nav-n">W</span>
          {connecting ? 'connecting wallet…' : 'connect wallet'}
        </button>
      )}
      {status === 'connected' && (
        <button className="nav-item" onClick={() => void verify()} title={VERIFY_HINT}>
          <span className="nav-n">W</span>
          verify wallet {short}
        </button>
      )}
      {status === 'verifying' && (
        <button className="nav-item" disabled>
          <span className="nav-n">W</span>
          verifying… approve the message in your wallet
        </button>
      )}
      {status === 'verified' && (
        <span className="nav-item nav-static">
          <span className="nav-n">W</span>
          verified {short}
        </span>
      )}
      {status !== 'none' && (
        <button className="nav-item" onClick={() => void disconnect()}>
          <span className="nav-n">×</span>
          disconnect wallet
        </button>
      )}
      {error && (
        <button className="nav-item nav-err" onClick={clearError} role="alert" aria-label={`${errText} Dismiss.`}>
          <span className="nav-n">!</span>
          {errText}
        </button>
      )}
      {noWallet && <NoWalletLinks className="nav-err-links" />}
    </>
  )
}

function TopBar() {
  const [open, setOpen] = useState(false)
  const loc = useLocation()
  const conn = useConn()
  const pages = useLive((s) => s.stats.pages)
  const sonar = useSonar()
  useEffect(() => setOpen(false), [loc.pathname])

  return (
    <header className="topbar">
      <Link to="/" className="brand" aria-label="LUSCA home">
        <Logo size={22} live />
        <span className="wordmark">LUSCA</span>
      </Link>

      <nav className={`nav ${open ? 'open' : ''}`} aria-label="Primary">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="nav-n">{n.n}</span>
            {n.label}
          </NavLink>
        ))}
        <div className="nav-extra">
          <NavWallet />
          <button className="nav-item" onClick={sonar.toggle} aria-pressed={sonar.on}>
            <span className="nav-n">S</span>
            sonar {sonar.on ? 'on' : 'off'}
          </button>
          <div className="nav-legal">
            {LEGAL.map((l) => (
              <NavLink key={l.to} to={l.to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <span className="nav-n">{l.n}</span>
                {l.label}
              </NavLink>
            ))}
          </div>
        </div>
      </nav>

      <div className="bar-right">
        <ConnBadge className="conn" />
        <span className="bar-stat num">
          {fmtInt(conn === 'live' ? pages : null)} <span className="dim">PAGES</span>
        </span>
        <BarWallet />
        <Link to="/node" className="btn primary bar-cta">
          START EARNING
        </Link>
        <button className="burger" aria-label={open ? 'Close menu' : 'Menu'} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span />
          <span />
        </button>
      </div>
    </header>
  )
}

function StatusBar() {
  const stats = useLive((s) => s.stats)
  const model = useLive((s) => s.model)
  const arms = useLive((s) => s.sectors.length)
  const conn = useConn()
  const live = conn === 'live'
  const sonar = useSonar()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  // Every value below comes from the server; while it is unreachable each one reads "—".
  const v = (n: number) => (live ? n : null)
  return (
    <footer className="statusbar mono">
      <span className="sb-seg sb-brand">
        <span className={connLed(conn)} aria-hidden="true" /> lusca
      </span>
      {!live && (
        <span className="sb-seg sb-conn" role="status">
          {CONN_TEXT[conn]}
        </span>
      )}
      <span className="sb-seg">
        <b>{fmtInt(v(stats.agentsActive))}</b>/{fmtInt(v(stats.agentsTotal))} agents
      </span>
      {/* widest-first drop order keeps the legal links and the clock on screen:
          hide-lg ≤1300 · hide-md ≤1100 · hide-tab ≤720 · hide-sm ≤600 · hide-xs ≤400 */}
      <span className="sb-seg hide-lg">{fmtInt(live && arms > 0 ? arms : null)} arms</span>
      <span className="sb-seg" title="pages accepted into the corpus, lifetime">
        <b>{fmtInt(v(stats.pages))}</b> pages
      </span>
      <span className="sb-seg hide-sm hide-tab">
        <b>{fmtCompact(v(stats.tokens))}</b> tok
      </span>
      <span className="sb-seg hide-sm hide-lg">
        <b>{fmtInt(v(stats.domains))}</b> hosts
      </span>
      <span className="sb-seg hide-md">
        sepia <b>step {fmtInt(v(model.step))}</b> loss <b>{live && model.loss ? model.loss.toFixed(3) : '—'}</b>
      </span>
      <span className="sb-seg hide-md">
        <b>{fmtInt(v(stats.neurons))}</b> neurons · {live ? fmtGflops(stats.gflops) : '—'}
      </span>
      <span className="sb-fill" />
      <button className={`sb-seg sb-btn hide-tab ${sonar.on ? 'on' : ''}`} onClick={sonar.toggle} aria-pressed={sonar.on} title="Sonar: one audio cue per ingested page">
        sonar {sonar.on ? 'on' : 'off'}
      </button>
      <span className="sb-seg hide-sm hide-lg">{fmtCompact(v(stats.pagesPerMin), 0)} pg/min</span>
      <nav className="sb-legal hide-sm" aria-label="Legal">
        {LEGAL.map((l) => (
          <NavLink key={l.to} to={l.to} className={({ isActive }) => `sb-seg sb-link ${isActive ? 'on' : ''}`}>
            {l.label.toLowerCase()}
          </NavLink>
        ))}
      </nav>
      <span className="sb-seg">
        {fmtClock(now)}
        <span className="hide-xs">UTC</span>
      </span>
    </footer>
  )
}

export function Shell() {
  const loc = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
    // a link to a section (/sepia#sp-code): scroll to it once the (lazily loaded) page has rendered it
    const id = loc.hash ? decodeURIComponent(loc.hash.slice(1)) : ''
    if (!id) return
    let tries = 0
    let t: number | undefined
    const go = () => {
      const el = document.getElementById(id)
      if (el) el.scrollIntoView({ block: 'start' })
      else if (++tries < 60) t = window.setTimeout(go, 50)
    }
    go()
    return () => window.clearTimeout(t)
  }, [loc.pathname, loc.hash])
  return (
    <div className="shell">
      <TopBar />
      <main className="shell-main">
        {/* reset on navigation so a crashed view never blocks the rest of the site */}
        <ErrorBoundary variant="page" resetKey={loc.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <StatusBar />
      <div className="grain" aria-hidden="true" />
      <Boot />
    </div>
  )
}
