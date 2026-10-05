const intFmt = new Intl.NumberFormat('en-US')

/** What every live number shows when there is no server value for it. */
export const DASH = '—'

/** A real, finite number (null / undefined / NaN / ±Infinity are "no value"). */
export function hasNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

export function fmtInt(n: number | null | undefined): string {
  if (!hasNum(n)) return DASH
  return intFmt.format(Math.round(n))
}

export function fmtCompact(n: number | null | undefined, digits = 1): string {
  if (!hasNum(n)) return DASH
  const a = Math.abs(n)
  if (a >= 1e12) return (n / 1e12).toFixed(digits) + 'T'
  if (a >= 1e9) return (n / 1e9).toFixed(digits) + 'B'
  if (a >= 1e6) return (n / 1e6).toFixed(digits) + 'M'
  if (a >= 1e4) return (n / 1e3).toFixed(digits) + 'k'
  return fmtInt(n)
}

export function fmtBytes(n: number | null | undefined): string {
  if (!hasNum(n)) return DASH
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GB'
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB'
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + ' KB'
  return n + ' B'
}

export function fmtDur(sec: number): string {
  sec = Math.max(0, Math.floor(sec))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function fmtAgo(ts: number, now = Date.now()): string {
  const d = Math.max(0, (now - ts) / 1000)
  if (d < 1) return 'now'
  if (d < 60) return `${Math.floor(d)}s`
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h`
  return `${Math.floor(d / 86400)}d`
}

export function fmtClock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`
}

export function fmtClockMs(ts: number): string {
  const d = new Date(ts)
  return `${fmtClock(ts)}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`
}

export function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

export function shortUrl(url: string, max = 64): string {
  const s = url.replace(/^https?:\/\//, '').replace(/^www\./, '')
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function pathOf(url: string, max = 56): string {
  try {
    const u = new URL(url)
    const p = u.pathname + u.search
    return p.length > max ? p.slice(0, max - 1) + '…' : p
  } catch {
    return url
  }
}

/** Fixed decimals, or "—" when there is no value. */
export function fmtFixed(n: number | null | undefined, digits: number): string {
  return hasNum(n) ? n.toFixed(digits) : DASH
}

export function fmtGflops(g: number | null | undefined): string {
  if (!hasNum(g)) return DASH
  if (g >= 1000) return (g / 1000).toFixed(1) + ' TFLOPS'
  return g.toFixed(0) + ' GFLOPS'
}
