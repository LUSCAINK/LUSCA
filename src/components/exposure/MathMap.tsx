// Signature math: which signature/proof checks the verified EVM sources LUSCA keeps call into.
// Data is a static read of the local corpus (math-map.json); every n comes from that read, basis included.
// "Hash-only proofs" = a Merkle proof check and no elliptic-curve class in the same source bundle.
import { Link } from 'react-router-dom'
import data from './math-map.json'

type Example = { chain: string; address: string; name: string }
type MathClass = { key: string; label: string; n: number; byChain: Record<string, number>; examples: Example[]; note: string }

const LABEL: Record<string, string> = { hashonly: 'Hash-only proofs (Merkle, no curve check)' }
const classes = (data.classes as MathClass[]).map((c) => ({ ...c, label: LABEL[c.key] ?? c.label }))
const max = Math.max(1, ...classes.map((c) => c.n))
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export default function MathMap() {
  return (
    <section className="ex-mm" aria-labelledby="mathmap-h">
      <div className="ex-sec-head">
        <span className="ex-sec-n mono">04 /</span>
        <h2 className="display" id="mathmap-h">
          Signature math
        </h2>
        <p className="ex-sec-k mono">what the verified contracts LUSCA keeps call to check signatures and proofs · {data.total.toLocaleString('en-US')} contracts</p>
      </div>
      <p className="ex-mm-lede">
        Elliptic-curve checks fall if the curve falls. Hash-only proofs (Merkle) do not rely on a curve. A contract can be in several curve classes, so
        the counts add up to more than the total.
      </p>
      <ul className="ex-mm-list">
        {classes.map((c) => (
          <li key={c.key} className={c.key === 'hashonly' || c.key === 'none' ? 'cold' : 'hot'}>
            <div className="ex-mm-h">
              <span>{c.label}</span>
              <span className="num">
                {c.n.toLocaleString('en-US')} / {data.total.toLocaleString('en-US')}
              </span>
            </div>
            <div className="ex-mm-bar" aria-hidden="true">
              <i style={{ width: `${(c.n / max) * 100}%`, minWidth: c.n ? 2 : 0 }} />
            </div>
            <div className="ex-mm-n mono">
              {Object.entries(c.byChain)
                .map(([k, v]) => `${k} ${v}`)
                .join(' · ')}
              {' · '}
              {c.note}
            </div>
            {c.examples.length > 0 && c.key !== 'none' && (
              <div className="ex-mm-ex mono">
                {c.examples.map((e) => (
                  <Link key={`${e.chain}:${e.address}`} to={`/lens/${e.chain}/${e.address}`}>
                    {e.name} <span className="dimmer">{e.chain} {short(e.address)}</span>
                  </Link>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="ex-note mono">
        Read {data.readAt}. {data.basis}
      </p>
    </section>
  )
}
