// CODE ATLAS — /atlas: every program and contract the chain agents kept, placed by what it shares with the
// others (ABI function and event names, IDL instructions, source file stems). Near = similar code surface.
//
// Data: GET /api/atlas (columnar map, quantized 0..10000, re-polled every 12 s; the server places new items next
// to their nearest neighbour between full layouts), GET /api/chain/feed (cached, every 4 s: kept reads pulse in),
// GET /api/atlas/item/:chain/:address when a dot is opened (closest relatives, functions that differ).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ChainId } from '@shared/chain'
import type { AtlasItem, AtlasMap } from '@shared/atlas'
import { CHAIN_LABEL } from '@/lib/chain'
import { fmtInt } from '@/lib/format'
import './atlas.css'
import { NAV_N } from '@/lib/nav'

const ACCENT = '#ff4d00'
const CHAIN_RGB: Record<string, [number, number, number]> = {
  solana: [255, 77, 0],
  ethereum: [236, 235, 230],
  base: [201, 199, 192],
  arbitrum: [163, 161, 153],
}
const W = 10000
const MAP_POLL_MS = 12_000
const FEED_POLL_MS = 4_000

interface Pt {
  key: string
  chain: ChainId
  address: string
  name: string
  k: number
  vf: boolean
  x: number // target (world)
  y: number
  px: number // drawn (world)
  py: number
  born: number // ms: fly-in start
  pulse: number // ms: last pulse
  pulseHot: boolean
  nn: Pt | null
}
interface Cam { x: number; y: number; z: number }
interface FeedRow { id: string; ts: number; chain: ChainId; address: string; name: string | null; verdict: string }

const keyOf = (c: string, a: string) => `${c}:${c === 'solana' ? a : a.toLowerCase()}`
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a)
const label = (p: { name: string | null | undefined; address: string }) => p.name || short(p.address)

export default function Atlas() {
  useEffect(() => {
    document.title = 'Atlas — LUSCA'
  }, [])
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pts = useRef<Pt[]>([])
  const byKey = useRef(new Map<string, Pt>())
  const clustersRef = useRef<AtlasMap['clusters']>([])
  const cam = useRef<Cam>({ x: W / 2, y: W / 2, z: 1 })
  const camT = useRef<Cam>({ x: W / 2, y: W / 2, z: 1 })
  const hoverRef = useRef<Pt | null>(null)
  const selRef = useRef<Pt | null>(null)
  const relRef = useRef<Pt[]>([])
  const firstLoad = useRef(0)
  const [map, setMap] = useState<AtlasMap | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [hover, setHover] = useState<{ p: Pt; sx: number; sy: number } | null>(null)
  const [sel, setSel] = useState<Pt | null>(null)
  const [item, setItem] = useState<AtlasItem | null>(null)
  const [itemErr, setItemErr] = useState<string | null>(null)
  const [ticker, setTicker] = useState<FeedRow[]>([])
  const seenFeed = useRef(new Set<string>())
  const pendingPulse = useRef(new Map<string, number>())
  const focusRef = useRef<((p: Pt) => void) | null>(null)

  // ── data: map ──
  const loadMap = useCallback(async () => {
    try {
      const r = await fetch('/api/atlas')
      if (!r.ok) throw new Error(r.status === 503 ? 'The atlas is not available on this server.' : `HTTP ${r.status}`)
      const m = (await r.json()) as AtlasMap
      const now = performance.now()
      const first = pts.current.length === 0
      if (first) firstLoad.current = now
      const next: Pt[] = []
      const nextMap = new Map<string, Pt>()
      for (let i = 0; i < m.n; i++) {
        const chain = m.chains[m.c[i]] ?? 'ethereum'
        const key = keyOf(chain, m.a[i])
        const old = byKey.current.get(key)
        const p: Pt = old ?? {
          key, chain, address: m.a[i], name: m.name[i], k: m.k[i], vf: m.vf[i] === 1,
          x: m.x[i], y: m.y[i],
          px: first ? W / 2 + (m.x[i] - W / 2) * 0.04 : m.x[i], py: first ? W / 2 + (m.y[i] - W / 2) * 0.04 : m.y[i],
          born: first ? now + Math.min(1400, (Math.hypot(m.x[i] - W / 2, m.y[i] - W / 2) / W) * 2400) : now,
          pulse: first ? 0 : now, pulseHot: !first, nn: null,
        }
        p.x = m.x[i]; p.y = m.y[i]; p.k = m.k[i]; p.name = m.name[i]; p.vf = m.vf[i] === 1
        if (!old && !first) { // a new read flies in from just outside its spot
          const a = (i * 2.399963) % (Math.PI * 2)
          p.px = p.x + Math.cos(a) * 900; p.py = p.y + Math.sin(a) * 900
        }
        const pend = pendingPulse.current.get(key)
        if (pend != null) { p.pulse = now; p.pulseHot = true; pendingPulse.current.delete(key) }
        next.push(p); nextMap.set(key, p)
      }
      next.forEach((p, i) => { const j = m.e?.[i] ?? -1; p.nn = j >= 0 ? next[j] ?? null : null })
      pts.current = next
      byKey.current = nextMap
      clustersRef.current = m.clusters
      setMap(m)
      setErr(null)
      if (first) {
        // /atlas?focus=<chain>:<address> opens that item (shareable view)
        const f = new URLSearchParams(window.location.search).get('focus')
        const i = f ? f.indexOf(':') : -1
        const fp = i > 0 ? nextMap.get(keyOf(f!.slice(0, i), f!.slice(i + 1))) : undefined
        if (fp) setTimeout(() => focusRef.current?.(fp), 1800)
      }
    } catch (e) {
      setErr((e as Error)?.message ?? 'The atlas could not be loaded.')
    }
  }, [])

  useEffect(() => {
    void loadMap()
    const t = setInterval(() => { if (!document.hidden) void loadMap() }, MAP_POLL_MS)
    return () => clearInterval(t)
  }, [loadMap])

  // ── data: live feed (cached server-side) ──
  useEffect(() => {
    let alive = true
    let first = true
    const tick = async () => {
      if (document.hidden) return
      try {
        const r = await fetch('/api/chain/feed?limit=30')
        if (!r.ok) return
        const rows = (await r.json()) as FeedRow[]
        if (!alive || !Array.isArray(rows)) return
        const fresh = rows.filter((e) => !seenFeed.current.has(e.id))
        for (const e of rows) seenFeed.current.add(e.id)
        if (first) { first = false; setTicker(rows.filter((e) => e.verdict === 'kept').slice(0, 5)); return }
        const now = performance.now()
        let newKept = false
        for (const e of fresh) {
          const p = byKey.current.get(keyOf(e.chain, e.address))
          if (p) { p.pulse = now; p.pulseHot = e.verdict === 'kept' }
          else if (e.verdict === 'kept') { pendingPulse.current.set(keyOf(e.chain, e.address), now); newKept = true }
        }
        const kept = fresh.filter((e) => e.verdict === 'kept')
        if (kept.length) setTicker((t) => [...kept, ...t].slice(0, 5))
        if (newKept) setTimeout(() => void loadMap(), 6_000)
      } catch { /* next tick */ }
    }
    void tick()
    const t = setInterval(tick, FEED_POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [loadMap])

  // ── selection ──
  const select = useCallback((p: Pt | null, fly = false) => {
    selRef.current = p
    relRef.current = []
    setSel(p)
    setItem(null)
    setItemErr(null)
    if (!p) return
    if (fly) camT.current = { x: p.x, y: p.y, z: Math.max(camT.current.z, 4) }
    fetch(`/api/atlas/item/${p.chain}/${p.address}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'Not on the atlas yet.' : `HTTP ${r.status}`)
        return (await r.json()) as AtlasItem
      })
      .then((it) => {
        if (selRef.current !== p) return
        setItem(it)
        relRef.current = it.relatives.map((r) => byKey.current.get(keyOf(r.chain, r.address))).filter((x): x is Pt => !!x)
      })
      .catch((e: Error) => { if (selRef.current === p) setItemErr(e.message) })
  }, [])

  // ── render loop + interaction ──
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    let w = 0, h = 0, dpr = 1
    const resize = () => {
      const r = wrap.getBoundingClientRect()
      dpr = Math.min(2, window.devicePixelRatio || 1)
      w = r.width; h = r.height
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    // glow sprites per chain
    const sprites: Record<string, HTMLCanvasElement> = {}
    for (const [c, [r, g, b]] of Object.entries(CHAIN_RGB)) {
      const s = document.createElement('canvas')
      s.width = s.height = 64
      const g2 = s.getContext('2d')!
      const grad = g2.createRadialGradient(32, 32, 0, 32, 32, 32)
      grad.addColorStop(0, `rgba(${r},${g},${b},0.55)`)
      grad.addColorStop(0.25, `rgba(${r},${g},${b},0.18)`)
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
      g2.fillStyle = grad
      g2.fillRect(0, 0, 64, 64)
      sprites[c] = s
    }

    const base = () => (Math.min(w, h) / W) * 0.9
    const toScreen = (x: number, y: number): [number, number] => {
      const s = base() * cam.current.z
      return [w / 2 + (x - cam.current.x) * s, h / 2 + (y - cam.current.y) * s]
    }
    const toWorld = (sx: number, sy: number): [number, number] => {
      const s = base() * camT.current.z
      return [camT.current.x + (sx - w / 2) / s, camT.current.y + (sy - h / 2) / s]
    }
    const pick = (sx: number, sy: number): Pt | null => {
      let best: Pt | null = null, bd = 14 * 14
      for (const p of pts.current) {
        const [x, y] = toScreen(p.px, p.py)
        const d = (x - sx) ** 2 + (y - sy) ** 2
        if (d < bd) { bd = d; best = p }
      }
      return best
    }

    const frame = () => {
      raf = requestAnimationFrame(frame)
      const now = performance.now()
      const c = cam.current, t = camT.current
      c.x += (t.x - c.x) * 0.16; c.y += (t.y - c.y) * 0.16; c.z += (t.z - c.z) * 0.16
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#050505'
      ctx.fillRect(0, 0, w, h)
      const s = base() * c.z

      // faint world grid
      const step = c.z > 6 ? 125 : c.z > 2.5 ? 250 : 500
      ctx.strokeStyle = 'rgba(236,235,230,0.035)'
      ctx.lineWidth = 1
      ctx.beginPath()
      const [wx0, wy0] = [c.x - w / 2 / s, c.y - h / 2 / s]
      const [wx1, wy1] = [c.x + w / 2 / s, c.y + h / 2 / s]
      for (let gx = Math.max(0, Math.floor(wx0 / step) * step); gx <= Math.min(W, wx1); gx += step) {
        const x = Math.round(w / 2 + (gx - c.x) * s) + 0.5
        ctx.moveTo(x, Math.max(0, h / 2 + (0 - c.y) * s)); ctx.lineTo(x, Math.min(h, h / 2 + (W - c.y) * s))
      }
      for (let gy = Math.max(0, Math.floor(wy0 / step) * step); gy <= Math.min(W, wy1); gy += step) {
        const y = Math.round(h / 2 + (gy - c.y) * s) + 0.5
        ctx.moveTo(Math.max(0, w / 2 + (0 - c.x) * s), y); ctx.lineTo(Math.min(w, w / 2 + (W - c.x) * s), y)
      }
      ctx.stroke()

      // nearest-neighbour links (faint constellation)
      ctx.lineWidth = 1
      ctx.strokeStyle = `rgba(236,235,230,${selRef.current ? 0.025 : 0.07})`
      ctx.beginPath()
      for (const p of pts.current) {
        const q = p.nn
        if (!q || now < p.born + 600 || now < q.born + 600) continue
        if (Math.abs(p.px - q.px) + Math.abs(p.py - q.py) > 900) continue // long links read as noise
        ctx.moveTo(w / 2 + (p.px - c.x) * s, h / 2 + (p.py - c.y) * s)
        ctx.lineTo(w / 2 + (q.px - c.x) * s, h / 2 + (q.py - c.y) * s)
      }
      ctx.stroke()

      // relations of the selected dot
      const selP = selRef.current
      if (selP && relRef.current.length) {
        const [sx, sy] = toScreen(selP.px, selP.py)
        ctx.lineWidth = 1
        for (const r of relRef.current) {
          const [rx, ry] = toScreen(r.px, r.py)
          const g = ctx.createLinearGradient(sx, sy, rx, ry)
          g.addColorStop(0, 'rgba(255,77,0,0.85)')
          g.addColorStop(1, 'rgba(255,77,0,0.12)')
          ctx.strokeStyle = g
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(rx, ry); ctx.stroke()
        }
      }

      // dots
      const r0 = Math.max(2, Math.min(5, 1.5 + Math.sqrt(c.z) * 0.9)) * (w < 600 ? 0.8 : 1)
      const dim = selP ? 0.35 : 1
      for (const p of pts.current) {
        const age = now - p.born
        if (age < 0) continue
        const k = Math.min(1, age / 900)
        const e = 1 - Math.pow(1 - k, 3)
        p.px += (p.x - p.px) * (k < 1 ? 0.06 + e * 0.1 : 0.12)
        p.py += (p.y - p.py) * (k < 1 ? 0.06 + e * 0.1 : 0.12)
        const x = w / 2 + (p.px - c.x) * s, y = h / 2 + (p.py - c.y) * s
        if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue
        const [cr, cg, cb] = CHAIN_RGB[p.chain] ?? CHAIN_RGB.ethereum
        const isRel = selP && (p === selP || relRef.current.includes(p))
        const a = (isRel ? 1 : dim) * (0.35 + 0.65 * e)
        const halo = r0 * (p.chain === 'solana' ? 6 : 4.5)
        ctx.globalAlpha = a * (p.chain === 'solana' ? 1 : 0.7)
        ctx.drawImage(sprites[p.chain] ?? sprites.ethereum, x - halo, y - halo, halo * 2, halo * 2)
        ctx.globalAlpha = a
        ctx.fillStyle = `rgb(${cr},${cg},${cb})`
        ctx.beginPath(); ctx.arc(x, y, r0 / 2 + 0.25, 0, Math.PI * 2); ctx.fill()
        // pulse ring
        const pa = now - p.pulse
        if (p.pulse && pa < 2600) {
          const q = pa / 2600
          ctx.globalAlpha = (1 - q) * 0.9
          ctx.strokeStyle = p.pulseHot ? ACCENT : '#ecebe6'
          ctx.lineWidth = 1.2
          ctx.beginPath(); ctx.arc(x, y, 4 + q * 34, 0, Math.PI * 2); ctx.stroke()
          ctx.globalAlpha = (1 - q)
          ctx.fillStyle = p.pulseHot ? ACCENT : '#ecebe6'
          ctx.fillRect(x - r0, y - r0, r0 * 2, r0 * 2)
        }
      }
      ctx.globalAlpha = 1

      // hover + selection rings
      for (const [p, col] of [[hoverRef.current, 'rgba(236,235,230,0.9)'], [selP, ACCENT]] as [Pt | null, string][]) {
        if (!p) continue
        const [x, y] = toScreen(p.px, p.py)
        ctx.strokeStyle = col
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke()
      }

      // cluster labels: bigger clusters first, faded by on-screen size, no overlaps
      const intro = Math.min(1, (now - firstLoad.current - 1200) / 900)
      if (intro > 0) {
        ctx.font = `500 ${w < 600 ? 9 : 11}px "Geist Mono Variable", "Geist Mono", ui-monospace, monospace`
        ctx.textBaseline = 'middle'
        const boxes: [number, number, number, number][] = []
        const sorted = [...clustersRef.current].sort((a, b) => b.n - a.n)
        let shown = 0
        for (const cl of sorted) {
          const vis = cl.n * c.z * c.z
          let a = Math.min(1, (vis - 14) / 30)
          if (c.z > 5 && cl.n > 60) a *= Math.max(0.25, 1 - (c.z - 5) / 6) // the biggest names step back up close
          if (a <= 0.02) continue
          const txt = cl.label.toUpperCase()
          const [x, y] = toScreen(cl.x, cl.y)
          if (x < -100 || x > w + 100 || y < -20 || y > h + 20) continue
          const tw = ctx.measureText(txt).width + 30
          const box: [number, number, number, number] = [x - tw / 2, y - 11, x + tw / 2, y + 11]
          if (boxes.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue
          boxes.push(box)
          ctx.globalAlpha = a * intro * (selP ? 0.4 : 1)
          ctx.fillStyle = 'rgba(5,5,5,0.62)'
          ctx.fillRect(box[0] + 6, box[1] + 2, tw - 12, 18)
          ctx.fillStyle = '#ecebe6'
          ctx.textAlign = 'center'
          ctx.fillText(txt, x - 8, y + 1)
          ctx.fillStyle = '#77756f'
          ctx.textAlign = 'left'
          ctx.fillText(String(cl.n), x - 8 + (tw - 30) / 2 + 6, y + 1)
          if (++shown > 40) break
        }
        ctx.globalAlpha = 1
      }
    }
    raf = requestAnimationFrame(frame)

    // pointer: drag to pan, pinch to zoom, click to select
    const pointers = new Map<number, { x: number; y: number }>()
    let downAt: { x: number; y: number; t: number } | null = null
    let pinch: { d: number; z: number } | null = null
    const rel = (e: PointerEvent | WheelEvent) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as [number, number] }
    const clampCam = () => {
      const t = camT.current
      t.z = Math.max(0.6, Math.min(40, t.z))
      t.x = Math.max(0, Math.min(W, t.x)); t.y = Math.max(0, Math.min(W, t.y))
    }
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId)
      const [x, y] = rel(e)
      pointers.set(e.pointerId, { x, y })
      if (pointers.size === 1) downAt = { x, y, t: performance.now() }
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: camT.current.z }
        downAt = null
      }
    }
    const onMove = (e: PointerEvent) => {
      const [x, y] = rel(e)
      const prev = pointers.get(e.pointerId)
      if (!prev) {
        const p = pick(x, y)
        hoverRef.current = p
        setHover(p ? { p, sx: x, sy: y } : null)
        canvas.style.cursor = p ? 'pointer' : 'grab'
        return
      }
      pointers.set(e.pointerId, { x, y })
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        camT.current.z = pinch.z * (d / Math.max(1, pinch.d))
        clampCam()
        return
      }
      const s = base() * camT.current.z
      camT.current.x -= (x - prev.x) / s
      camT.current.y -= (y - prev.y) / s
      cam.current.x = camT.current.x; cam.current.y = camT.current.y
      clampCam()
      canvas.style.cursor = 'grabbing'
      hoverRef.current = null
      setHover(null)
    }
    const onUp = (e: PointerEvent) => {
      const [x, y] = rel(e)
      pointers.delete(e.pointerId)
      if (pointers.size < 2) pinch = null
      if (downAt && Math.hypot(x - downAt.x, y - downAt.y) < 5 && performance.now() - downAt.t < 500) select(pick(x, y))
      downAt = null
      canvas.style.cursor = 'grab'
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const [x, y] = rel(e)
      const [wx, wy] = toWorld(x, y)
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018))
      const t = camT.current
      const z = Math.max(0.6, Math.min(40, t.z * f))
      const k = t.z / z
      t.x = wx - (wx - t.x) * k; t.y = wy - (wy - t.y) * k; t.z = z
      clampCam()
    }
    const onLeave = () => { hoverRef.current = null; setHover(null) }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [select])

  useEffect(() => {
    focusRef.current = (p) => select(p, true)
  }, [select])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') select(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [select])

  const zoom = (f: number) => { camT.current.z = Math.max(0.6, Math.min(40, camT.current.z * f)) }
  const reset = () => { camT.current = { x: W / 2, y: W / 2, z: 1 } }
  const chains = map ? map.chains.filter((c) => (map.byChain[c] ?? 0) > 0) : []
  const named = map ? map.clusters.length : 0

  return (
    <section className="at">
      <div className="at-stage" ref={wrapRef}>
        <canvas ref={canvasRef} className="at-canvas" aria-label="Map of every program and contract the chain agents kept" />
        <span className="at-tick at-tick--tl" /><span className="at-tick at-tick--tr" /><span className="at-tick at-tick--bl" /><span className="at-tick at-tick--br" />

        <header className="at-head">
          <div className="at-kick"><span className="at-dot" /><span className="at-kick-n">[{NAV_N.atlas}]</span> CODE ATLAS · LIVE</div>
          <h1 className="at-title">Atlas</h1>
          <p className="at-lede">Every program and contract the agents kept, placed by the functions, events and instructions it shares with the others. Close together means a similar code surface.</p>
        </header>

        <dl className="at-stats">
          <div><dt>ITEMS MAPPED</dt><dd>{map ? fmtInt(map.n) : '—'}</dd></div>
          <div><dt>CLUSTERS</dt><dd>{map ? fmtInt(named) : '—'}</dd></div>
          <div><dt>CHAINS</dt><dd>{map ? chains.length : '—'}</dd></div>
          <ul className="at-legend">
            {(map ? map.chains : []).map((c) => (
              <li key={c}><i style={{ background: `rgb(${(CHAIN_RGB[c] ?? CHAIN_RGB.ethereum).join(',')})` }} />{CHAIN_LABEL[c] ?? c}<b>{fmtInt(map?.byChain[c] ?? 0)}</b></li>
            ))}
          </ul>
        </dl>

        <div className="at-live">
          <div className="at-live-h">KEPT · LATEST</div>
          {ticker.length === 0 && <div className="at-live-empty">Waiting for the next kept read.</div>}
          <ol>
            {ticker.map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => { const p = byKey.current.get(keyOf(e.chain, e.address)); if (p) select(p, true) }}>
                  <i style={{ background: `rgb(${(CHAIN_RGB[e.chain] ?? CHAIN_RGB.ethereum).join(',')})` }} />
                  <span className="at-live-n">{label(e)}</span>
                  <span className="at-live-c">{(CHAIN_LABEL[e.chain] ?? e.chain).toUpperCase()}</span>
                  <span className="at-live-s">{byKey.current.has(keyOf(e.chain, e.address)) ? 'MAPPED' : 'PLACING'}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>

        <div className="at-ctl">
          <span className="at-hint">DRAG · SCROLL · CLICK A DOT</span>
          <button type="button" onClick={() => zoom(1.6)} aria-label="Zoom in">+</button>
          <button type="button" onClick={() => zoom(1 / 1.6)} aria-label="Zoom out">−</button>
          <button type="button" onClick={reset} aria-label="Reset view">FIT</button>
        </div>

        {err && !map && <div className="at-empty">{err}</div>}
        {map && map.n === 0 && <div className="at-empty">Nothing mapped yet. The atlas builds from kept reads a few seconds after the server starts.</div>}

        {hover && hover.p !== sel && (
          <div className="at-tip" style={{ left: hover.sx + 14, top: hover.sy + 14 }}>
            <b>{label(hover.p)}</b>
            <span>{(CHAIN_LABEL[hover.p.chain] ?? hover.p.chain).toUpperCase()} · {short(hover.p.address)}</span>
            {hover.p.k >= 0 && map && <span className="at-tip-c">{map.clusters.find((c) => c.id === hover.p.k)?.label ?? ''}</span>}
          </div>
        )}

        {sel && (
          <aside className="at-panel" aria-label="Selected program or contract">
            <button type="button" className="at-x" onClick={() => select(null)} aria-label="Close">×</button>
            <div className="at-p-kick"><i style={{ background: `rgb(${(CHAIN_RGB[sel.chain] ?? CHAIN_RGB.ethereum).join(',')})` }} />{(CHAIN_LABEL[sel.chain] ?? sel.chain).toUpperCase()}{sel.vf ? ' · VERIFIED SOURCE' : ''}</div>
            <h2 className="at-p-name">{label(sel)}</h2>
            <div className="at-p-addr">{sel.address}</div>
            {item?.clusterLabel && <div className="at-p-cl"><span>CLUSTER</span>{item.clusterLabel}</div>}
            {item && (
              <div className="at-p-facts">
                <div><span>FUNCTIONS</span><b>{item.functions}</b></div>
                <div><span>EVENTS</span><b>{item.events}</b></div>
                <div><span>VERIFIED</span><b>{item.verifiedBy === 'osec' ? 'OtterSec' : item.verifiedBy === 'sourcify' ? 'Sourcify' : 'No'}</b></div>
              </div>
            )}
            {item && item.sample.length > 0 && (
              <div className="at-p-chips">{item.sample.map((f) => <code key={f}>{f}</code>)}</div>
            )}
            <div className="at-p-h">CLOSEST RELATIVES</div>
            {!item && !itemErr && <div className="at-p-wait">Reading…</div>}
            {itemErr && <div className="at-p-wait">{itemErr}</div>}
            {item && item.relatives.length === 0 && <div className="at-p-wait">No relative shares a function name yet.</div>}
            <ol className="at-rel">
              {item?.relatives.map((r) => (
                <li key={r.chain + r.address}>
                  <button type="button" onClick={() => { const p = byKey.current.get(keyOf(r.chain, r.address)); if (p) select(p, true) }}>
                    <span className="at-rel-top"><span className="at-rel-n">{label(r)}</span><b>{r.similarity}%</b></span>
                    <span className="at-rel-bar"><i style={{ width: `${r.similarity}%` }} /></span>
                    <span className="at-rel-meta">{(CHAIN_LABEL[r.chain] ?? r.chain).toUpperCase()} · {short(r.address)} · {r.shared} SHARED</span>
                    {(r.onlyHere.length > 0 || r.onlyThere.length > 0) && (
                      <span className="at-rel-diff">
                        {r.onlyHere.slice(0, 3).map((f) => <code key={'h' + f} className="add">+{f}</code>)}
                        {r.onlyThere.slice(0, 3).map((f) => <code key={'t' + f} className="del">−{f}</code>)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ol>
            <Link className="at-p-lens" to={`/lens/${sel.chain}/${sel.address}`}>OPEN IN LENS →</Link>
          </aside>
        )}
      </div>
    </section>
  )
}
