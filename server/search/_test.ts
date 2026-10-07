// CODE SEARCH tests: regex safety helpers, dedup, trigram prefilter (against a brute-force scan), regex time
// budget (worker terminated and replaced), caps and paging, filters, cache + per-address limit, snapshot reload,
// incremental updates, IDL documents.   npx tsx server/search/_test.ts
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import type { ChainId, ChainIndexItem } from '../../shared/chain.ts'
import type { SearchResult } from '../../shared/search.ts'
import { pathMatcher, refuseRegex, requiredRuns, trigramsOf } from './common.mjs'
import { createCodeSearch, normalizeQuery, type CodeSearch } from './index.ts'

let passed = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    console.error(`FAIL  ${name}`)
    throw e
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

interface Rec { chain: ChainId; address: string; name: string; readAt: number; sources?: { path: string; text: string }[]; idl?: unknown }

function writeStore(dir: string, recs: Rec[], shard = 'chain-000001.jsonl.gz') {
  const sd = path.join(dir, 'chain', 'shards')
  fs.mkdirSync(sd, { recursive: true })
  for (const r of recs) {
    const rec = { v: 1, chain: r.chain, address: r.address, name: r.name, kind: r.chain === 'solana' ? 'program' : 'contract', via: 'registry', codeHash: null, sourceBundleHash: null, verified: null, idl: r.idl ?? null, abi: null, sources: (r.sources ?? []).map((s) => ({ ...s, lang: s.path.endsWith('.vy') ? 'vyper' : 'solidity' })), sourcesNote: null, securityTxt: null, proxy: null, upgradeable: null, upgradeAuthority: null, lastDeploySlot: null, loader: null, programBytes: null, bytecodeBytes: null, notes: [], readAt: r.readAt }
    fs.appendFileSync(path.join(sd, shard), zlib.gzipSync(Buffer.from(`${JSON.stringify(rec)}\n`)))
  }
}

function sourceOf(list: () => Rec[]) {
  return {
    items: (q: { cursor?: string; limit?: number }) => {
      const all: ChainIndexItem[] = list().map((r) => ({ chain: r.chain, address: r.address, name: r.name, kind: r.chain === 'solana' ? 'program' : 'contract', via: 'registry', verifiedBy: 'sourcify', idl: !!r.idl, sourceFiles: r.sources?.length ?? 0, sourceBytes: 1, codeHash: null, firstSeen: r.readAt, readAt: r.readAt }))
      const start = q.cursor ? Number(q.cursor) : 0
      const lim = q.limit ?? 50
      return { items: all.slice(start, start + lim), next: start + lim < all.length ? String(start + lim) : null }
    },
  }
}

const log = (lvl: string, msg: string) => {
  if (lvl === 'error') console.error(msg)
}

async function ready(s: CodeSearch) {
  for (let i = 0; i < 400 && s.stats().state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 25))
  await new Promise((r) => setTimeout(r, 30))
  await s.idle()
  // deltas reach the query workers through the main thread: one turn of the event loop
  await new Promise((r) => setTimeout(r, 30))
}

const rnd = (() => {
  let x = 0x2545f491
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
})()
const WORDS = 'function return uint256 address mapping owner balance transfer delegatecall selfdestruct require emit event modifier onlyOwner _mint tx.origin msg.sender memory storage calldata payable external internal view pure'.split(' ')
const line = () => Array.from({ length: 3 + Math.floor(rnd() * 8) }, () => WORDS[Math.floor(rnd() * WORDS.length)] + (rnd() < 0.2 ? '(' : '')).join(rnd() < 0.5 ? ' ' : '  ')
const fileText = (n: number) => Array.from({ length: n }, line).join('\n')
const addr = (i: number) => `0x${crypto.createHash('sha1').update(String(i)).digest('hex').slice(0, 40)}`

/** Brute force over every (deduplicated) source: lines where a match starts (a regex may span lines). */
function brute(recs: Rec[], q: string, re: boolean, cs: boolean) {
  const rx = new RegExp(re ? q : q.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), `gm${cs ? '' : 'i'}`)
  const seen = new Set<string>()
  let matches = 0
  let files = 0
  for (const r of recs)
    for (const s of r.sources ?? []) {
      const t = s.text.replace(/\r\n?/g, '\n')
      if (seen.has(t)) continue
      seen.add(t)
      const lines = new Set<number>()
      for (const m of t.matchAll(rx)) lines.add(t.slice(0, m.index).split('\n').length)
      if (lines.size) files++
      matches += lines.size
    }
  return { matches, files }
}

// ─── tests ───────────────────────────────────────────────────────────────────

console.log('code search')

await test('requiredRuns: literal runs every match must contain', () => {
  assert.deepEqual(requiredRuns('selfdestruct'), ['selfdestruct'])
  assert.deepEqual(requiredRuns('delegatecall\\('), ['delegatecall('])
  assert.deepEqual(requiredRuns('function\\s+\\w*[Mm]int\\w*\\('), ['function', 'int'])
  assert.deepEqual(requiredRuns('onlyOwner[^{;]*\\{[^}]*_mint\\('), ['onlyOwner', '_mint('])
  assert.deepEqual(requiredRuns('foo|bar'), [])
  assert.deepEqual(requiredRuns('abcd?ef'), ['abc'])
  assert.deepEqual(requiredRuns('abcx+yz'), ['abcx'])
  assert.deepEqual(requiredRuns('(?:abc)def'), ['def'])
  assert.deepEqual(requiredRuns('tx\\.origin'), ['tx.origin'])
  assert.deepEqual(requiredRuns('a{2}bcd'), ['bcd'])
  assert.deepEqual(trigramsOf(['ab']), [])
  assert.equal(trigramsOf(['ABC'])[0], trigramsOf(['abc'])[0])
})

await test('refuseRegex: backreferences and nested quantifiers are refused, ordinary patterns pass', () => {
  assert.ok(refuseRegex('(a+)+'))
  assert.ok(refuseRegex('(a|b)*c'))
  assert.ok(refuseRegex('(\\w+\\s?)*$'))
  assert.ok(refuseRegex('(a)\\1'))
  assert.equal(refuseRegex('function\\s+\\w*[Mm]int\\w*\\('), null)
  assert.equal(refuseRegex('(foo|bar)baz'), null)
  assert.equal(refuseRegex('(ab)+c'), null)
  const e = normalizeQuery({ q: 'a*', re: true })
  assert.ok(!e.ok && e.code === 'refused', 'a pattern that matches the empty string is refused')
  const bad = normalizeQuery({ q: '([a-z', re: true })
  assert.ok(!bad.ok && bad.code === 'invalid')
  assert.ok(!normalizeQuery({ q: 'x' }).ok)
})

await test('pathMatcher: substring and glob', () => {
  assert.ok(pathMatcher('vault')!('contracts/Vault.sol'))
  assert.ok(pathMatcher('*.vy')!('contracts/pool.vy'))
  assert.ok(!pathMatcher('*.vy')!('contracts/pool.sol'))
  assert.ok(pathMatcher('src/**/*.sol')!('src/a/b/C.sol'))
  assert.ok(!pathMatcher('src/*.sol')!('src/a/C.sol'))
  assert.equal(pathMatcher(''), null)
})

// a synthetic corpus: 60 contracts on 3 chains, a shared library file in 40 of them, a file shared as CRLF / LF
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-search-'))
const LIB = `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nlibrary Address {\n  function functionDelegateCall(address target, bytes memory data) internal returns (bytes memory) {\n    (bool ok, bytes memory r) = target.delegatecall(data);\n    return r;\n  }\n}\n`
const SHARED_CUSTOM = `contract Pool {\n  function kill() external onlyOwner {\n    selfdestruct(payable(owner));\n  }\n}\n`
const CHAIN3: ChainId[] = ['ethereum', 'base', 'arbitrum']
const recs: Rec[] = []
for (let i = 0; i < 60; i++) {
  const sources = [{ path: `contracts/C${i}.sol`, text: `contract C${i} {\n${fileText(30 + (i % 7) * 10)}\n}\n` }]
  if (i < 40) sources.push({ path: i % 2 ? '@openzeppelin/contracts/utils/Address.sol' : 'lib/openzeppelin-contracts/contracts/utils/Address.sol', text: LIB })
  if (i >= 50) sources.push({ path: `src/Pool${i}.sol`, text: i % 2 ? SHARED_CUSTOM.replace(/\n/g, '\r\n') : SHARED_CUSTOM })
  if (i === 7) sources.push({ path: 'contracts/vyper/Vault.vy', text: '@external\ndef withdraw(amount: uint256):\n    send(msg.sender, amount)\n' })
  recs.push({ chain: CHAIN3[i % 3], address: addr(i), name: `C${i}`, readAt: 1_700_000_000_000 + i, sources })
}
recs.push({
  chain: 'solana',
  address: 'Sw1ft1111111111111111111111111111111111111',
  name: 'swift_pool',
  readAt: 1_700_000_100_000,
  idl: { metadata: { name: 'swift_pool', version: '0.1.0' }, instructions: [{ name: 'initialize_pool', accounts: [{ name: 'pool' }, { name: 'authority' }], args: [{ name: 'fee_bps', type: 'u16' }] }, { name: 'withdraw_fees', accounts: [], args: [] }], accounts: [{ name: 'Pool' }], errors: [{ code: 6000, name: 'InvalidFee', msg: 'fee too high' }] },
})
recs.push({ chain: 'solana', address: 'Sw1ft2222222222222222222222222222222222222', name: 'swift_pool_fork', readAt: 1_700_000_100_001, idl: recs[recs.length - 1].idl })
writeStore(tmp, recs)
// a protocol code index file listing the vyper vault's sha256 prefix
fs.mkdirSync(path.join(tmp, 'code'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'code', 'x__vault.1.sha'), crypto.createHash('sha256').update('@external\ndef withdraw(amount: uint256):\n    send(msg.sender, amount)\n').digest().subarray(0, 16))

let live = recs.slice()
let s = createCodeSearch({ source: sourceOf(() => live), dataDir: tmp, log, startDelayMs: 0, syncMs: 100, hardMs: 600, perIpPerMin: 1000, saveDelayMs: 0, builderIdleMs: 150 })
s.start()
await ready(s)

await test('dedup: a file shared by 40 contracts is stored once and counted per contract and chain', async () => {
  const st = s.stats()
  assert.equal(st.contracts, 60)
  assert.equal(st.programs, 2)
  // 60 own files + Address.sol + Pool (CRLF and LF variants deduplicate) + Vault.vy
  assert.equal(st.uniqueFiles, 63)
  assert.equal(st.fileRefs, 60 + 40 + 10 + 1)
  assert.equal(st.top[0].contracts, 40)
  assert.deepEqual(st.top[0].chains, { ethereum: 14, base: 13, arbitrum: 13 })
  const r = await s.search({ q: 'target.delegatecall(data)' })
  assert.equal(r.error, null)
  assert.equal(r.total.files, 1)
  assert.equal(r.total.contracts, 40)
  const f = r.groups[0].files[0]
  assert.equal(f.shared.contracts, 40)
  assert.equal(f.library, true)
  assert.equal(f.alsoIn.length, 8)
  assert.equal(f.blocks[0].find((l) => l.hits.length)!.n, 5)
  const pool = await s.search({ q: 'selfdestruct(payable(owner))', case: true })
  assert.equal(pool.total.files, 1, 'CRLF and LF copies are one file')
  assert.equal(pool.total.contracts, 10)
  // a regex match over two lines counts once (on its first line) and highlights both
  const two = await s.search({ q: 'onlyOwner \\{\\s*selfdestruct', re: true })
  assert.equal(two.total.matches, 1)
  const lines = two.groups[0].files[0].blocks.flat()
  assert.deepEqual(lines.filter((l) => l.hits.length).map((l) => l.n), [2, 3])
})

await test('trigram prefilter: same totals as a brute-force scan (no false negatives)', async () => {
  const queries: [string, boolean, boolean][] = [
    ['selfdestruct', false, false],
    ['delegatecall(', false, false],
    ['tx.origin', false, false],
    ['ONLYOWNER', false, false],
    ['ONLYOWNER', false, true],
    ['msg.sender memory', false, false],
    ['function\\s+\\w*[Mm]int', true, false],
    ['onlyOwner[^{;]*_mint\\(', true, false],
    ['^contract C1\\d', true, true],
    ['payable|pure', true, false],
    ['zz', false, false],
  ]
  for (let i = 0; i < 25; i++) {
    const r = recs[Math.floor(rnd() * 60)]
    const t = r.sources![0].text
    const at = Math.floor(rnd() * (t.length - 12))
    const q = t.slice(at, at + 3 + Math.floor(rnd() * 9)).split('\n')[0]
    if (q.trim().length >= 2) queries.push([q, false, rnd() < 0.5])
  }
  let pruned = 0
  for (const [q, re, cs] of queries) {
    const r = await s.search({ q, re, case: cs })
    assert.equal(r.error, null, `${q}: ${r.error?.message}`)
    const b = brute(recs, q, re, cs)
    assert.equal(r.total.matches, b.matches, `matches for ${JSON.stringify(q)}`)
    assert.equal(r.total.files, b.files, `files for ${JSON.stringify(q)}`)
    if (r.scanned.files < r.scanned.ofFiles) pruned++
  }
  assert.ok(pruned >= queries.length / 3, `the prefilter skipped files for ${pruned} of ${queries.length} queries`)
  const rare = await s.search({ q: 'selfdestruct(payable' })
  assert.ok(rare.scanned.files <= 3, `a rare literal scans few files (${rare.scanned.files})`)
})

await test('filters: chain, custom only, path glob, language', async () => {
  const all = await s.search({ q: 'delegatecall(data)' })
  const base = await s.search({ q: 'delegatecall(data)', chain: 'base' })
  assert.equal(all.total.contracts, 40)
  assert.equal(base.total.contracts, 13)
  assert.deepEqual(base.total.chains, { base: 13 })
  const custom = await s.search({ q: 'delegatecall(data)', custom: true })
  assert.equal(custom.total.files, 0, 'library paths are left out')
  const vy = await s.search({ q: 'withdraw' })
  assert.ok(vy.total.files >= 1)
  const vyCustom = await s.search({ q: 'def withdraw', custom: true })
  assert.equal(vyCustom.total.files, 0, 'a file in the protocol code index is not custom')
  const lang = await s.search({ q: 'def withdraw', lang: 'vyper' })
  assert.equal(lang.total.files, 1)
  const langSol = await s.search({ q: 'def withdraw', lang: 'solidity' })
  assert.equal(langSol.total.files, 0)
  const glob = await s.search({ q: 'selfdestruct(payable', path: 'src/Pool5*.sol' })
  assert.equal(glob.total.contracts, 10)
  const glob2 = await s.search({ q: 'selfdestruct(payable', path: 'src/Pool51.sol' })
  assert.equal(glob2.total.contracts, 1)
  const sol = await s.search({ q: 'withdraw', chain: 'solana' })
  assert.equal(sol.total.files, 0)
  assert.equal(sol.total.programs, 2)
})

await test('IDL documents: instruction / account / error names, same IDL counted once', async () => {
  const r = await s.search({ q: 'initialize_pool' })
  assert.equal(r.idl.length, 1)
  assert.equal(r.idl[0].sharedPrograms, 2)
  assert.equal(r.idl[0].entries[0].kind, 'instruction')
  assert.match(r.idl[0].entries[0].text, /initialize_pool\(fee_bps: u16\) accounts: pool, authority/)
  const [a, b] = r.idl[0].entries[0].hits[0]
  assert.equal(r.idl[0].entries[0].text.slice(a, b), 'initialize_pool')
  const e = await s.search({ q: 'InvalidFee' })
  assert.equal(e.idl[0].entries[0].kind, 'error')
})

await test('caps and paging: totals stop at the cap and say so; pages do not repeat files', async () => {
  const many = await s.search({ q: 'contract C' })
  assert.equal(many.total.files, 60)
  assert.ok(many.next)
  const files1 = many.groups.flatMap((g) => g.files.map((f) => f.id))
  assert.equal(files1.length, 10)
  const p2 = await s.search({ q: 'contract C', cursor: many.next })
  const files2 = p2.groups.flatMap((g) => g.files.map((f) => f.id))
  assert.equal(files2.length, 10)
  assert.equal(files1.filter((x) => files2.includes(x)).length, 0)
  // the builder left once idle with everything saved (its memory goes with it) …
  for (let i = 0; i < 200 && (await s.heaps())[0] !== 0; i++) await new Promise((r) => setTimeout(r, 25))
  assert.equal((await s.heaps())[0], 0, 'the idle builder exited')
  assert.ok(fs.existsSync(path.join(tmp, 'search', 'index.v2.gz')), 'after saving its snapshot')
  // … and the next change starts a new one from the deltas the main thread keeps (no shard re-read of old items)
  // > 20 000 matching lines: counting stops, capped = true
  const big = Array.from({ length: 12_000 }, (_, i) => `uint256 constant K${i} = ${i};`).join('\n')
  live = live.concat([
    { chain: 'base', address: addr(900), name: 'Big1', readAt: 1_800_000_000_000, sources: [{ path: 'Big1.sol', text: big }] },
    { chain: 'base', address: addr(901), name: 'Big2', readAt: 1_800_000_000_001, sources: [{ path: 'Big2.sol', text: `${big}\n// two` }] },
  ])
  writeStore(tmp, live.slice(-2), 'chain-000002.jsonl.gz')
  await new Promise((r) => setTimeout(r, 250))
  await s.idle()
  await new Promise((r) => setTimeout(r, 50))
  const capped = await s.search({ q: 'uint256 constant' })
  assert.equal(capped.error, null)
  assert.equal(capped.total.capped, true)
  assert.equal(capped.total.matches, 20_000)
  const blocks = capped.groups[0].files[0].blocks
  assert.ok(blocks.flat().length <= 4 * 5, 'snippets stay small')
})

await test('incremental: a newly kept item is searchable after the next sync', async () => {
  const r = await s.search({ q: 'uint256 constant K11999' })
  assert.equal(r.total.contracts, 2)
  assert.ok(s.stats().contracts >= 62)
})

await test('regex time budget: a runaway pattern is stopped, the worker replaced, the next query answers', async () => {
  const slow = 'a'.repeat(30_000)
  live = live.concat([{ chain: 'ethereum', address: addr(950), name: 'Slow', readAt: 1_800_000_000_100, sources: [{ path: 'Slow.sol', text: `// ${slow}\n` }] }])
  writeStore(tmp, live.slice(-1), 'chain-000003.jsonl.gz')
  await new Promise((r) => setTimeout(r, 250))
  await s.idle()
  await new Promise((r) => setTimeout(r, 50))
  const t0 = Date.now()
  const r = await s.search({ q: '\\w*\\w*\\w*\\w*\\w*\\w*\\w*!', re: true })
  const ms = Date.now() - t0
  assert.equal(r.error?.code, 'timeout', JSON.stringify(r.error))
  assert.ok(ms < 2000, `stopped after ${ms} ms`)
  for (let i = 0; i < 3; i++) {
    const ok = await s.search({ q: 'selfdestruct(payable' })
    assert.equal(ok.error, null)
    assert.equal(ok.total.contracts, 10)
  }
})

await test('route: validation, cache, per-address limit', async () => {
  const bad = await s.route('/api/search', new URLSearchParams({ q: '(a+)+', re: '1' }), '1.1.1.1')
  assert.equal(bad.status, 400)
  assert.equal((JSON.parse(bad.json) as SearchResult).error?.code, 'refused')
  const a = await s.route('/api/search', new URLSearchParams({ q: 'tx.origin' }), '1.1.1.1')
  assert.equal(a.status, 200)
  assert.equal((JSON.parse(a.json) as SearchResult).cached, false)
  const b = await s.route('/api/search', new URLSearchParams({ q: 'tx.origin' }), '1.1.1.1')
  assert.equal((JSON.parse(b.json) as SearchResult).cached, true)
  const lib = (await s.search({ q: 'target.delegatecall(data)' })).groups[0].files[0]
  const fr = await s.route('/api/search/file', new URLSearchParams({ id: String(lib.id) }), '1.1.1.1')
  assert.equal(fr.status, 200)
  const full = JSON.parse(fr.json).file
  assert.equal(full.contracts, 40)
  assert.equal(full.list.length, 40)
  assert.deepEqual(full.chains, { ethereum: 14, base: 13, arbitrum: 13 })
  assert.equal((await s.route('/api/search/file', new URLSearchParams({ id: '99999' }), '1.1.1.1')).status, 404)
  assert.equal((await s.route('/api/search/file', new URLSearchParams({ id: 'x' }), '1.1.1.1')).status, 400)
  const poolHit = (await s.search({ q: 'selfdestruct(payable(owner))' })).groups[0].files[0]
  const src = await s.route('/api/search/source', new URLSearchParams({ id: String(poolHit.id), q: 'selfdestruct' }), '1.1.1.1')
  assert.equal(src.status, 200)
  const sj = JSON.parse(src.json)
  assert.match(sj.source.text, /^contract Pool \{/)
  assert.equal(sj.source.contracts, 10)
  assert.deepEqual(sj.marks.map((m: { n: number }) => m.n), [3])
  assert.equal(sj.matches, 1)
  assert.equal((await s.route('/api/search/source', new URLSearchParams({ id: '99999' }), '1.1.1.1')).status, 404)
  const st = await s.route('/api/search/stats', new URLSearchParams(), '1.1.1.1')
  assert.equal(st.status, 200)
  assert.ok(JSON.parse(st.json).uniqueFiles > 60)
  await s.stop()
  const lim = createCodeSearch({ source: sourceOf(() => live), dataDir: tmp, log, startDelayMs: 0, perIpPerMin: 2, saveDelayMs: 0 })
  lim.start()
  await ready(lim)
  assert.equal((await lim.route('/api/search', new URLSearchParams({ q: 'abc1' }), '2.2.2.2')).status, 200)
  assert.equal((await lim.route('/api/search', new URLSearchParams({ q: 'abc2' }), '2.2.2.2')).status, 200)
  assert.equal((await lim.route('/api/search', new URLSearchParams({ q: 'abc3' }), '2.2.2.2')).status, 429)
  assert.equal((await lim.route('/api/search', new URLSearchParams({ q: 'abc1' }), '2.2.2.2')).status, 200, 'cached answers do not count')
  assert.equal((await lim.route('/api/search', new URLSearchParams({ q: 'abc3' }), '3.3.3.3')).status, 200, 'another address has its own budget')
  s = lim
})

await test('snapshot: a restart loads the gzip snapshot and answers the same', async () => {
  await s.save()
  const snap = path.join(tmp, 'search', 'index.v2.gz')
  assert.ok(fs.existsSync(snap))
  const before = await s.search({ q: 'delegatecall(data)', chain: 'arbitrum' })
  await s.stop()
  let logs = ''
  const again = createCodeSearch({ source: sourceOf(() => live), dataDir: tmp, log: (_l, m) => (logs += `${m}\n`), startDelayMs: 0, syncMs: 100, saveDelayMs: 0 })
  again.start()
  await ready(again)
  assert.match(logs, /snapshot loaded/)
  assert.doesNotMatch(logs, /\+\d+ kept item/, 'nothing re-read from the shards')
  const after = await again.search({ q: 'delegatecall(data)', chain: 'arbitrum' })
  assert.deepEqual(after.total, before.total)
  assert.equal(again.stats().uniqueFiles, s.stats().uniqueFiles)
  // an item that is no longer kept leaves the results
  live = live.filter((r) => r.name !== 'C1')
  await new Promise((r) => setTimeout(r, 300))
  await again.idle()
  await new Promise((r) => setTimeout(r, 50))
  const gone = await again.search({ q: 'delegatecall(data)' })
  assert.equal(gone.total.contracts, 39)
  await again.stop()
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`code search: ${passed} passed`)
process.exit(0)
