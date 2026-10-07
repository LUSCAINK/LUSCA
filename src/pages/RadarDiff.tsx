// RADAR DIFF — /radar/:id: the source change behind one EVM upgrade. Both implementations verified on
// Sourcify: the files that changed, line by line (both line numbers), the functions they touch, access
// checks flagged. Solana programs and unverified implementations: the facts the radar read and why there
// is no source diff. Data: GET /api/radar/:id (facts) and GET /api/radar/:id/diff (computed once, cached).
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { RadarEvent } from '@shared/radar'
import type { DiffFile, DiffFunction, DiffLine, RadarCodeDiff } from '@shared/radarDiff'
import { Kicker } from '@/components/docs/pagekit'
import { CHAIN_LABEL, explorerName, explorerUrl, shortAddress } from '@/lib/chain'
import { DASH, fmtInt } from '@/lib/format'
import { VERIFIED_WORD, fetchRadarEvent, txUrl } from '@/lib/radar'
import './radardiff.css'
import { NAV_N } from '@/lib/nav'

const RADAR_NAV_N = NAV_N.radar
const p2 = (n: number) => String(n).padStart(2, '0')
function utc(ts: number): string {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`
}
const short = (a: string | null | undefined) => shortAddress(a, 6, 4)

async function fetchDiff(id: string, signal: AbortSignal): Promise<RadarCodeDiff | null> {
  const res = await fetch(`/api/radar/${encodeURIComponent(id)}/diff`, { headers: { Accept: 'application/json' }, signal })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as RadarCodeDiff
}

function jump(id: string | null) {
  if (!id) return
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  el.classList.remove('flash')
  void el.offsetWidth
  el.classList.add('flash')
  history.replaceState(null, '', `#${id}`)
}

export default function RadarDiff() {
  const { id = '' } = useParams()
  const [ev, setEv] = useState<RadarEvent | null>(null)
  const [d, setD] = useState<RadarCodeDiff | null>(null)
  const [load, setLoad] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    document.title = 'Radar diff — LUSCA'
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    let timer = 0
    Promise.all([fetchRadarEvent(id, ac.signal), fetchDiff(id, ac.signal)])
      .then(([e, x]) => {
        if (!e && !x) return setLoad('missing')
        setEv(e)
        setD(x)
        setLoad('ok')
        if (x?.state === 'pending') timer = window.setTimeout(() => setTick((t) => t + 1), 15_000)
      })
      .catch(() => !ac.signal.aborted && setLoad('error'))
    return () => {
      ac.abort()
      window.clearTimeout(timer)
    }
  }, [id, tick])

  // a #hunk in the address: jump there once the diff is on the page
  useEffect(() => {
    if (d?.state !== 'ready' || !location.hash) return
    const t = window.setTimeout(() => jump(location.hash.slice(1)), 120)
    return () => window.clearTimeout(t)
  }, [d])

  const chain = d?.chain ?? ev?.chain ?? null
  const sol = chain === 'solana'
  const name = d?.name ?? ev?.name ?? null
  const address = d?.address ?? ev?.address ?? ''
  const tx = chain ? txUrl(chain, d?.tx ?? ev?.tx ?? null) : null
  const acLines = useMemo(() => (d ? d.files.reduce((s, f) => s + f.hunks.reduce((a, h) => a + h.lines.filter((l) => l.ac && l.t !== ' ').length, 0), 0) : 0), [d])
  const fnCount = (c: DiffFunction['change']) => d?.functions.filter((f) => f.change === c).length ?? 0

  if (load === 'loading') return <main className="rdf"><p className="rdf-msg mono">Reading the change…</p></main>
  if (load === 'missing') {
    return (
      <main className="rdf">
        <p className="rdf-msg mono">
          No radar event with this id. <Link to="/radar">Back to the radar →</Link>
        </p>
      </main>
    )
  }
  if (load === 'error') {
    return (
      <main className="rdf">
        <p className="rdf-msg mono">
          The diff could not be loaded. <button type="button" onClick={() => { setLoad('loading'); setTick((t) => t + 1) }}>Try again</button>
        </p>
      </main>
    )
  }

  const oldImpl = d?.oldImpl ?? ev?.before?.implementation ?? null
  const newImpl = d?.newImpl ?? ev?.after?.implementation ?? null
  const vB = d?.oldVerified ?? ev?.before?.verified ?? null
  const vA = d?.newVerified ?? ev?.after?.verified ?? null
  const ready = d?.state === 'ready'

  return (
    <main className="rdf">
      <header className="rdf-hero">
        <span className="rdf-tick tl" aria-hidden="true" />
        <span className="rdf-tick tr" aria-hidden="true" />
        <span className="rdf-tick bl" aria-hidden="true" />
        <span className="rdf-tick br" aria-hidden="true" />
        <Kicker n={RADAR_NAV_N} name="Radar · diff" className="rdf-kick">
          <Link to="/radar" className="rdf-back mono">
            ← all changes
          </Link>
        </Kicker>
        <div className="rdf-title-row">
          <h1 className={`rdf-title ${name ? 'display' : 'addr mono'}`}>{name ?? short(address)}</h1>
          <span className="rdf-badge mono">{sol ? 'Upgraded program' : 'Upgraded implementation'}</span>
        </div>
        <dl className="rdf-facts mono">
          <div>
            <dt>Chain</dt>
            <dd>{chain ? CHAIN_LABEL[chain] : DASH}</dd>
          </div>
          <div className="wide xwide">
            <dt>{sol ? 'Program' : 'Proxy'}</dt>
            <dd>
              {chain && explorerUrl(chain, address) ? (
                <a href={explorerUrl(chain, address) ?? undefined} target="_blank" rel="noopener noreferrer">
                  {address}
                </a>
              ) : (
                address
              )}
            </dd>
          </div>
          {!sol && (
            <div className="wide">
              <dt>Implementation</dt>
              <dd className="impl">
                {oldImpl && chain ? <Link to={`/lens/${chain}/${oldImpl}`}>{short(oldImpl)}</Link> : DASH}
                <span className="arrow">→</span>
                {newImpl && chain ? <Link to={`/lens/${chain}/${newImpl}`} className="hot">{short(newImpl)}</Link> : DASH}
              </dd>
            </div>
          )}
          <div>
            <dt>{sol ? 'Signature' : 'Tx'}</dt>
            <dd>
              {tx ? (
                <a href={tx} target="_blank" rel="noopener noreferrer">
                  {short(d?.tx ?? ev?.tx)} ↗
                </a>
              ) : (
                DASH
              )}
            </dd>
          </div>
          <div>
            <dt>{sol ? 'Slot' : 'Block'}</dt>
            <dd>{sol ? (ev?.slot != null ? fmtInt(ev.slot) : DASH) : d?.block != null || ev?.block != null ? fmtInt((d?.block ?? ev?.block) as number) : DASH}</dd>
          </div>
          <div>
            <dt>Landed</dt>
            <dd>{d?.ts || ev?.ts ? utc((d?.ts ?? ev?.ts) as number) : DASH}</dd>
          </div>
          {(ev?.before?.codeHash || ev?.after?.codeHash) && (
            <div className="wide">
              <dt>Code hash</dt>
              <dd>
                {ev?.before?.codeHash && (
                  <>
                    {ev.before.codeHash.slice(0, 10)}…{ev.before.codeHash.slice(-4)} <span className="arrow">→</span>{' '}
                  </>
                )}
                <span className="hot">{ev?.after?.codeHash ? `${ev.after.codeHash.slice(0, 10)}…${ev.after.codeHash.slice(-4)}` : DASH}</span>
              </dd>
            </div>
          )}
          {sol && ev?.after && (
            <div className="wide">
              <dt>Upgrade authority</dt>
              <dd>{ev.after.authority ?? (ev.after.upgradeable === false ? 'none · immutable' : 'none')}</dd>
            </div>
          )}
          <div className="wide">
            <dt>Verified</dt>
            <dd>
              {vB && (
                <>
                  {VERIFIED_WORD[vB]} <span className="arrow">→</span>{' '}
                </>
              )}
              {vA ? VERIFIED_WORD[vA] : DASH}
              {d?.newCompiler && <span className="dim"> · {d.newCompiler}</span>}
            </dd>
          </div>
        </dl>
      </header>

      {ready && d && (
        <section className="rdf-strip mono" aria-label="Size of the change">
          <div>
            <b className="num">{fmtInt(d.totals.files)}</b>
            <span>files changed</span>
          </div>
          <div className="add">
            <b className="num">+{fmtInt(d.totals.add)}</b>
            <span>lines added</span>
          </div>
          <div className="del">
            <b className="num">−{fmtInt(d.totals.del)}</b>
            <span>lines removed</span>
          </div>
          <div>
            <b className="num">
              {fnCount('added')}/{fnCount('modified')}/{fnCount('removed')}
            </b>
            <span>functions added / modified / removed</span>
          </div>
          <div className="hot">
            <b className="num">{fmtInt(acLines)}</b>
            <span>changed lines with an access check</span>
          </div>
          <div className="dim">
            <b className="num">{fmtInt(d.unchangedFiles)}</b>
            <span>files identical</span>
          </div>
        </section>
      )}

      {ready && d && <KeyFns fns={d.functions} />}

      {!ready && (
        <section className="rdf-none">
          <p className="mono k">{d?.state === 'pending' ? 'Not computed yet' : 'No source diff'}</p>
          <p className="rdf-reason">{d?.reason ?? (sol ? 'Solana program: source not published on-chain.' : 'There is no source diff for this change.')}</p>
          {ev && (
            <p className="mono dim">
              {ev.headline}
            </p>
          )}
          <Link to="/radar" className="mono hot">
            Back to the radar →
          </Link>
        </section>
      )}

      {ready && d && d.files.length > 0 && (
        <div className="rdf-body">
          <aside className="rdf-side">
            <div className="rdf-side-in">
              <FnIndex fns={d.functions} />
              <section className="rdf-files" aria-label="Changed files">
                <h2 className="mono k">Files · {d.files.length}</h2>
                <ul>
                  {d.files.map((f) => (
                    <li key={f.id}>
                      <button type="button" onClick={() => jump(f.id)} title={f.path}>
                        <span className={`st ${f.status}`}>{f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : 'M'}</span>
                        <span className="p">{f.path.split('/').pop()}</span>
                        <span className="c">
                          <i className="a">+{f.add}</i> <i className="r">−{f.del}</i>
                        </span>
                        <Bar add={f.add} del={f.del} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </aside>
          <div className="rdf-main">
            {d.truncated && <p className="rdf-trunc mono">{d.truncated}</p>}
            {d.files.map((f) => (
              <FileView key={f.id} f={f} />
            ))}
            <p className="rdf-src mono dim">
              Source: Sourcify verified files of both implementations · line endings normalized · {fmtInt(d.unchangedFiles)} identical files not shown
              {chain && newImpl && explorerUrl(chain, newImpl) ? (
                <>
                  {' '}
                  ·{' '}
                  <a href={explorerUrl(chain, newImpl) ?? undefined} target="_blank" rel="noopener noreferrer">
                    {explorerName(chain)} ↗
                  </a>
                </>
              ) : null}
            </p>
          </div>
        </div>
      )}
    </main>
  )
}

function Bar({ add, del }: { add: number; del: number }) {
  const tot = add + del || 1
  const cells = 5
  const a = Math.round((add / tot) * cells)
  return (
    <span className="bar" aria-hidden="true">
      {Array.from({ length: cells }, (_, i) => (
        <i key={i} className={i < a ? 'a' : 'r'} />
      ))}
    </span>
  )
}

const CHANGE_GLYPH: Record<DiffFunction['change'], string> = { added: '+', modified: '~', removed: '−' }

function FnIndex({ fns }: { fns: DiffFunction[] }) {
  if (!fns.length) return null
  const groups: DiffFunction['change'][] = ['added', 'modified', 'removed']
  return (
    <section className="rdf-fns" aria-label="Changed functions">
      <h2 className="mono k">Changed functions · {fns.length}</h2>
      {groups.map((g) => {
        const list = fns.filter((f) => f.change === g)
        if (!list.length) return null
        return (
          <div key={g} className={`grp ${g}`}>
            <h3 className="mono">
              {g} · {list.length}
            </h3>
            <ul>
              {list.map((f) => (
                <li key={`${f.file}|${f.sig}|${f.line}`}>
                  <button type="button" onClick={() => jump(f.hunk)} disabled={!f.hunk} className={f.access ? 'ac' : ''}>
                    <span className="g">{CHANGE_GLYPH[f.change]}</span>
                    <span className="sig">
                      {f.kind !== 'function' && <em>{f.kind} </em>}
                      {f.sig}
                    </span>
                    <span className="at">{f.at}</span>
                    {f.access && (
                      <span className="acc" title={f.accessBefore !== undefined ? `before: ${f.accessBefore ?? 'none'}` : undefined}>
                        {f.accessBefore !== undefined && <s>{f.accessBefore ?? 'none'}</s>} {f.access}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

const isComment = (s: string) => /^\s*(\/\/|\/\*|\*)/.test(s)

/** New or changed functions with an access check: the lines to read first. */
function KeyFns({ fns }: { fns: DiffFunction[] }) {
  const key = fns.filter((f) => f.access && f.kind !== 'modifier' && (f.change === 'added' || f.accessBefore !== undefined)).slice(0, 4)
  if (!key.length) return null
  return (
    <section className="rdf-key" aria-label="Access-checked functions this upgrade adds or changes">
      <span className="mono k">Access-checked functions added or changed</span>
      <ul>
        {key.map((f) => (
          <li key={`${f.file}|${f.sig}`}>
            <button type="button" onClick={() => jump(f.hunk)} disabled={!f.hunk} className="mono">
              <span className="chg">{f.change === 'added' ? 'new' : 'check changed'}</span>
              <b>{f.sig}</b>
              <span className="acc">
                {f.accessBefore !== undefined && <s>{f.accessBefore ?? 'none'}</s>} {f.access}
              </span>
              <span className="at">{f.at}</span>
              {f.hunk && <span className="go">→</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

const TOK_RE = /(\/\/.*$|\/\*.*?\*\/|"[^"]*"|'[^']*')|\b(function|modifier|constructor|returns?|require|revert|emit|event|error|if|else|for|while|external|public|internal|private|view|pure|payable|override|virtual|memory|calldata|storage|contract|interface|library|abstract|import|pragma|using|struct|enum|mapping|immutable|constant|unchecked|new|delete|is)\b|\b(only[A-Z_][\w$]*|msg\.sender|_msgSender)\b/g

/** Light Solidity tinting: comments and strings quiet, keywords bright, access words in accent. */
function Code({ s }: { s: string }) {
  if (isComment(s)) return <span className="s">{s || ' '}</span>
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of s.matchAll(TOK_RE)) {
    const at = m.index ?? 0
    if (at > last) out.push(s.slice(last, at))
    out.push(
      <span key={i++} className={m[1] ? 'tq' : m[2] ? 'tk' : 'ta'}>
        {m[0]}
      </span>,
    )
    last = at + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return <span className="s">{out.length ? out : ' '}</span>
}

function Line({ l }: { l: DiffLine }) {
  const cls = `${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}${l.ac ? ' ac' : ''}${isComment(l.s) ? ' cm' : ''}`
  return (
    <tr className={cls}>
      <td className="ln o">{l.o ?? ''}</td>
      <td className="ln n">{l.n ?? ''}</td>
      <td className="mk">{l.t === ' ' ? '' : l.t === '+' ? '+' : '−'}</td>
      <td className="code">
        <Code s={l.s} />
        {l.ac && l.t !== ' ' ? <span className="acflag">access</span> : null}
      </td>
    </tr>
  )
}

function FileView({ f }: { f: DiffFile }) {
  const [open, setOpen] = useState(true)
  return (
    <section className={`rdf-file ${f.status}`} id={f.id}>
      <header className="rdf-file-h mono">
        <button type="button" className="tg" onClick={() => setOpen((x) => !x)} aria-expanded={open} aria-label={open ? 'Collapse file' : 'Expand file'}>
          {open ? '▾' : '▸'}
        </button>
        <span className={`st ${f.status}`}>{f.status}</span>
        <span className="path" title={f.path}>
          {f.oldPath && <span className="old">{f.oldPath} → </span>}
          {f.path}
        </span>
        <span className="c">
          <i className="a">+{fmtInt(f.add)}</i> <i className="r">−{fmtInt(f.del)}</i>
        </span>
      </header>
      {open && (
        <div className="rdf-code">
          <table>
            <tbody>
              {f.hunks.map((h) => (
                <HunkRows key={h.id} h={h} />
              ))}
            </tbody>
          </table>
          {f.omitted && (
            <p className="rdf-omit mono">
              {fmtInt(f.omitted.lines)} lines in {f.omitted.hunks} hunk{f.omitted.hunks === 1 ? '' : 's'} of this file not shown (size bound)
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function HunkRows({ h }: { h: DiffFile['hunks'][number] }) {
  return (
    <>
      <tr className="hk" id={h.id}>
        <td colSpan={3} className="hk-l">
          ⋯
        </td>
        <td className="hk-t">
          @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@{h.ctx ? <b> {h.ctx}</b> : null}
        </td>
      </tr>
      {h.lines.map((l, i) => (
        <Line key={i} l={l} />
      ))}
    </>
  )
}
