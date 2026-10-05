import { memo } from 'react'
import type { AgentInfo } from '@shared/protocol'
import { SECTORS } from '@shared/sectors'
import { useSampled } from '@/lib/hooks'
import { DASH, fmtInt } from '@/lib/format'
import { StateDot, STATE_LABEL, stateTone } from './parts'

const Row = memo(function Row({ a, selected, onSelect }: { a: AgentInfo; selected: boolean; onSelect: (id: number) => void }) {
  const tone = stateTone(a.state)
  return (
    <button className={`r-row ${selected ? 'sel' : ''} tone-${tone}`} onClick={() => onSelect(a.id)} title={a.url ?? undefined}>
      <StateDot state={a.state} />
      <span className="r-code num">{a.code}</span>
      <span className="r-name">{a.name}</span>
      <span className={`r-st r-st-${tone}`}>{STATE_LABEL[a.state]}</span>
      <span className="r-host">{a.host ? a.host.replace(/^www\./, '') : '—'}</span>
      <span className="r-pages num">{fmtInt(a.pages)}</span>
    </button>
  )
})

export function Roster({ selected, onSelect }: { selected: number | null; onSelect: (id: number) => void }) {
  const agents = useSampled((s) => s.agents, 150)
  const sectors = useSampled((s) => s.sectors, 1000)
  return (
    <div className="roster">
      {SECTORS.map((sec) => {
        const list = agents.filter((a) => a.sector === sec.id).sort((a, b) => a.slot - b.slot)
        const info = sectors.find((s) => s.id === sec.id)
        const busy = list.filter((a) => stateTone(a.state) === 'hot').length
        return (
          <section key={sec.id} className="r-arm">
            <header className="r-arm-head">
              <span className={`r-roman ${busy ? 'hot' : ''}`}>{sec.roman}</span>
              <span className="r-arm-name">{sec.name}</span>
              <span className="r-arm-meta num">
                {info ? fmtInt(info.pages) : DASH} <span className="dimmer">pg</span>
              </span>
              <span className="r-arm-bar" aria-hidden="true">
                {list.map((a) => (
                  <i key={a.id} className={`tone-${stateTone(a.state)}`} />
                ))}
              </span>
            </header>
            {list.map((a) => (
              <Row key={a.id} a={a} selected={a.id === selected} onSelect={onSelect} />
            ))}
          </section>
        )
      })}
    </div>
  )
}
