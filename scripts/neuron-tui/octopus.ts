// The LUSCA creature for the terminal: the brand's point-cloud bioluminescent octopus, drawn into
// a BrailleCanvas in the pose of the key art (brand octo_front / video scene 02): seen from above,
// the round mantle sits over the arms at the top, eight arms radiate (I straight up behind the
// mantle, then clockwise II … VIII), each tapering to a curled tip.
//
//  · mantle: an ordered-dither dome (regular dot patterns read as smooth tone in every glyph
//    mode), orange with a limb light and a white-hot core, a slow lidar band sweeping down it and
//    a turning Fibonacci sphere of sparkles that carries a sense of rotation; a narrower head
//    below it carries the two eyes, which blink now and then;
//  · arms: spines integrated each frame from layered travelling waves (each arm on its own
//    phase), outlined in orange, with two staggered rows of bone ring suckers (rings where there
//    is room, beads where there is not) that warm to orange toward the tips;
//  · a faint halo around the mantle and slow marine snow.
//
// Events (each starts on the next draw):
//   pulse(arm?, inward?)  a white-hot packet travels mantle→tip (or tip→mantle) in ~0.6 s; the
//                         arm's numeral (labels on) lights up
//   ripple(strength?)     a sonar ring expands from the body across the arms and fades
//   flash()               the mantle flares and settles
// State: load (0..1) speeds the motion and lifts the glow a little; connected=false cools the
// creature toward bone and slows it; paused dims and nearly stills it. All of it eases.
// labels=true writes the arm numerals I–VIII beyond the tips (as in the video). reveal (0..1)
// plays the entrance: the mantle swells in and a white-hot front grows each arm to its tip.
//
// Deterministic for a given sequence of draw times (seeded PRNG, no Math.random). Cost: a few
// thousand plotted points per frame.

import type { BrailleCanvas } from './canvas.ts'

export interface OctoState {
  /** 0..1 current compute intensity */
  load: number
  connected: boolean
  paused: boolean
  /** write the arm numerals I–VIII beyond the tips */
  labels?: boolean
  /** 0..1 entrance (default 1): the mantle swells in, then light traces out along the arms */
  reveal?: number
}

export interface Octopus {
  draw(c: BrailleCanvas, tMs: number, s: OctoState): void
  /** Light travels along an arm: mantle→tip (default) or tip→mantle when inward. */
  pulse(arm?: number, inward?: boolean): void
  /** Sonar ring from the body. */
  ripple(strength?: number): void
  /** Brief mantle flare. */
  flash(): void
}

type C3 = [number, number, number]

const TAU = Math.PI * 2
const ARMS = 8
const DEG = Math.PI / 180
const PULSE_S = 0.62
const RIPPLE_S = 2.1
const FLASH_S = 1.1
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII']

// Pose (units of R, the reach of the side arms; y grows downward). From the key art.
const ARM_ANGLE = [-90, -36, 3, 41, 90, 139, 177, -144].map((d) => d * DEG)
const ARM_LEN = [0.84, 0.97, 1.0, 1.03, 1.07, 1.02, 0.99, 0.96]
// tip curl: + turns clockwise on screen (mirror arms curl the opposite way)
const ARM_CURL = [-1, 1, -1, -1, 1, 1, 1, -1]
const MANTLE = { y: -0.28, rx: 0.25, ry: 0.275 }
const HEAD = { y: -0.035, rx: 0.165, ry: 0.115 }
const EYE = { x: 0.19, y: 0.005 }
const ROOT_W = 0.094 // arm half-width at the root
const BOX = { x0: -1.08, x1: 1.08, y0: -0.93, y1: 1.12 } // creature bounds (with curls)

// ── colour ──────────────────────────────────────────────────────────────────
const lerp3 = (a: C3, b: C3, t: number): C3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
function lut(stops: [number, C3][]): C3[] {
  const out: C3[] = []
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let k = 0
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++
    const [t0, c0] = stops[k]
    const [t1, c1] = stops[k + 1]
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))
    out.push(lerp3(c0, c1, u * u * (3 - 2 * u)).map(Math.round) as C3)
  }
  return out
}
// fire: ember → international orange (#ff4d00 at 0.45) → peach → white-hot
const FIRE = lut([
  [0, [110, 30, 0]],
  [0.45, [255, 77, 0]],
  [0.68, [255, 128, 52]],
  [0.86, [255, 205, 165]],
  [1, [255, 247, 238]],
])
// bone: dim bone → bone #f2efe8 → white-hot
const BONE = lut([
  [0, [70, 68, 64]],
  [0.7, [242, 239, 232]],
  [1, [255, 249, 242]],
])

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

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
/** stable per-dot noise in [0,1) (texture that stays attached to the body) */
const hash2 = (x: number, y: number) => {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h ^= h >>> 13
  return ((h >>> 0) % 1024) / 1024
}
const smooth = (e0: number, e1: number, v: number) => {
  const t = clamp01((v - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}
const easeOut3 = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t)

interface ArmP {
  theta: number
  len: number
  curl: number
  curlAmt: number
  ph: [number, number, number, number]
  f: [number, number, number, number]
  amp: number
}

interface Pulse {
  arm: number
  t0: number // seconds; NaN until the next draw
  inward: boolean
  landed: boolean
}

export function createOctopus(opts?: { seed?: number }): Octopus {
  const rnd = mulberry32(opts?.seed ?? 0x15ca)

  const arms: ArmP[] = []
  for (let i = 0; i < ARMS; i++) {
    arms.push({
      theta: ARM_ANGLE[i] + (rnd() - 0.5) * 0.05,
      len: ARM_LEN[i],
      curl: ARM_CURL[i],
      curlAmt: 1.45 + rnd() * 0.5,
      ph: [rnd() * TAU, rnd() * TAU, rnd() * TAU, rnd() * TAU],
      f: [0.55 + rnd() * 0.2, 0.27 + rnd() * 0.12, 0.17 + rnd() * 0.1, 0.4 + rnd() * 0.2],
      amp: 0.85 + rnd() * 0.3,
    })
  }

  // particle tables (unit space)
  const HALO_MAX = 360
  const halo = Array.from({ length: HALO_MAX }, () => ({
    a: rnd() * TAU,
    r: 1.12 + Math.pow(rnd(), 2) * 0.9,
    w: (rnd() - 0.5) * 0.2,
    tw: rnd() * TAU,
    tf: 0.4 + rnd() * 1.1,
    base: 0.12 + Math.pow(rnd(), 1.8) * 0.38,
  }))
  const SNOW_MAX = 700
  const snow = Array.from({ length: SNOW_MAX }, () => {
    const ember = rnd() < 0.18
    return {
      x: rnd(),
      y: rnd(),
      vy: 0.004 + rnd() * 0.012,
      wob: 0.002 + rnd() * 0.008,
      wf: 0.15 + rnd() * 0.3,
      ph: rnd() * TAU,
      a: 0.1 + Math.pow(rnd(), 2.2) * 0.32,
      ember,
      k: rnd(),
    }
  })
  // mantle sparkles: a Fibonacci sphere that turns with the dome; rebuilt when the size changes
  let mKey = -1
  let mPts = new Float32Array(0)
  let mN = 0
  const buildSphere = (rDots: number) => {
    const key = Math.max(4, Math.round(rDots))
    if (key === mKey) return
    mKey = key
    const nb = Math.max(60, Math.round(0.42 * key * key))
    const ga = Math.PI * (3 - Math.sqrt(5))
    const hr = mulberry32(0x0c70 + key)
    const pts: number[] = []
    for (let k = 0; k < nb; k++) {
      const y = 1 - (2 * (k + 0.5)) / nb
      const r = Math.sqrt(1 - y * y)
      pts.push(Math.cos(k * ga) * r, y, Math.sin(k * ga) * r, hr())
    }
    mPts = Float32Array.from(pts)
    mN = nb
  }

  // spine buffers
  const NMAX = 240
  const SX = new Float32Array(ARMS * NMAX)
  const SY = new Float32Array(ARMS * NMAX)
  const SH = new Float32Array(ARMS * NMAX)
  const BOOST = new Float32Array(NMAX)
  const armN = new Int32Array(ARMS)

  // live state
  let lastT = NaN
  let first = true
  let phase = 0
  let load = 0
  let conn = 0
  let pause = 0
  let nextArm = 0
  const pulses: Pulse[] = []
  const ripples: { t0: number; k: number }[] = []
  const armHeat = new Float32Array(ARMS)
  let flashT0 = -1e9
  let flashPending = false
  let microFlash = 0

  // per-frame scratch
  let cold = 0
  let dim = 1
  let gain = 1
  const col: C3 = [0, 0, 0]
  let hx = 0
  let hy = 0
  let R = 1
  let mx = 0
  let my = 0
  let mrx = 1
  let mry = 1
  let hdx = 0
  let hdy = 0
  let hrx = 1
  let hry = 1
  let KO = 1.5
  let eyeR = 1
  let eyeY = 0

  /** colour from a LUT, cooled toward bone grey when disconnected → `col` */
  const tone = (L: C3[], k: number): C3 => {
    const c = L[k <= 0 ? 0 : k >= 1 ? 255 : (k * 255) | 0]
    if (cold > 0.001) {
      const g = (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) * 0.95
      col[0] = c[0] + (g + 6 - c[0]) * cold
      col[1] = c[1] + (g + 3 - c[1]) * cold
      col[2] = c[2] + (g - c[2]) * cold
    } else {
      col[0] = c[0]
      col[1] = c[1]
      col[2] = c[2]
    }
    return col
  }
  /** a mix of two LUT tones → `col` */
  const tone2 = (A: C3[], ka: number, B: C3[], kb: number, t: number): C3 => {
    const a = tone(A, ka)
    const a0 = a[0]
    const a1 = a[1]
    const a2 = a[2]
    const b = tone(B, kb)
    col[0] = a0 + (b[0] - a0) * t
    col[1] = a1 + (b[1] - a1) * t
    col[2] = a2 + (b[2] - a2) * t
    return col
  }

  /** inside the mantle or head silhouette, plus a thin knockout gap so the body's outline stays
   *  crisp where arms pass under it */
  const underBody = (x: number, y: number): boolean => {
    let dx = (x - mx) / (mrx + KO)
    let dy = (y - my) / (mry + KO)
    if (dx * dx + dy * dy < 1.0) return true
    dx = (x - hdx) / (hrx + KO)
    dy = (y - hdy) / (hry + KO)
    if (dx * dx + dy * dy < 1.0) return true
    // the eyes sit on top too
    dy = (y - eyeY) / (eyeR + KO)
    if (dy * dy >= 1) return false
    const ex = Math.abs(x - hdx) - EYE.x * R
    dx = ex / (eyeR * 1.2 + KO)
    return dx * dx + dy * dy < 1.0
  }

  function draw(c: BrailleCanvas, tMs: number, st: OctoState) {
    const t = tMs / 1000
    let dt = Number.isFinite(lastT) ? t - lastT : 0
    if (dt < 0 || dt > 0.25) dt = dt < 0 ? 0 : 0.25
    lastT = t

    const kk = (tau: number) => 1 - Math.exp(-dt / tau)
    load += (clamp01(st.load || 0) - load) * kk(0.9)
    conn += ((st.connected ? 1 : 0) - conn) * (first ? 1 : kk(1.2))
    pause += ((st.paused ? 1 : 0) - pause) * (first ? 1 : kk(0.6))
    first = false
    const speed = (0.6 + 0.5 * load) * (0.45 + 0.55 * conn) * (1 - 0.85 * pause)
    phase += dt * speed
    cold = (1 - conn) * 0.8
    dim = (0.55 + 0.45 * conn) * (1 - 0.32 * pause) * (0.92 + 0.12 * load)
    // solid tiles (octants, half blocks) read brighter than font braille dots
    gain = c.glyphs === 'braille' ? 1 : 0.86

    // events
    for (const p of pulses) {
      if (Number.isNaN(p.t0)) {
        p.t0 = t
        armHeat[p.arm] = 1
      }
    }
    for (const r of ripples) if (Number.isNaN(r.t0)) r.t0 = t
    if (flashPending) {
      flashT0 = t
      flashPending = false
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pl = pulses[i]
      if (pl.inward && !pl.landed && t - pl.t0 >= PULSE_S) {
        pl.landed = true
        microFlash = Math.min(0.7, microFlash + 0.35)
      }
      if (t - pl.t0 > PULSE_S + 0.6) pulses.splice(i, 1)
    }
    for (let i = ripples.length - 1; i >= 0; i--) if (t - ripples[i].t0 > RIPPLE_S) ripples.splice(i, 1)
    for (let i = 0; i < ARMS; i++) armHeat[i] *= Math.exp(-dt / 0.8)
    const fa = t - flashT0
    const flare = fa >= 0 && fa < FLASH_S ? (1 - Math.exp(-fa / 0.05)) * Math.exp(-fa / 0.34) : 0
    microFlash *= Math.exp(-dt / 0.25)
    const glowUp = Math.min(1.2, flare + microFlash)
    // entrance
    const rv = clamp01(st.reveal ?? 1)
    const bodyIn = smooth(0, 0.42, rv)
    const front = rv >= 1 ? 9 : 0.12 + smooth(0.2, 1, rv) * 0.95
    const ambient = smooth(0.3, 1, rv)

    // ── layout: fit the creature's bounds (plus numerals) into the canvas ──
    const W = c.w
    const H = c.h
    const lab = st.labels ? 1 : 0
    const padX = 2 + lab * 7 // dots
    const padY = 2 + lab * 6
    R = Math.max(4, Math.min((W - 2 * padX) / (BOX.x1 - BOX.x0), (H - 2 * padY) / (BOX.y1 - BOX.y0)))
    const bob = 0.012 * R * Math.sin(phase * 0.8)
    hx = W / 2 - ((BOX.x0 + BOX.x1) / 2) * R
    hy = H / 2 - ((BOX.y0 + BOX.y1) / 2) * R + bob
    const breath = (1 + 0.02 * Math.sin(phase * 1.05) + 0.045 * glowUp) * (0.45 + 0.55 * easeOut3(bodyIn))
    mx = hx
    my = hy + MANTLE.y * R
    mrx = MANTLE.rx * R * breath
    mry = MANTLE.ry * R * breath
    hdx = hx
    hdy = hy + HEAD.y * R
    hrx = HEAD.rx * R
    hry = HEAD.ry * R
    const small = R < 18
    KO = small ? 0.8 : 1.6
    eyeR = Math.max(1, 0.046 * R)
    eyeY = hy + EYE.y * R

    // ── marine snow (screen space, real time so it never jumps) ──
    {
      const n = Math.min(SNOW_MAX, Math.round((W * H) / 190))
      for (let i = 0; i < n; i++) {
        const p = snow[i]
        const y = (((p.y + p.vy * t) % 1) + 1) % 1
        const x = (((p.x + p.wob * Math.sin(p.wf * t + p.ph)) % 1) + 1) % 1
        const tw = 0.7 + 0.3 * Math.sin(t * 0.8 + p.ph * 3)
        const edge = smooth(0, 0.07, y) * smooth(1, 0.93, y)
        const a = p.a * tw * edge * (0.6 + 0.4 * dim) * gain * ambient
        if (p.ember) c.plot(x * W, y * H, tone(FIRE, 0.3 + 0.15 * p.k), a * 1.1)
        else c.plot(x * W, y * H, tone(BONE, 0.25 + 0.2 * p.k), a)
      }
    }

    // ── halo around the mantle ──
    {
      const n = Math.min(HALO_MAX, Math.round(0.5 * mrx * mry + 24))
      const grow = 1 + 0.3 * glowUp
      for (let i = 0; i < n; i++) {
        const p = halo[i]
        const a = p.a + phase * p.w
        const r = p.r * grow * (1 + 0.03 * Math.sin(phase * 0.7 + p.tw))
        const x = mx + Math.cos(a) * r * mrx
        const y = my + Math.sin(a) * r * mry
        if (underBody(x, y)) continue
        const tw = 0.55 + 0.45 * Math.sin(t * p.tf + p.tw)
        c.plot(x, y, tone(FIRE, 0.4 + 0.25 * glowUp), p.base * tw * dim * gain * ambient * (1 + 2 * glowUp))
      }
    }

    // ── ripples: sonar rings from the body ──
    for (const rp of ripples) {
      const p = (t - rp.t0) / RIPPLE_S
      if (p < 0 || p > 1) continue
      // a dotted sonar ring and a fainter echo, gone before they reach the tips
      for (const lag of [0, 0.12]) {
        const q = p - lag
        if (q <= 0) continue
        const rr = (0.3 + 0.85 * easeOut3(q)) * R
        const a = rp.k * (lag ? 0.4 : 0.85) * Math.pow(1 - q, 2.2) * gain
        if (a < 0.03) continue
        const n = Math.ceil((TAU * rr) / 2.2)
        const spin = q * 0.6
        for (let i = 0; i < n; i++) {
          const ang = (i / n) * TAU + spin
          const x = hx + Math.cos(ang) * rr
          const y = hy + Math.sin(ang) * rr * 0.96
          if (underBody(x, y)) continue
          c.plot(x, y, tone(FIRE, 0.8 - 0.3 * q), a)
        }
      }
    }

    // ── arms: integrate spines ──
    const dormant = 1 - conn
    for (let ai = 0; ai < ARMS; ai++) {
      const A = arms[ai]
      const o = ai * NMAX
      const L = A.len * R * (1 - 0.08 * dormant)
      const N = Math.max(24, Math.min(NMAX, Math.ceil(L * 1.5)))
      armN[ai] = N
      const ds = 1 / (N - 1)
      const segL = L * ds
      const P1 = phase * A.f[0] * 2.1 + A.ph[0]
      const P2 = phase * A.f[1] * 2.1 + A.ph[1]
      const P3 = phase * A.f[2] * 2.1 + A.ph[2]
      const curlBreath = 0.75 + 0.25 * Math.sin(P3)
      let x = hx + Math.cos(A.theta) * 0.07 * R
      let y = hy + Math.sin(A.theta) * 0.07 * R
      for (let j = 0; j < N; j++) {
        const s = j * ds
        const sway = A.amp * (0.07 * Math.sin(P1 - 4.2 * s) * s + 0.11 * Math.sin(P2 - 1.8 * s) * s * s)
        const curl = A.curl * A.curlAmt * Math.pow(smooth(0.55, 1, s), 1.6) * curlBreath * (1 + 0.5 * dormant)
        const h = A.theta + sway + curl
        SX[o + j] = x
        SY[o + j] = y
        SH[o + j] = h
        x += Math.cos(h) * segL
        y += Math.sin(h) * segL
      }
    }

    // ── arms: draw ──
    for (let ai = 0; ai < ARMS; ai++) {
      const A = arms[ai]
      const o = ai * NMAX
      const N = armN[ai]
      const ds = 1 / (N - 1)
      const L = A.len * R

      // pulse light along this arm
      BOOST.fill(0, 0, N)
      let armGlow = 0
      for (const pl of pulses) {
        if (pl.arm !== ai) continue
        const p = (t - pl.t0) / PULSE_S
        if (p < 0 || p > 1) continue
        const e = p * p * (3 - 2 * p) * 0.25 + p * 0.75
        const sp = pl.inward ? 1 - e : e
        armGlow = Math.max(armGlow, 0.5 * (1 - p))
        for (let j = 0; j < N; j++) {
          const s = j * ds
          const g = Math.exp(-((s - sp) * (s - sp)) / 0.0016)
          const behind = pl.inward ? s - sp : sp - s
          const tail = behind > 0 ? 0.3 * Math.exp(-behind / 0.08) : 0
          const b = g > tail ? g : tail
          if (b > BOOST[j]) BOOST[j] = b
        }
      }
      const heatArm = armHeat[ai]

      if (front < 2) {
        const fk = smooth(0.15, 0.4, front) // the front brightens once it clears the body
        for (let j = 0; j < N; j++) {
          const d = j * ds - front
          const g = d > 0 ? 0 : fk * Math.exp(-(d * d) / 0.003)
          if (g > BOOST[j]) BOOST[j] = g
        }
      }
      for (let j = 0; j < N; j++) {
        const s = j * ds
        if (s > front) break
        const sx = SX[o + j]
        const sy = SY[o + j]
        const h = SH[o + j]
        const nx = -Math.sin(h)
        const ny = Math.cos(h)
        const w = R * (ROOT_W * Math.pow(1 - s, 1.05) + 0.007) * (1 + 0.05 * Math.sin(phase * 2.2 + s * 8 + ai))
        const b = BOOST[j]
        const light = dim * gain * (1 - 0.4 * Math.pow(s, 1.4)) * (1 + 0.25 * armGlow + 0.15 * heatArm)
        // silhouette: orange edges
        for (let side = -1; side <= 1; side += 2) {
          const ex = sx + nx * w * side
          const ey = sy + ny * w * side
          if (underBody(ex, ey)) continue
          c.plot(ex, ey, tone(FIRE, 0.47 + 0.08 * (1 - s) + 0.45 * b + 0.05 * load), (0.9 + 0.9 * b) * light)
        }
        // the travelling packet: a white-hot bead across the arm
        if (b > 0.35) {
          const rr = Math.max(0.9, w * 0.85) * b
          const n = Math.ceil(rr * rr * 3.2) + 2
          for (let k = 0; k < n; k++) {
            const a = k * 2.399963
            const r = rr * Math.sqrt((k + 0.5) / n)
            const px = sx + Math.cos(a) * r
            const py = sy + Math.sin(a) * r
            if (underBody(px, py)) continue
            c.plot(px, py, tone(FIRE, 0.8 + 0.2 * b), (0.5 + 1.1 * b) * dim * gain)
          }
        }
      }

      // suckers: two staggered rows at fixed arc positions, so they never pop
      {
        let s = 0.16 + (ai % 2) * 0.012
        let k = 0
        while (s < Math.min(0.93, front)) {
          const w0 = R * (ROOT_W * Math.pow(1 - s, 1.05) + 0.007)
          const rs = w0 * 0.36
          const fj = s * (N - 1)
          const j0 = Math.min(N - 2, fj | 0)
          const f = fj - j0
          const i0 = o + j0
          const sx = SX[i0] + (SX[i0 + 1] - SX[i0]) * f
          const sy = SY[i0] + (SY[i0 + 1] - SY[i0]) * f
          const h = SH[i0] + (SH[i0 + 1] - SH[i0]) * f
          const nx = -Math.sin(h)
          const ny = Math.cos(h)
          const u = (k & 1 ? 0.3 : -0.3) * w0
          const qx = sx + nx * u
          const qy = sy + ny * u
          const b = BOOST[f < 0.5 ? j0 : j0 + 1]
          const warm = smooth(0.3, 0.85, s)
          const light = dim * gain * (1 - 0.35 * Math.pow(s, 1.3)) * (1 + 0.2 * heatArm)
          const a = (0.95 + 0.8 * b) * light
          if (!underBody(qx, qy)) {
            const cc = tone2(BONE, 0.74 + 0.2 * b, FIRE, 0.55 + 0.3 * b, warm)
            if (rs >= 2.1 && !small) {
              const n = Math.max(6, Math.round(TAU * rs * 1.15))
              for (let q = 0; q < n; q++) {
                const ang = (q / n) * TAU
                c.plot(qx + Math.cos(ang) * rs, qy + Math.sin(ang) * rs, cc, a)
              }
            } else c.plot(qx, qy, cc, a * 1.1)
          }
          // pitch ∝ local width; the two rows alternate
          s += Math.max(2.4, 1.2 * rs + 0.8) / L
          k++
        }
      }

      // tip sparkle after an outward packet lands
      for (const pl of pulses) {
        if (pl.arm !== ai || pl.inward) continue
        const q = (t - pl.t0 - PULSE_S) / 0.45
        if (q < 0 || q > 1) continue
        const ox = SX[o + N - 1]
        const oy = SY[o + N - 1]
        const spread = (1.5 + 0.09 * R * easeOut3(q))
        for (let k = 0; k < 8; k++) {
          const a = k * 0.785398 + ai
          c.plot(ox + Math.cos(a) * spread, oy + Math.sin(a) * spread, tone(FIRE, 0.9 - 0.4 * q), (1 - q) * 0.95 * dim * gain)
        }
      }

      // numeral beyond the tip
      if (st.labels) {
        const off = Math.max(0.1 * R, 6)
        const tx = hx + Math.cos(A.theta) * (L + off)
        const ty = hy + Math.sin(A.theta) * (L + off)
        const label = ROMAN[ai]
        const colx = Math.round(tx / 2 - label.length / 2)
        const row = Math.round(ty / 4 - 0.5)
        const k = clamp01(heatArm)
        const base: C3 = [96, 94, 90]
        const hot: C3 = [255, 77, 0]
        const la = smooth(0.8, 1, rv) // numerals appear once the arms have reached them
        const lc = lerp3([5, 5, 5], lerp3(base, hot, k), la).map(Math.round) as C3
        if (la > 0.02) c.label(Math.max(0, Math.min(c.cols - label.length, colx)), Math.max(0, Math.min(c.lines - 1, row)), label, lc)
      }
    }

    // ── head (between the eyes) and mantle ──
    {
      const bd = dim * gain * bodyIn
      const band = 1.2 - ((t / 6) % 1) * 2.7 // lidar band latitude, top → bottom
      const bandY = my - band * mry
      const coreX = mx
      const coreY = my - 0.04 * R
      const coreR = mrx * (0.5 + 0.12 * glowUp)
      const coreHeat = 0.05 * load + 0.4 * glowUp
      const x0 = Math.max(0, Math.floor(Math.min(mx - mrx, hdx - hrx) - 1))
      const x1 = Math.min(W - 1, Math.ceil(Math.max(mx + mrx, hdx + hrx) + 1))
      const y0 = Math.max(0, Math.floor(my - mry - 1))
      const y1 = Math.min(H - 1, Math.ceil(hdy + hry + 1))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5
          const py = y + 0.5
          const dxm = (px - mx) / mrx
          const dym = (py - my) / mry
          const qm = dxm * dxm + dym * dym
          const dxh = (px - hdx) / hrx
          const dyh = (py - hdy) / hry
          const qh = dxh * dxh + dyh * dyh
          if (qm >= 1 && qh >= 1) continue
          const thr = hash2(x - Math.round(mx), y - Math.round(my))
          if (qm < 1) {
            const g = 1 - qm
            const rim = smooth(0.62, 0.98, qm)
            const dc = Math.hypot(px - coreX, (py - coreY) * 1.1) / coreR
            const core = Math.exp(-dc * dc * 1.6)
            const bnd = Math.exp(-((py - bandY) * (py - bandY)) / (0.018 * mry * mry))
            // solid body; only the outer shell breaks up into particles
            const B = 1.1 - 0.45 * smooth(0.72, 1, qm) + 0.6 * core + 0.2 * bnd + 0.3 * glowUp
            if (B <= thr) continue
            const heat = 0.4 + 0.12 * g + 0.52 * core + 0.06 * bnd + 0.05 * rim + coreHeat
            c.plot(x, y, tone(FIRE, heat), (0.62 + 0.25 * g + 0.75 * core + 0.4 * rim + 0.2 * bnd + 0.5 * glowUp) * bd)
          } else {
            // the head below the mantle: dimmer, warm
            const g = 1 - qh
            const B = 0.62 + 0.3 * g
            if (B <= thr) continue
            c.plot(x, y, tone(FIRE, 0.36 + 0.1 * g + 0.5 * coreHeat), (0.42 + 0.3 * g) * bd)
          }
        }
      }
      // turning sparkle sphere over the dome
      buildSphere(mrx)
      const spin = phase * 0.18
      const cs = Math.cos(spin)
      const ss = Math.sin(spin)
      for (let k = 0; k < mN; k++) {
        const oo = k * 4
        const nx0 = mPts[oo]
        const ny = mPts[oo + 1]
        const nz0 = mPts[oo + 2]
        const nz = nx0 * ss + nz0 * cs
        if (nz < 0.05) continue // back of the sphere
        const nx = nx0 * cs - nz0 * ss
        const px = mx + nx * mrx * 0.97
        const py = my + ny * mry * 0.97
        const tw = 0.75 + 0.25 * Math.sin(t * 1.7 + mPts[oo + 3] * TAU)
        const edge = 1 - nz // brighter toward the limb (glancing light)
        c.plot(px, py, tone(FIRE, 0.62 + 0.25 * nz), (0.35 + 0.5 * edge) * tw * bd * (1 + 0.8 * glowUp))
      }
      // crisp limb: the dome's outline as one dotted ellipse, brightest at the lower edge
      const nl = Math.ceil(TAU * Math.max(mrx, mry) * 1.3)
      for (let i = 0; i < nl; i++) {
        const a = (i / nl) * TAU
        const sy = Math.sin(a)
        const x = mx + Math.cos(a) * mrx
        const y = my + sy * mry
        if (sy > 0.2 && (Math.abs((x - hdx) / hrx) < 1 && Math.abs((y - hdy) / hry) < 1)) continue
        c.plot(x, y, tone(FIRE, 0.5 + 0.1 * glowUp), (0.55 + 0.3 * Math.max(0, -sy) + 0.5 * glowUp) * bd)
      }
      // white-hot core with a faint four-point glint
      const nc = Math.max(10, Math.round(0.5 * coreR * coreR))
      const rot = phase * 0.3
      for (let k = 0; k < nc; k++) {
        const u = Math.pow((k + 0.5) / nc, 0.85)
        const a = k * 2.399963 + rot
        const fall = (1 - u) * (1 - u)
        c.plot(coreX + Math.cos(a) * u * coreR * 0.8, coreY + Math.sin(a) * u * coreR * 0.75, tone(FIRE, 0.72 + 0.28 * fall + 0.1 * glowUp), (0.4 + 1.2 * fall + 0.5 * glowUp) * bd)
      }
      if (!small) {
        const gl = (0.55 + 0.45 * Math.sin(t * 0.9)) * (0.6 + 0.6 * glowUp)
        const len = coreR * (0.95 + 0.35 * glowUp)
        for (let k = 1; k <= Math.ceil(len); k++) {
          const f = 1 - k / (len + 1)
          const a = f * f * gl * bd
          c.plot(coreX + k, coreY, tone(FIRE, 0.85), a)
          c.plot(coreX - k, coreY, tone(FIRE, 0.85), a)
          c.plot(coreX, coreY + k * 0.8, tone(FIRE, 0.85), a)
          c.plot(coreX, coreY - k * 0.8, tone(FIRE, 0.85), a)
        }
      }
      // eyes: bright orange beads with a slit, at the sides of the head; they blink now and then
      const bt = t % 5.3
      const blink = bt < 0.16 ? Math.sin((bt / 0.16) * Math.PI) : 0
      const er = eyeR
      for (let side = -1; side <= 1; side += 2) {
        const ex = hx + side * EYE.x * R
        const ey = hy + EYE.y * R
        const ry = er * 0.85 * (1 - 0.85 * blink)
        for (let yy = -Math.ceil(er); yy <= Math.ceil(er); yy++) {
          for (let xx = -Math.ceil(er * 1.2); xx <= Math.ceil(er * 1.2); xx++) {
            const q = (xx * xx) / (er * er * 1.44) + (yy * yy) / Math.max(0.3, ry * ry)
            if (q > 1) continue
            // the pupil: a dark horizontal slit (left unlit)
            if (Math.abs(yy) < 0.5 && Math.abs(xx) < er * 0.75 && !small && blink < 0.5) continue
            c.plot(ex + xx, ey + yy, tone(FIRE, 0.8), 1.4 * bd)
          }
        }
      }
    }
  }

  return {
    draw,
    pulse(arm?: number, inward = false) {
      let a: number
      if (arm === undefined || !Number.isFinite(arm)) {
        a = nextArm
        nextArm = (nextArm + 3) % ARMS
      } else a = ((Math.floor(arm) % ARMS) + ARMS) % ARMS
      // events queued while the creature is not being drawn: keep only the latest two
      let pending = 0
      for (let i = pulses.length - 1; i >= 0; i--) if (Number.isNaN(pulses[i].t0) && ++pending >= 2) pulses.splice(i, 1)
      pulses.push({ arm: a, t0: NaN, inward, landed: false })
      if (pulses.length > 24) pulses.shift()
    },
    ripple(strength = 1) {
      ripples.push({ t0: NaN, k: Math.max(0.1, Math.min(1.5, strength)) })
      if (ripples.length > 6) ripples.shift()
    },
    flash() {
      flashPending = true
    },
  }
}
