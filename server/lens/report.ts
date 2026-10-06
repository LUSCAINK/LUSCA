// LensReport assembly from what the chain agents' readers returned (server/chain/solana.ts,
// server/chain/evm.ts) plus the ELF scan, the source analysis and the code-index provenance.
// Pure: no I/O, the same inputs give the same report. A field the readers did not fill stays null.

import type { ChainId, ChainRead } from '../../shared/chain.ts'
import type {
  LensCite,
  LensContract,
  LensDataset,
  LensEvm,
  LensPrimitive,
  LensProvenance,
  LensProvenanceMatch,
  LensReport,
  LensSolana,
  LensSummary,
} from '../../shared/lens.ts'
import { EVM_CHAIN_IDS, type EvmChain } from '../chain/evm.ts'
import { normalizeRepoUrl, osecStatusUrl, type OsecStatus } from '../chain/solana/osec.ts'
import { OSEC_UNAVAILABLE } from '../chain/solana.ts'
import { AnalysisLimit, Work, findPrimitives, findPrivileged, groupAbi } from './evm-analysis.ts'
import { solanaPrimitives, KNOWN_SYSCALLS, type ElfScan } from './elf-syscalls.ts'
import { idlDetail, signerRoles } from './idl-detail.ts'
import type { ProvenanceIndex } from './provenance.ts'

export const EXPLORER: Record<ChainId, (a: string) => string> = {
  solana: (a) => `https://explorer.solana.com/address/${a}`,
  ethereum: (a) => `https://etherscan.io/address/${a}`,
  base: (a) => `https://basescan.org/address/${a}`,
  arbitrum: (a) => `https://arbiscan.io/address/${a}`,
}
export const sourcifyUrl = (chain: EvmChain, a: string) => `https://repo.sourcify.dev/${EVM_CHAIN_IDS[chain]}/${a}`
export const sourcifyApiUrl = (chain: EvmChain, a: string) => `https://sourcify.dev/server/v2/contract/${EVM_CHAIN_IDS[chain]}/${a}?fields=all`
/** Link to a repository at a commit: GitHub slugs get a tree link; another host's https URL is linked as given; anything else, no link. */
export const repoCommitUrl = (repo: string, commit: string | null): string | null => {
  const slug = repo
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) return `https://github.com/${slug}${commit && /^[0-9a-f]{7,64}$/i.test(commit) ? `/tree/${commit}` : ''}`
  return /^https:\/\/[^\s"'<>]+$/i.test(repo) ? repo : null
}

export interface EvmPart {
  read: ChainRead
  abiJson: unknown | null
  sources: { path: string; text: string }[]
  profile: { customLines: number; libraryLines: number; interfaceLines: number; boilerplate: string | null } | null
  /** deployment.blockNumber of the Sourcify record, when it had one */
  deployBlock: number | null
}

export interface SolanaInput {
  read: ChainRead
  idlJson: unknown | null
  elf: ElfScan | null
  osec: OsecStatus | null
  programDataAddress: string | null
}

export interface BuildCommon {
  ms: number
  rpcCalls: number
  registryCalls: number
  provenance: Pick<ProvenanceIndex, 'lookup' | 'repoCommit' | 'stats'>
  dataset: LensDataset
  notes?: string[]
}

const PROXY_LABEL: Record<NonNullable<ChainRead['proxy']>['standard'], string> = {
  eip1967: 'EIP-1967 transparent / UUPS',
  eip1822: 'EIP-1822 UUPS (PROXIABLE)',
  beacon: 'EIP-1967 beacon',
  eip1167: 'EIP-1167 minimal clone',
  other: 'other',
}

/** Readable proxy kind; 'other' is named from the reader's own note (ZeppelinOS, EIP-897, Safe, Sourcify). */
export function proxyLabel(r: ChainRead): string {
  if (!r.proxy) return ''
  if (r.kind === 'account') return 'EIP-7702 delegation'
  if (r.proxy.standard !== 'other') return PROXY_LABEL[r.proxy.standard]
  const n = r.notes.join('\n')
  if (/ZeppelinOS proxy/.test(n)) return 'ZeppelinOS upgradeability proxy (pre-EIP-1967 slots)'
  if (/EIP-897 proxy/.test(n)) return 'EIP-897 delegate proxy (implementation())'
  if (/Gnosis Safe proxy/.test(n)) return 'Safe proxy (singleton in slot 0)'
  const sf = /proxy \(([^)]+)\) → implementation .*from the Sourcify record/.exec(n)
  if (sf) return `${sf[1]} (per Sourcify)`
  return 'proxy (non-standard slot)'
}

function verifiedOf(r: ChainRead | null | undefined): LensSummary['verified'] {
  const v = r?.verified
  if (!v) return null
  if (v.by === 'osec') return 'osec'
  return v.match === 'full' ? 'sourcify-full' : 'sourcify-partial'
}

const uniq = (xs: string[]) => [...new Set(xs)]

// ─── Solana ──────────────────────────────────────────────────────────────────

export function buildSolanaReport(x: SolanaInput, c: BuildCommon): LensReport {
  const r = x.read
  const idlNote = r.notes.find((n) => n.startsWith('IDL from the '))
  const idlSource = idlNote ? (/^IDL from the (.+?) \(/.exec(idlNote)?.[1] ?? 'on-chain IDL') : 'on-chain IDL'
  const idl = x.idlJson ? idlDetail(x.idlJson, idlSource) : null
  const roles = signerRoles(idl)
  const syscalls = x.elf ? uniq([...x.elf.imports.filter((s) => KNOWN_SYSCALLS.includes(s) || /^sol_/.test(s)), ...x.elf.hashed]) : []
  const primitives: LensPrimitive[] = x.elf ? solanaPrimitives(x.elf) : []
  const osec = x.osec ? { verified: r.verified?.by === 'osec', repo: x.osec.repo, commit: x.osec.commit } : null
  const sol: LensSolana = {
    loader: r.loader,
    upgradeable: r.upgradeable,
    upgradeAuthority: r.upgradeAuthority,
    programDataAddress: x.programDataAddress,
    programBytes: r.programBytes,
    lastDeploySlot: r.lastDeploySlot,
    codeHash: r.codeHash,
    securityTxt: r.securityTxt,
    idl,
    osec,
    syscalls,
    signerRoles: roles,
  }

  const repoUrl = osec?.repo ?? null
  let osecRepo: LensProvenance['osecRepo'] = null
  if (repoUrl) {
    const slug = normalizeRepoUrl(repoUrl)?.repo.replace(/^https?:\/\/(www\.)?github\.com\//i, '') ?? repoUrl
    const ic = c.provenance.repoCommit(slug)
    osecRepo = { repo: slug, commit: osec?.commit ?? null, inCodeIndex: ic !== undefined, indexCommit: ic ?? null }
  }
  const provenance: LensProvenance = { checked: 0, matches: [], osecRepo, index: c.provenance.stats() }

  const cites: LensCite[] = [{ label: 'Solana Explorer', url: EXPLORER.solana(r.address) }]
  if (x.programDataAddress) cites.push({ label: 'programdata account', url: EXPLORER.solana(x.programDataAddress) })
  if (r.upgradeAuthority) cites.push({ label: 'upgrade authority', url: EXPLORER.solana(r.upgradeAuthority) })
  if (x.osec || r.kind === 'program') cites.push({ label: 'OtterSec verify registry', url: osecStatusUrl(r.address) })
  const osecLink = osecRepo ? repoCommitUrl(osecRepo.repo, osecRepo.commit) : null
  if (osecRepo && osecLink) cites.push({ label: `${osecRepo.repo}${osecRepo.commit ? `@${osecRepo.commit.slice(0, 10)}` : ''}`, url: osecLink })

  const notes = [...r.notes, ...(x.elf?.notes ?? []), ...(c.notes ?? [])]
  // OtterSec could not be asked (endpoint failure or its budget): unknown, not "not verified"
  const osecDown = r.kind === 'program' && !r.verified && r.notes.some((n) => n.startsWith(OSEC_UNAVAILABLE))
  const summary: LensSummary = {
    verified: osecDown ? 'unknown' : verifiedOf(r),
    upgradeable: r.upgradeable,
    authority: r.upgradeAuthority,
    proxy: null,
    surface: idl ? idl.instructions.length : null,
    privileged: idl ? new Set(roles.map((x) => x.instruction)).size : null,
    primitives: primitives.length,
    provenance: osecRepo?.inCodeIndex && osec?.verified ? 1 : 0,
  }
  return {
    v: 1,
    chain: 'solana',
    address: r.address,
    kind: r.kind,
    name: r.name ?? idl?.name ?? null,
    readAt: r.readAt,
    ms: c.ms,
    rpcCalls: c.rpcCalls,
    registryCalls: c.registryCalls,
    summary,
    solana: sol,
    evm: null,
    primitives,
    provenance,
    dataset: c.dataset,
    notes: uniq(notes).slice(0, 40),
    cites,
  }
}

// ─── EVM ─────────────────────────────────────────────────────────────────────

function contractOf(p: EvmPart): LensContract {
  const r = p.read
  const g = groupAbi(p.abiJson)
  // only state-changing functions can be privileged in a way that matters (views are listed nowhere)
  let privileged: LensContract['privileged'] = []
  let primitives: LensContract['primitives'] = []
  let analysis: string | null = null
  if (p.sources.length) {
    const w = new Work()
    try {
      privileged = findPrivileged(p.sources, [...g.write, ...g.payable], w)
      primitives = findPrimitives(p.sources, w)
    } catch (e) {
      if (!(e instanceof AnalysisLimit)) throw e
      // nothing partial is shown: an incomplete list would read as a complete one
      privileged = []
      primitives = []
      analysis = `not completed: ${e.why}`
    }
  }
  return {
    address: r.address,
    name: r.name,
    bytecodeBytes: r.bytecodeBytes,
    codeHash: r.codeHash,
    verified: r.verified?.by === 'sourcify' ? { match: r.verified.match === 'full' ? 'full' : 'partial', compiler: r.verified.compiler } : null,
    deployBlock: p.deployBlock,
    sources: r.sources.map((s) => ({ path: s.path, lang: s.lang, bytes: s.bytes })),
    functions: { write: g.write, payable: g.payable, view: g.view },
    events: g.events,
    privileged,
    primitives,
    analysis,
    profile: p.profile ? { customLines: p.profile.customLines, libraryLines: p.profile.libraryLines, interfaceLines: p.profile.interfaceLines, boilerplate: p.profile.boilerplate } : null,
  }
}

export function buildEvmReport(chain: EvmChain, self: EvmPart, impl: EvmPart | null, c: BuildCommon): LensReport {
  const r = self.read
  const selfC = contractOf(self)
  const implC = impl ? contractOf(impl) : null
  const code = implC ?? selfC
  const proxy = r.proxy
    ? {
        standard: r.proxy.standard,
        label: proxyLabel(r),
        implementation: r.proxy.implementation,
        admin: r.upgradeAuthority,
        // the beacon address as the reader noted it ('… proxy: beacon 0x… → implementation 0x…')
        beacon: r.proxy.standard === 'beacon' ? (r.notes.map((n) => /proxy: beacon (0x[0-9a-fA-F]{40})\b/.exec(n)?.[1]).find(Boolean) ?? null) : null,
      }
    : null
  const evm: LensEvm = { chainId: EVM_CHAIN_IDS[chain], bytecodeBytes: r.bytecodeBytes, codeHash: r.codeHash, proxy, self: selfC, implementation: implC }

  // provenance: every verified file of both contracts against the code index
  const matches: LensProvenanceMatch[] = []
  let checked = 0
  for (const [part, of] of [
    [self, 'self'],
    [impl, 'implementation'],
  ] as const) {
    if (!part) continue
    for (const f of part.sources) {
      checked++
      const hit = c.provenance.lookup(f.text, f.path)
      if (hit) matches.push({ file: f.path, repo: hit.repo, commit: hit.commit, path: hit.path, exact: hit.exact, of })
    }
  }
  const provenance: LensProvenance = { checked, matches, osecRepo: null, index: c.provenance.stats() }

  // primitives: the code's (implementation behind a proxy), else the contract's own
  const primitives = code.primitives.length ? code.primitives : selfC.primitives

  const cites: LensCite[] = [{ label: `${chain === 'ethereum' ? 'Etherscan' : chain === 'base' ? 'Basescan' : 'Arbiscan'}`, url: EXPLORER[chain](r.address) }]
  if (r.verified) cites.push({ label: 'Sourcify', url: sourcifyUrl(chain, r.address) }, { label: 'Sourcify API record', url: sourcifyApiUrl(chain, r.address) })
  if (proxy) cites.push({ label: 'implementation', url: EXPLORER[chain](proxy.implementation) })
  if (impl?.read.verified) cites.push({ label: 'Sourcify (implementation)', url: sourcifyUrl(chain, impl.read.address) }, { label: 'Sourcify API record (implementation)', url: sourcifyApiUrl(chain, impl.read.address) })
  if (proxy?.admin) cites.push({ label: 'proxy admin', url: EXPLORER[chain](proxy.admin) })
  for (const m of matches.slice(0, 3)) {
    const u = repoCommitUrl(m.repo, m.commit)
    if (u) cites.push({ label: `${m.repo}@${(m.commit ?? '').slice(0, 10)}`, url: u })
  }
  if (proxy?.beacon) cites.push({ label: 'beacon', url: EXPLORER[chain](proxy.beacon) })

  const surface = code.functions.write.length + code.functions.payable.length + code.functions.view.length
  const incomplete = !!(selfC.analysis || implC?.analysis)
  const hasAbi = !!(impl?.abiJson ?? self.abiJson)
  const summary: LensSummary = {
    verified: verifiedOf(impl?.read ?? r),
    upgradeable: r.upgradeable,
    authority: r.upgradeAuthority,
    proxy: proxy?.label ?? null,
    surface: hasAbi ? surface : null,
    // the implementation's guarded functions plus the proxy's own (upgradeTo, changeAdmin…): all callable at this address
    privileged: incomplete ? null : self.sources.length || impl?.sources.length ? selfC.privileged.length + (implC?.privileged.length ?? 0) : null,
    primitives: incomplete ? null : primitives.length,
    provenance: matches.length,
    provenanceExact: matches.filter((m) => m.exact).length,
  }
  const notes = [...r.notes, ...(impl ? impl.read.notes.map((n) => `implementation: ${n}`) : []), ...(c.notes ?? [])]
  return {
    v: 1,
    chain,
    address: r.address,
    kind: r.kind,
    name: implC?.name ?? r.name,
    readAt: r.readAt,
    ms: c.ms,
    rpcCalls: c.rpcCalls,
    registryCalls: c.registryCalls,
    summary,
    solana: null,
    evm,
    primitives,
    provenance,
    dataset: c.dataset,
    notes: uniq(notes).slice(0, 40),
    cites,
  }
}
