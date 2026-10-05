import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useNeuron } from '@/lib/gpu'
import { DesktopPanel } from './DesktopPanel'
import { SecHead } from './Stage'
import { deviceName } from './util'

const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator

/** What you need: browser, GPU, the CPU path, and the desktop app alternative. */
export function Requirements() {
  const det = useNeuron((s) => s.detect)
  const webgpu = det ? det.supported : hasWebGpu
  const rows: { k: string; v: string; you: string; ok: boolean | null }[] = [
    {
      k: 'Browser',
      v: 'Chrome or Edge, version 113 or newer. These ship WebGPU, which lets a web page use your graphics card.',
      you: webgpu ? 'this browser has WebGPU' : 'no WebGPU in this browser',
      ok: webgpu,
    },
    {
      k: 'Graphics card',
      v: 'Any GPU works. Integrated graphics are fine; they usually land in the EPI tier.',
      you: det ? (det.supported ? deviceName(det, false) : 'none available to the browser') : 'checked when you start',
      ok: det ? det.supported : null,
    },
    {
      k: 'No WebGPU?',
      v: 'You can still earn. LUSCA switches to the CPU path automatically: slower, EPI tier.',
      you: webgpu ? 'not needed' : 'will be used',
      ok: null,
    },
    {
      k: 'This tab',
      v: 'Keep it open and visible while you earn. Work pauses when the tab is hidden and stops when you close it.',
      you: 'nothing to install',
      ok: null,
    },
  ]
  return (
    <section id="requirements" className="nd-sec" aria-labelledby="req-h">
      <SecHead id="req-h" kicker="requirements" title="Requirements" sub="A modern browser and any GPU. No install, no account." />
      <ul className="req-list">
        {rows.map((r) => (
          <li key={r.k} className="req">
            <span className="req-k mono">{r.k}</span>
            <span className="req-v">{r.v}</span>
            <span className={`req-you mono ${r.ok === true ? 'req-ok' : r.ok === false ? 'req-no' : ''}`}>
              <span className="req-mark" aria-hidden="true">
                {r.ok === true ? '■' : r.ok === false ? '□' : '·'}
              </span>
              <span className="sr-only">Your setup: </span>
              {r.you}
            </span>
          </li>
        ))}
      </ul>
      <div className="req-desk">
        <h3 className="req-desk-h display">Prefer the terminal? Run the desktop app</h3>
        <p className="req-desk-p">
          Same jobs, same checks, same INK. It runs on your CPU from the LUSCA repo (Node 20+). Set a name, copy the command, paste it into a terminal.
        </p>
        <DesktopPanel />
      </div>
    </section>
  )
}

const QA: { q: string; a: ReactNode }[] = [
  {
    q: 'Does it touch my wallet?',
    a: 'Earning INK needs no wallet. To receive SOL, you verify a wallet by signing one plain-text message that proves you own the address. It is not a transaction and costs nothing. LUSCA never asks for a transaction, a private key or a seed phrase.',
  },
  {
    q: 'When does it run?',
    a: 'Only while this tab is open and visible. Switch tabs and it pauses; close the tab and it stops. It uses your GPU the way a game does, so you can pause at any time.',
  },
  {
    q: 'What does it send?',
    a: 'Job results (row numbers, similarity scores and time taken), your tier and benchmark score, your GPU name and CPU thread count, a random device ID, and your wallet address and sign-in token if you verify a wallet. Detection and the benchmark run in this tab; nothing is sent until jobs start. No files, no browsing data.',
  },
  {
    q: 'How is INK paid?',
    a: (
      <>
        INK — points for verified GPU work. Each payout period, the payout pool is split by INK and paid in SOL to verified wallets. The amount depends on the
        pool and on everyone’s INK that period; nothing is guaranteed. <Link to="/earn">See how rewards are paid →</Link>
      </>
    ),
  },
]

/** Is it safe? Four direct answers. */
export function Safety() {
  return (
    <section id="safety" className="nd-sec" aria-labelledby="safe-h">
      <SecHead id="safe-h" kicker="safety" title="Is it safe?" sub="Four straight answers." />
      <dl className="safe-grid">
        {QA.map((x, i) => (
          <div key={x.q} className="safe">
            <dt className="safe-q">
              <span className="safe-i mono" aria-hidden="true">
                {String.fromCharCode(65 + i)}
              </span>
              {x.q}
            </dt>
            <dd className="safe-a">{x.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
