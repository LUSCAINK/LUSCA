// /agents/:id — AGENT DOSSIER. Identity, live state, lifetime numbers, the full
// decision trace (REST history merged with the live stream) and every page kept.
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AgentInfo, PageRecord, Trace } from '@shared/protocol'
import { SECTORS } from '@shared/sectors'
import { Creature } from '@/components/creature/Creature'
import { Meter, Stat, StateDot, StatePill, stateTone } from '@/components/obs/parts'
import { Terms } from '@/components/docs/pagekit'
import { connLed } from '@/components/ui/conn'
import { useNow, useSampled } from '@/lib/hooks'
import { CONN_LABEL, CONN_TEXT, type RejectEvent } from '@/lib/store'
import { fmtInt, shortUrl } from '@/lib/format'
import { shortAddr } from '@/lib/wallet'
import { PagesSwallowed } from './PagesSwallowed'
import { StageClock, TasteHistory } from './Rhythm'
import { TraceTimeline } from './TraceTimeline'
import { LADDER, STAGE, TASTE_MIN, WORKING, acceptRate, byCode, cleanHost, readableTitle, traceKey } from './util'

const CAP_TRACES = 800
const CAP_PAGES = 200

type Hist = { id: number; status: 'ok' | 'error'; list: Trace[]; err?: string }
const NO_TRACES: Trace[] = []

interface Mem {
  traces: Map<string, { t: Trace; seq: number }>
  seq: number
  pages: Map<string, PageRecord>
  rejects: Map<string, RejectEvent>
}
const MEMS = new Map<number, Mem>()
const MEM_AGENTS = 12

/** Per-agent session memory, LRU-capped to the last few dossiers opened. */
function memFor(id: number): Mem {
  const hit = MEMS.get(id)
  if (hit) {
    MEMS.delete(id)
    MEMS.set(id, hit)
    return hit
  }
  const m: Mem = { traces: new Map(), seq: 0, pages: new Map(), rejects: new Map() }
  MEMS.set(id, m)
  if (MEMS.size > MEM_AGENTS) {
    const oldest = MEMS.keys().next().value
    if (oldest !== undefined) MEMS.delete(oldest)
  }
  return m
}

function Ladder({ agent }: { agent: AgentInfo }) {
  const now = useNow(100)
  const step = STAGE[agent.state]
  const inPipe = step <= 5
  const secs = Math.max(0, (now - agent.since) / 1000)
  const tone = stateTone(agent.state)
  return (
    <div className="dos-ladder" role="group" aria-label={`Pipeline state: ${agent.state}, ${secs.toFixed(0)} seconds`}>
      {LADDER.map((l, i) => {
        const done = inPipe && step > i
        const cur = inPipe && step === i
        return (
          <div key={l.key} className={`dl ${done ? 'done' : ''} ${cur ? 'cur' : ''}`} aria-current={cur ? 'step' : undefined}>
            <span className="dl-i num">{String(i + 1).padStart(2, '0')}</span>
            <span className="dl-l">{l.label}</span>
            <span className="dl-h">{cur ? `${secs.toFixed(1)}s` : l.hint}</span>
          </div>
        )
      })}
      <div className={`dl dl-t dl-t-${tone}`}>
        <span className="dl-i">in state</span>
        <span className="dl-v num">
          {secs < 100 ? secs.toFixed(1) : Math.round(secs)}
          <small>s</small>
        </span>
        <StatePill state={agent.state} />
      </div>
    </div>
  )
}

function Siblings({ agent, all }: { agent: AgentInfo; all: AgentInfo[] }) {
  const sec = SECTORS[agent.sector]
  const sibs = all.filter((a) => a.sector === agent.sector)
  return (
    <nav className="dos-sibs" aria-label={`Agents on arm ${sec.roman}`}>
      <span className="label dos-sibs-l">
        arm <span className="hot">{sec.roman}</span> · {sibs.length} agent{sibs.length === 1 ? '' : 's'}
      </span>
      <ul>
        {sibs.map((a) => (
          <li key={a.id}>
            <Link to={`/agents/${a.id}`} className={`dos-sib ${a.id === agent.id ? 'on' : ''}`} aria-current={a.id === agent.id ? 'page' : undefined}>
              <StateDot state={a.state} />
              <span className="num">{a.code}</span>
              <span>{a.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function NotFound({ id, agents }: { id: string; agents: AgentInfo[] }) {
  const total = agents.length
  const heads = SECTORS.map((s) => agents.find((a) => a.sector === s.id)).filter((a): a is AgentInfo => !!a)
  return (
    <div className="ag dos-missing">
      <div className="dos-missing-in grid-bg">
        <div className="ag-idx mono">
          <span className="hot">[04]</span> agent / {id || '?'}
        </div>
        <h1 className="display">No such agent</h1>
        <p className="mono dim">
          nothing with id “{id}” on any of the 8 arms ({total} agent{total === 1 ? '' : 's'} reporting). it may not exist, or it was retired.
        </p>
        <Link to="/agents" className="btn primary lg">
          ← all agents
        </Link>
        {heads.length > 0 && (
          <nav className="dos-sibs dos-missing-sibs" aria-label="One agent per arm">
            <span className="label dos-sibs-l">or open one agent per arm</span>
            <ul>
              {heads.map((a) => (
                <li key={a.id}>
                  <Link to={`/agents/${a.id}`} className="dos-sib">
                    <StateDot state={a.state} />
                    <span className="num">{a.code}</span>
                    <span>{a.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </div>
  )
}

export function Dossier({ idParam }: { idParam: string }) {
  const navigate = useNavigate()
  const id = /^\d{1,6}$/.test(idParam) ? Number(idParam) : NaN
  const agents = useSampled((s) => s.agents, 150)
  const conn = useSampled((s) => s.conn, 400)
  const traceMap = useSampled((s) => s.agentTraces, 200)
  const pagesAll = useSampled((s) => s.pages, 400)
  const rejectsAll = useSampled((s) => s.rejects, 500)

  const ordered = useMemo(() => agents.slice().sort(byCode), [agents])
  const idx = ordered.findIndex((a) => a.id === id)
  const agent = idx >= 0 ? ordered[idx] : null
  const prev = idx >= 0 && ordered.length > 1 ? ordered[(idx - 1 + ordered.length) % ordered.length] : null
  const next = idx >= 0 && ordered.length > 1 ? ordered[(idx + 1) % ordered.length] : null

  const pageTitle = agent ? `${agent.code} ${agent.name} — LUSCA` : 'Agent — LUSCA'
  useEffect(() => {
    document.title = pageTitle
  }, [pageTitle])

  // ← / → walk the arms
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.key === 'ArrowLeft' && prev) navigate(`/agents/${prev.id}`)
      else if (e.key === 'ArrowRight' && next) navigate(`/agents/${next.id}`)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [prev, next, navigate])

  // full history from the server (live only). Results are keyed by agent id;
  // "loading" / "idle" are derived, so the effect only ever reports outcomes.
  const [hist, setHist] = useState<Hist | null>(null)
  useEffect(() => {
    if (conn !== 'live' || !Number.isFinite(id)) return
    const ctl = new AbortController()
    fetch(`/api/agents/${id}/traces`, { signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const body: unknown = await r.json()
        if (!Array.isArray(body)) throw new Error('unexpected payload')
        const list = (body as Trace[]).filter((t) => t && typeof t.ts === 'number' && typeof t.step === 'string' && typeof t.msg === 'string')
        setHist({ id, status: 'ok', list })
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return
        setHist({ id, status: 'error', list: [], err: e instanceof Error ? e.message : 'failed' })
      })
    return () => ctl.abort()
  }, [id, conn])
  const histMine = hist && hist.id === id ? hist : null
  const histStatus: 'idle' | 'loading' | 'ok' | 'error' = conn !== 'live' && !histMine ? 'idle' : histMine ? histMine.status : 'loading'
  const histList = histMine ? histMine.list : NO_TRACES

  // Session memory (module-level, per agent — see memFor): every step / page /
  // reject seen since this tab opened, so the timeline only grows although the
  // live store is capped.
  const liveTraces = Number.isFinite(id) ? traceMap[id] : undefined

  const traces = useMemo(() => {
    const m = memFor(id)
    const add = (list: Trace[]) => {
      // lists arrive newest-first; walk oldest-first so seq follows time
      for (let i = list.length - 1; i >= 0; i--) {
        const t = list[i]
        if (t.agentId !== id) continue
        const k = traceKey(t)
        if (!m.traces.has(k)) m.traces.set(k, { t, seq: m.seq++ })
      }
    }
    add(histList)
    if (liveTraces) add(liveTraces)
    let arr = [...m.traces.values()].sort((a, b) => a.t.ts - b.t.ts || a.seq - b.seq)
    if (arr.length > CAP_TRACES) {
      arr = arr.slice(arr.length - CAP_TRACES)
      m.traces = new Map(arr.map((x) => [traceKey(x.t), x]))
    }
    return arr.map((x) => x.t)
  }, [id, histList, liveTraces])

  const pages = useMemo(() => {
    const m = memFor(id)
    for (let i = pagesAll.length - 1; i >= 0; i--) {
      const p = pagesAll[i]
      if (p.agentId === id && !m.pages.has(p.id)) m.pages.set(p.id, p)
    }
    let arr = [...m.pages.values()].sort((a, b) => b.ts - a.ts)
    if (arr.length > CAP_PAGES) {
      arr = arr.slice(0, CAP_PAGES)
      m.pages = new Map(arr.map((p) => [p.id, p]))
    }
    return arr
  }, [id, pagesAll])

  const rejects = useMemo(() => {
    const m = memFor(id)
    for (const r of rejectsAll) if (r.agentId === id) m.rejects.set(`${r.ts}|${r.url}`, r)
    if (m.rejects.size > CAP_PAGES) m.rejects = new Map([...m.rejects].slice(-CAP_PAGES))
    return [...m.rejects.values()]
  }, [id, rejectsAll])

  const tastes = useMemo(() => {
    const s: number[] = []
    for (const t of traces) if (t.step === 'taste' && typeof t.data?.score === 'number') s.push(t.data.score)
    if (!s.length) for (let i = pages.length - 1; i >= 0; i--) s.push(pages[i].score)
    return s
  }, [traces, pages])

  if (!agent) {
    if (conn !== 'live' || agents.length === 0) {
      return (
        <div className="ag dos-wait">
          <span className="label caret">{conn === 'live' ? 'waiting for the agent list' : CONN_TEXT[conn]}</span>
        </div>
      )
    }
    return <NotFound id={idParam} agents={ordered} />
  }

  const sec = SECTORS[agent.sector]
  // lifetime counters, as the server reports them
  const kept = agent.pages
  const tokens = agent.tokens
  const dropped = agent.rejected
  const acc = acceptRate({ pages: kept, rejected: dropped })
  const lastTaste = agent.lastScore ?? (tastes.length ? tastes[tastes.length - 1] : null)
  const avgTaste = tastes.length ? tastes.reduce((a, b) => a + b, 0) / tastes.length : null
  const live = conn === 'live'
  const note =
    histStatus === 'loading'
      ? 'loading full history…'
      : histStatus === 'ok'
        ? `${traces.length} steps · server history (≤200) + live`
        : histStatus === 'error'
          ? `history unavailable (${histMine?.err ?? 'failed'}) · live steps only`
          : live
            ? `${traces.length} steps · live`
            : `${traces.length} steps seen this session · full history needs the live server`

  return (
    <div className="ag dos">
      <nav className="dos-nav" aria-label="Agent navigation">
        <Link to="/agents" className="dos-back">
          <span aria-hidden="true">←</span> all agents
        </Link>
        <span className="dos-crumb mono">
          agents / <b>{agent.code}</b>
        </span>
        <span className="dos-fill" />
        <span className="dos-keys mono" aria-hidden="true">
          ← → previous / next agent
        </span>
        {prev && (
          <Link to={`/agents/${prev.id}`} className="dos-step" rel="prev" aria-label={`Previous agent ${prev.code} ${prev.name}`}>
            <span aria-hidden="true">‹</span>
            <span className="num">{prev.code}</span>
            <span className="dos-step-n">{prev.name}</span>
          </Link>
        )}
        {next && (
          <Link to={`/agents/${next.id}`} className="dos-step" rel="next" aria-label={`Next agent ${next.code} ${next.name}`}>
            <span className="num">{next.code}</span>
            <span className="dos-step-n">{next.name}</span>
            <span aria-hidden="true">›</span>
          </Link>
        )}
      </nav>

      <section className="dos-top">
        <div className="dos-left">
        <div className="dos-viz brackets">
          <Creature variant="mini" selected={agent.id} />
          <div className="dos-hud mono">
            <span className={connLed(conn)} />
            {CONN_LABEL[conn]} · {agent.code} HIGHLIGHTED
          </div>
          <div className="dos-viz-foot mono">
            <span>
              ARM {sec.roman} · SLOT {String(agent.slot + 1).padStart(2, '0')}
            </span>
            <span>#{agent.id}</span>
          </div>
        </div>
        <div className="dos-legend">
          <div className="dos-lg">
            <span className="dlg">
              <i className="dlg-ring" /> this agent
            </span>
            <span className="dlg">
              <i className="dlg-sq" /> page kept
            </span>
            <span className="dlg">
              <i className="dlg-sq dlg-dim" /> frontier
            </span>
            <span className="dlg">
              <i className="dlg-line" /> scoring
            </span>
          </div>
          <dl className="dos-kv">
            <div className="kv">
              <dt>id</dt>
              <dd className="num">#{agent.id}</dd>
            </div>
            <div className="kv">
              <dt>arm · slot</dt>
              <dd className="num">
                {sec.roman} · {String(agent.slot + 1).padStart(2, '0')}
              </dd>
            </div>
            <div className="kv">
              <dt>origin</dt>
              <dd>{agent.origin === 'genesis' ? 'built-in' : 'spawned'}</dd>
            </div>
            <div className="kv">
              <dt>owner</dt>
              <dd className="num">{agent.owner ? (agent.owner.length > 14 ? shortAddr(agent.owner) : agent.owner) : agent.origin === 'genesis' ? 'network' : 'anon'}</dd>
            </div>
            <div className="kv">
              <dt>host</dt>
              <dd className="num">{cleanHost(agent.host)}</dd>
            </div>
          </dl>
        </div>
        </div>

        <div className="dos-main">
          <header className="dos-id">
            <div className="dos-id-k label">
              <span className="hot">[04]</span> agent · arm {sec.roman} {sec.name} ·{' '}
              {agent.origin === 'spawned' ? (
                <span className="hot">spawned by {agent.owner && agent.owner.length > 14 ? shortAddr(agent.owner) : (agent.owner ?? 'anon')}</span>
              ) : (
                'built-in'
              )}
            </div>
            <div className="dos-id-row">
              <h1 className="dos-code display">{agent.code}</h1>
              <div className="dos-id-side">
                <div className="dos-name">{agent.name}</div>
                <div className="dos-tags">
                  <span className="tag">
                    arm {sec.roman} · {sec.name}
                  </span>
                  <span className={`tag ${agent.origin === 'spawned' ? 'hot' : ''}`}>{agent.origin === 'genesis' ? 'built-in' : 'spawned'}</span>
                  <span className={`tag ${WORKING.has(agent.state) ? 'solid' : ''}`}>{WORKING.has(agent.state) ? 'working' : agent.state}</span>
                </div>
                <p className="dos-blurb">{sec.blurb}</p>
              </div>
            </div>
          </header>

          <Ladder agent={agent} />

          <div className="dos-now">
            <span className="label">reading now</span>
            {agent.url ? (
              <a className="dos-url mono" href={agent.url} target="_blank" rel="noreferrer noopener" title={agent.url}>
                {shortUrl(agent.url, 96)} <span aria-hidden="true">↗</span>
              </a>
            ) : (
              <span className="dos-url mono dim">— picking the next link —</span>
            )}
            <div className="dos-title">{agent.url || agent.host ? readableTitle(agent.title, agent.url, agent.host) : 'no page open'}</div>
            <div className="dos-taste">
              <span className="label">taste score</span>
              <span className={`num ${lastTaste !== null && lastTaste >= TASTE_MIN ? '' : 'dim'}`}>{lastTaste === null ? '—' : lastTaste.toFixed(2)}</span>
              <Meter value={lastTaste ?? 0} threshold={TASTE_MIN} segments={32} />
              <span className="label">kept at ≥ {TASTE_MIN}</span>
            </div>
          </div>

          <div className="dos-rhythm">
            <TasteHistory scores={tastes} />
            <StageClock key={agent.id} agentId={agent.id} />
          </div>

          <div className="dos-stats">
            <Stat label="pages kept" value={kept} />
            <Stat label="tokens" value={tokens} compact />
            <Stat label="dropped" value={dropped} />
            <Stat label="errors" value={agent.errors} />
            <Stat label="kept rate" value={acc === null ? null : acc * 100} suffix="%" sub={acc === null ? 'no pages judged yet' : `${kept + dropped} page${kept + dropped === 1 ? '' : 's'} judged`} />
            <div className="stat">
              <div className="label">avg taste score</div>
              <div className={`stat-v num ${avgTaste !== null && avgTaste < TASTE_MIN ? 'dim' : ''}`}>{avgTaste === null ? '—' : avgTaste.toFixed(2)}</div>
              <div className="stat-sub mono">{tastes.length ? `${tastes.length} pages scored` : 'nothing scored yet'}</div>
            </div>
          </div>
        </div>
      </section>

      <Terms keys={['agent', 'arm', 'taste']} />

      <Siblings agent={agent} all={ordered} />

      <section className="dos-bottom">
        <section className="panel dos-trace" aria-labelledby="dos-trace-h">
          <div className="panel-head">
            <span id="dos-trace-h">
              <span className="hot">C</span>&nbsp;&nbsp;<b>Decision trace</b>
            </span>
            <span className="dos-ph-meta">grouped by page · newest first</span>
          </div>
          <p className="dos-explain">
            Every step this agent took, in order: pick a link, download the page, read it, score it, skip it if it’s a copy, then keep or drop it.
          </p>
          <TraceTimeline traces={traces} pages={pages} rejects={rejects} note={note} nowUrl={agent.url} />
        </section>
        <div className="dos-side">
        <aside className="panel dos-pages" aria-labelledby="dos-pages-h">
          <div className="panel-head">
            <span id="dos-pages-h">
              <span className="hot">D</span>&nbsp;&nbsp;<b>Pages kept</b>
            </span>
            <span className="num">
              {pages.length} · {fmtInt(pages.reduce((n, p) => n + p.tokens, 0))} tok
            </span>
          </div>
          <PagesSwallowed pages={pages} name={agent.name} />
        </aside>
        </div>
      </section>
    </div>
  )
}
