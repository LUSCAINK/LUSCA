// Solana account layouts the chain reader needs: RPC account decoding (base64 / base64+zstd),
// the loader states (upgradeable loader v3, loader v4), SPL Token mints and the derived addresses
// of a program (programdata, Anchor IDL account, program-metadata IDL account).

import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { PublicKey } from '@solana/web3.js'
import { base58Encode } from '../../../shared/base58.ts'

export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
export const LOADER_V2 = 'BPFLoader2111111111111111111111111111111111'
export const LOADER_V1 = 'BPFLoader1111111111111111111111111111111111'
export const LOADER_V4 = 'LoaderV411111111111111111111111111111111111'
export const NATIVE_LOADER = 'NativeLoader1111111111111111111111111111111'
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const PROGRAM_METADATA_PROGRAM = 'ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S'

/** Loader labels stored in ChainRead.loader. */
export const LOADER_LABEL: Record<string, string> = {
  [UPGRADEABLE_LOADER]: 'bpf-upgradeable',
  [LOADER_V2]: 'bpf-loader-2',
  [LOADER_V1]: 'bpf-loader-1',
  [LOADER_V4]: 'loader-v4',
  [NATIVE_LOADER]: 'native',
}

/** Solana accounts are at most 10 MiB; decoded data above this is refused. */
export const MAX_ACCOUNT_BYTES = 12 * 1024 * 1024

export interface RawAccount {
  owner: string
  executable: boolean
  lamports: number
  /** Allocated size (RPC 'space'), or the data length when the RPC does not report it. */
  space: number
  data: Buffer
}

const zstdDecompress: ((buf: Buffer, opts: zlib.ZstdOptions) => Promise<Buffer>) | null =
  typeof zlib.zstdDecompress === 'function' ? promisify<Buffer, zlib.ZstdOptions, Buffer>(zlib.zstdDecompress) : null

/** True when this Node can inflate 'base64+zstd' account data (Node ≥ 22.15 / 23.8). */
export const ZSTD_AVAILABLE = zstdDecompress !== null

export class LayoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LayoutError'
  }
}

/** One entry of getMultipleAccounts / getAccountInfo's `value` → RawAccount, or null for a missing account. */
export async function decodeAccount(v: unknown, maxBytes = MAX_ACCOUNT_BYTES): Promise<RawAccount | null> {
  if (v === null || v === undefined) return null
  if (typeof v !== 'object') throw new LayoutError('malformed account in RPC response')
  const a = v as { owner?: unknown; executable?: unknown; lamports?: unknown; space?: unknown; data?: unknown }
  if (typeof a.owner !== 'string') throw new LayoutError('account without owner in RPC response')
  let data: Buffer
  if (Array.isArray(a.data) && typeof a.data[0] === 'string') {
    const enc = a.data[1]
    const raw = Buffer.from(a.data[0], 'base64')
    if (enc === 'base64+zstd') {
      if (!zstdDecompress) throw new LayoutError('zstd account data but this runtime cannot inflate zstd')
      if (raw.length === 0) data = Buffer.alloc(0)
      else {
        try {
          data = await zstdDecompress(raw, { maxOutputLength: maxBytes })
        } catch (e) {
          if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new LayoutError(`account data larger than ${maxBytes} bytes`)
          throw new LayoutError('account data: zstd stream is corrupt')
        }
      }
    } else if (enc === 'base64') {
      data = raw
    } else throw new LayoutError(`unexpected account data encoding ${String(enc).slice(0, 20)}`)
  } else throw new LayoutError('account data missing in RPC response')
  if (data.length > maxBytes) throw new LayoutError(`account data larger than ${maxBytes} bytes`)
  const space = typeof a.space === 'number' && Number.isFinite(a.space) ? a.space : data.length
  return {
    owner: a.owner,
    executable: a.executable === true,
    lamports: typeof a.lamports === 'number' ? a.lamports : 0,
    space,
    data,
  }
}

const keyAt = (b: Buffer, off: number): string => base58Encode(b.subarray(off, off + 32))

/** u64 LE → number (slots and supplies fit 2^53 for the foreseeable future; clamps otherwise). */
function u64(b: Buffer, off: number): number {
  const v = b.readBigUInt64LE(off)
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v)
}

// ─── upgradeable loader (v3) ─────────────────────────────────────────────────

/** Size of the ProgramData header: u32 tag + u64 slot + Option<Pubkey> (1 + 32). The ELF follows. */
export const PROGRAMDATA_HEADER = 45

export type UpgradeableState =
  | { type: 'uninitialized' }
  | { type: 'buffer'; authority: string | null }
  | { type: 'program'; programData: string }
  | { type: 'programdata'; slot: number; authority: string | null; elf: Buffer }

/** UpgradeableLoaderState (bincode): u32 tag, then the variant. null when the data is not one. */
export function parseUpgradeable(data: Buffer): UpgradeableState | null {
  if (data.length < 4) return null
  const tag = data.readUInt32LE(0)
  switch (tag) {
    case 0:
      return { type: 'uninitialized' }
    case 1: {
      // Buffer { authority_address: Option<Pubkey> }
      if (data.length < 5) return null
      const some = data[4] === 1
      if (some && data.length < 37) return null
      return { type: 'buffer', authority: some ? keyAt(data, 5) : null }
    }
    case 2:
      // Program { programdata_address: Pubkey }
      if (data.length < 36) return null
      return { type: 'program', programData: keyAt(data, 4) }
    case 3: {
      // ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }, ELF at 45
      if (data.length < PROGRAMDATA_HEADER) return null
      const some = data[12] === 1
      return { type: 'programdata', slot: u64(data, 4), authority: some ? keyAt(data, 13) : null, elf: data.subarray(PROGRAMDATA_HEADER) }
    }
    default:
      return null
  }
}

// ─── loader v4 ───────────────────────────────────────────────────────────────

/** LoaderV4State: u64 slot, Pubkey authority_address_or_next_version, u64 status. The ELF follows. */
export const LOADER_V4_HEADER = 48

export interface LoaderV4State {
  slot: number
  /** The authority while retracted / deployed; the next version once finalized. */
  authorityOrNext: string
  status: 'retracted' | 'deployed' | 'finalized' | 'unknown'
  elf: Buffer
}

export function parseLoaderV4(data: Buffer): LoaderV4State | null {
  if (data.length < LOADER_V4_HEADER) return null
  const st = data.readBigUInt64LE(40)
  const status = st === 0n ? 'retracted' : st === 1n ? 'deployed' : st === 2n ? 'finalized' : 'unknown'
  return { slot: u64(data, 0), authorityOrNext: keyAt(data, 8), status, elf: data.subarray(LOADER_V4_HEADER) }
}

// ─── SPL Token ───────────────────────────────────────────────────────────────

export const MINT_LEN = 82
export const TOKEN_ACCOUNT_LEN = 165

export interface MintInfo {
  program: 'spl-token' | 'token-2022'
  decimals: number
  supply: number
  initialized: boolean
  mintAuthority: string | null
  freezeAuthority: string | null
  extensions: boolean
}

/** An SPL Token / Token-2022 mint (82 bytes, or a Token-2022 mint with extensions: AccountType 1 at byte 165). */
export function parseMint(owner: string, data: Buffer): MintInfo | null {
  if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022_PROGRAM) return null
  const plain = data.length === MINT_LEN
  const ext = owner === TOKEN_2022_PROGRAM && data.length > TOKEN_ACCOUNT_LEN && data[TOKEN_ACCOUNT_LEN] === 1
  if (!plain && !ext) return null
  // COption<Pubkey> mint_authority (u32 tag + 32), u64 supply, u8 decimals, bool is_initialized, COption<Pubkey> freeze_authority
  return {
    program: owner === TOKEN_PROGRAM ? 'spl-token' : 'token-2022',
    mintAuthority: data.readUInt32LE(0) === 1 ? keyAt(data, 4) : null,
    supply: u64(data, 36),
    decimals: data[44],
    initialized: data[45] === 1,
    freezeAuthority: data.readUInt32LE(46) === 1 ? keyAt(data, 50) : null,
    extensions: ext,
  }
}

/** A token account (holder balance) of either token program. */
export function isTokenAccount(owner: string, data: Buffer): boolean {
  if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022_PROGRAM) return false
  return data.length === TOKEN_ACCOUNT_LEN || (owner === TOKEN_2022_PROGRAM && data.length > TOKEN_ACCOUNT_LEN && data[TOKEN_ACCOUNT_LEN] === 2)
}

// ─── derived addresses ───────────────────────────────────────────────────────

/** Seed of the Anchor IDL account: createWithSeed(findProgramAddress([], program), 'anchor:idl', program). */
export const ANCHOR_IDL_SEED = 'anchor:idl'

/** createWithSeed: sha256(base ‖ seed ‖ owner). */
export function createWithSeed(base: Uint8Array, seed: string, owner: Uint8Array): string {
  return base58Encode(createHash('sha256').update(base).update(seed, 'utf8').update(owner).digest())
}

export interface ProgramAddresses {
  /** Upgradeable-loader programdata account: PDA([program], loader). */
  programData: string
  /** Anchor IDL account (0.29 / 0.30). */
  anchorIdl: string
  /** Canonical program-metadata account with seed 'idl' (Anchor ≥ 1.0, Codama). */
  metadataIdl: string
}

const seed16 = (s: string): Buffer => {
  const b = Buffer.alloc(16)
  b.write(s, 'utf8')
  return b
}

const UPGRADEABLE_KEY = new PublicKey(UPGRADEABLE_LOADER)
const METADATA_KEY = new PublicKey(PROGRAM_METADATA_PROGRAM)
const IDL_SEED16 = seed16('idl')

export function programAddresses(program: string): ProgramAddresses {
  const pid = new PublicKey(program)
  const pidBytes = pid.toBuffer()
  const [programData] = PublicKey.findProgramAddressSync([pidBytes], UPGRADEABLE_KEY)
  const [base] = PublicKey.findProgramAddressSync([], pid)
  const [metadataIdl] = PublicKey.findProgramAddressSync([pidBytes, IDL_SEED16], METADATA_KEY)
  return {
    programData: programData.toBase58(),
    anchorIdl: createWithSeed(base.toBuffer(), ANCHOR_IDL_SEED, pidBytes),
    metadataIdl: metadataIdl.toBase58(),
  }
}
