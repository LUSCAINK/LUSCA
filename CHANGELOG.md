# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
  token for token. The SEPIA-1 model itself is not trained yet.
- **Sepia page: "SEPIA-1 tokenizer".** Tokenize real protocol code (Uniswap V2, an Anchor
  instruction, Sui Move, Cairo) or your own text in the browser and compare token counts with
  o200k_base and cl100k_base, next to the measured held-out evaluation.

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
