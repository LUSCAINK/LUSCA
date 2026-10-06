// Tail of the web agents' dataset (<dataDir>/dataset.jsonl) from a persisted byte offset.
//
// The store appends whole lines and rotates by renaming dataset.jsonl to dataset-<stamp>.jsonl and
// starting a fresh file. The tail notices a rotation by file identity (inode), by the file being
// shorter than the offset, or by its first bytes changing; it then finishes the unread end of the
// renamed archive (found by inode, else by head fingerprint) and continues at byte 0 of the new
// file. Reads are bounded chunks; the offset only ever moves past complete lines, so a torn last
// line (writer mid-append) is read on a later step. A line longer than maxLineBytes is skipped.

import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface CorpusState {
  /** byte offset of the next unread line in the current file */
  offset: number
  /** inode of the file the offset belongs to ('' = unknown) */
  ino: string
  /** sha1 of the first headLen bytes of that file */
  head: string
  headLen: number
  /** an archive still being drained after a rotation (its offset), or null */
  drain: { path: string; ino: string; offset: number } | null
  lines: number
  bytes: number
  skipped: number
  rotations: number
}

export interface CorpusStep {
  bytes: number
  lines: number
  rotated: boolean
  /** nothing left to read right now */
  caughtUp: boolean
  /** bytes still unread in the current file */
  behind: number
}

export interface CorpusOptions {
  /** bytes read per step (default 1 MB) */
  chunkBytes?: number
  /** longest line accepted (default 8 MB) */
  maxLineBytes?: number
  /** first run with no saved state: start this many bytes before the end (0 = whole file, default) */
  backlogBytes?: number
  /** file name inside dir (default dataset.jsonl) */
  file?: string
}

const HEAD_BYTES = 4096
const ARCHIVE_RE = /^dataset-.*\.jsonl$/

export const emptyCorpusState = (): CorpusState => ({ offset: 0, ino: '', head: '', headLen: 0, drain: null, lines: 0, bytes: 0, skipped: 0, rotations: 0 })

export function sanitizeCorpusState(v: unknown): CorpusState | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Partial<CorpusState>
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0)
  const st: CorpusState = {
    offset: num(o.offset),
    ino: typeof o.ino === 'string' ? o.ino.slice(0, 64) : '',
    head: typeof o.head === 'string' ? o.head.slice(0, 64) : '',
    headLen: num(o.headLen),
    drain: null,
    lines: num(o.lines),
    bytes: num(o.bytes),
    skipped: num(o.skipped),
    rotations: num(o.rotations),
  }
  const d = o.drain as CorpusState['drain'] | undefined
  if (d && typeof d === 'object' && typeof d.path === 'string' && typeof d.ino === 'string') st.drain = { path: d.path.slice(0, 1024), ino: d.ino.slice(0, 64), offset: num(d.offset) }
  return st
}

async function fileId(path: string): Promise<{ ino: string; size: number } | null> {
  try {
    const s = await stat(path, { bigint: true })
    if (!s.isFile()) return null
    return { ino: s.ino.toString(), size: Number(s.size) }
  } catch {
    return null
  }
}

async function headHash(path: string, len: number): Promise<string | null> {
  if (len <= 0) return ''
  let fh
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, 0)
    if (bytesRead < len) return null
    return createHash('sha1').update(buf).digest('hex')
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

export class CorpusTail {
  readonly dir: string
  readonly path: string
  private st: CorpusState
  private readonly chunk: number
  private readonly maxLine: number
  private readonly backlog: number
  private fresh: boolean

  constructor(dir: string, state: CorpusState | null, opts: CorpusOptions = {}) {
    this.dir = dir
    this.path = join(dir, opts.file ?? 'dataset.jsonl')
    this.st = state ? { ...state } : emptyCorpusState()
    this.fresh = !state
    this.chunk = Math.max(4096, opts.chunkBytes ?? 1 << 20)
    this.maxLine = Math.max(this.chunk, opts.maxLineBytes ?? 8 << 20)
    this.backlog = Math.max(0, opts.backlogBytes ?? 0)
  }

  state(): CorpusState {
    return { ...this.st, drain: this.st.drain ? { ...this.st.drain } : null }
  }

  /** Read at most one chunk of complete lines, calling onLine for each. Never throws on I/O errors. */
  async step(onLine: (line: string) => void): Promise<CorpusStep> {
    const res: CorpusStep = { bytes: 0, lines: 0, rotated: false, caughtUp: false, behind: 0 }
    // 1. finish an archive left over from a rotation
    if (this.st.drain) {
      const d = this.st.drain
      const id = await fileId(d.path)
      if (!id || id.ino !== d.ino || d.offset >= id.size) {
        this.st.drain = null
      } else {
        const r = await this.readFrom(d.path, d.offset, id.size, onLine)
        d.offset = r.offset
        res.bytes += r.bytes
        res.lines += r.lines
        if (r.offset >= id.size || r.stuck) this.st.drain = null
        res.behind = id.size - d.offset
        return res
      }
    }
    // 2. the live file
    const id = await fileId(this.path)
    if (!id) {
      res.caughtUp = true
      return res
    }
    if (this.fresh) {
      this.fresh = false
      this.st.ino = id.ino
      this.st.offset = this.backlog > 0 ? Math.max(0, id.size - this.backlog) : 0
      this.st.headLen = 0
      this.st.head = ''
      if (this.st.offset > 0) this.st.offset = await this.nextLineStart(this.path, this.st.offset, id.size)
    } else if (await this.rotatedAway(id)) {
      res.rotated = true
      this.st.rotations++
      const archive = await this.findArchive()
      if (archive && archive.size > this.st.offset) this.st.drain = { path: archive.path, ino: archive.ino, offset: this.st.offset }
      this.st.ino = id.ino
      this.st.offset = 0
      this.st.headLen = 0
      this.st.head = ''
      if (this.st.drain) return res // drain first, next step
    }
    this.st.ino = id.ino
    if (this.st.offset >= id.size) {
      res.caughtUp = true
      await this.fixHead(id.size)
      return res
    }
    const r = await this.readFrom(this.path, this.st.offset, id.size, onLine)
    this.st.offset = r.offset
    res.bytes += r.bytes
    res.lines += r.lines
    res.behind = Math.max(0, id.size - this.st.offset)
    res.caughtUp = res.behind === 0 || r.stuck || r.eof === true
    await this.fixHead(id.size)
    return res
  }

  /** Remember the head fingerprint once the file is long enough (used to notice rotation). */
  private async fixHead(size: number) {
    const want = Math.min(HEAD_BYTES, size)
    if (want <= this.st.headLen) return
    const h = await headHash(this.path, want)
    if (h !== null) {
      this.st.head = h
      this.st.headLen = want
    }
  }

  private async rotatedAway(id: { ino: string; size: number }): Promise<boolean> {
    if (this.st.ino && id.ino !== this.st.ino && id.ino !== '0') return true
    if (id.size < this.st.offset) return true
    if (this.st.headLen > 0) {
      if (id.size < this.st.headLen) return true
      const h = await headHash(this.path, this.st.headLen)
      if (h !== null && h !== this.st.head) return true
    }
    return false
  }

  /** The archive the tracked file was renamed to: same inode, else same head fingerprint. */
  private async findArchive(): Promise<{ path: string; ino: string; size: number } | null> {
    let names: string[]
    try {
      names = (await readdir(this.dir)).filter((n) => ARCHIVE_RE.test(n)).sort().reverse().slice(0, 16)
    } catch {
      return null
    }
    let byHead: { path: string; ino: string; size: number } | null = null
    for (const n of names) {
      const p = join(this.dir, n)
      const id = await fileId(p)
      if (!id) continue
      if (this.st.ino && id.ino === this.st.ino && id.ino !== '0') return { path: p, ...id }
      if (!byHead && this.st.headLen > 0 && id.size >= this.st.headLen) {
        const h = await headHash(p, this.st.headLen)
        if (h === this.st.head) byHead = { path: p, ...id }
      }
    }
    return byHead
  }

  /** First line start at or after `pos` (pos itself when the byte before it is a newline). */
  private async nextLineStart(path: string, pos: number, size: number): Promise<number> {
    let fh
    try {
      fh = await open(path, 'r')
      const one = Buffer.alloc(1)
      await fh.read(one, 0, 1, pos - 1)
      if (one[0] === 0x0a) return pos
      const buf = Buffer.alloc(64 * 1024)
      let p = pos
      while (p < size) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, p)
        if (bytesRead <= 0) break
        const nl = buf.subarray(0, bytesRead).indexOf(0x0a)
        if (nl >= 0) return p + nl + 1
        p += bytesRead
      }
      return size
    } catch {
      return pos
    } finally {
      await fh?.close().catch(() => {})
    }
  }

  /**
   * Read complete lines starting at `offset` (≤ one chunk, or one long line ≤ maxLine).
   * stuck = the data at offset is an incomplete last line (wait for the writer); eof = the read reached the end.
   */
  private async readFrom(path: string, offset: number, size: number, onLine: (line: string) => void): Promise<{ offset: number; bytes: number; lines: number; stuck: boolean; eof?: boolean }> {
    let fh
    let lines = 0
    const emit = (line: string) => {
      try {
        onLine(line)
      } catch {
        this.st.skipped++ // a bad line never stalls the tail
      }
    }
    try {
      fh = await open(path, 'r')
      const want = Math.min(this.chunk, size - offset)
      let buf = Buffer.alloc(want)
      let { bytesRead } = await fh.read(buf, 0, want, offset)
      buf = buf.subarray(0, bytesRead)
      let lastNl = buf.lastIndexOf(0x0a)
      if (lastNl < 0) {
        // one line longer than a chunk (or a torn tail): look further for its end
        if (offset + bytesRead >= size) return { offset, bytes: 0, lines: 0, stuck: true }
        let p = offset + bytesRead
        const parts: Buffer[] = [buf]
        let total = bytesRead
        const scan = Buffer.alloc(Math.min(this.chunk, 1 << 20))
        for (;;) {
          if (p >= size) return { offset, bytes: 0, lines: 0, stuck: true }
          ;({ bytesRead } = await fh.read(scan, 0, scan.length, p))
          if (bytesRead <= 0) return { offset, bytes: 0, lines: 0, stuck: true }
          const part = scan.subarray(0, bytesRead)
          const nl = part.indexOf(0x0a)
          if (nl >= 0) {
            total += nl + 1
            if (total <= this.maxLine) {
              parts.push(Buffer.from(part.subarray(0, nl)))
              const line = Buffer.concat(parts).toString('utf8').replace(/\r$/, '')
              if (line) {
                emit(line)
                lines++
              }
            } else this.st.skipped++
            this.st.lines += lines
            this.st.bytes += total
            return { offset: offset + total, bytes: total, lines, stuck: false }
          }
          total += bytesRead
          p += bytesRead
          if (total <= this.maxLine) parts.push(Buffer.from(part))
          else parts.length = 0 // too long: keep scanning for its end, drop the bytes
        }
      }
      const body = buf.subarray(0, lastNl)
      let start = 0
      while (start <= body.length) {
        let nl = body.indexOf(0x0a, start)
        if (nl < 0) nl = body.length
        if (nl > start) {
          const line = body.toString('utf8', start, nl).replace(/\r$/, '')
          if (line) {
            emit(line)
            lines++
          }
        }
        start = nl + 1
      }
      const consumed = lastNl + 1
      this.st.lines += lines
      this.st.bytes += consumed
      // eof: the read reached the end of the file; what is left is an incomplete line
      return { offset: offset + consumed, bytes: consumed, lines, stuck: false, eof: offset + bytesRead >= size }
    } catch {
      return { offset, bytes: 0, lines, stuck: true }
    } finally {
      await fh?.close().catch(() => {})
    }
  }
}
