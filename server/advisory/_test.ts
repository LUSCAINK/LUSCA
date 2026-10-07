// ADVISORY CHECK tests: npx tsx server/advisory/_test.ts
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChainId, ChainIndexItem } from '../../shared/chain.ts'
import { ADVISORY_SCOPE, type AdvisoryItem, type AdvisoryList, type AdvisorySummary } from '../../shared/advisory.ts'
import { cmpVer, fileHash, inRange, normalizeSource, ozHeader, packIdx, rangeLabel, solcVersionOf, unpackIdx } from './core.ts'
import { buildDataset, loadDataset, onlyAffected, preOfIntroduced, rangeVersion, releasesLabel, type AdvisoryDoc, type FingerprintDoc, type SolcDoc } from './dataset.ts'
import { anchorLine, checkSources } from './match.ts'
import { createAdvisoryCheck } from './index.ts'

let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

// ── a small synthetic world: one package, four releases, one file in three copies ──
const HDR = (v: string) => `// SPDX-License-Identifier: MIT\n// OpenZeppelin Contracts (last updated v${v}) (utils/Thing.sol)\n\npragma solidity ^0.8.0;\n\n`
const COPY_A = `${HDR('4.0.0')}library Thing {\n    function run(uint256 x) internal pure returns (uint256) {\n        return x;\n    }\n}\n`
const COPY_B = `${HDR('4.2.0')}library Thing {\n    function run(uint256 x) internal pure returns (uint256) {\n        return x + 0;\n    }\n}\n`
const COPY_C = `${HDR('4.3.0')}library Thing {\n    function run(uint256 x) internal pure returns (uint256) {\n        return x + 1;\n    }\n}\n`
const OTHER = `// SPDX-License-Identifier: MIT\n// OpenZeppelin Contracts (last updated v4.0.0) (utils/Other.sol)\npragma solidity ^0.8.0;\ncontract Other {}\n`
const VERSIONS = ['4.0.0-rc.0', '4.0.0', '4.1.0', '4.2.0', '4.3.0']
const fp: FingerprintDoc = {
  v: 1,
  generatedAt: '2026-10-06T00:00:00.000Z',
  packages: [{ name: '@openzeppelin/contracts', versions: VERSIONS }],
  stats: { versions: 5, solFiles: 8, uniqueFiles: 4, bytes: 1000 },
  files: {
    [fileHash(COPY_A)]: [[0, 'utils/Thing.sol', '4.0.0|utils/Thing.sol', packIdx([0, 1, 2])]],
    [fileHash(COPY_B)]: [[0, 'utils/Thing.sol', '4.2.0|utils/Thing.sol', packIdx([3])]],
    [fileHash(COPY_C)]: [[0, 'utils/Thing.sol', '4.3.0|utils/Thing.sol', packIdx([4])]],
    [fileHash(OTHER)]: [[0, 'utils/Other.sol', '4.0.0|utils/Other.sol', packIdx([0, 1, 2, 3, 4])]],
  },
}
const advDoc: AdvisoryDoc = {
  v: 1,
  reviewedAt: '2026-10-06',
  advisories: [
    { id: 'GHSA-aaaa-bbbb-cccc', aliases: ['CVE-2099-1'], severity: 'high', title: 'Thing.run returns x', url: 'https://example.invalid/a', packages: [{ name: '@openzeppelin/contracts', ranges: [{ introduced: '4.0.0', fixed: '4.2.0' }], files: [{ path: 'utils/Thing.sol', anchor: ['function run('], evidence: 'Thing.run', ref: 'https://example.invalid/fix' }] }] },
    // fixed in 4.3.0, but the 4.2.0 copy... is only in 4.2.0: A (4.0–4.1) and B (4.2) both count
    { id: 'GHSA-dddd-eeee-ffff', aliases: [], severity: 'low', title: 'Thing again', url: 'https://example.invalid/b', packages: [{ name: '@openzeppelin/contracts', ranges: [{ introduced: '4.1.0', fixed: '4.3.0' }], files: [{ path: 'utils/Thing.sol', anchor: ['function nope(', 'library Thing'], evidence: 'Thing', ref: 'https://example.invalid/fix2' }] }] },
  ],
}
const solcDoc: SolcDoc = {
  v: 1,
  generatedAt: '2026-10-06T00:00:00.000Z',
  bugs: [
    { uid: 'SOL-1', name: 'BugHigh', summary: 'h', severity: 'high', link: null, introduced: '0.8.0', fixed: '0.8.20', conditions: { optimizer: true } },
    { uid: 'SOL-2', name: 'BugLow', summary: 'l', severity: 'low', link: null, introduced: '0.8.0', fixed: null, conditions: {} },
  ],
  versions: { '0.8.19': { released: '2023-02-22', bugs: [0, 1] }, '0.8.30': { released: '2025-05-07', bugs: [1] }, '0.8.31': { released: '2025-12-01', bugs: [] } },
}
const ds = buildDataset(fp, advDoc, solcDoc)

console.log('advisory:')

await test('normalization: line endings and a BOM do not change the hash; any other byte does', () => {
  const lf = 'pragma solidity ^0.8.0;\ncontract A {}\n'
  assert.equal(normalizeSource('﻿a\r\nb\rc'), 'a\nb\nc')
  assert.equal(fileHash(lf), fileHash(lf.replace(/\n/g, '\r\n')))
  assert.equal(fileHash(lf), fileHash(`﻿${lf}`))
  assert.notEqual(fileHash(lf), fileHash(lf.replace('A', 'B')))
  assert.notEqual(fileHash(lf), fileHash(`${lf} `))
  assert.match(fileHash(lf), /^[0-9a-f]{32}$/)
})

await test('versions: semver order with prereleases, ranges, solc-0.7 builds and prerelease-of-introduced', () => {
  const sorted = ['4.9.0', '4.0.0-beta.0', '4.0.0', '4.0.0-rc.0', '3.4.2', '4.10.0', '4.0.0-beta.1'].sort(cmpVer)
  assert.deepEqual(sorted, ['3.4.2', '4.0.0-beta.0', '4.0.0-beta.1', '4.0.0-rc.0', '4.0.0', '4.9.0', '4.10.0'])
  const r = { introduced: '4.1.0', fixed: '4.7.3' }
  assert.equal(inRange('4.1.0', r), true)
  assert.equal(inRange('4.7.2', r), true)
  assert.equal(inRange('4.7.3', r), false)
  assert.equal(inRange('4.7.3-rc.0', r), true)
  assert.equal(inRange('4.0.0', r), false)
  assert.equal(inRange('1.0.0', { introduced: '0', fixed: '4.4.1' }), true)
  assert.equal(inRange('4.9.4', { introduced: '4.9.4', lastAffected: '4.9.4' }), true)
  assert.equal(rangeLabel(r), '>= 4.1.0, < 4.7.3')
  // 3.4.2-solc-0.7 is the 3.4.2 fix built for solc 0.7: compared as 3.4.2
  assert.equal(rangeVersion('3.4.2-solc-0.7'), '3.4.2')
  assert.equal(rangeVersion('3.4.1-solc-0.7-2'), '3.4.1')
  assert.equal(inRange(rangeVersion('3.4.2-solc-0.7'), { introduced: '3.3.0', fixed: '3.4.2' }), false)
  assert.equal(preOfIntroduced('4.0.0-beta.0', [{ introduced: '4.0.0', fixed: '4.3.1' }]), true)
  assert.equal(preOfIntroduced('4.0.0', [{ introduced: '4.0.0', fixed: '4.3.1' }]), false)
  assert.equal(onlyAffected(['4.0.0-beta.0', '4.0.0'], [{ introduced: '4.0.0', fixed: '4.3.1' }]), true)
  assert.equal(onlyAffected(['4.0.0-beta.0'], [{ introduced: '4.0.0', fixed: '4.3.1' }]), false)
  assert.equal(onlyAffected(['4.3.0', '4.3.1'], [{ introduced: '4.0.0', fixed: '4.3.1' }]), false)
  assert.deepEqual(unpackIdx(packIdx([5, 1, 2, 3, 9, 10])), [1, 2, 3, 5, 9, 10])
  assert.equal(packIdx([5, 1, 2, 3, 9, 10]), '1-3,5,9-10')
  assert.equal(releasesLabel(['4.7.2', '4.7.0', '4.7.1']), '4.7.0 – 4.7.2 (3 releases)')
})

await test('headers and compiler versions are parsed from real-world spellings', () => {
  assert.deepEqual(ozHeader('// SPDX-License-Identifier: MIT\n// OpenZeppelin Contracts (last updated v4.9.0) (token/ERC20/ERC20.sol)\n'), { version: '4.9.0', path: 'token/ERC20/ERC20.sol' })
  assert.deepEqual(ozHeader('// SPDX-License-Identifier: MIT\r\n// OpenZeppelin Contracts v4.4.1 (utils/Context.sol)\r\n'), { version: '4.4.1', path: 'utils/Context.sol' })
  assert.deepEqual(ozHeader('// OpenZeppelin Contracts (last updated v5.0.0-rc.0) (utils/Base64.sol)'), { version: '5.0.0-rc.0', path: 'utils/Base64.sol' })
  assert.equal(ozHeader('pragma solidity ^0.8.0;\ncontract A {}'), null)
  assert.equal(solcVersionOf('solc 0.8.19+commit.7dd6d404'), '0.8.19')
  assert.equal(solcVersionOf('v0.7.6+commit.7338295f'), '0.7.6')
  assert.equal(solcVersionOf('0.8.30'), '0.8.30')
  assert.equal(solcVersionOf('vyper 0.3.10+commit.91361694'), null)
  assert.equal(solcVersionOf(null), null)
})

await test('advisory → file mapping: a copy counts only when every release carrying it is affected', () => {
  const a = ds.affected.find((x) => x.adv.id === 'GHSA-aaaa-bbbb-cccc')!
  // copy A ships in 4.0.0-rc.0 (prerelease of introduced), 4.0.0, 4.1.0: all affected → counted
  assert.deepEqual([...a.hashes], [fileHash(COPY_A)])
  assert.deepEqual([...a.headers], ['4.0.0|utils/Thing.sol'])
  const b = ds.affected.find((x) => x.adv.id === 'GHSA-dddd-eeee-ffff')!
  // range 4.1.0–4.3.0: copy A also ships in 4.0.0 (unaffected) → not counted; copy B only in 4.2.0 → counted
  assert.deepEqual([...b.hashes], [fileHash(COPY_B)])
  assert.equal(b.straddling, 1)
  assert.equal(ds.info[0].packages[0].files[0].copies, 1)
  assert.equal(ds.info[0].packages[0].label, '>= 4.0.0, < 4.2.0')
})

await test('hash matching: byte-identical (CRLF) copy → evidence with file:line of the named function', () => {
  const r = checkSources(ds, [
    { path: '@openzeppelin/contracts/utils/Thing.sol', text: COPY_A.replace(/\n/g, '\r\n') },
    { path: 'src/Token.sol', text: 'pragma solidity 0.8.19;\nimport "./Thing.sol";\ncontract Token {}\n' },
    { path: 'README.md', text: 'not solidity' },
  ], 'solc 0.8.19+commit.7dd6d404')
  assert.equal(r.files, 2)
  assert.equal(r.ozFiles, 1)
  assert.equal(r.advisories.length, 1)
  const ev = r.advisories[0].files[0]
  assert.equal(r.advisories[0].id, 'GHSA-aaaa-bbbb-cccc')
  assert.equal(ev.method, 'hash')
  assert.equal(ev.path, '@openzeppelin/contracts/utils/Thing.sol')
  assert.equal(ev.pkgPath, 'utils/Thing.sol')
  assert.equal(ev.line, 7) // "function run(" in COPY_A
  assert.equal(ev.symbol, 'run')
  assert.equal(ev.releases, '4.0.0-rc.0 – 4.1.0 (3 releases)')
  assert.equal(ev.header, '4.0.0')
  assert.deepEqual(r.ozReleases, [{ pkg: '@openzeppelin/contracts', label: '4.0.0-rc.0 – 4.1.0 (3 releases)', files: 1 }])
  assert.deepEqual(r.solc, { version: '0.8.19', compiler: 'solc 0.8.19+commit.7dd6d404', bugs: [0, 1] })
})

await test('header matching: a modified file whose header names an affected release; none for a fixed release', () => {
  const edited = COPY_A.replace('return x;', 'return x * 2;')
  const r = checkSources(ds, [{ path: 'contracts/Thing.sol', text: edited }], 'solc 0.8.31')
  assert.equal(r.ozFiles, 0)
  assert.equal(r.advisories.length, 1)
  assert.equal(r.advisories[0].files[0].method, 'header')
  assert.equal(r.advisories[0].files[0].header, '4.0.0')
  assert.deepEqual(r.solc?.bugs, [])
  const fixedHdr = COPY_C.replace('return x + 1;', 'return x + 2;')
  assert.equal(checkSources(ds, [{ path: 'Thing.sol', text: fixedHdr }], null).advisories.length, 0)
  // releases disagree across files → no single release label
  const mixed = checkSources(ds, [{ path: 'a/Thing.sol', text: COPY_C }, { path: 'a/Other.sol', text: OTHER }, { path: 'b/Thing.sol', text: COPY_A }], null)
  assert.equal(mixed.ozReleases[0].label, null)
  assert.ok(mixed.notes.some((n) => /compiler version not recorded/.test(n)))
  assert.deepEqual(anchorLine('a\nb\nfunction x(\n', ['nope(', 'function x(']), { line: 3, symbol: 'x' })
  assert.deepEqual(anchorLine('a', ['zzz']), { line: 1, symbol: null })
})

await test('vendored data: every advisory maps to files with affected copies; known facts hold', () => {
  const real = loadDataset()
  assert.ok(real.fp.stats.versions >= 180, 'every published version fingerprinted')
  assert.ok(real.advisories.advisories.length >= 22)
  for (const af of real.affected) assert.ok(af.hashes.size > 0, `${af.adv.id} ${af.pkgName}/${af.path} has no affected copy`)
  for (const a of real.info) for (const p of a.packages) for (const f of p.files) assert.match(f.ref, /^https:\/\/github\.com\/OpenZeppelin\//)
  const ids = new Set(real.info.map((a) => a.id))
  for (const id of ['GHSA-4h98-2769-gh6h', 'GHSA-699g-q6qh-q4v8', 'GHSA-9c22-pwxw-p6hx', 'GHSA-q4h9-46xg-m3x9', 'GHSA-vrw4-w73r-6mm8', 'GHSA-7j52-6fjp-58gr', 'GHSA-9rcw-c2f9-2j55']) assert.ok(ids.has(id), id)
  // Multicall: the duplicated delegatecall exists in exactly one release (4.9.4)
  const mc = real.affected.find((x) => x.adv.id === 'GHSA-699g-q6qh-q4v8' && x.pkgName === '@openzeppelin/contracts')!
  assert.equal(mc.hashes.size, 1)
  const e = real.byHash.get([...mc.hashes][0])!.find((x) => x.pkg === mc.pkg && x.path === mc.path)!
  assert.deepEqual(e.versions.map((i) => real.fp.packages[mc.pkg].versions[i]), ['4.9.4'])
  // Governor (GHSA-5h3x): only the 4.9.0 copy of Governor.sol counts
  const gov = real.affected.find((x) => x.adv.id === 'GHSA-5h3x-9wvq-w4m2' && x.path === 'governance/Governor.sol')!
  const gv = [...gov.hashes].flatMap((h) => real.byHash.get(h)!.filter((x) => x.pkg === gov.pkg && x.path === gov.path).flatMap((x) => x.versions.map((i) => real.fp.packages[gov.pkg].versions[i])))
  assert.deepEqual(gv, ['4.9.0'])
  // a fixed release's copy never counts: ECDSA in 4.7.3
  const ec = real.affected.find((x) => x.adv.id === 'GHSA-4h98-2769-gh6h' && x.pkgName === '@openzeppelin/contracts')!
  for (const h of ec.hashes) for (const x of real.byHash.get(h)!) if (x.pkg === ec.pkg && x.path === ec.path) assert.ok(!x.versions.map((i) => real.fp.packages[ec.pkg].versions[i]).includes('4.7.3'))
  // solc list: 0.8.19 has known bugs, every version maps to listed bugs
  assert.ok(real.solc.versions['0.8.19'].bugs.length > 0)
  for (const v of Object.values(real.solc.versions)) for (const b of v.bugs) assert.ok(real.solc.bugs[b])
})

await test('background check: census math, lists, item, routes, persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-advisory-'))
  const mk = (chain: ChainId, address: string, firstSeen: number): ChainIndexItem => ({ chain, address, name: `c${firstSeen}`, kind: chain === 'solana' ? 'program' : 'contract', via: 'registry', verifiedBy: 'sourcify', idl: false, sourceFiles: 1, sourceBytes: 100, codeHash: null, firstSeen, readAt: firstSeen })
  const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40), D = '0x' + 'd'.repeat(40), E = '0x' + 'e'.repeat(40)
  const items = [mk('ethereum', A, 5), mk('base', B, 4), mk('arbitrum', C, 3), mk('ethereum', D, 2), mk('ethereum', E, 1), mk('solana', 'So11111111111111111111111111111111111111112', 6)]
  const recs: Record<string, { sources: { path: string; text: string }[]; compiler: string | null }> = {
    [A]: { sources: [{ path: '@openzeppelin/contracts/utils/Thing.sol', text: COPY_A }], compiler: 'solc 0.8.19+commit.7dd6d404' }, // advisory a (hash) + OZ
    [B]: { sources: [{ path: 'lib/Thing.sol', text: COPY_B }, { path: 'lib/Other.sol', text: OTHER }], compiler: 'solc 0.8.30' }, // advisory d (hash), OZ ×2
    [C]: { sources: [{ path: 'Thing.sol', text: COPY_C }], compiler: 'solc 0.8.31' }, // OZ, no advisory, no bugs
    [D]: { sources: [{ path: 'Pool.vy', text: '# @version 0.3.10' }], compiler: 'vyper 0.3.10' }, // not checked: Vyper
    [E]: { sources: [], compiler: null }, // not checked: no source stored
  }
  let calls = 0
  const source = {
    items: (q: { cursor?: string }) => (q.cursor ? { items: [], next: null } : { items, next: null }),
    record: async (_c: ChainId, a: string) => { calls++; return recs[a] ?? null },
  }
  const chk = createAdvisoryCheck({ source, dataDir: dir, log: () => {}, dataset: ds, pageSize: 1 })
  await chk.refresh()
  assert.equal(calls, 5)
  const s: AdvisorySummary = chk.summary()
  assert.equal(s.checked, 3)
  assert.deepEqual(s.notChecked, { noSource: 1, vyper: 1, solana: 1 })
  assert.deepEqual(s.byChain, { ethereum: 1, base: 1, arbitrum: 1 })
  assert.equal(s.withOz, 3)
  assert.equal(s.ozFiles, 4)
  assert.equal(s.withAdvisoryFile, 2)
  assert.deepEqual(s.advisories.map((a) => [a.id, a.contracts, a.byMethod.hash, a.byMethod.header]), [['GHSA-aaaa-bbbb-cccc', 1, 1, 0], ['GHSA-dddd-eeee-ffff', 1, 1, 0]])
  assert.equal(s.compiler.known, 3)
  assert.equal(s.compiler.withBugs, 2)
  assert.deepEqual(s.compiler.bySeverity, { high: 1, low: 2 })
  assert.deepEqual(s.compiler.bugs.map((b) => [b.name, b.contracts]), [['BugHigh', 1], ['BugLow', 2]])
  assert.equal(s.scope, ADVISORY_SCOPE)
  // lists: newest first, paged by 1
  const l1 = chk.list({}) as AdvisoryList
  assert.equal(l1.total, 2)
  assert.equal(l1.items[0].address, A)
  assert.equal(l1.next, '1')
  assert.equal((chk.list({ cursor: '1' }) as AdvisoryList).items[0].address, B)
  const la = chk.list({ advisory: 'GHSA-aaaa-bbbb-cccc' }) as AdvisoryList
  assert.equal(la.items[0].files[0].line, 7)
  assert.equal((chk.list({ bug: 'BugLow' }) as AdvisoryList).total, 2)
  assert.equal((chk.list({ bug: 'BugLow', chain: 'base' }) as AdvisoryList).total, 1)
  assert.equal(chk.list({ advisory: 'GHSA-zzzz-zzzz-zzzz' }), null)
  const it = chk.get('ethereum', A.toUpperCase().replace('0X', '0x')) as AdvisoryItem
  assert.equal(it.advisories[0].title, 'Thing.run returns x')
  assert.equal(it.advisories[0].label, '>= 4.0.0, < 4.2.0 · fixed in 4.2.0')
  assert.deepEqual(it.solc?.bugs.map((b) => b.name), ['BugHigh', 'BugLow'])
  assert.ok(chk.get('ethereum', D)!.notes.some((n) => /Vyper/.test(n)))
  // routes
  assert.equal(chk.route('/api/advisories/summary', new URLSearchParams()).status, 200)
  assert.equal(chk.route('/api/advisories/items', new URLSearchParams('advisory=nope')).status, 400)
  assert.equal(chk.route('/api/advisories/items', new URLSearchParams('advisory=GHSA-2222-3333-4444')).status, 404)
  assert.equal(chk.route('/api/advisories/items', new URLSearchParams('advisory=GHSA-aaaa-bbbb-cccc&bug=BugLow')).status, 400)
  assert.equal(chk.route('/api/advisories/items', new URLSearchParams('chain=solana')).status, 400)
  assert.equal(chk.route('/api/advisories/items', new URLSearchParams('cursor=x')).status, 400)
  assert.equal(chk.route(`/api/advisories/ethereum/${A}`, new URLSearchParams()).status, 200)
  assert.equal(chk.route('/api/advisories/ethereum/0x1234567890123456789012345678901234567890', new URLSearchParams()).status, 404)
  assert.equal(chk.route('/api/advisories/solana/So11111111111111111111111111111111111111112', new URLSearchParams()).status, 404)
  assert.equal(chk.route('/api/advisories/ethereum/notanaddressnotanaddress', new URLSearchParams()).status, 400)
  const j = JSON.parse(chk.route(`/api/advisories/ethereum/${A}`, new URLSearchParams()).json) as AdvisoryItem
  assert.equal(j.scope, ADVISORY_SCOPE)
  await chk.stop()
  // persistence: a second instance on the same data dir checks nothing again
  calls = 0
  const chk2 = createAdvisoryCheck({ source, dataDir: dir, log: () => {}, dataset: ds })
  await chk2.refresh()
  assert.equal(calls, 0)
  assert.equal(chk2.summary().withAdvisoryFile, 2)
  // a re-read item is checked again
  items[0] = { ...items[0], readAt: 99 }
  await chk2.refresh()
  assert.equal(calls, 1)
  await chk2.stop()
  // another dataset version → everything checked again
  calls = 0
  const chk3 = createAdvisoryCheck({ source, dataDir: dir, log: () => {}, dataset: { ...ds, version: 'other' } })
  await chk3.refresh()
  assert.equal(calls, 5)
  await chk3.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`advisory: ${passed} passed`)
