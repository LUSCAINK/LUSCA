// /agents — every agent, live: who they are, what they are doing, and a form to add one.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { AgentInfo } from '@shared/protocol'
import { ROMAN, SECTORS } from '@shared/sectors'
import { Stat, stateTone } from '@/components/obs/parts'
import { Kicker, NextStep, OnThisPage, Terms } from '@/components/docs/pagekit'
import { ConnBadge, ConnNote } from '@/components/ui/conn'
import { useSampled } from '@/lib/hooks'
import { CONN_TEXT } from '@/lib/store'
import { DASH, fmtCompact, fmtInt } from '@/lib/format'
import { AgentTable } from './AgentTable'
import { DEFAULT_DIR, SORT_LABEL, sortAgents, type SortKey, type SortSpec } from './sort'
import { SpawnPanel } from './SpawnPanel'
import { WORKING, byCode } from './util'

type Origin = 'all' | 'genesis' | 'spawned'

const ORIGIN_LABEL: Record<Origin, string> = { all: 'all', genesis: 'built-in', spawned: 'spawned' }

function parseArm(v: string | null): number | null {
  if (v === null || v === '') return null
  const r = ROMAN.indexOf(v.toUpperCase())
  if (r >= 0) return r
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n < 8 ? n : null
}

function ArmCell({ sector, agents, pages, on, onPick, live }: { sector: number | null; agents: AgentInfo[]; pages: number | null; on: boolean; onPick: () => void; live: boolean }) {
  const sec = sector === null ? null : SECTORS[sector]
  const working = agents.filter((a) => WORKING.has(a.state)).length
  const list = sector === null ? agents : agents.slice().sort(byCode)
  return (
    <button type="button" className={`ag-arm ${on ? 'on' : ''} ${sector === null ? 'ag-arm-all' : ''}`} aria-pressed={on} onClick={onPick}>
      <span className="ag-arm-top">
        <span className="ag-arm-r">{sec ? sec.roman : 'ALL'}</span>
        <span className="ag-arm-c num">{live ? String(agents.length).padStart(2, '0') : DASH}</span>
      </span>
      <span className="ag-arm-n">{sec ? sec.name : '8 arms'}</span>
      <span className="ag-arm-m num">
        {live ? working : DASH} on · {fmtCompact(pages)} pg
      </span>
      <span className="ag-arm-bar" aria-hidden="true">
        {sector === null
          ? SECTORS.map((s) => {
              const n = agents.filter((a) => a.sector === s.id && stateTone(a.state) === 'hot').length
              return <i key={s.id} className={n ? 'tone-hot' : ''} />
            })
          : list.map((a) => <i key={a.id} className={`tone-${stateTone(a.state)}`} />)}
      </span>
    </button>
  )
}

export function ArmsView() {
  const [params, setParams] = useSearchParams()
  const agents = useSampled((s) => s.agents, 250)
  const stats = useSampled((s) => s.stats, 500)
  const sectors = useSampled((s) => s.sectors, 1000)
  const conn = useSampled((s) => s.conn, 400)
  const live = conn === 'live'
  const pages = useSampled((s) => s.pages, 1000)

  const arm = parseArm(params.get('arm'))
  const [q, setQ] = useState(() => params.get('q') ?? '')
  const [origin, setOrigin] = useState<Origin>('all')
  const [sort, setSort] = useState<SortSpec>({ key: 'code', dir: 1 })
  const [spawnSector, setSpawnSector] = useState(() => arm ?? 1)
  const [freshId, setFreshId] = useState<number | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = 'Agents — LUSCA'
  }, [])

  // "/" focuses the search, like every good instrument
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  useEffect(() => {
    if (freshId === null) return
    const t = window.setTimeout(() => setFreshId(null), 6000)
    return () => window.clearTimeout(t)
  }, [freshId])

  const setArm = (a: number | null) => {
    const next = new URLSearchParams(params)
    if (a === null) next.delete('arm')
    else next.set('arm', ROMAN[a])
    setParams(next, { replace: true })
    if (a !== null) setSpawnSector(a)
  }

  const onSort = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: (s.dir * -1) as 1 | -1 } : { key: k, dir: DEFAULT_DIR[k] }))

  // last taste: the agent's own lastScore, else the score of its newest kept page
  const scoreOf = useMemo(() => {
    const m = new Map<number, number>()
    for (const p of pages) if (!m.has(p.agentId)) m.set(p.agentId, p.score)
    return (a: AgentInfo) => a.lastScore ?? m.get(a.id) ?? null
  }, [pages])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = agents.filter((a) => {
      if (arm !== null && a.sector !== arm) return false
      if (origin !== 'all' && a.origin !== origin) return false
      if (!needle) return true
      const sec = SECTORS[a.sector]
      return (
        a.code.toLowerCase().includes(needle) ||
        a.name.includes(needle) ||
        (a.host ?? '').includes(needle) ||
        (a.owner ?? '').toLowerCase().includes(needle) ||
        sec.name.toLowerCase().includes(needle) ||
        a.state.includes(needle)
      )
    })
    return sortAgents(list, sort, scoreOf)
  }, [agents, arm, origin, q, sort, scoreOf])

  const active = agents.filter((a) => WORKING.has(a.state)).length
  const tasting = agents.filter((a) => a.state === 'taste').length
  const spawnedN = agents.filter((a) => a.origin === 'spawned').length
  const accept = live && stats.pages + stats.rejected > 0 ? (stats.pages / (stats.pages + stats.rejected)) * 100 : null
  const v = (n: number) => (live ? n : null)

  return (
    <div className="ag">
      <header className="ag-head">
        <div className="ag-title grid-bg">
          <Kicker n="04" name="Agents" className="ag-idx">
            <ConnBadge className="ag-conn" />
          </Kicker>
          <h1 className="display">The Arms</h1>
          <p className="ag-lede">Every agent in the data pipeline, what it is doing right now, and how to add your own.</p>
          <ConnNote />
          <OnThisPage
            links={[
              { id: 'all-agents', label: 'All agents' },
              { id: 'add-agent', label: 'Add an agent' },
            ]}
          />
        </div>
        <div className="ag-stats">
          <Stat label="agents" value={v(agents.length)} sub={live ? `${agents.length - spawnedN} core · ${spawnedN} added` : `${DASH} core · ${DASH} added`} />
          <Stat label="working now" value={v(active)} hot sub={`${live ? tasting : DASH} scoring a page`} />
          <Stat label="pages kept" value={v(stats.pages)} sub={`${fmtInt(v(stats.pagesPerMin))} / min`} />
          <Stat label="kept rate" value={accept} suffix="%" sub={`${fmtInt(v(stats.rejected))} dropped`} />
          <Stat label="websites" value={v(stats.domains)} sub={`${fmtCompact(v(stats.frontier))} links queued`} />
        </div>
      </header>

      <Terms keys={['agent', 'arm', 'taste']} />

      <div className="ag-body">
        <section className="panel ag-roster pk-anchor" id="all-agents" aria-labelledby="ag-roster-h">
          <div className="panel-head">
            <span id="ag-roster-h">
              <span className="hot">A</span>&nbsp;&nbsp;<b>All agents</b>
            </span>
            <span className="num">
              {live ? `${shown.length}/${agents.length}` : `${DASH}/${DASH}`} · by {SORT_LABEL[sort.key]} {sort.dir === 1 ? '↑' : '↓'}
            </span>
          </div>
          <p className="ag-hint">Filter by arm or search. Click any agent to see every step it took.</p>
          <nav className="ag-strip" aria-label="Filter agents by arm">
            <ArmCell sector={null} agents={agents} pages={v(stats.pages)} on={arm === null} onPick={() => setArm(null)} live={live} />
            {SECTORS.map((s) => (
              <ArmCell
                key={s.id}
                sector={s.id}
                agents={agents.filter((a) => a.sector === s.id)}
                pages={sectors.find((x) => x.id === s.id)?.pages ?? null}
                on={arm === s.id}
                onPick={() => setArm(arm === s.id ? null : s.id)}
                live={live}
              />
            ))}
          </nav>
          <div className="ag-tools">
            <label className="ag-search">
              <span className="sr-only">Search agents</span>
              <span className="ag-search-k mono" aria-hidden="true">
                /
              </span>
              <input
                ref={searchRef}
                type="search"
                placeholder="search name, code, website, owner"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="ag-seg" role="group" aria-label="Filter by origin">
              {(['all', 'genesis', 'spawned'] as Origin[]).map((o) => (
                <button key={o} type="button" className={origin === o ? 'on' : ''} aria-pressed={origin === o} onClick={() => setOrigin(o)}>
                  {ORIGIN_LABEL[o]}
                </button>
              ))}
            </div>
            <label className="ag-sortsel">
              <span className="label">sort</span>
              <select
                value={`${sort.key}:${sort.dir}`}
                onChange={(e) => {
                  const [k, d] = e.target.value.split(':')
                  setSort({ key: k as SortKey, dir: Number(d) === 1 ? 1 : -1 })
                }}
              >
                {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                  <option key={k} value={`${k}:${DEFAULT_DIR[k]}`}>
                    {SORT_LABEL[k]} {DEFAULT_DIR[k] === 1 ? '↑' : '↓'}
                  </option>
                ))}
                {DEFAULT_DIR[sort.key] !== sort.dir && (
                  <option value={`${sort.key}:${sort.dir}`}>
                    {SORT_LABEL[sort.key]} {sort.dir === 1 ? '↑' : '↓'}
                  </option>
                )}
              </select>
            </label>
          </div>
          <div className="ag-tablewrap">
            <AgentTable
              agents={shown}
              scoreOf={scoreOf}
              sort={sort}
              onSort={onSort}
              freshId={freshId}
              empty={!live ? CONN_TEXT[conn] : agents.length === 0 ? 'no agents reported yet' : 'no agent matches — clear the filter or search'}
            />
          </div>
        </section>

        <aside className="panel ag-spawn pk-anchor" id="add-agent" aria-labelledby="ag-spawn-h">
          <div className="panel-head">
            <span id="ag-spawn-h">
              <span className="hot">B</span>&nbsp;&nbsp;<b>Add an agent</b>
            </span>
            <span className="hot">free · earns no credits</span>
          </div>
          <SpawnPanel sector={spawnSector} onSector={setSpawnSector} onSpawned={(a) => setFreshId(a.id)} />
        </aside>
      </div>

      <NextStep
        text="Agents fetch the web; connected GPUs check their work. Plug yours in from this browser tab to earn credits — no install, no account, no wallet needed to start."
        secondary={{ to: '/earn', label: 'How rewards work' }}
      />
    </div>
  )
}
