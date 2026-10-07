// LUSCA server entry.
//
//   crawler (8 arms × agents) ──onText──▶ trainer (SEPIA-0)
//      │  vectors / markSemanticDup             │
//      ▼                                        │
//   coordinator (GPU neurons, INK ledger)       │
//      │  PayoutLedger            auth (wallet sign-in tokens)
//      ▼                                        │
//   payouts (SOL per period) ──onUpdate──┐      │
//      └────────────── emit ─────────────┼──────┘
//                                        ▼
//                          hub (REST + /ws + static dist/)
//
// Env: PORT (8787) · LUSCA_AGENTS (24) · LUSCA_PACE (1) · LUSCA_DATA (server/data)
//      LUSCA_DATASET_MAX_MB (2048; rotate dataset.jsonl into an archive past this, 0 = never)
//      LUSCA_DATASET_KEEP (0 = keep every archive; else delete the oldest beyond N)
//      HOST (127.0.0.1) · LUSCA_CORS_ORIGINS (comma list)
//      LUSCA_TRUST_PROXY (0; N ≥ 1 = read X-Forwarded-For: skipping trusted proxy hops from the
//      right, the N-th untrusted entry is the client — 1 = rightmost untrusted)
//      LUSCA_TRUSTED_PROXIES (comma list of IPs / CIDRs / keywords loopback, private, cloudflare;
//      default loopback + private ranges)
//      LUSCA_MAX_CLIENTS (1000) · LUSCA_MAX_CLIENTS_PER_IP (16) · LUSCA_TOTAL_BUFFER_MB (128)
//      LUSCA_HARD_BUFFER_MB (8) · LUSCA_WS_MAX_KBPS (24 KB/s broadcast stream per client, 0 = off)
//      LUSCA_API_READS_PER_MIN (120; /api/ledger, /api/neurons, traces per address)
//      LUSCA_CSP (on | report | off) · LUSCA_HSTS_MAX_AGE (31536000 s; 0 = off)
//      LUSCA_HEALTH_LAG_MS (500) · LUSCA_HEALTH_CKPT_MIN (10) · LUSCA_HEALTH_DISK_PCT (10)
//      LUSCA_REQUIRE_DISK=1 (refuse to boot unless LUSCA_DATA is on its own mount)
//      LUSCA_SHUTDOWN_TIMEOUT_S (25; force exit after this, above the crawler's 15 s drain)
//      LUSCA_LEDGER_RESET=1 (start a fresh INK ledger when ledger.json is unreadable)
//      LUSCA_AUTH_SECRET (wallet session-token HMAC key; unset → generated once into <data>/auth.secret)
//      LUSCA_PUBLIC_HOST (host named in the sign-in message; default: the request Host header)
//      LUSCA_PAYOUTS (off | dryrun | live) · LUSCA_SOLANA_RPC · LUSCA_SOLANA_CLUSTER
//      LUSCA_TREASURY_SECRET · LUSCA_TREASURY_ADDRESS · LUSCA_PAYOUT_EVERY_H (12) · LUSCA_PAYOUT_SHARE (0.5)
//      LUSCA_PAYOUT_RESERVE_SOL (0.05) · LUSCA_PAYOUT_MAX_SOL (5) · LUSCA_PAYOUT_MAX_WALLET_SOL (1)
//      LUSCA_PAYOUT_MIN_SOL (0.001) — see server/payouts/config.ts
//      LUSCA_CODE_INDEX (1; 0 = off) · LUSCA_CODE_MAX_MB (150; compressed shards under <data>/code)
//      — protocol code index for SEPIA-1, see server/codebase
//      LUSCA_CHAIN_AGENTS (1; 0 = off, stored chain data still served) · LUSCA_SOLANA_DISCOVERY_RPC
//      LUSCA_ETH_RPC · LUSCA_BASE_RPC · LUSCA_ARB_RPC · LUSCA_CHAIN_MAX_MB (100) — chain agents
//      (programs / contracts found on-chain, read, kept or rejected), see server/chain/index.ts
//      LUSCA_RADAR (1; 0 = off) · LUSCA_RADAR_BACKFILL — upgrade radar (code changes caught live), see server/radar
//      NODE_ENV=development disables static serving of dist/.
//
// One process per data directory: <data>/.lock holds the owner's pid (refreshed every
// 10 s); a second server pointed at the same directory waits up to 20 s, then refuses.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIngest } from './ingest/pipeline.ts'
import { BOT_CONTACT } from './ingest/util.ts'
import { createTrainer } from './trainer/trainer.ts'
import { createCoordinator } from './neurons/coordinator.ts'
import { createAuth, type Auth } from './auth/auth.ts'
import { resolvePayoutConfig } from './payouts/config.ts'
import { createPayouts } from './payouts/index.ts'
import { createCodeIndex } from './codebase/index.ts'
import { createChainAgents } from './chain/index.ts'
import { createWeightsExporter } from './model/export.ts'
import { createProofs, resolveEpochMinutes, type ProofsApi } from './proofs/index.ts'
import { payoutPreviewSource } from './proofs/preview.ts'
import { loadHashSalt } from './neurons/issuance.ts'
import { createHub, ansi, log, DEFAULT_HUB_LIMITS, type HealthReport } from './http.ts'
import type { CrawlerApi, TrainerApi } from './contracts.ts'
import type { LuscaCoordinator } from './neurons/coordinator.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BOOT_AT = Date.now()

function intEnv(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return def
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    log.warn('env', `${name}=${raw} is not a number; using ${def}`)
    return def
  }
  return Math.min(max, Math.max(min, Math.round(n)))
}

function floatEnv(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return def
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    log.warn('env', `${name}=${raw} is not a number; using ${def}`)
    return def
  }
  return Math.min(max, Math.max(min, n))
}

const PORT = intEnv('PORT', 8787, 0, 65535)
const TRUST_PROXY = /^(true|yes)$/i.test(process.env.LUSCA_TRUST_PROXY?.trim() ?? '') ? 1 : intEnv('LUSCA_TRUST_PROXY', 0, 0, 16)
const TRUSTED_PROXIES = (process.env.LUSCA_TRUSTED_PROXIES ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
const MB = 1024 * 1024
const MAX_CLIENTS = intEnv('LUSCA_MAX_CLIENTS', DEFAULT_HUB_LIMITS.maxClients, 1, 100_000)
const MAX_CLIENTS_PER_IP = intEnv('LUSCA_MAX_CLIENTS_PER_IP', DEFAULT_HUB_LIMITS.maxClientsPerIp, 1, 100_000)
const TOTAL_BUFFER_MB = floatEnv('LUSCA_TOTAL_BUFFER_MB', DEFAULT_HUB_LIMITS.totalBufferBytes / MB, 1, 65_536)
const HARD_BUFFER_MB = floatEnv('LUSCA_HARD_BUFFER_MB', DEFAULT_HUB_LIMITS.hardBufferBytes / MB, 1, 4_096)
const WS_MAX_KBPS = floatEnv('LUSCA_WS_MAX_KBPS', DEFAULT_HUB_LIMITS.wsMaxBytesPerSec / 1024, 0, 1_000_000)
const API_READS_PER_MIN = intEnv('LUSCA_API_READS_PER_MIN', DEFAULT_HUB_LIMITS.readsPerMin, 1, 100_000)
const CSP_MODE = ((): 'on' | 'report' | 'off' => {
  const v = (process.env.LUSCA_CSP ?? '').trim().toLowerCase()
  if (v === '' || v === 'on' || v === '1' || v === 'true') return 'on'
  if (v === 'report' || v === 'report-only') return 'report'
  if (v === 'off' || v === '0' || v === 'false') return 'off'
  log.warn('env', `LUSCA_CSP=${v} is not on / report / off; using on`)
  return 'on'
})()
const HSTS_MAX_AGE = intEnv('LUSCA_HSTS_MAX_AGE', 31_536_000, 0, 63_072_000)
const HEALTH_LAG_MS = intEnv('LUSCA_HEALTH_LAG_MS', DEFAULT_HUB_LIMITS.lagP99Ms, 10, 600_000)
const HEALTH_CKPT_MIN = floatEnv('LUSCA_HEALTH_CKPT_MIN', 10, 1, 10_080)
const HEALTH_DISK_PCT = floatEnv('LUSCA_HEALTH_DISK_PCT', 10, 0, 100)
const REQUIRE_DISK = /^(1|true|yes)$/i.test(process.env.LUSCA_REQUIRE_DISK?.trim() ?? '')
// The crawler waits up to 15 s for in-flight fetches on stop: the force exit must come later.
const SHUTDOWN_TIMEOUT_S = intEnv('LUSCA_SHUTDOWN_TIMEOUT_S', 25, 5, 3_600)
const AGENTS = intEnv('LUSCA_AGENTS', 24, 1, 64) // the crawler caps agents at 64
const PACE = floatEnv('LUSCA_PACE', 1, 0, 20)
const DATASET_MAX_MB = intEnv('LUSCA_DATASET_MAX_MB', 2048, 0, 1_048_576)
const DATASET_KEEP = intEnv('LUSCA_DATASET_KEEP', 0, 0, 100_000)
const CODE_INDEX = !/^(0|false|no|off)$/i.test(process.env.LUSCA_CODE_INDEX?.trim() ?? '')
const CODE_MAX_MB = floatEnv('LUSCA_CODE_MAX_MB', 150, 1, 100_000)
const DATA_DIR = path.resolve(process.env.LUSCA_DATA?.trim() || path.join(ROOT, 'server', 'data'))
const DIST_DIR = path.join(ROOT, 'dist')
// default to loopback; set HOST=0.0.0.0 to expose on your LAN
const HOST = process.env.HOST?.trim() || '127.0.0.1'
const DEV = process.env.NODE_ENV === 'development'

// ─── process robustness ─────────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  log.error('process', 'unhandled rejection:', reason instanceof Error ? (reason.stack ?? reason.message) : reason)
})
process.on('uncaughtException', (err) => {
  log.error('process', 'uncaught exception:', err?.stack ?? err)
})

// ─── data-dir lock ──────────────────────────────────────────────────────────

const LOCK_WAIT_MS = 20_000 // a restarting server (tsx watch) may still be shutting down
const LOCK_REFRESH_MS = 10_000
const LOCK_STALE_MS = 35_000 // not refreshed for this long → the owner is gone (or its pid was reused)

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Exclusive lock on the data directory so two servers never overwrite each other's
 * ledger.json / sepia.ckpt / dataset.jsonl. Returns a release function.
 */
function lockDataDir(dir: string): () => void {
  const lockPath = path.join(dir, '.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  let warned = false
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      try {
        fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`)
      } finally {
        fs.closeSync(fd)
      }
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    let pid = NaN
    let age = 0
    try {
      pid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10)
      age = Date.now() - fs.statSync(lockPath).mtimeMs
    } catch {
      continue // vanished meanwhile: retry
    }
    const fresh = age < LOCK_STALE_MS
    // An empty / half-written lock that is seconds old belongs to a server starting right now.
    const held = Number.isInteger(pid) && pid > 0 ? pid !== process.pid && pidAlive(pid) && fresh : age < 5_000
    if (!held) {
      log.warn('boot', `removing stale lock ${lockPath} (pid ${Number.isNaN(pid) ? '?' : pid})`)
      try {
        fs.rmSync(lockPath, { force: true })
      } catch {
        /* retry */
      }
      continue
    }
    if (Date.now() >= deadline) throw new Error(`data directory ${dir} is in use by another LUSCA server (pid ${pid}); set LUSCA_DATA to a different directory`)
    if (!warned) {
      warned = true
      log.warn('boot', `data directory locked by pid ${pid} — waiting up to ${LOCK_WAIT_MS / 1000} s for it to exit…`)
    }
    sleepSync(500)
  }
  const refresh = setInterval(() => {
    try {
      const now = new Date()
      fs.utimesSync(lockPath, now, now)
    } catch {
      /* removed by an operator: nothing to refresh */
    }
  }, LOCK_REFRESH_MS)
  refresh.unref()
  let released = false
  return () => {
    if (released) return
    released = true
    clearInterval(refresh)
    try {
      if (parseInt(fs.readFileSync(lockPath, 'utf8'), 10) === process.pid) fs.rmSync(lockPath, { force: true })
    } catch {
      /* already gone */
    }
  }
}

// ─── persistent disk ────────────────────────────────────────────────────────

/**
 * LUSCA_REQUIRE_DISK=1: the data directory must live on a different filesystem than the
 * app (a mounted persistent disk). Otherwise a platform deploy without the disk would
 * write the INK ledger to ephemeral storage and lose it on the next deploy.
 */
function checkDataDisk(): void {
  let dataDev: number
  let appDev: number
  try {
    dataDev = fs.statSync(DATA_DIR).dev
    appDev = fs.statSync(ROOT).dev
  } catch (e) {
    log.error('boot', `LUSCA_REQUIRE_DISK=1 but the data / app directory cannot be inspected: ${(e as Error).message}`)
    process.exit(1)
  }
  if (dataDev === appDev) {
    log.error(
      'boot',
      `LUSCA_REQUIRE_DISK=1 but LUSCA_DATA (${DATA_DIR}) is on the same filesystem as the app (${ROOT}, device ${appDev}). ` +
        'The persistent disk is not mounted there — refusing to start so the ledger is not written to ephemeral storage.',
    )
    process.exit(1)
  }
  log.info('boot', `data dir is on its own mount (device ${dataDev}; app on ${appDev})`)
}

// Fetch agents identify an operator contact to site owners (UA, From:, /privacy, /terms).
if (!DEV && !BOT_CONTACT) {
  log.warn('boot', 'LUSCA_BOT_CONTACT is not set: LuscaBot sends no From: header and /privacy, /terms list no takedown contact. Set it to a monitored e-mail address.')
}

// ─── health checks (merged into /api/health) ─────────────────────────────────

/** Fed from the coordinator's log sink: the ledger has no status API, its log lines are the signal. */
const ledgerState = { failingSince: 0, lastError: '', disabled: false }

function noteCoordinatorLog(msg: string) {
  if (/ledger save failed/i.test(msg)) {
    if (!ledgerState.failingSince) ledgerState.failingSince = Date.now()
    ledgerState.lastError = msg.slice(0, 200)
  } else if (/without ledger saves/i.test(msg)) {
    ledgerState.disabled = true
    ledgerState.lastError = msg.slice(0, 200)
  }
}

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

let diskCache: { at: number; v: { freePct: number; freeMB: number; totalMB: number } | null } | null = null
function diskStats() {
  const now = Date.now()
  if (diskCache && now - diskCache.at < 30_000) return diskCache.v
  let v: { freePct: number; freeMB: number; totalMB: number } | null = null
  try {
    const s = fs.statfsSync(DATA_DIR)
    const total = s.blocks * s.bsize
    const free = s.bavail * s.bsize
    if (total > 0) v = { freePct: Math.round((free / total) * 1000) / 10, freeMB: Math.round(free / 1048576), totalMB: Math.round(total / 1048576) }
  } catch {
    v = null // statfs unsupported here: the check is skipped
  }
  diskCache = { at: now, v }
  return v
}

/** Contribution epochs (server/proofs), for the health report. */
let proofsRef: ProofsApi | null = null

function healthReport(trainer: TrainerApi): HealthReport {
  const now = Date.now()
  const degraded: string[] = []
  const proofs = proofsRef ? proofsRef.status() : null
  if (proofs && !proofs.ok) degraded.push(proofs.state === 'off' ? 'proofs-off' : 'proof-chain-broken')
  if (proofs?.stalled) degraded.push('proof-epoch-stalled')

  // A save that landed after the failure clears it.
  if (ledgerState.failingSince && mtimeMs(path.join(DATA_DIR, 'ledger.json')) > ledgerState.failingSince) {
    ledgerState.failingSince = 0
    ledgerState.lastError = ''
  }
  if (ledgerState.disabled) degraded.push('ledger-saves-disabled')
  else if (ledgerState.failingSince) degraded.push('ledger-save-failing')

  // The trainer checkpoints every 90 s while it makes progress; only a training model can go stale.
  let training = false
  try {
    training = trainer.info().stepsPerSec > 0
  } catch {
    /* trainer unavailable: no verdict */
  }
  const ckpt = mtimeMs(path.join(DATA_DIR, 'sepia.ckpt'))
  const limitMs = HEALTH_CKPT_MIN * 60_000
  if (training && now - Math.max(ckpt, BOOT_AT) > limitMs) degraded.push('checkpoint-stale')

  const disk = diskStats()
  if (disk && disk.freePct < HEALTH_DISK_PCT) degraded.push('disk-low')

  return {
    degraded,
    checks: {
      ledger: {
        saving: !ledgerState.disabled && !ledgerState.failingSince,
        failingForS: ledgerState.failingSince ? Math.round((now - ledgerState.failingSince) / 1000) : 0,
        disabled: ledgerState.disabled,
        lastError: ledgerState.lastError || null,
      },
      checkpoint: { ageS: ckpt ? Math.round((now - ckpt) / 1000) : null, training, limitS: Math.round(limitMs / 1000) },
      disk: disk ? { ...disk, minPct: HEALTH_DISK_PCT } : null,
      proofs,
    },
  }
}

// ─── boot ───────────────────────────────────────────────────────────────────

let PAYOUT_MODE = 'off'

function banner(port: number, serving: boolean) {
  const art = [
    '  _      _    _  _____  _____          ',
    ' | |    | |  | |/ ____|/ ____|   /\\    ',
    ' | |    | |  | | (___ | |       /  \\   ',
    ' | |    | |  | |\\___ \\| |      / /\\ \\  ',
    ' | |____| |__| |____) | |____ / ____ \\ ',
    ' |______|\\____/|_____/ \\_____/_/    \\_\\',
  ]
  const lan: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) lan.push(ni.address)
  }
  const row = (k: string, v: string) => `   ${ansi.dim('>')} ${k.padEnd(9)} ${v}`
  const lines = [
    '',
    ...art.map((l) => ansi.orange(l)),
    '',
    `   ${ansi.bold('the crypto web, tasted by eight arms')}  ${ansi.dim(`· ${AGENTS} agents · pace ${PACE} · node ${process.version}`)}`,
    '',
    serving
      ? row('App', ansi.orange(`http://localhost:${port}`))
      : row('App', `${ansi.orange('http://localhost:5173')} ${ansi.dim('(vite dev — npm run dev:web; or npm run build to serve here)')}`),
    row('API', `http://localhost:${port}/api/hello`),
    row('Health', `http://localhost:${port}/api/health`),
    row('Socket', `ws://localhost:${port}/ws`),
    row('Payouts', PAYOUT_MODE),
    ...(HOST && HOST !== '0.0.0.0' && HOST !== '::' ? [] : lan.slice(0, 3).map((ip) => row('Network', `http://${ip}:${port}`))),
    row('Data', DATA_DIR),
    '',
  ]
  console.log(lines.join('\n'))
}

async function main() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch (e) {
    log.error('boot', `cannot create data dir ${DATA_DIR}:`, (e as Error).message)
    process.exit(1)
  }
  if (REQUIRE_DISK) checkDataDisk()
  let releaseLock: () => void
  try {
    releaseLock = lockDataDir(DATA_DIR)
  } catch (e) {
    log.error('boot', (e as Error).message)
    process.exit(1)
  }

  let trainer: TrainerApi
  const hub = createHub({
    distDir: DIST_DIR,
    trustProxy: TRUST_PROXY,
    trustedProxies: TRUSTED_PROXIES,
    corsOrigins: (process.env.LUSCA_CORS_ORIGINS ?? '').split(',').filter(Boolean),
    limits: {
      maxClients: MAX_CLIENTS,
      maxClientsPerIp: MAX_CLIENTS_PER_IP,
      totalBufferBytes: Math.round(TOTAL_BUFFER_MB * MB),
      hardBufferBytes: Math.round(HARD_BUFFER_MB * MB),
      wsMaxBytesPerSec: Math.round(WS_MAX_KBPS * 1024),
      readsPerMin: API_READS_PER_MIN,
      lagP99Ms: HEALTH_LAG_MS,
    },
    security: { csp: CSP_MODE, hstsMaxAge: HSTS_MAX_AGE },
    health: () => healthReport(trainer),
  })

  let crawler: CrawlerApi
  let coordinator: LuscaCoordinator
  let auth: Auth
  let payouts: ReturnType<typeof createPayouts>
  let payoutConfigRef: ReturnType<typeof resolvePayoutConfig> | null = null
  try {
    auth = createAuth({
      dataDir: DATA_DIR,
      secret: process.env.LUSCA_AUTH_SECRET ?? null,
      publicHost: process.env.LUSCA_PUBLIC_HOST ?? null,
      log: (level, msg) => log[level]('auth', msg),
    })
    trainer = createTrainer({ dataDir: DATA_DIR, emit: hub.emit })
    crawler = createIngest({
      agents: AGENTS,
      dataDir: DATA_DIR,
      pace: PACE,
      datasetMaxMB: DATASET_MAX_MB,
      datasetKeep: DATASET_KEEP,
      emit: hub.emit,
      onText: (text) => {
        try {
          trainer.feed(text)
        } catch (e) {
          log.error('trainer', 'feed failed:', (e as Error)?.message ?? e)
        }
      },
    })
    coordinator = createCoordinator({
      crawler,
      emit: hub.emit,
      dataDir: DATA_DIR,
      trainer, // SEPIA gradient jobs for neurons advertising caps.train
      log: (level, msg) => {
        noteCoordinatorLog(msg)
        log[level]('neurons', msg)
      },
      auth,
    })
    const payoutConfig = resolvePayoutConfig(process.env)
    payoutConfigRef = payoutConfig
    PAYOUT_MODE = payoutConfig.mode
    payouts = createPayouts({
      ledger: coordinator.payouts,
      dataDir: DATA_DIR,
      config: payoutConfig,
      log: (level, msg) => log[level]('payouts', msg),
      onUpdate: (overview) => hub.emit({ t: 'payout', overview }),
    })
  } catch (e) {
    // A module that cannot even be constructed is a deployment bug, not a runtime hiccup.
    log.error('boot', 'failed to construct modules:', (e as Error)?.stack ?? e)
    process.exit(1)
  }
  // Protocol code index (optional): a failure here never blocks the rest of the server.
  let codeIndex: ReturnType<typeof createCodeIndex> | undefined
  if (CODE_INDEX) {
    try {
      codeIndex = createCodeIndex({ dataDir: DATA_DIR, log: (level, msg) => log[level]('code', msg), maxMb: CODE_MAX_MB })
    } catch (e) {
      log.error('code', 'code index unavailable:', (e as Error)?.message ?? e)
    }
  }
  // Chain agents (optional): find programs / contracts on-chain by themselves, read, keep or reject.
  // LUSCA_CHAIN_AGENTS=0 stops the agents inside the module; its stored data is still served.
  let chainAgents: ReturnType<typeof createChainAgents> | undefined
  try {
    // LUSCA_SOLANA_RPC (Helius on Render) is shared with payouts. Program reads must hit mainnet:
    // a devnet / testnet URL there is ignored and reads use the public mainnet RPC. The URL carries
    // a key and is never logged.
    let solanaRpc = process.env.LUSCA_SOLANA_RPC?.trim() ?? ''
    if (solanaRpc && /devnet|testnet/i.test(solanaRpc)) {
      log.warn('chain', 'LUSCA_SOLANA_RPC is not a mainnet endpoint; chain agents read programs over the public mainnet RPC')
      solanaRpc = ''
    }
    const evm = (k: string) => process.env[k]?.trim() || undefined
    chainAgents = createChainAgents({
      solanaRpc, // '' → the public mainnet RPC (server/chain/rpc.ts)
      solanaDiscoveryRpc: evm('LUSCA_SOLANA_DISCOVERY_RPC'),
      evmRpcs: { ethereum: evm('LUSCA_ETH_RPC'), base: evm('LUSCA_BASE_RPC'), arbitrum: evm('LUSCA_ARB_RPC') },
      dataDir: DATA_DIR,
      log: (level, msg) => log[level]('chain', msg),
      broadcast: (msg) => hub.emit(msg),
      broadcastRadar: (msg) => hub.emit(msg),
    })
  } catch (e) {
    log.error('chain', 'chain agents unavailable:', (e as Error)?.message ?? e)
  }
  // `code` serves GET /api/code/stats (CodeIndexStats); undefined when LUSCA_CODE_INDEX=0.
  // `chain` serves GET /api/chain/* from stored reads (no RPC per request).
  // SEPIA-0 public weights (GET /api/model/weights.safetensors, /api/model/manifest.json), rebuilt from
  // <LUSCA_DATA>/sepia.ckpt at most every 10 min. LUSCA_WEIGHTS_LICENSE sets the license field (default MIT).
  const modelExport = createWeightsExporter({
    ckptPath: path.join(DATA_DIR, 'sepia.ckpt'),
    license: process.env.LUSCA_WEIGHTS_LICENSE?.trim() || 'MIT',
    log: (level, msg) => log[level]('model', msg),
  })
  let proofs: ProofsApi | undefined
  try {
    proofs = createProofs({
      dataDir: DATA_DIR,
      epochs: coordinator.epochs,
      salt: loadHashSalt(DATA_DIR, process.env.LUSCA_HASH_SALT, (level, msg) => log[level]('proofs', msg)),
      epochMinutes: resolveEpochMinutes(process.env),
      checkToken: (t) => auth.checkToken(t),
      allowRestart: process.env.LUSCA_PROOFS_RESTART === '1',
      log: (level, msg) => log[level]('proofs', msg),
    })
    proofs.start() // verifies the stored chain (or writes genesis) before the server listens
    proofsRef = proofs
  } catch (e) {
    log.error('proofs', 'contribution proofs unavailable:', (e as Error)?.stack ?? e)
    proofs = undefined
  }
  const proofsModule = proofs ? { api: proofs, preview: (payoutConfigRef ? payoutPreviewSource(coordinator, payoutConfigRef) : null) } : undefined
  const modules = { crawler, trainer, coordinator, auth, payouts, code: codeIndex, chain: chainAgents, model: modelExport, proofs: proofsModule, lens: chainAgents?.lens, radar: chainAgents?.radar, radarDiff: chainAgents?.radarDiff, control: chainAgents?.control, atlas: chainAgents?.atlas, search: chainAgents?.search, advisory: chainAgents?.advisory }
  hub.bind(modules)

  let port: number
  try {
    port = await hub.listen(PORT, HOST)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') log.error('boot', `port ${PORT} is already in use — is another LUSCA server running? (set PORT=...)`)
    else log.error('boot', 'listen failed:', (e as Error)?.message ?? e)
    await coordinator.stop().catch(() => undefined)
    releaseLock()
    process.exit(1)
  }

  banner(port, !DEV && fs.existsSync(path.join(DIST_DIR, 'index.html')))

  try {
    trainer.start()
  } catch (e) {
    log.error('trainer', 'start failed:', (e as Error)?.stack ?? e)
  }
  try {
    crawler.start()
  } catch (e) {
    log.error('crawler', 'start failed:', (e as Error)?.stack ?? e)
  }
  try {
    payouts.start()
  } catch (e) {
    log.error('payouts', 'start failed:', (e as Error)?.stack ?? e)
  }
  try {
    codeIndex?.start() // first repository after 30 s, then one at a time
  } catch (e) {
    log.error('code', 'start failed:', (e as Error)?.stack ?? e)
  }
  try {
    chainAgents?.start() // discovery samples blocks at once; the first read about 20 s later
  } catch (e) {
    log.error('chain', 'start failed:', (e as Error)?.stack ?? e)
  }

  // ── graceful shutdown ──
  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) {
      log.warn('process', `${signal} again — forcing exit`)
      coordinator.flushSync()
      process.exit(1)
    }
    stopping = true
    log.info('process', `${signal} — checkpointing and shutting down…`)
    const force = setTimeout(() => {
      log.error('process', `shutdown took longer than ${SHUTDOWN_TIMEOUT_S} s — forcing exit`)
      coordinator.flushSync()
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_S * 1000)
    force.unref()
    const step = async (name: string, fn: () => Promise<void> | void) => {
      try {
        await fn()
      } catch (e) {
        log.error('process', `${name} failed during shutdown:`, (e as Error)?.message ?? e)
      }
    }
    await step('hub', () => hub.close())
    // Payouts first: an in-flight period close / send settles before the ledger's final save.
    await Promise.all([
      step('payouts', () => payouts.stop()),
      step('crawler', () => crawler.stop()),
      step('trainer', () => trainer.stop()),
      step('code', () => codeIndex?.stop()), // aborts an in-flight download; committed shards stay
      step('chain', () => chainAgents?.stop()), // aborts in-flight RPC; index, frontier, feed and budgets saved
    ])
    await step('proofs', () => proofs?.stop())
    await step('coordinator', () => coordinator.stop())
    log.info('process', 'bye.')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  if (process.platform === 'win32') process.on('SIGBREAK', () => void shutdown('SIGBREAK'))
  // Last-chance ledger save if something calls process.exit elsewhere; then free the data dir.
  process.on('exit', () => {
    coordinator.flushSync()
    releaseLock()
  })
}

void main().catch((e) => {
  log.error('boot', 'fatal:', (e as Error)?.stack ?? e)
  process.exit(1)
})
