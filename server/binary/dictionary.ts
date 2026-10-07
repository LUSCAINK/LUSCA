// READ THE BINARY — the dictionary: every name LUSCA's published IDLs define (instructions, account types,
// events, error messages), with its Anchor discriminator, plus instruction names proven by the log strings of
// executables already read. Each entry remembers how many IDLs name it and a few of the programs it came from,
// so a blind check can leave one program out (its own IDL does not help it).
//
// IDL dialects: Anchor ≤ 0.29 (camelCase names, no discriminators), Anchor ≥ 0.30 (snake_case names and
// explicit discriminators — used as given, so custom discriminators match too), Codama (names; Anchor
// discriminators computed).
//
// Entries are keyed by kind, name AND discriminator: "g:<name>" for the Anchor (sha256) discriminator of the
// name, "g:<name>#<hex>" for a custom one an IDL declares. Low-entropy discriminators (four or more zero bytes,
// or fewer than five distinct byte values: 00..00, 01 00..00, a small integer) are left out: such 8-byte values
// occur in almost every executable and prove nothing.

import { anchorDisc, indexProbes, probeOf, toSnakeCase, type DiscProbe } from './extract.ts'
import { idlFormat } from '../chain/solana/idl.ts'

export interface DictEntry {
  key: string
  kind: 'ix' | 'account' | 'event'
  name: string
  disc: Buffer
  /** True when disc is sha256("<namespace>:<name>")[0..8]; false for a custom discriminator an IDL declares. */
  sha: boolean
  /** Published IDLs naming it. */
  idls: number
  /** Executables whose log strings proved it. */
  logs: number
  /** A few programs it came from (leave-one-out). */
  src: string[]
}

export interface DictError {
  name: string | null
  idls: number
  src: string[]
}

const MAX_SRC = 4
const MAX_ENTRIES = 200_000
const MAX_ERRORS = 60_000
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.length <= 120 ? v.trim() : null)
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/

/** An 8-byte discriminator array from an IDL (Anchor ≥ 0.30), or null. */
function discOf(v: unknown): Buffer | null {
  const a = arr(v)
  if (a.length !== 8 || !a.every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 255)) return null
  return Buffer.from(a as number[])
}

/** An 8-byte value too regular to identify anything: four or more zero bytes, or fewer than five distinct bytes. */
export function lowEntropy(d: Uint8Array): boolean {
  let zeros = 0
  for (const x of d) if (x === 0) zeros++
  return zeros >= 4 || new Set(d).size < 5
}

/** Messages worth a verbatim search: long enough not to match by accident inside other text. */
export function usableMessage(m: string): boolean {
  return m.length <= 200 && (m.length >= 20 || (m.length >= 12 && m.includes(' '))) && /^[\x20-\x7e]+$/.test(m)
}

export class Dictionary {
  private entries = new Map<string, DictEntry>()
  private errors = new Map<string, DictError & { names: Map<string, number> }>()
  private idlSet = new Set<string>()
  /** Custom error names → how many IDLs define them and a few of those programs (leave-one-out). */
  private errorNames = new Map<string, { n: number; src: string[] }>()
  /** Explicit discriminators left out as low-entropy (counted). */
  lowEntropySkipped = 0
  private dirty = true
  private idx: Map<number, DiscProbe[]> = new Map()
  private errIdx: Map<number, string[]> = new Map()

  get idls(): number {
    return this.idlSet.size
  }

  has(address: string): boolean {
    return this.idlSet.has(address)
  }

  counts() {
    let instructions = 0
    let accounts = 0
    let events = 0
    for (const e of this.entries.values()) {
      if (e.kind === 'ix') instructions++
      else if (e.kind === 'account') accounts++
      else events++
    }
    return { idls: this.idlSet.size, instructions, accounts, events, errors: this.errors.size }
  }

  get size(): number {
    return this.entries.size + this.errors.size
  }

  entry(key: string): DictEntry | undefined {
    return this.entries.get(key)
  }

  error(msg: string): DictError | undefined {
    return this.errors.get(msg)
  }

  /** A custom error name some published IDL defines ("InvalidAmount"), the excluded program's own IDL left out. */
  knownErrorName(n: string, exclude?: string): boolean {
    const e = this.errorNames.get(n)
    if (!e) return false
    return !exclude || e.n - (e.src.includes(exclude) ? 1 : 0) > 0
  }

  /** Probes by low half (rebuilt after changes). */
  get index(): Map<number, DiscProbe[]> {
    this.rebuild()
    return this.idx
  }

  /** Usable error messages by their first four bytes. */
  get errorIndex(): Map<number, string[]> {
    this.rebuild()
    return this.errIdx
  }

  private rebuild() {
    if (!this.dirty) return
    this.dirty = false
    this.idx = indexProbes([...this.entries.values()].map((e) => probeOf(e.key, e.disc)))
    const m = new Map<number, string[]>()
    for (const msg of this.errors.keys()) {
      const b = Buffer.from(msg, 'latin1')
      const lo = b.readUInt32LE(0)
      const l = m.get(lo)
      if (l) l.push(msg)
      else m.set(lo, [msg])
    }
    this.errIdx = m
  }

  private put(kind: DictEntry['kind'], name: string, disc: Buffer, from: string, viaLog: boolean) {
    const ns = kind === 'ix' ? 'global' : kind
    const sha = anchorDisc(ns, name).equals(disc)
    if (lowEntropy(disc)) {
      this.lowEntropySkipped++
      return
    }
    const p = kind === 'ix' ? 'g' : kind === 'account' ? 'a' : 'e'
    const key = sha ? `${p}:${name}` : `${p}:${name}#${disc.toString('hex')}`
    const cur = this.entries.get(key)
    if (cur) {
      if (cur.src.includes(from)) return
      if (viaLog) cur.logs++
      else cur.idls++
      if (cur.src.length < MAX_SRC) cur.src.push(from)
      return
    }
    if (this.entries.size >= MAX_ENTRIES) return
    this.entries.set(key, { key, kind, name, disc, sha, idls: viaLog ? 0 : 1, logs: viaLog ? 1 : 0, src: [from] })
    this.dirty = true
  }

  /** Add one program's published IDL. Returns false when the JSON is not an IDL or was added before. */
  addIdl(address: string, json: unknown): boolean {
    if (this.idlSet.has(address)) return false
    const fmt = idlFormat(json)
    if (!fmt) return false
    this.idlSet.add(address)
    const o = json as Record<string, unknown>
    const p = fmt === 'codama' ? (obj(o.program) ?? {}) : o
    for (const i of arr(p.instructions)) {
      const io = obj(i)
      const n = str(io?.name)
      if (!io || !n || !NAME_RE.test(n)) continue
      const snake = toSnakeCase(n)
      const given = fmt === 'anchor' ? discOf(io.discriminator) : null
      this.put('ix', snake, given ?? anchorDisc('global', snake), address, false)
    }
    for (const a of arr(p.accounts)) {
      const ao = obj(a)
      const n = str(ao?.name)
      if (!ao || !n || !NAME_RE.test(n)) continue
      const given = fmt === 'anchor' ? discOf(ao.discriminator) : null
      // account and event discriminators hash the type's own (PascalCase) name
      const pascal = fmt === 'codama' ? n[0].toUpperCase() + n.slice(1) : n
      this.put('account', pascal, given ?? anchorDisc('account', pascal), address, false)
    }
    for (const ev of arr(p.events)) {
      const eo = obj(ev)
      const n = str(eo?.name)
      if (!eo || !n || !NAME_RE.test(n)) continue
      const given = fmt === 'anchor' ? discOf(eo.discriminator) : null
      this.put('event', n, given ?? anchorDisc('event', n), address, false)
    }
    for (const er of arr(p.errors)) {
      const eo = obj(er)
      if (!eo) continue
      const code = typeof eo.code === 'number' ? eo.code : null
      if (code !== null && code < 6000) continue // Anchor's built-in errors are the framework's, not the program's
      const msg = str(eo.msg) ?? str(eo.message)
      const name = str(eo.name)
      if (name && NAME_RE.test(name) && /[A-Z].*[A-Z]/.test(name)) {
        const pn = name[0].toUpperCase() + name.slice(1)
        const en = this.errorNames.get(pn)
        if (en) {
          if (!en.src.includes(address)) {
            en.n++
            if (en.src.length < MAX_SRC) en.src.push(address)
          }
        } else if (this.errorNames.size < 50_000) this.errorNames.set(pn, { n: 1, src: [address] })
      }
      if (!msg || !usableMessage(msg)) continue
      let cur = this.errors.get(msg)
      if (!cur) {
        if (this.errors.size >= MAX_ERRORS) continue
        cur = { name: null, idls: 0, src: [], names: new Map() }
        this.errors.set(msg, cur)
        this.dirty = true
      }
      if (cur.src.includes(address)) continue
      cur.idls++
      if (cur.src.length < MAX_SRC) cur.src.push(address)
      if (name && NAME_RE.test(name)) {
        cur.names.set(name, (cur.names.get(name) ?? 0) + 1)
        let best = cur.name
        let bestN = best ? (cur.names.get(best) ?? 0) : 0
        for (const [k, v] of cur.names) if (v > bestN) [best, bestN] = [k, v]
        cur.name = best
      }
    }
    return true
  }

  /** Instruction names proven by an executable's log strings (+ discriminator): searchable in every other one. */
  addLogNames(address: string, pascalNames: string[]) {
    for (const n of pascalNames.slice(0, 400)) {
      if (!NAME_RE.test(n)) continue
      const snake = toSnakeCase(n)
      this.put('ix', snake, anchorDisc('global', snake), address, true)
    }
  }
}
