// RADAR DIFF tests: npx tsx server/radar/_diff_test.ts
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diffLines, diffSources, isAccessLine, solFunctions } from './source-diff.ts'
import { createRadarDiff } from './code-diff.ts'
import { diffable, type RadarCodeDiff } from '../../shared/radarDiff.ts'
import type { RadarEvent } from '../../shared/radar.ts'

let n = 0
const t = async (name: string, f: () => void | Promise<void>) => {
  await f()
  n++
  console.log(`ok ${n} ${name}`)
}

const OLD = `// SPDX-License-Identifier: MIT\r\npragma solidity ^0.8.26;\r\n\r\ncontract Vault is Ownable {\r\n    uint256 public x;\r\n\r\n    function deposit(uint256 assets, address receiver) external returns (uint256) {\r\n        x += assets;\r\n        return x;\r\n    }\r\n\r\n    function close() external onlyOwner {\r\n        x = 0;\r\n    }\r\n\r\n    function gone() external {}\r\n}\r\n`
const NEW = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract Vault is Ownable {
    uint256 public x;

    function deposit(uint256 assets, address receiver) external returns (uint256) {
        require(msg.sender == receiver, "self");
        x += assets;
        return x;
    }

    function close() external onlyOwner {
        x = 0;
    }

    /// onlyOwner in a comment is not an access check
    function cancelClosing() external onlyOwner {
        x = 1;
    }
}
`

await t('line diff: insertions and deletions, line endings normalized by the caller', () => {
  const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])
  assert.deepEqual(ops.map((o) => o.t).join(''), ' -+  +')
  assert.equal(diffLines([], ['a']).length, 1)
  assert.equal(diffLines(['a'], []).length, 1)
})

await t('access lines: modifiers and msg.sender checks, comments excluded', () => {
  assert.ok(isAccessLine('    function close() external onlyOwner {'))
  assert.ok(isAccessLine('        require(msg.sender == owner, "no");'))
  assert.ok(isAccessLine('    function grant() external onlyRole(ADMIN_ROLE) {'))
  assert.ok(!isAccessLine('    /// onlyOwner can call'))
  assert.ok(!isAccessLine('        x += 1;'))
})

await t('solidity functions: signatures, lines, access', () => {
  const fns = solFunctions(NEW)
  const c = fns.find((f) => f.sig === 'cancelClosing()')
  assert.ok(c)
  assert.equal(c.line, 18)
  assert.equal(c.access, 'onlyOwner')
  assert.equal(c.contract, 'Vault')
  const d = fns.find((f) => f.sig === 'deposit(uint256,address)')
  assert.ok(d)
  assert.match(d.access ?? '', /msg\.sender == receiver/)
})

await t('diffSources: changed files only, functions added / removed / modified with file:line and hunks', () => {
  const r = diffSources({ 'src/v1/Vault.sol': OLD, 'src/Same.sol': 'contract S {}\n' }, { 'src/v2/Vault.sol': NEW, 'src/Same.sol': 'contract S {}\r\n' }, 200_000, 'Vault')
  assert.equal(r.unchangedFiles, 1)
  assert.equal(r.files.length, 1)
  const f = r.files[0]
  assert.equal(f.status, 'modified')
  assert.equal(f.oldPath, 'src/v1/Vault.sol')
  assert.ok(f.add > 0 && f.del > 0)
  const added = r.functions.find((x) => x.sig === 'cancelClosing()')
  assert.ok(added)
  assert.equal(added.change, 'added')
  assert.equal(added.at, 'Vault.sol:18')
  assert.equal(added.access, 'onlyOwner')
  assert.ok(added.hunk && f.hunks.some((h) => h.id === added.hunk))
  assert.equal(r.functions.find((x) => x.sig === 'gone()')?.change, 'removed')
  assert.equal(r.functions.find((x) => x.sig === 'deposit(uint256,address)')?.change, 'modified')
  assert.equal(r.functions.find((x) => x.sig === 'close()'), undefined)
  // line numbers both sides, access lines flagged
  const lines = f.hunks.flatMap((h) => h.lines)
  const req = lines.find((l) => l.s.includes('require(msg.sender'))
  assert.ok(req && req.t === '+' && req.n === 8 && req.o === null && req.ac === 1)
  assert.ok(!lines.find((l) => l.s.includes('/// onlyOwner'))?.ac)
})

await t('size bound: honest truncation note, counts stay complete', () => {
  const big = (k: number) => Array.from({ length: 4000 }, (_, i) => `line ${i} ${i % 7 === k ? 'changed' : ''}`).join('\n')
  const r = diffSources({ 'A.sol': big(0) }, { 'A.sol': big(1) }, 20_000)
  assert.ok(r.truncated && /not shown/.test(r.truncated))
  assert.ok(r.files[0].omitted && r.files[0].omitted.hunks > 0)
  assert.ok(r.totals.add > 500)
})

const ev = (over: Partial<RadarEvent> = {}): RadarEvent => ({
  id: 'eth-test0001',
  chain: 'ethereum',
  kind: 'upgrade',
  address: '0x936facdf10c8c36294e7b9d28345255539d81bc7',
  name: 'Vault',
  known: false,
  knownWhy: null,
  ts: 1,
  seenAt: 1,
  slot: null,
  block: 26136796,
  tx: '0x137a',
  count: 1,
  actor: null,
  actorRole: null,
  before: { at: 1, from: 'read', codeHash: 'a', authority: null, upgradeable: true, verified: 'sourcify-full', name: 'Vault', surfaceCount: 1, implementation: '0xe50554ec802375c9c3f9c087a8a7bb8c26d3dedf' },
  after: { at: 1, from: 'read', codeHash: 'b', authority: null, upgradeable: true, verified: 'sourcify-full', name: 'Vault', surfaceCount: 2, implementation: '0x8a051dd8f97b1725dc60f0f69cacc1d3e12ff92c' },
  diff: null,
  headline: '',
  priority: 1,
  via: 'test',
  state: 'read',
  notes: [],
  updatedAt: 1,
  ...over,
})

await t('diffable: EVM upgrades verified on Sourcify on both sides only', () => {
  assert.ok(diffable(ev()))
  assert.ok(!diffable(ev({ chain: 'solana' })))
  assert.ok(!diffable(ev({ kind: 'deploy' })))
  assert.ok(!diffable(ev({ after: { ...ev().after!, verified: 'none' } })))
})

await t('service: single-flight, two Sourcify calls ever (disk cache), Solana answered without calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radardiff-'))
  let calls = 0
  const rec = (src: string) => ({ match: 'exact_match', sources: { 'src/Vault.sol': { content: src } }, sourceIds: { 'src/Vault.sol': 0 }, compilation: { compiler: 'solc', compilerVersion: '0.8.26', name: 'Vault' } })
  const events: Record<string, RadarEvent> = { 'eth-test0001': ev(), 'sol-test0001': ev({ id: 'sol-test0001', chain: 'solana' }) }
  const mk = () =>
    createRadarDiff({
      rpc: {
        usage: () => ({}),
        fetchJson: async (url: string) => {
          calls++
          await new Promise((r) => setTimeout(r, 10))
          return rec(url.includes('0xe50554ec') ? OLD : NEW)
        },
      } as never,
      radar: { get: (id) => events[id] ?? null, list: () => ({ items: Object.values(events), next: null }) },
      dataDir: dir,
      log: () => {},
      backfill: false,
    })
  const s = mk()
  const [a, b] = await Promise.all([s.get('eth-test0001'), s.get('eth-test0001')])
  assert.equal(calls, 2)
  assert.ok(a && b && a.ready)
  const d = JSON.parse(a.json) as RadarCodeDiff
  assert.equal(d.state, 'ready')
  assert.equal(d.functions.find((f) => f.sig === 'cancelClosing()')?.at, 'Vault.sol:18')
  const s2 = mk() // restart: diff and sources from disk
  const again = await s2.get('eth-test0001')
  assert.ok(again?.ready)
  assert.equal(calls, 2)
  const sol = JSON.parse((await s2.get('sol-test0001'))!.json) as RadarCodeDiff
  assert.equal(sol.state, 'unavailable')
  assert.match(sol.reason ?? '', /source not published on-chain/)
  assert.equal(calls, 2)
  assert.equal(await s2.get('eth-nothere01'), null)
  await s.stop()
  await s2.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`radar diff: ${n} tests passed`)
