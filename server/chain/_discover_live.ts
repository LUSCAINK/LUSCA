// Frugal live check of chain discovery against the real public endpoints (not part of npm test):
//   1 Solana block (getSlot + getBlock on the public mainnet RPC), 1 latest block per EVM chain
//   (publicnode), 1 Sourcify list page per EVM chain, 1 OtterSec list page. ~9 requests in total.
//   npx tsx server/chain/_discover_live.ts
// Uses a temporary data dir and an in-memory budget (the server's budget.json is not touched).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRpc } from './rpc.ts'
import { createDiscovery, EVM_CHAINS } from './discover.ts'
import { SOLANA_NATIVE } from './discover/solblock.ts'

const dataDir = mkdtempSync(join(tmpdir(), 'lusca-discover-live-'))
const log = (lvl: string, msg: string) => console.log(`[${lvl}] ${msg}`)
const rpc = createRpc({ log }) // public endpoints only: LUSCA_* RPC env vars are not read here
const d = createDiscovery({ rpc, dataDir, log, config: { corpus: false, osecPages: 1, sourcifyPages: 1 } })

try {
  const sol = await d.run.solana()
  if (sol) {
    console.log(`\nSolana slot ${sol.slot}: ${sol.txs} tx, ${sol.txsWithLoaded} with lookup-table accounts, ${sol.instructions} instructions, ${sol.programs.size} programs (+ ${sol.natives.size} native)`)
    for (const [p, v] of [...sol.programs].sort((a, b) => b[1].txs - a[1].txs).slice(0, 12)) console.log(`  ${String(v.txs).padStart(4)} tx  ${p}`)
    console.log('  natives:', [...sol.natives].sort((a, b) => b[1].txs - a[1].txs).map(([p, v]) => `${SOLANA_NATIVE.get(p) ?? p} ${v.txs}`).join(', '))
  }
  for (const chain of EVM_CHAINS) {
    const act = await d.run.evm(chain)
    if (!act) continue
    console.log(`\n${chain} block ${act.number}: ${act.txs} tx, ${act.calls.size} called contracts, ${act.plain} plain transfers, ${act.creations.length} creations, ${act.skippedSystem} system`)
    for (const [a, v] of [...act.calls].sort((x, y) => y[1].txs - x[1].txs).slice(0, 8)) console.log(`  ${String(v.txs).padStart(4)} tx  ${a}${v.token / v.txs > 0.6 ? '  (token transfers)' : ''}`)
    for (const c of act.creations) console.log(`  created ${c}`)
  }
  await d.run.registries()
  const s = d.stats()
  console.log(`\nregistries: Sourcify rows ${s['registry.sourcify'] ?? 0}, OtterSec programs ${s['registry.osec'] ?? 0}`)
  console.log('frontier:', { solana: s.solana, ethereum: s.ethereum, base: s.base, arbitrum: s.arbitrum }, 'found', { block: s['found.block'], registry: s['found.registry'] })
  for (const chain of ['solana', ...EVM_CHAINS] as const) {
    const top = [d.next(chain), d.next(chain), d.next(chain)].filter(Boolean)
    console.log(`  next(${chain}):`, top.map((c) => `${c!.address} ${c!.via} ${c!.score} — ${c!.hint}`))
  }
  console.log('\nbudget used:', Object.fromEntries(Object.entries(rpc.usage()).filter(([, v]) => v.used > 0).map(([k, v]) => [k, v.used])))
} finally {
  await rpc.close()
  await d.stop()
  rmSync(dataDir, { recursive: true, force: true })
}
