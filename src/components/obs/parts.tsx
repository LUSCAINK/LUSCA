// Small brutalist building blocks shared by the observatory and other pages.
import type { ReactNode } from 'react'
import type { AgentState } from '@shared/protocol'
import { fmtInt, fmtCompact, hasNum } from '@/lib/format'

export const STATE_LABEL: Record<AgentState, string> = {
  idle: 'IDLE', seek: 'SEEK', fetch: 'FETCH', parse: 'PARSE', taste: 'TASTE', dedupe: 'DEDUPE',
  store: 'STORE', reject: 'REJECT', error: 'ERROR', sleep: 'SLEEP',
}

export function stateTone(s: AgentState): 'hot' | 'fg' | 'err' | 'dim' | 'mid' {
  if (s === 'fetch' || s === 'parse' || s === 'taste' || s === 'dedupe') return 'hot'
  if (s === 'store') return 'fg'
  if (s === 'reject' || s === 'error') return 'err'
  if (s === 'seek') return 'mid'
  return 'dim'
}

export function StateDot({ state }: { state: AgentState }) {
  return <span className={`sdot sdot-${stateTone(state)}`} aria-hidden="true" />
}

export function StatePill({ state }: { state: AgentState }) {
  return <span className={`spill spill-${stateTone(state)}`}>{STATE_LABEL[state]}</span>
}

/** Big tabular number, exactly as the server reported it. null → "—". */
export function Count({ value, compact = false, digits = 1 }: { value: number | null; compact?: boolean; digits?: number }) {
  return <span className="num">{compact ? fmtCompact(value, digits) : fmtInt(value)}</span>
}

export function Stat({ label, value, sub, compact, hot, suffix }: { label: string; value: number | null; sub?: ReactNode; compact?: boolean; hot?: boolean; suffix?: string }) {
  return (
    <div className={`stat ${hot ? 'stat-hot' : ''}`}>
      <div className="label">{label}</div>
      <div className="stat-v">
        <Count value={value} compact={compact} />
        {suffix && hasNum(value) && <span className="stat-suf">{suffix}</span>}
      </div>
      {sub !== undefined && <div className="stat-sub mono">{sub}</div>}
    </div>
  )
}

/** Horizontal meter with an optional threshold tick. */
export function Meter({ value, threshold, segments = 40 }: { value: number; threshold?: number; segments?: number }) {
  const lit = Math.round(Math.max(0, Math.min(1, value)) * segments)
  const th = threshold !== undefined ? Math.round(threshold * segments) : -1
  return (
    <div className="meter" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={1}>
      {Array.from({ length: segments }, (_, i) => (
        <span key={i} className={`mseg ${i < lit ? (value >= (threshold ?? 0) ? 'on' : 'low') : ''} ${i === th ? 'th' : ''}`} />
      ))}
    </div>
  )
}

/** Tiny sparkline from a numeric series. */
export function Spark({ data, w = 120, h = 28, stroke = 'var(--fg-1)' }: { data: number[]; w?: number; h?: number; stroke?: string }) {
  if (data.length < 2) return <svg width={w} height={h} />
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const pts = data.map((d, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 2 - ((d - min) / span) * (h - 4)).toFixed(1)}`)
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke={stroke} strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Highlight lexicon terms inside text. */
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>
  const esc = terms
    .filter((t) => t.length > 1)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
  if (!esc.length) return <>{text}</>
  const re = new RegExp(`(${esc.join('|')})`, 'gi')
  const parts = text.split(re)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="hl">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

export function SectionHead({ index, title, right }: { index: string; title: string; right?: ReactNode }) {
  return (
    <div className="panel-head">
      <span>
        <span className="hot">{index}</span>&nbsp;&nbsp;<b>{title}</b>
      </span>
      {right}
    </div>
  )
}
