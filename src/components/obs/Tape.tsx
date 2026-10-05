import { useConn, useSampled } from '@/lib/hooks'
import { CONN_TEXT } from '@/lib/store'
import { fmtClock, fmtCompact, shortUrl } from '@/lib/format'
import { SECTORS } from '@shared/sectors'

interface Ev {
  ts: number
  kind: 'page' | 'reject' | 'host'
  text: string
  meta: string
  url?: string
}

export function Tape({ limit = 40 }: { limit?: number }) {
  const conn = useConn(500)
  const evs = useSampled((s) => {
    const out: Ev[] = []
    for (const p of s.pages.slice(0, limit)) {
      out.push({ ts: p.ts, kind: 'page', text: p.title || shortUrl(p.url, 60), meta: `${SECTORS[p.sector]?.roman ?? ''} · ${p.host.replace(/^www\./, '')} · +${fmtCompact(p.tokens)} tok · ${p.score.toFixed(2)}`, url: p.url })
    }
    for (const r of s.rejects.slice(0, Math.round(limit / 2))) {
      out.push({ ts: r.ts, kind: 'reject', text: shortUrl(r.url, 60), meta: r.reason })
    }
    for (const d of Object.values(s.domains)) {
      if (d.discovered && d.firstSeen > Date.now() - 30 * 60_000) out.push({ ts: d.firstSeen, kind: 'host', text: d.host, meta: `new host admitted to arm ${SECTORS[d.sector]?.roman ?? '?'}` })
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, limit)
  }, 250)

  return (
    <ol className="tape">
      {evs.map((e) => (
        <li key={`${e.ts}-${e.kind}-${e.text}`} className={`tp tp-${e.kind}`}>
          <span className="tp-t num">{fmtClock(e.ts)}</span>
          <span className="tp-k">{e.kind === 'page' ? '＋' : e.kind === 'reject' ? '✕' : '◆'}</span>
          <span className="tp-x">
            {e.url ? (
              <a href={e.url} target="_blank" rel="noreferrer noopener">
                {e.text}
              </a>
            ) : (
              e.text
            )}
            <span className="tp-m">{e.meta}</span>
          </span>
        </li>
      ))}
      {!evs.length && <li className="tp tp-empty label">{conn === 'live' ? 'waiting for the first page…' : CONN_TEXT[conn]}</li>}
    </ol>
  )
}
