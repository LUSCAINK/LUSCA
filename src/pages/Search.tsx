// CODE SEARCH — /search: grep every verified source file and Solana IDL the chain agents kept.
// Each unique file is stored once (content hash); every result says how many kept contracts include that exact
// file. Literal or regex, case toggle, chain / custom-code / path / language filters. Deep links: /search?q=…
//
// Data: GET /api/search?q=&re=&case=&chain=&custom=&path=&lang=&cursor= (SearchResult), GET /api/search/stats.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { ChainId } from '@shared/chain'
import type { SearchFileHit, SearchFileRefs, SearchGroup, SearchIdlHit, SearchItem, SearchLang, SearchLine, SearchResult, SearchStats } from '@shared/search'
import { Kicker } from '@/components/docs/pagekit'
import { CHAINS, CHAIN_LABEL, CHAIN_SHORT, explorerName, explorerUrl, shortAddress } from '@/lib/chain'
import { DASH, fmtBytes, fmtInt } from '@/lib/format'
import './search.css'

/** Position of /search in the primary navigation (set when the nav is integrated in src/components/shell/Shell.tsx). */
const SEARCH_NAV_N = '13'

const EXAMPLES: { label: string; q: string; re?: boolean; custom?: boolean; title: string }[] = [
  { label: 'selfdestruct', q: 'selfdestruct', title: 'Every line that names selfdestruct' },
  { label: 'delegatecall(', q: 'delegatecall(', title: 'Calls that run another contract’s code in this contract’s storage' },
  { label: 'tx.origin', q: 'tx.origin', title: 'Code that reads the transaction’s original sender' },
  { label: 'onlyOwner … _mint(', q: 'onlyOwner[^{;]*\\{[^}]*_mint\\(', re: true, title: 'onlyOwner functions whose body calls _mint (regex)' },
  { label: 'ecrecover(', q: 'ecrecover(', custom: true, title: 'Signature recovery in custom code only' },
  { label: 'IDL · withdraw', q: '^instruction withdraw', re: true, title: 'Solana IDL instructions that start with withdraw' },
]

const LANGS: { k: SearchLang; label: string }[] = [
  { k: 'solidity', label: 'Solidity' },
  { k: 'vyper', label: 'Vyper' },
  { k: 'yul', label: 'Yul' },
  { k: 'other', label: 'Other' },
]

const pctOf = (n: number, d: number) => {
  if (!d) return DASH
  const v = (n / d) * 100
  return `${v >= 10 || v === 0 ? Math.round(v) : v < 0.1 ? '<0.1' : v.toFixed(1)}%`
}

function chainsText(c: Partial<Record<ChainId, number>>): string {
  const ks = CHAINS.filter((k) => (c[k] ?? 0) > 0)
  return `${ks.length} chain${ks.length === 1 ? '' : 's'}`
}

/** A number that counts up to its value when it changes (instant with reduced motion). */
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value)
  const from = useRef(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || value < 10) {
      setShown(value)
      return
    }
    const start = performance.now()
    const a = from.current
    let raf = 0
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / 700)
      const e = 1 - Math.pow(2, -10 * k)
      setShown(Math.round(a + (value - a) * (k >= 1 ? 1 : e)))
      if (k < 1) raf = requestAnimationFrame(tick)
      else from.current = value
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{fmtInt(shown)}</>
}

function Hl({ text, hits }: { text: string; hits: [number, number][] }) {
  if (!hits.length) return <>{text || ' '}</>
  const out: ReactNode[] = []
  let at = 0
  const sorted = [...hits].sort((a, b) => a[0] - b[0])
  sorted.forEach(([a, b], i) => {
    if (a < at) a = at
    if (b <= a) return
    if (a > at) out.push(text.slice(at, a))
    out.push(<mark key={i}>{text.slice(a, b)}</mark>)
    at = b
  })
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}

function Snippet({ blocks }: { blocks: SearchLine[][] }) {
  return (
    <div className="sx-code mono">
      {blocks.map((b, i) => (
        <div key={i} className="sx-block">
          {b.map((l) => (
            <div key={l.n} className={`sx-line ${l.hits.length ? 'hit' : ''}`}>
              <span className="sx-ln">{l.n}</span>
              <code>
                <Hl text={l.text} hits={l.hits} />
              </code>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function SharedBadge({ f }: { f: SearchFileHit }) {
  const n = f.shared.contracts
  if (n <= 1) return <span className="sx-badge one mono">only in this contract</span>
  return (
    <span className="sx-badge mono" title={`This exact file (same content hash) is part of ${n} kept contracts`}>
      <b className="num">{fmtInt(n)}</b> contracts · {chainsText(f.shared.chains)}
    </span>
  )
}

function FileHit({ f, open, toggle }: { f: SearchFileHit; open: boolean; toggle: () => void }) {
  const firstHit = f.blocks[0]?.find((l) => l.hits.length)?.n
  return (
    <div className={`sx-file ${f.shared.contracts > 1 ? 'shared' : ''}`}>
      <div className="sx-file-h">
        <span className="sx-path mono" title={f.path}>
          {f.path}
          {firstHit ? <i>:{firstHit}</i> : null}
        </span>
        <span className="sx-file-meta mono">
          {f.library ? (
            <span className="sx-lib" title="Library path (@openzeppelin, lib/, node_modules/ …): Custom only leaves it out">
              library
            </span>
          ) : f.codeIndex ? (
            <span className="sx-lib" title="The same file (sha256) is in the protocol code index of GitHub repositories: Custom only leaves it out">
              in code index
            </span>
          ) : null}
          <span className="dim">
            {fmtInt(f.matches)} line{f.matches === 1 ? '' : 's'} · {fmtInt(f.lines)} in file
          </span>
        </span>
        <SharedBadge f={f} />
      </div>
      <Snippet blocks={f.blocks} />
      {(f.moreMatches > 0 || f.alsoIn.length > 0) && (
        <div className="sx-file-f mono">
          {f.moreMatches > 0 ? <span className="dim">+{fmtInt(f.moreMatches)} more matching line{f.moreMatches === 1 ? '' : 's'} in this file</span> : <span />}
          {f.alsoIn.length > 0 && (
            <button className={`sx-also-t ${open ? 'on' : ''}`} onClick={toggle} aria-expanded={open}>
              {open ? 'hide' : 'show'} the other {fmtInt(f.shared.contracts - 1)} contract{f.shared.contracts - 1 === 1 ? '' : 's'} with this file
            </button>
          )}
        </div>
      )}
      {open && f.alsoIn.length > 0 && <RefsList id={f.id} preview={f.alsoIn} others={f.shared.contracts - 1} />}
    </div>
  )
}

/** Every kept contract with this exact file: a few come with the result (`preview`), the rest from /api/search/file. */
function RefsList({ id, preview, others }: { id: number; preview: (SearchItem & { path: string })[]; others: number }) {
  const [refs, setRefs] = useState<SearchFileRefs | 'loading' | 'error' | null>(null)
  const partial = others > preview.length
  useEffect(() => {
    if (!partial) return
    const ac = new AbortController()
    setRefs('loading')
    fetch(`/api/search/file?id=${id}`, { signal: ac.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ file: SearchFileRefs }>) : Promise.reject(new Error(String(r.status)))))
      .then((j) => setRefs(j.file))
      .catch(() => !ac.signal.aborted && setRefs('error'))
    return () => ac.abort()
  }, [id, partial])
  const full = refs && typeof refs === 'object' ? refs : null
  const list = full ? full.list : preview
  return (
    <div className="sx-also-w">
      {full && (
        <div className="sx-also-h mono">
          <b className="num">{fmtInt(full.contracts)}</b> kept contracts include this exact file ·{' '}
          {CHAINS.filter((c) => (full.chains[c] ?? 0) > 0)
            .map((c) => `${CHAIN_SHORT[c]} ${fmtInt(full.chains[c] ?? 0)}`)
            .join(' · ')}
        </div>
      )}
      <ul className={`sx-also mono ${full ? 'full' : ''}`}>
        {list.map((a) => (
          <li key={`${a.chain}:${a.address}`}>
            <span className="sx-chip">{CHAIN_SHORT[a.chain]}</span>
            <Link to={`/lens/${a.chain}/${a.address}`} title={a.address}>
              {a.name ?? shortAddress(a.address, 6, 6)}
              {a.name ? <i>{shortAddress(a.address, 4, 4)}</i> : null}
            </Link>
            <span className="dim" title={a.path}>
              {a.path}
            </span>
          </li>
        ))}
        {!full && partial && (
          <li className="dim">{refs === 'error' ? `and ${fmtInt(others - preview.length)} more (could not load them)` : `loading ${preview.length ? 'the other ' : ''}${fmtInt(others - preview.length)}…`}</li>
        )}
        {full && full.more > 0 && <li className="dim">and {fmtInt(full.more)} more</li>}
      </ul>
    </div>
  )
}

function Group({ g, openSet, toggle }: { g: SearchGroup; openSet: Set<number>; toggle: (id: number) => void }) {
  const ext = explorerUrl(g.item.chain, g.item.address)
  return (
    <li className="sx-group">
      <div className="sx-group-h">
        <span className="sx-chip mono">{CHAIN_SHORT[g.item.chain]}</span>
        <Link className={`sx-name ${g.item.name ? '' : 'addr'}`} to={`/lens/${g.item.chain}/${g.item.address}`} title="Open in Lens">
          {g.item.name ?? shortAddress(g.item.address, 6, 6)}
        </Link>
        <span className="sx-addr mono">{g.item.address}</span>
        {ext && (
          <a className="sx-ext mono" href={ext} target="_blank" rel="noreferrer noopener">
            {explorerName(g.item.chain)} ↗
          </a>
        )}
      </div>
      <div className="sx-files">
        {g.files.map((f) => (
          <FileHit key={f.id} f={f} open={openSet.has(f.id)} toggle={() => toggle(f.id)} />
        ))}
      </div>
    </li>
  )
}

function IdlCard({ h }: { h: SearchIdlHit }) {
  return (
    <li className="sx-idl">
      <div className="sx-idl-h">
        <span className="sx-chip mono">SOL</span>
        <Link className={`sx-name ${h.item.name ? '' : 'addr'}`} to={`/lens/solana/${h.item.address}`}>
          {h.item.name ?? shortAddress(h.item.address, 6, 6)}
        </Link>
        {h.sharedPrograms > 1 && <span className="sx-badge mono">same IDL · {fmtInt(h.sharedPrograms)} programs</span>}
      </div>
      <span className="sx-addr mono">{h.item.address}</span>
      <ul className="sx-idl-e mono">
        {h.entries.map((e, i) => (
          <li key={i}>
            <span className={`sx-kind k-${e.kind}`}>{e.kind}</span>
            <code>
              <Hl text={e.text} hits={e.hits} />
            </code>
          </li>
        ))}
        {h.moreEntries > 0 && <li className="dim">+{fmtInt(h.moreEntries)} more entries</li>}
      </ul>
    </li>
  )
}

interface Form {
  q: string
  re: boolean
  cs: boolean
  chain: ChainId | ''
  custom: boolean
  path: string
  lang: SearchLang | ''
}

const formOf = (sp: URLSearchParams): Form => ({
  q: sp.get('q') ?? '',
  re: sp.get('re') === '1',
  cs: sp.get('case') === '1',
  chain: (CHAINS as readonly string[]).includes(sp.get('chain') ?? '') ? (sp.get('chain') as ChainId) : '',
  custom: sp.get('custom') === '1',
  path: sp.get('path') ?? '',
  lang: (['solidity', 'vyper', 'yul', 'other'] as string[]).includes(sp.get('lang') ?? '') ? (sp.get('lang') as SearchLang) : '',
})

function paramsOf(f: Form): URLSearchParams {
  const p = new URLSearchParams()
  p.set('q', f.q)
  if (f.re) p.set('re', '1')
  if (f.cs) p.set('case', '1')
  if (f.chain) p.set('chain', f.chain)
  if (f.custom) p.set('custom', '1')
  if (f.path.trim()) p.set('path', f.path.trim())
  if (f.lang) p.set('lang', f.lang)
  return p
}

async function getResult(url: string, signal?: AbortSignal): Promise<SearchResult> {
  const r = await fetch(url, { signal })
  let j: unknown = null
  try {
    j = await r.json()
  } catch {
    /* not JSON */
  }
  if (j && typeof j === 'object' && 'total' in (j as object)) return j as SearchResult
  if (r.status === 429) throw new Error('too many requests — wait a few seconds')
  throw new Error(r.status === 503 ? 'code search is not available right now' : `server answered ${r.status}`)
}

export default function Search() {
  const [sp, setSp] = useSearchParams()
  const [form, setForm] = useState<Form>(() => formOf(sp))
  const [stats, setStats] = useState<SearchStats | null>(null)
  const [statsErr, setStatsErr] = useState(false)
  const [res, setRes] = useState<SearchResult | null>(null)
  const [groups, setGroups] = useState<SearchGroup[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [load, setLoad] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [moreBusy, setMoreBusy] = useState(false)
  const [topOpen, setTopOpen] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const active = useMemo(() => formOf(sp), [sp])
  const activeKey = paramsOf(active).toString()

  useEffect(() => {
    document.title = active.q ? `${active.q} — Code search — LUSCA` : 'Code search — LUSCA'
  }, [active.q])

  // "/" focuses the search box (as on code hosts)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    let alive = true
    const pull = () =>
      fetch('/api/search/stats')
        .then((r) => (r.ok ? (r.json() as Promise<SearchStats>) : Promise.reject(new Error(String(r.status)))))
        .then((s) => {
          if (!alive) return
          setStats(s)
          setStatsErr(false)
        })
        .catch(() => alive && setStatsErr(true))
    void pull()
    const t = window.setInterval(pull, 20_000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])

  // keep the form in step with the URL (back / forward, example chips)
  useEffect(() => {
    setForm(formOf(sp))
  }, [sp])

  useEffect(() => {
    if (active.q.trim().length < 2) {
      setRes(null)
      setGroups([])
      setNext(null)
      setLoad('idle')
      return
    }
    const ac = new AbortController()
    setLoad('loading')
    setOpen(new Set())
    getResult(`/api/search?${activeKey}`, ac.signal)
      .then((r) => {
        setRes(r)
        setGroups(r.groups)
        setNext(r.next)
        setLoad('ok')
        setErr('')
      })
      .catch((e: Error) => {
        if (ac.signal.aborted) return
        setErr(e.message)
        setLoad('error')
      })
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeKey covers every field of active
  }, [activeKey])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (form.q.trim().length < 2) {
      inputRef.current?.focus()
      return
    }
    setSp(paramsOf(form))
  }
  const runWith = (patch: Partial<Form>) => {
    const f = { ...form, ...patch }
    setForm(f)
    if (f.q.trim().length >= 2) setSp(paramsOf(f))
  }

  const more = () => {
    if (!next || moreBusy) return
    setMoreBusy(true)
    getResult(`/api/search?${activeKey}&cursor=${encodeURIComponent(next)}`)
      .then((r) => {
        setGroups((cur) => [...cur, ...r.groups])
        setNext(r.next)
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setMoreBusy(false))
  }

  const toggle = (id: number) =>
    setOpen((cur) => {
      const n = new Set(cur)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const s = stats
  const dedupX = s && s.bytes ? s.rawBytes / s.bytes : 0
  const head: [string, string, string, boolean][] = [
    ['unique source files', s ? fmtInt(s.uniqueFiles) : DASH, s ? `${fmtInt(s.fileRefs)} file references before deduplication` : '', true],
    ['kept contracts indexed', s ? fmtInt(s.contracts) : DASH, s ? `${CHAINS.filter((c) => c !== 'solana').map((c) => `${CHAIN_SHORT[c]} ${fmtInt(s.byChain[c] ?? 0)}`).join(' · ')} · ${fmtInt(s.programs)} Solana IDLs` : '', false],
    ['lines of verified code', s ? fmtInt(s.lines) : DASH, s ? `${fmtBytes(s.bytes)} searched per query at most` : '', false],
    ['deduplication', s && dedupX ? `${dedupX.toFixed(1)}×` : DASH, s ? `${fmtBytes(s.rawBytes)} of source files → ${fmtBytes(s.bytes)} stored once` : '', false],
  ]

  const t = res?.total
  const nChains = t ? CHAINS.filter((c) => (t.chains[c] ?? 0) > 0).length : 0
  const live = statsErr
    ? 'server unreachable'
    : !s
      ? 'loading'
      : s.state === 'off'
        ? 'off on this server'
        : s.state === 'ready' || s.ready
          ? `index ready · ${fmtBytes(s.diskBytes)} on disk`
          : `building · ${fmtInt(s.contracts)} contracts so far`

  return (
    <div className="sx">
      <header className="sx-hero">
        <div className="sx-hero-l">
          <Kicker n={SEARCH_NAV_N} name="Search" className="sx-kick">
            <span className="sx-live mono">
              <span className={s && !statsErr && s.state === 'ready' ? 'led on' : s && !statsErr ? 'led on pulse' : 'led'} aria-hidden="true" />
              {live}
            </span>
          </Kicker>
          <h1 className="sx-title display">
            Code
            <br />
            search
          </h1>
          <p className="sx-lede">
            Grep every verified contract the agents kept, and every Solana IDL. Each source file is stored once by its content hash, so every match also says how many
            kept contracts carry that exact file.
          </p>
        </div>
        <dl className="sx-head">
          {head.map(([k, v, sub, hot]) => (
            <div key={k} className={hot ? 'hot' : ''}>
              <dt className="mono">{k}</dt>
              <dd className="num">{v}</dd>
              <dd className="sx-head-s mono">{sub}</dd>
            </div>
          ))}
          <span className="sx-tick tl" aria-hidden="true" />
          <span className="sx-tick br" aria-hidden="true" />
        </dl>
      </header>

      <section className="sx-bar" aria-label="Search">
        <form className="sx-form" onSubmit={submit} role="search">
          <label className="sx-input">
            <span className="sx-prompt mono" aria-hidden="true">
              {form.re ? '/.*/' : 'grep'}
            </span>
            <input
              ref={inputRef}
              className="mono"
              value={form.q}
              onChange={(e) => setForm({ ...form, q: e.target.value })}
              placeholder={form.re ? 'a regular expression, e.g. function\\s+\\w*[Mm]int' : 'selfdestruct, delegatecall(, tx.origin …'}
              aria-label="Search the kept source code"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              maxLength={200}
              autoFocus
            />
            <button type="button" className={`sx-tog mono ${form.re ? 'on' : ''}`} aria-pressed={form.re} title="Regular expression" onClick={() => runWith({ re: !form.re })}>
              .*
            </button>
            <button type="button" className={`sx-tog mono ${form.cs ? 'on' : ''}`} aria-pressed={form.cs} title="Match case" onClick={() => runWith({ cs: !form.cs })}>
              Aa
            </button>
            <button type="submit" className="sx-go mono">
              Search
            </button>
          </label>
          <div className="sx-filters">
            <div className="sx-seg-g" role="group" aria-label="Chain">
              <button type="button" className={!form.chain ? 'on' : ''} aria-pressed={!form.chain} onClick={() => runWith({ chain: '' })}>
                All chains
              </button>
              {CHAINS.map((c) => (
                <button type="button" key={c} className={form.chain === c ? 'on' : ''} aria-pressed={form.chain === c} onClick={() => runWith({ chain: c })} title={c === 'solana' ? 'Solana: IDLs only' : CHAIN_LABEL[c]}>
                  {CHAIN_LABEL[c]}
                </button>
              ))}
            </div>
            <div className="sx-seg-g" role="group" aria-label="Code">
              <button type="button" className={!form.custom ? 'on' : ''} aria-pressed={!form.custom} onClick={() => runWith({ custom: false })}>
                All code
              </button>
              <button
                type="button"
                className={form.custom ? 'on' : ''}
                aria-pressed={form.custom}
                onClick={() => runWith({ custom: true })}
                title="Leave out library paths (@openzeppelin, forge-std, solmate, lib/, node_modules/ …) and files also in the protocol code index"
              >
                Custom only
              </button>
            </div>
            <div className="sx-seg-g" role="group" aria-label="Language">
              <button type="button" className={!form.lang ? 'on' : ''} aria-pressed={!form.lang} onClick={() => runWith({ lang: '' })}>
                Any language
              </button>
              {LANGS.map((l) => (
                <button type="button" key={l.k} className={form.lang === l.k ? 'on' : ''} aria-pressed={form.lang === l.k} onClick={() => runWith({ lang: l.k })}>
                  {l.label}
                </button>
              ))}
            </div>
            <label className="sx-pathf mono">
              <span>path</span>
              <input
                value={form.path}
                onChange={(e) => setForm({ ...form, path: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="*.vy · contracts/ · **/Vault*.sol"
                spellCheck={false}
                maxLength={120}
                aria-label="Path filter"
              />
            </label>
          </div>
        </form>
        <div className="sx-ex">
          <span className="sx-ex-l mono">try</span>
          {EXAMPLES.map((x) => (
            <Link
              key={x.label}
              className={`sx-ex-c mono ${active.q === x.q && active.re === !!x.re ? 'on' : ''}`}
              to={`/search?${paramsOf({ q: x.q, re: !!x.re, cs: false, chain: '', custom: !!x.custom, path: '', lang: '' })}`}
              title={x.title}
            >
              {x.re ? <i>re</i> : null}
              {x.label}
            </Link>
          ))}
        </div>
      </section>

      {active.q.trim().length >= 2 ? (
        <section className="sx-res" aria-label="Results" aria-busy={load === 'loading'}>
          <div className="sx-sum">
            {load === 'loading' && !res ? (
              <p className="sx-sum-main mono caret">searching</p>
            ) : load === 'error' ? (
              <p className="sx-sum-main err mono">{err || 'Can’t reach the LUSCA server'}</p>
            ) : res?.error ? (
              <p className={`sx-sum-main mono ${res.error.code === 'timeout' || res.error.code === 'refused' || res.error.code === 'invalid' ? 'err' : ''}`}>{res.error.message}</p>
            ) : t ? (
              <>
                <p className="sx-sum-main">
                  {t.files > 0 ? (
                    <>
                      <b className="num">
                        <CountUp value={t.matches} />
                        {t.capped ? '+' : ''}
                      </b>{' '}
                      matching line{t.matches === 1 ? '' : 's'} in{' '}
                      <b className="num">
                        <CountUp value={t.contracts} />
                      </b>{' '}
                      contract{t.contracts === 1 ? '' : 's'} across{' '}
                      <b className="num">{nChains}</b> chain{nChains === 1 ? '' : 's'}
                      {t.programs > 0 ? (
                        <>
                          {' '}
                          · <b className="num">{fmtInt(t.programs)}</b> Solana IDL{t.programs === 1 ? '' : 's'}
                        </>
                      ) : null}
                    </>
                  ) : t.programs > 0 ? (
                    <>
                      <b className="num">
                        <CountUp value={t.programs} />
                      </b>{' '}
                      Solana program{t.programs === 1 ? '' : 's'} with a matching IDL entry
                    </>
                  ) : (
                    <>
                      <b className="num">0</b> matches
                    </>
                  )}
                  <span className="sx-ms num"> · {fmtInt(res!.ms)} ms</span>
                </p>
                <p className="sx-sum-sub mono">
                  {fmtInt(t.files)} unique source file{t.files === 1 ? '' : 's'} matched · the trigram index left {fmtInt(res!.scanned.files)} of {fmtInt(res!.scanned.ofFiles)} files to scan (
                  {pctOf(res!.scanned.bytes, res!.scanned.ofBytes)} of {fmtBytes(res!.scanned.ofBytes)})
                  {CHAINS.filter((c) => (t.chains[c] ?? 0) > 0).length ? ` · ${CHAINS.filter((c) => (t.chains[c] ?? 0) > 0).map((c) => `${CHAIN_SHORT[c]} ${fmtInt(t.chains[c] ?? 0)}`).join(' · ')}` : ''}
                  {res!.cached ? ' · cached' : ''}
                  {t.capped ? ' · counting stopped at its cap: totals are lower bounds' : ''}
                </p>
              </>
            ) : null}
          </div>

          {res && !res.error && res.idl.length > 0 && (
            <div className="sx-idls">
              <div className="sx-sec-h mono">
                <span>
                  <span className="hot">■</span> Solana IDLs · instruction, account, type, event and error names
                </span>
                <span className="dim">{fmtInt(t?.programs ?? 0)} program{t?.programs === 1 ? '' : 's'}</span>
              </div>
              <ol className="sx-idl-list">
                {res.idl.map((h) => (
                  <IdlCard key={`${h.item.address}`} h={h} />
                ))}
              </ol>
            </div>
          )}

          {groups.length > 0 && (
            <div className="sx-code-w">
              <div className="sx-sec-h mono">
                <span>
                  <span className="hot">■</span> verified source · grouped by contract, most shared files first
                </span>
                <span className="dim">{fmtInt(t?.files ?? 0)} files</span>
              </div>
              <ol className="sx-groups">
                {groups.map((g, i) => (
                  <Group key={`${g.item.chain}:${g.item.address}:${i}`} g={g} openSet={open} toggle={toggle} />
                ))}
              </ol>
            </div>
          )}
          {res && !res.error && !groups.length && !res.idl.length && load === 'ok' && (
            <p className="sx-empty mono">no kept code matches this {active.re ? 'pattern' : 'text'}{active.chain || active.custom || active.path || active.lang ? ' with these filters' : ''}</p>
          )}
          {next && (
            <button className="btn sx-more" onClick={more} disabled={moreBusy}>
              {moreBusy ? 'LOADING' : 'MORE FILES'}
            </button>
          )}
        </section>
      ) : (
        <section className="sx-top" aria-label="Most shared files">
          <div className="sx-sec-h mono">
            <span>
              <span className="hot">■</span> one file, many contracts · the files the most kept contracts share
            </span>
            <span className="dim">{s ? `${fmtInt(s.uniqueFiles)} unique of ${fmtInt(s.fileRefs)}` : ''}</span>
          </div>
          {s && s.top.length ? (
            <ol className="sx-top-list">
              {s.top.map((f, i) => (
                <li key={`${f.path}:${i}`} className={topOpen === f.id ? 'open' : ''}>
                  <button className="sx-top-row" onClick={() => setTopOpen(topOpen === f.id ? null : f.id)} aria-expanded={topOpen === f.id} title="Every kept contract that includes this exact file">
                    <span className="sx-top-n num">{fmtInt(f.contracts)}</span>
                    <span className="sx-top-b">
                      <span className="sx-path mono" title={f.path}>
                        {f.path}
                      </span>
                      <span className="sx-top-s mono">
                        {CHAINS.filter((c) => (f.chains[c] ?? 0) > 0)
                          .map((c) => `${CHAIN_SHORT[c]} ${fmtInt(f.chains[c] ?? 0)}`)
                          .join(' · ')}{' '}
                        · {fmtInt(f.lines)} lines{f.library ? ' · library' : f.codeIndex ? ' · in code index' : ''}
                        {f.sample ? ` · e.g. ${f.sample.name ?? shortAddress(f.sample.address, 4, 4)}` : ''}
                      </span>
                    </span>
                    <span className="sx-top-t mono">{topOpen === f.id ? 'hide' : 'show all'}</span>
                    <span className="sx-top-bar" style={{ ['--w' as string]: `${Math.max(4, (f.contracts / (s.top[0]?.contracts || 1)) * 100)}%` }} aria-hidden="true" />
                  </button>
                  {topOpen === f.id && <RefsList id={f.id} preview={[]} others={f.contracts} />}
                </li>
              ))}
            </ol>
          ) : (
            <p className="sx-empty mono">{statsErr ? 'Can’t reach the LUSCA server — retrying…' : s ? (s.state === 'ready' ? 'no file is shared by two kept contracts yet' : 'the index is being built…') : 'Loading…'}</p>
          )}
        </section>
      )}

      <footer className="sx-foot mono">
        <span>
          Searches the source files and IDLs the chain agents already stored: no RPC calls, nothing from the daily budgets. A regex runs in a worker with a{' '}
          1.5 s budget; backreferences and nested quantifiers are refused. 20 searches a minute per address; results are cached.
          {s?.partial ? ` · ${s.partial}` : ''}
          {s ? ` · ${fmtBytes(s.diskBytes)} snapshot on disk · server memory ${fmtBytes(s.rss)}` : ''}
        </span>
      </footer>
    </div>
  )
}
