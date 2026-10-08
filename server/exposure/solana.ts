// EXPOSURE, Solana: the address IS the Ed25519 public key. What it holds (SOL, SPL / Token-2022 balances) and what
// it controls, read by account layout:
//   upgradeable loader ProgramData   tag u32=3 @0, Option<Pubkey> upgrade authority @12 (1) / @13 (key)
//   upgradeable loader Program       tag u32=2 @0, programdata address @4 (size 36)
//   SPL Token mint (size 82)         COption mint authority tag @0, key @4; freeze authority tag @46, key @50
//   stake account (size 200)         staker @12, withdrawer @44
import { base58Decode, base58Encode } from '../../shared/base58.ts'
import { isOnCurve } from '../control/curve.ts'
import type { ExposureControl, ExposureHolds, ExposureKey, ExposureToken } from '../../src/lib/exposure-types.ts'
import { type KnownIndex, type LookupCtx, type LookupResult, controlFromEntry, formatUnits, int, reasonOf, short } from './common.ts'

export const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const STAKE = 'Stake11111111111111111111111111111111111111'
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

export async function lookupSolana(ctx: LookupCtx, address: string, known: KnownIndex): Promise<LookupResult> {
  const partial: string[] = []
  const notes: string[] = []
  const controls: ExposureControl[] = []
  const curve = isOnCurve(address)
  let owner: string | undefined
  let executable = false
  let lamports: bigint | null = null
  let exists = true
  try {
    const r = (await ctx.call('solana', 'getAccountInfo', [address, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }])) as { value?: { owner?: string; executable?: boolean; lamports?: number } | null }
    const v = r?.value
    if (!v) {
      exists = false
      lamports = 0n
    } else {
      owner = typeof v.owner === 'string' ? v.owner : undefined
      executable = v.executable === true
      lamports = typeof v.lamports === 'number' ? BigInt(v.lamports) : null
    }
  } catch (e) {
    partial.push(reasonOf('Account', e))
  }

  let key: ExposureKey
  if (executable) {
    key = { kind: 'program', curve: null, exposed: null, verdict: 'Program (no private key signs as it)', basis: `The account is executable (owner ${short(owner ?? '?')}). Whoever holds its upgrade authority can replace the code; Lens shows that key.`, ...(owner ? { owner } : {}) }
  } else if (curve === false) {
    key = { kind: 'pda', curve: null, exposed: null, verdict: 'No private key (program-derived)', basis: 'The address is not a point on the Ed25519 curve, so no private key exists for it. A program signs for it; the exposure moves to whoever can upgrade that program.', ...(owner ? { owner } : {}) }
  } else {
    key = {
      kind: 'wallet',
      curve: 'ed25519',
      exposed: true,
      verdict: 'Exposed (the address is the public key)',
      basis: `On Solana the address is the Ed25519 public key itself, so it is public from the moment it is shared, whether or not it ever signed.${exists ? '' : ' No account exists at this address yet.'}`,
      ...(owner ? { owner } : {}),
    }
  }

  const holds: ExposureHolds = { native: lamports === null ? null : { symbol: 'SOL', amount: formatUnits(lamports, 9), raw: lamports.toString() }, tokens: [], tokenCount: 0, truncated: false }
  const tokenAccs: (ParsedTokenAcc & { program: 'token' | 'token-2022' })[] = []
  if (!executable) {
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
  }
  const nonzero = tokenAccs.filter((a) => a.raw > 0n).sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0))
  holds.tokenCount = nonzero.length
  holds.truncated = nonzero.length > CAP
  holds.tokens = nonzero.slice(0, CAP).map((a): ExposureToken => ({ mint: a.mint, program: a.program, amount: a.amount, decimals: a.decimals }))
  for (const a of tokenAccs.filter((x) => x.delegate).slice(0, CAP))
    controls.push({ kind: 'token-delegate-in', target: a.pubkey, label: 'Another key may move these tokens', via: 'Token account delegate', evidence: `Delegate ${short(a.delegate as string)} is approved for ${a.delegated} of mint ${short(a.mint)} in token account ${short(a.pubkey)}`, href: `/lens/solana/${a.mint}` })

  if (executable) return { key, holds, controls, partial, notes }

  const f = gpaFilters(address)
  const gpa = async (program: string, filters: unknown[]) =>
    gpaKeys(await ctx.call('solana', 'getProgramAccounts', [program, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters }], { weight: 10, timeoutMs: 15_000, maxBytes: 1 << 20 }))

  // programs this key can upgrade
  try {
    const pds = await gpa(f.programData.program, f.programData.filters)
    let resolved = 0
    for (const pd of pds.slice(0, CAP)) {
      let program: string | null = null
      if (resolved < 3) {
        try {
          program = (await gpa(LOADER, programOfFilters(pd)))[0] ?? null
          resolved++
        } catch (e) {
          partial.push(reasonOf(`Program of ProgramData ${short(pd)}`, e))
        }
      }
      const target = program ?? pd
      const name = program ? (known.entry('solana', program)?.name ?? undefined) : undefined
      controls.push({ kind: 'program-upgrade', target, label: 'Can upgrade program', ...(name ? { name } : {}), via: 'ProgramData upgrade authority (offset 13)', evidence: `ProgramData ${short(pd)} names this key as upgrade authority${program ? `; program ${short(program)}` : '; program account not resolved'}`, href: `/lens/solana/${target}` })
    }
    if (pds.length > CAP) partial.push(`Upgradeable programs: ${int(pds.length)} found, first ${CAP} listed`)
    if (pds.length > 3) partial.push(`Program accounts resolved for the first 3 of ${pds.length} ProgramData accounts; the rest show the ProgramData address`)
  } catch (e) {
    partial.push(reasonOf('Upgradeable programs', e))
  }
  // mint / freeze authorities, stake authorities
  const queries = [
    [f.mintAuthority, 'mint-authority', 'Mint authority', 'SPL Token mint, mint authority (offset 4)', 'Mint', '82-byte SPL Token mint', true],
    [f.freezeAuthority, 'freeze-authority', 'Freeze authority', 'SPL Token mint, freeze authority (offset 50)', 'Mint', '82-byte SPL Token mint', true],
    [f.staker, 'stake-staker', 'Stake authority (staker)', 'Stake account, staker (offset 12)', 'Stake account', '200 bytes', false],
    [f.withdrawer, 'stake-withdrawer', 'Stake withdrawer', 'Stake account, withdrawer (offset 44)', 'Stake account', '200 bytes', false],
  ] as const
  for (const [q, kind, label, via, what, size, lens] of queries) {
    try {
      const found = await gpa(q.program, q.filters)
      for (const t of found.slice(0, CAP)) controls.push({ kind, target: t, label, via, evidence: `${what} ${short(t)} (${size}) names this key`, ...(lens ? { href: `/lens/solana/${t}` } : {}) })
      if (found.length > CAP) partial.push(`${label}: ${int(found.length)} found, first ${CAP} listed`)
    } catch (e) {
      partial.push(reasonOf(label, e))
    }
  }
  // what LUSCA's Control Map already knows
  for (const e of known.controlledBy(address)) {
    const c = controlFromEntry(e, address, e.chain === 'solana')
    if (c && !controls.some((x) => x.target === c.target)) controls.push(c)
  }
  partial.push('Token-2022 mint authorities and Metaplex metadata update authorities: not read in this version')
  if (key.kind === 'wallet') notes.push('Every Solana wallet key is public: a fresh address hides nothing. A new address does not change this; only a hash-based signature scheme would.')
  if (key.kind === 'pda') notes.push('A PDA cannot sign by key. Check who can upgrade the program that owns it.')
  return { key, holds, controls, partial, notes }
}
