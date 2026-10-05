import { useEffect, useRef } from 'react'
import type { AgentState } from '@shared/protocol'
import { bus } from '@/lib/bus'
import { useIsLive, useSampled } from '@/lib/hooks'
import { useLive } from '@/lib/store'
import { DASH, fmtInt } from '@/lib/format'
import { Count } from './parts'

const STAGES = [
  { key: 'frontier', label: 'FRONTIER', sub: 'urls queued' },
  { key: 'fetch', label: 'FETCH', sub: 'in flight' },
  { key: 'parse', label: 'PARSE', sub: 'text + links' },
  { key: 'taste', label: 'TASTE', sub: 'scoring' },
  { key: 'dedupe', label: 'DEDUPE', sub: 'near-dups caught' },
  { key: 'store', label: 'DATASET', sub: 'pages kept' },
  { key: 'sepia', label: 'SEPIA-0', sub: 'train steps' },
] as const

const STAGE_OF: Partial<Record<AgentState, number>> = { seek: 0, fetch: 1, parse: 2, taste: 3, dedupe: 4, store: 5 }

interface P {
  x0: number
  y0: number
  x1: number
  y1: number
  t: number
  dur: number
  kind: 0 | 1 | 2 // 0 hot, 1 bone, 2 err
}

export function Pipeline() {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const cells = useRef<(HTMLDivElement | null)[]>([])
  const stats = useSampled((s) => s.stats, 300)
  const model = useSampled((s) => s.model, 500)
  const stageKey = useSampled((s) => {
    const c = [0, 0, 0, 0, 0, 0]
    for (const a of s.agents) {
      const k = STAGE_OF[a.state]
      if (k !== undefined) c[k]++
    }
    return c.join(',')
  }, 150)
  const inStage = stageKey.split(',').map(Number)

  useEffect(() => {
    const cv = canvas.current
    const host = wrap.current
    if (!cv || !host) return
    const ctx = cv.getContext('2d')!
    let centers: { x: number; y: number; w: number }[] = []
    let W = 0
    let H = 0
    const measure = () => {
      const r = host.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      W = r.width
      H = r.height
      cv.width = Math.round(W * dpr)
      cv.height = Math.round(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      centers = cells.current.map((el) => {
        if (!el) return { x: 0, y: 0, w: 0 }
        const b = el.getBoundingClientRect()
        return { x: b.left - r.left + b.width / 2, y: b.top - r.top + b.height - 30, w: b.width }
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)

    const parts: P[] = []
    const prev = new Map<number, AgentState>()
    for (const a of useLive.getState().agents) prev.set(a.id, a.state)
    const add = (from: number, to: number, kind: P['kind']) => {
      const a = centers[from]
      const b = centers[to]
      if (!a || !b || parts.length > 160) return
      const jitter = (Math.random() - 0.5) * 6
      parts.push({ x0: a.x + a.w * 0.22, y0: a.y + jitter, x1: b.x + b.w * 0.22 - b.w * 0.44, y1: b.y + jitter, t: 0, dur: 0.55 + Math.random() * 0.25, kind })
    }
    const offA = bus.on('agent', (m) => {
      const a = m.agent
      const p = prev.get(a.id)
      prev.set(a.id, a.state)
      if (p === a.state) return
      const s0 = p ? STAGE_OF[p] : undefined
      const s1 = STAGE_OF[a.state]
      if (s0 !== undefined && s1 !== undefined && s1 === s0 + 1 && s1 < 5) add(s0, s1, 0)
      if ((a.state === 'reject' || a.state === 'error') && s0 !== undefined) {
        const c = centers[Math.max(1, s0)]
        if (c && parts.length < 160) parts.push({ x0: c.x + (Math.random() - 0.5) * 40, y0: c.y, x1: c.x + (Math.random() - 0.5) * 40, y1: H + 6, t: 0, dur: 0.6, kind: 2 })
      }
    })
    const offP = bus.on('page', () => {
      add(4, 5, 1)
      window.setTimeout(() => add(5, 6, 1), 520)
    })

    let raf = 0
    let last = performance.now()
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      ctx.clearRect(0, 0, W, H)
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]
        p.t += dt / p.dur
        if (p.t >= 1) {
          parts.splice(i, 1)
          continue
        }
        const e = p.kind === 2 ? p.t * p.t : 1 - Math.pow(1 - p.t, 3)
        const x = p.x0 + (p.x1 - p.x0) * e
        const y = p.y0 + (p.y1 - p.y0) * e
        const tail = 14 * (1 - p.t)
        const color = p.kind === 0 ? '255,77,0' : p.kind === 1 ? '236,235,230' : '255,46,58'
        const dx = p.x1 - p.x0
        const dy = p.y1 - p.y0
        const len = Math.hypot(dx, dy) || 1
        ctx.strokeStyle = `rgba(${color},0.35)`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x - (dx / len) * tail, y - (dy / len) * tail)
        ctx.stroke()
        ctx.fillStyle = `rgba(${color},${0.95 - p.t * 0.4})`
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      offA()
      offP()
    }
  }, [])

  const live = useIsLive(300)
  const values: (number | null)[] = live ? [stats.frontier, inStage[1], inStage[2], inStage[3], stats.dupes, stats.pages, model.step] : STAGES.map(() => null)
  const acceptRate = live && stats.pages + stats.rejected > 0 ? (stats.pages / (stats.pages + stats.rejected)) * 100 : null

  return (
    <div className="pipe" ref={wrap}>
      <canvas ref={canvas} className="pipe-cv" aria-hidden="true" />
      {STAGES.map((s, i) => (
        <div key={s.key} className={`pipe-cell ${i >= 1 && i <= 3 && (values[i] ?? 0) > 0 ? 'busy' : ''}`} ref={(el) => { cells.current[i] = el }}>
          <div className="pipe-top">
            <span className="pipe-i num">{String(i).padStart(2, '0')}</span>
            <span className="pipe-l">{s.label}</span>
          </div>
          <div className="pipe-v">
            <Count value={values[i]} compact={(values[i] ?? 0) >= 100000} />
          </div>
          <div className="pipe-sub">
            {i === 6 && live && model.step > 0 ? `loss ${model.loss.toFixed(3)}` : i === 5 ? `${acceptRate === null ? DASH : acceptRate.toFixed(0)}% accept` : s.sub}
          </div>
          {i < STAGES.length - 1 && <span className="pipe-arrow" aria-hidden="true">▸</span>}
        </div>
      ))}
      <div className="pipe-reject">
        <span className="label">rejected</span>
        <span className="num">{fmtInt(live ? stats.rejected : null)}</span>
        <span className="label">errors</span>
        <span className="num">{fmtInt(live ? stats.errors : null)}</span>
      </div>
    </div>
  )
}
