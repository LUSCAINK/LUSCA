// Wallet ownership proof (Sign-In With Solana style) and the session tokens that link a
// neuron's INK to a verified wallet.
//
//   GET  /api/auth/nonce?wallet=<base58>  → { nonce, message, expiresAt }
//   POST /api/auth/verify { wallet, nonce, signature } → { token, wallet, expiresAt }
//
// The wallet signs one plain-text message (not a transaction; it costs nothing). Nonces are
// 16 random bytes (hex), single use, valid 5 minutes, kept in memory (at most 10k, oldest
// dropped first) and rate-limited per client address. The signature is checked with
// node:crypto ed25519 against the 32-byte wallet key; it may be sent as base58 or base64 and
// must decode to exactly 64 bytes.
//
// Token = base64url(JSON {w, exp}) "." base64url(HMAC-SHA256(secret, first part)), valid 30
// days, compared in constant time. Secret: LUSCA_AUTH_SECRET, else <dataDir>/auth.secret
// (32 random bytes, hex, created once with mode 0600). Rotating the secret signs everyone out.

import fs from 'node:fs'
import path from 'node:path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AuthNonce, AuthSession } from '../../shared/payouts.ts'
import { base58Decode, isSolanaAddress, solanaAddressBytes } from '../../shared/base58.ts'
import { verifyEd25519 } from './ed25519.ts'

type LogFn = (level: 'info' | 'warn' | 'error', msg: string) => void

export const NONCE_TTL_MS = 5 * 60_000
export const TOKEN_TTL_MS = 30 * 86_400_000
const MAX_NONCES = 10_000
const RATE_WINDOW_MS = 60_000
const MAX_TOKEN_LEN = 512

export class AuthError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface AuthOptions {
  /** <dataDir>/auth.secret holds the generated secret when `secret` is not given. */
  dataDir: string
  /** LUSCA_AUTH_SECRET (≥ 16 characters; 32+ recommended). */
  secret?: string | null
  /** LUSCA_PUBLIC_HOST, e.g. "lusca.ink"; default: the request Host header. */
  publicHost?: string | null
  log?: LogFn
  /** Clock (tests). */
  now?: () => number
  /** Nonces issued per client address per minute (default 20). */
  noncesPerMin?: number
  /** Verify attempts per client address per minute (default 30). */
  verifiesPerMin?: number
}

export interface TokenClaims {
  wallet: string
  exp: number
}

export interface Auth {
  /** Host named in the sign-in message for a request with this Host header (null = not a plausible host). */
  hostFor(requestHost: string | undefined): string | null
  /** Issue a single-use nonce + the exact message to sign. Throws AuthError. */
  issueNonce(wallet: unknown, requestHost: string | undefined, ip: string): AuthNonce
  /** Check a signed nonce; returns a session token. Throws AuthError. */
  verify(body: unknown, ip: string): AuthSession
  /** Claims of a valid, unexpired token, else null. Never throws. */
  checkToken(token: unknown): TokenClaims | null
  /** Mint a token for a wallet that has already proven ownership (tests and internal use). */
  issueToken(wallet: string): AuthSession
  /** Where the secret came from ('env' | 'file'), for the startup log. */
  readonly secretSource: 'env' | 'file'
}

/** The exact UTF-8 message a wallet signs. */
export function signInMessage(host: string, wallet: string, nonce: string, issuedAtIso: string, expirationIso?: string): string {
  // Sign-In With Solana (CAIP-122) layout: wallets such as Phantom parse messages that start with
  // "<domain> wants you to sign in…" and refuse any that break the format (the statement must be a
  // single line; URI and Version are required). Phantom also checks the domain against the page.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
  const exp = expirationIso ?? new Date(Date.parse(issuedAtIso) + NONCE_TTL_MS).toISOString()
  return [
    `${host} wants you to sign in with your Solana account:`,
    wallet,
    '',
    'Link this wallet to LUSCA to receive SOL payouts for verified GPU work. This is not a transaction and costs nothing.',
    '',
    `URI: ${local ? 'http' : 'https'}://${host}`,
    'Version: 1',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAtIso}`,
    `Expiration Time: ${exp}`,
  ].join('\n')
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::(\d{1,5}))?$/

/** "Host[:port]" → normalized lowercase host, or null when it is not a plausible hostname[:port]. */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim().toLowerCase()
  // LUSCA_PUBLIC_HOST may be given as a URL
  s = s.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!s || s.length > 260) return null
  const m = HOST_RE.exec(s)
  if (!m) return null
  const hostname = m[1] !== undefined ? s.slice(0, s.lastIndexOf(':')) : s
  if (hostname.length > 253) return null
  if (m[1] !== undefined) {
    const port = Number(m[1])
    if (!(port >= 1 && port <= 65535)) return null
  }
  return s
}

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url')

/** 64-byte signature candidates from base58 and/or base64 text (both are tried; ambiguity is harmless). */
export function signatureCandidates(sig: unknown): Uint8Array[] {
  if (typeof sig !== 'string') return []
  const s = sig.trim()
  if (!s || s.length > 128) return []
  const out: Uint8Array[] = []
  const b58 = base58Decode(s)
  if (b58 && b58.length === 64) out.push(b58)
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) || /^[A-Za-z0-9_-]+={0,2}$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    if (b.length === 64 && !out.some((x) => Buffer.from(x).equals(b))) out.push(new Uint8Array(b))
  }
  return out
}

function loadSecret(dataDir: string, envSecret: string | null | undefined, log: LogFn): { key: Buffer; source: 'env' | 'file' } {
  const env = typeof envSecret === 'string' ? envSecret.trim() : ''
  if (env) {
    if (env.length >= 16) {
      if (env.length < 32) log('warn', 'LUSCA_AUTH_SECRET is shorter than 32 characters; use a longer random value')
      return { key: Buffer.from(env, 'utf8'), source: 'env' }
    }
    log('error', 'LUSCA_AUTH_SECRET is shorter than 16 characters and is ignored; using the data-dir secret')
  }
  const file = path.join(dataDir, 'auth.secret')
  const read = (): Buffer | null => {
    try {
      const txt = fs.readFileSync(file, 'utf8').trim()
      return /^[0-9a-f]{64,}$/i.test(txt) ? Buffer.from(txt, 'hex') : null
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }
  const existing = read()
  if (existing) return { key: existing, source: 'file' }
  if (fs.existsSync(file)) {
    const aside = `${file}.invalid-${Date.now()}`
    fs.renameSync(file, aside)
    log('error', `auth.secret was not a hex secret; moved to ${path.basename(aside)} and generated a new one (existing sign-ins are invalid)`)
  }
  fs.mkdirSync(dataDir, { recursive: true })
  const key = randomBytes(32)
  try {
    fs.writeFileSync(file, key.toString('hex') + '\n', { flag: 'wx', mode: 0o600 })
    log('info', 'generated a new auth secret in the data directory (auth.secret, mode 0600); set LUSCA_AUTH_SECRET in production')
    return { key, source: 'file' }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    const raced = read()
    if (!raced) throw new Error('auth.secret appeared concurrently but is unreadable')
    return { key: raced, source: 'file' }
  }
}

/** Hard cap on tracked keys per limiter; the least recently used key is evicted first. */
const MAX_LIMITER_KEYS = 50_000

/** Sliding-window counter per key. Idle keys are swept at most once per window, never per call. */
function windowLimiter(windowMs: number, max: number, now: () => number) {
  const hits = new Map<string, number[]>()
  let sweptAt = 0
  return {
    take(key: string): number {
      const t = now()
      if (t - sweptAt >= windowMs) {
        sweptAt = t
        for (const [k, v] of hits) if (!v.length || v[v.length - 1] <= t - windowMs) hits.delete(k)
      }
      const ts = (hits.get(key) ?? []).filter((x) => x > t - windowMs)
      hits.delete(key) // re-insert below: Map order = least recently used first
      if (ts.length >= max) {
        hits.set(key, ts)
        return ts[0] + windowMs - t
      }
      ts.push(t)
      hits.set(key, ts)
      while (hits.size > MAX_LIMITER_KEYS) hits.delete(hits.keys().next().value as string)
      return 0
    },
  }
}

/** "a:b:c:d::/64" → "a:b:c::/48"; IPv4 and other keys unchanged. One /48 holds 65,536 /64s. */
function coarseKey(ip: string): string {
  const m = /^([0-9a-f]+:[0-9a-f]+:[0-9a-f]+):[0-9a-f]+::\/64$/i.exec(ip)
  return m ? `${m[1]}::/48` : ip
}

interface NonceEntry {
  wallet: string
  message: string
  expiresAt: number
}

export function createAuth(opts: AuthOptions): Auth {
  const log: LogFn = opts.log ?? ((level, msg) => (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[auth] ${msg}`))
  const now = opts.now ?? Date.now
  const { key: secret, source } = loadSecret(opts.dataDir, opts.secret, log)
  let publicHost: string | null = null
  if (opts.publicHost && opts.publicHost.trim()) {
    publicHost = normalizeHost(opts.publicHost)
    if (!publicHost) log('error', 'LUSCA_PUBLIC_HOST is not a plausible hostname[:port]; using the request Host header instead')
  }
  if (!publicHost) log('warn', 'LUSCA_PUBLIC_HOST is unset: the sign-in message names the request Host header; set it to the public hostname in production')
  const nonces = new Map<string, NonceEntry>() // insertion order = expiry order (one TTL)
  const perIp = Math.max(1, opts.noncesPerMin ?? 20)
  const nonceLimit = windowLimiter(RATE_WINDOW_MS, perIp, now)
  // A /48 may issue 4× the per-/64 rate; all clients together stay below MAX_NONCES per TTL, so
  // outstanding nonces are never evicted before they expire.
  const nonceLimit48 = windowLimiter(RATE_WINDOW_MS, perIp * 4, now)
  const nonceLimitAll = windowLimiter(RATE_WINDOW_MS, Math.max(perIp, Math.floor((MAX_NONCES * 0.75 * RATE_WINDOW_MS) / NONCE_TTL_MS)), now)
  const verifyLimit = windowLimiter(RATE_WINDOW_MS, Math.max(1, opts.verifiesPerMin ?? 30), now)

  function sweep(t: number) {
    for (const [k, v] of nonces) {
      if (v.expiresAt > t) break
      nonces.delete(k)
    }
  }

  function hostFor(requestHost: string | undefined): string | null {
    return publicHost ?? normalizeHost(requestHost)
  }

  function mac(payloadB64: string): Buffer {
    return createHmac('sha256', secret).update(payloadB64).digest()
  }

  function issueToken(wallet: string): AuthSession {
    if (!isSolanaAddress(wallet)) throw new AuthError(400, 'wallet must be a Solana address (base58, 32 bytes)')
    const exp = now() + TOKEN_TTL_MS
    const p = b64url(Buffer.from(JSON.stringify({ w: wallet, exp }), 'utf8'))
    return { token: `${p}.${b64url(mac(p))}`, wallet, expiresAt: exp }
  }

  function checkToken(token: unknown): TokenClaims | null {
    try {
      if (typeof token !== 'string' || token.length > MAX_TOKEN_LEN) return null
      const parts = token.split('.')
      if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null
      const given = Buffer.from(parts[1], 'base64url')
      const want = mac(parts[0])
      if (given.length !== want.length || !timingSafeEqual(given, want)) return null
      const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { w?: unknown; exp?: unknown }
      if (!claims || typeof claims !== 'object') return null
      if (!isSolanaAddress(claims.w)) return null
      if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now()) return null
      return { wallet: claims.w, exp: claims.exp }
    } catch {
      return null
    }
  }

  function issueNonce(walletRaw: unknown, requestHost: string | undefined, ip: string): AuthNonce {
    const wallet = typeof walletRaw === 'string' ? walletRaw.trim() : ''
    if (!isSolanaAddress(wallet)) throw new AuthError(400, 'wallet must be a Solana address (base58, 32 bytes)')
    const host = hostFor(requestHost)
    if (!host) throw new AuthError(400, 'unexpected Host header')
    const k = ip || 'unknown'
    const wait = nonceLimit.take(k) || nonceLimit48.take(coarseKey(k)) || nonceLimitAll.take('*')
    if (wait > 0) throw new AuthError(429, `too many sign-in requests — retry in ${Math.ceil(wait / 1000)} s`)
    const t = now()
    sweep(t)
    while (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value as string)
    const nonce = randomBytes(16).toString('hex')
    const expiresAt = t + NONCE_TTL_MS
    const message = signInMessage(host, wallet, nonce, new Date(t).toISOString())
    nonces.set(nonce, { wallet, message, expiresAt })
    return { nonce, message, expiresAt }
  }

  function verify(bodyRaw: unknown, ip: string): AuthSession {
    if (!bodyRaw || typeof bodyRaw !== 'object' || Array.isArray(bodyRaw)) throw new AuthError(400, 'expected a JSON object')
    const body = bodyRaw as { wallet?: unknown; nonce?: unknown; signature?: unknown }
    const wait = verifyLimit.take(ip || 'unknown')
    if (wait > 0) throw new AuthError(429, `too many sign-in attempts — retry in ${Math.ceil(wait / 1000)} s`)
    const wallet = typeof body.wallet === 'string' ? body.wallet.trim() : ''
    const walletBytes = isSolanaAddress(wallet) ? solanaAddressBytes(wallet) : null
    if (!walletBytes) throw new AuthError(400, 'wallet must be a Solana address (base58, 32 bytes)')
    const nonce = typeof body.nonce === 'string' ? body.nonce.trim() : ''
    if (!/^[0-9a-f]{32}$/.test(nonce)) throw new AuthError(400, 'nonce must be 32 hex characters')
    const sigs = signatureCandidates(body.signature)
    if (!sigs.length) throw new AuthError(400, 'signature must be 64 bytes, base58 or base64')
    const entry = nonces.get(nonce)
    if (!entry) throw new AuthError(400, 'unknown or already used nonce — request a new one')
    nonces.delete(nonce) // single use, whatever the outcome
    if (entry.expiresAt <= now()) throw new AuthError(400, 'nonce expired — request a new one')
    if (entry.wallet !== wallet) throw new AuthError(400, 'nonce was issued for a different wallet')
    const msg = new TextEncoder().encode(entry.message)
    if (!sigs.some((s) => verifyEd25519(msg, s, walletBytes))) throw new AuthError(401, 'signature does not match this wallet and message')
    return issueToken(wallet)
  }

  return { hostFor, issueNonce, verify, checkToken, issueToken, secretSource: source }
}
