// @ts-check
// CODE SEARCH — builder worker (worker_threads). Owns the index: reads kept records from the chain store's
// shards, deduplicates source files by content hash, copies each unique file once into shared memory
// (SharedArrayBuffer segments the query workers read without a copy), computes its trigram signature, and
// persists a gzip snapshot under <data>/search so a restart does not re-read every shard.
//
// In:  { type: 'init', dataDir, maxBytes, maxFileBytes, saveDelayMs }
//      { type: 'sync', items: [key, chain, address, name, kind, readAt][] }   (the store's current kept items)
// Out: { type: 'delta', delta }   (segments / items / paths / files / refs / dropped items; applied in order)
//      { type: 'stats', stats }   { type: 'log', lvl, msg }   { type: 'idle' }
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { parentPort } from 'node:worker_threads'
import { LOWER, isLibPath, sigBitsFor } from './common.mjs'

const port = /** @type {import('node:worker_threads').MessagePort} */ (parentPort)
const MB = 1048576
const SEG_BYTES = 32 * MB
const SIG_SEG_BYTES = 8 * MB
const SNAP_VERSION = 1
const LANGS = new Set(['solidity', 'vyper', 'yul'])

/** @typedef {{ id: number; key: string; chain: string; address: string; name: string | null; kind: string; readAt: number; files: number[]; idl: boolean }} Item */
/** @typedef {{ id: number; h: string; seg: number; off: number; len: number; sseg: number; soff: number; sbits: number; lang: string; lines: number; ci: boolean; idl: boolean; refs: [number, number][] }} FileRec */

const log = (/** @type {'info'|'warn'|'error'} */ lvl, /** @type {string} */ msg) => port.postMessage({ type: 'log', lvl, msg })

let dataDir = ''
let maxBytes = 192 * MB
let maxFileBytes = 2 * MB
let saveDelayMs = 120_000

/** @type {SharedArrayBuffer[]} */ const textSegs = []
let textUsed = SEG_BYTES
/** @type {SharedArrayBuffer[]} */ const sigSegs = []
let sigUsed = SIG_SEG_BYTES
/** @type {Item[]} */ const items = []
/** @type {Map<string, Item>} */ const itemByKey = new Map()
/** @type {FileRec[]} */ const files = []
/** @type {Map<string, FileRec>} */ const fileByHash = new Map()
/** @type {string[]} */ const paths = []
/** @type {Map<string, number>} */ const pathId = new Map()
/** @type {Set<string>} */ let codeIndex = new Set()
/** @type {Record<string, number>} */ let shardSizes = {}
let uniqueBytes = 0
let skipped = { big: 0, cap: 0 }
let builtAt = /** @type {number | null} */ (null)
let state = /** @type {'loading'|'building'|'ready'} */ ('loading')
let diskBytes = 0
let dirty = false
let saveTimer = /** @type {NodeJS.Timeout | null} */ (null)

// pending delta (flushed by flush())
/** @type {{ segs: { kind: 'text' | 'sig'; idx: number; sab: SharedArrayBuffer }[]; items: any[]; paths: [number, string][]; files: any[]; refs: [number, number, number][]; drop: number[] }} */
let delta = { segs: [], items: [], paths: [], files: [], refs: [], drop: [] }
const emptyDelta = () => !delta.segs.length && !delta.items.length && !delta.paths.length && !delta.files.length && !delta.refs.length && !delta.drop.length

function flush() {
  if (!emptyDelta()) {
    port.postMessage({ type: 'delta', delta })
    delta = { segs: [], items: [], paths: [], files: [], refs: [], drop: [] }
  }
  port.postMessage({ type: 'stats', stats: stats() })
}

// ─── storage ─────────────────────────────────────────────────────────────────

function allocText(/** @type {number} */ len) {
  if (len > SEG_BYTES) {
    const sab = new SharedArrayBuffer(len)
    textSegs.push(sab)
    delta.segs.push({ kind: 'text', idx: textSegs.length - 1, sab })
    return { seg: textSegs.length - 1, off: 0, dedicated: true }
  }
  if (textUsed + len > SEG_BYTES || !textSegs.length || textSegs[textSegs.length - 1].byteLength !== SEG_BYTES) {
    const sab = new SharedArrayBuffer(SEG_BYTES)
    textSegs.push(sab)
    delta.segs.push({ kind: 'text', idx: textSegs.length - 1, sab })
    textUsed = 0
  }
  const at = { seg: textSegs.length - 1, off: textUsed, dedicated: false }
  textUsed += len
  return at
}

function allocSig(/** @type {number} */ bytes) {
  if (sigUsed + bytes > SIG_SEG_BYTES || !sigSegs.length) {
    const sab = new SharedArrayBuffer(Math.max(SIG_SEG_BYTES, bytes))
    sigSegs.push(sab)
    delta.segs.push({ kind: 'sig', idx: sigSegs.length - 1, sab })
    sigUsed = 0
  }
  const at = { sseg: sigSegs.length - 1, soff: sigUsed }
  sigUsed += bytes
  return at
}

// trigram signature scratch (distinct trigrams of one file)
const seenTri = new Uint8Array(1 << 24)
let touched = new Int32Array(1 << 20)

/** Trigram signature of bytes (lower-cased ASCII) written into a new slot of a signature segment. */
function signature(/** @type {Uint8Array} */ b) {
  let cnt = 0
  if (b.length >= 3) {
    let x = LOWER[b[0]]
    let y = LOWER[b[1]]
    for (let i = 2; i < b.length; i++) {
      const z = LOWER[b[i]]
      const t = (x << 16) | (y << 8) | z
      if (!seenTri[t]) {
        seenTri[t] = 1
        if (cnt === touched.length) {
          const n = new Int32Array(touched.length * 2)
          n.set(touched)
          touched = n
        }
        touched[cnt++] = t
      }
      x = y
      y = z
    }
  }
  const bits = sigBitsFor(cnt)
  const lg = Math.log2(bits)
  const at = allocSig(bits >>> 3)
  const words = new Int32Array(sigSegs[at.sseg], at.soff, bits >>> 5)
  for (let k = 0; k < cnt; k++) {
    const t = touched[k]
    seenTri[t] = 0
    // skip trigrams with a non-ASCII byte: queries never ask for them (see trigramsOf)
    if ((t & 0x808080) !== 0) continue
    const bit = (Math.imul(t, 0x9e3779b1) >>> (32 - lg)) >>> 0
    words[bit >>> 5] |= 1 << (bit & 31)
  }
  return { ...at, sbits: bits }
}

function internPath(/** @type {string} */ p) {
  let id = pathId.get(p)
  if (id === undefined) {
    id = paths.length
    paths.push(p)
    pathId.set(p, id)
    delta.paths.push([id, p])
  }
  return id
}

const countLines = (/** @type {Uint8Array} */ b) => {
  if (!b.length) return 0
  let n = 1
  for (let i = 0; i < b.length; i++) if (b[i] === 10) n++
  if (b[b.length - 1] === 10) n--
  return n
}

/** Store one unique file (or find it), returns the file id or -1 when it is not indexed. */
function addFile(/** @type {Buffer} */ bytes, /** @type {string} */ lang, /** @type {boolean} */ ci, /** @type {boolean} */ idl, /** @type {string | null} */ hash) {
  const h = hash ?? crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  const have = fileByHash.get(h)
  if (have) return have.id
  if (bytes.length > maxFileBytes) {
    skipped.big++
    return -1
  }
  if (uniqueBytes + bytes.length > maxBytes) {
    skipped.cap++
    return -1
  }
  const at = allocText(bytes.length)
  new Uint8Array(textSegs[at.seg], at.off, bytes.length).set(bytes)
  const sig = signature(bytes)
  /** @type {FileRec} */
  const f = { id: files.length, h, seg: at.seg, off: at.off, len: bytes.length, ...sig, lang, lines: countLines(bytes), ci, idl, refs: [] }
  files.push(f)
  fileByHash.set(h, f)
  uniqueBytes += bytes.length
  delta.files.push({ id: f.id, seg: f.seg, off: f.off, len: f.len, sseg: f.sseg, soff: f.soff, sbits: f.sbits, lang: f.lang, lines: f.lines, ci: f.ci, idl: f.idl })
  return f.id
}

function addRef(/** @type {number} */ fid, /** @type {Item} */ it, /** @type {string} */ p) {
  const pid = internPath(p)
  files[fid].refs.push([it.id, pid])
  it.files.push(fid)
  delta.refs.push([fid, it.id, pid])
}

function dropItemRefs(/** @type {Item} */ it) {
  for (const fid of new Set(it.files)) {
    const f = files[fid]
    if (f) f.refs = f.refs.filter((r) => r[0] !== it.id)
  }
  it.files = []
  it.idl = false
  delta.drop.push(it.id)
}

function upsertItem(/** @type {[string, string, string, string | null, string, number]} */ e) {
  const [key, chain, address, name, kind, readAt] = e
  let it = itemByKey.get(key)
  if (!it) {
    it = { id: items.length, key, chain, address, name, kind, readAt, files: [], idl: false }
    items.push(it)
    itemByKey.set(key, it)
  } else {
    it.name = name
    it.readAt = readAt
    it.kind = kind
  }
  delta.items.push({ id: it.id, chain, address, name, readAt })
  return it
}

// ─── IDL → searchable lines ──────────────────────────────────────────────────

function typeName(/** @type {any} */ t) {
  if (typeof t === 'string') return t
  if (!t || typeof t !== 'object') return '?'
  if (t.defined) return typeof t.defined === 'string' ? t.defined : t.defined.name ?? '?'
  if (t.vec) return `Vec<${typeName(t.vec)}>`
  if (t.option) return `Option<${typeName(t.option)}>`
  if (t.coption) return `COption<${typeName(t.coption)}>`
  if (t.array) return `[${typeName(t.array[0])}; ${t.array[1]}]`
  return '?'
}
function accountNames(/** @type {any[]} */ accs, /** @type {string[]} */ out = []) {
  for (const a of accs ?? []) {
    if (!a || typeof a !== 'object') continue
    if (Array.isArray(a.accounts)) accountNames(a.accounts, out)
    else if (typeof a.name === 'string') out.push(a.name)
  }
  return out
}
const clip = (/** @type {string} */ s, n = 400) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Lines of an IDL document: one per instruction / account / type / event / error. */
export function idlLines(/** @type {any} */ idl) {
  if (!idl || typeof idl !== 'object') return []
  /** @type {string[]} */
  const out = []
  const name = idl.metadata?.name ?? idl.name
  const version = idl.metadata?.version ?? idl.version
  if (name) out.push(`program ${name}${version ? ` ${version}` : ''}`)
  for (const ix of Array.isArray(idl.instructions) ? idl.instructions : []) {
    if (typeof ix?.name !== 'string') continue
    const args = (Array.isArray(ix.args) ? ix.args : []).map((/** @type {any} */ a) => `${a?.name ?? '?'}: ${typeName(a?.type)}`).join(', ')
    const accs = accountNames(ix.accounts)
    out.push(clip(`instruction ${ix.name}(${args})${accs.length ? ` accounts: ${accs.join(', ')}` : ''}`))
  }
  for (const a of Array.isArray(idl.accounts) ? idl.accounts : []) if (typeof a?.name === 'string') out.push(`account ${a.name}`)
  for (const t of Array.isArray(idl.types) ? idl.types : []) if (typeof t?.name === 'string') out.push(`type ${t.name}`)
  for (const e of Array.isArray(idl.events) ? idl.events : []) if (typeof e?.name === 'string') out.push(`event ${e.name}`)
  for (const e of Array.isArray(idl.errors) ? idl.errors : [])
    if (typeof e?.name === 'string') out.push(clip(`error ${e.code ?? ''} ${e.name}${e.msg ? `: ${e.msg}` : ''}`.replace(/\s+/g, ' ')))
  return out
}

// ─── records → index ─────────────────────────────────────────────────────────

const langOf = (/** @type {string} */ l, /** @type {string} */ p) => {
  const v = (l || '').toLowerCase()
  if (LANGS.has(v)) return v
  const ext = p.toLowerCase().split('.').pop() ?? ''
  return ext === 'sol' ? 'solidity' : ext === 'vy' || ext === 'vyi' ? 'vyper' : ext === 'yul' ? 'yul' : 'other'
}

function indexRecord(/** @type {Item} */ it, /** @type {any} */ rec) {
  if (rec.chain === 'solana') {
    const lines = idlLines(rec.idl)
    if (lines.length) {
      const fid = addFile(Buffer.from(lines.join('\n'), 'utf8'), 'idl', false, true, null)
      if (fid >= 0) {
        addRef(fid, it, 'idl')
        it.idl = true
      }
    }
    return
  }
  const seen = new Set()
  for (const s of Array.isArray(rec.sources) ? rec.sources : []) {
    if (typeof s?.text !== 'string' || typeof s.path !== 'string') continue
    const raw = s.text
    const rawKey = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
    const text = raw.includes('\r') ? raw.replace(/\r\n?/g, '\n') : raw
    const bytes = Buffer.from(text, 'utf8')
    const h = text === raw ? rawKey : crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)
    const fid = addFile(bytes, langOf(s.lang, s.path), codeIndex.has(rawKey), false, h)
    if (fid < 0 || seen.has(fid)) continue
    seen.add(fid)
    addRef(fid, it, s.path)
  }
}

/** Stream the records of one shard file (multi-member gzip, one JSON record per line). */
async function eachRecordLine(/** @type {string} */ file, /** @type {(line: Buffer) => void} */ fn) {
  /** @type {Buffer[]} */
  let parts = []
  const gz = fs.createReadStream(file).pipe(zlib.createGunzip())
  for await (const chunk of gz) {
    let b = /** @type {Buffer} */ (chunk)
    let nl
    while ((nl = b.indexOf(10)) >= 0) {
      parts.push(b.subarray(0, nl))
      const line = parts.length === 1 ? parts[0] : Buffer.concat(parts)
      parts = []
      if (line.length) fn(line)
      b = b.subarray(nl + 1)
    }
    if (b.length) parts.push(Buffer.from(b))
  }
  if (parts.length) fn(Buffer.concat(parts))
}

const HEAD_RE = /^\{"v":1,"chain":"([a-z]+)","address":"([^"]+)"/
const READAT_RE = /"readAt":(\d+)\}\s*$/

const keyOf = (/** @type {string} */ chain, /** @type {string} */ address) => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`

/** @type {Map<string, [string, string, string, string | null, string, number]> | null} */
let wanted = null
let running = false
let initDone = false
/** @type {Map<string, number>} keys whose record was not found yet → readAt wanted */
const unresolved = new Map()
let fullScanned = false

async function sync() {
  if (running) return
  running = true
  try {
    while (wanted) {
      const cur = wanted
      wanted = null
      await syncOnce(cur)
    }
  } catch (e) {
    log('error', `search index sync failed: ${/** @type {Error} */ (e)?.stack ?? e}`)
  } finally {
    running = false
  }
}

async function syncOnce(/** @type {Map<string, [string, string, string, string | null, string, number]>} */ cur) {
  // items gone, or kept again (new readAt), since they were indexed
  for (const it of items) {
    if (!it.readAt) continue
    const e = cur.get(it.key)
    if (!e || e[5] !== it.readAt) {
      if (it.files.length || it.idl) dropItemRefs(it)
      it.readAt = 0
      dirty = true
    }
  }
  /** @type {Map<string, [string, string, string, string | null, string, number]>} */
  const pending = new Map()
  for (const [k, e] of cur) {
    const it = itemByKey.get(k)
    if (!it || it.readAt !== e[5]) pending.set(k, e)
  }
  if (!pending.size) {
    finishBuild()
    return
  }
  const shardDir = path.join(dataDir, 'chain', 'shards')
  let names = []
  try {
    names = fs.readdirSync(shardDir).filter((n) => /^chain-\d{6}\.jsonl\.gz$/.test(n)).sort()
  } catch {
    names = []
  }
  /** @type {Record<string, number>} */
  const sizes = {}
  for (const n of names) {
    try {
      sizes[n] = fs.statSync(path.join(shardDir, n)).size
    } catch {
      /* gone */
    }
  }
  // records are appended to the newest shard: new and re-kept items are in shards that grew (or the newest one);
  // anything not found there gets one scan of every shard per process (a first build, a lost snapshot)
  const newest = names[names.length - 1]
  const first = names.filter((n) => sizes[n] !== shardSizes[n] || n === newest)
  const rest = names.filter((n) => !first.includes(n))
  let indexed = 0
  let lastFlush = Date.now()
  for (const n of first.concat(['*'], rest)) {
    if (!pending.size) break
    if (n === '*') {
      if (fullScanned) break
      fullScanned = true
      continue
    }
    try {
      await eachRecordLine(path.join(shardDir, n), (line) => {
        const head = HEAD_RE.exec(line.subarray(0, 300).toString('latin1'))
        if (!head) return
        const k = keyOf(head[1], head[2])
        const e = pending.get(k)
        if (!e) return
        const ra = READAT_RE.exec(line.subarray(Math.max(0, line.length - 40)).toString('latin1'))
        if (!ra || Number(ra[1]) !== e[5]) return
        let rec
        try {
          rec = JSON.parse(line.toString('utf8'))
        } catch {
          return
        }
        const it = upsertItem(e)
        if (it.files.length || it.idl) dropItemRefs(it)
        indexRecord(it, rec)
        pending.delete(k)
        unresolved.delete(k)
        indexed++
        dirty = true
        if (Date.now() - lastFlush > 1500) {
          flush()
          lastFlush = Date.now()
        }
      })
    } catch (e) {
      log('warn', `search index: shard ${n} unreadable: ${/** @type {Error} */ (e).message}`)
    }
  }
  for (const n of names) if (sizes[n] !== undefined) shardSizes[n] = sizes[n]
  for (const k of Object.keys(shardSizes)) if (sizes[k] === undefined) delete shardSizes[k]
  for (const [k, e] of pending) unresolved.set(k, e[5])
  if (indexed) log('info', `search index: +${indexed} kept item${indexed === 1 ? '' : 's'} (${files.length} unique files, ${(uniqueBytes / MB).toFixed(1)} MB)`)
  finishBuild()
}

function finishBuild() {
  if (state !== 'ready') {
    state = 'ready'
    builtAt = Date.now()
  } else if (dirty) builtAt = Date.now()
  flush()
  if (dirty) scheduleSave()
  port.postMessage({ type: 'idle' })
}

// ─── stats ───────────────────────────────────────────────────────────────────

function stats() {
  let contracts = 0
  let programs = 0
  /** @type {Record<string, number>} */
  const byChain = {}
  for (const it of items) {
    if (!it.files.length) continue
    if (it.idl) programs++
    else contracts++
    byChain[it.chain] = (byChain[it.chain] ?? 0) + 1
  }
  let fileRefs = 0
  let lines = 0
  let bytes = 0
  let rawBytes = 0
  let unique = 0
  /** @type {{ f: FileRec; n: number }[]} */
  const top = []
  for (const f of files) {
    if (f.idl || !f.refs.length) continue
    const n = new Set(f.refs.map((r) => r[0])).size
    unique++
    fileRefs += n
    lines += f.lines
    bytes += f.len
    rawBytes += f.len * n
    if (n > 1) top.push({ f, n })
  }
  top.sort((a, b) => b.n - a.n || a.f.id - b.f.id)
  const partial = skipped.cap || skipped.big
    ? [skipped.cap ? `${skipped.cap} file${skipped.cap === 1 ? '' : 's'} not indexed: the ${Math.round(maxBytes / MB)} MB index cap is reached` : '', skipped.big ? `${skipped.big} file${skipped.big === 1 ? '' : 's'} over ${Math.round(maxFileBytes / MB)} MB left out` : '']
        .filter(Boolean)
        .join(' · ')
    : null
  return {
    state,
    contracts,
    programs,
    fileRefs,
    uniqueFiles: unique,
    lines,
    bytes,
    rawBytes,
    diskBytes,
    byChain,
    top: top.slice(0, 8).map(({ f, n }) => {
      /** @type {Record<string, number>} */
      const chains = {}
      const seenIt = new Set()
      let sample = null
      for (const [iid, pid] of f.refs) {
        if (seenIt.has(iid)) continue
        seenIt.add(iid)
        const it = items[iid]
        chains[it.chain] = (chains[it.chain] ?? 0) + 1
        if (!sample || (it.name && !sample.name)) sample = { chain: it.chain, address: it.address, name: it.name, path: paths[pid] }
      }
      const p = sample?.path ?? ''
      return { path: p, contracts: n, chains, lines: f.lines, library: f.ci || f.refs.some((r) => isLibPath(paths[r[1]])), sample: sample ? { chain: sample.chain, address: sample.address, name: sample.name } : null }
    }),
    partial,
    builtAt,
  }
}

// ─── snapshot ────────────────────────────────────────────────────────────────

const snapFile = () => path.join(dataDir, 'search', `index.v${SNAP_VERSION}.gz`)

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (running) return scheduleSave()
    void save()
  }, builtAt && diskBytes ? saveDelayMs : 1000)
}

async function save() {
  if (!dirty) return
  dirty = false
  const file = snapFile()
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const header = {
      v: SNAP_VERSION,
      savedAt: Date.now(),
      shardSizes,
      items: items.map((it) => [it.key, it.chain, it.address, it.name, it.kind, it.readAt]),
      paths,
      files: files.map((f) => [f.h, f.len, f.lang, f.lines, f.ci ? 1 : 0, f.idl ? 1 : 0, f.refs]),
    }
    const gz = zlib.createGzip({ level: 6 })
    const out = fs.createWriteStream(tmp)
    const done = new Promise((resolve, reject) => {
      out.on('finish', () => resolve(undefined))
      out.on('error', reject)
      gz.on('error', reject)
    })
    gz.pipe(out)
    const write = (/** @type {Buffer} */ b) => (gz.write(b) ? Promise.resolve() : new Promise((r) => gz.once('drain', () => r(undefined))))
    await write(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))
    for (const f of files) await write(Buffer.from(new Uint8Array(textSegs[f.seg], f.off, f.len)))
    gz.end()
    await done
    fs.renameSync(tmp, file)
    diskBytes = fs.statSync(file).size
    log('info', `search index snapshot saved (${(diskBytes / MB).toFixed(1)} MB gzip, ${files.length} unique files)`)
    port.postMessage({ type: 'stats', stats: stats() })
  } catch (e) {
    dirty = true
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* gone */
    }
    log('warn', `search index snapshot not saved: ${/** @type {Error} */ (e).message}`)
  }
}

/** Load the snapshot (streamed: header line, then the bytes of every file in order). */
async function load() {
  const file = snapFile()
  if (!fs.existsSync(file)) return false
  try {
    const gz = fs.createReadStream(file).pipe(zlib.createGunzip())
    /** @type {any} */
    let header = null
    /** @type {Buffer[]} */
    let headParts = []
    let fi = 0
    let fileBuf = /** @type {Buffer | null} */ (null)
    let fileFill = 0
    const startFile = () => {
      while (fi < header.files.length && header.files[fi][1] === 0) {
        place(Buffer.alloc(0))
      }
      if (fi < header.files.length) {
        fileBuf = Buffer.allocUnsafe(header.files[fi][1])
        fileFill = 0
      } else fileBuf = null
    }
    const place = (/** @type {Buffer} */ bytes) => {
      const [h, , lang, , ci, idl, refs] = header.files[fi]
      const at = allocText(bytes.length)
      new Uint8Array(textSegs[at.seg], at.off, bytes.length).set(bytes)
      const sig = signature(bytes)
      /** @type {FileRec} */
      const f = { id: files.length, h, seg: at.seg, off: at.off, len: bytes.length, ...sig, lang, lines: header.files[fi][3], ci: !!ci, idl: !!idl, refs }
      files.push(f)
      fileByHash.set(h, f)
      uniqueBytes += f.len
      fi++
    }
    for await (const chunk of gz) {
      let b = /** @type {Buffer} */ (chunk)
      if (!header) {
        const nl = b.indexOf(10)
        if (nl < 0) {
          headParts.push(Buffer.from(b))
          continue
        }
        headParts.push(b.subarray(0, nl))
        header = JSON.parse(Buffer.concat(headParts).toString('utf8'))
        headParts = []
        if (header?.v !== SNAP_VERSION || !Array.isArray(header.files) || !Array.isArray(header.items) || !Array.isArray(header.paths)) throw new Error('unknown snapshot format')
        b = b.subarray(nl + 1)
        startFile()
      }
      while (b.length && fileBuf) {
        const take = Math.min(b.length, fileBuf.length - fileFill)
        b.copy(fileBuf, fileFill, 0, take)
        fileFill += take
        b = b.subarray(take)
        if (fileFill === fileBuf.length) {
          place(fileBuf)
          startFile()
        }
      }
    }
    if (!header || fi !== header.files.length) throw new Error('snapshot cut short')
    for (const p of header.paths) {
      pathId.set(p, paths.length)
      delta.paths.push([paths.length, p])
      paths.push(p)
    }
    for (const e of header.items) {
      const it = upsertItem(e)
      it.readAt = e[5]
    }
    for (const f of files) {
      delta.files.push({ id: f.id, seg: f.seg, off: f.off, len: f.len, sseg: f.sseg, soff: f.soff, sbits: f.sbits, lang: f.lang, lines: f.lines, ci: f.ci, idl: f.idl })
      for (const [iid, pid] of f.refs) {
        const it = items[iid]
        if (!it) continue
        it.files.push(f.id)
        if (f.idl) it.idl = true
        delta.refs.push([f.id, iid, pid])
      }
    }
    shardSizes = header.shardSizes ?? {}
    diskBytes = fs.statSync(file).size
    log('info', `search index snapshot loaded: ${files.length} unique files, ${(uniqueBytes / MB).toFixed(1)} MB, ${items.length} items`)
    return true
  } catch (e) {
    log('warn', `search index snapshot unusable (${/** @type {Error} */ (e).message}) — rebuilding from the chain store`)
    // reset everything the partial load touched
    textSegs.length = 0
    sigSegs.length = 0
    textUsed = SEG_BYTES
    sigUsed = SIG_SEG_BYTES
    files.length = 0
    fileByHash.clear()
    items.length = 0
    itemByKey.clear()
    paths.length = 0
    pathId.clear()
    uniqueBytes = 0
    shardSizes = {}
    delta = { segs: [], items: [], paths: [], files: [], refs: [], drop: [] }
    return false
  }
}

/** First 16 bytes (hex) of the sha256 of every file in the protocol code index (<data>/code/*.sha). */
function loadCodeIndex() {
  const dir = path.join(dataDir, 'code')
  const out = new Set()
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.sha')) continue
      const b = fs.readFileSync(path.join(dir, n))
      for (let i = 0; i + 16 <= b.length; i += 16) out.add(b.subarray(i, i + 16).toString('hex'))
    }
  } catch {
    /* no code index here */
  }
  return out
}

port.on('message', async (/** @type {any} */ m) => {
  if (m?.type === 'init') {
    dataDir = m.dataDir
    if (m.maxBytes) maxBytes = m.maxBytes
    if (m.maxFileBytes) maxFileBytes = m.maxFileBytes
    if (m.saveDelayMs !== undefined) saveDelayMs = m.saveDelayMs
    codeIndex = loadCodeIndex()
    const ok = await load()
    state = 'building'
    if (ok) {
      // the loaded index answers right away; the first sync only adds what changed
      flush()
    } else flush()
    port.postMessage({ type: 'loaded', snapshot: ok, codeIndexFiles: codeIndex.size })
    initDone = true
    if (wanted) void sync()
  } else if (m?.type === 'sync') {
    wanted = new Map(m.items.map((/** @type {any} */ e) => [e[0], e]))
    if (initDone) void sync()
  } else if (m?.type === 'save') {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    await save()
    port.postMessage({ type: 'saved' })
  }
})
