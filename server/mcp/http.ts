// LUSCA MCP over Streamable HTTP: POST /mcp carries JSON-RPC, answered as application/json (or as one
// text/event-stream message for a client that accepts only SSE). Stateless: no Mcp-Session-Id is issued,
// so GET (server stream) and DELETE (session end) answer 405. A browser GET (Accept: text/html) is the
// docs page instead (server/http.ts asks wantsDocs() first).
//
// Abuse bounds, all per server: per-address request and tool-call windows, an all-clients window charged
// only by tool calls that actually run (cache hits, initialize, tools/list and ping never use it up), a body
// cap, JSON only, and the core's own in-flight pools, per-address in-flight cap and tool timeout.
//
// Origin: any. The endpoint is public and read-only, answers the same to everyone and uses no cookies or
// credentials, so a browser page on another origin (a hosted MCP client, a web inspector) can call it like
// any CLI; it gets the same per-address limits. CORS answers with '*' and never allows credentials.
//
// Hosted MCP clients (claude.ai and Claude Desktop custom connectors) call from their provider's shared
// egress addresses, so one address there is many users: addresses in the shared ranges get per-address
// windows `sharedFactor` times larger (still inside the global window) and a larger in-flight cap.

import type http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import { createWindow } from '../lens/index.ts'
import { DEFAULT_HEADER_PROTOCOL, RPC, SUPPORTED_PROTOCOLS, rpcError, type McpCore } from './protocol.ts'

export interface McpHttpLimits {
  /** POST /mcp per client address per minute. */
  requestsPerMin: number
  /** tools/call messages per client address per minute. */
  toolCallsPerMin: number
  /** Tool calls that run (not cached) per minute, all clients together. */
  globalPerMin: number
  /** Request body cap in bytes. */
  bodyBytes: number
  /** Per-address windows are this many times larger for an address in the shared client ranges. */
  sharedFactor: number
}

export const DEFAULT_MCP_LIMITS: McpHttpLimits = { requestsPerMin: 90, toolCallsPerMin: 40, globalPerMin: 2_400, bodyBytes: 64 * 1024, sharedFactor: 20 }

/**
 * Anthropic's published outbound addresses (MCP tool calls from claude.ai / Claude Desktop connectors to
 * remote servers): https://docs.anthropic.com/en/api/ip-addresses, "Outbound IP addresses", read
 * 2026-10-07. Override with LUSCA_MCP_SHARED_CLIENT_RANGES (comma-separated CIDRs; "none" for none).
 */
export const DEFAULT_SHARED_CLIENT_RANGES: readonly string[] = ['160.79.104.0/21']

export interface SharedRanges {
  has(ip: string): boolean
  ranges: string[]
  invalid: string[]
}

/** CIDR list → matcher for client keys as server/http.ts makes them (IPv4 text, or an IPv6 /64 'a:b:c:d::/64'). */
export function sharedRanges(list: readonly string[]): SharedRanges {
  const bl = new net.BlockList()
  const ranges: string[] = []
  const invalid: string[] = []
  for (const raw of list) {
    const s = raw.trim()
    if (!s || /^none$/i.test(s)) continue
    const m = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(s)
    const fam = m ? net.isIP(m[1]) : 0
    const bits = m ? Number(m[2]) : -1
    if (!m || !fam || bits > (fam === 4 ? 32 : 128)) {
      invalid.push(s)
      continue
    }
    bl.addSubnet(m[1], bits, fam === 4 ? 'ipv4' : 'ipv6')
    ranges.push(s)
  }
  return {
    ranges,
    invalid,
    has(ip) {
      if (!ranges.length) return false
      let a = ip.trim().replace(/\/\d+$/, '')
      if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(a)) a = a.slice(7)
      const fam = net.isIP(a)
      return fam ? bl.check(a, fam === 4 ? 'ipv4' : 'ipv6') : false
    },
  }
}

export interface McpHttpOptions {
  core: McpCore
  limits?: Partial<McpHttpLimits>
  /** Shared egress ranges of hosted MCP clients (default DEFAULT_SHARED_CLIENT_RANGES). */
  shared?: SharedRanges
  now?: () => number
}

export interface McpHttp {
  /** A browser asking for the page (GET / HEAD with text/html): serve the docs page, not the endpoint. */
  wantsDocs(req: http.IncomingMessage): boolean
  handle(req: http.IncomingMessage, res: http.ServerResponse, ip: string): Promise<void>
  /** The limits in force (the docs page shows them). */
  limits: McpHttpLimits
  shared: SharedRanges
}

const ALLOW = 'POST, OPTIONS'
const CORS_HEADERS = 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID'

export function createMcpHttp(o: McpHttpOptions): McpHttp {
  const L: McpHttpLimits = { ...DEFAULT_MCP_LIMITS, ...o.limits }
  const now = o.now ?? Date.now
  const perIp = createWindow(60_000, L.requestsPerMin, now)
  const perIpTools = createWindow(60_000, L.toolCallsPerMin, now)
  const sharedIp = createWindow(60_000, L.requestsPerMin * L.sharedFactor, now)
  const sharedIpTools = createWindow(60_000, L.toolCallsPerMin * L.sharedFactor, now)
  const global = createWindow(60_000, L.globalPerMin, now)
  const shared = o.shared ?? sharedRanges(DEFAULT_SHARED_CLIENT_RANGES)

  function send(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}, sse = false) {
    if (res.headersSent || res.destroyed) return
    const base: Record<string, string | number> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }
    if (body === null) {
      res.writeHead(status, { ...base, 'Content-Length': 0 })
      res.end()
      return
    }
    const json = JSON.stringify(body)
    if (sse) {
      const text = `event: message\ndata: ${json}\n\n`
      res.writeHead(status, { ...base, 'Content-Type': 'text/event-stream; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
      res.end(text)
      return
    }
    const gzip = json.length > 8192 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
    if (gzip) {
      const gz = zlib.gzipSync(json, { level: 5 })
      res.writeHead(status, { ...base, 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': gz.length })
      res.end(gz)
      return
    }
    res.writeHead(status, { ...base, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json) })
    res.end(json)
  }

  function readBody(req: http.IncomingMessage): Promise<string | 'too-large'> {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] ?? 0)
      const chunks: Buffer[] = []
      let size = 0
      let over = declared > L.bodyBytes
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > L.bodyBytes) over = true
        if (over) {
          if (size > L.bodyBytes * 16) req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(over ? 'too-large' : Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
      if (over) {
        // answer right away; keep draining (above) so the client reads the 413
        resolve('too-large')
      }
    })
  }

  return {
    limits: L,
    shared,
    wantsDocs(req) {
      const m = req.method ?? 'GET'
      if (m !== 'GET' && m !== 'HEAD') return false
      const accept = String(req.headers.accept ?? '')
      return accept.includes('text/html') && !accept.includes('text/event-stream')
    },

    async handle(req, res, ip) {
      const method = req.method ?? 'GET'
      if (req.headers.origin) {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS)
        res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version')
        res.setHeader('Access-Control-Max-Age', '600')
      }
      if (method === 'OPTIONS') return send(req, res, 204, null)
      if (method !== 'POST') {
        return send(
          req,
          res,
          405,
          rpcError(null, RPC.INVALID_REQUEST, 'Method not allowed: this MCP server is stateless and answers POST only (no server stream, no sessions). Open this URL in a browser for the setup page.'),
          { Allow: ALLOW },
        )
      }

      const isShared = shared.has(ip)
      const reqWin = isShared ? sharedIp : perIp
      const toolWin = isShared ? sharedIpTools : perIpTools
      const wait = reqWin.take(ip)
      if (wait > 0) return send(req, res, 429, rpcError(null, -32000, `Too many requests from this address — retry in ${Math.ceil(wait / 1000)} s`), { 'Retry-After': String(Math.ceil(wait / 1000)) })

      const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (ct !== 'application/json') return send(req, res, 415, rpcError(null, RPC.INVALID_REQUEST, 'Content-Type must be application/json'))

      const pv = String(req.headers['mcp-protocol-version'] ?? '').trim()
      if (pv && !SUPPORTED_PROTOCOLS.includes(pv)) return send(req, res, 400, rpcError(null, RPC.INVALID_REQUEST, `Unsupported MCP-Protocol-Version ${pv.slice(0, 32)} (supported: ${SUPPORTED_PROTOCOLS.join(', ')})`))

      const accept = String(req.headers.accept ?? '').toLowerCase()
      const json = !accept || /application\/json|application\/\*|\*\/\*/.test(accept)
      const sse = !json && accept.includes('text/event-stream')
      if (!json && !sse) return send(req, res, 406, rpcError(null, RPC.INVALID_REQUEST, 'Accept must include application/json or text/event-stream'))

      const raw = await readBody(req)
      if (raw === 'too-large') return send(req, res, 413, rpcError(null, RPC.INVALID_REQUEST, `Request body exceeds ${L.bodyBytes} bytes`), { Connection: 'close' })
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        return send(req, res, 400, rpcError(null, RPC.PARSE_ERROR, 'Parse error: the body is not JSON'))
      }

      // tool calls cost more than the rest: their own window per address
      const toolCalls = (Array.isArray(body) ? body : [body]).filter((m) => typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'tools/call').length
      for (let i = 0; i < toolCalls; i++) {
        const w = toolWin.take(ip)
        if (w > 0) return send(req, res, 429, rpcError(null, -32000, `Too many tool calls from this address — retry in ${Math.ceil(w / 1000)} s`), { 'Retry-After': String(Math.ceil(w / 1000)) })
      }

      const reply = await o.core.handle(body, { ip, protocolVersion: pv || DEFAULT_HEADER_PROTOCOL, shared: isShared, admit: () => global.take('*') })
      if (reply.status === 202 || reply.body === null) return send(req, res, 202, null)
      send(req, res, reply.status, reply.body, {}, sse)
    },
  }
}
