// The taste buds. A weighted crypto lexicon (450+ terms/phrases) plus a fast
// longest-match scanner used for page relevance ("taste") and anchor scoring.
//
// Matching model: text is lowercased and split on every non-alphanumeric char,
// so "zk-SNARK", "zk snark" and "ZK–SNARK" all become the token pair [zk, snark].
// Phrases (up to 5 tokens) are matched longest-first so "proof of stake" is not
// also counted as "stake". A trailing plural "s" is folded ("rollups" → "rollup").
// Numbered standards are pattern-matched: "EIP-4844", "eip4844", "ERC 20", "BIP-340".

/**
 * Weight guide: 1.3–1.5 unambiguous technical crypto vocabulary; 0.9–1.2 strong
 * crypto words; 0.5–0.8 crypto-leaning but polysemous; 0.2–0.4 generic words that
 * only count in aggregate (e.g. "gas", "block", "token").
 */
const GROUPS: [number, string][] = [
  // ── core / generic crypto ────────────────────────────────────────────────
  [1.0, 'blockchain, blockchains, cryptocurrency, cryptocurrencies, bitcoin, ethereum, solana, mainnet, testnet, web3, satoshi, hard fork, soft fork, block reward, block height, genesis block, block explorer'],
  [0.9, 'btc, altcoin, altcoins, on-chain, onchain, off-chain, offchain, devnet, permissionless, trustless, crypto asset, crypto assets, digital asset, digital assets, layer 1, full node, archive node, light client, node operator, block time, network fee, transaction fee, transaction fees'],
  [0.7, 'eth, ether, crypto, decentralization, distributed ledger, peer-to-peer network, sats, decentralised'],
  [0.5, 'decentralized, coin, coins'],
  [0.3, 'token, tokens, ledger, fork, forks'],
  [0.2, 'block, blocks, node, nodes, chain, chains, protocol, protocols, transaction, transactions, address, addresses, contract, contracts, client, clients, upgrade, upgrades, explorer, sdk'],
  // ── bitcoin ──────────────────────────────────────────────────────────────
  [1.4, 'lightning network, taproot, segwit, tapscript, p2pkh, p2sh, p2wpkh, p2wsh, p2tr, psbt, miniscript, op_ctv, op_cat, op_return, htlc, htlcs, replace-by-fee, cpfp, package relay, coinjoin, payjoin, silent payments, drivechain, utreexo, assumeutxo, utxo, utxos, bitcoin core, bitcoin script, nakamoto consensus, schnorr signature, musig2, frost signature, ark protocol, bolt12, channel jamming, lightning channel, lightning node'],
  [1.2, 'mempool, halving, hash rate, hashrate, proof of work, proof-of-work, difficulty adjustment, payment channel, payment channels, channel factory, watchtower, ordinals, inscriptions, rbf, fee rate, output descriptor, compact block filters, covenant opcode, covenants, sidechain, sidechains, liquid network, coinbase transaction, block subsidy, mining pool, mining pools, stratum v2'],
  [0.8, 'satoshi nakamoto, nakamoto, splicing, ctv, schnorr, nonce, covenant'],
  [0.6, 'miner, miners, runes'],
  [0.4, 'mining, lightning'],
  // ── ethereum core ────────────────────────────────────────────────────────
  [1.4, 'proto-danksharding, danksharding, data availability sampling, peerdas, verkle, verkle trees, account abstraction, proposer-builder separation, epbs, beacon chain, consensus layer, execution layer, execution client, consensus client, lmd ghost, casper ffg, gasper, sync committee, withdrawal credentials, blob transaction, blob transactions, blobspace, kzg, kzg commitment, single slot finality, inclusion list, inclusion lists, pectra, dencun, shapella, fusaka, glamsterdam, merkle patricia trie, state root, delegatecall, selfdestruct, create2, transient storage, precompile, precompiles, externally owned account, eoa, eoas, user operation, paymaster, entrypoint contract, smart account, smart accounts'],
  [1.2, 'evm, solidity, vyper, smart contract, smart contracts, calldata, opcode, opcodes, bytecode, gwei, base fee, priority fee, gas limit, gas price, gas fee, gas fees, gas cost, slashing, attestation, attestations, attester, validator client, fork choice, statelessness, state expiry, history expiry, geth, reth, nethermind, erigon, besu, prysm, teku, lodestar, rlp, ssz, ethereum name service, beacon node, execution payload, deposit contract, staking pool, solo staking, solo staker, client diversity, upgradeable proxy, proxy contract, storage slot, eip, erc, eips, ercs, electra, deneb, capella, bellatrix'],
  [1.0, 'finality, the merge, ens, yul, staking, stakers, staker'],
  [0.8, 'validator, validators, lighthouse client, nimbus client, ssf'],
  [0.6, 'proposer, blob, blobs, wei, abi, altair'],
  [0.4, 'stake, staked, gas, epoch, epochs'],
  // ── layer 2 / scaling ────────────────────────────────────────────────────
  [1.4, 'rollup, rollups, optimistic rollup, zk-rollup, zkrollup, layer 2, layer-2, sequencer, sequencers, decentralized sequencer, shared sequencer, based rollup, preconfirmation, preconfirmations, fraud proof, fraud proofs, fault proof, fault proofs, validity proof, validity proofs, zkevm, op stack, superchain, data availability, data availability committee, eigenda, eigenlayer, restaking, appchain, appchains, l2beat, canonical bridge, escape hatch, forced inclusion, state channel, state channels, rollup-as-a-service'],
  [1.2, 'arbitrum, zksync, starknet, linea, celestia, plasma chain, l2, l2s, cross-chain, bridge contract, bridged assets, avail da, layer 2s'],
  [0.6, 'l1, layer one'],
  [0.4, 'polygon, optimism, bridge, bridges, interoperability, scaling, scalability'],
  // ── cryptography ─────────────────────────────────────────────────────────
  [1.5, 'zero-knowledge, zero knowledge proof, zk-snark, zk-snarks, zk-stark, zk-starks, snark, snarks, plonk, groth16, halo2, fri protocol, polynomial commitment, polynomial commitments, verifiable delay function, verifiable random function, randao, secp256k1, bls signature, bls signatures, bls12-381, trusted setup, recursive proof, recursive proofs, proof aggregation, zkvm, zkvms, circom, risc zero, multi-party computation, threshold signature, threshold signatures, fully homomorphic encryption, keccak, keccak256, merkle tree, merkle trees, merkle proof, merkle proofs, merkle root'],
  [1.2, 'zk, cryptography, cryptographic, elliptic curve, elliptic curves, ecdsa, eddsa, ed25519, schnorr signatures, hash function, hash functions, sha-256, sha256, poseidon hash, commitment scheme, fhe, homomorphic, vdf, vrf, post-quantum, signature aggregation, private key, private keys, seed phrase, seed phrases, mnemonic phrase, hd wallet, key derivation, prover, provers, proving system, stark proof, merkle, pedersen commitment, stealth address, stealth addresses'],
  [0.9, 'mpc, digital signature, digital signatures'],
  [0.6, 'public key, public keys, verifier, mnemonic, randomness beacon'],
  [0.4, 'encryption, hashing'],
  // ── consensus ────────────────────────────────────────────────────────────
  [1.3, 'proof of stake, proof-of-stake, delegated proof of stake, byzantine fault tolerance, byzantine fault tolerant, tendermint, cometbft, hotstuff, weak subjectivity, selfish mining, double spend, double-spend, double spending, 51% attack, sybil resistance, consensus mechanism, consensus protocol, consensus protocols, longest chain rule, reorg, reorgs, chain reorganization, proof of history, finality gadget'],
  [0.9, 'bft, consensus algorithm, sybil attack, sybil attacks, validator set, staking rewards, slashing condition, slashing conditions'],
  [0.5, 'consensus, liveness'],
  [0.3, 'pos, pow, checkpoint'],
  // ── solana & other chains ────────────────────────────────────────────────
  [1.3, 'sealevel, spl token, spl tokens, firedancer, tower bft, lamports, lamport, program derived address, solana program, solana programs, jito, anchor framework, compute units, agave validator'],
  [1.1, 'cosmos sdk, ibc, polkadot, parachain, parachains, cardano, tezos, monero, zcash, litecoin, dogecoin, avalanche subnet, near protocol, aptos, move language, xrp ledger, stellar network, hedera, algorand, filecoin, arweave, ipfs, chainlink, the graph protocol, subgraph, subgraphs'],
  [0.6, 'xrp, tron'],
  // ── defi ─────────────────────────────────────────────────────────────────
  [1.4, 'defi, decentralized finance, automated market maker, automated market makers, amm, amms, impermanent loss, concentrated liquidity, liquidity pool, liquidity pools, flash loan, flash loans, liquid staking, liquid staking token, liquid restaking, algorithmic stablecoin, total value locked, tvl, overcollateralized, overcollateralization, bonding curve, constant product, dex aggregator, perpetual futures, perpetual swap, funding rate, lending protocol, lending protocols, lending market, borrow rate, utilization rate, health factor, collateral factor, liquidation threshold, stablecoin, stablecoins, depeg, makerdao, uniswap, aave, lido, rocket pool, curve finance, compound finance, yearn, ethena, pendle, gmx, dydx, cow swap, cowswap, 1inch, sushiswap, pancakeswap, morpho, frax, synthetix'],
  [1.1, 'dex, dexes, decentralized exchange, decentralized exchanges, liquidity provider, liquidity providers, liquidity mining, yield farming, yield aggregator, price oracle, price oracles, price feed, price feeds, twap, oracle network, usdc, usdt, dai, gho, wbtc, weth, steth, lst, lsts, lrt, lrts, perps, slippage, arbitrageur, arbitrageurs, collateralized, liquidation, liquidations, real world assets, rwa, rwas, tokenized treasuries, intents, solver network, order flow, peg stability, money market, balancer pool'],
  [0.6, 'liquidity, collateral, arbitrage, perpetuals, swap, swaps, solver, solvers, apy'],
  [0.4, 'oracle, oracles, yield, vault, vaults, peg, lending, borrowing'],
  // ── mev & market structure ───────────────────────────────────────────────
  [1.5, 'mev, maximal extractable value, miner extractable value, mev-boost, mev-share, mev burn, sandwich attack, sandwich attacks, order flow auction, order flow auctions, cross-domain mev, private mempool, encrypted mempool, block builder, block builders, block building, builder api, mev relay, flashbots, suave, searcher, searchers, backrunning, back-running, front-running, frontrunning, censorship resistance, timing games, fee market, blockspace, block space, ultrasound money'],
  [0.8, 'frontrun, relays, ofa'],
  [0.4, 'builders, censorship, inclusion'],
  // ── governance ───────────────────────────────────────────────────────────
  [1.3, 'dao, daos, governance proposal, governance proposals, governance token, governance tokens, temperature check, temp check, snapshot vote, snapshot proposal, onchain vote, on-chain vote, onchain governance, on-chain governance, voting power, delegated voting, timelock, multisig, multisigs, multi-sig, safe multisig, gnosis safe, security council, token holders, tokenholders, tokenholder, tokenomics, vetoken, retroactive public goods funding, retropgf, quadratic funding, quadratic voting, futarchy, arfc, governance forum, delegate platform, grants program, grants council, protocol treasury, dao treasury, airdrop, airdrops, token distribution, token unlock, token unlocks, vesting schedule'],
  [0.9, 'aip, gitcoin, token supply, circulating supply, market cap, governor contract, gauge voting, signaling vote, treasury management'],
  [0.6, 'governance, delegates, delegation, quorum, vesting, public goods, bribes, ratification'],
  [0.4, 'proposal, proposals, vote, voting, delegate, treasury, grant, grants, emissions, ballot'],
  // ── security ─────────────────────────────────────────────────────────────
  [1.5, 'reentrancy, re-entrancy, reentrant, flash loan attack, oracle manipulation, price manipulation, governance attack, rug pull, rugpull, bridge hack, bridge exploit, signature replay, replay attack, infinite approval, token approval, token approvals, drainer, wallet drainer, private key compromise, smart contract audit, smart contract audits, smart contract security, formal verification, invariant testing, echidna, slither, certora, tornado cash, stolen funds, access control vulnerability, integer overflow, read-only reentrancy, storage collision, uninitialized proxy'],
  [1.1, 'exploit, exploits, exploited, exploiter, post-mortem, postmortem, bug bounty, bug bounties, security audit, security audits, audit report, white hat, whitehat, malicious contract, mev bot, mev bots, ofac, sanctioned, money laundering, hardhat'],
  [0.8, 'auditor, auditors, attacker, attackers, vulnerability, vulnerabilities, phishing, hack, hacked, hacks, honeypot, mixer, black hat, scam, scams'],
  [0.5, 'audit, audits, kyc, aml, fuzzing, invariant, foundry, incident response, root cause'],
  [0.2, 'security, incident'],
  // ── wallets / ux ─────────────────────────────────────────────────────────
  [1.3, 'hardware wallet, hardware wallets, cold storage, hot wallet, non-custodial, self-custody, self custody, metamask, trezor, ledger nano, walletconnect, smart wallet, smart wallets, social recovery, sign-in with ethereum, siwe, wallet address, bitcoin address, ethereum address, multisig wallet, mpc wallet, crypto wallet, crypto wallets'],
  [0.8, 'custodial, bundler, signing key'],
  [0.6, 'wallet, wallets, signer, signers, passkey, passkeys, custody'],
  // ── nfts / tokens / markets ──────────────────────────────────────────────
  [1.3, 'nft, nfts, non-fungible token, non-fungible tokens, token standard, fungible token, fungible tokens, token sale, initial coin offering, ico, icos, spot bitcoin etf, bitcoin etf, ether etf, crypto exchange, crypto exchanges, centralized exchange, centralized exchanges, cex, cexs, binance, coinbase, kraken, ftx, crypto market, crypto markets, crypto industry, crypto lending, bitcoin treasury, strategic bitcoin reserve, tokenization, tokenized, cbdc, cbdcs, central bank digital currency, digital currency, digital currencies, crypto regulation, mica'],
  [0.8, 'minting, fungible, deflationary, staking yield, real yield, market maker, market makers'],
  [0.6, 'etf, etfs, issuance, custodian, inflation rate'],
  [0.4, 'mint, mints, minted, burn, burned, burns'],
  // ── dev tooling / infra / standards ──────────────────────────────────────
  [1.2, 'json-rpc, rpc endpoint, rpc node, web3.js, ethers.js, viem, wagmi, foundry forge, remix ide, openzeppelin, chainlink vrf, chainlink ccip, ccip, light node, block header, block headers, transaction pool, transaction receipt, merkle airdrop, improvement proposal, improvement proposals, network upgrade, network upgrades, coprocessor, zk coprocessor, oracle problem'],
  [0.6, 'rpc, ethers, testnets, indexer'],
]

export interface LexEntry {
  label: string // display form, e.g. "zk-rollup"
  weight: number
  /** unambiguous crypto vocabulary (see CORE_LABELS) */
  core: boolean
}

/**
 * Unambiguous crypto vocabulary. A page needs at least 2 distinct core terms for
 * its weighted hit rate to count in full: generic or polysemous words
 * (tokenization, covenant, halving, finality, staking, exploit, cryptography,
 * hash function, private key, dao, airdrop, mica, kraken, ico, ens, mining,
 * bridge, block ...) never carry an off-topic page on their own. Numbered
 * standards (EIP-/ERC-/BIP-/SIMD-n) are core as well.
 */
const CORE_LABELS = [
  // chains, assets, core concepts
  'blockchain', 'bitcoin', 'ethereum', 'cryptocurrency', 'solana', 'web3', 'mainnet', 'testnet', 'satoshi', 'btc', 'altcoin',
  'on-chain', 'onchain', 'off-chain', 'offchain', 'genesis block', 'block explorer', 'crypto asset', 'crypto wallet',
  'polkadot', 'parachain', 'cardano', 'tezos', 'monero', 'zcash', 'litecoin', 'dogecoin', 'near protocol', 'chainlink', 'filecoin', 'arweave', 'ipfs', 'cosmos sdk',
  // bitcoin
  'utxo', 'mempool', 'lightning network', 'taproot', 'segwit', 'tapscript', 'p2pkh', 'p2sh', 'p2wpkh', 'p2wsh', 'p2tr', 'psbt', 'miniscript',
  'op_ctv', 'op_cat', 'op_return', 'htlc', 'coinjoin', 'payjoin', 'silent payments', 'bitcoin core', 'bitcoin script', 'nakamoto consensus', 'musig2', 'bolt12', 'mining pool',
  // ethereum
  'smart contract', 'evm', 'solidity', 'vyper', 'calldata', 'gwei', 'validator client', 'beacon chain', 'beacon node', 'consensus layer', 'execution layer',
  'execution client', 'consensus client', 'proto-danksharding', 'danksharding', 'peerdas', 'account abstraction', 'proposer-builder separation', 'epbs', 'casper ffg', 'gasper',
  'blob transaction', 'blobspace', 'kzg commitment', 'pectra', 'dencun', 'shapella', 'fusaka', 'glamsterdam', 'delegatecall', 'selfdestruct', 'create2', 'eoa', 'paymaster',
  'geth', 'reth', 'nethermind', 'erigon', 'besu', 'prysm', 'teku', 'lodestar', 'deposit contract', 'solo staking', 'ethereum name service', 'eip', 'erc',
  // layer 2
  'rollup', 'optimistic rollup', 'zk-rollup', 'zkrollup', 'layer 2', 'layer-2', 'zkevm', 'op stack', 'superchain', 'eigenlayer', 'eigenda', 'restaking', 'l2beat', 'arbitrum', 'zksync', 'starknet', 'celestia',
  // cryptography / consensus with no life outside crypto
  'zk-snark', 'snark', 'zk-stark', 'plonk', 'groth16', 'halo2', 'secp256k1', 'bls12-381', 'zkvm', 'circom', 'risc zero',
  'proof of stake', 'proof-of-stake', 'delegated proof of stake', 'proof of work', 'proof-of-work', 'tendermint', 'cometbft', 'double spend', 'double-spend', '51% attack', 'proof of history',
  // solana
  'sealevel', 'spl token', 'firedancer', 'lamport', 'program derived address', 'jito', 'agave validator',
  // defi / mev / markets
  'defi', 'decentralized finance', 'stablecoin', 'automated market maker', 'impermanent loss', 'concentrated liquidity', 'liquidity pool', 'flash loan', 'liquid staking',
  'total value locked', 'tvl', 'dex', 'decentralized exchange', 'usdc', 'usdt', 'wbtc', 'weth', 'steth', 'yield farming', 'depeg',
  'makerdao', 'uniswap', 'aave', 'lido', 'rocket pool', 'curve finance', 'compound finance', 'ethena', 'pendle', 'dydx', 'cowswap', 'cow swap', 'sushiswap', 'pancakeswap', 'synthetix',
  'mev', 'maximal extractable value', 'mev-boost', 'flashbots', 'sandwich attack', 'ultrasound money',
  'nft', 'non-fungible token', 'initial coin offering', 'bitcoin etf', 'spot bitcoin etf', 'ether etf', 'crypto exchange', 'binance', 'coinbase', 'ftx',
  'crypto market', 'crypto industry', 'crypto lending', 'crypto regulation', 'cbdc', 'central bank digital currency',
  // wallets / tooling / governance
  'metamask', 'trezor', 'ledger nano', 'walletconnect', 'sign-in with ethereum', 'siwe', 'bitcoin address', 'ethereum address', 'web3.js', 'ethers.js', 'openzeppelin',
  'tornado cash', 'rug pull', 'wallet drainer', 'flash loan attack', 'on-chain governance', 'onchain governance', 'gnosis safe', 'tokenomics',
]
const CORE_STANDARDS = new Set(['eip', 'erc', 'bip', 'simd'])

export interface TasteResult {
  score: number
  words: number
  /** distinct lexicon terms matched */
  distinct: number
  /** distinct core (unambiguous) terms matched */
  core: number
  weightedHits: number
  hitsPer1000: number
  /** top terms by weighted contribution, display labels */
  terms: string[]
  /** [label, count] for the top terms (for traces) */
  top: [string, number][]
}

function normPhrase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

const LEX = new Map<string, LexEntry>()
/** first token → max phrase length starting with it (to skip impossible n-gram probes) */
const MAX_LEN_BY_FIRST = new Map<string, number>()

for (const [w, list] of GROUPS) {
  for (const raw of list.split(',')) {
    const label = raw.trim()
    if (!label) continue
    const key = normPhrase(label)
    if (!key) continue
    const prev = LEX.get(key)
    // Keep the highest weight if a term appears in two groups.
    if (!prev || prev.weight < w) LEX.set(key, { label, weight: w, core: false })
    const toks = key.split(' ')
    const first = toks[0]
    MAX_LEN_BY_FIRST.set(first, Math.max(MAX_LEN_BY_FIRST.get(first) ?? 1, toks.length))
  }
}

// Plural entries display (and aggregate) under their singular label:
// "rollups" → "rollup", "vulnerabilities" → "vulnerability".
for (const [key, e] of LEX) {
  const singular = key.endsWith('ies') ? key.slice(0, -3) + 'y' : key.endsWith('s') && !key.endsWith('ss') ? key.slice(0, -1) : null
  const s = singular ? LEX.get(singular) : undefined
  if (s && s !== e) e.label = s.label
}

const CORE_KEYS = new Set(CORE_LABELS.map(normPhrase))
for (const e of LEX.values()) e.core = CORE_KEYS.has(normPhrase(e.label))

/** Core labels missing from the lexicon (should be empty; checked by server/ingest/_taste.ts). */
export const CORE_MISSING = [...CORE_KEYS].filter((k) => !LEX.has(k))

export const LEXICON_SIZE = LEX.size
/** Weight below which a term counts as generic (its total is capped at the strong total). */
const GENERIC_WEIGHT = 0.7
/** Distinct core terms needed for the hit rate to count in full. */
const CORE_FOR_FULL = 2

/** Numbered standards: EIP-4844 / ERC-20 / BIP-340 / SIMD-0096 / ELIP / RIP / NIP excluded (too ambiguous). */
const STD_WEIGHT: Record<string, number> = { eip: 1.3, erc: 1.2, bip: 1.2, simd: 1.2, rip: 0.8, cip: 0.6, aip: 0.9, sip: 0.5 }
const STD_FUSED = /^(eip|erc|bip|simd)(\d{1,5})$/

const TOKEN_RE = /[a-z0-9]+/g

export function tokenize(text: string, max = 40_000): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(lower)) !== null) {
    out.push(m[0])
    if (out.length >= max) break
  }
  return out
}

function lookup(key: string): LexEntry | undefined {
  const e = LEX.get(key)
  if (e) return e
  // plural fold on the last token: "rollups" → "rollup", "smart contracts" → "smart contract"
  if (key.length > 3 && key.endsWith('s') && !key.endsWith('ss')) return LEX.get(key.slice(0, -1))
  return undefined
}

/**
 * Longest-match scan. Calls `hit(label, weight, core)` once per matched occurrence.
 */
function scan(tokens: string[], hit: (label: string, weight: number, core: boolean) => void): void {
  const n = tokens.length
  let i = 0
  while (i < n) {
    const t = tokens[i]
    // Numbered standards first: "eip 4844", "eip4844", "erc 20".
    const sw = STD_WEIGHT[t]
    if (sw !== undefined && i + 1 < n && /^\d{1,5}$/.test(tokens[i + 1])) {
      hit(`${t}-${tokens[i + 1]}`, sw, CORE_STANDARDS.has(t))
      i += 2
      continue
    }
    const fused = STD_FUSED.exec(t)
    if (fused) {
      hit(`${fused[1]}-${fused[2]}`, STD_WEIGHT[fused[1]] ?? 1, CORE_STANDARDS.has(fused[1]))
      i += 1
      continue
    }
    const maxLen = Math.min(MAX_LEN_BY_FIRST.get(t) ?? (t.endsWith('s') ? (MAX_LEN_BY_FIRST.get(t.slice(0, -1)) ?? 0) : 0), n - i)
    let matched = 0
    for (let len = maxLen; len >= 1; len--) {
      const key = len === 1 ? t : tokens.slice(i, i + len).join(' ')
      const e = lookup(key)
      if (e) {
        hit(e.label, e.weight, e.core)
        matched = len
        break
      }
    }
    i += matched > 0 ? matched : 1
  }
}

/**
 * Relevance score per spec:
 *   score = 0.75 * (1 - exp(-weightedHitsPer1000Words / 9)) + 0.25 * hostPrior   (clamped 0..1)
 * Each term's count is capped at max(4, words/250) so one polysemous word
 * ("mining", "bridge") cannot carry an off-topic page on its own; generic terms
 * (weight < 0.7) add at most as much as the strong terms do; and the hit rate is
 * damped by the number of distinct CORE terms (full weight from 2), so a page
 * without unambiguous crypto vocabulary falls back to the host-prior floor.
 */
export function taste(text: string, hostPrior: number): TasteResult {
  const tokens = tokenize(text)
  const words = tokens.length
  const counts = new Map<string, { n: number; w: number; core: boolean }>()
  scan(tokens, (label, weight, core) => {
    const c = counts.get(label)
    if (c) c.n++
    else counts.set(label, { n: 1, w: weight, core })
  })
  const cap = Math.max(4, words / 250)
  let strong = 0
  let generic = 0
  let core = 0
  const contrib: [string, number, number][] = []
  for (const [label, { n, w, core: isCore }] of counts) {
    const c = w * Math.min(n, cap)
    if (w >= GENERIC_WEIGHT) strong += c
    else generic += c
    if (isCore) core++
    contrib.push([label, n, c])
  }
  const weighted = strong + Math.min(generic, strong)
  contrib.sort((a, b) => b[2] - a[2] || b[1] - a[1])
  const per1000 = words > 0 ? (weighted / words) * 1000 : 0
  // Very short texts get a damped rate so 3 words of "bitcoin wallet" don't score 1.0,
  // and pages with fewer than 2 distinct core terms are damped (to zero without
  // any) so tokenizer docs, CVE write-ups or council minutes cannot pass.
  const lengthDamp = words >= 150 ? 1 : words / 150
  const diversityDamp = Math.min(1, core / CORE_FOR_FULL)
  const s = 0.75 * (1 - Math.exp(-(per1000 * lengthDamp * diversityDamp) / 9)) + 0.25 * hostPrior
  const score = Math.max(0, Math.min(1, s))
  return {
    score,
    words,
    distinct: counts.size,
    core,
    weightedHits: weighted,
    hitsPer1000: per1000,
    terms: contrib.slice(0, 6).map((c) => c[0]),
    top: contrib.slice(0, 6).map((c) => [c[0], c[1]] as [string, number]),
  }
}

/**
 * Lexicon hits in a short string (anchor text or URL path words).
 * Returns the summed weight and the best-matching label.
 */
export function phraseHits(text: string): { weight: number; best: string | null } {
  const tokens = tokenize(text, 64)
  let weight = 0
  let best: string | null = null
  let bestW = 0
  const seen = new Set<string>()
  scan(tokens, (label, w) => {
    if (seen.has(label)) return // count each term once in an anchor
    seen.add(label)
    weight += w
    if (w > bestW) {
      bestW = w
      best = label
    }
  })
  return { weight, best }
}
