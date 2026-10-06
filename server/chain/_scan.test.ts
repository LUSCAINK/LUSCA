// Tests: the call trace and decoded fields chain-agent reads carry for /scan (server/chain/trace.ts,
// agents.ts wiring, rpc.ts provider names). Run: npx tsx server/chain/_scan.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChainEvent, ChainId, ChainRead } from '../../shared/chain.ts'
import { RpcError, createRpc, providerOfUrl, registerSecretUrl, type RpcCtx } from './rpc.ts'
import { SCAN_EVENT_MAX_BYTES, TRACE_MAX, capScan, createTraceRecorder, rpcResultOf, scanDocOf, targetOf } from './trace.ts'
import { createChainAgentsWith, type ChainCandidate, type DiscoveryLike, type ReadEvmFn, type ReadSolanaFn } from './agents.ts'
import { createChainStore } from './store.ts'

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

const tmp = mkdtempSync(join(tmpdir(), 'lusca-scan-'))
const quiet = () => {}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SOL = 'Prog1111111111111111111111111111111111111A'
const EVM = '0x1111111111111111111111111111111111111111'
const IMPL = '0x2ce6311ddae708829bc0784c967b7d77d19fd779'
const ZOS_IMPL = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3'
const SECRET = 'https://mainnet.helius-rpc.com/?api-key=0123456789abcdef0123'

function mkRead(chain: ChainId, address: string, o: Partial<ChainRead> = {}): ChainRead {
  return {
    chain,
    address,
    kind: chain === 'solana' ? 'program' : 'contract',
    name: null,
    codeHash: null,
    upgradeable: null,
    upgradeAuthority: null,
    lastDeploySlot: null,
    programBytes: null,
    loader: null,
    idl: null,
    securityTxt: null,
    bytecodeBytes: null,
    proxy: null,
    abi: null,
    verified: null,
    sources: [],
    notes: [],
    readAt: Date.now(),
    rpcCalls: 1,
    ...o,
  }
}

/** A context answering like the real endpoints do for one read. */
function fakeCtx(o: { failSourcify?: 'missing' | 'timeout' } = {}): RpcCtx & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async call(_chain, method, params) {
      calls.push(method)
      await wait(2)
      if (method === 'getMultipleAccounts') return { value: [{ data: ['A'.repeat(800), 'base64+zstd'], space: 1852 }, { data: ['', 'base64'], space: 412_311 }, null, null] }
      if (method === 'eth_getCode') return `0x${'60'.repeat(1234)}`
      if (method === 'eth_getStorageAt') return params[1] === ZOS_IMPL ? `0x${'0'.repeat(24)}${IMPL.slice(2)}` : `0x${'0'.repeat(64)}`
      return null
    },
    async fetchJson(url) {
      calls.push(url.includes('sourcify') ? 'sourcify' : 'osec')
      if (url.includes('sourcify')) {
        if (o.failSourcify === 'missing') throw new RpcError('http', 'sourcify GET: HTTP 404', { status: 404 })
        if (o.failSourcify === 'timeout') throw new RpcError('timeout', `sourcify GET: timed out (${SECRET})`, { transient: true })
        return { match: 'exact_match' }
      }
      return { is_verified: true, repo_url: 'https://github.com/x/y' }
    },
    usage: () => ({}),
    canSpend: () => true,
  }
}

await test('trace: Solana read — one getMultipleAccounts via Helius, OtterSec registry, offsets and durations', async () => {
  const inner = fakeCtx()
  const rec = createTraceRecorder(inner, { provider: (k) => (k === 'solana' ? 'Helius' : k === 'osec' ? 'OtterSec' : 'x') })
  await rec.ctx.call('solana', 'getMultipleAccounts', [[SOL, 'a', 'b', 'c'], { encoding: 'base64+zstd' }])
  await rec.ctx.fetchJson(`https://verify.osec.io/status/${SOL}`, { host: 'osec' })
  const t = rec.calls()
  assert.equal(t.length, 2)
  assert.deepEqual(
    t.map((c) => [c.kind, c.method, c.target, c.provider, c.ok, c.result]),
    [
      ['rpc', 'getMultipleAccounts', 'program · programdata · IDL accounts', 'Helius', true, '2 of 4 accounts · 414,163 bytes'],
      ['registry', 'OtterSec', 'verified-build status', 'OtterSec', true, 'verified build'],
    ],
  )
  assert.equal(t[0].t, 0)
  assert.ok(t[1].t >= t[0].t + t[0].ms, 'second call starts after the first ends')
  assert.ok(t.every((c) => c.ms >= 0))
  assert.deepEqual(inner.calls, ['getMultipleAccounts', 'osec'], 'exactly the reader’s calls, nothing added')
})

await test('trace: EVM slots by name, implementation result, Sourcify 404 is an answer, failures redacted', async () => {
  registerSecretUrl(SECRET)
  const rec = createTraceRecorder(fakeCtx({ failSourcify: 'missing' }), { provider: (k) => (k === 'base' ? 'PublicNode' : 'Sourcify'), address: EVM })
  await rec.ctx.call('base', 'eth_getCode', [EVM, 'latest'])
  await rec.ctx.call('base', 'eth_getStorageAt', [EVM, ZOS_IMPL, 'latest'])
  await assert.rejects(rec.ctx.fetchJson(`https://sourcify.dev/server/v2/contract/8453/${EVM}?fields=sources,abi`, { host: 'sourcify' }))
  const t = rec.calls()
  assert.equal(t[0].result, '1,234 bytes')
  assert.equal(t[0].target, 'runtime bytecode')
  assert.equal(t[1].target, 'org.zeppelinos.proxy.implementation')
  assert.equal(t[1].result, '→ 0x2ce6…d779')
  assert.equal(t[2].ok, true)
  assert.equal(t[2].result, 'no match')

  const rec2 = createTraceRecorder(fakeCtx({ failSourcify: 'timeout' }), { provider: () => SECRET })
  await assert.rejects(rec2.ctx.fetchJson(`https://sourcify.dev/server/v2/contract/1/${EVM}?fields=sources`, { host: 'sourcify' }))
  const c = rec2.calls()[0]
  assert.equal(c.ok, false)
  assert.equal(c.result, 'timeout')
  assert.ok(!JSON.stringify(rec2.calls()).includes('helius-rpc'), 'no endpoint URL in the trace')
  assert.ok(!JSON.stringify(rec2.calls()).includes('0123456789abcdef'), 'no key in the trace')
})

await test('trace: bounded to TRACE_MAX calls; targets and results of the other methods', async () => {
  const rec = createTraceRecorder(fakeCtx(), {})
  for (let i = 0; i < TRACE_MAX + 5; i++) await rec.ctx.call('ethereum', 'eth_getStorageAt', [EVM, '0x0', 'latest'])
  assert.equal(rec.calls().length, TRACE_MAX)
  assert.equal(rec.more(), 5)
  assert.equal(targetOf('getMultipleAccounts', [['x']]), 'programdata')
  assert.equal(targetOf('eth_call', [{ to: IMPL, data: '0x5c60da1b' }], EVM), 'implementation() on beacon 0x2ce6…d779')
  assert.equal(targetOf('eth_call', [{ to: EVM, data: '0x5c60da1b' }], EVM), 'implementation()')
  assert.equal(rpcResultOf('eth_getCode', '0x'), 'no code')
  assert.equal(rpcResultOf('eth_call', `0x${'0'.repeat(64)}`), 'empty')
})

await test('provider names: Helius by host, public endpoints by name, never any part of the URL', () => {
  assert.equal(providerOfUrl(SECRET), 'Helius')
  assert.equal(providerOfUrl('https://ethereum-rpc.publicnode.com'), 'PublicNode')
  assert.equal(providerOfUrl('https://api.mainnet-beta.solana.com'), 'Solana public RPC')
  assert.equal(providerOfUrl('https://my-node.example.com/abcdef0123456789abcdef', 'Base RPC'), 'Base RPC')
  assert.equal(providerOfUrl('not a url', 'RPC'), 'RPC')
  const rpc = createRpc({ solanaRpc: SECRET })
  assert.equal(rpc.provider('solana'), 'Helius')
  assert.equal(rpc.provider('solana-discovery'), 'Solana public RPC')
  assert.equal(rpc.provider('sourcify'), 'Sourcify')
  void rpc.close()
})

await test('scan doc: decoded fields only when known; capped lists; event stays under 8 KB', () => {
  const sol = scanDocOf(
    mkRead('solana', SOL, {
      loader: 'BPF upgradeable loader',
      upgradeable: true,
      upgradeAuthority: 'Auth111111111111111111111111111111111111111',
      lastDeploySlot: 312_000_000,
      programBytes: 412_311,
      codeHash: 'ab'.repeat(32),
      idl: { name: 'amm', version: '0.1.0', instructions: Array.from({ length: 40 }, (_, i) => ({ name: `ix_${i}`, args: 1, accounts: 2 })), accounts: ['Pool'], types: 3, errors: 4, events: 1 },
      notes: ['IDL from the Anchor IDL account (anchor)', 'OtterSec verified build (checked 2026-10-01)', 'something else'],
    }),
    { primitives: ['sha256 (sol_sha256)'] },
  )
  assert.equal(sol.authority, 'Auth111111111111111111111111111111111111111')
  assert.equal(sol.idl!.source, 'Anchor IDL account (anchor)')
  assert.equal(sol.idl!.names.length, 24)
  assert.equal(sol.idl!.more, 16)
  assert.deepEqual(sol.notes, ['OtterSec verified build (checked 2026-10-01)'])
  assert.equal(sol.proxy, undefined)
  assert.equal(sol.verified, undefined)

  const empty = scanDocOf(mkRead('ethereum', EVM, { kind: 'empty' }))
  assert.deepEqual(empty, {}, 'nothing known, nothing shown')

  const evm = scanDocOf(
    mkRead('base', EVM, {
      proxy: { standard: 'other', implementation: IMPL },
      upgradeAuthority: '0x3abd6f64a422225e61e435bae41db12096106df7',
      verified: { by: 'sourcify', match: 'full', repo: null, commit: null, compiler: 'solc 0.6.12' },
      abi: { functions: Array.from({ length: 300 }, (_, i) => `fn${i}(uint256,address,bytes32,${'uint256,'.repeat(10)}bool)`), events: ['Transfer(address,address,uint256)'] },
    }),
    {
      sourcePaths: Array.from({ length: 200 }, (_, i) => `contracts/very/long/directory/name/for/padding/File${i}.sol`),
      privileged: Array.from({ length: 30 }, (_, i) => ({ fn: `configure${i}(address,uint256)`, guard: 'onlyMasterMinter', file: 'contracts/v1/FiatTokenV1.sol', line: 100 + i })),
    },
  )
  assert.equal(evm.proxy!.admin, '0x3abd6f64a422225e61e435bae41db12096106df7')
  assert.equal(evm.files!.more, 188)
  assert.equal(evm.privileged!.items[0].at, 'FiatTokenV1.sol:100')
  assert.equal(evm.privileged!.more, 22)

  const ev: ChainEvent = {
    id: 'x',
    ts: 1,
    agent: 'base-1',
    chain: 'base',
    address: EVM,
    name: 'FiatTokenProxy',
    kind: 'contract',
    via: 'registry',
    verdict: 'kept',
    reason: 'verified source',
    idl: false,
    verifiedBy: 'sourcify',
    sourceFiles: 200,
    sourceBytes: 1,
    trace: Array.from({ length: 24 }, (_, i) => ({ kind: 'rpc' as const, method: 'eth_getStorageAt', target: `x${'y'.repeat(60)}${i}`, provider: 'PublicNode', t: i, ms: 3, ok: true, result: 'z'.repeat(48) })),
    scan: evm,
  }
  const capped = capScan(ev)
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= SCAN_EVENT_MAX_BYTES, `size ${Buffer.byteLength(JSON.stringify(capped))}`)
  assert.ok(capped.scan, 'decoded fields kept, trimmed')
  assert.ok(capped.scan!.files!.paths.length >= 1)
  assert.ok(capped.scan!.files!.more + capped.scan!.files!.paths.length === 200, 'truncation counted')
  assert.ok(capped.trace!.length >= 4)
  assert.equal(ev.scan!.files!.paths.length, 12, 'the input is not mutated')
})

await test('agents: every read carries its call trace and decoded fields; errors carry the failing call', async () => {
  const store = createChainStore({ dataDir: join(tmp, 'a'), log: quiet, saveDelayMs: 0 })
  const queue: ChainCandidate[] = [
    { chain: 'solana', address: SOL, via: 'block', score: 5 },
    { chain: 'ethereum', address: EVM, via: 'registry', score: 4 },
  ]
  const marked: string[] = []
  const discovery: DiscoveryLike = {
    start() {},
    stop: async () => {},
    next: (chain) => {
      const i = queue.findIndex((c) => c.chain === chain)
      return i >= 0 ? queue.splice(i, 1)[0] : null
    },
    push() {},
    markRead: (chain, address) => void marked.push(`${chain}:${address}`),
    stats: () => ({}),
  }
  const readSolana: ReadSolanaFn = async (address, ctx, opts) => {
    await ctx.call('solana', 'getMultipleAccounts', [[address, 'a', 'b', 'c'], {}])
    await ctx.fetchJson(`https://verify.osec.io/status/${address}`, { host: 'osec' })
    opts?.onElf?.(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))
    return {
      read: mkRead('solana', address, {
        codeHash: 'p1',
        loader: 'BPF upgradeable loader',
        upgradeable: true,
        upgradeAuthority: 'Auth111111111111111111111111111111111111111',
        idl: { name: 'amm', version: '0.1.0', instructions: [{ name: 'swap', args: 2, accounts: 7 }], accounts: ['Pool'], types: 3, errors: 4, events: 1 },
        name: 'amm',
      }),
      idlJson: { name: 'amm' },
    }
  }
  const readEvm: ReadEvmFn = async (_chain, address, ctx) => {
    await ctx.call('ethereum', 'eth_getCode', [address, 'latest'])
    await ctx.fetchJson(`https://sourcify.dev/server/v2/contract/1/${address}?fields=sources`, { host: 'sourcify' })
    throw new Error('eth_getCode returned a malformed result')
  }
  const sent: ChainEvent[] = []
  const inner = fakeCtx()
  const agents = createChainAgentsWith({
    rpc: { ...inner, provider: (k) => (k === 'solana' ? 'Helius' : k === 'osec' ? 'OtterSec' : k === 'sourcify' ? 'Sourcify' : 'PublicNode') },
    discovery,
    readSolana,
    readEvm,
    store,
    broadcast: (m) => sent.push(m.event),
    log: quiet,
    agents: [
      { id: 'sol-1', chain: 'solana' },
      { id: 'eth-1', chain: 'ethereum' },
    ],
    analysers: { elfPrimitives: () => ['sha256 (sol_sha256)'] },
    minGapMs: 0,
    idleMs: 20,
    pace: false,
    broadcastPerSec: 50,
  })
  agents.start()
  const t0 = Date.now()
  while (sent.length < 2 && Date.now() - t0 < 4000) await wait(10)
  await agents.stop()
  const feed = agents.feed(10)
  const sol = feed.find((e) => e.chain === 'solana')!
  assert.equal(sol.verdict, 'kept')
  assert.deepEqual(
    sol.trace!.map((c) => `${c.method}|${c.provider}|${c.ok}`),
    ['getMultipleAccounts|Helius|true', 'OtterSec|OtterSec|true'],
  )
  assert.equal(sol.scan!.authority, 'Auth111111111111111111111111111111111111111')
  assert.deepEqual(sol.scan!.idl!.names, ['swap'])
  assert.deepEqual(sol.scan!.primitives, ['sha256 (sol_sha256)'])
  const evm = feed.find((e) => e.chain === 'ethereum')!
  assert.equal(evm.verdict, 'error')
  assert.deepEqual(
    evm.trace!.map((c) => `${c.method}|${c.result}`),
    ['eth_getCode|1,234 bytes', 'Sourcify|full match'],
  )
  assert.ok(sent.every((e) => Buffer.byteLength(JSON.stringify(e)) <= SCAN_EVENT_MAX_BYTES))
  assert.ok(sent.find((e) => e.chain === 'solana')?.trace, 'the broadcast carries the trace')
  await store.close()
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
