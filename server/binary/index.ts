// READ THE BINARY: the interface of Solana programs that never published an IDL, recovered from their
// executables (shared/binary.ts).
//
//   bytes      (1) handed over by the chain agents after each program read (the ELF they fetched anyway: no
//                  extra RPC) and by the upgrade radar after it re-reads an upgraded program
//              (2) the background reader: programs read without an IDL whose executable was not handed over
//                  (kept items first, then the newest seen), one getMultipleAccounts call each, charged to this
//                  module's own daily slice (LUSCA_BINARY_SOL_CALLS, default 250; ≤ 30 % of it per clock hour)
//                  and never below the 10 % of the shared Solana budget kept for the chain agents
//   recovery   server/binary/extract.ts against the dictionary of every published IDL LUSCA keeps
//              (server/binary/dictionary.ts) — off the request path, yielding to the event loop every 512 KB
//   cache      the RESULT per program code hash (never the executable): <data>/binary/results.jsonl
//              (append-only, compacted); a program is read again only when its code hash changes
//   check      programs that DO publish an IDL are recovered blind (their own IDL left out of the dictionary)
//              and scored against it: the method's measured precision / recall
//
// Viewers never cause RPC or recovery: the REST routes read the stored results (summary memoised 10 s).

import fs from 'node:fs'
import path from 'node:path'
import type { ChainEvent, ChainId, ChainIndexItem, ChainRead } from '../../shared/chain.ts'
import type { BinaryInterface, BinaryListItem, BinaryPage, BinarySummary, BinCheck, BinFramework } from '../../shared/binary.ts'
import { isSolanaAddress } from '../../shared/base58.ts'
import { BudgetError, redact, type RpcCtx } from '../chain/rpc.ts'
import type { ChainRecord } from '../chain/store.ts'
import { createRadarBudget, writeFileDurable, type RadarBudget } from '../radar/budget.ts'
import { LOADER_V1, LOADER_V2, LOADER_V4, UPGRADEABLE_LOADER, ZSTD_AVAILABLE, decodeAccount, parseLoaderV4, parseUpgradeable, programAddresses } from '../chain/solana/layout.ts'
import { codeHashOf, isElf, parseSecurityTxt, trimTrailingZeros } from '../chain/solana/elf.ts'
import { scanElf } from '../lens/elf-syscalls.ts'
import { Dictionary } from './dictionary.ts'
import { recoverInterface, toSnakeCase } from './extract.ts'

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

export interface BinaryStoreLike {
  items(q: { chain?: ChainId; limit?: number; cursor?: string }): { items: ChainIndexItem[]; next: string | null }
  item(chain: ChainId, address: string): { item: ChainIndexItem; read: ChainRead } | null
  record?(chain: ChainId, address: string): ChainRecord | null
}

export interface BinaryLimits {
  /** Daily getMultipleAccounts calls of the background reader. */
  solCalls: number
  hourShare: number
  /** Share of the shared Solana budget always left to the chain agents. */
  floor: number
  /** Programs WITH an IDL the background reader may read per day for the blind check. */
  checkPerDay: number
  /** Pause between background reads, ms. */
  gapMs: number
  /** Executables waiting for recovery (handed over by agents / radar); more are left to the background reader. */
  pending: number
  /** Programs remembered (census). */
  maxPrograms: number
  /** results.jsonl stops growing past this (MB); the results held in memory take about 4x its size. */
  maxResultsMb: number
  /** Largest executable recovered (bytes). */
  maxElfBytes: number
}

export const DEFAULT_BINARY_LIMITS: BinaryLimits = {
  solCalls: 250,
  hourShare: 0.3,
  floor: 0.1,
  checkPerDay: 40,
  gapMs: 6_000,
  pending: 4,
  maxPrograms: 20_000,
  maxResultsMb: 32,
  maxElfBytes: 12 * 1024 * 1024,
}

export interface BinaryDeps {
  rpc: RpcCtx
  store: BinaryStoreLike
  /** The chain feed, newest first (programs read and not kept). */
  feed: (limit: number) => ChainEvent[]
  dataDir: string
  log: Log
  limits?: Partial<BinaryLimits>
  now?: () => number
  /** Delay before the dictionary load and the first background read, ms (default 15 s). */
  startDelayMs?: number
  /** Dictionary refresh / census sweep interval, ms (default 30 min). */
  sweepMs?: number
}

export interface BinaryRouteResult {
  status: number
  json: string
  headers?: Record<string, string>
}

export interface BinaryService {
  start(): void
  stop(): Promise<void>
  /** Hook: one program executable just read (agents, radar). Cheap: queues it. */
  offer(read: ChainRead, elf: Uint8Array, via: BinaryInterface['via']): void
  summary(): BinarySummary
  list(q: { framework?: BinFramework; cursor?: string; limit?: number }): BinaryPage
  get(address: string): BinaryInterface | null
  route(p: string, params: URLSearchParams): BinaryRouteResult
  /** Load the dictionary + census now (tests / first start). */
  sweep(): Promise<void>
  /** One background read now (tests). */
  tick(): Promise<'read' | 'none' | 'budget' | 'error'>
  /** Resolves when nothing is queued or running (tests). */
  idle(): Promise<void>
}

interface ProgramRef {
  address: string
  name: string | null
  kept: boolean
  idl: boolean
  codeHash: string | null
  seenAt: number
  /** Last background attempt (ms) and its failure, if any. */
  tried?: number
  fail?: string
  /** IDL instruction / account names (programs with an IDL: the blind check). */
}

const DAY = 86_400_000
const FRAMEWORKS: BinFramework[] = ['anchor', 'steel', 'pinocchio', 'native', 'unknown']
const pause = () => new Promise<void>((r) => setImmediate(r))
const errMsg = (e: unknown) => redact(e instanceof Error ? e.message : String(e)).slice(0, 140)
const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null)

/** Score a blind recovery against the program's own IDL summary. */
export function checkAgainstIdl(r: Pick<BinaryInterface, 'instructions' | 'accounts'>, idl: { instructions: { name: string }[]; accounts: string[] }): BinCheck {
  const want = new Set(idl.instructions.map((i) => toSnakeCase(i.name)))
  const wantAcc = new Set(idl.accounts.map((a) => a.toLowerCase()))
  const hit = r.instructions.filter((i) => want.has(i.name)).length
  return {
    idlInstructions: want.size,
    recovered: r.instructions.length,
    hit,
    newerThanIdl: r.instructions.filter((i) => !want.has(i.name) && i.evidence === 'log+disc').length,
    newerNames: r.instructions
      .filter((i) => !want.has(i.name) && i.evidence === 'log+disc')
      .slice(0, 60)
      .map((i) => i.name),
    idlAccounts: wantAcc.size,
    accountsHit: r.accounts.filter((a) => wantAcc.has(a.name.toLowerCase())).length,
  }
}

/** The executable of a Solana program from one getMultipleAccounts([program, programdata]) answer. */
export async function elfFromAccounts(address: string, values: unknown[]): Promise<{ elf: Uint8Array | null; why: string | null }> {
  const acct = await decodeAccount(values[0])
  if (!acct) return { elf: null, why: 'no account at this address' }
  if (acct.owner === UPGRADEABLE_LOADER) {
    const st = parseUpgradeable(acct.data)
    if (st?.type !== 'program') return { elf: null, why: 'not a program account' }
    if (st.programData !== programAddresses(address).programData) return { elf: null, why: 'programdata address is not the canonical one' }
    const pd = await decodeAccount(values[1])
    const pst = pd && pd.owner === UPGRADEABLE_LOADER ? parseUpgradeable(pd.data) : null
    if (pst?.type !== 'programdata') return { elf: null, why: 'program closed: its programdata account is gone' }
    return { elf: pst.elf, why: null }
  }
  if (acct.owner === LOADER_V2 || acct.owner === LOADER_V1) return acct.executable ? { elf: acct.data, why: null } : { elf: null, why: 'not executable' }
  if (acct.owner === LOADER_V4) {
    const st = parseLoaderV4(acct.data)
    return st ? { elf: st.elf, why: null } : { elf: null, why: 'loader-v4 account shorter than its header' }
  }
  return { elf: null, why: 'not a program owned by a BPF loader' }
}

export function createBinary(d: BinaryDeps): BinaryService {
  const L: BinaryLimits = { ...DEFAULT_BINARY_LIMITS, ...d.limits }
  const now = d.now ?? Date.now
  const log: Log = (l, m) => d.log(l, redact(m))
  const dir = path.join(d.dataDir, 'binary')
  const resultsFile = path.join(dir, 'results.jsonl')
  const programsFile = path.join(dir, 'programs.json')
  const dict = new Dictionary()
  let dictReady = false

  // ─── state ────────────────────────────────────────────────────────────────

  const results = new Map<string, BinaryInterface>() // code hash → result
  let resultLines = 0
  let resultBytes = 0
  try {
    const text = fs.readFileSync(resultsFile, 'utf8')
    resultBytes = Buffer.byteLength(text)
    const latest = new Map<string, string>() // address → code hash of its newest line (older code is superseded)
    for (const line of text.split('\n')) {
      if (!line) continue
      resultLines++
      try {
        const r = JSON.parse(line) as BinaryInterface
        if (!(r && r.v === 1 && typeof r.codeHash === 'string' && typeof r.address === 'string')) continue
        const prev = latest.get(r.address)
        if (prev && prev !== r.codeHash && results.get(prev)?.address === r.address) results.delete(prev)
        latest.set(r.address, r.codeHash)
        results.set(r.codeHash, r)
      } catch {
        /* a torn last line */
      }
    }
  } catch {
    /* first start */
  }
  const programs = new Map<string, ProgramRef>()
  try {
    const arr = JSON.parse(fs.readFileSync(programsFile, 'utf8')) as ProgramRef[]
    if (Array.isArray(arr)) for (const p of arr) if (p && typeof p.address === 'string' && isSolanaAddress(p.address)) programs.set(p.address, p)
  } catch {
    /* first start */
  }
  // the results teach the dictionary their log-proven names again
  for (const r of results.values()) {
    const names = r.instructions.filter((i) => i.evidence === 'log+disc' && i.logName).map((i) => i.logName!)
    if (names.length) dict.addLogNames(r.address, names)
  }

  const shared = d.rpc.usage().solana
  const budget: RadarBudget = createRadarBudget({ solana: L.solCalls, check: L.checkPerDay }, path.join(dir, 'budget.json'), now, L.hourShare)
  // the check count is a daily counter, not an hourly-shared budget: give it the whole day per hour
  const sharedRoom = (n = 1) => {
    const u = d.rpc.usage().solana ?? shared
    return !u || u.limit - u.used - n >= Math.ceil(u.limit * L.floor)
  }

  let programsDirty = false
  let saveTimer: NodeJS.Timeout | null = null
  let sweepTimer: NodeJS.Timeout | null = null
  let loopTimer: NodeJS.Timeout | null = null
  let startTimer: NodeJS.Timeout | null = null
  let stopped = false
  let started = false
  let state: BinarySummary['reader']['state'] = 'idle'
  let lastAt: number | null = null
  let summaryMemo: { at: number; v: BinarySummary } | null = null
  const pending: { read: Pick<ChainRead, 'address' | 'name' | 'codeHash' | 'idl' | 'securityTxt'>; elf: Buffer; via: BinaryInterface['via'] }[] = []
  let working: Promise<void> | null = null
  let backfillRunning: Promise<unknown> | null = null

  function saveSoon() {
    programsDirty = true
    summaryMemo = null
    if (saveTimer || stopped) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      savePrograms()
    }, 30_000)
    saveTimer.unref?.()
  }

  function savePrograms() {
    if (!programsDirty) return
    programsDirty = false
    try {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${programsFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify([...programs.values()]))
      fs.renameSync(tmp, programsFile)
    } catch (e) {
      programsDirty = true
      log('warn', `binary programs.json save failed: ${errMsg(e)}`)
    }
  }

  /** results.jsonl at its cap (after dropping superseded lines): no new result is made, in memory or on disk. */
  let fullLogged = false
  function resultsFull(next?: number): boolean {
    const cap = L.maxResultsMb * 1024 * 1024
    // before a read: room for a typical result (16 KB, or a quarter of a small cap) must be left
    const extra = next ?? Math.min(16_384, cap / 4)
    if (resultBytes + extra <= cap) return false
    if (resultLines > results.size) compact()
    if (resultBytes + extra <= cap) return false
    if (!fullLogged) log('warn', `binary results are at their ${L.maxResultsMb} MB cap: no new recoveries until the cap is raised`)
    fullLogged = true
    return true
  }

  function appendResult(r: BinaryInterface) {
    const line = JSON.stringify(r) + '\n'
    if (resultsFull(Buffer.byteLength(line))) return
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(resultsFile, line)
      resultLines++
      resultBytes += Buffer.byteLength(line)
      if (resultLines > results.size * 1.5 + 50) compact()
    } catch (e) {
      log('warn', `binary result append failed: ${errMsg(e)}`)
    }
  }

  function compact() {
    try {
      const text = [...results.values()].map((r) => JSON.stringify(r) + '\n').join('')
      writeFileDurable(resultsFile, text)
      resultLines = results.size
      resultBytes = Buffer.byteLength(text)
    } catch (e) {
      log('warn', `binary results compaction failed: ${errMsg(e)}`)
    }
  }

  function remember(p: Omit<ProgramRef, 'seenAt'> & { seenAt?: number }) {
    const cur = programs.get(p.address)
    if (cur) {
      let changed = false
      if (p.name && cur.name !== p.name) ((cur.name = p.name), (changed = true))
      if (p.kept && !cur.kept) ((cur.kept = true), (changed = true))
      if (p.idl !== cur.idl && (p.idl || p.kept)) ((cur.idl = p.idl), (changed = true))
      if (p.codeHash && cur.codeHash !== p.codeHash) ((cur.codeHash = p.codeHash), (cur.fail = undefined), (cur.tried = undefined), (changed = true))
      if (changed) saveSoon()
      return cur
    }
    if (programs.size >= L.maxPrograms) {
      // the oldest program never processed makes room
      let oldest: ProgramRef | null = null
      for (const x of programs.values()) if (!(x.codeHash && results.has(x.codeHash)) && (!oldest || x.seenAt < oldest.seenAt)) oldest = x
      if (!oldest) return null
      programs.delete(oldest.address)
    }
    const ref: ProgramRef = { address: p.address, name: p.name, kept: p.kept, idl: p.idl, codeHash: p.codeHash, seenAt: p.seenAt ?? now() }
    programs.set(p.address, ref)
    saveSoon()
    return ref
  }

  // ─── recovery ─────────────────────────────────────────────────────────────

  async function recover(read: Pick<ChainRead, 'address' | 'name' | 'codeHash' | 'idl' | 'securityTxt'>, elf: Buffer, via: BinaryInterface['via']) {
    const trimmed = trimTrailingZeros(elf)
    const codeHash = read.codeHash ?? (await codeHashOf(trimmed))
    if (results.has(codeHash) && results.get(codeHash)!.dictionary.idls >= dict.idls * 0.9) return
    if (resultsFull()) return
    const hasIdl = !!read.idl
    const r = await recoverInterface(trimmed, dict, { exclude: hasIdl ? read.address : undefined, pause })
    if (stopped) return
    const scan = scanElf(trimmed)
    const sec = read.securityTxt ?? parseSecurityTxt(trimmed)
    const out: BinaryInterface = {
      v: 1,
      chain: 'solana',
      address: read.address,
      codeHash,
      programBytes: trimmed.length,
      readAt: now(),
      via,
      name: read.name ?? sec?.name ?? null,
      framework: r.framework,
      crates: r.crates,
      programCrate: r.programCrate,
      instructions: r.instructions,
      calls: r.calls,
      accounts: r.accounts,
      events: r.events,
      errors: r.errors,
      securityTxt: sec,
      syscalls: [...new Set([...scan.imports, ...scan.hashed])].slice(0, 64),
      strings: r.strings,
      dictionary: { idls: dict.idls, names: dict.size },
      notes: [...r.notes, ...scan.notes].slice(0, 12),
    }
    if (Object.keys(r.more).length) out.more = r.more
    if (!isElf(trimmed)) out.notes.push('the program bytes do not start with an ELF header')
    if (hasIdl && read.idl) out.check = checkAgainstIdl(out, read.idl)
    if (resultsFull(Buffer.byteLength(JSON.stringify(out)) + 1)) return
    // one result per program: the code it ran before an upgrade is dropped (unless another program runs it too)
    for (const [h, x] of results) {
      if (x.address !== read.address || h === codeHash) continue
      let shared = false
      for (const q of programs.values()) if (q.address !== read.address && q.codeHash === h) shared = true
      if (!shared) results.delete(h)
    }
    const ref = programs.get(read.address)
    if (ref && ref.codeHash !== codeHash) {
      ref.codeHash = codeHash
      saveSoon()
    }
    results.set(codeHash, out)
    appendResult(out)
    if (r.learned.length) dict.addLogNames(read.address, r.learned)
    lastAt = now()
    summaryMemo = null
  }

  function work() {
    if (working || stopped || !dictReady || !pending.length) return
    const run = async () => {
      while (pending.length && !stopped) {
        const job = pending.shift()!
        try {
          await recover(job.read, job.elf, job.via)
        } catch (e) {
          log('warn', `binary recovery of ${job.read.address.slice(0, 8)}… failed: ${errMsg(e)}`)
        }
        await pause()
      }
    }
    // cleared in a later microtask: never before `working` holds this run's promise
    working = run().finally(() => {
      working = null
    })
  }

  function offer(read: ChainRead, elf: Uint8Array, via: BinaryInterface['via']) {
    if (stopped || read.chain !== 'solana' || read.kind !== 'program' || !elf.length || elf.length > L.maxElfBytes) return
    const ref = remember({ address: read.address, name: read.name, kept: false, idl: !!read.idl, codeHash: read.codeHash })
    if (ref && read.codeHash && results.has(read.codeHash)) return
    // programs with an IDL: only a bounded sample feeds the blind check
    if (read.idl && checksToday() >= L.checkPerDay * 3) return
    if (pending.length >= L.pending || pending.some((x) => x.read.address === read.address)) return // the background reader catches up
    const copy = Buffer.from(elf) // the caller's bytes are not kept past this call
    pending.push({ read: { address: read.address, name: read.name, codeHash: read.codeHash, idl: read.idl, securityTxt: read.securityTxt }, elf: copy, via })
    work()
  }

  function checksToday(): number {
    const day = Math.floor(now() / DAY)
    let n = 0
    for (const r of results.values()) if (r.check && Math.floor(r.readAt / DAY) === day) n++
    return n
  }

  // ─── dictionary + census ──────────────────────────────────────────────────

  async function sweep() {
    let cursor: string | undefined
    let n = 0
    for (let guard = 0; guard < 500; guard++) {
      const page = d.store.items({ chain: 'solana', limit: 200, cursor })
      for (const it of page.items) {
        if (it.kind !== 'program') continue
        remember({ address: it.address, name: it.name, kept: true, idl: it.idl, codeHash: it.codeHash, seenAt: it.readAt })
        if (it.idl && !dict.has(it.address) && d.store.record) {
          const rec = d.store.record('solana', it.address)
          if (rec?.idl) dict.addIdl(it.address, rec.idl)
          if (++n % 10 === 0) await pause()
        }
      }
      if (!page.next || stopped) break
      cursor = page.next
    }
    for (const ev of d.feed(500)) {
      if (ev.chain !== 'solana' || ev.kind !== 'program' || ev.verdict === 'error') continue
      remember({ address: ev.address, name: ev.name, kept: ev.verdict === 'kept', idl: ev.idl, codeHash: null, seenAt: ev.ts })
    }
    if (!dictReady) {
      dictReady = true
      const c = dict.counts()
      log('info', `binary reader: dictionary of ${c.idls} IDLs (${c.instructions} instructions, ${c.accounts} accounts, ${c.events} events, ${c.errors} error messages); ${results.size} results cached`)
    }
    summaryMemo = null
    work()
  }

  // ─── background reader ────────────────────────────────────────────────────

  function nextCandidate(): ProgramRef | null {
    const t = now()
    let best: ProgramRef | null = null
    let bestCheck: ProgramRef | null = null
    const score = (p: ProgramRef) => (p.kept ? 1e15 : 0) + p.seenAt
    for (const p of programs.values()) {
      if (p.codeHash && results.has(p.codeHash)) continue
      if (p.tried && t - p.tried < (p.fail ? DAY : 6 * 3_600_000)) continue
      if (!p.idl) {
        if (!best || score(p) > score(best)) best = p
      } else if (p.kept && (!bestCheck || p.seenAt > bestCheck.seenAt)) bestCheck = p
    }
    // one read in four goes to the blind check (programs with an IDL), within its daily allowance
    if (bestCheck && budget.can('check') && (!best || readsDone % 4 === 3)) return bestCheck
    return best
  }

  let readsDone = 0

  async function tick(): Promise<'read' | 'none' | 'budget' | 'error'> {
    if (stopped || !dictReady || resultsFull()) return 'none'
    const p = nextCandidate()
    if (!p) {
      state = 'idle'
      return 'none'
    }
    if (!budget.can('solana') || !sharedRoom(1) || !d.rpc.canSpend('solana', 1, false)) {
      state = 'waiting-budget'
      return 'budget'
    }
    state = 'reading'
    p.tried = now()
    p.fail = undefined
    saveSoon()
    try {
      if (p.idl) budget.charge('check')
      budget.charge('solana')
      const pd = programAddresses(p.address).programData
      const res = (await d.rpc.call('solana', 'getMultipleAccounts', [[p.address, pd], { encoding: ZSTD_AVAILABLE ? 'base64+zstd' : 'base64', commitment: 'confirmed' }], {
        discovery: false,
        timeoutMs: 20_000,
      })) as { value?: unknown[] } | null
      readsDone++
      const values = res && Array.isArray(res.value) ? res.value : null
      if (!values || values.length !== 2) throw new Error('getMultipleAccounts: malformed response')
      const { elf, why } = await elfFromAccounts(p.address, values)
      if (!elf) {
        p.fail = why ?? 'no executable'
        return 'error'
      }
      const trimmed = Buffer.from(trimTrailingZeros(elf))
      if (!trimmed.length || trimmed.length > L.maxElfBytes) {
        p.fail = trimmed.length ? 'executable over the size cap' : 'program bytes are empty'
        return 'error'
      }
      const codeHash = await codeHashOf(trimmed)
      p.codeHash = codeHash
      const kept = p.kept ? d.store.item('solana', p.address) : null
      await recover({ address: p.address, name: p.name, codeHash, idl: kept?.read.idl ?? null, securityTxt: null }, trimmed, 'backfill')
      return 'read'
    } catch (e) {
      if (e instanceof BudgetError) {
        p.tried = undefined
        state = 'waiting-budget'
        return 'budget'
      }
      p.fail = errMsg(e)
      return 'error'
    } finally {
      budget.flush()
      if (state === 'reading') state = 'idle'
    }
  }

  function loop() {
    if (stopped) return
    loopTimer = setTimeout(async () => {
      loopTimer = null
      backfillRunning = tick().catch((e) => log('warn', `binary reader: ${errMsg(e)}`))
      await backfillRunning
      backfillRunning = null
      loop()
    }, L.gapMs)
    loopTimer.unref?.()
  }

  // ─── answers ──────────────────────────────────────────────────────────────

  // error messages found in a large share of all executables are framework / runtime strings (solana-program's
  // ProgramError texts, Anchor's built-in messages that some IDLs repeat as custom errors): not this program's own
  let freqMemo: { n: number; at: number; m: Map<string, number> } | null = null
  function msgFreq(): Map<string, number> {
    if (freqMemo && freqMemo.n === results.size && now() - freqMemo.at < 60_000) return freqMemo.m
    const m = new Map<string, number>()
    for (const r of results.values()) for (const e of r.errors) m.set(e.msg, (m.get(e.msg) ?? 0) + 1)
    freqMemo = { n: results.size, at: now(), m }
    return m
  }
  const commonCut = () => Math.max(8, Math.ceil(results.size * 0.12))
  function ownErrors(r: BinaryInterface) {
    const f = msgFreq()
    const cut = commonCut()
    return r.errors.filter((e) => (f.get(e.msg) ?? 0) < cut)
  }
  function publicView(r: BinaryInterface, address: string, name: string | null): BinaryInterface {
    const errors = ownErrors(r)
    const common = r.errors.length - errors.length
    const v = r.address === address && !common ? r : { ...r, address, name: name ?? r.name, errors }
    if (common) v.notes = [...r.notes, `${common} error message${common > 1 ? 's' : ''} found in most executables read (framework / runtime strings) left out`]
    return v
  }

  function resultFor(address: string): BinaryInterface | null {
    const p = programs.get(address)
    const r = p?.codeHash ? results.get(p.codeHash) : null
    if (r) return publicView(r, address, p?.name ?? null)
    for (const x of results.values()) if (x.address === address) return publicView(x, address, null)
    return null
  }

  function listItem(address: string, r: BinaryInterface, p: ProgramRef | undefined): BinaryListItem {
    const confirmed = r.instructions.filter((i) => i.evidence === 'log+disc')
    return {
      address,
      name: p?.name ?? r.name,
      codeHash: r.codeHash,
      programBytes: r.programBytes,
      framework: r.framework.name,
      frameworkVersion: r.framework.version,
      instructions: r.instructions.length + (r.more?.instructions ?? 0),
      confirmed: confirmed.length,
      calls: (r.calls?.length ?? 0) + (r.more?.calls ?? 0),
      accounts: r.accounts.length,
      errors: ownErrors(r).length,
      crates: r.crates.length,
      kept: !!p?.kept,
      readAt: r.readAt,
      sample: r.instructions.slice(0, 6).map((i) => i.name),
    }
  }

  /** Programs without an IDL with a result, best first. */
  function rows(): BinaryListItem[] {
    const out: BinaryListItem[] = []
    const seen = new Set<string>()
    for (const p of programs.values()) {
      if (p.idl || !p.codeHash) continue
      const r = results.get(p.codeHash)
      if (!r || r.check) continue
      seen.add(p.address)
      out.push(listItem(p.address, r, p))
    }
    out.sort((a, b) => b.confirmed - a.confirmed || b.instructions - a.instructions || b.readAt - a.readAt || a.address.localeCompare(b.address))
    return out
  }

  function summary(): BinarySummary {
    if (summaryMemo && now() - summaryMemo.at < 10_000) return summaryMemo.v
    const all = rows()
    let withoutIdl = 0
    for (const p of programs.values()) if (!p.idl) withoutIdl++
    const fw = new Map<BinFramework, number>()
    const crates = new Map<string, { name: string; version: string; count: number }>()
    let names = 0
    let instructions = 0
    let confirmed = 0
    let calls = 0
    let accounts = 0
    let errors = 0
    for (const it of all) {
      fw.set(it.framework, (fw.get(it.framework) ?? 0) + 1)
      const r = results.get(it.codeHash)!
      for (const c of r.crates) {
        const k = `${c.name}@${c.version}`
        const cur = crates.get(k)
        if (cur) cur.count++
        else crates.set(k, { ...c, count: 1 })
      }
      instructions += it.instructions
      confirmed += it.confirmed
      calls += it.calls
      accounts += r.accounts.length
      errors += it.errors
      names += it.instructions + r.accounts.length + r.events.length + it.errors
    }
    let bytesRead = 0
    const chk = { programs: 0, idlInstructions: 0, recovered: 0, hit: 0, newer: 0, idlAccounts: 0, accountsHit: 0 }
    for (const r of results.values()) {
      bytesRead += r.programBytes
      if (!r.check) continue
      chk.programs++
      chk.idlInstructions += r.check.idlInstructions
      chk.recovered += r.check.recovered
      chk.hit += r.check.hit
      chk.newer += r.check.newerThanIdl
      chk.idlAccounts += r.check.idlAccounts
      chk.accountsHit += r.check.accountsHit
    }
    const usage = budget.usage().solana
    const dc = dict.counts()
    const v: BinarySummary = {
      withoutIdl,
      processed: all.length,
      withInstructions: all.filter((x) => x.instructions > 0).length,
      names,
      instructions,
      confirmed,
      calls,
      accounts,
      errors,
      bytesRead,
      frameworks: FRAMEWORKS.map((name) => ({ name, count: fw.get(name) ?? 0 })).filter((x) => x.count > 0),
      crates: [...crates.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.version.localeCompare(b.version)).slice(0, 40),
      dictionary: { ...dc, ready: dictReady },
      check: chk.programs
        ? {
            programs: chk.programs,
            idlInstructions: chk.idlInstructions,
            recovered: chk.recovered,
            precision: ratio(chk.hit, chk.recovered),
            recall: ratio(chk.hit, chk.idlInstructions),
            newerThanIdl: chk.newer,
            accountRecall: ratio(chk.accountsHit, chk.idlAccounts),
          }
        : null,
      idlBehind: [...results.values()]
        .filter((r) => r.check && r.check.newerThanIdl > 0)
        .sort((a, b) => b.check!.newerThanIdl - a.check!.newerThanIdl || a.address.localeCompare(b.address))
        .slice(0, 6)
        .map((r) => ({ address: r.address, name: programs.get(r.address)?.name ?? r.name, newer: r.check!.newerThanIdl, idlInstructions: r.check!.idlInstructions })),
      reader: { used: usage?.used ?? 0, limit: usage?.limit ?? L.solCalls, queued: pending.length, state: stopped || !started ? 'off' : state, lastAt },
      // the top program by confirmed instructions; a named one among the top five when there is one
      featured: (all.slice(0, 5).find((x) => x.name) ?? all[0])?.address ?? null,
      updatedAt: now(),
    }
    summaryMemo = { at: now(), v }
    return v
  }

  function list(q: { framework?: BinFramework; cursor?: string; limit?: number }): BinaryPage {
    let all = rows()
    if (q.framework) all = all.filter((x) => x.framework === q.framework)
    const start = q.cursor ? Math.max(0, Number(q.cursor) || 0) : 0
    const lim = Math.max(1, Math.min(100, q.limit ?? 50))
    const items = all.slice(start, start + lim)
    return { items, next: start + lim < all.length ? String(start + lim) : null, total: all.length }
  }

  // memoised JSON answers (bounded)
  const memo = new Map<string, { at: number; json: string }>()
  function cached(key: string, ttl: number, build: () => unknown): string {
    const hit = memo.get(key)
    if (hit && now() - hit.at < ttl) return hit.json
    const json = JSON.stringify(build())
    memo.delete(key)
    memo.set(key, { at: now(), json })
    while (memo.size > 300) memo.delete(memo.keys().next().value!)
    return json
  }

  function route(p: string, params: URLSearchParams): BinaryRouteResult {
    const err = (status: number, error: string): BinaryRouteResult => ({ status, json: JSON.stringify({ error }) })
    const short = { 'Cache-Control': 'public, max-age=10' }
    if (p === '/api/binary/summary') return { status: 200, json: cached('summary', 10_000, summary), headers: short }
    if (p === '/api/binary/items') {
      const fw = params.get('framework') || ''
      if (fw && !(FRAMEWORKS as string[]).includes(fw)) return err(400, `framework must be one of ${FRAMEWORKS.join(', ')}`)
      const cursor = params.get('cursor') || ''
      if (cursor && !/^\d{1,6}$/.test(cursor)) return err(400, 'cursor is not one this server issued')
      const raw = params.get('limit')
      const n = raw === null || raw === '' ? 50 : Number(raw)
      if (!Number.isInteger(n) || n < 1) return err(400, 'limit must be an integer from 1 to 100')
      const q = { framework: (fw || undefined) as BinFramework | undefined, cursor: cursor || undefined, limit: Math.min(100, n) }
      return { status: 200, json: cached(`items:${fw}:${cursor}:${q.limit}`, 10_000, () => list(q)), headers: short }
    }
    const m = /^\/api\/binary\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p)
    if (!m || !isSolanaAddress(m[1])) return err(404, 'not found')
    const r = resultFor(m[1])
    if (!r) return err(404, 'no recovered interface for this program yet')
    return { status: 200, json: cached(`item:${m[1]}:${r.codeHash}:${r.readAt}`, 30_000, () => r), headers: { 'Cache-Control': 'public, max-age=30' } }
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      startTimer = setTimeout(() => {
        startTimer = null
        sweep()
          .catch((e) => log('warn', `binary sweep: ${errMsg(e)}`))
          .finally(() => loop())
      }, d.startDelayMs ?? 15_000)
      startTimer.unref?.()
      sweepTimer = setInterval(() => void sweep().catch((e) => log('warn', `binary sweep: ${errMsg(e)}`)), d.sweepMs ?? 30 * 60_000)
      sweepTimer.unref?.()
    },
    async stop() {
      if (stopped) return
      stopped = true
      for (const t of [saveTimer, loopTimer, startTimer]) if (t) clearTimeout(t)
      if (sweepTimer) clearInterval(sweepTimer)
      await working
      await backfillRunning
      budget.flush()
      savePrograms()
    },
    offer,
    summary,
    list,
    get: resultFor,
    route,
    sweep,
    tick,
    async idle() {
      while (working || pending.length) {
        if (!working) work()
        await working
        await pause()
      }
    },
  }
}
