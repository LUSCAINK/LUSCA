// CONTROL MAP: who can change the code of every program / contract the chain agents kept.
// Shared between server/control/** and the client (src/pages/Control.tsx).
//
//   immutable  the code cannot change (no upgrade authority, non-upgradeable loader, no proxy, EIP-1167 clone)
//   key        one key: a Solana authority that is an ed25519 point (a keypair), or an EVM account without code
//   pda        a Solana program-derived address (off the curve: only its program signs, e.g. a multisig or a DAO)
//   safe       an EVM Safe (getThreshold() / getOwners() answer)
//   timelock   an EVM TimelockController (getMinDelay() answers)
//   contract   another EVM contract (no Safe / timelock interface)
//   unknown    upgradeable, but the controller could not be identified from the slots and calls
//   pending    not resolved yet (EVM proxies are resolved in the background under a small daily budget)

import type { ChainId } from './chain.ts'

export const CONTROL_CLASSES = ['immutable', 'key', 'pda', 'safe', 'timelock', 'contract', 'unknown', 'pending'] as const
export type ControlClass = (typeof CONTROL_CLASSES)[number]

export type HopKind = 'program' | 'proxy' | 'clone' | 'beacon' | 'proxyadmin' | 'safe' | 'timelock' | 'eoa' | 'key' | 'pda' | 'contract' | 'none'

/** One link of the custody chain, from the code outwards. */
export interface ControlHop {
  kind: HopKind
  /** Address of this link (null for 'none'). */
  address: string | null
  /** Short factual label: 'EIP-1967 proxy', 'ProxyAdmin', 'Safe 3 of 5', 'Timelock 48h', 'single key', 'PDA'. */
  label: string
  /** How the next link was found: 'admin slot', 'owner()', 'upgrade authority', 'beacon slot'. */
  via?: string
  /** Safe: owners / threshold; timelock: delay in seconds. */
  threshold?: number
  owners?: number
  delay?: number
}

export interface ControlEntry {
  chain: ChainId
  address: string
  name: string | null
  cls: ControlClass
  hops: ControlHop[]
  /** What decided the class, in one line (factual). */
  basis: string
  /** When resolved (ms); 0 while pending. */
  at: number
  /** RPC calls spent on this entry (0 for Solana: from stored reads). */
  calls: number
}

export interface ControlController {
  chain: ChainId
  address: string
  label: string
  cls: ControlClass
  /** How many kept programs / contracts this one address can change. */
  count: number
}

export interface ControlSummary {
  total: number
  resolved: number
  pending: number
  byChain: Record<string, Partial<Record<ControlClass, number>>>
  byClass: Partial<Record<ControlClass, number>>
  /** Addresses that control the most kept programs / contracts (≥ 2). */
  topControllers: ControlController[]
  /** The control resolver's daily slice (EVM calls), by chain. */
  budget: Record<string, { used: number; limit: number }>
  updatedAt: number
}

export interface ControlPage {
  items: ControlEntry[]
  total: number
  next: string | null
}
// REST: GET /api/control/summary -> ControlSummary ; GET /api/control/items?chain=&class=&cursor=&limit= -> ControlPage ;
//       GET /api/control/:chain/:address -> ControlEntry | 404   (stored results only; no RPC per request)
