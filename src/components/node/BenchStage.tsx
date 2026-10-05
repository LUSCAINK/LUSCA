import { useEffect, useState } from 'react'
import { ZONES, zoneFor } from '@shared/protocol'
import { useNeuron } from '@/lib/gpu'
import type { BenchProgress } from '@/lib/gpu'
import { Stage } from './Stage'
import type { StageState } from './Stage'
import { fmtFlop, fmtG, scrollToId } from './util'

interface Sample {
  g: number
  phase: BenchProgress['phase']
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

function phases(p: BenchProgress | null, cpu: boolean, done: boolean) {
  // [validate, warm-up, measure] progress, null = indeterminate, -1 = skipped
  if (done) return { validate: cpu ? -1 : 1, warm: 1, measure: 1, active: -1 }
  if (!p) return { validate: cpu ? -1 : 0, warm: 0, measure: 0, active: -1 }
  if (cpu) {
    const warm = p.pct >= 10 ? 1 : clamp01(p.pct / 10)
    return { validate: -1, warm, measure: clamp01((p.pct - 10) / 90), active: p.phase === 'measure' ? 2 : 1 }
  }
  if (p.phase === 'validate') return { validate: null, warm: 0, measure: 0, active: 0 }
  const warm = p.pct <= 14 ? clamp01((p.pct - 6) / 8) : 1
  const measure = p.pct > 14 ? clamp01((p.pct - 14) / 86) : 0
  return { validate: 1, warm, measure, active: p.phase === 'measure' ? 2 : p.phase === 'warmup' ? 1 : -1 }
}

function PhaseRow({ i, name, what, value, active }: { i: string; name: string; what: string; value: number | null; active: boolean }) {
  const skipped = value === -1
  const pct = value === null || skipped ? 0 : Math.round(value * 100)
  return (
    <div className={`ph ${active ? 'ph-on' : ''} ${value === 1 ? 'ph-done' : ''} ${skipped ? 'ph-skip' : ''}`}>
      <div className="ph-top">
        <span className="ph-i mono">{i}</span>
        <span className="ph-n mono">{name}</span>
        <span className="ph-w">{what}</span>
        <span className="ph-v num">{skipped ? 'n/a' : value === null ? '···' : `${pct}%`}</span>
      </div>
      <div
        className={`ph-bar ${value === null ? 'ph-ind' : ''}`}
        role="progressbar"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value === null || skipped ? undefined : pct}
      >
        <i style={{ transform: `scaleX(${value === null ? 1 : skipped ? 0 : value})` }} />
      </div>
    </div>
  )
}

function Scope({ samples }: { samples: Sample[] }) {
  const W = 600
  const H = 120
  if (samples.length < 2) {
    return (
      <svg className="scope" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1={H - 1} x2={W} y2={H - 1} className="scope-base" />
      </svg>
    )
  }
  const max = Math.max(...samples.map((s) => s.g)) * 1.08 || 1
  const x = (i: number) => (i / (samples.length - 1)) * W
  const y = (g: number) => H - 2 - (g / max) * (H - 8)
  const pts = samples.map((s, i) => `${x(i).toFixed(1)},${y(s.g).toFixed(1)}`).join(' ')
  const area = `0,${H} ${pts} ${W},${H}`
  return (
    <svg className="scope" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="scope-grid" />
      ))}
      <polygon points={area} className="scope-area" />
      <polyline points={pts} className="scope-line" vectorEffect="non-scaling-stroke" />
      {samples.map((s, i) =>
        s.phase === 'measure' ? <rect key={i} x={x(i) - 1} y={H - 5} width="2" height="5" className="scope-tick" /> : null,
      )}
    </svg>
  )
}

export function BenchStage({ state }: { state: StageState }) {
  const det = useNeuron((s) => s.detect)
  const bench = useNeuron((s) => s.bench)
  const prog = useNeuron((s) => s.benchProgress)
  const status = useNeuron((s) => s.status)
  const error = useNeuron((s) => s.error)
  const benchmark = useNeuron((s) => s.benchmark)
  const running = status === 'benchmarking'
  const looping = status === 'running' || status === 'paused'
  const cpuPath = bench ? bench.backend === 'cpu' : det ? !det.supported : false

  // Live trace of every reading the benchmark reports (straight from the store).
  const [samples, setSamples] = useState<Sample[]>([])
  useEffect(() => {
    let lastKey = ''
    return useNeuron.subscribe((s, prev) => {
      const p = s.benchProgress
      if (!p || p === prev.benchProgress) return
      if (p.phase === 'validate' && p.pct === 0) {
        lastKey = ''
        setSamples([])
        return
      }
      if (s.status !== 'benchmarking' || p.gflops === undefined || !Number.isFinite(p.gflops)) return
      const key = `${p.phase}:${p.pct.toFixed(2)}:${p.gflops.toFixed(3)}`
      if (key === lastKey) return
      lastKey = key
      const g = p.gflops
      setSamples((prevS) => (prevS.length > 160 ? prevS.slice(-160) : prevS).concat({ g, phase: p.phase }))
    })
  }, [])

  const live = running ? (prog?.gflops ?? 0) : (bench?.gflops ?? 0)
  const shown = live // measured values only, never eased in between
  const ph = phases(running ? prog : null, cpuPath, !running && !!bench)
  const n = running ? prog?.n : bench?.n
  const zone = bench ? zoneFor(bench.gflops) : null
  const zoneName = zone ? ZONES.find((z) => z.zone === zone)?.name : null
  const maxRun = bench ? Math.max(...bench.runs) : 1
  const sorted = bench ? bench.runs.slice().sort((a, b) => a - b) : []
  const median = bench?.gflops ?? 0

  const readoutLabel = running
    ? prog?.phase === 'measure'
      ? 'running median'
      : prog?.phase === 'warmup'
        ? 'warming up · estimate'
        : 'checking the answer'
    : bench
      ? 'median · final'
      : 'awaiting run'

  return (
    <Stage
      id="bench"
      n="2"
      title="10-second benchmark"
      kicker="A real math workload, timed on your GPU. The score (GFLOPS = billions of operations per second) sets your tier."
      state={state}
      lockedNote="waiting for step 1 · detect your GPU"
    >
      <div className="nd-grid bench-grid">
        <div className="nd-cell bench-read scan">
          <div className="panel-head">
            <span>
              <span className="hot">A</span>&nbsp;&nbsp;<b>Speed</b>
            </span>
            <span className="nd-meta">{cpuPath ? 'JS matmul · cpu' : 'WGSL tiled GEMM · fp32'}</span>
          </div>
          <div className="br-body">
            <div className="label br-lab" aria-live="polite">
              {readoutLabel}
            </div>
            <div className={`br-num num ${running ? 'br-live' : ''}`} aria-label={`${fmtG(live)} GFLOPS`}>
              {fmtG(shown)}
              <span className="br-unit">GFLOPS</span>
            </div>
            <div className="br-sub mono">
              {shown >= 1000 ? `= ${(shown / 1000).toFixed(2)} TFLOPS fp32` : 'billions of math operations per second'}
              {n ? ` · N=${n}` : ''}
            </div>
            <Scope samples={running || samples.length ? samples : []} />
            <div className="br-phases">
              <PhaseRow i="a" name="check" what={cpuPath ? 'gpu only' : 'gpu answer vs cpu answer'} value={ph.validate} active={ph.active === 0} />
              <PhaseRow i="b" name="warm-up" what="run until clocks settle" value={ph.warm} active={ph.active === 1} />
              <PhaseRow i="c" name="measure" what={cpuPath ? '6 timed runs' : '7 timed batches / size'} value={ph.measure} active={ph.active === 2} />
            </div>
          </div>
        </div>

        <div className="nd-cell bench-side">
          <div className="panel-head">
            <span>
              <span className="hot">B</span>&nbsp;&nbsp;<b>Timed runs</b>
            </span>
            <span className="nd-meta">{bench ? `${bench.runs.length} @ N=${bench.n}` : '—'}</span>
          </div>
          <div className="bs-act">
            <p className="nd-lede">
              {cpuPath
                ? 'No usable GPU, so a small matrix multiply is timed on the CPU instead. Honest, and slow.'
                : 'Your GPU’s answer is first checked against the CPU, then the GPU warms up and a large matrix multiply is timed several times. The median is your score.'}
            </p>
            <div className="nd-actions">
              <button type="button" className={`btn lg ${bench ? '' : 'primary'}`} onClick={() => void benchmark()} disabled={running || looping || state === 'locked'} aria-busy={running}>
                {running ? 'measuring…' : bench ? 'run again' : 'run benchmark'}
              </button>
              {bench && !running && (
                <button type="button" className="btn lg" onClick={() => scrollToId('zone')}>
                  next: your tier <span aria-hidden="true">↓</span>
                </button>
              )}
            </div>
            {looping && <p className="nd-note mono">stop earning first to run the benchmark again.</p>}
            {status === 'error' && error && (
              <p className="nd-err mono" role="alert">
                {error}
              </p>
            )}
          </div>
          <ol className="runs" aria-label="Timed batches">
            {bench ? (
              bench.runs.map((g, i) => {
                const isMed = Math.abs(g - median) < 1e-9 || (sorted.length % 2 === 0 && (g === sorted[sorted.length / 2] || g === sorted[sorted.length / 2 - 1]))
                return (
                  <li key={i} className={`run ${isMed ? 'run-med' : ''}`}>
                    <span className="run-i mono">#{i + 1}</span>
                    <span className="run-bar" aria-hidden="true">
                      <i style={{ width: `${(g / maxRun) * 100}%` }} />
                    </span>
                    <span className="run-v num">{fmtG(g)}</span>
                  </li>
                )
              })
            ) : (
              <li className="run-empty mono dimmer">{running ? 'timed batches land here when measuring finishes' : 'no runs yet'}</li>
            )}
          </ol>
          <dl className="nd-kv bs-sum">
            <div>
              <dt>median</dt>
              <dd className={bench ? 'hot' : undefined}>{bench ? `${fmtG(bench.gflops)} GFLOPS` : '—'}</dd>
            </div>
            <div>
              <dt>matrix</dt>
              <dd>{bench ? `${bench.n} × ${bench.n} · ${fmtFlop(2 * bench.n ** 3).v} ${fmtFlop(2 * bench.n ** 3).u} each` : '—'}</dd>
            </div>
            <div>
              <dt>timing</dt>
              <dd>{bench ? bench.timing : '—'}</dd>
            </div>
            <div>
              <dt>wall time</dt>
              <dd>{bench ? `${(bench.ms / 1000).toFixed(1)} s` : '—'}</dd>
            </div>
            <div>
              <dt>tier</dt>
              <dd>{zone ? `${zone} · ${zoneName}` : '—'}</dd>
            </div>
          </dl>
        </div>
      </div>
    </Stage>
  )
}
