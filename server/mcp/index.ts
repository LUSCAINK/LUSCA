// LUSCA for AI agents: a remote MCP server (Model Context Protocol, Streamable HTTP) at /mcp.
//
//   MCP client ── POST /mcp (JSON-RPC) ──▶ http.ts (origin, limits, body cap, Accept)
//                                            └▶ protocol.ts (initialize, ping, tools/list, tools/call)
//                                                 └▶ tools.ts registry ─▶ source.ts ─▶ live modules
//                                                    (lens · radar · radar diff · control · atlas · chain feed / stats)
//
// Read-only. Every tool answers from data the REST API already serves; Lens reads go through server/lens
// with its cache, limits and daily budget. Env: LUSCA_MCP=0 turns /mcp off · LUSCA_MCP_UPSTREAM=https://…
// (local QA only: answer from another LUSCA server's public API, ≤ 1 request/s; never set in production)
// · LUSCA_MCP_REQ_PER_MIN (90) · LUSCA_MCP_TOOLS_PER_MIN (40) per client address · LUSCA_MCP_GLOBAL_PER_MIN (2400 tool calls that run, all clients)
// · LUSCA_MCP_SHARED_CLIENT_RANGES (CIDRs of hosted MCP clients' shared egress, default Anthropic's published
//   outbound range 160.79.104.0/21; "none" for none) · LUSCA_MCP_SHARED_FACTOR (20: their per-address windows
//   are this many times larger, inside the global window).
//
// Plain function API (for other server code):
//   const mcp = createMcp({ source, site })
//   await mcp.callTool('lusca_control', { chain: 'solana', address: '…' }, { ip })  → CallToolResult
//   mcp.listTools()                                                                → ToolDescriptor[]
//   mcp.registry.add(defineTool({ … }))                                            → one more tool

import fs from 'node:fs'
import { createCore, DEFAULT_INSTRUCTIONS, type McpCore } from './protocol.ts'
import { createMcpHttp, DEFAULT_SHARED_CLIENT_RANGES, sharedRanges, type McpHttp, type McpHttpLimits, type SharedRanges } from './http.ts'
import { createRegistry, TOOLS, type ToolRegistry } from './tools.ts'
import { localSource, remoteSource, type LocalExtras, type LocalModules, type McpSource } from './source.ts'

export { defineTool, ToolError, type McpTool, type ToolContext, type ToolOutput } from './tools.ts'
export type { McpSource } from './source.ts'
export type { CallToolResult, ToolDescriptor } from './protocol.ts'

function packageVersion(): string {
  try {
    const j = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }
    return typeof j.version === 'string' ? j.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export interface McpOptions {
  source: McpSource
  /** Public origin for links (default https://lusca.ink). */
  site?: string
  /** Not used: /mcp accepts any Origin (public, read-only, no credentials; see http.ts). Kept for callers. */
  originAllowed?: (origin: string, host: string | undefined) => boolean
  limits?: Partial<McpHttpLimits>
  /** Shared egress ranges of hosted MCP clients (default: LUSCA_MCP_SHARED_CLIENT_RANGES, else Anthropic's published outbound range). */
  shared?: SharedRanges
  maxInFlight?: number
  maxLensInFlight?: number
  toolTimeoutMs?: number
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
  now?: () => number
}

export interface Mcp {
  registry: ToolRegistry
  core: McpCore
  http: McpHttp
  callTool: McpCore['callTool']
  listTools: McpCore['listTools']
}

export function createMcp(o: McpOptions): Mcp {
  const registry = createRegistry(TOOLS)
  // eslint-disable-next-line prefer-const
  let http: McpHttp
  const core = createCore({
    registry,
    source: o.source,
    site: (o.site ?? 'https://lusca.ink').replace(/\/+$/, ''),
    version: packageVersion(),
    instructions: DEFAULT_INSTRUCTIONS,
    maxInFlight: o.maxInFlight,
    maxLensInFlight: o.maxLensInFlight,
    toolTimeoutMs: o.toolTimeoutMs,
    listMeta: () => ({ 'ink.lusca/limits': { requestsPerMin: http.limits.requestsPerMin, toolCallsPerMin: http.limits.toolCallsPerMin, bodyBytes: http.limits.bodyBytes, batch: 8 } }),
    log: o.log,
    now: o.now,
  })
  http = createMcpHttp({ core, limits: o.limits, shared: o.shared ?? sharedRangesFromEnv(), now: o.now })
  return { registry, core, http, callTool: core.callTool, listTools: core.listTools }
}

/**
 * The source for this server: the live modules, or (local QA only, LUSCA_MCP_UPSTREAM=https://…) another
 * LUSCA server's public API.
 */
export function mcpSourceFromEnv(getModules: () => LocalModules | null, extras: LocalExtras, log?: (level: 'info' | 'warn' | 'error', msg: string) => void): McpSource {
  const up = (process.env.LUSCA_MCP_UPSTREAM ?? '').trim()
  if (up) {
    if (/^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/?$/i.test(up)) {
      log?.('warn', `MCP tools answer from ${up} (LUSCA_MCP_UPSTREAM, local QA only)`)
      return remoteSource({ base: up })
    }
    log?.('warn', 'LUSCA_MCP_UPSTREAM ignored: it must be an https origin')
  }
  return localSource(getModules, extras)
}

/** Public origin for tool links: https://<LUSCA_CANONICAL_HOST>, else https://lusca.ink. */
export function mcpSite(): string {
  const h = (process.env.LUSCA_CANONICAL_HOST ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return `https://${/^[a-z0-9.-]+(:\d{1,5})?$/.test(h) ? h : 'lusca.ink'}`
}

/** Shared client ranges from env (LUSCA_MCP_SHARED_CLIENT_RANGES; unset → Anthropic's published outbound range). */
export function sharedRangesFromEnv(env: NodeJS.ProcessEnv = process.env): SharedRanges {
  const raw = env.LUSCA_MCP_SHARED_CLIENT_RANGES
  return sharedRanges(raw === undefined || raw.trim() === '' ? DEFAULT_SHARED_CLIENT_RANGES : raw.split(','))
}

/** Limits from env (unset or invalid → the defaults in http.ts). */
export function mcpLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<McpHttpLimits> {
  const out: Partial<McpHttpLimits> = {}
  const num = (k: string, lo: number, hi: number) => {
    const v = Number(env[k])
    return env[k] !== undefined && env[k] !== '' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined
  }
  const r = num('LUSCA_MCP_REQ_PER_MIN', 1, 100_000)
  const t = num('LUSCA_MCP_TOOLS_PER_MIN', 1, 100_000)
  const g = num('LUSCA_MCP_GLOBAL_PER_MIN', 1, 1_000_000)
  const f = num('LUSCA_MCP_SHARED_FACTOR', 1, 1_000)
  if (f !== undefined) out.sharedFactor = f
  if (r !== undefined) out.requestsPerMin = r
  if (t !== undefined) out.toolCallsPerMin = t
  if (g !== undefined) out.globalPerMin = g
  return out
}

export const mcpEnabled = () => !/^(0|false|no|off)$/i.test(process.env.LUSCA_MCP?.trim() ?? '')
