import { useEffect, useRef } from 'react'
import type { MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { useNeuron } from '@/lib/gpu'
import { useSampled } from '@/lib/hooks'
import { SectionRail } from '@/components/node/SectionRail'
import type { RailSection } from '@/components/node/SectionRail'
import { EarnStrip, EarningsPanel, StartButton } from '@/components/node/Earnings'
import { HowSteps } from '@/components/node/HowSteps'
import { DetectStage } from '@/components/node/DetectStage'
import { BenchStage } from '@/components/node/BenchStage'
import { ZoneStage } from '@/components/node/ZoneStage'
import { DiveStage } from '@/components/node/DiveStage'
import { Requirements, Safety } from '@/components/node/InfoSections'
import { NetworkPanel } from '@/components/node/NetworkPanel'
import { ZonesTable } from '@/components/node/ZonesTable'
import { SecHead } from '@/components/node/Stage'
import type { StageState } from '@/components/node/Stage'
import { UNREACHABLE_TEXT, serverState, usePhase } from '@/components/node/flow'
import { scrollToId } from '@/components/node/util'
import '@/components/obs/parts.css'
import './node.css'
import { NAV_N } from '@/lib/nav'

const SECTIONS: RailSection[] = [
  { id: 'start', label: 'Start' },
  { id: 'how', label: 'How it works' },
  { id: 'details', label: 'Details' },
  { id: 'requirements', label: 'Requirements' },
  { id: 'safety', label: 'Is it safe?' },
  { id: 'network', label: 'Who’s connected' },
  { id: 'tiers', label: 'GPU tiers' },
]

const TOC: [string, string][] = [
  ['how', 'How it works'],
  ['requirements', 'Requirements'],
  ['safety', 'Is it safe?'],
  ['network', 'Who’s connected'],
]

const TERMS: [string, string][] = [
  ['Neuron', 'a GPU connected to LUSCA (yours, through this browser tab or the desktop app).'],
  ['Tier', 'your GPU’s class (EPI, MESO, BATHY, ABYSSO, HADAL), set by a 10-second benchmark. Deeper tier = bigger jobs + a bigger credit bonus.'],
  ['Credits', 'your share of the payout pool, earned by verified GPU work. Training credits are held as pending until an audit of your gradients passes. Each payout period, the pool is split by confirmed credits and paid in SOL to verified wallets.'],
]

function connText(conn: string): string {
  const srv = serverState(conn)
  if (srv === 'live') return 'server live · every result checked'
  if (srv === 'connecting') return 'connecting to the LUSCA server…'
  return UNREACHABLE_TEXT
}

export default function Node() {
  const root = useRef<HTMLDivElement>(null)
  const status = useNeuron((s) => s.status)
  const det = useNeuron((s) => s.detect)
  const bench = useNeuron((s) => s.bench)
  // activity restored after a reload (job log / speed chart) keeps step 4 readable before a benchmark
  const hasActivity = useNeuron((s) => s.log.length > 0 || s.history.length > 0)
  const conn = useSampled((s) => s.conn, 500)
  const { phase } = usePhase()

  useEffect(() => {
    document.title = 'Start earning — LUSCA'
  }, [])

  const running = status === 'running' || status === 'paused'
  const states: StageState[] = [
    status === 'detecting' ? 'busy' : det ? 'done' : 'ready',
    !det ? 'locked' : status === 'benchmarking' ? 'busy' : bench ? 'done' : 'ready',
    !bench ? 'locked' : 'done',
    !bench && !hasActivity ? 'locked' : running ? 'busy' : 'ready',
  ]

  const jump = (id: string) => (e: MouseEvent) => {
    e.preventDefault()
    scrollToId(id)
  }

  return (
    <div className="nd" ref={root}>
      <div className="nd-snow" aria-hidden="true" />
      <SectionRail root={root} sections={SECTIONS} />
      <div className="nd-main">
        <header id="start" className="nd-hero">
          <div className="nd-hero-grid">
            <div className="nd-hero-copy">
              <div className="nd-kick mono">
                <span>
                  <span className="hot">[{NAV_N.node}]</span> start earning
                </span>
                <span className="nd-conn">
                  <span className={`led ${conn === 'live' ? 'on pulse' : 'white pulse'}`} aria-hidden="true" />
                  {connText(conn)}
                </span>
              </div>
              <h1 className="display nd-h1">
                <span>Connect a GPU.</span>
                <span>Earn SOL.</span>
              </h1>
              <p className="nd-lede-hero">
                Your GPU trains SEPIA, the language model LUSCA builds from the pages it collects. It computes training gradients on batches the server picks;
                the server checks each one and merges it into the model. Verified work earns credits — your share of each SOL payout. Each payout period the payout pool is split by confirmed
                credits and paid in SOL to verified wallets.
              </p>
              <div className="nd-actions nd-cta">
                <StartButton />
                <a className="btn lg" href="#details" onClick={jump('detect')}>
                  {phase === 'idle' ? 'step by step' : 'see the details'} <span aria-hidden="true">↓</span>
                </a>
              </div>
              <ul className="nd-chips" aria-label="Good to know">
                <li>
                  <b>No install</b> · runs in this tab
                </li>
                <li>
                  <b>No account</b> · a wallet is only needed to receive SOL
                </li>
                <li>
                  <b>Stop any time</b> · pauses when you leave the tab
                </li>
              </ul>
              <nav className="nd-toc mono" aria-label="On this page">
                <span className="nd-toc-l">on this page</span>
                {TOC.map(([id, label]) => (
                  <a key={id} href={`#${id}`} onClick={jump(id)}>
                    {label}
                  </a>
                ))}
              </nav>
            </div>
            <EarningsPanel />
          </div>
          <dl className="nd-terms" aria-label="Terms used on this page">
            <div className="nd-terms-h mono">terms</div>
            {TERMS.map(([t, d]) => (
              <div key={t} className="nd-term">
                <dt className="mono">{t}</dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
        </header>

        <HowSteps />

        <section id="details" className="nd-details" aria-labelledby="details-h">
          <div className="nd-sec nd-details-head">
            <SecHead
              id="details-h"
              kicker="details"
              title="Details"
              sub="Every number behind the four steps. Start earning runs them all for you; here you can run them one at a time."
            />
          </div>
          <DetectStage state={states[0]} />
          <BenchStage state={states[1]} />
          <ZoneStage state={states[2]} />
          <DiveStage state={states[3]} />
        </section>

        <Requirements />
        <Safety />
        <NetworkPanel />
        <ZonesTable />

        <footer className="nd-floor">
          <div className="floor-rule" aria-hidden="true" />
          <div className="floor-grid">
            <div>
              <p className="sec-k mono">
                <span className="sec-i" aria-hidden="true">
                  ■
                </span>
                ready
              </p>
              <p className="floor-h display">Connect a GPU. Earn SOL.</p>
            </div>
            <div className="nd-actions floor-cta">
              <StartButton />
              <Link className="btn lg" to="/earn">
                how rewards are paid <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
        </footer>
      </div>
      <EarnStrip />
    </div>
  )
}
