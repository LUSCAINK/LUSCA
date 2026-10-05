// Append-only INK issuance log and the salted hashing used for every identifier the
// coordinator writes to it or publishes.
//
// <dataDir>/issuance.log holds one JSON line per INK credit (and per ledger-account
// eviction), so a per-job history exists for later sybil filtering and audits. Lines are
// buffered in memory and appended asynchronously about once a second; the server never
// reads the file back. Once the next append would push it past the size limit
// (LUSCA_ISSUANCE_LOG_MB) the file is renamed to issuance-<UTC stamp>.log and gzipped in the
// background; the newest `keep` archives are kept (LUSCA_ISSUANCE_LOG_KEEP, 0 = keep all).
//
// IPs, device ids and ledger keys are never logged or published in the clear: they are
// HMAC-SHA256'd under a per-install secret (LUSCA_HASH_SALT, else <dataDir>/hash.salt,
// created on first start), so hashes stay linkable across restarts but cannot be reversed
// by brute-forcing the small IPv4 space.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { createHmac, randomBytes } from 'node:crypto'

type LogFn = (level: 'info' | 'warn' | 'error', msg: string) => void

export interface IssuanceLog {
  /** Queue one record (serialized as a JSON line). Never throws, never blocks on disk. */
  write(rec: Record<string, unknown>): void
  /** Append everything queued so far (resolves once it is on disk or has failed). */
  flush(): Promise<void>
  /** Last-chance synchronous append on process exit. */
  flushSync(): void
  /** Flush, stop the timer and wait for background compression. Later writes are dropped. */
  close(): Promise<void>
  readonly file: string
}

const FLUSH_MS = 1_000
const MAX_BUFFER_BYTES = 4 * 1024 * 1024 // lines held while the disk is slow or failing
const ROTATE_RETRY_MS = 60_000
export const ISSUANCE_ARCHIVE_RE = /^issuance-\d{8}T\d{9}Z(?:-\d+)?\.log(?:\.gz)?$/

function errMsg(e: unknown): string {
  return (e as Error)?.message ?? String(e)
}

/**
 * @param maxBytes rotate once the live file would exceed this size; 0 disables the log entirely
 * @param keep     archives to keep (0 = keep every archive)
 */
export function createIssuanceLog(dir: string, maxBytes: number, keep: number, log: LogFn): IssuanceLog {
  const file = path.join(dir, 'issuance.log')
  const enabled = maxBytes > 0
  let buf: string[] = []
  let bufBytes = 0
  let size: number | null = null // live file size, stat'ed lazily on the first append
  let writing: Promise<void> | null = null
  let timer: NodeJS.Timeout | null = null
  let closed = false
  let failures = 0
  let dropped = 0
  let rotateBlockedUntil = 0
  let lastStamp = ''
  let stampDup = 0
  let background: Promise<void> = Promise.resolve()

  function arm() {
    if (timer || closed || !buf.length) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, FLUSH_MS)
    timer.unref?.()
  }

  function write(rec: Record<string, unknown>) {
    if (!enabled || closed) return
    let line: string
    try {
      line = `${JSON.stringify(rec)}\n`
    } catch {
      return
    }
    if (bufBytes + line.length > MAX_BUFFER_BYTES) {
      if (dropped++ % 1000 === 0) log('error', `issuance log buffer full — ${dropped} record(s) dropped so far`)
      return
    }
    buf.push(line)
    bufBytes += line.length
    arm()
  }

  function stamp(): string {
    const s = new Date().toISOString().replace(/[-:.]/g, '') // 20261005T101500123Z
    if (s === lastStamp) return `${s}-${++stampDup}`
    lastStamp = s
    stampDup = 0
    return s
  }

  async function compress(src: string) {
    const gz = `${src}.gz`
    const tmp = `${gz}.tmp`
    try {
      await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp))
      await fs.promises.rename(tmp, gz)
      await fs.promises.rm(src, { force: true })
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
      log('warn', `issuance log: gzip of ${path.basename(src)} failed (kept uncompressed): ${errMsg(e)}`)
    }
  }

  async function prune() {
    if (keep <= 0) return
    const names = (await fs.promises.readdir(dir)).filter((n) => ISSUANCE_ARCHIVE_RE.test(n))
    // A .log and its .log.gz are one archive (compression in flight or failed). Oldest first.
    const order = (b: string) => {
      const m = /^issuance-(\d{8}T\d{9}Z)(?:-(\d+))?\.log$/.exec(b)
      return m ? `${m[1]}-${(m[2] ?? '0').padStart(6, '0')}` : b
    }
    const bases = [...new Set(names.map((n) => n.replace(/\.gz$/, '')))].sort((x, y) => (order(x) < order(y) ? -1 : order(x) > order(y) ? 1 : 0))
    for (const b of bases.slice(0, Math.max(0, bases.length - keep))) {
      await fs.promises.rm(path.join(dir, b), { force: true })
      await fs.promises.rm(path.join(dir, `${b}.gz`), { force: true })
    }
  }

  async function rotate() {
    const archive = path.join(dir, `issuance-${stamp()}.log`)
    await fs.promises.rename(file, archive)
    size = 0
    log('info', `issuance log rotated → ${path.basename(archive)}`)
    // One compress + prune at a time, in rotation order (never prune a file being gzipped).
    background = background
      .then(() => compress(archive))
      .then(prune)
      .catch((e) => log('warn', `issuance log: pruning archives failed: ${errMsg(e)}`))
  }

  function flush(): Promise<void> {
    if (writing) return writing.then(() => (buf.length ? flush() : undefined))
    if (!buf.length) return Promise.resolve()
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const chunk = buf.join('')
    buf = []
    bufBytes = 0
    writing = (async () => {
      try {
        await fs.promises.mkdir(dir, { recursive: true })
        if (size === null) size = await fs.promises.stat(file).then((s) => s.size, () => 0)
        const n = Buffer.byteLength(chunk)
        if (size > 0 && size + n > maxBytes && Date.now() >= rotateBlockedUntil) {
          try {
            await rotate()
          } catch (e) {
            // Keep appending to the current file rather than losing records; retry later.
            rotateBlockedUntil = Date.now() + ROTATE_RETRY_MS
            log('warn', `issuance log rotation failed (retry in ${ROTATE_RETRY_MS / 1000} s): ${errMsg(e)}`)
          }
        }
        await fs.promises.appendFile(file, chunk, 'utf8')
        size += n
        failures = 0
      } catch (e) {
        size = null // re-stat on the next attempt
        if (chunk.length + bufBytes <= MAX_BUFFER_BYTES) {
          buf.unshift(chunk)
          bufBytes += chunk.length
        } else dropped += chunk.split('\n').length - 1
        if (failures++ % 60 === 0) log('error', `issuance log append failed: ${errMsg(e)}`)
      } finally {
        writing = null
        arm()
      }
    })()
    return writing
  }

  function flushSync() {
    if (!buf.length) return
    const chunk = buf.join('')
    buf = []
    bufBytes = 0
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(file, chunk, 'utf8')
      if (size !== null) size += Buffer.byteLength(chunk)
    } catch (e) {
      log('error', `issuance log flush failed: ${errMsg(e)}`)
    }
  }

  async function close() {
    if (timer) clearTimeout(timer)
    timer = null
    for (let i = 0; i < 3 && (buf.length || writing); i++) await flush()
    closed = true
    if (timer) clearTimeout(timer)
    timer = null
    await background
  }

  return { write, flush, flushSync, close, file }
}

/**
 * Per-install secret for identifier hashing: LUSCA_HASH_SALT when set, else the content of
 * <dataDir>/hash.salt, created (0600) with 32 random bytes on first start. If the file cannot
 * be written the salt lives in memory only, and hashes change on the next restart.
 */
export function loadHashSalt(dataDir: string, envSalt: string | undefined, log: LogFn): Buffer {
  const fromEnv = envSalt?.trim()
  if (fromEnv) return Buffer.from(fromEnv, 'utf8')
  const file = path.join(dataDir, 'hash.salt')
  const read = (): Buffer | null => {
    try {
      const s = fs.readFileSync(file, 'utf8').trim()
      return s ? Buffer.from(s, 'utf8') : null
    } catch {
      return null
    }
  }
  const existing = read()
  if (existing) return existing
  const fresh = randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(file, `${fresh}\n`, { mode: 0o600, flag: 'wx' })
  } catch (e) {
    const raced = read()
    if (raced) return raced
    log('warn', `could not persist ${file} (${errMsg(e)}): hashed ids in the issuance log will change after a restart`)
  }
  return Buffer.from(fresh, 'utf8')
}

/** Keyed hash of an identifier (64 bits as 16 hex chars). `scope` separates uses of the same value. */
export function hashId(salt: Buffer, scope: string, value: string): string {
  return createHmac('sha256', salt).update(`${scope}\u0000${value}`).digest('hex').slice(0, 16)
}
