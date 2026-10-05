import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { ZONES } from '@shared/protocol'
import { useSampled } from '@/lib/hooks'
import { CONN_TEXT } from '@/lib/store'
import { fmtAgo, fmtCompact, fmtGflops, fmtInt } from '@/lib/format'
import { shortAddr } from '@/lib/wallet'
import { usePayouts } from '@/lib/payouts'
import { Kicker, NextStep, OnThisPage, Terms } from '@/components/docs/pagekit'
import { TreasuryPayouts } from '@/components/treasury/TreasuryPayouts'
import '@/components/obs/parts.css'
import './earn.css'

/* ─── model ──────────────────────────────────────────────── */

// Proposed treasury split — a design, not live. Live payouts follow the server's payout rules
// (GET /api/payouts → rules), shown in the Treasury & payouts section.
const SPLIT = [
  { k: 'contributors', pct: 55, d: 'paid in SOL each payout period, split by credits' },
  { k: 'compute', pct: 20, d: 'trains SEPIA-1+, pays the coordinator' },
  { k: 'buyback & burn', pct: 15, d: 'market buys of the owner’s token, burned on-chain' },
  { k: 'ops', pct: 10, d: 'infra, audits, legal' },
]

const SOURCES = [
  { k: 'trading fees', d: 'creator fees on the owner’s token, routed to the treasury wallet', live: true },
  { k: 'dataset licenses', d: 'clean, deduped, license-tagged crypto corpus', live: false },
  { k: 'inference api', d: 'SEPIA-1+ served by neurons, paid per token', live: false },
  { k: 'priority ingestion', d: 'projects pay to be fetched first — never to pass taste', live: false },
  { k: 'compute resale', d: 'idle neuron capacity for embedding jobs', live: false },
]

// The spider model: public API + on-chain data, 2026-10-04 23:10 UTC. A slot costs 100k tokens
// (≈1.97 SOL ≈ $239 then; it moves with price). 40% of creator fees per 12-hour round is split among
// eligible, uncapped slots (75 of 99 at the snapshot). Earning stops at 2× the SOL burned.
const SPIDER = { share: 0.4, costUsd: 239, cap: 2, maxSlots: 100, eligible: 0.8 }

function Flow() {
  // left: sources, center: treasury, right: splits — a brutalist sankey
  const W = 1000
  const H = 360
  const lx = 210
  const cx = 500
  const rx = 790
  const sy = (i: number) => 40 + i * 70
  const ry = (i: number) => 40 + i * 93
  return (
    <svg
      className="flow"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Proposed design: five revenue sources flow into the treasury and out to four destinations. Only trading fees are live today."
    >
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--hot)" strokeWidth="1" opacity="0.5" />
        </pattern>
      </defs>
      {SOURCES.map((s, i) => (
        <g key={s.k}>
          <path d={`M ${lx} ${sy(i)} C ${lx + 140} ${sy(i)}, ${cx - 140} ${H / 2}, ${cx - 40} ${H / 2}`} className={`fl ${s.live ? 'fl-live' : 'fl-plan'}`} />
          <rect x={lx - 8} y={sy(i) - 4} width="8" height="8" className={`fl-node ${s.live ? 'fl-node-hot' : ''}`} />
          <text x={lx - 18} y={sy(i) + 4} textAnchor="end" className={`fl-t ${s.live ? '' : 'fl-t-plan'}`}>
            {s.k}
          </text>
        </g>
      ))}
      <rect x={cx - 40} y={H / 2 - 60} width="80" height="120" fill="url(#hatch)" stroke="var(--hot)" />
      <text x={cx} y={H / 2 - 72} textAnchor="middle" className="fl-t fl-hot">
        treasury
      </text>
      {SPLIT.map((s, i) => (
        <g key={s.k}>
          <path
            d={`M ${cx + 40} ${H / 2 - 45 + i * 30} C ${cx + 160} ${H / 2 - 45 + i * 30}, ${rx - 160} ${ry(i)}, ${rx} ${ry(i)}`}
            className={`fl fl-out ${i === 0 ? 'fl-main' : ''}`}
            style={{ strokeWidth: Math.max(1, s.pct / 4) }}
          />
          <rect x={rx} y={ry(i) - 4} width="8" height="8" className={`fl-node ${i === 0 ? 'fl-node-hot' : ''}`} />
          <text x={rx + 18} y={ry(i) + 4} className={`fl-t ${i === 0 ? 'fl-hot' : ''}`}>
            {s.pct}% {s.k}
          </text>
        </g>
      ))}
    </svg>
  )
}

function Slider({ label, value, min, max, step, onChange, fmt }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt: (v: number) => string }) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <label className="sl">
      <span className="sl-top">
        <span className="label">{label}</span>
        <span className="sl-v num">{fmt(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ ['--p' as string]: `${pct}%` }} />
    </label>
  )
}

function Calculator() {
  const [volume, setVolume] = useState(5_000_000)
  const [feeBps, setFeeBps] = useState(95)
  const [other, setOther] = useState(2_000)
  const [people, setPeople] = useState(100)
  const [zone, setZone] = useState(2)
  const [kwh, setKwh] = useState(0.15)

  const r = useMemo(() => {
    const fees = volume * (feeBps / 10_000)
    // spider: 40% of fees, equal split across the eligible, uncapped share of sold slots
    const slots = Math.max(1, Math.round(Math.min(people, SPIDER.maxSlots) * SPIDER.eligible))
    const spiderDaily = (fees * SPIDER.share) / Math.max(1, slots)
    const spiderLifetime = SPIDER.costUsd * SPIDER.cap
    const spiderDays = spiderDaily > 0 ? spiderLifetime / spiderDaily : Infinity
    // lusca: 55% of (fees + other revenue), split by verified credits. credits/sec ∝ your throughput × zone bonus;
    // the network is assumed to average a BATHY-class neuron (~2.7 TFLOPS effective, bonus 1.3).
    const TYP_GFLOPS = [200, 900, 2700, 6500, 14000]
    const avg = TYP_GFLOPS[2] * ZONES[2].bonus
    const yourShare = (TYP_GFLOPS[zone] * ZONES[zone].bonus) / (avg * Math.max(1, people))
    const luscaDaily = 0.55 * (fees + other) * Math.min(1, yourShare)
    const watts = [60, 150, 220, 350, 600][zone]
    const power = (watts / 1000) * 24 * kwh
    return { fees, spiderDaily, spiderDays, luscaDaily, power, luscaNet: luscaDaily - power, slots }
  }, [volume, feeBps, other, people, zone, kwh])

  const usd = (v: number) => (Math.abs(v) >= 1000 ? `$${fmtCompact(v, 1)}` : `$${v.toFixed(2)}`)

  return (
    <div className="calc">
      <div className="calc-in panel">
        <div className="panel-head">
          <span>
            <span className="hot">C</span>&nbsp;&nbsp;<b>Inputs</b>
          </span>
          <span>same market, two models</span>
        </div>
        <div className="calc-sliders">
          <Slider label="daily trading volume" value={volume} min={100_000} max={40_000_000} step={100_000} onChange={setVolume} fmt={(v) => `$${fmtCompact(v, 1)}`} />
          <Slider label="creator fee rate" value={feeBps} min={5} max={125} step={5} onChange={setFeeBps} fmt={(v) => `${(v / 100).toFixed(2)}%`} />
          <Slider label="non-trading revenue / day" value={other} min={0} max={50_000} step={500} onChange={setOther} fmt={(v) => `$${fmtCompact(v, 1)}`} />
          <Slider label="participants" value={people} min={10} max={5000} step={10} onChange={setPeople} fmt={(v) => fmtInt(v)} />
          <div className="sl">
            <span className="sl-top">
              <span className="label">your gpu tier</span>
              <span className="sl-v num">
                {ZONES[zone].zone} · ×{ZONES[zone].bonus.toFixed(2)} credits
              </span>
            </span>
            <div className="zone-pick" role="radiogroup" aria-label="GPU tier">
              {ZONES.map((z, i) => (
                <button key={z.zone} role="radio" aria-checked={zone === i} className={zone === i ? 'on' : ''} onClick={() => setZone(i)}>
                  {z.zone}
                </button>
              ))}
            </div>
          </div>
          <Slider label="electricity $/kWh" value={kwh} min={0.03} max={0.45} step={0.01} onChange={setKwh} fmt={(v) => `$${v.toFixed(2)}`} />
        </div>
      </div>

      <div className="calc-out">
        <div className="co co-them">
          <div className="co-h">
            <span className="label">the spider model</span>
            <span className="tag">buy a slot</span>
          </div>
          <div className="co-big num">{usd(r.spiderDaily)}</div>
          <div className="co-sub mono">per slot / day</div>
          <div className="kv">
            <span>capital burned</span>
            <span>~${SPIDER.costUsd} per slot · moves with price</span>
          </div>
          <div className="kv">
            <span>paid slots</span>
            <span>
              {r.slots} eligible of {Math.min(people, SPIDER.maxSlots)} sold
              {people > SPIDER.maxSlots ? ' · sold out' : ''}
            </span>
          </div>
          <div className="kv">
            <span>ceiling</span>
            <span>earning stops at 2×{Number.isFinite(r.spiderDays) ? ` · ~${r.spiderDays.toFixed(1)} days at this volume` : ''}</span>
          </div>
        </div>
        <div className="co co-us">
          <div className="co-h">
            <span className="label">lusca</span>
            <span className="tag hot">do work</span>
          </div>
          <div className="co-big num hot">{usd(r.luscaNet)}</div>
          <div className="co-sub mono">per contributor / day, after power</div>
          <div className="kv">
            <span>capital burned</span>
            <span>$0 · you already own the gpu</span>
          </div>
          <div className="kv">
            <span>gross / power</span>
            <span>
              {usd(r.luscaDaily)} / −{usd(r.power)}
            </span>
          </div>
          <div className="kv">
            <span>ceiling</span>
            <span>none · paid while you work</span>
          </div>
        </div>
        <p className="calc-note mono">
          model, not a promise. the lusca side is the proposed mainnet design: it assumes a typical GPU for your tier in a network averaging BATHY-tier neurons (credits ∝ throughput × tier bonus). spider figures use the live rules from public api and on-chain data on 4 oct 2026 (40% of creator fees, split among eligible uncapped slots, 100 slots, earning stops at 2×, ~$239 burn). those rules may have changed since.
        </p>
      </div>
    </div>
  )
}

/* ─── page ───────────────────────────────────────────────── */

export default function Earn() {
  useEffect(() => {
    document.title = 'Rewards — LUSCA'
  }, [])
  const neurons = useSampled((s) => s.neurons.slice().sort((a, b) => b.ink - a.ink), 1000)
  const ink = useSampled((s) => s.ink.slice(0, 14), 500)
  const stats = useSampled((s) => s.stats, 1000)
  const conn = useSampled((s) => s.conn, 1000)
  const live = conn === 'live'
  // payout period length comes from the server's rules; until it answers, the copy names no number
  const everyHours = usePayouts().overview?.rules.everyHours

  const jump = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    const el = document.getElementById(id)
    if (!el) return
    e.preventDefault()
    el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  }

  return (
    <div className="earn-page">
      <header className="ep-hero">
        <Kicker n="03" name="Rewards" className="ep-i" />
        <div className="ep-hl">
          <h1 className="display ep-h">
            Credits and
            <br />
            SOL payouts
          </h1>
          <p className="ep-lede">
            Verified GPU work earns credits — your share of each SOL payout. Each payout period, the payout pool is split by credits and paid in SOL to verified wallets.
          </p>
          <div className="ep-cta">
            <Link to="/node" className="btn primary lg">
              Start earning <span aria-hidden="true">→</span>
            </Link>
            <a href="#ep-treasury" className="btn lg" onClick={jump('ep-treasury')}>
              Treasury &amp; payouts <span aria-hidden="true">↓</span>
            </a>
          </div>
        </div>
        <div className="ep-cmp">
          <div className="ep-c">
            <div className="label">of every $1 of creator fees, routed to participants</div>
            <div className="ep-bars">
              <div className="ep-bar">
                <span className="ep-bar-l mono">spider · live rule</span>
                <span className="ep-bar-t">
                  <i style={{ width: '40%' }} />
                </span>
                <span className="ep-bar-v num">$0.40</span>
              </div>
              <div className="ep-bar us">
                <span className="ep-bar-l mono">lusca · proposal</span>
                <span className="ep-bar-t">
                  <i style={{ width: '55%' }} />
                </span>
                <span className="ep-bar-v num">$0.55</span>
              </div>
            </div>
            <p className="ep-p">
              <b>Spider</b> is the buy-a-slot model: burn ~${SPIDER.costUsd} of tokens for a slot that shares 40% of trading fees until it has earned 2×. The
              LUSCA bar is the proposed revenue split: 55% to contributors, from fees and planned data products. Payouts running today follow the rules under{' '}
              <a href="#ep-treasury" onClick={jump('ep-treasury')}>
                Treasury &amp; payouts
              </a>
              .
            </p>
          </div>
        </div>
        <OnThisPage
          className="ep-otp"
          links={[
            { id: 'ep-how', label: 'How you earn' },
            { id: 'ep-treasury', label: 'Treasury & payouts' },
            { id: 'ep-estimate', label: 'Estimate your earnings' },
            { id: 'ep-board', label: 'Who’s earning now' },
          ]}
        />
      </header>

      <Terms keys={['ink', 'neuron', 'tier']} />

      <section id="ep-how" className="ep-sec pk-anchor" aria-labelledby="ep-how-h">
        <div className="ep-sh">
          <h2 id="ep-how-h" className="display">
            How you earn
          </h2>
          <p>One way to earn is live today: run a GPU. Two more are planned. Credits are given only for work the LUSCA server has verified.</p>
        </div>
        <div className="rules">
          <div className="rule rule-live">
            <span className="rule-k">
              <b>Run a GPU</b>
              <span className="mono">neuron</span>
            </span>
            <span className="rule-f mono">credits = verified GFLOP × 10 × (1 + 0.15 × tier)</span>
            <span className="rule-d">
              Your GPU computes SEPIA training gradients on batches the server picks, and checks fetched pages for near-duplicates. The server checks
              every result and recomputes a share of training jobs in full; training credits are pending until that audit passes and are forfeited if it
              fails. A mismatch earns zero, and 3 consecutive failed jobs disconnect the GPU for a cooldown. Tier runs from 0 (EPI) to 4 (HADAL).
            </span>
            <span className="rule-s">
              <span className="tag rule-live-tag">live now</span>
              <Link to="/node" className="rule-go mono">
                start →
              </Link>
            </span>
          </div>
          <div className="rule rule-plan">
            <span className="rule-k">
              <b>Suggest a site</b>
              <span className="mono">scout</span>
            </span>
            <span className="rule-f mono">credits = Σ taste score × log₁₀(tokens) per kept page from your site</span>
            <span className="rule-d">
              Point the agents at a crypto site they have not found. If its pages pass the taste score and are kept, you earn credits. Agents you add on the{' '}
              <Link to="/agents">Agents</Link> page do not earn credits.
            </span>
            <span className="rule-s">
              <span className="tag">planned</span>
            </span>
          </div>
          <div className="rule rule-plan">
            <span className="rule-k">
              <b>Flag bad pages</b>
              <span className="mono">reader</span>
            </span>
            <span className="rule-f mono">credits = confirmed flags × severity</span>
            <span className="rule-d">
              Flag junk sources, license problems or wrong taste scores. Flags confirmed by independent reviewers will earn credits; wrong flags will cost
              reputation.
            </span>
            <span className="rule-s">
              <span className="tag">planned</span>
            </span>
          </div>
        </div>

        <div className="paid">
          <h3 className="label paid-h">How rewards are paid</h3>
          <ol className="paid-l">
            <li>
              <span className="num hot">1</span>
              <p>
                <b>Do verified work.</b> Every job that passes the server’s checks adds credits; training credits count once an audit confirms them. Earning needs no wallet, no slot purchase and no sign-up; you stop earning
                when you stop contributing.
              </p>
            </li>
            <li>
              <span className="num hot">2</span>
              <p>
                <b>Verify a wallet to receive SOL.</b> Sign one plain-text message — not a transaction; it costs nothing. LUSCA never asks for transactions,
                private keys or seed phrases.
              </p>
            </li>
            <li>
              <span className="num hot">3</span>
              <p>
                <b>Split by credits each payout period.</b> {everyHours ? `Every ${everyHours} h (UTC), the` : 'Each period, the'} payout pool is split by the credits
                each verified wallet earned in that period and paid in SOL. Ten wallets on one GPU earn what one wallet would.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section id="ep-treasury" className="ep-sec pk-anchor" aria-labelledby="ep-treasury-h">
        <div className="ep-sh">
          <h2 id="ep-treasury-h" className="display">
            Treasury &amp; payouts
          </h2>
          <p>
            Read from the LUSCA server, which keeps the payout ledger and reads the treasury balance from Solana. Every transfer links to its transaction on
            Solscan.
          </p>
        </div>
        <TreasuryPayouts />
      </section>

      <section id="ep-money" className="ep-sec pk-anchor" aria-labelledby="ep-money-h">
        <div className="ep-sh">
          <h2 id="ep-money-h" className="display">
            Where the money comes from
          </h2>
          <p>
            Live today: creator fees from the owner’s token, routed to the treasury wallet. LUSCA does not launch tokens. The diagram is the proposed design —
            four more revenue sources and a fixed split with 55% to contributors. It is not live; payouts today follow the payout rules above.
          </p>
        </div>
        <div className="panel ep-flow">
          <Flow />
          <div className="ep-legend">
            {SOURCES.map((s) => (
              <div key={s.k}>
                <span className="ep-legend-k">
                  <b>{s.k}</b>
                  <span className={`tag ${s.live ? 'hot' : ''}`}>{s.live ? 'live' : 'planned'}</span>
                </span>
                <span>{s.d}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="ep-estimate" className="ep-sec pk-anchor" aria-labelledby="ep-estimate-h">
        <div className="ep-sh">
          <h2 id="ep-estimate-h" className="display">
            Estimate your earnings
          </h2>
          <p>Move the sliders. Same market, two models: LUSCA versus the buy-a-slot spider model. An estimate, not a promise.</p>
        </div>
        <Calculator />
      </section>

      <section id="ep-board" className="ep-sec pk-anchor" aria-labelledby="ep-board-h">
        <div className="ep-sh">
          <h2 id="ep-board-h" className="display">
            Who’s earning now
          </h2>
          <p>
            {live
              ? `Live from the coordinator. ${fmtInt(stats.jobsVerified)} jobs verified · ${fmtCompact(stats.inkIssued)} credits issued so far.`
              : `${CONN_TEXT[conn]} — jobs verified · — credits issued so far.`}
          </p>
        </div>
        <div className="board">
          <div className="panel">
            <div className="panel-head">
              <span>
                <span className="hot">L</span>&nbsp;&nbsp;<b>Leaderboard</b>
              </span>
              <span>by credits</span>
            </div>
            <div className="lb">
              <div className="lb-row lb-head mono">
                <span>#</span>
                <span>neuron</span>
                <span>tier</span>
                <span>gflops</span>
                <span>verified</span>
                <span>credits</span>
              </div>
              {live &&
                neurons.slice(0, 12).map((n, i) => (
                  <div key={n.id} className="lb-row mono">
                    <span className="dimmer">{String(i + 1).padStart(2, '0')}</span>
                    <span className="lb-name">{n.wallet ? shortAddr(n.wallet) : n.label}</span>
                    <span className={n.zone === 'HADAL' || n.zone === 'ABYSSO' ? 'hot' : ''}>{n.zone}</span>
                    <span>{fmtGflops(n.gflops)}</span>
                    <span>{fmtInt(n.verified)}</span>
                    <span className="lb-ink">{n.ink.toFixed(2)}</span>
                  </div>
                ))}
              {live && !neurons.length && (
                <div className="lb-empty">
                  <span className="label">{stats.jobsVerified > 0 ? 'no GPU connected right now' : 'no GPUs connected yet'}</span>
                  <Link to="/node" className="btn primary">
                    {stats.jobsVerified > 0 ? 'connect yours' : 'be the first'} <span aria-hidden="true">→</span>
                  </Link>
                </div>
              )}
              {!live && (
                <div className="lb-empty">
                  <span className="label">{CONN_TEXT[conn]}</span>
                </div>
              )}
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">
              <span>
                <span className="hot">I</span>&nbsp;&nbsp;<b>Credits earned</b>
              </span>
              <span>newest first</span>
            </div>
            <ol className="inkfeed">
              {live &&
                ink.map((e) => (
                  <li key={e.jobId} className={e.verified ? '' : 'bad'}>
                    <span className="mono dimmer">{fmtAgo(e.ts)}</span>
                    <span className="mono">{e.verified ? `+${e.ink.toFixed(2)}` : '0.00'}</span>
                    <span className="if-r">{e.reason}</span>
                  </li>
                ))}
              {(!live || !ink.length) && (
                <li className={`label if-empty${live && stats.jobsVerified > 0 ? ' if-idle' : ''}`}>
                  {!live
                    ? CONN_TEXT[conn]
                    : stats.jobsVerified > 0
                      ? `No GPU connected right now · ${fmtInt(stats.jobsVerified)} jobs verified so far`
                      : 'Waiting for the first verified job…'}
                </li>
              )}
            </ol>
          </div>
        </div>
      </section>

      <NextStep
        text="Plug your GPU in from this browser tab. No install and no account. A wallet signature is needed only to receive SOL."
        secondary={{ to: '/docs/neurons', label: 'How checking works' }}
      />

      <section className="ep-fine" aria-label="Fine print">
        <div className="mono">
          <b>Fine print.</b> Credits are points for verified GPU work: your share of the payout pool. Payouts are made in SOL. Each payout period, the payout
          pool is split by credits and paid in SOL to verified wallets. Credits are not a token. Payout amounts depend on the treasury balance and on the
          credits earned by all verified wallets in the period; no amount is promised or
          guaranteed. The pool is funded by creator fees from the owner’s token, routed to the treasury wallet; LUSCA does not launch tokens. The treasury
          split and the additional revenue sources shown above are a proposal and are not live. Nothing here is financial advice.
        </div>
      </section>
    </div>
  )
}
