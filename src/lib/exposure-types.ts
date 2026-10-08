// EXPOSURE: which keys are already public on-chain, and what each one holds and controls.
// The API contract, shared by server/exposure/** and the client (src/pages/Exposure.tsx).
// Self-contained on purpose (no imports), so both the server and the client compile it as is.
//
// Facts the answers rest on:
//   EVM      an address is the last 20 bytes of keccak256(public key). The public key stays hidden until the
//            address signs: every sent transaction (nonce > 0) carries a signature from which it is recoverable.
//            nonce 0 and no code = not exposed by any transaction (a signature published elsewhere, such as a
//            co-signature inside a Safe execution or a permit, can still reveal it).
//            Code 0xef0100 + 20 bytes = an EIP-7702-delegated account: the original key still controls it.
//            Safe: the owners' signatures are part of execTransaction calldata, so they are published when a
//            transaction executes, including confirmations collected off-chain.
//   Solana   the address IS the Ed25519 public key: every wallet key is public from the start.
//            A program-derived address (off the curve) has no private key; a program signs for it, so the
//            exposure moves to whoever can upgrade that program.
//
// REST
//   GET /api/exposure/:chain/:address   -> ExposureReport    (400 bad chain / address, 429 limited)
//   GET /api/exposure/summary           -> ExposureSummary   (stored data; never blocks on a recompute)
//   GET /api/exposure/status            -> ExposureStatus    (limits and budget; no secrets)

export type ExposureChain = 'solana' | 'ethereum' | 'base' | 'arbitrum'
export const EXPOSURE_CHAINS: readonly ExposureChain[] = ['solana', 'ethereum', 'base', 'arbitrum']
export const EXPOSURE_EVM_CHAINS: readonly ExposureChain[] = ['ethereum', 'base', 'arbitrum']

/**
 * What the address is.
 *   wallet    Solana account owned by the System Program (or not created yet) whose address is an ed25519 point
 *   account   Solana data account owned by another program (a mint, token account, multisig, stake account …):
 *             what moves it is decided by that program and the authorities stored in its data (`authorities`)
 *   pda       Solana program-derived address (off the curve): no private key exists
 *   program   Solana executable account (a program)
 *   eoa       EVM account without code
 *   eoa-7702  EVM account whose code is an EIP-7702 delegation (0xef0100 + address): the original key still controls it
 *   contract  EVM contract (not a Safe)
 *   safe      EVM Safe (getThreshold() / getOwners() answer)
 *   unknown   could not be read (see `partial`)
 */
export type ExposureKeyKind = 'wallet' | 'account' | 'pda' | 'program' | 'eoa' | 'eoa-7702' | 'contract' | 'safe' | 'unknown'
export type ExposureCurve = 'ed25519' | 'secp256k1'

export interface ExposureKey {
  kind: ExposureKeyKind
  /** Signature curve of the key behind the address; null when no private key exists (PDA, contract, program). */
  curve: ExposureCurve | null
  /**
   * true   the public key is on-chain (Solana wallet: always; EVM: a transaction was sent, or a 7702 authorization)
   * false  no transaction from this address exposes it (EVM nonce 0, no code). Not a promise: see `basis`.
   * null   does not apply (no private key) or was not read
   */
  exposed: boolean | null
  /** Short label: 'Exposed', 'Not exposed by any transaction', 'No private key (program-derived)' … */
  verdict: string
  /** One or two plain sentences with the evidence (nonce value, curve check, code prefix). */
  basis: string
  /** EVM: the account nonce (transactions sent from this address). */
  txCount?: number
  /** EIP-7702: the contract the account delegates to. */
  delegate?: string
  /** Solana: the program that owns the account (System Program for a wallet). */
  owner?: string
  /** EVM: the same key's nonce on every supported EVM chain that was read (one key signs on all of them).
   *  `contract`: the address holds contract code there, so that nonce counts contract creations, not signatures. */
  chains?: { chain: ExposureChain; txCount: number | null; contract?: boolean }[]
  /** Solana: the keys stored in this account's own data that decide what happens to it (mint / freeze
   *  authority, multisig signers, stake authorities, token account owner, upgrade authority). */
  authorities?: ExposureAuthority[]
}

export interface ExposureAuthority {
  /** 'Mint authority', 'Freeze authority', 'Signer (2 of 3)', 'Upgrade authority', 'Withdrawer' … */
  role: string
  /** null = the field is set to None (nobody holds that power). */
  address: string | null
  /** 'key' = an Ed25519 point (its public key is the address), 'pda' = off the curve (a program signs). */
  keyKind?: 'key' | 'pda'
  /** Where it was read: account, offset. */
  via: string
}

export interface ExposureNative {
  symbol: string
  /** Decimal string (no float rounding), e.g. '1.234567891'. */
  amount: string
  /** Smallest unit (lamports / wei), decimal string. */
  raw: string
  /** USD value at the price source's price (holds.usd names the source); absent when not priced. */
  usd?: number
}

export interface ExposureToken {
  /** Solana mint, or EVM token contract. */
  mint: string
  program: 'token' | 'token-2022'
  /** Decimal string. */
  amount: string
  decimals: number
  symbol?: string
  name?: string
  /** USD value at the price source's price (holds.usd names the source); absent when not priced. */
  usd?: number
}

export interface ExposureUsd {
  total: number
  /** Where the prices came from, by name (no URL). */
  source: string
  at: number
}

export interface ExposureHolds {
  native: ExposureNative | null
  /** Non-zero token balances, largest first by raw amount within the cap. */
  tokens: ExposureToken[]
  /** Non-zero token accounts found before the cap. */
  tokenCount: number
  /** true when `tokens` was cut to the cap. */
  truncated: boolean
  /** Present only when a public price source answered; otherwise absent (never estimated). */
  usd?: ExposureUsd
}

export type ExposureControlKind =
  | 'program-upgrade'
  | 'mint-authority'
  | 'freeze-authority'
  | 'metadata-update'
  | 'stake-staker'
  | 'stake-withdrawer'
  | 'token-delegate-in'
  | 'contract-control'
  | 'safe-owner-of'

export interface ExposureControl {
  kind: ExposureControlKind
  /** Chain of the target when it differs from the report's (an EVM key controls contracts on every EVM chain). */
  chain?: ExposureChain
  /** The thing controlled: a program, a mint, a stake account, a token account, a contract, a Safe. */
  target: string
  /** Short label: 'Can upgrade program', 'Mint authority', 'Stake withdrawer' … */
  label: string
  /** Name from LUSCA's kept data or token metadata, when known. */
  name?: string
  /** How it was found: 'ProgramData upgrade authority', 'SPL Token mint, offset 4', 'Control Map hop' … */
  via: string
  /** The evidence in one line (account read, offsets, slot). */
  evidence: string
  /** LUSCA page for it (/lens/solana/<id>, /control?q=…). */
  href?: string
}

export interface ExposureSafeOwner {
  address: string
  /** Same meaning as ExposureKey.exposed for that owner (null also when the Safe's own executions may have published it). */
  exposed: boolean | null
  basis: string
  /** Nonce summed over the EVM chains where the owner is not a contract. */
  txCount?: number
  /** The owner is a contract (a nested Safe, an EIP-1271 wallet): no key of its own. */
  contract?: boolean
}

export interface ExposureSafe {
  threshold: number
  owners: ExposureSafeOwner[]
  /** The Safe's nonce(): transactions it has executed (each one published its signers' signatures). */
  nonce?: number
}

export interface ExposureReport {
  v: 1
  chain: ExposureChain
  address: string
  readAt: number
  /** true when served from the per-address cache (readAt is when it was read). */
  cached: boolean
  key: ExposureKey
  holds: ExposureHolds
  controls: ExposureControl[]
  safe?: ExposureSafe
  /** Plain reasons for anything not read (timeouts, budget, unsupported). Never counted. */
  partial: string[]
  /** Short plain notes (what the verdict does and does not mean). */
  notes: string[]
  /** RPC / API calls this lookup spent (0 when cached). */
  calls?: number
}

/** One bucket of the Exposure Map. */
export interface ExposureBucket {
  id: string
  label: string
  n: number
  /** Plain sentence: what is counted here and from which data. */
  basis: string
  /** true for the buckets whose controlling key is public on-chain. */
  exposed?: boolean
}

export interface ExposureGroup {
  /** 'solana-programs' | 'evm-contracts' */
  id: string
  label: string
  total: number
  buckets: ExposureBucket[]
  basis: string
}

export interface ExposureSafeStat {
  /** 'k of n' */
  label: string
  safes: number
  /** Owners whose key is exposed (nonce > 0) across these Safes; absent while owners are not read for the map. */
  ownersExposed?: number
  ownersRead?: number
}

export interface ExposureSummary {
  v: 1
  readAt: number
  groups: ExposureGroup[]
  /** EVM Safes found as controllers, by threshold, with how many owners are exposed. */
  safes?: ExposureSafeStat[]
  /** What the counts rest on, in one or two sentences. */
  basis: string
  /** true while a bounded background refresh is running; the numbers are from the last complete pass. */
  refreshing: boolean
  partial: string[]
}

export interface ExposureStatus {
  /** Lookups one connection may start per minute / per UTC day (cache hits are free). */
  perIp?: { perMinute: number; perDay: number }
  /** Exposure's daily share of each chain budget, in budget units. */
  budget?: Record<string, { used: number; limit: number }>
  perMinute: { used: number; limit: number }
  perDay: { used: number; limit: number }
  cacheTtlMs: number
  chains: ExposureChain[]
}
