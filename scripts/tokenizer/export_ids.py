"""Reference token ids from the Hugging Face tokenizer, for the TypeScript parity checks.

    python scripts/tokenizer/export_ids.py --work <workdir> --tokenizer models/sepia-1-tokenizer/tokenizer.json

1. <workdir>/ids/<lang>.jsonl: ids of every held-out eval document (used by eval.ts, which encodes
   the same documents with shared/sepia1/tokenizer.ts and fails on any mismatch). Also checks the
   Python round trip (decode(encode(x)) == x) on every document.
2. scripts/tokenizer/_fixtures.json.gz (committed): seeded synthetic strings built to hit every
   pre-tokenizer rule and its edges (operators, hex boundaries, digits, indentation, CRLF, Unicode
   whitespace and letters, emoji, special tokens and near-misses), letters and digits added in
   Unicode 15/16, random strings over all of Unicode, plus the playground examples and slices of
   them, each with the ids `tokenizers` produces. scripts/tokenizer/_test.ts compares
   the TypeScript encoder against these, token for token.
"""

import argparse
import glob
import gzip
import json
import os
import random

from tokenizers import Tokenizer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

WORDS = [
    "function", "pub", "fn", "let", "mut", "uint256", "address", "require", "emit", "module", "struct", "impl",
    "return", "msg.sender", "self.balance", "ctx.accounts.vault", "onlyOwner", "invoke_signed", "token0", "_reserve1",
    "balanceOf", "transferFrom", "u64", "u128", "Coin", "TxContext", "felt252", "ContractAddress", "Result", "Ok",
    "Err", "assert!", "vector", "mapping", "external", "view", "returns", "memory", "calldata", "storage", "@external",
    "def", "class", "import", "from", "package", "func", "type", "interface", "const", "async", "await", "elif",
    "the", "protocol", "liquidity", "Ethereum", "validator", "rollup", "über", "naïve", "façade",
]
OPS = ["..=", "///", "=>", "->", "::", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "+=", "-=", "**", "//", "/*", "*/", "#[",
       "===", "!==", "=>{", "...", "..", "?.", "??", "::<", "#![", "/**", "**/", "->>", "<<=", ">>=", "*=", "/=", "%", "^",
       "(", ")", "{", "}", "[", "]", ";", ",", ".", ":", "?", "!", "@", "$", "#", "'", '"', "`", "~", "|", "&", "+", "-", "*", "/", "<", ">", "=", "\\"]
WS = [" ", "  ", "   ", "\t", "\t\t", "\n", "\r\n", "\n    ", "\n        ", "\n\t", "\n\t\t", "\n\n", "\n\n    ", " \n", "  \n  ",
      "\r", "\r\r\n", "\x0b", "\x0c", " ", " ", "　", "﻿", "\u0085", "​", " \t ", "\t "]
UNI = ["é", "ß", "日本語", "😀", "👨‍👩‍👧", "é", "مرحبا", "Привет", "²", "½", "Ⅻ", "∑", "→", "Ω", "中文 text", "Ä", "ı", "ǅ", "𝔘", "١٢٣"]
# Letters and digits added in Unicode 15 and 16, which JavaScript engines may know and Oniguruma in
# tokenizers 0.20.3 does not: CJK Ext H / I, Kawi, Nag Mundari, Garay, Kirat Rai, Sunuwar, outlined digits.
RECENT = [0x31350, 0x31351, 0x323AF, 0x2EBF0, 0x2EE5D, 0x11F04, 0x11F10, 0x11F50, 0x11F59, 0x1E4D0, 0x1E4EB, 0x1E4F0, 0x1E4F9,
          0x10D40, 0x10D49, 0x10D4A, 0x10D65, 0x16D40, 0x16D70, 0x16D79, 0x11BC0, 0x11BF0, 0x1CCF0, 0x1CCF9, 0x1E5D0, 0x1E5F1]
UNI += [chr(c) for c in RECENT] + [chr(RECENT[0]) + "11", "0x1234567890abcdef" + chr(0x31350), "x" + chr(0x1E4D0) + "_1", chr(0x10D40) + chr(0x10D41)]
SPECIAL = ["<|endoftext|>", "<|file|>", "<|repo|>", "<|pad|>", "<|fim_prefix|>", "<|", "|>", "<|endoftext", "<|reserved_31|>", "<|reserved_32|>", "<|<|file|>", "<|endoftext|>|>"]
HEXCH = "0123456789abcdefABCDEF"


def rnd_ident(r):
    k = r.random()
    if k < 0.5:
        return r.choice(WORDS)
    alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_"
    s = r.choice(alpha) + "".join(r.choice(alpha + "0123456789") for _ in range(r.randint(0, 14)))
    if r.random() < 0.2:
        s += "." + rnd_ident(r)
    return s


def rnd_num(r):
    k = r.random()
    if k < 0.4:
        return str(r.randint(0, 10 ** r.randint(1, 30)))
    if k < 0.6:
        return f"{r.randint(0, 999)}_{r.randint(0, 999):03d}"
    if k < 0.8:
        return f"{r.random() * 1000:.{r.randint(1, 8)}f}"
    return f"{r.randint(1, 9)}e{r.randint(1, 30)}"


def rnd_hex(r):
    n = r.choice([1, 2, 4, 7, 8, 9, 10, 12, 16, 39, 40, 41, 63, 64, 65, 80, r.randint(1, 120)])
    s = r.choice(["0x", "0x", "0X"]) + "".join(r.choice(HEXCH) for _ in range(n))
    k = r.random()
    if k < 0.15:
        s += r.choice("ghzG_")
    elif k < 0.25:
        s += r.choice(["0", "a", "F"])
    return s


def synth(r):
    parts = []
    for _ in range(r.randint(1, 40)):
        k = r.random()
        if k < 0.30:
            parts.append(rnd_ident(r))
        elif k < 0.50:
            parts.append(r.choice(WS))
        elif k < 0.68:
            parts.append(r.choice(OPS))
        elif k < 0.76:
            parts.append(rnd_num(r))
        elif k < 0.84:
            parts.append(rnd_hex(r))
        elif k < 0.92:
            parts.append(r.choice(UNI))
        elif k < 0.96:
            parts.append(r.choice(SPECIAL))
        else:
            parts.append(chr(r.choice([r.randint(0x20, 0x7E), r.randint(0xA0, 0x2FF), r.randint(0x370, 0x52F), r.randint(0x4E00, 0x4E80), r.randint(0x1F300, 0x1F64F)])))
    sep = r.choice(["", "", " "])
    return sep.join(parts)


def fuzz(r):
    """Random strings over all of Unicode, weighted toward letters, digits and code syntax."""
    out = []
    for _ in range(r.randint(1, 30)):
        k = r.random()
        if k < 0.35:
            out.append(chr(r.randint(0x20, 0x7E)))
        elif k < 0.55:
            c = r.randint(0, 0x10FFFF)
            while 0xD800 <= c <= 0xDFFF:
                c = r.randint(0, 0x10FFFF)
            out.append(chr(c))
        elif k < 0.70:
            c = r.randint(0x80, 0x33FFF)
            out.append(chr(c if not 0xD800 <= c <= 0xDFFF else c - 0x800))
        elif k < 0.82:
            out.append(chr(r.choice(RECENT)))
        elif k < 0.90:
            out.append(r.choice(OPS))
        elif k < 0.95:
            out.append(r.choice(WS))
        else:
            out.append(rnd_hex(r) if r.random() < 0.5 else rnd_num(r))
    return "".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--fixtures", type=int, default=2400)
    ap.add_argument("--fuzz", type=int, default=3000)
    a = ap.parse_args()
    tok = Tokenizer.from_file(a.tokenizer)

    # 1. eval documents
    os.makedirs(os.path.join(a.work, "ids"), exist_ok=True)
    totals = {}
    for p in sorted(glob.glob(os.path.join(a.work, "eval", "*.jsonl"))):
        lang = os.path.basename(p)[:-6]
        docs = [json.loads(l) for l in open(p, encoding="utf-8")]
        if not docs:
            continue
        encs = tok.encode_batch([d["text"] for d in docs], add_special_tokens=False)
        bad = 0
        with open(os.path.join(a.work, "ids", f"{lang}.jsonl"), "w", encoding="utf-8", newline="\n") as f:
            for d, e in zip(docs, encs):
                if tok.decode(e.ids, skip_special_tokens=False) != d["text"]:
                    bad += 1
                f.write(json.dumps(e.ids) + "\n")
        totals[lang] = {"docs": len(docs), "tokens": sum(len(e.ids) for e in encs), "python_roundtrip_failures": bad}
    json.dump(totals, open(os.path.join(a.work, "ids", "summary.json"), "w"), indent=1)
    print(json.dumps(totals))

    # 2. committed fixtures
    r = random.Random(20261006)
    texts = [synth(r) for _ in range(a.fixtures)]
    from importlib import util
    spec = util.spec_from_file_location("ex", os.path.join(ROOT, "scripts", "tokenizer", "examples.py"))
    ex_src = open(os.path.join(ROOT, "src", "components", "sepia", "tokenizer", "examples.ts"), encoding="utf-8").read()
    examples = json.loads(ex_src[ex_src.index("= [") + 2:])
    for e in examples:
        code = e["code"]
        texts.append(code)
        texts.append(code.replace("\n", "\r\n"))
        for _ in range(25):
            i = r.randint(0, len(code) - 1)
            j = r.randint(i, min(len(code), i + 400))
            texts.append(code[i:j])
    texts += [fuzz(r) for _ in range(a.fuzz)]
    texts += ["", " ", "\n", "\r\n", "<|endoftext|>", "a<|endoftext|>b", "  x", "0x" + "f" * 64, " 0x" + "a" * 9, "0x123456789g"]
    encs = tok.encode_batch(texts, add_special_tokens=False)
    fx = [{"text": t, "ids": e.ids} for t, e in zip(texts, encs)]
    out = os.path.join(ROOT, "scripts", "tokenizer", "_fixtures.json.gz")
    with gzip.GzipFile(out, "wb", mtime=0) as f:
        f.write(json.dumps({"tokenizer_sha256": __import__("hashlib").sha256(open(a.tokenizer, "rb").read()).hexdigest(), "fixtures": fx}, ensure_ascii=False).encode("utf-8"))
    print(f"wrote {len(fx)} fixtures to {out}")


if __name__ == "__main__":
    main()
