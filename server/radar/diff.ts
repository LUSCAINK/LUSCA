// Before / after of one program or implementation, and the difference between them. Pure.

import type { ChainId, ChainRead } from '../../shared/chain.ts'
import type { RadarDiff, RadarGuard, RadarList, RadarSide, RadarVerified } from '../../shared/radar.ts'
import { emptyDiff, verifiedOf } from './parse.ts'

/** What the radar remembers of one program / proxy / implementation (persisted, bounded). */
export interface Snapshot {
  chain: ChainId
  address: string
  at: number
  codeHash: string | null
  authority: string | null
  upgradeable: boolean | null
  implementation?: string | null
  beacon?: string | null
  verified: RadarVerified
  name: string | null
  /** Instruction names (Solana IDL) / function signatures (EVM ABI); null = unknown. */
  surface: string[] | null
  /** Admin-only functions (EVM verified source); null = not analysed. */
  guards: RadarGuard[] | null
  /** Primitive names from the program binary (Solana); null = unknown. */
  primitives: string[] | null
  deploySlot: number | null
  bytes: number | null
  /** Why the address is a known protocol (kept item, code index), when it is. */
  known?: string | null
}

export const SURFACE_CAP = 400
export const GUARD_CAP = 60
export const LIST_CAP = 64

/** Snapshot of a read (shared ChainRead) plus what the radar analysed of it. */
export function snapshotOfRead(read: ChainRead, x: { guards?: RadarGuard[] | null; primitives?: string[] | null; registryAsked: boolean; at?: number }): Snapshot {
  const sol = read.chain === 'solana'
  const surface = sol ? (read.idl ? read.idl.instructions.map((i) => i.name) : null) : read.abi ? [...new Set(read.abi.functions)] : null
  return {
    chain: read.chain,
    address: read.address,
    at: x.at ?? (read.readAt || Date.now()),
    codeHash: read.codeHash,
    authority: read.upgradeAuthority,
    upgradeable: read.upgradeable,
    implementation: sol ? undefined : (read.proxy?.implementation ?? null),
    verified: verifiedOf(read.verified, x.registryAsked),
    name: read.name,
    surface: surface ? surface.slice(0, SURFACE_CAP) : null,
    guards: x.guards ? x.guards.slice(0, GUARD_CAP) : null,
    primitives: x.primitives ?? null,
    deploySlot: read.lastDeploySlot,
    bytes: read.programBytes ?? read.bytecodeBytes,
  }
}

/** The public side of a snapshot. */
export function sideOf(s: Snapshot, from: RadarSide['from']): RadarSide {
  const side: RadarSide = {
    at: s.at,
    from,
    codeHash: s.codeHash,
    authority: s.authority,
    upgradeable: s.upgradeable,
    verified: s.verified,
    name: s.name,
    surfaceCount: s.surface ? s.surface.length : null,
    deploySlot: s.deploySlot,
    bytes: s.bytes,
  }
  if (s.implementation !== undefined) side.implementation = s.implementation
  if (s.beacon !== undefined) side.beacon = s.beacon
  if (s.chain === 'solana') side.primitives = s.primitives
  else side.guardCount = s.guards ? s.guards.length : null
  return side
}

function list(items: string[], cap = LIST_CAP): RadarList {
  return { items: items.slice(0, cap), more: Math.max(0, items.length - cap) }
}

/** a − b, order of a kept. */
export function minus(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b)
  return [...new Set(a)].filter((x) => !set.has(x))
}

const guardKey = (g: RadarGuard) => `${g.fn}|${g.guard}`

/**
 * Difference between what was known before and what was read after. Each part is 'unknown' / null
 * when either side does not know it: nothing is compared against a guess.
 */
export function diffSnapshots(before: Snapshot | null, after: Snapshot | null): RadarDiff {
  const d = emptyDiff()
  if (!after) return d
  d.surface = after.chain === 'solana' ? 'instructions' : 'functions'
  if (!before) return d
  if (before.codeHash && after.codeHash) d.code = before.codeHash === after.codeHash ? 'same' : 'changed'
  if (before.at && after.at) d.authority = (before.authority ?? null) === (after.authority ?? null) ? 'same' : 'changed'
  if (before.verified !== 'unknown' && after.verified !== 'unknown') d.verified = before.verified === after.verified ? 'same' : 'changed'
  if (before.surface && after.surface) {
    d.added = list(minus(after.surface, before.surface))
    d.removed = list(minus(before.surface, after.surface))
  }
  if (before.guards && after.guards) {
    // a function that was guarded before is not "new"; one whose guard changed is listed with its new guard
    const was = new Set(before.guards.map(guardKey))
    const now = new Set(after.guards.map(guardKey))
    d.guardsAdded = after.guards.filter((g) => !was.has(guardKey(g))).slice(0, 20)
    d.guardsRemoved = before.guards.filter((g) => !now.has(guardKey(g))).slice(0, 20)
  }
  if (before.primitives && after.primitives) {
    d.primitivesAdded = minus(after.primitives, before.primitives)
    d.primitivesRemoved = minus(before.primitives, after.primitives)
  }
  return d
}

/** True when the diff says anything beyond "unknown". */
export function diffKnown(d: RadarDiff | null): boolean {
  return !!d && (d.code !== 'unknown' || d.authority !== 'unknown' || d.added !== null || d.guardsAdded !== null || d.primitivesAdded !== null)
}
