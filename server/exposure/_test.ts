// EXPOSURE unit tests: offsets / parsers on fixtures, verdicts, validation, caps and cache (no network).
import assert from 'node:assert/strict'
import { base58Decode, base58Encode } from '../../shared/base58.ts'
import { createExposure, validate } from './index.ts'
import { delegationOf, keyNonce, verdictOfNonce } from './evm.ts'
import { gpaFilters, gpaKeys, parseDataAccount, parseTokenAccounts, programOfFilters, TOKEN, STAKE } from './solana.ts'
import { cmpDecimal, formatUnits } from './common.ts'
import { RpcError, type RpcCtx } from '../chain/rpc.ts'

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
  assert.equal(j.calls, 5) // 3 nonces + code here (nonce 0 elsewhere: no code read) + balance
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
  const safeA = '0x' + '55'.repeat(20)
  const o1 = '0x' + '33'.repeat(20)
  const o2 = '0x' + '44'.repeat(20)
  const o3 = '0x' + '66'.repeat(20)
  const word = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
  const owners = '0x' + word('20') + word('3') + word(o1) + word(o2) + word(o3)
  const rpc = fakeRpc({})
  let k = 0
  rpc.call = async (chain, method, params) => {
    const p = params as [unknown, string]
    rpc.calls.push(`${chain}:${method}`)
    if (method === 'eth_call') {
      const data = (p[0] as { data: string }).data
      if (data === '0xe75235b8') return (k++, '0x' + word('2'))
      if (data === '0xaffed0e0') return '0x' + word('7')
      return owners
    }
    const who = String(p[0]).toLowerCase()
    if (method === 'eth_getCode') return who === safeA || who === o3 ? '0x6080' : '0x'
    if (method === 'eth_getTransactionCount') return who === o1 && chain === 'arbitrum' ? '0x4' : who === o3 || who === safeA ? '0x1' : '0x0'
    return '0x0'
  }
  const s = await createExposure({ rpc }).lookup('ethereum', safeA)
  assert.equal(s.key.kind, 'safe')
  assert.equal(s.safe?.threshold, 2)
  assert.equal(s.safe?.nonce, 7)
  assert.equal(s.safe?.owners.length, 3)
  assert.equal(s.safe?.owners[0].exposed, true) // nonce on another chain counts
  assert.equal(s.safe?.owners[1].exposed, null) // nonce 0, but the Safe executed 7 times
  assert.match(s.safe?.owners[1].basis ?? '', /may already be public/)
  assert.equal(s.safe?.owners[2].contract, true) // contract owner, not an exposed key
  assert.equal(s.safe?.owners[2].exposed, null)
  assert.match(s.notes.join(' '), /2 owner signatures are needed; 1 of the 3/)
  assert.equal(k, 1)
})

await t('EVM: a contract on another chain is not an exposed key', async () => {
  const rpc = fakeRpc({})
  rpc.call = async (chain, method) => {
    rpc.calls.push(`${chain}:${method}`)
    if (method === 'eth_getTransactionCount') return chain === 'base' ? '0x1' : '0x0'
    if (method === 'eth_getCode') return chain === 'base' ? '0x6080' : '0x'
    return '0x0'
  }
  const r = await createExposure({ rpc }).lookup('ethereum', '0x' + '77'.repeat(20))
  assert.equal(r.key.kind, 'contract')
  assert.equal(r.key.exposed, null)
  assert.match(r.key.verdict, /Contract on base/)
  assert.equal(keyNonce([{ chain: 'base', txCount: 1, code: 'contract' }, { chain: 'ethereum', txCount: 2, code: 'none' }]).total, 2)
})

await t('EVM: a failed Safe check is partial, a revert is not', async () => {
  const mk = (err: Error) => {
    const rpc = fakeRpc({ eth_getTransactionCount: '0x1', eth_getCode: '0x6080', eth_getBalance: '0x0', eth_call: err })
    return createExposure({ rpc }).lookup('ethereum', '0x' + '88'.repeat(20))
  }
  const t1 = await mk(new RpcError('timeout', 'x', { transient: true }))
  assert.equal(t1.key.verdict, 'Contract (Safe check not read)')
  assert.ok(t1.partial.some((p) => /Safe check/.test(p)))
  const t2 = await mk(new RpcError('rpc', 'execution reverted', { code: 3 }))
  assert.equal(t2.key.verdict, 'Contract (no private key)')
  assert.ok(!t2.partial.some((p) => /Safe check/.test(p)))
})

const b64 = (d: Uint8Array) => Buffer.from(d).toString('base64')
await t('Solana wallet lookup: partial, not an error; no mint gPA', async () => {
  const rpc = fakeRpc({ getAccountInfo: { value: { owner: '11111111111111111111111111111111', executable: false, lamports: 2_000_000_000, data: ['', 'base64'] } }, getTokenAccountsByOwner: { value: [] }, getProgramAccounts: new Error('boom') })
  const r = await createExposure({ rpc }).lookup('solana', AUTH)
  assert.equal(r.key.kind, 'wallet')
  assert.equal(r.key.exposed, true)
  assert.equal(r.holds.native?.amount, '2')
  assert.equal(rpc.calls.filter((c) => c.endsWith('getProgramAccounts')).length, 3) // ProgramData + staker + withdrawer
  assert.ok(r.partial.some((p) => /reverse mint-authority/.test(p)))
})

await t('Solana: a mint is a data account with its authorities, not a wallet', async () => {
  const d = new Uint8Array(82)
  d.set([1, 0, 0, 0], 0)
  d.set(base58Decode(AUTH) as Uint8Array, 4)
  d[45] = 1
  const p = parseDataAccount(TOKEN, d, 82)
  assert.equal(p?.authorities[0].role, 'Mint authority')
  assert.equal(p?.authorities[0].address, AUTH)
  assert.equal(p?.authorities[1].address, null) // freeze None
  const rpc = fakeRpc({ getAccountInfo: { value: { owner: TOKEN, executable: false, lamports: 1, data: [b64(d), 'base64'], space: 82 } } })
  const r = await createExposure({ rpc }).lookup('solana', AUTH)
  assert.equal(r.key.kind, 'account')
  assert.equal(r.key.exposed, null)
  assert.match(r.key.verdict, /mint/)
  assert.equal(r.key.authorities?.length, 2)
  assert.deepEqual(rpc.calls, ['solana:getAccountInfo']) // one read, no reverse lookups
  const st = new Uint8Array(200)
  st[0] = 1
  st.set(base58Decode(AUTH) as Uint8Array, 44)
  assert.equal(parseDataAccount(STAKE, st, 200)?.authorities[1].address, AUTH)
})

await t('Exposure share: a day share and an hourly share stop calls before the shared budget', async () => {
  const rpc = fakeRpc({ getAccountInfo: { value: { owner: '11111111111111111111111111111111', executable: false, lamports: 1, data: ['', 'base64'] } }, getTokenAccountsByOwner: { value: [] }, getProgramAccounts: [] })
  const ex = createExposure({ rpc, limits: { budget: { solana: 20 }, hourShare: 1, ipPerMin: 100, perMin: 100 } })
  const r = await ex.lookup('solana', AUTH)
  // 1 + 2 = 3 units, then 30 for the reverse lookups do not fit the share of 20
  assert.equal(rpc.calls.filter((c) => c.endsWith('getProgramAccounts')).length, 0)
  assert.ok(r.partial.some((p) => /daily share/.test(p)))
  const ex2 = createExposure({ rpc: fakeRpc({ eth_getTransactionCount: '0x1', eth_getCode: '0x', eth_getBalance: '0x0' }), limits: { budget: { ethereum: 100 }, hourShare: 0.01 } })
  const r2 = await ex2.lookup('ethereum', '0x' + '99'.repeat(20))
  assert.ok(r2.partial.some((p) => /this hour's share/.test(p)))
})

await t('per-IP day cap', async () => {
  const ex = createExposure({ rpc: fakeRpc({ eth_getTransactionCount: '0x0', eth_getCode: '0x', eth_getBalance: '0x0' }), limits: { ipPerMin: 100, ipPerDay: 2 } })
  assert.equal((await ex.route(`/api/exposure/base/0x${'a1'.repeat(20)}`, 'ipX')).status, 200)
  assert.equal((await ex.route(`/api/exposure/base/0x${'a2'.repeat(20)}`, 'ipX')).status, 200)
  const third = await ex.route(`/api/exposure/base/0x${'a3'.repeat(20)}`, 'ipX')
  assert.equal(third.status, 429)
  assert.match(third.json, /your connection/)
  assert.equal((await ex.route(`/api/exposure/base/0x${'a1'.repeat(20)}`, 'ipX')).status, 200) // cached answers stay free
})

console.log(`exposure: ${n} tests passed`)
