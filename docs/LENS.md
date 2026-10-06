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
| Verification | OtterSec verified build: repository + commit, or the reason it is not verified | Sourcify full / partial match, contract name, compiler, deploy block, source files (proxy and implementation) |
| Interface | on-chain IDL (Anchor IDL account or program-metadata; Anchor ≤ 0.29, ≥ 0.30, Codama): instructions with accounts (signer / writable / optional) and typed args, account types, errors, events | verified ABI grouped as state-changing, payable, view / pure; events |
| Privileged | instructions whose IDL requires a signer named as a role (admin, operator, governance, fee / config / upgrade authority…) | state-changing ABI functions guarded by an access-control modifier (any modifier whose body checks the caller, directly or through a `_check*` / `_auth` helper) or by a check of `msg.sender` against stored state, with file:line. Checks against the function's own parameters (`msg.sender == from`) are a user's own permission and are not listed |
| Cryptography | syscall imports from the ELF dynamic symbol table (`sol_sha256`, `sol_keccak256`, `sol_blake3`, `sol_poseidon`, `sol_secp256k1_recover`, curve25519, alt_bn128, big_mod_exp), hashed syscall ids in `call` instructions (murmur3, static syscalls), native signature-verification program ids found in the binary | `keccak256`, `sha256`, `ripemd160`, `ecrecover`, `ECDSA.recover`, EIP-1271, EIP-712, Merkle proofs, precompile calls (modexp, BN254 add / mul / pairing, BLAKE2f, KZG point evaluation, RIP-7212 P-256), with file:line |
| Provenance | the OtterSec build repository, and whether LUSCA's code index holds it (and at which commit) | each verified file compared with the code index: `≡` byte-identical to `owner/repo@commit:path`, `≈` same code once comments / whitespace / pragma are removed |
| SEPIA-1 dataset | verdict before the read (kept index, agents' feed), verdict now under the chain agents' own rules (`evaluateRead`) | same; behind a proxy the implementation is judged (that is the code) |

A read the rules keep (verified, new, not boilerplate, not a token mint) is handed to the chain
store exactly like an agent read, with discovery source `lens`, and appears in the chain feed. Every
other verdict is reported and nothing is stored or counted.

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
- Per IP: fresh reads 5 / min and 40 / h; cached answers 60 / min; detect 12 / min; recent / status 120 / min.
- At most 3 reads at once; 6 more wait up to 20 s, then 503.
- One read per address however many ask at the same moment (in-flight dedupe).
- Cache: 15 min, in memory (100 reports) and on disk (`<data>/lens/cache`, ≤ 600 files, pruned).
- Budget: Lens has its own daily slice of every budget (`<data>/lens/budget.json`, resets 00:00 UTC),
  charged on top of the shared chain budget. Defaults are 15 % of the agents' limits: Solana 1 200
  calls (of 8 000), each EVM chain 2 250 (of 15 000), Sourcify and OtterSec 750 each (of 5 000).
  Lens can therefore never take more than its slice from the chain agents (who pace themselves to
  what is left), and the shared limit, the Helius budget in production, is never exceeded.
- A Solana read costs 1 RPC call + 1 OtterSec request; an EVM read 1–6 RPC calls + 1 Sourcify
  request, twice for a proxy (proxy + implementation).

Env: `LUSCA_LENS=0` (off) · `LUSCA_LENS_SOL_CALLS` · `LUSCA_LENS_EVM_CALLS` · `LUSCA_LENS_HTTP_CALLS`.

## Persistence

`<data>/lens/recent.json` (reads served + recent strip) and `budget.json` are written with
tmp + fsync + rename after every read, so neither goes backwards after a restart or a hard kill.
`<data>/lens/provenance.json` holds the code-index hashes (rebuilt per repository only when its
commit or shards change; the first build after a deploy hashes the whole index in the background,
yielding between records).

## Live check

`LUSCA_DATA=<dir> npx tsx server/lens/_live.ts solana:<id> ethereum:<0x…> …` reads real addresses
over public RPCs into a separate data directory (never point it at a running server's directory).
