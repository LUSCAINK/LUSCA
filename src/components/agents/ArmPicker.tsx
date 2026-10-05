// Radial 8-arm selector — the creature seen from above. Each wedge is an arm,
// each small square on it a live agent ("sucker"); the hollow square is where
// a newly spawned agent would grow. Keyboard: arrows / Home / End (ARIA radiogroup).
import { useRef, type KeyboardEvent } from 'react'
import type { AgentInfo } from '@shared/protocol'
import { SECTORS, agentCode } from '@shared/sectors'
import { stateTone } from '@/components/obs/parts'
import { byCode, nextSlot } from './util'

const R0 = 50
const R1 = 122
const R_DOT = 112
const R_ROMAN = 80
const R_TICK = 128
const R_LABEL = 144
const GAP = 2.5 // degrees trimmed off each side of a wedge

function pt(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180
  return [r * Math.cos(a), r * Math.sin(a)]
}

function f(n: number): string {
  return n.toFixed(2)
}

function wedgePath(i: number): string {
  const c = -90 + i * 45
  const s = c - 22.5 + GAP
  const e = c + 22.5 - GAP
  const [x1, y1] = pt(R1, s)
  const [x2, y2] = pt(R1, e)
  const [x3, y3] = pt(R0, e)
  const [x4, y4] = pt(R0, s)
  return `M${f(x1)} ${f(y1)}A${R1} ${R1} 0 0 1 ${f(x2)} ${f(y2)}L${f(x3)} ${f(y3)}A${R0} ${R0} 0 0 0 ${f(x4)} ${f(y4)}Z`
}

const TICKS = Array.from({ length: 72 }, (_, k) => {
  const deg = -90 + k * 5
  const major = k % 9 === 0
  const [x1, y1] = pt(R_TICK, deg)
  const [x2, y2] = pt(R_TICK + (major ? 7 : 3), deg)
  return { x1, y1, x2, y2, major, k }
})

export function ArmPicker({ value, onChange, agents, label, live = true }: { value: number; onChange: (sector: number) => void; agents: AgentInfo[]; label: string; live?: boolean }) {
  const refs = useRef<(SVGGElement | null)[]>([])

  const move = (to: number) => {
    const n = (to + 8) % 8
    onChange(n)
    refs.current[n]?.focus()
  }

  const onKey = (e: KeyboardEvent<SVGGElement>, i: number) => {
    let to: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = i + 1
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = i - 1
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = 7
    else if (e.key === ' ' || e.key === 'Enter') to = i
    if (to === null) return
    e.preventDefault()
    move(to)
  }

  const sel = SECTORS[value]
  const newCode = live ? agentCode(value, nextSlot(agents, value)) : '—'

  return (
    <div className="ap">
      <svg className="ap-svg" viewBox="-212 -162 424 324" role="radiogroup" aria-label={label}>
        {/* dial ticks */}
        <g className="ap-ticks" aria-hidden="true">
          {TICKS.map((t) => (
            <line key={t.k} x1={f(t.x1)} y1={f(t.y1)} x2={f(t.x2)} y2={f(t.y2)} className={t.major ? 'maj' : ''} />
          ))}
        </g>

        {SECTORS.map((s, i) => {
          const on = i === value
          const list = agents.filter((a) => a.sector === s.id).sort(byCode)
          const c = -90 + i * 45
          const [rx, ry] = pt(R_ROMAN, c)
          const [lx, ly] = pt(R_LABEL, c)
          const cos = Math.cos((c * Math.PI) / 180)
          const anchor = cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle'
          // sucker squares along the outer edge of the wedge (+1 ghost for the new one)
          const n = list.length + (on ? 1 : 0)
          const span = 45 - GAP * 2 - 9
          const step = n > 1 ? Math.min(5.6, span / (n - 1)) : 0
          const start = c - (step * (n - 1)) / 2
          return (
            <g
              key={s.id}
              ref={(el) => {
                refs.current[i] = el
              }}
              className={`wedge ${on ? 'on' : ''}`}
              role="radio"
              aria-checked={on}
              aria-label={live ? `Arm ${s.roman}, ${s.name}, ${list.length} agent${list.length === 1 ? '' : 's'}` : `Arm ${s.roman}, ${s.name}`}
              tabIndex={on ? 0 : -1}
              onClick={() => move(i)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <path className="w-path" d={wedgePath(i)} />
              <text className="w-roman" x={f(rx)} y={f(ry - 5)} textAnchor="middle" dominantBaseline="central">
                {s.roman}
              </text>
              <text className="w-count" x={f(rx)} y={f(ry + 10)} textAnchor="middle" dominantBaseline="central">
                {live ? String(list.length).padStart(2, '0') : '—'} AG
              </text>
              {Array.from({ length: n }, (_, k) => {
                const a = list[k]
                const deg = start + k * step
                const [dx, dy] = pt(R_DOT, deg)
                const ghost = !a
                const tone = a ? stateTone(a.state) : 'dim'
                return (
                  <rect
                    key={a ? a.id : 'ghost'}
                    className={`w-dot ${ghost ? 'ghost' : `t-${tone}`}`}
                    x={f(dx - 2.25)}
                    y={f(dy - 2.25)}
                    width="4.5"
                    height="4.5"
                    transform={`rotate(${f(deg + 90)} ${f(dx)} ${f(dy)})`}
                  />
                )
              })}
              <text className="w-name" x={f(lx)} y={f(ly)} textAnchor={anchor} dominantBaseline="central">
                {s.name.toUpperCase()}
              </text>
            </g>
          )
        })}

        {/* mantle: preview of the code the new agent will get */}
        <g className="ap-core" aria-hidden="true">
          <rect x={-R0 + 12} y={-R0 + 12} width={(R0 - 12) * 2} height={(R0 - 12) * 2} className="ap-core-box" />
          <text y="-15" textAnchor="middle" className="ap-core-l">
            NEW
          </text>
          <text y="3" textAnchor="middle" dominantBaseline="central" className="ap-core-code">
            {newCode}
          </text>
          <text y="20" textAnchor="middle" className="ap-core-l">
            {sel.key.toUpperCase()}
          </text>
        </g>
      </svg>
    </div>
  )
}
