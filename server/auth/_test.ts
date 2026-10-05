// Self-checks for wallet sign-in (nonce → signed message → token).
//
//   npx tsx server/auth/_test.ts
//
// Exits non-zero on the first failed assertion. Uses a throwaway data dir under the OS temp dir
// (or LUSCA_TEST_DIR) and throwaway ed25519 keys; nothing touches a network.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { base58Encode } from '../../shared/base58.ts'
import {
  AuthError,
  NONCE_TTL_MS,
  TOKEN_TTL_MS,
  createAuth,
  handleAuthRoute,
  normalizeHost,
  privateKeyFromSeed,
  rawPublicKey,
  signEd25519,
  signInMessage,
  verifyEd25519,
  type Auth,
} from './index.ts'

let passed = 0
function ok(cond: unknown, what: string): asserts cond {
  if (!cond) {
    console.error(`FAIL ${what}`)
    process.exit(1)
  }
  passed++
}
function throwsAuth(fn: () => unknown, status: number, re: RegExp, what: string) {
  try {
    fn()
  } catch (e) {
    ok(e instanceof AuthError, `${what}: AuthError (got ${(e as Error)?.message})`)
    ok(e.status === status, `${what}: status ${status} (got ${e.status})`)
    ok(re.test(e.message), `${what}: message ${re} (got "${e.message}")`)
    return
  }
  ok(false, `${what}: expected to throw`)
}

const root = process.env.LUSCA_TEST_DIR || path.join(os.tmpdir(), 'lusca-auth-test')
const runDir = path.join(root, `run-${process.pid}-${Date.now()}`)
fs.mkdirSync(runDir, { recursive: true })
let dirN = 0
const freshDir = () => {
  const d = path.join(runDir, `d${dirN++}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}
const quiet = () => {}

interface Wallet {
  key: KeyObject
  address: string
}
function newWallet(): Wallet {
  const { privateKey } = generateKeyPairSync('ed25519')
  return { key: privateKey, address: base58Encode(rawPublicKey(privateKey)) }
}
const sign = (w: Wallet, message: string) => signEd25519(new TextEncoder().encode(message), w.key)
const b58 = (b: Uint8Array) => base58Encode(b)
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

let clock = Date.UTC(2026, 9, 5, 12, 0, 0)
const now = () => clock
const mk = (extra: Partial<Parameters<typeof createAuth>[0]> = {}): Auth =>
  createAuth({ dataDir: freshDir(), secret: 'x'.repeat(40), log: quiet, now, noncesPerMin: 1000, verifiesPerMin: 1000, ...extra })

const HOST = 'localhost:8800'
const IP = '127.0.0.1'

// ─── ed25519 helpers ─────────────────────────────────────────────────────────
{
  const w = newWallet()
  const msg = new TextEncoder().encode('hello')
  const sig = signEd25519(msg, w.key)
  ok(sig.length === 64, 'signature is 64 bytes')
  ok(verifyEd25519(msg, sig, rawPublicKey(w.key)), 'verify own signature')
  ok(!verifyEd25519(new TextEncoder().encode('hellp'), sig, rawPublicKey(w.key)), 'reject other message')
  ok(!verifyEd25519(msg, sig.slice(0, 63), rawPublicKey(w.key)), 'reject 63-byte signature')
  // Solana keypair file layout: seed (32) ‖ public key (32)
  const seed = new Uint8Array(randomBytes(32))
  const k = privateKeyFromSeed(seed)
  const k2 = privateKeyFromSeed(seed)
  ok(Buffer.from(rawPublicKey(k)).equals(Buffer.from(rawPublicKey(k2))), 'seed → deterministic key')
  ok(verifyEd25519(msg, signEd25519(msg, k), rawPublicKey(k)), 'seed key signs')
}

// ─── host normalization ──────────────────────────────────────────────────────
ok(normalizeHost('Lusca.OnRender.com') === 'lusca.onrender.com', 'host lowercased')
ok(normalizeHost('https://lusca.onrender.com/') === 'lusca.onrender.com', 'host from URL form')
ok(normalizeHost('localhost:8800') === 'localhost:8800', 'host with port')
ok(normalizeHost('localhost:99999') === null, 'port out of range')
ok(normalizeHost('evil.com/x') === null, 'host with path rejected')
ok(normalizeHost('a b') === null, 'host with space rejected')
ok(normalizeHost('evil.com\nNonce: 00') === null, 'host with newline rejected')
ok(normalizeHost(undefined) === null, 'missing host')

// ─── exact message ───────────────────────────────────────────────────────────
{
  const m = signInMessage('lusca.onrender.com', 'WALLET', 'abc', '2026-10-05T12:00:00.000Z')
  ok(
    m ===
      'lusca.onrender.com wants you to sign in with your Solana account:\nWALLET\n\n' +
        'Link this wallet to LUSCA to receive SOL payouts for verified GPU work. This is not a transaction and costs nothing.\n\n' +
        'URI: https://lusca.onrender.com\nVersion: 1\nNonce: abc\nIssued At: 2026-10-05T12:00:00.000Z\n' +
        'Expiration Time: 2026-10-05T12:05:00.000Z',
    'exact sign-in message',
  )
}

// ─── valid signature (base58 and base64) ─────────────────────────────────────
{
  const auth = mk()
  const w = newWallet()
  const n = auth.issueNonce(w.address, HOST, IP)
  ok(/^[0-9a-f]{32}$/.test(n.nonce), 'nonce is 16 bytes hex')
  ok(n.expiresAt === clock + NONCE_TTL_MS, 'nonce TTL 5 min')
  ok(n.message === signInMessage(HOST, w.address, n.nonce, new Date(clock).toISOString()), 'message matches template')
  const s = auth.verify({ wallet: w.address, nonce: n.nonce, signature: b58(sign(w, n.message)) }, IP)
  ok(s.wallet === w.address, 'session wallet')
  ok(s.expiresAt === clock + TOKEN_TTL_MS, 'token TTL 30 d')
  const claims = auth.checkToken(s.token)
  ok(claims?.wallet === w.address && claims.exp === s.expiresAt, 'token round-trips')

  const n2 = auth.issueNonce(w.address, HOST, IP)
  const s2 = auth.verify({ wallet: w.address, nonce: n2.nonce, signature: b64(sign(w, n2.message)) }, IP)
  ok(auth.checkToken(s2.token)?.wallet === w.address, 'base64 signature accepted')

  const n3 = auth.issueNonce(w.address, HOST, IP)
  const sig3 = Buffer.from(sign(w, n3.message)).toString('base64url')
  ok(auth.verify({ wallet: w.address, nonce: n3.nonce, signature: sig3 }, IP).wallet === w.address, 'base64url signature accepted')

  // reused nonce
  throwsAuth(() => auth.verify({ wallet: w.address, nonce: n.nonce, signature: b58(sign(w, n.message)) }, IP), 400, /unknown or already used/, 'reused nonce')
}

// ─── wrong wallet ────────────────────────────────────────────────────────────
{
  const auth = mk()
  const a = newWallet()
  const b = newWallet()
  // nonce for A, signed by B, claimed as A
  const n = auth.issueNonce(a.address, HOST, IP)
  throwsAuth(() => auth.verify({ wallet: a.address, nonce: n.nonce, signature: b58(sign(b, n.message)) }, IP), 401, /does not match/, 'signature by another key')
  // the failed attempt burned the nonce
  throwsAuth(() => auth.verify({ wallet: a.address, nonce: n.nonce, signature: b58(sign(a, n.message)) }, IP), 400, /unknown or already used/, 'nonce single use after failure')
  // nonce for A, presented as B (with B's signature over A's message)
  const n2 = auth.issueNonce(a.address, HOST, IP)
  throwsAuth(() => auth.verify({ wallet: b.address, nonce: n2.nonce, signature: b58(sign(b, n2.message)) }, IP), 400, /different wallet/, 'nonce for another wallet')
  // signature over a different message (another nonce's) is rejected
  const n3 = auth.issueNonce(a.address, HOST, IP)
  const n4 = auth.issueNonce(a.address, HOST, IP)
  throwsAuth(() => auth.verify({ wallet: a.address, nonce: n3.nonce, signature: b58(sign(a, n4.message)) }, IP), 401, /does not match/, 'signature over another message')
}

// ─── expired nonce ───────────────────────────────────────────────────────────
{
  const auth = mk()
  const w = newWallet()
  const n = auth.issueNonce(w.address, HOST, IP)
  const sig = b58(sign(w, n.message))
  clock += NONCE_TTL_MS + 1
  throwsAuth(() => auth.verify({ wallet: w.address, nonce: n.nonce, signature: sig }, IP), 400, /expired|unknown/, 'expired nonce')
  // just inside the TTL still works
  const n2 = auth.issueNonce(w.address, HOST, IP)
  clock += NONCE_TTL_MS - 1
  ok(auth.verify({ wallet: w.address, nonce: n2.nonce, signature: b58(sign(w, n2.message)) }, IP).wallet === w.address, 'nonce valid until TTL')
  // sweep drops expired entries before they are looked up
  const n3 = auth.issueNonce(w.address, HOST, IP)
  clock += NONCE_TTL_MS + 1
  auth.issueNonce(w.address, HOST, IP) // triggers sweep
  throwsAuth(() => auth.verify({ wallet: w.address, nonce: n3.nonce, signature: b58(sign(w, n3.message)) }, IP), 400, /unknown/, 'swept nonce')
}

// ─── tampered / foreign / expired tokens ─────────────────────────────────────
{
  const auth = mk()
  const w = newWallet()
  const other = newWallet()
  const { token } = auth.issueToken(w.address)
  ok(auth.checkToken(token)?.wallet === w.address, 'issued token valid')
  const [p, m] = token.split('.')
  const forged = Buffer.from(JSON.stringify({ w: other.address, exp: clock + TOKEN_TTL_MS }), 'utf8').toString('base64url')
  ok(auth.checkToken(`${forged}.${m}`) === null, 'payload swapped → invalid')
  const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
  ok(auth.checkToken(`${p}.${flip(m)}`) === null, 'mac flipped → invalid')
  ok(auth.checkToken(`${p}.${m.slice(0, -2)}`) === null, 'mac truncated → invalid')
  ok(auth.checkToken(`${p}.${m}.x`) === null, 'three parts → invalid')
  ok(auth.checkToken(`${p}`) === null, 'one part → invalid')
  ok(auth.checkToken('') === null && auth.checkToken(null) === null && auth.checkToken(42) === null, 'non-string → invalid')
  ok(auth.checkToken('a'.repeat(600) + '.b') === null, 'oversized → invalid')
  ok(auth.checkToken(`${p}.${m}=`) === null, 'padding char → invalid')
  ok(mk({ secret: 'y'.repeat(40) }).checkToken(token) === null, 'other secret → invalid')
  clock += TOKEN_TTL_MS
  ok(auth.checkToken(token) === null, 'expired token → invalid')
  clock -= TOKEN_TTL_MS
  ok(auth.checkToken(token)?.wallet === w.address, 'still valid before expiry')
  // a correctly MACed payload with a bad wallet / exp is still rejected (defense in depth)
  throwsAuth(() => auth.issueToken('not-a-wallet'), 400, /Solana address/, 'issueToken rejects bad wallet')
}

// ─── bad encodings ───────────────────────────────────────────────────────────
{
  const auth = mk()
  const w = newWallet()
  throwsAuth(() => auth.issueNonce('0OIl' + w.address.slice(4), HOST, IP), 400, /Solana address/, 'non-base58 wallet')
  throwsAuth(() => auth.issueNonce(base58Encode(new Uint8Array(31).fill(7)), HOST, IP), 400, /Solana address/, '31-byte wallet')
  throwsAuth(() => auth.issueNonce(base58Encode(new Uint8Array(33).fill(7)), HOST, IP), 400, /Solana address/, '33-byte wallet')
  throwsAuth(() => auth.issueNonce('1' + w.address, HOST, IP), 400, /Solana address/, 'non-canonical wallet')
  throwsAuth(() => auth.issueNonce(undefined, HOST, IP), 400, /Solana address/, 'missing wallet')
  throwsAuth(() => auth.issueNonce(['x'], HOST, IP), 400, /Solana address/, 'array wallet')
  const n = auth.issueNonce(w.address, HOST, IP)
  const sig = sign(w, n.message)
  throwsAuth(() => auth.verify(null, IP), 400, /JSON object/, 'null body')
  throwsAuth(() => auth.verify([1], IP), 400, /JSON object/, 'array body')
  throwsAuth(() => auth.verify({ wallet: w.address, nonce: 'zz', signature: b58(sig) }, IP), 400, /nonce/, 'nonce not hex')
  throwsAuth(() => auth.verify({ wallet: w.address, nonce: n.nonce.toUpperCase(), signature: b58(sig) }, IP), 400, /nonce/, 'nonce uppercase')
  // 63 bytes as base58 is ~86 chars of the base64 alphabet too, which decodes to 64 bytes: rejected
  // either as malformed (400) or as a bad signature (401) — never accepted. Use a fresh nonce.
  {
    const nx = auth.issueNonce(w.address, HOST, IP)
    try {
      auth.verify({ wallet: w.address, nonce: nx.nonce, signature: b58(sign(w, nx.message).slice(0, 63)) }, IP)
      ok(false, '63-byte signature (base58) rejected')
    } catch (e) {
      ok(e instanceof AuthError && (e.status === 400 || e.status === 401), '63-byte signature (base58) rejected')
    }
  }
  throwsAuth(() => auth.verify({ wallet: w.address, nonce: n.nonce, signature: b64(new Uint8Array(65)) }, IP), 400, /64 bytes/, '65-byte signature (base64)')
  throwsAuth(() => auth.verify({ wallet: w.address, nonce: n.nonce, signature: '!!!' }, IP), 400, /64 bytes/, 'garbage signature')
  throwsAuth(() => auth.verify({ wallet: w.address, nonce: n.nonce, signature: Array.from(sig) }, IP), 400, /64 bytes/, 'array signature')
  throwsAuth(() => auth.verify({ wallet: w.address, nonce: n.nonce, signature: Buffer.from(sig).toString('hex') }, IP), 400, /64 bytes/, 'hex signature')
  throwsAuth(() => auth.verify({ wallet: 'abc', nonce: n.nonce, signature: b58(sig) }, IP), 400, /Solana address/, 'bad wallet on verify')
  // none of the malformed attempts consumed the nonce
  ok(auth.verify({ wallet: w.address, nonce: n.nonce, signature: b58(sig) }, IP).wallet === w.address, 'nonce survives malformed attempts')
}

// ─── host ────────────────────────────────────────────────────────────────────
{
  const auth = mk()
  const w = newWallet()
  throwsAuth(() => auth.issueNonce(w.address, 'evil.com/x', IP), 400, /Host/, 'bad Host header')
  throwsAuth(() => auth.issueNonce(w.address, undefined, IP), 400, /Host/, 'missing Host header')
  const n = auth.issueNonce(w.address, 'LocalHost:8800', IP)
  ok(n.message.startsWith('localhost:8800 wants you to sign in'), 'request Host normalized into message')
  // the wallet signed a message naming another host (phishing site relaying our nonce) → rejected
  const phished = n.message.replace(/^localhost:8800 /, 'lusca-login.example ')
  throwsAuth(() => auth.verify({ wallet: w.address, nonce: n.nonce, signature: b58(sign(w, phished)) }, IP), 401, /does not match/, 'signature over wrong host')

  const pinned = mk({ publicHost: 'https://Lusca.OnRender.com/' })
  ok(pinned.hostFor('evil.com') === 'lusca.onrender.com', 'LUSCA_PUBLIC_HOST overrides request Host')
  const pn = pinned.issueNonce(w.address, 'evil.com', IP)
  ok(pn.message.startsWith('lusca.onrender.com wants you to sign in with your Solana account:\n'), 'pinned host in message')
  const pinnedNoHeader = pinned.issueNonce(w.address, undefined, IP)
  ok(pinnedNoHeader.message.startsWith('lusca.onrender.com '), 'pinned host without Host header')
  ok(pinned.verify({ wallet: w.address, nonce: pn.nonce, signature: b58(sign(w, pn.message)) }, IP).wallet === w.address, 'pinned host verifies')
  const badPin = mk({ publicHost: 'bad host!' })
  ok(badPin.hostFor('localhost:8800') === 'localhost:8800', 'invalid LUSCA_PUBLIC_HOST falls back to request Host')
}

// ─── rate limits ─────────────────────────────────────────────────────────────
{
  const auth = mk({ noncesPerMin: 3, verifiesPerMin: 2 })
  const w = newWallet()
  for (let i = 0; i < 3; i++) auth.issueNonce(w.address, HOST, '10.0.0.1')
  throwsAuth(() => auth.issueNonce(w.address, HOST, '10.0.0.1'), 429, /retry in/, 'nonce rate limit')
  auth.issueNonce(w.address, HOST, '10.0.0.2') // other address unaffected
  clock += 60_001
  auth.issueNonce(w.address, HOST, '10.0.0.1') // window slid
  const body = { wallet: w.address, nonce: '0'.repeat(32), signature: b58(new Uint8Array(64)) }
  for (let i = 0; i < 2; i++) throwsAuth(() => auth.verify(body, '10.0.0.3'), 400, /unknown/, `verify attempt ${i}`)
  throwsAuth(() => auth.verify(body, '10.0.0.3'), 429, /retry in/, 'verify rate limit')
}

// ─── nonce store bound (LRU, 10k) ────────────────────────────────────────────
{
  const auth = mk({ noncesPerMin: 1_000_000 })
  const w = newWallet()
  const first = auth.issueNonce(w.address, HOST, IP)
  const sig = b58(sign(w, first.message))
  for (let i = 0; i < 10_000; i++) auth.issueNonce(w.address, HOST, IP)
  throwsAuth(() => auth.verify({ wallet: w.address, nonce: first.nonce, signature: sig }, IP), 400, /unknown/, 'oldest nonce evicted past 10k')
  const last = auth.issueNonce(w.address, HOST, IP)
  ok(auth.verify({ wallet: w.address, nonce: last.nonce, signature: b58(sign(w, last.message)) }, IP).wallet === w.address, 'newest nonce kept')
}

// ─── secret: env vs <dataDir>/auth.secret ────────────────────────────────────
{
  const dir = freshDir()
  const a1 = createAuth({ dataDir: dir, log: quiet, now })
  ok(a1.secretSource === 'file', 'generated secret source = file')
  const file = path.join(dir, 'auth.secret')
  ok(fs.existsSync(file), 'auth.secret written')
  ok(/^[0-9a-f]{64}\n?$/.test(fs.readFileSync(file, 'utf8')), 'auth.secret is 32 bytes hex')
  if (process.platform !== 'win32') ok((fs.statSync(file).mode & 0o777) === 0o600, 'auth.secret mode 0600')
  const w = newWallet()
  const { token } = a1.issueToken(w.address)
  const a2 = createAuth({ dataDir: dir, log: quiet, now })
  ok(a2.checkToken(token)?.wallet === w.address, 'secret reused across restarts')
  const a3 = createAuth({ dataDir: dir, secret: 's'.repeat(40), log: quiet, now })
  ok(a3.secretSource === 'env' && a3.checkToken(token) === null, 'env secret takes precedence')
  const logs: string[] = []
  const a4 = createAuth({ dataDir: dir, secret: 'short', log: (_l, m) => logs.push(m), now })
  ok(a4.secretSource === 'file' && logs.some((m) => /shorter than 16/.test(m)), 'short env secret ignored')
  ok(!logs.some((m) => m.includes('short') && m.includes(fs.readFileSync(file, 'utf8').trim())), 'secret never logged')
  // corrupt file is moved aside and replaced
  const dir2 = freshDir()
  fs.writeFileSync(path.join(dir2, 'auth.secret'), 'not hex')
  const a5 = createAuth({ dataDir: dir2, log: quiet, now })
  ok(a5.secretSource === 'file' && /^[0-9a-f]{64}/.test(fs.readFileSync(path.join(dir2, 'auth.secret'), 'utf8')), 'corrupt secret replaced')
}

// ─── route helper ────────────────────────────────────────────────────────────
{
  const auth = mk()
  const w = newWallet()
  const q = (s: string) => new URLSearchParams(s)
  ok(handleAuthRoute(auth, { method: 'GET', pathname: '/api/payouts', query: q(''), host: HOST, ip: IP }) === null, 'other paths → null')
  const r405 = handleAuthRoute(auth, { method: 'POST', pathname: '/api/auth/nonce', query: q(''), host: HOST, ip: IP })
  ok(r405?.status === 405 && r405.allow === 'GET, HEAD', 'nonce 405')
  const rBad = handleAuthRoute(auth, { method: 'GET', pathname: '/api/auth/nonce', query: q('wallet=xyz'), host: HOST, ip: IP })
  ok(rBad?.status === 400 && typeof (rBad.body as { error?: string }).error === 'string', 'nonce 400 → {error}')
  const rn = handleAuthRoute(auth, { method: 'GET', pathname: '/api/auth/nonce', query: q(`wallet=${w.address}`), host: HOST, ip: IP })
  ok(rn?.status === 200, 'nonce 200')
  const nb = rn.body as { nonce: string; message: string }
  const rv = handleAuthRoute(auth, {
    method: 'POST',
    pathname: '/api/auth/verify',
    query: q(''),
    host: HOST,
    ip: IP,
    body: { wallet: w.address, nonce: nb.nonce, signature: b58(sign(w, nb.message)) },
  })
  ok(rv?.status === 200 && auth.checkToken((rv.body as { token: string }).token)?.wallet === w.address, 'verify 200 → token')
  const rv405 = handleAuthRoute(auth, { method: 'GET', pathname: '/api/auth/verify', query: q(''), host: HOST, ip: IP })
  ok(rv405?.status === 405 && rv405.allow === 'POST', 'verify 405')
}

try {
  fs.rmSync(runDir, { recursive: true, force: true })
} catch {
  /* temp dir cleanup is best effort */
}
console.log(`auth: ${passed} checks passed`)
