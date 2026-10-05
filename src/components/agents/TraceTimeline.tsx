// Full decision trace of one agent, grouped per page visit. A visit starts at
// every `seek`; politeness pauses between visits get their own quiet group.
import { useMemo, useState } from 'react'
import type { AgentState, PageRecord, Trace } from '@shared/protocol'
import type { RejectEvent } from '@/lib/store'
import { StatePill, stateTone } from '@/components/obs/parts'
import { fmtClock, fmtClockMs, fmtInt, shortUrl } from '@/lib/format'
import { TASTE_MIN, cleanHost, readableTitle } from './util'

type Outcome = 'store' | 'reject' | 'error' | 'pause' | 'open'
type Filter = 'all' | 'kept' | 'dropped'

interface Visit {
  n: number
  steps: Trace[]          // chronological
  outcome: Outcome
  url: string | null
  host: string | null
  score: number | null
  tokens: number | null
  partial: boolean        // first group of the window — its seek may be out of range
  page: PageRecord | null
}

const TERMINAL: ReadonlySet<AgentState> = new Set<AgentState>(['store', 'reject', 'error'])
const QUIET: ReadonlySet<AgentState> = new Set<AgentState>(['sleep', 'idle'])

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Group chronological traces into visits. `traces` must be oldest → newest. */
function groupVisits(traces: Trace[], pages: PageRecord[], rejects: RejectEvent[] = []): Visit[] {
  const out: Visit[] = []
  let cur: Visit | null = null
  let closed = false
  for (const t of traces) {
    const quiet = QUIET.has(t.step)
    const startNew =
      !cur ||
      t.step === 'seek' ||
      (closed && !(cur.outcome === 'pause' && quiet)) ||
      (cur.outcome === 'pause' && !quiet)
    if (startNew) {
      cur = {
        n: out.length + 1,
        steps: [],
        outcome: quiet ? 'pause' : 'open',
        url: null,
        host: null,
        score: null,
        tokens: null,
        partial: out.length === 0 && t.step !== 'seek' && !quiet,
        page: null,
      }
      out.push(cur)
      closed = quiet
    }
    const v = cur as Visit
    v.steps.push(t)
    const d = t.data
    if (d) {
      v.url ??= str(d.url)
      v.host ??= str(d.host)
      if (t.step === 'taste') v.score = num(d.score) ?? v.score
      if (t.step === 'store') v.tokens = num(d.tokens) ?? v.tokens
      if (t.step === 'reject' && v.score === null) v.score = num(d.score)
    }
    if (TERMINAL.has(t.step)) {
      if (v.outcome !== 'pause') v.outcome = t.step as Outcome
      closed = true
    }
  }
  // tie a dropped visit to its reject event (url / host / score)
  for (const v of out) {
    if (v.outcome !== 'reject' || v.url) continue
    const st = v.steps[v.steps.length - 1]
    const r = rejects.find((x) => Math.abs(x.ts - st.ts) < 2500)
    if (r) {
      v.url = r.url
      v.host ??= r.host
      v.score ??= r.score
    }
  }
  // tie a stored visit to the page record it produced (title, url, score)
  for (const v of out) {
    if (v.outcome !== 'store') continue
    const st = v.steps[v.steps.length - 1]
    const id = str(st.data?.id)
    const p = (id && pages.find((x) => x.id === id)) || pages.find((x) => Math.abs(x.ts - st.ts) < 2500) || null
    if (p) {
      v.page = p
      v.url ??= p.url
      v.host ??= p.host
      v.score ??= p.score
      v.tokens ??= p.tokens
    }
  }
  return out
}

function fmtVal(k: string, v: string | number | boolean | null): string {
  if (v === null) return '—'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return k === 'ms' || Math.abs(v) >= 10000 ? fmtInt(v) : String(v)
    return Math.abs(v) < 10 ? v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : v.toFixed(1)
  }
  if (k === 'url' || k === 'dupOf' || /^https?:\/\//.test(v)) return shortUrl(v, 48)
  return v.length > 56 ? v.slice(0, 55) + '…' : v
}

function Chips({ data }: { data: Trace['data'] }) {
  if (!data) return null
  const entries = Object.entries(data).slice(0, 10)
  if (!entries.length) return null
  return (
    <span className="tl-chips">
      {entries.map(([k, v]) => (
        <span key={k} className="tl-chip" title={v === null ? undefined : String(v)}>
          <i>{k}</i>=<b>{fmtVal(k, v)}</b>
        </span>
      ))}
    </span>
  )
}

const OUT_LABEL: Record<Outcome, string> = { store: 'KEPT', reject: 'DROPPED', error: 'FAILED', pause: 'PAUSE', open: 'IN FLIGHT' }

function VisitBlock({ v, latest, nowUrl }: { v: Visit; latest: boolean; nowUrl: string | null }) {
  const t0 = v.steps[0].ts
  const t1 = v.steps[v.steps.length - 1].ts
  const live = latest && v.outcome === 'open'
  const url = v.url ?? (live ? nowUrl : null)
  const outcome: Outcome = v.outcome === 'open' && !latest ? 'open' : v.outcome
  const title = v.page ? readableTitle(v.page.title, v.page.url, v.page.host) : null
  const idleOnly = v.outcome === 'pause' && v.steps.every((s) => s.step === 'idle')
  return (
    <li className={`tl-v tl-${outcome} ${live ? 'tl-live' : ''}`}>
      <div className="tl-vh">
        <span className="tl-n num">{v.outcome === 'pause' ? '··' : String(v.n).padStart(2, '0')}</span>
        <div className="tl-vt">
          <div className="tl-vt-1">
            <span className={`tl-out tl-out-${outcome}`}>
              {live && <span className="led on pulse" />}
              {v.outcome === 'open' && !latest ? 'CUT OFF' : idleOnly ? 'IDLE' : OUT_LABEL[outcome]}
            </span>
            {v.outcome === 'pause' ? (
              <span className="tl-u dim">
                {idleOnly ? 'waiting for a frontier slot' : 'politeness backoff'} · {v.steps.length} step{v.steps.length === 1 ? '' : 's'}
              </span>
            ) : url ? (
              <a className="tl-u" href={url} target="_blank" rel="noreferrer noopener" title={url}>
                {shortUrl(url, 72)} <span aria-hidden="true">↗</span>
              </a>
            ) : (
              <span className="tl-u dim">{v.host ? cleanHost(v.host) : v.partial ? 'visit began before this window' : 'url not recorded'}</span>
            )}
          </div>
          {title && <div className="tl-vt-2">{title}</div>}
        </div>
        <div className="tl-vm num">
          {v.score !== null && <span className={v.score >= TASTE_MIN ? 'hot' : 'dim'}>{v.score.toFixed(2)}</span>}
          {v.tokens !== null && v.outcome === 'store' && <span>+{fmtInt(v.tokens)} tok</span>}
          <span className="dimmer">{((t1 - t0) / 1000).toFixed(1)}s</span>
          <span className="dimmer">{fmtClock(t0)}</span>
        </div>
      </div>
      <ol className="tl-steps">
        {v.steps.map((t, i) => (
          <li key={`${t.ts}-${t.step}-${i}`} className={`tl-s tone-${stateTone(t.step)}`}>
            <span className="tl-t num" title={fmtClockMs(t.ts) + ' UTC'}>
              {i === 0 ? fmtClockMs(t.ts).slice(3) : `+${((t.ts - t0) / 1000).toFixed(3)}`}
            </span>
            <span className="tl-node" aria-hidden="true" />
            <span className="tl-b">
              <StatePill state={t.step} />
            </span>
            <span className="tl-m">
              <span className="tl-msg">{t.msg}</span>
              <Chips data={t.data} />
            </span>
          </li>
        ))}
      </ol>
    </li>
  )
}

export function TraceTimeline({ traces, pages, rejects, note, nowUrl }: { traces: Trace[]; pages: PageRecord[]; rejects: RejectEvent[]; note: string; nowUrl: string | null }) {
  const [filter, setFilter] = useState<Filter>('all')
  const visits = useMemo(() => groupVisits(traces, pages, rejects), [traces, pages, rejects])
  const real = visits.filter((v) => v.outcome !== 'pause')
  const kept = real.filter((v) => v.outcome === 'store').length
  const dropped = real.filter((v) => v.outcome === 'reject' || v.outcome === 'error').length
  const shown = visits
    .filter((v) => (filter === 'all' ? true : filter === 'kept' ? v.outcome === 'store' : v.outcome === 'reject' || v.outcome === 'error'))
    .reverse()
  const latestN = visits.length ? visits[visits.length - 1].n : -1

  return (
    <div className="tl">
      <div className="tl-bar">
        <div className="ag-seg" role="group" aria-label="Filter visits">
          {(
            [
              ['all', `all ${real.length}`],
              ['kept', `kept ${kept}`],
              ['dropped', `dropped ${dropped}`],
            ] as [Filter, string][]
          ).map(([k, l]) => (
            <button key={k} type="button" className={filter === k ? 'on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
        <span className="tl-note mono">{note}</span>
      </div>
      {shown.length === 0 ? (
        <p className="tl-empty">
          <span className="label">{traces.length === 0 ? 'no steps yet' : 'nothing in this filter'}</span>
          <span className="dim">
            {traces.length === 0 ? 'Decisions appear here the moment this agent seeks, fetches, tastes or drops a page.' : 'Switch the filter back to all to see every visit.'}
          </span>
        </p>
      ) : (
        <ol className="tl-list">
          {shown.map((v) => (
            <VisitBlock key={`${v.steps[0].ts}-${v.steps[0].step}-${v.steps[0].msg}`} v={v} latest={v.n === latestN} nowUrl={nowUrl} />
          ))}
        </ol>
      )}
    </div>
  )
}
