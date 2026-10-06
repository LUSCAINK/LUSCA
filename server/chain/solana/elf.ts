// Program executable helpers: the code hash (same rule as solana-verify / the OtterSec registry:
// sha256 of the ELF with its trailing zero padding removed) and the embedded security.txt
// (solana-security-txt: NUL-separated key/value pairs between two markers).

import { webcrypto } from 'node:crypto'

/** The ELF without the zero bytes that pad the account to its allocated size. */
export function trimTrailingZeros(elf: Uint8Array): Uint8Array {
  let end = elf.length
  while (end > 0 && elf[end - 1] === 0) end--
  return elf.subarray(0, end)
}

/** sha256 hex of the trimmed ELF (WebCrypto: hashed off the main thread). */
export async function codeHashOf(trimmedElf: Uint8Array): Promise<string> {
  const d = await webcrypto.subtle.digest('SHA-256', trimmedElf)
  return Buffer.from(d).toString('hex')
}

/** True when the bytes start with the ELF magic. */
export const isElf = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46

const BEGIN = Buffer.from('=======BEGIN SECURITY.TXT V1=======\0', 'latin1')
const END = Buffer.from('=======END SECURITY.TXT V1=======\0', 'latin1')
const MAX_REGION = 64 * 1024
const MAX_VALUE = 2000
const MAX_FIELDS = 32

/** Fields defined by solana-security-txt (others are kept when they look like keys). */
export const SECURITY_TXT_FIELDS = [
  'name',
  'project_url',
  'contacts',
  'policy',
  'preferred_languages',
  'encryption',
  'source_code',
  'source_release',
  'source_revision',
  'auditors',
  'acknowledgements',
  'expiry',
] as const

const clean = (s: string): string =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_VALUE)

/**
 * The security.txt embedded in a program ELF, or null when there is none (or it is malformed).
 * Keys are lower-case identifiers; values are trimmed and capped at 2000 characters.
 */
export function parseSecurityTxt(elf: Uint8Array): Record<string, string> | null {
  const buf = Buffer.isBuffer(elf) ? elf : Buffer.from(elf.buffer, elf.byteOffset, elf.byteLength)
  let from = 0
  // A program can carry the marker more than once (e.g. a dependency that links the macro); take
  // the first region that parses to at least one known field.
  for (let guard = 0; guard < 4; guard++) {
    const s = buf.indexOf(BEGIN, from)
    if (s < 0) return null
    const bodyStart = s + BEGIN.length
    const e = buf.indexOf(END, bodyStart)
    if (e < 0) return null
    from = bodyStart
    if (e - bodyStart > MAX_REGION) continue
    const parts = buf.subarray(bodyStart, e).toString('utf8').split('\0')
    // "key\0value\0key\0value\0" → [key, value, key, value, '']
    if (parts.length && parts[parts.length - 1] === '') parts.pop()
    const out: Record<string, string> = {}
    let fields = 0
    let known = 0
    for (let i = 0; i + 1 < parts.length && fields < MAX_FIELDS; i += 2) {
      const k = parts[i].trim().toLowerCase()
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) continue
      const v = clean(parts[i + 1])
      if (!v || k in out) continue
      out[k] = v
      fields++
      if ((SECURITY_TXT_FIELDS as readonly string[]).includes(k)) known++
    }
    if (known > 0) return out
  }
  return null
}
