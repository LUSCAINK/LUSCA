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

/**
 * Control characters (C0, DEL, C1), zero-width and bidi controls, line / paragraph separators: never inside
 * one line of an answer. Strings published by a deployer (IDL and ABI names, security.txt, contract names,
 * source paths, guards quoted from source) pass through here, so they cannot start a line of their own or
 * reorder what a reader sees.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g

/** A third-party string made safe for one line of text: no control / bidi characters, whitespace collapsed, length capped. */
export function safe(s: unknown, max = 160): string {
  const t = String(s ?? '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** A published name as data: a plain identifier or signature stays bare (`buy`, `setFee(uint256)`); anything else is quoted. */
export function nm(s: unknown, max = 64): string {
  const t = safe(s, max)
  return /^[\w.$@/\-()[\],]{1,64}$/.test(t) ? t : JSON.stringify(t)
}

/** A program / contract name for a heading line ('(no name)' when none was read). */
export const title = (s: string | null | undefined): string => (s ? nm(s) : '(no name)')

/** The lines of an answer joined; each line stays one line (a stray line break inside a value becomes a space). */
export const lines = (out: readonly string[]): string => out.map((l) => l.replace(UNSAFE, ' ')).join('\n')

/** First `max` items joined, with "+N more" when cut (`total`: the full count when `items` is already a capped slice). */
export function list(items: readonly string[], max: number, sep = ', ', total = items.length): string {
  if (!items.length) return 'none'
  const shown = Math.min(max, items.length)
  const text = items.slice(0, shown).map((x) => safe(x, 200)).join(sep)
  const n = Math.max(total, items.length)
  return n > shown ? `${text}${sep}+${n - shown} more` : text
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

/**
 * A source path as the rest of the site shows it: a developer's absolute build path ('/Users/<name>/<repo>/
 * contracts/A.sol', 'C:/work/…') is cut to the project's own tree (the last contracts/ src/ lib/ packages/
 * segment, or what follows node_modules/), else to the file name. Relative paths stay as published.
 */
export function srcPath(p: unknown, max = 160): string {
  const s = String(p ?? '').replace(/\\/g, '/')
  const nmod = s.lastIndexOf('node_modules/')
  if (nmod >= 0) return safe(s.slice(nmod + 'node_modules/'.length), max)
  const abs = /^(\/|~\/|[A-Za-z]:\/)/.test(s) || /(^|\/)(Users|home|root)\//.test(s)
  if (!abs) return safe(s, max)
  let cut = -1
  for (const m of s.matchAll(/\/(contracts|src|lib|packages)\//g)) cut = (m.index ?? 0) + 1
  return safe(cut >= 0 ? s.slice(cut) : s.slice(s.lastIndexOf('/') + 1), max)
}

/** The hop's Safe threshold / timelock delay, unless its label already says it ('Safe 2 of 3', 'Timelock 48h'). */
export function hopExtra(h: { label: string; threshold?: number; owners?: number; delay?: number }): string {
  const th = h.threshold && !new RegExp(`\\b${h.threshold} of\\b`).test(h.label) ? ` (${h.threshold} of ${h.owners ?? '?'})` : ''
  const dl = h.delay && !/\d\s*h\b|delay/i.test(h.label) ? ` (delay ${Math.round(h.delay / 3600)} h)` : ''
  return th + dl
}
