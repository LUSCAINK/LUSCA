# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, never in a public issue, pull request or discussion:

- email **lusca@collider.capital**, or
- GitHub: **Security → Report a vulnerability** on https://github.com/LUSCAINK/LUSCA (private
  advisory).

Include what you found, how to reproduce it and its impact. We aim to acknowledge reports within
3 days and to keep you informed until a fix ships. Please allow reasonable time for a fix before
disclosing, and do not access other people's data, disrupt the service or move funds while testing.
Test against your own local server (`npm run dev`, see the README) wherever you can, rather than
against https://lusca.ink.

## Scope

In scope: this repository and the service it runs at https://lusca.ink.

- the server (`server/`), including the REST API, the WebSocket hub and the data agents;
- the wire protocol and shared code (`shared/`), including SEPIA and the gradient codec;
- the web client (`src/`), including the WebGPU neuron;
- the desktop neuron (`scripts/neuron.ts` and the published `https://lusca.ink/neuron.mjs`);
- the INK ledger, wallet sign-in (`server/auth/`) and the payout engine (`server/payouts/`).

Of particular interest:

- earning INK without doing the work, including passing training-gradient checks or audits with
  fabricated gradients;
- redirecting another identity's INK or session;
- anything that could make the payout engine sign an unintended transaction;
- anything that makes a neuron run code or sign something it should not.

Out of scope: third-party services (Render, Solana RPC providers, wallets, GitHub), servers run by
other people from forks of this code, volumetric denial of service, and findings that need a
compromised device or browser.

## No secrets in issues

Never paste secrets into an issue, a pull request, a discussion or a log you share: no session
tokens (`--auth` values), keypair files, seed phrases, private keys, `auth.secret`, `hash.salt` or
`.env` contents. Redact them from logs and screenshots. If you posted one by mistake, rotate it
(sign in again for a new token; move funds off a key) and tell us at lusca@collider.capital.

## Secrets (for maintainers and operators)

- Never commit secrets. `.gitignore` excludes `.env*`, `server/data/`, `keys/`, keypair files and
  checkpoints; still check `git status` before every commit.
- `LUSCA_TREASURY_SECRET` (the treasury signing key) is set only as a secret environment variable on
  the host (on Render: `sync: false` in `render.yaml`, entered in the dashboard). The server never
  writes it to disk or logs. Keep only working funds in the treasury wallet.
- `LUSCA_AUTH_SECRET` signs wallet session tokens; rotating it signs every wallet out.
- `<LUSCA_DATA>/hash.salt` protects hashed device ids and IPs in public payloads. Back it up with the
  ledger and treat it as a secret.
- If a secret is exposed (committed, pasted into an issue or a log), rotate it immediately. Removing
  it from git history is not enough.

## For neuron operators

LUSCA never asks for a transaction, a private key or a seed phrase. Wallet verification is one signed
plain-text message. For the desktop neuron use `--auth <token>` or a dedicated payout-only keypair
(`--keypair`), never a wallet that holds funds. Download `neuron.mjs` only from https://lusca.ink or
build it from this repository (`npm run build:neuron` writes `dist/neuron.mjs` and its checksum to
`dist/neuron.mjs.sha256`).
