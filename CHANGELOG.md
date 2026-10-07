# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Read the binary (`/binary`).** The interface of Solana programs that never published an IDL,
  recovered from their executables with the evidence for every name: the program's own
  `Instruction: <Name>` log strings, confirmed by the Anchor discriminator
  (`sha256("global:<name>")[0..8]`) found as an `lddw` constant in the code or 8 bytes of data;
  account types, events and other programs' instructions (CPI) from the discriminators of every
  published IDL LUSCA keeps; error messages of those IDLs found verbatim (messages present in most
  executables are left out as framework strings); crate name + version from crate directories in
  panic-location paths (the paths themselves are dropped); framework, syscalls, security.txt.
  Executables come from the reads the chain agents, the radar and Lens already make (no extra RPC),
  plus a background reader under its own daily slice of the Solana budget
  (`LUSCA_BINARY_SOL_CALLS`, default 250; ≤ 30 % per hour; never below the 10 % floor kept for the
  agents). Results are kept per code hash (`<data>/binary/results.jsonl`, never the executable) and
  read again only when the code changes. Programs that do publish an IDL are recovered blind (their
  own IDL left out of the dictionary) and scored against it: recall, precision, and the
  instructions the deployed code has that its IDL does not list. `GET /api/binary/summary`,
  `/api/binary/items?framework=&cursor=`, `/api/binary/:address`; a "Recovered from the binary"
  block on `/lens/solana/:address` for programs without an IDL. `LUSCA_BINARY=0` turns it off.
- **Scan (`/scan`).** Watch the chain agents read programs and contracts as they happen, with
  nothing to type: each read opens in a window on its Lens address, the calls it made play back in
  their real order and relative timing (method, what was asked, the provider that answered,
  duration, result), each call lights the link between the LUSCA hub and that provider's node
  (Helius for Solana program reads in production), every decoded field gets a bounding box and a
  wire to a detection chip or the hub, and the read ends on its verdict. With no new read queued,
  the most telling recent reads are replayed and labelled with the time they were read.
- **Call trace on chain-agent reads.** Every agent read records the calls it already makes (≤ 24,
  no extra RPC, no URL or key: providers by name; the wait for a turn in LUSCA's own pacing is kept
  apart from the provider's time) and the fields it decoded, capped at 8 KB per event. Served by
  `GET /api/chain/feed?scan=1`; on the socket only to connections that send
  `{ t: 'chain.scan', on: true }` (every other page gets the lean event). `/api/chain/stats`
  names each chain's RPC provider.
- **Protocol code index for SEPIA-1.** The server collects source files from an allowlist of 110
  public blockchain repositories (landmark protocols and core infrastructure across EVM, Solana,
  Move, Cairo, Cosmos, Bitcoin and clients / VMs; no memecoins or token clones) into gzip JSONL
  shards under `<data>/code`. One repository at a time, refreshed weekly when its commit moves;
  large monorepos are pinned to their release branch or tag (Sui, Aptos, Agave, Bitcoin Core,
  Osmosis, Anchor, OP Stack, Arbitrum Nitro, cosmos-sdk). Capped at 150 MB of shards
  (`LUSCA_CODE_MAX_MB`; `LUSCA_CODE_INDEX=0` turns it off), filled in priority order; downloads
  pause while GitHub rate-limits or fails. Core files over 200 KB that an entry names (Bitcoin
  Core `validation.cpp`, the Agave bank, the Token-2022 processor, …) are kept up to 640 KB. The license
  of every repository and file is recorded (SPDX id and tier); no repository is excluded by license.
  A repository is skipped only when it is not public, its license or README forbids
  machine-learning use, or it does not fit, and the reason is recorded (`server/codebase/`).
- **`GET /api/code/stats`.** Status, commit, license, files and bytes per repository, with totals
  per language and per ecosystem.
- **Sepia page: "What SEPIA-1 will read".** Live totals, code by ecosystem and the repository list
  with each license, from `GET /api/code/stats`.
- **SEPIA-1 design notes** in `docs/SEPIA-1.md` and `docs/SEPIA-1-data.md`.
- **SEPIA-1 tokenizer (milestone M1).** A 32,768-entry code-aware byte-level BPE trained on all 110
  code-index repositories and crypto web text (`models/sepia-1-tokenizer/`, scripts in
  `scripts/tokenizer/`). On held-out code it averages 4.22 bytes per token (o200k_base 4.03,
  cl100k_base 4.01, GPT-2 r50k_base 2.41) and every held-out file round-trips exactly. A
  dependency-free TypeScript encoder (`shared/sepia1/tokenizer.ts`) matches Hugging Face `tokenizers`
  0.20.3 on every held-out token and on 5,518 test strings, including Unicode 15/16 characters
  (its letter and digit classes are pinned to the tables `tokenizers` uses, not the browser's).
  The release files are served at `/models/sepia-1-tokenizer/`. The SEPIA-1 model itself is not
  trained yet.
- **Sepia page: "SEPIA-1 tokenizer".** Tokenize real protocol code from the held-out split
  (Solmate ERC4626, an OpenBook v2 Anchor instruction, DeepBook Move, OpenZeppelin Cairo) or your
  own text in the browser and compare token counts with o200k_base and cl100k_base, next to the
  measured held-out evaluation. The GPT encodings load only when you edit the text.
- **Proof of contribution.** Every epoch (60 minutes by default, `LUSCA_EPOCH_MIN`, aligned to the
  UTC clock) the server commits each identity's confirmed credits, jobs and FLOPs for that epoch as
  a leaf of a SHA-256 Merkle tree and writes a header linking to the previous header by hash.
  Escrowed credits enter only once an audit confirms them; forfeited credits never do. Epoch 0
  commits every balance that existed when proofs started. On `/earn` a browser can re-hash the
  whole chain, check its own leaf and Merkle path with WebCrypto, keep the last head it verified
  and copy a head hash to post publicly; the desktop neuron checks its newest leaf the same way.
  The chain proves that committed credits were not rewritten for anyone who kept an earlier head;
  it is not anchored on Solana yet. Routes under `/api/proofs` (docs 10.5).
- **Payout preview on `/earn`.** Runs the payout engine's own `planPayout()` (now in
  `shared/payoutPlan.ts`) in the browser on your period credits. Payouts stay as configured; the
  preview sends nothing.
- **LUSCA Lens (`/lens`).** Paste a Solana program id or an Ethereum, Base or Arbitrum contract
  address and get a report read on-chain with the chain agents' own readers: upgrade authority or
  proxy admin, verified source (OtterSec / Sourcify), interface, admin-gated functions with the file
  and line of the guard, cryptographic primitives, and files byte-identical to a repository in the
  protocol code index. Every fact links to where it was read; no model writes any of it. Reads that
  pass the SEPIA-1 rules are added to the chain index (discovery source `lens`, capped per day).
  Per-IP and daily call budgets; `LUSCA_LENS=0` turns it off. Design notes in `docs/LENS.md`.

### Fixed

- **SEPIA-0 counters after a crash.** The public step, weights version, server and GPU step counts
  and GPU samples no longer go back after a hard kill between two 90-s checkpoints. Step numbers are
  reserved in `<data>/progress.json` before they are shown, so a crash skips at most 256 step
  numbers and never shows one twice; the work counters are shown as persisted. Audit counts have
  the same guarantee (`<data>/audits.json`).

### Changed

- **Credits.** The units earned for verified GPU work are now called credits everywhere in the
  product (formerly shown as INK). Credits are each wallet's share of the payout pool; payouts are
  made in SOL. **$INK** only ever means the project token, whose trading fees fund the pool. API
  and ledger field names (`ink`, `periodInk`, `inkIssued`, …) are unchanged.

## [0.1.0] - 2026-10-05

First public release.

### Added

- **Data agents and ingest.** 24 autonomous agents (`LUSCA_AGENTS`) fetch public crypto web pages
  into an open corpus. Ingest honours robots.txt and AI opt-outs, paces requests per host, redacts
  PII during extraction and drops near-duplicates (`server/ingest/`).
- **Open corpus.** Extracted text is stored as a rotating JSONL dataset, browsable in the app and
  through `GET /api/pages`.
- **SEPIA-0.** A character-level MLP language model (187,104 parameters) trained on the corpus, with
  a single shared implementation in `shared/sepia/` and text generation through `POST /api/generate`.
- **GPU training network.** Browser neurons (WebGPU, WGSL kernels, no install) compute SEPIA-0
  training gradients on batches the server selects. The server spot-checks every gradient, fully
  audits the first 3 jobs of each identity and about 20% of later jobs at random, and applies
  accepted gradients with Adam.
- **Credit escrow.** Credits earned for training stay pending until an audit passes; a failed audit
  forfeits it.
- **Dedupe jobs.** Neurons also run deduplication jobs for the corpus.
- **Desktop neuron.** A single-file CPU neuron for Node 20+ (`scripts/neuron.ts`, built to
  `dist/neuron.mjs` with a SHA-256 checksum by `npm run build:neuron`), published at
  https://lusca.ink/neuron.mjs.
- **Wallet sign-in.** Solana wallets are verified with a single signed Sign-In With Solana message;
  no transaction is requested (`server/auth/`).
- **Payout engine.** Every 12-hour period, verified wallets can receive SOL from a treasury: 50% of
  the balance above a 0.05 SOL reserve, at most 5 SOL per period and 1 SOL per wallet
  (`server/payouts/`). Payouts are off until the treasury is funded (`LUSCA_PAYOUTS=off`).
- **Web app.** Vite + React + TypeScript client with a three.js scene and an in-app manual, live at
  https://lusca.ink.
- **Deployment.** Render Blueprint (`render.yaml`) for a single Node service with a persistent disk
  for the dataset, checkpoint and ledger.
- **Project tooling.** Tests for the coordinator, wallet auth, payout engine, SEPIA math and trainer
  (`npm test`), GitHub Actions CI, Dependabot, issue and pull request templates, contributing guide,
  security policy and code of conduct.

[Unreleased]: https://github.com/LUSCAINK/LUSCA/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LUSCAINK/LUSCA/releases/tag/v0.1.0
