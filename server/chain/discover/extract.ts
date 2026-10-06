// Program / contract addresses mentioned in pages the web agents kept (dataset.jsonl lines).
//
// Sources inside one page, strongest first:
//   - explorer links: solscan.io / explorer.solana.com / solana.fm (account|address|program|token),
//     etherscan.io, basescan.org, arbiscan.io, *.blockscout.com (address|token). The domain fixes the
//     chain; testnet subdomains / ?cluster=devnet, Solana token pages (mints are not programs) and
//     wallet tabs (#solTransfers …) are dropped.
//   - Anchor `declare_id!("…")` in code samples.
//   - a bare address with program-like words around it. A Solana address must be canonical base58 of
//     32 bytes (with digits and both letter cases, as real keys are); a 0x address must pass its EIP-55
//     checksum when written in mixed case (made-up example addresses usually fail it).
//     The nearest label before the address decides most ("Program ID: X" vs "Mint: X"), the wider
//     window (±200 chars) adds or removes a little; devnet / testnet context drops the mention unless
//     mainnet is named too.
// A bare 0x address gets its chain from explorer links or chain names nearby (and the page host /
// title); with no clue it goes to Ethereum at a lower score.

import { isSolanaAddress } from '../../../shared/base58.ts'
import type { ChainId } from '../../../shared/chain.ts'
import { checksumStatus, toChecksumAddress } from './keccak.ts'
import { isSolanaNative } from './solblock.ts'
import { isSystemAddress } from './evmblock.ts'

export type MentionKind = 'explorer' | 'page' | 'declare_id' | 'context'

export interface WebMention {
  chain: ChainId
  /** Solana: base58 as written; EVM: EIP-55 checksummed */
  address: string
  /** 1 … 8 */
  score: number
  kind: MentionKind
  /** how it was found, e.g. "explorer link on docs.example.org" */
  hint: string
}

export interface ExtractCounters {
  /** devnet / test-network mentions (not mainnet) */
  offMainnet: number
  tokenUrl: number
  wallet: number
  mintLike: number
  native: number
  placeholder: number
  checksum: number
  weak: number
}

export const emptyExtractCounters = (): ExtractCounters => ({ offMainnet: 0, tokenUrl: 0, wallet: 0, mintLike: 0, native: 0, placeholder: 0, checksum: 0, weak: 0 })

const B58 = '1-9A-HJ-NP-Za-km-z'
/** Longest text scanned per page (chars). */
export const MAX_SCAN_CHARS = 300_000
/** Mentions kept per page at most (strongest first). */
export const MAX_MENTIONS_PER_PAGE = 100

const SOL_EXPLORER_RE = new RegExp(
  `\\b(solscan\\.io|explorer\\.solana\\.com|solana\\.fm|orb\\.helius\\.dev|solanabeach\\.io)\\/(account|address|program|token)\\/([${B58}]{32,44})(?![${B58}])([^\\s"'<>()\\[\\]{}]{0,120})`,
  'g',
)
// the subdomain prefix is bounded (≤ 4 labels of ≤ 63 chars): an unbounded (?:label\.)* backtracks
// quadratically over a long whitespace-free dotted run (minified code, version lists)
const EVM_EXPLORER_RE = /\b((?:[a-z0-9-]{1,63}\.){0,4})(etherscan\.io|basescan\.org|arbiscan\.io|blockscout\.com)\/(address|token)\/(0x[0-9a-fA-F]{40})(?![0-9a-zA-Z])([^\s"'<>()[\]{}]{0,80})/gi
const DECLARE_ID_RE = new RegExp(`declare_id!\\s*\\(\\s*"([${B58}]{32,44})"\\s*\\)`, 'g')
const B58_RE = new RegExp(`(?<![${B58}])[${B58}]{32,44}(?![${B58}])`, 'g')
const HEX40_RE = /(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-zA-Z])/g

/** Well-known placeholder program ids (Anchor's template id). */
const SOL_PLACEHOLDERS = new Set(['Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'])
/** Launchpad mint vanity suffixes (pump.fun, letsbonk, Bags, Moonshot): token mints, not programs. */
const MINT_SUFFIX_RE = /(?:pump|bonk|BAGS|moon)$/

const SOL_TESTNET_RE = /\b(?:devnet|testnet|localnet|localhost)\b|127\.0\.0\.1/
const EVM_TESTNET_RE = /sepolia|goerli|holesky|hoodi|rinkeby|ropsten|kovan|testnet|devnet|localhost|127\.0\.0\.1|ganache|hardhat|\banvil\b|arbitrum nova|\bnova\b/
const MAINNET_RE = /\bmainnet/

const SOL_STRONG_RE = /program[ _-]?id|programid|program address|declare_id|upgrade authority|program (?:deploy|show)|deployed (?:to|at)|on-?chain program|\bidl\b|anchor program|verified build|program account/g
const SOL_WEAK_RE = /\bprogram\b|\bprotocol\b/g
const SOL_NEG_RE = /\bmint\b|token (?:address|mint|ca\b)|contract address|\bca\s*[:=]|\bpump\b|pump\.fun|airdrop|wallet|donat|\btips?\b|treasury|holder|presale|\bbuy\b|dexscreener|birdeye|\bsupply\b|market ?cap|\bmcap\b|signer|\bpubkey\b|public key|\bowner\b|state account|token account|\bata\b|\bpda\b|\bpool\b|receiver|recipient|sender|signature|\bpayer\b|fee account|vault account/g

const EVM_STRONG_RE = /contract|proxy|implementation|router|factory|vault|deployed|registry|controller|oracle|bridge|gateway|governor|timelock|staking|\bmarket\b|pool ?manager|entry ?point|\bmodule\b|adapter|aggregator|singleton|diamond|\bhook\b/g
const EVM_WEAK_RE = /address(?:es)?\b|\bpool\b|\bsafe\b|multisig/g
const EVM_NEG_RE = /wallet|\beoa\b|donat|deployer|recipient|\bsender\b|tx ?hash|transaction hash|\bholders?\b|whale|airdrop|exploiter|attacker|hacker|scammer|\bowner\b|\buser\b|\bsigner\b|treasury|dev wallet|\bsend\b|\bfrom:|\bto:/g
const EVM_TOKENISH_RE = /\btoken\b|erc-?20|erc-?721|erc-?1155|\bnfts?\b|\bmeme/

/** Chain names / explorer domains (matched on lowercase text, except the capitalized word "Base"). */
const CHAIN_HIT_RE: { re: RegExp; chain: ChainId; explorer: boolean; raw?: boolean }[] = [
  { re: /(?<![a-z0-9-]\.)\betherscan\.io|\beth\.blockscout\.com/g, chain: 'ethereum', explorer: true },
  { re: /(?<![a-z0-9-]\.)\bbasescan\.org|\bbase\.blockscout\.com/g, chain: 'base', explorer: true },
  { re: /(?<![a-z0-9-]\.)\barbiscan\.io|\barbitrum\.blockscout\.com/g, chain: 'arbitrum', explorer: true },
  { re: /ethereum(?! sepolia| goerli| holesky)|\beth mainnet\b/g, chain: 'ethereum', explorer: false },
  { re: /base\.org|\bbase (?:mainnet|chain|network|l2)\b|\bon base\b|\b8453\b/g, chain: 'base', explorer: false },
  { re: /arbitrum(?! nova| sepolia| goerli)|\barb1\b|\b42161\b/g, chain: 'arbitrum', explorer: false },
  { re: /\bBase\b/g, chain: 'base', explorer: false, raw: true },
]
/** Chains named within this much distance of the nearest one count too (a list "on Base and Arbitrum"). */
const CHAIN_TIE_CHARS = 24
/** A chain name farther than this from the address does not count (explorer links: the whole window). */
const CHAIN_MAX_CHARS = 150
/** Distance added per line break between a chain name and the address (lists: one address per line). */
const LINE_PENALTY = 60

export interface ChainNear {
  chain: ChainId
  /** the nearest hit of that chain is an explorer link within 80 chars */
  explorer: boolean
  /** the nearest hit is a chain label right before the address on the same line ("Arbitrum: 0x…") */
  label: boolean
}

/**
 * Chains named around an address, nearest first. Distance counts characters, plus LINE_PENALTY per
 * line break in between; names after the address count double (labels usually precede values).
 * Only names about as close as the nearest one are taken, so a page listing one address per chain
 * does not send every address to every chain.
 */
export function chainsNear(raw: string, lower: string, p0: number, p1: number): ChainNear[] {
  const best = new Map<ChainId, { d: number; explorer: boolean; label: boolean }>()
  const breaks = (from: number, to: number) => {
    let n = 0
    for (let i = from; i < to; i++) if (lower.charCodeAt(i) === 10) n++
    return n
  }
  for (const h of CHAIN_HIT_RE) {
    const hay = h.raw ? raw : lower
    h.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = h.re.exec(hay))) {
      const a = m.index
      const b = a + m[0].length
      let d: number
      let label = false
      if (a >= p1) d = 2 * (a - p1 + LINE_PENALTY * breaks(p1, a)) + 10
      else if (b <= p0) {
        const nl = breaks(b, p0)
        d = p0 - b + LINE_PENALTY * nl
        label = nl === 0 && p0 - b <= 8 && !h.explorer // 'Arbitrum: 0x…', 'Base - 0x…', 'Arbitrum One: 0x…'
      } else d = 0 // the address sits inside the hit (an explorer URL)
      if (d > CHAIN_MAX_CHARS && !h.explorer) continue
      const cur = best.get(h.chain)
      if (!cur || d < cur.d || (d === cur.d && h.explorer)) best.set(h.chain, { d, explorer: h.explorer, label })
    }
  }
  if (!best.size) return []
  const min = Math.min(...[...best.values()].map((v) => v.d))
  return [...best.entries()]
    .filter(([, v]) => v.d <= min + CHAIN_TIE_CHARS)
    .sort((x, y) => x[1].d - y[1].d)
    .map(([chain, v]) => ({ chain, explorer: v.explorer && v.d <= 80, label: v.label }))
}

/** Chains named by the page itself (host, title, URL). */
function pageChains(pageCtx: string): ChainId[] {
  const out: ChainId[] = []
  for (const h of CHAIN_HIT_RE) {
    if (h.raw) continue
    h.re.lastIndex = 0
    if (h.re.test(pageCtx) && !out.includes(h.chain)) out.push(h.chain)
  }
  return out
}

/** Index just past the last match of `re` in `s` (-1 when none). */
function lastEnd(re: RegExp, s: string): number {
  re.lastIndex = 0
  let end = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    end = m.index + m[0].length
    if (m[0].length === 0) re.lastIndex++
  }
  return end
}

function countDistinct(re: RegExp, s: string, max: number): number {
  re.lastIndex = 0
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) && seen.size < max) seen.add(m[0])
  return seen.size
}

const has = (re: RegExp, s: string) => {
  re.lastIndex = 0
  return re.test(s)
}

/**
 * Label score of the text right before an address: the class of the nearest keyword wins
 * (strong ⇒ +strong, weak ⇒ +weak, negative ⇒ neg). 0 when no keyword.
 */
function nearScore(near: string, strong: RegExp, weak: RegExp, neg: RegExp, w: { strong: number; weak: number; neg: number }): number {
  const s = lastEnd(strong, near)
  const k = lastEnd(weak, near)
  const n = lastEnd(neg, near)
  const best = Math.max(s, k, n)
  if (best < 0) return 0
  if (best === s) return w.strong
  if (best === n) return w.neg
  return w.weak
}

/** Label right after an address ("X — this is the program ID"): the class of the first keyword wins. */
function rightScore(right: string, strong: RegExp, weak: RegExp, neg: RegExp, w: { strong: number; weak: number; neg: number }): number {
  const first = (re: RegExp) => {
    re.lastIndex = 0
    const m = re.exec(right)
    return m ? m.index : Infinity
  }
  const s = first(strong)
  const k = first(weak)
  const n = first(neg)
  const best = Math.min(s, k, n)
  if (best === Infinity) return 0
  if (best === s) return w.strong
  if (best === n) return w.neg
  return w.weak
}

/** Canonical 32-byte base58 that looks like a real key (digits, upper and lower case, no long runs). */
export function plausibleSolana(s: string): boolean {
  return isSolanaAddress(s) && /[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s) && !/(.)\1{5,}/.test(s)
}

/**
 * Placeholder / sentinel 0x addresses: precompile range, one repeated digit (0xEeee… native-asset
 * sentinel, 0xffff…), long non-zero runs, counting sequences. Zero runs are normal (vanity leading
 * zeros such as Seaport / Permit2, OP-stack predeploys 0x4200…0016) and pass.
 */
export function placeholderEvm(lower: string): boolean {
  const b = lower.slice(2)
  return (
    isSystemAddress(lower) ||
    /^(.)\1{39}$/.test(b) ||
    /([1-9a-f])\1{11,}/.test(b) ||
    /1234567890|0123456789|abcdef0123|deadbeef|cafebabe|badc0ffee/.test(b)
  )
}

interface Acc {
  chain: ChainId
  address: string
  score: number
  kind: MentionKind
  n: number
}

export interface ExtractInput {
  text?: string
  url?: string
  title?: string
  host?: string
}

/** Every program / contract mention in one page, merged per (chain, address). Never throws. */
export function extractMentions(input: ExtractInput, counters: ExtractCounters = emptyExtractCounters()): WebMention[] {
  const text = typeof input.text === 'string' ? input.text.slice(0, MAX_SCAN_CHARS) : ''
  const url = typeof input.url === 'string' ? input.url.slice(0, 2048) : ''
  const title = typeof input.title === 'string' ? input.title.slice(0, 500) : ''
  const host = typeof input.host === 'string' ? input.host.slice(0, 200).toLowerCase() : ''
  const pageCtx = `${host} ${title} ${url}`.toLowerCase()
  const acc = new Map<string, Acc>()

  const add = (chain: ChainId, address: string, score: number, kind: MentionKind) => {
    const key = `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`
    const cur = acc.get(key)
    if (!cur) acc.set(key, { chain, address, score, kind, n: 1 })
    else {
      cur.n++
      if (score > cur.score) {
        cur.score = score
        cur.kind = kind
      }
    }
  }

  const solOk = (a: string): boolean => {
    if (isSolanaNative(a)) {
      counters.native++
      return false
    }
    if (SOL_PLACEHOLDERS.has(a) || !isSolanaAddress(a)) {
      counters.placeholder++
      return false
    }
    if (MINT_SUFFIX_RE.test(a)) {
      counters.mintLike++
      return false
    }
    return true
  }

  // Text positions of addresses already handled by a link / declare_id (the bare scans skip them).
  const claimed = new Set<number>()
  const claim = (s: string, m: RegExpExecArray, addr: string) => {
    if (s === text) claimed.add(m.index + m[0].indexOf(addr))
  }

  // ── explorer links (in the text and the page URL itself) ──
  const scanExplorers = (s: string, kind: MentionKind, bonus: number) => {
    SOL_EXPLORER_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = SOL_EXPLORER_RE.exec(s))) {
      const [, , type, addr, tail] = m
      claim(s, m, '/' + addr)
      const t = tail.toLowerCase()
      if (/cluster=(?:devnet|testnet|custom|localnet)/.test(t)) {
        counters.offMainnet++
        continue
      }
      if (type === 'token') {
        counters.tokenUrl++
        continue
      }
      if (/#(?:sol|spl)?transfers|#portfolio|#defiactivities|#balancechanges|#stakeaccounts|#nfts?\b/.test(t)) {
        counters.wallet++
        continue
      }
      if (!solOk(addr)) continue
      const programish = type === 'program' || /#(?:anchorprogramidl|programidl|idl|programs?)\b/.test(t)
      add('solana', addr, (programish ? 4 : 2) + bonus, kind)
    }
    EVM_EXPLORER_RE.lastIndex = 0
    while ((m = EVM_EXPLORER_RE.exec(s))) {
      const sub = m[1].toLowerCase()
      const domain = m[2].toLowerCase()
      const type = m[3].toLowerCase()
      const addr = m[4]
      const t = m[5].toLowerCase()
      claim(s, m, '/' + addr)
      let chain: ChainId | null = null
      if (domain === 'blockscout.com') chain = sub === 'eth.' ? 'ethereum' : sub === 'base.' ? 'base' : sub === 'arbitrum.' ? 'arbitrum' : null
      else if (sub === '' || sub === 'www.') chain = domain === 'etherscan.io' ? 'ethereum' : domain === 'basescan.org' ? 'base' : 'arbitrum'
      if (!chain) {
        if (EVM_TESTNET_RE.test(sub)) counters.offMainnet++
        continue
      }
      const lower = addr.toLowerCase()
      if (placeholderEvm(lower)) {
        counters.placeholder++
        continue
      }
      if (checksumStatus(addr) === 'invalid') {
        counters.checksum++
        continue
      }
      const base = type === 'token' ? 1.5 : 3
      add(chain, toChecksumAddress(lower), base + (/#code\b/.test(t) ? 1 : 0) + bonus, kind)
    }
  }
  scanExplorers(text, 'explorer', 0)
  if (url) scanExplorers(url, 'page', 1.5)

  // ── Anchor declare_id!("…") ──
  DECLARE_ID_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DECLARE_ID_RE.exec(text))) {
    const addr = m[1]
    claim(text, m, '"' + addr)
    if (!solOk(addr)) continue
    const wide = text.slice(Math.max(0, m.index - 200), m.index + m[0].length + 200).toLowerCase()
    if (SOL_TESTNET_RE.test(wide) && !MAINNET_RE.test(wide)) {
      counters.offMainnet++
      continue
    }
    add('solana', addr, 3, 'declare_id')
  }

  // ── bare Solana addresses with program-like context ──
  B58_RE.lastIndex = 0
  while ((m = B58_RE.exec(text))) {
    const a = m[0]
    if (a.length < 32 || claimed.has(m.index - 1)) continue
    if (isSolanaNative(a)) {
      counters.native++
      continue
    }
    if (!plausibleSolana(a)) continue // ordinary long words / hashes: not counted
    if (!solOk(a)) continue
    const start = m.index
    const end = start + a.length
    const near = text.slice(Math.max(0, start - 48), start).toLowerCase()
    const wide = `${text.slice(Math.max(0, start - 200), start)} ${text.slice(end, end + 200)}`.toLowerCase()
    if (SOL_TESTNET_RE.test(wide) && !MAINNET_RE.test(wide)) {
      counters.offMainnet++
      continue
    }
    let s = nearScore(near, SOL_STRONG_RE, SOL_WEAK_RE, SOL_NEG_RE, { strong: 3, weak: 1.5, neg: -3 })
    s += rightScore(text.slice(end, end + 48).toLowerCase(), SOL_STRONG_RE, SOL_WEAK_RE, SOL_NEG_RE, { strong: 2, weak: 1, neg: -1.5 })
    if (has(SOL_STRONG_RE, wide)) s += 1
    else if (has(SOL_WEAK_RE, wide)) s += 0.5
    s -= 0.5 * countDistinct(SOL_NEG_RE, wide, 3)
    if (s < 1.5) {
      counters.weak++
      continue
    }
    add('solana', a, Math.min(5, 1 + s), 'context')
  }

  // ── bare 0x addresses with contract-like context ──
  HEX40_RE.lastIndex = 0
  while ((m = HEX40_RE.exec(text))) {
    const a = m[0]
    if (claimed.has(m.index - 1)) continue
    const lower = a.toLowerCase()
    if (placeholderEvm(lower)) {
      counters.placeholder++
      continue
    }
    if (checksumStatus(a) === 'invalid') {
      counters.checksum++
      continue
    }
    const start = m.index
    const end = start + a.length
    const near = text.slice(Math.max(0, start - 48), start).toLowerCase()
    const ws = Math.max(0, start - 200)
    const winRaw = text.slice(ws, end + 200)
    const win = winRaw.toLowerCase()
    const wide = `${win.slice(0, start - ws)} ${win.slice(end - ws)}`
    if (EVM_TESTNET_RE.test(wide) && !MAINNET_RE.test(wide)) {
      counters.offMainnet++
      continue
    }
    const named = chainsNear(winRaw, win, start - ws, end - ws)
    const viaExplorer = named.some((c) => c.explorer)
    let s = nearScore(near, EVM_STRONG_RE, EVM_WEAK_RE, EVM_NEG_RE, { strong: 2.5, weak: 1.5, neg: -3 })
    s += rightScore(text.slice(end, end + 48).toLowerCase(), EVM_STRONG_RE, EVM_WEAK_RE, EVM_NEG_RE, { strong: 1.5, weak: 0, neg: -1.5 })
    if (viaExplorer) s += 2
    else if (named[0]?.label) s += 1.5 // deployment lists: 'Arbitrum: 0x…'
    if (has(EVM_STRONG_RE, wide)) s += 1
    s -= 0.5 * countDistinct(EVM_NEG_RE, wide, 3)
    if (s < 1.5) {
      counters.weak++
      continue
    }
    let score = Math.min(5, 0.5 + s)
    if (EVM_TOKENISH_RE.test(near)) score *= 0.5
    let chains: { chain: ChainId; f: number }[]
    if (named.length) chains = named.map((c) => ({ chain: c.chain, f: c.explorer ? 1 : 0.9 }))
    else {
      const fromPage = pageChains(pageCtx)
      chains = fromPage.length ? fromPage.map((chain) => ({ chain, f: 0.8 })) : [{ chain: 'ethereum', f: 0.7 }]
    }
    const display = toChecksumAddress(lower)
    for (const c of chains) add(c.chain, display, Math.max(1, score * c.f), 'context')
  }

  const where = host || (url ? safeHost(url) : '')
  const out: WebMention[] = []
  for (const a of acc.values()) {
    const score = Math.min(8, a.score + 0.5 * Math.log2(a.n))
    out.push({ chain: a.chain, address: a.address, score: Math.round(score * 100) / 100, kind: a.kind, hint: hintOf(a.kind, where) })
  }
  out.sort((x, y) => y.score - x.score)
  return out.length > MAX_MENTIONS_PER_PAGE ? out.slice(0, MAX_MENTIONS_PER_PAGE) : out
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function hintOf(kind: MentionKind, where: string): string {
  const what = kind === 'explorer' ? 'explorer link' : kind === 'page' ? 'explorer page' : kind === 'declare_id' ? 'declare_id in code' : 'named in text'
  return where ? `${what} on ${where}` : what
}
