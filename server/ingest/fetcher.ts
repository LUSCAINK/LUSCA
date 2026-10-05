// Single-hop HTTP GET with a hard byte cap, content-type gate and charset
// decoding. Redirects are NOT followed here (redirect: 'manual') so the crawler
// can apply robots.txt + per-host politeness to every hop.
import { botHeaders } from './util.ts'
import { assertPublicHost } from './netguard.ts'

export const MAX_BODY_BYTES = 2 * 1024 * 1024
export const PAGE_TIMEOUT_MS = 12_000

export type FetchKind = 'ok' | 'redirect' | 'http-error' | 'non-html'

export interface FetchOnceResult {
  kind: FetchKind
  status: number
  url: string
  /** absolute redirect target (kind === 'redirect') */
  location: string | null
  /** lowercased mime type without parameters, '' if absent */
  contentType: string
  html: string
  bytes: number
  truncated: boolean
  ms: number
  retryAfterMs: number | null
  xRobotsTag: string | null
  /** TDMRep `tdm-reservation` response header ('1' = text-and-data-mining rights reserved). */
  tdmReservation: string | null
  /** `Content-Signal` response header (e.g. "search=yes, ai-train=no"), if any. */
  contentSignal: string | null
}

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])
const REDIRECTS = new Set([301, 302, 303, 307, 308])

/** Read a body stream up to `cap` bytes, cancelling the rest. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (total + value.byteLength > cap) {
        chunks.push(value.subarray(0, cap - total))
        total = cap
        truncated = true
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {})
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return { bytes: out, truncated }
}

function charsetFrom(contentTypeHeader: string | null, head: Uint8Array): string {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentTypeHeader ?? '')
  if (m) return m[1].toLowerCase()
  // Sniff <meta charset> / http-equiv in the first 4 KB (ASCII-compatible decode is fine for the tag).
  const sniff = new TextDecoder('latin1').decode(head.subarray(0, 4096))
  const mm = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(sniff)
  return mm ? mm[1].toLowerCase() : 'utf-8'
}

export function decodeBody(bytes: Uint8Array, contentTypeHeader: string | null): string {
  const cs = charsetFrom(contentTypeHeader, bytes)
  try {
    return new TextDecoder(cs, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

function retryAfter(h: string | null): number | null {
  if (!h) return null
  const n = Number(h)
  if (Number.isFinite(n)) return Math.max(0, n * 1000)
  const t = Date.parse(h)
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null
}

/**
 * One GET. Throws on network failure / abort (the caller classifies with
 * describeFetchError). Never follows redirects.
 */
export async function fetchOnce(url: string, signal: AbortSignal): Promise<FetchOnceResult> {
  const t0 = Date.now()
  // Never talk to loopback / private / link-local space, whatever the hostname says.
  await assertPublicHost(new URL(url).hostname)
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal,
    headers: botHeaders({
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      'Accept-Language': 'en-US,en;q=0.9',
    }),
  })
  const ctHeader = res.headers.get('content-type')
  const contentType = (ctHeader ?? '').split(';')[0].trim().toLowerCase()
  const base: FetchOnceResult = {
    kind: 'ok',
    status: res.status,
    url,
    location: null,
    contentType,
    html: '',
    bytes: 0,
    truncated: false,
    ms: 0,
    retryAfterMs: retryAfter(res.headers.get('retry-after')),
    xRobotsTag: res.headers.get('x-robots-tag'),
    tdmReservation: res.headers.get('tdm-reservation'),
    contentSignal: res.headers.get('content-signal'),
  }

  if (REDIRECTS.has(res.status)) {
    await res.body?.cancel().catch(() => {})
    const loc = res.headers.get('location')
    let abs: string | null = null
    if (loc) {
      try {
        abs = new URL(loc, url).toString()
      } catch {
        abs = null
      }
    }
    return { ...base, kind: abs ? 'redirect' : 'http-error', location: abs, ms: Date.now() - t0 }
  }
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel().catch(() => {})
    return { ...base, kind: 'http-error', ms: Date.now() - t0 }
  }
  if (contentType && !HTML_TYPES.has(contentType)) {
    await res.body?.cancel().catch(() => {})
    return { ...base, kind: 'non-html', ms: Date.now() - t0 }
  }

  const { bytes, truncated } = await readCapped(res.body, MAX_BODY_BYTES)
  if (!contentType) {
    // No content-type: accept only if it actually looks like HTML.
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).toLowerCase()
    if (!head.includes('<html') && !head.includes('<!doctype html') && !head.includes('<head')) {
      return { ...base, kind: 'non-html', contentType: 'unknown', bytes: bytes.byteLength, ms: Date.now() - t0 }
    }
  }
  const html = decodeBody(bytes, ctHeader)
  return { ...base, kind: 'ok', html, bytes: bytes.byteLength, truncated, ms: Date.now() - t0 }
}

export interface FetchErrorInfo {
  msg: string
  timeout: boolean
  aborted: boolean
  code: string | null
}

export function describeFetchError(e: unknown, timeoutMs = PAGE_TIMEOUT_MS): FetchErrorInfo {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string; name?: string } }
  const name = err?.name ?? ''
  if (name === 'TimeoutError') return { msg: `timeout after ${Math.round(timeoutMs / 1000)} s`, timeout: true, aborted: false, code: 'TIMEOUT' }
  if (name === 'AbortError') return { msg: 'aborted', timeout: false, aborted: true, code: 'ABORT' }
  const code = err?.cause?.code ?? null
  if (err?.cause?.name === 'TimeoutError') return { msg: `timeout after ${Math.round(timeoutMs / 1000)} s`, timeout: true, aborted: false, code: 'TIMEOUT' }
  const detail = code ?? err?.cause?.message ?? err?.message ?? 'unknown'
  return { msg: `network error (${String(detail).slice(0, 80)})`, timeout: false, aborted: false, code }
}
