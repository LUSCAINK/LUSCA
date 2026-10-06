// Protocol code index — what SEPIA-1 will read: source files from an allowlist of public
// blockchain repositories (server/codebase). Served at GET /api/code/stats.
//
// No repository or file is left out because of its license. The license of every repository and
// every file is recorded (SPDX id from the LICENSE file, the file's SPDX header or the allowlist;
// "NOASSERTION" when a license file is not recognised, "none" when there is none) and sorted into a
// tier for display only.

/**
 * Display tier of a license (never used to exclude anything):
 * - 'permissive': MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Unlicense, CC0, Zlib, BSL-1.0, …
 * - 'copyleft': GPL / LGPL / AGPL (any version, -only / -or-later), MPL-2.0, EPL-2.0, EUPL-1.2, …
 * - 'source-available': published under a non-open license — BUSL-1.1, SSPL, Elastic-2.0, PolyForm,
 *   project licenses (Metaplex NFT, Orca, Aptos), "all rights reserved".
 * - 'unknown': NOASSERTION, none, UNLICENSED (no license granted), or an id that is not recognised.
 * For an SPDX expression, `A OR B` takes the more open side and `A AND B` the less open one.
 */
export type LicenseTier = 'permissive' | 'copyleft' | 'source-available' | 'unknown'

export interface CodeRepoInfo {
  /** owner/name on GitHub. */
  repo: string
  /** evm | solana | move | cairo | cosmos | bitcoin | infra */
  ecosystem: string
  /** dex | lending | stablecoin | staking | bridge-rollup | account-abstraction | wallet | token-standard | oracle | governance | client-vm | framework | security */
  category: string
  /** Branch the archive is taken from. */
  ref: string
  /** Commit of the indexed archive (null until fetched). */
  commit: string | null
  /**
   * SPDX expression of the repository license: what the LICENSE file at the indexed commit says once
   * fetched (the allowlist entry before that); "NOASSERTION" / "none" when unknown.
   */
  license: string
  tier: LicenseTier
  /** Files kept from this repository (after filters and cross-repo dedupe). */
  files: number
  /** UTF-8 text bytes of those files (uncompressed). */
  bytes: number
  /** When the indexed archive was fetched (ms), null if never. */
  fetchedAt: number | null
  /**
   * ok = indexed · pending = queued (note 'collecting' while it is being fetched) · skipped = not
   * indexed, note says why ('cap' = total size cap reached, archive too large, not found / not public,
   * license or README forbids machine-learning use) · error = last attempt failed, retried later.
   */
  status: 'ok' | 'pending' | 'skipped' | 'error'
  note?: string
}

export interface CodeIndexStats {
  /** Every allowlisted repository, in allowlist order. */
  repos: CodeRepoInfo[]
  /** Totals over repositories with status 'ok'. */
  files: number
  bytes: number
  /** Text bytes per language (solidity, rust, move, …) over 'ok' repositories. */
  byLang: Record<string, number>
  /** Text bytes per ecosystem over 'ok' repositories. */
  byEcosystem: Record<string, number>
  /** Last change to the index (ms), null before the first one. */
  updatedAt: number | null
}

// GET /api/code/stats -> CodeIndexStats
