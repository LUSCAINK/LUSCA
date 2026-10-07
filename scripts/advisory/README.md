# Advisory check data

The advisory check (`server/advisory`) matches the stored verified Solidity sources of every kept EVM contract
against three vendored, compact data files in `server/advisory/data/`. Each file records its own sources and the
date it was generated. Nothing downloaded is executed: tarballs and JSON are read as data only.

| File | What it holds | Source | Regenerate |
| --- | --- | --- | --- |
| `oz-fingerprints.json` | sha256 (first 128 bits, after BOM removal and CRLF/CR → LF) of every `.sol` file of every published version of `@openzeppelin/contracts` and `@openzeppelin/contracts-upgradeable`, deduplicated: hash → (package, path, release header, versions) | npm registry metadata + tarballs, each checked against the registry's sha512 `integrity` | `npx tsx scripts/advisory/build-fingerprints.ts` |
| `oz-advisories.json` | Every published OpenZeppelin Contracts advisory (GHSA, CVE, severity, affected ranges, fixed versions) mapped by hand to the package file(s) that define the affected contract, with a reference link per mapping | osv.dev (`ecosystem: npm`), api.github.com/advisories, the OpenZeppelin repositories' security advisories | reviewed by hand; `npx tsx scripts/advisory/check-advisories.ts` compares it with osv.dev and the fingerprints (exit 1 on any difference) |
| `solc-bugs.json` | Every known Solidity compiler bug (name, summary, severity, conditions, link) and the bugs of every released solc version | `ethereum/solidity` `docs/bugs.json` and `docs/bugs_by_version.json` (develop branch) | `npx tsx scripts/advisory/build-solc-bugs.ts` |

## Matching rules

- **Byte-identical copy.** A contract source file whose normalized hash equals a fingerprinted release file.
- **Affected copy.** A fingerprinted copy counts for an advisory only when every published release that ships that
  exact copy at the mapped path is inside the advisory's affected range (prereleases of the first affected version
  aside). A copy that also ships in a fixed release is never counted, so a match means the fix changed that file.
  `-solc-0.7` builds are compared as their base version.
- **Header.** A file that is not a published copy but whose `// OpenZeppelin Contracts (last updated vX.Y.Z) (path)`
  header names a release counts only when every release carrying that header for that file is affected; the
  evidence says `header` so it is never confused with an identical copy. In a flattened source (several OpenZeppelin
  files in one), flatteners do not always keep a header next to its code, so a header there counts only when the
  advisory's anchor (the affected function or contract) lies between that header and the next one.
- **Compiler.** The exact solc version from the verified metadata → that version's listed bugs. Bug conditions
  (optimizer, via-IR, EVM version, code patterns) are shown and never evaluated.

A match shows that code from an affected release is present; whether it is reachable or exploitable depends on how
the contract uses it.

Generated on 2026-10-06/07: 184 published versions (104 + 80), 23,171 `.sol` files, 6,988 distinct; 23 advisories;
66 compiler bugs over 121 solc versions.
