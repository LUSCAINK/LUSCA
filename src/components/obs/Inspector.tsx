import { Link } from 'react-router-dom'
import type { AgentState } from '@shared/protocol'
import { SECTORS } from '@shared/sectors'
import { useConn, useNow, useSampled } from '@/lib/hooks'
import { CONN_TEXT } from '@/lib/store'
import { fmtAgo, fmtClock, fmtInt, pathOf, shortUrl } from '@/lib/format'
import { Highlight, Meter, StatePill } from './parts'

const LADDER: { key: AgentState; label: string; hint: string }[] = [
  { key: 'seek', label: 'SEEK', hint: 'pick next url' },
  { key: 'fetch', label: 'FETCH', hint: 'http get' },
  { key: 'parse', label: 'PARSE', hint: 'text + links' },
  { key: 'taste', label: 'TASTE', hint: 'relevance' },
  { key: 'dedupe', label: 'DEDUPE', hint: 'simhash' },
  { key: 'store', label: 'STORE', hint: 'tokenize' },
]

const ORDER: Record<string, number> = { seek: 0, fetch: 1, parse: 2, taste: 3, dedupe: 4, store: 5 }

export function Inspector({ agentId, follow, onRelease }: { agentId: number | null; follow: boolean; onRelease: () => void }) {
  const now = useNow(250)
  const agent = useSampled((s) => (agentId === null ? null : s.agents.find((a) => a.id === agentId) ?? null), 100)
  const traces = useSampled((s) => (agentId === null ? [] : s.agentTraces[agentId] ?? []), 150)
  const page = useSampled((s) => (agentId === null ? null : s.pages.find((p) => p.agentId === agentId) ?? null), 250)
  const disc = useSampled((s) => (agentId === null ? null : s.discovers.find((d) => d.agentId === agentId) ?? null), 250)
  const conn = useConn(400)

  if (!agent) {
    return (
      <div className="insp insp-empty">
        <div className="label">{conn === 'live' ? 'no agent selected' : 'no data'}</div>
        <p className="dim">
          {conn === 'live'
            ? 'Click any glowing agent on the creature, or a row in the arm roster, to see its decisions.'
            : CONN_TEXT[conn]}
        </p>
      </div>
    )
  }

  const step = ORDER[agent.state] ?? -1
  const failed = agent.state === 'reject' || agent.state === 'error'
  const sec = SECTORS[agent.sector]
  const accept = agent.pages + agent.rejected > 0 ? agent.pages / (agent.pages + agent.rejected) : null
  const score = agent.lastScore ?? page?.score ?? null

  return (
    <div className="insp">
      <div className="insp-id">
        <div className="insp-code display">{agent.code}</div>
        <div className="insp-meta">
          <div className="insp-name">{agent.name}</div>
          <div className="label">
            arm {sec.roman} · {sec.name} · {agent.origin === 'spawned' ? `spawned by ${agent.owner ?? 'anon'}` : 'genesis'}
          </div>
        </div>
        <div className="insp-mode">
          {follow ? (
            <span className="tag hot">FOLLOWING</span>
          ) : (
            <button className="tag" onClick={onRelease} title="Return to auto-follow">
              PINNED ✕
            </button>
          )}
        </div>
      </div>

      {/* state ladder */}
      <div className="ladder">
        {LADDER.map((l, i) => {
          const done = step > i
          const cur = step === i
          return (
            <div key={l.key} className={`lad ${done ? 'done' : ''} ${cur ? 'cur' : ''} ${failed && i === 3 ? 'fail' : ''}`}>
              <span className="lad-i num">{String(i + 1).padStart(2, '0')}</span>
              <span className="lad-l">{l.label}</span>
              <span className="lad-h">{cur ? `${((now - agent.since) / 1000).toFixed(1)}s` : l.hint}</span>
            </div>
          )
        })}
      </div>

      <div className="insp-now">
        <div className="insp-now-row">
          <StatePill state={agent.state} />
          <span className="mono insp-url" title={agent.url ?? ''}>
            {agent.url ? shortUrl(agent.url, 80) : '— choosing from the frontier —'}
          </span>
        </div>
        {agent.title && <div className="insp-title">{agent.title}</div>}
      </div>

      {/* taste */}
      <div className="insp-block">
        <div className="insp-bh">
          <span className="label">taste · crypto relevance</span>
          <span className="label">accept ≥ 0.35</span>
        </div>
        <div className="taste">
          <div className={`taste-v num ${score !== null && score >= 0.35 ? 'hot' : 'dim'}`}>{score === null ? '—' : score.toFixed(2)}</div>
          <div className="taste-m">
            <Meter value={score ?? 0} threshold={0.35} segments={36} />
            <div className="taste-terms">
              {(page?.terms ?? []).slice(0, 6).map((t, i) => (
                <span key={`${i}-${t}`} className="tag">
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* last swallowed page */}
      {page && (
        <div className="insp-block">
          <div className="insp-bh">
            <span className="label">last page kept · {fmtAgo(page.ts, now)} ago</span>
            <span className="label num">
              +{fmtInt(page.tokens)} tok
            </span>
          </div>
          <a className="insp-page" href={page.url} target="_blank" rel="noreferrer noopener">
            <div className="insp-page-t">{page.title}</div>
            <div className="insp-page-u mono">{shortUrl(page.url, 70)}</div>
            <p className="insp-page-x">
              <Highlight text={page.excerpt.slice(0, 300)} terms={page.terms} />…
            </p>
          </a>
        </div>
      )}

      {/* frontier picks */}
      {disc && disc.picks.length > 0 && (
        <div className="insp-block">
          <div className="insp-bh">
            <span className="label">links found → frontier</span>
            <span className="label num">+{disc.total} new</span>
          </div>
          <div className="picks">
            {disc.picks.slice(0, 5).map((p) => (
              <div key={p.url} className="pick" title={p.why}>
                <span className="pick-s num">{p.score.toFixed(2)}</span>
                <span className="pick-bar">
                  <i style={{ width: `${Math.round(p.score * 100)}%` }} />
                </span>
                <span className="pick-u mono">{pathOf(p.url, 46)}</span>
                <span className="pick-w">{p.why}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* trace */}
      <div className="insp-block insp-trace-wrap">
        <div className="insp-bh">
          <span className="label">decision trace</span>
          <Link to={`/agents/${agent.id}`} className="label insp-more">
            full history →
          </Link>
        </div>
        <ol className="trace">
          {traces.slice(0, 40).map((t) => (
            <li key={`${t.ts}-${t.step}-${t.msg.length}`} className={`tr tr-${t.step}`}>
              <span className="tr-t num">{fmtClock(t.ts)}</span>
              <span className="tr-s">{t.step}</span>
              <span className="tr-m">{t.msg}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="insp-foot">
        <div>
          <div className="label">pages</div>
          <div className="num">{fmtInt(agent.pages)}</div>
        </div>
        <div>
          <div className="label">tokens</div>
          <div className="num">{fmtInt(agent.tokens)}</div>
        </div>
        <div>
          <div className="label">rejected</div>
          <div className="num">{fmtInt(agent.rejected)}</div>
        </div>
        <div>
          <div className="label">accept</div>
          <div className="num">{accept === null ? '—' : `${(accept * 100).toFixed(0)}%`}</div>
        </div>
      </div>
    </div>
  )
}
