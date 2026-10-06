// LUSCA Lens: one address in, one deterministic report out. Every fact in a report was read
// on-chain (RPC) or from a named registry (Sourcify, OtterSec) or from LUSCA's own stores (code
// index, chain index) during the read, and carries the link it came from. Nothing is inferred by a
// language model; nothing is filled in when it could not be read.
// Shared between server/lens/** and the client (src/pages/Lens.tsx).

import type { ChainId, ReadKind, Verdict } from './chain.ts'

export type LensChain = ChainId

/** A citation: where a fact can be checked. */
export interface LensCite {
  label: string
  url: string
}

export interface LensIdlAccount {
  name: string
  signer: boolean
  writable: boolean
  optional: boolean
}
export interface LensIdlInstruction {
  name: string
  docs: string | null
  accounts: LensIdlAccount[]
  args: { name: string; type: string }[]
}
export interface LensIdl {
  /** 'Anchor IDL account' | 'program-metadata IDL' */
  source: string
  format: 'anchor-legacy' | 'anchor' | 'codama' | null
  name: string | null
  version: string | null
  instructions: LensIdlInstruction[]
  accounts: string[]
  types: number
  errors: { code: number | null; name: string; msg: string | null }[]
  events: string[]
}

export type PrimitiveGroup = 'hash' | 'signature' | 'curve' | 'zk' | 'other'

/** A cryptographic / hash primitive the code uses, with the evidence. */
export interface LensPrimitive {
  name: string
  group: PrimitiveGroup
  /** How it was seen: an ELF syscall import, a hashed syscall id in a call instruction, a native program id in the binary, a source line. */
  via: 'syscall-import' | 'syscall-id' | 'program-id' | 'source'
  /** Source citations (EVM): file:line. */
  at: { file: string; line: number }[]
  /** Total occurrences (source) — `at` lists the first few. */
  count: number
}

export interface LensSolana {
  loader: string | null
  upgradeable: boolean | null
  upgradeAuthority: string | null
  programDataAddress: string | null
  programBytes: number | null
  lastDeploySlot: number | null
  codeHash: string | null
  securityTxt: Record<string, string> | null
  idl: LensIdl | null
  osec: { verified: boolean; repo: string | null; commit: string | null } | null
  /** Every syscall the program imports (names), for the curious. */
  syscalls: string[]
  /** Signer accounts with an authority-like name, per instruction (from the IDL). */
  signerRoles: { instruction: string; account: string }[]
}

export interface LensPrivileged {
  /** ABI signature 'setFee(uint256)' (the first one when overloaded). */
  fn: string
  /** What guards it: 'onlyOwner', 'onlyRole(DEFAULT_ADMIN_ROLE)', 'require(msg.sender == admin)'. */
  guard: string
  file: string
  line: number
}

export interface LensContract {
  address: string
  name: string | null
  bytecodeBytes: number | null
  codeHash: string | null
  verified: { match: 'full' | 'partial'; compiler: string | null } | null
  deployBlock: number | null
  sources: { path: string; lang: string; bytes: number }[]
  functions: { write: string[]; payable: string[]; view: string[] }
  events: string[]
  privileged: LensPrivileged[]
  primitives: LensPrimitive[]
  /** custom / library / interface lines and the boilerplate verdict of the source profile */
  profile: { customLines: number; libraryLines: number; interfaceLines: number; boilerplate: string | null } | null
}

export interface LensEvm {
  chainId: number
  bytecodeBytes: number | null
  codeHash: string | null
  proxy: {
    standard: 'eip1967' | 'eip1822' | 'beacon' | 'eip1167' | 'other'
    label: string
    implementation: string
    admin: string | null
  } | null
  /** The proxy itself (or the contract when it is not a proxy). */
  self: LensContract
  /** The implementation behind a proxy, read the same way; null when not a proxy or not read. */
  implementation: LensContract | null
}

/** A verified source file that is byte-identical (or identical after comment/whitespace removal) to a file of LUSCA's code index. */
export interface LensProvenanceMatch {
  file: string
  repo: string
  commit: string | null
  path: string
  exact: boolean
  /** Contract the file belongs to: 'proxy' | 'implementation' | 'self'. */
  of: 'self' | 'implementation'
}

export interface LensProvenance {
  /** Files compared against the code index. */
  checked: number
  matches: LensProvenanceMatch[]
  /** OtterSec verified-build repository (Solana), and whether LUSCA's code index holds that repository. */
  osecRepo: { repo: string; commit: string | null; inCodeIndex: boolean; indexCommit: string | null } | null
  /** Code index state at the time of the read: repositories / files hashed; 0 means "not connected yet". */
  index: { repos: number; files: number; builtAt: number | null }
}

export interface LensDataset {
  /** The address judged: the implementation behind a proxy (that is the code), else the address read. */
  address: string
  /** What the chain index holds for this address before the read. */
  before: { verdict: Verdict; reason: string; at: number | null; via: string | null } | null
  /** The verdict the SEPIA-1 rules give this read (same function the chain agents use). */
  verdict: Verdict
  reason: string
  /** True when this read was handed to the chain store (a new kept item, discovery source 'lens'). */
  added: boolean
}

export interface LensSummary {
  verified: 'osec' | 'sourcify-full' | 'sourcify-partial' | null
  upgradeable: boolean | null
  /** Who can change the code: upgrade authority (Solana) or proxy admin (EVM), when read. */
  authority: string | null
  proxy: string | null
  /** Instructions (Solana IDL) or ABI functions (EVM, the implementation's when proxied). */
  surface: number | null
  privileged: number | null
  primitives: number
  provenance: number
}

export interface LensReport {
  v: 1
  chain: LensChain
  address: string
  kind: ReadKind
  name: string | null
  readAt: number
  ms: number
  rpcCalls: number
  registryCalls: number
  summary: LensSummary
  solana: LensSolana | null
  evm: LensEvm | null
  primitives: LensPrimitive[]
  provenance: LensProvenance
  dataset: LensDataset
  notes: string[]
  cites: LensCite[]
}

/** One row of the public "recent reads" strip. */
export interface LensRecent {
  chain: LensChain
  address: string
  name: string | null
  kind: ReadKind
  verified: LensSummary['verified']
  at: number
}

/** GET /api/lens/:chain/:address answer (cached: true when served from the cache). */
export interface LensAnswer {
  report: LensReport
  cached: boolean
  /** ms epoch when the cached copy expires */
  fresh: number
}

/** GET /api/lens/detect/:address answer. */
export interface LensDetect {
  address: string
  chains: { chain: LensChain; code: boolean | null; bytes: number | null }[]
}

export interface LensStatus {
  budget: Record<string, { used: number; limit: number }>
  inFlight: number
  cached: number
  index: LensProvenance['index']
}

export const LENS_CHAINS: readonly LensChain[] = ['solana', 'ethereum', 'base', 'arbitrum']
