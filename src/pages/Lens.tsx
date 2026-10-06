// /lens and /lens/:chain/:address — LUSCA Lens. Paste a Solana program id or an Ethereum / Base /
// Arbitrum contract address; the server reads it on-chain with the chain agents' readers and
// returns a deterministic report. Every value on this page comes from that report, with the link it
// was read from. Nothing is computed or guessed in the browser.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { ChainId, Verdict } from '@shared/chain'
import type { LensAnswer, LensContract, LensPrimitive, LensRecent, LensReport } from '@shared/lens'
import { CHAIN_LABEL, CHAIN_SHORT, VERDICT_LABEL, VERDICT_TEXT, ago, fmtUtc, isChainId } from '@/lib/chain'
import {
  EXAMPLES,
  LensHttpError,
  blockUrl,
  classify,
  explorerName,
  explorerUrl,
  fetchDetect,
  fetchLens,
  fetchRecent,
  fileLink,
  fmtBytes,
  fmtN,
  repoFileUrl,
  repoSlug,
  short,
  slotUrl,
  sourcifyUrl,
} from '@/lib/lens'
import './lens.css'

const EVM_CHAINS: ChainId[] = ['ethereum', 'base', 'arbitrum']

type Phase = { s: 'idle' } | { s: 'loading'; chain: ChainId; address: string } | { s: 'done'; a: LensAnswer } | { s: 'error'; msg: string; retry: number | null }

// ─── small parts ────────────────────────────────────────────────────────────

function Ext({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`ln-ext ${className ?? ''}`}>
      {children}
    </a>
  )
}

function Addr({ chain, a, full }: { chain: ChainId; a: string | null; full?: boolean }) {
  if (!a) return <span className="dimmer">—</span>
  return (
    <Ext href={explorerUrl(chain, a)} className="mono">
      {full ? a : short(a, 6)}
    </Ext>
  )
}

function Copy({ text }: { text: string }) {
  const [ok, setOk] = useState(false)
  return (
    <button
      className="ln-copy"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setOk(true)
            setTimeout(() => setOk(false), 1200)
          },
          () => {},
        )
      }}
      aria-label="Copy"
    >
      {ok ? 'copied' : 'copy'}
    </button>
  )
}

function Row({ k, children, cite }: { k: string; children: ReactNode; cite?: { href: string; label: string } | null }) {
  return (
    <div className="ln-row">
      <span className="ln-k">{k}</span>
      <span className="ln-v">{children}</span>
      {cite ? (
        <Ext href={cite.href} className="ln-cite">
          {cite.label} ↗
        </Ext>
      ) : (
        <span className="ln-cite dimmer" />
      )}
    </div>
  )
}

function Section({ n, title, meta, children, open = true, id }: { n: string; title: string; meta?: ReactNode; children: ReactNode; open?: boolean; id?: string }) {
  return (
    <details className="ln-sec" open={open} id={id}>
      <summary>
        <span className="ln-sec-n hot">{n}</span>
        <span className="ln-sec-t">{title}</span>
        <span className="ln-sec-m">{meta}</span>
        <span className="ln-sec-x" aria-hidden />
      </summary>
      <div className="ln-sec-b">{children}</div>
    </details>
  )
}

const LOADER_SHORT: Record<string, string> = { 'bpf-upgradeable': 'v3', 'bpf-loader-2': 'v2', 'bpf-loader-1': 'v1', 'loader-v4': 'v4', native: 'native' }

const verifiedText = (v: LensReport['summary']['verified']) =>
  v === 'osec' ? 'OtterSec verified build' : v === 'sourcify-full' ? 'Sourcify full match' : v === 'sourcify-partial' ? 'Sourcify partial match' : 'not verified'

const VERDICT_CLASS: Partial<Record<Verdict, string>> = { kept: 'is-hot', duplicate: 'is-on', error: 'is-err' }

// ─── summary strip ──────────────────────────────────────────────────────────

function Strip({ r }: { r: LensReport }) {
  const s = r.summary
  const sol = r.chain === 'solana'
  const cells: { k: string; v: ReactNode; sub?: ReactNode; hot?: boolean; href?: string }[] = [
    { k: 'verified', v: s.verified ? 'yes' : 'no', sub: s.verified ? verifiedText(s.verified) : sol ? 'no OtterSec verified build' : 'no verified source on Sourcify', hot: !!s.verified, href: '#ln-verify' },
    {
      k: 'upgradeable',
      v: s.upgradeable === true ? 'yes' : s.upgradeable === false ? 'no' : 'unknown',
      sub: s.upgradeable === false ? (sol ? 'no upgrade authority' : 'fixed code') : s.authority ? `by ${short(s.authority, 4)}` : s.upgradeable ? (sol ? 'authority not read' : 'admin not in a standard slot') : 'not determinable from storage',
      href: '#ln-code',
    },
    {
      k: sol ? 'loader' : 'proxy',
      v: sol ? (LOADER_SHORT[r.solana?.loader ?? ''] ?? '—') : s.proxy ? 'yes' : 'no',
      sub: sol ? [r.solana?.loader, r.solana?.programBytes ? fmtBytes(r.solana.programBytes) : null].filter(Boolean).join(' · ') : (s.proxy ?? 'not a proxy'),
      href: '#ln-code',
    },
    { k: sol ? 'instructions' : 'functions', v: fmtN(s.surface), sub: s.surface === null ? (sol ? 'no on-chain IDL' : 'no verified ABI') : sol ? 'from the on-chain IDL' : 'from the verified ABI', href: '#ln-iface' },
    {
      k: 'privileged',
      v: fmtN(s.privileged),
      sub: s.privileged === null ? (sol ? 'needs an IDL' : 'needs verified source') : sol ? 'instructions with a role signer' : 'guarded state-changing fns',
      hot: (s.privileged ?? 0) > 0,
      href: '#ln-priv',
    },
    { k: 'crypto', v: fmtN(s.primitives), sub: sol ? 'syscalls / sig programs' : 'primitives in source', href: '#ln-prim' },
    {
      k: 'provenance',
      v: sol ? (r.provenance.osecRepo ? (r.provenance.osecRepo.inCodeIndex ? 'indexed' : 'not indexed') : '—') : `${fmtN(s.provenance)}/${fmtN(r.provenance.checked)}`,
      sub: sol ? (r.provenance.osecRepo ? repoSlug(r.provenance.osecRepo.repo) : 'no build repository') : 'files ≡ code index',
      href: '#ln-prov',
    },
    { k: 'SEPIA-1', v: VERDICT_LABEL[r.dataset.verdict], sub: r.dataset.added ? 'added by this read' : r.dataset.before ? `before: ${VERDICT_LABEL[r.dataset.before.verdict]}` : 'not seen before', hot: r.dataset.added, href: '#ln-data' },
  ]
  return (
    <div className="ln-strip">
      {cells.map((c) => (
        <a key={c.k} className={`ln-cell ${c.hot ? 'is-hot' : ''}`} href={c.href}>
          <span className="label">{c.k}</span>
          <span className={`ln-cell-v num ${typeof c.v === 'string' && c.v.length > 6 ? 'is-long' : ''}`}>{c.v}</span>
          <span className="ln-cell-s">{c.sub}</span>
        </a>
      ))}
    </div>
  )
}

// ─── report sections ────────────────────────────────────────────────────────

function FnList({ title, fns, priv, r, c }: { title: string; fns: string[]; priv: Set<string>; r: LensReport; c: LensContract }) {
  if (!fns.length) return null
  return (
    <div className="ln-fns">
      <div className="ln-fns-h label">
        {title} <span className="dimmer">{fns.length}</span>
      </div>
      <ul>
        {fns.map((f) => {
          const p = c.privileged.find((x) => x.fn === f)
          const l = p ? fileLink(r, p.file, p.line) : null
          return (
            <li key={f} className={priv.has(f) ? 'is-priv' : ''}>
              <code>{f}</code>
              {p && l && (
                <Ext href={l.url} className="ln-guard">
                  {p.guard}
                </Ext>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ContractBlock({ r, c, role }: { r: LensReport; c: LensContract; role: string }) {
  const priv = new Set(c.privileged.map((p) => p.fn))
  const n = c.functions.write.length + c.functions.payable.length + c.functions.view.length
  return (
    <div className="ln-contract">
      <div className="ln-contract-h">
        <span className="label">{role}</span>
        <span className="ln-contract-n">{c.name ?? 'unnamed'}</span>
        <Addr chain={r.chain} a={c.address} />
        {c.verified && <span className="tag">Sourcify {c.verified.match}</span>}
      </div>
      {n === 0 ? (
        <p className="dim ln-p">{c.verified ? 'The verified ABI lists no functions.' : 'No verified ABI on Sourcify: the interface cannot be read.'}</p>
      ) : (
        <div className="ln-fngrid" style={{ ['--cols' as string]: [c.functions.write, c.functions.payable, c.functions.view].filter((x) => x.length).length }}>
          <FnList title="state-changing" fns={c.functions.write} priv={priv} r={r} c={c} />
          <FnList title="payable" fns={c.functions.payable} priv={priv} r={r} c={c} />
          <FnList title="view / pure" fns={c.functions.view} priv={priv} r={r} c={c} />
        </div>
      )}
      {c.events.length > 0 && (
        <div className="ln-events">
          <span className="label">events {c.events.length}</span>
          <div className="ln-chips">
            {c.events.map((e) => (
              <code key={e}>{e}</code>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Primitives({ r, list }: { r: LensReport; list: LensPrimitive[] }) {
  if (!list.length)
    return (
      <p className="dim ln-p">
        {r.chain === 'solana'
          ? r.solana?.syscalls.length
            ? 'The program imports no hash, signature or curve syscall and carries no signature-verification program id.'
            : 'The executable could not be read for syscalls.'
          : r.evm?.implementation?.sources.length || r.evm?.self.sources.length
            ? 'No hash, signature or precompile call found in the verified source.'
            : 'No verified source to read.'}
      </p>
    )
  return (
    <div className="ln-prims">
      {list.map((p) => (
        <div key={p.name} className="ln-prim">
          <span className={`ln-prim-g g-${p.group}`}>{p.group}</span>
          <span className="ln-prim-n">{p.name}</span>
          <span className="ln-prim-via mono dimmer">
            {p.via === 'syscall-import' ? 'ELF import' : p.via === 'syscall-id' ? 'hashed syscall id' : p.via === 'program-id' ? 'program id in binary' : `${p.count}× in source`}
          </span>
          {p.at.length > 0 && (
            <span className="ln-prim-at">
              {p.at.map((a) => {
                const l = fileLink(r, a.file, a.line)
                return (
                  <Ext key={`${a.file}:${a.line}`} href={l.url} className="mono">
                    {a.file.split('/').pop()}:{a.line}
                  </Ext>
                )
              })}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

function SolanaSections({ r }: { r: LensReport }) {
  const s = r.solana!
  const [openIx, setOpenIx] = useState<string | null>(null)
  const roleSet = new Set(s.signerRoles.map((x) => x.instruction))
  return (
    <>
      <Section n="01" title="Program & deployment" id="ln-code" meta={<span className="mono">{s.loader ?? '—'}</span>}>
        <Row k="kind" cite={{ href: explorerUrl('solana', r.address), label: 'Explorer' }}>
          {r.kind}
        </Row>
        <Row k="loader">{s.loader ?? '—'}</Row>
        <Row k="upgradeable">{s.upgradeable === true ? 'yes' : s.upgradeable === false ? 'no (immutable)' : 'unknown'}</Row>
        <Row k="upgrade authority" cite={s.upgradeAuthority ? { href: explorerUrl('solana', s.upgradeAuthority), label: 'Explorer' } : null}>
          {s.upgradeAuthority ? <span className="mono">{s.upgradeAuthority}</span> : <span className="dim">{s.upgradeable === false ? 'none' : '—'}</span>}
        </Row>
        <Row k="programdata" cite={s.programDataAddress ? { href: explorerUrl('solana', s.programDataAddress), label: 'Explorer' } : null}>
          {s.programDataAddress ? <span className="mono">{s.programDataAddress}</span> : '—'}
        </Row>
        <Row k="executable size">{fmtBytes(s.programBytes)}</Row>
        <Row k="last deploy slot" cite={s.lastDeploySlot ? { href: slotUrl(s.lastDeploySlot), label: 'block' } : null}>
          {fmtN(s.lastDeploySlot)}
        </Row>
        <Row k="code hash">
          {s.codeHash ? <span className="mono ln-hash">{s.codeHash}</span> : '—'}
          {s.codeHash && <span className="dimmer ln-note"> sha256 of the executable, trailing zeros removed (solana-verify rule)</span>}
        </Row>
      </Section>

      <Section n="02" title="Verified build" id="ln-verify" meta={<span className={s.osec?.verified ? 'hot' : 'dim'}>{s.osec?.verified ? 'verified' : 'not verified'}</span>}>
        <Row k="OtterSec" cite={{ href: `https://verify.osec.io/status/${r.address}`, label: 'verify.osec.io' }}>
          {s.osec === null ? (
            <span className="dim">registry not asked or unavailable</span>
          ) : s.osec.verified ? (
            'verified: the build from this repository and commit hashes to the deployed code'
          ) : s.osec.repo ? (
            'build record exists, not verified for the deployed code'
          ) : (
            <span className="dim">no build record</span>
          )}
        </Row>
        {s.osec?.repo && (
          <Row k="repository" cite={{ href: s.osec.commit ? `${s.osec.repo.replace(/\/+$/, '')}/tree/${s.osec.commit}` : s.osec.repo, label: 'GitHub' }}>
            <span className="mono">
              {repoSlug(s.osec.repo)}
              {s.osec.commit ? `@${s.osec.commit.slice(0, 10)}` : ''}
            </span>
          </Row>
        )}
      </Section>

      <Section
        n="03"
        title="Interface"
        id="ln-iface"
        meta={s.idl ? <span className="mono">{`${s.idl.instructions.length} ix · ${s.idl.format ?? ''}`}</span> : <span className="dim">no on-chain IDL</span>}
      >
        {!s.idl ? (
          <p className="dim ln-p">No Anchor IDL account and no program-metadata IDL on-chain: the instructions cannot be read without the source.</p>
        ) : (
          <>
            <Row k="source">{s.idl.source}</Row>
            <Row k="name / version">
              {s.idl.name ?? '—'} {s.idl.version ? <span className="dim">v{s.idl.version}</span> : null}
            </Row>
            <Row k="account types">{fmtN(s.idl.accounts.length)}</Row>
            <Row k="defined types">{fmtN(s.idl.types)}</Row>
            <Row k="errors / events">
              {fmtN(s.idl.errors.length)} / {fmtN(s.idl.events.length)}
            </Row>
            <div className="ln-ix">
              {s.idl.instructions.map((ix) => {
                const open = openIx === ix.name
                const signers = ix.accounts.filter((a) => a.signer)
                return (
                  <div key={ix.name} className={`ln-ixrow ${open ? 'open' : ''} ${roleSet.has(ix.name) ? 'is-priv' : ''}`}>
                    <button className="ln-ixhead" onClick={() => setOpenIx(open ? null : ix.name)} aria-expanded={open}>
                      <code>{ix.name}</code>
                      <span className="ln-ixmeta mono dimmer">
                        {ix.accounts.length} acc · {ix.args.length} args{signers.length ? ` · signer ${signers.map((a) => a.name).join(', ')}` : ''}
                      </span>
                    </button>
                    {open && (
                      <div className="ln-ixbody">
                        {ix.docs && <p className="dim">{ix.docs}</p>}
                        <div className="ln-ixcols">
                          <div>
                            <div className="label">accounts</div>
                            {ix.accounts.map((a) => (
                              <div key={a.name} className="ln-acc mono">
                                <span>{a.name}</span>
                                <span className="dimmer">
                                  {[a.signer && 'signer', a.writable && 'mut', a.optional && 'optional'].filter(Boolean).join(' · ') || 'read'}
                                </span>
                              </div>
                            ))}
                          </div>
                          <div>
                            <div className="label">args</div>
                            {ix.args.length === 0 && <div className="dimmer mono">none</div>}
                            {ix.args.map((a) => (
                              <div key={a.name} className="ln-acc mono">
                                <span>{a.name}</span>
                                <span className="dimmer">{a.type}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {s.idl.errors.length > 0 && (
              <details className="ln-sub">
                <summary className="label">errors {s.idl.errors.length}</summary>
                <div className="ln-errs">
                  {s.idl.errors.map((e) => (
                    <div key={`${e.code}-${e.name}`} className="ln-acc mono">
                      <span>
                        {e.code ?? '—'} {e.name}
                      </span>
                      <span className="dimmer">{e.msg ?? ''}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </Section>

      <Section n="04" title="Privileged roles" id="ln-priv" meta={<span className="mono">{s.idl ? `${roleSet.size} instructions` : '—'}</span>}>
        {!s.idl ? (
          <p className="dim ln-p">Needs an on-chain IDL.</p>
        ) : s.signerRoles.length === 0 ? (
          <p className="dim ln-p">No instruction requires a signer named as an authority role (admin, operator, governance, fee / config / upgrade authority…).</p>
        ) : (
          <>
            <p className="dim ln-p">Instructions whose IDL requires a signer account named as a role. The name is what the IDL says; who holds the key is on-chain state, not read here.</p>
            <div className="ln-table">
              {s.signerRoles.map((x) => (
                <div key={`${x.instruction}-${x.account}`} className="ln-tr">
                  <code>{x.instruction}</code>
                  <span className="mono hot">{x.account}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Section>

      <Section n="05" title="Cryptography" id="ln-prim" meta={<span className="mono">{r.primitives.length}</span>}>
        <Primitives r={r} list={r.primitives} />
        {s.syscalls.length > 0 && (
          <div className="ln-events">
            <span className="label">all syscalls imported {s.syscalls.length}</span>
            <div className="ln-chips">
              {s.syscalls.map((x) => (
                <code key={x}>{x}</code>
              ))}
            </div>
          </div>
        )}
      </Section>

      <Section n="06" title="security.txt" id="ln-sec" open={!!s.securityTxt} meta={<span className="dim">{s.securityTxt ? `${Object.keys(s.securityTxt).length} fields` : 'none embedded'}</span>}>
        {!s.securityTxt ? (
          <p className="dim ln-p">The executable embeds no security.txt.</p>
        ) : (
          Object.entries(s.securityTxt).map(([k, v]) => (
            <Row key={k} k={k}>
              {/^https?:\/\//.test(v) ? <Ext href={v}>{v}</Ext> : <span className="ln-wrap">{v}</span>}
            </Row>
          ))
        )}
      </Section>
    </>
  )
}

function EvmSections({ r }: { r: LensReport }) {
  const e = r.evm!
  const code = e.implementation ?? e.self
  const allPriv = [...(e.implementation?.privileged ?? []).map((p) => ({ ...p, of: 'implementation' })), ...e.self.privileged.map((p) => ({ ...p, of: e.proxy ? 'proxy' : 'contract' }))]
  return (
    <>
      <Section n="01" title="Code & deployment" id="ln-code" meta={<span className="mono">{fmtBytes(e.bytecodeBytes)}</span>}>
        <Row k="kind" cite={{ href: explorerUrl(r.chain, r.address), label: explorerName(r.chain) }}>
          {r.kind}
        </Row>
        <Row k="runtime bytecode">{fmtBytes(e.bytecodeBytes)}</Row>
        <Row k="code hash">
          {e.codeHash ? <span className="mono ln-hash">{e.codeHash}</span> : '—'}
          {e.codeHash && <span className="dimmer ln-note"> sha256 of the runtime bytecode without its metadata trailer</span>}
        </Row>
        <Row k="proxy">{e.proxy ? e.proxy.label : 'not a proxy'}</Row>
        {e.proxy && (
          <>
            <Row k="implementation" cite={{ href: explorerUrl(r.chain, e.proxy.implementation), label: explorerName(r.chain) }}>
              <span className="mono">{e.proxy.implementation}</span>
            </Row>
            <Row k="admin" cite={e.proxy.admin ? { href: explorerUrl(r.chain, e.proxy.admin), label: explorerName(r.chain) } : null}>
              {e.proxy.admin ? <span className="mono">{e.proxy.admin}</span> : <span className="dim">not in a standard admin slot (upgrade rights are in the code; see privileged)</span>}
            </Row>
          </>
        )}
        <Row k="upgradeable">{r.summary.upgradeable === true ? 'yes' : r.summary.upgradeable === false ? 'no' : 'unknown'}</Row>
        {code.deployBlock && (
          <Row k={e.implementation ? 'implementation deployed' : 'deployed in block'} cite={{ href: blockUrl(r.chain, code.deployBlock), label: 'block' }}>
            {fmtN(code.deployBlock)}
          </Row>
        )}
      </Section>

      <Section n="02" title="Verified source" id="ln-verify" meta={<span className={code.verified ? 'hot' : 'dim'}>{code.verified ? `Sourcify ${code.verified.match}` : 'not verified'}</span>}>
        {[e.self, ...(e.implementation ? [e.implementation] : [])].map((c, i) => (
          <div key={c.address} className="ln-vblock">
            <Row k={i === 0 && e.proxy ? 'proxy' : i === 1 ? 'implementation' : 'contract'} cite={c.verified ? { href: sourcifyUrl(e.chainId, c.address), label: 'Sourcify' } : null}>
              {c.verified ? (
                <>
                  <b>{c.name ?? 'unnamed'}</b> · Sourcify {c.verified.match} match · <span className="mono">{c.verified.compiler ?? 'compiler not recorded'}</span>
                </>
              ) : (
                <span className="dim">no verified source on Sourcify</span>
              )}
            </Row>
            {c.profile && (
              <Row k="lines">
                custom {fmtN(c.profile.customLines)} · library {fmtN(c.profile.libraryLines)} · interfaces {fmtN(c.profile.interfaceLines)}
                {c.profile.boilerplate && <span className="dim"> · {c.profile.boilerplate}</span>}
              </Row>
            )}
            {c.sources.length > 0 && (
              <details className="ln-sub">
                <summary className="label">
                  source files {c.sources.length} · {fmtBytes(c.sources.reduce((s, f) => s + f.bytes, 0))}
                </summary>
                <div className="ln-files">
                  {c.sources.map((f) => {
                    const m = r.provenance.matches.find((x) => x.file === f.path)
                    return (
                      <div key={f.path} className="ln-file mono">
                        <span className="ln-wrap">{f.path}</span>
                        <span className="dimmer">{fmtBytes(f.bytes)}</span>
                        {m ? (
                          <Ext href={repoFileUrl(m.repo, m.commit, m.path)} className="ln-match">
                            {m.exact ? '≡' : '≈'} {m.repo}
                          </Ext>
                        ) : (
                          <span />
                        )}
                      </div>
                    )
                  })}
                </div>
              </details>
            )}
          </div>
        ))}
      </Section>

      <Section n="03" title="Interface" id="ln-iface" meta={<span className="mono">{r.summary.surface === null ? '—' : `${r.summary.surface} fns`}</span>}>
        {e.implementation && <ContractBlock r={r} c={e.implementation} role="implementation" />}
        <ContractBlock r={r} c={e.self} role={e.proxy ? 'proxy' : 'contract'} />
      </Section>

      <Section n="04" title="Privileged functions" id="ln-priv" meta={<span className="mono">{allPriv.length}</span>}>
        {!(e.implementation?.sources.length || e.self.sources.length) ? (
          <p className="dim ln-p">Needs verified source.</p>
        ) : allPriv.length === 0 ? (
          <p className="dim ln-p">No state-changing function is guarded by an access-control modifier or a check on msg.sender.</p>
        ) : (
          <>
            <p className="dim ln-p">
              State-changing functions of the verified ABI whose definition is guarded by an access-control modifier (onlyOwner, onlyRole, auth…) or checks
              msg.sender against stored state. Each row links to the line.
            </p>
            <div className="ln-table">
              {allPriv.map((p) => {
                const l = fileLink(r, p.file, p.line)
                return (
                  <div key={`${p.of}-${p.fn}`} className="ln-tr ln-tr-priv">
                    <code>{p.fn}</code>
                    <span className="mono hot ln-wrap">{p.guard}</span>
                    <Ext href={l.url} className="mono dim">
                      {p.file.split('/').pop()}:{p.line}
                    </Ext>
                    <span className="label dimmer">{p.of}</span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </Section>

      <Section n="05" title="Cryptography" id="ln-prim" meta={<span className="mono">{r.primitives.length}</span>}>
        <Primitives r={r} list={r.primitives} />
      </Section>
    </>
  )
}

function Report({ a, onRetry }: { a: LensAnswer; onRetry: () => void }) {
  const r = a.report
  const sol = r.chain === 'solana'
  const p = r.provenance
  const d = r.dataset
  return (
    <article className="ln-report">
      <header className="ln-rhead">
        <div className="ln-rtags">
          <span className="tag solid">{CHAIN_SHORT[r.chain]}</span>
          <span className="tag">{r.kind}</span>
          {r.summary.verified && <span className="tag hot">{verifiedText(r.summary.verified)}</span>}
          <span className="label dimmer">
            read {fmtUtc(r.readAt)} · {fmtN(r.ms)} ms · {r.rpcCalls} RPC · {r.registryCalls} registry
            {a.cached ? ' · from cache' : ''}
          </span>
        </div>
        <h2 className="display ln-name">{r.name ?? (r.kind === 'program' ? 'unnamed program' : r.kind === 'contract' ? 'unnamed contract' : r.kind)}</h2>
        <div className="ln-raddr">
          <span className="mono">{r.address}</span>
          <Copy text={r.address} />
          <Ext href={explorerUrl(r.chain, r.address)}>{explorerName(r.chain)} ↗</Ext>
          <button className="ln-copy" onClick={onRetry} title="Read again (served from cache within 15 minutes)">
            reload
          </button>
        </div>
      </header>

      {r.kind === 'program' || r.kind === 'contract' ? (
        <Strip r={r} />
      ) : (
        <div className="ln-notcode">
          <span className="label hot">not code</span>
          <p>
            {r.kind === 'token-mint'
              ? 'This is a token mint: supply, decimals and authorities. Lens reads programs and contracts.'
              : r.kind === 'empty'
                ? sol
                  ? 'No account exists at this address.'
                  : 'No contract code at this address on this chain.'
                : r.kind === 'account'
                  ? 'An account, not executable code.'
                  : ''}
          </p>
        </div>
      )}

      {(r.kind === 'program' || r.kind === 'contract') && (sol ? <SolanaSections r={r} /> : <EvmSections r={r} />)}

      <Section n={sol ? '07' : '06'} title="Provenance" id="ln-prov" meta={<span className="mono">{sol ? (p.osecRepo ? repoSlug(p.osecRepo.repo) : '—') : `${p.matches.length}/${p.checked} files`}</span>}>
        <p className="dim ln-p">
          {p.index.files > 0 ? (
            <>
              Compared against LUSCA's protocol code index: {fmtN(p.index.repos)} repositories, {fmtN(p.index.files)} files hashed
              {p.index.builtAt ? ` (${ago(p.index.builtAt)})` : ''}. ≡ byte-identical file · ≈ same code, comments and whitespace aside.
            </>
          ) : (
            'The code index is not connected yet on this server: provenance cannot be checked.'
          )}
        </p>
        {sol && p.osecRepo && (
          <Row k="build repository" cite={{ href: `https://github.com/${p.osecRepo.repo}${p.osecRepo.commit ? `/tree/${p.osecRepo.commit}` : ''}`, label: 'GitHub' }}>
            <span className="mono">
              {p.osecRepo.repo}
              {p.osecRepo.commit ? `@${p.osecRepo.commit.slice(0, 10)}` : ''}
            </span>{' '}
            <span className={p.osecRepo.inCodeIndex ? 'hot' : 'dim'}>
              {p.osecRepo.inCodeIndex ? `in the code index at ${p.osecRepo.indexCommit?.slice(0, 10) ?? 'an unrecorded commit'}` : 'not in the code index'}
            </span>
          </Row>
        )}
        {!sol && p.matches.length > 0 && (
          <div className="ln-table">
            {p.matches.map((m) => (
              <div key={`${m.of}-${m.file}`} className="ln-tr ln-tr-prov">
                <span className={`ln-eq ${m.exact ? 'hot' : ''}`}>{m.exact ? '≡' : '≈'}</span>
                <code className="ln-wrap">{m.file}</code>
                <Ext href={repoFileUrl(m.repo, m.commit, m.path)} className="mono ln-wrap">
                  {m.repo}@{(m.commit ?? '').slice(0, 7)}:{m.path}
                </Ext>
              </div>
            ))}
          </div>
        )}
        {!sol && p.checked > 0 && p.matches.length === 0 && p.index.files > 0 && <p className="dim ln-p">None of the verified files is in the code index.</p>}
      </Section>

      <Section n={sol ? '08' : '07'} title="SEPIA-1 dataset" id="ln-data" meta={<span className={`ln-verdict ${VERDICT_CLASS[d.verdict] ?? ''}`}>{VERDICT_LABEL[d.verdict]}</span>}>
        <Row k="address judged">
          <span className="mono">{d.address}</span> {d.address !== r.address && <span className="dim">(the implementation: that is the code)</span>}
        </Row>
        <Row k="before this read">
          {d.before ? (
            <>
              <span className={`ln-verdict ${VERDICT_CLASS[d.before.verdict] ?? ''}`}>{VERDICT_LABEL[d.before.verdict]}</span> {d.before.reason}
              {d.before.at ? <span className="dimmer"> · {ago(d.before.at)}</span> : null}
              {d.before.via ? <span className="dimmer"> · via {d.before.via}</span> : null}
            </>
          ) : (
            <span className="dim">not in the chain agents' recent reads or the kept index</span>
          )}
        </Row>
        <Row k="verdict now">
          <span className={`ln-verdict ${VERDICT_CLASS[d.verdict] ?? ''}`}>{VERDICT_LABEL[d.verdict]}</span> {d.reason}
        </Row>
        <p className="dim ln-p">
          {d.added
            ? 'This read passed the same rules the chain agents use and was added to the SEPIA-1 chain index (discovery source: lens).'
            : `${VERDICT_TEXT[d.verdict]} Lens applies the chain agents' rules; only reads they would keep are added.`}{' '}
          <Link to={`/chain/${r.chain}/${d.address}`}>chain index →</Link>
        </p>
      </Section>

      <Section n={sol ? '09' : '08'} title="Read notes" open={false} meta={<span className="mono dim">{r.notes.length}</span>}>
        <ul className="ln-notes mono">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Section>

      <div className="ln-cites">
        <span className="label">sources</span>
        {r.cites.map((c) => (
          <Ext key={c.url} href={c.url}>
            {c.label} ↗
          </Ext>
        ))}
      </div>
    </article>
  )
}

// ─── loading ────────────────────────────────────────────────────────────────

function Reading({ chain, address }: { chain: ChainId; address: string }) {
  const steps =
    chain === 'solana'
      ? ['getMultipleAccounts · program, programdata, Anchor IDL, program-metadata IDL', 'ELF · code hash, security.txt, syscall imports', 'verify.osec.io · verified build', 'SEPIA-1 rules · chain index']
      : [
          `eth_getCode · ${CHAIN_LABEL[chain]}`,
          'proxy slots · EIP-1967 / 1822 / beacon / 1167 / 897',
          'Sourcify · ABI, compiler, sources',
          'implementation · same read',
          'source · privileged functions, primitives, code-index hashes',
          'SEPIA-1 rules · chain index',
        ]
  return (
    <div className="ln-reading">
      <div className="ln-reading-h">
        <span className="led on pulse" /> <span className="label">reading</span> <span className="mono">{short(address, 8)}</span>{' '}
        <span className="dimmer mono">{CHAIN_LABEL[chain]}</span>
      </div>
      <ol>
        {steps.map((s, i) => (
          <li key={s} style={{ animationDelay: `${i * 0.35}s` }}>
            <span className="ln-step-n mono">{String(i + 1).padStart(2, '0')}</span>
            {s}
          </li>
        ))}
      </ol>
    </div>
  )
}

// ─── page ───────────────────────────────────────────────────────────────────

export default function Lens() {
  const params = useParams()
  const nav = useNavigate()
  const routeChain = isChainId(params.chain) ? params.chain : null
  const routeAddr = params.address ?? null
  const [text, setText] = useState(routeAddr ?? '')
  const [phase, setPhase] = useState<Phase>({ s: 'idle' })
  const [detectMsg, setDetectMsg] = useState<string | null>(null)
  const [alsoOn, setAlsoOn] = useState<ChainId[]>([])
  const [recent, setRecent] = useState<LensRecent[] | null>(null)
  const [reads, setReads] = useState<number | null>(null)
  const [nonce, setNonce] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const input = useMemo(() => classify(text), [text])

  useEffect(() => {
    document.title = routeAddr ? `Lens · ${short(routeAddr, 4)} · LUSCA` : 'Lens · LUSCA'
  }, [routeAddr])

  // the report of the address in the URL
  useEffect(() => {
    if (!routeChain || !routeAddr) {
      setPhase({ s: 'idle' })
      return
    }
    setText(routeAddr)
    const ac = new AbortController()
    setPhase({ s: 'loading', chain: routeChain, address: routeAddr })
    fetchLens(routeChain, routeAddr, ac.signal)
      .then((a) => setPhase({ s: 'done', a }))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setPhase({ s: 'error', msg: e instanceof Error ? e.message : String(e), retry: e instanceof LensHttpError ? e.retryAfter : null })
      })
    return () => ac.abort()
  }, [routeChain, routeAddr, nonce])

  // recent reads (public strip): on load and after each report
  useEffect(() => {
    const ac = new AbortController()
    fetchRecent(ac.signal)
      .then((j) => {
        setRecent(j.recent)
        setReads(j.reads)
      })
      .catch(() => {})
    return () => ac.abort()
  }, [phase.s === 'done' ? (phase as { a: LensAnswer }).a.report.readAt : 0])

  async function submit(chainPick?: ChainId) {
    setDetectMsg(null)
    setAlsoOn([])
    if (input.kind === 'solana') return nav(`/lens/solana/${input.address}`)
    if (input.kind !== 'evm') return
    if (chainPick) return nav(`/lens/${chainPick}/${input.address.toLowerCase()}`)
    setDetectMsg('looking for code on Ethereum, Base and Arbitrum…')
    try {
      const d = await fetchDetect(input.address)
      const withCode = d.chains.filter((c) => c.code).map((c) => c.chain)
      if (!withCode.length) {
        const unknown = d.chains.filter((c) => c.code === null).map((c) => CHAIN_LABEL[c.chain])
        setDetectMsg(unknown.length ? `no code found; ${unknown.join(', ')} did not answer — pick a chain` : 'no contract code at this address on Ethereum, Base or Arbitrum')
        return
      }
      setDetectMsg(null)
      setAlsoOn(withCode.slice(1))
      nav(`/lens/${withCode[0]}/${input.address.toLowerCase()}`)
    } catch (e) {
      setDetectMsg(`${e instanceof Error ? e.message : String(e)} — pick a chain`)
    }
  }

  const hint =
    input.kind === 'solana'
      ? 'Solana · base58 program id'
      : input.kind === 'evm'
        ? 'EVM · the chain is found by eth_getCode, or pick one'
        : input.kind === 'invalid'
          ? input.why
          : 'Solana program id, or an Ethereum / Base / Arbitrum contract address'

  return (
    <div className="ln">
      <section className="ln-hero">
        <div className="ln-hero-l">
          <div className="ln-kick mono">
            <span className="hot">LENS</span> / read a protocol
          </div>
          <h1 className="display">Lens</h1>
          <p className="ln-lede">
            Paste a Solana program id or an Ethereum, Base or Arbitrum contract address. LUSCA reads it on-chain with the same readers its chain agents use and
            returns a report in which every fact links to where it was read. No model writes any of it.
          </p>
        </div>
        <form
          className={`ln-form ${input.kind === 'invalid' ? 'bad' : ''}`}
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <label className="label" htmlFor="ln-in">
            address
          </label>
          <div className="ln-inrow">
            <input
              id="ln-in"
              ref={inputRef}
              className="mono"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="JUP6LkbZ… or 0x1F98431c…"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
            />
            <button className="btn primary" type="submit" disabled={input.kind !== 'solana' && input.kind !== 'evm'}>
              read →
            </button>
          </div>
          <div className="ln-hint">
            <span className={`ln-fmt ${input.kind}`}>{input.kind === 'solana' ? 'SOL' : input.kind === 'evm' ? 'EVM' : input.kind === 'invalid' ? '!' : '·'}</span>
            <span className="dim">{detectMsg ?? hint}</span>
          </div>
          {input.kind === 'evm' && (
            <div className="ln-pick">
              {EVM_CHAINS.map((c) => (
                <button key={c} type="button" className={`ln-chip ${routeChain === c && routeAddr?.toLowerCase() === input.address.toLowerCase() ? 'on' : ''}`} onClick={() => void submit(c)}>
                  {CHAIN_LABEL[c]}
                  {alsoOn.includes(c) ? ' · also has code' : ''}
                </button>
              ))}
            </div>
          )}
        </form>
      </section>

      <section className="ln-examples">
        <span className="label">examples</span>
        <div className="ln-exrow">
          {EXAMPLES.map((x) => (
            <Link key={`${x.chain}-${x.address}`} className="ln-ex" to={`/lens/${x.chain}/${x.chain === 'solana' ? x.address : x.address.toLowerCase()}`}>
              <span className="ln-ex-c mono">{CHAIN_SHORT[x.chain]}</span>
              <span className="ln-ex-l">{x.label}</span>
              <span className="ln-ex-n dimmer">{x.note}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="ln-main">
        {phase.s === 'idle' && (
          <div className="ln-empty">
            <div className="ln-empty-grid">
              {[
                ['upgradeable by whom', 'upgrade authority, proxy standard and admin, followed to the implementation'],
                ['verified source', 'OtterSec verified builds, Sourcify full / partial matches, compiler, files'],
                ['interface', 'IDL instructions with accounts and args; ABI functions by mutability'],
                ['privileged', 'admin-gated functions with the file and line of the guard'],
                ['cryptography', 'hash, signature and curve primitives: ELF syscalls and source lines'],
                ['provenance', 'files byte-identical to a repository at a commit in LUSCA’s code index'],
              ].map(([k, v]) => (
                <div key={k} className="ln-empty-c">
                  <span className="label hot">{k}</span>
                  <p>{v}</p>
                </div>
              ))}
            </div>
          </div>
        )}
        {phase.s === 'loading' && <Reading chain={phase.chain} address={phase.address} />}
        {phase.s === 'error' && (
          <div className="ln-error">
            <span className="label">read failed</span>
            <p>{phase.msg}</p>
            <button className="btn" onClick={() => setNonce((n) => n + 1)}>
              retry{phase.retry ? ` (after ${phase.retry} s)` : ''}
            </button>
          </div>
        )}
        {phase.s === 'done' && <Report a={phase.a} onRetry={() => setNonce((n) => n + 1)} />}
      </section>

      <section className="ln-recent">
        <div className="ln-recent-h">
          <span className="label">recent reads</span>
          <span className="label dimmer">{reads === null ? '—' : `${fmtN(reads)} reads served`}</span>
        </div>
        {recent === null ? (
          <p className="dimmer mono ln-p">—</p>
        ) : recent.length === 0 ? (
          <p className="dim ln-p">No reads yet.</p>
        ) : (
          <div className="ln-recent-row">
            {recent.map((x) => (
              <Link key={`${x.chain}-${x.address}`} to={`/lens/${x.chain}/${x.address}`} className="ln-rc">
                <span className="ln-rc-t">
                  <span className="mono">{CHAIN_SHORT[x.chain]}</span>
                  <span className="dimmer">{ago(x.at)}</span>
                </span>
                <span className="ln-rc-n">{x.name ?? short(x.address, 5)}</span>
                <span className="mono dimmer">{short(x.address, 5)}</span>
                <span className={`ln-rc-v ${x.verified ? 'hot' : 'dimmer'}`}>{x.verified ? verifiedText(x.verified) : 'not verified'}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
