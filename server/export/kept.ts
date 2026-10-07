// Kept-code export: the chain agents' kept programs / contracts as training shards for the owner's PC.
//
// Input is what the chain store already wrote (server/chain/store.ts), read-only, never through its API:
//   <data>/chain/items.json                  the commit point: current item per address (shard, off, len, readAt)
//   <data>/chain/shards/chain-NNNNNN.jsonl.gz ChainRecord per gzip member, append-only
//
// One chain shard gives three export artifacts (all gzip JSONL, one gzip member per ~1 MiB of lines):
//   kept-code/files-NNNNNN.jsonl.gz      one line per source file whose content (sha256) appears here for the
//                                        first time in the store: text, path, chain, address, compiler, SPDX
//                                        license, verification match, kept time
//   kept-code/contracts-NNNNNN.jsonl.gz  one line per stored record (every kept read, superseded ones too):
//                                        metadata, file list with sha256 and license, ABI, security.txt, proxy
//   kept-code/idls-NNNNNN.jsonl.gz       one line per record that carries an on-chain IDL (Solana program id)
// plus two small artifacts rebuilt from the whole store:
//   kept-code/refs.jsonl.gz              per file sha256: every (chain, address, path) that carries it
//   kept-code/current.jsonl.gz           the current index: which record is the live one for each address
//
// Stability: a sealed chain shard (not the one the store appends to) never changes, so its three artifacts
// never change either (files dedupe only against earlier shards, which are sealed too). The open shard is read
// up to its committed end (items.json), so its artifacts are a pure function of (shard, end). Nothing is
// written to disk: artifacts are rebuilt in memory when served (deterministic: each gzip member is one
// one-shot compression of a fixed run of lines) and a small LRU keeps the most recent ones.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import type { ChainRecord } from '../chain/store.ts'
import { exprTier, spdxHeader } from '../codebase/licenses.ts'

const gzipAsync = promisify(zlib.gzip) as (buf: Buffer, o?: zlib.ZlibOptions) => Promise<Buffer>

export const SHARD_RE = /^chain-(\d{6})\.jsonl\.gz$/
/** Lines per gzip member: a member is closed at the first line boundary past this many raw bytes. */
export const MEMBER_RAW_BYTES = 1 << 20
const GZ_LEVEL = 6
/**
 * Email addresses in a source file, counted (not changed: the text stays the verified source). Linear: each '@'
 * is checked against a bounded window, because a global /[…]+@…/ scan is quadratic on long runs of letters and
 * digits (hex blobs, inlined bytecode) and stalls the event loop.
 */
export function countEmails(text: string): number {
  let n = 0
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (i === 0 || !/[A-Za-z0-9._%+-]/.test(text[i - 1])) continue
    if (/^[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}(?![A-Za-z])/.test(text.slice(i + 1, i + 280))) n++
  }
  return n
}

export type KeptKind = 'kept-files' | 'kept-contracts' | 'kept-idls'
export const KEPT_KINDS: KeptKind[] = ['kept-files', 'kept-contracts', 'kept-idls']
const PREFIX: Record<KeptKind, string> = { 'kept-files': 'files', 'kept-contracts': 'contracts', 'kept-idls': 'idls' }

export const keptPath = (kind: KeptKind, seq: string) => `kept-code/${PREFIX[kind]}-${seq}.jsonl.gz`

/** One gzip JSONL artifact held in memory: its members concatenated are the file. */
export interface GzArtifact {
  members: Buffer[]
  bytes: number
  sha256: string
  records: number
  /** Uncompressed JSONL bytes. */
  rawBytes: number
}

export interface IndexItem {
  key: string
  chain: string
  address: string
  name: string | null
  kind: string
  via: string
  verifiedBy: string | null
  idl: boolean
  sourceFiles: number
  sourceBytes: number
  codeHash: string | null
  firstSeen: number
  readAt: number
  shard: string
  off: number
  len: number
}

export interface KeptIndex {
  /** The shard the store appends to (null before the first kept item). */
  open: string | null
  items: IndexItem[]
  updatedAt: number
}

const isoOf = (ms: number | null | undefined) => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null)
export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

/** items.json → the fields the export needs; null when absent or unreadable. */
export function readKeptIndex(dataDir: string): KeptIndex | null {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'chain', 'items.json'), 'utf8'))
  } catch {
    return null
  }
  const o = raw as { version?: unknown; updatedAt?: unknown; shard?: unknown; items?: unknown }
  if (!o || typeof o !== 'object' || o.version !== 1 || !Array.isArray(o.items)) return null
  const items: IndexItem[] = []
  for (const it of o.items as Partial<IndexItem>[]) {
    if (!it || typeof it.key !== 'string' || typeof it.shard !== 'string' || !SHARD_RE.test(it.shard)) continue
    if (!Number.isSafeInteger(it.off) || !Number.isSafeInteger(it.len) || (it.off as number) < 0 || (it.len as number) <= 0) continue
    items.push(it as IndexItem)
  }
  return { open: typeof o.shard === 'string' && SHARD_RE.test(o.shard) ? o.shard : null, items, updatedAt: Number(o.updatedAt) || 0 }
}

/** Committed end of each shard per the index (bytes past it may be an append in flight). */
export function committedEnds(idx: KeptIndex): Map<string, number> {
  const m = new Map<string, number>()
  for (const it of idx.items) m.set(it.shard, Math.max(m.get(it.shard) ?? 0, it.off + it.len))
  return m
}

/** Builds a gzip JSONL artifact from lines, one member per ~1 MiB of raw lines (deterministic). */
class GzBuilder {
  private members: Buffer[] = []
  private pending: string[] = []
  private pendingBytes = 0
  private records = 0
  private rawBytes = 0
  async add(obj: unknown): Promise<void> {
    const line = `${JSON.stringify(obj)}\n`
    const n = Buffer.byteLength(line)
    this.pending.push(line)
    this.pendingBytes += n
    this.records++
    this.rawBytes += n
    if (this.pendingBytes >= MEMBER_RAW_BYTES) await this.cut()
  }
  private async cut(): Promise<void> {
    if (!this.pending.length) return
    const buf = Buffer.from(this.pending.join(''), 'utf8')
    this.pending = []
    this.pendingBytes = 0
    this.members.push(await gzipAsync(buf, { level: GZ_LEVEL }))
  }
  async done(): Promise<GzArtifact> {
    await this.cut()
    const h = createHash('sha256')
    let bytes = 0
    for (const m of this.members) {
      h.update(m)
      bytes += m.length
    }
    return { members: this.members, bytes, sha256: h.digest('hex'), records: this.records, rawBytes: this.rawBytes }
  }
}

/** One (chain, address, path) carrying a file, in store order. */
export interface Occurrence {
  sha256: string
  chain: string
  address: string
  path: string
  readAt: number
}

export interface ShardBuild {
  shard: string
  seq: string
  /** Bytes of the shard file read (the committed end for the open shard). */
  end: number
  files: GzArtifact
  contracts: GzArtifact
  idls: GzArtifact
  /** sha256 of every file first seen in this shard. */
  firstSeen: Set<string>
  occurrences: Occurrence[]
}

/** Records of one chain shard, bytes [0, end), streamed (multi-member gzip, one record per line). */
export async function* shardRecords(file: string, end: number): AsyncGenerator<ChainRecord> {
  if (end <= 0) return
  const src = fs.createReadStream(file, { start: 0, end: end - 1, highWaterMark: 256 * 1024 })
  const gun = zlib.createGunzip()
  src.on('error', (e) => gun.destroy(e))
  src.pipe(gun)
  // split on the newline byte: it never occurs inside a multi-byte UTF-8 sequence
  let parts: Buffer[] = []
  const take = (): ChainRecord | null => {
    const line = (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString('utf8')
    parts = []
    return line.trim() ? (JSON.parse(line) as ChainRecord) : null
  }
  try {
    for await (const chunk of gun as AsyncIterable<Buffer>) {
      let start = 0
      let i: number
      while ((i = chunk.indexOf(10, start)) >= 0) {
        parts.push(chunk.subarray(start, i))
        start = i + 1
        const r = take()
        if (r) yield r
      }
      if (start < chunk.length) parts.push(chunk.subarray(start))
    }
    if (parts.length) {
      const r = take()
      if (r) yield r
    }
  } finally {
    src.destroy()
    gun.destroy()
  }
}

/**
 * The three artifacts of one chain shard. `seenBefore(sha)` says whether an earlier shard already exported that
 * file content (its files line is then left out here; the contracts line still lists it).
 */
export async function buildShard(file: string, end: number, seenBefore: (sha: string) => boolean): Promise<ShardBuild> {
  const shard = path.basename(file)
  const m = SHARD_RE.exec(shard)
  if (!m) throw new Error(`not a chain shard: ${shard}`)
  const files = new GzBuilder()
  const contracts = new GzBuilder()
  const idls = new GzBuilder()
  const firstSeen = new Set<string>()
  const occurrences: Occurrence[] = []
  let n = 0
  for await (const r of shardRecords(file, end)) {
    const v = r.verified ?? null
    const keptAt = isoOf(r.readAt)
    const fileRows: { path: string; lang: string; sha256: string; bytes: number; license: string | null }[] = []
    for (const s of r.sources ?? []) {
      if (!s || typeof s.text !== 'string' || typeof s.path !== 'string') continue
      const sha = sha256Hex(s.text)
      const bytes = Buffer.byteLength(s.text)
      const license = spdxHeader(s.text)
      fileRows.push({ path: s.path, lang: s.lang, sha256: sha, bytes, license })
      occurrences.push({ sha256: sha, chain: r.chain, address: r.address, path: s.path, readAt: r.readAt })
      if (firstSeen.has(sha) || seenBefore(sha)) continue
      firstSeen.add(sha)
      await files.add({
        sha256: sha,
        bytes,
        lang: s.lang,
        path: s.path,
        chain: r.chain,
        address: r.address,
        name: r.name,
        compiler: v?.compiler ?? null,
        verifiedBy: v?.by ?? null,
        match: v?.match ?? null,
        license,
        licenseTier: license ? exprTier(license) : 'unknown',
        keptAt,
        emails: countEmails(s.text),
        text: s.text,
      })
    }
    const idlSha256 = r.idl != null ? sha256Hex(JSON.stringify(r.idl)) : null
    await contracts.add({
      chain: r.chain,
      address: r.address,
      name: r.name,
      kind: r.kind,
      via: r.via,
      keptAt,
      readAt: r.readAt,
      codeHash: r.codeHash,
      sourceBundleHash: r.sourceBundleHash,
      verifiedBy: v?.by ?? null,
      match: v?.match ?? null,
      compiler: v?.compiler ?? null,
      repo: v?.repo ?? null,
      commit: v?.commit ?? null,
      files: fileRows,
      sourcesNote: r.sourcesNote ?? null,
      idlSha256,
      abi: r.abi ?? null,
      securityTxt: r.securityTxt ?? null,
      proxy: r.proxy ?? null,
      upgradeable: r.upgradeable ?? null,
      upgradeAuthority: r.upgradeAuthority ?? null,
      lastDeploySlot: r.lastDeploySlot ?? null,
      loader: r.loader ?? null,
      programBytes: r.programBytes ?? null,
      bytecodeBytes: r.bytecodeBytes ?? null,
      notes: r.notes ?? [],
    })
    if (r.idl != null) {
      await idls.add({
        programId: r.address,
        chain: r.chain,
        name: r.name,
        keptAt,
        readAt: r.readAt,
        verifiedBy: v?.by ?? null,
        repo: v?.repo ?? null,
        commit: v?.commit ?? null,
        idlSha256,
        idl: r.idl,
      })
    }
    // a record can hold megabytes of source: let the event loop breathe between records
    if (++n % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return { shard, seq: m[1], end, files: await files.done(), contracts: await contracts.done(), idls: await idls.done(), firstSeen, occurrences }
}

/** kept-code/refs.jsonl.gz: per file sha256 (first-seen order), every carrier with whether its record is current. */
export async function buildRefs(builds: readonly { shard: string; occurrences: readonly Occurrence[] }[], idx: KeptIndex): Promise<GzArtifact> {
  const current = new Map<string, { shard: string; readAt: number }>()
  for (const it of idx.items) current.set(it.key, { shard: it.shard, readAt: it.readAt })
  const keyOf = (chain: string, address: string) => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`
  const by = new Map<string, { chain: string; address: string; path: string; keptAt: string | null; current: boolean }[]>()
  for (const b of builds) {
    for (const o of b.occurrences) {
      const cur = current.get(keyOf(o.chain, o.address))
      const row = { chain: o.chain, address: o.address, path: o.path, keptAt: isoOf(o.readAt), current: !!cur && cur.shard === b.shard && cur.readAt === o.readAt }
      const list = by.get(o.sha256)
      if (list) list.push(row)
      else by.set(o.sha256, [row])
    }
  }
  const g = new GzBuilder()
  let n = 0
  for (const [sha256, carriers] of by) {
    await g.add({ sha256, carriers })
    if (++n % 2000 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return g.done()
}

/** kept-code/current.jsonl.gz: the live record of each kept address, in store order. */
export async function buildCurrent(idx: KeptIndex): Promise<GzArtifact> {
  const items = [...idx.items].sort((a, b) => (a.shard < b.shard ? -1 : a.shard > b.shard ? 1 : a.off - b.off))
  const g = new GzBuilder()
  for (const it of items) {
    const seq = SHARD_RE.exec(it.shard)![1]
    await g.add({
      chain: it.chain,
      address: it.address,
      name: it.name,
      kind: it.kind,
      via: it.via,
      verifiedBy: it.verifiedBy,
      idl: it.idl,
      sourceFiles: it.sourceFiles,
      sourceBytes: it.sourceBytes,
      codeHash: it.codeHash,
      firstSeen: isoOf(it.firstSeen),
      keptAt: isoOf(it.readAt),
      readAt: it.readAt,
      contracts: keptPath('kept-contracts', seq),
    })
  }
  return g.done()
}

/** The artifact of one kind from a build. */
export function pick(b: ShardBuild, kind: KeptKind): GzArtifact {
  return kind === 'kept-files' ? b.files : kind === 'kept-contracts' ? b.contracts : b.idls
}
