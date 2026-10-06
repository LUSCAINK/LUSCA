#!/usr/bin/env python3
"""SEPIA-0 inference with numpy only (no torch, no safetensors package).

    python inference.py "The validator" --n 240 --temperature 0.8 --seed 7

Sampling follows POST https://lusca.ink/api/generate:
  * the prompt has CRLF / CR turned into LF and is cut to 200 characters;
  * n is rounded and clamped to 1..600 (default 240);
  * temperature is clamped to 0.05..2 (default 0.8);
  * the prompt is mapped to the 96-symbol vocabulary, its last 16 symbols
    (left-padded with newline) form the context, and every next character is
    drawn from softmax(logits / temperature);
  * the output is the prompt followed by the continuation.

The forward pass repeats the server's float32 arithmetic step by step (each
multiply-add in float64, stored back to float32, inputs in order), so the logits
equal the server's up to float32 rounding of tanh. With --seed, the random
generator is mulberry32 (the seedable PRNG in the LUSCA source), so
`node sample.mjs` prints the same text for the same seed. Without --seed, OS
randomness is used, as on the server.
"""
import argparse
import json
import math
import os
import random
import re
import struct
import sys
import unicodedata

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

# id 0 = '\n', ids 1..95 = printable ASCII 32..126
VOCAB = "\n" + "".join(chr(c) for c in range(32, 127))
NL, SP, DROP = 0, 1, -1


# ─── weights ────────────────────────────────────────────────────────────────

def load_safetensors(path):
    """Minimal safetensors reader (F32 tensors): returns ({name: ndarray}, metadata)."""
    with open(path, "rb") as f:
        raw = f.read()
    (n,) = struct.unpack("<Q", raw[:8])
    header = json.loads(raw[8:8 + n].decode("utf-8"))
    meta = header.pop("__metadata__", None) or {}
    base = 8 + n
    tensors = {}
    for name, info in header.items():
        if info["dtype"] != "F32":
            raise ValueError(f"{name}: dtype {info['dtype']} is not supported")
        begin, end = info["data_offsets"]
        arr = np.frombuffer(raw, dtype="<f4", count=(end - begin) // 4, offset=base + begin)
        tensors[name] = arr.reshape(info["shape"]).astype(np.float32)
    return tensors, meta


class Sepia:
    """logits = tanh(concat_t emb[ids_t] @ W1 + b1) @ W2 + b2   (matrices are [in, out])"""

    def __init__(self, path=os.path.join(HERE, "model.safetensors")):
        t, self.meta = load_safetensors(path)
        self.emb, self.W1, self.b1, self.W2, self.b2 = (t[k] for k in ("emb", "W1", "b1", "W2", "b2"))
        self.V, self.E = self.emb.shape
        self.H = self.W1.shape[1]
        self.T = self.W1.shape[0] // self.E
        self._W1 = self.W1.astype(np.float64)
        self._W2 = self.W2.astype(np.float64)

    def logits(self, ctx):
        """Logits (float32[V]) for a context of T ids, oldest first."""
        x = self.emb[np.asarray(ctx, dtype=np.int64)].reshape(-1).astype(np.float64)
        h = self.b1.astype(np.float64)
        for i in range(self.T * self.E):
            h = (h + x[i] * self._W1[i]).astype(np.float32).astype(np.float64)
        h = np.tanh(h).astype(np.float32).astype(np.float64)
        lg = self.b2.astype(np.float64)
        for i in range(self.H):
            lg = (lg + h[i] * self._W2[i]).astype(np.float32).astype(np.float64)
        return lg.astype(np.float32)


# ─── vocabulary (same mapping as shared/sepia/model.mjs encode) ─────────────

def _build_map():
    m = [SP] * 65536  # unknown symbol → space
    for c in range(32, 127):
        m[c] = c - 31
    for c in range(0, 32):
        m[c] = DROP  # C0 controls
    m[10] = NL
    m[9] = SP
    m[11] = NL
    m[12] = NL
    for c in range(127, 160):
        m[c] = DROP  # DEL + C1 controls
    m[0x85] = NL
    m[0x2028] = NL
    m[0x2029] = NL

    def set_all(chars, i):
        for ch in chars:
            m[ord(ch)] = i

    set_all("‘’‚‛′‵ʼʹ´＇", ord("'") - 31)
    set_all("“”„‟″‶«»ʺ＂", ord('"') - 31)
    set_all("‐‑‒–—―−⁃﹘﹣－⸺⸻", ord("-") - 31)
    set_all("•‣●▪∙·", ord("*") - 31)
    set_all("×", ord("x") - 31)
    set_all("­﻿", DROP)  # soft hyphen, BOM
    for a, b in ((0x200B, 0x200F), (0x2060, 0x2064), (0x0300, 0x036F), (0x1AB0, 0x1AFF), (0x1DC0, 0x1DFF),
                 (0x20D0, 0x20FF), (0xFE00, 0xFE0F), (0xFE20, 0xFE2F), (0xDC00, 0xDFFF)):
        for c in range(a, b + 1):
            m[c] = DROP
    return m


_MAP = _build_map()


def encode(text, keep_trailing=False):
    """Text → vocabulary ids (NFKD, symbol folding, whitespace tidying as in the LUSCA corpus)."""
    try:
        s = unicodedata.normalize("NFKD", text)
    except Exception:
        s = text
    out = []
    for ch in s:
        cp = ord(ch)
        i = _MAP[cp] if cp < 65536 else SP  # characters beyond the BMP become one space
        if i == DROP:
            continue
        if i == SP:
            if not out or out[-1] == SP or out[-1] == NL:
                continue
        elif i == NL:
            if out and out[-1] == SP:
                out.pop()
            if not out:
                continue
            if len(out) >= 2 and out[-1] == NL and out[-2] == NL:
                continue
        out.append(i)
    if not keep_trailing:
        while out and (out[-1] == SP or out[-1] == NL):
            out.pop()
    return out


def decode(ids):
    return "".join(VOCAB[i] if 0 <= i < len(VOCAB) else " " for i in ids)


# ─── sampling ───────────────────────────────────────────────────────────────

def mulberry32(seed):
    """Seedable PRNG, floats in [0, 1); identical sequence to mulberry32 in the LUSCA source."""
    M = 0xFFFFFFFF
    state = [seed & M]

    def rand():
        state[0] = (state[0] + 0x6D2B79F5) & M
        t = state[0]
        t = ((t ^ (t >> 15)) * (t | 1)) & M
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & M)) & M
        return ((t ^ (t >> 14)) & M) / 4294967296

    return rand


def _js_round(x):
    return math.floor(x + 0.5)


def _utf16_prefix(s, k):
    """First k UTF-16 code units of s (how the server cuts prompts)."""
    b = s.encode("utf-16-le", "surrogatepass")
    return b[:2 * k].decode("utf-16-le", "surrogatepass")


def generate(model, prompt="", n=240, temperature=0.8, rand=None):
    """Prompt + n sampled characters, with /api/generate's input handling."""
    prompt = _utf16_prefix(re.sub(r"\r\n?", "\n", prompt or ""), 200)
    n = min(600, max(1, _js_round(float(n))))
    temperature = min(2.0, max(0.05, float(temperature)))
    rand = rand or random.random

    T, V = model.T, model.V
    p = encode(prompt, keep_trailing=True)
    ctx = [NL] * T
    k = min(T, len(p))
    if k:
        ctx[T - k:] = p[len(p) - k:]
    temp = max(1e-3, temperature)
    out = []
    for _ in range(n):
        lg = [float(v) for v in model.logits(ctx)]
        mx = max(lg)
        probs = [math.exp((v - mx) / temp) for v in lg]
        total = 0.0
        for q in probs:
            total += q
        r = rand() * total
        idx = V - 1
        for c in range(V):
            r -= probs[c]
            if r <= 0:
                idx = c
                break
        out.append(idx)
        ctx = ctx[1:] + [idx]
    return prompt + decode(out)


def main():
    ap = argparse.ArgumentParser(description="Sample text from SEPIA-0 (character-level, 187,104 parameters).")
    ap.add_argument("prompt", nargs="?", default="", help="text to continue (last 16 characters are the context)")
    ap.add_argument("--n", type=float, default=240, help="characters to generate, 1..600 (default 240)")
    ap.add_argument("--temperature", type=float, default=0.8, help="0.05..2 (default 0.8)")
    ap.add_argument("--seed", type=int, default=None, help="mulberry32 seed for reproducible output")
    ap.add_argument("--weights", default=os.path.join(HERE, "model.safetensors"), help="path to model.safetensors")
    a = ap.parse_args()
    model = Sepia(a.weights)
    rand = mulberry32(a.seed) if a.seed is not None else None
    text = generate(model, a.prompt, a.n, a.temperature, rand)
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass
    print(text)


if __name__ == "__main__":
    main()
