// The radar's own daily slice of every budget it touches, persisted write-ahead (<data>/radar/budget.json):
// a block of calls is written (fsync + rename) before the calls in it are made, so a hard kill can
// never lose a charged call and the restored count is never lower than the last one shown. A share
// per clock hour keeps a burst (a deploy wave, a backfill) from spending the day in an hour.

import fs from 'node:fs'
import path from 'node:path'
import { BudgetError, type BudgetKey } from '../chain/rpc.ts'

const DAY = 86_400_000
const HOUR = 3_600_000
/** Calls reserved on disk ahead of use. */
const RESERVE = 16

/** A BudgetError (the chain readers stop a read on it the same way), naming the radar's slice. */
export class RadarBudgetError extends BudgetError {
  constructor(
    readonly radarKey: string,
    readonly why: 'day' | 'hour',
  ) {
    super(radarKey as BudgetKey)
    this.message = why === 'day' ? `radar ${radarKey} budget for today used up` : `radar ${radarKey} share for this hour used up`
  }
}

export function writeFileDurable(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

export interface RadarBudget {
  /** Why `n` more calls of `key` cannot be made now ('day' / 'hour'), or null. */
  why(key: string, n?: number): 'day' | 'hour' | null
  can(key: string, n?: number): boolean
  /** Charge `n` calls (throws RadarBudgetError without charging when they do not fit). */
  charge(key: string, n?: number): void
  usage(): Record<string, { used: number; limit: number }>
  limit(key: string): number
  flush(): void
}

export function createRadarBudget(limits: Record<string, number>, file: string | null, now: () => number = Date.now, hourShare = 0.15): RadarBudget {
  let day = Math.floor(now() / DAY)
  let hour = Math.floor(now() / HOUR)
  let used: Record<string, number> = {}
  let hourUsed: Record<string, number> = {}
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { day?: number; used?: Record<string, number> }
      if (j.day === day && j.used) for (const [k, v] of Object.entries(j.used)) if (k in limits && Number.isFinite(v) && v > 0) used[k] = Math.floor(v)
    } catch {
      /* first day */
    }
  }
  let onDisk: Record<string, number> = { ...used }
  let dirty = false
  const hourCap = (k: string) => Math.max(1, Math.ceil((limits[k] ?? 0) * hourShare))
  const write = (v: Record<string, number>) => {
    if (!file) return
    writeFileDurable(file, JSON.stringify({ day, used: v }))
    onDisk = { ...v }
  }
  const roll = () => {
    const d = Math.floor(now() / DAY)
    if (d !== day) {
      day = d
      used = {}
      onDisk = {}
      dirty = true
    }
    const h = Math.floor(now() / HOUR)
    if (h !== hour) {
      hour = h
      hourUsed = {}
    }
  }
  const why = (k: string, n = 1): 'day' | 'hour' | null => {
    roll()
    const lim = limits[k] ?? 0
    if ((used[k] ?? 0) + n > lim) return 'day'
    if ((hourUsed[k] ?? 0) + n > hourCap(k)) return 'hour'
    return null
  }
  return {
    why,
    can: (k, n = 1) => why(k, n) === null,
    charge(k, n = 1) {
      const w = why(k, n)
      if (w) throw new RadarBudgetError(k, w)
      const next = (used[k] ?? 0) + n
      if (next > (onDisk[k] ?? 0)) write({ ...used, ...onDisk, [k]: Math.min(limits[k] ?? next, next + RESERVE - 1) })
      used[k] = next
      hourUsed[k] = (hourUsed[k] ?? 0) + n
      dirty = true
    },
    usage() {
      roll()
      const out: Record<string, { used: number; limit: number }> = {}
      for (const k of Object.keys(limits)) if (limits[k] > 0) out[k] = { used: used[k] ?? 0, limit: limits[k] }
      return out
    },
    limit: (k) => limits[k] ?? 0,
    flush() {
      if (!dirty) return
      dirty = false
      try {
        write({ ...used })
      } catch {
        dirty = true
      }
    },
  }
}
