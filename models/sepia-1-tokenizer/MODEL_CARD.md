# SEPIA-1 tokenizer

Byte-level BPE tokenizer with 32,768 entries for SEPIA-1, the code-reading model planned by LUSCA ([lusca.ink](https://lusca.ink), [design](https://github.com/LUSCAINK/LUSCA/blob/main/docs/SEPIA-1.md)). This is milestone M1 of SEPIA-1. **The SEPIA-1 model itself is not trained yet**; this release is the tokenizer only.

- tokenizer.json sha256 `4b2ec96ed69a7c9fe7a7c01bd01e4d4c95f527384d6ee3862e43e850ed54d04f`
- vocabulary 32,768: 256 byte tokens, 32,473 merges, 39 special tokens
- trained with Hugging Face `tokenizers` 0.20.3 (Python 3.12.10) in 24.6 s; training twice gives a byte-identical tokenizer.json (checked: True)
- held-out code: **4.22 bytes per token**, 4.6% fewer tokens than o200k_base, 5.1% fewer than cl100k_base and 43.0% fewer than GPT-2 r50k_base on the same files
- exact round trip on 1,052 of 1,052 held-out documents (9.20 MB)
- the TypeScript encoder used in the browser matches this tokenizer on 2,287,501 held-out tokens with 0 mismatches

## Design

Follows [docs/SEPIA-1.md §2.3](https://github.com/LUSCAINK/LUSCA/blob/main/docs/SEPIA-1.md#23-tokenizer).

- **Byte-level.** Any file encodes losslessly: tabs, CRLF, Unicode in comments. No normalizer.
- **Code-aware pre-tokenization** before BPE merges (`pre_tokenizer` in tokenizer.json, explained in `scripts/tokenizer/spec.py`):
  - a line break plus the next line's indentation is one pre-token, so indentation levels become single tokens;
  - multi-character operators are atomic: `..=` `///` `=>` `->` `::` `==` `!=` `<=` `>=` `&&` `||` `<<` `>>` `+=` `-=` `**` `//` `/*` `*/` `#[`;
  - identifiers (letters, digits, `_`) and dotted member chains are units, so `msg.sender` can be one token;
  - decimal digits are split one per token;
  - hex literals over 8 digits are cut into `0x` plus 4-digit groups, so addresses and hashes do not use up vocabulary; shorter ones (selectors, masks) stay whole;
  - a single leading space joins the next token (GPT-2 style); only ASCII whitespace counts as whitespace.
- **Special tokens** (ids 0–38): `<|endoftext|>`, `<|pad|>`, `<|repo|>`, `<|file|>`, `<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>`, and `<|reserved_0|>` … `<|reserved_31|>`. Code documents are framed as `<|repo|>owner/name@commit<|file|>path` then the file bytes; documents are separated by `<|endoftext|>`. Nothing is added automatically by `encode`.

Decisions where the design left room:

- Several consecutive line breaks with the indentation that follows them form one pre-token (blank lines inside functions are common).
- Dotted chains are kept together because the design names `msg.sender` as a token BPE should be able to learn; plain identifiers alone could not produce it.
- Operators keep an optional leading space (` =>`, ` ==`), like words do; the operator itself is still never split or merged with other symbols.
- Runs of other punctuation (`);`, `({`, `}`) may merge, but stop before any of the atomic operators.
- The listed operator set is used exactly; `===`, `!==`, `...` and compound assignments other than `+=` `-=` are left to BPE.

## Training data

Sample: 26,411 documents, 209.22 MB, 61.8% code by bytes (code first, as in the anneal phase of the SEPIA-1 mixture). Sample sha256 `aa6d94144c63528609ee107cab3b2a97871eca28615a2c037da8ae120268a6aa`.

- **Protocol code index**: 110 allowlisted repositories (18,239 files), fetched with LUSCA's code index (`server/codebase`) at the commits listed in `data-manifest.json`, with each repository's and file's license recorded. All licenses are included, as in the code index policy.
- **Crypto web text**: 10,595 pages (80.00 MB) sampled with a fixed seed from the LUSCA corpus (`dataset.jsonl`, a prefix snapshot; byte range and sha256 in the manifest).
- **Verified on-chain sources**: not used: the public API exposes source paths and sizes, not source text.
- **Expert analysis** (audit reports, advisories): not used: not collected yet (docs/SEPIA-1-data.md §5).

Code bytes per language in the sample. Every language contributes all of its training files, capped at 25% of the code budget; languages under 4% of it are repeated, up to 3 passes, for tokenizer training only.

| Language | Available (MB) | In sample (MB) | Passes |
|---|---:|---:|---:|
| Solidity | 36.59 | 30.04 | 0.82 |
| Vyper | 2.65 | 4.80 | 1.81 |
| Rust / Anchor | 40.32 | 30.02 | 0.74 |
| Move | 7.91 | 7.91 | 1.00 |
| Cairo | 3.86 | 4.85 | 1.26 |
| Go | 13.51 | 13.51 | 1.00 |
| C / C++ | 1.98 | 4.97 | 2.51 |
| TypeScript | 2.05 | 4.80 | 2.34 |
| Python | 0.86 | 2.58 | 3.00 |
| Markdown (EIPs, docs) | 24.76 | 24.76 | 1.00 |
| IDL (Anchor JSON) | 0.33 | 0.98 | 3.00 |

## Evaluation

Files and pages chosen by hash before training and never trained on (scripts/tokenizer/prepare.py). Code: sha256(repo\npath) mod 1000 < 80, up to 1.5 MB per language. Web: sha256(id) mod 1000 < 20, mostly-ASCII pages, up to 1.5 MB.

Bytes per token (higher is better):

| Held-out set | Files | MB | SEPIA-1 (32,768) | r50k_base (GPT-2) | cl100k_base | o200k_base |
|---|---:|---:|---:|---:|---:|---:|
| Solidity | 239 | 1.52 | **4.44** | 2.49 | 4.23 | 4.27 |
| Vyper | 15 | 0.28 | **4.34** | 2.56 | 3.93 | 3.93 |
| Rust / Anchor | 167 | 1.68 | **4.44** | 2.18 | 4.20 | 4.21 |
| Move | 59 | 0.63 | **4.20** | 2.45 | 4.10 | 4.09 |
| Cairo | 51 | 0.32 | **3.83** | 2.44 | 3.74 | 3.76 |
| Go | 138 | 1.27 | **3.87** | 2.64 | 3.62 | 3.67 |
| C / C++ | 9 | 0.23 | **3.78** | 2.21 | 3.81 | 3.80 |
| TypeScript | 16 | 0.11 | **4.30** | 2.43 | 3.89 | 3.91 |
| Python | 15 | 0.16 | **4.61** | 2.50 | 4.27 | 4.24 |
| Markdown (EIPs, docs) | 141 | 1.51 | **3.54** | 2.99 | 3.65 | 3.67 |
| Web text (English, crypto) | 202 | 1.51 | **3.79** | 3.80 | 4.16 | 4.26 |
| **All code** (no Markdown) | | 6.19 | **4.22** | 2.41 | 4.01 | 4.03 |

Lines of code in one 2,048-token window (2,048 × lines ÷ tokens):

| Held-out set | SEPIA-1 | r50k_base | cl100k_base | o200k_base |
|---|---:|---:|---:|---:|
| Solidity | **225** | 126 | 214 | 216 |
| Vyper | **277** | 163 | 250 | 250 |
| Rust / Anchor | **258** | 127 | 244 | 245 |
| Move | **233** | 135 | 227 | 226 |
| Cairo | **230** | 147 | 225 | 226 |
| Go | **229** | 156 | 215 | 217 |
| C / C++ | **195** | 114 | 197 | 197 |
| TypeScript | **245** | 138 | 222 | 222 |
| Python | **339** | 184 | 314 | 312 |
| Markdown (EIPs, docs) | **130** | 110 | 135 | 135 |

Tokens per 1,000 lines and the per-file list are in `eval.json` and `eval.md`.

## Usage

```python
from tokenizers import Tokenizer
tok = Tokenizer.from_file("tokenizer.json")
ids = tok.encode("function swap(uint amount0Out) external lock {").ids
assert tok.decode(ids) == "function swap(uint amount0Out) external lock {"
```

With `transformers`: `PreTrainedTokenizerFast(tokenizer_file="tokenizer.json", eos_token="<|endoftext|>", pad_token="<|pad|>")`, or `AutoTokenizer.from_pretrained` on this repository (tokenizer_config.json is included).

In JavaScript, `shared/sepia1/tokenizer.ts` in the LUSCA repository reads the same tokenizer.json (no dependencies) and is what https://lusca.ink/sepia runs in the browser.

## Limitations

- On English prose the 32,768-entry vocabulary is less compact than cl100k_base and o200k_base (100k and 200k entries). That trade keeps the SEPIA-1 embedding table small for volunteer GPUs.
- One token per decimal digit makes long numbers cost more tokens than in GPT tokenizers.
- The code holdout is by file, so held-out files can share code with training files of the same repository; repository-level holdouts come with the SEPIA-1 eval set (docs/SEPIA-1-data.md §6).
- The pre-tokenizer uses Unicode letter and number classes; the regex engines of Rust (Oniguruma) and JavaScript may disagree on characters added in recent Unicode versions. No disagreement was found on the held-out data or the fixtures.

## Reproduce

See `scripts/tokenizer/README.md` in the LUSCA repository: fetch the code index, `prepare.py` (sample and holdout), `train.py --check`, `export_ids.py`, `eval.ts`, `finalize.py`.

## License

The tokenizer files are released under the MIT license, like the LUSCA repository. The licenses of the training sources are listed per repository and per held-out file in `data-manifest.json`.
