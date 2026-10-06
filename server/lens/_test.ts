// LUSCA Lens tests: no network. Real readers (server/chain/evm.ts, solana.ts) over fake RPC
// contexts with the recorded fixtures of the chain tests, the real chain store in a temp dir.
//   npx tsx server/lens/_test.ts
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { base58Decode } from '../../shared/base58.ts'
import type { ChainEvent, ChainRead } from '../../shared/chain.ts'
import { RpcError, type RpcCtx } from '../chain/rpc.ts'
import { PROXY_SLOTS } from '../chain/evm.ts'
import { createChainStore } from '../chain/store.ts'
import { AAVE_POOL_PROXY_CODE, WETH9_CODE, WETH9_SOURCIFY } from '../chain/_evm.fixtures.ts'
import { murmur3_32, scanElf, solanaPrimitives } from './elf-syscalls.ts'
import { AnalysisLimit, Work, compactWs, findPrimitives, findPrivileged, groupAbi } from './evm-analysis.ts'
import { idlDetail, signerRoles, anchorType } from './idl-detail.ts'
import { createProvenanceIndex, exactKey } from './provenance.ts'
import { buildEvmReport, buildSolanaReport, repoCommitUrl } from './report.ts'
import { createLens, createWindow, safeName, validateTarget, LensError } from './index.ts'

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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-lens-'))
const quiet = () => {}

// ─── ELF syscalls ────────────────────────────────────────────────────────────

await test('murmur3_32 matches the SBPF syscall ids', () => {
  // ids published in the Solana runtime (sbpf static syscalls)
  assert.equal(murmur3_32(Buffer.from('sol_log_')), 0x207559bd)
  assert.equal(murmur3_32(Buffer.from('abort')), 0xb6fc1a11)
  assert.equal(murmur3_32(Buffer.from('sol_panic_')), 0x686093bb)
  assert.equal(murmur3_32(Buffer.from('')), 0)
})

/** A minimal ELF64: [null, .text, .dynstr, .dynsym, .shstrtab]; `imports` undefined symbols, `calls` hashed call imms. */
function makeElf(imports: string[], calls: string[], extra: Buffer = Buffer.alloc(0)): Buffer {
  const text = Buffer.alloc(8 * (calls.length + 1))
  calls.forEach((c, i) => {
    text[i * 8] = 0x85
    text.writeUInt32LE(murmur3_32(Buffer.from(c)), i * 8 + 4)
  })
  text[calls.length * 8] = 0x95 // exit
  const dynstr = Buffer.concat([Buffer.from([0]), ...imports.map((n) => Buffer.from(`${n}\0`))])
  const dynsym = Buffer.alloc(24 * (imports.length + 1))
  let off = 1
  imports.forEach((n, i) => {
    dynsym.writeUInt32LE(off, (i + 1) * 24) // st_name; st_shndx 0 = undefined
    off += n.length + 1
  })
  const shstr = Buffer.from('\0.text\0.dynstr\0.dynsym\0.shstrtab\0')
  const header = Buffer.alloc(64)
  const body = Buffer.concat([text, dynstr, dynsym, shstr, extra])
  const tOff = 64
  const dsOff = tOff + text.length
  const dyOff = dsOff + dynstr.length
  const shOff = dyOff + dynsym.length
  let shoff = shOff + shstr.length + extra.length
  shoff += (8 - (shoff % 8)) % 8
  const pad = Buffer.alloc(shoff - (64 + body.length))
  const sh = Buffer.alloc(64 * 5)
  const sec = (i: number, name: number, type: number, flags: number, offset: number, size: number, link: number, entsize: number) => {
    const o = i * 64
    sh.writeUInt32LE(name, o)
    sh.writeUInt32LE(type, o + 4)
    sh.writeBigUInt64LE(BigInt(flags), o + 8)
    sh.writeBigUInt64LE(BigInt(offset), o + 24)
    sh.writeBigUInt64LE(BigInt(size), o + 32)
    sh.writeUInt32LE(link, o + 40)
    sh.writeBigUInt64LE(BigInt(entsize), o + 56)
  }
  sec(1, 1, 1, 0x6, tOff, text.length, 0, 0)
  sec(2, 7, 3, 0x2, dsOff, dynstr.length, 0, 0)
  sec(3, 15, 11, 0x2, dyOff, dynsym.length, 2, 24)
  sec(4, 23, 3, 0, shOff, shstr.length, 0, 0)
  header.write('\x7fELF', 0, 'latin1')
  header[4] = 2
  header[5] = 1
  header.writeBigUInt64LE(BigInt(shoff), 0x28)
  header.writeUInt16LE(64, 0x3a)
  header.writeUInt16LE(5, 0x3c)
  header.writeUInt16LE(4, 0x3e)
  return Buffer.concat([header, body, pad, sh])
}

await test('scanElf: syscall imports, hashed static syscalls, signature program ids; zero-trimmed tail', () => {
  const ed = Buffer.from(base58Decode('Ed25519SigVerify111111111111111111111111111')!)
  const elf = makeElf(['sol_log_', 'sol_sha256', 'sol_poseidon', 'sol_invoke_signed_rust'], ['sol_keccak256', 'sol_log_'], ed)
  // the code-hash rule trims trailing zeros: the last section header ends in zeros
  let end = elf.length
  while (end > 0 && elf[end - 1] === 0) end--
  const s = scanElf(elf.subarray(0, end))
  assert.deepEqual(s.imports, ['sol_log_', 'sol_sha256', 'sol_poseidon', 'sol_invoke_signed_rust'])
  assert.deepEqual(s.hashed, ['sol_keccak256']) // sol_log_ is already an import
  assert.deepEqual(s.sigPrograms, ['Ed25519SigVerify111111111111111111111111111'])
  assert.deepEqual(s.notes, [])
  const prims = solanaPrimitives(s).map((p) => `${p.group}:${p.via}:${p.name.split(' (')[0]}`)
  assert.deepEqual(prims, [
    'hash:syscall-import:SHA-256',
    'zk:syscall-import:Poseidon',
    'hash:syscall-id:Keccak-256',
    'signature:program-id:Ed25519 signature verification',
  ])
})

await test('scanElf never throws on garbage and says why', () => {
  assert.match(scanElf(Buffer.from('not an elf at all')).notes[0], /not an ELF/)
  const broken = makeElf(['sol_sha256'], [])
  broken.writeBigUInt64LE(BigInt(10 ** 9), 0x28)
  assert.match(scanElf(broken).notes[0], /section headers/)
})

// ─── IDL ─────────────────────────────────────────────────────────────────────

const LEGACY_IDL = {
  version: '0.1.0',
  name: 'vault',
  instructions: [
    {
      name: 'setFee',
      accounts: [
        { name: 'config', isMut: true, isSigner: false },
        { name: 'adminAuthority', isMut: false, isSigner: true },
      ],
      args: [{ name: 'bps', type: 'u16' }],
    },
    {
      name: 'deposit',
      accounts: [
        { name: 'user', isMut: true, isSigner: true },
        { name: 'userTransferAuthority', isMut: false, isSigner: true },
        { name: 'pool', accounts: [{ name: 'state', isMut: true, isSigner: false }] },
      ],
      args: [{ name: 'amounts', type: { vec: 'u64' } }, { name: 'who', type: { option: 'publicKey' } }, { name: 'h', type: { array: ['u8', 32] } }],
    },
  ],
  accounts: [{ name: 'Config' }],
  types: [{ name: 'X' }],
  errors: [{ code: 6000, name: 'Paused', msg: 'paused' }],
  events: [{ name: 'Deposited' }],
}

await test('idlDetail: Anchor legacy accounts, nested groups, typed args; signer roles by name', () => {
  const d = idlDetail(LEGACY_IDL, 'Anchor IDL account')!
  assert.equal(d.format, 'anchor-legacy')
  assert.equal(d.name, 'vault')
  assert.deepEqual(d.instructions[0].accounts[1], { name: 'adminAuthority', signer: true, writable: false, optional: false })
  assert.deepEqual(d.instructions[1].accounts.map((a) => a.name), ['user', 'userTransferAuthority', 'pool.state'])
  assert.deepEqual(d.instructions[1].args.map((a) => a.type), ['Vec<u64>', 'Option<Pubkey>', '[u8; 32]'])
  assert.deepEqual(d.errors, [{ code: 6000, name: 'Paused', msg: 'paused' }])
  assert.deepEqual(d.events, ['Deposited'])
  // admin authority is a role; a user's transfer authority is not
  assert.deepEqual(signerRoles(d), [{ instruction: 'setFee', account: 'adminAuthority' }])
})

await test('idlDetail: Anchor 0.30 spec and Codama', () => {
  const spec = idlDetail(
    {
      address: 'x',
      metadata: { name: 'amm', version: '0.2.0', spec: '0.1.0' },
      instructions: [{ name: 'update_config', accounts: [{ name: 'owner', signer: true }, { name: 'amm_config', writable: true }, { name: 'operator', signer: true }], args: [{ name: 'param', type: { defined: { name: 'Param' } } }] }],
    },
    'program-metadata IDL',
  )!
  assert.equal(spec.format, 'anchor')
  assert.equal(spec.instructions[0].args[0].type, 'Param')
  assert.deepEqual(signerRoles(spec), [{ instruction: 'update_config', account: 'operator' }])
  const codama = idlDetail(
    {
      kind: 'rootNode',
      program: {
        name: 'token',
        instructions: [
          {
            name: 'mintTo',
            accounts: [{ name: 'mint', isWritable: true, isSigner: false }, { name: 'mintAuthority', isSigner: true }],
            arguments: [{ name: 'discriminator', type: { kind: 'numberTypeNode', format: 'u8' } }, { name: 'amount', type: { kind: 'numberTypeNode', format: 'u64' } }],
          },
        ],
        errors: [{ code: 1, name: 'InsufficientFunds', message: 'no' }],
      },
    },
    'program-metadata IDL',
  )!
  assert.equal(codama.format, 'codama')
  assert.deepEqual(codama.instructions[0].args, [{ name: 'amount', type: 'u64' }])
  assert.equal(anchorType({ coption: 'publicKey' }), 'COption<Pubkey>')
  assert.equal(idlDetail({ hello: 1 }, 'x'), null)
})

// ─── EVM source analysis ─────────────────────────────────────────────────────

const OWNABLE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
abstract contract Ownable {
    address private _owner;
    modifier onlyOwner() {
        _checkOwner();
        _;
    }
    function owner() public view returns (address) { return _owner; }
    function _checkOwner() internal view {
        require(owner() == msg.sender, "not owner");
    }
    function transferOwnership(address n) public virtual onlyOwner { _owner = n; }
}
`
const VAULT = `pragma solidity ^0.8.20;
import "./Ownable.sol";
interface IERC1271 { function isValidSignature(bytes32 h, bytes memory s) external view returns (bytes4); }
contract Vault is Ownable {
    address public guardian;
    mapping(address => bool) public keepers;
    modifier onlyGuardian() {
        if (msg.sender != guardian) revert();
        _;
    }
    /* a comment mentioning msg.sender == owner must not count */
    function setGuardian(address g) external onlyOwner { guardian = g; }
    function pause() external onlyGuardian {}
    function harvest() external {
        require(keepers[msg.sender], "keeper");
    }
    function sweep(address to) external {
        require(msg.sender == guardian);
        payable(to).transfer(address(this).balance);
    }
    function withdraw(address from, uint256 amt) external {
        require(msg.sender == from, "own funds only");
        bytes32 h = keccak256(abi.encode(from, amt));
        address s = ecrecover(h, 27, bytes32(0), bytes32(0));
        (bool ok, ) = address(0x0a).staticcall(abi.encode(h));
        s; ok;
    }
    function deposit() external payable {}
    function rate(uint256 a) external pure returns (uint256) { return a; }
    function rate(uint256 a, uint256 b) external {
        require(msg.sender == guardian);
        a; b;
    }
}
`
const SOURCES = [
  { path: 'contracts/access/Ownable.sol', text: OWNABLE },
  { path: 'contracts/Vault.sol', text: VAULT },
]
const VAULT_ABI = [
  { type: 'function', name: 'setGuardian', inputs: [{ type: 'address' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'pause', inputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'harvest', inputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'sweep', inputs: [{ type: 'address' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'withdraw', inputs: [{ type: 'address' }, { type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'deposit', inputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'rate', inputs: [{ type: 'uint256' }], stateMutability: 'pure' },
  { type: 'function', name: 'rate', inputs: [{ type: 'uint256' }, { type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'transferOwnership', inputs: [{ type: 'address' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'owner', inputs: [], constant: true },
  { type: 'event', name: 'Paused', inputs: [{ type: 'address' }] },
]

await test('groupAbi: mutability groups (legacy constant / payable flags honored), events', () => {
  const g = groupAbi(VAULT_ABI)
  assert.deepEqual(g.payable, ['deposit()'])
  assert.deepEqual(g.view, ['rate(uint256)', 'owner()'])
  assert.equal(g.write.length, 7)
  assert.deepEqual(g.events, ['Paused(address)'])
})

await test('findPrivileged: modifiers (direct and via helper), inline checks, overloads; user-permission checks are not privileged', () => {
  const g = groupAbi(VAULT_ABI)
  const p = findPrivileged(SOURCES, [...g.write, ...g.payable])
  const by = Object.fromEntries(p.map((x) => [x.fn, x]))
  assert.deepEqual(Object.keys(by).sort(), ['harvest()', 'pause()', 'rate(uint256,uint256)', 'setGuardian(address)', 'sweep(address)', 'transferOwnership(address)'])
  assert.equal(by['setGuardian(address)'].guard, 'onlyOwner')
  assert.equal(by['setGuardian(address)'].file, 'contracts/Vault.sol')
  assert.equal(by['setGuardian(address)'].line, 12)
  assert.equal(by['pause()'].guard, 'onlyGuardian')
  assert.equal(by['sweep(address)'].guard, 'require(msg.sender == guardian);')
  assert.equal(by['sweep(address)'].line, 18)
  assert.match(by['harvest()'].guard, /keepers\[msg\.sender\]/)
  assert.equal(by['transferOwnership(address)'].file, 'contracts/access/Ownable.sol')
  // withdraw checks msg.sender against its own parameter: a user permission, not a role
  assert.equal(by['withdraw(address,uint256)'], undefined)
})

await test('findPrimitives: hashes, signatures, precompiles with file:line; declarations are not uses', () => {
  const prims = findPrimitives(SOURCES)
  const by = Object.fromEntries(prims.map((p) => [p.name.split(' (')[0], p]))
  assert.deepEqual(by['Keccak-256'].at, [{ file: 'contracts/Vault.sol', line: 23 }])
  assert.equal(by.ecrecover.at[0].line, 24)
  assert.equal(by['KZG point evaluation'].at[0].line, 25)
  assert.equal(by['EIP-1271 contract signatures'], undefined) // only an interface declaration
})

// ─── provenance ──────────────────────────────────────────────────────────────

function writeCodeIndex(dir: string, files: { path: string; text: string }[]) {
  const code = path.join(dir, 'code')
  fs.mkdirSync(code, { recursive: true })
  const lines = files.map((f) => JSON.stringify({ repo: 'acme/vaults', commit: 'c0ffee', path: f.path, lang: 'solidity', sha256: crypto.createHash('sha256').update(f.text).digest('hex'), text: f.text }))
  fs.writeFileSync(path.join(code, 'acme__vaults.1.0.jsonl.gz'), zlib.gzipSync(`${lines.join('\n')}\n`))
  fs.writeFileSync(
    path.join(code, 'index.json'),
    JSON.stringify({ version: 2, repos: { 'acme/vaults': { repo: 'acme/vaults', commit: 'c0ffee', status: 'ok', shards: ['acme__vaults.1.0.jsonl.gz'] } } }),
  )
}

await test('provenance: byte-identical (CRLF / BOM normalized like the code index) and same-code matches; persisted', async () => {
  const dir = tmp()
  writeCodeIndex(dir, [{ path: 'src/Vault.sol', text: VAULT }])
  const p = createProvenanceIndex({ dataDir: dir, log: quiet })
  assert.deepEqual(p.stats(), { repos: 0, files: 0, builtAt: null })
  await p.refresh()
  assert.equal(p.stats().files, 1)
  assert.deepEqual(p.lookup(`﻿${VAULT.replace(/\n/g, '\r\n')}`, 'Vault.sol'), { repo: 'acme/vaults', commit: 'c0ffee', path: 'src/Vault.sol', exact: true })
  const reformatted = VAULT.replace('/* a comment mentioning msg.sender == owner must not count */', '// another comment').replace(/    /g, '\t')
  assert.deepEqual(p.lookup(reformatted, 'Vault.sol'), { repo: 'acme/vaults', commit: 'c0ffee', path: 'src/Vault.sol', exact: false })
  assert.equal(p.lookup(VAULT.replace('guardian = g', 'guardian = address(0)'), 'Vault.sol'), null)
  assert.equal(p.repoCommit('https://github.com/Acme/Vaults'), 'c0ffee')
  assert.equal(p.repoCommit('other/repo'), undefined)
  // a restart reads the hashes back without a rescan
  const q = createProvenanceIndex({ dataDir: dir, log: quiet })
  assert.equal(q.stats().files, 1)
  assert.equal(q.lookup(VAULT, 'x.sol')?.exact, true)
  assert.equal(exactKey('a\r\nb'), exactKey('a\nb'))
})

// ─── Lens: validation, proxy following, SEPIA-1 handoff, limits, persistence ─

const PROXY = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
const IMPL = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const word = (a: string) => `0x${a.slice(2).padStart(64, '0')}`

function sharedRpc(o: { sourcify?: (url: string) => unknown; failCode?: boolean } = {}) {
  const calls: string[] = []
  const urls: string[] = []
  const rpc: RpcCtx = {
    async call(_chain, method, params) {
      calls.push(method)
      if (method === 'eth_getCode') {
        if (o.failCode) throw new RpcError('timeout', 'ethereum rpc eth_getCode: timed out after 8 s', { transient: true })
        const a = String(params[0]).toLowerCase()
        return a === PROXY ? AAVE_POOL_PROXY_CODE : a === IMPL ? WETH9_CODE : '0x'
      }
      if (method === 'eth_getStorageAt') return String(params[1]) === PROXY_SLOTS.eip1967Implementation && String(params[0]).toLowerCase() === PROXY ? word(IMPL) : `0x${'0'.repeat(64)}`
      if (method === 'eth_call') return '0x'
      throw new Error(`unexpected ${method}`)
    },
    async fetchJson(url) {
      urls.push(url)
      if (o.sourcify) return o.sourcify(url)
      if (url.toLowerCase().includes(IMPL)) return WETH9_SOURCIFY
      throw new RpcError('http', 'sourcify GET: HTTP 404', { status: 404, body: { match: null } })
    },
    usage: () => ({}),
    canSpend: () => true,
  }
  return { rpc, calls, urls }
}

function makeLens(
  dir: string,
  x: { rpc?: RpcCtx; limits?: Parameters<typeof createLens>[0]['limits']; now?: () => number; readSolana?: Parameters<typeof createLens>[0]['readSolana'] } = {},
) {
  const store = createChainStore({ dataDir: dir, log: quiet })
  const events: ChainEvent[] = []
  const provenance = createProvenanceIndex({ dataDir: dir, log: quiet })
  const lens = createLens({
    rpc: x.rpc ?? sharedRpc().rpc,
    store,
    record: (ev) => events.push(ev),
    feed: () => [],
    provenance,
    dataDir: dir,
    log: quiet,
    limits: x.limits,
    now: x.now,
    readSolana: x.readSolana,
  })
  return { lens, store, events, provenance }
}

await test('validateTarget: chains, base58 / hex formats, canonical lower-case EVM', () => {
  assert.deepEqual(validateTarget('base', `0x${'AB'.repeat(20)}`), { chain: 'base', address: `0x${'ab'.repeat(20)}` })
  assert.equal(validateTarget('solana', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4').address, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')
  for (const [c, a] of [
    ['polygon', `0x${'ab'.repeat(20)}`],
    ['ethereum', '0x1234'],
    ['ethereum', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'],
    ['solana', '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'],
    ['solana', `0x${'ab'.repeat(20)}`],
  ])
    assert.throws(() => validateTarget(c, a), (e: unknown) => e instanceof LensError && e.status === 400)
})

await test('route: 400 / 404 as JSON errors; recent and status answer', async () => {
  const { lens } = makeLens(tmp())
  const bad = await lens.route('/api/lens/ethereum/0xnothex', '1.1.1.1')
  assert.equal(bad.status, 400)
  assert.match(JSON.parse(bad.json).error, /EVM address/)
  assert.equal((await lens.route('/api/lens/ethereum/a/b', '1.1.1.1')).status, 404)
  assert.equal((await lens.route('/api/lens/%E0%A4%A/x', '1.1.1.1')).status, 404)
  assert.deepEqual(JSON.parse((await lens.route('/api/lens/recent', '1.1.1.1')).json), { reads: 0, recent: [] })
  assert.equal(JSON.parse((await lens.route('/api/lens/status', '1.1.1.1')).json).inFlight, 0)
})

await test('EVM read: proxy followed to the implementation, both read by the agents’ reader; implementation kept via lens', async () => {
  const dir = tmp()
  const sh = sharedRpc()
  const { lens, store, events } = makeLens(dir, { rpc: sh.rpc })
  const a = await lens.read('ethereum', PROXY, '1.1.1.1')
  const r = a.report
  assert.equal(a.cached, false)
  assert.equal(r.evm?.proxy?.standard, 'eip1967')
  assert.equal(r.evm?.proxy?.implementation, IMPL)
  assert.equal(r.evm?.self.verified, null)
  assert.equal(r.evm?.implementation?.name, 'WETH9')
  assert.equal(r.summary.verified, 'sourcify-partial')
  assert.equal(r.summary.upgradeable, true)
  assert.ok(r.evm!.implementation!.functions.payable.includes('deposit()'))
  assert.ok(r.evm!.implementation!.functions.view.includes('balanceOf(address)'))
  assert.equal(r.summary.surface, r.evm!.implementation!.functions.write.length + r.evm!.implementation!.functions.payable.length + r.evm!.implementation!.functions.view.length)
  assert.ok(r.primitives.length === 0 || r.primitives.every((p) => p.via === 'source'))
  // two reads: proxy (getCode + slot) and implementation (getCode), two Sourcify lookups
  assert.equal(sh.calls.filter((m) => m === 'eth_getCode').length, 2)
  assert.equal(sh.urls.length, 2)
  assert.equal(r.rpcCalls, sh.calls.length)
  // SEPIA-1: the implementation is the code; kept under the same rules, discovery source 'lens'
  assert.equal(r.dataset.address, IMPL)
  assert.equal(r.dataset.verdict, 'kept')
  assert.equal(r.dataset.added, true)
  assert.equal(store.item('ethereum', IMPL)?.item.via, 'lens')
  assert.equal(events.length, 1)
  assert.equal(events[0].via, 'lens')
  assert.equal(events[0].agent, 'lens')
  // the next Lens read of the same code is a duplicate, and nothing more is stored
  const b = await lens.read('ethereum', IMPL, '2.2.2.2')
  assert.equal(b.report.dataset.verdict, 'duplicate')
  assert.equal(b.report.dataset.before?.verdict, 'kept')
  assert.equal(b.report.dataset.added, false)
  assert.equal(events.length, 1)
  await store.close()
})

await test('EVM read: no verified source → reported, not stored, nothing counted', async () => {
  const dir = tmp()
  const sh = sharedRpc({
    sourcify: () => {
      throw new RpcError('http', 'sourcify GET: HTTP 404', { status: 404, body: { match: null } })
    },
  })
  const { lens, store, events } = makeLens(dir, { rpc: sh.rpc })
  const r = (await lens.read('ethereum', IMPL, '1.1.1.1')).report
  assert.equal(r.summary.verified, null)
  assert.equal(r.summary.privileged, null)
  assert.equal(r.summary.surface, null)
  assert.equal(r.dataset.verdict, 'unverified')
  assert.equal(r.dataset.added, false)
  assert.equal(events.length, 0)
  assert.equal(store.summary().reads, 0)
  await store.close()
})

await test('cache, in-flight dedupe, per-IP limits, endpoint failure → 503 without a guess', async () => {
  const dir = tmp()
  const sh = sharedRpc()
  const { lens, store } = makeLens(dir, { rpc: sh.rpc, limits: { freshPerMin: 2, freshPerHour: 10, cachedPerMin: 2 } })
  // two concurrent requests for one address: one read
  const [x, y] = await Promise.all([lens.read('ethereum', IMPL, '9.9.9.9'), lens.read('ethereum', IMPL.toUpperCase().replace('0X', '0x'), '8.8.8.8')])
  assert.equal(sh.calls.filter((m) => m === 'eth_getCode').length, 1)
  assert.equal(x.cached !== y.cached, true)
  // served from the cache afterwards
  assert.equal((await lens.read('ethereum', IMPL, '9.9.9.9')).cached, true)
  // the cached-answer window is per IP
  await lens.read('ethereum', IMPL, '9.9.9.9')
  await assert.rejects(lens.read('ethereum', IMPL, '9.9.9.9'), (e: unknown) => e instanceof LensError && e.status === 429)
  // fresh reads: 2 a minute per IP
  await lens.read('ethereum', PROXY, '7.7.7.7')
  await lens.read('base', PROXY, '7.7.7.7')
  const r3 = await lens.route(`/api/lens/arbitrum/${PROXY}`, '7.7.7.7')
  assert.equal(r3.status, 429)
  assert.ok(Number(r3.headers?.['Retry-After']) > 0)
  // an endpoint that fails is a 503, never a report
  const failing = makeLens(tmp(), { rpc: sharedRpc({ failCode: true }).rpc })
  const f = await failing.lens.route(`/api/lens/ethereum/${IMPL}`, '6.6.6.6')
  assert.equal(f.status, 503)
  assert.match(JSON.parse(f.json).error, /nothing was guessed/)
  await store.close()
  await failing.store.close()
})

await test('budget slice: Lens stops at its own daily limit; reads served and recent survive a restart', async () => {
  const dir = tmp()
  const sh = sharedRpc()
  let t = Date.UTC(2026, 9, 6, 10)
  const one = makeLens(dir, { rpc: sh.rpc, limits: { hourShare: 1, budget: { solana: 0, 'solana-discovery': 0, ethereum: 4, base: 4, arbitrum: 4, sourcify: 10, osec: 10 } }, now: () => t })
  await one.lens.read('ethereum', IMPL, '1.1.1.1') // 1 RPC call
  const second = await one.lens.route(`/api/lens/ethereum/${PROXY}`, '1.1.1.2') // needs ≥ 3 left: 3 left → runs (proxy 2 + impl 1)
  assert.equal(second.status, 200)
  const third = await one.lens.route(`/api/lens/ethereum/0x${'12'.repeat(20)}`, '1.1.1.3')
  assert.equal(third.status, 503)
  assert.match(JSON.parse(third.json).error, /daily ethereum read budget/)
  const sol = await one.lens.route('/api/lens/solana/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', '1.1.1.4')
  assert.equal(sol.status, 503)
  await one.store.close()
  // restart: the counters and the strip come back from disk
  const two = makeLens(dir, { rpc: sh.rpc, now: () => t })
  const rec = JSON.parse((await two.lens.route('/api/lens/recent', '1.1.1.1')).json) as { reads: number; recent: { address: string }[] }
  assert.equal(rec.reads, 2)
  assert.deepEqual(rec.recent.map((x) => x.address), [PROXY, IMPL])
  assert.equal(JSON.parse((await two.lens.route('/api/lens/status', '1.1.1.1')).json).budget.ethereum.used, 4)
  // a new UTC day resets the slice
  t += 86_400_000
  assert.equal(JSON.parse((await two.lens.route('/api/lens/status', '1.1.1.1')).json).budget.ethereum.used, 0)
  await two.store.close()
})

await test('createWindow: sliding window per key, refund', () => {
  let t = 0
  const w = createWindow(1000, 2, () => t)
  assert.equal(w.take('a'), 0)
  assert.equal(w.take('a'), 0)
  assert.equal(w.take('a'), 1000)
  assert.equal(w.take('b'), 0)
  w.refund('a')
  assert.equal(w.take('a'), 0)
  t = 1001
  assert.equal(w.take('a'), 0)
})

await test('buildSolanaReport: facts only from the read; OtterSec repo checked against the code index', () => {
  const read: ChainRead = {
    chain: 'solana',
    address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    kind: 'program',
    name: null,
    codeHash: 'ab'.repeat(32),
    upgradeable: true,
    upgradeAuthority: 'CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ',
    lastDeploySlot: 123,
    programBytes: 1000,
    loader: 'bpf-upgradeable',
    idl: null,
    securityTxt: null,
    bytecodeBytes: null,
    proxy: null,
    abi: null,
    verified: { by: 'osec', match: 'full', repo: 'https://github.com/acme/vaults', commit: 'abc', compiler: null },
    sources: [],
    notes: ['IDL from the Anchor IDL account (anchor-legacy)'],
    readAt: 1,
    rpcCalls: 1,
  }
  const r = buildSolanaReport(
    { read, idlJson: LEGACY_IDL, elf: null, osec: { isVerified: true, onChainHash: null, executableHash: null, repo: 'https://github.com/acme/vaults', commit: 'abc', lastVerifiedAt: null, frozen: false, closed: false }, programDataAddress: null },
    {
      ms: 5,
      rpcCalls: 1,
      registryCalls: 1,
      provenance: { lookup: () => null, repoCommit: (r) => (r.toLowerCase() === 'acme/vaults' ? 'def' : undefined), stats: () => ({ repos: 1, files: 1, builtAt: 1 }) },
      dataset: { address: read.address, before: null, verdict: 'kept', reason: 'x', added: false },
    },
  )
  assert.equal(r.summary.verified, 'osec')
  assert.equal(r.summary.surface, 2)
  assert.equal(r.summary.privileged, 1)
  assert.equal(r.solana?.idl?.source, 'Anchor IDL account')
  assert.deepEqual(r.provenance.osecRepo, { repo: 'acme/vaults', commit: 'abc', inCodeIndex: true, indexCommit: 'def' })
  assert.equal(r.summary.provenance, 1)
  assert.deepEqual(r.solana?.syscalls, []) // no ELF read: nothing claimed
  assert.equal(r.primitives.length, 0)
  assert.ok(r.cites.some((c) => c.url === 'https://verify.osec.io/status/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'))
})

// ─── review fixes: hostile input, unknown registry state, caps, public names, persistence ─

await test('source analysis: whitespace runs of 50k (spaces, newlines, tabs) stay fast; line numbers survive compaction', () => {
  for (const ws of [' ', '\n', '\t', '\r\n']) {
    const run = ws.repeat(50_000)
    const src = `contract C {\n address owner;\n function f() external {\n if (${run} owner ${run} != ${run} msg.sender) revert();\n require(${run}); hasRole(${run});\n }\n function g() external { t.call(${run}""); t.staticcall(gas(), ${run} 0x08 ${run}, 0, 0, 0, 0); }\n}`
    const t0 = Date.now()
    const p = findPrivileged([{ path: 'C.sol', text: src }], ['f()', 'g()'])
    const q = findPrimitives([{ path: 'C.sol', text: src }])
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms for ${JSON.stringify(ws)}`)
    assert.equal(p.length, 1)
    assert.equal(p[0].fn, 'f()')
    // the guard is cited on the line it starts on in the verified file
    const want = src.slice(0, src.indexOf('if (')).split('\n').length
    assert.equal(p[0].line, want)
    assert.ok(q.some((x) => x.name.startsWith('BN254 pairing check')))
  }
  // a long run of identifier characters after call( is not quadratic either
  const s2 = `contract C { function g() external { ${'t.call('.repeat(20_000)}${'a'.repeat(50_000)} } }`
  const t1 = Date.now()
  findPrimitives([{ path: 'C.sol', text: s2 }])
  findPrivileged([{ path: 'C.sol', text: s2 }], ['g()'])
  assert.ok(Date.now() - t1 < 2000)
  // compaction keeps a map back to the original text
  const c = compactWs('a  \n\n  b\tc')
  assert.equal(c.text, 'a\nb c')
  assert.equal(c.map[2], 7)
})

await test('source analysis: a fixed work budget; deeply nested code is reported as not completed, never as a partial list', () => {
  let y = 'contract C { function g() external { assembly { '
  for (let i = 0; i < 1200; i++) y += `function f${i}(a) -> b { `
  y += 'let x := 1 '.repeat(20_000)
  for (let i = 0; i < 1200; i++) y += '} '
  y += '} } }'
  const t0 = Date.now()
  assert.throws(() => findPrivileged([{ path: 'C.sol', text: y }], ['g()']), (e: unknown) => e instanceof AnalysisLimit)
  assert.ok(Date.now() - t0 < 3000)
  assert.throws(() => findPrimitives(SOURCES, new Work(10)), (e: unknown) => e instanceof AnalysisLimit)
  const read = { ...blankEvmRead(IMPL), verified: { by: 'sourcify' as const, match: 'full' as const, repo: null, commit: null, compiler: 'v0.8.20' } }
  const rep = buildEvmReport('ethereum', { read, abiJson: [{ type: 'function', name: 'g', inputs: [], stateMutability: 'nonpayable' }], sources: [{ path: 'C.sol', text: y }], profile: null, deployBlock: null }, null, {
    ms: 1,
    rpcCalls: 1,
    registryCalls: 1,
    provenance: { lookup: () => null, repoCommit: () => undefined, stats: () => ({ repos: 0, files: 0, builtAt: null }) },
    dataset: { address: IMPL, before: null, verdict: 'kept', reason: 'x', added: false },
  })
  assert.match(rep.evm!.self.analysis ?? '', /not completed/)
  assert.deepEqual(rep.evm!.self.privileged, [])
  assert.equal(rep.summary.privileged, null)
  assert.equal(rep.summary.primitives, null)
})

function blankEvmRead(address: string): ChainRead {
  return {
    chain: 'ethereum',
    address,
    kind: 'contract',
    name: 'C',
    codeHash: 'cd'.repeat(32),
    upgradeable: false,
    upgradeAuthority: null,
    lastDeploySlot: null,
    programBytes: null,
    loader: null,
    idl: null,
    securityTxt: null,
    bytecodeBytes: 100,
    proxy: null,
    abi: null,
    verified: null,
    sources: [],
    notes: [],
    readAt: 1,
    rpcCalls: 1,
  }
}

const SOL_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
function solRead(notes: string[]): ChainRead {
  return {
    chain: 'solana',
    address: SOL_PROGRAM,
    kind: 'program',
    name: null,
    codeHash: 'ef'.repeat(32),
    upgradeable: false,
    upgradeAuthority: null,
    lastDeploySlot: 5,
    programBytes: 1000,
    loader: 'bpf-loader-2',
    idl: null,
    securityTxt: null,
    bytecodeBytes: null,
    proxy: null,
    abi: null,
    verified: null,
    sources: [],
    notes,
    readAt: 1,
    rpcCalls: 1,
  }
}

await test('OtterSec unavailable: verified is "unknown" (not "not verified"), cached one minute; no registry slice → 503 before any call', async () => {
  let t = Date.UTC(2026, 9, 6, 10)
  let reads = 0
  const { lens, store } = makeLens(tmp(), {
    now: () => t,
    readSolana: async () => {
      reads++
      return { read: solRead(['OtterSec status unavailable: daily registry budget used up']), idlJson: null }
    },
  })
  const a = await lens.read('solana', SOL_PROGRAM, '1.1.1.1')
  assert.equal(a.report.summary.verified, 'unknown')
  assert.equal(lens.recent()[0].verified, 'unknown')
  assert.equal(lens.recent()[0].name, null)
  assert.equal((await lens.read('solana', SOL_PROGRAM, '1.1.1.1')).cached, true)
  t += 61_000 // past the one-minute life of an "unknown" report (a normal one lives 15 minutes)
  assert.equal((await lens.read('solana', SOL_PROGRAM, '1.1.1.1')).cached, false)
  assert.equal(reads, 2)
  await store.close()
  // with no OtterSec slice left a Solana read is refused up front (nothing read, nothing charged)
  let called = 0
  const none = makeLens(tmp(), {
    limits: { budget: { solana: 100, 'solana-discovery': 0, ethereum: 10, base: 10, arbitrum: 10, sourcify: 10, osec: 0 } },
    readSolana: async () => {
      called++
      return { read: solRead([]), idlJson: null }
    },
  })
  const r = await none.lens.route(`/api/lens/solana/${SOL_PROGRAM}`, '1.1.1.1')
  assert.equal(r.status, 503)
  assert.match(JSON.parse(r.json).error, /osec/)
  assert.equal(called, 0)
  await none.store.close()
})

await test('detect: per-IP hourly cap; chains that answered (code or no code) are cached, only the rest asked again', async () => {
  const sh = sharedRpc()
  const { lens, store } = makeLens(tmp(), { rpc: sh.rpc, limits: { detectPerMin: 100, detectPerHour: 3 } })
  const empty = `0x${'34'.repeat(20)}`
  const d1 = await lens.detect(empty, '5.5.5.5')
  assert.deepEqual(d1.chains.map((c) => c.code), [false, false, false])
  const n = sh.calls.length
  await lens.detect(empty, '5.5.5.5') // cached negative answer: no call, no window hit
  assert.equal(sh.calls.length, n)
  await lens.detect(`0x${'35'.repeat(20)}`, '5.5.5.5')
  await lens.detect(`0x${'36'.repeat(20)}`, '5.5.5.5')
  await assert.rejects(lens.detect(`0x${'37'.repeat(20)}`, '5.5.5.5'), (e: unknown) => e instanceof LensError && e.status === 429)
  await store.close()
})

await test('fresh reads: a daily cap per IP', async () => {
  const sh = sharedRpc()
  const { lens, store } = makeLens(tmp(), { rpc: sh.rpc, limits: { freshPerMin: 100, freshPerHour: 100, freshPerDay: 2 } })
  await lens.read('ethereum', IMPL, '4.4.4.4')
  await lens.read('base', IMPL, '4.4.4.4')
  const r = await lens.route(`/api/lens/arbitrum/${IMPL}`, '4.4.4.4')
  assert.equal(r.status, 429)
  assert.match(JSON.parse(r.json).error, /today/)
  assert.equal((await lens.route(`/api/lens/arbitrum/${IMPL}`, '4.4.4.5')).status, 200)
  await store.close()
})

await test('SEPIA-1 handoff: Lens keeps per UTC day are capped; over the cap the verdict says so and nothing is stored', async () => {
  const dir = tmp()
  const sh = sharedRpc()
  const { lens, store, events } = makeLens(dir, { rpc: sh.rpc, limits: { keepPerDay: 0 } })
  const r = (await lens.read('ethereum', IMPL, '1.1.1.1')).report
  assert.equal(r.dataset.verdict, 'error')
  assert.match(r.dataset.reason, /passes the SEPIA-1 rules but was not stored: Lens has added its 0 items for today/)
  assert.equal(r.dataset.added, false)
  assert.equal(store.item('ethereum', IMPL), null)
  assert.equal(events.length, 0)
  // a rejected / not-stored read never puts its chosen name on the public strip
  assert.equal(lens.recent()[0].name, null)
  await store.close()
  // the count of today's keeps survives a restart
  const d2 = tmp()
  const one = makeLens(d2, { rpc: sharedRpc().rpc, limits: { keepPerDay: 1 } })
  assert.equal((await one.lens.read('ethereum', IMPL, '1.1.1.1')).report.dataset.added, true)
  assert.equal(one.lens.recent()[0].name, 'WETH9') // verified, kept, a plain name
  await one.store.close()
  const two = makeLens(d2, { rpc: sharedRpc().rpc, limits: { keepPerDay: 1 } })
  assert.deepEqual(two.lens.status().keeps, { items: 1, limit: 1 })
  await two.store.close()
})

await test('safeName: plain names only on the public strip', () => {
  assert.equal(safeName('FiatTokenV2_2'), 'FiatTokenV2_2')
  assert.equal(safeName('Uniswap V3: Factory'), 'Uniswap V3: Factory')
  for (const bad of ['Claim_at_ink-drop.xyz', 'visit https://x.io', 'www.free', 't.me/claim', '@admin', 'x'.repeat(49), 'a<b>', null, ''])
    assert.equal(safeName(bad as string | null), null, String(bad))
})

await test('budget slice: charged calls are on disk before they are made (a hard kill never lowers the count)', async () => {
  const dir = tmp()
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const rpc: RpcCtx = {
    ...sharedRpc().rpc,
    async call(chain, method, params) {
      await gate // the read hangs after its first charged call
      return sharedRpc().rpc.call(chain, method, params)
    },
  }
  const { lens, store } = makeLens(dir, { rpc })
  void lens.read('ethereum', IMPL, '1.1.1.1').catch(() => {})
  await new Promise((r) => setTimeout(r, 20))
  // "kill": a second instance reads the same files while the first read is still in flight
  const after = makeLens(dir, { rpc: sharedRpc().rpc })
  assert.ok(after.lens.status().budget.ethereum.used >= 1)
  release()
  await after.store.close()
  await store.close()
})

await test('repoCommitUrl: GitHub tree links; other https hosts as given; anything else no link', () => {
  assert.equal(repoCommitUrl('https://github.com/acme/vaults.git', 'abcdef1'), 'https://github.com/acme/vaults/tree/abcdef1')
  assert.equal(repoCommitUrl('acme/vaults', null), 'https://github.com/acme/vaults')
  assert.equal(repoCommitUrl('https://gitlab.com/acme/vaults', 'abcdef1'), 'https://gitlab.com/acme/vaults')
  assert.equal(repoCommitUrl('javascript:alert(1)', null), null)
})

await test('budget slice: at most a fair share of the day per clock hour, then a 503 that names the hour', async () => {
  let t = Date.UTC(2026, 9, 6, 10, 5)
  const sh = sharedRpc()
  const { lens, store } = makeLens(tmp(), { rpc: sh.rpc, now: () => t, limits: { hourShare: 0.5, budget: { solana: 10, 'solana-discovery': 0, ethereum: 8, base: 8, arbitrum: 8, sourcify: 100, osec: 100 } } })
  assert.equal((await lens.route(`/api/lens/ethereum/${IMPL}`, '1.1.1.1')).status, 200) // 1 call of the hour's 4
  const r = await lens.route(`/api/lens/ethereum/${PROXY}`, '1.1.1.2') // 3 calls: 4 of 4
  assert.equal(r.status, 200)
  const over = await lens.route(`/api/lens/ethereum/0x${'12'.repeat(20)}`, '1.1.1.3')
  assert.equal(over.status, 503)
  assert.match(JSON.parse(over.json).error, /this hour's share/)
  assert.ok(Number(over.headers?.['Retry-After']) <= 3600)
  t += 3_600_000 // next hour: the share is back, the day's count is not
  assert.equal((await lens.route(`/api/lens/ethereum/0x${'12'.repeat(20)}`, '1.1.1.3')).status, 200)
  assert.equal(lens.status().budget.ethereum.used, 5)
  await store.close()
})

console.log(`\n${passed} lens tests passed${process.exitCode ? ' — SOME FAILED' : ''}`)
