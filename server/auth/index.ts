// Public surface of server/auth for the HTTP / WS wiring.
//
//   const auth = authFromEnv(dataDir, log)          // LUSCA_AUTH_SECRET, LUSCA_PUBLIC_HOST
//   const r = handleAuthRoute(auth, { method, pathname, query, host, ip, body })
//   if (r) send r.status + JSON r.body             // null = not an /api/auth route
//   auth.checkToken(msg.auth)?.wallet               // on neuron.register

import { AuthError, createAuth, type Auth } from './auth.ts'

export { AuthError, createAuth, normalizeHost, signInMessage, signatureCandidates, NONCE_TTL_MS, TOKEN_TTL_MS } from './auth.ts'
export type { Auth, AuthOptions, TokenClaims } from './auth.ts'
export { publicKeyFromRaw32, privateKeyFromSeed, rawPublicKey, signEd25519, verifyEd25519 } from './ed25519.ts'

type LogFn = (level: 'info' | 'warn' | 'error', msg: string) => void

/** createAuth with LUSCA_AUTH_SECRET / LUSCA_PUBLIC_HOST from the environment. */
export function authFromEnv(dataDir: string, log?: LogFn, env: NodeJS.ProcessEnv = process.env): Auth {
  return createAuth({
    dataDir,
    secret: env.LUSCA_AUTH_SECRET ?? null,
    publicHost: env.LUSCA_PUBLIC_HOST ?? null,
    log,
  })
}

export interface AuthRouteRequest {
  method: string | undefined
  pathname: string
  /** Query parameters (only `wallet` is read). */
  query: URLSearchParams
  /** Raw Host header. */
  host: string | undefined
  /** Client address (after trusted-proxy resolution) for rate limiting. */
  ip: string
  /** Parsed JSON body for POST (undefined/null when absent or unparseable). */
  body?: unknown
}

export interface AuthRouteResponse {
  status: number
  body: unknown
  /** Allow header for 405 responses. */
  allow?: string
}

/**
 * GET /api/auth/nonce?wallet=… and POST /api/auth/verify. Returns null for any other path.
 * Errors become { status, body: { error } } — messages are safe to show to users.
 */
export function handleAuthRoute(auth: Auth, req: AuthRouteRequest): AuthRouteResponse | null {
  const method = (req.method ?? 'GET').toUpperCase()
  try {
    if (req.pathname === '/api/auth/nonce') {
      if (method !== 'GET' && method !== 'HEAD') return { status: 405, body: { error: 'use GET' }, allow: 'GET, HEAD' }
      return { status: 200, body: auth.issueNonce(req.query.get('wallet'), req.host, req.ip) }
    }
    if (req.pathname === '/api/auth/verify') {
      if (method !== 'POST') return { status: 405, body: { error: 'use POST' }, allow: 'POST' }
      return { status: 200, body: auth.verify(req.body, req.ip) }
    }
    return null
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } }
    throw e
  }
}
