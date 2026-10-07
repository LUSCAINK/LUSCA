// READ THE BINARY tests: string and log-token extraction, Anchor discriminators and their search (lddw pairs in
// code, bytes in data), crate paths with redaction, framework detection, the dictionary (leave-one-out), the
// recovery end to end on a synthetic ELF, and the service: budget slice + shared floor, caching by code hash,
// routes. Run: npx tsx server/binary/_test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChainIndexItem, ChainRead } from '../../shared/chain.ts'
import { base58Decode } from '../../shared/base58.ts'
import { programAddresses, UPGRADEABLE_LOADER } from '../chain/solana/layout.ts'
import { Dictionary } from './dictionary.ts'
import {
  anchorDisc,
  countStrings,
  detectFramework,
  elfRegions,
  findDiscs,
  indexProbes,
  logTokens,
  parseCrates,
  prefixesOf,
  probeOf,
  programCrateOf,
  recoverInterface,
  restoreSectionTail,
  stripErrorSuffix,
  toSnakeCase,
  trimGlue,
} from './extract.ts'
import { checkAgainstIdl, createBinary, elfFromAccounts } from './index.ts'

let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

// ─── a synthetic SBF executable: ELF64 header, .text, .rodata, section headers ──────────────────────────

/** `lddw r1, imm64` (two 8-byte slots: low half in the first, high half in the second). */
function lddw(disc: Buffer): Buffer {
  const b = Buffer.alloc(16)
  b[0] = 0x18
  b[1] = 0x01
  disc.copy(b, 4, 0, 4)
  disc.copy(b, 12, 4, 8)
  return b
}

function makeElf(text: Buffer, rodata: Buffer): Buffer {
  const pad8 = (b: Buffer) => Buffer.concat([b, Buffer.alloc((8 - (b.length % 8)) % 8)])
  const t = pad8(text)
  const r = pad8(rodata)
  const textOff = 64
  const roOff = textOff + t.length
  const shoff = roOff + r.length
  const h = Buffer.alloc(64)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(h, 0)
  h.writeUInt16LE(3, 16) // ET_DYN
  h.writeUInt16LE(247, 18) // EM_BPF
  h.writeBigUInt64LE(BigInt(shoff), 0x28)
  h.writeUInt16LE(64, 0x34)
  h.writeUInt16LE(64, 0x3a)
  h.writeUInt16LE(3, 0x3c)
  const sh = (type: number, flags: number, off: number, size: number) => {
    const s = Buffer.alloc(64)
    s.writeUInt32LE(type, 4)
    s.writeBigUInt64LE(BigInt(flags), 8)
    s.writeBigUInt64LE(BigInt(off), 24)
    s.writeBigUInt64LE(BigInt(size), 32)
    return s
  }
  return Buffer.concat([h, t, r, Buffer.alloc(64), sh(1, 0x6, textOff, t.length), sh(1, 0x2, roOff, r.length)])
}

const g = (n: string) => anchorDisc('global', n)

// ─── names and discriminators ────────────────────────────────────────────────

await test('snake_case like Anchor / heck', () => {
  assert.equal(toSnakeCase('ClaimSocialFeePdaV2'), 'claim_social_fee_pda_v2')
  assert.equal(toSnakeCase('InitializeFeeConfig'), 'initialize_fee_config')
  assert.equal(toSnakeCase('claimFee'), 'claim_fee')
  assert.equal(toSnakeCase('HTTPServer'), 'http_server')
  assert.equal(toSnakeCase('set_v2_x'), 'set_v2_x')
  assert.equal(toSnakeCase('SetV2X'), 'set_v2_x')
})

await test('Anchor discriminators: sha256("global:initialize")[0..8] and account / event namespaces', () => {
  assert.deepEqual([...g('initialize')], [175, 175, 109, 31, 13, 152, 155, 237])
  assert.equal(anchorDisc('account', 'Pool').length, 8)
  assert.notDeepEqual(anchorDisc('account', 'Pool'), anchorDisc('event', 'Pool'))
})

await test('log tokens: a token followed by another log string is clean, a glued one is not', () => {
  const b = Buffer.from('xxInstruction: DepositInstruction: WithdrawAllanchor_data\0Instruction: Swap: \0Instruction: lower', 'latin1')
  assert.deepEqual(logTokens(b), [
    { text: 'Deposit', clean: true },
    { text: 'WithdrawAllanchor_data', clean: false },
    { text: 'Swap', clean: false },
  ])
})

await test('glue: error-name suffixes, known words and trailing words', () => {
  assert.equal(stripErrorSuffix('SetMaxDepositAccountNotAssociatedTokenAccount', () => false), 'SetMaxDeposit')
  assert.equal(stripErrorSuffix('UpdateConfigInvalidMode', (n) => n === 'InvalidMode'), 'UpdateConfig')
  assert.equal(stripErrorSuffix('UpdateConfig', () => true), 'Update') // only a dictionary name is cut
  const known = (w: string) => ['types', 'type', 'account'].includes(w)
  assert.deepEqual(trimGlue('LzReceiveTypesaccountauthority', known), ['LzReceiveTypes', 'LzReceiveType'])
  assert.deepEqual(trimGlue('IdlResizeAccountdata_len', known), ['IdlResizeAccount'])
  assert.deepEqual(trimGlue('Plain', known), ['Plain'])
  assert.deepEqual(prefixesOf('ClaimFeePdaV2ProgramError'), ['ClaimFeePdaV2ProgramError', 'ClaimFeePdaV2Program', 'ClaimFeePdaV2'])
})

await test('strings are counted, not kept', () => {
  assert.equal(countStrings(Buffer.from('abcdef\0ab\0ghijklmn\x01xyz', 'latin1')), 2)
})

await test('discriminator search: lddw pair in code, 8 bytes in data, nothing for a split or shifted value', async () => {
  const a = g('deposit')
  const c = g('withdraw')
  const x = g('swap')
  // swap: its halves in two unrelated instructions (not one lddw) → not found
  const swapSplit = Buffer.concat([Buffer.from([0x18, 1, 0, 0]), x.subarray(0, 4), Buffer.alloc(8), Buffer.from([0xb7, 1, 0, 0]), x.subarray(4, 8)])
  const elf = makeElf(Buffer.concat([lddw(a), Buffer.alloc(8), swapSplit]), Buffer.concat([Buffer.from('padding!'), c, Buffer.from('tail')]))
  const regions = elfRegions(elf)
  assert.equal(regions.parsed, true)
  const ix = indexProbes([probeOf('g:deposit', a), probeOf('g:withdraw', c), probeOf('g:swap', x)])
  const found = await findDiscs(elf, regions, [ix])
  assert.equal(found.get('g:deposit'), 'code')
  assert.equal(found.get('g:withdraw'), 'data')
  assert.equal(found.has('g:swap'), false)
})

await test('section headers whose zero tail was trimmed (code hash rule) are read', async () => {
  const elf = makeElf(lddw(g('deposit')), Buffer.from('rodata!!'))
  let end = elf.length
  while (end > 0 && elf[end - 1] === 0) end--
  const trimmed = elf.subarray(0, end)
  assert.ok(trimmed.length < elf.length)
  assert.equal(elfRegions(trimmed).parsed, false)
  assert.equal(elfRegions(restoreSectionTail(trimmed)).parsed, true)
  const r = await recoverInterface(trimmed, new Dictionary())
  assert.deepEqual(r.notes, [])
})

await test('not an ELF: the whole file is scanned both ways', async () => {
  const b = Buffer.concat([Buffer.from('garbage!'), g('deposit')])
  const r = elfRegions(b)
  assert.equal(r.parsed, false)
  const found = await findDiscs(b, r, [indexProbes([probeOf('g:deposit', g('deposit'))])])
  assert.equal(found.get('g:deposit'), 'data')
})

// ─── crates, program crate, framework ────────────────────────────────────────

await test('crate paths → crate name + version only; home directories and user names never come out', () => {
  const text =
    'panicked/home/alice/.cargo/registry/src/index.crates.io-6f17d22bba15001f/anchor-lang-0.29.0/src/lib.rs' +
    'C:\\Users\\bob\\.cargo\\registry\\src\\index.crates.io-1949cf8c6b5b557f\\spl-token-4.0.0\\src\\state.rs' +
    '/Users/carol/vendor/borsh-1.5.1-alpha.2/src/de.rs/x/hashbrown-0.15.4/src/raw/mod.rs/not-a-crate/src/x.rs'
  const crates = parseCrates(text)
  assert.deepEqual(crates, [
    { name: 'anchor-lang', version: '0.29.0' },
    { name: 'borsh', version: '1.5.1-alpha.2' },
    { name: 'hashbrown', version: '0.15.4' },
    { name: 'spl-token', version: '4.0.0' },
  ])
  const out = JSON.stringify(crates)
  for (const leak of ['alice', 'bob', 'carol', 'home', 'Users', 'cargo', 'registry', 'index.crates', '6f17d22b', '/', '\\']) assert.ok(!out.includes(leak), leak)
})

await test('program crate: from relative workspace paths; a directory of an absolute path is never taken', () => {
  assert.equal(programCrateOf('\0programs/pump-fees/src/lib.rs\0programs/pump-fees/src/state.rs', []), 'pump-fees')
  assert.equal(programCrateOf('\0solg-staking/src/lib.rs\0solg-staking/src/math.rs', []), 'solg-staking')
  // /home/alice/src/… : "alice" is a user name, not a crate
  assert.equal(programCrateOf('\0/home/alice/src/main.rs\0/home/alice/src/lib.rs\0/home/alice/src/x.rs', []), null)
  assert.equal(programCrateOf('\0C:\\Users\\dave\\src\\main.rs\0C:\\Users\\dave\\src\\lib.rs', []), null)
  // registry crates are not the program's own
  assert.equal(programCrateOf('/registry/src/idx/anchor-lang-0.29.0/src/a.rs', [{ name: 'anchor-lang', version: '0.29.0' }]), null)
})

await test('framework: Anchor from its error-log string or crate; steel / pinocchio / native from crates', () => {
  assert.deepEqual(detectFramework('xxAnchorError occurred. Error Code: ', []).name, 'anchor')
  assert.equal(detectFramework('', [{ name: 'anchor-lang', version: '0.30.1' }]).version, '0.30.1')
  assert.equal(detectFramework('', [{ name: 'steel', version: '2.1.0' }]).name, 'steel')
  assert.equal(detectFramework('', [{ name: 'pinocchio', version: '0.8.1' }]).name, 'pinocchio')
  assert.equal(detectFramework('', [{ name: 'solana-program', version: '1.18.26' }]).name, 'native')
  assert.equal(detectFramework('nothing', []).name, 'unknown')
})

// ─── dictionary ──────────────────────────────────────────────────────────────

const IDL_A = {
  address: 'AAAA',
  metadata: { name: 'a', version: '0.1.0', spec: '0.1.0' },
  instructions: [
    { name: 'deposit', discriminator: [...g('deposit')], accounts: [], args: [] },
    { name: 'route', discriminator: [...g('route')], accounts: [], args: [] },
  ],
  accounts: [{ name: 'Pool', discriminator: [...anchorDisc('account', 'Pool')] }],
  events: [{ name: 'Swapped', discriminator: [...anchorDisc('event', 'Swapped')] }],
  errors: [
    { code: 6000, name: 'MathOverflow', msg: 'Math overflow in fee calculation' },
    { code: 6001, name: 'Short', msg: 'Too short' },
    { code: 100, name: 'InstructionMissing', msg: 'Builtin message that is long enough' },
  ],
}
const IDL_B_LEGACY = {
  version: '0.1.0',
  name: 'b',
  instructions: [{ name: 'claimReward', accounts: [], args: [] }, { name: 'deposit', accounts: [], args: [] }],
  accounts: [{ name: 'Vault', type: { kind: 'struct', fields: [] } }],
  errors: [{ code: 6000, name: 'MathOverflow', msg: 'Math overflow in fee calculation' }],
}
const PROG_A = '11111111111111111111111111111112'
const PROG_B = 'SysvarRent111111111111111111111111111111111'

function dictionary() {
  const d = new Dictionary()
  assert.equal(d.addIdl(PROG_A, IDL_A), true)
  assert.equal(d.addIdl(PROG_B, IDL_B_LEGACY), true)
  assert.equal(d.addIdl(PROG_B, IDL_B_LEGACY), false)
  assert.equal(d.addIdl('x', { not: 'an idl' }), false)
  return d
}

await test('dictionary: Anchor 0.30 + legacy IDLs, counts, short and built-in error messages left out', () => {
  const d = dictionary()
  assert.deepEqual(d.counts(), { idls: 2, instructions: 3, accounts: 2, events: 1, errors: 1 })
  assert.equal(d.entry('g:deposit')!.idls, 2)
  assert.equal(d.entry('g:claim_reward')!.idls, 1)
  assert.deepEqual(d.entry('g:claim_reward')!.disc, g('claim_reward'))
  assert.equal(d.error('Math overflow in fee calculation')!.idls, 2)
  assert.equal(d.error('Math overflow in fee calculation')!.name, 'MathOverflow')
  assert.equal(d.knownErrorName('MathOverflow'), true)
})

// ─── recovery end to end ─────────────────────────────────────────────────────

/**
 * A program with: Deposit (clean log + lddw), ClaimFeeV2 (glued log "ClaimFeeV2Program…" + lddw), Close (log only),
 * the discriminator of `route` (another program's instruction) in data, account Pool + Vault in code, event
 * Swapped in data, one known error message, an anchor-lang crate path and Anchor's error-log string.
 */
function sampleElf() {
  const text = Buffer.concat([lddw(g('deposit')), lddw(g('claim_fee_v2')), lddw(anchorDisc('account', 'Pool')), lddw(anchorDisc('account', 'Vault'))])
  const ro = Buffer.concat([
    Buffer.from('Instruction: DepositInstruction: ClaimFeeV2ProgramErrorInstruction: Close\0', 'latin1'),
    Buffer.from('AnchorError occurred. Error Code: Math overflow in fee calculationToo short\0', 'latin1'),
    Buffer.from('/home/zqxuser/.cargo/registry/src/index.crates.io-6f17d22bba15001f/anchor-lang-0.29.0/src/lib.rs\0programs/sample-prog/src/lib.rs\0programs/sample-prog/src/x.rs\0', 'latin1'),
    g('route'),
    anchorDisc('event', 'Swapped'),
  ])
  return makeElf(text, ro)
}

await test('recovery: log + discriminator, glued names cut back, log-only, calls, accounts, events, errors, crates', async () => {
  const d = dictionary()
  const r = await recoverInterface(sampleElf(), d)
  assert.deepEqual(
    r.instructions.map((i) => [i.name, i.evidence]),
    [
      ['claim_fee_v2', 'log+disc'],
      ['deposit', 'log+disc'],
      ['close', 'log'],
    ],
  )
  assert.equal(r.instructions[0].logName, 'ClaimFeeV2')
  assert.equal(r.instructions[0].site, 'code')
  assert.deepEqual(
    r.calls.map((c) => [c.name, c.site, c.programs]),
    [['route', 'data', [PROG_A]]],
  )
  assert.deepEqual(r.accounts.map((a) => a.name), ['Pool', 'Vault'])
  assert.deepEqual(r.events.map((a) => a.name), ['Swapped'])
  assert.deepEqual(r.errors.map((e) => [e.name, e.msg, e.idls]), [['MathOverflow', 'Math overflow in fee calculation', 2]])
  assert.equal(r.framework.name, 'anchor')
  assert.equal(r.framework.version, '0.29.0')
  assert.deepEqual(r.crates, [{ name: 'anchor-lang', version: '0.29.0' }])
  assert.equal(r.programCrate, 'sample-prog')
  assert.ok(!JSON.stringify(r).includes('zqxuser'), 'no user name in the result')
  assert.deepEqual(r.learned.sort(), ['ClaimFeeV2', 'Deposit'])
})

await test('leave-one-out: a name only the excluded program defines is not used', async () => {
  const d = dictionary()
  // PROG_B is the only IDL defining Vault; PROG_A the only one defining route
  const r = await recoverInterface(sampleElf(), d, { exclude: PROG_B })
  assert.deepEqual(r.accounts.map((a) => a.name), ['Pool'])
  assert.equal(r.errors[0].idls, 1)
  const r2 = await recoverInterface(sampleElf(), d, { exclude: PROG_A })
  assert.deepEqual(r2.calls, [])
  assert.deepEqual(r2.accounts.map((a) => a.name), ['Vault'])
  assert.equal(r2.events.length, 0)
})

await test('blind check: names scored against the IDL; confirmed names it lacks are counted apart', () => {
  const c = checkAgainstIdl(
    {
      instructions: [
        { name: 'deposit', evidence: 'log+disc' },
        { name: 'claim_reward', evidence: 'log' },
        { name: 'new_thing', evidence: 'log+disc' },
        { name: 'glued_wrong', evidence: 'log' },
      ],
      accounts: [{ name: 'Pool', disc: '00', site: 'code', idls: 1 }],
    },
    { instructions: [{ name: 'deposit' }, { name: 'claimReward' }, { name: 'withdraw' }], accounts: ['Pool', 'Vault'] },
  )
  assert.deepEqual(c, { idlInstructions: 3, recovered: 4, hit: 2, newerThanIdl: 1, newerNames: ['new_thing'], idlAccounts: 2, accountsHit: 1 })
})

// ─── the service ─────────────────────────────────────────────────────────────

function account(owner: string, data: Buffer, executable = false) {
  return { owner, executable, lamports: 1, space: data.length, data: [data.toString('base64'), 'base64'] }
}

function programAccounts(program: string, elf: Buffer) {
  const pd = programAddresses(program).programData
  const p = Buffer.alloc(36)
  p.writeUInt32LE(2, 0)
  Buffer.from(base58Decode(pd)!).copy(p, 4)
  const d = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.alloc(8), Buffer.from([0]), Buffer.alloc(32), elf, Buffer.alloc(64)])
  return [account(UPGRADEABLE_LOADER, p, true), account(UPGRADEABLE_LOADER, d)]
}

await test('elfFromAccounts: upgradeable program → its programdata executable; closed / not a program → why', async () => {
  const elf = sampleElf()
  const r = await elfFromAccounts(PROG_A, programAccounts(PROG_A, elf))
  assert.ok(r.elf && Buffer.from(r.elf).subarray(0, elf.length).equals(elf))
  assert.equal((await elfFromAccounts(PROG_A, [null, null])).why, 'no account at this address')
  const [p] = programAccounts(PROG_A, elf)
  assert.match((await elfFromAccounts(PROG_A, [p, null])).why ?? '', /closed/)
  assert.match((await elfFromAccounts(PROG_A, [account('11111111111111111111111111111111', Buffer.alloc(10)), null])).why ?? '', /not a program/)
})

function fakeStore(items: ChainIndexItem[], idls: Record<string, unknown>) {
  return {
    items: () => ({ items, next: null }),
    item: (_c: unknown, a: string) => {
      const it = items.find((x) => x.address === a)
      return it ? { item: it, read: { idl: null } as unknown as ChainRead } : null
    },
    record: (_c: unknown, a: string) => (idls[a] ? ({ idl: idls[a] } as never) : null),
  }
}

const item = (address: string, idl: boolean, name: string | null = null): ChainIndexItem => ({
  chain: 'solana',
  address,
  name,
  kind: 'program',
  via: 'block',
  verifiedBy: 'osec',
  idl,
  sourceFiles: 0,
  sourceBytes: 0,
  codeHash: null,
  firstSeen: 1,
  readAt: 1,
})

const NOIDL_1 = 'Stake11111111111111111111111111111111111111'
const NOIDL_2 = 'Vote111111111111111111111111111111111111111'
const NOIDL_3 = 'Config1111111111111111111111111111111111111'

function fakeRpc(o: { shared?: { used: number; limit: number }; elfs: Record<string, Buffer> }) {
  const calls: string[] = []
  return {
    calls,
    rpc: {
      async call(_chain: string, method: string, params: unknown[]) {
        assert.equal(method, 'getMultipleAccounts')
        const keys = params[0] as string[]
        calls.push(keys[0])
        const elf = o.elfs[keys[0]]
        return { value: elf ? programAccounts(keys[0], elf) : [null, null] }
      },
      fetchJson: async () => ({}),
      usage: () => ({ solana: o.shared ?? { used: 0, limit: 8000 } }),
      canSpend: () => true,
    },
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-binary-'))

await test('service: background reads stop at the daily slice (no call is made past it)', async () => {
  const dir = tmp()
  const f = fakeRpc({ elfs: { [NOIDL_1]: sampleElf(), [NOIDL_2]: makeElf(lddw(g('deposit')), Buffer.from('Instruction: Deposit\0')), [NOIDL_3]: sampleElf() } })
  const b = createBinary({ rpc: f.rpc as never, store: fakeStore([item(NOIDL_1, false, 'one'), item(NOIDL_2, false), item(NOIDL_3, false)], { [PROG_A]: IDL_A }), feed: () => [], dataDir: dir, log: () => {}, limits: { solCalls: 2, hourShare: 1 } })
  await b.sweep()
  assert.equal(await b.tick(), 'read')
  assert.equal(await b.tick(), 'read')
  assert.equal(await b.tick(), 'budget')
  assert.equal(f.calls.length, 2)
  const s = b.summary()
  assert.equal(s.reader.used, 2)
  assert.equal(s.withoutIdl, 3)
  // NOIDL_1 and NOIDL_3 share one executable: one result per code hash
  assert.equal(s.processed, 2)
  await b.stop()
  // the slice survives a restart (write-ahead)
  const b2 = createBinary({ rpc: f.rpc as never, store: fakeStore([], {}), feed: () => [], dataDir: dir, log: () => {}, limits: { solCalls: 2, hourShare: 1 } })
  await b2.sweep()
  assert.equal(await b2.tick(), 'budget')
  assert.equal(f.calls.length, 2)
  assert.equal(b2.summary().processed, 2, 'results restored from results.jsonl')
  await b2.stop()
})

await test('service: never below the floor of the shared Solana budget', async () => {
  const f = fakeRpc({ shared: { used: 7201, limit: 8000 }, elfs: { [NOIDL_1]: sampleElf() } })
  const b = createBinary({ rpc: f.rpc as never, store: fakeStore([item(NOIDL_1, false)], {}), feed: () => [], dataDir: tmp(), log: () => {}, limits: { hourShare: 1 } })
  await b.sweep()
  assert.equal(await b.tick(), 'budget')
  assert.equal(f.calls.length, 0)
  await b.stop()
})

await test('service: hourly share of the slice', async () => {
  const f = fakeRpc({ elfs: { [NOIDL_1]: sampleElf(), [NOIDL_2]: makeElf(lddw(g('deposit')), Buffer.from('Instruction: Deposit\0')) } })
  const b = createBinary({ rpc: f.rpc as never, store: fakeStore([item(NOIDL_1, false), item(NOIDL_2, false)], {}), feed: () => [], dataDir: tmp(), log: () => {}, limits: { solCalls: 3, hourShare: 0.3 } })
  await b.sweep()
  assert.equal(await b.tick(), 'read')
  assert.equal(await b.tick(), 'budget') // ceil(3 × 0.3) = 1 call this hour
  assert.equal(f.calls.length, 1)
  await b.stop()
})

const readOf = (address: string, codeHash: string, idl: ChainRead['idl'] = null): ChainRead =>
  ({ chain: 'solana', address, kind: 'program', name: null, codeHash, idl, securityTxt: null }) as unknown as ChainRead

await test('service: executables handed over are recovered once per code hash, again when the code changes', async () => {
  const f = fakeRpc({ elfs: {} })
  const dir = tmp()
  const b = createBinary({ rpc: f.rpc as never, store: fakeStore([], { [PROG_A]: IDL_A }), feed: () => [], dataDir: dir, log: () => {} })
  await b.sweep()
  b.offer(readOf(NOIDL_1, 'h1'), sampleElf(), 'agent')
  await b.idle()
  const first = b.get(NOIDL_1)!
  assert.equal(first.codeHash, 'h1')
  assert.equal(first.via, 'agent')
  b.offer(readOf(NOIDL_1, 'h1'), sampleElf(), 'agent')
  await b.idle()
  assert.equal(b.get(NOIDL_1)!.readAt, first.readAt, 'same code hash: not read again')
  // an upgrade: new code hash → read again (the radar hands it over)
  b.offer(readOf(NOIDL_1, 'h2'), makeElf(lddw(g('deposit')), Buffer.from('Instruction: Deposit\0')), 'radar')
  await b.idle()
  const second = b.get(NOIDL_1)!
  assert.equal(second.codeHash, 'h2')
  assert.equal(second.via, 'radar')
  assert.deepEqual(second.instructions.map((i) => i.name), ['deposit'])
  // the background reader skips it: its code hash has a result
  assert.equal(await b.tick(), 'none')
  assert.equal(f.calls.length, 0)
  // one result per program: the pre-upgrade code is dropped (in memory and after a restart)
  assert.equal(b.summary().processed, 1)
  await b.stop()
  const b2 = createBinary({ rpc: f.rpc as never, store: fakeStore([], { [PROG_A]: IDL_A }), feed: () => [], dataDir: dir, log: () => {} })
  await b2.sweep()
  assert.equal(b2.get(NOIDL_1)!.codeHash, 'h2')
  assert.equal(b2.summary().processed, 1, 'superseded line not restored')
  await b2.stop()
})

await test('service: results stop at their size cap (no recovery, no read, nothing kept in memory)', async () => {
  const f = fakeRpc({ elfs: { [NOIDL_2]: sampleElf() } })
  const dir = tmp()
  const b = createBinary({ rpc: f.rpc as never, store: fakeStore([item(NOIDL_2, false)], {}), feed: () => [], dataDir: dir, log: () => {}, limits: { maxResultsMb: 0.001, hourShare: 1 } })
  await b.sweep()
  b.offer(readOf(NOIDL_1, 'h1'), sampleElf(), 'agent')
  await b.idle()
  assert.ok(b.get(NOIDL_1), 'first result fits under the cap')
  b.offer(readOf(NOIDL_3, 'h9'), makeElf(lddw(g('deposit')), Buffer.from('Instruction: Deposit\0')), 'agent')
  await b.idle()
  assert.equal(b.get(NOIDL_3), null, 'over the cap: not kept')
  assert.equal(await b.tick(), 'none')
  assert.equal(f.calls.length, 0, 'over the cap: no RPC')
  await b.stop()
})

await test('service: programs with an IDL are checked blind against it', async () => {
  const f = fakeRpc({ elfs: {} })
  const b = createBinary({ rpc: f.rpc as never, store: fakeStore([item(PROG_A, true, 'a')], { [PROG_A]: IDL_A }), feed: () => [], dataDir: tmp(), log: () => {} })
  await b.sweep()
  const idl = { name: 'p', version: null, instructions: [{ name: 'deposit', args: 0, accounts: 0 }, { name: 'claimFeeV2', args: 0, accounts: 0 }, { name: 'withdraw', args: 0, accounts: 0 }], accounts: ['Pool'], types: 0, errors: 0, events: 0 }
  b.offer(readOf(PROG_B, 'h3', idl), sampleElf(), 'agent')
  await b.idle()
  const r = b.get(PROG_B)!
  assert.deepEqual(r.check, { idlInstructions: 3, recovered: 3, hit: 2, newerThanIdl: 0, newerNames: [], idlAccounts: 1, accountsHit: 1 })
  const s = b.summary()
  assert.equal(s.check!.programs, 1)
  assert.equal(s.check!.recall, 0.667)
  assert.equal(s.dictionary.idls, 1)
  assert.equal(s.processed, 0, 'programs with an IDL are not in the census of programs without one')
  await b.stop()
})

await test('routes: summary, items with filters, one program, 404 and 400', async () => {
  const dir = tmp()
  const f = fakeRpc({ elfs: {} })
  const b = createBinary({ rpc: f.rpc as never, store: fakeStore([], { [PROG_A]: IDL_A }), feed: () => [], dataDir: dir, log: () => {} })
  await b.sweep()
  b.offer(readOf(NOIDL_1, 'h1'), sampleElf(), 'agent')
  await b.idle()
  const q = (p: string, s = '') => b.route(p, new URLSearchParams(s))
  const sum = JSON.parse(q('/api/binary/summary').json)
  assert.equal(sum.processed, 1)
  assert.equal(sum.featured, NOIDL_1)
  assert.equal(sum.instructions, 3)
  assert.equal(sum.confirmed, 2)
  assert.deepEqual(sum.frameworks, [{ name: 'anchor', count: 1 }])
  const page = JSON.parse(q('/api/binary/items', 'framework=anchor').json)
  assert.equal(page.total, 1)
  assert.equal(page.items[0].confirmed, 2)
  assert.equal(JSON.parse(q('/api/binary/items', 'framework=native').json).total, 0)
  assert.equal(q('/api/binary/items', 'framework=evil').status, 400)
  assert.equal(q('/api/binary/items', 'cursor=abc').status, 400)
  assert.equal(q('/api/binary/items', 'limit=0').status, 400)
  assert.equal(JSON.parse(q(`/api/binary/${NOIDL_1}`).json).address, NOIDL_1)
  assert.equal(q(`/api/binary/${NOIDL_2}`).status, 404)
  assert.equal(q('/api/binary/not-an-address').status, 404)
  // nothing but results on disk: no executable bytes
  const files = fs.readdirSync(path.join(dir, 'binary'))
  assert.deepEqual(files.filter((x) => !['results.jsonl', 'programs.json', 'budget.json'].includes(x)), [])
  const text = fs.readFileSync(path.join(dir, 'binary', 'results.jsonl'), 'utf8')
  assert.ok(!text.includes('ELF') && text.length < 20_000)
  await b.stop()
})

await test('error messages found in most executables (framework / runtime strings) are left out of answers', async () => {
  const b = createBinary({ rpc: fakeRpc({ elfs: {} }).rpc as never, store: fakeStore([item(PROG_A, true)], { [PROG_A]: IDL_A }), feed: () => [], dataDir: tmp(), log: () => {} })
  await b.sweep()
  const addrs = ['Stake11111111111111111111111111111111111111', 'Vote111111111111111111111111111111111111111', 'Config1111111111111111111111111111111111111']
  b.offer(readOf(addrs[0], 'c0'), sampleElf(), 'agent')
  await b.idle()
  assert.equal(b.get(addrs[0])!.errors.length, 1, 'one executable: the message is its own')
  for (let i = 1; i < 9; i++) {
    b.offer(readOf(i < 3 ? addrs[i] : `${'Sysvar'.padEnd(43 - String(i).length, '1')}${i}`.slice(0, 43), `c${i}`), sampleElf(), 'agent')
    await b.idle()
  }
  const r = b.get(addrs[0])!
  assert.equal(r.errors.length, 0)
  assert.ok(r.notes.some((n) => /found in most executables/.test(n)))
  await b.stop()
})

console.log(`binary: ${passed} tests passed`)
