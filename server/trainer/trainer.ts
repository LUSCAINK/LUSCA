// SEPIA-0 trainer — main-thread side.
//
// Really trains a tiny character-level language model (char-MLP, see
// model.mjs) live on the text the crawler accepts. The heavy lifting happens
// in a worker thread (worker.mjs) so the crawler's event loop never blocks;
// this module owns everything the rest of the server reads synchronously
// (model info, loss history, samples), batches corpus feeds to the worker,
// persists checkpoints to <dataDir>/sepia.ckpt and restores them on start.
//
// Checkpoint file layout (little-endian):
//   "SEPIACK1" | u32 headerLen | header JSON (utf8) | pad to 8 |
//   f32 params[N] | f32 adam.m[N] | f32 adam.v[N] | f64 history[count×5]
// where each history row is (step, loss, val|NaN, tokens, ts).
//
// Checkpoint safety: writes go to sepia.ckpt.tmp (fsync'd), the previous file is
// kept as sepia.ckpt.bak, and the tmp is renamed over sepia.ckpt (retried; the live
// file is never overwritten in place). Only ENOENT means "no checkpoint yet": any
// other read error disables checkpoint writes for this process so an existing
// file is never replaced by fresh weights, and an undecodable file is moved aside
// (sepia.ckpt.corrupt-<ts>) before sepia.ckpt.tmp and sepia.ckpt.bak are tried.
import { Worker } from 'node:worker_threads'
import { createReadStream, promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { createInterface } from 'node:readline'
import { performance } from 'node:perf_hooks'
import type { LossPoint, ModelInfo, TrainJob } from '../../shared/protocol.ts'
import type { TrainerApi, TrainerOptions, TrainStats } from '../contracts.ts'
import { CTX, EMB, HIDDEN, VOCAB_SIZE, SepiaModel, generateText, mulberry32, paramCount } from './model.mjs'

const NAME = 'SEPIA-0'
const ARCH = `char-MLP · ctx ${CTX} · emb ${EMB} · hidden ${HIDDEN} · tanh`
const PARAMS = paramCount()

const CKPT_FILE = 'sepia.ckpt'
const DATASET_FILE = 'dataset.jsonl'
const CKPT_MAGIC = 'SEPIACK1'
const CKPT_VERSION = 1
const CKPT_EVERY_MS = 90_000

const MAX_HISTORY = 200_000 // beyond this the oldest half is merged pairwise
const MAX_RETURN_POINTS = 1000
const MAX_SAMPLES = 20
const MIN_DOC_CHARS = 48
const MAX_DOC_CHARS = 1_000_000 // a single page longer than this is truncated
const FEED_FLUSH_CHARS = 1_000_000
const FEED_FLUSH_MS = 100
const MAX_PENDING_CHARS = 32_000_000 // feeds queued while the worker is down
// Corpus cap is 24M chars; reading the last 64 MB of dataset.jsonl covers it
// with headroom for JSON escaping and the other record fields.
const RELOAD_TAIL_BYTES = 64 * 1024 * 1024
const GEN_TIMEOUT_MS = 20_000
const SNAPSHOT_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 10_000
const MAX_GEN_CHARS = 600
const MAX_PROMPT_CHARS = 400
const TRAIN_ISSUE_TIMEOUT_MS = 10_000
// A forced full audit can wait for CPU budget behind other audits; keep this generous.
const TRAIN_SUBMIT_TIMEOUT_MS = 300_000
const TRAIN_STATS_FRESH_MS = 15_000
const RETRYABLE_FS = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE'])

interface Snapshot {
  step: number
  adamT: number
  params: Float32Array
  m: Float32Array
  v: Float32Array
  /** GPU-pipeline counters (worker.mjs persistedTrain()); absent in pre-GPU checkpoints. */
  train?: unknown
}

type TrainVerdict = Awaited<ReturnType<TrainerApi['submitTrainResult']>>

/** Worker trainStats(): the ModelInfo counters plus pipeline diagnostics. */
interface WorkerTrainStats extends TrainStats {
  rejected?: number
  stale?: number
  issued?: number
  pendingJobs?: number
  auditQueue?: number
  auditBudgetMs?: number
  auditMsPerRow?: number | null
  snapshots?: number
  snapshotMB?: number
  samplesSeen?: number
  gpuEnabled?: boolean
}

interface Sample {
  step: number
  text: string
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const log = (msg: string) => console.log(`[sepia] ${msg}`)
const warn = (msg: string) => console.warn(`[sepia] ${msg}`)
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const r4 = (x: number) => Math.round(x * 1e4) / 1e4
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
const num = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d)
const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? ''

function isSnapshot(x: unknown): x is Snapshot {
  return (
    isObj(x) &&
    x.params instanceof Float32Array &&
    x.params.length === PARAMS &&
    x.m instanceof Float32Array &&
    x.m.length === PARAMS &&
    x.v instanceof Float32Array &&
    x.v.length === PARAMS &&
    typeof x.step === 'number'
  )
}

// ─── Loss-history helpers ───────────────────────────────────────────────────

/**
 * ≤ max points, evenly bucketed over the whole run. Each bucket reports the
 * mean train loss and mean val (when the bucket holds any) at the bucket's
 * last step, which is exactly what a LossPoint means at a coarser cadence.
 * The newest point is always returned verbatim as the final element.
 */
function downsample(h: LossPoint[], max: number): LossPoint[] {
  const n = h.length
  if (n <= max) return h.slice()
  const out: LossPoint[] = []
  const body = n - 1
  const buckets = max - 1
  for (let k = 0; k < buckets; k++) {
    const a = Math.floor((k * body) / buckets)
    const b = Math.floor(((k + 1) * body) / buckets)
    let ls = 0
    let vs = 0
    let vn = 0
    for (let i = a; i < b; i++) {
      ls += h[i].loss
      const v = h[i].val
      if (v !== null) {
        vs += v
        vn++
      }
    }
    const last = h[b - 1]
    out.push({ step: last.step, loss: r4(ls / (b - a)), val: vn ? r4(vs / vn) : null, tokens: last.tokens, ts: last.ts })
  }
  out.push({ ...h[n - 1] })
  return out
}

/** Halve the resolution of the oldest half of the history (bounded memory). */
function compactHistory(h: LossPoint[]): LossPoint[] {
  const half = Math.floor(h.length / 2) & ~1
  const merged: LossPoint[] = []
  for (let i = 0; i < half; i += 2) {
    const a = h[i]
    const b = h[i + 1]
    const val = a.val !== null && b.val !== null ? r4((a.val + b.val) / 2) : (b.val ?? a.val)
    merged.push({ step: b.step, loss: r4((a.loss + b.loss) / 2), val, tokens: b.tokens, ts: b.ts })
  }
  return merged.concat(h.slice(half))
}

// ─── Checkpoint (de)serialization ───────────────────────────────────────────

interface CkptHeader {
  version: number
  name: string
  T: number
  E: number
  H: number
  V: number
  nParams: number
  step: number
  adamT: number
  historyCount: number
  samples: Sample[]
  savedAt: number
  /** GPU-pipeline counters; optional so version-1 checkpoints without it still load. */
  train?: unknown
}

function encodeCheckpoint(snap: Snapshot, history: LossPoint[], samples: Sample[]): Buffer {
  const hist = history.filter((p) => p.step <= snap.step)
  const header: CkptHeader = {
    version: CKPT_VERSION,
    name: NAME,
    T: CTX,
    E: EMB,
    H: HIDDEN,
    V: VOCAB_SIZE,
    nParams: PARAMS,
    step: snap.step,
    adamT: snap.adamT,
    historyCount: hist.length,
    samples: samples.filter((s) => s.step <= snap.step).slice(0, MAX_SAMPLES),
    savedAt: Date.now(),
    train: snap.train,
  }
  const hj = Buffer.from(JSON.stringify(header), 'utf8')
  const pre = 8 + 4 + hj.length
  const dataOff = pre + ((8 - (pre % 8)) % 8)
  const f32Bytes = PARAMS * 4
  const histOff = dataOff + 3 * f32Bytes
  const histOffAligned = histOff + ((8 - (histOff % 8)) % 8)
  const buf = Buffer.alloc(histOffAligned + hist.length * 5 * 8)
  buf.write(CKPT_MAGIC, 0, 'latin1')
  buf.writeUInt32LE(hj.length, 8)
  hj.copy(buf, 12)
  let off = dataOff
  for (const a of [snap.params, snap.m, snap.v]) {
    Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(buf, off)
    off += a.byteLength
  }
  const rows = new Float64Array(hist.length * 5)
  for (let i = 0; i < hist.length; i++) {
    const p = hist[i]
    rows[i * 5] = p.step
    rows[i * 5 + 1] = p.loss
    rows[i * 5 + 2] = p.val === null ? Number.NaN : p.val
    rows[i * 5 + 3] = p.tokens
    rows[i * 5 + 4] = p.ts
  }
  Buffer.from(rows.buffer).copy(buf, histOffAligned)
  return buf
}

function readF32(buf: Buffer, off: number, n: number): Float32Array {
  const out = new Float32Array(n)
  new Uint8Array(out.buffer).set(buf.subarray(off, off + n * 4))
  return out
}

function decodeCheckpoint(buf: Buffer): { snap: Snapshot; history: LossPoint[]; samples: Sample[] } {
  if (buf.length < 12 || buf.toString('latin1', 0, 8) !== CKPT_MAGIC) throw new Error('bad magic')
  const hl = buf.readUInt32LE(8)
  if (12 + hl > buf.length) throw new Error('truncated header')
  const header = JSON.parse(buf.toString('utf8', 12, 12 + hl)) as Partial<CkptHeader>
  if (header.version !== CKPT_VERSION) throw new Error(`unsupported version ${String(header.version)}`)
  if (header.T !== CTX || header.E !== EMB || header.H !== HIDDEN || header.V !== VOCAB_SIZE || header.nParams !== PARAMS) {
    throw new Error('architecture mismatch')
  }
  const pre = 12 + hl
  const dataOff = pre + ((8 - (pre % 8)) % 8)
  const f32Bytes = PARAMS * 4
  const histOff = dataOff + 3 * f32Bytes
  const histOffAligned = histOff + ((8 - (histOff % 8)) % 8)
  const count = Math.max(0, Math.floor(num(header.historyCount)))
  if (histOffAligned + count * 40 > buf.length) throw new Error('truncated body')
  const params = readF32(buf, dataOff, PARAMS)
  const m = readF32(buf, dataOff + f32Bytes, PARAMS)
  const v = readF32(buf, dataOff + 2 * f32Bytes, PARAMS)
  for (let i = 0; i < PARAMS; i++) {
    if (!Number.isFinite(params[i]) || !Number.isFinite(m[i]) || !Number.isFinite(v[i])) throw new Error('non-finite weights')
  }
  const rows = new Float64Array(count * 5)
  new Uint8Array(rows.buffer).set(buf.subarray(histOffAligned, histOffAligned + count * 40))
  const history: LossPoint[] = []
  for (let i = 0; i < count; i++) {
    const val = rows[i * 5 + 2]
    history.push({ step: rows[i * 5], loss: rows[i * 5 + 1], val: Number.isNaN(val) ? null : val, tokens: rows[i * 5 + 3], ts: rows[i * 5 + 4] })
  }
  const samples = Array.isArray(header.samples)
    ? header.samples.filter((s): s is Sample => isObj(s) && typeof s.step === 'number' && typeof s.text === 'string').slice(0, MAX_SAMPLES)
    : []
  const step = Math.max(0, Math.floor(num(header.step)))
  const train = isObj(header.train) ? header.train : undefined
  return { snap: { step, adamT: Math.max(0, Math.floor(num(header.adamT, step))), params, m, v, train }, history, samples }
}

// ─── Trainer ────────────────────────────────────────────────────────────────

export function createTrainer(opts: TrainerOptions): TrainerApi {
  const dataDir = path.resolve(opts.dataDir)
  const ckptPath = path.join(dataDir, CKPT_FILE)
  const datasetPath = path.join(dataDir, DATASET_FILE)

  const emit = (msg: Parameters<TrainerOptions['emit']>[0]) => {
    try {
      opts.emit(msg)
    } catch (e) {
      warn(`emit failed: ${errMsg(e)}`)
    }
  }

  // Observable state (read synchronously by the rest of the server).
  let history: LossPoint[] = []
  let sampleList: Sample[] = []
  let step = 0
  let lastLoss = Math.log(VOCAB_SIZE) // the loss of the near-uniform initial softmax
  let lastVal: number | null = null
  let corpusChars = 0
  let sps = 0
  let lastLossAt = 0
  let dsCache: { len: number; step: number; out: LossPoint[] } | null = null
  let tstats: WorkerTrainStats = { version: 0, gpuSteps: 0, serverSteps: 0, gpuSamples: 0, contributors24h: 0, audits: { ok: 0, failed: 0 }, gpuStepsPerMin: 0 }
  let tstatsAt = 0
  let gpuEnabled = false

  // Worker lifecycle.
  let worker: Worker | null = null
  let ready = false
  let bootGen = 0 // bumps on every spawn/stop; stale callbacks compare against it
  let running = false
  let stopping = false
  let stopP: Promise<void> | null = null
  let spawnedAt = 0
  let failures = 0
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let ckptTimer: ReturnType<typeof setInterval> | null = null
  let lastSnap: Snapshot | null = null // newest weights known on this thread
  let savedStep = -1
  let savingP: Promise<boolean> | null = null
  let ckptWritesDisabled = false // an existing checkpoint could not be read: never overwrite it
  let warnedDisabled = false

  // Requests to the worker.
  let reqSeq = 0
  const reqs = new Map<number, Pending>()

  // Corpus feed queue.
  let pending: string[] = []
  let pendingChars = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  // Main-thread model used for generate() while no worker is available.
  let fallback: { model: SepiaModel; step: number } | null = null

  function failAll(reason: string) {
    for (const [id, p] of reqs) {
      clearTimeout(p.timer)
      reqs.delete(id)
      p.reject(new Error(reason))
    }
  }

  function request(
    op: 'gen' | 'snapshot' | 'stop' | 'train.issue' | 'train.submit' | 'train.stats',
    payload: Record<string, unknown>,
    timeoutMs: number,
    transfer: ArrayBuffer[] = [],
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const w = worker
      if (!w || !ready) {
        reject(new Error('trainer worker not ready'))
        return
      }
      const id = ++reqSeq
      const timer = setTimeout(() => {
        reqs.delete(id)
        reject(new Error(`worker ${op} timed out after ${timeoutMs} ms`))
      }, timeoutMs) // deliberately ref'd: an awaited request keeps the process alive until it settles
      reqs.set(id, { resolve, reject, timer })
      try {
        w.postMessage({ ...payload, type: 'req', id, op }, transfer)
      } catch (e) {
        clearTimeout(timer)
        reqs.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  // ── feeds ──

  function flushFeeds() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    const w = worker
    if (!w || !ready || pending.length === 0) return
    const texts = pending
    pending = []
    pendingChars = 0
    try {
      w.postMessage({ type: 'feed', texts })
    } catch (e) {
      warn(`feed post failed: ${errMsg(e)}`)
    }
  }

  function enqueue(text: string) {
    const t = text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text
    if (t.length < MIN_DOC_CHARS) return
    pending.push(t)
    pendingChars += t.length
    while (pendingChars > MAX_PENDING_CHARS && pending.length > 1) pendingChars -= pending.shift()!.length
    if (pendingChars >= FEED_FLUSH_CHARS) flushFeeds()
    else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        flushFeeds()
      }, FEED_FLUSH_MS)
      flushTimer.unref()
    }
  }

  /** Re-feed the persisted dataset (the crawler does not replay it through onText). */
  async function reloadDataset(gen: number) {
    let size = 0
    try {
      size = (await fsp.stat(datasetPath)).size
    } catch {
      return // no dataset yet
    }
    if (size <= 0) return
    const start = Math.max(0, size - RELOAD_TAIL_BYTES)
    const t0 = performance.now()
    let docs = 0
    let chars = 0
    let bad = 0
    // Read only up to the size seen now: records appended later reach us via feed().
    const stream = createReadStream(datasetPath, { start, end: size - 1, encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    let skipFirst = start > 0 // starting mid-file: the first line is partial
    try {
      for await (const line of rl) {
        if (gen !== bootGen || stopping) break
        if (skipFirst) {
          skipFirst = false
          continue
        }
        if (line.length < 2 || line.charCodeAt(0) !== 123 /* { */) continue
        try {
          const rec: unknown = JSON.parse(line)
          if (isObj(rec) && typeof rec.text === 'string') {
            enqueue(rec.text)
            docs++
            chars += rec.text.length
          }
        } catch {
          bad++
        }
      }
    } catch (e) {
      warn(`dataset reload failed: ${errMsg(e)}`)
    } finally {
      rl.close()
      stream.destroy()
    }
    flushFeeds()
    log(
      `reloaded ${docs} docs (${(chars / 1e6).toFixed(2)}M chars) from ${DATASET_FILE}` +
        `${start > 0 ? ' (tail)' : ''} in ${Math.round(performance.now() - t0)} ms${bad ? `, ${bad} bad lines` : ''}`,
    )
  }

  // ── worker messages ──

  function takeTrainStats(x: unknown) {
    if (!isObj(x)) return
    const a = isObj(x.audits) ? x.audits : {}
    tstats = {
      ...(x as Partial<WorkerTrainStats>),
      version: num(x.version, step),
      gpuSteps: num(x.gpuSteps),
      serverSteps: num(x.serverSteps),
      gpuSamples: num(x.gpuSamples),
      contributors24h: num(x.contributors24h),
      audits: { ok: num(a.ok), failed: num(a.failed) },
      gpuStepsPerMin: num(x.gpuStepsPerMin),
    }
    tstatsAt = Date.now()
  }

  function onWorkerMessage(msg: unknown) {
    if (!isObj(msg)) return
    switch (msg.type) {
      case 'ready': {
        ready = true
        spawnedAt = Date.now()
        step = Math.max(step, num(msg.step))
        gpuEnabled = msg.gpu === true
        if (!gpuEnabled) warn('GPU training jobs disabled (shared/sepia unavailable in the worker)')
        log(msg.restored ? `worker ready — resumed at step ${num(msg.step)}` : 'worker ready — fresh weights')
        flushFeeds()
        const gen = bootGen
        reloadDataset(gen).catch((e) => warn(`dataset reload failed: ${errMsg(e)}`))
        if (!ckptTimer) {
          ckptTimer = setInterval(() => void saveCheckpoint(), CKPT_EVERY_MS)
          ckptTimer.unref()
        }
        break
      }
      case 'corpus':
        corpusChars = num(msg.chars, corpusChars)
        break
      case 'loss': {
        const p = msg.point
        if (!isObj(p)) break
        const point: LossPoint = {
          step: num(p.step),
          loss: r4(num(p.loss)),
          val: typeof p.val === 'number' && Number.isFinite(p.val) ? r4(p.val) : null,
          tokens: num(p.tokens),
          ts: num(p.ts, Date.now()),
        }
        step = point.step
        lastLoss = point.loss
        if (point.val !== null) lastVal = point.val
        sps = num(msg.stepsPerSec)
        corpusChars = num(msg.corpusChars, corpusChars)
        takeTrainStats(msg.train)
        lastLossAt = Date.now()
        history.push(point)
        if (history.length > MAX_HISTORY) history = compactHistory(history)
        emit({ t: 'loss', point, model: info() })
        break
      }
      case 'train':
        takeTrainStats(msg.train)
        break
      case 'sample': {
        if (typeof msg.text !== 'string') break
        const s: Sample = { step: num(msg.step), text: msg.text }
        sampleList.unshift(s)
        if (sampleList.length > MAX_SAMPLES) sampleList.length = MAX_SAMPLES
        emit({ t: 'sample', step: s.step, text: s.text })
        break
      }
      case 'res': {
        const id = num(msg.id, -1)
        const p = reqs.get(id)
        if (!p) break
        reqs.delete(id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.data)
        else p.reject(new Error(typeof msg.error === 'string' ? msg.error : 'worker request failed'))
        break
      }
      case 'log': {
        const text = `[worker] ${String(msg.msg)}`
        if (msg.level === 'info') log(text)
        else warn(text)
        break
      }
    }
  }

  // ── lifecycle ──

  function spawn() {
    const gen = ++bootGen
    ready = false
    let w: Worker
    try {
      w = new Worker(new URL('./worker.mjs', import.meta.url))
    } catch (e) {
      warn(`could not start worker: ${errMsg(e)}`)
      scheduleRestart()
      return
    }
    worker = w
    w.unref() // never keep the process alive on its own
    w.on('message', (m: unknown) => {
      if (gen !== bootGen) return
      try {
        onWorkerMessage(m)
      } catch (e) {
        warn(`worker message handling failed: ${errMsg(e)}`)
      }
    })
    w.on('error', (e) => warn(`worker error: ${errMsg(e)}`))
    w.on('exit', (code) => {
      if (gen !== bootGen) return
      worker = null
      ready = false
      failAll('trainer worker exited')
      if (running && !stopping) {
        warn(`worker exited unexpectedly (code ${code}) — restarting from the last checkpoint`)
        scheduleRestart()
      }
    })

    // Send the init message with COPIES of the checkpoint (lastSnap stays
    // usable for fallback sampling and for restarts).
    let ckpt: Snapshot | undefined
    const transfer: ArrayBuffer[] = []
    if (lastSnap) {
      ckpt = { step: lastSnap.step, adamT: lastSnap.adamT, params: lastSnap.params.slice(), m: lastSnap.m.slice(), v: lastSnap.v.slice(), train: lastSnap.train }
      transfer.push(ckpt.params.buffer as ArrayBuffer, ckpt.m.buffer as ArrayBuffer, ckpt.v.buffer as ArrayBuffer)
    }
    try {
      w.postMessage({ type: 'init', seed: (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0, ckpt }, transfer)
    } catch (e) {
      warn(`worker init failed: ${errMsg(e)}`)
      void w.terminate().catch(() => {})
    }
  }

  function scheduleRestart() {
    if (!running || stopping || restartTimer) return
    if (spawnedAt && Date.now() - spawnedAt > 120_000) failures = 0
    const wait = Math.min(60_000, 2000 * 2 ** failures)
    failures++
    // Roll observable state back to the checkpoint the new worker resumes from.
    const resumeStep = lastSnap ? lastSnap.step : 0
    history = history.filter((p) => p.step <= resumeStep)
    sampleList = sampleList.filter((s) => s.step <= resumeStep)
    step = resumeStep
    lastLoss = history.length ? history[history.length - 1].loss : Math.log(VOCAB_SIZE)
    lastVal = null
    for (let i = history.length - 1; i >= 0; i--) {
      const v = history[i].val
      if (v !== null) {
        lastVal = v
        break
      }
    }
    corpusChars = 0
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (running && !stopping) spawn()
    }, wait)
    restartTimer.unref()
  }

  /** Read a file, retrying transient lock errors (antivirus / backup on Windows). */
  async function readWithRetry(file: string): Promise<{ ok: true; buf: Buffer } | { ok: false; code: string; msg: string }> {
    let last: unknown = null
    for (let i = 0; i < 6; i++) {
      try {
        return { ok: true, buf: await fsp.readFile(file) }
      } catch (e) {
        last = e
        if (!RETRYABLE_FS.has(errCode(e))) break
        await delay(100 * 2 ** i)
      }
    }
    return { ok: false, code: errCode(last) || 'EUNKNOWN', msg: errMsg(last) }
  }

  function applyCheckpoint(ck: ReturnType<typeof decodeCheckpoint>) {
    lastSnap = ck.snap
    savedStep = ck.snap.step
    history = ck.history
    sampleList = ck.samples
    step = ck.snap.step
    if (history.length) lastLoss = history[history.length - 1].loss
    for (let i = history.length - 1; i >= 0; i--) {
      const v = history[i].val
      if (v !== null) {
        lastVal = v
        break
      }
    }
  }

  async function loadCheckpoint(): Promise<boolean> {
    const r = await readWithRetry(ckptPath)
    if (!r.ok) {
      if (r.code === 'ENOENT') return false // no checkpoint yet
      ckptWritesDisabled = true
      warn(`cannot read ${CKPT_FILE} (${r.code}: ${r.msg}) — training from fresh weights with checkpoint writes DISABLED so the existing file is never overwritten; fix it and restart`)
      return false
    }
    try {
      applyCheckpoint(decodeCheckpoint(r.buf))
      log(`restored ${CKPT_FILE}: step ${step}, ${history.length} loss points, ${sampleList.length} samples`)
      return true
    } catch (e) {
      const aside = `${ckptPath}.corrupt-${Date.now()}`
      let moved = true
      try {
        await fsp.rename(ckptPath, aside)
      } catch {
        moved = false
      }
      warn(`unreadable ${CKPT_FILE} (${errMsg(e)})${moved ? ` — kept as ${path.basename(aside)}` : ''}`)
    }
    for (const f of [`${ckptPath}.tmp`, `${ckptPath}.bak`]) {
      const rr = await readWithRetry(f)
      if (!rr.ok) continue
      try {
        applyCheckpoint(decodeCheckpoint(rr.buf))
        savedStep = -1 // rewrite sepia.ckpt from the recovered copy at the next save
        log(`restored ${path.basename(f)}: step ${step}, ${history.length} loss points, ${sampleList.length} samples`)
        return true
      } catch (e) {
        warn(`ignoring unreadable ${path.basename(f)} (${errMsg(e)})`)
      }
    }
    warn('no usable checkpoint backup — starting fresh')
    return false
  }

  async function writeCheckpoint(snap: Snapshot) {
    if (ckptWritesDisabled) throw new Error(`checkpoint writes disabled (existing ${CKPT_FILE} could not be read at boot)`)
    const buf = encodeCheckpoint(snap, history, sampleList)
    await fsp.mkdir(dataDir, { recursive: true })
    const tmp = `${ckptPath}.tmp`
    const fh = await fsp.open(tmp, 'w')
    try {
      await fh.writeFile(buf)
      await fh.sync() // durable before it can replace the live checkpoint
    } finally {
      await fh.close()
    }
    try {
      await fsp.copyFile(ckptPath, `${ckptPath}.bak`)
    } catch (e) {
      if (errCode(e) !== 'ENOENT') warn(`checkpoint backup failed: ${errMsg(e)}`)
    }
    for (let i = 0; ; i++) {
      try {
        await fsp.rename(tmp, ckptPath)
        break
      } catch (e) {
        // Windows can transiently refuse to replace a file (AV scanners, open handles).
        // Never copy over the live checkpoint: give up on this save (the complete tmp
        // stays as a recovery copy) and let the next interval try again.
        if (i >= 8 || !RETRYABLE_FS.has(errCode(e))) throw new Error(`could not replace ${CKPT_FILE} (${errCode(e) || errMsg(e)}); previous checkpoint kept, retrying next interval`)
        await delay(150 * (i + 1))
      }
    }
    try {
      const dfd = await fsp.open(dataDir, 'r')
      try {
        await dfd.sync()
      } finally {
        await dfd.close()
      }
    } catch {
      /* directory fsync unsupported (Windows) */
    }
    savedStep = snap.step
  }

  async function doSave(): Promise<boolean> {
    if (!worker || !ready) return false
    if (step === savedStep) return false // nothing new since the last save
    if (ckptWritesDisabled) {
      if (!warnedDisabled) warn(`checkpoint writes are disabled for this run (${CKPT_FILE} was unreadable at boot)`)
      warnedDisabled = true
      return false
    }
    try {
      const snap = await request('snapshot', {}, SNAPSHOT_TIMEOUT_MS)
      if (!isSnapshot(snap)) throw new Error('malformed snapshot')
      lastSnap = snap
      await writeCheckpoint(snap)
      return true
    } catch (e) {
      warn(`checkpoint failed: ${errMsg(e)}`)
      return false
    }
  }

  function saveCheckpoint(): Promise<boolean> {
    if (savingP) return savingP
    const p = doSave().finally(() => {
      if (savingP === p) savingP = null
    })
    savingP = p
    return p
  }

  async function boot() {
    try {
      await fsp.mkdir(dataDir, { recursive: true })
    } catch (e) {
      warn(`cannot create ${dataDir}: ${errMsg(e)}`)
    }
    if (!lastSnap) await loadCheckpoint()
    if (!running || stopping) return
    spawn()
  }

  function fallbackModel(): SepiaModel {
    const want = lastSnap ? lastSnap.step : -1
    if (!fallback || fallback.step !== want) {
      const m = new SepiaModel()
      if (lastSnap) m.load(lastSnap.params)
      else m.init(mulberry32(0x5e91a))
      fallback = { model: m, step: want }
    }
    return fallback.model
  }

  // ── public API ──

  function trainStats(): TrainStats {
    const fresh = Date.now() - tstatsAt < TRAIN_STATS_FRESH_MS
    return {
      version: Math.max(step, tstats.version),
      gpuSteps: tstats.gpuSteps,
      serverSteps: tstats.serverSteps,
      gpuSamples: tstats.gpuSamples,
      contributors24h: tstats.contributors24h,
      audits: { ok: tstats.audits.ok, failed: tstats.audits.failed },
      gpuStepsPerMin: fresh && worker && ready ? tstats.gpuStepsPerMin : 0,
    }
  }

  function info(): ModelInfo {
    return {
      name: NAME,
      params: PARAMS,
      arch: ARCH,
      vocab: VOCAB_SIZE,
      step,
      loss: r4(lastLoss),
      val: lastVal,
      corpusChars,
      stepsPerSec: Date.now() - lastLossAt < 15_000 ? Math.round(sps * 10) / 10 : 0,
      ...trainStats(),
    }
  }

  function isVerdict(x: unknown): x is TrainVerdict {
    return isObj(x) && typeof x.verdict === 'string' && typeof x.reason === 'string' && typeof x.flops === 'number' && typeof x.audited === 'boolean'
  }

  const api: TrainerApi = {
    start() {
      if (stopP) {
        // A stop is in flight: start again once it has fully settled.
        void stopP.then(() => api.start())
        return
      }
      if (running) return
      running = true
      stopping = false
      failures = 0
      boot().catch((e) => warn(`boot failed: ${errMsg(e)}`))
    },

    stop() {
      if (stopP) return stopP
      if (!running && !worker) return Promise.resolve()
      stopping = true
      const p = (async () => {
        if (restartTimer) clearTimeout(restartTimer)
        restartTimer = null
        if (ckptTimer) clearInterval(ckptTimer)
        ckptTimer = null
        try {
          if (savingP) await savingP
        } catch {
          /* already logged */
        }
        const w = worker
        if (w && ready) {
          try {
            const snap = await request('stop', {}, STOP_TIMEOUT_MS)
            if (!isSnapshot(snap)) throw new Error('malformed snapshot')
            lastSnap = snap
            await writeCheckpoint(snap)
            log(`checkpoint saved at step ${snap.step}`)
          } catch (e) {
            warn(`final checkpoint failed: ${errMsg(e)}`)
          }
        }
        bootGen++ // ignore anything the dying worker still sends
        worker = null
        ready = false
        failAll('trainer stopped')
        if (w) {
          try {
            await w.terminate()
          } catch {
            /* already gone */
          }
        }
        running = false
        sps = 0
      })()
        .catch((e) => warn(`stop failed: ${errMsg(e)}`))
        .finally(() => {
          stopping = false
          stopP = null
        })
      stopP = p
      return p
    },

    feed(text: string) {
      try {
        if (typeof text === 'string' && text.length > 0) enqueue(text)
      } catch (e) {
        warn(`feed failed: ${errMsg(e)}`)
      }
    },

    info,

    async issueTrainJob(req) {
      if (!worker || !ready || !gpuEnabled || stopping) return null
      try {
        const job = await request(
          'train.issue',
          { neuronKey: String(req?.neuronKey ?? ''), batch: num(req?.batch, 128), haveVersion: typeof req?.haveVersion === 'number' ? req.haveVersion : null },
          TRAIN_ISSUE_TIMEOUT_MS,
        )
        return isObj(job) && job.kind === 'train' ? (job as unknown as TrainJob) : null
      } catch (e) {
        warn(`train job issue failed: ${errMsg(e)}`)
        return null
      }
    },

    async submitTrainResult(req) {
      // Worker unavailable (restart) or an internal error: never the neuron's fault, so no INK and no strike.
      if (!worker || !ready) return { verdict: 'stale', reason: 'trainer restarting', flops: 0, audited: false }
      const g = req?.grad
      if (!(g instanceof Uint8Array)) return { verdict: 'rejected', reason: 'missing gradient', flops: 0, audited: false }
      const grad = g.slice() // the transfer must never detach the caller's buffer
      try {
        const v = await request(
          'train.submit',
          { neuronKey: String(req.neuronKey ?? ''), jobId: String(req.jobId ?? ''), grad, loss: Number(req.loss), forceAudit: req.forceAudit === true },
          TRAIN_SUBMIT_TIMEOUT_MS,
          [grad.buffer as ArrayBuffer],
        )
        if (!isVerdict(v)) throw new Error('malformed verdict')
        return v
      } catch (e) {
        warn(`train result check failed: ${errMsg(e)}`)
        return { verdict: 'stale', reason: `trainer error: ${errMsg(e)}`, flops: 0, audited: false }
      }
    },

    trainStats,

    lossHistory() {
      const last = history.length ? history[history.length - 1].step : -1
      if (!dsCache || dsCache.len !== history.length || dsCache.step !== last) {
        dsCache = { len: history.length, step: last, out: downsample(history, MAX_RETURN_POINTS) }
      }
      return dsCache.out.map((p) => ({ ...p }))
    },

    samples() {
      return sampleList.slice(0, MAX_SAMPLES).map((s) => ({ ...s }))
    },

    async generate(prompt: string, n: number, temperature: number) {
      const t0 = performance.now()
      // Inputs may come straight from a REST body: coerce and clamp defensively.
      const p = typeof prompt === 'string' ? prompt.slice(0, MAX_PROMPT_CHARS) : ''
      const nn = Number(n)
      const count = Number.isFinite(nn) && nn > 0 ? Math.max(1, Math.min(MAX_GEN_CHARS, Math.floor(nn))) : 200
      const tt = Number(temperature)
      const temp = Number.isFinite(tt) && tt > 0 ? Math.min(2, Math.max(0.05, tt)) : 0.8
      if (worker && ready) {
        try {
          const res = await request('gen', { prompt: p, n: count, temperature: temp }, GEN_TIMEOUT_MS)
          if (isObj(res) && typeof res.text === 'string') return { text: res.text, ms: Math.round(performance.now() - t0) }
        } catch (e) {
          warn(`worker generate failed, sampling on main thread: ${errMsg(e)}`)
        }
      }
      try {
        const text = generateText(fallbackModel(), p, count, temp, Math.random)
        return { text, ms: Math.round(performance.now() - t0) }
      } catch (e) {
        warn(`generate failed: ${errMsg(e)}`)
        return { text: p, ms: Math.round(performance.now() - t0) }
      }
    },
  }
  return api
}
