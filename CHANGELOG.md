# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **INK escrow.** INK earned for training stays pending until an audit passes; a failed audit
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
