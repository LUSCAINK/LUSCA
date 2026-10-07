// CODE SEARCH: grep over every verified source file and Solana IDL the chain agents kept.
// Shared between server/search/** and the client (src/pages/Search.tsx).
//
// REST: GET /api/search?q=&re=1&case=1&chain=&custom=1&path=&lang=&cursor= -> SearchResult
//       GET /api/search/file?id= -> { file: SearchFileRefs }
//       GET /api/search/source?id=&q=&re=&case= -> { source: SearchSourceFile; marks: SearchLine-like matches; moreMarks }
//       GET /api/search/stats -> SearchStats
import type { ChainId } from './chain.ts'

export type SearchLang = 'solidity' | 'vyper' | 'yul' | 'other'
export const SEARCH_LANGS: readonly SearchLang[] = ['solidity', 'vyper', 'yul', 'other']

export interface SearchQuery {
  /** The text to find (literal unless `re`). 2 … 200 characters. */
  q: string
  /** Treat `q` as a JavaScript regular expression (no backreferences, no nested quantifiers). */
  re?: boolean
  /** Case-sensitive (default: case-insensitive). */
  case?: boolean
  /** Only contracts / programs on this chain ('solana' searches IDLs only). */
  chain?: ChainId | null
  /** Only custom code: leave out library paths (@openzeppelin, forge-std, solmate, lib/, node_modules/ …) and files also in the protocol code index. */
  custom?: boolean
  /** Path filter: plain text = substring of the path; with * ? = glob on the path (a pattern without / also matches the file name). */
  path?: string | null
  lang?: SearchLang | null
  /** Paging cursor from a previous SearchResult.next. */
  cursor?: string | null
}

/** One kept program / contract, as results name it. */
export interface SearchItem { chain: ChainId; address: string; name: string | null }

export interface SearchLine {
  /** 1-based line number. */
  n: number
  text: string
  /** Character ranges [start, end) of the match on this line (empty for context lines). */
  hits: [number, number][]
}

export interface SearchFileHit {
  /** Index id of the unique file (stable within one index generation). */
  id: number
  /** Path as the primary contract names the file. */
  path: string
  lang: SearchLang
  /** Total lines of the file. */
  lines: number
  /** Matching lines in this file (all of them, not only the shown ones). */
  matches: number
  /** Snippet blocks: matching lines with up to 2 lines of context, merged when they touch. */
  blocks: SearchLine[][]
  /** Matching lines not shown in `blocks`. */
  moreMatches: number
  /** How many kept contracts include this exact file (content hash), and on which chains. */
  shared: { contracts: number; chains: Partial<Record<ChainId, number>> }
  /** Library path (@openzeppelin, lib/, node_modules/ …): custom=1 leaves it out. */
  library: boolean
  /** The same file (sha256) is in the protocol code index (GitHub repositories): custom=1 leaves it out. */
  codeIndex: boolean
  /** Other contracts that include this exact file (up to 8; shared.contracts is the total). */
  alsoIn: (SearchItem & { path: string })[]
}

export interface SearchGroup {
  item: SearchItem
  files: SearchFileHit[]
}

export interface SearchIdlHit {
  item: SearchItem
  /** Same IDL (content hash) in this many kept programs. */
  sharedPrograms: number
  /** Matching IDL entries, e.g. { kind: 'instruction', text: 'initialize_pool(args 3, accounts 12)' }. */
  entries: { kind: string; text: string; hits: [number, number][] }[]
  moreEntries: number
}

export interface SearchResult {
  q: string
  re: boolean
  case: boolean
  /** Honest totals over the whole index (capped at `capped`). */
  total: {
    /** Matching lines summed over unique files (a shared file counts once). */
    matches: number
    /** Unique files with a match. */
    files: number
    /** Kept contracts that include at least one matching file. */
    contracts: number
    chains: Partial<Record<ChainId, number>>
    /** Solana programs with a matching IDL entry. */
    programs: number
    /** True when counting stopped at the match cap: the totals are lower bounds. */
    capped: boolean
  }
  /** What the trigram prefilter left to scan. */
  scanned: { files: number; bytes: number; ofFiles: number; ofBytes: number }
  groups: SearchGroup[]
  idl: SearchIdlHit[]
  /** Cursor for the next page of file results, or null. */
  next: string | null
  /** Index generation the result was computed on. */
  gen: number
  ms: number
  cached: boolean
  /** Set when the query could not run: invalid / refused regex, time budget exceeded, index not ready. */
  error: { code: 'invalid' | 'refused' | 'timeout' | 'busy' | 'not-ready'; message: string } | null
}

/** Every kept contract that includes one unique file (GET /api/search/file?id=). */
export interface SearchFileRefs {
  id: number
  lines: number
  bytes: number
  contracts: number
  chains: Partial<Record<ChainId, number>>
  /** At most 500, by chain then name; `more` counts the rest. */
  list: (SearchItem & { path: string })[]
  more: number
}

/** One unique file's text (GET /api/search/source?id=), cut at 600 000 characters. */
export interface SearchSourceFile {
  id: number
  path: string
  lang: SearchLang
  lines: number
  bytes: number
  /** The contract the file is listed under; `contracts` kept contracts include it. */
  item: SearchItem
  contracts: number
  library: boolean
  codeIndex: boolean
  text: string
  truncated: boolean
}

export interface SearchTopFile { id: number; path: string; contracts: number; chains: Partial<Record<ChainId, number>>; lines: number; library: boolean; codeIndex: boolean; sample: SearchItem | null }

export interface SearchStats {
  ready: boolean
  /** 'loading' (snapshot), 'building' (reading the chain store), 'ready', 'off'. */
  state: 'loading' | 'building' | 'ready' | 'off'
  /** Kept EVM contracts with source files in the index. */
  contracts: number
  /** Solana programs with an IDL in the index. */
  programs: number
  /** Source file references (a library file in 400 contracts counts 400 times). */
  fileRefs: number
  /** Unique files after deduplication by content hash. */
  uniqueFiles: number
  /** Lines of the unique files. */
  lines: number
  /** Bytes of the unique files (what a search scans at most). */
  bytes: number
  /** Bytes the same files take before deduplication. */
  rawBytes: number
  /** Index snapshot on disk (gzip), bytes. */
  diskBytes: number
  /** Shared memory holding the unique files and their trigram signatures, bytes. */
  sharedBytes: number
  /** Resident memory of the server process, bytes (index included). */
  rss: number
  byChain: Partial<Record<ChainId, number>>
  /** The files shared by the most kept contracts. */
  top: SearchTopFile[]
  /** Kept items not indexed and why (cap reached …), or null. */
  partial: string | null
  builtAt: number | null
  gen: number
}
