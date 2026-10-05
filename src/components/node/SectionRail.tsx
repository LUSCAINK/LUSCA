import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { scrollToId } from './util'

export interface RailSection {
  id: string
  label: string
}

/**
 * Sticky section index in the left margin. Each section owns an equal slice of
 * the track; the marker and orange trail follow the scroll position, written
 * straight to the DOM so scrolling never re-renders React. Also publishes
 * --depth (0..1 page progress) on the page root for the background fade.
 */
export function SectionRail({ root, sections }: { root: RefObject<HTMLElement | null>; sections: RailSection[] }) {
  const marker = useRef<HTMLDivElement>(null)
  const trail = useRef<HTMLDivElement>(null)
  const links = useRef<(HTMLAnchorElement | null)[]>([])

  useEffect(() => {
    let raf = 0
    let lastActive = -1
    const measure = () => {
      raf = 0
      const page = root.current
      if (!page) return
      const probe = window.scrollY + window.innerHeight * 0.3
      const tops = sections.map((s) => {
        const el = document.getElementById(s.id)
        return el ? el.getBoundingClientRect().top + window.scrollY : Number.POSITIVE_INFINITY
      })
      const rect = page.getBoundingClientRect()
      const end = Math.max(rect.bottom + window.scrollY - window.innerHeight * 0.7, (tops[tops.length - 1] ?? 0) + 1)
      let i = 0
      for (let k = 0; k < tops.length; k++) if (tops[k] <= probe) i = k
      const lo = tops[i]
      const hi = i + 1 < tops.length ? tops[i + 1] : end
      const frac = Number.isFinite(lo) && hi > lo ? Math.max(0, Math.min(1, (probe - lo) / (hi - lo))) : 0
      const pos = (i + frac) / sections.length
      if (marker.current) marker.current.style.top = `${(pos * 100).toFixed(3)}%`
      if (trail.current) trail.current.style.transform = `scaleY(${pos.toFixed(4)})`
      if (i !== lastActive) {
        lastActive = i
        links.current.forEach((a, k) => {
          if (!a) return
          a.classList.toggle('on', k === i)
          if (k === i) a.setAttribute('aria-current', 'true')
          else a.removeAttribute('aria-current')
        })
      }
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
      page.style.setProperty('--depth', Math.min(1, window.scrollY / max).toFixed(3))
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    const ro = typeof ResizeObserver !== 'undefined' && root.current ? new ResizeObserver(onScroll) : null
    if (ro && root.current) ro.observe(root.current)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      ro?.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [root, sections])

  return (
    <aside className="rail">
      <nav className="rail-in" aria-label="Sections on this page">
        <div className="rail-cap mono">on this page</div>
        <div className="rail-track">
          <div className="rail-trail" ref={trail} aria-hidden="true" />
          {sections.map((s, i) => (
            <a
              key={s.id}
              ref={(el) => {
                links.current[i] = el
              }}
              href={`#${s.id}`}
              className="rail-seg"
              style={{ top: `${(i / sections.length) * 100}%`, height: `${100 / sections.length}%` }}
              onClick={(e) => {
                e.preventDefault()
                scrollToId(s.id)
              }}
            >
              <span className="rail-z mono">{s.label}</span>
            </a>
          ))}
          <div className="rail-marker" ref={marker} aria-hidden="true">
            <i />
          </div>
        </div>
      </nav>
    </aside>
  )
}
