// What one chain-agent read did, for the public /scan page: the calls it made (method, what it asked
// for, who answered, when, how long, a short result) and the fields it decoded. Recorded around the
// RpcCtx the agent already hands its reader: no extra call, no extra budget. Nothing here carries a
// URL or a key (provider names come from rpc.ts provider(); every string goes through redact()).
//
//   createTraceRecorder(ctx, provider) → { ctx (pass to the reader), calls(), more() }
//   scanDocOf(read, extras)            → ScanDoc (capped lists)
//   capScan(event)                     → the event with trace + scan trimmed under SCAN_EVENT_MAX_BYTES

import type { ChainEvent, ChainId, ChainRead, ScanCall, ScanDoc } from '../../shared/chain.ts'
import { RpcError, isBudgetError, redact, type BudgetKey, type RpcCtx } from './rpc.ts'

/** Calls kept per read (a Solana read makes 1–3, an EVM read ≤ 6 RPC + ≤ 2 registry). */
export const TRACE_MAX = 24
/** Serialized size an event with its trace and decoded fields stays under. */
export const SCAN_EVENT_MAX_BYTES = 8 * 1024

const SHORT = 64

const clip = (s: string, n = SHORT) => {
  const r = redact(String(s ?? ''))
  return r.length > n ? `${r.slice(0, n - 1)}…` : r
}

const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US')
const shortHex = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

/** Storage slots the EVM reader asks for, by name (server/chain/evm.ts PROXY_SLOTS). */
const SLOT_NAMES: Record<string, string> = {
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc': 'eip1967.proxy.implementation',
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50': 'eip1967.proxy.beacon',
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103': 'eip1967.proxy.admin',
  '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7': 'PROXIABLE (EIP-1822)',
  '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3': 'org.zeppelinos.proxy.implementation',
  '0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b': 'org.zeppelinos.proxy.admin',
  '0x0': 'slot 0 (Safe singleton)',
}

/** 32-byte word → address, or null (same rule as evm.ts wordToAddress). */
function wordAddr(v: unknown): string | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) return null
  const w = v.slice(2).toLowerCase().padStart(64, '0')
  if (w.length > 64 || !/^0{24}/.test(w)) return null
  const a = w.slice(24)
  return /^0+$/.test(a) ? null : `0x${a}`
}

/** What a call asked for, in words. */
export function targetOf(method: string, params: unknown[], self?: string): string {
  if (method === 'getMultipleAccounts') {
    const keys = Array.isArray(params[0]) ? params[0].length : 0
    return keys >= 4 ? 'program · programdata · IDL accounts' : keys === 1 ? 'programdata' : `${keys} accounts`
  }
  if (method === 'getAccountInfo') return 'account'
  if (method === 'eth_getCode') return 'runtime bytecode'
  if (method === 'eth_getStorageAt') {
    const slot = typeof params[1] === 'string' ? params[1].toLowerCase() : ''
    return SLOT_NAMES[slot] ?? `storage slot ${shortHex(slot)}`
  }
  if (method === 'eth_call') {
    const p = (params[0] ?? {}) as { to?: unknown; data?: unknown }
    const fn = p.data === '0x5c60da1b' ? 'implementation()' : 'call'
    const to = typeof p.to === 'string' ? p.to.toLowerCase() : ''
    return to && self && to !== self.toLowerCase() ? `${fn} on beacon ${shortHex(to)}` : fn
  }
  return clip(method, 40)
}

/** A short result of an RPC call. */
export function rpcResultOf(method: string, res: unknown): string {
  if (method === 'getMultipleAccounts' || method === 'getAccountInfo') {
    const v = res && typeof res === 'object' ? (res as { value?: unknown }).value : null
    const list = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]
    const total = Array.isArray(v) ? v.length : 1
    let found = 0
    let bytes = 0
    let known = true
    for (const a of list) {
      if (!a || typeof a !== 'object') continue
      found++
      const acc = a as { space?: unknown; data?: unknown }
      if (typeof acc.space === 'number' && Number.isFinite(acc.space)) bytes += acc.space
      else if (Array.isArray(acc.data) && typeof acc.data[0] === 'string' && acc.data[1] === 'base64') bytes += Math.floor((acc.data[0].length * 3) / 4)
      else known = false
    }
    const acc = `${found} of ${total} account${total === 1 ? '' : 's'}`
    return known && bytes > 0 ? `${acc} · ${fmtInt(bytes)} bytes` : acc
  }
  if (method === 'eth_getCode') {
    if (typeof res !== 'string' || !/^0x[0-9a-fA-F]*$/.test(res)) return 'malformed'
    const n = Math.floor((res.length - 2) / 2)
    return n > 0 ? `${fmtInt(n)} bytes` : 'no code'
  }
  if (method === 'eth_getStorageAt' || method === 'eth_call') {
    const a = wordAddr(res)
    return a ? `→ ${shortHex(a)}` : 'empty'
  }
  return 'ok'
}

/** A short result of a registry answer. */
function registryResultOf(host: 'sourcify' | 'osec', j: unknown): string {
  const o = j && typeof j === 'object' ? (j as Record<string, unknown>) : {}
  if (host === 'sourcify') return o.match === 'exact_match' ? 'full match' : o.match === 'match' ? 'partial match' : 'no match'
  if (o.is_verified === true) return 'verified build'
  return typeof o.repo_url === 'string' && o.repo_url ? 'build record, not verified' : 'not verified'
}

function failureOf(e: unknown): string {
  if (isBudgetError(e)) return 'daily budget used up'
  if (e instanceof RpcError) {
    if (e.kind === 'http') return e.status === 429 ? 'rate limited' : `HTTP ${e.status ?? '?'}`
    if (e.kind === 'rpc') return `rpc error${e.code !== null ? ` ${e.code}` : ''}`
    return e.kind
  }
  return 'failed'
}

const registryOf = (url: string, explicit?: 'sourcify' | 'osec'): 'sourcify' | 'osec' | null =>
  explicit ?? (/^https?:\/\/([^/]+\.)?sourcify\.dev\b/i.test(url) ? 'sourcify' : /^https?:\/\/([^/]+\.)?osec\.io\b/i.test(url) ? 'osec' : null)

export interface TraceRecorder {
  /** The context to hand the reader: the same calls, recorded. */
  ctx: RpcCtx
  /** Recorded calls, in start order (≤ TRACE_MAX). */
  calls(): ScanCall[]
  /** Calls over the cap, not recorded. */
  more(): number
}

/**
 * Record every call made through `inner`. `provider(key)` names who answers a budget key (rpc.ts
 * provider()); `address` is the address being read (to tell a beacon call from a self call).
 */
export function createTraceRecorder(
  inner: RpcCtx,
  o: { provider?: (key: BudgetKey) => string; address?: string; clock?: () => number } = {},
): TraceRecorder {
  const clock = o.clock ?? (() => performance.now())
  const providerOf = (k: BudgetKey, def: string) => {
    try {
      return clip(o.provider?.(k) ?? def, 32)
    } catch {
      return def
    }
  }
  const list: ScanCall[] = []
  let t0: number | null = null
  let dropped = 0

  interface Open {
    at: number
    /** When the request actually went out (rpc.ts onStart), after LUSCA's own pacing wait. */
    sent: number | null
    entry: ScanCall | null
  }
  const begin = (c: Omit<ScanCall, 't' | 'ms' | 'ok' | 'result'>): Open => {
    const at = clock()
    if (t0 === null) t0 = at
    if (list.length >= TRACE_MAX) {
      dropped++
      return { at, sent: null, entry: null }
    }
    const entry: ScanCall = { ...c, t: Math.max(0, Math.round(at - t0)), ms: 0, ok: false, result: '' }
    list.push(entry)
    return { at, sent: null, entry }
  }
  const end = (b: Open, ok: boolean, result: string) => {
    if (!b.entry) return
    const t = clock()
    // the provider's time is the request alone; the wait for its turn is LUSCA's pacing, kept apart
    const from = b.sent !== null && b.sent >= b.at ? b.sent : b.at
    b.entry.ms = Math.max(0, Math.round(t - from))
    const wait = Math.round(from - b.at)
    if (wait > 0) b.entry.wait = wait
    b.entry.ok = ok
    b.entry.result = clip(result, 48)
  }
  /** The caller's options plus the hook rpc.ts calls when the request goes out. */
  const withStart = <T extends { onStart?: () => void }>(b: Open, opts: T | undefined): T => {
    const prev = opts?.onStart
    return {
      ...(opts ?? ({} as T)),
      onStart: () => {
        b.sent = clock()
        prev?.()
      },
    }
  }

  const ctx: RpcCtx = {
    async call(chain: ChainId, method, params, opts) {
      const key: BudgetKey = chain === 'solana' ? (opts?.discovery ? 'solana-discovery' : 'solana') : chain
      const b = begin({ kind: 'rpc', method: clip(method, 32), target: clip(targetOf(method, params, o.address)), provider: providerOf(key, 'RPC') })
      try {
        const r = await inner.call(chain, method, params, withStart(b, opts))
        end(b, true, rpcResultOf(method, r))
        return r
      } catch (e) {
        end(b, false, failureOf(e))
        throw e
      }
    },
    async fetchJson(url, opts) {
      const host = registryOf(url, opts?.host)
      const lean = host === 'sourcify' && /fields=/.test(url) && !/sources/.test(url.split('fields=')[1] ?? '')
      const b = begin({
        kind: 'registry',
        method: host === 'sourcify' ? 'Sourcify' : host === 'osec' ? 'OtterSec' : 'registry',
        target: host === 'sourcify' ? (lean ? 'ABI + compilation (lean)' : 'verified source + ABI') : host === 'osec' ? 'verified-build status' : 'lookup',
        provider: host ? providerOf(host, host === 'sourcify' ? 'Sourcify' : 'OtterSec') : 'registry',
      })
      try {
        const r = await inner.fetchJson(url, withStart(b, opts))
        end(b, true, host ? registryResultOf(host, r) : 'ok')
        return r
      } catch (e) {
        // a registry 404 is an answer: nothing on record for this address
        if (e instanceof RpcError && e.kind === 'http' && e.status === 404) end(b, true, host === 'sourcify' ? 'no match' : 'no record')
        else end(b, false, failureOf(e))
        throw e
      }
    },
    usage: () => inner.usage(),
    canSpend: (chain, n, discovery) => inner.canSpend(chain, n, discovery),
  }
  return { ctx, calls: () => list.map((c) => ({ ...c })), more: () => dropped }
}

// ─── decoded fields ─────────────────────────────────────────────────────────

export interface ScanExtras {
  /** Verified source paths (EVM: the files of the verified compilation). */
  sourcePaths?: string[]
  /** Privileged functions found in the verified source (server/lens/evm-analysis.ts findPrivileged). */
  privileged?: { fn: string; guard: string; file: string; line: number }[]
  /** Primitive names (ELF syscalls / source). */
  primitives?: string[]
}

const NOTE_RE = /^(immutable|OtterSec verified build|legacy loader|loader-v4|built-in program|EIP-7702|EIP-1167|Gnosis Safe proxy|deployed in block|boilerplate:|custom code|program closed|Arbitrum Stylus)/i
const LIST = 12

const fnName = (sig: string) => {
  const i = sig.indexOf('(')
  return i > 0 ? sig.slice(0, i) : sig
}
const baseName = (p: string) => p.split('/').pop() || p

/** The decoded fields of one read for the /scan page; absent when unknown. Lists are capped. */
export function scanDocOf(read: ChainRead, x: ScanExtras = {}): ScanDoc {
  const d: ScanDoc = {}
  if (read.loader) d.loader = clip(read.loader, 48)
  if (read.upgradeable !== null) d.upgradeable = read.upgradeable
  if (read.upgradeAuthority && read.chain === 'solana') d.authority = clip(read.upgradeAuthority, 48)
  if (read.lastDeploySlot !== null) d.deploySlot = read.lastDeploySlot
  if (read.programBytes !== null) d.programBytes = read.programBytes
  if (read.codeHash) d.codeHash = read.codeHash.slice(0, 64)
  if (read.bytecodeBytes !== null) d.bytecodeBytes = read.bytecodeBytes
  if (read.chain !== 'solana' && read.codeHash) {
    // server/chain/evm.ts notes either "metadata trailer (…) excluded from codeHash" or "no metadata trailer"
    if (read.notes.some((n) => /metadata trailer \(.*\) excluded/i.test(n))) d.trailer = true
    else if (read.notes.some((n) => /no metadata trailer/i.test(n))) d.trailer = false
  }
  const st = read.securityTxt
  if (st) {
    const name = typeof st.name === 'string' ? clip(st.name, 48) : ''
    const url = typeof st.project_url === 'string' && /^https?:\/\/[^\s]{3,200}$/i.test(st.project_url) ? st.project_url.slice(0, 120) : ''
    if (name || url) d.project = { ...(name ? { name } : {}), ...(url ? { url } : {}) }
  }
  if (read.proxy) {
    d.proxy = { standard: read.proxy.standard, implementation: read.proxy.implementation.slice(0, 48) }
    if (read.chain !== 'solana' && read.upgradeAuthority) d.proxy.admin = read.upgradeAuthority.slice(0, 48)
  }
  if (read.verified) {
    const v = read.verified
    d.verified = { by: v.by }
    if (v.match) d.verified.match = v.match
    if (v.compiler) d.verified.compiler = clip(v.compiler, 48)
    if (v.repo && /^https?:\/\//i.test(v.repo)) d.verified.repo = v.repo.slice(0, 120)
    if (v.commit) d.verified.commit = v.commit.slice(0, 12)
  }
  const paths = x.sourcePaths ?? read.sources.map((s) => s.path)
  if (paths.length) d.files = { paths: paths.slice(0, LIST).map((p) => clip(p, 96)), more: Math.max(0, paths.length - LIST) }
  if (read.idl) {
    const names = read.idl.instructions.map((i) => clip(i.name, 40))
    const src = read.notes.find((n) => n.startsWith('IDL from the '))
    d.idl = {
      ...(src ? { source: clip(src.replace(/^IDL from the /, ''), 48) } : {}),
      names: names.slice(0, LIST * 2),
      more: Math.max(0, names.length - LIST * 2),
      accounts: read.idl.accounts.length,
      errors: read.idl.errors,
      events: read.idl.events,
    }
  }
  if (read.abi && (read.abi.functions.length || read.abi.events.length)) {
    const names = [...new Set(read.abi.functions.map(fnName))].map((n) => clip(n, 40))
    d.abi = { names: names.slice(0, LIST * 2), more: Math.max(0, names.length - LIST * 2), events: read.abi.events.length }
  }
  if (x.privileged?.length) {
    d.privileged = {
      items: x.privileged.slice(0, 8).map((p) => ({ fn: clip(p.fn, 64), guard: clip(p.guard, 64), at: clip(`${baseName(p.file)}:${p.line}`, 64) })),
      more: Math.max(0, x.privileged.length - 8),
    }
  }
  if (x.primitives?.length) d.primitives = [...new Set(x.primitives.map((p) => clip(p, 40)))].slice(0, 8)
  const notes = read.notes.filter((n) => NOTE_RE.test(n)).slice(0, 4).map((n) => clip(n, 120))
  if (notes.length) d.notes = notes
  return d
}

// ─── size cap ───────────────────────────────────────────────────────────────

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8')

/**
 * The event with its trace and decoded fields trimmed until it serializes under `max` bytes: long
 * lists shrink first (the cut is counted in `more`), then notes, then the trace's tail.
 */
export function capScan(ev: ChainEvent, max = SCAN_EVENT_MAX_BYTES): ChainEvent {
  if (size(ev) <= max) return ev
  const out: ChainEvent = { ...ev, trace: ev.trace?.map((c) => ({ ...c })), scan: ev.scan ? structuredClone(ev.scan) : undefined }
  const s = out.scan
  for (const keep of [12, 8, 4, 2, 0]) {
    if (!s || size(out) <= max) break
    if (s.idl && s.idl.names.length > keep) {
      s.idl.more += s.idl.names.length - keep
      s.idl.names = s.idl.names.slice(0, keep)
    }
    if (s.abi && s.abi.names.length > keep) {
      s.abi.more += s.abi.names.length - keep
      s.abi.names = s.abi.names.slice(0, keep)
    }
    const files = Math.max(1, keep)
    if (s.files && s.files.paths.length > files) {
      s.files.more += s.files.paths.length - files
      s.files.paths = s.files.paths.slice(0, files)
    }
    const priv = Math.max(1, Math.min(keep, 6))
    if (s.privileged && s.privileged.items.length > priv) {
      s.privileged.more += s.privileged.items.length - priv
      s.privileged.items = s.privileged.items.slice(0, priv)
    }
    if (s.primitives && s.primitives.length > Math.max(2, keep)) s.primitives = s.primitives.slice(0, Math.max(2, keep))
    if (keep <= 4) delete s.notes
  }
  while (out.trace && out.trace.length > 4 && size(out) > max) {
    out.trace.pop()
    if (out.scan) out.scan.traceMore = (out.scan.traceMore ?? 0) + 1
    else out.scan = { traceMore: 1 }
  }
  if (size(out) > max) {
    // pathological strings: keep the event, drop the extras
    delete out.scan
    delete out.trace
  }
  return out
}
