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

function byFn(gs: readonly RadarGuard[]): Map<string, RadarGuard[]> {
  const m = new Map<string, RadarGuard[]>()
  for (const g of gs) {
    const l = m.get(g.fn)
    if (l) l.push(g)
    else m.set(g.fn, [g])
  }
  return m
}

/**
 * Admin-only functions before → after, compared by function: new = guarded now and not guarded at all
 * before (added by this change, or an existing function that gained an access check); removed = guarded
 * before and not now; changed = guarded on both sides by a different check. A guard that only moved to
 * another line is no change.
 */
export function diffGuards(before: readonly RadarGuard[], after: readonly RadarGuard[]): Pick<RadarDiff, 'guardsAdded' | 'guardsRemoved' | 'guardsChanged'> {
  const b = byFn(before)
  const a = byFn(after)
  const added: RadarGuard[] = []
  const removed: RadarGuard[] = []
  const changed: { fn: string; before: RadarGuard; after: RadarGuard }[] = []
  for (const [fn, gs] of a) {
    const was = b.get(fn)
    if (!was) {
      added.push(gs[0])
      continue
    }
    const wasSet = new Set(was.map((g) => g.guard))
    const nowSet = new Set(gs.map((g) => g.guard))
    if (wasSet.size === nowSet.size && [...nowSet].every((x) => wasSet.has(x))) continue
    const newOne = gs.find((g) => !wasSet.has(g.guard)) ?? gs[0]
    const oldOne = was.find((g) => !nowSet.has(g.guard)) ?? was[0]
    changed.push({ fn, before: oldOne, after: newOne })
  }
  for (const [fn, gs] of b) if (!a.has(fn)) removed.push(gs[0])
  return { guardsAdded: added.slice(0, 20), guardsRemoved: removed.slice(0, 20), guardsChanged: changed.slice(0, 20) }
}

/**
 * Before and after can only be compared when `before` describes the program before this change: its
 * last deploy is older than the change's slot, and it was read before the change landed. A read taken
 * after the change (a backfill that read the program first for a newer upgrade, a restart) is not a before.
 */
export function validBefore(s: Pick<Snapshot, 'at' | 'deploySlot'>, change: { slot: number | null; ts: number }): boolean {
  if (s.deploySlot != null && change.slot != null && s.deploySlot >= change.slot) return false
  return !!s.at && s.at < change.ts
}

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
  // the upgrade authority is a fact of a program read on both sides (a closed program has none to compare);
  // EVM implementation reads carry no proxy admin
  if (after.chain === 'solana' && before.codeHash && after.codeHash && before.at && after.at) d.authority = (before.authority ?? null) === (after.authority ?? null) ? 'same' : 'changed'
  if (before.verified !== 'unknown' && after.verified !== 'unknown') d.verified = before.verified === after.verified ? 'same' : 'changed'
  if (before.surface && after.surface) {
    d.added = list(minus(after.surface, before.surface))
    d.removed = list(minus(before.surface, after.surface))
  }
  if (before.guards && after.guards) Object.assign(d, diffGuards(before.guards, after.guards))
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
