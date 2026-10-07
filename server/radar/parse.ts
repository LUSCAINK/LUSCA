// Pure parts of the upgrade radar: loader log lines (Solana), proxy event logs (EVM), the headline
// and the display priority. No I/O here (tests: server/radar/_test.ts).

import type { RadarDiff, RadarEvent, RadarKind, RadarSide, RadarVerified } from '../../shared/radar.ts'
import { isSolanaAddress } from '../../shared/base58.ts'

export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
export const LOADER_V4 = 'LoaderV411111111111111111111111111111111111'

// ─── Solana: loader log lines ───────────────────────────────────────────────
//
// The upgradeable loader is a builtin: its messages are raw log lines ("Upgraded program <id>"),
// while a program's own msg! output is always prefixed "Program log: ". A line only counts when the
// loader is the program executing at that point of the invoke stack, so no program can fake one.

export type LoaderActionType = 'deployed' | 'upgraded' | 'authority' | 'closed' | 'migrated'

export interface LoaderAction {
  type: LoaderActionType
  loader: 'v3' | 'v4'
  /** Program id (deployed / upgraded / closed program / migrated). */
  program: string | null
  /** 'authority': the new authority (null = set to none: made immutable). */
  newAuthority?: string | null
  /** 'closed': what was closed. */
  closed?: 'program' | 'buffer' | 'uninitialized'
}

const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/
const END_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed.*)$/
const B58 = '([1-9A-HJ-NP-Za-km-z]{32,44})'
const DEPLOYED_RE = new RegExp(`^Deployed program ${B58}$`)
const UPGRADED_RE = new RegExp(`^Upgraded program ${B58}$`)
const MIGRATED_RE = new RegExp(`^Migrated program ${B58}$`)
const AUTH_RE = new RegExp(`^New authority (?:Some\\(${B58}\\)|${B58}|(None))$`)
const CLOSED_RE = new RegExp(`^Closed (Program|Buffer|Uninitialized) ${B58}$`)

/** Loader actions in a transaction's log lines (successful transactions only: the caller checks err). */
export function parseLoaderLogs(logs: readonly unknown[]): LoaderAction[] {
  const out: LoaderAction[] = []
  const stack: string[] = []
  for (const raw of logs) {
    if (typeof raw !== 'string') continue
    const line = raw.trim()
    const inv = INVOKE_RE.exec(line)
    if (inv) {
      stack.push(inv[1])
      continue
    }
    const end = END_RE.exec(line)
    if (end) {
      // pop back to the program that ended (a truncated log may have lost lines)
      const i = stack.lastIndexOf(end[1])
      if (i >= 0) stack.length = i
      continue
    }
    const top = stack[stack.length - 1]
    if (top !== UPGRADEABLE_LOADER && top !== LOADER_V4) continue
    const loader = top === LOADER_V4 ? 'v4' : 'v3'
    let m: RegExpExecArray | null
    if ((m = UPGRADED_RE.exec(line)) && isSolanaAddress(m[1])) out.push({ type: 'upgraded', loader, program: m[1] })
    else if ((m = DEPLOYED_RE.exec(line)) && isSolanaAddress(m[1])) out.push({ type: 'deployed', loader, program: m[1] })
    else if ((m = MIGRATED_RE.exec(line)) && isSolanaAddress(m[1])) out.push({ type: 'migrated', loader, program: m[1] })
    else if ((m = AUTH_RE.exec(line))) {
      const a = m[1] ?? m[2] ?? null
      if (a === null && !m[3]) continue
      if (a !== null && !isSolanaAddress(a)) continue
      out.push({ type: 'authority', loader, program: null, newAuthority: a })
    } else if ((m = CLOSED_RE.exec(line)) && isSolanaAddress(m[2])) {
      const what = m[1].toLowerCase() as 'program' | 'buffer' | 'uninitialized'
      out.push({ type: 'closed', loader, program: what === 'program' ? m[2] : null, closed: what })
    }
  }
  return out
}

/** Interesting actions only: buffer / uninitialized closes are deploy plumbing, not a code change. */
export function interestingActions(actions: LoaderAction[]): LoaderAction[] {
  return actions.filter((a) => a.type !== 'closed' || a.closed === 'program')
}

export interface SigInfo {
  signature: string
  slot: number
  err: unknown
  blockTime?: number | null
}

/**
 * Loader signatures worth a getTransaction: a deploy writes its buffer in hundreds of transactions
 * packed into a few slots; the deploy / upgrade / authority transaction itself usually lands alone in
 * its slot. Failed transactions are skipped. Newest first, as given.
 */
export function loaderCandidates(sigs: readonly SigInfo[]): SigInfo[] {
  const perSlot = new Map<number, number>()
  for (const s of sigs) perSlot.set(s.slot, (perSlot.get(s.slot) ?? 0) + 1)
  return sigs.filter((s) => !s.err && perSlot.get(s.slot) === 1)
}

/** The writable account of a SetAuthority / SetAuthorityChecked instruction of the upgradeable loader, from a getTransaction (json) result. */
export function setAuthorityTargets(tx: unknown): string[] {
  const t = tx as { transaction?: { message?: { accountKeys?: unknown[]; instructions?: unknown[] } }; meta?: { loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] }; innerInstructions?: { instructions?: unknown[] }[] } } | null
  const msg = t?.transaction?.message
  if (!msg || !Array.isArray(msg.accountKeys)) return []
  const keys = [
    ...msg.accountKeys.map((k) => (typeof k === 'string' ? k : (k as { pubkey?: unknown })?.pubkey)),
    ...(t?.meta?.loadedAddresses?.writable ?? []),
    ...(t?.meta?.loadedAddresses?.readonly ?? []),
  ].map((k) => (typeof k === 'string' ? k : ''))
  const loaderIx = keys.indexOf(UPGRADEABLE_LOADER)
  if (loaderIx < 0) return []
  const all: unknown[] = [...(msg.instructions ?? []), ...(t?.meta?.innerInstructions ?? []).flatMap((x) => x?.instructions ?? [])]
  const out: string[] = []
  for (const ix of all) {
    const i = ix as { programIdIndex?: unknown; accounts?: unknown; data?: unknown }
    if (i?.programIdIndex !== loaderIx || !Array.isArray(i.accounts) || typeof i.data !== 'string') continue
    const tag = instructionTag(i.data)
    // 4 = SetAuthority, 7 = SetAuthorityChecked (UpgradeableLoaderInstruction, bincode u32 LE)
    if (tag !== 4 && tag !== 7) continue
    const k = keys[Number(i.accounts[0])]
    if (k && isSolanaAddress(k) && !out.includes(k)) out.push(k)
  }
  return out
}

/** Fee payer and other signers of a getTransaction (json) result. */
export function txSigners(tx: unknown): string[] {
  const t = tx as { transaction?: { message?: { accountKeys?: unknown[]; header?: { numRequiredSignatures?: unknown } } } } | null
  const msg = t?.transaction?.message
  if (!msg || !Array.isArray(msg.accountKeys)) return []
  const n = Number(msg.header?.numRequiredSignatures)
  const keys = msg.accountKeys.map((k) => (typeof k === 'string' ? k : (k as { pubkey?: unknown })?.pubkey)).filter((k): k is string => typeof k === 'string')
  return keys.slice(0, Number.isInteger(n) && n > 0 ? n : 1)
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** First little-endian u32 of base58 instruction data, or null. */
function instructionTag(data: string): number | null {
  if (!data || data.length > 2000) return null
  let n = 0n
  for (const c of data) {
    const v = B58_ALPHABET.indexOf(c)
    if (v < 0) return null
    n = n * 58n + BigInt(v)
  }
  const bytes: number[] = []
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  for (const c of data) {
    if (c !== '1') break
    bytes.unshift(0)
  }
  if (bytes.length < 4) return null
  return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
}

// ─── EVM: proxy event logs ──────────────────────────────────────────────────

export const TOPIC_UPGRADED = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b'
export const TOPIC_ADMIN_CHANGED = '0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f'
export const TOPIC_BEACON_UPGRADED = '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e'
export const RADAR_TOPICS = [TOPIC_UPGRADED, TOPIC_ADMIN_CHANGED, TOPIC_BEACON_UPGRADED]

export interface ProxyLog {
  type: 'upgraded' | 'admin' | 'beacon'
  address: string
  tx: string
  block: number
  logIndex: number
  /** Upgraded: the new implementation. */
  implementation?: string
  /** BeaconUpgraded: the new beacon. */
  beacon?: string
  /** AdminChanged: previous (null = none) and new admin. */
  previousAdmin?: string | null
  newAdmin?: string | null
}

const HEX_RE = /^0x[0-9a-fA-F]*$/
const hexNum = (v: unknown): number | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(v) ? parseInt(v, 16) : null)

/** 32-byte word → lowercase address; null for zero / not an address. */
export function wordAddress(w: unknown): string | null {
  if (typeof w !== 'string' || !HEX_RE.test(w)) return null
  const h = w.slice(2).toLowerCase()
  if (h.length > 64) return null
  const p = h.padStart(64, '0')
  if (!/^0{24}/.test(p)) return null
  const a = p.slice(24)
  return /^0+$/.test(a) ? null : `0x${a}`
}

/** One eth_getLogs entry → ProxyLog, or null (removed, malformed, wrong topic layout). */
export function parseProxyLog(raw: unknown): ProxyLog | null {
  const l = raw as { address?: unknown; topics?: unknown; data?: unknown; transactionHash?: unknown; blockNumber?: unknown; logIndex?: unknown; removed?: unknown } | null
  if (!l || typeof l !== 'object' || l.removed === true) return null
  if (typeof l.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(l.address)) return null
  if (!Array.isArray(l.topics) || typeof l.topics[0] !== 'string') return null
  const tx = typeof l.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(l.transactionHash) ? l.transactionHash.toLowerCase() : null
  const block = hexNum(l.blockNumber)
  const logIndex = hexNum(l.logIndex) ?? 0
  if (!tx || block === null) return null
  const address = l.address.toLowerCase()
  const t0 = l.topics[0].toLowerCase()
  const data = typeof l.data === 'string' && HEX_RE.test(l.data) ? l.data.slice(2) : ''
  const base = { address, tx, block, logIndex }
  if (t0 === TOPIC_UPGRADED) {
    // Upgraded(address indexed implementation)
    const impl = l.topics.length >= 2 ? wordAddress(l.topics[1]) : data.length >= 64 ? wordAddress(`0x${data.slice(0, 64)}`) : null
    return impl ? { type: 'upgraded', ...base, implementation: impl } : null
  }
  if (t0 === TOPIC_BEACON_UPGRADED) {
    const beacon = l.topics.length >= 2 ? wordAddress(l.topics[1]) : data.length >= 64 ? wordAddress(`0x${data.slice(0, 64)}`) : null
    return beacon ? { type: 'beacon', ...base, beacon } : null
  }
  if (t0 === TOPIC_ADMIN_CHANGED) {
    // AdminChanged(address previousAdmin, address newAdmin): both in data (some forks index them)
    let prev: unknown
    let next: unknown
    if (l.topics.length >= 3) {
      prev = l.topics[1]
      next = l.topics[2]
    } else if (data.length >= 128) {
      prev = `0x${data.slice(0, 64)}`
      next = `0x${data.slice(64, 128)}`
    } else return null
    if (typeof prev !== 'string' || typeof next !== 'string' || !HEX_RE.test(prev) || !HEX_RE.test(next)) return null
    return { type: 'admin', ...base, previousAdmin: wordAddress(prev), newAdmin: wordAddress(next) }
  }
  return null
}

export interface ProxyTxGroup {
  key: string
  address: string
  tx: string
  block: number
  logs: ProxyLog[]
}

/** Logs grouped per (transaction, emitting address), in block / log order. */
export function groupProxyLogs(logs: ProxyLog[]): ProxyTxGroup[] {
  const m = new Map<string, ProxyTxGroup>()
  for (const l of [...logs].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
    const key = `${l.tx}:${l.address}`
    let g = m.get(key)
    if (!g) m.set(key, (g = { key, address: l.address, tx: l.tx, block: l.block, logs: [] }))
    g.logs.push(l)
  }
  return [...m.values()]
}

/** What a group shows without any further call: the last implementation / beacon / admin it set, and whether the admin was set from none. */
export function groupFacts(g: ProxyTxGroup) {
  let implementation: string | null = null
  let beacon: string | null = null
  const adm: { v: { previous: string | null; next: string | null } | null } = { v: null }
  for (const l of g.logs) {
    if (l.type === 'upgraded' && l.implementation) implementation = l.implementation
    else if (l.type === 'beacon' && l.beacon) beacon = l.beacon
    // the first change's previous admin and the last change's new admin
    else if (l.type === 'admin') adm.v = { previous: adm.v ? adm.v.previous : (l.previousAdmin ?? null), next: l.newAdmin ?? null }
  }
  const admin = adm.v
  /** AdminChanged from none in the same transaction: the proxy was initialized here (a deployment). */
  const adminFromNone = admin !== null && admin.previous === null
  return { implementation, beacon, admin, adminFromNone }
}

/**
 * Kind of an EVM group. `existedBefore`: whether the address had code in the block before (null = not
 * checked). A proxy that had no code before was deployed in this transaction.
 */
export function classifyProxyGroup(g: ProxyTxGroup, existedBefore: boolean | null): RadarKind {
  const f = groupFacts(g)
  if (existedBefore === false || (existedBefore === null && f.adminFromNone && (f.implementation || f.beacon))) return 'deploy'
  if (f.implementation) return 'upgrade'
  if (f.beacon) return 'beacon_upgrade'
  return 'admin_change'
}

// ─── headline + priority ────────────────────────────────────────────────────

const KIND_WORD: Record<RadarKind, string> = {
  deploy: 'Deployed',
  upgrade: 'Upgraded',
  admin_change: 'Admin changed',
  beacon_upgrade: 'Beacon changed',
  authority_change: 'Authority changed',
  close: 'Closed',
}

export const shortAddr = (a: string | null | undefined): string => (!a ? 'none' : a.length > 14 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a)

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export function verifiedWord(v: RadarVerified | undefined | null): string {
  switch (v) {
    case 'osec':
      return 'OtterSec'
    case 'sourcify-full':
      return 'Sourcify full'
    case 'sourcify-partial':
      return 'Sourcify partial'
    case 'none':
      return 'no'
    default:
      return 'unknown'
  }
}

/** "Upgraded · 2 instructions added · authority unchanged · verified: no" */
export function headlineOf(e: Pick<RadarEvent, 'kind' | 'chain' | 'count' | 'proxies' | 'before' | 'after' | 'diff' | 'state'>): string {
  const parts: string[] = [KIND_WORD[e.kind]]
  const d = e.diff
  const a = e.after
  const b = e.before
  const proxies = (n: number) => `${n} ${n === 1 ? 'proxy' : 'proxies'}`
  if (e.kind === 'deploy' && e.proxies && e.proxies.n > 1) parts[0] = `Deployed · ${proxies(e.proxies.n)}`
  // Upgraded / BeaconUpgraded events whose proxies could not be checked (deployment or upgrade): said as such
  const unchecked = !!e.proxies && e.kind !== 'deploy'
  if (unchecked) parts[0] = `${e.kind === 'beacon_upgrade' ? 'BeaconUpgraded' : 'Upgraded'} event · ${proxies(e.proxies!.n)}`
  if (e.count > 1 && e.kind !== 'deploy' && !unchecked) parts.push(`${e.count}×`)
  if (e.kind === 'admin_change') {
    parts.push(`${shortAddr(b?.authority)} → ${shortAddr(a?.authority)}`)
    return parts.join(' · ')
  }
  if (e.kind === 'authority_change') {
    parts.push(a?.authority ? `→ ${shortAddr(a.authority)}` : a && a.upgradeable === false ? 'now immutable' : 'new authority')
    return parts.join(' · ')
  }
  if (e.kind === 'close') {
    parts.push('program data removed')
    return parts.join(' · ')
  }
  if ((e.kind === 'beacon_upgrade' || (e.kind === 'deploy' && !a?.implementation)) && a?.beacon) parts.push(`beacon ${shortAddr(a.beacon)}`)
  if (e.chain !== 'solana' && (e.kind === 'upgrade' || e.kind === 'deploy') && a?.implementation) parts.push(`→ ${shortAddr(a.implementation)}`)
  if (d) {
    const unit = d.surface === 'functions' ? 'function' : 'instruction'
    const add = d.added ? d.added.items.length + d.added.more : 0
    const rem = d.removed ? d.removed.items.length + d.removed.more : 0
    if (add) parts.push(`${plural(add, unit)} added`)
    if (rem) parts.push(`${plural(rem, unit)} removed`)
    if (d.guardsAdded?.length) parts.push(`${plural(d.guardsAdded.length, 'new admin-only function')}`)
    if (d.primitivesAdded?.length) parts.push(`primitives + ${d.primitivesAdded.join(', ')}`)
    if (!add && !rem && d.added && d.removed) parts.push(`same ${unit}s`)
    if (d.code === 'same' && e.kind === 'upgrade') parts.push('same code hash')
    // a program without an IDL to compare: the code itself is the fact (and how its size moved)
    if (d.code === 'changed' && e.chain === 'solana' && !add && !rem) {
      const delta = a?.bytes != null && b?.bytes != null ? a.bytes - b.bytes : 0
      parts.push(`code hash changed${delta ? ` (${delta > 0 ? '+' : '−'}${Math.abs(delta).toLocaleString('en-US')} bytes)` : ''}`)
    }
    if (e.chain === 'solana' && e.kind === 'upgrade') {
      if (!b) parts.push('no earlier state')
      else parts.push(d.authority === 'same' ? 'authority unchanged' : d.authority === 'changed' ? 'authority changed' : 'authority before unknown')
    }
  } else if (unchecked) {
    parts.push('not checked: deployment or upgrade')
  } else if (e.kind === 'upgrade' && e.chain !== 'solana' && b?.implementation === undefined) {
    parts.push('previous implementation not read')
  }
  if (a && e.state !== 'pending' && a.from !== 'event') parts.push(`verified: ${verifiedWord(a.verified)}`)
  if (e.state === 'pending') parts.push('reading…')
  return parts.join(' · ')
}

const KIND_BASE: Record<RadarKind, number> = { upgrade: 50, beacon_upgrade: 44, authority_change: 40, admin_change: 34, close: 30, deploy: 12 }

/** Significance for display: known protocols and larger diffs first; test deploys and repeated redeploys lower. */
export function priorityOf(e: Pick<RadarEvent, 'kind' | 'known' | 'count' | 'proxies' | 'after' | 'before' | 'diff' | 'chain'>): number {
  let p = KIND_BASE[e.kind]
  if (e.known) p += 40
  const d = e.diff
  if (d) {
    const n = (d.added ? d.added.items.length + d.added.more : 0) + (d.removed ? d.removed.items.length + d.removed.more : 0)
    p += Math.min(20, n * 2)
    p += Math.min(15, (d.guardsAdded?.length ?? 0) * 5)
    p += Math.min(6, ((d.primitivesAdded?.length ?? 0) + (d.primitivesRemoved?.length ?? 0)) * 2)
    if (d.code === 'changed') p += 4
    if (d.authority === 'changed') p += 8
  }
  const a = e.after
  if (a && (a.verified === 'osec' || a.verified === 'sourcify-full' || a.verified === 'sourcify-partial')) p += 6
  if (a && a.surfaceCount) p += 3
  // nothing published to read (no IDL, no verified source): a test deploy reads like this
  if (a && !a.surfaceCount && (a.verified === 'none' || a.verified === 'unknown') && !e.known) p -= 10
  if (e.count > 3) p -= 6
  if (e.proxies && e.proxies.n > 3) p -= 4
  if (e.kind === 'upgrade' && e.chain !== 'solana' && !e.before) p -= 12
  return Math.max(0, Math.min(100, Math.round(p)))
}

/** The display-ready side of a verified field. */
export function verifiedOf(v: { by: 'osec' | 'sourcify'; match: 'full' | 'partial' | null } | null, asked: boolean): RadarVerified {
  if (!v) return asked ? 'none' : 'unknown'
  if (v.by === 'osec') return 'osec'
  return v.match === 'partial' ? 'sourcify-partial' : 'sourcify-full'
}

/** Empty diff shell. */
export function emptyDiff(): RadarDiff {
  return { code: 'unknown', authority: 'unknown', verified: 'unknown', surface: null, added: null, removed: null, guardsAdded: null, guardsRemoved: null, primitivesAdded: null, primitivesRemoved: null }
}

export type { RadarSide }
