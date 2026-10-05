import { useEffect, useId, useRef, useState } from 'react'
import { useSampled } from '@/lib/hooks'
import { shortAddr, useWallet } from '@/lib/wallet'

/** The public build (dist/neuron.mjs, scripts/build-neuron.mjs) defaults --server to this. */
const PUBLIC_WS = 'wss://lusca.ink/ws'
const PUBLIC_ORIGIN = 'https://lusca.ink'
const SOURCE_URL = 'https://github.com/LUSCAINK/LUSCA'
const SOURCE_FILE_URL = `${SOURCE_URL}/blob/main/scripts/neuron.ts`

function defaultServer(): string {
  if (typeof location === 'undefined') return PUBLIC_WS
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // In dev the page is served by Vite (which only proxies /ws); point straight at the hub.
  if (import.meta.env.DEV) return `ws://${location.hostname}:8787/ws`
  return `${proto}://${location.host}/ws`
}

/** Where to download the bundle: this server's own copy in production, the public one in dev. */
function downloadUrl(): string {
  if (typeof location === 'undefined' || import.meta.env.DEV) return `${PUBLIC_ORIGIN}/neuron.mjs`
  return `${location.origin}/neuron.mjs`
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

type Os = 'windows' | 'macos' | 'linux'

const OS_LABEL: Record<Os, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }
const OS_SHELL: Record<Os, string> = { windows: 'PowerShell', macos: 'Terminal', linux: 'shell' }
const OS_NODE: Record<Os, string> = {
  windows: 'winget install OpenJS.NodeJS.LTS',
  macos: 'brew install node',
  linux: 'your package manager or nodejs.org (node --version must print v20 or newer)',
}
const OS_HASH: Record<Os, string> = {
  windows: 'Get-FileHash neuron.mjs',
  macos: 'shasum -a 256 neuron.mjs',
  linux: 'sha256sum neuron.mjs',
}

function guessOs(): Os {
  if (typeof navigator === 'undefined') return 'windows'
  const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
  if (p.includes('win')) return 'windows'
  if (p.includes('mac') || p.includes('iphone') || p.includes('ipad')) return 'macos'
  return 'linux'
}

/** Copy feedback that resets itself. */
function useCopied(): [state: 'idle' | 'ok' | 'fail', set: (ok: boolean) => void] {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return [
    state,
    (ok: boolean) => {
      setState(ok ? 'ok' : 'fail')
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setState('idle'), 1800)
    },
  ]
}

const SAFE_LABEL = /[^A-Za-z0-9 ._·-]/g

export function DesktopPanel() {
  const conn = useSampled((s) => s.conn, 500)
  const verified = useWallet((s) => (s.status === 'verified' && s.session ? s.session : null))
  const [os, setOs] = useState<Os>(guessOs)
  const [label, setLabel] = useState('my-rig')
  const [withToken, setWithToken] = useState(false)
  const tokenId = useId()
  const labelId = useId()
  const [copied, setCopied] = useCopied()
  const [tokenCopied, setTokenCopied] = useCopied()
  const codeRef = useRef<HTMLSpanElement>(null)

  const cleanLabel = label.replace(SAFE_LABEL, '').trim().slice(0, 40)
  const server = defaultServer()
  const url = downloadUrl()
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s)

  const run = ['node neuron.mjs']
  // The bundle already points at wss://lusca.ink/ws; name the server only when this page is another one.
  if (server !== PUBLIC_WS) run.push(`--server ${server}`)
  if (cleanLabel) run.push(`--label ${quote(cleanLabel)}`)
  // The sign-in token is a credential: put in the command only on request, never by default.
  const useToken = withToken && !!verified
  if (useToken && verified) run.push(`--auth ${verified.token}`)
  const download = os === 'windows' ? `curl.exe -fLo neuron.mjs ${url}` : `curl -fLo neuron.mjs ${url}`
  const cmd = [`# 1. download the neuron (one file, no install)`, download, `# 2. run it (Node 20 or newer)`, run.join(' ')].join('\n')

  const onCopy = async () => {
    const ok = await copyText(cmd)
    setCopied(ok)
    if (!ok && codeRef.current) {
      // Clipboard blocked: select the command so a manual copy is one keystroke away.
      const range = document.createRange()
      range.selectNodeContents(codeRef.current)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }

  const onCopyToken = async () => {
    if (!verified) return
    setTokenCopied(await copyText(verified.token))
  }

  return (
    <div className="nd-grid desk-grid">
      <div className="nd-cell desk-cmd">
        <div className="panel-head">
          <span>
            <span className="hot">A</span>&nbsp;&nbsp;<b>Run it on your computer</b>
          </span>
          <span className="nd-meta">single file · node 20+ · no install</span>
        </div>
        <div className="dk-body">
          <div className="dk-field">
            <label htmlFor={labelId} className="label">
              name on the leaderboard
            </label>
            <input
              id={labelId}
              className="dk-input mono"
              value={label}
              maxLength={40}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div className="dk-field">
            <span className="label">desktop token</span>
            {verified ? (
              <>
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <button type="button" className={`btn ${tokenCopied === 'ok' ? 'primary' : ''}`} onClick={() => void onCopyToken()}>
                    {tokenCopied === 'ok' ? 'token copied' : tokenCopied === 'fail' ? 'clipboard blocked' : 'Copy desktop token'}
                  </button>
                  <span className="dk-hint mono">wallet {shortAddr(verified.wallet)} · valid until {new Date(verified.expiresAt).toISOString().slice(0, 10)}</span>
                </span>
                <label htmlFor={tokenId} className="dk-check mono">
                  <input id={tokenId} type="checkbox" checked={withToken} onChange={(e) => setWithToken(e.target.checked)} /> put the token in the command
                  (--auth)
                </label>
                <span className="dk-hint mono">
                  {useToken
                    ? `INK from that machine goes to ${shortAddr(verified.wallet)} · the token is a credential, keep the command private`
                    : 'add --auth followed by the token to the run line, or tick the box above · the token is a credential, keep it private'}
                </span>
              </>
            ) : (
              <span className="dk-hint mono">
                connect and verify your wallet on this page to get a desktop token (--auth). without it, INK is credited to that machine’s device
                account and is not paid in SOL.
              </span>
            )}
          </div>

          <div className="code">
            <div className="code-bar mono">
              <span role="group" aria-label="operating system">
                <span className="code-dot" aria-hidden="true" />
                {(Object.keys(OS_LABEL) as Os[]).map((o) => (
                  <button
                    key={o}
                    type="button"
                    className={`btn ${os === o ? 'primary' : ''}`}
                    aria-pressed={os === o}
                    onClick={() => setOs(o)}
                    style={{ height: 26, padding: '0 10px' }}
                  >
                    {OS_LABEL[o]}
                  </button>
                ))}
              </span>
              <button type="button" className={`btn code-copy ${copied === 'ok' ? 'primary' : ''}`} onClick={() => void onCopy()} aria-label="Copy commands to clipboard">
                {copied === 'ok' ? 'copied' : copied === 'fail' ? 'selected · ctrl-c' : 'copy'}
              </button>
            </div>
            <pre className="code-pre mono" tabIndex={0} aria-label={`Commands for ${OS_LABEL[os]} ${OS_SHELL[os]}`}>
              <code>
                <span ref={codeRef}>{cmd}</span>
              </code>
            </pre>
          </div>
          <span className="sr-only" aria-live="polite">
            {copied === 'ok'
              ? 'Commands copied'
              : copied === 'fail'
                ? 'Clipboard blocked — the commands are selected, press Ctrl-C or Cmd-C to copy them'
                : tokenCopied === 'ok'
                  ? 'Desktop token copied'
                  : ''}
          </span>
          <span className="dk-hint mono">
            paste into {OS_SHELL[os]} · no Node yet? {OS_NODE[os]} · check the file: {OS_HASH[os]} matches{' '}
            <a href={`${url}.sha256`} target="_blank" rel="noreferrer">
              neuron.mjs.sha256
            </a>{' '}
            · source:{' '}
            <a href={SOURCE_FILE_URL} target="_blank" rel="noreferrer">
              scripts/neuron.ts
            </a>
          </span>
          {conn !== 'live' && (
            <p className="nd-note mono">
              the LUSCA server is not reachable from this page right now. the desktop neuron keeps retrying until it answers at{' '}
              <span className="nowrap">{server}</span>.
            </p>
          )}
        </div>
      </div>
      <div className="nd-cell desk-how">
        <div className="panel-head">
          <span>
            <span className="hot">B</span>&nbsp;&nbsp;<b>What it does</b>
          </span>
          <span className="nd-meta">
            <a href={SOURCE_URL} target="_blank" rel="noreferrer">
              open source
            </a>
          </span>
        </div>
        <ol className="dk-steps">
          <li>
            <span className="dk-n mono">1</span>
            <span>
              <b>Benchmarks</b> one CPU thread, times one SEPIA gradient and reports its speed in GFLOPS.
            </span>
          </li>
          <li>
            <span className="dk-n mono">2</span>
            <span>
              <b>Connects</b> to the LUSCA server, which sets its tier from that score.
            </span>
          </li>
          <li>
            <span className="dk-n mono">3</span>
            <span>
              <b>Trains SEPIA.</b> The server sends a batch of corpus text and the current weights; the neuron computes the training gradient and
              sends it back. The server checks every gradient against its own computation on part of the batch, fully recomputes a share of them,
              and applies accepted gradients to the model with its optimizer. Dedupe jobs run in between.
            </span>
          </li>
          <li>
            <span className="dk-n mono">4</span>
            <span>
              <b>Earns INK.</b> Training INK is pending until the next full audit of your neuron passes, then confirmed. A failed audit forfeits
              the pending INK. Only confirmed INK counts toward SOL payouts.
            </span>
          </li>
          <li>
            <span className="dk-n mono">5</span>
            <span>
              <b>Reconnects</b> on its own if the connection drops. Press Ctrl-C to stop.
            </span>
          </li>
        </ol>
        <dl className="nd-kv dk-flags">
          <div>
            <dt>--auth</dt>
            <dd>desktop token from this page (verify a wallet, then Copy desktop token) · valid 30 days · keep it private</dd>
          </div>
          <div>
            <dt>--label</dt>
            <dd>name on the leaderboard · default: cpu model</dd>
          </div>
          <div>
            <dt>--server</dt>
            <dd>LUSCA server address · default {PUBLIC_WS}</dd>
          </div>
          <div>
            <dt>--keypair</dt>
            <dd>
              path to a dedicated payout-only keypair JSON (solana-keygen new -o lusca-payout.json), never a wallet that holds funds. The neuron
              signs the plain-text sign-in message locally; the key never leaves the machine and no transaction is made. --auth avoids key files
              entirely
            </dd>
          </div>
          <div>
            <dt>(neither)</dt>
            <dd>INK is credited to that machine’s device account · no SOL payouts</dd>
          </div>
          <div>
            <dt>--no-train</dt>
            <dd>dedupe jobs only, no SEPIA training</dd>
          </div>
          <div>
            <dt>--jobs</dt>
            <dd>exit after n verified jobs · default: run until ctrl-c</dd>
          </div>
          <div>
            <dt>--quiet</dt>
            <dd>failures + a summary every 25 jobs only</dd>
          </div>
        </dl>
      </div>
    </div>
  )
}
