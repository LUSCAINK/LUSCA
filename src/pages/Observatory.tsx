import { useEffect, useRef, useState } from 'react'
import { Creature } from '@/components/creature/Creature'
import { Roster } from '@/components/obs/Roster'
import { Inspector } from '@/components/obs/Inspector'
import { Pipeline } from '@/components/obs/Pipeline'
import { Tape } from '@/components/obs/Tape'
import { Stat } from '@/components/obs/parts'
import { ConnNote, connLed } from '@/components/ui/conn'
import { bus } from '@/lib/bus'
import { useSampled } from '@/lib/hooks'
import { CONN_LABEL, useLive } from '@/lib/store'
import { DASH } from '@/lib/format'
import '@/components/obs/parts.css'
import './observatory.css'

export default function Observatory() {
  const [pinned, setPinned] = useState<number | null>(null)
  const [auto, setAuto] = useState<number | null>(null)
  const lastSwitch = useRef(-Infinity)
  const stats = useSampled((s) => s.stats, 400)
  const conn = useSampled((s) => s.conn, 500)

  // auto-follow: jump to an agent that just started tasting a page (at most every 7s)
  useEffect(() => {
    const pickInitial = () => {
      const a = useLive.getState().agents.find((x) => x.state === 'fetch' || x.state === 'taste')
      if (a) setAuto(a.id)
    }
    pickInitial()
    return bus.on('agent', (m) => {
      const now = performance.now()
      if ((m.agent.state === 'taste' || m.agent.state === 'fetch') && now - lastSwitch.current > 7000) {
        lastSwitch.current = now
        setAuto(m.agent.id)
      }
    })
  }, [])

  useEffect(() => {
    document.title = 'Observatory — LUSCA'
  }, [])

  // keyboard: j/k (or ↓/↑) cycle agents · 1–8 jump to an arm · esc returns to auto-follow
  const shownRef = useRef<number | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const agents = useLive.getState().agents.slice().sort((a, b) => a.sector - b.sector || a.slot - b.slot)
      if (!agents.length) return
      const cur = agents.findIndex((a) => a.id === shownRef.current)
      if (e.key === 'j' || e.key === 'ArrowDown') {
        setPinned(agents[(cur + 1 + agents.length) % agents.length].id)
        e.preventDefault()
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        setPinned(agents[(cur - 1 + agents.length) % agents.length].id)
        e.preventDefault()
      } else if (e.key === 'Escape') {
        setPinned(null)
      } else if (/^[1-8]$/.test(e.key)) {
        const arm = agents.filter((a) => a.sector === Number(e.key) - 1)
        if (arm.length) {
          const i = arm.findIndex((a) => a.id === shownRef.current)
          setPinned(arm[(i + 1) % arm.length].id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const shown = pinned ?? auto
  shownRef.current = shown
  const live = conn === 'live'
  const accept = live && stats.pages + stats.rejected > 0 ? (stats.pages / (stats.pages + stats.rejected)) * 100 : null
  const v = (n: number) => (live ? n : null)

  return (
    <div className="obs">
      <header className="obs-head">
        <div className="obs-title">
          <div className="obs-kick mono">
            <span className="hot">[01]</span> live view · {live ? 'live from the server' : conn === 'connecting' ? 'connecting' : 'server unreachable'}
          </div>
          <h1 className="display">Observatory</h1>
          <p className="obs-lede">Every agent fetching the crypto web, as it happens. Click any glowing agent, or a row on the left, to see why it keeps or drops a page.</p>
          <ConnNote className="obs-conn" />
        </div>
        <div className="obs-stats">
          <Stat label="pages accepted" value={v(stats.pages)} hot />
          <Stat label="tokens accepted" value={v(stats.tokens)} compact />
          <Stat label="hosts" value={v(stats.domains)} />
          <Stat label="frontier" value={v(stats.frontier)} compact />
          <Stat label="pages / min" value={v(stats.pagesPerMin)} />
          <Stat label="accept rate" value={accept} suffix="%" />
        </div>
      </header>

      <aside className="obs-roster panel">
        <div className="panel-head">
          <span>
            <span className="hot">A</span>&nbsp;&nbsp;<b>Arms</b>
          </span>
          <span>
            {live ? `${stats.agentsActive}/${stats.agentsTotal}` : `${DASH}/${DASH}`} active
          </span>
        </div>
        <Roster selected={shown} onSelect={setPinned} />
      </aside>

      <section className="obs-stage brackets">
        <Creature variant="observatory" interactive labels selected={shown} onSelect={(id) => id !== null && setPinned(id)} />
        <div className="hud hud-tl mono">
          <span className={connLed(conn)} />
          {CONN_LABEL[conn]} · LUSCA/OBS · {live ? stats.agentsActive : DASH} AGENTS WORKING
        </div>
        <div className="hud hud-tr">
          <div className="lg">
            <i className="lg-ring" /> agent
          </div>
          <div className="lg">
            <i className="lg-sq" /> page
          </div>
          <div className="lg">
            <i className="lg-sq lg-dim" /> frontier
          </div>
          <div className="lg">
            <i className="lg-dash" /> fetching
          </div>
          <div className="lg">
            <i className="lg-line" /> tasting
          </div>
          <div className="lg">
            <i className="lg-sq lg-err" /> rejected
          </div>
        </div>
        <div className="hud hud-bl mono">DRAG · ORBIT &nbsp;/&nbsp; SCROLL · ZOOM &nbsp;/&nbsp; CLICK AN AGENT &nbsp;/&nbsp; J K · CYCLE &nbsp;/&nbsp; 1–8 · ARM &nbsp;/&nbsp; ESC · FOLLOW</div>
      </section>

      <aside className="obs-insp panel">
        <div className="panel-head">
          <span>
            <span className="hot">B</span>&nbsp;&nbsp;<b>Inspector</b>
          </span>
          <span>decisions</span>
        </div>
        <Inspector agentId={shown} follow={pinned === null} onRelease={() => setPinned(null)} />
      </aside>

      <section className="obs-pipe panel">
        <div className="panel-head">
          <span>
            <span className="hot">C</span>&nbsp;&nbsp;<b>Pipeline</b>
          </span>
          <span>every page, every stage</span>
        </div>
        <Pipeline />
      </section>

      <section className="obs-tape panel">
        <div className="panel-head">
          <span>
            <span className="hot">D</span>&nbsp;&nbsp;<b>Tape</b>
          </span>
          <span>newest first</span>
        </div>
        <Tape />
      </section>
    </div>
  )
}
