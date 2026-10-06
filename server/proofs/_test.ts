// Proof of contribution: Merkle vectors, chain verification, tamper detection, epoch close with
// escrow (real coordinator), restart / hard-kill persistence, API auth, plus the two counter
// fixes that ship with it (monotonic audit counts, held corpus totals).
//   npx tsx server/proofs/_test.ts
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerMsg, TrainJob } from '../../shared/protocol.ts'
import {
  ZERO_HASH,
  bytesToHex,
  leafBytes,
  merkleRootAsync,
  subtleSha256,
  verifyHeadersAsync,
  walkPath,
  type EpochHeader,
  type ProofLeaf,
} from '../../shared/proofs.ts'
import { planPayout } from '../../shared/payoutPlan.ts'
import { createCoordinator, inkFor } from '../neurons/coordinator.ts'
import { createStubCrawler } from '../neurons/_stubs.ts'
import type { NeuronConn } from '../contracts.ts'
import { createAuditCounter } from '../trainer/auditCounter.ts'
import { DatasetWriter } from '../ingest/store.ts'
import {
  buildEpoch,
  checkEpoch,
  createProofs,
  identityFor,
  leafHash,
  merklePath,
  merkleRoot,
  orderLeaves,
  pathFromLevels,
  rootFromPath,
  treeLevels,
  walletIdentity,
} from './index.ts'
import { handleProofRoute, ProofRouteError } from './http.ts'

let passed = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (e) {
    console.error(`FAIL ${name}\n${(e as Error).stack}`)
    process.exitCode = 1
  }
}

const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest()
const subtle = subtleSha256(globalThis.crypto.subtle)
const id = (n: number) => sha(Buffer.from(`identity-${n}`)).toString('hex')
const leaf = (n: number, credits = 1_000_000 * (n + 1)): ProofLeaf => ({ id: id(n), credits, jobs: n + 1, flops: (n + 1) * 1e9 })
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p))

// ─── Merkle vectors ─────────────────────────────────────────────────────────

await test('leaf bytes: 0x00 ‖ u32be epoch ‖ id ‖ u64be credits ‖ u64be jobs ‖ u64be flops', () => {
  const l: ProofLeaf = { id: 'ab'.repeat(32), credits: 1_234_567, jobs: 3, flops: 2 ** 40 }
  const b = Buffer.from(leafBytes(7, l))
  const expect = Buffer.alloc(61)
  expect[0] = 0
  expect.writeUInt32BE(7, 1)
  Buffer.from('ab'.repeat(32), 'hex').copy(expect, 5)
  expect.writeBigUInt64BE(1_234_567n, 37)
  expect.writeBigUInt64BE(3n, 45)
  expect.writeBigUInt64BE(2n ** 40n, 53)
  assert.equal(b.toString('hex'), expect.toString('hex'))
  assert.equal(bytesToHex(leafHash(7, l)), sha(expect).toString('hex'))
  assert.throws(() => leafBytes(1, { ...l, credits: 1.5 }))
  assert.throws(() => leafBytes(1, { ...l, id: 'AB'.repeat(32) }))
})

await test('empty tree root is 32 zero bytes; single leaf root is its leaf hash', async () => {
  assert.equal(merkleRoot([]), ZERO_HASH)
  assert.equal(await merkleRootAsync(subtle, 0, []), ZERO_HASH)
  const h = leafHash(5, leaf(0))
  assert.equal(merkleRoot([h]), bytesToHex(h))
  assert.deepEqual(merklePath([h], 0), [])
  assert.equal(await merkleRootAsync(subtle, 5, [leaf(0)]), bytesToHex(h))
})

await test('odd counts: the last node is carried up, never duplicated (3 and 5 leaves, hand-computed)', () => {
  const node = (a: Buffer, b: Buffer) => sha(Buffer.concat([Buffer.from([1]), a, b]))
  const o3 = orderLeaves(2, [leaf(0), leaf(1), leaf(2)])
  const [a, b, c] = o3.hashes.map((x) => Buffer.from(x))
  assert.equal(merkleRoot(o3.hashes), node(node(a, b), c).toString('hex'))
  const o5 = orderLeaves(2, [0, 1, 2, 3, 4].map((n) => leaf(n)))
  const h = o5.hashes.map((x) => Buffer.from(x))
  assert.equal(merkleRoot(o5.hashes), node(node(node(h[0], h[1]), node(h[2], h[3])), h[4]).toString('hex'))
})

await test('every path of trees with 1..17 leaves verifies (sync and WebCrypto) and the order of input does not matter', async () => {
  for (let n = 1; n <= 17; n++) {
    const leaves = Array.from({ length: n }, (_, i) => leaf(i))
    const o = orderLeaves(9, leaves)
    const root = merkleRoot(o.hashes)
    assert.equal(merkleRoot(orderLeaves(9, [...leaves].reverse()).hashes), root)
    assert.equal(await merkleRootAsync(subtle, 9, [...leaves].reverse()), root)
    for (let i = 0; i < n; i++) {
      const p = merklePath(o.hashes, i)
      assert.equal(rootFromPath(o.hashes[i], p), root, `n=${n} i=${i}`)
      const trace = await walkPath(subtle, bytesToHex(o.hashes[i]), p)
      assert.equal(trace.root, root)
      assert.equal(trace.steps.length, p.length + 1)
    }
  }
})

await test('domain separation: a leaf hash is not an inner node hash of the same bytes', () => {
  const l = leaf(1)
  const asLeaf = bytesToHex(leafHash(0, l))
  const raw = Buffer.from(leafBytes(0, l))
  raw[0] = 1
  assert.notEqual(asLeaf, sha(raw).toString('hex'))
})

// ─── chain verification / tamper detection ──────────────────────────────────

function chainOf(n: number): { header: EpochHeader; leaves: ProofLeaf[] }[] {
  const out: { header: EpochHeader; leaves: ProofLeaf[] }[] = []
  let ledger = 0
  for (let i = 0; i < n; i++) {
    const leaves = Array.from({ length: (i % 4) + 1 }, (_, k) => leaf(k + i, 1000 * (k + 1)))
    ledger += leaves.reduce((s, l) => s + l.credits, 0)
    out.push(buildEpoch(i, 1000 * i, 1000 * i + 999, leaves, out.length ? out[out.length - 1].header : null, ledger))
  }
  return out
}

await test('a built chain verifies in node and in the browser code; tampering is detected', async () => {
  const chain = chainOf(6)
  for (let i = 0; i < chain.length; i++) assert.equal(checkEpoch(chain[i].header, chain[i].leaves, i ? chain[i - 1].header : null), null)
  const headers = chain.map((c) => c.header)
  assert.deepEqual(await verifyHeadersAsync(subtle, headers), { ok: true, checked: 6, bad: null, warnings: [] })
  // a subrange verifies against its anchor
  assert.equal((await verifyHeadersAsync(subtle, headers.slice(3), headers[2])).ok, true)

  // rewritten credits in a header → header hash mismatch
  const t1 = headers.map((h) => ({ ...h, totals: { ...h.totals } }))
  t1[2].totals.credits += 1
  const r1 = await verifyHeadersAsync(subtle, t1)
  assert.equal(r1.ok, false)
  assert.equal(r1.bad?.index, 2)
  // a header re-hashed after the edit breaks the next link instead
  const t2 = headers.map((h) => ({ ...h }))
  const { headerHash: _drop, ...base } = { ...t2[2], treeRoot: 'ee'.repeat(32) }
  void _drop
  const forged = buildEpoch(2, base.startedAt, base.endedAt, chain[2].leaves, headers[1], base.totals.ledgerCredits).header
  t2[2] = { ...forged, treeRoot: 'ee'.repeat(32) }
  t2[2].headerHash = (await import('./index.ts')).headerHash((({ headerHash: _h, ...rest }) => (void _h, rest))(t2[2]))
  const r2 = await verifyHeadersAsync(subtle, t2)
  assert.equal(r2.ok, false)
  assert.equal(r2.bad?.index, 3)
  assert.match(r2.bad!.reason, /prevHeaderHash/)
  // a changed leaf no longer hashes to the root
  const leaves = chain[3].leaves.map((l) => ({ ...l }))
  leaves[0].credits += 1
  assert.match(checkEpoch(chain[3].header, leaves, chain[2].header) ?? '', /treeRoot/)
  // a dropped epoch is an index gap
  assert.match(checkEpoch(chain[4].header, chain[4].leaves, chain[2].header) ?? '', /gap/)
})

await test('identities: wallets are public sha256, devices are keyed HMACs', () => {
  const salt = Buffer.from('salt-a')
  const w = 'So11111111111111111111111111111111111111112'
  assert.equal(identityFor(salt, `wallet:${w}`), sha(Buffer.from(`lusca:id:v1:wallet:${w}`)).toString('hex'))
  assert.equal(identityFor(salt, `wallet:${w}`), walletIdentity(w))
  const d1 = identityFor(salt, 'device:abcdef123')
  assert.match(d1, /^[0-9a-f]{64}$/)
  assert.notEqual(d1, identityFor(Buffer.from('salt-b'), 'device:abcdef123'))
  assert.ok(!d1.includes('abcdef123'))
})

// ─── real coordinator: epochs over confirmed credits only ───────────────────

type Verdict = 'applied' | 'audited' | 'audit-failed'
interface FakeConn extends NeuronConn {
  next(t: string): Promise<ServerMsg>
}

function fakeConn(cid: string, ip: string): FakeConn {
  const inbox: ServerMsg[] = []
  const waiters: { t: string; resolve: (m: ServerMsg) => void }[] = []
  return {
    id: cid,
    ip,
    send(msg: ServerMsg) {
      const w = waiters.findIndex((x) => x.t === msg.t)
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg)
      else inbox.push(msg)
    },
    next(t: string) {
      const i = inbox.findIndex((m) => m.t === t)
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), 5000)
        waiters.push({ t, resolve: (m) => (clearTimeout(timer), resolve(m)) })
      })
    },
  } as FakeConn
}

function stubTrainer() {
  const st = { verdict: 'audited' as Verdict, n: 0 }
  return {
    st,
    api: {
      issueTrainJob: async (req: { haveVersion: number | null; batch: number }): Promise<TrainJob | null> => ({
        id: `tj${++st.n}`, kind: 'train', version: 3, weights: req.haveVersion === 3 ? null : 'AAAAAAAA', batch: req.batch, ctx: 16, x: 'AAAA', y: 'AA==', flops: 1e9, issuedAt: Date.now(),
      }),
      submitTrainResult: async () => ({ verdict: st.verdict, reason: `stub ${st.verdict}`, flops: 1e9, audited: st.verdict === 'audited' }),
      trainStats: () => ({ version: 3, gpuSteps: 0, serverSteps: 0, gpuSamples: 0, contributors24h: 0, audits: { ok: 0, failed: 0 }, gpuStepsPerMin: 0 }),
    },
  }
}

const WALLET = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV' // a valid base58 32-byte key shape
const SALT = Buffer.from('proof-test-salt')

function seedLedger(dir: string) {
  const now = Date.now()
  const acc = (key: string, kind: string, wallet: string | null, ink: number, verified: number, flops: number) => ({ key, kind, wallet, label: key, ink, flops, jobs: verified, verified, failed: 0, firstSeen: now, lastSeen: now, ...(kind === 'wallet' ? { walletVerified: true } : {}) })
  const ledger = {
    version: 1,
    updatedAt: now,
    totals: { jobsDone: 7, jobsVerified: 7, jobsFailed: 0, inkIssued: 42.5, inkPending: 0, inkForfeited: 0, flopsVerified: 7e9, dupsFound: 0 },
    leaderboard: [],
    accounts: {
      [`wallet:${WALLET}`]: acc(`wallet:${WALLET}`, 'wallet', WALLET, 30, 5, 5e9),
      'device:olddevice01': acc('device:olddevice01', 'device', null, 12.5, 2, 2e9),
    },
  }
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(ledger))
}

await test('genesis backfills balances; epochs commit confirmed credits only (escrow waits, forfeits never count); API auth', async () => {
  const dir = tmp('lusca-proofs-')
  seedLedger(dir)
  const crawler = createStubCrawler({ initialPages: 40 })
  const { st, api } = stubTrainer()
  const tokens = new Map([['tok-wallet', WALLET]])
  const checkToken = (t: unknown) => (typeof t === 'string' && tokens.has(t) ? { wallet: tokens.get(t)!, exp: Date.now() + 1e6 } : null)
  let clock = Date.UTC(2026, 9, 6, 8, 30)
  const mkCoord = () => createCoordinator({ crawler, emit: () => undefined, dataDir: dir, log: () => undefined, trainer: api, limits: { jobFillWaitMs: 0 }, auth: { checkToken } })
  const mkProofs = (c: ReturnType<typeof mkCoord>) => createProofs({ dataDir: dir, epochs: c.epochs, salt: SALT, epochMinutes: 60, checkToken, log: () => undefined, now: () => clock })
  let coord = mkCoord()
  let proofs = mkProofs(coord)
  proofs.start()
  proofs.stop()

  const g = proofs.header(0)!
  assert.ok(g, 'genesis written')
  assert.equal(g.leafCount, 2)
  assert.equal(g.totals.credits, 42_500_000)
  assert.equal(g.totals.ledgerCredits, 42_500_000)
  const gl = proofs.leaves(0)!
  assert.equal(gl.find((l) => l.id === walletIdentity(WALLET))?.credits, 30_000_000, 'wallet leaf = full balance')
  assert.equal(gl.find((l) => l.id === identityFor(SALT, 'device:olddevice01'))?.credits, 12_500_000)
  assert.deepEqual(coord.epochs.open(), { index: 1, startedAt: clock })

  // device neuron: 1 audited job (confirmed), 2 applied (escrow)
  const DEV = 'proofdev01'
  const c = fakeConn('p1', '10.7.0.1')
  coord.handle(c, { t: 'neuron.register', label: 'proof gpu', zone: 'EPI', gflops: 100, kind: 'browser', wallet: null, adapter: { deviceId: DEV } })
  await c.next('neuron.ok')
  const round = async (v: Verdict) => {
    st.verdict = v
    coord.handle(c, { t: 'job.request', caps: { train: true, version: 3 } })
    const job = (await c.next('job')) as Extract<ServerMsg, { t: 'job' }>
    coord.handle(c, { t: 'train.result', result: { id: job.job.id, kind: 'train', grad: 'AAAAAAAA', loss: 4.5, ms: 3 } })
    await new Promise((r) => setTimeout(r, 40))
  }
  const JOB = inkFor(1e9, 0)
  await round('audited')
  await round('applied')
  await round('applied')
  assert.equal(coord.balance(`device:${DEV}`)?.pendingInk, 2 * JOB)

  // not due yet: nothing closes
  assert.equal(proofs.tick(), null)
  clock = Date.UTC(2026, 9, 6, 9, 0, 1)
  const h1 = proofs.tick()!
  assert.equal(h1.index, 1)
  assert.equal(h1.startedAt, Date.UTC(2026, 9, 6, 8, 30))
  assert.equal(h1.leafCount, 1)
  const devId = identityFor(SALT, `device:${DEV}`)
  assert.equal(proofs.leaves(1)![0].id, devId)
  assert.equal(proofs.leaves(1)![0].credits, Math.round(JOB * 1e6), 'only the audited job; escrowed credits excluded')
  assert.equal(proofs.leaves(1)![0].jobs, 1)

  // an audit releases the escrow (2 + this job) → next epoch
  await round('audited')
  clock = Date.UTC(2026, 9, 6, 10, 0, 1)
  const h2 = proofs.tick()!
  assert.equal(h2.index, 2)
  assert.equal(h2.prevHeaderHash, h1.headerHash)
  assert.equal(proofs.leaves(2)![0].credits, Math.round(3 * JOB * 1e6), 'released escrow counted when confirmed')
  assert.equal(proofs.leaves(2)![0].jobs, 3)

  // escrow then a failed audit: forfeited credits never appear
  await round('applied')
  await round('audit-failed')
  assert.equal(coord.balance(`device:${DEV}`)?.pendingInk ?? 0, 0)
  clock = Date.UTC(2026, 9, 6, 11, 0, 1)
  const h3 = proofs.tick()!
  assert.equal(h3.leafCount, 0, 'forfeited escrow is never committed')
  assert.equal(h3.treeRoot, ZERO_HASH)

  // ── API: auth like account.watch ──
  const route = (p: string, method: string, body: unknown = null, q = '') => handleProofRoute(proofs, null, p, method, new URLSearchParams(q), body)
  assert.throws(() => route('/api/proofs/mine', 'POST', {}), (e: ProofRouteError) => e.status === 400)
  assert.throws(() => route('/api/proofs/mine', 'POST', { auth: 'forged' }), (e: ProofRouteError) => e.status === 401)
  assert.throws(() => route('/api/proofs/mine', 'GET'), (e: ProofRouteError) => e.status === 405)
  assert.throws(() => route('/api/proofs/1/proof', 'POST', { device: 'bad id!' }), (e: ProofRouteError) => e.status === 401)
  const mine = route('/api/proofs/mine', 'POST', { device: DEV, auth: 'tok-wallet' })!.body as { identities: { scope: string; id: string; epochs: number[] }[] }
  assert.deepEqual(mine.identities.map((i) => i.scope), ['wallet', 'device'])
  assert.deepEqual(mine.identities[1].epochs, [2, 1])
  assert.deepEqual(mine.identities[0].epochs, [0])
  const pr = route('/api/proofs/2/proof', 'POST', { device: DEV })!.body as { proofs: { leaf: ProofLeaf; leafHash: string; path: { h: string; side: 'L' | 'R' }[]; header: EpochHeader }[] }
  const p0 = pr.proofs[0]
  assert.equal(p0.leaf.id, devId)
  assert.equal((await walkPath(subtle, p0.leafHash, p0.path)).root, h2.treeRoot)
  const other = route('/api/proofs/2/proof', 'POST', { device: 'someoneelse1' })!.body as { proofs: { leaf: ProofLeaf | null }[] }
  assert.equal(other.proofs[0].leaf, null, 'another device sees no leaf, never someone else’s path')
  assert.throws(() => route('/api/proofs/99/proof', 'POST', { device: DEV }), (e: ProofRouteError) => e.status === 404)
  const pubRes = route('/api/proofs/2/leaves.json', 'GET')!
  assert.equal(pubRes.etag, `"${h2.headerHash.slice(0, 32)}"`, 'immutable leaves carry a validator')
  assert.equal(route('/api/proofs/2/leaves.json', 'GET')!.text, pubRes.text, 'serialized once, served from the cache')
  const pub = JSON.parse(pubRes.text!) as { leaves: ProofLeaf[]; treeRoot: string }
  assert.equal(await merkleRootAsync(subtle, 2, pub.leaves), pub.treeRoot, 'anyone can recompute the root from leaves.json')
  const page = route('/api/proofs', 'GET', null, 'limit=2')!.body as { headers: EpochHeader[]; next: number | null; status: { ok: boolean } }
  assert.deepEqual(page.headers.map((h) => h.index), [3, 2])
  assert.equal(page.next, 2)
  assert.equal(page.status.ok, true)
  assert.throws(() => route('/api/proofs', 'GET', null, 'limit=x'), (e: ProofRouteError) => e.status === 400)
  assert.throws(() => route('/api/proofs/preview', 'POST', { device: DEV }), (e: ProofRouteError) => e.status === 503)

  // ── hard kill with credits in the open epoch: the ledger file on disk is the truth ──
  await round('audited') // 1 job confirmed into epoch 4
  coord.flushSync() // what the debounced save does within 2 s
  const killed = fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8')
  await coord.stop()
  fs.writeFileSync(path.join(dir, 'ledger.json'), killed) // as if the process died right there
  coord = mkCoord()
  proofs = mkProofs(coord)
  proofs.start()
  proofs.stop()
  assert.equal(proofs.status().ok, true)
  assert.equal(proofs.status().head, 3, 'chain intact after restart')
  assert.equal(coord.epochs.open()?.index, 4)
  clock = Date.UTC(2026, 9, 6, 12, 0, 1)
  const h4 = proofs.tick()!
  assert.equal(h4.index, 4)
  assert.equal(proofs.leaves(4)![0].credits, Math.round(JOB * 1e6), 'open-epoch credits survived the kill')

  // ── kill between the ledger write-ahead and the epoch files: finished on restart ──
  await new Promise((r) => setTimeout(r, 10))
  const c2 = fakeConn('p2', '10.7.0.1')
  coord.handle(c2, { t: 'neuron.register', label: 'proof gpu', zone: 'EPI', gflops: 100, kind: 'browser', wallet: null, adapter: { deviceId: DEV } })
  await c2.next('neuron.ok')
  st.verdict = 'audited'
  coord.handle(c2, { t: 'job.request', caps: { train: true, version: 3 } })
  const job = (await c2.next('job')) as Extract<ServerMsg, { t: 'job' }>
  coord.handle(c2, { t: 'train.result', result: { id: job.job.id, kind: 'train', grad: 'AAAAAAAA', loss: 4.5, ms: 3 } })
  await new Promise((r) => setTimeout(r, 40))
  clock = Date.UTC(2026, 9, 6, 13, 0, 1)
  const built = { h: null as EpochHeader | null }
  const saved = coord.epochs.close(clock, (index, startedAt, rows) => {
    const leaves = [...rows].map(([k, r]) => ({ id: identityFor(SALT, k), credits: r.credits, jobs: r.jobs, flops: Math.round(r.flops) }))
    const e = buildEpoch(index, startedAt, clock, leaves, proofs.header(4), coord.epochs.ledgerCredits())
    built.h = e.header
    return e
  })
  assert.equal(saved, true)
  assert.ok(!fs.existsSync(path.join(dir, 'proofs', 'h-00000005.json')), 'files not written yet (simulated kill)')
  const wal = fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8')
  await coord.stop()
  fs.writeFileSync(path.join(dir, 'ledger.json'), wal)
  coord = mkCoord()
  proofs = mkProofs(coord)
  proofs.start()
  proofs.stop()
  assert.equal(proofs.header(5)?.headerHash, built.h!.headerHash, 'interrupted close finished from the write-ahead record')
  assert.equal(coord.epochs.closing(), null)
  assert.equal(coord.epochs.open()?.index, 6)
  assert.equal(proofs.status().ok, true)

  // ── a closed epoch is never rewritten; tampering on disk is reported at start ──
  const hf = path.join(dir, 'proofs', 'h-00000002.json')
  const orig = fs.readFileSync(hf, 'utf8')
  const bad = JSON.parse(orig) as EpochHeader
  bad.totals.credits += 1
  fs.writeFileSync(hf, JSON.stringify(bad))
  const logs: string[] = []
  const p3 = createProofs({ dataDir: dir, epochs: coord.epochs, salt: SALT, epochMinutes: 60, log: (_l, m) => logs.push(m), now: () => clock })
  p3.start()
  p3.stop()
  assert.equal(p3.status().ok, false)
  assert.match(p3.status().error ?? '', /epoch 2/)
  assert.ok(logs.some((m) => /PROOF CHAIN BROKEN/.test(m)), 'logged loudly')
  fs.writeFileSync(hf, orig)
  await coord.stop()
})

// ─── review fixes: save race, ledger-drop warning, missing chain, caches ─────

function devRig(dir: string) {
  const crawler = createStubCrawler({ initialPages: 40 })
  const { st, api } = stubTrainer()
  const mk = () => createCoordinator({ crawler, emit: () => undefined, dataDir: dir, log: () => undefined, trainer: api, limits: { jobFillWaitMs: 0 }, auth: { checkToken: () => null } })
  return { st, mk }
}

async function connect(coord: ReturnType<typeof createCoordinator>, cid: string, dev: string) {
  const c = fakeConn(cid, '10.9.0.1')
  coord.handle(c, { t: 'neuron.register', label: 'race', zone: 'EPI', gflops: 100, kind: 'browser', wallet: null, adapter: { deviceId: dev } })
  await c.next('neuron.ok')
  return async () => {
    coord.handle(c, { t: 'job.request', caps: { train: true, version: 3 } })
    const job = (await c.next('job')) as Extract<ServerMsg, { t: 'job' }>
    coord.handle(c, { t: 'train.result', result: { id: job.job.id, kind: 'train', grad: 'AAAAAAAA', loss: 4.5, ms: 3 } })
    await new Promise((r) => setTimeout(r, 30))
  }
}

const ledgerOnDisk = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8')) as { totals: { inkIssued: number }; epoch?: { index: number; closing?: unknown } }

await test('epoch close never races an in-flight async ledger save (the stale snapshot cannot land after the close)', async () => {
  const dir = tmp('lusca-race-')
  const { mk } = devRig(dir)
  let clock = Date.UTC(2026, 9, 6, 8, 30)
  const coord = mk()
  const proofs = createProofs({ dataDir: dir, epochs: coord.epochs, salt: SALT, epochMinutes: 60, log: () => undefined, now: () => clock })
  proofs.start()
  const round = await connect(coord, 'r1', 'racedevice01')
  for (let i = 0; i < 3; i++) await round()
  const realRename = fs.promises.rename
  let slow = true
  ;(fs.promises as { rename: typeof realRename }).rename = async (a, b) => {
    if (slow && String(b).endsWith('ledger.json')) await new Promise((r) => setTimeout(r, 2500))
    return realRename(a, b)
  }
  try {
    await new Promise((r) => setTimeout(r, 2150)) // the debounced async save is now in flight (slow rename)
    assert.equal(coord.epochs.busy?.(), true, 'async save in flight')
    for (let i = 0; i < 3; i++) await round() // credited while it is in flight
    clock = Date.UTC(2026, 9, 6, 9, 0, 1)
    assert.equal(coord.epochs.busy?.(), true, 'still in flight')
    assert.equal(proofs.tick(), null, 'no close while an async save is in flight')
    slow = false
    for (let i = 0; i < 60 && !proofs.header(1); i++) await new Promise((r) => setTimeout(r, 100))
    const h1 = proofs.header(1)
    assert.ok(h1, 'closed by the short retry once the save landed')
    await new Promise((r) => setTimeout(r, 300))
    const disk = ledgerOnDisk(dir)
    assert.equal(disk.epoch?.index, 2, 'ledger.json on disk is at or after the close')
    assert.ok(Math.round(disk.totals.inkIssued * 1e6) >= h1!.totals.ledgerCredits, 'the ledger on disk holds every credit the header committed')
  } finally {
    ;(fs.promises as { rename: typeof realRename }).rename = realRename
    proofs.stop()
    await coord.stop()
  }
})

await test('write generations: an async save that serialized before a sync save never renames over it', async () => {
  const dir = tmp('lusca-gen-')
  const { mk } = devRig(dir)
  const coord = mk()
  const proofs = createProofs({ dataDir: dir, epochs: coord.epochs, salt: SALT, epochMinutes: 60, log: () => undefined, now: () => Date.UTC(2026, 9, 6, 8, 30) })
  proofs.start()
  proofs.stop()
  const round = await connect(coord, 'g1', 'gendevice01')
  await round()
  const realCopy = fs.promises.copyFile
  const parked: { release: (() => void) | null } = { release: null }
  ;(fs.promises as { copyFile: typeof realCopy }).copyFile = async (a, b, m) => {
    if (String(a).endsWith('ledger.json')) await new Promise<void>((r) => (parked.release = r))
    return realCopy(a, b, m)
  }
  try {
    await new Promise((r) => setTimeout(r, 2150)) // async save serialized, now parked before its rename
    assert.ok(parked.release, 'async save parked')
    await round() // newer credit
    coord.flushSync() // synchronous save of the newer state lands first
    const synced = ledgerOnDisk(dir).totals.inkIssued
    parked.release!()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(ledgerOnDisk(dir).totals.inkIssued, synced, 'the older async snapshot was dropped, not renamed over the newer file')
  } finally {
    ;(fs.promises as { copyFile: typeof realCopy }).copyFile = realCopy
    await coord.stop()
  }
})

await test('a drop in ledger lifetime credits is a warning, not a broken chain', async () => {
  const chain = chainOf(4)
  const headers = chain.map((c) => c.header)
  const low = buildEpoch(4, 5000, 5999, [leaf(9)], headers[3], headers[3].totals.ledgerCredits - 1)
  assert.equal(checkEpoch(low.header, low.leaves, headers[3]), null)
  const r = await verifyHeadersAsync(subtle, [...headers, low.header])
  assert.equal(r.ok, true)
  assert.equal(r.warnings.length, 1)
  assert.equal(r.warnings[0].index, 4)
  // stored on disk: status stays ok, the warning is reported
  const dir = tmp('lusca-warn-')
  fs.mkdirSync(path.join(dir, 'proofs'))
  for (const e of [...chain, low]) {
    const pad = String(e.header.index).padStart(8, '0')
    fs.writeFileSync(path.join(dir, 'proofs', `l-${pad}.json`), JSON.stringify({ leaves: e.leaves.map((l) => [l.id, l.credits, l.jobs, l.flops]) }))
    fs.writeFileSync(path.join(dir, 'proofs', `h-${pad}.json`), JSON.stringify(e.header))
  }
  seedLedger(dir)
  const { mk } = devRig(dir)
  const coord = mk()
  const p = createProofs({ dataDir: dir, epochs: coord.epochs, salt: SALT, epochMinutes: 60, log: () => undefined, now: () => 10_000 })
  p.start()
  p.stop()
  assert.equal(p.status().ok, true)
  assert.equal(p.status().state, 'verified')
  assert.match(p.status().warning ?? '', /epoch 4: ledger lifetime credits went down/)
  await coord.stop()
})

await test('a missing chain is never silently restarted (proofs off until restored or LUSCA_PROOFS_RESTART)', async () => {
  const dir = tmp('lusca-missing-')
  seedLedger(dir)
  const { mk } = devRig(dir)
  let coord = mk()
  let clock = Date.UTC(2026, 9, 6, 8, 30)
  const mkP = (allowRestart = false) => createProofs({ dataDir: dir, epochs: coord.epochs, salt: SALT, epochMinutes: 60, allowRestart, log: () => undefined, now: () => clock })
  let p = mkP()
  p.start()
  clock = Date.UTC(2026, 9, 6, 9, 0, 1)
  assert.equal(p.tick()?.index, 1)
  p.stop()
  await coord.stop()
  fs.rmSync(path.join(dir, 'proofs'), { recursive: true, force: true })
  coord = mk()
  p = mkP()
  p.start()
  p.stop()
  assert.equal(p.status().ok, false)
  assert.equal(p.status().state, 'off')
  assert.equal(p.header(0), null, 'no new genesis written')
  assert.equal(fs.existsSync(path.join(dir, 'proofs', 'h-00000000.json')), false)
  p = mkP(true)
  p.start()
  p.stop()
  assert.equal(p.status().ok, true)
  assert.ok(p.header(0), 'explicit restart writes a new genesis')
  await coord.stop()
})

await test('cached tree levels give the same paths as the uncached tree (1..40 leaves)', () => {
  for (let n = 1; n <= 40; n++) {
    const o = orderLeaves(3, Array.from({ length: n }, (_, i) => leaf(i)))
    const levels = treeLevels(o.hashes)
    for (let i = 0; i < n; i++) assert.deepEqual(pathFromLevels(levels, i), merklePath(o.hashes, i))
  }
})

// ─── payout preview math = the payout engine's planPayout ──────────────────

await test('payout preview share uses planPayout exactly (own row independent of the others)', () => {
  const rules = { share: 1, reserveLamports: 0, maxLamports: 1e9, maxWalletLamports: 2e8, minLamports: 1e6 }
  const full = planPayout(1e9 + 10_000, [{ wallet: 'a', ink: 3 }, { wallet: 'b', ink: 5 }, { wallet: 'c', ink: 2 }], rules)
  const two = planPayout(1e9 + 10_000, [{ wallet: 'a', ink: 3 }, { wallet: '~rest', ink: 7 }], rules)
  assert.equal(two.rows[0].lamports, full.rows[0].lamports)
})

// ─── audit counters never go backwards ─────────────────────────────────────

await test('audit counter: persisted floor survives a hard kill and never decreases', () => {
  const dir = tmp('lusca-audits-')
  const a = createAuditCounter(dir)
  assert.deepEqual(a.observe({ ok: 10, failed: 1 }), { ok: 10, failed: 1 })
  assert.deepEqual(a.observe({ ok: 4, failed: 0 }), { ok: 10, failed: 1 }, 'a lower report (worker restored an older checkpoint) is not published')
  a.flushSync()
  const b = createAuditCounter(dir) // restart
  assert.deepEqual(b.floor(), { ok: 10, failed: 1 })
  assert.deepEqual(b.observe({ ok: 12, failed: 1 }), { ok: 12, failed: 1 })
  b.flushSync()
  fs.writeFileSync(path.join(dir, 'audits.json'), '{"ok":') // torn write: the .bak copy holds
  assert.deepEqual(createAuditCounter(dir).floor(), { ok: 10, failed: 1 })
})

// ─── held corpus vs lifetime ────────────────────────────────────────────────

await test('held corpus: rotation keeps archive totals, pruning subtracts them', async () => {
  const dir = tmp('lusca-held-')
  const line = (i: number) => ({ id: `p${i}`, url: `https://x.test/${i}`, host: 'x.test', title: 't', sector: 0, score: 1, tokens: 100, terms: [], ts: 1, text: 'x'.repeat(400) })
  const w = new DatasetWriter(dir, { maxBytes: 1500, keepArchives: 2, sectors: 8 })
  for (let i = 0; i < 12; i++) await w.append(line(i))
  await w.flush()
  const held = w.held()
  assert.ok(held.archives >= 2, `archives on disk (${held.archives})`)
  assert.ok(held.pages < 12, `pruned archives are not held (${held.pages} of 12)`)
  assert.equal(held.tokens, held.pages * 100)
  assert.equal(held.uncounted, 0)
  // restart: totals reloaded from dataset-archives.json
  const w2 = new DatasetWriter(dir, { maxBytes: 1500, keepArchives: 2, sectors: 8 })
  const h2 = w2.held()
  assert.equal(h2.archives, held.archives)
  assert.equal(h2.uncounted, 0)
})

console.log(`\n${passed} proof tests passed${process.exitCode ? ' — with failures' : ''}`)
process.exit(process.exitCode ?? 0)
