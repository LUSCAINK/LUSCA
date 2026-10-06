// Dev tool (not bundled): renders the octopus alone at a size, glyph mode and time, with optional
// events, to ANSI text for video/qa/tui/review/_wt.py.
//
//   npx tsx scripts/neuron-tui/_octo.ts --size 59x29 --glyphs octant --t 6 [--pulse 2.2:1] [--ripple 3] [--flash 3]
//                                        [--offline] [--labels] [--out dir] [--name x] [--bench]

import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { BrailleCanvas } from './canvas.ts'
import type { GlyphMode } from './canvas.ts'
import { createOctopus } from './octopus.ts'
import { setColorLevel } from './theme.ts'

const argv = process.argv.slice(2)
const opt = (n: string, d: string) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const [cols, rows] = opt('--size', '59x29').split('x').map(Number)
const glyphs = opt('--glyphs', 'octant') as GlyphMode
const T = Number(opt('--t', '6'))
const OUT = path.resolve(opt('--out', path.join(process.cwd(), '..', 'video', 'qa', 'tui', 'review', 'octo')))
const name = opt('--name', `octo_${glyphs}_${cols}x${rows}_t${T}`)
fs.mkdirSync(OUT, { recursive: true })
const evs: { at: number; kind: string; arg: number }[] = []
for (const k of ['--pulse', '--ripple', '--flash', '--inward']) {
  argv.forEach((a, i) => {
    if (a === k) {
      const [at, arg] = argv[i + 1].split(':').map(Number)
      evs.push({ at, kind: k, arg: arg ?? 1 })
    }
  })
}
evs.sort((a, b) => a.at - b.at)
setColorLevel('truecolor')
const c = new BrailleCanvas(cols, rows, { glyphs })
const o = createOctopus()
let ei = 0
let cost = 0
let n = 0
for (let t = 0; t <= T + 1e-9; t += 0.05) {
  while (ei < evs.length && evs[ei].at <= t + 1e-9) {
    const e = evs[ei++]
    if (e.kind === '--pulse') o.pulse(e.arg)
    else if (e.kind === '--inward') o.pulse(e.arg, true)
    else if (e.kind === '--ripple') o.ripple(e.arg)
    else o.flash()
  }
  const t0 = performance.now()
  c.clear()
  o.draw(c, t * 1000, { load: 0.3, connected: !argv.includes('--offline'), paused: false, labels: argv.includes('--labels') })
  const r = c.rows()
  cost += performance.now() - t0
  n++
  if (t + 0.05 > T + 1e-9) fs.writeFileSync(path.join(OUT, `${name}_${cols}x${rows}.ans`), r.join('\n') + '\n')
}
if (argv.includes('--bench')) console.log(`${cols}x${rows} ${glyphs}: ${(cost / n).toFixed(2)} ms/frame`)
console.log(path.join(OUT, `${name}_${cols}x${rows}.ans`))
