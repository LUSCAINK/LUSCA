// CODE ATLAS tests: npx tsx server/atlas/_test.ts
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChainId, ChainIndexItem, ChainRead } from '../../shared/chain.ts'
import { clusters, featuresOf, jaccard, knn, labelClusters, layout, minhash, minhashSim, quantize, type AtlasNode } from './core.ts'
import { createAtlas } from './index.ts'

let passed = 0
function test(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

const ERC20 = ['transfer(address,uint256)', 'approve(address,uint256)', 'allowance(address,address)', 'balanceOf(address)', 'totalSupply()', 'transferFrom(address,address,uint256)', 'decimals()', 'name()', 'symbol()']
const PAIR = ['getReserves()', 'swap(uint256,uint256,address,bytes)', 'skim(address)', 'sync()', 'mint(address)', 'burn(address)', 'token0()', 'token1()']

function read(chain: ChainId, address: string, fns: string[], ix: string[] = []): ChainRead {
  return {
    chain, address, kind: chain === 'solana' ? 'program' : 'contract', name: address.slice(0, 6), codeHash: null,
    upgradeable: chain === 'solana' ? true : null, upgradeAuthority: null, lastDeploySlot: null, programBytes: null,
    loader: chain === 'solana' ? 'BPFLoaderUpgradeab1e11111111111111111111111' : null,
    idl: ix.length ? { name: null, version: null, instructions: ix.map((name) => ({ name, args: 0, accounts: 0 })), accounts: [], types: 0, errors: 0, events: 0 } : null,
    securityTxt: null, bytecodeBytes: null, proxy: null,
    abi: fns.length ? { functions: fns, events: ['Transfer(address,address,uint256)'] } : null,
    verified: null, sources: [], notes: [], readAt: 1, rpcCalls: 0,
  }
}
function node(r: ChainRead): AtlasNode {
  const tokens = featuresOf(r)
  return { key: `${r.chain}:${r.address}`, chain: r.chain, address: r.address, name: r.name, tokens, sig: minhash(tokens), verifiedBy: null, firstSeen: 1 }
}

const reads: ChainRead[] = []
for (let i = 0; i < 12; i++) reads.push(read('ethereum', `0x${'a'.repeat(38)}${String(i).padStart(2, '0')}`, [...ERC20, ...(i % 3 === 0 ? ['permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', 'nonces(address)'] : [])]))
for (let i = 0; i < 8; i++) reads.push(read('base', `0x${'b'.repeat(38)}${String(i).padStart(2, '0')}`, PAIR))
for (let i = 0; i < 6; i++) reads.push(read('solana', `So1ana${'x'.repeat(30)}${i}`, [], ['initialize', 'swap', 'depositLiquidity', 'withdrawLiquidity']))

test('features: ABI names without argument lists, IDL instructions, Solana shape tokens', () => {
  const f = featuresOf(reads[0])
  assert.ok(f.includes('fn:transfer') && f.includes('ev:Transfer') && !f.some((t) => t.includes('(')))
  const s = featuresOf(reads[reads.length - 1])
  assert.ok(s.includes('ix:swap') && s.includes('sol:idl') && s.includes('sol:upgradeable'))
})

test('minhash tracks jaccard', () => {
  const a = featuresOf(reads[0]), b = featuresOf(reads[3])
  const j = jaccard(a, b)
  assert.ok(Math.abs(minhashSim(minhash(a), minhash(b)) - j) < 0.25, 'estimate near exact')
  assert.equal(minhashSim(minhash(a), minhash(a)), 1)
})

const nodes = reads.map(node)
const edges = knn(nodes, 6)

test('nearest neighbours stay within their family', () => {
  for (let i = 0; i < nodes.length; i++) {
    const fam = nodes[i].chain
    for (const e of edges[i].filter((x) => x.w > 0.5)) assert.equal(nodes[e.j].chain, fam)
  }
})

const cl = clusters(edges, 4)
const labels = labelClusters(nodes, cl)

test('clusters + labels: ERC-20, Uniswap V2 pair, Solana instructions', () => {
  assert.equal(new Set(cl.slice(0, 12)).size, 1)
  assert.ok(labels[cl[0]].startsWith('ERC-20'), labels[cl[0]])
  assert.ok(labels[cl[12]].startsWith('Uniswap V2 pair'), labels[cl[12]])
  assert.ok(labels[cl[20]].startsWith('Solana · '), labels[cl[20]])
})

test('layout is deterministic and warm starts stay put', () => {
  const a = layout(nodes, edges, new Map())
  const b = layout(nodes, edges, new Map())
  assert.deepEqual([...a], [...b])
  const prev = new Map(nodes.map((n, i) => [n.key, [a[2 * i], a[2 * i + 1]] as [number, number]]))
  const c = layout(nodes, edges, prev)
  let moved = 0
  for (let i = 0; i < nodes.length; i++) moved = Math.max(moved, Math.hypot(c[2 * i] - a[2 * i], c[2 * i + 1] - a[2 * i + 1]))
  assert.ok(moved < 3, `warm re-layout moved ${moved}`)
  const q = quantize(a)
  assert.ok(q.x.every((v) => v >= 0 && v <= 10000))
  // families sit closer to each other than to other families
  const d = (i: number, j: number) => Math.hypot(a[2 * i] - a[2 * j], a[2 * i + 1] - a[2 * j + 1])
  assert.ok(d(0, 1) < d(0, 13), 'ERC-20s together')
})

test('atlas service: full build, incremental placement, API answers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-'))
  let list = reads.slice(0, 20)
  const asItem = (r: ChainRead, i: number): ChainIndexItem => ({ chain: r.chain, address: r.address, name: r.name, kind: r.kind, via: 'scan' as ChainIndexItem['via'], verifiedBy: null, idl: !!r.idl, sourceFiles: 0, sourceBytes: 0, codeHash: null, firstSeen: 1000 + i, readAt: 1000 + i })
  const atlas = createAtlas({
    dataDir: dir,
    log: () => {},
    source: {
      items: () => ({ items: list.map(asItem).reverse(), next: null }),
      item: (c, a) => { const r = reads.find((x) => x.chain === c && x.address === a); return r ? { item: asItem(r, 0), read: r } : null },
    },
  })
  atlas.refresh()
  let m = atlas.map()
  assert.equal(m.n, 20)
  assert.ok(m.clusters.length >= 2)
  assert.ok(fs.existsSync(path.join(dir, 'atlas', 'layout.json')))
  const before = new Map(m.a.map((a, i) => [a, [m.x[i], m.y[i]]]))
  list = reads.slice(0, 22) // two Solana programs arrive
  atlas.refresh()
  m = atlas.map()
  assert.equal(m.n, 22)
  for (const [a, [x, y]] of before) { const i = m.a.indexOf(a); assert.ok(Math.hypot(m.x[i] - x, m.y[i] - y) < 1500, 'existing dots barely move') }
  const r = atlas.route(`/api/atlas/item/ethereum/${reads[0].address}`)
  assert.equal(r.status, 200)
  const it = JSON.parse(r.json)
  assert.ok(it.relatives.length > 0 && it.relatives[0].similarity > 50)
  assert.equal(atlas.route('/api/atlas/item/ethereum/0xnope').status, 404)
  assert.equal(atlas.route('/api/atlas').status, 200)
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`atlas: ${passed} passed`)
