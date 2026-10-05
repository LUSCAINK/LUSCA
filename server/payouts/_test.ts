// Payout engine tests with a fake Solana connection and an in-memory ledger.
//   npx tsx server/payouts/_test.ts
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair, PublicKey, SystemInstruction, Transaction } from '@solana/web3.js'
import { base58Encode } from '../../shared/base58.ts'
import type { PayoutsOverview } from '../../shared/payouts.ts'
import type { PayoutLedger, PeriodSnapshotRow } from '../contracts.ts'
import { resolvePayoutConfig, type PayoutConfig } from './config.ts'
import { createPayouts, type ConnectionLike } from './index.ts'
import { LAMPORTS_PER_SOL, MAX_TRANSFERS_PER_TX, periodIdFor, periodStart, planPayout, poolFor, type RulesLamports } from './plan.ts'

const SOL = LAMPORTS_PER_SOL
const H = 3_600_000
let passed = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (e) {
    console.error(`FAIL ${name}\n${(e as Error).stack}`)
    process.exitCode = 1
  }
}

// ---- fakes -----------------------------------------------------------------------------------
class FakeLedger implements PayoutLedger {
  period = new Map<string, number>()
  life = new Map<string, number>()
  last: { id: string; endsAt: number } | null = null
  carriedBack: { wallet: string; ink: number }[] = []
  add(w: string, ink: number) {
    this.period.set(w, (this.period.get(w) ?? 0) + ink)
    this.life.set(w, (this.life.get(w) ?? 0) + ink)
  }
  periodSnapshot(): PeriodSnapshotRow[] {
    return [...this.period].filter(([, v]) => v > 0).map(([wallet, ink]) => ({ wallet, ink })).sort((a, b) => b.ink - a.ink)
  }
  closePeriod(id: string, endsAt: number, plan: (s: PeriodSnapshotRow[]) => Record<string, number>) {
    const snap = this.periodSnapshot()
    const carry = plan(snap)
    this.period.clear()
    for (const [w, v] of Object.entries(carry)) this.period.set(w, v)
    this.last = { id, endsAt }
    return snap
  }
  reconcileClose(id: string, endsAt: number, snapshot: PeriodSnapshotRow[], carry: Record<string, number>) {
    if (this.last && this.last.endsAt >= endsAt) return false
    for (const s of snapshot) this.period.set(s.wallet, Math.max(0, (this.period.get(s.wallet) ?? 0) - s.ink))
    for (const [w, v] of Object.entries(carry)) this.period.set(w, (this.period.get(w) ?? 0) + v)
    this.last = { id, endsAt }
    return true
  }
  carryBack(wallet: string, ink: number) {
    this.carriedBack.push({ wallet, ink })
    this.period.set(wallet, (this.period.get(wallet) ?? 0) + ink)
  }
  lastClosed() {
    return this.last
  }
  lifetimeInk(w: string) {
    return this.life.get(w) ?? 0
  }
  periodInk(w: string) {
    return this.period.get(w) ?? 0
  }
  isVerified(w: string) {
    return this.life.has(w)
  }
  clone() {
    const c = new FakeLedger()
    c.period = new Map(this.period)
    c.life = new Map(this.life)
    c.last = this.last ? { ...this.last } : null
    return c
  }
}

type Status = { err: unknown; confirmationStatus: 'confirmed' }
class FakeChain implements ConnectionLike {
  balances = new Map<string, number>()
  statuses = new Map<string, Status>()
  hashes = new Map<string, number>()
  credited = new Map<string, number>()
  creditCount = new Map<string, number>()
  height = 1_000
  heightStep = 0
  sends = 0
  /** The next N distinct signatures never land (every broadcast of them is dropped). */
  blackhole = 0
  holed = new Set<string>()
  failBalance = false
  beforeLand?: (sig: string) => void
  afterLand?: (sig: string) => void
  async getBalance(pk: PublicKey) {
    if (this.failBalance) throw new Error('rpc down')
    return this.balances.get(pk.toBase58()) ?? 0
  }
  async getLatestBlockhash() {
    const blockhash = base58Encode(randomBytes(32))
    this.hashes.set(blockhash, this.height + 150)
    return { blockhash, lastValidBlockHeight: this.height + 150 }
  }
  async getBlockHeight() {
    this.height += this.heightStep
    return this.height
  }
  async sendRawTransaction(raw: Buffer | Uint8Array) {
    this.sends++
    const tx = Transaction.from(raw)
    assert.ok(tx.verifySignatures(), 'signature must verify')
    const sig = base58Encode(tx.signature!)
    if (this.statuses.has(sig)) throw new Error('This transaction has already been processed')
    const lvbh = this.hashes.get(tx.recentBlockhash!)
    if (lvbh === undefined || this.height > lvbh) throw new Error('Blockhash not found')
    if (this.holed.has(sig)) return sig
    if (this.blackhole > 0) {
      this.blackhole--
      this.holed.add(sig)
      return sig
    }
    this.beforeLand?.(sig)
    const payer = tx.feePayer!.toBase58()
    let debit = 5_000
    for (const ix of tx.instructions) {
      const t = SystemInstruction.decodeTransfer(ix)
      const to = t.toPubkey.toBase58()
      const lam = Number(t.lamports)
      debit += lam
      this.credited.set(to, (this.credited.get(to) ?? 0) + lam)
      this.creditCount.set(to, (this.creditCount.get(to) ?? 0) + 1)
      this.balances.set(to, (this.balances.get(to) ?? 0) + lam)
    }
    assert.ok((this.balances.get(payer) ?? 0) >= debit, 'treasury overdraft')
    this.balances.set(payer, (this.balances.get(payer) ?? 0) - debit)
    this.statuses.set(sig, { err: null, confirmationStatus: 'confirmed' })
    this.afterLand?.(sig)
    return sig
  }
  async getSignatureStatuses(sigs: string[]) {
    return { value: sigs.map((s) => this.statuses.get(s) ?? null) }
  }
  clone() {
    const c = new FakeChain()
    c.balances = new Map(this.balances)
    c.statuses = new Map(this.statuses)
    c.hashes = new Map(this.hashes)
    c.credited = new Map(this.credited)
    c.creditCount = new Map(this.creditCount)
    c.height = this.height
    return c
  }
}

// ---- helpers ---------------------------------------------------------------------------------
const DEFAULT_RULES: RulesLamports = { share: 0.5, reserveLamports: 0.05 * SOL, maxLamports: 5 * SOL, maxWalletLamports: 1 * SOL, minLamports: 0.001 * SOL }
const T_CLOSE = Date.UTC(2026, 9, 5, 12, 0, 5)
const tmp = mkdtempSync(join(tmpdir(), 'lusca-payouts-'))
let dirN = 0
const newDir = () => join(tmp, `d${dirN++}`)
const wallets = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58())

function cfgFor(mode: 'live' | 'dryrun' | 'off', kp: Keypair, extra: Record<string, string> = {}): PayoutConfig {
  return resolvePayoutConfig({
    LUSCA_PAYOUTS: mode,
    LUSCA_SOLANA_RPC: 'http://127.0.0.1:1/fake',
    LUSCA_TREASURY_SECRET: JSON.stringify(Array.from(kp.secretKey)),
    ...extra,
  })
}

function setup(mode: 'live' | 'dryrun' | 'off', opts: { wallets?: number; treasurySol?: number; dir?: string } = {}) {
  const kp = Keypair.generate()
  const config = cfgFor(mode, kp)
  const chain = new FakeChain()
  chain.balances.set(kp.publicKey.toBase58(), Math.round((opts.treasurySol ?? 100) * SOL))
  const ledger = new FakeLedger()
  ledger.last = { id: periodIdFor(Date.UTC(2026, 9, 4, 12)), endsAt: Date.UTC(2026, 9, 5, 0) }
  const ws = wallets(opts.wallets ?? 3)
  ws.forEach((w, i) => ledger.add(w, 10 + i))
  return { kp, config, chain, ledger, ws, dir: opts.dir ?? newDir() }
}

function engine(s: { config: PayoutConfig; chain: ConnectionLike; ledger: PayoutLedger; dir: string }, updates: PayoutsOverview[] = [], logs: string[] = [], balanceMs?: number) {
  return createPayouts({
    balanceMs,
    ledger: s.ledger,
    dataDir: s.dir,
    config: s.config,
    connection: s.chain,
    log: (_l, m) => logs.push(m),
    onUpdate: (o) => updates.push(o),
    now: () => T_CLOSE,
    pollMs: 1,
  })
}

const periodFile = (dir: string) => {
  const names = readdirSync(join(dir, 'payouts'))
  assert.ok(!names.some((n) => n.endsWith('.tmp')), 'no temp files left')
  const n = names.filter((x) => x.startsWith('period-')).sort().at(-1)!
  return JSON.parse(readFileSync(join(dir, 'payouts', n), 'utf8'))
}

/** Every planned row credited exactly once with exactly its lamports. */
function assertPaidOnce(chain: FakeChain, file: { rows: { wallet: string; lamports: number }[] }) {
  for (const r of file.rows) {
    if (r.lamports === 0) {
      assert.equal(chain.credited.get(r.wallet) ?? 0, 0)
      continue
    }
    assert.equal(chain.creditCount.get(r.wallet), 1, `wallet credited once (${r.wallet.slice(0, 6)})`)
    assert.equal(chain.credited.get(r.wallet), r.lamports)
  }
}

// ---- tests -----------------------------------------------------------------------------------
await test('pool: reserve, fees, share, max, unknown balance', () => {
  const fees3 = poolFor(3 * SOL, 3, DEFAULT_RULES)
  assert.equal(fees3.feeLamports, 10_000)
  assert.equal(fees3.poolLamports, Math.floor((3 * SOL - 0.05 * SOL - 10_000) * 0.5))
  assert.equal(poolFor(20 * SOL, 3, DEFAULT_RULES).poolLamports, 5 * SOL)
  assert.equal(poolFor(0.04 * SOL, 3, DEFAULT_RULES).poolLamports, 0)
  assert.equal(poolFor(null, 3, DEFAULT_RULES).poolLamports, 0)
  assert.equal(poolFor(10 * SOL, 40, DEFAULT_RULES).feeLamports, 3 * 5_000 * 2)
})

await test('split: per-wallet cap carries the excess, dust carries everything', () => {
  const p = planPayout(20 * SOL, [{ wallet: 'A', ink: 90 }, { wallet: 'B', ink: 5 }, { wallet: 'C', ink: 5 }], DEFAULT_RULES)
  assert.equal(p.poolLamports, 5 * SOL)
  assert.equal(p.rows[0].lamports, 1 * SOL)
  assert.equal(p.rows[0].reason, 'cap')
  assert.equal(p.rows[0].carryInk, 70)
  assert.equal(p.rows[0].paidInk, 20)
  assert.equal(p.rows[1].lamports, 0.25 * SOL)
  assert.equal(p.carry.A, 70)
  const d = planPayout(2.1 * SOL, [{ wallet: 'A', ink: 1_000_000 }, { wallet: 'B', ink: 1 }], DEFAULT_RULES)
  assert.equal(d.rows[1].reason, 'dust')
  assert.equal(d.rows[1].lamports, 0)
  assert.equal(d.carry.B, 1)
})

await test('split: lamport rounding never exceeds the pool (fuzz)', () => {
  for (let k = 0; k < 400; k++) {
    const n = 1 + Math.floor(Math.random() * 120)
    const snap = Array.from({ length: n }, (_, i) => ({ wallet: `w${i}`, ink: Math.round(Math.random() * 1e6) / 1e3 + 0.001 }))
    const bal = Math.floor(Math.random() * 30 * SOL)
    const rules = { ...DEFAULT_RULES, share: Math.random(), maxWalletLamports: Math.floor(Math.random() * 2 * SOL) + 0.001 * SOL }
    const p = planPayout(bal, snap, rules)
    const sum = p.rows.reduce((s, r) => s + r.lamports, 0)
    assert.ok(sum <= p.poolLamports, `sum ${sum} ≤ pool ${p.poolLamports}`)
    assert.ok(p.poolLamports <= rules.maxLamports && p.poolLamports <= Math.max(0, bal - rules.reserveLamports))
    for (const r of p.rows) {
      assert.ok(Number.isInteger(r.lamports) && r.lamports >= 0)
      assert.ok(r.lamports === 0 || (r.lamports >= rules.minLamports && r.lamports <= rules.maxWalletLamports))
      assert.ok(Math.abs(r.paidInk + r.carryInk - r.ink) < 1e-5)
    }
  }
})

await test('periods: UTC-aligned, fractional hours', () => {
  assert.equal(periodStart(Date.UTC(2026, 9, 5, 13, 30), 12 * H), Date.UTC(2026, 9, 5, 12))
  assert.equal(periodIdFor(Date.UTC(2026, 9, 5, 12)), '2026-10-05T12')
  const e = Math.round(0.01 * H)
  assert.equal(periodStart(Date.UTC(2026, 9, 5, 12, 3, 40), e), Date.UTC(2026, 9, 5, 12, 3, 36))
  assert.equal(periodIdFor(Date.UTC(2026, 9, 5, 12, 3, 36)), '2026-10-05T12-03-36')
})

await test('live: 40 wallets → 3 transactions (≤ 18 transfers), durable done file, overview + wallet shapes', async () => {
  const s = setup('live', { wallets: 40 })
  const updates: PayoutsOverview[] = []
  const logs: string[] = []
  const e = engine(s, updates, logs)
  await e.tick()
  const f = periodFile(s.dir)
  assert.equal(f.id, '2026-10-05T00')
  assert.equal(f.status, 'done')
  assert.equal(f.txs.length, 3)
  assert.deepEqual(f.txs.map((t: { rows: number[] }) => t.rows.length), [MAX_TRANSFERS_PER_TX, MAX_TRANSFERS_PER_TX, 4])
  assertPaidOnce(s.chain, f)
  const sum = f.rows.reduce((a: number, r: { lamports: number }) => a + r.lamports, 0)
  assert.ok(sum <= f.poolLamports && f.poolLamports === 5 * SOL)
  const o = e.overview()
  assert.equal(o.history[0].status, 'done')
  assert.equal(o.history[0].txs.length, 3)
  assert.equal(o.history[0].wallets, 40)
  assert.equal(o.history[0].poolSol, sum / SOL)
  assert.equal(o.period?.id, '2026-10-05T12')
  assert.equal(o.period?.endsAt, Date.UTC(2026, 9, 6, 0))
  assert.equal(o.treasury.stale, false)
  assert.ok(updates.length >= 4, 'onUpdate on close and every confirmed tx')
  const w = e.wallet(s.ws[0])
  assert.equal(w.history[0].status, 'sent')
  assert.ok(w.history[0].tx && f.txs.some((t: { sig: string }) => t.sig === w.history[0].tx))
  assert.equal(w.paidSol, f.rows.find((r: { wallet: string }) => r.wallet === s.ws[0]).lamports / SOL)
  assert.equal(w.verified, true)
  assert.equal(s.ledger.lastClosed()?.id, '2026-10-05T00')
  assert.equal(logs.filter((l) => l.includes('period 2026-10-05T00')).length, 1, 'one log line per period')
  assert.ok(!logs.some((l) => l.includes(JSON.stringify(Array.from(s.kp.secretKey)).slice(1, 20))))
  // Second tick in the same period: nothing new.
  const sends = s.chain.sends
  await e.tick()
  assert.equal(s.chain.sends, sends)
})

for (const variant of ['landed', 'stored-not-broadcast'] as const) {
  await test(`crash mid-sending (${variant}) → restart pays every row exactly once`, async () => {
    const s = setup('live', { wallets: 40 })
    let snap: { dir: string; chain: FakeChain; ledger: FakeLedger } | null = null
    const e1 = engine(s)
    const take = () => {
      const dir = newDir()
      cpSync(s.dir, dir, { recursive: true })
      snap = { dir, chain: s.chain.clone(), ledger: s.ledger.clone() }
      void e1.stop()
    }
    let n = 0
    if (variant === 'landed') s.chain.afterLand = () => ++n === 2 && take()
    else s.chain.beforeLand = () => ++n === 2 && take()
    await e1.tick()
    assert.ok(snap, 'crash point reached')
    const c = snap as unknown as { dir: string; chain: FakeChain; ledger: FakeLedger }
    const before = periodFile(c.dir)
    assert.equal(before.status, 'sending')
    assert.equal(before.txs[1].state, 'pending', 'signature stored before broadcast')
    const e2 = engine({ config: s.config, chain: c.chain, ledger: c.ledger, dir: c.dir })
    await e2.tick()
    const f = periodFile(c.dir)
    assert.equal(f.status, 'done')
    assertPaidOnce(c.chain, f)
    assert.equal(f.txs.filter((t: { state: string }) => t.state === 'confirmed').length, 3)
  })
}

await test('blockhash expiry with an unknown signature → rebuilt and paid once', async () => {
  const s = setup('live', { wallets: 5 })
  s.chain.blackhole = 1
  s.chain.heightStep = 40
  const e = engine(s)
  await e.tick()
  const f = periodFile(s.dir)
  assert.equal(f.status, 'done')
  assert.deepEqual(f.txs.map((t: { state: string }) => t.state), ['expired', 'confirmed'])
  assert.ok(f.rows.every((r: { attempts: number }) => r.attempts === 2))
  assertPaidOnce(s.chain, f)
})

await test('out of attempts → row failed, INK carried back once, period failed', async () => {
  const s = setup('live', { wallets: 1 })
  s.chain.blackhole = 3
  s.chain.heightStep = 60
  const e = engine(s)
  await e.tick()
  const f = periodFile(s.dir)
  assert.equal(f.status, 'failed')
  assert.equal(f.rows[0].state, 'failed')
  assert.equal(s.ledger.carriedBack.length, 1)
  assert.equal(s.ledger.periodInk(s.ws[0]), 10)
  assert.equal(s.chain.credited.size, 0)
  assert.equal(e.overview().history[0].poolSol, 0)
  assert.equal(e.wallet(s.ws[0]).history[0].status, 'carried')
})

await test('dryrun: plans, persists, publishes — never signs or sends', async () => {
  const s = setup('dryrun', { wallets: 25 })
  let signs = 0
  const real = s.config.treasury!
  s.config = { ...s.config, treasury: { ...real, sign: (m) => (signs++, real.sign(m)) } }
  const updates: PayoutsOverview[] = []
  const e = engine(s, updates)
  await e.tick()
  const f = periodFile(s.dir)
  assert.equal(f.status, 'dryrun')
  assert.equal(signs, 0)
  assert.equal(s.chain.sends, 0)
  assert.equal(f.txs.length, 0)
  assert.equal(updates.at(-1)!.history[0].status, 'dryrun')
  assert.ok(updates.at(-1)!.history[0].poolSol > 0)
  assert.equal(e.wallet(s.ws[0]).history[0].status, 'dryrun')
})

await test('restart after the plan was persisted but before the ledger saved → reconciled, not closed twice', async () => {
  const s = setup('dryrun', { wallets: 4 })
  const old = s.ledger.clone()
  await engine(s).tick()
  const e2 = engine({ ...s, ledger: old })
  await e2.tick()
  assert.equal(old.lastClosed()?.id, '2026-10-05T00')
  // Same state as the ledger that saved the close: planned INK removed, carry (cap excess) added.
  const round = (rows: PeriodSnapshotRow[]) => rows.map((r) => ({ wallet: r.wallet, ink: Math.round(r.ink * 1e6) / 1e6 }))
  assert.deepEqual(round(old.periodSnapshot()), round(s.ledger.periodSnapshot()))
  assert.equal(readdirSync(join(s.dir, 'payouts')).filter((n) => n.startsWith('period-')).length, 1)
})

await test('treasury balance: refresh failure keeps the last value and marks it stale', async () => {
  const s = setup('off', { wallets: 2, treasurySol: 7 })
  const e = engine(s, [], [], 5)
  await e.tick()
  assert.equal(e.overview().treasury.balanceSol, 7)
  assert.equal(e.overview().period, null)
  s.chain.failBalance = true
  e.start()
  await new Promise((r) => setTimeout(r, 20))
  await e.stop()
  const o = e.overview()
  assert.equal(o.treasury.stale, true)
  assert.equal(o.treasury.balanceSol, 7)
  assert.equal(o.mode, 'off')
  assert.equal(existsSync(join(s.dir, 'payouts')), false, 'off never writes periods')
})

rmSync(tmp, { recursive: true, force: true })
console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
