// Raw JSON-RPC smoke run against a running LUSCA MCP endpoint (no SDK): the handshake a client makes,
// tools/list, then every tool once with real arguments. Prints each answer's text.
//
//   npx tsx server/mcp/_smoke.ts [http://127.0.0.1:8910/mcp] [--json]
//
// Not part of `npm test` (it needs a server and live data); server/mcp/_test.ts is the offline suite.

const url = process.argv.find((a) => /^https?:\/\//.test(a)) ?? 'http://127.0.0.1:8910/mcp'
const asJson = process.argv.includes('--json')
let id = 0

async function rpc(method: string, params?: unknown, notify = false): Promise<{ status: number; body: unknown; ms: number }> {
  const t = Date.now()
  const msg = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++id, method, params }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify(msg),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null, ms: Date.now() - t }
}

function out(label: string, v: unknown) {
  console.log(`\n━━ ${label}`)
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
}

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lusca-smoke', version: '1' } })
out(`initialize → ${init.status} (${init.ms} ms)`, (init.body as { result: unknown }).result)
const note = await rpc('notifications/initialized', undefined, true)
out('notifications/initialized', `HTTP ${note.status}`)
const list = await rpc('tools/list')
const tools = (list.body as { result: { tools: { name: string; description: string }[] } }).result.tools
out(`tools/list → ${tools.length} tools`, tools.map((t) => `${t.name}: ${t.description.slice(0, 90)}…`).join('\n'))

// pump.fun (Solana) and Aave V3 Pool (Ethereum) as fixed, well-known targets
const calls: [string, Record<string, unknown>][] = [
  ['lusca_stats', {}],
  ['lusca_control', { chain: 'solana', address: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' }],
  ['lusca_control_summary', {}],
  ['lusca_radar', { limit: 5 }],
  ['lusca_scan_recent', { limit: 4 }],
  ['lusca_lens', { chain: 'solana', address: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' }],
  ['lusca_atlas_relatives', { chain: 'solana', address: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', limit: 5 }],
]
let radarId: string | null = null
for (const [name, args] of calls) {
  const r = await rpc('tools/call', { name, arguments: args })
  const res = (r.body as { result?: { content: { text: string }[]; isError: boolean; structuredContent?: { items?: { id?: string; sourceDiff?: boolean }[] } } }).result
  if (name === 'lusca_radar') radarId = res?.structuredContent?.items?.find((i) => i.sourceDiff)?.id ?? res?.structuredContent?.items?.[0]?.id ?? null
  out(`${name}(${JSON.stringify(args)}) → HTTP ${r.status}, ${r.ms} ms${res?.isError ? ' · isError' : ''}`, asJson ? res : (res?.content[0]?.text ?? r.body))
}
if (radarId) {
  const r = await rpc('tools/call', { name: 'lusca_radar_event', arguments: { id: radarId } })
  const res = (r.body as { result?: { content: { text: string }[]; isError: boolean } }).result
  out(`lusca_radar_event(${radarId}) → HTTP ${r.status}, ${r.ms} ms`, asJson ? res : (res?.content[0]?.text ?? r.body))
}
