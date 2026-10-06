// Drawing primitives for the LUSCA neuron dashboard (owner: dashboard): brand colors as packed
// ints, easing, eased scalars, the odometer used for the credits counter, a heavy display font
// drawn with half blocks, hairline gauges, brutalist frames (corner ticks, bracket labels) and
// braille sparklines. Everything draws into a Grid; nothing here writes to the terminal.

import { BrailleCanvas } from './canvas.ts'
import { PAL } from './theme.ts'
import { BOLD, type Grid, mixPacked, pack } from './grid.ts'

// ─── colors (packed 0xRRGGBB) ───────────────────────────────────────────────

export const C = {
  bone: pack(PAL.bone),
  bone62: pack(PAL.bone62),
  bone32: pack(PAL.bone32),
  bone16: pack(PAL.bone16),
  hot: pack(PAL.hot),
  white: pack(PAL.white),
  ink: pack(PAL.ink),
  /** between bone16 and bone32: hairlines that must still read on bright panels */
  bone24: mixPacked(pack(PAL.ink), pack(PAL.bone), 0.24),
  bone46: mixPacked(pack(PAL.ink), pack(PAL.bone), 0.46),
  /** orange at reduced strength (for quiet accents) */
  hot62: mixPacked(pack(PAL.ink), pack(PAL.hot), 0.62),
  hot32: mixPacked(pack(PAL.ink), pack(PAL.hot), 0.32),
} as const

export const mix = mixPacked
/** A color at `t` opacity over the ground. */
export const fadeIn = (c: number, t: number): number => mixPacked(C.ink, c, t)

// ─── easing ─────────────────────────────────────────────────────────────────

export const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t)
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const easeOutExpo = (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp01(t)))
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3)
export const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2
export const easeInCubic = (t: number): number => Math.pow(clamp01(t), 3)
/** 0→1 progress of now within [start, start+dur]. */
export const prog = (now: number, start: number, dur: number): number => clamp01((now - start) / Math.max(1, dur))

/** A scalar that eases toward its target (critically damped-ish exponential). */
export class Roller {
  value = 0
  target = 0
  has = false
  constructor(private readonly tau = 350) {}
  set(v: number): void {
    if (!this.has) {
      this.value = v
      this.has = true
    }
    this.target = v
  }
  /** Jump straight to the target. */
  snap(): void {
    this.value = this.target
  }
  update(dtMs: number): void {
    const k = 1 - Math.exp(-dtMs / this.tau)
    this.value += (this.target - this.value) * k
    if (Math.abs(this.target - this.value) < Math.abs(this.target) * 1e-6 + 1e-9) this.value = this.target
  }
}

// ─── display font (half blocks: 2 pixel rows per cell) ──────────────────────

type Glyph = { w: number; px: string[] }

const G = (rows: string[]): Glyph => ({ w: rows[0].length, px: rows })

/** Heavy 6×8 face (4 rows tall). '#' = lit pixel. */
const BIG: Record<string, Glyph> = {
  '0': G(['.####.', '######', '##..##', '##..##', '##..##', '##..##', '######', '.####.']),
  '1': G(['..##..', '####..', '####..', '..##..', '..##..', '..##..', '######', '######']),
  '2': G(['.####.', '######', '##..##', '...###', '.####.', '###...', '######', '######']),
  '3': G(['.####.', '######', '....##', '..###.', '..####', '....##', '######', '.####.']),
  '4': G(['...###', '..####', '.##.##', '##..##', '######', '######', '....##', '....##']),
  '5': G(['######', '######', '##....', '#####.', '######', '....##', '######', '#####.']),
  '6': G(['.####.', '#####.', '##....', '#####.', '######', '##..##', '######', '.####.']),
  '7': G(['######', '######', '....##', '...##.', '..###.', '..##..', '.###..', '.##...']),
  '8': G(['.####.', '######', '##..##', '.####.', '######', '##..##', '######', '.####.']),
  '9': G(['.####.', '######', '##..##', '######', '.#####', '....##', '.#####', '.####.']),
  '.': G(['..', '..', '..', '..', '..', '..', '##', '##']),
  // thousands separator: a thin gap (a comma this size reads as a second decimal point)
  ',': G(['.', '.', '.', '.', '.', '.', '.', '.']),
  '-': G(['......', '......', '......', '######', '######', '......', '......', '......']),
  '—': G(['......', '......', '......', '######', '######', '......', '......', '......']),
  ' ': G(['...', '...', '...', '...', '...', '...', '...', '...']),
  '+': G(['......', '..##..', '..##..', '######', '######', '..##..', '..##..', '......']),
}

/** Compact 4×6 face (3 rows tall). */
const SMALL: Record<string, Glyph> = {
  '0': G(['.##.', '#..#', '#..#', '#..#', '#..#', '.##.']),
  '1': G(['.#..', '##..', '.#..', '.#..', '.#..', '###.']),
  '2': G(['.##.', '#..#', '..#.', '.#..', '#...', '####']),
  '3': G(['###.', '...#', '.##.', '...#', '...#', '###.']),
  '4': G(['#..#', '#..#', '####', '...#', '...#', '...#']),
  '5': G(['####', '#...', '###.', '...#', '...#', '###.']),
  '6': G(['.##.', '#...', '###.', '#..#', '#..#', '.##.']),
  '7': G(['####', '...#', '..#.', '.#..', '.#..', '.#..']),
  '8': G(['.##.', '#..#', '.##.', '#..#', '#..#', '.##.']),
  '9': G(['.##.', '#..#', '#..#', '.###', '...#', '.##.']),
  '.': G(['.', '.', '.', '.', '.', '#']),
  ',': G(['.', '.', '.', '.', '.', '.']),
  '-': G(['....', '....', '####', '....', '....', '....']),
  '—': G(['....', '....', '####', '....', '....', '....']),
  ' ': G(['..', '..', '..', '..', '..', '..']),
  '+': G(['....', '.#..', '###.', '.#..', '....', '....']),
}

/** The wordmark, drawn like the brand's heavy extended display face (7×8 px, 2 px strokes). */
const WORD: Record<string, Glyph> = {
  L: G(['##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '#######', '#######']),
  U: G(['##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '#######', '.#####.']),
  S: G(['.######', '#######', '##.....', '######.', '.######', '.....##', '#######', '######.']),
  C: G(['.######', '#######', '##.....', '##.....', '##.....', '##.....', '#######', '.######']),
  A: G(['.#####.', '#######', '##...##', '##...##', '#######', '#######', '##...##', '##...##']),
  '.': G(['..', '..', '..', '..', '..', '..', '##', '##']),
}
const WORDMARK = 'LUSCA.'

/** Width in cells of the LUSCA. wordmark at scale 1 (half blocks, 4 rows) or 2 (full blocks, 8 rows). */
export function wordmarkWidth(scale: 1 | 2): number {
  let w = 0
  for (const ch of WORDMARK) w += WORD[ch].w
  return (w + WORDMARK.length - 1) * scale
}
export const wordmarkRows = (scale: 1 | 2): number => 4 * scale

/**
 * Draw "LUSCA." at (x, y). `reveal(i)` (0..1) wipes glyph i in from the left; `color(i)` gives its
 * colour (the full stop is glyph 5). Returns the width drawn.
 */
export function drawWordmark(grid: Grid, x: number, y: number, scale: 1 | 2, reveal: (i: number) => number, color: (i: number) => number): number {
  let cx = x
  let i = 0
  for (const ch of WORDMARK) {
    const g = WORD[ch]
    const k = clamp01(reveal(i))
    const cols = Math.ceil(g.w * k - 1e-9)
    const fg = color(i)
    for (let px = 0; px < cols; px++) {
      for (let row = 0; row < 8 / (scale === 1 ? 2 : 1); row++) {
        if (scale === 2) {
          if (lit(g, px, row)) {
            grid.put(cx + px * 2, y + row, '█', fg)
            grid.put(cx + px * 2 + 1, y + row, '█', fg)
          }
        } else {
          const bits = (lit(g, px, row * 2) ? 1 : 0) | (lit(g, px, row * 2 + 1) ? 2 : 0)
          if (bits) grid.put(cx + px, y + row, HALF[bits], fg)
        }
      }
    }
    cx += (g.w + 1) * scale
    i++
  }
  return cx - x - scale
}

export type FontSize = 'big' | 'small'
const FONTS: Record<FontSize, Record<string, Glyph>> = { big: BIG, small: SMALL }
export const fontHeight = (f: FontSize): number => (f === 'big' ? 8 : 6)
export const fontRows = (f: FontSize): number => fontHeight(f) / 2

const lit = (g: Glyph | undefined, x: number, y: number): boolean => !!g && y >= 0 && y < g.px.length && g.px[y][x] === '#'

const HALF = [' ', '▀', '▄', '█']

/** Width in cells of a string in the display font (1-cell gap between glyphs). */
export function fontWidth(s: string, f: FontSize): number {
  let w = 0
  let n = 0
  for (const ch of s) {
    const g = FONTS[f][ch]
    if (!g) continue
    w += g.w
    n++
  }
  return w + Math.max(0, n - 1)
}

/**
 * Draw a glyph whose pixels are sampled from a vertical strip: pixel row py of the window shows
 * `from` shifted up by `off` pixels with `to` following below after a `gap` (odometer roll).
 */
function drawRolling(grid: Grid, x: number, y: number, from: Glyph, to: Glyph | null, off: number, gap: number, fg: number, f: FontSize): number {
  const H = fontHeight(f)
  const w = Math.max(from.w, to?.w ?? 0)
  for (let row = 0; row < H / 2; row++) {
    for (let cx = 0; cx < w; cx++) {
      let bits = 0
      for (let k = 0; k < 2; k++) {
        const py = row * 2 + k + off
        let on = false
        if (py < H) on = lit(from, cx, py)
        else if (to && py >= H + gap) on = lit(to, cx, py - H - gap)
        if (on) bits |= k === 0 ? 1 : 2
      }
      if (bits) grid.put(x + cx, y + row, HALF[bits], fg)
    }
  }
  return w
}

/** Static text in the display font. Returns the width drawn. */
export function drawBig(grid: Grid, x: number, y: number, s: string, f: FontSize, color: (i: number, ch: string) => number): number {
  let cx = x
  let i = 0
  for (const ch of s) {
    const g = FONTS[f][ch]
    if (!g) continue
    if (i > 0) cx++
    drawRolling(grid, cx, y, g, null, 0, 0, color(i, ch), f)
    cx += g.w
    i++
  }
  return cx - x
}

/**
 * Odometer: each digit is a wheel that rolls forward to its target digit with eased speed, so a
 * changing total reads as motion rather than a jump. Wheels in motion warm toward orange.
 */
export class Odometer {
  private wheels: { pos: number; target: number }[] = []
  private text = ''
  private decimals: number
  has = false

  constructor(decimals = 2) {
    this.decimals = decimals
  }

  /** Formatted target text, e.g. "12,345.67". */
  get target(): string {
    return this.text
  }

  set(value: number): void {
    const s = value.toLocaleString('en-US', { minimumFractionDigits: this.decimals, maximumFractionDigits: this.decimals })
    const digits = s.replace(/[^0-9]/g, '')
    // align wheels from the right
    while (this.wheels.length < digits.length) this.wheels.unshift({ pos: 0, target: 0 })
    while (this.wheels.length > digits.length) this.wheels.shift()
    for (let i = 0; i < digits.length; i++) this.wheels[i].target = Number(digits[i])
    if (!this.has) for (const w of this.wheels) w.pos = w.target
    this.has = true
    this.text = s
  }

  /** Roll everything from zero (used for the first reveal). */
  spinUp(): void {
    for (const w of this.wheels) w.pos = 0
  }

  get moving(): boolean {
    return this.wheels.some((w) => Math.abs(w.pos - w.target) > 1e-3)
  }

  update(dtMs: number): void {
    const dt = Math.min(dtMs, 120) / 1000
    for (const w of this.wheels) {
      const cur = ((w.pos % 10) + 10) % 10
      let dist = w.target - cur
      if (dist < 0) dist += 10
      if (dist < 1e-3) {
        w.pos = w.target
        continue
      }
      // ease out: fast when far, settles softly; never slower than 2.5 digits/s
      const step = Math.min(dist, Math.max(dist * (1 - Math.exp(-dt / 0.16)), 2.5 * dt))
      w.pos = (cur + step) % 10
      if (Math.abs(w.pos - w.target) < 1e-3) w.pos = w.target
    }
  }

  /** Draw at (x, y). Returns the width. Integer digits in `int`, decimals in `dec`. */
  draw(grid: Grid, x: number, y: number, f: FontSize, colors: { int: number; dec: number; moving: number }): number {
    const font = FONTS[f]
    const H = fontHeight(f)
    const gap = 2
    let cx = x
    let wi = 0
    let afterPoint = false
    let first = true
    for (const ch of this.text) {
      if (!first) cx++
      first = false
      if (ch === '.') afterPoint = true
      if (ch >= '0' && ch <= '9') {
        const w = this.wheels[wi++]
        const pos = w ? w.pos : Number(ch)
        const d = Math.floor(pos) % 10
        const frac = pos - Math.floor(pos)
        const off = Math.round(frac * (H + gap))
        const base = afterPoint ? colors.dec : colors.int
        const heat = w ? clamp01(Math.abs(((w.target - pos + 10) % 10)) / 3) : 0
        const col = frac > 0.001 || heat > 0.01 ? mixPacked(base, colors.moving, 0.35 + 0.65 * clamp01(heat + frac * 0.5)) : base
        cx += drawRolling(grid, cx, y, font[String(d)], font[String((d + 1) % 10)], off, gap, col, f)
      } else {
        const g = font[ch]
        if (!g) {
          first = true
          continue
        }
        cx += drawRolling(grid, cx, y, g, null, 0, 0, afterPoint ? colors.dec : colors.int, f)
      }
    }
    return cx - x
  }

  width(f: FontSize): number {
    return fontWidth(this.text, f)
  }
}

// ─── frames, rules, labels ──────────────────────────────────────────────────

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Corner ticks (brutalist framing): ┌─ ─┐ └─ ─┘ with arms of `len` cells. */
export function corners(grid: Grid, r: Rect, color: number, len = 2): void {
  const x1 = r.x + r.w - 1
  const y1 = r.y + r.h - 1
  grid.put(r.x, r.y, '┌', color)
  grid.put(x1, r.y, '┐', color)
  grid.put(r.x, y1, '└', color)
  grid.put(x1, y1, '┘', color)
  for (let i = 1; i < len; i++) {
    grid.put(r.x + i, r.y, '─', color)
    grid.put(x1 - i, r.y, '─', color)
    grid.put(r.x + i, y1, '─', color)
    grid.put(x1 - i, y1, '─', color)
  }
}

/** Horizontal rule; `reveal` (0..1) draws it from the left. */
export function hrule(grid: Grid, x: number, y: number, w: number, color: number, ch = '─', reveal = 1): void {
  const n = Math.round(w * clamp01(reveal))
  for (let i = 0; i < n; i++) grid.put(x + i, y, ch, color)
}

export function vrule(grid: Grid, x: number, y: number, h: number, color: number, ch = '│', reveal = 1): void {
  const n = Math.round(h * clamp01(reveal))
  for (let i = 0; i < n; i++) grid.put(x, y + i, ch, color)
}

/** "T R A I N I N G" — mono tracking for labels. */
export function track(s: string): string {
  return [...s].join(' ')
}

/** "[ 01 ]  T R A I N I N G" header. Returns x after the label. */
export function bracketLabel(grid: Grid, x: number, y: number, num: string, title: string, opts: { tracked?: boolean; numColor?: number; titleColor?: number; reveal?: number } = {}): number {
  const r = opts.reveal ?? 1
  const head = `[ ${num} ]`
  const titleText = opts.tracked === false ? title : track(title)
  const full = `${head}  ${titleText}`
  const n = Math.round(full.length * clamp01(r))
  let cx = x
  for (let i = 0; i < n; i++) {
    const ch = full[i]
    const inHead = i < head.length
    const isNum = inHead && ch !== '[' && ch !== ']' && ch !== ' '
    const col = inHead ? (isNum ? (opts.numColor ?? C.hot) : C.bone32) : (opts.titleColor ?? C.bone62)
    grid.put(cx++, y, ch, col, inHead ? 0 : BOLD)
  }
  return x + full.length
}

/** Right-aligned text ending at x1 (exclusive). Returns the start x. */
export function textRight(grid: Grid, x1: number, y: number, s: string, color: number, at = 0): number {
  const len = [...s].length
  grid.text(x1 - len, y, s, color, at)
  return x1 - len
}

/** Segments of [text, color] laid out left to right. Returns the x after. */
export function spans(grid: Grid, x: number, y: number, parts: [string, number, number?][], max = Infinity): number {
  let cx = x
  const end = x + max
  for (const [s, c, at] of parts) {
    if (cx >= end) break
    cx = grid.text(cx, y, s, c, at ?? 0, end - cx)
  }
  return cx
}

export const spansWidth = (parts: [string, number, number?][]): number => parts.reduce((n, p) => n + [...p[0]].length, 0)

/** Hairline gauge: heavy ━ for the filled part (with a ╸ half cell), light ─ for the rest. */
export function gauge(grid: Grid, x: number, y: number, w: number, frac: number, fill: number, empty: number, ascii = false): void {
  const f = clamp01(frac) * w
  const full = Math.floor(f)
  const half = f - full >= 0.5
  for (let i = 0; i < w; i++) {
    if (i < full) grid.put(x + i, y, ascii ? '=' : '━', fill)
    else if (i === full && half) grid.put(x + i, y, ascii ? '-' : '╸', fill)
    else grid.put(x + i, y, ascii ? '-' : '─', empty)
  }
}

/** Two-part bar (e.g. escrow): a = confirmed share, b = pending share after it. */
export function splitBar(grid: Grid, x: number, y: number, w: number, a: number, b: number, ca: number, cb: number, empty: number, ascii = false): void {
  const tot = a + b
  const na = tot > 0 ? Math.round((a / tot) * w) : 0
  const nb = tot > 0 ? w - na : 0
  for (let i = 0; i < w; i++) {
    if (i < na) grid.put(x + i, y, ascii ? '=' : '━', ca)
    else if (i < na + nb) grid.put(x + i, y, ascii ? '~' : '┅', cb)
    else grid.put(x + i, y, ascii ? '-' : '─', empty)
  }
}

/** Braille sparkline of `values` into a w×h cell box (auto-scaled). */
export function sparkline(grid: Grid, canvas: BrailleCanvas, x: number, y: number, w: number, h: number, values: number[], line: readonly [number, number, number], head: readonly [number, number, number]): void {
  if (w < 2 || h < 1 || values.length < 2) return
  if (canvas.cols !== w || canvas.lines !== h) canvas.resize(w, h)
  else canvas.clear()
  const n = Math.min(values.length, w * 2)
  const vs = values.slice(-n)
  let lo = Infinity
  let hi = -Infinity
  for (const v of vs) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const span = hi - lo || Math.abs(hi) * 0.02 || 1
  const H = h * 4 - 1
  const X = (i: number) => w * 2 - n + i
  const Y = (v: number) => H - ((v - lo) / span) * H
  for (let i = 1; i < vs.length; i++) canvas.line(X(i - 1), Y(vs[i - 1]), X(i), Y(vs[i]), line, 0.85)
  canvas.plot(X(vs.length - 1), Y(vs[vs.length - 1]), head, 1.4)
  const rows = canvas.rows()
  for (let r = 0; r < rows.length; r++) grid.ansi(x, y + r, rows[r], w, true)
}

// ─── formatting ─────────────────────────────────────────────────────────────

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII']
export const roman = (i: number): string => ROMAN[((i % 8) + 8) % 8]

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

export function fmtClock(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

/** "42 S", "3 MIN", "1 H 04" — elapsed time, coarse. */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} S`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} MIN`
  const h = Math.floor(m / 60)
  return `${h} H ${String(m % 60).padStart(2, '0')}`
}

/** Keep the ends of a long string: "wss://lusca.ink/ws" stays, long ones become "wss://…/ws". */
export function ellipsize(s: string, max: number): string {
  const cs = [...s]
  if (cs.length <= max) return s
  if (max <= 1) return '…'
  const head = Math.ceil((max - 1) * 0.6)
  const tail = max - 1 - head
  return cs.slice(0, head).join('') + '…' + (tail > 0 ? cs.slice(-tail).join('') : '')
}

export function padRight(s: string, n: number): string {
  const len = [...s].length
  return len >= n ? s : s + ' '.repeat(n - len)
}
