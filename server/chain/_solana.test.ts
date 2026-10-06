// Solana reader tests: accounts recorded from mainnet (_solana.fixtures.json: program accounts,
// programdata headers, Anchor 0.29 / 0.30 IDL accounts, a USDC mint, a native program, the Whirlpool
// security.txt, OtterSec responses) around stand-in executables, a fake RpcCtx, no network.
//   npx tsx server/chain/_solana.test.ts
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'
import { base58Decode, base58Encode } from '../../shared/base58.ts'
import { BudgetError, RpcError, type RpcCtx } from './rpc.ts'
import { OSEC_UNAVAILABLE, readSolana } from './solana.ts'
import {
  LOADER_V4,
  NATIVE_LOADER,
  PROGRAM_METADATA_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  UPGRADEABLE_LOADER,
  decodeAccount,
  parseLoaderV4,
  parseMint,
  parseUpgradeable,
  programAddresses,
} from './solana/layout.ts'
import { codeHashOf, parseSecurityTxt, trimTrailingZeros } from './solana/elf.ts'
import { decodeAnchorIdlAccount, decodeMetadataIdlAccount, idlFormat, summarizeIdl, IdlError, ANCHOR_IDL_DISCRIMINATOR } from './solana/idl.ts'
import { normalizeRepoUrl, parseOsecStatus } from './solana/osec.ts'

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

// ─── fixtures ────────────────────────────────────────────────────────────────

interface RecAccount {
  owner: string
  executable: boolean
  lamports: number
  space: number
  data: string
}
interface Fixtures {
  slot: number
  accounts: Record<string, RecAccount>
  programDataHeaders: Record<string, { address: string; space: number; header: string }>
  whirlpoolSecurityTxt: string
  memoLegacy: { owner: string; executable: boolean; lamports: number; space: number; elfHead: string }
  osec: Record<string, unknown>
}
const FX = JSON.parse(readFileSync(new URL('./_solana.fixtures.json', import.meta.url), 'utf8')) as Fixtures

const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const MAR = 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD'
const WHIRL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
const PHOENIX = 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY'
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const VOTE = 'Vote111111111111111111111111111111111111111'
const SYSTEM = '11111111111111111111111111111111'

interface Acct {
  owner: string
  executable: boolean
  lamports: number
  space: number
  data: Buffer
}
const rec = (a: RecAccount): Acct => ({ ...a, data: Buffer.from(a.data, 'base64') })
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const key = (addr: string) => Buffer.from(base58Decode(addr)!)
const fresh = (n: number) => base58Encode(createHash('sha256').update(`lusca-test-${n}`).digest())

/** Deterministic stand-in executable: ELF magic, pseudo-random body, optional insert, non-zero last byte. */
function standInElf(seed: number, size: number, insert?: Buffer): Buffer {
  const b = Buffer.alloc(size)
  let s = seed
  for (let i = 0; i < size; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    b[i] = (s >>> 16) & 0xff
  }
  b.set([0x7f, 0x45, 0x4c, 0x46], 0)
  if (insert) insert.copy(b, Math.floor(size / 3))
  b[size - 1] = 0x5a
  return b
}

/** Recorded programdata header + a stand-in ELF + zero padding (as allocated on-chain). */
function programData(program: string, elf: Buffer, pad = 4096): { address: string; acct: Acct } {
  const h = FX.programDataHeaders[program]
  const data = Buffer.concat([Buffer.from(h.header, 'base64'), elf, Buffer.alloc(pad)])
  return { address: h.address, acct: { owner: UPGRADEABLE_LOADER, executable: false, lamports: 1, space: data.length, data } }
}

function programAccount(programDataAddr: string): Acct {
  const data = Buffer.alloc(36)
  data.writeUInt32LE(2, 0)
  key(programDataAddr).copy(data, 4)
  return { owner: UPGRADEABLE_LOADER, executable: true, lamports: 1, space: 36, data }
}

function metadataAccount(program: string, json: unknown, o: { format?: number; compression?: 0 | 1 | 2; source?: number; canonical?: boolean; encoding?: number } = {}): Acct {
  const raw = Buffer.from(typeof json === 'string' ? json : JSON.stringify(json))
  const compression = o.compression ?? 2
  const body = compression === 2 ? zlib.deflateSync(raw) : compression === 1 ? zlib.gzipSync(raw) : raw
  const h = Buffer.alloc(96)
  h[0] = 2
  key(program).copy(h, 1)
  h[65] = 1
  h[66] = o.canonical === false ? 0 : 1
  h.write('idl', 67)
  h[83] = o.encoding ?? 1
  h[84] = compression
  h[85] = o.format ?? 1
  h[86] = o.source ?? 0
  h.writeUInt32LE(body.length, 87)
  const data = Buffer.concat([h, body])
  return { owner: PROGRAM_METADATA_PROGRAM, executable: false, lamports: 1, space: data.length, data }
}

function anchorIdlAccount(program: string, json: unknown): Acct {
  const z = zlib.deflateSync(Buffer.from(JSON.stringify(json)))
  const data = Buffer.alloc(44 + z.length)
  ANCHOR_IDL_DISCRIMINATOR.copy(data, 0)
  data.writeUInt32LE(z.length, 40)
  z.copy(data, 44)
  return { owner: program, executable: false, lamports: 1, space: data.length, data }
}

const NOT_VERIFIED = {
  is_verified: false,
  message: 'On chain program not verified',
  on_chain_hash: '',
  executable_hash: '',
  repo_url: '',
  commit: '',
  last_verified_at: null,
  is_frozen: false,
  is_closed: false,
}

interface Fake {
  ctx: RpcCtx
  calls: { keys: string[]; encoding: string }[]
  urls: string[]
}
function fakeCtx(accounts: Map<string, Acct>, o: { osec?: Record<string, unknown>; osecError?: Error; callError?: Error; rejectZstd?: boolean } = {}): Fake {
  const calls: Fake['calls'] = []
  const urls: string[] = []
  const ctx: RpcCtx = {
    async call(chain, method, params) {
      if (o.callError) throw o.callError
      assert.equal(chain, 'solana')
      assert.equal(method, 'getMultipleAccounts')
      const [keys, cfg] = params as [string[], { encoding: string; commitment: string }]
      calls.push({ keys, encoding: cfg.encoding })
      if (o.rejectZstd && cfg.encoding === 'base64+zstd') {
        throw new RpcError('rpc', 'solana rpc getMultipleAccounts: Invalid params: unknown variant `base64+zstd` (-32602)', { code: -32602 })
      }
      return {
        context: { slot: FX.slot },
        value: keys.map((k) => {
          const a = accounts.get(k)
          if (!a) return null
          const data = cfg.encoding === 'base64+zstd' ? zlib.zstdCompressSync(a.data) : a.data
          return { owner: a.owner, executable: a.executable, lamports: a.lamports, space: a.space, rentEpoch: 0, data: [data.toString('base64'), cfg.encoding] }
        }),
      }
    },
    async fetchJson(url, opts) {
      urls.push(url)
      assert.equal(opts?.host, 'osec')
      if (o.osecError) throw o.osecError
      const pid = decodeURIComponent(url.split('/').pop() ?? '')
      return o.osec?.[pid] ?? FX.osec[pid] ?? NOT_VERIFIED
    },
    usage: () => ({}),
    canSpend: () => true,
  }
  return { ctx, calls, urls }
}

/** Accounts of a recorded upgradeable program (program + IDL accounts as recorded) with a stand-in ELF. */
function recordedProgram(program: string, elf: Buffer, extra: [string, Acct][] = []): Map<string, Acct> {
  const pd = programData(program, elf)
  const m = new Map<string, Acct>([
    [program, rec(FX.accounts[program])],
    [pd.address, pd.acct],
  ])
  const d = programAddresses(program)
  if (FX.accounts[d.anchorIdl]) m.set(d.anchorIdl, rec(FX.accounts[d.anchorIdl]))
  for (const [k, v] of extra) m.set(k, v)
  return m
}

// ─── derived addresses ───────────────────────────────────────────────────────

await test('derived addresses match the recorded programdata / IDL accounts', () => {
  const j = programAddresses(JUP)
  assert.equal(j.programData, '4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT')
  assert.equal(j.anchorIdl, 'C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa')
  assert.equal(j.metadataIdl, 'FDDfotwLyeLhUQ62ugzgTjwTvF3r64tPRVsKwsqRrbbC')
  for (const p of [JUP, MAR, WHIRL]) {
    assert.equal(programAddresses(p).programData, FX.programDataHeaders[p].address)
    // the recorded program account points at the same programdata address
    const st = parseUpgradeable(rec(FX.accounts[p]).data)
    assert.deepEqual(st, { type: 'program', programData: FX.programDataHeaders[p].address })
  }
  assert.ok(FX.accounts[programAddresses(MAR).anchorIdl], 'Marinade IDL account recorded at the derived address')
})

// ─── upgradeable program + security.txt ──────────────────────────────────────

await test('upgradeable program: deploy slot, authority, code hash, security.txt, OtterSec record without a completed build', async () => {
  const sec = Buffer.from(FX.whirlpoolSecurityTxt, 'base64')
  const elf = standInElf(1, 200_000, sec)
  const accounts = recordedProgram(WHIRL, elf)
  const f = fakeCtx(accounts)
  const { read, idlJson } = await readSolana(WHIRL, f.ctx)
  assert.equal(read.chain, 'solana')
  assert.equal(read.address, WHIRL)
  assert.equal(read.kind, 'program')
  assert.equal(read.loader, 'bpf-upgradeable')
  assert.equal(read.lastDeploySlot, 440170207)
  assert.equal(read.upgradeAuthority, 'GwH3Hiv5mACLX3ufTw1pFsrhSPon5tdw252DBs4Rx4PV')
  assert.equal(read.upgradeable, true)
  assert.equal(read.programBytes, elf.length, 'zero padding trimmed')
  assert.equal(read.codeHash, sha(elf))
  assert.deepEqual(read.securityTxt, {
    name: 'Orca Whirlpool program',
    project_url: 'https://orca.so',
    contacts: 'discord:https://discord.orca.so/,twitter:https://twitter.com/orca_so',
    policy: 'https://immunefi.com/bounty/orca/',
    source_code: 'https://github.com/orca-so/whirlpools',
  })
  assert.equal(read.name, 'Orca Whirlpool program', 'name from security.txt')
  assert.equal(read.idl, null)
  assert.equal(idlJson, null)
  // OtterSec has a record for the repo whose build never finished: not verified, and no claim that it differs
  assert.equal(read.verified, null)
  assert.ok(read.notes.some((n) => n === 'OtterSec has a build record for https://github.com/orca-so/whirlpools, not verified (no completed build)'), read.notes.join(' / '))
  assert.ok(!read.notes.some((n) => /does not match/.test(n)))
  assert.equal(read.rpcCalls, 1)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].encoding, 'base64+zstd')
  assert.equal(f.calls[0].keys.length, 4, 'program, programdata, Anchor IDL, program-metadata IDL in one call')
  assert.deepEqual(f.urls, [`https://verify.osec.io/status/${WHIRL}`])
  assert.deepEqual(read.sources, [])
  assert.equal(read.abi, null)
  assert.equal(read.proxy, null)
  assert.ok(read.readAt > 0)
})

await test('OtterSec verified build: kept as verified only when the build hash is the deployed code', async () => {
  const elf = standInElf(2, 50_000)
  const hash = sha(elf)
  const verifiedRec = { ...(FX.osec[PHOENIX] as object), on_chain_hash: hash, executable_hash: hash }
  const accounts = recordedProgram(JUP, elf)
  let r = await readSolana(JUP, fakeCtx(accounts, { osec: { [JUP]: verifiedRec } }).ctx)
  assert.deepEqual(r.read.verified, { by: 'osec', match: 'full', repo: 'https://github.com/Ellipsis-Labs/phoenix-v1', commit: null, compiler: null })
  assert.ok(r.read.notes.some((n) => n.startsWith('OtterSec verified build (checked 2024-12-12)')))
  // the recorded Phoenix record verifies a different executable: not verified for this code
  r = await readSolana(JUP, fakeCtx(accounts, { osec: { [JUP]: FX.osec[PHOENIX] } }).ctx)
  assert.equal(r.read.verified, null)
  assert.ok(r.read.notes.some((n) => n.includes('earlier deployment')))
  // registry unavailable / budget used up → noted (the read itself succeeds)
  r = await readSolana(JUP, fakeCtx(accounts, { osecError: new RpcError('timeout', 'osec GET: timed out after 8 s', { transient: true }) }).ctx)
  assert.equal(r.read.verified, null)
  assert.ok(r.read.notes.some((n) => n.startsWith(`${OSEC_UNAVAILABLE}: osec GET: timed out`)))
  r = await readSolana(JUP, fakeCtx(accounts, { osecError: new BudgetError('osec') }).ctx)
  assert.ok(r.read.notes.includes(`${OSEC_UNAVAILABLE}: daily registry budget used up`))
  // a finished build of other code is a mismatch; an unfinished one (Squads v4: on_chain_hash = the
  // deployed code, executable_hash empty) is not called one
  const other = 'ab'.repeat(32)
  r = await readSolana(JUP, fakeCtx(accounts, { osec: { [JUP]: { ...(FX.osec[WHIRL] as object), on_chain_hash: hash, executable_hash: other } } }).ctx)
  assert.ok(r.read.notes.some((n) => /^OtterSec build record for https:\/\/github\.com\/orca-so\/whirlpools does not match the deployed code$/.test(n)), r.read.notes.join(' / '))
  r = await readSolana(JUP, fakeCtx(accounts, { osec: { [JUP]: { ...(FX.osec[WHIRL] as object), on_chain_hash: hash, executable_hash: '' } } }).ctx)
  assert.ok(!r.read.notes.some((n) => /does not match|different deployment/.test(n)), r.read.notes.join(' / '))
  assert.ok(r.read.notes.some((n) => /not verified \(no completed build\)$/.test(n)))
})

await test('skipOsec: a binary that is already kept is not looked up again', async () => {
  const elf = standInElf(21, 9000)
  const seen: string[] = []
  const f = fakeCtx(recordedProgram(WHIRL, elf))
  const { read } = await readSolana(WHIRL, f.ctx, { skipOsec: (h) => (seen.push(h), true) })
  assert.deepEqual(seen, [sha(elf)])
  assert.equal(f.urls.length, 0)
  assert.equal(read.verified, null)
  assert.ok(read.notes.includes('OtterSec not asked: this program binary is already kept'))
  const g = fakeCtx(recordedProgram(WHIRL, elf))
  await readSolana(WHIRL, g.ctx, { skipOsec: () => false })
  assert.equal(g.urls.length, 1)
})

// ─── Anchor IDLs ─────────────────────────────────────────────────────────────

await test('Anchor 0.29 IDL account (Marinade, recorded): summary + full JSON', async () => {
  const elf = standInElf(3, 30_000)
  const f = fakeCtx(recordedProgram(MAR, elf))
  const { read, idlJson } = await readSolana(MAR, f.ctx)
  assert.equal(read.kind, 'program')
  assert.equal(read.lastDeploySlot, 433290841)
  assert.equal(read.upgradeAuthority, '551FBXSXdhcRDDkdcb3ThDRg84Mwe5Zs6YjJ1EEoyzBp')
  assert.ok(read.idl)
  assert.equal(idlFormat(idlJson), 'anchor-legacy')
  assert.equal(read.idl.name, 'marinade_finance')
  assert.equal(read.idl.version, '0.1.0')
  assert.equal(read.idl.instructions.length, 29)
  const deposit = read.idl.instructions.find((i) => i.name === 'deposit')
  assert.ok(deposit && deposit.args === 1 && deposit.accounts > 5, JSON.stringify(deposit))
  assert.ok(read.idl.instructions.some((i) => i.name === 'liquidUnstake'))
  assert.equal(read.idl.accounts.length, 2)
  assert.equal(read.idl.types, 24)
  assert.equal(read.idl.errors, 93)
  assert.equal(read.idl.events, 26)
  assert.equal(read.name, 'marinade_finance', 'no security.txt in the stand-in: name from the IDL')
  assert.ok(read.notes.includes('IDL from the Anchor IDL account (anchor-legacy)'))
  assert.equal((idlJson as { instructions: unknown[] }).instructions.length, 29)
  assert.equal(read.rpcCalls, 1)
})

await test('Anchor 0.30 IDL account (Jupiter v6, recorded): summary + full JSON', async () => {
  const f = fakeCtx(recordedProgram(JUP, standInElf(4, 30_000)))
  const { read, idlJson } = await readSolana(JUP, f.ctx)
  assert.ok(read.idl)
  assert.equal(idlFormat(idlJson), 'anchor')
  assert.equal((idlJson as { address: string }).address, JUP)
  assert.equal(read.idl.name, 'jupiter')
  assert.equal(read.idl.version, '0.1.0')
  assert.equal(read.idl.instructions.length, 19)
  const route = read.idl.instructions.find((i) => i.name === 'route')
  assert.deepEqual(route, { name: 'route', args: 5, accounts: 9 })
  assert.ok(read.idl.instructions.some((i) => i.name === 'shared_accounts_route'))
  assert.equal(read.idl.types, 23)
  assert.equal(read.idl.errors, 28)
  assert.equal(read.idl.events, 6)
  assert.equal(read.name, 'jupiter')
  assert.equal(read.lastDeploySlot, 451957263)
  assert.equal(read.upgradeAuthority, 'CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ')
})

await test('program-metadata IDL: read (zlib / gzip / none, format unspecified), richer IDL wins', async () => {
  const meta = programAddresses(JUP).metadataIdl
  const codama = {
    kind: 'rootNode',
    standard: 'codama',
    version: '1.0.0',
    program: {
      kind: 'programNode',
      name: 'jupiterAggregator',
      publicKey: JUP,
      version: '6.0.0',
      accounts: [{ kind: 'accountNode', name: 'tokenLedger' }],
      instructions: Array.from({ length: 25 }, (_, i) => ({
        kind: 'instructionNode',
        name: `ix${i}`,
        arguments: [{ name: 'a' }, { name: 'b' }],
        accounts: [{ name: 'x' }, { name: 'y' }, { name: 'z' }],
      })),
      definedTypes: [{ name: 't1' }, { name: 't2' }],
      errors: [{ name: 'e1' }],
    },
  }
  for (const compression of [2, 1, 0] as const) {
    const elf = standInElf(5, 20_000)
    const f = fakeCtx(recordedProgram(JUP, elf, [[meta, metadataAccount(JUP, codama, { compression, format: compression === 0 ? 0 : 1 })]]))
    const { read, idlJson } = await readSolana(JUP, f.ctx)
    assert.equal(idlFormat(idlJson), 'codama', `compression ${compression}`)
    assert.deepEqual(read.idl, {
      name: 'jupiterAggregator',
      version: '6.0.0',
      instructions: Array.from({ length: 25 }, (_, i) => ({ name: `ix${i}`, args: 2, accounts: 3 })),
      accounts: ['tokenLedger'],
      types: 2,
      errors: 1,
      events: 0,
    })
    assert.ok(read.notes.includes('Anchor IDL account also present, with fewer instructions'))
    assert.equal(read.rpcCalls, 1)
  }
  // a partial metadata IDL (fewer instructions) loses to the Anchor IDL account
  const partial = { address: JUP, metadata: { name: 'jupiter', version: '0.0.1', spec: '0.1.0' }, instructions: [{ name: 'route', accounts: [], args: [] }] }
  const f = fakeCtx(recordedProgram(JUP, standInElf(6, 20_000), [[meta, metadataAccount(JUP, partial)]]))
  const { read } = await readSolana(JUP, f.ctx)
  assert.equal(read.idl?.instructions.length, 19)
  assert.ok(read.notes.includes('program-metadata IDL also present, with fewer instructions'))
  // off-chain (URL) metadata is noted, not fetched
  const g = fakeCtx(recordedProgram(JUP, standInElf(7, 20_000), [[meta, metadataAccount(JUP, 'https://example.org/idl.json', { compression: 0, source: 1 })]]))
  const r2 = await readSolana(JUP, g.ctx)
  assert.ok(r2.read.notes.includes('program-metadata IDL is hosted off-chain (not fetched)'))
  assert.equal(r2.read.idl?.name, 'jupiter')
  assert.equal(g.urls.length, 1, 'only the OtterSec status was fetched')
})

await test('IDL failures degrade to notes: oversize, corrupt, wrong owner, not an IDL', async () => {
  const d = programAddresses(JUP)
  // > 4 MB inflated
  const huge = { address: JUP, metadata: { name: 'x', version: '1', spec: '0.1.0' }, instructions: [], pad: 'a'.repeat(4.5 * 1024 * 1024) }
  let f = fakeCtx(recordedProgram(JUP, standInElf(8, 10_000), [[d.anchorIdl, anchorIdlAccount(JUP, huge)]]))
  let r = await readSolana(JUP, f.ctx)
  assert.equal(r.read.idl, null)
  assert.equal(r.idlJson, null)
  assert.ok(r.read.notes.includes('Anchor IDL unreadable: IDL larger than 4 MB inflated'), r.read.notes.join(' | '))
  // corrupt zlib
  const bad = anchorIdlAccount(JUP, { instructions: [] })
  bad.data.fill(7, 50)
  f = fakeCtx(recordedProgram(JUP, standInElf(9, 10_000), [[d.anchorIdl, bad]]))
  r = await readSolana(JUP, f.ctx)
  assert.equal(r.read.idl, null)
  assert.ok(r.read.notes.includes('Anchor IDL unreadable: IDL zlib stream is corrupt'))
  // an account at the IDL address that the program does not own (anyone can fund the address)
  f = fakeCtx(recordedProgram(JUP, standInElf(10, 10_000), [[d.anchorIdl, { owner: SYSTEM, executable: false, lamports: 1, space: 0, data: Buffer.alloc(0) }]]))
  r = await readSolana(JUP, f.ctx)
  assert.equal(r.read.idl, null)
  assert.ok(!r.read.notes.some((n) => /IDL/.test(n)), r.read.notes.join(' | '))
  // JSON that is not an IDL
  f = fakeCtx(recordedProgram(JUP, standInElf(11, 10_000), [[d.anchorIdl, anchorIdlAccount(JUP, { hello: 'world' })]]))
  r = await readSolana(JUP, f.ctx)
  assert.equal(r.read.idl, null)
  assert.ok(r.read.notes.includes('Anchor IDL account is not a recognized IDL format'))
  // metadata in YAML / of another program / not canonical
  await assert.rejects(decodeMetadataIdlAccount(metadataAccount(JUP, 'a: 1', { format: 2 }).data, JUP), /format 2 is not JSON/)
  await assert.rejects(decodeMetadataIdlAccount(metadataAccount(MAR, {}).data, JUP), /another program/)
  const nc = await decodeMetadataIdlAccount(metadataAccount(JUP, { instructions: [] }, { canonical: false }).data, JUP)
  assert.deepEqual(nc.notes, ['program-metadata IDL is not canonical'])
  await assert.rejects(decodeAnchorIdlAccount(Buffer.alloc(20)), IdlError)
})

// ─── other loaders and account kinds ─────────────────────────────────────────

await test('legacy loader (BPF loader 2, recorded header): not upgradeable, hash of the trimmed account data', async () => {
  const m = FX.memoLegacy
  const elf = Buffer.concat([Buffer.from(m.elfHead, 'base64'), standInElf(12, 70_000).subarray(64)])
  const data = Buffer.concat([elf, Buffer.alloc(16)])
  const f = fakeCtx(new Map([[MEMO, { owner: m.owner, executable: m.executable, lamports: m.lamports, space: data.length, data }]]))
  const { read } = await readSolana(MEMO, f.ctx)
  assert.equal(read.kind, 'program')
  assert.equal(read.loader, 'bpf-loader-2')
  assert.equal(read.upgradeable, false)
  assert.equal(read.upgradeAuthority, null)
  assert.equal(read.lastDeploySlot, null)
  assert.equal(read.codeHash, sha(elf))
  assert.equal(read.programBytes, elf.length)
  assert.equal(read.idl, null)
  assert.ok(read.notes.includes('legacy loader (bpf-loader-2): not upgradeable'))
  assert.equal(f.urls.length, 1)
})

await test('native program (recorded): built-in, named from its account data, no OtterSec call', async () => {
  const f = fakeCtx(new Map([[VOTE, rec(FX.accounts[VOTE])]]))
  const { read } = await readSolana(VOTE, f.ctx)
  assert.equal(read.kind, 'program')
  assert.equal(read.loader, 'native')
  assert.equal(read.name, 'solana_vote_program')
  assert.equal(read.codeHash, null)
  assert.equal(read.upgradeable, false)
  assert.equal(f.urls.length, 0)
})

await test('loader v4: deployed (upgradeable) and finalized (immutable)', async () => {
  const pid = fresh(1)
  const auth = fresh(2)
  const elf = standInElf(13, 9_000)
  const v4 = (status: number) => {
    const h = Buffer.alloc(48)
    h.writeBigUInt64LE(123456789n, 0)
    key(auth).copy(h, 8)
    h.writeBigUInt64LE(BigInt(status), 40)
    const data = Buffer.concat([h, elf, Buffer.alloc(100)])
    return { owner: LOADER_V4, executable: true, lamports: 1, space: data.length, data }
  }
  let { read } = await readSolana(pid, fakeCtx(new Map([[pid, v4(1)]])).ctx)
  assert.equal(read.kind, 'program')
  assert.equal(read.loader, 'loader-v4')
  assert.equal(read.lastDeploySlot, 123456789)
  assert.equal(read.upgradeable, true)
  assert.equal(read.upgradeAuthority, auth)
  assert.equal(read.codeHash, sha(elf))
  ;({ read } = await readSolana(pid, fakeCtx(new Map([[pid, v4(2)]])).ctx))
  assert.equal(read.upgradeable, false)
  assert.equal(read.upgradeAuthority, null)
  assert.ok(read.notes.includes('loader-v4 program, finalized (immutable)'))
  assert.equal(parseLoaderV4(Buffer.alloc(47)), null)
})

await test('token mint (USDC, recorded) → token-mint; Token-2022 mint with extensions; token account → account', async () => {
  const f = fakeCtx(new Map([[USDC, rec(FX.accounts[USDC])]]))
  const { read } = await readSolana(USDC, f.ctx)
  assert.equal(read.kind, 'token-mint')
  assert.deepEqual(read.notes, ['SPL Token mint, 6 decimals'])
  assert.equal(read.codeHash, null)
  assert.equal(f.urls.length, 0, 'no registry call for a mint')
  const mint = parseMint(TOKEN_PROGRAM, rec(FX.accounts[USDC]).data)
  assert.ok(mint && mint.decimals === 6 && mint.initialized && mint.mintAuthority && mint.freezeAuthority)
  // Token-2022 mint with extensions: padded to 165, AccountType 1 (Mint)
  const t22 = Buffer.alloc(200)
  t22.writeUInt32LE(0, 0)
  t22[44] = 9
  t22[45] = 1
  t22[165] = 1
  const pid = fresh(3)
  let r = await readSolana(pid, fakeCtx(new Map([[pid, { owner: TOKEN_2022_PROGRAM, executable: false, lamports: 1, space: 200, data: t22 }]])).ctx)
  assert.equal(r.read.kind, 'token-mint')
  assert.deepEqual(r.read.notes, ['Token-2022 mint, 9 decimals, with extensions, fixed supply'])
  // a token account (165 bytes) is an account
  r = await readSolana(pid, fakeCtx(new Map([[pid, { owner: TOKEN_PROGRAM, executable: false, lamports: 1, space: 165, data: Buffer.alloc(165) }]])).ctx)
  assert.equal(r.read.kind, 'account')
  assert.deepEqual(r.read.notes, ['token account (a holder balance)'])
})

await test('missing account → empty; wallet / data accounts / buffers → account; no registry calls', async () => {
  const pid = fresh(4)
  let f = fakeCtx(new Map())
  let r = await readSolana(pid, f.ctx)
  assert.equal(r.read.kind, 'empty')
  assert.deepEqual(r.read.notes, ['no account at this address'])
  assert.equal(r.read.rpcCalls, 1)
  assert.equal(f.urls.length, 0)
  f = fakeCtx(new Map([[pid, { owner: SYSTEM, executable: false, lamports: 5, space: 0, data: Buffer.alloc(0) }]]))
  r = await readSolana(pid, f.ctx)
  assert.equal(r.read.kind, 'account')
  assert.deepEqual(r.read.notes, [`data account owned by ${SYSTEM} (0 bytes)`])
  const buf = Buffer.alloc(37)
  buf.writeUInt32LE(1, 0)
  f = fakeCtx(new Map([[pid, { owner: UPGRADEABLE_LOADER, executable: false, lamports: 5, space: 37, data: buf }]]))
  r = await readSolana(pid, f.ctx)
  assert.equal(r.read.kind, 'account')
  assert.deepEqual(r.read.notes, ['upgradeable-loader buffer (program bytes not deployed)'])
  // the programdata account itself is not the program
  const pd = programData(JUP, standInElf(14, 1000))
  f = fakeCtx(new Map([[pd.address, pd.acct]]))
  r = await readSolana(pd.address, f.ctx)
  assert.equal(r.read.kind, 'account')
  assert.equal(f.urls.length, 0)
})

await test('closed program: programdata gone → no code hash, not upgradeable, no registry call', async () => {
  const f = fakeCtx(new Map([[JUP, rec(FX.accounts[JUP])]]))
  const { read } = await readSolana(JUP, f.ctx)
  assert.equal(read.kind, 'program')
  assert.equal(read.codeHash, null)
  assert.equal(read.upgradeable, false)
  assert.ok(read.notes.includes('program closed: its programdata account is gone'))
  assert.equal(f.urls.length, 0)
})

await test('programdata at a non-canonical address: one extra call (≤ 4 per read)', async () => {
  const pid = fresh(5)
  const pdAddr = fresh(6)
  const elf = standInElf(15, 5000)
  const header = Buffer.alloc(45)
  header.writeUInt32LE(3, 0)
  header.writeBigUInt64LE(77n, 4)
  header[12] = 0
  const pdData = Buffer.concat([header, elf])
  const f = fakeCtx(
    new Map([
      [pid, programAccount(pdAddr)],
      [pdAddr, { owner: UPGRADEABLE_LOADER, executable: false, lamports: 1, space: pdData.length, data: pdData }],
    ]),
  )
  const { read } = await readSolana(pid, f.ctx)
  assert.equal(read.rpcCalls, 2)
  assert.deepEqual(f.calls[1].keys, [pdAddr])
  assert.equal(read.lastDeploySlot, 77)
  assert.equal(read.upgradeable, false)
  assert.ok(read.notes.includes('immutable: no upgrade authority'))
  assert.equal(read.codeHash, sha(elf))
})

await test('errors: invalid address (no call), RPC / budget errors propagate', async () => {
  const f = fakeCtx(new Map())
  await assert.rejects(readSolana('TokenkegQfeYi2zaN7Ef9QWstWrH1mL7mVRPQEjHBn', f.ctx), /not a Solana address/)
  await assert.rejects(readSolana('0x1234', f.ctx), /not a Solana address/)
  assert.equal(f.calls.length, 0)
  await assert.rejects(readSolana(JUP, fakeCtx(new Map(), { callError: new BudgetError('solana') }).ctx), BudgetError)
  await assert.rejects(readSolana(JUP, fakeCtx(new Map(), { callError: new RpcError('timeout', 'solana rpc getMultipleAccounts: timed out after 8 s', { transient: true }) }).ctx), RpcError)
})

// ─── pure helpers ────────────────────────────────────────────────────────────

await test('security.txt parser: recorded block, missing / unterminated / unknown-only blocks', () => {
  const sec = Buffer.from(FX.whirlpoolSecurityTxt, 'base64')
  assert.equal(parseSecurityTxt(standInElf(16, 3000, sec))?.source_code, 'https://github.com/orca-so/whirlpools')
  assert.equal(parseSecurityTxt(standInElf(17, 3000)), null)
  assert.equal(parseSecurityTxt(Buffer.concat([Buffer.from('=======BEGIN SECURITY.TXT V1=======\0name\0x\0'), Buffer.alloc(10)])), null)
  const unknownOnly = Buffer.from('=======BEGIN SECURITY.TXT V1=======\0foo\0bar\0=======END SECURITY.TXT V1=======\0')
  assert.equal(parseSecurityTxt(unknownOnly), null)
  const ctrl = Buffer.from('=======BEGIN SECURITY.TXT V1=======\0name\0  My\x07 Program \0auditors\0Neodyme, OtterSec\0x\0=======END SECURITY.TXT V1=======\0')
  assert.deepEqual(parseSecurityTxt(ctrl), { name: 'My Program', auditors: 'Neodyme, OtterSec' })
})

await test('code hash: trailing zero padding removed (solana-verify rule)', async () => {
  const elf = standInElf(18, 1000)
  const padded = Buffer.concat([elf, Buffer.alloc(5000)])
  assert.equal(trimTrailingZeros(padded).length, 1000)
  assert.equal(await codeHashOf(trimTrailingZeros(padded)), sha(elf))
  assert.equal(trimTrailingZeros(Buffer.alloc(10)).length, 0)
})

await test('OtterSec status parsing and repository URLs', () => {
  assert.deepEqual(normalizeRepoUrl('https://github.com/drift-labs/protocol-v2/tree/fee7bfa60f52274969500c37acbbe79bea847ba1'), {
    repo: 'https://github.com/drift-labs/protocol-v2',
    commit: 'fee7bfa60f52274969500c37acbbe79bea847ba1',
  })
  assert.deepEqual(normalizeRepoUrl('https://www.github.com/foo/bar.git'), { repo: 'https://github.com/foo/bar', commit: null })
  assert.deepEqual(normalizeRepoUrl('https://gitlab.com/a/b/c/'), { repo: 'https://gitlab.com/a/b/c', commit: null })
  assert.equal(normalizeRepoUrl('git@github.com:foo/bar'), null)
  assert.equal(normalizeRepoUrl(''), null)
  const ph = parseOsecStatus(FX.osec[PHOENIX])
  assert.ok(ph && ph.isVerified && ph.repo === 'https://github.com/Ellipsis-Labs/phoenix-v1' && ph.commit === null, JSON.stringify(ph))
  assert.equal(ph.executableHash, ph.onChainHash)
  const wh = parseOsecStatus(FX.osec[WHIRL])
  assert.ok(wh && !wh.isVerified && wh.repo === 'https://github.com/orca-so/whirlpools' && wh.commit === null && wh.executableHash === null)
  assert.equal(parseOsecStatus('Invalid URL: Invalid public key'), null)
  assert.equal(parseOsecStatus({ message: 'x' }), null)
})

await test('IDL summaries: composite accounts flattened, format detection', () => {
  const legacy = { version: '0.1.0', name: 'p', instructions: [{ name: 'a', accounts: [{ name: 'x', isMut: true, isSigner: true }, { name: 'grp', accounts: [{ name: 'y' }, { name: 'z' }] }], args: [{ name: 'n', type: 'u64' }] }] }
  assert.equal(idlFormat(legacy), 'anchor-legacy')
  assert.deepEqual(summarizeIdl(legacy)?.instructions, [{ name: 'a', args: 1, accounts: 3 }])
  assert.equal(idlFormat({ hello: 1 }), null)
  assert.equal(summarizeIdl(null), null)
  assert.equal(summarizeIdl([1, 2]), null)
})

await test('account decoding: base64 / base64+zstd, size cap, malformed entries', async () => {
  const data = standInElf(19, 4000)
  const z = await decodeAccount({ owner: NATIVE_LOADER, executable: true, lamports: 1, space: 4000, data: [zlib.zstdCompressSync(data).toString('base64'), 'base64+zstd'] })
  assert.ok(z && z.data.equals(data))
  const b = await decodeAccount({ owner: NATIVE_LOADER, executable: false, lamports: 1, data: [data.toString('base64'), 'base64'] })
  assert.ok(b && b.data.equals(data) && b.space === 4000)
  assert.equal(await decodeAccount(null), null)
  await assert.rejects(decodeAccount({ owner: SYSTEM, data: [zlib.zstdCompressSync(Buffer.alloc(5000)).toString('base64'), 'base64+zstd'] }, 1000), /larger than 1000 bytes/)
  await assert.rejects(decodeAccount({ owner: SYSTEM, data: ['', 'base58'] }), /encoding/)
  await assert.rejects(decodeAccount({ data: ['', 'base64'] }), /owner/)
})

// Last: flips the process-wide encoding to plain base64.
await test('endpoint without zstd: falls back to base64 once (2 calls), then stays on base64', async () => {
  const elf = standInElf(20, 8000)
  const f = fakeCtx(recordedProgram(JUP, elf), { rejectZstd: true })
  const { read } = await readSolana(JUP, f.ctx)
  assert.equal(read.rpcCalls, 2)
  assert.deepEqual(
    f.calls.map((c) => c.encoding),
    ['base64+zstd', 'base64'],
  )
  assert.equal(read.codeHash, sha(elf))
  assert.equal(read.idl?.name, 'jupiter')
  const g = fakeCtx(recordedProgram(JUP, elf), { rejectZstd: true })
  const r2 = await readSolana(JUP, g.ctx)
  assert.equal(r2.read.rpcCalls, 1)
  assert.deepEqual(
    g.calls.map((c) => c.encoding),
    ['base64'],
  )
})

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
