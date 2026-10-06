// EVM reader of the chain agents (Ethereum, Base, Arbitrum): one address in, one ChainRead out.
//
//   1. eth_getCode — empty → kind 'empty'; EIP-7702 delegation → kind 'account' (+ the delegate as a link)
//   2. codeHash = sha256 of the runtime bytecode with its trailing CBOR metadata removed (the last two
//      bytes give the CBOR length), so two deployments of the same code hash the same
//   3. proxies — EIP-1167 clones from the bytecode pattern (no RPC); EIP-1967 implementation / beacon,
//      EIP-1822 and ZeppelinOS slots by eth_getStorageAt, only when the code has DELEGATECALL (and,
//      for large contracts, only the slots whose constants are in the code); beacon → implementation();
//      slots empty but implementation() in the code → EIP-897 (Aragon AppProxy, Compound delegators)
//   4. Sourcify v2 lookup — match level, compiler, name, ABI, source files (only the files of the
//      verified compilation: Sourcify's `sources` can list files of other compilations; `sourceIds`
//      is authoritative)
//
// At most 6 RPC calls per read and one Sourcify request (two when the record is over the size cap).
// Nothing here evaluates keep/reject: index.ts does, using the read, sourceBundleHash and profile.

import { createHash } from 'node:crypto'
import type { ChainRead } from '../../shared/chain.ts'
import { RpcError, type RpcCtx } from './rpc.ts'
import { abiSignatures, langOfPath, profileEvmSources, sourceBundleHash, type EvmSourceProfile, type SourceText } from './evm-source.ts'

export type EvmChain = 'ethereum' | 'base' | 'arbitrum'
export const EVM_CHAIN_IDS: Record<EvmChain, number> = { ethereum: 1, base: 8453, arbitrum: 42161 }

/** Storage slots of the proxy standards (all verified against their keccak definitions). */
export const PROXY_SLOTS = {
  /** bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1) */
  eip1967Implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  /** bytes32(uint256(keccak256('eip1967.proxy.beacon')) - 1) */
  eip1967Beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  /** bytes32(uint256(keccak256('eip1967.proxy.admin')) - 1) */
  eip1967Admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  /** keccak256('PROXIABLE') */
  eip1822: '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7',
  /** keccak256('org.zeppelinos.proxy.implementation') — pre-1967 OpenZeppelin proxies (e.g. USDC) */
  zeppelinos: '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
  /** keccak256('org.zeppelinos.proxy.admin') */
  zeppelinosAdmin: '0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b',
} as const

/** implementation() selector, asked of a beacon. */
const IMPLEMENTATION_SELECTOR = '0x5c60da1b'
/** masterCopy() selector: Safe (Gnosis Safe) proxies keep the singleton in slot 0. */
const SAFE_MASTERCOPY = 'a619486e'

const MAX_RPC_PER_READ = 6
/** Above this size, slots are probed only when their constant is in the bytecode (proxies are small). */
const SMALL_CODE = 3072
const MB = 1048576
const SOURCIFY_MAX_BYTES = 8 * MB
/** Sourcify bodies run to several MB; the 8 s RPC timeout is too tight for them. */
const SOURCIFY_TIMEOUT_MS = 15_000
const RPC_TIMEOUT_MS = 8_000
const MAX_SOURCE_FILES = 1000
const MAX_SOURCE_TEXT = 6 * MB

export interface EvmReadResult {
  read: ChainRead
  /** Full ABI JSON (Sourcify), for storage. */
  abiJson: unknown | null
  /** Verified source files of the compilation, raw text, sorted by path. */
  sources: { path: string; text: string }[]
  /** sha256 over sorted (path, normalized content): identical code under any formatting collapses. */
  sourceBundleHash: string | null
  /** Custom-vs-library line counts and a boilerplate reason (null = reads as protocol code). */
  profile: EvmSourceProfile | null
}

export interface ReadEvmOptions {
  /**
   * Called with the codeHash before the Sourcify request; return true to skip it (e.g. the codeHash
   * already belongs to a kept item, so the read is a duplicate either way). Saves registry budget.
   */
  skipSourcify?: (codeHash: string) => boolean
}

// ─── bytecode helpers ────────────────────────────────────────────────────────

const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/** 0x-prefixed lowercase 20-byte address, or null. */
export function normalizeEvmAddress(a: string): string | null {
  const s = String(a ?? '').trim()
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null
}

/** Bytes of a JSON-RPC hex data result ('0x…'), or null when malformed. '0x' / '0x0' → empty. */
export function hexToBytes(v: unknown): Buffer | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) return null
  const h = v.slice(2)
  if (h === '0' || h === '') return Buffer.alloc(0)
  if (h.length % 2) return null
  return Buffer.from(h, 'hex')
}

/** Index after one CBOR item starting at i, or -1 (malformed, indefinite length, or out of bounds). */
function cborSkip(b: Buffer, i: number, end: number, depth = 0): number {
  if (i >= end || depth > 8) return -1
  const ib = b[i]
  const mt = ib >> 5
  const ai = ib & 31
  let p = i + 1
  let len: number
  if (ai < 24) len = ai
  else if (ai === 24) {
    if (p + 1 > end) return -1
    len = b[p]
    p += 1
  } else if (ai === 25) {
    if (p + 2 > end) return -1
    len = b.readUInt16BE(p)
    p += 2
  } else if (ai === 26) {
    if (p + 4 > end) return -1
    len = b.readUInt32BE(p)
    p += 4
  } else return -1
  switch (mt) {
    case 0:
    case 1:
      return p
    case 2:
    case 3:
      return p + len <= end ? p + len : -1
    case 4:
    case 5: {
      const items = mt === 5 ? len * 2 : len
      for (let k = 0; k < items; k++) {
        p = cborSkip(b, p, end, depth + 1)
        if (p < 0) return -1
      }
      return p
    }
    case 6:
      return cborSkip(b, p, end, depth + 1)
    default:
      // simple values / floats: the argument bytes were the value
      return ai <= 27 ? p : -1
  }
}

/** Text keys of a top-level CBOR map (e.g. ipfs, solc, bzzr0, vyper) — for notes only. */
function cborKeys(b: Buffer, start: number, end: number): string[] {
  const keys: string[] = []
  const ib = b[start]
  const mt = ib >> 5
  if (mt === 4) {
    // Vyper ≥ 0.4 appends an array whose last element is the {'vyper': [...]} map
    let p = start + 1
    const n = ib & 31
    for (let k = 0; k < n && p >= 0 && p < end; k++) {
      if (k === n - 1 && b[p] >> 5 === 5) return cborKeys(b, p, end)
      p = cborSkip(b, p, end)
    }
    return keys
  }
  if (mt !== 5) return keys
  const n = ib & 31
  let p = start + 1
  for (let k = 0; k < n && p >= 0 && p < end; k++) {
    const kb = b[p]
    if (kb >> 5 === 3 && (kb & 31) < 24) keys.push(b.subarray(p + 1, p + 1 + (kb & 31)).toString('latin1'))
    p = cborSkip(b, p, end)
    if (p < 0) break
    p = cborSkip(b, p, end)
  }
  return keys.filter((k) => /^[\x20-\x7e]{1,24}$/.test(k))
}

/**
 * Runtime bytecode split from its compiler metadata trailer: Solidity / Vyper append a CBOR map
 * (Vyper ≥ 0.4: an array) followed by its length as 2 big-endian bytes. The trailer is accepted only
 * when that length is in range and the CBOR item parses to exactly those bytes.
 */
export function splitMetadata(code: Buffer): { body: Buffer; metadataBytes: number; keys: string[] } {
  if (code.length < 4) return { body: code, metadataBytes: 0, keys: [] }
  const len = code.readUInt16BE(code.length - 2)
  if (len < 1 || len + 2 > code.length) return { body: code, metadataBytes: 0, keys: [] }
  const start = code.length - 2 - len
  const end = code.length - 2
  const mt = code[start] >> 5
  if ((mt !== 5 && mt !== 4) || cborSkip(code, start, end) !== end) return { body: code, metadataBytes: 0, keys: [] }
  return { body: code.subarray(0, start), metadataBytes: len + 2, keys: cborKeys(code, start, end) }
}

/** codeHash of runtime bytecode: sha256 (hex) of the bytecode without its metadata trailer. */
export function evmCodeHash(code: Buffer): string {
  return sha256hex(splitMetadata(code).body)
}

/** True when `op` occurs as an opcode (PUSH1…PUSH32 immediates skipped). */
export function hasOpcode(code: Buffer, op: number): boolean {
  for (let i = 0; i < code.length; i++) {
    const b = code[i]
    if (b === op) return true
    if (b >= 0x60 && b <= 0x7f) i += b - 0x5f
  }
  return false
}

const CLONE_RE = /^363d3d373d3d3d363d(6[0-9a-f]|7[0-3])([0-9a-f]*?)5af43d82803e903d9160[0-9a-f]{2}57fd5bf3$/

/** Implementation of an EIP-1167 minimal proxy (incl. the shorter-PUSH vanity form), or null. */
export function minimalProxyTarget(code: Buffer): string | null {
  if (code.length < 30 || code.length > 64) return null
  const m = CLONE_RE.exec(code.toString('hex'))
  if (!m) return null
  const n = parseInt(m[1], 16) - 0x5f
  if (m[2].length !== n * 2) return null
  return `0x${m[2].padStart(40, '0')}`
}

/** Delegate of an EIP-7702 delegated account (code = 0xef0100 ‖ address), or null. */
export function eip7702Delegate(code: Buffer): string | null {
  if (code.length !== 23 || code[0] !== 0xef || code[1] !== 0x01 || code[2] !== 0x00) return null
  return `0x${code.subarray(3).toString('hex')}`
}

/** Address held in a 32-byte storage word / return value, or null (zero, or not an address). */
export function wordToAddress(v: unknown): string | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) return null
  const h = v.slice(2).toLowerCase()
  if (h.length > 64) return null
  const w = h.padStart(64, '0')
  if (!/^0{24}/.test(w)) return null
  const a = w.slice(24)
  return /^0+$/.test(a) ? null : `0x${a}`
}

// ─── reader ──────────────────────────────────────────────────────────────────

class CallCap extends Error {}

function emptyRead(chain: EvmChain, address: string): ChainRead {
  return {
    chain,
    address,
    kind: 'empty',
    name: null,
    codeHash: null,
    upgradeable: null,
    upgradeAuthority: null,
    lastDeploySlot: null,
    programBytes: null,
    loader: null,
    idl: null,
    securityTxt: null,
    bytecodeBytes: null,
    proxy: null,
    abi: null,
    verified: null,
    sources: [],
    notes: [],
    readAt: Date.now(),
    rpcCalls: 0,
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160)

type ProxyStd = NonNullable<ChainRead['proxy']>['standard']

interface ProxyFinding {
  proxy: ChainRead['proxy']
  upgradeable: boolean | null
  admin: string | null
  notes: string[]
}

/** Proxy detection by storage slots. Never throws (failures become notes) except on a budget error. */
async function detectProxy(address: string, code: Buffer, rpc: (m: string, p: unknown[]) => Promise<unknown>): Promise<ProxyFinding> {
  const out: ProxyFinding = { proxy: null, upgradeable: false, admin: null, notes: [] }
  if (!hasOpcode(code, 0xf4)) return out // no DELEGATECALL: not a proxy, code is fixed
  const hex = code.toString('hex')
  const has = (slot: string) => hex.includes(slot.slice(2))
  const read = (slot: string) => rpc('eth_getStorageAt', [address, slot, 'latest'])
  try {
    // Safe proxies: tiny fixed code, singleton address in slot 0
    if (code.length <= 400 && hex.includes(SAFE_MASTERCOPY)) {
      const impl = wordToAddress(await read('0x0'))
      if (impl) {
        out.proxy = { standard: 'other', implementation: impl }
        out.upgradeable = true
        out.notes.push(`Gnosis Safe proxy: singleton ${impl} (storage slot 0)`)
        return out
      }
    }
    const order: [string, ProxyStd, string][] = [
      [PROXY_SLOTS.eip1967Implementation, 'eip1967', 'EIP-1967'],
      [PROXY_SLOTS.eip1967Beacon, 'beacon', 'EIP-1967 beacon'],
      [PROXY_SLOTS.eip1822, 'eip1822', 'EIP-1822'],
      [PROXY_SLOTS.zeppelinos, 'other', 'ZeppelinOS'],
    ]
    let probe = order.filter(([slot]) => has(slot))
    if (!probe.length) probe = code.length > SMALL_CODE ? [] : order
    for (const [slot, std, label] of probe) {
      const a = wordToAddress(await read(slot))
      if (!a) continue
      out.upgradeable = true
      if (std === 'beacon') {
        let impl: string | null = null
        try {
          impl = wordToAddress(await rpc('eth_call', [{ to: a, data: IMPLEMENTATION_SELECTOR }, 'latest']))
        } catch (e) {
          if (e instanceof CallCap) throw e
          if (isBudget(e)) throw e
          out.notes.push(`beacon implementation() failed: ${errMsg(e)}`)
        }
        out.proxy = { standard: 'beacon', implementation: impl ?? a }
        out.notes.push(impl ? `${label} proxy: beacon ${a} → implementation ${impl}` : `${label} proxy: beacon ${a} (implementation unknown)`)
      } else {
        out.proxy = { standard: std, implementation: a }
        out.notes.push(`${label} proxy → implementation ${a}`)
      }
      // the admin that can upgrade it, when the code names the admin slot (transparent proxies)
      const adminSlot = std === 'other' ? PROXY_SLOTS.zeppelinosAdmin : PROXY_SLOTS.eip1967Admin
      if (has(adminSlot)) {
        try {
          out.admin = wordToAddress(await read(adminSlot))
        } catch (e) {
          if (isBudget(e)) throw e
          if (!(e instanceof CallCap)) out.notes.push(`admin slot read failed: ${errMsg(e)}`)
        }
      }
      return out
    }
    // EIP-897: the proxy names its implementation through implementation() (Aragon AppProxy, Compound
    // delegators, custom proxies keeping the address outside the standard slots); asked only when the
    // selector is in the code
    if (hex.includes(IMPLEMENTATION_SELECTOR.slice(2))) {
      let impl: string | null = null
      try {
        impl = wordToAddress(await rpc('eth_call', [{ to: address, data: IMPLEMENTATION_SELECTOR }, 'latest']))
      } catch (e) {
        if (e instanceof CallCap || isBudget(e)) throw e
        out.notes.push(`implementation() failed: ${errMsg(e)}`)
      }
      if (impl && impl !== address.toLowerCase()) {
        out.proxy = { standard: 'other', implementation: impl }
        out.upgradeable = null
        out.notes.push(`EIP-897 proxy: implementation() → ${impl}`)
        return out
      }
    }
    out.upgradeable = null
    out.notes.push(probe.length ? 'uses DELEGATECALL; standard proxy slots are empty' : 'uses DELEGATECALL; no proxy slot constant in the bytecode')
  } catch (e) {
    if (isBudget(e)) throw e
    out.upgradeable = out.proxy ? out.upgradeable : null
    out.notes.push(e instanceof CallCap ? 'proxy check stopped at the per-read RPC limit' : `proxy check failed: ${errMsg(e)}`)
  }
  return out
}

const isBudget = (e: unknown) => e instanceof Error && e.name === 'BudgetError'

interface SourcifyRecord {
  match?: unknown
  runtimeMatch?: unknown
  creationMatch?: unknown
  compilation?: { compiler?: unknown; compilerVersion?: unknown; name?: unknown; fullyQualifiedName?: unknown; language?: unknown } | null
  abi?: unknown
  sources?: Record<string, { content?: unknown } | null> | null
  sourceIds?: Record<string, unknown> | null
  proxyResolution?: { isProxy?: unknown; proxyType?: unknown; implementations?: { address?: unknown; name?: unknown }[] } | null
  deployment?: { blockNumber?: unknown } | null
}

const SOURCIFY_FIELDS = 'sources,sourceIds,abi,compilation,proxyResolution,deployment'
const SOURCIFY_FIELDS_LEAN = 'abi,compilation,proxyResolution,deployment'

/** Sourcify v2 record, or null when the address has no verified match. Transport errors propagate. */
async function sourcifyLookup(ctx: RpcCtx, chainId: number, address: string, notes: string[]): Promise<SourcifyRecord | null> {
  const url = (fields: string) => `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=${fields}`
  const get = (fields: string) => ctx.fetchJson(url(fields), { host: 'sourcify', maxBytes: SOURCIFY_MAX_BYTES, timeoutMs: SOURCIFY_TIMEOUT_MS })
  let j: unknown
  try {
    j = await get(SOURCIFY_FIELDS)
  } catch (e) {
    if (e instanceof RpcError && e.kind === 'http' && e.status === 404) return null
    if (e instanceof RpcError && e.kind === 'too-large') {
      notes.push('Sourcify record over 8 MB: ABI kept, source files not stored')
      try {
        j = await get(SOURCIFY_FIELDS_LEAN)
      } catch (e2) {
        if (e2 instanceof RpcError && e2.kind === 'http' && e2.status === 404) return null
        throw e2
      }
    } else throw e
  }
  if (!j || typeof j !== 'object') throw new Error('Sourcify returned a malformed record')
  const r = j as SourcifyRecord
  if (r.match !== 'exact_match' && r.match !== 'match') return null
  return r
}

const proxyStdOf = (t: unknown): ProxyStd =>
  t === 'EIP1967Proxy' ? 'eip1967' : t === 'PROXIABLEProxy' ? 'eip1822' : t === 'EIP1167Proxy' ? 'eip1167' : 'other'

/**
 * Read one EVM address: code, codeHash, proxy, Sourcify verification, ABI and sources.
 * Throws on an unusable eth_getCode, a budget error, or a Sourcify transport failure (so the caller
 * records an error instead of a wrong 'unverified'); everything else degrades to notes.
 */
export async function readEvm(chain: EvmChain, address: string, ctx: RpcCtx, opts: ReadEvmOptions = {}): Promise<EvmReadResult> {
  const chainId = EVM_CHAIN_IDS[chain]
  if (!chainId) throw new Error(`not an EVM chain: ${String(chain)}`)
  const addr = normalizeEvmAddress(address)
  if (!addr) throw new Error('not an EVM address')
  const read = emptyRead(chain, addr)
  const result: EvmReadResult = { read, abiJson: null, sources: [], sourceBundleHash: null, profile: null }
  const rpc = async (method: string, params: unknown[], maxBytes = 64 * 1024) => {
    if (read.rpcCalls >= MAX_RPC_PER_READ) throw new CallCap('per-read RPC limit')
    read.rpcCalls++
    return ctx.call(chain, method, params, { timeoutMs: RPC_TIMEOUT_MS, maxBytes })
  }

  // 1. code
  const code = hexToBytes(await rpc('eth_getCode', [addr, 'latest'], 256 * 1024))
  read.readAt = Date.now()
  if (!code) throw new Error('eth_getCode returned a malformed result')
  if (code.length === 0) {
    read.kind = 'empty'
    read.notes.push('no code at this address (externally owned account or removed contract)')
    return result
  }
  read.bytecodeBytes = code.length
  const delegate = eip7702Delegate(code)
  if (delegate) {
    read.kind = 'account'
    read.upgradeable = true
    read.proxy = { standard: 'other', implementation: delegate }
    read.notes.push(`EIP-7702 delegated account → ${delegate}`)
    return result
  }
  read.kind = 'contract'

  // 2. codeHash without the metadata trailer
  const meta = splitMetadata(code)
  read.codeHash = sha256hex(meta.body)
  read.notes.push(
    meta.metadataBytes
      ? `runtime bytecode ${code.length} bytes; metadata trailer (${meta.keys.join(', ') || 'cbor'}, ${meta.metadataBytes} bytes) excluded from codeHash`
      : `runtime bytecode ${code.length} bytes; no metadata trailer`,
  )
  if (code[0] === 0xef && code[1] === 0xf0 && code[2] === 0x00) read.notes.push('Arbitrum Stylus (WASM) program')

  // 3a. EIP-1167 clone: the implementation is the code; nothing to verify here
  const clone = minimalProxyTarget(code)
  if (clone) {
    read.proxy = { standard: 'eip1167', implementation: clone }
    read.upgradeable = false
    read.notes.push(`EIP-1167 minimal proxy → implementation ${clone}`)
    return result
  }

  // 3b + 4. proxy slots (RPC) and Sourcify (HTTP) side by side
  const skip = opts.skipSourcify?.(read.codeHash) === true
  const [px, sf] = await Promise.allSettled([
    detectProxy(addr, meta.body, (m, p) => rpc(m, p)),
    skip ? Promise.resolve(null) : sourcifyLookup(ctx, chainId, addr, read.notes),
  ])
  if (px.status === 'rejected') throw px.reason
  if (sf.status === 'rejected') {
    // RpcError as is: its message names Sourcify and its `transient` flag drives the retry
    if (isBudget(sf.reason) || sf.reason instanceof RpcError) throw sf.reason
    throw new Error(`Sourcify lookup failed: ${errMsg(sf.reason)}`)
  }
  read.proxy = px.value.proxy
  read.upgradeable = px.value.upgradeable
  read.upgradeAuthority = px.value.admin
  read.notes.push(...px.value.notes)
  if (skip) {
    read.notes.push('Sourcify not asked: this bytecode was already judged')
    return result
  }
  const rec = sf.value
  if (!rec) {
    read.notes.push('Sourcify: no verified source')
    return result
  }

  const comp = rec.compilation ?? {}
  const compiler = [comp.compiler, comp.compilerVersion].filter((x) => typeof x === 'string' && x).join(' ') || null
  const full = rec.match === 'exact_match'
  read.verified = { by: 'sourcify', match: full ? 'full' : 'partial', repo: null, commit: null, compiler }
  read.name = typeof comp.name === 'string' && comp.name ? comp.name.slice(0, 120) : null
  read.notes.push(full ? 'Sourcify full match' : 'Sourcify partial match')
  const block = Number(rec.deployment?.blockNumber)
  if (Number.isFinite(block) && block > 0) read.notes.push(`deployed in block ${block}`)

  if (Array.isArray(rec.abi)) {
    result.abiJson = rec.abi
    read.abi = abiSignatures(rec.abi)
  }

  // sources of the verified compilation only
  const all = rec.sources && typeof rec.sources === 'object' ? rec.sources : {}
  const ids = rec.sourceIds && typeof rec.sourceIds === 'object' ? Object.keys(rec.sourceIds) : []
  const paths = (ids.length ? ids.filter((p) => Object.hasOwn(all, p)) : Object.keys(all)).sort()
  const extra = Object.keys(all).length - paths.length
  if (ids.length && extra > 0) read.notes.push(`${extra} source files outside the verified compilation ignored`)
  let total = 0
  let dropped = 0
  const files: SourceText[] = []
  for (const p of paths) {
    const c = all[p]?.content
    if (typeof c !== 'string') continue
    const bytes = Buffer.byteLength(c, 'utf8')
    if (files.length >= MAX_SOURCE_FILES || total + bytes > MAX_SOURCE_TEXT) {
      dropped++
      continue
    }
    total += bytes
    files.push({ path: p, text: c })
    read.sources.push({ path: p, lang: langOfPath(p), bytes })
  }
  if (dropped) read.notes.push(`${dropped} source files over the per-contract cap not stored`)
  result.sources = files
  // the compilation target is part of the hash: Token and Crowdsale verified from one flattened file differ
  const target = typeof comp.fullyQualifiedName === 'string' && comp.fullyQualifiedName ? comp.fullyQualifiedName : typeof comp.name === 'string' ? comp.name : null
  result.sourceBundleHash = sourceBundleHash(files, target)

  // Sourcify's proxy record fills in when the slots said nothing (diamonds, unusual layouts)
  const pr = rec.proxyResolution
  if (!read.proxy && pr && pr.isProxy === true && Array.isArray(pr.implementations)) {
    const impl = pr.implementations.map((x) => (typeof x?.address === 'string' ? normalizeEvmAddress(x.address) : null)).find(Boolean)
    if (impl) {
      const std = proxyStdOf(pr.proxyType)
      read.proxy = { standard: std, implementation: impl }
      read.upgradeable = std !== 'eip1167'
      read.notes.push(`proxy (${typeof pr.proxyType === 'string' ? pr.proxyType.slice(0, 40) : 'unknown type'}) → implementation ${impl}, from the Sourcify record`)
    }
  }

  if (files.length) {
    const prof = profileEvmSources(files, { abiFunctions: read.abi?.functions ?? null, name: read.name, proxy: read.proxy !== null })
    result.profile = prof
    read.notes.push(`custom code ${prof.customLines} lines, library ${prof.libraryLines}, interfaces ${prof.interfaceLines}`)
    if (prof.boilerplate) read.notes.push(`boilerplate: ${prof.boilerplate}`)
  }
  return result
}
