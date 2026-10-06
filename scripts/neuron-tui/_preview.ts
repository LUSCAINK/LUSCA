// Dev driver for the neuron dashboard (not bundled): feeds a scripted, realistic sequence of
// NeuronEvents into the dashboard on a virtual terminal with virtual time, steps frames at 20 fps,
// checks that the diff-encoded output reproduces each composed frame exactly (a small VT emulator
// replays the byte stream), and dumps chosen frames as ANSI text (one row per line) for
// ../video/qa/tui/ansi2png.py.
//
//   npx tsx scripts/neuron-tui/_preview.ts --live [--stop ms] [--ascii]   (real terminal, real time)
//   npx tsx scripts/neuron-tui/_preview.ts [--size 160x45] [--at 300,1200,…] [--out dir] [--level truecolor|256|none] [--ascii]
//   npx tsx scripts/neuron-tui/_preview.ts --moments [--scenario linked|nolink|reconnect|idle] [--glyphs octant|braille|ascii]
//
// Default: three sizes (160×45 full, 120×30 compact, 90×26 compact-min) at a standard set of times.
// --moments dumps named frames instead (boot ×3, pulse, ripple, escrow — or the scenario's state).

import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Dashboard } from './dashboard.ts'
import { createUI } from './index.ts'
import { virtualTerm } from './term.ts'
import type { ColorLevel, GlyphMode } from './term.ts'
import type { NeuronEvent } from './types.ts'

const argv = process.argv.slice(2)
const opt = (n: string, d: string) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const OUT = path.resolve(opt('--out', path.join(process.cwd(), '..', 'video', 'qa', 'tui', 'frames')))
const LEVEL = opt('--level', 'truecolor') as ColorLevel
const ASCII = argv.includes('--ascii')
const GLYPHS = opt('--glyphs', ASCII ? 'ascii' : 'octant') as GlyphMode
const MOMENTS = argv.includes('--moments')
const SIZES = argv.includes('--size') ? [opt('--size', '160x45')] : ['160x45', '120x30', '90x26']
const DEFAULT_AT = [250, 900, 1700, 2500, 3300, 3700, 4100, 5200, 9000, 21000, 46000]
const AT = argv.includes('--at') ? opt('--at', '').split(',').map(Number) : DEFAULT_AT
const SCENARIO = opt('--scenario', 'linked') // linked | nolink | reconnect | idle
const RESIZE: [number, number, number][] = argv.includes('--resize')
  ? opt('--resize', '')
      .split(',')
      .map((kv) => {
        const [t, s] = kv.split(':')
        const [w, h] = s.split('x').map(Number)
        return [Number(t), w, h] as [number, number, number]
      })
  : []
const STOP_AT = Number(opt('--stop', '0'))
const KEYS: [number, string][] = argv.includes('--keys')
  ? opt('--keys', '')
      .split(',')
      .map((kv) => {
        const [t, k] = kv.split(':')
        return [Number(t), k] as [number, string]
      })
  : []
fs.mkdirSync(OUT, { recursive: true })

// ─── deterministic script ────────────────────────────────────────────────────

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

function script(): { at: number; e: NeuronEvent }[] {
  const rnd = mulberry32(0x5e9a)
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('')
  const ev: { at: number; e: NeuronEvent }[] = []
  const at = (t: number, e: NeuronEvent) => ev.push({ at: t, e })
  const server = 'wss://lusca.ink/ws'
  at(0, { t: 'boot', build: '2026-10-05+3f9c2a71d0', cpu: 'AMD Ryzen 7 5800X 8-Core Processor', threads: 16, os: 'win32 x64', server, label: 'AMD Ryzen 7 5800X 8-Core Processor · desktop' })
  at(600, { t: 'bench', phase: 'start' })
  at(1500, { t: 'bench', phase: 'done', gflops: 2.43, zone: 'EPI', bonus: 1 })
  at(1780, { t: 'selftest', batch: 128, ms: 29.6, gflops: 4.73, codecCos: 0.99998 })
  if (SCENARIO === 'nolink') at(2050, { t: 'wallet', state: 'none' })
  else at(2050, { t: 'wallet', state: 'verified', address: 'E78KqkTZ5Ue3dLHJmT9Wpz2dDrmGG9nYcxCnaYCbRxWm', until: Date.UTC(2026, 10, 4) })
  at(2120, { t: 'conn', state: 'connecting', server })
  at(2380, { t: 'conn', state: 'connected', server })
  at(2560, { t: 'conn', state: 'registered', server, neuronId: 'nrn_7f3a9c2e41d8b6aa', zone: 'EPI', gflops: 2.43, linked: SCENARIO !== 'nolink' })
  // the ledger's reply to account.watch, right after registering (pushed again ~250 ms after changes)
  at(2600, { t: 'account', confirmed: 1184.6, pending: 0, session: 0, scope: SCENARIO === 'nolink' ? 'device' : 'wallet' })
  at(2700, { t: 'network', rank: 212, neurons: 1204, poolGflops: 84210 })
  // job stream (idle: the first job arrives long after the dashboard is up)
  let t = SCENARIO === 'idle' ? 12000 : 2900
  let confirmed = 1184.6
  let pending = 0
  let jobs = 0
  let verified = 0
  let failed = 0
  let loss = 4.214
  const version = 492151
  for (let i = 0; i < 160; i++) {
    const id = `trn_${hex(12)}`
    const B = 128
    const flops = 1.402e8
    at(t, { t: 'job', id, kind: 'train', version: version + Math.floor(i / 9), batch: B, flops })
    const ms = 27 + rnd() * 8
    t += 40 + ms
    loss = Math.max(1.2, loss - 0.0016 + (rnd() - 0.5) * 0.02)
    at(t, { t: 'computed', id, kind: 'train', ms, gflops: flops / (ms * 1e6), loss })
    t += 90 + rnd() * 60
    jobs++
    const credits = 1.4
    if (i === 23) {
      failed++
      at(t, { t: 'verdict', id, kind: 'train', status: 'rejected', credits: 0, pending: false, reason: 'spot check mismatch on sub-batch 3/8' })
    } else if (i % 11 === 4) {
      verified++
      confirmed += credits
      at(t, { t: 'verdict', id, kind: 'train', status: 'audited', credits, pending: false, reason: 'full audit passed' })
      if (pending > 0) {
        const rel = Math.round(pending * 100) / 100
        confirmed += rel
        pending = 0
        at(t + 1, { t: 'escrow', released: rel })
      }
    } else {
      verified++
      pending += credits
      at(t, { t: 'verdict', id, kind: 'train', status: 'verified', credits, pending: true, reason: 'spot check passed' })
    }
    at(t + 2, { t: 'totals', jobs, verified, failed })
    at(t + 250, { t: 'account', confirmed: Math.round(confirmed * 100) / 100, pending: Math.round(pending * 100) / 100, session: Math.round((confirmed - 1184.6) * 100) / 100, scope: SCENARIO === 'nolink' ? 'device' : 'wallet' })
    if (i === 40) at(t + 3, { t: 'network', rank: 209, neurons: 1211, poolGflops: 84655 })
    if (i === 70) at(t + 3, { t: 'notice', level: 'warn', msg: 'no job for 30 s — asking again' })
    if (SCENARIO === 'reconnect' && i === 30) {
      // same order and wording as neuron.ts: the conn event, then the reason
      at(t + 10, { t: 'conn', state: 'reconnecting', server })
      at(t + 11, { t: 'notice', level: 'error', msg: 'connection lost — reconnecting in 1.2 s' })
      at(t + 1300, { t: 'conn', state: 'connecting', server })
      at(t + 1600, { t: 'conn', state: 'connected', server })
      at(t + 1750, { t: 'conn', state: 'registered', server, neuronId: 'nrn_7f3a9c2e41d8b6aa', zone: 'EPI', gflops: 2.43, linked: true })
      t += 1800
    }
    t += 60 + rnd() * 200
  }
  return ev.sort((a, b) => a.at - b.at)
}

// ─── VT replay (checks the diff encoder) ─────────────────────────────────────

class VScreen {
  ch: string[]
  fg: Int32Array
  x = 0
  y = 0
  cur = -1
  constructor(
    public w: number,
    public h: number,
  ) {
    this.ch = new Array(w * h).fill(' ')
    this.fg = new Int32Array(w * h).fill(-1)
  }
  feed(s: string): void {
    for (let i = 0; i < s.length; ) {
      if (s[i] === '\x1b' && s[i + 1] === '[') {
        let j = i + 2
        while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++
        const params = s.slice(i + 2, j)
        const fin = s[j]
        if (fin === 'H') {
          const [r, c] = params.split(';').map((v) => Number(v || 1))
          this.y = (r || 1) - 1
          this.x = (c || 1) - 1
        } else if (fin === 'J' && params === '2') {
          this.ch.fill(' ')
          this.fg.fill(-1)
        } else if (fin === 'm') {
          const ps = params.split(';')
          for (let k = 0; k < ps.length; k++) {
            const p = Number(ps[k] || 0)
            if (p === 0) this.cur = -1
            else if (p === 38 && ps[k + 1] === '2') {
              this.cur = (Number(ps[k + 2]) << 16) | (Number(ps[k + 3]) << 8) | Number(ps[k + 4])
              k += 4
            } else if (p === 38 && ps[k + 1] === '5') {
              this.cur = 1000 + Number(ps[k + 2])
              k += 2
            }
          }
        }
        i = j + 1
        continue
      }
      const cp = s.codePointAt(i) ?? 32
      const c = String.fromCodePoint(cp)
      i += c.length
      if (this.x < this.w && this.y < this.h) {
        const idx = this.y * this.w + this.x
        this.ch[idx] = c
        this.fg[idx] = this.cur
      }
      this.x++
    }
  }
}

// ─── run ────────────────────────────────────────────────────────────────────

function run(size: string): void {
  const [W, H] = size.split('x').map(Number)
  const vt = virtualTerm(W, H)
  let now = 0
  const BASE = new Date(2026, 9, 5, 14, 21, 7).getTime()
  const dash = new Dashboard({ term: vt, level: LEVEL, ascii: ASCII, glyphs: GLYPHS, now: () => now, wall: () => BASE + now, manual: true, onQuit: () => {} })
  const events = script()
  const vs = new VScreen(W, H)
  dash.start()
  vs.feed(vt.take())
  let ei = 0
  const labels = MOMENTS ? moments(events) : new Map(AT.map((a) => [a, '']))
  const dumps = new Set(labels.keys())
  const lastAt = Math.max(...dumps)
  let costs = 0
  let frames = 0
  const each: number[] = []
  let maxCost = 0
  let bytes = 0
  let mismatches = 0
  // the CPU benchmark blocks the event loop: no frames between bench start (+120 ms) and done
  const blocked = (t: number) => t > 720 && t < 1500
  const keys = [...KEYS]
  const resizes = [...RESIZE]
  for (let t = 0; t <= lastAt; t += 50) {
    now = t
    while (ei < events.length && events[ei].at <= t) dash.emit(events[ei++].e)
    while (keys.length && keys[0][0] <= t) vt.press(keys.shift()![1])
    while (resizes.length && resizes[0][0] <= t) {
      const [, w, h] = resizes.shift()!
      vt.resize(w, h)
      vs.w = w
      vs.h = h
      vs.ch = new Array(w * h).fill(' ')
      vs.fg = new Int32Array(w * h).fill(-1)
    }
    if (blocked(t)) continue
    const t0 = performance.now()
    dash.frame(now)
    const dt = performance.now() - t0
    costs += dt
    each.push(dt)
    maxCost = Math.max(maxCost, dt)
    frames++
    const out = vt.take()
    bytes += out.length
    vs.feed(out)
    // compare the replayed screen with the composed grid
    const snap = (dash as unknown as { grid: { ch: string[]; w: number; h: number } }).grid
    let bad = 0
    for (let i = 0; i < snap.ch.length; i++) if (snap.ch[i] !== vs.ch[i]) bad++
    if (bad) mismatches++
    for (const d of dumps) {
      if (d >= t && d < t + 50) {
        const tag = SCENARIO === 'linked' ? '' : `${SCENARIO}_`
        const lab = labels.get(d)
        const file = lab
          ? path.join(OUT, `${String(W)}x${H}_${lab}_${vt.cols()}x${vt.rows()}.ans`)
          : path.join(OUT, `${tag}${String(W)}x${H}_${String(d).padStart(5, '0')}ms_${vt.cols()}x${vt.rows()}.ans`)
        fs.writeFileSync(file, dash.snapshot(LEVEL).join('\n') + '\n')
      }
    }
  }
  if (STOP_AT > 0) {
    void dash.stop('0:00:46 · 160 jobs (160 train) · 158 verified · 1 failed · 22.43 GFLOP · 1,412.20 credits confirmed · 5.60 pending · +227.60 confirmed this session')
    fs.writeFileSync(path.join(OUT, `stop_${W}x${H}.txt`), vt.take())
  }
  if (argv.includes('--perf')) {
    const warm = each.slice(20).sort((a, b) => a - b)
    const q = (p: number) => warm[Math.min(warm.length - 1, Math.floor(p * warm.length))].toFixed(2)
    const mean = warm.reduce((a, b) => a + b, 0) / warm.length
    console.log(`${size} ${GLYPHS} (after 20 warm-up frames): n=${warm.length} mean ${mean.toFixed(2)} ms · p50 ${q(0.5)} · p95 ${q(0.95)} · p99 ${q(0.99)} · max ${warm[warm.length - 1].toFixed(2)} ms`)
  }
  console.log(
    `${size}: ${frames} frames · mean ${(costs / frames).toFixed(2)} ms · max ${maxCost.toFixed(1)} ms · ${(bytes / frames / 1024).toFixed(1)} KB/frame · replay mismatches ${mismatches}`,
  )
}

/** Named review moments for the scenario (frame times in ms). */
function moments(events: { at: number; e: NeuronEvent }[]): Map<number, string> {
  const m = new Map<number, string>()
  const after = (t: number, pred: (e: NeuronEvent) => boolean) => events.find((x) => x.at >= t && pred(x.e))?.at ?? -1
  const snap = (t: number) => Math.round(t / 50) * 50
  if (SCENARIO === 'linked') {
    m.set(300, 'boot1')
    m.set(1650, 'boot2')
    m.set(2700, 'boot3')
    const job = after(9000, (e) => e.t === 'job')
    if (job >= 0) m.set(snap(job + 250), 'pulse')
    const aud = after(12000, (e) => e.t === 'verdict' && e.status === 'audited')
    if (aud >= 0) m.set(snap(aud + 700), 'ripple')
    const esc = after(aud + 1000, (e) => e.t === 'escrow')
    if (esc >= 0) m.set(snap(esc + 200), 'escrow')
  } else if (SCENARIO === 'idle') m.set(8000, 'idle')
  else if (SCENARIO === 'nolink') m.set(9000, 'nolink')
  else if (SCENARIO === 'reconnect') {
    const rc = after(0, (e) => e.t === 'conn' && e.state === 'reconnecting')
    if (rc >= 0) m.set(snap(rc + 600), 'reconnecting')
  }
  return m
}

function live(): void {
  const ui = createUI({ mode: 'tui', color: !process.env.NO_COLOR, ascii: ASCII })
  const t0 = Date.now()
  // QA: record what the terminal sends on stdin (keys and reports), with timestamps
  const keylog = process.env.LUSCA_QA_KEYLOG
  if (keylog) process.stdin.on('data', (d) => fs.appendFileSync(keylog, `${Date.now() - t0} ${JSON.stringify(d.toString())}
`))
  for (const { at, e } of script()) setTimeout(() => ui.emit(e), at)
  const end = async (why: string) => {
    await ui.stop(`${why} · ${((Date.now() - t0) / 1000).toFixed(1)} s of scripted events (preview driver)`)
    process.exit(0)
  }
  process.on('SIGINT', () => void end('quit'))
  if (STOP_AT > 0) setTimeout(() => void end('stopped'), STOP_AT)
}

if (argv.includes('--live')) live()
else for (const s of SIZES) run(s)
