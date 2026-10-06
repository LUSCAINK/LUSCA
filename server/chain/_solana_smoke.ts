// Live smoke of the Solana reader (frugal: one RPC call per address on the public endpoint).
//   npx tsx server/chain/_solana_smoke.ts [address…]
import { createRpc } from './rpc.ts'
import { readSolana } from './solana.ts'

const DEFAULT = [
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH',
  'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]
const addrs = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT
const rpc = createRpc({ solanaRpc: process.env.LUSCA_SOLANA_RPC, log: (l, m) => console.error(`[${l}] ${m}`) })
for (const a of addrs) {
  const t = Date.now()
  try {
    const { read, idlJson } = await readSolana(a, rpc)
    const { idl, securityTxt, ...rest } = read
    console.log(JSON.stringify({ ms: Date.now() - t, ...rest, idl: idl && { ...idl, instructions: `${idl.instructions.length} (e.g. ${idl.instructions.slice(0, 3).map((i) => `${i.name}/${i.args}a/${i.accounts}acc`).join(', ')})`, accounts: idl.accounts.length }, securityTxt, idlJsonBytes: idlJson ? JSON.stringify(idlJson).length : 0 }, null, 1))
  } catch (e) {
    console.log(a, 'ERROR', (e as Error).name, (e as Error).message)
  }
}
console.log('usage', JSON.stringify(rpc.usage()))
await rpc.close()
