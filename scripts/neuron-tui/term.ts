// Terminal plumbing for the LUSCA neuron dashboard (owner: dashboard).
//
//  · TermIO     — the real terminal (process.stdout/stdin) or a virtual one (fixed size, writes
//                 captured, keys injected) so frames can be rendered to strings for QA.
//  · Screen     — alternate screen buffer, hidden cursor, no auto-wrap, raw keyboard, and a
//                 restore that is guaranteed on stop, process exit, signals and uncaught errors.
//  · FrameLoop  — ~20 fps scheduler that never starves the event loop: it always leaves idle time
//                 between frames, skips a frame while the terminal has not drained the last one,
//                 and can be stepped manually (virtual time) by the preview driver.
//
// Node built-ins only; bundled into dist/neuron.mjs.

import fs from 'node:fs'
import type { GlyphMode } from './canvas.ts'

export type ColorLevel = 'truecolor' | '256' | 'none'

export const SEQ = {
  altOn: '\x1b[?1049h',
  altOff: '\x1b[?1049l',
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  wrapOff: '\x1b[?7l',
  wrapOn: '\x1b[?7h',
  syncOn: '\x1b[?2026h',
  syncOff: '\x1b[?2026l',
  clear: '\x1b[2J',
  home: '\x1b[H',
  reset: '\x1b[0m',
} as const

export interface TermIO {
  readonly virtual: boolean
  cols(): number
  rows(): number
  /** Queue output (one call per frame). */
  write(s: string): void
  /** Write immediately and synchronously (exit paths). */
  writeSync(s: string): void
  /** Bytes queued but not yet flushed by the OS (0 when unknown). */
  backlog(): number
  onResize(cb: () => void): () => void
  onKey(cb: (key: string) => void): () => void
  /** Raw keyboard on/off; a no-op when stdin is not a TTY. */
  setRaw(on: boolean): void
}

/** Split a stdin chunk into keys: printable chars one by one, an escape sequence as one key. */
export function splitKeys(chunk: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < chunk.length) {
    const c = chunk[i]
    if (c === '\x1b' && i + 1 < chunk.length) {
      // CSI / SS3: ESC [ ... final byte (0x40–0x7e)  |  ESC O x  |  Alt+key: ESC x
      let j = i + 1
      if (chunk[j] === '[' || chunk[j] === 'O') {
        j++
        while (j < chunk.length && !/[\x40-\x7e]/.test(chunk[j])) j++
        j++
      } else {
        j++
      }
      out.push(chunk.slice(i, j))
      i = j
      continue
    }
    const cp = chunk.codePointAt(i) ?? 0
    const s = String.fromCodePoint(cp)
    out.push(s)
    i += s.length
  }
  return out
}

/** The process terminal. */
export function realTerm(): TermIO {
  const out = process.stdout
  const inp = process.stdin
  return {
    virtual: false,
    cols: () => out.columns || 80,
    rows: () => out.rows || 24,
    write: (s) => {
      out.write(s)
    },
    writeSync: (s) => {
      try {
        fs.writeSync(typeof out.fd === 'number' ? out.fd : 1, s)
      } catch {
        try {
          out.write(s)
        } catch {
          /* terminal gone */
        }
      }
    },
    backlog: () => out.writableLength || 0,
    onResize: (cb) => {
      out.on('resize', cb)
      // SIGWINCH also reaches us on POSIX; stdout 'resize' covers it and Windows (console polling).
      return () => {
        out.off('resize', cb)
      }
    },
    onKey: (cb) => {
      if (!inp.isTTY) return () => {}
      const onData = (d: Buffer | string) => {
        for (const k of splitKeys(typeof d === 'string' ? d : d.toString('utf8'))) cb(k)
      }
      inp.on('data', onData)
      return () => {
        inp.off('data', onData)
      }
    },
    setRaw: (on) => {
      if (!inp.isTTY) return
      try {
        inp.setRawMode(on)
        if (on) {
          inp.resume()
          // Never keep the process alive just for the keyboard.
          ;(inp as unknown as { unref?: () => void }).unref?.()
        } else {
          inp.pause()
        }
      } catch {
        /* stdin closed */
      }
    },
  }
}

export interface VirtualTerm extends TermIO {
  /** Everything written since the last take(). */
  take(): string
  resize(cols: number, rows: number): void
  press(key: string): void
}

/** A fixed-size terminal that records output; for the preview driver and tests. */
export function virtualTerm(cols: number, rows: number): VirtualTerm {
  let c = cols
  let r = rows
  let buf: string[] = []
  const resizeCbs = new Set<() => void>()
  const keyCbs = new Set<(k: string) => void>()
  return {
    virtual: true,
    cols: () => c,
    rows: () => r,
    write: (s) => {
      buf.push(s)
    },
    writeSync: (s) => {
      buf.push(s)
    },
    backlog: () => 0,
    onResize: (cb) => {
      resizeCbs.add(cb)
      return () => resizeCbs.delete(cb)
    },
    onKey: (cb) => {
      keyCbs.add(cb)
      return () => keyCbs.delete(cb)
    },
    setRaw: () => {},
    take: () => {
      const s = buf.join('')
      buf = []
      return s
    },
    resize: (nc, nr) => {
      c = nc
      r = nr
      for (const cb of resizeCbs) cb()
    },
    press: (k) => {
      for (const cb of keyCbs) cb(k)
    },
  }
}

/**
 * Color capability: honors NO_COLOR / FORCE_COLOR / COLORTERM / TERM through Node's own
 * getColorDepth (which also knows Windows 10+ consoles and Windows Terminal are 24-bit).
 */
export function detectColorLevel(color: boolean): ColorLevel {
  if (!color || process.env.NO_COLOR) return 'none'
  const ct = (process.env.COLORTERM || '').toLowerCase()
  if (ct.includes('truecolor') || ct.includes('24bit')) return 'truecolor'
  if (process.env.WT_SESSION) return 'truecolor' // Windows Terminal does not set COLORTERM
  let depth = 8
  try {
    depth = process.stdout.isTTY ? process.stdout.getColorDepth() : 8
  } catch {
    /* not a tty */
  }
  if (depth >= 24) return 'truecolor'
  if (depth <= 1) return 'none'
  return '256'
}

export type { GlyphMode } from './canvas.ts'

/**
 * Which characters the point-cloud art uses (see canvas.ts). Windows Terminal draws Unicode 16
 * block octants itself as solid tiles (checked on 1.24), while it takes braille from the font as
 * small, gappy dots, so it gets octants; every other terminal gets braille. --ascii forces half
 * blocks; LUSCA_NEURON_GLYPHS=braille|octant|ascii overrides the choice.
 */
export function detectGlyphs(ascii: boolean, env: NodeJS.ProcessEnv = process.env): GlyphMode {
  if (ascii) return 'ascii'
  const o = (env.LUSCA_NEURON_GLYPHS || '').toLowerCase()
  if (o === 'braille' || o === 'octant' || o === 'ascii') return o
  if (env.WT_SESSION) return 'octant'
  return 'braille'
}

type Cleanup = () => void

/**
 * Alternate screen + hidden cursor + raw keyboard, with a restore that runs exactly once:
 * on leave(), on process 'exit', before an uncaught exception is printed (so the stack lands on
 * the normal screen), and on SIGTERM/SIGHUP/SIGINT when nobody else handles them.
 */
export class Screen {
  private on = false
  private guards: Cleanup[] = []

  constructor(private readonly term: TermIO) {}

  get active(): boolean {
    return this.on
  }

  enter(): void {
    if (this.on) return
    this.on = true
    this.term.write(SEQ.altOn + SEQ.hide + SEQ.wrapOff + SEQ.reset + SEQ.clear + SEQ.home)
    this.term.setRaw(true)
    if (this.term.virtual) return
    const restore = () => this.leave(true)
    const onExit = () => restore()
    // Only when the error is really fatal (nobody installed an uncaughtException handler).
    const onFatal = () => {
      if (process.listenerCount('uncaughtException') === 0) restore()
    }
    process.on('exit', onExit)
    process.on('uncaughtExceptionMonitor', onFatal)
    this.guards.push(() => process.off('exit', onExit), () => process.off('uncaughtExceptionMonitor', onFatal))
    const sigs: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGTERM', 'SIGHUP']
    for (const sig of sigs) {
      const h = () => {
        // Someone else (neuron.ts) handles it and will call stop(): leave it to them.
        if (process.listenerCount(sig) > 1) return
        restore()
        process.exit(sig === 'SIGHUP' ? 129 : 143)
      }
      process.on(sig, h)
      this.guards.push(() => process.off(sig, h))
    }
  }

  /** Restore the terminal. `sync` writes with fs.writeSync (exit paths). Idempotent. */
  leave(sync = false): void {
    if (!this.on) return
    this.on = false
    const seq = SEQ.syncOff + SEQ.reset + SEQ.wrapOn + SEQ.show + SEQ.altOff
    this.term.setRaw(false)
    if (sync) this.term.writeSync(seq)
    else this.term.write(seq)
    for (const g of this.guards.splice(0)) g()
  }
}

/** Frame scheduler. Real mode drives itself with timers; virtual mode is stepped by step(now). */
export class FrameLoop {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private interval: number
  /** Rolling mean frame cost in ms. */
  cost = 0
  frames = 0
  skipped = 0

  constructor(
    private readonly opts: {
      fps: number
      now: () => number
      render: (now: number) => void
      /** false while the terminal is still flushing the previous frame */
      canWrite: () => boolean
    },
  ) {
    this.interval = 1000 / opts.fps
  }

  setFps(fps: number): void {
    this.interval = 1000 / Math.max(1, fps)
  }

  get fps(): number {
    return 1000 / this.interval
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule(0)
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Render one frame now (virtual time, or an out-of-band refresh). */
  step(now = this.opts.now()): void {
    if (!this.opts.canWrite()) {
      this.skipped++
      return
    }
    const t0 = this.opts.now()
    this.opts.render(now)
    const dt = this.opts.now() - t0
    this.cost = this.frames === 0 ? dt : this.cost * 0.9 + dt * 0.1
    this.frames++
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.running) return
      const t0 = this.opts.now()
      this.step(t0)
      const spent = this.opts.now() - t0
      // Behind schedule: never chain frames back to back — keep ≥ 40 % of the interval idle so
      // websocket messages and job compute always get the event loop.
      this.schedule(Math.max(this.interval * 0.4, this.interval - spent))
    }, delay)
    this.timer.unref()
  }
}
