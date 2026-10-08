// Signature math: which signature/proof checks the verified EVM sources LUSCA keeps call into.
// Data is a static read of the local corpus (math-map.json); every n comes from that read, basis included.
import { Link } from 'react-router-dom'
import data from './math-map.json'

type Example = { chain: string; address: string; name: string }
type MathClass = { key: string; label: string; n: number; byChain: Record<string, number>; examples: Example[]; note: string }

const classes = data.classes as MathClass[]
const max = Math.max(1, ...classes.map((c) => c.n))
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export default function MathMap() {
  return (
    <section className="mathmap" aria-labelledby="mathmap-h" style={{ maxWidth: '100%', overflowWrap: 'anywhere' }}>
      <h2 id="mathmap-h" style={{ color: 'var(--fg)', fontSize: 'var(--t-xs)', letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 6px' }}>
        Signature math
      </h2>
      <p style={{ color: 'var(--fg-2)', fontSize: 'var(--t-xs)', margin: '0 0 14px' }}>
        What the contracts LUSCA has read rely on to verify signatures and proofs. Elliptic-curve checks fall if the curve
        falls; hash-only checks do not.
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
        {classes.map((c) => (
          <li key={c.key} style={{ borderTop: '1px solid var(--line-2)', paddingTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 'var(--t-xs)', color: 'var(--fg-1)' }}>
              <span>{c.label}</span>
              <span style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
                {c.n} / {data.total}
              </span>
            </div>
            <div aria-hidden="true" style={{ height: 6, background: 'var(--line-2)', marginTop: 4 }}>
              <div
                style={{
                  height: '100%',
                  width: `${(c.n / max) * 100}%`,
                  minWidth: c.n ? 2 : 0,
                  background: c.key === 'hashonly' || c.key === 'none' ? 'var(--fg-3)' : 'var(--hot)',
                }}
              />
            </div>
            <div style={{ fontSize: 'var(--t-2xs)', color: 'var(--fg-2)', marginTop: 4 }}>
              {Object.entries(c.byChain)
                .map(([k, v]) => `${k} ${v}`)
                .join(' · ')}
              {' — '}
              {c.note}
            </div>
            {c.examples.length > 0 && c.key !== 'none' && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 4, fontSize: 'var(--t-2xs)' }}>
                {c.examples.map((e) => (
                  <Link key={`${e.chain}:${e.address}`} to={`/lens/${e.chain}/${e.address}`} style={{ color: 'var(--fg-1)' }}>
                    {e.name} <span style={{ color: 'var(--fg-3)' }}>{e.chain} {short(e.address)}</span>
                  </Link>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p style={{ color: 'var(--fg-3)', fontSize: 'var(--t-2xs)', marginTop: 12 }}>
        Read {data.readAt}. {data.basis}
      </p>
    </section>
  )
}
