import { useEffect, useRef, useState } from 'react'
import { ZONES } from '@shared/protocol'
import type { Zone } from '@shared/protocol'
import { useNeuron } from '@/lib/gpu'
import { Stage } from './Stage'
import type { StageState } from './Stage'
import { bandPos, depthFor, deviceName, fmtG, fmtM, scrollToId, zoneIdx } from './util'

const BOUNDS = [0, 200, 1000, 4000, 6000, 11000]

/** Deterministic marine snow for the water column (computed once). */
const SNOW = (() => {
  let s = 0x9e3779b9
  const r = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
  return Array.from({ length: 42 }, () => ({ x: 6 + r() * 88, y: r() * 500, w: 0.6 + r() * 1.4, o: 0.15 + r() * 0.45 }))
})()

export function ZoneGauge({ zone, depth, active }: { zone: Zone | null; depth: number; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined')
  const snow = SNOW
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setInView(true), { threshold: 0.35 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const dropped = active && inView && zone !== null
  const pos = dropped ? bandPos(depth) : 0
  const zi = zoneIdx(zone)
  const shownDepth = depth // the marker moves; the label shows the real value only

  return (
    <div className="zg" ref={ref}>
      <ol className="zg-axis mono" aria-hidden="true">
        {BOUNDS.map((b, i) => (
          <li key={b} style={{ top: `${(i / ZONES.length) * 100}%` }}>
            {b.toLocaleString('en-US')} m
          </li>
        ))}
      </ol>
      <div className="zg-col" aria-hidden="true">
        <svg viewBox="0 0 100 500" preserveAspectRatio="none">
          <defs>
            <linearGradient id="zg-water" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#262624" />
              <stop offset="0.2" stopColor="#151515" />
              <stop offset="0.4" stopColor="#0c0c0c" />
              <stop offset="0.6" stopColor="#070707" />
              <stop offset="0.8" stopColor="#030303" />
              <stop offset="1" stopColor="#000" />
            </linearGradient>
            <linearGradient id="zg-ray" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ecebe6" stopOpacity="0.16" />
              <stop offset="1" stopColor="#ecebe6" stopOpacity="0" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="100" height="500" fill="url(#zg-water)" />
          <polygon points="18,0 30,0 46,150 26,150" fill="url(#zg-ray)" />
          <polygon points="52,0 60,0 74,120 58,120" fill="url(#zg-ray)" />
          <polygon points="78,0 84,0 92,90 82,90" fill="url(#zg-ray)" />
          {zi >= 0 && <rect x="0" y={zi * 100} width="100" height="100" className="zg-you" />}
          <g className="zg-snow">
            {snow.map((p, i) => (
              <rect key={i} x={p.x} y={p.y} width={p.w} height={p.w * 0.6} opacity={p.o} />
            ))}
            {snow.map((p, i) => (
              <rect key={`b${i}`} x={p.x} y={p.y + 500} width={p.w} height={p.w * 0.6} opacity={p.o} />
            ))}
          </g>
          {Array.from({ length: 50 }, (_, i) => (
            <line key={i} x1="0" x2={i % 10 === 0 ? 14 : 6} y1={i * 10} y2={i * 10} className="zg-tick" vectorEffect="non-scaling-stroke" />
          ))}
          {[100, 200, 300, 400].map((y) => (
            <line key={y} x1="0" x2="100" y1={y} y2={y} className="zg-sep" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      </div>
      <ol className="zg-bands">
        {ZONES.map((z, i) => (
          <li key={z.zone} className={`zg-band ${i === zi ? 'zg-band-you' : ''}`} aria-current={i === zi ? 'true' : undefined}>
            <div className="zg-code display">{z.zone}</div>
            <div className="zg-name mono">
              {z.name} · {z.depth}
            </div>
            <div className="zg-spec mono">
              <span>≥ {z.minGflops.toLocaleString('en-US')} GFLOPS</span>
              <span>{z.vram}</span>
              <span className={i === zi ? 'hot' : undefined}>×{z.bonus.toFixed(2)}</span>
            </div>
          </li>
        ))}
      </ol>
      <div className={`zg-marker ${dropped ? 'zg-marker-on' : ''}`} style={{ top: `${pos * 100}%` }} aria-hidden="true">
        <span className="zg-mline" />
        <span className="zg-mtag mono">
          {dropped ? (
            <>
              ▼ <span className="zg-mt-you">you · </span>
              {fmtM(shownDepth)}
            </>
          ) : zone ? (
            '▼ diving…'
          ) : (
            <>
              ▼ surface<span className="zg-mt-you"> · unmeasured</span>
            </>
          )}
        </span>
      </div>
    </div>
  )
}

export function ZoneStage({ state }: { state: StageState }) {
  const bench = useNeuron((s) => s.bench)
  const zone = useNeuron((s) => s.zone)
  const det = useNeuron((s) => s.detect)
  const backend = useNeuron((s) => s.backend)
  const g = bench?.gflops ?? 0
  const depth = bench ? depthFor(g) : 0
  const zi = zoneIdx(zone)
  const info = zi >= 0 ? ZONES[zi] : null
  const next = zi >= 0 && zi + 1 < ZONES.length ? ZONES[zi + 1] : null
  const name = deviceName(det, backend === 'cpu' || bench?.backend === 'cpu')

  return (
    <Stage
      id="zone"
      n="3"
      title="Your tier"
      kicker="Your benchmark score puts your GPU in one of five tiers. Deeper tier = bigger jobs + a bigger INK bonus."
      state={state}
      lockedNote="waiting for step 2 · the benchmark"
    >
      <div className="nd-grid zone-grid">
        <div className="nd-cell zg-cell">
          <div className="panel-head">
            <span>
              <span className="hot">A</span>&nbsp;&nbsp;<b>The five tiers</b>
            </span>
            <span className="nd-meta">named after ocean depths</span>
          </div>
          <ZoneGauge zone={zone} depth={depth} active={!!bench} />
        </div>

        <div className="nd-cell zone-copy">
          <div className="panel-head">
            <span>
              <span className="hot">B</span>&nbsp;&nbsp;<b>Your result</b>
            </span>
            <span className="nd-meta">{info ? info.name.toLowerCase() : 'not measured'}</span>
          </div>
          <div className="zc-body">
            <div className="label">your tier</div>
            <div className={`zc-tier display ${info ? '' : 'zc-tier-none'}`}>{info ? info.zone : '—'}</div>
            <p className="zc-h">
              {info ? (
                <>
                  Your {name} scored {fmtG(g)} GFLOPS, which puts it in <b>{info.zone}</b>. You earn <b className="hot">×{info.bonus.toFixed(2)}</b> INK per
                  verified job.
                </>
              ) : (
                'Run the benchmark to see your tier.'
              )}
            </p>
            <dl className="nd-kv">
              <div>
                <dt>tier</dt>
                <dd>{info ? `${info.zone} · ${info.name}` : '—'}</dd>
              </div>
              <div>
                <dt>benchmark score</dt>
                <dd>{bench ? `${fmtG(g)} GFLOPS` : '—'}</dd>
              </div>
              <div>
                <dt>ink bonus</dt>
                <dd className="zc-weight">{info ? `×${info.bonus.toFixed(2)}` : '—'}</dd>
              </div>
              <div>
                <dt>job size</dt>
                <dd>{info ? `${info.job} (rows × columns)` : '—'}</dd>
              </div>
              <div>
                <dt>typical gpu memory</dt>
                <dd>{info ? info.vram : '—'}</dd>
              </div>
              <div>
                <dt>next tier</dt>
                <dd>
                  {next
                    ? `${next.zone} at ${next.minGflops.toLocaleString('en-US')} GFLOPS`
                    : info
                      ? 'none — this is the deepest tier'
                      : '—'}
                </dd>
              </div>
            </dl>
            <p className="zc-note">
              Your tier comes from the benchmark score only. Browsers can’t read GPU memory, so the memory column is a guide. Each tier down gets 4× bigger
              jobs and +0.15 on the INK multiplier.
            </p>
            {bench && (
              <div className="nd-actions">
                <button type="button" className="btn lg" onClick={() => scrollToId('dive')}>
                  next: verified jobs <span aria-hidden="true">↓</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Stage>
  )
}
