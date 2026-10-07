// Small text helpers for tool answers: plain, compact, unambiguous for a model to quote.

export const DASH = '—'

export const int = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? DASH : Math.round(v).toLocaleString('en-US'))

export function bytes(b: number | null | undefined): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return DASH
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB`
  return `${b} B`
}

export const iso = (ts: number | null | undefined): string => (ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : DASH)

export function ago(ts: number | null | undefined, now: number): string {
  if (!ts) return DASH
  const s = Math.max(0, (now - ts) / 1000)
  if (s < 90) return `${Math.round(s)} s ago`
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export const pct = (a: number, b: number): string => (b > 0 ? `${((a / b) * 100).toFixed(a / b >= 0.1 || a === 0 ? 0 : 1)}%` : DASH)

/** First `max` items joined, with "+N more" when cut. */
export function list(items: readonly string[], max: number, sep = ', '): string {
  if (!items.length) return 'none'
  const shown = items.slice(0, max).join(sep)
  return items.length > max ? `${shown}${sep}+${items.length - max} more` : shown
}

/** Cut a text to at most `max` characters on a line boundary, saying so. */
export function bound(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf('\n', max - 60)
  return text.slice(0, cut > 0 ? cut : max - 60) + '\n… (answer shortened; the links above hold the full record)'
}

/** yes / no / not known. */
export const yesNo = (v: boolean | null | undefined): string => (v === null || v === undefined ? 'not known' : v ? 'yes' : 'no')

/** Endpoint wording is not part of tool answers: 'Base public RPC' / 'PublicNode' / 'public websocket' → 'RPC' / 'websocket'. */
export function scrub(text: string): string {
  return text
    .replace(/\b(?:(?:Solana|Ethereum|Base|Arbitrum) )?public (RPC|node|websocket)s?\b/gi, (_m, w: string) => (w.toLowerCase() === 'websocket' ? 'websocket' : 'RPC'))
    .replace(/PublicNode/g, 'RPC')
}
