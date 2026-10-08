// EXPOSURE, Solana: the address IS the Ed25519 public key. What it holds (SOL, SPL / Token-2022 balances) and what
// it controls, read by account layout:
//   upgradeable loader ProgramData   tag u32=3 @0, Option<Pubkey> upgrade authority @12 (1) / @13 (key)
//   upgradeable loader Program       tag u32=2 @0, programdata address @4 (size 36)
//   SPL Token mint (size 82)         COption mint authority tag @0, key @4; freeze authority tag @46, key @50
//   stake account (size 200)         staker @12, withdrawer @44, lockup custodian @92
//   SPL Token account (size 165)     mint @0, owner @32, delegate COption tag @72 / key @76, close authority tag @129 / key @133
//   SPL Token multisig (size 355)    m @0, n @1, initialized @2, signers 11 x 32 @3
// Token-2022 uses the same base layouts; an extended account carries its type at byte 165 (1 mint, 2 account).
// The account's own data is read once (first 400 bytes), so a mint, token account, multisig or stake account
// shows the keys stored in it; reverse lookups (getProgramAccounts) run only for wallets and PDAs.
import { base58Decode, base58Encode } from '../../shared/base58.ts'
import { isOnCurve } from '../control/curve.ts'
import type { ExposureAuthority, ExposureControl, ExposureHolds, ExposureKey, ExposureToken } from '../../src/lib/exposure-types.ts'
import { type KnownIndex, type LookupCtx, type LookupResult, controlFromEntry, formatUnits, int, reasonOf, short } from './common.ts'

export const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const STAKE = 'Stake11111111111111111111111111111111111111'
export const SYSTEM = '11111111111111111111111111111111'
export const LOADER_V2 = 'BPFLoader2111111111111111111111111111111111'
const LOADER_V1 = 'BPFLoader1111111111111111111111111111111111'
const OWNER_NAMES: Record<string, string> = {
  [SYSTEM]: 'System Program',
  [TOKEN]: 'SPL Token',
  [TOKEN_2022]: 'Token-2022',
  [LOADER]: 'BPF upgradeable loader',
  [LOADER_V2]: 'BPF loader (not upgradeable)',
  [STAKE]: 'Stake program',
  Vote111111111111111111111111111111111111111: 'Vote program',
}
export const ownerName = (o: string | undefined) => (o ? (OWNER_NAMES[o] ?? short(o)) : 'an unknown program')
const SLICE = 400
const CAP = 20

const u32 = (n: number) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}
const cat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((s, x) => s + x.length, 0))
  let o = 0
  for (const x of p) {
    out.set(x, o)
    o += x.length
  }
  return out
}
const b58 = (...p: Uint8Array[]) => base58Encode(cat(...p))
const pk = (a: string) => base58Decode(a) as Uint8Array

/** getProgramAccounts filters for each control query (exported for the offset fixtures). */
export function gpaFilters(address: string) {
  const k = pk(address)
  return {
    programData: { program: LOADER, filters: [{ memcmp: { offset: 0, bytes: b58(u32(3)) } }, { memcmp: { offset: 12, bytes: b58(Uint8Array.of(1), k) } }] },
    mintAuthority: { program: TOKEN, filters: [{ dataSize: 82 }, { memcmp: { offset: 0, bytes: b58(u32(1), k) } }] },
    freezeAuthority: { program: TOKEN, filters: [{ dataSize: 82 }, { memcmp: { offset: 46, bytes: b58(u32(1), k) } }] },
    staker: { program: STAKE, filters: [{ dataSize: 200 }, { memcmp: { offset: 12, bytes: address } }] },
    withdrawer: { program: STAKE, filters: [{ dataSize: 200 }, { memcmp: { offset: 44, bytes: address } }] },
  }
}
export const programOfFilters = (programData: string) => [{ dataSize: 36 }, { memcmp: { offset: 0, bytes: b58(u32(2), pk(programData)) } }]

/** Pubkeys of a getProgramAccounts answer. */
export function gpaKeys(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : Array.isArray((v as { value?: unknown })?.value) ? (v as { value: unknown[] }).value : []
  return arr.map((x) => (x as { pubkey?: unknown })?.pubkey).filter((x): x is string => typeof x === 'string')
}

export interface ParsedTokenAcc {
  pubkey: string
  mint: string
  raw: bigint
  decimals: number
  amount: string
  delegate?: string
  delegated?: string
}
/** getTokenAccountsByOwner (jsonParsed) → non-zero balances and accounts with a delegate. */
export function parseTokenAccounts(v: unknown): ParsedTokenAcc[] {
  const arr = (v as { value?: unknown[] })?.value
  if (!Array.isArray(arr)) return []
  const out: ParsedTokenAcc[] = []
  for (const a of arr) {
    const info = (a as { account?: { data?: { parsed?: { info?: Record<string, unknown> } } } })?.account?.data?.parsed?.info
    const pub = (a as { pubkey?: unknown })?.pubkey
    const ta = info?.tokenAmount as { amount?: string; decimals?: number } | undefined
    if (!info || typeof pub !== 'string' || typeof info.mint !== 'string' || !ta || typeof ta.amount !== 'string' || !/^\d+$/.test(ta.amount)) continue
    const raw = BigInt(ta.amount)
    const decimals = Number(ta.decimals ?? 0)
    const d = info.delegatedAmount as { amount?: string } | undefined
    const acc: ParsedTokenAcc = { pubkey: pub, mint: info.mint, raw, decimals, amount: formatUnits(raw, decimals) }
    if (typeof info.delegate === 'string' && d?.amount && /^\d+$/.test(d.amount) && d.amount !== '0') {
      acc.delegate = info.delegate
      acc.delegated = formatUnits(BigInt(d.amount), decimals)
    }
    if (raw > 0n || acc.delegate) out.push(acc)
  }
  return out
}

const keyAt = (d: Uint8Array, off: number) => (d.length >= off + 32 ? base58Encode(d.slice(off, off + 32)) : null)
const u32At = (d: Uint8Array, off: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(off, true)
/** COption<Pubkey> (u32 tag) → key, null for None, undefined when the data is too short. */
const optKeyAt = (d: Uint8Array, tagOff: number, keyOff: number): string | null | undefined => {
  if (d.length < keyOff + 32) return undefined
  return u32At(d, tagOff) === 1 ? keyAt(d, keyOff) : null
}
const auth = (role: string, address: string | null, via: string): ExposureAuthority => ({ role, address, ...(address ? { keyKind: isOnCurve(address) === false ? ('pda' as const) : ('key' as const) } : {}), via })

/** The account's own data (first bytes) → what kind of data account it is and the keys stored in it. */
export function parseDataAccount(owner: string | undefined, d: Uint8Array, size: number | null): { what: string; authorities: ExposureAuthority[] } | null {
  const isTok = owner === TOKEN || owner === TOKEN_2022
  const prog = ownerName(owner)
  const t2022Type = owner === TOKEN_2022 && d.length > 165 ? d[165] : 0
  if (isTok && (size === 82 || t2022Type === 1)) {
    const mint = optKeyAt(d, 0, 4)
    const freeze = optKeyAt(d, 46, 50)
    if (mint === undefined || freeze === undefined) return null
    return { what: `${prog} mint`, authorities: [auth('Mint authority', mint, 'mint data, COption @0, key @4'), auth('Freeze authority', freeze, 'mint data, COption @46, key @50')] }
  }
  if (isTok && (size === 165 || t2022Type === 2)) {
    const o = keyAt(d, 32)
    const m = keyAt(d, 0)
    if (!o || !m) return null
    const del = optKeyAt(d, 72, 76)
    const close = optKeyAt(d, 129, 133)
    const out = [auth('Token account owner', o, `token account data @32 (mint ${short(m)})`)]
    if (del) out.push(auth('Delegate', del, 'token account data, COption @72, key @76'))
    if (close) out.push(auth('Close authority', close, 'token account data, COption @129, key @133'))
    return { what: `${prog} token account`, authorities: out }
  }
  if (isTok && size === 355) {
    const m = d[0]
    const n = d[1]
    if (!(n >= 1 && n <= 11 && m >= 1 && m <= n)) return null
    const out: ExposureAuthority[] = []
    for (let i = 0; i < n; i++) {
      const k = keyAt(d, 3 + i * 32)
      if (k && k !== SYSTEM) out.push(auth(`Signer (${m} of ${n})`, k, `multisig data, signer ${i + 1} @${3 + i * 32}`))
    }
    return { what: `${prog} multisig (${m} of ${n})`, authorities: out }
  }
  if (owner === STAKE && size === 200 && d.length >= 124) {
    const tag = u32At(d, 0)
    if (tag !== 1 && tag !== 2) return { what: 'Stake account (not initialized)', authorities: [] }
    const out = [auth('Staker', keyAt(d, 12), 'stake data @12'), auth('Withdrawer', keyAt(d, 44), 'stake data @44')]
    const cu = keyAt(d, 92)
    if (cu && cu !== SYSTEM) out.push(auth('Lockup custodian', cu, 'stake data @92'))
    return { what: 'Stake account', authorities: out }
  }
  if (owner === LOADER && d.length >= 45 && d[0] === 3) {
    return { what: 'ProgramData account (upgradeable loader)', authorities: [auth('Upgrade authority', d[12] === 1 ? keyAt(d, 13) : null, 'ProgramData @12 (Option), key @13')] }
  }
  return null
}

type Acc = { owner?: string; executable: boolean; lamports: bigint | null; data: Uint8Array; size: number | null } | null
/** getAccountInfo with the first `length` bytes of data; null when no account exists. */
async function readAccount(ctx: LookupCtx, address: string, length: number): Promise<Acc> {
  const r = (await ctx.call('solana', 'getAccountInfo', [address, { encoding: 'base64', dataSlice: { offset: 0, length } }], { maxBytes: 64 << 10 })) as {
    value?: { owner?: string; executable?: boolean; lamports?: number; data?: unknown; space?: number } | null
  }
  const v = r?.value
  if (!v) return null
  const b64 = Array.isArray(v.data) && typeof v.data[0] === 'string' ? v.data[0] : ''
  const data = new Uint8Array(Buffer.from(b64, 'base64'))
  const size = typeof v.space === 'number' ? v.space : data.length < length ? data.length : null
  return { owner: typeof v.owner === 'string' ? v.owner : undefined, executable: v.executable === true, lamports: typeof v.lamports === 'number' ? BigInt(v.lamports) : null, data, size }
}

export async function lookupSolana(ctx: LookupCtx, address: string, known: KnownIndex): Promise<LookupResult> {
  const partial: string[] = []
  const notes: string[] = []
  const controls: ExposureControl[] = []
  const curve = isOnCurve(address)
  let acc: Acc = null
  let readOk = true
  try {
    acc = await readAccount(ctx, address, SLICE)
  } catch (e) {
    readOk = false
    partial.push(reasonOf('Account', e))
  }
  const owner = acc?.owner
  const lamports = readOk ? (acc ? acc.lamports : 0n) : null
  const holds: ExposureHolds = { native: lamports === null ? null : { symbol: 'SOL', amount: formatUnits(lamports, 9), raw: lamports.toString() }, tokens: [], tokenCount: 0, truncated: false }
  const ownerTag = owner ? { owner } : {}

  if (!readOk) {
    const key: ExposureKey = {
      kind: 'unknown',
      curve: curve === false ? null : 'ed25519',
      exposed: null,
      verdict: 'Not read',
      basis: `The account could not be read, so it is not known whether this is a wallet, a program or a data account.${curve === false ? ' The address is off the Ed25519 curve: no private key exists for it.' : curve ? ' The address is an Ed25519 point: if it is a wallet, its public key is the address itself.' : ''}`,
    }
    partial.push('Holdings and reverse lookups: not read, the account read failed first')
    return { key, holds, controls, partial, notes }
  }

  // a program: who can upgrade it (one more read: the first 45 bytes of its ProgramData)
  if (acc?.executable) {
    const authorities: ExposureAuthority[] = []
    let who = ''
    if (owner === LOADER && acc.data.length >= 36 && acc.data[0] === 2) {
      const pd = keyAt(acc.data, 4) as string
      try {
        const p = await readAccount(ctx, pd, 45)
        const parsed = p ? parseDataAccount(p.owner, p.data, null) : null
        const a = parsed?.authorities[0]
        if (a) {
          authorities.push({ ...a, via: `ProgramData ${short(pd)} @12 (Option), key @13` })
          who = a.address ? ` The upgrade authority is ${short(a.address)} (${a.keyKind === 'pda' ? 'program-derived: a program signs for it' : 'an on-curve address: look it up'}).` : ' The upgrade authority is None: no key can change the code.'
        } else partial.push(`Upgrade authority: ProgramData ${short(pd)} did not parse`)
      } catch (e) {
        partial.push(reasonOf('Upgrade authority (ProgramData)', e))
      }
    } else if (owner === LOADER_V2 || owner === LOADER_V1) who = ' Its loader has no upgrades: the code cannot be changed.'
    const name = known.entry('solana', address)?.name
    const key: ExposureKey = {
      kind: 'program',
      curve: null,
      exposed: null,
      verdict: 'Program (no private key signs as it)',
      basis: `The account is executable (owner ${ownerName(owner)}${name ? `; ${name}` : ''}). Whoever holds its upgrade authority can replace the code.${who}`,
      ...ownerTag,
      ...(authorities.length ? { authorities } : {}),
    }
    return { key, holds, controls, partial, notes }
  }

  const parsed = acc ? parseDataAccount(owner, acc.data, acc.size) : null
  let key: ExposureKey
  if (curve === false) {
    key = {
      kind: 'pda',
      curve: null,
      exposed: null,
      verdict: 'No private key (program-derived)',
      basis: `The address is not a point on the Ed25519 curve, so no private key exists for it.${acc ? ` Owner: ${ownerName(owner)}.` : ' No account exists at this address yet.'}${parsed ? ` It is a ${parsed.what}; the keys stored in it are listed below.` : ''}`,
      ...ownerTag,
      ...(parsed?.authorities.length ? { authorities: parsed.authorities } : {}),
    }
  } else if (!acc || owner === SYSTEM) {
    key = {
      kind: 'wallet',
      curve: 'ed25519',
      exposed: true,
      verdict: 'Exposed (the address is the public key)',
      basis: `On Solana the address is the Ed25519 public key itself, so it is public from the moment it is shared, whether or not it ever signed.${acc ? '' : ' No account exists at this address yet.'}`,
      ...ownerTag,
    }
  } else {
    key = {
      kind: 'account',
      curve: 'ed25519',
      exposed: null,
      verdict: parsed ? `Data account: ${parsed.what}` : `Data account owned by ${ownerName(owner)}`,
      basis: `The account is owned by ${ownerName(owner)}, not the System Program, so it is not a wallet. Its address is an Ed25519 point, but what happens to it is decided by that program${parsed ? ' and the keys stored in its data (listed below)' : ''}, not by a keypair for this address.`,
      ...ownerTag,
      ...(parsed?.authorities.length ? { authorities: parsed.authorities } : {}),
    }
  }

  // holdings and reverse lookups: wallets and PDAs only (a data account's own keypair holds no power)
  const reverse = key.kind === 'wallet' || (key.kind === 'pda' && owner !== LOADER)
  const tokenAccs: (ParsedTokenAcc & { program: 'token' | 'token-2022' })[] = []
  if (reverse) {
    for (const [prog, name] of [
      [TOKEN, 'token'],
      [TOKEN_2022, 'token-2022'],
    ] as const) {
      try {
        const r = await ctx.call('solana', 'getTokenAccountsByOwner', [address, { programId: prog }, { encoding: 'jsonParsed' }], { maxBytes: 4 << 20 })
        for (const a of parseTokenAccounts(r)) tokenAccs.push({ ...a, program: name })
      } catch (e) {
        partial.push(reasonOf(name === 'token' ? 'SPL token balances' : 'Token-2022 balances', e))
      }
    }
  } else partial.push(`Token balances and reverse lookups: not read (${key.kind === 'pda' ? 'a loader-owned account' : 'a data account, not a wallet'})`)
  const nonzero = tokenAccs.filter((a) => a.raw > 0n).sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0))
  holds.tokenCount = nonzero.length
  holds.truncated = nonzero.length > CAP
  holds.tokens = nonzero.slice(0, CAP).map((a): ExposureToken => ({ mint: a.mint, program: a.program, amount: a.amount, decimals: a.decimals }))
  for (const a of tokenAccs.filter((x) => x.delegate).slice(0, CAP))
    controls.push({ kind: 'token-delegate-in', target: a.pubkey, label: 'Another key may move these tokens', via: 'Token account delegate', evidence: `Delegate ${short(a.delegate as string)} is approved for ${a.delegated} of mint ${short(a.mint)} in token account ${short(a.pubkey)}`, href: `/lens/solana/${a.mint}` })

  if (reverse) {
    const why = ctx.short('solana', 30)
    if (why) partial.push(`Upgradeable programs and stake accounts: not read, ${why}`)
    else await reverseLookups(ctx, address, known, controls, partial)
    partial.push('Mints this key can mint or freeze: not listed, this RPC does not serve reverse mint-authority lookups (it needs an index)')
    partial.push('Token-2022 mint authorities and Metaplex metadata update authorities: not read in this version')
  }
  // what LUSCA's Control Map already knows
  for (const e of known.controlledBy(address)) {
    const c = controlFromEntry(e, address, e.chain === 'solana')
    if (c && !controls.some((x) => x.target === c.target)) controls.push(c)
  }
  if (key.kind === 'wallet') notes.push('Every Solana wallet key is public: a fresh address hides nothing. A new address does not change this; only a hash-based signature scheme would.')
  if (key.kind === 'account') notes.push('For a data account, look up the keys stored in it (listed under authorities): those are the keys that would matter if the signature math breaks.')
  if (key.kind === 'pda') {
    if (owner === LOADER) notes.push('This is a ProgramData account of the upgradeable loader: the upgrade authority stored in it (offset 13) decides code changes. Look that key up.')
    else if (!acc || owner === SYSTEM) notes.push('A System-owned or empty PDA: the program that derived it signs for it, and the account does not record which program that is.')
    else notes.push(`A PDA cannot sign by key: ${ownerName(owner)} signs for it, so the exposure moves to whoever can upgrade that program.`)
  }
  return { key, holds, controls, partial, notes }
}

async function reverseLookups(ctx: LookupCtx, address: string, known: KnownIndex, controls: ExposureControl[], partial: string[]) {
  const f = gpaFilters(address)
  const gpa = async (program: string, filters: unknown[]) =>
    gpaKeys(await ctx.call('solana', 'getProgramAccounts', [program, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters }], { weight: 10, timeoutMs: 12_000, maxBytes: 1 << 20 }))

  // programs this key can upgrade
  try {
    const pds = await gpa(f.programData.program, f.programData.filters)
    let resolved = 0
    for (const pd of pds.slice(0, CAP)) {
      let program: string | null = null
      if (resolved < 3 && !ctx.short('solana', 10)) {
        try {
          program = (await gpa(LOADER, programOfFilters(pd)))[0] ?? null
          resolved++
        } catch (e) {
          partial.push(reasonOf(`Program of ProgramData ${short(pd)}`, e))
        }
      }
      if (program) {
        const name = known.entry('solana', program)?.name ?? undefined
        controls.push({ kind: 'program-upgrade', target: program, label: 'Can upgrade program', ...(name ? { name } : {}), via: 'ProgramData upgrade authority (offset 13)', evidence: `ProgramData ${short(pd)} names this key as upgrade authority; program ${short(program)}`, href: `/lens/solana/${program}` })
      } else {
        controls.push({ kind: 'program-upgrade', target: pd, label: 'ProgramData (program not resolved)', via: 'ProgramData upgrade authority (offset 13)', evidence: `ProgramData ${short(pd)} names this key as upgrade authority; the program account was not resolved` })
      }
    }
    if (pds.length > CAP) partial.push(`Upgradeable programs: ${int(pds.length)} found, first ${CAP} listed`)
    if (pds.length > 3) partial.push(`Program accounts resolved for the first 3 of ${pds.length} ProgramData accounts; the rest show the ProgramData address`)
  } catch (e) {
    partial.push(reasonOf('Upgradeable programs', e))
  }
  // stake authorities
  const queries = [
    [f.staker, 'stake-staker', 'Stake authority (staker)', 'Stake account, staker (offset 12)'],
    [f.withdrawer, 'stake-withdrawer', 'Stake withdrawer', 'Stake account, withdrawer (offset 44)'],
  ] as const
  for (const [q, kind, label, via] of queries) {
    try {
      const found = await gpa(q.program, q.filters)
      for (const t of found.slice(0, CAP)) controls.push({ kind, target: t, label, via, evidence: `Stake account ${short(t)} (200 bytes) names this key` })
      if (found.length > CAP) partial.push(`${label}: ${int(found.length)} found, first ${CAP} listed`)
    } catch (e) {
      partial.push(reasonOf(label, e))
    }
  }
}
