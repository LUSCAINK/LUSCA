// LUSCA MCP: thin tools over code search (server/search), the advisory check (server/advisory) and
// read-the-binary (server/binary). Each one answers from the same stored results the REST API serves
// (no RPC, no new work beyond what /api/search, /api/advisories and /api/binary do for a page view), with
// strict input schemas, bounded answers and a lusca.ink link for every fact.
//
//   lusca_search            grep over kept verified sources and Solana IDLs (literal or regex)
//   lusca_advisories        one kept EVM contract vs OpenZeppelin advisories and solc bugs, one advisory's
//                           contracts, or the totals
//   lusca_binary_interface  the interface recovered from a Solana program's executable, or the census

import type { ChainId } from '../../shared/chain.ts'
import { SEARCH_LANGS, type SearchQuery, type SearchResult } from '../../shared/search.ts'
import { ADVISORY_SCOPE, COMPILER_SCOPE, type AdvisoryItem, type AdvisoryList, type AdvisorySummary } from '../../shared/advisory.ts'
import type { BinaryInterface, BinarySummary } from '../../shared/binary.ts'
import { isSolanaAddress } from '../../shared/base58.ts'
import type { JsonSchema } from './schema.ts'
import { CHAINS, defineTool, ToolError, type McpTool, type ToolContext } from './tools.ts'
import { SourceError, searchParams } from './source.ts'
import { bound, bytes, int, iso, lines, list, nm, pct, safe, srcPath, title } from './format.ts'

const TEXT_MAX = 12_000
const EVM_RE = /^0x[0-9a-fA-F]{40}$/
const EVM_CHAINS = ['ethereum', 'base', 'arbitrum'] as const
const GHSA = '^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$'

const links = (site: string, ...paths: string[]) => [...new Set(paths.filter(Boolean).map((p) => (p.startsWith('http') ? p : site + p)))]
const lensPath = (chain: ChainId, address: string) => `/lens/${chain}/${address}`
const chainCounts = (c: Partial<Record<ChainId, number>>) =>
  CHAINS.filter((k) => c[k])
    .map((k) => `${k} ${int(c[k])}`)
    .join(' · ')

/** A source method this server may not have (feature off), and its refusals as tool errors. */
function need<T>(fn: T | undefined, what: string): T {
  if (!fn) throw new ToolError(`${what} is not available on this server`)
  return fn
}
async function from<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (e) {
    if (e instanceof SourceError) throw new ToolError(e.message, e.retryAfterS)
    throw e
  }
}

// ─── lusca_search ───────────────────────────────────────────────────────────

/** The query a tool call asks for (schema-validated arguments). */
export function searchQueryOf(args: Record<string, unknown>): SearchQuery {
  const q: SearchQuery = { q: String(args.query) }
  if (args.regex === true) q.re = true
  if (args.case_sensitive === true) q.case = true
  if (typeof args.chain === 'string') q.chain = args.chain as ChainId
  if (args.custom_only === true) q.custom = true
  if (typeof args.path === 'string' && args.path.trim()) q.path = args.path.trim()
  if (typeof args.lang === 'string') q.lang = args.lang as SearchQuery['lang']
  if (typeof args.cursor === 'string' && args.cursor) q.cursor = args.cursor
  return q
}

function searchData(r: SearchResult, limit: number, site: string) {
  return {
    query: { q: r.q, regex: r.re, caseSensitive: r.case },
    total: r.total,
    scanned: r.scanned,
    ms: r.ms,
    partial: r.building,
    contracts: r.groups.slice(0, limit).map((g) => ({
      chain: g.item.chain,
      address: g.item.address,
      name: g.item.name,
      url: site + lensPath(g.item.chain, g.item.address),
      files: g.files.slice(0, 3).map((f) => ({
        path: srcPath(f.path),
        lang: f.lang,
        lines: f.lines,
        matches: f.matches,
        sameFileIn: f.shared,
        library: f.library,
        libraryContracts: f.libraryContracts,
        inCodeIndex: f.codeIndex,
        matchLines: f.blocks
          .flat()
          .filter((l) => l.hits.length)
          .slice(0, 4)
          .map((l) => ({ n: l.n, text: safe(l.text, 240) })),
      })),
      moreFiles: Math.max(0, g.files.length - 3),
    })),
    moreContractsOnPage: Math.max(0, r.groups.length - limit),
    idl: r.idl.slice(0, 6).map((h) => ({
      address: h.item.address,
      name: h.item.name,
      sameIdlIn: h.sharedPrograms,
      entries: h.entries.slice(0, 4).map((e) => ({ kind: e.kind, text: safe(e.text, 200) })),
      moreEntries: h.moreEntries + Math.max(0, h.entries.length - 4),
      url: site + lensPath('solana', h.item.address),
    })),
    moreIdlOnPage: Math.max(0, r.idl.length - 6),
    next: r.next,
  }
}

const searchTool = defineTool({
  name: 'lusca_search',
  title: 'Search kept contract source and IDLs',
  description:
    "Grep every verified source file of the EVM contracts LUSCA keeps (Ethereum, Base, Arbitrum) and every kept Solana IDL, literal text or a regular expression. Answers the totals (matching lines, unique files, contracts per chain), the first contracts with their matching lines, and for each file how many kept contracts include that exact file (content hash) — a library copied into hundreds of contracts versus one team's own code. Stored data only; same limits as lusca.ink/search.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 200, description: 'Text to find (2–200 characters), e.g. "delegatecall(" or, with regex, "function\\s+\\w+\\s*\\([^)]*\\)[^{]*onlyOwner"' },
      regex: { type: 'boolean', default: false, description: 'Treat query as a JavaScript regular expression (no backreferences; patterns that can run away are refused)' },
      case_sensitive: { type: 'boolean', default: false, description: 'Case-sensitive (default: case-insensitive)' },
      chain: { type: 'string', enum: CHAINS, description: "Only this chain ('solana' searches IDLs only)" },
      custom_only: { type: 'boolean', default: false, description: 'Leave out library paths (@openzeppelin, lib/, node_modules/ …) and files that are also in the protocol code index' },
      path: { type: 'string', maxLength: 120, description: 'Path filter: plain text = substring of the path; with * or ? = glob (e.g. "*.sol", "src/**")' },
      lang: { type: 'string', enum: SEARCH_LANGS, description: 'solidity, vyper, yul or other' },
      cursor: { type: 'string', maxLength: 200, description: 'next from a previous answer (next page of file results)' },
      limit: { type: 'integer', minimum: 1, maximum: 10, default: 5, description: 'Contracts shown (1–10, default 5); totals always cover the whole index' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  cacheS: 60,
  timeoutMs: 8_000,
  async run(args, ctx: ToolContext) {
    const q = searchQueryOf(args)
    if (q.q.trim().length < 2) throw new ToolError('query must have at least 2 characters besides spaces')
    const limit = (args.limit as number | undefined) ?? 5
    const now = ctx.now()
    const r = await from(need(ctx.source.search, 'code search').call(ctx.source, q, ctx.ip))
    const d = searchData(r, limit, ctx.site)
    const page = `/search?${searchParams({ ...q, cursor: null })}`
    const filt = [q.re ? 'regex' : 'literal', q.case ? 'case-sensitive' : 'case-insensitive', q.chain, q.custom ? 'custom code only' : '', q.path ? `path ${JSON.stringify(safe(q.path, 120))}` : '', q.lang ?? ''].filter(Boolean).join(' · ')
    const t = r.total
    const out = [`Code search: ${JSON.stringify(safe(r.q, 200))} (${filt})`]
    out.push(
      `${t.capped ? 'at least ' : ''}${int(t.matches)} matching line${t.matches === 1 ? '' : 's'} in ${int(t.files)} unique file${t.files === 1 ? '' : 's'}, ${int(t.contracts)} kept contract${t.contracts === 1 ? '' : 's'}${chainCounts(t.chains) ? ` (${chainCounts(t.chains)})` : ''}${t.programs ? ` · ${int(t.programs)} Solana program${t.programs === 1 ? '' : 's'} with a matching IDL entry` : ''} · ${int(r.ms)} ms · scanned ${int(r.scanned.files)} of ${int(r.scanned.ofFiles)} unique files${r.cached ? ' (cached)' : ''}`,
    )
    if (r.building) out.push(`Partial: the index is still being built (${int(r.building.items)}${r.building.of !== null ? ` of ${int(r.building.of)}` : ''} kept items so far); totals will grow.`)
    if (!d.contracts.length && !d.idl.length) out.push(q.cursor ? 'No more results on this page.' : 'No match in the kept sources and IDLs.')
    d.contracts.forEach((g, i) => {
      out.push(`${i + 1}. ${g.chain} · ${title(g.name)} ${g.address}`)
      for (const f of g.files) {
        const shared = f.sameFileIn.contracts > 1 ? ` · this exact file is in ${int(f.sameFileIn.contracts)} kept contracts (${chainCounts(f.sameFileIn.chains)})` : ' · in this contract only'
        const lib = f.library ? ' · library path' : f.libraryContracts ? ` · library path in ${int(f.libraryContracts)}` : ''
        out.push(`   ${f.path} (${int(f.lines)} lines) — ${int(f.matches)} matching line${f.matches === 1 ? '' : 's'}${shared}${lib}${f.inCodeIndex ? ' · also in the protocol code index' : ''}`)
        for (const l of f.matchLines) out.push(`     ${l.n}: ${l.text}`)
      }
      if (g.moreFiles) out.push(`   +${g.moreFiles} more matching file${g.moreFiles === 1 ? '' : 's'} in this contract`)
      out.push(`   ${g.url}`)
    })
    if (d.moreContractsOnPage) out.push(`+${d.moreContractsOnPage} more contracts on this page (raise limit, or open the search link)`)
    if (d.idl.length) {
      out.push(`Solana IDL matches${d.moreIdlOnPage ? ` (first ${d.idl.length})` : ''}:`)
      d.idl.forEach((h, i) => {
        out.push(`${i + 1}. ${title(h.name)} ${h.address}${h.sameIdlIn > 1 ? ` · same IDL in ${int(h.sameIdlIn)} kept programs` : ''}`)
        out.push(`   ${list(h.entries.map((e) => `${e.kind} ${e.text}`), 4, ' · ', h.entries.length + h.moreEntries)}`)
        out.push(`   ${h.url}`)
      })
    }
    if (r.next) out.push(`Next page: call again with cursor ${JSON.stringify(r.next)}`)
    out.push('Source lines are quoted from verified source published by each deployer.')
    const l = links(ctx.site, page, `/api/search?${searchParams(q)}`)
    out.push(`Sources: ${l.join(' · ')}`)
    return { text: bound(lines(out), TEXT_MAX), data: { ...d, links: l, asOf: now } }
  },
})

// ─── lusca_advisories ───────────────────────────────────────────────────────

function advisoryItemText(it: AdvisoryItem, site: string, out: string[]) {
  out.push(`Advisory check · ${it.chain} · ${title(it.name)} ${it.address}`)
  out.push(`checked ${iso(it.checkedAt)} · ${int(it.files)} .sol file${it.files === 1 ? '' : 's'} · ${int(it.ozFiles)} byte-identical to published OpenZeppelin release files`)
  const rel = it.ozReleases.filter((r) => r.label).map((r) => `${r.pkg.replace('@openzeppelin/', '')} ${r.label} (${int(r.files)} files)`)
  if (rel.length) out.push(`OpenZeppelin releases consistent with those files: ${list(rel, 4, ' · ')}`)
  if (!it.advisories.length) out.push('No file from an affected OpenZeppelin release was found in the verified source.')
  else {
    out.push(`Files from an affected OpenZeppelin release (${it.advisories.length} advisor${it.advisories.length === 1 ? 'y' : 'ies'}):`)
    for (const a of it.advisories.slice(0, 12)) {
      out.push(`- ${a.id}${a.aliases.length ? ` (${a.aliases.slice(0, 2).join(', ')})` : ''} · ${a.severity} · ${safe(a.title, 140)} · affected: ${safe(a.label, 80)}`)
      for (const f of a.files.slice(0, 4)) {
        const how = f.method === 'hash' ? `byte-identical to ${f.pkg.replace('@openzeppelin/', '')} ${f.releases}` : `header names ${f.header ? safe(f.header, 40) : 'an affected release'}${f.fix ? ` and ${safe(f.fix, 120)}` : ''}`
        out.push(`    ${srcPath(f.path)}:${f.line}${f.symbol ? ` (${nm(f.symbol)})` : ''} — ${how}`)
      }
      if (a.files.length > 4) out.push(`    +${a.files.length - 4} more files`)
    }
    if (it.advisories.length > 12) out.push(`+${it.advisories.length - 12} more advisories`)
  }
  if (it.solc) {
    const bugs = it.solc.bugs
    out.push(`Compiler: ${safe(it.solc.compiler, 60)}${it.solc.released ? ` (released ${safe(it.solc.released, 20)})` : ''} — ${bugs.length ? `${bugs.length} known bug${bugs.length === 1 ? '' : 's'} listed for this version: ${list(bugs.map((b) => `${b.name} (${b.severity})`), 8)}` : 'no known bug listed for this version'}`)
    if (bugs.length) out.push(`  ${COMPILER_SCOPE}`)
  }
  if (it.notes.length) out.push(`notes: ${it.notes.slice(0, 4).map((n) => safe(n, 200)).join(' · ')}`)
  void site
}

function advisorySummaryText(s: AdvisorySummary, out: string[]) {
  const nc = s.notChecked
  out.push(`Advisory check — ${int(s.checked)} kept EVM contracts checked against every published OpenZeppelin Contracts advisory and the Solidity compiler bug list (updated ${iso(s.updatedAt)})`)
  out.push(`not checked: ${int(nc.vyper)} Vyper · ${int(nc.noSource)} without stored Solidity source${s.progress.running ? ` · a pass is running (${int(s.progress.done)} of ${int(s.progress.total)})` : ''}`)
  out.push(`${int(s.withOz)} (${pct(s.withOz, s.checked)}) contain files byte-identical to a published OpenZeppelin release (${int(s.ozFiles)} files)`)
  const present = s.advisories.filter((a) => a.contracts > 0).sort((a, b) => b.contracts - a.contracts)
  out.push(`${int(s.withAdvisoryFile)} include a file from an affected release, covering ${present.length} of ${s.advisories.length} advisories:`)
  for (const a of present.slice(0, 12)) out.push(`- ${a.id} · ${a.severity} · ${safe(a.title, 120)}: ${int(a.contracts)} contract${a.contracts === 1 ? '' : 's'} (${int(a.byMethod.hash)} byte-identical, ${int(a.byMethod.header)} by header)`)
  if (present.length > 12) out.push(`+${present.length - 12} more advisories`)
  const c = s.compiler
  out.push(`Compiler: ${int(c.known)} contracts with a known solc version; ${int(c.withBugs)} on a version with listed bugs; ${int(c.bySeverity.high ?? 0)} on a version whose list includes a high-severity bug (conditions not checked)`)
  const top = [...c.bugs].sort((a, b) => b.contracts - a.contracts).slice(0, 5)
  if (top.length) out.push(`  most common listed bugs: ${list(top.map((b) => `${b.name} (${b.severity}, ${int(b.contracts)})`), 5)}`)
  out.push(`Data: ${int(s.data.ozVersions)} OpenZeppelin releases, ${int(s.data.ozUniqueFiles)} distinct files (fingerprints ${safe(s.data.fingerprintsAt, 24)}) · advisories reviewed ${safe(s.data.advisoriesReviewedAt, 24)} · ${int(s.data.solcBugs)} solc bugs (${safe(s.data.solcBugsAt, 24)})`)
}

function advisoryListText(l: AdvisoryList, id: string, out: string[]) {
  out.push(`Kept contracts with a file from a release affected by ${id}: ${int(l.total)}${l.items.length < l.total ? ` (first ${l.items.length})` : ''}`)
  l.items.forEach((it, i) => {
    out.push(`${i + 1}. ${it.chain} · ${title(it.name)} ${it.address}${it.solc ? ` · ${safe(it.solc, 40)}` : ''}`)
    for (const f of it.files.slice(0, 3)) out.push(`   ${srcPath(f.path)}:${f.line} — ${f.method === 'hash' ? `byte-identical to ${f.releases}` : `header ${f.header ? safe(f.header, 40) : ''}${f.fix ? `, ${safe(f.fix, 100)}` : ''}`}`)
  })
}

const advisoriesTool = defineTool({
  name: 'lusca_advisories',
  title: 'OpenZeppelin advisories and solc bugs in kept contracts',
  description:
    "LUSCA's check of every kept EVM contract's verified Solidity source against every published OpenZeppelin Contracts security advisory (files byte-identical to an affected release, or an edited file whose header names one and that still has the code the fix changed) and the known bugs of its exact solc version. With chain + address: that contract's matches with file:line evidence. With advisory (a GHSA id): the kept contracts that carry it. With neither: the totals. A match shows code from an affected release is present; whether it matters depends on how the contract uses it.",
  inputSchema: {
    type: 'object',
    properties: {
      chain: { type: 'string', enum: EVM_CHAINS, description: 'ethereum, base or arbitrum (with address)' },
      address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'A kept EVM contract (0x + 40 hex)' },
      advisory: { type: 'string', pattern: GHSA, description: 'A GHSA id, e.g. GHSA-4h98-2769-gh6h: list the kept contracts that carry it' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'Contracts listed for an advisory (1–20, default 10)' },
    },
    additionalProperties: false,
  },
  cacheS: 30,
  async run(args, ctx) {
    const now = ctx.now()
    const out: string[] = []
    const address = typeof args.address === 'string' ? args.address.trim() : null
    const chain = typeof args.chain === 'string' ? (args.chain as ChainId) : null
    const advisory = typeof args.advisory === 'string' ? args.advisory : null
    if (address && advisory) throw new ToolError('ask for one contract (chain + address) or one advisory, not both')
    if (address && !chain) throw new ToolError('address needs its chain (ethereum, base or arbitrum)')
    if (chain && !address && !advisory) throw new ToolError('chain needs an address')
    let data: Record<string, unknown>
    let l: string[]
    if (address && chain) {
      if (!EVM_RE.test(address)) throw new ToolError('address is not an EVM address (0x + 40 hex)')
      const it = await from(need(ctx.source.advisoryGet, 'the advisory check').call(ctx.source, chain, address))
      advisoryItemText(it, ctx.site, out)
      l = links(ctx.site, `${lensPath(it.chain, it.address)}#ln-adv`, `/api/advisories/${it.chain}/${it.address}`, '/advisories')
      data = {
        mode: 'contract',
        chain: it.chain, address: it.address, name: it.name, checkedAt: it.checkedAt, files: it.files, ozFiles: it.ozFiles, ozReleases: it.ozReleases,
        advisories: it.advisories.slice(0, 12).map((a) => ({ id: a.id, aliases: a.aliases, severity: a.severity, title: a.title, url: a.url, affected: a.label, files: a.files.slice(0, 6).map((f) => ({ ...f, path: srcPath(f.path) })) })),
        solc: it.solc ? { version: it.solc.version, compiler: it.solc.compiler, released: it.solc.released, bugs: it.solc.bugs.slice(0, 30).map((b) => ({ name: b.name, severity: b.severity, summary: b.summary, link: b.link })) } : null,
        notes: it.notes.slice(0, 6),
      }
    } else if (advisory) {
      const limit = (args.limit as number | undefined) ?? 10
      const ls = await from(need(ctx.source.advisoryList, 'the advisory check').call(ctx.source, { advisory, limit }))
      advisoryListText(ls, advisory, out)
      l = links(ctx.site, '/advisories', `/api/advisories/items?advisory=${advisory}&limit=${limit}`)
      data = { mode: 'advisory', advisory, total: ls.total, items: ls.items.map((it) => ({ ...it, files: it.files.slice(0, 4).map((f) => ({ ...f, path: srcPath(f.path) })), url: ctx.site + lensPath(it.chain, it.address) })), next: ls.next }
    } else {
      const s = await from(need(ctx.source.advisorySummary, 'the advisory check').call(ctx.source))
      advisorySummaryText(s, out)
      l = links(ctx.site, '/advisories', '/api/advisories/summary')
      data = {
        mode: 'summary',
        checked: s.checked, notChecked: s.notChecked, progress: s.progress, byChain: s.byChain, withOz: s.withOz, ozFiles: s.ozFiles, withAdvisoryFile: s.withAdvisoryFile,
        advisories: s.advisories.map((a) => ({ id: a.id, severity: a.severity, title: a.title, url: a.url, contracts: a.contracts, byMethod: a.byMethod })),
        compiler: { known: s.compiler.known, withBugs: s.compiler.withBugs, bySeverity: s.compiler.bySeverity, bugs: [...s.compiler.bugs].sort((a, b) => b.contracts - a.contracts).slice(0, 12).map((b) => ({ name: b.name, severity: b.severity, contracts: b.contracts, link: b.link })) },
        data: s.data, updatedAt: s.updatedAt,
      }
    }
    out.push(`Scope: ${ADVISORY_SCOPE}`)
    out.push(`Sources: ${l.join(' · ')}`)
    return { text: bound(lines(out), TEXT_MAX), data: { ...data, scope: ADVISORY_SCOPE, links: l, asOf: now } }
  },
})

// ─── lusca_binary_interface ─────────────────────────────────────────────────

const EVIDENCE_KEY =
  'Evidence: log = an "Instruction: <Name>" log string in the executable; log+disc = that string and its Anchor discriminator (sha256 of the name, 8 bytes) both in the executable; dict = an error message of a published IDL found verbatim.'

function binaryText(b: BinaryInterface, out: string[]) {
  const ix = b.instructions
  const confirmed = ix.filter((i) => i.evidence === 'log+disc').length
  out.push(`Recovered interface · solana · ${title(b.name)} ${b.address}`)
  out.push(`read from the ${bytes(b.programBytes)} executable ${iso(b.readAt)} (code hash ${b.codeHash.slice(0, 16)}…) · matched against ${int(b.dictionary.idls)} published IDLs`)
  out.push(`framework: ${b.framework.name}${b.framework.version ? ` ${safe(b.framework.version, 20)}` : ''}${b.programCrate ? ` · program crate ${nm(b.programCrate)}` : ''}`)
  const own = b.crates.filter((c) => !c.toolchain).map((c) => `${c.name} ${c.version}`)
  if (own.length) out.push(`crates: ${list(own, 14)}`)
  out.push(`instructions (${int(ix.length + (b.more?.instructions ?? 0))}, ${int(confirmed)} confirmed by discriminator): ${list(ix.map((i) => `${nm(i.name)} [${i.evidence}]`), 40, ', ', ix.length + (b.more?.instructions ?? 0))}`)
  if (b.accounts.length) out.push(`account types (${int(b.accounts.length + (b.more?.accounts ?? 0))}): ${list(b.accounts.map((a) => nm(a.name)), 24, ', ', b.accounts.length + (b.more?.accounts ?? 0))}`)
  if (b.events.length) out.push(`events (${int(b.events.length + (b.more?.events ?? 0))}): ${list(b.events.map((a) => nm(a.name)), 24, ', ', b.events.length + (b.more?.events ?? 0))}`)
  if (b.errors.length) out.push(`error messages matched to published IDLs (${int(b.errors.length + (b.more?.errors ?? 0))}): ${list(b.errors.map((e) => (e.name ? nm(e.name) : JSON.stringify(safe(e.msg, 80)))), 16, ', ', b.errors.length + (b.more?.errors ?? 0))}`)
  if (b.calls.length) out.push(`instruction discriminators other programs' IDLs name (own handlers or calls to other programs; not counted): ${list(b.calls.map((c) => nm(c.name)), 12, ', ', b.calls.length + (b.more?.calls ?? 0))}`)
  if (b.fragments?.length) out.push(`unconfirmed log fragments (not counted): ${list(b.fragments.map((f) => JSON.stringify(safe(f, 60))), 6, ', ', b.fragments.length + (b.more?.fragments ?? 0))}`)
  if (b.check) {
    const c = b.check
    out.push(
      `check against its own published IDL (read blind): ${int(c.hitInCode ?? c.hit)} of ${int(c.idlInCode ?? c.idlInstructions)} IDL instructions present in the code recovered${c.newerThanIdl ? ` · ${int(c.newerThanIdl)} confirmed in the code, not in the IDL` : ''}${c.notInCode ? ` · ${int(c.notInCode)} IDL instructions not in the code` : ''}`,
    )
  }
  if (b.securityTxt) out.push(`security.txt (published by the deployer): ${list(Object.entries(b.securityTxt).map(([k, v]) => `${nm(k, 32)}=${JSON.stringify(safe(v, 100))}`), 4, ' · ')}`)
  if (b.notes.length) out.push(`notes: ${b.notes.slice(0, 4).map((n) => safe(n, 200)).join(' · ')}`)
  out.push(EVIDENCE_KEY)
}

function binarySummaryText(s: BinarySummary, out: string[]) {
  out.push(`Read the binary — Solana programs without a published IDL, interface recovered from the executable (updated ${iso(s.updatedAt)})`)
  out.push(`${int(s.programs)} Solana programs known · ${int(s.withoutIdl)} without a published IDL · ${int(s.processed)} executables read · ${int(s.withInstructions)} with recovered instructions`)
  out.push(`recovered: ${int(s.instructions)} instructions (${int(s.confirmed)} confirmed by discriminator) · ${int(s.accounts)} account types · ${int(s.errors)} error messages · dictionary of ${int(s.dictionary.idls)} published IDLs`)
  if (s.frameworks.length) out.push(`frameworks: ${list(s.frameworks.map((f) => `${f.name} ${int(f.count)}`), 6)}`)
  const c = s.check
  if (c) {
    out.push(
      `method check on ${int(c.programs)} programs that publish an Anchor IDL, read blind: recall ${c.recall === null ? '—' : `${(c.recall * 100).toFixed(1)}%`} (${int(c.recovered)} recovered; base ${int(c.idlInCode)} IDL instructions present in the code) · precision ${c.precision === null ? '—' : `${(c.precision * 100).toFixed(1)}%`}${c.skipped ? ` · ${int(c.skipped)} skipped (no IDL discriminator in the code)` : ''}`,
    )
  } else out.push('method check: no program with a published IDL read yet')
  if (s.idlBehind.length) out.push(`deployed code that differs from its published IDL: ${list(s.idlBehind.map((p) => `${title(p.name)} ${p.address} (+${p.newer} / −${p.missing} of ${p.idlInstructions})`), 5, '; ')}`)
}

const binaryTool = defineTool({
  name: 'lusca_binary_interface',
  title: 'Interface recovered from a Solana program executable',
  description:
    "For a Solana program (most useful for one that never published an IDL): the instructions, account types, events, error messages, framework and crate versions LUSCA recovered from its deployed executable, each with its evidence (an \"Instruction: <Name>\" log string, its Anchor discriminator found in the code, or an error message matched to a published IDL). Without an address: the census and the blind method check against programs that do publish an IDL. Stored results only.",
  inputSchema: {
    type: 'object',
    properties: {
      address: { type: 'string', minLength: 32, maxLength: 44, pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$', description: 'Solana program id (base58); omit for the census' },
    },
    additionalProperties: false,
  },
  cacheS: 30,
  async run(args, ctx) {
    const now = ctx.now()
    const out: string[] = []
    const address = typeof args.address === 'string' ? args.address.trim() : null
    let data: Record<string, unknown>
    let l: string[]
    if (address) {
      if (!isSolanaAddress(address)) throw new ToolError('address is not a Solana address (base58, 32 bytes)')
      const b = await from(need(ctx.source.binaryGet, 'the binary reader').call(ctx.source, address))
      if (!b) {
        throw new ToolError(
          `no recovered interface for ${address} yet: LUSCA reads the executables of Solana programs its agents, the radar or Lens have seen, in the background under a daily budget. lusca_lens reads the program now (IDL, upgrade authority, syscalls).`,
        )
      }
      binaryText(b, out)
      l = links(ctx.site, `/binary/${b.address}`, `/api/binary/${b.address}`, `${lensPath('solana', b.address)}#ln-iface`)
      data = {
        mode: 'program',
        address: b.address, name: b.name, codeHash: b.codeHash, programBytes: b.programBytes, readAt: b.readAt, via: b.via,
        framework: b.framework, programCrate: b.programCrate, crates: b.crates.slice(0, 40),
        instructions: b.instructions.slice(0, 120), accounts: b.accounts.slice(0, 60), events: b.events.slice(0, 60), errors: b.errors.slice(0, 40).map((e) => ({ name: e.name, msg: safe(e.msg, 160), idls: e.idls })),
        calls: b.calls.slice(0, 30), fragments: (b.fragments ?? []).slice(0, 20).map((f) => safe(f, 80)), more: b.more ?? null,
        check: b.check ?? null, securityTxt: b.securityTxt, notes: b.notes.slice(0, 8), dictionary: b.dictionary,
      }
    } else {
      const s = await from(need(ctx.source.binarySummary, 'the binary reader').call(ctx.source))
      binarySummaryText(s, out)
      l = links(ctx.site, '/binary', '/api/binary/summary')
      data = {
        mode: 'census',
        programs: s.programs, withoutIdl: s.withoutIdl, processed: s.processed, withInstructions: s.withInstructions,
        instructions: s.instructions, confirmed: s.confirmed, accounts: s.accounts, errors: s.errors, calls: s.calls,
        frameworks: s.frameworks, dictionary: s.dictionary, check: s.check, idlBehind: s.idlBehind.slice(0, 10), featured: s.featured, updatedAt: s.updatedAt,
      }
    }
    out.push(`Sources: ${l.join(' · ')}`)
    return { text: bound(lines(out), TEXT_MAX), data: { ...data, links: l, asOf: now } }
  },
})

/** Tools over code search, the advisory check and read-the-binary, in the order tools/list shows them. */
export const CODE_TOOLS: McpTool[] = [searchTool, advisoriesTool, binaryTool]

export type { JsonSchema }
