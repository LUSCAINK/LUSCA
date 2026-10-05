// Render-error safety net + stale-deploy recovery.
//
// After a deploy, an open tab still references the previous build's hashed
// chunks; the server 404s them and every lazy route throws. `reloadOnce` reloads
// the page a single time to pick up the new build, guarded by sessionStorage so
// a chunk that is genuinely broken can never cause a reload loop. Anything else
// that throws while rendering shows a branded "something broke — reload" panel
// instead of a black screen.
import { Component, type ErrorInfo, type ReactNode } from 'react'
import './shell/error.css'

const RELOAD_KEY = 'lusca.reloadAt'

function envSeconds(v: unknown, fallback: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** A second automatic reload inside this window is refused (loop guard). */
const RELOAD_GUARD_MS = envSeconds(import.meta.env.VITE_LUSCA_RELOAD_GUARD_S, 60) * 1000

const CHUNK_RE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (?:CSS )?chunk [\w-]+ failed|ChunkLoadError|is not a valid JavaScript MIME type/i

let reloading = false

/** True for errors thrown when a code-split chunk (JS or CSS) cannot be fetched. */
export function isChunkLoadError(e: unknown): boolean {
  if (e == null) return false
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : typeof e === 'string' ? e : String((e as { message?: unknown }).message ?? '')
  return CHUNK_RE.test(msg)
}

/**
 * Reload the page once to pick up a newer build. Returns false — and does
 * nothing — when it already reloaded within the guard window or sessionStorage
 * is unavailable (no way to prove we are not looping).
 */
export function reloadOnce(reason: string): boolean {
  if (reloading) return true
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Number.isFinite(last) && Date.now() - last < RELOAD_GUARD_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    return false
  }
  reloading = true
  console.warn(`[lusca] ${reason}; reloading once to pick up the current build`)
  window.location.reload()
  return true
}

/** Window-level hooks: Vite's preload failures and chunk errors outside React. Call once at startup. */
export function installReloadOnStaleBuild() {
  window.addEventListener('vite:preloadError', (e) => {
    // only swallow the error when we really reload; otherwise let it reach the boundary
    if (reloadOnce('a code chunk failed to preload')) e.preventDefault()
  })
  window.addEventListener('unhandledrejection', (e) => {
    if (isChunkLoadError(e.reason)) reloadOnce('a code chunk failed to load')
  })
}

interface Props {
  children: ReactNode
  /** 'page' fills the shell's content area; 'full' takes the whole viewport (no shell around it). */
  variant?: 'page' | 'full'
  /** Changing this clears the error (e.g. the route path), so navigating away recovers. */
  resetKey?: string
}

interface State {
  error: Error | null
  chunk: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, chunk: false }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return {
      error: error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown error'),
      chunk: isChunkLoadError(error) || reloading,
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[lusca] view crashed', error, info.componentStack)
    // re-render as "new build · reloading…" while the reload is under way
    if (isChunkLoadError(error) && reloadOnce('a route chunk failed to load')) this.setState({ chunk: true })
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, chunk: false })
  }

  render() {
    const { error, chunk } = this.state
    if (!error) return this.props.children
    return <CrashPanel error={error} chunk={chunk} variant={this.props.variant ?? 'page'} />
  }
}

function CrashPanel({ error, chunk, variant }: { error: Error; chunk: boolean; variant: 'page' | 'full' }) {
  const detail = `${error.name}: ${error.message}`.slice(0, 280)
  const home = import.meta.env.BASE_URL || '/'
  return (
    <section className={`eb eb-${variant}`} role="alert" aria-labelledby="eb-title">
      <div className="eb-frame brackets">
        <header className="eb-top mono">
          <span className="tag solid">{chunk ? 'ERR · BUILD' : 'ERR · CLIENT'}</span>
          <span className="eb-top-t">{chunk ? 'lusca/client · chunk not found' : 'lusca/client · render fault'}</span>
        </header>
        <div className="eb-body">
          <span className="label">
            <span className="hot">00</span>&nbsp;&nbsp;status
          </span>
          <h1 id="eb-title" className="display eb-title">
            {reloading ? 'new build' : 'something broke'}
          </h1>
          <p className="eb-sub">
            {reloading
              ? 'LUSCA was updated while this tab was open. Reloading…'
              : chunk
                ? 'Part of the app could not be downloaded, usually because a new version was just deployed or the server is restarting. Reload to get the current build.'
                : 'This view hit an error and stopped drawing. The arms are fine; reloading the page usually brings it back.'}
          </p>
          <pre className="eb-msg mono">{detail}</pre>
          <div className="eb-actions">
            <button type="button" className="btn primary lg" onClick={() => window.location.reload()}>
              Reload
            </button>
            <a className="btn lg" href={home}>
              <span aria-hidden="true">←</span> Surface
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
