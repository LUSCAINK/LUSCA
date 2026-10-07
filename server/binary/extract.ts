// READ THE BINARY — pure extraction over one Solana program executable (the trimmed ELF).
//
//   strings     printable runs; "Instruction: <Name>" log strings (Rust string literals are not
//               NUL-terminated, so neighbours run together: a name's end is confirmed by its discriminator;
//               a glued run whose end no discriminator confirms is kept apart as an unconfirmed fragment)
//   discs       one pass over the bytes: `lddw` immediates in the code sections (an 8-byte compare against
//               the instruction data compiles to lddw imm64: low half in slot 1, high half in slot 2) and every
//               byte offset of the data sections (a discriminator kept as a [u8; 8] constant)
//   crates      cargo registry paths in panic locations → crate name + version ONLY (the path, the user's
//               home directory and everything around the crate directory are dropped here, never stored)
//   framework   Anchor (its error-log format string / anchor-lang crate), steel, pinocchio, native
//
// No I/O, no network. CPU: linear in the executable size, chunked with `pause()` between 512 KB slices so a
// caller can yield to the event loop.

import { createHash } from 'node:crypto'
import type { BinAccount, BinCall, BinCrate, BinError, BinEvent, BinFramework, BinInstruction, DiscSite } from '../../shared/binary.ts'
import type { Dictionary, DictEntry } from './dictionary.ts'

const CHUNK = 512 * 1024
export const MAX_INSTRUCTIONS = 300
export const MAX_CALLS = 120
export const MAX_ACCOUNTS = 200
export const MAX_EVENTS = 100
export const MAX_ERRORS = 150
export const MAX_TOKEN = 128
export const MAX_FRAGMENTS = 40
/** At most this many glued tokens are cut back for confirmation (each cut costs one sha256). */
const MAX_CUT_TOKENS = 600

/** heck-style snake_case (what Anchor's `#[program]` handler names are): "ClaimFeeV2" → "claim_fee_v2". */
export function toSnakeCase(name: string): string {
  const words: string[] = []
  for (const part of name.split(/[^A-Za-z0-9]+/)) {
    if (!part) continue
    let cur = ''
    for (let i = 0; i < part.length; i++) {
      const c = part[i]
      const prev = part[i - 1]
      const next = part[i + 1]
      const up = c >= 'A' && c <= 'Z'
      if (cur && up) {
        const prevLow = prev >= 'a' && prev <= 'z'
        const prevDigit = prev >= '0' && prev <= '9'
        const prevUp = prev >= 'A' && prev <= 'Z'
        const nextLow = next !== undefined && next >= 'a' && next <= 'z'
        if (prevLow || prevDigit || (prevUp && nextLow)) {
          words.push(cur)
          cur = ''
        }
      }
      cur += c
    }
    if (cur) words.push(cur)
  }
  return words.map((w) => w.toLowerCase()).join('_')
}

/** "claim_fee_v2" → "ClaimFeeV2" (the spelling of Anchor's "Instruction: …" log). */
export function toPascalCase(snake: string): string {
  return snake
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')
}

/** Anchor discriminator: sha256("<namespace>:<name>")[0..8]. */
export function anchorDisc(namespace: 'global' | 'account' | 'event', name: string): Buffer {
  return createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8)
}

export const hex8 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, 8).toString('hex')

// ─── ELF layout ─────────────────────────────────────────────────────────────

export interface Regions {
  /** Executable sections (scanned for lddw at 8-byte steps). */
  code: [number, number][]
  /** Other allocated / read-only sections (scanned byte by byte). */
  data: [number, number][]
  /** True when section headers were read; otherwise the whole file is scanned both ways. */
  parsed: boolean
}

/**
 * The code hash rule trims the trailing zero padding, which usually eats the zero tail of the last section
 * header (the table sits at the end of the file): put those zeros back (at most one header table) so the
 * section headers can be read. Returns the input when nothing is missing.
 */
export function restoreSectionTail(b: Buffer): Buffer {
  if (b.length < 64 || b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46 || b[4] !== 2 || b[5] !== 1) return b
  const shoff = Number(b.readBigUInt64LE(0x28))
  const need = shoff + b.readUInt16LE(0x3c) * b.readUInt16LE(0x3a)
  if (shoff > 0 && shoff < b.length && need > b.length && need - b.length <= 512 * 64) {
    const padded = Buffer.alloc(need)
    b.copy(padded)
    return padded
  }
  return b
}

/** Code / data regions from the section headers; the whole file both ways when they cannot be read. */
export function elfRegions(elf: Uint8Array): Regions {
  const b = Buffer.isBuffer(elf) ? elf : Buffer.from(elf.buffer, elf.byteOffset, elf.byteLength)
  const whole: Regions = { code: [[0, b.length]], data: [[0, b.length]], parsed: false }
  if (b.length < 64 || b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46 || b[4] !== 2 || b[5] !== 1) return whole
  try {
    const shoff = Number(b.readBigUInt64LE(0x28))
    const shentsize = b.readUInt16LE(0x3a)
    const shnum = b.readUInt16LE(0x3c)
    if (!shoff || shentsize < 64 || !shnum || shnum > 512 || shoff + shnum * shentsize > b.length) return whole
    const code: [number, number][] = []
    const data: [number, number][] = []
    for (let i = 0; i < shnum; i++) {
      const o = shoff + i * shentsize
      const type = b.readUInt32LE(o + 4)
      const flags = Number(b.readBigUInt64LE(o + 8))
      const off = Number(b.readBigUInt64LE(o + 24))
      const size = Number(b.readBigUInt64LE(o + 32))
      if (type !== 1 || !size || off >= b.length) continue // SHT_PROGBITS only
      const end = Math.min(b.length, off + size)
      if (flags & 0x4) code.push([off, end])
      else if (flags & 0x2) data.push([off, end]) // SHF_ALLOC: .rodata, .data.rel.ro, .data
    }
    if (!code.length && !data.length) return whole
    return { code, data, parsed: true }
  } catch {
    return whole
  }
}

// ─── strings ────────────────────────────────────────────────────────────────

/** Printable ASCII runs of at least `min` bytes (counted, not kept). */
export function countStrings(b: Uint8Array, min = 6): number {
  let n = 0
  let run = 0
  for (let i = 0; i < b.length; i++) {
    const c = b[i]
    if (c >= 0x20 && c < 0x7f) run++
    else {
      if (run >= min) n++
      run = 0
    }
  }
  return run >= min ? n + 1 : n
}

const MARK = Buffer.from('Instruction: ', 'latin1')
const isIdent = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f

export interface LogToken {
  text: string
  /** True when the next string literal is another "Instruction: " log: the token is the whole name. */
  clean: boolean
}

/** The identifier run after each "Instruction: " marker (it may run into the next string literal). */
export function logTokens(b: Buffer): LogToken[] {
  const out: LogToken[] = []
  const seen = new Set<string>()
  let from = 0
  for (let guard = 0; guard < 5000; guard++) {
    const at = b.indexOf(MARK, from)
    if (at < 0) break
    const s = at + MARK.length
    let e = s
    let clean = false
    while (e < b.length && isIdent(b[e])) {
      // the next literal can be another "Instruction: " log
      if (b[e] === 0x49 && b.compare(MARK, 0, MARK.length, e, Math.min(b.length, e + MARK.length)) === 0) {
        clean = true
        break
      }
      if (e - s >= MAX_TOKEN) break // over-long run: kept truncated, never clean
      e++
    }
    from = Math.max(e, s)
    const t = b.toString('latin1', s, e)
    // names start with a capital letter (Anchor logs the handler's UpperCamelCase name)
    if (t.length >= 2 && /^[A-Z]/.test(t) && !seen.has(t)) {
      seen.add(t)
      out.push({ text: t, clean })
    }
  }
  return out
}

/** Words of a PascalCase name ("SetOftConfigV2" → Set, Oft, Config, V2). */
export function wordsOf(name: string): string[] {
  return toSnakeCase(name).split('_').filter(Boolean)
}

/**
 * Every prefix of a glued token, longest first ("ClaimFinisherxy" → "ClaimFinisherx", …, "Cl"): a Rust string
 * literal can end anywhere inside an identifier run (the next literal may start with a capital, a lower-case
 * letter, a digit or "_"), so each cut is tried and only a cut confirmed by its discriminator is ever taken.
 * No word list is involved: the result does not depend on the dictionary.
 */
export function cutsOf(token: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([toSnakeCase(token)])
  for (let i = token.length - 1; i >= 2; i--) {
    const t = token.slice(0, i)
    if (t.endsWith('_')) continue
    const snake = toSnakeCase(t)
    if (!snake || seen.has(snake)) continue
    seen.add(snake)
    out.push(t)
  }
  return out
}

/** Anchor's built-in error names: a log literal is often followed by one of them in the executable. */
export const ANCHOR_ERROR_NAMES = new Set(
  (
    'InstructionMissing InstructionFallbackNotFound InstructionDidNotDeserialize InstructionDidNotSerialize IdlInstructionStub IdlInstructionInvalidProgram IdlAccountNotEmpty ' +
    'EventInstructionStub ConstraintMut ConstraintHasOne ConstraintSigner ConstraintRaw ConstraintOwner ConstraintRentExempt ConstraintSeeds ConstraintExecutable ConstraintState ' +
    'ConstraintAssociated ConstraintAssociatedInit ConstraintClose ConstraintAddress ConstraintZero ConstraintTokenMint ConstraintTokenOwner ConstraintMintMintAuthority ' +
    'ConstraintMintFreezeAuthority ConstraintMintDecimals ConstraintSpace ConstraintAccountIsNone ConstraintTokenTokenProgram ConstraintMintTokenProgram ' +
    'ConstraintAssociatedTokenTokenProgram RequireViolated RequireEqViolated RequireKeysEqViolated RequireNeqViolated RequireKeysNeqViolated RequireGtViolated RequireGteViolated ' +
    'AccountDiscriminatorAlreadySet AccountDiscriminatorNotFound AccountDiscriminatorMismatch AccountDidNotDeserialize AccountDidNotSerialize AccountNotEnoughKeys ' +
    'AccountNotMutable AccountOwnedByWrongProgram InvalidProgramId InvalidProgramExecutable AccountNotSigner AccountNotSystemOwned AccountNotInitialized ' +
    'AccountNotProgramData AccountNotAssociatedTokenAccount AccountSysvarMismatch AccountReallocExceedsLimit AccountDuplicateReallocs DeclaredProgramIdMismatch ' +
    'TryingToInitPayerAsProgramAccount InvalidNumericConversion Deprecated ProgramError'
  ).split(' '),
)

/** Framework words a log literal can be followed by (cut from the end of a clean token). */
const TAIL_WORDS = /(?:ProgramError|Program|Error|Instruction)+$/

/** PascalCase words ("SetOftConfigV2" → Set, Oft, Config, V2), case kept. */
const pascalWords = (t: string) => t.match(/[A-Z0-9][a-z0-9]*|[a-z0-9]+/g) ?? [t]

/** A glued token without a trailing error name ("SetMaxAccountNotSigner" → "SetMax" when AccountNotSigner is an error name). */
export function stripErrorSuffix(token: string, isError: (n: string) => boolean): string {
  const w = pascalWords(token)
  for (let k = 1; k < w.length; k++) {
    const suffix = w.slice(k).join('')
    if (ANCHOR_ERROR_NAMES.has(suffix) || isError(suffix)) return w.slice(0, k).join('')
  }
  return token
}

/** Anchor's own IDL-management instructions (their dispatch tag is not a discriminator of their name). */
export const ANCHOR_IDL_INSTRUCTIONS = ['IdlCreateAccount', 'IdlResizeAccount', 'IdlCloseAccount', 'IdlCreateBuffer', 'IdlWrite', 'IdlSetBuffer', 'IdlSetAuthority']

// ─── crates ─────────────────────────────────────────────────────────────────

// a crate directory in a source path: "<sep><crate>-<semver><sep>" — cargo's registry checkout
// (…/registry/src/<index>/anchor-lang-0.29.0/src/…) or a vendored copy; forward or back slashes
const CRATE_RE = /[\\/]([A-Za-z][A-Za-z0-9_-]{0,63}?)-(\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,24})?(?:\+[0-9A-Za-z.]{1,24})?)[\\/]/g

/**
 * Crate name + version from crate directories in source paths (panic locations). Only those two fields leave
 * this function: the directories around them (home directory, user name, index hash) are never returned.
 */
export function parseCrates(text: string): BinCrate[] {
  const out = new Map<string, BinCrate>()
  const stdRoots = toolchainRoots(text)
  CRATE_RE.lastIndex = 0
  for (let m = CRATE_RE.exec(text), i = 0; m && out.size < 200 && i < 20_000; m = CRATE_RE.exec(text), i++) {
    const name = m[1].toLowerCase()
    const version = m[2]
    CRATE_RE.lastIndex = m.index + m[0].length - 1 // the closing separator can open the next match
    // the semver must end at the directory: "foo-1.2.3/" (not "foo-1.2.3.4/")
    if (!/^[a-z][a-z0-9_-]*[a-z0-9]$/.test(name)) continue
    // a dependency of Rust's own std (hashbrown, …) checked out under the same home as the toolchain's library
    // sources: built into platform-tools, not chosen by the program (the root is compared here, never returned)
    const toolchain = STD_DEPS.has(name) && stdRoots.has(rootOf(text, m.index))
    const k = `${name}@${version}`
    const cur = out.get(k)
    if (!cur) out.set(k, toolchain ? { name, version, toolchain: true } : { name, version })
    else if (cur.toolchain && !toolchain) delete cur.toolchain
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

/** Crates Rust's std itself depends on (vendored into the toolchain build). */
const STD_DEPS = new Set(['hashbrown', 'compiler_builtins', 'rustc-demangle', 'addr2line', 'gimli', 'object', 'miniz_oxide', 'adler', 'adler2', 'std_detect', 'dlmalloc', 'unwinding', 'rustc-std-workspace-core', 'rustc-std-workspace-alloc'])

/** The home directory nearest before `at` ("/home/runner/"); compared internally, never returned. */
function rootOf(text: string, at: number): string {
  const s = text.slice(Math.max(0, at - 300), at + 1)
  const re = /[\\/](?:home|Users)[\\/][^\\/]{1,64}[\\/]|[\\/]root[\\/]/g
  let last = ''
  for (let m = re.exec(s), i = 0; m && i < 50; m = re.exec(s), i++) last = m[0]
  return last
}

/** Roots of the toolchain's own library sources (".../library/core/src/..."); internal only. */
function toolchainRoots(text: string): Set<string> {
  const out = new Set<string>()
  for (const lib of ['library/core/src/', 'library/alloc/src/', 'library/std/src/']) {
    let from = 0
    for (let n = 0; n < 50; n++) {
      const at = text.indexOf(lib, from)
      if (at < 0) break
      from = at + lib.length
      const r = rootOf(text, at)
      if (r) out.add(r)
    }
  }
  return out
}

const STD_CRATES = new Set(['core', 'alloc', 'std', 'src', 'registry', 'library', 'rustc', 'cargo', 'home', 'users', 'runner', 'root', 'build', 'target', 'tmp', 'workspace', 'app', 'programs', 'program'])

// a relative workspace path "programs/<crate>/src/<file>.rs" or "<crate>/src/<file>.rs" preceded by a separator
const OWN_RE = /(?:^|[\\/])programs[\\/]([a-z][a-z0-9_-]{1,63})[\\/]src[\\/][A-Za-z0-9_\\/-]{1,80}\.rs/g
const ANY_RE = /(?:^|[^A-Za-z0-9_-])([a-z][a-z0-9_-]{1,63})[\\/]src[\\/][A-Za-z0-9_\\/-]{1,80}\.rs/g

/**
 * The program's own crate: the workspace crate named most often in relative source paths
 * ("programs/<crate>/src/…"), registry crates excluded. Name only; null when there is none.
 */
export function programCrateOf(text: string, crates: BinCrate[]): string | null {
  const registry = new Set(crates.map((c) => c.name))
  const count = new Map<string, number>()
  const files = new Map<string, Set<string>>()
  const ok = (n: string) =>
    !(STD_CRATES.has(n) || registry.has(n) || /^\d/.test(n)) &&
    // a build directory id (UUID, or a hex run with digits: "5ab3f1a7-1ee8-…") is not a crate name
    !(/[0-9a-f]{8}-[0-9a-f]{4}/.test(n) || /(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}/.test(n))
  OWN_RE.lastIndex = 0
  for (let m = OWN_RE.exec(text), i = 0; m && i < 5000; m = OWN_RE.exec(text), i++) {
    // "<…>/<dir>/programs/<crate>/src": the crate is a workspace member's name, never a directory above it
    if (ok(m[1])) count.set(m[1], (count.get(m[1]) ?? 0) + 3)
  }
  ANY_RE.lastIndex = 0
  for (let m = ANY_RE.exec(text), i = 0; m && i < 5000; m = ANY_RE.exec(text), i++) {
    // relative paths only: a directory inside an absolute path (/home/<user>/src/…, C:\Users\…) could be a
    // user name, so the whole path is skipped; registry / git / toolchain paths are not the program's own
    const at = m.index + m[0].indexOf(m[1])
    let s = at
    while (s > 0 && at - s < 200 && /[A-Za-z0-9._\-\\/:~]/.test(text[s - 1])) s--
    const prefix = text.slice(s, at + 1)
    if (/^(?:[\\/~]|[A-Za-z]:)/.test(prefix) || /(?:^|[\\/])(?:home|Users|root|runner|tmp|mnt|var|opt|workspace|registry|checkouts|rustc|cargo)[\\/]/i.test(prefix)) continue
    if (!ok(m[1])) continue
    // the literal before a path can run into it ("…value" + "my_prog/src/lib.rs"): a bare directory counts only
    // when two different source files name it (two literals glued the same way are not expected)
    const f = files.get(m[1]) ?? new Set<string>()
    f.add(m[0].slice(m[0].indexOf(m[1]) + m[1].length))
    files.set(m[1], f)
  }
  for (const [n, f] of files) if (f.size >= 2) count.set(n, (count.get(n) ?? 0) + f.size)
  let best: string | null = null
  let bestN = 0
  for (const [k, v] of count) if (v > bestN || (v === bestN && best !== null && k < best)) [best, bestN] = [k, v]
  return bestN >= 2 ? best : null
}

// ─── framework ──────────────────────────────────────────────────────────────

export function detectFramework(text: string, crates: BinCrate[]): { name: BinFramework; version: string | null; evidence: string[] } {
  const ver = (n: string) => crates.filter((c) => c.name === n).map((c) => c.version).sort().pop() ?? null
  const ev: string[] = []
  const anchorLang = ver('anchor-lang')
  if (anchorLang || text.includes('AnchorError occurred') || text.includes('AnchorError thrown')) {
    if (anchorLang) ev.push(`crate anchor-lang ${anchorLang}`)
    if (text.includes('AnchorError')) ev.push('Anchor error-log format string')
    return { name: 'anchor', version: anchorLang, evidence: ev }
  }
  const steel = ver('steel')
  if (steel) return { name: 'steel', version: steel, evidence: [`crate steel ${steel}`] }
  const pino = ver('pinocchio')
  if (pino) return { name: 'pinocchio', version: pino, evidence: [`crate pinocchio ${pino}`] }
  const sp = ver('solana-program') ?? ver('solana-program-entrypoint')
  if (sp) return { name: 'native', version: sp, evidence: [`crate solana-program ${sp}, no Anchor strings`] }
  return { name: 'unknown', version: null, evidence: [] }
}

// ─── the discriminator pass ─────────────────────────────────────────────────

/** A discriminator to look for: what it names and the halves to compare. */
export interface DiscProbe {
  key: string
  lo: number
  hi: number
}

export function probeOf(key: string, disc: Uint8Array): DiscProbe {
  const b = Buffer.from(disc.buffer, disc.byteOffset, 8)
  return { key, lo: b.readUInt32LE(0), hi: b.readUInt32LE(4) }
}

/** Index of probes by low half. */
export function indexProbes(probes: DiscProbe[]): Map<number, DiscProbe[]> {
  const m = new Map<number, DiscProbe[]>()
  for (const p of probes) {
    const l = m.get(p.lo)
    if (l) l.push(p)
    else m.set(p.lo, [p])
  }
  return m
}

/**
 * One pass over the executable: which probes appear, and where (code: lddw immediate pair; data: 8 bytes).
 * `indexes` are looked up in order; a key found in code is not reported again from data.
 */
export async function findDiscs(b: Buffer, regions: Regions, indexes: Map<number, DiscProbe[]>[], pause?: () => Promise<void>): Promise<Map<string, DiscSite>> {
  const found = new Map<string, DiscSite>()
  const hit = (lo: number, hi: number, site: DiscSite) => {
    for (const ix of indexes) {
      const l = ix.get(lo)
      if (!l) continue
      for (const p of l) if (p.hi === hi && !found.has(p.key)) found.set(p.key, site)
    }
  }
  const u32 = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
  for (const [s, e] of regions.code) {
    for (let c = s; c < e; c += CHUNK) {
      const end = Math.min(e, c + CHUNK)
      for (let o = c; o + 16 <= end + 8 && o + 16 <= b.length; o += 8) {
        if (b[o] !== 0x18 || b[o + 8] !== 0) continue
        const lo = u32(o + 4)
        let any = false
        for (const ix of indexes) if (ix.has(lo)) any = true
        if (any) hit(lo, u32(o + 12), 'code')
      }
      if (pause) await pause()
    }
  }
  for (const [s, e] of regions.data) {
    for (let c = s; c < e; c += CHUNK) {
      const end = Math.min(e, c + CHUNK)
      for (let o = c; o < end && o + 8 <= b.length; o++) {
        const lo = u32(o)
        let any = false
        for (const ix of indexes) if (ix.has(lo)) any = true
        if (any) hit(lo, u32(o + 4), 'data')
      }
      if (pause) await pause()
    }
  }
  return found
}

/** Error messages of the dictionary found verbatim in the data sections. */
export async function findMessages(b: Buffer, regions: Regions, byLo: Map<number, string[]>, pause?: () => Promise<void>): Promise<Set<string>> {
  const out = new Set<string>()
  const u32 = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
  const scan = regions.parsed ? regions.data : [[0, b.length] as [number, number]]
  for (const [s, e] of scan) {
    for (let c = s; c < e; c += CHUNK) {
      const end = Math.min(e, c + CHUNK)
      for (let o = c; o < end && o + 4 <= b.length; o++) {
        const l = byLo.get(u32(o))
        if (!l) continue
        for (const msg of l) {
          if (out.has(msg) || o + msg.length > b.length) continue
          if (b.toString('latin1', o, o + msg.length) === msg) out.add(msg)
        }
      }
      if (pause) await pause()
    }
  }
  return out
}

// ─── recovery ───────────────────────────────────────────────────────────────

export interface Recovered {
  framework: { name: BinFramework; version: string | null; evidence: string[] }
  crates: BinCrate[]
  programCrate: string | null
  instructions: BinInstruction[]
  /** Unconfirmed log fragments: glued "Instruction: …" runs whose end no discriminator confirms (not counted). */
  fragments: string[]
  calls: BinCall[]
  accounts: BinAccount[]
  events: BinEvent[]
  errors: BinError[]
  strings: { total: number; logs: number }
  more: { instructions?: number; calls?: number; accounts?: number; events?: number; errors?: number; fragments?: number }
  notes: string[]
  /** Log-proven names (PascalCase) to teach the dictionary. */
  learned: string[]
  /** Of `checkNames`, those whose Anchor discriminator is in the executable. */
  inCode: string[]
}

export interface RecoverOptions {
  /** Leave-one-out: dictionary entries known only from this program's own IDL / strings are ignored. */
  exclude?: string
  /** snake_case instruction names (a published IDL's) to look up by their Anchor discriminator: the blind check. */
  checkNames?: string[]
  pause?: () => Promise<void>
}

const usable = (e: DictEntry, exclude?: string) => !exclude || e.idls + e.logs - (e.src.includes(exclude) ? 1 : 0) > 0

interface Cand {
  pascal: string
  snake: string
}

/** Recover the interface of one executable against the dictionary. */
export async function recoverInterface(elf: Uint8Array, dict: Dictionary, o: RecoverOptions = {}): Promise<Recovered> {
  const b = restoreSectionTail(Buffer.isBuffer(elf) ? elf : Buffer.from(elf.buffer, elf.byteOffset, elf.byteLength))
  const notes: string[] = []
  const regions = elfRegions(b)
  if (!regions.parsed) notes.push('section headers not read: the whole file was scanned as code and data')
  const text = b.toString('latin1')
  const crates = parseCrates(text)
  const programCrate = programCrateOf(text, crates)
  const framework = detectFramework(text, crates)
  if (o.pause) await o.pause()

  // log tokens → candidate names, each with its discriminator.
  //   clean token (the next literal is another log string): the whole token is the name; a trailing Anchor /
  //     IDL error name or a framework word ("…V2" + "ProgramError") may be cut from it
  //   every token whose whole name is not confirmed: each shorter prefix is tried (a second pass over the
  //     bytes); a prefix is taken only when its discriminator is in the executable. An unconfirmed glued
  //     token, or one with "_" (Anchor logs UpperCamelCase names), is an unconfirmed fragment, never counted
  const tokens = logTokens(b)
  const own = new Map<string, DiscProbe>()
  const probe = (m: Map<string, DiscProbe>, c: Cand) => {
    const k = `g:${c.snake}`
    if (!own.has(k) && !m.has(k)) m.set(k, probeOf(k, anchorDisc('global', c.snake)))
  }
  const isError = (n: string) => dict.knownErrorName(n, o.exclude)
  const info: { t: LogToken; primary: Cand[]; cuts: Cand[]; shown: Cand }[] = []
  for (const t of tokens) {
    if (ANCHOR_IDL_INSTRUCTIONS.some((x) => t.text.startsWith(x))) continue
    const stripped = stripErrorSuffix(t.text, isError)
    const bases = t.clean ? [t.text, stripped, stripped.replace(TAIL_WORDS, '')] : [t.text]
    const primary = [...new Set(bases)].filter((x) => x.length >= 2).map((p) => ({ pascal: p, snake: toSnakeCase(p) }))
    for (const c of primary) probe(own, c)
    const sp = stripped.length >= 2 ? stripped : t.text
    info.push({ t, primary, cuts: [], shown: { pascal: sp, snake: toSnakeCase(sp) } })
  }
  const check = new Map<string, DiscProbe>()
  for (const n of (o.checkNames ?? []).slice(0, 2000)) check.set(`c:${n}`, probeOf(`c:${n}`, anchorDisc('global', n)))
  const found = await findDiscs(b, regions, [indexProbes([...own.values()]), dict.index, indexProbes([...check.values()])], o.pause)

  const ix = new Map<string, BinInstruction>()
  const take = (c: Cand) => ix.set(c.snake, { name: c.snake, evidence: 'log+disc', logName: c.pascal, disc: hex8(anchorDisc('global', c.snake)), site: found.get(`g:${c.snake}`) })
  // 1. tokens whose whole name is confirmed
  const open: typeof info = []
  for (const x of info) {
    const conf = x.primary.find((c) => found.has(`g:${c.snake}`))
    if (conf && !ix.has(conf.snake)) take(conf)
    else if (!conf) open.push(x)
  }
  // 2. the others: every prefix, looked up in one more pass (only when some token is still open)
  const cutProbes = new Map<string, DiscProbe>()
  for (const x of open.slice(0, MAX_CUT_TOKENS)) {
    x.cuts = cutsOf(x.t.text).map((p) => ({ pascal: p, snake: toSnakeCase(p) }))
    for (const c of x.cuts) probe(cutProbes, c)
    if (o.pause && cutProbes.size > 4000) await o.pause()
  }
  if (cutProbes.size) for (const [k, v] of await findDiscs(b, regions, [indexProbes([...cutProbes.values()])], o.pause)) if (!found.has(k)) found.set(k, v)
  // 3. cut back to the longest confirmed prefix; a clean, well-formed log string kept as logged; the rest are fragments
  const fragments: string[] = []
  for (const x of open) {
    const conf = x.cuts.find((c) => found.has(`g:${c.snake}`) && !ix.has(c.snake))
    if (conf) take(conf)
    else if (x.t.clean && !x.shown.pascal.includes('_')) {
      const p = x.shown // the logged name, a trailing error name cut
      if (!ix.has(p.snake)) ix.set(p.snake, { name: p.snake, evidence: 'log', logName: p.pascal })
    } else if (!x.cuts.some((c) => ix.has(c.snake) && found.has(`g:${c.snake}`))) fragments.push(x.t.text)
  }
  const learned = [...ix.values()].filter((x) => x.evidence === 'log+disc').map((x) => x.logName!)

  // dictionary discriminators found: account types, events, and instruction discriminators other IDLs name
  // (this program's own handlers when it logs no names, or instructions it sends to other programs)
  const accounts: BinAccount[] = []
  const events: BinEvent[] = []
  const calls: BinCall[] = []
  const inCode: string[] = []
  for (const [key, site] of found) {
    if (key.startsWith('c:')) {
      inCode.push(key.slice(2))
      continue
    }
    const e = dict.entry(key)
    if (!e || !usable(e, o.exclude)) continue
    const custom = e.sha ? {} : { custom: true as const }
    if (e.kind === 'ix') {
      if (ix.has(e.name)) continue // this program's own instruction (its log string names it)
      calls.push({ name: e.name, disc: hex8(e.disc), site, idls: e.idls, programs: e.src.filter((x) => x !== o.exclude && !x.startsWith('bin:')).slice(0, 4), ...custom })
    } else {
      const item = { name: e.name, disc: hex8(e.disc), site, idls: e.idls, ...custom }
      if (e.kind === 'account') accounts.push(item)
      else events.push(item)
    }
  }
  if (o.pause) await o.pause()

  // error messages of published IDLs found verbatim
  const msgs = await findMessages(b, regions, dict.errorIndex, o.pause)
  const errors: BinError[] = []
  for (const m of msgs) {
    const e = dict.error(m)
    if (!e) continue
    const n = e.idls - (o.exclude && e.src.includes(o.exclude) ? 1 : 0)
    if (n <= 0) continue
    errors.push({ name: e.name, msg: m, idls: n })
  }

  const proven = [...ix.values()]
  proven.sort((a, b) => (a.evidence === b.evidence ? a.name.localeCompare(b.name) : a.evidence === 'log+disc' ? -1 : 1))
  calls.sort((a, b) => (a.site === b.site ? 0 : a.site === 'code' ? -1 : 1) || b.idls - a.idls || a.name.localeCompare(b.name))
  accounts.sort((a, b) => a.name.localeCompare(b.name))
  events.sort((a, b) => a.name.localeCompare(b.name))
  errors.sort((a, b) => b.idls - a.idls || a.msg.localeCompare(b.msg))
  fragments.sort()
  const more: Recovered['more'] = {}
  if (proven.length > MAX_INSTRUCTIONS) more.instructions = proven.length - MAX_INSTRUCTIONS
  if (calls.length > MAX_CALLS) more.calls = calls.length - MAX_CALLS
  if (accounts.length > MAX_ACCOUNTS) more.accounts = accounts.length - MAX_ACCOUNTS
  if (events.length > MAX_EVENTS) more.events = events.length - MAX_EVENTS
  if (errors.length > MAX_ERRORS) more.errors = errors.length - MAX_ERRORS
  if (fragments.length > MAX_FRAGMENTS) more.fragments = fragments.length - MAX_FRAGMENTS
  return {
    framework,
    crates,
    programCrate,
    instructions: proven.slice(0, MAX_INSTRUCTIONS),
    fragments: fragments.slice(0, MAX_FRAGMENTS),
    calls: calls.slice(0, MAX_CALLS),
    accounts: accounts.slice(0, MAX_ACCOUNTS),
    events: events.slice(0, MAX_EVENTS),
    errors: errors.slice(0, MAX_ERRORS),
    strings: { total: countStrings(b), logs: tokens.length },
    more,
    notes,
    learned,
    inCode: inCode.sort(),
  }
}
