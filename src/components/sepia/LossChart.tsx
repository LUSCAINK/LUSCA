// The hero of the Sepia page: SEPIA-0's live loss curve, hand-drawn in SVG.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { LossPoint } from '@shared/protocol'
import { bus } from '@/lib/bus'
import { useMedia, useNow, useSampled } from '@/lib/hooks'
import { fmtCompact, fmtInt } from '@/lib/format'
import { useLossHistory } from './history'
import { HP, LN_VOCAB, MIN_CORPUS, ago, fmtLoss, fmtStep, idxAtOrBefore, idxNearest, valAtOrBefore } from './model'

type Domain = [x0: number, x1: number, y0: number, y1: number]

function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target)
  const p = 10 ** Math.floor(Math.log10(raw))
  const n = raw / p
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p
}

/** Step-aware exponential moving average (uneven spacing after server downsampling). */
function ema(pts: LossPoint[], tau: number): number[] {
  const out = new Array<number>(pts.length)
  let v = pts.length ? pts[0].loss : 0
  for (let i = 0; i < pts.length; i++) {
    const a = i === 0 ? 1 : 1 - Math.exp(-Math.max(1, pts[i].step - pts[i - 1].step) / tau)
    v += a * (pts[i].loss - v)
    out[i] = v
  }
  return out
}

/** Eases a numeric domain toward its target so the curve glides instead of jumping. */
function useEasedDomain(target: Domain, still: boolean): Domain {
  const [v, setV] = useState<Domain>(target)
  const cur = useRef<Domain>(target)
  const key = target.join('|')
  useEffect(() => {
    if (still) {
      cur.current = target
      setV(target)
      return
    }
    let raf = 0
    const tick = () => {
      let done = true
      const next = cur.current.map((c, i) => {
        const t = target[i]
        const d = t - c
        if (Math.abs(d) <= Math.max(1e-6, Math.abs(t) * 2e-4)) return t
        done = false
        return c + d * 0.16
      }) as Domain
      cur.current = next
      setV(next)
      if (!done) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [key, still])
  return v
}

export function LossChart() {
  const loss = useLossHistory(250)
  const model = useSampled((s) => s.model, 250)
  const conn = useSampled((s) => s.conn, 500)
  const now = useNow(5000)
  const narrow = useMedia('(max-width: 720px)')
  const still = useMedia('(prefers-reduced-motion: reduce)')
  const [logX, setLogX] = useState(false)
  const [hoverStep, setHoverStep] = useState<number | null>(null)
  const [burst, setBurst] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [W, setW] = useState(1100)

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.round(el.clientWidth))))
    ro.observe(el)
    setW(Math.max(280, Math.round(el.clientWidth)))
    return () => ro.disconnect()
  }, [])

  // ring-burst on every fresh point
  useEffect(() => bus.on('loss', () => setBurst((b) => (b + 1) % 1000)), [])

  const H = narrow ? 300 : 380
  const M = { l: narrow ? 38 : 52, r: narrow ? 58 : 96, t: 26, b: 30 }
  const pw = Math.max(10, W - M.l - M.r)
  const ph = H - M.t - M.b

  const pts = loss
  const n = pts.length
  const last = n ? pts[n - 1] : null
  const tau = Math.min(1000, Math.max(25, (last?.step ?? 0) / 300))
  const sm = useMemo(() => ema(pts, tau), [pts, tau])
  const vals = useMemo(() => pts.filter((p) => p.val !== null), [pts])

  // ── target domain
  const target: Domain = useMemo(() => {
    if (!n) return [logX ? 1 : 0, 1000, 0, 5]
    const first = Math.max(1, pts[0].step)
    const lastStep = Math.max(pts[n - 1].step, first * 4, 100)
    let lo = Infinity
    let top = -Infinity
    for (const p of pts) {
      lo = Math.min(lo, p.loss, p.val ?? Infinity)
      top = Math.max(top, p.loss, p.val ?? -Infinity)
    }
    const y0 = Math.max(0, Math.floor((lo - 0.12) * 4) / 4)
    const y1 = Math.max(LN_VOCAB + 0.36, Math.ceil((top + 0.08) * 4) / 4)
    const x1 = logX ? lastStep * 1.12 : lastStep * 1.035
    return [logX ? first : 0, x1, y0, y1]
  }, [pts, n, logX])
  const [x0, x1, y0, y1] = useEasedDomain(target, still)

  const lx0 = Math.log10(Math.max(1e-9, x0))
  const lx1 = Math.log10(Math.max(x0 * 1.0001, x1))
  const sx = (step: number) =>
    logX ? M.l + ((Math.log10(Math.max(step, x0)) - lx0) / (lx1 - lx0)) * pw : M.l + ((step - x0) / (x1 - x0 || 1)) * pw
  const sy = (l: number) => M.t + (1 - (l - y0) / (y1 - y0 || 1)) * ph
  const invx = (px: number) => {
    const f = (px - M.l) / pw
    return logX ? 10 ** (lx0 + f * (lx1 - lx0)) : x0 + f * (x1 - x0)
  }

  // ── ticks
  const yStep = y1 - y0 > 2.6 ? 0.5 : 0.25
  const yTicks: number[] = []
  for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1 + 1e-9; v += yStep) yTicks.push(+v.toFixed(2))
  const xTicks: { v: number; major: boolean }[] = []
  if (logX) {
    for (let d = Math.floor(lx0); d <= Math.ceil(lx1); d++) {
      for (const m of [1, 2, 5]) {
        const v = m * 10 ** d
        if (v >= x0 * 0.999 && v <= x1) xTicks.push({ v, major: m === 1 || pw > 640 })
      }
    }
  } else {
    const st = niceStep(x1 - x0, Math.max(3, Math.floor(pw / 130)))
    for (let v = Math.ceil(x0 / st) * st; v <= x1; v += st) xTicks.push({ v, major: true })
  }

  // ── paths
  const rawPath = n > 1 ? 'M' + pts.map((p) => `${sx(p.step).toFixed(1)},${sy(p.loss).toFixed(1)}`).join('L') : ''
  const emaPath = n > 1 ? 'M' + pts.map((p, i) => `${sx(p.step).toFixed(1)},${sy(sm[i]).toFixed(1)}`).join('L') : ''
  const areaPath = n > 1 ? `${emaPath}L${sx(pts[n - 1].step).toFixed(1)},${M.t + ph}L${sx(pts[0].step).toFixed(1)},${M.t + ph}Z` : ''
  const valPath = vals.length > 1 ? 'M' + vals.map((p) => `${sx(p.step).toFixed(1)},${sy(p.val as number).toFixed(1)}`).join('L') : ''

  // thin validation markers so dense histories read as squares, not a smear
  const valMarks: LossPoint[] = []
  {
    let lastPx = -Infinity
    for (let i = 0; i < vals.length; i++) {
      const px = sx(vals[i].step)
      if (px - lastPx >= 7 || i === vals.length - 1) {
        if (i === vals.length - 1 && px - lastPx < 7 && valMarks.length) valMarks.pop()
        valMarks.push(vals[i])
        lastPx = px
      }
    }
  }

  const ry = sy(LN_VOCAB)
  const warmX = sx(HP.warmup)
  const showWarm = n > 0 && HP.warmup > x0 && HP.warmup < x1 && warmX - M.l > 34

  // ── latest readout
  const lastX = last ? sx(last.step) : 0
  const lastY = last ? sy(last.loss) : 0
  const tagY = Math.max(M.t + 9, Math.min(M.t + ph - 9, lastY))

  // ── hover
  const hi = hoverStep !== null && n ? idxNearest(pts, hoverStep) : null
  const hp = hi !== null ? pts[hi] : null
  const setHover = (i: number | null) => setHoverStep(i === null ? null : pts[Math.max(0, Math.min(n - 1, i))].step)
  const hval = hi !== null ? valAtOrBefore(pts, pts[hi].step, hi) : null
  const pick = (clientX: number) => {
    const r = svg.current?.getBoundingClientRect()
    if (!r || !n) return
    const px = ((clientX - r.left) / r.width) * W
    if (px < M.l - 8 || px > M.l + pw + 8) return setHover(null)
    setHover(idxNearest(pts, invx(px)))
  }
  const onMove = (e: PointerEvent<SVGSVGElement>) => pick(e.clientX)
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!n) return
    const stepN = e.shiftKey ? 20 : 1
    if (e.key === 'ArrowLeft') setHover((hi ?? n - 1) - stepN)
    else if (e.key === 'ArrowRight') setHover((hi ?? n - 1) + stepN)
    else if (e.key === 'Home') setHover(0)
    else if (e.key === 'End') setHover(n - 1)
    else if (e.key === 'Escape') setHover(null)
    else return
    e.preventDefault()
  }

  // ── readouts
  const emaNow = n ? sm[n - 1] : 0
  const lastVal = vals.length ? (vals[vals.length - 1].val as number) : null
  const bestVal = vals.length ? Math.min(...vals.map((v) => v.val as number)) : null
  const kAgo = last ? idxAtOrBefore(pts, last.step - 1000) : -1
  const delta = last && kAgo >= 0 && kAgo < n - 1 ? emaNow - sm[kAgo] : null
  const corpusPct = Math.min(1, model.corpusChars / MIN_CORPUS)

  const ariaSummary = last
    ? `SEPIA-0 loss curve. ${n} points. Latest step ${fmtInt(last.step)}, train loss ${fmtLoss(last.loss)} nats per character${lastVal !== null ? `, validation ${fmtLoss(lastVal)}` : ''}. Random guessing scores ${LN_VOCAB.toFixed(3)}. Use arrow keys to inspect points.`
    : 'SEPIA-0 loss curve. No training steps yet.'

  const tipLeft = hp ? sx(hp.step) : 0
  const tipFlip = tipLeft + 200 > M.l + pw

  return (
    <div className="lc panel">
      <div className="panel-head lc-head">
        <span>
          <span className="hot">A</span>&nbsp;&nbsp;<b>Live loss curve</b>
          <span className="lc-unit">&nbsp;&nbsp;nats / char · lower is better</span>
        </span>
        <span className="lc-ctrl">
          <span className="lc-legend" aria-hidden="true">
            <span className="lc-lg"><i className="lg-train" /> train</span>
            <span className="lc-lg"><i className="lg-val" /> val</span>
            <span className="lc-lg"><i className="lg-rand" /> random</span>
          </span>
          <span className="seg" role="group" aria-label="x-axis scale">
            <button type="button" aria-pressed={!logX} className={!logX ? 'on' : ''} onClick={() => setLogX(false)}>
              lin
            </button>
            <button type="button" aria-pressed={logX} className={logX ? 'on' : ''} onClick={() => setLogX(true)}>
              log
            </button>
          </span>
        </span>
      </div>

      <div className="lc-plot" ref={wrap} style={{ height: H }}>
        <svg
          ref={svg}
          className="lc-svg"
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={ariaSummary}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          <defs>
            <pattern id="lc-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" className="lc-hatch-l" />
            </pattern>
            <clipPath id="lc-clip">
              <rect x={M.l} y={M.t - 1} width={pw + 1} height={ph + 2} />
            </clipPath>
          </defs>

          {/* grid */}
          <g className="lc-grid">
            {yTicks.map((v) => (
              <line key={`y${v}`} x1={M.l} x2={M.l + pw} y1={sy(v)} y2={sy(v)} />
            ))}
            {xTicks.map((t) => (
              <line key={`x${t.v}`} x1={sx(t.v)} x2={sx(t.v)} y1={M.t} y2={M.t + ph} className={t.major ? '' : 'minor'} />
            ))}
          </g>
          <rect x={M.l} y={M.t} width={pw} height={ph} className="lc-frame" />

          {/* axes labels */}
          <g className="lc-ax">
            {yTicks.map((v) => (
              <text key={`yl${v}`} x={M.l - 8} y={sy(v) + 3} textAnchor="end">
                {v.toFixed(yStep < 0.5 ? 2 : 1)}
              </text>
            ))}
            {xTicks
              .filter((t) => t.major)
              .map((t) => (
                <text key={`xl${t.v}`} x={sx(t.v)} y={M.t + ph + 18} textAnchor="middle">
                  {fmtStep(t.v)}
                </text>
              ))}
            <text x={M.l} y={M.t - 12} className="lc-axt">
              loss · nats/char
            </text>
            <text x={M.l + pw} y={M.t - 12} textAnchor="end" className="lc-axt">
              step{logX ? ' · log' : ''}
            </text>
          </g>

          <g clipPath="url(#lc-clip)">
            {/* random-guess reference */}
            <line x1={M.l} x2={M.l + pw} y1={ry} y2={ry} className="lc-rand" />
            <text x={M.l + 8} y={ry - 6} className="lc-rand-t">
              random guess · ln 96 = {LN_VOCAB.toFixed(3)}
            </text>

            {showWarm && (
              <g className="lc-warm">
                <line x1={warmX} x2={warmX} y1={M.t} y2={M.t + ph} />
                <text x={warmX + 5} y={M.t + ph - 6}>
                  warmup ends
                </text>
              </g>
            )}

            {n > 1 && <path d={areaPath} className="lc-area" />}
            {n > 1 && <path d={rawPath} className="lc-raw" />}
            {n > 1 && <path d={emaPath} className="lc-ema" />}
            {valPath && <path d={valPath} className="lc-valline" />}
            {valMarks.map((p) => (
              <rect key={p.step} x={sx(p.step) - 2.5} y={sy(p.val as number) - 2.5} width={5} height={5} className="lc-val" />
            ))}

            {/* latest point */}
            {last && (
              <g>
                <line x1={lastX} x2={M.l + pw} y1={lastY} y2={lastY} className="lc-lastline" />
                <rect key={burst} x={lastX - 4} y={lastY - 4} width={8} height={8} className="lc-burst" />
                <rect x={lastX - 6} y={lastY - 6} width={12} height={12} className="lc-ping" />
                <rect x={lastX - 3} y={lastY - 3} width={6} height={6} className="lc-last" />
              </g>
            )}

            {/* hover crosshair */}
            {hp && (
              <g className="lc-cross">
                <line x1={sx(hp.step)} x2={sx(hp.step)} y1={M.t} y2={M.t + ph} />
                <line x1={M.l} x2={M.l + pw} y1={sy(hp.loss)} y2={sy(hp.loss)} />
                <rect x={sx(hp.step) - 3.5} y={sy(hp.loss) - 3.5} width={7} height={7} className="lc-cross-pt" />
              </g>
            )}
          </g>

          {/* right-margin readout tag */}
          {last && (
            <g className="lc-tag" transform={`translate(${M.l + pw + 1}, ${tagY})`}>
              <path d="M0,0 L6,-9 L6,9 Z" className="lc-tag-bg" />
              <rect x={6} y={-9} width={M.r - 10} height={18} className="lc-tag-bg" />
              <text x={10} y={4} className="lc-tag-v">
                {fmtLoss(last.loss)}
              </text>
              {!narrow && (
                <text x={10} y={22} className="lc-tag-s">
                  #{fmtStep(last.step)}
                </text>
              )}
            </g>
          )}
          {hp && (
            <g transform={`translate(0, ${M.t + ph})`}>
              <rect x={sx(hp.step) - 28} y={4} width={56} height={16} className="lc-xtag" />
              <text x={sx(hp.step)} y={15} textAnchor="middle" className="lc-xtag-t">
                {fmtInt(hp.step)}
              </text>
            </g>
          )}
        </svg>

        {hp && (
          <div
            className={`lc-tip mono ${narrow ? 'strip' : tipFlip ? 'flip' : ''}`}
            style={narrow ? { left: M.l + 4, right: M.r + 4, top: M.t + 4 } : { left: tipLeft, top: Math.max(M.t + 6, Math.min(sy(hp.loss) - 20, H - 140)) }}
            aria-hidden="true"
          >
            <div className="lc-tip-r">
              <span>step</span>
              <b>{fmtInt(hp.step)}</b>
            </div>
            <div className="lc-tip-r">
              <span>train</span>
              <b>{fmtLoss(hp.loss)}</b>
            </div>
            <div className="lc-tip-r">
              <span>ema</span>
              <b>{fmtLoss(sm[hi as number])}</b>
            </div>
            <div className="lc-tip-r hotrow">
              <span>val</span>
              <b>{hval ? fmtLoss(hval.val) : '—'}</b>
            </div>
            {hval && hval.step !== hp.step && !narrow && <div className="lc-tip-n">val from step {fmtInt(hval.step)}</div>}
            <div className="lc-tip-r">
              <span>seen</span>
              <b>{fmtCompact(hp.tokens)} ch</b>
            </div>
            <div className="lc-tip-r">
              <span>when</span>
              <b>{ago(hp.ts, now)}</b>
            </div>
          </div>
        )}

        {!n && (
          <div className="lc-empty">
            <div className="label">{conn === 'connecting' ? 'linking to the coordinator' : 'no steps yet'}</div>
            <p className="lc-empty-t">waiting for 20k characters of corpus before the first step</p>
            <div className="lc-empty-m" role="progressbar" aria-label="corpus collected before training starts" aria-valuemin={0} aria-valuemax={MIN_CORPUS} aria-valuenow={Math.min(MIN_CORPUS, model.corpusChars)}>
              <i style={{ transform: `scaleX(${corpusPct})` }} />
            </div>
            <div className="lc-empty-n mono">
              {fmtInt(Math.min(MIN_CORPUS, model.corpusChars))} / {fmtInt(MIN_CORPUS)} chars
            </div>
          </div>
        )}
      </div>

      <div className="lc-foot">
        <Readout label="train · ema" value={fmtLoss(n ? emaNow : null)} sub={last ? `raw ${fmtLoss(last.loss)}` : 'no steps'} />
        <Readout label="val · last" value={fmtLoss(lastVal)} hot sub={lastVal !== null && n ? `gap ${lastVal - emaNow >= 0 ? '+' : '−'}${Math.abs(lastVal - emaNow).toFixed(3)}` : `every ${HP.valEvery} steps`} />
        <Readout label="val · best" value={fmtLoss(bestVal)} sub={`${vals.length} checks`} />
        <Readout label="bits / char" value={n ? (emaNow / Math.LN2).toFixed(3) : '—'} sub={`random ${(LN_VOCAB / Math.LN2).toFixed(2)}`} />
        <Readout label="perplexity" value={n ? Math.exp(emaNow).toFixed(2) : '—'} sub="of 96 symbols" />
        <Readout
          label="Δ / 1k steps"
          value={delta === null ? '—' : `${delta <= 0 ? '−' : '+'}${Math.abs(delta).toFixed(3)}`}
          sub={delta === null ? 'needs 1k steps' : delta < -0.015 ? 'still learning' : delta > 0.03 ? 'new text, new confusion' : 'plateau · noise'}
        />
      </div>
    </div>
  )
}

function Readout({ label, value, sub, hot }: { label: string; value: string; sub: string; hot?: boolean }) {
  return (
    <div className={`lc-ro ${hot ? 'hot-ro' : ''}`}>
      <span className="label">{label}</span>
      <span className="lc-ro-v num">{value}</span>
      <span className="lc-ro-s mono">{sub}</span>
    </div>
  )
}
