# Update 2/3: SEPIA-1 tokenizer (milestone M1)

Branch `update/tok` in `C:/Users/PC/lw/tok`. Local commits only: nothing was pushed, deployed or uploaded.

## What it is

SEPIA-1 is the code-reading model LUSCA plans to train on protocol code. Before any model can be trained it needs a tokenizer: the fixed table that cuts text into the pieces the model reads. This update trains that tokenizer (milestone M1 of SEPIA-1), measures it honestly on files it never saw, and ships it in the app so anyone can paste code on `/sepia` and see how it is cut, next to the GPT tokenizers.

- 32,768 entries, byte-level BPE (any file encodes losslessly), built for code. Indentation is one token per level. Operators such as `=>`, `::`, `!=` and `#[` are never split. `msg.sender` can be one token. Numbers go one digit per token. Long hex addresses and hashes are cut into 4-digit groups so they do not use up the vocabulary.
- **The SEPIA-1 model itself is not trained yet.** The page says so in the milestone strip.

## Results

All numbers are measured on 1,052 documents set aside by hash before training and never trained on (`models/sepia-1-tokenizer/eval.json`, regenerated 2026-10-06 09:22 UTC).

| Held-out set | SEPIA-1 (32,768) | o200k_base | cl100k_base | GPT-2 r50k_base |
|---|---:|---:|---:|---:|
| All code, bytes per token (higher is better) | **4.22** | 4.03 | 4.01 | 2.41 |
| Tokens SEPIA-1 needs for the same code | | 4.6% fewer | 5.1% fewer | 43.0% fewer |
| Web text, bytes per token | 3.79 | **4.26** | 4.15 | 3.80 |

- Best on every code language except C/C++ (cl100k 3.81 vs 3.78, only 9 files). Behind on English prose and Markdown: the cost of a vocabulary 3–6× smaller than cl100k/o200k.
- Lines in one 2,048-token window: Solidity 225 (o200k 216), Rust 258 (o200k 245), Move 233 (o200k 226).
- Exact round trip on all 1,052 held-out documents.
- The browser encoder matches the Python reference (Hugging Face `tokenizers` 0.20.3) on all 2,287,501 held-out tokens and on 5,518 test strings, 0 mismatches. The test strings now include Unicode 15/16 letters and digits and 3,000 random strings over all of Unicode.
- Training is deterministic: training twice gives a byte-identical `tokenizer.json` (sha256 `4b2ec96e…`). The tokenizer itself did not change in this round.

## Review round: what changed

Every blocker and major finding is fixed, and so is every minor one except the pre-existing persistence issue, which is out of scope (see Risks).

| Finding | Fix |
|---|---|
| **Major: playground examples were training files** | The four examples now come from the held-out split: Solmate ERC4626 `deposit()`/`mint()`, an OpenBook v2 Anchor instruction, DeepBook `math.move` and OpenZeppelin Cairo `royalty_info`. I chose them for being recognisable before I looked at their counts. `examples.py` refuses any file that is not on the held-out list, `_test.ts` checks it again, and the page shows "HELD OUT · NOT IN TRAINING" under each one. Their counts are mixed and shown as they are: 201/205/207, 290/309/305, 264/257/261 (SEPIA-1 uses more on the Move excerpt) and 280/323/324 (SEPIA-1 / o200k / cl100k). MEDIA_FACTS.json says to quote only the held-out totals. |
| **Major: TS encoder depended on the JS engine's Unicode version** | `shared/sepia1/unicode-classes.ts` holds the exact `\p{L}` and `\p{N}` code-point sets that Oniguruma uses in `tokenizers` 0.20.3: 131,756 letter and 1,791 number code points. `scripts/tokenizer/unicode_classes.py` measures them by running the tokenizer's own regex over every code point. The encoder substitutes them for `\p{L}`/`\p{N}` before compiling the regex and refuses any other Unicode property. I added Unicode 15/16 letters and digits (CJK Ext H/I, Kawi, Nag Mundari, Garay, Kirat Rai, Sunuwar, outlined digits) and 3,000 seeded random strings over all of Unicode to the fixtures (2,518 → 5,518). Result: 0 mismatches. With the old unpinned regex, Node 24 (Unicode 16) gets 548 of the 5,518 wrong, so the test now catches this class of bug. The reviewer's two cases (`U+31350` + `11`; long hex followed by `U+31350`) are explicit tests. |
| Minor: bold ≠ best in eval.md / model card | `eval.ts` and `finalize.py` now bold the best value in each row, whichever tokenizer it belongs to. Regenerated `eval.md`, `MODEL_CARD.md` and `manifest.json`. |
| Minor: "61.8% code" mixed definitions | Now reads: 61.8% from the code index (49.5% source code, 11.8% Markdown docs and EIPs, 0.5% Anchor IDL JSON), 38.2% web text. Updated in the model card (computed in `finalize.py`) and in `docs/SEPIA-1.md`. |
| Minor: special tokens counted differently | The playground encodes with `allowSpecial: false`, the same as `eval.ts`, so `<|endoftext|>` is plain text for all three tokenizers. |
| Minor: silent 40,000-char cut | The cap is now 100,000 characters. Text is cut at a line break when possible and never inside a surrogate pair, and an orange notice says "showing the first N characters of M". |
| Minor: tokens wrapping mid-chip | Chips use `white-space: pre`, with a `<wbr>` after each one, so lines break only between tokens. Headless check: 0 split chips at 1440 px and at 375 px. |
| Minor: main thread blocked by o200k | GPT counts are debounced by 250 ms. They are skipped, with a note, when the text has one unbroken run of 5,000 or more characters. Measured: a 39,000-character word now takes about 80 ms to the first frame (was about 1,800 ms). |
| Minor: mobile table hid comparisons | Below 720 px the table shows language, files, SEPIA-1 and o200k, and every value is visible: inner overflow is 0 at 375 px. A footnote says where cl100k and r50k are. The metric switch wraps instead of being cut off. |
| Minor: artifacts not served at a stable path | A Vite plugin copies the release files to `dist/models/sepia-1-tokenizer/` (and serves them in dev). The playground loads `tokenizer.json` from there. The footer links (model card, eval table, manifest) point there too, not to GitHub `main`. `server/http.ts` gets one MIME line (`.md` → `text/plain`) so the model card opens in the browser. |
| Minor: GPT chip byte counts | A GPT token that is part of a multi-byte character now says "part of a multi-byte character" instead of a wrong "3 bytes". |
| Minor: weak per-language evidence | The table footnote says code is held out by file and the repos overlap with training. Rows with fewer than 30 files are marked † "indicative only". The same caveat is in `eval.md`, the model card and the design doc. The section intro now says "evaluated on files set aside before training". |
| Minor: smoke test never rendered the component | New `scripts/tokenizer/_render_test.ts` (in `npm test`). It loads the real `Tokenizer.tsx` through Vite's SSR loader, renders it with `react-dom/server` and the trained tokenizer, and checks the milestone strip, the held-out label, all three counts, one chip per token and the release links. |
| Minor: 1.9 MB downloaded on scroll | The o200k/cl100k tokens of the four examples are precomputed in `examples-gpt.json` (30 KB). `_test.ts` re-encodes them and fails if the file is stale. Scrolling to the section now loads only the section chunk (25 KB gzipped) and `tokenizer.json` (395 KB gzipped). The GPT encodings (about 1.46 MB gzipped) load only when someone focuses or edits the editor. Verified with the network log in headless Edge. |
| Minor: SEPIA-0 step counter goes back after a hard kill | **Not changed (pre-existing on `main`, not caused by this branch).** Reproduced again: `model.version` 4,918,200 before `taskkill /F`, 4,916,725 after restart. Pages 335 → 336, jobsDone 985 = 985, credits issued 2,462.28 = 2,462.28. It needs a server-side fix in the SEPIA-0 checkpoint path, which the other two updates may also touch, so I kept it out of this branch. |

Disagreement: the reviewer suggested also writing the explicit classes into `tokenizer.json`. I did not. It would change the trained file's sha256, the model card and the Hugging Face package, and gain nothing: Python behaviour is already fixed by `tokenizers` 0.20.3, and the TS encoder no longer depends on the engine.

## Files

Changed in this round, on top of the four earlier commits:

- `shared/sepia1/tokenizer.ts`: pins `\p{L}`/`\p{N}` (`pinUnicodeClasses`). New: `shared/sepia1/unicode-classes.ts` (generated), `scripts/tokenizer/unicode_classes.py`.
- `scripts/tokenizer/examples.py`: held-out examples only, refuses others. Regenerated `src/components/sepia/tokenizer/examples.ts`. New: `scripts/tokenizer/examples-gpt.ts` → `src/components/sepia/tokenizer/examples-gpt.json`.
- `scripts/tokenizer/export_ids.py`: Unicode 15/16 and fuzz fixtures. Regenerated `scripts/tokenizer/_fixtures.json.gz` (5,518 strings).
- `scripts/tokenizer/eval.ts`: bold-best tables, fixture parity recorded in `eval.json`. `scripts/tokenizer/finalize.py`: bold-best, mix breakdown, caveats, Unicode note. Regenerated `models/sepia-1-tokenizer/{eval.json, eval.md, MODEL_CARD.md, manifest.json}`; `tokenizer.json`, `vocab.json` and `merges.txt` are unchanged.
- `src/components/sepia/tokenizer/Tokenizer.tsx` and `tokenizer.css`: all playground fixes above. `src/pages/Sepia.tsx`: intro wording.
- `scripts/tokenizer/_test.ts`: held-out check, precomputed GPT check, Unicode tests. New: `scripts/tokenizer/_render_test.ts` and `_render_entry.mjs`. `package.json`: the `test` line runs the render test.
- `vite.config.ts`: `tokenizerRelease()` plugin. `server/http.ts`: `.md` MIME type.
- `docs/SEPIA-1.md` (M1 status), `CHANGELOG.md`.

## How to test locally

```bash
cd C:/Users/PC/lw/tok
npx tsx scripts/tokenizer/_test.ts          # parity on 5,518 strings, Unicode pins, examples held out, GPT precompute fresh
npx tsx scripts/tokenizer/_render_test.ts   # renders the real component (Vite SSR)
npm run typecheck && npm test && npm run build
node scripts/hf/build-tokenizer-release.mjs --out <scratch dir> && npx tsx scripts/hf/verify-tokenizer-release.mjs --dir <scratch dir>
```

All of these passed on 2026-10-06 between 03:20 and 03:45 local. The HF verify includes Python `tokenizers` and `transformers` parity on the new 5,518 fixtures.

Start the server for review or filming (Git Bash):

```bash
cd C:/Users/PC/lw/tok && npm run build && PORT=8802 LUSCA_DATA=C:/Users/PC/lw/data-tok LUSCA_AGENTS=2 npx tsx server/index.ts
```

PowerShell:

```powershell
cd C:\Users\PC\lw\tok; npm run build; $env:PORT='8802'; $env:LUSCA_DATA='C:/Users/PC/lw/data-tok'; $env:LUSCA_AGENTS='2'; npx tsx server/index.ts
```

Then open http://127.0.0.1:8802/sepia#sp-tok. The shot list is in `MEDIA_FACTS.json`. Screenshots from this round are in `C:/Users/PC/lw/data-tok/qa/v2-desk-*.png` and `v2-mob-*.png`, and final ones in `final2-*.png`.

## Deploy notes

- **Env vars:** none new. **Migrations:** none. **RPC:** none. **Server code:** one line (`.md` served as `text/plain`).
- **Disk:** `dist/models/sepia-1-tokenizer/` adds 1.9 MB. The hashed `tokenizer.json` asset is gone, so it is not served twice. The repo grows by about 0.4 MB more than last round (fixtures 665 KB → 1,016 KB, plus 30 KB of precomputed example tokens).
- **CPU / memory:** no server work. The static handler caches gzipped copies of files once they are requested, a few MB.
- **Browser payload:** scrolling to the section loads 25 KB + 395 KB gzipped. Editing the text loads the GPT encodings, 1.46 MB gzipped. The build still warns about the o200k chunk being over 1.6 MB. It is loaded lazily and only on edit.
- **Caching:** `/models/sepia-1-tokenizer/*` is served with `max-age=300` plus an ETag, so a new release shows up within 5 minutes.

## Risks

- SEPIA-0's public step counter can go back after a hard kill. This is pre-existing on `main` and not touched here (details above). The tokenizer section has no server state, so a reload or restart cannot change its numbers. They come from `eval.json` or are computed in the tab.
- The "training scripts" footer link still points to GitHub `main/scripts/tokenizer`. It works once the branch is merged and pushed.
- The code holdout is by file, not by repository, so the code numbers may be slightly optimistic. This is stated on the page, in the model card and in the design doc.

## What is left

- **Hugging Face upload** (owner): the command is in the header of `scripts/hf/build-tokenizer-release.mjs`. The package is built and verified. Please confirm the **MIT license** first: the design doc leaves the release license open.
- The rest of SEPIA-1 is not started: the M1 reference model, the shard builder, the offline reference run and the ablations.

## Merging

Expect small conflicts in `package.json` (the `test` line), `CHANGELOG.md` (the "Added" list) and the page outline in `src/pages/Sepia.tsx`. `vite.config.ts` gains one plugin, and `server/http.ts` one MIME line. After each commit git prints "fatal: '$GIT_DIR' too big" because the shared repository's path is long. The commits themselves are fine.
