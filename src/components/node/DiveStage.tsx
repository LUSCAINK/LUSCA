import { useMemo } from 'react'
import { useLastRun } from '@/lib/account'
import { useNeuron } from '@/lib/gpu'
import type { NeuronHistoryPoint, NeuronStatus } from '@/lib/gpu'
import { useSampled } from '@/lib/hooks'
import { DASH, fmtInt } from '@/lib/format'
import { Stage } from './Stage'
import type { StageState } from './Stage'
import { UNREACHABLE_TEXT, serverState } from './flow'
import { useSaved, useSession } from './session'
import { fmtFlop, fmtG, shortId } from './util'

const STATUS_TEXT: Record<NeuronStatus, string> = {
  idle: 'idle',
  detecting: 'detecting',
  unsupported: 'cpu only',
  benchmarking: 'measuring',
  ready: 'ready',
  running: 'earning',
  paused: 'paused',
  error: 'error',
}

function Throughput({ history, bench }: { history: NeuronHistoryPoint[]; bench: number }) {
  const W = 600
  const H = 132
  const pts = history.filter((p) => Number.isFinite(p.gflopsEff))
  const peak = pts.length ? Math.max(...pts.map((p) => p.gflopsEff)) : 0
  const max = Math.max(1e-6, peak) * 1.12
  const slot = W / 60
  const x = (i: number) => W - (pts.length - 1 - i) * slot - slot / 2
  const y = (g: number) => H - 14 - (g / max) * (H - 24)
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.gflopsEff).toFixed(1)}`).join(' ')
  const avg = pts.length ? pts.reduce((a, p) => a + p.gflopsEff, 0) / pts.length : 0
  const last = pts.length ? pts[pts.length - 1].gflopsEff : 0
  return (
    <figure className="tp-fig">
      <figcaption className="tp-cap mono">
        <span>
          last <b className="num">{fmtG(last)}</b>
        </span>
        <span>
          avg <b className="num">{fmtG(avg)}</b>
        </span>
        <span>
          peak <b className="num">{fmtG(peak)}</b>
        </span>
        <span className="tp-cap-r">speed per job · GFLOPS · last {pts.length} jobs</span>
      </figcaption>
      <div className="tp-plot">
        <svg className="tp-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Speed over the last ${pts.length} jobs, latest ${fmtG(last)} GFLOPS`}>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1="0" x2={W} y1={(H - 14) * f} y2={(H - 14) * f} className="tp-grid" vectorEffect="non-scaling-stroke" />
          ))}
          <line x1="0" x2={W} y1={H - 14} y2={H - 14} className="tp-base" vectorEffect="non-scaling-stroke" />
          {pts.length > 1 && (
            <>
              <polygon points={`${x(0).toFixed(1)},${H - 14} ${line} ${x(pts.length - 1).toFixed(1)},${H - 14}`} className="tp-area" />
              <polyline points={line} className="tp-line" vectorEffect="non-scaling-stroke" />
            </>
          )}
          {pts.map((p, i) => (
            <rect
              key={p.id}
              x={x(i) - slot * 0.32}
              y={H - 10}
              width={slot * 0.64}
              height="8"
              className={p.verified ? 'tp-tick tp-ok' : 'tp-tick tp-bad'}
            />
          ))}
        </svg>
        {pts.length === 0 && <div className="tp-empty mono">{bench > 0 ? 'the chart starts with your first job' : 'no jobs yet'}</div>}
      </div>
      <div className="tp-legend mono" aria-hidden="true">
        <span>
          <i className="tp-ok" /> verified by server
        </span>
        <span>
          <i className="tp-bad" /> failed
        </span>
      </div>
    </figure>
  )
}

function logTone(line: string): string {
  if (/fail|error|rejected|lost|crash|refused|timed out/i.test(line)) return 'lg-err'
  if (/near-duplicate/i.test(line)) return 'lg-hot'
  if (/verified \+|\+\d.*(?:INK|credits)/.test(line)) return 'lg-ok'
  if (/^(neuron|registered|coordinator|benchmark|detected|paused|resumed|tab |waiting|can't reach|lusca server|ink now goes|credits now go|linked|sepia|self-test|switching)/i.test(line)) return 'lg-sys'
  return ''
}

/**
 * Stable keys for a newest-first log: text + occurrence counted from the oldest
 * line, so prepending new lines never re-keys existing ones (new lines animate in).
 */
function logKeys(log: string[]): string[] {
  const seen = new Map<string, number>()
  const keys = new Array<string>(log.length)
  for (let i = log.length - 1; i >= 0; i--) {
    const n = (seen.get(log[i]) ?? 0) + 1
    seen.set(log[i], n)
    keys[i] = `${n}:${log[i]}`
  }
  return keys
}

/** One count tile: the saved all-time value with this session's share, or this session alone while the account is unknown. */
function CountTile({ label, all, session, fmt, err = false }: { label: string; all: number | null; session: number; fmt: (n: number) => string; err?: boolean }) {
  return (
    <div className="dt">
      <div className="label">{label}</div>
      <div className={`dt-v num ${err ? 'dt-err' : ''}`}>{fmt(all ?? session)}</div>
      <div className="dt-sub mono">{all !== null ? `all-time · +${fmt(session)} this session` : 'this session'}</div>
    </div>
  )
}

function flopText(n: number): string {
  const f = fmtFlop(n)
  return `${f.v} ${f.u}`
}

export function DiveStage({ state }: { state: StageState }) {
  const status = useNeuron((s) => s.status)
  const session = useSession()
  const lastJob = useNeuron((s) => s.lastJob)
  const lastTrain = useNeuron((s) => s.lastTrain)
  const trainBackend = useNeuron((s) => s.trainBackend)
  const history = useNeuron((s) => s.history)
  const log = useNeuron((s) => s.log)
  const keys = useMemo(() => logKeys(log), [log])
  const bench = useNeuron((s) => s.bench)
  const zone = useNeuron((s) => s.zone)
  const neuronId = useNeuron((s) => s.neuronId)
  const backend = useNeuron((s) => s.backend)
  const lastRun = useLastRun()
  const { start, pause, resume, stop } = useNeuron.getState()
  const conn = useSampled((s) => s.conn, 500)

  const running = status === 'running'
  const paused = status === 'paused'
  const active = running || paused
  const srv = serverState(conn)
  const live = srv === 'live'
  // Counts: the server's all-time totals with this session's share; this session only while unknown.
  const { acct } = useSaved(live)
  // Until a benchmark runs on this page, tier and speed come from this browser's last finished one.
  const headZone = zone ?? lastRun?.zone ?? DASH
  const headSpeed = bench ? `${fmtG(bench.gflops)} GFLOPS` : lastRun ? `${fmtG(lastRun.gflops)} GFLOPS · last benchmark` : DASH

  const onStart = () => void start()

  return (
    <Stage
      id="dive"
      n="4"
      title="Verified jobs"
      kicker="The work your GPU does, and how each result is checked before it earns credits."
      state={state}
      lockedNote="waiting for step 2 · the benchmark"
    >
      <div className="nd-grid dive-grid">
        <div className="nd-cell dive-ctl">
          <div className="panel-head">
            <span>
              <span className="hot">A</span>&nbsp;&nbsp;<b>How a job works</b>
            </span>
            <span className="nd-meta">{(trainBackend ?? backend) === 'cpu' ? 'cpu path' : 'webgpu'}</span>
          </div>
          <div className="dc-body">
            <ol className="dc-how">
              <li>
                <span className="mono">1</span>
                <span>LUSCA sends the current SEPIA weights and a batch of 16-character windows from its corpus, each with the character that follows it.</span>
              </li>
              <li>
                <span className="mono">2</span>
                <span>Your GPU runs the forward and backward pass and returns the gradient of the loss for every one of SEPIA’s 187,104 parameters.</span>
              </li>
              <li>
                <span className="mono">3</span>
                <span>The server checks every gradient against its own computation on part of the batch, fully re-computes a share of them, and applies verified gradients to SEPIA with its Adam optimizer. Between jobs your GPU also runs near-duplicate checks on new pages.</span>
              </li>
            </ol>
            <div className="nd-actions dc-btns">
              {!active && (
                <button type="button" className="btn primary lg" onClick={onStart} disabled={!live || status === 'benchmarking' || state === 'locked'}>
                  {!live ? 'waiting for server' : session.jobs > 0 || (acct?.jobs ?? 0) > 0 ? 'start again' : 'start verified jobs'}
                </button>
              )}
              {running && (
                <button type="button" className="btn lg" onClick={() => pause()}>
                  pause
                </button>
              )}
              {paused && (
                <button type="button" className="btn primary lg" onClick={() => resume()}>
                  resume
                </button>
              )}
              {active && (
                <button type="button" className="btn lg dc-stop" onClick={() => void stop()}>
                  stop
                </button>
              )}
            </div>
            <div className={`dc-mode ${live ? 'dc-mode-live' : ''}`} role="status">
              <div className="dc-mode-h mono">
                <span className={`led ${live ? 'on pulse' : 'white pulse'}`} aria-hidden="true" />
                {live ? 'live · checked by the server' : srv === 'connecting' ? 'connecting to the server' : 'waiting for the server'}
              </div>
              <p>
                {live
                  ? 'Jobs come from the LUSCA server, which re-checks every result before it writes credits to the ledger.'
                  : `${srv === 'connecting' ? 'Connecting to the LUSCA server…' : UNREACHABLE_TEXT} Jobs come only from the server, so none run and no credits are counted until it answers.`}
              </p>
            </div>
          </div>
        </div>

        <div className="nd-cell dive-live">
          <div className="panel-head">
            <span>
              <span className="hot">B</span>&nbsp;&nbsp;<b>Job stats</b>
            </span>
            <span className="nd-meta">
              {neuronId ? `id ${shortId(neuronId)}` : 'not registered'} · {headZone} · {headSpeed}
            </span>
          </div>
          <div className="dl-tiles">
            <div className="dt">
              <div className="label">status</div>
              <div className="dt-v dt-st">
                <span className={`led ${running ? 'on pulse' : paused ? 'white pulse' : status === 'error' ? '' : 'white'}`} aria-hidden="true" />
                <span>{STATUS_TEXT[status]}</span>
              </div>
            </div>
            <CountTile label="jobs done" all={acct ? acct.jobs : null} session={session.jobs} fmt={fmtInt} />
            {/* the ledger counts a gradient job as verified once a full audit releases its escrow */}
            <CountTile label="verified" all={acct ? acct.verified : null} session={acct ? session.confirmed : session.verified} fmt={fmtInt} />
            <CountTile label="failed" all={acct ? acct.failed : null} session={session.failed} fmt={fmtInt} err={session.failed > 0} />
            <div className="dt">
              <div className="label">server</div>
              <div className="dt-v dt-mode">{live ? 'live' : srv === 'connecting' ? 'connecting' : DASH}</div>
            </div>
            <div className="dt">
              <div className="label">total work</div>
              <div className="dt-v num">
                {fmtFlop(acct ? acct.flops : session.flops).v}
                <span className="dt-u">{fmtFlop(acct ? acct.flops : session.flops).u}</span>
              </div>
              <div className="dt-sub mono">{acct ? `all-time · +${flopText(session.flops)} this session` : 'this session'}</div>
            </div>
            <div className="dt">
              <div className="label">last job speed</div>
              <div className="dt-v num">{lastTrain && Number.isFinite(lastTrain.gflopsEff) ? fmtG(lastTrain.gflopsEff) : lastJob ? fmtG(lastJob.gflopsEff) : '—'}</div>
              <div className="dt-sub mono">{lastTrain || lastJob ? 'GFLOPS, effective' : ''}</div>
            </div>
            <div className="dt">
              <div className="label">last job size</div>
              <div className="dt-v num dt-sm">{lastTrain ? `B=${lastTrain.batch.toLocaleString('en-US')}` : lastJob ? `${lastJob.rows}×${lastJob.cols}×${lastJob.dim}` : '—'}</div>
              <div className="dt-sub mono">{lastTrain ? `v${lastTrain.version} · loss ${lastTrain.loss.toFixed(3)} · ${lastTrain.ms.toFixed(lastTrain.ms < 10 ? 1 : 0)} ms` : lastJob ? `${lastJob.ms.toFixed(lastJob.ms < 10 ? 1 : 0)} ms` : ''}</div>
            </div>
          </div>
          <Throughput history={history} bench={bench?.gflops ?? 0} />
          <div className="dl-log">
            <div className="dl-log-h label">
              <span>job log</span>
              <span>{log.length} lines · newest first</span>
            </div>
            <ol className="jlog mono" aria-label="Job log, newest first" tabIndex={0}>
              {log.length ? (
                log.map((l, i) => (
                  <li key={keys[i]} className={logTone(l)}>
                    {l}
                  </li>
                ))
              ) : (
                <li className="dimmer">the log fills once you start.</li>
              )}
            </ol>
          </div>
        </div>
      </div>
    </Stage>
  )
}
