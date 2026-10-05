// Connection status, said the same way on every page. Live numbers elsewhere are
// gated on `useIsLive()` (src/lib/hooks.ts) and read "—" whenever this is not live.
import { useConn } from '@/lib/hooks'
import { CONN_LABEL, CONN_TEXT, type ConnState } from '@/lib/store'
import './conn.css'

/** Class for the status LED: orange pulse when live, white pulse while connecting, grey when unreachable. */
export function connLed(conn: ConnState): string {
  return conn === 'live' ? 'led on pulse' : conn === 'connecting' ? 'led white pulse' : 'led'
}

/** LED + short label (LIVE / CONNECTING / UNREACHABLE). */
export function ConnBadge({ className = '' }: { className?: string }) {
  const conn = useConn()
  return (
    <span className={`conn-badge ${className}`} title={CONN_TEXT[conn]}>
      <span className={connLed(conn)} aria-hidden="true" /> {CONN_LABEL[conn]}
    </span>
  )
}

/** One status line while the server is not live ("Can't reach the LUSCA server — reconnecting…"); nothing when live. */
export function ConnNote({ className = '', live }: { className?: string; live?: string }) {
  const conn = useConn()
  if (conn === 'live' && !live) return null
  return (
    <p className={`conn-note mono ${conn === 'live' ? 'is-live' : ''} ${className}`} role="status">
      <span className={connLed(conn)} aria-hidden="true" />
      <span>{conn === 'live' ? live : CONN_TEXT[conn]}</span>
    </p>
  )
}
