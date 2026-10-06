# Update 3/3: LUSCA Lens

Branch `update/lens` in `C:/Users/PC/lw/lens`. All commits are local and nothing has been pushed or deployed. The branch starts from `7a0d79f` (Chain agents and public SEPIA-1 weights).

## What it is, in plain words

You can now paste any Solana program id, or any Ethereum, Base or Arbitrum contract address, into
`lusca.ink/lens`. LUSCA reads that address on-chain with the same code its chain agents use and
returns a report. Each fact in the report links to where it was read: the block explorer, Sourcify,
OtterSec, or a GitHub repository at a commit with a file and line. No language model writes any part
of it. When something could not be read, the report says so and shows nothing in its place.

A report covers these questions:

- **Upgrades:** can the code be changed, and by whom? This is the upgrade authority on Solana, or the proxy admin on EVM. Proxies are followed through to the implementation contract.
- **Verification:** is the code verified? On Solana that means an OtterSec verified build; on EVM, a Sourcify full or partial match.
- **Interface:** the program's instructions, or the contract's functions grouped by type.
- **Privileged functions:** which functions only an admin can call, each with the file and line of the guard.
- **Cryptography:** which hash and signature primitives the code uses, such as SHA-256, Keccak, Poseidon, BN254, ecrecover, EIP-712 and KZG.
- **Provenance:** which of the verified files are the same as a file in LUSCA's 110-repository protocol code index.
- **SEPIA-1:** whether the code belongs in the SEPIA-1 dataset. Lens applies the same rules as the chain agents. If the rules keep a read, it is added to the chain index with the discovery source `lens`.

Reports can be shared as `/lens/<chain>/<address>`. The page also shows a public strip of recent reads.

## What changed since the review (this session)

All 1 blocker, 5 majors and every minor were addressed, except where noted below.

| Finding | Fix |
|---|---|
| **Blocker: backtracking regexes could freeze the server** | `server/lens/evm-analysis.ts` now collapses every run of whitespace to a single character before any pattern runs. A map keeps the original line numbers, so file:line citations still match the verified file. Every repetition in the patterns is bounded. Precompile calls are found by reading the call's arguments directly instead of with a regex. Each contract's analysis has a fixed work budget of 400 M characters scanned, with an 8 s wall-clock backstop. Real bundles cost 11–17 units per source byte, measured over every Solidity repository in the code index. Over the budget, the report says "analysis not completed" and lists nothing. Measured on this machine: a 50,000-character run of spaces, newlines or tabs now takes 3–10 ms, where the reviewer measured 15 s at 4,000. The 1,200-level nested-function case stops after 0.3 s. On the same sources for 13 real contracts (GMX Vault, Lido, Aave pool, Arbitrum token, Uniswap v4 PoolManager, Morpho, Permit2, a Curve Vyper pool, Safe, the Deposit contract, the Uniswap v3 Factory, the Base bridge proxy and the Uniswap v3 position manager), the results are identical to before: the same functions, guards, file:line citations and primitives. |
| **Major: OtterSec down was shown as "not verified"** | This now has its own `unknown` state. The page shows "n/a · OtterSec could not be asked: not checked", and the recent strip shows "not checked: registry unavailable". Such a report is cached for 1 minute instead of 15. If Lens has no OtterSec share left for the day, it returns a 503 before reading anything, the same way the EVM path does. |
| **Major: one IP could drain the daily budget** | A global fair share: at most a quarter of each daily Lens slice can be spent in one clock hour, so many IPs together cannot drain the day in an hour; over it, Lens returns a 503 with the seconds to the next hour. Per IP (IPv6 is grouped per /64): at most 100 fresh reads a day, and detect at most 60 an hour and 200 a day. Detect answers are cached per address and per chain for 6 h, including "no code". Only chains that did not answer are asked again. The Sourcify and OtterSec shares were raised to 2,000 a day each, which is 40 % of LUSCA's own 5,000 cap, and both are checked before a read starts. The status line now also shows registry lookups left today. A call that the shared budget would refuse is no longer charged to the Lens share. |
| **Major: anyone could fill the SEPIA-1 chain store** | Lens can add at most 50 items and 16 MB of source per UTC day (`<data>/lens/keeps.json`). It stops adding once the store is 80 % full; the remaining 20 % is headroom kept for the agents. Nothing is stored after a read's 60 s deadline. Over the cap, the report says "passes the SEPIA-1 rules but was not stored: … The chain agents may still keep it." |
| **Major: the public strip showed names chosen by attackers** | The strip shows a name only for code that the SEPIA-1 rules kept or already held, and only a plain name: no links, handles or domain-like text, and at most 48 characters. On EVM the code must also be verified on Sourcify. Every other row shows the address. Lens-kept events in the chain feed go through the same filter. **Partial disagreement:** for Solana I show the name of a program the rules kept even when it has no OtterSec build. The rules keep only programs with an OtterSec build or an on-chain IDL, and that name was written by the upgrade authority. Deploying a program costs SOL rent, and the filter blocks links. This keeps "jupiter" and "raydium-cp-swap" on the strip. To make it stricter, change one line in `remember()` in `server/lens/index.ts`. |
| **Provenance labels (≡ / ≈)** | The strip now counts the two kinds separately: "2/28 · 0 ≡ byte-identical · 2 ≈ same code". The section wording is now "the same bytes are in <repo>@<commit>", plus a sentence explaining that the code index keeps one copy of a shared file, so the repository shown is not necessarily the origin. Listing every holder of a file would need changes in the code index, which deduplicates files across repositories. Not done. |
| Budget share persistence | `budget.json` is written ahead: before a call is made, the file already covers it (16 calls are reserved at a time, with fsync and rename), and the exact count is written after each read. The count shown never goes down after a hard kill; it can go up by at most 16. |
| Concurrency and timeouts | A read keeps its concurrency slot until it actually finishes, even after a 504. After the deadline it makes no more calls and stores nothing. |
| /chain page regression | The "Where they look" panel counts only the agents' own reads, so its four rows add up to 100 % again. |
| Links for repositories not on GitHub | GitHub tree links are built only for `owner/repo` slugs. Any other `https` URL is linked as given and labelled with its host. Anything else gets no link, which also closes a `javascript:` href. |
| Spec gaps | The beacon address is now a linked fact (EVM section 01 and the cites). "Executable size" is now explained as "ELF in the programdata account, trailing zero padding removed". **Not done:** Sourcify has no per-file URL any more (the old `repo.sourcify.dev/contracts/...` paths return "API v1 is removed"), so file:line citations for files outside the code index still link to the Sourcify contract page. The keccak EXTCODEHASH is not added; the sha256 hash is labelled for what it is. |
| UI | The "reading" panel is now a static list of what the read asks for, with no fake progress timing. The nav number is now `06 Lens` (Model is 07, Docs is 08; neither other branch touches the nav). `/lens/polygon/…` shows an error message. An unnamed example such as SPL Token says it is listed on the page as the example "SPL Token" and that the program carries no on-chain name. |
| Tests | There are 10 new Lens tests, 27 in total. They cover 50k whitespace runs, the work budget and its "not completed" report, the OtterSec `unknown` state with its 1-minute cache and the up-front 503, detect caps and caching, the daily per-IP cap, the cap on SEPIA-1 items (it survives a restart), name filtering, the write-ahead budget across a simulated kill, the hourly fair share, and repository links. |
| `npm test` flake in `server/trainer/_smoke.ts` | Not Lens code. It passed in my full run (exit 0). If it fails once before you push, run it again. |

## Files

New: `server/lens/{index,report,evm-analysis,elf-syscalls,idl-detail,provenance}.ts`, `server/lens/_test.ts`,
`server/lens/_live.ts` (live smoke, not part of `npm test`), `shared/lens.ts`, `src/lib/lens.ts`,
`src/pages/Lens.tsx`, `src/pages/lens.css`, `docs/LENS.md`, this file, `MEDIA_FACTS.json`.

Small hunks in existing files: `server/http.ts` (the `/api/lens/*` route and the `lens` module), `server/index.ts`
(the modules line), `server/chain/{index,agents,store,solana}.ts`, `server/chain/discover/frontier.ts`,
`shared/chain.ts` (`FoundVia` gains `'lens'`), `src/App.tsx` (routes), `src/components/shell/Shell.tsx`
(nav), `src/lib/chain.ts` (the label for `lens`), `src/pages/Chain.tsx` (the panel fix), `package.json` (the test script).

## How to test locally

```bash
cd C:/Users/PC/lw/lens
npm run typecheck && npm test && npm run build
# a server with the QA data used tonight (populated with real reads)
PORT=8803 LUSCA_DATA=C:/Users/PC/lw/data-lens LUSCA_AGENTS=2 npx tsx server/index.ts
# open http://127.0.0.1:8803/lens and click the example chips
# live smoke over public RPCs, in a separate data dir (never a running server's dir):
LUSCA_DATA=C:/Users/PC/lw/data-lens-qa npx tsx server/lens/_live.ts solana:JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 ethereum:0x1f98431c8ad98523631ae4a59f267346ea31f984
```

Results tonight:

- `npm run typecheck`, `npm test` (exit 0, all suites; the Lens suite now has 27 tests and passes after the last change) and `npm run build` all pass.
- 41 real addresses were read end to end over public RPCs: 15 on Ethereum, 5 on Base, 5 on Arbitrum and 16 on Solana, including all 13 example chips, proxies of every kind, a Vyper pool, an EIP-7702 account, a token mint, an empty address and built-in programs. All 41 returned reports (`C:/Users/PC/lw/qa/lens-live-after-fixes.log`).
- In headless Chrome there is no horizontal scroll at 360 and 375 px, and desktop looks right at 1440 px. Screenshots are in `C:/Users/PC/lw/qa/v2-*.png`.
- I hard-killed the server (`taskkill /F`) and restarted it twice. "Reads served" was 55 before and 55 after, then 77 before and 77 after. Every budget counter and the count of Lens-kept items were the same after each restart.

## Deploy notes

- **Env vars:** none are required.
  - `LUSCA_LENS=0` turns Lens off; the route then answers 503.
  - `LUSCA_LENS_SOL_CALLS` (default 1,200 a day) and `LUSCA_LENS_EVM_CALLS` (default 2,250 a day per chain) set Lens's RPC share.
  - `LUSCA_LENS_HTTP_CALLS` sets the Sourcify / OtterSec share. Its default is now 2,000 a day each, 40 % of `LUSCA_CHAIN_HTTP_CALLS`.
  - The Lens shares are charged on top of the shared budgets. On production the agents keep at least 85 % of the 8,000 Helius calls a day, and the shared limit can never be exceeded.
- **Migrations:** none. Lens creates `<LUSCA_DATA>/lens/`, which holds `cache/`, `recent.json`, `budget.json`, `keeps.json` and `provenance.json`.
- **Disk:**
  - About 2 MB of code-index hashes.
  - At most 600 cached reports, pruned after an hour (roughly 15–90 MB worst case).
  - Lens-kept items count towards the chain store's existing 100 MB cap, at most 16 MB a day and never past 80 % of the cap.
- **CPU:**
  - 45 s after the first boot, the code index is hashed once in the background. That took a few seconds here, so expect tens of seconds on 1 CPU; it yields between records.
  - Each contract's source analysis is linear and capped at its work budget. It took 40–160 ms on the largest real repositories here, and it stops a hostile input in about 0.3 s.
- **RPC:** a Solana read costs 1 RPC call and 1 OtterSec call. An EVM read costs 1–7 RPC calls and 1–2 Sourcify calls. The first view of an EVM report also costs up to 2 `eth_getCode` calls for "same address on other chains", which are then cached for 6 h.

## Risks

- Privileged-function detection is pattern-based, not a full Solidity parser. It was right on every contract checked (USDC, Aave, Morpho, Uniswap v4, Lido, Permit2, GMX, Safe, Curve). On Solana, "privileged" means the IDL requires a signer whose name looks like a role.
- After the tweet, organic traffic could use up a share for the day. Each refusal is an honest 503 with Retry-After, and the status line shows what is left.
- **Merge conflicts:**
  - All three branches edit the same `package.json` "test" line.
  - `update/proof` also edits the `server/index.ts` modules line, plus the `Modules` interface and the route anchor in `server/http.ts`.
  - Each conflict is resolved by keeping both sides' additions. Merge Lens last.

## Left to do

- The code index keeps one holder per deduplicated file, so provenance cannot list every repository that holds a file.
- There are no per-file Sourcify links (Sourcify removed those URLs), and no keccak EXTCODEHASH.
- Links to Lens from the Landing page, `/chain`, the README and the CHANGELOG were not added, to avoid merge conflicts. These are one-line additions after merging.

## For filming

```bash
cd C:/Users/PC/lw/lens && PORT=8803 LUSCA_DATA=C:/Users/PC/lw/data-lens LUSCA_AGENTS=2 npx tsx server/index.ts
# then open http://127.0.0.1:8803/lens (dist/ is already built from the last commit; run npm run build first if you change anything)
```

- `C:/Users/PC/lw/data-lens` holds real reads from tonight: 77 reads served, and a recent strip of 24 programs and contracts across the four chains.
- Reports older than 15 minutes are read again live (0.3–2 s each), so filming needs internet.
- The shot list and the numbers that can be quoted are in `MEDIA_FACTS.json`. Those numbers come from a local server, not from lusca.ink usage.
