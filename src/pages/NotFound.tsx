import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Creature } from '@/components/creature/Creature'
import { useNow, useSampled } from '@/lib/hooks'
import { fmtAgo, fmtInt, shortUrl } from '@/lib/format'
import type { ConnState } from '@/lib/store'
import './notfound.css'

const SECRET = 'ink'
const WATCH_MS = 3600
// 400 is left unlabelled: the 404 marker sits on it
const DEPTH_TICKS = [0, 100, 200, 300, 500]

const FEED: Record<ConnState, string> = {
  live: 'live server',
  unreachable: 'Can’t reach the LUSCA server — reconnecting…',
  connecting: 'connecting',
}

/** Last three letters typed anywhere on the page; fires when they spell the secret. */
function useKeyBuffer(onSecret: () => void) {
  const [keys, setKeys] = useState('')
  const fire = useRef(onSecret)
  fire.current = onSecret

  useEffect(() => {
    let buf = ''
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      const k = e.key.toLowerCase()
      if (!/^[a-z]$/.test(k)) return
      buf = (buf + k).slice(-SECRET.length)
      setKeys(buf)
      if (buf === SECRET) {
        buf = ''
        fire.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return [keys, setKeys] as const
}

export default function NotFound() {
  const loc = useLocation()
  const path = `${loc.pathname}${loc.search}`
  const conn = useSampled((s) => s.conn, 500)
  const stats = useSampled((s) => s.stats, 800)
  const last = useSampled((s) => s.pages[0] ?? null, 1000)
  const now = useNow(1000)

  const [watch, setWatch] = useState(false)
  const timer = useRef(0)
  const [keys, setKeys] = useKeyBuffer(() => {
    setWatch(true)
    setKeys(SECRET)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setWatch(false)
      setKeys('')
    }, WATCH_MS)
  })

  useEffect(() => () => window.clearTimeout(timer.current), [])

  // the stage is centred between the top strip and the foot band, so track the band's height
  const root = useRef<HTMLElement>(null)
  const foot = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = foot.current
    const host = root.current
    if (!el || !host) return
    const ro = new ResizeObserver(() => host.style.setProperty('--nf-foot-h', `${Math.round(el.offsetHeight)}px`))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    document.title = 'Not found — LUSCA'
  }, [])

  const linked = conn === 'live'
  const cells = Array.from({ length: SECRET.length }, (_, i) => keys[i] ?? '')

  return (
    <section ref={root} className={`nf ${watch ? 'is-watching' : ''}`} aria-labelledby="nf-title">
      <div className="nf-bg" aria-hidden="true">
        <Creature variant="mini" />
        <div className="nf-veil" />
      </div>

      <header className="nf-top mono">
        <span className="nf-top-l">
          <span className="tag solid">ERR 404</span>
          <span className="nf-top-route">lusca/router · no route matched</span>
        </span>
        <span className="nf-top-r">
          <span className={`led ${conn === 'live' ? 'on' : 'white'}`} />
          <span>
            {linked ? (
              <>
                <b className="num">{stats.agentsActive}</b>/{stats.agentsTotal} arms searching · <b>0</b> contact
              </>
            ) : (
              conn === 'unreachable' ? 'server unreachable' : 'connecting…'
            )}
          </span>
        </span>
      </header>

      <div className="nf-stage">
        <i className="nf-cross nf-cross-h" aria-hidden="true" />
        <i className="nf-cross nf-cross-v" aria-hidden="true" />

        <h1 id="nf-title" className="display nf-code">
          <span className="sr-only">404 — page not found</span>
          <span aria-hidden="true">4</span>
          <span aria-hidden="true" className="nf-zero">
            0
          </span>
          <span aria-hidden="true">4</span>
        </h1>

        <div className="nf-reticle" aria-hidden="true">
          <i className="nf-rc nf-rc-tl" />
          <i className="nf-rc nf-rc-tr" />
          <i className="nf-rc nf-rc-bl" />
          <i className="nf-rc nf-rc-br" />
          <span className="nf-eyes mono">the creature is watching</span>
        </div>

        <div className="nf-depth mono" aria-hidden="true">
          <span className="nf-depth-k">depth / m</span>
          <div className="nf-depth-scale">
            {DEPTH_TICKS.map((d) => (
              <span key={d} className="nf-depth-t" style={{ top: `${(d / 500) * 100}%` }}>
                {String(d).padStart(3, '0')}
              </span>
            ))}
            <span className="nf-depth-mark" style={{ top: `${(404 / 500) * 100}%` }}>
              404 · below the frontier
            </span>
          </div>
        </div>

        <span className="nf-coord mono" aria-hidden="true">
          blue hole · andros · 24°27′N 77°57′W
        </span>
      </div>

      <footer ref={foot} className="nf-foot">
        <div className="nf-cell nf-say">
          <span className="label">
            <span className="hot">00</span>&nbsp;&nbsp;status
          </span>
          <p className="nf-line">no arm has reached here.</p>
          <p className="nf-sub">
            Nothing at this address was ever tasted, kept or linked. The arms only go where links lead, and none lead here.
          </p>
          <div className="nf-actions">
            <Link to="/" className="btn lg">
              <span>
                <span aria-hidden="true">←</span> Surface
              </span>
              <span className="nf-k">/</span>
            </Link>
            <Link to="/live" className="btn primary lg">
              <span>Watch the arms</span>
              <span className="nf-k">
                /live <span aria-hidden="true">→</span>
              </span>
            </Link>
          </div>
        </div>

        <div className="nf-cell nf-read">
          <span className="label">
            <span className="hot">01</span>&nbsp;&nbsp;readout
          </span>
          <p className="nf-req mono">
            <span className="dim">GET</span> <span className="nf-path">{path}</span> <span className="dim">→</span> <b>404</b>
            <span className="dim"> · </span>0 links<span className="dim"> · </span>not in frontier
          </p>
          <dl className="nf-kv">
            <div className="kv">
              <dt>frontier</dt>
              <dd className="num">{linked ? `${fmtInt(stats.frontier)} queued · no match` : '—'}</dd>
            </div>
            <div className="kv">
              <dt>hosts mapped</dt>
              <dd className="num">{linked ? fmtInt(stats.domains) : '—'}</dd>
            </div>
            <div className="kv">
              <dt>last swallowed</dt>
              <dd className="nf-last">
                {linked && last ? (
                  <>
                    <a href={last.url} target="_blank" rel="noreferrer noopener">
                      {shortUrl(last.url, 44)}
                    </a>
                    <span className="dim"> · {fmtAgo(last.ts, now)}</span>
                  </>
                ) : (
                  <span className="dim">{linked ? 'waiting for the first page' : '—'}</span>
                )}
              </dd>
            </div>
            <div className="kv">
              <dt>feed</dt>
              <dd>{FEED[conn]}</dd>
            </div>
          </dl>
        </div>

        <div className="nf-cell nf-keys">
          <span className="label">
            <span className="hot">02</span>&nbsp;&nbsp;keybuf
          </span>
          <div className="nf-buf mono" aria-hidden="true">
            {cells.map((c, i) => (
              <span key={i} className={`nf-buf-c ${c ? 'on' : ''}`}>
                {c || '·'}
              </span>
            ))}
          </div>
          <p className="nf-hint mono">it tastes keystrokes.</p>
        </div>
      </footer>

      <p className="sr-only" aria-live="polite">
        {watch ? 'the creature is watching' : ''}
      </p>
    </section>
  )
}
