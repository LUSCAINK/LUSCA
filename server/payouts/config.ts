// Payout configuration from the environment.
//
//   LUSCA_PAYOUTS                off (default) | dryrun | live
//   LUSCA_SOLANA_RPC             https://api.mainnet-beta.solana.com
//   LUSCA_SOLANA_CLUSTER         mainnet-beta | devnet | custom (explorer links; default from the RPC URL)
//   LUSCA_TREASURY_SECRET        treasury secret key: base58 (Phantom export) or a JSON array of 64 bytes
//   LUSCA_TREASURY_ADDRESS       treasury address for balance reads without a key (dryrun)
//   LUSCA_PAYOUT_EVERY_H         12      period length in hours, aligned to UTC epoch multiples (0.01–720)
//   LUSCA_PAYOUT_SHARE           0.5     share of (balance − reserve − fees) paid per period
//   LUSCA_PAYOUT_RESERVE_SOL     0.05    never spent (≥ 0.002)
//   LUSCA_PAYOUT_MAX_SOL         5       pool cap per period
//   LUSCA_PAYOUT_MAX_WALLET_SOL  1       cap per wallet per period (the rest of its INK carries over)
//   LUSCA_PAYOUT_MIN_SOL         0.001   dust floor (≥ 0.0009, the rent-exempt minimum of a new account)
//
// The secret key is parsed once into a node:crypto KeyObject; the raw bytes are zeroed and the
// value is never logged, returned to clients or written to disk. A key that does not parse forces
// payouts off with one log line that names the variable, never its value.

import type { PayoutCluster, PayoutMode, PayoutRules } from '../../shared/payouts.ts'
import { base58Decode, base58Encode, isSolanaAddress } from '../../shared/base58.ts'
import { privateKeyFromSeed, rawPublicKey, signEd25519 } from '../auth/ed25519.ts'
import { LAMPORTS_PER_SOL, type RulesLamports } from './plan.ts'

export const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com'

/** The treasury hot wallet: an address and a signing function (the key never leaves this closure). */
export interface TreasurySigner {
  address: string
  publicKey: Uint8Array
  sign(message: Uint8Array): Uint8Array
}

export interface PayoutConfig {
  mode: PayoutMode
  rpcUrl: string
  cluster: PayoutCluster
  everyHours: number
  everyMs: number
  rules: RulesLamports
  treasury: TreasurySigner | null
  /** Treasury address for balance reads (the signer's, else LUSCA_TREASURY_ADDRESS). */
  treasuryAddress: string | null
  /** Startup log lines (never contain secret material). */
  notes: { level: 'info' | 'warn' | 'error'; msg: string }[]
}

/** Parse a Solana secret key (base58 or JSON byte array, 64 bytes = seed ‖ public key). Throws without echoing the input. */
export function parseTreasurySecret(raw: string): TreasurySigner {
  const text = raw.trim()
  let bytes: Uint8Array | null = null
  if (text.startsWith('[')) {
    let arr: unknown
    try {
      arr = JSON.parse(text)
    } catch {
      throw new Error('not valid JSON')
    }
    if (!Array.isArray(arr) || !arr.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) throw new Error('JSON must be an array of byte values')
    bytes = Uint8Array.from(arr as number[])
  } else {
    bytes = base58Decode(text)
    if (!bytes) throw new Error('not base58')
  }
  try {
    if (bytes.length !== 64) throw new Error(`expected 64 bytes, got ${bytes.length}`)
    const key = privateKeyFromSeed(bytes.subarray(0, 32))
    const pub = rawPublicKey(key)
    if (!Buffer.from(pub).equals(Buffer.from(bytes.subarray(32)))) throw new Error('the public half does not match the seed')
    const address = base58Encode(pub)
    return { address, publicKey: pub, sign: (msg) => signEd25519(msg, key) }
  } finally {
    bytes.fill(0)
  }
}

/** Explorer cluster: LUSCA_SOLANA_CLUSTER, else 'devnet' for a devnet RPC URL, 'mainnet-beta' for the default URL, else 'custom'. */
export function clusterFor(rpcUrl: string, override?: string): PayoutCluster {
  const o = (override ?? '').trim().toLowerCase()
  if (o === 'mainnet-beta' || o === 'mainnet') return 'mainnet-beta'
  if (o === 'devnet') return 'devnet'
  if (o === 'custom') return 'custom'
  if (/devnet/i.test(rpcUrl)) return 'devnet'
  if (rpcUrl.replace(/\/+$/, '') === DEFAULT_RPC) return 'mainnet-beta'
  return 'custom'
}

export function rulesFor(cfg: Pick<PayoutConfig, 'everyHours' | 'rules'>): PayoutRules {
  return {
    everyHours: cfg.everyHours,
    share: cfg.rules.share,
    reserveSol: cfg.rules.reserveLamports / LAMPORTS_PER_SOL,
    maxSol: cfg.rules.maxLamports / LAMPORTS_PER_SOL,
    maxWalletSol: cfg.rules.maxWalletLamports / LAMPORTS_PER_SOL,
    minSol: cfg.rules.minLamports / LAMPORTS_PER_SOL,
  }
}

export function resolvePayoutConfig(env: Record<string, string | undefined> = process.env): PayoutConfig {
  const notes: PayoutConfig['notes'] = []
  const num = (name: string, def: number, min: number, max: number): number => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return def
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      notes.push({ level: 'warn', msg: `${name}=${JSON.stringify(raw.slice(0, 40))} is not a number — using ${def}` })
      return def
    }
    if (n < min || n > max) notes.push({ level: 'warn', msg: `${name}=${n} is outside ${min}–${max} — clamped` })
    return Math.min(max, Math.max(min, n))
  }

  let mode: PayoutMode = 'off'
  const modeRaw = (env.LUSCA_PAYOUTS ?? '').trim().toLowerCase()
  if (modeRaw === 'live' || modeRaw === 'dryrun') mode = modeRaw
  else if (modeRaw && modeRaw !== 'off') notes.push({ level: 'warn', msg: `LUSCA_PAYOUTS=${JSON.stringify(modeRaw.slice(0, 20))} is not off / dryrun / live — payouts are off` })

  let rpcUrl = (env.LUSCA_SOLANA_RPC ?? '').trim() || DEFAULT_RPC
  if (!/^https?:\/\/[^\s]+$/i.test(rpcUrl)) {
    notes.push({ level: 'error', msg: 'LUSCA_SOLANA_RPC is not an http(s) URL — payouts are off' })
    rpcUrl = DEFAULT_RPC
    mode = 'off'
  }
  const cluster = clusterFor(rpcUrl, env.LUSCA_SOLANA_CLUSTER)

  const everyHours = num('LUSCA_PAYOUT_EVERY_H', 12, 0.01, 720)
  const everyMs = Math.max(36_000, Math.round(everyHours * 3_600_000))
  const rules: RulesLamports = {
    share: num('LUSCA_PAYOUT_SHARE', 0.5, 0, 1),
    reserveLamports: Math.round(num('LUSCA_PAYOUT_RESERVE_SOL', 0.05, 0.002, 1e9) * LAMPORTS_PER_SOL),
    maxLamports: Math.round(num('LUSCA_PAYOUT_MAX_SOL', 5, 0, 1e9) * LAMPORTS_PER_SOL),
    maxWalletLamports: Math.round(num('LUSCA_PAYOUT_MAX_WALLET_SOL', 1, 0.001, 1e9) * LAMPORTS_PER_SOL),
    minLamports: Math.round(num('LUSCA_PAYOUT_MIN_SOL', 0.001, 0.0009, 1e9) * LAMPORTS_PER_SOL),
  }

  let treasury: TreasurySigner | null = null
  const secret = env.LUSCA_TREASURY_SECRET
  if (secret !== undefined && secret.trim() !== '') {
    try {
      treasury = parseTreasurySecret(secret)
    } catch (e) {
      notes.push({ level: 'error', msg: `LUSCA_TREASURY_SECRET could not be parsed (${(e as Error).message}; expected a base58 or JSON-array 64-byte Solana secret key) — payouts are off` })
      mode = 'off'
    }
  }
  let treasuryAddress = treasury?.address ?? null
  const addrRaw = (env.LUSCA_TREASURY_ADDRESS ?? '').trim()
  if (addrRaw) {
    if (!isSolanaAddress(addrRaw)) notes.push({ level: 'warn', msg: 'LUSCA_TREASURY_ADDRESS is not a Solana address — ignored' })
    else if (treasury && treasury.address !== addrRaw) notes.push({ level: 'warn', msg: `LUSCA_TREASURY_ADDRESS differs from the treasury key's address — using the key's address ${treasury.address}` })
    else treasuryAddress = addrRaw
  }
  if (mode === 'live' && !treasury) {
    notes.push({ level: 'error', msg: 'LUSCA_PAYOUTS=live needs LUSCA_TREASURY_SECRET — payouts are off' })
    mode = 'off'
  }
  if (mode === 'dryrun' && !treasuryAddress) notes.push({ level: 'warn', msg: 'dryrun without a treasury address: the balance is unknown, so every planned pool is 0' })
  return { mode, rpcUrl, cluster, everyHours, everyMs, rules, treasury, treasuryAddress, notes }
}
