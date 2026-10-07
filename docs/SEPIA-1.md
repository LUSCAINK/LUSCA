# SEPIA-1 — design

Status: draft for review · 2026-10-05 · no SEPIA-1 training code yet; the code index (M0, `server/codebase`) is being built.
License policy updated 2026-10-05 after the owner's decision: every license is used for training and recorded ([§3.6](#36-license-policy-and-tracking)).
Companion document: [SEPIA-1-data.md](./SEPIA-1-data.md) (sources, expert analysis, held-out protocol set).
Live numbers are from `GET /api/health` and `GET /api/neurons` at 2026-10-06 01:47 UTC unless stated otherwise.
Every derived figure in this document comes from the formulas in [Appendix A](#appendix-a--formulas-and-assumptions).

## Summary

1. SEPIA-1 is a small transformer that reads real blockchain protocol code (Solidity, Vyper, Rust/Anchor, Move, Cairo) and crypto technical text.
2. It learns from curated landmark protocols and core infrastructure. Memecoins, pump.fun contracts and token clones are excluded on purpose.
3. Every license is used for training: permissive, copyleft (Uniswap v2/v3, Lido, Maker, Balancer…), source-available BUSL (Uniswap v4, Aave v3) and code with no license. The license of every repository and file is recorded and listed in the model card.
4. Three sizes: 25.7M, 61.8M and 124.3M parameters, with a 2,048-token context and a new 32k code-aware tokenizer.
5. Today's per-step gradient upload does not scale: the 25M model would need about 200 Mbit/s of upload per GPU.
6. Instead, each GPU trains on its own for 128 steps, then uploads one compressed update (26 MB, or under 1 MB in sparse form).
7. The server cannot recheck that work (one step of the 25M model is 1.3 hours of server CPU), so 20% of units are run twice by independent GPUs and compared. Escrow and strikes carry over unchanged.
8. On today's pool (7.8 TFLOPS benchmarked, 25% of it assumed usable), the 25M model needs about 1–2 days of compute, the 60M model 4–9 days and the 120M model 17–34 days.
9. The 120M model is limited by data as much as by compute, and the Render box is big enough only for the 25M model. We start with the 25M model, then the 60M one.
10. Roughly 5–7 months to the "read a protocol" feature. Decisions needed from you: the license for the released weights, an optional rented verification GPU, the quality bar before release, and the code volume (the 110-entry allowlist is ≈ 40M tokens, under the mixture's plan: grow it or lower the code share, §9).

---

## 0. Where we are today

This is what SEPIA-1 builds on, taken from the code.

| Area | Today (SEPIA-0) | Source |
|---|---|---|
| Model | Character-level MLP, context 16, embedding 24, hidden 384, tanh, vocabulary 96 (newline + printable ASCII), 187,104 parameters | `shared/sepia/model.mjs` |
| Optimizer | One Adam state (β1 0.9, β2 0.99, clip 1.0), LR 3e-3 → 3e-4 cosine; the server CPU loop (batch 64) and GPU-neuron gradients both step it; version = optimizer step | `shared/sepia/model.mjs`, `server/trainer/worker.mjs` |
| GPU kernels | WGSL forward + backward: 64×64 output tiles, 16-deep K stages, 4×4 per invocation; weight gradients split-K into partials (256 rows per chunk) summed by a second kernel; no float atomics, so the same device gives the same bits | `src/lib/gpu/train/kernels.ts` |
| Wire format | Weights in f16 (≈374 KB); gradient in f16 with one power-of-two scale per tensor, 374,228 bytes (`GRAD_BYTES`) | `shared/sepia/index.mjs` |
| FLOPs | `trainFlops(B) = 6·B·(T·E·H + H·V) = 1,105,920·B` | `shared/sepia/index.mjs` |
| Job size | `TRAIN_BATCH`: EPI 256 · MESO 512 · BATHY 1,024 · ABYSSO 2,048 · HADAL 4,096 sequences; CPU neurons 128 | `server/neurons/coordinator.ts` |
| Cheap check (every result) | Server gradients on 64 random rows of the same batch in 8 groups; cosine, projection and norm screens plus loss plausibility; a weak score escalates to a full audit | `server/trainer/worker.mjs` |
| Full audit | Recompute the whole gradient from the exact base weights (ring of 24 f16 snapshots); pass if cosine ≥ 0.99 and relative error ≤ 0.05. Always for a neuron's first 3 results, then 20% at random, within 0.35 of one CPU core | `worker.mjs` (`LUSCA_TRAIN_AUDIT_P`, `LUSCA_TRAIN_AUDIT_CPU`), `coordinator.ts` (`FORCE_AUDIT_JOBS`) |
| Staleness | Results computed on weights more than 64 versions old are verified and credited, not applied | `LUSCA_TRAIN_MAX_STALE` |
| Escrow | Gradient-job credits held per strike identity (device / wallet / IP) until that identity's next passed full audit; a failed audit forfeits the escrow and counts as a strike; cooldown 30 s, doubling up to 15 min | `coordinator.ts` |

Live snapshot:

| Metric | Value |
|---|---|
| Web corpus | 324,775,719 tokens (counted with a GPT BPE tokenizer at ingest) · 165,272 pages · 287 domains · 24 agents in 8 arms |
| Neurons online / pool | 6 / 7,798.7 GFLOPS (sum of FP32 WGSL GEMM benchmarks, `src/lib/gpu/bench.ts`) |
| Pool composition | one RDNA-4 browser neuron at 6,583 GFLOPS (roughly three quarters of the pool), one Maxwell at 1,884, an RDNA-2 at 324, an Adreno at 276, a Valhall at 47, one desktop CPU neuron at 2 |
| Contributors, last 24 h | 49 |
| Jobs verified | 35,025 of 35,067 |
| Full audits | 7,162 passed · 0 failed |
| SEPIA-0 | step 629,475 · train loss 1.7049 · validation 1.6546 nats/char · 312 GPU steps/min |
| Server | RSS 740 MB · disk 568 MB free of 1,981 MB |

What these numbers tell us:

- **The GPUs mostly wait.** The average GPU batch is 745 sequences (25,549,056 samples / 34,305 GPU steps). An earlier version of this document multiplied that average by the 312 steps/min peak and got 4.3 GFLOPS; the production counters do not support that rate over time. Measured on 2026-10-07, the network delivers 920–1,327 samples/s, so 1,105,920 FLOP per sample gives **1.0–1.5 GFLOPS of useful training**, under 0.02% of the benchmarked pool. Each step is a round trip (weights out, 0.8 GFLOP of work, 374 KB back, server checks), and the round trip dominates. A larger model does more work per round trip, but then per-step exchange becomes bandwidth-bound ([§4.1](#41-why-the-current-scheme-does-not-scale)).
- **SEPIA-0 cannot read code.** Its 96 symbols fold tabs to spaces and drop non-ASCII. Its 16-character context is shorter than `function transfer(`.
- **Verification works at small scale.** It does so because the server can recompute a whole gradient on its CPU. At SEPIA-1 sizes that is no longer possible ([§5](#5-verification-on-a-1-cpu-coordinator)).

---

## 1. Goal and non-goals

### Goal

A model that reads high-quality blockchain code across ecosystems:

- **Explain code**: what a contract, program, module or function does, what state it touches, who can call it, and what invariants it relies on.
- **Describe a protocol from its code**: how the pieces fit, for example pool → router → oracle → liquidation path, and where value moves.
- **Recognise known vulnerability classes** in code, using the taxonomy of [SEPIA-1-data.md §6.3](./SEPIA-1-data.md) (task T3):
  - access control; reentrancy/callback; oracle/price manipulation; rounding/precision; accounting desync; signature/replay; initialization/upgrade; input validation/DoS;
  - on Solana: missing signer/owner check, account type confusion, PDA seed/bump, arbitrary CPI target.

Languages, following the code index filters (`server/codebase/filters.ts`): **Solidity, Vyper, Rust (incl. Anchor), Move, Cairo** first. Go comes from Cosmos repositories and C++ from Bitcoin repositories where the index keeps them. TypeScript appears only in SDK and test directories. Markdown docs and specs are included. Crypto technical text comes from the 8 arms' web corpus.

The categories follow `shared/codebase.ts`: DEXs, lending, stablecoins, liquid staking, bridges and rollups, account abstraction, wallets, token standards, oracles, governance, clients and VMs, frameworks, security tooling.

**Future product surface, "read a protocol".** Point SEPIA at a public repository, a verified contract (from an open registry such as Sourcify) or a Solana program with verified source. You get an explanation per file and function, plus a protocol-level summary. Each statement cites file and line ranges. Those citations come from the system's own span tracking, not from the model's memory ([§8, M5](#8-milestones)).

### Non-goals

- **Not a chat assistant.** There is no general instruction following and no open-domain Q&A.
- **Not financial analysis.** No prices, token recommendations, "is this a good investment", or market signals.
- **Not memecoin scanning.** No pump.fun or launchpad token contracts, no boilerplate token clones, and no bulk dumps of deployed contracts (these are mostly clones). The code index is a priority-ordered allowlist of landmark repositories, not a sweep of chains ([§3.3](#33-filtering-and-deduplication)).
- **Not an audit.** Output is labelled as machine-generated explanation that may be wrong. It does not replace a security review.

---

## 2. Architecture

### 2.1 Model

All three sizes are decoder-only transformers in a Llama-compatible layout. They export to Hugging Face as `LlamaForCausalLM` with `tie_word_embeddings: true`, so anyone can load and test the weights with standard tools.

- Pre-norm **RMSNorm**, no biases, **SwiGLU** MLP, **RoPE** (θ = 10,000, head dimension 64), **tied** input/output embeddings.
- Init N(0, 0.02); residual output projections scaled by 1/√(2·layers).
- Vocabulary 32,768. Context **2,048** tokens.

| | S | M | L |
|---|---|---|---|
| Layers | 12 | 14 | 14 |
| d_model | 320 | 512 | 768 |
| Heads × head dim | 5 × 64 | 8 × 64 | 12 × 64 |
| SwiGLU hidden | 896 | 1,408 | 2,048 |
| **Parameters (total)** | **25.73M** | **61.75M** | **124.28M** |
| Non-embedding | 15.25M | 44.97M | 99.11M |
| Embedding (tied) | 10.49M | 16.78M | 25.17M |
| Training FLOPs per token at 2,048 | 201.5M (1.31 × 6N) | 458.5M (1.24 × 6N) | 877.7M (1.18 × 6N) |
| Largest single tensor (f32) | 40 MiB | 64 MiB | 96 MiB |

Why these shapes:

- **Deep and thin for S.** Below ~100M parameters, depth helps more than width (MobileLLM, Liu et al. 2024). S uses 12 narrow layers, not 6–8 wide ones.
- **Head dimension 64 everywhere.** One attention kernel serves all sizes.
- **Every tensor stays under 128 MiB.** That is WebGPU's default `maxStorageBufferBindingSize`, so all sizes run without asking for raised limits. Parameters live in one buffer per tensor, not in SEPIA-0's single flat vector.
- **Attention adds 18–31% over 6N at 2,048.** The causal kernel skips fully masked tiles, so the average attended length is T/2.

### 2.2 Why 2,048 tokens

A typical contract file or Anchor module is 5–30 KB. The M1 tokenizer measures 4.22 bytes per token on held-out code (§2.3), so 2,048 tokens hold about 8.7 KB: 225 lines of Solidity, 258 of Rust, 233 of Move. That fits a contract's storage layout, its modifiers and several functions together. Longer files are split into windows. Repo-level packing ([§3.2](#32-document-format)) keeps related files next to each other. Extending to 4,096 with RoPE position interpolation is an option for M5, not for the base run.

### 2.3 Tokenizer

- **Byte-level BPE, 32,768 entries.** Ids fit in u16, so token ids are 2 bytes on disk and on the wire. The 256 byte tokens make encoding lossless for any file: tabs, indentation, Unicode in comments. SEPIA-0's 96-symbol map folds or drops these characters, and code needs exact bytes.
- **Code-aware pre-tokenization**, applied before BPE merges:
  - a newline plus the following indentation is one pre-token, so indentation levels become tokens;
  - common multi-character operators are atomic: `=>` `->` `::` `==` `!=` `<=` `>=` `&&` `||` `<<` `>>` `+=` `-=` `**` `..=` `//` `///` `/*` `*/` `#[`;
  - identifiers (letters, digits, `_`) are pre-token units, and BPE learns merges inside them, so `msg.sender`, `onlyOwner` and `invoke_signed` can become single tokens;
  - decimal digits are split one per token, the common choice for numeric robustness;
  - hex literals longer than 8 digits are split into 4-digit groups, so addresses and hashes do not use up vocabulary.
- **Special tokens**: `<|endoftext|>`, `<|pad|>`, `<|repo|>`, `<|file|>`, the fill-in-the-middle triple (`<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>`), and 32 reserved tokens for later fine-tuning formats.
- **Training sample**: balanced so each language gets merges (Move and Cairo are small and are upsampled for tokenizer training only), plus crypto web text. It is trained once with a published, deterministic script.
- **Artifacts**: `tokenizer.json` (Hugging Face format), merges, and sha256. One JavaScript encoder serves the server, the browser and the desktop CLI, the same pattern as `shared/sepia/` today.
- **M1 reports**: bytes per token per language, compared with the GPT tokenizer used at ingest on the same held-out files.

**Status (M1, 2026-10-06): trained and evaluated.** Artifacts in [`models/sepia-1-tokenizer/`](../models/sepia-1-tokenizer/) (tokenizer.json sha256 `4b2ec96e…`, model card, eval.json, manifest), scripts in [`scripts/tokenizer/`](../scripts/tokenizer/), TypeScript encoder in `shared/sepia1/tokenizer.ts`, playground on lusca.ink/sepia.

- Sample: 209.2 MB. 61.8% of it comes from the code index (all 110 repositories, 18,239 files at the commits in `scripts/tokenizer/data-manifest.json`): 49.5% source code, 11.8% Markdown docs and EIPs, 0.5% Anchor IDL JSON. The other 38.2% (80.0 MB) is crypto web text from the corpus. Verified on-chain sources were not used: the public chain API exposes source paths and sizes, not source text. Expert analysis is not collected yet.
- Held out before training, by hash: 1,052 documents (8% of code files per language up to 1.5 MB each, plus 1.5 MB of English web pages). Code is held out by file, not by repository, so other files of the same repositories are in training and the code results may be slightly optimistic; C/C++, TypeScript, Python and Vyper have fewer than 30 held-out files each and are indicative only.
- Held-out code: 4.22 bytes per token, against 4.03 for o200k_base (the encoding used at ingest), 4.01 for cl100k_base and 2.41 for GPT-2 r50k_base: 4.6%, 5.1% and 43% fewer tokens for the same code. Web text: 3.79 bytes per token against 4.26 for o200k_base, the expected cost of a 32k vocabulary on prose.
- Exact round trip on all 1,052 held-out documents. The TypeScript encoder matches Hugging Face `tokenizers` 0.20.3 on all 2,287,501 held-out tokens and on 5,518 committed test strings, with 0 mismatches. The test strings include letters and digits added in Unicode 15 and 16 and 3,000 random strings over all of Unicode: the encoder replaces `\p{L}` and `\p{N}` with the exact code-point sets Oniguruma uses in `tokenizers` 0.20.3 (`shared/sepia1/unicode-classes.ts`), so its output does not depend on the browser's Unicode version. Training twice gives a byte-identical tokenizer.json.
- Where this section left room (blank-line runs, dotted chains such as `msg.sender`, leading spaces on operators, punctuation runs), the choices and reasons are in the model card.

### 2.4 Precision and determinism

| Quantity | Format |
|---|---|
| Master weights, gradients, AdamW m and v | f32 |
| Matmul operands | f32 in v1. f16 through the optional `shader-f16` feature once twin agreement ([§5](#5-verification-on-a-1-cpu-coordinator)) is confirmed with it |
| Accumulation | f32 always |
| Stored activations | f16 when `shader-f16` is available, otherwise f32 (2× activation memory) |
| Base weights on the wire | int8 deltas with power-of-two block scales; f16 full snapshots for newcomers ([§4.3](#43-compression)) |
| Pseudo-gradient on the wire | int8 with power-of-two block scales |

WGSL has no bf16. Determinism rules carry over from `kernels.ts`:

- no float atomics;
- every reduction in a fixed order, independent of subgroup size (which varies from 8 to 64 across vendors).

A given device and driver therefore produce the same bits for the same inputs. **Bit equality across vendors is not achievable in WGSL**: transcendental functions are specified in ULPs, and `fma` may or may not be fused. Cross-vendor verification therefore compares results within calibrated tolerances ([§5.3](#53-calibration-gate)).

### 2.5 Optimizer

- **Inner** (on each neuron): AdamW, β1 0.9, β2 0.95, weight decay 0.1, clip 1.0. Peak inner LR is S 1.5e-3, M 1.0e-3, L 6e-4, to be confirmed by a small sweep in M1. The global schedule is warmup over 1% of tokens, then cosine to 10% of peak, indexed by global tokens consumed.
- **Outer** (on the server): Nesterov momentum 0.9, outer LR 0.7, the settings reported for DiLoCo (Douillard et al. 2023) ([§4.2](#42-local-inner-steps-and-outer-sync)).

---

## 3. Data mix and curriculum

The sources, the held-out protocol set and the expert-analysis policy are specified in [SEPIA-1-data.md](./SEPIA-1-data.md). This section covers how they are combined.

### 3.1 Sources and volumes

| Source | What | Volume | Notes |
|---|---|---|---|
| Web corpus | Crypto technical text from the 8 arms: specs, EIPs, docs, research, governance | ≈250–300M tokens on disk at any time | Production rotates `dataset.jsonl` at 350 MB and keeps 3 archives, so at most ≈1.4 GB of JSONL (text plus metadata) exists at once. The lifetime counter (325M) includes pages in archives that were already rotated out. **Export to tokenized shards before more pages rotate out.** The export API (`GET /api/export/*`, `server/export`) and `scripts/codex/pull_corpus.py` copy each archive to the owner's PC before it is deleted. |
| Protocol code index | 110 allowlisted repositories, all licenses (`server/codebase`, `GET /api/code/stats`) | Allowlist estimate: ≈ 35–46M tokens (≈ 40M at 3.5 bytes per token) | Filled in allowlist priority order up to a cap of 150 MB of gzip shards (`LUSCA_CODE_MAX_MB`); whatever does not fit is skipped with a note. Running `filters.ts` over the file list of every allowlisted archive (2026-10-05) gives ≈ 18.5k files, ≈ 139 MB of text and ≈ 29 MB of gzip shards with the allowlist's path limits; the same method matched real ingest exactly on 5 repositories. The earlier survey of 92 candidate archives, without path limits, found ≈ 400 MB. At 3.5–5× gzip the cap holds ≈ 525–750 MB of text, so the allowlist sets the size, not the cap. Measured 2026-10-06 (M1): all 110 entries indexed, 18,239 files, 147.7 MB of text, ≈ 35.7M tokens with the M1 tokenizer (each language's bytes ÷ its measured bytes per token) |
| Expert analysis | Vulnerability guides, incident index and exploit PoCs, advisories, wargames, audit reports | Guides, advisories, wargames and incidents: ≈ 8–15 MB (≈ 2.3–4.3M tokens). Audit-report repositories: more than 1,400 PDFs, text not yet measured; ≈ 60–140 MB (≈ 15–40M tokens) if a report averages 40–100 KB of text | Per [SEPIA-1-data.md §5](./SEPIA-1-data.md), all licenses. Code4rena-derived text is excluded because its terms forbid ML training. Reports that describe evaluation items stay out ([§3.5](#35-eval-contamination-control)). PDF-to-text conversion runs off the Render box |

The code index is a separate data source, not an arm. The arms stay at 8.

### 3.2 Document format

- **Code**: `<|repo|>owner/name@commit` then `<|file|>path/to/File.sol`, then the file bytes. Files of one repository are packed in dependency order (imported files first) so a window often contains a callee and its caller, the repo-level packing used by recent code models. Sequences are 2,048-token rows separated by `<|endoftext|>`.
- **Fill-in-the-middle** (Bavarian et al. 2022) on 10% of code documents is optional. It is decided by an ablation at a tiny size in M1, because the goal is reading, not completion.
- **Web and expert text**: title + body. Expert findings keep their code excerpt next to the finding text.

### 3.3 Filtering and deduplication

- **Exact duplicates**: sha256 of normalized content (line endings, trailing whitespace). The code index already drops exact duplicates across repositories at ingest (sha256 after newline normalization). The copy indexed first, normally the higher-priority allowlist entry, is kept.
- **Near-duplicates**: MinHash over 5-gram token shingles (128 permutations, LSH banding), clustered at Jaccard ≥ 0.8. The kept copy is the canonical upstream repository's, earliest commit. Lee et al. (2022) show deduplication improves models and reduces memorization.
- **Vendored copies**: `lib/`, `node_modules/`, `vendor/` and submodules are already skipped by `server/codebase/filters.ts`. Any copy that slips through is mapped to its canonical upstream by near-duplicate clustering.
- **Clone-family cap**: at most 2 members per near-duplicate cluster. This is the main defence against ERC-20/721 template floods and launchpad clones.
- **Non-source files**: ABIs, build artifacts, typechain output, lockfiles, minified files, files over 200 KB (`MAX_FILE_BYTES`) and files marked generated are excluded (already in `filters.ts`). An allowlist entry can name core files that run longer in `largeFiles`; those are kept up to 640 KB (`LARGE_FILE_BYTES`), and the generated and long-line checks still apply. This keeps Bitcoin Core's `src/validation.cpp` and `src/net_processing.cpp`, Agave's `runtime/src/bank.rs` and vote program state, the Token-2022 and SPL token-swap processors, the Raydium CLMM swap instruction, Reth's transaction pool and Aptos `delegation_pool.move`.
- **Refs and priority**: the large monorepos are pinned to the release branch or tag of the deployed code (Sui `framework/mainnet`, Aptos `mainnet`, Agave v4.3, Bitcoin Core v31.1, Osmosis v31.0.3, Anchor v1.2.0, OP Stack `op-contracts/v8.0.0`, Nitro contracts v3.2.0, cosmos-sdk `release/v0.55.x`) rather than their development heads, so the index holds released code and an unchanged pin is not downloaded again at the weekly refresh. Moving a pin is an edit of `server/codebase/repos.ts`. The allowlist is ordered by tier across ecosystems (core landmark code of every ecosystem, then more EVM protocols, then security corpora, then EIP / ERC text), so a lower `LUSCA_CODE_MAX_MB` cuts the least central entries first and no ecosystem is cut out as a block.
- **Tests**: kept, because they document behaviour. Capped at 30% of a repository's tokens.
- **Web text**: the existing taste score, simhash and vector near-duplicate checks apply. Pages under a taste-score floor are dropped from the anneal phase.

### 3.4 Mixture and curriculum

Mixture shares are sampling weights. No source is repeated more than 4 times: Muennighoff et al. (2023) find up to ~4 epochs of repeated data is nearly as good as fresh data, with diminishing returns after that.

| Phase | Share of tokens | Code | Web text | Expert analysis |
|---|---|---|---|---|
| 1 · main | first 80% | 50% | the rest, ≈ 40–49% | up to 2 passes, at most 10% of the phase |
| 2 · anneal (LR decays to its floor) | last 20% | 60% (landmark repositories upsampled) | the rest, ≈ 30–36% (highest taste scores: specs, EIPs, docs, research) | up to 2 more passes, at most 10% (guides, advisories and the highest-signal reports first) |

Expert analysis is capped by passes and by share:

- Without the audit reports it is ≈ 2.3–4.3M tokens. Two passes are ≈ 1–2% of S's phase-1 tokens; a fixed 10% share would mean 10–18 passes.
- With the audit-report repositories (≈ 15–40M tokens, unmeasured), the 10% ceiling binds for S instead: ≈ 1–2.4 passes in phase 1.

Checking the cap for each size:

- **S**: about 267M code tokens in total, 5.8–7.6 passes over the 35–46M-token allowlist estimate, which exceeds 4 passes. Keeping the shares above needs a code index of ≈ 67M tokens or more (≈ 1.5–2× the current allowlist). Otherwise S's average code share drops to ≈ 27–36%.
- **M**: about 640M code tokens, 14–18 passes over the same range. Either M's average code share drops to ≈ 11–15%, or M trains on fewer than 20·N tokens, or the allowlist grows ≈ 3.5–4.5×. No source is padded with lower-quality material to fill the gap.

The context is 2,048 throughout. A short-context warmup (the first 2% of tokens at 512) is kept as an option if early training proves unstable.

### 3.5 Eval contamination control

This follows [SEPIA-1-data.md §6.1 and §6.6](./SEPIA-1-data.md) (SEPIA-1 eval v0). That document defines two holdouts:

- **Repository holdout**: about 16 repositories never enter the code index.
- **Time holdout**: landmark repositories that stay in training are pinned to a commit from before an audited change. Evaluation uses only the files that change introduced.

On top of that, the shard builder applies:

- **Forks and copies of held-out code**: any training file with MinHash Jaccard ≥ 0.5 against a held-out file is dropped. This catches copies under other repository names.
- **Web corpus scan before training**: drop records that name a held-out protocol together with a report URL, or that share 64-byte shingles with evaluation code. The same shingle scan runs over every shard.
- **Reports behind evaluation items**: audit reports, incident entries and advisories now enter training ([§3.6](#36-license-policy-and-tracking)). Any of them that describes an evaluation item is dropped from training and from the M5 fine-tune, by URL and path.
- **Canary GUIDs**: every evaluation file carries one, so leakage into a future corpus can be detected.
- **A frozen corpus snapshot**: training data is frozen at a recorded date, and time-holdout items come only from audits published after it.
- **Published per release**: a decontamination report (counts removed per rule), the corpus snapshot hash and the evaluation manifest hash.

### 3.6 License policy and tracking

**Policy (owner decision, 2026-10-05).** SEPIA-1 learns from the data; it does not republish it. Repositories are not excluded by license. All four tiers of `LicenseTier` (`shared/codebase.ts`) are used for training:

| Tier | Licenses | Examples |
|---|---|---|
| permissive | MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Unlicense, CC0-1.0, Zlib, BSL-1.0 and others | OpenZeppelin Contracts, Solady, cosmos-sdk, agave |
| copyleft | GPL, LGPL, AGPL, MPL-2.0, EPL-2.0, EUPL-1.2 (incl. -only / -or-later) | Uniswap v2, Uniswap v3 periphery, Lido, Maker (dss), Balancer v2, Solmate |
| source-available | BUSL-1.1 and other licenses that publish source with use restrictions | Uniswap v4 core contracts, Aave v3, Uniswap v3 core (see "Recorded as written") |
| unknown | no license file (`none`), a text that is not recognised (`NOASSERTION`), `UNLICENSED` headers | Uniswap v4 core test files, DeFiHackLabs PoCs |

- **BUSL and other source-available code** is included for training under the same reasoning as copyleft: the model learns from the code.
- **The tier describes a file; it does not filter it.** The mapping from SPDX ids to tiers lives in `server/codebase/licenses.ts`.
- **License is never the reason a repository is skipped.** A repository is skipped when it is not public (HTTP 404 / 451 from the archive while the git ref advertisement does not list it either, or 404s for more than a day; checked again after a day), when its root LICENSE or README explicitly forbids machine-learning or AI training, or when it does not fit: an archive over the per-archive download limit (120 MB compressed, 1 GiB uncompressed), or an entry past the 150 MB cap (the allowlist is filled in priority order, so lower-priority entries wait with the note `cap`, shown on the Sepia page as "total size cap reached"; an entry that fits only in part keeps what fit, with the note `partial (cap)`). Each skip is recorded with its reason (`status: 'skipped'`, `note`).

**Tracking.** The license record follows each file from the code index to the model card:

1. **Code index.** Per repository, `CodeRepoInfo`: repo, commit, license, tier, status, note. Per file, the shard record: repo, commit, path, language, license, tier, bytes, sha256. A file's own `SPDX-License-Identifier` header is recorded as its license; a file without one takes the license of the nearest LICENSE file in its folder or a parent folder, else the repository's license. For example, GitHub reports no repository license for Uniswap v4-core, and its 130 Solidity files declare MIT (44), BUSL-1.1 (8), UNLICENSED (77) and GPL-3.0-or-later (1) (survey of 2026-10-05). Each file keeps its own id.
2. **Shard manifest.** Per row range: repo, commit, path, SPDX id and tier. For web rows: page id and host.
3. **Model card.** Every repository with commit, license, tier, files, bytes, tokens trained and epochs. Totals per tier. Every skipped repository with its reason. The full per-file manifest as JSON.

- **Recorded as written.** The record is what the files say at the indexed commit. The LICENSE file of Uniswap v3 core is still the BUSL-1.1 text, although its change date has passed (GPL-2.0-or-later by 2023-04-01 at the latest); it is recorded as BUSL-1.1, because that is the text in the tree. Aave's indexed repository, `aave-dao/aave-v3-origin`, is BUSL-1.1 for the licensed work "Aave v3.7", with a change date that has not passed (the earlier of 2027-03-06 and the date in the `v37.aavelicense.eth` record; change license MIT). Solmate's root LICENSE defers to each file's SPDX header, which the per-file record captures. Header spellings are normalised (`Apache 2`, `Apache-2.0.` → `Apache-2.0`); a header that only points elsewhere (`SEE LICENSE IN LICENSE`, `None`, `NOASSERTION`) is not taken as the file's license, so the nearest LICENSE file applies.
- **Notices.** The manifest ships the license texts, and shards sent to neurons carry the notices, since permissive and copyleft licenses require them to be kept.
- **Shards stay private.** A shard is a copy of the text. Shards go only to neurons, by short-lived URL ([§4.3](#43-compression)). The public release is the weights, the tokenizer, the manifest (no text) and the eval results.
- **Removal.** A repository taken off the allowlist has its shards deleted the next time the server starts (`server/codebase/index.ts`), and it is absent from the next data version. Weights already trained do not change.

---

## 4. Distributed training on browser GPUs

### 4.1 Why the current scheme does not scale

Today each job sends one f16 gradient per optimizer step. At SEPIA-1 sizes, with 16,384 tokens per step on an ABYSSO-class device (6,500 GFLOPS benchmark, 25% usable):

| | S | M | L |
|---|---|---|---|
| Gradient per step (f16, 2 bytes × N) | 51.5 MB | 123.5 MB | 248.6 MB |
| Compute per step | 2.0 s | 4.6 s | 8.8 s |
| Upload needed to keep up | 203 Mbit/s | 214 Mbit/s | 225 Mbit/s |
| Upload per hour | 91 GB | 96 GB | 101 GB |

The same volume again flows down as weights. Residential uplinks are typically 10–50 Mbit/s, so they are 4–20× too slow. Six such neurons would also push more than 1 Gbit/s into a 1-CPU server.

### 4.2 Local inner steps and outer sync

SEPIA-1 follows DiLoCo (Douillard et al. 2023; open implementations: OpenDiLoCo, INTELLECT-1). Each neuron runs **H inner AdamW steps** locally from the current global weights, then returns one **pseudo-gradient** Δ = θ_start − θ_end. The server averages the accepted Δs and applies an outer Nesterov step.

**Work unit.** The coordinator issues units, not batches:

```
unit = { id, baseVersion, baseSha256, shardSha256, slice: [rowStart, rowEnd),
         seed, H, tokensPerStep: 16384, microBatch, innerLr, sketchSeed, deadline }
```

- **Fixed H per model size**: S 128, M 64, L 48. H is global, not per device, so redundant twins run identical work and pseudo-gradients have comparable scale when averaged. H is the main knob trading bandwidth against convergence; M3 measures loss against H.
- **16,384 tokens per inner step**: 8 sequences of 2,048. Micro-batches with gradient accumulation are sized to the device's memory; the result does not depend on micro-batch size, apart from summation order, which is fixed.
- **Fresh inner AdamW state per unit**, with an 8-step linear LR warmup inside the unit. A unit is then fully determined by its spec, so any twin can reproduce it. Keeping per-device inner state in IndexedDB would converge somewhat better but breaks twin comparison; it is tested as an ablation in M3.
- **Async outer steps**: about every 10 minutes, or earlier once enough units have arrived. A unit whose base is s outer versions old (s ≤ 3) is applied with weight 1/(1+s). Older units are verified and credited, not applied, the same rule as today's `stale` verdict at 64 versions. Async Local-SGD for language models is studied in Liu et al. (2024).
- **Aggregation**: token-weighted mean of accepted Δs. Each Δ is first clipped to at most 2× the running median norm of accepted units at that version (poisoning damping, [§5.8](#58-what-redundancy-does-not-solve)). Of a redundant pair, one result is applied.

Unit wall time at 25% of benchmark. A unit must finish within a **30-minute** deadline:

| Tier (representative benchmark) | Step time S / M / L | Unit S (H 128) | Unit M (H 64) | Unit L (H 48) |
|---|---|---|---|---|
| EPI (250 GFLOPS) | 52.8 / 120 / 230 s | 113 min ✗ | 128 min ✗ | 184 min ✗ |
| MESO (1,000) | 13.2 / 30 / 57.5 s | 28 min ✓ (marginal) | 32 min ✗ | 46 min ✗ |
| BATHY (2,500) | 5.3 / 12 / 23 s | 11 min ✓ | 13 min ✓ | 18 min ✓ |
| ABYSSO (6,500) | 2.0 / 4.6 / 8.8 s | 4.3 min ✓ | 4.9 min ✓ | 7.1 min ✓ |
| HADAL (12,000) | 1.1 / 2.5 / 4.8 s | 2.3 min ✓ | 2.7 min ✓ | 3.8 min ✓ |

Eligibility is decided by **measured** unit time and a memory probe ([§4.5](#45-memory-per-tier)), not by the zone label.

### 4.3 Compression

**Upload (pseudo-gradient), v1: dense int8.**

- Blocks of 256 values, each with one **power-of-two** scale chosen from the block's largest exponent. This is the trick `encodeGrad` uses per tensor today: scaling is exact and dequantization is bit-identical everywhere.
- **Stochastic rounding seeded from the unit spec**: unbiased, and still reproducible by a twin.
- ≈ N bytes per unit. There is no client-side state, which keeps verification simple.

**Upload, v2 (only if uplink is measured to be the bottleneck): top-k + error feedback.**

- Keep the top 1% of |Δ| per tensor. The threshold comes from an exponent histogram, which is deterministic. Values are int8 and indices delta-coded, about 3 bytes per kept value.
- **Error feedback** (Stich et al. 2018; Karimireddy et al. 2019): the dropped remainder is added to the next unit's Δ on the same device.
- The residual is device state, so twins would no longer match. Each unit therefore commits sha256(residual), and the device must reveal the residual when the unit is audited.
- Decoupled momentum optimization (Peng et al. 2024) is an alternative family: DCT-domain top-k on momentum.

**Download (global update): int8 delta with server-side error feedback.**

- The canonical global weights are *defined* as the running sum of the dequantized int8 deltas. Every client and the server therefore hold bit-identical base weights, which twin comparison and audits need.
- The server keeps one residual buffer.
- A neuron that is several versions behind downloads the chain of deltas or one f16 snapshot, whichever is smaller.

Per unit and per hour:

| | S | M | L |
|---|---|---|---|
| Upload per unit, int8 | 26.1 MB | 62.7 MB | 126.2 MB |
| Upload per unit, top-1% (v2) | 0.77 MB | 1.85 MB | 3.73 MB |
| Download per unit: global delta + data slice | 26.1 + 4.2 MB | 62.7 + 2.1 MB | 126.2 + 1.6 MB |
| Full f16 snapshot (newcomers) | 51.5 MB | 123.5 MB | 248.6 MB |
| Upload reduction vs per-step f16 (int8 / top-1%) | 252× / 8,533× | 126× / 4,267× | 95× / 3,200× |
| **BATHY neuron**: up / down per hour (int8) | 139 / 161 MB (0.31 Mbit/s avg up) | 294 / 303 MB | 411 / 417 MB |
| **ABYSSO neuron**: up / down per hour (int8) | 362 / 420 MB (0.8 Mbit/s avg up) | 763 / 789 MB (1.7 Mbit/s) | 1,070 / 1,083 MB (2.4 Mbit/s) |
| Upload per hour with top-1% (BATHY / ABYSSO) | 4.1 / 10.7 MB | 8.7 / 22.5 MB | 12.2 / 31.6 MB |

**Hosting.** Production caps job-payload egress at `LUSCA_ISSUE_MB_PER_SEC = 1` (`render.yaml`). About 8 ABYSSO-class neurons on S would use that whole budget for downloads alone.

- Weights and shards are therefore served as **content-addressed blobs from object storage**, at a provider without egress fees (for example Cloudflare R2).
- Training shards contain the source text, so they stay private: the coordinator hands each neuron sha256 + a short-lived signed URL, and shards are never listed publicly ([§3.6](#36-license-policy-and-tracking)). Public release artifacts (weights, tokenizer, manifest without text) go to the Hugging Face Hub ([§7.4](#74-release-artifacts)).
- Neurons verify the hash before use.
- Server ingress stays modest: 6 ABYSSO-class neurons on S upload ≈ 2.2 GB/h ≈ 0.6 MB/s, which is fine for one Node process. Dequantizing and accumulating one S payload costs tens of milliseconds.

### 4.4 Shards and assignment

- **Shard**: `shard-<sha256>.bin` (u16 little-endian token ids in 2,048-token rows) with `shard-<sha256>.json` (row ranges → source documents and licenses, [§3.6](#36-license-policy-and-tracking)). A shard is about 4M tokens, or 8 MB.
- **Schedule**: a deterministic order of (mixture component, shard, slice) from a published seed, so the data order can be reproduced. Phase weights switch at global token counts.
- **Assignment**: each unit takes the next unassigned slice. A redundant twin gets the same slice, seed and base. Slices from failed or timed-out units go back to the front of the queue. A slice counts as consumed only when its unit is applied.
- **Within a unit**: the order of micro-batches comes from `mulberry32(seed)`, the PRNG already in `shared/sepia/model.mjs`.

### 4.5 Memory per tier

Training memory on the GPU = **16 bytes × N** (f32 weights, gradients, AdamW m and v) + activations. The figures below assume per-layer activation recomputation, f16 activation storage, tiled attention (no T×T matrix) and cross-entropy in 256-token chunks (never materializing all logits). b is the number of 2,048-token sequences per micro-batch.

| | State (16N) | Total b = 1 | b = 2 | b = 4 | Activations without recompute (b = 2) |
|---|---|---|---|---|---|
| S | 0.41 GB | 0.54 GB | 0.60 GB | 0.72 GB | +0.53 GB |
| M | 0.99 GB | 1.16 GB | 1.26 GB | 1.46 GB | +1.0 GB |
| L | 1.99 GB | 2.21 GB | 2.36 GB | 2.66 GB | +1.5 GB |

Without `shader-f16`, activation memory doubles. The CPU side of the tab also holds θ_start (4N) to form Δ.

WebGPU does not report VRAM, so the zone VRAM labels in `shared/protocol.ts` are guidance only. Before accepting units, a neuron allocates its full plan inside an `out-of-memory` error scope and runs one timed inner step, the same pattern `bench.ts` uses for sizes.

| Tier (`ZONES`) | Typical memory | S | M | L | Role |
|---|---|---|---|---|---|
| EPI (< 400 GFLOPS) | integrated / ≤ 6 GB | fits, too slow for the deadline | — | — | eval (forward-only), data jobs, the existing dedupe jobs |
| MESO (400–1,500) | 8 GB | ✓ (upper half of the band) | fits, marginal on time | fits, too slow | S training, eval |
| BATHY (1,500–4,000) | 12–16 GB | ✓ | ✓ | ✓ | S, M, L |
| ABYSSO (4,000–9,000) | 24 GB | ✓ | ✓ | ✓ | S, M, L |
| HADAL (≥ 9,000) | 48 GB+ | ✓ | ✓ | ✓ | S, M, L |

### 4.6 WebGPU kernel work

These extend `src/lib/gpu/train/kernels.ts`. A plain-JavaScript reference implementation (M1) is the ground truth for parity tests at small shapes.

1. **Matmul**: reuse the 64×64 tiled kernel with its transpose flags and split-K partials. Add epilogues for residual add, fused SwiGLU and RoPE on the Q/K projections. Add an f16-operand variant with f32 accumulation behind `shader-f16`.
2. **RMSNorm** forward and backward: one workgroup per row, a fixed-tree reduction.
3. **RoPE** forward and backward: elementwise rotation from a precomputed cos/sin table.
4. **Causal attention, tiled** (FlashAttention-2 style, Dao 2023):
   - **Forward**: online softmax and a saved logsumexp per row; skips fully masked tiles.
   - **Backward**, deterministic, without atomics: one pass parallel over key tiles produces dK and dV, a second pass parallel over query tiles produces dQ. The extra recompute buys determinism.
   - **Tile sizes** must fit `maxComputeWorkgroupStorageSize`, which is 16 KB by default. With f32 and head dimension 64, that allows 32×32 K/V tiles (8 KB each); devices that grant 32 KB use larger tiles.
5. **Fused LM head + cross-entropy** over 256-token chunks: logits, loss, d(hidden) and the tied-embedding gradient, without materializing B×T×32,768 logits.
6. **Embedding gradient by sort.** Today's `EMBGRAD` scans every position for every (token, dim) pair, which is fine at V = 96 but ≈ 1.7×10¹¹ compares at V = 32,768. Replace it with a deterministic counting sort of positions by token id, followed by fixed-order segment sums.
7. **SwiGLU** forward and backward (elementwise, fused).
8. **Fused AdamW** per tensor buffer, with global grad-norm clipping computed by a two-stage fixed-order reduction.
9. **Pseudo-gradient pipeline**: Δ, int8 block quantization with seeded stochastic rounding, optional top-k by exponent histogram, and weight sketches (256 seeded random projections every 16 inner steps, [§5.2](#52-redundant-assignment)). Sketch cost is ≈ 256·N multiply-adds, negligible against a 3.3 TFLOP step.
10. **Scheduling and memory**: a buffer planner and per-tensor buffers ≤ 128 MiB. Each submit stays inside the existing ~150 ms budget (Windows resets GPUs that stall for about 2 s), so a step is split across several submits, layer by layer.

### 4.7 CPU desktop neurons and small devices

A 2 GFLOPS CPU neuron is about 0.03% of today's pool. Its useful role is data work, not training:

- **Data preparation**: tokenizing candidate shard text and computing MinHash signatures for near-duplicate clustering. This work is integer-only, so it is verified by giving the same job to two neurons and comparing hashes exactly, which is cheap and conclusive.
- **Small eval jobs**: forward-only scoring of short held-out sets. An S forward pass is 67M FLOPs per token, so a few minutes per 2,048-token sequence on a CPU. Better suited to EPI GPUs.
- **The existing dedupe jobs** continue.
- **A tiny pipeline-check model** (a few million parameters, short context) lets the full unit protocol run end to end on any device during M3.

### 4.8 Server side: memory and disk

The coordinator holds the canonical weights, outer momentum, an accumulator and the broadcast residual: **16 bytes × N** of RAM. A checkpoint holds weights, momentum and residual (**12 bytes × N**) and is written with a `.bak` copy, as `sepia.ckpt` is today.

| | Server RAM | Checkpoint | With `.bak` | Fits today's box (2 GB RAM, RSS 740 MB; disk 568 MB free)? |
|---|---|---|---|---|
| S | 412 MB | 309 MB | 618 MB | RAM yes. Disk only after freeing space (see below) |
| M | 988 MB | 741 MB | 1,482 MB | No. Needs a larger instance and disk |
| L | 1,988 MB | 1,491 MB | 2,983 MB | No |

Required before M3, even for S:

- Move tokenized web text and shards to object storage, and lower `LUSCA_DATASET_KEEP` or grow the disk.
- Retire the SEPIA-0 training loop when SEPIA-1's outer loop starts, to free CPU and RAM. Its checkpoint is kept as history.

---

## 5. Verification on a 1-CPU coordinator

### 5.1 Why recomputation no longer works

- The server's JavaScript trainer reaches about 0.42 GFLOPS at duty 0.6 (5.9 steps/s × 64 × 1,105,920 FLOPs), or about 0.7 GFLOPS for a full core.
- One S inner step is 3.3 TFLOP, about **1.3 hours** of that core.
- One S unit (128 steps) is about **7 days**.
- Training S on the server alone would take about 5 years of the whole core.

Today's full audit (recompute and compare) therefore cannot be carried over.

### 5.2 Redundant assignment

**Policy** (parameters as today):

- An identity's first **3** units are always duplicated (`FORCE_AUDIT_JOBS = 3`).
- After that, **20%** of units are duplicated at random (`LUSCA_TRAIN_AUDIT_P = 0.2`).
- A duplicated unit goes to two neurons that differ in device id, wallet and network (IPv4 /24, IPv6 /56). Where possible the pair also differs in GPU vendor, and both identities must have some account age.

**Blind.** Nothing in a unit spec reveals whether it is duplicated. Twins are issued at different times and have the same deadline as singles.

**What is compared:**

1. **Loss trace**: mean loss at each inner step. Twins start from the same weights and see the same batches, so early-step losses must agree closely.
2. **Weight sketches** every 16 inner steps: 256 seeded random projections of θ_k − θ_start. Cheap to compute and upload, and they catch a run that went off-course or skipped steps.
3. **Final payload**: cosine and relative error of the dequantized Δs.

**Same device class** (same vendor, architecture and kernel version) is expected to produce bit-identical payloads, so it is compared by hash. Any mismatch falls back to the tolerance comparison, because drivers can still differ.

**Disagreement.** The unit goes to a third independent neuron and the majority wins. The outlier gets a strike and forfeits its escrow. If all three disagree, nobody is penalized, the unit is discarded (or replayed on a server GPU, [§5.5](#55-optional-server-gpu)), and the thresholds are flagged for review.

**Detection math.**

- With p = 0.2, 20% extra unit executions buy a 2p / (1 + p) = **1/3** chance that any executed unit is part of a pair.
- A neuron faking n units is caught with probability 1 − (2/3)ⁿ:

| Faked units | 1 | 3 | 5 | 10 |
|---|---|---|---|---|
| P(caught) | 33% | 70% | 87% | 98.3% |

- Credits are released only by a passed comparison, and a failure forfeits everything in escrow, so faking has negative expected value. The argument is the same as today's escrow.

### 5.3 Calibration gate

Tolerances are measured, not guessed. M3 cannot finish until this is done:

- Collect honest pairs across every vendor/architecture combination seen in the pool, at the chosen H for each size. Record the distributions of per-step |Δloss|, sketch cosine, and final cosine and relative error.
- Construct dishonest baselines: a different slice, H/2 steps scaled ×2, a base version 1–3 steps old, and honest Δ plus noise at 1% and 10% of its norm. **Each must separate from the honest distribution.**
- If they do not separate at the full H, compare sketches over a shorter early horizon, where honest trajectories are closest.
- Publish the thresholds and the measured distributions.

### 5.4 Server-side screens on every unit

These are cheap enough for the 1-CPU coordinator:

- The payload decodes and is finite.
- Per-tensor norms are within bounds relative to the running median of accepted units.
- The loss trace is plausible against the global loss curve.
- Norm clipping is applied before aggregation.
- **Sampled loss-drop check** (S only on today's box): evaluate θ_start and θ_end on two 256-token windows from the unit's slice and two from a control shard. The training windows must improve more than the control windows. This catches "did not train on this data" at about 1.1×10¹¹ FLOPs, or about 2.6 CPU-minutes per check, budgeted like today's `LUSCA_TRAIN_AUDIT_CPU`.

### 5.5 Optional server GPU

One rented datacenter GPU could replay sampled units with the same unit spec, for example in PyTorch with the Llama-compatible export. PyTorch and WGSL numerics still differ, so the comparison uses the same tolerances as cross-vendor twins.

- **Cost**: replaying 20% of today's pool work (7.8 TFLOPS × 25%) takes about **14 GPU-minutes per day** on a GPU that sustains 40 TFLOPS on bf16 training. The figure scales with pool throughput, not model size. It can run as a scheduled batch job; apply current hourly prices.
- **Benefit**: an independent anchor. It fixes the case redundancy cannot handle on a small pool (below) and costs contributors no extra compute.
- **For scale**: one such GPU sustains more than the entire pool's effective throughput today (≈2 TFLOPS). Growing the pool matters more than any kernel optimization.

### 5.6 What carries over

| Today | SEPIA-1 |
|---|---|
| First 3 results always fully audited | First 3 units always duplicated |
| 20% random full audits | 20% random duplication (+ optional server-GPU replay) |
| Cheap check on every result (64-row server gradient) | Cheap screens on every unit (decode, norms, loss trace, sampled loss-drop) |
| Escrow per strike identity; released by a passed audit, forfeited by a failed one | Unchanged; released by a passed comparison, forfeited by a lost comparison |
| Strikes and cooldowns keyed by device / wallet / IP | Unchanged |
| Verified but older than 64 versions → credited, not applied | Verified but older than 3 outer versions → credited, not applied |
| Credits = verified GFLOP × rate × zone bonus | Unchanged formula. FLOPs per unit = tokens × training FLOPs per token (§2.1); both twins credited |

Contributors are paid in SOL for credits, as today.

### 5.7 Cost and benefit

| Option | Extra compute | Detection per faked unit | Collusion resistance | Cost |
|---|---|---|---|---|
| A · redundancy only (p = 0.2) | +20% of pool work | 1/3 | Depends on pool diversity | None in money |
| B · server-GPU replay of 20% | 0% | 20% | Independent anchor | ~14 GPU-min/day at today's pool |
| C · A + B | +20% | 47% | Best | Both |

Recommendation: start with A. Add B if the pool stays concentrated in a few large devices.

### 5.8 What redundancy does not solve

- **Concentrated pools.** If one operator controls a share a of eligible capacity, a random pair is entirely theirs with probability ≈ a². Today one device is about three quarters of the pool, so for M and L units there may be no independent second neuron online at all. In that case credits stay in escrow until a comparison is possible, or option B provides the anchor.
- **Targeted poisoning.** A contributor who is honest on checked units and crafts harmful Δs on unchecked ones is caught at the same 1/3 rate per unit. Each harmful Δ is bounded by norm clipping and token weighting. Subtle backdoors in decentralized training remain an open research problem. This is stated in the model card.

---

## 6. Compute estimates

**Formula.** Total training compute ≈ 6·N·D (Kaplan et al. 2020), with D = 20·N tokens (the compute-optimal ratio from Hoffmann et al. 2022). The attention term at 2,048 is added explicitly (§2.1).

**Overheads:**

- ×1.2 for redundancy (p = 0.2);
- ×1.1 for local-update training needing somewhat more tokens than fully synchronous training. This is a planning margin, and M3 measures it.

**Pool.** The 7,798.7 GFLOPS benchmark snapshot.

**Utilization u.** The fraction of the benchmark that training kernels sustain. This is the single most uncertain number. The benchmark is a large square FP32 GEMM. Transformer steps mix smaller matmuls, attention and elementwise kernels, and recomputation adds work that does not count as model FLOPs. M2 measures u. The table shows 10%, 25% and 40%.

| | D (tokens) | 6ND | With attention | u = 10% | u = 25% | u = 40% |
|---|---|---|---|---|---|---|
| S | 0.51 B | 7.9×10¹⁶ | 1.04×10¹⁷ | 2.0 d (4.1 d) | **0.8 d (1.6 d)** | 0.5 d (1.0 d) |
| M | 1.23 B | 4.6×10¹⁷ | 5.7×10¹⁷ | 11.1 d (22.2 d) | **4.4 d (8.9 d)** | 2.8 d (5.5 d) |
| L | 2.49 B | 1.85×10¹⁸ | 2.18×10¹⁸ | 42.7 d (85.5 d) | **17.1 d (34.2 d)** | 10.7 d (21.4 d) |

The first figure assumes today's pool online around the clock; the figure in parentheses assumes half of it on average. Wall time adds restarts, calibration and pool churn. Plan **1–2 weeks of calendar time for S** and **2–4 weeks for M**.

**Data limits.** With ≈ 290–390M unique tokens (§3.1 ranges: web 250–300M, code 35–46M from the current allowlist, expert analysis 2–44M; the upper end includes the audit reports at their estimated size):

| | Epochs needed for D = 20N |
|---|---|
| S | 1.3–1.8 (but 6–8 passes over code at a 50–60% code share, §3.4) |
| M | 3.2–4.3 (and 14–18 passes over code at that share) |
| L | 6.4–8.7, beyond the ~4-epoch guidance |

L is data-limited unless the curated code index grows: more landmark repositories on the allowlist, then a higher `LUSCA_CODE_MAX_MB` with more disk. Padding it with clones would defeat the purpose.

**Per-neuron bandwidth per hour.** See the table in §4.3. In short, an ABYSSO-class neuron uploads 0.4–1.1 GB/h with dense int8, or 10–32 MB/h with top-1%. A BATHY-class neuron uploads roughly 40% of that. Downloads are about the same as dense uploads, served from object storage.

**Today, for comparison.** SEPIA-0's GPU path delivers 1.0–1.5 GFLOPS of useful work (measured 2026-10-07, §0). At that rate S (1.04 × 10¹⁷ FLOP) would take about 820–1,180 days. In practice the per-step scheme at S size would run out of bandwidth long before that (§4.1), so the redesign is required, not optional.

---

## 7. Evaluation

Every checkpoint released as a SEPIA-1 version runs the same suite: **SEPIA-1 eval v0**, defined in [SEPIA-1-data.md §6](./SEPIA-1-data.md). This section covers how it plugs into training and release. Results are published on lusca.ink/sepia and on Hugging Face.

### 7.1 Held-out protocol set

- **Candidate pool**: 24 protocols, stratified EVM 14, Solana 5, Cosmos/Go 3, Move 2, and spread across the code-index categories.
- **Holdouts**: a repository holdout and a time holdout (§3.5).
- **Items** are built from code at pinned commits (license recorded in the evaluation manifest), factual labels written by maintainers, and CC-BY/CC0 advisory text. No report wording is copied, and reports that describe an item are kept out of training (§3.5).
- **Results** are reported per task, language, ecosystem and category.

### 7.2 Tasks and how SEPIA-1 is scored

| ID | Task | Metric | Chance | What it measures for SEPIA-1 |
|---|---|---|---|---|
| T1 | Held-out code modelling | bits per byte, per language | — | Can it read the languages at all |
| T2 | Find the vulnerable function (label + 4 functions) | top-1, MRR | 25% | Locating a described issue |
| T3 | Classify a finding (8 classes; Solana-specific classes) | accuracy, macro-F1 | 12.5% | Vulnerability-class recognition |
| T4 | Vulnerable vs. fixed (advisory + function before/after the fix) | accuracy | 50% | Sensitivity to the actual fix |
| T5 | Architecture (1 correct description of 4) | accuracy | 25% | Describing a protocol from its code |
| T6 | Explain a function (stretch) | 0–3 rubric, 2 raters, Cohen's κ | — | Free-text explanation (after the M5 fine-tune) |

**Scoring.** T2–T5 pick the candidate with the highest mean per-byte log-probability, so a base model with no instruction tuning can be scored, and every item fits the 2,048-token context. BPB in T1 does not depend on the tokenizer, so models with different vocabularies are comparable.

**Baselines** (from SEPIA-1-data.md):

- chance;
- SEPIA-0;
- a byte-level n-gram model trained on the same SEPIA-1 corpus;
- for T1, `zstd -19` with a dictionary trained on the training split.

Optionally, small public models with permissive licenses are added as reference points, with the caveat that their training data probably includes our held-out repositories.

**Pass rule.** SEPIA-1 "reads code" on a task only if the lower bound of its 95% bootstrap interval (1,000 resamples) is above both chance and the n-gram baseline.

### 7.3 Additional measurements in this design

- **Docstring reconstruction** (automatic, every checkpoint). Remove the NatSpec (`@notice`, `@dev`) or Rust/Move `///` comment from held-out functions and score the conditional BPB of the original comment given the function. It is cheap, deterministic, and tracks explanation ability before any fine-tune.
- **Per-checkpoint T1 on a small fixed subset during training.** This runs as forward-only eval jobs on EPI GPUs (§4.7), so loss on held-out code is visible on lusca.ink while training runs, not only at release.
- **Honest expectation.** Models of 25–120M parameters will probably be near chance on the subtler T3 classes and on T6. The numbers are published either way, as the baseline later versions must beat.

### 7.4 Release artifacts

Published on Hugging Face (organization name to be decided):

- `model.safetensors` in f32, plus an f16 copy;
- `config.json` (Llama-compatible) and `tokenizer.json`;
- the model card with:
  - the data manifest summary and full manifest JSON (repo, commit, license, tier, files, bytes, tokens, epochs; per-file path and SPDX id; totals per tier; skipped repositories with their reasons), without the text itself (§3.6);
  - the decontamination report, corpus snapshot hash and evaluation manifest hash;
  - eval JSON per task with bootstrap intervals;
  - a training summary: tokens, FLOPs, outer steps, contributors, units, redundant pairs, disagreements, forfeits;
  - known limitations;
- `SHA256SUMS`.

lusca.ink/sepia shows the same eval table per version, with the sha256 of each file.

---

## 8. Milestones

Durations are engineering estimates for the current team. M2 carries the most uncertainty.

### M0 · Code index collecting (now)

The `server/codebase` priority-ordered allowlist (all licenses), license recording per repository and per file (the allowlisted SPDX id checked against the LICENSE file in each fetched archive, per-file SPDX headers; `none` or `NOASSERTION` when unknown), filters, the 150 MB cap on gzip shards, and `GET /api/code/stats`.
**Done when**: every allowlist entry is either indexed (`status: ok`) or skipped with its reason recorded (size cap, not public, explicit ML-training prohibition), and the stats show bytes per language and ecosystem.
**Duration**: ongoing. The first usable snapshot arrives once the allowlist is fetched.

### M1 · Tokenizer and reference implementation — 2–3 weeks

- **Done (2026-10-06):** the tokenizer trained (vocab, merges, sha256), with a bytes-per-token report per language (§2.3). Publishing it to the Hugging Face Hub is prepared (`scripts/hf/build-tokenizer-release.mjs`), not yet uploaded.
- `shared/sepia1/`: a plain-JavaScript reference forward and backward for the transformer, with a float64 option for gradient checks, used as ground truth for kernels at small shapes. Same role as `shared/sepia/` today.
- The shard builder and manifest format. Web text exported before it rotates out, then scanned for held-out material (§3.5) and frozen at a recorded date.
- An offline reference run of a small config on the same shards (PyTorch, owner's machine), to know what a correct loss curve looks like before trusting the distributed run.
- Small ablations: fill-in-the-middle on/off, the LR sweep.

### M2 · WebGPU transformer kernels and inner steps in the browser — 6–8 weeks

- The kernels in §4.6, with parity against `shared/sepia1` at small shapes. Same device must give bit-identical repeats.
- The memory planner and probe; submits within the time budget.
- Measured u per vendor, which replaces the planning value in §6.
- **Done when**: a browser completes a full S unit and its Δ matches the reference within tolerance.

### M3 · Redundant verification and outer sync live — 4–6 weeks

- Work units, pairing, sketches, int8 compression, outer Nesterov, async staleness, escrow integration, object-storage hosting.
- The calibration gate (§5.3) passed and its thresholds published.
- A closed run of the tiny pipeline-check model, then of S, on the live pool.
- SEPIA-0 training retired.

### M4 · First SEPIA-1 checkpoint, evaluation and Hugging Face release — 3–5 weeks

- Training S: 1–2 weeks of calendar time at today's pool.
- The evaluation suite (§7), model card, decontamination report, safetensors and sha256.
- **Then**: M on the same pipeline (2–4 weeks calendar), and L only if data and pool grow (§6).

### M5 · "Read a protocol" — 6–8 weeks after M4

- **Explanation fine-tune** on real, human-written pairs only:
  - function ↔ NatSpec/doc comment, from the code index (any license, recorded per file);
  - code ↔ guide, advisory or audit-report text, from the security sources in SEPIA-1-data.md §5 (Code4rena-derived text excluded);
  - repository ↔ its own docs.
  No machine-generated explanations unless the owner decides otherwise (§9). T6 and T5 items, and reports that describe any evaluation item, are excluded from fine-tune data.
- **Ingestion**: public repository, verified-source registry, or Solana program; parsing into files and functions; license shown to the user.
- **Inference in the visitor's browser** on WebGPU, reusing the M2 forward kernels plus a KV cache. The server only serves weights from object storage.
- **Citations** to file and line, from the spans the system fed the model.
- **Quality gate**: ships only when T6 (explain a function) and docstring reconstruction on the held-out set meet the bar the owner sets (§9). Output is labelled as machine-generated and not an audit.

**Total to M5: roughly 5–7 months**, if M2 lands within its range.

---

## 9. Risks and open questions

Open owner decisions: the license for the released weights (item 2), an optional rented verification GPU (item 4) and the quality bar (item 6). The training-data license policy is decided (item 1).

1. **Training-data licenses (decided 2026-10-05).** All licenses are used: permissive, copyleft, source-available (BUSL) and none. The owner's reasoning is that the model learns from the data and does not copy it. Licenses are recorded per repository and per file and listed in the model card (§3.6). Whether weights trained on copyleft, BUSL or unlicensed code carry obligations is not settled law, and this document does not give legal advice. Three parts of the design follow from the policy:
   - training shards contain the text, so they stay private (§4.3);
   - a repository taken off the allowlist leaves the next data version;
   - sources whose terms explicitly forbid ML training (Code4rena) are excluded.
2. **License for the weights (owner).** The training data includes copyleft, BUSL and unlicensed code. MIT (matching the repository) or Apache-2.0 follow the owner's position that the weights are not a copy of the training files. A license that passes use restrictions on is the alternative. Decide before the M4 release.
3. **Compute sufficiency.** The pool is one snapshot, with one device at about three quarters of it. u is unmeasured. Availability over a day is unknown (49 contributors in 24 h, 6 online at the snapshot). S is feasible on almost any reasonable assumption. M is feasible. L is not, at today's pool and data.
4. **Verification on a small pool.** Cross-vendor tolerances must separate honest from dishonest work (§5.3), and that is not yet shown. With a concentrated pool, independent pairs may not exist for M and L units (§5.8). The fallback is escrow-until-checkable or a server GPU. **Optional rented verification GPU (owner):** about 14 GPU-minutes per day at today's pool (§5.5), recommended if the pool stays concentrated (§5.7).
5. **Convergence with local steps.** Fresh inner optimizer state per unit, fixed H across very different devices, async staleness and int8 pseudo-gradients each cost some quality. M3 measures the total against the offline reference curve from M1.
6. **Quality bar (owner).** Small models produce fluent but often wrong explanations. Proposal:
   - a release counts as "reads code" on a task only by the pass rule in §7.2;
   - M5 ships only if ≥ 60% of graded T6 explanations score 2 or 3 on the 0–3 rubric and ≤ 15% score 0.

   The owner sets the final numbers. Vulnerability-class results (T2–T4) are published but not presented as detection.
7. **Code volume (owner).** The 110-entry allowlist is estimated at ≈ 139 MB of text, ≈ 35–46M tokens, and ≈ 29 MB of gzip shards: a fifth of the 150 MB cap. That is below the 80–130M tokens the mixture in §3.4 was planned for. S at a 50–60% code share would repeat code 6–8 times (§3.4), M 14–18 times. Choices: grow the allowlist (more landmark repositories, or wider include paths such as tests in repositories already listed; the cap has room for ≈ 4–5× more), or lower the code share (S ≈ 27–36%, M ≈ 11–15%). Padding with clones is not an option.
8. **Fine-tuning and security text.** Under the license policy, the audit-report repositories (more than 1,400 PDFs) can be used for pretraining and the M5 fine-tune. Their text volume is unmeasured, PDF-to-text conversion must run off the Render box, and Code4rena-derived text stays out. Reports that describe evaluation items are kept out of both (§3.5). Machine-generated explanations would scale but conflict with the real-data policy; the default is no.
9. **Infrastructure.** S fits the current Render instance only after disk is freed. M and L need more RAM and disk. Object storage becomes a dependency for weights and shards.
10. **Browser constraints.** Tabs close mid-unit (the unit is simply reissued). Integrated and mobile GPUs throttle. `shader-f16` and raised limits are not universal, and WebGPU availability differs across browsers.
11. **Baseline contamination.** Public models used as reference points were likely trained on GitHub, including our held-out repositories. Their scores are reported as such.

---

## Appendix A — formulas and assumptions

| Symbol / quantity | Definition |
|---|---|
| N | Total parameters including the tied embedding = L·(4d² + 3·d·ff + 2d) + d + V·d |
| Training FLOPs per token | 3 × [2·L·(4d² + 3·d·ff) + 2·d·V + L·4·d·(T/2)]: matmuls, LM head and causal attention (masked tiles skipped), with the backward pass = 2 × forward |
| Tokens per inner step | 16,384 = 8 × 2,048 |
| Representative tier benchmarks | EPI 250 · MESO 1,000 · BATHY 2,500 · ABYSSO 6,500 · HADAL 12,000 GFLOPS |
| u | Sustained fraction of the FP32 GEMM benchmark; 25% unless stated |
| Per-step gradient (today's scheme) | 2·N bytes (f16) |
| int8 pseudo-gradient | N·(1 + 4/256) bytes (int8 plus one 4-byte scale per 256 values) |
| Top-1% pseudo-gradient | 0.01·N × 3 bytes |
| Data slice per unit | H × 16,384 × 2 bytes |
| GPU training memory | 16·N + L·b·T·d·2 (stored layer inputs) + 34·b·T·d·2 (one layer's working set) + 2 × 256·V·4 (CE chunk) |
| Server RAM / checkpoint | 16·N / 12·N bytes |
| Compute | FLOPs per token × D, D = 20·N, × 1.2 (redundancy) × 1.1 (local-update margin) ÷ (7,798.7 GFLOPS × u) |
| Detection | Executed unit in a pair with probability 2p/(1+p); P(caught after n fakes) = 1 − (1 − 2p/(1+p))ⁿ |
| Server CPU throughput | 5.9 steps/s × 64 × 1,105,920 FLOPs ≈ 0.42 GFLOPS at duty 0.6 (≈ 0.7 GFLOPS per full core) |
| SEPIA-0 effective GPU throughput | 920–1,327 samples/s (production counters, 2026-10-07) × 1,105,920 FLOPs ≈ 1.0–1.5 GFLOPS delivered. The earlier figure of 4.3 GFLOPS (312 steps/min × 745 avg batch) assumed the peak step rate for every minute |

## Appendix B — references

- Douillard et al., 2023. *DiLoCo: Distributed Low-Communication Training of Language Models.* arXiv:2311.08105.
- Jaghouar, Ong, Hagemann, 2024. *OpenDiLoCo: An Open-Source Framework for Globally Distributed Low-Communication Training.*
- Prime Intellect, 2024. *INTELLECT-1 Technical Report.*
- Liu et al., 2024. *Asynchronous Local-SGD Training for Language Modeling.*
- Peng, Quesnelle, Kingma, 2024. *Decoupled Momentum Optimization.*
- Stich, Cordonnier, Jaggi, 2018. *Sparsified SGD with Memory.*
- Karimireddy et al., 2019. *Error Feedback Fixes SignSGD and other Gradient Compression Schemes.*
- Kaplan et al., 2020. *Scaling Laws for Neural Language Models.*
- Hoffmann et al., 2022. *Training Compute-Optimal Large Language Models.*
- Muennighoff et al., 2023. *Scaling Data-Constrained Language Models.*
- Korthikanti et al., 2022. *Reducing Activation Recomputation in Large Transformer Models.*
- Dao, 2023. *FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning.*
- Su et al., 2021. *RoFormer: Enhanced Transformer with Rotary Position Embedding.*
- Shazeer, 2020. *GLU Variants Improve Transformer.*
- Zhang, Sennrich, 2019. *Root Mean Square Layer Normalization.*
- Liu et al., 2024. *MobileLLM: Optimizing Sub-billion Parameter Language Models for On-Device Use Cases.*
- Bavarian et al., 2022. *Efficient Training of Language Models to Fill in the Middle.*
- Lee et al., 2022. *Deduplicating Training Data Makes Language Models Better.*
- Srivastava, Arora, Boneh, 2024. *Optimistic Verifiable Training by Controlling Hardware Nondeterminism.*
