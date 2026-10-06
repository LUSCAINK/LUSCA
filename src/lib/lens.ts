// LUSCA Lens on the client: address-format detection, REST helpers for /api/lens/*, and the link
// helpers the dossier uses. Every number on the page comes from the server's report; the browser
// reads nothing from a chain itself.
import type { ChainId } from '@shared/chain'
import type { LensAnswer, LensDetect, LensRecent, LensReport, LensStatus } from '@shared/lens'

export type LensInput = { kind: 'solana'; address: string } | { kind: 'evm'; address: string } | { kind: 'invalid'; why: string } | { kind: 'empty' }

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM = /^0x[0-9a-fA-F]{40}$/

/** What the pasted text looks like (format only; the server validates for real). */
export function classify(raw: string): LensInput {
  const s = raw.trim()
  if (!s) return { kind: 'empty' }
  if (EVM.test(s)) return { kind: 'evm', address: s }
  if (B58.test(s)) return { kind: 'solana', address: s }
  if (/^0x/i.test(s)) return { kind: 'invalid', why: `an EVM address is 0x and 40 hex characters (${Math.max(0, s.length - 2)} given)` }
  return { kind: 'invalid', why: 'not a Solana address (base58, 32–44 characters) or an EVM address (0x + 40 hex)' }
}

export class LensHttpError extends Error {
  readonly status: number
  readonly retryAfter: number | null
  constructor(status: number, message: string, retryAfter: number | null) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal, headers: { accept: 'application/json' } })
  const text = await r.text()
  let j: unknown = null
  try {
    j = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  if (!r.ok) {
    const msg = (j as { error?: string } | null)?.error ?? `HTTP ${r.status}`
    const ra = Number(r.headers.get('retry-after'))
    throw new LensHttpError(r.status, msg, Number.isFinite(ra) && ra > 0 ? ra : null)
  }
  return j as T
}

export const fetchLens = (chain: ChainId, address: string, signal?: AbortSignal) =>
  getJson<LensAnswer>(`/api/lens/${chain}/${encodeURIComponent(address)}`, signal)
export const fetchDetect = (address: string, signal?: AbortSignal) => getJson<LensDetect>(`/api/lens/detect/${encodeURIComponent(address)}`, signal)
export const fetchStatus = (signal?: AbortSignal) => getJson<LensStatus>('/api/lens/status', signal)
export const fetchRecent = (signal?: AbortSignal) => getJson<{ reads: number; recent: LensRecent[] }>('/api/lens/recent', signal)

// ─── links ──────────────────────────────────────────────────────────────────

export const explorerUrl = (chain: ChainId, a: string) =>
  chain === 'solana'
    ? `https://explorer.solana.com/address/${a}`
    : chain === 'ethereum'
      ? `https://etherscan.io/address/${a}`
      : chain === 'base'
        ? `https://basescan.org/address/${a}`
        : `https://arbiscan.io/address/${a}`

export const explorerName = (chain: ChainId) => (chain === 'solana' ? 'Solana Explorer' : chain === 'ethereum' ? 'Etherscan' : chain === 'base' ? 'Basescan' : 'Arbiscan')

export const slotUrl = (slot: number) => `https://explorer.solana.com/block/${slot}`
export const blockUrl = (chain: ChainId, n: number) =>
  chain === 'ethereum' ? `https://etherscan.io/block/${n}` : chain === 'base' ? `https://basescan.org/block/${n}` : `https://arbiscan.io/block/${n}`

export const sourcifyUrl = (chainId: number, a: string) => `https://repo.sourcify.dev/${chainId}/${a}`

export const repoSlug = (repo: string) => repo.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/, '')

/**
 * A repository at a commit as a cite: GitHub slugs link to the tree at that commit; another host's
 * https URL is linked as given and labelled with its host name; anything else gets no link.
 */
export function repoLink(repo: string, commit: string | null): { href: string; label: string } | null {
  const slug = repoSlug(repo)
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) return { href: `https://github.com/${slug}${commit && /^[0-9a-f]{7,64}$/i.test(commit) ? `/tree/${commit}` : ''}`, label: 'GitHub' }
  if (!/^https:\/\/[^\s"'<>]+$/i.test(repo)) return null
  try {
    return { href: repo, label: new URL(repo).hostname }
  } catch {
    return null
  }
}

/** github.com/<repo>/blob/<commit>/<path>#L<line> (line only when the files are byte-identical). */
export function repoFileUrl(repo: string, commit: string | null, path: string, line?: number | null) {
  return `https://github.com/${repoSlug(repo)}/blob/${commit ?? 'HEAD'}/${path.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}`
}

/**
 * Where a verified file can be read at a line: the code-index repository when the file is
 * byte-identical there, else the Sourcify copy of the contract.
 */
export function fileLink(r: LensReport, file: string, line: number | null): { url: string; label: string } {
  const m = r.provenance.matches.find((x) => x.file === file)
  if (m) return { url: repoFileUrl(m.repo, m.commit, m.path, m.exact ? line : null), label: `${m.repo}@${(m.commit ?? '').slice(0, 7)}` }
  const ev = r.evm
  const addr = ev?.implementation?.sources.some((s) => s.path === file) ? ev.implementation.address : r.address
  return { url: sourcifyUrl(ev?.chainId ?? 1, addr), label: 'Sourcify' }
}

export const short = (a: string | null | undefined, n = 4) => (!a ? '—' : a.length > n * 2 + 3 ? `${a.slice(0, n + (a.startsWith('0x') ? 2 : 0))}…${a.slice(-n)}` : a)

export const fmtBytes = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`

export const fmtN = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'))

/** Example addresses: well-known deployments, each read end to end before being listed here. */
export const EXAMPLES: { chain: ChainId; address: string; label: string; note: string }[] = [
  { chain: 'solana', address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', label: 'Jupiter v6', note: 'aggregator · on-chain IDL' },
  { chain: 'solana', address: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', label: 'Raydium CPMM', note: 'AMM · program-metadata IDL' },
  { chain: 'solana', address: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', label: 'Orca Whirlpool', note: 'concentrated liquidity' },
  { chain: 'solana', address: 'SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7', label: 'Light System', note: 'Poseidon · BN254 syscalls' },
  { chain: 'solana', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', label: 'SPL Token', note: 'OtterSec verified build' },
  { chain: 'ethereum', address: '0x1F98431c8aD98523631AE4a59f267346ea31F984', label: 'Uniswap v3 Factory', note: 'byte-identical to v3-core' },
  { chain: 'ethereum', address: '0x000000000004444c5dc75cB358380D2e3dE08A90', label: 'Uniswap v4 PoolManager', note: 'singleton · ERC-6909' },
  { chain: 'ethereum', address: '0x000000000022D473030F116dDEE9F6B43aC78BA3', label: 'Permit2', note: 'signatures · no admin' },
  { chain: 'ethereum', address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', label: 'Lido stETH', note: 'EIP-897 proxy · Aragon roles' },
  { chain: 'ethereum', address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', label: 'Morpho Blue', note: 'Sourcify full match' },
  { chain: 'ethereum', address: '0x00000000219ab540356cBB839Cbe05303d7705Fa', label: 'Beacon deposit', note: 'SHA-256 Merkle tree' },
  { chain: 'base', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', label: 'USDC on Base', note: 'proxy → FiatTokenV2_2' },
  { chain: 'arbitrum', address: '0x489ee077994B6658eAfA855C308275EAd8097C4A', label: 'GMX Vault', note: 'perpetuals vault' },
]
