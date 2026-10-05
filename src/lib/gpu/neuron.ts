/*
 * LUSCA neuron — plug this browser's GPU into the octopus.
 * ─────────────────────────────────────────────────────────────────────────
 * Flow
 *   1. detect()     WebGPU probe (detect.ts). No WebGPU → status 'unsupported'
 *                   with a human reason; the CPU fallback stays available.
 *   2. benchmark()  Tiled FP32 GEMM benchmark (bench.ts), validated against the
 *                   CPU first. Median GFLOPS → zone via zoneFor() (EPI…HADAL).
 *                   No WebGPU, or a GPU that fails validation → JS CPU benchmark
 *                   and CPU backend.
 *   3. start()      Starts ONE work loop (benchmarks first if needed). Work only
 *                   happens while the coordinator websocket is up (useLive conn
 *                   === 'live'); otherwise the loop waits for it — no jobs, no INK.
 *        neuron.register {label, zone, gflops, kind:'browser', wallet, adapter, auth}
 *          (adapter carries a persistent anonymous deviceId, so INK accrues to
 *          this browser on the coordinator's ledger without a wallet; `auth` is
 *          the wallet sign-in token (src/lib/wallet.ts) and is the only thing
 *          that links the neuron's INK to a wallet)
 *          → 'neuron.ok' gives our neuronId
 *        before the first job: SEPIA trainer self-test (GPU gradient vs the
 *          shared/sepia reference on a fixed batch); a mismatch → CPU path.
 *        loop: job.request {caps:{train:true, version:<held weights>}} → 'job'
 *              TrainJob → decode weights (f16, cached by version) + x/y →
 *                gradient of the mean cross-entropy (GPU trainer or CPU
 *                lossAndGrad) → encodeGrad → train.result → 'ink' event
 *                (status pending = escrow until the next full audit passes)
 *              SimJob (dedupe, secondary) → SimKernel.run on the GPU
 *                (near-ties re-scored on the CPU; 1 row self-checked on CPU)
 *                → job.result → wait for our 'ink' event (≤ 3 s) → repeat.
 *        'corpus warming up' → the coordinator keeps our request queued; we
 *        wait for the pushed job. Other {t:'error'}s → exponential backoff
 *        (or the coordinator's "retry in N s" hint).
 *        Socket reconnect ('hello') → re-register automatically. A wallet
 *        verification change → re-register on the same socket between jobs
 *        (the coordinator keeps counters and any job in flight). A job that is
 *        already queued is always finished, even while paused, because an
 *        unanswered job counts as a failure server-side.
 *   4. pause() / resume() / stop(). The loop also pauses while the tab is
 *      hidden (visibilitychange) and resumes when it is visible again.
 *
 * Reloads: the counters here are this page session's (from the server's verdicts); the saved
 * totals come from the server ledger (src/lib/account.ts). What survives a reload on the client:
 *   - the last finished benchmark (tier, GPU, GFLOPS) in localStorage (recordLastRun),
 *   - the job log and the throughput history of this tab in sessionStorage (throttled writes),
 *   - the AUTORESUME_KEY flag while earning: set by start() / resume(), cleared by an explicit
 *     pause() or stop(); a reloaded tab then resumes on its own (resumeEarning, node/flow.ts).
 *
 * Guarantees: never two loops (generation counter + awaited hand-over), every
 * await is cancellable by stop(), all errors are caught and logged, and a GPU
 * that returns a wrong answer is never trusted: failed self-checks fall back to
 * the CPU, and three strikes switch the neuron to the CPU backend.
 */
import { create } from 'zustand'
import { ZONES, zoneFor } from '@shared/protocol'
import type { ClientMsg, InkEvent, NeuronInfo, SimJob, Zone } from '@shared/protocol'
import type { AuthSession } from '@shared/payouts'
import { b64ToF32 } from '@shared/b64'
import { AUTORESUME_KEY, send } from '@/lib/live'
import { neuronDeviceId, recordLastRun, storedDeviceId } from '@/lib/account'
import { bus } from '@/lib/bus'
import { useLive } from '@/lib/store'
import { refreshWalletPayouts } from '@/lib/payouts'
import { authToken, useWallet, verifiedWallet } from '@/lib/wallet'
import { acquireDevice, detectGpu } from './detect'
import type { GpuDetect } from './detect'
import { cpuBenchmark, runBenchmark } from './bench'
import type { BenchProgress, BenchResult } from './bench'
import { SimKernel, pickRows, simCPU, spotCheck } from './simkernel'
import type { SimRun, SpotCheck } from './simkernel'
import { computeGrad, decodeTrainJob, destroyGpuTrainer, dropWeights, heldVersion, prepareGpuTrainer } from './training'
import type { TrainBackend, TrainJobWire, TrainSelfTest } from './training'

/** Any job the coordinator can assign (SimJob = dedupe, TrainJob = SEPIA gradients). */
type AnyJob = SimJob | TrainJobWire
/** InkEvent with the training fields (kind/status) the protocol adds. */
type InkEv = InkEvent & { kind?: 'sim' | 'train'; status?: 'confirmed' | 'pending' | 'forfeited' }

// ─── public types ─────────────────────────────────────────────────────────

export type NeuronStatus =
  | 'idle'
  | 'detecting'
  | 'unsupported'
  | 'benchmarking'
  | 'ready'
  | 'running'
  | 'paused'
  | 'error'

export type NeuronBackend = 'webgpu' | 'cpu'

/**
 * neuron.register plus the wallet sign-in token. `auth` is part of the shared protocol
 * (shared/protocol.ts); the intersection keeps this file compiling against either version.
 */
type RegisterMsg = Extract<ClientMsg, { t: 'neuron.register' }> & { auth?: string | null }

export interface NeuronBench {
  gflops: number
  /** GFLOPS of each timed batch at size n. */
  runs: number[]
  n: number
  ms: number
  timing: BenchResult['timing']
  backend: NeuronBackend
}

export interface NeuronLastJob {
  id: string
  rows: number
  cols: number
  dim: number
  ms: number
  gflopsEff: number
}

export interface NeuronHistoryPoint {
  ts: number
  ms: number
  gflopsEff: number
  ink: number
  verified: boolean
  /** Job id (lets late INK events patch the point). */
  id: string
}

export interface NeuronLastTrain {
  id: string
  /** Batch size B (context windows of SEPIA.ctx characters). */
  batch: number
  /** Weights version the gradient was computed against. */
  version: number
  loss: number
  ms: number
  gflopsEff: number
  backend: TrainBackend
}

export interface NeuronState {
  status: NeuronStatus
  /** What the neuron is computing right now (null = waiting / idle). */
  task: 'train' | 'sim' | null
  /** Backend for SEPIA gradients (null until the self-test ran this session). */
  trainBackend: TrainBackend | null
  /** Result of the GPU trainer self-test (null = not run, or no WebGPU). */
  trainSelfTest: TrainSelfTest | null
  /** Why gradients are computed on the CPU (no WebGPU, self-test failure, GPU faults). */
  trainNote: string | null
  /** Training jobs returned this session. */
  trainJobs: number
  /** Context windows (samples) in those jobs. */
  trainSamples: number
  /** Gradients the server reported as applied to SEPIA. */
  gradsApplied: number
  /** Gradients verified but too old to apply (paid, not applied). */
  gradsStale: number
  lastTrain: NeuronLastTrain | null
  /** Training INK held in escrow until this identity's next full audit passes. */
  inkPending: number
  /** Training INK forfeited by a failed audit. */
  inkForfeited: number
  detect: GpuDetect | null
  bench: NeuronBench | null
  /** Live benchmark progress (phase, 0..100 pct, running GFLOPS). */
  benchProgress: BenchProgress | null
  backend: NeuronBackend | null
  zone: Zone | null
  neuronId: string | null
  /** Verified wallet the current registration credits (null = this device's account). */
  wallet: string | null
  /** Job results sent to the coordinator. */
  jobs: number
  /** Jobs the coordinator verified. */
  verified: number
  /** Jobs the coordinator rejected. */
  failed: number
  /** Total FLOPs of completed jobs (2·rows·cols·dim each). */
  flops: number
  /**
   * Confirmed INK the coordinator awarded to this neuron in this page session (its 'ink'
   * events): dedupe jobs, plus training jobs whose escrow a passed audit released.
   */
  ink: number
  lastJob: NeuronLastJob | null
  /** Last 60 jobs, oldest → newest (chronological, for charts; restored after a reload of this tab). */
  history: NeuronHistoryPoint[]
  /** Last 150 human-readable lines, newest first (restored after a reload of this tab). */
  log: string[]
  error: string | null

  // Actions (same functions as the module-level exports below).
  runDetect: () => Promise<GpuDetect>
  benchmark: () => Promise<NeuronBench | null>
  start: () => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => Promise<void>
}

// ─── tuning ───────────────────────────────────────────────────────────────

const HISTORY_CAP = 60 // the throughput chart has 60 slots
const LOG_CAP = 150
const INK_WAIT_MS = 3000
const JOB_WAIT_MS = 12000
const REGISTER_WAIT_MS = 6000
const LIVE_MIN_GAP_MS = 150 // min interval between job requests
const SERVER_WAIT_MS = 10000 // re-check interval while the LUSCA server is unreachable
/** A registration refusal that is about the wallet sign-in token itself. */
const AUTH_REFUSED_RE = /\b(auth|token|sign-?in|signature)\b/i

/**
 * Stable anonymous id for this browser (one source of truth: src/lib/account.ts). The
 * coordinator keys the INK ledger by it when no wallet is verified, so balances survive reloads.
 */
export { neuronDeviceId }

// ─── reload persistence ───────────────────────────────────────────────────

/** This tab's job log + throughput history (sessionStorage: survives a reload, not a new tab). */
const ACTIVITY_KEY = 'lusca.activity.v1'
const ACTIVITY_SAVE_MS = 2000
/** First line after a reload; the log above it is new, below it is from before. */
const RELOAD_LINE = 'tab reloaded · the lines below are from before the reload'

function readActivity(): { log: string[]; history: NeuronHistoryPoint[] } {
  try {
    const raw = sessionStorage.getItem(ACTIVITY_KEY)
    if (raw === null) return { log: [], history: [] }
    const j = JSON.parse(raw) as { log?: unknown; history?: unknown } | null
    const log = (Array.isArray(j?.log) ? j.log : []).filter((l): l is string => typeof l === 'string' && l.length <= 600).slice(0, LOG_CAP)
    const history: NeuronHistoryPoint[] = []
    for (const p of Array.isArray(j?.history) ? j.history : []) {
      const o = p as Record<string, unknown> | null
      if (!o || typeof o !== 'object' || typeof o.id !== 'string' || typeof o.verified !== 'boolean') continue
      const ts = Number(o.ts)
      const ms = Number(o.ms)
      const ink = Number(o.ink)
      if (!Number.isFinite(ts) || !Number.isFinite(ms) || !Number.isFinite(ink)) continue
      // NaN (job without a FLOP count) is stored as null
      const g = typeof o.gflopsEff === 'number' && Number.isFinite(o.gflopsEff) ? o.gflopsEff : NaN
      history.push({ ts, ms, gflopsEff: g, ink, verified: o.verified, id: o.id })
    }
    if (log.length && log[0] !== RELOAD_LINE) {
      log.unshift(RELOAD_LINE)
      if (log.length > LOG_CAP) log.length = LOG_CAP
    }
    return { log, history: history.slice(-HISTORY_CAP) }
  } catch {
    return { log: [], history: [] }
  }
}

let activityTimer: ReturnType<typeof setTimeout> | null = null

function saveActivity() {
  if (activityTimer !== null) clearTimeout(activityTimer)
  activityTimer = null
  const s = useNeuron.getState()
  try {
    if (!s.log.length && !s.history.length) sessionStorage.removeItem(ACTIVITY_KEY)
    else sessionStorage.setItem(ACTIVITY_KEY, JSON.stringify({ log: s.log, history: s.history }))
  } catch {
    /* storage unavailable or full: the feed lasts for this page only */
  }
}

/** At most one write per ACTIVITY_SAVE_MS; pagehide flushes the rest. */
function scheduleActivitySave() {
  if (activityTimer === null) activityTimer = setTimeout(saveActivity, ACTIVITY_SAVE_MS)
}

/** Mark this tab as earning (true) or not (false), for a reload (AUTORESUME_KEY). */
export function markEarning(on: boolean) {
  try {
    if (on) sessionStorage.setItem(AUTORESUME_KEY, '1')
    else sessionStorage.removeItem(AUTORESUME_KEY)
  } catch {
    /* storage unavailable: no resume after a reload */
  }
}

/** This tab was earning (started or resumed, not paused or stopped by hand). */
export function autoResumeSet(): boolean {
  try {
    return sessionStorage.getItem(AUTORESUME_KEY) === '1'
  } catch {
    return false
  }
}

// ─── formatting helpers ───────────────────────────────────────────────────

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
function fmtGflop(flops: number): string {
  const g = flops / 1e9
  return g >= 10 ? g.toFixed(0) : g >= 1 ? g.toFixed(1) : g >= 0.01 ? g.toFixed(2) : g.toFixed(3)
}
function fmtMs(ms: number): string {
  return ms < 10 ? ms.toFixed(1) : ms.toFixed(0)
}
function fmtG(g: number): string {
  return g >= 100 ? Math.round(g).toLocaleString('en-US') : g.toFixed(1)
}
/**
 * The distinctive part of a job id. Server ids are `j<seq36>-<conn6>`: the sequence before the
 * dash changes per job while the connection suffix never does, so keep the sequence part.
 */
function shortId(id: string): string {
  const head = id.split('-')[0] || id
  const alnum = head.replace(/[^a-zA-Z0-9]/g, '')
  return (alnum || id).slice(-6)
}
function trunc(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

// ─── store ────────────────────────────────────────────────────────────────

const restored = typeof window === 'undefined' ? { log: [], history: [] } : readActivity()

export const useNeuron = create<NeuronState>(() => ({
  status: 'idle',
  task: null,
  trainBackend: null,
  trainSelfTest: null,
  trainNote: null,
  trainJobs: 0,
  trainSamples: 0,
  gradsApplied: 0,
  gradsStale: 0,
  lastTrain: null,
  inkPending: 0,
  inkForfeited: 0,
  detect: null,
  bench: null,
  benchProgress: null,
  backend: null,
  zone: null,
  neuronId: null,
  wallet: null,
  jobs: 0,
  verified: 0,
  failed: 0,
  flops: 0,
  ink: 0,
  lastJob: null,
  history: restored.history,
  log: restored.log,
  error: null,
  runDetect: () => detect(),
  benchmark: () => benchmark(),
  start: () => start(),
  pause: () => pause(),
  resume: () => resume(),
  stop: () => stop(),
}))

const get = () => useNeuron.getState()
const set = (p: Partial<NeuronState>) => useNeuron.setState(p)

function log(line: string) {
  const next = [line, ...get().log]
  if (next.length > LOG_CAP) next.length = LOG_CAP
  set({ log: next })
}

function pushHistory(p: NeuronHistoryPoint) {
  const h = get().history.concat(p)
  if (h.length > HISTORY_CAP) h.splice(0, h.length - HISTORY_CAP)
  set({ history: h })
}

// Keep this tab's feed across a reload (throttled; flushed when the page is hidden or unloads).
useNeuron.subscribe((s, prev) => {
  if (s.log !== prev.log || s.history !== prev.history) scheduleActivitySave()
})
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (activityTimer !== null) saveActivity()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && activityTimer !== null) saveActivity()
  })
}

// ─── module state (non-reactive) ──────────────────────────────────────────

let device: GPUDevice | null = null
let devicePromise: Promise<GPUDevice> | null = null
let detectedAdapterUsed = false
let kernel: SimKernel | null = null
let deviceFailures = 0
let gpuStrikes = 0

let detectPromise: Promise<GpuDetect> | null = null
let benchPromise: Promise<NeuronBench | null> | null = null

let gen = 0 // loop generation: bump to cancel the running loop
let loopGen = -1 // generation of the loop that is currently alive
let loopPromise: Promise<void> | null = null
let starting = false
let userPaused = false
let hiddenPaused = false
const cancelers = new Set<() => void>() // pending waits, resolved early by stop()/pause changes
const wakers = new Set<() => void>() // pause-gate waiters

let connEpoch = 0 // bumped on every server 'hello' (new socket ⇒ registration lost)
let regEpoch = -1 // epoch our neuronId belongs to
let regAuth: string | null = null // sign-in token the current registration was made with
let reauthAt = 0 // earliest time (ms epoch) to retry a refused wallet re-registration
let errStreak = 0
let warmingUp = false // coordinator said "corpus warming up"; our request is queued server-side
let lastLiveJobAt = 0
let wasLiveThisSession = false

let trainReadyGen = -1 // loop generation whose trainer self-test already ran
let trainStrikes = 0 // consecutive GPU gradient faults
let trainTestedDevice: GPUDevice | null = null // device whose trainer self-test passed this session
/** Training INK per job this session: escrow state as the coordinator reported it. */
const trainLedger = new Map<string, { ink: number; status: 'confirmed' | 'pending' | 'forfeited' }>()
/** Send order of this session's training results (the coordinator's escrow seq follows it). */
const trainOrder = new Map<string, number>()
let trainOrderSeq = 0

let jobWaiter: ((job: AnyJob) => void) | null = null
let lateJob: AnyJob | null = null
let lateJobWaker: (() => void) | null = null // cuts a backoff short when a queued job lands
let reauthWaker: (() => void) | null = null // cuts a job wait short when the wallet sign-in changes
const sentJobs = new Set<string>() // jobs we returned results for (ink attribution)
const trainSent = new Set<string>() // the training jobs among them
const creditedJobs = new Set<string>() // jobs whose INK we already counted
const recentInk = new Map<string, InkEv>() // jobId → event (handles ink-before-wait races)
const inkWaiters = new Map<string, (ev: InkEv) => void>()
let sessionOffs: Array<() => void> = []
let visibilityBound = false

// Every server greeting means a (re)connected socket.
bus.on('hello', () => {
  connEpoch++
})

/** The registration no longer matches the wallet sign-in (verified, changed or dropped). */
const authStale = () => regAuth !== authToken()

// Wallet verification changed: link this device's current-period INK to the new wallet and
// re-register between jobs, so new INK is credited to the wallet right away.
useWallet.subscribe((s, prev) => {
  const tok = s.status === 'verified' ? (s.session?.token ?? null) : null
  const before = prev.status === 'verified' ? (prev.session?.token ?? null) : null
  if (tok === before) return
  reauthAt = 0
  if (tok && s.session) void linkDevice(s.session)
  if (loopPromise && loopGen === gen && regEpoch === connEpoch && authStale()) reauthWaker?.()
})

/**
 * Ask the server to move this device's INK from the current payout period to the newly
 * verified wallet (POST /api/auth/link-device, idempotent). Best effort: servers that link
 * on neuron.register instead answer 404, which is ignored.
 */
async function linkDevice(sess: AuthSession): Promise<void> {
  const id = storedDeviceId()
  if (!id) return // this browser never ran a neuron
  try {
    const res = await fetch('/api/auth/link-device', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sess.token, deviceId: id }),
    })
    if (!res.ok) return
    log(`linked this device to wallet ${sess.wallet.slice(0, 4)}…${sess.wallet.slice(-4)} for the current payout period`)
    refreshWalletPayouts(sess.wallet)
  } catch {
    /* server unreachable: registering with the token still links new work */
  }
}
// INK is credited even after stop(): an event for a result we already sent may
// land a moment later (attribution via neuronId or our sent-job ids).
bus.on('ink', (m) => {
  try {
    creditInk(m.event)
  } catch {
    /* malformed event: ignore */
  }
})

function capSet<T>(s: Set<T>, max: number) {
  if (s.size <= max) return
  const drop = s.size - max
  let i = 0
  for (const v of s) {
    if (i++ >= drop) break
    s.delete(v)
  }
}

// ─── cancellable waiting ──────────────────────────────────────────────────

/**
 * Wait for a bus-driven outcome. `setup` subscribes and returns unsubscribers;
 * `kick` (optional) fires the request AFTER subscribing — if it returns false
 * the wait resolves immediately with `onKickFail`. stop() resolves pending
 * waits with `onTimeout`; callers re-check the generation after awaiting.
 */
function waitFor<R>(
  timeoutMs: number,
  onTimeout: R,
  setup: (settle: (r: R) => void) => Array<() => void>,
  kick?: () => boolean,
  onKickFail?: R,
): Promise<R> {
  return new Promise<R>((resolve) => {
    let done = false
    let offs: Array<() => void> = []
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (r: R) => {
      if (done) return
      done = true
      if (timer !== null) clearTimeout(timer)
      cancelers.delete(cancel)
      for (const off of offs) {
        try {
          off()
        } catch {
          /* ignore */
        }
      }
      resolve(r)
    }
    const cancel = () => settle(onTimeout)
    cancelers.add(cancel)
    timer = setTimeout(cancel, timeoutMs)
    try {
      offs = setup(settle)
    } catch {
      settle(onTimeout)
      return
    }
    if (done) {
      for (const off of offs) off()
      return
    }
    if (kick) {
      let ok = false
      try {
        ok = kick()
      } catch {
        ok = false
      }
      if (!ok) settle(onKickFail ?? onTimeout)
    }
  })
}

function sleep(ms: number): Promise<void> {
  return waitFor<void>(Math.max(0, ms), undefined, () => [])
}

/** Like sleep(), but returns early if the coordinator pushes a job or the wallet sign-in changes. */
function sleepUntilJob(ms: number): Promise<void> {
  if (lateJob) return Promise.resolve()
  return waitFor<void>(Math.max(0, ms), undefined, (settle) => {
    lateJobWaker = () => settle(undefined)
    reauthWaker = () => settle(undefined)
    return [
      () => {
        lateJobWaker = null
        reauthWaker = null
      },
    ]
  })
}

/** Resolve when the LUSCA server connection is live (or after `ms`, or on stop()). */
function waitForServer(ms: number): Promise<void> {
  if (useLive.getState().conn === 'live') return Promise.resolve()
  return waitFor<void>(ms, undefined, (settle) => [
    useLive.subscribe((s) => {
      if (s.conn === 'live') settle(undefined)
    }),
  ])
}

/** "… retry in 27 s" → 27000 ms (coordinator cooldown messages), else null. */
function retryHintMs(msg: string): number | null {
  const m = /retry in (\d+)\s*s/i.exec(msg) ?? /re-register in (\d+)\s*s/i.exec(msg)
  return m ? Math.min(120000, Number(m[1]) * 1000 + 500) : null
}

/** A queued job for the current registration is waiting to be processed. */
const hasQueuedJob = () => lateJob !== null && regEpoch === connEpoch

function cancelAllWaits() {
  for (const c of [...cancelers]) c()
}

function wake() {
  for (const w of [...wakers]) w()
}

const isPaused = () => userPaused || hiddenPaused
const alive = (myGen: number) => gen === myGen

/** Resolve when not paused (or when the loop is cancelled, or a queued job must be finished). */
async function gate(myGen: number) {
  while (alive(myGen) && isPaused() && !hasQueuedJob()) {
    await new Promise<void>((r) => {
      const w = () => {
        wakers.delete(w)
        r()
      }
      wakers.add(w)
    })
  }
}

function syncRunStatus() {
  if (loopGen !== gen || !loopPromise) return
  const status: NeuronStatus = isPaused() ? 'paused' : 'running'
  if (get().status !== status) set({ status })
}

// ─── device / kernel ──────────────────────────────────────────────────────

async function ensureDevice(): Promise<GPUDevice> {
  if (device) return device
  if (devicePromise) return devicePromise
  devicePromise = (async () => {
    const det = get().detect
    const d = await acquireDevice(det && !detectedAdapterUsed ? det : null)
    detectedAdapterUsed = true
    d.lost.then(
      (info) => {
        if (device !== d) return
        device = null
        try {
          kernel?.destroy()
        } catch {
          /* ignore */
        }
        kernel = null
        destroyGpuTrainer()
        if (info.reason !== 'destroyed') log(`GPU device lost (${info.message || info.reason || 'unknown'}) — will re-acquire`)
      },
      () => {},
    )
    let uncaptured = 0
    d.onuncapturederror = (ev) => {
      // Rate-limited: a broken driver can fire this per dispatch.
      if (uncaptured++ < 5) log(`GPU error: ${trunc(ev.error.message, 140)}`)
    }
    device = d
    return d
  })()
  try {
    return await devicePromise
  } finally {
    devicePromise = null
  }
}

async function ensureKernel(): Promise<SimKernel> {
  if (kernel && device && kernel.device === device) return kernel
  const d = await ensureDevice()
  try {
    kernel?.destroy()
  } catch {
    /* ignore */
  }
  kernel = new SimKernel(d)
  kernel.setThroughputHint(get().bench?.gflops ?? 0)
  return kernel
}

function switchToCpu(why: string) {
  if (get().backend === 'cpu') return
  set({ backend: 'cpu' })
  log(`switching to CPU backend — ${why}`)
}

// ─── detection & benchmark ────────────────────────────────────────────────

/** Probe WebGPU (deduplicated; safe to call repeatedly). */
export async function detect(): Promise<GpuDetect> {
  if (detectPromise) return detectPromise
  const busy = loopPromise !== null || get().status === 'benchmarking'
  if (!busy) set({ status: 'detecting', error: null })
  detectPromise = (async () => {
    const d = await detectGpu()
    detectedAdapterUsed = false
    const patch: Partial<NeuronState> = { detect: d }
    if (!busy) {
      patch.status = d.supported ? (get().bench ? 'ready' : 'idle') : 'unsupported'
      if (!get().bench) patch.backend = d.supported ? 'webgpu' : 'cpu'
    }
    set(patch)
    if (d.supported) {
      log(`detected ${d.label}${d.isFallback ? ' (software adapter — expect low throughput)' : ''} · ${d.features.includes('timestamp-query') ? 'timestamp-query' : 'wall-clock timing'}`)
    } else {
      log(`WebGPU unavailable — ${d.reason ?? 'unknown reason'} · CPU fallback: ${d.cpu.label}`)
    }
    return d
  })()
  try {
    return await detectPromise
  } finally {
    detectPromise = null
  }
}

function toNeuronBench(r: BenchResult): NeuronBench {
  return { gflops: r.gflops, runs: r.runs, n: r.n, ms: r.ms, timing: r.timing, backend: r.backend }
}

/** Run the GEMM benchmark (GPU, or CPU fallback) and set bench + zone. */
export async function benchmark(): Promise<NeuronBench | null> {
  if (loopPromise) return get().bench // never benchmark while the work loop owns the GPU
  if (benchPromise) return benchPromise
  benchPromise = (async (): Promise<NeuronBench | null> => {
    try {
      const det = get().detect ?? (await detect())
      set({ status: 'benchmarking', error: null, benchProgress: { phase: 'validate', pct: 0 } })
      const onProgress = (p: BenchProgress) => set({ benchProgress: p })
      let result: BenchResult | null = null
      if (det.supported) {
        try {
          const dev = await ensureDevice()
          log('benchmark · validating GEMM kernel against CPU, then timing N=1024 / N=2048')
          result = await runBenchmark(dev, onProgress)
          deviceFailures = 0
        } catch (e) {
          log(`GPU benchmark failed: ${trunc(errText(e), 160)} — falling back to CPU`)
          result = null
        }
      }
      if (!result) result = await cpuBenchmark(onProgress)
      const bench = toNeuronBench(result)
      const zone = zoneFor(bench.gflops)
      set({
        bench,
        zone,
        backend: bench.backend,
        status: 'ready',
        benchProgress: { phase: 'done', pct: 100, gflops: bench.gflops, n: bench.n },
      })
      // shown as "last benchmark" after a reload, until the next one replaces it
      recordLastRun({ zone, gflops: bench.gflops, gpu: bench.backend === 'webgpu' && det.supported ? det.label : null, backend: bench.backend, at: Date.now() })
      kernel?.setThroughputHint(bench.gflops)
      const zoneName = ZONES.find((z) => z.zone === zone)?.name ?? zone
      log(
        `benchmark · ${fmtG(bench.gflops)} GFLOPS ${bench.backend === 'cpu' ? 'CPU' : 'FP32'} (median of ${bench.runs.length} @ N=${bench.n}, ${bench.timing}) → ${zone} · ${zoneName}`,
      )
      return bench
    } catch (e) {
      set({ status: 'error', error: `Benchmark failed: ${errText(e)}`, benchProgress: null })
      log(`benchmark error: ${trunc(errText(e), 160)}`)
      return null
    }
  })()
  try {
    return await benchPromise
  } finally {
    benchPromise = null
  }
}

// ─── compute (GPU with verification, CPU fallback) ────────────────────────

interface ComputeOut extends SimRun {
  check: SpotCheck
  backend: NeuronBackend
}

async function compute(
  myGen: number,
  a: Float32Array,
  b: Float32Array,
  rows: number,
  cols: number,
  dim: number,
  checkRows: number,
): Promise<ComputeOut> {
  const which = pickRows(rows, checkRows)
  if (get().backend === 'webgpu') {
    try {
      const k = await ensureKernel()
      if (!k.fits(rows, cols, dim)) throw new Error(`job ${rows}×${cols}×${dim} exceeds GPU limits`)
      const r = await k.run(a, b, rows, cols, dim)
      const check = spotCheck(a, b, rows, cols, dim, r, which)
      deviceFailures = 0
      if (check.passed === check.checked) {
        gpuStrikes = 0
        return { ...r, check, backend: 'webgpu' }
      }
      gpuStrikes++
      log(`GPU self-check failed ${check.checked - check.passed}/${check.checked} rows (max err ${check.maxErr.toExponential(1)}) — recomputing on CPU`)
      if (gpuStrikes >= 3) switchToCpu('GPU failed verification 3 times in a row')
    } catch (e) {
      if (!alive(myGen)) throw e
      deviceFailures++
      log(`GPU job error: ${trunc(errText(e), 140)} — using CPU for this job`)
      if (deviceFailures >= 3) switchToCpu('GPU unavailable after repeated errors')
    }
  }
  const r = await simCPU(a, b, rows, cols, dim, () => !alive(myGen))
  const check = spotCheck(a, b, rows, cols, dim, r, which)
  return { ...r, check, backend: 'cpu' }
}

// ─── INK accounting ───────────────────────────────────────────────────────

/** Recompute the session's confirmed / pending / forfeited training INK from the ledger. */
function syncTrainInk(simInk: number) {
  let confirmed = 0
  let pending = 0
  let forfeited = 0
  for (const e of trainLedger.values()) {
    if (e.status === 'confirmed') confirmed += e.ink
    else if (e.status === 'pending') pending += e.ink
    else forfeited += e.ink
  }
  set({ ink: simInk + confirmed, inkPending: pending, inkForfeited: forfeited })
}

let simInkTotal = 0 // confirmed INK from dedupe jobs this session

/**
 * Training INK (coordinator semantics): each verified gradient is credited 'pending' (escrow);
 * a passed full audit sends 'confirmed' for that job plus a second 'confirmed' event (same job
 * id, aggregate amount) releasing the identity's earlier escrow; a failed audit sends a
 * 'forfeited' event with the forfeited total. Absent status = confirmed. Only the first event of
 * a job sets that job's own amount; later events (release / forfeit) only move escrow state.
 * A passed audit releases only the escrow sent up to the audited job (jobs sent after it, e.g.
 * while it was audited, stay pending on the server); a failed audit forfeits all of it.
 */
function creditTrainInk(ev: InkEv, ink: number, first: boolean) {
  const st = ev.status
  if (first) trainLedger.set(ev.jobId, { ink: ev.verified ? ink : 0, status: ev.verified ? (st ?? 'confirmed') : 'forfeited' })
  if (st === 'forfeited') {
    for (const e of trainLedger.values()) if (e.status === 'pending') e.status = st
  } else if (st === 'confirmed' && ev.verified) {
    const upto = trainOrder.get(ev.jobId)
    for (const [id, e] of trainLedger) {
      if (e.status === 'pending' && (upto === undefined || (trainOrder.get(id) ?? 0) <= upto)) e.status = st
    }
  }
  if (trainLedger.size > 2000) {
    const k = trainLedger.keys().next().value
    if (k !== undefined) trainLedger.delete(k)
  }
  syncTrainInk(simInkTotal)
}

function isTrainEvent(ev: InkEv): boolean {
  return ev.kind === 'train' || trainSent.has(ev.jobId) || trainLedger.has(ev.jobId)
}

function creditInk(ev: InkEv) {
  const mine = (get().neuronId !== null && ev.neuronId === get().neuronId) || sentJobs.has(ev.jobId)
  if (!mine) return
  recentInk.set(ev.jobId, ev)
  if (recentInk.size > 200) {
    const first = recentInk.keys().next().value
    if (first !== undefined) recentInk.delete(first)
  }
  if (isTrainEvent(ev)) {
    const ink = Number.isFinite(ev.ink) ? ev.ink : 0
    const first = !creditedJobs.has(ev.jobId)
    if (first) {
      creditedJobs.add(ev.jobId)
      capSet(creditedJobs, 1000)
      const s = get()
      set({ verified: s.verified + (ev.verified ? 1 : 0), failed: s.failed + (ev.verified ? 0 : 1) })
      if (ev.verified) {
        if (/too old|\bstale\b/i.test(ev.reason)) set({ gradsStale: get().gradsStale + 1 })
        else set({ gradsApplied: get().gradsApplied + 1 })
      }
    }
    creditTrainInk(ev, ink, first)
    const h = get().history
    const i = first ? h.findIndex((p) => p.id === ev.jobId) : -1
    if (i >= 0 && (h[i].ink !== ink || h[i].verified !== ev.verified)) {
      const next = h.slice()
      next[i] = { ...h[i], ink, verified: ev.verified }
      set({ history: next })
    }
    const w = inkWaiters.get(ev.jobId)
    if (w) w(ev)
    return
  }
  if (!creditedJobs.has(ev.jobId)) {
    creditedJobs.add(ev.jobId)
    capSet(creditedJobs, 1000)
    const s = get()
    const ink = Number.isFinite(ev.ink) ? ev.ink : 0
    simInkTotal += ink
    set({
      ink: s.ink + ink,
      verified: s.verified + (ev.verified ? 1 : 0),
      failed: s.failed + (ev.verified ? 0 : 1),
    })
    // Patch the history point if the event arrived after we stopped waiting.
    const h = get().history
    const i = h.findIndex((p) => p.id === ev.jobId)
    if (i >= 0 && h[i].ink !== ink) {
      const next = h.slice()
      next[i] = { ...h[i], ink, verified: ev.verified }
      set({ history: next })
    }
  }
  const w = inkWaiters.get(ev.jobId)
  if (w) w(ev)
}

/** Our INK event for `jobId`, 'expired' if the coordinator says the result was stale, or null on timeout. */
function waitInk(jobId: string, ms = INK_WAIT_MS): Promise<InkEv | 'expired' | null> {
  const seen = recentInk.get(jobId)
  if (seen) return Promise.resolve(seen)
  return waitFor<InkEv | 'expired' | null>(ms, null, (settle) => {
    inkWaiters.set(jobId, settle)
    const offErr = bus.on('error', (m) => {
      if (/expired job/i.test(m.msg)) settle('expired')
    })
    return [() => inkWaiters.delete(jobId), offErr]
  })
}

// ─── jobs ─────────────────────────────────────────────────────────────────

function backoffMs(): number {
  const base = Math.min(15000, 1500 * 2 ** Math.max(0, errStreak - 1))
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

function adapterRecord(): Record<string, string> {
  const s = get()
  const d = s.detect
  const rec: Record<string, string> = {
    backend: s.backend ?? 'cpu',
    vendor: d?.info.vendor ?? '',
    architecture: d?.info.architecture ?? '',
    device: d?.info.device ?? '',
    description: d?.info.description ?? '',
    fallback: String(d?.isFallback ?? false),
    cores: String(d?.cpu.cores ?? ''),
    timing: s.bench?.timing ?? '',
    deviceId: neuronDeviceId(),
  }
  return rec
}

function neuronLabel(): string {
  const s = get()
  const d = s.detect
  if (s.backend === 'cpu' || !d?.supported) return d?.cpu.label ?? 'CPU'
  return d.label
}

type RegisterOutcome = { kind: 'ok'; neuron: NeuronInfo; auth?: 'verified' | 'invalid' | 'none' } | { kind: 'error'; msg: string } | { kind: 'timeout' }

const short4 = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`

/**
 * Register (or, with `reauth`, re-register on the same socket after a wallet verification
 * change). The wallet sign-in token is the only thing that links INK to a wallet; without one
 * the coordinator credits this device's account.
 */
async function register(myGen: number, reauth = false): Promise<boolean> {
  const s = get()
  const zone = s.zone ?? 'EPI'
  const gflops = s.bench?.gflops ?? 0
  const auth = authToken()
  const wallet = auth ? verifiedWallet() : null
  const msg: RegisterMsg = {
    t: 'neuron.register',
    label: neuronLabel(),
    zone,
    gflops: Math.round(gflops * 10) / 10,
    kind: 'browser',
    wallet,
    adapter: adapterRecord(),
    auth,
  }
  const res = await waitFor<RegisterOutcome>(
    REGISTER_WAIT_MS,
    { kind: 'timeout' },
    (settle) => [
      bus.on('neuron.ok', (m) => settle({ kind: 'ok', neuron: m.neuron, auth: m.auth })),
      bus.on('error', (m) => {
        // A stale-result notice refers to an earlier job, not this registration.
        if (/expired job/i.test(m.msg)) return
        settle({ kind: 'error', msg: m.msg })
      }),
    ],
    () => send(msg),
    { kind: 'error', msg: 'socket not open' },
  )
  if (!alive(myGen)) return false
  if (res.kind === 'ok') {
    regEpoch = connEpoch
    regAuth = auth
    reauthAt = 0
    errStreak = 0
    // A fresh registration voids anything queued for the old socket; a re-registration on the
    // same socket keeps its queued job (the coordinator still expects the answer).
    if (!reauth) lateJob = null
    // The server decides who is credited: 'invalid' = it refused the token (INK stays on this
    // device); a server without the field credits the wallet it echoes back, if any.
    const refused = !!auth && res.auth === 'invalid'
    const credited = refused || res.auth === 'none' ? null : res.auth === 'verified' ? (res.neuron.wallet ?? wallet) : wallet
    set({ neuronId: res.neuron.id, wallet: credited })
    if (refused) {
      log('the server did not accept the wallet sign-in — credits go to this device until the wallet is verified again')
      // regAuth stays the refused token, so the loop does not re-register with it again;
      // invalidate() clears the token, which makes the registration stale once more (→ device).
      useWallet.getState().invalidate('The LUSCA server did not accept this wallet sign-in. Verify the wallet again to receive SOL.')
      return true
    }
    const to = credited ? `wallet ${short4(credited)} (verified)` : 'this device'
    log(
      reauth
        ? `credits now go to ${to}`
        : `registered neuron ${shortId(res.neuron.id)} · ${neuronLabel()} · ${zone} · ${fmtG(gflops)} GFLOPS · credits go to ${to}`,
    )
    return true
  }
  if (res.kind === 'error' && auth && AUTH_REFUSED_RE.test(res.msg)) {
    // The server refused the sign-in token itself: drop it and register as this device.
    log(`the server did not accept the wallet sign-in (${trunc(res.msg, 100)}) — credits go to this device until the wallet is verified again`)
    useWallet.getState().invalidate('The LUSCA server did not accept this wallet sign-in. Verify the wallet again to receive SOL.')
    return false
  }
  const wait = (res.kind === 'error' ? retryHintMs(res.msg) : null) ?? backoffMs()
  if (reauth) {
    // The current registration keeps working; try the switch again later.
    reauthAt = Date.now() + wait
    log(`wallet link ${res.kind === 'timeout' ? 'timed out' : `refused: ${trunc(res.msg, 120)}`} — retry in ${Math.round(wait / 1000)} s; jobs continue meanwhile`)
    return false
  }
  errStreak++
  log(`registration ${res.kind === 'timeout' ? 'timed out' : `refused: ${trunc(res.msg, 120)}`} — retry in ${Math.round(wait / 1000)} s`)
  await sleep(wait)
  return false
}

type JobOutcome = { kind: 'job'; job: AnyJob } | { kind: 'error'; msg: string } | { kind: 'timeout' } | { kind: 'reauth' }

/** job.request with the training capability and the weights version we hold. */
function jobRequestMsg(): ClientMsg {
  return { t: 'job.request', caps: { train: true, version: heldVersion(), cpu: get().trainBackend === 'cpu' } }
}

function requestJob(): Promise<JobOutcome> {
  if (lateJob) {
    // Always answer a queued job, however old: an unanswered job counts as a
    // failure server-side, while a late answer is merely "stale". (No age check
    // on issuedAt either — it is server time and client clocks drift.)
    const j = lateJob
    lateJob = null
    return Promise.resolve({ kind: 'job', job: j })
  }
  return waitFor<JobOutcome>(
    JOB_WAIT_MS,
    { kind: 'timeout' },
    (settle) => {
      jobWaiter = (job) => settle({ kind: 'job', job })
      // The request stays queued server-side; a job pushed meanwhile is kept as lateJob.
      reauthWaker = () => settle({ kind: 'reauth' })
      const offErr = bus.on('error', (m) => {
        // A stale-result notice refers to an earlier job, not this request.
        if (/expired job/i.test(m.msg)) return
        settle({ kind: 'error', msg: m.msg })
      })
      return [
        offErr,
        () => {
          jobWaiter = null
          reauthWaker = null
        },
      ]
    },
    () => send(jobRequestMsg()),
    { kind: 'error', msg: 'socket not open' },
  )
}

function decodeJob(job: SimJob): { a: Float32Array; b: Float32Array } {
  if (job.kind !== 'simmatrix') throw new Error(`unknown job kind '${String((job as { kind?: unknown }).kind)}'`)
  const { rows, cols, dim } = job
  const okInt = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x >= 0
  if (!okInt(rows) || !okInt(cols) || !okInt(dim) || dim === 0) throw new Error(`bad job shape ${rows}×${cols}×${dim}`)
  const a = b64ToF32(job.a)
  const b = b64ToF32(job.b)
  if (a.length < rows * dim) throw new Error(`job A has ${a.length} floats, expected ${rows * dim}`)
  if (b.length < cols * dim) throw new Error(`job B has ${b.length} floats, expected ${cols * dim}`)
  return { a, b }
}

// ─── SEPIA training ───────────────────────────────────────────────────────

/** Training INK can take a full audit (server-side recompute) before its event: wait longer. */
const TRAIN_INK_WAIT_MS = 10000

function trainCpu(why: string) {
  if (get().trainBackend !== 'cpu' || get().trainNote !== why) set({ trainBackend: 'cpu', trainNote: why })
}

/**
 * Once per session, before any training job is accepted: on WebGPU, run the trainer self-test
 * (GPU gradient vs the shared/sepia reference on a fixed batch) and build the trainer; any
 * mismatch or error keeps gradients on the CPU path for this session.
 */
async function ensureTraining(myGen: number) {
  if (trainReadyGen === myGen) return
  trainReadyGen = myGen
  trainStrikes = 0
  if (get().backend !== 'webgpu') {
    trainCpu(get().detect?.supported === false ? 'WebGPU is not available in this browser' : 'the GPU did not pass the benchmark check')
    log('SEPIA gradients on the CPU path (shared reference implementation)')
    return
  }
  try {
    const dev = await ensureDevice()
    if (trainTestedDevice === dev && get().trainBackend === 'webgpu') return // passed earlier this session
    log('SEPIA trainer self-test · GPU gradient vs CPU reference on a fixed batch')
    const { test } = await prepareGpuTrainer(dev)
    if (!alive(myGen)) return
    trainTestedDevice = dev
    set({ trainBackend: 'webgpu', trainSelfTest: test, trainNote: null })
    log(`self-test passed · cosine ${test.cosine.toFixed(6)} · rel. error ${test.relErr.toExponential(2)} · loss Δ ${test.lossDiff.toExponential(2)} → gradients on the GPU`)
  } catch (e) {
    if (!alive(myGen)) return
    const test = (e as { test?: TrainSelfTest }).test ?? null
    set({ trainSelfTest: test })
    trainCpu(`the GPU trainer self-test failed: ${trunc(errText(e), 140)}`)
    log(`SEPIA trainer self-test failed (${trunc(errText(e), 140)}) — gradients on the CPU path this session`)
  }
}

async function runTrainJob(myGen: number, job: TrainJobWire) {
  let d: ReturnType<typeof decodeTrainJob>
  try {
    d = decodeTrainJob(job)
  } catch (e) {
    // Unusable job (usually a weights version we do not hold): forget our weights so the next
    // request asks for a full copy. The coordinator times the job out.
    dropWeights()
    errStreak++
    log(`training job ${shortId(job.id)} rejected locally: ${trunc(errText(e), 120)}`)
    await sleep(backoffMs())
    return
  }
  set({ task: 'train' })
  const backend: TrainBackend = get().trainBackend ?? 'cpu'
  const dev = backend === 'webgpu' ? (device ?? (await ensureDevice().catch(() => null))) : null
  const res = await computeGrad(backend === 'webgpu' && dev ? 'webgpu' : 'cpu', dev, d)
  if (!alive(myGen)) return
  if (res.gpuFault) {
    trainStrikes++
    log(`GPU gradient error: ${trunc(res.gpuFault, 120)} — computed on the CPU instead`)
    if (trainStrikes >= 3) {
      destroyGpuTrainer()
      trainCpu('the GPU trainer failed 3 times in a row')
      log('switching SEPIA gradients to the CPU path for this session')
    }
  } else if (res.backend === 'webgpu') {
    trainStrikes = 0
  }
  if (regEpoch !== connEpoch) {
    log(`training job ${shortId(job.id)} computed, but the connection was replaced meanwhile — re-registering`)
    return
  }
  sentJobs.add(job.id)
  trainSent.add(job.id)
  capSet(sentJobs, 1000)
  capSet(trainSent, 1000)
  const msg = { t: 'train.result' as const, result: { id: job.id, kind: 'train' as const, grad: res.grad, loss: res.loss, ms: Math.round(res.ms * 100) / 100 } }
  if (!send(msg as unknown as ClientMsg)) {
    log(`training job ${shortId(job.id)} computed but the socket closed before the result could be sent`)
    return
  }
  trainOrder.set(job.id, ++trainOrderSeq)
  if (trainOrder.size > 2000) {
    const k = trainOrder.keys().next().value
    if (k !== undefined) trainOrder.delete(k)
  }
  errStreak = 0
  const flops = Number.isFinite(job.flops) && job.flops > 0 ? job.flops : 0
  const gflopsEff = flops > 0 ? flops / (Math.max(res.ms, 0.001) * 1e6) : NaN
  const s = get()
  set({
    jobs: s.jobs + 1,
    flops: s.flops + flops,
    trainJobs: s.trainJobs + 1,
    trainSamples: s.trainSamples + d.B,
    lastTrain: { id: job.id, batch: d.B, version: job.version, loss: res.loss, ms: res.ms, gflopsEff, backend: res.backend },
  })

  const ev = await waitInk(job.id, TRAIN_INK_WAIT_MS)
  const head = `train ${shortId(job.id)} · v${job.version} · B=${d.B} · loss ${res.loss.toFixed(4)} · ${fmtMs(res.ms)} ms${res.backend === 'cpu' ? ' (cpu)' : ''}`
  const point = (ink: number, ok: boolean) => pushHistory({ ts: Date.now(), ms: res.ms, gflopsEff, ink, verified: ok, id: job.id })
  if (ev === 'expired') {
    point(0, false)
    log(`${head} · result arrived after the job expired (no credits)`)
  } else if (ev) {
    point(ev.ink, ev.verified)
    const st = ev.status ? ` · ${ev.status === 'pending' ? 'pending audit' : ev.status}` : ''
    log(ev.verified ? `${head} · +${ev.ink.toFixed(2)} credits${st}${ev.reason ? ` (${trunc(ev.reason, 60)})` : ''}` : `${head} · rejected${ev.reason ? ` (${trunc(ev.reason, 80)})` : ''}`)
  } else {
    point(0, false)
    if (alive(myGen)) log(`${head} · sent, awaiting verification`)
  }
}

async function liveStep(myGen: number) {
  wasLiveThisSession = true
  if (regEpoch !== connEpoch || !get().neuronId) {
    if (get().neuronId) set({ neuronId: null })
    const ok = await register(myGen)
    if (!ok) return
  } else if (authStale() && Date.now() >= reauthAt) {
    // Wallet verified, switched or dropped since we registered: re-register between jobs.
    await register(myGen, true)
    if (!alive(myGen)) return
  }

  const gap = LIVE_MIN_GAP_MS - (performance.now() - lastLiveJobAt)
  if (gap > 0 && !hasQueuedJob()) await sleep(gap)
  if (!alive(myGen)) return
  await gate(myGen)
  if (!alive(myGen)) return
  if (isPaused() && !hasQueuedJob()) return // paused meanwhile: do not ask for new work

  if (trainReadyGen !== myGen) {
    await ensureTraining(myGen) // self-test before the first training job is accepted
    if (!alive(myGen)) return
  }
  set({ task: null })
  const out = await requestJob()
  if (!alive(myGen)) return // stopped while waiting (a job assigned now expires server-side)
  if (out.kind === 'reauth') return // re-register first; the queued request (or job) carries over
  if (out.kind === 'timeout') {
    // The coordinator keeps the request queued (e.g. while the corpus warms up);
    // re-sending job.request is idempotent, and a pushed job ends the wait early.
    errStreak++
    const wait = backoffMs()
    if (!warmingUp) log(`no job from coordinator within ${JOB_WAIT_MS / 1000} s — retry in ${Math.round(wait / 1000)} s`)
    await sleepUntilJob(wait)
    return
  }
  if (out.kind === 'error') {
    if (/warming up/i.test(out.msg)) {
      // Not a failure: the request stays queued server-side and the job follows
      // automatically once the corpus has vectors.
      if (!warmingUp) log(`coordinator: ${trunc(out.msg, 80)} — request queued, waiting for the first job`)
      warmingUp = true
      await sleepUntilJob(JOB_WAIT_MS)
      return
    }
    errStreak++
    if (/regist|unknown neuron|not a neuron/i.test(out.msg)) regEpoch = -1
    const wait = retryHintMs(out.msg) ?? backoffMs()
    log(`coordinator: ${trunc(out.msg, 120)} — retry in ${Math.round(wait / 1000)} s`)
    await sleep(wait)
    return
  }
  warmingUp = false

  lastLiveJobAt = performance.now()
  if (out.job.kind === 'train') {
    await runTrainJob(myGen, out.job)
    return
  }
  const job = out.job
  set({ task: 'sim' })
  let decoded: { a: Float32Array; b: Float32Array }
  try {
    decoded = decodeJob(job)
  } catch (e) {
    errStreak++
    log(`job ${shortId(job.id)} rejected locally: ${trunc(errText(e), 120)}`)
    await sleep(backoffMs())
    return
  }
  const { rows, cols, dim } = job
  const res = await compute(myGen, decoded.a, decoded.b, rows, cols, dim, 1)
  if (!alive(myGen)) return
  const flops = Number.isFinite(job.flops) && job.flops > 0 ? job.flops : 2 * rows * cols * dim

  if (regEpoch !== connEpoch) {
    // The socket reconnected while we computed: this job died with the old
    // connection, and the next iteration re-registers.
    log(`job ${shortId(job.id)} computed, but the connection was replaced meanwhile — re-registering`)
    return
  }
  sentJobs.add(job.id)
  capSet(sentJobs, 1000)
  const ok = send({ t: 'job.result', result: { id: job.id, best: res.best, sim: res.sim, ms: Math.round(res.ms * 100) / 100 } })
  if (!ok) {
    log(`job ${shortId(job.id)} computed but the socket closed before the result could be sent`)
    return
  }
  errStreak = 0
  const gflopsEff = flops / (Math.max(res.ms, 0.001) * 1e6)
  const s = get()
  set({
    jobs: s.jobs + 1,
    flops: s.flops + flops,
    lastJob: { id: job.id, rows, cols, dim, ms: res.ms, gflopsEff },
  })

  const ev = await waitInk(job.id)
  const shape = `${rows}×${cols}×${dim}`
  const head = `job ${shortId(job.id)} · ${shape} · ${fmtGflop(flops)} GFLOP · ${fmtMs(res.ms)} ms${res.backend === 'cpu' ? ' (cpu)' : ''}`
  if (ev === 'expired') {
    pushHistory({ ts: Date.now(), ms: res.ms, gflopsEff, ink: 0, verified: false, id: job.id })
    log(`${head} · result arrived after the job expired (no credits)`)
  } else if (ev) {
    pushHistory({ ts: Date.now(), ms: res.ms, gflopsEff, ink: ev.ink, verified: ev.verified, id: job.id })
    log(ev.verified ? `${head} · verified +${ev.ink.toFixed(2)} credits` : `${head} · rejected${ev.reason ? ` (${trunc(ev.reason, 60)})` : ''}`)
  } else {
    pushHistory({ ts: Date.now(), ms: res.ms, gflopsEff, ink: 0, verified: false, id: job.id })
    if (alive(myGen)) log(`${head} · sent, awaiting verification`)
  }
}

// ─── the loop ─────────────────────────────────────────────────────────────

async function runLoop(myGen: number) {
  let waiting = false
  while (alive(myGen)) {
    await gate(myGen) // returns early when a queued job must be finished
    if (!alive(myGen)) break
    try {
      if (useLive.getState().conn === 'live') {
        if (waiting) log('LUSCA server reachable — resuming verified jobs')
        waiting = false
        await liveStep(myGen)
      } else {
        // No server, no work: jobs only come from (and are only checked and paid by) the server.
        if (!waiting) {
          waiting = true
          regEpoch = -1 // the registration died with the socket
          if (get().neuronId) set({ neuronId: null })
          log(
            wasLiveThisSession
              ? "can't reach the LUSCA server — waiting for it to come back; no jobs run meanwhile"
              : 'waiting for the LUSCA server — jobs start when it answers',
          )
        }
        await waitForServer(SERVER_WAIT_MS)
      }
    } catch (e) {
      if (!alive(myGen)) break
      errStreak++
      log(`neuron error: ${trunc(errText(e), 160)}`)
      await sleep(backoffMs())
    }
  }
}

function onVisibility() {
  if (typeof document === 'undefined') return
  if (document.hidden) {
    if (!hiddenPaused && loopPromise && loopGen === gen) {
      hiddenPaused = true
      syncRunStatus()
      log('tab hidden — pausing neuron')
    }
  } else if (hiddenPaused) {
    hiddenPaused = false
    syncRunStatus()
    wake()
    if (!userPaused) log('tab visible — resuming')
  }
}

function attachSession() {
  detachSession()
  sessionOffs = [
    bus.on('job', (m) => {
      if (jobWaiter) {
        jobWaiter(m.job)
        return
      }
      // Unsolicited / late job (e.g. queued by the coordinator after "corpus
      // warming up"): keep it, and wake the loop — even when paused, in-flight
      // work is finished so the coordinator does not time it out as a failure.
      lateJob = m.job
      lateJobWaker?.()
      wake()
    }),
  ]
  if (typeof document !== 'undefined' && !visibilityBound) {
    document.addEventListener('visibilitychange', onVisibility)
    visibilityBound = true
  }
}

function detachSession() {
  for (const off of sessionOffs) {
    try {
      off()
    } catch {
      /* ignore */
    }
  }
  sessionOffs = []
  if (typeof document !== 'undefined' && visibilityBound) {
    document.removeEventListener('visibilitychange', onVisibility)
    visibilityBound = false
  }
}

// ─── controller ───────────────────────────────────────────────────────────

/** Start contributing. Benchmarks first if needed. No-op if already running. */
export async function start(): Promise<void> {
  if (starting) return
  if (loopPromise && loopGen === gen) return // already running
  starting = true
  try {
    // A previous loop may still be winding down (stop() then start()): let it finish.
    if (loopPromise) await loopPromise.catch(() => {})
    if (loopPromise) return
    const genAtCall = gen
    if (!get().bench) {
      const b = await benchmark()
      if (!b) return
    }
    if (gen !== genAtCall) return // stop() was called while we were benchmarking
    const myGen = ++gen
    loopGen = myGen
    userPaused = false
    hiddenPaused = typeof document !== 'undefined' && document.hidden
    errStreak = 0
    warmingUp = false
    lateJob = null
    wasLiveThisSession = false
    gpuStrikes = 0
    regEpoch = -1
    regAuth = null
    reauthAt = 0
    attachSession()
    set({
      status: hiddenPaused ? 'paused' : 'running',
      wallet: null,
      neuronId: null,
      error: null,
    })
    log(`neuron starting · ${neuronLabel()} · ${get().zone ?? 'EPI'} · ${get().backend === 'cpu' ? 'CPU backend' : 'WebGPU backend'}`)
    if (hiddenPaused) log('tab is hidden — the neuron starts working when it becomes visible')
    const p: Promise<void> = runLoop(myGen)
      .catch((e) => {
        set({ status: 'error', error: `Neuron loop crashed: ${errText(e)}` })
        log(`neuron loop crashed: ${trunc(errText(e), 160)}`)
      })
      .finally(() => {
        if (loopPromise === p) loopPromise = null
        if (loopGen === myGen) loopGen = -1
      })
    loopPromise = p
    markEarning(true) // a reload of this tab resumes earning
  } finally {
    starting = false
  }
}

/** Pause after the in-flight job completes (by hand: a reload stays paused). */
export function pause() {
  if (!loopPromise || loopGen !== gen || userPaused) return
  userPaused = true
  markEarning(false)
  syncRunStatus()
  log('paused')
}

export function resume() {
  if (!loopPromise || loopGen !== gen || !userPaused) return
  userPaused = false
  markEarning(true)
  syncRunStatus()
  wake()
  log(hiddenPaused ? 'resumed (will start when the tab is visible)' : 'resumed')
}

/** Stop the loop, tell the coordinator we are leaving, keep the benchmark. */
export async function stop(): Promise<void> {
  gen++ // invalidates the running loop (and a start() that is still benchmarking)
  markEarning(false) // a reload stays stopped
  const p = loopPromise
  if (!p) {
    cancelAllWaits()
    const s = get().status
    if (s === 'running' || s === 'paused') set({ status: get().bench ? 'ready' : 'idle' })
    return
  }
  userPaused = false
  hiddenPaused = false
  cancelAllWaits()
  wake()
  if (get().neuronId && regEpoch === connEpoch && useLive.getState().conn === 'live') {
    try {
      send({ t: 'neuron.leave' })
    } catch {
      /* ignore */
    }
  }
  regEpoch = -1
  regAuth = null
  detachSession()
  set({ status: get().bench ? 'ready' : 'idle', neuronId: null, task: null })
  log('neuron stopped')
  try {
    await p
  } catch {
    /* already handled */
  }
}

/** Namespaced controller, for call sites that prefer `neuron.start()`. */
export const neuron = { detect, benchmark, start, pause, resume, stop }
