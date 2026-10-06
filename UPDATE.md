# Update 1/3: Proof of Contribution

Branch `update/proof`, 7 local commits on top of `7a0d79f`. Nothing has been pushed, deployed or published.

## What it is, in plain words

Every hour, LUSCA closes a contribution epoch. It records how many confirmed credits each contributor earned in that hour as a Merkle tree, and writes a small header that links to the previous hour's header by hash. The result is a hash chain of everyone's credits.

- A contributor can click **Verify my credits** on `/earn`. Their browser rebuilds their own leaf, hashes it with WebCrypto, walks the Merkle path to the root, and re-hashes every header from that epoch up to the current head. It then shows PASS or FAIL.
- Anyone can click **Verify the whole chain**, or download `leaves.json` for any epoch and recompute the roots themselves.
- The browser keeps the last head it verified. On the next check, the chain must still contain exactly that header. If anything before it was rewritten, the check fails and says which epoch changed. The desktop neuron does the same, storing its last head in `~/.lusca`.
- A rewrite is only detectable by someone who kept an earlier head hash. That is why there is a **copy head hash** button: a head posted anywhere public becomes an anchor anyone can check against. The chain is not anchored on Solana yet ("not connected yet" in the docs).
- What it does not prove is that the server measured the work honestly in the first place. That still rests on the spot checks and full audits. The docs (section 10.5) say this explicitly.

Only confirmed credits enter a leaf. Escrowed gradient credits enter once an audit confirms them, and forfeited credits never enter. Epoch 0 (genesis) commits every account's full balance at first start, so earlier history is covered.

## What changed since the review

All three major findings are fixed. The minor ones are fixed too, except the two listed under "What is left".

| Review finding | Fix |
|---|---|
| **Major: epoch close vs. in-flight async ledger save** | Ledger saves now carry a write generation. An async save that serialized before a later synchronous save never renames its older snapshot over the newer file. If its rename was already under way, it rewrites the newest state synchronously. On top of that, an epoch never closes while an async save is in flight; it retries after 250 ms. Two new tests cover this: one reproduces the reviewer's slow-rename race, the other parks an async save and lands a sync save first. |
| **Major: overclaimed tamper evidence** | Each check is now anchored to the last head this browser or neuron verified: localStorage `lusca.proofs.seen` in the browser, `~/.lusca/proof-head-<server>.json` for the neuron. There is a copy-head button for publishing heads. A missing `proofs/` directory no longer starts a silent new genesis: proofs turn **off** (`proofs-off` in `/api/health`) unless `LUSCA_PROOFS_RESTART=1`. The docs and the `/earn` strip were reworded to state only what the scheme proves. |
| **Major: CPU / DoS on proof lookups** | Tree levels and leaf positions are cached per epoch (8 epochs). A lookup on a 50k-leaf epoch now takes 0.019 ms instead of 121 ms; the first lookup still builds the tree, about 400 ms on this machine (see "Risks"). `leaves.json` is serialized once and gzipped once per epoch, served with an `ETag`, and answers `If-None-Match` with 304 (checked live). |
| Identity index cap | Least recently seen identities are evicted. New contributors are no longer refused once 50k identities exist. |
| Proof POSTs shared the sign-in rate limit | They have their own limiter now (30/min per address). Live check: 25×200 then 429 on `/api/proofs/mine`, while `/api/auth/nonce` still returned 200. |
| 5000-header cap on the whole-chain check | It fetches up to 2000 headers (or back to your anchor) and verifies them against the header just below. It reports "#N to the head, linked to #N-1" instead of a false genesis failure. |
| Status when proofs are off or stalled | `state: verified / broken / off` and a `stalled` flag are shown on `/earn` and reported in `/api/health` (`proofs-off`, `proof-epoch-stalled`). The page refetches 2.5 s after a close, then backs off (5 s, 5 s, then 30 s doubling up to 5 min) instead of polling every second. |
| PASS without the header being in the public chain | PASS now requires every header from that epoch up to the current head to re-hash and link in the browser. The verdict line shows how many headers it linked through. |
| Ledger cross-check unexplained | When they differ, the stat says "X issued to no account", with a tooltip giving the reasons: below the account minimum, account cap, or evicted before genesis. A drop in ledger lifetime credits is now a recorded **warning**, not a permanently broken chain. The headers still link, and the drop stays visible forever in the headers. |
| Corpus counters | `heldBytes` now covers only counted files. A new `heldUncountedBytes` field reports the rest. `dataset-archives.json` is fsync'd before the rename. Lifetime tokens are labelled "accepted" on Observatory and Landing. |
| Filming provenance | `MEDIA_FACTS.json` labels every number as a **local test run**, not lusca.ink. |
| Also | Epochs now close exactly on the boundary: a timer is armed for the close time, with the 15 s tick as the fallback. The open block reads "closing…" instead of 0:00:00. |

### Files

- **New modules (earlier commits):**
  - `shared/proofs.ts`: byte format and browser verification
  - `shared/payoutPlan.ts`: `planPayout`, moved so the browser runs the same code. `server/payouts/plan.ts` re-exports it.
  - `server/proofs/{index,http,preview,_test}.ts`
  - `server/trainer/auditCounter.ts`
  - `src/components/proofs/{ProofOfContribution.tsx,proofs.css}`
- **Touched:**
  - `server/neurons/coordinator.ts`: EpochLedger and write generations
  - `server/http.ts`: proof routes, their own limiter, immutable gzip and ETag
  - `server/index.ts`: wiring and health flags
  - `server/ingest/{store,pipeline}.ts`, `server/contracts.ts`, `shared/protocol.ts`: held corpus counters
  - `server/trainer/trainer.ts`: monotonic audits
  - `scripts/neuron.ts`: proof line and head anchor
  - `src/components/docs/content/Economics.tsx`: docs 10.5
  - `src/pages/{Earn,Landing,Observatory}.tsx`, `src/components/sepia/Dataset.tsx`, `src/components/shell/Shell.tsx`, `src/components/agents/ArmsView.tsx`: labels
  - `package.json`: test line

## How to test locally

```bash
cd C:/Users/PC/lw/proof
npm run typecheck && npm test && npm run build     # all pass (16 proof tests)
npx tsx server/proofs/_test.ts                       # proofs only

# live (2-minute epochs so blocks appear while you watch)
PORT=8801 LUSCA_DATA=C:/Users/PC/lw/data-proof LUSCA_AGENTS=2 LUSCA_EPOCH_MIN=2 npx tsx server/index.ts
# in 1–3 other terminals (more devices = longer Merkle paths)
npx tsx scripts/neuron.ts --server ws://127.0.0.1:8801/ws --device proofqa-device-0001 --plain
npx tsx scripts/neuron.ts --server ws://127.0.0.1:8801/ws --device proofqa-device-0002 --plain
npx tsx scripts/neuron.ts --server ws://127.0.0.1:8801/ws --device proofqa-device-0003 --plain
```

Then open `http://127.0.0.1:8801/earn#ep-proofs`. In the dev console run `localStorage.setItem('lusca.deviceId','proofqa-device-0001')` and reload, so "Verify my credits" finds that device's leaves.

**What QA checked (03:28–03:35 local, headless Chrome 154):**
- At 1440 px: "Verify the whole chain" re-hashed 11 headers and 11 roots. The second run reported "still contains head #8 … nothing before it was rewritten".
- With a forged anchor in localStorage, the check failed with "epoch #8 no longer has the hash this browser verified … history was rewritten".
- "Verify my credits" walked a two-step path (3 leaves) and returned PASS. Its last line read "header is the current head #10". An old chip (#1) linked through 7 headers.
- Payout preview computed with a 25 SOL pool.
- At 375 px: no horizontal overflow (scrollWidth 375).
- After a hard kill (`taskkill /F`) and restart: the chain verified in 5 ms, and the committed credits were unchanged (6,986.58).
  - Audits went 725 → 744, lifetime credits 7,651.66 → 7,831.98, pages 433 → 433.
  - The next epoch closed at exactly 09:32:00 UTC.
- The desktop neuron printed: `proof · epoch #4 … Merkle path verified here · chain extends the head #8 seen 2026-10-06 09:29 UTC`.

## Deploy notes

- **New env vars:**
  - `LUSCA_EPOCH_MIN`: minutes per epoch, default 60, boundaries on the UTC clock.
  - `LUSCA_PROOFS_RESTART=1`: only to deliberately start a new chain when `proofs/` is lost. Leave it unset.
  - No new secrets. Device identities are HMAC'd with the existing `LUSCA_HASH_SALT`, or `hash.salt` in the data dir.
- **Migration:** none by hand. On first start the server writes genesis (epoch 0) from every account with a balance: under 5 MB at the 50k-account cap, under a second. `ledger.json` gains an `epoch` field; older code ignores it.
- **Disk:** per epoch, one header (~0.5 KB) plus about 100 bytes per active identity. At 60-minute epochs that is 24 files of each kind per day. Nothing is pruned.
- **CPU:**
  - Startup re-hashes every stored leaf: milliseconds now, an estimated 1–2 s after a year at around 100 identities per hour.
  - Repeat proof lookups are cached. The first lookup of a big epoch builds its tree: about 400 ms for 50k leaves on this machine (a Ryzen 7950X3D), slower on a Render vCPU. Only genesis is that big, and its tree stays cached while it is among the 8 most recently looked-up epochs.
- **RPC:** none. **New public routes:** `GET /api/proofs`, `GET /api/proofs/:i`, `GET /api/proofs/:i/leaves.json`, `POST /api/proofs/mine`, `POST /api/proofs/:i/proof`, `POST /api/proofs/preview`.
- **Health:** new degraded flags `proof-chain-broken`, `proofs-off` and `proof-epoch-stalled`. `/api/health` keeps answering 200.

## Risks

- **Post a head hash when you tweet.** The chain only proves "not rewritten" to someone holding an earlier head. A head in the tweet makes everyone an anchor. Get it from the copy-head-hash button on lusca.ink after deploy, not from the local run.
- **Ledger reset or restore:** `LUSCA_LEDGER_RESET`, or restoring `ledger.json.bak`, makes the next header record lower lifetime credits. That now shows as a permanent **warning** line, not "chain broken". Credits already committed stay committed.
- **Lost `proofs/` directory:** proofs turn off and `/api/health` shows `proofs-off` until the directory is restored or `LUSCA_PROOFS_RESTART=1` is set. This is deliberate, so the server can never silently hand out a fresh chain.
- **Identity model:** proof lookups authenticate like `account.watch` (session token or device id). A device id is a bearer secret, as it already is for balances.
- **Merge with the other two branches** (checked with `git merge-tree` at 03:35 local; those branches may have moved since):
  - `update/lens` conflicts in `package.json`, `server/http.ts` (the Modules interface and the route block) and `server/index.ts` (the modules line).
  - `update/tok` conflicts in `package.json`.
  - All of these are adjacent insertions: keep both sides. Merge `update/proof` first, then the others.
  - `server/payouts/plan.ts` is now a re-export of `shared/payoutPlan.ts`, so any later change to the plan logic belongs in `shared/payoutPlan.ts`.
- The held-corpus counters read low for about 0.1 s after a restart, because HTTP starts before `dataset.jsonl` is reloaded. Lifetime pages already behaved this way, and this is not fixed.

## What is left

- **Link events:** a device-to-wallet link moves payout credits but adds no leaf (it is not new work), so a wallet's leaves can add up to less than its payout credits. Committing link events as their own leaf type would close that gap. This is documented in 10.5.
- **On-chain anchoring:** posting each head hash to a Solana memo is not built ("not connected yet").
- `leaves.json` files are never pruned, and reads of a leaf file are synchronous (cached for 24 epochs).
- No CHANGELOG entry, and the routes are not on the Protocol docs page (all three branches edit those lines). The routes are listed in 10.5.
- Filming data in `C:/Users/PC/lw/data-proof` is a **local test run**: 2-minute epochs, QA devices `proofqa-device-0001..0003` on this machine. See `MEDIA_FACTS.json`.
  - State when QA stopped (09:37:47 UTC): epochs 0–12 closed (head #12 `a710ff73…`), and epoch 13 open with 3 identities' credits saved in `ledger.json`. It closes on the next start.
  - The QA neurons wrote their last verified head to `~/.lusca/proof-head-2d7e6d97f266.json` (the anchor for `127.0.0.1:8801`). Delete it if you do not want the neuron's "chain extends the head #… seen …" line.
