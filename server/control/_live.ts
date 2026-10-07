// Live check (manual): classify real kept items read from lusca.ink's public API, resolving EVM proxies over
// the public RPCs. Run: npx tsx server/control/_live.ts   (≤ 1 request/s to lusca.ink)
import type { ChainRead } from '../../shared/chain.ts'
import { createRpc } from '../chain/rpc.ts'
import { classifySolana, resolveEvm } from './resolve.ts'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const get = async (u: string) => { const r = await fetch(`https://lusca.ink${u}`); await sleep(1100); return r.ok ? r.json() : null }
const rpc = createRpc({ log: () => {} })
const N = Number(process.argv[2] ?? 30)
const solCls: Record<string, number> = {}
const solItems = ((await get('/api/chain/items?chain=solana&limit=200')) as { items: { address: string }[] }).items
for (const it of solItems.slice(0, N)) {
  const got = (await get(`/api/chain/item/solana/${it.address}`)) as { read: ChainRead } | null
  if (!got) continue
  const c = classifySolana(got.read)
  solCls[c.cls] = (solCls[c.cls] ?? 0) + 1
  console.log('SOL', c.cls.padEnd(9), got.read.name ?? '', it.address, got.read.upgradeAuthority ?? '')
}
console.log('solana sample', solCls)
for (const chain of ['ethereum', 'base', 'arbitrum'] as const) {
  const items = ((await get(`/api/chain/items?chain=${chain}&limit=100`)) as { items: { address: string }[] }).items
  let found = 0
  for (const it of items.slice(0, N)) {
    if (found >= 5) break
    const got = (await get(`/api/chain/item/${chain}/${it.address}`)) as { read: ChainRead } | null
    if (!got?.read.proxy) continue
    found++
    try {
      const r = await resolveEvm(got.read, (m, p) => rpc.call(chain, m, p, { timeoutMs: 10000 }))
      console.log('EVM', chain, r.cls.padEnd(9), got.read.name ?? '', it.address, '|', r.hops.map((h) => `${h.label}${h.address ? ' ' + h.address : ''}`).join(' -> '))
    } catch (err) { console.log('EVM', chain, 'ERR', it.address, (err as Error).message) }
  }
}
await rpc.close()
