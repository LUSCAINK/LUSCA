// Two small instruments for the dossier:
//  · TasteHistory — the last tastings as bars against the accept threshold
//  · StageClock   — where this agent's time goes, measured from every state
//    transition seen on the event bus since the dossier opened
import { useEffect, useState } from 'react'
import type { AgentState } from '@shared/protocol'
import { STATE_LABEL } from '@/components/obs/parts'
import { bus } from '@/lib/bus'
import { useLive } from '@/lib/store'
import { TASTE_MIN } from './util'

export function TasteHistory({ scores }: { scores: number[] }) {
  const last = scores.slice(-36)
  const avg = last.length ? last.reduce((a, b) => a + b, 0) / last.length : 0
  const pass = last.filter((s) => s >= TASTE_MIN).length
  return (
    <div className="rh">
      <div className="rh-h">
        <span className="label">recent taste scores</span>
        <span className="label num">{last.length ? `last ${last.length} · avg ${avg.toFixed(2)} · ${pass} ≥ ${TASTE_MIN}` : 'nothing scored yet'}</span>
      </div>
      <div className="tsh" role="img" aria-label={last.length ? `Last ${last.length} taste scores, average ${avg.toFixed(2)}, ${pass} above the ${TASTE_MIN} threshold` : 'No taste scores yet'}>
        <span className="tsh-line" style={{ bottom: `${TASTE_MIN * 100}%` }} aria-hidden="true">
          <i>{TASTE_MIN}</i>
        </span>
        {Array.from({ length: 36 }, (_, i) => {
          const s = last[i - (36 - last.length)]
          if (s === undefined) return <span key={i} className="tsh-b tsh-empty" />
          const latest = i === 35
          return <span key={i} className={`tsh-b ${latest ? 'tsh-now' : s >= TASTE_MIN ? 'tsh-ok' : 'tsh-low'}`} style={{ height: `${Math.max(3, s * 100)}%` }} title={s.toFixed(3)} />
        })}
      </div>
    </div>
  )
}

const CLOCK_ORDER: AgentState[] = ['seek', 'fetch', 'parse', 'taste', 'dedupe', 'store', 'reject', 'error', 'sleep', 'idle']

type Acc = Partial<Record<AgentState, { ms: number; n: number }>>

export function StageClock({ agentId }: { agentId: number }) {
  const [acc, setAcc] = useState<Acc>({})
  // keyed by agentId by the parent, so state starts fresh per agent
  useEffect(() => {
    const a0 = useLive.getState().agents.find((a) => a.id === agentId)
    let prev = a0 ? { state: a0.state, since: a0.since } : null
    return bus.on('agent', (m) => {
      if (m.agent.id !== agentId) return
      const cur = { state: m.agent.state, since: m.agent.since }
      if (prev && cur.since !== prev.since) {
        const d = cur.since - prev.since
        const st = prev.state
        if (d > 0 && d < 300_000) {
          setAcc((o) => {
            const e = o[st] ?? { ms: 0, n: 0 }
            return { ...o, [st]: { ms: e.ms + d, n: e.n + 1 } }
          })
        }
      }
      prev = cur
    })
  }, [agentId])

  const rows = CLOCK_ORDER.filter((s) => acc[s]).map((s) => ({ s, ...(acc[s] as { ms: number; n: number }) }))
  const total = rows.reduce((t, r) => t + r.ms, 0)
  return (
    <div className="rh">
      <div className="rh-h">
        <span className="label">stage clock</span>
        <span className="label num">{total ? `${(total / 1000).toFixed(1)}s observed` : 'measuring…'}</span>
      </div>
      <div className="sc-bar" role="img" aria-label={rows.map((r) => `${r.s} ${Math.round((r.ms / total) * 100)}%`).join(', ') || 'No transitions observed yet'}>
        {total === 0 ? (
          <span className="sc-seg sc-wait" style={{ flexGrow: 1 }} />
        ) : (
          rows.map((r) => <span key={r.s} className={`sc-seg sc-${r.s}`} style={{ flexGrow: r.ms }} title={`${r.s} ${((r.ms / total) * 100).toFixed(0)}%`} />)
        )}
      </div>
      <ul className="sc-legend">
        {rows.length === 0 ? (
          <li className="sc-li dim">every state change from now on is timed here</li>
        ) : (
          rows.slice(0, 8).map((r) => (
            <li key={r.s} className="sc-li">
              <i className={`sc-k sc-${r.s}`} aria-hidden="true" />
              <span className="sc-l">{STATE_LABEL[r.s]}</span>
              <span className="num">{(r.ms / r.n / 1000).toFixed(2)}s</span>
              <span className="num dimmer">{Math.round((r.ms / total) * 100)}%</span>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}
