// ADVISORY CHECK: every kept EVM contract's stored Solidity sources checked against every published OpenZeppelin
// Contracts security advisory (byte-identical release files or the release header) and the known bugs of its exact
// solc version. Shared between server/advisory/** and the client.
//
// REST: GET /api/advisories/summary -> AdvisorySummary
//       GET /api/advisories/items?advisory=<GHSA id>|bug=<solc bug name>&chain=&cursor=&limit=<1-50> -> AdvisoryList
//       GET /api/advisories/:chain/:address -> AdvisoryItem | 404
import type { ChainId } from './chain.ts'

export type AdvisorySeverity = 'critical' | 'high' | 'moderate' | 'low'
export type MatchMethod = 'hash' | 'header'

/** Wording required wherever a match is shown (page and API). */
export const ADVISORY_SCOPE =
  'A match shows that code from an affected OpenZeppelin release is present in the contract\'s verified source. Whether it is reachable or exploitable depends on how the contract uses it.'
/** The release file on GitHub (tag v<release>), at a line. Byte-identical copies have the same line numbers. */
export function releaseFileUrl(pkg: string, release: string, pkgPath: string, line?: number): string {
  const repo = pkg === '@openzeppelin/contracts-upgradeable' ? 'openzeppelin-contracts-upgradeable' : 'openzeppelin-contracts'
  return `https://github.com/OpenZeppelin/${repo}/blob/v${release}/contracts/${pkgPath}${line && line > 1 ? `#L${line}` : ''}`
}

export const COMPILER_SCOPE =
  'Known bugs of the exact compiler version the contract was verified with, from the Solidity team\'s list. Each bug only applies under its listed conditions (optimizer, via-IR, EVM version, specific code patterns); they are listed, not checked.'

export interface AdvisoryRange { introduced: string; fixed?: string | null; lastAffected?: string | null }

/** One published advisory as LUSCA mapped it to package files. */
export interface AdvisoryInfo {
  id: string
  aliases: string[]
  severity: AdvisorySeverity
  title: string
  url: string
  note?: string
  packages: { name: string; ranges: AdvisoryRange[]; label: string; fixedIn: string[]; files: { path: string; evidence: string; ref: string; label?: string; copies: number }[] }[]
}

/** One file of a kept contract that is a copy of an affected release file. */
export interface AdvisoryEvidence {
  /** Path of the file inside the contract's verified source. */
  path: string
  /** 1-based line of the advisory's named function / contract in that file (1 when not found). */
  line: number
  symbol: string | null
  /** The package and path of the release file it matches. */
  pkg: string
  pkgPath: string
  /** hash: byte-identical (line endings aside) to the file in these releases; header: its "OpenZeppelin Contracts (last updated vX)" header names an affected release of this file, content differs. */
  method: MatchMethod
  /** Releases that ship this exact copy (hash) or this header (header), e.g. "4.7.0 – 4.7.2 (3 releases)". */
  releases: string
  header: string | null
  /** One release that ships this exact copy (the newest; hash) or the header's own release (header): the file at that tag on GitHub has the same line. */
  release: string | null
}

export interface ItemAdvisory { id: string; severity: AdvisorySeverity; files: AdvisoryEvidence[] }

export interface SolcBug { name: string; uid: string; summary: string; severity: string; link: string | null; introduced: string | null; fixed: string | null; conditions: Record<string, unknown> }

export interface AdvisoryItem {
  chain: ChainId
  address: string
  name: string | null
  checkedAt: number
  /** .sol files checked. */
  files: number
  /** Files byte-identical to a published OpenZeppelin release file. */
  ozFiles: number
  /** Releases consistent with every byte-identical OpenZeppelin file, per package (null label when they disagree). */
  ozReleases: { pkg: string; label: string | null; files: number }[]
  advisories: (ItemAdvisory & { title: string; url: string; aliases: string[]; label: string })[]
  solc: { version: string; compiler: string; released: string | null; bugs: SolcBug[] } | null
  /** Why something was not checked (no stored source, Vyper, unknown compiler …). */
  notes: string[]
  scope: string
  compilerScope: string
}

export interface AdvisoryListItem {
  chain: ChainId
  address: string
  name: string | null
  /** Evidence for the requested advisory (empty for a compiler-bug list). */
  files: AdvisoryEvidence[]
  solc: string | null
  advisories: number
}

export interface AdvisoryList { items: AdvisoryListItem[]; next: string | null; total: number; scope: string }

export interface AdvisorySummary {
  updatedAt: number
  /** Background progress: items checked of items to check. */
  progress: { done: number; total: number; running: boolean }
  /** EVM contracts with stored Solidity source that were checked. */
  checked: number
  notChecked: { noSource: number; vyper: number; solana: number }
  byChain: Record<string, number>
  /** Contracts with at least one file byte-identical to a published OpenZeppelin release file. */
  withOz: number
  ozFiles: number
  /** Contracts with at least one file from an affected release (any advisory, any method). */
  withAdvisoryFile: number
  advisories: (AdvisoryInfo & { contracts: number; byMethod: { hash: number; header: number } })[]
  topReleases: { pkg: string; label: string; contracts: number }[]
  compiler: {
    known: number
    withBugs: number
    bySeverity: Record<string, number>
    bugs: { name: string; severity: string; summary: string; link: string | null; conditions: Record<string, unknown>; contracts: number }[]
    versions: { version: string; contracts: number }[]
  }
  data: { ozVersions: number; ozUniqueFiles: number; fingerprintsAt: string; advisoriesReviewedAt: string; solcBugs: number; solcBugsAt: string; packages: string[] }
  scope: string
  compilerScope: string
}
