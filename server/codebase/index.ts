// Protocol code index: source files of an allowlist of public blockchain repositories
// (server/codebase/repos.ts), kept as gzip JSONL shards for SEPIA-1.
//
//   allowlist ─▶ commit of the branch / tag (git ref advertisement) ─▶ codeload tar.gz (≤ 120 MB, streamed)
//      ─▶ tar reader ─▶ filters · license recording · dedupe ─▶ <data>/code/<repo>.<gen>.<n>.jsonl.gz
//
// No repository is left out for its license: every repository and file records its SPDX license and
// display tier. A repository is skipped only when it cannot be fetched (not found / not public, archive
// too large), when its root LICENSE or README forbids machine-learning use, or when the size cap is
// reached (note 'cap').
//
// One repository at a time, ≥ 5 s apart; each refreshed at most every 7 days (re-downloaded only
// when its head commit or its allowlist entry changed, or when a copy cut short by the cap now has
// room to finish). Total compressed size capped (LUSCA_CODE_MAX_MB, default 150); a repository that
// is already indexed keeps its space at refresh. When GitHub limits or fails (429 / 403 / 5xx /
// network), all downloads pause (Retry-After, else an exponential backoff). Restart-safe: shards are
// written to <data>/code/tmp and committed with index.json (tmp + fsync + rename); anything
// half-written is removed on start and that repository is fetched again.

import fs from 'node:fs'
import path from 'node:path'
import type { CodeIndexStats, CodeRepoInfo, LicenseTier } from '../../shared/codebase.ts'
import { REPOS, type RepoSpec } from './repos.ts'
import { ArchiveTooLarge, HttpStatusError, githubSource, type ArchiveSource } from './source.ts'
import { indexArchive, type IndexOutput } from './ingest.ts'
import { canonicalExpr, exprTier } from './licenses.ts'
import { TarError } from './tar.ts'

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

export interface CodeIndexOptions {
  dataDir: string
  log: Log
  /** Total compressed size of all shards, MB (default 150). */
  maxMb?: number
}

export interface CodeIndex {
  start(): void
  stop(): Promise<void>
  stats(): CodeIndexStats
}

/** Knobs for tests and tools (createCodeIndex uses the defaults). */
export interface CodeIndexInternals extends CodeIndexOptions {
  repos?: RepoSpec[]
  source?: ArchiveSource
  startDelayMs?: number
  gapMs?: number
  refreshMs?: number
  maxArchiveBytes?: number
  maxInflatedBytes?: number
  maxShardBytes?: number
  repoTimeoutMs?: number
  /** Free disk space kept in reserve beyond what the cap may still add (default 10 % of the disk, clamped to 160 MB – 1 GB). */
  diskReserveBytes?: number
  now?: () => number
  /** Called whenever the queue has nothing due. */
  onIdle?: () => void
}

const MB = 1048576
const HOUR = 3_600_000
const DAY = 24 * HOUR
const STATE_VERSION = 2

interface RepoState {
  repo: string
  ref: string
  /** Fingerprint of the allowlist entry the data was built from (a change triggers a re-index). */
  spec: string
  gen: number
  commit: string | null
  fetchedAt: number | null
  attemptAt: number | null
  attempts: number
  retryAt?: number
  status: 'ok' | 'skipped' | 'error'
  note?: string
  capSkip?: boolean
  /** Set when the copy stopped at the size cap: the cap and what the other repositories held then. */
  capped?: { cap: number; others: number }
  /** First of a run of 404 / 451 answers for an archive the ref advertisement still lists. */
  missingSince?: number
  /** License recorded for the repository (null until an archive was read). */
  license: string | null
  files: number
  bytes: number
  gzBytes: number
  shards: string[]
  shaFile: string | null
  byLang: Record<string, number>
  byTier: Record<string, number>
}

interface StateFile {
  version: number
  gen: number
  updatedAt: number | null
  /** The size cap the index was last held to (a lower one on start drops repositories from the end). */
  capBytes?: number
  repos: Record<string, RepoState>
}

const slug = (repo: string) => repo.replace('/', '__').replace(/[^A-Za-z0-9._-]/g, '_')
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Shard and dedupe files written for one repository (any generation). */
const repoFileRe = (repo: string) => new RegExp(`^${escRe(slug(repo))}\\.\\d+\\.(?:(?:r\\.)?\\d+\\.jsonl\\.gz|sha)$`)
const DATA_FILE_RE = /\.(?:jsonl\.gz|sha)$/

/** What in an allowlist entry changes the records built from it. */
const fingerprint = (s: RepoSpec) =>
  JSON.stringify([
    s.ref,
    s.ecosystem,
    s.category,
    s.license,
    s.includePaths ?? [],
    s.excludePaths ?? [],
    s.langs ?? [],
    ...(s.largeFiles?.length ? [s.largeFiles] : []),
  ])

/** The allowlist license as shown before an archive was read. */
const declaredLicense = (s: RepoSpec) => (s.license && s.license.trim() ? canonicalExpr(s.license.trim()) : 'NOASSERTION')

const errCode = (e: unknown): string | undefined => {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null
  const c = err?.code ?? err?.cause?.code
  return typeof c === 'string' ? c : undefined
}

/** GitHub limiting or unavailable, or the network failing: pause every download, not just this repository. */
export function isTransient(e: unknown): boolean {
  if (e instanceof HttpStatusError) return e.status === 429 || e.status === 403 || e.status === 408 || e.status >= 500
  if (!(e instanceof Error)) return false
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return false
  if (e instanceof TypeError) return true // undici: 'fetch failed', 'terminated'
  const code = errCode(e)
  return !!code && /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR)/.test(code)
}

/** The short reason shown publicly (GET /api/code/stats); the full message goes to the server log only. */
export function publicNote(e: unknown): string {
  if (e instanceof HttpStatusError) return `HTTP ${e.status}`
  const err = e as Error | null
  if (err?.name === 'TimeoutError') return 'timed out'
  const code = errCode(e)
  if (e instanceof TarError || code?.startsWith('Z_') || /incorrect header check|unexpected end of file|invalid (?:stored )?block/i.test(err?.message ?? '')) return 'archive unreadable'
  if (isTransient(e)) return 'network error'
  if (code && /^E[A-Z]+$/.test(code)) return 'storage error'
  return 'error'
}

export function createCodeIndex(opts: { dataDir: string; log: (lvl: 'info' | 'warn' | 'error', msg: string) => void; maxMb?: number }): {
  start(): void
  stop(): Promise<void>
  stats(): CodeIndexStats
} {
  return createCodeIndexWith(opts)
}

export function createCodeIndexWith(o: CodeIndexInternals): CodeIndex {
  const repos = o.repos ?? REPOS
  const source = o.source ?? githubSource
  const capBytes = Math.max(1, Math.round((o.maxMb && o.maxMb > 0 ? o.maxMb : 150) * MB))
  /**
   * Below this much room the cap counts as reached (no 100 MB download to add a few KB). Also the
   * tolerance over the cap on restart: ingest keeps capTail (ingest.ts, half of this at most) free
   * for gzip's tail, so a repository that stopped at the cap is never read as over it.
   */
  const capSlack = Math.min(MB, Math.floor(capBytes * 0.01))
  const startDelayMs = o.startDelayMs ?? 30_000
  const gapMs = o.gapMs ?? 5_000
  const refreshMs = o.refreshMs ?? 7 * DAY
  // MystenLabs/sui ≈ 87 MB and osmosis ≈ 94 MB compressed; streamed, so this costs bandwidth, not RAM or disk
  const maxArchiveBytes = o.maxArchiveBytes ?? 120 * MB
  const repoTimeoutMs = o.repoTimeoutMs ?? 15 * 60_000
  const now = o.now ?? Date.now
  const log = o.log
  const dir = path.join(o.dataDir, 'code')
  const tmpDir = path.join(dir, 'tmp')
  const stateFile = path.join(dir, 'index.json')

  /** index.json exists but could not be read (not a parse error): the index stays paused this boot. */
  let loadError: string | null = null
  /** index.json was rebuilt (corrupt, older format or missing beside shards): old shards stay until replaced. */
  let recovering = false
  /** Unreferenced shard files kept while recovering, removed as each repository is indexed again. */
  const legacy = new Set<string>()
  let disabled = false
  let state: StateFile = loadState()
  let seen = new Set<string>()
  let started = false
  let stopping = false
  let active: string | null = null
  let current: AbortController | null = null
  let loopDone: Promise<void> | null = null
  let wake: (() => void) | null = null
  let blockedUntil = 0
  let blockedNote = ''
  /** Consecutive GitHub / network failures (sets the length of the global pause). */
  let failStreak = 0
  let statsCache: { at: number; v: CodeIndexStats } | null = null

  // ─── state ────────────────────────────────────────────────────────────────

  function loadState(): StateFile {
    const fresh: StateFile = { version: STATE_VERSION, gen: 0, updatedAt: null, repos: {} }
    let raw: string
    try {
      raw = fs.readFileSync(stateFile, 'utf8')
    } catch (e) {
      if (errCode(e) === 'ENOENT') {
        // no index yet; shards without one (index.json deleted by hand) are kept until rebuilt
        try {
          recovering = fs.readdirSync(dir).some((f) => DATA_FILE_RE.test(f))
        } catch {
          /* no code directory yet */
        }
        return fresh
      }
      loadError = `${errCode(e) ?? 'read error'}: ${(e as Error)?.message ?? e}`
      return fresh
    }
    try {
      const j = JSON.parse(raw) as StateFile
      if (j && j.repos && typeof j.repos === 'object') {
        if (j.version === STATE_VERSION) return { ...fresh, ...j }
        log('info', `index.json is format ${j.version}, now ${STATE_VERSION} — rebuilding the index`)
        recovering = true
        return { ...fresh, gen: Number.isSafeInteger(j.gen) ? j.gen : 0 }
      }
    } catch {
      /* fall through */
    }
    const aside = `${stateFile}.corrupt-${Date.now()}`
    try {
      fs.renameSync(stateFile, aside)
    } catch {
      /* ignore */
    }
    // keep only the newest moved-aside copy
    try {
      const copies = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('index.json.corrupt-'))
        .sort((a, b) => Number(b.slice(19)) - Number(a.slice(19)))
      for (const f of copies.slice(1)) fs.rmSync(path.join(dir, f), { force: true })
    } catch {
      /* ignore */
    }
    recovering = true
    log('warn', `index.json unreadable — moved to ${path.basename(aside)}; rebuilding the index (existing shards kept until each repository is indexed again)`)
    return fresh
  }

  function save() {
    if (disabled) return
    state.updatedAt = now()
    state.capBytes = capBytes
    statsCache = null
    try {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${stateFile}.tmp`
      const fd = fs.openSync(tmp, 'w')
      try {
        fs.writeSync(fd, JSON.stringify(state))
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, stateFile)
    } catch (e) {
      log('error', `index.json save failed: ${(e as Error).message}`)
    }
  }

  const rmQuiet = (f: string) => {
    try {
      fs.rmSync(f, { force: true, recursive: true })
    } catch {
      /* already gone */
    }
  }

  function dropData(st: RepoState) {
    for (const s of st.shards) rmQuiet(path.join(dir, s))
    if (st.shaFile) rmQuiet(path.join(dir, st.shaFile))
  }

  function readKeys(shaFile: string | null): string[] {
    if (!shaFile) return []
    let buf: Buffer
    try {
      buf = fs.readFileSync(path.join(dir, shaFile))
    } catch {
      return []
    }
    const out: string[] = []
    for (let i = 0; i + 16 <= buf.length; i += 16) out.push(buf.subarray(i, i + 16).toString('base64url'))
    return out
  }

  function totalGz(except?: string): number {
    let n = 0
    for (const st of Object.values(state.repos)) if (st.status === 'ok' && st.repo !== except) n += st.gzBytes
    return n
  }

  function freeBytes(): { free: number; total: number } | null {
    try {
      const s = fs.statfsSync(o.dataDir)
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
    } catch {
      return null
    }
  }

  function emptyState(spec: RepoSpec): RepoState {
    return {
      repo: spec.repo,
      ref: spec.ref,
      spec: fingerprint(spec),
      gen: 0,
      commit: null,
      fetchedAt: null,
      attemptAt: null,
      attempts: 0,
      status: 'skipped',
      license: null,
      files: 0,
      bytes: 0,
      gzBytes: 0,
      shards: [],
      shaFile: null,
      byLang: {},
      byTier: {},
    }
  }

  /** Remove stale data, orphans and temp files; hold the size cap; rebuild the dedupe set. */
  function reconcile() {
    fs.mkdirSync(tmpDir, { recursive: true })
    for (const f of fs.readdirSync(tmpDir)) rmQuiet(path.join(tmpDir, f))
    const allow = new Map(repos.map((r) => [r.repo, r]))
    let changed = false
    for (const [name, st] of Object.entries(state.repos)) {
      if (!allow.has(name)) {
        dropData(st)
        delete state.repos[name]
        log('info', `${name} left the allowlist — its shards were removed`)
        changed = true
        continue
      }
      if (st.status === 'ok' && (st.shards.some((s) => !fs.existsSync(path.join(dir, s))) || (st.shaFile && !fs.existsSync(path.join(dir, st.shaFile))))) {
        log('warn', `${name}: shards missing on disk — it will be fetched again`)
        dropData(st)
        delete state.repos[name]
        changed = true
      }
    }
    // Over the cap (a lowered LUSCA_CODE_MAX_MB): drop whole repositories from the end of the
    // allowlist until the rest fits. A repository that stopped at the cap may end a few KB over it
    // (what gzip still held when the cap was checked), so under an unchanged cap only more than
    // max(capSlack, 64 KB) over counts; under a lowered one, more than capSlack.
    const prevCap = state.capBytes
    const lowered = prevCap !== undefined && capBytes < prevCap
    const tolerance = lowered ? capSlack : Math.max(capSlack, 64 * 1024)
    let total = totalGz()
    for (let i = repos.length - 1; i >= 0 && total > capBytes + tolerance; i--) {
      const st = state.repos[repos[i].repo]
      if (!st || st.status !== 'ok') continue
      total -= st.gzBytes
      dropData(st)
      const sk = emptyState(repos[i])
      sk.note = 'cap'
      sk.capSkip = true
      sk.attemptAt = now()
      sk.gen = st.gen
      state.repos[repos[i].repo] = sk
      log(
        'info',
        lowered
          ? `${repos[i].repo}: size cap lowered to ${Math.round(capBytes / MB)} MB — its shards were removed`
          : `${repos[i].repo}: index over the ${Math.round(capBytes / MB)} MB size cap — its shards were removed`,
      )
      changed = true
    }
    if (prevCap !== capBytes) changed = true
    // orphans: files under code/ that index.json does not reference (an interrupted commit)
    const keep = new Set<string>(['index.json', 'tmp'])
    for (const st of Object.values(state.repos)) {
      for (const s of st.shards) keep.add(s)
      if (st.shaFile) keep.add(st.shaFile)
    }
    for (const f of fs.readdirSync(dir)) {
      if (keep.has(f) || f.startsWith('index.json')) continue
      if (recovering && DATA_FILE_RE.test(f)) {
        legacy.add(f) // rebuilt index: the old copy stays until this repository is indexed again
        continue
      }
      rmQuiet(path.join(dir, f))
    }
    if (legacy.size) log('info', `${legacy.size} shard files from before the rebuild kept until their repositories are indexed again`)
    seen = new Set()
    for (const st of Object.values(state.repos)) if (st.status === 'ok') for (const k of readKeys(st.shaFile)) seen.add(k)
    if (changed) save()
  }

  // ─── scheduling ───────────────────────────────────────────────────────────

  function dueAt(spec: RepoSpec, st: RepoState): number {
    const retry = st.retryAt ?? 0
    const specChanged = st.spec !== fingerprint(spec) || st.ref !== spec.ref
    if (st.status === 'ok') return specChanged ? retry : Math.max((st.fetchedAt ?? 0) + refreshMs, retry)
    if (st.status === 'skipped') {
      if (st.capSkip) {
        // re-checked hourly while there is room again, else at the normal refresh
        const room = totalGz() < capBytes - capSlack
        return room ? Math.max(retry, (st.attemptAt ?? 0) + HOUR) : (st.attemptAt ?? 0) + refreshMs
      }
      if (specChanged) return 0
      return st.retryAt ?? (st.attemptAt ?? 0) + refreshMs
    }
    return retry || (st.attemptAt ?? 0)
  }

  function nextDue(): { spec: RepoSpec | null; waitMs: number } {
    const t = now()
    if (t < blockedUntil) return { spec: null, waitMs: blockedUntil - t }
    let wait = HOUR
    for (const spec of repos) {
      const st = state.repos[spec.repo]
      if (!st) return { spec, waitMs: 0 }
      const due = dueAt(spec, st)
      if (due <= t) return { spec, waitMs: 0 }
      wait = Math.min(wait, due - t)
    }
    return { spec: null, waitMs: wait }
  }

  function sleep(ms: number): Promise<void> {
    if (stopping) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(done, Math.max(0, ms))
      timer.unref?.()
      function done() {
        clearTimeout(timer)
        if (wake === done) wake = null
        resolve()
      }
      wake = done
    })
  }

  async function loop() {
    await sleep(startDelayMs)
    while (!stopping) {
      const pick = nextDue()
      if (!pick.spec) {
        o.onIdle?.()
        await sleep(Math.max(1_000, Math.min(pick.waitMs, HOUR)))
        continue
      }
      const usedNetwork = await processRepo(pick.spec)
      if (stopping) break
      if (usedNetwork) await sleep(gapMs)
      else await new Promise<void>((r) => setImmediate(r))
    }
  }

  /** GitHub is limiting or failing: no request to any repository until the pause ends. */
  function pauseAll(err: unknown) {
    failStreak++
    const asked = err instanceof HttpStatusError ? (err.retryAfterMs ?? 0) : 0
    const ms = Math.min(DAY, Math.max(asked, Math.min(6 * HOUR, 2 * 60_000 * 2 ** Math.min(failStreak - 1, 12))))
    blockedUntil = now() + ms
    blockedNote = 'waiting for GitHub'
    statsCache = null
    log('warn', `GitHub ${err instanceof HttpStatusError ? `answered HTTP ${err.status}` : 'unreachable'} — all downloads paused for ${Math.max(1, Math.round(ms / 60_000))} min`)
  }

  // ─── one repository ───────────────────────────────────────────────────────

  interface SkipOpts {
    capSkip?: boolean
    retryMs?: number
    license?: string | null
    commit?: string | null
  }

  /** Not indexed (for a reason that holds for a while): drop old data, retry later. */
  function setSkipped(spec: RepoSpec, note: string, so: SkipOpts = {}) {
    const prev = state.repos[spec.repo]
    if (prev) {
      dropData(prev)
      for (const k of readKeys(prev.shaFile)) seen.delete(k)
    }
    const st = emptyState(spec)
    st.status = 'skipped'
    st.note = note.slice(0, 200)
    st.capSkip = so.capSkip
    st.attemptAt = now()
    if (so.retryMs !== undefined) st.retryAt = now() + so.retryMs
    st.gen = prev?.gen ?? 0
    st.license = so.license ?? prev?.license ?? null
    st.commit = so.commit ?? null
    state.repos[spec.repo] = st
    save()
    log(so.capSkip ? 'info' : 'warn', `${spec.repo} skipped: ${note}`)
  }

  /** The attempt failed: keep any indexed data, retry with a per-repository backoff. */
  function setError(spec: RepoSpec, err: unknown, opts: { missing?: boolean } = {}) {
    const prev = state.repos[spec.repo]
    const st = prev ?? emptyState(spec)
    st.attempts = (prev?.attempts ?? 0) + 1
    st.attemptAt = now()
    st.retryAt = now() + Math.min(DAY, 30 * 60_000 * 2 ** (st.attempts - 1))
    if (opts.missing) st.missingSince ??= now()
    else delete st.missingSince
    if (st.status !== 'ok') {
      st.status = 'error'
      st.note = publicNote(err)
      st.capSkip = undefined
    }
    state.repos[spec.repo] = st
    save()
    const msg = (err as Error)?.name === 'TimeoutError' ? 'timed out' : ((err as Error)?.message ?? String(err))
    log('warn', `${spec.repo}: ${msg} — retry in ${Math.round((st.retryAt - now()) / 60_000)} min`)
  }

  /** Mark an indexed repository as checked now (nothing new to read). */
  function touch(st: RepoState) {
    st.fetchedAt = now()
    st.attemptAt = now()
    st.attempts = 0
    delete st.retryAt
    delete st.missingSince
    save()
  }

  /** Move the new shards in and switch index.json to them. On failure nothing changes: the new files are removed, the old copy stays. */
  function commit(spec: RepoSpec, out: IndexOutput, gen: number, prev: RepoState | undefined, others: number) {
    const shards: string[] = []
    const moved: string[] = []
    const shaFile = `${slug(spec.repo)}.${gen}.sha`
    const shaTmp = path.join(tmpDir, shaFile)
    try {
      for (const f of out.shards) {
        const name = path.basename(f)
        const dest = path.join(dir, name)
        fs.renameSync(f, dest)
        moved.push(dest)
        shards.push(name)
      }
      fs.writeFileSync(shaTmp, Buffer.concat(out.keys.map((k) => Buffer.from(k, 'base64url'))))
      fs.renameSync(shaTmp, path.join(dir, shaFile))
      moved.push(path.join(dir, shaFile))
    } catch (e) {
      for (const f of moved) rmQuiet(f)
      for (const f of out.shards) rmQuiet(f)
      rmQuiet(shaTmp)
      throw e
    }
    const notes = [out.capped ? 'partial (cap)' : '', out.licenseNote ?? ''].filter(Boolean)
    const st: RepoState = {
      repo: spec.repo,
      ref: spec.ref,
      spec: fingerprint(spec),
      gen,
      commit: out.commit,
      fetchedAt: now(),
      attemptAt: now(),
      attempts: 0,
      status: 'ok',
      ...(notes.length ? { note: notes.join(' · ') } : {}),
      ...(out.capped ? { capped: { cap: capBytes, others } } : {}),
      license: out.license,
      files: out.files,
      bytes: out.bytes,
      gzBytes: out.gzBytes,
      shards,
      shaFile,
      byLang: out.byLang,
      byTier: out.byTier,
    }
    state.repos[spec.repo] = st
    save() // the new shards are referenced from here on; the old ones are orphans
    if (prev) {
      for (const s of prev.shards) if (!shards.includes(s)) rmQuiet(path.join(dir, s))
      if (prev.shaFile && prev.shaFile !== shaFile) rmQuiet(path.join(dir, prev.shaFile))
    }
    if (legacy.size) {
      const re = repoFileRe(spec.repo)
      for (const f of [...legacy]) {
        if (!re.test(f)) continue
        legacy.delete(f)
        if (!shards.includes(f) && f !== shaFile) rmQuiet(path.join(dir, f))
      }
    }
    for (const k of out.keys) seen.add(k)
  }

  /** Index (or refresh) one repository. Resolves true when it used the network. */
  async function processRepo(spec: RepoSpec): Promise<boolean> {
    const prev = state.repos[spec.repo]
    /** Already indexed: its space is within the cap and stays its own at refresh (list order is priority). */
    const held = prev?.status === 'ok'
    const others = totalGz(spec.repo)
    if (!held && others >= capBytes - capSlack) {
      setSkipped(spec, 'cap', { capSkip: true })
      return false
    }
    const disk = freeBytes()
    if (disk) {
      // 10 % of the disk (the health check warns below that), at least 160 MB, at most 1 GB
      const reserve = o.diskReserveBytes ?? Math.min(1024 * MB, Math.max(160 * MB, disk.total * 0.1))
      // what this repository may add (its old copy stays on disk until the new one is committed)
      const need = reserve + Math.max(0, capBytes - others)
      if (disk.free < need) {
        blockedUntil = now() + HOUR
        blockedNote = 'waiting for disk space'
        statsCache = null
        log('warn', `disk has ${Math.round(disk.free / MB)} MB free, ${Math.round(need / MB)} MB needed — pausing for an hour`)
        return false
      }
    }
    blockedNote = ''

    active = spec.repo
    statsCache = null
    const ctl = new AbortController()
    current = ctl
    const signal = AbortSignal.any([ctl.signal, AbortSignal.timeout(repoTimeoutMs)])
    // this repository's previous files must not count as duplicates of themselves
    const oldKeys = held ? readKeys(prev.shaFile) : []
    for (const k of oldKeys) seen.delete(k)
    let restored = false
    const restore = () => {
      if (restored) return
      restored = true
      for (const k of oldKeys) seen.add(k)
    }
    let head: string | null = null
    /** The ref advertisement answered 401 / 404: GitHub does not list the repository. */
    let refsMissing = false
    try {
      try {
        head = await source.head(spec.repo, spec.ref, signal)
      } catch (e) {
        if (stopping || !(e instanceof HttpStatusError) || (e.status !== 401 && e.status !== 404)) throw e // limited / down: no archive download either
        refsMissing = true
      }
      const sameEntry = held && prev.ref === spec.ref && prev.spec === fingerprint(spec)
      if (head && sameEntry && prev.commit === head) {
        // a copy cut short by the cap is finished once the cap was raised or space freed up
        const room = prev.capped && (capBytes > prev.capped.cap || others + capSlack < prev.capped.others) && others + prev.gzBytes < capBytes - capSlack
        if (!room) {
          restore()
          failStreak = 0
          touch(prev)
          log('info', `${spec.repo} unchanged at ${head.slice(0, 7)}`)
          return true
        }
        log('info', `${spec.repo}: room under the size cap again — completing the partial copy`)
      }
      const t0 = now()
      const tar = await source.open(spec.repo, head ?? spec.ref, signal, maxArchiveBytes, o.maxInflatedBytes)
      const gen = state.gen + 1
      state.gen = gen
      const out = await indexArchive(tar, {
        spec,
        commit: head,
        seen,
        tmpDir,
        base: `${slug(spec.repo)}.${gen}`,
        capBytes,
        otherBytes: others,
        maxShardBytes: o.maxShardBytes,
        signal,
      })
      failStreak = 0
      if (stopping) {
        for (const f of out.shards) rmQuiet(f)
        restore()
        return true
      }
      if (out.forbidden) {
        restored = true // setSkipped drops the old keys for good
        setSkipped(spec, out.forbidden, { license: out.license, commit: out.commit })
        return true
      }
      if (held && sameEntry && out.capped && !prev.capped) {
        // the new commit does not fit in the space left: the complete copy of the previous commit stays
        for (const f of out.shards) rmQuiet(f)
        restore()
        touch(prev)
        log('info', `${spec.repo}@${(out.commit ?? '?').slice(0, 7)} does not fit under the size cap — the copy at ${(prev.commit ?? '?').slice(0, 7)} is kept`)
        return true
      }
      if (out.files === 0) {
        restored = true
        if (out.capped) setSkipped(spec, 'cap', { capSkip: true, license: out.license, commit: out.commit })
        else setSkipped(spec, 'no files kept after filters', { license: out.license, commit: out.commit })
        return true
      }
      commit(spec, out, gen, prev, others)
      restored = true // the old keys are replaced by the new ones
      const sk = Object.entries(out.skipped)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')
      const tiers = Object.entries(out.byTier)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')
      log(
        'info',
        `${spec.repo}@${(out.commit ?? '?').slice(0, 7)}: ${out.files} files, ${(out.bytes / MB).toFixed(1)} MB text, ` +
          `${(out.gzBytes / MB).toFixed(1)} MB gz in ${Math.round((now() - t0) / 1000)} s · license ${out.license} (${tiers})` +
          `${sk ? ` · skipped: ${sk}` : ''}${out.capped ? ' · size cap reached' : ''}${out.licenseNote ? ` · ${out.licenseNote}` : ''}`,
      )
    } catch (e) {
      restore()
      if (stopping) return true
      const err = e as Error
      if (err instanceof ArchiveTooLarge) {
        restored = true
        setSkipped(spec, err.message)
      } else if (err instanceof HttpStatusError && err.what === 'archive' && (err.status === 404 || err.status === 451)) {
        // Gone only when GitHub agrees twice (no ref advertisement either), or when a repository never
        // indexed has no resolvable head, or after a day of 404s. A single 404 for a repository the
        // advertisement still lists (a codeload incident) keeps its data and is retried with a backoff.
        const confirmed = refsMissing || (head === null && !held)
        const longGone = prev?.missingSince !== undefined && now() - prev.missingSince > DAY
        if (confirmed || longGone) {
          restored = true
          setSkipped(spec, `not found or not public (HTTP ${err.status})`, { retryMs: DAY })
        } else setError(spec, err, { missing: true })
      } else {
        if (isTransient(err)) pauseAll(err)
        setError(spec, err)
      }
    } finally {
      active = null
      current = null
      statsCache = null
    }
    return true
  }

  // ─── stats ────────────────────────────────────────────────────────────────

  function tierFor(spec: RepoSpec, license: string): LicenseTier {
    const t = exprTier(license)
    // a license we do not recognise but the allowlist entry classified (e.g. a project license)
    if (t === 'unknown' && license === declaredLicense(spec) && spec.tier) return spec.tier
    return t
  }

  function info(spec: RepoSpec): CodeRepoInfo {
    const st = state.repos[spec.repo]
    const license = st?.license ?? declaredLicense(spec)
    const base: CodeRepoInfo = {
      repo: spec.repo,
      ecosystem: spec.ecosystem,
      category: spec.category,
      ref: spec.ref,
      commit: null,
      license,
      tier: tierFor(spec, license),
      files: 0,
      bytes: 0,
      fetchedAt: null,
      status: 'pending',
    }
    if (!st) {
      if (active === spec.repo) return { ...base, note: 'collecting' }
      return blockedNote ? { ...base, note: blockedNote } : base
    }
    const filled: CodeRepoInfo = {
      ...base,
      commit: st.commit,
      files: st.status === 'ok' ? st.files : 0,
      bytes: st.status === 'ok' ? st.bytes : 0,
      fetchedAt: st.fetchedAt,
      status: st.status,
      ...(st.note ? { note: st.note } : {}),
    }
    if (active === spec.repo) return st.status === 'ok' ? { ...filled, note: 'refreshing' } : { ...filled, status: 'pending', note: 'collecting' }
    return filled
  }

  function stats(): CodeIndexStats {
    const t = now()
    if (statsCache && t - statsCache.at < 1_000) return statsCache.v
    const list = repos.map(info)
    let files = 0
    let bytes = 0
    const byLang: Record<string, number> = {}
    const byEcosystem: Record<string, number> = {}
    for (const r of list) {
      if (r.status !== 'ok') continue
      files += r.files
      bytes += r.bytes
      byEcosystem[r.ecosystem] = (byEcosystem[r.ecosystem] ?? 0) + r.bytes
      const st = state.repos[r.repo]
      for (const [lang, n] of Object.entries(st?.byLang ?? {})) byLang[lang] = (byLang[lang] ?? 0) + n
    }
    const v: CodeIndexStats = { repos: list, files, bytes, byLang, byEcosystem, updatedAt: state.updatedAt }
    statsCache = { at: t, v }
    return v
  }

  return {
    start() {
      if (started) return
      started = true
      if (loadError) {
        // index.json is there but unreadable right now (EIO, EACCES, …): touch nothing on disk
        disabled = true
        log('error', `index.json could not be read (${loadError}) — the code index is paused until the next restart; nothing on disk was changed`)
        return
      }
      try {
        fs.mkdirSync(dir, { recursive: true })
        reconcile()
      } catch (e) {
        disabled = true
        log('error', `start failed: ${(e as Error).message}`)
        return
      }
      log('info', `${repos.length} repositories allowlisted · cap ${Math.round(capBytes / MB)} MB · ${(totalGz() / MB).toFixed(1)} MB held`)
      loopDone = loop().catch((e) => log('error', `loop stopped: ${(e as Error)?.stack ?? e}`))
    },
    async stop() {
      if (stopping) return loopDone ?? undefined
      stopping = true
      current?.abort(new Error('shutting down'))
      wake?.()
      await loopDone
      if (disabled) return
      for (const f of fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []) rmQuiet(path.join(tmpDir, f))
      if (started) save()
    },
    stats,
  }
}
