// LUSCA MCP tests (offline): npx tsx server/mcp/_test.ts
// Protocol conformance over real HTTP (initialize / version negotiation, notifications, ping, tools/list
// schemas, tools/call results and errors, batches, GET / DELETE 405, docs negotiation, origin, body cap,
// content type, rate limits, SSE accept) and every tool against fixtures shaped like production answers.

import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ChainEvent, ChainId, ChainIndexItem, ChainRead } from '../../shared/chain.ts'
import type { RadarEvent, RadarPage } from '../../shared/radar.ts'
import type { RadarCodeDiff } from '../../shared/radarDiff.ts'
import type { ControlEntry, ControlSummary } from '../../shared/control.ts'
import type { AtlasItem } from '../../shared/atlas.ts'
import type { LensAnswer, LensReport } from '../../shared/lens.ts'
import { createMcp, defineTool, mcpLimitsFromEnv } from './index.ts'
import { localSource, remoteSource, SourceError, type McpSource } from './source.ts'
import { validate } from './schema.ts'
import { scrub } from './format.ts'
import { TOOLS, viaText } from './tools.ts'

let passed = 0
async function test(name: string, fn: () => Promise<void> | void) {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

// ─── fixtures (shapes and values as lusca.ink serves them) ──────────────────

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const PUMP_AUTH = '7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8'
const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
const FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'
const PROXY = '0x28d66dcf994e76cffbbcce31f2d7df6f36fdff81'
const IMPL_A = '0x1111111111111111111111111111111111111111'
const IMPL_B = '0x2222222222222222222222222222222222222222'
const NOW = 1_791_350_000_000

const pda = (address: string, name: string): ControlEntry => ({
  chain: 'solana',
  address,
  name,
  cls: 'pda',
  hops: [
    { kind: 'program', address, label: 'program · bpf-upgradeable' },
    { kind: 'pda', address: PUMP_AUTH, label: 'program-derived address', via: 'upgrade authority' },
  ],
  basis: 'upgrade authority is off the ed25519 curve (a PDA)',
  at: NOW - 3_600_000,
  calls: 0,
})
const CONTROL: ControlEntry[] = [pda(PUMP, 'pump'), pda(AMM, 'pump_amm'), pda(FEES, 'pump_fees')]

const SUMMARY: ControlSummary = {
  total: 2650,
  resolved: 2650,
  pending: 0,
  byChain: { solana: { key: 331, pda: 328, immutable: 108 }, ethereum: { immutable: 879, unknown: 13, safe: 4, key: 1, contract: 1 } },
  byClass: { immutable: 1950, key: 332, pda: 328, unknown: 32, safe: 5, contract: 3 },
  topControllers: [{ chain: 'solana', address: '6awyHMshBGVjJ3ozdSJdyyDE1CTAXUwrpNMaRGMsb4sf', label: 'program-derived address', cls: 'pda', count: 16, names: ['launchpad', 'autocrat', 'amm'] }],
  budget: {},
  updatedAt: NOW,
}

const side = (impl: string, verified: 'sourcify-full' | 'none' = 'sourcify-full') => ({ at: NOW - 1000, from: 'read' as const, codeHash: 'ab'.repeat(32), authority: '0x9999999999999999999999999999999999999999', upgradeable: true, implementation: impl, verified, name: 'Vault', surfaceCount: 12 })
const UPGRADE: RadarEvent = {
  id: 'eth-abc123def4',
  chain: 'ethereum',
  kind: 'upgrade',
  address: PROXY,
  name: 'Vault',
  known: true,
  knownWhy: 'kept in the chain index',
  ts: NOW - 120_000,
  seenAt: NOW - 110_000,
  slot: null,
  block: 21_000_000,
  tx: '0x' + 'cd'.repeat(32),
  count: 1,
  actor: '0x9999999999999999999999999999999999999999',
  actorRole: 'sender',
  before: side(IMPL_A),
  after: side(IMPL_B),
  diff: { code: 'changed', authority: 'same', verified: 'same', surface: 'functions', added: { items: ['pause()'], more: 0 }, removed: { items: [], more: 0 }, guardsAdded: [{ fn: 'pause()', guard: 'onlyOwner', at: 'Vault.sol:88' }], guardsRemoved: [], primitivesAdded: null, primitivesRemoved: null },
  headline: 'Upgraded · 1 function added · admin unchanged · verified: Sourcify full',
  priority: 10,
  via: 'eth_getLogs · Ethereum public RPC',
  state: 'read',
  notes: ['read over PublicNode'],
  updatedAt: NOW,
  trace: [
    { kind: 'rpc', method: 'eth_getStorageAt', target: PROXY, provider: 'PublicNode', t: 0, ms: 120, ok: true, result: 'implementation slot' },
    { kind: 'registry', method: 'Sourcify', target: IMPL_B, provider: 'Sourcify', t: 130, ms: 300, ok: true, result: 'full match' },
  ],
}
const DEPLOY: RadarEvent = { ...UPGRADE, id: 'sol-zz99yy88', chain: 'solana', kind: 'deploy', address: AMM, name: 'pump_amm', before: null, after: null, diff: null, headline: 'Deployed', via: 'Helius websocket', trace: undefined, notes: [] }
const DIFF: RadarCodeDiff = {
  id: UPGRADE.id, chain: 'ethereum', address: PROXY, name: 'Vault', block: 21_000_000, tx: UPGRADE.tx, ts: UPGRADE.ts, oldImpl: IMPL_A, newImpl: IMPL_B, oldVerified: 'sourcify-full', newVerified: 'sourcify-full', oldCompiler: 'v0.8.20', newCompiler: 'v0.8.24', state: 'ready', reason: null,
  files: [{ id: 'f1', path: 'src/Vault.sol', status: 'modified', add: 14, del: 2, hunks: [] }],
  unchangedFiles: 31,
  functions: [{ sig: 'pause()', kind: 'function', change: 'added', at: 'src/Vault.sol:88', file: 'src/Vault.sol', line: 88, access: 'onlyOwner', hunk: 'f1h1' }],
  totals: { files: 1, add: 14, del: 2 },
  truncated: null,
  computedAt: NOW,
}
const STATUS = { sources: {}, last24h: { total: 1657, byKind: { deploy: 550, upgrade: 146 }, byChain: {} }, backfill: {}, budget: {}, stored: 1880, updatedAt: NOW }

const FEED: ChainEvent[] = [
  {
    id: 'c1', ts: NOW - 9_000, agent: 'eth-1', chain: 'ethereum', address: '0xc82fb8fb873b0c56e1aeb9238d79b27e3d67f155', name: 'ResolverRegistry', kind: 'contract', via: 'link', verdict: 'kept',
    reason: 'Sourcify partial match · 47 source files · 504 KB', idl: false, verifiedBy: 'sourcify', sourceFiles: 47, sourceBytes: 516_400,
    trace: [
      { kind: 'rpc', method: 'eth_getCode', target: '0xc82f', provider: 'PublicNode', t: 0, ms: 210, ok: true, result: '12.1 KB code' },
      { kind: 'registry', method: 'Sourcify', target: '0xc82f', provider: 'Sourcify', t: 220, ms: 317, ok: true, result: 'partial match' },
    ],
    scan: { upgradeable: false },
  },
  { id: 'c2', ts: NOW - 23_000, agent: 'sol-1', chain: 'solana', address: 'CatMoR2RWH47v8TYnKi76oV57E5DhYMRqAroKUGCMxTu', name: null, kind: 'program', via: 'block', verdict: 'unverified', reason: 'no verified build, no on-chain IDL', idl: false, verifiedBy: null, sourceFiles: 0, sourceBytes: 0 },
]

const REPORT: LensReport = {
  v: 1, chain: 'solana', address: PUMP, kind: 'program', name: 'pump', readAt: NOW - 2000, ms: 900, rpcCalls: 1, registryCalls: 1,
  summary: { verified: null, upgradeable: true, authority: PUMP_AUTH, proxy: null, surface: 47, privileged: null, primitives: 1, provenance: 0 },
  solana: {
    loader: 'bpf-upgradeable', upgradeable: true, upgradeAuthority: PUMP_AUTH, programDataAddress: 'B5MvUwXdiW1NMM6QFFD3ssPKBujD4zMohncbM73Z2BQu', programBytes: 1_800_000, lastDeploySlot: 452_654_932, codeHash: 'b0b7'.repeat(16), securityTxt: null,
    idl: { source: 'Anchor IDL account', format: 'anchor', name: 'pump', version: '0.1.0', instructions: [{ name: 'buy', docs: null, accounts: [], args: [] }, { name: 'sell', docs: null, accounts: [], args: [] }], accounts: ['Global'], types: 9, errors: [], events: ['TradeEvent'] },
    osec: { verified: false, repo: null, commit: null }, syscalls: ['sol_sha256'], signerRoles: [],
  },
  evm: null,
  primitives: [{ name: 'SHA-256', group: 'hash', via: 'syscall-import', at: [], count: 1 }],
  provenance: { checked: 0, matches: [], osecRepo: null, index: { repos: 110, files: 18_239, builtAt: NOW } },
  dataset: { address: PUMP, before: null, verdict: 'duplicate', reason: 'already kept, code unchanged', added: false },
  notes: ['IDL from the Anchor IDL account (anchor)'],
  cites: [{ label: 'Solana Explorer', url: `https://explorer.solana.com/address/${PUMP}` }],
}

const ATLAS: AtlasItem = {
  chain: 'solana', address: PUMP, name: 'pump', verifiedBy: null, cluster: -1, clusterLabel: null, functions: 47, events: 0, sample: ['buy', 'sell', 'create'],
  relatives: [{ chain: 'solana', address: AMM, name: 'pump_amm', similarity: 29, shared: 13, onlyHere: ['create'], onlyThere: ['create_pool'] }],
}

const KEPT: { item: ChainIndexItem; read: ChainRead } = {
  item: { chain: 'ethereum', address: '0xc82fb8fb873b0c56e1aeb9238d79b27e3d67f155', name: 'ResolverRegistry', kind: 'contract', via: 'link', verifiedBy: 'sourcify', idl: false, sourceFiles: 2, sourceBytes: 516_400, codeHash: 'ef'.repeat(32), firstSeen: NOW - 86_400_000, readAt: NOW - 9_000 },
  read: {
    chain: 'ethereum', address: '0xc82fb8fb873b0c56e1aeb9238d79b27e3d67f155', kind: 'contract', name: 'ResolverRegistry', codeHash: 'ef'.repeat(32), upgradeable: false, upgradeAuthority: null, lastDeploySlot: null, programBytes: null, loader: null,
    idl: null, securityTxt: null, bytecodeBytes: 12_100, proxy: null,
    abi: { functions: ['register(bytes32,address)', 'resolve(bytes32)'], events: ['Registered(bytes32,address)'] },
    verified: { by: 'sourcify', match: 'partial', repo: null, commit: null, compiler: 'v0.8.24' },
    sources: [{ path: 'src/ResolverRegistry.sol', lang: 'solidity', bytes: 14_000 }, { path: 'lib/Ownable.sol', lang: 'solidity', bytes: 3_000 }],
    notes: ['Sourcify partial match'], readAt: NOW - 9_000, rpcCalls: 2,
  },
}

function fixtureSource(over: Partial<McpSource> = {}): McpSource & { lensCalls: { ip: string }[] } {
  const lensCalls: { ip: string }[] = []
  return {
    kind: 'fixture',
    lensCalls,
    async stats() {
      return {
        corpus: { pages: 577_279, tokens: 1_067_829_062, domains: 287, pagesPerMin: 279, tokensPerMin: 500_000, heldPages: 115_196, heldTokens: 210_000_000 },
        network: { neurons: 23, gflops: 14_565, jobsDone: 313_394, jobsVerified: 313_267 },
        chain: { reads: 18_457, kept: 2654, programs: 767, contracts: 1887, idls: 537, verified: 2372, sourceBytes: 247_800_000, byChain: { solana: { reads: 3003, kept: 767 } }, rejected: { boilerplate: 9596 }, updatedAt: NOW },
        code: { repos: 110, files: 18_239, bytes: 147_700_000, updatedAt: NOW },
        audits: { ok: 58_769, failed: 0 },
      }
    },
    async feed(limit) {
      return FEED.slice(0, limit)
    },
    async chainItem(chain, address) {
      return chain === KEPT.item.chain && address.toLowerCase() === KEPT.item.address ? KEPT : null
    },
    async lens(chain, address, ip) {
      lensCalls.push({ ip })
      if (address === PUMP && chain === 'solana') return { ok: true, answer: { report: REPORT, cached: true, fresh: NOW + 3_600_000 } satisfies LensAnswer }
      return { ok: false, status: 429, error: 'too many Lens requests — slow down', retryAfterS: 30 }
    },
    async radarList(q) {
      const items = [UPGRADE, DEPLOY].filter((e) => (!q.chain || e.chain === q.chain) && (!q.kind || e.kind === q.kind)).slice(0, q.limit)
      return { items, next: null, status: STATUS } as RadarPage
    },
    async radarGet(id) {
      return [UPGRADE, DEPLOY].find((e) => e.id === id) ?? null
    },
    async radarDiff(id) {
      return id === DIFF.id ? DIFF : null
    },
    async controlGet(chain, address) {
      return CONTROL.find((e) => e.chain === chain && e.address === address) ?? null
    },
    async controlList(q) {
      const items = CONTROL.filter((e) => e.hops.some((h, i) => i > 0 && h.address === q.controller)).slice(0, q.limit)
      return { items, total: items.length, next: null }
    },
    async controlSummary() {
      return SUMMARY
    },
    async atlasItem(chain, address) {
      return chain === 'solana' && address === PUMP ? ATLAS : null
    },
    ...over,
  }
}

// ─── HTTP harness ───────────────────────────────────────────────────────────

async function serve(mcp: ReturnType<typeof createMcp>) {
  const server = http.createServer((req, res) => {
    const ip = String(req.headers['x-test-ip'] ?? '127.0.0.1')
    if (mcp.http.wantsDocs(req)) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end('<!doctype html><title>docs</title>')
    }
    void mcp.http.handle(req, res, ip)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  return { server, url }
}

type Res = { status: number; headers: Headers; text: string; json: any }
async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await r.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: r.status, headers: r.headers, text, json }
}
const call = (url: string, name: string, args: unknown, id: number | string = 1, headers?: Record<string, string>) => post(url, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, headers)

const src = fixtureSource()
const mcp = createMcp({ source: src, site: 'https://lusca.ink', originAllowed: (o, host) => o === 'http://localhost:5173' || (!!host && new URL(o).host === host), now: () => NOW })
const { server, url } = await serve(mcp)

try {
  console.log('mcp protocol')

  await test('initialize negotiates the protocol version and names the server', async () => {
    const r = await post(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type') ?? '', /application\/json/)
    assert.equal(r.json.jsonrpc, '2.0')
    assert.equal(r.json.id, 1)
    assert.equal(r.json.result.protocolVersion, '2025-06-18')
    assert.equal(r.json.result.serverInfo.name, 'lusca')
    assert.ok(r.json.result.serverInfo.version)
    assert.deepEqual(r.json.result.capabilities, { tools: { listChanged: false }, prompts: { listChanged: false } })
    assert.match(r.json.result.instructions, /lusca_lens/)
    const old = await post(url, { jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } }, { 'MCP-Protocol-Version': '' })
    assert.equal(old.json.result.protocolVersion, '2025-03-26')
    const future = await post(url, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01', capabilities: {} } })
    assert.equal(future.json.result.protocolVersion, '2025-06-18', 'an unknown version is answered with the latest supported one')
    const missing = await post(url, { jsonrpc: '2.0', id: 3, method: 'initialize', params: {} })
    assert.equal(missing.json.error.code, -32602)
  })

  await test('notifications and client responses are accepted with 202 and no body', async () => {
    const r = await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(r.status, 202)
    assert.equal(r.text, '')
    const c = await post(url, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })
    assert.equal(c.status, 202)
    const resp = await post(url, { jsonrpc: '2.0', id: 9, result: {} })
    assert.equal(resp.status, 202)
  })

  await test('ping answers an empty result; unknown methods are -32601', async () => {
    const r = await post(url, { jsonrpc: '2.0', id: 7, method: 'ping' })
    assert.deepEqual(r.json, { jsonrpc: '2.0', id: 7, result: {} })
    const u = await post(url, { jsonrpc: '2.0', id: 8, method: 'resources/list' })
    assert.equal(u.status, 200)
    assert.equal(u.json.error.code, -32601)
  })

  await test('tools/list: strict schemas, annotations, output schemas (2025-06-18)', async () => {
    const r = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const tools = r.json.result.tools as any[]
    assert.equal(tools.length, 10)
    assert.deepEqual(tools.map((t) => t.name).sort(), ['lusca_atlas_relatives', 'lusca_control', 'lusca_control_summary', 'lusca_controlled_by', 'lusca_kept_item', 'lusca_lens', 'lusca_radar', 'lusca_radar_event', 'lusca_scan_recent', 'lusca_stats'])
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object', t.name)
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} schema is strict`)
      assert.equal(t.annotations.readOnlyHint, true)
      assert.equal(t.annotations.destructiveHint, false)
      assert.equal(typeof t.annotations.openWorldHint, 'boolean')
      assert.ok(t.title && t.description.length > 60)
      assert.equal(t.outputSchema.type, 'object')
      assert.deepEqual(t.outputSchema.required, ['links', 'asOf'])
      for (const k of t.inputSchema.required ?? []) assert.ok(t.inputSchema.properties[k], `${t.name}.${k} is described`)
    }
    assert.equal(tools.find((t) => t.name === 'lusca_lens').annotations.openWorldHint, true)
    const old = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'MCP-Protocol-Version': '2025-03-26' })
    const t0 = old.json.result.tools[0]
    assert.equal(t0.outputSchema, undefined, '2025-03-26 clients get no outputSchema')
    assert.equal(t0.title, undefined)
    assert.ok(t0.annotations)
    const ancient = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'MCP-Protocol-Version': '2024-11-05' })
    assert.equal(ancient.json.result.tools[0].annotations, undefined)
  })

  await test('tools/call errors: unknown tool -32602, bad arguments isError, bad params -32602', async () => {
    const u = await call(url, 'lusca_nope', {})
    assert.equal(u.json.error.code, -32602)
    assert.match(u.json.error.message, /Unknown tool/)
    const extra = await call(url, 'lusca_stats', { foo: 1 })
    assert.equal(extra.json.result.isError, true)
    assert.match(extra.json.result.content[0].text, /unknown argument foo/)
    const badChain = await call(url, 'lusca_control', { chain: 'tron', address: PUMP })
    assert.equal(badChain.json.result.isError, true)
    assert.match(badChain.json.result.content[0].text, /chain must be one of/)
    const missing = await call(url, 'lusca_control', { chain: 'solana' })
    assert.match(missing.json.result.content[0].text, /address is required/)
    const wrongKind = await call(url, 'lusca_control', { chain: 'ethereum', address: PUMP })
    assert.equal(wrongKind.json.result.isError, true)
    assert.match(wrongKind.json.result.content[0].text, /not an EVM address/)
    const limit = await call(url, 'lusca_radar', { limit: 500 })
    assert.match(limit.json.result.content[0].text, /limit must be ≤ 25/)
    const noName = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })
    assert.equal(noName.json.error.code, -32602)
    const argsArray = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lusca_stats', arguments: [] } })
    assert.equal(argsArray.json.error.code, -32602)
  })

  await test('malformed messages: parse error, invalid request, empty and oversized batches', async () => {
    const pe = await post(url, '{"jsonrpc":"2.0",')
    assert.equal(pe.status, 400)
    assert.equal(pe.json.error.code, -32700)
    assert.equal(pe.json.id, null)
    const ir = await post(url, { id: 1, method: 'ping' })
    assert.equal(ir.status, 400)
    assert.equal(ir.json.error.code, -32600)
    const badId = await post(url, { jsonrpc: '2.0', id: { x: 1 }, method: 'ping' })
    assert.equal(badId.json.error.code, -32600)
    const empty = await post(url, [])
    assert.equal(empty.status, 400)
    assert.equal(empty.json.error.code, -32600)
    const big = await post(url, Array.from({ length: 9 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })))
    assert.equal(big.status, 400)
  })

  await test('batch: answered entry by entry, notifications left out; only notifications → 202', async () => {
    const r = await post(url, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lusca_stats', arguments: {} } },
      { jsonrpc: '2.0', id: 3, method: 'nope' },
    ])
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.json))
    assert.deepEqual(r.json.map((x: any) => x.id), [1, 2, 3])
    assert.equal(r.json[1].result.isError, false)
    assert.equal(r.json[2].error.code, -32601)
    const n = await post(url, [{ jsonrpc: '2.0', method: 'notifications/initialized' }])
    assert.equal(n.status, 202)
  })

  await test('GET / DELETE from MCP clients → 405 with Allow; a browser GET gets the docs page', async () => {
    const g = await fetch(url, { headers: { Accept: 'text/event-stream' } })
    assert.equal(g.status, 405)
    assert.equal(g.headers.get('allow'), 'POST, OPTIONS')
    assert.equal(((await g.json()) as any).error.code, -32600)
    const d = await fetch(url, { method: 'DELETE', headers: { 'Mcp-Session-Id': 'x' } })
    assert.equal(d.status, 405)
    const curl = await fetch(url, { headers: { Accept: '*/*' } })
    assert.equal(curl.status, 405)
    const b = await fetch(url, { headers: { Accept: 'text/html,application/xhtml+xml' } })
    assert.equal(b.status, 200)
    assert.match(await b.text(), /docs/)
  })

  await test('origin: foreign browser origins refused, own / local origins get CORS, preflight 204', async () => {
    const f = await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })
    assert.equal(f.status, 403)
    const l = await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'http://localhost:5173' })
    assert.equal(l.status, 200)
    assert.equal(l.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    assert.match(l.headers.get('access-control-expose-headers') ?? '', /Mcp-Session-Id/)
    const host = new URL(url).host
    const same = await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: `http://${host}` })
    assert.equal(same.status, 200)
    const pre = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,mcp-protocol-version' } })
    assert.equal(pre.status, 204)
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /MCP-Protocol-Version/)
  })

  await test('content type, protocol header, Accept and body cap', async () => {
    const ct = await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'Content-Type': 'text/plain' })
    assert.equal(ct.status, 415)
    const pv = await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' })
    assert.equal(pv.status, 400)
    assert.match(pv.json.error.message, /Unsupported MCP-Protocol-Version/)
    const acc = await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Accept: 'text/plain' })
    assert.equal(acc.status, 406)
    const sse = await post(url, { jsonrpc: '2.0', id: 5, method: 'ping' }, { Accept: 'text/event-stream' })
    assert.equal(sse.status, 200)
    assert.match(sse.headers.get('content-type') ?? '', /text\/event-stream/)
    assert.match(sse.text, /^event: message\ndata: \{"jsonrpc":"2.0","id":5,"result":\{\}\}\n\n$/)
    const huge = await post(url, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70_000) } }))
    assert.equal(huge.status, 413)
    assert.equal(huge.json.error.code, -32600)
  })

  await test('prompts/list and prompts/get: templates that chain the tools, arguments checked', async () => {
    const l = await post(url, { jsonrpc: '2.0', id: 1, method: 'prompts/list' })
    const names = (l.json.result.prompts as any[]).map((p) => p.name)
    assert.deepEqual(names, ['who_can_change', 'latest_upgrades', 'explain_code'])
    assert.ok(l.json.result.prompts[0].title)
    assert.deepEqual(l.json.result.prompts[0].arguments.map((a: any) => [a.name, a.required]), [['chain', true], ['address', true]])
    const g = await post(url, { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'who_can_change', arguments: { chain: 'solana', address: PUMP } } })
    const msg = g.json.result.messages[0]
    assert.equal(msg.role, 'user')
    assert.match(msg.content.text, /lusca_control for solana 6EF8/)
    assert.match(msg.content.text, /no judgment/)
    const miss = await post(url, { jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'who_can_change', arguments: { chain: 'solana' } } })
    assert.equal(miss.json.error.code, -32602)
    const bad = await post(url, { jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'explain_code', arguments: { chain: 'base', address: PUMP } } })
    assert.match(bad.json.error.message, /not a EVM address|not an? EVM address/)
    const unk = await post(url, { jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'nope' } })
    assert.equal(unk.json.error.code, -32602)
    const opt = await post(url, { jsonrpc: '2.0', id: 6, method: 'prompts/get', params: { name: 'latest_upgrades' } })
    assert.match(opt.json.result.messages[0].content.text, /kind "upgrade" and limit 10/)
  })

  console.log('mcp tools')

  await test('lusca_control: custody chain, controller, everything else it can change, links', async () => {
    const r = await call(url, 'lusca_control', { chain: 'solana', address: PUMP })
    const res = r.json.result
    assert.equal(res.isError, false)
    const text = res.content[0].text as string
    assert.match(text, /program-derived address/)
    assert.match(text, new RegExp(`controller: ${PUMP_AUTH}`))
    assert.match(text, /can change 2 other kept programs/)
    assert.match(text, /pump_amm/)
    assert.match(text, /https:\/\/lusca\.ink\/api\/control\/solana\//)
    const sc = res.structuredContent
    assert.equal(sc.class, 'pda')
    assert.equal(sc.controller.address, PUMP_AUTH)
    assert.equal(sc.sameController.total, 2)
    assert.deepEqual(sc.sameController.items.map((x: any) => x.name).sort(), ['pump_amm', 'pump_fees'])
    assert.ok(sc.links.length >= 3 && sc.links.every((l: string) => l.startsWith('https://lusca.ink/')))
    assert.equal(sc.asOf, NOW)
    assert.equal(validate(TOOLS.find((t) => t.name === 'lusca_control')!.outputSchema!, sc), null, 'structuredContent satisfies outputSchema')
    const miss = await call(url, 'lusca_control', { chain: 'base', address: '0x' + '3'.repeat(40) })
    assert.equal(miss.json.result.isError, true)
    assert.match(miss.json.result.content[0].text, /not in the control map/)
  })

  await test('lusca_control on an address that is not kept: Lens read first, authority classified, same-controller list', async () => {
    const m = createMcp({ source: fixtureSource({ controlGet: async () => null }), now: () => NOW })
    const r = await m.callTool('lusca_control', { chain: 'solana', address: PUMP }, { ip: '1' })
    assert.equal(r.isError, false)
    const t = r.content[0].text
    assert.match(t, /not kept by LUSCA: read with Lens just now/)
    assert.match(t, /class: program-derived address/)
    assert.match(t, /upgrade authority is off the ed25519 curve/)
    assert.match(t, /can change 2 other kept programs/)
    assert.equal((r.structuredContent as any).source, 'lens')
    const evmReport = {
      ...REPORT, chain: 'base', address: PROXY, kind: 'contract', name: 'Vault', solana: null,
      evm: { chainId: 8453, bytecodeBytes: 500, codeHash: null, proxy: { standard: 'eip1967', label: 'EIP-1967 transparent', implementation: IMPL_B, admin: '0x' + '7'.repeat(40) }, self: null, implementation: null },
    } as unknown as LensReport
    const e = createMcp({ source: fixtureSource({ controlGet: async () => null, lens: async () => ({ ok: true, answer: { report: evmReport, cached: false, fresh: 0 } }) }), now: () => NOW })
    const er = await e.callTool('lusca_control', { chain: 'base', address: PROXY }, { ip: '1' })
    assert.match(er.content[0].text, /proxy admin read, not classified/)
    assert.ok(er.content[0].text.includes('[admin slot] proxy admin 0x7777'))
  })

  await test('lusca_lens: report summary, IDL, primitives, dataset verdict; refusals carry Retry-After', async () => {
    const r = await call(url, 'lusca_lens', { chain: 'solana', address: PUMP }, 1, { 'x-test-ip': '10.0.0.7' })
    const res = r.json.result
    assert.equal(res.isError, false)
    const text = res.content[0].text as string
    assert.match(text, /LUSCA Lens · solana · pump/)
    assert.match(text, /upgrade authority: 7gZu/)
    assert.match(text, /IDL \(Anchor IDL account\): 2 instructions — buy, sell/)
    assert.match(text, /SHA-256/)
    assert.match(text, /SEPIA-1 training data: duplicate/)
    assert.doesNotMatch(text, /known-repository files/, 'no provenance line when nothing was checked')
    assert.equal(src.lensCalls.at(-1)?.ip, '10.0.0.7', 'Lens limits key on the client address')
    assert.equal(res.structuredContent.solana.idl.instructionCount, 2)
    const busy = await call(url, 'lusca_lens', { chain: 'base', address: '0x' + '4'.repeat(40) })
    assert.equal(busy.json.result.isError, true)
    assert.match(busy.json.result.content[0].text, /too many Lens requests.*retry after 30 s/)
  })

  await test('lusca_radar + lusca_radar_event: list, filters, full record with the source diff summary', async () => {
    const r = await call(url, 'lusca_radar', { kind: 'upgrade', limit: 5 })
    const res = r.json.result
    const text = res.content[0].text as string
    assert.match(text, /last 24 h: 1,657 events/)
    assert.match(text, /id eth-abc123def4/)
    assert.match(text, /source diff available/)
    assert.equal(res.structuredContent.items.length, 1)
    assert.equal(res.structuredContent.items[0].url, 'https://lusca.ink/radar/eth-abc123def4')
    const e = await call(url, 'lusca_radar_event', { id: 'eth-abc123def4' })
    const et = e.json.result.content[0].text as string
    assert.match(et, /admin checks added: pause\(\) \[onlyOwner\] Vault\.sol:88/)
    assert.match(et, /source diff \(Sourcify, 0x1111.* → 0x2222.*\): 1 files changed \(\+14 −2\), 31 unchanged/)
    assert.match(et, /added pause\(\) \[onlyOwner\] src\/Vault\.sol:88/)
    assert.match(et, /calls: 2 \(1 RPC, 1 registry\)/)
    assert.doesNotMatch(et, /public RPC|PublicNode/i, 'no endpoint wording in answers')
    assert.doesNotMatch(JSON.stringify(e.json.result.structuredContent), /public RPC|PublicNode/i)
    assert.equal(e.json.result.structuredContent.sourceDiffSummary.functions[0].sig, 'pause()')
    const bad = await call(url, 'lusca_radar_event', { id: 'nope' })
    assert.match(bad.json.result.content[0].text, /id has the wrong format|id must be at least/)
    const none = await call(url, 'lusca_radar_event', { id: 'eth-zzzzzzzzzz' })
    assert.match(none.json.result.content[0].text, /no radar event with id/)
  })

  await test('lusca_atlas_relatives, lusca_scan_recent, lusca_control_summary, lusca_stats', async () => {
    const a = (await call(url, 'lusca_atlas_relatives', { chain: 'solana', address: PUMP })).json.result
    assert.match(a.content[0].text, /29% similar · 13 shared names · solana · pump_amm/)
    const s = (await call(url, 'lusca_scan_recent', { limit: 5, verdict: 'kept' })).json.result
    assert.equal(s.structuredContent.items.length, 1)
    assert.match(s.content[0].text, /KEPT · ResolverRegistry/)
    assert.match(s.content[0].text, /calls: 2 \(1 RPC, 1 registry\) in 537 ms · eth_getCode → Sourcify/)
    assert.doesNotMatch(JSON.stringify(s.structuredContent), /PublicNode/)
    const c = (await call(url, 'lusca_control_summary', { chain: 'solana' })).json.result
    assert.match(c.content[0].text, /Control census · solana — 767 kept/)
    assert.match(c.content[0].text, /key: 331 \(43% of resolved\)/)
    const st = (await call(url, 'lusca_stats', {})).json.result
    assert.match(st.content[0].text, /577,279 pages · 1,067,829,062 tokens/)
    assert.match(st.content[0].text, /58,769 passed · 0 failed/)
    assert.doesNotMatch(st.content[0].text + JSON.stringify(st.structuredContent), /inkIssued|\bINK\b|[Pp]ayout/, 'never payout amounts')
  })

  await test('lusca_controlled_by: reverse lookup of a controller; lusca_kept_item: the stored read', async () => {
    const c = (await call(url, 'lusca_controlled_by', { address: PUMP_AUTH })).json.result
    assert.equal(c.isError, false)
    assert.match(c.content[0].text, /Controlled by 7gZu\w+ · program-derived address · solana/)
    assert.match(c.content[0].text, /can change 3 kept programs/)
    assert.ok(c.content[0].text.includes('can change 3 kept programs / contracts (as upgrade authority):'))
    assert.equal(c.structuredContent.total, 3)
    assert.equal(c.structuredContent.role.kind, 'pda')
    const none = (await call(url, 'lusca_controlled_by', { address: '0x' + '6'.repeat(40) })).json.result
    assert.equal(none.isError, false)
    assert.match(none.content[0].text, /holds no kept program or contract this address can change/)
    const bad = (await call(url, 'lusca_controlled_by', { address: 'not-an-address-at-all-0000000000000' })).json.result
    assert.equal(bad.isError, true)
    const k = (await call(url, 'lusca_kept_item', { chain: 'ethereum', address: '0xC82fb8fb873b0c56e1aeb9238d79b27e3d67f155' })).json.result
    assert.equal(k.isError, false)
    assert.match(k.content[0].text, /Kept · ethereum · ResolverRegistry/)
    assert.match(k.content[0].text, /verified: sourcify partial match · v0\.8\.24/)
    assert.match(k.content[0].text, /source files \(2, 516\.4 KB\): src\/ResolverRegistry\.sol \(14\.0 KB\)/)
    assert.match(k.content[0].text, /ABI functions \(2\): register\(bytes32,address\), resolve\(bytes32\)/)
    assert.equal(k.structuredContent.sources.count, 2)
    const nk = (await call(url, 'lusca_kept_item', { chain: 'solana', address: AMM })).json.result
    assert.equal(nk.isError, true)
    assert.match(nk.content[0].text, /not kept by LUSCA/)
  })

  await test('2025-03-26 clients get text results without structuredContent', async () => {
    const r = await call(url, 'lusca_stats', {}, 1, { 'MCP-Protocol-Version': '2025-03-26' })
    assert.equal(r.json.result.structuredContent, undefined)
    assert.ok(r.json.result.content[0].text)
  })

  await test('answers are cached per arguments; identical calls in flight are shared', async () => {
    let n = 0
    const slow = fixtureSource({
      async controlSummary() {
        n++
        await new Promise((r) => setTimeout(r, 30))
        return SUMMARY
      },
    })
    const m = createMcp({ source: slow })
    const [a, b] = await Promise.all([m.callTool('lusca_control_summary', {}, { ip: '1' }), m.callTool('lusca_control_summary', {}, { ip: '2' })])
    assert.equal(n, 1)
    assert.equal(a.content[0].text, b.content[0].text)
    await m.callTool('lusca_control_summary', {}, { ip: '3' })
    assert.equal(n, 1, 'served from the cache')
    await m.callTool('lusca_control_summary', { chain: 'solana' }, { ip: '3' })
    assert.equal(n, 2, 'other arguments, other answer')
  })

  await test('caps: in-flight limit, tool timeout, internal errors stay generic', async () => {
    const hang = fixtureSource({ controlSummary: () => new Promise(() => {}), stats: () => Promise.reject(new Error('secret stack detail')) })
    const m = createMcp({ source: hang, maxInFlight: 1, toolTimeoutMs: 50 })
    const p1 = m.callTool('lusca_control_summary', {}, { ip: '1' })
    const busy = await m.callTool('lusca_radar', {}, { ip: '1' })
    assert.equal(busy.isError, true)
    assert.match(busy.content[0].text, /many tool calls/)
    const t = await p1
    assert.equal(t.isError, true)
    assert.match(t.content[0].text, /took too long/)
    const err = await m.callTool('lusca_stats', {}, { ip: '1' })
    assert.equal(err.isError, true)
    assert.doesNotMatch(err.content[0].text, /secret/)
    const off = createMcp({ source: fixtureSource({ controlSummary: () => Promise.reject(new SourceError('the control map is not available on this server')) }) })
    const o = await off.callTool('lusca_control_summary', {}, { ip: '1' })
    assert.equal(o.isError, true)
    assert.match(o.content[0].text, /control map is not available/)
  })

  await test('rate limits: per-address requests and tool calls → 429 with Retry-After', async () => {
    const m = createMcp({ source: fixtureSource(), limits: { requestsPerMin: 3, toolCallsPerMin: 2 } })
    const s = await serve(m)
    try {
      const h = { 'x-test-ip': '10.9.9.9' }
      assert.equal((await call(s.url, 'lusca_stats', {}, 1, h)).status, 200)
      assert.equal((await call(s.url, 'lusca_stats', {}, 2, h)).status, 200)
      const third = await call(s.url, 'lusca_stats', {}, 3, h)
      assert.equal(third.status, 429, 'tool-call window')
      assert.ok(Number(third.headers.get('retry-after')) > 0)
      const fourth = await post(s.url, { jsonrpc: '2.0', id: 4, method: 'ping' }, h)
      assert.equal(fourth.status, 429, 'request window')
      assert.equal((await post(s.url, { jsonrpc: '2.0', id: 5, method: 'ping' }, { 'x-test-ip': '10.9.9.10' })).status, 200, 'other addresses unaffected')
    } finally {
      s.server.close()
    }
  })

  await test('registry: one more tool in a few lines', async () => {
    const m = createMcp({ source: fixtureSource() })
    m.registry.add(
      defineTool({
        name: 'lusca_echo',
        title: 'Echo',
        description: 'Returns its word (test tool for the registry contract).',
        inputSchema: { type: 'object', properties: { word: { type: 'string', maxLength: 10 } }, required: ['word'], additionalProperties: false },
        async run(args, ctx) {
          return { text: String(args.word), data: { word: args.word, links: [ctx.site], asOf: ctx.now() } }
        },
      }),
    )
    assert.equal(m.listTools().length, 11)
    const r = await m.callTool('lusca_echo', { word: 'octopus' }, { ip: '1' })
    assert.equal(r.content[0].text, 'octopus')
    assert.throws(() => m.registry.add(TOOLS[0]), /registered twice/)
  })

  console.log('mcp sources')

  await test('localSource reads the hub modules; a missing module is a SourceError', async () => {
    const mods = {
      chain: { stats: () => ({ agents: [], reads: 5, kept: 2, rejected: {}, programs: 1, contracts: 1, idls: 1, verified: 1, sourceBytes: 10, byChain: {}, frontier: {}, budget: {}, updatedAt: 1 }), feed: (n: number) => FEED.slice(0, n), item: () => KEPT },
      lens: { route: async (p: string, ip: string) => (p.includes(PUMP) ? { status: 200, json: JSON.stringify({ report: REPORT, cached: false, fresh: 1 }) } : { status: 429, json: JSON.stringify({ error: `slow ${ip}` }), headers: { 'Retry-After': '12' } }) },
      control: { summary: () => SUMMARY, list: () => ({ items: CONTROL, total: 3, next: null }), get: (_c: ChainId, a: string) => CONTROL.find((e) => e.address === a) ?? null },
      atlas: { route: (p: string) => (p.endsWith(PUMP) ? { status: 200, json: JSON.stringify(ATLAS) } : { status: 404, json: '{"error":"not on the atlas yet"}' }) },
    }
    const s = localSource(() => mods, { stats: () => ({ pages: 3, tokens: 4, domains: 1, pagesPerMin: 0, tokensPerMin: 0 }) as any, audits: () => ({ ok: 2, failed: 0 }) })
    assert.equal((await s.feed(1)).length, 1)
    const l = await s.lens('solana', PUMP, '1.2.3.4')
    assert.ok(l.ok && l.answer.report.name === 'pump')
    const busy = await s.lens('solana', AMM, '1.2.3.4')
    assert.ok(!busy.ok && busy.status === 429 && busy.retryAfterS === 12 && busy.error === 'slow 1.2.3.4')
    assert.equal((await s.atlasItem('solana', AMM)), null)
    assert.equal((await s.atlasItem('solana', PUMP))?.name, 'pump')
    const st = await s.stats()
    assert.equal(st.chain?.kept, 2)
    assert.equal(st.audits?.ok, 2)
    assert.equal(st.code, null)
    await assert.rejects(() => s.radarList({ limit: 1 }), /upgrade radar is not available/)
    const starting = localSource(() => null)
    await assert.rejects(() => starting.controlSummary(), /starting/)
  })

  await test('remoteSource: one request at a time with spacing, cached, 404 → null', async () => {
    const seen: { url: string; at: number }[] = []
    const fake = (async (u: string) => {
      seen.push({ url: String(u), at: Date.now() })
      if (String(u).includes('/api/control/solana/')) return new Response(JSON.stringify(CONTROL[0]), { status: 200 })
      return new Response('{"error":"not found"}', { status: 404 })
    }) as typeof fetch
    const s = remoteSource({ base: 'https://lusca.example/', spacingMs: 40, fetch: fake })
    const [a, b] = await Promise.all([s.controlGet('solana', PUMP), s.controlGet('base', '0x' + '5'.repeat(40))])
    assert.equal(a?.name, 'pump')
    assert.equal(b, null)
    assert.equal(seen.length, 2)
    assert.ok(seen[1].at - seen[0].at >= 35, 'spaced')
    assert.equal(seen[0].url, `https://lusca.example/api/control/solana/${PUMP}`)
    await s.controlGet('solana', PUMP)
    assert.equal(seen.length, 2, 'cached')
  })

  await test('helpers: endpoint wording scrubbed, schema subset', () => {
    assert.equal(viaText('eth_getLogs · Base public RPC'), 'eth_getLogs')
    assert.equal(scrub('Solana public websocket, gaps on Solana public RPC, via PublicNode'), 'websocket, gaps on RPC, via RPC')
    assert.equal(validate({ type: 'object', properties: { n: { type: 'integer', minimum: 1 } }, additionalProperties: false }, { n: 1.5 }), 'n must be an integer')
    assert.equal(validate({ type: 'object', properties: {}, additionalProperties: false }, null), 'arguments must be an object')
    assert.deepEqual(mcpLimitsFromEnv({ LUSCA_MCP_REQ_PER_MIN: '300', LUSCA_MCP_TOOLS_PER_MIN: 'x', LUSCA_MCP_GLOBAL_PER_MIN: '0' }), { requestsPerMin: 300 })
  })
} finally {
  server.close()
}

console.log(`mcp: ${passed} passed`)
