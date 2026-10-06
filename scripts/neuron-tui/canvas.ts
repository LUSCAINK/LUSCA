// BrailleCanvas — a high-resolution point canvas for the terminal.
//
// Each terminal cell holds a 2×4 grid of braille dots (U+2800–U+28FF), so a 56×22 cell panel
// is a 112×88 dot canvas with roughly square dots. A cell can only carry one foreground colour,
// so light is accumulated per cell: the brightest contribution picks the hue, and the other
// contributions in the cell add energy on top (overexposed cells roll off toward white-hot,
// never to yellow). `rows()` returns one string per terminal row with colour escapes from
// theme.ts (truecolor, 256 or none) and a trailing reset, so nothing leaks past the row.
//
// Glyph modes (same 2×4 dot grid, different characters):
//   'braille'  U+2800–U+28FF. Terminals that draw braille themselves (kitty, WezTerm) show even
//              round dots; terminals that take it from the font show smaller, gappier dots.
//   'octant'   Unicode 16 block octants (U+1CD00–U+1CDE5 plus the quadrant / half / quarter
//              blocks that already covered the other 26 patterns). Windows Terminal ≥ 1.22 draws
//              these itself as solid tiles that join seamlessly, so the same art reads as dense,
//              luminous pixels instead of faint font dots. Chosen for Windows Terminal.
//   'ascii'    (for terminals without either) half blocks (▀ ▄ █) and small dots (· . :).
//
// Coordinates: x in [0, cols*2), y in [0, rows*4); fractional values floor to a dot.

import { colorLevel, fg } from './theme.ts'
import type { RGB } from './theme.ts'

export type GlyphMode = 'braille' | 'octant' | 'ascii'

// braille bit for dot (dx, dy) inside a cell
const BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

// octant pattern (bit dy*2+dx, row-major from the top left) → character. The octant block is
// assigned in increasing pattern order, skipping the 26 patterns older characters already draw.
const OCT_OLD: Record<number, number> = {
  0: 0x20, 1: 0x1cea8, 2: 0x1ceab, 3: 0x1fb82, 5: 0x2598, 10: 0x259d, 15: 0x2580, 20: 0x1fbe6, 40: 0x1fbe7,
  63: 0x1fb85, 64: 0x1cea3, 80: 0x2596, 85: 0x258c, 90: 0x259e, 95: 0x259b, 128: 0x1cea0, 160: 0x2597,
  165: 0x259a, 170: 0x2590, 175: 0x259c, 192: 0x2582, 240: 0x2584, 245: 0x2599, 250: 0x259f, 252: 0x2586,
  255: 0x2588,
}
const OCTANT: string[] = (() => {
  const out: string[] = []
  let k = 0x1cd00
  for (let b = 0; b < 256; b++) out.push(String.fromCodePoint(OCT_OLD[b] ?? k++))
  return out
})()

/** Alpha below which a plot only adds light to its cell without lighting its dot. */
const DOT_MIN = 0.045

export class BrailleCanvas {
  cols = 0
  lines = 0
  /** width in dots (cols*2) */
  w = 0
  /** height in dots (lines*4) */
  h = 0
  readonly ascii: boolean
  readonly glyphs: GlyphMode
  /** Share of non-brightest light added to a cell (0 = pure "brightest wins"). */
  glow = 0.16

  private dot = new Float32Array(0) // max alpha per dot
  private bestK = new Float32Array(0) // brightness key of the brightest contribution per cell
  private bestR = new Float32Array(0)
  private bestG = new Float32Array(0)
  private bestB = new Float32Array(0)
  private bestA = new Float32Array(0)
  private sumA = new Float32Array(0)
  private text: (string | undefined)[] = []
  private textRgb: (RGB | undefined)[] = []

  constructor(cols: number, rows: number, opts?: { ascii?: boolean; glyphs?: GlyphMode }) {
    this.glyphs = opts?.ascii ? 'ascii' : (opts?.glyphs ?? 'braille')
    this.ascii = this.glyphs === 'ascii'
    // solid tiles already read as dense light: add less of a crowded cell's extra energy
    if (this.glyphs !== 'braille') this.glow = 0.06
    this.resize(cols, rows)
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(1, Math.floor(cols))
    rows = Math.max(1, Math.floor(rows))
    if (cols === this.cols && rows === this.lines) {
      this.clear()
      return
    }
    this.cols = cols
    this.lines = rows
    this.w = cols * 2
    this.h = rows * 4
    const n = cols * rows
    this.dot = new Float32Array(this.w * this.h)
    this.bestK = new Float32Array(n)
    this.bestR = new Float32Array(n)
    this.bestG = new Float32Array(n)
    this.bestB = new Float32Array(n)
    this.bestA = new Float32Array(n)
    this.sumA = new Float32Array(n)
    this.text = new Array(n).fill(undefined)
    this.textRgb = new Array(n).fill(undefined)
  }

  clear(): void {
    this.dot.fill(0)
    this.bestK.fill(0)
    this.sumA.fill(0)
    this.bestA.fill(0)
    this.text.fill(undefined)
    this.textRgb.fill(undefined)
  }

  /** Light one dot. `a` (default 1) is intensity; values above 1 overexpose toward white. */
  plot(x: number, y: number, rgb: ArrayLike<number>, a = 1): void {
    if (!(x >= 0 && y >= 0 && x < this.w && y < this.h) || !(a > 0.004)) return
    const xi = x | 0
    const yi = y | 0
    const di = yi * this.w + xi
    if (a > this.dot[di]) this.dot[di] = a
    const ci = (yi >> 2) * this.cols + (xi >> 1)
    this.sumA[ci] += a
    const r = rgb[0]
    const g = rgb[1]
    const b = rgb[2]
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b
    const k = (mx + 0.25 * mn) * a
    if (k > this.bestK[ci]) {
      this.bestK[ci] = k
      this.bestR[ci] = r
      this.bestG[ci] = g
      this.bestB[ci] = b
      this.bestA[ci] = a
    }
  }

  /** Dotted line (one dot per step, inclusive). */
  line(x0: number, y0: number, x1: number, y1: number, rgb: ArrayLike<number>, a = 1): void {
    const dx = x1 - x0
    const dy = y1 - y0
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))))
    for (let i = 0; i <= n; i++) {
      const t = i / n
      this.plot(x0 + dx * t + 0.5, y0 + dy * t + 0.5, rgb, a)
    }
  }

  /** Hairline circle (dot coordinates; ry defaults to r). */
  ring(cx: number, cy: number, r: number, rgb: ArrayLike<number>, a = 1, ry = r): void {
    const n = Math.max(8, Math.ceil(2 * Math.PI * Math.max(r, ry) * 1.15))
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2
      this.plot(cx + Math.cos(t) * r + 0.5, cy + Math.sin(t) * ry + 0.5, rgb, a)
    }
  }

  /** Put text into cells (col,row in cells) over the dots — for labels on the art. */
  label(col: number, row: number, s: string, rgb: RGB): void {
    if (row < 0 || row >= this.lines) return
    let c = Math.floor(col)
    for (const ch of s) {
      if (c >= 0 && c < this.cols) {
        const i = row * this.cols + c
        this.text[i] = ch
        this.textRgb[i] = rgb
      }
      c++
    }
  }

  /** Final colour of a cell (0..255 floats), after the white-hot roll-off. */
  private cellColor(ci: number, out: Float32Array): void {
    const a = this.bestA[ci]
    let e = a + this.glow * (this.sumA[ci] - a)
    let r = this.bestR[ci]
    let g = this.bestG[ci]
    let b = this.bestB[ci]
    if (e > 1) {
      // overexposed: roll off toward white-hot, keep the hue's warmth
      const w = Math.min(0.75, (e - 1) * 0.45)
      r += (255 - r) * w
      g += (247 - g) * w
      b += (238 - b) * w
      e = 1
    }
    out[0] = r * e
    out[1] = g * e
    out[2] = b * e
  }

  /** Resolve cell `ci`: returns its character ('' when blank) and leaves the packed
   *  0xRRGGBB colour in this.rc. */
  private rc = 0
  private resolve(ci: number, col: Float32Array): string {
    const t = this.text[ci]
    if (t !== undefined) {
      const tr = this.textRgb[ci]!
      this.rc = ((tr[0] & 255) << 16) | ((tr[1] & 255) << 8) | (tr[2] & 255)
      return t
    }
    const W = this.w
    const x0 = (ci % this.cols) * 2
    const y0 = Math.floor(ci / this.cols) * 4
    let bits = 0
    let oct = 0
    let top = 0
    let bot = 0
    for (let dy = 0; dy < 4; dy++) {
      const base = (y0 + dy) * W + x0
      if (this.dot[base] >= DOT_MIN) {
        bits |= BIT[dy][0]
        oct |= 1 << (dy * 2)
        if (dy < 2) top++
        else bot++
      }
      if (this.dot[base + 1] >= DOT_MIN) {
        bits |= BIT[dy][1]
        oct |= 2 << (dy * 2)
        if (dy < 2) top++
        else bot++
      }
    }
    if (bits === 0) return ''
    this.cellColor(ci, col)
    // quantise a little so neighbouring cells share escapes
    const r = Math.min(255, Math.round(col[0] / 3) * 3)
    const g = Math.min(255, Math.round(col[1] / 3) * 3)
    const b = Math.min(255, Math.round(col[2] / 3) * 3)
    this.rc = (r << 16) | (g << 8) | b
    if (this.glyphs === 'braille') return String.fromCharCode(0x2800 + bits)
    if (this.glyphs === 'octant') return OCTANT[oct]
    if (top >= 2 && bot >= 2) return '█'
    if (top >= 2) return '▀'
    if (bot >= 2) return '▄'
    if (top && bot) return ':'
    return top ? '·' : '.'
  }

  /** One coloured string per terminal row (colour escapes at the theme's current level).
   *  Each row that emits colour ends in \x1b[0m, so nothing leaks. */
  rows(): string[] {
    const out: string[] = []
    const none = colorLevel() === 'none'
    const col = new Float32Array(3)
    const rgb: RGB = [0, 0, 0]
    for (let row = 0; row < this.lines; row++) {
      let s = ''
      let cur = -1
      let colored = false
      for (let c = 0; c < this.cols; c++) {
        const ch = this.resolve(row * this.cols + c, col)
        if (ch === '') {
          s += ' '
          continue
        }
        if (!none && this.rc !== cur) {
          cur = this.rc
          rgb[0] = (cur >> 16) & 255
          rgb[1] = (cur >> 8) & 255
          rgb[2] = cur & 255
          s += fg(rgb)
          colored = true
        }
        s += ch
      }
      if (colored) s += '\x1b[0m'
      out.push(s)
    }
    return out
  }

  /** The frame as raw cells (row-major, cols × lines): `ch` is ' ' for blank cells and
   *  `rgb` the packed 0xRRGGBB foreground, or -1 for blank cells. For compositors that would
   *  otherwise parse rows() back. */
  cells(): { ch: string[]; rgb: Int32Array } {
    const n = this.cols * this.lines
    const ch: string[] = new Array(n)
    const rgb = new Int32Array(n)
    const col = new Float32Array(3)
    for (let i = 0; i < n; i++) {
      const c = this.resolve(i, col)
      if (c === '') {
        ch[i] = ' '
        rgb[i] = -1
      } else {
        ch[i] = c
        rgb[i] = this.rc
      }
    }
    return { ch, rgb }
  }
}
