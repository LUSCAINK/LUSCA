// /api/proofs/* routes. server/http.ts applies the Origin guard, the rate limits (reads: the
// shared read limit; POST lookups: their own per-address limit), the JSON content-type check and body
// parsing, then calls handleProofRoute. Errors carry an HTTP status (thrown as ProofRouteError).
//
// GET  /api/proofs?limit=20&before=<index>   chain head, open epoch, newest headers (paged)
// GET  /api/proofs/:index                    one header
// GET  /api/proofs/:index/leaves.json        every leaf of the epoch, tree order (recompute the root yourself)
// POST /api/proofs/mine          { auth?, device? }  your identity hashes and the epochs that hold a leaf for them
// POST /api/proofs/:index/proof  { auth?, device? }  your leaf + Merkle path in that epoch
// POST /api/proofs/preview       { auth?, device? }  period credits for the payout preview
//
// `auth` is the wallet session token (POST /api/auth/verify), `device` this browser's device id:
// the same identity rules as account.watch, so a caller only ever sees its own leaves and paths.

import type { PayoutPreviewData } from '../../shared/proofs.ts'
import type { ProofsApi } from './index.ts'

export class ProofRouteError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface ProofRouteResult {
  status: number
  body: unknown
  /** Pre-serialized JSON body (sent as is instead of `body`). */
  text?: string
  /** Strong validator for an immutable body (If-None-Match → 304). */
  etag?: string
  /** Response may be cached publicly for this many seconds. */
  maxAge?: number
}

/** Payout preview inputs (wired in server/index.ts from the coordinator ledger and payout config). */
export type PreviewSource = (identities: { scope: 'wallet' | 'device'; key: string; wallet: string | null }[]) => PayoutPreviewData

const INDEX_RE = /^\/api\/proofs\/(\d{1,9})$/
const LEAVES_RE = /^\/api\/proofs\/(\d{1,9})\/leaves\.json$/
const PROOF_RE = /^\/api\/proofs\/(\d{1,9})\/proof$/

function authBody(body: unknown): { auth: unknown; device: unknown } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProofRouteError(400, 'expected a JSON object')
  const b = body as { auth?: unknown; device?: unknown }
  if (b.auth !== undefined && b.auth !== null && typeof b.auth !== 'string') throw new ProofRouteError(400, 'auth must be a session token string')
  if (b.device !== undefined && b.device !== null && typeof b.device !== 'string') throw new ProofRouteError(400, 'device must be a device id string')
  if (!b.auth && !b.device) throw new ProofRouteError(400, 'send auth (wallet session token) or device (device id)')
  return { auth: b.auth ?? null, device: b.device ?? null }
}

/** Returns null when `p` is not a proofs route. */
export function handleProofRoute(api: ProofsApi, preview: PreviewSource | null, p: string, method: string, query: URLSearchParams, body: unknown): ProofRouteResult | null {
  if (p !== '/api/proofs' && !p.startsWith('/api/proofs/')) return null
  const isGet = method === 'GET' || method === 'HEAD'

  if (p === '/api/proofs') {
    if (!isGet) throw new ProofRouteError(405, 'method not allowed')
    const lim = query.get('limit')
    const before = query.get('before')
    const n = lim === null || lim === '' ? 20 : Number(lim)
    if (!Number.isInteger(n) || n < 1) throw new ProofRouteError(400, 'limit must be an integer from 1 to 100')
    let b: number | null = null
    if (before !== null && before !== '') {
      b = Number(before)
      if (!Number.isInteger(b) || b < 0) throw new ProofRouteError(400, 'before must be an epoch index')
    }
    return { status: 200, body: api.page(Math.min(100, n), b), maxAge: 5 }
  }

  if (p === '/api/proofs/mine') {
    if (method !== 'POST') throw new ProofRouteError(405, 'method not allowed')
    const { auth, device } = authBody(body)
    const identities = api.mine(auth, device)
    if (!identities.length) throw new ProofRouteError(401, 'no valid identity: the session token is invalid or expired and no valid device id was sent')
    return { status: 200, body: { identities } }
  }

  if (p === '/api/proofs/preview') {
    if (method !== 'POST') throw new ProofRouteError(405, 'method not allowed')
    if (!preview) throw new ProofRouteError(503, 'the payout preview is not available on this server')
    const { auth, device } = authBody(body)
    const ids = api.resolve(auth, device)
    if (!ids.length) throw new ProofRouteError(401, 'no valid identity: the session token is invalid or expired and no valid device id was sent')
    return { status: 200, body: preview(ids) }
  }

  let m = PROOF_RE.exec(p)
  if (m) {
    if (method !== 'POST') throw new ProofRouteError(405, 'method not allowed')
    const { auth, device } = authBody(body)
    if (!api.resolve(auth, device).length) throw new ProofRouteError(401, 'no valid identity: the session token is invalid or expired and no valid device id was sent')
    const out = api.proof(Number(m[1]), auth, device)
    if (!out) throw new ProofRouteError(404, 'no such epoch')
    return { status: 200, body: { proofs: out } }
  }

  m = LEAVES_RE.exec(p)
  if (m) {
    if (!isGet) throw new ProofRouteError(405, 'method not allowed')
    const index = Number(m[1])
    const out = api.leavesJson(index)
    if (!out) throw new ProofRouteError(404, 'no such epoch')
    // closed epochs never change: serialized once, served with a validator, cached hard
    return { status: 200, body: null, text: out.text, etag: out.etag, maxAge: 3600 }
  }

  m = INDEX_RE.exec(p)
  if (m) {
    if (!isGet) throw new ProofRouteError(405, 'method not allowed')
    const h = api.header(Number(m[1]))
    if (!h) throw new ProofRouteError(404, 'no such epoch')
    return { status: 200, body: { header: h }, maxAge: 3600 }
  }

  throw new ProofRouteError(404, 'not found')
}
