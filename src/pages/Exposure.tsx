// EXPOSURE — /exposure (and /exposure/:chain/:address): is this key's public key already on-chain, and what goes
// with it? EVM: an address is a hash of the public key, which stays hidden until the address signs; any sent
// transaction (nonce > 0) publishes a signature it can be recovered from. Solana: the address IS the Ed25519
// public key. Program-derived addresses have no private key at all. Every verdict carries the read it rests on.
//
// Data: GET /api/exposure/:chain/:address (one lookup, cached server-side) · GET /api/exposure/summary (the
// Exposure Map over what LUSCA already tracks) · GET /api/exposure/status (limits). The hash-only signature
// demo runs entirely in the browser (src/lib/wots.ts) and sends nothing.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Kicker, OnThisPage } from '@/components/docs/pagekit'
import { WotsDemo } from '@/components/exposure/WotsDemo'
import { ExposureMap } from '@/components/exposure/ExposureMap'
import MathMap from '@/components/exposure/MathMap'
import { explorerName, explorerUrl, fmtUtc, shortAddress } from '@/lib/chain'
import { DASH, fmtInt } from '@/lib/format'
import { NAV_N } from '@/lib/nav'
import {
  classifyAddress,
  ExposureHttpError,
  fetchExposure,
  fetchExposureStatus,
  fetchExposureSummary,
  fmtAmount,
  isZeroAmount,
} from '@/lib/exposure'
import {
  EXPOSURE_CHAINS,
  EXPOSURE_EVM_CHAINS,
  type ExposureChain,
  type ExposureControl,
  type ExposureKey,
  type ExposureKeyKind,
  type ExposureReport,
  type ExposureSafe,
  type ExposureStatus,
  type ExposureSummary,
} from '@/lib/exposure-types'
import './exposure.css'

const CHAIN_NAME: Record<ExposureChain, string> = { solana: 'Solana', ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum' }
const CHAIN_TAG: Record<ExposureChain, string> = { solana: 'SOL', ethereum: 'ETH', base: 'BASE', arbitrum: 'ARB' }

const KIND_LABEL: Record<ExposureKeyKind, string> = {
  wallet: 'Wallet · keypair',
  account: 'Data account (owned by a program)',
  pda: 'Program-derived address',
  program: 'Program',
  eoa: 'Account without code (EOA)',
  'eoa-7702': 'EOA with an EIP-7702 delegation',
  contract: 'Contract',
  safe: 'Safe multisig',
  unknown: 'Not identified',
}

const CONTROL_LABEL: Record<ExposureControl['kind'], string> = {
  'program-upgrade': 'program upgrade',
  'mint-authority': 'mint authority',
  'freeze-authority': 'freeze authority',
  'metadata-update': 'metadata update',
  'stake-staker': 'stake · staker',
  'stake-withdrawer': 'stake · withdrawer',
  'token-delegate-in': 'token delegate',
  'contract-control': 'contract control',
  'safe-owner-of': 'Safe owner',
}

type Tone = 'exposed' | 'hidden' | 'nokey' | 'unknown'
/** The verdict's colour: public key on-chain (hot), not exposed by any transaction (bone), no private key (hatch), not read. */
function toneOf(k: Pick<ExposureKey, 'exposed' | 'kind' | 'curve'>): Tone {
  if (k.exposed === true) return 'exposed'
  if (k.exposed === false) return 'hidden'
  if (k.kind === 'unknown') return 'unknown'
  return k.curve === null ? 'nokey' : 'unknown'
}

type Read = { state: 'loading' } | { state: 'ok'; report: ExposureReport } | { state: 'error'; status: number; message: string; retryAfter: number | null }

const validFor = (chain: ExposureChain, address: string) => {
  const c = classifyAddress(address)
  return chain === 'solana' ? c.kind === 'solana' : c.kind === 'evm'
}

function A({ href, children, className, title }: { href: string; children: ReactNode; className?: string; title?: string }) {
  return href.startsWith('/') ? (
    <Link to={href} className={className} title={title}>
      {children}
    </Link>
  ) : (
    <a href={href} className={className} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

export default function Exposure() {
  const { chain: rChain, address: rAddr } = useParams()
  const [sp] = useSearchParams()
  const nav = useNavigate()
  useEffect(() => {
    document.title = 'Exposure — LUSCA'
  }, [])

  const routeChain = rChain && (EXPOSURE_CHAINS as readonly string[]).includes(rChain.toLowerCase()) ? (rChain.toLowerCase() as ExposureChain) : null
  const allEvm = sp.get('all') === '1' && routeChain !== null && routeChain !== 'solana'
  const routeBad = rChain !== undefined && (!routeChain || !rAddr || !validFor(routeChain, rAddr))

  // ─── the form ───────────────────────────────────────────────────────────
  const [text, setText] = useState(rAddr ?? '')
  const [evmPick, setEvmPick] = useState<ExposureChain | 'all'>(allEvm ? 'all' : routeChain && routeChain !== 'solana' ? routeChain : 'ethereum')
  const input = useMemo(() => classifyAddress(text), [text])
  const resultRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (rAddr) setText(rAddr)
    if (routeChain && routeChain !== 'solana') setEvmPick(allEvm ? 'all' : routeChain)
  }, [rAddr, routeChain, allEvm])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (input.kind === 'solana') nav(`/exposure/solana/${input.address}`)
    else if (input.kind === 'evm') nav(evmPick === 'all' ? `/exposure/ethereum/${input.address}?all=1` : `/exposure/${evmPick}/${input.address}`)
    else return
    window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }

  // ─── server state: limits, the map ──────────────────────────────────────
  const [status, setStatus] = useState<ExposureStatus | null>(null)
  const [sum, setSum] = useState<ExposureSummary | null>(null)
  const [sumErr, setSumErr] = useState<string | null>(null)

  // ─── lookups ────────────────────────────────────────────────────────────
  const [reads, setReads] = useState<Partial<Record<ExposureChain, Read>>>({})
  const [active, setActive] = useState<ExposureChain | null>(null)
  const [retry, setRetry] = useState(0)
  const target = routeChain && rAddr && !routeBad ? { chain: routeChain, address: rAddr, all: allEvm } : null
  const targetKey = target ? `${target.chain}:${target.address}:${target.all ? 1 : 0}:${retry}` : ''
  useEffect(() => {
    if (!target) {
      setReads({})
      setActive(null)
      return
    }
    const chains: ExposureChain[] = target.all ? [target.chain, ...EXPOSURE_EVM_CHAINS.filter((c) => c !== target.chain)] : [target.chain]
    setReads(Object.fromEntries(chains.map((c) => [c, { state: 'loading' } as Read])))
    setActive(target.chain)
    const ac = new AbortController()
    void (async () => {
      // one chain after another: the server limits lookups per client, and the first answer shows at once
      for (const c of chains) {
        try {
          const report = await fetchExposure(c, target.address, ac.signal)
          if (!ac.signal.aborted) setReads((cur) => ({ ...cur, [c]: { state: 'ok', report } }))
        } catch (e) {
          if (ac.signal.aborted) return
          const he = e instanceof ExposureHttpError ? e : null
          setReads((cur) => ({
            ...cur,
            [c]: { state: 'error', status: he?.status ?? 0, message: he?.message ?? 'Can’t reach the LUSCA server', retryAfter: he?.retryAfter ?? null },
          }))
        }
      }
      fetchExposureStatus()
        .then((s) => !ac.signal.aborted && setStatus(s))
        .catch(() => undefined)
    })()
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey carries chain, address, all and retry
  }, [targetKey])

  // ─── map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    fetchExposureStatus(ac.signal)
      .then((s) => alive && setStatus(s))
      .catch(() => undefined)
    const pull = () =>
      fetchExposureSummary(ac.signal)
        .then((s) => {
          if (!alive) return
          setSum(s)
          setSumErr(null)
        })
        .catch(
          (e: unknown) =>
            alive &&
            !ac.signal.aborted &&
            setSumErr(
              e instanceof ExposureHttpError && e.status !== 0
                ? e.status === 404
                  ? 'This server does not serve the Exposure Map yet'
                  : e.message
                : 'Can’t reach the LUSCA server',
            ),
        )
    void pull()
    const t = window.setInterval(pull, 60_000)
    return () => {
      alive = false
      ac.abort()
      window.clearInterval(t)
    }
  }, [])

  const shown = active ? reads[active] : undefined
  const tabs = Object.keys(reads) as ExposureChain[]

  const hint =
    input.kind === 'solana'
      ? 'Solana · base58, 32 bytes'
      : input.kind === 'evm'
        ? 'EVM · pick the chain to read'
        : input.kind === 'invalid'
          ? input.why
          : 'a Solana address, or an Ethereum / Base / Arbitrum address'

  return (
    <div className="ex">
      <header className="ex-hero">
        <div className="ex-hero-l">
          <Kicker n={NAV_N.exposure} name="Exposure" className="ex-kick">
            <span className="ex-live mono">
              <span className={sum ? 'led on' : 'led'} aria-hidden="true" />
              {sumErr ? 'map unavailable' : sum ? (sum.refreshing ? 'map · refreshing' : 'reads on request') : 'loading'}
            </span>
          </Kicker>
          <h1 className="ex-title display">Exposure</h1>
          <p className="ex-lede">Which keys are already public, and what each one controls.</p>
          <p className="ex-sub">
            Elliptic-curve signatures (ECDSA on secp256k1 for EVM chains, Ed25519 for Solana) could be broken earlier than planned: by a quantum computer
            running Shor’s algorithm, or by new mathematics. Either attack starts from a public key. Keys whose public key is already on-chain would be the
            first in reach. Hash-based signatures do not rely on elliptic curves.
          </p>
          <OnThisPage
            className="ex-otp"
            links={[
              { id: 'ex-how', label: 'How a key gets exposed' },
              { id: 'ex-sig', label: 'Hash-only signatures' },
              { id: 'ex-map', label: 'Exposure Map' },
              { id: 'ex-math', label: 'Signature math' },
            ]}
          />
        </div>

        <form className={`ex-form ${input.kind === 'invalid' ? 'bad' : ''}`} onSubmit={submit} aria-label="Look up an address">
          <label className="label" htmlFor="ex-in">
            address
          </label>
          <div className="ex-inrow">
            <input
              id="ex-in"
              className="mono"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Solana address or 0x…"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-describedby="ex-hint"
            />
            <button className="btn primary" type="submit" disabled={input.kind !== 'solana' && input.kind !== 'evm'}>
              read →
            </button>
          </div>
          <div className="ex-hint" id="ex-hint">
            <span className={`ex-fmt ${input.kind}`}>{input.kind === 'solana' ? 'SOL' : input.kind === 'evm' ? 'EVM' : input.kind === 'invalid' ? '!' : '·'}</span>
            <span className="dim">{hint}</span>
          </div>
          {input.kind === 'evm' && (
            <div className="ex-pick" role="group" aria-label="EVM chain">
              {EXPOSURE_EVM_CHAINS.map((c) => (
                <button key={c} type="button" className={`ex-chip ${evmPick === c ? 'on' : ''}`} aria-pressed={evmPick === c} onClick={() => setEvmPick(c)}>
                  {CHAIN_NAME[c]}
                </button>
              ))}
              <button
                type="button"
                className={`ex-chip ${evmPick === 'all' ? 'on' : ''}`}
                aria-pressed={evmPick === 'all'}
                onClick={() => setEvmPick('all')}
                title="Read the address on Ethereum, Base and Arbitrum, one after another"
              >
                All three
              </button>
            </div>
          )}
          <p className="ex-privacy">
            The address is sent to the LUSCA server, which reads the chain over RPC. LUSCA never asks for a key or a signature and never holds funds.
          </p>
          <div className="ex-status mono">
            <span>
              <span className="dimmer">cached per address</span> {status ? `${fmtInt(Math.round(status.cacheTtlMs / 60_000))} min` : DASH}
            </span>
            <span>
              <span className="dimmer">new lookups per connection</span> {status?.perIp ? `${fmtInt(status.perIp.perMinute)} / min · ${fmtInt(status.perIp.perDay)} / day` : DASH}
            </span>
            <span>
              <span className="dimmer">all connections today</span> {status ? `${fmtInt(status.perDay.used)} / ${fmtInt(status.perDay.limit)}` : DASH}
            </span>
          </div>
        </form>
      </header>

      {(target || routeBad) && (
        <section className="ex-result pk-anchor" ref={resultRef} aria-label="Lookup result" aria-live="polite">
          {routeBad ? (
            <p className="ex-msg bad mono">
              {routeChain ? `Not a valid ${CHAIN_NAME[routeChain]} address.` : `Unknown chain “${rChain}”. Supported: ${EXPOSURE_CHAINS.map((c) => CHAIN_NAME[c]).join(', ')}.`}
            </p>
          ) : (
            <>
              {tabs.length > 1 && (
                <div className="ex-tabs" role="tablist" aria-label="Chains read">
                  {tabs.map((c) => {
                    const r = reads[c]
                    const tone = r?.state === 'ok' ? toneOf(r.report.key) : r?.state === 'error' ? 'unknown' : null
                    return (
                      <button key={c} role="tab" aria-selected={active === c} className={`ex-tab ${active === c ? 'on' : ''}`} onClick={() => setActive(c)}>
                        <b>{CHAIN_NAME[c]}</b>
                        <span className={`ex-tab-v mono ${tone ? `t-${tone}` : ''}`}>
                          {r?.state === 'ok' ? r.report.key.verdict : r?.state === 'error' ? 'not read' : 'reading…'}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
              {!shown || shown.state === 'loading' ? (
                <p className="ex-msg mono caret">reading {active ? CHAIN_NAME[active] : ''} · account, balances, authorities</p>
              ) : shown.state === 'error' ? (
                <div className="ex-msg bad mono">
                  <span>
                    {shown.status === 429
                      ? `Lookup limit reached${shown.retryAfter ? `: try again in ${fmtInt(shown.retryAfter)} s` : ''}. ${shown.message}`
                      : shown.status === 400
                        ? shown.message
                        : shown.status === 404 || shown.status === 501 || shown.status === 503
                          ? `This server does not answer exposure lookups yet (${shown.message}).`
                          : `${shown.message}.`}
                  </span>
                  {shown.status !== 400 && (
                    <button className="btn ghost" onClick={() => setRetry((n) => n + 1)}>
                      RETRY
                    </button>
                  )}
                </div>
              ) : (
                <Report r={shown.report} />
              )}
            </>
          )}
        </section>
      )}

      <Explainer />
      <WotsDemo />
      <ExposureMap sum={sum} err={sumErr} />
      <div className="ex-math pk-anchor" id="ex-math">
        <MathMap />
      </div>

      <footer className="ex-foot mono">
        <span>
          Facts from chain reads, each with the read it rests on. “Exposed” means the public key can be read from the chain; it says nothing about whether
          anyone can use it today, and nothing on this page is financial advice. Moving funds is where people lose them: wrong addresses, approvals left
          behind, rushed transfers. Read first, then decide.
        </span>
      </footer>
    </div>
  )
}

// ─── one report ─────────────────────────────────────────────────────────────

function Report({ r }: { r: ExposureReport }) {
  const k = r.key
  const tone = toneOf(k)
  const exp = explorerUrl(r.chain, r.address)
  const lensable = k.kind === 'program' || k.kind === 'contract' || k.kind === 'safe'
  const facts: [string, ReactNode][] = [
    ['what it is', KIND_LABEL[k.kind]],
    ['signature curve', k.curve === 'ed25519' ? 'Ed25519' : k.curve === 'secp256k1' ? 'secp256k1 ECDSA' : 'none · no private key'],
  ]
  if (k.txCount !== undefined) facts.push(['transactions sent (nonce)', fmtInt(k.txCount)])
  if (k.owner) facts.push(['owner program', <AddrLink key="o" chain={r.chain} a={k.owner} />])
  if (k.delegate) facts.push(['delegates to', <AddrLink key="d" chain={r.chain} a={k.delegate} />])
  facts.push(['read', `${fmtUtc(r.readAt)}${r.cached ? ' · from cache' : ''}${r.calls !== undefined && !r.cached ? ` · ${fmtInt(r.calls)} calls` : ''}`])

  return (
    <div className="ex-rep">
      <div className={`ex-verdict t-${tone}`}>
        <div className="ex-v-top mono">
          <span className="ex-v-chain">{CHAIN_TAG[r.chain]}</span>
          <span className="ex-v-addr">{r.address}</span>
        </div>
        <div className="ex-v-label display-cond">{k.verdict}</div>
        <p className="ex-v-basis">{k.basis}</p>
        <div className="ex-v-links mono">
          {exp && (
            <a href={exp} target="_blank" rel="noopener noreferrer">
              {explorerName(r.chain)} ↗
            </a>
          )}
          {lensable && <Link to={`/lens/${r.chain}/${r.address}`}>read the code in Lens →</Link>}
        </div>
      </div>
      <dl className="ex-facts">
        {facts.map(([dt, dd]) => (
          <div key={dt}>
            <dt className="label">{dt}</dt>
            <dd className="mono">{dd}</dd>
          </div>
        ))}
      </dl>

      {k.authorities && k.authorities.length > 0 && <Authorities r={r} />}

      <div className="ex-cols">
        <Holds r={r} />
        <Controls r={r} exposed={k.exposed === true} />
      </div>

      {r.safe && <SafeOwners safe={r.safe} chain={r.chain} />}

      {(r.partial.length > 0 || r.notes.length > 0) && (
        <div className="ex-aside">
          {r.partial.length > 0 && (
            <div className="ex-partial">
              <div className="ex-sub-h mono">
                <span>not read · {fmtInt(r.partial.length)}</span>
                <span className="dim">left out of everything above, never counted</span>
              </div>
              <ul>
                {r.partial.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {r.notes.length > 0 && (
            <div className="ex-notes">
              <div className="ex-sub-h mono">
                <span>notes</span>
              </div>
              <ul>
                {r.notes.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AddrLink({ chain, a }: { chain: ExposureChain; a: string }) {
  const u = explorerUrl(chain, a)
  return u ? (
    <a href={u} target="_blank" rel="noopener noreferrer" title={a}>
      {shortAddress(a, 6, 6)}
    </a>
  ) : (
    <span title={a}>{shortAddress(a, 6, 6)}</span>
  )
}

function Holds({ r }: { r: ExposureReport }) {
  const h = r.holds
  const lensFor = (mint: string) => `/lens/${r.chain}/${mint}`
  const nothing = (!h.native || isZeroAmount(h.native.amount)) && h.tokens.length === 0
  return (
    <section className="ex-box" aria-label="What the key holds">
      <div className="ex-sub-h mono">
        <span>
          <span className="hot">■</span> holds
        </span>
        <span className="dim">{h.tokenCount ? `${fmtInt(h.tokenCount)} token ${h.tokenCount === 1 ? 'balance' : 'balances'}` : 'no token balances'}</span>
      </div>
      <div className="ex-native">
        <span className="ex-native-n num">{h.native ? fmtAmount(h.native.amount, 9) : DASH}</span>
        <span className="ex-native-s mono">{h.native?.symbol ?? ''}</span>
        {h.usd && (
          <span className="ex-usd mono" title={`prices from ${h.usd.source}, ${fmtUtc(h.usd.at)}`}>
            ≈ ${h.usd.total.toLocaleString('en-US', { maximumFractionDigits: 0 })} · prices: {h.usd.source}
          </span>
        )}
      </div>
      {h.native && (
        <div className="ex-raw mono" title="smallest unit, as read">
          {h.native.raw} {r.chain === 'solana' ? 'lamports' : 'wei'}
        </div>
      )}
      {h.tokens.length > 0 && (
        <table className="ex-table">
          <thead>
            <tr>
              <th scope="col">token</th>
              <th scope="col" className="r">
                amount
              </th>
              {r.chain === 'solana' && <th scope="col">program</th>}
            </tr>
          </thead>
          <tbody>
            {h.tokens.map((t) => (
              <tr key={`${t.mint}:${t.program}`}>
                <td>
                  <Link to={lensFor(t.mint)} className="ex-tok" title={t.mint}>
                    <b>{t.symbol ?? shortAddress(t.mint, 4, 4)}</b>
                    {t.name && <span className="dim">{t.name}</span>}
                  </Link>
                </td>
                <td className="r num">{fmtAmount(t.amount, Math.min(6, t.decimals))}</td>
                {r.chain === 'solana' && <td className="mono dim">{t.program}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {h.truncated && (
        <p className="ex-note mono">
          showing {fmtInt(h.tokens.length)} of {fmtInt(h.tokenCount)} balances
        </p>
      )}
      {nothing && (
        <p className="ex-note mono">
          {r.chain === 'solana'
            ? r.partial.some((p) => /token balances/i.test(p))
              ? `no SOL at this address; token balances not read`
              : `nothing held at this address on Solana`
            : `no ETH at this address on ${CHAIN_NAME[r.chain]}; ERC-20 balances not read`}
        </p>
      )}
      {!h.usd && h.tokens.length > 0 && <p className="ex-note mono">no dollar total: no public price source was read for this lookup</p>}
    </section>
  )
}

function Authorities({ r }: { r: ExposureReport }) {
  const list = r.key.authorities ?? []
  return (
    <section className="ex-box ex-auth" aria-label="Keys stored in this account">
      <div className="ex-sub-h mono">
        <span>
          <span className="hot">■</span> keys stored in this account
        </span>
        <span className="dim">read from the account's own data</span>
      </div>
      <ol className="ex-ctl">
        {list.map((a, i) => (
          <li key={`${a.role}:${a.address ?? 'none'}:${i}`}>
            <div className="ex-ctl-h">
              <span className="ex-pill mono">{a.role}</span>
              {a.address ? (
                <Link to={`/exposure/solana/${a.address}`} className="ex-ctl-t" title={a.address}>
                  {shortAddress(a.address, 6, 6)}
                </Link>
              ) : (
                <span className="ex-ctl-t">None</span>
              )}
            </div>
            <div className="ex-ctl-l">
              {!a.address ? 'not set: nobody holds this power' : a.keyKind === 'pda' ? 'program-derived address: no private key, a program signs' : 'on-curve address: look it up to see what kind of key it is'}
            </div>
            <div className="ex-ctl-e mono">
              <span className="dimmer">via</span> {a.via}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function Controls({ r, exposed }: { r: ExposureReport; exposed: boolean }) {
  const c = r.controls
  return (
    <section className="ex-box" aria-label="What the key controls">
      <div className="ex-sub-h mono">
        <span>
          <span className="hot">■</span> controls
        </span>
        <span className="dim">{c.length ? `${fmtInt(c.length)} found` : 'nothing found'}</span>
      </div>
      {c.length === 0 ? (
        <p className="ex-note mono">
          No program, mint, stake account, delegation or tracked contract names this address as its authority
          {r.partial.length ? ' in what was read (see “not read” below)' : ''}.
        </p>
      ) : (
        <>
          {exposed && <p className="ex-note mono">each of these is signed for with the key above</p>}
          <ol className="ex-ctl">
            {c.map((x, i) => (
              <li key={`${x.kind}:${x.target}:${i}`} className={`k-${x.kind}`}>
                <div className="ex-ctl-h">
                  <span className="ex-pill mono">{CONTROL_LABEL[x.kind] ?? x.kind}</span>
                  {x.href ? (
                    <A href={x.href} className="ex-ctl-t" title={x.target}>
                      {x.name ?? shortAddress(x.target, 6, 6)}
                    </A>
                  ) : (
                    <span className="ex-ctl-t" title={x.target}>
                      {x.name ?? shortAddress(x.target, 6, 6)}
                    </span>
                  )}
                </div>
                <div className="ex-ctl-l">{x.label}</div>
                <div className="ex-ctl-e mono">
                  <span className="dimmer">via</span> {x.via} · {x.evidence}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}

function SafeOwners({ safe, chain }: { safe: ExposureSafe; chain: ExposureChain }) {
  const exposed = safe.owners.filter((o) => o.exposed === true).length
  const contracts = safe.owners.filter((o) => o.contract).length
  const may = safe.owners.filter((o) => o.exposed === null && !o.contract && o.txCount === 0).length
  const unread = safe.owners.filter((o) => o.exposed === null).length - contracts - may
  return (
    <section className="ex-box ex-safe" aria-label="Safe owners">
      <div className="ex-sub-h mono">
        <span>
          <span className="hot">■</span> Safe · {fmtInt(safe.threshold)} of {fmtInt(safe.owners.length)} owners must sign
        </span>
        <span className="dim">
          {fmtInt(exposed)} of {fmtInt(safe.owners.length)} owner keys exposed by sent transactions{may ? ` · ${fmtInt(may)} may be public from this Safe's executions` : ''}{contracts ? ` · ${fmtInt(contracts)} contract owner${contracts > 1 ? 's' : ''}` : ''}{unread ? ` · ${fmtInt(unread)} not read` : ''}{safe.nonce !== undefined ? ` · Safe nonce ${fmtInt(safe.nonce)}` : ''}
          {exposed >= safe.threshold && safe.threshold > 0 ? ' · the exposed keys alone meet the threshold' : ''}
        </span>
      </div>
      <table className="ex-table ex-owners">
        <thead>
          <tr>
            <th scope="col">owner</th>
            <th scope="col">key</th>
            <th scope="col" className="r">
              nonce
            </th>
            <th scope="col">basis</th>
          </tr>
        </thead>
        <tbody>
          {safe.owners.map((o) => {
            const t = o.exposed === true ? 'exposed' : o.exposed === false ? 'hidden' : 'unknown'
            const lab = o.contract ? 'contract owner' : o.exposed === true ? 'exposed' : o.exposed === false ? 'not exposed by a tx' : o.txCount === 0 ? 'may be public' : 'not read'
            return (
              <tr key={o.address}>
                <td className="mono">
                  <Link to={`/exposure/${chain}/${o.address}`} title={o.address}>
                    {shortAddress(o.address, 6, 4)}
                  </Link>
                </td>
                <td>
                  <span className={`ex-dot t-${t} mono`}>{lab}</span>
                </td>
                <td className="r num">{o.txCount !== undefined ? fmtInt(o.txCount) : DASH}</td>
                <td className="ex-owner-b">{o.basis}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

// ─── how a key gets exposed ─────────────────────────────────────────────────

function Flow({ steps }: { steps: { t: string; s?: string; hot?: boolean; hidden?: boolean }[] }) {
  return (
    <div className="ex-flow" aria-hidden="true">
      {steps.map((x, i) => (
        <span key={i} className="ex-flow-i">
          {i > 0 && <b className="ex-flow-a">→</b>}
          <span className={`ex-flow-n ${x.hot ? 'hot' : ''} ${x.hidden ? 'hid' : ''}`}>
            <span className="ex-flow-t">{x.t}</span>
            {x.s && <span className="ex-flow-s">{x.s}</span>}
          </span>
        </span>
      ))}
    </div>
  )
}

const HOW: { tag: string; title: string; flow: { t: string; s?: string; hot?: boolean; hidden?: boolean }[]; body: ReactNode; reads: string }[] = [
  {
    tag: 'EVM · secp256k1',
    title: 'Hidden until the first signature',
    flow: [{ t: 'private key' }, { t: 'public key', s: 'hidden', hidden: true }, { t: 'keccak256', s: 'last 20 bytes' }, { t: 'address', s: 'public' }],
    body: (
      <>
        An address is the last 20 bytes of the keccak256 hash of the public key, so the key itself is not on-chain until the account signs. Every sent
        transaction carries an ECDSA signature from which anyone can recover the public key: nonce above 0 means exposed. Nonce 0 and no code means no
        transaction has revealed it; a signature published elsewhere (a permit, a co-signature inside a Safe execution) still can.
      </>
    ),
    reads: 'eth_getTransactionCount · eth_getCode',
  },
  {
    tag: 'Solana · Ed25519',
    title: 'The address is the public key',
    flow: [{ t: 'private key' }, { t: 'public key = address', s: 'public from the start', hot: true }],
    body: (
      <>
        A Solana address is the Ed25519 public key itself, in base58. Every wallet key is public from the moment the address exists, whether it has signed or
        not. Moving to a fresh address does not hide anything: the new address is a public key too.
      </>
    ),
    reads: 'getAccountInfo · the address’s place on the ed25519 curve',
  },
  {
    tag: 'Solana · PDA',
    title: 'No private key at all',
    flow: [{ t: 'seeds + program id' }, { t: 'sha256', s: 'must land off the curve' }, { t: 'program-derived address', s: 'no key' }],
    body: (
      <>
        A program-derived address is chosen off the Ed25519 curve, so no private key exists for it; only the program that derived it can sign for it. The
        question moves to whoever can upgrade that program: its upgrade authority, which is itself a key, a PDA or nobody.
      </>
    ),
    reads: 'isOnCurve · upgradeable-loader ProgramData',
  },
  {
    tag: 'EVM · EIP-7702',
    title: 'Delegated, still the same key',
    flow: [{ t: 'account key' }, { t: 'signed authorization', s: 'on-chain', hot: true }, { t: 'code 0xef0100 ‖ delegate' }],
    body: (
      <>
        An account that delegates with EIP-7702 runs a contract’s code, but its original key still controls it: it can sign a new delegation or ordinary
        transactions. The authorization that set the delegation is itself a signature on-chain.
      </>
    ),
    reads: 'eth_getCode · prefix 0xef0100',
  },
  {
    tag: 'EVM · Safe',
    title: 'Owners sign in the calldata',
    flow: [{ t: 'owner keys' }, { t: 'threshold signatures' }, { t: 'execTransaction calldata', s: 'on-chain', hot: true }],
    body: (
      <>
        A Safe has no key of its own: a threshold of owners must sign. Confirmations collected off-chain are passed in the execTransaction calldata, so every
        executed transaction publishes the signatures it used. Each owner is a key with its own exposure.
      </>
    ),
    reads: 'getOwners() · getThreshold() · each owner’s nonce',
  },
]

function Explainer() {
  return (
    <section className="ex-how pk-anchor" id="ex-how" aria-labelledby="ex-how-h">
      <div className="ex-sec-head">
        <span className="ex-sec-n mono">01 /</span>
        <h2 className="display" id="ex-how-h">
          How a key gets exposed
        </h2>
        <p className="ex-sec-k mono">what each chain publishes, and what LUSCA reads to tell</p>
      </div>
      <div className="ex-how-grid">
        {HOW.map((h) => (
          <article key={h.tag} className="ex-how-c">
            <span className="ex-how-tag mono">{h.tag}</span>
            <h3>{h.title}</h3>
            <Flow steps={h.flow} />
            <p>{h.body}</p>
            <div className="ex-how-r mono">
              <span className="dimmer">reads</span> {h.reads}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
