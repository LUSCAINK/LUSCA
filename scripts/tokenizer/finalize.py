"""Write the release metadata of models/sepia-1-tokenizer from the measured results.

    python scripts/tokenizer/finalize.py --work <workdir>

Run after train.py, export_ids.py and eval.ts. Writes:
  - scripts/tokenizer/data-manifest.json: the training/eval data manifest (sources, byte counts,
    sha256 of every input shard and of the web snapshot, the held-out file list; no text);
  - models/sepia-1-tokenizer/MODEL_CARD.md: every number is read from eval.json, training.json and
    the data manifest, none is typed by hand;
  - models/sepia-1-tokenizer/manifest.json: sha256 and size of every artifact, training settings.
"""

import argparse
import hashlib
import json
import os
import shutil

from spec import SPECIALS

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODEL = os.path.join(ROOT, "models", "sepia-1-tokenizer")
LABEL = {"solidity": "Solidity", "vyper": "Vyper", "rust": "Rust / Anchor", "move": "Move", "cairo": "Cairo", "go": "Go", "cpp": "C / C++",
         "typescript": "TypeScript", "python": "Python", "markdown": "Markdown (EIPs, docs)", "idl": "IDL (Anchor JSON)", "web": "Web text"}


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def mb(n):
    return f"{n / 1e6:.2f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    a = ap.parse_args()
    data = json.load(open(os.path.join(a.work, "manifest.json"), encoding="utf-8"))
    training = json.load(open(os.path.join(a.work, "training.json"), encoding="utf-8"))
    ev = json.load(open(os.path.join(MODEL, "eval.json"), encoding="utf-8"))
    shutil.copyfile(os.path.join(a.work, "manifest.json"), os.path.join(ROOT, "scripts", "tokenizer", "data-manifest.json"))

    tr = data["train"]
    code = ev["totals"]["code"]
    rel = code["relative"]
    pct = lambda r: f"{(1 - r) * 100:.1f}% fewer" if r < 1 else f"{(r - 1) * 100:.1f}% more"
    L = []
    w = L.append
    w("# SEPIA-1 tokenizer")
    w("")
    w("Byte-level BPE tokenizer with 32,768 entries for SEPIA-1, the code-reading model planned by LUSCA ([lusca.ink](https://lusca.ink), [design](https://github.com/LUSCAINK/LUSCA/blob/main/docs/SEPIA-1.md)). "
      "This is milestone M1 of SEPIA-1. **The SEPIA-1 model itself is not trained yet**; this release is the tokenizer only.")
    w("")
    w(f"- tokenizer.json sha256 `{training['tokenizer_json_sha256']}`")
    w(f"- vocabulary {training['vocab_size']:,}: 256 byte tokens, {training['merges']:,} merges, {len(SPECIALS)} special tokens")
    w(f"- trained with Hugging Face `tokenizers` {training['tokenizers_version']} (Python {training['python']}) in {training['train_seconds']} s; training twice gives a byte-identical tokenizer.json (checked: {training['deterministic_check']})")
    w(f"- held-out code: **{code['tokenizers']['sepia1']['bytesPerToken']:.2f} bytes per token**, {pct(rel['o200k'])} tokens than o200k_base, {pct(rel['cl100k'])} than cl100k_base and {pct(rel['r50k'])} than GPT-2 r50k_base on the same files")
    w(f"- exact round trip on {ev['roundTrip']['exact']:,} of {ev['roundTrip']['docs']:,} held-out documents ({mb(ev['roundTrip']['bytes'])} MB)")
    w(f"- the TypeScript encoder used in the browser matches this tokenizer on {ev['parity']['tokens']:,} held-out tokens with {ev['parity']['mismatches']} mismatches")
    w("")
    w("## Design")
    w("")
    w("Follows [docs/SEPIA-1.md §2.3](https://github.com/LUSCAINK/LUSCA/blob/main/docs/SEPIA-1.md#23-tokenizer).")
    w("")
    w("- **Byte-level.** Any file encodes losslessly: tabs, CRLF, Unicode in comments. No normalizer.")
    w("- **Code-aware pre-tokenization** before BPE merges (`pre_tokenizer` in tokenizer.json, explained in `scripts/tokenizer/spec.py`):")
    w("  - a line break plus the next line's indentation is one pre-token, so indentation levels become single tokens;")
    w("  - multi-character operators are atomic: `..=` `///` `=>` `->` `::` `==` `!=` `<=` `>=` `&&` `||` `<<` `>>` `+=` `-=` `**` `//` `/*` `*/` `#[`;")
    w("  - identifiers (letters, digits, `_`) and dotted member chains are units, so `msg.sender` can be one token;")
    w("  - decimal digits are split one per token;")
    w("  - hex literals over 8 digits are cut into `0x` plus 4-digit groups, so addresses and hashes do not use up vocabulary; shorter ones (selectors, masks) stay whole;")
    w("  - a single leading space joins the next token (GPT-2 style); only ASCII whitespace counts as whitespace.")
    w("- **Special tokens** (ids 0–38): " + ", ".join(f"`{s}`" for s in SPECIALS[:7]) + ", and `<|reserved_0|>` … `<|reserved_31|>`. Code documents are framed as `<|repo|>owner/name@commit<|file|>path` then the file bytes; documents are separated by `<|endoftext|>`. Nothing is added automatically by `encode`.")
    w("")
    w("Decisions where the design left room:")
    w("")
    w("- Several consecutive line breaks with the indentation that follows them form one pre-token (blank lines inside functions are common).")
    w("- Dotted chains are kept together because the design names `msg.sender` as a token BPE should be able to learn; plain identifiers alone could not produce it.")
    w("- Operators keep an optional leading space (` =>`, ` ==`), like words do; the operator itself is still never split or merged with other symbols.")
    w("- Runs of other punctuation (`);`, `({`, `}`) may merge, but stop before any of the atomic operators.")
    w("- The listed operator set is used exactly; `===`, `!==`, `...` and compound assignments other than `+=` `-=` are left to BPE.")
    w("")
    w("## Training data")
    w("")
    w(f"Sample: {tr['docs']:,} documents, {mb(tr['bytes'])} MB, {tr['code_share_actual'] * 100:.1f}% code by bytes (code first, as in the anneal phase of the SEPIA-1 mixture). Sample sha256 `{tr['sha256']}`.")
    w("")
    w(f"- **Protocol code index**: {data['sources']['code_index']['repos_ok']} allowlisted repositories ({data['sources']['code_index']['files_read']:,} files), fetched with LUSCA's code index (`server/codebase`) at the commits listed in `data-manifest.json`, with each repository's and file's license recorded. All licenses are included, as in the code index policy.")
    w(f"- **Crypto web text**: {tr['web_docs']:,} pages ({mb(tr['web_bytes'])} MB) sampled with a fixed seed from the LUSCA corpus (`dataset.jsonl`, a prefix snapshot; byte range and sha256 in the manifest).")
    w(f"- **Verified on-chain sources**: {data['sources']['chain_sources']}.")
    w(f"- **Expert analysis** (audit reports, advisories): {data['sources']['expert_analysis']}.")
    w("")
    w("Code bytes per language in the sample. Every language contributes all of its training files, capped at 25% of the code budget; languages under 4% of it are repeated, up to 3 passes, for tokenizer training only.")
    w("")
    w("| Language | Available (MB) | In sample (MB) | Passes |")
    w("|---|---:|---:|---:|")
    for k, v in tr["by_language"].items():
        w(f"| {LABEL.get(k, k)} | {mb(v['available_bytes'])} | {mb(v['train_bytes'])} | {v['repeat']:.2f} |")
    w("")
    w("## Evaluation")
    w("")
    w(ev["heldOut"])
    w("")
    w("Bytes per token (higher is better):")
    w("")
    w("| Held-out set | Files | MB | SEPIA-1 (32,768) | r50k_base (GPT-2) | cl100k_base | o200k_base |")
    w("|---|---:|---:|---:|---:|---:|---:|")
    for l in ev["languages"]:
        t = l["tokenizers"]
        w(f"| {l['label']} | {l['docs']} | {mb(l['bytes'])} | **{t['sepia1']['bytesPerToken']:.2f}** | {t['r50k']['bytesPerToken']:.2f} | {t['cl100k']['bytesPerToken']:.2f} | {t['o200k']['bytesPerToken']:.2f} |")
    t = code["tokenizers"]
    w(f"| **All code** (no Markdown) | | {mb(code['bytes'])} | **{t['sepia1']['bytesPerToken']:.2f}** | {t['r50k']['bytesPerToken']:.2f} | {t['cl100k']['bytesPerToken']:.2f} | {t['o200k']['bytesPerToken']:.2f} |")
    w("")
    w("Lines of code in one 2,048-token window (2,048 × lines ÷ tokens):")
    w("")
    w("| Held-out set | SEPIA-1 | r50k_base | cl100k_base | o200k_base |")
    w("|---|---:|---:|---:|---:|")
    for l in ev["languages"]:
        if l["id"] == "web":
            continue
        t = l["tokenizers"]
        w(f"| {l['label']} | **{t['sepia1']['linesPer2048']}** | {t['r50k']['linesPer2048']} | {t['cl100k']['linesPer2048']} | {t['o200k']['linesPer2048']} |")
    w("")
    w("Tokens per 1,000 lines and the per-file list are in `eval.json` and `eval.md`.")
    w("")
    w("## Usage")
    w("")
    w("```python")
    w("from tokenizers import Tokenizer")
    w('tok = Tokenizer.from_file("tokenizer.json")')
    w('ids = tok.encode("function swap(uint amount0Out) external lock {").ids')
    w("assert tok.decode(ids) == \"function swap(uint amount0Out) external lock {\"")
    w("```")
    w("")
    w("With `transformers`: `PreTrainedTokenizerFast(tokenizer_file=\"tokenizer.json\", eos_token=\"<|endoftext|>\", pad_token=\"<|pad|>\")`, or `AutoTokenizer.from_pretrained` on this repository (tokenizer_config.json is included).")
    w("")
    w("In JavaScript, `shared/sepia1/tokenizer.ts` in the LUSCA repository reads the same tokenizer.json (no dependencies) and is what https://lusca.ink/sepia runs in the browser.")
    w("")
    w("## Limitations")
    w("")
    w("- On English prose the 32,768-entry vocabulary is less compact than cl100k_base and o200k_base (100k and 200k entries). That trade keeps the SEPIA-1 embedding table small for volunteer GPUs.")
    w("- One token per decimal digit makes long numbers cost more tokens than in GPT tokenizers.")
    w("- The code holdout is by file, so held-out files can share code with training files of the same repository; repository-level holdouts come with the SEPIA-1 eval set (docs/SEPIA-1-data.md §6).")
    w("- The pre-tokenizer uses Unicode letter and number classes; the regex engines of Rust (Oniguruma) and JavaScript may disagree on characters added in recent Unicode versions. No disagreement was found on the held-out data or the fixtures.")
    w("")
    w("## Reproduce")
    w("")
    w("See `scripts/tokenizer/README.md` in the LUSCA repository: fetch the code index, `prepare.py` (sample and holdout), `train.py --check`, `export_ids.py`, `eval.ts`, `finalize.py`.")
    w("")
    w("## License")
    w("")
    w("The tokenizer files are released under the MIT license, like the LUSCA repository. The licenses of the training sources are listed per repository and per held-out file in `data-manifest.json`.")
    w("")
    open(os.path.join(MODEL, "MODEL_CARD.md"), "w", encoding="utf-8", newline="\n").write("\n".join(L))

    files = {}
    for name in ["tokenizer.json", "vocab.json", "merges.txt", "eval.json", "eval.md", "MODEL_CARD.md"]:
        p = os.path.join(MODEL, name)
        files[name] = {"bytes": os.path.getsize(p), "sha256": sha(p)}
    dm = os.path.join(ROOT, "scripts", "tokenizer", "data-manifest.json")
    manifest = {
        "name": "SEPIA-1 tokenizer",
        "milestone": "M1",
        "model_trained": False,
        "vocab_size": training["vocab_size"],
        "merges": training["merges"],
        "special_tokens": {s: i for i, s in enumerate(SPECIALS)},
        "training": {k: training[k] for k in ("tokenizers_version", "python", "seed", "min_frequency", "train_docs", "train_sha256", "train_seconds", "deterministic_check")},
        "pre_tokenizer": training["pre_tokenizer"],
        "data_manifest": {"path": "scripts/tokenizer/data-manifest.json", "sha256": sha(dm), "bytes": os.path.getsize(dm)},
        "files": files,
    }
    json.dump(manifest, open(os.path.join(MODEL, "manifest.json"), "w", encoding="utf-8", newline="\n"), indent=1, ensure_ascii=False)
    print(json.dumps(files, indent=1))


if __name__ == "__main__":
    main()
