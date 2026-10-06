// GPU neuron coordinator.
//
// Browser / desktop "neurons" do REAL, verifiable work for the crawl: semantic
// near-duplicate detection. Each job is a block cosine-similarity problem —
// a group of page vectors (rows) against a block of OLDER corpus pages (cols) —
// and the neuron returns, per row, the best-matching column and its
// similarity. Every result is spot-checked on the CPU against the reference
// implementation in shared/vectorize.ts before any INK is issued, and verified
// matches above the duplicate threshold are reported back to the crawler.
//
// Work is never paid twice. The coordinator tracks coverage per row page (the
// next corpus column it still has to be compared against, up to its own corpus
// index), leases rows exclusively to one job at a time and advances coverage
// only on a verified result, so every paid (row, col) pair is novel and
// concurrent neurons always get disjoint tiles. When every pair is covered no
// job is issued; the request stays queued until new pages arrive.
//
// Trust: the zone a client claims (its benchmark GFLOPS) is only an upper
// bound. Job size starts at EPI and ramps one zone per verified job while the
// a GPU-speed proof from server-measured end-to-end throughput on large jobs
// predicts the next size finishes well inside the timeout. The INK zone bonus
// is frozen at issue time from min(claimed, measured × 3) once 3 jobs have been
// measured (capped at MESO before that). Strikes and cooldowns are keyed by
// adapter.deviceId / wallet / remote IP (never by connection id) and survive
// leave + re-register and reconnects.
//
// The INK ledger (per wallet / device / label) and lifetime network totals are
// persisted to <dataDir>/ledger.json (fsync'd tmp file + rename, previous copy
// kept as ledger.json.bak) a couple of seconds after every change. A ledger
// account is created only by the first verified job (≥ 0.01 INK), at most
// LUSCA_NEW_ACCOUNTS_PER_HOUR per IPv4 address / IPv6 /56. Once the ledger is
// 90% full, accounts holding < 1 INK that were idle for LUSCA_ACCOUNT_IDLE_DAYS
// are evicted (oldest first) so sybils cannot lock new contributors out.
// Every credit is also appended to <dataDir>/issuance.log (see issuance.ts).
//
// Egress: job payloads share one global budget (LUSCA_ISSUE_MB_PER_SEC), a
// neuron only gets a new job once at least JOB_ROWS[size]/2 uncovered rows can
// share it (or LUSCA_JOB_FILL_WAIT_S passed since its last job), and the
// 'neurons' broadcast lists only the top LUSCA_NEURONS_TOP neurons by INK.
// Raw device ids are never published (public ledger keys are salted hashes).
//
// Wallets: INK is credited to a wallet ONLY when neuron.register carries a valid session
// token (`auth`, minted by server/auth after the wallet signed the sign-in message). A bare
// `wallet` field is ignored: INK stays on the device (or label) account. On a device's first
// verified register in the current payout period, the INK that device account earned in the
// period moves to the wallet (once per period, persisted with the ledger).
//
// Payout periods: every account carries `periodInk` (INK since the last closed period). The
// payout engine (server/payouts) reads the verified wallets' period INK through `payouts`
// (PayoutLedger) and closes a period atomically: snapshot → persisted plan → reset with
// carry-over → synchronous ledger save.
//
// Account watches: any connection (a page that just opened, registered or not) may send
// account.watch to follow its own ledger account. The scope resolves like neuron.register (valid
// session token → wallet:<w>, else device id → device:<id>) and is answered at once with an
// 'account' message. Every ledger / escrow mutation touches the account key; touched keys that
// someone watches are pushed again after ACCOUNT_FLUSH_MS, at most one push per connection per
// ACCOUNT_PUSH_MIN_MS (a trailing push reads the account when it fires, so the last value always
// arrives). Only watched keys are computed; escrowed INK per account comes from an index.

import fs from 'node:fs'
import path from 'node:path'
import { isIP } from 'node:net'
import { performance } from 'node:perf_hooks'
import { randomInt } from 'node:crypto'
import { ZONES, zoneFor } from '../../shared/protocol.ts'
import type { AccountView, ClientMsg, InkEvent, NeuronInfo, ServerMsg, SimJob, TrainJob, Zone } from '../../shared/protocol.ts'
import { VEC_DIM, bestMatchesCPU } from '../../shared/vectorize.ts'
import { f32ToB64 } from '../../shared/b64.ts'
import type { CoordinatorApi, CoordinatorOptions, NeuronConn, PayoutLedger, PeriodSnapshotRow } from '../contracts.ts'
import { createIssuanceLog, hashId, loadHashSalt } from './issuance.ts'

// ─── tunables ────────────────────────────────────────────────────────────────

/** Rows (page vectors) per job, by depth zone. */
export const JOB_ROWS: Record<Zone, number> = { EPI: 16, MESO: 32, BATHY: 64, ABYSSO: 128, HADAL: 256 }
/** Corpus columns per job, by depth zone (capped by the uncovered range). */
export const JOB_COLS: Record<Zone, number> = { EPI: 512, MESO: 1024, BATHY: 2048, ABYSSO: 4096, HADAL: 8192 }

/** Absolute tolerance for similarity agreement between GPU (f32) and CPU reference. */
export const SIM_TOLERANCE = 2e-3
/** Rows recomputed on the CPU per job (all rows when the job has fewer). */
export const SPOT_CHECK_ROWS = 4
/** Verified cosine similarity at/above which two distinct pages are near-duplicates. */
export const DUP_THRESHOLD = 0.92

/**
 * Proof of GPU-class speed. End-to-end time (send → result) is dominated by transfer on small
 * jobs, so only large jobs count: on a ≥0.25 GFLOP job a GPU answers at well over 3 GFLOPS
 * end-to-end while the JavaScript CPU path manages ~1–2. A neuron that claims a tier deeper
 * than MESO earns that tier's INK bonus only after BIG_MIN_JOBS large jobs averaging at least
 * GPU_GATE_GFLOPS; until then (or if it measures slower) the bonus is capped at MESO.
 */
export const BIG_JOB_FLOPS = 2.5e8
export const BIG_MIN_JOBS = 2
export const GPU_GATE_GFLOPS = 3
/** Verified jobs measured before job sizing trusts the measured throughput. */
export const MEASURED_MIN_JOBS = 3
/** Highest INK bonus zone before a neuron has proven GPU-class speed. */
export const UNMEASURED_INK_CAP: Zone = 'MESO'

/** SEPIA gradient batch (sequences) per job, by job-size zone (contract 5); CPU-backend neurons get CPU_TRAIN_BATCH. */
export const TRAIN_BATCH: Record<Zone, number> = { EPI: 256, MESO: 512, BATHY: 1024, ABYSSO: 2048, HADAL: 4096 }
export const CPU_TRAIN_BATCH = 128
/** A neuron's first FORCE_AUDIT_JOBS gradient results are always fully audited. */
export const FORCE_AUDIT_JOBS = 3
const TRAIN_JOB_TIMEOUT_MS = 60_000 // gradient jobs carry the weights on first issue: allow the download
const TRAIN_NULL_BACKOFF_MS = 5_000 // trainer had no job (corpus too small / paused): dedupe jobs meanwhile
// First weights download (~500 KB) per network (IPv4 /24, IPv6 /64): burst, then one per interval.
// Stops fresh connections from turning a few hundred request bytes into the whole egress budget.
const WEIGHTS_NET_BURST = 4
const WEIGHTS_NET_EVERY_MS = 15_000
const MAX_GRAD_B64 = 4 << 20        // encodeGrad of 187k params is ~0.5 MB base64
const MAX_ESCROW_RECORDS = 200_000

const MIN_JOB_GAP_MS = 120          // per-neuron minimum spacing between job issues
const JOB_TIMEOUT_MS = 20_000       // an unanswered job counts as failed
const MAX_CONSEC_FAILS = 3          // per identity (device / wallet / ip), then cooldown
const IP_MAX_CONSEC_FAILS = 12      // per remote IP across identities, then cooldown
const KICK_COOLDOWN_MS = 30_000     // first cooldown; doubles per repeat offence
const MAX_KICK_COOLDOWN_MS = 15 * 60_000
const IDENT_TTL_MS = 60 * 60_000    // strike / measurement records expire after an idle hour
const MAX_IDENTS = 100_000
const MIN_CORPUS = 8                // below this, jobs are issued after a short delay
const SMALL_CORPUS_DELAY_MS = 600
const WARMUP_RETRY_MS = 1_500       // re-check cadence while the corpus is empty
const IDLE_RETRY_MS = 2_000         // re-check cadence while every pair is covered
const BUDGET_RETRY_MS = 250         // re-check cadence while an issuance budget is exhausted
const MAX_BUDGET_WAIT_MS = 5_000    // longest single wait for the global byte budget to refill
const NEURONS_THROTTLE_MS = 500     // ≤ 2 'neurons' broadcasts per second on change
const NEURONS_HEARTBEAT_MS = 5_000  // plus an unconditional broadcast every 5 s
const LEDGER_SAVE_MS = 30_000       // fallback save cadence
const LEDGER_DEBOUNCE_MS = 2_000    // save this long after any change
const MAX_NEURONS = 1_024
const MAX_NEURONS_PER_IP = 8
const REGISTER_WINDOW_MS = 60_000
const MAX_REGISTERS_PER_IP = 20     // neuron.register messages per IP per minute
/** A socket closed with a job outstanding (reload, network drop): scored as abandoned only if its identity does not register again within this. */
export const REJOIN_GRACE_MS = 60_000
const MAX_ABANDONED = 4_096         // closed-socket jobs awaiting their grace at once; past it they are scored right away
const ACCOUNT_SWITCH_MS = 60_000    // a live neuron may change its ledger account at most once a minute
const NEW_ACCOUNT_WINDOW_MS = 60 * 60_000
/** A ledger account is only created by a verified job worth at least this much INK. */
export const MIN_ACCOUNT_INK = 0.01
/** Accounts below this balance may be evicted once idle (LUSCA_ACCOUNT_IDLE_DAYS) and the ledger is near its cap. */
export const EVICT_MAX_INK = 1
const EVICT_AT = 0.9                // start evicting idle low-balance accounts at 90% of the cap…
const EVICT_TO = 0.85               // …down to 85%
const EVICT_EVERY_MS = 60_000       // at most one eviction scan a minute
const LEADERBOARD_SIZE = 100
const MAX_MARKED_PAIRS = 100_000
const GFLOPS_MIN = 1
const GFLOPS_MAX = 200_000
const EWMA_KEEP = 0.7
const RAMP_UP_BUDGET_MS = JOB_TIMEOUT_MS / 4   // step up only if the next size is predicted to take < 5 s
const RAMP_DOWN_BUDGET_MS = JOB_TIMEOUT_MS / 2 // step down when the current size is predicted to take > 10 s
const ROW_POOL = 4_096              // newest pages tracked for coverage
const MAX_SEND_BACKLOG = 1024 * 1024 // don't issue while the neuron's socket is this far behind
const COL_CACHE_SIZE = 4
const MB = 1024 * 1024
/** Push touched watched accounts this long after the first change (changes in between coalesce). */
export const ACCOUNT_FLUSH_MS = 250
/** At most one 'account' push per connection per this interval (trailing push guaranteed). */
export const ACCOUNT_PUSH_MIN_MS = 1_000
const WATCH_BURST = 6               // account.watch requests per connection: burst…
const WATCH_REFILL_MS = 2_000       // …then one per 2 s (a held request is applied when a token refills)
const MAX_WATCH_DEVICE_LEN = 64     // longest valid device id (DEVICE_ID_RE)
const MAX_WATCH_AUTH_LEN = 512      // longest session token server/auth accepts
/** Client-supplied device ids (adapter.deviceId on register, `device` on account.watch). */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/

// ─── deploy-time limits (env, overridable per instance) ─────────────────────

export interface CoordinatorLimits {
  /** Global job payload budget on the wire, bytes/s, shared by all neurons (LUSCA_ISSUE_MB_PER_SEC, default 2). */
  issueBytesPerSec: number
  /** A neuron gets a job with fewer than JOB_ROWS/2 rows only this long after its last job (LUSCA_JOB_FILL_WAIT_S, default 30; 0 = never hold). */
  jobFillWaitMs: number
  /** Neurons listed in 'neurons' broadcasts, the hello and /api/neurons: the top N by INK (LUSCA_NEURONS_TOP, default 50). */
  neuronsTop: number
  /** Ledger accounts, hard cap (LUSCA_MAX_ACCOUNTS, default 50000). */
  maxAccounts: number
  /** Idle time after which an account with < 1 INK may be evicted near the cap (LUSCA_ACCOUNT_IDLE_DAYS, default 7). */
  accountIdleMs: number
  /** New ledger accounts per IPv4 address / IPv6 /56 per hour (LUSCA_NEW_ACCOUNTS_PER_HOUR, default 30). */
  newAccountsPerHour: number
  /** Vector bytes held for outstanding jobs, all neurons (LUSCA_MAX_PENDING_MB, default 64). */
  maxPendingBytes: number
  /** Concurrent ABYSSO / HADAL sized jobs (LUSCA_MAX_BIG_JOBS, default 8). */
  maxBigJobs: number
  /** Main-thread ms per second spent on CPU spot-checks, sustained (LUSCA_VERIFY_MS_PER_SEC, default 200). */
  verifyMsPerSec: number
  /** issuance.log size that triggers rotation; 0 disables the log (LUSCA_ISSUANCE_LOG_MB, default 50). */
  issuanceLogBytes: number
  /** Rotated issuance-*.log.gz archives kept; 0 = keep all (LUSCA_ISSUANCE_LOG_KEEP, default 10). */
  issuanceLogKeep: number
}

/** Resolve limits from the environment (invalid values fall back to the default; out-of-range values are clamped). */
export function resolveLimits(
  env: Record<string, string | undefined> = process.env,
  over: Partial<CoordinatorLimits> = {},
  warn: (msg: string) => void = () => undefined,
): CoordinatorLimits {
  const read = (name: string, def: number, min: number, max: number): number => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return def
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      warn(`${name}=${JSON.stringify(raw)} is not a number — using ${def}`)
      return def
    }
    return Math.min(max, Math.max(min, n))
  }
  const limits: CoordinatorLimits = {
    issueBytesPerSec: Math.round(read('LUSCA_ISSUE_MB_PER_SEC', 2, 0.05, 1024) * MB),
    jobFillWaitMs: Math.round(read('LUSCA_JOB_FILL_WAIT_S', 30, 0, 600) * 1000),
    neuronsTop: Math.floor(read('LUSCA_NEURONS_TOP', 50, 1, MAX_NEURONS)),
    maxAccounts: Math.floor(read('LUSCA_MAX_ACCOUNTS', 50_000, 100, 10_000_000)),
    accountIdleMs: Math.round(read('LUSCA_ACCOUNT_IDLE_DAYS', 7, 0, 3650) * 86_400_000),
    newAccountsPerHour: Math.floor(read('LUSCA_NEW_ACCOUNTS_PER_HOUR', 30, 1, 1_000_000)),
    maxPendingBytes: Math.round(read('LUSCA_MAX_PENDING_MB', 64, 1, 4096) * MB),
    maxBigJobs: Math.floor(read('LUSCA_MAX_BIG_JOBS', 8, 0, 1024)),
    verifyMsPerSec: read('LUSCA_VERIFY_MS_PER_SEC', 200, 10, 1000),
    issuanceLogBytes: Math.round(read('LUSCA_ISSUANCE_LOG_MB', 50, 0, 10_240) * MB),
    issuanceLogKeep: Math.floor(read('LUSCA_ISSUANCE_LOG_KEEP', 10, 0, 100_000)),
  }
  for (const [k, v] of Object.entries(over)) if (typeof v === 'number' && Number.isFinite(v)) (limits as unknown as Record<string, number>)[k] = v
  return limits
}

// ─── pure helpers (exported for tests) ──────────────────────────────────────

/**
 * Float32Array → base64. Output is byte-for-byte identical to f32ToB64 from
 * shared/b64.ts (asserted in server/neurons/_test.ts) but uses Node's native
 * encoder: ~2 ms instead of ~160 ms for an 8 MB HADAL column block.
 */
export function encodeF32(arr: Float32Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64')
  return f32ToB64(arr)
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100
}

/** Period INK keeps 6 decimals: carry-over after the per-wallet cap is fractional. */
export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6
}

export function zoneIndex(zone: Zone): number {
  const i = ZONES.findIndex((z) => z.zone === zone)
  return i < 0 ? 0 : i
}

export function zoneAt(idx: number): Zone {
  return ZONES[Math.max(0, Math.min(ZONES.length - 1, Math.floor(idx)))]?.zone ?? 'EPI'
}

/**
 * INK for a verified job: 1 INK per 100 MFLOP of verified work, with a 15%
 * bonus per depth zone. Verified work always earns at least 0.01 so tiny
 * warm-up jobs still register on the ledger.
 */
export function inkFor(flops: number, zoneIdx: number): number {
  return Math.max(0.01, round2((flops / 1e8) * (1 + 0.15 * zoneIdx)))
}

/**
 * Zone used for the INK bonus: the claimed (benchmarked) zone, except that a claim deeper than
 * UNMEASURED_INK_CAP is capped there until the neuron has proven GPU-class speed on large jobs.
 */
export function bonusZoneFor(claimedGflops: number, bigGflops: number, bigJobs: number): Zone {
  const claimedIdx = zoneIndex(zoneFor(claimedGflops))
  const capIdx = zoneIndex(UNMEASURED_INK_CAP)
  if (claimedIdx <= capIdx) return zoneAt(claimedIdx)
  if (bigJobs >= BIG_MIN_JOBS && bigGflops >= GPU_GATE_GFLOPS) return zoneAt(claimedIdx)
  return zoneAt(capIdx)
}

/** Server-measured end-to-end throughput of one job in GFLOPS (flops over send → result wall time). */
export function measuredGflops(flops: number, rttMs: number): number {
  return flops / (Math.max(1, rttMs) * 1e6)
}

/** Distinct random row indices to spot-check (all rows when rows ≤ k). Uses a CSPRNG. */
export function pickCheckRows(rows: number, k = SPOT_CHECK_ROWS): number[] {
  if (rows <= k) return Array.from({ length: rows }, (_, i) => i)
  const picked = new Set<number>()
  while (picked.size < k) picked.add(randomInt(rows))
  return [...picked].sort((x, y) => x - y)
}

/** Structural validation of a job.result against the job it answers. Returns an error or null. */
export function validateResultShape(result: unknown, rows: number, cols: number): string | null {
  if (!result || typeof result !== 'object') return 'result is not an object'
  const r = result as { best?: unknown; sim?: unknown; ms?: unknown }
  if (!Array.isArray(r.best) || !Array.isArray(r.sim)) return 'best/sim must be arrays'
  if (r.best.length !== rows || r.sim.length !== rows) return `expected ${rows} rows, got best=${r.best.length} sim=${r.sim.length}`
  for (let i = 0; i < rows; i++) {
    const b = r.best[i]
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b >= cols) return `row ${i}: best index out of range`
    const s = r.sim[i]
    if (typeof s !== 'number' || !Number.isFinite(s) || s < -1.01 || s > 1.01) return `row ${i}: similarity not a finite cosine`
  }
  if (r.ms !== undefined && (typeof r.ms !== 'number' || !Number.isFinite(r.ms) || r.ms < 0)) return 'ms must be a non-negative number'
  return null
}

export interface VerifiableJob {
  a: Float32Array
  b: Float32Array
  rows: number
  cols: number
  dim: number
}

export interface VerifyOutcome {
  ok: boolean
  checked: number
  passed: number
  failRow: number | null
  delta: number
}

function dot(a: Float32Array, ao: number, b: Float32Array, bo: number, dim: number): number {
  let d = 0
  for (let k = 0; k < dim; k++) d += a[ao + k] * b[bo + k]
  return d
}

/**
 * Recompute `rowsToCheck` on the CPU and compare with the neuron's claim.
 * A row passes when the claimed similarity is within SIM_TOLERANCE of the
 * reference best similarity AND either the claimed index is the reference
 * index, or the claimed index is a tie (its true similarity is also within
 * tolerance of the reference best). Assumes the shape was validated first.
 */
export function verifySimResult(
  job: VerifiableJob,
  result: { best: number[]; sim: number[] },
  rowsToCheck: number[],
): VerifyOutcome {
  const ref = bestMatchesCPU(job.a, job.b, job.rows, job.cols, job.dim, rowsToCheck)
  let passed = 0
  for (let i = 0; i < ref.rows.length; i++) {
    const r = ref.rows[i]
    const refSim = ref.sim[i]
    const claimedSim = result.sim[r]
    const claimedBest = result.best[r]
    const dSim = Math.abs(claimedSim - refSim)
    // `!(x < tol)` also rejects NaN
    if (!(dSim < SIM_TOLERANCE)) return { ok: false, checked: ref.rows.length, passed, failRow: r, delta: dSim }
    if (claimedBest !== ref.best[i]) {
      const actual = dot(job.a, r * job.dim, job.b, claimedBest * job.dim, job.dim)
      const dTie = Math.abs(actual - refSim)
      if (!(dTie < SIM_TOLERANCE)) return { ok: false, checked: ref.rows.length, passed, failRow: r, delta: dTie }
    }
    passed++
  }
  return { ok: true, checked: ref.rows.length, passed, failRow: null, delta: 0 }
}

function fmtFlops(flops: number): string {
  const g = flops / 1e9
  if (g >= 10) return `${g.toFixed(1)} GFLOP`
  if (g >= 0.1) return `${g.toFixed(2)} GFLOP`
  return `${g.toFixed(3)} GFLOP`
}

function fmtDelta(d: number): string {
  if (!Number.isFinite(d)) return 'NaN'
  return d >= 0.01 ? d.toFixed(2) : d.toExponential(1)
}

function sanitizeLabel(v: unknown, adapter: Record<string, string> | null): string {
  let s = typeof v === 'string' ? v : ''
  if (!s.trim() && adapter) s = [adapter.vendor, adapter.architecture].filter((x) => typeof x === 'string' && x).join(' · ')
  // strip control characters (intentional control-char regex), collapse whitespace
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim()
  return s.slice(0, 48) || 'anonymous neuron'
}

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ // base58 alphabet (no 0 O I l)
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * A wallet is either a Solana address (base58, 32–44 chars) or an EVM address (0x + 40 hex,
 * lowercased: EIP-55 checksum casing must not split one address into several ledger accounts).
 * Anything else is treated as no wallet.
 */
export function sanitizeWallet(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const w = v.trim()
  if (EVM_ADDR_RE.test(w)) return w.toLowerCase()
  return SOLANA_ADDR_RE.test(w) ? w : null
}

/** IPv6 text → 8 hextets (accepts '::' compression and an embedded IPv4 tail), or null. */
function v6Hextets(s: string): number[] | null {
  let str = s
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(str)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number)
    str = `${str.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = str.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null
  const out = [...head, ...Array<string>(fill).fill('0'), ...tail].map((h) => (/^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16) : NaN))
  return out.length === 8 && out.every((x) => Number.isInteger(x)) ? out : null
}

/**
 * Rate-limit key for new ledger accounts: the IPv4 address, or the IPv6 /56 (a typical
 * end-site allocation, so one subscriber cannot multiply the limit by hopping /64s).
 * Accepts plain, bracketed, IPv4-mapped and prefix-suffixed ('2001:db8:1:2::/64') forms.
 */
export function accountNetKey(ip: string): string {
  let s = String(ip ?? '').trim().replace(/^\[|\]$/g, '').replace(/\/\d{1,3}$/, '').replace(/%.*$/, '')
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(s)) s = s.slice(7)
  const kind = isIP(s)
  if (kind === 4) return `ip4:${s}`
  if (kind === 6) {
    const h = v6Hextets(s)
    if (h) return `ip6:${h[0].toString(16)}:${h[1].toString(16)}:${h[2].toString(16)}:${(h[3] & 0xff00).toString(16)}::/56`
  }
  return `ip:${s || 'unknown'}`
}

function sanitizeAdapter(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const out: Record<string, string> = {}
  let n = 0
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string' || n++ >= 16) continue
    out[k.slice(0, 32)] = val.slice(0, 96)
  }
  return out
}

function clampGflops(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : GFLOPS_MIN
  return Math.round(Math.min(GFLOPS_MAX, Math.max(GFLOPS_MIN, n)) * 10) / 10
}

function errCode(e: unknown): string {
  return (e as NodeJS.ErrnoException)?.code ?? ''
}

/** Synchronous sleep (boot-time retries and the exit-path flush only). */
function sleepSync(ms: number) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* not available: retry immediately */
  }
}

const RETRYABLE_FS = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE'])

/** Per-key sliding-window counter (count() never consumes). */
class WindowCounter {
  private readonly hits = new Map<string, number[]>()
  private readonly windowMs: number
  constructor(windowMs: number) {
    this.windowMs = windowMs
  }
  count(key: string, now = Date.now()): number {
    const ts = this.hits.get(key)
    if (!ts) return 0
    const cut = now - this.windowMs
    let i = 0
    while (i < ts.length && ts[i] <= cut) i++
    if (i) ts.splice(0, i)
    if (!ts.length) {
      this.hits.delete(key)
      return 0
    }
    return ts.length
  }
  /** ms until count(key) drops by one (0 when nothing is recorded). */
  retryIn(key: string, now = Date.now()): number {
    const ts = this.hits.get(key)
    return ts && ts.length ? Math.max(0, ts[0] + this.windowMs - now) : 0
  }
  add(key: string, now = Date.now()) {
    const ts = this.hits.get(key)
    if (ts) ts.push(now)
    else this.hits.set(key, [now])
  }
  sweep(now = Date.now()) {
    const cut = now - this.windowMs
    for (const [k, ts] of this.hits) if (!ts.length || ts[ts.length - 1] <= cut) this.hits.delete(k)
  }
}

/** Token bucket: `level()` refills, `take()` may drive the level negative (debt). */
function tokenBucket(perSec: number, burst: number) {
  let level = burst
  let at = Date.now()
  const refill = () => {
    const now = Date.now()
    level = Math.min(burst, level + ((now - at) / 1000) * perSec)
    at = now
  }
  return {
    level() {
      refill()
      return level
    },
    take(n: number) {
      refill()
      level -= n
    },
  }
}

// ─── ledger ─────────────────────────────────────────────────────────────────

export interface LedgerAccount {
  key: string
  kind: 'wallet' | 'device' | 'label'
  wallet: string | null
  label: string
  ink: number
  flops: number            // verified FLOPs contributed
  jobs: number
  verified: number
  failed: number
  firstSeen: number
  lastSeen: number
  /** Wallet accounts: ownership proven by a signed sign-in message (only these receive payouts). */
  walletVerified?: boolean
  /** INK since the last closed payout period (wallets: plus INK carried over from it). */
  periodInk?: number
  /** Device accounts: wallet this device's period INK moved to, and the period (last close time) of that move. */
  linkedTo?: string
  linkedPeriod?: number
  /** Device accounts: salted hash of the network (IPv4 /24, IPv6 /64) that last earned INK on it. */
  earnNet?: string
  /** balance() only: gradient-job INK of this account still in escrow (not in `ink` / `periodInk`). */
  pendingInk?: number
}

/** Escrowed gradient-job INK of one ledger account, inside an identity's escrow record. */
export interface EscrowItem {
  kind: LedgerAccount['kind']
  wallet: string | null
  label: string
  ink: number
  flops: number
  jobs: number
  /** Ledger account key (items are keyed per job: "<account>|<seq>"; legacy items are keyed by account). */
  acct?: string
  /** Submit sequence number of the (newest) job in this item: a passed audit releases only items up to its own. */
  seq?: number
}

/** Per strike identity (device / wallet / ip): gradient jobs submitted and INK awaiting a full audit. */
export interface EscrowRecord {
  trainJobs: number
  items: Record<string, EscrowItem>
  lastAt: number
  /** Submit sequence counter (gradient results received from this identity). */
  seq?: number
}

/** Last payout period whose reset is applied to this ledger. */
export interface PayoutLedgerState {
  lastClosedId: string | null
  lastClosedEndsAt: number | null
}

export interface LedgerTotals {
  jobsDone: number         // jobs that reached a verdict (verified + failed, incl. timeouts)
  jobsVerified: number
  jobsFailed: number
  inkIssued: number        // confirmed INK only (escrow excluded)
  inkPending: number       // gradient-job INK held in escrow until the identity's next passed full audit
  inkForfeited: number     // escrow INK cancelled by failed audits
  flopsVerified: number
  dupsFound: number        // semantic near-duplicates reported to the crawler
}

export interface LeaderRow {
  rank: number
  key: string
  name: string
  wallet: string | null
  ink: number
  verified: number
  flops: number
  lastSeen: number
}

export interface LedgerSnapshot {
  updatedAt: number
  totals: LedgerTotals
  leaderboard: LeaderRow[]
}

interface LedgerFile extends LedgerSnapshot {
  version: 1
  accounts: Record<string, LedgerAccount>
  payouts?: PayoutLedgerState
  escrow?: Record<string, EscrowRecord>
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

function emptyTotals(): LedgerTotals {
  return { jobsDone: 0, jobsVerified: 0, jobsFailed: 0, inkIssued: 0, inkPending: 0, inkForfeited: 0, flopsVerified: 0, dupsFound: 0 }
}

function displayName(a: LedgerAccount): string {
  if (a.wallet) return `${a.wallet.slice(0, 4)}…${a.wallet.slice(-4)}`
  return a.label
}

interface ParsedLedger {
  totals: LedgerTotals
  accounts: Map<string, LedgerAccount>
  payouts: PayoutLedgerState
  escrow: Map<string, EscrowRecord>
}

function parseEscrow(raw: unknown): Map<string, EscrowRecord> {
  const out = new Map<string, EscrowRecord>()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, r] of Object.entries(raw as Record<string, Partial<EscrowRecord>>)) {
    if (!r || typeof r !== 'object') continue
    const items: Record<string, EscrowItem> = {}
    const src = r.items && typeof r.items === 'object' ? r.items : {}
    for (const [acct, it] of Object.entries(src as Record<string, Partial<EscrowItem>>)) {
      if (!it || typeof it !== 'object' || !(num(it.ink) > 0)) continue
      const kind = it.kind === 'wallet' || it.kind === 'device' ? it.kind : 'label'
      const account = typeof it.acct === 'string' && it.acct ? it.acct : acct
      items[acct] = { kind, wallet: typeof it.wallet === 'string' ? it.wallet : null, label: typeof it.label === 'string' ? it.label : account, ink: num(it.ink), flops: num(it.flops), jobs: num(it.jobs), acct: account, seq: Math.max(0, Math.floor(num(it.seq))) }
    }
    out.set(key, { trainJobs: Math.max(0, Math.floor(num(r.trainJobs))), items, lastAt: num(r.lastAt, Date.now()), seq: Math.max(0, Math.floor(num(r.seq))) })
  }
  return out
}

function escrowTotal(rec: EscrowRecord | undefined): number {
  let t = 0
  if (rec) for (const it of Object.values(rec.items)) t += it.ink
  return t
}

/** Parse ledger.json content. Throws on anything that is not a ledger object. */
function parseLedger(raw: string): ParsedLedger {
  const f = JSON.parse(raw) as Partial<LedgerFile> | null
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('not a ledger object')
  const ps = (f.payouts && typeof f.payouts === 'object' ? f.payouts : {}) as Partial<PayoutLedgerState>
  const payouts: PayoutLedgerState = {
    lastClosedId: typeof ps.lastClosedId === 'string' ? ps.lastClosedId : null,
    lastClosedEndsAt: typeof ps.lastClosedEndsAt === 'number' && Number.isFinite(ps.lastClosedEndsAt) ? ps.lastClosedEndsAt : null,
  }
  const t = (f.totals ?? {}) as Partial<LedgerTotals>
  const totals: LedgerTotals = {
    jobsDone: num(t.jobsDone),
    jobsVerified: num(t.jobsVerified),
    jobsFailed: num(t.jobsFailed),
    inkIssued: num(t.inkIssued),
    inkPending: 0, // recomputed from the escrow below
    inkForfeited: num(t.inkForfeited),
    flopsVerified: num(t.flopsVerified),
    dupsFound: num(t.dupsFound),
  }
  const accs = f.accounts && typeof f.accounts === 'object' ? f.accounts : {}
  const accounts = new Map<string, LedgerAccount>()
  for (const [rawKey, a] of Object.entries(accs)) {
    if (!a || typeof a !== 'object') continue
    const kind = a.kind === 'wallet' || a.kind === 'device' ? a.kind : 'label'
    let key = rawKey
    let wallet = typeof a.wallet === 'string' ? a.wallet : null
    // EVM addresses are case-insensitive: fold checksum-cased accounts from older ledgers into one.
    if (kind === 'wallet' && wallet && EVM_ADDR_RE.test(wallet) && rawKey === `wallet:${wallet}`) {
      wallet = wallet.toLowerCase()
      key = `wallet:${wallet}`
    }
    const acc: LedgerAccount = {
      key,
      kind,
      wallet,
      label: typeof a.label === 'string' ? a.label : key,
      ink: num(a.ink),
      flops: num(a.flops),
      jobs: num(a.jobs),
      verified: num(a.verified),
      failed: num(a.failed),
      firstSeen: num(a.firstSeen, Date.now()),
      lastSeen: num(a.lastSeen, Date.now()),
    }
    if (kind === 'wallet' && a.walletVerified === true) acc.walletVerified = true
    const periodInk = num(a.periodInk)
    if (periodInk > 0) acc.periodInk = periodInk
    if (kind === 'device' && typeof a.linkedTo === 'string' && typeof a.linkedPeriod === 'number') {
      acc.linkedTo = a.linkedTo
      acc.linkedPeriod = a.linkedPeriod
    }
    const prev = accounts.get(key)
    if (prev) {
      prev.ink += acc.ink
      prev.flops += acc.flops
      prev.jobs += acc.jobs
      prev.verified += acc.verified
      prev.failed += acc.failed
      prev.firstSeen = Math.min(prev.firstSeen, acc.firstSeen)
      prev.lastSeen = Math.max(prev.lastSeen, acc.lastSeen)
      if (acc.periodInk) prev.periodInk = (prev.periodInk ?? 0) + acc.periodInk
      if (acc.walletVerified === true) prev.walletVerified = true
    } else accounts.set(key, acc)
  }
  const escrow = parseEscrow(f.escrow)
  for (const rec of escrow.values()) totals.inkPending += escrowTotal(rec)
  return { totals, accounts, payouts, escrow }
}

// ─── coordinator ────────────────────────────────────────────────────────────

export interface CoordinatorExtraOptions {
  /** Directory for ledger.json (defaults to $LUSCA_DATA or ./server/data). */
  dataDir?: string
  /** Log sink (defaults to console). */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
  /** Overrides for the env-derived limits (tests, embedding). */
  limits?: Partial<CoordinatorLimits>
  /** Session-token check (server/auth). Without it no register is verified and no INK reaches a wallet. */
  auth?: { checkToken(token: unknown): { wallet: string; exp: number } | null }
  /** Override REJOIN_GRACE_MS (tests). */
  rejoinGraceMs?: number
}

/** CoordinatorApi plus lifecycle and ledger accessors used by server/index.ts and http.ts. */
export interface LuscaCoordinator extends CoordinatorApi {
  /** Stop timers and persist the ledger. */
  stop(): Promise<void>
  /** Synchronous ledger flush (for last-chance saves on process exit). */
  flushSync(): void
  /** Lifetime totals + leaderboard. */
  ledger(): LedgerSnapshot
  /** Lifetime account for a wallet address (or full ledger key), if any. `key` is the public (device-hashed) key. */
  balance(walletOrKey: string): LedgerAccount | null
  /** The limits this instance runs with. */
  limits(): CoordinatorLimits
  /**
   * POST /api/auth/link-device: the wallet of a valid session token takes over the device's
   * current-period credits, the same move as a verified register from that device. Returns the
   * credits moved, or null when the token or the device id is not valid.
   */
  linkDevice(token: unknown, deviceId: unknown, ip: string): { wallet: string; ink: number } | null
  /** Period INK of verified wallets, for the payout engine. */
  payouts: PayoutLedger
}

interface PendingJob {
  id: string
  rows: number
  cols: number
  dim: number
  a: Float32Array
  b: Float32Array
  /** Real page ids, server-side only (the wire carries positional placeholders). */
  rowIds: string[]
  colIds: string[]
  /** Corpus column index the rows' coverage advances to on a verified result. */
  colEnd: number
  flops: number
  /** INK bonus zone index, frozen at issue time. */
  zoneIdx: number
  /** Job-size zone index (for the big-job budget). */
  sizeIdx: number
  bytes: number
  issuedAt: number
  /** Wall clock right before the job was handed to the socket (server-side throughput). */
  sentAt: number
  timer: NodeJS.Timeout
}

type BuiltJob = Omit<PendingJob, 'timer' | 'sentAt'> & { b64b: string }

interface Peer {
  conn: NeuronConn
  info: NeuronInfo
  ip: string
  /** Ledger account key (wallet → device → label). */
  account: string
  accountKind: LedgerAccount['kind']
  accountSetAt: number
  /** Strike / measurement identity (device → wallet → ip). */
  strikeKey: string
  claimed: number
  claimedIdx: number
  /** Job-size ramp: starts at EPI, ±1 zone per verdict. */
  rampIdx: number
  pending: PendingJob | null
  wants: boolean            // a job.request is waiting to be served
  requestedAt: number
  timer: NodeJS.Timeout | null   // deferred pump (gap / warm-up / idle / budget)
  lastIssueAt: number
  warned: boolean           // the current request was already told it is queued
  warnedAccount: boolean
  /** CPU-backend neuron (adapter.backend 'cpu' or 'cpu-js'): CPU_TRAIN_BATCH gradient jobs. */
  cpu: boolean
  /** Last job.request advertised caps.train. */
  trainCap: boolean
  /** Last job.request said gradients run on the CPU path (caps.cpu, e.g. a browser whose GPU self-test failed). */
  trainCpu: boolean
  /** Weights version the neuron says it holds (caps.version). */
  trainVersion: number | null
  /** Outstanding gradient job (mutually exclusive with `pending`). */
  pendingTrain: PendingTrain | null
  /** An issueTrainJob call is in flight. */
  issuing: boolean
  /** The trainer had no job: serve dedupe jobs until then. */
  trainNullUntil: number
}

interface PendingTrain {
  id: string
  kind: 'train'
  version: number
  batch: number
  flops: number
  zoneIdx: number
  sizeIdx: number
  issuedAt: number
  sentAt: number
  timer: NodeJS.Timeout
}

/** Who submitted a gradient (captured at submit time: a re-register must not redirect escrow). */
interface Submitter {
  strikeKey: string
  account: string
  accountKind: LedgerAccount['kind']
  wallet: string | null
  label: string
  ip: string
}

/** Strike + throughput record of one identity (device / wallet / ip) or one remote IP. */
interface Ident {
  fails: number             // consecutive failures
  kicks: number             // cooldowns served (exponential backoff)
  until: number             // cooldown end
  lastAt: number
  ewma: number              // measured end-to-end GFLOPS (all jobs; drives job sizing)
  measured: number          // verified jobs measured
  bigEwma: number           // measured end-to-end GFLOPS on large jobs only (GPU-speed proof)
  bigMeasured: number       // large jobs measured
}

interface RowState {
  /** The page's corpus index when first seen: it is compared against columns [0, limit). */
  limit: number
  /** Next column index still to compare against. */
  next: number
  /** Job holding this row, if any. */
  lease: string | null
}

/** Jobs a socket closed on, scored as abandoned when `timer` fires unless the identity registers again. */
interface Abandoned {
  peer: Peer
  jobs: { id: string; kind?: 'train' }[]
  timer: NodeJS.Timeout
}

/** One connection following its own ledger account (account.watch). */
interface AccountWatch {
  conn: NeuronConn
  scope: 'wallet' | 'device' | null
  /** Ledger key watched (null scope: none). */
  key: string | null
  /** Wallet scope: the device account the watch also named, followed too (what stays on that device). */
  devKey: string | null
  lastSentAt: number
  /** Trailing push, due at lastSentAt + ACCOUNT_PUSH_MIN_MS (reads the account when it fires). */
  timer: NodeJS.Timeout | null
  /** account.watch token bucket. */
  tokens: number
  tokensAt: number
  /** Newest request held by the bucket, applied by `queueTimer`. */
  queued: { device: string | null; auth: unknown } | null
  queueTimer: NodeJS.Timeout | null
}

export function createCoordinator(opts: CoordinatorOptions & CoordinatorExtraOptions): LuscaCoordinator {
  const { crawler, emit } = opts
  const dataDir = path.resolve(opts.dataDir ?? process.env.LUSCA_DATA ?? path.join('server', 'data'))
  const ledgerPath = path.join(dataDir, 'ledger.json')
  const ledgerBak = `${ledgerPath}.bak`
  const logFn = opts.log ?? ((level, msg) => (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[neurons] ${msg}`))

  const limits = resolveLimits(process.env, opts.limits, (msg) => log('warn', msg))

  const peers = new Map<string, Peer>()
  const idents = new Map<string, Ident>()       // 'device:…' | 'wallet:…' | 'ip:…' → strikes + measured throughput
  const ipStrikes = new Map<string, Ident>()    // remote ip → strikes across identities
  const registers = new WindowCounter(REGISTER_WINDOW_MS)
  const newAccounts = new WindowCounter(NEW_ACCOUNT_WINDOW_MS) // keyed by accountNetKey (IPv4 / IPv6 /56)
  const markedRows = new Set<string>()          // page ids already reported as semantic dups
  const rowStates = new Map<string, RowState>() // coverage of the newest ROW_POOL pages
  const colCache: { key: string; b: Float32Array; ids: string[]; b64: string }[] = []
  // Debt bucket: a job is issued whenever the level is positive and charged in full, so large
  // jobs are never starved by a stream of small ones; the long-run rate stays at the budget.
  const issueBytes = tokenBucket(limits.issueBytesPerSec, Math.max(2 * limits.issueBytesPerSec, 256 * 1024))
  const verifyBudget = tokenBucket(limits.verifyMsPerSec, Math.max(250, 5 * limits.verifyMsPerSec))
  const BIG_IDX = zoneIndex('ABYSSO')
  const hashSalt = loadHashSalt(dataDir, process.env.LUSCA_HASH_SALT, log)
  const issuance = createIssuanceLog(dataDir, limits.issuanceLogBytes, limits.issuanceLogKeep, log)
  const hid = (scope: string, value: string) => hashId(hashSalt, scope, value)
  const publicKeys = new Map<string, string>()  // ledger key → published key (device ids hashed)
  let lastEvictAt = 0
  let pendingBytes = 0
  let bigJobs = 0
  let seq = 0
  let stopped = false

  // ── ledger state ──
  let totals = emptyTotals()
  let accounts = new Map<string, LedgerAccount>()
  let payoutState: PayoutLedgerState = { lastClosedId: null, lastClosedEndsAt: null }
  let escrow = new Map<string, EscrowRecord>() // strike identity -> gradient jobs + escrowed INK
  // ledger account key -> strike identities whose escrow record may hold items for it (a superset:
  // every insert is indexed, removals are dropped eagerly on confirm / forfeit and lazily on read)
  const escrowIdx = new Map<string, Set<string>>()
  const rejoinGraceMs = typeof opts.rejoinGraceMs === 'number' && opts.rejoinGraceMs >= 0 ? opts.rejoinGraceMs : REJOIN_GRACE_MS
  /** Jobs left outstanding by closed sockets, per strike identity, until their grace runs out. */
  const abandoned = new Map<string, Set<Abandoned>>()
  let abandonedCount = 0
  // account watches: connection id -> watch, ledger key -> watches, keys touched since the last push
  const watches = new Map<string, AccountWatch>()
  const watchedKeys = new Map<string, Set<AccountWatch>>()
  const dirtyKeys = new Set<string>()
  let watchFlushTimer: NodeJS.Timeout | null = null
  let ledgerDirty = false
  let loadFailed = false // ledger.json exists but could not be loaded: never overwrite it
  let saving: Promise<void> | null = null
  let saveTimer: NodeJS.Timeout | null = null
  loadLedger()

  function log(level: 'info' | 'warn' | 'error', msg: string) {
    try {
      logFn(level, msg)
    } catch {
      /* logging must never throw */
    }
  }

  function safeEmit(msg: ServerMsg) {
    try {
      emit(msg)
    } catch (e) {
      log('error', `emit(${msg.t}) failed: ${(e as Error)?.message ?? e}`)
    }
  }

  function safeSend(conn: NeuronConn, msg: ServerMsg) {
    try {
      conn.send(msg)
    } catch (e) {
      log('warn', `send(${msg.t}) to ${conn.id} failed: ${(e as Error)?.message ?? e}`)
    }
  }

  // ── ledger persistence ──

  /** Read a file, retrying transient lock errors (antivirus / backup on Windows). */
  function readWithRetry(file: string): { ok: true; raw: string } | { ok: false; code: string; msg: string } {
    let last: unknown = null
    for (let i = 0; i < 6; i++) {
      try {
        return { ok: true, raw: fs.readFileSync(file, 'utf8') }
      } catch (e) {
        last = e
        if (!RETRYABLE_FS.has(errCode(e))) break
        sleepSync(100 * 2 ** i)
      }
    }
    return { ok: false, code: errCode(last) || 'EUNKNOWN', msg: (last as Error)?.message ?? String(last) }
  }

  function applyLedger(l: ParsedLedger, from: string) {
    totals = l.totals
    accounts = l.accounts
    payoutState = l.payouts
    escrow = l.escrow
    escrowIdx.clear()
    for (const [sk, rec] of escrow) for (const [k, it] of Object.entries(rec.items)) indexEscrow(it.acct ?? k, sk)
    log('info', `ledger loaded${from === ledgerPath ? '' : ` from ${path.basename(from)}`}: ${accounts.size} accounts, ${round2(totals.inkIssued)} INK issued lifetime`)
  }

  /** Recovery candidates after a corrupt ledger.json: the .bak, then leftover tmp files (newest first). */
  function fallbackFiles(): string[] {
    const out = [ledgerBak]
    try {
      const base = path.basename(ledgerPath)
      const tmps = fs
        .readdirSync(dataDir)
        .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.tmp'))
        .map((f) => path.join(dataDir, f))
        .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
        .sort((x, y) => y.t - x.t)
        .map((x) => x.f)
      out.push(...tmps)
    } catch {
      /* no directory listing: .bak only */
    }
    return out
  }

  function loadLedger() {
    const reset = process.env.LUSCA_LEDGER_RESET === '1'
    const read = readWithRetry(ledgerPath)
    if (!read.ok) {
      if (read.code === 'ENOENT') return // first run
      if (reset) {
        log('warn', `ledger.json unreadable (${read.code}); LUSCA_LEDGER_RESET=1 → starting a fresh ledger`)
        return
      }
      loadFailed = true
      log('error', `ledger.json exists but cannot be read (${read.code}: ${read.msg}). Running WITHOUT ledger saves so it is never overwritten — fix the file or restart with LUSCA_LEDGER_RESET=1.`)
      return
    }
    try {
      applyLedger(parseLedger(read.raw), ledgerPath)
      return
    } catch (e) {
      // Keep the unreadable file for forensics, then try the backups.
      const aside = `${ledgerPath}.corrupt-${Date.now()}`
      try {
        fs.renameSync(ledgerPath, aside)
      } catch {
        /* keep it where it is */
      }
      log('error', `ledger.json unreadable (${(e as Error).message}); moved to ${path.basename(aside)}`)
    }
    for (const f of fallbackFiles()) {
      const r = readWithRetry(f)
      if (!r.ok) continue
      try {
        applyLedger(parseLedger(r.raw), f)
        ledgerDirty = true // rewrite ledger.json from the recovered copy
        return
      } catch {
        /* next candidate */
      }
    }
    if (reset) {
      log('warn', 'no usable ledger backup; LUSCA_LEDGER_RESET=1 → starting a fresh ledger')
      return
    }
    loadFailed = true
    log('error', 'no usable ledger backup found. Running WITHOUT ledger saves — restore ledger.json or restart with LUSCA_LEDGER_RESET=1.')
  }

  /** Ledger key as published (leaderboard, balance lookups): device ids are replaced by a salted hash. */
  function publicKey(key: string): string {
    if (!key.startsWith('device:')) return key // wallets and labels are public already
    let pub = publicKeys.get(key)
    if (!pub) {
      if (publicKeys.size >= 10_000) publicKeys.clear()
      pub = `device:${hid('pub', key)}`
      publicKeys.set(key, pub)
    }
    return pub
  }

  function leaderboard(): LeaderRow[] {
    return [...accounts.values()]
      .filter((a) => a.ink > 0)
      .sort((x, y) => y.ink - x.ink || y.verified - x.verified)
      .slice(0, LEADERBOARD_SIZE)
      .map((a, i) => ({
        rank: i + 1,
        key: publicKey(a.key),
        name: displayName(a),
        wallet: a.wallet,
        ink: round2(a.ink),
        verified: a.verified,
        flops: a.flops,
        lastSeen: a.lastSeen,
      }))
  }

  /**
   * Once the ledger is EVICT_AT full, drop accounts holding < EVICT_MAX_INK that have been idle
   * for limits.accountIdleMs and are not connected, oldest first, down to EVICT_TO of the cap.
   * Throttled to one scan per EVICT_EVERY_MS. Each eviction is recorded in the issuance log.
   */
  function evictIdle(now: number): number {
    if (accounts.size < Math.floor(limits.maxAccounts * EVICT_AT)) return 0
    if (now - lastEvictAt < EVICT_EVERY_MS) return 0
    lastEvictAt = now
    const live = new Set([...peers.values()].map((p) => p.account))
    const cutoff = now - limits.accountIdleMs
    const victims: LedgerAccount[] = []
    // Verified wallets and accounts holding unpaid period INK are never evicted.
    for (const a of accounts.values()) {
      if (a.ink < EVICT_MAX_INK && a.lastSeen <= cutoff && !live.has(a.key) && !a.walletVerified && !((a.periodInk ?? 0) > 0)) victims.push(a)
    }
    if (!victims.length) return 0
    victims.sort((x, y) => x.lastSeen - y.lastSeen || x.ink - y.ink)
    const n = Math.min(victims.length, accounts.size - Math.floor(limits.maxAccounts * EVICT_TO))
    let ink = 0
    for (let i = 0; i < n; i++) {
      const v = victims[i]
      accounts.delete(v.key)
      touch(v.key)
      ink += v.ink
      issuance.write({ ts: now, ev: 'evict', acct: hid('acct', v.key), kind: v.kind, ink: round2(v.ink), lastSeen: v.lastSeen })
    }
    if (n > 0) {
      markDirty()
      log('info', `evicted ${n} idle ledger accounts (< ${EVICT_MAX_INK} INK, ${round2(ink)} INK total); ${accounts.size}/${limits.maxAccounts} accounts`)
    }
    return n
  }

  function serializeLedger(): string {
    const file: LedgerFile = {
      version: 1,
      updatedAt: Date.now(),
      totals: { ...totals, inkIssued: round2(totals.inkIssued), inkPending: round2(totals.inkPending), inkForfeited: round2(totals.inkForfeited) },
      leaderboard: leaderboard(),
      accounts: Object.fromEntries(
        [...accounts].map(([k, a]) => {
          const out: LedgerAccount = { ...a, ink: round2(a.ink) }
          if (a.periodInk && a.periodInk > 0) out.periodInk = round6(a.periodInk)
          else delete out.periodInk
          return [k, out]
        }),
      ),
      payouts: { ...payoutState },
      escrow: Object.fromEntries(
        [...escrow].map(([k, r]) => [k, { trainJobs: r.trainJobs, lastAt: r.lastAt, seq: r.seq ?? 0, items: Object.fromEntries(Object.entries(r.items).map(([a, it]) => [a, { ...it, ink: round6(it.ink) }])) }]),
      ),
    }
    return JSON.stringify(file, null, 1)
  }

  function fsyncDirSync() {
    try {
      const fd = fs.openSync(dataDir, 'r')
      try {
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      /* not supported (Windows) */
    }
  }

  /** tmp (fsync'd) → copy current to .bak → rename over ledger.json (retrying locks). Never writes ledger.json in place. */
  async function writeLedgerAsync(data: string): Promise<void> {
    await fs.promises.mkdir(dataDir, { recursive: true })
    const tmp = `${ledgerPath}.${process.pid}.tmp`
    const fh = await fs.promises.open(tmp, 'w')
    try {
      await fh.writeFile(data, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    try {
      await fs.promises.copyFile(ledgerPath, ledgerBak)
    } catch (e) {
      if (errCode(e) !== 'ENOENT') log('warn', `ledger backup failed: ${(e as Error).message}`)
    }
    for (let i = 0; ; i++) {
      try {
        await fs.promises.rename(tmp, ledgerPath)
        break
      } catch (e) {
        if (i >= 8 || !RETRYABLE_FS.has(errCode(e))) {
          await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
          throw e
        }
        await new Promise((r) => setTimeout(r, 100 * (i + 1)))
      }
    }
    fsyncDirSync()
  }

  function writeLedgerSync(data: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${ledgerPath}.${process.pid}.sync.tmp`
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, data, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.copyFileSync(ledgerPath, ledgerBak)
    } catch {
      /* first save */
    }
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, ledgerPath)
        break
      } catch (e) {
        if (i >= 5 || !RETRYABLE_FS.has(errCode(e))) {
          try {
            fs.rmSync(tmp, { force: true })
          } catch {
            /* ignore */
          }
          throw e
        }
        sleepSync(50 * (i + 1))
      }
    }
    fsyncDirSync()
  }

  function markDirty() {
    ledgerDirty = true
    if (saveTimer || stopped || loadFailed) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveLedger()
    }, LEDGER_DEBOUNCE_MS)
    saveTimer.unref?.()
  }

  async function saveLedger(force = false): Promise<void> {
    if (loadFailed) return
    if (!ledgerDirty && !force) return
    if (saving) return saving
    ledgerDirty = false
    const data = serializeLedger()
    saving = (async () => {
      try {
        await writeLedgerAsync(data)
      } catch (e) {
        ledgerDirty = true // retry on the next tick
        log('error', `ledger save failed: ${(e as Error).message}`)
      } finally {
        saving = null
        if (ledgerDirty && !stopped) markDirty()
      }
    })()
    return saving
  }

  function flushSync() {
    issuance.flushSync()
    if (!ledgerDirty || loadFailed) return
    try {
      writeLedgerSync(serializeLedger())
      ledgerDirty = false
    } catch (e) {
      log('error', `ledger flush failed: ${(e as Error).message}`)
    }
  }

  function canCreateAccount(ip: string, now = Date.now()): boolean {
    if (newAccounts.count(accountNetKey(ip), now) >= limits.newAccountsPerHour) return false
    if (accounts.size >= limits.maxAccounts) evictIdle(now)
    return accounts.size < limits.maxAccounts
  }

  /**
   * Ledger accounts are created only by a VERIFIED job worth ≥ MIN_ACCOUNT_INK (never at
   * register or issue), within the per-network new-account rate and the ledger cap.
   */
  function accountForPeer(peer: Peer, earned: number): LedgerAccount | null {
    let a = accounts.get(peer.account)
    if (!a && earned >= MIN_ACCOUNT_INK) {
      const now = Date.now()
      if (!canCreateAccount(peer.ip, now)) return null
      a = { key: peer.account, kind: peer.accountKind, wallet: peer.info.wallet, label: peer.info.label, ink: 0, flops: 0, jobs: 0, verified: 0, failed: 0, firstSeen: now, lastSeen: now }
      // A wallet account is only ever reached through a verified register (see register()).
      if (peer.accountKind === 'wallet') a.walletVerified = true
      accounts.set(peer.account, a)
      newAccounts.add(accountNetKey(peer.ip), now)
    }
    return a ?? null
  }

  // ── payout periods (PayoutLedger) ──

  /** Period INK of every verified wallet holding some, largest first. */
  function periodSnapshot(): PeriodSnapshotRow[] {
    const out: PeriodSnapshotRow[] = []
    for (const a of accounts.values()) {
      const ink = a.periodInk ?? 0
      if (a.kind === 'wallet' && a.walletVerified && a.wallet && ink > 0) out.push({ wallet: a.wallet, ink: round6(ink) })
    }
    return out.sort((x, y) => y.ink - x.ink || (x.wallet < y.wallet ? -1 : 1))
  }

  /** Synchronous save right now (payout period boundaries); a failure leaves the ledger dirty for the next save. */
  function saveNowSync(why: string): boolean {
    if (loadFailed) return false
    try {
      writeLedgerSync(serializeLedger())
      // An async save that serialized earlier may still land after this one: write again then.
      if (saving) markDirty()
      else ledgerDirty = false
      return true
    } catch (e) {
      log('error', `ledger save (${why}) failed: ${(e as Error).message}`)
      markDirty()
      return false
    }
  }

  /** Reset every account's period INK and add the carry-over back (wallet → INK). */
  function applyClose(periodId: string, endsAt: number, carry: Record<string, number>, subtract: PeriodSnapshotRow[] | null) {
    const sub = new Map((subtract ?? []).map((r) => [r.wallet, r.ink]))
    for (const a of accounts.values()) {
      if (!a.periodInk) continue
      touch(a.key)
      if (subtract && a.kind === 'wallet' && a.wallet && sub.has(a.wallet)) {
        // Recovery: only the INK of the persisted plan is consumed; anything newer stays.
        const left = Math.max(0, a.periodInk - (sub.get(a.wallet) ?? 0))
        a.periodInk = left > 1e-9 ? round6(left) : 0
      } else if (!subtract || a.kind !== 'wallet') a.periodInk = 0
      if (!a.periodInk) delete a.periodInk
    }
    for (const [wallet, ink] of Object.entries(carry)) {
      if (!(ink > 0)) continue
      const a = accounts.get(`wallet:${wallet}`)
      if (a) {
        a.periodInk = round6((a.periodInk ?? 0) + ink)
        touch(a.key)
      }
    }
    payoutState = { lastClosedId: periodId, lastClosedEndsAt: endsAt }
    ledgerDirty = true
  }

  const payoutLedger: PayoutLedger = {
    periodSnapshot,
    closePeriod(periodId, endsAt, plan) {
      if (loadFailed) throw new Error('the INK ledger is not being saved (unreadable ledger.json); refusing to close a payout period')
      const snap = periodSnapshot()
      const carry = plan(snap) // persists the period plan; throws → nothing changes
      applyClose(periodId, endsAt, carry, null)
      saveNowSync(`close ${periodId}`)
      return snap
    },
    reconcileClose(periodId, endsAt, snapshot, carry) {
      if ((payoutState.lastClosedEndsAt ?? -Infinity) >= endsAt) return false
      applyClose(periodId, endsAt, carry, snapshot)
      log('warn', `payout period ${periodId}: the ledger reset was not saved before a restart; re-applied from the period file`)
      saveNowSync(`reconcile ${periodId}`)
      return true
    },
    carryBack(wallet, ink) {
      if (!(ink > 0)) return
      let a = accounts.get(`wallet:${wallet}`)
      if (!a) {
        const now = Date.now()
        a = { key: `wallet:${wallet}`, kind: 'wallet', wallet, label: `${wallet.slice(0, 4)}…${wallet.slice(-4)}`, ink: 0, flops: 0, jobs: 0, verified: 0, failed: 0, firstSeen: now, lastSeen: now, walletVerified: true }
        accounts.set(a.key, a)
      }
      a.periodInk = round6((a.periodInk ?? 0) + ink)
      ledgerDirty = true
      touch(a.key)
      saveNowSync(`carry ${wallet.slice(0, 4)}…`)
    },
    lastClosed() {
      return payoutState.lastClosedId !== null && payoutState.lastClosedEndsAt !== null ? { id: payoutState.lastClosedId, endsAt: payoutState.lastClosedEndsAt } : null
    },
    lifetimeInk(wallet) {
      return round2(accounts.get(`wallet:${wallet}`)?.ink ?? 0)
    },
    periodInk(wallet) {
      const a = accounts.get(`wallet:${wallet}`)
      return a?.walletVerified ? round6(a.periodInk ?? 0) : 0
    },
    isVerified(wallet) {
      return accounts.get(`wallet:${wallet}`)?.walletVerified === true
    },
  }

  /**
   * First verified register of a device in the current period: move the INK that device account
   * earned this period to the wallet. Once a device is linked to a wallet in a period, it cannot
   * be moved to a different wallet until the next period. Returns the INK moved.
   */
  function linkDevice(device: string, wallet: string, ip: string, now: number): number {
    const dev = accounts.get(`device:${device}`)
    if (!dev) return 0
    // Device ids are client-supplied, so holding one is no proof of owning it: device INK only moves
    // to a wallet registering from the network that earned it. A claim from elsewhere neither moves
    // INK nor locks the device to that wallet.
    if ((dev.periodInk ?? 0) > 0 && dev.earnNet !== hid('net', accountNetKey(ip))) return 0
    const marker = payoutState.lastClosedEndsAt ?? 0
    if (dev.linkedPeriod === marker && dev.linkedTo && dev.linkedTo !== wallet) return 0
    dev.linkedTo = wallet
    dev.linkedPeriod = marker
    markDirty()
    const amount = round6(dev.periodInk ?? 0)
    if (!(amount > 0)) return 0
    const wkey = `wallet:${wallet}`
    let w = accounts.get(wkey)
    if (!w) {
      if (!canCreateAccount(ip, now)) return 0
      w = { key: wkey, kind: 'wallet', wallet, label: dev.label, ink: 0, flops: 0, jobs: 0, verified: 0, failed: 0, firstSeen: now, lastSeen: now, walletVerified: true }
      accounts.set(wkey, w)
      newAccounts.add(accountNetKey(ip), now)
    }
    w.walletVerified = true
    dev.ink = round2(Math.max(0, dev.ink - amount))
    delete dev.periodInk
    w.ink += amount
    w.periodInk = round6((w.periodInk ?? 0) + amount)
    w.lastSeen = now
    touch(dev.key)
    touch(wkey)
    issuance.write({ ts: now, ev: 'link', from: hid('acct', dev.key), acct: hid('acct', wkey), ink: amount })
    return amount
  }

  // ── identities: strikes, cooldowns, measured throughput ──

  function identOf(map: Map<string, Ident>, key: string): Ident {
    let id = map.get(key)
    if (!id) {
      id = { fails: 0, kicks: 0, until: 0, lastAt: Date.now(), ewma: 0, measured: 0, bigEwma: 0, bigMeasured: 0 }
      map.set(key, id)
    }
    return id
  }

  function cooldownFor(kicks: number): number {
    return Math.min(MAX_KICK_COOLDOWN_MS, KICK_COOLDOWN_MS * 2 ** Math.max(0, kicks - 1))
  }

  /**
   * Keys a cooldown is recorded under besides the strike identity: the socket (so a
   * re-register with another identity on the same connection is refused) and the
   * wallet / device ledger account (so rotating the device id keeps the wallet cooling).
   * Label accounts are shared by everyone with the same GPU label, so they are left out.
   */
  function cooldownKeys(strikeKey: string, connId: string, account: string): string[] {
    const keys = new Set([strikeKey, `conn:${connId}`])
    if (account.startsWith('wallet:') || account.startsWith('device:')) keys.add(account)
    return [...keys]
  }

  function coolingUntil(strikeKey: string, ip: string, connId = '', account = ''): number {
    let until = ipStrikes.get(ip)?.until ?? 0
    for (const k of cooldownKeys(strikeKey, connId, account)) until = Math.max(until, idents.get(k)?.until ?? 0)
    return until
  }

  function sweepIdents(now: number) {
    const liveKeys = new Set<string>()
    const liveIps = new Set<string>()
    for (const p of peers.values()) {
      liveKeys.add(p.strikeKey)
      liveIps.add(p.ip)
    }
    const sweep = (map: Map<string, Ident>, live: Set<string>) => {
      for (const [k, id] of map) if (!live.has(k) && id.until <= now && now - id.lastAt > IDENT_TTL_MS) map.delete(k)
      if (map.size > MAX_IDENTS) {
        // oldest insertions first; never forget an active cooldown
        let n = map.size - MAX_IDENTS
        for (const [k, id] of map) {
          if (n <= 0) break
          if (id.until > now || live.has(k)) continue
          map.delete(k)
          n--
        }
      }
    }
    sweep(idents, liveKeys)
    sweep(ipStrikes, liveIps)
    registers.sweep(now)
    newAccounts.sweep(now)
  }

  /** Pooled-compute GFLOPS of a neuron: its benchmark once its INK zone is proven, else capped at the unproven zone. */
  function effectiveGflops(peer: Peer): number {
    if (zoneIndex(zoneFor(peer.claimed)) === bonusIdx(peer)) return peer.claimed
    const next = ZONES[zoneIndex(UNMEASURED_INK_CAP) + 1]
    const cap = next ? Math.max(GFLOPS_MIN, next.minGflops - 0.1) : GFLOPS_MAX
    return Math.min(peer.claimed, cap)
  }

  function bonusIdx(peer: Peer): number {
    const id = idents.get(peer.strikeKey)
    return zoneIndex(bonusZoneFor(peer.claimed, id?.bigEwma ?? 0, id?.bigMeasured ?? 0))
  }

  /** Keep the public NeuronInfo in step: zone = INK bonus zone, gflops = the benchmarked speed. */
  function refreshInfo(peer: Peer) {
    peer.info.zone = zoneAt(bonusIdx(peer))
    peer.info.gflops = peer.claimed
  }

  function flopsForZone(idx: number): number {
    const z = zoneAt(idx)
    return 2 * (JOB_ROWS[z] ?? JOB_ROWS.EPI) * (JOB_COLS[z] ?? JOB_COLS.EPI) * VEC_DIM
  }

  function bytesForZone(idx: number): number {
    const z = zoneAt(idx)
    return ((JOB_ROWS[z] ?? JOB_ROWS.EPI) + (JOB_COLS[z] ?? JOB_COLS.EPI)) * VEC_DIM * 4
  }

  // ── neurons broadcast (throttled on change + heartbeat) ──

  let lastNeuronsAt = 0
  let neuronsTimer: NodeJS.Timeout | null = null

  /** The public neuron list: the top limits.neuronsTop by session INK (then verified jobs, then seniority). */
  function neuronList(): NeuronInfo[] {
    const all = [...peers.values()].map((p) => p.info)
    all.sort((x, y) => y.ink - x.ink || y.verified - x.verified || x.connectedAt - y.connectedAt)
    return all.slice(0, limits.neuronsTop).map((n) => ({ ...n, ink: round2(n.ink) }))
  }

  function broadcastNeurons() {
    lastNeuronsAt = Date.now()
    if (neuronsTimer) {
      clearTimeout(neuronsTimer)
      neuronsTimer = null
    }
    safeEmit({ t: 'neurons', neurons: neuronList() })
  }

  function neuronsChanged() {
    if (stopped || neuronsTimer) return
    const wait = Math.max(0, lastNeuronsAt + NEURONS_THROTTLE_MS - Date.now())
    neuronsTimer = setTimeout(broadcastNeurons, wait)
    neuronsTimer.unref?.()
  }

  const heartbeat = setInterval(() => {
    try {
      // Skip if a change-driven broadcast just went out, so the total stays ≤ 2/s.
      if (Date.now() - lastNeuronsAt >= 1_000) broadcastNeurons()
      sweepIdents(Date.now())
      evictIdle(Date.now())
      sweepEscrow()
    } catch (e) {
      log('error', `heartbeat: ${(e as Error).message}`)
    }
  }, NEURONS_HEARTBEAT_MS)
  heartbeat.unref?.()

  const saver = setInterval(() => void saveLedger(), LEDGER_SAVE_MS)
  saver.unref?.()

  // ── corpus access (crawler is written independently — never trust it blindly) ──

  function corpusSize(): number {
    try {
      const n = crawler.vectorCount()
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    } catch (e) {
      log('error', `crawler.vectorCount failed: ${(e as Error).message}`)
      return 0
    }
  }

  /** Contract says Float32Array(VEC_DIM); tolerate any numeric array of the right length. */
  function isVec(v: unknown): v is ArrayLike<number> {
    return (ArrayBuffer.isView(v) || Array.isArray(v)) && (v as ArrayLike<number>).length === VEC_DIM
  }

  /** Copy a vector into a packed buffer, zeroing non-finite values. Returns false on a bad shape. */
  function packInto(dst: Float32Array, offset: number, v: unknown): boolean {
    if (!isVec(v)) return false
    for (let k = 0; k < VEC_DIM; k++) {
      const x = v[k]
      dst[offset + k] = Number.isFinite(x) ? x : 0
    }
    return true
  }

  const placeholderCache = new Map<string, string[]>()
  /** Positional, per-job ids for the wire ('r0', 'c17', …): real page ids stay server-side. */
  function placeholders(prefix: string, n: number): string[] {
    let arr = placeholderCache.get(prefix)
    if (!arr || arr.length < n) {
      arr = Array.from({ length: Math.max(n, arr?.length ?? 0) }, (_, i) => `${prefix}${i}`)
      placeholderCache.set(prefix, arr)
    }
    return arr.slice(0, n)
  }

  /** Track coverage for the newest pages; returns the pool (newest first). */
  function refreshRows(count: number): { ids: string[]; vecs: Float32Array[] } | null {
    let pool: { ids: string[]; vecs: Float32Array[] }
    try {
      pool = crawler.newestVectors(Math.min(ROW_POOL, count))
    } catch (e) {
      log('error', `crawler.newestVectors failed: ${(e as Error).message}`)
      return null
    }
    if (!pool || !Array.isArray(pool.ids)) return null
    for (let k = 0; k < pool.ids.length; k++) {
      const id = pool.ids[k]
      if (typeof id !== 'string' || rowStates.has(id)) continue
      // newestVectors is newest first: entry k sits at corpus index count-1-k and
      // only has to be compared against the OLDER pages [0, index).
      rowStates.set(id, { limit: Math.max(0, count - 1 - k), next: 0, lease: null })
    }
    if (rowStates.size > ROW_POOL * 1.25) {
      const keep = new Set(pool.ids)
      for (const [id, st] of rowStates) if (!keep.has(id) && !st.lease) rowStates.delete(id)
    }
    return pool
  }

  type BuildResult = { kind: 'job'; job: BuiltJob } | { kind: 'idle' } | { kind: 'thin'; rows: number } | { kind: 'error' }

  /**
   * Build a job from uncovered pairs only: up to JOB_ROWS[zone] unleased rows
   * that share the same coverage position `start`, against the column block
   * [start, min(start + JOB_COLS[zone], max row limit)), excluding the row
   * pages themselves (a page matches itself at 1.0).
   *
   * The newest coverage position with at least JOB_ROWS[zone]/2 rows wins (else
   * the largest group). Unless `allowThin`, a group smaller than that yields
   * 'thin' instead of a job: a few rows against a full column block costs
   * nearly the same bytes as a full job for a fraction of the work.
   */
  function buildJob(peer: Peer, count: number, sizeIdx: number, allowThin: boolean): BuildResult {
    const zone = zoneAt(sizeIdx)
    const wantRows = Math.max(1, JOB_ROWS[zone] ?? JOB_ROWS.EPI)
    const wantCols = Math.max(1, JOB_COLS[zone] ?? JOB_COLS.EPI)
    const fillRows = Math.ceil(wantRows / 2)
    const pool = refreshRows(count)
    if (!pool) return { kind: 'error' }

    for (let attempt = 0; attempt < 4; attempt++) {
      // Pass 1: unleased rows with uncovered pairs, grouped by coverage position (newest first).
      const groups = new Map<number, number>()
      for (let k = 0; k < pool.ids.length; k++) {
        const id = pool.ids[k]
        const st = typeof id === 'string' ? rowStates.get(id) : undefined
        if (!st || st.lease) continue
        if (st.next >= Math.min(st.limit, count)) continue
        if (!isVec(pool.vecs?.[k])) {
          st.next = st.limit // unusable vector: never a row
          continue
        }
        groups.set(st.next, (groups.get(st.next) ?? 0) + 1)
      }
      if (groups.size === 0) return { kind: 'idle' }
      let start = -1
      let best = -1
      let bestN = 0
      for (const [s, n] of groups) {
        if (start < 0 && n >= fillRows) start = s // Map keeps first-seen (newest-row) order
        if (n > bestN) [best, bestN] = [s, n]
      }
      if (start < 0) {
        if (!allowThin) return { kind: 'thin', rows: bestN }
        start = best
      }

      // Pass 2: up to wantRows rows at that position.
      let maxLimit = 0
      const rowIds: string[] = []
      const rowVecs: ArrayLike<number>[] = []
      for (let k = 0; k < pool.ids.length && rowIds.length < wantRows; k++) {
        const id = pool.ids[k]
        const st = typeof id === 'string' ? rowStates.get(id) : undefined
        if (!st || st.lease || st.next !== start) continue
        const limit = Math.min(st.limit, count)
        if (st.next >= limit) continue
        const v = pool.vecs?.[k]
        if (!isVec(v)) continue
        rowIds.push(id)
        rowVecs.push(v)
        maxLimit = Math.max(maxLimit, limit)
      }
      if (rowIds.length === 0) return { kind: 'idle' }
      const colEnd = Math.min(start + wantCols, maxLimit)
      const rowSet = new Set(rowIds)

      let colsRes: { ids: string[]; vecs: Float32Array[] }
      try {
        colsRes = crawler.vectors(start, colEnd - start)
      } catch (e) {
        log('error', `crawler.vectors failed: ${(e as Error).message}`)
        return { kind: 'error' }
      }
      if (!colsRes || !Array.isArray(colsRes.ids)) return { kind: 'error' }

      const cacheKey = colsRes.ids.length ? `${start}:${colEnd}:${colsRes.ids[0]}:${colsRes.ids[colsRes.ids.length - 1]}:${colsRes.ids.length}` : ''
      let b: Float32Array | null = null
      let colIds: string[] = []
      let b64b = ''
      let excluded = 0
      for (const id of colsRes.ids) if (rowSet.has(id)) excluded++
      const hit = excluded === 0 && cacheKey ? colCache.find((c) => c.key === cacheKey) : undefined
      if (hit) {
        b = hit.b
        colIds = hit.ids
        b64b = hit.b64
      } else {
        const colVecs: ArrayLike<number>[] = []
        const colSet = new Set<string>()
        for (let i = 0; i < colsRes.ids.length; i++) {
          const id = colsRes.ids[i]
          const v = colsRes.vecs?.[i]
          if (typeof id !== 'string' || rowSet.has(id) || colSet.has(id) || !isVec(v)) continue
          colSet.add(id)
          colIds.push(id)
          colVecs.push(v)
        }
        if (colIds.length) {
          b = new Float32Array(colIds.length * VEC_DIM)
          for (let c = 0; c < colIds.length; c++) packInto(b, c * VEC_DIM, colVecs[c])
          b64b = encodeF32(b)
          if (excluded === 0 && cacheKey && colIds.length === colsRes.ids.length) {
            colCache.unshift({ key: cacheKey, b, ids: colIds, b64: b64b })
            if (colCache.length > COL_CACHE_SIZE) colCache.length = COL_CACHE_SIZE
          }
        }
      }
      if (!b || colIds.length === 0) {
        // Nothing comparable in this block (only the rows themselves): mark it covered, unpaid.
        for (const id of rowIds) {
          const st = rowStates.get(id)
          if (st && !st.lease) st.next = Math.max(st.next, colEnd)
        }
        continue
      }

      const rows = rowIds.length
      const cols = colIds.length
      const dim = VEC_DIM
      const a = new Float32Array(rows * dim)
      for (let r = 0; r < rows; r++) packInto(a, r * dim, rowVecs[r])
      return {
        kind: 'job',
        job: {
          id: `j${(++seq).toString(36)}-${peer.conn.id.slice(0, 6)}`,
          rows,
          cols,
          dim,
          a,
          b,
          rowIds,
          colIds,
          colEnd,
          flops: 2 * rows * cols * dim,
          zoneIdx: bonusIdx(peer),
          sizeIdx,
          bytes: a.byteLength + b.byteLength,
          issuedAt: Date.now(),
          b64b,
        },
      }
    }
    return { kind: 'idle' }
  }

  /** Release a job's resources and row leases exactly once; advance coverage when verified. */
  function settle(p: PendingJob, verified: boolean) {
    clearTimeout(p.timer)
    pendingBytes = Math.max(0, pendingBytes - p.bytes)
    if (p.sizeIdx >= BIG_IDX) bigJobs = Math.max(0, bigJobs - 1)
    for (const id of p.rowIds) {
      const st = rowStates.get(id)
      if (!st || st.lease !== p.id) continue
      st.lease = null
      if (verified) st.next = Math.max(st.next, p.colEnd)
    }
  }

  // ── job scheduling ──

  function live(peer: Peer): boolean {
    return !stopped && peers.get(peer.conn.id) === peer
  }

  function schedule(peer: Peer, ms: number) {
    if (peer.timer) return
    peer.timer = setTimeout(() => {
      peer.timer = null
      try {
        pump(peer)
      } catch (e) {
        log('error', `pump: ${(e as Error).message}`)
      }
    }, Math.max(0, ms))
    peer.timer.unref?.()
  }

  function tellQueued(peer: Peer, msg: string) {
    if (peer.warned) return
    peer.warned = true
    safeSend(peer.conn, { t: 'error', msg })
  }

  /** Serve a waiting job.request if spacing / corpus / budgets allow, otherwise re-arm. */
  function pump(peer: Peer) {
    if (!live(peer) || !peer.wants || peer.pending || peer.pendingTrain || peer.issuing || peer.timer) return
    const now = Date.now()
    if (tryTrain(peer, now)) return
    const count = corpusSize()

    if (count < 2) {
      tellQueued(peer, 'corpus warming up')
      schedule(peer, WARMUP_RETRY_MS) // keep the request queued; the job follows automatically
      return
    }

    const notBefore = Math.max(
      peer.lastIssueAt + MIN_JOB_GAP_MS,
      count < MIN_CORPUS ? peer.requestedAt + SMALL_CORPUS_DELAY_MS : 0,
    )
    if (notBefore > now) {
      schedule(peer, notBefore - now)
      return
    }

    // A neuron that could never be credited (ledger full / too many new accounts
    // from this address) gets no work rather than unpaid work.
    if (!accounts.has(peer.account) && !canCreateAccount(peer.ip, now)) {
      if (!peer.warnedAccount) {
        peer.warnedAccount = true
        const wait = Math.max(60_000, newAccounts.retryIn(accountNetKey(peer.ip), now))
        safeSend(peer.conn, { t: 'error', msg: `the credit ledger is not accepting new accounts from this address right now — retry in ${Math.ceil(wait / 1000)} s` })
      }
      schedule(peer, 60_000)
      return
    }

    // Never pile jobs onto a socket that is not reading.
    let backlog = 0
    try {
      backlog = peer.conn.buffered?.() ?? 0
    } catch {
      backlog = 0
    }
    if (backlog > MAX_SEND_BACKLOG) {
      schedule(peer, BUDGET_RETRY_MS)
      return
    }

    let sizeIdx = Math.min(peer.claimedIdx, peer.rampIdx)
    if (sizeIdx >= BIG_IDX && bigJobs >= limits.maxBigJobs) sizeIdx = BIG_IDX - 1
    while (sizeIdx > 0 && bytesForZone(sizeIdx) > limits.maxPendingBytes) sizeIdx--
    const est = bytesForZone(sizeIdx)
    if (pendingBytes + est > limits.maxPendingBytes || verifyBudget.level() < 0) {
      schedule(peer, BUDGET_RETRY_MS + randomInt(BUDGET_RETRY_MS))
      return
    }
    const level = issueBytes.level()
    if (level <= 0) {
      // Global egress budget in debt: wait about as long as it takes to refill (jittered, so
      // waiting neurons do not all re-check at once).
      const refillMs = (-level / limits.issueBytesPerSec) * 1000
      schedule(peer, Math.min(MAX_BUDGET_WAIT_MS, Math.max(BUDGET_RETRY_MS, refillMs)) + randomInt(BUDGET_RETRY_MS))
      return
    }

    const fillWaitLeft = peer.lastIssueAt + limits.jobFillWaitMs - now
    const built = buildJob(peer, count, sizeIdx, fillWaitLeft <= 0)
    if (built.kind === 'error') {
      schedule(peer, WARMUP_RETRY_MS)
      return
    }
    if (built.kind === 'thin') {
      // Too few new rows for a worthwhile job yet: hold the request until enough pages
      // arrive or the fill wait runs out. ("warming up" = queued for both neuron clients.)
      tellQueued(peer, `corpus warming up — batching new pages into a fuller job; the request stays queued (next job within ${Math.ceil(fillWaitLeft / 1000)} s)`)
      schedule(peer, Math.max(BUDGET_RETRY_MS, Math.min(IDLE_RETRY_MS, fillWaitLeft)))
      return
    }
    if (built.kind === 'idle') {
      // Every current page pair is verified: no paid work exists until new pages arrive.
      tellQueued(peer, 'corpus warming up — every current page pair is already verified; the request stays queued for new pages')
      schedule(peer, IDLE_RETRY_MS)
      return
    }
    issue(peer, built.job)
  }

  function issue(peer: Peer, built: BuiltJob) {
    const { b64b, ...rest } = built
    const timer = setTimeout(() => onTimeout(peer, built.id), JOB_TIMEOUT_MS)
    timer.unref?.()
    const pending: PendingJob = { ...rest, timer, sentAt: Date.now() }
    for (const id of built.rowIds) {
      const st = rowStates.get(id)
      if (st) st.lease = built.id
    }
    pendingBytes += built.bytes
    if (built.sizeIdx >= BIG_IDX) bigJobs++
    peer.pending = pending
    peer.wants = false
    peer.warned = false
    peer.warnedAccount = false
    peer.lastIssueAt = built.issuedAt
    peer.info.jobs++
    const acc = accounts.get(peer.account)
    if (acc) {
      acc.jobs++
      acc.lastSeen = built.issuedAt
      markDirty()
      touch(acc.key)
    }

    const job: SimJob = {
      id: built.id,
      kind: 'simmatrix',
      dim: built.dim,
      rows: built.rows,
      cols: built.cols,
      a: encodeF32(built.a),
      b: b64b,
      rowIds: placeholders('r', built.rows),
      colIds: placeholders('c', built.cols),
      flops: built.flops,
      issuedAt: built.issuedAt,
    }
    const wireBytes = job.a.length + job.b.length
    issueBytes.take(wireBytes)
    pending.sentAt = Date.now()
    safeSend(peer.conn, { t: 'job', job })
    neuronsChanged()
  }

  function onTimeout(peer: Peer, jobId: string) {
    try {
      if (!live(peer) || peer.pending?.id !== jobId) return
      const p = peer.pending
      peer.pending = null
      settle(p, false)
      fail(peer, p, `timed out after ${JOB_TIMEOUT_MS / 1000} s`)
      pump(peer)
    } catch (e) {
      log('error', `timeout handler: ${(e as Error).message}`)
    }
  }

  // ── verdicts ──

  function inkEvent(peer: Peer, jobId: string, ink: number, verified: boolean, reason: string, kind: 'sim' | 'train' = 'sim', status?: InkEvent['status']) {
    const event: InkEvent = { neuronId: peer.info.id, jobId, ink, verified, reason, ts: Date.now(), kind }
    if (status) event.status = status
    safeEmit({ t: 'ink', event })
  }

  /** Count a failed / abandoned job and record the strike. Returns true when a cooldown tripped. */
  function recordFailure(peer: Peer, p: { id: string; kind?: 'train' }, reason: string): { tripped: boolean; waitMs: number } {
    const now = Date.now()
    peer.info.failed++
    totals.jobsDone++
    totals.jobsFailed++
    const acc = accounts.get(peer.account)
    if (acc) {
      acc.failed++
      settleJobCount(acc)
      touch(acc.key)
    }
    markDirty()
    inkEvent(peer, p.id, 0, false, reason, p.kind ?? 'sim')

    peer.rampIdx = Math.max(0, peer.rampIdx - 1)
    const id = identOf(idents, peer.strikeKey)
    const ipi = identOf(ipStrikes, peer.ip)
    id.lastAt = ipi.lastAt = now
    if (id.measured > 0) id.ewma *= 0.5
    id.fails++
    ipi.fails++
    let tripped = false
    if (id.fails >= MAX_CONSEC_FAILS) {
      id.fails = 0
      id.kicks++
      id.until = now + cooldownFor(id.kicks)
      tripped = true
    }
    if (ipi.fails >= IP_MAX_CONSEC_FAILS) {
      ipi.fails = 0
      ipi.kicks++
      ipi.until = now + cooldownFor(ipi.kicks)
      tripped = true
    }
    if (tripped) {
      const until = Math.max(id.until, ipi.until)
      for (const k of cooldownKeys(peer.strikeKey, peer.conn.id, peer.account)) {
        const rec = identOf(idents, k)
        rec.until = Math.max(rec.until, until)
        rec.lastAt = now
      }
    }
    refreshInfo(peer)
    neuronsChanged()
    return { tripped, waitMs: Math.max(0, coolingUntil(peer.strikeKey, peer.ip, peer.conn.id, peer.account) - now) }
  }

  function fail(peer: Peer, p: { id: string; kind?: 'train' }, reason: string) {
    const r = recordFailure(peer, p, reason)
    if (!r.tripped) return
    const secs = Math.ceil(r.waitMs / 1000)
    const msg = `neuron disconnected: ${MAX_CONSEC_FAILS} consecutive failed jobs (last: ${reason}). Re-register in ${secs} s.`
    // Every live connection of the same identity goes too.
    for (const other of [...peers.values()]) if (other !== peer && other.strikeKey === peer.strikeKey) kick(other, msg)
    kick(peer, msg)
  }

  /** Update the identity's measured throughput and the job-size ramp after a verified job. */
  function measure(peer: Peer, p: { flops: number; sentAt: number; sizeIdx: number }, receivedAt: number, flopsAt: (idx: number) => number = flopsForZone) {
    const id = identOf(idents, peer.strikeKey)
    const m = measuredGflops(p.flops, receivedAt - p.sentAt)
    id.ewma = id.measured === 0 ? m : EWMA_KEEP * id.ewma + (1 - EWMA_KEEP) * m
    id.measured++
    if (p.flops >= BIG_JOB_FLOPS) {
      id.bigEwma = id.bigMeasured === 0 ? m : EWMA_KEEP * id.bigEwma + (1 - EWMA_KEEP) * m
      id.bigMeasured++
    }
    id.lastAt = receivedAt
    const predictMs = (idx: number) => flopsAt(idx) / (Math.max(id.ewma, 1e-6) * 1e6)
    if (p.sizeIdx >= peer.rampIdx && peer.rampIdx < peer.claimedIdx && predictMs(peer.rampIdx + 1) < RAMP_UP_BUDGET_MS) peer.rampIdx++
    else if (peer.rampIdx > 0 && predictMs(peer.rampIdx) > RAMP_DOWN_BUDGET_MS) peer.rampIdx--
    refreshInfo(peer)
  }

  function pass(peer: Peer, p: PendingJob, reason: string, receivedAt: number): number {
    const ink = inkFor(p.flops, p.zoneIdx)
    const now = Date.now()
    peer.info.verified++
    peer.info.ink += ink
    const id = identOf(idents, peer.strikeKey)
    id.fails = 0
    id.lastAt = now
    const ipi = ipStrikes.get(peer.ip)
    if (ipi) ipi.fails = 0
    totals.jobsDone++
    totals.jobsVerified++
    totals.inkIssued += ink
    totals.flopsVerified += p.flops
    const acc = accountForPeer(peer, ink)
    if (acc) {
      acc.verified++
      settleJobCount(acc)
      acc.ink += ink
      acc.periodInk = round6((acc.periodInk ?? 0) + ink)
      if (acc.kind === 'device') acc.earnNet = hid('net', accountNetKey(peer.ip))
      acc.flops += p.flops
      acc.lastSeen = now
      touch(acc.key)
    }
    // Append-only audit trail (salted hashes only; written asynchronously, never read back).
    issuance.write({
      ts: now,
      ev: 'issue',
      jobId: p.id,
      acct: hid('acct', peer.account),
      kind: peer.accountKind,
      dev: hid('ident', peer.strikeKey),
      ip: hid('ip', peer.ip),
      net: hid('net', accountNetKey(peer.ip)),
      zone: zoneAt(p.zoneIdx),
      size: zoneAt(p.sizeIdx),
      rows: p.rows,
      cols: p.cols,
      flops: p.flops,
      ink,
      rttMs: Math.max(0, receivedAt - p.sentAt),
      credited: acc !== null,
    })
    markDirty()
    inkEvent(peer, p.id, ink, true, reason)
    neuronsChanged()
    return ink
  }

  /**
   * Report near-duplicates from a verified job. Every candidate pair is
   * re-scored on the CPU (one 256-d dot product), so a neuron that passed the
   * spot-check still cannot fabricate duplicates on unchecked rows.
   */
  function reportDups(p: PendingJob, result: { best: number[]; sim: number[] }) {
    for (let r = 0; r < p.rows; r++) {
      if (!(result.sim[r] >= DUP_THRESHOLD - SIM_TOLERANCE)) continue
      const c = result.best[r]
      const rowId = p.rowIds[r]
      const colId = p.colIds[c]
      if (!rowId || !colId || rowId === colId || markedRows.has(rowId)) continue
      const sim = dot(p.a, r * p.dim, p.b, c * p.dim, p.dim)
      if (!(sim >= DUP_THRESHOLD)) continue
      if (markedRows.size >= MAX_MARKED_PAIRS) markedRows.clear()
      markedRows.add(rowId)
      totals.dupsFound++
      try {
        crawler.markSemanticDup(rowId, colId, Math.round(sim * 10_000) / 10_000)
      } catch (e) {
        log('error', `crawler.markSemanticDup failed: ${(e as Error).message}`)
      }
    }
  }

  function onResult(peer: Peer, raw: unknown) {
    const receivedAt = Date.now()
    const p = peer.pending
    const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined
    if (!p || id !== p.id) {
      // Late result for a timed-out job, or a stray message: not a failure, just stale.
      safeSend(peer.conn, { t: 'error', msg: 'unknown or expired job' })
      return
    }
    peer.pending = null

    const shapeErr = validateResultShape(raw, p.rows, p.cols)
    if (shapeErr) {
      settle(p, false)
      fail(peer, p, `malformed result: ${shapeErr}`)
      return
    }
    const result = raw as { best: number[]; sim: number[]; ms?: number }
    const t0 = performance.now()
    const v = verifySimResult(p, result, pickCheckRows(p.rows))
    const ms = typeof result.ms === 'number' ? Math.round(result.ms) : receivedAt - p.sentAt
    if (!v.ok) {
      verifyBudget.take(performance.now() - t0)
      settle(p, false)
      fail(peer, p, `spot-check failed row ${v.failRow} (Δ ${fmtDelta(v.delta)})`)
      return
    }
    settle(p, true)
    pass(peer, p, `verified ${v.passed}/${v.checked} rows · ${fmtFlops(p.flops)} · ${ms} ms`, receivedAt)
    measure(peer, p, receivedAt)
    reportDups(p, result)
    verifyBudget.take(performance.now() - t0)
  }

  // ── SEPIA gradient jobs ──
  //
  // A neuron advertising caps.train gets gradient jobs from the trainer (batch per job-size zone,
  // contract 5); dedupe jobs remain the fallback whenever the trainer has none. Gradient INK goes
  // to an escrow keyed by the strike identity and reaches the ledger (lifetime INK, periodInk,
  // leaderboard, payouts) only when that identity's next full audit passes; a failed audit
  // forfeits the whole escrow and counts as a strike. The first FORCE_AUDIT_JOBS results of an
  // identity are always fully audited.

  /** Trainer-side neuron key: identity + connection (weights held and jobs outstanding are per connection). */
  function trainKey(strikeKey: string, connId: string): string {
    return `${hid('ident', strikeKey)}#${connId}`
  }

  function trainBatchFor(peer: Peer, sizeIdx: number): number {
    return peer.cpu || peer.trainCpu ? CPU_TRAIN_BATCH : (TRAIN_BATCH[zoneAt(sizeIdx)] ?? TRAIN_BATCH.EPI)
  }

  function escrowOf(strikeKey: string): EscrowRecord {
    let rec = escrow.get(strikeKey)
    if (!rec) {
      rec = { trainJobs: 0, items: {}, lastAt: Date.now() }
      escrow.set(strikeKey, rec)
    }
    return rec
  }

  function indexEscrow(acct: string, strikeKey: string) {
    let s = escrowIdx.get(acct)
    if (!s) escrowIdx.set(acct, (s = new Set()))
    s.add(strikeKey)
  }

  /** Drop `strikeKey` from the account's escrow index once its record holds no item of that account. */
  function unindexEscrow(acct: string, strikeKey: string, rec: EscrowRecord | undefined) {
    const s = escrowIdx.get(acct)
    if (!s) return
    if (rec) for (const [k, it] of Object.entries(rec.items)) if ((it.acct ?? k) === acct) return
    s.delete(strikeKey)
    if (!s.size) escrowIdx.delete(acct)
  }

  /** Escrowed gradient-job INK of one ledger account (not in its `ink` / `periodInk` yet). */
  function pendingInkOf(acct: string): number {
    const s = escrowIdx.get(acct)
    if (!s) return 0
    let total = 0
    for (const sk of [...s]) {
      const rec = escrow.get(sk)
      let held = false
      if (rec) {
        for (const [k, it] of Object.entries(rec.items)) {
          if ((it.acct ?? k) !== acct) continue
          total += it.ink
          held = true
        }
      }
      if (!held) s.delete(sk)
    }
    if (!s.size) escrowIdx.delete(acct)
    return total
  }

  /** Bound the escrow map: drop the oldest records that hold no INK. */
  function sweepEscrow() {
    if (escrow.size <= MAX_ESCROW_RECORDS) return
    const empty = [...escrow].filter(([, r]) => !Object.keys(r.items).length).sort((x, y) => x[1].lastAt - y[1].lastAt)
    let n = escrow.size - MAX_ESCROW_RECORDS
    for (const [k] of empty) {
      if (n-- <= 0) break
      escrow.delete(k)
    }
    markDirty()
  }

  function validTrainJob(job: unknown): job is TrainJob {
    if (!job || typeof job !== 'object') return false
    const j = job as Partial<TrainJob>
    return (
      typeof j.id === 'string' && j.id.length > 0 && j.kind === 'train' && typeof j.version === 'number' &&
      (j.weights === null || typeof j.weights === 'string') && typeof j.x === 'string' && typeof j.y === 'string' &&
      typeof j.batch === 'number' && j.batch > 0 && typeof j.flops === 'number' && Number.isFinite(j.flops)
    )
  }

  /**
   * Gradient path of pump(): returns true when it took over the request (a job is being fetched
   * from the trainer, or the request was re-armed for pacing / budgets). False → dedupe path.
   */
  /** Per-network token bucket for first weights downloads. */
  const weightsNet = new Map<string, { tokens: number; at: number }>()
  function weightsTokens(ip: string, now: number): { tokens: number; at: number } {
    const k = accountNetKey(ip)
    let b = weightsNet.get(k)
    if (!b) {
      b = { tokens: WEIGHTS_NET_BURST, at: now }
      weightsNet.set(k, b)
      if (weightsNet.size > 20_000) {
        const first = weightsNet.keys().next().value
        if (first !== undefined) weightsNet.delete(first)
      }
    }
    b.tokens = Math.min(WEIGHTS_NET_BURST, b.tokens + (now - b.at) / WEIGHTS_NET_EVERY_MS)
    b.at = now
    return b
  }

  function tryTrain(peer: Peer, now: number): boolean {
    const tr = opts.trainer
    if (!tr || !peer.trainCap || now < peer.trainNullUntil) return false
    const notBefore = peer.lastIssueAt + MIN_JOB_GAP_MS
    if (notBefore > now) {
      schedule(peer, notBefore - now)
      return true
    }
    // No credit possible (ledger full / new-account rate): the dedupe path tells the neuron why.
    if (!accounts.has(peer.account) && !canCreateAccount(peer.ip, now)) return false
    let backlog = 0
    try {
      backlog = peer.conn.buffered?.() ?? 0
    } catch {
      backlog = 0
    }
    if (backlog > MAX_SEND_BACKLOG || verifyBudget.level() < 0) {
      schedule(peer, BUDGET_RETRY_MS + randomInt(BUDGET_RETRY_MS))
      return true
    }
    const level = issueBytes.level()
    if (level <= 0) {
      const refillMs = (-level / limits.issueBytesPerSec) * 1000
      schedule(peer, Math.min(MAX_BUDGET_WAIT_MS, Math.max(BUDGET_RETRY_MS, refillMs)) + randomInt(BUDGET_RETRY_MS))
      return true
    }
    if (peer.trainVersion === null) {
      const wb = weightsTokens(peer.ip, now)
      if (wb.tokens < 1) {
        // This network fetched weights recently: dedupe jobs until a token refills.
        peer.trainNullUntil = now + Math.ceil((1 - wb.tokens) * WEIGHTS_NET_EVERY_MS)
        return false
      }
    }
    const sizeIdx = Math.min(peer.claimedIdx, peer.rampIdx)
    const batch = trainBatchFor(peer, sizeIdx)
    const zoneIdx = bonusIdx(peer)
    const haveVersion = peer.trainVersion
    peer.issuing = true
    const giveUp = () => {
      peer.trainNullUntil = Date.now() + TRAIN_NULL_BACKOFF_MS
      if (live(peer)) pump(peer)
    }
    Promise.resolve()
      .then(() => tr.issueTrainJob({ neuronKey: trainKey(peer.strikeKey, peer.conn.id), batch, haveVersion }))
      .then(
        (job) => {
          peer.issuing = false
          if (!live(peer) || !peer.wants || peer.pending || peer.pendingTrain) return
          if (!validTrainJob(job)) {
            if (job) log('error', 'trainer.issueTrainJob returned a malformed job')
            giveUp()
            return
          }
          issueTrain(peer, job, sizeIdx, zoneIdx)
        },
        (e) => {
          peer.issuing = false
          log('error', `trainer.issueTrainJob failed: ${(e as Error)?.message ?? e}`)
          giveUp()
        },
      )
      .catch((e) => log('error', `train issue: ${(e as Error)?.message ?? e}`))
    return true
  }

  function issueTrain(peer: Peer, job: TrainJob, sizeIdx: number, zoneIdx: number) {
    const now = Date.now()
    const timer = setTimeout(() => onTrainTimeout(peer, job.id), TRAIN_JOB_TIMEOUT_MS)
    timer.unref?.()
    const pending: PendingTrain = { id: job.id, kind: 'train', version: job.version, batch: job.batch, flops: Math.max(0, job.flops), zoneIdx, sizeIdx, issuedAt: now, sentAt: now, timer }
    peer.pendingTrain = pending
    peer.wants = false
    peer.warned = false
    peer.warnedAccount = false
    peer.lastIssueAt = now
    peer.info.jobs++
    const acc = accounts.get(peer.account)
    if (acc) {
      acc.jobs++
      acc.lastSeen = now
      markDirty()
      touch(acc.key)
    }
    // Egress: the real payload bytes on the wire (weights only when the neuron lacks the version).
    issueBytes.take((job.weights?.length ?? 0) + job.x.length + job.y.length)
    if (job.weights) weightsTokens(peer.ip, now).tokens -= 1
    pending.sentAt = Date.now()
    safeSend(peer.conn, { t: 'job', job })
    neuronsChanged()
  }

  function onTrainTimeout(peer: Peer, jobId: string) {
    try {
      if (!live(peer) || peer.pendingTrain?.id !== jobId) return
      const p = peer.pendingTrain
      peer.pendingTrain = null
      fail(peer, p, `gradient job timed out after ${TRAIN_JOB_TIMEOUT_MS / 1000} s`)
      pump(peer)
    } catch (e) {
      log('error', `train timeout handler: ${(e as Error).message}`)
    }
  }

  /**
   * `jobs` is counted at issue, on the account the neuron had then: none before its first credit
   * creates one, and the old one when a sign-in switches accounts mid-job. An account never shows
   * fewer jobs than were scored on it.
   */
  function settleJobCount(a: LedgerAccount) {
    if (a.jobs < a.verified + a.failed) a.jobs = a.verified + a.failed
  }

  /** Move an account's escrowed INK into the ledger (same rules as a verified dedupe job). */
  function creditEscrowItem(key: string, it: EscrowItem, ip: string, now: number): LedgerAccount | null {
    let a = accounts.get(key)
    if (!a && it.ink >= MIN_ACCOUNT_INK) {
      if (!canCreateAccount(ip, now)) return null
      a = { key, kind: it.kind, wallet: it.wallet, label: it.label, ink: 0, flops: 0, jobs: 0, verified: 0, failed: 0, firstSeen: now, lastSeen: now }
      if (it.kind === 'wallet') a.walletVerified = true
      accounts.set(key, a)
      newAccounts.add(accountNetKey(ip), now)
    }
    if (!a) return null
    a.verified += it.jobs
    settleJobCount(a)
    a.ink += it.ink
    a.periodInk = round6((a.periodInk ?? 0) + it.ink)
    if (a.kind === 'device') a.earnNet = hid('net', accountNetKey(ip))
    a.flops += it.flops
    a.lastSeen = now
    return a
  }

  /** Bound an escrow record's item count: merge per account (merged seq = newest, so release stays conservative). */
  function compactEscrow(rec: EscrowRecord) {
    const keys = Object.keys(rec.items)
    if (keys.length <= 256) return
    const merged: Record<string, EscrowItem> = {}
    for (const k of keys) {
      const it = rec.items[k]
      const acct = it.acct ?? k
      const m = merged[acct]
      if (!m) merged[acct] = { ...it, acct }
      else {
        m.ink += it.ink
        m.flops += it.flops
        m.jobs += it.jobs
        m.seq = Math.max(m.seq ?? 0, it.seq ?? 0)
        m.label = it.label
      }
    }
    rec.items = {}
    for (const [acct, it] of Object.entries(merged)) rec.items[`${acct}|${it.seq ?? 0}`] = it
  }

  /**
   * The identity passed a full audit: escrow items submitted up to (and including) the audited
   * job become confirmed INK. Items submitted after it (possibly while it was being audited)
   * wait for a later audit. Returns the INK released.
   */
  function confirmEscrow(peer: Peer, who: Submitter, jobId: string, now: number, uptoSeq: number): number {
    const rec = escrow.get(who.strikeKey)
    if (!rec) return 0
    let total = 0
    let jobs = 0
    const released = new Set<string>()
    for (const [key, it] of Object.entries(rec.items)) {
      if ((it.seq ?? 0) > uptoSeq) continue
      const acct = it.acct ?? key
      const acc = creditEscrowItem(acct, it, who.ip, now)
      total += it.ink
      jobs += it.jobs
      delete rec.items[key]
      released.add(acct)
      issuance.write({ ts: now, ev: 'confirm', jobId, acct: hid('acct', acct), kind: it.kind, dev: hid('ident', who.strikeKey), ink: round6(it.ink), jobs: it.jobs, flops: it.flops, credited: acc !== null })
    }
    for (const acct of released) {
      unindexEscrow(acct, who.strikeKey, rec)
      touch(acct)
    }
    rec.lastAt = now
    totals.inkPending = Math.max(0, totals.inkPending - total)
    totals.inkIssued += total
    if (peers.get(peer.conn.id) === peer) peer.info.ink += total
    markDirty()
    void jobs
    return total
  }

  /** A full audit failed: the identity's escrow is forfeited. Returns the INK forfeited. */
  function forfeitEscrow(peer: Peer, who: Submitter, jobId: string, reason: string, now: number): number {
    const rec = escrow.get(who.strikeKey)
    const total = escrowTotal(rec)
    if (!rec || !(total > 0)) return 0
    const forfeited = new Set<string>()
    for (const [key, it] of Object.entries(rec.items)) {
      forfeited.add(it.acct ?? key)
      issuance.write({ ts: now, ev: 'forfeit', jobId, acct: hid('acct', it.acct ?? key), kind: it.kind, dev: hid('ident', who.strikeKey), ink: round6(it.ink), jobs: it.jobs })
    }
    rec.items = {}
    for (const acct of forfeited) {
      unindexEscrow(acct, who.strikeKey, rec)
      touch(acct)
    }
    rec.lastAt = now
    totals.inkPending = Math.max(0, totals.inkPending - total)
    totals.inkForfeited += total
    markDirty()
    inkEvent(peer, jobId, round2(total), false, `escrow forfeited: ${reason}`, 'train', 'forfeited')
    return total
  }

  function onTrainResult(peer: Peer, raw: unknown) {
    const receivedAt = Date.now()
    const p = peer.pendingTrain
    const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined
    const tr = opts.trainer
    if (!p || !tr || id !== p.id) {
      safeSend(peer.conn, { t: 'error', msg: 'unknown or expired job' })
      return
    }
    peer.pendingTrain = null
    clearTimeout(p.timer)
    const r = raw as { grad?: unknown; loss?: unknown; ms?: unknown }
    let err: string | null = null
    if (typeof r.grad !== 'string' || !r.grad.length) err = 'grad must be a base64 string'
    else if (r.grad.length > MAX_GRAD_B64) err = 'grad payload too large'
    else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(r.grad)) err = 'grad is not base64'
    else if (typeof r.loss !== 'number' || !Number.isFinite(r.loss) || r.loss < 0) err = 'loss must be a finite non-negative number'
    else if (r.ms !== undefined && (typeof r.ms !== 'number' || !Number.isFinite(r.ms) || r.ms < 0)) err = 'ms must be a non-negative number'
    if (err) {
      fail(peer, p, `malformed gradient result: ${err}`)
      return
    }
    const grad = new Uint8Array(Buffer.from(r.grad as string, 'base64'))
    const who: Submitter = { strikeKey: peer.strikeKey, account: peer.account, accountKind: peer.accountKind, wallet: peer.info.wallet, label: peer.info.label, ip: peer.ip }
    const rec = escrowOf(who.strikeKey)
    const forceAudit = rec.trainJobs < FORCE_AUDIT_JOBS
    rec.trainJobs++
    rec.seq = (rec.seq ?? 0) + 1
    const seq = rec.seq
    rec.lastAt = receivedAt
    markDirty()
    const ms = typeof r.ms === 'number' ? Math.round(r.ms) : receivedAt - p.sentAt
    Promise.resolve()
      .then(() => tr.submitTrainResult({ neuronKey: trainKey(who.strikeKey, peer.conn.id), jobId: p.id, grad, loss: r.loss as number, forceAudit }))
      .then(
        (v) => onTrainVerdict(peer, p, who, v, ms, receivedAt, seq),
        (e) => {
          log('error', `trainer.submitTrainResult failed: ${(e as Error)?.message ?? e}`)
          inkEvent(peer, p.id, 0, false, 'gradient not scored: server error (no strike)', 'train')
        },
      )
      .catch((e) => log('error', `train verdict: ${(e as Error)?.stack ?? e}`))
  }

  type TrainVerdict = Awaited<ReturnType<NonNullable<CoordinatorOptions['trainer']>['submitTrainResult']>>

  function onTrainVerdict(peer: Peer, p: PendingTrain, who: Submitter, v: TrainVerdict, ms: number, receivedAt: number, seq: number) {
    const now = Date.now()
    const verdict = v && typeof v === 'object' ? v.verdict : undefined
    const reason = typeof v?.reason === 'string' ? v.reason.slice(0, 200) : ''
    // INK only for work the trainer actually verified: its verdict carries the FLOPs it checked.
    const flops = typeof v?.flops === 'number' && Number.isFinite(v.flops) && v.flops > 0 ? Math.min(v.flops, p.flops > 0 ? p.flops : v.flops) : 0
    if ((verdict === 'applied' || verdict === 'audited' || verdict === 'stale') && !(flops > 0)) {
      // Expired / unknown job, base weights dropped, trainer restarting, audit queue full: not scored.
      if (verdict !== 'stale') log('error', `trainer verdict '${verdict}' without FLOPs for ${p.id}; not credited`)
      inkEvent(peer, p.id, 0, false, `gradient not scored: ${reason || 'job expired'} (no strike)`, 'train')
      return
    }
    if (verdict === 'applied' || verdict === 'audited' || verdict === 'stale') {
      const audited = verdict === 'audited' || (verdict === 'stale' && v.audited === true)
      const ink = inkFor(flops, p.zoneIdx)
      peer.info.verified++
      const id = identOf(idents, who.strikeKey)
      id.fails = 0
      id.lastAt = now
      const ipi = ipStrikes.get(who.ip)
      if (ipi) ipi.fails = 0
      totals.jobsDone++
      totals.jobsVerified++
      totals.flopsVerified += flops
      totals.inkPending += ink
      const rec = escrowOf(who.strikeKey)
      rec.items[`${who.account}|${seq}`] = { kind: who.accountKind, wallet: who.wallet, label: who.label, ink, flops, jobs: 1, acct: who.account, seq }
      indexEscrow(who.account, who.strikeKey)
      compactEscrow(rec)
      rec.lastAt = now
      touch(who.account)
      issuance.write({
        ts: now, ev: 'escrow', jobId: p.id, acct: hid('acct', who.account), kind: who.accountKind, dev: hid('ident', who.strikeKey),
        ip: hid('ip', who.ip), net: hid('net', accountNetKey(who.ip)), zone: zoneAt(p.zoneIdx), size: zoneAt(p.sizeIdx),
        batch: p.batch, version: p.version, flops, ink, verdict, audited, rttMs: Math.max(0, receivedAt - p.sentAt),
      })
      markDirty()
      const what = verdict === 'stale' ? 'gradient verified · base too old to apply' : audited ? 'gradient fully audited · applied' : 'gradient checked · applied'
      const base = `${what} · B ${p.batch} · v${p.version} · ${fmtFlops(flops)} · ${ms} ms`
      if (audited) {
        const released = confirmEscrow(peer, who, p.id, now, seq)
        inkEvent(peer, p.id, ink, true, base, 'train', 'confirmed')
        const prior = round2(released - ink)
        if (prior > 0) inkEvent(peer, p.id, prior, true, `escrow released by full audit: ${prior} credits from earlier gradient jobs`, 'train', 'confirmed')
      } else {
        inkEvent(peer, p.id, ink, true, `${base} · held in escrow until the next full audit`, 'train', 'pending')
      }
      if (peers.get(peer.conn.id) === peer) {
        const batchAt = (idx: number) => p.flops * (trainBatchFor(peer, idx) / Math.max(1, p.batch))
        measure(peer, { flops, sentAt: p.sentAt, sizeIdx: p.sizeIdx }, receivedAt, batchAt)
      }
      neuronsChanged()
      return
    }
    if (verdict === 'audit-failed') {
      forfeitEscrow(peer, who, p.id, reason || 'full audit failed', now)
      if (peers.get(peer.conn.id) === peer) fail(peer, p, /^full audit failed/.test(reason) ? reason : `full audit failed: ${reason}`)
      else recordFailure(peer, p, /^full audit failed/.test(reason) ? reason : `full audit failed: ${reason}`)
      return
    }
    const why = verdict === 'rejected' ? `gradient rejected: ${reason}` : 'gradient rejected: no verdict'
    if (peers.get(peer.conn.id) === peer) fail(peer, p, why)
    else recordFailure(peer, p, why)
  }

  // ── registration ──

  function kick(peer: Peer, msg: string) {
    safeSend(peer.conn, { t: 'error', msg })
    remove(peer.conn.id, null)
    try {
      peer.conn.close?.(1008, 'neuron cooling down')
    } catch {
      /* already closed */
    }
    log('warn', `kicked ${peer.info.label} (${peer.conn.id} · ${peer.strikeKey}): ${msg}`)
  }

  /**
   * Drop a neuron from the pool. With `abandoned` set and a job outstanding, the
   * job counts as a failed timeout (leaving or disconnecting is no escape hatch).
   */
  function remove(connId: string, abandoned: string | null): boolean {
    const peer = peers.get(connId)
    if (!peer) return false
    if (peer.timer) clearTimeout(peer.timer)
    const p = peer.pending
    const pt = peer.pendingTrain
    peer.timer = null
    peer.pending = null
    peer.pendingTrain = null
    peer.wants = false
    peers.delete(connId)
    if (p) {
      settle(p, false)
      if (abandoned) recordFailure(peer, p, abandoned)
    }
    if (pt) {
      clearTimeout(pt.timer)
      if (abandoned) recordFailure(peer, pt, abandoned)
    }
    const acc = accounts.get(peer.account)
    if (acc) {
      acc.lastSeen = Date.now()
      markDirty()
      touch(acc.key)
    }
    neuronsChanged()
    return true
  }

  function refuse(conn: NeuronConn, msg: string) {
    safeSend(conn, { t: 'error', msg })
  }

  function register(conn: NeuronConn, msg: Extract<ClientMsg, { t: 'neuron.register' }>) {
    const now = Date.now()
    const ip = typeof conn.ip === 'string' && conn.ip ? conn.ip : 'unknown'
    if (registers.count(ip, now) >= MAX_REGISTERS_PER_IP) {
      refuse(conn, `too many neuron registrations from this address — retry in ${Math.ceil(registers.retryIn(ip, now) / 1000)} s`)
      return
    }
    registers.add(ip, now)

    const adapter = sanitizeAdapter(msg.adapter)
    const label = sanitizeLabel(msg.label, adapter)
    // Only a wallet proven by a valid session token counts; a bare `wallet` field is ignored.
    const authRaw = (msg as { auth?: unknown }).auth
    const claims = authRaw !== undefined && authRaw !== null && authRaw !== '' ? (opts.auth?.checkToken(authRaw) ?? null) : null
    const wallet = claims?.wallet ?? null
    const authState: 'verified' | 'invalid' | 'none' = wallet ? 'verified' : authRaw ? 'invalid' : 'none'
    const claimed = clampGflops(msg.gflops)
    const claimedIdx = zoneIndex(zoneFor(claimed)) // never trust the client's zone
    const kind: NeuronInfo['kind'] = msg.kind === 'desktop' ? 'desktop' : 'browser'
    const rawDevice = adapter?.deviceId ?? adapter?.device
    const device = typeof rawDevice === 'string' && DEVICE_ID_RE.test(rawDevice) ? rawDevice : null

    // Strikes / cooldowns / measurements: device → verified wallet → remote ip.
    const strikeKey = device ? `device:${device}` : wallet ? `wallet:${wallet}` : `ip:${ip}`

    // Ledger key: verified wallet → device id → label.
    let key: string
    let accKind: LedgerAccount['kind']
    if (wallet) {
      key = `wallet:${wallet}`
      accKind = 'wallet'
    } else if (device) {
      key = `device:${device}`
      accKind = 'device'
    } else {
      key = `label:${label.toLowerCase()}`
      accKind = 'label'
    }

    const until = coolingUntil(strikeKey, ip, conn.id, key)
    if (until > now) {
      refuse(conn, `cooling down after failed jobs — retry in ${Math.ceil((until - now) / 1000)} s`)
      return
    }

    const existing = peers.get(conn.id)
    if (existing) {
      // Re-register on the same connection: update identity, keep counters and any job in flight.
      // Linking or unlinking a verified wallet is exempt from the switch limit (sign-in / sign-out).
      const walletSwitch = accKind === 'wallet' || existing.accountKind === 'wallet'
      if (key !== existing.account && !walletSwitch && now - existing.accountSetAt < ACCOUNT_SWITCH_MS) {
        refuse(conn, `ledger account switch too frequent — retry in ${Math.ceil((existing.accountSetAt + ACCOUNT_SWITCH_MS - now) / 1000)} s`)
        return
      }
      if (key !== existing.account) existing.accountSetAt = now
      rejoined(strikeKey)
      existing.account = key
      existing.accountKind = accKind
      existing.strikeKey = strikeKey
      existing.claimed = claimed
      existing.claimedIdx = claimedIdx
      existing.cpu = (adapter?.backend?.toLowerCase() ?? '').startsWith('cpu')
      existing.info = { ...existing.info, label, kind, wallet }
      refreshInfo(existing)
      const moved = wallet && device ? linkDevice(device, wallet, ip, now) : 0
      const acc = accounts.get(key)
      if (acc) {
        acc.label = label
        acc.lastSeen = now
        if (wallet) acc.walletVerified = true
        markDirty()
        touch(acc.key)
      }
      if (moved > 0) log('info', `linked this period's device INK to ${wallet!.slice(0, 4)}…${wallet!.slice(-4)}: ${round2(moved)} INK`)
      safeSend(conn, { t: 'neuron.ok', neuron: { ...existing.info, ink: round2(existing.info.ink) }, auth: authState })
      neuronsChanged()
      return
    }

    if (peers.size >= MAX_NEURONS) {
      refuse(conn, 'neuron pool is full — try again shortly')
      return
    }
    let fromIp = 0
    for (const p of peers.values()) if (p.ip === ip) fromIp++
    if (fromIp >= MAX_NEURONS_PER_IP) {
      refuse(conn, `too many neurons from this address (max ${MAX_NEURONS_PER_IP}) — retry in 60 s`)
      return
    }

    rejoined(strikeKey)
    const moved = wallet && device ? linkDevice(device, wallet, ip, now) : 0
    const acc = accounts.get(key)
    if (acc) {
      acc.label = label
      acc.lastSeen = now
      if (wallet) acc.walletVerified = true
      markDirty()
      touch(acc.key)
    }

    const info: NeuronInfo = {
      id: conn.id,
      label,
      zone: 'EPI',
      gflops: claimed,
      jobs: 0,
      verified: 0,
      failed: 0,
      ink: 0,
      wallet,
      connectedAt: now,
      kind,
    }
    const peer: Peer = {
      conn,
      info,
      ip,
      account: key,
      accountKind: accKind,
      accountSetAt: now,
      strikeKey,
      claimed,
      claimedIdx,
      rampIdx: 0,
      pending: null,
      wants: false,
      requestedAt: 0,
      timer: null,
      lastIssueAt: 0,
      warned: false,
      warnedAccount: false,
      cpu: (adapter?.backend?.toLowerCase() ?? '').startsWith('cpu'),
      trainCap: false,
      trainCpu: false,
      trainVersion: null,
      pendingTrain: null,
      issuing: false,
      trainNullUntil: 0,
    }
    identOf(idents, strikeKey).lastAt = now
    refreshInfo(peer)
    peers.set(conn.id, peer)
    safeSend(conn, { t: 'neuron.ok', neuron: { ...info }, auth: authState })
    log(
      'info',
      `+ neuron ${label} · claims ${zoneAt(claimedIdx)} (${claimed} GFLOPS) · ink zone ${info.zone}` +
        `${wallet ? ` · verified ${wallet.slice(0, 4)}…${wallet.slice(-4)}` : authState === 'invalid' ? ' · invalid auth token (INK stays on the device)' : ''}` +
        `${moved > 0 ? ` · linked ${round2(moved)} period INK` : ''}`,
    )
    neuronsChanged()
  }

  // ── account watches ──

  /**
   * What a watcher sees of one ledger account (no label / link / network fields), null when there
   * is none. Escrow never creates an account (a confirm does), so a key holding only pending
   * training credits gets a zero view carrying them.
   */
  function accountView(key: string): AccountView | null {
    const a = accounts.get(key)
    if (!a) {
      const kind = key.startsWith('wallet:') ? 'wallet' : key.startsWith('device:') ? 'device' : null
      const pending = kind ? pendingInkOf(key) : 0
      if (!kind || !(pending > 0)) return null
      return {
        kind,
        wallet: kind === 'wallet' ? key.slice('wallet:'.length) : null,
        ink: 0,
        pendingInk: round2(pending),
        periodInk: 0,
        jobs: 0,
        verified: 0,
        failed: 0,
        flops: 0,
        firstSeen: 0,
        lastSeen: 0,
      }
    }
    if (a.kind !== 'wallet' && a.kind !== 'device') return null
    return {
      kind: a.kind,
      wallet: a.kind === 'wallet' ? a.wallet : null,
      ink: round2(a.ink),
      pendingInk: round2(pendingInkOf(key)),
      periodInk: round6(a.periodInk ?? 0),
      jobs: a.jobs,
      verified: a.verified,
      failed: a.failed,
      flops: a.flops,
      firstSeen: a.firstSeen,
      lastSeen: a.lastSeen,
    }
  }

  /** An account (or its escrow) changed: queue a push for the connections watching it. O(1) when nobody does. */
  function touch(key: string | null | undefined) {
    if (!key || !watchedKeys.has(key)) return
    dirtyKeys.add(key)
    if (watchFlushTimer || stopped) return
    watchFlushTimer = setTimeout(flushWatches, ACCOUNT_FLUSH_MS)
    watchFlushTimer.unref?.()
  }

  type AccountMsg = Extract<ServerMsg, { t: 'account' }>

  /**
   * One watcher's message: its account, plus for a wallet watch that also named a device the
   * device's own account. `views` caches the accounts read during one flush.
   */
  function sendAccount(w: AccountWatch, now: number, views?: Map<string, AccountView | null>) {
    const view = (key: string): AccountView | null => {
      if (!views) return accountView(key)
      if (!views.has(key)) views.set(key, accountView(key))
      return views.get(key) ?? null
    }
    w.lastSentAt = now
    const msg: AccountMsg = { t: 'account', scope: w.scope, account: w.key ? view(w.key) : null, at: now }
    if (w.devKey) msg.device = view(w.devKey)
    safeSend(w.conn, msg)
  }

  /** Each touched key is read once; a watcher pushed less than ACCOUNT_PUSH_MIN_MS ago gets a trailing push instead. */
  function flushWatches() {
    watchFlushTimer = null
    try {
      if (stopped) return
      const now = Date.now()
      const keys = [...dirtyKeys]
      dirtyKeys.clear()
      const views = new Map<string, AccountView | null>()
      const seen = new Set<AccountWatch>() // a watcher of two touched keys gets one message
      for (const key of keys) {
        const set = watchedKeys.get(key)
        if (!set) continue
        for (const w of set) {
          if (seen.has(w)) continue
          seen.add(w)
          if (w.timer) continue // a trailing push is already due; it reads the account when it fires
          const wait = w.lastSentAt + ACCOUNT_PUSH_MIN_MS - now
          if (wait > 0) {
            trailingPush(w, wait)
            continue
          }
          sendAccount(w, now, views)
        }
      }
    } catch (e) {
      log('error', `account push: ${(e as Error)?.message ?? e}`)
    }
  }

  function trailingPush(w: AccountWatch, ms: number) {
    w.timer = setTimeout(() => {
      w.timer = null
      try {
        if (stopped || watches.get(w.conn.id) !== w || !w.key) return
        sendAccount(w, Date.now())
      } catch (e) {
        log('error', `account push: ${(e as Error)?.message ?? e}`)
      }
    }, Math.max(0, ms))
    w.timer.unref?.()
  }

  function linkWatchKey(w: AccountWatch, key: string) {
    let set = watchedKeys.get(key)
    if (!set) watchedKeys.set(key, (set = new Set()))
    set.add(w)
  }

  function unlinkWatchKey(w: AccountWatch, key: string) {
    const set = watchedKeys.get(key)
    if (!set) return
    set.delete(w)
    if (!set.size) {
      watchedKeys.delete(key)
      dirtyKeys.delete(key)
    }
  }

  function unlinkWatch(w: AccountWatch) {
    if (w.key) unlinkWatchKey(w, w.key)
    if (w.devKey) unlinkWatchKey(w, w.devKey)
    w.key = null
    w.devKey = null
  }

  /** Resolve a watch request like neuron.register resolves the ledger key, then answer it right away. */
  function applyWatch(w: AccountWatch, now: number) {
    const req = w.queued
    w.queued = null
    if (!req) return
    const claims = req.auth !== undefined && req.auth !== null && req.auth !== '' ? (opts.auth?.checkToken(req.auth) ?? null) : null
    const device = req.device !== null && DEVICE_ID_RE.test(req.device) ? req.device : null
    let scope: AccountWatch['scope'] = null
    let key: string | null = null
    if (claims?.wallet) {
      scope = 'wallet'
      key = `wallet:${claims.wallet}`
    } else if (device) {
      scope = 'device'
      key = `device:${device}`
    }
    // A wallet watch also follows the device it came from: credits earned there before the
    // wallet was verified stay on the device account.
    const devKey = scope === 'wallet' && device ? `device:${device}` : null
    if (w.key !== key || w.devKey !== devKey) {
      unlinkWatch(w)
      if (key) linkWatchKey(w, (w.key = key))
      if (devKey) linkWatchKey(w, (w.devKey = devKey))
    }
    w.scope = scope
    if (w.timer) {
      clearTimeout(w.timer) // this reply is fresher than the push that was due
      w.timer = null
    }
    sendAccount(w, now)
  }

  function refillWatchTokens(w: AccountWatch, now: number) {
    w.tokens = Math.min(WATCH_BURST, w.tokens + (now - w.tokensAt) / WATCH_REFILL_MS)
    w.tokensAt = now
  }

  /**
   * account.watch: any connection, registered or not. Malformed requests are ignored. Past the
   * per-connection burst the newest request is held and applied when the bucket refills.
   */
  function watch(conn: NeuronConn, msg: unknown) {
    const m = msg as { device?: unknown; auth?: unknown }
    const rawDevice = m.device === undefined || m.device === null ? null : m.device
    const rawAuth = m.auth
    if (rawDevice !== null && typeof rawDevice !== 'string') return
    if (rawAuth !== undefined && rawAuth !== null && typeof rawAuth !== 'string') return
    // Longer than any valid device id / session token: resolves as none. Only the bounded values
    // are held, so a held request costs a few hundred bytes whatever the frame size.
    const device = rawDevice !== null && rawDevice.length <= MAX_WATCH_DEVICE_LEN ? rawDevice : null
    const auth = typeof rawAuth === 'string' && rawAuth.length > MAX_WATCH_AUTH_LEN ? null : rawAuth
    const now = Date.now()
    const cur: AccountWatch = watches.get(conn.id) ?? { conn, scope: null, key: null, devKey: null, lastSentAt: 0, timer: null, tokens: WATCH_BURST, tokensAt: now, queued: null, queueTimer: null }
    watches.set(conn.id, cur)
    cur.queued = { device, auth }
    if (cur.queueTimer) return // already held: the newest request wins when the bucket refills
    refillWatchTokens(cur, now)
    if (cur.tokens >= 1) {
      cur.tokens -= 1
      applyWatch(cur, now)
      return
    }
    cur.queueTimer = setTimeout(() => {
      cur.queueTimer = null
      try {
        if (stopped || watches.get(cur.conn.id) !== cur) return
        const t = Date.now()
        refillWatchTokens(cur, t)
        cur.tokens = Math.max(0, cur.tokens - 1)
        applyWatch(cur, t)
      } catch (e) {
        log('error', `account.watch: ${(e as Error)?.message ?? e}`)
      }
    }, Math.ceil((1 - cur.tokens) * WATCH_REFILL_MS))
    cur.queueTimer.unref?.()
  }

  function dropWatch(connId: string) {
    const w = watches.get(connId)
    if (!w) return
    watches.delete(connId)
    unlinkWatch(w)
    if (w.timer) clearTimeout(w.timer)
    if (w.queueTimer) clearTimeout(w.queueTimer)
    w.timer = null
    w.queueTimer = null
    w.queued = null
  }

  // ── public API ──

  function handle(conn: NeuronConn, msg: ClientMsg) {
    if (stopped || !conn || typeof conn.id !== 'string') return
    try {
      if (!msg || typeof msg !== 'object') return
      switch (msg.t) {
        case 'neuron.register':
          register(conn, msg)
          return
        case 'job.request': {
          const peer = peers.get(conn.id)
          if (!peer) {
            safeSend(conn, { t: 'error', msg: 'register as a neuron first (neuron.register)' })
            return
          }
          const caps = (msg as { caps?: unknown }).caps as { train?: unknown; version?: unknown; cpu?: unknown } | undefined
          peer.trainCap = !!caps && typeof caps === 'object' && caps.train === true
          peer.trainCpu = !!caps && typeof caps === 'object' && caps.cpu === true
          const v = caps && typeof caps === 'object' ? caps.version : null
          peer.trainVersion = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
          if (peer.pending || peer.pendingTrain) return // one job at a time; the outstanding one is still valid
          if (!peer.wants) {
            peer.wants = true
            peer.requestedAt = Date.now()
          }
          pump(peer)
          return
        }
        case 'job.result': {
          const peer = peers.get(conn.id)
          if (!peer) {
            safeSend(conn, { t: 'error', msg: 'register as a neuron first (neuron.register)' })
            return
          }
          onResult(peer, (msg as { result?: unknown }).result)
          return
        }
        case 'train.result': {
          const peer = peers.get(conn.id)
          if (!peer) {
            safeSend(conn, { t: 'error', msg: 'register as a neuron first (neuron.register)' })
            return
          }
          onTrainResult(peer, (msg as { result?: unknown }).result)
          return
        }
        case 'neuron.leave':
          if (remove(conn.id, 'abandoned — left with a job outstanding')) log('info', `- neuron ${conn.id} left`)
          return
        case 'account.watch':
          watch(conn, msg)
          return
        default:
          return // 'ping' and anything unknown
      }
    } catch (e) {
      log('error', `handle(${(msg as { t?: unknown })?.t}) failed: ${(e as Error)?.stack ?? e}`)
    }
  }

  function disconnect(conn: NeuronConn) {
    try {
      if (!conn || typeof conn.id !== 'string') return
      dropWatch(conn.id)
      // Cooldowns live on the identity / ip records and are never cleared here. A job left
      // outstanding is scored as abandoned once the grace runs out (deferAbandoned).
      const peer = peers.get(conn.id)
      const jobs: Abandoned['jobs'] = []
      if (peer?.pending) jobs.push({ id: peer.pending.id })
      if (peer?.pendingTrain) jobs.push({ id: peer.pendingTrain.id, kind: 'train' })
      if (remove(conn.id, null)) {
        if (peer && jobs.length) deferAbandoned(peer, jobs)
        log('info', `- neuron ${conn.id} disconnected`)
      }
    } catch (e) {
      log('error', `disconnect failed: ${(e as Error).message}`)
    }
  }

  /**
   * A socket closed with a job outstanding. A reload or a dropped connection is not a failed job:
   * when the same identity registers again within the grace, the job is not scored (rejoined).
   * Otherwise it counts as abandoned, with the strike, as before. Leaving with neuron.leave is
   * scored at once.
   */
  function deferAbandoned(peer: Peer, jobs: Abandoned['jobs']) {
    const reason = 'abandoned — disconnected with a job outstanding'
    if (abandonedCount >= MAX_ABANDONED || rejoinGraceMs <= 0) {
      for (const job of jobs) recordFailure(peer, job, reason)
      return
    }
    const key = peer.strikeKey
    // Already back on another socket (the old one was only reaped now): nothing to wait for.
    for (const p of peers.values()) {
      if (p.strikeKey !== key) continue
      log('info', `${key} is registered on another socket: ${jobs.length} job${jobs.length === 1 ? '' : 's'} left by its closed socket not scored`)
      return
    }
    const entry: Abandoned = {
      peer,
      jobs,
      timer: setTimeout(() => {
        try {
          if (!forgetAbandoned(key, entry)) return
          for (const job of entry.jobs) recordFailure(entry.peer, job, reason)
        } catch (e) {
          log('error', `abandoned job: ${(e as Error)?.message ?? e}`)
        }
      }, rejoinGraceMs),
    }
    entry.timer.unref?.()
    let set = abandoned.get(key)
    if (!set) abandoned.set(key, (set = new Set()))
    set.add(entry)
    abandonedCount++
  }

  function forgetAbandoned(key: string, entry: Abandoned): boolean {
    const set = abandoned.get(key)
    if (!set?.delete(entry)) return false
    if (!set.size) abandoned.delete(key)
    abandonedCount--
    return true
  }

  /** The identity registered again: jobs its closed sockets left are not scored. */
  function rejoined(strikeKey: string) {
    const set = abandoned.get(strikeKey)
    if (!set) return
    let n = 0
    for (const entry of [...set]) {
      clearTimeout(entry.timer)
      forgetAbandoned(strikeKey, entry)
      n += entry.jobs.length
    }
    if (n > 0) log('info', `${strikeKey} registered again: ${n} job${n === 1 ? '' : 's'} left by its closed socket not scored`)
  }

  function stats() {
    let gflops = 0
    for (const p of peers.values()) gflops += effectiveGflops(p)
    return {
      neurons: peers.size,
      gflops: Math.round(gflops * 10) / 10,
      jobsDone: totals.jobsDone,
      jobsVerified: totals.jobsVerified,
      inkIssued: round2(totals.inkIssued),
    }
  }

  async function stop() {
    if (stopped) return
    stopped = true
    clearInterval(heartbeat)
    clearInterval(saver)
    if (neuronsTimer) clearTimeout(neuronsTimer)
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    if (watchFlushTimer) clearTimeout(watchFlushTimer)
    watchFlushTimer = null
    for (const id of [...watches.keys()]) dropWatch(id)
    for (const set of abandoned.values()) for (const entry of set) clearTimeout(entry.timer)
    abandoned.clear()
    abandonedCount = 0
    for (const p of peers.values()) {
      if (p.timer) clearTimeout(p.timer)
      if (p.pending) settle(p.pending, false)
      if (p.pendingTrain) clearTimeout(p.pendingTrain.timer)
      p.timer = null
      p.pending = null
      p.pendingTrain = null
    }
    if (saving) await saving
    await saveLedger(true)
    await issuance.close()
  }

  return {
    handle,
    disconnect,
    neurons: neuronList,
    stats,
    stop,
    flushSync,
    ledger: () => ({ updatedAt: Date.now(), totals: { ...totals, inkIssued: round2(totals.inkIssued), inkPending: round2(totals.inkPending), inkForfeited: round2(totals.inkForfeited) }, leaderboard: leaderboard() }),
    balance: (walletOrKey: string) => {
      const q = typeof walletOrKey === 'string' ? walletOrKey.trim() : ''
      if (!q) return null
      const evm = EVM_ADDR_RE.test(q) ? q.toLowerCase() : null
      const a = accounts.get(q) ?? accounts.get(`wallet:${evm ?? q}`)
      if (!a) return null
      const pendingInk = pendingInkOf(a.key)
      const { linkedTo: _l, linkedPeriod: _p, earnNet: _n, ...pub } = a
      void _l
      void _p
      void _n
      const out: LedgerAccount = { ...pub, key: publicKey(a.key), ink: round2(a.ink) }
      if (out.periodInk !== undefined) out.periodInk = round6(out.periodInk)
      if (pendingInk > 0) out.pendingInk = round2(pendingInk)
      return out
    },
    limits: () => ({ ...limits }),
    linkDevice: (token: unknown, deviceId: unknown, ip: string) => {
      if (stopped || typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) return null
      if (typeof token !== 'string' || !token) return null
      const wallet = opts.auth?.checkToken(token)?.wallet ?? null
      if (!wallet) return null
      const moved = linkDevice(deviceId, wallet, typeof ip === 'string' && ip ? ip : 'unknown', Date.now())
      if (moved > 0) log('info', `linked this period's device INK to ${wallet.slice(0, 4)}…${wallet.slice(-4)} at sign-in: ${round2(moved)} INK`)
      return { wallet, ink: round2(moved) }
    },
    payouts: payoutLedger,
  }
}
