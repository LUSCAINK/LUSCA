// Page kit — the pieces every content page shares so the site reads as one
// manual: the [NN] kicker, the "on this page" row, the plain-language terms
// strip and the "start earning" next step. Definitions live in ./glossary.
import type { MouseEvent, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { TERMS, type TermKey } from './glossary'
import './pagekit.css'

/** "[04] AGENTS" — mono, orange index. Optional right-hand content (a live badge). */
export function Kicker({ n, name, children, className }: { n: string; name: string; children?: ReactNode; className?: string }) {
  return (
    <div className={`pk-kick mono ${className ?? ''}`}>
      <span className="pk-kick-n">
        <span className="hot">[{n}]</span> {name}
      </span>
      {children}
    </div>
  )
}

const smooth = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches

function jumpTo(e: MouseEvent<HTMLAnchorElement>, id: string) {
  const el = document.getElementById(id)
  if (!el) return
  e.preventDefault()
  el.scrollIntoView({ behavior: smooth() ? 'smooth' : 'auto', block: 'start' })
}

/** Compact anchor row: 2–4 links to the page's own sections. */
export function OnThisPage({ links, className }: { links: { id: string; label: string }[]; className?: string }) {
  return (
    <nav className={`pk-otp ${className ?? ''}`} aria-label="On this page">
      <span className="pk-otp-l label">On this page</span>
      <ul>
        {links.map((l) => (
          <li key={l.id}>
            <a href={`#${l.id}`} onClick={(e) => jumpTo(e, l.id)}>
              {l.label}
              <span aria-hidden="true">↓</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** Plain definitions for the terms a page uses, shown once near its top. */
export function Terms({ keys, className }: { keys: TermKey[]; className?: string }) {
  return (
    <section className={`pk-terms ${className ?? ''}`} aria-label="Terms used on this page">
      <div className="pk-terms-h">
        <span className="label">Terms on this page</span>
        <Link to="/docs/faq" className="pk-terms-all mono">
          full glossary →
        </Link>
      </div>
      <dl className="pk-terms-l" style={{ ['--pk-n' as string]: keys.length }}>
        {keys.map((k) => (
          <div className="pk-term" key={k}>
            <dt>{TERMS[k].term}</dt>
            <dd>{TERMS[k].def}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** The primary next step: plug a GPU in at /node. */
export function NextStep({
  title = 'Start earning',
  text = 'Plug your GPU in from this browser tab. No install, no account. A wallet is only needed to receive SOL payouts.',
  secondary,
  className,
}: {
  title?: string
  text?: ReactNode
  secondary?: { to: string; label: string }
  className?: string
}) {
  return (
    <section className={`pk-next ${className ?? ''}`} aria-label="Next step">
      <div className="pk-next-copy">
        <span className="label">Next step</span>
        <h2 className="display pk-next-h">{title}</h2>
        <p className="pk-next-p">{text}</p>
      </div>
      <ol className="pk-next-steps mono">
        <li>
          <span className="num hot">1</span>
          <span>Open Start earning and detect your GPU</span>
        </li>
        <li>
          <span className="num hot">2</span>
          <span>Run the 10-second benchmark — it sets your tier</span>
        </li>
        <li>
          <span className="num hot">3</span>
          <span>Start jobs — every checked job earns INK</span>
        </li>
      </ol>
      <div className="pk-next-act">
        <Link to="/node" className="btn primary lg">
          Start earning <span aria-hidden="true">→</span>
        </Link>
        {secondary && (
          <Link to={secondary.to} className="btn lg">
            {secondary.label}
          </Link>
        )}
      </div>
    </section>
  )
}
