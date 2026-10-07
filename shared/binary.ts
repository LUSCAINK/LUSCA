// READ THE BINARY: the interface of Solana programs that never published an IDL, recovered from the
// program executable itself. Shared between server/binary/** and the client (src/pages/Binary.tsx).
//
// Every recovered item carries the evidence it was read from:
//   log         an "Instruction: <Name>" log string in the executable (the program logs it when it runs)
//   disc        an Anchor discriminator — sha256("global:<snake_name>")[0..8] for instructions,
//               sha256("account:<Name>")[0..8] for accounts, sha256("event:<Name>")[0..8] for events — found
//               in the executable as an 8-byte constant (`lddw` immediate pair in the code, or 8 bytes of data),
//               for a name taken from the program's own log strings or from the dictionary of published IDLs
//   dict        an error message of a published IDL found verbatim in the executable's strings
// Nothing is guessed: an item without evidence is not listed.

import type { ChainId } from './chain.ts'

export type BinFramework = 'anchor' | 'steel' | 'pinocchio' | 'native' | 'unknown'

/** Where an 8-byte discriminator was found: an `lddw` immediate in the code, or 8 contiguous bytes of data. */
export type DiscSite = 'code' | 'data'

export interface BinInstruction {
  /** snake_case name (Anchor's handler name); the log string's own spelling is in `logName`. */
  name: string
  /**
   * log+disc   log string and the Anchor discriminator of that name both in the executable
   * log        log string only (no Anchor discriminator kept as a constant: native dispatch, a per-byte dispatcher)
   */
  evidence: 'log+disc' | 'log'
  logName?: string
  /** Discriminator hex (16 chars) when one was found. */
  disc?: string
  site?: DiscSite
}

/**
 * An instruction discriminator of another program found in this executable (named by published IDLs): the
 * bytes a program needs to send that instruction (CPI). Not counted as this program's own instructions.
 */
export interface BinCall {
  name: string
  disc: string
  site: DiscSite
  /** Published IDLs that name it, and up to four of those programs. */
  idls: number
  programs: string[]
}

export interface BinAccount {
  name: string
  disc: string
  site: DiscSite
  /** Published IDLs that define this account type. */
  idls: number
}

export interface BinEvent {
  name: string
  disc: string
  site: DiscSite
  idls: number
}

export interface BinError {
  /** The error's name in the IDLs that define this message (most common spelling). */
  name: string | null
  msg: string
  /** Published IDLs with this exact message. */
  idls: number
}

export interface BinCrate {
  /** Crate name and version only (from cargo registry paths in panic locations); never a path. */
  name: string
  version: string
}

export interface BinaryInterface {
  v: 1
  chain: 'solana'
  address: string
  codeHash: string
  /** Bytes of the executable (trailing zero padding removed). */
  programBytes: number
  /** When the executable was read (ms). */
  readAt: number
  /** Who supplied the bytes: an agent read, a radar re-read after an upgrade, the background reader, Lens. */
  via: 'agent' | 'radar' | 'backfill' | 'lens'
  name: string | null
  framework: { name: BinFramework; version: string | null; evidence: string[] }
  crates: BinCrate[]
  /** The program's own crate name, from relative source paths in its panic locations (no path kept). */
  programCrate: string | null
  instructions: BinInstruction[]
  /** Instruction discriminators of other programs (CPI) found in the bytes. */
  calls: BinCall[]
  accounts: BinAccount[]
  events: BinEvent[]
  errors: BinError[]
  securityTxt: Record<string, string> | null
  /** Syscalls the executable imports or calls by hashed id (server/lens/elf-syscalls.ts). */
  syscalls: string[]
  /** Printable strings of 6+ characters found, and "Instruction: …" log strings among them. */
  strings: { total: number; logs: number }
  /** Size of the dictionary the executable was matched against at read time. */
  dictionary: { idls: number; names: number }
  /** Items left out over the list caps. */
  more?: { instructions?: number; calls?: number; accounts?: number; events?: number; errors?: number }
  notes: string[]
  /** Programs that DO publish an IDL: blind recovery (their own IDL left out of the dictionary) scored against it. */
  check?: BinCheck
}

/** Recovered instructions scored against the program's own published IDL. */
export interface BinCheck {
  idlInstructions: number
  /** Instructions recovered (log-proven) and how many of them the IDL lists. */
  recovered: number
  hit: number
  /** Recovered names the IDL does not list but whose discriminator is in the code (the IDL lags the deployed code). */
  newerThanIdl: number
  idlAccounts: number
  accountsHit: number
}

/** Census of one program in the list. */
export interface BinaryListItem {
  address: string
  name: string | null
  codeHash: string
  programBytes: number
  framework: BinFramework
  frameworkVersion: string | null
  instructions: number
  /** Of those, confirmed by a discriminator too. */
  confirmed: number
  calls: number
  accounts: number
  errors: number
  crates: number
  /** Kept in the chain index (verified build) or read and not kept. */
  kept: boolean
  readAt: number
  /** First few instruction names (confirmed first). */
  sample: string[]
}

export interface BinaryPage {
  items: BinaryListItem[]
  next: string | null
  total: number
}

export interface BinarySummary {
  /** Solana programs read without a published IDL that this server knows of (kept + read and not kept). */
  withoutIdl: number
  /** Of those, executables read and recovered. */
  processed: number
  /** Processed programs with at least one recovered instruction. */
  withInstructions: number
  /** Names recovered in total (instructions + accounts + events + errors). */
  names: number
  instructions: number
  /** Instructions confirmed by their discriminator too. */
  confirmed: number
  calls: number
  accounts: number
  errors: number
  /** Executables read in total (incl. programs that publish an IDL, read for the method check). */
  bytesRead: number
  frameworks: { name: BinFramework; count: number }[]
  /** Crate@version histogram (most common first, capped). */
  crates: { name: string; version: string; count: number }[]
  dictionary: { idls: number; instructions: number; accounts: number; events: number; errors: number; ready: boolean }
  /** Blind check on programs that publish an IDL (micro-averaged), null until any was read. */
  check: {
    programs: number
    idlInstructions: number
    recovered: number
    /** Share of recovered names the IDL lists / of IDL instructions recovered. */
    precision: number | null
    recall: number | null
    /** Recovered names absent from the IDL but confirmed by a discriminator in the code. */
    newerThanIdl: number
    accountRecall: number | null
  } | null
  /** The reader: its daily RPC slice and queue. */
  reader: { used: number; limit: number; queued: number; state: 'reading' | 'idle' | 'waiting-budget' | 'off'; lastAt: number | null }
  /** A program worth showing first: most confirmed instructions among programs without an IDL. */
  featured: string | null
  updatedAt: number
}

export const BIN_CHAIN: ChainId = 'solana'
// REST: GET /api/binary/summary -> BinarySummary ; GET /api/binary/items?cursor=&framework=&limit= -> BinaryPage ;
//       GET /api/binary/:address -> BinaryInterface | 404   (stored results only — no RPC per request)
