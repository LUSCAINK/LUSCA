// CONTROL — /control: who can change the code of every program and contract the chain agents kept.
// Solana: from the stored read (loader, upgrade authority; the authority's place on the ed25519 curve tells a
// keypair from a program-derived address). EVM: no proxy = fixed code; proxies are followed through the
// EIP-1967 admin slot (or owner()) to the account that can upgrade them, resolved in the background under a
// small daily budget. Facts only: the class says what the controller is, never what anyone may do with it.
//
// Data: GET /api/control/summary (census, polled every 30 s), GET /api/control/items?chain=&class=&cursor=.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ChainId } from '@shared/chain'
import type { ControlClass, ControlEntry, ControlHop, ControlPage, ControlSummary } from '@shared/control'
import { Kicker } from '@/components/docs/pagekit'
import { CHAINS, CHAIN_LABEL, CHAIN_SHORT, shortAddress } from '@/lib/chain'
import { DASH, fmtInt } from '@/lib/format'
import './control.css'

const CLASSES: { k: ControlClass; label: string; title: string }[] = [
  { k: 'immutable', label: 'Immutable', title: 'The code cannot change: no upgrade authority, a non-upgradeable loader, no proxy, or an EIP-1967 clone' },
  { k: 'key', label: 'Single key', title: 'One key can change the code: a Solana authority on the ed25519 curve (a keypair), or an EVM account without code' },
  { k: 'pda', label: 'Program-derived', title: 'A Solana program-derived address (off the ed25519 curve): only its program can sign, e.g. a multisig or a DAO' },
  { k: 'safe', label: 'Safe', title: 'An EVM Safe: a threshold of its owners must sign' },
  { k: 'timelock', label: 'Timelock', title: 'An EVM TimelockController: changes wait for its minimum delay' },
  { k: 'contract', label: 'Other contract', title: 'Another EVM contract without a Safe or timelock interface' },
  { k: 'unknown', label: 'Unidentified', title: 'Upgradeable, but the controller did not answer the standard slots and calls' },
  { k: 'pending', label: 'Not resolved yet', title: 'EVM proxies waiting for the resolver (it runs under a small daily RPC budget)' },
]
/** Position of /control in the primary navigation (set when the nav is integrated in src/components/shell/Shell.tsx). */
const CONTROL_NAV_N = '11'
const LABEL = Object.fromEntries(CLASSES.map((c) => [c.k, c.label])) as Record<ControlClass, string>

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal })
  if (!r.ok) throw new Error(String(r.status))
  return (await r.json()) as T
}

const pct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0)
const fmtPct = (n: number, d: number) => {
  if (!d) return DASH
  const v = pct(n, d)
  return `${v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)}%`
}

export default function Control() {
  useEffect(() => {
    document.title = 'Control — LUSCA'
  }, [])
  const [sum, setSum] = useState<ControlSummary | null>(null)
  const [sumErr, setSumErr] = useState(false)
  const [chain, setChain] = useState<ChainId | ''>('')
  const [cls, setCls] = useState<ControlClass | ''>('')
  const [ctl, setCtl] = useState<{ chain: ChainId; address: string; label: string } | null>(null)
  const [items, setItems] = useState<ControlEntry[]>([])
  const [total, setTotal] = useState(0)
  const [next, setNext] = useState<string | null>(null)
  const [load, setLoad] = useState<'loading' | 'ok' | 'error'>('loading')

  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    const pull = () =>
      getJson<ControlSummary>('/api/control/summary', ac.signal)
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
    if (chain) p.set('chain', chain)
    if (cls) p.set('class', cls)
    if (ctl) p.set('controller', ctl.address)
    if (cursor) p.set('cursor', cursor)
    return `/api/control/items?${p}`
  }

  useEffect(() => {
    const ac = new AbortController()
    setLoad('loading')
    getJson<ControlPage>(query(), ac.signal)
      .then((pg) => {
        setItems(pg.items)
        setTotal(pg.total)
        setNext(pg.next)
        setLoad('ok')
      })
      .catch(() => !ac.signal.aborted && setLoad('error'))
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- query() reads chain / cls / ctl
  }, [chain, cls, ctl])

  const more = () => {
    if (!next) return
    getJson<ControlPage>(query(next))
      .then((pg) => {
        setItems((cur) => [...cur, ...pg.items])
        setNext(pg.next)
      })
      .catch(() => setLoad('error'))
  }

  const by = sum?.byClass ?? {}
  const n = (k: ControlClass) => by[k] ?? 0
  const resolved = sum?.resolved ?? 0
  const changeable = n('key') + n('pda') + n('safe') + n('timelock') + n('contract') + n('unknown')
  const solTotal = sum ? Object.values(sum.byChain.solana ?? {}).reduce((a, b) => a + (b ?? 0), 0) : 0
  const solKey = sum?.byChain.solana?.key ?? 0
  const solUp = solTotal - (sum?.byChain.solana?.immutable ?? 0)

  const head: [string, string, string][] = [
    ['kept programs & contracts', sum ? fmtInt(sum.total) : DASH, sum ? `resolved ${fmtInt(resolved)} of ${fmtInt(sum.total)}` : ''],
    ['code cannot change', sum ? fmtPct(n('immutable'), resolved) : DASH, sum ? `${fmtInt(n('immutable'))} immutable` : ''],
    ['one key can change it', sum ? fmtInt(n('key')) : DASH, sum ? `${fmtPct(n('key'), resolved)} of resolved` : ''],
    ['Solana upgradeable by one keypair', sum ? fmtPct(solKey, solUp) : DASH, sum ? `${fmtInt(solKey)} of ${fmtInt(solUp)} upgradeable programs` : ''],
  ]

  return (
    <div className="ct">
      <header className="ct-hero">
        <div className="ct-hero-l">
          <Kicker n={CONTROL_NAV_N} name="Control" className="ct-kick">
            <span className="ct-live mono">
              <span className={sum && !sumErr ? 'led on' : 'led'} aria-hidden="true" />
              {sumErr ? 'server unreachable' : sum ? (sum.pending ? `resolving · ${fmtInt(sum.pending)} proxies left` : 'all resolved') : 'loading'}
            </span>
          </Kicker>
          <h1 className="ct-title display">
            Control
            <br />
            map
          </h1>
          <p className="ct-lede">
            Who can change the code of every program and contract the agents kept. Solana: the upgrade authority, and whether it is a keypair (a point on the ed25519
            curve) or a program-derived address. EVM: the proxy admin slot, followed to the account behind it — a key, a Safe, a timelock or another contract.
          </p>
        </div>
        <dl className="ct-head">
          {head.map(([k, v, s], i) => (
            <div key={k} className={i === 2 ? 'hot' : ''}>
              <dt className="mono">{k}</dt>
              <dd className="num">{v}</dd>
              <dd className="ct-head-s mono">{s}</dd>
            </div>
          ))}
          <span className="ct-tick tl" aria-hidden="true" />
          <span className="ct-tick br" aria-hidden="true" />
        </dl>
      </header>

      <section className="ct-census" aria-label="Census by chain">
        <div className="ct-sec-h mono">
          <span>
            <span className="hot">■</span> census · who can change the code, by chain
          </span>
          <span className="dim">{sum ? `${fmtInt(changeable)} changeable · ${fmtInt(n('immutable'))} immutable · ${fmtInt(n('pending'))} not resolved yet` : ''}</span>
        </div>
        <div className="ct-bars">
          {CHAINS.map((c) => {
            const row = sum?.byChain[c] ?? {}
            const tot = Object.values(row).reduce((a, b) => a + (b ?? 0), 0)
            return (
              <div key={c} className={`ct-bar-row ${chain && chain !== c ? 'dim' : ''}`}>
                <button className="ct-bar-l mono" onClick={() => setChain(chain === c ? '' : c)} aria-pressed={chain === c}>
                  <b>{CHAIN_SHORT[c]}</b>
                  <span className="num">{sum ? fmtInt(tot) : DASH}</span>
                </button>
                <div className="ct-bar" role="img" aria-label={`${CHAIN_LABEL[c]}: ${CLASSES.filter((k) => row[k.k]).map((k) => `${row[k.k]} ${k.label}`).join(', ') || 'none'}`}>
                  {tot === 0 ? (
                    <span className="ct-bar-empty mono">{sum ? 'nothing kept on this chain yet' : ''}</span>
                  ) : (
                    CLASSES.filter((k) => (row[k.k] ?? 0) > 0).map((k) => {
                      const v = row[k.k] ?? 0
                      const w = pct(v, tot)
                      return (
                        <button
                          key={k.k}
                          className={`ct-seg c-${k.k} ${cls && cls !== k.k ? 'off' : ''}`}
                          style={{ flexGrow: v }}
                          title={`${CHAIN_LABEL[c]} · ${k.label}: ${fmtInt(v)} (${fmtPct(v, tot)})`}
                          onClick={() => {
                            setChain(c)
                            setCls(k.k)
                          }}
                        >
                          {w >= 7 && (
                            <span className="ct-seg-n mono">
                              {fmtInt(v)}
                              <i>{fmtPct(v, tot)}</i>
                            </span>
                          )}
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <ul className="ct-legend mono">
          {CLASSES.map((k) => (
            <li key={k.k} title={k.title}>
              <button className={cls === k.k ? 'on' : ''} aria-pressed={cls === k.k} onClick={() => setCls(cls === k.k ? '' : k.k)}>
                <span className={`ct-sw c-${k.k}`} aria-hidden="true" />
                {k.label}
                <span className="num">{sum ? fmtInt(n(k.k)) : DASH}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {sum && sum.topControllers.length > 0 && (
        <section className="ct-ctl" aria-label="Addresses that control several kept items">
          <div className="ct-sec-h mono">
            <span>
              <span className="hot">■</span> one controller, several programs · the addresses that can change the most kept code
            </span>
          </div>
          <ol className="ct-ctl-list">
            {sum.topControllers.slice(0, 8).map((c) => (
              <li key={`${c.chain}:${c.address}`}>
                <button
                  className={ctl?.address === c.address ? 'on' : ''}
                  aria-pressed={ctl?.address === c.address}
                  title={`Show the ${c.count} kept programs and contracts ${c.address} can change`}
                  onClick={() => {
                    const off = ctl?.address === c.address
                    setCtl(off ? null : { chain: c.chain, address: c.address, label: c.label })
                    if (!off) {
                      setChain('')
                      setCls('')
                      window.setTimeout(() => document.querySelector('.ct-filters')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
                    }
                  }}
                >
                  <span className="ct-ctl-n num">{fmtInt(c.count)}</span>
                  <span className="ct-ctl-b">
                    <span className={`ct-pill c-${c.cls} mono`}>{c.label}</span>
                    <span className="ct-ctl-a mono">
                      {CHAIN_SHORT[c.chain]} · {shortAddress(c.address, 6, 6)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      <nav className="ct-filters" aria-label="Filters">
        <div className="ct-seg-g" role="group" aria-label="Chain">
          <button className={!chain ? 'on' : ''} aria-pressed={!chain} onClick={() => setChain('')}>
            All chains
          </button>
          {CHAINS.map((c) => (
            <button key={c} className={chain === c ? 'on' : ''} aria-pressed={chain === c} onClick={() => setChain(c)}>
              {CHAIN_LABEL[c]}
            </button>
          ))}
        </div>
        <div className="ct-seg-g" role="group" aria-label="Who can change the code">
          <button className={!cls ? 'on' : ''} aria-pressed={!cls} onClick={() => setCls('')}>
            Any
          </button>
          {CLASSES.map((k) => (
            <button key={k.k} className={cls === k.k ? 'on' : ''} aria-pressed={cls === k.k} title={k.title} onClick={() => setCls(k.k)}>
              {k.label}
            </button>
          ))}
        </div>
        {ctl && (
          <button className="ct-ctl-chip mono" onClick={() => setCtl(null)} title="Clear the controller filter">
            can be changed by {ctl.label} {shortAddress(ctl.address, 4, 4)} <b aria-hidden="true">×</b>
          </button>
        )}
        <span className="ct-count mono">{load === 'ok' ? `${fmtInt(total)} shown` : ''}</span>
      </nav>

      <section className="ct-list-w" aria-label="Programs and contracts with their custody chain">
        {items.length === 0 ? (
          <p className="ct-empty mono">
            {load === 'error' ? 'Can’t reach the LUSCA server — retrying…' : load === 'loading' ? 'Loading…' : chain || cls || ctl ? 'nothing matches these filters yet' : 'no kept programs or contracts yet'}
          </p>
        ) : (
          <ol className="ct-list">
            {items.map((e) => (
              <Row key={`${e.chain}:${e.address}`} e={e} />
            ))}
          </ol>
        )}
        {next && (
          <button className="btn ghost ct-more" onClick={more}>
            MORE
          </button>
        )}
      </section>

      <footer className="ct-foot mono">
        <span>
          Solana classes come from the stored reads (no extra calls). EVM proxies are resolved in the background
          {sum && Object.keys(sum.budget).length
            ? ` · today ${Object.entries(sum.budget)
                .map(([c, b]) => `${CHAIN_SHORT[c as ChainId] ?? c} ${fmtInt(b.used)}/${fmtInt(b.limit)} calls`)
                .join(' · ')}`
            : ''}
          . Describes who holds the upgrade right; says nothing about intent.
        </span>
      </footer>
    </div>
  )
}

function Node({ h, chain, first }: { h: ControlHop; chain: ChainId; first: boolean }) {
  const addr = h.address
  return (
    <>
      {!first && (
        <span className="ct-arrow mono" aria-label={h.via ? `via ${h.via}` : 'then'}>
          <i>{h.via ?? ''}</i>
          <b aria-hidden="true">→</b>
        </span>
      )}
      <span className={`ct-node k-${h.kind}`}>
        <span className="ct-node-l mono">{h.label}</span>
        {addr && !first && (
          <Link className="ct-node-a mono" to={`/lens/${chain}/${addr}`} title={addr}>
            {shortAddress(addr, 4, 4)}
          </Link>
        )}
      </span>
    </>
  )
}

function Row({ e }: { e: ControlEntry }) {
  return (
    <li className={`ct-row c-${e.cls}`}>
      <div className="ct-row-id">
        <span className="ct-row-chip mono">{CHAIN_SHORT[e.chain]}</span>
        <Link className={`ct-row-name ${e.name ? '' : 'addr'}`} to={`/lens/${e.chain}/${e.address}`}>
          {e.name ?? shortAddress(e.address, 6, 6)}
        </Link>
        <span className="ct-row-addr mono">{e.address}</span>
      </div>
      <div className="ct-chain" aria-label="custody chain">
        {e.hops.length ? e.hops.map((h, i) => <Node key={i} h={h} chain={e.chain} first={i === 0} />) : <span className="ct-node k-none"><span className="ct-node-l mono">proxy · controller not resolved yet</span></span>}
      </div>
      <div className="ct-row-r">
        <span className={`ct-pill c-${e.cls} mono`}>{LABEL[e.cls]}</span>
        {e.controls && e.controls > 1 ? <span className="ct-shared mono">same controller for {fmtInt(e.controls)} kept items</span> : null}
        <span className="ct-basis mono">{e.basis}</span>
      </div>
    </li>
  )
}
