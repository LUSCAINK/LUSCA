// Payout engine: closes UTC-aligned periods, plans the SOL split (plan.ts) and, in live mode,
// sends it from the treasury hot wallet with no double payment across crashes and restarts.
//
// Durability: every period is a file <data>/payouts/period-<id>.json, written temp → fsync →
// rename. Status: planned → sending → done | failed (live), or dryrun. A transaction's signature
// (and its signed bytes) is written BEFORE it is broadcast. On restart a 'sending' period re-checks
// every pending signature with getSignatureStatuses: a landed row is never resent; a row whose
// blockhash expired with an unknown signature is rebuilt with a new blockhash.
//
// dryrun plans, persists and publishes, and never signs or sends. The treasury key never leaves
// config.ts's signer closure and is never logged.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import type { PayoutRecord, PayoutsOverview, PeriodStatus, WalletPayoutRow, WalletPayouts } from '../../shared/payouts.ts'
import { base58Encode, isSolanaAddress } from '../../shared/base58.ts'
import type { PayoutLedger, PeriodSnapshotRow } from '../contracts.ts'
import { rulesFor, type PayoutConfig } from './config.ts'
import { batchRows, FEE_PER_SIGNATURE, LAMPORTS_PER_SOL, periodIdFor, periodStart, planPayout, poolFor, type PlanRow } from './plan.ts'

export { resolvePayoutConfig } from './config.ts'
export type { PayoutConfig } from './config.ts'

/** The subset of @solana/web3.js Connection the engine uses (a fake one is injected in tests). */
export interface ConnectionLike {
  getBalance(publicKey: PublicKey, commitment?: 'confirmed'): Promise<number>
  getLatestBlockhash(commitment?: 'confirmed'): Promise<{ blockhash: string; lastValidBlockHeight: number }>
  getBlockHeight(commitment?: 'confirmed'): Promise<number>
  sendRawTransaction(raw: Buffer | Uint8Array, opts?: { skipPreflight?: boolean; maxRetries?: number; preflightCommitment?: 'confirmed' }): Promise<string>
  getSignatureStatuses(
    sigs: string[],
    cfg?: { searchTransactionHistory: boolean },
  ): Promise<{ value: ({ err: unknown; confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null } | null)[] }>
}

type Level = 'info' | 'warn' | 'error'

export interface PayoutsOptions {
  ledger: PayoutLedger
  dataDir: string
  config: PayoutConfig
  log: (level: Level, msg: string) => void
  onUpdate: (overview: PayoutsOverview) => void
  connection?: ConnectionLike
  /** Clock (tests). */
  now?: () => number
  /** Signature status poll interval (default 2 s). */
  pollMs?: number
  /** Engine tick interval (default min(15 s, period / 6)). */
  tickMs?: number
  /** Treasury balance refresh interval (default 60 s). */
  balanceMs?: number
}

export interface Payouts {
  start(): void
  stop(): Promise<void>
  overview(): PayoutsOverview
  wallet(address: string): WalletPayouts
  /** Run one engine cycle now: recovery (first call), close a due period, settle open sends. */
  tick(): Promise<void>
}

type RowState = 'unsent' | 'pending' | 'sent' | 'carried' | 'failed'
interface FileRow extends PlanRow {
  state: RowState
  /** Signature of the transaction currently carrying the row. */
  tx: string | null
  attempts: number
}
type TxState = 'pending' | 'confirmed' | 'failed' | 'expired'
interface FileTx {
  sig: string
  rows: number[]
  blockhash: string
  lastValidBlockHeight: number
  /** Signed transaction (base64) so a restart can rebroadcast the same signature. Not secret. */
  raw: string
  state: TxState
  createdAt: number
}
interface PeriodFile {
  v: 1
  id: string
  startsAt: number
  endsAt: number
  closedAt: number
  mode: 'dryrun' | 'live'
  status: PeriodStatus
  treasury: string | null
  balanceLamports: number | null
  feeLamports: number
  poolLamports: number
  totalInk: number
  snapshot: PeriodSnapshotRow[]
  carry: Record<string, number>
  rows: FileRow[]
  txs: FileTx[]
}

const MAX_ATTEMPTS = 3
const HISTORY_CAP = 30
const WALLET_HISTORY_CAP = 50
const PERIODS_IN_MEMORY = 400

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const fmt = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(6).replace(/\.?0+$/, '')

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

export function createPayouts(opts: PayoutsOptions): Payouts {
  const { ledger, config, log, onUpdate } = opts
  const now = opts.now ?? Date.now
  const pollMs = opts.pollMs ?? 2_000
  const tickMs = opts.tickMs ?? Math.max(1_000, Math.min(15_000, Math.floor(config.everyMs / 6)))
  const balanceMs = opts.balanceMs ?? 60_000
  const dir = join(opts.dataDir, 'payouts')
  const conn: ConnectionLike = opts.connection ?? new Connection(config.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: false })
  const treasuryPk = config.treasuryAddress ? new PublicKey(config.treasuryAddress) : null

  const periods = new Map<string, PeriodFile>()
  let balance: number | null = null
  let balanceAt: number | null = null
  let stale = false
  let recovered = false
  let stopped = false
  let running: Promise<void> | null = null
  let firstBoundary: number | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null
  let balTimer: ReturnType<typeof setInterval> | null = null

  // ---- persistence ------------------------------------------------------------------------
  const fileOf = (id: string) => join(dir, `period-${id}.json`)
  function save(p: PeriodFile): void {
    mkdirSync(dir, { recursive: true })
    writeAtomic(fileOf(p.id), JSON.stringify(p))
    periods.set(p.id, p)
  }
  function load(): void {
    if (!existsSync(dir)) return
    const names = readdirSync(dir)
      .filter((n) => /^period-.+\.json$/.test(n))
      .sort()
    for (const n of names.slice(-PERIODS_IN_MEMORY)) {
      try {
        const p = JSON.parse(readFileSync(join(dir, n), 'utf8')) as PeriodFile
        if (p && p.v === 1 && typeof p.id === 'string' && Array.isArray(p.rows)) periods.set(p.id, p)
      } catch (e) {
        log('error', `payouts: cannot read ${n} (${(e as Error).message}) — skipped`)
      }
    }
  }
  const sorted = () => [...periods.values()].sort((a, b) => b.endsAt - a.endsAt)

  // ---- treasury balance -------------------------------------------------------------------
  async function refreshBalance(): Promise<boolean> {
    if (!treasuryPk) return false
    try {
      const b = await conn.getBalance(treasuryPk, 'confirmed')
      if (!Number.isFinite(b)) throw new Error('bad balance')
      if (stale) log('info', 'payouts: treasury balance refresh recovered')
      balance = b
      balanceAt = now()
      stale = false
      return true
    } catch (e) {
      if (!stale) log('warn', `payouts: treasury balance refresh failed (${(e as Error).message.slice(0, 120)}) — keeping the last value`)
      stale = true
      return false
    }
  }

  // ---- overview -----------------------------------------------------------------------------
  function record(p: PeriodFile): PayoutRecord {
    // Settled live periods count what was sent; dryrun and in-flight periods count what is planned.
    const settled = p.mode === 'live' && (p.status === 'done' || p.status === 'failed')
    const counted = p.rows.filter((r) => (settled ? r.state === 'sent' : r.lamports > 0 && r.state !== 'failed'))
    return {
      id: p.id,
      closedAt: p.closedAt,
      poolSol: counted.reduce((s, r) => s + r.lamports, 0) / LAMPORTS_PER_SOL,
      ink: Math.round(counted.reduce((s, r) => s + r.paidInk, 0) * 1e6) / 1e6,
      wallets: counted.length,
      txs: p.txs.filter((t) => t.state === 'confirmed').map((t) => t.sig),
      status: p.status,
    }
  }

  function overview(): PayoutsOverview {
    const t = now()
    let period: PayoutsOverview['period'] = null
    if (config.mode !== 'off') {
      const startsAt = periodStart(t, config.everyMs)
      const snap = ledger.periodSnapshot()
      const inkSoFar = Math.round(snap.reduce((s, r) => s + r.ink, 0) * 1e6) / 1e6
      period = {
        id: periodIdFor(startsAt),
        startsAt,
        endsAt: startsAt + config.everyMs,
        inkSoFar,
        wallets: snap.length,
        estPoolSol: poolFor(balance, snap.length, config.rules).poolLamports / LAMPORTS_PER_SOL,
      }
    }
    return {
      mode: config.mode,
      cluster: config.cluster,
      treasury: { address: config.treasuryAddress, balanceSol: balance === null ? null : balance / LAMPORTS_PER_SOL, updatedAt: balanceAt, stale },
      period,
      history: sorted().slice(0, HISTORY_CAP).map(record),
      rules: rulesFor(config),
      at: t,
    }
  }

  function wallet(address: string): WalletPayouts {
    const t = now()
    let period: WalletPayouts['period'] = null
    if (config.mode !== 'off') {
      const snap = ledger.periodSnapshot()
      const total = snap.reduce((s, r) => s + r.ink, 0)
      const ink = ledger.periodInk(address)
      const row = planPayout(balance, snap, config.rules).rows.find((r) => r.wallet === address)
      period = {
        id: periodIdFor(periodStart(t, config.everyMs)),
        ink,
        sharePct: total > 0 ? Math.round((ink / total) * 1e6) / 1e4 : 0,
        estSol: (row?.lamports ?? 0) / LAMPORTS_PER_SOL,
      }
    }
    let paid = 0
    const history: WalletPayoutRow[] = []
    for (const p of sorted()) {
      for (const r of p.rows) {
        if (r.wallet !== address) continue
        if (p.mode === 'live' && r.state === 'sent') paid += r.lamports
        if (history.length >= WALLET_HISTORY_CAP) continue
        let status: WalletPayoutRow['status']
        if (p.mode === 'dryrun') status = 'dryrun'
        else if (r.state === 'sent') status = 'sent'
        else if (r.state === 'carried' || r.state === 'failed' || r.lamports === 0) status = 'carried'
        else status = 'pending'
        history.push({
          periodId: p.id,
          closedAt: p.closedAt,
          ink: status === 'carried' ? r.ink : r.paidInk,
          sol: status === 'carried' ? 0 : r.lamports / LAMPORTS_PER_SOL,
          tx: status === 'carried' ? null : r.tx,
          status,
        })
      }
    }
    return {
      wallet: address,
      verified: ledger.isVerified(address),
      period,
      totalInk: ledger.lifetimeInk(address),
      paidSol: paid / LAMPORTS_PER_SOL,
      history,
    }
  }

  const publish = () => {
    try {
      onUpdate(overview())
    } catch (e) {
      log('warn', `payouts: onUpdate threw (${(e as Error).message})`)
    }
  }

  // ---- closing a period ---------------------------------------------------------------------
  async function closeDue(): Promise<PeriodFile | null> {
    if (config.mode === 'off') return null
    const t = now()
    const boundary = periodStart(t, config.everyMs)
    const last = ledger.lastClosed()
    if (last) {
      if (last.endsAt >= boundary) return null
    } else {
      if (firstBoundary === null) firstBoundary = boundary
      if (boundary <= firstBoundary) return null
    }
    const startsAt = boundary - config.everyMs
    const id = periodIdFor(startsAt)
    const existing = periods.get(id)
    if (existing && existing.txs.length > 0) {
      log('error', `payouts: period ${id} already has transactions on disk but the ledger did not record its close — not closing again`)
      return null
    }
    // Fresh balance for the plan. Live: a failed refresh defers the close to the next tick rather than
    // planning against a value that may predate the last payout or a withdrawal. Dryrun: last known value.
    if (treasuryPk) {
      const fresh = await refreshBalance()
      if (!fresh && config.mode === 'live') return null
    }
    const planBalance = config.mode === 'live' && !treasuryPk ? null : balance
    let file: PeriodFile | null = null
    ledger.closePeriod(id, boundary, (snapshot) => {
      const plan = planPayout(planBalance, snapshot, config.rules)
      const mode = config.mode === 'live' ? 'live' : 'dryrun'
      const rows: FileRow[] = plan.rows.map((r) => {
        const invalid = r.lamports > 0 && (!isSolanaAddress(r.wallet) || r.wallet === config.treasuryAddress)
        return {
          ...r,
          // An unpayable address keeps its INK: the whole row carries.
          lamports: invalid ? 0 : r.lamports,
          paidInk: invalid ? 0 : r.paidInk,
          carryInk: invalid ? r.ink : r.carryInk,
          state: r.lamports > 0 && !invalid ? 'unsent' : 'carried',
          tx: null,
          attempts: 0,
        }
      })
      const carry: Record<string, number> = {}
      for (const r of rows) if (r.carryInk > 0) carry[r.wallet] = r.carryInk
      const payable = rows.some((r) => r.state === 'unsent')
      file = {
        v: 1,
        id,
        startsAt,
        endsAt: boundary,
        closedAt: t,
        mode,
        status: mode === 'dryrun' ? 'dryrun' : payable ? 'planned' : 'done',
        treasury: config.treasuryAddress,
        balanceLamports: plan.balanceLamports,
        feeLamports: plan.feeLamports,
        poolLamports: plan.poolLamports,
        totalInk: plan.totalInk,
        snapshot,
        carry,
        rows,
        txs: [],
      }
      save(file)
      return carry
    })
    const p = file as PeriodFile | null
    if (!p) return null
    if (p.status !== 'planned') summary(p)
    publish()
    return p
  }

  function summary(p: PeriodFile): void {
    const pay = p.rows.filter((r) => r.lamports > 0)
    const sent = p.rows.filter((r) => r.state === 'sent')
    const carried = p.rows.filter((r) => r.carryInk > 0 || r.state === 'failed').length
    const bal = p.balanceLamports === null ? 'unknown' : `${fmt(p.balanceLamports)} SOL`
    if (p.mode === 'dryrun') {
      log('info', `payouts: period ${p.id} closed (dryrun): ${pay.length} wallets, ${fmt(pay.reduce((s, r) => s + r.lamports, 0))} SOL planned of a ${fmt(p.poolLamports)} SOL pool, ${p.totalInk} INK, ${carried} carried, treasury ${bal}`)
    } else {
      log('info', `payouts: period ${p.id} ${p.status}: ${sent.length}/${pay.length} wallets paid ${fmt(sent.reduce((s, r) => s + r.lamports, 0))} SOL in ${p.txs.filter((x) => x.state === 'confirmed').length} txs, pool ${fmt(p.poolLamports)} SOL, ${p.totalInk} INK, ${carried} carried, treasury ${bal}`)
    }
  }

  // ---- sending --------------------------------------------------------------------------------
  function buildTx(p: PeriodFile, idx: number[], blockhash: string, lastValidBlockHeight: number): FileTx {
    const signer = config.treasury
    if (!signer || !treasuryPk) throw new Error('no treasury signer')
    const tx = new Transaction({ feePayer: treasuryPk, blockhash, lastValidBlockHeight })
    for (const i of idx) tx.add(SystemProgram.transfer({ fromPubkey: treasuryPk, toPubkey: new PublicKey(p.rows[i].wallet), lamports: p.rows[i].lamports }))
    const sig = signer.sign(tx.serializeMessage())
    tx.addSignature(treasuryPk, Buffer.from(sig))
    const raw = tx.serialize()
    return { sig: base58Encode(sig), rows: idx, blockhash, lastValidBlockHeight, raw: Buffer.from(raw).toString('base64'), state: 'pending', createdAt: now() }
  }

  async function broadcast(tx: FileTx): Promise<void> {
    try {
      await conn.sendRawTransaction(Buffer.from(tx.raw, 'base64'), { skipPreflight: true, maxRetries: 0 })
    } catch (e) {
      // Not proof of anything: the status poll decides (landed / expired).
      const m = (e as Error).message ?? ''
      if (!/already been processed/i.test(m)) log('warn', `payouts: broadcast of ${tx.sig.slice(0, 12)}… failed (${m.slice(0, 120)}) — will re-check`)
    }
  }

  /** Wait for a pending tx to land, fail or expire. 'stopped' when the engine stops first. */
  async function settleTx(tx: FileTx): Promise<'confirmed' | 'failed' | 'expired' | 'stopped'> {
    let n = 0
    let rpcWarned = false
    while (!stopped) {
      try {
        const st = (await conn.getSignatureStatuses([tx.sig], { searchTransactionHistory: true })).value[0]
        // An error seen only at 'processed' may sit on a fork that is abandoned; the original tx can
        // still land until its blockhash expires, so only a confirmed error (or expiry) is final.
        const final = st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized'
        if (st && final) return st.err ? 'failed' : 'confirmed'
        if (!st || st.err) {
          const h = await conn.getBlockHeight('confirmed')
          if (h > tx.lastValidBlockHeight) {
            const again = (await conn.getSignatureStatuses([tx.sig], { searchTransactionHistory: true })).value[0]
            if (!again) return 'expired'
            if (again.err) return 'failed'
            if (again.confirmationStatus === 'confirmed' || again.confirmationStatus === 'finalized') return 'confirmed'
          } else if (!st && n % 3 === 0) {
            await broadcast(tx)
          }
        }
      } catch (e) {
        if (!rpcWarned) log('warn', `payouts: status check of ${tx.sig.slice(0, 12)}… failed (${(e as Error).message.slice(0, 120)}) — retrying`)
        rpcWarned = true
      }
      n++
      await sleep(pollMs)
    }
    return 'stopped'
  }

  function applyTxResult(p: PeriodFile, tx: FileTx, result: 'confirmed' | 'failed' | 'expired'): void {
    tx.state = result
    for (const i of tx.rows) {
      const r = p.rows[i]
      if (r.tx !== tx.sig) continue
      if (result === 'confirmed') r.state = 'sent'
      else {
        r.state = 'unsent'
        r.tx = null
      }
    }
    if (result !== 'confirmed') log('warn', `payouts: period ${p.id} tx ${tx.sig.slice(0, 12)}… ${result === 'failed' ? 'failed on-chain' : 'expired unconfirmed'} — its ${tx.rows.length} rows will be rebuilt`)
    save(p)
    if (result === 'confirmed') publish()
  }

  function finish(p: PeriodFile): void {
    // Rows out of attempts: mark failed (persisted first, at-most-once), then return their INK.
    const give: FileRow[] = []
    for (const r of p.rows) {
      if (r.state === 'unsent' && r.attempts >= MAX_ATTEMPTS) {
        r.state = 'failed'
        r.tx = null
        give.push(r)
      }
    }
    const open = p.rows.some((r) => r.state === 'unsent' || r.state === 'pending')
    if (open && give.length === 0) return
    if (!open) p.status = p.rows.some((r) => r.state === 'failed') ? 'failed' : 'done'
    save(p)
    for (const r of give) {
      try {
        ledger.carryBack(r.wallet, r.paidInk)
      } catch (e) {
        log('error', `payouts: carry-back for a failed row of period ${p.id} threw (${(e as Error).message})`)
      }
    }
    if (!open) {
      summary(p)
      publish()
    }
  }

  /**
   * A live period that can no longer be sent (payouts not live, or a different treasury key): settle
   * its in-flight transactions through the RPC (no key needed), then mark the rows that were never
   * sent as failed (persisted first) and return their INK to the wallets so it is paid next period.
   */
  async function abandonPeriod(p: PeriodFile, why: string): Promise<void> {
    log('error', `payouts: period ${p.id} is '${p.status}' but ${why} — settling in-flight txs and returning unsent INK`)
    for (const tx of p.txs) {
      if (tx.state !== 'pending') continue
      const res = await settleTx(tx)
      if (res === 'stopped') return
      applyTxResult(p, tx, res)
    }
    for (const r of p.rows) if (r.state === 'unsent') r.attempts = MAX_ATTEMPTS
    finish(p)
  }

  async function settlePeriod(p: PeriodFile): Promise<void> {
    if (p.mode !== 'live' || (p.status !== 'planned' && p.status !== 'sending')) return
    if (config.mode !== 'live' || !config.treasury) return abandonPeriod(p, 'payouts are not live now')
    if (p.treasury !== config.treasury.address) return abandonPeriod(p, `it was planned for treasury ${p.treasury} and the key is now ${config.treasury.address}`)
    if (p.status === 'planned') {
      p.status = 'sending'
      save(p)
    }
    // 1) Pending transactions first (restart recovery): never resend a landed row.
    for (const tx of p.txs) {
      if (tx.state !== 'pending') continue
      const res = await settleTx(tx)
      if (res === 'stopped') return
      applyTxResult(p, tx, res)
    }
    // 2) Unsent rows in batches of ≤ 18 transfers, one transaction at a time.
    while (!stopped) {
      finish(p)
      if (p.status !== 'sending') return
      const unsent = p.rows.map((r, i) => (r.state === 'unsent' ? i : -1)).filter((i) => i >= 0)
      if (unsent.length === 0) return
      const idx = batchRows(unsent)[0]
      // Never dip into the reserve: re-check the balance against this batch before signing.
      const need = idx.reduce((s, i) => s + p.rows[i].lamports, 0) + FEE_PER_SIGNATURE * 2
      const fresh = await refreshBalance()
      if (!fresh || balance === null || balance - need < config.rules.reserveLamports) {
        const why = fresh ? `treasury balance ${fmt(balance ?? 0)} SOL does not cover the next batch plus the reserve` : 'treasury balance unavailable'
        log('warn', `payouts: period ${p.id} held — ${why}; retrying next tick`)
        return
      }
      let bh: { blockhash: string; lastValidBlockHeight: number }
      try {
        bh = await conn.getLatestBlockhash('confirmed')
      } catch (e) {
        log('warn', `payouts: getLatestBlockhash failed (${(e as Error).message.slice(0, 120)}) — retrying`)
        await sleep(Math.max(pollMs, 1_000))
        continue
      }
      const tx = buildTx(p, idx, bh.blockhash, bh.lastValidBlockHeight)
      for (const i of idx) {
        p.rows[i].state = 'pending'
        p.rows[i].tx = tx.sig
        p.rows[i].attempts++
      }
      p.txs.push(tx)
      save(p) // signature on disk before the first broadcast
      await broadcast(tx)
      const res = await settleTx(tx)
      if (res === 'stopped') return
      applyTxResult(p, tx, res)
    }
  }

  // ---- recovery + loop ------------------------------------------------------------------------
  function recover(): void {
    load()
    const last = ledger.lastClosed()
    // Oldest first: reconcileClose refuses anything at or before the ledger's last close, so applying
    // a newer period first would skip (and later re-pay) every older one.
    for (const p of [...sorted()].reverse()) {
      if (last && p.endsAt <= last.endsAt) continue
      // The plan was persisted but the ledger reset was not: apply it now.
      const applied = ledger.reconcileClose(p.id, p.endsAt, p.snapshot, p.carry)
      if (applied) log('warn', `payouts: period ${p.id} was planned before a restart — ledger reconciled`)
    }
    // Rows marked 'failed' are persisted before their INK is carried back (at-most-once), so a
    // crash between the two loses that carry-back rather than paying it twice.
  }

  async function cycle(): Promise<void> {
    if (!recovered) {
      recovered = true
      recover()
      if (treasuryPk && balance === null) await refreshBalance()
    }
    // Open live periods are settled (or their unsent INK returned) in every mode, including off.
    const open = sorted().filter((p) => p.mode === 'live' && (p.status === 'planned' || p.status === 'sending')).reverse()
    for (const p of open) {
      if (stopped) return
      await settlePeriod(p)
    }
    if (stopped || config.mode === 'off') return
    const p = await closeDue()
    if (p && !stopped) await settlePeriod(p)
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (running) return running
    running = cycle()
      .catch((e) => log('error', `payouts: cycle failed (${(e as Error).message.slice(0, 200)})`))
      .finally(() => {
        running = null
      })
    return running
  }

  for (const n of config.notes) log(n.level, `payouts: ${n.msg}`)

  return {
    start() {
      stopped = false
      void tick()
      tickTimer = setInterval(() => void tick(), tickMs)
      if (treasuryPk) balTimer = setInterval(() => void refreshBalance(), balanceMs)
      tickTimer.unref?.()
      balTimer?.unref?.()
      log('info', `payouts: mode ${config.mode}, every ${config.everyHours} h (UTC-aligned), cluster ${config.cluster}${config.treasuryAddress ? `, treasury ${config.treasuryAddress}` : ''}`)
    },
    async stop() {
      stopped = true
      if (tickTimer) clearInterval(tickTimer)
      if (balTimer) clearInterval(balTimer)
      tickTimer = balTimer = null
      if (running) await running
    },
    overview,
    wallet,
    tick,
  }
}
