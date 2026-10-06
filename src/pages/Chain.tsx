// CHAIN — two views in one route component:
//   /chain                    chain agents, totals, the live feed of reads and the kept index
//   /chain/:chain/:address    one kept program or contract, from stored data only
//
// Chain agents find programs (Solana) and contracts (Ethereum, Base, Arbitrum) themselves: in
// recent blocks, in verified-source registries, on pages the web agents kept, and through links
// (proxy to implementation). They read each one over RPC, judge it, and keep verified code as
// SEPIA-1 training data. Everything shown here comes from the server's stored data.
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { ChainAgentInfo, ChainEvent, ChainId, ChainIndexItem, ChainStats } from '@shared/chain'
import { Kicker, OnThisPage } from '@/components/docs/pagekit'
import { ConnBadge } from '@/components/ui/conn'
import { ChainDetail } from '@/components/chain/ChainDetail'
import { ChainTag, VerdictTag, ViaTag } from '@/components/chain/parts'
import {
  CHAIN_NAV_N,
  CHAINS,
  CHAIN_LABEL,
  KIND_LABEL,
  PACED_WINDOW_MS,
  STORE_FULL_KEY,
  UNAVAILABLE_PREFIX,
  VERDICTS,
  VERDICT_LABEL,
  VERDICT_TEXT,
  VIAS,
  VIA_TEXT,
  ago,
  chainLabel,
  classifyError,
  explorerUrl,
  fetchChainItems,
  fmtUtcShort,
  isChainId,
  itemPath,
  plural,
  refreshChain,
  shortAddress,
  useChain,
  useChainLive,
  verifiedShort,
  type ChainLoadError,
} from '@/lib/chain'
import { useConn, useNow } from '@/lib/hooks'
import { DASH, fmtBytes, fmtClock, fmtInt } from '@/lib/format'
import './chain.css'

export default function Chain() {
  const { chain, address } = useParams<{ chain?: string; address?: string }>()
  // keyed: a new address starts from a fresh loading state
  if (chain !== undefined) return <ChainDetail key={`${chain}/${address ?? ''}`} chainParam={chain} addressParam={address ?? ''} />
  return <ChainOverview />
}

// ─── overview ───────────────────────────────────────────────────────────────

function ChainOverview() {
  useChainLive()
  useEffect(() => {
    document.title = 'Chain — LUSCA'
  }, [])

  const stats = useChain((s) => s.stats)
  const statsError = useChain((s) => s.statsError)
  const feed = useChain((s) => s.feed)
  const now = useNow(5000)

  const via = useMemo(() => {
    const n: Record<string, number> = {}
    // the agents' own ways in: Lens reads (on request) are not part of where the agents look
    let total = 0
    for (const e of feed) {
      if (e.via === 'lens') continue
      n[e.via] = (n[e.via] ?? 0) + 1
      total++
    }
    return { n, total }
  }, [feed])

  // last read per agent, from the feed
  const lastByAgent = useMemo(() => {
    const m = new Map<string, ChainEvent>()
    for (const e of feed) if (!m.has(e.agent)) m.set(e.agent, e)
    return m
  }, [feed])

  const agents = stats?.agents ?? []
  const reading = agents.filter((a) => a.state === 'reading').length
  // agents spend most of their time between reads, paced so the daily budget lasts: that is not idle
  const recent = (a: ChainAgentInfo) => a.lastAt != null && now - a.lastAt < PACED_WINDOW_MS
  const active = agents.filter((a) => a.state === 'reading' || recent(a)).length
  const storeFull = (stats?.frontier?.[STORE_FULL_KEY] ?? 0) > 0
  const down = useMemo(() => {
    const m = new Map<string, number>()
    for (const [k, v] of Object.entries(stats?.frontier ?? {})) if (k.startsWith(UNAVAILABLE_PREFIX) && typeof v === 'number') m.set(k.slice(UNAVAILABLE_PREFIX.length), v)
    return m
  }, [stats])

  return (
    <div className="ch">
      <header className="ch-head">
        <div className="ch-title grid-bg">
          <Kicker n={CHAIN_NAV_N} name="Chain" className="ch-idx">
            <ConnBadge className="ch-conn" />
          </Kicker>
          <h1 className="display">Reading the chain.</h1>
          <p className="ch-lede">
            Chain agents discover programs and contracts on Solana, Ethereum, Base and Arbitrum by themselves, read them on-chain and keep verified code as
            training data for SEPIA-1.
          </p>
          <p className="ch-honest mono">
            The agents find addresses themselves. Anyone can read one address with <Link to="/lens">Lens</Link>; a Lens read that passes the same rules
            is kept here, marked &ldquo;lens&rdquo;. SEPIA-0, the current model, cannot read code: this index is what SEPIA-1 will train on.
          </p>
          <StatusLine error={statsError} hasData={!!stats} />
          <OnThisPage
            links={[
              { id: 'ch-agents', label: 'Agents' },
              { id: 'ch-feed', label: 'Live feed' },
              { id: 'ch-index', label: 'Kept index' },
            ]}
          />
        </div>

        <aside className="ch-where" aria-labelledby="ch-where-h">
          <div className="panel-head">
            <span id="ch-where-h">
              <b>Where they look</b>
            </span>
            <span>{via.total ? `last ${fmtInt(via.total)} reads` : 'share of reads'}</span>
          </div>
          <ol className="ch-where-l">
            {VIAS.map((v, i) => {
              const n = via.n[v] ?? 0
              const pct = via.total ? (n / via.total) * 100 : null
              return (
                <li key={v} className="ch-where-r">
                  <span className="ch-where-i num">{String(i + 1).padStart(2, '0')}</span>
                  <span className="ch-where-x">
                    <span className="ch-where-k">{v === 'block' ? 'Blocks' : v === 'registry' ? 'Registries' : v === 'web' ? 'Web corpus' : 'Links'}</span>
                    <span className="ch-where-t">{VIA_TEXT[v]}</span>
                  </span>
                  <span className="ch-where-v num">{pct == null ? DASH : `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`}</span>
                  <span className="ch-where-bar" aria-hidden="true">
                    <i style={{ width: `${pct ?? 0}%` }} />
                  </span>
                </li>
              )
            })}
          </ol>
          <ol className="ch-flow mono" aria-label="What happens to every address">
            <li>find</li>
            <li>read on-chain</li>
            <li>judge</li>
            <li className="hot">keep</li>
          </ol>
        </aside>
      </header>

      <section className="ch-verdicts" aria-labelledby="ch-vd-h">
        <div className="ch-verdicts-h">
          <span id="ch-vd-h" className="label">
            How a read is judged
          </span>
        </div>
        <dl className="ch-verdicts-l">
          {VERDICTS.map((v) => (
            <div key={v} className="ch-verdicts-i">
              <dt>
                <VerdictTag v={v} />
              </dt>
              <dd>{VERDICT_TEXT[v]}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="ch-agents" className="panel ch-agents pk-anchor" aria-labelledby="ch-agents-h">
        <div className="panel-head">
          <span id="ch-agents-h">
            <span className="hot">A</span>&nbsp;&nbsp;<b>Chain agents</b>
          </span>
          <span className="num">{stats ? (agents.length ? `${fmtInt(active)} active · ${fmtInt(reading)} reading now` : 'not running') : DASH}</span>
        </div>
        {storeFull && agents.length > 0 && (
          <p className="ch-pnote mono" role="status">
            Storage cap reached: the agents are paused and nothing more is kept until space is made.
          </p>
        )}
        {agents.length ? (
          <div className="ch-agent-grid">
            {agents.map((a) => (
              <AgentCard
                key={a.id}
                a={a}
                last={lastByAgent.get(a.id) ?? null}
                now={now}
                paced={!storeFull && a.state === 'idle' && recent(a) && (stats?.frontier?.[a.chain] ?? 0) > 0}
                down={unavailableFor(a.chain, down, now)}
              />
            ))}
          </div>
        ) : (
          <p className="ch-empty mono">{stats ? 'Chain agents are not running on this server.' : emptyText(statsError, 'loading the chain agents…')}</p>
        )}
      </section>

      <div className="ch-row">
        <Totals stats={stats} error={statsError} />
        <ByChain stats={stats} error={statsError} />
      </div>

      <Feed />

      <KeptIndex />

      <footer className="ch-foot mono">
        <p>
          Every kept item is stored with its provenance: chain, address, how it was found, code hash, verification record, interface and source files. For
          OtterSec verified builds the source files are not copied here: the repository and commit of the verified build are recorded with the item. The
          GitHub code index (<Link to="/sepia#sp-code">Model page</Link>, &ldquo;What SEPIA-1 will read&rdquo;) is a separate, curated list of protocol
          repositories.
        </p>
        <p>This page shows the server&rsquo;s stored data. Your browser never queries a chain.</p>
      </footer>
    </div>
  )
}

function emptyText(error: ChainLoadError | null, loading: string): string {
  if (error === 'unavailable') return 'Chain agents are not served by this server yet.'
  if (error === 'unreachable') return 'Can’t reach the LUSCA server. Retrying.'
  return loading
}

function StatusLine({ error, hasData }: { error: ChainLoadError | null; hasData: boolean }) {
  if (!error) return null
  return (
    <p className="ch-status mono" role="status">
      <span className={`led ${error === 'unreachable' ? 'white pulse' : ''}`} aria-hidden="true" />
      <span>
        {error === 'unavailable' ? 'Chain agents are not served by this server yet.' : 'Can’t reach the LUSCA server. Retrying.'}
        {hasData && <span className="dimmer"> Showing the last answer received.</span>}
      </span>
      <button type="button" className="ch-retry" onClick={refreshChain}>
        retry
      </button>
    </p>
  )
}

// ─── agents ─────────────────────────────────────────────────────────────────

const STATE_LABEL: Record<ChainAgentInfo['state'], string> = {
  reading: 'reading',
  idle: 'idle',
  'waiting-budget': 'waiting · daily budget',
  error: 'error',
}

/** Endpoints each chain's reads depend on (server/chain/agents.ts endpointsOf). */
const ENDPOINTS: Record<string, string[]> = { solana: ['solana', 'osec'], ethereum: ['ethereum', 'sourcify'], base: ['base', 'sourcify'], arbitrum: ['arbitrum', 'sourcify'] }
const ENDPOINT_LABEL: Record<string, string> = { solana: 'Solana RPC', ethereum: 'Ethereum RPC', base: 'Base RPC', arbitrum: 'Arbitrum RPC', sourcify: 'Sourcify', osec: 'OtterSec' }

/** "Sourcify unavailable · retry 14:32 UTC" when an endpoint this chain needs is paused, else null. */
function unavailableFor(chain: string, down: Map<string, number>, now: number): string | null {
  for (const ep of ENDPOINTS[chain] ?? []) {
    const until = down.get(ep)
    if (until && until > now) {
      const d = new Date(until)
      return `${ENDPOINT_LABEL[ep] ?? ep} not answering · retry ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
    }
  }
  return null
}

function AgentCard({ a, last, now, paced, down }: { a: ChainAgentInfo; last: ChainEvent | null; now: number; paced: boolean; down: string | null }) {
  const led =
    a.state === 'reading' ? 'led on pulse' : a.state === 'error' ? 'led ch-led-err' : a.state === 'waiting-budget' ? 'led white' : paced ? 'led ch-led-paced' : 'led'
  const stateText = paced ? 'between reads · paced to daily budget' : a.state === 'error' && down ? 'paused · endpoint not answering' : (STATE_LABEL[a.state] ?? a.state)
  const cur = a.current
  // between reads, the row shows the last address read (from the feed) instead of a dash
  const shown = cur ?? (a.state !== 'reading' && last ? last.address : null)
  const shownLink = shown && isChainId(a.chain) ? explorerUrl(a.chain, shown) : null
  const rowLabel = a.state === 'reading' ? 'now reading' : cur ? 'current' : shown ? 'last read' : 'current'
  return (
    <article className={`ch-agent st-${a.state} ${paced ? 'is-paced' : ''}`} aria-label={`Chain agent ${a.id}, ${chainLabel(a.chain)}, ${stateText}`}>
      <div className="ch-agent-top">
        <span className="ch-agent-id">{a.id}</span>
        <ChainTag chain={a.chain} long />
      </div>
      <div className="ch-agent-st mono">
        <span className={led} aria-hidden="true" />
        {stateText}
      </div>
      <div className="ch-agent-cur mono" title={shown ?? undefined}>
        <span className="label">{rowLabel}</span>
        {down && a.state === 'error' ? (
          <span className="dimmer">{down}</span>
        ) : shown ? (
          shownLink ? (
            <a href={shownLink} target="_blank" rel="noopener noreferrer">
              {last && !cur && last.name ? last.name : shortAddress(shown, 6, 6)}
            </a>
          ) : (
            <span>{shortAddress(shown, 6, 6)}</span>
          )
        ) : (
          <span className="dimmer">{a.state === 'waiting-budget' ? 'resumes 00:00 UTC' : DASH}</span>
        )}
      </div>
      <dl className="ch-agent-n">
        <div>
          <dt className="label">reads</dt>
          <dd className="num">{fmtInt(a.reads)}</dd>
        </div>
        <div>
          <dt className="label">kept</dt>
          <dd className="num hot">{fmtInt(a.kept)}</dd>
        </div>
      </dl>
      <div className="ch-agent-last mono">
        <span>last activity</span>
        <span className="num">{ago(a.lastAt, now)}</span>
      </div>
      {last && (
        <div className="ch-agent-ev mono" title={last.reason || undefined}>
          <VerdictTag v={last.verdict} />
          <span className="ch-agent-ev-n">{last.name || shortAddress(last.address)}</span>
        </div>
      )}
    </article>
  )
}

// ─── totals ─────────────────────────────────────────────────────────────────

function Totals({ stats, error }: { stats: ChainStats | null; error: ChainLoadError | null }) {
  // a failed read is not a verdict on the address: counted apart from the rejections
  const rejected = useMemo(() => {
    if (!stats) return []
    return Object.entries(stats.rejected ?? {})
      .filter(([k, n]) => k !== 'error' && typeof n === 'number' && n > 0)
      .sort((a, b) => b[1] - a[1])
  }, [stats])
  const failed = stats?.rejected?.error ?? 0
  const rejMax = Math.max(0, ...rejected.map(([, n]) => n))
  const rejTotal = rejected.reduce((a, [, n]) => a + n, 0)
  const rate = stats && stats.reads > 0 ? (stats.kept / stats.reads) * 100 : null
  const s = stats
  return (
    <section className="panel ch-tot" aria-labelledby="ch-tot-h">
      <div className="panel-head">
        <span id="ch-tot-h">
          <span className="hot">B</span>&nbsp;&nbsp;<b>Totals</b>
        </span>
        <span>{s ? `updated ${ago(s.updatedAt)}` : error ? 'no answer' : 'loading'}</span>
      </div>
      <dl className="ch-tot-grid">
        <Tot k="reads" v={s ? fmtInt(s.reads) : DASH} sub="addresses read on-chain" />
        <Tot k="kept" v={s ? fmtInt(s.kept) : DASH} sub={rate == null ? 'stored as training data' : `${rate < 10 ? rate.toFixed(1) : Math.round(rate)}% of reads`} hot />
        <Tot k="programs" v={s ? fmtInt(s.programs) : DASH} sub="kept · Solana" />
        <Tot k="contracts" v={s ? fmtInt(s.contracts) : DASH} sub="kept · EVM chains" />
        <Tot k="on-chain IDLs" v={s ? fmtInt(s.idls) : DASH} sub="program interfaces" />
        <Tot k="verified sources" v={s ? fmtInt(s.verified) : DASH} sub={s ? `OtterSec · Sourcify · ${fmtBytes(s.sourceBytes)} text` : 'OtterSec · Sourcify'} />
        <Tot k="rejected" v={s ? fmtInt(rejTotal) : DASH} sub="reason below" />
        <Tot k="failed reads" v={s ? fmtInt(failed) : DASH} sub="not a verdict · read again later" />
      </dl>
      <div className="ch-rej">
        <div className="ch-sub-h label">Rejected by reason</div>
        {rejected.length ? (
          <ol className="ch-rej-l">
            {rejected.map(([k, n]) => (
              <li key={k} className="ch-rej-r" title={k in VERDICT_TEXT ? VERDICT_TEXT[k as keyof typeof VERDICT_TEXT] : undefined}>
                <span className="ch-rej-k">{k in VERDICT_LABEL ? VERDICT_LABEL[k as keyof typeof VERDICT_LABEL] : k}</span>
                <span className="ch-rej-bar" aria-hidden="true">
                  <i style={{ width: `${rejMax > 0 ? (n / rejMax) * 100 : 0}%` }} />
                </span>
                <span className="ch-rej-v num">{fmtInt(n)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="ch-empty mono">{s ? 'nothing rejected yet' : emptyText(error, 'loading…')}</p>
        )}
      </div>
    </section>
  )
}

function Tot({ k, v, sub, hot }: { k: string; v: string; sub?: string; hot?: boolean }) {
  return (
    <div className={`ch-t ${hot ? 'hot-t' : ''}`}>
      <dt className="label">{k}</dt>
      <dd className="num">{v}</dd>
      {sub && <dd className="ch-t-s mono">{sub}</dd>}
    </div>
  )
}

// ─── by chain + budget ──────────────────────────────────────────────────────

function budgetLabel(key: string): string {
  const k = key.toLowerCase()
  const chain = CHAINS.find((c) => k.includes(c)) ?? (k.startsWith('sol') ? 'solana' : k.startsWith('eth') ? 'ethereum' : k.startsWith('arb') ? 'arbitrum' : null)
  if (k.includes('sourcify')) return 'Sourcify API'
  if (k.includes('osec') || k.includes('otter')) return 'OtterSec API'
  if (chain && k.includes('disc')) return `${CHAIN_LABEL[chain]} discovery`
  if (chain === 'solana') return 'Solana reads'
  if (chain) return `${CHAIN_LABEL[chain]} RPC`
  return key
}

function ByChain({ stats, error }: { stats: ChainStats | null; error: ChainLoadError | null }) {
  const rows = useMemo(() => {
    if (!stats) return []
    const keys = [...CHAINS.filter((c) => c in (stats.byChain ?? {}) || c in (stats.frontier ?? {})), ...Object.keys(stats.byChain ?? {}).filter((k) => !isChainId(k))]
    return keys.map((c) => ({ chain: c, reads: stats.byChain?.[c]?.reads ?? 0, kept: stats.byChain?.[c]?.kept ?? 0, queued: stats.frontier?.[c] ?? null }))
  }, [stats])
  const max = Math.max(0, ...rows.map((r) => r.reads))
  const budget = useMemo(() => (stats ? Object.entries(stats.budget ?? {}).filter(([, b]) => b && typeof b.used === 'number' && typeof b.limit === 'number') : []), [stats])
  return (
    <section className="panel ch-by" aria-labelledby="ch-by-h">
      <div className="panel-head">
        <span id="ch-by-h">
          <span className="hot">C</span>&nbsp;&nbsp;<b>By chain</b>
        </span>
        <span>reads · kept · queued</span>
      </div>
      {rows.length ? (
        <ol className="ch-by-l">
          {rows.map((r) => (
            <li key={r.chain} className="ch-by-r">
              <span className="ch-by-n">{chainLabel(r.chain)}</span>
              <span className="ch-by-bar" aria-hidden="true">
                <i className="rd" style={{ width: `${max > 0 ? (r.reads / max) * 100 : 0}%` }} />
                <i className="kp" style={{ width: `${max > 0 ? (r.kept / max) * 100 : 0}%` }} />
              </span>
              <span className="ch-by-v num">
                <span title="reads">{fmtInt(r.reads)}</span>
                <span className="hot" title="kept">
                  {fmtInt(r.kept)}
                </span>
                <span className="dim" title="candidates queued">
                  {r.queued == null ? DASH : fmtInt(r.queued)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="ch-empty mono">{stats ? 'no reads yet' : emptyText(error, 'loading…')}</p>
      )}
      {rows.length > 0 && (
      <div className="ch-legend mono">
        <span>
          <i className="sw rd" /> reads
        </span>
        <span>
          <i className="sw kp" /> kept
        </span>
        <span>
          <i className="sw q" /> queued = candidates waiting to be read
        </span>
      </div>
      )}

      <div className="ch-bud">
        <div className="ch-sub-h">
          <span className="label">Daily call budget</span>
          <span className="label dimmer">resets 00:00 UTC</span>
        </div>
        {budget.length ? (
          <ol className="ch-bud-l">
            {budget.map(([k, b]) => {
              const pct = b.limit > 0 ? Math.min(100, (b.used / b.limit) * 100) : 0
              const full = b.limit > 0 && b.used >= b.limit
              return (
                <li key={k} className={`ch-bud-r ${full ? 'full' : ''}`}>
                  <span className="ch-bud-k">{budgetLabel(k)}</span>
                  <span className="ch-bud-m" role="meter" aria-valuemin={0} aria-valuemax={b.limit} aria-valuenow={b.used} aria-label={`${budgetLabel(k)} calls used today`}>
                    <i style={{ width: `${pct}%` }} />
                  </span>
                  <span className="ch-bud-v num">
                    {fmtInt(b.used)} <span className="dimmer">/ {fmtInt(b.limit)}</span>
                  </span>
                </li>
              )
            })}
          </ol>
        ) : (
          <p className="ch-empty mono">{stats ? 'no calls made today' : emptyText(error, 'loading…')}</p>
        )}
        <p className="ch-bud-note mono">Agents wait when a cap is reached. Discovery uses free public RPC endpoints.</p>
      </div>
    </section>
  )
}

// ─── live feed ──────────────────────────────────────────────────────────────

type FeedFilter = 'all' | 'kept' | 'rejected' | 'errors'
const FEED_SHOWN = 120

function Feed() {
  const feed = useChain((s) => s.feed)
  const feedError = useChain((s) => s.feedError)
  const feedAt = useChain((s) => s.feedAt)
  const agentsRunning = useChain((s) => (s.stats ? s.stats.agents.length > 0 : true))
  const conn = useConn()
  const [filter, setFilter] = useState<FeedFilter>('all')
  const [chain, setChain] = useState<ChainId | null>(null)
  // paused: the list holds still (a snapshot) while reads keep arriving underneath
  const [frozen, setFrozen] = useState<ChainEvent[] | null>(null)
  const paused = frozen !== null
  const base = frozen ?? feed
  const newer = frozen && frozen.length ? Math.max(0, feed.findIndex((e) => e.id === frozen[0].id)) : frozen ? feed.length : 0
  const togglePause = () => setFrozen((f) => (f ? null : useChain.getState().feed))

  const shown = useMemo(
    () =>
      base
        .filter((e) =>
          filter === 'all' ? true : filter === 'kept' ? e.verdict === 'kept' : filter === 'errors' ? e.verdict === 'error' : e.verdict !== 'kept' && e.verdict !== 'error',
        )
        .filter((e) => (chain ? e.chain === chain : true))
        .slice(0, FEED_SHOWN),
    [base, filter, chain],
  )

  const live = conn === 'live'
  return (
    <section id="ch-feed" className="panel ch-feed pk-anchor" aria-labelledby="ch-feed-h">
      <div className="panel-head">
        <span id="ch-feed-h">
          <span className="hot">D</span>&nbsp;&nbsp;<b>Live feed</b>
        </span>
        <span className="ch-feed-live">
          <span className={live && !paused && agentsRunning ? 'led on pulse' : 'led'} aria-hidden="true" />
          {paused ? 'paused' : !agentsRunning ? 'stored reads · agents not running' : live ? 'live · newest first' : 'stored reads · socket reconnecting'}
        </span>
      </div>
      <div className="ch-tools">
        <div className="ch-seg" role="group" aria-label="Filter reads by verdict">
          {(['all', 'kept', 'rejected', 'errors'] as FeedFilter[]).map((f) => (
            <button key={f} type="button" className={filter === f ? 'on' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
        <ChainFilter value={chain} onChange={setChain} label="Filter reads by chain" />
        <button type="button" className={`ch-pause ${paused ? 'on' : ''}`} aria-pressed={paused} onClick={togglePause}>
          {paused ? (newer > 0 ? `resume · ${fmtInt(newer)} new` : 'resume') : 'pause'}
        </button>
      </div>
      <div className="ch-feed-scroll" role="region" aria-labelledby="ch-feed-h" tabIndex={0}>
        {shown.length ? (
          <ol className="ch-feed-l">
            {shown.map((e) => (
              <FeedRow key={e.id} e={e} />
            ))}
          </ol>
        ) : (
          <p className="ch-empty mono">
            {feed.length
              ? 'no read matches this filter'
              : feedError
                ? emptyText(feedError, '')
                : feedAt
                  ? 'no reads yet · the first ones appear here as they happen'
                  : 'loading the feed…'}
          </p>
        )}
      </div>
    </section>
  )
}

const FeedRow = memo(function FeedRow({ e }: { e: ChainEvent }) {
  const kept = e.verdict === 'kept'
  const label = e.name || shortAddress(e.address, 6, 6)
  const ext = isChainId(e.chain) ? explorerUrl(e.chain, e.address) : null
  return (
    <li className={`ch-fr ${kept ? 'is-kept' : 'is-rej'}`}>
      <span className="ch-fr-t num">{fmtClock(e.ts)}</span>
      <span className="ch-fr-a mono">{e.agent}</span>
      <span className="ch-fr-c">
        <ChainTag chain={e.chain} />
      </span>
      <span className="ch-fr-x">
        {kept && isChainId(e.chain) ? (
          <Link to={itemPath(e.chain, e.address)} className="ch-fr-n" title={e.address}>
            {label}
          </Link>
        ) : ext ? (
          <a href={ext} target="_blank" rel="noopener noreferrer" className="ch-fr-n" title={`${e.address} on the explorer`}>
            {label}
          </a>
        ) : (
          <span className="ch-fr-n">{label}</span>
        )}
        {e.name && <span className="ch-fr-addr mono">{shortAddress(e.address)}</span>}
        {e.reason && <span className={`ch-fr-r ${kept ? 'ok' : ''}`}>{e.reason}</span>}
      </span>
      <span className="ch-fr-v">
        <ViaTag via={e.via} />
      </span>
      <span className="ch-fr-d">
        <VerdictTag v={e.verdict} />
      </span>
      <span className="ch-fr-m num">
        {e.idl && (
          <span className="ch-fr-idl" title="on-chain IDL">
            IDL ✓
          </span>
        )}
        {e.sourceFiles > 0 ? (
          <span className="ch-fr-src" title={e.verifiedBy ? `verified source · ${verifiedShort(e.verifiedBy)}` : 'source files'}>
            {e.verifiedBy && <span className="ch-fr-by">{verifiedShort(e.verifiedBy)} · </span>}
            {plural(e.sourceFiles, 'file')} · {fmtBytes(e.sourceBytes)}
          </span>
        ) : e.verifiedBy ? (
          <span className="ch-fr-src" title="verified build record; source files are not copied">
            {verifiedShort(e.verifiedBy)}
          </span>
        ) : (
          !e.idl && <span className="ch-fr-none">{DASH}</span>
        )}
      </span>
    </li>
  )
})

function ChainFilter({ value, onChange, label }: { value: ChainId | null; onChange: (c: ChainId | null) => void; label: string }) {
  return (
    <div className="ch-seg" role="group" aria-label={label}>
      <button type="button" className={value === null ? 'on' : ''} aria-pressed={value === null} onClick={() => onChange(null)}>
        all chains
      </button>
      {CHAINS.map((c) => (
        <button key={c} type="button" className={value === c ? 'on' : ''} aria-pressed={value === c} onClick={() => onChange(c)} title={CHAIN_LABEL[c]}>
          {c === 'solana' ? 'sol' : c === 'ethereum' ? 'eth' : c === 'arbitrum' ? 'arb' : 'base'}
        </button>
      ))}
    </div>
  )
}

// ─── kept index ─────────────────────────────────────────────────────────────

const PAGE = 25

interface IndexState {
  items: ChainIndexItem[]
  next: string | null
  loading: boolean
  error: ChainLoadError | null
  loaded: boolean
  /** kept-event counters when the first page was requested: the difference is "N new" */
  base: { seq: number; byChain: Partial<Record<ChainId, number>> }
}

const keptBase = () => ({ seq: useChain.getState().keptSeq, byChain: useChain.getState().keptByChain })

function KeptIndex() {
  const [chain, setChain] = useState<ChainId | null>(null)
  const [st, setSt] = useState<IndexState>(() => ({ items: [], next: null, loading: true, error: null, loaded: false, base: keptBase() }))
  const [reload, setReload] = useState(0)
  const keptSeq = useChain((s) => s.keptSeq)
  const keptByChain = useChain((s) => s.keptByChain)
  const ctl = useRef<AbortController | null>(null)
  const now = useNow(30_000)

  /** Start over from the first page (chain filter changed, or refresh). */
  const restart = (next: ChainId | null) => {
    setSt((p) => ({ ...p, loading: true, error: null, base: keptBase() }))
    setChain(next)
    setReload((n) => n + 1)
  }

  // first page (on mount, chain change or refresh); the loading state is set by whoever asked
  useEffect(() => {
    ctl.current?.abort()
    const c = new AbortController()
    ctl.current = c
    fetchChainItems({ chain, limit: PAGE }, c.signal).then(
      (page) => {
        if (c.signal.aborted) return
        setSt((p) => ({ ...p, items: page.items, next: page.next, loading: false, error: null, loaded: true }))
      },
      (e) => {
        if (c.signal.aborted) return
        setSt((p) => ({ ...p, loading: false, error: classifyError(e) }))
      },
    )
    return () => c.abort()
  }, [chain, reload])

  const more = () => {
    if (!st.next || st.loading) return
    const c = new AbortController()
    ctl.current = c
    const cursor = st.next
    setSt((p) => ({ ...p, loading: true, error: null }))
    fetchChainItems({ chain, limit: PAGE, cursor }, c.signal).then(
      (page) => {
        if (c.signal.aborted) return
        setSt((p) => {
          const seen = new Set(p.items.map((i) => `${i.chain}:${i.address}`))
          return { ...p, items: [...p.items, ...page.items.filter((i) => !seen.has(`${i.chain}:${i.address}`))], next: page.next, loading: false, error: null, loaded: true }
        })
      },
      (e) => {
        if (c.signal.aborted) return
        setSt((p) => ({ ...p, loading: false, error: classifyError(e) }))
      },
    )
  }

  const fresh = chain ? (keptByChain[chain] ?? 0) - (st.base.byChain[chain] ?? 0) : keptSeq - st.base.seq

  return (
    <section id="ch-index" className="panel ch-index pk-anchor" aria-labelledby="ch-index-h">
      <div className="panel-head">
        <span id="ch-index-h">
          <span className="hot">E</span>&nbsp;&nbsp;<b>Kept index</b>
        </span>
        <span className="num">{st.loaded ? `${fmtInt(st.items.length)}${st.next ? '+' : ''} shown · newest first` : DASH}</span>
      </div>
      <div className="ch-tools">
        <ChainFilter value={chain} onChange={(c) => c !== chain && restart(c)} label="Filter the kept index by chain" />
        {fresh > 0 && (
          <button type="button" className="ch-pause on" onClick={() => restart(chain)}>
            {fmtInt(fresh)} new · refresh
          </button>
        )}
      </div>
      {st.items.length ? (
        <div className="ch-tbl-scroll" role="region" aria-labelledby="ch-index-h" tabIndex={0}>
          <table className="ch-tbl">
            <caption className="sr-only">Programs and contracts kept as SEPIA-1 training data, newest first. Each name opens the stored record.</caption>
            <colgroup>
              <col className="w-name" />
              <col className="w-chain" />
              <col className="w-kind" />
              <col className="w-ver" />
              <col className="w-idl" />
              <col className="w-n" />
              <col className="w-size" />
              <col className="w-time" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className="c-name">
                  name
                </th>
                <th scope="col">chain</th>
                <th scope="col">kind</th>
                <th scope="col">verified by</th>
                <th scope="col">IDL</th>
                <th scope="col" className="c-n">
                  files
                </th>
                <th scope="col" className="c-n">
                  size
                </th>
                <th scope="col">read (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {st.items.map((it) => (
                <tr key={`${it.chain}:${it.address}`}>
                  <td className="c-name">
                    {isChainId(it.chain) ? (
                      <Link to={itemPath(it.chain, it.address)} className="ch-tbl-n" title={it.address}>
                        {it.name || shortAddress(it.address, 6, 6)}
                      </Link>
                    ) : (
                      <span className="ch-tbl-n">{it.name || shortAddress(it.address, 6, 6)}</span>
                    )}
                    {it.name && <span className="ch-tbl-a">{shortAddress(it.address)}</span>}
                  </td>
                  <td>{chainLabel(it.chain)}</td>
                  <td>{KIND_LABEL[it.kind] ?? it.kind}</td>
                  <td className={it.verifiedBy ? 'c-ver' : 'c-dim'}>{verifiedShort(it.verifiedBy)}</td>
                  <td className={it.idl ? 'c-ok' : 'c-dim'}>{it.idl ? '✓' : DASH}</td>
                  <td className="c-n num">{it.sourceFiles > 0 ? fmtInt(it.sourceFiles) : DASH}</td>
                  <td className="c-n num">{it.sourceBytes > 0 ? fmtBytes(it.sourceBytes) : DASH}</td>
                  <td className="num" title={ago(it.readAt, now)}>
                    {fmtUtcShort(it.readAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ch-empty mono">
          {st.loading
            ? 'loading the index…'
            : st.error
              ? emptyText(st.error, '')
              : chain
                ? `nothing kept on ${CHAIN_LABEL[chain]} yet`
                : 'nothing kept yet · kept programs and contracts appear here'}
        </p>
      )}
      {(st.next || (st.error && st.items.length > 0)) && (
        <div className="ch-more">
          {st.error && st.items.length > 0 && <span className="ch-more-err mono">{emptyText(st.error, '')}</span>}
          {st.next && (
            <button type="button" className="btn" onClick={more} disabled={st.loading}>
              {st.loading ? 'loading…' : `load ${PAGE} more`}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
