// Self-checks for the neuron coordinator and the hub.
//
//   npx tsx server/neurons/_test.ts        unit + coordinator integration
//   npx tsx server/neurons/_test.ts e2e    + full HTTP/WS run against stub modules
//
// Exits non-zero on the first failed assertion.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { WebSocket } from 'ws'
import { bestMatchesCPU, VEC_DIM } from '../../shared/vectorize.ts'
import { b64ToF32, f32ToB64 } from '../../shared/b64.ts'
import type { AgentInfo, Hello, InkEvent, NeuronInfo, ServerMsg, SimJob, TrainJob } from '../../shared/protocol.ts'
import type { NeuronConn } from '../contracts.ts'
import { zoneFor } from '../../shared/protocol.ts'
import {
  accountNetKey,
  bonusZoneFor,
  createCoordinator,
  encodeF32,
  inkFor,
  measuredGflops,
  pickCheckRows,
  resolveLimits,
  sanitizeWallet,
  validateResultShape,
  verifySimResult,
  type VerifiableJob,
} from './coordinator.ts'
import { createIssuanceLog, hashId, loadHashSalt } from './issuance.ts'
import { createStubCrawler, createStubTrainer } from './_stubs.ts'
import { createAuth } from '../auth/auth.ts'
import { base58Encode } from '../../shared/base58.ts'

/** Valid Solana addresses (32 bytes, base58) for wallet-linked registers. */
const W1 = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 255))
const W2 = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 5) & 255))
const W3 = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + 11) & 255))
const testAuth = (dataDir: string) => createAuth({ dataDir, secret: 'lusca-test-secret-0123456789abcdef', log: () => undefined })

let passed = 0
function ok(cond: unknown, what: string): asserts cond {
  if (!cond) {
    console.error(`FAIL  ${what}`)
    process.exit(1)
  }
  passed++
  console.log(`ok    ${what}`)
}

// Coordinator timers are unref'd (they must not hold a server open); keep the loop alive while testing.
const keepAlive = setInterval(() => undefined, 1000)

function randUnit(n: number, dim: number, seed: number): Float32Array {
  let s = seed
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1
  const out = new Float32Array(n * dim)
  for (let i = 0; i < n; i++) {
    let norm = 0
    for (let k = 0; k < dim; k++) norm += (out[i * dim + k] = r()) ** 2
    norm = Math.sqrt(norm)
    for (let k = 0; k < dim; k++) out[i * dim + k] /= norm
  }
  return out
}

function solve(job: VerifiableJob) {
  const ref = bestMatchesCPU(job.a, job.b, job.rows, job.cols, job.dim)
  return { best: ref.best.slice(), sim: ref.sim.slice() }
}

// ─── 1. pure verification ───────────────────────────────────────────────────

function unit() {
  const dim = VEC_DIM
  const rows = 12
  const cols = 300
  const job: VerifiableJob = { a: randUnit(rows, dim, 1), b: randUnit(cols, dim, 2), rows, cols, dim }
  const all = Array.from({ length: rows }, (_, i) => i)
  const good = solve(job)

  ok(validateResultShape({ id: 'x', ...good, ms: 3 }, rows, cols) === null, 'shape: correct result validates')
  ok(verifySimResult(job, good, all).ok, 'verify: exact CPU result passes (all rows)')
  ok(verifySimResult(job, good, pickCheckRows(rows)).checked === 4, 'verify: spot-check uses 4 rows when rows > 4')
  ok(pickCheckRows(3).length === 3, 'pickCheckRows: all rows when rows <= 4')
  ok(new Set(pickCheckRows(1000)).size === 4, 'pickCheckRows: 4 distinct rows')

  // f32 GPU rounding noise well inside the tolerance still passes
  const noisy = { best: good.best.slice(), sim: good.sim.map((s) => Math.fround(s) + 4e-4) }
  ok(verifySimResult(job, noisy, all).ok, 'verify: sims within 2e-3 pass')

  // corrupt one similarity
  const badSim = { best: good.best.slice(), sim: good.sim.slice() }
  badSim.sim[7] += 0.21
  const v1 = verifySimResult(job, badSim, all)
  ok(!v1.ok && v1.failRow === 7 && Math.abs(v1.delta - 0.21) < 1e-6, 'verify: corrupted sim fails on row 7 with Δ 0.21')

  // claim a different (non-tied) best index but keep the right sim value
  const badIdx = { best: good.best.slice(), sim: good.sim.slice() }
  badIdx.best[3] = (badIdx.best[3] + 1) % cols
  ok(!verifySimResult(job, badIdx, all).ok, 'verify: wrong best index fails')

  // NaN never passes
  const nan = { best: good.best.slice(), sim: good.sim.slice() }
  nan.sim[0] = Number.NaN
  ok(!verifySimResult(job, nan, all).ok, 'verify: NaN similarity fails')

  // ties: duplicate a column so two indices share the best similarity
  const b2 = new Float32Array(job.b)
  const tieRow = 5
  const tBest = good.best[tieRow]
  const other = (tBest + 17) % cols
  b2.set(job.b.subarray(tBest * dim, (tBest + 1) * dim), other * dim)
  const tieJob = { ...job, b: b2 }
  const tieRes = solve(tieJob)
  const alt = { best: tieRes.best.slice(), sim: tieRes.sim.slice() }
  alt.best[tieRow] = tieRes.best[tieRow] === tBest ? other : tBest
  ok(verifySimResult(tieJob, alt, all).ok, 'verify: tied best index (either duplicate column) passes')

  // shape errors
  ok(validateResultShape({ best: good.best.slice(1), sim: good.sim }, rows, cols) !== null, 'shape: wrong row count rejected')
  ok(validateResultShape({ best: good.best.map(() => cols), sim: good.sim }, rows, cols) !== null, 'shape: out-of-range index rejected')
  ok(validateResultShape({ best: good.best.map(() => 1.5), sim: good.sim }, rows, cols) !== null, 'shape: fractional index rejected')
  ok(validateResultShape({ best: good.best, sim: good.sim.map(() => 'x') }, rows, cols) !== null, 'shape: non-numeric sim rejected')
  ok(validateResultShape(null, rows, cols) !== null, 'shape: null rejected')

  // encoding parity with the shared helper (the neuron decodes with b64ToF32)
  const enc = randUnit(64, dim, 9)
  ok(encodeF32(enc) === f32ToB64(enc), 'encodeF32 is byte-identical to f32ToB64')
  const round = b64ToF32(encodeF32(enc.subarray(dim, 3 * dim)))
  ok(round.length === 2 * dim && round[0] === enc[dim], 'encodeF32 respects subarray offsets')

  ok(inkFor(2 * 16 * 512 * 256, 0) === 0.04, 'ink: EPI full job = 0.04')
  ok(inkFor(2 * 256 * 8192 * 256, 4) === 17.18, 'ink: HADAL full job = 17.18')
  ok(inkFor(10, 0) === 0.01, 'ink: verified work earns at least 0.01')

  // INK bonus zone: claimed is only an upper bound; MESO cap until 3 jobs are measured
  ok(bonusZoneFor(200_000, 0, 0) === 'MESO', 'bonus zone: unmeasured HADAL claim capped at MESO')
  ok(bonusZoneFor(50, 0, 0) === 'EPI', 'bonus zone: unmeasured EPI claim stays EPI')
  ok(bonusZoneFor(200_000, 5, 3) === zoneFor(200_000), 'bonus zone: proven GPU speed on large jobs -> claimed zone')
  ok(bonusZoneFor(200_000, 1.5, 3) === 'MESO', 'bonus zone: CPU-like speed on large jobs -> capped at MESO')
  ok(bonusZoneFor(200_000, 5, 1) === 'MESO', 'bonus zone: too few large jobs -> capped at MESO')
  ok(bonusZoneFor(2_000, 1_000, 3) === zoneFor(2_000), 'bonus zone: never above the claim')
  ok(Math.abs(measuredGflops(2e9, 1000) - 2) < 1e-9, 'measured GFLOPS = flops / (rtt ms x 1e6)')

  // wallets: Solana base58 (32–44) or EVM 0x + 40 hex only
  ok(sanitizeWallet('So1anaWa11etAddre55xxxxxxxxxxxxxxxxxxxx') === 'So1anaWa11etAddre55xxxxxxxxxxxxxxxxxxxx', 'wallet: Solana base58 accepted')
  ok(sanitizeWallet('  7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU ') === '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'wallet: trimmed 44-char Solana accepted')
  ok(sanitizeWallet('0x52908400098527886E0F7030069857D2E4169EE7') === '0x52908400098527886e0f7030069857d2e4169ee7', 'wallet: EVM accepted and lowercased (one account per address)')
  ok(sanitizeWallet('0x52908400098527886E0F7030069857D2E4169EE') === null, 'wallet: EVM with 39 hex digits rejected')
  ok(sanitizeWallet('So1anaWa11etAddre55xxxxxxxxxxxxxxxxxxx0') === null, 'wallet: base58 excludes 0 / O / I / l')
  ok(sanitizeWallet('short1234') === null && sanitizeWallet('x'.repeat(45)) === null, 'wallet: too short / too long rejected')
  ok(sanitizeWallet('claim-airdrop-at-evil.example') === null && sanitizeWallet('wallet:So1anaWa11etAddre55xxxxxxxxxxxxxxxxxxxx') === null, 'wallet: free text / prefixed keys rejected')
  ok(sanitizeWallet(42) === null && sanitizeWallet(null) === null, 'wallet: non-strings rejected')

  // new-account rate key: IPv4 address, IPv6 /56
  ok(accountNetKey('203.0.113.7') === 'ip4:203.0.113.7' && accountNetKey('::ffff:203.0.113.7') === 'ip4:203.0.113.7', 'net key: IPv4 (plain / mapped)')
  const k56 = accountNetKey('2001:db8:1:200::/64')
  ok(k56 === 'ip6:2001:db8:1:200::/56', `net key: IPv6 /64 → /56 (${k56})`)
  ok(accountNetKey('2001:db8:1:2ff::/64') === k56 && accountNetKey('[2001:db8:1:2a0:dead:beef:1:2]') === k56, 'net key: every /64 of one /56 shares the key')
  ok(accountNetKey('2001:db8:1:300::/64') !== k56 && accountNetKey('2001:db8:2:200::/64') !== k56, 'net key: other /56s differ')
  ok(accountNetKey('unknown') === 'ip:unknown' && accountNetKey('') === 'ip:unknown', 'net key: non-IP input passes through')

  // limits from env
  const d = resolveLimits({})
  ok(d.issueBytesPerSec === 2 * 1024 * 1024 && d.jobFillWaitMs === 30_000 && d.neuronsTop === 50, 'limits: defaults 2 MB/s, 30 s fill wait, top 50 neurons')
  ok(d.maxAccounts === 50_000 && d.accountIdleMs === 7 * 86_400_000 && d.newAccountsPerHour === 30, 'limits: defaults 50k accounts, 7 d idle, 30 new accounts/h')
  ok(d.maxPendingBytes === 64 * 1024 * 1024 && d.issuanceLogBytes === 50 * 1024 * 1024 && d.issuanceLogKeep === 10, 'limits: defaults 64 MB pending, 50 MB log, keep 10')
  const warns: string[] = []
  const e = resolveLimits({ LUSCA_ISSUE_MB_PER_SEC: '0.5', LUSCA_NEURONS_TOP: 'lots', LUSCA_JOB_FILL_WAIT_S: '-4', LUSCA_ISSUANCE_LOG_MB: '0' }, { maxAccounts: 7 }, (m) => warns.push(m))
  ok(e.issueBytesPerSec === 512 * 1024 && e.jobFillWaitMs === 0 && e.issuanceLogBytes === 0, 'limits: env parsed and clamped')
  ok(e.neuronsTop === 50 && warns.length === 1 && /LUSCA_NEURONS_TOP/.test(warns[0]), 'limits: invalid number → default + warning')
  ok(e.maxAccounts === 7, 'limits: programmatic overrides win')

  // salted identifier hashes
  const salt = Buffer.from('test-salt')
  ok(/^[0-9a-f]{16}$/.test(hashId(salt, 'ip', '203.0.113.7')) && hashId(salt, 'ip', '203.0.113.7') === hashId(salt, 'ip', '203.0.113.7'), 'hashId: 16 hex chars, deterministic')
  ok(hashId(salt, 'ip', 'x') !== hashId(salt, 'acct', 'x') && hashId(salt, 'ip', 'x') !== hashId(Buffer.from('other'), 'ip', 'x'), 'hashId: depends on scope and salt')
}

function sameVec(a: Float32Array, ai: number, b: Float32Array, bi: number, dim: number): boolean {
  for (let k = 0; k < dim; k++) if (a[ai * dim + k] !== b[bi * dim + k]) return false
  return true
}

/** No row vector of the job appears among its columns (a page is never compared with itself). */
function rowsNotInCols(j: VerifiableJob): boolean {
  for (let r = 0; r < j.rows; r++) for (let c = 0; c < j.cols; c++) if (sameVec(j.a, r, j.b, c, j.dim)) return false
  return true
}

// ─── 2. coordinator over a fake connection ──────────────────────────────────

interface FakeConn extends NeuronConn {
  inbox: ServerMsg[]
  next<T extends ServerMsg['t']>(t: T, timeoutMs?: number): Promise<T extends 'job' ? { t: 'job'; job: SimJob } : Extract<ServerMsg, { t: T }>>
  /** First message of any of the given types (one waiter, removed when it settles). */
  nextOf(ts: ServerMsg['t'][], timeoutMs?: number): Promise<ServerMsg>
}

function fakeConn(id: string, ip?: string): FakeConn {
  const inbox: ServerMsg[] = []
  const waiters: { ts: string[]; resolve: (m: ServerMsg) => void }[] = []
  const nextOf = (ts: string[], timeoutMs = 5000): Promise<ServerMsg> => {
    const i = inbox.findIndex((m) => ts.includes(m.t))
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const w = { ts, resolve: (m: ServerMsg) => (clearTimeout(timer), resolve(m)) }
      const timer = setTimeout(() => {
        const k = waiters.indexOf(w)
        if (k >= 0) waiters.splice(k, 1)
        reject(new Error(`timeout waiting for ${ts.join('|')}`))
      }, timeoutMs)
      waiters.push(w)
    })
  }
  return {
    id,
    ip,
    inbox,
    send(msg) {
      const w = waiters.findIndex((x) => x.ts.includes(msg.t))
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg)
      else inbox.push(msg)
    },
    nextOf,
    next(t, timeoutMs = 5000) {
      return nextOf([t], timeoutMs) as never
    },
  }
}

function decodeJob(j: SimJob | TrainJob): VerifiableJob {
  const job = j as SimJob
  return { a: b64ToF32(job.a), b: b64ToF32(job.b), rows: job.rows, cols: job.cols, dim: job.dim }
}

async function coordinatorFlow() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-coord-'))
  const crawler = createStubCrawler({ initialPages: 0 })
  const broadcasts: ServerMsg[] = []
  const auth = testAuth(dataDir)
  const tok1 = auth.issueToken(W1).token
  const coord = createCoordinator({ crawler, emit: (m) => broadcasts.push(m), dataDir, log: () => undefined, auth })
  const conn = fakeConn('neuron-test-1')
  const inks = () => broadcasts.filter((m): m is { t: 'ink'; event: InkEvent } => m.t === 'ink').map((m) => m.event)

  coord.handle(conn, { t: 'job.request' })
  ok((await conn.next('error')).msg.includes('register'), 'job.request before register → error')

  coord.handle(conn, { t: 'neuron.register', label: 'Test GPU', zone: 'HADAL', gflops: 50, kind: 'browser', wallet: W1, adapter: { vendor: 'test' }, auth: tok1 })
  const reg = await conn.next('neuron.ok')
  ok(reg.neuron.zone === 'EPI' && reg.neuron.gflops === 50, 'register: zone re-derived from gflops (client claimed HADAL)')
  ok(reg.auth === 'verified' && reg.neuron.wallet === W1, 'register: valid session token → auth verified, INK goes to the wallet')
  ok(coord.stats().neurons === 1 && coord.stats().gflops === 50, 'stats: 1 neuron, 50 GFLOPS')
  ok(coord.balance(W1) === null, 'no ledger account is created at register (only on the first verified job)')

  // only a session token links a wallet: free text, bare addresses and bad tokens register as "no wallet"
  const cw = fakeConn('wallet-check')
  coord.handle(cw, { t: 'neuron.register', label: 'W', zone: 'EPI', gflops: 10, kind: 'browser', wallet: 'claim-airdrop-at-evil.example', adapter: {} })
  const rw = await cw.next('neuron.ok')
  ok(rw.neuron.wallet === null && rw.auth === 'none', 'register: free-text wallet is dropped (treated as no wallet)')
  coord.handle(cw, { t: 'neuron.leave' })
  const ce = fakeConn('wallet-check-bare')
  coord.handle(ce, { t: 'neuron.register', label: 'W', zone: 'EPI', gflops: 10, kind: 'browser', wallet: W2, adapter: {} })
  const re = await ce.next('neuron.ok')
  ok(re.neuron.wallet === null && re.auth === 'none', 'register: bare wallet without a token is ignored (auth none)')
  coord.handle(ce, { t: 'neuron.leave' })
  const cb = fakeConn('wallet-check-badtoken')
  const forged = tok1.slice(0, -2) + (tok1.endsWith('AA') ? 'BB' : 'AA')
  coord.handle(cb, { t: 'neuron.register', label: 'W', zone: 'EPI', gflops: 10, kind: 'browser', wallet: W1, adapter: {}, auth: forged })
  const rb = await cb.next('neuron.ok')
  ok(rb.neuron.wallet === null && rb.auth === 'invalid', 'register: tampered token → auth invalid, no wallet')
  coord.handle(cb, { t: 'neuron.leave' })
  const otherAuth = createAuth({ dataDir: path.join(dataDir, 'other'), secret: 'another-secret-abcdefghijklmnop', log: () => undefined })
  coord.handle(cb, { t: 'neuron.register', label: 'W', zone: 'EPI', gflops: 10, kind: 'browser', wallet: W1, adapter: {}, auth: otherAuth.issueToken(W1).token })
  ok((await cb.next('neuron.ok')).auth === 'invalid', 'register: token signed with another secret → auth invalid')
  coord.handle(cb, { t: 'neuron.leave' })

  // empty corpus → warm-up error, then the job arrives on its own once pages exist
  coord.handle(conn, { t: 'job.request' })
  ok((await conn.next('error')).msg === 'corpus warming up', 'empty corpus → "corpus warming up"')
  crawler.addPages(5)
  const small = (await conn.next('job', 6000)).job
  ok(small.rows >= 1 && small.cols >= 1 && small.rows <= 4 && small.cols <= 4, `small corpus (5) -> job of whatever exists (rows ${small.rows}, cols ${small.cols})`)
  ok(rowsNotInCols(decodeJob(small)), 'row pages are excluded from the column block')
  ok(small.rowIds.every((id, i) => id === `r${i}`) && small.colIds.every((id, i) => id === `c${i}`), 'wire carries positional placeholders, not page ids')
  ok(coord.balance(W1) === null, 'no ledger account while the first job is still unverified')
  coord.handle(conn, { t: 'job.result', result: { id: small.id, ...solve(decodeJob(small)), ms: 1 } })
  ok(inks().at(-1)?.verified === true, 'small job verified')
  ok((coord.balance(W1)?.ink ?? 0) > 0, 'ledger account created on the first verified job')
  ok(coord.payouts.isVerified(W1) && coord.payouts.periodInk(W1) === coord.balance(W1)!.ink, 'verified wallet: period INK tracks the INK earned this period')

  crawler.addPages(700) // includes planted near-duplicates
  let t0 = Date.now()
  coord.handle(conn, { t: 'job.request' })
  const j1 = (await conn.next('job')).job
  ok(j1.rows === 16 && j1.cols === 512 && j1.flops === 2 * 16 * 512 * 256, 'EPI job: 16 × 512 × 256')
  ok(j1.a.length === Math.ceil((16 * 256 * 4) / 3) * 4, 'job.a is base64 of rows*dim float32')
  coord.handle(conn, { t: 'job.result', result: { id: j1.id, ...solve(decodeJob(j1)), ms: 12 } })
  let ev = inks().at(-1)!
  ok(ev.verified && ev.ink === 0.04 && /^verified 4\/4 rows · 0\.004 GFLOP · 12 ms$/.test(ev.reason), `verified job → ink 0.04 ("${ev.reason}")`)

  // min spacing between jobs
  t0 = Date.now()
  coord.handle(conn, { t: 'job.request' })
  const j2 = (await conn.next('job')).job
  ok(Date.now() - t0 >= 100, `≥120 ms between jobs (waited ${Date.now() - t0} ms)`)
  const d1 = decodeJob(j1)
  const d2 = decodeJob(j2)
  const sameRows = j2.rows === j1.rows && Array.from({ length: j1.rows }, (_, r) => sameVec(d1.a, r, d2.a, r, 256)).every(Boolean)
  ok(sameRows && !sameVec(d1.b, 0, d2.b, 0, 256), 'coverage: the same rows continue on the next, uncovered column block')
  ok(rowsNotInCols(d2), 'coverage: rows never compared with themselves')

  // duplicate request while a job is outstanding is ignored
  coord.handle(conn, { t: 'job.request' })
  await new Promise((r) => setTimeout(r, 200))
  ok(!conn.inbox.some((m) => m.t === 'job'), 'no second job while one is outstanding')

  // semantic dups: the newest rows include planted near-duplicates (every 5th
  // stub page) of older pages; cycling the column cursor covers the corpus.
  for (let i = 0; i < 6; i++) {
    const job = i === 0 ? j2 : (coord.handle(conn, { t: 'job.request' }), (await conn.next('job')).job)
    coord.handle(conn, { t: 'job.result', result: { id: job.id, ...solve(decodeJob(job)), ms: 5 } })
  }
  const newest = new Set(crawler.newestVectors(16).ids)
  const planted = (id: string) => parseInt(id.slice(1), 16) % 5 === 0 && parseInt(id.slice(1), 16) > 10
  const plantedInRows = [...newest].filter(planted)
  const reported = new Set(crawler.dups.map((d) => d.pageId))
  ok(plantedInRows.length > 0 && plantedInRows.every((id) => reported.has(id)), `markSemanticDup reported every planted near-duplicate among the newest rows (${plantedInRows.filter((id) => reported.has(id)).length}/${plantedInRows.length}, ${crawler.dups.length} total)`)
  ok(crawler.dups.every((d) => d.sim >= 0.92 && d.pageId !== d.dupOfId && planted(d.pageId) && d.pageId > d.dupOfId), 'reported dups: sim >= 0.92, distinct ids, the newer (planted) page is the dup')
  ok(reported.size === crawler.dups.length, 'each dup page reported once across jobs')

  // stale result
  coord.handle(conn, { t: 'job.result', result: { id: 'nope', best: [], sim: [], ms: 1 } })
  ok((await conn.next('error')).msg.includes('expired'), 'unknown job id → error, not a failure')

  // three corrupted results → kicked
  const failsBefore = coord.neurons()[0].failed
  for (let i = 0; i < 3; i++) {
    coord.handle(conn, { t: 'job.request' })
    const job = (await conn.next('job')).job
    const res = solve(decodeJob(job))
    res.sim = res.sim.map((s) => s - 0.3) // every row wrong → any spot-check catches it
    coord.handle(conn, { t: 'job.result', result: { id: job.id, ...res, ms: 1 } })
    ev = inks().at(-1)!
    ok(!ev.verified && ev.ink === 0 && /^spot-check failed row \d+ \(Δ 0\.30\)$/.test(ev.reason), `corrupted result ${i + 1} fails ("${ev.reason}")`)
  }
  const kickMsg = await conn.next('error')
  ok(kickMsg.msg.includes('3 consecutive failed jobs'), 'after 3 consecutive failures → disconnect error')
  ok(coord.neurons().length === 0 && failsBefore === 0, 'neuron removed from the pool')
  coord.handle(conn, { t: 'neuron.register', label: 'Test GPU', zone: 'EPI', gflops: 50, kind: 'browser', wallet: null, adapter: {} })
  ok((await conn.next('error')).msg.includes('cooling down'), 're-register during cooldown is refused (same socket, other identity)')
  const conn1b = fakeConn('neuron-test-1b') // a brand-new socket with the same wallet
  coord.handle(conn1b, { t: 'neuron.register', label: 'Test GPU', zone: 'EPI', gflops: 50, kind: 'browser', wallet: W1, adapter: {}, auth: tok1 })
  ok((await conn1b.next('error')).msg.includes('cooling down'), 'cooldown survives reconnecting (keyed by wallet, not connection id)')

  // leave + re-register does not reset strikes; leaving with a job outstanding is a failure
  const c3 = fakeConn('neuron-test-3')
  const reg3 = { t: 'neuron.register' as const, label: 'Strike GPU', zone: 'EPI' as const, gflops: 10, kind: 'browser' as const, wallet: null, adapter: { deviceId: 'dev-strikes' } }
  coord.handle(c3, reg3)
  await c3.next('neuron.ok')
  coord.handle(c3, { t: 'job.request' })
  const s1 = (await c3.next('job')).job
  coord.handle(c3, { t: 'job.result', result: { id: s1.id, best: [], sim: [], ms: 1 } })
  ok(inks().at(-1)?.verified === false, 'strike 1 (malformed)')
  coord.handle(c3, { t: 'job.request' })
  const s2 = (await c3.next('job')).job
  coord.handle(c3, { t: 'neuron.leave' })
  ok(inks().at(-1)?.jobId === s2.id && /abandoned/.test(inks().at(-1)!.reason), 'leaving with a job outstanding counts as a failed job (strike 2)')
  coord.handle(c3, reg3)
  await c3.next('neuron.ok')
  coord.handle(c3, { t: 'job.request' })
  const s3 = (await c3.next('job')).job
  coord.handle(c3, { t: 'job.result', result: { id: s3.id, best: [], sim: [], ms: 1 } })
  ok((await c3.next('error')).msg.includes('3 consecutive failed jobs'), 'strikes survive leave + re-register (kicked on the 3rd)')

  // malformed result counts as failure; timeout path exercised via a second neuron
  const c2 = fakeConn('neuron-test-2')
  coord.handle(c2, { t: 'neuron.register', label: 'Big GPU', zone: 'EPI', gflops: 1e9, kind: 'desktop', wallet: null, adapter: { deviceId: 'dev-abcdef' } })
  const reg2 = await c2.next('neuron.ok')
  ok(reg2.neuron.gflops === 200000 && reg2.neuron.zone === 'MESO', 'gflops clamped to 200000; INK zone capped at MESO until measured')
  ok(coord.stats().gflops < 200000, `stats count an unmeasured claim only up to the MESO cap (${coord.stats().gflops})`)
  coord.handle(c2, { t: 'job.request' })
  const big = (await c2.next('job')).job
  ok(big.rows <= 16 && big.cols <= 512, `a HADAL claim still starts with an EPI-sized job (rows ${big.rows}, cols ${big.cols})`)
  coord.handle(c2, { t: 'job.result', result: { id: big.id, best: [1, 2], sim: [0.1, 0.2], ms: 1 } })
  ok(/^malformed result/.test(inks().at(-1)!.reason), 'malformed result → failed with reason')
  coord.handle(c2, { t: 'job.request' })
  const big2 = (await c2.next('job')).job
  coord.handle(c2, { t: 'job.result', result: { id: big2.id, ...solve(decodeJob(big2)), ms: 40 } })
  ev = inks().at(-1)!
  ok(ev.verified && ev.ink === inkFor(big2.flops, 1), `unmeasured HADAL claim is paid at most the MESO bonus (ink ${ev.ink}, "${ev.reason}")`)
  // ramp: one zone step per verified job while the measured throughput keeps up
  let maxRows = big2.rows
  for (let i = 0; i < 4; i++) {
    coord.handle(c2, { t: 'job.request' })
    const j = (await c2.next('job')).job
    maxRows = Math.max(maxRows, j.rows)
    coord.handle(c2, { t: 'job.result', result: { id: j.id, ...solve(decodeJob(j)), ms: 40 } })
    ok(inks().at(-1)?.verified === true, `ramp job ${i + 1}: ${j.rows}x${j.cols} verified`)
  }
  ok(maxRows > 16, `job size ramps up after verified jobs (largest ${maxRows} rows)`)
  const me2 = coord.neurons().find((n) => n.id === 'neuron-test-2')!
  // the test neuron answers on the CPU, so it never proves GPU-class speed on large jobs
  ok(me2.gflops === 200000 && me2.zone === 'MESO', `NeuronInfo shows the benchmark (${me2.gflops}) while the INK zone stays capped (${me2.zone}) without a GPU-speed proof`)
  ok(broadcasts.some((m) => m.t === 'neurons'), "'neurons' broadcasts emitted")

  const st = coord.stats()
  ok(st.jobsDone === st.jobsVerified + 7 && st.inkIssued > 0, `stats totals consistent (done ${st.jobsDone}, verified ${st.jobsVerified}, ink ${st.inkIssued})`)

  coord.disconnect(c2)
  ok(coord.neurons().length === 0, 'disconnect removes neuron')
  await coord.stop()
  const ledger = JSON.parse(fs.readFileSync(path.join(dataDir, 'ledger.json'), 'utf8'))
  ok(ledger.accounts[`wallet:${W1}`]?.ink > 0 && ledger.accounts[`wallet:${W1}`]?.walletVerified === true, 'ledger persisted the verified wallet balance')
  ok(ledger.accounts['device:dev-abcdef']?.ink > 0, 'ledger keyed by adapter.deviceId when no wallet')
  ok(Array.isArray(ledger.leaderboard) && ledger.leaderboard[0].rank === 1, 'ledger includes leaderboard')

  // raw device ids are never published (leaderboard / balance / broadcasts)
  const pub = JSON.stringify(coord.ledger())
  const devRow = coord.ledger().leaderboard.find((r) => r.key.startsWith('device:'))
  ok(!!devRow && /^device:[0-9a-f]{16}$/.test(devRow.key) && !pub.includes('dev-abcdef') && !pub.includes('dev-strikes'), `leaderboard keys hash device ids (${devRow?.key})`)
  ok(!JSON.stringify(ledger.leaderboard).includes('dev-abcdef'), 'persisted leaderboard carries hashed device keys too')
  const bal = coord.balance('device:dev-abcdef')
  ok(!!bal && bal.key === devRow!.key && bal.ink > 0, 'balance() by raw device key answers with the hashed public key')
  ok(!JSON.stringify(broadcasts).includes('dev-abcdef') && !JSON.stringify(broadcasts).includes('dev-strikes'), 'no broadcast carries a raw device id')

  // append-only issuance log: one line per verified job, identifiers hashed
  const logRaw = fs.readFileSync(path.join(dataDir, 'issuance.log'), 'utf8')
  const lines = logRaw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  const issued = lines.filter((l) => l.ev === 'issue')
  ok(issued.length === st.jobsVerified, `issuance.log has one line per verified job (${issued.length})`)
  ok(
    issued.every((l) => typeof l.ts === 'number' && typeof l.jobId === 'string' && /^[0-9a-f]{16}$/.test(String(l.acct)) && /^[0-9a-f]{16}$/.test(String(l.ip)) && typeof l.zone === 'string' && typeof l.flops === 'number' && typeof l.ink === 'number' && l.credited === true),
    'issuance lines: ts, jobId, hashed acct + ip, zone, flops, ink',
  )
  ok(Math.abs(issued.reduce((s, l) => s + (l.ink as number), 0) - st.inkIssued) < 0.05, 'issuance log INK sums to the issued total')
  ok(!logRaw.includes(W1) && !logRaw.includes('dev-abcdef') && !logRaw.includes('unknown'), 'issuance log holds no raw wallet / device id / ip')
  ok(fs.existsSync(path.join(dataDir, 'hash.salt')), 'hash salt persisted in the data dir')

  // restart: totals survive
  const coord2 = createCoordinator({ crawler, emit: () => undefined, dataDir, log: () => undefined })
  ok(coord2.stats().inkIssued === st.inkIssued && coord2.stats().jobsVerified === st.jobsVerified, 'INK totals survive restart')
  ok((coord2.balance(W1)?.ink ?? 0) > 0, 'balance() by wallet after restart')
  await coord2.stop()
  ok(fs.existsSync(path.join(dataDir, 'ledger.json.bak')), 'previous ledger kept as ledger.json.bak')

  // a corrupt ledger.json is moved aside and recovered from ledger.json.bak - never reset to zero
  fs.writeFileSync(path.join(dataDir, 'ledger.json'), '{"version":1,"tot')
  const coord3 = createCoordinator({ crawler, emit: () => undefined, dataDir, log: () => undefined })
  ok(coord3.stats().inkIssued > 0 && fs.readdirSync(dataDir).some((f) => f.startsWith('ledger.json.corrupt-')), `corrupt ledger.json recovered from the .bak (${coord3.stats().inkIssued} INK)`)
  await coord3.stop()
  // unreadable and no usable backup -> run without saving, never overwrite the file
  for (const f of fs.readdirSync(dataDir)) if (f.startsWith('ledger.json')) fs.rmSync(path.join(dataDir, f))
  fs.writeFileSync(path.join(dataDir, 'ledger.json'), 'garbage')
  const coord4 = createCoordinator({ crawler, emit: () => undefined, dataDir, log: () => undefined })
  ok(coord4.stats().inkIssued === 0, 'unrecoverable ledger -> starts empty in memory')
  coord4.flushSync()
  await coord4.stop()
  const left = fs.readdirSync(dataDir).filter((f) => f === 'ledger.json')
  ok(left.length === 0, 'unrecoverable ledger is moved aside and nothing new is written (saves disabled)')
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// --- 2a. payout periods: verified wallets, device linking, close / carry-over / recovery ---

async function payoutLedgerFlow() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-payout-ledger-'))
  const crawler = createStubCrawler({ initialPages: 700 })
  const auth = testAuth(dataDir)
  const tokA = auth.issueToken(W1).token
  const tokB = auth.issueToken(W2).token
  const tokC = auth.issueToken(W3).token
  const broadcasts: ServerMsg[] = []
  const inks = () => broadcasts.filter((m): m is { t: 'ink'; event: InkEvent } => m.t === 'ink').map((m) => m.event)
  let coord = createCoordinator({ crawler, emit: (m) => broadcasts.push(m), dataDir, log: () => undefined, auth })
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6
  const work = async (c: FakeConn, n: number) => {
    for (let i = 0; i < n; i++) {
      coord.handle(c, { t: 'job.request' })
      const job = (await c.next('job', 6000)).job
      coord.handle(c, { t: 'job.result', result: { id: job.id, ...solve(decodeJob(job)), ms: 5 } })
      ok(inks().at(-1)?.verified === true, `payout flow: job verified (${job.rows}x${job.cols})`)
    }
  }
  const devReg = (extra: { wallet?: string | null; auth?: string | null } = {}) => ({
    t: 'neuron.register' as const,
    label: 'Link GPU',
    zone: 'EPI' as const,
    gflops: 10,
    kind: 'browser' as const,
    wallet: extra.wallet ?? null,
    adapter: { deviceId: 'link-dev-1' },
    auth: extra.auth,
  })

  // a bare wallet (no token): INK stays on the device account, nothing is payable
  const c = fakeConn('payout-dev', '10.0.0.5')
  coord.handle(c, devReg({ wallet: W1 }))
  ok((await c.next('neuron.ok')).auth === 'none', 'payout flow: bare wallet register → auth none')
  await work(c, 2)
  const devInk = coord.balance('device:link-dev-1')?.periodInk ?? 0
  ok(devInk > 0 && coord.balance(W1) === null, `bare wallet: INK stays on the device account (${devInk} period INK)`)
  ok(coord.payouts.periodSnapshot().length === 0 && !coord.payouts.isVerified(W1), 'bare wallet: no verified wallet, empty period snapshot')

  // first verified register of the device in this period: its period INK moves to the wallet once
  coord.handle(c, devReg({ wallet: W1, auth: tokA }))
  const r1 = await c.next('neuron.ok')
  ok(r1.auth === 'verified' && r1.neuron.wallet === W1, 'link: re-register with a token on the same socket → verified (no switch cooldown)')
  ok(near(coord.payouts.periodInk(W1), devInk) && near(coord.payouts.lifetimeInk(W1), Math.round(devInk * 100) / 100), `link: device period INK moved to the wallet (${coord.payouts.periodInk(W1)})`)
  ok(!coord.balance('device:link-dev-1')?.periodInk && coord.payouts.isVerified(W1), 'link: device period INK cleared, wallet verified')
  coord.handle(c, devReg({ wallet: W1, auth: tokA }))
  await c.next('neuron.ok')
  ok(near(coord.payouts.periodInk(W1), devInk), 'link: idempotent (a second verified register moves nothing more)')
  const before = coord.payouts.periodInk(W1)
  await work(c, 1)
  ok(near(coord.payouts.periodInk(W1), before + inks().at(-1)!.ink), 'verified register: new INK accrues to the wallet period INK')

  // the same device cannot move this period's INK to a second wallet
  coord.handle(c, devReg())
  await c.next('neuron.ok')
  await work(c, 1)
  const devLeft = coord.balance('device:link-dev-1')?.periodInk ?? 0
  coord.handle(c, devReg({ auth: tokB }))
  ok((await c.next('neuron.ok')).auth === 'verified', 'second wallet: token accepted')
  ok(devLeft > 0 && near(coord.balance('device:link-dev-1')?.periodInk ?? 0, devLeft) && coord.payouts.periodInk(W2) === 0, 'link: a device moves period INK to one wallet per period only')

  // snapshot + close with carry-over
  const snap = coord.payouts.periodSnapshot()
  const wInk = coord.payouts.periodInk(W1)
  ok(snap.length === 1 && snap[0].wallet === W1 && near(snap[0].ink, wInk), 'periodSnapshot: verified wallets with period INK only')
  let planned: unknown = null
  const endsAt = Date.now()
  const closed = coord.payouts.closePeriod('2026-10-05T00', endsAt, (s) => {
    planned = s
    return { [W1]: 0.01 }
  })
  ok(planned !== null && JSON.stringify(closed) === JSON.stringify(snap), 'closePeriod: plan() receives the snapshot, which is returned')
  ok(near(coord.payouts.periodInk(W1), 0.01) && !coord.balance('device:link-dev-1')?.periodInk, 'closePeriod: period INK reset everywhere, carry-over added back')
  ok(coord.payouts.lastClosed()?.id === '2026-10-05T00' && coord.payouts.lastClosed()?.endsAt === endsAt, 'closePeriod: lastClosed recorded')
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'ledger.json'), 'utf8'))
  ok(onDisk.payouts?.lastClosedId === '2026-10-05T00' && near(onDisk.accounts[`wallet:${W1}`]?.periodInk, 0.01), 'closePeriod: ledger saved synchronously (close + carry on disk)')
  let threw = false
  try {
    coord.payouts.closePeriod('2026-10-05T12', endsAt + 1000, () => {
      throw new Error('plan not persisted')
    })
  } catch {
    threw = true
  }
  ok(threw && near(coord.payouts.periodInk(W1), 0.01) && coord.payouts.lastClosed()?.id === '2026-10-05T00', 'closePeriod: a throwing plan changes nothing')

  // failed on-chain payout → INK carried back; restart recovery
  coord.payouts.carryBack(W1, 0.5)
  ok(near(coord.payouts.periodInk(W1), 0.51), 'carryBack: INK added back to the current period')
  ok(!coord.payouts.reconcileClose('2026-10-05T00', endsAt, [{ wallet: W1, ink: 1 }], {}), 'reconcileClose: no-op for a period the ledger already closed')
  ok(coord.payouts.reconcileClose('2026-10-05T12', endsAt + 1000, [{ wallet: W1, ink: 0.5 }], { [W1]: 0.1 }), 'reconcileClose: applies a close whose reset was not saved')
  ok(near(coord.payouts.periodInk(W1), 0.11) && coord.payouts.lastClosed()?.id === '2026-10-05T12', 'reconcileClose: subtracts the planned INK, adds the carry, keeps newer INK')
  coord.handle(c, { t: 'neuron.leave' })
  await coord.stop()

  // restart: period INK, verification and the last close survive
  coord = createCoordinator({ crawler, emit: (m) => broadcasts.push(m), dataDir, log: () => undefined, auth })
  ok(near(coord.payouts.periodInk(W1), 0.11) && coord.payouts.isVerified(W1) && coord.payouts.lastClosed()?.id === '2026-10-05T12', 'restart: period INK, verified flag and last close persisted')
  ok(!coord.payouts.isVerified(W2) && coord.payouts.periodInk(W2) === 0, 'restart: a wallet that never earned holds nothing')
  // a new period lets the device link again (to another wallet)
  const c2 = fakeConn('payout-dev-2', '10.0.0.5')
  coord.handle(c2, devReg())
  await c2.next('neuron.ok')
  await work(c2, 1)
  const devNew = coord.balance('device:link-dev-1')?.periodInk ?? 0
  coord.handle(c2, devReg({ auth: tokC }))
  await c2.next('neuron.ok')
  ok(devNew > 0 && near(coord.payouts.periodInk(W3), devNew), 'link: after a period close the device links to a new wallet')
  ok(!JSON.stringify(coord.ledger()).includes('link-dev-1'), 'ledger snapshot carries no raw device id after linking')
  const bal = coord.balance('device:link-dev-1') as Record<string, unknown> | null
  ok(!!bal && !('linkedTo' in bal) && !('linkedPeriod' in bal), 'balance() hides the device → wallet link')
  coord.handle(c2, { t: 'neuron.leave' })
  await coord.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// --- 2b. coverage: every pair is paid once, concurrent neurons get disjoint rows ---

async function coverageFlow() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-cover-'))
  const crawler = createStubCrawler({ initialPages: 40, seed: 11 })
  // no fill wait here: this flow checks pure coverage (fillFlow covers the batching rule)
  const coord = createCoordinator({ crawler, emit: () => undefined, dataDir, log: () => undefined, limits: { jobFillWaitMs: 0 } })
  const a = fakeConn('cover-a')
  const b = fakeConn('cover-b')
  coord.handle(a, { t: 'neuron.register', label: 'A', zone: 'EPI', gflops: 10, kind: 'browser', wallet: null, adapter: { deviceId: 'cover-dev-a' } })
  coord.handle(b, { t: 'neuron.register', label: 'B', zone: 'EPI', gflops: 10, kind: 'browser', wallet: null, adapter: { deviceId: 'cover-dev-b' } })
  await a.next('neuron.ok')
  await b.next('neuron.ok')
  coord.handle(a, { t: 'job.request' })
  coord.handle(b, { t: 'job.request' })
  const ja = (await a.next('job')).job
  const jb = (await b.next('job')).job
  const da = decodeJob(ja)
  const db = decodeJob(jb)
  let shared = false
  for (let r = 0; r < ja.rows; r++) for (let q = 0; q < jb.rows; q++) if (sameVec(da.a, r, db.a, q, 256)) shared = true
  ok(!shared, `concurrent neurons get disjoint rows (${ja.rows} + ${jb.rows})`)

  // A replayed answer for an old job is worthless: the job id is gone.
  coord.handle(a, { t: 'job.result', result: { id: ja.id, ...solve(da), ms: 1 } })
  coord.handle(b, { t: 'job.result', result: { id: jb.id, ...solve(db), ms: 1 } })
  coord.handle(a, { t: 'job.result', result: { id: ja.id, ...solve(da), ms: 1 } })
  ok((await a.next('error')).msg.includes('expired'), 'replaying a verified answer earns nothing')

  // Work until every pair is covered: then no job is issued (the request stays queued).
  let flops = ja.flops + jb.flops
  let jobs = 2
  for (;;) {
    coord.handle(a, { t: 'job.request' })
    const m = await a.nextOf(['job', 'error'], 4000)
    if (m.t === 'error') {
      ok(/warming up.*already verified/.test(m.msg), `all ${crawler.vectorCount()} pages covered after ${jobs} jobs -> "${m.msg.slice(0, 60)}..."`)
      break
    }
    if (m.t !== 'job') break
    jobs++
    flops += m.job.flops
    coord.handle(a, { t: 'job.result', result: { id: m.job.id, ...solve(decodeJob(m.job)), ms: 1 } })
    if (jobs > 200) break
  }
  const n = crawler.vectorCount()
  ok(jobs < 200 && flops <= ((n * (n - 1)) / 2) * 2 * 256, `total paid work <= one comparison per unordered page pair (${flops} <= ${((n * (n - 1)) / 2) * 2 * 256} FLOP)`)
  crawler.addPages(3)
  const fresh = (await a.next('job', 5000)).job
  ok(fresh.rows >= 1, `new pages -> the queued request is served (${fresh.rows}x${fresh.cols})`)
  await coord.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// --- 2c. no tiny repeat jobs: wait for JOB_ROWS/2 uncovered rows or the fill wait ---

async function fillFlow() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-fill-'))
  const crawler = createStubCrawler({ initialPages: 40, seed: 5 })
  const coord = createCoordinator({ crawler, emit: () => undefined, dataDir, log: () => undefined, limits: { jobFillWaitMs: 1500 } })
  const a = fakeConn('fill-a')
  coord.handle(a, { t: 'neuron.register', label: 'F', zone: 'EPI', gflops: 10, kind: 'browser', wallet: null, adapter: { deviceId: 'fill-dev-a' } })
  await a.next('neuron.ok')
  const run = async () => {
    coord.handle(a, { t: 'job.request' })
    const j = (await a.next('job', 4000)).job
    coord.handle(a, { t: 'job.result', result: { id: j.id, ...solve(decodeJob(j)), ms: 1 } })
    return j
  }
  const j1 = await run()
  ok(j1.rows === 16, `first job is served at once (${j1.rows} rows)`)
  const j2 = await run()
  ok(j2.rows === 16, `next job while ≥ JOB_ROWS/2 uncovered rows share a position is served at once (${j2.rows} rows)`)
  // 7 rows left (< 16/2): the request is held, then served once the fill wait has passed
  const tLast = Date.now()
  coord.handle(a, { t: 'job.request' })
  const held = await a.nextOf(['job', 'error'], 1000)
  ok(held.t === 'error' && /warming up/.test(held.msg) && /fuller job/.test(held.msg), `< JOB_ROWS/2 uncovered rows → request held as queued ("${held.t === 'error' ? held.msg.slice(0, 48) : held.t}…")`)
  const j3 = (await a.next('job', 4000)).job
  const waited = Date.now() - tLast
  ok(j3.rows < 8 && waited >= 1300, `…and served anyway after the fill wait (${j3.rows} rows after ${waited} ms)`)
  coord.handle(a, { t: 'job.result', result: { id: j3.id, ...solve(decodeJob(j3)), ms: 1 } })
  crawler.addPages(10)
  const t4 = Date.now()
  const j4 = await run()
  ok(j4.rows >= 8 && Date.now() - t4 < 1000, `enough new pages → served without waiting (${j4.rows} rows in ${Date.now() - t4} ms)`)
  await coord.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// --- 2d. global egress budget for job payloads ---

async function budgetFlow() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-budget-'))
  const crawler = createStubCrawler({ initialPages: 700, seed: 3 })
  const rate = 512 * 1024 // 0.5 MB/s → bucket of 1 MB
  const coord = createCoordinator({ crawler, emit: () => undefined, dataDir, log: () => undefined, limits: { issueBytesPerSec: rate, jobFillWaitMs: 0 } })
  const a = fakeConn('budget-a')
  coord.handle(a, { t: 'neuron.register', label: 'B', zone: 'EPI', gflops: 10, kind: 'browser', wallet: null, adapter: { deviceId: 'budget-dev-a' } })
  await a.next('neuron.ok')
  const t0 = Date.now()
  let bytes = 0
  let last = 0
  for (let i = 0; i < 4; i++) {
    coord.handle(a, { t: 'job.request' })
    const j = (await a.next('job', 8000)).job
    last = j.a.length + j.b.length
    bytes += last
    coord.handle(a, { t: 'job.result', result: { id: j.id, ...solve(decodeJob(j)), ms: 1 } })
  }
  const elapsed = Date.now() - t0
  const floor = ((bytes - last - 2 * rate) / rate) * 1000
  ok(floor > 1000 && elapsed >= floor * 0.95, `LUSCA_ISSUE_MB_PER_SEC holds: ${(bytes / 1048576).toFixed(2)} MB of jobs took ${elapsed} ms at 0.5 MB/s (≥ ${Math.round(floor)} ms)`)
  await coord.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// --- 2e. 'neurons' broadcast: top N only ---

async function broadcastFlow() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-top-'))
  const crawler = createStubCrawler({ initialPages: 200, seed: 9 })
  const broadcasts: ServerMsg[] = []
  const coord = createCoordinator({ crawler, emit: (m) => broadcasts.push(m), dataDir, log: () => undefined, limits: { neuronsTop: 3, jobFillWaitMs: 0 } })
  const conns = Array.from({ length: 5 }, (_, i) => fakeConn(`top-${i}`, `198.51.100.${i + 1}`))
  for (const [i, c] of conns.entries()) {
    coord.handle(c, { t: 'neuron.register', label: `N${i}`, zone: 'EPI', gflops: 10, kind: 'browser', wallet: null, adapter: { deviceId: `top-device-${i}` } })
    await c.next('neuron.ok')
  }
  const earner = conns[4]
  coord.handle(earner, { t: 'job.request' })
  const j = (await earner.next('job')).job
  coord.handle(earner, { t: 'job.result', result: { id: j.id, ...solve(decodeJob(j)), ms: 1 } })
  const list = coord.neurons()
  ok(coord.stats().neurons === 5 && list.length === 3 && list[0].id === 'top-4', `public neuron list = top 3 of 5 by INK (first ${list[0]?.id})`)
  await new Promise((r) => setTimeout(r, 700))
  const lastB = [...broadcasts].reverse().find((m): m is Extract<ServerMsg, { t: 'neurons' }> => m.t === 'neurons')
  ok(!!lastB && lastB.neurons.length === 3 && lastB.neurons[0].id === 'top-4', `'neurons' broadcast carries only the top 3 (${lastB?.neurons.length})`)
  ok(!JSON.stringify(broadcasts).includes('top-device-'), 'broadcasts never carry device ids')
  await coord.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// --- 2f. ledger accounts: threshold, per-/56 creation limit, idle eviction near the cap ---

async function accountsFlow() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-accounts-'))
  const day = 86_400_000
  const now = Date.now()
  const accounts: Record<string, unknown> = {}
  const seed = (key: string, ink: number, lastSeen: number) => {
    accounts[key] = { key, kind: 'device', wallet: null, label: key, ink, flops: 1, jobs: 1, verified: 1, failed: 0, firstSeen: lastSeen, lastSeen }
  }
  for (let i = 0; i < 10; i++) seed(`device:idle-low-${i}`, 0.5, now - (8 + i) * day) // evictable; idle-low-9 is the oldest
  for (let i = 0; i < 5; i++) seed(`device:idle-rich-${i}`, 5, now - 30 * day) // ≥ 1 INK: never evicted
  for (let i = 0; i < 5; i++) seed(`device:recent-low-${i}`, 0.2, now - day) // active within 7 days: kept
  // an older ledger with a checksum-cased EVM account folds into the lowercase key
  accounts['wallet:0x52908400098527886E0F7030069857D2E4169EE7'] = { key: 'wallet:0x52908400098527886E0F7030069857D2E4169EE7', kind: 'wallet', wallet: '0x52908400098527886E0F7030069857D2E4169EE7', label: 'evm', ink: 3, flops: 1, jobs: 1, verified: 1, failed: 0, firstSeen: now, lastSeen: now }
  const totals = { jobsDone: 0, jobsVerified: 0, jobsFailed: 0, inkIssued: 0, flopsVerified: 0, dupsFound: 0 }
  fs.writeFileSync(path.join(dataDir, 'ledger.json'), JSON.stringify({ version: 1, updatedAt: now, totals, leaderboard: [], accounts }))

  const crawler = createStubCrawler({ initialPages: 300, seed: 13 })
  const coord = createCoordinator({ crawler, emit: () => undefined, dataDir, log: () => undefined, limits: { maxAccounts: 21, newAccountsPerHour: 2, jobFillWaitMs: 0 } })
  ok(coord.balance('0x52908400098527886E0F7030069857D2E4169EE7')?.key === 'wallet:0x52908400098527886e0f7030069857d2e4169ee7', 'EVM ledger accounts are normalized to lowercase (lookup by either casing)')
  const reg = async (id: string, ip: string) => {
    const c = fakeConn(id, ip)
    coord.handle(c, { t: 'neuron.register', label: id, zone: 'EPI', gflops: 10, kind: 'browser', wallet: null, adapter: { deviceId: id } })
    await c.next('neuron.ok')
    return c
  }
  /** One job → null when verified, else the coordinator's refusal. */
  const work = async (c: FakeConn): Promise<string | null> => {
    coord.handle(c, { t: 'job.request' })
    const m = await c.nextOf(['job', 'error'], 3000)
    if (m.t !== 'job') return m.t === 'error' ? m.msg : m.t
    coord.handle(c, { t: 'job.result', result: { id: m.job.id, ...solve(decodeJob(m.job)), ms: 1 } })
    return null
  }

  // The ledger is full (21/21): idle accounts holding < 1 INK are evicted down to 85% (17), so a newcomer still gets an account.
  const n1 = await reg('newcomer-1', '2001:db8:1:200::/64')
  ok((await work(n1)) === null && coord.balance('device:newcomer-1') !== null, 'full ledger: a newcomer still earns an account (idle < 1 INK accounts evicted)')
  const left = (p: string, n: number) => Array.from({ length: n }, (_, i) => coord.balance(`device:${p}-${i}`)).filter(Boolean).length
  ok(left('idle-low', 10) === 6 && left('idle-rich', 5) === 5 && left('recent-low', 5) === 5, `only idle accounts below 1 INK are evicted, down to 85% of the cap (idle-low ${left('idle-low', 10)}/10, idle-rich ${left('idle-rich', 5)}/5, recent ${left('recent-low', 5)}/5)`)
  ok(coord.balance('device:idle-low-9') === null && coord.balance('device:idle-low-0') !== null, 'the longest-idle accounts go first')

  // New accounts per IPv6 /56 (2 per hour here), whichever /64 they come from.
  const n2 = await reg('newcomer-2', '2001:db8:1:2ff::/64')
  ok((await work(n2)) === null && coord.balance('device:newcomer-2') !== null, 'second new account from the same /56 (other /64) is accepted')
  const n3 = await reg('newcomer-3', '2001:db8:1:2a0::/64')
  const refused = await work(n3)
  ok(refused !== null && /not accepting new accounts/.test(refused) && coord.balance('device:newcomer-3') === null, 'third new account from the same IPv6 /56 within the hour is refused')
  const n4 = await reg('newcomer-4', '2001:db8:1:300::/64')
  ok((await work(n4)) === null && coord.balance('device:newcomer-4') !== null, 'another /56 has its own new-account budget')
  await coord.stop()

  const lines = fs.readFileSync(path.join(dataDir, 'issuance.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  const evicted = lines.filter((l) => l.ev === 'evict')
  ok(evicted.length === 4 && evicted.every((l) => /^[0-9a-f]{16}$/.test(String(l.acct)) && (l.ink as number) < 1), `evictions are recorded in the issuance log (${evicted.length})`)
  ok(lines.filter((l) => l.ev === 'issue').length === 3, 'refused work is never issued, so never logged')
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// --- 2g. issuance log rotation, archives, sync flush, salt ---

async function issuanceLogFlow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-issuance-'))
  const lg = createIssuanceLog(dir, 2048, 2, () => undefined)
  for (let i = 0; i < 40; i++) {
    lg.write({ ts: i, ev: 'issue', jobId: `j${i}`, acct: 'a'.repeat(16), pad: 'x'.repeat(200) })
    await lg.flush()
  }
  await lg.close()
  const names = fs.readdirSync(dir)
  const live = path.join(dir, 'issuance.log')
  ok(names.includes('issuance.log') && fs.statSync(live).size <= 2048, `issuance log: live file stays under the rotation size (${fs.statSync(live).size} B)`)
  const archives = names.filter((n) => /^issuance-.+\.log\.gz$/.test(n))
  ok(archives.length === 2 && !names.some((n) => /^issuance-.+\.log$/.test(n) || n.endsWith('.tmp')), `issuance log: rotated archives are gzipped, newest 2 kept (${archives.length})`)
  const tsOf = (raw: string) => raw.trim().split('\n').map((l) => (JSON.parse(l) as { ts: number }).ts)
  const arch = archives.map((n) => tsOf(zlib.gunzipSync(fs.readFileSync(path.join(dir, n))).toString('utf8'))).sort((x, y) => x[0] - y[0])
  const all = [...arch.flat(), ...tsOf(fs.readFileSync(live, 'utf8'))]
  ok(all.at(-1) === 39 && all.every((t, i) => i === 0 || t === all[i - 1] + 1), `issuance log: archives + live file form one ordered, gap-free tail (${all[0]}…${all.at(-1)})`)

  const lg2 = createIssuanceLog(dir, 2048, 2, () => undefined)
  lg2.write({ ts: 40 })
  lg2.flushSync()
  ok(tsOf(fs.readFileSync(live, 'utf8')).at(-1) === 40, 'issuance log: flushSync appends synchronously (exit path)')
  await lg2.close()
  const off = createIssuanceLog(path.join(dir, 'off'), 0, 2, () => undefined)
  off.write({ ts: 1 })
  await off.close()
  ok(!fs.existsSync(path.join(dir, 'off')), 'issuance log: LUSCA_ISSUANCE_LOG_MB=0 disables it')

  const s1 = loadHashSalt(dir, undefined, () => undefined)
  const s2 = loadHashSalt(dir, undefined, () => undefined)
  ok(s1.equals(s2) && s1.length >= 32 && fs.existsSync(path.join(dir, 'hash.salt')), 'hash salt is created once and reused across restarts')
  ok(loadHashSalt(dir, 'from-env', () => undefined).toString('utf8') === 'from-env', 'LUSCA_HASH_SALT overrides the salt file')
  fs.rmSync(dir, { recursive: true, force: true })
}

// ─── 2b. SEPIA gradient jobs: issue / apply / escrow confirm / forfeit / stale / fallback ──

type Verdict = 'applied' | 'audited' | 'audit-failed' | 'rejected' | 'stale'

function stubTrainer() {
  const st = {
    version: 7,
    verdict: 'audited' as Verdict,
    flops: 1e9,
    available: true,
    issued: [] as { neuronKey: string; batch: number; haveVersion: number | null }[],
    submits: [] as { neuronKey: string; jobId: string; grad: Uint8Array; loss: number; forceAudit: boolean }[],
  }
  const api = {
    issueTrainJob: async (req: { neuronKey: string; batch: number; haveVersion: number | null }): Promise<TrainJob | null> => {
      st.issued.push(req)
      if (!st.available) return null
      return { id: `tj${st.issued.length}`, kind: 'train', version: st.version, weights: req.haveVersion === st.version ? null : 'AAAAAAAA', batch: req.batch, ctx: 16, x: 'AAAA', y: 'AA==', flops: 1e9, issuedAt: Date.now() }
    },
    submitTrainResult: async (req: { neuronKey: string; jobId: string; grad: Uint8Array; loss: number; forceAudit: boolean }) => {
      st.submits.push(req)
      const v = st.verdict
      return { verdict: v, reason: `stub ${v}`, flops: st.flops, audited: v === 'audited' }
    },
    trainStats: () => ({ version: st.version, gpuSteps: 0, serverSteps: 0, gpuSamples: 0, contributors24h: 0, audits: { ok: 0, failed: 0 }, gpuStepsPerMin: 0 }),
  }
  return { st, api }
}

async function trainFlow() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-train-'))
  const crawler = createStubCrawler({ initialPages: 40 })
  const broadcasts: ServerMsg[] = []
  const { st, api } = stubTrainer()
  const mk = () => createCoordinator({ crawler, emit: (m) => broadcasts.push(m), dataDir, log: () => undefined, trainer: api, limits: { jobFillWaitMs: 0 } })
  let coord = mk()
  const inkEvents = () => broadcasts.filter((m): m is Extract<ServerMsg, { t: 'ink' }> => m.t === 'ink').map((m) => m.event)
  const settle = () => new Promise((r) => setTimeout(r, 40))
  const DEV = 'device:traindev01'
  const JOB_INK = inkFor(1e9, 0) // 10 INK per 1 GFLOP job at EPI

  const reg = async (c: FakeConn, adapter: Record<string, string>) => {
    coord.handle(c, { t: 'neuron.register', label: 'train test gpu', zone: 'EPI', gflops: 100, kind: 'browser', wallet: null, adapter })
    await c.next('neuron.ok')
  }
  const round = async (c: FakeConn, verdict: Verdict, version: number | null = null) => {
    st.verdict = verdict
    coord.handle(c, { t: 'job.request', caps: { train: true, version } })
    const job = (await c.next('job')).job as SimJob | TrainJob
    ok(job.kind === 'train', `train: job.request with caps.train → TrainJob (${verdict})`)
    coord.handle(c, { t: 'train.result', result: { id: job.id, kind: 'train', grad: 'AAAAAAAA', loss: 4.5, ms: 3 } })
    await settle()
    return job as TrainJob
  }

  let c = fakeConn('tr1', '10.9.0.1')
  await reg(c, { deviceId: 'traindev01' })
  const j1 = await round(c, 'audited')
  ok(j1.batch === 256 && j1.weights !== null && st.issued[0].haveVersion === null, 'train: EPI neuron → B=256, weights sent when the neuron holds none')
  ok(st.submits[0].forceAudit === true && st.submits[0].loss === 4.5 && st.submits[0].grad.length === 6, 'train: first result forced to a full audit, grad decoded from base64')
  let bal = coord.balance(DEV)
  ok(bal && bal.ink === JOB_INK && bal.periodInk === JOB_INK && !bal.pendingInk, `train: audited job INK confirmed into ledger + periodInk (${bal?.ink})`)
  ok(inkEvents().at(-1)?.kind === 'train' && inkEvents().at(-1)?.status === 'confirmed', 'train: ink event kind=train status=confirmed')

  await round(c, 'applied')
  await round(c, 'applied')
  ok(st.submits[1].forceAudit && st.submits[2].forceAudit, 'train: jobs 2 and 3 still forced to a full audit')
  const j4 = await round(c, 'applied', 7)
  ok(st.submits[3].forceAudit === false, 'train: 4th job not forced (sampled audit left to the trainer)')
  ok(j4.weights === null && st.issued[3].haveVersion === 7, 'train: no weights resent when caps.version is current')
  bal = coord.balance(DEV)
  ok(bal?.ink === JOB_INK && bal.pendingInk === 3 * JOB_INK && bal.periodInk === JOB_INK, `train: applied-but-unaudited INK held in escrow (pending ${bal?.pendingInk})`)
  ok(coord.ledger().totals.inkPending === 3 * JOB_INK && coord.ledger().totals.inkIssued === JOB_INK, 'train: totals split confirmed / pending')
  ok(inkEvents().at(-1)?.status === 'pending', 'train: unaudited job event status=pending')
  ok(!coord.ledger().leaderboard.some((r) => r.ink > JOB_INK), 'train: leaderboard counts confirmed INK only')

  const before = inkEvents().length
  await round(c, 'audited', 7)
  bal = coord.balance(DEV)
  ok(bal?.ink === 5 * JOB_INK && !bal.pendingInk && bal.periodInk === 5 * JOB_INK, `train: next passed audit releases the escrow (${bal?.ink} INK)`)
  const rel = inkEvents().slice(before)
  ok(rel.some((e) => e.status === 'confirmed' && e.ink === 3 * JOB_INK && /escrow released/.test(e.reason)), 'train: escrow release event carries the released INK')

  await round(c, 'stale', 7)
  bal = coord.balance(DEV)
  ok(bal?.pendingInk === JOB_INK && bal.ink === 5 * JOB_INK, 'train: stale unaudited result paid into escrow, not confirmed')
  // 'stale' without FLOPs = the trainer never checked the gradient (expired job, restart): no INK, no strike
  st.flops = 0
  const vBefore = coord.ledger().totals.jobsVerified
  await round(c, 'stale', 7)
  st.flops = 1e9
  bal = coord.balance(DEV)
  ok(bal?.pendingInk === JOB_INK && bal.ink === 5 * JOB_INK && coord.ledger().totals.jobsVerified === vBefore, 'train: unchecked stale result (flops 0) earns no INK')
  ok(/not scored/.test(inkEvents().at(-1)?.reason ?? '') && inkEvents().at(-1)?.ink === 0, 'train: unchecked stale result reported as not scored (no strike)')

  // escrow survives a restart (persisted with the ledger)
  await coord.stop()
  coord = mk()
  bal = coord.balance(DEV)
  ok(bal?.pendingInk === JOB_INK && bal.ink === 5 * JOB_INK && coord.ledger().totals.inkPending === JOB_INK, 'train: escrow persisted with the ledger across restart')
  c = fakeConn('tr2', '10.9.0.1')
  await reg(c, { deviceId: 'traindev01' })
  ok(true, 'train: re-register after restart')
  const nSub = st.submits.length
  await round(c, 'audit-failed', 7)
  ok(st.submits[nSub].forceAudit === false, 'train: forced-audit count persisted (no re-forcing after restart)')
  bal = coord.balance(DEV)
  ok(bal && !bal.pendingInk && bal.ink === 5 * JOB_INK && coord.ledger().totals.inkForfeited === JOB_INK, 'train: failed audit forfeits the escrow, confirmed INK untouched')
  const evs = inkEvents()
  ok(evs.some((e) => e.status === 'forfeited' && e.ink === JOB_INK) && evs.at(-1)?.verified === false && evs.at(-1)?.kind === 'train', 'train: forfeited + failed-job events')
  ok(coord.neurons().find((n) => n.id === 'tr2')?.failed === 1, 'train: failed audit counts as a strike')

  await round(c, 'rejected', 7)
  ok(coord.neurons().find((n) => n.id === 'tr2')?.failed === 2, 'train: rejected gradient counts as a strike')

  // the trainer has no job → dedupe job instead
  st.available = false
  coord.handle(c, { t: 'job.request', caps: { train: true, version: 7 } })
  const sj = (await c.next('job', 6000)).job as SimJob | TrainJob
  ok(sj.kind === 'simmatrix', 'train: falls back to a dedupe job when the trainer has none')
  coord.handle(c, { t: 'job.result', result: { id: sj.id, ...solve(decodeJob(sj)), ms: 1 } })
  await settle()
  st.available = true

  // a CPU-backend neuron gets the CPU batch; a neuron without caps.train never gets a gradient job
  const cpu = fakeConn('tr3', '10.9.0.2')
  await reg(cpu, { deviceId: 'traincpu01', backend: 'cpu' })
  coord.handle(cpu, { t: 'job.request', caps: { train: true, version: null } })
  const cj = (await cpu.next('job')).job as SimJob | TrainJob
  ok(cj.kind === 'train' && cj.batch === 128, 'train: CPU-backend neuron → B=128')
  const old = fakeConn('tr4', '10.9.0.3')
  await reg(old, { deviceId: 'trainold01' })
  coord.handle(old, { t: 'job.request' })
  ok(((await old.next('job', 6000)).job as SimJob | TrainJob).kind === 'simmatrix', 'train: request without caps → dedupe job')
  // an unknown train.result is refused, not paid
  coord.handle(old, { t: 'train.result', result: { id: 'nope', kind: 'train', grad: 'AAAA', loss: 1, ms: 1 } })
  ok((await old.next('error')).msg === 'unknown or expired job', 'train: stray train.result refused')
  // abandoning a gradient job is a failure
  coord.disconnect(cpu)
  ok(inkEvents().at(-1)?.kind === 'train' && inkEvents().at(-1)?.verified === false, 'train: disconnect with a gradient job outstanding → failed')
  await coord.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// ─── 3. end-to-end over HTTP + WebSocket with stub modules ───────────────────

async function e2e() {
  const { createHub } = await import('../http.ts')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-e2e-'))
  const hub = createHub({ distDir: null })
  const trainer = createStubTrainer({ emit: hub.emit })
  const crawler = createStubCrawler({ emit: hub.emit, initialPages: 200, onText: (t) => trainer.feed(t) })
  const coordinator = createCoordinator({ crawler, emit: hub.emit, dataDir, log: () => undefined })
  hub.bind({ crawler, trainer, coordinator })
  const port = await hub.listen(0, '127.0.0.1')
  crawler.start()
  trainer.start()
  const base = `http://127.0.0.1:${port}`

  const hello = (await (await fetch(`${base}/api/hello`)).json()) as Hello
  ok(hello.t === 'hello' && hello.agents.length === 8 && hello.recent.length === 60 && hello.stats.pages >= 200, 'GET /api/hello')
  const health = (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean }
  ok(health.ok === true, 'GET /api/health')
  const pages = await (await fetch(`${base}/api/pages?sector=2&q=`)).json()
  ok(Array.isArray(pages) && pages.every((p: { sector: number }) => p.sector === 2), 'GET /api/pages?sector=2')
  ok((await fetch(`${base}/api/pages?sector=9`)).status === 400, 'GET /api/pages?sector=9 → 400')
  ok(Array.isArray(await (await fetch(`${base}/api/agents/1/traces`)).json()), 'GET /api/agents/1/traces')
  const JSON_HDR = { 'Content-Type': 'application/json' }
  const gen = await fetch(`${base}/api/generate`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ prompt: 'x'.repeat(500), n: 5000 }) })
  const genBody = (await gen.json()) as { text: string; ms: number }
  ok(gen.status === 200 && genBody.text.length <= 600, 'POST /api/generate caps prompt/n')
  ok((await fetch(`${base}/api/generate`, { method: 'POST', headers: JSON_HDR, body: '{nope' })).status === 400, 'POST /api/generate bad JSON -> 400')
  ok((await fetch(`${base}/api/generate`, { method: 'POST', body: JSON.stringify({ prompt: 'z' }) })).status === 415, 'POST without Content-Type: application/json -> 415 (no CORS-simple requests)')
  ok((await fetch(`${base}/api/generate`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ prompt: 'y'.repeat(20_000) }) })).status === 413, 'body > 16 KB -> 413')
  ok((await fetch(`${base}/api/spawn`, { method: 'POST', headers: { ...JSON_HDR, Origin: 'https://evil.example' }, body: JSON.stringify({ name: 'evil', owner: null, sector: 1 }) })).status === 403, 'POST from a foreign Origin -> 403')
  const spawnBad = await fetch(`${base}/api/spawn`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ name: 'Bad Name!', owner: null, sector: 1 }) })
  ok(spawnBad.status === 400, 'POST /api/spawn invalid name → 400')
  const sp1 = await fetch(`${base}/api/spawn`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ name: 'kraken-1', owner: 'tester', sector: 3 }) })
  const agent = (await sp1.json()) as AgentInfo
  ok(sp1.status === 200 && agent.name === 'kraken-1' && agent.sector === 3, 'POST /api/spawn → AgentInfo')
  const sp2 = await fetch(`${base}/api/spawn`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ name: 'kraken-2', owner: null, sector: 3 }) })
  ok(sp2.status === 429 && sp2.headers.get('retry-after') !== null, 'POST /api/spawn rate limited (1 / 10 s / IP)')
  ok((await fetch(`${base}/api/nope`)).status === 404, 'unknown /api route → 404')
  const cors = await fetch(`${base}/api/health`, { headers: { Origin: 'http://localhost:5173' } })
  ok(cors.headers.get('access-control-allow-origin') === 'http://localhost:5173', 'CORS allows localhost origin')
  const corsX = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } })
  ok(corsX.headers.get('access-control-allow-origin') === null && corsX.status === 403, 'foreign origin: no CORS headers, request refused')

  // ws with a foreign Origin is refused (WebSockets bypass CORS)
  const evilWs = await new Promise<string>((resolve) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'https://evil.example' } })
    s.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)))
    s.on('error', () => resolve('error'))
    s.on('open', () => (s.close(), resolve('open')))
  })
  ok(evilWs === '403', `ws from a foreign Origin rejected (${evilWs})`)

  // wrong ws path rejected
  const badWs = await new Promise<string>((resolve) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/nope`)
    s.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)))
    s.on('error', () => resolve('error'))
    s.on('open', () => resolve('open'))
  })
  ok(badWs === '404' || badWs === 'error', `ws on /nope rejected (${badWs})`)

  // a viewer and a neuron
  const viewerMsgs: ServerMsg[] = []
  const viewer = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  viewer.on('message', (d) => viewerMsgs.push(JSON.parse(String(d))))
  await new Promise((r) => viewer.once('open', r))

  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const queue: ServerMsg[] = []
  const waiters: { t: string; resolve: (m: ServerMsg) => void }[] = []
  sock.on('message', (d) => {
    const msg = JSON.parse(String(d)) as ServerMsg
    const w = waiters.findIndex((x) => x.t === msg.t)
    if (w >= 0) waiters.splice(w, 1)[0].resolve(msg)
    else queue.push(msg)
  })
  const next = <T extends ServerMsg['t']>(t: T, ms = 8000) =>
    new Promise<Extract<ServerMsg, { t: T }>>((resolve, reject) => {
      const i = queue.findIndex((m) => m.t === t)
      if (i >= 0) return resolve(queue.splice(i, 1)[0] as never)
      const timer = setTimeout(() => reject(new Error(`ws timeout waiting for ${t}`)), ms)
      waiters.push({ t, resolve: (m) => (clearTimeout(timer), resolve(m as never)) })
    })
  await new Promise((r) => sock.once('open', r))
  const wsHello = await next('hello')
  ok(wsHello.mode === 'live' && wsHello.sectors.length === 8 && wsHello.model.name === 'SEPIA-0', 'ws hello payload')
  sock.send('not json')
  sock.send(JSON.stringify({ t: 'ping' }))
  sock.send(JSON.stringify({ t: 'neuron.register', label: 'e2e GPU', zone: 'EPI', gflops: 900, kind: 'browser', wallet: null, adapter: { vendor: 'stub' } }))
  const me = (await next('neuron.ok')).neuron as NeuronInfo
  ok(me.zone === 'MESO', 'ws register → neuron.ok (MESO at 900 GFLOPS)')
  for (let i = 0; i < 3; i++) {
    sock.send(JSON.stringify({ t: 'job.request' }))
    const job = (await next('job')).job as SimJob
    const t0 = performance.now()
    const res = solve(decodeJob(job))
    sock.send(JSON.stringify({ t: 'job.result', result: { id: job.id, ...res, ms: Math.round(performance.now() - t0) } }))
    const ink = (await next('ink')).event
    ok(ink.verified && ink.jobId === job.id && job.rows <= 32, `ws job ${i + 1} verified (${job.rows}x${job.cols}, ${ink.reason}, +${ink.ink} INK)`)
  }
  await new Promise((r) => setTimeout(r, 1300))
  ok(!viewerMsgs.some((m) => m.t === 'job' || m.t === 'neuron.ok'), 'viewer never receives job / neuron.ok')
  ok(viewerMsgs.some((m) => m.t === 'ink') && viewerMsgs.some((m) => m.t === 'neurons'), 'viewer receives ink + neurons broadcasts')
  ok(viewerMsgs.some((m) => m.t === 'stats'), 'viewer receives 1 Hz stats')
  const statsMsg = [...viewerMsgs].reverse().find((m) => m.t === 'stats') as Extract<ServerMsg, { t: 'stats' }>
  ok(statsMsg.stats.neurons === 1 && statsMsg.stats.jobsVerified >= 3, 'stats merge crawler + coordinator fields')
  const ledger = (await (await fetch(`${base}/api/ledger`)).json()) as { leaderboard: unknown[] }
  ok(ledger.leaderboard.length >= 1, 'GET /api/ledger leaderboard')

  sock.close()
  await new Promise((r) => setTimeout(r, 200))
  ok(coordinator.neurons().length === 0, 'socket close → coordinator.disconnect')
  viewer.close()
  await hub.close()
  await Promise.all([crawler.stop(), trainer.stop(), coordinator.stop()])
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// ─── 4. static hosting of a built client ────────────────────────────────────

async function staticServing() {
  const { createHub } = await import('../http.ts')
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-dist-'))
  fs.mkdirSync(path.join(dist, 'assets'))
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>LUSCA</title><div id=root></div>')
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), `console.log(${JSON.stringify('x'.repeat(5000))})`)
  const hub = createHub({ distDir: dist, forceStatic: true })
  hub.bind({ crawler: createStubCrawler(), trainer: createStubTrainer(), coordinator: createCoordinator({ crawler: createStubCrawler(), emit: () => undefined, dataDir: dist, log: () => undefined }) })
  const port = await hub.listen(0, '127.0.0.1')
  const base = `http://127.0.0.1:${port}`

  const root = await fetch(`${base}/`)
  ok(root.status === 200 && root.headers.get('content-type')?.startsWith('text/html') && (await root.text()).includes('LUSCA'), 'static: / serves dist/index.html')
  const js = await fetch(`${base}/assets/app-abc123.js`, { headers: { 'Accept-Encoding': 'gzip' } })
  ok(js.status === 200 && js.headers.get('content-type')?.startsWith('text/javascript') && js.headers.get('cache-control')?.includes('immutable') && (await js.text()).length > 5000, 'static: hashed asset, js mime, immutable cache, gzip transparently decoded')
  const spa = await fetch(`${base}/agents/7`, { headers: { Accept: 'text/html' } })
  ok(spa.status === 200 && (await spa.text()).includes('id=root'), 'static: SPA fallback for client routes')
  ok((await fetch(`${base}/Live`)).status === 200, 'static: client routes match case-insensitively')
  const miss = await fetch(`${base}/observatory/agents`, { headers: { Accept: 'text/html' } })
  ok(miss.status === 404 && miss.headers.get('cache-control') === 'no-store' && (await miss.text()).includes('id=root'), 'static: unknown route → client shell under 404')
  ok((await fetch(`${base}/live/extra`)).status === 404, 'static: extra segments on a leaf route → 404')
  const dot = await fetch(`${base}/.env`, { headers: { Accept: 'text/html' } })
  ok(dot.status === 404 && !(dot.headers.get('content-type') ?? '').startsWith('text/html'), 'static: dot-path probe → plain 404')
  ok((await fetch(`${base}/assets/missing.js`)).status === 404, 'static: missing asset → 404')
  ok((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status !== 200 || !(await (await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).text()).includes('root:'), 'static: no path traversal')
  const etag = js.headers.get('etag')!
  ok((await fetch(`${base}/assets/app-abc123.js`, { headers: { 'If-None-Match': etag } })).status === 304, 'static: ETag → 304')
  ok((await fetch(`${base}/api/health`)).status === 200, 'static mode still routes /api')
  await hub.close()
  fs.rmSync(dist, { recursive: true, force: true })
}

try {
  unit()
  await coordinatorFlow()
  await payoutLedgerFlow()
  await coverageFlow()
  await fillFlow()
  await budgetFlow()
  await broadcastFlow()
  await accountsFlow()
  await issuanceLogFlow()
  await trainFlow()
  if (process.argv.includes('e2e')) {
    await e2e()
    await staticServing()
  }
  console.log(`\nall ${passed} checks passed`)
  clearInterval(keepAlive)
  process.exit(0)
} catch (e) {
  console.error('FAIL ', e)
  process.exit(1)
}
