// Upgrade radar tests: loader log parsing, EVM proxy topics, classification, diffs, headline and
// priority, budgets (write-ahead, hourly share), the EVM endpoint pool (range errors, failover,
// batches), persistence (append log, torn lines, compaction, restart), the radar end to end with
// stub readers and a stub log endpoint, and the REST routes. No internet.
//   npx tsx server/radar/_test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChainId, ChainRead } from '../../shared/chain.ts'
import type { RadarEvent } from '../../shared/radar.ts'
import { BudgetError, type ChainRpc } from '../chain/rpc.ts'
import type { SolanaReadResult } from '../chain/solana.ts'
import type { EvmReadResult } from '../chain/evm.ts'
import {
  LOADER_V4,
  TOPIC_ADMIN_CHANGED,
  TOPIC_BEACON_UPGRADED,
  TOPIC_UPGRADED,
  UPGRADEABLE_LOADER,
  classifyProxyGroup,
  groupFacts,
  groupProxyLogs,
  headlineOf,
  interestingActions,
  loaderCandidates,
  parseLoaderLogs,
  parseProxyLog,
  priorityOf,
  setAuthorityTargets,
  txSigners,
} from './parse.ts'
import { diffSnapshots, type Snapshot } from './diff.ts'
import { RadarBudgetError, createRadarBudget } from './budget.ts'
import { RangeLimitError, createEvmPool, wsUrlOf } from './net.ts'
import { createEventLog, createSnapshotStore } from './persist.ts'
import { createRadar } from './index.ts'

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

const tmp = mkdtempSync(join(tmpdir(), 'lusca-radar-'))
let dirN = 0
const freshDir = () => {
  const d = join(tmp, `d${dirN++}`)
  mkdirSync(d, { recursive: true })
  return d
}
const quiet = () => {}

const PROG = 'Nio5Zfm8ECQcFLRTgngARTqLewvVB6Pb11t833LJJbQ'
const PROG2 = '6kWk2mEYSs2Xw58RnFNTuNbgHbeCLAtjeRndWetBRTfN'
const AUTH = 'bfQVv6niKVgEURYqQ1beJmiEQQN7MrvLRvk3mZGFubb'
const SQUADS = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf'
const SIG = '3p7aDTXGQQaYBH9uBz9x6EaFXVz2YH2hb6ZqXbXz3oJ1z3kVgxwZyW5h7Dq2eGQX4gY4bRbVqMEwDzx2h5YyQq3a'
const SIG2 = '2mTQWut2nC5MBH9uBz9x6EaFXVz2YH2hb6ZqXbXz3oJ1z3kVgxwZyW5h7Dq2eGQX4gY4bRbVqMEwDzx2h5YyQq3b'

const loaderInvoke = (lines: string[], depth = 1) => [`Program ${UPGRADEABLE_LOADER} invoke [${depth}]`, ...lines, `Program ${UPGRADEABLE_LOADER} success`]

// ─── Solana loader logs ─────────────────────────────────────────────────────

await test('loader logs: upgrade, deploy, authority (Some / None), closes, inside the loader only', () => {
  const up = parseLoaderLogs(['Program ComputeBudget111111111111111111111111111111 invoke [1]', 'Program ComputeBudget111111111111111111111111111111 success', ...loaderInvoke([`Upgraded program ${PROG}`])])
  assert.deepEqual(up, [{ type: 'upgraded', loader: 'v3', program: PROG }])
  const dep = parseLoaderLogs(loaderInvoke([`Deployed program ${PROG2}`]))
  assert.equal(dep[0].type, 'deployed')
  assert.equal(dep[0].program, PROG2)
  const auth = parseLoaderLogs(loaderInvoke([`New authority Some(${AUTH})`]))
  assert.deepEqual(auth, [{ type: 'authority', loader: 'v3', program: null, newAuthority: AUTH }])
  const none = parseLoaderLogs(loaderInvoke(['New authority None']))
  assert.equal(none[0].newAuthority, null)
  const closes = parseLoaderLogs(loaderInvoke([`Closed Program ${PROG}`, `Closed Buffer ${PROG2}`]))
  assert.equal(closes.length, 2)
  assert.deepEqual(
    interestingActions(closes).map((a) => [a.type, a.program]),
    [['closed', PROG]],
    'buffer closes are deploy plumbing',
  )
})

await test('loader logs: a program cannot fake a loader line (msg! output and lines outside the loader are ignored)', () => {
  const fake = parseLoaderLogs([
    `Program ${SQUADS} invoke [1]`,
    `Program log: Upgraded program ${PROG}`,
    `Upgraded program ${PROG}`, // raw line while another program executes
    `Program ${SQUADS} success`,
  ])
  assert.deepEqual(fake, [])
  // a multisig upgrading through CPI: the loader at depth 2 counts
  const cpi = parseLoaderLogs([`Program ${SQUADS} invoke [1]`, `Program log: Instruction: VaultTransactionExecute`, ...loaderInvoke([`Upgraded program ${PROG}`], 2), `Program ${SQUADS} success`])
  assert.deepEqual(cpi, [{ type: 'upgraded', loader: 'v3', program: PROG }])
  // loader v4 lines count too; junk addresses do not
  assert.equal(parseLoaderLogs([`Program ${LOADER_V4} invoke [1]`, `Deployed program ${PROG}`, `Program ${LOADER_V4} success`])[0].loader, 'v4')
  assert.deepEqual(parseLoaderLogs(loaderInvoke(['Upgraded program 0OIl'])), [])
  assert.deepEqual(parseLoaderLogs([null, 3, ...loaderInvoke([])] as unknown[]), [])
})

await test('loader signatures: the transactions alone in their slot are the candidates; failed ones skipped', () => {
  const sigs = [
    { signature: 'a', slot: 10, err: null },
    { signature: 'b', slot: 9, err: null },
    { signature: 'c', slot: 9, err: null },
    { signature: 'd', slot: 8, err: { InstructionError: [0, 'Custom'] } },
    { signature: 'e', slot: 7, err: null },
  ]
  assert.deepEqual(
    loaderCandidates(sigs).map((s) => s.signature),
    ['a', 'e'],
  )
})

/** base58 of bytes (tests only). */
function b58(bytes: number[]): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let s = ''
  while (n > 0n) {
    s = A[Number(n % 58n)] + s
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    s = `1${s}`
  }
  return s
}

await test('getTransaction: SetAuthority target account and signers', () => {
  const PD = PROG2
  const tx = {
    transaction: {
      message: {
        header: { numRequiredSignatures: 2 },
        accountKeys: [AUTH, SQUADS, PD, UPGRADEABLE_LOADER],
        instructions: [
          { programIdIndex: 3, accounts: [2, 0], data: b58([4, 0, 0, 0]) },
          { programIdIndex: 3, accounts: [1, 0], data: b58([3, 0, 0, 0]) }, // Upgrade: not an authority change
        ],
      },
    },
    meta: { innerInstructions: [{ instructions: [{ programIdIndex: 3, accounts: [1], data: b58([7, 0, 0, 0]) }] }] },
  }
  assert.deepEqual(setAuthorityTargets(tx), [PD, SQUADS])
  assert.deepEqual(txSigners(tx), [AUTH, SQUADS])
  assert.deepEqual(setAuthorityTargets(null), [])
  assert.deepEqual(setAuthorityTargets({ transaction: { message: { accountKeys: [AUTH], instructions: [] } } }), [])
})

// ─── EVM topics ─────────────────────────────────────────────────────────────

const PROXY = '0x1111111111111111111111111111111111111111'
const PROXY2 = '0x2222222222222222222222222222222222222222'
const IMPL_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const IMPL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ADMIN = '0xcccccccccccccccccccccccccccccccccccccccc'
const BEACON = '0xdddddddddddddddddddddddddddddddddddddddd'
const word = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`
const TX1 = `0x${'1'.repeat(64)}`
const TX2 = `0x${'2'.repeat(64)}`
const TX3 = `0x${'3'.repeat(64)}`
const log = (o: { address: string; topics: string[]; data?: string; tx: string; block: number; i?: number; ts?: number }) => ({
  address: o.address,
  topics: o.topics,
  data: o.data ?? '0x',
  transactionHash: o.tx,
  blockNumber: `0x${o.block.toString(16)}`,
  logIndex: `0x${(o.i ?? 0).toString(16)}`,
  removed: false,
  blockTimestamp: `0x${Math.floor((o.ts ?? 1_791_000_000_000) / 1000).toString(16)}`,
})

await test('EVM topics: Upgraded, AdminChanged (data), BeaconUpgraded; removed and malformed logs dropped', () => {
  const up = parseProxyLog(log({ address: PROXY.toUpperCase().replace('0X', '0x'), topics: [TOPIC_UPGRADED, word(IMPL_A)], tx: TX1, block: 100 }))
  assert.deepEqual(up, { type: 'upgraded', address: PROXY, tx: TX1, block: 100, logIndex: 0, implementation: IMPL_A })
  const adm = parseProxyLog(log({ address: PROXY, topics: [TOPIC_ADMIN_CHANGED], data: `0x${'0'.repeat(64)}${word(ADMIN).slice(2)}`, tx: TX1, block: 100, i: 1 }))
  assert.equal(adm?.type, 'admin')
  assert.equal(adm?.previousAdmin, null)
  assert.equal(adm?.newAdmin, ADMIN)
  const bc = parseProxyLog(log({ address: PROXY2, topics: [TOPIC_BEACON_UPGRADED, word(BEACON)], tx: TX2, block: 101 }))
  assert.equal(bc?.beacon, BEACON)
  assert.equal(parseProxyLog({ ...log({ address: PROXY, topics: [TOPIC_UPGRADED, word(IMPL_A)], tx: TX1, block: 1 }), removed: true }), null)
  assert.equal(parseProxyLog(log({ address: PROXY, topics: [TOPIC_UPGRADED, word('0x0000000000000000000000000000000000000000')], tx: TX1, block: 1 })), null)
  assert.equal(parseProxyLog(log({ address: 'nope', topics: [TOPIC_UPGRADED, word(IMPL_A)], tx: TX1, block: 1 })), null)
  assert.equal(parseProxyLog(log({ address: PROXY, topics: [TOPIC_ADMIN_CHANGED], data: '0x12', tx: TX1, block: 1 })), null)
  assert.equal(parseProxyLog({ address: PROXY, topics: ['0xdeadbeef'], transactionHash: TX1, blockNumber: '0x1' }), null)
})

await test('EVM classification: admin set from none or no code one block earlier → deploy; existing → upgrade; admin only → admin_change', () => {
  const l1 = parseProxyLog(log({ address: PROXY, topics: [TOPIC_UPGRADED, word(IMPL_A)], tx: TX1, block: 100 }))!
  const l2 = parseProxyLog(log({ address: PROXY, topics: [TOPIC_ADMIN_CHANGED], data: `0x${'0'.repeat(64)}${word(ADMIN).slice(2)}`, tx: TX1, block: 100, i: 1 }))!
  const l3 = parseProxyLog(log({ address: PROXY2, topics: [TOPIC_UPGRADED, word(IMPL_B)], tx: TX2, block: 99 }))!
  const l4 = parseProxyLog(log({ address: PROXY2, topics: [TOPIC_ADMIN_CHANGED], data: `0x${word(ADMIN).slice(2)}${word(IMPL_A).slice(2)}`, tx: TX3, block: 101 }))!
  const groups = groupProxyLogs([l1, l2, l3, l4])
  assert.deepEqual(
    groups.map((g) => [g.address, g.tx, g.logs.length]),
    [
      [PROXY2, TX2, 1],
      [PROXY, TX1, 2],
      [PROXY2, TX3, 1],
    ],
  )
  const [g2, g1, g3] = groups
  assert.equal(groupFacts(g1).adminFromNone, true)
  assert.equal(classifyProxyGroup(g1, null), 'deploy', 'TransparentUpgradeableProxy constructor')
  assert.equal(classifyProxyGroup(g2, false), 'deploy', 'no code one block earlier')
  assert.equal(classifyProxyGroup(g2, true), 'upgrade')
  assert.equal(classifyProxyGroup(g2, null), 'upgrade', 'unchecked: the event says Upgraded')
  assert.equal(classifyProxyGroup(g3, true), 'admin_change')
})

// ─── diffs, headline, priority ─────────────────────────────────────────────

const snap = (o: Partial<Snapshot>): Snapshot => ({
  chain: 'solana',
  address: PROG,
  at: 1000,
  codeHash: 'aa',
  authority: AUTH,
  upgradeable: true,
  verified: 'none',
  name: null,
  surface: ['init', 'swap'],
  guards: null,
  primitives: ['sha256'],
  deploySlot: 1,
  bytes: 100,
  ...o,
})

await test('diff: instructions added / removed, code and authority, primitives; unknown sides are never compared', () => {
  const d = diffSnapshots(snap({}), snap({ codeHash: 'bb', surface: ['init', 'swap', 'set_fee', 'pause'], primitives: ['sha256', 'secp256k1_recover'], at: 2000 }))
  assert.equal(d.code, 'changed')
  assert.equal(d.authority, 'same')
  assert.deepEqual(d.added, { items: ['set_fee', 'pause'], more: 0 })
  assert.deepEqual(d.removed, { items: [], more: 0 })
  assert.deepEqual(d.primitivesAdded, ['secp256k1_recover'])
  assert.equal(d.surface, 'instructions')
  const u = diffSnapshots(snap({ surface: null, codeHash: null, verified: 'unknown' }), snap({}))
  assert.equal(u.code, 'unknown')
  assert.equal(u.added, null)
  assert.equal(u.verified, 'unknown')
  const none = diffSnapshots(null, snap({}))
  assert.equal(none.code, 'unknown')
  assert.equal(none.added, null)
  // EVM: a function newly guarded, with its file:line
  const g1 = snap({ chain: 'ethereum', surface: ['deposit()'], guards: [{ fn: 'pause()', guard: 'onlyOwner', at: 'Vault.sol:10' }] })
  const g2 = snap({ chain: 'ethereum', surface: ['deposit()', 'setFee(uint256)'], guards: [{ fn: 'pause()', guard: 'onlyOwner', at: 'Vault.sol:12' }, { fn: 'setFee(uint256)', guard: 'onlyOwner', at: 'Vault.sol:20' }] })
  const de = diffSnapshots(g1, g2)
  assert.equal(de.surface, 'functions')
  assert.deepEqual(de.guardsAdded, [{ fn: 'setFee(uint256)', guard: 'onlyOwner', at: 'Vault.sol:20' }], 'a moved line is not a new guard')
  // long lists are capped with a count
  const big = diffSnapshots(snap({ surface: [] }), snap({ surface: Array.from({ length: 100 }, (_, i) => `ix${i}`) }))
  assert.equal(big.added?.items.length, 64)
  assert.equal(big.added?.more, 36)
})

await test('headline and priority: facts in one line; known protocols and bigger diffs rank first', () => {
  const after = { at: 2, from: 'read' as const, codeHash: 'bb', authority: AUTH, upgradeable: true, verified: 'none' as const, name: null, surfaceCount: 4 }
  const before = { ...after, from: 'radar' as const, codeHash: 'aa', surfaceCount: 2 }
  const diff = diffSnapshots(snap({}), snap({ codeHash: 'bb', surface: ['init', 'swap', 'set_fee', 'pause'], at: 2000 }))
  const base = { kind: 'upgrade' as const, chain: 'solana' as ChainId, count: 1, proxies: null, before, after, diff, state: 'read' as const, known: false }
  assert.equal(headlineOf(base), 'Upgraded · 2 instructions added · authority unchanged · verified: no')
  const known = priorityOf({ ...base, known: true })
  const plain = priorityOf(base)
  assert.ok(known > plain)
  const test = priorityOf({ ...base, kind: 'deploy', before: null, diff: null, after: { ...after, surfaceCount: null } })
  assert.ok(test < plain, 'a deploy with nothing published ranks low')
  assert.ok(priorityOf({ ...base, count: 8 }) < plain, 'repeated redeploys rank lower')
  assert.match(headlineOf({ ...base, kind: 'admin_change', chain: 'base', before: { ...before, authority: ADMIN }, after: { ...after, authority: null } }), /^Admin changed · 0xcc…cccc → none$/)
  assert.match(headlineOf({ ...base, state: 'pending' }), /reading…$/)
  const noIdl = diffSnapshots(snap({ surface: null }), snap({ codeHash: 'bb', surface: null, at: 2000 }))
  assert.equal(headlineOf({ ...base, diff: noIdl, before: { ...before, bytes: 1000 }, after: { ...after, bytes: 640 } }), 'Upgraded · code hash changed (−360 bytes) · authority unchanged · verified: no')
  assert.match(headlineOf({ ...base, kind: 'deploy', chain: 'base', proxies: { n: 3, sample: [] }, before: null, diff: null, after: { ...after, implementation: IMPL_A } }), /^Deployed · 3 proxies · → 0xaa…aaaa/)
})

// ─── budgets ────────────────────────────────────────────────────────────────

await test('budget: daily limit, hourly share, write-ahead persistence, day roll', () => {
  const dir = freshDir()
  const file = join(dir, 'budget.json')
  let t = Date.UTC(2026, 9, 6, 10, 0, 0)
  const b = createRadarBudget({ solana: 100, osec: 10 }, file, () => t, 0.2)
  for (let i = 0; i < 20; i++) b.charge('solana')
  assert.equal(b.why('solana'), 'hour')
  assert.throws(() => b.charge('solana'), (e: unknown) => e instanceof RadarBudgetError && e instanceof BudgetError && e.why === 'hour')
  // write-ahead: the file already holds at least what was charged
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { used: Record<string, number> }
  assert.ok(onDisk.used.solana >= 20)
  t += 3_600_000
  assert.equal(b.can('solana', 20), true)
  // restart: never lower than what was shown
  const b2 = createRadarBudget({ solana: 100, osec: 10 }, file, () => t, 0.2)
  assert.ok(b2.usage().solana.used >= 20)
  assert.throws(() => b2.charge('nope'), RadarBudgetError)
  t += 86_400_000
  assert.equal(b2.usage().solana.used, 0, 'a new UTC day starts at zero')
})

// ─── EVM endpoint pool ──────────────────────────────────────────────────────

function fakeFetch(handler: (url: string, body: unknown) => { status?: number; json: unknown }) {
  const calls: string[] = []
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push(u)
    const r = handler(u, JSON.parse(String(init?.body ?? 'null')))
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { f, calls }
}

await test('EVM pool: range refusals become RangeLimitError; failover with a breaker; batches charged per call', async () => {
  let charged = 0
  const { f, calls } = fakeFetch((url, body) => {
    if (url.startsWith('http://a.test')) return { status: 503, json: { error: { message: 'down' } } }
    if (Array.isArray(body)) return { json: body.map((c: { id: number; method: string }) => (c.method === 'eth_getCode' ? { jsonrpc: '2.0', id: c.id, result: '0x' } : { jsonrpc: '2.0', id: c.id, error: { message: 'missing trie node' } })) }
    const m = (body as { method: string }).method
    if (m === 'eth_getLogs') return { status: 413, json: { error: { code: -32614, message: 'eth_getLogs is limited to a 500 range' } } }
    return { json: { jsonrpc: '2.0', id: (body as { id: number }).id, result: '0x10' } }
  })
  let t = 0
  const pool = createEvmPool({ chain: 'base', urls: ['http://a.test/rpc?key=secret123456', 'http://b.test'], charge: (n) => (charged += n), fetch: f, now: () => t })
  assert.equal(await pool.call('eth_blockNumber', []), '0x10', 'the second endpoint answers')
  assert.equal(calls.length, 2)
  // the first is cooling down: not asked again
  assert.equal(await pool.call('eth_blockNumber', []), '0x10')
  assert.equal(calls.filter((u) => u.startsWith('http://a.test')).length, 1)
  await assert.rejects(pool.call('eth_getLogs', [{}]), RangeLimitError)
  const res = await pool.batch([
    { method: 'eth_getCode', params: [] },
    { method: 'eth_getStorageAt', params: [] },
  ])
  assert.deepEqual(res, [{ result: '0x' }, { error: 'missing trie node' }])
  assert.ok(charged >= 6)
  t += 10 * 60_000
  assert.equal(pool.up(), true)
  assert.equal(wsUrlOf('https://mainnet.helius-rpc.com/?api-key=abc'), 'wss://mainnet.helius-rpc.com/?api-key=abc')
  assert.equal(wsUrlOf('http://127.0.0.1:8899'), 'ws://127.0.0.1:8899/')
  assert.equal(wsUrlOf('nope'), null)
})

// ─── persistence ────────────────────────────────────────────────────────────

const mkEv = (id: string, ts: number, x: Partial<RadarEvent> = {}): RadarEvent => ({
  id,
  chain: 'solana',
  kind: 'upgrade',
  address: PROG,
  name: null,
  known: false,
  knownWhy: null,
  ts,
  seenAt: ts,
  slot: null,
  block: null,
  tx: null,
  count: 1,
  actor: null,
  actorRole: null,
  before: null,
  after: null,
  diff: null,
  headline: 'Upgraded',
  priority: 50,
  via: 'test',
  state: 'read',
  notes: [],
  updatedAt: ts,
  ...x,
})

await test('event log: last version of an id wins, a torn line is skipped, compaction keeps the newest', () => {
  const dir = freshDir()
  const file = join(dir, 'events.jsonl')
  const el = createEventLog(file, 3, quiet)
  el.append(mkEv('sol-a', 1))
  el.append(mkEv('sol-b', 2))
  el.append(mkEv('sol-a', 1, { count: 5 }))
  el.flush(() => [])
  appendFileSync(file, '{"id":"sol-torn","ts":') // a kill mid-append
  const back = createEventLog(file, 3, quiet).load()
  assert.deepEqual(
    back.map((e) => [e.id, e.count]),
    [
      ['sol-b', 1],
      ['sol-a', 5],
    ],
  )
  const el2 = createEventLog(file, 3, quiet)
  el2.load()
  const all = Array.from({ length: 10 }, (_, i) => mkEv(`sol-${i}`, 100 + i))
  for (const e of all) el2.append(e)
  el2.flush(() => all.slice().reverse().slice(0, 3))
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 3, 'compacted to the cap')
})

await test('snapshots: bounded LRU, programdata map, durable flush', () => {
  const dir = freshDir()
  const file = join(dir, 'snapshots.json')
  let t = 0
  const s = createSnapshotStore(file, 2, quiet, () => t)
  s.put('a', snap({}))
  s.put('b', snap({}))
  s.get('a')
  s.put('c', snap({}))
  assert.equal(s.get('b'), null, 'least recently used goes first')
  s.setProgramData('PD', PROG)
  t += 30_000
  s.flush()
  const s2 = createSnapshotStore(file, 2, quiet)
  assert.ok(s2.get('a') && s2.get('c'))
  assert.equal(s2.programOfData('PD'), PROG)
})

// ─── the radar end to end (stub readers, stub log endpoint) ─────────────────

function stubRpc(): ChainRpc & { callsMade: string[] } {
  const callsMade: string[] = []
  const usage = { solana: { used: 0, limit: 8000 }, ethereum: { used: 0, limit: 15000 }, base: { used: 0, limit: 15000 }, arbitrum: { used: 0, limit: 15000 }, sourcify: { used: 0, limit: 5000 }, osec: { used: 0, limit: 5000 } }
  return {
    callsMade,
    async call(chain, method) {
      callsMade.push(`${chain}:${method}`)
      if (method === 'getTransaction') return { blockTime: Math.floor(Date.now() / 1000), transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [AUTH, UPGRADEABLE_LOADER] } } }
      return null
    },
    async fetchJson() {
      return null
    },
    usage: () => usage,
    canSpend: () => true,
    budgetKey: (c) => (c === 'solana' ? 'solana' : c),
    remaining: () => 1000,
    msUntilReset: () => 1000,
    provider: (k) => (k === 'solana' ? 'Helius' : 'PublicNode'),
    flush() {},
    async close() {},
  } as ChainRpc & { callsMade: string[] }
}

function solRead(address: string, o: { codeHash: string; ix: string[] | null; authority?: string | null; verified?: boolean }): SolanaReadResult {
  const read: ChainRead = {
    chain: 'solana',
    address,
    kind: 'program',
    name: o.ix ? 'amm' : null,
    codeHash: o.codeHash,
    upgradeable: o.authority !== null,
    upgradeAuthority: o.authority === undefined ? AUTH : o.authority,
    lastDeploySlot: 5,
    programBytes: 1000,
    loader: 'bpf-upgradeable',
    idl: o.ix ? { name: 'amm', version: '0.1.0', instructions: o.ix.map((n) => ({ name: n, args: 0, accounts: 1 })), accounts: [], types: 0, errors: 0, events: 0 } : null,
    securityTxt: null,
    bytecodeBytes: null,
    proxy: null,
    abi: null,
    verified: o.verified ? { by: 'osec', match: 'full', repo: 'https://github.com/x/amm', commit: 'abc', compiler: null } : null,
    sources: [],
    notes: [],
    readAt: Date.now(),
    rpcCalls: 1,
  }
  return { read, idlJson: null }
}

await test('radar (Solana): an upgrade is read and diffed against the radar snapshot; repeats fold into one event', async () => {
  const dir = freshDir()
  const sent: RadarEvent[] = []
  let version = 0
  const reads = [
    { codeHash: 'h1', ix: ['init', 'swap'] },
    { codeHash: 'h2', ix: ['init', 'swap', 'set_fee'] },
    { codeHash: 'h3', ix: ['init', 'swap', 'set_fee', 'pause'] },
  ]
  const radar = createRadar({
    rpc: stubRpc(),
    store: { item: () => null, keptAt: () => null },
    dataDir: dir,
    log: quiet,
    broadcast: (m) => sent.push(m.event),
    chains: { solana: true, evm: [] },
    backfill: false,
    readSolana: async (a) => solRead(a, reads[Math.min(version, reads.length - 1)]),
  })
  // first sighting: the radar has no earlier state
  radar.ingestSolanaLogs({ signature: SIG, slot: 10, err: null, logs: loaderInvoke([`Upgraded program ${PROG}`]), loader: UPGRADEABLE_LOADER })
  await radar.idle()
  let page = radar.list({})
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].state, 'read')
  assert.equal(page.items[0].before, null)
  assert.equal(page.items[0].actor, AUTH)
  assert.equal(page.items[0].actorRole, 'signer')
  assert.match(page.items[0].headline, /no earlier state/)
  // a Write transaction (no loader line) is not an event; a failed upgrade is not either
  radar.ingestSolanaLogs({ signature: 'x', slot: 11, err: null, logs: loaderInvoke([]), loader: UPGRADEABLE_LOADER })
  radar.ingestSolanaLogs({ signature: 'y', slot: 11, err: { InstructionError: [0, 'Custom'] }, logs: loaderInvoke([`Upgraded program ${PROG2}`]), loader: UPGRADEABLE_LOADER })
  await radar.idle()
  assert.equal(radar.list({}).items.length, 1)
  // later upgrade: diffed against the snapshot, folded into the same event (deploy scripts repeat)
  version = 1
  radar.ingestSolanaLogs({ signature: SIG2, slot: 12, err: null, logs: loaderInvoke([`Upgraded program ${PROG}`]), loader: UPGRADEABLE_LOADER })
  await radar.idle()
  page = radar.list({})
  assert.equal(page.items.length, 1, 'folded into the recent event')
  const ev = page.items[0]
  assert.equal(ev.count, 2)
  assert.equal(ev.state, 'read')
  // the before of a folded event stays what LUSCA had before the first change of the burst
  assert.equal(ev.diff?.code, 'unknown')
  // the same signature twice (websocket + polling) is one change
  radar.ingestSolanaLogs({ signature: SIG2, slot: 12, err: null, logs: loaderInvoke([`Upgraded program ${PROG}`]), loader: UPGRADEABLE_LOADER })
  await radar.idle()
  assert.equal(radar.list({}).items[0].count, 2)
  // broadcasts are compact
  for (const e of sent) assert.ok(Buffer.byteLength(JSON.stringify({ t: 'radar', event: e })) < 8 * 1024)
  assert.ok(sent.some((e) => e.state === 'pending'), 'caught first, then read')
  await radar.stop()

  // restart: a new burst later diffs against the snapshot the radar kept
  const radar2 = createRadar({
    rpc: stubRpc(),
    store: { item: () => null, keptAt: () => null },
    dataDir: dir,
    log: quiet,
    broadcast: () => {},
    chains: { solana: true, evm: [] },
    backfill: false,
    timing: { coalesceMs: 0 },
    readSolana: async (a) => solRead(a, reads[2]),
  })
  assert.equal(radar2.list({}).items.length, 1, 'events survive a restart')
  radar2.ingestSolanaLogs({ signature: `${SIG2.slice(0, -1)}c`, slot: 20, err: null, logs: loaderInvoke([`Upgraded program ${PROG}`]), loader: UPGRADEABLE_LOADER })
  await radar2.idle()
  const top = radar2.list({}).items[0]
  assert.equal(top.diff?.code, 'changed')
  assert.deepEqual(top.diff?.added?.items, ['pause'])
  assert.equal(top.diff?.authority, 'same')
  assert.match(top.headline, /^Upgraded · 1 instruction added · authority unchanged · verified: no$/)
  assert.equal(top.before?.from, 'radar')
  await radar2.stop()
})

await test('radar (Solana): deploy, close and the chain index as the before; known protocol; pending survives a restart as partial', async () => {
  const dir = freshDir()
  const kept = solRead(PROG, { codeHash: 'old', ix: ['init'], verified: true }).read
  const radar = createRadar({
    rpc: stubRpc(),
    store: { item: (c, a) => (a === PROG ? { item: { chain: c, address: a, name: 'amm', kind: 'program', via: 'block', verifiedBy: 'osec', idl: true, sourceFiles: 0, sourceBytes: 0, codeHash: 'old', firstSeen: 1, readAt: 1000 }, read: kept } : null), keptAt: (_c, a) => (a === PROG ? 1000 : null) },
    dataDir: dir,
    log: quiet,
    broadcast: () => {},
    chains: { solana: true, evm: [] },
    backfill: false,
    readSolana: async (a) => solRead(a, { codeHash: 'new', ix: ['init', 'migrate'], verified: true }),
  })
  radar.ingestSolanaLogs({ signature: SIG, slot: 10, err: null, logs: loaderInvoke([`Upgraded program ${PROG}`]), loader: UPGRADEABLE_LOADER })
  radar.ingestSolanaLogs({ signature: SIG2, slot: 11, err: null, logs: loaderInvoke([`Deployed program ${PROG2}`]), loader: UPGRADEABLE_LOADER })
  await radar.idle()
  const items = radar.list({}).items
  const up = items.find((e) => e.address === PROG)!
  assert.equal(up.known, true)
  assert.equal(up.knownWhy, 'kept in the chain index')
  assert.equal(up.before?.from, 'chain-index')
  assert.equal(up.diff?.code, 'changed')
  assert.deepEqual(up.diff?.added?.items, ['migrate'])
  assert.equal(up.name, 'amm')
  const dep = items.find((e) => e.address === PROG2)!
  assert.equal(dep.kind, 'deploy')
  assert.equal(dep.before, null)
  assert.equal(radar.list({ known: true }).items.length, 1)
  assert.equal(radar.list({ kind: 'deploy' }).items.length, 1)
  // paging
  const p1 = radar.list({ limit: 1 })
  assert.ok(p1.next)
  const p2 = radar.list({ limit: 1, cursor: p1.next! })
  assert.notEqual(p2.items[0].id, p1.items[0].id)
  assert.equal(p2.next, null)
  // caught but not read when the server stops: partial after the restart, never "reading…" forever
  radar.ingestSolanaLogs({ signature: `${SIG.slice(0, -1)}z`, slot: 30, err: null, logs: loaderInvoke([`Closed Program ${PROG2}`]), loader: UPGRADEABLE_LOADER })
  await radar.stop()
  const radar2 = createRadar({ rpc: stubRpc(), store: { item: () => null, keptAt: () => null }, dataDir: dir, log: quiet, broadcast: () => {}, chains: { solana: true, evm: [] }, backfill: false })
  const closed = radar2.list({ kind: 'close' }).items[0]
  assert.equal(closed.state, 'partial')
  assert.match(closed.notes.join(' '), /restarted before the read/)
  await radar2.stop()
})

const VAULT_V1 = `pragma solidity ^0.8.0;
contract Vault {
    address owner;
    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }
    function deposit() external {}
    function pause() external onlyOwner {}
}
`
const VAULT_V2 = `pragma solidity ^0.8.0;
contract Vault {
    address owner;
    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }
    function deposit() external {}
    function pause() external onlyOwner {}
    function setFee(uint256 f) external onlyOwner {}
    function sweep(address to) external onlyOwner {}
}
`

function evmRead(address: string, src: string, fns: string[]): EvmReadResult {
  const read: ChainRead = {
    chain: 'ethereum',
    address,
    kind: 'contract',
    name: 'Vault',
    codeHash: `code-${address.slice(2, 6)}`,
    upgradeable: null,
    upgradeAuthority: null,
    lastDeploySlot: null,
    programBytes: null,
    loader: null,
    idl: null,
    securityTxt: null,
    bytecodeBytes: 2000,
    proxy: null,
    abi: { functions: fns, events: [] },
    verified: { by: 'sourcify', match: 'full', repo: null, commit: null, compiler: 'solc 0.8.20' },
    sources: [{ path: 'src/Vault.sol', lang: 'solidity', bytes: src.length }],
    notes: [],
    readAt: Date.now(),
    rpcCalls: 1,
  }
  return { read, abiJson: [], sources: [{ path: 'src/Vault.sol', text: src }], sourceBundleHash: null, profile: null }
}

await test('radar (EVM): deploys fold by implementation; an upgrade reads both implementations and lists new admin-only functions with file:line', async () => {
  const dir = freshDir()
  const PROXY3 = '0x3333333333333333333333333333333333333333'
  const { f } = fakeFetch((_url, body) => {
    const answer = (c: { id: number; method: string; params: unknown[] }) => {
      const addr = String(c.params[0]).toLowerCase()
      if (c.method === 'eth_getCode') return { jsonrpc: '2.0', id: c.id, result: addr === PROXY ? '0x6080604052' : '0x' }
      if (c.method === 'eth_getStorageAt') return { jsonrpc: '2.0', id: c.id, result: word(IMPL_A) }
      if (c.method === 'eth_getTransactionByHash') return { jsonrpc: '2.0', id: c.id, result: { from: ADMIN } }
      return { jsonrpc: '2.0', id: c.id, result: null }
    }
    return { json: Array.isArray(body) ? body.map(answer) : answer(body as never) }
  })
  const sent: RadarEvent[] = []
  const radar = createRadar({
    rpc: stubRpc(),
    store: { item: () => null, keptAt: () => null },
    dataDir: dir,
    log: quiet,
    broadcast: (m) => sent.push(m.event),
    chains: { solana: false, evm: ['ethereum'] },
    logEndpoints: { ethereum: ['http://127.0.0.1:9/rpc'] },
    fetch: f,
    backfill: false,
    readEvm: async (c, a, ctx) => (await ctx.call(c, 'eth_getCode', [a, 'latest']), a === IMPL_A ? evmRead(a, VAULT_V1, ['deposit()', 'pause()']) : evmRead(a, VAULT_V2, ['deposit()', 'pause()', 'setFee(uint256)', 'sweep(address)'])),
  })
  const T0 = 1_791_000_000_000
  await radar.ingestEvmLogs('ethereum', [
    // an existing proxy upgraded A → B
    log({ address: PROXY, topics: [TOPIC_UPGRADED, word(IMPL_B)], tx: TX1, block: 500, ts: T0 }),
    // two new proxies of implementation B (no code one block earlier)
    log({ address: PROXY2, topics: [TOPIC_UPGRADED, word(IMPL_B)], tx: TX2, block: 501, ts: T0 + 12_000 }),
    log({ address: PROXY3, topics: [TOPIC_UPGRADED, word(IMPL_B)], tx: TX3, block: 502, ts: T0 + 24_000 }),
  ])
  await radar.idle()
  const items = radar.list({ chain: 'ethereum' }).items
  const up = items.find((e) => e.kind === 'upgrade')!
  const dep = items.find((e) => e.kind === 'deploy')!
  assert.ok(up && dep)
  assert.equal(dep.proxies?.n, 2)
  assert.equal(up.before?.implementation, IMPL_A)
  assert.equal(up.after?.implementation, IMPL_B)
  assert.equal(up.actor, ADMIN)
  assert.equal(up.actorRole, 'sender')
  assert.equal(up.ts, T0)
  assert.equal(up.state, 'read')
  assert.deepEqual(up.diff?.added?.items, ['setFee(uint256)', 'sweep(address)'])
  assert.deepEqual(
    up.diff?.guardsAdded?.map((g) => [g.fn, g.at]),
    [
      ['setFee(uint256)', 'Vault.sol:7'],
      ['sweep(address)', 'Vault.sol:8'],
    ],
  )
  assert.match(up.headline, /^Upgraded · → 0xbb…bbbb · 2 functions added · 2 new admin-only functions · verified: Sourcify full$/)
  assert.equal(up.name, 'Vault')
  assert.ok(radar.get(up.id)?.trace?.length, 'the detail carries the calls the radar made')
  assert.equal(radar.list({}).items.find((e) => e.id === up.id)?.trace, undefined, 'the list does not')
  for (const e of sent) assert.ok(Buffer.byteLength(JSON.stringify({ t: 'radar', event: e })) < 8 * 1024)
  // the same window seen again (overlap) adds nothing
  await radar.ingestEvmLogs('ethereum', [log({ address: PROXY, topics: [TOPIC_UPGRADED, word(IMPL_B)], tx: TX1, block: 500, ts: T0 })])
  await radar.idle()
  assert.equal(radar.list({ chain: 'ethereum' }).items.length, 2)
  // an admin change needs no read
  await radar.ingestEvmLogs('ethereum', [log({ address: PROXY, topics: [TOPIC_ADMIN_CHANGED], data: `0x${word(ADMIN).slice(2)}${word(IMPL_A).slice(2)}`, tx: `0x${'4'.repeat(64)}`, block: 600, ts: T0 + 60_000 })])
  const adm = radar.list({ kind: 'admin_change' }).items[0]
  assert.equal(adm.before?.authority, ADMIN)
  assert.equal(adm.after?.authority, IMPL_A)
  assert.equal(adm.diff?.authority, 'changed')
  const st = radar.status()
  assert.equal(st.last24h.byChain.ethereum ?? 0, 0, 'fixture blocks are older than 24 h')
  await radar.stop()
})

await test('radar (EVM): a provider batch limit is learned; proxies that cannot be checked fold into one Upgraded event', async () => {
  const sizes: number[] = []
  const { f } = fakeFetch((_u, body) => {
    if (Array.isArray(body)) {
      sizes.push(body.length)
      if (body.length > 4) return { json: { jsonrpc: '2.0', id: null, error: { code: -32014, message: 'maximum 4 calls in 1 batch' } } }
      return { json: body.map((c: { id: number }) => ({ jsonrpc: '2.0', id: c.id, error: { message: 'missing trie node' } })) }
    }
    return { json: { jsonrpc: '2.0', id: (body as { id: number }).id, result: null } }
  })
  const radar = createRadar({
    rpc: stubRpc(),
    store: { item: () => null, keptAt: () => null },
    dataDir: freshDir(),
    log: quiet,
    broadcast: () => {},
    chains: { solana: false, evm: ['base'] },
    logEndpoints: { base: ['http://127.0.0.1:9/rpc'] },
    fetch: f,
    backfill: false,
    readEvm: async (c, a, ctx) => (await ctx.call(c, 'eth_getCode', [a, 'latest']), evmRead(a, VAULT_V2, ['deposit()'])),
  })
  const now = Date.now()
  const proxies = Array.from({ length: 12 }, (_, i) => `0x${(i + 16).toString(16).padStart(40, '0')}`)
  await radar.ingestEvmLogs(
    'base',
    proxies.map((p, i) => log({ address: p, topics: [TOPIC_UPGRADED, word(IMPL_B)], tx: `0x${(i + 16).toString(16).padStart(64, '0')}`, block: 900 + i, ts: now - 60_000 + i * 2000 })),
  )
  await radar.idle()
  assert.deepEqual(sizes, [10, 4, 4, 4], 'refused at 10, then 4 per batch')
  const items = radar.list({ chain: 'base' }).items
  assert.equal(items.length, 1)
  assert.equal(items[0].proxies?.n, 12)
  assert.match(items[0].headline, /^Upgraded event · 12 proxies · → 0xbb…bbbb · not checked: deployment or upgrade/)
  const st = radar.status()
  assert.equal(st.last24h.unchecked, 1)
  assert.equal(st.last24h.byKind.upgrade, undefined, 'not counted as an upgrade')
  await radar.stop()
})

// ─── REST ───────────────────────────────────────────────────────────────────

await test('REST: /api/radar pages and filters, /api/radar/:id detail, validation, 503 without the radar', async () => {
  const { createHub } = await import('../http.ts')
  const evs = [mkEv('sol-aaaaaaaa', Date.now(), { trace: [{ kind: 'rpc', method: 'getMultipleAccounts', target: 'x', provider: 'Helius', t: 0, ms: 3, ok: true, result: 'ok' }] }), mkEv('bas-bbbbbbbb', Date.now() - 1000, { chain: 'base', kind: 'deploy' })]
  const radar = {
    list: (q: { chain?: ChainId; kind?: string; known?: boolean; limit?: number; cursor?: string }) => ({
      items: evs.filter((e) => (!q.chain || e.chain === q.chain) && (!q.kind || e.kind === q.kind)).map(({ trace: _t, ...e }) => e as RadarEvent),
      next: null,
      status: { sources: {}, last24h: { total: 2, byKind: {}, byChain: {} }, backfill: {}, budget: {}, stored: 2, updatedAt: 0 },
    }),
    get: (id: string) => evs.find((e) => e.id === id) ?? null,
  }
  const hub = createHub({ distDir: null })
  hub.bind({ radar } as never)
  const port = await hub.listen(0, '127.0.0.1')
  const get = async (p: string) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`)
    return { status: r.status, body: (await r.json()) as Record<string, unknown> }
  }
  const all = await get('/api/radar')
  assert.equal(all.status, 200)
  assert.equal((all.body.items as unknown[]).length, 2)
  const base = await get('/api/radar?chain=base&kind=deploy&known=0&limit=5')
  assert.deepEqual((base.body.items as RadarEvent[]).map((e) => e.id), ['bas-bbbbbbbb'])
  assert.equal((await get('/api/radar?chain=doge')).status, 400)
  assert.equal((await get('/api/radar?kind=rug')).status, 400)
  assert.equal((await get('/api/radar?limit=0')).status, 400)
  assert.equal((await get('/api/radar?cursor=../../x')).status, 400)
  const one = await get('/api/radar/sol-aaaaaaaa')
  assert.equal(one.status, 200)
  assert.equal((one.body.trace as unknown[]).length, 1)
  assert.equal((await get('/api/radar/sol-zzzzzzzz')).status, 404)
  assert.equal((await get('/api/radar/..%2F..')).status, 404)
  await hub.close()
  const hub2 = createHub({ distDir: null })
  hub2.bind({} as never)
  const port2 = await hub2.listen(0, '127.0.0.1')
  assert.equal((await fetch(`http://127.0.0.1:${port2}/api/radar`)).status, 503)
  await hub2.close()
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
