// LUSCA MCP tools: a registry of read-only tools over LUSCA's live chain intelligence.
//
// Each tool: a strict JSON input schema, MCP annotations, and a run() that reads through an McpSource and
// returns a short text answer (what a model quotes) plus structured data (what a program parses), with a
// lusca.ink link for every fact. Answers are bounded (text ≤ 12 KB, lists capped).
//
// Adding a tool (integrator): write `defineTool({ name, title, description, inputSchema, run })` in a new
// module and `registry.add(thatTool)` where the registry is created (server/mcp/index.ts createMcp).

import type { ChainEvent, ChainId, ScanCall, Verdict } from '../../shared/chain.ts'
import { RADAR_KINDS, type RadarEvent, type RadarKind, type RadarSide } from '../../shared/radar.ts'
import { diffable } from '../../shared/radarDiff.ts'
import { CONTROL_CLASSES, type ControlClass, type ControlEntry } from '../../shared/control.ts'
import type { LensReport } from '../../shared/lens.ts'
import { isSolanaAddress } from '../../shared/base58.ts'
import { isOnCurve } from '../control/curve.ts'
import type { JsonSchema } from './schema.ts'
import { SourceError, type McpSource } from './source.ts'
import { ago, bound, bytes, DASH, int, iso, list, pct, yesNo } from './format.ts'

export const CHAINS: readonly ChainId[] = ['solana', 'ethereum', 'base', 'arbitrum']
const VERDICTS: readonly Verdict[] = ['kept', 'duplicate', 'boilerplate', 'unverified', 'token-mint', 'not-code', 'error']
const EVM_RE = /^0x[0-9a-fA-F]{40}$/
export const RADAR_ID_RE = /^[a-z]{3}-[a-z0-9]{6,20}$/
const TEXT_MAX = 12_000

export interface ToolContext {
  source: McpSource
  /** Client address (Lens keys its per-address limits on it). */
  ip: string
  /** Public origin for links, e.g. https://lusca.ink. */
  site: string
  now: () => number
}

export interface ToolOutput {
  text: string
  data: Record<string, unknown>
}

export interface ToolAnnotations {
  title?: string
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint: boolean
}

export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema & { type: 'object' }
  outputSchema?: JsonSchema & { type: 'object' }
  annotations: ToolAnnotations
  /** Seconds a successful answer is reused for the same arguments (0 = never). */
  cacheS: number
  /** Longer limit than the core default (Lens: a fresh read can take up to its own 60 s timeout). */
  timeoutMs?: number
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>
}

/** A refusal the model should see as a tool error (bad address for the chain, not found, rate limited …). */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly retryAfterS: number | null = null,
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

/** Every tool's structured answer carries these two fields; outputSchema says so. */
const BASE_OUTPUT: JsonSchema & { type: 'object' } = {
  type: 'object',
  properties: {
    links: { type: 'array', items: { type: 'string' }, description: 'lusca.ink pages and API answers that hold these facts' },
    asOf: { type: 'integer', description: 'When this answer was made (ms since epoch)' },
  },
  required: ['links', 'asOf'],
}

export function defineTool(t: Omit<McpTool, 'annotations' | 'cacheS' | 'outputSchema'> & { annotations?: Partial<ToolAnnotations>; cacheS?: number; outputSchema?: McpTool['outputSchema'] }): McpTool {
  return {
    ...t,
    outputSchema: t.outputSchema ?? BASE_OUTPUT,
    cacheS: t.cacheS ?? 5,
    annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, ...t.annotations },
  }
}

export interface ToolRegistry {
  add(t: McpTool): void
  get(name: string): McpTool | undefined
  list(): McpTool[]
}

export function createRegistry(tools: McpTool[] = []): ToolRegistry {
  const m = new Map<string, McpTool>()
  const reg: ToolRegistry = {
    add(t) {
      if (!/^[a-z][a-z0-9_]{1,63}$/.test(t.name)) throw new Error(`bad tool name ${t.name}`)
      if (m.has(t.name)) throw new Error(`tool ${t.name} registered twice`)
      m.set(t.name, t)
    },
    get: (name) => m.get(name),
    list: () => [...m.values()],
  }
  for (const t of tools) reg.add(t)
  return reg
}

// ─── shared schema parts ────────────────────────────────────────────────────

const chainSchema: JsonSchema = { type: 'string', enum: CHAINS, description: 'solana, ethereum, base or arbitrum' }
const addressSchema: JsonSchema = {
  type: 'string',
  minLength: 32,
  maxLength: 44,
  pattern: '^([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$',
  description: 'Solana program id (base58) or EVM contract address (0x + 40 hex)',
}
const target = (extra: Record<string, JsonSchema> = {}): JsonSchema & { type: 'object' } => ({
  type: 'object',
  properties: { chain: chainSchema, address: addressSchema, ...extra },
  required: ['chain', 'address'],
  additionalProperties: false,
})

function targetOf(args: Record<string, unknown>): { chain: ChainId; address: string } {
  const chain = args.chain as ChainId
  const address = String(args.address).trim()
  if (chain === 'solana' ? !isSolanaAddress(address) : !EVM_RE.test(address)) {
    throw new ToolError(chain === 'solana' ? 'address is not a Solana address (base58, 32 bytes)' : `address is not an EVM address (0x + 40 hex) — ${chain} takes EVM addresses`)
  }
  return { chain, address }
}

const sameAddr = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && (a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b)

/** Run a source call; its refusals become tool errors the model can read. */
async function from<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (e) {
    if (e instanceof SourceError) throw new ToolError(e.message, e.retryAfterS)
    throw e
  }
}

const links = (site: string, ...paths: string[]) => [...new Set(paths.filter(Boolean).map((p) => (p.startsWith('http') ? p : site + p)))]
const lensPath = (chain: ChainId, address: string) => `/lens/${chain}/${address}`

/** How an event was caught, without endpoint names ('eth_getLogs · <endpoint>' → 'eth_getLogs'). */
export function viaText(v: string): string {
  const parts = v.split(' · ').filter((x) => !/public|node/i.test(x))
  return parts.join(' · ') || 'chain RPC'
}

// ─── trace summary (chain feed, radar events) ───────────────────────────────

export function traceSummary(trace: ScanCall[] | undefined, more = 0) {
  if (!trace?.length) return null
  const ok = trace.filter((c) => c.ok).length
  const wall = trace.reduce((m, c) => Math.max(m, c.t + c.ms), 0)
  const rpc = trace.filter((c) => c.kind === 'rpc').length
  return {
    calls: trace.length + more,
    ok,
    failed: trace.length - ok,
    rpc,
    registry: trace.length - rpc,
    wallMs: Math.round(wall),
    steps: trace.slice(0, 8).map((c) => ({ method: c.method, target: c.target, ms: Math.round(c.ms), ok: c.ok, result: c.result.slice(0, 80) })),
  }
}

function traceLine(t: ReturnType<typeof traceSummary>): string {
  if (!t) return 'calls: not recorded for this read'
  const steps = t.steps.map((s) => `${s.method}${s.ok ? '' : ' ✗'}`).join(' → ')
  return `calls: ${t.calls} (${t.rpc} RPC, ${t.registry} registry${t.failed ? `, ${t.failed} failed` : ''}) in ${int(t.wallMs)} ms · ${steps}${t.calls > t.steps.length ? ' → …' : ''}`
}

// ─── lusca_stats ────────────────────────────────────────────────────────────

const statsTool = defineTool({
  name: 'lusca_stats',
  title: 'LUSCA corpus and network numbers',
  description:
    "Live numbers of LUSCA's open crypto corpus: web pages and tokens collected, chain reads by the agents and the programs / contracts kept as SEPIA-1 training data (per chain), verified source bytes, the protocol code index, the GPU network and its gradient audits. No arguments.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  cacheS: 10,
  async run(_args, ctx) {
    const s = await from(ctx.source.stats())
    const now = ctx.now()
    const out: string[] = [`LUSCA — live numbers (${iso(now)})`]
    if (s.corpus) {
      out.push(
        `Web corpus: ${int(s.corpus.pages)} pages · ${int(s.corpus.tokens)} tokens collected (lifetime)${s.corpus.heldPages !== null ? ` · ${int(s.corpus.heldPages)} pages held on disk now` : ''} · ${int(s.corpus.domains)} domains · ${int(s.corpus.pagesPerMin)} pages/min`,
      )
    }
    if (s.chain) {
      const c = s.chain
      out.push(`Chain agents: ${int(c.reads)} reads · ${int(c.kept)} kept (${int(c.programs)} Solana programs, ${int(c.contracts)} EVM contracts) · ${int(c.idls)} with an IDL · ${int(c.verified)} with verified source · ${bytes(c.sourceBytes)} of verified source`)
      const by = CHAINS.filter((k) => c.byChain[k]).map((k) => `${k} ${int(c.byChain[k].reads)} reads / ${int(c.byChain[k].kept)} kept`)
      if (by.length) out.push(`  by chain: ${by.join(' · ')}`)
      const rej = Object.entries(c.rejected ?? {}).sort((a, b) => b[1] - a[1])
      if (rej.length) out.push(`  not kept: ${rej.map(([k, v]) => `${k} ${int(v)}`).join(' · ')}`)
    }
    if (s.code) out.push(`Protocol code index: ${int(s.code.repos)} repositories · ${int(s.code.files)} files · ${bytes(s.code.bytes)}`)
    if (s.network) out.push(`GPU network: ${int(s.network.neurons)} neurons connected · ${int(s.network.gflops)} GFLOPS · ${int(s.network.jobsVerified)} of ${int(s.network.jobsDone)} jobs verified`)
    if (s.audits) out.push(`Gradient audits (full server-side recomputation of GPU gradients): ${int(s.audits.ok)} passed · ${int(s.audits.failed)} failed`)
    if (out.length === 1) out.push('No module answered on this server.')
    const l = links(ctx.site, '/live', '/chain', '/api/stats', '/api/chain/stats', '/api/code/stats')
    out.push(`Sources: ${l.join(' · ')}`)
    return { text: out.join('\n'), data: { ...s, links: l, asOf: now } }
  },
})

// ─── lusca_scan_recent ──────────────────────────────────────────────────────

function eventRow(e: ChainEvent, site: string, now: number) {
  const t = traceSummary(e.trace, e.scan?.traceMore ?? 0)
  return {
    id: e.id,
    ts: e.ts,
    chain: e.chain,
    address: e.address,
    name: e.name,
    kind: e.kind,
    foundVia: e.via,
    verdict: e.verdict,
    reason: e.reason,
    idl: e.idl,
    verifiedBy: e.verifiedBy,
    sourceFiles: e.sourceFiles,
    sourceBytes: e.sourceBytes,
    upgradeable: e.scan?.upgradeable ?? null,
    authority: e.scan?.authority ?? e.scan?.proxy?.admin ?? null,
    proxy: e.scan?.proxy ? { standard: e.scan.proxy.standard, implementation: e.scan.proxy.implementation } : null,
    calls: t,
    ago: ago(e.ts, now),
    url: site + lensPath(e.chain, e.address),
  }
}

const scanTool = defineTool({
  name: 'lusca_scan_recent',
  title: 'Latest chain reads',
  description:
    "The latest reads by LUSCA's chain agents, newest first: which Solana program or EVM contract was read, how it was found, the verdict (kept as training data, or not kept with the reason) and the network calls each read made (method, count, time). Filter by chain or verdict.",
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 8, description: 'How many reads (1–20, default 8)' },
      chain: chainSchema,
      verdict: { type: 'string', enum: VERDICTS, description: 'Only reads with this verdict' },
    },
    additionalProperties: false,
  },
  cacheS: 3,
  async run(args, ctx) {
    const limit = (args.limit as number | undefined) ?? 8
    const now = ctx.now()
    const feed = await from(ctx.source.feed(50))
    const rows = feed.filter((e) => (!args.chain || e.chain === args.chain) && (!args.verdict || e.verdict === args.verdict)).slice(0, limit)
    const items = rows.map((e) => eventRow(e, ctx.site, now))
    const filt = [args.chain, args.verdict].filter(Boolean).join(' · ')
    const out = [`Latest chain reads${filt ? ` (${filt})` : ''} — ${items.length} of the newest ${feed.length} in the feed`]
    if (!items.length) out.push(feed.length ? 'No read in the recent feed matches these filters.' : 'The feed is empty on this server.')
    items.forEach((r, i) => {
      out.push(`${i + 1}. ${r.ago} · ${r.chain} · ${r.verdict.toUpperCase()} · ${r.name ?? '(no name)'} ${r.address}`)
      out.push(`   found via ${r.foundVia} · ${r.kind}${r.verifiedBy ? ` · verified source (${r.verifiedBy}, ${int(r.sourceFiles)} files, ${bytes(r.sourceBytes)})` : ''}${r.idl ? ' · IDL' : ''}${r.upgradeable !== null ? ` · upgradeable: ${yesNo(r.upgradeable)}` : ''}`)
      out.push(`   reason: ${r.reason}`)
      out.push(`   ${traceLine(r.calls)}`)
      out.push(`   ${r.url}`)
    })
    const l = links(ctx.site, '/scan', '/api/chain/feed?limit=50&scan=1')
    out.push(`Sources: ${l.join(' · ')}`)
    return { text: bound(out.join('\n'), TEXT_MAX), data: { items, feedSize: feed.length, links: l, asOf: now } }
  },
})

// ─── lusca_lens ─────────────────────────────────────────────────────────────

function lensData(r: LensReport) {
  const sol = r.solana
  const evm = r.evm
  const impl = evm?.implementation ?? null
  const code = impl ?? evm?.self ?? null
  return {
    chain: r.chain,
    address: r.address,
    name: r.name,
    kind: r.kind,
    readAt: r.readAt,
    summary: r.summary,
    solana: sol
      ? {
          loader: sol.loader,
          upgradeable: sol.upgradeable,
          upgradeAuthority: sol.upgradeAuthority,
          programBytes: sol.programBytes,
          lastDeploySlot: sol.lastDeploySlot,
          codeHash: sol.codeHash,
          securityTxt: sol.securityTxt ? Object.fromEntries(Object.entries(sol.securityTxt).slice(0, 8).map(([k, v]) => [k, String(v).slice(0, 160)])) : null,
          idl: sol.idl
            ? { source: sol.idl.source, name: sol.idl.name, version: sol.idl.version, instructions: sol.idl.instructions.slice(0, 40).map((i) => i.name), instructionCount: sol.idl.instructions.length, accounts: sol.idl.accounts.length, errors: sol.idl.errors.length, events: sol.idl.events.length }
            : null,
          osec: sol.osec,
          signerRoles: sol.signerRoles.slice(0, 16),
        }
      : null,
    evm: evm
      ? {
          proxy: evm.proxy ? { standard: evm.proxy.standard, label: evm.proxy.label, implementation: evm.proxy.implementation, admin: evm.proxy.admin, beacon: evm.proxy.beacon ?? null } : null,
          bytecodeBytes: evm.bytecodeBytes,
          code: code
            ? {
                address: code.address,
                name: code.name,
                verified: code.verified,
                sources: code.sources.length,
                functions: { write: code.functions.write.length, payable: code.functions.payable.length, view: code.functions.view.length },
                privileged: code.privileged.slice(0, 16).map((p) => ({ fn: p.fn, guard: p.guard, at: `${p.file}:${p.line}` })),
                privilegedCount: code.privileged.length,
                analysis: code.analysis ?? null,
              }
            : null,
        }
      : null,
    primitives: r.primitives.slice(0, 16).map((p) => ({ name: p.name, group: p.group, via: p.via, at: p.at.slice(0, 2).map((a) => `${a.file}:${a.line}`) })),
    provenance: { checked: r.provenance.checked, matches: r.provenance.matches.slice(0, 8).map((m) => ({ file: m.file, repo: m.repo, path: m.path, exact: m.exact })), matchCount: r.provenance.matches.length, osecRepo: r.provenance.osecRepo },
    dataset: { verdict: r.dataset.verdict, reason: r.dataset.reason, added: r.dataset.added },
    notes: r.notes.slice(0, 8),
    cites: r.cites.slice(0, 10),
  }
}

const lensTool = defineTool({
  name: 'lusca_lens',
  title: 'LUSCA Lens report',
  description:
    'Deterministic report on one Solana program or EVM contract, read on-chain and from verified-source registries: verified build/source, upgradeability and who holds the upgrade right, proxy and implementation, IDL instructions or ABI surface, admin-only (guarded) functions with file:line, cryptographic primitives the code uses, files matching known protocol repositories, and whether it qualifies as SEPIA-1 training data. Answers from cache when the address was read recently; a fresh read spends a small shared daily budget and takes up to ~20 s.',
  inputSchema: target(),
  annotations: { openWorldHint: true },
  cacheS: 60,
  timeoutMs: 62_000,
  async run(args, ctx) {
    const { chain, address } = targetOf(args)
    const r = await from(ctx.source.lens(chain, address, ctx.ip))
    if (!r.ok) throw new ToolError(`Lens: ${r.error}`, r.retryAfterS)
    const rep = r.answer.report
    const d = lensData(rep)
    const s = rep.summary
    const now = ctx.now()
    const out = [`LUSCA Lens · ${rep.chain} · ${rep.name ?? '(no name)'} · ${rep.address}`, `kind: ${rep.kind} · read ${iso(rep.readAt)} (${ago(rep.readAt, now)}${r.answer.cached ? ', from cache' : ', fresh read'}) · ${int(rep.rpcCalls)} RPC + ${int(rep.registryCalls)} registry calls`]
    out.push(`verified: ${s.verified === null ? 'no verified build/source found' : s.verified === 'unknown' ? 'unknown (the registry could not be asked)' : s.verified}`)
    out.push(`upgradeable: ${yesNo(s.upgradeable)}${s.authority ? ` · ${rep.chain === 'solana' ? 'upgrade authority' : 'proxy admin'}: ${s.authority}` : ''}`)
    if (d.solana) {
      const so = d.solana
      out.push(`loader: ${so.loader ?? DASH} · program ${bytes(so.programBytes)} · last deploy slot ${int(so.lastDeploySlot)} · code hash ${so.codeHash ?? DASH}`)
      if (so.osec) out.push(`OtterSec verified build: ${so.osec.verified ? 'yes' : 'no'}${so.osec.repo ? ` · ${so.osec.repo}${so.osec.commit ? `@${so.osec.commit.slice(0, 10)}` : ''}` : ''}`)
      if (so.idl) out.push(`IDL (${so.idl.source}): ${so.idl.instructionCount} instructions — ${list(so.idl.instructions, 24)} · ${so.idl.accounts} account types · ${so.idl.errors} errors · ${so.idl.events} events`)
      else out.push('IDL: none published on-chain')
      if (so.signerRoles.length) out.push(`authority-like signers: ${list(so.signerRoles.map((x) => `${x.instruction}(${x.account})`), 10)}`)
      if (so.securityTxt) out.push(`security.txt: ${list(Object.entries(so.securityTxt).map(([k, v]) => `${k}=${v}`), 4, ' · ')}`)
    }
    if (d.evm) {
      const e = d.evm
      if (e.proxy) out.push(`proxy: ${e.proxy.label} → implementation ${e.proxy.implementation}${e.proxy.admin ? ` · admin ${e.proxy.admin}` : ''}${e.proxy.beacon ? ` · beacon ${e.proxy.beacon}` : ''}`)
      if (e.code) {
        const c = e.code
        out.push(`code: ${c.name ?? '(unnamed)'} ${c.address} · ${c.verified ? `verified (${c.verified.match} match${c.verified.compiler ? `, ${c.verified.compiler}` : ''}), ${c.sources} source files` : 'source not verified'} · functions: ${c.functions.write} write, ${c.functions.payable} payable, ${c.functions.view} view`)
        if (c.analysis) out.push(`source analysis: ${c.analysis}`)
        else if (c.verified) out.push(`admin-only (guarded) functions: ${c.privilegedCount}${c.privileged.length ? ` — ${list(c.privileged.map((p) => `${p.fn} [${p.guard}] ${p.at}`), 12, '; ')}` : ''}`)
      }
    }
    if (d.primitives.length) out.push(`primitives: ${list(d.primitives.map((p) => `${p.name} (${p.via}${p.at.length ? ` ${p.at[0]}` : ''})`), 12)}`)
    if (d.provenance.checked > 0) out.push(`known-repository files: ${d.provenance.matchCount} of ${d.provenance.checked} checked${d.provenance.matches.length ? ` — ${list(d.provenance.matches.map((m) => `${m.file} ≡ ${m.repo}/${m.path}${m.exact ? '' : ' (same code, whitespace/comments differ)'}`), 5, '; ')}` : ''}`)
    out.push(`SEPIA-1 training data: ${d.dataset.verdict} — ${d.dataset.reason}`)
    if (d.notes.length) out.push(`notes: ${d.notes.join(' · ')}`)
    const l = links(ctx.site, lensPath(rep.chain, rep.address), `/api/lens/${rep.chain}/${rep.address}`, ...d.cites.map((c) => c.url))
    out.push(`Sources: ${l.slice(0, 8).join(' · ')}`)
    return { text: bound(out.join('\n'), TEXT_MAX), data: { ...d, cached: r.answer.cached, links: l, asOf: now } }
  },
})

// ─── lusca_radar / lusca_radar_event ────────────────────────────────────────

function sideData(s: RadarSide | null) {
  if (!s) return null
  return { at: s.at, codeHash: s.codeHash, authority: s.authority, upgradeable: s.upgradeable, implementation: s.implementation ?? null, verified: s.verified, name: s.name, surfaceCount: s.surfaceCount, guardCount: s.guardCount ?? null, bytes: s.bytes ?? null, deploySlot: s.deploySlot ?? null }
}

function radarRow(e: RadarEvent, site: string, now: number) {
  return {
    id: e.id,
    chain: e.chain,
    kind: e.kind,
    address: e.address,
    name: e.name,
    known: e.known,
    headline: e.headline,
    ts: e.ts,
    ago: ago(e.ts, now),
    tx: e.tx,
    slot: e.slot,
    block: e.block,
    actor: e.actor,
    actorRole: e.actorRole,
    state: e.state,
    sourceDiff: diffable(e),
    url: site + (diffable(e) ? `/radar/${e.id}` : '/radar'),
    lens: site + lensPath(e.chain, e.address),
  }
}

const radarTool = defineTool({
  name: 'lusca_radar',
  title: 'Recent on-chain code changes',
  description:
    "Code changes LUSCA's upgrade radar caught live, newest first: Solana program upgrades, deploys, upgrade-authority changes and closes; EVM proxy upgrades, beacon upgrades and admin changes — each with what was read before and after (code hash, authority, verified source, instruction / function surface). Use lusca_radar_event with an id for the full record and the line-by-line source diff summary.",
  inputSchema: {
    type: 'object',
    properties: {
      chain: chainSchema,
      kind: { type: 'string', enum: RADAR_KINDS, description: 'upgrade, deploy, authority_change, admin_change, beacon_upgrade or close' },
      known: { type: 'boolean', description: 'Only protocols LUSCA already knows (kept, or their repository is in the code index)' },
      limit: { type: 'integer', minimum: 1, maximum: 25, default: 10, description: 'How many events (1–25, default 10)' },
    },
    additionalProperties: false,
  },
  cacheS: 3,
  async run(args, ctx) {
    const now = ctx.now()
    const page = await from(ctx.source.radarList({ chain: args.chain as ChainId | undefined, kind: args.kind as RadarKind | undefined, known: args.known === true, limit: (args.limit as number | undefined) ?? 10 }))
    const items = page.items.map((e) => radarRow(e, ctx.site, now))
    const st = page.status
    const filt = [args.chain, args.kind, args.known ? 'known protocols' : ''].filter(Boolean).join(' · ')
    const out = [`Upgrade radar — ${items.length} most recent${filt ? ` (${filt})` : ''}`]
    if (st?.last24h) {
      const k = Object.entries(st.last24h.byKind ?? {}).map(([a, b]) => `${a} ${int(b)}`)
      out.push(`last 24 h: ${int(st.last24h.total)} events${k.length ? ` (${k.join(', ')})` : ''} · ${int(st.stored)} stored`)
    }
    if (!items.length) out.push('No event matches these filters yet.')
    items.forEach((r, i) => {
      out.push(`${i + 1}. ${iso(r.ts)} (${r.ago}) · ${r.chain} · ${r.kind} · ${r.name ?? r.address}${r.known ? ' · known protocol' : ''}`)
      out.push(`   ${r.headline}`)
      out.push(`   id ${r.id}${r.name ? ` · address ${r.address}` : ''}${r.actor ? ` · ${r.actorRole ?? 'actor'} ${r.actor}` : ''}${r.state !== 'read' ? ` · ${r.state}` : ''}${r.sourceDiff ? ' · source diff available' : ''}`)
      out.push(`   ${r.url}`)
    })
    const qs = new URLSearchParams({ limit: String(items.length || 10) })
    if (args.chain) qs.set('chain', String(args.chain))
    if (args.kind) qs.set('kind', String(args.kind))
    const l = links(ctx.site, '/radar', `/api/radar?${qs}`)
    out.push(`Sources: ${l.join(' · ')}`)
    return {
      text: bound(out.join('\n'), TEXT_MAX),
      data: { items, last24h: st?.last24h ?? null, stored: st?.stored ?? null, links: l, asOf: now },
    }
  },
})

const radarEventTool = defineTool({
  name: 'lusca_radar_event',
  title: 'One code change, in full',
  description:
    'Full record of one upgrade-radar event by id (from lusca_radar): when it landed, the transaction and who sent or signed it, the state read before and after (code hash, upgrade authority / proxy admin, implementation, verified source, surface), instructions or functions added and removed, admin checks added / removed / changed with file:line, the calls the radar made — and for verified EVM upgrades the source diff summary (files and functions changed, access checks).',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', pattern: RADAR_ID_RE.source, minLength: 10, maxLength: 24, description: 'Radar event id, e.g. "sol-3k9x2m1q"' } },
    required: ['id'],
    additionalProperties: false,
  },
  cacheS: 5,
  async run(args, ctx) {
    const id = String(args.id)
    const e = await from(ctx.source.radarGet(id))
    if (!e) throw new ToolError(`no radar event with id ${id} (ids come from lusca_radar)`)
    const now = ctx.now()
    const row = radarRow(e, ctx.site, now)
    const out = [`Radar event ${e.id} · ${e.chain} · ${e.kind} · ${e.name ?? '(no name)'} ${e.address}`, e.headline]
    out.push(`landed ${iso(e.ts)} (${ago(e.ts, now)}) · ${e.count > 1 ? 'first caught' : 'caught'} ${iso(e.seenAt)} via ${viaText(e.via)}${e.backfill && !/backfill/.test(e.via) ? ' (backfill)' : ''}${e.slot ? ` · slot ${int(e.slot)}` : ''}${e.block ? ` · block ${int(e.block)}` : ''}${e.count > 1 ? ` · ${e.count} transactions folded` : ''}`)
    if (e.tx) out.push(`transaction: ${e.tx}`)
    if (e.actor) out.push(`${e.actorRole ?? 'actor'}: ${e.actor}`)
    if (e.known) out.push(`known protocol: ${e.knownWhy ?? 'yes'}`)
    const side = (label: string, s: RadarSide | null) => {
      if (!s) return out.push(`${label}: not read`)
      out.push(
        `${label}: code hash ${s.codeHash ?? DASH} · authority ${s.authority ?? DASH} · upgradeable ${yesNo(s.upgradeable)}${s.implementation ? ` · implementation ${s.implementation}` : ''} · verified ${s.verified} · surface ${s.surfaceCount ?? DASH}${s.bytes ? ` · ${bytes(s.bytes)}` : ''}`,
      )
    }
    side('before', e.before)
    side('after', e.after)
    const d = e.diff
    if (d) {
      out.push(`diff: code ${d.code} · authority ${d.authority} · verified ${d.verified}`)
      if (d.added?.items.length) out.push(`  ${d.surface ?? 'items'} added: ${list(d.added.items, 20)}${d.added.more ? ` (+${d.added.more})` : ''}`)
      if (d.removed?.items.length) out.push(`  ${d.surface ?? 'items'} removed: ${list(d.removed.items, 20)}${d.removed.more ? ` (+${d.removed.more})` : ''}`)
      if (d.guardsAdded?.length) out.push(`  admin checks added: ${list(d.guardsAdded.map((g) => `${g.fn} [${g.guard}] ${g.at}`), 10, '; ')}`)
      if (d.guardsRemoved?.length) out.push(`  admin checks removed: ${list(d.guardsRemoved.map((g) => `${g.fn} [${g.guard}] ${g.at}`), 10, '; ')}`)
      if (d.guardsChanged?.length) out.push(`  admin checks changed: ${list(d.guardsChanged.map((g) => `${g.fn}: ${g.before.guard} → ${g.after.guard} (${g.after.at})`), 10, '; ')}`)
      if (d.primitivesAdded?.length) out.push(`  primitives added: ${d.primitivesAdded.join(', ')}`)
      if (d.primitivesRemoved?.length) out.push(`  primitives removed: ${d.primitivesRemoved.join(', ')}`)
    }
    if (e.notes.length) out.push(`notes: ${e.notes.slice(0, 6).join(' · ')}`)
    const t = traceSummary(e.trace)
    out.push(traceLine(t))
    let src: Record<string, unknown> | null = null
    if (row.sourceDiff) {
      const cd = await from(ctx.source.radarDiff(e.id)).catch(() => null)
      if (!cd) out.push('source diff: not available right now')
      else if (cd.state !== 'ready') {
        out.push(`source diff: ${cd.state}${cd.reason ? ` — ${cd.reason}` : ''}`)
        src = { state: cd.state, reason: cd.reason }
      } else {
        const fns = cd.functions.slice(0, 20).map((f) => ({ sig: f.sig, change: f.change, at: f.at, access: f.access, accessBefore: f.accessBefore ?? undefined }))
        const files = cd.files.slice(0, 12).map((f) => ({ path: f.path, status: f.status, add: f.add, del: f.del }))
        out.push(`source diff (Sourcify, ${cd.oldImpl} → ${cd.newImpl}): ${int(cd.totals.files)} files changed (+${int(cd.totals.add)} −${int(cd.totals.del)}), ${int(cd.unchangedFiles)} unchanged${cd.oldCompiler || cd.newCompiler ? ` · compiler ${cd.oldCompiler ?? DASH} → ${cd.newCompiler ?? DASH}` : ''}`)
        if (files.length) out.push(`  files: ${list(files.map((f) => `${f.path} (${f.status}, +${f.add} −${f.del})`), 8, '; ')}`)
        if (fns.length) out.push(`  functions: ${list(fns.map((f) => `${f.change} ${f.sig}${f.access ? ` [${f.access}]` : ''}${f.accessBefore !== undefined && f.accessBefore !== f.access ? ` (check before: ${f.accessBefore ?? 'none'})` : ''} ${f.at}`), 14, '; ')}`)
        if (cd.truncated) out.push(`  ${cd.truncated}`)
        src = { state: 'ready', oldImpl: cd.oldImpl, newImpl: cd.newImpl, totals: cd.totals, unchangedFiles: cd.unchangedFiles, files, functions: fns, truncated: cd.truncated }
      }
    }
    const l = links(ctx.site, row.url, `/api/radar/${e.id}`, row.sourceDiff ? `/api/radar/${e.id}/diff` : '', row.lens)
    out.push(`Sources: ${l.join(' · ')}`)
    return {
      text: bound(out.join('\n'), TEXT_MAX),
      data: { ...row, seenAt: e.seenAt, via: viaText(e.via), count: e.count, knownWhy: e.knownWhy, before: sideData(e.before), after: sideData(e.after), diff: e.diff, notes: e.notes.slice(0, 8), calls: t, sourceDiffSummary: src, links: l, asOf: now },
    }
  },
})

// ─── lusca_control / lusca_control_summary ──────────────────────────────────

export const CLASS_TEXT: Record<ControlClass, string> = {
  immutable: 'immutable — the code cannot change',
  key: 'single key — one keypair / externally owned account can change the code',
  pda: 'program-derived address — only the program behind that address can sign (e.g. a multisig or DAO program)',
  safe: 'Safe — a threshold of the Safe owners must sign',
  timelock: 'timelock — changes wait for the timelock minimum delay',
  contract: 'another contract (no Safe or timelock interface)',
  unknown: 'upgradeable, controller not identified from the standard slots and calls',
  pending: 'not resolved yet (EVM proxies are resolved in the background under a daily budget)',
}

/** The account at the end of the custody chain (null when the code cannot change or nothing was resolved). */
export function finalController(e: ControlEntry): { address: string; label: string; kind: string } | null {
  for (let i = e.hops.length - 1; i > 0; i--) {
    const h = e.hops[i]
    if (h.address && h.kind !== 'none') return { address: h.address, label: h.label, kind: h.kind }
  }
  return null
}

function hopsText(e: ControlEntry): string {
  return e.hops
    .map((h, i) => `${i ? `→ [${h.via ?? 'then'}] ` : ''}${h.label}${h.address ? ` ${h.address}` : ''}${h.threshold ? ` (${h.threshold} of ${h.owners ?? '?'})` : ''}${h.delay ? ` (delay ${Math.round(h.delay / 3600)} h)` : ''}`)
    .join(' ')
}

/**
 * Custody chain of an address the control map does not hold (not kept), from a Lens read: Solana upgrade
 * authority classified on / off the ed25519 curve; EVM proxy admin as read (not classified further: the
 * control map's Safe / timelock calls run for kept items only).
 */
async function controlFromLens(chain: ChainId, address: string, ctx: ToolContext): Promise<ControlEntry> {
  const r = await from(ctx.source.lens(chain, address, ctx.ip))
  if (!r.ok) throw new ToolError(`${address} on ${chain} is not in the control map (kept items only), and the Lens read needed for it was refused: ${r.error}`, r.retryAfterS)
  const rep = r.answer.report
  const base = { chain, address: rep.address, name: rep.name, at: rep.readAt, calls: rep.rpcCalls }
  if (rep.solana) {
    const s = rep.solana
    const first = { kind: 'program' as const, address: rep.address, label: `program · ${s.loader ?? 'loader not read'}` }
    if (s.upgradeable === false) return { ...base, cls: 'immutable', hops: [first], basis: `the program is not upgradeable (${s.loader ?? 'loader'}; Lens read)` }
    if (!s.upgradeAuthority) return { ...base, cls: 'unknown', hops: [first], basis: 'the upgrade authority could not be read' }
    const on = isOnCurve(s.upgradeAuthority)
    if (on === null) return { ...base, cls: 'unknown', hops: [first, { kind: 'none', address: s.upgradeAuthority, label: 'upgrade authority', via: 'upgrade authority' }], basis: 'the upgrade authority is not a valid ed25519 encoding' }
    return {
      ...base,
      cls: on ? 'key' : 'pda',
      hops: [first, { kind: on ? 'key' : 'pda', address: s.upgradeAuthority, label: on ? 'single key' : 'program-derived address', via: 'upgrade authority' }],
      basis: on ? 'upgrade authority is an ed25519 point (a keypair)' : 'upgrade authority is off the ed25519 curve (a PDA)',
    }
  }
  const evm = rep.evm
  if (!evm?.proxy) return { ...base, cls: 'immutable', hops: [{ kind: 'contract', address: rep.address, label: 'contract · no proxy' }], basis: 'no proxy found by the Lens read: the bytecode at this address is the code' }
  const px = evm.proxy
  const hops: ControlEntry['hops'] = [{ kind: px.standard === 'beacon' ? 'beacon' : px.standard === 'eip1167' ? 'clone' : 'proxy', address: rep.address, label: px.label }]
  if (px.standard === 'eip1167') return { ...base, cls: 'immutable', hops, basis: 'EIP-1167 clone: the implementation address is fixed in the bytecode' }
  if (px.admin) {
    hops.push({ kind: 'contract', address: px.admin, label: 'proxy admin', via: 'admin slot' })
    return { ...base, cls: 'unknown', hops, basis: 'EIP-1967 admin slot (Lens read)' }
  }
  const up = (evm.implementation?.privileged ?? []).filter((p) => /upgrade/i.test(p.fn)).slice(0, 2)
  return {
    ...base,
    cls: 'unknown',
    hops,
    basis: up.length ? `no admin in the proxy slot; the implementation guards ${up.map((p) => `${p.fn} with ${p.guard} (${p.file}:${p.line})`).join('; ')}` : 'no admin in the proxy slot (UUPS-style: the upgrade check lives in the implementation code)',
  }
}

const controlTool = defineTool({
  name: 'lusca_control',
  title: 'Who can change the code',
  description:
    "Who can change the code of a Solana program or EVM contract: the custody chain from the code to the controlling account (Solana upgrade authority and whether it is a keypair or a program-derived address; EVM proxy admin followed to a key, Safe with its threshold, timelock with its delay, or another contract) and every other kept program / contract the same controller can change. Kept items answer from the control map; any other address is read with Lens first. Facts about who holds the upgrade right; nothing about intent.",
  inputSchema: target(),
  annotations: { openWorldHint: true },
  cacheS: 10,
  timeoutMs: 62_000,
  async run(args, ctx) {
    const { chain, address } = targetOf(args)
    const now = ctx.now()
    const stored = await from(ctx.source.controlGet(chain, address))
    const viaLens = stored ? null : await controlFromLens(chain, address, ctx)
    const e = stored ?? viaLens!
    const ctl = finalController(e)
    let others: { chain: ChainId; address: string; name: string | null; cls: ControlClass; url: string }[] = []
    let total = 0
    if (ctl && e.cls !== 'immutable') {
      const pg = await from(ctx.source.controlList({ controller: ctl.address, limit: 50 })).catch(() => null)
      if (pg) {
        const rest = pg.items.filter((x) => !(x.chain === e.chain && sameAddr(x.address, e.address)))
        total = Math.max(rest.length, pg.total - (pg.items.length - rest.length))
        others = rest.slice(0, 25).map((x) => ({ chain: x.chain, address: x.address, name: x.name, cls: x.cls, url: ctx.site + lensPath(x.chain, x.address) }))
      }
    }
    const out = [
      `Control · ${e.chain} · ${e.name ?? '(no name)'} ${e.address}${viaLens ? ' · not kept by LUSCA: read with Lens just now' : ''}`,
      `class: ${viaLens && e.cls === 'unknown' ? 'proxy admin read, not classified (key / Safe / timelock are classified for kept items only)' : CLASS_TEXT[e.cls]}`,
      `basis: ${e.basis}`,
      `custody chain: ${hopsText(e) || 'not resolved yet'}`,
    ]
    if (ctl) out.push(`controller: ${ctl.address} (${ctl.label})`)
    if (ctl && e.cls !== 'immutable') {
      if (others.length) {
        out.push(`the same controller can change ${int(total)} other kept program${total === 1 ? '' : 's'} / contract${total === 1 ? '' : 's'}:`)
        for (const o of others.slice(0, 20)) out.push(`  • ${o.chain} · ${o.name ?? '(no name)'} ${o.address}`)
        if (total > 20) out.push(`  … +${int(total - 20)} more`)
      } else out.push('the same controller changes no other kept program / contract')
    }
    if (viaLens) out.push(`read ${iso(e.at)} by LUSCA Lens`)
    else if (e.at) out.push(`resolved ${iso(e.at)}${e.calls ? ` with ${e.calls} RPC calls` : ' from the stored read (no extra calls)'}`)
    const l = links(ctx.site, viaLens ? lensPath(e.chain, e.address) : '/control', viaLens ? `/api/lens/${e.chain}/${e.address}` : `/api/control/${e.chain}/${e.address}`, ctl ? `/api/control/items?controller=${ctl.address}` : '', lensPath(e.chain, e.address))
    out.push(`Sources: ${l.join(' · ')}`)
    return {
      text: bound(out.join('\n'), TEXT_MAX),
      data: { source: viaLens ? 'lens' : 'control-map', chain: e.chain, address: e.address, name: e.name, class: e.cls, classText: CLASS_TEXT[e.cls], basis: e.basis, hops: e.hops, controller: ctl, sameController: { total, items: others }, resolvedAt: e.at || null, links: l, asOf: now },
    }
  },
})

const controlSummaryTool = defineTool({
  name: 'lusca_control_summary',
  title: 'Control census',
  description:
    'Census of who can change the code across every program and contract LUSCA keeps: how many are immutable, held by a single key, a program-derived address, a Safe, a timelock or another contract — per chain — and the controller addresses that can change the most kept code, with the names of what they control.',
  inputSchema: { type: 'object', properties: { chain: chainSchema }, additionalProperties: false },
  cacheS: 10,
  async run(args, ctx) {
    const s = await from(ctx.source.controlSummary())
    const now = ctx.now()
    const chain = args.chain as ChainId | undefined
    const by = chain ? (s.byChain[chain] ?? {}) : s.byClass
    const tot = Object.values(by).reduce((a, b) => a + (b ?? 0), 0)
    const resolvedHere = tot - (by.pending ?? 0)
    const classes = CONTROL_CLASSES.filter((c) => (by[c] ?? 0) > 0).map((c) => ({ class: c, count: by[c] ?? 0, share: pct(by[c] ?? 0, resolvedHere) }))
    const top = s.topControllers.filter((c) => !chain || c.chain === chain).slice(0, 10)
    const out = [`Control census${chain ? ` · ${chain}` : ''} — ${int(tot)} kept programs / contracts${chain ? '' : ` (${int(s.resolved)} resolved, ${int(s.pending)} pending)`}`]
    for (const c of classes) out.push(`  ${c.class}: ${int(c.count)} (${c.share} of resolved)`)
    if (!chain) {
      for (const k of CHAINS) {
        const row = s.byChain[k]
        if (!row) continue
        out.push(`  ${k}: ${CONTROL_CLASSES.filter((c) => row[c]).map((c) => `${c} ${int(row[c])}`).join(' · ')}`)
      }
    }
    if (top.length) {
      out.push('controllers that can change the most kept code:')
      for (const c of top) out.push(`  • ${int(c.count)} · ${c.chain} · ${c.label} ${c.address}${c.names.length ? ` — ${list(c.names, 4)}` : ''}`)
    }
    const l = links(ctx.site, '/control', '/api/control/summary')
    out.push(`Sources: ${l.join(' · ')}`)
    return {
      text: bound(out.join('\n'), TEXT_MAX),
      data: { chain: chain ?? null, total: tot, resolved: chain ? resolvedHere : s.resolved, pending: chain ? (by.pending ?? 0) : s.pending, classes, byChain: s.byChain, topControllers: top.map((c) => ({ ...c, names: c.names.slice(0, 6), url: ctx.site + `/api/control/items?controller=${c.address}` })), links: l, asOf: now },
    }
  },
})

// ─── lusca_atlas_relatives ──────────────────────────────────────────────────

const atlasTool = defineTool({
  name: 'lusca_atlas_relatives',
  title: 'Code relatives',
  description:
    "Programs and contracts in LUSCA's code atlas that share the most instruction / function / event names with this one (MinHash similarity over the kept IDLs and verified ABIs), with the names they share and the names only one side has, plus the cluster it belongs to. Only kept items are on the atlas.",
  inputSchema: target({ limit: { type: 'integer', minimum: 1, maximum: 12, default: 8, description: 'How many relatives (1–12, default 8)' } }),
  cacheS: 30,
  async run(args, ctx) {
    const { chain, address } = targetOf(args)
    const limit = (args.limit as number | undefined) ?? 8
    const it = await from(ctx.source.atlasItem(chain, address))
    if (!it) throw new ToolError(`${address} on ${chain} is not on the code atlas yet: the atlas maps kept programs and contracts (rebuilt in the background).`)
    const now = ctx.now()
    const rel = it.relatives.slice(0, limit).map((r) => ({ ...r, similarityPct: Math.round(r.similarity), url: ctx.site + lensPath(r.chain, r.address) }))
    const out = [`Code atlas · ${it.chain} · ${it.name ?? '(no name)'} ${it.address}`, `cluster: ${it.clusterLabel ?? 'none'} · ${int(it.functions)} functions/instructions · ${int(it.events)} events · ${it.verifiedBy ? `verified (${it.verifiedBy})` : 'not verified'}`]
    if (it.sample.length) out.push(`names: ${list(it.sample, 16)}`)
    if (!rel.length) out.push('No relative shares enough names with it yet.')
    else out.push(`closest relatives (${rel.length}):`)
    rel.forEach((r, i) => {
      out.push(`${i + 1}. ${r.similarityPct}% similar · ${r.shared} shared names · ${r.chain} · ${r.name ?? '(no name)'} ${r.address}`)
      if (r.onlyHere.length || r.onlyThere.length) out.push(`   only here: ${list(r.onlyHere, 6)} · only there: ${list(r.onlyThere, 6)}`)
    })
    const l = links(ctx.site, '/atlas', `/api/atlas/item/${it.chain}/${it.address}`, lensPath(it.chain, it.address))
    out.push(`Sources: ${l.join(' · ')}`)
    return {
      text: bound(out.join('\n'), TEXT_MAX),
      data: { chain: it.chain, address: it.address, name: it.name, cluster: it.clusterLabel, functions: it.functions, events: it.events, verifiedBy: it.verifiedBy, sample: it.sample.slice(0, 24), relatives: rel, links: l, asOf: now },
    }
  },
})

// ─── lusca_controlled_by ────────────────────────────────────────────────────

const controlledByTool = defineTool({
  name: 'lusca_controlled_by',
  title: 'What can this address change?',
  description:
    "Reverse lookup of the control map: every kept Solana program and EVM contract that one address (an upgrade authority, proxy admin, ProxyAdmin, Safe or timelock anywhere in the custody chain) can change, with what that address is (single key, program-derived address, Safe threshold, timelock delay). Covers the programs and contracts LUSCA keeps.",
  inputSchema: {
    type: 'object',
    properties: {
      address: { ...addressSchema, description: 'Solana address (base58) or EVM address (0x + 40 hex) of the controller' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 25, description: 'How many items to list (1–50, default 25; the total is always given)' },
    },
    required: ['address'],
    additionalProperties: false,
  },
  cacheS: 10,
  async run(args, ctx) {
    const address = String(args.address).trim()
    if (!isSolanaAddress(address) && !EVM_RE.test(address)) throw new ToolError('address is not a Solana or EVM address')
    const limit = (args.limit as number | undefined) ?? 25
    const now = ctx.now()
    const pg = await from(ctx.source.controlList({ controller: address, limit: Math.max(limit, 50) }))
    const role = (() => {
      for (const e of pg.items) for (let i = 1; i < e.hops.length; i++) if (sameAddr(e.hops[i].address, address)) return { hop: e.hops[i], chain: e.chain }
      return null
    })()
    const items = pg.items.slice(0, limit).map((e) => ({ chain: e.chain, address: e.address, name: e.name, class: e.cls, via: e.hops.find((h, i) => i > 0 && sameAddr(h.address, address))?.via ?? null, url: ctx.site + lensPath(e.chain, e.address) }))
    const h = role?.hop
    const what = h ? `${h.label}${h.threshold ? ` (${h.threshold} of ${h.owners ?? '?'})` : ''}${h.delay ? ` (delay ${Math.round(h.delay / 3600)} h)` : ''}` : null
    const out = [`Controlled by ${address}${what ? ` · ${what}` : ''}${role ? ` · ${role.chain}` : ''}`]
    if (!pg.total) out.push("LUSCA's control map holds no kept program or contract this address can change (it maps the programs and contracts LUSCA keeps).")
    else {
      const vias = [...new Set(items.map((it) => it.via ?? ''))]
      const one = vias.length === 1 && vias[0] ? vias[0] : null
      out.push(`can change ${int(pg.total)} kept program${pg.total === 1 ? '' : 's'} / contract${pg.total === 1 ? '' : 's'}${one ? ` (as ${one})` : ''}:`)
      for (const it of items) out.push(`  • ${it.chain} · ${it.name ?? '(no name)'} ${it.address}${!one && it.via ? ` · via ${it.via}` : ''}`)
      if (pg.total > items.length) out.push(`  … +${int(pg.total - items.length)} more`)
    }
    const l = links(ctx.site, '/control', `/api/control/items?controller=${address}`)
    out.push(`Sources: ${l.join(' · ')}`)
    return {
      text: bound(out.join('\n'), TEXT_MAX),
      data: { controller: address, role: h ? { kind: h.kind, label: h.label, threshold: h.threshold ?? null, owners: h.owners ?? null, delay: h.delay ?? null } : null, total: pg.total, items, links: l, asOf: now },
    }
  },
})

// ─── lusca_kept_item ────────────────────────────────────────────────────────

const keptItemTool = defineTool({
  name: 'lusca_kept_item',
  title: 'What LUSCA keeps for an address',
  description:
    "The stored read of one kept program or contract (no new network calls): how and when the agents found it, verified source files with sizes (Sourcify / OtterSec match, compiler, repository and commit), the IDL instructions or ABI functions and events, security.txt, proxy and upgrade authority, and the read's notes. Kept items are LUSCA's SEPIA-1 training data.",
  inputSchema: target(),
  cacheS: 30,
  async run(args, ctx) {
    const { chain, address } = targetOf(args)
    const now = ctx.now()
    const r = await from(ctx.source.chainItem(chain, address))
    if (!r) throw new ToolError(`${address} on ${chain} is not kept by LUSCA (not in the chain index). lusca_lens reads any address and says whether it would qualify.`)
    const { item: it, read: rd } = r
    const files = rd.sources.slice(0, 40).map((f) => ({ path: f.path, lang: f.lang, bytes: f.bytes }))
    const fns = rd.abi?.functions ?? []
    const ix = rd.idl?.instructions.map((i) => i.name) ?? []
    const out = [
      `Kept · ${it.chain} · ${it.name ?? rd.name ?? '(no name)'} ${it.address}`,
      `${it.kind} · found via ${it.via} · first seen ${iso(it.firstSeen)} · read ${iso(it.readAt)} (${int(rd.rpcCalls)} RPC call${rd.rpcCalls === 1 ? "" : "s"})`,
    ]
    if (rd.verified) out.push(`verified: ${rd.verified.by}${rd.verified.match ? ` ${rd.verified.match} match` : ''}${rd.verified.compiler ? ` · ${rd.verified.compiler}` : ''}${rd.verified.repo ? ` · ${rd.verified.repo}${rd.verified.commit ? `@${rd.verified.commit.slice(0, 10)}` : ''}` : ''}`)
    else out.push('verified: no verified source / build')
    if (rd.upgradeable !== null || rd.upgradeAuthority) out.push(`upgradeable: ${yesNo(rd.upgradeable)}${rd.upgradeAuthority ? ` · upgrade authority ${rd.upgradeAuthority}` : ''}`)
    if (rd.proxy) out.push(`proxy: ${rd.proxy.standard} → implementation ${rd.proxy.implementation}`)
    if (rd.programBytes || rd.bytecodeBytes) out.push(`code: ${bytes(rd.programBytes ?? rd.bytecodeBytes)}${rd.codeHash ? ` · hash ${rd.codeHash}` : ''}${rd.lastDeploySlot ? ` · last deploy slot ${int(rd.lastDeploySlot)}` : ''}`)
    if (files.length) out.push(`source files (${rd.sources.length}, ${bytes(it.sourceBytes)}): ${list(files.map((f) => `${f.path} (${bytes(f.bytes)})`), 14, '; ')}`)
    if (ix.length) out.push(`IDL instructions (${ix.length}): ${list(ix, 30)}`)
    if (fns.length) out.push(`ABI functions (${fns.length}): ${list(fns, 30)}`)
    if (rd.abi?.events.length) out.push(`events (${rd.abi.events.length}): ${list(rd.abi.events, 12)}`)
    if (rd.securityTxt) out.push(`security.txt: ${list(Object.entries(rd.securityTxt).map(([k, v]) => `${k}=${String(v).slice(0, 120)}`), 5, ' · ')}`)
    if (rd.notes.length) out.push(`notes: ${rd.notes.slice(0, 6).join(' · ')}`)
    const l = links(ctx.site, `/chain/${it.chain}/${it.address}`, `/api/chain/item/${it.chain}/${it.address}`, lensPath(it.chain, it.address))
    out.push(`Sources: ${l.join(' · ')}`)
    return {
      text: bound(out.join('\n'), TEXT_MAX),
      data: {
        chain: it.chain, address: it.address, name: it.name ?? rd.name, kind: it.kind, foundVia: it.via, firstSeen: it.firstSeen, readAt: it.readAt,
        verified: rd.verified, upgradeable: rd.upgradeable, upgradeAuthority: rd.upgradeAuthority, proxy: rd.proxy, codeHash: rd.codeHash,
        sources: { count: rd.sources.length, bytes: it.sourceBytes, files },
        idl: rd.idl ? { name: rd.idl.name, version: rd.idl.version, instructions: ix.slice(0, 60), accounts: rd.idl.accounts.length, errors: rd.idl.errors, events: rd.idl.events } : null,
        abi: rd.abi ? { functions: fns.slice(0, 80), events: rd.abi.events.slice(0, 40), functionCount: fns.length } : null,
        securityTxt: rd.securityTxt, notes: rd.notes.slice(0, 10), links: l, asOf: now,
      },
    }
  },
})

/** The built-in LUSCA tools, in the order tools/list shows them. */
export const TOOLS: McpTool[] = [lensTool, controlTool, controlledByTool, radarTool, radarEventTool, atlasTool, keptItemTool, scanTool, controlSummaryTool, statsTool]
