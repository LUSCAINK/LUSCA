// CODE INDEX — what SEPIA-1 will read: the allowlisted public protocol repositories and what has been
// indexed from them, live from GET /api/code/stats (server/codebase). Real data only: "—" until the server answers.
import { useEffect, useMemo, useState } from 'react'
import type { CodeIndexStats, CodeRepoInfo } from '@shared/codebase'
import { fmtAgo, fmtBytes, fmtClock, fmtInt } from '@/lib/format'
import './codeindex.css'

const POLL_MS = 30_000
const RETRY_MS = 5_000
const MAX_BACKOFF_MS = 120_000
/** Report an error only after this many consecutive failures; the first one retries quickly. */
const FAILS_BEFORE_ERROR = 2

const GH = 'https://github.com/'
const DOCS = 'https://github.com/LUSCAINK/LUSCA/blob/main/docs/'
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA_RE = /^[0-9a-f]{7,40}$/i

/** Display order and names. Ecosystems the server reports outside this list are appended in allowlist order. */
const ECO_ORDER = ['evm', 'solana', 'move', 'cairo', 'cosmos', 'bitcoin', 'infra', 'security']
const ECO_LABEL: Record<string, string> = {
  evm: 'EVM',
  solana: 'Solana',
  move: 'Move',
  cairo: 'Cairo',
  cosmos: 'Cosmos',
  bitcoin: 'Bitcoin',
  infra: 'Infra',
  security: 'Security',
}
const CAT_LABEL: Record<string, string> = {
  'bridge-rollup': 'bridge · rollup',
  'account-abstraction': 'account abstraction',
  'token-standard': 'token standard',
  'client-vm': 'client · vm',
}
const TIER_ORDER = ['permissive', 'copyleft', 'source-available', 'unknown']

const ecoLabel = (e: string) => ECO_LABEL[e] ?? (e ? e.charAt(0).toUpperCase() + e.slice(1) : '—')
const catLabel = (c: string) => (c ? (CAT_LABEL[c] ?? c.replace(/-/g, ' ')) : '—')

// ─── data ───────────────────────────────────────────────────────────────────

type LoadError = 'unavailable' | 'unreachable'
interface Load {
  data: CodeIndexStats | null
  error: LoadError | null
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

function isStats(v: unknown): v is CodeIndexStats {
  if (!v || typeof v !== 'object') return false
  const o = v as Partial<CodeIndexStats>
  return Array.isArray(o.repos) && typeof o.files === 'number' && typeof o.bytes === 'number'
}

/** Polls /api/code/stats while mounted; pauses while the tab is hidden and keeps the last good answer on errors. */
function useCodeStats(): Load {
  const [load, setLoad] = useState<Load>({ data: null, error: null })

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let ctl: AbortController | null = null
    let fails = 0
    let lastOk = 0
    let inflight = false

    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer)
      timer = alive ? setTimeout(() => run(), ms) : null
    }

    async function run(first = false) {
      timer = null
      if (!alive || inflight) return
      if (document.hidden && !first) return // resumed by the visibility handler
      inflight = true
      ctl = new AbortController()
      try {
        const res = await fetch('/api/code/stats', { headers: { Accept: 'application/json' }, signal: ctl.signal })
        if (!res.ok) throw new HttpError(res.status)
        let body: unknown
        try {
          body = await res.json()
        } catch {
          throw new HttpError(404) // an HTML fallback page: the route is not served here
        }
        if (!isStats(body)) throw new HttpError(404)
        if (!alive) return
        fails = 0
        lastOk = Date.now()
        setLoad({ data: body, error: null })
        schedule(POLL_MS)
      } catch (e) {
        if (!alive || ctl?.signal.aborted) return
        fails++
        const unavailable = e instanceof HttpError && (e.status === 404 || e.status === 501 || e.status === 503)
        if (fails >= FAILS_BEFORE_ERROR) setLoad((p) => ({ ...p, error: unavailable ? 'unavailable' : 'unreachable' }))
        schedule(fails < FAILS_BEFORE_ERROR ? RETRY_MS : Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** (fails - FAILS_BEFORE_ERROR)))
      } finally {
        inflight = false
      }
    }

    const onVisible = () => {
      if (document.hidden || inflight) return
      if (Date.now() - lastOk >= POLL_MS) schedule(0)
      else if (!timer) schedule(POLL_MS - (Date.now() - lastOk))
    }

    run(true)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      ctl?.abort()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return load
}

// ─── view model ─────────────────────────────────────────────────────────────

interface Group {
  eco: string
  repos: CodeRepoInfo[]
  ok: number
  bytes: number
}

interface Status {
  label: string
  cls: 'ok' | 'live' | 'wait' | 'err' | 'skip'
  note?: string
}

/** Short server notes spelled out (a note may join several parts with ' · '). */
const NOTE_TEXT: Record<string, string> = { cap: 'total size cap reached', 'partial (cap)': 'partly indexed · size cap' }
const noteText = (n: string | undefined) =>
  n
    ? n
        .split(' · ')
        .map((p) => NOTE_TEXT[p] ?? p)
        .join(' · ')
    : undefined

function statusOf(r: CodeRepoInfo): Status {
  const note = noteText(r.note)
  switch (r.status) {
    case 'ok':
      return { label: 'indexed', cls: 'ok', note }
    case 'pending':
      return r.note === 'collecting' ? { label: 'collecting', cls: 'live' } : { label: 'queued', cls: 'wait', note }
    case 'error':
      return { label: 'error', cls: 'err', note: note ?? 'retried later' }
    case 'skipped':
      return { label: 'skipped', cls: 'skip', note }
    default:
      return { label: String(r.status), cls: 'skip', note }
  }
}

function group(stats: CodeIndexStats): Group[] {
  const by = new Map<string, CodeRepoInfo[]>()
  for (const r of stats.repos) {
    const k = r.ecosystem || 'other'
    const list = by.get(k)
    if (list) list.push(r)
    else by.set(k, [r])
  }
  for (const k of Object.keys(stats.byEcosystem ?? {})) if (!by.has(k)) by.set(k, [])
  const keys = [...ECO_ORDER.filter((k) => by.has(k)), ...[...by.keys()].filter((k) => !ECO_ORDER.includes(k))]
  return keys.map((eco) => {
    const repos = by.get(eco) ?? []
    const okRepos = repos.filter((r) => r.status === 'ok')
    const fromServer = stats.byEcosystem?.[eco]
    return {
      eco,
      repos,
      ok: okRepos.length,
      bytes: typeof fromServer === 'number' ? fromServer : okRepos.reduce((a, r) => a + r.bytes, 0),
    }
  })
}

const ago = (ts: number | null) => {
  if (!ts) return '—'
  const a = fmtAgo(ts)
  return a === 'now' ? 'just now' : `${a} ago`
}

// ─── view ───────────────────────────────────────────────────────────────────

export function CodeIndex() {
  const { data, error } = useCodeStats()

  const v = useMemo(() => {
    if (!data) return null
    const repos = data.repos
    const count = (s: string) => repos.filter((r) => r.status === s).length
    const groups = group(data)
    const ecoMax = Math.max(0, ...groups.map((g) => g.bytes))
    const ecoTotal = groups.reduce((a, g) => a + g.bytes, 0)
    const langs = Object.entries(data.byLang ?? {})
      .filter(([, b]) => b > 0)
      .sort((a, b) => b[1] - a[1])
    const tiers = new Map<string, number>()
    for (const r of repos) tiers.set(r.tier || 'unknown', (tiers.get(r.tier || 'unknown') ?? 0) + 1)
    const tierList = [...TIER_ORDER.filter((t) => tiers.has(t)), ...[...tiers.keys()].filter((t) => !TIER_ORDER.includes(t))].map((t) => [t, tiers.get(t) ?? 0] as const)
    return {
      total: repos.length,
      ok: count('ok'),
      pending: count('pending'),
      skipped: count('skipped'),
      errors: count('error'),
      active: repos.find((r) => r.status === 'pending' && r.note === 'collecting')?.repo ?? null,
      groups,
      ecoMax,
      ecoTotal,
      langs,
      tierList,
    }
  }, [data])

  const message =
    error === 'unavailable'
      ? 'The code index is not served by this server yet.'
      : error === 'unreachable'
        ? 'Can’t reach the LUSCA server. Retrying.'
        : null

  const bare = !v || v.groups.length === 0

  return (
    <div className={`ci ${bare ? 'bare' : ''}`}>
      {message && (
        <p className="ci-alert mono" role="status">
          <span className={`led ${error === 'unreachable' ? 'white pulse' : ''}`} aria-hidden="true" />
          <span className="ci-alert-t">
            {message}
            {data && <span className="ci-alert-s"> Showing the last answer received.</span>}
          </span>
        </p>
      )}

      <section className="ci-tot panel" aria-labelledby="ci-tot-h">
        <div className="panel-head">
          <span id="ci-tot-h">
            <span className="hot">K</span>&nbsp;&nbsp;<b>Index totals</b>
          </span>
          <span>{data ? `updated ${ago(data.updatedAt)}` : error ? 'no answer' : 'loading'}</span>
        </div>
        <dl className="ci-grid">
          <Tot k="repositories" v={v ? fmtInt(v.ok) : '—'} sub={v ? `indexed · of ${fmtInt(v.total)} listed` : 'indexed'} hot />
          <Tot
            k="queued"
            v={v ? fmtInt(v.pending) : '—'}
            sub={v ? (v.active ? `now ${v.active}` : v.pending ? 'waiting to be fetched' : 'none waiting') : 'waiting to be fetched'}
          />
          <Tot k="files" v={data ? fmtInt(data.files) : '—'} sub="source files kept" />
          <Tot k="size" v={data ? fmtBytes(data.bytes) : '—'} sub="text, uncompressed" />
          <Tot k="languages" v={v ? (v.langs.length ? fmtInt(v.langs.length) : '—') : '—'} sub={v && v.langs.length ? v.langs.slice(0, 3).map(([l]) => l).join(' · ') : 'by file extension'} />
          <Tot
            k="skipped · error"
            v={v ? `${fmtInt(v.skipped)} · ${fmtInt(v.errors)}` : '—'}
            sub={v && v.errors ? 'errors are retried' : 'reason shown per row'}
          />
        </dl>
      </section>

      <section className="ci-eco panel" aria-labelledby="ci-eco-h">
        <div className="panel-head">
          <span id="ci-eco-h">
            <span className="hot">L</span>&nbsp;&nbsp;<b>Code by ecosystem</b>
            <span className="lc-unit">&nbsp;&nbsp;text indexed</span>
          </span>
          <span>{v ? `${fmtInt(v.groups.length)} ecosystems` : '—'}</span>
        </div>
        {v && v.groups.length ? (
          <>
            <ol className="ci-bars">
              {v.groups.map((g) => {
                const lead = g.bytes > 0 && g.bytes === v.ecoMax
                return (
                  <li key={g.eco} className={`ci-row ${lead ? 'lead' : ''}`}>
                    <span className="ci-name">
                      <span className="ci-n">{ecoLabel(g.eco)}</span>
                      <span className="ci-s num">
                        {fmtInt(g.ok)} / {fmtInt(g.repos.length)} indexed
                      </span>
                    </span>
                    <span className="ci-bar" aria-hidden="true">
                      <i style={{ width: `${v.ecoMax > 0 ? (g.bytes / v.ecoMax) * 100 : 0}%` }} />
                    </span>
                    <span className="ci-v num">{g.bytes > 0 ? fmtBytes(g.bytes) : '—'}</span>
                    <span className="ci-pct num">{v.ecoTotal > 0 && g.bytes > 0 ? `${((g.bytes / v.ecoTotal) * 100).toFixed(1)}%` : '—'}</span>
                  </li>
                )
              })}
            </ol>
            <div className="ci-axis mono" aria-hidden="true">
              <span className="ci-axis-in">
                <span>0</span>
                <span>{v.ecoMax > 0 ? fmtBytes(v.ecoMax / 2) : ''}</span>
                <span>{v.ecoMax > 0 ? fmtBytes(v.ecoMax) : ''}</span>
              </span>
            </div>
          </>
        ) : (
          <p className="ci-empty mono">{emptyText(data, error)}</p>
        )}
      </section>

      <section className="ci-repos panel" aria-labelledby="ci-repos-h">
        <div className="panel-head">
          <span id="ci-repos-h">
            <span className="hot">M</span>&nbsp;&nbsp;<b>Repositories</b>
          </span>
          <span>{v ? `${fmtInt(v.total)} listed · by ecosystem` : '—'}</span>
        </div>
        {v && v.total ? (
          <div className="ci-scroll" role="region" aria-labelledby="ci-repos-h" tabIndex={0}>
            <table className="ci-table">
              <caption className="sr-only">Repositories SEPIA-1 will read, grouped by ecosystem, with the license recorded for each and its index status.</caption>
              <colgroup>
                <col className="w-repo" />
                <col className="w-cat" />
                <col className="w-lic" />
                <col className="w-sha" />
                <col className="w-n" />
                <col className="w-size" />
                <col className="w-st" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className="c-repo">
                    repository
                  </th>
                  {/* phones: status sits next to the repository (one of the two status columns is shown) */}
                  <th scope="col" className="c-st-m">
                    status
                  </th>
                  <th scope="col" className="c-cat">
                    category
                  </th>
                  <th scope="col">license</th>
                  <th scope="col" className="c-sha">
                    commit
                  </th>
                  <th scope="col" className="c-n">
                    files
                  </th>
                  <th scope="col" className="c-n">
                    size
                  </th>
                  <th scope="col" className="c-st-d">
                    status
                  </th>
                </tr>
              </thead>
              {v.groups
                .filter((g) => g.repos.length)
                .map((g) => (
                  <tbody key={g.eco}>
                    <tr className="ci-grp">
                      <th scope="rowgroup" colSpan={7}>
                        <span className="ci-grp-in">
                          <b>{ecoLabel(g.eco)}</b>
                          <span className="num">
                            {fmtInt(g.ok)} / {fmtInt(g.repos.length)} indexed
                            {g.bytes > 0 ? ` · ${fmtBytes(g.bytes)}` : ''}
                          </span>
                        </span>
                      </th>
                    </tr>
                    {g.repos.map((r) => (
                      <RepoRow key={r.repo} r={r} />
                    ))}
                  </tbody>
                ))}
            </table>
          </div>
        ) : (
          <p className="ci-empty mono">{emptyText(data, error)}</p>
        )}
      </section>

      <div className="ci-foot mono">
        <p>
          {v && v.tierList.length ? (
            <>
              Licenses as recorded from each repository (SPDX):{' '}
              {v.tierList.map(([t, n], i) => (
                <span key={t}>
                  {i > 0 && ' · '}
                  <b className="num">{fmtInt(n)}</b> {t}
                </span>
              ))}
              .
            </>
          ) : (
            <>Licenses are recorded per repository (SPDX id) as each one is listed.</>
          )}
        </p>
        <p>
          Design notes on GitHub:{' '}
          <a href={`${DOCS}SEPIA-1.md`} target="_blank" rel="noopener noreferrer">
            SEPIA-1.md
          </a>{' '}
          ·{' '}
          <a href={`${DOCS}SEPIA-1-data.md`} target="_blank" rel="noopener noreferrer">
            SEPIA-1-data.md
          </a>
        </p>
      </div>
    </div>
  )
}

function emptyText(data: CodeIndexStats | null, error: LoadError | null): string {
  if (data) return 'collecting · no repositories listed yet'
  if (error === 'unavailable') return 'not served by this server yet'
  if (error === 'unreachable') return 'server unreachable · retrying'
  return 'loading the index…'
}

function StatusCell({ r, st, cls }: { r: CodeRepoInfo; st: Status; cls: string }) {
  return (
    <td className={`c-st ${cls}`}>
      <span className={`ci-st ${st.cls}`}>
        {st.cls === 'live' && <span className="led on pulse" aria-hidden="true" />}
        {st.label}
      </span>
      {st.note && st.note !== st.label && (
        <span className="ci-note" title={r.fetchedAt ? `${st.note} · fetched ${fmtClock(r.fetchedAt)} UTC` : st.note}>
          {st.note}
        </span>
      )}
    </td>
  )
}

function RepoRow({ r }: { r: CodeRepoInfo }) {
  const st = statusOf(r)
  const ok = r.status === 'ok'
  const [owner, name] = r.repo.includes('/') ? [r.repo.slice(0, r.repo.indexOf('/') + 1), r.repo.slice(r.repo.indexOf('/') + 1)] : ['', r.repo]
  const linkable = REPO_RE.test(r.repo)
  const sha = r.commit && SHA_RE.test(r.commit) ? r.commit : null
  const license = r.license || '—'
  return (
    <tr className={`ci-r ci-r-${st.cls}`}>
      <td className="c-repo">
        {linkable ? (
          <a href={`${GH}${r.repo}`} target="_blank" rel="noopener noreferrer" className="ci-repo" title={`${r.repo} on GitHub`}>
            <span className="ci-owner">{owner}</span>
            {name}
          </a>
        ) : (
          <span className="ci-repo">{r.repo || '—'}</span>
        )}
      </td>
      <StatusCell r={r} st={st} cls="c-st-m" />
      <td className="c-cat">{catLabel(r.category)}</td>
      <td className="c-lic" title={r.tier ? `${license} · ${r.tier}` : license}>
        {license}
      </td>
      <td className="c-sha num">
        {sha && linkable ? (
          <a href={`${GH}${r.repo}/tree/${sha}`} target="_blank" rel="noopener noreferrer" title={`${r.ref ? `${r.ref} @ ` : ''}${sha}`}>
            {sha.slice(0, 7)}
          </a>
        ) : (
          '—'
        )}
      </td>
      <td className="c-n num">{ok ? fmtInt(r.files) : '—'}</td>
      <td className="c-n num">{ok ? fmtBytes(r.bytes) : '—'}</td>
      <StatusCell r={r} st={st} cls="c-st-d" />
    </tr>
  )
}

function Tot({ k, v, sub, hot }: { k: string; v: string; sub?: string; hot?: boolean }) {
  return (
    <div className={`ci-t ${hot ? 'hot-t' : ''}`}>
      <dt className="label">{k}</dt>
      <dd className="num">{v}</dd>
      {sub && <dd className="ci-t-s mono">{sub}</dd>}
    </div>
  )
}
