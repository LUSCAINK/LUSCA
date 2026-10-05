import { ZONES } from '@shared/protocol'
import { useNeuron } from '@/lib/gpu'
import { fmtInt } from '@/lib/format'
import { SecHead } from './Stage'
import { STEP_NAMES, usePhase } from './flow'
import { deviceName, fmtG, scrollToId } from './util'

type StepState = 'done' | 'working' | 'next' | 'waiting'

const STATE_TEXT: Record<StepState, string> = {
  done: 'done',
  working: 'working',
  next: 'next',
  waiting: 'waiting',
}

const LINES = [
  'Your browser reports which graphics card it can use. This runs locally; nothing is sent until jobs start.',
  'A real math workload is timed on your GPU to measure its speed.',
  'Your speed sets your tier. Deeper tier = bigger jobs + a bigger INK bonus.',
  'Your GPU computes SEPIA training gradients on batches the server picks. The server checks each gradient, audits a share in full, applies them to the model and credits INK.',
]

const IDS = ['detect', 'bench', 'zone', 'dive']

/** "What happens when you press start": the four steps, each with its live state. */
export function HowSteps() {
  const status = useNeuron((s) => s.status)
  const det = useNeuron((s) => s.detect)
  const bench = useNeuron((s) => s.bench)
  const zone = useNeuron((s) => s.zone)
  const verified = useNeuron((s) => s.verified)
  const jobs = useNeuron((s) => s.jobs)
  const backend = useNeuron((s) => s.backend)
  const prog = useNeuron((s) => s.benchProgress)
  const { phase, step } = usePhase()
  const running = status === 'running' || status === 'paused'
  const zinfo = ZONES.find((z) => z.zone === zone)

  const done = [!!det, !!bench, !!bench && !!zinfo, running]
  const working = [
    status === 'detecting' || (phase === 'starting' && step === 1),
    status === 'benchmarking',
    phase === 'starting' && step === 3,
    phase === 'starting' && step === 4,
  ]
  // step 4 is never "done" while it runs: it is the part that earns
  if (status === 'running') working[3] = true
  const firstOpen = done.findIndex((d, i) => !d && !working[i])
  const states: StepState[] = done.map((d, i) => (working[i] ? 'working' : d ? 'done' : i === firstOpen ? 'next' : 'waiting'))
  const stateText = (i: number) => (i === 3 && status === 'running' ? 'earning' : i === 3 && status === 'paused' ? 'paused' : STATE_TEXT[states[i]])
  const pct = status === 'benchmarking' && prog ? Math.round(Math.max(0, Math.min(100, prog.pct))) : 0

  const values = [
    det ? (det.supported ? deviceName(det, false) : 'no WebGPU · CPU path') : 'not checked yet',
    bench ? `${fmtG(bench.gflops)} GFLOPS${backend === 'cpu' || bench.backend === 'cpu' ? ' · cpu' : ''}` : status === 'benchmarking' ? `measuring · ${pct}%` : 'not measured yet',
    zinfo ? `${zinfo.zone} · ×${zinfo.bonus.toFixed(2)} INK bonus` : 'not set yet',
    running ? `${status === 'paused' ? 'paused' : 'earning'} · ${fmtInt(verified)} verified` : jobs > 0 ? `stopped · ${fmtInt(verified)} verified` : 'not started yet',
  ]

  return (
    <section id="how" className="nd-sec nd-how" aria-labelledby="how-h">
      <SecHead
        id="how-h"
        kicker="how it works"
        title="What happens when you press start"
        sub="Four steps, in order. The first three take about 15 seconds; then your GPU earns until you stop."
      />
      <ol className="how-steps">
        {STEP_NAMES.map((name, i) => (
          <li key={name} className={`how-step how-${states[i]}`} aria-current={states[i] === 'working' ? 'step' : undefined}>
            <div className="how-top">
              <span className="how-n display" aria-hidden="true">
                {i + 1}
              </span>
              <span className="how-st mono">
                <span className={`led ${states[i] === 'working' ? 'on pulse' : states[i] === 'done' ? 'white' : ''}`} aria-hidden="true" />
                {stateText(i)}
              </span>
            </div>
            <h3 className="how-t">
              <span className="sr-only">Step {i + 1}: </span>
              {name}
            </h3>
            <p className="how-l">{LINES[i]}</p>
            <div className="how-v mono">{values[i]}</div>
            <div className="how-bar" aria-hidden="true">
              <i style={{ transform: `scaleX(${states[i] === 'done' ? 1 : i === 1 && status === 'benchmarking' ? pct / 100 : 0})` }} />
            </div>
            <a
              className="how-more mono"
              href={`#${IDS[i]}`}
              onClick={(e) => {
                e.preventDefault()
                scrollToId(IDS[i])
              }}
            >
              details <span aria-hidden="true">↓</span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  )
}
