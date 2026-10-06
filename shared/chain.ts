// Chain agents: on-chain programs (Solana) and contracts (Ethereum, Base, Arbitrum) found by the
// agents themselves (block sampling, verified-source registries, the web corpus, links), read over
// RPC, evaluated (kept / rejected with a reason) and stored as SEPIA-1 training data.
// Shared between server/chain/** and the client.

export type ChainId = 'solana' | 'ethereum' | 'base' | 'arbitrum'
export type ReadKind = 'program' | 'contract' | 'token-mint' | 'account' | 'empty'
export type Verdict = 'kept' | 'duplicate' | 'boilerplate' | 'unverified' | 'token-mint' | 'not-code' | 'error'
export type FoundVia = 'block' | 'registry' | 'web' | 'link' | 'lens'
export interface SourceFileInfo { path: string; lang: string; bytes: number }
export interface IdlSummary { name: string | null; version: string | null; instructions: { name: string; args: number; accounts: number }[]; accounts: string[]; types: number; errors: number; events: number }
export interface ChainRead { chain: ChainId; address: string; kind: ReadKind; name: string | null; codeHash: string | null;
  upgradeable: boolean | null; upgradeAuthority: string | null; lastDeploySlot: number | null; programBytes: number | null; loader: string | null;
  idl: IdlSummary | null; securityTxt: Record<string, string> | null;
  bytecodeBytes: number | null; proxy: { standard: 'eip1967' | 'eip1822' | 'beacon' | 'eip1167' | 'other'; implementation: string } | null;
  abi: { functions: string[]; events: string[] } | null;
  verified: { by: 'osec' | 'sourcify'; match: 'full' | 'partial' | null; repo: string | null; commit: string | null; compiler: string | null } | null;
  sources: SourceFileInfo[]; notes: string[]; readAt: number; rpcCalls: number }
export interface ChainEvent { id: string; ts: number; agent: string; chain: ChainId; address: string; name: string | null; kind: ReadKind; via: FoundVia; verdict: Verdict; reason: string; idl: boolean; verifiedBy: 'osec' | 'sourcify' | null; sourceFiles: number; sourceBytes: number
  /** The calls this read made, in the order they started (agent reads only; absent on older events and Lens reads). */
  trace?: ScanCall[]
  /** What the read decoded, enough to draw it without another request (agent reads only). */
  scan?: ScanDoc }
/**
 * One network call of a read, as the agent made it: the method, what it asked for, who answered, when
 * (ms after the read's first call) and how long it took, and a short result. No URLs, no keys.
 */
export interface ScanCall { kind: 'rpc' | 'registry'; method: string; target: string; provider: string; t: number; ms: number; ok: boolean; result: string
  /** ms the call waited for its turn in LUSCA's own pacing (in-flight limit, spacing, cool-down) before the request went out; `ms` is the request alone. */
  wait?: number }
/** Decoded fields of one read (capped lists; `more` counts what was left out). Unknown fields are absent. */
export interface ScanDoc {
  /** Calls left out of `trace` (over its cap). */
  traceMore?: number
  loader?: string; upgradeable?: boolean; authority?: string; deploySlot?: number; programBytes?: number; codeHash?: string; bytecodeBytes?: number
  /** EVM: a compiler metadata trailer was found and left out of codeHash (false: the bytecode has none). */
  trailer?: boolean
  /** security.txt name / project url (Solana). */
  project?: { name?: string; url?: string }
  proxy?: { standard: string; implementation: string; admin?: string }
  verified?: { by: 'osec' | 'sourcify'; match?: 'full' | 'partial'; compiler?: string; repo?: string; commit?: string }
  files?: { paths: string[]; more: number }
  idl?: { source?: string; names: string[]; more: number; accounts: number; errors: number; events: number }
  abi?: { names: string[]; more: number; events: number }
  privileged?: { items: { fn: string; guard: string; at: string }[]; more: number }
  primitives?: string[]
  /** Up to a few of the read's own notes (immutable, verified build checked …). */
  notes?: string[]
}
export interface ChainAgentInfo { id: string; chain: ChainId; state: 'reading' | 'idle' | 'waiting-budget' | 'error'; current: string | null; reads: number; kept: number; lastAt: number | null }
export interface ChainIndexItem { chain: ChainId; address: string; name: string | null; kind: ReadKind; via: FoundVia; verifiedBy: 'osec' | 'sourcify' | null; idl: boolean; sourceFiles: number; sourceBytes: number; codeHash: string | null; firstSeen: number; readAt: number }
export interface ChainStats { agents: ChainAgentInfo[]; reads: number; kept: number; rejected: Record<string, number>; programs: number; contracts: number; idls: number; verified: number; sourceBytes: number; byChain: Record<string, { reads: number; kept: number }>; frontier: Record<string, number>; budget: Record<string, { used: number; limit: number }>; updatedAt: number
  /** Who answers each chain's reads, by name ('Helius', 'PublicNode' …); never a URL. */
  providers?: Partial<Record<ChainId, string>> }
// REST: GET /api/chain/stats -> ChainStats ; GET /api/chain/feed?limit=N (≤ 200) -> ChainEvent[] ; GET /api/chain/items?chain=&limit=&cursor= -> { items: ChainIndexItem[]; next: string | null } ; GET /api/chain/item/:chain/:address -> { item: ChainIndexItem; read: ChainRead } | 404   (all from stored data — NO live RPC per user request)
// WS (shared/protocol.ts ServerMsg union gains): | { t: 'chain'; event: ChainEvent }   (broadcast, throttled ≤ 4/s)
