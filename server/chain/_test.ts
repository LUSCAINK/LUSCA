// Chain agents core tests: the network layer against a local mock HTTP server, the store (persistence,
// cap, crash recovery, duplicate and boilerplate verdicts) and the agent loop with stubs. No internet.
//   npx tsx server/chain/_test.ts
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ChainEvent, ChainId, ChainRead } from '../../shared/chain.ts'
import { BudgetError, RpcError, createRpc, redact, type RpcCtx } from './rpc.ts'
import { classifyEvmSources, createChainStore, evaluateRead, readJson, stripComments, type SeenLookup } from './store.ts'
import { createChainAgentsWith, endpointOfFailure, type ChainCandidate, type DiscoveryLike, type ReadEvmFn, type ReadSolanaFn } from './agents.ts'
import { normalizeSource, profileEvmSources, stripVyper } from './evm-source.ts'
import { PLAIN_OZ_TOKEN, PROTOCOL_TOKENS } from './_token.fixtures.ts'

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

const tmp = mkdtempSync(join(tmpdir(), 'lusca-chain-'))
let dirN = 0
const freshDir = () => {
  const d = join(tmp, `d${dirN++}`)
  mkdirSync(d, { recursive: true })
  return d
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const quiet = () => {}

// ─── mock HTTP server ────────────────────────────────────────────────────────

let concurrent = 0
let maxConcurrent = 0
const httpHits: number[] = []
let httpActive = 0
let httpMaxActive = 0

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (req.method === 'GET') {
    httpHits.push(Date.now())
    httpActive++
    httpMaxActive = Math.max(httpMaxActive, httpActive)
    setTimeout(() => {
      httpActive--
      if (url.pathname === '/sourcify/ok') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, n: httpHits.length }))
      } else if (url.pathname === '/sourcify/404') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ customCode: 'not_found', message: 'Contract not found' }))
      } else if (url.pathname === '/sourcify/big') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ blob: 'x'.repeat(200_000) }))
      } else {
        res.writeHead(500)
        res.end('nope')
      }
    }, 20)
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let j: { id: number; method: string; params: unknown[] }
    try {
      j = JSON.parse(body)
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const reply = (result: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }))
    }
    switch (j.method) {
      case 'echo':
        return reply({ method: j.method, params: j.params, path: url.pathname, key: url.searchParams.get('api-key') })
      case 'big':
        return reply('y'.repeat(2 * 1048576))
      case 'bigchunked': {
        res.writeHead(200, { 'content-type': 'application/json' }) // chunked, no content-length
        res.write(`{"jsonrpc":"2.0","id":${j.id},"result":"`)
        let n = 0
        const iv = setInterval(() => {
          if (n++ > 40 || res.destroyed) {
            clearInterval(iv)
            if (!res.destroyed) res.end('"}')
            return
          }
          res.write('z'.repeat(32 * 1024))
        }, 2)
        res.on('close', () => clearInterval(iv))
        return
      }
      case 'slow':
        setTimeout(() => !res.destroyed && reply('late'), 1500)
        return
      case 'err':
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32000, message: `upstream failed for ${String((j.params as string[])[0])}` } }))
        return
      case 'limited':
        res.writeHead(429)
        res.end('slow down')
        return
      case 'conc':
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        setTimeout(() => {
          concurrent--
          reply('ok')
        }, 60)
        return
      default:
        return reply(null)
    }
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const PORT = (server.address() as AddressInfo).port
const BASE = `http://127.0.0.1:${PORT}`
const SECRET = 'SUPERSECRETKEY1234567'
const KEYED = `${BASE}/rpc?api-key=${SECRET}`

// ─── rpc ─────────────────────────────────────────────────────────────────────

await test('rpc: JSON-RPC POST with id, per-chain endpoints, solana reads vs discovery endpoints', async () => {
  const rpc = createRpc({ solanaRpc: KEYED, solanaDiscoveryRpc: `${BASE}/disc`, evmRpcs: { ethereum: `${BASE}/eth`, base: `${BASE}/base`, arbitrum: `${BASE}/arb` }, minGapMs: 0 })
  const a = (await rpc.call('solana', 'echo', [1, 'x'])) as { method: string; params: unknown[]; path: string; key: string }
  assert.equal(a.method, 'echo')
  assert.deepEqual(a.params, [1, 'x'])
  assert.equal(a.path, '/rpc')
  assert.equal(a.key, SECRET)
  const b = (await rpc.call('solana', 'echo', [], { discovery: true })) as { path: string }
  assert.equal(b.path, '/disc')
  assert.equal(((await rpc.call('base', 'echo', [])) as { path: string }).path, '/base')
  assert.equal(((await rpc.call('arbitrum', 'echo', [], { discovery: true })) as { path: string }).path, '/arb')
  const u = rpc.usage()
  assert.equal(u.solana.used, 1)
  assert.equal(u['solana-discovery'].used, 1)
  assert.equal(u.base.used, 1)
  assert.equal(u.arbitrum.used, 1, 'EVM discovery shares the chain budget')
  await rpc.close()
})

await test('rpc: daily budgets, BudgetError without sending, UTC reset, persisted usage', async () => {
  const dataDir = freshDir()
  let t = Date.UTC(2026, 9, 5, 23, 59, 0)
  const rpc = createRpc({ evmRpcs: { ethereum: `${BASE}/eth` }, limits: { ethereum: 3, sourcify: 1 }, minGapMs: 0, dataDir, now: () => t })
  for (let i = 0; i < 3; i++) await rpc.call('ethereum', 'echo', [])
  assert.equal(rpc.canSpend('ethereum'), false)
  assert.equal(rpc.canSpend('base'), true)
  await assert.rejects(rpc.call('ethereum', 'echo', []), (e: unknown) => e instanceof BudgetError && e.key === 'ethereum')
  assert.deepEqual(rpc.usage().ethereum, { used: 3, limit: 3 })
  assert.equal(rpc.remaining('ethereum'), 0)
  assert.equal(rpc.msUntilReset(), 60_000)
  await rpc.close()
  assert.ok(existsSync(join(dataDir, 'chain', 'budget.json')))
  // same UTC day: usage carries over a restart
  const rpc2 = createRpc({ evmRpcs: { ethereum: `${BASE}/eth` }, limits: { ethereum: 3 }, minGapMs: 0, dataDir, now: () => t })
  assert.equal(rpc2.usage().ethereum.used, 3)
  assert.equal(rpc2.canSpend('ethereum', 1), false)
  // 00:00 UTC: reset
  t += 61_000
  assert.equal(rpc2.canSpend('ethereum', 3), true)
  assert.equal(rpc2.usage().ethereum.used, 0)
  await rpc2.call('ethereum', 'echo', [])
  assert.equal(rpc2.usage().ethereum.used, 1)
  await rpc2.close()
  // a stale day in budget.json is ignored
  const rpc3 = createRpc({ evmRpcs: { ethereum: `${BASE}/eth` }, dataDir, now: () => t + 86_400_000 })
  assert.equal(rpc3.usage().ethereum.used, 0)
  await rpc3.close()
})

await test('rpc: URLs and keys never appear in errors', async () => {
  const rpc = createRpc({ solanaRpc: KEYED, evmRpcs: { base: `http://127.0.0.1:1/x?api-key=${SECRET}` }, minGapMs: 0, timeoutMs: 3000 })
  // the upstream echoes the URL back in its error message
  const e1 = await rpc.call('solana', 'err', [KEYED]).catch((e) => e)
  assert.ok(e1 instanceof RpcError)
  assert.equal(e1.kind, 'rpc')
  assert.equal(e1.code, -32000)
  assert.ok(!e1.message.includes(SECRET), e1.message)
  assert.ok(!e1.message.includes(`127.0.0.1:${PORT}`), e1.message)
  assert.match(e1.message, /^solana rpc err:/)
  // connection refused
  const e2 = await rpc.call('base', 'echo', []).catch((e) => e)
  assert.ok(e2 instanceof RpcError)
  assert.equal(e2.kind, 'network')
  assert.equal(e2.transient, true)
  assert.ok(!e2.message.includes(SECRET) && !e2.message.includes('127.0.0.1'), e2.message)
  assert.ok(!String(e2.stack).includes(SECRET))
  // redact() for any message
  assert.ok(!redact(`failed: ${KEYED} and https://mainnet.helius-rpc.com/?api-key=abcdef123456`).includes('api-key=abcdef'))
  assert.ok(!redact(`x ${SECRET} y`).includes(SECRET))
  await rpc.close()
})

await test('rpc: response size caps abort the request (content-length and chunked)', async () => {
  const rpc = createRpc({ evmRpcs: { ethereum: `${BASE}/eth` }, minGapMs: 0 })
  const e1 = await rpc.call('ethereum', 'big', [], { maxBytes: 64 * 1024 }).catch((e) => e)
  assert.ok(e1 instanceof RpcError && e1.kind === 'too-large', String(e1))
  const e2 = await rpc.call('ethereum', 'bigchunked', [], { maxBytes: 100 * 1024 }).catch((e) => e)
  assert.ok(e2 instanceof RpcError && e2.kind === 'too-large', String(e2))
  // under the cap is fine
  const ok = (await rpc.call('ethereum', 'big', [], { maxBytes: 3 * 1048576 })) as string
  assert.equal(ok.length, 2 * 1048576)
  await rpc.close()
})

await test('rpc: timeouts are transient errors', async () => {
  const rpc = createRpc({ evmRpcs: { ethereum: `${BASE}/eth` }, minGapMs: 0 })
  const t0 = Date.now()
  const e = await rpc.call('ethereum', 'slow', [], { timeoutMs: 200 }).catch((x) => x)
  assert.ok(e instanceof RpcError && e.kind === 'timeout' && e.transient, String(e))
  assert.ok(Date.now() - t0 < 1200)
  await rpc.close()
})

await test('rpc: at most 2 requests in flight per endpoint', async () => {
  const rpc = createRpc({ evmRpcs: { ethereum: `${BASE}/eth`, base: `${BASE}/base` }, minGapMs: 0 })
  maxConcurrent = 0
  await Promise.all(Array.from({ length: 6 }, () => rpc.call('ethereum', 'conc', [])))
  assert.equal(maxConcurrent, 2)
  await rpc.close()
})

await test('rpc: registries are polite (1 in flight, spaced), host allowlist, 404 body, 429 cooldown', async () => {
  const rpc = createRpc({ httpGapMs: 120, minGapMs: 0, limits: { sourcify: 4 } })
  httpHits.length = 0
  httpMaxActive = 0
  const t0 = Date.now()
  const rs = await Promise.all([1, 2, 3].map(() => rpc.fetchJson(`${BASE}/sourcify/ok`, { host: 'sourcify' })))
  assert.equal(rs.length, 3)
  assert.equal(httpMaxActive, 1)
  assert.ok(Date.now() - t0 >= 230, `3 requests in ${Date.now() - t0} ms`)
  for (let i = 1; i < httpHits.length; i++) assert.ok(httpHits[i] - httpHits[i - 1] >= 100, 'spacing')
  // a host that is neither sourcify nor osec is refused without a request
  await assert.rejects(rpc.fetchJson(`${BASE}/sourcify/ok`), (e: unknown) => e instanceof RpcError && e.kind === 'host')
  const e404 = await rpc.fetchJson(`${BASE}/sourcify/404`, { host: 'sourcify' }).catch((e) => e)
  assert.ok(e404 instanceof RpcError && e404.status === 404 && !e404.transient)
  assert.deepEqual(e404.body, { customCode: 'not_found', message: 'Contract not found' })
  assert.ok(!e404.message.includes('127.0.0.1'))
  // budget of 4 used
  await assert.rejects(rpc.fetchJson(`${BASE}/sourcify/ok`, { host: 'sourcify' }), (e: unknown) => e instanceof BudgetError && e.key === 'sourcify')
  const big = await rpc.fetchJson(`${BASE}/sourcify/big`, { host: 'osec', maxBytes: 10_000 }).catch((e) => e)
  assert.ok(big instanceof RpcError && big.kind === 'too-large')
  await rpc.close()
  // 429 → transient, then a cool-down before the next request on that endpoint
  const rpc2 = createRpc({ evmRpcs: { ethereum: `${BASE}/eth` }, minGapMs: 0 })
  const e429 = await rpc2.call('ethereum', 'limited', []).catch((e) => e)
  assert.ok(e429 instanceof RpcError && e429.status === 429 && e429.transient)
  const t1 = Date.now()
  await rpc2.call('ethereum', 'echo', [])
  assert.ok(Date.now() - t1 >= 1500, 'cool-down after 429')
  await rpc2.close()
  // close() aborts waits
  const rpc3 = createRpc({ evmRpcs: { ethereum: `${BASE}/eth` }, minGapMs: 0 })
  const pending = rpc3.call('ethereum', 'slow', [], { timeoutMs: 5000 }).catch((e) => e)
  await wait(50)
  await rpc3.close()
  const ce = await pending
  assert.ok(ce instanceof RpcError && ce.kind === 'closed', String(ce))
})

// ─── fixtures for store / agents ─────────────────────────────────────────────

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
    rpcCalls: 2,
    ...o,
  }
}

const OZ_ERC20 = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {IERC20} from "./IERC20.sol";
abstract contract ERC20 is IERC20 {
${Array.from({ length: 180 }, (_, i) => `    function f${i}() internal pure returns (uint256) { return ${i}; }`).join('\n')}
}
`
const OZ_OWNABLE = `pragma solidity ^0.8.20;\nabstract contract Ownable {\n${Array.from({ length: 60 }, (_, i) => `    uint256 internal o${i};`).join('\n')}\n}\n`

const tokenTemplate = [
  { path: '@openzeppelin/contracts/token/ERC20/ERC20.sol', text: OZ_ERC20 },
  { path: '@openzeppelin/contracts/access/Ownable.sol', text: OZ_OWNABLE },
  {
    path: 'contracts/PepeMoon.sol',
    text: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
/* a token */
contract PepeMoon is ERC20, Ownable {
    constructor() ERC20("PepeMoon", "PMOON") Ownable(msg.sender) {
        _mint(msg.sender, 420_690_000_000 * 10 ** decimals()); // "https://pepe.moon"
    }
}
`,
  },
]

function flattenedTaxToken(): { path: string; text: string }[] {
  const lib = (name: string, kind = 'contract', n = 40) => `${kind} ${name} {\n${Array.from({ length: n }, (_, i) => `    uint256 internal ${name.toLowerCase()}${i};`).join('\n')}\n}\n`
  const custom = Array.from({ length: 220 }, (_, i) => `        if (amount > ${i}) { fee = amount * ${i % 9} / 100; }`).join('\n')
  return [
    {
      path: 'contracts/ShibaElonInu.sol',
      text: `pragma solidity ^0.8.4;
${lib('Context', 'abstract contract')}
${lib('IERC20', 'interface', 20).replace(/uint256 internal \w+;/g, 'function x() external;')}
${lib('Ownable')}
${lib('SafeMath', 'library')}
${lib('IUniswapV2Router02', 'interface', 20).replace(/uint256 internal \w+;/g, 'function y() external;')}
contract ShibaElonInu is Context, IERC20, Ownable {
    using SafeMath for uint256;
    address payable private _marketingWallet;
    uint256 private _maxTxAmount = 1e9;
    function balanceOf(address a) public view returns (uint256) { return 0; }
    function transfer(address to, uint256 amount) public returns (bool) {
        uint256 fee;
${custom}
        return true;
    }
    function swapTokensForEth(uint256 tokenAmount) private {
        uniswapV2Router.swapExactTokensForETHSupportingFeeOnTransferTokens(tokenAmount, 0, path, address(this), block.timestamp);
    }
}
`,
    },
  ]
}

function vaultProtocol(): { path: string; text: string }[] {
  const body = Array.from(
    { length: 160 },
    (_, i) => `    function action${i}(uint256 assets) external nonReentrant returns (uint256 shares) { shares = assets * totalShares / (totalAssets + ${i + 1}); }`,
  ).join('\n')
  return [
    { path: '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol', text: `library SafeERC20 {\n${'    function a() internal {}\n'.repeat(80)}}` },
    { path: '@openzeppelin/contracts/utils/ReentrancyGuard.sol', text: `abstract contract ReentrancyGuard {\n${'    uint256 private s;\n'.repeat(40)}}` },
    {
      path: 'src/LendingVault.sol',
      text: `pragma solidity 0.8.24;\nimport {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";\ncontract LendingVault is ReentrancyGuard {\n    uint256 public totalShares;\n    uint256 public totalAssets;\n${body}\n}\n`,
    },
  ]
}

// ─── classifier ──────────────────────────────────────────────────────────────

await test('boilerplate: comments stripped, strings kept', () => {
  const s = stripComments(`a = "http://x.y"; // note\n/* block\n comment */ b = 'it''s'; # not a comment in solidity`)
  assert.ok(s.includes('"http://x.y"'))
  assert.ok(!s.includes('note'))
  assert.ok(!s.includes('block'))
  assert.equal(s.split('\n').length, 3, 'line breaks of comments are kept')
  assert.ok(!stripComments('x = 1 # vyper comment\n', true).includes('vyper'))
})

await test('boilerplate: OpenZeppelin ERC-20 template with a constructor is boilerplate', () => {
  const r = classifyEvmSources(tokenTemplate, 'PepeMoon')
  assert.equal(r.boilerplate, true, r.reason)
  assert.equal(r.libraryFiles, 2)
  assert.ok(r.customLines < 10, `${r.customLines}`)
  assert.ok(r.tokenLike)
  assert.match(r.reason, /library code \(2 files\) \+ \d+ custom lines/)
})

await test('boilerplate: flattened fee-on-transfer token with pasted libraries is boilerplate', () => {
  const r = classifyEvmSources(flattenedTaxToken(), 'ShibaElonInu')
  assert.equal(r.boilerplate, true, r.reason)
  assert.ok(r.libraryLines > 100, `library lines ${r.libraryLines}`)
  assert.ok(r.customLines > 150 && r.customLines < 800, `${r.customLines}`)
  assert.match(r.reason, /fee-on-transfer token template/)
})

await test('boilerplate: protocol code on top of library helpers is kept', () => {
  const r = classifyEvmSources(vaultProtocol(), 'LendingVault')
  assert.equal(r.boilerplate, false, r.reason)
  assert.equal(r.tokenLike, false)
  assert.ok(r.customLines >= 160)
})

await test('boilerplate: proxy (library only), NFT drop, tiny token; small standalone code is not boilerplate', () => {
  const proxy = classifyEvmSources([
    { path: '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol', text: 'contract ERC1967Proxy is Proxy {\n  constructor() {}\n}\n' },
    { path: '@openzeppelin/contracts/proxy/Proxy.sol', text: 'abstract contract Proxy {\n  fallback() external payable {}\n}\n' },
  ])
  assert.equal(proxy.boilerplate, true)
  assert.match(proxy.reason, /only, no custom code/)

  const mintLines = Array.from({ length: 150 }, (_, i) => `    uint256 public tier${i} = ${i};`).join('\n')
  const nft = classifyEvmSources([
    { path: 'erc721a/contracts/ERC721A.sol', text: `contract ERC721A {\n${'    uint256 x;\n'.repeat(300)}}` },
    {
      path: 'contracts/CoolApes.sol',
      text: `contract CoolApes is ERC721A, Ownable {\n    uint256 public constant MAX_SUPPLY = 10000;\n    string private baseURI;\n${mintLines}\n    function publicMint(uint256 n) external payable { _mint(msg.sender, n); }\n}\n`,
    },
  ])
  assert.equal(nft.boilerplate, true, nft.reason)
  assert.ok(nft.nftLike)
  assert.match(nft.reason, /NFT collection template/)

  const vy = classifyEvmSources([{ path: 'Token.vy', text: '# @version 0.3.10\n@external\ndef transfer(to: address, v: uint256) -> bool:\n    self.balanceOf[to] += v\n    return True\n' }])
  assert.equal(vy.boilerplate, true, vy.reason)

  const lines = Array.from({ length: 40 }, (_, i) => `    function step${i}(bytes32 h) external { roots[h] = ${i}; }`).join('\n')
  const tiny = classifyEvmSources([{ path: 'src/Registry.sol', text: `pragma solidity 0.8.24;\ncontract Registry {\n    mapping(bytes32 => uint256) public roots;\n${lines}\n}\n` }])
  assert.equal(tiny.boilerplate, false, tiny.reason)
})

await test('boilerplate: hand-written ERC-20 (public mappings) is a template; a WETH-style wrapper is not', () => {
  const launch = `pragma solidity ^0.8.26;
contract LaunchToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    constructor(string memory n, string memory s, uint256 supply) { name = n; symbol = s; totalSupply = supply; balanceOf[msg.sender] = supply; }
    function approve(address spender, uint256 value) external returns (bool) { allowance[msg.sender][spender] = value; return true; }
    function transfer(address to, uint256 value) external returns (bool) { _transfer(msg.sender, to, value); return true; }
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        allowance[from][msg.sender] -= value;
        _transfer(from, to, value);
        return true;
    }
    function _transfer(address from, address to, uint256 value) private { balanceOf[from] -= value; balanceOf[to] += value; emit Transfer(from, to, value); }
}
`
  const r = classifyEvmSources([{ path: 'project/compiled/LaunchToken.sol', text: launch }], 'LaunchToken')
  assert.equal(r.boilerplate, true, r.reason)
  assert.equal(r.tokenLike, true)
  // same code under another name, token detected from the ABI alone
  const abi = ['transfer(address,uint256)', 'balanceOf(address)', 'approve(address,uint256)']
  const plain = launch.replace(/balanceOf|allowance|approve/g, (m) => `${m}X`)
  assert.equal(classifyEvmSources([{ path: 'A.sol', text: plain }], 'Thing', abi).tokenLike, true)
  // name rule
  assert.equal(classifyEvmSources([{ path: 'A.sol', text: `contract MoonCoin {\n${'    uint256 public a;\n'.repeat(30)}}` }], 'MoonCoin').boilerplate, true)
  const weth = `contract WETH9 {
    mapping (address => uint) public balanceOf;
    mapping (address => mapping (address => uint)) public allowance;
    function deposit() public payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint wad) public { balanceOf[msg.sender] -= wad; payable(msg.sender).transfer(wad); }
    function approve(address guy, uint wad) public returns (bool) { allowance[msg.sender][guy] = wad; return true; }
    function transfer(address dst, uint wad) public returns (bool) { return transferFrom(msg.sender, dst, wad); }
    function transferFrom(address src, address dst, uint wad) public returns (bool) {
        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        return true;
    }
    function totalSupply() public view returns (uint) { return address(this).balance; }
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
    uint8 public decimals = 18;
}
`
  const w = classifyEvmSources([{ path: 'WETH9.sol', text: weth }], 'WETH9')
  assert.equal(w.boilerplate, false, w.reason)
  // old ZeppelinOS proxy names count as library code
  const zos = classifyEvmSources([
    { path: 'FiatTokenProxy.sol', text: `contract UpgradeabilityProxy {\n${'  uint256 a;\n'.repeat(40)}}\ncontract AdminUpgradeabilityProxy is UpgradeabilityProxy {\n${'  uint256 b;\n'.repeat(40)}}\ncontract FiatTokenProxy is AdminUpgradeabilityProxy {\n  constructor(address i) AdminUpgradeabilityProxy(i) {}\n}\n` },
  ])
  assert.equal(zos.boilerplate, true, zos.reason)
  // trivial and sample contracts
  assert.equal(classifyEvmSources([{ path: 'S.sol', text: 'contract Storage {\n uint256 n;\n function store(uint256 x) public { n = x; }\n function retrieve() public view returns (uint256) { return n; }\n}\n' }], 'Storage').boilerplate, true)
})

await test('boilerplate: padded sources classify in linear time (no regex backtracking over blank lines / spaces)', () => {
  const t0 = Date.now()
  const blank = '\n'.repeat(200_000)
  const sol = `pragma solidity ^0.8.20;\nerror Nope();\n${blank}contract Vault {\n${'    uint256 public a;\n'.repeat(80)}}\n`
  const b = classifyEvmSources([{ path: 'src/Vault.sol', text: sol }], 'Vault')
  assert.equal(b.customLines, 83, String(b.customLines))
  const vy = `# @version 0.3.10\n${'\n'.repeat(80_000)}@external\ndef f():\n    pass\n`
  classifyEvmSources([{ path: 'V.vy', text: vy }], 'V')
  const spaces = `@external\ndef f():${' '.repeat(80_000)}x\n    pass${' '.repeat(80_000)}\n`
  stripVyper(spaces)
  normalizeSource(spaces, 'vyper')
  normalizeSource(`${'pragma solidity '.repeat(20_000)}`, 'solidity')
  classifyEvmSources([{ path: 'S.sol', text: `contract S {\n string s = "${'function deposit() '.repeat(20_000)}";\n string t = "function ${'mint'.repeat(20_000)} x";\n}\n` }], 'S')
  profileEvmSources([{ path: 'src/Vault.sol', text: sol }, { path: 'V.vy', text: vy }], { name: 'Vault' })
  const ms = Date.now() - t0
  assert.ok(ms < 1500, `${ms} ms`)
})

// ─── evaluation ──────────────────────────────────────────────────────────────

const noneSeen: SeenLookup = { code: () => null, bundle: () => null }
const SOURCIFY = { by: 'sourcify' as const, match: 'full' as const, repo: null, commit: null, compiler: 'solc 0.8.24' }
const IDL = { name: 'amm', version: '0.1.0', instructions: [{ name: 'swap', args: 2, accounts: 7 }], accounts: ['Pool'], types: 3, errors: 4, events: 1 }
const EVM_A = '0x1111111111111111111111111111111111111111'
const EVM_B = '0x2222222222222222222222222222222222222222'
const SOL_A = 'Prog1111111111111111111111111111111111111A'
const SOL_B = 'Prog2222222222222222222222222222222222222B'

await test('evaluate: kinds, unverified, duplicates, boilerplate, kept reasons', () => {
  assert.equal(evaluateRead(mkRead('solana', SOL_A, { kind: 'token-mint' }), {}, noneSeen).verdict, 'token-mint')
  assert.equal(evaluateRead(mkRead('solana', SOL_A, { kind: 'account' }), {}, noneSeen).verdict, 'not-code')
  assert.equal(evaluateRead(mkRead('ethereum', EVM_A, { kind: 'empty' }), {}, noneSeen).verdict, 'not-code')
  const u = evaluateRead(mkRead('ethereum', EVM_A, { codeHash: 'aa' }), {}, noneSeen)
  assert.deepEqual([u.verdict, u.reason], ['unverified', 'no verified source on Sourcify'])
  assert.equal(evaluateRead(mkRead('solana', SOL_A, { codeHash: 'bb' }), {}, noneSeen).verdict, 'unverified')
  const osec = evaluateRead(mkRead('solana', SOL_A, { notes: ['OtterSec status unavailable: timed out'] }), {}, noneSeen)
  assert.equal(osec.verdict, 'error')
  assert.equal(osec.retry, true)
  const clone = evaluateRead(mkRead('base', EVM_A, { proxy: { standard: 'eip1167', implementation: EVM_B } }), {}, noneSeen)
  assert.equal(clone.verdict, 'boilerplate')
  assert.match(clone.reason, /implementation queued/)

  const kept = evaluateRead(
    mkRead('ethereum', EVM_A, { codeHash: 'cc', verified: SOURCIFY, sources: vaultProtocol().map((f) => ({ path: f.path, lang: 'solidity', bytes: f.text.length })) }),
    { sources: vaultProtocol(), sourceBundleHash: 'b1' },
    noneSeen,
  )
  assert.equal(kept.verdict, 'kept', kept.reason)
  assert.match(kept.reason, /^Sourcify full match · 3 source files · \d+ KB$/)
  assert.ok(!/safe|audit/i.test(kept.reason))

  const idl = evaluateRead(mkRead('solana', SOL_A, { codeHash: 'dd', idl: IDL }), { idlJson: { name: 'amm' } }, noneSeen)
  assert.deepEqual([idl.verdict, idl.reason], ['kept', 'on-chain IDL · 1 instruction'])
  const osecKept = evaluateRead(mkRead('solana', SOL_A, { codeHash: 'ee', verified: { by: 'osec', match: 'full', repo: 'https://github.com/o/r', commit: 'abc', compiler: null } }), {}, noneSeen)
  assert.equal(osecKept.verdict, 'kept')
  assert.match(osecKept.reason, /OtterSec verified build/)

  const seen: SeenLookup = { code: (h) => (h === 'cc' ? EVM_B : null), bundle: (h) => (h === 'b1' ? EVM_B : null) }
  const d1 = evaluateRead(mkRead('ethereum', EVM_A, { codeHash: 'cc' }), {}, seen)
  assert.equal(d1.verdict, 'duplicate', 'same code hash, even when the registry was not asked')
  assert.match(d1.reason, /same bytecode as 0x2222…2222/)
  const d2 = evaluateRead(mkRead('ethereum', EVM_A, { codeHash: 'zz', verified: SOURCIFY }), { sources: vaultProtocol(), sourceBundleHash: 'b1' }, seen)
  assert.equal(d2.verdict, 'duplicate')
  assert.match(d2.reason, /same verified sources/)
  const self = evaluateRead(mkRead('ethereum', EVM_B.toUpperCase().replace('0X', '0x'), { codeHash: 'cc' }), {}, seen)
  assert.equal(self.reason, 'already kept, code unchanged')

  const bp = evaluateRead(mkRead('base', EVM_A, { codeHash: 'ff', verified: SOURCIFY }), { sources: tokenTemplate }, noneSeen)
  assert.equal(bp.verdict, 'boilerplate')
  const reader = evaluateRead(mkRead('base', EVM_A, { codeHash: 'ff', verified: SOURCIFY }), { sources: vaultProtocol(), boilerplate: 'sample contract (Lock), 20 custom lines' }, noneSeen)
  assert.deepEqual([reader.verdict, reader.reason], ['boilerplate', 'sample contract (Lock), 20 custom lines'])
  // a large codebase is not rejected on the reader's admin-function heuristics (blacklist() in a stablecoin)
  const big = [{ path: 'src/Stable.sol', text: `contract Stable {\n${Array.from({ length: 900 }, (_, i) => `    function op${i}() external {}`).join('\n')}\n}\n` }]
  const large = evaluateRead(mkRead('arbitrum', EVM_A, { codeHash: 'gg', verified: SOURCIFY }), { sources: big, boilerplate: 'ERC-20 token with launch/tax controls (blacklist, unBlacklist)' }, noneSeen)
  assert.equal(large.verdict, 'kept', large.reason)
})

await test('boilerplate: token-shaped protocol code (sUSDe, rETH, sfrxETH, Dai, USDT) is kept; a template-only token is not', () => {
  for (const f of PROTOCOL_TOKENS) {
    const b = classifyEvmSources(f.sources, f.name, f.abi)
    assert.equal(b.boilerplate, false, `${f.name}: ${b.reason}`)
    assert.ok(b.tokenLike || f.name === 'sfrxETH' || f.name === 'StakedUSDeV2' || f.name === 'RocketTokenRETH', f.name)
    const p = profileEvmSources(f.sources, { abiFunctions: f.abi, name: f.name })
    assert.equal(p.boilerplate, null, `${f.name} (reader profile): ${p.boilerplate}`)
    const ev = evaluateRead(mkRead('ethereum', EVM_A, { codeHash: f.name, verified: SOURCIFY, name: f.name, abi: { functions: f.abi, events: [] } }), { sources: f.sources, boilerplate: p.boilerplate }, noneSeen)
    assert.equal(ev.verdict, 'kept', `${f.name}: ${ev.reason}`)
  }
  // the same 120 custom lines with nothing beyond token / owner / launch functions: a template
  const t = classifyEvmSources(PLAIN_OZ_TOKEN.sources, PLAIN_OZ_TOKEN.name, PLAIN_OZ_TOKEN.abi)
  assert.equal(t.boilerplate, true, t.reason)
  assert.match(t.reason, /^token template: \d+ custom lines on library code \(2 files\)$/)
  const p = profileEvmSources(PLAIN_OZ_TOKEN.sources, { abiFunctions: PLAIN_OZ_TOKEN.abi, name: PLAIN_OZ_TOKEN.name })
  assert.match(p.boilerplate ?? '', /^ERC-20 token on a library template, \d+ custom lines$/)
  // USDT's pasted ERC20 base is not called a library template
  const usdt = PROTOCOL_TOKENS.find((f) => f.name === 'TetherToken')!
  const fake = profileEvmSources(usdt.sources, { abiFunctions: usdt.abi.filter((x) => /^(name|symbol|decimals|totalSupply|balanceOf|transfer|transferFrom|approve|allowance)\(/.test(x)), name: 'TetherToken' })
  assert.ok(!/library template/.test(fake.boilerplate ?? ''), fake.boilerplate ?? '')
  // one library file: singular
  assert.match(classifyEvmSources([{ path: '@openzeppelin/contracts/proxy/Proxy.sol', text: 'abstract contract Proxy {\n  fallback() external payable {}\n}\n' }]).reason, /library code \(1 file\) only/)
})

await test('evaluate: other-chain duplicates name the chain; clones of rejected bytecode; ABI-only Sourcify match; closed programs', () => {
  // EntryPoint at the same address on Ethereum (kept) and Base: not "already kept"
  const seen: SeenLookup = { code: (h) => (h === 'ep' ? `ethereum:${EVM_A}` : null), bundle: (h) => (h === 'pb' ? `ethereum:${EVM_B}` : null) }
  const x = evaluateRead(mkRead('base', EVM_A, { codeHash: 'ep' }), {}, seen)
  assert.deepEqual([x.verdict, x.reason], ['duplicate', 'same bytecode as ethereum:0x1111…1111'])
  assert.equal(evaluateRead(mkRead('ethereum', EVM_A, { codeHash: 'ep' }), {}, seen).reason, 'already kept, code unchanged')
  const pb = evaluateRead(mkRead('base', EVM_B, { codeHash: 'zz', verified: SOURCIFY }), { sources: vaultProtocol(), sourceBundleHash: 'pb' }, seen)
  assert.equal(pb.reason, 'same verified sources as ethereum:0x2222…2222')
  // bytecode judged boilerplate at another address: same verdict, Sourcify not needed
  const rej: SeenLookup = { ...noneSeen, rejected: (h) => (h === 'oz' ? { verdict: 'boilerplate', reason: 'library code (2 files) only, no custom code', key: `base:${EVM_B}`, at: Date.now() } : null) }
  const c = evaluateRead(mkRead('base', EVM_A, { codeHash: 'oz', proxy: { standard: 'eip1967', implementation: EVM_B } }), {}, rej)
  assert.deepEqual([c.verdict, c.reason], ['boilerplate', 'same bytecode as 0x2222…2222 (boilerplate) · implementation queued'])
  // with verified sources of its own the read is judged on them
  assert.equal(evaluateRead(mkRead('base', EVM_A, { codeHash: 'oz', verified: SOURCIFY }), { sources: vaultProtocol() }, rej).verdict, 'kept')
  // a Sourcify match over the size cap: kept with its ABI, not "unverified"
  const big = evaluateRead(mkRead('ethereum', EVM_A, { codeHash: 'lg', verified: SOURCIFY, notes: ['Sourcify record over 8 MB: ABI kept, source files not stored'], abi: { functions: ['f()'], events: [] } }), {}, noneSeen)
  assert.deepEqual([big.verdict, big.reason], ['kept', 'Sourcify full match · sources over 8 MB, ABI stored'])
  // a closed program keeps its IDL account, not its code
  const closed = evaluateRead(mkRead('solana', SOL_A, { codeHash: null, idl: IDL, notes: ['program closed: its programdata account is gone'] }), { idlJson: { name: 'amm' } }, noneSeen)
  assert.deepEqual([closed.verdict, closed.reason], ['not-code', 'program closed: no executable on-chain'])
})

// ─── store ───────────────────────────────────────────────────────────────────

function keptEvm(addr: string, codeHash: string, bundle: string, extraText = '') {
  const sources = vaultProtocol()
  sources[2] = { ...sources[2], text: sources[2].text + extraText }
  return {
    agent: 'eth-1',
    via: 'registry' as const,
    read: mkRead('ethereum', addr, { codeHash, name: 'LendingVault', verified: SOURCIFY, sources: sources.map((f) => ({ path: f.path, lang: 'solidity', bytes: Buffer.byteLength(f.text) })), abi: { functions: ['deposit(uint256)'], events: [] } }),
    abiJson: [{ type: 'function', name: 'deposit', inputs: [{ type: 'uint256' }] }],
    sources,
    sourceBundleHash: bundle,
  }
}

await test('store: keep, list, item, records, duplicates, restart resume', async () => {
  const dataDir = freshDir()
  const st = createChainStore({ dataDir, log: quiet, saveDelayMs: 0 })
  const r1 = await st.process(keptEvm(EVM_A, 'h1', 'b1'))
  assert.equal(r1.verdict, 'kept', r1.reason)
  assert.ok(r1.item && r1.item.sourceFiles === 3 && r1.item.verifiedBy === 'sourcify')
  const r2 = await st.process(keptEvm(EVM_B, 'h1', 'b9'))
  assert.equal(r2.verdict, 'duplicate')
  const r3 = await st.process({ agent: 'sol-1', via: 'block', read: mkRead('solana', SOL_A, { codeHash: 's1', idl: IDL, name: 'amm' }), idlJson: { version: '0.1.0', name: 'amm', instructions: [] } })
  assert.equal(r3.verdict, 'kept')
  const r4 = await st.process({ agent: 'sol-1', via: 'block', read: mkRead('solana', SOL_B, { kind: 'token-mint' }) })
  assert.equal(r4.verdict, 'token-mint')
  st.countError('sol-2', 'solana')
  assert.equal(st.seenCode('h1'), `ethereum:${EVM_A}`)

  const sum = st.summary()
  assert.equal(sum.reads, 5)
  assert.equal(sum.kept, 2)
  assert.deepEqual(sum.rejected, { duplicate: 1, 'token-mint': 1, error: 1 })
  assert.equal(sum.programs, 1)
  assert.equal(sum.contracts, 1)
  assert.equal(sum.idls, 1)
  assert.equal(sum.verified, 1)
  assert.equal(sum.byChain.solana.reads, 3)
  assert.equal(sum.byChain.ethereum.kept, 1)
  assert.equal(sum.agents['sol-1'].reads, 2)

  const list = st.items({})
  assert.equal(list.items.length, 2)
  assert.equal(list.next, null)
  assert.equal(st.items({ chain: 'solana' }).items[0].address, SOL_A)
  const got = st.item('ethereum', EVM_A.toUpperCase().replace('0X', '0x'))
  assert.ok(got)
  assert.equal(got.read.codeHash, 'h1')
  assert.deepEqual(got.read.abi, { functions: ['deposit(uint256)'], events: [] })
  assert.equal(st.item('ethereum', EVM_B), null)

  const recs = st.records()
  assert.equal(recs.length, 2)
  const evm = recs.find((r) => r.chain === 'ethereum')!
  assert.equal(evm.sources.length, 3)
  assert.ok(evm.sources[2].text.includes('contract LendingVault'))
  assert.equal(evm.sources[2].lang, 'solidity')
  assert.ok(Array.isArray(evm.abi))
  assert.equal(evm.verified?.compiler, 'solc 0.8.24')
  const sol = recs.find((r) => r.chain === 'solana')!
  assert.deepEqual(sol.idl, { version: '0.1.0', name: 'amm', instructions: [] })
  await st.close()

  // restart: same index, duplicates still detected, counters kept
  const st2 = createChainStore({ dataDir, log: quiet, saveDelayMs: 0 })
  assert.equal(st2.summary().kept, 2)
  assert.equal(st2.summary().reads, 5)
  assert.equal((await st2.process(keptEvm('0x3333333333333333333333333333333333333333', 'h2', 'b1'))).verdict, 'duplicate', 'bundle hash survives restart')
  assert.equal((await st2.process(keptEvm('0x4444444444444444444444444444444444444444', 'h4', 'b4', '\n// different'))).verdict, 'kept')
  assert.equal(st2.records().length, 3)
  assert.ok(st2.item('solana', SOL_A))
  await st2.close()
})

await test('store: OtterSec-verified program keeps repo + commit, no source download', async () => {
  const st = createChainStore({ dataDir: freshDir(), log: quiet, saveDelayMs: 0 })
  const r = await st.process({
    agent: 'sol-2',
    via: 'registry',
    read: mkRead('solana', SOL_B, { codeHash: 'o1', verified: { by: 'osec', match: 'full', repo: 'https://github.com/org/prog', commit: 'deadbeef', compiler: null }, securityTxt: { name: 'prog', source_code: 'https://github.com/org/prog' } }),
  })
  assert.equal(r.verdict, 'kept')
  const rec = st.records()[0]
  assert.equal(rec.sources.length, 0)
  // the GitHub code index is a fixed list: a repository outside it is not claimed to be covered
  assert.equal(rec.sourcesNote, 'source at https://github.com/org/prog@deadbeef (OtterSec verified build); source files are not copied here')
  assert.equal(rec.securityTxt?.source_code, 'https://github.com/org/prog')
  const r2 = await st.process({
    agent: 'sol-2',
    via: 'registry',
    read: mkRead('solana', SOL_A, { codeHash: 'o2', verified: { by: 'osec', match: 'full', repo: 'https://github.com/solana-program/stake-pool', commit: null, compiler: null } }),
  })
  assert.equal(r2.verdict, 'kept')
  assert.equal(
    st.records()[1].sourcesNote,
    'source at https://github.com/solana-program/stake-pool (commit not recorded) (OtterSec verified build); source files are not copied here; this repository is also in the GitHub code index',
  )
  await st.close()
})

await test('store: dedupe keys carry the chain; rejected bytecode is remembered; keptAt', async () => {
  const st = createChainStore({ dataDir: freshDir(), log: quiet, saveDelayMs: 0 })
  const k = await st.process(keptEvm(EVM_A, 'ep1', 'epb'))
  assert.equal(k.verdict, 'kept')
  assert.equal(st.seenCode('ep1'), `ethereum:${EVM_A}`)
  assert.ok((st.keptAt('ethereum', EVM_A.toUpperCase().replace('0X', '0x')) ?? 0) > 0)
  assert.equal(st.keptAt('base', EVM_A), null)
  const other = await st.process({ ...keptEvm(EVM_A, 'ep1', 'epb'), agent: 'base-1', read: { ...keptEvm(EVM_A, 'ep1', 'epb').read, chain: 'base' } })
  assert.deepEqual([other.verdict, other.reason], ['duplicate', 'same bytecode as ethereum:0x1111…1111'])
  // boilerplate bytecode on Base, then a clone elsewhere read without Sourcify
  const proxySrc = [{ path: '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol', text: 'contract ERC1967Proxy is Proxy {\n constructor() {}\n}\n' }]
  const bp = await st.process({ agent: 'base-1', via: 'registry', read: mkRead('base', EVM_B, { codeHash: 'oz1967', verified: SOURCIFY, sources: [{ path: proxySrc[0].path, lang: 'solidity', bytes: 60 }] }), sources: proxySrc, sourceBundleHash: 'ozb' })
  assert.equal(bp.verdict, 'boilerplate')
  assert.equal(st.seenRejected('oz1967')?.key, `base:${EVM_B}`)
  const clone = await st.process({ agent: 'arb-1', via: 'block', read: mkRead('arbitrum', EVM_A, { codeHash: 'oz1967' }) })
  assert.deepEqual([clone.verdict, clone.reason], ['boilerplate', 'same bytecode as base:0x2222…2222 (boilerplate)'])
  // unverified bytecode is remembered for a day only
  await st.process({ agent: 'eth-1', via: 'block', read: mkRead('ethereum', EVM_B, { codeHash: 'uv' }) })
  assert.equal(st.seenRejected('uv')?.verdict, 'unverified')
  await st.close()
})

await test('store: crash recovery cuts uncommitted tails and drops dangling entries', async () => {
  const dataDir = freshDir()
  const st = createChainStore({ dataDir, log: quiet, saveDelayMs: 0 })
  await st.process(keptEvm(EVM_A, 'c1', 'cb1'))
  await st.process(keptEvm(EVM_B, 'c2', 'cb2', '\n// b'))
  await st.close()
  const shardDir = join(dataDir, 'chain', 'shards')
  const shard = join(shardDir, readdirSync(shardDir)[0])
  const goodSize = statSync(shard).size
  // a half-written record and a half-written read after the last commit
  appendFileSync(shard, randomBytes(777))
  appendFileSync(join(dataDir, 'chain', 'reads.gz'), randomBytes(55))
  // an orphan shard from a crash right after rotation
  writeFileSync(join(shardDir, 'chain-000099.jsonl.gz'), randomBytes(100))
  const logs: string[] = []
  const st2 = createChainStore({ dataDir, log: (_l, m) => logs.push(m), saveDelayMs: 0 })
  assert.equal(statSync(shard).size, goodSize)
  assert.ok(!existsSync(join(shardDir, 'chain-000099.jsonl.gz')))
  assert.equal(st2.records().length, 2)
  assert.ok(st2.item('ethereum', EVM_B))
  // new writes go after the committed data and stay readable
  await st2.process(keptEvm('0x5555555555555555555555555555555555555555', 'c5', 'cb5', '\n// c'))
  assert.equal(st2.records().length, 3)
  await st2.close()
  // the index points past the end of a truncated file: those entries are dropped
  const readsFile = join(dataDir, 'chain', 'reads.gz')
  const idx = readJson<{ items: { rOff: number; rLen: number; address: string }[] }>(join(dataDir, 'chain', 'items.json'))!
  const last = idx.items.reduce((a, b) => (b.rOff > a.rOff ? b : a))
  const { truncateSync } = await import('node:fs')
  truncateSync(readsFile, last.rOff + 3)
  const st3 = createChainStore({ dataDir, log: (_l, m) => logs.push(m), saveDelayMs: 0 })
  assert.equal(st3.summary().kept, 2)
  assert.equal(st3.item('ethereum', last.address), null)
  assert.ok(logs.some((m) => /past the end/.test(m)))
  await st3.close()
  // an unreadable items.json is moved aside, a fresh index starts
  writeFileSync(join(dataDir, 'chain', 'items.json'), '{nope')
  const st4 = createChainStore({ dataDir, log: (_l, m) => logs.push(m), saveDelayMs: 0 })
  assert.equal(st4.summary().kept, 0)
  assert.ok(readdirSync(join(dataDir, 'chain')).some((f) => f.startsWith('items.json.corrupt-')))
  await st4.close()
})

await test('store: compressed size cap stops keeping; pagination cursor', async () => {
  const dataDir = freshDir()
  const st = createChainStore({ dataDir, log: quiet, saveDelayMs: 0, maxMb: 0.1, maxShardBytes: 64 * 1024, diskReserveBytes: 0 })
  let kept = 0
  let refused = 0
  for (let i = 0; i < 12; i++) {
    const noise = `\n// ${randomBytes(12_000).toString('base64')}` // incompressible
    const addr = `0x${(i + 16).toString(16).padStart(40, 'a')}`
    const r = await st.process(keptEvm(addr, `cap${i}`, `capb${i}`, noise))
    if (r.verdict === 'kept') kept++
    else {
      assert.equal(r.verdict, 'error')
      assert.match(r.reason, /storage cap reached .*not stored/)
      refused++
    }
  }
  assert.ok(kept >= 3 && refused >= 1, `kept ${kept}, refused ${refused}`)
  assert.ok(st.full())
  assert.ok(readdirSync(join(dataDir, 'chain', 'shards')).length >= 2, 'shards rotate')
  // pagination: newest first, cursor continues without repeats
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    const r = st.items({ limit: 2, cursor })
    for (const it of r.items) {
      assert.ok(!seen.has(it.address), 'no repeats')
      seen.add(it.address)
    }
    if (!r.next) break
    cursor = r.next
  }
  assert.equal(seen.size, kept)
  await st.close()
})

// ─── agents ──────────────────────────────────────────────────────────────────

function stubDiscovery(initial: ChainCandidate[]) {
  const q = new Map<ChainId, ChainCandidate[]>()
  const pushed: ChainCandidate[] = []
  const marked: string[] = []
  const verdicts: (string | undefined)[] = []
  const add = (c: ChainCandidate) => {
    const arr = q.get(c.chain) ?? []
    arr.push(c)
    arr.sort((a, b) => b.score - a.score)
    q.set(c.chain, arr)
  }
  for (const c of initial) add(c)
  const d: DiscoveryLike = {
    start() {},
    stop: async () => {},
    next: (chain) => q.get(chain)?.shift() ?? null,
    push(c) {
      pushed.push(c)
      if (!marked.includes(`${c.chain}:${c.address}`)) add(c)
    },
    markRead: (chain, address, verdict) => {
      marked.push(`${chain}:${address}`)
      verdicts.push(verdict)
    },
    stats: () => Object.fromEntries([...q].map(([k, v]) => [k, v.length])),
  }
  return { d, pushed, marked, verdicts, q }
}

function stubRpc(o: { limit?: number; used?: number; canSpend?: boolean; reset?: number } = {}): RpcCtx & { msUntilReset?: () => number } {
  const used = o.used ?? 0
  const limit = o.limit ?? 1_000_000
  const usage = () => Object.fromEntries(['solana', 'solana-discovery', 'ethereum', 'base', 'arbitrum', 'sourcify', 'osec'].map((k) => [k, { used, limit }]))
  const r: RpcCtx & { msUntilReset?: () => number } = {
    call: async () => null,
    fetchJson: async () => null,
    usage,
    canSpend: () => o.canSpend ?? true,
  }
  if (o.reset !== undefined) r.msUntilReset = () => o.reset!
  return r
}

async function until(cond: () => boolean, ms = 4000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await wait(10)
  }
}

await test('agents: loop reads, evaluates, stores, links proxies, emits throttled feed', async () => {
  const dataDir = freshDir()
  const store = createChainStore({ dataDir, log: quiet, saveDelayMs: 0 })
  const IMPL = '0x9999999999999999999999999999999999999999'
  const { d, pushed, marked } = stubDiscovery([
    { chain: 'solana', address: SOL_A, via: 'block', score: 5 },
    { chain: 'solana', address: SOL_B, via: 'web', score: 3 },
    { chain: 'ethereum', address: EVM_A, via: 'registry', score: 4 },
    { chain: 'ethereum', address: EVM_B, via: 'block', score: 2 },
  ])
  const readSolana: ReadSolanaFn = async (address, _ctx, opts) => {
    assert.equal(typeof opts?.skipOsec, 'function', 'skipOsec is wired')
    return address === SOL_A ? { read: mkRead('solana', address, { codeHash: 'p1', idl: IDL, name: 'amm' }), idlJson: { name: 'amm' } } : { read: mkRead('solana', address, { kind: 'token-mint' }), idlJson: null }
  }
  const evmCalls: string[] = []
  const readEvm: ReadEvmFn = async (chain, address, _ctx, opts) => {
    evmCalls.push(address)
    if (address === EVM_A) {
      const k = keptEvm(address, 'e1', 'eb1')
      return { read: k.read, abiJson: k.abiJson, sources: k.sources, sourceBundleHash: k.sourceBundleHash }
    }
    if (address === EVM_B) {
      // a proxy whose own source is library code
      assert.equal(typeof opts?.skipSourcify, 'function')
      return {
        read: mkRead(chain, address, { codeHash: 'px', verified: SOURCIFY, proxy: { standard: 'eip1967', implementation: IMPL }, sources: [{ path: '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol', lang: 'solidity', bytes: 60 }] }),
        abiJson: null,
        sources: [{ path: '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol', text: 'contract ERC1967Proxy is Proxy {\n constructor() {}\n}\n' }],
        sourceBundleHash: 'pxb',
      }
    }
    // the implementation: same code as EVM_A
    const k = keptEvm(address, 'e1', 'eb1')
    return { read: k.read, abiJson: k.abiJson, sources: k.sources, sourceBundleHash: k.sourceBundleHash }
  }
  const sent: { at: number; ev: ChainEvent }[] = []
  const agents = createChainAgentsWith({
    rpc: stubRpc(),
    discovery: d,
    readSolana,
    readEvm,
    store,
    broadcast: (m) => sent.push({ at: Date.now(), ev: m.event }),
    log: quiet,
    minGapMs: 0,
    idleMs: 20,
    pace: false,
    broadcastPerSec: 20,
  })
  agents.start()
  await until(() => marked.length >= 5)
  await until(() => sent.length >= 5)
  await agents.stop()

  assert.ok(pushed.some((c) => c.address === IMPL && c.via === 'link' && c.chain === 'ethereum'), 'implementation queued as a link')
  const feed = agents.feed(50)
  assert.equal(feed.length, 5)
  assert.ok(feed[0].ts >= feed[feed.length - 1].ts, 'newest first')
  const byAddr = Object.fromEntries(feed.map((e) => [e.address, e]))
  assert.equal(byAddr[SOL_A].verdict, 'kept')
  assert.equal(byAddr[SOL_A].idl, true)
  assert.equal(byAddr[SOL_B].verdict, 'token-mint')
  assert.equal(byAddr[EVM_A].verdict, 'kept')
  assert.equal(byAddr[EVM_A].verifiedBy, 'sourcify')
  assert.equal(byAddr[EVM_A].sourceFiles, 3)
  assert.ok(byAddr[EVM_A].sourceBytes > 1000)
  assert.equal(byAddr[EVM_B].verdict, 'boilerplate')
  assert.match(byAddr[EVM_B].reason, /implementation queued/)
  assert.equal(byAddr[IMPL].verdict, 'duplicate')
  assert.equal(byAddr[IMPL].via, 'link')
  for (const e of feed) assert.ok(!/safe|audited|crawl/i.test(e.reason), e.reason)

  // broadcast spacing ≤ 20/s
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].at - sent[i - 1].at >= 40, `spacing ${sent[i].at - sent[i - 1].at}`)

  const s = agents.stats()
  assert.equal(s.agents.length, 5)
  assert.deepEqual(
    s.agents.map((a) => a.id),
    ['sol-1', 'sol-2', 'eth-1', 'base-1', 'arb-1'],
  )
  assert.equal(s.reads, 5)
  assert.equal(s.kept, 2)
  assert.equal(s.programs, 1)
  assert.equal(s.contracts, 1)
  assert.equal(s.rejected['token-mint'], 1)
  assert.equal(s.rejected.boilerplate, 1)
  assert.equal(s.rejected.duplicate, 1)
  assert.equal(s.byChain.ethereum.reads, 3)
  assert.equal(s.agents.filter((a) => a.chain === 'solana').reduce((n, a) => n + a.reads, 0), 2)
  assert.ok(s.budget.solana)
  assert.equal(agents.items({}).items.length, 2)
  assert.ok(agents.item('solana', SOL_A))
  await store.close()

  // per-agent counters survive a restart of the store
  const store2 = createChainStore({ dataDir, log: quiet })
  const again = createChainAgentsWith({ rpc: stubRpc(), discovery: stubDiscovery([]).d, readSolana, readEvm, store: store2, broadcast: quiet, log: quiet })
  assert.equal(again.stats().agents.find((a) => a.id === 'eth-1')!.reads, 3)
  await store2.close()
})

await test('agents: budgets — waiting-budget, BudgetError puts the candidate back, pacing spreads reads', async () => {
  // canSpend false: nobody reads
  const s1 = createChainStore({ dataDir: freshDir(), log: quiet })
  const disc1 = stubDiscovery([{ chain: 'base', address: EVM_A, via: 'block', score: 1 }])
  let reads1 = 0
  const ag1 = createChainAgentsWith({
    rpc: stubRpc({ canSpend: false }),
    discovery: disc1.d,
    readSolana: async () => {
      throw new Error('unused')
    },
    readEvm: async () => {
      reads1++
      throw new Error('unused')
    },
    store: s1,
    broadcast: quiet,
    log: quiet,
    budgetWaitMs: 30,
    agents: [{ id: 'base-1', chain: 'base' }],
  })
  ag1.start()
  await wait(120)
  assert.equal(ag1.stats().agents[0].state, 'waiting-budget')
  assert.equal(reads1, 0)
  await ag1.stop()
  await s1.close()

  // BudgetError inside a read: no verdict, the candidate goes back into the frontier
  const s2 = createChainStore({ dataDir: freshDir(), log: quiet })
  const disc2 = stubDiscovery([{ chain: 'solana', address: SOL_A, via: 'block', score: 1 }])
  const ag2 = createChainAgentsWith({
    rpc: stubRpc(),
    discovery: disc2.d,
    readSolana: async () => {
      throw new BudgetError('solana')
    },
    readEvm: async () => {
      throw new Error('unused')
    },
    store: s2,
    broadcast: quiet,
    log: quiet,
    budgetWaitMs: 5000,
    agents: [{ id: 'sol-1', chain: 'solana' }],
  })
  ag2.start()
  await until(() => disc2.pushed.length >= 1)
  await wait(20)
  assert.equal(ag2.stats().agents[0].state, 'waiting-budget')
  assert.equal(disc2.marked.length, 0)
  assert.equal(ag2.stats().reads, 0)
  const t0 = Date.now()
  await ag2.stop()
  assert.ok(Date.now() - t0 < 500, 'stop wakes a waiting agent')
  await s2.close()

  // pacing: 850 reads left for the rest of a full day → the second read waits (minutes), not 0 ms
  const s3 = createChainStore({ dataDir: freshDir(), log: quiet })
  const disc3 = stubDiscovery([
    { chain: 'arbitrum', address: EVM_A, via: 'block', score: 2 },
    { chain: 'arbitrum', address: EVM_B, via: 'block', score: 1 },
  ])
  let reads3 = 0
  const ag3 = createChainAgentsWith({
    rpc: stubRpc({ limit: 1000, used: 0, reset: 86_400_000 }),
    discovery: disc3.d,
    readSolana: async () => {
      throw new Error('unused')
    },
    readEvm: async (chain, address) => {
      reads3++
      return { read: mkRead(chain, address, { kind: 'empty' }), abiJson: null, sources: [], sourceBundleHash: null }
    },
    store: s3,
    broadcast: quiet,
    log: quiet,
    minGapMs: 0,
    agents: [{ id: 'arb-1', chain: 'arbitrum' }],
  })
  ag3.start()
  await wait(250)
  assert.equal(reads3, 1)
  await ag3.stop()
  await s3.close()

  // the reads share of a budget is used up (discovery keeps its reserve): waiting-budget
  const s4 = createChainStore({ dataDir: freshDir(), log: quiet })
  const ag4 = createChainAgentsWith({
    rpc: stubRpc({ limit: 1000, used: 849, reset: 3_600_000 }),
    discovery: stubDiscovery([{ chain: 'arbitrum', address: EVM_A, via: 'block', score: 2 }]).d,
    readSolana: async () => {
      throw new Error('unused')
    },
    readEvm: async () => {
      throw new Error('should not read')
    },
    store: s4,
    broadcast: quiet,
    log: quiet,
    budgetWaitMs: 30,
    agents: [{ id: 'arb-1', chain: 'arbitrum' }],
  })
  ag4.start()
  await wait(80)
  assert.equal(ag4.stats().agents[0].state, 'waiting-budget')
  assert.equal(ag4.stats().reads, 0)
  await ag4.stop()
  await s4.close()
})

await test('agents: a failing endpoint does not use up candidates; its breaker pauses reads, a probe resumes them', async () => {
  // classification
  assert.equal(endpointOfFailure(new RpcError('timeout', 'ethereum rpc eth_getCode: timed out after 8 s', { transient: true }), 'ethereum'), 'ethereum')
  assert.equal(endpointOfFailure(new RpcError('bad-json', 'sourcify GET: response is not JSON'), 'base'), 'sourcify')
  assert.equal(endpointOfFailure(new RpcError('http', 'solana rpc getMultipleAccounts: HTTP 401', { status: 401 }), 'solana'), 'solana')
  assert.equal(endpointOfFailure(new RpcError('too-large', 'solana rpc getMultipleAccounts: response over 12 MB'), 'solana'), null)
  assert.equal(endpointOfFailure(new RpcError('rpc', 'ethereum rpc eth_getCode: invalid params (-32602)', { code: -32602 }), 'ethereum'), null)
  assert.equal(endpointOfFailure(new Error('Sourcify lookup failed: boom'), 'arbitrum'), 'sourcify')

  const store = createChainStore({ dataDir: freshDir(), log: quiet })
  const disc = stubDiscovery([{ chain: 'ethereum', address: EVM_A, via: 'web', score: 8 }])
  const logs: string[] = []
  let n = 0
  let down = true
  const agents = createChainAgentsWith({
    rpc: stubRpc(),
    discovery: disc.d,
    readSolana: async () => {
      throw new Error('unused')
    },
    readEvm: async (chain, address) => {
      n++
      if (down) throw new RpcError('timeout', `ethereum rpc eth_getCode: timed out via ${KEYED}`, { transient: true })
      return { read: mkRead(chain, address, { kind: 'empty' }), abiJson: null, sources: [], sourceBundleHash: null }
    },
    store,
    broadcast: quiet,
    log: (_l, m) => logs.push(m),
    minGapMs: 0,
    idleMs: 20,
    pace: false,
    breakerFails: 3,
    breakerBaseMs: 150,
    endpointRetries: 10,
    agents: [{ id: 'eth-1', chain: 'ethereum' }],
  })
  agents.start()
  await until(() => n === 3)
  await wait(40)
  // three endpoint failures: the candidate went back each time (not marked), the breaker is open
  assert.equal(disc.marked.length, 0)
  assert.equal(disc.pushed.length, 3)
  assert.ok(disc.pushed.every((c) => c.score === 8), 'no half score for an endpoint failure')
  const st = agents.stats()
  assert.equal(st.agents[0].state, 'error')
  assert.ok(st.frontier['unavailable.ethereum'] > Date.now(), JSON.stringify(st.frontier))
  assert.ok(logs.some((m) => /ethereum unavailable \(3 failures in a row/.test(m)), logs.join(' | '))
  assert.equal(n, 3, 'no read while the breaker is open')
  // the endpoint recovers: one probe read, then normal reads
  down = false
  await until(() => disc.marked.length === 1, 3000)
  await agents.stop()
  assert.equal(n, 4)
  assert.deepEqual(disc.verdicts, ['not-code'])
  assert.ok(logs.some((m) => /ethereum answers again/.test(m)))
  const feed = agents.feed(10)
  assert.equal(feed.length, 4)
  assert.ok(feed.slice(1).every((e) => e.verdict === 'error' && /will retry/.test(e.reason)))
  assert.ok(feed.every((e) => !e.reason.includes(SECRET) && !e.reason.includes('127.0.0.1')), feed[1].reason)
  assert.ok(!logs.some((m) => m.includes(SECRET)))
  await store.close()
})

await test('agents: a candidate that keeps meeting endpoint failures is set aside as a soft error read', async () => {
  const store = createChainStore({ dataDir: freshDir(), log: quiet })
  const disc = stubDiscovery([{ chain: 'base', address: EVM_A, via: 'block', score: 2 }])
  let n = 0
  const agents = createChainAgentsWith({
    rpc: stubRpc(),
    discovery: disc.d,
    readSolana: async () => {
      throw new Error('unused')
    },
    readEvm: async () => {
      n++
      throw new RpcError('http', 'sourcify GET: HTTP 503', { status: 503, transient: true })
    },
    store,
    broadcast: quiet,
    log: quiet,
    minGapMs: 0,
    idleMs: 20,
    pace: false,
    breakerFails: 100,
    endpointRetries: 2,
    agents: [{ id: 'base-1', chain: 'base' }],
  })
  agents.start()
  await until(() => disc.marked.length === 1)
  await agents.stop()
  assert.equal(n, 3)
  assert.deepEqual(disc.verdicts, ['error'], 'soft: offered again after a short time')
  await store.close()
})

await test('agents: other transient errors retry once (half score), then the address is marked read', async () => {
  const store = createChainStore({ dataDir: freshDir(), log: quiet })
  const disc = stubDiscovery([{ chain: 'ethereum', address: EVM_A, via: 'web', score: 8 }])
  let n = 0
  const agents = createChainAgentsWith({
    rpc: stubRpc(),
    discovery: disc.d,
    readSolana: async () => {
      throw new Error('unused')
    },
    readEvm: async () => {
      n++
      throw new Error(`reader: node busy, timed out via ${KEYED}`)
    },
    store,
    broadcast: quiet,
    log: quiet,
    minGapMs: 0,
    idleMs: 20,
    pace: false,
    agents: [{ id: 'eth-1', chain: 'ethereum' }],
  })
  agents.start()
  await until(() => disc.marked.length === 1)
  await agents.stop()
  assert.equal(n, 2)
  assert.equal(disc.pushed.length, 1)
  assert.equal(disc.pushed[0].score, 4)
  assert.deepEqual(disc.verdicts, ['error'])
  const feed = agents.feed(10)
  assert.equal(feed.length, 2)
  assert.match(feed[1].reason, /will retry/)
  assert.ok(feed.every((e) => !e.reason.includes(SECRET)))
  assert.equal(agents.stats().rejected.error, 2)
  await store.close()
})

await test('agents: kept code read this week is not read again; clones of rejected bytecode skip Sourcify (unverified ones not when the registry lists them)', async () => {
  const store = createChainStore({ dataDir: freshDir(), log: quiet, saveDelayMs: 0 })
  await store.process(keptEvm(EVM_A, 'k1', 'kb1'))
  const proxySrc = [{ path: '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol', text: 'contract ERC1967Proxy is Proxy {\n constructor() {}\n}\n' }]
  await store.process({ agent: 'eth-1', via: 'registry', read: mkRead('ethereum', EVM_B, { codeHash: 'oz', verified: SOURCIFY, sources: [{ path: proxySrc[0].path, lang: 'solidity', bytes: 60 }] }), sources: proxySrc })
  const U0 = '0x5555555555555555555555555555555555555555'
  await store.process({ agent: 'eth-1', via: 'block', read: mkRead('ethereum', U0, { codeHash: 'uv' }) })
  const C1 = '0x3333333333333333333333333333333333333333'
  const C2 = '0x4444444444444444444444444444444444444444'
  const C3 = '0x6666666666666666666666666666666666666666'
  const C4 = '0x7777777777777777777777777777777777777777'
  const hashOf: Record<string, string> = { [C1]: 'oz', [C2]: 'oz', [C3]: 'uv', [C4]: 'uv' }
  const disc = stubDiscovery([
    { chain: 'ethereum', address: EVM_A, via: 'block', score: 9 },
    { chain: 'ethereum', address: C1, via: 'block', score: 5 },
    { chain: 'ethereum', address: C2, via: 'registry', score: 4 },
    { chain: 'ethereum', address: C3, via: 'registry', score: 3 },
    { chain: 'ethereum', address: C4, via: 'block', score: 2 },
  ])
  const reads: string[] = []
  const skipped: Record<string, boolean> = {}
  const agents = createChainAgentsWith({
    rpc: stubRpc(),
    discovery: disc.d,
    readSolana: async () => {
      throw new Error('unused')
    },
    readEvm: async (chain, address, _ctx, opts) => {
      reads.push(address)
      skipped[address] = opts?.skipSourcify?.(hashOf[address]) ?? false
      return { read: mkRead(chain, address, { codeHash: hashOf[address] }), abiJson: null, sources: [], sourceBundleHash: null }
    },
    store,
    broadcast: quiet,
    log: quiet,
    minGapMs: 0,
    idleMs: 20,
    pace: false,
    agents: [{ id: 'eth-1', chain: 'ethereum' }],
  })
  agents.start()
  await until(() => disc.marked.length === 5)
  await agents.stop()
  assert.deepEqual(reads, [C1, C2, C3, C4], 'the kept address was not read again')
  assert.equal(disc.verdicts[0], 'kept')
  assert.equal(skipped[C1], true, 'same bytecode as a boilerplate proxy: Sourcify not asked')
  assert.equal(skipped[C2], true, 'boilerplate is a property of the bytecode, registry or not')
  assert.equal(skipped[C3], false, 'unverified elsewhere, but the registry lists this one as verified: Sourcify asked')
  assert.equal(skipped[C4], true)
  const byAddr = Object.fromEntries(agents.feed(10).map((e) => [e.address, e]))
  assert.equal(byAddr[C1].verdict, 'boilerplate')
  assert.match(byAddr[C1].reason, /^same bytecode as 0x2222…2222 \(boilerplate\)/)
  assert.equal(byAddr[C4].verdict, 'unverified')
  assert.match(byAddr[C4].reason, /^same bytecode as 0x5555…5555 \(unverified\)/)
  assert.deepEqual(disc.verdicts.slice(1), ['boilerplate', 'boilerplate', 'unverified', 'unverified'])
  await store.close()
})

server.close()
rmSync(tmp, { recursive: true, force: true })
console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
