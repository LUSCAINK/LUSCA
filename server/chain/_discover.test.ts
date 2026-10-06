// Chain discovery tests: block parsing (legacy / v0 / v1, inner instructions, real mainnet fixture),
// EVM blocks, web-corpus extraction on tricky text, corpus tail + rotation, frontier ordering / dedupe /
// TTL / persistence, and the discovery loop against a stub RPC. No network.
//   npx tsx server/chain/_discover.test.ts
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base58Decode, base58Encode, isSolanaAddress } from '../../shared/base58.ts'
import type { ChainId } from '../../shared/chain.ts'
import { RpcError, BudgetError, type RpcCtx } from './rpc.ts'
import { checksumStatus, createAddress, keccak256, keccakSponge256, toChecksumAddress, toHex } from './discover/keccak.ts'
import { SOLANA_NATIVE, isSolanaNative, parseSolanaBlock, requiredTxVersion } from './discover/solblock.ts'
import { parseEvmBlock } from './discover/evmblock.ts'
import { emptyExtractCounters, extractMentions, plausibleSolana, type WebMention } from './discover/extract.ts'
import { CorpusTail } from './discover/corpus.ts'
import { ChainFrontier, normalizeAddress } from './discover/frontier.ts'
import { parseOsecPage, parseSourcifyList, sourcifyScores } from './discover/registry.ts'
import { CREATION_DELAY_MS, createDiscovery, type DiscoveryConfig } from './discover.ts'
import { createHash } from 'node:crypto'

let passed = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (e) {
    console.error(`FAIL ${name}\n${(e as Error).stack}`)
    process.exitCode = 1
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'lusca-discover-'))
let dirN = 0
const freshDir = () => {
  const d = join(tmp, `d${dirN++}`)
  mkdirSync(d, { recursive: true })
  return d
}

const fixture = JSON.parse(readFileSync(new URL('./_discover.fixtures.json', import.meta.url), 'utf8')) as {
  slot: number
  blockTime: number
  transactions: unknown[]
}

// Real mainnet program ids used as test data.
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
const PHOENIX = 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY'
const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
const DRIFT = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH'
const SYSTEM = '11111111111111111111111111111111'
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const UNI_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984'
const WETH9 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

/** A canonical 32-byte address ending in 'pump' (the pump.fun mint vanity suffix), built deterministically. */
const PUMP_MINT = (() => {
  for (let i = 1; i < 255; i++) {
    const b58 = base58Encode(Uint8Array.from({ length: 32 }, (_, j) => (j * 37 + i * 11) & 0xff))
    const cand = b58.slice(0, -4) + 'pump'
    const back = base58Decode(cand)
    if (back && back.length === 32 && isSolanaAddress(cand) && /[0-9]/.test(cand)) return cand
  }
  throw new Error('no pump-suffixed address')
})()

/** Neutral text between test cases (separate page sections, so no context bleeds across). */
const FILLER = `\n\n${'Lorem ipsum dolor sit amet. '.repeat(10)}\n\n`

const mentionOf = (ms: WebMention[], chain: ChainId, addr: string) => ms.find((m) => m.chain === chain && m.address.toLowerCase() === addr.toLowerCase())

// ─── keccak / EVM address helpers ────────────────────────────────────────────

await test('keccak256 vectors, SHA3 parity across block boundaries, EIP-55, CREATE address', () => {
  assert.equal(toHex(keccak256('')), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
  assert.equal(toHex(keccak256('abc')), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45')
  for (const n of [0, 1, 135, 136, 137, 272, 1000]) {
    const b = Buffer.alloc(n, n & 0xff)
    assert.equal(toHex(keccakSponge256(b, 0x06)), createHash('sha3-256').update(b).digest('hex'), `sha3 parity at ${n} bytes`)
  }
  for (const a of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']) {
    assert.equal(toChecksumAddress(a.toLowerCase()), a)
    assert.equal(checksumStatus(a), 'valid')
  }
  assert.equal(checksumStatus('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), 'none')
  assert.equal(checksumStatus('0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), 'invalid')
  assert.equal(createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 0), '0xcd234A471b72ba2F1Ccf0A70FCABA648a5eeCD8d')
  assert.equal(createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 1), '0x343c43A37D37dfF08AE8C4A11544c718AbB4fCF8')
  // multi-byte nonce (0x80 needs a length prefix) stays a valid 20-byte address
  assert.match(createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 0x1234), /^0x[0-9a-fA-F]{40}$/)
})

// ─── Solana blocks ───────────────────────────────────────────────────────────

await test('native / SPL core program ids are canonical 32-byte addresses', () => {
  for (const id of SOLANA_NATIVE.keys()) assert.ok(isSolanaAddress(id), `${id} (${SOLANA_NATIVE.get(id)})`)
  assert.ok(isSolanaNative('SysvarRent111111111111111111111111111111111'))
  assert.ok(!isSolanaNative(JUP))
})

await test('real mainnet block fixture: legacy + v0 (lookup tables) + v1, inner instructions', () => {
  const act = parseSolanaBlock({ blockTime: fixture.blockTime, transactions: fixture.transactions }, fixture.slot)
  assert.equal(act.txs, 4)
  assert.equal(act.txsWithLoaded, 1)
  assert.equal(act.unresolved, 0)
  const progs = [...act.programs.keys()].sort()
  assert.deepEqual(
    progs,
    [
      '3TK9D8aoBFYjYZtKCjciPrVrRStsnvo7KmpcJqDavpaU',
      'DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH',
      JUP,
      'JTXJTXfr1wVRMEzqiPhXUr69zJtfGuLh5qEiXG772Zj',
      'MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms',
      PUMP_AMM,
      'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
    ].sort(),
  )
  // pAMMBay / pfee are invoked through indices 21 / 22: readonly lookup-table addresses (10 static keys + 7 writable)
  assert.equal(act.programs.get(PUMP_AMM)?.txs, 1)
  // one tx counts once per program however many instructions
  assert.deepEqual(act.programs.get('JTXJTXfr1wVRMEzqiPhXUr69zJtfGuLh5qEiXG772Zj'), { txs: 1, ix: 4 })
  assert.equal(act.natives.get(TOKEN)?.txs, 3)
  assert.equal(act.natives.get(SYSTEM)?.txs, 3)
  assert.equal(act.natives.get('ComputeBudget111111111111111111111111111111')?.txs, 2)
  assert.equal(act.natives.get('Vote111111111111111111111111111111111111111')?.txs, 1)
})

await test('synthetic v0: writable-then-readonly index space, inner CPI, bad index, jsonParsed, junk', () => {
  const A = 'Fee1111111111111111111111111111111111111111'
  const block = {
    blockTime: 1,
    transactions: [
      {
        version: 0,
        transaction: {
          message: {
            accountKeys: [A, SYSTEM],
            instructions: [{ programIdIndex: 3, accounts: [0, 2], data: '' }, { programIdIndex: 9, accounts: [], data: '' }],
          },
        },
        meta: {
          loadedAddresses: { writable: [WHIRLPOOL], readonly: [PHOENIX] },
          innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 2 }, { programIdIndex: 1 }, { programIdIndex: 3 }] }],
        },
      },
      {
        // jsonParsed: accountKeys objects (lookup addresses inline), programId given directly
        version: 0,
        transaction: { message: { accountKeys: [{ pubkey: A, signer: true }, { pubkey: DRIFT, source: 'lookupTable' }], instructions: [{ programId: DRIFT, parsed: null }] } },
        meta: { loadedAddresses: { writable: [DRIFT], readonly: [] }, innerInstructions: [{ index: 0, instructions: [{ programId: PHOENIX }] }] },
      },
      { version: 'legacy', transaction: { message: { accountKeys: [A], instructions: [{ programIdIndex: 0 }] } }, meta: null },
      'junk',
      { transaction: {} },
    ],
  }
  const act = parseSolanaBlock(block)
  assert.equal(act.txs, 3)
  assert.deepEqual(act.programs.get(PHOENIX), { txs: 2, ix: 3 }) // index 3 twice in tx 1 + jsonParsed inner
  assert.deepEqual(act.programs.get(WHIRLPOOL), { txs: 1, ix: 1 })
  assert.deepEqual(act.programs.get(DRIFT), { txs: 1, ix: 1 })
  assert.equal(act.natives.get(SYSTEM)?.txs, 1)
  assert.equal(act.unresolved, 1) // index 9 out of range
  assert.ok(!act.programs.has(A) || act.programs.get(A)!.txs === 1) // the legacy tx invokes A (a non-native id)
})

await test('required transaction version is read from the -32015 error text', () => {
  const msg = 'solana discovery rpc getBlock: Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1 (-32015)'
  assert.equal(requiredTxVersion(msg), 1)
  assert.equal(requiredTxVersion('Transaction version (2) is not supported'), 2)
  assert.equal(requiredTxVersion('slot skipped'), null)
})

// ─── EVM blocks ──────────────────────────────────────────────────────────────

await test('EVM block: calls with calldata, token-selector share, creations, system addresses, plain transfers', () => {
  const router = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad'
  const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const deployer = '0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0'
  const block = {
    number: '0x1500000',
    timestamp: '0x66000000',
    transactions: [
      { to: router, from: deployer, input: '0x3593564c0000', nonce: '0x5' },
      { to: router.toUpperCase().replace('0X', '0x'), from: deployer, input: '0x3593564c0001', nonce: '0x6' },
      { to: usdc, from: deployer, input: '0xa9059cbb' + '00'.repeat(64), nonce: '0x7' },
      { to: usdc, from: deployer, input: '0x095ea7b3' + '00'.repeat(64), nonce: '0x8' },
      { to: '0x' + '22'.repeat(20), from: deployer, input: '0x', nonce: '0x9' }, // plain transfer
      { to: null, from: deployer, input: '0x6080604052', nonce: '0x1' }, // creation
      { to: '0x00000000000000000000000000000000000a4b05', from: deployer, input: '0x6bf6a42d', nonce: '0x0' }, // ArbOS
      '0xabc', // hash only
    ],
  }
  const act = parseEvmBlock(block)
  assert.equal(act.number, 0x1500000)
  assert.equal(act.txs, 7)
  assert.deepEqual(act.calls.get(router), { txs: 2, token: 0 })
  assert.deepEqual(act.calls.get(usdc), { txs: 2, token: 2 })
  assert.equal(act.plain, 1)
  assert.equal(act.skippedSystem, 1)
  assert.deepEqual(act.creations, ['0x343c43A37D37dfF08AE8C4A11544c718AbB4fCF8'])
  assert.equal(parseEvmBlock({ transactions: ['0x1', '0x2'] }).calls.size, 0)
})

// ─── web corpus extraction ───────────────────────────────────────────────────

await test('extract: Solana program ids by label, declare_id, explorer links; mints / wallets / devnet dropped', () => {
  const c = emptyExtractCounters()
  const text = [
    `Program Type: Burnmint Token Pool\nProgram ID: ${PHOENIX}\nState Account: ${WHIRLPOOL.replace('whir', 'Whir')}`,
    `The address of the feed on both Devnet and Mainnet is ${DRIFT}. This is the program ID that you use to read prices onchain.`,
    `RPC URL: https://api.devnet.solana.com\nProgram ID: 8eqh8wppT9c5rw4ERqNCffvU6cNFJWff9WmkcYtmGiqC`,
    `Mint: ${PUMP_MINT} and CA: 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin`,
    `The Token Program has the program ID ${TOKEN}, and provides the basic capabilities.`,
    `wallets of the attacker: https://solscan.io/account/Htp9MGP8Tig923ZFY7Qf2zzbMUmYneFRAhSp7vSg4wxV#solTransfers`,
    `token page https://solscan.io/token/6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN`,
    `see the IDL https://solscan.io/account/${JUP}#anchorProgramIdl and https://explorer.solana.com/address/${WHIRLPOOL}?cluster=devnet`,
    'declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"); // Anchor template id',
    `use anchor_lang::prelude::*;\ndeclare_id!("${PUMP_AMM}");`,
    // a signature (88 chars), an over-long run, and a CamelCase identifier: never addresses
    'Signature: 5osMiNMiDZGM7L1e2tPHxU8wdB8gwGqYbHZZAzmKbBLqHyVmMxUhGsjAHPMEWnTKV8gsM2tpgRVbW5fQ9CfMDTnBb program',
    'program TransferCheckedWithFeeInstructionDataXYZabc in the protocol',
  ].join(FILLER)
  const ms = extractMentions({ text, url: 'https://docs.example.org/x', host: 'docs.example.org' }, c)
  assert.ok(mentionOf(ms, 'solana', PHOENIX), 'Program ID label')
  assert.equal(mentionOf(ms, 'solana', PHOENIX)!.kind, 'context')
  assert.ok(!mentionOf(ms, 'solana', WHIRLPOOL.replace('whir', 'Whir')), 'state account is not a program')
  assert.ok(mentionOf(ms, 'solana', DRIFT), 'devnet + mainnet named: kept')
  assert.ok(!ms.some((m) => m.address === '8eqh8wppT9c5rw4ERqNCffvU6cNFJWff9WmkcYtmGiqC'), 'devnet-only program dropped')
  assert.ok(!ms.some((m) => m.address.endsWith('pump')), 'pump.fun mint dropped')
  assert.ok(!ms.some((m) => m.address === '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'), 'CA: label is a token')
  assert.ok(!mentionOf(ms, 'solana', TOKEN), 'SPL Token is native')
  assert.ok(!ms.some((m) => m.address === 'Htp9MGP8Tig923ZFY7Qf2zzbMUmYneFRAhSp7vSg4wxV'), 'wallet tab dropped')
  assert.ok(!ms.some((m) => m.address === '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN'), 'token page dropped')
  const jup = mentionOf(ms, 'solana', JUP)!
  assert.equal(jup.kind, 'explorer')
  assert.ok(jup.score >= 4, 'IDL tab = program')
  assert.ok(!mentionOf(ms, 'solana', WHIRLPOOL), '?cluster=devnet dropped')
  assert.ok(!ms.some((m) => m.address === 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'), 'Anchor template id dropped')
  assert.equal(mentionOf(ms, 'solana', PUMP_AMM)?.kind, 'declare_id')
  assert.ok(c.offMainnet >= 2 && c.wallet === 1 && c.tokenUrl === 1 && c.native >= 1 && c.mintLike >= 1 && c.placeholder >= 1, JSON.stringify(c))
  assert.ok(ms.every((m) => m.hint.endsWith('docs.example.org')))
  assert.ok(!plausibleSolana('TransferCheckedWithFeeInstructionDataXYZabc'))
})

await test('extract: EVM explorer links per chain, testnets / Nova / bad checksums / placeholders dropped', () => {
  const c = emptyExtractCounters()
  const lower = UNI_V3_FACTORY.toLowerCase()
  const text = [
    `Factory: https://etherscan.io/address/${UNI_V3_FACTORY}#code`,
    `ArbOS 20 (Arb One): https://arbiscan.io/address/0x3e313eeed58e851ca3841c6109697b9eb35c7726`,
    `(Nova): https://nova.arbiscan.io/address/0x13f7f24ca959359a4d710d32c715d4bce273c793`,
    `Token Pool: https://sepolia.arbiscan.io/address/0x7D2f4A6c8E1b3D5a9F0c2E4b6A8d1C3e5F7a9B2d`,
    `token: https://basescan.org/token/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`,
    `Explorer: https://base.blockscout.com/address/0x4200000000000000000000000000000000000016`,
    `Token Address: 0x5B3c8F2a9D4e7A1c6F0b3E8d5C9a2F4b7D1e6A3c (made up: bad checksum)`,
    `burn address 0x000000000000000000000000000000000000dEaD and native sentinel 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE contract`,
    `tx hash 0x${'ab'.repeat(32)} contract`,
  ].join(FILLER)
  const ms = extractMentions({ text }, c)
  const f = mentionOf(ms, 'ethereum', lower)!
  assert.ok(f, 'etherscan link')
  assert.equal(f.address, UNI_V3_FACTORY, 'checksummed')
  assert.ok(f.score >= 4, '#code tab')
  assert.ok(mentionOf(ms, 'arbitrum', '0x3e313eeed58e851ca3841c6109697b9eb35c7726'))
  assert.ok(!ms.some((m) => m.address.toLowerCase() === '0x13f7f24ca959359a4d710d32c715d4bce273c793'), 'Nova dropped')
  assert.ok(!ms.some((m) => m.address.toLowerCase() === '0x7d2f4a6c8e1b3d5a9f0c2e4b6a8d1c3e5f7a9b2d'), 'Sepolia dropped')
  const usdc = mentionOf(ms, 'base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')!
  assert.ok(usdc && usdc.score < f.score, 'token page kept on base, lower score')
  assert.ok(mentionOf(ms, 'base', '0x4200000000000000000000000000000000000016'), 'base blockscout')
  assert.ok(!ms.some((m) => m.address.toLowerCase() === '0x5b3c8f2a9d4e7a1c6f0b3e8d5c9a2f4b7d1e6a3c'), 'bad checksum dropped')
  assert.ok(!ms.some((m) => /dead$/i.test(m.address) || /^0xe{40}$/i.test(m.address)), 'placeholders dropped')
  assert.ok(!ms.some((m) => m.address.length !== 42 && m.chain !== 'solana'))
  assert.ok(c.checksum >= 1 && c.placeholder >= 2 && c.offMainnet >= 1, JSON.stringify(c))
})

await test('extract: long whitespace-free dotted runs scan in linear time (no regex backtracking)', () => {
  // 300 000 chars of 'a.a.a…' took 78 s with the unbounded subdomain group; a link after it still parses
  const t0 = Date.now()
  const runs = ['a.'.repeat(150_000), Array.from({ length: 40_000 }, (_, i) => `v${i}`).join('.')]
  for (const run of runs) extractMentions({ text: `${run} see https://etherscan.io/address/${UNI_V3_FACTORY}#code` })
  const ms = extractMentions({ text: `${'x.'.repeat(1000)}sepolia.etherscan.io/address/${UNI_V3_FACTORY} https://www.etherscan.io/address/${UNI_V3_FACTORY}` })
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`)
  assert.ok(mentionOf(ms, 'ethereum', UNI_V3_FACTORY.toLowerCase()), 'www. link still read')
})

await test('extract: bare 0x addresses need contract context; chain from nearby names or the page', () => {
  const ms = extractMentions({
    text: [
      `The SwapRouter contract on Arbitrum is deployed at ${UNI_V3_FACTORY.toLowerCase()}.`,
      `Wrapped Ether: the WETH9 contract address ${WETH9}`,
      `Send donations to my wallet ${'0x' + 'd8da6bf26964af9d7eed9e03e53415d37aa96045'}`,
      `deployer: 0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2 paid the gas`,
    ].join(FILLER),
    url: 'https://blog.example.com/post',
  })
  // one address per chain in a list: each goes to the chain named next to it, not to all three
  const list = extractMentions({
    text: `Deployments of the router contract:\nEthereum: ${UNI_V3_FACTORY}\nArbitrum: ${WETH9}\nBase: 0x2626664c2603336E57B271c5C0b26F421741e481`,
  })
  assert.deepEqual(
    list.map((m) => `${m.chain}:${m.address.slice(0, 6)}`).sort(),
    ['arbitrum:0xC02a', 'base:0x2626', 'ethereum:0x1F98'],
  )
  const arb = mentionOf(ms, 'arbitrum', UNI_V3_FACTORY)
  assert.ok(arb, 'Arbitrum named nearby')
  assert.ok(!mentionOf(ms, 'base', UNI_V3_FACTORY))
  assert.ok(mentionOf(ms, 'ethereum', WETH9), 'no chain named: Ethereum')
  assert.ok(!ms.some((m) => m.address.toLowerCase() === '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'), 'wallet dropped')
  assert.ok(!ms.some((m) => m.address.toLowerCase() === '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2'), 'deployer dropped')
  // page context decides the chain for a bare mention
  const onBase = extractMentions({ text: `Pool manager contract: ${WETH9}`, host: 'docs.base.org', title: 'Contracts on Base' })
  assert.ok(mentionOf(onBase, 'base', WETH9))
  // the page URL itself is an explorer page
  const page = extractMentions({ text: 'Contract source code verified', url: `https://basescan.org/address/${WETH9}#code` })
  assert.equal(mentionOf(page, 'base', WETH9)?.kind, 'page')
})

// ─── corpus tail ─────────────────────────────────────────────────────────────

const line = (i: number, extra = '') => JSON.stringify({ id: `p${i}`, url: `https://x.test/${i}`, host: 'x.test', title: `t${i}`, text: `page ${i} ${extra}`, tokens: 1 }) + '\n'

await test('corpus tail: chunks, torn last line, restore from saved state', async () => {
  const dir = freshDir()
  const f = join(dir, 'dataset.jsonl')
  writeFileSync(f, line(0) + line(1) + line(2).slice(0, 20)) // torn third line
  const seen: string[] = []
  const t = new CorpusTail(dir, null, { chunkBytes: 4096 })
  let r = await t.step((l) => seen.push(JSON.parse(l).id))
  assert.deepEqual(seen, ['p0', 'p1'])
  assert.ok(r.caughtUp)
  r = await t.step((l) => seen.push(JSON.parse(l).id))
  assert.equal(r.lines, 0, 'torn line waits')
  appendFileSync(f, line(2).slice(20) + line(3))
  await t.step((l) => seen.push(JSON.parse(l).id))
  assert.deepEqual(seen, ['p0', 'p1', 'p2', 'p3'])
  // restart from the saved state: nothing is read twice
  const t2 = new CorpusTail(dir, t.state(), { chunkBytes: 4096 })
  appendFileSync(f, line(4))
  const again: string[] = []
  await t2.step((l) => again.push(JSON.parse(l).id))
  assert.deepEqual(again, ['p4'])
  assert.equal(t2.state().lines, 5)
})

await test('corpus tail: rotation finishes the archive, then the new file; truncation restarts', async () => {
  const dir = freshDir()
  const f = join(dir, 'dataset.jsonl')
  let body = ''
  for (let i = 0; i < 40; i++) body += line(i, 'x'.repeat(200))
  writeFileSync(f, body)
  const seen: string[] = []
  const on = (l: string) => seen.push(JSON.parse(l).id)
  const t = new CorpusTail(dir, null, { chunkBytes: 4096 })
  await t.step(on) // reads part of the file only (chunk < file)
  const readBefore = seen.length
  assert.ok(readBefore > 0 && readBefore < 40)
  // writer appends more, then rotates (rename) and starts a fresh file
  appendFileSync(f, line(40))
  renameSync(f, join(dir, 'dataset-20261005T000000000Z.jsonl'))
  writeFileSync(f, line(100) + line(101))
  let rotated = false
  for (let i = 0; i < 40; i++) {
    const r = await t.step(on)
    rotated ||= r.rotated
    if (r.caughtUp && !t.state().drain) break
  }
  assert.ok(rotated)
  const want = [...Array.from({ length: 41 }, (_, i) => `p${i}`), 'p100', 'p101']
  assert.deepEqual(seen, want, 'every line exactly once, archive first')
  // truncation / replacement by a shorter file
  writeFileSync(f, line(200))
  for (let i = 0; i < 3; i++) await t.step(on)
  assert.equal(seen.at(-1), 'p200')
  assert.equal(seen.filter((s) => s === 'p200').length, 1)
})

await test('corpus tail: over-long line skipped, backlog starts on a line boundary, throwing handler never stalls', async () => {
  const dir = freshDir()
  const f = join(dir, 'dataset.jsonl')
  writeFileSync(f, line(0) + JSON.stringify({ text: 'y'.repeat(20000) }) + '\n' + line(1))
  const seen: string[] = []
  const t = new CorpusTail(dir, null, { chunkBytes: 4096, maxLineBytes: 8192 })
  for (let i = 0; i < 10; i++) {
    const r = await t.step((l) => seen.push(JSON.parse(l).id ?? 'long'))
    if (r.caughtUp) break
  }
  assert.deepEqual(seen, ['p0', 'p1'])
  assert.equal(t.state().skipped, 1)
  // backlog: start ~1 line before the end, never mid-line
  const dir2 = freshDir()
  let body = ''
  for (let i = 0; i < 20; i++) body += line(i)
  writeFileSync(join(dir2, 'dataset.jsonl'), body)
  const tb = new CorpusTail(dir2, null, { backlogBytes: line(19).length + 5 })
  const got: string[] = []
  await tb.step((l) => got.push(JSON.parse(l).id))
  assert.deepEqual(got, ['p19'])
  // a handler that throws: the offset still moves on
  const dir3 = freshDir()
  writeFileSync(join(dir3, 'dataset.jsonl'), line(0) + line(1))
  const tt = new CorpusTail(dir3, null)
  await tt.step(() => {
    throw new Error('boom')
  })
  assert.equal(tt.state().offset, (line(0) + line(1)).length)
})

// ─── frontier ────────────────────────────────────────────────────────────────

const H = 3_600_000
const DAY = 24 * H

await test('frontier: best first, bumps add up, aging lets new finds overtake old ones', () => {
  const t0 = 1_800_000_000_000
  const f = new ChainFrontier('solana')
  assert.equal(f.push({ address: JUP, via: 'block', score: 3 }, t0), 'added')
  assert.equal(f.push({ address: PHOENIX, via: 'registry', score: 6 }, t0), 'added')
  assert.equal(f.push({ address: DRIFT, via: 'web', score: 2 }, t0), 'added')
  assert.equal(f.push({ address: JUP, via: 'block', score: 4 }, t0), 'bumped') // 3 + 4 = 7 > 6
  assert.equal(f.push({ address: 'not-an-address', via: 'web', score: 9 }, t0), 'invalid')
  assert.equal(f.push({ address: SYSTEM.slice(1), via: 'web', score: 9 }, t0), 'invalid')
  assert.deepEqual(f.peekAll(t0).map((c) => c.address), [JUP, PHOENIX, DRIFT])
  // 12 h later a fresh find at 2 beats JUP's 7 (decayed to 1.75)
  assert.equal(f.push({ address: WHIRLPOOL, via: 'web', score: 2 }, t0 + 12 * H), 'added')
  const first = f.pop(t0 + 12 * H)!
  assert.equal(first.address, WHIRLPOOL)
  assert.equal(first.chain, 'solana')
  const second = f.pop(t0 + 12 * H)!
  assert.equal(second.address, JUP)
  assert.ok(Math.abs(second.score - 1.75) < 0.01, String(second.score))
  assert.equal(second.via, 'block')
})

await test('frontier: in flight, seen TTL (7 d), half weight after, cap eviction, EVM normalization', () => {
  const t0 = 1_800_000_000_000
  const f = new ChainFrontier('solana')
  f.push({ address: JUP, via: 'block', score: 5 }, t0)
  const c = f.pop(t0)!
  assert.equal(f.push({ address: JUP, via: 'block', score: 5 }, t0 + 1000), 'inflight')
  f.markInflightDone(JUP)
  assert.equal(f.push({ address: JUP, via: 'block', score: 5 }, t0 + 1000), 'added', 'handed back')
  f.pop(t0 + 2000)
  f.markRead(c.address, t0 + 2000)
  assert.equal(f.push({ address: JUP, via: 'web', score: 5 }, t0 + 6 * DAY), 'seen')
  assert.equal(f.push({ address: JUP, via: 'web', score: 5 }, t0 + 8 * DAY), 'added')
  assert.equal(f.peekAll(t0 + 8 * DAY)[0].score, 2.5, 'read before: half weight')
  // cap: the lowest-ranked are evicted, the best survive
  const g = new ChainFrontier('ethereum', { cap: 100 })
  for (let i = 1; i <= 150; i++) g.push({ address: '0x' + i.toString(16).padStart(40, 'a'), via: 'block', score: i / 20 }, t0)
  assert.ok(g.size <= 100 && g.size >= 90, String(g.size))
  assert.ok(g.has('0x' + (150).toString(16).padStart(40, 'a')))
  assert.ok(!g.has('0x' + (1).toString(16).padStart(40, 'a')))
  // EVM keys ignore case; output is checksummed
  const e = new ChainFrontier('base')
  assert.equal(e.push({ address: WETH9.toLowerCase(), via: 'web', score: 1 }, t0), 'added')
  assert.equal(e.push({ address: WETH9.toUpperCase().replace('0X', '0x'), via: 'block', score: 1 }, t0), 'bumped')
  assert.equal(e.pop(t0)!.address, WETH9)
  assert.equal(normalizeAddress('ethereum', '0x0000000000000000000000000000000000000001'), null, 'precompile')
})

await test('frontier: one source saturates at its cap, independent sources add up', () => {
  const t0 = 1_800_000_000_000
  const f = new ChainFrontier('solana')
  // a busy program seen in 200 consecutive block samples (90 s apart) stays at the block cap (8)
  for (let i = 0; i < 200; i++) f.push({ address: PUMP_AMM, via: 'block', score: 6, hint: `sample ${i}` }, t0 + i * 90_000)
  const t1 = t0 + 199 * 90_000
  assert.equal(f.peekAll(t1)[0].score, 8)
  // a verified program also seen once in a block and named on the web outranks it
  f.push({ address: PHOENIX, via: 'registry', score: 6, hint: 'OtterSec verified build' }, t1)
  f.push({ address: PHOENIX, via: 'block', score: 2 }, t1)
  f.push({ address: PHOENIX, via: 'web', score: 3, hint: 'named in text on docs.example.org' }, t1)
  const top = f.pop(t1)!
  assert.equal(top.address, PHOENIX)
  assert.equal(top.score, 11)
  assert.equal(top.via, 'registry', 'largest part names the source')
  assert.equal(top.hint, 'OtterSec verified build')
  assert.equal(f.pop(t1)!.hint, 'sample 199')
})

await test('frontier: persistence round trip keeps order, seen map and hints', () => {
  const t0 = 1_800_000_000_000
  const f = new ChainFrontier('solana')
  f.push({ address: JUP, via: 'block', score: 3, hint: 'invoked by 3 tx' }, t0)
  f.push({ address: PHOENIX, via: 'registry', score: 6, hint: 'OtterSec verified build' }, t0)
  f.markRead(DRIFT, t0)
  const j = JSON.parse(JSON.stringify(f.toJSON()))
  const g = new ChainFrontier('solana')
  assert.equal(g.load(j, t0 + 1000), 2)
  assert.equal(g.push({ address: DRIFT, via: 'web', score: 1 }, t0 + 1000), 'seen')
  const a = g.pop(t0 + 1000)!
  assert.equal(a.address, PHOENIX)
  assert.equal(a.hint, 'OtterSec verified build')
  assert.equal(g.pop(t0 + 1000)!.address, JUP)
  assert.equal(g.load({ q: [['bad', 1, 1, 'web']], seen: [['also bad', 5]] }, t0), 0)
})

await test('frontier: unverified / error reads are soft — short ttl, a registry find bypasses them, kept across a restart', () => {
  const t0 = 1_800_000_000_000
  const H = 3_600_000
  const f = new ChainFrontier('base')
  const A = '0x' + 'ab'.repeat(20)
  const B = '0x' + 'cd'.repeat(20)
  f.markRead(A, t0, 'unverified') // a creation read minutes after deployment
  f.markRead(B, t0, 'boilerplate')
  assert.equal(f.push({ address: A, via: 'block', score: 2 }, t0 + H), 'seen')
  // verified an hour later: the registry lists it → queued at once, full weight
  assert.equal(f.push({ address: A, via: 'registry', score: 4 }, t0 + H), 'added')
  assert.equal(f.peekAll(t0 + H)[0].score, 4)
  assert.equal(f.pop(t0 + H)!.address.toLowerCase(), A)
  // a final verdict is not bypassed by the registry
  assert.equal(f.push({ address: B, via: 'registry', score: 4 }, t0 + H), 'seen')
  // soft ttl (12 h) vs full ttl (7 d), through a save / load
  f.markRead(A, t0 + H, 'error')
  const g = new ChainFrontier('base')
  g.load(JSON.parse(JSON.stringify(f.toJSON())), t0 + 2 * H)
  assert.equal(g.push({ address: A, via: 'web', score: 2 }, t0 + 6 * H), 'seen')
  assert.equal(g.push({ address: A, via: 'web', score: 2 }, t0 + 14 * H), 'added')
  assert.equal(g.push({ address: B, via: 'web', score: 2 }, t0 + 14 * H), 'seen')
})

// ─── registries ──────────────────────────────────────────────────────────────

await test('registry parsers: Sourcify v2 list (burst damping), OtterSec pages', () => {
  const rows = parseSourcifyList({
    results: [
      { match: 'exact_match', chainId: '1', address: UNI_V3_FACTORY, verifiedAt: '2026-10-06T03:43:46Z', matchId: '54904194' },
      ...Array.from({ length: 6 }, (_, i) => ({ match: 'match', chainId: '1', address: '0x' + String(i + 1).repeat(40).slice(0, 40), verifiedAt: '2026-10-06T03:40:01Z', matchId: String(54900000 + i) })),
      { match: 'match', address: 'nope', matchId: '1' },
      { match: 'match', address: WETH9, matchId: 'x' },
    ],
  })
  assert.equal(rows.length, 7)
  assert.ok(rows[0].full && rows[0].matchId === 54904194)
  const scores = sourcifyScores(rows)
  assert.equal(scores.find((s) => s.address === UNI_V3_FACTORY)!.score, 5)
  const burst = scores.filter((s) => s.address !== UNI_V3_FACTORY).map((s) => s.score)
  assert.deepEqual(burst, [4, 4, 4, 1.2, 1.2, 1.2])
  assert.deepEqual(parseOsecPage({ meta: { total: 568, page: 2, total_pages: 29 }, verified_programs: [PHOENIX, 7] }), { programs: [PHOENIX], page: 2, totalPages: 29 })
  assert.equal(parseOsecPage({ error: 'x' }), null)
})

// ─── discovery loop (stub RPC) ───────────────────────────────────────────────

interface Stub extends RpcCtx {
  log: string[]
}

function stubRpc(o: {
  call?: (chain: ChainId, method: string, params: unknown[]) => unknown
  fetchJson?: (url: string) => unknown
  canSpend?: (chain: ChainId, n: number, discovery: boolean) => boolean
}): Stub {
  const log: string[] = []
  return {
    log,
    async call(chain, method, params) {
      log.push(`${chain} ${method}`)
      if (!o.call) throw new Error('no call')
      return o.call(chain, method, params)
    },
    async fetchJson(url) {
      log.push(`GET ${url}`)
      if (!o.fetchJson) throw new Error('no fetch')
      return o.fetchJson(url)
    },
    usage: () => ({}),
    canSpend: (chain, n = 1, d = false) => (o.canSpend ? o.canSpend(chain, n, d) : true),
  }
}

const quiet: (lvl: 'info' | 'warn' | 'error', msg: string) => void = () => {}
const testCfg: Partial<DiscoveryConfig> = { corpus: true, startDelayMs: 0 }

await test('discovery: Solana sampling raises the tx version on -32015, steps over skipped slots, skips natives', async () => {
  const dataDir = freshDir()
  const versions: unknown[] = []
  const slots: number[] = []
  let first = true
  const rpc = stubRpc({
    call: (_c, method, params) => {
      if (method === 'getSlot') return 1000
      const cfg = params[1] as { maxSupportedTransactionVersion: number }
      versions.push(cfg.maxSupportedTransactionVersion)
      slots.push(params[0] as number)
      if (first) {
        first = false
        throw new RpcError('rpc', 'solana discovery rpc getBlock: Transaction version (2) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 2 (-32015)', { code: -32015 })
      }
      if (slots.length === 2) throw new RpcError('rpc', 'Slot 995 was skipped, or missing due to ledger jump to recent snapshot (-32007)', { code: -32007 })
      return { blockTime: 1, transactions: fixture.transactions }
    },
  })
  const d = createDiscovery({ rpc, dataDir, log: quiet, config: { ...testCfg, solTxVersion: 1 } })
  const act = await d.run.solana()
  assert.ok(act && act.programs.size === 7)
  assert.deepEqual(versions, [1, 2, 2])
  assert.equal(slots[2], slots[1] - 1, 'skipped slot → previous slot')
  const got: string[] = []
  for (let c = d.next('solana'); c; c = d.next('solana')) {
    assert.equal(c.via, 'block')
    got.push(c.address)
  }
  assert.equal(got.length, 7)
  assert.ok(!got.includes(TOKEN) && !got.includes(SYSTEM))
  assert.equal(d.stats()['blocks.solana'], 1)
  assert.equal(d.stats()['found.block'], 7)
})

await test('discovery: budget gate — no sampling when the discovery budget is used up', async () => {
  const rpc = stubRpc({ call: () => 1, canSpend: () => false })
  const d = createDiscovery({ rpc, dataDir: freshDir(), log: quiet, config: testCfg })
  assert.equal(await d.run.solana(), null)
  assert.equal(await d.run.evm('base'), null)
  assert.equal(rpc.log.length, 0)
  assert.equal(d.stats().budgetWaits, 2)
  // a BudgetError thrown mid-poll is counted, not logged as an error
  const rpc2 = stubRpc({
    fetchJson: () => {
      throw new BudgetError('sourcify')
    },
  })
  const d2 = createDiscovery({ rpc: rpc2, dataDir: freshDir(), log: quiet, config: testCfg })
  await d2.run.registries()
  assert.equal(d2.stats().errors ?? 0, 0)
  assert.ok(d2.stats().budgetWaits >= 1)
})

const CREATED = '0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d'

await test('discovery: EVM sampling queues called contracts and creations, token traffic ranks lower', async () => {
  const router = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad'
  const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  const txs = [
    ...Array.from({ length: 3 }, () => ({ to: router, from: WETH9, input: '0x3593564c00', nonce: '0x1' })),
    ...Array.from({ length: 6 }, () => ({ to: usdc, from: WETH9, input: '0xa9059cbb00', nonce: '0x1' })),
    { to: null, from: '0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', input: '0x60806040', nonce: '0x0' },
  ]
  const rpc = stubRpc({ call: (_c, method, params) => (method === 'eth_getBlockByNumber' && params[0] === 'latest' && params[1] === true ? { number: '0x10', transactions: txs } : null) })
  let clock = Date.now()
  const dataDir = freshDir()
  const d = createDiscovery({ rpc, dataDir, log: quiet, config: testCfg, now: () => clock })
  await d.run.evm('base')
  const order = [d.next('base'), d.next('base'), d.next('base')].map((c) => c?.address.toLowerCase())
  assert.equal(order[0], router, '3 router calls beat 6 token transfers')
  assert.ok(order.includes(usdc))
  assert.ok(!order.includes(CREATED), 'a created contract waits for its delay (not verified minutes after deployment)')
  assert.equal(d.stats().deferred, 1)
  assert.equal(d.next('ethereum'), null)
  // the delay survives a restart; once over, the next sample offers the creation
  d.save()
  const d2 = createDiscovery({ rpc: stubRpc({ call: () => ({ number: '0x11', transactions: [] }) }), dataDir, log: quiet, config: testCfg, now: () => clock })
  assert.equal(d2.stats().deferred, 1)
  await d2.run.evm('base')
  assert.equal(d2.next('base')?.address.toLowerCase() === CREATED, false)
  clock += CREATION_DELAY_MS + 1000
  await d2.run.evm('base')
  const later: string[] = []
  for (let c = d2.next('base'); c; c = d2.next('base')) later.push(c.address.toLowerCase())
  assert.ok(later.includes(CREATED), 'created contract offered after the delay')
  assert.equal(d2.stats().deferred, 0)
})

await test('discovery: registries — Sourcify first page, then only newer rows; OtterSec cursor walks and wraps', async () => {
  let newest = 100
  const pages: Record<number, string[]> = { 1: [PHOENIX, JUP], 2: [DRIFT] }
  const rpc = stubRpc({
    fetchJson: (url) => {
      if (url.startsWith('https://sourcify.dev/server/v2/contracts/')) {
        assert.match(url, /\?sort=desc&limit=200/)
        const chainId = url.split('/contracts/')[1].split('?')[0]
        const id = (k: number) => String(newest - k)
        return { results: [0, 1].map((k) => ({ match: k ? 'match' : 'exact_match', chainId, address: '0x' + (chainId.padStart(4, '0') + id(k)).padStart(40, '7'), verifiedAt: '2026-10-06T03:43:46Z', matchId: id(k) })) }
      }
      const page = Number(url.split('/verified-programs/')[1])
      assert.ok(url.startsWith('https://verify.osec.io/verified-programs/'))
      return { meta: { total: 3, page, total_pages: 2 }, verified_programs: pages[page] ?? [] }
    },
  })
  const dataDir = freshDir()
  const d = createDiscovery({ rpc, dataDir, log: quiet, config: { ...testCfg, osecPages: 1 } })
  await d.run.registries()
  assert.equal(d.stats()['registry.sourcify'], 6)
  assert.equal(d.stats()['registry.osec'], 2)
  const sol = d.next('solana')!
  assert.equal(sol.via, 'registry')
  assert.equal(sol.hint, 'OtterSec verified build')
  newest = 101 // one new verification per chain
  await d.run.registries()
  assert.equal(d.stats()['registry.sourcify'], 9, 'only the new row of each chain')
  assert.equal(d.stats()['registry.osec'], 3, 'page 2')
  assert.equal(d.stats()['osec.sweeps'], 1)
  await d.run.registries()
  assert.ok(rpc.log.filter((l) => l.includes('/verified-programs/1')).length === 2, 'wrapped to page 1')
  assert.ok(d.next('ethereum')!.hint!.startsWith('Sourcify'))
})

await test('discovery: web corpus lines become candidates; agent hand-backs, links, markRead; state survives restart', async () => {
  const dataDir = freshDir()
  const page = (i: number, text: string, url = `https://docs.example.org/${i}`) => JSON.stringify({ id: `p${i}`, url, host: 'docs.example.org', title: 'docs', text, tokens: 9, vec: 'AAAA'.repeat(500) }) + '\n'
  writeFileSync(
    join(dataDir, 'dataset.jsonl'),
    page(0, `Program ID: ${PHOENIX}`) + page(1, 'nothing to see here') + page(2, `Router: https://arbiscan.io/address/${UNI_V3_FACTORY}`) + '{not json\n',
  )
  const rpc = stubRpc({})
  const d = createDiscovery({ rpc, dataDir, log: quiet, config: testCfg })
  const r = await d.run.corpus()
  assert.equal(r.lines, 4)
  const s = d.stats()
  assert.equal(s['found.web'], 2)
  assert.equal(s['corpus.lines'], 4)
  const sol = d.next('solana')!
  assert.equal(sol.address, PHOENIX)
  assert.equal(sol.via, 'web')
  // handed back unread (budget): queued again although in flight
  d.push(sol)
  assert.equal(d.stats().solana, 1)
  const again = d.next('solana')!
  d.markRead('solana', again.address)
  d.push({ chain: 'solana', address: PHOENIX, via: 'web', score: 9 })
  assert.equal(d.next('solana'), null, 'read within 7 days')
  // a link from an agent
  d.push({ chain: 'arbitrum', address: WETH9, via: 'link', score: 0, hint: 'implementation of 0x1234…' })
  d.save()
  // restart: queue, seen map and corpus offset are restored
  appendFileSync(join(dataDir, 'dataset.jsonl'), page(3, `see https://etherscan.io/address/${WETH9}`))
  const d2 = createDiscovery({ rpc, dataDir, log: quiet, config: testCfg })
  assert.equal(d2.stats().arbitrum, 2)
  const r2 = await d2.run.corpus()
  assert.equal(r2.lines, 1, 'only the new line')
  assert.equal(d2.next('ethereum')!.address, WETH9)
  const top = d2.next('arbitrum')!
  assert.equal(top.via, 'link')
  assert.equal(top.score, 8)
  d2.push({ chain: 'solana', address: PHOENIX, via: 'web', score: 9 })
  assert.equal(d2.next('solana'), null, 'seen map restored')
  assert.ok(existsSync(join(dataDir, 'chain', 'frontier.json')))
})

await test('discovery: start/stop with timers, unreadable frontier.json moved aside', async () => {
  const dataDir = freshDir()
  mkdirSync(join(dataDir, 'chain'), { recursive: true })
  writeFileSync(join(dataDir, 'chain', 'frontier.json'), '{broken')
  const warns: string[] = []
  const rpc = stubRpc({
    call: (_c, method) => {
      if (method === 'getSlot') return 5000
      if (method === 'getBlock') return { transactions: fixture.transactions }
      return { number: '0x1', transactions: [{ to: WETH9, input: '0xd0e30db0', from: WETH9, nonce: '0x0' }] }
    },
    fetchJson: () => ({ results: [] }),
  })
  const d = createDiscovery({ rpc, dataDir, log: (l, m) => l !== 'info' && warns.push(m), config: { ...testCfg, startDelayMs: 1, corpusIdleMs: 50, saveMs: 60 } })
  assert.ok(existsSync(join(dataDir, 'chain', 'frontier.json.bad')))
  d.start()
  for (let i = 0; i < 100 && !(d.stats()['blocks.solana'] && d.stats()['blocks.arbitrum']); i++) await new Promise((r) => setTimeout(r, 50))
  await d.stop()
  assert.ok(d.stats()['blocks.solana'] >= 1, JSON.stringify(d.stats()))
  assert.ok(d.stats()['blocks.arbitrum'] >= 1)
  const saved = JSON.parse(readFileSync(join(dataDir, 'chain', 'frontier.json'), 'utf8'))
  assert.equal(saved.v, 1)
  assert.ok(saved.chains.solana.q.length >= 7)
  assert.ok(warns.length >= 1, 'broken state file reported')
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
