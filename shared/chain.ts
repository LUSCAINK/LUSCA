// Chain agents: on-chain programs (Solana) and contracts (Ethereum, Base, Arbitrum) found by the
// agents themselves (block sampling, verified-source registries, the web corpus, links), read over
// RPC, evaluated (kept / rejected with a reason) and stored as SEPIA-1 training data.
// Shared between server/chain/** and the client.

export type ChainId = 'solana' | 'ethereum' | 'base' | 'arbitrum'
export type ReadKind = 'program' | 'contract' | 'token-mint' | 'account' | 'empty'
export type Verdict = 'kept' | 'duplicate' | 'boilerplate' | 'unverified' | 'token-mint' | 'not-code' | 'error'
export type FoundVia = 'block' | 'registry' | 'web' | 'link'
export interface SourceFileInfo { path: string; lang: string; bytes: number }
export interface IdlSummary { name: string | null; version: string | null; instructions: { name: string; args: number; accounts: number }[]; accounts: string[]; types: number; errors: number; events: number }
export interface ChainRead { chain: ChainId; address: string; kind: ReadKind; name: string | null; codeHash: string | null;
  upgradeable: boolean | null; upgradeAuthority: string | null; lastDeploySlot: number | null; programBytes: number | null; loader: string | null;
  idl: IdlSummary | null; securityTxt: Record<string, string> | null;
  bytecodeBytes: number | null; proxy: { standard: 'eip1967' | 'eip1822' | 'beacon' | 'eip1167' | 'other'; implementation: string } | null;
  abi: { functions: string[]; events: string[] } | null;
  verified: { by: 'osec' | 'sourcify'; match: 'full' | 'partial' | null; repo: string | null; commit: string | null; compiler: string | null } | null;
  sources: SourceFileInfo[]; notes: string[]; readAt: number; rpcCalls: number }
export interface ChainEvent { id: string; ts: number; agent: string; chain: ChainId; address: string; name: string | null; kind: ReadKind; via: FoundVia; verdict: Verdict; reason: string; idl: boolean; verifiedBy: 'osec' | 'sourcify' | null; sourceFiles: number; sourceBytes: number }
export interface ChainAgentInfo { id: string; chain: ChainId; state: 'reading' | 'idle' | 'waiting-budget' | 'error'; current: string | null; reads: number; kept: number; lastAt: number | null }
export interface ChainIndexItem { chain: ChainId; address: string; name: string | null; kind: ReadKind; via: FoundVia; verifiedBy: 'osec' | 'sourcify' | null; idl: boolean; sourceFiles: number; sourceBytes: number; codeHash: string | null; firstSeen: number; readAt: number }
export interface ChainStats { agents: ChainAgentInfo[]; reads: number; kept: number; rejected: Record<string, number>; programs: number; contracts: number; idls: number; verified: number; sourceBytes: number; byChain: Record<string, { reads: number; kept: number }>; frontier: Record<string, number>; budget: Record<string, { used: number; limit: number }>; updatedAt: number }
// REST: GET /api/chain/stats -> ChainStats ; GET /api/chain/feed?limit=N (≤ 200) -> ChainEvent[] ; GET /api/chain/items?chain=&limit=&cursor= -> { items: ChainIndexItem[]; next: string | null } ; GET /api/chain/item/:chain/:address -> { item: ChainIndexItem; read: ChainRead } | 404   (all from stored data — NO live RPC per user request)
// WS (shared/protocol.ts ServerMsg union gains): | { t: 'chain'; event: ChainEvent }   (broadcast, throttled ≤ 4/s)
