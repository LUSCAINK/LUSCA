// On-chain interface descriptions of Solana programs:
//   · the Anchor IDL account (Anchor 0.29 / 0.30): 8-byte discriminator, 32-byte authority, u32 length,
//     zlib-compressed JSON; at createWithSeed(findProgramAddress([], program), 'anchor:idl', program)
//   · the canonical program-metadata account with seed 'idl' (Anchor ≥ 1.0, Codama): 96-byte header,
//     then the data (direct, optionally gzip / zlib compressed)
// and the IdlSummary of either IDL JSON format (Anchor ≤ 0.29 "legacy", Anchor ≥ 0.30 "spec", Codama).

import { promisify } from 'node:util'
import zlib from 'node:zlib'
import type { IdlSummary } from '../../../shared/chain.ts'
import { base58Encode } from '../../../shared/base58.ts'

/** Inflated IDL JSON larger than this is refused. */
export const MAX_IDL_JSON_BYTES = 4 * 1024 * 1024

/** sha256("internal:IdlAccount")[0..8] — Anchor's IdlAccount discriminator. */
export const ANCHOR_IDL_DISCRIMINATOR = Buffer.from([24, 70, 98, 191, 58, 144, 123, 158])
/** discriminator 8 + authority 32 + u32 data length */
export const ANCHOR_IDL_HEADER = 44
/** program-metadata header length */
export const METADATA_HEADER = 96

const inflateAsync = promisify<zlib.InputType, zlib.ZlibOptions, Buffer>(zlib.inflate)
const gunzipAsync = promisify<zlib.InputType, zlib.ZlibOptions, Buffer>(zlib.gunzip)

export class IdlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdlError'
  }
}

async function inflateCapped(kind: 'zlib' | 'gzip', data: Buffer, maxBytes: number): Promise<Buffer> {
  try {
    return await (kind === 'zlib' ? inflateAsync : gunzipAsync)(data, { maxOutputLength: maxBytes })
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new IdlError(`IDL larger than ${Math.round(maxBytes / 1048576)} MB inflated`)
    throw new IdlError(`IDL ${kind} stream is corrupt`)
  }
}

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new IdlError('IDL is not valid JSON')
  }
}

export interface DecodedIdl {
  json: unknown
  /** Who can rewrite the IDL (Anchor IDL authority / metadata authority), when set. */
  authority: string | null
  notes: string[]
}

/** Anchor IDL account data → IDL JSON. Throws IdlError when the account cannot be read as one. */
export async function decodeAnchorIdlAccount(data: Buffer, maxJson = MAX_IDL_JSON_BYTES): Promise<DecodedIdl> {
  if (data.length < ANCHOR_IDL_HEADER) throw new IdlError('IDL account shorter than its header')
  const notes: string[] = []
  // Anchor's own client skips the discriminator without checking it; a mismatch is noted, not fatal.
  if (!data.subarray(0, 8).equals(ANCHOR_IDL_DISCRIMINATOR)) notes.push('IDL account discriminator differs from Anchor IdlAccount')
  const authority = base58Encode(data.subarray(8, 40))
  const len = data.readUInt32LE(40)
  if (len === 0) throw new IdlError('IDL account is empty')
  if (ANCHOR_IDL_HEADER + len > data.length) throw new IdlError('IDL length runs past the account data')
  const json = parseJson(await inflateCapped('zlib', data.subarray(ANCHOR_IDL_HEADER, ANCHOR_IDL_HEADER + len), maxJson))
  return { json, authority, notes }
}

export interface DecodedMetadata extends DecodedIdl {
  /** Set when the metadata points to a URL instead of holding the data (not fetched). */
  url: string | null
}

/**
 * Canonical program-metadata account (seed 'idl') → IDL JSON. `program` must match the account's
 * program field. Throws IdlError when the account is not a readable JSON IDL held on-chain.
 */
export async function decodeMetadataIdlAccount(data: Buffer, program: string, maxJson = MAX_IDL_JSON_BYTES): Promise<DecodedMetadata> {
  if (data.length < METADATA_HEADER) throw new IdlError('metadata account shorter than its header')
  // u8 discriminator (2 = Metadata), program 32, authority 32 (zero = none), mutable u8, canonical u8,
  // seed [16], encoding u8, compression u8, format u8, data_source u8, data_length u32, padding [5]
  if (data[0] !== 2) throw new IdlError('metadata account is not initialized')
  if (base58Encode(data.subarray(1, 33)) !== program) throw new IdlError('metadata account belongs to another program')
  const authorityBytes = data.subarray(33, 65)
  const authority = authorityBytes.some((b) => b !== 0) ? base58Encode(authorityBytes) : null
  const canonical = data[66] === 1
  const encoding = data[83]
  const compression = data[84]
  const format = data[85]
  const source = data[86]
  const len = data.readUInt32LE(87)
  const notes: string[] = []
  if (!canonical) notes.push('program-metadata IDL is not canonical')
  if (METADATA_HEADER + len > data.length) throw new IdlError('metadata length runs past the account data')
  let body = data.subarray(METADATA_HEADER, METADATA_HEADER + len)
  if (source === 2) throw new IdlError('metadata IDL is stored in another account (not followed)')
  if (source !== 0 && source !== 1) throw new IdlError(`metadata data source ${source} is unknown`)
  if (compression === 1) body = await inflateCapped('gzip', body, maxJson)
  else if (compression === 2) body = await inflateCapped('zlib', body, maxJson)
  else if (compression !== 0) throw new IdlError(`metadata compression ${compression} is unknown`)
  if (body.length > maxJson) throw new IdlError(`IDL larger than ${Math.round(maxJson / 1048576)} MB`)
  if (encoding !== 1) throw new IdlError(`metadata encoding ${encoding} is not utf-8`)
  if (source === 1) {
    const url = body.toString('utf8').trim().slice(0, 300)
    return { json: null, authority, notes, url: /^https?:\/\//i.test(url) ? url : null }
  }
  // format 1 = JSON; 0 = unspecified (seen on mainnet with JSON content): parsed when it is JSON
  if (format !== 1 && format !== 0) throw new IdlError(`metadata format ${format} is not JSON`)
  return { json: parseJson(body), authority, notes, url: null }
}

// ─── summary ─────────────────────────────────────────────────────────────────

const MAX_LIST = 1000
const str = (v: unknown, max = 80): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

/** Leaf accounts of an instruction (composite account groups are flattened). */
function countAccounts(list: unknown, depth = 0): number {
  if (depth > 8) return 0
  let n = 0
  for (const a of arr(list)) {
    const o = obj(a)
    if (!o) continue
    if (Array.isArray(o.accounts)) n += countAccounts(o.accounts, depth + 1)
    else n++
  }
  return n
}

export type IdlFormat = 'anchor-legacy' | 'anchor' | 'codama'

/** The IDL dialect of a JSON document, or null when it is not an IDL. */
export function idlFormat(json: unknown): IdlFormat | null {
  const o = obj(json)
  if (!o) return null
  if (o.kind === 'rootNode' && obj(o.program)) return 'codama'
  if (!Array.isArray(o.instructions)) return null
  const meta = obj(o.metadata)
  if (meta && (typeof meta.spec === 'string' || typeof meta.name === 'string')) return 'anchor'
  return 'anchor-legacy'
}

/** IdlSummary of an Anchor (≤ 0.29 or ≥ 0.30) or Codama IDL; null when the JSON is not one. */
export function summarizeIdl(json: unknown): IdlSummary | null {
  const fmt = idlFormat(json)
  if (!fmt) return null
  const o = json as Record<string, unknown>
  if (fmt === 'codama') {
    const p = o.program as Record<string, unknown>
    return {
      name: str(p.name),
      version: str(p.version, 40),
      instructions: arr(p.instructions)
        .slice(0, MAX_LIST)
        .map((i) => {
          const io = obj(i) ?? {}
          return { name: str(io.name) ?? '?', args: arr(io.arguments).length, accounts: countAccounts(io.accounts) }
        }),
      accounts: arr(p.accounts)
        .slice(0, MAX_LIST)
        .map((a) => str(obj(a)?.name) ?? '?'),
      types: arr(p.definedTypes).length,
      errors: arr(p.errors).length,
      events: 0,
    }
  }
  const meta = obj(o.metadata)
  const name = fmt === 'anchor' ? (str(meta?.name) ?? str(o.name)) : (str(o.name) ?? str(meta?.name))
  const version = fmt === 'anchor' ? (str(meta?.version, 40) ?? str(o.version, 40)) : (str(o.version, 40) ?? str(meta?.version, 40))
  return {
    name,
    version,
    instructions: arr(o.instructions)
      .slice(0, MAX_LIST)
      .map((i) => {
        const io = obj(i) ?? {}
        return { name: str(io.name) ?? '?', args: arr(io.args).length, accounts: countAccounts(io.accounts) }
      }),
    accounts: arr(o.accounts)
      .slice(0, MAX_LIST)
      .map((a) => str(obj(a)?.name) ?? '?'),
    types: arr(o.types).length,
    errors: arr(o.errors).length,
    events: arr(o.events).length,
  }
}
