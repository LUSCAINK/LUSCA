// LUSCA desktop neuron — a headless CPU worker for the coordinator. It trains SEPIA: the server
// sends a batch of corpus text plus the current weights, this program computes the training
// gradient (shared/sepia lossAndGrad, the same code the server audits with) and sends it back;
// the server checks it and applies it with its optimizer. Dedupe (simmatrix) jobs still run too.
//
//   node neuron.mjs --auth <token>                        (public build: dist/neuron.mjs, Node ≥ 20)
//   npx tsx scripts/neuron.ts [--server ws://127.0.0.1:8787/ws] [--label name] [--keypair file | --auth token] [--jobs n] [--plain | --ascii] [--quiet]
//
// `npm run build:neuron` bundles this file and its imports (ws included) into one dependency-free
// ESM file, dist/neuron.mjs, served at https://lusca.ink/neuron.mjs; that build defaults --server
// to wss://lusca.ink/ws. Flags take `--flag value` or `--flag=value`; a bare ws:// url is accepted
// as the server too. Env: LUSCA_WS, or PORT → ws://127.0.0.1:$PORT/ws.
//
//   --server  coordinator websocket          (default ws://127.0.0.1:8787/ws; bundle: wss://lusca.ink/ws)
//   --label   name on the leaderboard        (default "<cpu model> · desktop")
//   --auth    sign-in token from the Node page (verify in your browser wallet; env LUSCA_AUTH).
//             Preferred: no key material on this machine.
//   --keypair a dedicated payout-only keypair JSON (solana-keygen new -o lusca-payout.json), never
//             a wallet that holds funds. Signs the one-line sign-in message locally (no transaction,
//             no cost; the key never leaves this machine) and links credits to that wallet.
//   --wallet  Solana address shown with this neuron; payouts need --keypair or --auth
//   --jobs    exit after n verified jobs     (default: run until Ctrl-C)
//   --device  override the device id used for the ledger (16–64 chars; keep it secret)
//   --plain   plain log lines instead of the live dashboard (env LUSCA_NEURON_PLAIN=1)
//   --ascii   dashboard art in plain half blocks (LUSCA_NEURON_GLYPHS=braille|octant|ascii overrides)
//   --quiet   plain output: only verdict failures and a summary every 25 jobs
//   --no-train  dedupe jobs only (no SEPIA training)
//
// Output: every user-visible fact is a NeuronEvent (scripts/neuron-tui/types.ts) sent to a front-end:
// the live dashboard (scripts/neuron-tui/index.ts) on a TTY of at least 90×26, otherwise plain log
// lines (scripts/neuron-tui/log.ts). NO_COLOR turns colors off. Earnings are shown as credits: the
// user's share of each payout period's SOL pool (the protocol's `ink` fields).
//
// 1. Benchmarks one CPU thread with a JS matmul → median GFLOPS (the server derives the zone),
//    and times one SEPIA gradient on a fixed batch (also checks the f16 gradient codec).
// 2. Connects to the hub websocket and registers as a `desktop` neuron.
// 3. Loops job.request {caps: {train, version}} → job → result:
//      train     → weights (f16, only when the held version is not current) + x/y batch →
//                  lossAndGrad → encodeGrad → train.result
//      simmatrix → bestMatchesCPU (shared/vectorize.ts) → job.result
//    reporting every verdict ('ink' events for our neuron id) as a feed line. Credit totals are
//    the server's: after each registration the neuron sends account.watch {device, auth} and shows
//    the 'account' replies (confirmed all-time, pending in escrow), like the web panel; the session
//    gain is the confirmed total now minus the first reply of this run.
// 4. Handles {t:'error'} (corpus warming up, cool-downs, kicks, full pool) with backoff,
//    reconnects on socket loss, and sends neuron.leave on Ctrl-C.
//
// Verification: dedupe results are re-checked on random rows; every training gradient is
// compared with a server-computed gradient on a random sub-batch, and full audits (the whole
// gradient recomputed from the same weights) run on the first jobs and then at random. Training
// credits are held 'pending' until this identity's next full audit passes ('confirmed'); a failed
// audit forfeits the pending credits. Only confirmed credits count toward payouts: each payout
// period the payout pool is split by credits and paid in SOL to verified wallets.

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { WebSocket } from 'ws'
import { ZONES, zoneFor } from '../shared/protocol.ts'
import type { ClientMsg, InkEvent, NeuronInfo, ServerMsg, SimJob, TrainJob, Zone } from '../shared/protocol.ts'
import { bestMatchesCPU } from '../shared/vectorize.ts'
import { b64ToF32 } from '../shared/b64.ts'
import { base58Decode, base58Encode, isSolanaAddress } from '../shared/base58.ts'
import type { AuthNonce, AuthSession } from '../shared/payouts.ts'
import { privateKeyFromSeed, rawPublicKey, signEd25519 } from '../server/auth/ed25519.ts'
import { SEPIA, cosine, decodeGrad, encodeGrad, f16ToF32, lossAndGrad, trainFlops } from '../shared/sepia/index.mjs'
import { createUI } from './neuron-tui/index.ts'
import { createLogUI, fmtCredits, fmtDur, fmtFlop, shortAddr, shortId } from './neuron-tui/log.ts'
import type { NeuronEvent, NeuronUI } from './neuron-tui/types.ts'

// ─── build constants ─────────────────────────────────────────────────────────

// Replaced by scripts/build-neuron.mjs (esbuild `define`) in the public bundle; under tsx these
// identifiers are undeclared globals, so `typeof` reads 'undefined' and the dev defaults apply.
declare const __LUSCA_DEFAULT_WS__: string
declare const __LUSCA_BUILD__: string
const BUNDLED_WS: string | null = typeof __LUSCA_DEFAULT_WS__ === 'string' ? __LUSCA_DEFAULT_WS__ : null
const BUILD_ID: string = typeof __LUSCA_BUILD__ === 'string' ? __LUSCA_BUILD__ : 'source'
const PROG = BUNDLED_WS ? 'node neuron.mjs' : 'npx tsx scripts/neuron.ts'
const MIN_NODE_MAJOR = 20

// ─── args ────────────────────────────────────────────────────────────────────

interface Args {
  server: string
  label: string | null
  wallet: string | null
  auth: string | null
  keypair: string | null
  device: string | null
  jobs: number
  quiet: boolean
  plain: boolean
  ascii: boolean
  train: boolean
  help: boolean
}

function defaultServer(): string {
  const env = process.env.LUSCA_WS?.trim()
  if (env) return env
  if (BUNDLED_WS && !process.env.PORT?.trim()) return BUNDLED_WS
  return `ws://127.0.0.1:${process.env.PORT?.trim() || '8787'}/ws`
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    server: defaultServer(),
    label: null,
    wallet: null,
    auth: process.env.LUSCA_AUTH?.trim() || null,
    keypair: null,
    device: null,
    jobs: 0,
    quiet: false,
    plain: false,
    ascii: false,
    train: true,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('-')) {
      if (/^wss?:\/\//.test(a)) {
        out.server = a
        continue
      }
      throw new Error(`unexpected argument "${a}" (try --help)`)
    }
    const eq = a.indexOf('=')
    const flag = eq > 0 ? a.slice(0, eq) : a
    const inline = eq > 0 ? a.slice(eq + 1) : undefined
    const val = () => {
      if (inline !== undefined) return inline
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
      i++
      return v
    }
    switch (flag) {
      case '--server':
      case '-s':
        out.server = val()
        break
      case '--label':
      case '-l':
        out.label = val().trim() || null
        break
      case '--wallet':
      case '-w':
        out.wallet = val().trim() || null
        break
      case '--auth':
        out.auth = val().trim() || null
        break
      case '--keypair':
      case '-k':
        out.keypair = val().trim() || null
        break
      case '--device':
        out.device = val().trim() || null
        break
      case '--jobs':
      case '-n': {
        const n = Number(val())
        if (!Number.isInteger(n) || n < 0) throw new Error('--jobs must be a non-negative integer')
        out.jobs = n
        break
      }
      case '--quiet':
      case '-q':
        out.quiet = true
        break
      case '--plain':
        out.plain = true
        break
      case '--ascii':
        out.ascii = true
        break
      case '--no-train':
        out.train = false
        break
      case '--version':
      case '-v':
        process.stdout.write(`lusca-neuron ${BUILD_ID} · node ${process.version}\n`)
        process.exit(0)
        break
      case '--help':
      case '-h':
        out.help = true
        break
      default:
        throw new Error(`unknown flag ${a} (try --help)`)
    }
  }
  if (!/^wss?:\/\//.test(out.server)) throw new Error(`--server must be a ws:// or wss:// url, got ${out.server}`)
  if (out.device && !/^[A-Za-z0-9_-]{16,64}$/.test(out.device)) throw new Error('--device must be 16–64 chars of [A-Za-z0-9_-]')
  if (out.wallet && !isSolanaAddress(out.wallet)) throw new Error('--wallet must be a Solana address (base58, 32 bytes)')
  if (out.auth && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(out.auth)) throw new Error('--auth must be a token from /api/auth/verify')
  return out
}

// ─── output ──────────────────────────────────────────────────────────────────

// Only --help and fatal errors are written here directly; everything else is a NeuronEvent rendered
// by the front-end (scripts/neuron-tui).
const COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string) => (s: string | number) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s))
const dim = paint('2')
const bold = paint('1')
const red = paint('31')

/** The server's texts name the INK token; to the user these amounts are work credits. */
function credText(s: string): string {
  return s.replace(/\bINK ledger\b/g, 'credit ledger').replace(/\$?\bINK\b/g, 'credits')
}

/** LUSCA_NEURON_PLAIN set to anything but an explicit "off" value. */
function plainFromEnv(): boolean {
  const v = process.env.LUSCA_NEURON_PLAIN?.trim() ?? ''
  return v !== '' && !/^(0|false|no|off)$/i.test(v)
}

// ─── CPU benchmark ───────────────────────────────────────────────────────────

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Single-thread FP32 matmul (i-k-j order). Returns median GFLOPS over 5 timed runs. */
function benchmarkCpu(): { gflops: number; n: number; runs: number[] } {
  const N = 256
  const A = new Float32Array(N * N)
  const B = new Float32Array(N * N)
  const C = new Float32Array(N * N)
  for (let i = 0; i < N * N; i++) {
    A[i] = Math.random() - 0.5
    B[i] = Math.random() - 0.5
  }
  const once = () => {
    C.fill(0)
    for (let i = 0; i < N; i++) {
      const co = i * N
      for (let k = 0; k < N; k++) {
        const aik = A[co + k]
        const bo = k * N
        for (let j = 0; j < N; j++) C[co + j] += aik * B[bo + j]
      }
    }
  }
  once() // JIT warm-up
  once()
  const runs: number[] = []
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now()
    once()
    const ms = Math.max(performance.now() - t0, 0.01)
    runs.push((2 * N ** 3) / (ms * 1e6))
  }
  if (!Number.isFinite(C[(N * N) >> 1])) throw new Error('CPU matmul produced non-finite output')
  return { gflops: median(runs), n: N, runs }
}

// ─── SEPIA training helpers ──────────────────────────────────────────────────

/** base64 → a fresh, 0-offset Uint8Array (safe to view as Uint16/Float32). */
function b64Bytes(b64: string): Uint8Array {
  const buf = Buffer.from(b64, 'base64')
  const out = new Uint8Array(buf.length)
  out.set(buf)
  return out
}

function bytesB64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/** base64 f16 weights → Float32Array params (checks size and finiteness). */
function decodeWeights(b64: string): Float32Array {
  const bytes = b64Bytes(b64)
  if (bytes.length !== SEPIA.params * 2) throw new Error(`weights are ${bytes.length} bytes, expected ${SEPIA.params * 2} (f16 × ${SEPIA.params})`)
  const p = f16ToF32(new Uint16Array(bytes.buffer, 0, SEPIA.params))
  for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) throw new Error(`weights hold a non-finite value at ${i}`)
  return p
}

/**
 * Time one gradient on a fixed batch from deterministic small weights and check the f16 gradient
 * codec round-trips (cosine ≥ 0.999). Real work, not a score: it is the same lossAndGrad that runs
 * on every train job, so a broken build stops here instead of failing audits.
 */
function trainSelfCheck(B: number): { ms: number; loss: number; codecCos: number; gflops: number } {
  const n = SEPIA.params
  const params = new Float32Array(n)
  let s = 0x9e3779b9
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = 0; i < n; i++) params[i] = (rnd() - 0.5) * 0.1
  const x = new Uint8Array(B * SEPIA.ctx)
  const y = new Uint8Array(B)
  for (let i = 0; i < x.length; i++) x[i] = Math.floor(rnd() * SEPIA.vocab)
  for (let i = 0; i < B; i++) y[i] = Math.floor(rnd() * SEPIA.vocab)
  const g = new Float32Array(n)
  lossAndGrad(params, x, y, B, g) // JIT warm-up
  const t0 = performance.now()
  const loss = lossAndGrad(params, x, y, B, g)
  const ms = Math.max(performance.now() - t0, 0.01)
  if (!Number.isFinite(loss)) throw new Error('SEPIA self-check: loss is not finite')
  const codecCos = cosine(g, decodeGrad(encodeGrad(g)))
  if (!(codecCos >= 0.999)) throw new Error(`SEPIA self-check: gradient codec cosine ${codecCos.toFixed(5)} < 0.999`)
  return { ms, loss, codecCos, gflops: trainFlops(B) / (ms * 1e6) }
}

// ─── identity ────────────────────────────────────────────────────────────────

function cpuModel(): string {
  const m = os.cpus()[0]?.model ?? 'cpu'
  return m.replace(/\(R\)|\(TM\)|CPU|Processor|@.*$/gi, '').replace(/\d+-Core/i, '').replace(/\s+/g, ' ').trim() || 'cpu'
}

/**
 * Stable, anonymous per-machine id so wallet-less credits stay with this device: 80 random bits kept in
 * ~/.lusca/device-id (mode 0600). Hostname/user-derived ids are guessable, so they are only the
 * fallback when that file cannot be written.
 */
function deviceId(): string {
  const dir = path.join(os.homedir(), '.lusca')
  const file = path.join(dir, 'device-id')
  try {
    const saved = fs.readFileSync(file, 'utf8').trim()
    if (/^cpu-[0-9a-f]{20}$/.test(saved)) return saved
  } catch {
    /* first run */
  }
  try {
    const id = 'cpu-' + randomBytes(10).toString('hex')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, `${id}\n`, { mode: 0o600 })
    return id
  } catch {
    /* read-only home: fall back to a derived id */
  }
  let user = ''
  try {
    user = os.userInfo().username
  } catch {
    /* no passwd entry in some containers */
  }
  return 'cpu-' + createHash('sha256').update(`lusca-desktop|${os.hostname()}|${user}|${os.platform()}|${os.arch()}`).digest('hex').slice(0, 20)
}

// ─── wallet sign-in ──────────────────────────────────────────────────────────

/** ws(s)://host[:port]/ws → http(s)://host[:port] */
function httpBase(server: string): URL {
  const u = new URL(server)
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
  u.pathname = '/'
  u.search = ''
  u.hash = ''
  return u
}

/**
 * Read a Solana keypair file: a JSON array of 64 bytes (solana-keygen) or base58 text of the
 * 64-byte secret key (Phantom export). Returns the 32-byte seed and the derived address; checks the
 * stored public half matches the seed. The file is only read locally.
 */
function readKeypair(file: string): { seed: Uint8Array; address: string } {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8').trim()
  } catch (e) {
    throw new Error(`cannot read --keypair file: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`)
  }
  let bytes: Uint8Array | null = null
  if (text.startsWith('[')) {
    let arr: unknown
    try {
      arr = JSON.parse(text)
    } catch {
      throw new Error('--keypair file is not valid JSON')
    }
    if (Array.isArray(arr) && arr.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) bytes = Uint8Array.from(arr as number[])
  } else {
    bytes = base58Decode(text)
  }
  text = ''
  if (!bytes || bytes.length !== 64) throw new Error('--keypair must hold a 64-byte Solana secret key (JSON byte array or base58)')
  const seed = bytes.slice(0, 32)
  const pub = rawPublicKey(privateKeyFromSeed(seed))
  const stored = bytes.slice(32)
  bytes.fill(0)
  if (!Buffer.from(pub).equals(Buffer.from(stored))) {
    seed.fill(0)
    throw new Error('--keypair is inconsistent: its public half does not match the secret seed')
  }
  return { seed, address: base58Encode(pub) }
}

const SIGN_IN_TIMEOUT_MS = 15_000
const SIGN_IN_TRIES = 3
const SIGN_IN_RETRY_MS = 5_000

async function postJson<T>(url: URL, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
  })
  return readJson<T>(res)
}

async function readJson<T>(res: Response): Promise<T> {
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : `HTTP ${res.status}`
    throw new Error(err)
  }
  return data as T
}

/**
 * nonce → check the message is the plain-text LUSCA sign-in for this server and wallet → sign
 * locally → verify. Only the signature leaves this machine.
 */
async function signIn(server: string, kp: { seed: Uint8Array; address: string }): Promise<AuthSession> {
  const base = httpBase(server)
  const nonceUrl = new URL('/api/auth/nonce', base)
  nonceUrl.searchParams.set('wallet', kp.address)
  const n = await readJson<AuthNonce>(await fetch(nonceUrl, { signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS) }))
  if (!n || typeof n.message !== 'string' || typeof n.nonce !== 'string') throw new Error('unexpected reply from /api/auth/nonce')
  const lines = n.message.split('\n')
  const host = base.host.toLowerCase()
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/
  const expected =
    lines.length === 10 &&
    lines[0] === `${host} wants you to sign in with your Solana account:` &&
    lines[1] === kp.address &&
    lines[2] === '' &&
    lines[3] === 'Link this wallet to LUSCA to receive SOL payouts for verified GPU work. This is not a transaction and costs nothing.' &&
    lines[4] === '' &&
    /^URI: https?:\/\//.test(lines[5]) && lines[5].slice(5).replace(/^https?:\/\//, '').toLowerCase() === host &&
    lines[6] === 'Version: 1' &&
    lines[7] === `Nonce: ${n.nonce}` &&
    ISO.test(lines[8].replace(/^Issued At: /, '')) && lines[8].startsWith('Issued At: ') &&
    ISO.test(lines[9].replace(/^Expiration Time: /, '')) && lines[9].startsWith('Expiration Time: ')
  if (!expected) {
    const named = /^(.*) wants you to sign in/.exec(lines[0] ?? '')?.[1]?.toLowerCase()
    if (named && named !== host && /^[a-z0-9.-]+(:\d{1,5})?$/.test(named)) {
      const suggested = new URL(server)
      suggested.host = named
      throw new Error(`this server signs in as ${named}, not ${host}; nothing was signed — run again with --server ${suggested.toString()}`)
    }
    throw new Error('the server sent an unexpected sign-in message; nothing was signed')
  }
  const key = privateKeyFromSeed(kp.seed)
  const sig = signEd25519(new TextEncoder().encode(n.message), key)
  return postJson<AuthSession>(new URL('/api/auth/verify', base), { wallet: kp.address, nonce: n.nonce, signature: base58Encode(sig) })
}

// ─── neuron ──────────────────────────────────────────────────────────────────

function usage(): string {
  return [
    '',
    `  ${bold('LUSCA desktop neuron')}`,
    '',
    `  ${PROG} [--auth token | --keypair file] [--label name] [--server url] [--jobs n] [--plain | --ascii] [--quiet] [--no-train]`,
    '',
    '  Trains SEPIA on this CPU: computes gradients on batches chosen by the server, which audits',
    '  them and applies them. Also runs dedupe jobs. Node 20 or newer.',
    '',
    `  --server   coordinator websocket          (env LUSCA_WS, default ${defaultServer()})`,
    '  --label    name on the leaderboard        (default: cpu model)',
    '  --auth     sign-in token from the Node page (env LUSCA_AUTH; preferred: no key on this machine)',
    '  --keypair  dedicated payout-only keypair JSON (never a wallet that holds funds); signs one',
    '             plain-text sign-in message locally, no transaction, no cost, the key is never sent',
    '  --wallet   Solana address to display      (payouts need --keypair or --auth)',
    '  --jobs     exit after n verified jobs     (default: 0 = run until Ctrl-C)',
    '  --device   override the ledger device id  (16–64 chars of A-Z a-z 0-9 _ -; keep it private)',
    '  --plain    plain log lines instead of the live dashboard (env LUSCA_NEURON_PLAIN=1). Also used',
    '             automatically when output is not a terminal or the window is smaller than 90×26',
    '  --ascii    draw the live dashboard with plain half blocks (fonts that lack braille / block octants);',
    '             LUSCA_NEURON_GLYPHS=braille|octant|ascii picks the art characters (Windows Terminal: octant)',
    '  --quiet    plain output: only failures + a summary every 25 verified jobs',
    '  --no-train dedupe jobs only (no SEPIA training)',
    '  --version  print the build id',
    '',
    '  Credits are earned without a wallet (kept on this device). Training credits are pending until',
    '  the next full audit of this identity passes, then confirmed; only confirmed credits are paid.',
    '  Each payout period the payout pool is split by credits and paid in SOL to verified wallets.',
    '  NO_COLOR=1 turns colors off. Source: https://github.com/LUSCAINK/LUSCA',
    '',
  ].join('\n')
}

async function main() {
  const major = Number(process.versions.node.split('.')[0])
  if (!(major >= MIN_NODE_MAJOR)) {
    process.stderr.write(`LUSCA neuron needs Node ${MIN_NODE_MAJOR} or newer (this is ${process.version}). Install the LTS from https://nodejs.org\n`)
    process.exit(2)
  }
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`${red('error')} ${(e as Error).message}\n`)
    process.exit(2)
  }
  if (args.help) {
    process.stdout.write(usage() + '\n')
    return
  }

  const threads = os.cpus().length
  const model = cpuModel()
  const label = (args.label ?? `${model} · desktop`).slice(0, 48)
  const dev = args.device ?? deviceId()

  // ── front-end: live dashboard on a big enough terminal, plain lines otherwise ──
  const tty = process.stdout
  const wantTui =
    !!tty.isTTY && (tty.columns ?? 0) >= 90 && (tty.rows ?? 0) >= 26 && !args.plain && !args.quiet && !plainFromEnv()
  const plainUI = (resumed = false) => createLogUI({ color: COLOR, quiet: args.quiet, resumed })
  let uiMode: 'tui' | 'log' = 'log'
  let ui: NeuronUI
  let uiNote: string | null = null
  if (wantTui) {
    try {
      ui = createUI({ mode: 'tui', color: !process.env.NO_COLOR, ascii: args.ascii })
      uiMode = 'tui'
    } catch (e) {
      ui = plainUI()
      uiNote = `live dashboard unavailable (${(e as Error)?.message ?? e}) — plain output`
    }
  } else {
    ui = plainUI()
  }

  // A rendering failure must never stop the work: if the dashboard throws, it is shut down and the
  // session continues on plain lines (events in between are queued and replayed).
  let swapQueue: NeuronEvent[] | null = null
  let swapDone: Promise<void> | null = null
  const emit = (e: NeuronEvent) => {
    if (swapQueue) {
      swapQueue.push(e)
      return
    }
    try {
      ui.emit(e)
    } catch (err) {
      if (uiMode !== 'tui') return
      uiMode = 'log'
      swapQueue = [{ t: 'notice', level: 'warn', msg: `live dashboard stopped (${(err as Error)?.message ?? err}) — continuing with plain output` }, e]
      const dead = ui
      swapDone = within(Promise.resolve().then(() => dead.stop()), 3000).then(() => {
        ui = plainUI(true)
        const q = swapQueue ?? []
        swapQueue = null
        swapDone = null
        for (const x of q) {
          try {
            ui.emit(x)
          } catch {
            /* plain output cannot fail in a way worth stopping for */
          }
        }
      })
    }
  }

  let uiStopped = false
  /** Stop the front-end (restores the terminal); bounded so a stuck renderer cannot block exit. */
  const stopUI = async (summary?: string) => {
    if (uiStopped) return
    uiStopped = true
    if (swapDone) await swapDone
    await within(Promise.resolve().then(() => ui.stop(summary)), 3000)
  }
  /** Fatal before the session starts: restore the terminal, then explain on stderr. */
  const fatal = async (text: string): Promise<never> => {
    await stopUI()
    process.stderr.write(text)
    process.exit(2)
  }
  /** Dashboard pacing only (lets a frame render around the blocking benchmark); no-op for plain output. */
  const pause = (ms: number) => (uiMode === 'tui' ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve())

  // Until the session installs its own handlers: leave cleanly (terminal restored) on Ctrl-C or a crash.
  const early = () => void stopUI().finally(() => process.exit(130))
  process.on('SIGINT', early)
  process.on('SIGTERM', early)
  process.on('uncaughtException', (err) => {
    void stopUI().finally(() => {
      process.stderr.write(`${red('error')} ${(err as Error)?.stack ?? String(err)}\n`)
      process.exit(1)
    })
  })

  emit({ t: 'boot', build: BUILD_ID, cpu: model, threads, os: `${os.platform()} ${os.arch()}`, server: args.server, label })
  if (uiNote) emit({ t: 'notice', level: 'warn', msg: uiNote })
  await pause(600)
  emit({ t: 'bench', phase: 'start' })
  await pause(120)
  const bench = benchmarkCpu()
  const zone: Zone = zoneFor(bench.gflops)
  const zinfo = ZONES.find((z) => z.zone === zone) ?? ZONES[0]
  emit({ t: 'bench', phase: 'done', gflops: bench.gflops, zone, bonus: zinfo.bonus })
  await pause(250)
  if (args.train) {
    let sc: ReturnType<typeof trainSelfCheck>
    try {
      sc = trainSelfCheck(128)
    } catch (e) {
      return fatal(`${red('error')} ${(e as Error).message} — run with --no-train for dedupe jobs only\n`)
    }
    emit({ t: 'selftest', batch: 128, ms: sc.ms, gflops: sc.gflops, codecCos: sc.codecCos })
  } else {
    emit({ t: 'notice', level: 'info', msg: 'training off (--no-train) · dedupe jobs only' })
  }
  await pause(250)

  // Wallet sign-in: --keypair signs the nonce message locally; --auth reuses a token.
  let authToken: string | null = args.auth
  let wallet: string | null = args.wallet
  if (args.keypair) {
    let kp: { seed: Uint8Array; address: string }
    try {
      kp = readKeypair(args.keypair)
    } catch (e) {
      return fatal(`${red('error')} ${(e as Error).message}\n`)
    }
    if (wallet && wallet !== kp.address) {
      kp.seed.fill(0)
      return fatal(`${red('error')} --wallet ${shortAddr(wallet)} does not match the --keypair address ${shortAddr(kp.address)}\n`)
    }
    wallet = kp.address
    emit({ t: 'wallet', state: 'signing', address: kp.address })
    // A wallet was asked for: never fall back to earning on the device account, where credits are
    // not paid out. Network errors and timeouts are retried; anything else stops here.
    let failure: string | null = null
    try {
      for (let tryNo = 1; ; tryNo++) {
        try {
          const s = await signIn(args.server, kp)
          if (s.wallet !== kp.address || typeof s.token !== 'string') throw new Error('the server returned a token for another wallet')
          authToken = s.token
          emit({ t: 'wallet', state: 'verified', address: kp.address, until: s.expiresAt })
          break
        } catch (e) {
          const err = e as Error
          const transient = err.name === 'TimeoutError' || err.name === 'TypeError' // fetch: network failure
          const why = err.name === 'TimeoutError' ? 'timed out' : transient ? `network error (${(err.cause as Error | undefined)?.message ?? err.message})` : err.message
          if (!transient || tryNo >= SIGN_IN_TRIES) {
            failure = why
            break
          }
          emit({ t: 'notice', level: 'warn', msg: `wallet sign-in: ${why} — retrying (${tryNo + 1}/${SIGN_IN_TRIES})` })
          await new Promise((r) => setTimeout(r, SIGN_IN_RETRY_MS))
        }
      }
    } finally {
      kp.seed.fill(0)
    }
    if (failure !== null) {
      emit({ t: 'wallet', state: 'failed', address: kp.address, reason: failure })
      await stopUI()
      process.stderr.write(
        `  ${red('■')} wallet sign-in failed: ${failure}\n` +
          `  ${dim('         not starting: --keypair was given but no wallet is verified. Fix the sign-in and run again,')}\n` +
          `  ${dim('         or run without --keypair to earn credits on this device account.')}\n`,
      )
      // Let the event loop drain instead of process.exit(): exiting while fetch's socket is still
      // closing trips a libuv assertion on Windows (exit status 127 instead of 2).
      process.off('SIGINT', early)
      process.off('SIGTERM', early)
      process.exitCode = 2
      return
    }
  } else if (authToken) {
    emit({ t: 'wallet', state: 'token', ...(wallet ? { address: wallet } : {}) })
  } else {
    emit({ t: 'wallet', state: 'none', ...(wallet ? { address: wallet } : {}) })
  }
  await pause(200)

  // session state
  const startedAt = Date.now()
  let ws: WebSocket | null = null
  let neuronId: string | null = null
  let stopping = false
  let attempt = 0
  let jobs = 0
  let verified = 0
  let failed = 0
  let forfeited = 0 // credits the server reported forfeited during this session (sum of its events)
  let trainJobs = 0
  let flops = 0
  // Credit totals come only from the server's ledger, exactly like the web panel: every registered
  // socket sends account.watch, and each 'account' reply (pushed again whenever the account or its
  // escrow changes) replaces the totals. Verdict events drive the per-job feed only; nothing here
  // adds them up. null until the first reply: the front-ends show "—".
  let account: { confirmed: number; pending: number; scope: 'wallet' | 'device' | null } | null = null
  // Confirmed credits at the first reply of this run, per resolved scope (session gain = now − base).
  let sessionBase: { scope: string; ink: number } | null = null
  let sessionCarry = 0 // gain on an earlier scope of this run (the identity changed mid-run)
  let watchedSock: WebSocket | null = null
  let watchedAuth: string | null = null
  let accountWaiters: (() => void)[] = []
  // Feed classification only (no amounts): this session's escrowed and audited training job ids,
  // and results sent that have no verdict yet (waited for briefly on shutdown).
  const pendingIds = new Set<string>()
  const auditedIds = new Set<string>()
  const unsettled = new Set<string>()
  // SEPIA weights held by version, so the server can skip resending them (job.weights === null).
  let held: { version: number; params: Float32Array } | null = null
  let grad: Float32Array | null = null
  let errStreak = 0
  let warmupLogged = false
  let requestTimer: NodeJS.Timeout | null = null
  let watchdog: NodeJS.Timeout | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let reRegisterTimer: NodeJS.Timeout | null = null
  let lastAuth: 'verified' | 'invalid' | 'none' | null = null
  const mine = new Set<string>() // job ids we answered (attribution across re-registers)

  const notice = (level: 'info' | 'warn' | 'error', msg: string) => emit({ t: 'notice', level, msg })
  const r2 = (x: number) => Math.round(x * 100) / 100
  const totals = () => emit({ t: 'totals', jobs, verified, failed })
  const sessionGain = () => (account && sessionBase ? r2(sessionCarry + account.confirmed - sessionBase.ink) : 0)

  const send = (msg: ClientMsg): boolean => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch (e) {
      notice('warn', `send failed: ${(e as Error).message}`)
      return false
    }
  }

  /**
   * Follow this neuron's ledger account on the current socket: { device, auth } resolve on the
   * server like neuron.register (valid token → wallet:<w>, else device:<id>). One watch per
   * connection; `force` re-sends it (the identity may have changed, or a fresh reply is wanted).
   */
  const watchAccount = (force = false): boolean => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    if (!force && watchedSock === ws && watchedAuth === authToken) return true
    if (!send({ t: 'account.watch', device: dev, auth: authToken })) return false
    watchedSock = ws
    watchedAuth = authToken
    return true
  }

  const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

  /** A server 'account' message: the new credit totals (account null = no ledger entry yet = 0). */
  const onAccount = (m: Extract<ServerMsg, { t: 'account' }>) => {
    const scope = m.scope === 'wallet' || m.scope === 'device' ? m.scope : null
    let confirmed = 0
    let pending = 0
    if (m.account !== null) {
      const ink = m.account && typeof m.account === 'object' ? finite(m.account.ink) : null
      if (ink === null) return // malformed: keep the last good totals
      confirmed = ink
      pending = Math.max(0, finite(m.account.pendingInk) ?? 0)
    }
    const key = scope ?? 'none'
    if (!sessionBase || sessionBase.scope !== key) {
      if (sessionBase && account) sessionCarry += account.confirmed - sessionBase.ink
      sessionBase = { scope: key, ink: confirmed }
    }
    account = { confirmed, pending, scope }
    emit({ t: 'account', confirmed, pending, session: sessionGain(), scope })
    const waiting = accountWaiters
    accountWaiters = []
    for (const f of waiting) f()
  }

  /** Re-watch and wait for the server's reply (or `ms`): final totals straight from the ledger. */
  const refreshAccount = (ms: number) =>
    new Promise<void>((resolve) => {
      if (!watchAccount(true)) return resolve()
      const done = () => {
        clearTimeout(timer)
        accountWaiters = accountWaiters.filter((f) => f !== done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      accountWaiters.push(done)
    })

  const clearTimers = () => {
    if (requestTimer) clearTimeout(requestTimer)
    if (watchdog) clearTimeout(watchdog)
    if (reRegisterTimer) clearTimeout(reRegisterTimer)
    requestTimer = watchdog = reRegisterTimer = null
  }

  const backoff = () => Math.round(Math.min(15000, 1500 * 2 ** Math.max(0, errStreak - 1)) * (0.8 + Math.random() * 0.4))

  const register = () => {
    send({
      t: 'neuron.register',
      label,
      zone, // advisory: the coordinator re-derives the zone from gflops
      gflops: Math.round(bench.gflops * 100) / 100,
      kind: 'desktop',
      wallet,
      auth: authToken,
      adapter: {
        backend: 'cpu-js',
        vendor: model.slice(0, 64),
        architecture: `${os.arch()} · ${threads} threads`,
        deviceId: dev,
        description: `${model} (${os.platform()})`.slice(0, 96),
        cores: String(threads),
        timing: 'cpu',
        runtime: `node ${process.version}`,
      },
    })
  }

  const scheduleRegister = (ms: number, why: string) => {
    if (reRegisterTimer || stopping) return
    notice('info', `${why} — re-registering in ${Math.ceil(ms / 1000)} s`)
    reRegisterTimer = setTimeout(() => {
      reRegisterTimer = null
      if (!stopping) register()
    }, ms)
  }

  /** Ask for the next job; re-ask if nothing arrives (the server keeps one request queued). */
  const requestJob = (delay = 0) => {
    if (requestTimer) clearTimeout(requestTimer)
    if (watchdog) clearTimeout(watchdog)
    requestTimer = watchdog = null
    requestTimer = setTimeout(() => {
      requestTimer = null
      if (stopping || !neuronId) return
      if (!send({ t: 'job.request', caps: { train: args.train, version: args.train && held ? held.version : null } })) return
      watchdog = setTimeout(() => {
        watchdog = null
        if (stopping || !neuronId) return
        notice('info', 'no job for 30 s — asking again')
        requestJob()
      }, 30_000)
    }, delay)
  }

  /** The closing line; credit figures are the server ledger's ("—" if it never answered). */
  const summary = () => {
    const credits = account
      ? `${fmtCredits(account.confirmed)} credits confirmed · ${fmtCredits(account.pending)} pending · +${fmtCredits(sessionGain())} confirmed this session`
      : '— credits (no ledger reply)'
    return (
      `${fmtDur(Date.now() - startedAt)} · ${jobs} jobs (${trainJobs} train) · ${verified} verified · ${failed} failed · ${fmtFlop(flops)} · ` +
      `${credits}${forfeited > 0 ? ` · ${fmtCredits(forfeited)} forfeited` : ''} · paid in SOL to verified wallets`
    )
  }

  /** Add to a bounded id set (oldest dropped first). */
  const keep = (set: Set<string>, id: string, max = 2000) => {
    set.add(id)
    if (set.size > max) set.delete(set.values().next().value as string)
  }
  const remember = (id: string) => keep(mine, id)

  /** SEPIA training step: gradient of the mean cross-entropy on the server's batch. */
  const handleTrainJob = (job: TrainJob) => {
    const B = job.batch
    if (!(Number.isInteger(B) && B > 0 && B <= 65536)) throw new Error(`bad batch size ${B}`)
    if (job.ctx !== SEPIA.ctx) throw new Error(`context ${job.ctx} does not match SEPIA ctx ${SEPIA.ctx} — update this program`)
    if (job.weights !== null) {
      held = { version: job.version, params: decodeWeights(job.weights) }
    } else if (!held || held.version !== job.version) {
      const have = held ? `v${held.version}` : 'none'
      held = null // the next request asks for the weights again
      throw new Error(`job is for weights v${job.version} but this neuron holds ${have}`)
    }
    const x = b64Bytes(job.x)
    const y = b64Bytes(job.y)
    if (x.length !== B * SEPIA.ctx || y.length !== B) throw new Error(`batch payload is ${x.length}+${y.length} bytes, expected ${B * SEPIA.ctx}+${B}`)
    for (let i = 0; i < x.length; i++) if (x[i] >= SEPIA.vocab) throw new Error('batch holds an id outside the vocabulary')
    for (let i = 0; i < y.length; i++) if (y[i] >= SEPIA.vocab) throw new Error('batch holds a target outside the vocabulary')
    if (!grad || grad.length !== SEPIA.params) grad = new Float32Array(SEPIA.params)
    const t0 = performance.now()
    const loss = lossAndGrad(held.params, x, y, B, grad)
    const ms = performance.now() - t0
    if (!Number.isFinite(loss)) throw new Error('loss is not finite')
    const f = Number.isFinite(job.flops) && job.flops > 0 ? job.flops : trainFlops(B)
    remember(job.id)
    const ok = send({ t: 'train.result', result: { id: job.id, kind: 'train', grad: bytesB64(encodeGrad(grad)), loss, ms: Math.round(ms * 100) / 100 } })
    if (!ok) {
      notice('warn', `train job ${shortId(job.id)} computed but the socket closed before sending`)
      return
    }
    keep(unsettled, job.id, 64)
    jobs++
    trainJobs++
    flops += f
    errStreak = 0
    emit({ t: 'computed', id: job.id, kind: 'train', ms, gflops: f / (Math.max(ms, 0.001) * 1e6), loss })
    if (!args.jobs || jobs - failed < args.jobs) requestJob(0)
  }

  /** The 'job' event: what arrived, before any work (the FLOPs the job is worth, as the server counts them). */
  const announce = (job: SimJob | TrainJob) => {
    const given = Number.isFinite(job.flops) && job.flops > 0 ? job.flops : 0
    if (job.kind === 'train') {
      const B = job.batch
      emit({ t: 'job', id: String(job.id), kind: 'train', version: job.version, batch: B, flops: given || (Number.isInteger(B) && B > 0 ? trainFlops(B) : 0) })
    } else {
      emit({ t: 'job', id: String(job.id), kind: 'sim', flops: given || 2 * job.rows * job.cols * job.dim || 0 })
    }
  }

  const handleJob = (job: SimJob | TrainJob) => {
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    announce(job)
    try {
      if (job.kind === 'train') {
        handleTrainJob(job)
        return
      }
      if (job.kind !== 'simmatrix') throw new Error(`unknown job kind ${String((job as { kind?: unknown }).kind)} — update this program`)
      const { rows, cols, dim: d } = job
      if (!(rows > 0 && cols > 0 && d > 0)) throw new Error(`empty job ${rows}×${cols}×${d}`)
      const a = b64ToF32(job.a)
      const b = b64ToF32(job.b)
      if (a.length < rows * d || b.length < cols * d) throw new Error(`payload too short for ${rows}×${cols}×${d}`)
      const t0 = performance.now()
      const r = bestMatchesCPU(a, b, rows, cols, d)
      const ms = performance.now() - t0
      const f = Number.isFinite(job.flops) && job.flops > 0 ? job.flops : 2 * rows * cols * d
      remember(job.id)
      if (!send({ t: 'job.result', result: { id: job.id, best: r.best, sim: r.sim, ms: Math.round(ms * 100) / 100 } })) {
        notice('warn', `job ${shortId(job.id)} computed but the socket closed before sending`)
        return
      }
      keep(unsettled, job.id, 64)
      jobs++
      flops += f
      errStreak = 0
      emit({ t: 'computed', id: job.id, kind: 'sim', ms, gflops: f / (Math.max(ms, 0.001) * 1e6) })
      // One job at a time; the coordinator keeps one request queued, so ask right behind the result.
      if (!args.jobs || jobs - failed < args.jobs) requestJob(0)
    } catch (e) {
      errStreak++
      emit({
        t: 'verdict',
        id: String((job as { id?: unknown }).id ?? '—'),
        kind: (job as { kind?: unknown }).kind === 'train' ? 'train' : 'sim',
        status: 'failed',
        credits: 0,
        pending: false,
        reason: (e as Error).message,
      })
      requestJob(backoff())
    }
  }

  const handleInk = (ev: InkEvent) => {
    if (ev.neuronId !== neuronId && !mine.has(ev.jobId)) return
    const status = ev.status ?? (ev.verified ? 'confirmed' : undefined)
    const isTrain = ev.kind === 'train'
    const kind = isTrain ? 'train' : 'sim'
    const reason = credText(ev.reason ?? '')
    const amount = Number.isFinite(ev.ink) && ev.ink > 0 ? ev.ink : 0
    unsettled.delete(ev.jobId)
    // Feed lines only, with the server's amounts. Totals are never added up here: the server
    // releases escrow only up to the audited job and verdicts can arrive out of order, so they come
    // from its ledger ('account' replies to account.watch).
    if (status === 'forfeited') {
      // A failed full audit: the server forfeited this identity's escrow (its amount can include
      // escrow from earlier sessions); the job's own rejection arrives as a separate event.
      forfeited += amount
      pendingIds.clear()
      emit({ t: 'escrow', released: 0, forfeited: amount })
    } else if (ev.verified && status === 'confirmed' && (auditedIds.has(ev.jobId) || pendingIds.has(ev.jobId))) {
      // Escrow released: the line that follows a passed full audit (same job id, credits of
      // earlier gradient jobs), or an escrowed job confirmed on its own (already counted).
      pendingIds.delete(ev.jobId)
      emit({ t: 'escrow', released: amount })
    } else if (ev.verified && status === 'pending') {
      verified++
      keep(pendingIds, ev.jobId)
      emit({ t: 'verdict', id: ev.jobId, kind, status: 'verified', credits: amount, pending: true, reason })
    } else if (ev.verified) {
      verified++
      // A confirmed training job passed a full audit (the server follows up with the escrow it
      // released under the same job id).
      if (isTrain) keep(auditedIds, ev.jobId, 200)
      emit({ t: 'verdict', id: ev.jobId, kind, status: isTrain ? 'audited' : 'verified', credits: amount, pending: false, reason })
    } else {
      failed++
      // "gradient not scored … (no strike)": expired or unchecked, not a failed check.
      emit({ t: 'verdict', id: ev.jobId, kind, status: /not scored/i.test(reason) ? 'stale' : 'rejected', credits: 0, pending: false, reason })
      if (!args.jobs || jobs - failed < args.jobs) requestJob(200) // harmless if one is already queued
    }
    totals()
    if (args.jobs && verified >= args.jobs) void shutdown(`reached ${args.jobs} verified job${args.jobs === 1 ? '' : 's'}`)
  }

  const handleError = (raw: string) => {
    errStreak++
    const msg = credText(raw)
    const cool = /retry in (\d+)\s*s/i.exec(msg) ?? /re-register in (\d+)\s*s/i.exec(msg)
    if (/warming up/i.test(msg)) {
      if (!warmupLogged) notice('warn', 'corpus warming up — the request stays queued; the first job follows when pages arrive')
      warmupLogged = true
      if (watchdog) clearTimeout(watchdog)
      watchdog = null
      requestJob(Math.max(backoff(), 5000)) // harmless re-ask in case the queued request was dropped
    } else if (/register as a neuron/i.test(msg)) {
      notice('warn', 'coordinator forgot this neuron — re-registering')
      neuronId = null
      register()
    } else if (/consecutive failed jobs|cooling down/i.test(msg)) {
      notice('error', msg)
      neuronId = null
      if (requestTimer) clearTimeout(requestTimer)
      if (watchdog) clearTimeout(watchdog)
      requestTimer = watchdog = null
      scheduleRegister(cool ? Number(cool[1]) * 1000 + 500 : 30_000, 'cooling down')
    } else if (/unknown or expired job/i.test(msg)) {
      notice('warn', 'result arrived after the job expired — requesting a fresh one')
      requestJob(200)
    } else if (/pool is full/i.test(msg)) {
      scheduleRegister(Math.max(backoff(), 15_000), 'neuron pool is full')
    } else {
      const wait = backoff()
      notice('warn', `coordinator: ${msg} — retry in ${Math.round(wait / 1000)} s`)
      if (neuronId) requestJob(wait)
      else scheduleRegister(wait, 'not registered')
    }
  }

  const connect = () => {
    if (stopping) return
    reconnectTimer = null
    emit({ t: 'conn', state: 'connecting', server: args.server })
    const sock = new WebSocket(args.server, { handshakeTimeout: 10_000, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
    ws = sock
    let registered = false
    const join = () => {
      if (registered) return
      registered = true
      register()
    }
    sock.on('open', () => {
      attempt = 0
      emit({ t: 'conn', state: 'connected', server: args.server })
      join()
    })
    sock.on('message', (data, isBinary) => {
      if (isBinary) return
      let msg: ServerMsg
      try {
        msg = JSON.parse(data.toString()) as ServerMsg
      } catch {
        return
      }
      try {
        switch (msg.t) {
          case 'hello':
            join() // greeting on every (re)connect; register once per socket
            return
          case 'neuron.ok': {
            const n: NeuronInfo = msg.neuron
            const first = neuronId === null
            neuronId = n.id
            errStreak = 0
            warmupLogged = false
            const auth = msg.auth ?? 'none'
            // A wallet was asked for: do not keep earning on the device account instead.
            const authFailed = !!authToken && auth !== 'verified'
            const authChanged = !authFailed && auth !== lastAuth
            if (authChanged && auth === 'verified' && (n.wallet ?? wallet)) emit({ t: 'wallet', state: 'verified', address: (n.wallet ?? wallet) as string })
            if (first || authChanged) {
              emit({
                t: 'conn',
                state: 'registered',
                server: args.server,
                neuronId: n.id,
                zone: n.zone,
                gflops: n.gflops,
                ...(authFailed ? {} : { linked: auth === 'verified' }),
              })
            }
            if (authFailed) {
              const why = auth === 'invalid' ? 'sign-in token rejected (expired or issued by another server)' : 'the server did not confirm the wallet sign-in'
              emit({ t: 'wallet', state: 'failed', ...(wallet ? { address: wallet } : {}), reason: why })
              notice('error', why)
              void shutdown(`stopping — run again with --keypair, or with a new --auth token from the Node page`, 2)
              return
            }
            if (authChanged) lastAuth = auth
            // Credit totals: follow the ledger account credits now go to (every new socket, and
            // again when the server's view of the sign-in changed).
            watchAccount(authChanged && !first)
            requestJob(0)
            return
          }
          case 'account':
            onAccount(msg)
            return
          case 'job':
            handleJob(msg.job)
            return
          case 'ink':
            handleInk(msg.event)
            return
          case 'error':
            handleError(msg.msg || 'unknown error')
            return
          case 'neurons': {
            if (!neuronId) return
            const ranked = msg.neurons.slice().sort((x, y) => y.ink - x.ink)
            const pos = ranked.findIndex((x) => x.id === neuronId)
            const pooled = ranked.reduce((s, x) => s + x.gflops, 0)
            emit({ t: 'network', ...(pos >= 0 ? { rank: pos + 1 } : {}), neurons: ranked.length, poolGflops: pooled })
            return
          }
          default:
            return // ingest firehose (agents, pages, traces, payouts…) — not ours
        }
      } catch (e) {
        notice('warn', `message handler failed: ${(e as Error)?.message ?? e}`)
      }
    })
    sock.on('error', (e: Error & { code?: string }) => {
      if (stopping) return
      if (e.code === 'ECONNREFUSED') notice('warn', `coordinator unreachable at ${args.server} — is the server running?${/\/\/(127\.0\.0\.1|localhost)[:/]/.test(args.server) ? ' (npm run server)' : ''}`)
      else notice('warn', `socket error: ${e.message}`)
    })
    sock.on('close', (code) => {
      if (ws === sock) ws = null
      clearTimers()
      const had = neuronId !== null
      neuronId = null
      if (stopping) return
      attempt++
      const wait = Math.round(Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5) * (0.8 + Math.random() * 0.4)))
      emit({ t: 'conn', state: 'reconnecting', server: args.server })
      notice(had ? 'error' : 'warn', `${had ? 'connection lost' : 'disconnected'}${code && code !== 1006 ? ` (code ${code})` : ''} — reconnecting in ${(wait / 1000).toFixed(1)} s`)
      reconnectTimer = setTimeout(connect, wait)
    })
  }

  const shutdown = async (why: string, code = 0) => {
    if (stopping) return
    stopping = true
    clearTimers()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    notice('info', why)
    const sock = ws
    if (sock && sock.readyState === WebSocket.OPEN) {
      // Closing totals from the ledger: let verdicts for results already sent land (briefly), then
      // ask the server for the account once more.
      for (const until = Date.now() + 4000; unsettled.size > 0 && Date.now() < until && sock.readyState === WebSocket.OPEN; ) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (sock.readyState === WebSocket.OPEN) await refreshAccount(2500)
      send({ t: 'neuron.leave' })
      await new Promise<void>((resolve) => {
        const done = setTimeout(resolve, 1500)
        sock.once('close', () => {
          clearTimeout(done)
          resolve()
        })
        sock.close(1000, 'neuron leaving')
      })
    } else if (sock) {
      sock.terminate()
    }
    emit({ t: 'conn', state: 'closed', server: args.server })
    await stopUI(summary())
    process.exit(code)
  }

  process.off('SIGINT', early)
  process.off('SIGTERM', early)
  // A second Ctrl-C while leaving (it waits a few seconds for the closing totals) leaves at once.
  const leaveNow = () => void stopUI().finally(() => process.exit(130))
  process.on('SIGINT', () => (stopping ? leaveNow() : void shutdown('Ctrl-C — leaving the pool')))
  process.on('SIGTERM', () => (stopping ? leaveNow() : void shutdown('terminated — leaving the pool')))
  process.on('unhandledRejection', (r) => notice('warn', `unhandled rejection: ${String(r)}`))
  connect()
}

/** Resolve when `p` settles or after `ms`, whichever is first (never rejects). */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    const done = () => {
      clearTimeout(t)
      resolve()
    }
    p.then(done, done)
  })
}

void main()
