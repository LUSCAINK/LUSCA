// Solana block sampling: which programs a block's transactions invoke.
//
// Input is a getBlock result with transactionDetails 'full' in the default 'json' encoding. Every
// instruction (top-level and inner / CPI) names its program by an index into the transaction's
// account list, which is
//     message.accountKeys ‖ meta.loadedAddresses.writable ‖ meta.loadedAddresses.readonly
// (the loaded addresses come from address lookup tables of v0 messages; legacy and v1 messages have
// none). 'jsonParsed' blocks (programId given directly, accountKeys as objects) are read as well.
//
// Activity = number of transactions in the block that invoke the program (each transaction counted
// once per program however many instructions it has), plus the raw instruction count. Native and
// SPL core programs are counted separately and never become candidates.

import { isSolanaAddress } from '../../../shared/base58.ts'

/** Builtin / native programs, SPL core programs and sysvars: counted, never scored as discoveries. */
export const SOLANA_NATIVE: ReadonlyMap<string, string> = new Map([
  ['11111111111111111111111111111111', 'System'],
  ['Vote111111111111111111111111111111111111111', 'Vote'],
  ['Stake11111111111111111111111111111111111111', 'Stake'],
  ['Config1111111111111111111111111111111111111', 'Config'],
  ['ComputeBudget111111111111111111111111111111', 'Compute Budget'],
  ['AddressLookupTab1e1111111111111111111111111', 'Address Lookup Table'],
  ['BPFLoader1111111111111111111111111111111111', 'BPF Loader (deprecated)'],
  ['BPFLoader2111111111111111111111111111111111', 'BPF Loader 2'],
  ['BPFLoaderUpgradeab1e11111111111111111111111', 'BPF Upgradeable Loader'],
  ['LoaderV411111111111111111111111111111111111', 'Loader v4'],
  ['NativeLoader1111111111111111111111111111111', 'Native Loader'],
  ['Ed25519SigVerify111111111111111111111111111', 'Ed25519 precompile'],
  ['KeccakSecp256k11111111111111111111111111111', 'Secp256k1 precompile'],
  ['Secp256r1SigVerify1111111111111111111111111', 'Secp256r1 precompile'],
  ['Feature111111111111111111111111111111111111', 'Feature Gate'],
  ['ZkTokenProof1111111111111111111111111111111', 'ZK Token Proof'],
  ['ZkE1Gama1Proof11111111111111111111111111111', 'ZK ElGamal Proof'],
  ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'SPL Token'],
  ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'SPL Token-2022'],
  ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'SPL Associated Token Account'],
  ['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'SPL Memo'],
  ['Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', 'SPL Memo (v1)'],
])

/** Native program, SPL core program or sysvar (sysvar ids all start with "Sysvar"). */
export const isSolanaNative = (addr: string): boolean => SOLANA_NATIVE.has(addr) || addr.startsWith('Sysvar')

export interface SolanaBlockActivity {
  slot: number | null
  blockTime: number | null
  /** transactions in the block */
  txs: number
  /** transactions whose account list included lookup-table addresses (v0) */
  txsWithLoaded: number
  /** instructions seen (top-level + inner) */
  instructions: number
  /** non-native programs: transactions invoking them and their instruction count */
  programs: Map<string, { txs: number; ix: number }>
  /** native / SPL core programs (same counts) */
  natives: Map<string, { txs: number; ix: number }>
  /** instructions whose program index could not be resolved */
  unresolved: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Account list of one transaction (json: strings; jsonParsed: { pubkey } objects, loaded addresses inline). */
function accountList(message: Obj, meta: Obj | null): string[] {
  const raw = Array.isArray(message.accountKeys) ? message.accountKeys : []
  const keys: string[] = []
  let parsed = false
  for (const k of raw) {
    if (typeof k === 'string') keys.push(k)
    else if (isObj(k) && typeof k.pubkey === 'string') {
      keys.push(k.pubkey)
      parsed = true
    } else keys.push('')
  }
  // In jsonParsed blocks the lookup-table addresses are already part of accountKeys.
  if (!parsed && meta && isObj(meta.loadedAddresses)) {
    keys.push(...strArr(meta.loadedAddresses.writable), ...strArr(meta.loadedAddresses.readonly))
  }
  return keys
}

function programOf(ix: unknown, keys: string[]): string | null {
  if (!isObj(ix)) return null
  if (typeof ix.programId === 'string') return ix.programId // jsonParsed
  const i = ix.programIdIndex
  if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < keys.length) return keys[i] || null
  return null
}

/** Count the programs invoked by a getBlock result. Malformed transactions are skipped, never fatal. */
export function parseSolanaBlock(block: unknown, slot: number | null = null): SolanaBlockActivity {
  const out: SolanaBlockActivity = {
    slot,
    blockTime: null,
    txs: 0,
    txsWithLoaded: 0,
    instructions: 0,
    programs: new Map(),
    natives: new Map(),
    unresolved: 0,
  }
  if (!isObj(block)) return out
  if (typeof block.blockTime === 'number') out.blockTime = block.blockTime
  const txs = Array.isArray(block.transactions) ? block.transactions : []
  for (const t of txs) {
    if (!isObj(t) || !isObj(t.transaction) || !isObj(t.transaction.message)) continue
    out.txs++
    const message = t.transaction.message
    const meta = isObj(t.meta) ? t.meta : null
    const keys = accountList(message, meta)
    if (meta && isObj(meta.loadedAddresses)) {
      const n = strArr(meta.loadedAddresses.writable).length + strArr(meta.loadedAddresses.readonly).length
      if (n > 0) out.txsWithLoaded++
    }
    const perTx = new Map<string, number>()
    const see = (ix: unknown) => {
      out.instructions++
      const p = programOf(ix, keys)
      if (!p) {
        out.unresolved++
        return
      }
      perTx.set(p, (perTx.get(p) ?? 0) + 1)
    }
    if (Array.isArray(message.instructions)) for (const ix of message.instructions) see(ix)
    if (meta && Array.isArray(meta.innerInstructions)) {
      for (const g of meta.innerInstructions) {
        if (isObj(g) && Array.isArray(g.instructions)) for (const ix of g.instructions) see(ix)
      }
    }
    for (const [p, n] of perTx) {
      if (!isSolanaAddress(p)) {
        out.unresolved += n
        continue
      }
      const m = isSolanaNative(p) ? out.natives : out.programs
      const cur = m.get(p)
      if (cur) {
        cur.txs++
        cur.ix += n
      } else m.set(p, { txs: 1, ix: n })
    }
  }
  return out
}

/** Version needed from an RPC "Transaction version (N) is not supported" error (-32015), or null. */
export function requiredTxVersion(message: string): number | null {
  const m = /maxSupportedTransactionVersion\\?"?\s*:\s*(\d{1,3})/.exec(message) ?? /Transaction version \((\d{1,3})\)/.exec(message)
  if (!m) return null
  const v = Number(m[1])
  return Number.isInteger(v) && v >= 0 && v < 256 ? v : null
}
