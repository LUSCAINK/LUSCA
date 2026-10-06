// Live smoke of the chain agents core against the free public endpoints (temp data dir, no keys).
//   npx tsx server/chain/_core_live.ts [seconds=80]
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRpc } from './rpc.ts'
import { createChainStore } from './store.ts'
import { createChainAgentsWith } from './agents.ts'
import { createDiscovery } from './discover.ts'
import { readSolana } from './solana.ts'
import { readEvm } from './evm.ts'

const secs = Number(process.argv[2] ?? 80)
const dataDir = mkdtempSync(join(tmpdir(), 'lusca-chain-live-'))
const log = (lvl: string, msg: string) => console.log(`[${lvl}] ${msg}`)
const rpc = createRpc({ dataDir, log })
const discovery = createDiscovery({ rpc, dataDir, log })
const store = createChainStore({ dataDir, log })
const agents = createChainAgentsWith({
  rpc,
  discovery,
  readSolana,
  readEvm,
  store,
  broadcast: (m) => {
    const e = m.event
    console.log(`  ${e.agent.padEnd(6)} ${e.chain.padEnd(8)} ${e.via.padEnd(8)} ${e.verdict.padEnd(11)} ${e.address.slice(0, 12)}… ${e.name ?? '—'} · ${e.reason}`)
  },
  log,
  pace: false,
  minGapMs: 4000,
  idleMs: 3000,
})
discovery.start()
agents.start()
await new Promise((r) => setTimeout(r, secs * 1000))
const t0 = Date.now()
const done = agents.stop()
await rpc.close()
await done
await discovery.stop()
await store.close()
const s = agents.stats()
console.log(`stopped in ${Date.now() - t0} ms`)
console.log(JSON.stringify({ reads: s.reads, kept: s.kept, rejected: s.rejected, frontier: s.frontier, budget: s.budget, agents: s.agents.map((a) => `${a.id}:${a.state}:${a.reads}/${a.kept}`) }, null, 1))
rmSync(dataDir, { recursive: true, force: true })
