// CODE ATLAS wire types (server/atlas). Every field comes from stored reads; no RPC.
import type { ChainId } from './chain.ts'

export const ATLAS_CHAINS: ChainId[] = ['solana', 'ethereum', 'base', 'arbitrum']

/** GET /api/atlas — columnar; x / y quantized to 0..10000; c = index into chains; k = cluster id (-1: none). */
export interface AtlasMap {
  v: number
  builtAt: number
  n: number
  chains: ChainId[]
  byChain: Record<string, number>
  clusters: { id: number; label: string; n: number; x: number; y: number }[]
  x: number[]
  y: number[]
  c: number[]
  k: number[]
  name: string[]
  a: string[]
  /** 1 when the source is verified (Sourcify / OtterSec). */
  vf: number[]
  /** firstSeen, unix seconds. */
  t: number[]
  /** Index of the nearest neighbour when it shares ≥ 30 % of features (-1: none); drawn as faint links. */
  e: number[]
}

/** GET /api/atlas/item/:chain/:address */
export interface AtlasItem {
  chain: ChainId
  address: string
  name: string | null
  verifiedBy: 'osec' | 'sourcify' | null
  cluster: number
  clusterLabel: string | null
  functions: number
  events: number
  sample: string[]
  relatives: { chain: ChainId; address: string; name: string | null; similarity: number; shared: number; onlyHere: string[]; onlyThere: string[] }[]
}
