# LUSCA Lens

Paste a Solana program id or an Ethereum, Base or Arbitrum contract address; LUSCA reads it on-chain
and returns a deterministic report. Every fact in the report was read during that request (RPC, the
Sourcify and OtterSec registries) or comes from LUSCA's own stores (protocol code index, chain
index), and carries the link it came from. No language model writes any of it; a field that could
not be read stays empty and says so.

Page: `/lens`, shareable as `/lens/:chain/:address`. Code: `server/lens/*`, `shared/lens.ts`,
`src/pages/Lens.tsx`.

## What a report contains

| | Solana program | EVM contract |
|---|---|---|
| Code & deployment | loader, upgradeable, upgrade authority, programdata address, executable size, last deploy slot, code hash (solana-verify rule) | runtime bytecode size, code hash (metadata trailer removed), proxy standard (EIP-1967, EIP-1822, beacon, EIP-1167, ZeppelinOS, EIP-897, Safe, EIP-7702) followed to the implementation, admin slot |
| Verification | OtterSec verified build: repository + commit, or the reason it is not verified. When OtterSec cannot be asked (endpoint down, budget) the state is `unknown` ("not checked"), never "not verified", and the report is cached for one minute only | Sourcify full / partial match, contract name, compiler, deploy block, source files (proxy and implementation) |
| Interface | on-chain IDL (Anchor IDL account or program-metadata; Anchor ≤ 0.29, ≥ 0.30, Codama): instructions with accounts (signer / writable / optional) and typed args, account types, errors, events | verified ABI grouped as state-changing, payable, view / pure; events |
| Privileged | instructions whose IDL requires a signer named as a role (admin, operator, governance, fee / config / upgrade authority…) | state-changing ABI functions guarded by an access-control modifier (any modifier whose body checks the caller, directly or through a `_check*` / `_auth` helper) or by a check of `msg.sender` against stored state, with file:line. Checks against the function's own parameters (`msg.sender == from`) are a user's own permission and are not listed |
| Cryptography | syscall imports from the ELF dynamic symbol table (`sol_sha256`, `sol_keccak256`, `sol_blake3`, `sol_poseidon`, `sol_secp256k1_recover`, curve25519, alt_bn128, big_mod_exp), hashed syscall ids in `call` instructions (murmur3, static syscalls), native signature-verification program ids found in the binary | `keccak256`, `sha256`, `ripemd160`, `ecrecover`, `ECDSA.recover`, EIP-1271, EIP-712, Merkle proofs, precompile calls (modexp, BN254 add / mul / pairing, BLAKE2f, KZG point evaluation, RIP-7212 P-256), with file:line |
| Provenance | the OtterSec build repository, and whether LUSCA's code index holds it (and at which commit) | each verified file compared with the code index: `≡` the same bytes are in `owner/repo@commit:path`, `≈` same code once comments / whitespace / pragma are removed; counted separately. The code index keeps one copy of a file that several repositories share, so the repository named holds the file; it is not necessarily where the file was first written |
| SEPIA-1 dataset | verdict before the read (kept index, agents' feed), verdict now under the chain agents' own rules (`evaluateRead`) | same; behind a proxy the implementation is judged (that is the code) |

A read the rules keep (verified, new, not boilerplate, not a token mint) is handed to the chain
store exactly like an agent read, with discovery source `lens`, and appears in the chain feed. Every
other verdict is reported and nothing is stored or counted. Lens-originated keeps are capped: at most
50 items and 16 MB of source per UTC day (`<data>/lens/keeps.json`), and none once the chain store is
80 % full (the rest is the agents' headroom). A read over the cap says "passes the SEPIA-1 rules but
was not stored" and why. Nothing is handed to the store after a read's 60 s deadline.

## Source analysis on hostile input

Anyone can verify a contract on Sourcify, so the source analysis (privileged functions, primitives)
is written to stay linear on any input: comments are blanked, every whitespace run is collapsed to one
character before matching (a map keeps the verified file's line numbers), no pattern has two
unbounded quantifiers over the same characters, precompile calls are found by reading the call's
arguments instead of a regex, and one contract's analysis spends from a fixed work budget (400 M
characters scanned, about 4× what a 6 MB real bundle needs; real bundles cost 11–17 per byte) with an
8 s wall-clock backstop. Over the budget the report says "analysis not completed" and lists nothing,
since a partial list would read as a complete one.

## API

```
GET /api/lens/:chain/:address   chain = solana | ethereum | base | arbitrum   → LensAnswer
GET /api/lens/detect/:address   0x address: eth_getCode on the three EVM chains → LensDetect
GET /api/lens/recent            { reads, recent: LensRecent[] }   (public strip, newest first)
GET /api/lens/status            { budget, inFlight, cached, index }
```

Errors are JSON `{ error }` with 400 (validation), 404, 429 (+ Retry-After), 502 / 503 (an
endpoint did not answer usably: nothing is guessed), 504 (read over 60 s).

## Guards and budgets

- Validation: base58 32-byte Solana keys; `0x` + 40 hex for EVM (stored lower-case).
- Per IP (IPv6: per /64): fresh reads 5 / min, 40 / h and 100 / day; cached answers 60 / min; detect 12 / min,
  60 / h and 200 / day; recent / status 120 / min.
- Detect answers are cached per address and chain for 6 h (no code is an answer too); only chains that
  did not answer are asked again.
- At most 3 reads at once; 6 more wait up to 20 s, then 503.
- One read per address however many ask at the same moment (in-flight dedupe).
- Cache: 15 min, in memory (100 reports) and on disk (`<data>/lens/cache`, ≤ 600 files, pruned).
- Budget: Lens has its own daily slice of every budget (`<data>/lens/budget.json`, resets 00:00 UTC),
  charged on top of the shared chain budget. Defaults are 15 % of the agents' RPC limits and 40 % of
  the registry limits: Solana 1 200 calls (of 8 000), each EVM chain 2 250 (of 15 000), Sourcify and
  OtterSec 2 000 each (of 5 000, LUSCA's own politeness cap; the registries are free public services).
  A read checks every slice it needs (chain RPC and its registry) before its first call, and a call
  the shared layer would refuse is not charged to the slice.
  Lens can therefore never take more than its slice from the chain agents (who pace themselves to
  what is left), and the shared limit, the Helius budget in production, is never exceeded.
- A Solana read costs 1 RPC call + 1 OtterSec request; an EVM read 1–6 RPC calls + 1 Sourcify
  request, twice for a proxy (proxy + implementation). The page's "same address on other chains" line
  costs up to 2 more `eth_getCode` calls the first time an address is viewed (then cached for 6 h).

Env: `LUSCA_LENS=0` (off) · `LUSCA_LENS_SOL_CALLS` · `LUSCA_LENS_EVM_CALLS` · `LUSCA_LENS_HTTP_CALLS`.

## Persistence

`<data>/lens/recent.json` (reads served + recent strip) is written with tmp + fsync + rename after
every read. `budget.json` is written ahead: before a call is made, the file already holds at least
that call (a block of 16 is reserved at a time), and the exact count is written after each read, so
the count shown never goes down after a restart or a hard kill (after a kill it can be up to 16
higher than the calls actually made). `keeps.json` is written after every Lens-kept item.

The public "recent reads" strip names only verified code that the SEPIA-1 rules kept (or already
held), and only plain names (no links, handles or domains, at most 48 characters); every other row
shows its address. Contract names are chosen by whoever deploys the contract.
`<data>/lens/provenance.json` holds the code-index hashes (rebuilt per repository only when its
commit or shards change; the first build after a deploy hashes the whole index in the background,
yielding between records).

## Live check

`LUSCA_DATA=<dir> npx tsx server/lens/_live.ts solana:<id> ethereum:<0x…> …` reads real addresses
over public RPCs into a separate data directory (never point it at a running server's directory).
