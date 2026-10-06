// /chain/:chain/:address — one kept program or contract, from the server's stored data only
// (GET /api/chain/item/:chain/:address). Nothing here queries a chain.
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ChainId, ChainIndexItem, ChainRead } from '@shared/chain'
import { Kicker } from '@/components/docs/pagekit'
import {
  CHAIN_LABEL,
  CHAIN_NAV_N as NAV_N,
  KIND_LABEL,
  VIA_TEXT,
  ago,
  classifyError,
  explorerBlockUrl,
  explorerName,
  explorerUrl,
  fetchChainItem,
  fmtUtc,
  isChainId,
  itemPath,
  plural,
  shortAddress,
  validAddress,
  verifiedLabel,
  type ChainLoadError,
} from '@/lib/chain'
import { useNow } from '@/lib/hooks'
import { DASH, fmtBytes, fmtInt } from '@/lib/format'
import { ChainTag, ViaTag } from './parts'

const GH = 'https://github.com/'
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA_RE = /^[0-9a-f]{7,40}$/i
/** Plain https URLs inside security.txt values (contacts are comma-separated, so commas end a URL). */
const URL_RE = /https:\/\/[^\s<>"'`,]+/g

/** Solana loaders said in words: the labels the reader stores (server/chain/solana/layout.ts LOADER_LABEL) and the program ids. */
const LOADERS: Record<string, string> = {
  'bpf-upgradeable': 'upgradeable BPF loader',
  'bpf-loader-2': 'BPF loader v2 (not upgradeable)',
  'bpf-loader-1': 'BPF loader v1 (deprecated)',
  'loader-v4': 'loader v4',
  native: 'native loader (built-in program)',
  BPFLoaderUpgradeab1e11111111111111111111111: 'upgradeable BPF loader',
  BPFLoader2111111111111111111111111111111111: 'BPF loader v2 (not upgradeable)',
  BPFLoader1111111111111111111111111111111111: 'BPF loader v1 (deprecated)',
  LoaderV411111111111111111111111111111111111: 'loader v4',
  NativeLoader1111111111111111111111111111111: 'native loader (built-in program)',
}

/** IDL format from the reader's note ("IDL from the … (anchor | anchor-legacy | codama)"). */
function idlKind(read: ChainRead): string {
  for (const n of read.notes) {
    const m = /^IDL from the .*\((anchor|anchor-legacy|codama)\)$/.exec(n)
    if (m) return m[1] === 'codama' ? 'Codama IDL' : 'Anchor IDL'
  }
  return 'IDL'
}

/** Title size by name length, and break points at camelCase / snake_case boundaries. */
function titleClass(name: string): string {
  return name.length > 26 ? 'len-l' : name.length > 14 ? 'len-m' : ''
}
function Breakable({ text }: { text: string }) {
  // no regex lookbehind: Safari before 16.4 cannot parse it
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (cur && /[A-Z]/.test(c) && /[a-z0-9]/.test(text[i - 1])) {
      parts.push(cur)
      cur = ''
    }
    cur += c
    if (c === '_') {
      parts.push(cur)
      cur = ''
    }
  }
  if (cur) parts.push(cur)
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <wbr />}
          {p}
        </span>
      ))}
    </>
  )
}

type Load =
  | { s: 'loading' }
  | { s: 'ok'; item: ChainIndexItem; read: ChainRead }
  | { s: 'missing' }
  | { s: 'error'; error: ChainLoadError }

export function ChainDetail({ chainParam, addressParam }: { chainParam: string; addressParam: string }) {
  const chain = chainParam.toLowerCase()
  const address = addressParam.trim()
  const valid = isChainId(chain) && validAddress(chain, address)
  const [load, setLoad] = useState<Load>({ s: 'loading' })
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!valid) return
    const c = new AbortController()
    fetchChainItem(chain as ChainId, address, c.signal).then(
      (r) => {
        if (!c.signal.aborted) setLoad(r ? { s: 'ok', item: r.item, read: r.read } : { s: 'missing' })
      },
      (e) => {
        if (!c.signal.aborted) setLoad({ s: 'error', error: classifyError(e) })
      },
    )
    return () => c.abort()
  }, [chain, address, valid, retry])

  const name = load.s === 'ok' ? load.read.name || load.item.name : null
  useEffect(() => {
    document.title = `${name || (valid ? shortAddress(address) : 'Chain')} — LUSCA`
  }, [name, address, valid])

  if (!isChainId(chain)) {
    return (
      <Shell chain={null} address={address}>
        <Notice title="Unknown chain">
          Chain agents read Solana, Ethereum, Base and Arbitrum. <Link to="/chain">Back to the chain index</Link>.
        </Notice>
      </Shell>
    )
  }
  if (!valid) {
    return (
      <Shell chain={chain} address={address}>
        <Notice title={`Not a ${CHAIN_LABEL[chain]} address`}>
          This link does not hold a valid {CHAIN_LABEL[chain]} address. <Link to="/chain">Back to the chain index</Link>.
        </Notice>
      </Shell>
    )
  }

  if (load.s !== 'ok') {
    const ext = explorerUrl(chain, address)
    return (
      <Shell chain={chain} address={address}>
        {load.s === 'loading' && <p className="ch-empty mono ch-d-loading">loading the stored record…</p>}
        {load.s === 'missing' && (
          <Notice title="Not in the kept index">
            Only reads with verified source or an on-chain IDL, that are not duplicates or templates, are kept. This address has not been kept, or has not
            been read yet.{' '}
            {ext && (
              <a href={ext} target="_blank" rel="noopener noreferrer">
                View it on {explorerName(chain)} ↗
              </a>
            )}{' '}
            · <Link to="/chain">Back to the chain index</Link>
          </Notice>
        )}
        {load.s === 'error' && (
          <Notice title={load.error === 'unavailable' ? 'Not served by this server yet' : 'Can’t reach the LUSCA server'}>
            {load.error === 'unavailable' ? 'This server does not serve the chain index yet.' : 'The request did not get an answer.'}{' '}
            <button
              type="button"
              className="ch-retry"
              onClick={() => {
                setLoad({ s: 'loading' })
                setRetry((n) => n + 1)
              }}
            >
              retry
            </button>
          </Notice>
        )}
      </Shell>
    )
  }

  return <Record item={load.item} read={load.read} />
}

// ─── frame (header shared by every state) ───────────────────────────────────

function Shell({ chain, address, children, head }: { chain: ChainId | null; address: string; children: ReactNode; head?: ReactNode }) {
  return (
    <div className="ch ch-d">
      <header className="ch-d-head grid-bg">
        <div className="ch-d-nav">
          <Link to="/chain" className="ch-back mono">
            ← all chain reads
          </Link>
        </div>
        <Kicker n={NAV_N} name={chain ? `Chain / ${CHAIN_LABEL[chain]}` : 'Chain'} className="ch-idx" />
        {head ?? <h1 className="display ch-d-title ch-d-title-addr">{shortAddress(address, 6, 6)}</h1>}
      </header>
      {children}
    </div>
  )
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ch-notice" role="status">
      <h2 className="ch-notice-h mono">{title}</h2>
      <p className="ch-notice-p">{children}</p>
    </section>
  )
}

// ─── the record ─────────────────────────────────────────────────────────────

function Record({ item, read }: { item: ChainIndexItem; read: ChainRead }) {
  const chain = item.chain
  const address = item.address
  const name = read.name || item.name
  const ext = explorerUrl(chain, address)
  const now = useNow(30_000)
  const sol = chain === 'solana'
  const showSec = sol || !!read.securityTxt

  const head = (
    <>
      <h1 className={`display ch-d-title ${name ? titleClass(name) : 'ch-d-title-addr'}`} title={name ?? address}>
        {name ? <Breakable text={name} /> : shortAddress(address, 6, 6)}
      </h1>
      <div className="ch-d-addr">
        <code className="ch-d-code mono">{address}</code>
        <CopyButton text={address} label="Copy address" />
        {ext && (
          <a className="ch-d-ext mono" href={ext} target="_blank" rel="noopener noreferrer">
            {explorerName(chain)} ↗
          </a>
        )}
      </div>
      <ul className="ch-d-tags" aria-label="Summary">
        <li>
          <span className="ch-kind">{KIND_LABEL[read.kind] ?? read.kind}</span>
        </li>
        <li>
          <ChainTag chain={chain} long />
        </li>
        {read.verified && (
          <li>
            <span className="ch-vtag">{verifiedLabel(read.verified.by, read.verified.match)}</span>
          </li>
        )}
        {read.idl && (
          <li>
            <span className="ch-vtag">on-chain {idlKind(read)}</span>
          </li>
        )}
        <li>
          <span className="ch-found mono">
            found via <ViaTag via={item.via} />
          </span>
        </li>
      </ul>
      <p className="ch-d-honest mono">
        <span className="led on" aria-hidden="true" /> Kept as SEPIA-1 training data.
      </p>
    </>
  )

  return (
    <Shell chain={chain} address={address} head={head}>
      <div className={`ch-d-grid ${showSec ? '' : 'no-sec'}`}>
        <Control read={read} chain={chain} />
        <Source read={read} />
        <Interface read={read} />
        {showSec && <SecurityTxt sec={read.securityTxt} />}
        <Provenance item={item} read={read} now={now} />
      </div>
      <p className="ch-d-foot mono">
        SEPIA-0, the current model, cannot read code. This record is training data for SEPIA-1. Shown from the server&rsquo;s stored read; nothing on this page
        queries a chain.
      </p>
    </Shell>
  )
}

function Panel({ k, title, sub, className, children }: { k: string; title: string; sub?: ReactNode; className?: string; children: ReactNode }) {
  const id = `ch-d-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <section className={`panel ch-d-p ${className ?? ''}`} aria-labelledby={id}>
      <div className="panel-head">
        <span id={id}>
          <span className="hot">{k}</span>&nbsp;&nbsp;<b>{title}</b>
        </span>
        {sub && <span className="ch-d-p-sub">{sub}</span>}
      </div>
      {children}
    </section>
  )
}

function Row({ k, children, title }: { k: string; children: ReactNode; title?: string }) {
  return (
    <div className="ch-kv" title={title}>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function AddrLink({ chain, address, internal }: { chain: ChainId; address: string; internal?: boolean }) {
  const ext = explorerUrl(chain, address)
  if (!ext) return <span className="mono">{address || DASH}</span>
  return (
    <span className="ch-addr-link">
      {internal ? (
        <Link to={itemPath(chain, address)} title={`${address} in the kept index`} className="mono">
          {shortAddress(address, 6, 6)}
        </Link>
      ) : (
        <a href={ext} target="_blank" rel="noopener noreferrer" title={address} className="mono">
          {shortAddress(address, 6, 6)}
        </a>
      )}
      {internal && (
        <a href={ext} target="_blank" rel="noopener noreferrer" className="ch-addr-ext mono" aria-label={`${address} on ${explorerName(chain)}`}>
          {explorerName(chain)} ↗
        </a>
      )}
      <CopyButton text={address} label="Copy address" small />
    </span>
  )
}

const yesNo = (b: boolean | null) => (b === true ? 'yes' : b === false ? 'no' : DASH)

const PROXY_LABEL: Record<string, string> = {
  eip1967: 'EIP-1967 proxy',
  eip1822: 'EIP-1822 (UUPS) proxy',
  beacon: 'EIP-1967 beacon proxy',
  eip1167: 'EIP-1167 minimal proxy',
  other: 'proxy',
}

function Control({ read, chain }: { read: ChainRead; chain: ChainId }) {
  const sol = chain === 'solana'
  return (
    <Panel k="A" title="Control" sub={sol ? 'program account' : 'bytecode'} className="ch-d-ctl">
      <dl className="ch-kvs">
        {sol ? (
          <>
            <Row k="loader">
              {read.loader && LOADERS[read.loader] ? (
                <span title={read.loader}>{LOADERS[read.loader]}</span>
              ) : (
                <span className="mono ch-wrap">{read.loader || DASH}</span>
              )}
            </Row>
            <Row k="upgradeable">{yesNo(read.upgradeable)}</Row>
            <Row k="upgrade authority">
              {read.upgradeAuthority ? (
                <AddrLink chain={chain} address={read.upgradeAuthority} />
              ) : read.upgradeable === false ? (
                <span className="dim">none · the program cannot be changed</span>
              ) : (
                DASH
              )}
            </Row>
            <Row k="last deploy slot">
              {read.lastDeploySlot != null ? (
                <a href={explorerBlockUrl(chain, read.lastDeploySlot) ?? undefined} target="_blank" rel="noopener noreferrer" className="num">
                  {fmtInt(read.lastDeploySlot)}
                </a>
              ) : (
                DASH
              )}
            </Row>
            <Row k="program size">
              <span className="num">{read.programBytes != null ? fmtBytes(read.programBytes) : DASH}</span>
            </Row>
          </>
        ) : (
          <>
            <Row k="proxy">{read.proxy ? PROXY_LABEL[read.proxy.standard] ?? read.proxy.standard : 'not a proxy'}</Row>
            {read.proxy && (
              <Row k="implementation">
                <AddrLink chain={chain} address={read.proxy.implementation} internal />
              </Row>
            )}
            <Row k="bytecode size">
              <span className="num">{read.bytecodeBytes != null ? fmtBytes(read.bytecodeBytes) : DASH}</span>
            </Row>
          </>
        )}
        <Row k="code hash" title={sol ? 'sha256 of the deployed program (ELF)' : 'sha256 of the runtime bytecode, metadata stripped'}>
          {read.codeHash ? (
            <span className="ch-hash">
              <span className="mono" title={read.codeHash}>
                {read.codeHash.length > 20 ? `${read.codeHash.slice(0, 10)}…${read.codeHash.slice(-8)}` : read.codeHash}
              </span>
              <CopyButton text={read.codeHash} label="Copy code hash" small />
            </span>
          ) : (
            DASH
          )}
        </Row>
      </dl>
      {read.proxy && (
        <p className="ch-d-note mono">The implementation is read as its own candidate (found via link). Its page opens only if it was kept.</p>
      )}
    </Panel>
  )
}

function repoUrl(repo: string | null): string | null {
  if (!repo) return null
  const r = repo.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  if (REPO_RE.test(r)) return `${GH}${r}`
  try {
    const u = new URL(r)
    return u.protocol === 'https:' ? u.toString().replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

function repoName(url: string): string {
  return url.replace(/^https:\/\/(www\.)?github\.com\//, '').replace(/^https:\/\//, '')
}

function Source({ read }: { read: ChainRead }) {
  const v = read.verified
  const repo = repoUrl(v?.repo ?? null)
  const sha = v?.commit && SHA_RE.test(v.commit) ? v.commit : null
  const gh = repo?.startsWith(GH) ?? false
  const total = read.sources.reduce((a, f) => a + (f.bytes || 0), 0)
  return (
    <Panel k="B" title="Source" sub={v ? verifiedLabel(v.by, v.match) : 'no verified source'} className="ch-d-src">
      {v ? (
        <dl className="ch-kvs">
          <Row k="verified by">
            <span className="ch-vtag">{verifiedLabel(v.by, v.match)}</span>
          </Row>
          {(v.by === 'osec' || v.repo) && (
          <Row k="repository">
            {repo ? (
              <a href={repo} target="_blank" rel="noopener noreferrer" className="mono ch-wrap">
                {repoName(repo)}
              </a>
            ) : (
              <span className="mono ch-wrap">{v.repo || DASH}</span>
            )}
          </Row>
          )}
          {(v.by === 'osec' || v.commit) && (
          <Row k="commit">
            {sha && repo && gh ? (
              <a href={`${repo}/tree/${sha}`} target="_blank" rel="noopener noreferrer" className="mono" title={sha}>
                {sha.slice(0, 10)}
              </a>
            ) : (
              <span className="mono">{v.commit ? v.commit.slice(0, 12) : DASH}</span>
            )}
          </Row>
          )}
          <Row k="compiler">
            <span className="mono ch-wrap">{v.compiler || DASH}</span>
          </Row>
        </dl>
      ) : (
        <p className="ch-d-note mono">{read.idl ? `No verified source. Kept for its on-chain ${idlKind(read)}.` : 'No verified source.'}</p>
      )}

      {read.sources.length > 0 ? (
        <details className="ch-det" open={read.sources.length <= 40}>
          <summary className="mono">
            source files <span className="num">{fmtInt(read.sources.length)}</span> · <span className="num">{fmtBytes(total)}</span>
          </summary>
          <div className="ch-det-scroll">
            <table className="ch-files">
              <caption className="sr-only">Verified source files and their sizes</caption>
              <thead>
                <tr>
                  <th scope="col">path</th>
                  <th scope="col">lang</th>
                  <th scope="col" className="c-n">
                    size
                  </th>
                </tr>
              </thead>
              <tbody>
                {read.sources.map((f) => (
                  <tr key={f.path}>
                    <td className="c-path mono" title={f.path}>
                      {f.path}
                    </td>
                    <td className="mono">{f.lang || DASH}</td>
                    <td className="c-n num">{fmtBytes(f.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : v?.by === 'osec' ? (
        <p className="ch-d-note mono">
          The source is the repository of the verified build{v.commit ? ' at this commit' : ' (commit not recorded)'}. Source files are not copied here. The
          GitHub code index (<Link to="/sepia#sp-code">Model page</Link>, &ldquo;What SEPIA-1 will read&rdquo;) is a separate, curated list of protocol
          repositories.
        </p>
      ) : v?.by === 'sourcify' && read.notes.some((n) => /^Sourcify record over 8 MB/.test(n)) ? (
        <p className="ch-d-note mono">The verified source files are over 8 MB and are not stored here; the ABI is.</p>
      ) : null}
    </Panel>
  )
}

function Interface({ read }: { read: ChainRead }) {
  const idl = read.idl
  const abi = read.abi
  return (
    <Panel
      k="C"
      title="Interface"
      sub={idl ? `${idlKind(read)}${idl.name ? ` · ${idl.name}` : ''}${idl.version ? ` ${idl.version}` : ''}` : abi ? 'ABI' : 'none stored'}
      className="ch-d-if"
    >
      {idl ? (
        <div className="ch-if">
          <dl className="ch-if-counts">
            <Count k="instructions" n={idl.instructions.length} />
            <Count k="account types" n={idl.accounts.length} />
            <Count k="types" n={idl.types} />
            <Count k="errors" n={idl.errors} />
            <Count k="events" n={idl.events} />
          </dl>
          {idl.instructions.length > 0 && (
            <details className="ch-det" open>
              <summary className="mono">
                instructions <span className="num">{fmtInt(idl.instructions.length)}</span>
              </summary>
              <div className="ch-det-scroll">
                <table className="ch-files ch-ix">
                  <caption className="sr-only">Instructions with their number of arguments and accounts</caption>
                  <thead>
                    <tr>
                      <th scope="col">instruction</th>
                      <th scope="col" className="c-n">
                        args
                      </th>
                      <th scope="col" className="c-n">
                        accounts
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {idl.instructions.map((ix, i) => (
                      <tr key={`${ix.name}-${i}`}>
                        <td className="c-path mono">{ix.name}</td>
                        <td className="c-n num">{fmtInt(ix.args)}</td>
                        <td className="c-n num">{fmtInt(ix.accounts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {idl.accounts.length > 0 && (
            <details className="ch-det" open={idl.accounts.length <= 30}>
              <summary className="mono">
                account types <span className="num">{fmtInt(idl.accounts.length)}</span>
              </summary>
              <ul className="ch-chips">
                {idl.accounts.map((a, i) => (
                  <li key={`${a}-${i}`} className="mono">
                    {a}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : abi ? (
        <div className="ch-if">
          <dl className="ch-if-counts n2">
            <Count k="functions" n={abi.functions.length} />
            <Count k="events" n={abi.events.length} />
          </dl>
          <SigList title="functions" list={abi.functions} />
          <SigList title="events" list={abi.events} />
        </div>
      ) : (
        <p className="ch-d-note mono">No interface stored for this read.</p>
      )}
    </Panel>
  )
}

function Count({ k, n }: { k: string; n: number | null | undefined }) {
  return (
    <div className="ch-if-c">
      <dt className="label">{k}</dt>
      <dd className="num">{fmtInt(n)}</dd>
    </div>
  )
}

function SigList({ title, list }: { title: string; list: string[] }) {
  if (!list.length) return null
  return (
    <details className="ch-det" open={list.length <= 24}>
      <summary className="mono">
        {title} <span className="num">{fmtInt(list.length)}</span>
      </summary>
      <ol className="ch-sigs mono">
        {list.map((s, i) => (
          <li key={`${s}-${i}`}>{s}</li>
        ))}
      </ol>
    </details>
  )
}

/** security.txt values are text written by the program's authors: shown as text, plain https URLs linked. */
function SecValue({ v }: { v: string }) {
  const out: ReactNode[] = []
  let last = 0
  for (const m of v.matchAll(URL_RE)) {
    const url = m[0].replace(/[.;:)\]]+$/, '')
    const at = m.index ?? 0
    if (at > last) out.push(<span key={`t${last}`}>{v.slice(last, at)}</span>)
    out.push(
      <a key={`u${at}`} href={url} target="_blank" rel="noopener noreferrer nofollow">
        {url}
      </a>,
    )
    last = at + url.length
  }
  if (last < v.length) out.push(<span key={`t${last}`}>{v.slice(last)}</span>)
  return <>{out}</>
}

function SecurityTxt({ sec }: { sec: Record<string, string> | null }) {
  const entries = sec ? Object.entries(sec).filter(([, v]) => typeof v === 'string' && v.trim() !== '') : []
  return (
    <Panel k="D" title="Security.txt" sub="from the program's security.txt" className="ch-d-sec">
      {entries.length ? (
        <>
          <dl className="ch-kvs ch-sec">
            {entries.map(([k, v]) => (
              <Row key={k} k={k.replace(/_/g, ' ')}>
                <span className="ch-wrap ch-sec-v">
                  <SecValue v={v} />
                </span>
              </Row>
            ))}
          </dl>
          <p className="ch-d-note mono">Quoted as written by the program&rsquo;s authors, from the program&rsquo;s security.txt. LUSCA has not checked these claims.</p>
        </>
      ) : (
        <p className="ch-d-note mono">No security.txt embedded in this program.</p>
      )}
    </Panel>
  )
}

function Provenance({ item, read, now }: { item: ChainIndexItem; read: ChainRead; now: number }) {
  return (
    <Panel k={item.chain === 'solana' || read.securityTxt ? 'E' : 'D'} title="Provenance" sub="how it got here" className="ch-d-prov">
      <dl className="ch-kvs">
        <Row k="found via">
          <span className="ch-found">
            <ViaTag via={item.via} /> <span className="dim">{VIA_TEXT[item.via] ?? ''}</span>
          </span>
        </Row>
        <Row k="first seen">
          <span className="num">{fmtUtc(item.firstSeen)}</span> <span className="dimmer">· {ago(item.firstSeen, now)}</span>
        </Row>
        <Row k="read at">
          <span className="num">{fmtUtc(read.readAt || item.readAt)}</span> <span className="dimmer">· {ago(read.readAt || item.readAt, now)}</span>
        </Row>
        <Row k="RPC calls">
          <span className="num">{fmtInt(read.rpcCalls)}</span> <span className="dimmer">for this read</span>
        </Row>
        <Row k="stored">
          <span>
            {[read.idl ? 'IDL' : null, read.abi ? 'ABI' : null, item.sourceFiles > 0 ? `${plural(item.sourceFiles, 'source file')} (${fmtBytes(item.sourceBytes)})` : null, read.securityTxt ? 'security.txt' : null]
              .filter(Boolean)
              .join(' · ') || 'metadata only'}
          </span>
        </Row>
      </dl>
      {read.notes.length > 0 && (
        <>
          <div className="ch-sub-h label">Reader notes</div>
          <ul className="ch-notes mono">
            {read.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  )
}

function CopyButton({ text, label, small }: { text: string; label: string; small?: boolean }) {
  const [done, setDone] = useState<'ok' | 'fail' | null>(null)
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(null), 1600)
    return () => window.clearTimeout(t)
  }, [done])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setDone('ok')
    } catch {
      setDone('fail')
    }
  }
  return (
    <button type="button" className={`ch-copy ${small ? 'sm' : ''} ${done === 'ok' ? 'ok' : ''}`} onClick={() => void copy()} aria-label={label} title={label}>
      {done === 'ok' ? 'copied' : done === 'fail' ? 'copy failed' : 'copy'}
      <span className="sr-only" aria-live="polite">
        {done === 'ok' ? 'Copied' : ''}
      </span>
    </button>
  )
}
