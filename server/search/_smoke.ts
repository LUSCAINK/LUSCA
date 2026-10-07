// Dev smoke: build the index over a data dir and run a few queries.  npx tsx server/search/_smoke.ts <dataDir> [query...]
import { createChainStore } from '../chain/store.ts'
import { createCodeSearch } from './index.ts'
const dataDir = process.argv[2]
const log = (l: string, m: string) => console.log(`[${l}] ${m}`)
const store = createChainStore({ dataDir, log })
const s = createCodeSearch({ source: store, dataDir, log, startDelayMs: 0, saveDelayMs: 0, builderIdleMs: 1000 })
const rss0 = process.memoryUsage().rss
const t0 = Date.now()
s.start()
while (s.stats().state !== 'ready') await new Promise((r) => setTimeout(r, 100))
await s.idle()
console.log(`ready in ${Date.now() - t0} ms`, JSON.stringify({ ...s.stats(), top: s.stats().top.slice(0, 3).map((t) => `${t.contracts} ${t.path}`) }))
for (const q of process.argv.slice(3).length ? process.argv.slice(3) : ['selfdestruct', 'delegatecall(', 'tx.origin', 'initialize']) {
  const re = q.startsWith('re:')
  const r = await s.search({ q: re ? q.slice(3) : q, re })
  console.log(`\n${q}: ${r.error ? JSON.stringify(r.error) : ''} matches ${r.total.matches} files ${r.total.files} contracts ${r.total.contracts} chains ${JSON.stringify(r.total.chains)} programs ${r.total.programs} capped ${r.total.capped} scanned ${r.scanned.files}/${r.scanned.ofFiles} files ${r.scanned.bytes}/${r.scanned.ofBytes} B · ${r.ms} ms`)
  for (const g of r.groups.slice(0, 3)) for (const f of g.files.slice(0, 2)) console.log(`  ${g.item.chain} ${g.item.name} ${f.path} x${f.matches} shared ${f.shared.contracts} ${JSON.stringify(f.shared.chains)} lib ${f.library} :: ${f.blocks[0]?.find((l) => l.hits.length)?.text.trim().slice(0, 100)}`)
  for (const h of r.idl.slice(0, 3)) console.log(`  IDL ${h.item.name} ${h.entries.map((e) => `${e.kind} ${e.text.slice(0, 60)}`).join(' | ')}`)
}
await s.save()
console.log('rss before', (rss0 / 1048576).toFixed(0), 'MB · after', (process.memoryUsage().rss / 1048576).toFixed(0), 'MB · shared', (s.stats().sharedBytes / 1048576).toFixed(0), 'MB · unique', (s.stats().bytes / 1048576).toFixed(0), 'MB · disk', (s.stats().diskBytes / 1048576).toFixed(1), 'MB')
await new Promise((r) => setTimeout(r, 4000))
for (let i = 0; i < 3; i++) await s.search({ q: 're:\w+\(', re: true })
console.log('heaps MB', (await s.heaps()).map((h) => (h / 1048576).toFixed(1)).join(' '), 'main heap', (process.memoryUsage().heapUsed / 1048576).toFixed(0), 'external', (process.memoryUsage().external / 1048576).toFixed(0), 'ab', (process.memoryUsage().arrayBuffers / 1048576).toFixed(0))
console.log('rss +3s', (process.memoryUsage().rss / 1048576).toFixed(0), 'MB')
await s.stop()
await store.close()
process.exit(0)
