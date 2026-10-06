// Cell grid compositor for the LUSCA neuron dashboard (owner: dashboard).
//
// Every frame is composed into a Grid of cells (one code point + a packed RGB foreground + attrs;
// the terminal's own background is never painted). Braille canvas rows arrive as ANSI strings and
// are parsed back into cells, so text, hairlines and point-cloud art share one buffer. A frame is
// then encoded as the minimal diff against the previous frame — cursor jumps over unchanged runs,
// one SGR per style change — at the terminal's color level (truecolor, 256 or none).

import type { ColorLevel } from './term.ts'
import { rgbTo256 } from './theme.ts'

export type Rgb = readonly [number, number, number]

/** -1 = terminal default foreground. */
export const DEFAULT_FG = -1
export const BOLD = 1

export const pack = (c: Rgb): number => ((c[0] & 255) << 16) | ((c[1] & 255) << 8) | (c[2] & 255)

export function mixPacked(a: number, b: number, t: number): number {
  if (a < 0) a = 0xf2efe8
  if (b < 0) b = 0xf2efe8
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t
  const r = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * k
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * k
  const bl = (a & 255) + ((b & 255) - (a & 255)) * k
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl)
}

// ─── 256-color mapping ───────────────────────────────────────────────────────

const CUBE = [0, 95, 135, 175, 215, 255]
const cache256 = new Map<number, number>()

export function to256(p: number): number {
  const hit = cache256.get(p)
  if (hit !== undefined) return hit
  const idx = rgbTo256((p >> 16) & 255, (p >> 8) & 255, p & 255)
  if (cache256.size > 8192) cache256.clear()
  cache256.set(p, idx)
  return idx
}

const BASIC16 = [
  0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff,
  0xff00ff, 0x00ffff, 0xffffff,
]

export function from256(n: number): number {
  if (n < 16) return BASIC16[n] ?? 0xf2efe8
  if (n >= 232) {
    const v = 8 + 10 * (n - 232)
    return (v << 16) | (v << 8) | v
  }
  const i = n - 16
  return (CUBE[Math.floor(i / 36) % 6] << 16) | (CUBE[Math.floor(i / 6) % 6] << 8) | CUBE[i % 6]
}

/** SGR for a style, always starting from a reset so styles never leak. '' when level is none. */
export function sgr(fg: number, at: number, level: ColorLevel): string {
  if (level === 'none') return ''
  let s = '\x1b[0'
  if (at & BOLD) s += ';1'
  if (fg >= 0) {
    if (level === 'truecolor') s += `;38;2;${(fg >> 16) & 255};${(fg >> 8) & 255};${fg & 255}`
    else s += `;38;5;${to256(fg)}`
  }
  return s + 'm'
}

// ─── grid ────────────────────────────────────────────────────────────────────

export class Grid {
  w = 0
  h = 0
  ch: string[] = []
  fg: Int32Array = new Int32Array(0)
  at: Uint8Array = new Uint8Array(0)

  constructor(w: number, h: number) {
    this.resize(w, h)
  }

  resize(w: number, h: number): void {
    this.w = Math.max(1, w | 0)
    this.h = Math.max(1, h | 0)
    const n = this.w * this.h
    this.ch = new Array<string>(n).fill(' ')
    this.fg = new Int32Array(n).fill(DEFAULT_FG)
    this.at = new Uint8Array(n)
  }

  clear(): void {
    this.ch.fill(' ')
    this.fg.fill(DEFAULT_FG)
    this.at.fill(0)
  }

  put(x: number, y: number, ch: string, fg: number, at = 0): void {
    x |= 0
    y |= 0
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = y * this.w + x
    this.ch[i] = ch
    this.fg[i] = fg
    this.at[i] = at
  }

  get(x: number, y: number): string {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return ' '
    return this.ch[y * this.w + x]
  }

  /** Write text (one cell per code point), clipped to [x, x+max). Returns the x after the text. */
  text(x: number, y: number, s: string, fg: number, at = 0, max = Infinity): number {
    x |= 0
    const end = Math.min(this.w, x + max)
    for (const c of s) {
      if (x >= end) break
      if (c !== '\u0000') this.put(x, y, c, fg, at)
      x++
    }
    return x
  }

  /** Text where spaces are transparent (overlays on art). */
  overlay(x: number, y: number, s: string, fg: number, at = 0): number {
    x |= 0
    for (const c of s) {
      if (c !== ' ') this.put(x, y, c, fg, at)
      x++
    }
    return x
  }

  /**
   * Parse one ANSI-colored row (SGR 0/1/2/22/39, 38;2;r;g;b, 38;5;n) into cells at (x, y).
   * Spaces are written as blanks; `transparent` skips them so art can sit under text.
   */
  ansi(x: number, y: number, s: string, max = Infinity, transparent = false): void {
    let fg = DEFAULT_FG
    let at = 0
    let cx = x | 0
    const end = Math.min(this.w, cx + max)
    for (let i = 0; i < s.length && cx < end; ) {
      const c = s.charCodeAt(i)
      if (c === 0x1b) {
        if (s[i + 1] === '[') {
          let j = i + 2
          while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++
          if (s[j] === 'm') {
            const ps = s.slice(i + 2, j).split(';')
            if (ps.length === 1 && ps[0] === '') ps[0] = '0'
            for (let k = 0; k < ps.length; k++) {
              const p = Number(ps[k])
              if (p === 0) {
                fg = DEFAULT_FG
                at = 0
              } else if (p === 1) at |= BOLD
              else if (p === 22) at &= ~BOLD
              else if (p === 39) fg = DEFAULT_FG
              else if (p === 38 && ps[k + 1] === '2') {
                fg = ((Number(ps[k + 2]) & 255) << 16) | ((Number(ps[k + 3]) & 255) << 8) | (Number(ps[k + 4]) & 255)
                k += 4
              } else if (p === 38 && ps[k + 1] === '5') {
                fg = from256(Number(ps[k + 2]))
                k += 2
              } else if (p >= 30 && p <= 37) fg = BASIC16[p - 30]
              else if (p >= 90 && p <= 97) fg = BASIC16[p - 90 + 8]
            }
          }
          i = j + 1
        } else {
          i += 2
        }
        continue
      }
      const cp = s.codePointAt(i) ?? 32
      const ch = String.fromCodePoint(cp)
      i += ch.length
      if (cp < 32) continue
      if (!(transparent && (cp === 32 || cp === 0x2800))) this.put(cx, y, ch, fg, at)
      cx++
    }
  }

  /** Blend every foreground in the rect toward `toward` by t (0 = unchanged). Used for fades. */
  fade(x: number, y: number, w: number, h: number, t: number, toward = 0x050505): void {
    if (t <= 0) return
    const x0 = Math.max(0, x | 0)
    const y0 = Math.max(0, y | 0)
    const x1 = Math.min(this.w, (x + w) | 0)
    const y1 = Math.min(this.h, (y + h) | 0)
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = yy * this.w + xx
        if (this.ch[i] === ' ') continue
        if (t >= 1) {
          this.ch[i] = ' '
          this.fg[i] = DEFAULT_FG
          this.at[i] = 0
        } else {
          this.fg[i] = mixPacked(this.fg[i], toward, t)
        }
      }
    }
  }

  /**
   * Blank every cell whose colour is too dark to read. Fades end at the brand ground (#050505),
   * but most terminals sit a little lighter (Windows Terminal: #0c0c0c), where a nearly faded
   * glyph would show as a darker shape instead of disappearing.
   */
  dropDark(min = 18): void {
    for (let i = 0; i < this.ch.length; i++) {
      const f = this.fg[i]
      if (f < 0 || this.ch[i] === ' ') continue
      if (((f >> 16) & 255) < min && ((f >> 8) & 255) < min && (f & 255) < min) {
        this.ch[i] = ' '
        this.fg[i] = DEFAULT_FG
        this.at[i] = 0
      }
    }
  }

  /** Blank the rect. */
  erase(x: number, y: number, w: number, h: number): void {
    this.fade(x, y, w, h, 1)
  }

  copyFrom(g: Grid): void {
    if (g.w !== this.w || g.h !== this.h) this.resize(g.w, g.h)
    for (let i = 0; i < g.ch.length; i++) this.ch[i] = g.ch[i]
    this.fg.set(g.fg)
    this.at.set(g.at)
  }
}

/**
 * Encode `next` as terminal output. With `prev` (same size) only changed cells are written;
 * without it the whole screen is repainted. The result starts with no assumption about the
 * cursor or style and ends with a reset.
 */
export function encodeFrame(prev: Grid | null, next: Grid, level: ColorLevel): string {
  const full = !prev || prev.w !== next.w || prev.h !== next.h
  const parts: string[] = []
  if (full) parts.push('\x1b[0m\x1b[2J')
  let curFg = -2
  let curAt = -1
  let cx = -1
  let cy = -1
  const W = next.w
  for (let y = 0; y < next.h; y++) {
    const row = y * W
    for (let x = 0; x < W; x++) {
      const i = row + x
      if (!full && prev!.ch[i] === next.ch[i] && prev!.fg[i] === next.fg[i] && prev!.at[i] === next.at[i]) continue
      if (full && next.ch[i] === ' ') continue // the screen was just cleared
      if (cy !== y || cx !== x) {
        // Small gap on the same row in the current style: re-send those cells instead of a jump.
        const gap = x - cx
        let bridged = false
        if (cy === y && gap > 0 && gap <= 4) {
          let ok = true
          for (let k = cx; k < x; k++) {
            const j = row + k
            if (!(next.ch[j] === ' ' || (next.fg[j] === curFg && next.at[j] === curAt))) {
              ok = false
              break
            }
          }
          if (ok) {
            for (let k = cx; k < x; k++) parts.push(next.ch[row + k])
            bridged = true
          }
        }
        if (!bridged) parts.push(`\x1b[${y + 1};${x + 1}H`)
      }
      const f = next.fg[i]
      const a = next.at[i]
      if (f !== curFg || a !== curAt) {
        // A space only needs a style if it is bold (it never does): skip style churn for blanks.
        if (next.ch[i] !== ' ' || curFg === -2) {
          parts.push(sgr(f, a, level))
          curFg = f
          curAt = a
        }
      }
      parts.push(next.ch[i])
      cx = x + 1
      cy = y
    }
  }
  if (level !== 'none') parts.push('\x1b[0m')
  return parts.join('')
}

/** The whole grid as one ANSI string per row (for snapshots / the QA renderer). */
export function gridRows(g: Grid, level: ColorLevel): string[] {
  const rows: string[] = []
  for (let y = 0; y < g.h; y++) {
    let s = ''
    let curFg = -2
    let curAt = -1
    let last = g.w - 1
    while (last >= 0 && g.ch[y * g.w + last] === ' ') last--
    for (let x = 0; x <= last; x++) {
      const i = y * g.w + x
      const ch = g.ch[i]
      if (ch !== ' ' && (g.fg[i] !== curFg || g.at[i] !== curAt)) {
        s += sgr(g.fg[i], g.at[i], level)
        curFg = g.fg[i]
        curAt = g.at[i]
      }
      s += ch
    }
    if (level !== 'none' && curFg !== -2) s += '\x1b[0m'
    rows.push(s)
  }
  return rows
}
