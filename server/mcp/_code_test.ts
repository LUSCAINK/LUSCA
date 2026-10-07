// LUSCA MCP tests for the code tools (offline): npx tsx server/mcp/_code_test.ts
// lusca_search, lusca_advisories, lusca_binary_interface against fixtures shaped like the REST answers of
// server/search, server/advisory and server/binary, plus the localSource mapping onto those routes.

import assert from 'node:assert/strict'
import type { SearchResult } from '../../shared/search.ts'
import type { AdvisoryItem, AdvisoryList, AdvisorySummary } from '../../shared/advisory.ts'
import type { BinaryInterface, BinarySummary } from '../../shared/binary.ts'
import { createMcp } from './index.ts'
import { localSource, SourceError, type McpSource } from './source.ts'
import { CODE_TOOLS, searchQueryOf } from './tools-code.ts'

let passed = 0
async function test(name: string, fn: () => Promise<void> | void) {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

const NOW = 1_791_350_000_000
const BANNED = /\b(rug|scam|dangerous|malicious|vulnerable|crawl(er)?)\b/i
const PORTAL = '0x3160738db14b27eae2d0d1b622259010308f4c38'
const RC = '0x2088435abcb1234a9427b755931c9064c93a2595'
const CORIUM = 'NovanpiewpH4zvYgtzAQN2zWQ94KcKWrHCTswWdZ1Y1'
const FLASH = 'FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn'

const SEARCH: SearchResult = {
  q: 'selfdestruct(',
  re: false,
  case: false,
  total: { matches: 29, files: 28, contracts: 59, chains: { ethereum: 30, base: 20, arbitrum: 9 }, programs: 0, capped: false },
  scanned: { files: 131, bytes: 2_100_000, ofFiles: 16_014, ofBytes: 117_900_000 },
  groups: [
    {
      item: { chain: 'ethereum', address: PORTAL, name: 'OptimismPortal2' },
      files: [
        {
          id: 77,
          path: 'src/libraries/Burn.sol',
          lang: 'solidity',
          lines: 32,
          matches: 1,
          blocks: [[{ n: 29, text: '    function eth(uint256 _amount) internal {', hits: [] }, { n: 30, text: '        selfdestruct(payable(address(this)));', hits: [[8, 21]] }]],
          moreMatches: 0,
          shared: { contracts: 28, chains: { ethereum: 10, base: 18 } },
          library: false,
          libraryContracts: 0,
          pathCount: 1,
          codeIndex: true,
          alsoIn: [],
        },
      ],
    },
  ],
  idl: [],
  next: '1:77',
  gen: 3,
  ms: 40,
  cached: false,
  building: null,
  error: null,
}

const ITEM: AdvisoryItem = {
  chain: 'ethereum',
  address: RC,
  name: 'RegistryCoordinator',
  checkedAt: NOW - 60_000,
  files: 41,
  ozFiles: 12,
  ozReleases: [{ pkg: '@openzeppelin/contracts', label: '4.7.0 – 4.7.2', files: 12 }],
  advisories: [
    {
      id: 'GHSA-4h98-2769-gh6h',
      severity: 'high',
      title: 'ECDSA signature malleability',
      url: 'https://github.com/advisories/GHSA-4h98-2769-gh6h',
      aliases: ['CVE-2022-35961'],
      label: '>= 4.1.0 < 4.7.3',
      files: [{ path: '/Users/dev/eigen/lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol', line: 74, symbol: 'tryRecover', pkg: '@openzeppelin/contracts', pkgPath: 'utils/cryptography/ECDSA.sol', method: 'hash', releases: '4.7.0 – 4.7.2 (3 releases)', header: null, release: '4.7.2', fix: 'has `signature.length == 64`' }],
    },
  ],
  solc: { version: '0.8.12', compiler: 'v0.8.12+commit.f00d7308', released: '2022-02-16', bugs: [{ name: 'VerbatimInvalidDeduplication', uid: 'SOL-2022-7', summary: 's', severity: 'low', link: null, introduced: '0.8.5', fixed: '0.8.17', conditions: {} }] },
  notes: [],
  scope: 'x',
  compilerScope: 'y',
}

const ADV_SUMMARY: AdvisorySummary = {
  updatedAt: NOW,
  progress: { done: 1870, total: 1895, running: false },
  checked: 1870,
  notChecked: { noSource: 1, vyper: 24, solana: 771 },
  byChain: { ethereum: 900, base: 600, arbitrum: 370 },
  withOz: 1210,
  ozFiles: 14_934,
  withAdvisoryFile: 61,
  advisories: [
    { id: 'GHSA-4h98-2769-gh6h', aliases: ['CVE-2022-35961'], severity: 'high', title: 'ECDSA signature malleability', url: 'https://github.com/advisories/GHSA-4h98-2769-gh6h', packages: [], contracts: 20, byMethod: { hash: 19, header: 1 } },
    { id: 'GHSA-9c22-pwxw-p6hx', aliases: [], severity: 'high', title: 'Initializable', url: 'https://github.com/advisories/GHSA-9c22-pwxw-p6hx', packages: [], contracts: 0, byMethod: { hash: 0, header: 0 } },
  ],
  topReleases: [],
  compiler: { known: 1870, withBugs: 1500, bySeverity: { high: 288 }, bugs: [{ name: 'TransientStorageClearingHelperCollision', severity: 'high', summary: 's', link: null, conditions: {}, contracts: 288 }], versions: [] },
  data: { ozVersions: 184, ozUniqueFiles: 6988, fingerprintsAt: '2026-10-07', advisoriesReviewedAt: '2026-10-07', solcBugs: 49, solcBugsAt: '2026-10-07', packages: [] },
  scope: 'x',
  compilerScope: 'y',
}

const ADV_LIST: AdvisoryList = {
  items: [{ chain: 'ethereum', address: RC, name: 'RegistryCoordinator', files: ITEM.advisories[0].files, solc: '0.8.12', advisories: 1 }],
  next: null,
  total: 20,
  scope: 'x',
}

const BIN: BinaryInterface = {
  v: 1,
  chain: 'solana',
  address: CORIUM,
  codeHash: 'ab'.repeat(32),
  programBytes: 1_200_000,
  readAt: NOW - 3_600_000,
  via: 'agent',
  name: 'Corium Launch',
  framework: { name: 'anchor', version: '0.30.1', evidence: ['anchor-lang crate'] },
  crates: [{ name: 'anchor-lang', version: '0.30.1' }, { name: 'hashbrown', version: '0.14.5', toolchain: true }],
  programCrate: 'corium_launch',
  instructions: [{ name: 'claim_finisher', evidence: 'log+disc', logName: 'ClaimFinisher', disc: '0011223344556677', site: 'code' }, { name: 'initialize', evidence: 'log' }],
  calls: [],
  accounts: [{ name: 'LaunchState', disc: '8899aabbccddeeff', site: 'data', idls: 2 }],
  events: [],
  errors: [{ name: 'MathOverflow', msg: 'Math overflow', idls: 40 }],
  securityTxt: { name: 'corium.so' },
  syscalls: ['sol_log_'],
  strings: { total: 900, logs: 32 },
  dictionary: { idls: 537, names: 22_000 },
  notes: [],
}

const BIN_SUMMARY: BinarySummary = {
  programs: 3003,
  withoutIdl: 2400,
  processed: 600,
  withInstructions: 360,
  names: 5000,
  instructions: 2195,
  confirmed: 1354,
  calls: 722,
  accounts: 612,
  errors: 900,
  bytesRead: 300_000_000,
  frameworks: [{ name: 'anchor', count: 400 }],
  crates: [],
  dictionary: { idls: 537, instructions: 7102, accounts: 1500, events: 3000, errors: 10_983, ready: true },
  check: { programs: 167, idlInstructions: 3288, idlInCode: 2854, recovered: 2785, precision: 0.996, recall: 0.976, newerThanIdl: 382, notInCode: 434, accountRecall: null, skipped: 73 },
  idlBehind: [{ address: FLASH, name: 'Flash Trade', newer: 23, missing: 5, idlInstructions: 196 }],
  reader: { used: 10, limit: 250, queued: 3, state: 'idle', lastAt: NOW },
  featured: CORIUM,
  updatedAt: NOW,
}

function source(over: Partial<McpSource> = {}): McpSource & { searchIps: string[] } {
  const searchIps: string[] = []
  const no = async () => {
    throw new SourceError('not in this fixture')
  }
  return {
    kind: 'fixture',
    searchIps,
    stats: no,
    feed: no,
    chainItem: no,
    lens: no,
    radarList: no,
    radarGet: no,
    radarDiff: no,
    controlGet: no,
    controlList: no,
    controlSummary: no,
    atlasItem: no,
    async search(q, ip) {
      searchIps.push(ip)
      if (q.q === 'x(?=y)+') throw new SourceError('refused: this pattern can take too long', 400)
      if (q.q === 'busy') throw new SourceError('20 searches a minute per address — wait 12 s', 429, 12)
      return SEARCH
    },
    async advisorySummary() {
      return ADV_SUMMARY
    },
    async advisoryGet(chain, address) {
      if (chain === 'ethereum' && address.toLowerCase() === RC) return ITEM
      throw new SourceError('this contract is not among the kept contracts', 404)
    },
    async advisoryList(q) {
      if (q.advisory !== 'GHSA-4h98-2769-gh6h') throw new SourceError('no advisory with this id', 404)
      return { ...ADV_LIST, items: ADV_LIST.items.slice(0, q.limit) }
    },
    async binarySummary() {
      return BIN_SUMMARY
    },
    async binaryGet(address) {
      return address === CORIUM ? BIN : null
    },
    ...over,
  }
}

const ctx = { ip: '9.9.9.9' }

await test('registered: three strict tools after the built-in ones', () => {
  const m = createMcp({ source: source(), now: () => NOW })
  const names = m.listTools().map((t) => t.name)
  assert.deepEqual(names.slice(-3), ['lusca_search', 'lusca_advisories', 'lusca_binary_interface'])
  for (const t of CODE_TOOLS) {
    assert.equal(t.inputSchema.additionalProperties, false, t.name)
    assert.equal(t.annotations.readOnlyHint, true)
    assert.ok(!BANNED.test(t.description), `${t.name} description wording`)
  }
})

await test('lusca_search: totals, shared-file count, quoted line, links, client address passed through', async () => {
  const s = source()
  const m = createMcp({ source: s, now: () => NOW })
  const r = await m.callTool('lusca_search', { query: 'selfdestruct(', limit: 3 }, ctx)
  assert.equal(r.isError, false)
  const t = r.content[0].text
  assert.match(t, /29 matching lines in 28 unique files, 59 kept contracts \(ethereum 30 · base 20 · arbitrum 9\)/)
  assert.match(t, /this exact file is in 28 kept contracts \(ethereum 10 · base 18\)/)
  assert.match(t, /30: selfdestruct\(payable\(address\(this\)\)\);/)
  assert.ok(!t.includes('29:'), 'context lines are left out')
  assert.match(t, /https:\/\/lusca\.ink\/search\?q=selfdestruct%28/)
  assert.match(t, /cursor "1:77"/)
  assert.ok(!BANNED.test(t))
  const d = r.structuredContent as any
  assert.equal(d.contracts.length, 1)
  assert.equal(d.contracts[0].url, `https://lusca.ink/lens/ethereum/${PORTAL}`)
  assert.equal(d.next, '1:77')
  assert.deepEqual(s.searchIps, ['9.9.9.9'])
  assert.deepEqual(searchQueryOf({ query: 'a.b', regex: true, case_sensitive: false, chain: 'base', custom_only: true, path: ' src/ ', lang: 'solidity' }), { q: 'a.b', re: true, chain: 'base', custom: true, path: 'src/', lang: 'solidity' })
})

await test('lusca_search: refusals and limits are tool errors; schema is strict', async () => {
  const m = createMcp({ source: source(), now: () => NOW })
  const refused = await m.callTool('lusca_search', { query: 'x(?=y)+', regex: true }, ctx)
  assert.equal(refused.isError, true)
  assert.match(refused.content[0].text, /refused/)
  const busy = await m.callTool('lusca_search', { query: 'busy' }, ctx)
  assert.equal(busy.isError, true)
  assert.match(busy.content[0].text, /retry after 12 s/)
  for (const bad of [{ query: 'a' }, { query: 'ok', limit: 11 }, { query: 'ok', chain: 'bsc' }, { query: 'ok', extra: 1 }, {}]) {
    const r = await m.callTool('lusca_search', bad, ctx)
    assert.equal(r.isError, true, JSON.stringify(bad))
  }
  const off = await createMcp({ source: source({ search: undefined }), now: () => NOW }).callTool('lusca_search', { query: 'abc' }, ctx)
  assert.match(off.content[0].text, /code search is not available on this server/)
})

await test('lusca_search: answers stay bounded with many groups and long lines', async () => {
  const long = 'x'.repeat(5000)
  const many: SearchResult = {
    ...SEARCH,
    groups: Array.from({ length: 40 }, (_, i) => ({
      item: { chain: 'base' as const, address: '0x' + String(i).padStart(40, '0'), name: `C${i}` },
      files: Array.from({ length: 6 }, (_, j) => ({ ...SEARCH.groups[0].files[0], id: j, path: `src/F${j}.sol`, blocks: [Array.from({ length: 10 }, (_, k) => ({ n: k + 1, text: long, hits: [[0, 3]] as [number, number][] }))] })),
    })),
  }
  const m = createMcp({ source: source({ search: async () => many }), now: () => NOW })
  const r = await m.callTool('lusca_search', { query: 'xxx', limit: 10 }, ctx)
  assert.ok(r.content[0].text.length <= 12_100, `text ${r.content[0].text.length}`)
  const d = r.structuredContent as any
  assert.equal(d.contracts.length, 10)
  assert.equal(d.moreContractsOnPage, 30)
  assert.ok(d.contracts.every((g: any) => g.files.length <= 3 && g.files.every((f: any) => f.matchLines.length <= 4 && f.matchLines.every((l: any) => l.text.length <= 240))))
  assert.ok(JSON.stringify(d).length < 60_000)
})

await test('lusca_advisories: one contract with file:line evidence, scope wording, local build path cut', async () => {
  const m = createMcp({ source: source(), now: () => NOW })
  const r = await m.callTool('lusca_advisories', { chain: 'ethereum', address: RC }, ctx)
  assert.equal(r.isError, false)
  const t = r.content[0].text
  assert.match(t, /GHSA-4h98-2769-gh6h \(CVE-2022-35961\) · high/)
  assert.match(t, / {4}contracts\/utils\/cryptography\/ECDSA\.sol:74 \(tryRecover\) — byte-identical to contracts 4\.7\.0 – 4\.7\.2/)
  assert.ok(!t.includes('/Users/dev'), 'developer paths are cut')
  assert.match(t, /Scope: A match shows that code from an affected OpenZeppelin release is present/)
  assert.match(t, /1 known bug listed for this version/)
  assert.match(t, /lusca\.ink\/lens\/ethereum\/0x2088435abcb1234a9427b755931c9064c93a2595#ln-adv/)
  assert.ok(!BANNED.test(t))
  assert.equal((r.structuredContent as any).mode, 'contract')
  const missing = await m.callTool('lusca_advisories', { chain: 'base', address: '0x' + '5'.repeat(40) }, ctx)
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /not among the kept contracts/)
})

await test('lusca_advisories: totals, one advisory, argument rules', async () => {
  const m = createMcp({ source: source(), now: () => NOW })
  const s = await m.callTool('lusca_advisories', {}, ctx)
  assert.match(s.content[0].text, /1,210 \(65%\) contain files byte-identical/)
  assert.match(s.content[0].text, /61 include a file from an affected release, covering 1 of 2 advisories/)
  assert.match(s.content[0].text, /20 contracts \(19 byte-identical, 1 by header\)/)
  assert.match(s.content[0].text, /288 on a version whose list includes a high-severity bug \(conditions not checked\)/)
  assert.ok(!BANNED.test(s.content[0].text))
  const l = await m.callTool('lusca_advisories', { advisory: 'GHSA-4h98-2769-gh6h', limit: 5 }, ctx)
  assert.match(l.content[0].text, /affected by GHSA-4h98-2769-gh6h: 20 \(first 1\)/)
  for (const bad of [{ address: RC }, { chain: 'ethereum' }, { chain: 'ethereum', address: RC, advisory: 'GHSA-4h98-2769-gh6h' }, { chain: 'solana', address: RC }, { advisory: 'CVE-2022-35961' }, { limit: 50 }]) {
    const r = await m.callTool('lusca_advisories', bad, ctx)
    assert.equal(r.isError, true, JSON.stringify(bad))
  }
})

await test('lusca_binary_interface: one program with evidence, the census, not read yet', async () => {
  const m = createMcp({ source: source(), now: () => NOW })
  const r = await m.callTool('lusca_binary_interface', { address: CORIUM }, ctx)
  assert.equal(r.isError, false)
  const t = r.content[0].text
  assert.match(t, /instructions \(2, 1 confirmed by discriminator\): claim_finisher \[log\+disc\], initialize \[log\]/)
  assert.match(t, /framework: anchor 0\.30\.1 · program crate corium_launch/)
  assert.ok(!t.includes('hashbrown'), 'toolchain crates are not listed as the program\'s')
  assert.match(t, /https:\/\/lusca\.ink\/binary\/NovanpiewpH4zvYgtzAQN2zWQ94KcKWrHCTswWdZ1Y1/)
  const c = await m.callTool('lusca_binary_interface', {}, ctx)
  assert.match(c.content[0].text, /recall 97\.6% .* precision 99\.6%/)
  assert.match(c.content[0].text, /"Flash Trade" FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn \(\+23 \/ −5 of 196\)/)
  const none = await m.callTool('lusca_binary_interface', { address: FLASH }, ctx)
  assert.equal(none.isError, true)
  assert.match(none.content[0].text, /no recovered interface/)
  const bad = await m.callTool('lusca_binary_interface', { address: '0x' + '1'.repeat(40) }, ctx)
  assert.equal(bad.isError, true)
})

await test('localSource: routes of the search, advisory and binary modules', async () => {
  const seen: string[] = []
  const mods = {
    search: {
      route: async (p: string, params: URLSearchParams, ip: string) => {
        seen.push(`${p}?${params}|${ip}`)
        if (params.get('q') === 'slow') return { status: 429, json: JSON.stringify({ ...SEARCH, error: { code: 'busy', message: '20 searches a minute per address — wait 9 s' } }), headers: { 'Retry-After': '9' } }
        return { status: 200, json: JSON.stringify(SEARCH) }
      },
    },
    advisory: { route: (p: string) => (p.endsWith(RC) ? { status: 200, json: JSON.stringify(ITEM) } : p.endsWith('summary') ? { status: 200, json: JSON.stringify(ADV_SUMMARY) } : { status: 404, json: '{"error":"not checked yet: the check is running"}' }) },
    binary: { route: (p: string) => (p.endsWith(CORIUM) ? { status: 200, json: JSON.stringify(BIN) } : { status: 404, json: '{"error":"no recovered interface for this program yet"}' }) },
  }
  const s = localSource(() => mods)
  assert.equal((await s.search!({ q: 'selfdestruct(', re: true, custom: true }, '1.2.3.4')).total.contracts, 59)
  assert.equal(seen[0], '/api/search?q=selfdestruct%28&re=1&custom=1|1.2.3.4')
  await assert.rejects(() => s.search!({ q: 'slow' }, '1.2.3.4'), (e: unknown) => e instanceof SourceError && e.status === 429 && e.retryAfterS === 9 && /20 searches a minute/.test(e.message))
  assert.equal((await s.advisoryGet!('ethereum', RC)).name, 'RegistryCoordinator')
  await assert.rejects(() => s.advisoryGet!('base', '0x' + '1'.repeat(40)), /not checked yet/)
  assert.equal((await s.advisorySummary!()).withOz, 1210)
  assert.equal((await s.binaryGet!(CORIUM))?.programCrate, 'corium_launch')
  assert.equal(await s.binaryGet!(FLASH), null)
  await assert.rejects(() => localSource(() => ({})).binarySummary!(), /binary reader is not available/)
})

console.log(`mcp code tools: ${passed} passed`)
