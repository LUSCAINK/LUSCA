// EXPOSURE on the client: address-format detection and REST helpers for /api/exposure/*. Every fact on the
// page comes from the server's reads; the browser reads nothing from a chain itself.
import { isSolanaAddress } from '@shared/base58'
import type { ExposureChain, ExposureReport, ExposureStatus, ExposureSummary } from './exposure-types'

export type ExposureInput =
  | { kind: 'solana'; address: string }
  | { kind: 'evm'; address: string }
  | { kind: 'invalid'; why: string }
  | { kind: 'empty' }

const EVM = /^0x[0-9a-fA-F]{40}$/
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/

/** What the pasted text is: a Solana address (base58 of exactly 32 bytes) or an EVM address (0x + 40 hex). */
export function classifyAddress(raw: string): ExposureInput {
  const s = raw.trim()
  if (!s) return { kind: 'empty' }
  if (EVM.test(s)) return { kind: 'evm', address: s }
  if (/^0x/i.test(s)) return { kind: 'invalid', why: `an EVM address is 0x and 40 hex characters (${Math.max(0, s.length - 2)} given)` }
  if (isSolanaAddress(s)) return { kind: 'solana', address: s }
  if (B58.test(s)) return { kind: 'invalid', why: 'base58, but not 32 bytes: not a Solana address' }
  return { kind: 'invalid', why: 'not a Solana address (base58, 32 bytes) or an EVM address (0x + 40 hex)' }
}

export class ExposureHttpError extends Error {
  readonly status: number
  /** Seconds, from Retry-After. */
  readonly retryAfter: number | null
  constructor(status: number, message: string, retryAfter: number | null) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal, headers: { accept: 'application/json' } })
  const text = await r.text()
  let j: unknown = null
  try {
    j = JSON.parse(text)
  } catch {
    /* an HTML fallback page: the route is not served here */
  }
  if (!r.ok || j === null) {
    const msg = (j as { error?: string } | null)?.error ?? (r.ok ? 'the server does not serve this yet' : `HTTP ${r.status}`)
    const ra = Number(r.headers.get('retry-after'))
    throw new ExposureHttpError(r.ok ? 404 : r.status, msg, Number.isFinite(ra) && ra > 0 ? ra : null)
  }
  return j as T
}

export const fetchExposure = (chain: ExposureChain, address: string, signal?: AbortSignal) =>
  getJson<ExposureReport>(`/api/exposure/${chain}/${encodeURIComponent(address)}`, signal)
export const fetchExposureSummary = (signal?: AbortSignal) => getJson<ExposureSummary>('/api/exposure/summary', signal)
export const fetchExposureStatus = (signal?: AbortSignal) => getJson<ExposureStatus>('/api/exposure/status', signal)

/** "1 234.5678" style: thousands separators on the integer part of a decimal string, at most `maxFrac` decimals (cut, not rounded). */
export function fmtAmount(dec: string, maxFrac = 6): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(dec.trim())
  if (!m) return dec
  const int = m[2].replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = (m[3] ?? '').slice(0, maxFrac).replace(/0+$/, '')
  const cut = (m[3] ?? '').length > maxFrac && /[1-9]/.test((m[3] ?? '').slice(maxFrac))
  if (!frac && cut && int === '0') return `${m[1]}< 0.${'0'.repeat(maxFrac - 1)}1`
  return `${m[1]}${int}${frac ? `.${frac}` : ''}`
}

/** true when the decimal string is exactly zero. */
export const isZeroAmount = (dec: string) => !/[1-9]/.test(dec)
