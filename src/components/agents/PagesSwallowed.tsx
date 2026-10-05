import type { PageRecord } from '@shared/protocol'
import { Highlight, Meter } from '@/components/obs/parts'
import { useNow } from '@/lib/hooks'
import { fmtAgo, fmtInt, pathOf } from '@/lib/format'
import { TASTE_MIN, cleanHost, readableTitle } from './util'

export function PagesSwallowed({ pages, name }: { pages: PageRecord[]; name: string }) {
  const now = useNow(5000)
  if (pages.length === 0) {
    return (
      <div className="pg-empty">
        <span className="label">no pages kept yet</span>
        <p className="dim">
          Pages {name} keeps show up here the moment they pass the taste score and duplicate check — with title, website, size and the crypto terms that made them relevant.
        </p>
      </div>
    )
  }
  return (
    <ol className="pg-list">
      {pages.map((p) => (
        <li key={p.id} className="pg">
          <a href={p.url} target="_blank" rel="noreferrer noopener" className="pg-a">
            <div className="pg-top">
              <span className={`pg-score num ${p.score >= TASTE_MIN ? 'hot' : 'dim'}`}>{p.score.toFixed(2)}</span>
              <Meter value={p.score} threshold={TASTE_MIN} segments={16} />
              <span className="pg-tok num">+{fmtInt(p.tokens)} tok</span>
              <span className="pg-ago num">{fmtAgo(p.ts, now)}</span>
            </div>
            <div className="pg-t">
              <Highlight text={readableTitle(p.title, p.url, p.host)} terms={p.terms} />
            </div>
            <div className="pg-u mono">
              <b>{cleanHost(p.host)}</b>
              {pathOf(p.url, 54)} <span aria-hidden="true">↗</span>
              <span className="sr-only">(opens in a new tab)</span>
            </div>
            {p.excerpt && p.excerpt.length > 24 && (
              <p className="pg-x">
                <Highlight text={p.excerpt.slice(0, 220)} terms={p.terms} />…
              </p>
            )}
            {p.terms.length > 0 && (
              <div className="pg-terms">
                {[...new Set(p.terms)].slice(0, 6).map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
                <span className="pg-meta num">
                  d{p.depth} · {p.links} links
                </span>
              </div>
            )}
          </a>
        </li>
      ))}
    </ol>
  )
}
