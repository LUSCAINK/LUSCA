// OtterSec verified-build registry (verify.osec.io):
//   GET /status/<programId> → { is_verified, message, on_chain_hash, executable_hash, repo_url, commit,
//                               last_verified_at, is_frozen, is_closed }
//   GET /verified-programs[?page=N] → { meta: { total, page, total_pages, … }, verified_programs: [id…] }
// on_chain_hash / executable_hash use the same rule as codeHashOf (sha256 of the zero-trimmed ELF).

export const OSEC_BASE = 'https://verify.osec.io'
export const osecStatusUrl = (programId: string): string => `${OSEC_BASE}/status/${encodeURIComponent(programId)}`

export interface OsecStatus {
  isVerified: boolean
  /** Hash of the deployed program as the registry last saw it. */
  onChainHash: string | null
  /** Hash of the program built from the recorded repo / commit. */
  executableHash: string | null
  /** Repository root (…/tree/<commit> removed). */
  repo: string | null
  commit: string | null
  lastVerifiedAt: string | null
  frozen: boolean
  closed: boolean
}

const HEX64 = /^[0-9a-f]{64}$/
const hash = (v: unknown): string | null => (typeof v === 'string' && HEX64.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null)
const SHA = /^[0-9a-f]{7,40}$/i

/** A repository URL → { repo root, commit from a GitHub /tree|commit|blob/<sha> path }; null for non-http(s) values. */
export function normalizeRepoUrl(raw: unknown): { repo: string; commit: string | null } | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.length > 500) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const segs = u.pathname.split('/').filter(Boolean)
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'github.com' && segs.length >= 2) {
    const [owner, name, kind, ref] = segs
    const commit = (kind === 'tree' || kind === 'commit' || kind === 'blob') && ref && SHA.test(ref) ? ref.toLowerCase() : null
    return { repo: `https://github.com/${owner}/${name.replace(/\.git$/i, '')}`, commit }
  }
  return { repo: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')}`, commit: null }
}

/** The registry's status JSON → OsecStatus, or null when it is not one. */
export function parseOsecStatus(j: unknown): OsecStatus | null {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const o = j as Record<string, unknown>
  if (typeof o.is_verified !== 'boolean') return null
  const repo = normalizeRepoUrl(o.repo_url)
  const rawCommit = typeof o.commit === 'string' ? o.commit.trim() : ''
  const commit = SHA.test(rawCommit) ? rawCommit.toLowerCase() : (repo?.commit ?? null)
  return {
    isVerified: o.is_verified,
    onChainHash: hash(o.on_chain_hash),
    executableHash: hash(o.executable_hash),
    repo: repo?.repo ?? null,
    commit,
    lastVerifiedAt: typeof o.last_verified_at === 'string' ? o.last_verified_at.slice(0, 40) : null,
    frozen: o.is_frozen === true,
    closed: o.is_closed === true,
  }
}
