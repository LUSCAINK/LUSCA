// One repository archive → gzip JSONL shards (in a temp directory; the caller commits them).
//
// Record per kept file: {repo, ecosystem, category, commit, path, lang, license, tier, bytes, sha256, text}.
// `license` is the file's own SPDX header, else the nearest LICENSE file above it, else the repository
// license; `tier` is its display tier. Nothing is dropped for its license.
// Streams the tar, buffers one file at a time (≤ 200 KB; ≤ 640 KB for the files an entry names in
// `largeFiles`), yields to the event loop between files.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import type { LicenseTier } from '../../shared/codebase.ts'
import type { RepoSpec } from './repos.ts'
import { readTar, type TarEntry } from './tar.ts'
import { MAX_FILE_BYTES, bodyLimit, contentReject, decodeText, fileLimit, langOf, licenseDirInScope, pathInScope, type Lang } from './filters.ts'
import {
  combineLicenseFiles,
  detectLicenseExpr,
  exprTier,
  forbidsMachineLearning,
  isLicenseFile,
  isReadme,
  resolveRepoLicense,
  spdxHeader,
  type LicenseFileFound,
} from './licenses.ts'

export interface CodeRecord {
  repo: string
  ecosystem: string
  category: string
  commit: string | null
  path: string
  lang: Lang
  /** SPDX expression that applies to this file ("NOASSERTION" / "none" when unknown). */
  license: string
  tier: LicenseTier
  bytes: number
  sha256: string
  text: string
}

/**
 * Room kept under the size cap for what gzip still buffers when the cap is checked (it is written
 * only when the shard is closed): 0.5 % of the cap, at most 64 KB. Kept smaller than the index's own
 * slack (1 %, at most 1 MB), so a repository that stopped at the cap reads as within it on restart.
 */
export function capTail(capBytes: number): number {
  return Math.min(64 * 1024, Math.floor(capBytes / 200))
}

/** Dedupe key: first 16 bytes of the sha256, base64url (22 chars). */
export function dedupeKey(sha256hex: string): string {
  return Buffer.from(sha256hex.slice(0, 32), 'hex').toString('base64url')
}

// ─── shard writer ───────────────────────────────────────────────────────────

export class ShardWriter {
  readonly files: string[] = []
  private gz: zlib.Gzip | null = null
  private out: fs.WriteStream | null = null
  private done: Promise<void> | null = null
  private err: Error | null = null
  private n = 0
  private closedBytes = 0
  private curBytes = 0

  constructor(
    private dir: string,
    private base: string,
    private maxShardBytes: number,
  ) {}

  /** Compressed bytes produced so far (lags the input by gzip's internal buffer). */
  get compressed(): number {
    return this.closedBytes + this.curBytes
  }

  private open() {
    const file = path.join(this.dir, `${this.base}.${this.n++}.jsonl.gz`)
    const out = fs.createWriteStream(file)
    const gz = zlib.createGzip({ level: 9 })
    gz.on('data', (c: Buffer) => {
      this.curBytes += c.length
    })
    gz.pipe(out)
    const fail = (e: Error) => {
      this.err ??= e
    }
    gz.on('error', fail)
    out.on('error', fail)
    this.done = finished(out).catch(fail)
    this.gz = gz
    this.out = out
    this.files.push(file)
  }

  async write(line: string): Promise<void> {
    if (this.err) throw this.err
    if (!this.gz) this.open()
    const gz = this.gz!
    if (!gz.write(line)) {
      await Promise.race([once(gz, 'drain'), this.done!.then(() => undefined)])
      if (this.err) throw this.err
    }
    if (this.curBytes >= this.maxShardBytes) await this.finishCurrent()
  }

  private async finishCurrent() {
    const gz = this.gz
    if (!gz) return
    this.gz = null
    this.out = null
    gz.end()
    await this.done
    this.done = null
    this.closedBytes += this.curBytes
    this.curBytes = 0
    if (this.err) throw this.err
  }

  async close(): Promise<string[]> {
    await this.finishCurrent()
    return this.files
  }

  async abort(): Promise<void> {
    const gz = this.gz
    const out = this.out
    this.gz = null
    this.out = null
    if (gz) {
      // destroying the gzip stream does not end the file it pipes into: close that too
      gz.unpipe()
      gz.destroy()
      out?.destroy()
      await this.done?.catch(() => undefined)
      this.done = null
    }
    for (const f of this.files) await fs.promises.rm(f, { force: true }).catch(() => undefined)
  }
}

/** Read records back from a gzip JSONL shard. */
export async function* readShard(file: string): AsyncGenerator<CodeRecord> {
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity })
  for await (const line of rl) if (line) yield JSON.parse(line) as CodeRecord
}

// ─── one archive ────────────────────────────────────────────────────────────

export interface IndexInput {
  spec: RepoSpec
  /** Commit resolved before the download (null → read from the archive's pax header). */
  commit: string | null
  /** Global dedupe keys of every other committed repository (read only here). */
  seen: ReadonlySet<string>
  tmpDir: string
  base: string
  /** Total compressed cap and what other repositories already hold. */
  capBytes: number
  otherBytes: number
  maxShardBytes?: number
  signal?: AbortSignal
}

export interface IndexOutput {
  commit: string | null
  files: number
  bytes: number
  gzBytes: number
  shards: string[]
  keys: string[]
  byLang: Record<string, number>
  /** Kept files per license tier. */
  byTier: Record<string, number>
  /** License recorded for the repository (root LICENSE file at this commit, else the allowlist entry). */
  license: string
  /** Set when the LICENSE file disagrees with the allowlist entry. */
  licenseNote?: string
  /** Set when a root LICENSE / README forbids machine-learning use: nothing is kept (no shards). */
  forbidden: string | null
  capped: boolean
  skipped: Record<string, number>
}

interface Kept {
  path: string
  key: string
  lang: string
  bytes: number
  license: string
  /** The license came from the file's own SPDX header (never relabelled). */
  own: boolean
}

class MlForbidden extends Error {}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r))

/**
 * Index one archive stream. Writes shards into `tmpDir`; on any error they are removed and the
 * error rethrown.
 */
export async function indexArchive(tar: AsyncIterable<Buffer> | Iterable<Buffer>, inp: IndexInput): Promise<IndexOutput> {
  const { spec } = inp
  const maxShard = inp.maxShardBytes ?? 16 * 1048576
  const writer = new ShardWriter(inp.tmpDir, inp.base, maxShard)
  let commit = inp.commit
  let root: string | null = null
  const rootFiles: LicenseFileFound[] = []
  /** directory (relative) → license files found in it */
  const nested = new Map<string, LicenseFileFound[]>()
  // Repository license as known so far. Root license files sort early in git archives (upper-case
  // names), so a guess is rarely wrong; files written under a wrong guess are relabelled at the end.
  let repoLicense = resolveRepoLicense(spec.license, []).license
  const kept: Kept[] = []
  const localKeys = new Set<string>()
  const skipped: Record<string, number> = {}
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1
  }
  let capped = false
  const tail = capTail(inp.capBytes)

  const relOf = (p: string): string | null => {
    const clean = p.replace(/^\.\//, '')
    const slash = clean.indexOf('/')
    const top = slash < 0 ? clean : clean.slice(0, slash)
    if (root === null) root = top
    if (!top || top !== root) return null // not under the archive root: ignore
    const rel = slash < 0 ? '' : clean.slice(slash + 1)
    // control characters and backslashes never belong in a source path
    // oxlint-disable-next-line no-control-regex
    if (!rel || /[\x00-\x1f\x7f\\]/.test(rel)) return null
    if (rel.split('/').some((s) => s === '..' || s === '.' || s === '')) return null
    return rel
  }

  /** License of the nearest directory above `rel` that holds a LICENSE file (not the root), or null. */
  const dirLicense = (rel: string): string | null => {
    if (!nested.size) return null
    const segs = rel.split('/')
    for (let i = segs.length - 1; i >= 1; i--) {
      const files = nested.get(segs.slice(0, i).join('/'))
      if (files) return combineLicenseFiles(files)
    }
    return null
  }

  try {
    await readTar(
      tar,
      {
        global(rec) {
          if (!commit && rec.comment && /^[0-9a-f]{40}$/.test(rec.comment)) commit = rec.comment
        },
        want(e: TarEntry) {
          if (inp.signal?.aborted) throw inp.signal.reason instanceof Error ? inp.signal.reason : new Error('aborted')
          const rel = relOf(e.path)
          if (rel === null) return false
          const slash = rel.lastIndexOf('/')
          const base = rel.slice(slash + 1)
          if (isLicenseFile(base)) return e.size <= MAX_FILE_BYTES && licenseDirInScope(slash < 0 ? '' : rel.slice(0, slash), spec)
          if (slash < 0 && isReadme(base)) return e.size <= MAX_FILE_BYTES // checked for an ML prohibition
          if (capped) return false
          if (!pathInScope(rel, spec)) return false
          if (!langOf(rel, spec)) return false
          if (e.size > fileLimit(rel, spec)) {
            skip('too-large')
            return false
          }
          return true
        },
        async file(e: TarEntry, body: Buffer) {
          const rel = relOf(e.path)!
          const slash = rel.lastIndexOf('/')
          const base = rel.slice(slash + 1)
          if (isLicenseFile(base)) {
            const text = body.toString('utf8')
            const found: LicenseFileFound = { name: base, expr: detectLicenseExpr(text) }
            if (slash < 0) {
              rootFiles.push(found)
              repoLicense = resolveRepoLicense(spec.license, rootFiles).license
              const ml = forbidsMachineLearning(text)
              if (ml) throw new MlForbidden(`${base} forbids machine-learning use: "${ml}"`)
            } else {
              const dir = rel.slice(0, slash)
              nested.set(dir, [...(nested.get(dir) ?? []), found])
            }
            return
          }
          const text = decodeText(body)
          if (slash < 0 && isReadme(base)) {
            const ml = text === null ? null : forbidsMachineLearning(text)
            if (ml) throw new MlForbidden(`${base} forbids machine-learning use: "${ml}"`)
            if (capped || !pathInScope(rel, spec) || !langOf(rel, spec)) return // checked only
          }
          const lang = langOf(rel, spec)!
          if (text === null) return skip('binary')
          const bad = contentReject(text, lang)
          if (bad) return skip(bad)

          const header = spdxHeader(text)
          const license = header ?? dirLicense(rel) ?? repoLicense
          const bytes = Buffer.byteLength(text)
          const sha256 = crypto.createHash('sha256').update(text).digest('hex')
          const key = dedupeKey(sha256)
          if (inp.seen.has(key) || localKeys.has(key)) return skip('duplicate')

          const rec: CodeRecord = {
            repo: spec.repo,
            ecosystem: spec.ecosystem,
            category: spec.category,
            commit,
            path: rel,
            lang,
            license,
            tier: exprTier(license),
            bytes,
            sha256,
            text,
          }
          const line = JSON.stringify(rec) + '\n'
          // gzip's buffer lags the count (assume ~1/3 of the line is still to come out) and holds a tail
          // that only close() writes: keep room for both, so the final size stays under the cap
          if (inp.otherBytes + writer.compressed + Math.ceil(line.length / 3) + tail > inp.capBytes) {
            capped = true
            return skip('cap')
          }
          await writer.write(line)
          localKeys.add(key)
          kept.push({ path: rel, key, lang, bytes, license, own: header !== null })
          await yieldLoop()
        },
      },
      bodyLimit(spec),
    )
    let shards = await writer.close()

    // Final licenses: the root license files and every nested LICENSE are known now. Files without
    // their own SPDX header that were written with an earlier guess are relabelled.
    const final = resolveRepoLicense(spec.license, rootFiles)
    const change = new Map<string, string>()
    for (const k of kept) {
      if (k.own) continue
      const want = dirLicense(k.path) ?? final.license
      if (want !== k.license) change.set(k.path, want)
    }
    if (change.size) {
      const rewrite = new ShardWriter(inp.tmpDir, `${inp.base}.r`, maxShard)
      try {
        for (const f of shards) {
          for await (const rec of readShard(f)) {
            const lic = change.get(rec.path)
            if (lic !== undefined) {
              rec.license = lic
              rec.tier = exprTier(lic)
            }
            await rewrite.write(JSON.stringify(rec) + '\n')
          }
          await yieldLoop()
        }
        const out = await rewrite.close()
        for (const f of shards) await fs.promises.rm(f, { force: true })
        shards = out
      } catch (e) {
        await rewrite.abort()
        throw e
      }
      for (const k of kept) {
        const lic = change.get(k.path)
        if (lic !== undefined) k.license = lic
      }
    }

    const byLang: Record<string, number> = {}
    const byTier: Record<string, number> = {}
    let bytes = 0
    for (const k of kept) {
      byLang[k.lang] = (byLang[k.lang] ?? 0) + k.bytes
      const tier = exprTier(k.license)
      byTier[tier] = (byTier[tier] ?? 0) + 1
      bytes += k.bytes
    }
    let gzBytes = 0
    for (const f of shards) gzBytes += (await fs.promises.stat(f)).size
    if (!kept.length) {
      for (const f of shards) await fs.promises.rm(f, { force: true })
      shards = []
      gzBytes = 0
    }
    return {
      commit,
      files: kept.length,
      bytes,
      gzBytes,
      shards,
      keys: kept.map((k) => k.key),
      byLang,
      byTier,
      license: final.license,
      ...(final.note ? { licenseNote: final.note } : {}),
      forbidden: null,
      capped,
      skipped,
    }
  } catch (e) {
    await writer.abort()
    if (e instanceof MlForbidden) {
      return {
        commit,
        files: 0,
        bytes: 0,
        gzBytes: 0,
        shards: [],
        keys: [],
        byLang: {},
        byTier: {},
        license: resolveRepoLicense(spec.license, rootFiles).license,
        forbidden: e.message,
        capped: false,
        skipped,
      }
    }
    throw e
  }
}
