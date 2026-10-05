import { useNeuron } from '@/lib/gpu'
import type { GpuDetect } from '@/lib/gpu'
import { fmtBytes, fmtInt } from '@/lib/format'
import { Cell, Stage } from './Stage'
import type { StageState } from './Stage'
import { scrollToId } from './util'

const KEY_FEATURES: { key: string; what: string }[] = [
  { key: 'shader-f16', what: 'half-precision math in shaders' },
  { key: 'timestamp-query', what: 'GPU-side timers for the benchmark' },
]

const BROWSER: Record<string, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  opera: 'Opera',
  firefox: 'Firefox',
  safari: 'Safari',
  other: 'unknown browser',
}

function verdict(d: GpuDetect | null): { tone: 'ok' | 'warn' | 'no' | 'idle'; head: string; body: string } {
  if (!d) return { tone: 'idle', head: 'Not checked yet', body: 'Press Detect GPU here, or Start earning at the top of the page.' }
  if (!d.supported) {
    return {
      tone: 'no',
      head: 'No WebGPU',
      body: `${d.reason ?? 'This browser does not expose WebGPU.'} You can still earn on the CPU path (${d.cpu.label}): slower, EPI tier.`,
    }
  }
  if (d.isFallback) {
    return {
      tone: 'warn',
      head: 'Software adapter',
      body: 'WebGPU is running in software (SwiftShader / WARP), not on your graphics card. It works, but slowly. Turn on hardware acceleration in your browser settings to use the real GPU.',
    }
  }
  const ts = d.features.includes('timestamp-query')
  return {
    tone: 'ok',
    head: 'GPU ready',
    body: `${d.label} · ${ts ? 'exact GPU timing available' : 'wall-clock timing'}. Next: the benchmark.`,
  }
}

export function DetectStage({ state }: { state: StageState }) {
  const det = useNeuron((s) => s.detect)
  const status = useNeuron((s) => s.status)
  const runDetect = useNeuron((s) => s.runDetect)
  const busy = status === 'detecting'
  const v = verdict(det)
  const lim = det?.limits
  const others = det ? det.features.filter((f) => !KEY_FEATURES.some((k) => k.key === f)) : []
  const dash = (s: string | undefined | null) => (s && s.trim() ? s : '—')

  const onProbe = async () => {
    await runDetect()
  }

  return (
    <Stage id="detect" n="1" title="Detect your GPU" kicker="What your browser reports about your graphics card. Runs locally — nothing is sent." state={state}>
      <div className="nd-grid det-grid">
        <div className="nd-cell det-act">
          <p className="nd-lede">
            WebGPU is the browser feature that lets a web page use your graphics card. This step asks your browser which card it would use and what that
            card supports.
          </p>
          <div className="nd-actions">
            <button type="button" className={`btn lg ${det ? '' : 'primary'}`} onClick={() => void onProbe()} disabled={busy} aria-busy={busy}>
              {busy ? 'detecting…' : det ? 'detect again' : 'detect GPU'}
            </button>
            {det && (
              <button type="button" className="btn lg" onClick={() => scrollToId('bench')}>
                next: benchmark <span aria-hidden="true">↓</span>
              </button>
            )}
          </div>
          <div className={`verdict verdict-${v.tone}`} role="status" aria-live="polite">
            <div className="label">result</div>
            <div className="verdict-h display-cond">{v.head}</div>
            <p className="verdict-b">{v.body}</p>
          </div>
        </div>

        <Cell idx="A" title="Graphics card" meta={det ? (det.supported ? BROWSER[det.browser] ?? det.browser : 'unavailable') : 'not checked'} className="det-adapter">
          <dl className="nd-kv">
            <div>
              <dt>vendor</dt>
              <dd>{dash(det?.info.vendor)}</dd>
            </div>
            <div>
              <dt>architecture</dt>
              <dd className={det?.info.architecture ? 'hot' : undefined}>{dash(det?.info.architecture)}</dd>
            </div>
            <div>
              <dt>device</dt>
              <dd>{dash(det?.info.device)}</dd>
            </div>
            <div>
              <dt>description</dt>
              <dd>{det ? (det.info.description.trim() ? det.info.description : 'withheld by browser') : '—'}</dd>
            </div>
            <div>
              <dt>label</dt>
              <dd>{det ? det.label : '—'}</dd>
            </div>
            <div>
              <dt>adapter type</dt>
              <dd>{det ? (det.supported ? (det.isFallback ? 'software' : 'hardware') : 'none') : '—'}</dd>
            </div>
          </dl>
        </Cell>

        <Cell idx="B" title="Features" meta={det?.supported ? `${det.features.length} exposed` : '—'} className="det-feat">
          <div className="feat-key">
            {KEY_FEATURES.map((f) => {
              const has = !!det?.features.includes(f.key)
              return (
                <div key={f.key} className={`feat ${det ? (has ? 'feat-on' : 'feat-off') : ''}`}>
                  <span className="feat-mark mono" aria-hidden="true">
                    {det ? (has ? '■' : '□') : '·'}
                  </span>
                  <span className="feat-n mono">{f.key}</span>
                  <span className="feat-w">{f.what}</span>
                  <span className="sr-only">{det ? (has ? 'supported' : 'not supported') : 'unknown'}</span>
                </div>
              )
            })}
          </div>
          {others.length > 0 && (
            <ul className="feat-all" aria-label="Other adapter features">
              {others.map((f) => (
                <li key={f} className="tag">
                  {f}
                </li>
              ))}
            </ul>
          )}
        </Cell>

        <Cell idx="C" title="Limits" meta="largest sizes a job may use" className="det-lim">
          <dl className="nd-kv nd-kv-num">
            <div>
              <dt>max buffer</dt>
              <dd>{lim?.maxBufferSize ? fmtBytes(lim.maxBufferSize) : '—'}</dd>
            </div>
            <div>
              <dt>storage binding</dt>
              <dd>{lim?.maxStorageBufferBindingSize ? fmtBytes(lim.maxStorageBufferBindingSize) : '—'}</dd>
            </div>
            <div>
              <dt>workgroup memory</dt>
              <dd>{lim?.maxComputeWorkgroupStorageSize ? fmtBytes(lim.maxComputeWorkgroupStorageSize) : '—'}</dd>
            </div>
            <div>
              <dt>invocations / wg</dt>
              <dd>{lim?.maxComputeInvocationsPerWorkgroup ? fmtInt(lim.maxComputeInvocationsPerWorkgroup) : '—'}</dd>
            </div>
            <div>
              <dt>wg size x</dt>
              <dd>{lim?.maxComputeWorkgroupSizeX ? fmtInt(lim.maxComputeWorkgroupSizeX) : '—'}</dd>
            </div>
            <div>
              <dt>workgroups / dim</dt>
              <dd>{lim?.maxComputeWorkgroupsPerDimension ? fmtInt(lim.maxComputeWorkgroupsPerDimension) : '—'}</dd>
            </div>
          </dl>
        </Cell>

        <Cell idx="D" title="CPU" meta="backup when there is no WebGPU" className="det-cpu">
          <div className="cpu-big">
            <span className="num cpu-n">{det ? det.cpu.cores : '—'}</span>
            <span className="label">logical threads</span>
          </div>
          <dl className="nd-kv">
            <div>
              <dt>device memory</dt>
              <dd>{det ? (det.cpu.memoryGB ? `≈ ${det.cpu.memoryGB} GB (browser-rounded)` : 'not reported') : '—'}</dd>
            </div>
            <div>
              <dt>cpu path</dt>
              <dd>{det ? (det.supported ? 'standby' : 'in use') : '—'}</dd>
            </div>
          </dl>
        </Cell>
      </div>
    </Stage>
  )
}
