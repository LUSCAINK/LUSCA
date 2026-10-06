// Proof of contribution: hourly contribution epochs over the coordinator's confirmed credits.
//
// Every LUSCA_EPOCH_MIN minutes (default 60, boundaries aligned to the UTC clock) the open epoch is
// closed: one leaf per ledger account that received CONFIRMED credits in it (escrowed gradient
// credits only once an audit confirmed them; forfeited escrow never), a sorted-leaf binary Merkle
// tree over those leaves, and a header that commits to the tree root and to the previous header's
// hash. Epoch 0 (genesis) commits every account's full confirmed balance when proofs first started,
// so the history before this module existed is covered too. The byte format is in shared/proofs.ts.
//
// Storage: <dataDir>/proofs/l-<index>.json (leaves, tree order) then h-<index>.json (header), each
// written to a tmp file, fsync'd and renamed; a header is never overwritten. The open epoch's
// per-account credits live in ledger.json (coordinator EpochLedger) and the epoch being closed is
// saved there first as a write-ahead record, so a hard kill at any point either finishes the
// close on the next start or never happened. Every start re-hashes the whole chain (header hashes,
// links, roots, totals) and logs loudly when anything does not match.
//
// Identities: wallets are sha256("lusca:id:v1:wallet:" + address) so anyone can derive them;
// device / label accounts are HMAC-SHA256 under the per-install secret (LUSCA_HASH_SALT or
// <dataDir>/hash.salt), so no device id ever leaves the server.

import fs from 'node:fs'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'
import {
  PROOF_VERSION,
  ZERO_HASH,
  bytesToHex,
  canonicalHeader,
  compareBytes,
  isHash,
  ledgerDropReason,
  leafBytes,
  nodeBytes,
  type EpochHeader,
  type PathStep,
  type ProofChainPage,
  type ProofChainStatus,
  type ProofIdentity,
  type ProofLeaf,
  type ProofLookup,
} from '../../shared/proofs.ts'
import type { EpochLedger, EpochRow } from '../neurons/coordinator.ts'

type LogFn = (level: 'info' | 'warn' | 'error', msg: string) => void

const HEADER_RE = /^h-(\d{8})\.json$/
const TICK_MS = 15_000
const LEAF_CACHE = 24
const TREE_CACHE = 8
const JSON_CACHE = 4
const IDENT_EPOCHS = 100
const MAX_IDENTS = 50_000
/** The open epoch counts as stalled this long after its close time. */
const STALL_MS = 120_000
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN'])

// ─── pure tree code (sync, node:crypto) ─────────────────────────────────────

export function sha256(b: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(b).digest())
}

export function leafHash(epoch: number, leaf: ProofLeaf): Uint8Array {
  return sha256(leafBytes(epoch, leaf))
}

/** Leaves in tree order (ascending leaf hash), with their hashes. */
export function orderLeaves(epoch: number, leaves: ProofLeaf[]): { leaves: ProofLeaf[]; hashes: Uint8Array[] } {
  const rows = leaves.map((l) => ({ l, h: leafHash(epoch, l) }))
  rows.sort((a, b) => compareBytes(a.h, b.h))
  return { leaves: rows.map((r) => r.l), hashes: rows.map((r) => r.h) }
}

/** Levels of the tree, bottom (sorted leaf hashes) to top. */
export function treeLevels(hashes: Uint8Array[]): Uint8Array[][] {
  const levels: Uint8Array[][] = [hashes]
  let level = hashes
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? sha256(nodeBytes(level[i], level[i + 1])) : level[i])
    levels.push(next)
    level = next
  }
  return levels
}

export function merkleRoot(hashes: Uint8Array[]): string {
  if (!hashes.length) return ZERO_HASH
  const levels = treeLevels(hashes)
  return bytesToHex(levels[levels.length - 1][0])
}

/** Merkle path of the leaf at `pos` (an odd last node at some level has no sibling there). */
export function merklePath(hashes: Uint8Array[], pos: number): PathStep[] {
  return pathFromLevels(treeLevels(hashes), pos)
}

/** Merkle path from prebuilt levels (treeLevels). */
export function pathFromLevels(levels: Uint8Array[][], pos: number): PathStep[] {
  const out: PathStep[] = []
  let i = pos
  for (let d = 0; d < levels.length - 1; d++) {
    const level = levels[d]
    const sib = i ^ 1
    if (sib < level.length) out.push({ h: bytesToHex(level[sib]), side: sib < i ? 'L' : 'R' })
    i = i >> 1
  }
  return out
}

/** Recompute a path's root (sync twin of shared walkPath). */
export function rootFromPath(leaf: Uint8Array, path: PathStep[]): string {
  let cur = leaf
  for (const s of path) {
    const sib = Buffer.from(s.h, 'hex')
    cur = sha256(s.side === 'L' ? nodeBytes(sib, cur) : nodeBytes(cur, sib))
  }
  return bytesToHex(cur)
}

export function headerHash(h: Omit<EpochHeader, 'headerHash'>): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalHeader(h))))
}

/** Build a closed epoch from its leaves. */
export function buildEpoch(index: number, startedAt: number, endedAt: number, leaves: ProofLeaf[], prev: EpochHeader | null, ledgerCredits: number): { header: EpochHeader; leaves: ProofLeaf[] } {
  const ordered = orderLeaves(index, leaves)
  let credits = 0
  let jobs = 0
  let flops = 0
  for (const l of ordered.leaves) {
    credits += l.credits
    jobs += l.jobs
    flops += l.flops
  }
  const base: Omit<EpochHeader, 'headerHash'> = {
    v: PROOF_VERSION,
    index,
    startedAt,
    endedAt,
    leafCount: ordered.leaves.length,
    totals: { credits, jobs, flops, ledgerCredits },
    treeRoot: merkleRoot(ordered.hashes),
    prevHeaderHash: prev ? prev.headerHash : ZERO_HASH,
  }
  return { header: { ...base, headerHash: headerHash(base) }, leaves: ordered.leaves }
}

/**
 * Check one stored epoch against its predecessor. Returns a reason, or null when it holds. A drop in
 * the ledger's lifetime credits is not a broken chain (see ledgerDropReason): it is reported apart.
 */
export function checkEpoch(h: EpochHeader, leaves: ProofLeaf[] | null, prev: EpochHeader | null): string | null {
  const { headerHash: stored, ...base } = h
  if (headerHash(base) !== stored) return 'header hash does not match its contents'
  if (prev === null) {
    if (h.index !== 0 || h.prevHeaderHash !== ZERO_HASH) return 'chain does not start at genesis'
  } else {
    if (h.index !== prev.index + 1) return `index gap after epoch ${prev.index}`
    if (h.prevHeaderHash !== prev.headerHash) return `prevHeaderHash does not match epoch ${prev.index}`
  }
  if (leaves === null) return 'leaves file missing or unreadable'
  if (leaves.length !== h.leafCount) return `leafCount ${h.leafCount} but ${leaves.length} leaves stored`
  const ordered = orderLeaves(h.index, leaves)
  if (merkleRoot(ordered.hashes) !== h.treeRoot) return 'leaves do not hash to treeRoot'
  let credits = 0
  for (const l of leaves) credits += l.credits
  if (credits !== h.totals.credits) return 'leaf credits do not sum to the header total'
  return null
}

// ─── identities ─────────────────────────────────────────────────────────────

export function walletIdentity(wallet: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`lusca:id:v1:wallet:${wallet}`)))
}

export function identityFor(salt: Buffer, ledgerKey: string): string {
  if (ledgerKey.startsWith('wallet:')) return walletIdentity(ledgerKey.slice(7))
  return createHmac('sha256', salt).update(`lusca:id:v1:${ledgerKey}`).digest('hex')
}

// ─── parsing ────────────────────────────────────────────────────────────────

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

export function parseHeader(raw: unknown): EpochHeader | null {
  if (!raw || typeof raw !== 'object') return null
  const h = raw as Partial<EpochHeader>
  const t = h.totals as Partial<EpochHeader['totals']> | undefined
  if (!isInt(h.v) || !isInt(h.index) || !isInt(h.startedAt) || !isInt(h.endedAt) || !isInt(h.leafCount)) return null
  if (!t || !isInt(t.credits) || !isInt(t.jobs) || !isInt(t.flops) || !isInt(t.ledgerCredits)) return null
  if (!isHash(h.treeRoot) || !isHash(h.prevHeaderHash) || !isHash(h.headerHash)) return null
  return {
    v: h.v,
    index: h.index,
    startedAt: h.startedAt,
    endedAt: h.endedAt,
    leafCount: h.leafCount,
    totals: { credits: t.credits, jobs: t.jobs, flops: t.flops, ledgerCredits: t.ledgerCredits },
    treeRoot: h.treeRoot,
    prevHeaderHash: h.prevHeaderHash,
    headerHash: h.headerHash,
  }
}

export function parseLeaves(raw: unknown): ProofLeaf[] | null {
  if (!raw || typeof raw !== 'object') return null
  const rows = (raw as { leaves?: unknown }).leaves
  if (!Array.isArray(rows)) return null
  const out: ProofLeaf[] = []
  for (const r of rows) {
    if (!Array.isArray(r) || !isHash(r[0]) || !isInt(r[1]) || !isInt(r[2]) || !isInt(r[3])) return null
    out.push({ id: r[0], credits: r[1], jobs: r[2], flops: r[3] })
  }
  return out
}

/** The write-ahead record kept in ledger.json while an epoch is being closed. */
interface ClosingRecord {
  header: EpochHeader
  leaves: ProofLeaf[]
}

function parseClosing(raw: unknown): ClosingRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const header = parseHeader((raw as { header?: unknown }).header)
  const rows = (raw as { leaves?: unknown }).leaves
  const leaves = Array.isArray(rows)
    ? parseLeaves({ leaves: rows.map((l) => (l && typeof l === 'object' && !Array.isArray(l) ? [(l as ProofLeaf).id, (l as ProofLeaf).credits, (l as ProofLeaf).jobs, (l as ProofLeaf).flops] : l)) })
    : null
  return header && leaves ? { header, leaves } : null
}

// ─── the module ─────────────────────────────────────────────────────────────

export interface ProofsOptions {
  dataDir: string
  epochs: EpochLedger
  /** Secret for device / label identity HMACs (the coordinator's hash salt). */
  salt: Buffer
  /** Epoch length in minutes (LUSCA_EPOCH_MIN, default 60). */
  epochMinutes?: number
  /** Session-token check (server/auth): token → verified wallet. */
  checkToken?: (token: unknown) => { wallet: string } | null
  /**
   * Start a new chain (new genesis) even though ledger.json shows one existed (LUSCA_PROOFS_RESTART=1).
   * Without it a missing proofs/ directory turns proofs off instead of silently starting over.
   */
  allowRestart?: boolean
  log?: LogFn
  now?: () => number
}

export interface ProofsApi {
  page(limit: number, before: number | null): ProofChainPage
  header(index: number): EpochHeader | null
  leaves(index: number): ProofLeaf[] | null
  /** leaves.json body of a closed epoch, serialized once and cached (closed epochs never change). */
  leavesJson(index: number): { text: string; etag: string } | null
  /** Identities of the caller (same scope rules as account.watch); [] when neither is valid. */
  resolve(auth: unknown, device: unknown): { scope: 'wallet' | 'device'; key: string; wallet: string | null }[]
  mine(auth: unknown, device: unknown): ProofIdentity[]
  proof(index: number, auth: unknown, device: unknown): ProofLookup[] | null
  status(): ProofChainStatus & { head: number | null; pendingWrite: boolean; stalled: boolean }
  /** Close the open epoch now if it is due (also run by the timer). Returns the closed header. */
  tick(force?: boolean): EpochHeader | null
  start(): void
  stop(): void
}

const pad = (i: number) => String(i).padStart(8, '0')
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/

export function resolveEpochMinutes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.LUSCA_EPOCH_MIN?.trim()
  if (!raw) return 60
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(24 * 60, Math.max(1, n)) : 60
}

export function createProofs(opts: ProofsOptions): ProofsApi {
  const dir = path.join(opts.dataDir, 'proofs')
  const log: LogFn = (level, msg) => {
    try {
      ;(opts.log ?? ((l, m) => console[l === 'info' ? 'log' : l](`[proofs] ${m}`)))(level, msg)
    } catch {
      /* never throw from logging */
    }
  }
  const now = opts.now ?? Date.now
  const epochMs = Math.round((opts.epochMinutes ?? 60) * 60_000)
  const epochs = opts.epochs
  const headers: EpochHeader[] = [] // index-ordered, contiguous from 0 while the chain is intact
  const leafCache = new Map<number, ProofLeaf[]>()
  // tree order, every level and leaf positions of the most recently looked-up epochs
  const treeCache = new Map<number, { leaves: ProofLeaf[]; levels: Uint8Array[][]; pos: Map<string, number> }>()
  const jsonCache = new Map<number, { text: string; etag: string }>()
  // identity → epochs with a leaf (oldest first, capped); least recently seen identities are evicted first
  const identEpochs = new Map<string, number[]>()
  let status: ProofChainStatus = { ok: true, state: 'verified', verified: 0, error: null, warning: null, checkedAt: 0 }
  let pendingWrite: ClosingRecord | null = null
  let timer: NodeJS.Timeout | null = null
  let retry: NodeJS.Timeout | null = null
  let ready = false
  let savingWarned = false
  const committed = { credits: 0, leaves: 0 } // Σ over every stored header (genesis included)

  const head = () => (headers.length ? headers[headers.length - 1] : null)
  const closesAt = (startedAt: number) => Math.floor(startedAt / epochMs) * epochMs + epochMs

  function noteIdentities(index: number, leaves: ProofLeaf[]) {
    for (const l of leaves) {
      let list = identEpochs.get(l.id)
      if (list) identEpochs.delete(l.id) // re-insert: Map order = least recently seen first
      else {
        list = []
        while (identEpochs.size >= MAX_IDENTS) identEpochs.delete(identEpochs.keys().next().value as string)
      }
      identEpochs.set(l.id, list)
      list.push(index)
      if (list.length > IDENT_EPOCHS) list.splice(0, list.length - IDENT_EPOCHS)
    }
  }

  function isStalled(): boolean {
    const open = epochs.open()
    return ready && !!open && now() > closesAt(open.startedAt) + STALL_MS
  }

  function setOff(reason: string) {
    status = { ...status, ok: false, state: 'off', error: reason, checkedAt: now() }
  }

  function noteWarning(h: EpochHeader, prev: EpochHeader | null) {
    const w = prev ? ledgerDropReason(h, prev) : null
    if (!w) return
    status = { ...status, warning: status.warning ?? `epoch ${h.index}: ${w}` }
    log('warn', `epoch ${h.index}: ${w}. The chain still links; the header records it.`)
  }

  function cacheLeaves(index: number, leaves: ProofLeaf[]) {
    leafCache.delete(index)
    leafCache.set(index, leaves)
    while (leafCache.size > LEAF_CACHE) leafCache.delete(leafCache.keys().next().value as number)
  }

  function readJson(file: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  function readLeaves(index: number): ProofLeaf[] | null {
    const hit = leafCache.get(index)
    if (hit) return hit
    const leaves = parseLeaves(readJson(path.join(dir, `l-${pad(index)}.json`)))
    if (leaves) cacheLeaves(index, leaves)
    return leaves
  }

  function fsyncDir() {
    try {
      const fd = fs.openSync(dir, 'r')
      try {
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      /* not supported (Windows) */
    }
  }

  function sleepSync(ms: number) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  }

  /** tmp (fsync'd) → rename. `exclusive`: never replace an existing file. */
  function writeFileDurable(file: string, data: string, exclusive: boolean) {
    fs.mkdirSync(dir, { recursive: true })
    if (exclusive && fs.existsSync(file)) throw new Error(`${path.basename(file)} already exists`)
    const tmp = `${file}.${process.pid}.tmp`
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, data, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file)
        break
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? ''
        if (i >= 5 || !RETRYABLE.has(code)) {
          try {
            fs.rmSync(tmp, { force: true })
          } catch {
            /* ignore */
          }
          throw e
        }
        sleepSync(50 * (i + 1))
      }
    }
    fsyncDir()
  }

  /** Persist a closed epoch: leaves first, then the header (its presence = committed). */
  function persist(rec: ClosingRecord) {
    const h = rec.header
    const hFile = path.join(dir, `h-${pad(h.index)}.json`)
    const existing = parseHeader(readJson(hFile))
    if (existing) {
      if (existing.headerHash === h.headerHash) return // already on disk (crash after the header write)
      throw new Error(`epoch ${h.index} is already on disk with a different header hash; refusing to overwrite it`)
    }
    const leavesJson = JSON.stringify({ index: h.index, treeRoot: h.treeRoot, leaves: rec.leaves.map((l) => [l.id, l.credits, l.jobs, l.flops]) })
    writeFileDurable(path.join(dir, `l-${pad(h.index)}.json`), leavesJson, false)
    writeFileDurable(hFile, `${JSON.stringify(h)}\n`, true)
  }

  function adopt(rec: ClosingRecord) {
    noteWarning(rec.header, head())
    headers.push(rec.header)
    committed.credits += rec.header.totals.credits
    committed.leaves += rec.header.leafCount
    cacheLeaves(rec.header.index, rec.leaves)
    noteIdentities(rec.header.index, rec.leaves)
    if (status.ok) status = { ...status, verified: status.verified + 1, checkedAt: now() }
  }

  /** Write the pending record; on success adopt it and drop the ledger's write-ahead copy. */
  function flushPending(): boolean {
    if (!pendingWrite) return true
    try {
      persist(pendingWrite)
    } catch (e) {
      log('error', `could not write epoch ${pendingWrite.header.index}: ${(e as Error).message} (kept in ledger.json; retrying)`)
      return false
    }
    adopt(pendingWrite)
    log('info', `epoch ${pendingWrite.header.index} closed: ${pendingWrite.header.leafCount} identities, ${(pendingWrite.header.totals.credits / 1e6).toFixed(2)} credits, root ${pendingWrite.header.treeRoot.slice(0, 16)}…`)
    pendingWrite = null
    epochs.clearClosing()
    return true
  }

  function leavesFromRows(rows: Map<string, EpochRow>): ProofLeaf[] {
    const byId = new Map<string, ProofLeaf>()
    for (const [key, r] of rows) {
      const credits = Math.round(r.credits)
      if (!(credits > 0)) continue
      const id = identityFor(opts.salt, key)
      const prev = byId.get(id)
      const jobs = Math.max(0, Math.round(r.jobs))
      const flops = Math.max(0, Math.round(r.flops))
      if (prev) {
        prev.credits += credits
        prev.jobs += jobs
        prev.flops += flops
      } else byId.set(id, { id, credits, jobs, flops })
    }
    return [...byId.values()]
  }

  /** Load and verify the stored chain. */
  function load() {
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter((n) => HEADER_RE.test(n)).sort()
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log('error', `cannot read ${dir}: ${(e as Error).message}`)
    }
    let error: string | null = null
    let verified = 0
    const t0 = performance.now()
    for (const n of names) {
      const h = parseHeader(readJson(path.join(dir, n)))
      const fileIndex = Number(HEADER_RE.exec(n)![1])
      if (!h || h.index !== fileIndex) {
        error ??= `${n} is unreadable or does not match its file name`
        break
      }
      const prev = headers.length ? headers[headers.length - 1] : null
      const leaves = parseLeaves(readJson(path.join(dir, `l-${pad(h.index)}.json`)))
      const bad = checkEpoch(h, leaves, prev)
      if (prev && !bad) noteWarning(h, prev)
      if (bad) {
        error ??= `epoch ${h.index}: ${bad}`
        // keep going from here so the chain can still be served and extended; the status stays broken
      } else verified++
      headers.push(h)
      committed.credits += h.totals.credits
      committed.leaves += h.leafCount
      if (leaves) {
        noteIdentities(h.index, leaves)
        if (h.index >= names.length - LEAF_CACHE) cacheLeaves(h.index, leaves)
      }
    }
    status = { ok: error === null, state: error === null ? 'verified' : 'broken', verified, error, warning: status.warning ?? null, checkedAt: now() }
    const ms = Math.round(performance.now() - t0)
    if (error) log('error', `PROOF CHAIN BROKEN — ${error}. ${verified}/${headers.length} epochs verified. Closed epochs are never rewritten; investigate ${dir}.`)
    else if (headers.length) log('info', `proof chain verified: ${headers.length} epochs, head ${head()!.index} (${head()!.headerHash.slice(0, 16)}…) in ${ms} ms`)
  }

  function init() {
    load()
    // 1. finish (or drop) an epoch whose close was interrupted after the ledger save
    const closing = parseClosing(epochs.closing())
    if (closing) {
      const h = head()
      const expected = h ? h.index + 1 : 0
      if (closing.header.index === expected && closing.header.prevHeaderHash === (h ? h.headerHash : ZERO_HASH)) {
        pendingWrite = closing
        if (flushPending()) log('warn', `epoch ${closing.header.index}: the close was interrupted by a restart; finished from the ledger's write-ahead record`)
      } else if (h && closing.header.index <= h.index) {
        epochs.clearClosing()
      } else {
        log('error', `ledger.json holds a closing record for epoch ${closing.header.index} that does not extend the chain (head ${h ? h.index : 'none'}); dropped`)
        epochs.clearClosing()
      }
    } else if (epochs.closing() != null) epochs.clearClosing()

    // a close that could not be written yet (disk error) still counts as the head: tick() retries it
    const h = pendingWrite ? pendingWrite.header : head()
    const open = epochs.open()
    if (!h) {
      // 2. genesis: the full confirmed balance of every account, once
      if (!epochs.saving()) {
        log('error', 'the ledger is not being saved; contribution proofs are off until ledger.json is readable')
        setOff('ledger.json is not readable, so no epoch can be committed')
        return
      }
      if (open && open.index > 0) {
        // A chain existed (the ledger is collecting epoch N > 0) but proofs/ is gone. Starting over
        // silently would hand out a fresh chain that passes every check; refuse unless told to.
        if (!opts.allowRestart) {
          log('error', `PROOF CHAIN MISSING — ledger.json is collecting epoch ${open.index} but ${dir} holds no chain. Proofs are off. Restore the directory, or set LUSCA_PROOFS_RESTART=1 to start a new chain from the current balances (anyone holding an old head hash will see the restart).`)
          setOff(`proof chain missing on disk (ledger expects epoch ${open.index}); restore it or restart the chain explicitly`)
          return
        }
        log('warn', `no proof chain on disk but ledger.json has an open epoch ${open.index}; LUSCA_PROOFS_RESTART is set: starting a new chain from the current balances`)
      }
      const t = now()
      const leaves = epochs.balances().map((b) => ({ key: b.key, credits: b.credits, jobs: b.jobs, flops: b.flops }))
      const rows = new Map<string, EpochRow>(leaves.map((b) => [b.key, { credits: b.credits, jobs: b.jobs, flops: b.flops }]))
      const g = buildEpoch(0, t, t, leavesFromRows(rows), null, epochs.ledgerCredits())
      try {
        persist(g)
      } catch (e) {
        log('error', `could not write the genesis epoch: ${(e as Error).message}; proofs are off`)
        setOff(`could not write the genesis epoch: ${(e as Error).message}`)
        return
      }
      adopt(g)
      epochs.start(1, t)
      log('info', `genesis epoch written: ${g.header.leafCount} accounts, ${(g.header.totals.credits / 1e6).toFixed(2)} credits committed, root ${g.header.treeRoot.slice(0, 16)}…`)
    } else if (!open) {
      epochs.start(h.index + 1, h.endedAt)
    } else if (open.index <= h.index) {
      log('warn', `ledger.json's open epoch ${open.index} is already closed on disk (head ${h.index}): its credits are committed; continuing at ${h.index + 1}`)
      epochs.start(h.index + 1, h.endedAt)
    } else if (open.index > h.index + 1) {
      log('error', `ledger.json's open epoch ${open.index} skips epochs after head ${h.index}; credits of the missing epochs are not in any proof. Continuing at ${h.index + 1}`)
      epochs.start(h.index + 1, h.endedAt)
    }
    ready = true
  }

  function tick(force = false): EpochHeader | null {
    if (!ready) return null
    if (!epochs.saving()) {
      if (!savingWarned) log('error', 'ledger.json is not being saved: no epoch closes until it is readable again (the open epoch keeps collecting)')
      savingWarned = true
      return null
    }
    if (savingWarned) {
      savingWarned = false
      log('info', 'ledger.json is being saved again: epochs close again')
    }
    if (pendingWrite && !flushPending()) return null
    const open = epochs.open()
    if (!open) return null
    const t = now()
    if (!force && t < closesAt(open.startedAt)) return null
    const prev = head()
    if (prev && open.index !== prev.index + 1) return null // guarded in init(); never fork
    if (epochs.busy?.()) {
      // an async ledger save is in flight; its older snapshot must not land after the close's save
      if (!retry) {
        retry = setTimeout(() => {
          retry = null
          tick(force)
        }, 250)
        retry.unref?.()
      }
      return null
    }
    const built: { rec: ClosingRecord | null } = { rec: null }
    let saved = false
    try {
      saved = epochs.close(t, (index, startedAt, rows) => {
        built.rec = buildEpoch(index, startedAt, t, leavesFromRows(rows), prev, epochs.ledgerCredits())
        return built.rec
      })
    } catch (e) {
      log('error', `epoch close failed: ${(e as Error).message}`)
      return null
    }
    const rec = built.rec
    if (!saved || !rec) {
      log('error', 'epoch close: ledger.json could not be saved; the epoch stays open and is retried')
      return null
    }
    pendingWrite = rec
    flushPending()
    return rec.header
  }

  function resolve(auth: unknown, device: unknown) {
    const out: { scope: 'wallet' | 'device'; key: string; wallet: string | null }[] = []
    if (typeof auth === 'string' && auth && auth.length <= 512 && opts.checkToken) {
      const w = opts.checkToken(auth)?.wallet
      if (w) out.push({ scope: 'wallet', key: `wallet:${w}`, wallet: w })
    }
    if (typeof device === 'string' && DEVICE_ID_RE.test(device)) out.push({ scope: 'device', key: `device:${device}`, wallet: null })
    return out
  }

  /** Tree order, every level and leaf positions of a closed epoch: built once, then cached. */
  function treeOf(index: number) {
    let t = treeCache.get(index)
    if (t) {
      treeCache.delete(index)
      treeCache.set(index, t)
      return t
    }
    const leaves = readLeaves(index)
    if (!leaves) return null
    const ordered = orderLeaves(index, leaves)
    t = { leaves: ordered.leaves, levels: treeLevels(ordered.hashes), pos: new Map(ordered.leaves.map((l, i) => [l.id, i])) }
    treeCache.set(index, t)
    while (treeCache.size > TREE_CACHE) treeCache.delete(treeCache.keys().next().value as number)
    return t
  }

  function proofFor(index: number, id: string, scope: 'wallet' | 'device'): ProofLookup | null {
    const h = headers[index]
    if (!h || h.index !== index) return null
    const t = treeOf(index)
    if (!t) return null
    const pos = t.pos.get(id)
    if (pos === undefined) return { header: h, scope, leaf: null, leafHash: null, position: null, path: [] }
    return { header: h, scope, leaf: t.leaves[pos], leafHash: bytesToHex(t.levels[0][pos]), position: pos, path: pathFromLevels(t.levels, pos) }
  }

  function leavesJson(index: number): { text: string; etag: string } | null {
    const h = headers[index]
    if (!h || h.index !== index) return null
    let hit = jsonCache.get(index)
    if (hit) return hit
    const leaves = readLeaves(index)
    if (!leaves) return null
    hit = { text: JSON.stringify({ index, treeRoot: h.treeRoot, leaves }), etag: `"${h.headerHash.slice(0, 32)}"` }
    jsonCache.set(index, hit)
    while (jsonCache.size > JSON_CACHE) jsonCache.delete(jsonCache.keys().next().value as number)
    return hit
  }

  return {
    page(limit, before) {
      const n = Math.min(100, Math.max(1, Math.floor(limit) || 20))
      const top = before === null ? headers.length : Math.max(0, Math.min(headers.length, before))
      const from = Math.max(0, top - n)
      const page = headers.slice(from, top).reverse()
      const open = epochs.open()
      return {
        head: head(),
        headers: page,
        next: from > 0 ? from : null,
        open: ready && open ? { index: open.index, startedAt: open.startedAt, closesAt: closesAt(open.startedAt) } : null,
        status,
        stalled: isStalled(),
        epochMinutes: epochMs / 60_000,
        committed: { epochs: headers.length, credits: committed.credits, leaves: committed.leaves },
      }
    },
    header: (index) => (headers[index]?.index === index ? headers[index] : null),
    leaves: (index) => (headers[index]?.index === index ? readLeaves(index) : null),
    leavesJson,
    resolve,
    mine(auth, device) {
      return resolve(auth, device).map((r) => {
        const id = identityFor(opts.salt, r.key)
        return { scope: r.scope, id, epochs: [...(identEpochs.get(id) ?? [])].reverse() }
      })
    },
    proof(index, auth, device) {
      if (headers[index]?.index !== index) return null
      const out: ProofLookup[] = []
      for (const r of resolve(auth, device)) {
        const p = proofFor(index, identityFor(opts.salt, r.key), r.scope)
        if (p) out.push(p)
      }
      return out
    },
    status: () => ({ ...status, head: head()?.index ?? null, pendingWrite: pendingWrite !== null, stalled: isStalled() }),
    tick,
    start() {
      init()
      tick()
      timer = setInterval(() => tick(), TICK_MS)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      if (retry) clearTimeout(retry)
      timer = null
      retry = null
    },
  }
}
