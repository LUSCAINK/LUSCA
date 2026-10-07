// "Recovered from the binary" — compact block for /lens/solana/:address when the program publishes no IDL:
// what READ THE BINARY recovered from its executable (stored result; GET /api/binary/:address), with evidence.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { BinaryInterface } from '@shared/binary'
import './recovered.css'

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`

export default function Recovered({ address }: { address: string }) {
  const [r, setR] = useState<BinaryInterface | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'none' | 'error'>('loading')
  useEffect(() => {
    const ac = new AbortController()
    let retry: number | undefined
    setState('loading')
    // the Lens read that drew this page handed its executable to the binary reader: ask again once, shortly
    const pull = (again: boolean) =>
      fetch(`/api/binary/${encodeURIComponent(address)}`, { signal: ac.signal })
        .then(async (res) => {
          if (res.status === 404) {
            if (again) retry = window.setTimeout(() => void pull(false), 2500)
            return setState('none')
          }
          if (!res.ok) throw new Error(String(res.status))
          setR((await res.json()) as BinaryInterface)
          setState('ok')
        })
        .catch(() => !ac.signal.aborted && setState('error'))
    void pull(true)
    return () => {
      ac.abort()
      window.clearTimeout(retry)
    }
  }, [address])

  if (state === 'loading') return null
  if (state !== 'ok' || !r)
    return (
      <p className="dim rb-p mono">
        {state === 'none' ? 'Recovered from the binary: not read yet — the binary reader works through programs without an IDL in the background.' : ''}
      </p>
    )
  const confirmed = r.instructions.filter((i) => i.evidence === 'log+disc').length
  return (
    <div className="rb">
      <div className="rb-h mono">
        <span>
          <span className="hot">■</span> recovered from the binary
        </span>
        <Link to={`/binary/${r.address}`}>evidence →</Link>
      </div>
      <p className="rb-s mono">
        {n(r.instructions.length, 'instruction')} ({confirmed} confirmed by discriminator) · {n(r.accounts.length, 'account type')} · {n(r.errors.length, 'error message')} ·{' '}
        {r.framework.name === 'unknown' ? 'framework not identified' : r.framework.name}
        {r.programCrate ? ` · crate ${r.programCrate}` : ''}
      </p>
      {r.instructions.length > 0 && (
        <ul className="rb-ix">
          {r.instructions.slice(0, 40).map((ix) => (
            <li key={ix.name} className={ix.evidence === 'log+disc' ? 'c' : ''} title={ix.evidence === 'log+disc' ? `log string + discriminator ${ix.disc}` : 'log string'}>
              <code>{ix.name}</code>
            </li>
          ))}
          {r.instructions.length > 40 && <li className="more mono">+{r.instructions.length - 40}</li>}
        </ul>
      )}
    </div>
  )
}
