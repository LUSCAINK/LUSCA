# SEPIA-1 tokenizer: held-out evaluation

Tokenizer sha256 `4b2ec96ed69a7c9fe7a7c01bd01e4d4c95f527384d6ee3862e43e850ed54d04f`. 1052 of 1052 held-out documents round-trip exactly; the TypeScript encoder matches the Python tokenizer on 2,287,501 tokens with 0 mismatches.

## Bytes per token (higher is better)

| Language | Docs | MB | SEPIA-1 (32,768) | r50k (GPT-2) | cl100k | o200k |
|---|---:|---:|---:|---:|---:|---:|
| Solidity | 239 | 1.52 | **4.44** | 2.49 | 4.23 | 4.27 |
| Vyper | 15 | 0.28 | **4.34** | 2.56 | 3.93 | 3.93 |
| Rust / Anchor | 167 | 1.68 | **4.44** | 2.18 | 4.20 | 4.21 |
| Move | 59 | 0.63 | **4.20** | 2.45 | 4.10 | 4.09 |
| Cairo | 51 | 0.32 | **3.83** | 2.44 | 3.74 | 3.76 |
| Go | 138 | 1.27 | **3.87** | 2.64 | 3.62 | 3.67 |
| C / C++ | 9 | 0.23 | **3.78** | 2.21 | 3.81 | 3.80 |
| TypeScript | 16 | 0.11 | **4.30** | 2.43 | 3.89 | 3.91 |
| Python | 15 | 0.16 | **4.61** | 2.49 | 4.27 | 4.24 |
| Markdown (EIPs, docs) | 141 | 1.51 | **3.54** | 2.99 | 3.65 | 3.67 |
| Web text (English, crypto) | 202 | 1.51 | **3.79** | 3.80 | 4.15 | 4.26 |
| **All code** (no Markdown) | | 6.19 | **4.22** | 2.41 | 4.01 | 4.03 |

## Tokens per 1,000 lines (lower is better)

| Language | SEPIA-1 | r50k | cl100k | o200k |
|---|---:|---:|---:|---:|
| Solidity | **9,106** | 16,256 | 9,557 | 9,471 |
| Vyper | **7,405** | 12,558 | 8,192 | 8,187 |
| Rust / Anchor | **7,935** | 16,155 | 8,392 | 8,375 |
| Move | **8,807** | 15,134 | 9,032 | 9,049 |
| Cairo | **8,908** | 13,974 | 9,107 | 9,068 |
| Go | **8,927** | 13,103 | 9,542 | 9,431 |
| C / C++ | **10,489** | 17,945 | 10,405 | 10,421 |
| TypeScript | **8,365** | 14,787 | 9,242 | 9,206 |
| Python | **6,040** | 11,157 | 6,517 | 6,565 |
| Markdown (EIPs, docs) | **15,703** | 18,599 | 15,227 | 15,126 |
| Web text (English, crypto) | **18,579** | 18,542 | 16,970 | 16,560 |

## Lines in one 2,048-token window

| Language | SEPIA-1 | r50k | cl100k | o200k |
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

Encoder speed (TypeScript, Node, one core): 6.71 MB/s.
