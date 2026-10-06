# SEPIA-1 tokenizer scripts

Milestone M1 of SEPIA-1 ([docs/SEPIA-1.md §2.3](../../docs/SEPIA-1.md#23-tokenizer)): a 32,768-entry code-aware byte-level BPE.
Results and artifacts: [`models/sepia-1-tokenizer/`](../../models/sepia-1-tokenizer/).

Requirements: Node 24 (repository dependencies), Python 3.12 with `tokenizers` 0.20.3. Nothing else.

| File | Role |
|---|---|
| `spec.py` | Special tokens and the two-stage pre-tokenizer (single source for the Python scripts) |
| `fetch-code.ts` | Runs the code index (`server/codebase`) once over the whole allowlist and exits |
| `prepare.py` | Held-out split (decided before training) and the seeded training sample; writes the data manifest |
| `train.py` | Trains the tokenizer; `--check` trains twice and requires a byte-identical tokenizer.json |
| `export_ids.py` | Python reference ids for every held-out document, and the committed parity fixtures |
| `eval.ts` | Bytes per token, tokens per 1,000 lines and lines per 2,048-token window against r50k, cl100k and o200k; TypeScript/Python parity and round trip on every held-out document |
| `finalize.py` | Writes MODEL_CARD.md and manifest.json from the measured results, copies the data manifest |
| `examples.py` | Regenerates the playground excerpts (`src/components/sepia/tokenizer/examples.ts`) with their source and license |
| `_test.ts` | Encoder parity (fixtures), round trip, special tokens, artifact hashes, playground smoke (part of `npm test`) |
| `data-manifest.json` | Sources, byte counts and sha256 of every input, the per-language sample, the held-out file list |

## Reproduce

```sh
DATA=/path/to/data          # any empty directory
WORK=$DATA/tokwork
LUSCA_DATA=$DATA npx tsx scripts/tokenizer/fetch-code.ts                 # ≈ 10 min, 110 codeload archives
python scripts/tokenizer/prepare.py --code $DATA/code --web <dataset.jsonl> --out $WORK --total-mb 200
python scripts/tokenizer/train.py --work $WORK --out models/sepia-1-tokenizer --check
python scripts/tokenizer/export_ids.py --work $WORK --tokenizer models/sepia-1-tokenizer/tokenizer.json
npx tsx scripts/tokenizer/eval.ts $WORK
python scripts/tokenizer/finalize.py --work $WORK
npx tsx scripts/tokenizer/_test.ts
```

The repositories are fetched at their current allowlist pins and branch heads, so a later run can see newer commits than
the ones in `data-manifest.json`; the manifest records the commit and sha256 of every shard actually used. The web
corpus changes as agents read; `prepare.py` reads a prefix snapshot of `dataset.jsonl` and records its byte range and sha256.
Held-out text and the training sample stay in the work directory and are not committed (they are copies of
third-party code and pages); the manifest lists them by repository, commit, path, license and sha256.

## Hugging Face release (prepared, not uploaded)

```sh
node scripts/hf/build-tokenizer-release.mjs --out /tmp/lusca-hf/SEPIA-1-tokenizer
node scripts/hf/verify-tokenizer-release.mjs --dir /tmp/lusca-hf/SEPIA-1-tokenizer
```

The folder is ready for `LUSCAINK/SEPIA-1-tokenizer`; see the build script's header for the upload command.
