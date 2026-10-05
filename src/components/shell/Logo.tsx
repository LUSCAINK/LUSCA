import { useEffect, useRef } from 'react'
import { bus } from '@/lib/bus'

/**
 * LUSCA mark: a mantle dome with a visor slit over eight bars. The bars are the
 * arms — when `live`, each one twitches with its sector's ingest activity.
 */
export function Logo({ size = 24, live = false, color = 'currentColor' }: { size?: number; live?: boolean; color?: string }) {
  const bars = useRef<(SVGRectElement | null)[]>([])
  const level = useRef<number[]>([0.55, 0.75, 0.9, 1, 1, 0.9, 0.75, 0.55])

  useEffect(() => {
    if (!live) return
    const base = [0.55, 0.75, 0.9, 1, 1, 0.9, 0.75, 0.55]
    const boost = new Array(8).fill(0)
    const off = bus.on('page', (m) => {
      boost[m.page.sector % 8] = 1
    })
    const offA = bus.on('agent', (m) => {
      if (m.agent.state === 'fetch') boost[m.agent.sector % 8] = Math.max(boost[m.agent.sector % 8], 0.45)
    })
    let raf = 0
    const t0 = performance.now()
    const loop = (t: number) => {
      const s = (t - t0) / 1000
      for (let i = 0; i < 8; i++) {
        boost[i] *= 0.94
        const wave = 0.06 * Math.sin(s * 2.2 + i * 0.8)
        const target = Math.min(1.25, base[i] + wave + boost[i] * 0.45)
        level.current[i] += (target - level.current[i]) * 0.2
        const el = bars.current[i]
        if (el) {
          const h = 11 * level.current[i]
          el.setAttribute('height', h.toFixed(2))
          el.setAttribute('fill', boost[i] > 0.3 ? 'var(--hot)' : color)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      off()
      offA()
    }
  }, [live, color])

  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      {/* mantle */}
      <path d="M4 13 A10 10 0 0 1 24 13 Z" fill={color} />
      {/* visor */}
      <rect x="8" y="8.6" width="12" height="1.6" fill="var(--bg)" />
      {/* arms */}
      {Array.from({ length: 8 }, (_, i) => (
        <rect
          key={i}
          ref={(el) => {
            bars.current[i] = el
          }}
          x={4.35 + i * 2.5}
          y={14}
          width={1.3}
          height={11 * [0.55, 0.75, 0.9, 1, 1, 0.9, 0.75, 0.55][i]}
          fill={color}
        />
      ))}
    </svg>
  )
}
