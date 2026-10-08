// EXPOSURE unit tests: offsets / parsers on fixtures, verdicts, validation, caps and cache (no network).
import assert from 'node:assert/strict'
import { base58Decode, base58Encode } from '../../shared/base58.ts'
import { createExposure, validate } from './index.ts'
import { delegationOf, verdictOfNonce } from './evm.ts'
import { gpaFilters, gpaKeys, parseTokenAccounts, programOfFilters } from './solana.ts'
import { cmpDecimal, formatUnits } from './common.ts'
import type { RpcCtx } from '../chain/rpc.ts'

let n = 0
const t = async (name: string, f: () => void | Promise<void>) => {
  await f()
  n++
  console.log(`ok ${name}`)
}
const AUTH = 'CjoV5B96reuCfPh2rRK11G1QptG97jZdyZArTn3EN1Mj'

await t('formatUnits / cmpDecimal', () => {
  assert.equal(formatUnits(1_500_000_000n, 9), '1.5')
  assert.equal(formatUnits(1n, 6), '0.000001')
  assert.equal(formatUnits(12n, 0), '12')
  assert.ok(cmpDecimal('10.1', '9.99') > 0)
})

await t('gpa filters put the key at the documented offsets', () => {
  const f = gpaFilters(AUTH)
  const k = base58Decode(AUTH) as Uint8Array
  const pd = base58Decode(f.programData.filters[1].memcmp!.bytes) as Uint8Array
  assert.equal(f.programData.filters[1].memcmp!.offset, 12)
  assert.equal(pd[0], 1)
  assert.deepEqual([...pd.slice(1)], [...k]) // key at 13
  assert.deepEqual([...(base58Decode(f.programData.filters[0].memcmp!.bytes) as Uint8Array)], [3, 0, 0, 0])
  const mint = base58Decode((f.mintAuthority.filters[1] as { memcmp: { bytes: string; offset: number } }).memcmp.bytes) as Uint8Array
  assert.deepEqual([...mint.slice(0, 4)], [1, 0, 0, 0])
  assert.deepEqual([...mint.slice(4)], [...k]) // key at 4
  const fr = (f.freezeAuthority.filters[1] as { memcmp: { bytes: string; offset: number } }).memcmp
  assert.equal(fr.offset + 4, 50) // key at 50
  assert.equal((f.staker.filters[1] as { memcmp: { offset: number } }).memcmp.offset, 12)
  assert.equal((f.withdrawer.filters[1] as { memcmp: { offset: number } }).memcmp.offset, 44)
  assert.deepEqual(f.mintAuthority.filters[0], { dataSize: 82 })
  assert.deepEqual(f.staker.filters[0], { dataSize: 200 })
  const po = base58Decode((programOfFilters(AUTH)[1] as { memcmp: { bytes: string } }).memcmp.bytes) as Uint8Array
  assert.deepEqual([...po.slice(0, 4)], [2, 0, 0, 0])
  assert.equal(base58Encode(po.slice(4)), AUTH)
})

await t('gpaKeys and parseTokenAccounts', () => {
  assert.deepEqual(gpaKeys([{ pubkey: 'a', account: {} }, { x: 1 }]), ['a'])
  assert.deepEqual(gpaKeys({ value: [{ pubkey: 'b' }] }), ['b'])
  const fx = {
    value: [
      { pubkey: 'acc1', account: { data: { parsed: { info: { mint: 'm1', tokenAmount: { amount: '2500000', decimals: 6 } } } } } },
      { pubkey: 'acc0', account: { data: { parsed: { info: { mint: 'm0', tokenAmount: { amount: '0', decimals: 6 } } } } } },
      { pubkey: 'accd', account: { data: { parsed: { info: { mint: 'm2', delegate: 'D', delegatedAmount: { amount: '5' }, tokenAmount: { amount: '0', decimals: 0 } } } } } },
      { pubkey: 'bad', account: { data: { parsed: { info: { mint: 'm3', tokenAmount: { amount: '-1', decimals: 0 } } } } } },
    ],
  }
  const r = parseTokenAccounts(fx)
  assert.equal(r.length, 2)
  assert.equal(r[0].amount, '2.5')
  assert.equal(r[1].delegate, 'D')
  assert.equal(r[1].delegated, '5')
})

await t('EIP-7702 delegation prefix', () => {
  assert.equal(delegationOf('0xef0100' + 'ab'.repeat(20)), '0x' + 'ab'.repeat(20))
  assert.equal(delegationOf('0x6080'), null)
  assert.equal(delegationOf('0xef0100abcd'), null)
})

await t('nonce verdicts never call nonce 0 safe', () => {
  assert.equal(verdictOfNonce(3, 3).exposed, true)
  const z = verdictOfNonce(0, 3)
  assert.equal(z.exposed, false)
  assert.equal(z.verdict, 'Not exposed by any transaction')
  assert.match(z.basis, /Safe co-signature/)
  assert.match(z.basis, /not a statement that the key is safe/)
  assert.equal(verdictOfNonce(null, 0).exposed, null)
})

await t('validation', () => {
  assert.deepEqual(validate('ethereum', '0x' + 'AB'.repeat(20)), { chain: 'ethereum', address: '0x' + 'ab'.repeat(20) })
  assert.ok('error' in validate('polygon', '0x' + 'ab'.repeat(20)))
  assert.ok('error' in validate('base', '0x1234'))
  assert.ok('error' in validate('solana', '0x' + 'ab'.repeat(20)))
  assert.deepEqual(validate('solana', AUTH), { chain: 'solana', address: AUTH })
})

function fakeRpc(answers: Record<string, unknown>): RpcCtx & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async call(chain, method) {
      calls.push(`${chain}:${method}`)
      const v = answers[`${chain}:${method}`] ?? answers[method]
      if (v instanceof Error) throw v
      return v
    },
    async fetchJson() {
      return null
    },
    usage: () => ({}),
    canSpend: () => true,
  }
}

await t('EVM EOA lookup, cache and caps', async () => {
  const rpc = fakeRpc({ 'ethereum:eth_getTransactionCount': '0x5', eth_getTransactionCount: '0x0', eth_getCode: '0x', eth_getBalance: '0xde0b6b3a7640000' })
  const ex = createExposure({ rpc, limits: { ipPerMin: 2, perMin: 10, perDay: 100 } })
  const a = '0x' + '11'.repeat(20)
  const r1 = await ex.route(`/api/exposure/ethereum/${a}`, 'ip1')
  assert.equal(r1.status, 200)
  const j = JSON.parse(r1.json)
  assert.equal(j.key.kind, 'eoa')
  assert.equal(j.key.exposed, true)
  assert.equal(j.key.txCount, 5)
  assert.equal(j.holds.native.amount, '1')
  assert.equal(j.calls, 5) // 3 nonces + code + balance
  const r2 = JSON.parse((await ex.route(`/api/exposure/ethereum/${a}`, 'ip1')).json)
  assert.equal(r2.cached, true)
  assert.equal(r2.calls, 0)
  assert.equal(rpc.calls.length, 5)
  await ex.route(`/api/exposure/base/${a}`, 'ip1')
  const lim = await ex.route(`/api/exposure/arbitrum/${a}`, 'ip1')
  assert.equal(lim.status, 429)
  assert.equal((await ex.route('/api/exposure/polygon/x', 'ip2')).status, 400)
  assert.equal((await ex.route('/api/exposure/summary', 'ip2')).status, 200)
})

await t('EVM nonce 0 everywhere and Safe owners', async () => {
  const ex = createExposure({ rpc: fakeRpc({ eth_getTransactionCount: '0x0', eth_getCode: '0x', eth_getBalance: '0x0' }) })
  const r = await ex.lookup('base', '0x' + '22'.repeat(20))
  assert.equal(r.key.exposed, false)
  assert.equal(r.key.verdict, 'Not exposed by any transaction')
  const owners = '0x' + (32).toString(16).padStart(64, '0') + (2).toString(16).padStart(64, '0') + '33'.repeat(12).replace(/./g, '0') + '33'.repeat(20) + '0'.repeat(24) + '44'.repeat(20)
  const rpc = fakeRpc({ eth_getTransactionCount: '0x1', eth_getCode: '0x6080', eth_getBalance: '0x0', eth_call: '0x2' })
  let k = 0
  rpc.call = async (_chain, method, params) => {
    rpc.calls.push(method)
    if (method === 'eth_call') return (params as [{ data: string }])[0].data === '0xe75235b8' ? (k++, '0x' + '2'.padStart(64, '0')) : owners
    return ({ eth_getTransactionCount: '0x1', eth_getCode: '0x6080', eth_getBalance: '0x0' } as Record<string, string>)[method]
  }
  const s = await createExposure({ rpc }).lookup('ethereum', '0x' + '55'.repeat(20))
  assert.equal(s.key.kind, 'safe')
  assert.equal(s.safe?.threshold, 2)
  assert.equal(s.safe?.owners.length, 2)
  assert.equal(s.safe?.owners[0].exposed, true)
  assert.equal(k, 1)
})

await t('Solana wallet lookup: partial, not an error', async () => {
  const rpc = fakeRpc({ getAccountInfo: { value: { owner: '11111111111111111111111111111111', executable: false, lamports: 2_000_000_000 } }, getTokenAccountsByOwner: { value: [] }, getProgramAccounts: new Error('boom') })
  const r = await createExposure({ rpc }).lookup('solana', AUTH)
  assert.equal(r.key.kind, 'wallet')
  assert.equal(r.key.exposed, true)
  assert.equal(r.holds.native?.amount, '2')
  assert.ok(r.partial.length >= 5)
})

console.log(`exposure: ${n} tests passed`)
