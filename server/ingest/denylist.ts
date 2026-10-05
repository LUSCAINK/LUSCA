// Operator denylist: hosts (or URL prefixes) LuscaBot must never fetch, for
// takedown and opt-out requests from site owners.
//
// ── file format ─────────────────────────────────────────────────────────────
// <dataDir>/denylist.json (env LUSCA_DENYLIST_FILE overrides the path). A JSON
// array; each entry is a string, or an object whose "host" field holds the same
// string (any other fields, e.g. "reason" / "requestedBy" / "added", are kept for
// the operator's records and ignored here):
//
//   [
//     "example.com",                        example.com and every subdomain of it
//     "*.example.org",                      same meaning (".example.org" too)
//     "news.example.net/private/",          only news.example.net URLs whose path starts with /private/
//     "forum.example.io/index.php?board=7", prefix match on path + query of that exact host
//     { "host": "example.io", "reason": "owner request 2026-10-05", "added": "2026-10-05" }
//   ]
//
// Matching is case-insensitive; a scheme ("https://"), port and trailing dot are
// ignored and Unicode host names are punycoded. Strings starting with "#" are comments.
//
// ── behaviour ───────────────────────────────────────────────────────────────
// The crawler loads the file at start-up and re-reads it every
// LUSCA_DENYLIST_RELOAD_SEC seconds (default 60; 0 = start-up only) when its size or
// mtime changed. A missing file is an empty list; an unreadable or malformed file
// keeps the previous list and logs the error. While an entry is listed:
//   • isBlockedHost() / skipReason() (url.ts) refuse matching URLs, so no link,
//     redirect or seed to them is queued or followed;
//   • an agent that picks a matching frontier entry drops it without any request
//     (not even robots.txt);
//   • on every change the crawler drops already-queued matching URLs and hides stored
//     pages of matching URLs from search / recent pages / GPU jobs.
// dataset.jsonl itself is not rewritten: purging stored text is a separate step.
//
// To add entries from code or a REPL (atomic write; picked up within one reload period):
//   await addDenylistEntries(denylistPath(dataDir), ['example.com'], 'owner request')
import { readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Largest denylist file read (a takedown list is tiny; this only guards against accidents). */
const MAX_FILE_BYTES = 4 * 1024 * 1024
const DEFAULT_RELOAD_SEC = 60

export interface DenyRule {
  /** punycoded lowercase host */
  host: string
  /** null = the host and all its subdomains; else a path(+query) prefix on exactly this host */
  prefix: string | null
}

export interface DenyIndex {
  /** hosts denied with all their subdomains */
  hosts: Set<string>
  /** exact host → path(+query) prefixes */
  prefixes: Map<string, string[]>
  size: number
}

const EMPTY: DenyIndex = { hosts: new Set(), prefixes: new Map(), size: 0 }

/** Parse one entry (string or { host }) into a rule, or null when it is not usable. */
export function parseDenyEntry(entry: unknown): DenyRule | null {
  let s: string
  if (typeof entry === 'string') s = entry
  else if (entry && typeof entry === 'object' && typeof (entry as { host?: unknown }).host === 'string') s = (entry as { host: string }).host
  else return null
  s = s.trim()
  if (!s || s.startsWith('#')) return null
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  s = s.replace(/^\*?\./, '')
  const cut = s.search(/[/?#]/)
  let rest = cut >= 0 ? s.slice(cut) : ''
  const hostPart = cut >= 0 ? s.slice(0, cut) : s
  const hashAt = rest.indexOf('#')
  if (hashAt >= 0) rest = rest.slice(0, hashAt)
  if (rest.startsWith('?')) rest = '/' + rest
  let host: string
  try {
    host = new URL(`http://${hostPart}`).hostname.toLowerCase()
  } catch {
    return null
  }
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (!host || !host.includes('.')) return null
  const prefix = rest && rest !== '/' ? rest : null
  return { host, prefix }
}

/** Build a lookup index from the parsed JSON (anything that is not an array → empty). */
export function buildDenyIndex(list: unknown): DenyIndex {
  if (!Array.isArray(list)) return { hosts: new Set(), prefixes: new Map(), size: 0 }
  const hosts = new Set<string>()
  const prefixes = new Map<string, string[]>()
  for (const e of list) {
    const r = parseDenyEntry(e)
    if (!r) continue
    if (r.prefix === null) hosts.add(r.host)
    else {
      const l = prefixes.get(r.host) ?? []
      if (!l.includes(r.prefix)) l.push(r.prefix)
      prefixes.set(r.host, l)
    }
  }
  let size = hosts.size
  for (const l of prefixes.values()) size += l.length
  return { hosts, prefixes, size }
}

/** Does the index deny this host (+ path + query)? `host` must be lowercase. */
export function matchDeny(idx: DenyIndex, host: string, path = '/', search = ''): boolean {
  if (idx.size === 0) return false
  if (idx.hosts.size) {
    // example.com denies a.b.example.com: test every dot suffix of the host.
    for (let h = host; ; ) {
      if (idx.hosts.has(h)) return true
      const dot = h.indexOf('.')
      if (dot < 0) break
      h = h.slice(dot + 1)
    }
  }
  const pre = idx.prefixes.get(host)
  if (pre) {
    const target = (path || '/') + (search || '')
    for (const p of pre) if (target.startsWith(p)) return true
  }
  return false
}

// ── the process-wide active list (one crawler per process) ──────────────────
let active: DenyIndex = EMPTY

export function setActiveDenylist(idx: DenyIndex): void {
  active = idx
}

export function denylistSize(): number {
  return active.size
}

/** Is this host (+ path + query) on the active denylist? */
export function isDenylisted(host: string, path = '/', search = ''): boolean {
  if (active.size === 0) return false
  return matchDeny(active, host.toLowerCase(), path, search)
}

/** isDenylisted() for a full URL string (unparseable URLs are not denied). */
export function isDenylistedUrl(url: string): boolean {
  if (active.size === 0) return false
  try {
    const u = new URL(url)
    let h = u.hostname.toLowerCase()
    if (h.endsWith('.')) h = h.slice(0, -1)
    return matchDeny(active, h, u.pathname || '/', u.search)
  } catch {
    return false
  }
}

// ── the file ────────────────────────────────────────────────────────────────
/** Path of the denylist for a data directory (env LUSCA_DENYLIST_FILE overrides). */
export function denylistPath(dataDir: string): string {
  const env = process.env.LUSCA_DENYLIST_FILE?.trim()
  return env || join(dataDir, 'denylist.json')
}

/** Re-read period in ms (env LUSCA_DENYLIST_RELOAD_SEC, default 60; 0 = never re-read). */
export function denylistReloadMs(): number {
  const raw = process.env.LUSCA_DENYLIST_RELOAD_SEC
  const n = raw === undefined || raw.trim() === '' ? DEFAULT_RELOAD_SEC : Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RELOAD_SEC * 1000
  return n === 0 ? 0 : Math.max(5, Math.min(86_400, n)) * 1000
}

export interface ReloadResult {
  /** the active list changed (callers then purge the frontier etc.) */
  changed: boolean
  size: number
  error: string | null
}

/** Reads the denylist file when it changed (size / mtime) and activates it. */
export class DenylistFile {
  readonly path: string
  private stamp = '' // "size:mtimeMs", '' = never read, 'missing' = no file
  private lastError: string | null = null

  constructor(path: string) {
    this.path = path
  }

  /** Synchronous (the file is tiny); never throws. `force` re-reads even if unchanged. */
  reload(force = false): ReloadResult {
    let stamp: string
    try {
      const st = statSync(this.path)
      stamp = `${st.size}:${st.mtimeMs}`
      if (st.size > MAX_FILE_BYTES) return this.failed(stamp, `file is larger than ${MAX_FILE_BYTES} bytes`)
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return this.failed('error', (e as Error).message ?? String(e))
      stamp = 'missing'
    }
    if (!force && stamp === this.stamp) return { changed: false, size: active.size, error: this.lastError }
    let idx: DenyIndex = EMPTY
    if (stamp !== 'missing') {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(this.path, 'utf8').replace(/^﻿/, ''))
      } catch (e) {
        return this.failed(stamp, (e as Error).message ?? String(e))
      }
      if (!Array.isArray(parsed)) return this.failed(stamp, 'expected a JSON array')
      idx = buildDenyIndex(parsed)
    }
    this.stamp = stamp
    this.lastError = null
    const changed = !sameIndex(idx, active)
    setActiveDenylist(idx)
    return { changed, size: idx.size, error: null }
  }

  /** Keep the previous list; report (and log) each distinct error once. */
  private failed(stamp: string, msg: string): ReloadResult {
    const err = `denylist ${this.path} not loaded (${msg}); keeping the previous ${active.size} entries`
    if (this.lastError !== err || this.stamp !== stamp) console.warn(`[crawler] ${err}`)
    this.stamp = stamp
    this.lastError = err
    return { changed: false, size: active.size, error: err }
  }
}

function sameIndex(a: DenyIndex, b: DenyIndex): boolean {
  if (a.size !== b.size || a.hosts.size !== b.hosts.size || a.prefixes.size !== b.prefixes.size) return false
  for (const h of a.hosts) if (!b.hosts.has(h)) return false
  for (const [h, l] of a.prefixes) {
    const o = b.prefixes.get(h)
    if (!o || o.length !== l.length || l.some((p) => !o.includes(p))) return false
  }
  return true
}

/**
 * Append entries to a denylist file (created if missing), skipping ones already
 * listed. Written to a temp file and renamed, so a concurrent reload never sees a
 * half-written file. Returns the number of entries added. With `reason`, entries
 * are stored as { host, reason, added } objects.
 */
export async function addDenylistEntries(file: string, entries: string[], reason?: string): Promise<number> {
  let list: unknown[] = []
  try {
    const parsed: unknown = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''))
    if (!Array.isArray(parsed)) throw new Error(`${file} is not a JSON array`)
    list = parsed
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e
  }
  const key = (r: DenyRule) => `${r.host}${r.prefix ?? ''}`
  const have = new Set<string>()
  for (const e of list) {
    const r = parseDenyEntry(e)
    if (r) have.add(key(r))
  }
  let added = 0
  const day = new Date().toISOString().slice(0, 10)
  for (const raw of entries) {
    const r = parseDenyEntry(raw)
    if (!r || have.has(key(r))) continue
    have.add(key(r))
    list.push(reason ? { host: raw.trim(), reason, added: day } : raw.trim())
    added++
  }
  if (added === 0) return 0
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
  return added
}
