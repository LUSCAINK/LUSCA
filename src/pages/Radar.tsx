// RADAR — /radar: on-chain code changes, caught as they land. Every card is one change the server
// caught (Solana loader logs over the Helius websocket, EVM proxy events from eth_getLogs) and then
// read: what LUSCA had before, what the chain holds now, and the difference. Facts only — a field
// that could not be read says so; nothing is inferred about intent.
//
// Data: GET /api/radar (first page + live counters, polled every 30 s), the WebSocket stream
// { t: 'radar', event } (a new id animates in at the top; a known id updates in place),
// GET /api/radar/:id when a card is opened (full lists, notes, the calls the radar made).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ChainId } from '@shared/chain'
import type { RadarEvent, RadarKind, RadarSide, RadarStatus } from '@shared/radar'
import { Kicker } from '@/components/docs/pagekit'
import { bus } from '@/lib/bus'
import { CHAINS, CHAIN_LABEL, CHAIN_SHORT, explorerName, explorerUrl, shortAddress } from '@/lib/chain'
import { DASH, fmtAgo, fmtInt } from '@/lib/format'
import { useConn, useMedia, useNow } from '@/lib/hooks'
import { KIND_BADGE, KIND_FILTER, VERIFIED_WORD, fetchRadar, fetchRadarEvent, matches, txUrl, type RadarQuery } from '@/lib/radar'
import './radar.css'

/** Position of /radar in the primary navigation (src/components/shell/Shell.tsx NAV). */
const RADAR_NAV_N = '08'
const PAGE = 40
const MAX_ITEMS = 400
const FRESH_MS = 2600

const p2 = (n: number) => String(n).padStart(2, '0')
function utc(ts: number): string {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`
}
const short = (a: string | null | undefined) => shortAddress(a, 4, 4)
const hash = (h: string | null | undefined) => (h ? `${h.slice(0, 10)}…${h.slice(-4)}` : null)

export default function Radar() {
  useEffect(() => {
    document.title = 'Radar — LUSCA'
  }, [])
  const conn = useConn()
  const reduced = useMedia('(prefers-reduced-motion: reduce)')
  const now = useNow(15_000)
  const [q, setQ] = useState<RadarQuery>({ chain: '', kind: '', known: false, sort: 'new' })
  const [items, setItems] = useState<RadarEvent[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [status, setStatus] = useState<RadarStatus | null>(null)
  const [load, setLoad] = useState<'loading' | 'ok' | 'error'>('loading')
  const [more, setMore] = useState(false)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const qRef = useRef(q)
  useEffect(() => {
    qRef.current = q
  }, [q])
  /** New filters: the list starts over (the effect below loads it). */
  const applyQ = (f: (x: RadarQuery) => RadarQuery) => {
    setQ(f)
    setLoad('loading')
    setItems([])
    setNext(null)
  }

  const merge = useCallback((list: RadarEvent[], markFresh: boolean) => {
    setItems((cur) => {
      const byId = new Map(cur.map((e) => [e.id, e]))
      const added: string[] = []
      for (const e of list) {
        if (!byId.has(e.id)) added.push(e.id)
        const old = byId.get(e.id)
        if (!old || e.updatedAt >= old.updatedAt) byId.set(e.id, e)
      }
      if (markFresh && added.length) {
        setFresh((f) => new Set([...f, ...added]))
        window.setTimeout(() => setFresh((f) => new Set([...f].filter((id) => !added.includes(id)))), FRESH_MS)
      }
      const bySignificance = qRef.current.sort === 'priority'
      return [...byId.values()].sort((a, b) => (bySignificance ? b.priority - a.priority : 0) || b.ts - a.ts || (a.id < b.id ? 1 : -1)).slice(0, MAX_ITEMS)
    })
  }, [])

  // first page for the filters, then a poll every 30 s (counters + anything the stream dropped)
  useEffect(() => {
    const ac = new AbortController()
    let timer = 0
    const run = async (first: boolean) => {
      try {
        const page = await fetchRadar({ ...q, limit: PAGE }, ac.signal)
        setStatus(page.status)
        if (first) {
          setItems(page.items)
          setNext(page.next)
        } else merge(page.items, true)
        setLoad('ok')
      } catch {
        if (!ac.signal.aborted) setLoad((s) => (s === 'ok' ? s : 'error'))
      }
      if (!ac.signal.aborted) timer = window.setTimeout(() => void run(false), 30_000)
    }
    void run(true)
    return () => {
      ac.abort()
      window.clearTimeout(timer)
    }
  }, [q, merge])

  useEffect(
    () =>
      bus.on('radar', (m) => {
        if (m.event && matches(m.event, qRef.current)) merge([m.event], true)
      }),
    [merge],
  )

  const loadMore = async () => {
    if (!next || more) return
    setMore(true)
    try {
      const page = await fetchRadar({ ...q, cursor: next, limit: PAGE })
      merge(page.items, false)
      setNext(page.next)
    } catch {
      /* the button stays; try again */
    } finally {
      setMore(false)
    }
  }

  const s24 = status?.last24h
  const counters: [string, number | undefined][] = [
    ['changes · 24 h', s24?.total],
    ['upgraded', s24?.byKind.upgrade],
    ['deployed', s24?.byKind.deploy],
    ['authority · admin · beacon', s24 ? (s24.byKind.authority_change ?? 0) + (s24.byKind.admin_change ?? 0) + (s24.byKind.beacon_upgrade ?? 0) : undefined],
  ]
  const live = conn === 'live' && load === 'ok'
  const blips = useMemo(() => items.slice(0, 24), [items])

  return (
    <div className={`rd ${reduced ? 'rd-still' : ''}`}>
      <header className="rd-hero">
        <div className="rd-hero-l">
          <Kicker n={RADAR_NAV_N} name="Radar" className="rd-kick">
            <span className="rd-live mono">
              <span className={live ? 'led on pulse' : 'led'} aria-hidden="true" />
              {live ? 'listening' : load === 'error' ? 'server unreachable' : 'connecting'}
            </span>
          </Kicker>
          <h1 className="rd-title display">
            Upgrade
            <br />
            radar
          </h1>
          <p className="rd-lede">
            On-chain code changes on Solana, Ethereum, Base and Arbitrum, caught as they land. For each one: what LUSCA had before, what the chain holds now, and the
            difference — code hash, authority, instructions or functions, admin-only functions with file and line, verified status.
          </p>
        </div>
        <Scope blips={blips} now={now} reduced={reduced} />
      </header>

      <section className="rd-strip" aria-label="Last 24 hours">
        <dl className="rd-counts">
          {counters.map(([k, v]) => (
            <div key={k}>
              <dt className="mono">{k}</dt>
              <dd className="num">{status ? fmtInt(v ?? 0) : DASH}</dd>
            </div>
          ))}
        </dl>
        <ul className="rd-sources mono" aria-label="How the radar listens">
          {CHAINS.map((c) => {
            const src = status?.sources[c]
            const n = s24?.byChain[c]
            return (
              <li key={c} className={src?.up ? 'up' : ''} title={src ? `${CHAIN_LABEL[c]}: ${src.via}${src.lastAt ? ` · last answer ${utc(src.lastAt)}` : ''}` : CHAIN_LABEL[c]}>
                <span className={src?.up ? 'led on' : 'led'} aria-hidden="true" />
                <b>{CHAIN_SHORT[c]}</b>
                <span className="rd-src-n num">{status ? fmtInt(n ?? 0) : DASH}</span>
                <span className={`rd-src-v ${src && /helius/i.test(src.via) ? 'hot' : ''}`}>{src ? `via ${src.via}` : DASH}</span>
              </li>
            )
          })}
        </ul>
      </section>

      <nav className="rd-filters mono" aria-label="Filters">
        <div className="rd-seg" role="group" aria-label="Chain">
          {(['', ...CHAINS] as (ChainId | '')[]).map((c) => (
            <button key={c || 'all'} className={q.chain === c ? 'on' : ''} aria-pressed={q.chain === c} onClick={() => applyQ((x) => ({ ...x, chain: c }))}>
              {c ? CHAIN_SHORT[c] : 'All chains'}
            </button>
          ))}
        </div>
        <div className="rd-seg" role="group" aria-label="Kind of change">
          {KIND_FILTER.map((k) => (
            <button key={k.k || 'all'} className={q.kind === k.k ? 'on' : ''} aria-pressed={q.kind === k.k} onClick={() => applyQ((x) => ({ ...x, kind: k.k as RadarKind | '' }))}>
              {k.label}
            </button>
          ))}
        </div>
        <div className="rd-seg" role="group" aria-label="Order">
          {(
            [
              ['new', 'Newest'],
              ['priority', 'Most significant'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={q.sort === k ? 'on' : ''} aria-pressed={q.sort === k} onClick={() => applyQ((x) => ({ ...x, sort: k }))}>
              {label}
            </button>
          ))}
        </div>
        <label className="rd-known-t">
          <input type="checkbox" checked={!!q.known} onChange={(e) => applyQ((x) => ({ ...x, known: e.target.checked }))} />
          <span>Known protocols only</span>
        </label>
      </nav>

      <section className="rd-feed-w" aria-label={q.sort === 'priority' ? 'Code changes, most significant first' : 'Code changes, newest first'}>
        {items.length === 0 ? (
          <p className="rd-empty mono">
            {load === 'error'
              ? 'Can’t reach the LUSCA server — retrying…'
              : load === 'loading'
                ? 'Loading…'
                : q.chain || q.kind || q.known
                  ? 'listening · nothing matches these filters yet'
                  : 'listening · no upgrades yet'}
          </p>
        ) : (
          <ol className="rd-feed">
            {items.map((e) => (
              <Card key={e.id} e={e} now={now} fresh={fresh.has(e.id) && !reduced} />
            ))}
          </ol>
        )}
        {next && (
          <button className="btn ghost rd-more" onClick={() => void loadMore()} disabled={more}>
            {more ? 'LOADING…' : 'OLDER CHANGES'}
          </button>
        )}
      </section>

      <footer className="rd-foot mono">
        <span>
          Facts read on-chain and from Sourcify / OtterSec. A change is described, not judged. Backfill:{' '}
          {status
            ? Object.entries(status.backfill)
                .map(([c, b]) => `${CHAIN_SHORT[c as ChainId] ?? c} ${b?.done ? `since ${b.fromTs ? utc(b.fromTs).slice(5, 16) : '—'}` : 'running'}`)
                .join(' · ') || 'none'
            : DASH}
        </span>
        <Link to="/scan" className="rd-foot-a">
          Watch reads live on /scan →
        </Link>
      </footer>
    </div>
  )
}

// ─── scope: the last changes as blips (angle from the address, distance from age) ─────────

function angleOf(a: string): number {
  let h = 2166136261
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a.charCodeAt(i), 16777619)
  return ((h >>> 0) % 3600) / 10
}

function Scope({ blips, now, reduced }: { blips: RadarEvent[]; now: number; reduced: boolean }) {
  const R = 100
  return (
    <div className="rd-scope" aria-hidden="true">
      <svg viewBox="-110 -110 220 220" className="rd-scope-svg">
        {[25, 50, 75, 100].map((r) => (
          <circle key={r} r={r} className="rd-ring" />
        ))}
        <line x1={-R} y1={0} x2={R} y2={0} className="rd-axis" />
        <line x1={0} y1={-R} x2={0} y2={R} className="rd-axis" />
        {Array.from({ length: 36 }, (_, i) => {
          const a = (i * 10 * Math.PI) / 180
          const r0 = i % 9 === 0 ? 92 : 96
          return <line key={i} x1={Math.cos(a) * r0} y1={Math.sin(a) * r0} x2={Math.cos(a) * R} y2={Math.sin(a) * R} className="rd-tick" />
        })}
        {!reduced && (
          <g className="rd-sweep">
            <path d={`M0 0 L${R} 0 A${R} ${R} 0 0 0 ${Math.cos(-0.6) * R} ${Math.sin(-0.6) * R} Z`} className="rd-sweep-fan" />
            <line x1={0} y1={0} x2={R} y2={0} className="rd-sweep-line" />
          </g>
        )}
        {blips.map((e) => {
          const age = Math.max(0, now - e.ts)
          const r = 12 + Math.min(1, Math.sqrt(age / 86_400_000)) * 84
          const a = (angleOf(`${e.chain}:${e.address}`) * Math.PI) / 180
          const hot = e.kind !== 'deploy'
          return <circle key={e.id} cx={Math.cos(a) * r} cy={Math.sin(a) * r} r={hot ? 2.6 : 1.6} className={hot ? 'rd-blip hot' : 'rd-blip'} />
        })}
        <circle r={2} className="rd-core" />
      </svg>
      <span className="rd-scope-l mono">
        last 24 h · centre = now
        <br />
        <span className="hot">■</span> upgrade / authority · <span className="dim">■</span> deploy
      </span>
    </div>
  )
}

// ─── one change ─────────────────────────────────────────────────────────────

function sideVal(s: RadarSide | null | undefined, f: (s: RadarSide) => string | null | undefined): string | null {
  if (!s) return null
  const v = f(s)
  return v ?? null
}

function Row({ k, before, after, same, addr, chain }: { k: string; before: string | null; after: string | null; same?: boolean; addr?: boolean; chain?: ChainId }) {
  if (before === null && after === null) return null
  const lensOf = (v: string | null) => (addr && chain && v && v !== 'none' ? <Link to={`/lens/${chain}/${v}`}>{short(v)}</Link> : v ?? '—')
  return (
    <div className={`rd-row ${same ? 'same' : before !== null && after !== null && before !== after ? 'chg' : ''}`}>
      <dt className="mono">{k}</dt>
      <dd className="mono">
        {before !== null && (
          <>
            <span className="b">{lensOf(before)}</span>
            <span className="arrow" aria-label="then">
              →
            </span>
          </>
        )}
        <span className="a">{after === null ? 'not read' : lensOf(after)}</span>
        {same && <span className="tagx">same</span>}
      </dd>
    </div>
  )
}

function Card({ e, now, fresh }: { e: RadarEvent; now: number; fresh: boolean }) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<RadarEvent | null>(null)
  const [err, setErr] = useState(false)
  const ev = full && full.updatedAt >= e.updatedAt ? full : e
  const sol = ev.chain === 'solana'
  const b = ev.before
  const a = ev.after
  const d = ev.diff
  const low = !ev.known && (ev.priority < 20 || ev.kind === 'deploy' || !!ev.proxies)
  const unit = d?.surface === 'functions' || !sol ? 'functions' : 'instructions'
  const tx = txUrl(ev.chain, ev.tx)
  const addrUrl = explorerUrl(ev.chain, ev.address)

  useEffect(() => {
    if (!open || (full && full.updatedAt >= e.updatedAt)) return
    const ac = new AbortController()
    fetchRadarEvent(e.id, ac.signal)
      .then((x) => {
        setFull(x)
        setErr(false)
      })
      .catch(() => !ac.signal.aborted && setErr(true))
    return () => ac.abort()
  }, [open, e.id, e.updatedAt, full])

  const authLabel = sol ? 'Upgrade authority' : 'Admin'
  const codeSame = d?.code === 'same'
  const listAdded = d?.added && d.added.items.length + d.added.more > 0 ? d.added : null
  const listRemoved = d?.removed && d.removed.items.length + d.removed.more > 0 ? d.removed : null
  const verifiedB = b && b.verified !== 'unknown' ? VERIFIED_WORD[b.verified] : null
  const verifiedA = a && a.from !== 'event' ? VERIFIED_WORD[a.verified] : null
  const actorWord = ev.actorRole === 'signer' ? 'signed by' : ev.actorRole === 'sender' ? 'sent by' : ev.actorRole === 'authority' ? 'authority' : ev.actorRole === 'admin' ? 'admin' : null

  return (
    <li className={`rd-card k-${ev.kind} ${fresh ? 'fresh' : ''} ${low ? 'low' : ''} ${ev.known ? 'known' : ''} ${ev.state === 'pending' ? 'pending' : ''}`}>
      {fresh && <span className="rd-card-sweep" aria-hidden="true" />}
      <div className="rd-card-h mono">
        <span className={`rd-badge ${ev.kind === 'deploy' || ev.proxies ? 'quiet' : ''}`}>{ev.proxies && ev.kind !== 'deploy' ? `${KIND_BADGE[ev.kind]} EVENT` : KIND_BADGE[ev.kind]}</span>
        <span className="rd-chip">{CHAIN_SHORT[ev.chain]}</span>
        {ev.known && (
          <span className="rd-chip known" title={ev.knownWhy ?? undefined}>
            KNOWN
          </span>
        )}
        {ev.proxies && ev.proxies.n > 1 ? <span className="rd-chip">{fmtInt(ev.proxies.n)} proxies</span> : ev.count > 1 && ev.kind !== 'deploy' ? <span className="rd-chip">{ev.count}× in a row</span> : null}
        {ev.backfill && <span className="rd-chip dim">backfill</span>}
        <time className="rd-time" dateTime={new Date(ev.ts).toISOString()} title={`caught ${utc(ev.seenAt)}`}>
          {fmtAgo(ev.ts, now)} <span className="dim">· {utc(ev.ts)}</span>
        </time>
      </div>

      <div className="rd-card-t">
        <h3 className={`rd-name ${ev.name ? '' : 'addr'}`}>{ev.name ?? short(ev.address)}</h3>
        <span className="rd-addr mono">{ev.proxies && ev.proxies.n > 1 ? `${fmtInt(ev.proxies.n)} proxies · first ${ev.address}` : ev.address}</span>
      </div>
      <p className="rd-headline mono">
        {ev.state === 'pending' && <span className="led on pulse" aria-hidden="true" />} {ev.headline}
      </p>

      {!low || open ? (
        <dl className="rd-rows">
          {(sol || ev.kind === 'upgrade') && (
            <Row k="Code hash" before={b ? hash(b.codeHash) ?? (b.from === 'event' ? null : 'unknown') : null} after={a && a.from !== 'event' ? hash(a.codeHash) ?? 'none' : null} same={codeSame} />
          )}
          {!sol && (ev.kind === 'upgrade' || ev.kind === 'deploy') && (
            <Row k="Implementation" before={b ? sideVal(b, (s) => (s.implementation === undefined ? undefined : (s.implementation ?? 'none'))) : null} after={sideVal(a, (s) => s.implementation)} addr chain={ev.chain} />
          )}
          {(ev.kind === 'beacon_upgrade' || a?.beacon) && <Row k="Beacon" before={sideVal(b, (s) => (s.beacon === undefined ? undefined : (s.beacon ?? 'none')))} after={sideVal(a, (s) => s.beacon)} addr chain={ev.chain} />}
          {(sol || ev.kind === 'admin_change' || a?.authority) && (
            <Row
              k={authLabel}
              before={b && (sol ? b.from !== 'event' : true) ? (b.authority ?? (b.from === 'event' && !sol ? 'none' : b.upgradeable === false ? 'none · immutable' : 'none')) : null}
              after={a && (a.from !== 'event' || !sol) ? (a.authority ?? (a.upgradeable === false ? 'none · immutable' : 'none')) : null}
              same={d?.authority === 'same'}
            />
          )}
          {(a?.surfaceCount != null || b?.surfaceCount != null) && (
            <Row k={sol ? 'IDL instructions' : 'ABI functions'} before={b && b.from !== 'event' ? (b.surfaceCount == null ? 'none' : fmtInt(b.surfaceCount)) : null} after={a ? (a.surfaceCount == null ? 'none' : fmtInt(a.surfaceCount)) : null} />
          )}
          {(verifiedA || verifiedB) && <Row k="Verified" before={verifiedB} after={verifiedA} same={d?.verified === 'same'} />}
          {sol && a?.primitives && a.primitives.length > 0 && <Row k="Primitives" before={b?.primitives ? b.primitives.join(' · ') || 'none' : null} after={a.primitives.join(' · ')} />}
        </dl>
      ) : null}

      {(listAdded || listRemoved) && (
        <div className="rd-lists">
          {listAdded && (
            <div className="rd-list add">
              <span className="mono k">
                + {fmtInt(listAdded.items.length + listAdded.more)} {unit} added
              </span>
              <span className="chips">
                {listAdded.items.map((x) => (
                  <code key={x}>{x}</code>
                ))}
                {listAdded.more > 0 && <code className="more">+{fmtInt(listAdded.more)}</code>}
              </span>
            </div>
          )}
          {listRemoved && (
            <div className="rd-list rem">
              <span className="mono k">
                − {fmtInt(listRemoved.items.length + listRemoved.more)} {unit} removed
              </span>
              <span className="chips">
                {listRemoved.items.map((x) => (
                  <code key={x}>{x}</code>
                ))}
                {listRemoved.more > 0 && <code className="more">+{fmtInt(listRemoved.more)}</code>}
              </span>
            </div>
          )}
        </div>
      )}
      {d?.guardsAdded && d.guardsAdded.length > 0 && (
        <div className="rd-guards">
          <span className="mono k">New admin-only functions</span>
          <ul>
            {d.guardsAdded.map((g) => (
              <li key={`${g.fn}|${g.guard}`} className="mono">
                <b>{g.fn}</b> <span className="dim">guarded by</span> {g.guard} <span className="at">{g.at}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {d?.primitivesAdded && d.primitivesAdded.length > 0 && (
        <p className="rd-prim mono">
          primitives added: <b>{d.primitivesAdded.join(' · ')}</b>
          {d.primitivesRemoved && d.primitivesRemoved.length > 0 && <> · removed: {d.primitivesRemoved.join(' · ')}</>}
        </p>
      )}

      <div className="rd-card-f mono">
        {ev.actor && actorWord && (
          <span className="rd-actor">
            {actorWord} <a href={explorerUrl(ev.chain, ev.actor) ?? undefined} target="_blank" rel="noopener noreferrer">{short(ev.actor)}</a>
          </span>
        )}
        <span className="rd-links">
          {tx && (
            <a href={tx} target="_blank" rel="noopener noreferrer">
              tx ↗
            </a>
          )}
          {addrUrl && (
            <a href={addrUrl} target="_blank" rel="noopener noreferrer">
              {explorerName(ev.chain)} ↗
            </a>
          )}
          <Link to={`/lens/${ev.chain}/${ev.address}`} className="hot">
            Lens →
          </Link>
          <button className="rd-open" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'less' : 'details'}
          </button>
        </span>
      </div>

      {open && (
        <div className="rd-detail mono">
          <p>
            <span className="dim">caught</span> {utc(ev.seenAt)} <span className="dim">via</span> {ev.via}
            {ev.slot != null && (
              <>
                {' '}
                · <span className="dim">slot</span> {fmtInt(ev.slot)}
              </>
            )}
            {ev.block != null && (
              <>
                {' '}
                · <span className="dim">block</span> {fmtInt(ev.block)}
              </>
            )}
          </p>
          {b && b.at && (
            <p>
              <span className="dim">before:</span> {b.from === 'radar' ? 'the radar’s earlier read' : b.from === 'chain-index' ? 'the chain agents’ kept read' : 'the event'} of {utc(b.at)}
            </p>
          )}
          {ev.proxies && ev.proxies.n > 1 && (
            <p>
              <span className="dim">proxies:</span> {ev.proxies.sample.map(short).join(' · ')}
              {ev.proxies.n > ev.proxies.sample.length ? ` · +${fmtInt(ev.proxies.n - ev.proxies.sample.length)}` : ''}
            </p>
          )}
          {ev.notes.map((n) => (
            <p key={n} className="note">
              {n}
            </p>
          ))}
          {ev.trace && ev.trace.length > 0 && (
            <ol className="rd-trace">
              {ev.trace.map((c, i) => (
                <li key={i} className={c.ok ? '' : 'fail'}>
                  <b>{c.method}</b> <span className="dim">{c.target}</span> <span>{c.provider}</span> <span className="num">{fmtInt(c.ms)} ms</span> <span className="dim">{c.result}</span>
                </li>
              ))}
            </ol>
          )}
          {err && <p className="note">Details could not be loaded.</p>}
        </div>
      )}
    </li>
  )
}
