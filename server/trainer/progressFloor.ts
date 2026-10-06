// Monotonic SEPIA-0 progress numbers across restarts, including a hard kill.
//
// sepia.ckpt is written every 90 s, so a crash used to roll the public step and the work
// counters (GPU steps, server steps, GPU samples) back by up to 90 s of training. This file
// keeps them in <dataDir>/progress.json (tmp file, fsync, rename, .bak copy):
//
//  - step: step numbers are reserved in small blocks before they are published, the way a
//    database sequence is. The trainer never publishes a step above the reservation, and a
//    restart resumes numbering at the reservation. After a hard kill at most one block of step
//    numbers is skipped (the weights resume from the checkpoint); no step number is shown
//    twice and the counter never goes down. A clean stop gives the unused block back.
//  - work counters: the published values are the persisted ones (written about 1 s after a
//    change), so whatever was shown survives a kill. At every worker (re)spawn the worker's
//    counters are raised to them.
//
// Audit counts have their own file (auditCounter.ts).

import fs from 'node:fs'
import path from 'node:path'

export interface ProgressCounts {
  gpuSteps: number
  serverSteps: number
  gpuSamples: number
  samplesSeen: number
}

export interface ProgressState extends ProgressCounts {
  /** Highest step number that may have been published (the reservation). */
  step: number
}

export interface ProgressFloor {
  /** What is on disk: the step reservation and the counters. */
  floor(): ProgressState
  /** Call before publishing `step`: extends the reservation (synchronous, durable) when needed. */
  reserveStep(step: number): void
  /** Record the worker's counters. Returns the counters that may be published (never above disk, never below it). */
  observe(c: ProgressCounts): ProgressCounts
  /** Clean stop with the final checkpoint at `step`: return the unused reservation, flush counters. */
  release(step: number): void
  flushSync(): void
}

export const STEP_BLOCK = 256 // step numbers reserved per write
const STEP_HEADROOM = 64 // extend the reservation when a step gets this close to it
const SAVE_MS = 1_000
const KEYS = ['gpuSteps', 'serverSteps', 'gpuSamples', 'samplesSeen'] as const

const cnt = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)

export function createProgressFloor(dataDir: string, log: (msg: string) => void = () => undefined): ProgressFloor {
  const file = path.join(dataDir, 'progress.json')
  let disk: ProgressState = { step: 0, gpuSteps: 0, serverSteps: 0, gpuSamples: 0, samplesSeen: 0 }
  // The main file is replaced by rename only, so when it parses it is the newest save (a clean stop
  // may have lowered its step below the .bak's). The .bak is read only when the main file is unusable.
  for (const f of [file, `${file}.bak`]) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as Partial<ProgressState>
      if (!raw || typeof raw !== 'object') throw new Error('not an object')
      disk = { step: cnt(raw.step), gpuSteps: cnt(raw.gpuSteps), serverSteps: cnt(raw.serverSteps), gpuSamples: cnt(raw.gpuSamples), samplesSeen: cnt(raw.samplesSeen) }
      break
    } catch {
      /* missing or torn: the .bak copy (or zeros) */
    }
  }
  let cur: ProgressState = { ...disk } // newest known values (counters may be ahead of disk)
  let failing = false // last write failed: publish live values rather than freezing them
  let timer: NodeJS.Timeout | null = null

  function write(next: ProgressState): boolean {
    const data = `${JSON.stringify({ ...next, at: Date.now() })}\n`
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      const fd = fs.openSync(tmp, 'w')
      try {
        fs.writeFileSync(fd, data, 'utf8')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      try {
        fs.copyFileSync(file, `${file}.bak`)
      } catch {
        /* first save */
      }
      fs.renameSync(tmp, file)
      disk = { ...next }
      if (failing) log('progress floor saves again')
      failing = false
      return true
    } catch (e) {
      if (!failing) log(`progress floor save failed: ${(e as Error).message}`)
      failing = true
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
      return false
    }
  }

  function countersChanged() {
    return KEYS.some((k) => cur[k] !== disk[k])
  }

  function flush() {
    if (timer) clearTimeout(timer)
    timer = null
    if (countersChanged() || cur.step !== disk.step) write({ ...cur, step: Math.max(cur.step, disk.step) })
  }

  function published(): ProgressCounts {
    const src = failing ? cur : disk
    return { gpuSteps: src.gpuSteps, serverSteps: src.serverSteps, gpuSamples: src.gpuSamples, samplesSeen: src.samplesSeen }
  }

  return {
    floor: () => ({ ...disk }),
    reserveStep(step) {
      const s = cnt(step)
      if (s + STEP_HEADROOM <= disk.step) return
      cur.step = Math.max(cur.step, s + STEP_BLOCK)
      if (timer) clearTimeout(timer)
      timer = null
      write({ ...cur })
    },
    observe(c) {
      let changed = false
      for (const k of KEYS) {
        const v = Math.max(cur[k], cnt(c[k]))
        if (v !== cur[k]) {
          cur[k] = v
          changed = true
        }
      }
      if (changed && !timer) {
        timer = setTimeout(() => {
          timer = null
          flush()
        }, SAVE_MS)
        timer.unref?.()
      }
      return published()
    },
    release(step) {
      // Every step published so far is <= the final checkpoint's step, so the reservation can drop to it.
      if (timer) clearTimeout(timer)
      timer = null
      write({ ...cur, step: cnt(step) })
      cur.step = disk.step
    },
    flushSync: flush,
  }
}
