// The LUSCA mark as particles — a dome with a visor slit over eight vertical bars of graduated
// length (outer bars shortest), rasterised onto the braille dot grid and snapped to it so the
// bars stay crisp: bar pitch is an even number of dots and the origin snaps to an even x and a
// cell row, so every bar fills whole braille columns. The bar grid quantises the size: the mark
// is never taller than h (bars shorten a little at small sizes) and is centred vertically in it.
// Reads from h ≈ 16 dots (4 rows); needs h ≥ 12.
//
// logoMark(c, x, y, h, progress, tMs)
//   (x, y)    top-left of the mark in dot coordinates (snapped to even x / multiple-of-4 y)
//   h         height in dots; width ≈ 0.91·h (logoWidth(h) gives the exact value)
//   progress  0 → particles scattered around the mark, dim bone; 1 → assembled, orange.
//             Each particle flies home on its own delay and flares white-hot as it lands.
//   tMs       drives the scattered drift and, once assembled, a gentle breath plus a slow
//             highlight that sweeps down the bars.
// Deterministic: particle starts and delays come from a seeded PRNG per size.

import type { BrailleCanvas } from './canvas.ts'
import { RAMP_LUT } from './theme.ts'

interface Mark {
  w: number
  h: number
  n: number
  tx: Float32Array // target dot x
  ty: Float32Array
  sx: Float32Array // scattered start
  sy: Float32Array
  delay: Float32Array
  spin: Float32Array
  bar: Int8Array // -1 dome, 0..7 bar index
}

const cache = new Map<number, Mark>()

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function geometry(h: number) {
  // Even bar pitch so every bar sits on whole braille columns (crisp in fonts that gap cells):
  // pick the pitch whose mark width is closest to the true proportion (w ≈ 0.907·h), then derive
  // the mark's own height from that width so the dome / bar proportions never distort.
  let pitch = 2
  for (let p = 4; p < 64; p += 2) {
    if (Math.abs(7.5 * p - 0.907 * h) < Math.abs(7.5 * pitch - 0.907 * h)) pitch = p
    else break
  }
  const barW = pitch / 2
  const w = 8 * pitch - barW
  const R = w / 2
  const H = Math.max(8, Math.round(w / 0.907)) // the mark's real height
  const domeH = Math.max(3, Math.round(R))
  const gapY = Math.max(1, Math.round(R * 0.1))
  const barTop = domeH + gapY
  // bar lengths in the mark's proportions, shortened if needed so the mark never exceeds h
  const longest = Math.max(2, Math.min(Math.round(0.5 * H), h - barTop))
  const lens = [0.55, 0.748, 0.9, 1].map((f) => Math.max(1, Math.round(f * longest)))
  const visW = Math.max(3, Math.round(w * 0.6))
  const visH = Math.max(1, Math.round(R * 0.2))
  const visY = Math.round(R * 0.56)
  return { pitch, barW, w, R, H: barTop + lens[3], domeH, barTop, lens, visW, visH, visY }
}

/** Width in dots of a mark drawn with height h. */
export function logoWidth(h: number): number {
  return geometry(Math.max(4, Math.round(h))).w
}

/** Actual height in dots of a mark drawn with height h (the bar grid snaps the size; the mark
 *  is centred vertically inside the requested h). */
export function logoHeight(h: number): number {
  return geometry(Math.max(4, Math.round(h))).H
}

function build(h: number): Mark {
  const g = geometry(h)
  const tx: number[] = []
  const ty: number[] = []
  const bar: number[] = []
  // dome: semicircle of radius R sitting on y = domeH, minus the visor slit
  const visX0 = Math.round((g.w - g.visW) / 2)
  for (let y = 0; y < g.domeH; y++) {
    for (let x = 0; x < g.w; x++) {
      const dx = x + 0.5 - g.R
      const dy = g.domeH - (y + 0.5)
      if (dx * dx + dy * dy > g.R * g.R + 0.15 * g.R) continue
      if (y >= g.visY && y < g.visY + g.visH && x >= visX0 && x < visX0 + g.visW) continue
      tx.push(x)
      ty.push(y)
      bar.push(-1)
    }
  }
  // bars: outer → inner lengths, mirrored
  for (let b = 0; b < 8; b++) {
    const len = g.lens[b < 4 ? b : 7 - b]
    const x0 = b * g.pitch
    for (let y = 0; y < len; y++) {
      for (let x = 0; x < g.barW; x++) {
        tx.push(x0 + x)
        ty.push(g.barTop + y)
        bar.push(b)
      }
    }
  }
  const n = tx.length
  const rnd = mulberry32(0x1a5c + h * 7919)
  const m: Mark = {
    w: g.w,
    h: g.H,
    n,
    tx: Float32Array.from(tx),
    ty: Float32Array.from(ty),
    sx: new Float32Array(n),
    sy: new Float32Array(n),
    delay: new Float32Array(n),
    spin: new Float32Array(n),
    bar: Int8Array.from(bar),
  }
  const cxm = g.w / 2
  const cym = m.h / 2
  for (let i = 0; i < n; i++) {
    // scattered around the mark on a loose ring, biased outward
    const a = rnd() * Math.PI * 2
    const r = (0.55 + Math.pow(rnd(), 0.6) * 0.9) * m.h
    m.sx[i] = cxm + Math.cos(a) * r * 1.15
    m.sy[i] = cym + Math.sin(a) * r * 0.75
    // bars assemble first (bottom-up feel), dome closes over them
    const order = m.bar[i] >= 0 ? 0.05 + (1 - m.ty[i] / m.h) * 0.15 : 0.22 + (1 - m.ty[i] / g.domeH) * 0.22
    m.delay[i] = Math.min(0.5, order + rnd() * 0.12)
    m.spin[i] = (rnd() - 0.5) * 2
  }
  return m
}

function getMark(h: number): Mark {
  let m = cache.get(h)
  if (!m) {
    if (cache.size > 16) cache.clear()
    m = build(h)
    cache.set(h, m)
  }
  return m
}

const DUR = 0.5 // share of progress each particle spends in flight

/** Draw the LUSCA mark (dome + visor + 8 graduated bars) as particles. See file header. */
export function logoMark(c: BrailleCanvas, x: number, y: number, h: number, progress: number, tMs: number): void {
  const hh = Math.max(4, Math.round(h))
  const m = getMark(hh)
  const t = tMs / 1000
  const p = progress <= 0 ? 0 : progress >= 1 ? 1 : progress
  // snap to the cell grid: x to an even dot, y to a cell row
  const ox = Math.round(x / 2) * 2
  const oy = Math.round((y + Math.max(0, hh - m.h) / 2) / 4) * 4
  const done = p >= 1
  const breath = 0.86 + 0.14 * Math.sin(t * ((Math.PI * 2) / 3.6))
  const sweep = ((t / 6.5) % 1) * (m.h + 10) - 5 // highlight band position (dots)
  for (let i = 0; i < m.n; i++) {
    const q = (p - m.delay[i]) / DUR
    let e: number
    let px: number
    let py: number
    if (q >= 1 || done) {
      e = 1
      px = m.tx[i]
      py = m.ty[i]
    } else {
      const k = q <= 0 ? 0 : q
      e = 1 - Math.pow(1 - k, 3)
      // drift while waiting, swirl while flying
      const d = (1 - e) * 1.6
      const wob = Math.sin(t * 0.7 + i * 1.7) * d
      const wob2 = Math.cos(t * 0.55 + i * 2.3) * d
      const dx = m.tx[i] - m.sx[i]
      const dy = m.ty[i] - m.sy[i]
      const sw = Math.sin(Math.PI * e) * 0.22 * m.spin[i]
      px = m.sx[i] + dx * e - dy * sw + wob
      py = m.sy[i] + dy * e + dx * sw + wob2
    }
    let heat: number
    let a: number
    if (e >= 1) {
      // landed: orange, flare as it arrives, then breathe
      const since = done ? 1 : (q - 1) * DUR // progress elapsed since landing
      const land = since < 0.12 ? 1 - since / 0.12 : 0
      const band = Math.exp(-((m.ty[i] - sweep) * (m.ty[i] - sweep)) / 6)
      heat = 0.5 + 0.42 * land + (done ? 0.07 * band : 0)
      a = (done ? breath : 1) * (0.95 + 0.3 * land + (done ? 0.12 * band : 0))
    } else {
      heat = 0.08 + 0.3 * e
      a = 0.25 + 0.55 * e
    }
    const ci = heat <= 0 ? 0 : heat >= 1 ? 255 : (heat * 255) | 0
    c.plot(ox + px, oy + py, RAMP_LUT[ci], a)
  }
}
