// CONTROL MAP tests: the ed25519 on-curve check, Solana classification, EVM controller resolution (mock RPC),
// and the module loop over a fake store. Run: npx tsx server/control/_test.ts

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChainIndexItem, ChainRead } from '../../shared/chain.ts'
import { base58Encode } from '../../shared/base58.ts'
import { isOnCurve, isOnCurveBytes } from './curve.ts'
import { classifySolana, decodeAddressArray, IMPL_SLOT, resolveEvm, SEL, SLOT, wordToAddress } from './resolve.ts'
import { createControl } from './index.ts'

let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

// ─── curve ───────────────────────────────────────────────────────────────────
await test('known wallets and program ids are on the curve', () => {
  for (const a of [
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    '11111111111111111111111111111111',
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
  ])
    assert.equal(isOnCurve(a), true, a)
})
await test('program-derived addresses are off the curve', () => {
  // ProgramData PDAs (seed: program id, program: the upgradeable loader), as find_program_address returns them
  for (const a of ['3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2', '4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT', 'CtXfPzz36dH5Ws4UYKZvrQ1Xqzn42ecDW6y8NKuiN8nD'])
    assert.equal(isOnCurve(a), false, a)
})
await test('not an address → null', () => {
  assert.equal(isOnCurve('abc'), null)
  assert.equal(isOnCurve('0OIl'), null)
})
await test('random bytes: about half decompress (sanity of the square-root test)', () => {
  let on = 0
  for (let i = 0; i < 400; i++) if (isOnCurveBytes(crypto.randomBytes(32))) on++
  assert.ok(on > 140 && on < 260, String(on))
  assert.equal(isOnCurve(base58Encode(new Uint8Array(32))), true) // y = 0: x² = −1 has a root mod p
})

// ─── Solana classification ───────────────────────────────────────────────────
const solRead = (o: Partial<ChainRead>): ChainRead => ({
  chain: 'solana', address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', kind: 'program', name: 'jupiter', codeHash: null,
  upgradeable: true, upgradeAuthority: null, lastDeploySlot: 1, programBytes: 1, loader: 'bpf-upgradeable',
  idl: null, securityTxt: null, bytecodeBytes: null, proxy: null, abi: null, verified: null, sources: [], notes: [], readAt: 1, rpcCalls: 1, ...o,
})
await test('solana: immutable / key / pda', () => {
  assert.equal(classifySolana(solRead({ upgradeable: false })).cls, 'immutable')
  assert.equal(classifySolana(solRead({ loader: 'bpf-loader-2', upgradeable: false })).cls, 'immutable')
  assert.equal(classifySolana(solRead({ loader: 'native', upgradeable: false })).cls, 'immutable')
  const k = classifySolana(solRead({ upgradeAuthority: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }))
  assert.equal(k.cls, 'key')
  assert.equal(k.hops[1].kind, 'key')
  const p = classifySolana(solRead({ upgradeAuthority: 'CtXfPzz36dH5Ws4UYKZvrQ1Xqzn42ecDW6y8NKuiN8nD' }))
  assert.equal(p.cls, 'pda')
  assert.equal(p.hops[1].address, 'CtXfPzz36dH5Ws4UYKZvrQ1Xqzn42ecDW6y8NKuiN8nD')
})

// ─── EVM ─────────────────────────────────────────────────────────────────────
const W = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`
const U = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const arr = (as: string[]) => `0x${U(32).slice(2)}${U(as.length).slice(2)}${as.map((a) => W(a).slice(2)).join('')}`
class RpcError extends Error {
  kind = 'rpc'
  constructor() {
    super('execution reverted')
    this.name = 'RpcError'
  }
}
const PROXY = '0x1111111111111111111111111111111111111111'
const PA = '0x2222222222222222222222222222222222222222'
const SAFE = '0x3333333333333333333333333333333333333333'
const TL = '0x4444444444444444444444444444444444444444'
const EOA = '0x5555555555555555555555555555555555555555'
const owners5 = [1, 2, 3, 4, 5].map((i) => `0x${String(i).repeat(40)}`)
interface World {
  code: Record<string, string>
  slots: Record<string, string>
  calls: Record<string, string>
}
const mock = (w: World) => {
  let n = 0
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    n++
    if (method === 'eth_getCode') return w.code[(params[0] as string).toLowerCase()] ?? '0x'
    if (method === 'eth_getStorageAt') return w.slots[`${(params[0] as string).toLowerCase()}:${params[1]}`] ?? U(0)
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string }
      const r = w.calls[`${to.toLowerCase()}:${data.slice(0, 10)}`]
      if (r === undefined) throw new RpcError()
      return r
    }
    throw new Error(method)
  }
  return { call, count: () => n }
}
const evmRead = (o: Partial<ChainRead>): ChainRead => ({ ...solRead({}), chain: 'ethereum', address: PROXY, kind: 'contract', loader: null, upgradeAuthority: null, ...o })

await test('decoders', () => {
  assert.equal(wordToAddress(W(PA)), PA)
  assert.equal(wordToAddress(U(0)), null)
  assert.deepEqual(decodeAddressArray(arr(owners5)), owners5)
})
await test('evm: non-proxy → immutable, clone → immutable, no calls', async () => {
  const m = mock({ code: {}, slots: {}, calls: {} })
  assert.equal((await resolveEvm(evmRead({ proxy: null }), m.call)).cls, 'immutable')
  assert.equal((await resolveEvm(evmRead({ proxy: { standard: 'eip1167', implementation: EOA } }), m.call)).cls, 'immutable')
  assert.equal(m.count(), 0)
})
await test('evm: transparent proxy → ProxyAdmin → Safe 3 of 5', async () => {
  const m = mock({
    code: { [PA]: '0x6080', [SAFE]: '0x6080' },
    slots: { [`${PROXY}:${SLOT.eip1967Admin}`]: W(PA) },
    calls: {
      [`${PA}:${SEL.owner}`]: W(SAFE),
      [`${PA}:${SEL.getProxyAdmin}`]: W(PA),
      [`${SAFE}:${SEL.getThreshold}`]: U(3),
      [`${SAFE}:${SEL.getOwners}`]: arr(owners5),
    },
  })
  const r = await resolveEvm(evmRead({ proxy: { standard: 'eip1967', implementation: EOA } }), m.call)
  assert.equal(r.cls, 'safe')
  assert.deepEqual(r.hops.map((h) => h.label), ['EIP-1967 proxy', 'ProxyAdmin', 'Safe 3 of 5'])
  assert.equal(r.hops[2].threshold, 3)
  assert.equal(r.hops[2].owners, 5)
})
await test('evm: UUPS (empty admin slot) → owner() EOA = single key; timelock admin', async () => {
  const IMPL = '0x7777777777777777777777777777777777777777'
  const notUups = mock({ code: {}, slots: {}, calls: { [`${PROXY}:${SEL.owner}`]: W(EOA) } })
  assert.equal((await resolveEvm(evmRead({ proxy: { standard: 'eip1967', implementation: IMPL } }), notUups.call)).cls, 'unknown')
  const m = mock({ code: {}, slots: {}, calls: { [`${PROXY}:${SEL.owner}`]: W(EOA), [`${IMPL}:${SEL.proxiableUUID}`]: IMPL_SLOT } })
  const r = await resolveEvm(evmRead({ proxy: { standard: 'eip1967', implementation: IMPL } }), m.call)
  assert.equal(r.cls, 'key')
  assert.equal(r.hops[0].label, 'UUPS proxy')
  assert.equal(r.hops[1].via, 'owner()')
  const t = mock({ code: { [TL]: '0x60' }, slots: { [`${PROXY}:${SLOT.eip1967Admin}`]: W(TL) }, calls: { [`${TL}:${SEL.getMinDelay}`]: U(172800) } })
  const r2 = await resolveEvm(evmRead({ proxy: { standard: 'eip1967', implementation: EOA } }), t.call)
  assert.equal(r2.cls, 'timelock')
  assert.equal(r2.hops[1].label, 'timelock 2d')
})
await test('evm: nothing answers → unknown; network error propagates', async () => {
  const m = mock({ code: {}, slots: {}, calls: {} })
  assert.equal((await resolveEvm(evmRead({ proxy: { standard: 'eip1967', implementation: EOA } }), m.call)).cls, 'unknown')
  await assert.rejects(resolveEvm(evmRead({ proxy: { standard: 'eip1967', implementation: EOA } }), async () => { throw new Error('timeout') }))
})

// ─── module ──────────────────────────────────────────────────────────────────
await test('module: sweep classifies Solana with no RPC, resolves EVM proxies under its slice, persists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-'))
  const items: ChainIndexItem[] = []
  const reads = new Map<string, ChainRead>()
  const add = (r: ChainRead) => {
    items.push({ chain: r.chain, address: r.address, name: r.name, kind: r.kind, via: 'block', verifiedBy: null, idl: false, sourceFiles: 0, sourceBytes: 0, codeHash: null, firstSeen: 1, readAt: 1 })
    reads.set(`${r.chain}:${r.address}`, r)
  }
  add(solRead({ upgradeAuthority: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }))
  add(solRead({ address: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', upgradeAuthority: 'CtXfPzz36dH5Ws4UYKZvrQ1Xqzn42ecDW6y8NKuiN8nD' }))
  add(evmRead({ proxy: { standard: 'eip1967', implementation: EOA } }))
  add(evmRead({ address: '0x6666666666666666666666666666666666666666', proxy: null }))
  const m = mock({ code: {}, slots: {}, calls: { [`${PROXY}:${SEL.owner}`]: W(EOA), [`${EOA}:${SEL.proxiableUUID}`]: IMPL_SLOT } })
  const store = { items: () => ({ items, next: null }), item: (c: string, a: string) => { const r = reads.get(`${c}:${a}`); return r ? { item: items.find((i) => i.address === a)!, read: r } : null } }
  const rpcCalls: string[] = []
  const rpc = {
    call: (chain: string, method: string, params: unknown[]) => { rpcCalls.push(chain); return m.call(method, params) },
    fetchJson: async () => null,
    usage: () => ({ ethereum: { used: 0, limit: 15000 } }),
    canSpend: () => true,
  }
  const c = createControl({ rpc: rpc as never, store: store as never, dataDir: dir, log: () => {}, evmCalls: 50 })
  await c.tick()
  const s = c.summary()
  assert.equal(s.total, 4)
  assert.equal(s.byChain.solana?.key, 1)
  assert.equal(s.byChain.solana?.pda, 1)
  assert.equal(s.byChain.ethereum?.immutable, 1)
  assert.equal(s.byChain.ethereum?.key, 1)
  assert.equal(s.pending, 0)
  assert.ok(rpcCalls.every((x) => x === 'ethereum'))
  assert.equal(c.get('ethereum', PROXY.toUpperCase().replace('0X', '0x'))?.cls, 'key')
  const page = c.list({ cls: 'key' })
  assert.equal(page.total, 2)
  await c.stop()
  const again = createControl({ rpc: rpc as never, store: store as never, dataDir: dir, log: () => {}, evmCalls: 50 })
  assert.equal(again.summary().total, 4)
  await again.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})
await test('module: budget slice stops the resolver (proxies stay pending)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-'))
  const r = evmRead({ proxy: { standard: 'eip1967', implementation: EOA } })
  const item: ChainIndexItem = { chain: 'ethereum', address: PROXY, name: null, kind: 'contract', via: 'block', verifiedBy: null, idl: false, sourceFiles: 0, sourceBytes: 0, codeHash: null, firstSeen: 1, readAt: 1 }
  const store = { items: () => ({ items: [item], next: null }), item: () => ({ item, read: r }) }
  let n = 0
  const rpc = { call: async () => { n++; return U(0) }, fetchJson: async () => null, usage: () => ({}), canSpend: () => true }
  const c = createControl({ rpc: rpc as never, store: store as never, dataDir: dir, log: () => {}, evmCalls: 4 })
  await c.tick()
  assert.equal(n, 0)
  assert.equal(c.summary().pending, 1)
  await c.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`control: ${passed} passed`)
