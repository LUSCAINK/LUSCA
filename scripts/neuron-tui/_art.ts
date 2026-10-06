// Dev tool for the neuron's terminal art (not bundled): renders octopus and logo frames at
// fixed times, prints a couple to stdout and writes every frame as an ANSI text file so it can
// be rasterised and inspected.
//
//   node scripts/neuron-tui/_art.ts [--out <dir>] [--quiet] [--bench]
//   (or: npx tsx scripts/neuron-tui/_art.ts)
//
// Default out dir: <workspace>/video/qa/tui/art. Time is simulated: each frame is the result of
// drawing every 50 ms from t=0, so motion state matches a live 20 fps run. Rasterise the .ans
// files with video/qa/tui/art/_render.py (Cascadia Mono on #050505; --uniform for terminals that
// draw braille as an even dot grid).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { BrailleCanvas } from './canvas.ts'
import { createOctopus } from './octopus.ts'
import type { Octopus, OctoState } from './octopus.ts'
import { logoMark, logoWidth } from './logo.ts'
import { setColorLevel } from './theme.ts'
import type { ColorLevel } from './theme.ts'

const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(n)
const opt = (n: string, d: string) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(opt('--out', path.join(HERE, '..', '..', '..', 'video', 'qa', 'tui', 'art')))
fs.mkdirSync(OUT, { recursive: true })

type Ev = { at: number; fn: (o: Octopus) => void }

function octoFrame(
  name: string,
  cols: number,
  rows: number,
  atSec: number,
  st: OctoState | ((t: number) => OctoState),
  events: Ev[] = [],
  opts: { ascii?: boolean; level?: ColorLevel } = {},
): string[] {
  setColorLevel(opts.level ?? 'truecolor')
  const c = new BrailleCanvas(cols, rows, { ascii: opts.ascii })
  const o = createOctopus()
  const evs = [...events].sort((a, b) => a.at - b.at)
  let ei = 0
  for (let t = 0; t <= atSec + 1e-9; t += 0.05) {
    while (ei < evs.length && evs[ei].at <= t + 1e-9) evs[ei++].fn(o)
    c.clear()
    o.draw(c, t * 1000, typeof st === 'function' ? st(t) : st)
  }
  const lines = c.rows()
  fs.writeFileSync(path.join(OUT, `${name}.ans`), lines.join('\n') + '\n')
  return lines
}

function logoFrame(name: string, cols: number, rows: number, h: number, progress: number, tSec: number, level: ColorLevel = 'truecolor'): string[] {
  setColorLevel(level)
  const c = new BrailleCanvas(cols, rows)
  const w = logoWidth(h)
  logoMark(c, Math.round((c.w - w) / 2), Math.round((c.h - h) / 2), h, progress, tSec * 1000)
  const lines = c.rows()
  fs.writeFileSync(path.join(OUT, `${name}.ans`), lines.join('\n') + '\n')
  return lines
}

const LIVE: OctoState = { load: 0.45, connected: true, paused: false }
const BUSY: OctoState = { load: 1, connected: true, paused: false }

const shown: string[][] = []
shown.push(octoFrame('octo_56x22_a', 56, 22, 2.0, LIVE))
octoFrame('octo_56x22_b', 56, 22, 6.5, LIVE)
octoFrame('octo_56x22_c', 56, 22, 11.0, BUSY)
octoFrame('octo_56x22_pulse', 56, 22, 3.3, BUSY, [
  { at: 2.9, fn: (o) => o.pulse(0) },
  { at: 3.0, fn: (o) => o.pulse(3) },
  { at: 3.05, fn: (o) => o.pulse(6, true) },
])
octoFrame('octo_56x22_ripple', 56, 22, 3.6, LIVE, [{ at: 3.0, fn: (o) => o.ripple(1) }])
octoFrame('octo_56x22_flash', 56, 22, 3.15, LIVE, [{ at: 3.0, fn: (o) => o.flash() }])
octoFrame('octo_56x22_offline', 56, 22, 6.0, { load: 0, connected: false, paused: false })
octoFrame('octo_56x22_paused', 56, 22, 6.0, { load: 0, connected: true, paused: true })
octoFrame('octo_56x22_ascii', 56, 22, 2.0, LIVE, [], { ascii: true })
octoFrame('octo_56x22_256', 56, 22, 2.0, LIVE, [], { level: '256' })
octoFrame('octo_100x40', 100, 40, 4.0, LIVE, [{ at: 3.7, fn: (o) => o.pulse(1) }])
octoFrame('octo_160x48', 160, 48, 4.0, LIVE, [{ at: 3.5, fn: (o) => o.ripple(1) }])
octoFrame('octo_36x14', 36, 14, 2.0, LIVE)
// a short strip for motion review
for (let i = 0; i < 6; i++) octoFrame(`octo_seq_${i}`, 56, 22, 8 + i * 0.4, LIVE)
// a pulse out along arm 2 and one back along arm 5, sampled through its flight
for (let i = 0; i < 6; i++)
  octoFrame(`octo_pulse_seq_${i}`, 56, 22, 5.0 + i * 0.13, LIVE, [
    { at: 5.0, fn: (o) => o.pulse(2) },
    { at: 5.0, fn: (o) => o.pulse(5, true) },
  ])
// escrow release: flash, then audit pass: ripple
for (let i = 0; i < 4; i++) octoFrame(`octo_flash_seq_${i}`, 56, 22, 5.0 + i * 0.2, LIVE, [{ at: 5.0, fn: (o) => o.flash() }])

for (const p of [0, 0.3, 0.55, 0.8, 1]) logoFrame(`logo_h40_p${Math.round(p * 100)}`, 40, 14, 40, p, 1 + p)
for (const p of [0.5, 1]) logoFrame(`logo_h16_p${Math.round(p * 100)}`, 16, 6, 16, p, 2)
shown.push(logoFrame('logo_h24_p100', 24, 8, 24, 1, 2))
logoFrame('logo_h24_p100_b', 24, 8, 24, 1, 4.2)
logoFrame('logo_h64_p100', 56, 20, 64, 1, 2.5)

if (!flag('--quiet')) {
  setColorLevel('truecolor')
  for (const f of shown) process.stdout.write(f.join('\n') + '\n\n')
}
process.stdout.write(`_art: wrote ${fs.readdirSync(OUT).filter((f) => f.endsWith('.ans')).length} frames to ${OUT}\n`)

if (flag('--bench')) {
  for (const [cols, rows] of [
    [56, 22],
    [120, 40],
    [200, 60],
  ]) {
    const c = new BrailleCanvas(cols, rows)
    const o = createOctopus()
    let drawMs = 0
    let rowsMs = 0
    const N = 200
    for (let i = 0; i < N; i++) {
      if (i % 20 === 0) o.pulse()
      if (i % 60 === 0) o.ripple()
      const t0 = performance.now()
      c.clear()
      o.draw(c, i * 50, BUSY)
      const t1 = performance.now()
      c.rows()
      rowsMs += performance.now() - t1
      drawMs += t1 - t0
    }
    process.stdout.write(`bench ${cols}×${rows}: draw ${(drawMs / N).toFixed(2)} ms · rows ${(rowsMs / N).toFixed(2)} ms per frame\n`)
  }
}
