// EVM block sampling: which contracts a block's transactions call, from eth_getBlockByNumber(tag, true).
//
//   - a transaction with calldata (input ≠ '0x') and a 'to' is a call: 'to' is counted. Plain value
//     transfers (no calldata) usually go to wallets, so they are skipped; whether a counted address
//     really holds code is only known once it is read.
//   - share of calls whose selector is an ERC-20 / ERC-721 transfer or approval: addresses called
//     mostly that way are token contracts, which discovery down-weights (token templates are rejected
//     as boilerplate later anyway).
//   - a transaction with to = null deploys a contract at keccak256(rlp([from, nonce]))[12:]; that
//     address is computed locally (no receipt needed).
//   - precompiles / chain system addresses (≥ 15 leading zero bytes, e.g. ArbOS 0x…a4b05) are skipped.

import { createAddress, isEvmAddress, toChecksumAddress } from './keccak.ts'

/** transfer, approve, transferFrom, permit, increaseAllowance, ERC-721 safeTransferFrom ×2, setApprovalForAll */
export const TOKEN_SELECTORS: ReadonlySet<string> = new Set(['a9059cbb', '095ea7b3', '23b872dd', 'd505accf', '39509351', '42842e0e', 'b88d4fde', 'a22cb465'])

/** 0x00000000000000000000000000000000000000xx-style system / precompile addresses. */
export const isSystemAddress = (lower: string): boolean => /^0x0{30}/.test(lower)

export interface EvmBlockActivity {
  number: number | null
  timestamp: number | null
  txs: number
  /** called contracts (lowercase address → calls in this block, calls with a token selector) */
  calls: Map<string, { txs: number; token: number }>
  /** contracts deployed by top-level creation transactions (checksummed) */
  creations: string[]
  /** value transfers without calldata (not counted) */
  plain: number
  skippedSystem: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

function hexNum(v: unknown): number | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(v)) return null
  const n = Number.parseInt(v.slice(2), 16)
  return Number.isSafeInteger(n) ? n : null
}

export function parseEvmBlock(block: unknown): EvmBlockActivity {
  const out: EvmBlockActivity = { number: null, timestamp: null, txs: 0, calls: new Map(), creations: [], plain: 0, skippedSystem: 0 }
  if (!isObj(block)) return out
  out.number = hexNum(block.number)
  out.timestamp = hexNum(block.timestamp)
  const txs = Array.isArray(block.transactions) ? block.transactions : []
  for (const t of txs) {
    if (!isObj(t)) continue // hashes only (fullTx = false): nothing to learn
    out.txs++
    const input = typeof t.input === 'string' ? t.input : typeof t.data === 'string' ? t.data : '0x'
    const to = t.to
    if (to === null || to === undefined || to === '') {
      // contract creation
      if (isEvmAddress(t.from) && typeof t.nonce === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(t.nonce)) {
        try {
          out.creations.push(createAddress(t.from, BigInt(t.nonce)))
        } catch {
          /* malformed: skip */
        }
      }
      continue
    }
    if (!isEvmAddress(to)) continue
    const lower = to.toLowerCase()
    if (isSystemAddress(lower)) {
      out.skippedSystem++
      continue
    }
    if (input.length < 10) {
      out.plain++
      continue
    }
    const sel = input.slice(2, 10).toLowerCase()
    const cur = out.calls.get(lower)
    const tok = TOKEN_SELECTORS.has(sel) ? 1 : 0
    if (cur) {
      cur.txs++
      cur.token += tok
    } else out.calls.set(lower, { txs: 1, token: tok })
  }
  return out
}

/** Checksummed form for a lowercase key (display / reader input). */
export const displayEvm = (lower: string): string => toChecksumAddress(lower)
