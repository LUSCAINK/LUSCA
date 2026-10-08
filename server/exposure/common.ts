// EXPOSURE: pieces shared by the Solana and EVM lookups (server/exposure/solana.ts, evm.ts).

import type { ControlEntry } from '../../shared/control.ts'
import type { ExposureChain, ExposureControl, ExposureHolds, ExposureKey, ExposureSafe } from '../../src/lib/exposure-types.ts'
import { BudgetError, RpcError, redact } from '../chain/rpc.ts'

/** One call of a lookup, charged to the Exposure slice and the shared chain budget. */
export interface LookupCtx {
  /**
   * `weight`: budget units (Helius-style credits: getProgramAccounts and DAS 10, everything else 1).
   * Rejects with BudgetError (nothing sent), DeadlineError (lookup out of time) or RpcError.
   */
  call(chain: ExposureChain, method: string, params: unknown, o?: { weight?: number; timeoutMs?: number; maxBytes?: number }): Promise<unknown>
  /** null when `weight` more units on `chain` fit now; else a plain reason why not. */
  short(chain: ExposureChain, weight: number): string | null
}

/** What LUSCA already holds about addresses (Control Map, Exposure Map), read without RPC. */
export interface KnownIndex {
  /** Kept programs / contracts whose controller chain (after the item itself) includes this address, any chain. */
  controlledBy(address: string): ControlEntry[]
  /** The Control Map entry of a kept item. */
  entry(chain: ExposureChain, address: string): ControlEntry | null
  /** Safes whose owner list LUSCA has read and that list this address as an owner. */
  safesOf(address: string): { chain: ExposureChain; address: string; threshold: number; owners: number; at: number }[]
}

export const NO_KNOWN: KnownIndex = { controlledBy: () => [], entry: () => null, safesOf: () => [] }

/** The chain-specific part of an ExposureReport. */
export interface LookupResult {
  key: ExposureKey
  holds: ExposureHolds
  controls: ExposureControl[]
  safe?: ExposureSafe
  partial: string[]
  notes: string[]
}

/** The lookup ran past its deadline: no further calls are sent. */
export class DeadlineError extends Error {
  constructor() {
    super('lookup deadline reached')
    this.name = 'DeadlineError'
  }
}

/** Raw integer → exact decimal string ('1.5', '0.000001', '12'). */
export function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n
  const v = neg ? -raw : raw
  if (decimals <= 0) return `${neg ? '-' : ''}${v}`
  const base = 10n ** BigInt(decimals)
  const int = v / base
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`
}

/** Compare two decimal strings (non-negative) as numbers: > 0 when a > b. */
export function cmpDecimal(a: string, b: string): number {
  const [ai, af = ''] = a.split('.')
  const [bi, bf = ''] = b.split('.')
  const ia = ai.replace(/^0+(?=\d)/, '')
  const ib = bi.replace(/^0+(?=\d)/, '')
  if (ia.length !== ib.length) return ia.length - ib.length
  if (ia !== ib) return ia < ib ? -1 : 1
  const n = Math.max(af.length, bf.length)
  const fa = af.padEnd(n, '0')
  const fb = bf.padEnd(n, '0')
  return fa === fb ? 0 : fa < fb ? -1 : 1
}

export const int = (n: number) => Math.round(n).toLocaleString('en-US')

/** Plain reason for a step that did not complete (never a URL or key). */
export function reasonOf(what: string, e: unknown): string {
  if (e instanceof BudgetError) return `${what}: not read, today's Exposure budget for this chain is used up (resets 00:00 UTC)`
  if (e instanceof DeadlineError) return `${what}: not read, the lookup ran out of time`
  if (e instanceof RpcError) {
    if (e.kind === 'too-large') return `${what}: more results than one answer may carry, not listed`
    if (e.kind === 'timeout') return `${what}: the RPC did not answer in time`
    if (e.kind === 'rpc' && (e.code === -32602 || e.code === -32601 || e.code === -32010 || /excluded|not supported|method not found|unavailable for key/i.test(e.message)))
      return `${what}: this RPC endpoint does not answer that query`
    if (e.transient) return `${what}: the RPC did not answer usably (${e.kind === 'http' && e.status ? `HTTP ${e.status}` : e.kind}), retry later`
    return `${what}: the RPC answered with an error`
  }
  const m = redact(e instanceof Error ? e.message : String(e)).slice(0, 120)
  return `${what}: not read (${m})`
}

/** A name fit for display: plain text, no links or handles, ≤ 48 characters; else undefined. */
const URLISH = /https?:|www\.|:\/\/|\.(?:com|io|xyz|net|org|app|gg|me|co|fi|finance|ink|site|online|top|vip|cc|link|click|claims?)\b|t\.me|discord|telegram|@/i
export function plainName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  // eslint-disable-next-line no-control-regex -- strip control characters from on-chain names
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!s || s.length > 48 || URLISH.test(s) || !/^[\p{L}\p{N} .()+:/_$-]+$/u.test(s)) return undefined
  return s
}

/** Run async jobs with at most `n` in flight; results in input order. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

/** Short form of an address for evidence lines. */
export const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

/** One kept item the address controls (Control Map hop), as an ExposureControl. */
export function controlFromEntry(e: ControlEntry, address: string, solana: boolean): ExposureControl | null {
  const want = solana ? address : address.toLowerCase()
  const i = e.hops.findIndex((h, k) => k > 0 && h.address && (solana ? h.address : h.address.toLowerCase()) === want)
  if (i < 0) return null
  const hop = e.hops[i]
  const path = e.hops
    .slice(0, i + 1)
    .map((h) => h.label)
    .join(' → ')
  const what = e.name ?? short(e.address)
  const direct = i === e.hops.length - 1
  return {
    kind: solana ? 'program-upgrade' : 'contract-control',
    chain: e.chain as ExposureChain,
    target: e.address,
    label: solana ? 'Can upgrade program' : direct ? 'Can change the code' : 'In the control path',
    ...(e.name ? { name: e.name } : {}),
    via: `LUSCA Control Map: ${hop.via ?? hop.label}`,
    evidence: `${path}${direct ? '' : ` → … (${e.hops.length - 1 - i} more hop${e.hops.length - 1 - i > 1 ? 's' : ''})`}; ${e.basis}${e.at ? ` (read ${new Date(e.at).toISOString().slice(0, 10)})` : ''}; ${what} on ${e.chain}`,
    href: `/lens/${e.chain}/${e.address}`,
  }
}
