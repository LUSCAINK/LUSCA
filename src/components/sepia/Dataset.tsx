// DATASET — what the eight arms brought back, i.e. what SEPIA is reading.
import { useMemo, useState } from 'react'
import { SECTORS, ROMAN } from '@shared/sectors'
import { useSampled } from '@/lib/hooks'
import { fmtBytes, fmtInt } from '@/lib/format'
import { CORPUS_CAP, HP, fmtC } from './model'

type Metric = 'tokens' | 'pages'

export function Dataset() {
  const sectors = useSampled((s) => s.sectors, 1000)
  const stats = useSampled((s) => s.stats, 1000)
  const domains = useSampled((s) => s.domains, 2000)
  const model = useSampled((s) => s.model, 1000)
  const [metric, setMetric] = useState<Metric>('tokens')

  const tokTotal = sectors.reduce((a, s) => a + s.tokens, 0)
  const m: Metric = metric === 'tokens' && tokTotal === 0 ? 'pages' : metric

  const rows = SECTORS.map((sec) => {
    const info = sectors.find((x) => x.id === sec.id)
    return { sec, v: info ? info[m] : 0, pages: info?.pages ?? 0, tokens: info?.tokens ?? 0, agents: info?.agents ?? 0 }
  })
  const max = Math.max(1, ...rows.map((r) => r.v))
  const total = rows.reduce((a, r) => a + r.v, 0)
  const sorted = rows.map((r) => r.v).sort((a, b) => b - a)
  const lead = sorted[0] > sorted[1] ? rows.find((r) => r.v === sorted[0]) : undefined

  const hosts = useMemo(
    () =>
      Object.values(domains)
        .sort((a, b) => b.pages - a.pages || b.tokens - a.tokens)
        .slice(0, 10),
    [domains],
  )
  const hostMax = Math.max(1, hosts[0]?.pages ?? 1)

  return (
    <div className="ds">
      <section className="ds-arms panel" aria-labelledby="ds-arms-h">
        <div className="panel-head">
          <span id="ds-arms-h">
            <span className="hot">E</span>&nbsp;&nbsp;<b>Pages by arm</b>
            <span className="lc-unit">&nbsp;&nbsp;{m === 'tokens' ? 'tokens kept' : 'pages kept'}</span>
          </span>
          <span className="seg" role="group" aria-label="bar metric">
            <button type="button" aria-pressed={m === 'tokens'} className={m === 'tokens' ? 'on' : ''} onClick={() => setMetric('tokens')} disabled={tokTotal === 0} title={tokTotal === 0 ? 'this feed reports no per-arm token counts' : undefined}>
              tokens
            </button>
            <button type="button" aria-pressed={m === 'pages'} className={m === 'pages' ? 'on' : ''} onClick={() => setMetric('pages')}>
              pages
            </button>
          </span>
        </div>
        <ol className="ds-bars">
          {rows.map((r) => {
            const pct = (r.v / max) * 100
            const share = total ? (r.v / total) * 100 : 0
            const isLead = r === lead && r.v > 0
            return (
              <li key={r.sec.id} className={`ds-row ${isLead ? 'lead' : ''}`}>
                <span className="ds-roman" aria-hidden="true">
                  {r.sec.roman}
                </span>
                <span className="ds-name">
                  <span className="ds-n">
                    <span className="sr-only">arm {r.sec.roman}, </span>
                    {r.sec.name}
                  </span>
                  <span className="ds-blurb">{r.sec.blurb}</span>
                </span>
                <span className="ds-bar" aria-hidden="true">
                  <i style={{ width: `${pct}%` }} />
                </span>
                <span className="ds-v num">{fmtC(r.v)}</span>
                <span className="ds-pct num">{share.toFixed(1)}%</span>
              </li>
            )
          })}
        </ol>
        <div className="ds-axis mono" aria-hidden="true">
          <span className="ds-axis-in">
            <span>0</span>
            <span>{fmtC(max / 2)}</span>
            <span>{fmtC(max)}</span>
          </span>
        </div>
      </section>

      <section className="ds-hosts panel" aria-labelledby="ds-hosts-h">
        <div className="panel-head">
          <span id="ds-hosts-h">
            <span className="hot">F</span>&nbsp;&nbsp;<b>Top websites</b>
          </span>
          <span>by pages · of {fmtInt(stats.domains || Object.keys(domains).length)}</span>
        </div>
        {hosts.length ? (
          <table className="ds-table">
            <thead>
              <tr>
                <th scope="col" className="c-i">#</th>
                <th scope="col">host</th>
                <th scope="col" className="c-arm">arm</th>
                <th scope="col" className="c-n">pages</th>
                <th scope="col" className="c-n c-tok">tokens</th>
                <th scope="col" className="c-n c-taste">taste</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((d, i) => (
                <tr key={d.host}>
                  <td className="c-i num">{String(i + 1).padStart(2, '0')}</td>
                  <td className="c-host">
                    <span className="ds-host">{d.host}</span>
                    <span className="ds-hbar" aria-hidden="true">
                      <i style={{ width: `${(d.pages / hostMax) * 100}%` }} />
                    </span>
                  </td>
                  <td className="c-arm num">{ROMAN[d.sector] ?? '—'}</td>
                  <td className="c-n num">{fmtInt(d.pages)}</td>
                  <td className="c-n c-tok num">{d.tokens ? fmtC(d.tokens) : '—'}</td>
                  <td className="c-n c-taste num">{d.avgScore ? d.avgScore.toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="ds-empty mono">no hosts reported yet</p>
        )}
      </section>

      <section className="ds-tot panel" aria-labelledby="ds-tot-h">
        <div className="panel-head">
          <span id="ds-tot-h">
            <span className="hot">G</span>&nbsp;&nbsp;<b>Totals</b>
          </span>
          <span>fetch → corpus</span>
        </div>
        <dl className="ds-grid">
          <Tot k="pages accepted" v={fmtInt(stats.pages)} sub="lifetime" />
          <Tot k="tokens accepted" v={fmtC(stats.tokens)} sub="lifetime" />
          <Tot
            k="held on disk"
            v={stats.heldPages == null ? '—' : `${fmtInt(stats.heldPages)} pg`}
            sub={
              stats.heldPages == null
                ? 'not reported by this server'
                : `${fmtC(stats.heldTokens ?? 0)} tok · ${fmtBytes(stats.heldBytes ?? 0)}${stats.heldUncounted ? ` · +${stats.heldUncounted} older archive file${stats.heldUncounted === 1 ? '' : 's'}${stats.heldUncountedBytes ? ` (${fmtBytes(stats.heldUncountedBytes)})` : ''} not counted` : ''}`
            }
          />
          <Tot k="raw html" v={fmtBytes(stats.bytes)} />
          <Tot k="hosts" v={fmtInt(stats.domains)} />
          <Tot k="rejected" v={fmtInt(stats.rejected)} />
          <Tot k="near-dupes" v={fmtInt(stats.dupes)} />
          <Tot k="frontier" v={fmtC(stats.frontier)} />
          <Tot k="sepia corpus" v={`${fmtC(model.corpusChars)} ch`} hot sub={`cap ${fmtC(CORPUS_CAP)} · oldest evicted`} />
          <Tot k="held out" v={`1 / ${HP.holdoutEvery}`} sub="docs → validation" />
          <Tot k="arms" v={`${ROMAN.length}`} sub={`${stats.agentsTotal} agents`} />
        </dl>
      </section>
    </div>
  )
}

function Tot({ k, v, sub, hot }: { k: string; v: string; sub?: string; hot?: boolean }) {
  return (
    <div className={`ds-t ${hot ? 'hot-t' : ''}`}>
      <dt className="label">{k}</dt>
      <dd className="num">{v}</dd>
      {sub && <dd className="ds-t-s mono">{sub}</dd>}
    </div>
  )
}
