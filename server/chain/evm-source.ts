// Source-side helpers of the EVM reader: ABI → canonical signatures, source normalization and the
// bundle hash that collapses identical code, and a profile of how much of a verified bundle is the
// author's own implementation (vs. OpenZeppelin / solmate / solady library code and interfaces).
// The profile flags token / NFT templates, trading-control tokens, proxies and sample contracts as
// boilerplate, so the chain index keeps protocol code instead of token noise. Pure functions, no I/O.

import { createHash } from 'node:crypto'

export interface SourceText {
  path: string
  text: string
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

// ─── language ────────────────────────────────────────────────────────────────

/** Language label of a source path (names match the GitHub code index: 'solidity', 'vyper', …). */
export function langOfPath(p: string): string {
  const base = p.split('/').pop() ?? p
  const dot = base.lastIndexOf('.')
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
  switch (ext) {
    case 'sol':
      return 'solidity'
    case 'vy':
    case 'vyi':
      return 'vyper'
    case 'yul':
      return 'yul'
    case 'json':
      return 'json'
    case 'fe':
      return 'fe'
    default:
      return 'text'
  }
}

// ─── ABI ─────────────────────────────────────────────────────────────────────

interface AbiParam {
  type?: unknown
  components?: unknown
}

/** Canonical ABI type: tuples expand to '(t1,t2)' with their array suffix kept ('tuple[]' → '(t1,t2)[]'). */
function canonType(p: AbiParam, depth = 0): string {
  const t = typeof p?.type === 'string' ? p.type : '?'
  if (t.startsWith('tuple') && depth < 16) {
    const comps = Array.isArray(p.components) ? (p.components as AbiParam[]) : []
    return `(${comps.map((c) => canonType(c, depth + 1)).join(',')})${t.slice(5)}`
  }
  return t
}

const sigOf = (e: { name?: unknown; inputs?: unknown }) =>
  `${typeof e.name === 'string' ? e.name : ''}(${(Array.isArray(e.inputs) ? (e.inputs as AbiParam[]) : []).map((p) => canonType(p)).join(',')})`

/** Function and event signatures ('transfer(address,uint256)') of an ABI JSON array, in ABI order, de-duplicated. */
export function abiSignatures(abi: unknown): { functions: string[]; events: string[] } | null {
  if (!Array.isArray(abi)) return null
  const functions = new Set<string>()
  const events = new Set<string>()
  for (const e of abi as { type?: unknown; name?: unknown; inputs?: unknown }[]) {
    if (!e || typeof e !== 'object' || typeof e.name !== 'string' || !e.name) continue
    if (e.type === 'function') functions.add(sigOf(e))
    else if (e.type === 'event') events.add(sigOf(e))
  }
  return { functions: [...functions], events: [...events] }
}

// ─── normalization ───────────────────────────────────────────────────────────

const isIdentCode = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36
const isWsCode = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12

/** End index (exclusive) of a quoted string starting at i (quote char at i). Escapes honored; stops at a newline. */
function stringEnd(text: string, i: number): number {
  const q = text.charCodeAt(i)
  let j = i + 1
  while (j < text.length) {
    const d = text.charCodeAt(j)
    if (d === 92) {
      j += 2
      continue
    }
    if (d === q) return j + 1
    if (d === 10) return j
    j++
  }
  return text.length
}

/**
 * Solidity / Yul text without comments.
 *  'min'   — formatting-insensitive form for hashing: whitespace dropped except one space between two
 *            identifier characters; string literals kept verbatim.
 *  'lines' — line structure kept for counting; string literal contents emptied ("") so braces inside
 *            strings cannot confuse block matching.
 */
export function stripSolidity(text: string, mode: 'min' | 'lines'): string {
  const out: string[] = []
  const n = text.length
  let i = 0
  let run = 0
  let pendingWs = false
  let last = -1
  const flush = (end: number) => {
    if (end > run) {
      out.push(text.slice(run, end))
      last = text.charCodeAt(end - 1)
    }
  }
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 47 && i + 1 < n && (text.charCodeAt(i + 1) === 47 || text.charCodeAt(i + 1) === 42)) {
      flush(i)
      if (text.charCodeAt(i + 1) === 47) {
        const j = text.indexOf('\n', i + 2)
        i = j < 0 ? n : j
      } else {
        const j = text.indexOf('*/', i + 2)
        const end = j < 0 ? n : j + 2
        if (mode === 'lines') {
          // keep the newlines a block comment spans so line counts stay honest
          const nl = text.slice(i, end).split('\n').length - 1
          if (nl > 0) out.push('\n'.repeat(nl))
        }
        i = end
      }
      if (mode === 'min') pendingWs = true
      run = i
      continue
    }
    if (mode === 'min' && isWsCode(c)) {
      flush(i)
      pendingWs = true
      while (i < n && isWsCode(text.charCodeAt(i))) i++
      run = i
      continue
    }
    if (c === 34 || c === 39) {
      flush(i)
      const end = stringEnd(text, i)
      if (mode === 'min') {
        pendingWs = false // a quote is a token boundary: never a space before it
        out.push(text.slice(i, end))
        last = c
      } else {
        out.push(String.fromCharCode(c, c))
        last = c
      }
      i = end
      run = i
      continue
    }
    if (mode === 'min' && pendingWs) {
      if (isIdentCode(last) && isIdentCode(c)) out.push(' ')
      pendingWs = false
    }
    i++
  }
  flush(n)
  return out.join('')
}

/** Vyper text without '#' comments (strings honored), trailing spaces and blank lines. Indentation is kept: it is syntax. */
export function stripVyper(text: string): string {
  const lines: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    let cut = raw.length
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i)
      if (c === 34 || c === 39) {
        i = stringEnd(raw, i) - 1
        continue
      }
      if (c === 35) {
        cut = i
        break
      }
    }
    // trimEnd, not /\s+$/: that regex is quadratic on a long run of spaces inside one line
    const line = raw.slice(0, cut).trimEnd()
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

/** Formatting- and comment-insensitive form of one source file, used for the bundle hash. */
export function normalizeSource(text: string, lang: string): string {
  // bounded: an unbounded [^;]* scans to the end of the file from every 'pragma solidity' with no ';' after it
  if (lang === 'solidity' || lang === 'yul') return stripSolidity(text, 'min').replace(/pragma solidity[^;]{0,256};/g, '')
  if (lang === 'vyper') return stripVyper(text).replace(/^#\s*(@version|pragma)\b.*$/gm, '')
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * sha256 over the sorted (full path, normalized content) pairs, plus the compilation target when
 * known. Re-formatted, re-commented or re-pragma'd copies of the same bundle hash the same; any code
 * change, a moved file, or another contract compiled from the same files (Token and Crowdsale from
 * one flattened file) does not.
 */
export function sourceBundleHash(files: SourceText[], target?: string | null): string | null {
  if (!files.length) return null
  const rows = files
    .map((f) => `${f.path}\n${sha256(normalizeSource(f.text, langOfPath(f.path)))}\n`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const t = typeof target === 'string' ? target.trim() : ''
  return sha256(t ? `target\n${t}\n${rows.join('')}` : rows.join(''))
}

// ─── token surface (shared with server/chain/store.ts classifyEvmSources) ────

/**
 * Function names every token / NFT template exposes: ERC-20 / 721 / 1155 and their common
 * extensions, Ownable, AccessControl, Permit / EIP-712, votes, upgrade hooks. Lower-cased.
 */
const STANDARD_FN = new Set(
  `name symbol decimals totalsupply balanceof transfer transferfrom approve allowance increaseallowance decreaseallowance
  burn burnfrom mint cap pause unpause paused snapshot permit nonces domain_separator eip712domain delegate delegatebysig
  delegates getvotes getpastvotes getpasttotalsupply checkpoints numcheckpoints clock clock_mode flashloan maxflashloan flashfee
  owner getowner renounceownership transferownership pendingowner acceptownership hasrole getroleadmin grantrole revokerole
  renouncerole supportsinterface getrolemember getrolemembercount getrolemembers ownerof safetransferfrom setapprovalforall
  getapproved isapprovedforall tokenuri tokenbyindex tokenofownerbyindex baseuri contracturi royaltyinfo setbaseuri settokenuri
  setcontracturi setdefaultroyalty settokenroyalty uri balanceofbatch safebatchtransferfrom exists initialize upgradeto
  upgradetoandcall proxiableuuid version multicall`.split(/\s+/).filter(Boolean),
)
/** Launch / drop / tax-token admin words: such functions are not protocol surface either. */
const LAUNCH_FN = /mint|sale|price|reveal|withdraw|uri|merkle|whitelist|allowlist|presale|airdrop|supply|royalt|claim|limit|max|fee|tax|wallet|trading|swap|bots?$|blacklist|exclude|include|launch|rescue|stuck/i

export interface TokenSurface {
  /** An ABI was given. */
  known: boolean
  /** Functions outside the token / ownership / launch vocabulary (constants in CAPS excluded). */
  nonStandard: string[]
  /** asset() + totalAssets(): an ERC-4626 vault. */
  erc4626: boolean
  /** deposit() payable + withdraw(uint256): a wrapped native token (WETH-style). */
  wrapper: boolean
  /** Reads as protocol code rather than a token template: several own functions, a vault, or a wrapper. */
  protocol: boolean
}

/** What a token contract does beyond being a token, from its ABI function signatures. */
export function tokenSurface(abiFunctions: string[] | null | undefined): TokenSurface {
  const fns = abiFunctions ?? []
  const set = new Set(fns)
  const own = new Set<string>()
  for (const s of fns) {
    const nm = s.slice(0, Math.max(0, s.indexOf('(')))
    if (!nm || /^[A-Z0-9_]+$/.test(nm) || STANDARD_FN.has(nm.toLowerCase()) || LAUNCH_FN.test(nm)) continue
    own.add(nm)
  }
  const erc4626 = set.has('asset()') && set.has('totalAssets()')
  const wrapper = set.has('deposit()') && set.has('withdraw(uint256)')
  const nonStandard = [...own]
  return { known: fns.length > 0, nonStandard, erc4626, wrapper, protocol: nonStandard.length >= 3 || erc4626 || wrapper }
}

/** Custom lines under which a token / NFT is a template whatever it exposes (the spec's ~60). */
export const TEMPLATE_LINES = 60
/** Up to this many custom lines, a token with no protocol surface in its ABI is still a template. */
export const TOKEN_SURFACE_LINES = 300

// ─── profile / boilerplate ───────────────────────────────────────────────────

/**
 * Paths of library code vendored into verified bundles. Protocol packages (@uniswap, @layerzerolabs,
 * @aave, …) are not here: their own deployments import from them and are protocol code.
 */
const LIBRARY_PATH = /openzeppelin|(^|\/)(@?solmate|@?solady|forge-std|ds-test|erc721a(-upgradeable)?|@thirdweb-dev)(\/|$)/i

/** Contract / library names that are library code when they appear flattened into a single file. */
const LIBRARY_NAMES = new Set(
  `Context ContextUpgradeable Ownable Ownable2Step OwnableUpgradeable Ownable2StepUpgradeable OwnableRoles
  ERC20 ERC20Burnable ERC20Capped ERC20Pausable ERC20Permit ERC20Votes ERC20Snapshot ERC20FlashMint ERC20Wrapper ERC4626
  ERC20Upgradeable ERC20BurnableUpgradeable ERC20PermitUpgradeable ERC20VotesUpgradeable ERC20PausableUpgradeable
  ERC721 ERC721A ERC721AQueryable ERC721ABurnable ERC721Enumerable ERC721URIStorage ERC721Burnable ERC721Royalty ERC721Pausable
  ERC721Upgradeable ERC721EnumerableUpgradeable ERC721URIStorageUpgradeable ERC721AUpgradeable
  ERC1155 ERC1155Supply ERC1155Burnable ERC1155Pausable ERC1155URIStorage ERC1155Upgradeable ERC1155SupplyUpgradeable
  ERC165 ERC165Upgradeable ERC2981 ERC2981Upgradeable EIP712 EIP712Upgradeable Nonces NoncesUpgradeable Votes VotesUpgradeable
  SafeMath SafeMathUpgradeable SignedSafeMath SafeERC20 SafeERC20Upgradeable SafeTransferLib SafeCast SafeCastUpgradeable
  Address AddressUpgradeable AddressUtils Strings StringsUpgradeable LibString Math MathUpgradeable SignedMath FixedPointMathLib
  ECDSA ECDSAUpgradeable MessageHashUtils SignatureChecker MerkleProof MerkleProofLib Counters CountersUpgradeable
  EnumerableSet EnumerableMap BitMaps Checkpoints Arrays StorageSlot ShortStrings Panic Base64 Create2 Clones LibClone
  ReentrancyGuard ReentrancyGuardUpgradeable ReentrancyGuardTransient Pausable PausableUpgradeable
  AccessControl AccessControlUpgradeable AccessControlEnumerable AccessControlEnumerableUpgradeable AccessControlDefaultAdminRules
  Initializable UUPSUpgradeable ERC1967Upgrade ERC1967UpgradeUpgradeable ERC1967Utils ERC1967Proxy TransparentUpgradeableProxy
  ProxyAdmin BeaconProxy UpgradeableBeacon Proxy UpgradeableProxy BaseUpgradeabilityProxy UpgradeabilityProxy
  AdminUpgradeabilityProxy BaseAdminUpgradeabilityProxy InitializableUpgradeabilityProxy InitializableAdminUpgradeabilityProxy
  OwnedUpgradeabilityProxy Proxiable TimelockController ERC2771Context DefaultOperatorFilterer
  OperatorFilterer UpdatableOperatorFilterer RevokableOperatorFilterer RevokableDefaultOperatorFilterer`.split(/\s+/).filter(Boolean),
)

/** Library token implementations a template token inherits. */
const TOKEN_BASES =
  /^(ERC20|ERC20Burnable|ERC20Capped|ERC20Pausable|ERC20Permit|ERC20Votes|ERC20Snapshot|ERC20Upgradeable|ERC20BurnableUpgradeable|ERC20PermitUpgradeable|ERC721|ERC721A|ERC721AQueryable|ERC721Enumerable|ERC721URIStorage|ERC721Burnable|ERC721Royalty|ERC721Upgradeable|ERC721AUpgradeable|ERC1155|ERC1155Supply|ERC1155Burnable|ERC1155Upgradeable|OFT|OFTV2|ONFT721|ERC404|DN404|DN404Mirror)$/

/** Admin functions typical of launch-and-tax tokens (anchored on the whole function name, lower-cased). */
const TRADING_CONTROL =
  /^((open|enable|start)trading|removelimits?|manual(swap|send)|(set|update)max(wallet|tx|txn|transaction)(amount|size|percent)?|excludefrom(fees?|maxtransaction|maxtx)|includeinfees?|(set|update|reduce)(buy|sell)?(fees?|tax(es)?)|(set|update)(buy|sell)(fees?|tax(es)?)|(set|update)swap(tokensatamount|backsettings|enabled|threshold)|swapback|(add|del|remove|set)bots?|(un)?blacklist|setblacklist|(set|update)(marketing|dev|tax|team)wallet|(clear|withdraw|rescue)stuck(eth|tokens?|balance)?|setautomatedmarketmakerpair|disabletransferdelay)$/

const ERC20_CORE = ['totalSupply()', 'balanceOf(address)', 'transfer(address,uint256)', 'transferFrom(address,address,uint256)', 'approve(address,uint256)', 'allowance(address,address)']
const ERC721_CORE = ['ownerOf(uint256)', 'safeTransferFrom(address,address,uint256)', 'setApprovalForAll(address,bool)', 'getApproved(uint256)']
const ERC1155_CORE = ['safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)', 'balanceOfBatch(address[],uint256[])']

/** Sample contracts from Remix / Hardhat / Foundry templates. */
const SAMPLE_PATH = /(^|\/)[1-4]_(Storage|Owner|Ballot)\.sol$/i
const SAMPLE_NAMES = new Set(['Storage', 'SimpleStorage', 'Owner', 'Ballot', 'HelloWorld', 'Greeter', 'Counter', 'Lock', 'MyContract'])

export interface EvmSourceProfile {
  files: number
  libraryFiles: number
  /** Non-blank implementation lines outside library code and interfaces (comments excluded). */
  customLines: number
  libraryLines: number
  interfaceLines: number
  token: 'erc20' | 'erc721' | 'erc1155' | null
  /** The author's contract inherits a library token implementation (OpenZeppelin ERC20, ERC721A, …). */
  tokenBase: boolean
  /** Launch / tax-token admin functions found in the ABI. */
  tradingControls: string[]
  /** Why this bundle is boilerplate, or null when it reads as protocol code. */
  boilerplate: string | null
}

const countLines = (s: string) => {
  let n = 0
  for (const l of s.split('\n')) if (l.trim()) n++
  return n
}

const DECL = /(?:abstract\s+)?(contract|library|interface)\s+([A-Za-z_$][\w$]*)([^{;]*)\{/y

interface SolBlocks {
  custom: number
  library: number
  iface: number
  bases: string[]
}

/** Split one comment-free Solidity file into top-level contract / library / interface blocks and count lines. */
function solidityBlocks(code: string): SolBlocks {
  const r: SolBlocks = { custom: 0, library: 0, iface: 0, bases: [] }
  const outside: string[] = []
  let i = 0
  let seg = 0
  const n = code.length
  while (i < n) {
    const c = code.charCodeAt(i)
    if ((c === 97 || c === 99 || c === 108 || c === 105) && (i === 0 || !isIdentCode(code.charCodeAt(i - 1)))) {
      DECL.lastIndex = i
      const m = DECL.exec(code)
      if (m) {
        // matching close brace of the block body
        let depth = 1
        let j = DECL.lastIndex
        while (j < n && depth > 0) {
          const d = code.charCodeAt(j)
          if (d === 123) depth++
          else if (d === 125) depth--
          j++
        }
        outside.push(code.slice(seg, i))
        const lines = countLines(code.slice(i, j))
        const kind = m[1]
        const name = m[2]
        if (kind === 'interface') r.iface += lines
        else if (LIBRARY_NAMES.has(name)) r.library += lines
        else {
          r.custom += lines
          const isList = /\bis\b([\s\S]*)$/.exec(m[3])
          if (isList) for (const b of isList[1].split(',')) {
            const bn = b.trim().split(/[\s(]/)[0]
            if (bn) r.bases.push(bn)
          }
        }
        i = j
        seg = j
        continue
      }
    }
    i++
  }
  outside.push(code.slice(seg))
  // file-level code outside blocks (free functions, structs, constants, errors) is the author's; pragmas and imports are not
  for (const l of outside.join('\n').split('\n')) {
    const t = l.trim()
    if (t && !/^(pragma|import)\b/.test(t) && t !== ';') r.custom++
  }
  return r
}

/**
 * How much of a verified bundle is the author's own implementation, and whether it is boilerplate:
 * library code only, a sample contract, a thin proxy, a token / NFT on a library template, a token
 * with launch / tax controls, or a few lines on top of library code.
 */
export function profileEvmSources(
  files: SourceText[],
  opts: { abiFunctions?: string[] | null; name?: string | null; proxy?: boolean } = {},
): EvmSourceProfile {
  const p: EvmSourceProfile = { files: files.length, libraryFiles: 0, customLines: 0, libraryLines: 0, interfaceLines: 0, token: null, tokenBase: false, tradingControls: [], boilerplate: null }
  const bases = new Set<string>()
  for (const f of files) {
    const lang = langOfPath(f.path)
    const lib = LIBRARY_PATH.test(f.path)
    if (lib) p.libraryFiles++
    if (lang === 'solidity' || lang === 'yul') {
      const code = stripSolidity(f.text, 'lines')
      if (lib) {
        p.libraryLines += countLines(code)
        continue
      }
      const b = solidityBlocks(code)
      p.customLines += b.custom
      p.libraryLines += b.library
      p.interfaceLines += b.iface
      for (const x of b.bases) bases.add(x)
    } else if (lang === 'vyper') {
      if (lib) p.libraryLines += countLines(stripVyper(f.text))
      else p.customLines += countLines(stripVyper(f.text))
    } else if (lang !== 'json' && lang !== 'text') {
      if (lib) p.libraryLines += countLines(f.text)
      else p.customLines += countLines(f.text)
    }
  }
  p.tokenBase = [...bases].some((b) => TOKEN_BASES.test(b))

  const fns = opts.abiFunctions ?? []
  if (fns.length) {
    const set = new Set(fns)
    if (ERC1155_CORE.every((s) => set.has(s))) p.token = 'erc1155'
    else if (ERC721_CORE.every((s) => set.has(s))) p.token = 'erc721'
    else if (ERC20_CORE.every((s) => set.has(s))) p.token = 'erc20'
    const seen = new Set<string>()
    for (const s of fns) {
      const nm = s.slice(0, s.indexOf('('))
      if (TRADING_CONTROL.test(nm.toLowerCase()) && !seen.has(nm)) {
        seen.add(nm)
        p.tradingControls.push(nm)
      }
    }
  }

  const n = p.customLines
  const tok = p.token ? p.token.toUpperCase().replace('ERC', 'ERC-') : null
  const name = opts.name ?? ''
  // a token is a template under ~60 custom lines; up to 300 only when its ABI shows nothing beyond the
  // token / ownership / launch vocabulary (sUSDe, rETH, sfrxETH, Dai, USDT are tokens AND protocol code)
  const surface = tokenSurface(fns)
  const plain = n < TEMPLATE_LINES || (n < TOKEN_SURFACE_LINES && surface.known && !surface.protocol)
  // "library template" only when a library file is really in the bundle (a pasted contract named ERC20 may be the author's own)
  const onBase = p.libraryFiles > 0 ? 'on a library template' : 'on a standard token base'
  if (!files.length) p.boilerplate = null
  else if (n === 0) p.boilerplate = 'library code only, no custom implementation'
  else if (files.some((f) => SAMPLE_PATH.test(f.path)) || (SAMPLE_NAMES.has(name) && n < 80)) p.boilerplate = `sample contract (${name || 'template'}), ${n} custom lines`
  else if (opts.proxy && n < 200) p.boilerplate = `proxy contract, ${n} custom lines; the implementation is read separately`
  else if (tok && p.tradingControls.length >= 2 && n < 2000) p.boilerplate = `${tok} token with launch/tax controls (${p.tradingControls.slice(0, 4).join(', ')})`
  else if (tok && p.tokenBase && plain && !surface.wrapper) p.boilerplate = `${tok} token ${onBase}, ${n} custom lines`
  else if (tok && !p.tokenBase && !surface.wrapper && (n < 40 || (n < TOKEN_SURFACE_LINES && surface.known && !surface.protocol)))
    p.boilerplate = `${tok} token, ${n} custom lines`
  else if (!tok && /(token|coin|erc20|erc721|erc1155|nft)$/i.test(name) && plain) p.boilerplate = `token template (${name}), ${n} custom lines`
  else if ((p.libraryLines > 0 || p.tokenBase) && n < 60) p.boilerplate = `library code plus ${n} custom lines`
  else if (n < 15) p.boilerplate = `trivial contract, ${n} custom lines`
  return p
}
