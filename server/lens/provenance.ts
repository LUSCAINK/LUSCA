// Provenance for Lens: which verified source files are the same file as one in LUSCA's protocol code
// index (server/codebase: allowlisted GitHub repositories at a recorded commit).
//
//   <data>/code/index.json + shards ─▶ per repository: sha256 of every file (the index's own hash of
//   the text, BOM removed, CRLF → LF) and, for Solidity / Vyper, sha256 of the comment- and
//   whitespace-free form (server/chain/evm-source.ts normalizeSource)
//   ─▶ <data>/lens/provenance.json (tmp + fsync + rename), rebuilt per repository only when its
//      commit or shards change; read back on start, so a restart costs no rescan
//
// A Sourcify file is "byte-identical" to <repo>@<commit>:<path> when its normalized text hashes to
// the index's sha256; "same code" when only comments / whitespace / pragma differ. The scan runs in
// the background, yielding to the event loop between records (production has one CPU).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'
import { langOfPath, normalizeSource } from '../chain/evm-source.ts'

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

export interface ProvenanceHit {
  repo: string
  commit: string | null
  path: string
  exact: boolean
}

export interface ProvenanceIndex {
  /** Start the background build (and a re-check every `recheckMs`). */
  start(): void
  stop(): Promise<void>
  lookup(text: string, filePath: string): ProvenanceHit | null
  /** The commit the code index holds for a repository ('owner/name', case-insensitive), or undefined when it is not indexed. */
  repoCommit(repo: string): string | null | undefined
  stats(): { repos: number; files: number; builtAt: number | null }
  /** Build now (tests and tools); resolves when every changed repository is scanned. */
  refresh(): Promise<void>
}

interface RepoEntry {
  repo: string
  commit: string | null
  /** shards joined: a change means the repository was re-indexed */
  sig: string
  /** [exact16, norm16 | '', path] */
  files: [string, string, string][]
}

interface FileV1 {
  version: 1
  builtAt: number
  repos: RepoEntry[]
}

const FILE_VERSION = 1
const sha16 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32)
const NORM_LANGS = new Set(['solidity', 'vyper'])

/** The text the code index hashes: BOM removed, line endings LF (server/codebase/filters.ts decodeText). */
export function indexText(text: string): string {
  let s = text
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  return s.replace(/\r\n?/g, '\n')
}

export function exactKey(text: string): string {
  return sha16(indexText(text))
}

export function normKey(text: string, filePath: string): string | null {
  const lang = langOfPath(filePath)
  if (!NORM_LANGS.has(lang)) return null
  const n = normalizeSource(indexText(text), lang)
  return n.length >= 40 ? sha16(n) : null
}

function writeAtomicSync(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

export function createProvenanceIndex(o: { dataDir: string; log: Log; recheckMs?: number; startDelayMs?: number; now?: () => number }): ProvenanceIndex {
  const codeDir = path.join(o.dataDir, 'code')
  const outFile = path.join(o.dataDir, 'lens', 'provenance.json')
  const now = o.now ?? Date.now
  const recheckMs = Math.max(1000, o.recheckMs ?? 10 * 60_000)
  let repos = new Map<string, RepoEntry>()
  let exact = new Map<string, [number, number]>() // key → [repo idx, file idx]
  let norm = new Map<string, [number, number]>()
  let order: RepoEntry[] = []
  let builtAt: number | null = null
  let timer: NodeJS.Timeout | null = null
  let running: Promise<void> | null = null
  let stopped = false
  let lastIndexMtime = -1

  function rebuildMaps() {
    order = [...repos.values()].sort((a, b) => (a.repo < b.repo ? -1 : 1))
    const ex = new Map<string, [number, number]>()
    const nm = new Map<string, [number, number]>()
    order.forEach((r, ri) =>
      r.files.forEach((f, fi) => {
        if (!ex.has(f[0])) ex.set(f[0], [ri, fi])
        if (f[1] && !nm.has(f[1])) nm.set(f[1], [ri, fi])
      }),
    )
    exact = ex
    norm = nm
  }

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(outFile, 'utf8')) as FileV1
      if (j?.version !== FILE_VERSION || !Array.isArray(j.repos)) return
      repos = new Map(j.repos.filter((r) => r && typeof r.repo === 'string' && Array.isArray(r.files)).map((r) => [r.repo.toLowerCase(), r]))
      builtAt = typeof j.builtAt === 'number' ? j.builtAt : null
      rebuildMaps()
    } catch {
      /* none yet */
    }
  }

  const yieldNow = () => new Promise<void>((r) => setImmediate(r))

  async function scanRepo(name: string, commit: string | null, shards: string[], sig: string): Promise<RepoEntry | null> {
    const files: [string, string, string][] = []
    let n = 0
    for (const s of shards) {
      const file = path.join(codeDir, s)
      if (!fs.existsSync(file)) return null
      const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity })
      try {
        for await (const line of rl) {
          if (stopped) return null
          if (!line) continue
          let rec: { path?: unknown; sha256?: unknown; text?: unknown }
          try {
            rec = JSON.parse(line)
          } catch {
            continue
          }
          if (typeof rec.path !== 'string' || typeof rec.sha256 !== 'string' || typeof rec.text !== 'string') continue
          const nk = normKey(rec.text, rec.path) ?? ''
          files.push([rec.sha256.slice(0, 32), nk, rec.path])
          if (++n % 100 === 0) await yieldNow()
        }
      } finally {
        rl.close()
      }
    }
    return { repo: name, commit, sig, files }
  }

  async function build() {
    let state: { repos?: Record<string, { repo?: string; commit?: string | null; status?: string; shards?: string[] }> }
    let mtime: number
    try {
      mtime = fs.statSync(path.join(codeDir, 'index.json')).mtimeMs
      if (mtime === lastIndexMtime) return
      state = JSON.parse(fs.readFileSync(path.join(codeDir, 'index.json'), 'utf8'))
    } catch {
      return // no code index here: provenance stays "not connected yet"
    }
    const live = new Map<string, { repo: string; commit: string | null; shards: string[] }>()
    for (const [k, r] of Object.entries(state.repos ?? {})) {
      if (!r || r.status !== 'ok' || !Array.isArray(r.shards) || !r.shards.length) continue
      live.set((r.repo ?? k).toLowerCase(), { repo: r.repo ?? k, commit: typeof r.commit === 'string' ? r.commit : null, shards: r.shards })
    }
    let changed = false
    for (const k of [...repos.keys()]) {
      if (!live.has(k)) {
        repos.delete(k)
        changed = true
      }
    }
    let scanned = 0
    for (const [k, r] of live) {
      if (stopped) return
      const sig = `${r.commit ?? ''}|${r.shards.join(',')}`
      if (repos.get(k)?.sig === sig) continue
      try {
        const e = await scanRepo(r.repo, r.commit, r.shards, sig)
        if (!e) continue
        repos.set(k, e)
        changed = true
        scanned++
      } catch (err) {
        o.log('warn', `lens provenance: ${r.repo} unreadable (${(err as Error).message.slice(0, 120)})`)
      }
    }
    lastIndexMtime = mtime
    if (!changed) return
    builtAt = now()
    rebuildMaps()
    try {
      writeAtomicSync(outFile, JSON.stringify({ version: FILE_VERSION, builtAt, repos: order } satisfies FileV1))
    } catch (e) {
      o.log('warn', `lens provenance save failed: ${(e as Error).message}`)
    }
    if (scanned) o.log('info', `lens provenance: ${scanned} repositories hashed; ${exact.size} files in the index`)
  }

  function refresh(): Promise<void> {
    if (!running)
      running = build()
        .catch((e) => o.log('warn', `lens provenance build failed: ${(e as Error).message}`))
        .finally(() => {
          running = null
        })
    return running
  }

  load()

  return {
    start() {
      if (timer || stopped) return
      const first = setTimeout(() => void refresh(), Math.max(0, o.startDelayMs ?? 45_000))
      first.unref?.()
      timer = setInterval(() => void refresh(), recheckMs)
      timer.unref?.()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      await running
    },
    lookup(text, filePath) {
      const e = exact.get(exactKey(text))
      const hit = e ?? (() => {
        const k = normKey(text, filePath)
        return k ? norm.get(k) : undefined
      })()
      if (!hit) return null
      const r = order[hit[0]]
      const f = r?.files[hit[1]]
      if (!r || !f) return null
      return { repo: r.repo, commit: r.commit, path: f[2], exact: !!e }
    },
    repoCommit(repo) {
      const m = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repo.trim())
      if (!m) return undefined
      const r = repos.get(`${m[1]}/${m[2]}`.toLowerCase())
      return r ? r.commit : undefined
    },
    stats: () => ({ repos: repos.size, files: exact.size, builtAt }),
    refresh,
  }
}
