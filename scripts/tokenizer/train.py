"""Train the SEPIA-1 tokenizer: byte-level BPE, 32,768 entries including special tokens.

    python scripts/tokenizer/train.py --work <workdir> --out models/sepia-1-tokenizer

Reads <workdir>/train.jsonl (prepare.py). Writes tokenizer.json, vocab.json, merges.txt and
training.json (data hash, timing, library version) to --out. Deterministic: the same sample gives
the same tokenizer.json byte for byte (checked by --check, which trains twice).
"""

import argparse
import hashlib
import json
import os
import sys
import time

import tokenizers
from tokenizers import pre_tokenizers, trainers

from spec import SPECIALS, STAGE1, STAGE2, VOCAB_SIZE, SEED, build_tokenizer


def docs(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            yield json.loads(line)["text"]


def train_once(train_path, n_docs):
    tok = build_tokenizer()
    trainer = trainers.BpeTrainer(
        vocab_size=VOCAB_SIZE,
        min_frequency=2,
        special_tokens=SPECIALS,
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
        show_progress=False,
    )
    tok.train_from_iterator(docs(train_path), trainer=trainer, length=n_docs)
    return tok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--check", action="store_true", help="train twice and compare")
    a = ap.parse_args()
    train_path = os.path.join(a.work, "train.jsonl")
    n_docs = sum(1 for _ in open(train_path, encoding="utf-8"))
    t0 = time.time()
    tok = train_once(train_path, n_docs)
    secs = time.time() - t0
    vs = tok.get_vocab_size(with_added_tokens=True)
    if vs != VOCAB_SIZE:
        print(f"vocab size {vs} != {VOCAB_SIZE}", file=sys.stderr)
        sys.exit(1)
    for i, s in enumerate(SPECIALS):
        assert tok.token_to_id(s) == i, s
    os.makedirs(a.out, exist_ok=True)
    tj = tok.to_str(pretty=False)
    with open(os.path.join(a.out, "tokenizer.json"), "w", encoding="utf-8", newline="\n") as f:
        f.write(tj)
    tok.model.save(a.out)  # vocab.json + merges.txt
    det = None
    if a.check:
        tok2 = train_once(train_path, n_docs)
        det = tok2.to_str(pretty=False) == tj
        print(f"deterministic: {det}")
        if not det:
            sys.exit(1)
    data_sha = hashlib.sha256(open(train_path, "rb").read()).hexdigest()
    info = {
        "tokenizers_version": tokenizers.__version__,
        "python": sys.version.split()[0],
        "vocab_size": vs,
        "merges": len(json.loads(tj)["model"]["merges"]),
        "special_tokens": SPECIALS,
        "seed": SEED,
        "min_frequency": 2,
        "train_docs": n_docs,
        "train_sha256": data_sha,
        "train_seconds": round(secs, 1),
        "deterministic_check": det,
        "pre_tokenizer": {"stage1": STAGE1, "stage2": STAGE2},
        "tokenizer_json_sha256": hashlib.sha256(tj.encode("utf-8")).hexdigest(),
    }
    json.dump(info, open(os.path.join(a.work, "training.json"), "w", encoding="utf-8"), indent=1)
    print(json.dumps({k: v for k, v in info.items() if k not in ("special_tokens", "pre_tokenizer")}, indent=1))


if __name__ == "__main__":
    main()
