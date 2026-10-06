# SEPIA-1 data: audit findings and exploit data

Research notes for SEPIA-1, the model after SEPIA-0. SEPIA-1 should read real blockchain protocol
code. These notes cover the second half of that goal: sources where experts explain what is wrong
with a piece of code (audit findings, exploit reproductions, advisories, security guides). They
also propose a held-out evaluation set.

Checked on 2026-10-05. The rows that are code repositories on the code-index allowlist (#19
not-so-smart-contracts, #20 building-secure-contracts, #24 DeFiHackLabs, #29 sealevel-attacks, #36
Ethernaut, #37 Damn Vulnerable DeFi) are ingested by `server/codebase` while the server runs; nothing
else listed here has been ingested yet. Each license record comes from the
GitHub REST API (`license.spdx_id`, repository size, archive flag), the LICENSE file at the
repository root, per-file `SPDX-License-Identifier` headers (sampled), the copyright notices inside
sampled report PDFs (`pdftotext`), and the terms pages quoted below. Sizes are as of that date.
Licenses change, so the ingest code records them again when it fetches.

**License policy (owner decision, 2026-10-05).** "We are learning from the data, not copying it."
Sources are not excluded by license: permissive, copyleft, source-available (BUSL, non-commercial)
and unlicensed material are all used for training. The license, and any notice or terms, is
recorded for every source and every file, and the list goes into the model card. A source is
excluded only when it is not public, when its license, README or terms explicitly forbid
machine-learning or AI training (the reason is recorded), or when it is out of scope on quality
(memecoins, token clones, beginner contracts). This version of the notes applies that policy. The
first version, written before the decision, held unlicensed and restricted sources back pending
permission; those verdicts are replaced below.

---

## 1. Findings

1. **One contest platform explicitly forbids training and evaluation.** Code4rena's Terms of
   Service (effective 2025-01-07), §8(h), prohibit using "any C4 Content, or any Submissions to
   train, fine-tune, evaluate, or otherwise improve any machine-learning [...] model" without a
   separate written agreement. §8(h)(ii) also covers "embeddings, feature vectors, or other derived
   datasets". This is an explicit ML prohibition, so Code4rena reports and findings repositories
   stay excluded, and so does the Code4rena-derived text inside Web3Bugs (`reports/`), ScaBench and
   EVMbench. Sherlock and Cantina publish no license for findings text and no ML prohibition; their
   public repositories are used, with their terms recorded (§4.1).
2. **Most audit-firm report repositories have no license.** Zellic, Cyfrin, Sigma Prime, Sherlock,
   Spearbit, Halborn, Pashov and Anza (`security-audits`) publish their PDFs on GitHub without a
   LICENSE file. Some PDFs carry their own notice: Trail of Bits reports say "Material within this
   report may not be reproduced or distributed in part or in whole without Trail of Bits' express
   written permission", and every page of OtterSec's reports says "All Rights Reserved". Neither
   notice mentions machine learning. Under the license policy these reports are used for training,
   with the license recorded (`none` where there is no LICENSE file) and the notice stored with each
   record. With Trail of Bits (item 3) they hold more than 1,400 report PDFs (§5.3), by far the
   largest body of expert blockchain reasoning on this list.
3. **Trail of Bits: repository license vs. report notice.** `trailofbits/publications` is
   CC-BY-SA-4.0 at the root, but the sampled review PDF reserves all rights (quoted in §4.2). Both
   are recorded for every review PDF; the PDFs are used.
4. **DeFiHackLabs: repository license vs. file headers.** The repository is Apache-2.0, but 44 of
   52 sampled exploit files declare `SPDX-License-Identifier: UNLICENSED`. One declares MIT and 7
   had no readable header. Each file's own header is recorded and the exploit code is used. Of 692
   incident entries in the README files, only 62 state a loss of at least $1M in USD and 191 state
   less than $100K. Many are small BSC token contracts, which this project does not want. Use a
   filtered subset of both the index and the PoCs (§5.2).
5. **Security text without the reports is small; the reports are not.** Guides, specifications,
   wargames, the DeFiHackLabs index and PoCs, and blockchain advisories from OSV come to about
   8–15 MB across all tiers (§5.1). The permissive part is 4–6 MB: MIT/Apache vulnerability guides,
   the EEA EthTrust v3 specification (Apache-2.0), OpenZeppelin's own audits inside the MIT
   `openzeppelin-contracts` repository, and OSV, which holds GitHub advisories (CC-BY-4.0), Go
   advisories (CC-BY-4.0) and RustSec (CC0-1.0), most with a fix commit. Copyleft adds about
   1.6 MB (Trail of Bits `building-secure-contracts` and Ethernaut, both AGPL-3.0 repositories). The audit-report
   repositories add an estimated 60–140 MB of text once converted (§5.3), still a supplement to
   the code index rather than a volume source.
6. **Evaluation does not need anyone else's report text.** The evaluation set in §6 uses code at
   pinned commits (license recorded), factual labels written by LUSCA maintainers (file, function,
   class, one-line description), and CC-BY/CC0 advisory text with attribution. Because reports now
   enter training, any report that describes an evaluation item is kept out of training (§6.6).
7. **The existing web corpus.** The Security sector in `shared/sectors.ts` seeds
   `https://rekt.news/`, whose terms say "All content on this site is protected by copyright and may
   not be reproduced without the express permission of Rekt News". Its host rules also accept
   `openzeppelin.com` and any host matching `/security|audit/`, which includes
   `audits.sherlock.xyz`. None of these terms explicitly forbids ML training, so under the license
   policy they stay, with the terms recorded per host. The same explicit-prohibition rule applies to
   the web corpus as to repositories: `code4rena.com` is not seeded and does not match the host
   rule, but an explicit block keeps it out. The web dataset must also be checked for held-out
   evaluation material before SEPIA-1 trains on it (§6.6).

---

## 2. Verdicts and license tiers

| Verdict | Meaning |
|---|---|
| **train** | Goes into the SEPIA-1 training stream. The tier is recorded; it does not gate anything. |
| **eval** | Used to build held-out evaluation items. Kept out of training. |
| **reference** | Read for method or metadata only (titles, dates, commits, links), because the text adds little (link lists, harnesses) or the material is out of scope. |
| **exclude** | Not used: the source explicitly forbids ML training, is not public, or is out of scope on quality. The reason is recorded. |

The code index sorts licenses into four tiers (`LicenseTier` in `shared/codebase.ts`). Text
licenses (documents, advisories, reports) use the same tiers:

| License or terms | Tier | Used for training |
|---|---|---|
| MIT, Apache-2.0, BSD, ISC, 0BSD, Unlicense, CC0-1.0 | permissive | yes |
| CC-BY-4.0 | permissive, with attribution stored on every record (source URL) | yes |
| GPL/LGPL/AGPL, MPL-2.0, CC-BY-SA-4.0 | copyleft | yes |
| BUSL-1.1, CC-BY-NC, CC-BY-NC-SA, custom project licenses and terms (Metaplex, Orca, Aptos, Meteora), "all rights reserved" notices, other licenses with use restrictions | source-available | yes |
| No license (`none`), `UNLICENSED`, a license text that is not recognised (`NOASSERTION`) | unknown (recorded with the notice text) | yes |
| A license, README or terms that explicitly forbid ML/AI training | — | no; excluded with the reason |

For a public repository with no license, GitHub's Terms of Service §D.5 give other users a license
"to use, display, perform and reproduce (by forking) Your Content through the Service as permitted
by GitHub's functionality". The owner's position is that training learns from the data rather
than copying it. The training shards are copies of the text, so they stay private: they go only to
neurons, by short-lived URL, and are never published (SEPIA-1.md §3.6, §4.3).

---

## 3. Summary table

Size is the GitHub repository size unless stated otherwise. "Text" means measured bytes of text
files (from the git tree, excluding `lib/`, `node_modules/` and build output).

| # | Source | Owner | License / terms (verified) | Format | Size | Verdict |
|---|---|---|---|---|---|---|
| 1 | Code4rena reports and `code-423n4/*-findings` repos | Code4rena | ToS §8(g) bars automated collection, §8(h) bars ML training **and evaluation**. Findings repos have no license. | GitHub issues, markdown, website | `code423n4.com` repo 676 MB (deprecated); 1 findings repo ≈ 1 MB | **exclude** (explicit ML prohibition; only a written agreement with C4 would change this) |
| 2 | Sherlock reports (`sherlock-protocol/sherlock-reports`) and judging repos (`sherlock-audit/*-judging`) | Sherlock | No license. ToS (2026-09-17): publication rights "governed by the applicable Engagement Agreement". | PDFs; judging README = full findings in markdown | 145 MB, 236 PDFs; one judging README 303 KB | **train** (unknown; terms recorded). Judging READMEs first |
| 3 | Cantina / Spearbit (`spearbit/portfolio`, `cantina.xyz/portfolio`) | Cantina | No license. Cantina terms (2025-09-19): use only "for the sole purpose of providing or receiving the Services". | PDFs, website | 16.6 MB repo; reports now link to cantina.xyz | **train** (unknown; terms recorded): the PDFs in the GitHub repository |
| 4 | CodeHawks / Solodit | Cyfrin | ToS not found (`solodit.cyfrin.io/terms` returns 404). Solodit aggregates C4, Sherlock and Cantina findings, whose rights stay with those platforms. | website, API | — | **exclude** the Code4rena-sourced findings; take the others from the platforms' own repositories (#2, #3) |
| 5 | Trail of Bits `publications` | Trail of Bits | Repo CC-BY-SA-4.0, **but** sampled review PDF: "All rights reserved [...] may not be reproduced or distributed". | PDFs | 983 MB; 457 review PDFs, 245 under "Blockchain Reviews" | **train** (repo license and PDF notice both recorded): the blockchain reviews |
| 6 | Zellic `publications` | Zellic | No license. Sampled PDF has no copyright notice. | PDFs (+ HTML at reports.zellic.io) | 128 MB, 386 PDFs | **train** (unknown) |
| 7 | Cyfrin `cyfrin-audit-reports` | Cyfrin | No license. Sampled PDF has no notice. | PDFs | 62 MB, 208 PDFs | **train** (unknown) |
| 8 | Sigma Prime `public-audits` | Sigma Prime | No license. PDF has a liability disclaimer only. README lists the target commit for each review. | PDFs | 75 MB, 147 PDFs | **train** (unknown); README is also **reference** (target commits) |
| 9 | Pashov Audit Group `audits` | Pashov | No license. | PDFs + markdown copies (`team/md/`) | 131 MB, 124 PDFs | **train** (unknown); prefer the markdown copies |
| 10 | Halborn `PublicReports` | Halborn | No license, no README. | PDFs | 716 MB | **train** (unknown), low priority: 716 MB of PDFs, converted off the Render box |
| 11 | Anza `security-audits` (Agave, SPL) | Anza (authors: OtterSec, Neodyme, others) | No license. OtterSec pages: "© 2026 Otter Audits LLC. All Rights Reserved." | PDFs | 105 MB, 78 PDFs | **train** (unknown; notice recorded); the table is also **reference** for evaluation targets |
| 12 | OtterSec (osec.io/audits), Neodyme (neodyme.io/reports) | OtterSec, Neodyme | OtterSec: all rights reserved (above). Neodyme: no license located. | PDFs on own sites | — | **train** (unknown; notice recorded); prefer the copies in public repositories (#11) |
| 13 | OpenZeppelin audits on openzeppelin.com | OpenZeppelin | ToS (2026-03-25): OZ "exclusively own all right, title and interest in and to the Services, Service Outputs". | blog / PDFs | — | **train** (terms recorded); the OZ-authored reports are also in #14 |
| 14 | `OpenZeppelin/openzeppelin-contracts/audits/` | OpenZeppelin | Repo MIT. 10 of 12 listed audits are by OpenZeppelin itself. The sampled v5.0 PDF has no restrictive notice. | PDFs + 1 markdown, with commit hashes | 12 reports; v5.0 report = 172 KB text | **train** (permissive) for OZ-authored reports, and the third-party ones with their authors recorded; **eval** anchor (time split) |
| 15 | Protocol repos that keep third-party audits (e.g. `ethereum-optimism/optimism/docs/security-reviews`, Solady, Morpho Blue `audits/`) | each protocol | Repo license (Optimism MIT, Solady MIT, Morpho Blue GPL-2.0-or-later), but the PDFs were written by third parties (Spearbit, Cantina, ToB, ...). | PDFs, commit-pinned tables | Optimism lists 30+ reviews with commits | **train** (repo license and PDF authors recorded); the commit tables are also **reference** |
| 16 | SWC Registry | SmartContractSecurity | MIT. README: "no longer actively maintained", no new entries since 2020. | markdown | 45 files, 244 KB | **train** (permissive, low weight: legacy) |
| 17 | EEA EthTrust Security Levels v3 (Mar 2025) | Enterprise Ethereum Alliance | "licensed by the Enterprise Ethereum Alliance, Inc. (EEA) under the terms of the Apache License, Version 2.0" | HTML spec | ≈ 400 KB HTML | **train** (permissive) |
| 18 | `kadenzipfel/smart-contract-vulnerabilities` | Kaden Zipfel | MIT | markdown | 81 files, 188 KB text | **train** (permissive) |
| 19 | `crytic/not-so-smart-contracts` | Trail of Bits | Apache-2.0 (archived 2023-02). Solidity files have no SPDX header, so the repo license applies. | Solidity + markdown | 45 files, 175 KB text | **train** (permissive) |
| 20 | `crytic/building-secure-contracts` | Trail of Bits | AGPL-3.0 | markdown + examples (EVM, Solana, Cosmos, Cairo, Substrate, Sui, TON, Algorand) | 210 files, 850 KB text | **train** (copyleft) |
| 21 | ConsenSys smart-contract-best-practices | ConsenSys Diligence | Moved to `ConsenSysDiligence/smart-contract-best-practices`. API license null, no root LICENSE. | markdown (mkdocs) | 4.4 MB | **train** (unknown) |
| 22 | OWASP Smart Contract Top 10 | OWASP | `LICENSE.md`: "CC-BY-NC-SA 4.0 International" | markdown | 5.1 MB | **train** (source-available: non-commercial license recorded; LUSCA pays contributors in SOL) |
| 23 | SCSVS (`ComposableSecurity/SCSVS`) | Composable Security | API license null, no root LICENSE found | markdown | 3.2 MB | **train** (unknown) |
| 24 | `SunWeb3Sec/DeFiHackLabs` | SunWeb3Sec | Repo Apache-2.0. Exploit files are mostly `SPDX: UNLICENSED` (44 of 52 sampled). | Foundry PoCs (875 `_exp.sol`, 5.0 MB) + README incident index (≈ 1.3 MB md) | 14.5 MB; "883 incidents included" | README index: **train**/**eval** (permissive, filtered). PoC code: **train** (per-file `UNLICENSED` recorded; same filter, §5.2) |
| 25 | `SunWeb3Sec/DeFiVulnLabs` | SunWeb3Sec | No license | Foundry examples, 48 bug types | 0.4 MB | **train** (unknown) |
| 26 | `pcaversaccio/reentrancy-attacks` | pcaversaccio | AGPL-3.0 | markdown incident list with links | 0.2 MB | **train** (copyleft, low value) |
| 27 | rekt.news | Rekt News | "may not be reproduced without the express permission of Rekt News" | website | — | **train** through the web corpus (terms recorded per host) |
| 28 | Immunefi `Web3-Security-Library`, `bugfix-reviews-pocs` | Immunefi | No license | link list; PoCs | 0.1 / 0.2 MB | library: **reference** (link list); PoCs: **train** (unknown) |
| 29 | `coral-xyz/sealevel-attacks` | Coral (Anchor) | No license anywhere in the 115-file tree | Anchor programs (insecure / secure / recommended) | 143 KB | **train** (unknown; high value for Solana) |
| 30 | Solana "Program Security" course (`solana-foundation/developer-content`) | Solana Foundation | Archived 2025-01-24, no license. solana.com course URLs redirect here (308). | markdown lessons with code | 58.8 MB repo | **train** (unknown): the Program Security lessons |
| 31 | `slowmist/solana-smart-contract-security-best-practices` | SlowMist | Apache-2.0 | markdown | 74 KB | **train** (permissive) |
| 32 | `Ackee-Blockchain/solana-common-attack-vectors` | Ackee | No license | Anchor examples | 0.1 MB | **train** (unknown) |
| 33 | `neodyme-labs/solana-ctf` (incl. Neodyme workshop) | Neodyme / various | No license. README: challenges "belong to the respective authors". | Rust CTF programs | 10 MB | **train** (unknown; the README's ownership note recorded) |
| 34 | `neodyme-labs/solana-security-txt`, `otter-sec/sol-ctf-framework` | Neodyme, OtterSec | Apache-2.0, BSD-3-Clause | tooling code | 0.1 / 15 MB | code index only (low value as reasoning text) |
| 35 | `sannykim/solsec` | sannykim | No license | link list | 0.3 MB | **reference** (use to find sources) |
| 36 | Ethernaut | OpenZeppelin | Repo AGPL-3.0. Level contracts carry `SPDX: MIT`. | 85 level contracts + 82 English descriptions | 1.08 MB text | **train** (each file's own id recorded: MIT for the level contracts, AGPL-3.0 for the rest) |
| 37 | Damn Vulnerable DeFi v4 | The Red Guild | MIT; 4/4 sampled files `SPDX: MIT` | 18 challenges (Solidity + Foundry tests); no solutions in repo | 232 KB Solidity, 19 KB md | **train** (permissive) |
| 38 | OSV advisories (GHSA, Go vuln DB, RustSec) | GitHub, Go team, RustSec | GHSA CC-BY-4.0, Go DB CC-BY-4.0, RustSec CC0-1.0 (+ CC-BY-4.0 for GHSA imports) | JSON, with affected versions and fix commits | Go `all.zip` 12.0 MB (9,491 records), crates.io 3.5 MB (2,892); ≈ 500 blockchain candidates before curation | **train** + **eval** (permissive, attribution) |
| 39 | Web3Bugs (`ZhangZhuoSJTU/Web3Bugs`) | Zhang et al. (ICSE 2023) | Repo MIT, but `reports/` "contains all the reports provided by code4rena". | contest code + C4 reports + bug labels | 149 MB | reports: **exclude** (Code4rena text, ToS §8(h)); labels: **exclude** (derived from Code4rena reports, §8(h)(ii)); contest code: code index under its own license |
| 40 | DAppSCAN (`InPlusLab/DAppSCAN`) | InPlusLab (SYSU) | No license. Bundles 608 third-party audit PDFs. | PDFs + Solidity (682 DApps) | 1.1 GB | **train** (unknown), low priority: 1.1 GB, mostly the same firms' reports as #5–#12; useful for report ↔ code pairs |
| 41 | SmartBugs Curated | SmartBugs | Apache-2.0; contracts annotated with `@source`, mostly Solidity 0.4 | Solidity with vulnerable-line tags | 156 files, 591 KB | **train** (permissive, low weight); not for eval (widely copied) |
| 42 | SC-Bench (`system-pclub/SC-Bench`) | system-pclub | No license | dataset | 43 MB | **reference** (license unknown and recorded; contents not reviewed for this note) |
| 43 | ScaBench | scabench-org | MIT code. Dataset = 31 C4/Cantina/Sherlock projects, 555 findings with descriptions. | JSON + scoring code | 7.3 MB | scoring method: **reference**; Code4rena findings: **exclude**; Cantina/Sherlock findings: **eval** candidates (kept out of training) |
| 44 | EVMbench | OpenAI + Paradigm | Apache-2.0 (UI repo; eval code in `openai/frontier-evals`). 117 vulnerabilities from 40 audits, mostly contests. | harness + tasks | 1.2 MB | **reference** |
| 45 | SCONE-bench (`anthropics/scone-bench`) | Anthropic | Apache-2.0. Tasks drawn from DeFiHackLabs incidents, run as agent exploits on forked chains. | harness | 0.1 MB | **reference** (agentic; out of scope for SEPIA-1) |

---

## 4. Notes by source group

### 4.1 Audit contest platforms

**Code4rena.** Terms of Service, effective 2025-01-07, §8:

> (h) No AI or Machine-Learning Training. Except as expressly authorized in a separate written
> agreement with C4 (or via C4 affiliate entities), you may not, and may not permit any third party
> to: (i) use the Services, any C4 Content, or any Submissions to train, fine-tune, evaluate, or
> otherwise improve any machine-learning, large-language, foundation, or similar
> artificial-intelligence model; (ii) create embeddings, feature vectors, or other derived datasets
> from the Services, any C4 Content, or any Submissions for use with such models; [...]

§8(e) defines C4 Content to include "audit reports" and the "selection and arrangement of
Submissions". §8(g) prohibits automated access, indexing and bulk download except through public
APIs C4 designates. The findings repositories (`code-423n4/YYYY-MM-<name>-findings`) are GitHub
issues with no license. A sampled one, `2024-03-revert-lend-findings`, points contributors to an
"Agreements & Disclosures" issue. The contest code repositories (`code-423n4/YYYY-MM-<name>`)
carry the sponsor's own license. That code is in scope for the code index like any other public
repository; the C4-written README and scoping text are not.

**Sherlock.** Terms of Service (last updated 2026-09-17): "Publication rights relating to security
findings, audit reports, contest results, benchmarks, vulnerabilities, or other engagement-specific
information will be governed by the applicable Engagement Agreement." There is no public license.
The `sherlock-reports` README says "All links to reports are provided with the permission of each
protocol team." Judging repositories are well structured for this purpose. For example,
`2024-08-sentiment-v2-judging` has a 303 KB README holding every valid issue in markdown (found by,
summary, root cause, PoC, mitigation). They have no license. Nothing here forbids ML training, so
under the license policy the public reports and judging repositories are used, with these terms
recorded.

**Cantina / Spearbit.** Cantina General Terms (2025-09-19) grant users a right to use the Platform
"for the sole purpose of providing or receiving the Services" and forbid users to "copy, create
derivative works, distribute, publish [...] the Platform". The `spearbit/portfolio` README says
"All reports herein are published with the consent of our clients", and its report links now point
to `cantina.xyz/portfolio/<id>`. The PDFs in the public repository are used, with the terms recorded.

**CodeHawks / Solodit (Cyfrin).** No terms page was found for Solodit (`/terms` returns 404).
Cyfrin advertises a Solodit API for building AI tools, but Solodit collects findings from Code4rena,
Sherlock, Cantina and others. Cyfrin cannot grant rights over that text that those platforms hold,
and the Code4rena part falls under the C4 prohibition above. Take Sherlock and Cantina findings
from their own repositories instead. CodeHawks "First Flight" contracts are bugged on purpose for
beginners and are not the protocol-quality code SEPIA-1 is meant to learn from (out of scope).

### 4.2 Audit-firm report repositories

**Trail of Bits** (`trailofbits/publications`, CC-BY-SA-4.0 at the root, 983 MB). The review
`reviews/2025-03-otim-smart-wallet-securityreview.pdf` says, under "Copyright and Distribution":

> All rights reserved. [...] Material within this report may not be reproduced or distributed in
> part or in whole without Trail of Bits' express written permission.

The README links 457 review PDFs, 245 of them under "Blockchain Reviews". This is the largest and
best-written corpus of expert blockchain reasoning on the list. The notice restricts reproduction
and distribution and does not mention machine learning, so under the license policy the blockchain
reviews are used, with the repository license and the PDF notice both recorded. The training
guides Trail of Bits publishes separately are used as well: `not-so-smart-contracts` (Apache-2.0,
archived) and `building-secure-contracts` (AGPL-3.0).

**OtterSec.** The footer of every page of the sampled Agave v4.2 assessment reads "© 2026 Otter
Audits LLC. All Rights Reserved." Used; the notice is recorded.

**Zellic, Cyfrin, Sigma Prime, Pashov, Sherlock, Halborn, Anza.** None has a LICENSE file. The
sampled PDFs from Zellic, Cyfrin, Sigma Prime, Sherlock, Pashov and Neodyme have no copyright line
at all. With no license, default copyright applies; under the license policy they are used, with
the license recorded as `none`. The README index tables (protocol, date, commit, severity counts)
are factual metadata and also serve to choose evaluation targets. Reports on those targets are
then kept out of training (§6.6).

**Sec3, Spearbit (direct), OpenZeppelin (website).** No public repository of Sec3 reports was
found. OpenZeppelin's website reports fall under its ToS ("exclusively own all right, title and
interest in and to the Services, Service Outputs"), which is recorded; the OZ-authored reports are
also in the MIT repository (§4.3).

### 4.3 Audits stored inside protocol repositories

Several protocols commit audit reports next to their code, with the audited commit recorded:

- `OpenZeppelin/openzeppelin-contracts/audits/README.md` lists 12 audits. Ten are by OpenZeppelin
  (v4.8 to v5.6, with commits `14f98db` to `68e4095`), plus LevelK (2018) and New Alchemy (2017,
  markdown). Formal verification reports by Certora sit in `fv/reports/`. The repo is MIT and owned
  by the same company that wrote the OZ audits, and the sampled v5.0 PDF has no restrictive notice.
  This is the cleanest permissive case. The third-party reports in this folder are used too, with
  their authors recorded.
- `ethereum-optimism/optimism/docs/security-reviews/README.md` lists more than 30 reviews (Trail of
  Bits, OpenZeppelin, Spearbit, Cantina, Sigma Prime, Sherlock, Runtime Verification and others),
  most with the exact commit and the release they shipped in. The repo is MIT, but the PDFs were
  written by third parties. Use the table as metadata and the PDF text for training, with the
  authors recorded.
- Solady (MIT) has an `audits/` folder. Morpho Blue (GPL-2.0-or-later, formerly BUSL-1.1) says "All
  audits are stored in the audits folder."

### 4.4 Vulnerability taxonomies and guides

- **SWC Registry** (MIT): 37 weakness classes with test cases. It is unmaintained and points
  readers to EthTrust. Use it with low weight and as a label vocabulary.
- **EEA EthTrust Security Levels v3** (Apache-2.0, March 2025): requirement-by-requirement
  Solidity security criteria, written with reviewers from OpenZeppelin, ChainSecurity, Diligence,
  Hacken and Coinspect. Good training text and a good classification vocabulary for §6.
- **kadenzipfel/smart-contract-vulnerabilities** (MIT): about 37 vulnerability pages with code and
  prevention notes.
- **not-so-smart-contracts** (Apache-2.0) and **building-secure-contracts** (AGPL-3.0, copyleft).
  The latter covers issue examples for Algorand, Cairo, Cosmos, Substrate, Solana, Sui and TON,
  which helps beyond EVM.
- **OWASP SC Top 10** (CC-BY-NC-SA, source-available tier), **ConsenSys best practices** and
  **SCSVS** (no license file, unknown tier) are used, with their licenses recorded.

### 4.5 Exploit reproductions and incidents

**DeFiHackLabs** has 883 incidents. Each README entry gives a date, a title that states the root
cause (for example "Aztec V1 - escapeHatch Proof-Forgery (permissionless RollupProcessor exit)"),
the loss, the `forge test` command and reference links. The README text is Apache-2.0. The PoC
files are mostly `SPDX-License-Identifier: UNLICENSED`, probably the Foundry template default.
Each file's header is recorded and the PoCs are used. Recent entries are dominated by small token
contracts on BSC (losses of a few thousand dollars), so filter both the index and the PoCs (§5.2).
The vulnerable contracts themselves are on-chain verified sources. They are used only when the
same code is in a GitHub repository on the code-index allowlist: bulk deployed contracts are mostly
clones, which SEPIA-1 does not learn from (SEPIA-1.md §1).

**SCONE-bench** (Apache-2.0) and **EVMbench** (Apache-2.0) are agent benchmarks: the model must
write a working exploit or patch against a forked chain. SEPIA-1 will not be able to do this. They
are listed as method references.

### 4.6 Solana

The most useful Solana teaching material has no license: `coral-xyz/sealevel-attacks`, the Solana
Foundation "Program Security" course, `Ackee-Blockchain/solana-common-attack-vectors` and the
Neodyme workshop inside `neodyme-labs/solana-ctf`. Under the license policy all four are used
(unknown tier), which is the biggest gain for Solana. Together with them:

- `slowmist/solana-smart-contract-security-best-practices` (Apache-2.0)
- the Solana chapter of `building-secure-contracts` (copyleft)
- Solana and Anchor advisories in OSV/RustSec (e.g. `anchor`, `solana_rbpf`, `spl-*` records)
- Anza's audit reports (OtterSec, Neodyme and others), and their table as metadata for choosing
  evaluation targets

### 4.7 Wargames

**Damn Vulnerable DeFi v4** (MIT, 18 challenges) and **Ethernaut** (AGPL-3.0, 85 levels) are
deliberately vulnerable code with prose descriptions of the challenges. They are useful for
training. They are poor for evaluation because write-ups of the solutions are everywhere on the web
and probably already in the web corpus.

### 4.8 Advisory databases (OSV)

OSV publishes one zip per ecosystem at
`https://osv-vulnerabilities.storage.googleapis.com/<ECOSYSTEM>/all.zip`, with per-source licenses
listed in its docs (GHSA CC-BY-4.0, Go DB CC-BY-4.0, RustSec CC0-1.0). The RustSec LICENSE says:
"You can copy, modify, distribute, and retransmit any information in this repository, even for
commercial purposes, without asking permission." A keyword pass over the 2026-10-05 exports found
about 281 Go and 228 crates.io records that look blockchain-related. Most matches were go-ethereum
(45), cosmos-sdk (25), cometbft (22), evmos (18), gnark (16), ibc-go (9), wasmd (10), btcd (6),
lnd (5) in Go, and ckb, zebra, cosmwasm, anchor, alloy, solana_rbpf in crates. The pass also
caught noise such as wasmtime (105). About 90% of matches reference a fix commit or version range.
A curated package allowlist should leave about 300 records (about 1.5 MB of JSON). Each record gives
an expert description plus the vulnerable and fixed code in an upstream repo. That code keeps its
own license, recorded by the code index at fetch time: go-ethereum is copyleft; cosmos-sdk, cometbft
and agave are permissive. Do not clone `github/advisory-database` (3.4 GB). Download the
per-ecosystem zips, filter them, and delete them.

### 4.9 Research datasets

**Web3Bugs** (MIT) is valuable mainly for its bug taxonomy, but its `reports/` folder is
Code4rena's text, and its labels are derived from it, so both stay out under the C4 prohibition.
**DAppSCAN** pairs 608 audit reports with the source of 682 DApps. It has no license and bundles
other firms' PDFs; it is used at low priority, mainly for report ↔ code pairs, after dedupe
against the firms' own repositories. **SmartBugs Curated**
(Apache-2.0) is small, legacy (Solidity 0.4) and copied everywhere: fine for training with low
weight, useless for evaluation. **ScaBench** (MIT) is a good model for evaluation method: it uses
time-sliced datasets "to prevent models from being trained on known results" and a scoring
algorithm that matches findings. Its findings text comes from contest platforms.

---

## 5. Recommended ingestion

### 5.1 Guides, wargames, incidents and advisories (all tiers)

| Source | Tier | Take | Approx. text |
|---|---|---|---|
| kadenzipfel/smart-contract-vulnerabilities | permissive | `vulnerabilities/*.md` | 188 KB |
| crytic/not-so-smart-contracts | permissive | all `.md` + `.sol` | 175 KB |
| SmartContractSecurity/SWC-registry | permissive | `entries/docs/*.md` | 244 KB |
| EEA EthTrust v3 | permissive | spec HTML converted to text | ≈ 300 KB |
| slowmist Solana best practices | permissive | `.md` | 74 KB |
| Damn Vulnerable DeFi v4 | permissive | `src/**/*.sol`, `test/**/*.t.sol`, challenge READMEs | ≈ 250 KB |
| SmartBugs Curated | permissive | `dataset/**/*.sol` (keep the `@vulnerable_at_lines` annotations) | 591 KB |
| DeFiHackLabs README index (filtered, §5.2) | permissive | incident entries | ≤ 1.3 MB |
| OSV blockchain advisories (curated allowlist) | permissive (CC-BY-4.0 / CC0) | `summary`, `details`, affected, fix refs, URL for attribution | ≈ 1.5 MB |
| openzeppelin-contracts `audits/` (OZ-authored) | permissive | PDF → text | ≈ 1 MB |
| crytic/building-secure-contracts | copyleft | `.md` + examples | 850 KB |
| Ethernaut | copyleft repo (level contracts MIT by header) | level contracts + English descriptions | ≈ 700 KB |
| pcaversaccio/reentrancy-attacks | copyleft | incident list | ≤ 0.2 MB |
| DeFiHackLabs PoCs (filtered, §5.2) | unknown (`UNLICENSED` headers) | `_exp.sol` of the kept incidents | ≈ 0.6–1.1 MB of 5.0 MB |
| coral-xyz/sealevel-attacks | unknown | all programs + READMEs | 143 KB |
| Ackee-Blockchain/solana-common-attack-vectors | unknown | all examples | ≈ 0.1 MB |
| SunWeb3Sec/DeFiVulnLabs | unknown | all examples | ≤ 0.4 MB |
| Immunefi bugfix-reviews-pocs | unknown | PoCs + write-ups | ≤ 0.2 MB |
| Solana Foundation "Program Security" course | unknown | the program-security lessons | not measured |
| ConsenSys smart-contract-best-practices | unknown | `.md` | not measured (repo 4.4 MB) |
| SCSVS | unknown | `.md` | not measured (repo 3.2 MB) |
| OWASP Smart Contract Top 10 | source-available (CC-BY-NC-SA) | `.md` | not measured (repo 5.1 MB) |

Total is about 8–15 MB. The permissive part is 4–6 MB and copyleft about 1.6 MB; the rest is
partly estimated from repository sizes, and filtering removes most of the DeFiHackLabs index and
PoCs. This fits the 2 GB disk easily. If it is stored apart from the code index, use one JSONL
record per document:
`{source, url, commit, path, license, tier, notice, kind: 'guide'|'challenge'|'incident'|'advisory'|'audit', text}`.
Repositories that are code rather than prose (not-so-smart-contracts, Damn Vulnerable DeFi, SWC
test cases, SmartBugs, sealevel-attacks, DeFiVulnLabs, `neodyme-labs/solana-ctf`) fit the code
index directly as `category: 'security'`, `ecosystem: 'evm'` (`'solana'` for the Solana ones).
They are candidates for the allowlist.

### 5.2 Filters

- **DeFiHackLabs.** Keep an incident, and its PoC, only if (a) the stated loss is at least $1M, or
  the vulnerable contract belongs to a protocol on the code-index allowlist (DEX, lending, bridge,
  rollup, staking, wallet, oracle), and (b) the root-cause title is not a token transfer-tax,
  reflection or self-burn bug in a standalone token. Expect roughly 100–200 entries out of 883.
- **No memecoin or clone code anywhere.** Drop ERC-20/SPL token contracts that have no protocol
  logic. Drop CodeHawks First Flight and similar beginner contracts. Drop audit reports whose scope
  is only a standalone token or launchpad token.
- **Legacy weight.** Down-weight Solidity `^0.4`/`^0.5` material (SWC, SmartBugs) so it does not
  dominate the security slice.
- **Evaluation items.** Drop any report, incident entry or advisory that describes an evaluation
  item (§6.6).
- **Explicit ML prohibitions.** Drop Code4rena text and anything derived from it (§4.1), wherever it
  appears (Solodit, Web3Bugs, ScaBench, EVMbench).
- **Records.** Every record keeps its license, tier and any notice or terms. Every CC-BY record also
  keeps its source URL, and the dataset README lists GHSA and Go DB as CC-BY-4.0 sources.

### 5.3 Audit-report repositories

| Repository | Reports | Repo size | Tier | Notes |
|---|---|---|---|---|
| `trailofbits/publications` | 245 blockchain reviews (of 457) | 983 MB | copyleft at the root (CC-BY-SA-4.0) | PDF notice "All rights reserved" recorded per report |
| `Zellic/publications` | 386 | 128 MB | unknown | HTML copies at reports.zellic.io |
| `Cyfrin/cyfrin-audit-reports` | 208 | 62 MB | unknown | |
| `sigp/public-audits` | 147 | 75 MB | unknown | README lists target commits |
| `pashov/audits` | 124 | 131 MB | unknown | use the markdown copies in `team/md/` |
| `sherlock-protocol/sherlock-reports` | 236 | 145 MB | unknown | plus `sherlock-audit/*-judging` READMEs (findings in markdown) |
| `spearbit/portfolio` | not counted | 16.6 MB | unknown | newer reports exist only on cantina.xyz |
| `anza-xyz/security-audits` | 78 | 105 MB | unknown | OtterSec notice recorded |
| `HalbornSecurity/PublicReports` | not counted | 716 MB | unknown | low priority |
| `ethereum-optimism/optimism` `docs/security-reviews` | 30+ | — | MIT repo | third-party authors recorded |
| `InPlusLab/DAppSCAN` | 608 | 1.1 GB | unknown | low priority; mostly duplicates of the rows above |

The seven firm repositories with a count hold 1,424 reports. Text volume is not measured yet: at
40–100 KB of text per report (the OpenZeppelin v5.0 report is 172 KB), that is ≈ 60–140 MB, ≈ 15–40M tokens.

- **Off the Render box.** The repositories total ≈ 2.4 GB without DAppSCAN, more than the server's
  disk. Fetch one at a time on another machine, convert PDF → text (`pdftotext`), keep the text and
  delete the PDFs.
- **One JSONL record per report**: `{source, url, commit, path, license, tier, notice, authors, kind: 'audit', text}`.
  At 3.5–4× gzip the text is ≈ 15–40 MB on disk.
- **Dedupe.** The same report often sits in the firm's repository, the protocol's repository and
  DAppSCAN. Keep one copy, preferring the firm's.
- **Filters** as in §5.2: no Code4rena contests, no token-only scopes, nothing that describes an
  evaluation item.
- **Measure, then weight.** The measured text size replaces the estimate before the mixture
  weights are fixed (SEPIA-1.md §3.4).

---

## 6. Held-out evaluation set (proposal: SEPIA-1 eval v0)

### 6.1 Principles

1. **Maintainer-written labels.** Evaluation items are built from code at pinned commits (any
   license, recorded in the manifest), factual labels written by LUSCA maintainers, and CC-BY/CC0
   advisory text. A label states a fact, for example "`withdraw` in `Vault.sol` at commit X lets the
   first depositor inflate the share price". It cites the public report by URL and copies none of
   its wording. Reports are training data under the license policy, but a report behind an
   evaluation item is kept out of training (§6.6).
2. **Score with likelihood, not free text.** SEPIA-0 has 187K parameters and a 16-character
   context. SEPIA-1 will still be small. Most tasks are therefore multiple choice, scored by the
   model's own log-likelihood normalised per byte, plus bits per byte on held-out code. Free-form
   explanation is a stretch task.
3. **Fit the context window.** Every item, prompt and candidate included, fits SEPIA-1's context.
   Functions longer than the window are not used.
4. **Two holdouts.** *Repository holdout*: about 16 repositories never enter the code index.
   *Time holdout*: for landmark repositories that must stay in training, the code index pins a
   commit from before an audited change, and evaluation uses only the files that change introduced.
   Example: pin openzeppelin-contracts at v5.4 (`f6fea85`) and evaluate on the v5.5/v5.6 audited
   changes (`d9f966f`, `68e4095`, including the new RLP library).

### 6.2 Candidate pool (24 protocols)

Selection rule. Each protocol needs: (a) public code (any license; the license is recorded), (b) at
least one public audit or advisory that names a commit, and (c) real protocol logic, so no token
clones. Stratify by ecosystem: EVM 14, Solana 5, Cosmos/Go 3, Move 2. Spread the EVM picks across
the code-index categories: DEX, lending, stablecoin, staking, bridge/rollup, account abstraction,
wallet, oracle.

Seed candidates whose audit sources were checked here (each code license is recorded again by the
code index at fetch time):

| Candidate | Code license | Audit / advisory source (verified) | Holdout |
|---|---|---|---|
| OpenZeppelin Contracts v5.5–v5.6 changes | MIT (verified) | `audits/README.md`, commits listed | time |
| Optimism contracts-bedrock, 2025 reviews (interop, MT-Cannon) | MIT | `docs/security-reviews/README.md`, commits listed | time |
| Solady | MIT (verified) | `audits/` folder | time or repo |
| Morpho Blue | GPL-2.0-or-later (verified, copyleft) | `audits/` folder | repo |
| SPL Token-2022 / Agave | per code index | `anza-xyz/security-audits` table | time |
| Sigma Prime-reviewed projects | per project | `sigp/public-audits` README "Target Commit" column | repo |
| cosmos-sdk, cometbft, ibc-go, wasmd | per code index | OSV GHSA/GO records with fix commits | advisory pairs |
| go-ethereum | copyleft (per code index) | 45 OSV records | advisory pairs |
| Anchor, solana_rbpf, alloy | per code index | OSV/RustSec records | advisory pairs |

The remaining slots are filled with the same rule from the code-index allowlist. Each choice is
recorded in the evaluation manifest with its commit, license and the reason it was chosen.

### 6.3 Tasks

| ID | Task | Item format | Size | Metric | Chance |
|---|---|---|---|---|---|
| T1 | Held-out code modelling | raw source files from held-out repos/diffs, per language (Solidity, Rust, Go, Move) | 2–5 MB | bits per byte | baselines below |
| T2 | Find the vulnerable function | factual one-line label + K=4 functions from the same contract (distractors of similar length from the same file) | 300 | top-1 accuracy, MRR | 25% |
| T3 | Classify a finding | one function + 8 classes (access control; reentrancy/callback; oracle/price manipulation; rounding/precision; accounting desync; signature/replay; initialization/upgrade; input validation/DoS). Solana items use missing signer/owner check, account type confusion, PDA seed/bump, arbitrary CPI target. Names map to EthTrust/SWC where possible. | 300 | accuracy, macro-F1 | 12.5% |
| T4 | Vulnerable vs. fixed | OSV advisory summary (CC-BY/CC0) + the function before and after the fix commit; which one has the issue? A/B order randomised. | 120 pairs | accuracy | 50% |
| T5 | Architecture | 4 short descriptions of a protocol's structure (which contract holds funds, the entry point for liquidation or settlement, the trust boundary); 1 correct, 3 taken from other protocols in the same category. Written from the protocol's own licensed docs and code. | 96 (24 × 4) | accuracy | 25% |
| T6 | Explain a function (stretch) | function → free-text explanation | 48 | 0–3 rubric (purpose, key invariant, external calls/side effects), 2 human raters, Cohen's κ reported | — |

Scoring for T2–T5: for each candidate c, compute the mean per-byte log-probability of c given the
shared prompt, and pick the argmax. For T2, also report the reverse direction (log P(label | function)),
which is less sensitive to candidate length.

Baselines: chance; SEPIA-0 (no code in its training data); a byte-level n-gram model trained on the
same SEPIA-1 corpus; and, for T1 only, `zstd -19` with a dictionary trained on the training split.
SEPIA-1 "reads code" on a task only if the lower bound of its 95% bootstrap interval (1,000
resamples) is above both chance and the n-gram baseline.

### 6.4 Labelling

- Two maintainers label each T2/T3 item independently from the public report and the code at the
  pinned commit. Disagreements go to a third maintainer. Items that stay ambiguous are dropped.
- Labels are new sentences. They never paste or paraphrase a report sentence by sentence.
- T5 descriptions are written from the protocol's own repository docs (same license as the code).

### 6.5 Files

`eval/v0/manifest.json` holds protocols, commits, licenses and the reason each was selected.
`eval/v0/items.jsonl` holds one item per line: `{id, task, repo, commit, path, symbol, prompt, candidates[], answer, label_source_url}`.
Every file carries a canary GUID so leakage into any future corpus can be detected. The items are
small (under 5 MB). They hold references and short labels; code is fetched by commit at run time,
which keeps the repository light and the licenses traceable.

### 6.6 Leakage controls

1. Held-out repositories are left out of the code-index allowlist. Time-holdout repositories are
   pinned to the pre-audit commit.
2. **Scan the existing web corpus** (`dataset.jsonl` and its 3 archives) before SEPIA-1 trains on
   it. Drop records that contain a held-out protocol name together with a report URL, or that share
   64-byte shingles with evaluation code. The Security sector already collects from security blogs
   and from hosts matching `/security|audit/` (§1, item 7), so this is a real risk.
3. Freeze the training data at a recorded date. Evaluation items for the time holdout must come
   from audits published after that date, the same approach as ScaBench.
4. **Keep the sources of evaluation items out of training.** Audit reports, judging READMEs,
   DeFiHackLabs entries and PoCs, and OSV advisories now enter training (§5). Any of them that
   describes an evaluation item is dropped from training and from the M5 fine-tune, matched by URL,
   repository path, and protocol name with commit. The OSV advisories used as T4 prompts are held
   out the same way.
5. Publish per-task results with the corpus snapshot hash and the evaluation manifest hash.

---

## 7. Owner decisions and open items

The owner's license decision (2026-10-05) settles the permission requests the first version of
these notes listed (Trail of Bits, SunWeb3Sec, coral-xyz, the Solana Foundation, Ackee, the audit
firms, OpenZeppelin) and the copyleft question: none is a prerequisite now. What remains:

| # | Item | Status |
|---|---|---|
| 1 | Code4rena content | Excluded: ToS §8(h) explicitly forbids ML training and evaluation, including derived datasets. A written agreement with C4 is the only way in; optional. |
| 2 | Web corpus host rules | The rekt.news seed and the `/security|audit/` host rule stay, with terms recorded per host. Add an explicit block for hosts whose terms forbid ML training (`code4rena.com`). |
| 3 | An author asks to be left out | Not required by the policy. If it happens, removing the source from the allowlist or source list drops it from the next data version (SEPIA-1.md §3.6). |
| 4 | SEPIA-1 owner decisions | License for the released weights, optional rented verification GPU, quality bar (SEPIA-1.md §9). |

---

## 8. Sources checked

Terms pages: Code4rena ToS (docs.code4rena.com/legal/terms-of-service), Sherlock ToS
(sherlock.xyz/terms-of-service), Cantina General Terms (cantina.xyz/terms/general), OpenZeppelin
ToS (openzeppelin.com/tos), Rekt News T&C (rekt.news/termAndConditions), GitHub ToS §D.5, OSV data
docs (google.github.io/osv.dev/data), EEA EthTrust v3 (entethalliance.org/specs/ethtrust-sl/v3).

GitHub repositories (REST metadata plus root LICENSE and README): code-423n4/code423n4.com,
code-423n4/2024-03-revert-lend-findings, sherlock-protocol/sherlock-reports,
sherlock-audit/2024-08-sentiment-v2-judging, spearbit/portfolio, Cyfrin/cyfrin-audit-reports,
Cyfrin/codehawks-docs, trailofbits/publications, Zellic/publications, sigp/public-audits,
pashov/audits, HalbornSecurity/PublicReports, anza-xyz/security-audits,
OpenZeppelin/openzeppelin-contracts (audits/), ethereum-optimism/optimism (docs/security-reviews),
SmartContractSecurity/SWC-registry, kadenzipfel/smart-contract-vulnerabilities,
crytic/not-so-smart-contracts, crytic/building-secure-contracts,
ConsenSysDiligence/smart-contract-best-practices, OWASP/www-project-smart-contract-top-10,
ComposableSecurity/SCSVS, SunWeb3Sec/DeFiHackLabs, SunWeb3Sec/DeFiVulnLabs,
pcaversaccio/reentrancy-attacks, immunefi-team/Web3-Security-Library,
immunefi-team/bugfix-reviews-pocs, coral-xyz/sealevel-attacks, solana-foundation/developer-content,
slowmist/solana-smart-contract-security-best-practices, Ackee-Blockchain/solana-common-attack-vectors,
neodyme-labs/solana-ctf, neodyme-labs/solana-security-txt, otter-sec/sol-ctf-framework,
sannykim/solsec, OpenZeppelin/ethernaut, theredguild/damn-vulnerable-defi, github/advisory-database,
rustsec/advisory-db, ZhangZhuoSJTU/Web3Bugs, InPlusLab/DAppSCAN, smartbugs/smartbugs-curated,
system-pclub/SC-Bench, scabench-org/scabench, paradigmxyz/evmbench, anthropics/scone-bench.

Report PDFs sampled for notices: Trail of Bits (Otim smart wallet, 2025-03), Zellic (Tenbin Labs),
Sigma Prime (Term Finance v2), Cyfrin (GreekFi core), Sherlock (Notional Exponent), Pashov (Aave),
OtterSec and Neodyme (Agave v4.2, from anza-xyz/security-audits), OpenZeppelin (Contracts v5.0),
Spearbit and Cantina (Optimism interop and MCP L1, from the Optimism repo).
