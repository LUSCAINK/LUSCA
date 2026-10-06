// SEPIA-0 public weights export.
//
// Reads the trainer's checkpoint (<dataDir>/sepia.ckpt, written by
// server/trainer/trainer.ts) and turns the float32 master weights into a
// safetensors file plus a JSON manifest. Nothing here touches the running
// trainer: the checkpoint file on disk is the only input, so the exported
// weights are exactly the newest saved checkpoint (the trainer saves every 90 s).
//
//   readCheckpoint(path)          checkpoint → { format, version, step, params, tensors, counters, loss, val, … }
//   toSafetensors(tensors, meta)  F32 tensors → safetensors bytes
//   parseSafetensors(bytes)       the inverse (tests, scripts/hf/build-release.mjs)
//   buildExport(ckpt)             safetensors + sha256 + manifest for one checkpoint (deterministic)
//   createWeightsExporter(opts)   cached builder: re-reads the checkpoint at most every 10 min
//   handleModelRoute(p, req, res, deps)
//                                 GET /api/model/weights.safetensors, GET /api/model/manifest.json
//                                 (not wired yet; see WIRING.md)
//
// Checkpoint layout (little-endian, see trainer.ts):
//   "SEPIACK1" | u32 headerLen | header JSON | pad to 8 |
//   f32 params[N] | f32 adam.m[N] | f32 adam.v[N] | pad to 8 | f64 history[count×5]
// where a history row is (step, loss, val|NaN, tokens, ts).
//
// safetensors layout (https://github.com/huggingface/safetensors):
//   u64 LE headerLen | header JSON (utf8, padded with spaces so the data starts
//   8-byte aligned) | raw little-endian tensor data
// with header = { "__metadata__": {string: string}, name: { dtype, shape, data_offsets: [begin, end] } }
// and data_offsets relative to the start of the data section. SEPIA tensors are
// written in parameter-vector order (emb, W1, b1, W2, b2), so the data section
// is byte-for-byte the flat float32 parameter vector of the checkpoint.
//
// Erasable TypeScript only (no enums / parameter properties): Node ≥ 22.18
// imports this file directly from scripts/hf/build-release.mjs.
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { endianness } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CTX, EMB, HIDDEN, VOCAB, VOCAB_SIZE, paramLayout } from '../../shared/sepia/model.mjs'

export const MODEL_NAME = 'SEPIA-0'
/** Same string as ModelInfo.arch (server/trainer/trainer.ts). */
export const MODEL_ARCH = `char-MLP · ctx ${CTX} · emb ${EMB} · hidden ${HIDDEN} · tanh`
export const DEFAULT_WEIGHTS_LICENSE = 'MIT'
export const EXPORT_TTL_MS = 10 * 60_000
export const WEIGHTS_ROUTE = '/api/model/weights.safetensors'
export const MANIFEST_ROUTE = '/api/model/manifest.json'

const CKPT_MAGIC = 'SEPIACK1'
const CKPT_FORMAT = 1
const HISTORY_COLS = 5
const MAX_ST_HEADER = 100 * 1024 * 1024 // the reference implementation's limit
const FAILED_RETRY_MS = 60_000
const RETRYABLE_FS = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE'])

// ─── types ──────────────────────────────────────────────────────────────────

export type TensorName = 'emb' | 'W1' | 'b1' | 'W2' | 'b2'

export interface F32Tensor {
  name: string
  /** row-major; SEPIA matrices are [in, out] (x @ W) */
  shape: number[]
  data: Float32Array
}

export interface SepiaTensor extends F32Tensor {
  name: TensorName
  /** first index in the flat parameter vector */
  offset: number
}

/** GPU-pipeline counters persisted in the checkpoint (worker.mjs persistedTrain()). */
export interface TrainCounters {
  /** optimizer steps computed by the server's own CPU loop */
  serverSteps: number
  /** optimizer steps applied from gradients computed by GPU neurons */
  gpuSteps: number
  /** (context, next-char) samples covered by applied GPU gradients */
  gpuSamples: number
  /** (context, next-char) samples consumed by applied updates, all sources */
  samplesSeen: number
  auditsOk: number
  auditsFailed: number
  /** results that failed the cheap checks */
  rejected: number
  /** verified results not applied because their base weights were too old */
  stale: number
  /** distinct neuron identities with an accepted result in the 24 h before the save */
  contributors24h: number
}

export interface CheckpointData {
  /** file format version from the header (1) */
  format: number
  /** weights version = optimizer steps applied (ModelInfo.version) */
  version: number
  step: number
  adamT: number
  /** ms since epoch when the trainer wrote the checkpoint */
  savedAt: number
  dims: { T: number; E: number; H: number; V: number }
  nParams: number
  /** flat float32 master weights, parameter-vector order */
  params: Float32Array
  /** views into `params` */
  tensors: SepiaTensor[]
  /** null when the checkpoint predates the GPU pipeline counters */
  counters: TrainCounters | null
  /** newest history point: mean train loss over its 25 steps (nats/char) */
  loss: number | null
  /** newest validation loss (held-out documents, nats/char) */
  val: number | null
  historyCount: number
}

export interface ManifestTensor {
  name: string
  dtype: 'F32'
  shape: number[]
  /** byte range inside the safetensors data section */
  data_offsets: [number, number]
}

export interface ModelManifest {
  name: string
  params: number
  arch: string
  vocab: number
  ctx: number
  emb: number
  hidden: number
  activation: 'tanh'
  /** weights version = optimizer steps applied (equals step) */
  version: number
  step: number
  loss: number | null
  val: number | null
  /** sha256 of the safetensors file (hex) */
  sha256: string
  bytes: number
  /** ISO time the checkpoint was saved */
  updatedAt: string
  license: string
  /** the 96 vocabulary symbols in id order: '\n', then ASCII 32..126 */
  chars: string
  format: 'safetensors'
  weights: string
  tensors: ManifestTensor[]
  training: {
    serverSteps: number
    gpuSteps: number
    gpuSamples: number
    samplesSeen: number
    audits: { ok: number; failed: number }
    rejected: number
    stale: number
    contributors24h: number
  } | null
}

export interface ExportBundle {
  safetensors: Buffer
  sha256: string
  bytes: number
  manifest: ModelManifest
  /** manifest JSON exactly as served */
  manifestJson: string
  /** strong ETag of the manifest body */
  manifestEtag: string
  step: number
  savedAt: number
}

export class NoCheckpointError extends Error {
  constructor(message = 'no SEPIA-0 checkpoint yet') {
    super(message)
    this.name = 'NoCheckpointError'
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
const cnt = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0)
const posInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0
const pad8 = (n: number) => (8 - (n % 8)) % 8
const errCode = (e: unknown) => (isObj(e) && typeof e.code === 'string' ? e.code : '')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const LE = endianness() === 'LE'

/** Float32Array → little-endian bytes (a copy). */
function f32Bytes(a: Float32Array): Buffer {
  if (LE) return Buffer.from(a.buffer, a.byteOffset, a.byteLength)
  const out = Buffer.alloc(a.length * 4)
  for (let i = 0; i < a.length; i++) out.writeFloatLE(a[i], i * 4)
  return out
}

/** Little-endian bytes → a fresh Float32Array. */
function readF32(buf: Uint8Array, off: number, n: number): Float32Array {
  const out = new Float32Array(n)
  if (LE) {
    new Uint8Array(out.buffer).set(buf.subarray(off, off + n * 4))
  } else {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    for (let i = 0; i < n; i++) out[i] = dv.getFloat32(off + i * 4, true)
  }
  return out
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Tensor views of a flat SEPIA parameter vector (layout of shared/sepia/model.mjs paramLayout). */
export function sepiaTensors(params: Float32Array, dims: { T: number; E: number; H: number; V: number } = { T: CTX, E: EMB, H: HIDDEN, V: VOCAB_SIZE }): SepiaTensor[] {
  const { T, E, H, V } = dims
  const L = paramLayout({ T, E, H, V })
  if (params.length !== L.total) throw new Error(`params: want ${L.total} values, got ${params.length}`)
  const view = (name: TensorName, offset: number, shape: number[]): SepiaTensor => {
    const len = shape.reduce((a, b) => a * b, 1)
    return { name, offset, shape, data: params.subarray(offset, offset + len) }
  }
  return [
    view('emb', L.emb, [V, E]),
    view('W1', L.W1, [T * E, H]),
    view('b1', L.b1, [H]),
    view('W2', L.W2, [H, V]),
    view('b2', L.b2, [V]),
  ]
}

// ─── checkpoint ─────────────────────────────────────────────────────────────

/** Decode a sepia.ckpt image (validates magic, format, sizes and finiteness). */
export function parseCheckpoint(buf: Uint8Array): CheckpointData {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (b.length < 12 || b.toString('latin1', 0, 8) !== CKPT_MAGIC) throw new Error('not a SEPIA checkpoint (bad magic)')
  const hl = b.readUInt32LE(8)
  if (12 + hl > b.length) throw new Error('truncated checkpoint header')
  let header: unknown
  try {
    header = JSON.parse(b.toString('utf8', 12, 12 + hl))
  } catch {
    throw new Error('checkpoint header is not JSON')
  }
  if (!isObj(header)) throw new Error('checkpoint header is not an object')
  if (header.version !== CKPT_FORMAT) throw new Error(`unsupported checkpoint format ${String(header.version)}`)
  const { T, E, H, V, nParams } = header
  if (!posInt(T) || !posInt(E) || !posInt(H) || !posInt(V)) throw new Error('checkpoint dimensions missing')
  if (V !== VOCAB_SIZE) throw new Error(`vocabulary size ${V} ≠ ${VOCAB_SIZE}`)
  const N = paramLayout({ T, E, H, V }).total
  if (nParams !== N) throw new Error(`checkpoint nParams ${String(nParams)} ≠ ${N} for its dimensions`)

  const dataOff = 12 + hl + pad8(12 + hl)
  const histOff = dataOff + 3 * N * 4
  const histOffAligned = histOff + pad8(histOff)
  const count = cnt(header.historyCount)
  if (histOffAligned + count * HISTORY_COLS * 8 > b.length) throw new Error('truncated checkpoint body')
  const params = readF32(b, dataOff, N)
  for (let i = 0; i < N; i++) if (!Number.isFinite(params[i])) throw new Error(`non-finite weight at index ${i}`)

  // Newest train loss and newest validation loss from the history tail.
  let loss: number | null = null
  let val: number | null = null
  for (let i = count - 1; i >= 0 && (loss === null || val === null); i--) {
    const row = histOffAligned + i * HISTORY_COLS * 8
    if (loss === null) {
      const l = b.readDoubleLE(row + 8)
      if (Number.isFinite(l)) loss = l
    }
    if (val === null) {
      const v = b.readDoubleLE(row + 16)
      if (Number.isFinite(v)) val = v
    }
  }

  const step = cnt(header.step)
  const t = header.train
  const counters: TrainCounters | null = isObj(t)
    ? {
        serverSteps: cnt(t.serverSteps),
        gpuSteps: cnt(t.gpuSteps),
        gpuSamples: cnt(t.gpuSamples),
        samplesSeen: cnt(t.samplesSeen),
        auditsOk: cnt(t.auditsOk),
        auditsFailed: cnt(t.auditsFailed),
        rejected: cnt(t.rejected),
        stale: cnt(t.stale),
        contributors24h: countRecentContributors(t.contributors, cnt(header.savedAt)),
      }
    : null

  return {
    format: CKPT_FORMAT,
    version: step,
    step,
    adamT: typeof header.adamT === 'number' ? cnt(header.adamT) : step,
    savedAt: cnt(header.savedAt),
    dims: { T, E, H, V },
    nParams: N,
    params,
    tensors: sepiaTensors(params, { T, E, H, V }),
    counters,
    loss,
    val,
    historyCount: count,
  }
}

/** Distinct [neuronKey, lastSeenMs] rows within 24 h of `at` (the keys themselves are never exported). */
function countRecentContributors(rows: unknown, at: number): number {
  if (!Array.isArray(rows)) return 0
  const since = at - 24 * 3600_000
  const keys = new Set<string>()
  for (const r of rows) if (Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'number' && (at === 0 || r[1] >= since)) keys.add(r[0])
  return keys.size
}

async function readFileWithRetry(file: string): Promise<Buffer> {
  let last: unknown = null
  for (let i = 0; i < 6; i++) {
    try {
      return await fsp.readFile(file)
    } catch (e) {
      last = e
      if (!RETRYABLE_FS.has(errCode(e))) break
      await new Promise((r) => setTimeout(r, 100 * 2 ** i)) // the trainer renames sepia.ckpt.tmp over it
    }
  }
  if (errCode(last) === 'ENOENT') throw new NoCheckpointError()
  throw last instanceof Error ? last : new Error(String(last))
}

/** Read and decode <dataDir>/sepia.ckpt. Throws NoCheckpointError when the file does not exist. */
export async function readCheckpoint(file: string): Promise<CheckpointData> {
  return parseCheckpoint(await readFileWithRetry(file))
}

// ─── safetensors ────────────────────────────────────────────────────────────

/**
 * F32 tensors → safetensors bytes. Tensors are stored contiguously in the given
 * order; the JSON header is padded with spaces so the data section starts on an
 * 8-byte boundary. Metadata values must be strings (the format's rule).
 */
export function toSafetensors(tensors: readonly F32Tensor[], metadata: Record<string, string> = {}): Buffer {
  const header: Record<string, unknown> = {}
  const meta: Record<string, string> = {}
  for (const [k, v] of Object.entries(metadata)) {
    if (typeof v !== 'string') throw new Error(`metadata ${k}: values must be strings`)
    meta[k] = v
  }
  if (Object.keys(meta).length) header.__metadata__ = meta
  let off = 0
  const seen = new Set<string>()
  for (const t of tensors) {
    if (!t.name || t.name === '__metadata__' || seen.has(t.name)) throw new Error(`bad or duplicate tensor name "${t.name}"`)
    seen.add(t.name)
    if (!(t.data instanceof Float32Array)) throw new Error(`${t.name}: data must be a Float32Array`)
    if (!t.shape.every((d) => Number.isInteger(d) && d >= 0)) throw new Error(`${t.name}: bad shape`)
    const n = t.shape.reduce((a, b) => a * b, 1)
    if (n !== t.data.length) throw new Error(`${t.name}: shape [${t.shape.join(', ')}] holds ${n} values, data has ${t.data.length}`)
    header[t.name] = { dtype: 'F32', shape: [...t.shape], data_offsets: [off, off + n * 4] }
    off += n * 4
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const hl = json.length + pad8(json.length) // 8 + hl is a multiple of 8
  const out = Buffer.alloc(8 + hl + off, 0x20) // padding bytes are spaces
  out.writeBigUInt64LE(BigInt(hl), 0)
  json.copy(out, 8)
  let p = 8 + hl
  for (const t of tensors) {
    f32Bytes(t.data).copy(out, p)
    p += t.data.byteLength
  }
  return out
}

export interface ParsedSafetensors {
  headerLength: number
  metadata: Record<string, string>
  tensors: F32Tensor[]
}

/** safetensors bytes → tensors (F32 only), with the reference implementation's checks. */
export function parseSafetensors(buf: Uint8Array): ParsedSafetensors {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (b.length < 8) throw new Error('safetensors: file too short')
  const hl64 = b.readBigUInt64LE(0)
  if (hl64 > BigInt(Math.min(MAX_ST_HEADER, b.length - 8))) throw new Error('safetensors: header length out of range')
  const hl = Number(hl64)
  let header: unknown
  try {
    header = JSON.parse(b.toString('utf8', 8, 8 + hl))
  } catch {
    throw new Error('safetensors: header is not JSON')
  }
  if (!isObj(header)) throw new Error('safetensors: header is not an object')
  const dataStart = 8 + hl
  const dataLen = b.length - dataStart
  let metadata: Record<string, string> = {}
  const entries: { name: string; shape: number[]; begin: number; end: number }[] = []
  for (const [name, v] of Object.entries(header)) {
    if (name === '__metadata__') {
      if (!isObj(v)) throw new Error('safetensors: __metadata__ must be an object')
      for (const [k, s] of Object.entries(v)) if (typeof s !== 'string') throw new Error(`safetensors: metadata ${k} is not a string`)
      metadata = v as Record<string, string>
      continue
    }
    if (!isObj(v)) throw new Error(`safetensors: ${name} is not an object`)
    if (v.dtype !== 'F32') throw new Error(`safetensors: ${name} has dtype ${String(v.dtype)}; only F32 is supported`)
    const shape = v.shape
    const offs = v.data_offsets
    if (!Array.isArray(shape) || !shape.every((d) => Number.isInteger(d) && d >= 0)) throw new Error(`safetensors: ${name} has a bad shape`)
    if (!Array.isArray(offs) || offs.length !== 2 || !offs.every((d) => Number.isInteger(d) && d >= 0)) throw new Error(`safetensors: ${name} has bad data_offsets`)
    const [begin, end] = offs as number[]
    const n = (shape as number[]).reduce((a, c) => a * c, 1)
    if (end < begin || end > dataLen || end - begin !== n * 4) throw new Error(`safetensors: ${name} data_offsets do not match its shape`)
    entries.push({ name, shape: shape as number[], begin, end })
  }
  // Like the reference loader: the tensors must tile the data section exactly.
  const sorted = [...entries].sort((a, c) => a.begin - c.begin)
  let expect = 0
  for (const e of sorted) {
    if (e.begin !== expect) throw new Error(`safetensors: gap or overlap before ${e.name}`)
    expect = e.end
  }
  if (expect !== dataLen) throw new Error('safetensors: trailing bytes after the last tensor')
  return {
    headerLength: hl,
    metadata,
    tensors: entries.map((e) => ({ name: e.name, shape: e.shape, data: readF32(b, dataStart + e.begin, (e.end - e.begin) / 4) })),
  }
}

// ─── export bundle ──────────────────────────────────────────────────────────

/** safetensors __metadata__ for a checkpoint (no build time, so the bytes are deterministic). */
export function sepiaMetadata(ck: CheckpointData, license = DEFAULT_WEIGHTS_LICENSE): Record<string, string> {
  return {
    name: MODEL_NAME,
    arch: MODEL_ARCH,
    forward: 'logits = tanh(concat_t emb[ids_t] @ W1 + b1) @ W2 + b2; matrices row-major [in, out]; contexts left-padded with id 0',
    vocab: VOCAB,
    vocab_size: String(ck.dims.V),
    ctx: String(ck.dims.T),
    emb: String(ck.dims.E),
    hidden: String(ck.dims.H),
    activation: 'tanh',
    params: String(ck.nParams),
    version: String(ck.version),
    step: String(ck.step),
    saved_at: new Date(ck.savedAt).toISOString(),
    license,
    source: 'https://lusca.ink',
  }
}

/** safetensors + sha256 + manifest for one checkpoint. Same checkpoint → same bytes. */
export function buildExport(ck: CheckpointData, opts: { license?: string } = {}): ExportBundle {
  const license = opts.license || DEFAULT_WEIGHTS_LICENSE
  const safetensors = toSafetensors(ck.tensors, sepiaMetadata(ck, license))
  const sha256 = sha256Hex(safetensors)
  let off = 0
  const tensors: ManifestTensor[] = ck.tensors.map((t) => {
    const r: ManifestTensor = { name: t.name, dtype: 'F32', shape: [...t.shape], data_offsets: [off, off + t.data.byteLength] }
    off += t.data.byteLength
    return r
  })
  const c = ck.counters
  const manifest: ModelManifest = {
    name: MODEL_NAME,
    params: ck.nParams,
    arch: MODEL_ARCH,
    vocab: ck.dims.V,
    ctx: ck.dims.T,
    emb: ck.dims.E,
    hidden: ck.dims.H,
    activation: 'tanh',
    version: ck.version,
    step: ck.step,
    loss: ck.loss,
    val: ck.val,
    sha256,
    bytes: safetensors.length,
    updatedAt: new Date(ck.savedAt).toISOString(),
    license,
    chars: VOCAB,
    format: 'safetensors',
    weights: WEIGHTS_ROUTE,
    tensors,
    training: c
      ? {
          serverSteps: c.serverSteps,
          gpuSteps: c.gpuSteps,
          gpuSamples: c.gpuSamples,
          samplesSeen: c.samplesSeen,
          audits: { ok: c.auditsOk, failed: c.auditsFailed },
          rejected: c.rejected,
          stale: c.stale,
          contributors24h: c.contributors24h,
        }
      : null,
  }
  const manifestJson = JSON.stringify(manifest)
  return {
    safetensors,
    sha256,
    bytes: safetensors.length,
    manifest,
    manifestJson,
    manifestEtag: `"m-${sha256Hex(manifestJson).slice(0, 40)}"`,
    step: ck.step,
    savedAt: ck.savedAt,
  }
}

// ─── cached builder ─────────────────────────────────────────────────────────

export interface WeightsExporterOptions {
  /** <dataDir>/sepia.ckpt */
  ckptPath: string
  /** minimum time between checkpoint re-reads (default 10 min) */
  ttlMs?: number
  license?: string
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
  /** test hooks */
  now?: () => number
  stat?: (file: string) => Promise<{ mtimeMs: number; size: number }>
  read?: (file: string) => Promise<CheckpointData>
}

export interface WeightsExporter {
  /** Current bundle; re-reads the checkpoint only when the last check is older than the TTL. */
  get(): Promise<ExportBundle>
  /** The cached bundle, if any (never reads). */
  peek(): ExportBundle | null
  /** Forget the cache (next get() re-reads). */
  invalidate(): void
}

/**
 * The checkpoint is re-read at most once per TTL (10 min): within the TTL every
 * request is served from memory; after it, an unchanged file (same mtime and
 * size) keeps the cached bundle. A failed refresh keeps serving the previous
 * bundle and is retried after 60 s; with no bundle yet, failures are cached for
 * 60 s too (no re-read storm on a missing or damaged file).
 */
export function createWeightsExporter(opts: WeightsExporterOptions): WeightsExporter {
  const ttl = Math.max(0, opts.ttlMs ?? EXPORT_TTL_MS)
  const now = opts.now ?? Date.now
  const stat = opts.stat ?? ((f: string) => fsp.stat(f))
  const read = opts.read ?? readCheckpoint
  const log = opts.log ?? (() => {})
  let cache: { bundle: ExportBundle; mtimeMs: number; size: number } | null = null
  let nextCheckAt = 0
  let failure: { error: Error; until: number } | null = null
  let inflight: Promise<ExportBundle> | null = null

  async function refresh(): Promise<ExportBundle> {
    const t = now()
    try {
      let st: { mtimeMs: number; size: number }
      try {
        st = await stat(opts.ckptPath)
      } catch (e) {
        throw errCode(e) === 'ENOENT' ? new NoCheckpointError() : e
      }
      if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
        nextCheckAt = t + ttl
        return cache.bundle
      }
      const ck = await read(opts.ckptPath)
      const bundle = buildExport(ck, { license: opts.license })
      if (!cache || cache.bundle.sha256 !== bundle.sha256) log('info', `weights export: step ${bundle.step}, ${bundle.bytes} bytes, sha256 ${bundle.sha256.slice(0, 12)}…`)
      cache = { bundle, mtimeMs: st.mtimeMs, size: st.size }
      failure = null
      nextCheckAt = t + ttl
      return bundle
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      if (cache) {
        log('warn', `weights export refresh failed (${errMsg(error)}); serving step ${cache.bundle.step}`)
        nextCheckAt = t + Math.min(ttl, FAILED_RETRY_MS)
        return cache.bundle
      }
      if (!(error instanceof NoCheckpointError)) log('warn', `weights export unavailable: ${errMsg(error)}`)
      failure = { error, until: t + Math.min(ttl, FAILED_RETRY_MS) }
      throw error
    }
  }

  return {
    get() {
      const t = now()
      if (cache && t < nextCheckAt) return Promise.resolve(cache.bundle)
      if (!cache && failure && t < failure.until) return Promise.reject(failure.error)
      if (!inflight) {
        inflight = refresh().finally(() => {
          inflight = null
        })
      }
      return inflight
    },
    peek: () => cache?.bundle ?? null,
    invalidate() {
      cache = null
      failure = null
      nextCheckAt = 0
    },
  }
}

// ─── HTTP routes (wired by server/http.ts, see WIRING.md) ───────────────────

export interface ModelRouteDeps {
  exporter: WeightsExporter
  /** Rate limiter: ms the caller must wait (0 = allowed). */
  take?: (req: IncomingMessage) => number
}

function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  const body = JSON.stringify({ error: message })
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

/** True when an If-None-Match header lists `etag` (weak comparison, as RFC 9110 requires for 304). */
function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false
  const v = Array.isArray(header) ? header.join(',') : header
  if (v.trim() === '*') return true
  const bare = etag.replace(/^W\//, '')
  return v.split(',').some((t) => t.trim().replace(/^W\//, '') === bare)
}

/**
 * GET|HEAD /api/model/weights.safetensors   the newest checkpoint as safetensors (attachment)
 * GET|HEAD /api/model/manifest.json         { name, params, arch, vocab, ctx, version, step, loss, val,
 *                                             sha256, bytes, updatedAt, license, … }
 * Both: ETag + Cache-Control public, max-age=600; If-None-Match → 304.
 * Returns false (nothing written) for any other path.
 */
export async function handleModelRoute(p: string, req: IncomingMessage, res: ServerResponse, deps: ModelRouteDeps): Promise<boolean> {
  if (p !== WEIGHTS_ROUTE && p !== MANIFEST_ROUTE) return false
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    sendError(res, 405, 'method not allowed', { Allow: 'GET, HEAD' })
    return true
  }
  const wait = deps.take ? deps.take(req) : 0
  if (wait > 0) {
    sendError(res, 429, 'too many model requests — slow down', { 'Retry-After': String(Math.ceil(wait / 1000)) })
    return true
  }
  let bundle: ExportBundle
  try {
    bundle = await deps.exporter.get()
  } catch (e) {
    if (e instanceof NoCheckpointError) sendError(res, 503, 'no SEPIA-0 checkpoint has been saved yet', { 'Retry-After': '60' })
    else sendError(res, 503, 'model export is unavailable right now', { 'Retry-After': '60' })
    return true
  }
  const weights = p === WEIGHTS_ROUTE
  const etag = weights ? `"${bundle.sha256}"` : bundle.manifestEtag
  const common: Record<string, string> = {
    ETag: etag,
    'Cache-Control': 'public, max-age=600',
    'Last-Modified': new Date(bundle.savedAt).toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  }
  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, common)
    res.end()
    return true
  }
  const body = weights ? bundle.safetensors : Buffer.from(bundle.manifestJson, 'utf8')
  res.writeHead(200, {
    ...common,
    'Content-Type': weights ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...(weights ? { 'Content-Disposition': `attachment; filename="sepia-0-step-${bundle.step}.safetensors"` } : {}),
  })
  if (method === 'HEAD') res.end()
  else res.end(body)
  return true
}

/** Factory form: (p, req, res) => handleModelRoute(p, req, res, deps). */
export function createModelRouteHandler(deps: ModelRouteDeps) {
  return (p: string, req: IncomingMessage, res: ServerResponse) => handleModelRoute(p, req, res, deps)
}
