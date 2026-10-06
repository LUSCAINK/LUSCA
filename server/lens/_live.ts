// Live smoke of LUSCA Lens against public RPCs and the real registries (not part of npm test):
//   LUSCA_DATA=<dir> npx tsx server/lens/_live.ts solana:JUP6Lkb… ethereum:0x… …
// Prints a one-line summary per address and writes the full reports to <dir>/lens/_live/.
import fs from 'node:fs'
import path from 'node:path'
import { createRpc } from '../chain/rpc.ts'
import { createChainStore } from '../chain/store.ts'
import { createLens } from './index.ts'
import { createProvenanceIndex } from './provenance.ts'
import type { ChainId } from '../../shared/chain.ts'

const dataDir = path.resolve(process.env.LUSCA_DATA || 'server/data')
const log = (l: string, m: string) => console.log(`[${l}] ${m}`)
const rpc = createRpc({ dataDir, log })
const store = createChainStore({ dataDir, log })
const provenance = createProvenanceIndex({ dataDir, log })
await provenance.refresh()
console.log('provenance', provenance.stats())
const lens = createLens({ rpc, store, record: (ev) => console.log('feed+', ev.verdict, ev.address), feed: () => [], provenance, dataDir, log, limits: { freshPerMin: 1000, freshPerHour: 1000 } })
const out = path.join(dataDir, 'lens', '_live')
fs.mkdirSync(out, { recursive: true })
for (const arg of process.argv.slice(2)) {
  const [chain, address] = arg.split(':') as [ChainId, string]
  const t = Date.now()
  try {
    const { report: r } = await lens.read(chain, address, '127.0.0.1')
    fs.writeFileSync(path.join(out, `${chain}-${address}.json`), JSON.stringify(r, null, 1))
    const s = r.summary
    console.log(
      `OK ${chain} ${address} ${r.kind} name=${r.name} verified=${s.verified} upg=${s.upgradeable} auth=${s.authority} proxy=${s.proxy} surface=${s.surface} priv=${s.privileged} prim=${s.primitives} prov=${s.provenance}/${r.provenance.checked} dataset=${r.dataset.verdict}${r.dataset.added ? '+added' : ''} (${r.dataset.reason}) rpc=${r.rpcCalls} http=${r.registryCalls} ${Date.now() - t}ms`,
    )
  } catch (e) {
    console.log(`ERR ${chain} ${address}: ${(e as Error).message}`)
  }
}
await rpc.close()
await store.close()
