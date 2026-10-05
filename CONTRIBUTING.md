# Contributing to LUSCA

Thanks for helping. This file covers setup, tests and the conventions the code follows.

## Setup

Requires Node 22.12+ (CI and production use Node 24, pinned in `.node-version`) and npm, on
Windows, macOS or Linux. The desktop neuron alone (`dist/neuron.mjs`) runs on Node 20+.

1. Fork https://github.com/LUSCAINK/LUSCA on GitHub (the **Fork** button).
2. Clone your fork and add the main repository as `upstream`:

```bash
git clone https://github.com/<your-username>/LUSCA.git
cd LUSCA
git remote add upstream https://github.com/LUSCAINK/LUSCA.git
npm ci               # exact versions from package-lock.json
npm run dev          # server on :8787, web app on http://localhost:5173
```

Stop with Ctrl+C. If ports 8787 or 5173 are taken, or you need to set environment variables on
Windows, see [Run locally](README.md#run-locally) in the README: it lists the PowerShell and cmd
forms of each command.

Runtime data (dataset, SEPIA checkpoint, credit ledger, salts, auth secret) is written to
`server/data/` or `LUSCA_DATA` and is git-ignored. Never commit it. Running the server starts the
data agents, which fetch public web pages; keep `LUSCA_AGENTS` low for local work.

## Before you open a pull request

```bash
npm test             # coordinator, wallet auth, payout engine, SEPIA math and trainer tests (~1.5 min)
npm run typecheck    # client + server, must be clean
npm run lint         # oxlint: no errors (existing warnings are known)
npm run build        # app + dist/neuron.mjs must build
```

`npx tsx shared/sepia/_test.ts` runs only the SEPIA math tests, which is quicker while you work on
SEPIA math, the GPU trainer or the gradient codec.

If you change anything a user sees, run `npm run dev` and check the page in a browser at desktop
and phone widths. If you change the WGSL training kernels (`src/lib/gpu/train`), open
http://localhost:5173/src/lib/gpu/train/harness.html with `npm run dev` running, in a browser with
WebGPU. It runs the self-test, which compares the GPU gradient against `shared/sepia` on a fixed
batch, and prints the result as JSON on the page.

If you change the desktop neuron or the protocol, run it against your local server:

```bash
npx tsx scripts/neuron.ts --server ws://127.0.0.1:8787/ws --jobs 3   # exits after 3 verified jobs
```

## Where things live

- `shared/protocol.ts` is the wire contract between server, browser and desktop neuron. Changes
  must stay backward compatible: add optional fields; do not rename or repurpose existing ones.
- `shared/sepia/` is the single SEPIA implementation. The server audits neuron gradients against it,
  so the browser and desktop paths must produce the same math.
- `src/components/docs/facts.ts` transcribes every constant the in-app manual quotes. If you change a
  constant in the server, update it there in the same pull request.
- `server/neurons/` decides what earns credits. Changes there need a test in `server/neurons/_test.ts`.

## Code style

- TypeScript everywhere except the dependency-free `.mjs` modules shared with workers (each has a
  `.d.mts` next to it).
- Formatting follows the existing files: 2-space indent, single quotes, no semicolons in `src/`,
  lines up to about 150 columns.
- Prefer small, pure functions and explicit units in names (`ms`, `kb`, `flops`).
- No new runtime dependency without a reason in the pull request description.
- UI numbers come from the server. If a value is unavailable, show "—"; never fill in recorded or
  generated values.
- User-facing copy is plain and technical: say what the code does, label anything not built yet as
  planned, and do not promise returns.

## Commits and pull requests

- Work on a branch in your fork (`git switch -c my-change`), keep it current with
  `git pull --rebase upstream main`, push it to your fork and open a pull request against
  `LUSCAINK/LUSCA` `main`.
- One topic per pull request, with a description of what changed and how you checked it.
- Do not include secrets, keypairs, `.env` files or anything from `server/data/`.
- Security problems go to lusca@collider.capital, not to an issue or pull request
  (see [SECURITY.md](SECURITY.md)).
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests and build on every pull request.
- Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
- By contributing you agree that your contribution is licensed under the MIT License in `LICENSE`.
