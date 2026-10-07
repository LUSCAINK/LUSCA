// Radar storage under <data>/radar, all durable (fsync; whole files through tmp + fsync + rename):
//
//   events.jsonl     every version of every event, appended (fsync per flush); the last line of an id
//                    wins; compacted to the newest `cap` events (tmp + fsync + rename) when it grows
//   snapshots.json   what the radar last read of each program / proxy / implementation (bounded, LRU)
//   state.json       EVM block cursors, the Solana gap checks' cursor, backfill status, unattributed count
//   budget.json      the radar's budget slice (server/radar/budget.ts)
//
// A torn last line (a kill mid-append) is skipped on load.

import fs from 'node:fs'
import path from 'node:path'
import type { RadarEvent } from '../../shared/radar.ts'
import type { Snapshot } from './diff.ts'
import { writeFileDurable } from './budget.ts'

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

export interface EventLog {
  load(): RadarEvent[]
  /** Queue one event version for the next flush. */
  append(ev: RadarEvent): void
  /** Write queued versions (append + fsync); compacts when the file has grown past twice the cap. */
  flush(current: () => RadarEvent[]): void
}

export function createEventLog(file: string, cap: number, log: Log): EventLog {
  let queue: string[] = []
  let lines = 0
  return {
    load() {
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        return []
      }
      const byId = new Map<string, RadarEvent>()
      let bad = 0
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        lines++
        try {
          const e = JSON.parse(line) as RadarEvent
          if (e && typeof e.id === 'string' && typeof e.ts === 'number' && typeof e.chain === 'string') {
            byId.delete(e.id)
            byId.set(e.id, e)
          } else bad++
        } catch {
          bad++
        }
      }
      if (bad) log('warn', `radar events.jsonl: ${bad} unreadable line(s) skipped`)
      return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, cap)
    },
    append(ev) {
      queue.push(JSON.stringify(ev))
    },
    flush(current) {
      if (!queue.length) return
      const batch = queue
      queue = []
      try {
        if (lines + batch.length > cap * 2 + Math.min(200, cap)) {
          const all = current()
          writeFileDurable(file, all.map((e) => JSON.stringify(e)).join('\n') + (all.length ? '\n' : ''))
          lines = all.length
          return
        }
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const fd = fs.openSync(file, 'a')
        try {
          fs.writeSync(fd, batch.join('\n') + '\n')
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
        lines += batch.length
      } catch (e) {
        queue = batch.concat(queue)
        log('warn', `radar events save failed: ${(e as Error).message}`)
      }
    },
  }
}

export interface SnapshotStore {
  get(key: string): Snapshot | null
  put(key: string, s: Snapshot): void
  /** Program id of a Solana programdata address the radar knows. */
  programOfData(pd: string): string | null
  setProgramData(pd: string, program: string): void
  size(): number
  flush(force?: boolean): void
}

export function createSnapshotStore(file: string, cap: number, log: Log, now: () => number = Date.now): SnapshotStore {
  const map = new Map<string, Snapshot>()
  const pd = new Map<string, string>()
  let dirty = false
  let savedAt = 0
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { items?: [string, Snapshot][]; pd?: [string, string][] }
    for (const [k, v] of j.items ?? []) if (typeof k === 'string' && v && typeof v === 'object') map.set(k, v)
    for (const [k, v] of j.pd ?? []) if (typeof k === 'string' && typeof v === 'string') pd.set(k, v)
  } catch {
    /* none yet */
  }
  return {
    get: (k) => {
      const v = map.get(k)
      if (!v) return null
      map.delete(k)
      map.set(k, v)
      return v
    },
    put(k, s) {
      map.delete(k)
      map.set(k, s)
      while (map.size > cap) map.delete(map.keys().next().value!)
      dirty = true
    },
    programOfData: (a) => pd.get(a) ?? null,
    setProgramData(a, program) {
      if (pd.get(a) === program) return
      pd.delete(a)
      pd.set(a, program)
      while (pd.size > cap) pd.delete(pd.keys().next().value!)
      dirty = true
    },
    size: () => map.size,
    flush(force = false) {
      if (!dirty || (!force && now() - savedAt < 20_000)) return
      try {
        writeFileDurable(file, JSON.stringify({ v: 1, items: [...map.entries()], pd: [...pd.entries()] }))
        dirty = false
        savedAt = now()
      } catch (e) {
        log('warn', `radar snapshots save failed: ${(e as Error).message}`)
      }
    },
  }
}

export interface RadarState {
  /** Last EVM block fully read, per chain. */
  cursors: Record<string, number>
  /** Newest loader signature the gap checks have covered (the next check reads from it). */
  solanaSig: string | null
  /** attempts: Solana's backfill runs once more when its very first call failed. */
  backfill: Record<string, { started: number; done: boolean; fromTs: number | null; events: number; note: string | null; attempts?: number }>
  /** "New authority" lines whose program could not be identified, on one UTC day. */
  unattributed?: { day: number; n: number }
}

export function loadState(file: string): RadarState {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RadarState>
    return {
      cursors: j.cursors && typeof j.cursors === 'object' ? j.cursors : {},
      solanaSig: typeof j.solanaSig === 'string' ? j.solanaSig : null,
      backfill: j.backfill && typeof j.backfill === 'object' ? j.backfill : {},
      ...(j.unattributed && Number.isFinite(j.unattributed.day) && Number.isFinite(j.unattributed.n) ? { unattributed: { day: j.unattributed.day, n: j.unattributed.n } } : {}),
    }
  } catch {
    return { cursors: {}, solanaSig: null, backfill: {} }
  }
}

export function saveState(file: string, s: RadarState, log: Log): void {
  try {
    writeFileDurable(file, JSON.stringify(s))
  } catch (e) {
    log('warn', `radar state save failed: ${(e as Error).message}`)
  }
}
