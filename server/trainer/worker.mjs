// @ts-check
/**
 * SEPIA-0 training worker (worker_threads). Owns the model, the optimizer, the
 * corpus and the GPU-neuron training pipeline, and runs the training loop so the
 * server's event loop on the main thread is never blocked. Plain JS because tsx
 * does not reliably transpile .ts files loaded as workers.
 *
 * Two sources of optimizer steps share ONE Adam state (version = optimizer step):
 *   - the server's own CPU loop (batch 64, duty-cycled), and
 *   - gradients computed by GPU neurons on batches this worker samples and issues
 *     ('train.issue'), checked and applied on return ('train.submit').
 * Every returned gradient gets cheap checks (decodes, finite, norm, cosine with a
 * server gradient on a random sub-batch of the same rows, loss plausibility). A
 * FULL AUDIT recomputes the whole gradient from the exact base weights the job was
 * issued with (a ring of f16 weight snapshots keyed by version) when the caller
 * forces it or with probability LUSCA_TRAIN_AUDIT_P, within a CPU budget of
 * LUSCA_TRAIN_AUDIT_CPU of one core. Results based on weights more than
 * LUSCA_TRAIN_MAX_STALE versions old are verified but not applied ('stale').
 *
 * Protocol (all messages are plain objects with a `type`):
 *   main → worker
 *     { type:'init', seed, ckpt?: { params, m, v, step, adamT, train? } }   once, first
 *     { type:'feed', texts: string[] }                                corpus append
 *     { type:'req', id, op:'gen', prompt, n, temperature }             → res { text }
 *     { type:'req', id, op:'snapshot' }                                → res Snapshot
 *     { type:'req', id, op:'stop' }      final snapshot, loop halts    → res Snapshot
 *     { type:'req', id, op:'train.issue', neuronKey, batch, haveVersion } → res TrainJob | null
 *     { type:'req', id, op:'train.submit', neuronKey, jobId, grad: Uint8Array, loss, forceAudit } → res Verdict
 *     { type:'req', id, op:'train.stats' }                             → res TrainStats
 *   worker → main
 *     { type:'ready', step, restored }
 *     { type:'corpus', chars, docs, valDocs, trainChars, valChars }
 *     { type:'loss', point, stepsPerSec, corpusChars, train }
 *     { type:'train', train }                                          GPU pipeline counters (≤ 1/s)
 *     { type:'sample', step, text }
 *     { type:'res', id, ok, data?, error? }
 *     { type:'log', level, msg }
 */
import { parentPort } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Adam, NL, SepiaModel, encode, generateText, lrAt, mulberry32 } from './model.mjs'

const port = parentPort
if (!port) throw new Error('server/trainer/worker.mjs must be started as a worker thread')

// Deploy-time knobs (small instances): LUSCA_CORPUS_CHARS caps the in-memory corpus,
// LUSCA_TRAIN_DUTY caps the share of one core the training loop may use (0.05–1).
const envNum = (name, def, lo, hi) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? Math.min(hi, Math.max(lo, v)) : def
}

const HP = Object.freeze({
  batch: 64,
  clip: 1.0,
  lossEvery: 25, // post a LossPoint every N steps (mean train loss over them)
  valEvery: 250, // validation loss every N steps …
  valBatches: 16, // … averaged over this many batches
  sampleEvery: 600, // emit a sample every N steps
  sampleLen: 260,
  sampleTemp: 0.8,
  minChars: 20_000, // don't train until the corpus has this many chars
  maxChars: envNum('LUSCA_CORPUS_CHARS', 24_000_000, 1_000_000, 200_000_000), // corpus cap; oldest docs are evicted beyond it
  minDocChars: 48, // shorter normalized docs are ignored
  holdoutEvery: 20, // every 20th accepted document goes to validation
  duty: envNum('LUSCA_TRAIN_DUTY', 0.85, 0.05, 1), // fraction of one core the loop may use
  chunkMs: 40, // train this long between yields to the message loop
})

/** GPU-neuron training pipeline knobs. */
const GT = (() => {
  const maxStale = Math.round(envNum('LUSCA_TRAIN_MAX_STALE', 64, 0, 1_000_000))
  return Object.freeze({
    auditP: envNum('LUSCA_TRAIN_AUDIT_P', 0.2, 0, 1), // probability of a full audit on a non-forced result
    auditCpu: envNum('LUSCA_TRAIN_AUDIT_CPU', 0.35, 0.02, 1), // share of one core audits may use
    maxStale, // versions; older bases are verified but not applied
    reuse: Math.min(maxStale, Math.round(envNum('LUSCA_TRAIN_REUSE', Math.floor(maxStale / 2), 0, 1_000_000))), // issue on a held/latest snapshot this many versions back
    // A neuron that downloaded weights less than this long ago keeps computing on them
    // while they are still inside the staleness window (egress: ~500 KB per download).
    minWeightsGapMs: Math.round(envNum('LUSCA_TRAIN_WEIGHTS_GAP_S', 20, 0, 3600) * 1000),
    maxSnapshots: Math.round(envNum('LUSCA_TRAIN_SNAPSHOTS', 24, 2, 512)), // ring size (unreferenced snapshots evicted first)
    // Cheap check on every result: server gradients on `checkGroups` groups of random
    // rows of the same batch (S = checkRows rows in all). Three screens:
    //  · cosine(grad, gS) ≥ min(minCos, ½·√(S/B)). Honest results usually score 0.1–0.8,
    //    but a few high-loss rows can dominate a sub-batch, so honest large-B results
    //    occasionally score ≈ 0 (measured: 1–3 % at B = 4096). A low score therefore
    //    escalates to a forced full audit instead of rejecting; only a clearly negative
    //    cosine (< rejectCos) or an undecodable / non-finite result is rejected outright.
    //  · projection: for an honest g, E[g·gS] = ‖g‖² (rows drawn uniformly from the batch);
    //    |mean_q(g·G_q) − ‖g‖²| ≤ projK·SE (SE from the group spread) — catches scaled
    //    gradients, added orthogonal components and gradients of a different batch.
    //  · norm: ‖g‖ ≤ maxNormRatio·‖gS‖ (a sub-batch mean is noisier, so never smaller on average).
    // Failing the projection, norm or loss screen also escalates to a forced full audit.
    minCos: envNum('LUSCA_TRAIN_MIN_COS', 0.08, -1, 1),
    checkRows: Math.round(envNum('LUSCA_TRAIN_CHECK_ROWS', 64, 8, 512)),
    checkGroups: 8,
    rejectCos: -0.1,
    projK: 5,
    maxNormRatio: 1.25,
    spotCpu: envNum('LUSCA_TRAIN_SPOT_CPU', 0.25, 0.02, 1), // share of one core spot checks may use (back-pressure on issue)
    // Own CPU training duty while GPU gradients flow: every server step advances the
    // version, so a low duty keeps GPU results inside the staleness window.
    dutyGpu: envNum('LUSCA_TRAIN_DUTY_GPU', 0.02, 0, 1),
    // Full audit tolerances (exact base weights, whole batch). An f16-encoded honest
    // CPU gradient scores cosine 0.99999998 / relErr 2.1e-4; GPU f32 reduction order
    // adds ~1e-6. The bounds leave room for GPU transcendental differences.
    auditCos: envNum('LUSCA_TRAIN_AUDIT_COS', 0.99, 0, 1),
    auditRel: envNum('LUSCA_TRAIN_AUDIT_REL', 0.05, 0, 10),
    maxNorm: envNum('LUSCA_TRAIN_MAX_NORM', 1e3, 1, 1e9),
    minBatch: 16,
    maxBatch: 4096,
    jobTtlMs: Math.round(envNum('LUSCA_TRAIN_JOB_TTL_S', 90, 10, 86_400) * 1000), // coordinator times jobs out at 60 s
    maxJobs: 512, // outstanding jobs, all neurons
    maxJobsPerKey: 2, // outstanding jobs per neuron key = connection (the coordinator holds one)
    auditRows: 64, // rows per audit chunk (one chunk ≈ 40–80 ms of CPU)
    budgetCapMs: 20_000, // audit CPU bucket capacity
    maxDebtMs: 60_000, // forced audits may overdraw the bucket down to −this
    maxAuditQueue: 32, // hard cap on queued audits (forced included); issue pauses at ¾ of it
    flowMs: 30_000, // "GPU gradients are flowing" if one arrived this recently
    statsEveryMs: 1000,
  })
})()

const SAMPLE_PROMPTS = [
  'The validator ',
  'EIP-',
  'Proposal: ',
  'The bridge ',
  'Liquidity ',
  'Bitcoin ',
  'zk',
  'The DAO ',
  'Ethereum ',
  'The protocol ',
  'Staking ',
  'A rollup ',
]

/** @param {string} msg @param {'info'|'warn'|'error'} [level] */
function log(msg, level = 'info') {
  try {
    port?.postMessage({ type: 'log', level, msg })
  } catch {
    /* port closed */
  }
}

/** @param {unknown} e */
const errMsg = (e) => (e instanceof Error ? e.stack || e.message : String(e))

// ─── Shared SEPIA math (shared/sepia) ─────────────────────────────────────────
// One implementation of lossAndGrad / encodeGrad / f16 used by the server, the
// browser GPU trainer's self-test and the desktop CLI. Loaded dynamically so a
// missing module disables GPU jobs instead of killing the CPU trainer.

/**
 * @typedef {{
 *   lossAndGrad: (p: Float32Array, x: Uint8Array, y: Uint8Array, B: number, g: Float32Array) => number,
 *   lossOnly: (p: Float32Array, x: Uint8Array, y: Uint8Array, B: number) => number,
 *   f32ToF16: (a: Float32Array) => Uint16Array,
 *   f16ToF32: (u: Uint16Array) => Float32Array,
 *   encodeGrad: (g: Float32Array) => Uint8Array,
 *   decodeGrad: (b: Uint8Array) => Float32Array,
 *   cosine: (a: Float32Array, b: Float32Array) => number,
 *   l2: (a: Float32Array) => number,
 *   trainFlops: (B: number) => number,
 * }} SepiaCore
 */

/** @type {SepiaCore | null} */
let core = null

async function loadCore() {
  const dir = new URL('../../shared/sepia/', import.meta.url)
  for (const f of ['index.mjs', 'index.js', 'index.ts']) {
    const u = new URL(f, dir)
    if (!existsSync(fileURLToPath(u))) continue
    try {
      const mod = /** @type {any} */ (await import(u.href))
      const need = ['lossAndGrad', 'lossOnly', 'f32ToF16', 'f16ToF32', 'encodeGrad', 'decodeGrad', 'cosine', 'l2', 'trainFlops']
      const missing = need.filter((k) => typeof mod[k] !== 'function')
      if (missing.length) {
        log(`shared/sepia/${f} lacks ${missing.join(', ')} — GPU training jobs disabled`, 'warn')
        return null
      }
      return /** @type {SepiaCore} */ (mod)
    } catch (e) {
      log(`cannot load shared/sepia/${f}: ${errMsg(e)} — GPU training jobs disabled`, 'warn')
      return null
    }
  }
  log('shared/sepia not found — GPU training jobs disabled', 'warn')
  return null
}

// ─── Corpus ─────────────────────────────────────────────────────────────────

/**
 * One side (train or validation) of the corpus: an ordered list of encoded
 * documents plus a lazily rebuilt prefix-sum index, so a training target can
 * be drawn uniformly over every character position in O(log docs).
 */
class Split {
  constructor() {
    /** @type {Uint8Array[]} */
    this.docs = []
    /** cum[i] = total length of docs[0..i] */
    this.cum = new Float64Array(0)
    this.chars = 0
    this.dirty = false
  }

  /** @param {Uint8Array} d */
  push(d) {
    this.docs.push(d)
    this.chars += d.length
    this.dirty = true
  }

  shift() {
    const d = this.docs.shift()
    if (d) this.chars -= d.length
    this.dirty = true
    return d
  }

  rebuild() {
    const n = this.docs.length
    if (this.cum.length < n) this.cum = new Float64Array(Math.max(1024, n * 2))
    let s = 0
    for (let i = 0; i < n; i++) this.cum[i] = s += this.docs[i].length
    this.dirty = false
  }

  /**
   * Draw one (context, target) pair uniformly over all positions. Positions
   * near a document start see '\n' padding, so the model also learns how
   * documents begin.
   * @param {() => number} rand
   * @param {Uint8Array} X destination for T context ids
   * @param {number} off offset into X
   * @param {number} T
   * @returns {number} target id
   */
  sample(rand, X, off, T) {
    if (this.dirty) this.rebuild()
    const r = Math.floor(rand() * this.chars)
    let lo = 0
    let hi = this.docs.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.cum[mid] > r) hi = mid
      else lo = mid + 1
    }
    const doc = this.docs[lo]
    const pos = r - (lo > 0 ? this.cum[lo - 1] : 0)
    for (let t = 0; t < T; t++) {
      const p = pos - T + t
      X[off + t] = p >= 0 ? doc[p] : NL
    }
    return doc[pos]
  }
}

const train = new Split()
const val = new Split()
/** Arrival order of all docs (true = validation) so eviction drops the oldest overall. */
/** @type {boolean[]} */
let arrival = []
let arrivalHead = 0
let acceptedDocs = 0

const corpusChars = () => train.chars + val.chars

/** @param {string} text */
function addText(text) {
  if (typeof text !== 'string' || text.length === 0) return
  const ids = encode(text)
  if (ids.length < HP.minDocChars) return
  acceptedDocs++
  const isVal = acceptedDocs % HP.holdoutEvery === 0
  ;(isVal ? val : train).push(ids)
  arrival.push(isVal)
  // Evict oldest documents beyond the cap (always keep at least the newest one).
  while (corpusChars() > HP.maxChars && arrival.length - arrivalHead > 1) {
    const oldestIsVal = arrival[arrivalHead++]
    ;(oldestIsVal ? val : train).shift()
  }
  if (arrivalHead > 65536) {
    arrival = arrival.slice(arrivalHead)
    arrivalHead = 0
  }
}

function postCorpus() {
  port?.postMessage({
    type: 'corpus',
    chars: corpusChars(),
    docs: train.docs.length + val.docs.length,
    valDocs: val.docs.length,
    trainChars: train.chars,
    valChars: val.chars,
  })
}

// ─── Model state ────────────────────────────────────────────────────────────

const model = new SepiaModel() // Float32, ctx 16 · emb 24 · hidden 384 · vocab 96
const opt = new Adam(model.size, Float32Array, { beta1: 0.9, beta2: 0.99, eps: 1e-8 })
const T = model.T
const NP = model.size
const B = HP.batch
const X = new Uint8Array(B * T)
const Y = new Uint8Array(B)
let rand = mulberry32(Date.now() >>> 0)
let step = 0 // optimizer step == weights version
let initialized = false
let stopping = false

// LossPoint accumulation
let accLoss = 0
let accN = 0
let skipped = 0
let samplesSeen = 0 // (context, target) pairs consumed by applied updates, all sources
/** (time, step) marks for a sliding-window steps/sec */
/** @type {[number, number][]} */
let rateMarks = []

// GPU pipeline counters (persisted in the checkpoint header).
const TS = {
  gpuSteps: 0, // GPU gradients applied
  serverSteps: 0, // updates from the server's own CPU loop
  gpuSamples: 0, // rows covered by applied GPU gradients
  auditsOk: 0,
  auditsFailed: 0,
  rejected: 0, // failed cheap checks
  stale: 0, // verified but not applied (base too old)
  issued: 0,
}
/** neuronKey → last applied/verified result time */
/** @type {Map<string, number>} */
const contributors = new Map()
/** times of applied GPU gradients in the last minute */
/** @type {number[]} */
let gpuApplyTimes = []
let lastGpuResultAt = 0
let lastTrainPost = 0

function stepsPerSec() {
  if (rateMarks.length < 2) return 0
  const [t0, s0] = rateMarks[0]
  const [t1, s1] = rateMarks[rateMarks.length - 1]
  return t1 > t0 ? ((s1 - s0) * 1000) / (t1 - t0) : 0
}

function canTrain() {
  return initialized && !stopping && corpusChars() >= HP.minChars && train.chars > 0
}

/** Mean validation loss over HP.valBatches fixed-seed batches (null without val docs). */
function validationLoss() {
  if (val.chars <= 0) return null
  // Fixed seed → identical positions while the val set is unchanged, so the
  // curve reflects the model, not sampling noise.
  const vr = mulberry32(0x5e914)
  let s = 0
  for (let k = 0; k < HP.valBatches; k++) {
    for (let b = 0; b < B; b++) Y[b] = val.sample(vr, X, b * T, T)
    s += model.forward(X, Y, B, false)
  }
  return s / HP.valBatches
}

/** Bookkeeping after any applied update (CPU or GPU). @param {number} loss @param {number} rows */
function afterStep(loss, rows) {
  step++
  samplesSeen += rows
  accLoss += loss
  accN++
  if (step % HP.lossEvery === 0 && accN > 0) {
    const point = {
      step,
      loss: accLoss / accN,
      val: step % HP.valEvery === 0 ? validationLoss() : null,
      tokens: samplesSeen,
      ts: Date.now(),
    }
    accLoss = 0
    accN = 0
    port?.postMessage({ type: 'loss', point, stepsPerSec: stepsPerSec(), corpusChars: corpusChars(), train: trainStats() })
    lastTrainPost = Date.now()
  }
  if (step % HP.sampleEvery === 0) {
    const prompt = SAMPLE_PROMPTS[Math.floor(Math.random() * SAMPLE_PROMPTS.length)]
    const text = generateText(model, prompt, HP.sampleLen, HP.sampleTemp, Math.random)
    port?.postMessage({ type: 'sample', step, text })
  }
}

function trainStep() {
  for (let b = 0; b < B; b++) Y[b] = train.sample(rand, X, b * T, T)
  const loss = model.forward(X, Y, B, true)
  if (!Number.isFinite(loss)) {
    skipped++
    if (skipped % 100 === 1) log(`non-finite loss at step ${step}; batch skipped (${skipped} total)`, 'warn')
    return
  }
  const norm = opt.step(model.params, model.grads, lrAt(step), HP.clip)
  if (!Number.isFinite(norm)) {
    skipped++
    if (skipped % 100 === 1) log(`non-finite grad norm at step ${step}; update skipped (${skipped} total)`, 'warn')
    return
  }
  TS.serverSteps++
  afterStep(loss, B)
}

// ─── GPU pipeline: weight snapshots ─────────────────────────────────────────

/**
 * @typedef {{ version: number, f16: Uint16Array, b64: string | null, f32: Float32Array | null, refs: number, at: number }} Snap
 */
/** @type {Map<number, Snap>} version → snapshot (insertion order = creation order) */
const snaps = new Map()
let latestSnap = -1

/** @param {Uint16Array} u */
const u16b64 = (u) => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('base64')
/** @param {Uint8Array} u */
const u8b64 = (u) => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('base64')

/** f32 view of a snapshot's weights exactly as clients decode them (f16 → f32). @param {Snap} s */
function snapF32(s) {
  if (!s.f32 && core) {
    s.f32 = core.f16ToF32(s.f16)
    // Keep decoded copies only for the two newest snapshots.
    let kept = 0
    const vs = [...snaps.keys()].sort((a, b) => b - a)
    for (const v of vs) {
      const o = snaps.get(v)
      if (o?.f32) {
        if (kept >= 2 && o !== s) o.f32 = null
        else kept++
      }
    }
  }
  return /** @type {Float32Array} */ (s.f32)
}

function takeSnapshot() {
  if (!core) throw new Error('model core unavailable')
  const ex = snaps.get(step)
  if (ex) return ex
  /** @type {Snap} */
  const s = { version: step, f16: core.f32ToF16(/** @type {Float32Array} */ (model.params)), b64: null, f32: null, refs: 0, at: Date.now() }
  snaps.set(step, s)
  latestSnap = step
  evictSnapshots()
  return s
}

function evictSnapshots() {
  if (snaps.size <= GT.maxSnapshots) return
  // Oldest unreferenced first, then (hard cap 2×) oldest overall.
  for (const [v, s] of snaps) {
    if (snaps.size <= GT.maxSnapshots) return
    if (s.refs <= 0 && v !== latestSnap) snaps.delete(v)
  }
  for (const [v] of snaps) {
    if (snaps.size <= GT.maxSnapshots * 2) return
    if (v !== latestSnap) snaps.delete(v)
  }
}

function snapshotBytes() {
  let n = 0
  for (const s of snaps.values()) n += s.f16.byteLength + (s.b64 ? s.b64.length : 0) + (s.f32 ? s.f32.byteLength : 0)
  return n
}

// ─── GPU pipeline: jobs ─────────────────────────────────────────────────────

/**
 * @typedef {{ id: string, key: string, version: number, x: Uint8Array, y: Uint8Array, B: number, flops: number, issuedAt: number }} Job
 */
/** @type {Map<string, Job>} */
const jobs = new Map()
let jobSeq = 0
const jobRand = mulberry32((Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0)

/** @param {Job} j */
function dropJob(j) {
  jobs.delete(j.id)
  const s = snaps.get(j.version)
  if (s) s.refs = Math.max(0, s.refs - 1)
}

function pruneJobs() {
  const cut = Date.now() - GT.jobTtlMs
  for (const j of jobs.values()) {
    if (j.issuedAt >= cut) break // insertion order = issue order
    dropJob(j)
  }
}

/**
 * Weights this worker sent, per neuron key (the coordinator keys per connection):
 * key → { version, at }. A client's advertised version is trusted only when THIS worker
 * sent it those weights — after a worker restart `step` resumes from the last checkpoint
 * and version numbers repeat with different weights.
 * @type {Map<string, { version: number, at: number }>}
 */
const sentTo = new Map()

/** @param {string} key @param {number} version */
function noteSent(key, version) {
  sentTo.delete(key)
  sentTo.set(key, { version, at: Date.now() })
  if (sentTo.size > 50_000) {
    const first = sentTo.keys().next().value
    if (first !== undefined) sentTo.delete(first)
  }
}

/** Identity part of a neuron key ("<identity>#<connection>"). @param {string} key */
const identOfKey = (key) => {
  const i = key.indexOf('#')
  return i < 0 ? key : key.slice(0, i)
}

/** @param {any} msg */
function issueTrainJob(msg) {
  if (!core || !canTrain()) return null
  pruneJobs()
  const key = String(msg.neuronKey ?? '')
  if (!key) throw new Error('neuronKey required')
  // Back-pressure: no new work while audits or spot checks are behind.
  if (auditQueue >= Math.ceil(GT.maxAuditQueue * 0.75)) return null
  refillSpot()
  if (spotBudget < 0) return null
  const reqB = Math.floor(Number(msg.batch) || 0)
  const Bj = Math.max(GT.minBatch, Math.min(GT.maxBatch, reqB || 128))
  // Per-key cap: a client that lost jobs (reconnect) gets its oldest ones dropped.
  const mine = [...jobs.values()].filter((j) => j.key === key)
  while (mine.length >= GT.maxJobsPerKey) dropJob(/** @type {Job} */ (mine.shift()))
  if (jobs.size >= GT.maxJobs) return null

  // Base weights: the version the client already holds when recent enough (no
  // weights on the wire), else the newest snapshot when recent enough, else now.
  const have = msg.haveVersion === null || msg.haveVersion === undefined ? null : Math.floor(Number(msg.haveVersion))
  /** @type {Snap} */
  let s
  let sendWeights = true
  const sent = sentTo.get(key)
  const holds = have !== null && Number.isFinite(have) && sent !== undefined && sent.version === have
  const held = holds ? snaps.get(/** @type {number} */ (have)) : undefined
  const age = held ? step - held.version : Infinity
  if (held && (age <= GT.reuse || (age <= GT.maxStale - 8 && Date.now() - /** @type {{at:number}} */ (sent).at < GT.minWeightsGapMs))) {
    s = held
    sendWeights = false
  } else {
    const latest = snaps.get(latestSnap)
    s = latest && step - latest.version <= GT.reuse ? latest : takeSnapshot()
    if (holds && have === s.version) sendWeights = false
  }
  if (sendWeights) {
    if (!s.b64) s.b64 = u16b64(s.f16)
    noteSent(key, s.version)
  }

  const x = new Uint8Array(Bj * T)
  const y = new Uint8Array(Bj)
  for (let b = 0; b < Bj; b++) y[b] = train.sample(jobRand, x, b * T, T)
  const id = `tj${(++jobSeq).toString(36)}${Math.floor(jobRand() * 0x7fffffff).toString(36)}`
  const now = Date.now()
  const flops = core.trainFlops(Bj)
  /** @type {Job} */
  const j = { id, key, version: s.version, x, y, B: Bj, flops, issuedAt: now }
  jobs.set(id, j)
  s.refs++
  TS.issued++
  return {
    id,
    kind: 'train',
    version: s.version,
    weights: sendWeights ? s.b64 : null,
    batch: Bj,
    ctx: T,
    x: u8b64(x),
    y: u8b64(y),
    flops,
    issuedAt: now,
  }
}

// ─── GPU pipeline: audits (CPU-budgeted, chunked) ───────────────────────────

let auditBudget = GT.budgetCapMs / 2 // ms of CPU available to audits
let budgetAt = performance.now()
let spotBudget = 2000 // ms of CPU available to spot checks (separate bucket)
let spotAt = performance.now()
const spotHist = { ms: 0, at: Date.now(), rate: 0 } // spot-check CPU ms per second (diagnostics)

function refillSpot() {
  const now = performance.now()
  spotBudget = Math.min(4000, spotBudget + (now - spotAt) * GT.spotCpu)
  spotAt = now
}
let auditQueue = 0 // audits queued or running
/** @type {Promise<unknown>} */
let auditChain = Promise.resolve()
const auditMsHist = { n: 0, ms: 0, rows: 0 } // measured audit cost

function refillBudget() {
  const now = performance.now()
  auditBudget = Math.min(GT.budgetCapMs, auditBudget + (now - budgetAt) * GT.auditCpu)
  budgetAt = now
}

/** Estimated CPU ms of a full audit over `rows` rows. @param {number} rows */
function auditCostMs(rows) {
  const perRow = auditMsHist.rows > 0 ? auditMsHist.ms / auditMsHist.rows : 0.6
  return perRow * rows
}

/**
 * Recompute the full-batch gradient from the job's base weights, in chunks that
 * each charge the CPU budget and yield to the event loop between them.
 * @param {Job} j @param {Float32Array} base @param {boolean} forced
 * @returns {Promise<{ grad: Float32Array, loss: number, cpuMs: number }>}
 */
async function fullGradient(j, base, forced) {
  const c = /** @type {SepiaCore} */ (core)
  const g = new Float32Array(NP)
  const tmp = new Float32Array(NP)
  let loss = 0
  let cpuMs = 0
  const waitFrom = performance.now()
  for (let a = 0; a < j.B; a += GT.auditRows) {
    // Wait for budget: forced audits may overdraw down to −maxDebt.
    for (;;) {
      refillBudget()
      if (auditBudget > (forced ? -GT.maxDebtMs : 0) || stopping) break
      if (!forced && auditBudget > -GT.maxDebtMs && performance.now() - waitFrom > 120_000) break // a sampled audit is never starved
      await sleep(Math.min(1000, Math.max(20, -auditBudget / GT.auditCpu)))
    }
    const n = Math.min(GT.auditRows, j.B - a)
    const t0 = performance.now()
    const l = c.lossAndGrad(base, j.x.subarray(a * T, (a + n) * T), j.y.subarray(a, a + n), n, tmp)
    const w = n / j.B
    for (let i = 0; i < NP; i++) g[i] += tmp[i] * w
    loss += l * w
    const dt = performance.now() - t0
    cpuMs += dt
    refillBudget()
    auditBudget -= dt
    await new Promise((r) => setImmediate(r))
  }
  auditMsHist.n++
  auditMsHist.ms += cpuMs
  auditMsHist.rows += j.B
  return { grad: g, loss, cpuMs }
}

/** relative L2 error ‖a − b‖ / ‖b‖ @param {Float32Array} a @param {Float32Array} b */
function relErr(a, b) {
  let d = 0
  let n = 0
  for (let i = 0; i < a.length; i++) {
    const e = a[i] - b[i]
    d += e * e
    n += b[i] * b[i]
  }
  return n > 0 ? Math.sqrt(d / n) : Infinity
}

// ─── GPU pipeline: results ──────────────────────────────────────────────────

/** @param {string} key */
function touchContributor(key) {
  contributors.delete(key)
  contributors.set(key, Date.now())
  if (contributors.size > 20_000) {
    const first = contributors.keys().next().value
    if (first !== undefined) contributors.delete(first)
  }
}

function spotRate() {
  const now = Date.now()
  if (now - spotHist.at >= 5000) {
    spotHist.rate = Math.round((spotHist.ms * 1000) / (now - spotHist.at))
    spotHist.ms = 0
    spotHist.at = now
  }
  return spotHist.rate
}

function trainStats() {
  const now = Date.now()
  const dayAgo = now - 24 * 3600_000
  for (const [k, t] of contributors) {
    if (t >= dayAgo) break // insertion order = recency order
    contributors.delete(k)
  }
  while (gpuApplyTimes.length && gpuApplyTimes[0] < now - 60_000) gpuApplyTimes.shift()
  return {
    version: step,
    gpuSteps: TS.gpuSteps,
    serverSteps: TS.serverSteps,
    gpuSamples: TS.gpuSamples,
    contributors24h: contributors.size,
    audits: { ok: TS.auditsOk, failed: TS.auditsFailed },
    gpuStepsPerMin: gpuApplyTimes.length,
    // diagnostics (not part of ModelInfo)
    rejected: TS.rejected,
    stale: TS.stale,
    issued: TS.issued,
    pendingJobs: jobs.size,
    auditQueue,
    auditBudgetMs: Math.round(auditBudget),
    spotBudgetMs: Math.round(spotBudget),
    spotMsPerSec: spotRate(),
    auditMsPerRow: auditMsHist.rows > 0 ? Math.round((auditMsHist.ms / auditMsHist.rows) * 1000) / 1000 : null,
    snapshots: snaps.size,
    snapshotMB: Math.round((snapshotBytes() / 1048576) * 100) / 100,
    samplesSeen,
    gpuEnabled: core !== null,
  }
}

/** @type {ReturnType<typeof setTimeout> | null} */
let trainPostTimer = null
/** Post the pipeline counters, at most once per statsEveryMs (a trailing post carries the last change). */
function maybePostTrain() {
  const wait = GT.statsEveryMs - (Date.now() - lastTrainPost)
  if (wait > 0) {
    if (!trainPostTimer) {
      trainPostTimer = setTimeout(() => {
        trainPostTimer = null
        maybePostTrain()
      }, wait)
    }
    return
  }
  lastTrainPost = Date.now()
  port?.postMessage({ type: 'train', train: trainStats() })
}

/**
 * @typedef {{ verdict: 'applied'|'audited'|'audit-failed'|'rejected'|'stale', reason: string, flops: number, audited: boolean,
 *   version?: number, baseVersion?: number, cos?: number, relErr?: number, lossDiff?: number, auditMs?: number, escalated?: boolean }} Verdict
 */

/** @param {any} msg @returns {Promise<Verdict>} */
async function submitTrainResult(msg) {
  const key = String(msg.neuronKey ?? '')
  const j = jobs.get(String(msg.jobId ?? ''))
  // Unknown/expired jobs (e.g. issued before a restart) are not the client's fault: no INK, no strike.
  if (!j) return { verdict: 'stale', reason: 'unknown or expired job', flops: 0, audited: false }
  if (j.key !== key) return { verdict: 'rejected', reason: 'job belongs to another neuron', flops: 0, audited: false }
  jobs.delete(j.id) // one result per job
  const s = snaps.get(j.version)
  try {
    if (!core) return { verdict: 'stale', reason: 'model core unavailable', flops: 0, audited: false }
    if (!s) return { verdict: 'stale', reason: 'base weights no longer held', flops: 0, audited: false }
    lastGpuResultAt = Date.now()
    const reject = (/** @type {string} */ reason, /** @type {Partial<Verdict>} */ extra = {}) => {
      TS.rejected++
      return /** @type {Verdict} */ ({ verdict: 'rejected', reason, flops: 0, audited: false, baseVersion: j.version, ...extra })
    }

    // 1. decode + shape + finiteness + norm
    const bytes = msg.grad
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return reject('missing gradient')
    /** @type {Float32Array} */
    let grad
    try {
      grad = core.decodeGrad(bytes)
    } catch (e) {
      return reject(`gradient does not decode (${e instanceof Error ? e.message : String(e)})`)
    }
    if (!(grad instanceof Float32Array) || grad.length !== NP) return reject(`gradient has ${grad?.length} values, want ${NP}`)
    for (let i = 0; i < NP; i++) if (!Number.isFinite(grad[i])) return reject('non-finite gradient value')
    const norm = core.l2(grad)
    if (!(norm > 1e-9) || norm > GT.maxNorm) return reject(`gradient norm ${norm.toExponential(2)} out of range`)
    const loss = Number(msg.loss)
    if (!Number.isFinite(loss) || loss < 0 || loss > 50) return reject('implausible loss')

    // 2. cheap check: server gradients on groups of random rows of the same batch
    const base = snapF32(s)
    const S0 = Math.min(GT.checkRows, j.B)
    const Q = Math.max(2, Math.min(GT.checkGroups, S0))
    const per = Math.max(1, Math.floor(S0 / Q))
    const S = per * Q
    const xs = new Uint8Array(per * T)
    const ys = new Uint8Array(per)
    const t0 = performance.now()
    const gS = new Float32Array(NP)
    const gq = new Float32Array(NP)
    const gg = core.l2(grad) ** 2
    const dq = new Float64Array(Q)
    const lq = new Float64Array(Q)
    for (let q = 0; q < Q; q++) {
      for (let k = 0; k < per; k++) {
        const r = Math.floor(Math.random() * j.B)
        xs.set(j.x.subarray(r * T, r * T + T), k * T)
        ys[k] = j.y[r]
      }
      lq[q] = core.lossAndGrad(base, xs, ys, per, gq)
      let d = 0
      for (let i = 0; i < NP; i++) {
        d += grad[i] * gq[i]
        gS[i] += gq[i] / Q
      }
      dq[q] = d
    }
    const mean = (/** @type {Float64Array} */ a) => a.reduce((x, y) => x + y, 0) / a.length
    const seOf = (/** @type {Float64Array} */ a, /** @type {number} */ m) => Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / Math.max(1, a.length - 1) / a.length)
    const lossS = mean(lq)
    const se = seOf(lq, lossS)
    const dMean = mean(dq)
    const dSe = seOf(dq, dMean)
    const spotMs = performance.now() - t0
    refillSpot()
    spotBudget -= spotMs
    spotHist.ms += spotMs
    const cos = core.cosine(grad, gS)
    const normS = core.l2(gS)
    const minCos = Math.min(GT.minCos, 0.5 * Math.sqrt(S / j.B))
    if (!(cos >= GT.rejectCos)) return reject(`gradient opposes the server's spot check (cosine ${cos.toFixed(3)})`, { cos })
    /** @type {string[]} */
    const doubts = []
    if (!(cos >= minCos)) doubts.push(`spot-check cosine ${cos.toFixed(3)} < ${minCos.toFixed(3)}`)
    const projTol = GT.projK * dSe + 1e-3 * gg + 1e-12 // + f16 codec error
    if (!(Math.abs(dMean - gg) <= projTol)) doubts.push(`projection ${dMean.toExponential(2)} vs ‖g‖² ${gg.toExponential(2)} ± ${projTol.toExponential(2)}`)
    if (!(Math.sqrt(gg) <= GT.maxNormRatio * normS)) doubts.push(`norm ${Math.sqrt(gg).toExponential(2)} > ${GT.maxNormRatio}× spot-check norm ${normS.toExponential(2)}`)
    const lossTol = 0.25 + 5 * se
    if (Math.abs(loss - lossS) > lossTol) doubts.push(`reported loss ${loss.toFixed(3)} vs spot check ${lossS.toFixed(3)} ± ${lossTol.toFixed(3)}`)

    // Staleness is judged on arrival: time spent waiting for an audit is the server's, not the neuron's.
    const ageAtArrival = step - j.version

    // 3. full audit: forced, escalated by a failed screen, or a plain coin flip (never
    //    budget-dependent — an audit selected while the budget is short waits for it,
    //    and the gradient is neither applied nor paid until it ran).
    refillBudget()
    const forced = msg.forceAudit === true || doubts.length > 0
    const doAudit = forced || Math.random() < GT.auditP
    /** @type {Partial<Verdict>} */
    let auditInfo = { escalated: doubts.length > 0 }
    let lossRef = lossS
    if (doAudit) {
      if (auditQueue >= GT.maxAuditQueue) {
        TS.stale++
        return { verdict: 'stale', reason: 'audit queue full; result not scored (no strike)', flops: 0, audited: false, baseVersion: j.version }
      }
      auditQueue++
      /** @type {Promise<{ grad: Float32Array, loss: number, cpuMs: number }>} */
      const p = auditChain.then(() => fullGradient(j, base, forced))
      auditChain = p.catch(() => {})
      let ref
      try {
        ref = await p
      } finally {
        auditQueue--
      }
      const aCos = core.cosine(grad, ref.grad)
      const aRel = relErr(grad, ref.grad)
      const lossDiff = Math.abs(loss - ref.loss)
      auditInfo = { cos: aCos, relErr: aRel, lossDiff, auditMs: Math.round(ref.cpuMs), escalated: doubts.length > 0 }
      lossRef = ref.loss
      const lossOk = lossDiff <= 0.02 + 0.005 * ref.loss
      if (!(aCos >= GT.auditCos) || !(aRel <= GT.auditRel) || !lossOk) {
        TS.auditsFailed++
        return {
          verdict: 'audit-failed',
          reason: `full audit failed: cosine ${aCos.toFixed(5)}, rel. error ${aRel.toExponential(2)}, loss diff ${lossDiff.toExponential(2)}${doubts.length ? ` (escalated: ${doubts.join('; ')})` : ''}`,
          flops: 0,
          audited: true,
          baseVersion: j.version,
          ...auditInfo,
        }
      }
      TS.auditsOk++
    }

    // 4. apply unless the base is too old (staleness checked after the audit wait)
    touchContributor(identOfKey(key))
    if (ageAtArrival > GT.maxStale || step - j.version > 2 * GT.maxStale + 64 || stopping) {
      TS.stale++
      return {
        verdict: 'stale',
        reason: stopping ? 'trainer stopping' : `base version ${j.version} was ${ageAtArrival} versions old on arrival (max ${GT.maxStale})`,
        flops: j.flops,
        audited: doAudit,
        version: step,
        baseVersion: j.version,
        ...(doAudit ? auditInfo : { cos }),
      }
    }
    const n = opt.step(model.params, grad, lrAt(step), HP.clip)
    if (!Number.isFinite(n)) return reject('optimizer rejected the gradient')
    TS.gpuSteps++
    TS.gpuSamples += j.B
    gpuApplyTimes.push(Date.now())
    afterStep(lossRef, j.B) // server-computed loss (full audit, else the spot-check estimate)
    return {
      verdict: doAudit ? 'audited' : 'applied',
      reason: doAudit ? 'full audit passed; gradient applied' : 'spot check passed; gradient applied',
      flops: j.flops,
      audited: doAudit,
      version: step,
      baseVersion: j.version,
      ...(doAudit ? auditInfo : { cos }),
    }
  } finally {
    if (s) s.refs = Math.max(0, s.refs - 1)
    evictSnapshots()
    maybePostTrain()
  }
}

// ─── Loop ───────────────────────────────────────────────────────────────────

/** Own-training duty: yields CPU to audits while GPU gradients are flowing. */
function ownDuty() {
  const flowing = Date.now() - lastGpuResultAt < GT.flowMs || auditQueue > 0
  return flowing ? Math.min(HP.duty, 1 - GT.auditCpu - 0.1, GT.dutyGpu) : HP.duty
}

async function loop() {
  // Duty-cycle accounting: every ms of work "owes" (1−duty)/duty ms of rest.
  // Paying the debt with real (coarse, ~15 ms on Windows) timers and carrying
  // the error forward keeps the long-run CPU share at the duty regardless of
  // timer granularity.
  let owed = 0
  while (!stopping) {
    if (!canTrain()) {
      rateMarks = []
      owed = 0
      await sleep(200)
      continue
    }
    const duty = ownDuty()
    if (duty <= 0.001) {
      // LUSCA_TRAIN_DUTY_GPU=0: GPU neurons alone train while they are active.
      rateMarks = []
      owed = 0
      await sleep(200)
      continue
    }
    const t0 = performance.now()
    try {
      do trainStep()
      while (!stopping && performance.now() - t0 < HP.chunkMs)
    } catch (e) {
      log(`training step failed: ${errMsg(e)}`, 'error')
      await sleep(1000)
      continue
    }
    const t1 = performance.now()
    rateMarks.push([t1, step])
    while (rateMarks.length > 2 && t1 - rateMarks[0][0] > 8000) rateMarks.shift()
    owed += ((t1 - t0) * (1 - duty)) / duty
    if (owed >= 2) {
      const s0 = performance.now()
      await sleep(owed)
      owed = Math.max(-100, owed - (performance.now() - s0))
    } else {
      await new Promise((r) => setImmediate(r)) // let queued messages run
    }
  }
}

// ─── Messages ───────────────────────────────────────────────────────────────

function persistedTrain() {
  return {
    gpuSteps: TS.gpuSteps,
    serverSteps: TS.serverSteps,
    gpuSamples: TS.gpuSamples,
    auditsOk: TS.auditsOk,
    auditsFailed: TS.auditsFailed,
    rejected: TS.rejected,
    stale: TS.stale,
    samplesSeen,
    contributors: [...contributors.entries()].slice(-5000),
  }
}

function snapshot() {
  const params = Float32Array.from(model.params)
  const m = Float32Array.from(opt.m)
  const v = Float32Array.from(opt.v)
  return { data: { step, adamT: opt.t, params, m, v, train: persistedTrain() }, transfer: [params.buffer, m.buffer, v.buffer] }
}

/** @param {unknown} a @param {number} n */
function isF32(a, n) {
  return a instanceof Float32Array && a.length === n
}

/** @param {unknown} x @param {number} [d] */
const cnt = (x, d = 0) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : d)

/** @param {any} t */
function restoreTrain(t) {
  if (!t || typeof t !== 'object') {
    TS.serverSteps = step // pre-GPU checkpoints: every step so far was a server step
    samplesSeen = step * B
    return
  }
  TS.gpuSteps = cnt(t.gpuSteps)
  TS.serverSteps = cnt(t.serverSteps, Math.max(0, step - TS.gpuSteps))
  TS.gpuSamples = cnt(t.gpuSamples)
  TS.auditsOk = cnt(t.auditsOk)
  TS.auditsFailed = cnt(t.auditsFailed)
  TS.rejected = cnt(t.rejected)
  TS.stale = cnt(t.stale)
  samplesSeen = cnt(t.samplesSeen, step * B)
  if (Array.isArray(t.contributors)) {
    const rows = t.contributors.filter((/** @type {any} */ r) => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'number')
    rows.sort((/** @type {any} */ a, /** @type {any} */ b) => a[1] - b[1])
    for (const [k, ts] of rows) contributors.set(k, ts)
  }
}

/** @param {any} msg */
async function init(msg) {
  if (initialized) return
  rand = mulberry32((Number(msg?.seed) >>> 0) || Date.now() >>> 0)
  let restored = false
  const ck = msg?.ckpt
  if (ck && isF32(ck.params, model.size) && isF32(ck.m, model.size) && isF32(ck.v, model.size)) {
    model.load(ck.params)
    opt.m.set(ck.m)
    opt.v.set(ck.v)
    step = Math.max(0, Math.floor(Number(ck.step) || 0))
    opt.t = Math.max(0, Math.floor(Number(ck.adamT) || step))
    restoreTrain(ck.train)
    restored = true
  } else {
    if (ck) log('checkpoint shape mismatch — starting from fresh weights', 'warn')
    model.init(rand)
  }
  core = await loadCore()
  initialized = true
  port?.postMessage({ type: 'ready', step, restored, gpu: core !== null })
  loop().catch((e) => log(`training loop crashed: ${errMsg(e)}`, 'error'))
}

/** @param {number} id @param {any} data @param {Transferable[]} [transfer] */
function reply(id, data, transfer) {
  port?.postMessage({ type: 'res', id, ok: true, data }, transfer ?? [])
}

/** @param {number} id @param {unknown} e */
function replyErr(id, e) {
  try {
    port?.postMessage({ type: 'res', id, ok: false, error: errMsg(e) })
  } catch {
    /* port closed */
  }
}

/** @param {any} msg */
function handleReq(msg) {
  const id = msg.id
  try {
    if (!initialized) throw new Error('worker not initialized')
    switch (msg.op) {
      case 'gen': {
        const t0 = performance.now()
        const n = Math.max(0, Math.min(600, Math.floor(Number(msg.n) || 0)))
        const temp = Number(msg.temperature)
        const text = generateText(model, String(msg.prompt ?? ''), n, Number.isFinite(temp) && temp > 0 ? temp : 0.8, Math.random)
        reply(id, { text, ms: performance.now() - t0 })
        return
      }
      case 'snapshot': {
        const s = snapshot()
        reply(id, s.data, s.transfer)
        return
      }
      case 'stop': {
        stopping = true
        const s = snapshot()
        reply(id, s.data, s.transfer)
        return
      }
      case 'train.issue':
        reply(id, issueTrainJob(msg))
        return
      case 'train.submit':
        submitTrainResult(msg).then(
          (v) => reply(id, v),
          (e) => replyErr(id, e),
        )
        return
      case 'train.stats':
        reply(id, trainStats())
        return
      default:
        throw new Error(`unknown op ${String(msg.op)}`)
    }
  } catch (e) {
    replyErr(id, e)
  }
}

port.on('message', (msg) => {
  try {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'init':
        init(msg).catch((e) => log(`init failed: ${errMsg(e)}`, 'error'))
        break
      case 'feed': {
        const texts = Array.isArray(msg.texts) ? msg.texts : []
        for (const t of texts) addText(t)
        postCorpus()
        break
      }
      case 'req':
        handleReq(msg)
        break
    }
  } catch (e) {
    log(`message handling failed: ${errMsg(e)}`, 'error')
  }
})
