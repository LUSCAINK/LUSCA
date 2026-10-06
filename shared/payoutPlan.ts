// Payout math (shared by server/payouts and the payout preview on /earn): UTC-aligned periods, the pool and the per-wallet split. Pure functions, all
// amounts in integer lamports (BigInt where a product could leave the safe-integer range).
//
//   pool     = min(MAX, floor(SHARE × max(0, balance − RESERVE − estimated fees)))
//   amount_i = floor(pool × ink_i / Σ ink)            (Σ amount_i ≤ pool, always)
//   cap      : amount_i > MAX_WALLET → MAX_WALLET; the unpaid share of ink_i carries over
//   dust     : amount_i < MIN → nothing is paid; all of ink_i carries over

/** One verified wallet's period credits (structurally server/contracts.ts PeriodSnapshotRow). */
export interface PeriodSnapshotRow {
  wallet: string
  ink: number
}

export const LAMPORTS_PER_SOL = 1_000_000_000
/** Base fee per signature (one signature per payout transaction). */
export const FEE_PER_SIGNATURE = 5_000
/** Transfers per transaction (a legacy transaction with 18 transfers stays under the 1232-byte limit). */
export const MAX_TRANSFERS_PER_TX = 18
/** Fee estimate margin: every batch may need one rebuilt transaction. */
const FEE_MARGIN = 2
/** INK is split in micro-INK so integer math stays exact. */
const INK_SCALE = 1_000_000

export interface RulesLamports {
  share: number
  reserveLamports: number
  maxLamports: number
  maxWalletLamports: number
  minLamports: number
}

export interface PlanRow {
  wallet: string
  /** Period INK of the wallet (snapshot). */
  ink: number
  /** Lamports to send (0 when carried). */
  lamports: number
  /** INK settled by this payout. */
  paidInk: number
  /** INK that carries over to the next period. */
  carryInk: number
  reason: 'pay' | 'cap' | 'dust'
}

export interface Plan {
  balanceLamports: number | null
  feeLamports: number
  poolLamports: number
  totalInk: number
  rows: PlanRow[]
  /** wallet → INK to carry into the next period. */
  carry: Record<string, number>
}

export const toSol = (lamports: number) => lamports / LAMPORTS_PER_SOL
export const toLamports = (sol: number) => Math.round(sol * LAMPORTS_PER_SOL)

/** Estimated network fees for paying `wallets` wallets (base fee per transaction, with a rebuild margin). */
export function estimateFees(wallets: number): number {
  const txs = Math.max(1, Math.ceil(Math.max(0, wallets) / MAX_TRANSFERS_PER_TX))
  return txs * FEE_PER_SIGNATURE * FEE_MARGIN
}

/** Pool for a treasury balance (null = unknown → 0). */
export function poolFor(balanceLamports: number | null, wallets: number, rules: RulesLamports): { poolLamports: number; feeLamports: number } {
  const feeLamports = estimateFees(wallets)
  if (balanceLamports === null || !Number.isFinite(balanceLamports)) return { poolLamports: 0, feeLamports }
  const spendable = Math.max(0, balanceLamports - rules.reserveLamports - feeLamports)
  const share = Math.min(1, Math.max(0, rules.share))
  const pool = Math.min(Math.max(0, Math.floor(rules.maxLamports)), Math.floor(spendable * share))
  return { poolLamports: Math.max(0, pool), feeLamports }
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6

/** Split the pool by INK with the per-wallet cap and the dust floor. Rows keep the snapshot order. */
export function planPayout(balanceLamports: number | null, snapshot: PeriodSnapshotRow[], rules: RulesLamports): Plan {
  const rows0 = snapshot.filter((r) => typeof r.wallet === 'string' && Number.isFinite(r.ink) && r.ink > 0)
  const { poolLamports, feeLamports } = poolFor(balanceLamports, rows0.length, rules)
  const units = rows0.map((r) => BigInt(Math.max(0, Math.round(r.ink * INK_SCALE))))
  const totalUnits = units.reduce((s, u) => s + u, 0n)
  const pool = BigInt(poolLamports)
  const cap = Math.max(0, Math.floor(rules.maxWalletLamports))
  const min = Math.max(0, Math.floor(rules.minLamports))
  const carry: Record<string, number> = {}
  const rows: PlanRow[] = rows0.map((r, i) => {
    const share = totalUnits > 0n ? Number((pool * units[i]) / totalUnits) : 0
    let lamports = share
    let reason: PlanRow['reason'] = 'pay'
    let carryInk = 0
    if (share > cap) {
      lamports = cap
      reason = 'cap'
      carryInk = round6((r.ink * (share - cap)) / share)
    }
    if (lamports < min || lamports <= 0) {
      lamports = 0
      reason = 'dust'
      carryInk = round6(r.ink)
    }
    if (carryInk > 0) carry[r.wallet] = carryInk
    return { wallet: r.wallet, ink: round6(r.ink), lamports, paidInk: round6(r.ink - carryInk), carryInk, reason }
  })
  const totalInk = round6(rows0.reduce((s, r) => s + r.ink, 0))
  return { balanceLamports, feeLamports, poolLamports, totalInk, rows, carry }
}

/** Start (ms epoch) of the period containing `t`: periods are epoch multiples of `everyMs` (12 h → 00:00 and 12:00 UTC). */
export function periodStart(t: number, everyMs: number): number {
  return Math.floor(t / everyMs) * everyMs
}

/**
 * Period id = its UTC start: "2026-10-05T12" on the hour, "2026-10-05T12-03" with minutes,
 * "2026-10-05T12-03-36" with seconds (sub-hour rehearsal periods). Safe in file names.
 */
export function periodIdFor(startMs: number): string {
  const iso = new Date(startMs).toISOString() // 2026-10-05T12:03:36.000Z
  const hour = iso.slice(0, 13)
  const mm = iso.slice(14, 16)
  const ss = iso.slice(17, 19)
  if (ss !== '00') return `${hour}-${mm}-${ss}`
  if (mm !== '00') return `${hour}-${mm}`
  return hour
}

/** Split row indices into transaction batches of at most MAX_TRANSFERS_PER_TX. */
export function batchRows(indices: number[], size = MAX_TRANSFERS_PER_TX): number[][] {
  const out: number[][] = []
  for (let i = 0; i < indices.length; i += size) out.push(indices.slice(i, i + size))
  return out
}
