// UPGRADE RADAR: the moment on-chain code changes, caught live and described. Facts only: what was
// read before, what was read after, and the difference. Nothing is inferred about intent.
// Shared between server/radar/** and the client (src/pages/Radar.tsx, src/pages/Scan.tsx).

import type { ChainId, ScanCall } from './chain.ts'

export type RadarKind = 'deploy' | 'upgrade' | 'admin_change' | 'beacon_upgrade' | 'authority_change' | 'close'
export const RADAR_KINDS: readonly RadarKind[] = ['upgrade', 'deploy', 'authority_change', 'admin_change', 'beacon_upgrade', 'close']

/** 'none': the registry was asked and has no verified build / source. 'unknown': not asked or could not be asked. */
export type RadarVerified = 'osec' | 'sourcify-full' | 'sourcify-partial' | 'none' | 'unknown'

/** A function guarded by an access check (EVM, verified source), with where the guard is. */
export interface RadarGuard {
  fn: string
  guard: string
  /** file:line */
  at: string
}

/** One side of a change: the state LUSCA had before, or the state read after. Unknown fields are null. */
export interface RadarSide {
  /** When this state was read (ms epoch); null when it comes from the event itself. */
  at: number | null
  /** 'read': read by the radar for this event · 'radar': the radar's own earlier snapshot · 'chain-index': the chain agents' kept item · 'event': the log / event data only */
  from: 'read' | 'radar' | 'chain-index' | 'event'
  codeHash: string | null
  /** Upgrade authority (Solana) or proxy admin (EVM). */
  authority: string | null
  upgradeable: boolean | null
  /** EVM: the implementation behind the proxy. */
  implementation?: string | null
  /** EVM: the beacon of a beacon proxy. */
  beacon?: string | null
  verified: RadarVerified
  name: string | null
  /** Instructions (Solana IDL) or ABI functions (EVM): how many; null = not known (no IDL / no verified source). */
  surfaceCount: number | null
  /** Admin-only functions found in the verified source (EVM); null = not analysed. */
  guardCount?: number | null
  /** Cryptographic / hash primitives the program binary imports (Solana ELF syscalls); null = not known. */
  primitives?: string[] | null
  deploySlot?: number | null
  /** Program bytes (Solana) / runtime bytecode bytes (EVM). */
  bytes?: number | null
}

export interface RadarList {
  items: string[]
  /** Items over the cap, not listed. */
  more: number
}

export interface RadarDiff {
  code: 'changed' | 'same' | 'unknown'
  authority: 'changed' | 'same' | 'unknown'
  verified: 'changed' | 'same' | 'unknown'
  /** What `added` / `removed` list. */
  surface: 'instructions' | 'functions' | null
  /** null = not comparable (one side unknown). */
  added: RadarList | null
  removed: RadarList | null
  /** Admin-only functions present after and not before (EVM verified source), with file:line. */
  guardsAdded: RadarGuard[] | null
  guardsRemoved: RadarGuard[] | null
  primitivesAdded: string[] | null
  primitivesRemoved: string[] | null
}

export interface RadarEvent {
  id: string
  chain: ChainId
  kind: RadarKind
  /** Program id (Solana), proxy or beacon (EVM). For an aggregated EVM deploy: the first proxy. */
  address: string
  name: string | null
  /** A protocol LUSCA already knows (kept in the chain index, or its verified repository is in the code index). */
  known: boolean
  knownWhy: string | null
  /** When the change landed (block time; detection time when the block time is not known), ms epoch. */
  ts: number
  /** When LUSCA caught it, ms epoch. */
  seenAt: number
  slot: number | null
  block: number | null
  /** Signature (Solana) / transaction hash (EVM) of the latest transaction of this event. */
  tx: string | null
  /** Transactions folded into this event (a deploy script upgrading the same program again, a factory deploying many proxies). */
  count: number
  /** Aggregated EVM deploys: how many proxies, and the first few. */
  proxies?: { n: number; sample: string[] } | null
  /** Who did it: the transaction signer / sender when it was read, else the current authority / admin. */
  actor: string | null
  actorRole: 'signer' | 'sender' | 'authority' | 'admin' | null
  before: RadarSide | null
  after: RadarSide | null
  diff: RadarDiff | null
  /** One plain line: "Upgraded · 2 instructions added · authority unchanged · verified: no". */
  headline: string
  /** Display order hint (higher first when sorting by significance). Known protocols and larger diffs score higher. */
  priority: number
  /** How it was caught: 'Helius websocket', 'eth_getLogs · MEV Blocker' … (never a URL). */
  via: string
  /** 'pending': caught, being read · 'read': before/after read · 'partial': some reads were not possible (budget, endpoint). */
  state: 'pending' | 'read' | 'partial'
  /** Found by the first-start backfill, not live. */
  backfill?: boolean
  notes: string[]
  updatedAt: number
  /** The calls the radar made to read this event (detail view and /scan). */
  trace?: ScanCall[]
}

export interface RadarStatus {
  /** Per chain: how the radar listens right now, and whether it is up. */
  sources: Partial<Record<ChainId, { via: string; up: boolean; lastAt: number | null }>>
  /** Events of the last 24 h (by when they landed). */
  last24h: {
    total: number
    byKind: Partial<Record<RadarKind, number>>
    byChain: Partial<Record<ChainId, number>>
    /** Upgraded / BeaconUpgraded events whose proxies could not be checked (deployment or upgrade): not in byKind. */
    unchecked?: number
  }
  /** First-start backfill per chain. */
  backfill: Partial<Record<ChainId, { done: boolean; fromTs: number | null; events: number; note: string | null }>>
  budget: Record<string, { used: number; limit: number }>
  stored: number
  updatedAt: number
}

/** GET /api/radar answer. */
export interface RadarPage {
  items: RadarEvent[]
  next: string | null
  status: RadarStatus
}

// REST: GET /api/radar?chain=&kind=&known=1&sort=new|priority&limit=(≤100)&cursor= → RadarPage · GET /api/radar/:id → RadarEvent (full, with trace) | 404
// WS: { t: 'radar'; event: RadarEvent } (compact, < 8 KB; an update of an event re-sends it with the same id)
