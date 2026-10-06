// The LUSCA neuron live dashboard (owner: dashboard).
//
// A full-screen, ~20 fps terminal view of a running desktop neuron, built on the brand's motion
// language: a boot sequence (the logo mark assembles from particles, then each boot step reveals
// with its real measurement), a match-moved transition into the dashboard, and a live layout of
// the point-cloud octopus (pulses on every job, a sonar ripple on every passed full audit, a
// mantle flare when escrow is released) beside four bracket-labelled panels — TRAINING,
// VERIFICATION, CREDITS (odometer digits), NETWORK — and a live feed.
//
// Everything shown comes from NeuronEvents; until a value has arrived it reads "—". Credit totals
// (CREDITS odometer = all-time confirmed, pending in escrow, this session's gain) come only from
// the server's ledger ('account' events); verdict and escrow events only drive the feed.
// Layouts: full (≥ 120×36), compact (≥ 90×26), and a minimal card when the window shrinks below
// that mid-session. Keys: q / Ctrl+C quit (graceful), p pause animation, l raw log view.
//
// Time: `now` is the real monotonic clock (rates, uptime); the animation clock advances by at most
// 100 ms per frame, so a blocking computation (the CPU benchmark) pauses motion instead of
// skipping it.

import { SEPIA } from '../../shared/sepia/index.mjs'
import { ZONES } from '../../shared/protocol.ts'
import { BrailleCanvas } from './canvas.ts'
import { BOLD, Grid, encodeFrame, gridRows, to256 } from './grid.ts'
import { fmtCredits, fmtDur, fmtFlop, fmtG, shortAddr, shortId } from './log.ts'
import { logoMark, logoWidth } from './logo.ts'
import { createOctopus } from './octopus.ts'
import type { Octopus } from './octopus.ts'
import { PAL, mix as mixRgb, ramp as rampAt, setColorLevel } from './theme.ts'
import { FrameLoop, SEQ, Screen } from './term.ts'
import type { ColorLevel, GlyphMode, TermIO } from './term.ts'
import type { NeuronEvent, NeuronUI } from './types.ts'
import {
  C,
  Odometer,
  drawWordmark,
  wordmarkRows,
  wordmarkWidth,
  type Rect,
  Roller,
  bracketLabel,
  clamp01,
  corners,
  easeInOutSine,
  easeOutCubic,
  easeOutExpo,
  ellipsize,
  fadeIn,
  fmtAgo,
  fmtClock,
  fmtInt,
  fontRows,
  gauge,
  hrule,
  lerp,
  mix,
  prog,
  roman,
  sparkline,
  spans,
  spansWidth,
  textRight,
  track,
} from './widgets.ts'

type Ev<T extends NeuronEvent['t']> = Extract<NeuronEvent, { t: T }>
type Span = [string, number, number?]

// ─── state ──────────────────────────────────────────────────────────────────

type JobStatus = 'received' | 'computed' | 'verified' | 'audited' | 'rejected' | 'stale' | 'failed'

interface JobRow {
  id: string
  kind: 'train' | 'sim'
  version?: number
  batch?: number
  flops: number
  ms?: number
  gflops?: number
  loss?: number
  status: JobStatus
  credits?: number
  pending?: boolean
  reason?: string
  arm: number
  changed: number // UI clock of the last status change
}

interface FeedItem {
  at: number // wall ms
  born: number // animation clock
  job?: JobRow
  glyph?: string
  glyphColor?: number
  parts?: Span[]
}

interface LogLine {
  at: number
  glyph: string
  color: number
  text: string
}

type Phase = 'boot' | 'transition' | 'dash'

interface Layout {
  mode: 'full' | 'compact' | 'mini'
  W: number
  H: number
  header: Rect
  logo: { x: number; y: number; h: number } | null // cells / dots
  hero: Rect
  caption: Rect
  train: Rect
  verify: Rect
  credits: Rect
  network: Rect
  feed: Rect
  hints: Rect
  /** vertical data bus in the gutter between the creature and the panels */
  bus: Rect
  /** live compute trace in the masthead (full layout, when there is room) */
  signal: Rect | null
  /** narrow right column: NETWORK folds into the feed header */
  narrow: boolean
}

const FEED_MAX = 160
const LOG_MAX = 600
const TAPE_MAX = 2000
const LOSS_MAX = 240

export function computeLayout(W: number, H: number): Layout {
  const z: Rect = { x: 0, y: 0, w: 0, h: 0 }
  if (W < 90 || H < 26) {
    return { mode: 'mini', W, H, header: z, logo: null, hero: z, caption: z, train: z, verify: z, credits: z, network: z, feed: z, hints: z, bus: z, signal: null, narrow: false }
  }
  const full = W >= 120 && H >= 36
  const mx = 2
  const header: Rect = full ? { x: mx, y: 1, w: W - 2 * mx, h: 4 } : { x: mx, y: 0, w: W - 2 * mx, h: 1 }
  const bodyTop = full ? 7 : 2
  const bodyBot = full ? H - 3 : H - 2 // exclusive
  const hints: Rect = { x: mx, y: full ? H - 2 : H - 1, w: W - 2 * mx, h: 1 }
  const bodyH = bodyBot - bodyTop
  // full: at 120 columns the creature leaves exactly enough room for a 2×2 panel grid
  const heroW = full ? Math.max(47, Math.min(100, Math.round(W * 0.39))) : Math.max(34, Math.min(58, Math.round(W * 0.4)))
  const capH = full ? 3 : 2
  const hero: Rect = { x: mx, y: bodyTop, w: heroW, h: bodyH - capH }
  const caption: Rect = { x: mx, y: bodyTop + bodyH - capH, w: heroW, h: capH }
  const gut = full ? 5 : 3
  const rx = mx + heroW + gut
  const rw = W - mx - rx
  const bus: Rect = { x: mx + heroW + Math.floor(gut / 2), y: bodyTop, w: 1, h: bodyH }
  const narrow = rw < 64
  let hA = full ? (bodyH >= 50 ? 12 : bodyH >= 44 ? 10 : 9) : 7
  let hB = full ? 9 : bodyH >= 24 ? 8 : 7
  const gap = 1
  let feedH = bodyH - hA - hB - 2 * gap
  if (feedH < 5) {
    const need = 5 - feedH
    hA -= Math.ceil(need / 2)
    hB -= Math.floor(need / 2)
    feedH = 5
  }
  const wA = Math.floor((rw - 3) / 2)
  const train: Rect = { x: rx, y: bodyTop, w: wA, h: hA }
  const verify: Rect = { x: rx + wA + 3, y: bodyTop, w: rw - wA - 3, h: hA }
  const wC = narrow ? rw : Math.max(Math.round(rw * 0.56), rw - 3 - 40)
  const credits: Rect = { x: rx, y: bodyTop + hA + gap, w: wC, h: hB }
  const network: Rect = narrow ? z : { x: rx + wC + 3, y: credits.y, w: rw - wC - 3, h: hB }
  const feed: Rect = { x: rx, y: credits.y + hB + gap, w: rw, h: bodyBot - (credits.y + hB + gap) }
  const logo = full ? { x: mx + 1, y: 1, h: 16 } : null
  // masthead trace: between the identity block (≈ 60 cols) and the status block (≈ 42 cols)
  let signal: Rect | null = null
  if (full) {
    const sx = mx + 72
    const sw = W - mx - 46 - sx
    if (sw >= 20) signal = { x: sx, y: 1, w: Math.min(sw, 64), h: 4 }
    if (signal && sw > 64) signal.x = sx + Math.floor((sw - 64) / 2)
  }
  return { mode: full ? 'full' : 'compact', W, H, header, logo, hero, caption, train, verify, credits, network, feed, hints, bus, signal, narrow }
}

// ─── dashboard ──────────────────────────────────────────────────────────────

export interface DashboardOpts {
  term: TermIO
  level: ColorLevel
  ascii: boolean
  /** point-cloud glyphs (default: braille, or ascii when `ascii`) — see term.ts detectGlyphs */
  glyphs?: GlyphMode
  /** monotonic ms (default performance.now) */
  now?: () => number
  /** epoch ms for feed timestamps (default Date.now) */
  wall?: () => number
  /** q / Ctrl+C. Default: run the process's SIGINT handlers (graceful leave), else exit. */
  onQuit?: () => void
  /** Called when rendering throws; the dashboard has already restored the terminal. */
  onCrash?: (err: unknown) => void
  /** Skip the boot sequence. */
  noBoot?: boolean
  /** Drive frames manually with frame(now) (virtual terminals). */
  manual?: boolean
}

export class Dashboard implements NeuronUI {
  private readonly term: TermIO
  private readonly level: ColorLevel
  private readonly ascii: boolean
  private readonly glyphs: GlyphMode
  private readonly now: () => number
  private readonly wall: () => number
  private readonly screen: Screen
  private readonly loop: FrameLoop
  private readonly octo: Octopus
  private readonly heroCanvas: BrailleCanvas
  private readonly fxCanvas: BrailleCanvas
  private readonly logoCanvas: BrailleCanvas
  private fxGrid = new Grid(1, 1)
  private readonly sparkCanvas: BrailleCanvas
  private readonly sparkCanvas2: BrailleCanvas
  private grid: Grid
  private prev: Grid | null = null
  private layout: Layout
  private unsub: (() => void)[] = []

  // clocks
  private readonly t0: number
  private lastNow: number
  private clock = 0 // UI ms: advances every frame (≤ 100 ms per frame)
  private anim = 0 // creature / logo ms: frozen while paused
  private phase: Phase = 'boot'
  private phaseAt = 0 // clock at phase start
  private bootReadyAt = -1
  private introAt = 0
  private paused = false
  private logView = false
  private stopping = false
  private stopped = false
  private broken = false
  private quitPresses = 0
  private forceFull = true

  // data
  private boot: Ev<'boot'> | null = null
  private benchStart = -1
  private bench: Ev<'bench'> | null = null
  private benchDoneAt = -1
  private selftest: Ev<'selftest'> | null = null
  private wallet: Ev<'wallet'> | null = null
  private conn: Ev<'conn'> | null = null
  private registeredAt = -1
  private neuronId: string | null = null
  private zone: string | null = null
  private linked: boolean | null = null
  private network: Ev<'network'> | null = null
  private totals: Ev<'totals'> | null = null // this session's verdict counts
  private account: Ev<'account'> | null = null // the server's ledger totals (null: no reply yet → "—")
  private notices: Ev<'notice'>[] = []
  private trainingOff = false

  private jobs = new Map<string, JobRow>()
  private feed: FeedItem[] = []
  private log: LogLine[] = []
  private tape: { s: JobStatus; born: number }[] = []
  private losses: number[] = []
  private version: number | null = null
  private batch: number | null = null
  private lastKind: 'train' | 'sim' | null = null
  private lastLoss: number | null = null
  private lastMs: number | null = null
  private gflopsNow = new Roller(500)
  private peakGflops = 0
  private computedAt: number[] = [] // real ms
  private busy: { t: number; ms: number }[] = [] // compute time per job (real clock), last 10 s
  private busyR = new Roller(600)
  private computedCount = 0
  private flopsTotal = 0
  private spot = 0
  private audits = 0
  private rejected = 0
  private stale = 0
  private lastAuditWall = -1
  private released = 0
  private forfeited = 0
  private reconnectItem: FeedItem | null = null
  private arm = 0
  private lastArm = -1
  private lastArmAt = -1e9
  private energy = 0
  private load = new Roller(260)
  private packets: { born: number; dir: 1 | -1 }[] = [] // data bus: jobs in (down), results out (up)
  private spikes: { t: number; g: number }[] = [] // masthead trace: one per computed job
  private releaseAt = -1e9
  private maxPending = 0

  // animated numbers
  private odo = new Odometer(2)
  private pendingR = new Roller(320)
  private confirmedR = new Roller(320)
  private rateR = new Roller(800)

  constructor(private readonly opts: DashboardOpts) {
    this.term = opts.term
    this.level = opts.level
    this.ascii = opts.ascii
    this.glyphs = opts.ascii ? 'ascii' : (opts.glyphs ?? 'braille')
    this.now = opts.now ?? (() => performance.now())
    this.wall = opts.wall ?? (() => Date.now())
    this.t0 = this.now()
    this.lastNow = this.t0
    setColorLevel(this.level === 'none' ? 'none' : 'truecolor') // canvases emit truecolor; we downsample
    this.screen = new Screen(this.term)
    this.grid = new Grid(this.term.cols(), this.term.rows())
    this.layout = computeLayout(this.grid.w, this.grid.h)
    this.octo = createOctopus()
    const gm = { glyphs: this.glyphs }
    this.heroCanvas = new BrailleCanvas(1, 1, gm)
    this.fxCanvas = new BrailleCanvas(1, 1, gm)
    this.logoCanvas = new BrailleCanvas(1, 1, gm)
    this.sparkCanvas = new BrailleCanvas(1, 1, gm)
    this.sparkCanvas2 = new BrailleCanvas(1, 1, gm)
    if (opts.noBoot) this.enterDash(0, true)
    this.loop = new FrameLoop({
      fps: 20,
      now: this.now,
      render: (t) => this.frame(t),
      canWrite: () => this.term.backlog() < 512 * 1024,
    })
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    this.screen.enter()
    this.unsub.push(
      this.term.onResize(() => {
        this.forceFull = true
        if (!this.opts.manual) this.loop.step()
      }),
      this.term.onKey((k) => this.key(k)),
    )
    if (!this.opts.manual) this.loop.start()
  }

  emit(e: NeuronEvent): void {
    if (this.broken) throw new Error('dashboard renderer failed')
    if (this.stopped) return
    this.reduce(e)
    // A frame right away while booting, so a step shows before a blocking computation starts.
    if (this.phase === 'boot' && !this.opts.manual && (e.t === 'bench' || e.t === 'selftest' || e.t === 'boot')) this.loop.step()
  }

  async stop(summary?: string): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.loop.stop()
    for (const u of this.unsub.splice(0)) u()
    if (this.screen.active) {
      try {
        if (!this.broken) {
          this.stopping = true
          this.frame(this.now())
        }
      } catch {
        /* restoring matters more than a last frame */
      }
      this.screen.leave()
    }
    const card = this.summaryCard(summary)
    if (!card) return
    if (this.term.virtual) {
      this.term.write(card)
      return
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1000).unref()
      try {
        process.stdout.write(card, () => resolve())
      } catch {
        resolve()
      }
    })
  }

  /** Render one frame at `now` (the loop calls this; manual drivers call it directly). */
  frame(now: number): void {
    if (this.broken || (this.stopped && !this.stopping)) return
    try {
      this.render(now)
    } catch (err) {
      this.broken = true
      this.loop.stop()
      try {
        this.screen.leave()
      } catch {
        /* ignore */
      }
      this.opts.onCrash?.(err)
    }
  }

  /** The current composed screen, one ANSI string per row (QA snapshots). */
  snapshot(level: ColorLevel = 'truecolor'): string[] {
    return gridRows(this.grid, level)
  }

  get frameCost(): number {
    return this.loop.cost
  }

  // ── input ────────────────────────────────────────────────────────────────

  private key(k: string): void {
    if (k === '\x03' || k === 'q' || k === 'Q') {
      this.quitPresses++
      if (this.quitPresses >= 2) {
        // second request: leave now
        this.screen.leave(true)
        process.exit(130)
      }
      this.stopping = true
      if (this.opts.onQuit) this.opts.onQuit()
      else if (process.listenerCount('SIGINT') > 0) process.emit('SIGINT', 'SIGINT')
      else {
        this.screen.leave(true)
        process.exit(130)
      }
      return
    }
    // terminal reports (focus in/out, cursor position, device attributes, mode reports, OSC/DCS
    // replies) arrive on stdin too: they are not keypresses
    if (/^\x1b(\[(I|O|\??[\d;]*[Rcn]|\?[\d;]*\$y)$|[\]P])/.test(k)) return
    if (this.phase === 'boot') {
      this.skipBoot()
      return
    }
    if (k === 'p' || k === 'P') {
      this.paused = !this.paused
      this.loop.setFps(this.paused ? 4 : 20)
    } else if (k === 'l' || k === 'L') {
      this.logView = !this.logView
      this.forceFull = true
    } else if (k === '\x1b' && this.logView) {
      this.logView = false
      this.forceFull = true
    }
    if (this.opts.manual) return
    this.loop.step()
  }

  /** Any key during the boot sequence. */
  skipBoot(): void {
    if (this.phase !== 'boot') return
    this.phase = 'transition'
    this.phaseAt = this.clock
    this.introAt = this.clock + TRANSITION_MS * 0.45
    this.odo.spinUp()
  }

  // ── events → state ───────────────────────────────────────────────────────

  private pushFeed(item: Omit<FeedItem, 'at' | 'born'>): void {
    this.feed.unshift({ ...item, at: this.wall(), born: this.clock })
    if (this.feed.length > FEED_MAX) this.feed.length = FEED_MAX
  }

  private pushLog(glyph: string, color: number, text: string): void {
    this.log.push({ at: this.wall(), glyph, color, text })
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX)
  }

  private reduce(e: NeuronEvent): void {
    const nowReal = this.now()
    switch (e.t) {
      case 'boot':
        this.boot = e
        this.pushLog('■', C.hot, `LUSCA desktop neuron · build ${e.build} · ${e.cpu} · ${e.threads} threads · ${e.os}`)
        return
      case 'bench':
        if (e.phase === 'start') {
          this.benchStart = this.clock
          this.pushLog('·', C.bone32, 'benchmark: timing a 256×256 fp32 matmul')
        } else {
          this.bench = e
          this.benchDoneAt = this.clock
          if (e.zone) this.zone = this.zone ?? e.zone
          if (e.gflops !== undefined) this.pushLog('■', C.bone, `benchmark ${fmtG(e.gflops)} GFLOPS${e.zone ? ` → ${e.zone}` : ''}${e.bonus !== undefined ? ` · credit bonus ×${e.bonus.toFixed(2)}` : ''}`)
        }
        return
      case 'selftest':
        this.selftest = e
        this.pushLog('■', C.bone, `self-test: SEPIA gradient B=${e.batch} in ${e.ms.toFixed(0)} ms · ${fmtG(e.gflops)} GFLOPS · f16 codec cos ${e.codecCos.toFixed(5)}`)
        return
      case 'wallet':
        this.wallet = e
        if (e.state === 'verified') {
          this.pushFeed({ glyph: this.g('✓'), glyphColor: C.hot, parts: [['WALLET VERIFIED', C.bone, BOLD], ['  ', 0], [e.address ? shortAddr(e.address) : '', C.bone62], [e.until ? `  ·  SIGN-IN VALID UNTIL ${new Date(e.until).toISOString().slice(0, 10)}` : '', C.bone32]] })
          this.pushLog('✓', C.hot, `wallet verified ${e.address ?? ''}`)
        } else if (e.state === 'failed') {
          this.pushFeed({ glyph: this.g('×'), glyphColor: C.hot, parts: [['WALLET SIGN-IN FAILED', C.hot, BOLD], [e.reason ? `  ${e.reason}` : '', C.bone62]] })
          this.pushLog('×', C.hot, `wallet sign-in failed${e.reason ? `: ${e.reason}` : ''}`)
        } else if (e.state === 'signing') {
          this.pushLog('·', C.bone32, `wallet ${e.address ?? ''} · signing in (plain-text message, no transaction)`)
        } else if (e.state === 'none') {
          this.pushLog('·', C.bone32, 'credits to this device (no wallet linked)')
        } else {
          this.pushLog('·', C.bone32, 'sign-in token given · pending server check')
        }
        return
      case 'conn': {
        const prevState = this.conn?.state
        this.conn = e
        if (e.neuronId) this.neuronId = e.neuronId
        if (e.zone) this.zone = e.zone
        if (e.linked !== undefined) this.linked = e.linked
        if (e.state === 'registered') {
          if (this.registeredAt < 0 || prevState !== 'registered') {
            this.registeredAt = this.clock
            // the creature's own entrance covers the first registration
            if (this.phase === 'dash') this.octo.ripple(1)
          }
          this.pushFeed({
            glyph: this.g('■'),
            glyphColor: C.bone,
            parts: [['REGISTERED', C.bone, BOLD], ['  NEURON ', C.bone32], [e.neuronId ? shortId(e.neuronId) : '—', C.bone62], [e.zone ? `  ·  ${e.zone}` : '', C.hot], [e.gflops !== undefined ? `  ·  ${fmtG(e.gflops)} GFLOPS` : '', C.bone62], [e.linked === true ? '  ·  CREDITS TO VERIFIED WALLET' : e.linked === false ? '  ·  CREDITS TO THIS DEVICE' : '', C.bone32]],
          })
          this.pushLog('■', C.bone, `registered neuron ${e.neuronId ? shortId(e.neuronId) : '—'}${e.zone ? ` · ${e.zone}` : ''}${e.gflops !== undefined ? ` · ${fmtG(e.gflops)} GFLOPS` : ''}`)
        } else if (e.state === 'connecting') {
          this.pushFeed({ glyph: this.g('◇'), glyphColor: C.bone32, parts: [['CONNECTING', C.bone62, BOLD], ['  ', 0], [e.server, C.bone32]] })
          this.pushLog('·', C.bone32, `connecting to ${e.server}`)
        } else if (e.state === 'connected') {
          this.pushFeed({ glyph: this.g('▸'), glyphColor: C.bone62, parts: [['CONNECTED', C.bone, BOLD], ['  ·  REGISTERING', C.bone32]] })
          this.pushLog('■', C.bone, 'connected · registering')
        } else if (e.state === 'reconnecting') {
          this.pushFeed({ glyph: this.g('▲'), glyphColor: C.hot, parts: [['CONNECTION LOST', C.hot, BOLD], ['  ·  RECONNECTING', C.bone62]] })
          this.reconnectItem = this.feed[0]
          this.pushLog('▲', C.hot, 'connection lost — reconnecting')
        } else {
          this.pushLog('·', C.bone32, 'connection closed')
        }
        return
      }
      case 'network':
        this.network = e
        return
      case 'job': {
        const arm = this.arm++ % 8
        const row: JobRow = { id: e.id, kind: e.kind, version: e.version, batch: e.batch, flops: e.flops, status: 'received', arm, changed: this.clock }
        this.jobs.set(e.id, row)
        if (this.jobs.size > 400) this.jobs.delete(this.jobs.keys().next().value as string)
        if (e.version !== undefined) this.version = e.version
        if (e.batch !== undefined) this.batch = e.batch
        this.lastKind = e.kind
        this.octo.pulse(arm)
        this.lastArm = arm
        this.lastArmAt = this.clock
        this.pushFeed({ job: row })
        this.packets.push({ born: this.clock, dir: 1 })
        return
      }
      case 'computed': {
        const row = this.jobs.get(e.id)
        if (row) {
          row.status = 'computed'
          row.changed = this.clock
          row.ms = e.ms
          row.gflops = e.gflops
          row.loss = e.loss
        }
        this.lastKind = e.kind
        this.lastMs = e.ms
        if (e.loss !== undefined && Number.isFinite(e.loss)) {
          this.lastLoss = e.loss
          this.losses.push(e.loss)
          if (this.losses.length > LOSS_MAX) this.losses.splice(0, this.losses.length - LOSS_MAX)
        }
        if (Number.isFinite(e.gflops) && e.gflops > 0) {
          this.gflopsNow.set(e.gflops)
          this.peakGflops = Math.max(this.peakGflops, e.gflops)
        }
        this.computedAt.push(nowReal)
        if (Number.isFinite(e.ms) && e.ms >= 0) this.busy.push({ t: nowReal, ms: e.ms })
        while (this.computedAt.length && nowReal - this.computedAt[0] > 60_000) this.computedAt.shift()
        this.computedCount++
        this.packets.push({ born: this.clock, dir: -1 })
        if (this.packets.length > 64) this.packets.splice(0, this.packets.length - 64)
        this.spikes.push({ t: this.clock, g: Number.isFinite(e.gflops) ? e.gflops : 0 })
        if (this.spikes.length > 600) this.spikes.splice(0, this.spikes.length - 600)
        this.flopsTotal += row && row.flops > 0 ? row.flops : e.gflops * e.ms * 1e6
        this.energy = Math.min(1, this.energy + 0.34)
        this.pushLog('▸', C.bone62, `${e.kind === 'train' ? 'train' : 'dedupe'} ${shortId(e.id)}${row?.version !== undefined ? ` · SEPIA v${row.version}` : ''}${row?.batch ? ` · B=${row.batch}` : ''}${e.loss !== undefined ? ` · loss ${e.loss.toFixed(4)}` : ''} · ${e.ms.toFixed(0)} ms · ${fmtG(e.gflops)} GFLOPS`)
        return
      }
      case 'verdict': {
        const row = this.jobs.get(e.id)
        if (row) {
          row.status = e.status
          row.changed = this.clock
          row.credits = e.credits
          row.pending = e.pending
          row.reason = e.reason
        }
        this.tape.push({ s: e.status, born: this.clock })
        if (this.tape.length > TAPE_MAX) this.tape.splice(0, this.tape.length - TAPE_MAX)
        if (e.status === 'verified') this.spot++
        else if (e.status === 'audited') {
          this.audits++
          this.lastAuditWall = this.wall()
          this.octo.ripple(1)
        } else if (e.status === 'stale') this.stale++
        else this.rejected++
        if (!row) {
          // a verdict for a job we did not see issued (e.g. after a reconnect): give it a row
          this.pushFeed({ job: { id: e.id, kind: e.kind, flops: 0, status: e.status, credits: e.credits, pending: e.pending, reason: e.reason, arm: -1, changed: this.clock } })
        }
        const word = e.status === 'audited' ? 'audit passed' : e.status
        this.pushLog(
          this.verdictGlyph(e.status),
          this.verdictColor(e.status),
          `${word} ${shortId(e.id)}${e.credits > 0 ? ` · +${fmtCredits(e.credits)} credits ${e.pending ? 'pending' : 'confirmed'}` : ''}${e.reason ? ` · ${e.reason}` : ''}`,
        )
        return
      }
      case 'escrow':
        if (e.released > 0) {
          this.released += e.released
          this.releaseAt = this.clock
          this.octo.flash()
          this.octo.ripple(0.7)
          this.pushFeed({ glyph: this.g('✓'), glyphColor: C.hot, parts: [['ESCROW RELEASED', C.bone, BOLD], [`  +${fmtCredits(e.released)}`, C.hot, BOLD], ['  →  CONFIRMED', C.bone62]] })
          this.pushLog('✓', C.hot, `escrow released · ${fmtCredits(e.released)} pending credits confirmed`)
        }
        if (e.forfeited && e.forfeited > 0) {
          this.forfeited += e.forfeited
          this.pushFeed({ glyph: this.g('×'), glyphColor: C.hot, parts: [['ESCROW FORFEITED', C.hot, BOLD], [`  ${fmtCredits(e.forfeited)}`, C.bone], ['  LOST · A FULL AUDIT FAILED', C.bone62]] })
          this.pushLog('×', C.hot, `escrow forfeited · ${fmtCredits(e.forfeited)} pending credits lost`)
        }
        return
      case 'totals':
        this.totals = e
        return
      case 'account':
        this.account = e
        this.odo.set(e.confirmed)
        this.pendingR.set(e.pending)
        this.confirmedR.set(e.confirmed)
        this.maxPending = Math.max(this.maxPending, e.pending)
        return
      case 'notice': {
        this.notices.push(e)
        if (this.notices.length > 20) this.notices.shift()
        if (/training off/i.test(e.msg)) this.trainingOff = true
        const glyph = e.level === 'error' ? '×' : e.level === 'warn' ? '▲' : '·'
        const col = e.level === 'info' ? C.bone32 : C.hot
        // the reason for a reconnect follows its conn event: fold it into that feed row
        const lost = /^(connection lost|disconnected)\s*/i.exec(e.msg)
        const rc = this.reconnectItem
        this.reconnectItem = null
        if (lost && rc && this.feed[0] === rc) {
          const rest = e.msg.slice(lost[0].length).replace(/^—\s*/, '').toUpperCase()
          rc.parts = [[lost[1].toUpperCase(), C.hot, BOLD], [rest ? `  ·  ${rest}` : '  ·  RECONNECTING', C.bone62]]
          this.pushLog(glyph, col, e.msg)
          return
        }
        this.pushFeed({ glyph: this.g(glyph), glyphColor: col, parts: [[e.msg, e.level === 'info' ? C.bone62 : C.bone]] })
        this.pushLog(glyph, col, e.msg)
        return
      }
    }
  }

  // ── glyph helpers ────────────────────────────────────────────────────────

  private g(ch: string): string {
    if (!this.ascii) return ch
    const map: Record<string, string> = { '◇': 'o', '▸': '>', '■': '#', '◆': '*', '✓': '+', '×': 'x', '▲': '!', '○': '.', '●': '*', '▪': '#', '·': '.' }
    return map[ch] ?? ch
  }

  private verdictGlyph(s: JobStatus): string {
    switch (s) {
      case 'received':
        return '◇'
      case 'computed':
        return '▸'
      case 'verified':
        return '■'
      case 'audited':
        return '◆'
      case 'stale':
        return '○'
      default:
        return '×'
    }
  }

  private verdictColor(s: JobStatus): number {
    switch (s) {
      case 'received':
        return C.bone32
      case 'computed':
        return C.bone62
      case 'verified':
        return C.bone
      case 'audited':
        return C.hot
      case 'stale':
        return C.bone32
      default:
        return C.hot
    }
  }

  // ── frame ────────────────────────────────────────────────────────────────

  private enterDash(at: number, fresh = false): void {
    this.phase = 'dash'
    this.phaseAt = at
    if (fresh) {
      this.introAt = at
      this.odo.spinUp()
    }
  }

  private render(now: number): void {
    const dtReal = Math.max(0, now - this.lastNow)
    this.lastNow = now
    const dt = Math.min(100, dtReal)
    this.clock += dt
    if (!this.paused) this.anim += dt

    // size
    const W = this.term.cols()
    const H = this.term.rows()
    if (W !== this.grid.w || H !== this.grid.h) {
      this.grid.resize(W, H)
      this.forceFull = true
    }
    if (this.forceFull) {
      this.layout = computeLayout(W, H)
      this.prev = null
    }

    // eased values (they keep easing while paused: data still updates)
    const dtv = Math.min(dtReal, 250)
    this.odo.update(dtv)
    this.pendingR.update(dtv)
    this.confirmedR.update(dtv)
    this.gflopsNow.update(dtv)
    this.energy *= Math.exp(-dtv / 1400)
    this.load.set(this.energy)
    this.load.update(dtv)
    // busy share of the compute thread over the last 10 s (sum of gradient times / elapsed)
    while (this.busy.length && now - this.busy[0].t > BUSY_WINDOW) this.busy.shift()
    if (this.busy.length) {
      const span = Math.min(BUSY_WINDOW, Math.max(1000, now - this.t0))
      let ms = 0
      for (const b of this.busy) ms += b.ms
      this.busyR.set(clamp01(ms / span))
    } else if (this.busyR.has) this.busyR.set(0)
    this.busyR.update(dtv)
    const rate = this.jobsPerMin(now)
    if (rate !== null) this.rateR.set(rate)
    this.rateR.update(dtv)

    // phase machine
    if (this.phase === 'boot') this.bootTick()
    if (this.phase === 'transition' && this.clock - this.phaseAt >= TRANSITION_MS) this.enterDash(this.clock)

    const g = this.grid
    g.clear()
    if (this.logView && this.phase === 'dash') this.drawLogView()
    else if (this.layout.mode === 'mini') this.drawMini()
    else if (this.phase === 'boot') this.drawBoot(0)
    else if (this.phase === 'transition') this.drawTransition()
    else this.drawDash()

    g.dropDark()
    const out = encodeFrame(this.prev, g, this.level)
    this.forceFull = false
    if (!this.prev || this.prev.w !== g.w || this.prev.h !== g.h) this.prev = new Grid(g.w, g.h)
    this.prev.copyFrom(g)
    if (out.length > 0) this.term.write(SEQ.syncOn + out + SEQ.syncOff)
  }

  private jobsPerMin(now: number): number | null {
    const n = this.computedAt.length
    if (n < 3) return null
    // intervals per elapsed time since the oldest event in the 60 s window (decays when idle)
    return ((n - 1) / Math.max(1, now - this.computedAt[0])) * 60_000
  }

  // ── boot ─────────────────────────────────────────────────────────────────

  private bootTick(): void {
    const t = this.clock
    const ready = this.conn?.state === 'registered' && this.selftestOrSkipped() && t > BOOT_LINES_AT + 5 * BOOT_STAGGER + 400
    if (ready && this.bootReadyAt < 0) this.bootReadyAt = t
    if (this.bootReadyAt >= 0 && t - this.bootReadyAt > 550) this.skipBoot()
    // the connection is taking long: show the dashboard (it shows the connection state too)
    if (t > 8000 && this.conn) this.skipBoot()
  }

  private selftestOrSkipped(): boolean {
    return !!this.selftest || this.trainingOff
  }

  /** Boot screen layout: the brand lockup (mark + LUSCA. wordmark, as on the film's end card),
   *  the sub line, five step lines and the hint, centred as one block. */
  private bootGeometry(): { scale: 1 | 2; top: number; logoX: number; logoY: number; logoH: number; wordX: number; wordY: number; subY: number; linesY: number; hintY: number; lineX: number; lineW: number } {
    const { W, H } = this.layout
    const scale: 1 | 2 = W >= 112 && H >= 28 ? 2 : 1
    const wordRows = wordmarkRows(scale)
    const logoH = wordRows * 4 // dots: the mark stands as tall as the wordmark
    const logoCols = Math.ceil(logoWidth(logoH) / 2)
    const gap = scale === 2 ? 5 : 3
    const blockW = logoCols + gap + wordmarkWidth(scale)
    const total = wordRows + 2 + 1 + 2 + 5 + 2 + 1
    const top = Math.max(1, Math.floor((H - total) / 2))
    const bx = Math.floor((W - blockW) / 2)
    const lineW = Math.min(W - 8, 104)
    return {
      scale,
      top,
      logoX: bx * 2,
      logoY: top * 4,
      logoH,
      wordX: bx + logoCols + gap,
      wordY: top,
      subY: top + wordRows + 2,
      linesY: top + wordRows + 5,
      hintY: top + wordRows + 12,
      lineX: Math.floor((W - lineW) / 2),
      lineW,
    }
  }

  /** The boot screen; `out` (0..1) fades it toward the ground for the transition. */
  private drawBoot(out: number, drawLogo = true): void {
    const g = this.grid
    const { W, H } = this.layout
    const t = this.clock
    const geo = this.bootGeometry()
    const fadeK = 1 - out

    // screen corner ticks + chrome
    corners(g, { x: 0, y: 0, w: W, h: H }, fadeIn(C.bone24, fadeK * prog(t, 0, 600)), 2)
    const chromeA = fadeK * prog(t, 200, 600)
    g.text(3, 1, '[ 00 ]', fadeIn(C.bone32, chromeA))
    g.text(10, 1, track('BOOT'), fadeIn(C.bone62, chromeA))
    textRight(g, W - 3, 1, 'L U S C A', fadeIn(C.bone62, chromeA), BOLD)

    // the mark assembles from particles
    const lp = easeOutCubic(prog(t, 0, LOGO_MS))
    if (drawLogo) {
      this.fx()
      logoMark(this.fxCanvas, geo.logoX, geo.logoY, geo.logoH, lp, this.anim)
      this.blitFx(fadeK)
    }

    // wordmark: each glyph wipes in from the left, warm first, settling to bone; the stop stays orange
    const w0 = LOGO_MS * 0.18
    drawWordmark(
      g,
      geo.wordX,
      geo.wordY,
      geo.scale,
      (i) => easeOutCubic(prog(t, w0 + i * 90, 300)),
      (i) => {
        if (i === 5) return fadeIn(C.hot, fadeK)
        const k = prog(t, w0 + i * 90 + 200, 600)
        return fadeIn(mix(C.hot, C.bone, k), fadeK)
      },
    )
    const sub = this.boot ? `D E S K T O P   N E U R O N   ·   B U I L D   ${this.boot.build}` : 'D E S K T O P   N E U R O N'
    const sa = prog(t, LOGO_MS * 0.8, 400) * fadeK
    if (sa > 0) g.text(Math.floor((W - [...sub].length) / 2), geo.subY, sub, fadeIn(C.bone32, sa))

    // step lines
    const lines = this.bootLines()
    for (let i = 0; i < lines.length; i++) {
      const at = BOOT_LINES_AT + i * BOOT_STAGGER
      const a = prog(t, at, 260) * fadeK
      if (a <= 0) continue
      this.drawBootLine(geo.lineX, geo.linesY + i, geo.lineW, i, lines[i], t - at, a)
    }

    // hint
    const ha = prog(t, BOOT_LINES_AT + 5 * BOOT_STAGGER, 600) * fadeK
    if (ha > 0) {
      const hint = this.term.virtual || process.stdin.isTTY ? 'P R E S S   A N Y   K E Y   T O   S K I P' : ''
      g.text(Math.floor((W - hint.length) / 2), Math.min(H - 2, geo.hintY), hint, fadeIn(C.bone24, ha))
    }
  }

  private bootLines(): { label: string; state: 'wait' | 'run' | 'done' | 'warn' | 'fail'; value: Span[]; bar?: number; doneAt?: number }[] {
    const b = this.boot
    const out: ReturnType<Dashboard['bootLines']> = []
    // 01 CPU
    out.push({ label: 'CPU', state: b ? 'done' : 'wait', value: b ? [[b.cpu, C.bone], [`  ·  ${b.threads} THREADS`, C.bone32], [`  ·  ${b.os}`, C.bone62]] : [] })
    // 02 BENCHMARK
    if (this.bench && this.bench.gflops !== undefined) {
      const z = ZONES.find((x) => x.zone === this.bench!.zone)
      const k = easeOutExpo(prog(this.clock, this.benchDoneAt, 900))
      out.push({
        label: 'BENCHMARK',
        state: 'done',
        bar: k,
        doneAt: this.benchDoneAt,
        value: [
          [fmtG(this.bench.gflops * k), C.bone, BOLD],
          [' GFLOPS', C.bone62],
          [this.bench.zone ? `  →  ${this.bench.zone}` : '', C.hot, BOLD],
          [z ? `  ${z.name.toUpperCase()}` : '', C.bone62],
          [this.bench.bonus !== undefined ? `  ×${this.bench.bonus.toFixed(2)}` : '', C.bone32],
        ],
      })
    } else {
      out.push({ label: 'BENCHMARK', state: this.benchStart >= 0 ? 'run' : 'wait', bar: -1, value: [['256×256 FP32 MATMUL  ·  1 THREAD', C.bone32]] })
    }
    // 03 SELF-TEST
    if (this.selftest) {
      const s = this.selftest
      out.push({ label: 'SELF-TEST', state: 'done', value: [[`SEPIA GRADIENT B=${s.batch}`, C.bone], [`  ·  ${s.ms.toFixed(0)} MS`, C.bone62], [`  ·  ${fmtG(s.gflops)} GFLOPS`, C.bone62], [`  ·  CODEC COS ${s.codecCos.toFixed(5)}`, C.bone32]] })
    } else if (this.trainingOff) {
      out.push({ label: 'SELF-TEST', state: 'done', value: [['TRAINING OFF  ·  DEDUPE JOBS ONLY', C.bone62]] })
    } else {
      out.push({ label: 'SELF-TEST', state: this.bench ? 'run' : 'wait', value: [[`SEPIA ${fmtInt(SEPIA.params)} PARAMS`, C.bone32]] })
    }
    // 04 WALLET
    const w = this.wallet
    if (!w) out.push({ label: 'WALLET', state: this.selftest ? 'run' : 'wait', value: [] })
    else if (w.state === 'verified') out.push({ label: 'WALLET', state: 'done', value: [['VERIFIED  ', C.bone, BOLD], [w.address ?? '', C.bone62], [w.until ? `  ·  UNTIL ${new Date(w.until).toISOString().slice(0, 10)}` : '', C.bone32]] })
    else if (w.state === 'token') out.push({ label: 'WALLET', state: 'done', value: [['SIGN-IN TOKEN', C.bone, BOLD], ['  ·  CHECKED BY THE SERVER ON REGISTER', C.bone32]] })
    else if (w.state === 'signing') out.push({ label: 'WALLET', state: 'run', value: [[w.address ?? '', C.bone62], ['  ·  SIGNING IN', C.bone32]] })
    else if (w.state === 'failed') out.push({ label: 'WALLET', state: 'fail', value: [['SIGN-IN FAILED', C.hot, BOLD], [w.reason ? `  ·  ${w.reason}` : '', C.bone62]] })
    else out.push({ label: 'WALLET', state: 'warn', value: [['NOT LINKED', C.bone, BOLD], ['  ·  run with --auth to receive SOL', C.bone62]] })
    // 05 NETWORK
    const c = this.conn
    const server = c?.server ?? b?.server ?? ''
    if (!c) out.push({ label: 'NETWORK', state: 'wait', value: server ? [[server, C.bone32]] : [] })
    else if (c.state === 'registered') out.push({ label: 'NETWORK', state: 'done', value: [['LIVE', C.hot, BOLD], [`  ·  ${server}`, C.bone62], [c.neuronId ? `  ·  NEURON ${shortId(c.neuronId)}` : '', C.bone32]] })
    else if (c.state === 'reconnecting' || c.state === 'closed') out.push({ label: 'NETWORK', state: 'warn', value: [['RECONNECTING', C.hot, BOLD], [`  ·  ${server}`, C.bone62]] })
    else out.push({ label: 'NETWORK', state: 'run', value: [[c.state === 'connected' ? 'REGISTERING' : 'CONNECTING', C.bone, BOLD], [`  ·  ${server}`, C.bone62]] })
    return out
  }

  private drawBootLine(x: number, y: number, w: number, i: number, l: ReturnType<Dashboard['bootLines']>[number], age: number, a: number): void {
    const g = this.grid
    const t = this.clock
    // status mark
    const mark = l.state === 'done' ? '■' : l.state === 'warn' ? '▲' : l.state === 'fail' ? '×' : '◇'
    const mc = l.state === 'done' ? C.bone : l.state === 'warn' || l.state === 'fail' ? C.hot : l.state === 'run' ? mix(C.bone32, C.bone, 0.5 + 0.5 * Math.sin(t / 180)) : C.bone24
    g.put(x, y, this.g(mark), fadeIn(mc, a))
    // bracket + label, typed on
    const num = `[ 0${i + 1} ]`
    g.text(x + 2, y, num, fadeIn(C.bone32, a))
    const label = track(l.label)
    const n = Math.round(label.length * prog(age, 0, 220))
    g.text(x + 9, y, label.slice(0, n), fadeIn(C.bone62, a), BOLD)
    const vx = x + 9 + 20
    const vw = w - (vx - x)
    // benchmark bar
    let cx = vx
    if (l.bar !== undefined) {
      const bw = Math.min(28, Math.max(12, Math.floor(vw * 0.32)))
      if (l.bar < 0) {
        // measuring: a soft highlight sweeps along the hairline
        if (l.state === 'run') {
          const pos = ((t / 900) % 1) * (bw + 8) - 4
          for (let k = 0; k < bw; k++) {
            const d = Math.abs(k - pos)
            const glow = Math.max(0, 1 - d / 4)
            g.put(cx + k, y, this.ascii ? '-' : '─', fadeIn(mix(C.bone16, C.hot, glow), a))
          }
        } else {
          hrule(g, cx, y, bw, fadeIn(C.bone16, a), this.ascii ? '-' : '─')
        }
      } else {
        gauge(g, cx, y, bw, l.bar, fadeIn(C.hot, a), fadeIn(C.bone16, a), this.ascii)
      }
      cx += bw + 2
    }
    if (l.state === 'wait' && l.value.length === 0) {
      g.text(cx, y, '—', fadeIn(C.bone24, a))
      return
    }
    if (l.state === 'run' && l.value.length === 0) {
      const dots = '·'.repeat(1 + (Math.floor(t / 300) % 3))
      g.text(cx, y, dots, fadeIn(C.bone32, a))
      return
    }
    // value: whole groups that fit (the first is cut if it must), revealed left to right
    const room = x + w - cx
    const fit: Span[] = []
    let used = 0
    for (const sp of l.value) {
      const n = [...sp[0]].length
      if (used + n <= room) {
        fit.push(sp)
        used += n
      } else {
        if (fit.length === 0) fit.push([cutEnd(sp[0], room), sp[1], sp[2]])
        break
      }
    }
    const vAge = l.doneAt !== undefined ? t - l.doneAt : age - 120
    const shown = Math.round(spansWidth(fit) * easeOutCubic(prog(vAge, 0, 420)))
    let left = shown
    for (const [s, c, at] of fit) {
      if (left <= 0) break
      const part = [...s].slice(0, left).join('')
      left -= [...s].length
      cx = g.text(cx, y, part, fadeIn(c, a), at ?? 0, x + w - cx)
    }
  }

  // ── transition: boot → dashboard (the logo match-moves into the masthead) ──

  private drawTransition(): void {
    const k = clamp01((this.clock - this.phaseAt) / TRANSITION_MS)
    const e = easeInOutSine(k)
    // boot content fades out in the first half; the dashboard intro starts at 40 %
    this.drawBoot(clamp01(k * 2.6), false)
    if (k > 0.42) this.drawDashInto(1, false)
    // the logo travels
    const geo = this.bootGeometry()
    const fromH = geo.logoH
    const from = { x: geo.logoX, y: geo.logoY }
    const tgt = this.layout.logo
    const toH = tgt ? tgt.h : 16
    const to = tgt ? { x: tgt.x * 2, y: tgt.y * 4 } : { x: 4, y: 0 }
    const h = Math.round(lerp(fromH, toH, e))
    this.fx()
    logoMark(this.fxCanvas, lerp(from.x, to.x, e), lerp(from.y, to.y, e), h, 1, this.anim)
    this.blitFx(tgt ? 1 : 1 - e)
  }

  // ── dashboard ────────────────────────────────────────────────────────────

  private drawDash(): void {
    this.drawDashInto(1, true)
  }

  /** The dashboard; `a` (0..1) scales every fade; `logo` draws the masthead mark. */
  private drawDashInto(a: number, logo: boolean): void {
    const L = this.layout
    const t = this.clock
    const it = (delay: number, dur = 500) => a * prog(t, this.introAt + delay, dur)
    this.drawChrome(it(0, 600), logo)
    this.drawHero(it(80, 1700))
    this.drawBus(it(200, 900))
    this.drawTraining(L.train, it(160), it(260, 600))
    this.drawVerification(L.verify, it(240), it(340, 600))
    this.drawCredits(L.credits, it(320), it(420, 600))
    if (!L.narrow) this.drawNetwork(L.network, it(400), it(500, 600))
    this.drawFeed(L.feed, it(480), it(580, 600))
    this.drawHints(it(640, 600))
  }

  private statusSpans(): Span[] {
    if (this.stopping) return [[this.g('■'), C.bone32], [' LEAVING POOL', C.bone62, BOLD]]
    const c = this.conn
    const pausedTail: Span[] = this.paused ? [['  ·  PAUSED', C.bone32]] : []
    if (!c || c.state === 'connecting') return [[this.g('○'), C.bone32], [' CONNECTING', C.bone62, BOLD], ...pausedTail]
    if (c.state === 'connected') return [[this.g('○'), C.bone62], [' REGISTERING', C.bone62, BOLD], ...pausedTail]
    if (c.state === 'registered') {
      const breath = 0.5 + 0.5 * Math.sin((this.anim / 1000) * Math.PI * 1.1)
      return [[this.g('●'), mix(C.hot62, C.hot, breath)], [' LIVE', C.bone, BOLD], ...pausedTail]
    }
    if (c.state === 'reconnecting') return [[this.g('▲'), C.hot], [' RECONNECTING', C.hot, BOLD], ...pausedTail]
    return [[this.g('■'), C.bone32], [' OFFLINE', C.bone62, BOLD], ...pausedTail]
  }

  private walletSpans(short = false): Span[] {
    const w = this.wallet
    const addr = w?.address ?? null
    if (this.linked === true || w?.state === 'verified') return [[this.g('✓'), C.hot], [' VERIFIED', C.bone, BOLD], [addr && !short ? `  ${shortAddr(addr)}` : '', C.bone62]]
    if (w?.state === 'failed') return [[this.g('×'), C.hot], [' SIGN-IN FAILED', C.hot, BOLD]]
    if (w?.state === 'signing') return [['SIGNING IN', C.bone62, BOLD], [addr && !short ? `  ${shortAddr(addr)}` : '', C.bone32]]
    if (w?.state === 'token' && this.linked === null) return [['TOKEN', C.bone62, BOLD], [short ? '' : '  PENDING SERVER CHECK', C.bone32]]
    if (!w && this.linked === null) return [['—', C.bone32]]
    return [['NOT LINKED', C.bone, BOLD], [short ? '' : '  run with --auth to receive SOL', C.bone32]]
  }

  private uptime(): string {
    return fmtDur(this.lastNow - this.t0)
  }

  private fadeSpans(sp: Span[], a: number): Span[] {
    return sp.map(([s, c, at]) => [s, fadeIn(c, a), at] as Span)
  }

  private drawChrome(a: number, drawLogo: boolean): void {
    if (a <= 0) return
    const g = this.grid
    const L = this.layout
    const { W, H } = L
    if (L.mode === 'full') {
      corners(g, { x: 0, y: 0, w: W, h: H }, fadeIn(C.bone24, a), 2)
      const hx = L.header.x
      const hy = L.header.y
      if (L.logo && drawLogo) {
        const lc = this.logoCanvas
        const cols = Math.ceil(logoWidth(L.logo.h) / 2) + 1
        const rows = Math.ceil(L.logo.h / 4)
        if (lc.cols !== cols || lc.lines !== rows) lc.resize(cols, rows)
        else lc.clear()
        logoMark(lc, 0, 0, L.logo.h, 1, this.anim)
        const lr = lc.rows()
        for (let i = 0; i < lr.length; i++) g.ansi(L.logo.x, L.logo.y + i, lr[i], cols, true)
        if (a < 1) g.fade(L.logo.x, L.logo.y, cols, rows, 1 - a)
      }
      const tx = hx + 1 + Math.ceil(logoWidth(16) / 2) + 2
      const b = this.boot
      // status block, right-aligned values; the wallet hint gives way before the identity block does
      const rx1 = hx + L.header.w
      const statusRows = (short: boolean): [string, Span[]][] => [
        ['STATUS', this.statusSpans()],
        ['SERVER', [[this.conn?.server ?? b?.server ?? '—', C.bone62]]],
        ['WALLET', this.walletSpans(short)],
        ['UPTIME', [[this.uptime(), C.bone62]]],
      ]
      const widest = (rs: [string, Span[]][]) => rs.reduce((m, [, sp]) => Math.max(m, spansWidth(sp)), 0)
      let rows = statusRows(false)
      if (rx1 - widest(rows) - 9 - 3 - tx < 56) rows = statusRows(true)
      const maxW = widest(rows)
      const vx = rx1 - maxW
      const idW = Math.max(16, Math.min(56, vx - 9 - 3 - tx))
      g.text(tx, hy, 'L U S C A', fadeIn(C.bone, a), BOLD)
      g.text(tx, hy + 1, track('DESKTOP NEURON'), fadeIn(C.bone62, a), 0, idW)
      g.text(tx, hy + 2, b ? ellipsize(b.label, idW) : '—', fadeIn(C.bone32, a))
      g.text(tx, hy + 3, b ? ellipsize(`${b.threads} THREADS  ·  ${b.os}  ·  BUILD ${b.build}`, idW) : '', fadeIn(C.bone24, a))
      for (let i = 0; i < rows.length; i++) {
        const [label, sp] = rows[i]
        g.text(vx - 9, hy + i, label, fadeIn(C.bone24, a))
        spans(g, vx, hy + i, this.fadeSpans(sp, a))
      }
      // live compute trace between the two blocks
      if (L.signal) {
        const sx = tx + idW + 4
        const ex = vx - 9 - 4
        const w = Math.min(72, ex - sx)
        if (w >= 20) this.drawSignal({ x: sx + Math.floor((ex - sx - w) / 2), y: hy, w, h: 4 }, a)
      }
      hrule(g, hx, hy + 5, L.header.w, fadeIn(C.bone16, a), this.ascii ? '-' : '─', easeOutExpo(a))
    } else {
      const y = L.header.y
      const x0 = L.header.x
      const avail = L.header.w
      const right: Span[][] = [
        [...this.statusSpans(), ['   ', 0], ...this.walletSpans(), ['   UP ', C.bone24], [this.uptime(), C.bone62]],
        [...this.statusSpans(), ['   ', 0], ...this.walletSpans(true), ['   UP ', C.bone24], [this.uptime(), C.bone62]],
        [...this.statusSpans(), ['   ', 0], ...this.walletSpans(true)],
        this.statusSpans(),
      ]
      const lefts: Span[][] = [
        [[this.g('■'), C.hot], [' L U S C A', C.bone, BOLD], ['   ', 0], [track('DESKTOP NEURON'), C.bone32]],
        [[this.g('■'), C.hot], [' L U S C A', C.bone, BOLD], ['   ', 0], ['DESKTOP NEURON', C.bone32]],
        [[this.g('■'), C.hot], [' L U S C A', C.bone, BOLD]],
      ]
      let done = false
      for (const r of right) {
        for (const l of lefts) {
          if (spansWidth(l) + 3 + spansWidth(r) <= avail) {
            spans(g, x0, y, this.fadeSpans(l, a))
            spans(g, x0 + avail - spansWidth(r), y, this.fadeSpans(r, a))
            done = true
            break
          }
        }
        if (done) break
      }
    }
  }

  /** Masthead trace: a spike per computed job (height = its GFLOPS against the session peak). */
  private drawSignal(r: Rect, a: number): void {
    const g = this.grid
    // label row on top, trace in the rows below
    const tr: Rect = { x: r.x, y: r.y + 1, w: r.w, h: r.h - 1 }
    const c = this.sparkCanvas2
    if (c.cols !== tr.w || c.lines !== tr.h) c.resize(tr.w, tr.h)
    else c.clear()
    const W2 = tr.w * 2
    const H4 = tr.h * 4
    const base = H4 - 1
    const dps = 14 // dots per second of scroll
    const now = this.clock
    const windowMs = (W2 / dps) * 1000
    // the visible spikes, scaled between the window's lowest and highest GFLOPS
    let lo = Infinity
    let hi = -Infinity
    let first = this.spikes.length
    for (let i = this.spikes.length - 1; i >= 0; i--) {
      if (now - this.spikes[i].t > windowMs + 600) break
      first = i
      lo = Math.min(lo, this.spikes[i].g)
      hi = Math.max(hi, this.spikes[i].g)
    }
    const span = hi - lo > 1e-9 ? hi - lo : Math.max(hi, 1)
    // envelope: each job is a sharp peak with a short decay (a seismograph of the work)
    const env = new Float32Array(W2)
    const heat = new Float32Array(W2)
    for (let i = first; i < this.spikes.length; i++) {
      const s = this.spikes[i]
      const x0 = W2 - 1 - ((now - s.t) / 1000) * dps
      const h = 0.35 + 0.65 * ((s.g - lo) / span)
      const fresh = clamp01(1 - (now - s.t) / 900)
      for (let dx = -1; dx <= 7; dx++) {
        const x = Math.round(x0) + dx
        if (x < 0 || x >= W2) continue
        const d = x - x0
        const v = d < 0 ? h * Math.max(0, 1 + d * 1.2) : h * Math.exp(-d / 1.7)
        if (v > env[x]) {
          env[x] = v
          heat[x] = fresh
        }
      }
    }
    let px = -1
    let py = base
    for (let x = 0; x < W2; x++) {
      const y = base - env[x] * (H4 - 2)
      const k = env[x]
      const col = rampAt(0.18 + 0.3 * k + 0.45 * heat[x])
      if (px >= 0) c.line(px, py, x, y, col, 0.55 + 0.5 * k)
      else c.plot(x, y, col, 0.7)
      px = x
      py = y
    }
    const rows = c.rows()
    for (let i = 0; i < rows.length; i++) g.ansi(tr.x, tr.y + i, rows[i], tr.w, true)
    if (a < 1) g.fade(tr.x, tr.y, tr.w, tr.h, 1 - a)
    const rate = this.rateR.has ? `${fmtInt(this.rateR.value)} JOBS/MIN` : '—'
    g.text(r.x, r.y, 'C O M P U T E', fadeIn(C.bone24, a))
    textRight(g, r.x + r.w, r.y, `${rate}  ·  ${Math.round(windowMs / 1000)} S`, fadeIn(C.bone24, a))
  }

  /** Data bus in the gutter: jobs travel down, results travel up. */
  private drawBus(a: number): void {
    if (a <= 0) return
    const g = this.grid
    const b = this.layout.bus
    if (b.h <= 0) return
    const line = this.ascii ? '|' : '│'
    const n = Math.round(b.h * easeOutExpo(a))
    for (let i = 0; i < n; i++) g.put(b.x, b.y + i, this.ascii ? ':' : '┊', fadeIn(C.bone16, a))
    const travel = 900
    const live: typeof this.packets = []
    for (const p of this.packets) {
      const k = (this.clock - p.born) / travel
      if (k >= 1.2) continue
      live.push(p)
      const pos = p.dir > 0 ? k * (b.h + 4) : b.h - 1 - k * (b.h + 4)
      for (let tail = 0; tail < 4; tail++) {
        const yy = Math.round(pos - p.dir * tail)
        if (yy < 0 || yy >= n) continue
        const glow = tail === 0 ? 1 : 0.62 - tail * 0.16
        const col = tail === 0 ? (p.dir > 0 ? C.hot : C.white) : mix(C.bone16, p.dir > 0 ? C.hot : C.bone, glow)
        g.put(b.x, b.y + yy, tail === 0 ? line : this.ascii ? ':' : '│', fadeIn(col, a))
      }
    }
    this.packets = live
  }

  private drawHero(a: number): void {
    if (a <= 0) return
    const g = this.grid
    const L = this.layout
    const r = L.hero
    const c = this.heroCanvas
    if (c.cols !== r.w || c.lines !== r.h) c.resize(r.w, r.h)
    else c.clear()
    const connected = this.conn?.state === 'registered' || this.conn?.state === 'connected'
    // the entrance is the creature's own: the mantle swells in, light traces out along the arms
    this.octo.draw(c, this.anim, { load: clamp01(this.load.value), connected, paused: this.paused, labels: true, reveal: a })
    const rows = c.rows()
    for (let i = 0; i < rows.length; i++) g.ansi(r.x, r.y + i, rows[i], r.w, true)

    // frame: ticks around creature + caption, overlay labels on the top edge
    const cap = L.caption
    const fr: Rect = { x: r.x, y: r.y, w: r.w, h: r.h + cap.h }
    corners(g, fr, fadeIn(C.bone24, a), 2)
    g.overlay(r.x + 3, r.y, '[ 00 ]', fadeIn(C.bone32, a))
    g.overlay(r.x + 10, r.y, track('NEURON'), fadeIn(C.bone62, a), BOLD)
    if (this.lastArm >= 0) {
      const k = clamp01(1 - (this.clock - this.lastArmAt) / 1600)
      textRight(g, r.x + r.w - 3, r.y, `ARM ${roman(this.lastArm)}`, fadeIn(mix(C.bone32, C.hot, k), a))
    }
    // caption (inside the frame; the frame's bottom row stays clear for the ticks)
    const capY = cap.h >= 3 ? cap.y : cap.y
    const innerX = cap.x + 2
    const innerW = cap.w - 4
    const kind = this.lastKind
    const ver = this.version !== null ? `SEPIA v${this.version}` : 'SEPIA'
    const what = kind === 'sim' ? 'DEDUPE' : kind === 'train' ? 'TRAINING' : this.conn?.state === 'registered' ? 'WAITING FOR A JOB' : this.conn ? 'CONNECTING' : 'STARTING'
    const groups: Span[][] = [
      [[ver, C.bone, BOLD]],
      [['  ·  ', C.bone24], [what, kind ? C.hot : C.bone62, BOLD]],
    ]
    if (this.batch !== null && kind === 'train') groups.push([['  ·  ', C.bone24], [`B=${this.batch}`, C.bone62]])
    const busy = this.busyR.has ? clamp01(this.busyR.value) : null
    const pct = busy !== null ? `${String(Math.round(busy * 100)).padStart(3)}%` : '   —'
    // the caption wins; the load meter takes what is left (hidden below a 4-cell gauge)
    const capParts = fitGroups(groups.slice(0, 2), innerW)
    const extra = fitGroups(groups.slice(2), innerW - spansWidth(capParts) - 22)
    capParts.push(...extra)
    spans(g, innerX, capY, this.fadeSpans(capParts, a), innerW)
    const lw = Math.min(16, innerW - spansWidth(capParts) - 3 - 5 - 1 - pct.length)
    const lx = innerX + innerW - lw - 1 - pct.length
    if (lw >= 4) {
      g.text(lx - 5, capY, 'BUSY', fadeIn(C.bone24, a))
      gauge(g, lx, capY, lw, busy ?? 0, fadeIn(C.hot, a), fadeIn(C.bone16, a), this.ascii)
      g.text(lx + lw + 1, capY, pct, fadeIn(C.bone62, a))
    }
    if (cap.h >= 3) {
      const z = ZONES.find((q) => q.zone === this.zone)
      const g2: Span[][] = [
        [['NEURON ', C.bone24], [this.neuronId ? shortId(this.neuronId) : '—', C.bone62]],
        [['   ZONE ', C.bone24], [this.zone ?? '—', this.zone ? C.hot : C.bone32, BOLD]],
      ]
      if (z) g2.push([['  ', 0], [z.name.toUpperCase(), C.bone32]], [[`  ${z.depth.toUpperCase()}`, C.bone24]])
      spans(g, innerX, capY + 1, this.fadeSpans(fitGroups(g2, innerW), a), innerW)
    }
  }

  /** Panel chrome: bracket label + right meta + hairline. Returns the content rect. */
  private panel(r: Rect, num: string, title: string, meta: Span[], a: number): Rect {
    const g = this.grid
    const content = { x: r.x, y: r.y + 2, w: r.w, h: Math.max(0, r.h - 2) }
    if (a <= 0 || r.w < 8 || r.h < 3) return content
    // titles are letterspaced together or not at all (VERIFICATION is the longest)
    const tracked = this.layout.verify.w >= 31
    const end = bracketLabel(g, r.x, r.y, num, title, { reveal: easeOutCubic(a), tracked, numColor: fadeIn(C.hot, a), titleColor: fadeIn(C.bone62, a) })
    const mw = spansWidth(meta)
    if (mw > 0 && r.x + r.w - mw > end + 1) spans(g, r.x + r.w - mw, r.y, this.fadeSpans(meta, a))
    hrule(g, r.x, r.y + 1, r.w, fadeIn(C.bone16, a), this.ascii ? '-' : '─', easeOutExpo(a))
    return content
  }

  private labelW(r: Rect): number {
    return r.w >= 40 ? 12 : 9
  }

  /** Label + value spans (+ right spans, dropped when they would crowd the value). */
  private kv(r: Rect, row: number, label: string, value: Span[], a: number, right?: Span[]): void {
    if (row >= r.h || a <= 0) return
    const g = this.grid
    const lw = this.labelW(r)
    const y = r.y + row
    g.text(r.x, y, label, fadeIn(C.bone32, a), 0, lw - 1)
    const vw = spansWidth(value)
    const rw = right ? spansWidth(right) : 0
    const showRight = rw > 0 && lw + vw + 2 + rw <= r.w
    // whole spans only: a trailing detail that does not fit is left out rather than cut
    const room = r.w - lw - (showRight ? rw + 2 : 0)
    const fit: Span[] = []
    let used = 0
    for (const sp of value) {
      const n = [...sp[0]].length
      if (used + n > room && fit.length > 0) break
      fit.push(sp)
      used += n
    }
    spans(g, r.x + lw, y, this.fadeSpans(fit, a), room)
    if (showRight && right) spans(g, r.x + r.w - rw, y, this.fadeSpans(right, a))
  }

  private dash(): Span {
    return ['—', C.bone32]
  }

  private drawTraining(r: Rect, ah: number, ac: number): void {
    const meta: Span[] = this.version !== null ? [['SEPIA ', C.bone32], [`v${this.version}`, C.bone62]] : [['SEPIA-0', C.bone32]]
    const c = this.panel(r, '01', 'TRAINING', meta, ah)
    if (ac <= 0 || c.h <= 0) return
    const g = this.grid
    const lw = this.labelW(c)
    const wide = c.w >= 40
    // loss + trend
    const loss = this.lastLoss
    let trend: Span[] | undefined
    if (this.losses.length >= 8) {
      const n = this.losses.length
      const k = Math.min(30, Math.floor(n / 2))
      const recent = this.losses.slice(n - k).reduce((s, v) => s + v, 0) / k
      const before = this.losses.slice(Math.max(0, n - 2 * k), n - k).reduce((s, v) => s + v, 0) / Math.max(1, Math.min(k, n - k))
      const d = recent - before
      trend = [[`${d <= 0 ? '▼' : '▲'} ${Math.abs(d).toFixed(4)}`, d <= 0 ? C.bone62 : C.hot]]
    }
    this.kv(c, 0, 'LOSS', loss !== null ? [[loss.toFixed(4), C.bone, BOLD]] : [this.dash()], ac, trend)
    let row = 1
    const sparkH = c.h >= 7 ? Math.max(2, c.h - 5) : 1
    if (c.h >= 5) {
      if (this.losses.length >= 2) {
        sparkline(g, this.sparkCanvas, c.x, c.y + row, c.w, sparkH, this.losses, mixRgb(PAL.bone32, PAL.bone, 0.45), PAL.hot)
        if (ac < 1) g.fade(c.x, c.y + row, c.w, sparkH, 1 - ac)
      } else {
        hrule(g, c.x, c.y + row + sparkH - 1, c.w, fadeIn(C.bone16, ac), this.ascii ? '.' : '┄')
      }
      row += sparkH
    }
    // GFLOPS + gauge against the session peak
    if (row < c.h) {
      const y = c.y + row
      g.text(c.x, y, 'GFLOPS', fadeIn(C.bone32, ac))
      const gf = this.gflopsNow.has ? this.gflopsNow.value : null
      const peakW = wide ? 11 : 0
      const gx = c.x + lw + 7
      const gw = Math.max(3, c.x + c.w - gx - peakW)
      if (gf !== null) {
        g.text(c.x + lw, y, fmtG(gf), fadeIn(C.bone, ac), BOLD)
        gauge(g, gx, y, gw, this.peakGflops > 0 ? gf / (this.peakGflops * 1.1) : 0, fadeIn(C.hot, ac), fadeIn(C.bone16, ac), this.ascii)
        if (wide) textRight(g, c.x + c.w, y, `PEAK ${fmtG(this.peakGflops)}`, fadeIn(C.bone32, ac))
      } else {
        g.text(c.x + lw, y, '—', fadeIn(C.bone32, ac))
        hrule(g, gx, y, gw, fadeIn(C.bone16, ac), this.ascii ? '-' : '─')
      }
      row++
    }
    const rate = this.rateR.has ? this.rateR.value : null
    this.kv(c, row++, 'RATE', rate !== null ? [[fmtInt(rate), C.bone, BOLD], [wide ? ' JOBS/MIN' : '/MIN', C.bone62], [this.lastMs !== null && wide ? `  ·  ${this.lastMs.toFixed(0)} MS/JOB` : '', C.bone32]] : [this.dash()], ac)
    if (wide)
      this.kv(c, row++, 'BATCH', this.batch !== null ? [[`${this.batch} × ${SEPIA.ctx}`, C.bone62], ['  ·  ', C.bone24], [`${fmtInt(SEPIA.params)} PARAMS`, C.bone32]] : [this.dash(), [`   ${fmtInt(SEPIA.params)} PARAMS`, C.bone24]], ac)
    else this.kv(c, row++, 'BATCH', this.batch !== null ? [[`${this.batch} × ${SEPIA.ctx}`, C.bone62]] : [this.dash()], ac)
    this.kv(c, row++, wide ? 'COMPUTED' : 'DONE', this.computedCount > 0 ? [[fmtFlop(this.flopsTotal), C.bone62], [wide ? `  ·  ${fmtInt(this.computedCount)} JOBS` : '', C.bone32]] : [this.dash()], ac)
  }

  private drawVerification(r: Rect, ah: number, ac: number): void {
    const meta: Span[] = this.totals && r.w >= 36 ? [[`${fmtInt(this.totals.verified)}/${fmtInt(this.totals.verified + this.totals.failed)}`, C.bone62]] : []
    const c = this.panel(r, '02', 'VERIFICATION', meta, ah)
    if (ac <= 0 || c.h <= 0) return
    const g = this.grid
    const wide = c.w >= 40
    const lw = this.labelW(c)
    const any = this.tape.length > 0
    this.kv(c, 0, wide ? 'SPOT CHECKS' : 'SPOT', any ? [[fmtInt(this.spot), C.bone, BOLD], [' PASSED', C.bone62]] : [this.dash()], ac, any ? [[`${fmtInt(this.rejected)} REJECTED`, this.rejected > 0 ? C.hot : C.bone24]] : undefined)
    const ago = this.lastAuditWall >= 0 ? fmtAgo(this.wall() - this.lastAuditWall) : null
    this.kv(c, 1, wide ? 'FULL AUDITS' : 'AUDITS', any ? [[fmtInt(this.audits), C.bone, BOLD], [' PASSED', C.bone62]] : [this.dash()], ac, ago ? [['LAST ', C.bone24], [ago, C.bone62], [wide ? ' AGO' : '', C.bone24]] : undefined)
    let row = 2
    // verdict tape — one cell per verdict, newest at the bottom right; wraps into a grid on tall panels
    if (c.h >= 5) {
      const rowsT = Math.max(1, c.h - 5)
      const cells = rowsT * c.w
      for (let j = 0; j < cells; j++) {
        const x = c.x + (j % c.w)
        const y = c.y + row + Math.floor(j / c.w)
        const ti = this.tape.length - cells + j
        if (ti < 0) {
          g.put(x, y, this.ascii ? '.' : '·', fadeIn(C.bone16, ac))
          continue
        }
        const v = this.tape[ti]
        const fresh = clamp01((this.clock - v.born) / 500)
        const ch = v.s === 'verified' ? '▪' : v.s === 'audited' ? '◆' : v.s === 'stale' ? '·' : '×'
        const base = v.s === 'verified' ? C.bone62 : v.s === 'audited' ? C.hot : v.s === 'stale' ? C.bone24 : C.hot
        g.put(x, y, this.g(ch), fadeIn(mix(C.white, base, fresh), ac * (0.35 + 0.65 * fresh)))
      }
      row += rowsT
    }
    // escrow: fills with every verified gradient, drains when a full audit releases it
    if (row < c.h) {
      const y = c.y + row
      g.text(c.x, y, 'ESCROW', fadeIn(C.bone32, ac))
      const bw = c.w - lw
      const pend = this.pendingR.value
      if (this.account) {
        const cap = Math.max(this.maxPending * 1.15, 1)
        const n = clamp01(pend / cap) * bw
        const full = Math.floor(n)
        for (let i = 0; i < bw; i++) {
          if (i < full) g.put(c.x + lw + i, y, this.ascii ? '~' : '┅', fadeIn(C.hot, ac))
          else if (i === full && n - full >= 0.5) g.put(c.x + lw + i, y, this.ascii ? '-' : '╍', fadeIn(C.hot62, ac))
          else g.put(c.x + lw + i, y, this.ascii ? '-' : '─', fadeIn(C.bone16, ac))
        }
      } else hrule(g, c.x + lw, y, bw, fadeIn(C.bone16, ac), this.ascii ? '-' : '─')
      row++
    }
    if (row < c.h) {
      const y = c.y + row
      if (this.account) {
        spans(g, c.x + lw, y, this.fadeSpans([[`+${fmtCredits(this.pendingR.value)}`, C.hot, BOLD], [' PENDING', C.bone62]], ac))
        const rel: Span[] = wide ? [['RELEASED ', C.bone24], [fmtCredits(this.released), C.bone62]] : []
        if (rel.length && spansWidth(rel) + lw + 16 < c.w) spans(g, c.x + c.w - spansWidth(rel), y, this.fadeSpans(rel, ac))
      } else g.text(c.x + lw, y, '—', fadeIn(C.bone32, ac))
      row++
    }
    if (row < c.h && c.w >= 30) {
      g.text(c.x, c.y + row, c.w >= 46 ? 'PENDING CREDITS CONFIRM ON THE NEXT FULL AUDIT' : 'CONFIRMS ON THE NEXT FULL AUDIT', fadeIn(C.bone24, ac), 0, c.w)
    }
  }

  private drawCredits(r: Rect, ah: number, ac: number): void {
    const glow = clamp01(1 - (this.clock - this.releaseAt) / 1400)
    // the server's ledger: all-time confirmed for this identity (wallet or device account)
    const meta: Span[] = r.w >= 50 ? [['CONFIRMED', mix(C.bone32, C.hot, glow)], ['  ·  ALL-TIME', C.bone24]] : [['CONFIRMED', mix(C.bone32, C.hot, glow)]]
    const c = this.panel(r, '03', 'CREDITS', meta, ah)
    if (ac <= 0 || c.h <= 0) return
    const g = this.grid
    const has = !!this.account && this.odo.has
    const wBig = has ? this.odo.width('big') : 6
    const wSmall = has ? this.odo.width('small') : 4
    const font = c.h >= 6 && wBig <= c.w ? 'big' : c.h >= 4 && wSmall <= c.w ? 'small' : null
    let row = 0
    if (font) {
      const fh = fontRows(font)
      if (has) {
        const w = this.odo.draw(g, c.x, c.y, font, { int: fadeIn(mix(C.bone, C.white, glow), ac), dec: fadeIn(mix(C.bone62, C.bone, glow), ac), moving: fadeIn(C.hot, ac) })
        // escrow released: a band of light sweeps across the figures once
        const k = prog(this.clock, this.releaseAt, 750)
        if (k > 0 && k < 1) {
          const bx = c.x - 4 + (w + 8) * easeInOutSine(k)
          for (let yy = c.y; yy < c.y + fh; yy++) {
            for (let xx = Math.floor(bx - 4); xx <= bx + 4; xx++) {
              if (xx < c.x || xx >= c.x + w || g.get(xx, yy) === ' ') continue
              const i = yy * g.w + xx
              const d = 1 - Math.abs(xx - bx) / 4.5
              if (d > 0) g.fg[i] = mix(g.fg[i], C.hot, d * 0.9)
            }
          }
        }
      } else {
        for (let k = 0; k < (font === 'big' ? 6 : 4); k++) g.put(c.x + k, c.y + Math.floor(fh / 2), '▀', fadeIn(C.bone24, ac))
      }
      row = fh + (c.h - fh >= 3 ? 1 : 0)
    } else {
      // too small for display digits: plain bold figures
      g.text(c.x, c.y, has ? this.odo.target : '—', fadeIn(C.bone, ac), BOLD)
      row = 1
    }
    if (row < c.h) {
      // pending in escrow (left) and confirmed gained since this run's first ledger reply (right),
      // the longest wording that fits
      const a = this.account
      const pend = (long: boolean): Span[] => (a ? [[`+${fmtCredits(this.pendingR.value)}`, C.hot, BOLD], [long ? ' PENDING IN ESCROW' : ' PENDING', C.bone62]] : [['—', C.bone32], [' PENDING', C.bone32]])
      const sess = (long: boolean): Span[] => [[long ? 'THIS SESSION ' : 'SESSION ', C.bone24], [a ? `+${fmtCredits(a.session)}` : '—', a && a.session > 0 ? C.bone : C.bone62, a && a.session > 0 ? BOLD : 0]]
      const options: [Span[], Span[] | null][] = [
        [pend(true), sess(true)],
        [pend(true), sess(false)],
        [pend(false), sess(false)],
        [pend(true), null],
        [pend(false), null],
      ]
      const [left, right] = options.find(([l, rr]) => spansWidth(l) + (rr ? 2 + spansWidth(rr) : 0) <= c.w) ?? options[options.length - 1]
      spans(g, c.x, c.y + row, this.fadeSpans(left, ac), c.w)
      if (right) spans(g, c.x + c.w - spansWidth(right), c.y + row, this.fadeSpans(right, ac))
      row++
    }
    if (row < c.h) {
      const linked = this.linked === true || this.wallet?.state === 'verified'
      const variants: Span[][] = linked
        ? [
            [['WORK CREDITS', C.bone32], ['  ·  ', C.bone24], ['PAID IN SOL TO VERIFIED WALLETS', C.bone62]],
            [['PAID IN SOL TO VERIFIED WALLETS', C.bone62]],
            [['PAID IN SOL', C.bone62]],
          ]
        : [
            [['NOT LINKED', C.bone62, BOLD], ['  ·  run with --auth to receive SOL', C.bone32]],
            [['run with --auth to receive SOL', C.bone32]],
            [['NOT LINKED', C.bone62, BOLD]],
          ]
      const pick = variants.find((v) => spansWidth(v) <= c.w) ?? variants[variants.length - 1]
      spans(g, c.x, c.y + row, this.fadeSpans(pick, ac), c.w)
    }
  }

  private drawNetwork(r: Rect, ah: number, ac: number): void {
    const c = this.panel(r, '04', 'NETWORK', [], ah)
    if (ac <= 0 || c.h <= 0) return
    const n = this.network
    this.kv(c, 0, 'NEURONS', n ? [[fmtInt(n.neurons), C.bone, BOLD], [' ONLINE', C.bone62]] : [this.dash()], ac)
    this.kv(c, 1, 'POOL', n ? [[fmtG(n.poolGflops), C.bone, BOLD], [' GFLOPS', C.bone62]] : [this.dash()], ac)
    this.kv(c, 2, 'RANK', n && n.rank !== undefined ? [[`#${fmtInt(n.rank)}`, C.hot, BOLD], [` OF ${fmtInt(n.neurons)}`, C.bone62]] : [this.dash()], ac)
    const z = ZONES.find((q) => q.zone === this.zone)
    this.kv(c, 3, 'ZONE', this.zone ? [[this.zone, C.hot, BOLD], [z ? `  ${z.name.toUpperCase()}` : '', C.bone62]] : [this.dash()], ac)
    if (z && c.h > 4) this.kv(c, 4, 'BONUS', [[`×${(this.bench?.bonus ?? z.bonus).toFixed(2)}`, C.bone62], [`  ·  ${z.depth.toUpperCase()}`, C.bone32]], ac)
  }

  private drawFeed(r: Rect, ah: number, ac: number): void {
    const L = this.layout
    let meta: Span[] = []
    if (L.narrow) {
      const n = this.network
      if (n) meta = [['RANK ', C.bone24], [n.rank !== undefined ? `#${fmtInt(n.rank)}` : '—', C.hot, BOLD], [` OF ${fmtInt(n.neurons)}`, C.bone32]]
    } else {
      const head = [...`[ 05 ]  ${track('LIVE FEED')}`].length + 3
      const full: Span[] = [
        [this.g('◇'), C.bone32], [' JOB   ', C.bone24],
        [this.g('▸'), C.bone62], [' COMPUTED   ', C.bone24],
        [this.g('■'), C.bone], [' VERIFIED   ', C.bone24],
        [this.g('◆'), C.hot], [' AUDITED   ', C.bone24],
        [this.g('✓'), C.hot], [' RELEASED   ', C.bone24],
        [this.g('×'), C.hot], [' REJECTED', C.bone24],
      ]
      const tight: Span[] = [
        [this.g('◇'), C.bone32], [' JOB  ', C.bone24],
        [this.g('▸'), C.bone62], [' SENT  ', C.bone24],
        [this.g('■'), C.bone], [' VERIFIED  ', C.bone24],
        [this.g('◆'), C.hot], [' AUDITED  ', C.bone24],
        [this.g('×'), C.hot], [' REJECTED', C.bone24],
      ]
      meta = head + spansWidth(full) <= r.w ? full : head + spansWidth(tight) <= r.w ? tight : []
    }
    const c = this.panel(r, '05', 'LIVE FEED', meta, ah)
    if (ac <= 0 || c.h <= 0) return
    const g = this.grid
    if (this.feed.length === 0) {
      g.text(c.x, c.y, '—', fadeIn(C.bone32, ac))
      return
    }
    const showTime = c.w >= 60
    for (let i = 0; i < c.h && i < this.feed.length; i++) {
      const it = this.feed[i]
      const y = c.y + i
      const fresh = easeOutCubic(clamp01((this.clock - it.born) / 450))
      const age = clamp01(i / Math.max(6, c.h))
      const k = ac * fresh * (1 - 0.45 * age)
      let x = c.x
      if (showTime) {
        g.text(x, y, fmtClock(it.at), fadeIn(C.bone24, k))
        x += 10
      }
      const w = c.x + c.w - x
      if (it.job) this.feedJob(it.job, x, y, w, k, fresh)
      else {
        g.put(x, y, it.glyph ?? '·', fadeIn(it.glyphColor ?? C.bone32, k))
        spans(g, x + 3, y, this.fadeSpans(fitGroups((it.parts ?? []).map((p) => [p]), w - 3), k), w - 3)
      }
    }
  }

  private feedJob(j: JobRow, x: number, y: number, w: number, k: number, fresh: number): void {
    const g = this.grid
    const glyph = this.g(this.verdictGlyph(j.status))
    const gc = this.verdictColor(j.status)
    const flash = Math.min(fresh, clamp01((this.clock - j.changed) / 500))
    g.put(x, y, glyph, fadeIn(mix(C.white, gc, flash), k))
    let right: Span[]
    switch (j.status) {
      case 'received':
        right = [['COMPUTING', C.bone32]]
        break
      case 'computed':
        right = [['SENT', C.bone32]]
        break
      case 'verified':
        right = [[`+${fmtCredits(j.credits ?? 0)}`, C.bone, BOLD], [j.pending ? ' PENDING' : ' CONFIRMED', C.bone32]]
        break
      case 'audited':
        right = [[`+${fmtCredits(j.credits ?? 0)}`, C.hot, BOLD], [' AUDITED', C.bone62]]
        break
      case 'stale':
        right = [['NOT SCORED', C.bone32]]
        break
      case 'failed':
        right = [['FAILED LOCALLY', C.hot, BOLD]]
        break
      default:
        right = [['REJECTED', C.hot, BOLD]]
    }
    const rw = spansWidth(right)
    const avail = w - 3 - rw - 2
    // detail groups in display order, with a priority for dropping when space runs out
    const groups: { p: number; s: Span[] }[] = [
      { p: 0, s: [[j.kind === 'train' ? 'TRAIN ' : 'DEDUPE', C.bone62]] },
      { p: 1, s: [['  ', 0], [shortId(j.id), C.bone]] },
    ]
    if (j.status === 'rejected' || j.status === 'failed' || j.status === 'stale') {
      // the reason takes whatever room is left after the kind and id
      const room = avail - 6 - 2 - [...shortId(j.id)].length - 2
      if (j.reason && room >= 8) groups.push({ p: 2, s: [['  ', 0], [cutEnd(j.reason, room), C.bone62]] })
    } else {
      if (j.version !== undefined) groups.push({ p: 5, s: [['  v', C.bone24], [String(j.version), C.bone62]] })
      if (j.batch !== undefined) groups.push({ p: 6, s: [['  B=', C.bone24], [String(j.batch), C.bone62]] })
      if (j.loss !== undefined) groups.push({ p: 2, s: [['  LOSS ', C.bone24], [j.loss.toFixed(4), C.bone62]] })
      if (j.ms !== undefined) groups.push({ p: 3, s: [['  ', 0], [`${j.ms.toFixed(0)} MS`, C.bone62]] })
      if (j.gflops !== undefined) groups.push({ p: 7, s: [['  ', 0], [`${fmtG(j.gflops)} GFLOPS`, C.bone32]] })
      if (j.ms === undefined && j.flops > 0) groups.push({ p: 4, s: [['  ', 0], [fmtFlop(j.flops), C.bone32]] })
    }
    const order = groups.map((q, i) => ({ ...q, i })).sort((a, b) => a.p - b.p)
    const keep = new Set<number>()
    let used = 0
    for (const q of order) {
      const gw = spansWidth(q.s)
      if (used + gw > avail) continue
      used += gw
      keep.add(q.i)
    }
    const det: Span[] = []
    groups.forEach((q, i) => {
      if (keep.has(i)) det.push(...q.s)
    })
    spans(g, x + 3, y, this.fadeSpans(det, k), Math.max(0, avail))
    spans(g, x + w - rw, y, this.fadeSpans(right, k))
  }

  private drawHints(a: number): void {
    if (a <= 0) return
    const g = this.grid
    const L = this.layout
    const y = L.hints.y
    const key = (k: string, label: string): Span[] => [['[ ', C.bone24], [k, C.bone62, BOLD], [' ] ', C.bone24], [label, C.bone32], ['    ', 0]]
    const parts: Span[] = [...key('Q', 'QUIT'), ...key('P', this.paused ? 'RESUME' : 'PAUSE'), ...key('L', 'LOG')]
    spans(g, L.hints.x, y, this.fadeSpans(parts, a))
    const b = this.boot
    const right: Span[] = L.mode === 'compact' && b ? [['BUILD ', C.bone24], [b.build, C.bone32], ['   ·   ', C.bone16], ['lusca.ink', C.bone32]] : [['lusca.ink', C.bone32]]
    const rw = spansWidth(right)
    if (L.hints.w - rw > spansWidth(parts) + 2) spans(g, L.hints.x + L.hints.w - rw, y, this.fadeSpans(right, a))
    else if (L.hints.w - 9 > spansWidth(parts) + 2) spans(g, L.hints.x + L.hints.w - 9, y, this.fadeSpans([['lusca.ink', C.bone32]], a))
  }

  // ── log view ─────────────────────────────────────────────────────────────

  private drawLogView(): void {
    const g = this.grid
    const { W, H } = this.layout
    corners(g, { x: 0, y: 0, w: W, h: H }, C.bone24, 2)
    bracketLabel(g, 2, 1, 'LOG', 'RAW EVENTS', {})
    textRight(g, W - 3, 1, '[ L ] DASHBOARD', C.bone32)
    hrule(g, 2, 2, W - 4, C.bone16, this.ascii ? '-' : '─')
    const rows = H - 5
    const start = Math.max(0, this.log.length - rows)
    for (let i = start, y = 3; i < this.log.length; i++, y++) {
      const l = this.log[i]
      g.text(2, y, fmtClock(l.at), C.bone24)
      g.put(12, y, this.g(l.glyph), l.color)
      g.text(14, y, l.text, C.bone62, 0, W - 16)
    }
    const st = this.statusSpans()
    spans(g, 2, H - 2, st)
  }

  // ── minimal card (window smaller than 90×26) ─────────────────────────────

  private drawMini(): void {
    const g = this.grid
    const { W, H } = this.layout
    const lines: Span[][] = [
      [[this.g('■'), C.hot], [' L U S C A', C.bone, BOLD], ['  NEURON', C.bone32]],
      this.statusSpans(),
      [['CREDITS ', C.bone32], [this.account ? fmtCredits(this.account.confirmed) : '—', C.bone, BOLD], [this.account ? `  +${fmtCredits(this.account.pending)} PENDING` : '', C.hot]],
      [['JOBS ', C.bone32], [this.totals ? fmtInt(this.totals.jobs) : '—', C.bone62], ['  LOSS ', C.bone32], [this.lastLoss !== null ? this.lastLoss.toFixed(4) : '—', C.bone62]],
      [['ENLARGE TO 90×26 FOR THE DASHBOARD', C.bone24]],
    ]
    const top = Math.max(0, Math.floor((H - lines.length * 2) / 2))
    for (let i = 0; i < lines.length; i++) {
      const w = spansWidth(lines[i])
      spans(g, Math.max(0, Math.floor((W - w) / 2)), top + i * 2, lines[i], W)
    }
  }

  // ── fx canvas (full screen, for the logo) ────────────────────────────────

  private fx(): void {
    const { W, H } = this.layout
    if (this.fxCanvas.cols !== W || this.fxCanvas.lines !== H) this.fxCanvas.resize(W, H)
    else this.fxCanvas.clear()
  }

  /** Composite the fx canvas over the grid (blank cells stay transparent), faded by a. */
  private blitFx(a: number): void {
    if (a <= 0) return
    const rows = this.fxCanvas.rows()
    const g = this.grid
    const fx = this.fxGrid
    if (fx.w !== g.w || fx.h !== g.h) fx.resize(g.w, g.h)
    else fx.clear()
    for (let y = 0; y < rows.length; y++) if (rows[y].trim() !== '') fx.ansi(0, y, rows[y], g.w, true)
    for (let i = 0; i < fx.ch.length; i++) {
      if (fx.ch[i] === ' ') continue
      g.ch[i] = fx.ch[i]
      g.fg[i] = a < 1 ? mix(C.ink, fx.fg[i], a) : fx.fg[i]
      g.at[i] = fx.at[i]
    }
  }

  // ── summary card (printed on the normal screen after leaving) ────────────

  private summaryCard(summary?: string): string {
    if (!summary && !this.totals && !this.account) return '' // nothing ran (e.g. a fatal start-up error follows on stderr)
    const lv = this.level
    const paint = (c: number, s: string, bold = false) => {
      if (lv === 'none') return s
      const r = (c >> 16) & 255
      const gg = (c >> 8) & 255
      const b = c & 255
      const code = lv === 'truecolor' ? `38;2;${r};${gg};${b}` : `38;5;${to256(c)}`
      return `\x1b[${bold ? '1;' : ''}${code}m${s}\x1b[0m`
    }
    const rule = paint(C.bone16, '─'.repeat(64))
    const out: string[] = ['']
    out.push(`  ${paint(C.hot, this.g('■'))} ${paint(C.bone, 'L U S C A', true)}  ${paint(C.bone32, '·  desktop neuron  ·  session ended')}`)
    out.push(`  ${rule}`)
    // the server's ledger as of its last reply (neuron.ts asks once more before leaving)
    const a = this.account
    if (a) {
      out.push(
        `  ${paint(C.bone32, 'credits   ')}${paint(C.bone, fmtCredits(a.confirmed), true)} ${paint(C.bone62, 'confirmed')}  ${paint(C.hot, `+${fmtCredits(a.pending)}`)} ${paint(C.bone62, 'pending')}  ${paint(C.bone62, `+${fmtCredits(a.session)} confirmed this session`)}${this.forfeited > 0 ? `  ${paint(C.hot, `${fmtCredits(this.forfeited)} forfeited`)}` : ''}`,
      )
    } else if (this.totals) {
      out.push(`  ${paint(C.bone32, 'credits   ')}${paint(C.bone62, '— (no reply from the server ledger)')}`)
    }
    if (summary) out.push(`  ${paint(C.bone32, 'session   ')}${paint(C.bone62, summary)}`)
    if (this.audits > 0) out.push(`  ${paint(C.bone32, 'audits    ')}${paint(C.bone62, `${fmtInt(this.audits)} full audits passed · ${fmtInt(this.spot)} spot checks passed`)}`)
    out.push(`  ${paint(C.bone32, 'payouts   ')}${paint(C.bone32, 'work credits are paid in SOL to verified wallets')}`)
    out.push(`  ${rule}`, '', '')
    return out.join('\n')
  }
}

/**
 * Keep whole groups (in order) while they fit in `max` cells; the first group that does not fit is
 * cut with an ellipsis when at least 8 cells remain, and nothing after it is kept.
 */
function fitGroups(groups: Span[][], max: number): Span[] {
  const out: Span[] = []
  let used = 0
  for (const gr of groups) {
    const w = spansWidth(gr)
    if (used + w <= max) {
      out.push(...gr)
      used += w
      continue
    }
    let room = max - used
    if (room >= 8) {
      for (const [s, c, at] of gr) {
        if (room <= 0) break
        const cs = [...s]
        if (cs.length <= room) {
          out.push([s, c, at])
          room -= cs.length
        } else {
          out.push([cs.slice(0, Math.max(0, room - 1)).join('') + '…', c, at])
          room = 0
        }
      }
    }
    break
  }
  return out
}

const LOGO_MS = 1000
const BUSY_WINDOW = 10_000
const BOOT_LINES_AT = 520
const BOOT_STAGGER = 150
const TRANSITION_MS = 800


/** Cut a sentence to `max` cells with a trailing ellipsis. */
function cutEnd(s: string, max: number): string {
  const cs = [...s]
  return cs.length <= max ? s : cs.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…'
}
