// The Exposure Map: real counts over what LUSCA already tracks (the Control Map's kept programs and contracts),
// grouped by who can change them and whether that key is public. Served by GET /api/exposure/summary from
// stored data; each bucket carries its n and the sentence that says what it counts.
import { Link } from 'react-router-dom'
import { fmtUtc } from '@/lib/chain'
import { DASH, fmtInt } from '@/lib/format'
import type { ExposureBucket, ExposureGroup, ExposureSummary } from '@/lib/exposure-types'

const share = (n: number, d: number) => {
  if (!d) return DASH
  const v = (n / d) * 100
  return `${v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)}%`
}

/** Colour class for a bucket: public controlling key (hot), nobody can change it (hatch), not known (dashed), the rest bone. */
function bucketTone(b: ExposureBucket): string {
  if (b.exposed) return 'b-exposed'
  const id = b.id.toLowerCase()
  if (/immutable|none|no-authority|frozen/.test(id)) return 'b-fixed'
  if (/unknown|unread|pending|unresolved/.test(id)) return 'b-unknown'
  if (/nonce-?0|hidden|not-exposed/.test(id)) return 'b-hidden'
  return 'b-other'
}

function Group({ g }: { g: ExposureGroup }) {
  const live = g.buckets.filter((b) => b.n > 0)
  const exposed = g.buckets.filter((b) => b.exposed).reduce((a, b) => a + b.n, 0)
  return (
    <div className="ex-mg">
      <div className="ex-mg-h">
        <h3>{g.label}</h3>
        <span className="ex-mg-n num">{fmtInt(g.total)}</span>
        {exposed > 0 && (
          <span className="ex-mg-x mono">
            <b className="hot">{fmtInt(exposed)}</b> ({share(exposed, g.total)}) controlled by a public key
          </span>
        )}
      </div>
      <div className="ex-mbar" role="img" aria-label={`${g.label}: ${g.buckets.map((b) => `${b.n} ${b.label}`).join(', ')}`}>
        {g.total === 0 || live.length === 0 ? (
          <span className="ex-mbar-empty mono">nothing counted yet</span>
        ) : (
          live.map((b) => (
            <span key={b.id} className={`ex-mseg ${bucketTone(b)}`} style={{ flexGrow: b.n }} title={`${b.label}: ${fmtInt(b.n)} (${share(b.n, g.total)})`}>
              {b.n / g.total >= 0.08 && (
                <span className="ex-mseg-n mono">
                  {fmtInt(b.n)}
                  <i>{share(b.n, g.total)}</i>
                </span>
              )}
            </span>
          ))
        )}
      </div>
      <table className="ex-table ex-mt">
        <thead>
          <tr>
            <th scope="col">bucket</th>
            <th scope="col" className="r">
              n
            </th>
            <th scope="col" className="r">
              share
            </th>
            <th scope="col">basis</th>
          </tr>
        </thead>
        <tbody>
          {g.buckets.map((b) => (
            <tr key={b.id} className={b.n === 0 ? 'zero' : ''}>
              <td>
                <span className={`ex-sw ${bucketTone(b)}`} aria-hidden="true" />
                {b.label}
              </td>
              <td className="r num">{fmtInt(b.n)}</td>
              <td className="r num">{share(b.n, g.total)}</td>
              <td className="ex-mt-b">{b.basis}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="ex-note mono">{g.basis}</p>
    </div>
  )
}

export function ExposureMap({ sum, err }: { sum: ExposureSummary | null; err: string | null }) {
  return (
    <section className="ex-map pk-anchor" id="ex-map" aria-labelledby="ex-map-h">
      <div className="ex-sec-head">
        <span className="ex-sec-n mono">03 /</span>
        <h2 className="display" id="ex-map-h">
          Exposure Map
        </h2>
        <p className="ex-sec-k mono">
          the programs and contracts LUSCA keeps, by who can change them ·{' '}
          {sum ? `${sum.refreshing ? 'refreshing · ' : ''}counted ${fmtUtc(sum.readAt)}` : err ? 'not available' : 'loading'}
        </p>
      </div>
      {!sum ? (
        <p className={`ex-msg mono ${err ? 'bad' : 'caret'}`}>{err ? `${err}.` : 'loading the map'}</p>
      ) : (
        <>
          <p className="ex-map-basis">{sum.basis}</p>
          <div className="ex-mgs">
            {sum.groups.map((g) => (
              <Group key={g.id} g={g} />
            ))}
          </div>
          {sum.safes && sum.safes.length > 0 && (
            <div className="ex-mg ex-msafe">
              <div className="ex-mg-h">
                <h3>Safes found as controllers</h3>
                <span className="ex-mg-n num">{fmtInt(sum.safes.reduce((a, s) => a + s.safes, 0))}</span>
              </div>
              <table className="ex-table">
                <thead>
                  <tr>
                    <th scope="col">threshold</th>
                    <th scope="col" className="r">
                      Safes
                    </th>
                    <th scope="col" className="r">
                      owner keys exposed
                    </th>
                    <th scope="col" className="r">
                      owners read
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sum.safes.map((s) => (
                    <tr key={s.label}>
                      <td className="mono">{s.label}</td>
                      <td className="r num">{fmtInt(s.safes)}</td>
                      <td className="r num">
                        {fmtInt(s.ownersExposed)} <span className="dim">({share(s.ownersExposed, s.ownersRead)})</span>
                      </td>
                      <td className="r num">{fmtInt(s.ownersRead)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="ex-note mono">An owner key counts as exposed when that owner has sent a transaction (nonce above 0).</p>
            </div>
          )}
          {sum.partial.length > 0 && (
            <div className="ex-partial">
              <div className="ex-sub-h mono">
                <span>not counted · {fmtInt(sum.partial.length)}</span>
              </div>
              <ul>
                {sum.partial.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="ex-note mono">
            Every program and contract counted here is listed with its controller on the <Link to="/control">Control map</Link>.
          </p>
        </>
      )}
    </section>
  )
}
