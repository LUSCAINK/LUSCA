// Solana reader of the chain agents: one address in, one ChainRead out.
//
//   getMultipleAccounts([address, programdata PDA, Anchor IDL account, program-metadata IDL account])
//     — one RPC call (base64+zstd: zero padding compresses away; plain base64 when unsupported)
//   ─▶ kind: program (upgradeable loader v3 / loader v4 / legacy loaders / native) · token-mint · account · empty
//   ─▶ program: last deploy slot, upgrade authority, codeHash = sha256(ELF without trailing zeros) — the
//      rule solana-verify and the OtterSec registry use — embedded security.txt, on-chain IDL
//      (Anchor 0.29 / 0.30 IDL account, or the canonical program-metadata IDL), summarized
//   ─▶ OtterSec verified-build status (verify.osec.io, registry budget, not RPC)
//
// RPC: 1 call per read (2 if the endpoint rejects zstd once, +1 for a non-canonical programdata
// address — never seen on mainnet); ≤ 4 by construction. RPC and budget errors propagate (the agent
// records verdict 'error' / waits for the budget); everything after the account fetch degrades to a
// note instead of failing the read.

import type { ChainRead, IdlSummary } from '../../shared/chain.ts'
import { isSolanaAddress } from '../../shared/base58.ts'
import { RpcError, isBudgetError, type RpcCtx } from './rpc.ts'
import {
  LOADER_LABEL,
  LOADER_V1,
  LOADER_V2,
  LOADER_V4,
  NATIVE_LOADER,
  PROGRAM_METADATA_PROGRAM,
  UPGRADEABLE_LOADER,
  ZSTD_AVAILABLE,
  decodeAccount,
  isTokenAccount,
  parseLoaderV4,
  parseMint,
  parseUpgradeable,
  programAddresses,
  type RawAccount,
} from './solana/layout.ts'
import { codeHashOf, isElf, parseSecurityTxt, trimTrailingZeros } from './solana/elf.ts'
import { decodeAnchorIdlAccount, decodeMetadataIdlAccount, idlFormat, summarizeIdl, type DecodedIdl } from './solana/idl.ts'
import { osecStatusUrl, parseOsecStatus, type OsecStatus } from './solana/osec.ts'

export interface ReadSolanaOptions {
  /** True when this code hash is already kept: the read is a duplicate either way, OtterSec is not asked. */
  skipOsec?: (codeHash: string) => boolean
  /** Handed the trimmed program executable (Lens reads its syscall imports); not called when there is none. */
  onElf?: (elf: Uint8Array) => void
}

export interface SolanaReadResult {
  read: ChainRead
  /** The full on-chain IDL JSON (Anchor or Codama), for the stored item; null when there is none. */
  idlJson: unknown | null
}

/**
 * Note prefix written when the OtterSec registry could not be asked (budget used up, timeout, HTTP
 * error). A program read with this note and no IDL is not known to be unverified: worth reading again.
 */
export const OSEC_UNAVAILABLE = 'OtterSec status unavailable'

/** Flips to false (for the process) when the read endpoint rejects 'base64+zstd'. */
let zstdOk = ZSTD_AVAILABLE

const MAX_NOTES = 24
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 160)

interface Counter {
  n: number
}

/** getMultipleAccounts → decoded accounts. `soft` indices degrade to null on a decoding error (noted). */
async function getAccounts(ctx: RpcCtx, keys: string[], calls: Counter, notes: string[], soft: Set<number> = new Set()): Promise<(RawAccount | null)[]> {
  const send = (encoding: 'base64' | 'base64+zstd') => {
    calls.n++
    return ctx.call('solana', 'getMultipleAccounts', [keys, { encoding, commitment: 'confirmed' }])
  }
  let res: unknown
  try {
    res = await send(zstdOk ? 'base64+zstd' : 'base64')
  } catch (e) {
    const rejectsZstd = zstdOk && e instanceof RpcError && e.kind === 'rpc' && (e.code === -32602 || /zstd|encoding/i.test(e.message))
    if (!rejectsZstd) throw e
    zstdOk = false
    res = await send('base64')
  }
  const value = res && typeof res === 'object' ? (res as { value?: unknown }).value : null
  if (!Array.isArray(value) || value.length !== keys.length) throw new Error('solana rpc getMultipleAccounts: malformed response')
  const out: (RawAccount | null)[] = []
  for (let i = 0; i < keys.length; i++) {
    try {
      out.push(await decodeAccount(value[i]))
    } catch (e) {
      if (!soft.has(i)) throw e
      notes.push(`account ${keys[i]} unreadable: ${errMsg(e)}`)
      out.push(null)
    }
  }
  return out
}

function blankRead(address: string): ChainRead {
  return {
    chain: 'solana',
    address,
    kind: 'empty',
    name: null,
    codeHash: null,
    upgradeable: null,
    upgradeAuthority: null,
    lastDeploySlot: null,
    programBytes: null,
    loader: null,
    idl: null,
    securityTxt: null,
    bytecodeBytes: null,
    proxy: null,
    abi: null,
    verified: null,
    sources: [],
    notes: [],
    readAt: 0,
    rpcCalls: 0,
  }
}

const cleanName = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return s ? s.slice(0, 80) : null
}

/** Name of a native (built-in) program: its account data is the program's name in ASCII. */
function nativeName(data: Buffer): string | null {
  if (!data.length || data.length > 64) return null
  for (const b of data) if (b < 0x20 || b > 0x7e) return null
  return data.toString('latin1')
}

function applyOsec(read: ChainRead, st: OsecStatus, notes: string[]) {
  const code = read.codeHash
  if (st.isVerified) {
    const built = st.executableHash ?? st.onChainHash
    if (built && code && built !== code) {
      notes.push('OtterSec verified build is for an earlier deployment: its hash differs from the deployed code')
    } else {
      read.verified = { by: 'osec', match: 'full', repo: st.repo, commit: st.commit, compiler: null }
      notes.push(`OtterSec verified build${st.lastVerifiedAt ? ` (checked ${st.lastVerifiedAt.slice(0, 10)})` : ''}`)
    }
  } else if (st.repo) {
    // "does not match" only when both hashes are known and differ; a record whose build never
    // finished (executable_hash empty) says nothing about the deployed code
    const deployed = code ?? st.onChainHash
    if (st.executableHash && deployed && st.executableHash !== deployed) notes.push(`OtterSec build record for ${st.repo} does not match the deployed code`)
    else if (!st.executableHash) notes.push(`OtterSec has a build record for ${st.repo}, not verified (no completed build)`)
    else notes.push(`OtterSec has a build record for ${st.repo}, not marked verified`)
  }
  if (st.onChainHash && code && st.onChainHash !== code && !(st.isVerified && read.verified)) {
    notes.push('OtterSec last saw a different deployment of this program')
  }
  if (st.closed) notes.push('OtterSec record: program closed')
}

/**
 * Read a Solana address: what it is, and for a program its code hash, deploy state, security.txt,
 * on-chain IDL and OtterSec verified-build status. Throws on an invalid address, RPC errors and
 * budget exhaustion (RpcError / BudgetError from ctx), never for missing optional parts.
 */
export async function readSolana(address: string, ctx: RpcCtx, opts: ReadSolanaOptions = {}): Promise<SolanaReadResult> {
  if (!isSolanaAddress(address)) throw new Error('not a Solana address')
  const read = blankRead(address)
  const notes: string[] = []
  const calls: Counter = { n: 0 }
  let idlJson: unknown | null = null

  const finish = (): SolanaReadResult => {
    read.notes = [...new Set(notes.map((n) => n.slice(0, 200)))].slice(0, MAX_NOTES)
    read.rpcCalls = calls.n
    read.readAt = Date.now()
    return { read, idlJson }
  }

  const derived = programAddresses(address)
  const [acct, pdAcct, anchorAcct, metaAcct] = await getAccounts(
    ctx,
    [address, derived.programData, derived.anchorIdl, derived.metadataIdl],
    calls,
    notes,
    new Set([2, 3]),
  )

  if (!acct) {
    read.kind = 'empty'
    notes.push('no account at this address')
    return finish()
  }

  let elf: Uint8Array | null = null
  let fallbackName: string | null = null

  switch (acct.owner) {
    case UPGRADEABLE_LOADER: {
      const st = parseUpgradeable(acct.data)
      if (st?.type === 'program') {
        read.kind = 'program'
        read.loader = LOADER_LABEL[UPGRADEABLE_LOADER]
        let pd = pdAcct
        if (st.programData !== derived.programData) {
          notes.push('programdata address is not the canonical one')
          ;[pd] = await getAccounts(ctx, [st.programData], calls, notes)
        }
        const pst = pd && pd.owner === UPGRADEABLE_LOADER ? parseUpgradeable(pd.data) : null
        if (pst?.type === 'programdata') {
          read.lastDeploySlot = pst.slot
          read.upgradeAuthority = pst.authority
          read.upgradeable = pst.authority !== null
          if (!read.upgradeable) notes.push('immutable: no upgrade authority')
          elf = pst.elf
        } else {
          read.upgradeable = false
          notes.push('program closed: its programdata account is gone')
        }
      } else if (st?.type === 'programdata') {
        read.kind = 'account'
        notes.push('programdata account of an upgradeable program (the program id is another address)')
      } else if (st?.type === 'buffer') {
        read.kind = 'account'
        notes.push('upgradeable-loader buffer (program bytes not deployed)')
      } else {
        read.kind = 'account'
        notes.push('upgradeable-loader account without a program')
      }
      break
    }
    case LOADER_V2:
    case LOADER_V1: {
      read.loader = LOADER_LABEL[acct.owner]
      if (acct.executable) {
        read.kind = 'program'
        read.upgradeable = false
        elf = acct.data
        notes.push(`legacy loader (${read.loader}): not upgradeable`)
      } else {
        read.kind = 'account'
        notes.push(`${read.loader} account that is not executable`)
      }
      break
    }
    case LOADER_V4: {
      read.loader = LOADER_LABEL[LOADER_V4]
      const st = parseLoaderV4(acct.data)
      if (!st) {
        read.kind = 'account'
        notes.push('loader-v4 account shorter than its header')
        break
      }
      read.kind = 'program'
      read.lastDeploySlot = st.slot
      if (st.status === 'finalized') {
        read.upgradeable = false
        notes.push('loader-v4 program, finalized (immutable)')
      } else {
        read.upgradeable = true
        read.upgradeAuthority = st.authorityOrNext
        notes.push(`loader-v4 program, ${st.status}`)
      }
      elf = st.elf
      break
    }
    case NATIVE_LOADER: {
      read.kind = 'program'
      read.loader = LOADER_LABEL[NATIVE_LOADER]
      read.upgradeable = false
      fallbackName = nativeName(acct.data)
      notes.push('built-in program (native loader): no executable on-chain')
      break
    }
    default: {
      const mint = parseMint(acct.owner, acct.data)
      if (mint) {
        read.kind = 'token-mint'
        notes.push(
          `${mint.program === 'spl-token' ? 'SPL Token' : 'Token-2022'} mint, ${mint.decimals} decimals${mint.extensions ? ', with extensions' : ''}${
            mint.mintAuthority ? '' : ', fixed supply'
          }`,
        )
      } else if (isTokenAccount(acct.owner, acct.data)) {
        read.kind = 'account'
        notes.push('token account (a holder balance)')
      } else if (acct.executable) {
        read.kind = 'program'
        read.loader = acct.owner
        notes.push('executable account of an unknown loader')
      } else {
        read.kind = 'account'
        notes.push(`data account owned by ${acct.owner} (${acct.space} bytes)`)
      }
    }
  }

  if (elf) {
    const trimmed = trimTrailingZeros(elf)
    if (!trimmed.length) {
      notes.push('program bytes are empty')
    } else {
      if (!isElf(trimmed)) notes.push('program bytes do not start with an ELF header')
      read.programBytes = trimmed.length
      read.codeHash = await codeHashOf(trimmed)
      read.securityTxt = parseSecurityTxt(trimmed)
      opts.onElf?.(trimmed)
    }
  }

  // ── on-chain IDL ──
  if (read.kind === 'program' && read.loader !== LOADER_LABEL[NATIVE_LOADER]) {
    let fromMeta: DecodedIdl | null = null
    let fromAnchor: DecodedIdl | null = null
    if (metaAcct && metaAcct.owner === PROGRAM_METADATA_PROGRAM) {
      try {
        const m = await decodeMetadataIdlAccount(metaAcct.data, address)
        if (m.url) notes.push('program-metadata IDL is hosted off-chain (not fetched)')
        else fromMeta = m
      } catch (e) {
        notes.push(`program-metadata IDL unreadable: ${errMsg(e)}`)
      }
    }
    // Only the program itself can own an account at its IDL address (anyone can fund the address,
    // leaving a plain system account there: not an IDL).
    if (anchorAcct && anchorAcct.owner === address) {
      try {
        fromAnchor = await decodeAnchorIdlAccount(anchorAcct.data)
      } catch (e) {
        notes.push(`Anchor IDL unreadable: ${errMsg(e)}`)
      }
    }
    // Both can exist (a program moving to program-metadata keeps its Anchor IDL account); they are
    // written by the program's authorities and either can be partial: the one describing more
    // instructions wins, program-metadata on a tie.
    let best: { src: string; d: DecodedIdl; s: IdlSummary } | null = null
    for (const [src, d] of [
      ['program-metadata IDL', fromMeta],
      ['Anchor IDL account', fromAnchor],
    ] as const) {
      if (!d) continue
      const s = summarizeIdl(d.json)
      if (!s) notes.push(`${src} is not a recognized IDL format`)
      else if (!best || s.instructions.length > best.s.instructions.length) {
        if (best) notes.push(`${best.src} also present, with fewer instructions`)
        best = { src, d, s }
      } else notes.push(`${src} also present, with ${s.instructions.length === best.s.instructions.length ? 'as many' : 'fewer'} instructions`)
    }
    const summary = best?.s ?? null
    if (best) {
      idlJson = best.d.json
      notes.push(`IDL from the ${best.src} (${idlFormat(best.d.json)})`, ...best.d.notes)
    }
    read.idl = summary
  }

  read.name = cleanName(read.securityTxt?.name) ?? cleanName(read.idl?.name) ?? cleanName(fallbackName)

  // ── OtterSec verified build (executable programs only) ──
  if (read.kind === 'program' && read.codeHash && opts.skipOsec?.(read.codeHash)) {
    notes.push('OtterSec not asked: this program binary is already kept')
  } else if (read.kind === 'program' && read.codeHash) {
    try {
      const st = parseOsecStatus(await ctx.fetchJson(osecStatusUrl(address), { host: 'osec', timeoutMs: 8000, maxBytes: 64 * 1024 }))
      if (st) applyOsec(read, st, notes)
      else notes.push(`${OSEC_UNAVAILABLE}: unexpected response`)
    } catch (e) {
      notes.push(`${OSEC_UNAVAILABLE}: ${isBudgetError(e) ? 'daily registry budget used up' : errMsg(e)}`)
    }
  }

  return finish()
}
