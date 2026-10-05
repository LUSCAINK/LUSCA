// Dataset persistence: append-only JSONL (one accepted page per line) plus a
// tiny state file for counters that cannot be derived from the dataset.
//
// Rotation: when dataset.jsonl would grow past `maxBytes` it is renamed to
// dataset-<UTC stamp>.jsonl (an archive that is never read back) and a fresh
// dataset.jsonl is started. That bounds the start-up reload time and the dedupe
// sets rebuilt on restart (a busy crawl writes ~15 GB/day). The crawler carries
// the archived page / token totals forward in ingest-state.json so lifetime
// counters stay monotonic across restarts.
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { appendFile, readdir, rename, unlink, writeFile, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, join } from 'node:path'

/** One line of dataset.jsonl. Extra fields beyond the spec make reloads cheap. */
export interface DatasetLine {
  id: string
  url: string
  host: string
  title: string
  sector: number
  score: number
  tokens: number
  terms: string[]
  ts: number
  text: string
  // extras (optional so older/foreign lines still load)
  agentId?: number
  depth?: number
  bytes?: number
  links?: number
  simhash?: string
  hash?: string // sha1 of the cleaned text (exact-duplicate check)
  vec?: string // base64 Float32Array(VEC_DIM) from shared/vectorize.ts
  /** provenance: what the opt-out checks saw when the page was fetched (absent on older lines) */
  prov?: DatasetProvenance
}

export interface DatasetProvenance {
  /** HTTP status robots.txt was answered with for the page's origin (4xx = none, allow all) */
  robotsStatus: number | null
  /** robots.txt allowed LuscaBot to fetch the URL (always true for a stored page) */
  robotsAllowed: boolean
  /** a TDM reservation (TDMRep, noai, AI-crawler disallow) applied (always false for a stored page) */
  tdm: boolean
  /** Content-Signal ai-train value given for the page ('yes'), null when the site gave none */
  aiTrain: 'yes' | null
}

/** Page/token totals of the pages that live in rotated-out archives. */
export interface ArchivedTotals {
  pages: number
  tokens: number
  bytes: number
  sectorPages: number[]
  sectorTokens: number[]
  files: number
}

export interface PersistedState {
  rejected: number
  errors: number
  dupes: number
  semanticDups: string[]
  archived?: ArchivedTotals
}

export function emptyArchived(sectors: number): ArchivedTotals {
  return { pages: 0, tokens: 0, bytes: 0, sectorPages: new Array<number>(sectors).fill(0), sectorTokens: new Array<number>(sectors).fill(0), files: 0 }
}

export interface RotateInfo {
  archive: string
  /** totals of the pages in the archived file (pages the crawler counted) */
  totals: ArchivedTotals
}

export interface DatasetWriterOptions {
  /** rotate dataset.jsonl once it would exceed this many bytes (0 = never) */
  maxBytes?: number
  /** keep at most this many archives, deleting the oldest (0 = keep all) */
  keepArchives?: number
  /** number of sectors (for per-sector archived totals) */
  sectors?: number
  /** awaited after a successful rotation, before the next line is appended */
  onRotate?: (info: RotateInfo) => void | Promise<void>
}

// dataset-20261004T221500123Z.jsonl: millisecond UTC stamp, so name order is age order.
const ARCHIVE_RE = /^dataset-\d{8}T\d{9}Z\.jsonl$/
const archiveName = (ms: number) => `dataset-${new Date(ms).toISOString().replace(/[-:.]/g, '')}.jsonl`
const ROTATE_RETRY_MS = 60_000

export class DatasetWriter {
  readonly path: string
  private readonly dir: string
  private chain: Promise<void> = Promise.resolve()
  private failures = 0
  private size = 0
  private readonly maxBytes: number
  private readonly keepArchives: number
  private readonly sectors: number
  private readonly onRotate?: DatasetWriterOptions['onRotate']
  private rotateBlockedUntil = 0
  /** totals of the counted pages currently in dataset.jsonl */
  private file: ArchivedTotals

  constructor(dir: string, opts: DatasetWriterOptions = {}) {
    this.dir = dir
    this.path = join(dir, 'dataset.jsonl')
    const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
    this.maxBytes = pos(opts.maxBytes)
    this.keepArchives = pos(opts.keepArchives)
    this.sectors = Math.max(1, pos(opts.sectors) || 8)
    this.onRotate = opts.onRotate
    this.file = emptyArchived(this.sectors)
    try {
      this.size = statSync(this.path).size
    } catch {
      this.size = 0
    }
  }

  /** Account for a page that was already in dataset.jsonl at start-up (reload path). */
  noteExisting(p: { tokens: number; bytes?: number; sector: number }): void {
    this.count(p)
  }

  private count(p: { tokens: number; bytes?: number; sector: number }): void {
    const f = this.file
    const tokens = Number.isFinite(p.tokens) ? p.tokens : 0
    f.pages++
    f.tokens += tokens
    f.bytes += typeof p.bytes === 'number' && Number.isFinite(p.bytes) ? p.bytes : 0
    if (Number.isInteger(p.sector) && p.sector >= 0 && p.sector < this.sectors) {
      f.sectorPages[p.sector]++
      f.sectorTokens[p.sector] += tokens
    }
  }

  /** Serialized append (lines never interleave). Never rejects. */
  append(line: DatasetLine): Promise<void> {
    let json: string
    try {
      json = JSON.stringify(line) + '\n'
    } catch (e) {
      console.warn('[crawler] could not serialize dataset line', e)
      return this.chain
    }
    const bytes = Buffer.byteLength(json, 'utf8')
    this.chain = this.chain
      .then(async () => {
        if (this.maxBytes > 0 && this.size > 0 && this.size + bytes > this.maxBytes && Date.now() >= this.rotateBlockedUntil) {
          await this.rotate()
        }
        await appendFile(this.path, json, 'utf8')
        this.size += bytes
        this.count(line)
      })
      .catch((e) => {
        this.failures++
        if (this.failures <= 5) console.warn('[crawler] dataset append failed:', (e as Error)?.message ?? e)
      })
    return this.chain
  }

  /** Runs inside the append chain, so no append interleaves with the rename. Never throws. */
  private async rotate(): Promise<void> {
    let ms = Date.now()
    while (existsSync(join(this.dir, archiveName(ms)))) ms++ // never overwrite an archive
    const archive = join(this.dir, archiveName(ms))
    try {
      await rename(this.path, archive)
    } catch (e) {
      // e.g. EBUSY on Windows while another process holds the file: keep appending, retry later.
      this.rotateBlockedUntil = Date.now() + ROTATE_RETRY_MS
      console.warn(`[crawler] dataset rotation failed (retrying in ${ROTATE_RETRY_MS / 1000} s):`, (e as Error)?.message ?? e)
      return
    }
    const totals = this.file
    this.file = emptyArchived(this.sectors)
    this.size = 0
    console.log(`[crawler] dataset.jsonl rotated → ${basename(archive)} (${totals.pages.toLocaleString('en-US')} pages)`)
    try {
      await this.onRotate?.({ archive, totals })
    } catch (e) {
      console.warn('[crawler] rotation hook failed:', (e as Error)?.message ?? e)
    }
    if (this.keepArchives > 0) await this.pruneArchives()
  }

  private async pruneArchives(): Promise<void> {
    try {
      const names = (await readdir(this.dir)).filter((n) => ARCHIVE_RE.test(n)).sort()
      for (const n of names.slice(0, Math.max(0, names.length - this.keepArchives))) {
        await unlink(join(this.dir, n))
          .then(() => console.log(`[crawler] deleted old dataset archive ${n} (keeping ${this.keepArchives})`))
          .catch((e) => console.warn(`[crawler] could not delete archive ${n}:`, (e as Error)?.message ?? e))
      }
    } catch (e) {
      console.warn('[crawler] archive pruning failed:', (e as Error)?.message ?? e)
    }
  }

  flush(): Promise<void> {
    return this.chain
  }
}

export function ensureDir(dir: string): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch (e) {
    console.warn('[crawler] could not create data dir', dir, (e as Error)?.message ?? e)
  }
}

function isLine(x: unknown): x is DatasetLine {
  const o = x as DatasetLine
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.id === 'string' &&
    typeof o.url === 'string' &&
    typeof o.host === 'string' &&
    typeof o.text === 'string' &&
    typeof o.tokens === 'number' &&
    Number.isFinite(o.tokens)
  )
}

/**
 * Stream dataset.jsonl line by line. Corrupt lines (e.g. a torn final write after
 * a crash) are skipped and counted, never fatal.
 */
export async function loadDataset(path: string, onLine: (line: DatasetLine) => void): Promise<{ ok: number; bad: number }> {
  let ok = 0
  let bad = 0
  if (!existsSync(path)) return { ok, bad }
  const stream = createReadStream(path, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const raw of rl) {
      const s = raw.trim()
      if (!s) continue
      try {
        const obj: unknown = JSON.parse(s)
        if (!isLine(obj)) {
          bad++
          continue
        }
        onLine(obj)
        ok++
      } catch {
        bad++
      }
    }
  } catch (e) {
    console.warn('[crawler] dataset read failed:', (e as Error)?.message ?? e)
  } finally {
    rl.close()
    stream.destroy()
  }
  return { ok, bad }
}

function parseArchived(v: unknown): ArchivedTotals | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Partial<Record<keyof ArchivedTotals, unknown>>
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0)
  const arr = (x: unknown) => (Array.isArray(x) ? x.map(n) : [])
  return { pages: n(o.pages), tokens: n(o.tokens), bytes: n(o.bytes), sectorPages: arr(o.sectorPages), sectorTokens: arr(o.sectorTokens), files: n(o.files) }
}

export async function loadState(dir: string): Promise<PersistedState | null> {
  try {
    // Data dirs written before the rename hold the same state under its old file name.
    const raw = await readFile(join(dir, 'ingest-state.json'), 'utf8').catch(() => readFile(join(dir, 'crawler-state.json'), 'utf8'))
    const o = JSON.parse(raw) as Partial<PersistedState>
    return {
      rejected: Number(o.rejected) || 0,
      errors: Number(o.errors) || 0,
      dupes: Number(o.dupes) || 0,
      semanticDups: Array.isArray(o.semanticDups) ? o.semanticDups.filter((x) => typeof x === 'string') : [],
      archived: parseArchived(o.archived),
    }
  } catch {
    return null
  }
}

// Saves are serialized: the periodic saver, a rotation and stop() can overlap,
// and two writers racing on the same .tmp file fail on Windows (EPERM on rename).
let saveChain: Promise<void> = Promise.resolve()

/** Atomic write (tmp + rename), serialized. Never rejects. */
export function saveState(dir: string, st: PersistedState): Promise<void> {
  const file = join(dir, 'ingest-state.json')
  const tmp = file + '.tmp'
  let json: string
  try {
    json = JSON.stringify(st)
  } catch (e) {
    console.warn('[crawler] state serialize failed:', (e as Error)?.message ?? e)
    return saveChain
  }
  saveChain = saveChain.then(async () => {
    try {
      await writeFile(tmp, json, 'utf8')
      await rename(tmp, file)
    } catch (e) {
      console.warn('[crawler] state save failed:', (e as Error)?.message ?? e)
    }
  })
  return saveChain
}
