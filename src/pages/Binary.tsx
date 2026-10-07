// READ THE BINARY — /binary (and /binary/:address): the interface of Solana programs that never published an
// IDL, recovered from their executables. Every item shows the evidence it was read from: the program's own
// "Instruction: <Name>" log strings, Anchor discriminators found as 8-byte constants in the code or data, and
// error messages of published IDLs found verbatim. Facts with their evidence; nothing is judged.
//
// Data: GET /api/binary/summary (census, polled every 30 s) · GET /api/binary/items?framework=&cursor= ·
//       GET /api/binary/:address (one recovered interface).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { BinaryInterface, BinaryListItem, BinaryPage, BinarySummary, BinFramework, BinInstruction } from '@shared/binary'
import { Kicker } from '@/components/docs/pagekit'
import { shortAddress } from '@/lib/chain'
import { DASH, fmtBytes, fmtInt } from '@/lib/format'
import './binary.css'
import { NAV_N } from '@/lib/nav'

/** Position of /binary in the primary navigation (set when the nav is integrated in src/components/shell/Shell.tsx). */
const BINARY_NAV_N = NAV_N.binary
/** The blind check is shown as the method's accuracy only from this many programs. */
const CHECK_MIN = 20

const FW_LABEL: Record<BinFramework, string> = { anchor: 'Anchor', steel: 'Steel', pinocchio: 'Pinocchio', native: 'Native', unknown: 'Not identified' }
const EVIDENCE: Record<BinInstruction['evidence'], { tag: string; title: string }> = {
  'log+disc': { tag: 'LOG + DISC', title: 'The program logs "Instruction: <Name>" and the Anchor discriminator of that name is a constant in its executable' },
  log: { tag: 'LOG', title: 'The program logs "Instruction: <Name>"; no discriminator constant confirms it (native dispatch, or a dispatcher that compares byte by byte)' },
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal })
  if (!r.ok) throw new Error(String(r.status))
  return (await r.json()) as T
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${Math.round(v * 1000) / 10}%`)
const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`
/** Tooltip text for a dictionary discriminator: the sha256 rule only when the value follows it. */
const discTitle = (ns: 'global' | 'account' | 'event', name: string, d: { disc: string; custom?: true }) =>
  d.custom ? `discriminator ${d.disc}, declared in the published IDL that names it (not sha256 of the name)` : `sha256("${ns}:${name}")[0..8] = ${d.disc}`
const hexOf = (s: string) => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
const pairs = (hex: string) => hex.match(/../g) ?? []
const GLYPHS = '0123456789abcdef'
const scramble = (n: number, seed: number) => Array.from({ length: n }, (_, i) => GLYPHS[(seed * 7 + i * 13 + ((seed * i) % 5)) % 16]).join('')

export default function Binary() {
  const { address: routeAddr } = useParams()
  const nav = useNavigate()
  useEffect(() => {
    document.title = 'Read the binary — LUSCA'
  }, [])
  const [sum, setSum] = useState<BinarySummary | null>(null)
  const [sumErr, setSumErr] = useState(false)
  const [fw, setFw] = useState<BinFramework | ''>('')
  const [items, setItems] = useState<BinaryListItem[]>([])
  const [total, setTotal] = useState(0)
  const [next, setNext] = useState<string | null>(null)
  const [load, setLoad] = useState<'loading' | 'ok' | 'error'>('loading')
  const [sel, setSel] = useState<BinaryInterface | null>(null)
  const [selState, setSelState] = useState<'idle' | 'loading' | 'missing' | 'error'>('idle')
  const revealRef = useRef<HTMLElement>(null)

  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    const pull = () =>
      getJson<BinarySummary>('/api/binary/summary', ac.signal)
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

  const query = (cursor?: string) => {
    const p = new URLSearchParams({ limit: '40' })
    if (fw) p.set('framework', fw)
    if (cursor) p.set('cursor', cursor)
    return `/api/binary/items?${p}`
  }
  useEffect(() => {
    const ac = new AbortController()
    setLoad('loading')
    getJson<BinaryPage>(query(), ac.signal)
      .then((pg) => {
        setItems(pg.items)
        setTotal(pg.total)
        setNext(pg.next)
        setLoad('ok')
      })
      .catch(() => !ac.signal.aborted && setLoad('error'))
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- query() reads fw
  }, [fw])
  const more = () => {
    if (!next) return
    getJson<BinaryPage>(query(next))
      .then((pg) => {
        setItems((cur) => [...cur, ...pg.items])
        setNext(pg.next)
      })
      .catch(() => setLoad('error'))
  }

  // the program in the reveal: the route's, else the featured one
  const target = routeAddr ?? sum?.featured ?? null
  useEffect(() => {
    if (!target) return
    if (sel?.address === target) return
    const ac = new AbortController()
    setSelState('loading')
    getJson<BinaryInterface>(`/api/binary/${encodeURIComponent(target)}`, ac.signal)
      .then((r) => {
        setSel(r)
        setSelState('idle')
      })
      .catch((e: Error) => !ac.signal.aborted && setSelState(e.message === '404' ? 'missing' : 'error'))
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sel is compared, not followed
  }, [target])

  const pick = (a: string) => {
    nav(`/binary/${a}`)
    window.setTimeout(() => revealRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40)
  }

  const head: [string, string, string, boolean][] = [
    ['Solana programs without an IDL', sum ? fmtInt(sum.withoutIdl) : DASH, sum ? `of ${fmtInt(sum.programs)} read by LUSCA (agents, radar, Lens)` : '', false],
    ['executables read', sum ? fmtInt(sum.processed) : DASH, sum ? `${fmtBytes(sum.bytesRead)} of program bytes` : '', false],
    ['instructions recovered', sum ? fmtInt(sum.instructions) : DASH, sum ? `${fmtInt(sum.confirmed)} also confirmed by their discriminator` : '', true],
    ['names recovered', sum ? fmtInt(sum.names) : DASH, sum ? `instructions, account types, events, error messages` : '', false],
  ]
  const fwMax = Math.max(1, ...(sum?.frameworks.map((f) => f.count) ?? [1]))
  const crMax = Math.max(1, ...(sum?.crates.map((c) => c.count) ?? [1]))
  const chk = sum?.check ?? null

  return (
    <div className="bn">
      <header className="bn-hero">
        <div className="bn-hero-l">
          <Kicker n={BINARY_NAV_N} name="Binary" className="bn-kick">
            <span className="bn-live mono">
              <span className={sum && !sumErr ? 'led on' : 'led'} aria-hidden="true" />
              {sumErr
                ? 'server unreachable'
                : sum
                  ? sum.reader.state === 'reading'
                    ? 'reading an executable'
                    : sum.reader.state === 'waiting-budget'
                      ? 'waiting for budget'
                      : sum.dictionary.ready
                        ? `dictionary · ${fmtInt(sum.dictionary.idls)} published IDLs`
                        : 'loading the IDL dictionary'
                  : 'loading'}
            </span>
          </Kicker>
          <h1 className="bn-title display">
            Read the
            <br />
            binary
          </h1>
          <p className="bn-lede">
            {sum && sum.programs > 0 ? `${pct(sum.withoutIdl / sum.programs)} of the Solana programs LUSCA has read publish no IDL. ` : ''}A program without one still
            carries its interface in its executable: the log string each instruction prints, the 8-byte Anchor discriminators the dispatcher compares, the error
            messages, the crates it was built with. LUSCA reads them from the bytes, with the evidence for every name.
          </p>
        </div>
        <dl className="bn-head">
          {head.map(([k, v, s, hot]) => (
            <div key={k} className={hot ? 'hot' : ''}>
              <dt className="mono">{k}</dt>
              <dd className="num">{v}</dd>
              <dd className="bn-head-s mono">{s}</dd>
            </div>
          ))}
          <span className="bn-tick tl" aria-hidden="true" />
          <span className="bn-tick br" aria-hidden="true" />
        </dl>
      </header>

      <section className="bn-reveal-w" ref={revealRef} aria-label="One program, read from its executable">
        <div className="bn-sec-h mono">
          <span>
            <span className="hot">■</span> executable → interface · <span className="bn-sec-name">{sel ? (sel.name ?? shortAddress(sel.address, 6, 6)) : 'one program'}</span>
          </span>
          {sel && (
            <span className="dim">
              <Link to={`/lens/solana/${sel.address}`}>{sel.address}</Link>
            </span>
          )}
        </div>
        {sel ? (
          <Reveal r={sel} />
        ) : (
          <p className="bn-empty mono">
            {selState === 'missing'
              ? 'No recovered interface for this program yet: the reader has not read its executable.'
              : selState === 'error' || sumErr
                ? 'Can’t reach the LUSCA server — retrying…'
                : sum && !sum.featured
                  ? sum.dictionary.ready
                    ? 'No executable read yet: the reader works through programs without an IDL in the background.'
                    : 'Loading the dictionary of published IDLs…'
                  : 'Loading…'}
          </p>
        )}
      </section>

      {sel && <Interface r={sel} />}

      <section className="bn-stats" aria-label="Frameworks and crates">
        <div className="bn-fw">
          <div className="bn-sec-h mono">
            <span>
              <span className="hot">■</span> framework · from strings and crate paths
            </span>
          </div>
          <ul className="bn-bars">
            {(sum?.frameworks ?? []).map((f) => (
              <li key={f.name}>
                <button className={fw === f.name ? 'on' : ''} aria-pressed={fw === f.name} onClick={() => setFw(fw === f.name ? '' : f.name)} title={`Show ${FW_LABEL[f.name]} programs`}>
                  <span className="bn-bar-l mono">{FW_LABEL[f.name]}</span>
                  <span className="bn-bar">
                    <i style={{ width: `${(f.count / fwMax) * 100}%` }} />
                  </span>
                  <span className="bn-bar-n num">{fmtInt(f.count)}</span>
                </button>
              </li>
            ))}
            {sum && !sum.frameworks.length && <li className="bn-empty mono">no executable read yet</li>}
          </ul>
          <dl className="bn-legend mono">
            <dt>
              <span className="bn-ev e-logdisc">LOG + DISC</span>
            </dt>
            <dd>the program logs &quot;Instruction: Name&quot; and sha256(&quot;global:name&quot;)[0..8] is a constant in its code or data</dd>
            <dt>
              <span className="bn-ev e-log">LOG</span>
            </dt>
            <dd>the log string alone (native dispatch, or a dispatcher that compares byte by byte)</dd>
            <dt>
              <span className="bn-ev e-disc">DISC</span>
            </dt>
            <dd>a discriminator that other programs&apos; published IDLs name, found in the bytes: account types, events, instructions</dd>
            <dt>
              <span className="bn-ev e-frag">FRAGMENT</span>
            </dt>
            <dd>a log string that runs into the next literal, with no discriminator to confirm where the name ends: shown apart, never counted</dd>
          </dl>
        </div>
        <div className="bn-cr">
          <div className="bn-sec-h mono">
            <span>
              <span className="hot">■</span> crates · name and version from crate directories in panic-location paths
            </span>
            <span className="dim">paths are dropped; only crate and version are kept</span>
          </div>
          {sum && sum.crates.length ? (
            <ul className="bn-crates">
              {sum.crates.slice(0, 24).map((c) => (
                <li key={`${c.name}@${c.version}${c.toolchain ? ':std' : ''}`} title={c.toolchain ? 'a dependency of Rust std built into the Solana toolchain, not one the program chose' : undefined}>
                  <span className="bn-crate mono">
                    {c.name} <b>{c.version}</b>
                    {c.toolchain ? <i className="bn-tc">toolchain std</i> : null}
                  </span>
                  <span className="bn-bar">
                    <i style={{ width: `${(c.count / crMax) * 100}%` }} />
                  </span>
                  <span className="bn-bar-n num">{fmtInt(c.count)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="bn-empty mono">{sum ? 'no crate directory with a version found in the executables read so far' : ''}</p>
          )}
        </div>
        <div className="bn-chk">
          <div className="bn-sec-h mono">
            <span>
              <span className="hot">■</span> method check · blind, on programs that do publish an IDL
            </span>
          </div>
          {chk && chk.programs >= CHECK_MIN ? (
            <dl className="bn-chk-g">
              <div className="hot">
                <dt className="mono">recall · IDL instructions in the code, recovered</dt>
                <dd className="num">{pct(chk.recall)}</dd>
              </div>
              <div>
                <dt className="mono">precision · names in the IDL or confirmed in the code</dt>
                <dd className="num">{pct(chk.precision)}</dd>
              </div>
              <div>
                <dt className="mono">confirmed in the code, not in its IDL</dt>
                <dd className="num">{fmtInt(chk.newerThanIdl)}</dd>
              </div>
              <div>
                <dt className="mono">in the IDL, not in the code</dt>
                <dd className="num">{fmtInt(chk.notInCode)}</dd>
              </div>
              <p className="bn-chk-s mono">
                {plural(chk.programs, 'program')} that publish an Anchor IDL, read blind: each program&apos;s own IDL (names, discriminators, error names) left out of the
                dictionary. Recall counts the {fmtInt(chk.idlInCode)} IDL instructions whose discriminator is in the executable; the {fmtInt(chk.notInCode)} IDL
                instructions whose discriminator is not in the deployed code are counted apart, never as misses. A name the IDL does not list counts as correct only
                when its discriminator is in the code. Account types are found only through other programs&apos; IDLs ({pct(chk.accountRecall)} of IDL account types).
                {chk.skipped ? ` ${plural(chk.skipped, 'program')} whose executable holds none of its IDL's instruction discriminators are left out.` : ''}
              </p>
            </dl>
          ) : null}
          {sum && sum.idlBehind.length > 0 && (chk?.programs ?? 0) >= CHECK_MIN ? (
            <div className="bn-behind">
              <div className="bn-behind-h mono">deployed code that differs from its published IDL</div>
              <ol>
                {sum.idlBehind.map((p) => (
                  <li key={p.address}>
                    <button
                      onClick={() => pick(p.address)}
                      title={`${p.newer} instructions confirmed in the executable (log string + discriminator) that the published IDL does not list; ${p.missing ?? 0} of the IDL's ${p.idlInstructions} instructions have no discriminator in the executable`}
                    >
                      <span className="bn-behind-n">{p.name ?? shortAddress(p.address, 6, 6)}</span>
                      <span className="bn-behind-d mono">
                        <span>
                          <b className="num">+{fmtInt(p.newer)}</b> in the code, not in the IDL
                        </span>
                        {p.missing ? (
                          <span>
                            <b className="num minus">−{fmtInt(p.missing)}</b> of its {fmtInt(p.idlInstructions)} IDL instructions not in the code
                          </span>
                        ) : (
                          <span>IDL of {fmtInt(p.idlInstructions)}, all in the code</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {!(chk && chk.programs >= CHECK_MIN) && (
            <p className="bn-empty mono">
              {chk ? `measuring · ${fmtInt(chk.programs)} of ${CHECK_MIN} programs checked so far` : 'not measured yet: programs that publish an IDL are read blind in the background'}
            </p>
          )}
        </div>
      </section>

      <nav className="bn-filters" aria-label="Filters">
        <div className="bn-seg-g" role="group" aria-label="Framework">
          <button className={!fw ? 'on' : ''} aria-pressed={!fw} onClick={() => setFw('')}>
            All
          </button>
          {(Object.keys(FW_LABEL) as BinFramework[]).map((k) => (
            <button key={k} className={fw === k ? 'on' : ''} aria-pressed={fw === k} onClick={() => setFw(k)}>
              {FW_LABEL[k]}
            </button>
          ))}
        </div>
        <span className="bn-count mono">{load === 'ok' ? `${fmtInt(total)} programs read` : ''}</span>
      </nav>

      <section className="bn-list-w" aria-label="Programs read from their executables">
        {items.length === 0 ? (
          <p className="bn-empty mono">{load === 'error' ? 'Can’t reach the LUSCA server — retrying…' : load === 'loading' ? 'Loading…' : fw ? 'no program with this framework yet' : 'no executable read yet'}</p>
        ) : (
          <ol className="bn-list">
            {items.map((it) => (
              <li key={it.address} className={sel?.address === it.address ? 'on' : ''}>
                <button className="bn-row" onClick={() => pick(it.address)} title={`Show what was recovered from ${it.address}`}>
                  <span className="bn-row-id">
                    <span className={`bn-row-name ${it.name ? '' : 'addr'}`}>{it.name ?? shortAddress(it.address, 6, 6)}</span>
                    <span className="bn-row-addr mono">{it.address}</span>
                  </span>
                  <span className="bn-row-fw mono">
                    {FW_LABEL[it.framework]}
                    {it.frameworkVersion ? ` ${it.frameworkVersion}` : ''}
                  </span>
                  <span className="bn-row-n mono">
                    <b className="num">{fmtInt(it.instructions)}</b> instr. · <b className="num">{fmtInt(it.confirmed)}</b> confirmed
                  </span>
                  <span className="bn-row-names mono">{it.sample.join(' · ') || DASH}</span>
                  <span className="bn-row-sz mono">
                    {fmtBytes(it.programBytes)}
                    <i>{it.kept ? 'source verified' : 'no verified source'}</i>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
        {next && (
          <button className="btn ghost bn-more" onClick={more}>
            MORE
          </button>
        )}
      </section>

      <footer className="bn-foot mono">
        <span>
          Executables come from the reads the chain agents, the upgrade radar and Lens make anyway; the rest are read in the background under a small daily RPC slice
          {sum ? ` (today ${fmtInt(sum.reader.used)}/${fmtInt(sum.reader.limit)} calls)` : ''}. Results are kept per code hash and read again only when the code
          changes. Discriminator dictionary: {sum ? `${fmtInt(sum.dictionary.instructions)} instructions, ${fmtInt(sum.dictionary.accounts)} account types, ${fmtInt(sum.dictionary.events)} events and ${fmtInt(sum.dictionary.errors)} error messages from ${fmtInt(sum.dictionary.idls)} published IDLs` : DASH}, plus names proven by
          log strings. Recovered names describe the code&apos;s interface; they say nothing about its behaviour.
        </span>
      </footer>
    </div>
  )
}

/** The decoding animation: evidence bytes on the left turn into the interface on the right. */
function Reveal({ r }: { r: BinaryInterface }) {
  const shown = r.instructions.slice(0, 12)
  const total = shown.length + 1
  const [step, setStep] = useState(0)
  const [run, setRun] = useState(0)
  const [seen, setSeen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // the decoding plays when the panel comes into view (and again on replay or for another program)
  useEffect(() => {
    const el = box.current
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') return setSeen(true)
    // mostly in view: nearly all of the panel, or (taller than the screen) most of the screen
    const io = new IntersectionObserver(
      (es) => es.some((e) => e.intersectionRatio >= 0.9 || e.intersectionRect.height >= window.innerHeight * 0.6) && setSeen(true),
      { threshold: [0, 0.25, 0.5, 0.75, 0.9, 1] },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  useEffect(() => {
    setStep(0)
    if (!seen) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      setStep(total + 1)
      return
    }
    let i = 0
    const t = window.setInterval(() => {
      i++
      setStep(i)
      if (i > total) window.clearInterval(t)
    }, 230)
    return () => window.clearInterval(t)
  }, [r.codeHash, r.address, run, total, seen])

  const confirmed = r.instructions.filter((x) => x.evidence === 'log+disc').length
  const lines = useMemo(
    () =>
      shown.map((ix) => {
        const log = ix.logName ? `Instruction: ${ix.logName}` : null
        return { ix, log, logHex: ix.logName ? hexOf(ix.logName) : null, disc: ix.disc ? pairs(ix.disc) : null }
      }),
    [shown],
  )

  return (
    <div className="bn-reveal" ref={box}>
      <div className="bn-pane bn-bytes" aria-label="Evidence in the executable">
        <div className="bn-pane-h mono">
          <span>executable · {fmtBytes(r.programBytes)}</span>
          <span className="dim">sha256 {r.codeHash.slice(0, 12)}…</span>
        </div>
        <ol className="bn-hex">
          {lines.map(({ ix, log, logHex, disc }, i) => (
            <li key={ix.name} className={i < step ? 'lit' : i === step ? 'scan' : ''}>
              {logHex && (
                <span className="bn-hex-l">
                  <span className="bn-sect mono">.rodata</span>
                  <span className="bn-hx mono">{logHex.slice(0, 12).join(' ')}{logHex.length > 12 ? ' …' : ''}</span>
                  <span className="bn-asc mono">{log}</span>
                </span>
              )}
              {disc && (
                <span className="bn-hex-l">
                  <span className="bn-sect mono">{ix.site === 'code' ? '.text lddw' : '.rodata'}</span>
                  <span className="bn-hx mono hot">{disc.join(' ')}</span>
                  <span className="bn-asc mono">sha256(&quot;global:{ix.name}&quot;)[0..8]</span>
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
      <div className="bn-arrow" aria-hidden="true">
        <span />
      </div>
      <div className="bn-pane bn-iface" aria-label="Recovered interface">
        <div className="bn-pane-h mono">
          <span>recovered interface</span>
          <button className="bn-replay mono" onClick={() => setRun((x) => x + 1)} title="Play the decoding again">
            ↻ replay
          </button>
        </div>
        <ol className="bn-ix">
          {shown.map((ix, i) => (
            <li key={ix.name} className={i < step ? 'lit' : ''}>
              <span className="bn-ix-n mono">{i < step ? ix.name : scramble(Math.min(28, ix.name.length), i + step)}</span>
              <span className={`bn-ev e-${ix.evidence.replace('+', '')} mono`} title={EVIDENCE[ix.evidence].title}>
                {EVIDENCE[ix.evidence].tag}
              </span>
            </li>
          ))}
        </ol>
        <div className={`bn-iface-f ${step > shown.length ? 'lit' : ''}`}>
          <span className="mono">
            <b>{FW_LABEL[r.framework.name]}</b>
            {r.framework.version ? ` ${r.framework.version}` : ''}
            {r.programCrate ? ` · crate ${r.programCrate}` : ''}
          </span>
          <span className="mono dim">
            {plural(r.instructions.length + (r.more?.instructions ?? 0), 'instruction')} ({fmtInt(confirmed)} confirmed) · {plural(r.accounts.length, 'account type')} ·{' '}
            {plural(r.events.length, 'event')} · {plural(r.errors.length, 'error message')}
          </span>
        </div>
      </div>
    </div>
  )
}

/** The whole recovered interface, every list with its evidence. */
function Interface({ r }: { r: BinaryInterface }) {
  const sec = r.securityTxt
  const newer = new Set(r.check?.newerNames ?? [])
  return (
    <section className="bn-if" aria-label="Recovered interface, complete">
      <div className="bn-col">
        <h3 className="bn-col-h mono">
          instructions <span className="num">{fmtInt(r.instructions.length)}</span>
        </h3>
        <ul className="bn-tags">
          {r.instructions.map((ix) => (
            <li key={ix.name} title={`${EVIDENCE[ix.evidence].title}${ix.disc ? ` · discriminator ${ix.disc} in ${ix.site === 'code' ? 'the code (lddw)' : 'the data'}` : ''}`}>
              <span className="mono">{ix.name}</span>
              <span className="bn-tagset">
                {newer.has(ix.name) && <span className="bn-ev e-new mono" title="Confirmed in the deployed code; the program's published IDL does not list it">NOT IN IDL</span>}
                <span className={`bn-ev e-${ix.evidence.replace('+', '')} mono`}>{EVIDENCE[ix.evidence].tag}</span>
              </span>
            </li>
          ))}
          {!r.instructions.length && <li className="bn-none mono">{r.fragments?.length ? 'no log string confirmed as a whole name' : 'no "Instruction:" log strings in this executable'}</li>}
          {r.more?.instructions ? <li className="bn-none mono">+{fmtInt(r.more.instructions)} more</li> : null}
        </ul>
        {r.fragments && r.fragments.length > 0 && (
          <>
            <h3
              className="bn-col-h mono"
              title="Log strings that run into the next string literal, with no discriminator in the executable to confirm where the name ends. Raw text, not counted as instructions."
            >
              unconfirmed log fragments <span className="num">{fmtInt(r.fragments.length + (r.more?.fragments ?? 0))}</span>
            </h3>
            <ul className="bn-tags bn-frags">
              {r.fragments.slice(0, 12).map((f) => (
                <li key={f} title={`"Instruction: ${f}…" runs into the next literal; no discriminator of any of its prefixes is in the executable`}>
                  <span className="mono">{f}</span>
                  <span className="bn-ev e-frag mono">FRAGMENT</span>
                </li>
              ))}
              {r.fragments.length + (r.more?.fragments ?? 0) > 12 && <li className="bn-none mono">+{fmtInt(r.fragments.length + (r.more?.fragments ?? 0) - 12)} more</li>}
            </ul>
          </>
        )}
        <h3
          className="bn-col-h mono"
          title="Instruction discriminators found in this executable that other programs' published IDLs name and none of this program's log strings names: this program's own handlers (when it logs no names) or instructions it sends to other programs. The bytes alone do not tell which."
        >
          instruction discriminators other IDLs name <span className="num">{fmtInt((r.calls?.length ?? 0) + (r.more?.calls ?? 0))}</span>
        </h3>
        <ul className="bn-tags">
          {(r.calls ?? []).slice(0, 30).map((c) => (
            <li key={`${c.name}:${c.disc}`} title={`${discTitle('global', c.name, c)}, found in ${c.site === 'code' ? 'the code (lddw)' : 'the data'} · named by ${plural(c.idls, 'published IDL')}${c.programs.length ? `, e.g. ${c.programs.join(', ')}` : ''}`}>
              <span className="mono">{c.name}</span>
              <span className="bn-ev e-disc mono">DISC</span>
            </li>
          ))}
          {!(r.calls ?? []).length && <li className="bn-none mono">no instruction discriminator named by another IDL</li>}
          {(r.calls?.length ?? 0) > 30 && <li className="bn-none mono">+{fmtInt((r.calls?.length ?? 0) - 30 + (r.more?.calls ?? 0))} more</li>}
        </ul>
      </div>
      <div className="bn-col">
        <h3 className="bn-col-h mono">
          account types <span className="num">{fmtInt(r.accounts.length)}</span>
        </h3>
        <ul className="bn-tags">
          {r.accounts.map((a) => (
            <li key={`${a.name}:${a.disc}`} title={`${discTitle('account', a.name, a)}, found in ${a.site === 'code' ? 'the code (lddw)' : 'the data'} · defined by ${plural(a.idls, 'published IDL')}`}>
              <span className="mono">{a.name}</span>
              <span className="bn-ev e-disc mono">DISC</span>
            </li>
          ))}
          {!r.accounts.length && <li className="bn-none mono">no known account discriminator found</li>}
        </ul>
        <h3 className="bn-col-h mono">
          events <span className="num">{fmtInt(r.events.length)}</span>
        </h3>
        <ul className="bn-tags">
          {r.events.map((a) => (
            <li key={`${a.name}:${a.disc}`} title={discTitle('event', a.name, a)}>
              <span className="mono">{a.name}</span>
              <span className="bn-ev e-disc mono">DISC</span>
            </li>
          ))}
          {!r.events.length && <li className="bn-none mono">no known event discriminator found</li>}
        </ul>
      </div>
      <div className="bn-col">
        <h3 className="bn-col-h mono">
          error messages <span className="num">{fmtInt(r.errors.length)}</span>
        </h3>
        <ul className="bn-errs">
          {r.errors.slice(0, 40).map((e) => (
            <li key={e.msg} title={`found verbatim in the executable; the same message is in ${e.idls} published IDL${e.idls > 1 ? 's' : ''}`}>
              <span className="mono">{e.name ?? 'error'}</span>
              <q>{e.msg}</q>
            </li>
          ))}
          {!r.errors.length && <li className="bn-none mono">no error message of a published IDL found</li>}
          {r.errors.length > 40 && <li className="bn-none mono">+{fmtInt(r.errors.length - 40)} more</li>}
        </ul>
      </div>
      <div className="bn-col">
        <h3 className="bn-col-h mono">built with</h3>
        <dl className="bn-kv mono">
          <dt>framework</dt>
          <dd>
            {FW_LABEL[r.framework.name]}
            {r.framework.version ? ` ${r.framework.version}` : ''}
            {r.framework.evidence.length ? <i>{r.framework.evidence.join(' · ')}</i> : null}
          </dd>
          <dt>program crate</dt>
          <dd>{r.programCrate ?? DASH}</dd>
          <dt>crates</dt>
          <dd>{r.crates.length ? r.crates.map((c) => `${c.name} ${c.version}${c.toolchain ? ' (toolchain std)' : ''}`).join(' · ') : DASH}</dd>
          <dt>syscalls</dt>
          <dd>{r.syscalls.length ? r.syscalls.join(' · ') : DASH}</dd>
          <dt>security.txt</dt>
          <dd>{sec ? [sec.name, sec.project_url, sec.source_code].filter(Boolean).join(' · ') || 'present' : 'none'}</dd>
          <dt>strings</dt>
          <dd>
            {fmtInt(r.strings.total)} printable · {fmtInt(r.strings.logs)} instruction logs
          </dd>
          <dt>read</dt>
          <dd>
            {new Date(r.readAt).toISOString().slice(0, 16).replace('T', ' ')} UTC · via {r.via} · dictionary {fmtInt(r.dictionary.idls)} IDLs
          </dd>
        </dl>
        {r.check && (
          <p className="bn-own mono">
            This program publishes an IDL of {plural(r.check.idlInstructions, 'instruction')}. Read blind, {fmtInt(r.check.hit)} of the {fmtInt(r.check.recovered)} recovered
            names are in it
            {r.check.newerThanIdl ? `; ${fmtInt(r.check.newerThanIdl)} more are confirmed in the code and not in the IDL` : ''}
            {r.check.notInCode ? `; ${fmtInt(r.check.notInCode)} of the IDL's instructions have no discriminator in the executable` : ''}.
          </p>
        )}
      </div>
    </section>
  )
}
