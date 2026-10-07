// MCP — /mcp: LUSCA for AI agents. The endpoint, copy-paste setup for Claude Code, Claude Desktop /
// claude.ai, Cursor and VS Code, the live tool list (tools/list) and a console that POSTs real JSON-RPC
// to /mcp and shows the request and the answer. A browser GET of /mcp is this page; MCP clients POST.
//
// Data: POST /mcp initialize + tools/list on load; tools/call from the console (same per-address limits
// as any MCP client). Nothing here is sampled or made up: every number comes from the answer shown.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Kicker } from '@/components/docs/pagekit'
import './mcp.css'

/** Position of /mcp in the primary navigation (set when the nav is integrated in src/components/shell/Shell.tsx). */
const MCP_NAV_N = '13'
const PROTOCOL = '2025-06-18'
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'

interface PropSchema {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array'
  description?: string
  enum?: (string | number)[]
  minimum?: number
  maximum?: number
  default?: unknown
  pattern?: string
}
interface ToolInfo {
  name: string
  title?: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, PropSchema>; required?: string[] }
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean }
}
interface InitResult {
  protocolVersion: string
  serverInfo: { name: string; title?: string; version: string }
}
interface CallResult {
  content?: { type: string; text?: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}
interface Exchange {
  request: Record<string, unknown>
  status: number
  ms: number
  body: unknown
  at: number
}

let nextId = 1

async function rpc(method: string, params: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<Exchange> {
  const request: Record<string, unknown> = { jsonrpc: '2.0', id: nextId++, method }
  if (params) request.params = params
  const t = performance.now()
  const r = await fetch('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL },
    body: JSON.stringify(request),
    signal,
  })
  const text = await r.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { request, status: r.status, ms: Math.round(performance.now() - t), body, at: Date.now() }
}

type Args = Record<string, string | boolean>

const PRESETS: { label: string; tool: string; args: Args }[] = [
  { label: 'Who can upgrade pump?', tool: 'lusca_control', args: { chain: 'solana', address: PUMP } },
  { label: 'What was upgraded last?', tool: 'lusca_radar', args: { kind: 'upgrade', limit: '5' } },
  { label: 'Which keys control the most code?', tool: 'lusca_control_summary', args: { chain: 'solana' } },
  { label: 'What code is closest to pump?', tool: 'lusca_atlas_relatives', args: { chain: 'solana', address: PUMP, limit: '6' } },
  { label: 'What did the agents just read?', tool: 'lusca_scan_recent', args: { limit: '5' } },
  { label: 'How big is the corpus?', tool: 'lusca_stats', args: {} },
]

/** Form values → JSON arguments (empty fields left out, numbers parsed). */
function toArgs(tool: ToolInfo | undefined, a: Args): { args: Record<string, unknown>; error: string | null } {
  const out: Record<string, unknown> = {}
  const props = tool?.inputSchema.properties ?? {}
  for (const [k, s] of Object.entries(props)) {
    const v = a[k]
    if (s.type === 'boolean') {
      if (v === true) out[k] = true
      continue
    }
    if (v === undefined || v === '' || v === false) continue
    if (s.type === 'integer' || s.type === 'number') {
      const n = Number(v)
      if (!Number.isFinite(n)) return { args: out, error: `${k} must be a number` }
      out[k] = n
    } else out[k] = String(v).trim()
  }
  for (const k of tool?.inputSchema.required ?? []) if (out[k] === undefined) return { args: out, error: `${k} is required` }
  return { args: out, error: null }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function Copy({ text, label = 'copy' }: { text: string; label?: string }) {
  const [s, setS] = useState<'idle' | 'ok' | 'fail'>('idle')
  const t = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(t.current), [])
  return (
    <button
      type="button"
      className={`mc-copy mono ${s}`}
      onClick={async () => {
        setS((await copyText(text)) ? 'ok' : 'fail')
        window.clearTimeout(t.current)
        t.current = window.setTimeout(() => setS('idle'), 1400)
      }}
      aria-label={`${label} to clipboard`}
    >
      {s === 'ok' ? 'copied' : s === 'fail' ? 'select + ctrl+c' : label}
    </button>
  )
}

/** Plain text with its https links clickable. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s·,)]+)/g)
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer">
            {p.replace(/^https?:\/\//, '')}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

/** JSON with keys, strings and numbers told apart (no library). */
function JsonView({ value }: { value: unknown }) {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? 'null', [value])
  const nodes: ReactNode[] = []
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b(true|false|null)\b/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1]) nodes.push(<span key={k++} className={m[2] ? 'j-k' : 'j-s'}>{m[1]}</span>, m[2] ?? '')
    else if (m[3]) nodes.push(<span key={k++} className="j-n">{m[3]}</span>)
    else nodes.push(<span key={k++} className="j-b">{m[4]}</span>)
    last = re.lastIndex
  }
  nodes.push(text.slice(last))
  return <>{nodes}</>
}

function Setup({ endpoint }: { endpoint: string }) {
  const clients = useMemo(
    () => [
      {
        k: 'claude-code',
        label: 'Claude Code',
        steps: ['Run once in a terminal:', 'Then ask in any session — “Who can upgrade the Solana program 6EF8…?” — or run a prompt: /mcp__lusca__who_can_change, /mcp__lusca__latest_upgrades, /mcp__lusca__explain_code.'],
        code: `claude mcp add --transport http lusca ${endpoint}`,
      },
      {
        k: 'claude',
        label: 'Claude Desktop · claude.ai',
        steps: ['Settings → Connectors → Add custom connector.', 'Name it LUSCA and paste the URL:'],
        code: endpoint,
      },
      {
        k: 'cursor',
        label: 'Cursor',
        steps: ['Add to .cursor/mcp.json (project) or ~/.cursor/mcp.json (global):'],
        code: JSON.stringify({ mcpServers: { lusca: { url: endpoint } } }, null, 2),
      },
      {
        k: 'vscode',
        label: 'VS Code',
        steps: ['Add to .vscode/mcp.json, then start it from the MCP view (agent mode):'],
        code: JSON.stringify({ servers: { lusca: { type: 'http', url: endpoint } } }, null, 2),
      },
      {
        k: 'curl',
        label: 'Any client · curl',
        steps: ['Plain JSON-RPC over HTTP POST, no key:'],
        code: `curl -s ${endpoint} \\\n  -H 'Content-Type: application/json' \\\n  -H 'Accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lusca_control","arguments":{"chain":"solana","address":"${PUMP}"}}}'`,
      },
    ],
    [endpoint],
  )
  const [on, setOn] = useState(clients[0].k)
  const c = clients.find((x) => x.k === on) ?? clients[0]
  return (
    <div className="mc-setup">
      <div className="mc-tabs" role="tablist" aria-label="MCP client">
        {clients.map((x) => (
          <button key={x.k} role="tab" aria-selected={x.k === on} className={x.k === on ? 'on' : ''} onClick={() => setOn(x.k)}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="mc-setup-b" role="tabpanel">
        <p className="mc-setup-s">{c.steps[0]}</p>
        <div className="mc-code">
          <pre className="mono">{c.code}</pre>
          <Copy text={c.code} />
        </div>
        {c.steps[1] && <p className="mc-setup-s dim">{c.steps[1]}</p>}
      </div>
    </div>
  )
}

export default function Mcp() {
  useEffect(() => {
    document.title = 'MCP — LUSCA'
  }, [])
  const endpoint = `${window.location.origin}/mcp`
  const [init, setInit] = useState<InitResult | null>(null)
  const [tools, setTools] = useState<ToolInfo[] | null>(null)
  const [load, setLoad] = useState<'loading' | 'ok' | 'error'>('loading')
  const [sel, setSel] = useState<string>(PRESETS[0].tool)
  const [args, setArgs] = useState<Args>(PRESETS[0].args)
  const [ex, setEx] = useState<Exchange | null>(null)
  const [busy, setBusy] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)
  const [view, setView] = useState<'text' | 'structured' | 'raw'>('text')
  const ac = useRef<AbortController | null>(null)
  const ran = useRef(false)

  const tool = tools?.find((t) => t.name === sel)
  const built = useMemo(() => toArgs(tool, args), [tool, args])
  const preview = { jsonrpc: '2.0', id: nextId, method: 'tools/call', params: { name: sel, arguments: built.args } }

  const run = async (name = sel, a: Args = args, list = tools) => {
    const t = list?.find((x) => x.name === name)
    const b = toArgs(t, a)
    if (b.error) {
      setFormErr(b.error)
      return
    }
    setFormErr(null)
    ac.current?.abort()
    const c = new AbortController()
    ac.current = c
    setBusy(true)
    try {
      const r = await rpc('tools/call', { name, arguments: b.args }, c.signal)
      if (!c.signal.aborted) {
        setEx(r)
        setView('text')
      }
    } catch {
      if (!c.signal.aborted) setEx({ request: { jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: b.args } }, status: 0, ms: 0, body: { error: 'the server did not answer' }, at: Date.now() })
    } finally {
      if (!c.signal.aborted) setBusy(false)
    }
  }

  useEffect(() => {
    const c = new AbortController()
    ;(async () => {
      try {
        const i = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'lusca.ink/mcp', version: '1' } }, c.signal)
        const ir = (i.body as { result?: InitResult })?.result
        if (ir) setInit(ir)
        const l = await rpc('tools/list', {}, c.signal)
        const list = (l.body as { result?: { tools?: ToolInfo[] } })?.result?.tools
        if (!list) throw new Error('no tools')
        setTools(list)
        setLoad('ok')
        if (!ran.current) {
          ran.current = true
          void run(PRESETS[0].tool, PRESETS[0].args, list)
        }
      } catch {
        if (!c.signal.aborted) setLoad('error')
      }
    })()
    return () => {
      c.abort()
      ac.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once
  }, [])

  const pick = (name: string, a?: Args) => {
    setSel(name)
    const t = tools?.find((x) => x.name === name)
    const defaults: Args = {}
    for (const [k, s] of Object.entries(t?.inputSchema.properties ?? {})) if (s.default !== undefined) defaults[k] = typeof s.default === 'boolean' ? s.default : String(s.default)
    setArgs(a ?? defaults)
    setFormErr(null)
  }

  const res = (ex?.body as { result?: CallResult; error?: { code: number; message: string } } | null) ?? null
  const result = res?.result
  const text = result?.content?.map((c) => c.text ?? '').join('\n') ?? ''
  const rpcErr = res?.error

  return (
    <div className="mc">
      <header className="mc-hero">
        <div className="mc-hero-l">
          <Kicker n={MCP_NAV_N} name="MCP" className="mc-kick">
            <span className="mc-live mono">
              <span className={load === 'ok' ? 'led on' : 'led'} aria-hidden="true" />
              {load === 'error' ? 'endpoint unreachable' : load === 'ok' ? `endpoint live · ${tools?.length ?? 0} tools` : 'connecting'}
            </span>
          </Kicker>
          <h1 className="mc-title display">
            LUSCA
            <br />
            for agents
          </h1>
          <p className="mc-lede">
            A remote MCP server for Claude, Cursor and any MCP client. Your agent asks; LUSCA answers from what its agents read on Solana, Ethereum, Base and Arbitrum — who
            can change a program’s code and what else that key controls, what changed on-chain, what a contract exposes — with a lusca.ink link for every fact.
          </p>
          <ol className="mc-flow mono" aria-label="How an answer is made">
            <li>any MCP client</li>
            <li className="hot">POST /mcp</li>
            <li>{tools ? tools.map((t) => t.name.replace(/^lusca_/, '').replace(/_.*$/, '')).filter((v, i, a) => a.indexOf(v) === i).join(' · ') : 'lens · control · radar · atlas · scan · stats'}</li>
            <li>facts + links</li>
          </ol>
        </div>
        <div className="mc-end">
          <div className="mc-end-h mono">
            <span>
              <span className="hot">■</span> endpoint · streamable http
            </span>
            <span className="dim">read-only · no key</span>
          </div>
          <div className="mc-url">
            <span className="mc-url-t mono">{endpoint}</span>
            <Copy text={endpoint} label="copy url" />
          </div>
          <Setup endpoint={endpoint} />
          <dl className="mc-spec mono">
            <div>
              <dt>protocol</dt>
              <dd>{init ? `MCP ${init.protocolVersion}` : `MCP ${PROTOCOL}`} · also 2025-03-26</dd>
            </div>
            <div>
              <dt>transport</dt>
              <dd>HTTP POST · JSON-RPC 2.0 · stateless</dd>
            </div>
            <div>
              <dt>server</dt>
              <dd>{init ? `${init.serverInfo.name} ${init.serverInfo.version}` : '—'}</dd>
            </div>
          </dl>
          <span className="mc-tick tl" aria-hidden="true" />
          <span className="mc-tick br" aria-hidden="true" />
        </div>
      </header>

      <section className="mc-x" aria-label="Tools and console">
        <div className="mc-tools">
          <div className="mc-sec-h mono">
            <span>
              <span className="hot">■</span> tools · live from tools/list
            </span>
            <span className="dim">{tools ? `${tools.length} read-only` : ''}</span>
          </div>
          {!tools ? (
            <p className="mc-empty mono">{load === 'error' ? 'Can’t reach /mcp — retrying on reload' : 'Loading tools…'}</p>
          ) : (
            <ol className="mc-tlist">
              {tools.map((t) => {
                const props = Object.entries(t.inputSchema.properties ?? {})
                const req = new Set(t.inputSchema.required ?? [])
                return (
                  <li key={t.name}>
                    <button className={`mc-tool ${t.name === sel ? 'on' : ''}`} aria-pressed={t.name === sel} onClick={() => pick(t.name)}>
                      <span className="mc-tool-n mono">{t.name}</span>
                      <span className="mc-tool-t">{t.title ?? ''}</span>
                      <span className="mc-tool-d">{t.description}</span>
                      <span className="mc-tool-p mono">
                        {props.length ? props.map(([k]) => <i key={k}>{req.has(k) ? `${k}*` : k}</i>) : <i>no arguments</i>}
                        {t.annotations?.openWorldHint ? <b>live chain read</b> : <b className="dim">stored data</b>}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
        </div>

        <div className="mc-con">
          <div className="mc-sec-h mono">
            <span>
              <span className="hot">■</span> call a tool · real JSON-RPC to /mcp
            </span>
            <span className="dim">{ex ? `last answer ${new Date(ex.at).toISOString().slice(11, 19)} UTC` : ''}</span>
          </div>
          <div className="mc-presets" role="group" aria-label="Examples">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className={sel === p.tool && JSON.stringify(args) === JSON.stringify(p.args) ? 'on' : ''}
                onClick={() => {
                  pick(p.tool, p.args)
                  void run(p.tool, p.args)
                }}
                disabled={!tools}
              >
                {p.label}
              </button>
            ))}
          </div>
          <form
            className="mc-form"
            onSubmit={(e) => {
              e.preventDefault()
              void run()
            }}
          >
            <span className="mc-form-n mono">{sel}</span>
            {Object.entries(tool?.inputSchema.properties ?? {}).map(([k, s]) => {
              const req = tool?.inputSchema.required?.includes(k)
              const v = args[k]
              return (
                <label key={k} className={`mc-f ${k === 'address' ? 'wide' : ''}`}>
                  <span className="mono">
                    {k}
                    {req ? '*' : ''}
                  </span>
                  {s.type === 'boolean' ? (
                    <input type="checkbox" checked={v === true} onChange={(e) => setArgs({ ...args, [k]: e.target.checked })} />
                  ) : s.enum ? (
                    <select className="mono" value={String(v ?? '')} onChange={(e) => setArgs({ ...args, [k]: e.target.value })}>
                      {!req && <option value="">any</option>}
                      {s.enum.map((o) => (
                        <option key={String(o)} value={String(o)}>
                          {String(o)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="mono"
                      inputMode={s.type === 'integer' ? 'numeric' : undefined}
                      placeholder={s.type === 'integer' ? `${s.minimum ?? ''}–${s.maximum ?? ''}` : k === 'address' ? 'Solana program id or 0x… contract' : ''}
                      value={String(v ?? '')}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => setArgs({ ...args, [k]: e.target.value })}
                    />
                  )}
                </label>
              )
            })}
            <button className="btn primary mc-go" type="submit" disabled={busy || !tools}>
              {busy ? 'calling…' : 'call ▸'}
            </button>
            {formErr && <span className="mc-ferr mono">{formErr}</span>}
          </form>

          <div className="mc-io">
            <div className="mc-pane">
              <div className="mc-pane-h mono">
                <span>request · POST /mcp</span>
                <Copy text={JSON.stringify(ex?.request ?? preview)} label="copy" />
              </div>
              <pre className="mc-json mono">
                <JsonView value={ex && !busy ? ex.request : preview} />
              </pre>
            </div>
            <div className="mc-pane mc-resp">
              <div className="mc-pane-h mono">
                <span>
                  response
                  {ex && (
                    <>
                      {' · '}
                      <b className={ex.status === 200 && !result?.isError ? '' : 'err'}>{ex.status || 'no answer'}</b> · {ex.ms} ms
                      {result?.isError ? ' · isError' : ''}
                    </>
                  )}
                </span>
                <span className="mc-views" role="group" aria-label="Response view">
                  {(['text', 'structured', 'raw'] as const).map((v) => (
                    <button key={v} className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => setView(v)} disabled={!ex}>
                      {v}
                    </button>
                  ))}
                </span>
              </div>
              {busy && <div className="mc-scan" aria-hidden="true" />}
              {!ex ? (
                <p className="mc-empty mono">{load === 'error' ? 'No answer from /mcp.' : 'Calling…'}</p>
              ) : view === 'text' ? (
                <pre key={ex.at} className={`mc-text mono ${busy ? 'stale' : ''}`}>
                  {rpcErr ? (
                    <span className="err">
                      JSON-RPC error {rpcErr.code}: {rpcErr.message}
                    </span>
                  ) : (
                    text.split('\n').map((line, i) => (
                      <span key={i} className={`ln ${i === 0 ? 'h' : ''}`} style={{ animationDelay: `${Math.min(i, 40) * 22}ms` }}>
                        <Linkified text={line} />
                        {'\n'}
                      </span>
                    ))
                  )}
                </pre>
              ) : (
                <pre className="mc-json mono">
                  <JsonView value={view === 'raw' ? ex.body : (result?.structuredContent ?? null)} />
                </pre>
              )}
            </div>
          </div>
        </div>
      </section>

      <footer className="mc-foot mono">
        <span>
          Read-only, no key, no account. Tools answer from the same stored reads as the LUSCA API; a Lens read of an address LUSCA has not read recently spends LUSCA Lens’s shared
          daily budget. Per address: 90 requests and 40 tool calls a minute. Answers state what was read and where; they make no judgment about any project, team or contract.
        </span>
      </footer>
    </div>
  )
}
