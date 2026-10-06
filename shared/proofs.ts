// Proof of contribution: the byte-exact encoding of contribution epochs, shared by the server
// (server/proofs builds the trees and the hash chain) and the browser (re-derives leaves, walks
// Merkle paths and re-hashes the header chain with WebCrypto). Self-contained: no imports, and
// every hash function is passed in, so the same code runs on node:crypto and on crypto.subtle.
//
//   leaf        = sha256(0x00 ‖ u32be epoch ‖ identity (32 bytes) ‖ u64be credits ‖ u64be jobs ‖ u64be flops)
//                 credits in micro-credits (1 credit = 1 000 000), all integers
//   inner node  = sha256(0x01 ‖ left ‖ right)
//   tree        = leaf hashes sorted ascending (bytewise); each level pairs neighbours left to right;
//                 an odd last node is carried up unchanged (never duplicated)
//   root        = the top node; a single leaf's root is its leaf hash; an empty epoch's root is 32 zero bytes
//   header      = canonical JSON, fixed key order, integers and lowercase hex only (canonicalHeader)
//   headerHash  = sha256(utf8(canonical header)); epoch 0 (genesis) has prevHeaderHash = 32 zero bytes
//   identity    = wallet accounts: sha256(utf8("lusca:id:v1:wallet:" + address)), so anyone can derive it;
//                 device / label accounts: HMAC-SHA256 under the server's per-install secret (never reversible)

export const PROOF_VERSION = 1
/** 32 zero bytes, hex: prevHeaderHash of genesis and the root of an epoch without leaves. */
export const ZERO_HASH = '0'.repeat(64)
/** Credits are committed in integer micro-credits. */
export const MICRO = 1_000_000
export const LEAF_BYTES = 1 + 4 + 32 + 8 + 8 + 8
const HEX64 = /^[0-9a-f]{64}$/

/** One committed identity of one epoch. */
export interface ProofLeaf {
  /** Identity hash, 64 lowercase hex chars. */
  id: string
  /** Confirmed credits in the epoch, micro-credits (integer). */
  credits: number
  /** Verified jobs behind those credits. */
  jobs: number
  /** Verified floating-point operations behind those credits (rounded to an integer). */
  flops: number
}

export interface EpochTotals {
  /** Σ leaf credits (micro-credits). */
  credits: number
  jobs: number
  flops: number
  /** Lifetime confirmed credits on the ledger when the epoch closed (micro-credits). */
  ledgerCredits: number
}

export interface EpochHeader {
  v: number
  /** 0 = genesis (the full confirmed balance of every account when proofs started). */
  index: number
  startedAt: number
  endedAt: number
  leafCount: number
  totals: EpochTotals
  treeRoot: string
  prevHeaderHash: string
  headerHash: string
}

/** One step of a Merkle path: the sibling hash and the side it sits on. */
export interface PathStep {
  h: string
  side: 'L' | 'R'
}

// REST (server/proofs/http.ts)
// GET  /api/proofs?limit=&before=      -> ProofChainPage
// GET  /api/proofs/:index              -> { header: EpochHeader }
// GET  /api/proofs/:index/leaves.json  -> ProofLeaves
// POST /api/proofs/mine                -> ProofMine         body { auth?, device? } (same scope rules as account.watch)
// POST /api/proofs/:index/proof        -> ProofLookup       body { auth?, device? }
// POST /api/proofs/preview             -> PayoutPreviewData body { auth?, device? }

export interface ProofChainPage {
  /** Newest header; null before genesis has been written. */
  head: EpochHeader | null
  /** Newest first. */
  headers: EpochHeader[]
  /** Pass as `before` for the next (older) page; null at genesis. */
  next: number | null
  /** The open epoch collecting credits now. */
  open: { index: number; startedAt: number; closesAt: number } | null
  /** Startup verification of the stored chain. */
  status: ProofChainStatus
  epochMinutes: number
  /** Σ over every closed epoch, genesis included: credits in micro-credits, leaves = committed (identity, epoch) pairs. */
  committed: { epochs: number; credits: number; leaves: number }
}

export interface ProofChainStatus {
  ok: boolean
  /** Epochs whose header hash, link and root were re-checked at start (and every close since). */
  verified: number
  /** First problem found, if any. */
  error: string | null
  checkedAt: number
}

export interface ProofLeaves {
  index: number
  treeRoot: string
  /** Sorted by leaf hash, i.e. tree order. */
  leaves: ProofLeaf[]
}

export interface ProofIdentity {
  scope: 'wallet' | 'device'
  id: string
  /** Newest first: epochs with a leaf for this identity (up to 100). */
  epochs: number[]
}

export interface ProofMine {
  identities: ProofIdentity[]
}

export interface ProofLookup {
  header: EpochHeader
  scope: 'wallet' | 'device'
  /** null: this identity has no confirmed credits in that epoch. */
  leaf: ProofLeaf | null
  leafHash: string | null
  /** Position of the leaf in tree order. */
  position: number | null
  path: PathStep[]
}

export interface PayoutPreviewData {
  mode: string
  /** Credits since the last closed payout period (the ledger's period credits). */
  periodSince: number | null
  lastClosedId: string | null
  /** Caller's period credits: verified wallet (paid) and device (paid only once linked to a verified wallet). */
  you: { wallet: string | null; walletCredits: number; deviceCredits: number }
  /** Σ period credits of verified wallets (the payout snapshot right now). */
  totalCredits: number
  wallets: number
  rules: { maxWalletLamports: number; minLamports: number }
  at: number
}

// ─── encoding ───────────────────────────────────────────────────────────────

export function isHash(s: unknown): s is string {
  return typeof s === 'string' && HEX64.test(s)
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new Error('not lowercase hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

function u64(v: number, what: string): bigint {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${what} must be a non-negative safe integer`)
  return BigInt(v)
}

/** 0x00 ‖ u32be epoch ‖ id ‖ u64be credits ‖ u64be jobs ‖ u64be flops (61 bytes). */
export function leafBytes(epoch: number, leaf: ProofLeaf): Uint8Array {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > 0xffffffff) throw new Error('epoch must be a u32')
  if (!isHash(leaf.id)) throw new Error('identity must be 64 lowercase hex chars')
  const out = new Uint8Array(LEAF_BYTES)
  const dv = new DataView(out.buffer)
  out[0] = 0x00
  dv.setUint32(1, epoch, false)
  out.set(hexToBytes(leaf.id), 5)
  dv.setBigUint64(37, u64(leaf.credits, 'credits'), false)
  dv.setBigUint64(45, u64(leaf.jobs, 'jobs'), false)
  dv.setBigUint64(53, u64(leaf.flops, 'flops'), false)
  return out
}

/** 0x01 ‖ left ‖ right (65 bytes). */
export function nodeBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(65)
  out[0] = 0x01
  out.set(left, 1)
  out.set(right, 33)
  return out
}

/** The exact string headerHash is computed over. Key order is part of the format. */
export function canonicalHeader(h: Omit<EpochHeader, 'headerHash'>): string {
  return JSON.stringify({
    v: h.v,
    index: h.index,
    startedAt: h.startedAt,
    endedAt: h.endedAt,
    leafCount: h.leafCount,
    totals: { credits: h.totals.credits, jobs: h.totals.jobs, flops: h.totals.flops, ledgerCredits: h.totals.ledgerCredits },
    treeRoot: h.treeRoot,
    prevHeaderHash: h.prevHeaderHash,
  })
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

// ─── async verification (browser: crypto.subtle; tests: node) ───────────────

export type AsyncHash = (data: Uint8Array) => Promise<Uint8Array>

/** WebCrypto SHA-256 (browsers, and Node ≥ 20 through globalThis.crypto). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DOM and Node type the argument differently
export function subtleSha256(subtle: { digest(alg: string, data: any): Promise<ArrayBuffer> }): AsyncHash {
  return async (data) => new Uint8Array(await subtle.digest('SHA-256', data))
}

export async function leafHashAsync(hash: AsyncHash, epoch: number, leaf: ProofLeaf): Promise<string> {
  return bytesToHex(await hash(leafBytes(epoch, leaf)))
}

export interface PathTrace {
  /** Hash after each step, starting with the leaf hash. */
  steps: { sibling: string | null; side: 'L' | 'R' | null; out: string }[]
  root: string
}

/** Walk a Merkle path from a leaf hash, recording every intermediate hash. */
export async function walkPath(hash: AsyncHash, leafHash: string, path: PathStep[]): Promise<PathTrace> {
  let cur = hexToBytes(leafHash)
  const steps: PathTrace['steps'] = [{ sibling: null, side: null, out: leafHash }]
  for (const s of path) {
    const sib = hexToBytes(s.h)
    cur = await hash(s.side === 'L' ? nodeBytes(sib, cur) : nodeBytes(cur, sib))
    steps.push({ sibling: s.h, side: s.side, out: bytesToHex(cur) })
  }
  return { steps, root: bytesToHex(cur) }
}

/** Root of a set of leaves (any order): the same tree the server builds. */
export async function merkleRootAsync(hash: AsyncHash, epoch: number, leaves: ProofLeaf[]): Promise<string> {
  if (!leaves.length) return ZERO_HASH
  let level: Uint8Array[] = []
  for (const l of leaves) level.push(await hash(leafBytes(epoch, l)))
  level.sort(compareBytes)
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? await hash(nodeBytes(level[i], level[i + 1])) : level[i])
    level = next
  }
  return bytesToHex(level[0])
}

export async function headerHashAsync(hash: AsyncHash, h: Omit<EpochHeader, 'headerHash'>): Promise<string> {
  return bytesToHex(await hash(utf8(canonicalHeader(h))))
}

export interface ChainCheck {
  ok: boolean
  checked: number
  /** Index of the first bad header, with the reason. */
  bad: { index: number; reason: string } | null
}

/**
 * Re-hash a run of consecutive headers (any order) and check every link. `anchor` is the header
 * just below the oldest one given (null when the run starts at genesis).
 */
export async function verifyHeadersAsync(hash: AsyncHash, headers: EpochHeader[], anchor: EpochHeader | null = null): Promise<ChainCheck> {
  const hs = [...headers].sort((a, b) => a.index - b.index)
  let prev = anchor
  let checked = 0
  for (const h of hs) {
    const recomputed = await headerHashAsync(hash, h)
    if (recomputed !== h.headerHash) return { ok: false, checked, bad: { index: h.index, reason: `header hash mismatch (recomputed ${recomputed.slice(0, 12)}…)` } }
    if (prev === null) {
      if (h.index !== 0 || h.prevHeaderHash !== ZERO_HASH) return { ok: false, checked, bad: { index: h.index, reason: 'chain does not start at genesis' } }
    } else {
      if (h.index !== prev.index + 1) return { ok: false, checked, bad: { index: h.index, reason: `index gap after ${prev.index}` } }
      if (h.prevHeaderHash !== prev.headerHash) return { ok: false, checked, bad: { index: h.index, reason: `prevHeaderHash does not match epoch ${prev.index}` } }
      if (h.totals.ledgerCredits < prev.totals.ledgerCredits) return { ok: false, checked, bad: { index: h.index, reason: 'ledger lifetime credits went down' } }
    }
    prev = h
    checked++
  }
  return { ok: true, checked, bad: null }
}
