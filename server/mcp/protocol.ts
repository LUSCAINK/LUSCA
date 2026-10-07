// LUSCA MCP: JSON-RPC 2.0 message handling for the Model Context Protocol (stateless server).
//
// Spec 2025-06-18 (Streamable HTTP), also 2025-03-26 and 2024-11-05 clients: initialize with protocol
// version negotiation, notifications (no answer), ping, tools/list, tools/call. Batches (2025-03-26) are
// answered entry by entry. Tool failures are tool results with isError (the model reads them and can
// correct itself); protocol failures are JSON-RPC errors with the standard codes.

import { validate } from './schema.ts'
import { scrub } from './format.ts'
import { ToolError, type McpTool, type ToolContext, type ToolRegistry } from './tools.ts'
import type { McpSource } from './source.ts'

export const LATEST_PROTOCOL = '2025-06-18'
export const SUPPORTED_PROTOCOLS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05']
/** Assumed when a request carries no MCP-Protocol-Version header (spec 2025-06-18, Streamable HTTP). */
export const DEFAULT_HEADER_PROTOCOL = '2025-03-26'

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

export type JsonRpcId = string | number | null

export interface JsonRpcError {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: { code: number; message: string; data?: unknown }
}
export interface JsonRpcResult {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}
export type JsonRpcResponse = JsonRpcError | JsonRpcResult

export const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcError => ({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } })

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

export interface CallToolResult {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError: boolean
}

export interface ToolDescriptor {
  name: string
  title?: string
  description: string
  inputSchema: unknown
  outputSchema?: unknown
  annotations?: unknown
}

export interface CoreOptions {
  registry: ToolRegistry
  source: McpSource
  /** Public origin for links. */
  site: string
  version: string
  instructions?: string
  /** Tool calls running at once, all clients together (default 8). */
  maxInFlight?: number
  /** A tool answer that takes longer is given up (default 25 s; Lens reads stop at their own timeout first). */
  toolTimeoutMs?: number
  /** JSON-RPC messages in one batch (default 8). */
  maxBatch?: number
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

export interface RequestContext {
  ip: string
  /** MCP-Protocol-Version of the HTTP request (DEFAULT_HEADER_PROTOCOL when absent). */
  protocolVersion: string
}

export interface CoreReply {
  /** HTTP status: 200 with a body, 202 without (only notifications / responses were sent), 400 for a malformed message. */
  status: number
  body: JsonRpcResponse | JsonRpcResponse[] | null
}

export const DEFAULT_INSTRUCTIONS = [
  "LUSCA reads crypto code on-chain and keeps an open corpus of it. These tools answer from LUSCA's live data on Solana, Ethereum, Base and Arbitrum.",
  'Start with lusca_lens for any program or contract address, lusca_control for who can change its code (and what else that controller can change), lusca_radar / lusca_radar_event for code changes caught live, lusca_atlas_relatives for code that shares its names, lusca_scan_recent for the latest reads, lusca_control_summary and lusca_stats for totals.',
  'Every answer carries lusca.ink links: cite them. Answers state what was read and where; they make no judgment about any project, team or contract.',
].join(' ')

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function stableKey(name: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort()
  return name + '\u0000' + JSON.stringify(keys.map((k) => [k, args[k]]))
}

export interface McpCore {
  handle(body: unknown, ctx: RequestContext): Promise<CoreReply>
  /** Plain function API: run one tool exactly as tools/call does (validation, cache, caps, timeout). */
  callTool(name: string, args: Record<string, unknown> | undefined, ctx: { ip: string; protocolVersion?: string }): Promise<CallToolResult>
  listTools(protocolVersion?: string): ToolDescriptor[]
  stats(): { inFlight: number; cached: number; calls: number; errors: number }
}

export function createCore(o: CoreOptions): McpCore {
  const now = o.now ?? Date.now
  const maxInFlight = o.maxInFlight ?? 8
  const timeoutMs = o.toolTimeoutMs ?? 25_000
  const maxBatch = o.maxBatch ?? 8
  const cache = new Map<string, { at: number; ttl: number; r: CallToolResult }>()
  const running = new Map<string, Promise<CallToolResult>>()
  let inFlight = 0
  let calls = 0
  let errors = 0

  const modern = (v: string) => v >= '2025-06-18'

  function descriptor(t: McpTool, v: string): ToolDescriptor {
    const d: ToolDescriptor = { name: t.name, description: t.description, inputSchema: t.inputSchema }
    if (modern(v)) {
      d.title = t.title
      if (t.outputSchema) d.outputSchema = t.outputSchema
    }
    if (v >= '2025-03-26') d.annotations = t.annotations
    return d
  }

  const errorResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true })

  function shape(r: CallToolResult, v: string): CallToolResult {
    if (modern(v) || !r.structuredContent) return r
    return { content: r.content, isError: r.isError }
  }

  async function runTool(t: McpTool, args: Record<string, unknown>, ip: string): Promise<CallToolResult> {
    if (inFlight >= maxInFlight) return errorResult('LUSCA is answering many tool calls right now — retry in a few seconds.')
    inFlight++
    calls++
    let timer: NodeJS.Timeout | undefined
    const ctx: ToolContext = { source: o.source, ip, site: o.site, now }
    try {
      const out = await Promise.race([
        t.run(args, ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ToolError('the answer took too long — retry in a minute', 60)), timeoutMs)
          timer.unref?.()
        }),
      ])
      const r: CallToolResult = { content: [{ type: 'text', text: scrub(out.text) }], structuredContent: JSON.parse(scrub(JSON.stringify(out.data))) as Record<string, unknown>, isError: false }
      if (t.cacheS > 0) {
        const key = stableKey(t.name, args)
        cache.delete(key)
        cache.set(key, { at: now(), ttl: t.cacheS * 1000, r })
        while (cache.size > 300) cache.delete(cache.keys().next().value as string)
      }
      return r
    } catch (e) {
      errors++
      if (e instanceof ToolError) return errorResult(e.retryAfterS ? `${e.message} (retry after ${e.retryAfterS} s)` : e.message)
      o.log?.('error', `tool ${t.name} failed: ${(e as Error)?.stack ?? e}`)
      return errorResult('LUSCA could not answer this tool call (internal error).')
    } finally {
      if (timer) clearTimeout(timer)
      inFlight--
    }
  }

  async function callTool(name: string, rawArgs: Record<string, unknown> | undefined, c: { ip: string; protocolVersion?: string }): Promise<CallToolResult> {
    const v = c.protocolVersion ?? LATEST_PROTOCOL
    const t = o.registry.get(name)
    if (!t) throw new RpcFailure(RPC.INVALID_PARAMS, `Unknown tool: ${String(name).slice(0, 64)}`)
    const args = rawArgs ?? {}
    const bad = validate(t.inputSchema, args)
    if (bad) return errorResult(`Invalid arguments for ${t.name}: ${bad}.`)
    const key = stableKey(t.name, args)
    const hit = cache.get(key)
    if (hit && now() - hit.at < hit.ttl) return shape(hit.r, v)
    let p = running.get(key)
    if (!p) {
      p = runTool(t, args, c.ip)
      running.set(key, p)
      void p.finally(() => running.delete(key))
    }
    return shape(await p, v)
  }

  async function one(msg: unknown, ctx: RequestContext): Promise<JsonRpcResponse | null> {
    if (!isObj(msg) || msg.jsonrpc !== '2.0') return rpcError(isObj(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null, RPC.INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC 2.0 message')
    const hasId = 'id' in msg && msg.id !== undefined
    if (!('method' in msg)) {
      // a response from the client (to a server request we never send): accepted, nothing to answer
      return null
    }
    if (typeof msg.method !== 'string' || !msg.method) return rpcError(hasId && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null, RPC.INVALID_REQUEST, 'Invalid Request: method must be a string')
    if (!hasId) return null // notifications (notifications/initialized, notifications/cancelled …): nothing to answer
    if (typeof msg.id !== 'string' && typeof msg.id !== 'number') return rpcError(null, RPC.INVALID_REQUEST, 'Invalid Request: id must be a string or a number')
    const id = msg.id
    if (msg.params !== undefined && !isObj(msg.params)) return rpcError(id, RPC.INVALID_PARAMS, 'params must be an object')
    const params = (msg.params ?? {}) as Record<string, unknown>
    try {
      switch (msg.method) {
        case 'initialize': {
          const asked = params.protocolVersion
          if (typeof asked !== 'string' || !asked) return rpcError(id, RPC.INVALID_PARAMS, 'initialize needs params.protocolVersion')
          const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'lusca', title: 'LUSCA', version: o.version, websiteUrl: o.site + '/mcp' },
              instructions: o.instructions ?? DEFAULT_INSTRUCTIONS,
            },
          }
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} }
        case 'tools/list':
          if (params.cursor !== undefined && typeof params.cursor !== 'string') return rpcError(id, RPC.INVALID_PARAMS, 'cursor must be a string')
          return { jsonrpc: '2.0', id, result: { tools: o.registry.list().map((t) => descriptor(t, ctx.protocolVersion)) } }
        case 'tools/call': {
          if (typeof params.name !== 'string' || !params.name) return rpcError(id, RPC.INVALID_PARAMS, 'tools/call needs params.name')
          if (params.arguments !== undefined && !isObj(params.arguments)) return rpcError(id, RPC.INVALID_PARAMS, 'params.arguments must be an object')
          const r = await callTool(params.name, params.arguments as Record<string, unknown> | undefined, { ip: ctx.ip, protocolVersion: ctx.protocolVersion })
          return { jsonrpc: '2.0', id, result: r }
        }
        default:
          return rpcError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${msg.method.slice(0, 64)}`)
      }
    } catch (e) {
      if (e instanceof RpcFailure) return rpcError(id, e.code, e.message)
      o.log?.('error', `mcp ${msg.method} failed: ${(e as Error)?.stack ?? e}`)
      return rpcError(id, RPC.INTERNAL_ERROR, 'Internal error')
    }
  }

  async function handle(body: unknown, ctx: RequestContext): Promise<CoreReply> {
    if (Array.isArray(body)) {
      if (!body.length) return { status: 400, body: rpcError(null, RPC.INVALID_REQUEST, 'Invalid Request: empty batch') }
      if (body.length > maxBatch) return { status: 400, body: rpcError(null, RPC.INVALID_REQUEST, `Invalid Request: at most ${maxBatch} messages per batch`) }
      const out: JsonRpcResponse[] = []
      for (const m of body) {
        const r = await one(m, ctx)
        if (r) out.push(r)
      }
      return out.length ? { status: 200, body: out } : { status: 202, body: null }
    }
    const r = await one(body, ctx)
    if (!r) return { status: 202, body: null }
    // a message that is not JSON-RPC at all is a bad request; method-level errors are answered with 200
    const bad = 'error' in r && r.error.code === RPC.INVALID_REQUEST
    return { status: bad ? 400 : 200, body: r }
  }

  return {
    handle,
    callTool,
    listTools: (v = LATEST_PROTOCOL) => o.registry.list().map((t) => descriptor(t, v)),
    stats: () => ({ inFlight, cached: cache.size, calls, errors }),
  }
}
