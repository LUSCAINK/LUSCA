import { useEffect, useState } from 'react'
import { Logo } from './Logo'
import { SECTORS } from '@shared/sectors'

const LINES = [
  'lusca · connecting to server',
  ...SECTORS.map((s) => `arm ${s.roman.padEnd(4, ' ')} ${s.name.toLowerCase()}`),
  'mantle · sepia-0',
  'neurons',
]

/** One-shot boot sequence on first visit per session. Click to skip. */
export function Boot() {
  const [show, setShow] = useState(() => {
    try {
      if (sessionStorage.getItem('lusca.booted')) return false
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
      return true
    } catch {
      return false
    }
  })
  const [n, setN] = useState(0)
  const [out, setOut] = useState(false)

  useEffect(() => {
    if (!show) return
    try {
      sessionStorage.setItem('lusca.booted', '1')
    } catch {
      /* ignore */
    }
    const id = window.setInterval(() => setN((x) => x + 1), 95)
    const t1 = window.setTimeout(() => setOut(true), LINES.length * 95 + 380)
    const t2 = window.setTimeout(() => setShow(false), LINES.length * 95 + 1100)
    return () => {
      window.clearInterval(id)
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [show])

  if (!show) return null
  return (
    <div className={`boot ${out ? 'boot-out' : ''}`} onClick={() => setShow(false)} role="presentation">
      <div className="boot-in">
        <div className="boot-logo">
          <Logo size={44} live />
          <span className="boot-word">LUSCA</span>
        </div>
        <pre className="boot-lines">
          {LINES.slice(0, n).map((l, i) => (
            <div key={i}>
              <span className="boot-ok">{i === 0 ? '›' : '■'}</span> {l}
            </div>
          ))}
        </pre>
        <div className="boot-bar">
          <i style={{ width: `${Math.min(100, (n / LINES.length) * 100)}%` }} />
        </div>
      </div>
    </div>
  )
}
