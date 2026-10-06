// Monotonic full-audit counters (model.train.audits in /api/health and the hello).
//
// The trainer worker counts audits in memory and only writes them into sepia.ckpt every 90 s, so
// a crash used to roll the published counts back by up to 90 s of audits. This file keeps the
// highest counts ever published in <dataDir>/audits.json (tmp file, fsync, rename; ~1 s after
// each change and synchronously on shutdown). At every worker (re)spawn the counts it restores
// from the checkpoint are raised to that floor, so the published numbers never go backwards
// after a restart, including a hard kill.

import fs from 'node:fs'
import path from 'node:path'

export interface AuditCounts {
  ok: number
  failed: number
}

export interface AuditCounter {
  /** Highest counts known (persisted floor). */
  floor(): AuditCounts
  /** Record counts reported by the worker; persists when they rise. Returns the published counts (never below the floor). */
  observe(c: AuditCounts): AuditCounts
  flushSync(): void
  stop(): void
}

const SAVE_MS = 1_000
const cnt = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)

export function createAuditCounter(dataDir: string, log: (msg: string) => void = () => undefined): AuditCounter {
  const file = path.join(dataDir, 'audits.json')
  let cur: AuditCounts = { ok: 0, failed: 0 }
  for (const f of [file, `${file}.bak`]) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as Partial<AuditCounts>
      cur = { ok: Math.max(cur.ok, cnt(raw.ok)), failed: Math.max(cur.failed, cnt(raw.failed)) }
    } catch {
      /* missing or torn: the other copy (or 0) */
    }
  }
  let saved = { ...cur }
  let timer: NodeJS.Timeout | null = null

  function write() {
    if (cur.ok === saved.ok && cur.failed === saved.failed) return
    const data = `${JSON.stringify({ ok: cur.ok, failed: cur.failed, at: Date.now() })}\n`
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
      saved = { ...cur }
    } catch (e) {
      log(`audit counter save failed: ${(e as Error).message}`)
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
    }
  }

  return {
    floor: () => ({ ...cur }),
    observe(c) {
      const ok = Math.max(cur.ok, cnt(c.ok))
      const failed = Math.max(cur.failed, cnt(c.failed))
      if (ok !== cur.ok || failed !== cur.failed) {
        cur = { ok, failed }
        if (!timer) {
          timer = setTimeout(() => {
            timer = null
            write()
          }, SAVE_MS)
          timer.unref?.()
        }
      }
      return { ...cur }
    },
    flushSync() {
      if (timer) clearTimeout(timer)
      timer = null
      write()
    },
    stop() {
      this.flushSync()
    },
  }
}
