// ADVISORIES — /advisories: every kept EVM contract's verified Solidity source checked against every published
// OpenZeppelin Contracts security advisory (files byte-identical to a file of an affected release, or whose release
// header names one) and against the known bugs of its exact solc version. Stored sources only, no RPC.
// Facts with evidence: a match says affected code is present, never that a contract can be exploited.
//
// Data: GET /api/advisories/summary (census, polled every 30 s), /api/advisories/items?advisory=|bug=&chain=&cursor=,
//       /api/advisories/:chain/:address (lookup).
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { ChainId } from '@shared/chain'
import type { AdvisoryList, AdvisorySummary } from '@shared/advisory'
import { ADVISORY_SCOPE, COMPILER_SCOPE } from '@shared/advisory'
import { Kicker } from '@/components/docs/pagekit'
import { AdvisoryCard, Conditions, EvidenceLine, SEV_LABEL, useAdvisoryItem } from '@/components/advisory/AdvisoryCard'
import { CHAIN_LABEL, CHAIN_SHORT, shortAddress } from '@/lib/chain'
import { DASH, fmtInt } from '@/lib/format'
import './advisories.css'

/** Position of /advisories in the primary navigation (set when the nav is integrated in src/components/shell/Shell.tsx). */
const ADVISORIES_NAV_N = '13'
const EVM: ChainId[] = ['ethereum', 'base', 'arbitrum']

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal })
  if (!r.ok) throw new Error(String(r.status))
  return (await r.json()) as T
}
const fmtPct = (n: number, d: number) => {
  if (!d) return DASH
  const v = (n / d) * 100
  return `${v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)}%`
}
const fmtDay = (iso: string) => (iso ? iso.slice(0, 10) : DASH)

export default function Advisories() {
  useEffect(() => {
    document.title = 'Advisories — LUSCA'
  }, [])
  const [sum, setSum] = useState<AdvisorySummary | null>(null)
  const [sumErr, setSumErr] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [bugOpen, setBugOpen] = useState<string | null>(null)
  const [chain, setChain] = useState<ChainId | ''>('')
  const [showAll, setShowAll] = useState(false)
  const [look, setLook] = useState<Query | null>(null)

  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    const pull = () =>
      getJson<AdvisorySummary>('/api/advisories/summary', ac.signal)
        .then((s) => {
          if (!alive) return
          setSum(s)
          setSumErr(false)
        })
        .catch(() => alive && !ac.signal.aborted && setSumErr(true))
    void pull()
    const t = window.setInterval(pull, 30_000)
    return () => {
      alive = false
      ac.abort()
      window.clearInterval(t)
    }
  }, [])

  const advs = useMemo(() => {
    const list = [...(sum?.advisories ?? [])]
    const order: Record<string, number> = { critical: 0, high: 1, moderate: 2, low: 3 }
    return list.sort((a, b) => b.contracts - a.contracts || order[a.severity] - order[b.severity] || a.id.localeCompare(b.id))
  }, [sum])
  const maxC = Math.max(1, ...advs.map((a) => a.contracts))
  const shown = showAll ? advs : advs.filter((a) => a.contracts > 0)
  const quiet = advs.length - advs.filter((a) => a.contracts > 0).length
  const checked = sum?.checked ?? 0
  const running = sum?.progress.running

  const head: [string, string, string, boolean][] = [
    ['kept contracts checked', sum ? fmtInt(checked) : DASH, sum ? `${fmtInt(sum.byChain.ethereum ?? 0)} ETH · ${fmtInt(sum.byChain.base ?? 0)} BASE · ${fmtInt(sum.byChain.arbitrum ?? 0)} ARB` : '', false],
    ['include OpenZeppelin release files', sum ? fmtPct(sum.withOz, checked) : DASH, sum ? `${fmtInt(sum.withOz)} contracts · ${fmtInt(sum.ozFiles)} identical files` : '', false],
    ['include a file from an affected release', sum ? fmtInt(sum.withAdvisoryFile) : DASH, sum ? `${fmtPct(sum.withAdvisoryFile, checked)} of checked · ${advs.filter((a) => a.contracts > 0).length} of ${advs.length} advisories present` : '', true],
    ['solc version lists a high-severity bug', sum ? fmtInt(sum.compiler.bySeverity.high ?? 0) : DASH, sum ? `${fmtPct(sum.compiler.bySeverity.high ?? 0, sum.compiler.known)} of ${fmtInt(sum.compiler.known)} with a known solc version · conditions not checked` : '', false],
  ]

  return (
    <div className="av">
      <header className="av-hero">
        <div className="av-hero-l">
          <Kicker n={ADVISORIES_NAV_N} name="Advisories" className="av-kick">
            <span className="av-live mono">
              <span className={sum && !sumErr ? 'led on' : 'led'} aria-hidden="true" />
              {sumErr ? 'server unreachable' : sum ? (running ? `checking · ${fmtInt(sum.progress.done)} of ${fmtInt(sum.progress.total)}` : `all ${fmtInt(sum.progress.total)} kept EVM contracts checked`) : 'loading'}
            </span>
          </Kicker>
          <h1 className="av-title display">
            Advisory
            <br />
            check
          </h1>
          <p className="av-lede">
            Every kept contract’s verified Solidity source, file by file, against every published OpenZeppelin Contracts security advisory and the known bugs of
            the exact compiler version it was built with. {sum ? `${fmtInt(sum.data.ozVersions)} releases fingerprinted · ${fmtInt(sum.data.ozUniqueFiles)} distinct files · ${advs.length} advisories · ${fmtInt(sum.data.solcBugs)} compiler bugs.` : ''}
          </p>
          <Lookup onCheck={setLook} />
        </div>
        <dl className="av-head">
          {head.map(([k, v, s, hot]) => (
            <div key={k} className={hot ? 'hot' : ''}>
              <dt className="mono">{k}</dt>
              <dd className="num">{v}</dd>
              <dd className="av-head-s mono">{s}</dd>
            </div>
          ))}
          <span className="av-tick tl" aria-hidden="true" />
          <span className="av-tick br" aria-hidden="true" />
        </dl>
      </header>

      {look && <LookupResult key={`${look.chain}:${look.address}`} q={look} onClose={() => setLook(null)} />}

      <p className="av-band mono" role="note">
        <span className="hot">■</span> {sum?.scope ?? ADVISORY_SCOPE}
      </p>

      <section className="av-advs" aria-label="OpenZeppelin Contracts advisories">
        <div className="av-sec-h mono">
          <span>
            <span className="hot">■</span> OpenZeppelin Contracts advisories · kept contracts that include the affected file
          </span>
          <span className="av-filt" role="group" aria-label="Chain">
            <button className={!chain ? 'on' : ''} aria-pressed={!chain} onClick={() => setChain('')}>
              All
            </button>
            {EVM.map((c) => (
              <button key={c} className={chain === c ? 'on' : ''} aria-pressed={chain === c} onClick={() => setChain(c)}>
                {CHAIN_SHORT[c]}
              </button>
            ))}
          </span>
        </div>
        <div className="av-thead mono" aria-hidden="true">
          <span>severity</span>
          <span>advisory</span>
          <span>affected → fixed in</span>
          <span>kept contracts</span>
        </div>
        {!sum ? (
          <p className="av-empty mono">{sumErr ? 'Can’t reach the LUSCA server — retrying…' : 'Loading…'}</p>
        ) : (
          <ol className="av-rows">
            {shown.map((a) => {
              const isOpen = open === a.id
              const files = a.packages.flatMap((p) => p.files.map((f) => `${p.name.replace('@openzeppelin/', '')}/${f.path}`))
              return (
                <li key={a.id} className={`av-row sv-${a.severity} ${isOpen ? 'open' : ''} ${a.contracts ? '' : 'zero'}`}>
                  <button className="av-row-b" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : a.id)}>
                    <span className={`av-sev mono sv-${a.severity}`}>{SEV_LABEL[a.severity]}</span>
                    <span className="av-row-t">
                      <span className="av-row-id mono">
                        {a.id}
                        {a.aliases.filter((x) => x.startsWith('CVE')).slice(0, 1).map((x) => (
                          <i key={x}> · {x}</i>
                        ))}
                      </span>
                      <span className="av-row-title">{a.title}</span>
                      <span className="av-row-files mono">{[...new Set(files.map((f) => f.split('/').pop()))].join(' · ')}</span>
                    </span>
                    <span className="av-row-rng mono">
                      {a.packages.map((p) => (
                        <span key={p.name}>
                          <i>{p.name === '@openzeppelin/contracts' ? 'contracts' : 'upgradeable'}</i> {p.label.replace(/>= /g, '≥').replace(/< /g, '<')}
                          {p.fixedIn.length > 0 && <b> → {p.fixedIn.join(' / ')}</b>}
                        </span>
                      ))}
                    </span>
                    <span className="av-row-n">
                      <span className="num">{fmtInt(a.contracts)}</span>
                      <span className="av-bar" aria-hidden="true">
                        <span style={{ width: `${(a.contracts / maxC) * 100}%` }} />
                      </span>
                      <span className="av-row-m mono">{a.contracts ? `${fmtInt(a.byMethod.hash)} identical · ${fmtInt(a.byMethod.header)} by header` : 'none kept'}</span>
                    </span>
                    <span className="av-row-x" aria-hidden="true" />
                  </button>
                  {isOpen && (
                    <div className="av-row-d">
                      <div className="av-map">
                        {a.packages.map((p) =>
                          p.files.map((f) => (
                            <div key={`${p.name}/${f.path}`} className="av-map-r">
                              <code className="mono">
                                {p.name}/<b>{f.path}</b>
                              </code>
                              <span className="av-map-e">{f.evidence}</span>
                              <span className="av-map-m mono">
                                {fmtInt(f.copies)} affected cop{f.copies === 1 ? 'y' : 'ies'} fingerprinted{f.label ? ` · this file: ${f.label}` : ''} ·{' '}
                                <a href={f.ref} target="_blank" rel="noreferrer">
                                  reference ↗
                                </a>
                              </span>
                            </div>
                          )),
                        )}
                        {a.note && <p className="av-map-note mono">{a.note}</p>}
                        <a className="av-map-adv mono" href={a.url} target="_blank" rel="noreferrer">
                          read the advisory ↗
                        </a>
                      </div>
                      <Matches advisory={a.id} chain={chain} />
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
        {sum && quiet > 0 && (
          <button className="av-showall mono" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'hide' : 'show'} the {quiet} advisor{quiet === 1 ? 'y' : 'ies'} no kept contract includes
          </button>
        )}
      </section>

      {sum && sum.topReleases.length > 0 && (
        <section className="av-rel" aria-label="OpenZeppelin releases found in kept contracts">
          <div className="av-sec-h mono">
            <span>
              <span className="hot">■</span> releases · the OpenZeppelin release consistent with every identical file of a contract
            </span>
            <span className="dim">{fmtInt(sum.withOz)} contracts include release files</span>
          </div>
          <ol className="av-rel-list">
            {sum.topReleases.map((r) => (
              <li key={`${r.pkg}:${r.label}`}>
                <span className="num">{fmtInt(r.contracts)}</span>
                <span className="av-rel-l">
                  <b>{r.label.replace(/ \(\d+ releases\)$/, '')}</b>
                  <i className="mono">{r.pkg.replace('@openzeppelin/', '')}</i>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="av-solc" aria-label="Known Solidity compiler bugs">
        <div className="av-sec-h mono">
          <span>
            <span className="hot">■</span> compiler · known bugs of the exact solc version each contract was verified with
          </span>
          <span className="dim">{sum ? `${fmtInt(sum.compiler.known)} contracts with a known solc version · ${sum.compiler.versions.length} versions` : ''}</span>
        </div>
        <p className="av-band in mono" role="note">
          {sum?.compilerScope ?? COMPILER_SCOPE}
        </p>
        {sum && (
          <div className="av-solc-sev">
            {['high', 'medium/high', 'medium', 'low/medium', 'low', 'very low'].map((s) => (
              <div key={s} className={`av-solc-sev-c s-${s.replace(/[^a-z]/g, '')}`}>
                <span className="num">{fmtInt(sum.compiler.bySeverity[s] ?? 0)}</span>
                <span className="mono">contracts · ≥1 {s} bug listed</span>
              </div>
            ))}
          </div>
        )}
        {sum && (
          <ol className="av-bugrows">
            {sum.compiler.bugs.map((b) => {
              const isOpen = bugOpen === b.name
              return (
                <li key={b.name} className={isOpen ? 'open' : ''}>
                  <button className="av-bugrow-b" aria-expanded={isOpen} onClick={() => setBugOpen(isOpen ? null : b.name)}>
                    <span className={`av-bsev mono s-${b.severity.replace(/[^a-z]/g, '')}`}>{b.severity}</span>
                    <span className="av-bugrow-t">
                      <span className="av-bugrow-n mono">{b.name}</span>
                      <span className="av-bugrow-s">{b.summary.replace(/``/g, '')}</span>
                      <Conditions c={b.conditions} />
                    </span>
                    <span className="av-bugrow-c">
                      <span className="num">{fmtInt(b.contracts)}</span>
                      <span className="mono">contracts</span>
                    </span>
                    <span className="av-row-x" aria-hidden="true" />
                  </button>
                  {isOpen && (
                    <div className="av-row-d">
                      {b.link && (
                        <a className="av-map-adv mono" href={b.link} target="_blank" rel="noreferrer">
                          the Solidity team’s write-up ↗
                        </a>
                      )}
                      <Matches bug={b.name} chain={chain} />
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </section>

      <footer className="av-foot mono">
        {sum ? (
          <span>
            Release fingerprints: every published version of {sum.data.packages.join(' and ')} from the npm registry ({fmtDay(sum.data.fingerprintsAt)}), each tarball
            checked against the registry’s integrity hash. Advisories: osv.dev and GitHub, mapped to files by hand ({sum.data.advisoriesReviewedAt}). Compiler bugs: the
            Solidity team’s bugs.json ({fmtDay(sum.data.solcBugsAt)}). Not checked: {fmtInt(sum.notChecked.vyper)} Vyper · {fmtInt(sum.notChecked.noSource)} without stored
            source · {fmtInt(sum.notChecked.solana)} Solana programs. Stored sources only, no RPC.
          </span>
        ) : (
          <span>{DASH}</span>
        )}
      </footer>
    </div>
  )
}

/** Kept contracts for one advisory (with file:line evidence) or one compiler bug, newest kept first, paged. */
function Matches({ advisory, bug, chain }: { advisory?: string; bug?: string; chain: ChainId | '' }) {
  const [list, setList] = useState<AdvisoryList | null>(null)
  const [err, setErr] = useState(false)
  const q = (cursor?: string) => {
    const p = new URLSearchParams()
    if (advisory) p.set('advisory', advisory)
    if (bug) p.set('bug', bug)
    if (chain) p.set('chain', chain)
    if (cursor) p.set('cursor', cursor)
    return `/api/advisories/items?${p}`
  }
  useEffect(() => {
    const ac = new AbortController()
    setList(null)
    setErr(false)
    getJson<AdvisoryList>(q(), ac.signal)
      .then(setList)
      .catch(() => !ac.signal.aborted && setErr(true))
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- q() reads advisory / bug / chain
  }, [advisory, bug, chain])
  const more = () => {
    if (!list?.next) return
    getJson<AdvisoryList>(q(list.next))
      .then((pg) => setList((cur) => (cur ? { ...pg, items: [...cur.items, ...pg.items] } : pg)))
      .catch(() => setErr(true))
  }
  if (err) return <p className="av-empty mono">Can’t reach the LUSCA server.</p>
  if (!list) return <p className="av-empty mono">Loading…</p>
  if (!list.items.length) return <p className="av-empty mono">{chain ? `none on ${CHAIN_LABEL[chain]}` : 'no kept contract includes it'}</p>
  return (
    <div className="av-m">
      <div className="av-m-h mono">
        {fmtInt(list.total)} kept contract{list.total === 1 ? '' : 's'}
        {chain ? ` on ${CHAIN_LABEL[chain]}` : ''}
      </div>
      <ol className="av-m-list">
        {list.items.map((it) => (
          <li key={`${it.chain}:${it.address}`} className="av-m-row">
            <div className="av-m-id">
              <span className="av-chip mono">{CHAIN_SHORT[it.chain]}</span>
              <Link className={`av-m-name ${it.name ? '' : 'addr'}`} to={`/lens/${it.chain}/${it.address}`}>
                {it.name ?? shortAddress(it.address, 6, 6)}
              </Link>
              <span className="av-m-addr mono">{it.address}</span>
              {it.solc && <span className="av-m-solc mono">solc {it.solc}</span>}
            </div>
            {it.files.length > 0 && (
              <div className="av-m-ev">
                {it.files.map((f) => (
                  <EvidenceLine key={f.path} e={f} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      {list.next && (
        <button className="btn ghost av-more" onClick={more}>
          MORE
        </button>
      )}
    </div>
  )
}

type Query = { chain: ChainId; address: string }

/** Check one kept contract by address: the form (in the hero). */
function Lookup({ onCheck }: { onCheck: (q: Query) => void }) {
  const [chain, setChain] = useState<ChainId>('ethereum')
  const [text, setText] = useState('')
  const valid = /^0x[0-9a-fA-F]{40}$/.test(text.trim())
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (valid) onCheck({ chain, address: text.trim() })
  }
  return (
    <div className="av-look">
      <form className="av-look-f" onSubmit={submit}>
        <select className="mono" value={chain} onChange={(e) => setChain(e.target.value as ChainId)} aria-label="Chain">
          {EVM.map((c) => (
            <option key={c} value={c}>
              {CHAIN_LABEL[c]}
            </option>
          ))}
        </select>
        <input className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder="0x… a kept contract" spellCheck={false} autoComplete="off" aria-label="Contract address" />
        <button className="btn" type="submit" disabled={!valid}>
          CHECK
        </button>
      </form>
    </div>
  )
}

/** The checked contract, full width under the hero. */
function LookupResult({ q, onClose }: { q: Query; onClose: () => void }) {
  const st = useAdvisoryItem(q.chain, q.address)
  const name = st.k === 'ok' ? st.it.name : null
  return (
    <section className="av-look-r" aria-label="Checked contract">
      <div className="av-sec-h mono">
        <span>
          <span className="hot">■</span> {CHAIN_SHORT[q.chain]} · {name ? `${name} · ` : ''}
          {q.address}
        </span>
        <button className="av-look-x mono" onClick={onClose} aria-label="Close">
          close ×
        </button>
      </div>
      <AdvisoryCard st={st} />
    </section>
  )
}
