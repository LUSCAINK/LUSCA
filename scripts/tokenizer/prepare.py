"""Build the SEPIA-1 tokenizer training sample and the held-out evaluation split.

    python scripts/tokenizer/prepare.py --code <LUSCA_DATA>/code --web <dataset.jsonl> --out <workdir>

Inputs (all real, recorded in <workdir>/manifest.json with byte counts and sha256):
  - protocol source code: the gzip JSONL shards of the code index (server/codebase), as listed by
    <code>/index.json;
  - crypto web text: a prefix snapshot of the corpus dataset.jsonl (the file is appended to while
    the server runs, so only bytes [0, N) at start time are read; N and the sha256 of that range
    are recorded).
  - verified on-chain sources: not used. The public API (/api/chain/item) exposes source paths and
    sizes but not source text, so there is nothing to read without server access.

Split (decided BEFORE training, deterministic, never trained on):
  - code: a file is in the eval bucket when sha256("<repo>\\n<path>") mod 1000 < 80 (8 %). Eval
    files are taken in hash order up to EVAL_CAP bytes per language; bucket files beyond the cap
    are unused (neither eval nor training).
  - web: a page is in the eval bucket when sha256(id) mod 1000 < 20; eval keeps mostly-ASCII
    (English) pages up to EVAL_CAP. Training pages come from other buckets.

Mix (docs/SEPIA-1.md §2.3 and §3.4): code first, about 60 % code / 40 % web text by bytes (the
anneal-phase share). Inside the code share every language contributes all of its training files,
capped at CAP of the code budget (Rust and Solidity hit the cap); a language with less than FLOOR
of the code budget is repeated, up to MAX_REPEAT passes, for tokenizer training only.

Outputs in <workdir>: train.jsonl ({"src","text"} per document, in training order),
eval/<lang>.jsonl (held-out documents with source metadata), manifest.json.
"""

import argparse
import glob
import gzip
import hashlib
import json
import os
import random
import sys
import time

from spec import SEED

CODE_LANGS = ["solidity", "vyper", "rust", "move", "cairo", "go", "cpp", "typescript", "python", "markdown", "idl"]
EVAL_LANGS = ["solidity", "vyper", "rust", "move", "cairo", "go", "cpp", "typescript", "python", "markdown"]
EVAL_CAP = 1_500_000
CODE_SHARE = 0.60
FLOOR = 0.04
CAP = 0.25
MAX_REPEAT = 3
WEB_EVAL_BUCKET = 20
CODE_EVAL_BUCKET = 80


def h(s: str) -> int:
    return int(hashlib.sha256(s.encode("utf-8")).hexdigest()[:12], 16)


def sha_file(path: str, limit: int | None = None) -> str:
    d = hashlib.sha256()
    left = limit
    with open(path, "rb") as f:
        while True:
            n = 1 << 20 if left is None else min(1 << 20, left)
            if n == 0:
                break
            b = f.read(n)
            if not b:
                break
            d.update(b)
            if left is not None:
                left -= len(b)
    return d.hexdigest()


def ascii_ratio(t: str) -> float:
    if not t:
        return 0.0
    return sum(1 for c in t if ord(c) < 128) / len(t)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--code", required=True)
    ap.add_argument("--web", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--total-mb", type=float, default=160.0)
    ap.add_argument("--web-snapshot-mb", type=float, default=900.0)
    a = ap.parse_args()
    t0 = time.time()
    os.makedirs(os.path.join(a.out, "eval"), exist_ok=True)
    budget = int(a.total_mb * 1e6)
    code_budget = int(budget * CODE_SHARE)
    web_budget = budget - code_budget

    # ── code ──
    index = json.load(open(os.path.join(a.code, "index.json"), encoding="utf-8"))
    shard_files = []
    for repo, st in index["repos"].items():
        if st.get("status") != "ok":
            continue
        for s in st.get("shards", []):
            shard_files.append((repo, st.get("commit"), st.get("license"), s))
    inputs = []
    code_train = {l: [] for l in CODE_LANGS}
    code_eval = {l: [] for l in CODE_LANGS}
    files_seen = 0
    for repo, commit, lic, s in shard_files:
        p = os.path.join(a.code, s)
        inputs.append({"kind": "code-shard", "repo": repo, "commit": commit, "license": lic, "file": s, "bytes": os.path.getsize(p), "sha256": sha_file(p)})
        with gzip.open(p, "rt", encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                files_seen += 1
                lang = r["lang"]
                if lang not in code_train:
                    continue
                key = h(f"{r['repo']}\n{r['path']}")
                doc = {"repo": r["repo"], "commit": r.get("commit"), "path": r["path"], "lang": lang, "license": r.get("license"), "tier": r.get("tier"), "bytes": len(r["text"].encode("utf-8")), "sha256": r["sha256"], "key": key, "text": r["text"]}
                (code_eval if key % 1000 < CODE_EVAL_BUCKET else code_train)[lang].append(doc)

    eval_docs = {}
    for lang in CODE_LANGS:
        docs = sorted(code_eval[lang], key=lambda d: d["key"])
        kept, n = [], 0
        for d in docs:
            if n >= EVAL_CAP:
                break
            kept.append(d)
            n += d["bytes"]
        eval_docs[lang] = kept

    # per-language training quota
    avail = {l: sum(d["bytes"] for d in code_train[l]) for l in CODE_LANGS}
    total_avail = sum(avail.values()) or 1
    # Every language contributes all of its training files, capped at CAP of the code budget;
    # a language below FLOOR is repeated (up to MAX_REPEAT passes) to reach it.
    quota = {}
    for l in CODE_LANGS:
        q = max(avail[l], min(FLOOR * code_budget, MAX_REPEAT * avail[l]))
        quota[l] = int(min(q, CAP * code_budget))

    rng = random.Random(SEED)
    train = []
    code_stats = {}
    for l in CODE_LANGS:
        docs = sorted(code_train[l], key=lambda d: d["key"])
        if not docs:
            code_stats[l] = {"available_bytes": 0, "train_bytes": 0, "repeat": 0, "files": 0, "eval_files": 0, "eval_bytes": 0}
            continue
        taken, n, passes = [], 0, 0
        while n < quota[l] and passes < MAX_REPEAT:
            for d in docs:
                if n >= quota[l]:
                    break
                taken.append(d)
                n += d["bytes"]
            passes += 1
        train.extend({"src": f"code:{l}", "text": d["text"]} for d in taken)
        code_stats[l] = {
            "available_bytes": avail[l],
            "available_files": len(docs),
            "train_bytes": n,
            "train_docs": len(taken),
            "repeat": round(n / avail[l], 3) if avail[l] else 0,
            "eval_files": len(eval_docs[l]),
            "eval_bytes": sum(d["bytes"] for d in eval_docs[l]),
        }

    # ── web ──
    web_size = os.path.getsize(a.web)
    snap = min(web_size, int(a.web_snapshot_mb * 1e6))
    web_train, web_eval = [], []
    wn = we = 0
    pages = 0
    with open(a.web, "rb") as f:
        data = f.read(snap)
    end = data.rfind(b"\n") + 1  # whole lines only
    data = data[:end]
    inputs.append({"kind": "web-snapshot", "file": os.path.basename(a.web), "range": [0, end], "bytes": end, "sha256": hashlib.sha256(data).hexdigest()})
    # A deterministic stride over the snapshot so the sample spans all arms and dates, not only the oldest pages.
    lines = data.split(b"\n")
    del data
    order = list(range(len(lines)))
    rng.shuffle(order)
    for i in order:
        line = lines[i]
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        pages += 1
        text = (r.get("title") or "").strip()
        body = r.get("text") or ""
        doc = (text + "\n\n" + body) if text else body
        if not doc.strip():
            continue
        b = len(doc.encode("utf-8"))
        key = h(str(r.get("id")))
        if key % 1000 < WEB_EVAL_BUCKET:
            if we < EVAL_CAP and ascii_ratio(doc) > 0.97:
                web_eval.append({"id": r.get("id"), "host": r.get("host"), "url": r.get("url"), "lang": "web", "bytes": b, "text": doc})
                we += b
            continue
        if wn < web_budget:
            web_train.append({"src": "web", "text": doc})
            wn += b
        if wn >= web_budget and we >= EVAL_CAP:
            break
    del lines
    eval_docs["web"] = web_eval
    train.extend(web_train)

    # Training order: shuffled with the seed (order does not change BPE counts; recorded for completeness).
    rng.shuffle(train)

    h_train = hashlib.sha256()
    with open(os.path.join(a.out, "train.jsonl"), "w", encoding="utf-8", newline="\n") as f:
        for d in train:
            line = json.dumps(d, ensure_ascii=False) + "\n"
            f.write(line)
            h_train.update(line.encode("utf-8"))
    eval_manifest = {}
    for lang, docs in eval_docs.items():
        p = os.path.join(a.out, "eval", f"{lang}.jsonl")
        hh = hashlib.sha256()
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            for d in docs:
                d = {k: v for k, v in d.items() if k != "key"}
                line = json.dumps(d, ensure_ascii=False) + "\n"
                f.write(line)
                hh.update(line.encode("utf-8"))
        eval_manifest[lang] = {
            "docs": len(docs),
            "bytes": sum(d["bytes"] for d in docs),
            "repos": sorted({d["repo"] for d in docs}) if lang != "web" else sorted({d["host"] for d in docs if d.get("host")}),
            "sha256": hh.hexdigest(),
            "files": [{"repo": d["repo"], "commit": d["commit"], "path": d["path"], "license": d["license"], "bytes": d["bytes"], "sha256": d["sha256"]} for d in docs] if lang != "web" else [{"id": d["id"], "url": d["url"], "bytes": d["bytes"]} for d in docs],
        }

    code_train_bytes = sum(v["train_bytes"] for v in code_stats.values())
    manifest = {
        "name": "SEPIA-1 tokenizer training sample",
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "seed": SEED,
        "policy": {
            "code_share": CODE_SHARE,
            "floor_per_language": FLOOR,
            "cap_per_language": CAP,
            "max_repeat": MAX_REPEAT,
            "code_eval_bucket": f"sha256(repo\\npath) mod 1000 < {CODE_EVAL_BUCKET}",
            "web_eval_bucket": f"sha256(id) mod 1000 < {WEB_EVAL_BUCKET}, ASCII ratio > 0.97",
            "eval_cap_bytes_per_language": EVAL_CAP,
        },
        "sources": {
            "code_index": {"repos_ok": len({x[0] for x in shard_files}), "shards": len(shard_files), "files_read": files_seen},
            "web": {"pages_read": pages, "dataset_bytes_at_start": web_size},
            "chain_sources": "not used: the public API exposes source paths and sizes, not source text",
            "expert_analysis": "not used: not collected yet (docs/SEPIA-1-data.md §5)",
        },
        "train": {
            "docs": len(train),
            "bytes": code_train_bytes + wn,
            "code_bytes": code_train_bytes,
            "web_bytes": wn,
            "web_docs": len(web_train),
            "code_share_actual": round(code_train_bytes / max(1, code_train_bytes + wn), 4),
            "by_language": code_stats,
            "sha256": h_train.hexdigest(),
        },
        "eval": eval_manifest,
        "inputs": inputs,
    }
    with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, indent=1)
    print(json.dumps({k: manifest[k] for k in ("train",)}, indent=1)[:3000])
    print({l: (v["docs"], v["bytes"]) for l, v in eval_manifest.items()})
    print(f"done in {time.time() - t0:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
