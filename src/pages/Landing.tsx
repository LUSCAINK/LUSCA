import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AgentState } from '@shared/protocol'
import { ZONES } from '@shared/protocol'
import { SECTORS } from '@shared/sectors'
import { Creature } from '@/components/creature/Creature'
import { Count, Spark } from '@/components/obs/parts'
import { Logo } from '@/components/shell/Logo'
import { INK_LINE, payoutStatus, sentence, solAmt, usePayoutRules } from '@/components/docs/payout'
import { HP } from '@/components/sepia/model'
import { connLed } from '@/components/ui/conn'
import { bus } from '@/lib/bus'
import { useConn, useIsLive, useSampled } from '@/lib/hooks'
import { CONN_TEXT, useLive } from '@/lib/store'
import { DASH, fmtCompact, fmtFixed, fmtInt } from '@/lib/format'
import '@/components/obs/parts.css'
import './landing.css'

/* ─── shared section header ──────────────────────────────── */

function SecHead({ i, kicker, title, children }: { i: string; kicker: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="sec-head">
      <span className="sec-i mono">[ {i} ]</span>
      <div className="sec-t">
        <div className="sec-kick mono">{kicker}</div>
        <h2 className="display sec-h">{title}</h2>
      </div>
      {children && <p className="sec-k">{children}</p>}
    </div>
  )
}

/* ─── hero ───────────────────────────────────────────────── */

function Telemetry() {
  const s = useSampled((st) => st.stats, 400)
  const m = useSampled((st) => st.model, 600)
  const conn = useConn(600)
  const live = conn === 'live'
  const rows: [string, number, boolean?][] = [
    ['pages kept', s.pages],
    ['tokens collected', s.tokens, true],
    ['websites', s.domains],
    ['agents working', s.agentsActive],
    ['gpus connected', s.neurons],
  ]
  return (
    <div className="tele">
      <div className="tele-head">
        <span className={connLed(conn)} />
        <span>{live ? 'live from the server' : conn === 'connecting' ? 'connecting…' : 'server unreachable'}</span>
      </div>
      {rows.map(([k, v, c]) => (
        <div key={k} className="tele-row">
          <span className="label">{k}</span>
          <span className="tele-v">
            <Count value={live ? v : null} compact={c} />
          </span>
        </div>
      ))}
      <div className="tele-row">
        <span className="label">model loss</span>
        <span className="tele-v hot num">{live && m.step > 0 ? fmtFixed(m.loss, 3) : DASH}</span>
      </div>
    </div>
  )
}

function Ticker() {
  const conn = useConn(600)
  const pages = useSampled((st) => st.pages.slice(0, 24), 2500)
  const live = conn === 'live'
  const row = (
    <>
      {pages.map((p) => (
        <span key={p.id} className="tk-item">
          <span className="tk-sec">{SECTORS[p.sector]?.roman}</span>
          <span className="tk-host">{p.host.replace(/^www\./, '')}</span>
          <span className="tk-title">{p.title}</span>
          {p.tokens > 0 && <span className="tk-tok">+{fmtCompact(p.tokens)} tok</span>}
          <span className="tk-sep">/</span>
        </span>
      ))}
    </>
  )
  return (
    <div className="ticker" aria-label="Pages the agents just kept">
      <div className="tk-label">
        <span className={live ? 'led on pulse' : 'led'} /> just kept
      </div>
      <div className="tk-track">
        {live && pages.length > 0 ? (
          <div className="tk-run">
            {row}
            {row}
          </div>
        ) : (
          <div className="tk-item tk-empty">
            <span className="tk-host">{live ? 'no pages kept since the server started' : CONN_TEXT[conn]}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function Hero() {
  return (
    <section className="hero">
      <div className="hero-gl">
        <Creature variant="hero" />
      </div>
      <div className="hero-vignette" aria-hidden="true" />
      <div className="hero-grid" aria-hidden="true" />

      <div className="hero-top mono">
        <span>[ 00 ]</span>
        <span>lusca · open corpus · verified gpu work</span>
        <nav className="hero-jump" aria-label="On this page">
          <a href="#how">how it works</a>
          <a href="#start">start earning</a>
          <a href="#tiers">gpu tiers</a>
          <a href="#faq">questions</a>
        </nav>
      </div>

      <div className="hero-copy">
        <h1 className="hero-h display">
          <span className="hh-line">Open corpus.</span>
          <span className="hh-line">
            Verified <em>work</em>.
          </span>
        </h1>
        <p className="hero-p">
          LUSCA runs agents that fetch public crypto web pages, score them for relevance and keep the useful ones in an open corpus. A small language
          model trains on that corpus in public. <b>Connect your GPU</b> from the browser and it computes training gradients for that model on
          batches the server picks; the server checks every result, recomputes a share of them in full and applies the accepted ones. Checked work
          earns <b className="hot">INK</b>. Each payout period, the payout pool is split by INK and paid in SOL to verified wallets.
        </p>
        <div className="hero-cta">
          <Link to="/node" className="btn primary lg">
            start earning <span aria-hidden="true">→</span>
          </Link>
          <Link to="/live" className="btn lg">
            open the live view
          </Link>
        </div>
        <div className="hero-chips mono">
          <span>no install</span>
          <span>no account</span>
          <span>stop any time</span>
        </div>
      </div>

      <Telemetry />
      <Ticker />
    </section>
  )
}

/* ─── 01 how it works ────────────────────────────────────── */

function HowItWorks() {
  const s = useSampled((st) => st.stats, 800)
  const m = useSampled((st) => st.model, 800)
  const conn = useConn(1000)
  const live = conn === 'live'
  const steps = [
    {
      n: '01',
      k: 'ingest',
      t: 'Agents fetch the crypto web',
      d: 'Agents visit governance forums, research, developer docs and standards. Each page gets a taste score from 0 to 1. Only crypto-relevant pages are kept.',
      live: live ? `${fmtInt(s.pages)} pages kept · ${fmtInt(s.domains)} websites` : `${DASH} pages kept · ${DASH} websites`,
      to: '/live',
      cta: 'open the live view',
    },
    {
      n: '02',
      k: 'train',
      t: 'A small language model trains on it',
      d: 'Every kept page becomes training text for SEPIA, a small character-level model. Connected GPUs compute its training gradients and the server applies the ones that pass its checks. The loss curve and samples are on the Model page, and you can prompt it.',
      live: !live ? `step ${DASH} · loss ${DASH}` : m.step ? `step ${fmtInt(m.step)} · loss ${fmtFixed(m.loss, 3)}` : 'waiting for enough text to start',
      to: '/sepia',
      cta: 'see the model',
    },
    {
      n: '03',
      k: 'verify',
      t: 'Your GPU trains the model',
      d: 'Your graphics card computes SEPIA training gradients on batches the server picks, and also checks new pages for near-duplicates. The server checks every result and recomputes a share in full; training INK is pending until an audit confirms it.',
      live: live ? `${fmtInt(s.jobsVerified)} jobs verified · ${fmtCompact(s.inkIssued)} INK issued` : `${DASH} jobs verified · ${DASH} INK issued`,
      to: '/node',
      cta: 'start earning',
    },
  ]
  return (
    <section className="sec how" id="how">
      <SecHead i="01" kicker="how it works" title="Three stages, one pipeline.">
        {live ? 'The figures below come from the running server and update as it works.' : `${CONN_TEXT[conn]} Figures show “—” until it answers.`}
      </SecHead>
      <ol className="how-steps">
        {steps.map((st) => (
          <li key={st.n} className="how-step">
            <div className="how-top">
              <span className="how-n display">{st.n}</span>
              <span className="how-k mono">{st.k}</span>
            </div>
            <h3 className="how-t">{st.t}</h3>
            <p className="how-d">{st.d}</p>
            <div className="how-live mono">
              <span className={live ? 'led on pulse' : 'led'} /> {st.live}
            </div>
            <Link to={st.to} className="how-cta mono">
              {st.cta} →
            </Link>
          </li>
        ))}
      </ol>
      <dl className="terms">
        <div>
          <dt>Agent</dt>
          <dd>an automated program that fetches crypto websites and decides which pages to keep</dd>
        </div>
        <div>
          <dt>Arm</dt>
          <dd>one of 8 topic areas, like governance or security; each agent works one arm</dd>
        </div>
        <div>
          <dt>Taste score</dt>
          <dd>how relevant a page is to crypto, 0 to 1; under 0.35 it is dropped</dd>
        </div>
        <div>
          <dt>Neuron</dt>
          <dd>a GPU connected to LUSCA, yours through a browser tab</dd>
        </div>
        <div>
          <dt>Tier</dt>
          <dd>your GPU's class, EPI to HADAL, set by a 10-second benchmark</dd>
        </div>
        <div>
          <dt>INK</dt>
          <dd>points for verified GPU work; each payout period, the payout pool is split by INK and paid in SOL to verified wallets</dd>
        </div>
      </dl>
    </section>
  )
}

/* ─── 02 start earning ───────────────────────────────────── */

function StartEarning() {
  const steps = [
    { t: 'Open Start earning', d: 'One page, in this browser. Nothing to download.' },
    { t: 'Detect your GPU', d: 'Your browser reports which graphics card you have.' },
    { t: 'Run the benchmark', d: '10 seconds of real math sets your tier.' },
    { t: 'Press start', d: 'Your GPU takes jobs. Each verified job adds INK.' },
  ]
  return (
    <section className="sec start" id="start">
      <SecHead i="02" kicker="start earning" title="Start in about a minute.">
        No install and no account. Earning INK needs no wallet; connect and verify a wallet only to receive SOL payouts.
      </SecHead>
      <div className="start-grid">
        <ol className="start-steps">
          {steps.map((s, i) => (
            <li key={s.t} className="start-step">
              <span className="start-n num">{i + 1}</span>
              <div>
                <div className="start-t">{s.t}</div>
                <div className="start-d">{s.d}</div>
              </div>
            </li>
          ))}
        </ol>
        <div className="start-panel panel">
          <div className="panel-head">
            <span>
              <b>What you need</b>
            </span>
            <span>requirements</span>
          </div>
          <ul className="need">
            <li>
              <span className="need-k mono">browser</span>
              <span>Chrome or Edge 113 or newer</span>
            </li>
            <li>
              <span className="need-k mono">gpu</span>
              <span>any graphics card; laptops work too</span>
            </li>
            <li>
              <span className="need-k mono">time</span>
              <span>runs while the tab is open; pauses when you leave it</span>
            </li>
            <li>
              <span className="need-k mono">wallet</span>
              <span>only to receive SOL: sign one plain-text message (not a transaction, no cost)</span>
            </li>
          </ul>
          <div className="start-cta">
            <Link to="/node" className="btn primary lg">
              start earning →
            </Link>
            <Link to="/earn" className="btn ghost">
              how rewards work
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ─── 03 gpu tiers ───────────────────────────────────────── */

const TYPICAL = [
  'older integrated graphics',
  'recent laptops · Apple M1 · GTX 1650',
  'RTX 3060 · RX 6600 · Apple M-Pro',
  'RTX 3070 / 3080 · RTX 4060 Ti',
  'RTX 4070 Super and up · workstation cards',
]

function Tiers() {
  return (
    <section className="sec zones" id="tiers">
      <SecHead i="03" kicker="gpu tiers" title="Find your tier.">
        The benchmark measures how much math your GPU does per second. Deeper tiers get bigger jobs and a bigger INK bonus on every verified job.
      </SecHead>
      <div className="strata">
        <div className="stratum st-head mono">
          <span>tier</span>
          <span>examples (your benchmark decides)</span>
          <span>needs</span>
          <span className="st-w">ink bonus</span>
        </div>
        {ZONES.map((z, i) => (
          <div key={z.zone} className={`stratum s${i}`}>
            <span className="st-zone display">{z.zone}</span>
            <span className="st-ex">{TYPICAL[i]}</span>
            <span className="st-g mono">{z.minGflops ? `≥ ${fmtInt(z.minGflops)} GFLOPS` : 'any GPU'}</span>
            <span className="st-w mono">×{z.bonus.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="zones-cta">
        <Link to="/node" className="btn primary lg">
          find my tier →
        </Link>
        <span className="mono dim">a 10-second test in your browser</span>
      </div>
    </section>
  )
}

/* ─── 04 how it differs ──────────────────────────────────── */

function WhyMore() {
  const { rules, fromServer } = usePayoutRules()
  const VERSUS: [string, string, string][] = [
    ['who does the work', 'The project’s own servers. Slot holders burn about 2 SOL of tokens for a share of fees.', 'You do, with a browser tab or a GPU. The server spot-checks every job.'],
    [
      'how rewards are split',
      'Equal shares for every uncapped slot that reads 25 new pages in a 12-hour round. The project’s scheduler reads those pages, not the slot holder.',
      'By INK earned from verified work in the payout period, so extra wallets earn nothing extra.',
    ],
    [
      'earning limit',
      'Earning stops at 2× the SOL burned; the slot keeps working unpaid.',
      `At most ${solAmt(rules.maxWalletSol)}${fromServer ? '' : ' (server default)'} per wallet per period; the excess carries to the next period.`,
    ],
    ['how many can join', '100 slots for sale.', 'Anyone, while there is unchecked work.'],
    [
      'where the money comes from',
      '40% of trading fees.',
      'Creator fees from the owner’s token, routed to the treasury wallet. Each period pays out a share of the treasury balance; no amount is guaranteed.',
    ],
    [
      'what you can see',
      'A live page camera with each slot’s reasoning, an open API and on-chain payouts.',
      'Every decision each agent makes, live; the treasury balance and every payout transaction on Solscan.',
    ],
    ['your gpu', 'Not used.', 'One click in the browser. Five tiers, EPI to HADAL.'],
  ]
  return (
    <section className="sec versus" id="why">
      <SecHead i="04" kicker="how it differs" title="Rewards follow verified work.">
        Buy-a-slot projects sell a share of trading fees while their own servers do the work. LUSCA credits the work you do yourself: INK for verified
        GPU jobs, split into SOL payouts each period.
      </SecHead>
      <div className="vs-table" role="table">
        <div className="vs-row vs-headrow" role="row">
          <span role="columnheader" />
          <span role="columnheader" className="vs-them">
            buy-a-slot projects
          </span>
          <span role="columnheader" className="vs-us">
            <Logo size={16} color="var(--ink)" /> lusca
          </span>
        </div>
        {VERSUS.map(([k, a, b], i) => (
          <div key={k} className="vs-row" role="row">
            <span role="cell" className="vs-k">
              <span className="vs-n num">{String(i + 1).padStart(2, '0')}</span>
              {k}
            </span>
            <span role="cell" className="vs-a">
              {a}
            </span>
            <span role="cell" className="vs-b">
              {b}
            </span>
          </div>
        ))}
      </div>
      <p className="vs-foot mono">
        Buy-a-slot figures: public API and on-chain data, 4 Oct 2026, 21:00–23:15 UTC. Their rules may have changed since.
      </p>
      <div className="anatomy-cta">
        <Link to="/earn" className="btn">
          see the treasury and payouts →
        </Link>
      </div>
    </section>
  )
}

/* ─── 05 watch an agent decide (live) ────────────────────── */

const STEPS: { st: AgentState; name: string; line: string }[] = [
  { st: 'seek', name: 'Seek', line: 'chooses the most promising link from thousands waiting in line.' },
  { st: 'fetch', name: 'Fetch', line: 'downloads the page politely: robots.txt honored, one request per site at a time.' },
  { st: 'parse', name: 'Parse', line: 'strips menus and ads, keeps the text, collects every link on the page.' },
  { st: 'taste', name: 'Taste', line: 'scores crypto relevance from 0 to 1. under 0.35, the page is dropped.' },
  { st: 'dedupe', name: 'Dedupe', line: 'checks the page is not a copy of something already kept.' },
  { st: 'store', name: 'Store', line: 'adds the page to the corpus and sends it to the model.' },
]

function WatchAgent() {
  // Follow ONE real agent through its loop so the sequence can be read step by step.
  const [featured, setFeatured] = useState<number | null>(null)
  const [cur, setCur] = useState<AgentState | null>(null)
  const [msgs, setMsgs] = useState<Record<string, string>>({})
  const [visit, setVisit] = useState(0)
  const feat = useRef<number | null>(null)
  const shown = useRef<number | null>(null)
  const handoff = useRef(0)
  const agents = useSampled((s) => s.agents, 1000)
  const conn = useConn(600)
  const live = conn === 'live'

  useEffect(() => {
    const pick = () => {
      const pool = useLive.getState().agents.filter((a) => a.state === 'seek' || a.state === 'fetch')
      const a = pool[Math.floor(Math.random() * pool.length)]
      if (!a) return
      feat.current = a.id
      shown.current = a.id
      setFeatured(a.id)
      setCur(a.state)
      setMsgs({})
      setVisit((v) => v + 1)
    }
    pick()
    const offA = bus.on('agent', (m) => {
      if (feat.current === null) {
        if (performance.now() > handoff.current) pick()
        return
      }
      if (m.agent.id !== feat.current) return
      setCur(m.agent.state)
      if (m.agent.state === 'store' || m.agent.state === 'reject' || m.agent.state === 'error') {
        feat.current = null
        handoff.current = performance.now() + 2200
      }
    })
    const offT = bus.on('trace', (m) => {
      // keep listening to the last featured agent until the next one is picked
      if (m.trace.agentId !== shown.current) return
      setMsgs((x) => ({ ...x, [m.trace.step]: m.trace.msg }))
    })
    const id = window.setInterval(() => {
      if (feat.current === null && performance.now() > handoff.current) pick()
    }, 500)
    // link lost: forget the agent being followed
    const offConn = useLive.subscribe((s, prev) => {
      if (prev.conn === 'live' && s.conn !== 'live') {
        feat.current = null
        shown.current = null
        setFeatured(null)
        setCur(null)
        setMsgs({})
      }
    })
    return () => {
      offA()
      offT()
      offConn()
      window.clearInterval(id)
    }
  }, [])

  const order: Record<string, number> = { seek: 0, fetch: 1, parse: 2, taste: 3, dedupe: 4, store: 5, reject: 3, error: 1 }
  const at = live && cur ? order[cur] ?? -1 : -1
  const failed = live && (cur === 'reject' || cur === 'error')
  const a = live && featured !== null ? agents.find((x) => x.id === featured) : undefined
  return (
    <section className="sec anatomy" id="watch">
      <SecHead i="05" kicker="watch an agent decide" title="One agent, one page, live.">
        Every agent runs these six steps for every page. Below, one real agent is followed through them. Each line is what it reported.
      </SecHead>
      <div className="follow mono" key={visit}>
        <span className={connLed(conn)} />
        {live ? (
          <>
            following <b>{a ? `${a.code} ${a.name}` : '…'}</b>
            <span className="dim">{a?.url ? `→ ${a.url.replace(/^https?:\/\//, '').slice(0, 72)}` : ''}</span>
          </>
        ) : (
          <span>{CONN_TEXT[conn]}</span>
        )}
        {failed && <span className="tag" style={{ borderColor: 'var(--err)', color: 'var(--err)' }}>dropped</span>}
        {live && cur === 'store' && <span className="tag solid">kept</span>}
      </div>
      <ol className="steps">
        {STEPS.map((s, i) => {
          const state = i < at ? 'done' : i === at ? (failed ? 'fail' : 'now') : 'todo'
          return (
            <li key={s.st} className={`step step-${state}`}>
              <span className="step-i num">{String(i + 1).padStart(2, '0')}</span>
              <span className="step-name display">{s.name}</span>
              <span className="step-line">{s.line}</span>
              <span className="step-live mono">{live ? (msgs[s.st] ?? (state === 'todo' ? '' : '…')) : ''}</span>
            </li>
          )
        })}
      </ol>
      <div className="anatomy-cta">
        <Link to="/live" className="btn">
          {live ? `watch all ${fmtInt(agents.length)} agents at once →` : 'open the live view →'}
        </Link>
      </div>
    </section>
  )
}

/* ─── 06 the model ───────────────────────────────────────── */

function Model() {
  const loss = useSampled((s) => s.loss.slice(-160).map((p) => p.loss), 1500)
  const model = useSampled((s) => s.model, 1000)
  const sample = useSampled((s) => s.samples[0] ?? null, 2000)
  const live = useIsLive(1000)
  const trained = live && model.step > 0
  const vocab = live && model.vocab > 0 ? model.vocab : null
  return (
    <section className="sec sepia-t" id="model">
      <SecHead i="06" kicker="the model" title="Trained in public.">
        SEPIA is a small character-level language model trained only on pages the agents keep. Loss measures how wrong its next-character guesses are;
        lower is better. Its output is still mostly noise.
      </SecHead>
      <div className="sepia-grid">
        <div className="sepia-card panel">
          <div className="panel-head">
            <span>
              <b>training loss</b>
            </span>
            <span>step {trained ? fmtInt(model.step) : DASH}</span>
          </div>
          <div className="sepia-chart">
            {live && loss.length > 1 ? (
              <Spark data={loss} w={560} h={150} stroke="var(--fg)" />
            ) : (
              <div className="sepia-empty mono dim">{live ? 'no training steps yet' : 'no data — server not connected'}</div>
            )}
            <div className="sepia-loss num">{trained ? fmtFixed(model.loss, 3) : DASH}</div>
          </div>
          <div className="sepia-meta mono">
            <span>{live && model.params ? `${fmtInt(model.params)} parameters` : `${DASH} parameters`}</span>
            <span>random guessing: {vocab ? `ln ${vocab} = ${Math.log(vocab).toFixed(3)}` : DASH}</span>
          </div>
        </div>
        <div className="sepia-card panel">
          <div className="panel-head">
            <span>
              <b>latest sample</b>
            </span>
            <span>{live && sample ? `step ${fmtInt(sample.step)}` : DASH}</span>
          </div>
          <p className="sepia-sample mono">
            {!live ? 'no data — server not connected' : sample ? sample.text : `SEPIA writes its first sample after ${fmtInt(HP.sampleEvery)} training steps.`}
          </p>
          <Link to="/sepia" className="btn ghost sepia-link">
            try the model →
          </Link>
        </div>
      </div>
    </section>
  )
}

/* ─── 07 why an octopus ──────────────────────────────────── */

function WhyOctopus() {
  const total = useSampled((s) => (s.conn === 'live' ? s.stats.agentsTotal : null), 2000)
  return (
    <section className="paper" id="octopus">
      <div className="paper-inner">
        <div className="paper-i mono">[ 07 ] · design · independent agents, one server</div>
        <div className="paper-big display">{SECTORS.length}</div>
        <div className="paper-copy">
          <h2 className="display">arms. Each agent decides on its own.</h2>
          <p>
            An octopus arm senses and acts largely on its own while the brain sets direction. LUSCA is built the same way: each agent picks its next
            link and scores every page by itself. The LUSCA server only coordinates, keeps the corpus and trains the model. Added agents add capacity,
            and connected GPUs check more of the work.
          </p>
          <div className="paper-facts">
            <div>
              <span className="mono">{total === null ? DASH : fmtInt(total)}</span>
              <span>agents in total; anyone can add more</span>
            </div>
            <div>
              <span className="mono">1</span>
              <span>server that coordinates and keeps the INK ledger</span>
            </div>
            <div>
              <span className="mono">1</span>
              <span>model, trained on everything they keep</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ─── 08 questions ───────────────────────────────────────── */

function PayoutLine() {
  const { mode, failed } = usePayoutRules()
  return <>{sentence(payoutStatus(mode, failed))}</>
}

const FAQ: [string, ReactNode][] = [
  ['Is it free?', 'Yes. LUSCA sells nothing: no slot, no subscription, no token sale. You pay only for your own electricity.'],
  [
    'What is INK worth?',
    <>
      {INK_LINE} No amount is guaranteed: the pool depends on the treasury balance, which is funded by creator fees from the owner’s token. Status on
      this server: <PayoutLine /> <Link to="/earn">Treasury and payouts →</Link>
    </>,
  ],
  [
    'Do I need a wallet?',
    'Not to earn INK. A wallet is needed only to receive SOL: you sign one plain-text message to prove you own it. It is not a transaction and costs nothing. LUSCA never asks for a transaction, a private key or a seed phrase.',
  ],
  ['Will it slow down my computer?', 'It uses your GPU only while the Start earning tab is open and visible, and pauses as soon as you switch away. You can stop it any time.'],
  [
    'Which GPUs work?',
    'Any GPU in Chrome or Edge 113+, including laptop graphics. Faster cards land in deeper tiers and earn a bigger bonus. No WebGPU? A slower CPU mode still works.',
  ],
  [
    'How do the agents fetch pages?',
    <>
      Agents obey robots.txt and AI-training opt-outs (TDMRep headers, noai tags and robots rules aimed at AI-training bots), identify themselves as
      LuscaBot, and wait at least 2 seconds between requests to the same site. Any site can opt out. <Link to="/docs/ethics">Data ethics →</Link>
    </>,
  ],
]

function Questions() {
  return (
    <section className="sec faq" id="faq">
      <SecHead i="08" kicker="questions" title="Short answers." />
      <dl className="faq-grid">
        {FAQ.map(([q, a]) => (
          <div key={q} className="faq-item">
            <dt>{q}</dt>
            <dd>{a}</dd>
          </div>
        ))}
      </dl>
      <div className="faq-cta">
        <Link to="/node" className="btn primary lg">
          start earning →
        </Link>
        <Link to="/docs" className="btn ghost">
          read the docs
        </Link>
      </div>
    </section>
  )
}

/* ─── footer ─────────────────────────────────────────────── */

function Footer() {
  const { rules, mode, failed } = usePayoutRules()
  const status = mode === 'live' ? `Payouts every ${rules.everyHours} h (UTC)` : mode || failed ? payoutStatus(mode, failed) : null
  return (
    <footer className="foot">
      <div className="foot-links">
        <div>
          <div className="label">start</div>
          <Link to="/node">start earning</Link>
          <Link to="/earn">rewards</Link>
          <Link to="/agents">add an agent</Link>
        </div>
        <div>
          <div className="label">watch</div>
          <Link to="/live">live view</Link>
          <Link to="/agents">all agents</Link>
          <Link to="/sepia">the model</Link>
        </div>
        <div>
          <div className="label">learn</div>
          <Link to="/docs">docs</Link>
          <Link to="/docs/ethics">data ethics</Link>
          <Link to="/docs/neurons">how jobs are verified</Link>
        </div>
        <div className="foot-note mono">
          {INK_LINE} {status ? `${status}; no amount is guaranteed.` : 'No amount is guaranteed.'} LUSCA never asks for a transaction, a private key or a seed phrase.
          The agents honor robots.txt and identify themselves as LuscaBot.
        </div>
      </div>
      <div className="foot-word display" aria-hidden="true">
        LUSCA
      </div>
    </footer>
  )
}

export default function Landing() {
  useEffect(() => {
    document.title = 'LUSCA — open crypto corpus and verified GPU work'
  }, [])
  return (
    <div className="landing">
      <Hero />
      <HowItWorks />
      <StartEarning />
      <Tiers />
      <WhyMore />
      <WatchAgent />
      <Model />
      <WhyOctopus />
      <Questions />
      <Footer />
    </div>
  )
}
