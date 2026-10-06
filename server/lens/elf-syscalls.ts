// What a Solana program executable calls into: the syscalls it imports (ELF .dynsym undefined
// symbols, SBPF v1/v2) and the syscalls named by hashed id in `call` instructions (static syscalls,
// SBPF v3: imm = murmur3_32(name)), plus the native signature-verification program ids whose 32
// bytes appear in the binary (a program checking an Ed25519 / secp256k1 / secp256r1 instruction
// through the instructions sysvar carries the id to compare against).
// Pure functions over the ELF bytes; nothing guessed: a name is reported only when it was read.

import { base58Decode } from '../../shared/base58.ts'
import type { LensPrimitive, PrimitiveGroup } from '../../shared/lens.ts'

/** murmur3 x86 32-bit, seed 0 — the hash SBPF uses for syscall ids. */
export function murmur3_32(key: Uint8Array, seed = 0): number {
  const c1 = 0xcc9e2d51
  const c2 = 0x1b873593
  const n = key.length
  let h = seed >>> 0
  let i = 0
  for (; i + 4 <= n; i += 4) {
    let k = key[i] | (key[i + 1] << 8) | (key[i + 2] << 16) | (key[i + 3] << 24)
    k = Math.imul(k, c1)
    k = (k << 15) | (k >>> 17)
    k = Math.imul(k, c2)
    h ^= k
    h = (h << 13) | (h >>> 19)
    h = (Math.imul(h, 5) + 0xe6546b64) | 0
  }
  let k = 0
  const rem = n & 3
  if (rem === 3) k ^= key[i + 2] << 16
  if (rem >= 2) k ^= key[i + 1] << 8
  if (rem >= 1) {
    k ^= key[i]
    k = Math.imul(k, c1)
    k = (k << 15) | (k >>> 17)
    k = Math.imul(k, c2)
    h ^= k
  }
  h ^= n
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Syscalls that are cryptographic / hash primitives, with a readable name and group. */
export const PRIMITIVE_SYSCALLS: Record<string, { name: string; group: PrimitiveGroup }> = {
  sol_sha256: { name: 'SHA-256', group: 'hash' },
  sol_keccak256: { name: 'Keccak-256', group: 'hash' },
  sol_blake3: { name: 'BLAKE3', group: 'hash' },
  sol_poseidon: { name: 'Poseidon', group: 'zk' },
  sol_secp256k1_recover: { name: 'secp256k1 public-key recovery', group: 'signature' },
  sol_curve_validate_point: { name: 'Curve25519 / Ristretto point validation', group: 'curve' },
  sol_curve_group_op: { name: 'Curve25519 / Ristretto group operation', group: 'curve' },
  sol_curve_multiscalar_mul: { name: 'Curve25519 / Ristretto multiscalar multiplication', group: 'curve' },
  sol_curve_pairing_map: { name: 'curve pairing map', group: 'curve' },
  sol_alt_bn128_group_op: { name: 'alt_bn128 (BN254) add / mul / pairing', group: 'zk' },
  sol_alt_bn128_compression: { name: 'alt_bn128 (BN254) point compression', group: 'zk' },
  sol_big_mod_exp: { name: 'big-integer modular exponentiation', group: 'zk' },
}

/** Every syscall name the runtime defines (agave), for the hashed-id scan. */
export const KNOWN_SYSCALLS = [
  ...Object.keys(PRIMITIVE_SYSCALLS),
  'abort',
  'sol_panic_',
  'sol_log_',
  'sol_log_64_',
  'sol_log_pubkey',
  'sol_log_compute_units_',
  'sol_log_data',
  'sol_invoke_signed_c',
  'sol_invoke_signed_rust',
  'sol_create_program_address',
  'sol_try_find_program_address',
  'sol_set_return_data',
  'sol_get_return_data',
  'sol_memcpy_',
  'sol_memmove_',
  'sol_memcmp_',
  'sol_memset_',
  'sol_alloc_free_',
  'sol_get_clock_sysvar',
  'sol_get_epoch_schedule_sysvar',
  'sol_get_fees_sysvar',
  'sol_get_rent_sysvar',
  'sol_get_last_restart_slot',
  'sol_get_epoch_rewards_sysvar',
  'sol_get_sysvar',
  'sol_get_epoch_stake',
  'sol_get_processed_sibling_instruction',
  'sol_get_stack_height',
  'sol_remaining_compute_units',
]

const ID_TO_SYSCALL = new Map<number, string>(KNOWN_SYSCALLS.map((n) => [murmur3_32(Buffer.from(n, 'latin1')), n]))

/** Native programs that verify signatures; a program reading their instructions carries their id. */
export const SIG_VERIFY_PROGRAMS: { id: string; name: string }[] = [
  { id: 'Ed25519SigVerify111111111111111111111111111', name: 'Ed25519 signature verification (native program)' },
  { id: 'KeccakSecp256k11111111111111111111111111111', name: 'secp256k1 signature verification (native program)' },
  { id: 'Secp256r1SigVerify1111111111111111111111111', name: 'secp256r1 (P-256) signature verification (native program)' },
]
const SIG_IDS = SIG_VERIFY_PROGRAMS.flatMap((p) => {
  const b = base58Decode(p.id)
  return b && b.length === 32 ? [{ ...p, bytes: Buffer.from(b) }] : []
})

export interface ElfScan {
  /** Undefined dynamic symbols (syscall imports), in table order, de-duplicated. */
  imports: string[]
  /** Syscalls named by hashed id in call instructions (static syscalls). */
  hashed: string[]
  /** Native signature-verification program ids found in the bytes. */
  sigPrograms: string[]
  /** Why a part could not be read (malformed headers…). */
  notes: string[]
}

const SHT_SYMTAB = 2
const SHT_DYNSYM = 11
const MAX_SECTIONS = 512
const MAX_SYMBOLS = 20_000

/** Scan a (trimmed) program ELF. Never throws: unreadable parts become notes. */
export function scanElf(elf: Uint8Array): ElfScan {
  const out: ElfScan = { imports: [], hashed: [], sigPrograms: [], notes: [] }
  let b = Buffer.isBuffer(elf) ? elf : Buffer.from(elf.buffer, elf.byteOffset, elf.byteLength)
  for (const p of SIG_IDS) if (b.indexOf(p.bytes) >= 0) out.sigPrograms.push(p.id)
  if (b.length < 64 || b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46) {
    out.notes.push('not an ELF file: syscalls not read')
    return out
  }
  if (b[4] !== 2 || b[5] !== 1) {
    out.notes.push('not a 64-bit little-endian ELF: syscalls not read')
    return out
  }
  try {
    const shoff = Number(b.readBigUInt64LE(0x28))
    const shentsize = b.readUInt16LE(0x3a)
    const shnum = b.readUInt16LE(0x3c)
    // the code hash rule trims the trailing zero padding, which can eat the zero tail of the last
    // section header: put the zeros back (at most one header table) before reading
    const need = shoff + shnum * shentsize
    if (shoff > 0 && shoff < b.length && need > b.length && need - b.length <= MAX_SECTIONS * 64) {
      const padded = Buffer.alloc(need)
      b.copy(padded)
      b = padded
    }
    if (!shoff || shentsize < 64 || shnum === 0 || shnum > MAX_SECTIONS || shoff + shnum * shentsize > b.length) {
      out.notes.push('ELF section headers missing or out of range: syscall imports not read')
    } else {
      const sec = (i: number) => {
        const o = shoff + i * shentsize
        return {
          type: b.readUInt32LE(o + 4),
          flags: Number(b.readBigUInt64LE(o + 8)),
          offset: Number(b.readBigUInt64LE(o + 24)),
          size: Number(b.readBigUInt64LE(o + 32)),
          link: b.readUInt32LE(o + 40),
          entsize: Number(b.readBigUInt64LE(o + 56)),
        }
      }
      const seen = new Set<string>()
      for (let i = 0; i < shnum; i++) {
        const s = sec(i)
        if (s.type !== SHT_DYNSYM && s.type !== SHT_SYMTAB) continue
        if (s.link >= shnum) continue
        const str = sec(s.link)
        const ent = s.entsize || 24
        if (ent < 24 || s.offset + s.size > b.length || str.offset + str.size > b.length) continue
        const n = Math.min(MAX_SYMBOLS, Math.floor(s.size / ent))
        for (let k = 1; k < n; k++) {
          const o = s.offset + k * ent
          const nameOff = b.readUInt32LE(o)
          const shndx = b.readUInt16LE(o + 6)
          if (shndx !== 0 || !nameOff || nameOff >= str.size) continue
          const start = str.offset + nameOff
          let end = start
          while (end < str.offset + str.size && b[end] !== 0 && end - start < 128) end++
          const name = b.toString('latin1', start, end)
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !seen.has(name)) {
            seen.add(name)
            out.imports.push(name)
          }
        }
      }
      // static syscalls: `call imm` (opcode 0x85, src reg 0) in executable sections
      const hashed = new Set<string>()
      for (let i = 0; i < shnum; i++) {
        const s = sec(i)
        if (!(s.flags & 0x4) || s.type !== 1) continue // SHF_EXECINSTR, SHT_PROGBITS
        const end = Math.min(b.length, s.offset + s.size)
        for (let o = s.offset; o + 8 <= end; o += 8) {
          if (b[o] !== 0x85 || (b[o + 1] & 0xf0) !== 0) continue
          const name = ID_TO_SYSCALL.get(b.readUInt32LE(o + 4))
          if (name && !seen.has(name)) hashed.add(name)
        }
      }
      out.hashed = [...hashed]
    }
  } catch (e) {
    out.notes.push(`ELF unreadable: ${(e as Error).message.slice(0, 80)}`)
  }
  return out
}

/** The primitives an ELF scan shows. */
export function solanaPrimitives(scan: ElfScan): LensPrimitive[] {
  const out: LensPrimitive[] = []
  for (const [list, via] of [
    [scan.imports, 'syscall-import'],
    [scan.hashed, 'syscall-id'],
  ] as const) {
    for (const s of list) {
      const p = PRIMITIVE_SYSCALLS[s]
      if (p) out.push({ name: `${p.name} (${s})`, group: p.group, via, at: [], count: 1 })
    }
  }
  for (const id of scan.sigPrograms) {
    const p = SIG_VERIFY_PROGRAMS.find((x) => x.id === id)
    if (p) out.push({ name: `${p.name} ${id}`, group: 'signature', via: 'program-id', at: [], count: 1 })
  }
  return out
}
