// Corpus export: an authenticated, pull-only API that lets the owner's PC copy what the server holds before
// it is rotated out. Nothing here writes to the data disk; the server's retention (LUSCA_DATASET_MAX_MB /
// LUSCA_DATASET_KEEP, chain and code caps) is unchanged.
//
//   GET|HEAD /api/export/manifest          every exportable artifact: path, kind, bytes, sha256, immutable, meta
//   GET|HEAD /api/export/file/<path>       one artifact: Content-Length, ETag "<sha256>", Range / If-Range
//                                          (single range), If-Match (412 when it changed since the manifest);
//                                          .jsonl / .json with Accept-Encoding: gzip and no Range → gzip on the
//                                          fly (no Content-Length; X-Content-Length and X-Content-SHA256 give the
//                                          plain bytes)
//
// Artifacts:
//   web/dataset-<stamp>.jsonl          rotated web-text archives (immutable; text and titles PII-redacted at
//                                      ingest, server/ingest/extract.ts redactPII). The active dataset.jsonl is
//                                      exported once it rotates.
//   code-index/<repo>.<gen>.<n>.jsonl.gz  protocol code index shards (immutable while listed) and
//   code-index/index.json              the index state (repo, commit, license per repository)
//   kept-code/…                        the chain agents' kept code, see kept.ts
//
// Auth: Authorization: Bearer <LUSCA_EXPORT_TOKEN> (≥ 32 characters; unset = the API answers 404). Compared in
// constant time (sha256 of both sides, timingSafeEqual). 10 failed attempts per address in 15 min lock that
// address out for the rest of the window. Limits: requests per address and overall per minute, concurrent
// downloads per address and overall, and one egress budget (LUSCA_EXPORT_MB_PER_SEC, default 4) shared by every
// download. Responses are Cache-Control: private, no-store (never cached at the edge).

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash, timingSafeEqual } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ARCHIVE_RE, ARCHIVES_FILE } from '../ingest/store.ts'
import {
  KEPT_KINDS,
  SHARD_RE,
  buildCurrent,
  buildRefs,
  buildShard,
  committedEnds,
  keptPath,
  pick,
  readKeptIndex,
  sha256Hex,
  type GzArtifact,
  type KeptIndex,
  type KeptKind,
  type Occurrence,
  type ShardBuild,
} from './kept.ts'

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

export const MIN_TOKEN_CHARS = 32
const MB = 1048576

export type ArtifactKind = 'web-text' | 'code-index' | 'code-index-state' | KeptKind | 'kept-refs' | 'kept-current'

/** One manifest row. */
export interface ArtifactInfo {
  path: string
  kind: ArtifactKind
  bytes: number
  sha256: string
  /** True when these bytes never change while the artifact is listed (rotated archives, sealed shards). */
  immutable: boolean
  contentType: string
  updatedAt: string
  /** Lines (JSONL artifacts built here). */
  records?: number
  /** Uncompressed JSONL bytes (gzip artifacts built here). */
  rawBytes?: number
  meta?: Record<string, unknown>
}

export interface ExportManifest {
  v: 1
  generatedAt: string
  /** False while hashes or kept-code builds are still running: listed rows are final, `pending` comes later. */
  complete: boolean
  pending: string[]
  retention: { datasetMaxMB: number; datasetKeep: number; note: string }
  totals: { artifacts: number; bytes: number; byKind: Record<string, { artifacts: number; bytes: number }> }
  artifacts: ArtifactInfo[]
}

export interface ExportOptions {
  dataDir: string
  /** LUSCA_EXPORT_TOKEN; null / shorter than 32 characters = export off (404). */
  token: string | null
  log: Log
  datasetMaxMB: number
  datasetKeep: number
  /** Egress budget shared by every download, MB/s (default 4). */
  mbPerSec?: number
  perIpPerMin?: number
  globalPerMin?: number
  maxStreams?: number
  maxStreamsPerIp?: number
  /** A manifest younger than this is served as is (default 60 s). */
  manifestTtlMs?: number
  /** How long a manifest request waits for a refresh before answering with what is ready (default 15 s). */
  manifestWaitMs?: number
  /** The open chain shard's artifacts are rebuilt at most this often (default 10 min). */
  openRebuildMs?: number
  /** Built kept-code artifacts kept in memory, bytes (default 32 MB). */
  lruBytes?: number
  /** First background refresh after start, ms (default 5 min; < 0 = none). */
  warmupMs?: number
  now?: () => number
}

export interface ExportApi {
  readonly enabled: boolean
  /** Answers every /api/export* request (p without trailing slash). */
  handle(req: IncomingMessage, res: ServerResponse, p: string, ip: string): Promise<void>
  /** The newest manifest after a full refresh (tests, tools). */
  manifest(): Promise<ExportManifest>
  stop(): void
}

// ─── small helpers ──────────────────────────────────────────────────────────

function limiter(windowMs: number, max: number, now: () => number) {
  const hits = new Map<string, number[]>()
  const live = (key: string) => {
    const t = now()
    const ts = (hits.get(key) ?? []).filter((x) => x > t - windowMs)
    if (ts.length) hits.set(key, ts)
    else hits.delete(key)
    return ts
  }
  return {
    check(key: string): number {
      const ts = live(key)
      return ts.length >= max ? ts[0] + windowMs - now() : 0
    },
    take(key: string): number {
      const ts = live(key)
      if (ts.length >= max) return ts[0] + windowMs - now()
      ts.push(now())
      hits.set(key, ts)
      return 0
    },
    sweep() {
      for (const k of [...hits.keys()]) live(k)
    },
  }
}

/** Egress budget shared by all downloads (debt-based token bucket). */
function bucket(bytesPerSec: number) {
  const burst = Math.max(256 * 1024, bytesPerSec)
  let tokens = burst
  let at = Date.now()
  return {
    /** ms to wait before sending n bytes (the bytes are charged now). */
    reserve(n: number): number {
      const t = Date.now()
      tokens = Math.min(burst, tokens + ((t - at) / 1000) * bytesPerSec)
      at = t
      tokens -= n
      return tokens >= 0 ? 0 : Math.ceil((-tokens / bytesPerSec) * 1000)
    },
  }
}

function throttle(b: ReturnType<typeof bucket>): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const wait = b.reserve(chunk.length)
      if (wait <= 0) cb(null, chunk)
      else setTimeout(() => cb(null, chunk), wait)
    },
  })
}

const isoOf = (ms: number) => new Date(ms).toISOString()
const contentTypeOf = (p: string) =>
  p.endsWith('.gz') ? 'application/gzip' : p.endsWith('.jsonl') ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8'

async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of fs.createReadStream(file, { highWaterMark: MB })) h.update(chunk as Buffer)
  return h.digest('hex')
}

/** Parses `Range: bytes=a-b | a- | -n` (one range) against `size`. null = no usable Range, 'bad' = 416. */
export function parseRange(h: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (!h) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null // multi-range or another unit: answer the whole thing
  let start: number
  let end: number
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0) return 'bad'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return 'bad'
  return { start, end }
}

/** A list of ETags in If-Match / If-None-Match contains `etag` (weak comparison). */
function etagListed(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false
  const v = Array.isArray(header) ? header.join(',') : header
  if (v.trim() === '*') return true
  const bare = etag.replace(/^W\//, '')
  return v.split(',').some((t) => t.trim().replace(/^W\//, '') === bare)
}

// ─── the service ────────────────────────────────────────────────────────────

type Source =
  | { type: 'file'; file: string; size: number; mtimeMs: number }
  | { type: 'mem'; data: Buffer[] }
  | { type: 'kept'; shard: string; end: number; kind: KeptKind }

interface Entry {
  art: ArtifactInfo
  src: Source
}

interface Snapshot {
  at: number
  complete: boolean
  manifest: ExportManifest
  json: string
  etag: string
  entries: Map<string, Entry>
}

interface KeptState {
  shard: string
  seq: string
  end: number
  sealed: boolean
  /** Fingerprint of the shards before this one (dedupe state). */
  prevKey: string
  builtAt: number
  arts: Record<KeptKind, Omit<GzArtifact, 'members'>>
  firstSeen: Set<string>
  occurrences: Occurrence[]
}

const PATH_RE = /^(web|code-index|kept-code)\/([A-Za-z0-9._-]{1,200})$/
const CODE_SHARD_RE = /^[A-Za-z0-9._-]+\.jsonl\.gz$/

export function createExport(o: ExportOptions): ExportApi {
  const now = o.now ?? Date.now
  const log = o.log
  const token = (o.token ?? '').trim()
  const enabled = token.length >= MIN_TOKEN_CHARS
  if (o.token && !enabled) log('warn', `LUSCA_EXPORT_TOKEN is shorter than ${MIN_TOKEN_CHARS} characters: the export API stays off`)
  const want = createHash('sha256').update(token).digest()
  const dataDir = o.dataDir
  const ttl = Math.max(0, o.manifestTtlMs ?? 60_000)
  const waitMs = Math.max(0, o.manifestWaitMs ?? 15_000)
  const openRebuildMs = Math.max(0, o.openRebuildMs ?? 10 * 60_000)
  const lruMax = Math.max(0, o.lruBytes ?? 32 * MB)
  const egress = bucket(Math.max(64 * 1024, Math.round((o.mbPerSec && o.mbPerSec > 0 ? o.mbPerSec : 4) * MB)))
  const perIp = limiter(60_000, Math.max(1, o.perIpPerMin ?? 300), now)
  const global = limiter(60_000, Math.max(1, o.globalPerMin ?? 900), now)
  const authFail = limiter(15 * 60_000, 10, now)
  const maxStreams = Math.max(1, o.maxStreams ?? 4)
  const maxStreamsPerIp = Math.max(1, o.maxStreamsPerIp ?? 2)
  const streams = new Map<string, number>()
  let streamsTotal = 0

  const hashes = new Map<string, string>() // `${file}\0${size}\0${mtimeMs}` → sha256
  const kept = new Map<string, KeptState>() // chain shard name → state
  let keptExtras: { key: string; refs: GzArtifact; current: GzArtifact; at: number } | null = null
  const lru = new Map<string, Buffer[]>() // `${path}@${sha256}` → members
  let lruBytes = 0
  let snap: Snapshot | null = null
  let refreshing: Promise<Snapshot> | null = null
  let buildLock: Promise<unknown> = Promise.resolve()
  let stopped = false

  const sweepTimer = setInterval(() => {
    perIp.sweep()
    global.sweep()
    authFail.sweep()
  }, 60_000)
  sweepTimer.unref?.()
  const warmup = enabled && (o.warmupMs ?? 5 * 60_000) >= 0 ? setTimeout(() => void refresh().catch(() => {}), o.warmupMs ?? 5 * 60_000) : null
  warmup?.unref?.()

  /** Serialize CPU-heavy builds (refresh and on-demand rebuilds never run side by side). */
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const p = buildLock.then(fn, fn)
    buildLock = p.catch(() => {})
    return p
  }

  function lruPut(key: string, members: Buffer[]) {
    const n = members.reduce((a, m) => a + m.length, 0)
    if (n > lruMax) return
    const old = lru.get(key)
    if (old) {
      lru.delete(key)
      lruBytes -= old.reduce((a, m) => a + m.length, 0)
    }
    lru.set(key, members)
    lruBytes += n
    while (lruBytes > lruMax && lru.size) {
      const [k, v] = lru.entries().next().value as [string, Buffer[]]
      lru.delete(k)
      lruBytes -= v.reduce((a, m) => a + m.length, 0)
    }
  }
  function lruGet(key: string): Buffer[] | null {
    const v = lru.get(key)
    if (!v) return null
    lru.delete(key)
    lru.set(key, v)
    return v
  }

  // ── listing ──

  function statQuiet(file: string): fs.Stats | null {
    try {
      const st = fs.statSync(file)
      return st.isFile() ? st : null
    } catch {
      return null
    }
  }

  async function fileEntry(file: string, art: Omit<ArtifactInfo, 'bytes' | 'sha256' | 'updatedAt' | 'contentType'>, work: boolean, pending: string[]): Promise<Entry | null> {
    const st = statQuiet(file)
    if (!st) return null
    const key = `${file}\0${st.size}\0${st.mtimeMs}`
    let sha = hashes.get(key)
    if (!sha && work) {
      try {
        sha = await hashFile(file)
        // the file may have been replaced while it was read: keep the hash only if it is still the same file
        const st2 = statQuiet(file)
        if (st2 && st2.size === st.size && st2.mtimeMs === st.mtimeMs) hashes.set(key, sha)
        else sha = undefined
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log('warn', `could not hash ${path.basename(file)}: ${(e as Error).message}`)
        sha = undefined
      }
    }
    if (!sha) {
      pending.push(art.path)
      return null
    }
    return {
      art: { ...art, bytes: st.size, sha256: sha, contentType: contentTypeOf(art.path), updatedAt: isoOf(st.mtimeMs) },
      src: { type: 'file', file, size: st.size, mtimeMs: st.mtimeMs },
    }
  }

  async function webEntries(work: boolean, pending: string[]): Promise<Entry[]> {
    let names: string[] = []
    try {
      names = fs.readdirSync(dataDir).filter((n) => ARCHIVE_RE.test(n)).sort()
    } catch {
      return []
    }
    let totals: Record<string, { pages?: number; tokens?: number }> = {}
    try {
      totals = JSON.parse(fs.readFileSync(path.join(dataDir, ARCHIVES_FILE), 'utf8')) as typeof totals
    } catch {
      totals = {}
    }
    const out: Entry[] = []
    for (const n of names) {
      const t = totals[n]
      const meta = t && typeof t === 'object' ? { pages: Number(t.pages) || 0, tokens: Number(t.tokens) || 0 } : { pages: null, tokens: null }
      const e = await fileEntry(path.join(dataDir, n), { path: `web/${n}`, kind: 'web-text', immutable: true, meta }, work, pending)
      if (e) out.push(e)
    }
    return out
  }

  async function codeEntries(work: boolean, pending: string[]): Promise<Entry[]> {
    const dir = path.join(dataDir, 'code')
    let buf: Buffer
    try {
      buf = fs.readFileSync(path.join(dir, 'index.json'))
    } catch {
      return []
    }
    let state: { repos?: Record<string, { repo?: string; commit?: string | null; license?: string | null; gen?: number; status?: string; fetchedAt?: number | null; shards?: unknown }> }
    try {
      state = JSON.parse(buf.toString('utf8'))
    } catch {
      return []
    }
    const out: Entry[] = []
    const st = statQuiet(path.join(dir, 'index.json'))
    out.push({
      art: {
        path: 'code-index/index.json',
        kind: 'code-index-state',
        bytes: buf.length,
        sha256: sha256Hex(buf),
        immutable: false,
        contentType: contentTypeOf('index.json'),
        updatedAt: isoOf(st?.mtimeMs ?? now()),
      },
      src: { type: 'mem', data: [buf] },
    })
    for (const r of Object.values(state.repos ?? {})) {
      if (!r || !Array.isArray(r.shards)) continue
      for (const s of r.shards) {
        if (typeof s !== 'string' || !CODE_SHARD_RE.test(s)) continue
        const meta = { repo: r.repo ?? null, commit: r.commit ?? null, license: r.license ?? null, gen: r.gen ?? null, fetchedAt: typeof r.fetchedAt === 'number' ? isoOf(r.fetchedAt) : null }
        const e = await fileEntry(path.join(dir, s), { path: `code-index/${s}`, kind: 'code-index', immutable: true, meta }, work, pending)
        if (e) out.push(e)
      }
    }
    return out
  }

  /** Earlier shards' first-seen sets, for dedupe while (re)building `shard`. */
  function seenBeforeOf(shard: string): (sha: string) => boolean {
    const sets = [...kept.values()].filter((k) => k.shard < shard).map((k) => k.firstSeen)
    return (sha) => sets.some((s) => s.has(sha))
  }

  async function runBuild(shard: string, end: number): Promise<ShardBuild> {
    const b = await buildShard(path.join(dataDir, 'chain', 'shards', shard), end, seenBeforeOf(shard))
    for (const kind of KEPT_KINDS) {
      const a = pick(b, kind)
      if (a.records) lruPut(`${keptPath(kind, b.seq)}@${a.sha256}`, a.members)
    }
    return b
  }

  async function keptEntries(work: boolean, pending: string[]): Promise<Entry[]> {
    const idx: KeptIndex | null = readKeptIndex(dataDir)
    if (!idx) return []
    const shardDir = path.join(dataDir, 'chain', 'shards')
    let names: string[] = []
    try {
      names = fs.readdirSync(shardDir).filter((n) => SHARD_RE.test(n)).sort()
    } catch {
      names = []
    }
    const ends = committedEnds(idx)
    const out: Entry[] = []
    let prevKey = ''
    let blocked = false // a shard could not be built: later ones depend on it
    const live = new Set<string>()
    for (const name of names) {
      // shards past the index's open shard hold nothing committed yet
      if (idx.open !== null && name > idx.open) continue
      const sealed = idx.open !== null && name < idx.open
      const st = statQuiet(path.join(shardDir, name))
      if (!st) continue
      const end = sealed ? st.size : Math.min(st.size, ends.get(name) ?? 0)
      if (end <= 0) continue
      live.add(name)
      let k = kept.get(name) ?? null
      const fresh = k && k.prevKey === prevKey && (k.end === end || (!sealed && k.end < end && now() - k.builtAt < openRebuildMs))
      if (!fresh) {
        if (!work || blocked) {
          blocked = true
          for (const kind of KEPT_KINDS) pending.push(keptPath(kind, SHARD_RE.exec(name)![1]))
          continue
        }
        try {
          const myPrev = prevKey
          const b = await locked(() => runBuild(name, end))
          k = {
            shard: name,
            seq: b.seq,
            end,
            sealed,
            prevKey: myPrev,
            builtAt: now(),
            arts: {
              'kept-files': { bytes: b.files.bytes, sha256: b.files.sha256, records: b.files.records, rawBytes: b.files.rawBytes },
              'kept-contracts': { bytes: b.contracts.bytes, sha256: b.contracts.sha256, records: b.contracts.records, rawBytes: b.contracts.rawBytes },
              'kept-idls': { bytes: b.idls.bytes, sha256: b.idls.sha256, records: b.idls.records, rawBytes: b.idls.rawBytes },
            },
            firstSeen: b.firstSeen,
            occurrences: b.occurrences,
          }
          kept.set(name, k)
        } catch (e) {
          log('warn', `kept-code shard ${name} could not be built: ${(e as Error).message}`)
          blocked = true
          for (const kind of KEPT_KINDS) pending.push(keptPath(kind, SHARD_RE.exec(name)![1]))
          continue
        }
      }
      if (!k) continue
      k.sealed = sealed
      prevKey = sha256Hex(`${prevKey}|${k.shard}:${k.end}`)
      for (const kind of KEPT_KINDS) {
        const a = k.arts[kind]
        if (!a.records) continue
        const p = keptPath(kind, k.seq)
        out.push({
          art: {
            path: p,
            kind,
            bytes: a.bytes,
            sha256: a.sha256,
            immutable: sealed,
            contentType: contentTypeOf(p),
            updatedAt: isoOf(k.builtAt),
            records: a.records,
            rawBytes: a.rawBytes,
            meta: { shard: k.shard, sealed, shardBytes: k.end },
          },
          src: { type: 'kept', shard: k.shard, end: k.end, kind },
        })
      }
    }
    for (const name of [...kept.keys()]) if (!live.has(name)) kept.delete(name)
    if (blocked) {
      pending.push('kept-code/refs.jsonl.gz', 'kept-code/current.jsonl.gz')
      return out
    }
    // refs + current: rebuilt when the builds or the index changed
    const extrasKey = sha256Hex(`${prevKey}|${idx.updatedAt}|${idx.items.length}`)
    if (!keptExtras || keptExtras.key !== extrasKey) {
      if (!work) {
        if (keptExtras) pushExtras(out, keptExtras)
        pending.push('kept-code/refs.jsonl.gz', 'kept-code/current.jsonl.gz')
        return out
      }
      const builds = [...kept.values()].sort((a, b) => (a.shard < b.shard ? -1 : 1))
      const refs = await locked(() => buildRefs(builds, idx))
      const current = await locked(() => buildCurrent(idx))
      keptExtras = { key: extrasKey, refs, current, at: now() }
    }
    pushExtras(out, keptExtras)
    return out
  }

  function pushExtras(out: Entry[], x: NonNullable<typeof keptExtras>) {
    for (const [p, kind, a] of [
      ['kept-code/refs.jsonl.gz', 'kept-refs', x.refs],
      ['kept-code/current.jsonl.gz', 'kept-current', x.current],
    ] as const) {
      out.push({
        art: { path: p, kind, bytes: a.bytes, sha256: a.sha256, immutable: false, contentType: contentTypeOf(p), updatedAt: isoOf(x.at), records: a.records, rawBytes: a.rawBytes },
        src: { type: 'mem', data: a.members },
      })
    }
  }

  async function assemble(work: boolean): Promise<Snapshot> {
    const pending: string[] = []
    const entries = [...(await webEntries(work, pending)), ...(await codeEntries(work, pending)), ...(await keptEntries(work, pending))]
    // forget hashes of files that are gone
    const liveFiles = new Set(entries.flatMap((e) => (e.src.type === 'file' ? [`${e.src.file}\0${e.src.size}\0${e.src.mtimeMs}`] : [])))
    if (work) for (const k of [...hashes.keys()]) if (!liveFiles.has(k)) hashes.delete(k)
    const byKind: Record<string, { artifacts: number; bytes: number }> = {}
    let bytes = 0
    for (const e of entries) {
      const k = (byKind[e.art.kind] ??= { artifacts: 0, bytes: 0 })
      k.artifacts++
      k.bytes += e.art.bytes
      bytes += e.art.bytes
    }
    const manifest: ExportManifest = {
      v: 1,
      generatedAt: isoOf(now()),
      complete: pending.length === 0,
      pending,
      retention: {
        datasetMaxMB: o.datasetMaxMB,
        datasetKeep: o.datasetKeep,
        note:
          o.datasetMaxMB > 0 && o.datasetKeep > 0
            ? `dataset.jsonl rotates at ${o.datasetMaxMB} MB and the ${o.datasetKeep} newest archives are kept: pull web/ archives before they are deleted`
            : 'web-text archives are not pruned on this server',
      },
      totals: { artifacts: entries.length, bytes, byKind },
      artifacts: entries.map((e) => e.art),
    }
    const json = JSON.stringify(manifest)
    // the ETag covers the content, not the time it was assembled
    const etag = `"${sha256Hex(JSON.stringify({ ...manifest, generatedAt: null }))}"`
    return { at: now(), complete: manifest.complete, manifest, json, etag, entries: new Map(entries.map((e) => [e.art.path, e])) }
  }

  /** Quick listing first (what is already hashed / built), then the full one. */
  function refresh(): Promise<Snapshot> {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        const quick = await assemble(false)
        if (!snap || !snap.complete || quick.complete) snap = quick
        if (quick.complete) return quick
        const t0 = now()
        const full = await assemble(true)
        snap = full
        const secs = ((now() - t0) / 1000).toFixed(1)
        log('info', `manifest: ${full.manifest.totals.artifacts} artifacts, ${(full.manifest.totals.bytes / MB).toFixed(1)} MB (${secs} s)`)
        return full
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  /** The manifest to answer with: a young one as is; else a refresh, waited for up to waitMs. */
  async function currentSnapshot(): Promise<Snapshot> {
    if (!refreshing && snap && now() - snap.at < ttl) return snap
    const r = refreshing ?? refresh()
    const timeout = new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), waitMs)
      t.unref?.()
    })
    const done = await Promise.race([r.catch(() => null), timeout])
    // the quick listing is published within moments of a refresh starting: answer with it rather than keep a
    // proxy waiting (Cloudflare gives up on an origin after 100 s)
    return done ?? snap ?? r
  }

  // ── responses ──

  function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    const body = JSON.stringify({ error: message })
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': Buffer.byteLength(body),
      ...headers,
    })
    res.end(body)
  }

  function authorized(req: IncomingMessage): boolean {
    const h = req.headers.authorization
    const m = typeof h === 'string' ? /^Bearer[ \t]+(\S{1,512})[ \t]*$/i.exec(h) : null
    // always hash and compare, so a missing header and a wrong token take the same path
    const got = createHash('sha256').update(m ? m[1] : '\0').digest()
    return timingSafeEqual(got, want) && !!m
  }

  async function sendManifest(req: IncomingMessage, res: ServerResponse) {
    const s = await currentSnapshot()
    const headers: Record<string, string> = { 'Cache-Control': 'private, no-store', ETag: s.etag, 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json; charset=utf-8' }
    if (etagListed(req.headers['if-none-match'], s.etag)) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    const ae = String(req.headers['accept-encoding'] ?? '')
    let body: Buffer = Buffer.from(s.json, 'utf8')
    if (/\bgzip\b/.test(ae) && body.length > 1024) {
      body = await new Promise<Buffer>((resolve, reject) => zlib.gzip(body, { level: 6 }, (e, b) => (e ? reject(e) : resolve(b))))
      headers['Content-Encoding'] = 'gzip'
      headers.Vary = 'Accept-Encoding'
    }
    res.writeHead(200, { ...headers, 'Content-Length': String(body.length) })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  /** The members of a kept-code artifact as listed (rebuilt when not in memory). */
  async function keptMembers(e: Entry & { src: { type: 'kept' } }): Promise<{ members: Buffer[]; sha256: string }> {
    const key = `${e.art.path}@${e.art.sha256}`
    const hit = lruGet(key)
    if (hit) return { members: hit, sha256: e.art.sha256 }
    const b = await locked(() => runBuild(e.src.shard, e.src.end))
    const a = pick(b, e.src.kind)
    if (a.sha256 !== e.art.sha256) log('warn', `${e.art.path} rebuilt with a different sha256 (${a.sha256.slice(0, 12)}… vs ${e.art.sha256.slice(0, 12)}…)`)
    return { members: a.members, sha256: a.sha256 }
  }

  async function* sliceMembers(members: Buffer[], start: number, end: number): AsyncGenerator<Buffer> {
    let pos = 0
    for (const m of members) {
      const mEnd = pos + m.length
      if (mEnd > start && pos <= end) {
        const from = Math.max(0, start - pos)
        const to = Math.min(m.length, end - pos + 1)
        for (let i = from; i < to; i += 64 * 1024) yield m.subarray(i, Math.min(to, i + 64 * 1024))
      }
      pos = mEnd
      if (pos > end) break
    }
  }

  async function sendFile(req: IncomingMessage, res: ServerResponse, rel: string, ip: string) {
    const s = await currentSnapshot()
    const e = s.entries.get(rel)
    if (!e) {
      const pend = s.manifest.pending.includes(rel)
      return sendError(res, pend ? 503 : 404, pend ? 'artifact is being prepared; try again shortly' : 'no such artifact', pend ? { 'Retry-After': '60' } : {})
    }
    let sha = e.art.sha256
    if (req.headers['if-match'] && !etagListed(req.headers['if-match'], `"${sha}"`)) return sendError(res, 412, 'artifact changed since that manifest')
    if (etagListed(req.headers['if-none-match'], `"${sha}"`)) {
      res.writeHead(304, { ETag: `"${sha}"`, 'Cache-Control': 'private, no-store' })
      res.end()
      return
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Type': e.art.contentType,
        ETag: `"${sha}"`,
        'X-Content-SHA256': sha,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(e.art.bytes),
      })
      res.end()
      return
    }
    // gather the bytes source
    let members: Buffer[] | null = null
    let size = e.art.bytes
    if (e.src.type === 'file') {
      const st = statQuiet(e.src.file)
      if (!st || st.size !== e.src.size || st.mtimeMs !== e.src.mtimeMs) return sendError(res, 410, 'artifact is gone or changed; fetch the manifest again')
    } else if (e.src.type === 'mem') {
      members = e.src.data
    } else {
      try {
        const k = await keptMembers(e as Entry & { src: { type: 'kept' } })
        if (k.sha256 !== sha) {
          if (req.headers['if-match']) return sendError(res, 412, 'artifact changed since that manifest')
          sha = k.sha256
        }
        members = k.members
        size = members.reduce((a, m) => a + m.length, 0)
      } catch (err) {
        log('warn', `${rel} unavailable: ${(err as Error).message}`)
        return sendError(res, 503, 'artifact unavailable right now', { 'Retry-After': '60' })
      }
    }
    const etag = `"${sha}"`
    const base: Record<string, string> = {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': e.art.contentType,
      'Content-Disposition': `attachment; filename="${path.basename(rel)}"`,
      'Last-Modified': new Date(e.art.updatedAt).toUTCString(),
      'X-Content-SHA256': sha,
      'Accept-Ranges': 'bytes',
    }
    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined
    const ifRange = req.headers['if-range']
    const rangeOk = !ifRange || etagListed(ifRange, etag)
    let range = rangeOk ? parseRange(rangeHeader, size) : null
    if (range === 'bad') return sendError(res, 416, 'range not satisfiable', { 'Content-Range': `bytes */${size}` })
    const plain = /\.jsonl?$/.test(rel)
    const gz = plain && !range && !rangeHeader && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))

    // concurrency
    if (streamsTotal >= maxStreams || (streams.get(ip) ?? 0) >= maxStreamsPerIp) return sendError(res, 429, 'too many downloads in progress', { 'Retry-After': '30' })
    streamsTotal++
    streams.set(ip, (streams.get(ip) ?? 0) + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      streamsTotal--
      const n = (streams.get(ip) ?? 1) - 1
      if (n > 0) streams.set(ip, n)
      else streams.delete(ip)
    }
    res.once('close', release)
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    const t0 = Date.now()
    try {
      if (size === 0) {
        res.writeHead(200, { ...base, ETag: etag, 'Content-Length': '0' })
        res.end()
        return
      }
      const src: Readable =
        e.src.type === 'file' ? fs.createReadStream(e.src.file, { start, end, highWaterMark: 256 * 1024 }) : Readable.from(sliceMembers(members!, start, end))
      if (gz) {
        res.writeHead(200, { ...base, ETag: `W/${etag}`, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'X-Content-Length': String(size) })
        await pipeline(src, zlib.createGzip({ level: 4 }), throttle(egress), res)
      } else if (range) {
        res.writeHead(206, { ...base, ETag: etag, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) })
        await pipeline(src, throttle(egress), res)
      } else {
        res.writeHead(200, { ...base, ETag: etag, 'Content-Length': String(size) })
        await pipeline(src, throttle(egress), res)
      }
      const sent = range ? end - start + 1 : size
      log('info', `${rel} · ${(sent / MB).toFixed(1)} MB${gz ? ' (gzip)' : range ? ` (range from ${start})` : ''} in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ERR_STREAM_PREMATURE_CLOSE') log('warn', `${rel} stream ended early: ${(err as Error).message}`)
      if (!res.headersSent) sendError(res, 500, 'stream failed')
      else res.destroy()
    } finally {
      release()
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, p: string, ip: string): Promise<void> {
    if (!enabled || stopped) return sendError(res, 404, 'not found')
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'method not allowed', { Allow: 'GET, HEAD' })
    const locked429 = authFail.check(ip)
    if (locked429 > 0) return sendError(res, 429, 'too many failed attempts', { 'Retry-After': String(Math.ceil(locked429 / 1000)) })
    if (!authorized(req)) {
      authFail.take(ip)
      return sendError(res, 401, 'export token required', { 'WWW-Authenticate': 'Bearer realm="lusca-export"' })
    }
    const w = Math.max(perIp.take(ip), global.take('*'))
    if (w > 0) return sendError(res, 429, 'too many export requests; slow down', { 'Retry-After': String(Math.ceil(w / 1000)) })
    if (p === '/api/export/manifest' || p === '/api/export') return sendManifest(req, res)
    const m = /^\/api\/export\/file\/(.+)$/.exec(p)
    if (m) {
      let rel: string
      try {
        rel = decodeURIComponent(m[1])
      } catch {
        return sendError(res, 400, 'bad path')
      }
      if (!PATH_RE.test(rel) || rel.includes('..')) return sendError(res, 400, 'bad path')
      return sendFile(req, res, rel, ip)
    }
    return sendError(res, 404, 'not found')
  }

  return {
    enabled,
    handle,
    async manifest() {
      const s = await refresh()
      return s.manifest
    },
    stop() {
      stopped = true
      clearInterval(sweepTimer)
      if (warmup) clearTimeout(warmup)
    },
  }
}
