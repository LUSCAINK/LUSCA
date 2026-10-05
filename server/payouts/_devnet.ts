// Devnet rehearsal of one live payout period with throwaway keys (never mainnet).
//   npx tsx server/payouts/_devnet.ts [dataDir]
// Generates a treasury and 3 recipients, airdrops devnet SOL to the treasury (backoff ≤ 2 min),
// closes one live period through the engine against https://api.devnet.solana.com, checks the
// recipients' balances and prints devnet Solscan links. The throwaway secret is never printed.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import type { PayoutLedger, PeriodSnapshotRow } from '../contracts.ts'
import { resolvePayoutConfig } from './config.ts'
import { createPayouts } from './index.ts'
import { periodIdFor, periodStart } from './plan.ts'

const RPC = 'https://api.devnet.solana.com'
const conn = new Connection(RPC, 'confirmed')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`
const solscanAccount = (a: string) => `https://solscan.io/account/${a}?cluster=devnet`

const treasury = Keypair.generate()
const recipients = [Keypair.generate(), Keypair.generate(), Keypair.generate()].map((k) => k.publicKey.toBase58())
const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'lusca-devnet-'))

async function airdrop(): Promise<boolean> {
  const deadline = Date.now() + 120_000
  let wait = 3_000
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    try {
      const sig = await conn.requestAirdrop(treasury.publicKey, 1 * LAMPORTS_PER_SOL)
      console.log(`airdrop requested (attempt ${attempt}): ${solscanTx(sig)}`)
      while (Date.now() < deadline) {
        if ((await conn.getBalance(treasury.publicKey)) > 0) return true
        await sleep(2_000)
      }
    } catch (e) {
      console.log(`airdrop attempt ${attempt} failed: ${(e as Error).message.slice(0, 160)}`)
    }
    await sleep(Math.min(wait, Math.max(0, deadline - Date.now())))
    wait = Math.min(wait * 2, 40_000)
  }
  return false
}

console.log(`treasury ${solscanAccount(treasury.publicKey.toBase58())}`)
if (!(await airdrop())) {
  console.log('RESULT: devnet airdrop unavailable (rate-limited) within 2 min — period not run')
  process.exit(2)
}
const startBal = await conn.getBalance(treasury.publicKey)
console.log(`treasury balance ${startBal / LAMPORTS_PER_SOL} SOL`)

// Minimal in-memory ledger: 3 verified wallets with 10 / 20 / 30 INK this period.
const period = new Map<string, number>(recipients.map((w, i) => [w, 10 * (i + 1)]))
const config = resolvePayoutConfig({
  LUSCA_PAYOUTS: 'live',
  LUSCA_SOLANA_RPC: RPC,
  LUSCA_TREASURY_SECRET: JSON.stringify(Array.from(treasury.secretKey)),
  LUSCA_PAYOUT_EVERY_H: '0.01',
})
let last: { id: string; endsAt: number } | null = (() => {
  const prev = periodStart(Date.now(), config.everyMs) - config.everyMs
  return { id: periodIdFor(prev - config.everyMs), endsAt: prev }
})()
const ledger: PayoutLedger = {
  periodSnapshot: (): PeriodSnapshotRow[] => [...period].filter(([, v]) => v > 0).map(([wallet, ink]) => ({ wallet, ink })),
  closePeriod(id, endsAt, plan) {
    const snap = this.periodSnapshot()
    const carry = plan(snap)
    period.clear()
    for (const [w, v] of Object.entries(carry)) period.set(w, v)
    last = { id, endsAt }
    return snap
  },
  reconcileClose: () => false,
  carryBack: (w, ink) => void period.set(w, (period.get(w) ?? 0) + ink),
  lastClosed: () => last,
  lifetimeInk: (w) => (recipients.includes(w) ? 10 * (recipients.indexOf(w) + 1) : 0),
  periodInk: (w) => period.get(w) ?? 0,
  isVerified: (w) => recipients.includes(w),
}

const engine = createPayouts({
  ledger,
  dataDir,
  config,
  log: (l, m) => console.log(`[${l}] ${m}`),
  onUpdate: () => {},
  pollMs: 1_500,
})
const t0 = Date.now()
await engine.tick()
const o = engine.overview()
const rec = o.history[0]
console.log(`period ${rec?.id} status ${rec?.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s, pool ${rec?.poolSol} SOL, txs ${rec?.txs.length}`)
for (const sig of rec?.txs ?? []) console.log(`tx ${solscanTx(sig)}`)
let ok = rec?.status === 'done'
for (const w of recipients) {
  const want = engine.wallet(w).history[0]
  const bal = await conn.getBalance(new PublicKey(w), 'confirmed')
  const match = want && Math.round(want.sol * LAMPORTS_PER_SOL) === bal
  ok = ok && !!match
  console.log(`${match ? 'ok  ' : 'BAD '} ${w}: expected ${want?.sol} SOL, on-chain ${bal / LAMPORTS_PER_SOL} SOL — ${solscanAccount(w)}`)
}
console.log(`treasury after: ${(await conn.getBalance(treasury.publicKey)) / LAMPORTS_PER_SOL} SOL`)
console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'} (period files in ${dataDir})`)
await engine.stop()
process.exit(ok ? 0 : 1)
