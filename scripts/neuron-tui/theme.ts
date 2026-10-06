// LUSCA terminal theme — the brand palette as RGB tuples plus ANSI SGR helpers.
//
// Ground is the terminal's own background (never painted). Bone #f2efe8 carries text and
// hairlines (62/32/16 % tints = bone over #050505 at that opacity); international orange
// #ff4d00 is the single accent. Every helper honours a colour capability level:
//   'truecolor'  \x1b[38;2;r;g;bm
//   '256'        nearest xterm-256 entry (6×6×6 cube or grey ramp)
//   'none'       no escape codes at all (NO_COLOR, dumb terminals, pipes)
// The level is module state (setColorLevel / colorLevel), detected from the environment on
// import; every helper also reads it at call time, so switching level takes effect at once.
// No dependencies; safe to bundle into dist/neuron.mjs.

export type RGB = [number, number, number]
export type ColorLevel = 'truecolor' | '256' | 'none'

const BONE: RGB = [242, 239, 232]
const INK: RGB = [5, 5, 5]
const over = (t: number): RGB => [
  Math.round(INK[0] + (BONE[0] - INK[0]) * t),
  Math.round(INK[1] + (BONE[1] - INK[1]) * t),
  Math.round(INK[2] + (BONE[2] - INK[2]) * t),
]

/** Brand palette. Treat the tuples as read-only. */
export const PAL = {
  ink: INK, //       #050505 ground (reference only — use the terminal background)
  bone: BONE, //     #f2efe8 primary text
  bone62: over(0.62), // secondary text
  bone32: over(0.32), // labels, hairlines
  bone16: over(0.16), // faint rules, ticks
  hot: [255, 77, 0] as RGB, // #ff4d00 international orange — accent only
  white: [255, 247, 238] as RGB, // white-hot core (top of ramp)
} as const

// ─── capability level ───────────────────────────────────────────────────────

let LEVEL: ColorLevel = 'truecolor'

/** Detect what the terminal can show. NO_COLOR → none; COLORTERM / Windows Terminal / Node's
 *  colour depth ≥ 24 → truecolor; otherwise 256 (or none for a non-colour terminal). */
export function detectColorLevel(
  env: NodeJS.ProcessEnv = process.env,
  stream: { isTTY?: boolean; getColorDepth?: (env?: object) => number } = process.stdout,
): ColorLevel {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none'
  const force = env.FORCE_COLOR
  if (force === '0' || force === 'false') return 'none'
  if (force === '3') return 'truecolor'
  if (force === '2') return '256'
  if (env.TERM === 'dumb') return 'none'
  const ct = (env.COLORTERM || '').toLowerCase()
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor'
  if (env.WT_SESSION) return 'truecolor' // Windows Terminal does not always export COLORTERM
  const tp = env.TERM_PROGRAM || ''
  if (tp === 'iTerm.app' || tp === 'WezTerm' || tp === 'vscode' || tp === 'ghostty') return 'truecolor'
  if (/-direct|truecolor|24bit/i.test(env.TERM || '')) return 'truecolor'
  let depth = 0
  try {
    depth = stream.getColorDepth ? stream.getColorDepth(env) : 0
  } catch {
    depth = 0
  }
  if (depth >= 24) return 'truecolor'
  if (depth >= 4 || /256|color/i.test(env.TERM || '')) return '256'
  return stream.isTTY ? '256' : 'none'
}

try {
  LEVEL = detectColorLevel()
} catch {
  LEVEL = 'truecolor'
}

export function setColorLevel(level: ColorLevel): void {
  LEVEL = level
}
export function colorLevel(): ColorLevel {
  return LEVEL
}

// ─── xterm-256 mapping ──────────────────────────────────────────────────────

const CUBE = [0, 95, 135, 175, 215, 255]
const d2 = (r: number, g: number, b: number, R: number, G: number, B: number) => {
  // perceptual-ish weighting (redmean)
  const rm = (r + R) / 2
  const dr = r - R
  const dg = g - G
  const db = b - B
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db
}

/** Nearest xterm-256 palette index (16–255) for an RGB colour. Searches the cube corners around
 *  the colour plus the grey ramp, scoring perceptual distance plus a chroma term so warm tints stay
 *  warm (a peach must not round to pink, an ember not to brown-grey). */
const sgn = (v: number) => (v > 12 ? 1 : v < -12 ? -1 : 0)

export function rgbTo256(r: number, g: number, b: number): number {
  const lo = (v: number) => (v < 95 ? 0 : Math.min(4, Math.floor((v - 55) / 40)))
  const r0 = lo(r)
  const g0 = lo(g)
  const b0 = lo(b)
  const cr = r - g
  const cg = g - b
  let best = 16
  let bestD = Infinity
  for (let i = 0; i < 8; i++) {
    const ri = Math.min(5, r0 + (i & 1))
    const gi = Math.min(5, g0 + ((i >> 1) & 1))
    const bi = Math.min(5, b0 + ((i >> 2) & 1))
    const R = CUBE[ri]
    const G = CUBE[gi]
    const B = CUBE[bi]
    let d = d2(r, g, b, R, G, B) + 1.5 * ((cr - (R - G)) ** 2 + (cg - (G - B)) ** 2)
    // keep the channel order (warm stays warm: never tip into pink, green or blue)
    if (sgn(cr) !== sgn(R - G) || sgn(cg) !== sgn(G - B)) d += 6000
    if (d < bestD) {
      bestD = d
      best = 16 + 36 * ri + 6 * gi + bi
    }
  }
  const avg = (r + g + b) / 3
  const gi2 = avg > 238 ? 23 : Math.max(0, Math.round((avg - 8) / 10))
  const gv = 8 + gi2 * 10
  const dg = d2(r, g, b, gv, gv, gv) + 1.5 * (cr * cr + cg * cg)
  return dg < bestD ? 232 + gi2 : best
}

// ─── escape builders ────────────────────────────────────────────────────────

const fgCache = new Map<number, string>()
const bgCache = new Map<number, string>()
let cacheLevel: ColorLevel = LEVEL

function code(rgb: ArrayLike<number>, isBg: boolean): string {
  if (LEVEL === 'none') return ''
  if (cacheLevel !== LEVEL) {
    fgCache.clear()
    bgCache.clear()
    cacheLevel = LEVEL
  }
  const r = clamp255(rgb[0])
  const g = clamp255(rgb[1])
  const b = clamp255(rgb[2])
  const key = (r << 16) | (g << 8) | b
  const cache = isBg ? bgCache : fgCache
  let s = cache.get(key)
  if (s === undefined) {
    const p = isBg ? 48 : 38
    s = LEVEL === 'truecolor' ? `\x1b[${p};2;${r};${g};${b}m` : `\x1b[${p};5;${rgbTo256(r, g, b)}m`
    if (cache.size > 4096) cache.clear()
    cache.set(key, s)
  }
  return s
}

/** Foreground colour escape for `rgb`; with `text`, returns the coloured text followed by a
 *  foreground reset (\x1b[39m). Empty / plain at level 'none'. */
export function fg(rgb: ArrayLike<number>, text?: string): string {
  const c = code(rgb, false)
  if (text === undefined) return c
  return c ? c + text + '\x1b[39m' : text
}

/** Background colour escape — for small inverted tags only, never full-screen fills. */
export function bg(rgb: ArrayLike<number>, text?: string): string {
  const c = code(rgb, true)
  if (text === undefined) return c
  return c ? c + text + '\x1b[49m' : text
}

/** An SGR helper usable three ways: `bold('x')` wraps, `bold()` returns the code, and
 *  `bold + 'x'` / `${bold}` coerce to the code. Empty at level 'none'. */
export interface Sgr {
  (text?: string): string
  readonly code: string
  [Symbol.toPrimitive](hint?: string): string
}

function sgr(on: string, off: string): Sgr {
  const f = ((text?: string) => {
    if (LEVEL === 'none') return text ?? ''
    return text === undefined ? on : on + text + off
  }) as Sgr
  Object.defineProperty(f, 'code', { get: () => (LEVEL === 'none' ? '' : on) })
  Object.defineProperty(f, Symbol.toPrimitive, { value: () => (LEVEL === 'none' ? '' : on) })
  Object.defineProperty(f, 'toString', { value: () => (LEVEL === 'none' ? '' : on) })
  return f
}

export const bold = sgr('\x1b[1m', '\x1b[22m')
export const dim = sgr('\x1b[2m', '\x1b[22m')
export const reset = sgr('\x1b[0m', '\x1b[0m')

/** Remove every CSI escape sequence (for measuring visible width). */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

// ─── colour maths ───────────────────────────────────────────────────────────

function clamp255(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v)
}

/** Linear mix a→b by t (0..1), rounded. */
export function mix(a: ArrayLike<number>, b: ArrayLike<number>, t: number): RGB {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ]
}

/** Scale brightness (k may exceed 1; result is clamped). */
export function scale(a: ArrayLike<number>, k: number): RGB {
  return [clamp255(a[0] * k), clamp255(a[1] * k), clamp255(a[2] * k)]
}

// The heat ramp: dim bone (cold tips) → bone → international orange → peach → white-hot core.
const RAMP_STOPS: [number, RGB][] = [
  [0.0, [58, 56, 53]],
  [0.18, [150, 146, 139]],
  [0.32, [196, 150, 120]],
  [0.5, [255, 77, 0]],
  [0.66, [255, 112, 34]],
  [0.82, [255, 172, 112]],
  [0.93, [255, 222, 190]],
  [1.0, [255, 247, 238]],
]

/** 256-entry lookup of ramp(); index with Math.round(t * 255). Shared — do not mutate. */
export const RAMP_LUT: RGB[] = (() => {
  const out: RGB[] = []
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let k = 0
    while (k < RAMP_STOPS.length - 2 && t > RAMP_STOPS[k + 1][0]) k++
    const [t0, c0] = RAMP_STOPS[k]
    const [t1, c1] = RAMP_STOPS[k + 1]
    const u = (t - t0) / (t1 - t0)
    const s = u * u * (3 - 2 * u)
    out.push(mix(c0, c1, s))
  }
  return out
})()

/** Heat ramp, t in 0..1: dim bone → bone → orange (#ff4d00 at 0.5) → white-hot. */
export function ramp(t: number): RGB {
  const i = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255)
  const c = RAMP_LUT[i]
  return [c[0], c[1], c[2]]
}
