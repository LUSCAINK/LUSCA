// EVM reader tests: fixtures (real mainnet bytecode + a trimmed Sourcify record) and synthetic code,
// a fake RpcCtx, no network.
//   npx tsx server/chain/_evm.test.ts
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { RpcError, BudgetError, type RpcCtx } from './rpc.ts'
import {
  PROXY_SLOTS,
  eip7702Delegate,
  evmCodeHash,
  hasOpcode,
  hexToBytes,
  minimalProxyTarget,
  readEvm,
  splitMetadata,
  wordToAddress,
} from './evm.ts'
import { abiSignatures, normalizeSource, profileEvmSources, sourceBundleHash, stripSolidity } from './evm-source.ts'
import { AAVE_POOL_PROXY_CODE, WETH9_CODE, WETH9_SOURCIFY } from './_evm.fixtures.ts'

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

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const buf = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex')
const word = (addr: string) => `0x${'0'.repeat(24)}${addr.replace(/^0x/, '').toLowerCase()}`
const ZERO = `0x${'0'.repeat(64)}`
const IMPL = '0x1111111111111111111111111111111111111111'
const BEACON = '0x2222222222222222222222222222222222222222'
const ADDR = '0x3333333333333333333333333333333333333333'

interface Fake {
  ctx: RpcCtx
  calls: { method: string; params: unknown[] }[]
  urls: string[]
}
function fakeCtx(h: { call?: (method: string, params: unknown[]) => unknown; fetch?: (url: string, n: number) => unknown }): Fake {
  const calls: Fake['calls'] = []
  const urls: string[] = []
  const ctx: RpcCtx = {
    async call(_chain, method, params) {
      calls.push({ method, params })
      if (!h.call) throw new Error('unexpected rpc')
      return h.call(method, params)
    },
    async fetchJson(url) {
      urls.push(url)
      if (!h.fetch) throw new Error('unexpected http')
      return h.fetch(url, urls.length)
    },
    usage: () => ({}),
    canSpend: () => true,
  }
  return { ctx, calls, urls }
}
const sourcify404 = () => {
  throw new RpcError('http', 'sourcify GET: HTTP 404', { status: 404, body: { match: null } })
}
/** RPC handler: code for eth_getCode, storage map for eth_getStorageAt, zero otherwise. */
const chainState =
  (code: string, storage: Record<string, string> = {}, calls: Record<string, string> = {}) =>
  (method: string, params: unknown[]) => {
    if (method === 'eth_getCode') return code
    if (method === 'eth_getStorageAt') return storage[String(params[1])] ?? ZERO
    if (method === 'eth_call') {
      const p = params[0] as { to: string; data: string }
      return calls[`${p.to}:${p.data}`] ?? '0x'
    }
    throw new Error(`unexpected ${method}`)
  }

// ─── bytecode ────────────────────────────────────────────────────────────────

await test('CBOR trailer: WETH9 (bzzr0) and Aave proxy (ipfs + solc) are stripped exactly', () => {
  const w = buf(WETH9_CODE)
  const ws = splitMetadata(w)
  assert.deepEqual(ws.keys, ['bzzr0'])
  assert.equal(ws.metadataBytes, 0x29 + 2)
  assert.equal(evmCodeHash(w), sha(w.subarray(0, w.length - 43)))
  const a = buf(AAVE_POOL_PROXY_CODE)
  const as = splitMetadata(a)
  assert.deepEqual(as.keys, ['ipfs', 'solc'])
  assert.equal(as.metadataBytes, 0x33 + 2)
  assert.equal(as.body.length, a.length - 53)
})

await test('CBOR trailer: bytecodeHash none (solc only) and Vyper 0.4 array form', () => {
  const body = '6080604052348015600f57600080fd5b50'
  const solcOnly = splitMetadata(buf(body + 'a164736f6c6343000706000a'))
  assert.deepEqual(solcOnly.keys, ['solc'])
  assert.equal(solcOnly.body.toString('hex'), body)
  // [runtime size 0x1234, [], 0, {'vyper': [0, 4, 0]}] + length 0x0011
  const vy = splitMetadata(buf(body + '841912348000a165767970657283000400' + '0011'))
  assert.deepEqual(vy.keys, ['vyper'])
  assert.equal(vy.body.toString('hex'), body)
})

await test('CBOR trailer: metadata-only differences share a codeHash; malformed trailers are not stripped', () => {
  const body = '6080604052600080fd'
  const ipfs = (h: string) => `a2646970667358221220${h}64736f6c63430008140033`
  const a = buf(body + 'fe' + ipfs('11'.repeat(32)))
  const b = buf(body + 'fe' + ipfs('22'.repeat(32)))
  const c = buf('6080604052600180fd' + 'fe' + ipfs('11'.repeat(32)))
  assert.equal(evmCodeHash(a), evmCodeHash(b))
  assert.notEqual(evmCodeHash(a), evmCodeHash(c))
  // length in range but the bytes are not one CBOR item → whole code hashed
  const bad = buf(body + '00'.repeat(20) + '0014')
  assert.equal(splitMetadata(bad).metadataBytes, 0)
  assert.equal(evmCodeHash(bad), sha(bad))
  // length larger than the code
  const big = buf('6001ffff')
  assert.equal(splitMetadata(big).metadataBytes, 0)
})

await test('opcode scan skips PUSH immediates; clone / 7702 patterns; storage words', () => {
  assert.equal(hasOpcode(buf('7f' + 'f4'.repeat(32) + '00'), 0xf4), false) // f4 inside PUSH32 data
  assert.equal(hasOpcode(buf('60016000f4'), 0xf4), true)
  // the reader scans the code without its trailer: WETH9's bzzr0 hash happens to hold an f4 byte
  assert.equal(hasOpcode(splitMetadata(buf(WETH9_CODE)).body, 0xf4), false)
  assert.equal(minimalProxyTarget(buf(`363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`)), IMPL)
  // vanity form: PUSH19 of an address with one leading zero byte
  const short = '00' + 'ab'.repeat(19)
  assert.equal(minimalProxyTarget(buf(`363d3d373d3d3d363d72${short.slice(2)}5af43d82803e903d91602a57fd5bf3`)), `0x${short}`)
  assert.equal(minimalProxyTarget(buf(`363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf300`)), null)
  assert.equal(eip7702Delegate(buf(`ef0100${IMPL.slice(2)}`)), IMPL)
  assert.equal(wordToAddress(word(IMPL)), IMPL)
  assert.equal(wordToAddress(ZERO), null)
  assert.equal(wordToAddress(`0x${'ff'.repeat(32)}`), null) // not an address
  assert.equal(wordToAddress('0x0'), null)
  assert.deepEqual(hexToBytes('0x'), Buffer.alloc(0))
  assert.equal(hexToBytes('0x123'), null)
  assert.equal(hexToBytes(42), null)
})

// ─── reader ──────────────────────────────────────────────────────────────────

await test('plain verified contract (WETH9): one RPC call, Sourcify match, ABI, sources, bundle hash', async () => {
  const f = fakeCtx({ call: chainState(WETH9_CODE), fetch: () => WETH9_SOURCIFY })
  const { read, abiJson, sources, sourceBundleHash: bh, profile } = await readEvm('ethereum', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', f.ctx)
  assert.equal(read.address, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
  assert.equal(read.kind, 'contract')
  assert.equal(read.rpcCalls, 1)
  assert.equal(f.calls.length, 1)
  assert.match(f.urls[0], /^https:\/\/sourcify\.dev\/server\/v2\/contract\/1\/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2\?fields=/)
  assert.equal(read.name, 'WETH9')
  assert.deepEqual(read.verified, { by: 'sourcify', match: 'partial', repo: null, commit: null, compiler: 'solc 0.4.19+commit.c4cbbb05' })
  assert.equal(read.proxy, null)
  assert.equal(read.upgradeable, false)
  assert.equal(read.bytecodeBytes, buf(WETH9_CODE).length)
  assert.equal(read.codeHash, evmCodeHash(buf(WETH9_CODE)))
  assert.ok(read.abi?.functions.includes('transferFrom(address,address,uint256)'))
  assert.ok(read.abi?.functions.includes('withdraw(uint256)'))
  assert.ok(read.abi?.events.includes('Transfer(address,address,uint256)'))
  assert.ok(Array.isArray(abiJson))
  assert.equal(sources.length, 1)
  assert.deepEqual(read.sources, [{ path: 'WETH9.sol', lang: 'solidity', bytes: Buffer.byteLength(sources[0].text) }])
  assert.match(bh ?? '', /^[0-9a-f]{64}$/)
  assert.equal(profile?.token, 'erc20')
  assert.equal(profile?.tokenBase, false)
  assert.ok((profile?.customLines ?? 0) >= 40, `custom lines ${profile?.customLines}`)
  assert.equal(profile?.boilerplate, null)
  assert.ok(read.notes.includes('Sourcify partial match'))
  assert.ok(read.notes.includes('deployed in block 4719568'))
})

await test('EIP-1967 proxy (Aave v3 Pool proxy): implementation from the slot, Sourcify miss, ≤ 6 calls', async () => {
  const f = fakeCtx({ call: chainState(AAVE_POOL_PROXY_CODE, { [PROXY_SLOTS.eip1967Implementation]: word(IMPL) }), fetch: sourcify404 })
  const { read, sources, sourceBundleHash: bh } = await readEvm('ethereum', '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', f.ctx)
  assert.deepEqual(read.proxy, { standard: 'eip1967', implementation: IMPL })
  assert.equal(read.upgradeable, true)
  assert.equal(read.verified, null)
  assert.deepEqual(sources, [])
  assert.equal(bh, null)
  assert.ok(read.rpcCalls <= 6)
  assert.ok(f.calls.some((c) => c.method === 'eth_getStorageAt' && c.params[1] === PROXY_SLOTS.eip1967Implementation))
  assert.ok(read.notes.includes('Sourcify: no verified source'))
})

await test('beacon proxy: beacon slot → implementation() on the beacon', async () => {
  const code = `0x7f${PROXY_SLOTS.eip1967Beacon.slice(2)}545af400`
  const f = fakeCtx({
    call: chainState(code, { [PROXY_SLOTS.eip1967Beacon]: word(BEACON) }, { [`${BEACON}:0x5c60da1b`]: word(IMPL) }),
    fetch: sourcify404,
  })
  const { read } = await readEvm('base', ADDR, f.ctx)
  assert.deepEqual(read.proxy, { standard: 'beacon', implementation: IMPL })
  assert.equal(read.rpcCalls, 3)
  assert.match(f.urls[0], /\/contract\/8453\//)
})

await test('transparent proxy: admin slot read when its constant is in the code', async () => {
  const code = `0x7f${PROXY_SLOTS.eip1967Implementation.slice(2)}547f${PROXY_SLOTS.eip1967Admin.slice(2)}545af400`
  const admin = '0x4444444444444444444444444444444444444444'
  const f = fakeCtx({
    call: chainState(code, { [PROXY_SLOTS.eip1967Implementation]: word(IMPL), [PROXY_SLOTS.eip1967Admin]: word(admin) }),
    fetch: sourcify404,
  })
  const { read } = await readEvm('arbitrum', ADDR, f.ctx)
  assert.deepEqual(read.proxy, { standard: 'eip1967', implementation: IMPL })
  assert.equal(read.upgradeAuthority, admin)
  assert.equal(read.rpcCalls, 3)
  assert.match(f.urls[0], /\/contract\/42161\//)
})

await test('EIP-897 proxy (stETH AppProxyUpgradeable): standard slots empty → implementation() on the proxy itself', async () => {
  // DELEGATECALL, the implementation() selector in the dispatcher, no standard slot constant
  const code = `0x63${'5c60da1b'}14605657${'00'.repeat(40)}5af400`
  const f = fakeCtx({ call: chainState(code, {}, { [`${ADDR}:0x5c60da1b`]: word(IMPL) }), fetch: sourcify404 })
  const { read } = await readEvm('ethereum', ADDR, f.ctx)
  assert.deepEqual(read.proxy, { standard: 'other', implementation: IMPL })
  assert.ok(read.notes.includes(`EIP-897 proxy: implementation() → ${IMPL}`), read.notes.join(' / '))
  assert.ok(read.rpcCalls <= 6)
  // no selector in the code: not asked
  const g = fakeCtx({ call: chainState('0x60016000f400'), fetch: sourcify404 })
  const r2 = await readEvm('ethereum', ADDR, g.ctx)
  assert.equal(r2.read.proxy, null)
  assert.ok(!g.calls.some((c) => c.method === 'eth_call'))
  assert.ok(r2.read.notes.includes('uses DELEGATECALL; standard proxy slots are empty'))
})

await test('EIP-1167 clone: implementation from the bytecode, no slot reads, no Sourcify request', async () => {
  const f = fakeCtx({ call: chainState(`0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`) })
  const { read } = await readEvm('ethereum', ADDR, f.ctx)
  assert.equal(read.kind, 'contract')
  assert.deepEqual(read.proxy, { standard: 'eip1167', implementation: IMPL })
  assert.equal(read.upgradeable, false)
  assert.equal(read.rpcCalls, 1)
  assert.equal(f.urls.length, 0)
  assert.equal(read.bytecodeBytes, 45)
})

await test('EOA: empty code → kind empty, nothing else asked', async () => {
  const f = fakeCtx({ call: chainState('0x') })
  const { read, sources } = await readEvm('ethereum', ADDR, f.ctx)
  assert.equal(read.kind, 'empty')
  assert.equal(read.codeHash, null)
  assert.equal(read.rpcCalls, 1)
  assert.equal(f.urls.length, 0)
  assert.deepEqual(sources, [])
})

await test('EIP-7702 delegated account → kind account, delegate as the link', async () => {
  const f = fakeCtx({ call: chainState(`0xef0100${IMPL.slice(2)}`) })
  const { read } = await readEvm('ethereum', ADDR, f.ctx)
  assert.equal(read.kind, 'account')
  assert.deepEqual(read.proxy, { standard: 'other', implementation: IMPL })
  assert.equal(f.urls.length, 0)
})

await test('Sourcify miss: 404 and a null match both read as unverified; transport errors and budget errors throw', async () => {
  const code = '0x6080604052600080fd'
  for (const fetch of [sourcify404, () => ({ match: null, creationMatch: null, runtimeMatch: null, chainId: '1', address: ADDR })]) {
    const f = fakeCtx({ call: chainState(code), fetch })
    const { read } = await readEvm('ethereum', ADDR, f.ctx)
    assert.equal(read.verified, null)
    assert.equal(read.name, null)
    assert.equal(read.abi, null)
  }
  const t = fakeCtx({
    call: chainState(code),
    fetch: () => {
      throw new RpcError('timeout', 'sourcify GET: timed out after 15 s', { transient: true })
    },
  })
  await assert.rejects(readEvm('ethereum', ADDR, t.ctx), (e: Error) => e instanceof RpcError && e.transient && /sourcify GET: timed out/.test(e.message))
  const m = fakeCtx({ call: chainState(code), fetch: () => 'not a record' })
  await assert.rejects(readEvm('ethereum', ADDR, m.ctx), /Sourcify lookup failed: Sourcify returned a malformed record/)
  const b = fakeCtx({
    call: chainState(code),
    fetch: () => {
      throw new BudgetError('sourcify')
    },
  })
  await assert.rejects(readEvm('ethereum', ADDR, b.ctx), (e: Error) => e.name === 'BudgetError')
  const r = fakeCtx({
    call: () => {
      throw new BudgetError('ethereum')
    },
  })
  await assert.rejects(readEvm('ethereum', ADDR, r.ctx), (e: Error) => e.name === 'BudgetError')
  await assert.rejects(readEvm('ethereum', '0x1234', r.ctx), /not an EVM address/)
})

await test('Sourcify sources outside the verified compilation (sourceIds) are ignored', async () => {
  const rec = {
    match: 'exact_match',
    compilation: { compiler: 'solc', compilerVersion: '0.8.24+commit.e11b9ed9', name: 'Vault' },
    abi: [],
    sources: { 'src/Vault.sol': { content: 'contract Vault { uint x; }' }, 'other/Unrelated.sol': { content: 'contract Unrelated {}' } },
    sourceIds: { 'src/Vault.sol': { id: 0 } },
  }
  const f = fakeCtx({ call: chainState('0x6080604052600080fd'), fetch: () => rec })
  const { read, sources } = await readEvm('ethereum', ADDR, f.ctx)
  assert.deepEqual(
    sources.map((s) => s.path),
    ['src/Vault.sol'],
  )
  assert.equal(read.verified?.match, 'full')
  assert.ok(read.notes.includes('Sourcify full match'))
  assert.ok(read.notes.some((n) => n.startsWith('1 source files outside')))
})

await test('Sourcify record over the size cap: lean refetch keeps ABI and verification', async () => {
  const f = fakeCtx({
    call: chainState('0x6080604052600080fd'),
    fetch: (url, n) => {
      if (n === 1) throw new RpcError('too-large', 'sourcify GET: response larger than 8 MB')
      assert.match(url, /fields=abi,compilation/)
      return { match: 'match', compilation: { compiler: 'solc', compilerVersion: '0.8.20', name: 'Big' }, abi: [{ type: 'function', name: 'f', inputs: [] }] }
    },
  })
  const { read, sources } = await readEvm('ethereum', ADDR, f.ctx)
  assert.equal(f.urls.length, 2)
  assert.equal(read.verified?.match, 'partial')
  assert.deepEqual(read.abi?.functions, ['f()'])
  assert.deepEqual(sources, [])
  assert.ok(read.notes.some((n) => n.includes('over 8 MB')))
})

await test('large contract with DELEGATECALL and no slot constant: no slot probes; Sourcify proxy record fills in', async () => {
  const code = `0x${'6001'.repeat(2000)}5af400`
  const rec = {
    match: 'match',
    compilation: { compiler: 'solc', compilerVersion: '0.8.17', name: 'Diamond' },
    abi: [],
    sources: { 'Diamond.sol': { content: 'contract Diamond {}' } },
    sourceIds: { 'Diamond.sol': { id: 0 } },
    proxyResolution: { isProxy: true, proxyType: 'DiamondProxy', implementations: [{ address: IMPL.toUpperCase().replace('0X', '0x'), name: 'Facet' }] },
  }
  const f = fakeCtx({ call: chainState(code), fetch: () => rec })
  const { read } = await readEvm('ethereum', ADDR, f.ctx)
  assert.equal(read.rpcCalls, 1)
  assert.deepEqual(read.proxy, { standard: 'other', implementation: IMPL })
  assert.equal(read.upgradeable, true)
})

await test('small DELEGATECALL contract with empty slots: at most 6 RPC calls, upgradeable unknown', async () => {
  // Safe-like code (masterCopy selector) → slot 0, then the four standard slots: 1 + 1 + 4 = 6
  const code = `0x63a619486e60005460016000f400`
  const f = fakeCtx({ call: chainState(code), fetch: sourcify404 })
  const { read } = await readEvm('ethereum', ADDR, f.ctx)
  assert.ok(read.rpcCalls <= 6, `calls ${read.rpcCalls}`)
  assert.equal(read.proxy, null)
  assert.equal(read.upgradeable, null)
  const safe = fakeCtx({ call: chainState(code, { '0x0': word(IMPL) }), fetch: sourcify404 })
  const s = await readEvm('ethereum', ADDR, safe.ctx)
  assert.deepEqual(s.read.proxy, { standard: 'other', implementation: IMPL })
  assert.equal(s.read.rpcCalls, 2)
})

await test('skipSourcify: a known codeHash skips the registry request', async () => {
  const f = fakeCtx({ call: chainState(WETH9_CODE), fetch: () => WETH9_SOURCIFY })
  const known = evmCodeHash(buf(WETH9_CODE))
  const { read } = await readEvm('ethereum', ADDR, f.ctx, { skipSourcify: (h) => h === known })
  assert.equal(f.urls.length, 0)
  assert.equal(read.verified, null)
  assert.ok(read.notes.some((n) => n.includes('Sourcify not asked')))
})

// ─── ABI and sources ─────────────────────────────────────────────────────────

await test('ABI signatures: tuples, tuple arrays, events; non-entries skipped', () => {
  const abi = [
    { type: 'constructor', inputs: [] },
    {
      type: 'function',
      name: 'supply',
      inputs: [
        { type: 'address' },
        { type: 'tuple[]', components: [{ type: 'uint256' }, { type: 'tuple', components: [{ type: 'bytes32' }, { type: 'bool' }] }] },
      ],
    },
    { type: 'event', name: 'Supplied', inputs: [{ type: 'address', indexed: true }, { type: 'uint256' }] },
    { type: 'error', name: 'Nope', inputs: [] },
    { type: 'function', name: 'supply', inputs: [{ type: 'address' }, { type: 'tuple[]', components: [{ type: 'uint256' }, { type: 'tuple', components: [{ type: 'bytes32' }, { type: 'bool' }] }] }] },
    null,
  ]
  assert.deepEqual(abiSignatures(abi), { functions: ['supply(address,(uint256,(bytes32,bool))[])'], events: ['Supplied(address,uint256)'] })
  assert.equal(abiSignatures({}), null)
})

await test('bundle hash: comments, whitespace and pragma do not matter; code, strings and paths do', () => {
  const a = `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\n/* vault */\ncontract V {\n  string s = "http://x // y /* z */";\n  function f(uint a) external pure returns (uint) { return a + 1; }\n}\n`
  const b = `pragma solidity 0.8.24;\ncontract V{string s="http://x // y /* z */";\n\n function f( uint a ) external pure returns(uint){\n return a+1; // inc\n }}`
  const c = a.replace('a + 1', 'a + 2')
  const d = a.replace('// y', '// q')
  assert.equal(sourceBundleHash([{ path: 'V.sol', text: a }]), sourceBundleHash([{ path: 'V.sol', text: b }]))
  assert.notEqual(sourceBundleHash([{ path: 'V.sol', text: a }]), sourceBundleHash([{ path: 'V.sol', text: c }]))
  assert.notEqual(sourceBundleHash([{ path: 'V.sol', text: a }]), sourceBundleHash([{ path: 'V.sol', text: d }]), 'string contents are code')
  assert.notEqual(sourceBundleHash([{ path: 'V.sol', text: a }]), sourceBundleHash([{ path: 'src/V.sol', text: a }]))
  // order of files does not matter
  const x = { path: 'A.sol', text: 'contract A {}' }
  const y = { path: 'B.sol', text: 'contract B {}' }
  assert.equal(sourceBundleHash([x, y]), sourceBundleHash([y, x]))
  assert.equal(sourceBundleHash([]), null)
  // two contracts compiled from one flattened file are different code
  assert.notEqual(sourceBundleHash([x, y], 'A.sol:A'), sourceBundleHash([x, y], 'B.sol:B'))
  assert.equal(sourceBundleHash([x, y], 'A.sol:A'), sourceBundleHash([y, x], 'A.sol:A'))
  assert.ok(normalizeSource(a, 'solidity').includes('"http://x // y /* z */"'))
  assert.ok(normalizeSource(a, 'solidity').includes('uint a'))
  // Vyper: comments go, indentation stays
  assert.equal(normalizeSource('# @version 0.3.10\n@external\ndef f():  # c\n    pass\n\n', 'vyper'), '@external\ndef f():\n    pass')
  // line mode keeps line count and empties strings
  assert.equal(stripSolidity('a /* x\ny */ b "{" // c\nd', 'lines'), 'a \n b "" \nd')
})

const lines = (n: number, prefix = 'x') => Array.from({ length: n }, (_, i) => `    uint256 ${prefix}${i} = ${i};`).join('\n')
const ERC20_FNS = ['name()', 'symbol()', 'decimals()', 'totalSupply()', 'balanceOf(address)', 'transfer(address,uint256)', 'transferFrom(address,address,uint256)', 'approve(address,uint256)', 'allowance(address,address)']
const OZ_ERC20 = { path: '@openzeppelin/contracts/token/ERC20/ERC20.sol', text: `pragma solidity ^0.8.20;\nabstract contract ERC20 {\n${lines(300)}\n}\n` }

await test('profile: token on an OpenZeppelin template → boilerplate', () => {
  const p = profileEvmSources(
    [OZ_ERC20, { path: 'contracts/PepeMoon.sol', text: 'pragma solidity ^0.8.20;\nimport "@openzeppelin/contracts/token/ERC20/ERC20.sol";\ncontract PepeMoon is ERC20 {\n  constructor() ERC20("PepeMoon", "PM") {\n    _mint(msg.sender, 1e27);\n  }\n}\n' }],
    { abiFunctions: ERC20_FNS, name: 'PepeMoon' },
  )
  assert.equal(p.token, 'erc20')
  assert.equal(p.tokenBase, true)
  assert.equal(p.libraryFiles, 1)
  assert.ok(p.customLines < 10, String(p.customLines))
  assert.match(p.boilerplate ?? '', /^ERC-20 token on a library template/)
})

await test('profile: flattened launch/tax token → boilerplate', () => {
  const flat = `pragma solidity 0.8.23;
abstract contract Context { function _msgSender() internal view virtual returns (address) { return msg.sender; } }
interface IERC20 {\n  function totalSupply() external view returns (uint256);\n  function transfer(address, uint256) external returns (bool);\n}
library SafeMath {\n${lines(40, 's')}\n}
contract Ownable is Context {\n${lines(30, 'o')}\n}
interface IUniswapV2Router02 {\n  function WETH() external pure returns (address);\n}
contract MOONCAT is Context, IERC20, Ownable {\n${lines(180, 'm')}\n  function openTrading() external onlyOwner {}\n  function removeLimits() external onlyOwner {}\n  function manualSwap() external {}\n}`
  const p = profileEvmSources([{ path: 'MOONCAT.sol', text: flat }], {
    abiFunctions: [...ERC20_FNS, 'openTrading()', 'removeLimits()', 'manualSwap()', 'owner()'],
    name: 'MOONCAT',
  })
  assert.ok(p.customLines > 150, String(p.customLines))
  assert.ok(p.libraryLines >= 70, String(p.libraryLines))
  assert.ok(p.interfaceLines >= 5)
  assert.deepEqual(p.tradingControls, ['openTrading', 'removeLimits', 'manualSwap'])
  assert.match(p.boilerplate ?? '', /launch\/tax controls/)
})

await test('profile: protocol code is not boilerplate; vault fee setters are not trading controls', () => {
  const p = profileEvmSources(
    [OZ_ERC20, { path: 'src/Vault.sol', text: `pragma solidity ^0.8.20;\nimport "@openzeppelin/contracts/token/ERC20/ERC20.sol";\ncontract Vault is ERC20 {\n${lines(420)}\n}\n` }],
    { abiFunctions: [...ERC20_FNS, 'setManagementFee(uint256)', 'setPerformanceFee(uint256)', 'deposit(uint256,address)'], name: 'Vault' },
  )
  assert.deepEqual(p.tradingControls, [])
  assert.equal(p.boilerplate, null)
  const amm = profileEvmSources([{ path: 'contracts/Pool.sol', text: `contract Pool {\n${lines(90)}\n}` }], { abiFunctions: ['swap(uint256,uint256,address,bytes)'], name: 'Pool' })
  assert.equal(amm.boilerplate, null)
})

await test('profile: library only, sample contracts, thin proxies, tiny contracts', () => {
  assert.equal(profileEvmSources([OZ_ERC20], {}).boilerplate, 'library code only, no custom implementation')
  assert.match(profileEvmSources([{ path: 'contracts/1_Storage.sol', text: `contract Storage {\n${lines(8)}\n}` }], { name: 'Storage' }).boilerplate ?? '', /^sample contract/)
  assert.match(
    profileEvmSources([{ path: 'P.sol', text: `contract Proxy {\n${lines(60)}\n}\ncontract MyProxy is Proxy {\n${lines(20)}\n}` }], { proxy: true, name: 'MyProxy' }).boilerplate ?? '',
    /^proxy contract, 2\d custom lines/,
  )
  assert.match(profileEvmSources([{ path: 'T.sol', text: 'contract T {\n  uint x;\n}' }], { name: 'T' }).boilerplate ?? '', /^trivial contract/)
  assert.match(profileEvmSources([OZ_ERC20, { path: 'X.sol', text: `contract X is Ownable {\n${lines(30)}\n}` }], { name: 'X' }).boilerplate ?? '', /^library code plus/)
  assert.equal(profileEvmSources([], {}).boilerplate, null)
})

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
