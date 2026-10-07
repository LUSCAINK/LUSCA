// LUSCA MCP over Streamable HTTP: POST /mcp carries JSON-RPC, answered as application/json (or as one
// text/event-stream message for a client that accepts only SSE). Stateless: no Mcp-Session-Id is issued,
// so GET (server stream) and DELETE (session end) answer 405. A browser GET (Accept: text/html) is the
// docs page instead (server/http.ts asks wantsDocs() first).
//
// Abuse bounds, all per server: per-address request and tool-call windows, a global window, a body cap,
// JSON only, an Origin check (no Origin = CLI / server clients; browsers only from this site, localhost
// or a configured origin), and the core's own in-flight cap and tool timeout.

import type http from 'node:http'
import zlib from 'node:zlib'
import { createWindow } from '../lens/index.ts'
import { DEFAULT_HEADER_PROTOCOL, RPC, SUPPORTED_PROTOCOLS, rpcError, type McpCore } from './protocol.ts'

export interface McpHttpLimits {
  /** POST /mcp per client address per minute. */
  requestsPerMin: number
  /** tools/call messages per client address per minute. */
  toolCallsPerMin: number
  /** POST /mcp per minute, all clients together. */
  globalPerMin: number
  /** Request body cap in bytes. */
  bodyBytes: number
}

export const DEFAULT_MCP_LIMITS: McpHttpLimits = { requestsPerMin: 90, toolCallsPerMin: 40, globalPerMin: 2_400, bodyBytes: 64 * 1024 }

export interface McpHttpOptions {
  core: McpCore
  /** Same-host / localhost / configured origins (server/http.ts originAllowed). */
  originAllowed: (origin: string, host: string | undefined) => boolean
  limits?: Partial<McpHttpLimits>
  now?: () => number
}

export interface McpHttp {
  /** A browser asking for the page (GET / HEAD with text/html): serve the docs page, not the endpoint. */
  wantsDocs(req: http.IncomingMessage): boolean
  handle(req: http.IncomingMessage, res: http.ServerResponse, ip: string): Promise<void>
}

const ALLOW = 'POST, OPTIONS'
const CORS_HEADERS = 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID'

export function createMcpHttp(o: McpHttpOptions): McpHttp {
  const L: McpHttpLimits = { ...DEFAULT_MCP_LIMITS, ...o.limits }
  const now = o.now ?? Date.now
  const perIp = createWindow(60_000, L.requestsPerMin, now)
  const perIpTools = createWindow(60_000, L.toolCallsPerMin, now)
  const global = createWindow(60_000, L.globalPerMin, now)

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
    wantsDocs(req) {
      const m = req.method ?? 'GET'
      if (m !== 'GET' && m !== 'HEAD') return false
      const accept = String(req.headers.accept ?? '')
      return accept.includes('text/html') && !accept.includes('text/event-stream')
    },

    async handle(req, res, ip) {
      const method = req.method ?? 'GET'
      const origin = req.headers.origin
      if (origin) {
        if (!o.originAllowed(origin, req.headers.host)) return send(req, res, 403, rpcError(null, RPC.INVALID_REQUEST, 'Origin not allowed'))
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
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

      let wait = perIp.take(ip)
      if (wait === 0) {
        wait = global.take('*')
        if (wait > 0) perIp.refund(ip)
      }
      if (wait > 0) return send(req, res, 429, rpcError(null, -32000, 'Too many requests — slow down'), { 'Retry-After': String(Math.ceil(wait / 1000)) })

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
        const w = perIpTools.take(ip)
        if (w > 0) return send(req, res, 429, rpcError(null, -32000, 'Too many tool calls — slow down'), { 'Retry-After': String(Math.ceil(w / 1000)) })
      }

      const reply = await o.core.handle(body, { ip, protocolVersion: pv || DEFAULT_HEADER_PROTOCOL })
      if (reply.status === 202 || reply.body === null) return send(req, res, 202, null)
      send(req, res, reply.status, reply.body, {}, sse)
    },
  }
}
