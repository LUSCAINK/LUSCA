// Storage of the chain agents: what was kept, as SEPIA-1 training data, plus the evaluation rules.
//
//   <data>/chain/items.json                  index: one entry per kept program / contract + read counters
//   <data>/chain/shards/chain-NNNNNN.jsonl.gz training records (ChainRecord), one gzip member per record
//   <data>/chain/reads.gz                     the ChainRead of every kept item, one gzip member each
//   <data>/chain/feed.json                    the newest feed events (written by index.ts via writeJsonAtomic)
//
// Records are appended as whole gzip members (a multi-member gzip file is a valid .gz: zcat and
// zlib read it end to end); items.json is the commit point (tmp + rename). On start, bytes past
// the last indexed record of each file are cut off and index entries pointing past the end of a
// file are dropped, so a crash at any moment leaves a consistent store. Total compressed size is
// capped (LUSCA_CHAIN_MAX_MB, default 100); past the cap nothing more is kept.
//
// Evaluation (evaluateRead):
//   token-mint / not-code   by the kind of account read
//   unverified              no verified source (Sourcify / OtterSec) and no on-chain IDL
//   duplicate               same code hash, or same normalized source bundle, as a kept item
//   boilerplate             EVM token / NFT templates and library-only code (classifyEvmSources)
//   kept                    everything else

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import type { ChainId, ChainIndexItem, ChainRead, FoundVia, Verdict } from '../../shared/chain.ts'
import { REPOS } from '../codebase/repos.ts'
import { TEMPLATE_LINES, TOKEN_SURFACE_LINES, tokenSurface } from './evm-source.ts'

const gzipAsync = promisify(zlib.gzip)

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void

const MB = 1048576
const INDEX_VERSION = 1

export const CHAINS: ChainId[] = ['solana', 'ethereum', 'base', 'arbitrum']

/** Index key: EVM addresses are case-insensitive, Solana (base58) addresses are not. */
export const itemKey = (chain: ChainId, address: string) => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`

export const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

// ─── boilerplate classifier (EVM sources) ────────────────────────────────────

/** Library code: OpenZeppelin, solmate, solady, forge-std, and Uniswap interface files. */
const LIBRARY_PATH_RE = [
  /(^|\/)@openzeppelin(-upgradeable)?\//,
  /(^|\/)openzeppelin-contracts(-upgradeable)?\//,
  /(^|\/)openzeppelin-solidity\//,
  /(^|\/)(@rari-capital\/)?solmate\//,
  /(^|\/)@?solady\//,
  /(^|\/)(forge-std|ds-test)\//,
  /(^|\/)zos-lib\//,
  /(^|\/)erc721a(-upgradeable)?\//,
  /(^|\/)@uniswap\/[^/]+\/contracts\/interfaces\//,
]

/** Library contracts often pasted into flattened single-file sources. */
const LIBRARY_NAMES = new Set(
  (
    'Context Ownable Ownable2Step Owned Auth IERC20 IERC20Metadata IERC20Permit ERC20 ERC20Burnable ERC20Permit ERC20Capped ' +
    'ERC20Pausable ERC20Votes ERC20Snapshot ERC20FlashMint ERC20Wrapper SafeERC20 SafeMath SignedSafeMath Math SignedMath ' +
    'Address Strings ECDSA EIP712 Nonces Counters ReentrancyGuard Pausable AccessControl AccessControlEnumerable IAccessControl ' +
    'IAccessControlEnumerable ERC165 IERC165 ERC721 IERC721 IERC721Metadata IERC721Enumerable ERC721Enumerable ERC721URIStorage ' +
    'ERC721Burnable ERC721Royalty ERC721Pausable IERC721Receiver ERC721Holder ERC721A IERC721A ERC721AQueryable IERC721AQueryable ' +
    'ERC1155 IERC1155 IERC1155MetadataURI IERC1155Receiver ERC1155Supply ERC1155Burnable ERC1155Holder ERC2981 IERC2981 IERC4906 ' +
    'MerkleProof Base64 IUniswapV2Factory IUniswapV2Router01 IUniswapV2Router02 IUniswapV2Pair IUniswapV2ERC20 IDEXRouter IDEXFactory ' +
    'IERC5267 IERC20Errors IERC721Errors IERC1155Errors IERC6372 IVotes Votes Checkpoints Initializable UUPSUpgradeable ERC1967Proxy ' +
    'ERC1967Upgrade ERC1967Utils Proxy TransparentUpgradeableProxy ITransparentUpgradeableProxy ProxyAdmin BeaconProxy UpgradeableBeacon ' +
    'IBeacon StorageSlot IERC1822Proxiable IERC1967 DefaultOperatorFilterer OperatorFilterer IOperatorFilterRegistry ' +
    'UpdatableOperatorFilterer RevokableOperatorFilterer SafeTransferLib FixedPointMathLib LibString SafeCastLib SafeCast ' +
    'EnumerableSet EnumerableMap BitMaps ShortStrings Arrays Multicall Create2 Clones ERC4626 IERC4626 ERC2771Context ' +
    'MessageHashUtils SignatureChecker IERC1271 Panic Errors Hashes TransientSlot ReentrancyGuardTransient ' +
    'AdminUpgradeabilityProxy UpgradeabilityProxy BaseAdminUpgradeabilityProxy BaseUpgradeabilityProxy ' +
    'InitializableAdminUpgradeabilityProxy InitializableUpgradeabilityProxy OwnedUpgradeabilityProxy ZOSLibAddress AddressUtils'
  ).split(/\s+/),
)

/** Bases that make a contract a token / NFT. */
const TOKEN_BASES = new Set(
  (
    'ERC20 ERC20Burnable ERC20Permit ERC20Capped ERC20Votes ERC20Pausable ERC20Snapshot ERC20FlashMint IERC20 IERC20Metadata ' +
    'ERC721 ERC721A ERC721Enumerable ERC721URIStorage ERC721Burnable ERC721Royalty ERC721Pausable ERC721AQueryable IERC721 IERC721A ' +
    'ERC1155 ERC1155Supply ERC1155Burnable IERC1155 OFT ONFT721 ERC404 DN404'
  ).split(/\s+/),
)
/** Tutorial / scaffold contract names (Remix, Hardhat, Foundry templates). */
const SAMPLE_NAMES = new Set(['storage', 'simplestorage', 'lock', 'counter', 'greeter', 'helloworld', 'ballot', 'owner', 'mytoken', 'mynft', 'test', 'testtoken'])
const NFT_BASE_RE = /^(I?ERC721\w*|I?ERC1155\w*|ERC721A\w*|ONFT721|ERC404|DN404)$/

const baseName = (n: string) => n.replace(/Upgradeable$/, '')

/** Remove // and /* *\/ comments (and # comments for Vyper), keeping string literals and line breaks. */
export function stripComments(text: string, vyper = false): string {
  let out = ''
  let i = 0
  const n = text.length
  let chunkStart = 0
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 34 || c === 39) {
      // string literal
      const q = c
      i++
      while (i < n) {
        const d = text.charCodeAt(i)
        if (d === 92) i += 2
        else if (d === q || d === 10) {
          i++
          break
        } else i++
      }
      continue
    }
    if (!vyper && c === 47 && text.charCodeAt(i + 1) === 47) {
      out += text.slice(chunkStart, i)
      while (i < n && text.charCodeAt(i) !== 10) i++
      chunkStart = i
      continue
    }
    if (vyper && c === 35) {
      out += text.slice(chunkStart, i)
      while (i < n && text.charCodeAt(i) !== 10) i++
      chunkStart = i
      continue
    }
    if (!vyper && c === 47 && text.charCodeAt(i + 1) === 42) {
      out += text.slice(chunkStart, i)
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      // keep the line breaks of the comment so line counts stay honest
      for (let k = i; k < stop; k++) if (text.charCodeAt(k) === 10) out += '\n'
      i = stop
      chunkStart = i
      continue
    }
    i++
  }
  return out + text.slice(chunkStart)
}

const countLines = (s: string) => {
  let k = 0
  for (const line of s.split('\n')) if (line.trim()) k++
  return k
}

interface Decl {
  kind: 'contract' | 'library' | 'interface'
  name: string
  bases: string[]
  body: string
}

/** Top-level contract / library / interface declarations of a comment-stripped Solidity file, plus the remaining top-level code. */
function declarations(src: string): { decls: Decl[]; rest: string } {
  const decls: Decl[] = []
  let rest = ''
  let i = 0
  const n = src.length
  const re = /\b(abstract\s+contract|contract|library|interface)\s+([A-Za-z_$][\w$]*)([^{;]*)\{/y
  let last = 0
  while (i < n) {
    const c = src.charCodeAt(i)
    if (c === 34 || c === 39) {
      const q = c
      i++
      while (i < n && src.charCodeAt(i) !== q && src.charCodeAt(i) !== 10) i += src.charCodeAt(i) === 92 ? 2 : 1
      i++
      continue
    }
    // only at a word start
    if ((c === 97 || c === 99 || c === 108 || c === 105) && (i === 0 || !/[\w$]/.test(src[i - 1]))) {
      re.lastIndex = i
      const m = re.exec(src)
      if (m) {
        // find the matching close brace
        let depth = 1
        let j = re.lastIndex
        while (j < n && depth > 0) {
          const d = src.charCodeAt(j)
          if (d === 34 || d === 39) {
            j++
            while (j < n && src.charCodeAt(j) !== d && src.charCodeAt(j) !== 10) j += src.charCodeAt(j) === 92 ? 2 : 1
            j++
            continue
          }
          if (d === 123) depth++
          else if (d === 125) depth--
          j++
        }
        rest += src.slice(last, i)
        const heritage = m[3].match(/\bis\b([\s\S]*)$/)
        const bases = heritage
          ? heritage[1]
              .split(',')
              .map((b) => b.trim().match(/^[A-Za-z_$][\w$.]*/)?.[0] ?? '')
              .filter(Boolean)
              .map((b) => b.split('.').pop()!)
          : []
        const kindWord = m[1].replace(/^abstract\s+/, '') as Decl['kind']
        decls.push({ kind: kindWord, name: m[2], bases, body: src.slice(i, j) })
        i = j
        last = j
        continue
      }
    }
    i++
  }
  rest += src.slice(last)
  return { decls, rest }
}

export interface BoilerplateResult {
  boilerplate: boolean
  reason: string
  /** Non-blank, non-comment lines outside library files and pasted library contracts. */
  customLines: number
  /** Lines of library code (library files + pasted library contracts). */
  libraryLines: number
  libraryFiles: number
  files: number
  tokenLike: boolean
  nftLike: boolean
}

/**
 * Library code plus a little custom code, or a token / NFT template, is boilerplate:
 *   no custom code at all (proxies, library-only bundles)
 *   library code + < 60 custom lines
 *   a token / NFT contract with < 60 custom lines, or < 300 when its ABI shows no protocol surface
 *     (fewer than 3 functions outside the token / ownership / launch vocabulary, no ERC-4626 vault)
 *   a fee-on-transfer token (swap-and-liquify / tax wallet pattern) with < 800 custom lines
 *   an NFT collection (mint price / max supply / base URI) with < 400 custom lines
 */
export function classifyEvmSources(
  sources: { path: string; text: string }[],
  name?: string | null,
  /** Function signatures of the verified ABI ('transfer(address,uint256)'), when known. */
  abiFunctions?: string[] | null,
): BoilerplateResult {
  let customLines = 0
  let libraryLines = 0
  let libraryFiles = 0
  let tokenLike = false
  let nftLike = false
  let custom = ''
  let files = 0
  for (const f of sources) {
    const p = f.path.replace(/\\/g, '/').toLowerCase()
    if (p.endsWith('.json') || p.endsWith('.md') || p.endsWith('.txt')) continue
    files++
    const vyper = p.endsWith('.vy') || p.endsWith('.vyi')
    const text = stripComments(f.text ?? '', vyper)
    if (LIBRARY_PATH_RE.some((re) => re.test(p))) {
      libraryFiles++
      libraryLines += countLines(text)
      continue
    }
    if (vyper) {
      // [ \t]*, not \s*: \s* runs across newlines and backtracks quadratically over a run of blank lines
      const lines = countLines(text.replace(/^[ \t]*(#|@version).*$/gm, ''))
      customLines += lines
      custom += `${text}\n`
      if (/\bdef\s+transfer\s*\(/.test(text) && /\bbalanceOf\b/.test(text)) tokenLike = true
      continue
    }
    const { decls, rest } = declarations(text)
    for (const d of decls) {
      const lines = countLines(d.body)
      if (LIBRARY_NAMES.has(baseName(d.name))) {
        libraryLines += lines
        continue
      }
      customLines += lines
      custom += `${d.body}\n`
      if (d.kind === 'contract') {
        const bases = d.bases.map(baseName)
        if (bases.some((b) => TOKEN_BASES.has(b))) tokenLike = true
        if (bases.some((b) => NFT_BASE_RE.test(b))) nftLike = true
        // a hand-written ERC-20 surface: transfer + balanceOf (function or public mapping) + approve / allowance
        if (/\bfunction\s+transfer\s*\(/.test(d.body) && /\bbalanceOf\b/.test(d.body) && /\b(approve|allowance)\b/.test(d.body)) tokenLike = true
      }
    }
    // free functions, structs, errors, constants; not pragma / import / using lines (line by line:
    // a multi-line regex here backtracks quadratically over runs of blank lines)
    for (const line of rest.split('\n')) {
      const t = line.trim()
      if (t && t !== ';' && !/^(pragma|import|using)\b/.test(t)) customLines++
    }
  }
  if (abiFunctions && abiFunctions.length) {
    const abi = new Set(abiFunctions)
    if (abi.has('transfer(address,uint256)') && abi.has('balanceOf(address)') && (abi.has('approve(address,uint256)') || abi.has('allowance(address,address)'))) tokenLike = true
    if (abi.has('ownerOf(uint256)') && abi.has('safeTransferFrom(address,address,uint256)')) nftLike = true
  }
  if (nftLike) tokenLike = true
  const base = { customLines, libraryLines, libraryFiles, files, tokenLike, nftLike }
  const cname = (name ?? '').trim()
  // a wrapped native token (WETH-style deposit / withdraw) is infrastructure, not a template
  // (bounded gaps: an unbounded [^{;]* rescans the text from every 'function deposit()' it meets)
  const wrapper = /\bfunction\s+deposit\s*\(\s*\)[^{;]{0,200}\bpayable\b/.test(custom) && /\bfunction\s+withdraw\s*\(/.test(custom)
  if (files === 0) return { ...base, boilerplate: false, reason: 'no source files' }
  const libs = libraryLines > 0 ? `library code (${libraryFiles ? `${libraryFiles} file${libraryFiles === 1 ? '' : 's'}` : 'pasted'})` : ''
  if (customLines === 0) return { ...base, boilerplate: true, reason: libs ? `${libs} only, no custom code` : 'no custom code' }
  if (libraryLines > 0 && customLines < TEMPLATE_LINES) return { ...base, boilerplate: true, reason: `${libs} + ${customLines} custom lines` }
  // a token is a template under ~60 custom lines; up to 300 only when its ABI shows nothing beyond
  // the token / ownership / launch vocabulary (sUSDe, rETH, sfrxETH, Dai, USDT are tokens AND protocol code)
  const surface = tokenSurface(abiFunctions)
  const plain = !wrapper && !surface.protocol && (customLines < TEMPLATE_LINES || (customLines < TOKEN_SURFACE_LINES && surface.known))
  if (tokenLike && plain)
    return { ...base, boilerplate: true, reason: `${nftLike ? 'NFT' : 'token'} template: ${customLines} custom lines${libraryFiles ? ` on ${libs}` : ''}` }
  if (/(token|coin|erc20|erc721|erc1155|nft)$/i.test(cname) && plain)
    return { ...base, boilerplate: true, reason: `token template (${cname.slice(0, 60)}): ${customLines} custom lines` }
  if (SAMPLE_NAMES.has(cname.toLowerCase()) && customLines < 80)
    return { ...base, boilerplate: true, reason: `sample contract (${cname}): ${customLines} custom lines` }
  if (customLines < 15) return { ...base, boilerplate: true, reason: `trivial contract: ${customLines} custom lines` }
  const feeSwap =
    /swapExactTokensForETHSupportingFeeOnTransferTokens|swapTokensForEth\s*\(|swapAndLiquify/.test(custom) ||
    (/\baddLiquidityETH\b/.test(custom) && /(marketing|dev|tax)(Wallet|Fee|Address)|_?maxTx(Amount)?|_?maxWallet/i.test(custom))
  if (tokenLike && feeSwap && customLines < 800) return { ...base, boilerplate: true, reason: `fee-on-transfer token template: ${customLines} custom lines` }
  const mintDrop = /\bfunction\s+\w{0,64}mint\w{0,64}\s*\(/i.test(custom) && /max_?supply/i.test(custom) && /base_?(token)?_?uri/i.test(custom)
  if (nftLike && mintDrop && customLines < 400) return { ...base, boilerplate: true, reason: `NFT collection template: ${customLines} custom lines` }
  return { ...base, boilerplate: false, reason: `${customLines} custom lines` }
}

// ─── evaluation ──────────────────────────────────────────────────────────────

export interface Evaluation {
  verdict: Verdict
  reason: string
  /** Not a final answer about this address (a registry could not be asked): worth reading again. */
  retry?: boolean
  boilerplate?: BoilerplateResult
}

export interface EvalExtras {
  /** Verified source texts (EVM). */
  sources?: { path: string; text: string }[]
  sourceBundleHash?: string | null
  /** Full on-chain IDL (Solana). */
  idlJson?: unknown | null
  /** The EVM reader's own boilerplate verdict on the sources (null = reads as protocol code). */
  boilerplate?: string | null
}

/** A non-kept EVM verdict remembered by code hash, so clones of rejected bytecode are not looked up again. */
export interface RejectedCode {
  verdict: 'boilerplate' | 'unverified'
  reason: string
  /** itemKey of the address first judged */
  key: string
  at: number
}

/**
 * Kept item with this code hash / source bundle hash, as its itemKey ('ethereum:0x…'; a bare address
 * is read as one on the same chain), or null. `rejected`: a non-kept verdict for this EVM code hash.
 */
export interface SeenLookup {
  code(hash: string): string | null
  bundle(hash: string): string | null
  rejected?(hash: string): RejectedCode | null
}

/** "0x2222…2222", or "ethereum:0x2222…2222" when the other item is on another chain. */
function otherLabel(other: string, chain: ChainId): { key: string; label: string } {
  const i = other.indexOf(':')
  const oc = i > 0 ? (other.slice(0, i) as ChainId) : chain
  const oa = i > 0 ? other.slice(i + 1) : other
  return { key: itemKey(oc, oa), label: oc === chain ? shortAddr(oa) : `${oc}:${shortAddr(oa)}` }
}

/** Note prefix server/chain/evm.ts writes when a Sourcify record was over the size cap (ABI only). */
const SOURCIFY_TOO_LARGE_RE = /^Sourcify record over 8 MB/
/** Notes server/chain/solana.ts writes for a program with no executable left on-chain. */
const SOL_NO_CODE_RE = /^(program closed|program bytes are empty)/

const fmtKb = (n: number) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

export function sourceBytesOf(read: ChainRead, sources?: { path: string; text: string }[]): number {
  if (sources && sources.length) return sources.reduce((s, f) => s + Buffer.byteLength(f.text ?? '', 'utf8'), 0)
  return read.sources.reduce((s, f) => s + (f.bytes || 0), 0)
}

/** Note prefix server/chain/solana.ts writes when the OtterSec registry could not be asked. */
const OSEC_UNAVAILABLE_RE = /^OtterSec status unavailable/

export function evaluateRead(read: ChainRead, x: EvalExtras, seen: SeenLookup): Evaluation {
  const evm = read.chain !== 'solana'
  if (read.kind === 'token-mint') return { verdict: 'token-mint', reason: 'token mint account, not a program' }
  if (read.kind === 'empty') return { verdict: 'not-code', reason: evm ? 'no contract code at this address' : 'no account at this address' }
  if (read.kind === 'account') {
    if (evm && read.proxy) return { verdict: 'not-code', reason: 'EIP-7702 delegated account · delegate code queued' }
    return { verdict: 'not-code', reason: evm ? 'externally owned account, no code' : 'data account, not an executable program' }
  }

  // a Solana program whose executable is gone (closed, or empty bytes) is not code any more, even
  // when its IDL account is still there
  if (!evm && read.kind === 'program' && !read.codeHash && read.notes.some((n) => SOL_NO_CODE_RE.test(n)))
    return { verdict: 'not-code', reason: 'program closed: no executable on-chain' }

  // the same code as a kept item is a duplicate whatever else is known about it
  const self = itemKey(read.chain, read.address)
  if (read.codeHash) {
    const other = seen.code(read.codeHash)
    if (other) {
      const o = otherLabel(other, read.chain)
      return { verdict: 'duplicate', reason: o.key === self ? 'already kept, code unchanged' : `same ${evm ? 'bytecode' : 'program binary'} as ${o.label}` }
    }
  }

  const sources = x.sources ?? []
  // the same EVM bytecode was already judged boilerplate / unverified (Sourcify not asked again)
  if (evm && read.codeHash && read.verified === null && !sources.length) {
    const r = seen.rejected?.(read.codeHash)
    if (r) {
      const o = otherLabel(r.key, read.chain)
      const queued = read.proxy ? ' · implementation queued' : ''
      return { verdict: r.verdict, reason: o.key === self ? `${r.reason}${queued && !/implementation/.test(r.reason) ? queued : ''}` : `same bytecode as ${o.label} (${r.verdict})${queued}` }
    }
  }

  const hasIdl = read.idl !== null || (x.idlJson !== undefined && x.idlJson !== null)
  // a Sourcify match whose record was over the size cap: the ABI is stored, the files are not
  const abiOnly = evm && read.verified?.by === 'sourcify' && !sources.length && !read.sources.length && read.notes.some((n) => SOURCIFY_TOO_LARGE_RE.test(n))
  const hasSource = read.verified !== null && (read.verified.by === 'osec' || sources.length > 0 || read.sources.length > 0 || abiOnly)
  if (!hasIdl && !hasSource) {
    if (evm && read.proxy?.standard === 'eip1167') return { verdict: 'boilerplate', reason: 'EIP-1167 minimal proxy · implementation queued' }
    if (evm && read.proxy) return { verdict: 'unverified', reason: 'proxy without verified source · implementation queued' }
    if (!evm && read.notes.some((n) => OSEC_UNAVAILABLE_RE.test(n)))
      return { verdict: 'error', reason: 'OtterSec status unavailable, no on-chain IDL', retry: true }
    if (!evm && read.loader && /native/i.test(read.loader)) return { verdict: 'unverified', reason: 'built-in program, no on-chain executable' }
    return { verdict: 'unverified', reason: evm ? 'no verified source on Sourcify' : 'no verified build, no on-chain IDL' }
  }

  if (x.sourceBundleHash) {
    const other = seen.bundle(x.sourceBundleHash)
    if (other) {
      const o = otherLabel(other, read.chain)
      return { verdict: 'duplicate', reason: o.key === self ? 'already kept, sources unchanged' : `same verified sources as ${o.label}` }
    }
  }

  if (evm && sources.length) {
    const queued = read.proxy ? ' · implementation queued' : ''
    const b = classifyEvmSources(sources, read.name, read.abi?.functions ?? null)
    if (b.boilerplate) return { verdict: 'boilerplate', reason: `${b.reason}${queued}`, boilerplate: b }
    // the reader's own profile also models launch / tax controls and proxies; it is not applied to
    // large codebases (≥ 800 custom lines), where an admin function such as blacklist() is common in
    // real protocol code (e.g. a fiat-backed stablecoin)
    if (x.boilerplate && b.customLines < 800)
      return { verdict: 'boilerplate', reason: `${x.boilerplate}${queued && !/implementation/i.test(x.boilerplate) ? queued : ''}`, boilerplate: b }
  }

  const parts: string[] = []
  if (read.verified) parts.push(read.verified.by === 'osec' ? 'OtterSec verified build' : `Sourcify ${read.verified.match ?? ''} match`.replace(/\s+/g, ' '))
  const nFiles = sources.length || read.sources.length
  if (nFiles) parts.push(`${nFiles} source file${nFiles === 1 ? '' : 's'} · ${fmtKb(sourceBytesOf(read, sources))}`)
  else if (abiOnly) parts.push('sources over 8 MB, ABI stored')
  if (hasIdl) {
    const ins = read.idl?.instructions.length
    parts.push(`on-chain IDL${ins !== undefined ? ` · ${ins} instruction${ins === 1 ? '' : 's'}` : ''}`)
  }
  if (read.verified?.by === 'osec' && !nFiles && read.verified.repo) parts.push('source repo recorded')
  return { verdict: 'kept', reason: parts.join(' · ') }
}

// ─── records ─────────────────────────────────────────────────────────────────

/** One training record (a line of a shard). */
export interface ChainRecord {
  v: 1
  chain: ChainId
  address: string
  name: string | null
  kind: ChainRead['kind']
  via: FoundVia
  codeHash: string | null
  sourceBundleHash: string | null
  verified: ChainRead['verified']
  /** Full on-chain IDL JSON (Solana). */
  idl: unknown | null
  /** Full ABI JSON (EVM). */
  abi: unknown | null
  sources: { path: string; lang: string; text: string }[]
  /** Where the source is when it is not stored here (OtterSec-verified programs: repo + commit). */
  sourcesNote: string | null
  securityTxt: Record<string, string> | null
  proxy: ChainRead['proxy']
  upgradeable: boolean | null
  upgradeAuthority: string | null
  lastDeploySlot: number | null
  loader: string | null
  programBytes: number | null
  bytecodeBytes: number | null
  notes: string[]
  readAt: number
}

export interface KeepInput {
  agent: string
  via: FoundVia
  read: ChainRead
  idlJson?: unknown | null
  abiJson?: unknown | null
  sources?: { path: string; text: string }[]
  sourceBundleHash?: string | null
  /** The EVM reader's boilerplate verdict (EvmSourceProfile.boilerplate), when it made one. */
  boilerplate?: string | null
}

interface StoredItem extends ChainIndexItem {
  key: string
  bundleHash: string | null
  shard: string
  off: number
  len: number
  rOff: number
  rLen: number
}

interface Totals {
  reads: number
  rejected: Record<string, number>
  byChain: Record<string, { reads: number; kept: number }>
  agents: Record<string, { reads: number; kept: number; lastAt: number | null }>
}

interface IndexFile {
  version: number
  updatedAt: number
  seq: number
  shard: string | null
  totals: Totals
  items: StoredItem[]
}

export interface ChainStoreSummary {
  reads: number
  kept: number
  rejected: Record<string, number>
  programs: number
  contracts: number
  idls: number
  verified: number
  sourceBytes: number
  byChain: Record<string, { reads: number; kept: number }>
  agents: Record<string, { reads: number; kept: number; lastAt: number | null }>
  bytes: number
  capBytes: number
}

export interface ChainStoreOptions {
  dataDir: string
  log: Log
  /** Total compressed size of shards + reads, MB (default 100). */
  maxMb?: number
  /** Start a new shard past this size (default 8 MB). */
  maxShardBytes?: number
  /** Keep at least this much free disk (default 256 MB). */
  diskReserveBytes?: number
  /** Debounce of items.json saves after a kept item, ms (default 3000). */
  saveDelayMs?: number
  /** Debounce of items.json saves after counter-only changes (rejected reads), ms (default 30000). */
  countSaveDelayMs?: number
  now?: () => number
}

export interface ChainStore {
  /** Evaluate a read, store it when kept, count it. Serialized (two agents never keep the same code twice). */
  process(input: KeepInput): Promise<{ verdict: Verdict; reason: string; item: ChainIndexItem | null; retry?: boolean }>
  /** itemKey of the kept item with this code hash, or null (lets a reader skip a registry lookup). */
  seenCode(hash: string): string | null
  /** A non-kept EVM verdict (boilerplate / unverified) remembered for this code hash, or null. */
  seenRejected(hash: string): RejectedCode | null
  /** The verdict process() would give this read now, without storing or counting anything (Lens preview). */
  evaluate(input: Omit<KeepInput, 'agent' | 'via'>): Evaluation
  /** readAt of the kept item at this address, or null (agents skip re-reading kept code within a week). */
  keptAt(chain: ChainId, address: string): number | null
  /** Count a read that failed (verdict 'error'). */
  countError(agent: string, chain: ChainId): void
  /** Why nothing more can be kept (cap / disk), or null. */
  full(): string | null
  summary(): ChainStoreSummary
  items(q: { chain?: ChainId; limit?: number; cursor?: string }): { items: ChainIndexItem[]; next: string | null }
  item(chain: ChainId, address: string): { item: ChainIndexItem; read: ChainRead } | null
  /** Every training record, in file order (tests and tools). */
  records(): ChainRecord[]
  flush(): void
  close(): Promise<void>
}

/** Write JSON via tmp + rename. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value))
  fs.renameSync(tmp, file)
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** All records of one shard file. */
export function readChainShard(file: string): ChainRecord[] {
  const buf = fs.readFileSync(file)
  if (!buf.length) return []
  const text = zlib.gunzipSync(buf).toString('utf8')
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ChainRecord)
}

/** Non-kept EVM verdicts remembered by code hash at most (≈ 2 MB). */
const REJECTED_MAX = 10_000
const REJECTED_UNVERIFIED_TTL_MS = 24 * 3_600_000

/** owner/name of a GitHub repository URL or 'owner/name' string, lower-cased, or null. */
function repoSlug(repo: string | null | undefined): string | null {
  if (!repo) return null
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repo.trim())
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}
const CODE_INDEX_REPOS = new Set(REPOS.map((r) => r.repo.toLowerCase()))

/** True when the GitHub code index (server/codebase/repos.ts) lists this repository. */
export function inCodeIndex(repo: string | null | undefined): boolean {
  const s = repoSlug(repo)
  return !!s && CODE_INDEX_REPOS.has(s)
}

/** Where the source of a kept item is when its files are not stored here. */
export function sourcesNoteOf(r: ChainRead): string | null {
  const v = r.verified
  if (v?.by === 'osec' && v.repo) {
    const at = v.commit ? `@${v.commit}` : ' (commit not recorded)'
    const idx = inCodeIndex(v.repo) ? '; this repository is also in the GitHub code index' : ''
    return `source at ${v.repo}${at} (OtterSec verified build); source files are not copied here${idx}`
  }
  if (v?.by === 'sourcify' && r.notes.some((n) => SOURCIFY_TOO_LARGE_RE.test(n)))
    return `Sourcify ${v.match ?? ''} match; the source files are over 8 MB and are not stored here (ABI stored)`.replace(/\s+/g, ' ')
  return null
}

const langOfPath = (p: string): string => {
  const ext = p.toLowerCase().split('.').pop() ?? ''
  return ({ sol: 'solidity', vy: 'vyper', vyi: 'vyper', yul: 'yul', json: 'json', rs: 'rust', md: 'markdown', txt: 'text' } as Record<string, string>)[ext] ?? 'text'
}

const emptyTotals = (): Totals => ({ reads: 0, rejected: {}, byChain: {}, agents: {} })

export function createChainStore(o: ChainStoreOptions): ChainStore {
  const log = o.log
  const now = o.now ?? Date.now
  const dir = path.join(o.dataDir, 'chain')
  const shardDir = path.join(dir, 'shards')
  const indexFile = path.join(dir, 'items.json')
  const readsFile = path.join(dir, 'reads.gz')
  const capBytes = Math.max(64 * 1024, Math.round((o.maxMb && o.maxMb > 0 ? o.maxMb : 100) * MB))
  const maxShardBytes = Math.max(64 * 1024, o.maxShardBytes ?? 8 * MB)
  const diskReserve = Math.max(0, o.diskReserveBytes ?? 256 * MB)
  const saveDelayMs = Math.max(0, o.saveDelayMs ?? 3000)
  const countSaveDelayMs = Math.max(0, o.countSaveDelayMs ?? 30_000)

  fs.mkdirSync(shardDir, { recursive: true })

  let seq = 0
  let currentShard: string | null = null
  let totals: Totals = emptyTotals()
  const items = new Map<string, StoredItem>()
  const fileSize = new Map<string, number>() // shard name or 'reads.gz' → bytes
  const seenCode = new Map<string, string>() // codeHash → itemKey of the kept item
  const seenBundle = new Map<string, string>() // source bundle hash → itemKey
  // codeHash → non-kept EVM verdict, LRU (oldest first); 'unverified' rows expire after a day
  const rejectedCode = new Map<string, RejectedCode>()
  let sorted: StoredItem[] | null = null
  let summaryCache: ChainStoreSummary | null = null
  let saveTimer: NodeJS.Timeout | null = null
  let saveDue = Infinity
  let dirty = false
  let chainLock: Promise<unknown> = Promise.resolve()
  let diskCheck = { at: 0, free: Infinity }
  let closed = false

  load()

  function load() {
    let idx: IndexFile | null = null
    if (fs.existsSync(indexFile)) {
      idx = readJson<IndexFile>(indexFile)
      if (!idx || idx.version !== INDEX_VERSION || !Array.isArray(idx.items)) {
        const aside = `${indexFile}.corrupt-${now()}`
        try {
          fs.renameSync(indexFile, aside)
        } catch {
          /* ignore */
        }
        log('warn', `items.json unreadable — moved to ${path.basename(aside)}; starting a fresh chain index`)
        idx = null
      }
    }
    if (idx) {
      seq = Number.isSafeInteger(idx.seq) ? idx.seq : 0
      currentShard = typeof idx.shard === 'string' ? idx.shard : null
      totals = { ...emptyTotals(), ...(idx.totals ?? {}) }
      for (const it of idx.items) if (it && typeof it.key === 'string') items.set(it.key, it)
    }
    // reconcile files with the index: cut uncommitted tails, drop entries past the end of a file
    const committed = new Map<string, number>()
    for (const it of items.values()) {
      committed.set(it.shard, Math.max(committed.get(it.shard) ?? 0, it.off + it.len))
      committed.set('reads.gz', Math.max(committed.get('reads.gz') ?? 0, it.rOff + it.rLen))
    }
    const sizeOf = (f: string) => {
      try {
        return fs.statSync(f).size
      } catch {
        return -1
      }
    }
    const sizes = new Map<string, number>()
    for (const name of safeList(shardDir)) {
      const m = name.match(/^chain-(\d{6})\.jsonl\.gz$/)
      if (!m) {
        if (name.endsWith('.tmp')) rmQuiet(path.join(shardDir, name))
        continue
      }
      seq = Math.max(seq, Number(m[1]))
      sizes.set(name, sizeOf(path.join(shardDir, name)))
    }
    sizes.set('reads.gz', sizeOf(readsFile))
    let dropped = 0
    for (const [key, it] of items) {
      const s = sizes.get(it.shard) ?? -1
      const r = sizes.get('reads.gz') ?? -1
      if (s < it.off + it.len || r < it.rOff + it.rLen) {
        items.delete(key)
        dropped++
      }
    }
    if (dropped) log('warn', `${dropped} chain index entr${dropped === 1 ? 'y points' : 'ies point'} past the end of a file — dropped`)
    // recompute committed ends after drops
    committed.clear()
    for (const it of items.values()) {
      committed.set(it.shard, Math.max(committed.get(it.shard) ?? 0, it.off + it.len))
      committed.set('reads.gz', Math.max(committed.get('reads.gz') ?? 0, it.rOff + it.rLen))
    }
    for (const [name, size] of sizes) {
      if (size < 0) continue
      const end = committed.get(name) ?? 0
      const file = name === 'reads.gz' ? readsFile : path.join(shardDir, name)
      if (end === 0 && name !== 'reads.gz') {
        rmQuiet(file)
        if (currentShard === name) currentShard = null
        continue
      }
      if (size > end) {
        try {
          fs.truncateSync(file, end)
          log('info', `${name}: cut ${size - end} uncommitted bytes`)
        } catch (e) {
          log('warn', `${name}: truncate failed: ${(e as Error).message}`)
        }
      }
      fileSize.set(name, end)
    }
    if (currentShard && !fileSize.has(currentShard)) currentShard = null
    for (const it of items.values()) {
      if (it.codeHash) seenCode.set(it.codeHash, it.key)
      if (it.bundleHash) seenBundle.set(it.bundleHash, it.key)
    }
    if (items.size || totals.reads) log('info', `chain index: ${items.size} kept items, ${totals.reads} reads, ${fmtKb(totalBytes())} on disk`)
  }

  function safeList(d: string): string[] {
    try {
      return fs.readdirSync(d)
    } catch {
      return []
    }
  }

  function rmQuiet(f: string) {
    try {
      fs.rmSync(f, { force: true })
    } catch {
      /* gone */
    }
  }

  function totalBytes(): number {
    let s = 0
    for (const v of fileSize.values()) s += v
    return s
  }

  /** Schedule an items.json save: soon after a kept item, within 30 s after counter-only changes. */
  function changed(itemChanged: boolean) {
    dirty = true
    summaryCache = null
    if (itemChanged) sorted = null
    if (closed) return
    const t = Date.now()
    const due = t + (itemChanged ? saveDelayMs : Math.max(saveDelayMs, countSaveDelayMs))
    if (saveTimer && due >= saveDue) return
    if (saveTimer) clearTimeout(saveTimer)
    saveDue = due
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveDue = Infinity
      if (dirty) save()
    }, due - t)
    saveTimer.unref?.()
  }

  function save() {
    dirty = false
    const idx: IndexFile = { version: INDEX_VERSION, updatedAt: now(), seq, shard: currentShard, totals, items: [...items.values()] }
    try {
      writeJsonAtomic(indexFile, idx)
    } catch (e) {
      dirty = true
      log('error', `items.json save failed: ${(e as Error).message}`)
    }
  }

  function freeDisk(): number {
    const t = now()
    if (t - diskCheck.at < 60_000) return diskCheck.free
    let free = Infinity
    try {
      const s = fs.statfsSync(dir)
      free = Number(s.bavail) * Number(s.bsize)
    } catch {
      /* unknown: do not block */
    }
    diskCheck = { at: t, free }
    return free
  }

  function full(): string | null {
    if (totalBytes() >= capBytes - Math.min(MB, Math.floor(capBytes * 0.01))) return `storage cap reached (${fmtKb(capBytes)})`
    if (freeDisk() < diskReserve) return 'disk space low'
    return null
  }

  function count(agent: string, chain: ChainId, verdict: Verdict) {
    totals.reads++
    const bc = (totals.byChain[chain] ??= { reads: 0, kept: 0 })
    bc.reads++
    const ag = (totals.agents[agent] ??= { reads: 0, kept: 0, lastAt: null })
    ag.reads++
    ag.lastAt = now()
    if (verdict === 'kept') {
      bc.kept++
      ag.kept++
    } else totals.rejected[verdict] = (totals.rejected[verdict] ?? 0) + 1
    changed(verdict === 'kept')
  }

  function getRejected(h: string): RejectedCode | null {
    const r = rejectedCode.get(h)
    if (!r) return null
    if (r.verdict === 'unverified' && now() - r.at > REJECTED_UNVERIFIED_TTL_MS) {
      rejectedCode.delete(h)
      return null
    }
    return r
  }

  /** Remember a non-kept EVM verdict by code hash (boilerplate for good, unverified for a day). */
  function rememberRejected(read: ChainRead, ev: Evaluation) {
    if (read.chain === 'solana' || !read.codeHash) return
    if (ev.verdict !== 'boilerplate' && ev.verdict !== 'unverified') return
    // a verdict taken from the cache is not re-dated (the original keeps its expiry)
    if (rejectedCode.has(read.codeHash) && /^same bytecode as /.test(ev.reason)) return
    rejectedCode.delete(read.codeHash)
    rejectedCode.set(read.codeHash, { verdict: ev.verdict, reason: ev.reason, key: itemKey(read.chain, read.address), at: now() })
    while (rejectedCode.size > REJECTED_MAX) rejectedCode.delete(rejectedCode.keys().next().value!)
  }

  const seen: SeenLookup = {
    code: (h) => seenCode.get(h) ?? null,
    bundle: (h) => seenBundle.get(h) ?? null,
    rejected: getRejected,
  }

  async function append(file: string, name: string, data: Buffer): Promise<number> {
    const off = fileSize.get(name) ?? 0
    await fs.promises.appendFile(file, data)
    fileSize.set(name, off + data.length)
    return off
  }

  async function write(input: KeepInput, ev: Evaluation): Promise<StoredItem> {
    const r = input.read
    const sources = (input.sources ?? []).map((f) => ({
      path: f.path,
      lang: r.sources.find((s) => s.path === f.path)?.lang ?? langOfPath(f.path),
      text: f.text,
    }))
    const sourcesNote = !sources.length ? sourcesNoteOf(r) : null
    const rec: ChainRecord = {
      v: 1,
      chain: r.chain,
      address: r.address,
      name: r.name,
      kind: r.kind,
      via: input.via,
      codeHash: r.codeHash,
      sourceBundleHash: input.sourceBundleHash ?? null,
      verified: r.verified,
      idl: input.idlJson ?? null,
      abi: input.abiJson ?? null,
      sources,
      sourcesNote,
      securityTxt: r.securityTxt,
      proxy: r.proxy,
      upgradeable: r.upgradeable,
      upgradeAuthority: r.upgradeAuthority,
      lastDeploySlot: r.lastDeploySlot,
      loader: r.loader,
      programBytes: r.programBytes,
      bytecodeBytes: r.bytecodeBytes,
      notes: r.notes,
      readAt: r.readAt,
    }
    const recGz = await gzipAsync(Buffer.from(`${JSON.stringify(rec)}\n`, 'utf8'))
    const readGz = await gzipAsync(Buffer.from(`${JSON.stringify(r)}\n`, 'utf8'))
    if (!currentShard || (fileSize.get(currentShard) ?? 0) + recGz.length > maxShardBytes) {
      if (!currentShard || (fileSize.get(currentShard) ?? 0) > 0) {
        seq++
        currentShard = `chain-${String(seq).padStart(6, '0')}.jsonl.gz`
        fileSize.set(currentShard, 0)
      }
    }
    const shard = currentShard!
    const off = await append(path.join(shardDir, shard), shard, recGz)
    const rOff = await append(readsFile, 'reads.gz', readGz)
    const key = itemKey(r.chain, r.address)
    const prev = items.get(key)
    const sourceBytes = sourceBytesOf(r, input.sources)
    const it: StoredItem = {
      chain: r.chain,
      address: r.address,
      name: r.name,
      kind: r.kind,
      via: input.via,
      verifiedBy: r.verified?.by ?? null,
      idl: r.idl !== null || (input.idlJson !== undefined && input.idlJson !== null),
      sourceFiles: sources.length || r.sources.length,
      sourceBytes,
      codeHash: r.codeHash,
      firstSeen: prev?.firstSeen ?? r.readAt,
      readAt: r.readAt,
      key,
      bundleHash: input.sourceBundleHash ?? null,
      shard,
      off,
      len: recGz.length,
      rOff,
      rLen: readGz.length,
    }
    if (prev) {
      if (prev.codeHash && seenCode.get(prev.codeHash) === prev.key) seenCode.delete(prev.codeHash)
      if (prev.bundleHash && seenBundle.get(prev.bundleHash) === prev.key) seenBundle.delete(prev.bundleHash)
    }
    items.set(key, it)
    if (it.codeHash) {
      seenCode.set(it.codeHash, key)
      rejectedCode.delete(it.codeHash)
    }
    if (it.bundleHash) seenBundle.set(it.bundleHash, key)
    void ev
    return it
  }

  function process(input: KeepInput): Promise<{ verdict: Verdict; reason: string; item: ChainIndexItem | null; retry?: boolean }> {
    const run = async () => {
      const ev = evaluateRead(
        input.read,
        { sources: input.sources, sourceBundleHash: input.sourceBundleHash, idlJson: input.idlJson, boilerplate: input.boilerplate },
        seen,
      )
      if (ev.verdict !== 'kept') {
        rememberRejected(input.read, ev)
        count(input.agent, input.read.chain, ev.verdict)
        return { verdict: ev.verdict, reason: ev.reason, item: null, retry: ev.retry }
      }
      const why = full()
      if (why) {
        count(input.agent, input.read.chain, 'error')
        return { verdict: 'error' as Verdict, reason: `${why}: not stored`, item: null }
      }
      try {
        const it = await write(input, ev)
        count(input.agent, input.read.chain, 'kept')
        return { verdict: 'kept' as Verdict, reason: ev.reason, item: toPublic(it) }
      } catch (e) {
        log('error', `chain store write failed: ${(e as Error).message}`)
        count(input.agent, input.read.chain, 'error')
        return { verdict: 'error' as Verdict, reason: 'storage write failed', item: null }
      }
    }
    const p = chainLock.then(run, run)
    chainLock = p.catch(() => {})
    return p
  }

  function toPublic(it: StoredItem): ChainIndexItem {
    return {
      chain: it.chain,
      address: it.address,
      name: it.name,
      kind: it.kind,
      via: it.via,
      verifiedBy: it.verifiedBy,
      idl: it.idl,
      sourceFiles: it.sourceFiles,
      sourceBytes: it.sourceBytes,
      codeHash: it.codeHash,
      firstSeen: it.firstSeen,
      readAt: it.readAt,
    }
  }

  function sortedItems(): StoredItem[] {
    if (!sorted) sorted = [...items.values()].sort((a, b) => b.readAt - a.readAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return sorted
  }

  function summary(): ChainStoreSummary {
    if (summaryCache) return summaryCache
    let programs = 0
    let contracts = 0
    let idls = 0
    let verified = 0
    let sourceBytes = 0
    const byChain: Record<string, { reads: number; kept: number }> = {}
    for (const c of CHAINS) byChain[c] = { reads: totals.byChain[c]?.reads ?? 0, kept: 0 }
    for (const it of items.values()) {
      if (it.kind === 'program') programs++
      else if (it.kind === 'contract') contracts++
      if (it.idl) idls++
      if (it.verifiedBy) verified++
      sourceBytes += it.sourceBytes
      ;(byChain[it.chain] ??= { reads: 0, kept: 0 }).kept++
    }
    summaryCache = {
      reads: totals.reads,
      kept: items.size,
      rejected: { ...totals.rejected },
      programs,
      contracts,
      idls,
      verified,
      sourceBytes,
      byChain,
      agents: JSON.parse(JSON.stringify(totals.agents)),
      bytes: totalBytes(),
      capBytes,
    }
    return summaryCache
  }

  function listItems(q: { chain?: ChainId; limit?: number; cursor?: string }): { items: ChainIndexItem[]; next: string | null } {
    const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50) || 50))
    let all = sortedItems()
    let start = 0
    if (q.cursor) {
      const m = /^(\d{1,16})\.([a-z]+)\.([A-Za-z0-9]{20,64})$/.exec(q.cursor)
      if (m) {
        const at = Number(m[1])
        const key = itemKey(m[2] as ChainId, m[3])
        // first item strictly after (at, key) in (readAt desc, key asc) order
        let lo = 0
        let hi = all.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          const it = all[mid]
          const after = it.readAt < at || (it.readAt === at && it.key > key)
          if (after) hi = mid
          else lo = mid + 1
        }
        start = lo
      }
    }
    if (q.chain) all = all.slice(start).filter((it) => it.chain === q.chain)
    else all = all.slice(start)
    const page = all.slice(0, limit)
    const last = page[page.length - 1]
    const next = page.length === limit && all.length > limit && last ? `${last.readAt}.${last.chain}.${last.address}` : null
    return { items: page.map(toPublic), next }
  }

  function getItem(chain: ChainId, address: string): { item: ChainIndexItem; read: ChainRead } | null {
    const it = items.get(itemKey(chain, address))
    if (!it) return null
    let fd: number | null = null
    try {
      fd = fs.openSync(readsFile, 'r')
      const buf = Buffer.alloc(it.rLen)
      const n = fs.readSync(fd, buf, 0, it.rLen, it.rOff)
      if (n !== it.rLen) return null
      const read = JSON.parse(zlib.gunzipSync(buf, { maxOutputLength: 8 * MB }).toString('utf8')) as ChainRead
      return { item: toPublic(it), read }
    } catch (e) {
      log('warn', `chain read record ${shortAddr(address)} unreadable: ${(e as Error).message}`)
      return null
    } finally {
      if (fd !== null) fs.closeSync(fd)
    }
  }

  function records(): ChainRecord[] {
    const out: ChainRecord[] = []
    const names = safeList(shardDir)
      .filter((n) => /^chain-\d{6}\.jsonl\.gz$/.test(n))
      .sort()
    for (const n of names) out.push(...readChainShard(path.join(shardDir, n)))
    return out
  }

  return {
    process,
    seenCode: (h) => seenCode.get(h) ?? null,
    seenRejected: getRejected,
    evaluate: (input) =>
      evaluateRead(input.read, { sources: input.sources, sourceBundleHash: input.sourceBundleHash, idlJson: input.idlJson, boilerplate: input.boilerplate }, seen),
    keptAt: (chain, address) => items.get(itemKey(chain, address))?.readAt ?? null,
    countError: (agent, chain) => count(agent, chain, 'error'),
    full,
    summary,
    items: listItems,
    item: getItem,
    records,
    flush() {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
        saveDue = Infinity
      }
      if (dirty) save()
    },
    async close() {
      await chainLock.catch(() => {})
      closed = true
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
        saveDue = Infinity
      }
      if (dirty) save()
    },
  }
}
