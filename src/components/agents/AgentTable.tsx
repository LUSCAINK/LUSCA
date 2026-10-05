// Dense, sortable roster of every agent. Rows open the agent's dossier.
import { memo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AgentInfo } from '@shared/protocol'
import { SECTORS } from '@shared/sectors'
import { Meter, StateDot, StatePill } from '@/components/obs/parts'
import { useNow } from '@/lib/hooks'
import { fmtCompact, fmtInt } from '@/lib/format'
import { shortAddr } from '@/lib/wallet'
import { SORT_LABEL, type SortKey, type SortSpec } from './sort'
import { TASTE_MIN, acceptRate, cleanHost } from './util'

function Since({ ts }: { ts: number }) {
  const now = useNow(250)
  const s = Math.max(0, (now - ts) / 1000)
  return <span className="ag-since num">{s < 100 ? s.toFixed(1) : Math.round(s)}s</span>
}

const Row = memo(function Row({ a, score, fresh, onOpen }: { a: AgentInfo; score: number | null; fresh: boolean; onOpen: (id: number) => void }) {
  const sec = SECTORS[a.sector]
  const acc = acceptRate(a)
  return (
    <tr className={`ag-tr ${fresh ? 'ag-tr-new' : ''} ${a.origin === 'spawned' ? 'ag-tr-sp' : ''}`} onClick={() => onOpen(a.id)}>
      <td className="c-code">
        <StateDot state={a.state} />
        <Link to={`/agents/${a.id}`} className="ag-code num" onClick={(e) => e.stopPropagation()} aria-label={`${a.code} ${a.name} — open its full history`}>
          {a.code}
        </Link>
      </td>
      <td className="c-name">{a.name}</td>
      <td className="c-arm">
        <span className="ag-roman">{sec.roman}</span> {sec.name}
      </td>
      <td className="c-state">
        <StatePill state={a.state} />
        <Since ts={a.since} />
      </td>
      <td className="c-host" title={a.url ?? undefined}>
        {cleanHost(a.host)}
      </td>
      <td className="c-num c-pages num" data-k="kept">
        {fmtInt(a.pages)}
      </td>
      <td className="c-num c-tokens num" data-k="tok">
        {fmtCompact(a.tokens)}
      </td>
      <td className="c-num c-rej num" data-k="drop">
        {fmtInt(a.rejected)}
      </td>
      <td className="c-num c-acc num" data-k="kept %">
        {acc === null ? '—' : `${Math.round(acc * 100)}%`}
      </td>
      <td className="c-taste">
        <span className={`ag-score num ${score !== null && score >= TASTE_MIN ? '' : 'dimmer'}`}>{score === null ? '—' : score.toFixed(2)}</span>
        <Meter value={score ?? 0} threshold={TASTE_MIN} segments={12} />
      </td>
      <td className="c-origin">
        {a.origin === 'spawned' ? (
          <>
            <span className="tag hot">SPAWNED</span> <span className="ag-owner">{a.owner && a.owner.length > 14 ? shortAddr(a.owner) : (a.owner ?? 'anon')}</span>
          </>
        ) : (
          <span className="tag">BUILT-IN</span>
        )}
      </td>
    </tr>
  )
})

const COLS: { key: SortKey | null; label: string; cls: string; title?: string }[] = [
  { key: 'code', label: 'Code', cls: 'c-code' },
  { key: 'name', label: 'Name', cls: 'c-name' },
  { key: null, label: 'Arm', cls: 'c-arm' },
  { key: 'state', label: 'Doing now', cls: 'c-state', title: 'current step and seconds spent on it' },
  { key: 'host', label: 'Website', cls: 'c-host' },
  { key: 'pages', label: 'Kept', cls: 'c-num c-pages', title: 'pages kept for the dataset' },
  { key: 'tokens', label: 'Tokens', cls: 'c-num c-tokens', title: 'amount of text kept, in tokens' },
  { key: 'rejected', label: 'Dropped', cls: 'c-num c-rej', title: 'pages scored and dropped' },
  { key: 'accept', label: 'Kept %', cls: 'c-num c-acc', title: 'kept / (kept + dropped)' },
  { key: 'taste', label: 'Taste score', cls: 'c-taste', title: `relevance of the last page, 0–1 · kept at ≥ ${TASTE_MIN}` },
  { key: 'origin', label: 'Origin', cls: 'c-origin' },
]

export function AgentTable({ agents, scoreOf, sort, onSort, freshId, empty }: { agents: AgentInfo[]; scoreOf: (a: AgentInfo) => number | null; sort: SortSpec; onSort: (k: SortKey) => void; freshId: number | null; empty: string }) {
  const navigate = useNavigate()
  const open = (id: number) => navigate(`/agents/${id}`)
  return (
    <table className="ag-table">
      <caption className="sr-only">All agents, sorted by {SORT_LABEL[sort.key]} {sort.dir === 1 ? 'ascending' : 'descending'}</caption>
      <thead>
        <tr>
          {COLS.map((c) => {
            const on = c.key !== null && sort.key === c.key
            return (
              <th key={c.label} scope="col" className={c.cls} aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined} title={c.title}>
                {c.key ? (
                  <button type="button" className={`ag-th ${on ? 'on' : ''}`} onClick={() => onSort(c.key as SortKey)}>
                    {c.label}
                    <span className="ag-th-ar" aria-hidden="true">
                      {on ? (sort.dir === 1 ? '↑' : '↓') : '·'}
                    </span>
                  </button>
                ) : (
                  <span className="ag-th">{c.label}</span>
                )}
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody>
        {agents.map((a) => (
          <Row key={a.id} a={a} score={scoreOf(a)} fresh={a.id === freshId} onOpen={open} />
        ))}
        {agents.length === 0 && (
          <tr className="ag-tr-empty">
            <td colSpan={COLS.length}>
              <span className="label">{empty}</span>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
