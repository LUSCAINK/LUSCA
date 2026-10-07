// RADAR DIFF: the source change behind one EVM upgrade (both implementations verified on Sourcify).
// Shared between server/radar/code-diff.ts and src/pages/RadarDiff.tsx. Facts only: the files that
// changed, line by line, and the functions they touch.

import type { ChainId } from './chain.ts'
import type { RadarVerified } from './radar.ts'

/** One line of a hunk: ' ' context · '+' added · '-' removed. `o` / `n`: line number on the old / new side. */
export interface DiffLine {
  t: ' ' | '+' | '-'
  o: number | null
  n: number | null
  s: string
  /** The line holds an access check (only* modifier, onlyRole, msg.sender comparison, _checkOwner …). */
  ac?: 1
}

export interface DiffHunk {
  /** Anchor id ('f2h3'). */
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Enclosing function / contract on the new side, when known. */
  ctx: string | null
  lines: DiffLine[]
}

export interface DiffFile {
  /** Anchor id ('f2'). */
  id: string
  path: string
  /** Path on the old side when the file moved (paired by file name). */
  oldPath?: string | null
  status: 'modified' | 'added' | 'removed'
  add: number
  del: number
  hunks: DiffHunk[]
  /** Hunks / lines left out by the size bound. */
  omitted?: { hunks: number; lines: number } | null
}

export interface DiffFunction {
  /** Name with parameter types: 'cancelClosing()'. */
  sig: string
  kind: 'function' | 'modifier' | 'constructor' | 'fallback' | 'receive'
  change: 'added' | 'removed' | 'modified'
  /** file:line on the new side (old side for removed). */
  at: string
  file: string
  line: number
  /** The access check on the function (new side; old side for removed), or null. */
  access: string | null
  /** The access check changed: before → after (modified functions). */
  accessBefore?: string | null
  /** Hunk anchor that shows it, when it is in the diff. */
  hunk: string | null
}

export interface RadarCodeDiff {
  id: string
  chain: ChainId
  address: string
  name: string | null
  block: number | null
  tx: string | null
  ts: number
  oldImpl: string | null
  newImpl: string | null
  oldVerified: RadarVerified | null
  newVerified: RadarVerified | null
  oldCompiler: string | null
  newCompiler: string | null
  /** 'ready': diff below · 'unavailable': cannot be computed (reason) · 'pending': not computed yet (reason, retry later). */
  state: 'ready' | 'unavailable' | 'pending'
  reason: string | null
  files: DiffFile[]
  /** Source files present and identical on both sides. */
  unchangedFiles: number
  functions: DiffFunction[]
  totals: { files: number; add: number; del: number }
  /** Honest note when the size bound cut the diff. */
  truncated: string | null
  computedAt: number | null
}

/** A radar event the diff can be computed for (the client shows "diff →" on these cards). */
export function diffable(e: { chain: ChainId; kind: string; before?: { implementation?: string | null; verified: RadarVerified } | null; after?: { implementation?: string | null; verified: RadarVerified } | null }): boolean {
  if (e.chain === 'solana' || e.kind !== 'upgrade') return false
  const b = e.before
  const a = e.after
  if (!b?.implementation || !a?.implementation || b.implementation === a.implementation) return false
  const sfy = (v: RadarVerified) => v === 'sourcify-full' || v === 'sourcify-partial'
  return sfy(b.verified) && sfy(a.verified)
}
