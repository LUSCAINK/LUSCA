// Minimal streaming tar reader: POSIX ustar + pax (x / g) + GNU long names (L / K).
// Bodies are buffered only for entries the caller asks for, up to a size limit; everything
// else is skipped as it streams past, so a whole archive is never held in memory.

export type TarEntryType = 'file' | 'dir' | 'symlink' | 'link' | 'other'

export interface TarEntry {
  /** Full path inside the archive (pax `path` / GNU long name / ustar prefix + name). */
  path: string
  type: TarEntryType
  size: number
  linkPath: string
}

export interface TarHandlers {
  /** Return true to receive the body of this entry (files only; bodies larger than `maxBody` are never buffered). */
  want(entry: TarEntry): boolean
  /** Called with the full body of a wanted entry. Awaited: back-pressure flows to the source. */
  file(entry: TarEntry, body: Buffer): void | Promise<void>
  /** Called for every pax global header (git archive puts the commit id in `comment`). */
  global?(records: Record<string, string>): void
}

export class TarError extends Error {}

const BLOCK = 512
const META_MAX = 1 << 20 // pax / long-name bodies above 1 MB are refused
/** Entry sizes above this are treated as a corrupt header (no source file comes close). */
export const MAX_ENTRY_SIZE = 16 * 1024 * 1024 * 1024

function cstr(buf: Buffer, off: number, len: number): string {
  let end = off
  const stop = off + len
  while (end < stop && buf[end] !== 0) end++
  return buf.toString('utf8', off, end)
}

function octal(buf: Buffer, off: number, len: number): number {
  // GNU base-256: high bit of the first byte set (sizes ≥ 8 GiB).
  if (buf[off] & 0x80) {
    if (buf[off] === 0xff) throw new TarError('negative base-256 field')
    let v = buf[off] & 0x7f
    for (let i = 1; i < len; i++) v = v * 256 + buf[off + i]
    return v
  }
  const s = cstr(buf, off, len).trim()
  if (!s) return 0
  if (!/^[0-7]+$/.test(s)) throw new TarError(`bad octal field "${s.slice(0, 16)}"`)
  return parseInt(s, 8)
}

function checksumOk(h: Buffer): boolean {
  const stored = octal(h, 148, 8)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]
  return sum === stored
}

/** Parse pax extended header records: "<len> <key>=<value>\n" repeated. */
export function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < body.length) {
    const sp = body.indexOf(0x20, i)
    if (sp < 0) break
    const len = parseInt(body.toString('ascii', i, sp), 10)
    if (!Number.isFinite(len) || len <= 0 || i + len > body.length) break
    const rec = body.toString('utf8', sp + 1, i + len - 1) // drop the trailing \n
    const eq = rec.indexOf('=')
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
    i += len
  }
  return out
}

function typeOf(flag: string): TarEntryType {
  switch (flag) {
    case '0':
    case '\0':
    case '':
    case '7': // contiguous file
      return 'file'
    case '5':
      return 'dir'
    case '2':
      return 'symlink'
    case '1':
      return 'link'
    default:
      return 'other'
  }
}

/**
 * Read a tar stream (already decompressed). Resolves at the end-of-archive marker or the end of
 * the stream; rejects on a corrupt header. `maxBody` caps buffered bodies (larger wanted entries are skipped).
 */
export async function readTar(src: AsyncIterable<Buffer | Uint8Array> | Iterable<Buffer | Uint8Array>, h: TarHandlers, maxBody = 1 << 20): Promise<void> {
  let pending: Buffer = Buffer.alloc(0)

  // header-level state
  let paxLocal: Record<string, string> = {}
  let longName: string | null = null
  let longLink: string | null = null

  // body state
  type Body =
    | { kind: 'skip'; left: number; pad: number }
    | { kind: 'meta'; flag: string; buf: Buffer; got: number; pad: number }
    | { kind: 'file'; entry: TarEntry; buf: Buffer; got: number; pad: number }
  let body: Body | null = null
  let zeroBlocks = 0
  let ended = false

  const startEntry = (hdr: Buffer) => {
    if (!checksumOk(hdr)) throw new TarError('header checksum mismatch')
    const flag = String.fromCharCode(hdr[156])
    let size = octal(hdr, 124, 12)
    if (!Number.isSafeInteger(size) || size > MAX_ENTRY_SIZE) throw new TarError(`entry size out of range (${size})`)
    const pad = (BLOCK - (size % BLOCK)) % BLOCK

    if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
      if (size > META_MAX) throw new TarError(`metadata entry too large (${size} B)`)
      body = { kind: 'meta', flag, buf: Buffer.alloc(size), got: 0, pad }
      return
    }

    const magic = hdr.toString('ascii', 257, 262)
    const name = cstr(hdr, 0, 100)
    const prefix = magic === 'ustar' ? cstr(hdr, 345, 155) : ''
    const path = paxLocal.path ?? longName ?? (prefix ? `${prefix}/${name}` : name)
    const linkPath = paxLocal.linkpath ?? longLink ?? cstr(hdr, 157, 100)
    if (paxLocal.size !== undefined) {
      if (!/^\d{1,15}$/.test(paxLocal.size)) throw new TarError(`bad pax size "${paxLocal.size.slice(0, 16)}"`)
      size = parseInt(paxLocal.size, 10)
      if (size > MAX_ENTRY_SIZE) throw new TarError(`entry size out of range (${size})`)
    }
    const realPad = (BLOCK - (size % BLOCK)) % BLOCK
    paxLocal = {}
    longName = null
    longLink = null

    const entry: TarEntry = { path, type: typeOf(flag), size, linkPath }
    if (entry.type === 'file' && h.want(entry) && size <= maxBody) {
      body = { kind: 'file', entry, buf: Buffer.alloc(size), got: 0, pad: realPad }
    } else {
      // dirs / links carry no body; a file we do not want is skipped as it streams by
      body = size > 0 || realPad > 0 ? { kind: 'skip', left: size, pad: realPad } : null
    }
  }

  const finishMeta = (flag: string, buf: Buffer) => {
    if (flag === 'x') paxLocal = parsePax(buf)
    else if (flag === 'g') h.global?.(parsePax(buf))
    else if (flag === 'L') longName = cstr(buf, 0, buf.length)
    else if (flag === 'K') longLink = cstr(buf, 0, buf.length)
  }

  for await (const raw of src) {
    if (ended) break
    let chunk: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
    if (pending.length) {
      chunk = Buffer.concat([pending, chunk])
      pending = Buffer.alloc(0)
    }
    let off = 0
    while (off < chunk.length && !ended) {
      const b = body as Body | null
      if (b === null) {
        if (chunk.length - off < BLOCK) {
          pending = Buffer.from(chunk.subarray(off)) // copy: the source may reuse its buffer
          off = chunk.length
          break
        }
        const hdr = chunk.subarray(off, off + BLOCK)
        off += BLOCK
        if (hdr.every((x) => x === 0)) {
          if (++zeroBlocks >= 2) ended = true
          continue
        }
        zeroBlocks = 0
        startEntry(hdr)
        continue
      }
      if (b.kind === 'skip') {
        const n = Math.min(b.left + b.pad, chunk.length - off)
        off += n
        if (n >= b.left) {
          b.pad -= n - b.left
          b.left = 0
        } else b.left -= n
        if (b.left === 0 && b.pad === 0) body = null
        continue
      }
      // meta / file: fill the buffer, then drop the padding
      const want = b.buf.length - b.got
      if (want > 0) {
        const n = Math.min(want, chunk.length - off)
        chunk.copy(b.buf, b.got, off, off + n)
        b.got += n
        off += n
        if (b.got < b.buf.length) continue
      }
      if (b.pad > 0) {
        const n = Math.min(b.pad, chunk.length - off)
        b.pad -= n
        off += n
        if (b.pad > 0) continue
      }
      body = null
      if (b.kind === 'meta') finishMeta(b.flag, b.buf)
      else await h.file(b.entry, b.buf)
    }
  }
  if (!ended) {
    const b = body as Body | null
    if (b !== null) {
      // A finished body whose padding sits at the very end still counts; anything else is truncated.
      const done = b.kind === 'skip' ? b.left === 0 : b.got === b.buf.length
      if (!done) throw new TarError('archive truncated')
      if (b.kind === 'file') await h.file(b.entry, b.buf)
    }
  }
}

// ─── writer (tests only) ─────────────────────────────────────────────────────

function header(name: string, size: number, flag: string, prefix = '', linkName = ''): Buffer {
  const h = Buffer.alloc(BLOCK)
  h.write(name, 0, 100, 'utf8')
  h.write('0000644\0', 100, 'ascii')
  h.write('0000000\0', 108, 'ascii')
  h.write('0000000\0', 116, 'ascii')
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  h.write('00000000000\0', 136, 'ascii')
  h.write('        ', 148, 'ascii')
  h.write(flag, 156, 'ascii')
  h.write(linkName, 157, 100, 'utf8')
  h.write('ustar\0', 257, 'ascii')
  h.write('00', 263, 'ascii')
  h.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += h[i]
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return h
}

function padTo(buf: Buffer): Buffer {
  const pad = (BLOCK - (buf.length % BLOCK)) % BLOCK
  return pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf
}

function paxBody(records: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(records)) {
    const tail = ` ${k}=${v}\n`
    let len = Buffer.byteLength(tail) + 1
    while (String(len).length + Buffer.byteLength(tail) !== len) len = String(len).length + Buffer.byteLength(tail)
    parts.push(Buffer.from(`${len}${tail}`))
  }
  return Buffer.concat(parts)
}

export interface TarWriteEntry {
  path: string
  body?: string | Buffer
  type?: 'file' | 'dir' | 'symlink' | 'link' | 'char' | 'fifo'
  linkPath?: string
  /** How to encode a long path: pax (default), gnu (L entry) or ustar prefix split. */
  longMode?: 'pax' | 'gnu' | 'prefix'
}

/** Build an uncompressed tar archive (used by tests to fake codeload archives). */
export function writeTar(entries: TarWriteEntry[], globalPax?: Record<string, string>): Buffer {
  const out: Buffer[] = []
  if (globalPax) {
    const b = paxBody(globalPax)
    out.push(header('pax_global_header', b.length, 'g'), padTo(b))
  }
  for (const e of entries) {
    const type = e.type ?? 'file'
    const data = type === 'file' || (type === 'link' && e.body !== undefined) ? (Buffer.isBuffer(e.body) ? e.body : Buffer.from(e.body ?? '', 'utf8')) : Buffer.alloc(0)
    const flag = { file: '0', link: '1', symlink: '2', char: '3', dir: '5', fifo: '6' }[type]
    let name = e.path
    let prefix = ''
    if (Buffer.byteLength(e.path) > 100) {
      const mode = e.longMode ?? 'pax'
      if (mode === 'pax') {
        const b = paxBody({ path: e.path })
        out.push(header('PaxHeader/long', b.length, 'x'), padTo(b))
        name = e.path.slice(0, 99)
      } else if (mode === 'gnu') {
        const b = Buffer.from(e.path + '\0', 'utf8')
        out.push(header('././@LongLink', b.length, 'L'), padTo(b))
        name = e.path.slice(0, 99)
      } else {
        const cut = e.path.lastIndexOf('/', 155)
        prefix = e.path.slice(0, cut)
        name = e.path.slice(cut + 1)
      }
    }
    out.push(header(name, data.length, flag, prefix, e.linkPath ?? ''))
    if (data.length) out.push(padTo(data))
  }
  out.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(out)
}
