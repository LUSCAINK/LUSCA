// DISTRIBUTED TRAINING — live counters from ModelInfo (GPU steps vs server steps,
// audits, contributors). Every value comes from the server; missing fields show "—".
import type { ReactNode } from 'react'
import { useSampled } from '@/lib/hooks'
import { fmtCompact, fmtInt } from '@/lib/format'

/** Training fields added to ModelInfo by the GPU-training protocol. Read defensively:
 *  an older server omits them and the tiles fall back to "—". */
type TrainFields = {
  version?: number
  gpuSteps?: number
  serverSteps?: number
  gpuSamples?: number
  contributors24h?: number
  audits?: { ok: number; failed: number }
  gpuStepsPerMin?: number
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function Distributed() {
  const model = useSampled((s) => s.model, 500)
  const conn = useSampled((s) => s.conn, 500)
  const live = conn === 'live'
  // works whether or not the local ModelInfo type already declares the training fields
  const t = model as unknown as TrainFields

  const version = live ? num(t.version) : null
  const gpu = live ? num(t.gpuSteps) : null
  const cpu = live ? num(t.serverSteps) : null
  const samples = live ? num(t.gpuSamples) : null
  const people = live ? num(t.contributors24h) : null
  const ok = live && t.audits ? num(t.audits.ok) : null
  const failed = live && t.audits ? num(t.audits.failed) : null
  const rate = live ? num(t.gpuStepsPerMin) : null
  const total = gpu !== null && cpu !== null ? gpu + cpu : null
  const share = total ? (gpu ?? 0) / total : null
  const auditTotal = ok !== null && failed !== null ? ok + failed : null

  return (
    <div className="sp-dist">
      <div className="sp-dist-bar" role="img" aria-label={share === null ? 'GPU share of applied steps: no data' : `GPU share of applied steps: ${(share * 100).toFixed(1)}%`}>
        <div className="sp-dist-bar-h mono">
          <span>
            <span className="sw sw-gpu" /> GPU neurons {gpu === null ? '—' : fmtInt(gpu)}
          </span>
          <span className="dim">{share === null ? 'share —' : `${(share * 100).toFixed(1)}% of applied steps`}</span>
          <span>
            server CPU {cpu === null ? '—' : fmtInt(cpu)} <span className="sw sw-cpu" />
          </span>
        </div>
        <div className={`sp-dist-track ${share === null ? 'is-empty' : ''}`}>
          <span className="sp-dist-fill" style={{ width: share === null ? '0%' : `${Math.max(0, Math.min(1, share)) * 100}%` }} />
        </div>
      </div>

      <div className="sp-dist-grid">
        <Cell label="weights version" value={version === null ? null : fmtInt(version)} sub="one version per applied update" />
        <Cell label="GPU steps / min" value={rate === null ? null : rate < 10 ? rate.toFixed(1) : fmtInt(rate)} sub="gradients applied, last minute" hot />
        <Cell label="GPU samples" value={samples === null ? null : fmtCompact(samples)} sub="(context, next char) pairs" />
        <Cell label="contributors · 24 h" value={people === null ? null : fmtInt(people)} sub="identities with an applied step" />
        <Cell
          label="audits ok / failed"
          value={ok === null || failed === null ? null : `${fmtInt(ok)} / ${fmtInt(failed)}`}
          sub={auditTotal ? `${((ok! / auditTotal) * 100).toFixed(1)}% passed · full recompute` : 'full server recompute'}
        />
      </div>

      <p className="sp-dist-note">
        A connected GPU receives the current weights and a batch the server picks from the corpus, computes the gradient of the loss and returns it.
        The server checks every result against a gradient it computes on a random sub-batch, fully recomputes a share of jobs from the same base
        weights, and applies accepted gradients with its Adam optimizer. INK for a training job stays pending until the next full audit of that
        identity passes. The server keeps training on its own CPU when no GPU work arrives.
      </p>
    </div>
  )
}

function Cell({ label, value, sub, hot }: { label: string; value: string | null; sub: ReactNode; hot?: boolean }) {
  return (
    <div className={`sp-dist-cell ${hot ? 'hot-tile' : ''}`}>
      <span className="label">{label}</span>
      <span className="sp-tile-v num">{value ?? '—'}</span>
      <span className="sp-tile-s mono">{sub}</span>
    </div>
  )
}
