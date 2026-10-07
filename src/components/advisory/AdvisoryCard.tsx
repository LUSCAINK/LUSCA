// ADVISORY CHECK, one contract: which of its verified Solidity files are copies of a file from an affected
// OpenZeppelin release (file:line evidence), and the known bugs of its exact solc version (conditions shown, never
// applied). Used on /advisories (address lookup) and in the Lens report. Data: GET /api/advisories/:chain/:address.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ChainId } from '@shared/chain'
import type { AdvisoryEvidence, AdvisoryItem, SolcBug } from '@shared/advisory'
import { ADVISORY_SCOPE, COMPILER_SCOPE, releaseFileUrl } from '@shared/advisory'
import { fmtInt } from '@/lib/format'
import './advisory.css'

export type CardState = { k: 'loading' } | { k: 'ok'; it: AdvisoryItem } | { k: 'missing'; why: string } | { k: 'error' }

export function useAdvisoryItem(chain: ChainId | null, address: string | null): CardState {
  const [st, setSt] = useState<CardState>({ k: 'loading' })
  useEffect(() => {
    if (!chain || !address) return
    const ac = new AbortController()
    setSt({ k: 'loading' })
    fetch(`/api/advisories/${chain}/${address}`, { signal: ac.signal })
      .then(async (r) => {
        if (r.ok) return setSt({ k: 'ok', it: (await r.json()) as AdvisoryItem })
        if (r.status === 404 || r.status === 400) {
          const j = (await r.json().catch(() => null)) as { error?: string } | null
          return setSt({ k: 'missing', why: j?.error ?? 'not checked' })
        }
        setSt({ k: 'error' })
      })
      .catch(() => !ac.signal.aborted && setSt({ k: 'error' }))
    return () => ac.abort()
  }, [chain, address])
  return st
}

export const SEV_LABEL: Record<string, string> = { critical: 'Critical', high: 'High', moderate: 'Moderate', low: 'Low' }

/** Human wording of a Solidity bug condition ({ optimizer: true } → "optimizer on"). */
export function conditionText(k: string, v: unknown): string {
  const on = v === true ? 'on' : v === false ? 'off' : String(v)
  switch (k) {
    case 'optimizer':
      return `optimizer ${on}`
    case 'yulOptimizer':
      return `Yul optimizer ${on}`
    case 'viaIR':
      return `via-IR ${on}`
    case 'ABIEncoderV2':
      return `ABI coder v2 ${on}`
    case 'evmVersion':
      return `EVM version ${String(v)}`
    default:
      return `${k}: ${on}`
  }
}

export function Conditions({ c }: { c: Record<string, unknown> }) {
  const e = Object.entries(c ?? {})
  if (!e.length) return <span className="av-cond none mono">no compiler-setting condition: depends on the code pattern</span>
  return (
    <span className="av-conds">
      {e.map(([k, v]) => (
        <span key={k} className="av-cond mono">
          {conditionText(k, v)}
        </span>
      ))}
    </span>
  )
}

/** "lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol" → { dir, base } */
const split = (p: string) => {
  const i = p.lastIndexOf('/')
  return i < 0 ? { dir: '', base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) }
}

export function EvidenceLine({ e }: { e: AdvisoryEvidence }) {
  const { dir, base } = split(e.path)
  return (
    <span className="av-ev">
      <span className={`av-ev-m mono ${e.method}`} title={e.method === 'hash' ? 'Byte-identical to the release file (line endings aside)' : 'Content differs from every published copy; the file header names an affected release'}>
        {e.method === 'hash' ? '≡' : 'hdr'}
      </span>
      <code className="av-ev-p">
        <span className="av-ev-dir">{dir}</span>
        <b>{base}</b>
        <span className="av-ev-ln">:{e.line}</span>
      </code>
      {e.symbol && <span className="av-ev-s mono">{e.symbol}</span>}
      <span className="av-ev-r mono">
        {e.method === 'hash' ? `identical to ${e.pkg.replace('@openzeppelin/', '')} ${e.releases}` : `header says v${e.header} · ${e.pkg.replace('@openzeppelin/', '')} ${e.pkgPath}`}
        {e.release && (
          <>
            {' · '}
            <a href={releaseFileUrl(e.pkg, e.release, e.pkgPath, e.method === 'hash' ? e.line : undefined)} target="_blank" rel="noreferrer" title={`${e.pkg}@${e.release}/${e.pkgPath} on GitHub`}>
              v{e.release} {e.method === 'hash' ? `line ${e.line}` : 'file'} ↗
            </a>
          </>
        )}
      </span>
    </span>
  )
}

function BugRow({ b }: { b: SolcBug }) {
  return (
    <li className="av-bug">
      <span className={`av-bsev mono s-${b.severity.replace(/[^a-z]/g, '')}`}>{b.severity}</span>
      <span className="av-bug-b">
        {b.link ? (
          <a className="av-bug-n" href={b.link} target="_blank" rel="noreferrer">
            {b.name} ↗
          </a>
        ) : (
          <span className="av-bug-n">{b.name}</span>
        )}
        <span className="av-bug-s">{b.summary.replace(/``/g, '')}</span>
        <Conditions c={b.conditions} />
      </span>
    </li>
  )
}

const BUGS_SHOWN = 4

export function AdvisoryCard({ st, lensLink = true }: { st: CardState; lensLink?: boolean }) {
  const [allBugs, setAllBugs] = useState(false)
  if (st.k === 'loading') return <p className="av-card-note mono">checking…</p>
  if (st.k === 'error') return <p className="av-card-note mono">Can’t reach the LUSCA server.</p>
  if (st.k === 'missing') return <p className="av-card-note mono">{st.why}</p>
  const it = st.it
  return (
    <div className="av-card">
      <div className="av-card-h mono">
        <span>
          {fmtInt(it.files)} Solidity file{it.files === 1 ? '' : 's'} checked · {fmtInt(it.ozFiles)} identical to an OpenZeppelin release file
          {it.ozReleases
            .filter((z) => z.label)
            .map((z) => ` · ${z.pkg.replace('@openzeppelin/', '')} ${z.label}`)
            .join('')}
        </span>
        {lensLink && (
          <Link to={`/lens/${it.chain}/${it.address}`} className="av-card-lens">
            open in Lens →
          </Link>
        )}
      </div>
      {it.advisories.length === 0 ? (
        <p className="av-card-none">{it.files ? 'No file from a release named in an OpenZeppelin Contracts advisory.' : 'Nothing to check.'}</p>
      ) : (
        <ul className="av-card-advs">
          {it.advisories.map((a) => (
            <li key={a.id} className={`av-card-adv sv-${a.severity}`}>
              <div className="av-card-adv-h">
                <span className={`av-sev mono sv-${a.severity}`}>{SEV_LABEL[a.severity]}</span>
                <a className="av-id mono" href={a.url} target="_blank" rel="noreferrer">
                  {a.id} ↗
                </a>
                <span className="av-card-t">{a.title}</span>
                <span className="av-card-r mono">{a.label}</span>
              </div>
              {a.files.map((f) => (
                <EvidenceLine key={f.path} e={f} />
              ))}
            </li>
          ))}
        </ul>
      )}
      {it.advisories.length > 0 && <p className="av-scope mono">{ADVISORY_SCOPE}</p>}
      <div className="av-card-solc">
        <div className="av-card-h mono">
          <span>
            {it.solc ? (
              <>
                compiler <b>solc {it.solc.version}</b>
                {it.solc.released ? ` · released ${it.solc.released}` : ''} · {fmtInt(it.solc.bugs.length)} known bug{it.solc.bugs.length === 1 ? '' : 's'} listed for this version
              </>
            ) : (
              'compiler: not on the Solidity bug list'
            )}
          </span>
        </div>
        {it.solc && it.solc.bugs.length > 0 && (
          <>
            <ul className="av-bugs">
              {(allBugs ? it.solc.bugs : it.solc.bugs.slice(0, BUGS_SHOWN)).map((b) => (
                <BugRow key={b.name} b={b} />
              ))}
            </ul>
            {it.solc.bugs.length > BUGS_SHOWN && (
              <button className="av-bugs-more mono" onClick={() => setAllBugs(!allBugs)}>
                {allBugs ? 'show fewer' : `show all ${it.solc.bugs.length} listed bugs`}
              </button>
            )}
            <p className="av-scope mono">{COMPILER_SCOPE}</p>
          </>
        )}
      </div>
      {it.notes.length > 0 && (
        <ul className="av-card-notes mono">
          {it.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The Lens report's advisory section (EVM): same markup as the report's own sections (lens.css). */
export function LensAdvisories({ chain, address, n }: { chain: ChainId; address: string; n: string }) {
  const st = useAdvisoryItem(chain, address)
  const meta =
    st.k === 'ok' ? (
      <span className={`mono ${st.it.advisories.length ? 'hot' : 'dim'}`}>
        {st.it.advisories.length ? `${st.it.advisories.length} advisor${st.it.advisories.length === 1 ? 'y' : 'ies'}` : 'none'}
        {st.it.solc ? ` · solc ${st.it.solc.version}` : ''}
      </span>
    ) : (
      <span className="mono dim">{st.k === 'loading' ? '…' : '—'}</span>
    )
  return (
    <details className="ln-sec" open={st.k === 'ok'} id="ln-adv">
      <summary>
        <span className="ln-sec-n hot">{n}</span>
        <span className="ln-sec-t">Advisories</span>
        <span className="ln-sec-m">{meta}</span>
        <span className="ln-sec-x" aria-hidden />
      </summary>
      <div className="ln-sec-b">
        <AdvisoryCard st={st} lensLink={false} />
        <p className="dim ln-p">
          Checked against every published OpenZeppelin Contracts advisory and the Solidity compiler bug list. <Link to="/advisories">All kept contracts →</Link>
        </p>
      </div>
    </details>
  )
}
