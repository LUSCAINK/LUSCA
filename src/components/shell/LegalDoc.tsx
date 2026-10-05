// Layout shared by /privacy and /terms (styles: src/pages/legal.css, imported by
// both pages). Every page carries the plain-language / change-notice note.
import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { LEGAL } from './Shell'

export interface LegalSection {
  id: string
  title: string
  body: ReactNode
}

export interface LegalFact {
  k: string
  v: string
}

interface Props {
  doc: 'privacy' | 'terms'
  title: string
  kicker: string
  /** ISO date of the last edit, shown in the strip and the head. */
  revised: string
  facts: LegalFact[]
  sections: LegalSection[]
}

const pad = (i: number) => String(i).padStart(2, '0')

// Hash routing (static builds) owns location.hash, so in-page jumps scroll instead of navigating.
function jumpTo(id: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    const el = document.getElementById(id)
    if (!el) return
    e.preventDefault()
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    el.focus({ preventScroll: true })
  }
}

export function LegalDoc({ doc, title, kicker, revised, facts, sections }: Props) {
  useEffect(() => {
    document.title = `${title} — LUSCA`
  }, [title])

  const me = LEGAL.find((l) => l.to === `/${doc}`)
  const other = LEGAL.find((l) => l.to !== `/${doc}`)

  return (
    <article className="legal" aria-labelledby="lg-title">
      <header className="lg-strip mono">
        <span className="lg-strip-l">
          <span className="tag hot">{doc}</span>
          <span className="lg-strip-t">plain-language terms</span>
        </span>
        <span className="lg-strip-r">
          lusca/legal/{doc} · rev {revised}
        </span>
      </header>

      <div className="lg-head grid-bg">
        <div className="lg-head-main">
          <span className="label">
            <span className="hot">{me?.n}</span>&nbsp;&nbsp;/ legal
          </span>
          <h1 id="lg-title" className="display lg-title">
            {title}
          </h1>
          <p className="lg-kicker mono">{kicker}</p>
        </div>
        <nav className="lg-switch mono" aria-label="Legal documents">
          {LEGAL.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => `lg-switch-i ${isActive ? 'on' : ''}`}>
              <span className="lg-switch-n">{l.n}</span>
              {l.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <dl className="lg-facts" style={{ '--lg-n': facts.length } as CSSProperties}>
        {facts.map((f) => (
          <div key={f.k} className="lg-fact">
            <dt className="label">{f.k}</dt>
            <dd className="lg-fact-v num">{f.v}</dd>
          </div>
        ))}
      </dl>

      <aside className="lg-draft hatch" role="note">
        <p>
          <b>Plain-language document.</b> It describes how LUSCA works today. Payout parameters (schedule, pool size, caps, minimums) may
          change; changes are announced on the <Link to="/earn">Rewards</Link> page before they apply. The revision date above shows the latest
          version of this page.
        </p>
      </aside>

      <div className="lg-body">
        <nav className="lg-toc" aria-label="On this page">
          <span className="label">on this page</span>
          <ol className="lg-toc-list">
            {sections.map((s, i) => (
              <li key={s.id}>
                <a href={`#${s.id}`} onClick={jumpTo(s.id)} className="lg-toc-a">
                  <span className="lg-toc-n mono">{pad(i + 1)}</span>
                  <span>{s.title}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="lg-col">
          {sections.map((s, i) => (
            <section key={s.id} id={s.id} className="lg-sec" aria-labelledby={`${s.id}-h`} tabIndex={-1}>
              <div className="lg-sec-head">
                <span className="lg-sec-n mono">{pad(i + 1)} /</span>
                <h2 id={`${s.id}-h`} className="lg-sec-title">
                  {s.title}
                </h2>
              </div>
              <div className="lg-prose">{s.body}</div>
            </section>
          ))}

          <footer className="lg-foot mono">
            {other && (
              <Link to={other.to} className="lg-foot-a">
                <span className="dim">{other.n}</span> {other.label.toLowerCase()} <span aria-hidden="true">→</span>
              </Link>
            )}
            <Link to="/docs/ethics" className="lg-foot-a">
              <span className="dim">docs</span> data ethics <span aria-hidden="true">→</span>
            </Link>
            <span className="lg-foot-rev dim">rev {revised}</span>
          </footer>
        </div>
      </div>
    </article>
  )
}

// The operator's contact comes from the server (GET /api/bot, env LUSCA_BOT_CONTACT): the
// same address LuscaBot sends in its user-agent, so one setting covers both. Servers without a
// contact show a neutral line; no address is ever invented here.
let botContact: Promise<string | null> | null = null

function loadBotContact(): Promise<string | null> {
  botContact ??= fetch('/api/bot', { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? (r.json() as Promise<{ contact?: unknown }>) : null))
    .then((j) => (j && typeof j.contact === 'string' && j.contact.trim() ? j.contact.trim().slice(0, 160) : null))
    .catch(() => {
      botContact = null // transient failure: the next mount asks again
      return null
    })
  return botContact
}

/** mailto: for an e-mail address, the URL itself for http(s); anything else is shown as text. */
function contactHref(c: string): string | null {
  if (/^https?:\/\/\S+$/i.test(c)) return c
  const mail = c.replace(/^mailto:/i, '')
  return /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(mail) ? `mailto:${mail}` : null
}

/** The one contact line both pages share (a neutral line until the operator configures a contact). */
export function LegalContact() {
  const [contact, setContact] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void loadBotContact().then((c) => {
      if (live) setContact(c)
    })
    return () => {
      live = false
    }
  }, [])
  const href = contact ? contactHref(contact) : null
  return (
    <p>
      {contact ? (
        <b>
          Contact: {href ? <a href={href} rel="noopener noreferrer">{contact.replace(/^mailto:/i, '')}</a> : contact}.
        </b>
      ) : (
        <b>Contact: not yet published by this server’s operator.</b>
      )}{' '}
      Use it for questions, for removal requests about your ledger entries, and for site owners who want pages taken out of the dataset.
    </p>
  )
}
