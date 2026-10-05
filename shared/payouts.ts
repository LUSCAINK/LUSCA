// LUSCA payouts + wallet auth — the REST contract shared by the server (server/payouts/,
// server/auth/) and the client (src/lib/payouts.ts, src/lib/wallet.ts).
//
// Credits = points for verified GPU work (the JSON field is named `ink` for historical reasons;
// credits are not the $INK token). Each payout period, the payout pool (a share of the
// treasury wallet's SOL balance) is split by the credits each verified wallet earned in that
// period and sent in SOL. Nothing here is an estimate of future value: every number is read from the
// coordinator ledger or the Solana RPC.

export type PayoutMode = 'off' | 'dryrun' | 'live'

/** Solana cluster the treasury lives on (used for explorer links). */
export type PayoutCluster = 'mainnet-beta' | 'devnet' | 'custom'

export interface TreasuryInfo {
  /** Treasury public key (base58); null when no treasury key is configured. */
  address: string | null
  /** Last on-chain balance read; null until the first successful read. */
  balanceSol: number | null
  /** ms epoch of that read. */
  updatedAt: number | null
  /** The most recent RPC refresh failed (balance is the last known value). */
  stale: boolean
}

export interface PeriodInfo {
  /** UTC start of the period, hour precision, e.g. "2026-10-05T12". */
  id: string
  startsAt: number
  /** Next payout time (ms epoch). */
  endsAt: number
  /** Credits earned so far this period by verified wallets. */
  inkSoFar: number
  /** Verified wallets with credits this period. */
  wallets: number
  /** Pool if the period closed now, after reserve, share and caps. */
  estPoolSol: number
}

export type PeriodStatus = 'planned' | 'sending' | 'done' | 'dryrun' | 'failed'

/** One closed payout period. */
export interface PayoutRecord {
  id: string
  closedAt: number
  /** SOL sent (or planned, for dryrun). */
  poolSol: number
  /** Total credits across the paid wallets. */
  ink: number
  wallets: number
  /** Confirmed transaction signatures. */
  txs: string[]
  status: PeriodStatus
}

export interface PayoutRules {
  everyHours: number
  share: number
  reserveSol: number
  maxSol: number
  maxWalletSol: number
  minSol: number
}

/** GET /api/payouts */
export interface PayoutsOverview {
  mode: PayoutMode
  cluster: PayoutCluster
  treasury: TreasuryInfo
  /** Current period; null when mode is 'off'. */
  period: PeriodInfo | null
  /** Newest first, up to 30. */
  history: PayoutRecord[]
  rules: PayoutRules
  /** Server time when this snapshot was built (ms epoch). */
  at: number
}

export interface WalletPayoutRow {
  periodId: string
  closedAt: number
  ink: number
  sol: number
  /** Transaction signature that carried this row; null until broadcast. */
  tx: string | null
  /** carried = below the dust floor or above the per-wallet cap; rolls into the next period. */
  status: 'sent' | 'pending' | 'carried' | 'dryrun'
}

/** GET /api/payouts/wallet/:address */
export interface WalletPayouts {
  wallet: string
  /** The wallet has proven ownership by signing the LUSCA sign-in message. */
  verified: boolean
  /** Current-period standing; null when payouts are off. */
  period: { id: string; ink: number; sharePct: number; estSol: number } | null
  /** Lifetime credits earned by this wallet. */
  totalInk: number
  /** Lifetime SOL sent and confirmed. */
  paidSol: number
  /** Newest first, up to 50. */
  history: WalletPayoutRow[]
}

/** GET /api/auth/nonce?wallet=<base58> */
export interface AuthNonce {
  nonce: string
  /** Exact UTF-8 message the wallet must sign. */
  message: string
  expiresAt: number
}

/** POST /api/auth/verify — signature is base58 or base64 of the 64-byte ed25519 signature. */
export interface AuthVerifyRequest {
  wallet: string
  nonce: string
  signature: string
}

export interface AuthSession {
  token: string
  wallet: string
  expiresAt: number
}

// REST
// GET  /api/payouts                     -> PayoutsOverview   (cached 5 s, rate-limited)
// GET  /api/payouts/wallet/:address     -> WalletPayouts     (cached 5 s, rate-limited)
// GET  /api/auth/nonce?wallet=<base58>  -> AuthNonce
// POST /api/auth/verify                 -> AuthSession       (body: AuthVerifyRequest)
// WS   { t: 'payout'; overview: PayoutsOverview }  when a period closes or a payout tx confirms
// WS   neuron.register gains `auth?: string` (AuthSession.token). Only a valid token links
//      the neuron's credits to a wallet; a bare `wallet` field earns nothing toward payouts.
