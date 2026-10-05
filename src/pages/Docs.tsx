// /docs and /docs/:section — the manual. One long page; every section is
// addressable. Sidebar links update the URL; scrolling only moves the highlight
// (navigating on scroll would trip the shell's scroll-to-top on every change).
import { useCallback, useEffect, useRef, useState, type ComponentType, type MouseEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { DOC_SECTIONS, isDocSlug, sectionId, type DocSectionMeta } from '@/components/docs/sections'
import { CopyButton } from '@/components/docs/ui'
import { Kicker } from '@/components/docs/pagekit'
import { Overview } from '@/components/docs/content/Overview'
import { Quickstart } from '@/components/docs/content/Quickstart'
import { Architecture } from '@/components/docs/content/Architecture'
import { Arms } from '@/components/docs/content/Arms'
import { Ethics } from '@/components/docs/content/Ethics'
import { Taste } from '@/components/docs/content/Taste'
import { Dedupe } from '@/components/docs/content/Dedupe'
import { Sepia } from '@/components/docs/content/Sepia'
import { Neurons } from '@/components/docs/content/Neurons'
import { Protocol } from '@/components/docs/content/Protocol'
import { Economics } from '@/components/docs/content/Economics'
import { Faq } from '@/components/docs/content/Faq'
import { useSampled } from '@/lib/hooks'
import { CONN_TEXT } from '@/lib/store'
import { fmtCompact, fmtInt } from '@/lib/format'
import './docs.css'

const BODIES: Record<string, ComponentType> = {
  overview: Overview,
  quickstart: Quickstart,
  architecture: Architecture,
  arms: Arms,
  ethics: Ethics,
  taste: Taste,
  dedupe: Dedupe,
  sepia: Sepia,
  neurons: Neurons,
  protocol: Protocol,
  economics: Economics,
  faq: Faq,
}

const MOBILE_Q = '(max-width: 960px)'
const LOCK_MS = 1200

interface Sub {
  id: string
  n: string
  t: string
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

function scrollToId(id: string, smooth: boolean): boolean {
  const el = document.getElementById(id)
  if (!el) return false
  el.scrollIntoView({ behavior: smooth && !reducedMotion() ? 'smooth' : 'auto', block: 'start' })
  return true
}

/**
 * Run fn after every effect of the current commit (including the shell's
 * scroll-to-top). rAF normally wins; the timeout covers background tabs, where
 * animation frames do not fire.
 */
function afterEffects(fn: () => void): () => void {
  let done = false
  const run = () => {
    if (done) return
    done = true
    cancelAnimationFrame(raf)
    window.clearTimeout(t)
    fn()
  }
  const raf = requestAnimationFrame(run)
  const t = window.setTimeout(run, 50)
  return () => {
    done = true
    cancelAnimationFrame(raf)
    window.clearTimeout(t)
  }
}

/* ─── pieces ─────────────────────────────────────────────── */

function ConnBadge() {
  const conn = useSampled((s) => s.conn, 1000)
  return (
    <span className="dconn">
      <span className={`led ${conn === 'live' ? 'on pulse' : ''}`} />
      {CONN_TEXT[conn]}
    </span>
  )
}

function Hero() {
  const stats = useSampled((s) => s.stats, 1000)
  const model = useSampled((s) => s.model, 1000)
  const live = useSampled((s) => s.conn, 1000) === 'live'
  const v = (s: string) => (live ? s : '—')
  return (
    <header className="docs-hero">
      <div className="dhero-top">
        <Kicker n="06" name="Docs" />
        <span className="dhero-rev mono">rev 2026-10-05</span>
      </div>
      <h1 className="display dhero-h">The manual</h1>
      <p className="dhero-p">How LUSCA works, end to end — with the exact thresholds and formulas quoted from the code.</p>
      <nav className="dnew" aria-label="New here? Start with these 3">
        <div className="dnew-h">
          <span className="label">New here?</span>
          <span className="dnew-t">Start with these 3</span>
        </div>
        <ol className="dnew-l">
          <li>
            <Link to="/docs/overview" className="dnew-c">
              <span className="dnew-n num">1</span>
              <span className="dnew-name">Overview</span>
              <span className="dnew-d">What LUSCA is, what runs today and what doesn’t yet.</span>
              <span className="dnew-go mono">read →</span>
            </Link>
          </li>
          <li>
            <Link to="/node" className="dnew-c dnew-hot">
              <span className="dnew-n num">2</span>
              <span className="dnew-name">Start earning</span>
              <span className="dnew-d">Plug your GPU in from a browser tab. No install, no account, no wallet needed to earn credits.</span>
              <span className="dnew-go mono">open →</span>
            </Link>
          </li>
          <li>
            <Link to="/earn" className="dnew-c">
              <span className="dnew-n num">3</span>
              <span className="dnew-name">Rewards</span>
              <span className="dnew-d">How credits are earned and paid out in SOL, the payout rules, the treasury and payout history.</span>
              <span className="dnew-go mono">open →</span>
            </Link>
          </li>
        </ol>
      </nav>
      <div className="dhero-tele mono">
        <ConnBadge />
        <span>
          pages <b>{v(fmtInt(stats.pages))}</b>
        </span>
        <span>
          tokens <b>{v(fmtCompact(stats.tokens))}</b>
        </span>
        <span>
          hosts <b>{v(fmtInt(stats.domains))}</b>
        </span>
        <span>
          agents <b>{live && stats.agentsTotal ? `${stats.agentsActive}/${stats.agentsTotal}` : '—'}</b>
        </span>
        <span>
          neurons <b>{v(fmtInt(stats.neurons))}</b>
        </span>
        <span>
          sepia step <b>{live && model.step ? fmtInt(model.step) : '—'}</b>
        </span>
      </div>
      <nav className="dtoc-grid" aria-label="Contents">
        {DOC_SECTIONS.map((s) => (
          <Link key={s.slug} to={`/docs/${s.slug}`} className="dtoc-cell">
            <span className="dtoc-n">{s.n}</span>
            <span className="dtoc-t display-cond">{s.title}</span>
            <span className="dtoc-k">{s.kicker}</span>
          </Link>
        ))}
      </nav>
    </header>
  )
}

function Section({ meta, children }: { meta: DocSectionMeta; children: ReactNode }) {
  const id = sectionId(meta.slug)
  return (
    <section id={id} className="dsec" aria-labelledby={`${id}-h`}>
      <header className="dsec-head">
        <div className="dsec-meta mono">
          <Link className="dsec-n" to={`/docs/${meta.slug}`} aria-label={`Section ${meta.n}, link`}>
            {meta.n} /
          </Link>
          <span className="dsec-k">{meta.kicker}</span>
          <CopyButton text={`${window.location.origin}/docs/${meta.slug}`} label="link" className="dsec-copy" />
        </div>
        <h2 id={`${id}-h`} className="display dsec-h">
          {meta.title}
        </h2>
      </header>
      <div className="dx">{children}</div>
    </section>
  )
}

function End() {
  return (
    <footer className="docs-end">
      <div className="label">end of manual</div>
      <p>
        Found a number here that disagrees with the code? The code wins. Every constant quoted on this page is collected in{' '}
        <code className="dc">src/components/docs/facts.ts</code> with the file it came from.
      </p>
      <div className="docs-end-links">
        <Link to="/node" className="btn primary">
          start earning <span aria-hidden="true">→</span>
        </Link>
        <Link to="/live" className="btn">
          watch it live
        </Link>
        <Link to="/sepia" className="btn ghost">
          try the model
        </Link>
      </div>
    </footer>
  )
}

/* ─── page ───────────────────────────────────────────────── */

export default function Docs() {
  const { section } = useParams<{ section?: string }>()
  const navigate = useNavigate()
  const { search } = useLocation()
  const [active, setActive] = useState<string>(isDocSlug(section) ? section : DOC_SECTIONS[0].slug)
  const [activeSub, setActiveSub] = useState<string | null>(null)
  const [subs, setSubs] = useState<Record<string, Sub[]>>({})
  const sideRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const pending = useRef<{ from: number } | null>(null)
  const lock = useRef<{ slug: string; until: number } | null>(null)
  const spy = useRef<() => void>(() => {})
  /** Target of the last programmatic jump; cleared as soon as the reader scrolls by hand. */
  const jump = useRef<string | null>(null)

  useEffect(() => {
    const meta = DOC_SECTIONS.find((s) => s.slug === active) ?? DOC_SECTIONS[0]
    document.title = `${meta.title} — LUSCA Docs`
  }, [active])

  // Build the on-this-page index from the rendered sub-headings (content is static).
  useEffect(() => {
    const m: Record<string, Sub[]> = {}
    for (const s of DOC_SECTIONS) {
      const el = document.getElementById(sectionId(s.slug))
      m[s.slug] = el
        ? [...el.querySelectorAll<HTMLElement>('h3[id]')].map((h) => ({
            id: h.id,
            n: h.dataset.n ?? '',
            t: h.querySelector('.dh3-t')?.textContent ?? h.textContent ?? '',
          }))
        : []
    }
    setSubs(m)
  }, [])

  // URL → scroll. Runs after the shell's scroll-to-top (rAF lands after all effects of the commit).
  useEffect(() => {
    if (section !== undefined && !isDocSlug(section)) {
      navigate({ pathname: '/docs', search }, { replace: true })
      return
    }
    const p = pending.current
    pending.current = null
    return afterEffects(() => {
      // Restore where the reader was so an in-page jump animates from there, not from the top.
      if (p) window.scrollTo(0, p.from)
      if (section) scrollToId(sectionId(section), !!p)
      else if (p) window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })
      // Scroll events are only dispatched while the page renders; sync the highlight explicitly.
      if (!p) spy.current()
    })
    // search is carried along only; it must not re-trigger the scroll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, navigate])

  // Deep link on first load: fonts can shift layout after the first scroll — re-align once
  // unless the reader has already started scrolling.
  useEffect(() => {
    if (!isDocSlug(section)) return
    const target = section
    let moved = false
    const mark = () => {
      moved = true
    }
    window.addEventListener('wheel', mark, { passive: true })
    window.addEventListener('touchstart', mark, { passive: true })
    window.addEventListener('keydown', mark)
    let alive = true
    void document.fonts?.ready.then(() => {
      if (alive && !moved)
        afterEffects(() => {
          scrollToId(sectionId(target), false)
          spy.current()
        })
    })
    const t = window.setTimeout(() => {
      alive = false
    }, 4000)
    return () => {
      alive = false
      window.clearTimeout(t)
      window.removeEventListener('wheel', mark)
      window.removeEventListener('touchstart', mark)
      window.removeEventListener('keydown', mark)
    }
    // first load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Scroll spy: highlight only, never navigate.
  useEffect(() => {
    let queued: (() => void) | null = null
    const mq = window.matchMedia(MOBILE_Q)
    const compute = () => {
      queued = null
      const lk = lock.current
      if (lk && performance.now() < lk.until) return
      lock.current = null
      const bar = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 48
      const side = sideRef.current?.getBoundingClientRect()
      const top = mq.matches && side ? Math.max(bar, side.bottom) : bar
      const line = top + Math.min(140, window.innerHeight * 0.2)
      let cur = DOC_SECTIONS[0].slug
      for (const s of DOC_SECTIONS) {
        const el = document.getElementById(sectionId(s.slug))
        if (el && el.getBoundingClientRect().top <= line) cur = s.slug
      }
      const doc = document.documentElement
      if (window.scrollY > 0 && window.scrollY + window.innerHeight >= doc.scrollHeight - 2) cur = DOC_SECTIONS[DOC_SECTIONS.length - 1].slug
      setActive(cur)
      let sub: string | null = null
      document
        .getElementById(sectionId(cur))
        ?.querySelectorAll<HTMLElement>('h3[id]')
        .forEach((h) => {
          if (h.getBoundingClientRect().top <= line) sub = h.id
        })
      setActiveSub(sub)
    }
    const onScroll = () => {
      if (!queued) queued = afterEffects(compute)
    }
    const unlock = () => {
      lock.current = null
      jump.current = null
    }
    spy.current = onScroll
    compute()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    window.addEventListener('wheel', unlock, { passive: true })
    window.addEventListener('touchstart', unlock, { passive: true })
    return () => {
      queued?.()
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('wheel', unlock)
      window.removeEventListener('touchstart', unlock)
    }
  }, [])

  // Keep the active item visible in the sidebar list / mobile strip.
  useEffect(() => {
    const list = listRef.current
    const item = list?.querySelector<HTMLElement>(`[data-slug="${active}"]`)
    if (!list || !item) return
    // Instant on purpose: smooth element scrolls stall in background tabs and get
    // interrupted by the next spy update; the strip only needs to be right.
    if (list.scrollWidth > list.clientWidth + 1) {
      list.scrollLeft = item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2
    }
    const nav = list.parentElement
    if (nav && nav.scrollHeight > nav.clientHeight + 1) {
      const top = item.offsetTop - nav.clientHeight / 2 + item.offsetHeight / 2
      if (item.offsetTop < nav.scrollTop || item.offsetTop + item.offsetHeight > nav.scrollTop + nav.clientHeight) nav.scrollTop = top
    }
  }, [active])

  /** Section navigation: update the URL (shareable) and scroll there. */
  const go = useCallback(
    (slug: string | null) => {
      const target = slug ?? DOC_SECTIONS[0].slug
      lock.current = { slug: target, until: performance.now() + LOCK_MS }
      setActive(target)
      setActiveSub(null)
      jump.current = target
      window.setTimeout(() => {
        // If the smooth scroll never landed (interrupted, or the tab was not rendering), finish it instantly.
        if (jump.current === target) {
          const el = slug ? document.getElementById(sectionId(slug)) : null
          const off = el ? el.getBoundingClientRect().top : window.scrollY
          if (Math.abs(off) > window.innerHeight * 0.5) {
            if (el) scrollToId(el.id, false)
            else window.scrollTo(0, 0)
          }
        }
        jump.current = null
        spy.current()
      }, LOCK_MS + 60)
      if ((slug ?? undefined) === section) {
        if (slug) scrollToId(sectionId(slug), true)
        else window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })
        return
      }
      pending.current = { from: window.scrollY }
      navigate({ pathname: slug ? `/docs/${slug}` : '/docs', search })
    },
    [navigate, section, search],
  )

  // Route every in-manual link (sidebar, contents grid, cross-references) through go().
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = (e.target as HTMLElement).closest('a')
    if (!a || (a.target && a.target !== '_self')) return
    const m = /^\/docs(?:\/([a-z-]+))?\/?$/.exec(a.getAttribute('href') ?? '')
    if (!m) return
    const slug = m[1] ?? null
    if (slug !== null && !isDocSlug(slug)) return
    e.preventDefault()
    go(slug)
  }

  const activeMeta = DOC_SECTIONS.find((s) => s.slug === active) ?? DOC_SECTIONS[0]
  const activeSubs = subs[active] ?? []

  return (
    <div className="docs" onClickCapture={onClickCapture}>
      <aside className="docs-side" ref={sideRef} aria-label="Manual sections">
        <div className="ds-head">
          <span className="label">lusca / docs</span>
          <span className="ds-title">The manual</span>
          <span className="ds-sub mono">12 sections</span>
        </div>
        <nav className="ds-nav">
          <ol className="dn-list" ref={listRef}>
            {DOC_SECTIONS.map((s) => {
              const on = s.slug === active
              return (
                <li key={s.slug}>
                  <Link
                    to={`/docs/${s.slug}`}
                    data-slug={s.slug}
                    className={`dn-item${on ? ' on' : ''}`}
                    aria-current={on ? 'location' : undefined}
                  >
                    <span className="dn-n">{s.n}</span>
                    <span className="dn-t">{s.title}</span>
                  </Link>
                </li>
              )
            })}
          </ol>
        </nav>
        <div className="ds-foot">
          <Link to="/node" className="ds-foot-hot">
            start earning →
          </Link>
          <Link to="/earn">rewards →</Link>
          <Link to="/live">live →</Link>
        </div>
      </aside>

      <article className="docs-main">
        <Hero />
        {DOC_SECTIONS.map((s) => {
          const Body = BODIES[s.slug]
          return (
            <Section key={s.slug} meta={s}>
              <Body />
            </Section>
          )
        })}
        <End />
      </article>

      <aside className="docs-toc" aria-label="On this page">
        <div className="label">on this page</div>
        <div className="dtoc-sec">
          <span className="num hot">{activeMeta.n}</span>
          <span className="dtoc-sec-t">{activeMeta.title}</span>
        </div>
        <ol className="dtoc-list">
          {activeSubs.map((h) => (
            <li key={h.id} className={`dtoc-item${h.id === activeSub ? ' on' : ''}`}>
              <button
                type="button"
                onClick={() => {
                  lock.current = null
                  scrollToId(h.id, true)
                }}
              >
                <span className="dtoc-in num">{h.n}</span>
                <span>{h.t}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="dtoc-foot">
          <button type="button" className="dtoc-top mono" onClick={() => window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })}>
            ↑ top
          </button>
          <CopyButton text={`${window.location.origin}/docs/${active}`} label="copy section link" />
        </div>
      </aside>
    </div>
  )
}
