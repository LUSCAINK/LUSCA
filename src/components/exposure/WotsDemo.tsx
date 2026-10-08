// Hash-only signatures, in this tab: a Winternitz one-time signature (w = 16, SHA-256 through WebCrypto) generated,
// signed and verified in the browser (src/lib/wots.ts). Nothing is sent anywhere. Every size and count shown is
// measured from the arrays the demo holds; the reuse panel shows what a second signature with the same key gives away.
import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtInt } from '@/lib/format'
import {
  WOTS,
  forge,
  forgeChance,
  generate,
  hashCount,
  lowestRevealed,
  sign,
  signatureBytes,
  toHex,
  verify,
  type ForgeResult,
  type WotsKeyPair,
  type WotsSignature,
} from '@/lib/wots'

interface Signed {
  message: string
  sig: WotsSignature
  ms: number
}

const DEFAULT_MSG = (n: number) => `LUSCA exposure demo: message ${n}`
/** The search runs only when its expected number of tries is at most this (a few seconds to a minute in a tab). */
const SEARCH_MAX_EXPECTED = 3_000_000
const SEARCH_DEADLINE_MS = 45_000

/** "1 in 3.4 × 10^11" style for tiny probabilities. */
function oneIn(p: number): string {
  if (p <= 0) return 'none'
  const n = 1 / p
  if (n < 10_000) return `1 in ${fmtInt(n)}`
  const e = Math.floor(Math.log10(n))
  return `1 in ${(n / 10 ** e).toFixed(1)} × 10^${e}`
}

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${fmtInt(ms / 60_000)} min`)
const hexShort = (b: Uint8Array, n = 10) => {
  const h = toHex(b)
  return h.length > n * 2 + 1 ? `${h.slice(0, n)}…${h.slice(-n)}` : h
}

function flipOne(s: string): string {
  if (!s) return 'x'
  const i = Math.floor(s.length / 2)
  const c = s[i]
  const r = c === 'a' ? 'b' : c === '1' ? '2' : c === ' ' ? '_' : 'a'
  return s.slice(0, i) + r + s.slice(i + 1)
}

/**
 * 67 chains as columns, position 0 (the secret start) at the top, 15 (the public key's chain end) at the bottom.
 * Filled: positions anyone can compute from what was signed. Hot: what signing more than once added.
 */
function ChainStrip({ first, lowest, label }: { first: number[] | null; lowest: number[] | null; label: string }) {
  const W = 6
  const H = 5
  const n = WOTS.len
  const steps = WOTS.steps
  return (
    <svg className="ex-strip" viewBox={`0 0 ${n * W} ${steps * H + 1}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {Array.from({ length: n }, (_, i) => {
        const x = i * W
        const f = first ? first[i] : steps
        const l = lowest ? lowest[i] : f
        return (
          <g key={i} className={i >= WOTS.len1 ? 'cs' : ''}>
            <rect className="sec" x={x} y={0} width={W - 1} height={steps * H} />
            {l < f && <rect className="more" x={x} y={l * H} width={W - 1} height={(f - l) * H} />}
            {f < steps && <rect className="pub" x={x} y={f * H} width={W - 1} height={(steps - f) * H} />}
          </g>
        )
      })}
    </svg>
  )
}

export function WotsDemo() {
  const supported = typeof globalThis.crypto !== 'undefined' && !!globalThis.crypto.subtle
  const [kp, setKp] = useState<WotsKeyPair | null>(null)
  const [gen, setGen] = useState<{ ms: number; hashes: number } | null>(null)
  const [busy, setBusy] = useState<'gen' | 'sign' | null>(null)
  const [msg, setMsg] = useState(DEFAULT_MSG(1))
  const [signed, setSigned] = useState<Signed[]>([])
  const [vMsg, setVMsg] = useState('')
  /** The signature the verify box checks: the latest one, or a forged one. */
  const [vSig, setVSig] = useState<{ sig: WotsSignature; label: string } | null>(null)
  const [vOkRaw, setVOk] = useState<boolean | null>(null)
  const [vMs, setVMs] = useState<number | null>(null)
  const [search, setSearch] = useState<{ running: boolean; tries: number; res: ForgeResult | null; verified: boolean | null }>({ running: false, tries: 0, res: null, verified: null })
  const stopRef = useRef<AbortController | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const last = signed.length ? signed[signed.length - 1] : null
  const rate = gen && gen.ms > 0 ? (gen.hashes / gen.ms) * 1000 : null
  const vOk = kp && vSig ? vOkRaw : null

  const newKey = async () => {
    stopRef.current?.abort()
    setBusy('gen')
    setErr(null)
    try {
      const h0 = hashCount
      const t0 = performance.now()
      const k = await generate()
      setGen({ ms: performance.now() - t0, hashes: hashCount - h0 })
      setKp(k)
      setSigned([])
      setMsg(DEFAULT_MSG(1))
      setVMsg('')
      setVSig(null)
      setVOk(null)
      setSearch({ running: false, tries: 0, res: null, verified: null })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const doSign = async () => {
    if (!kp) return
    setBusy('sign')
    try {
      const t0 = performance.now()
      const sig = await sign(kp, msg)
      const s: Signed = { message: msg, sig, ms: performance.now() - t0 }
      setSigned((cur) => [...cur, s])
      setVMsg(msg)
      setVSig({ sig, label: `signature ${signed.length + 1}` })
      setMsg(DEFAULT_MSG(signed.length + 2))
      setSearch({ running: false, tries: 0, res: null, verified: null })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // verify the chosen signature against whatever the verify box says (live)
  useEffect(() => {
    if (!kp || !vSig) return
    let alive = true
    const t = window.setTimeout(async () => {
      const t0 = performance.now()
      const ok = await verify(kp.publicKey, vMsg, vSig.sig.values)
      if (!alive) return
      setVOk(ok)
      setVMs(performance.now() - t0)
    }, 120)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [kp, vSig, vMsg])

  const sigs = useMemo(() => signed.map((s) => s.sig), [signed])
  const chance = useMemo(() => (sigs.length >= 2 ? forgeChance(sigs) : 0), [sigs])
  const lowest = useMemo(() => (sigs.length ? lowestRevealed(sigs) : null), [sigs])
  const expected = chance > 0 ? 1 / chance : Infinity
  const canSearch = sigs.length >= 2 && expected <= SEARCH_MAX_EXPECTED

  const runSearch = async () => {
    if (!kp || !lowest) return
    stopRef.current?.abort()
    const ac = new AbortController()
    stopRef.current = ac
    setSearch({ running: true, tries: 0, res: null, verified: null })
    const res = await forge(lowest, 'forged message #', {
      maxTries: Math.ceil(Math.min(SEARCH_MAX_EXPECTED * 4, expected * 8)),
      deadlineMs: SEARCH_DEADLINE_MS,
      signal: ac.signal,
      onProgress: (tries) => setSearch((s) => ({ ...s, tries })),
    })
    const verified = res.found ? await verify(kp.publicKey, res.found.message, res.found.signature.values) : null
    if (stopRef.current === ac) stopRef.current = null
    setSearch({ running: false, tries: res.tries, res, verified })
  }
  useEffect(() => () => stopRef.current?.abort(), [])

  const sigLen = last ? signatureBytes(last.sig).length : WOTS.len * WOTS.n
  const first = signed.length ? signed[0].sig.digits : null
  const extra = lowest && first ? lowest.reduce((a, r, i) => a + (first[i] - r.step), 0) : 0

  return (
    <section className="ex-sig pk-anchor" id="ex-sig" aria-labelledby="ex-sig-h">
      <div className="ex-sec-head">
        <span className="ex-sec-n mono">02 /</span>
        <h2 className="display" id="ex-sig-h">
          Hash-only signatures
        </h2>
        <p className="ex-sec-k mono">a Winternitz one-time signature · w = 16 · SHA-256 · runs in this tab, nothing is sent</p>
      </div>
      <p className="ex-sig-lede">
        A hash-based signature needs no elliptic curve: its security rests on SHA-256 alone, which Shor’s algorithm does not break. Each of 67 chains
        starts at a secret and is hashed 15 times; the 67 chain ends, hashed together, are the public key. To sign, each digit of the message hash says how
        far down its chain to reveal. Anyone can walk a chain further down, nobody can walk it back up, and a checksum makes sure any change to the message
        would need one chain walked back.
      </p>

      {!supported ? (
        <p className="ex-msg bad mono">This browser does not expose WebCrypto (crypto.subtle) on this page, so the demo cannot run here.</p>
      ) : (
        <>
          <div className="ex-steps">
            <div className="ex-step">
              <div className="ex-step-h mono">
                <span className="hot">1</span> key pair
              </div>
              <button className="btn primary" onClick={() => void newKey()} disabled={busy !== null}>
                {busy === 'gen' ? 'GENERATING…' : kp ? 'NEW KEY PAIR' : 'GENERATE A KEY PAIR'}
              </button>
              {kp && gen ? (
                <dl className="ex-kv mono">
                  <div>
                    <dt>private seed</dt>
                    <dd title="32 random bytes from crypto.getRandomValues; stays in this tab">{hexShort(kp.seed, 8)}</dd>
                  </div>
                  <div>
                    <dt>public key</dt>
                    <dd title={toHex(kp.publicKey)}>{hexShort(kp.publicKey, 8)}</dd>
                  </div>
                  <div>
                    <dt>work</dt>
                    <dd>
                      {fmtInt(gen.hashes)} SHA-256 in {fmtMs(gen.ms)}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="ex-step-p">67 secrets from a random 32-byte seed, each hashed 15 times; the 67 ends hashed into one 32-byte public key.</p>
              )}
            </div>

            <div className={`ex-step ${kp ? '' : 'off'}`}>
              <div className="ex-step-h mono">
                <span className="hot">2</span> sign
                {signed.length > 0 && <span className={`ex-uses ${signed.length > 1 ? 'hot' : ''}`}>key used {fmtInt(signed.length)}×</span>}
              </div>
              <textarea className="ex-ta mono" value={msg} onChange={(e) => setMsg(e.target.value)} rows={2} disabled={!kp} aria-label="Message to sign" spellCheck={false} />
              <button className={`btn ${signed.length ? 'ghost' : 'primary'}`} onClick={() => void doSign()} disabled={!kp || busy !== null}>
                {busy === 'sign' ? 'SIGNING…' : signed.length ? 'SIGN AGAIN WITH THE SAME KEY' : 'SIGN'}
              </button>
              {last ? (
                <dl className="ex-kv mono">
                  <div>
                    <dt>signature</dt>
                    <dd>
                      {fmtInt(sigLen)} bytes · {WOTS.len} × {WOTS.n}
                    </dd>
                  </div>
                  <div>
                    <dt>signed in</dt>
                    <dd>{fmtMs(last.ms)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="ex-step-p">The message is hashed to 64 base-16 digits, plus 3 checksum digits: one digit per chain.</p>
              )}
            </div>

            <div className={`ex-step ${last ? '' : 'off'}`}>
              <div className="ex-step-h mono">
                <span className="hot">3</span> verify
                {vSig && <span className="ex-uses">{vSig.label}</span>}
                {vOk !== null && <span className={`ex-ok ${vOk ? 'yes' : 'no'}`}>{vOk ? 'valid' : 'fails'}</span>}
              </div>
              <textarea
                className="ex-ta mono"
                value={vMsg}
                onChange={(e) => setVMsg(e.target.value)}
                rows={2}
                disabled={!last}
                aria-label="Message to verify against the latest signature"
                spellCheck={false}
              />
              <button className="btn ghost" onClick={() => setVMsg((m) => flipOne(m))} disabled={!last}>
                CHANGE ONE CHARACTER
              </button>
              {last ? (
                <p className="ex-step-p mono">
                  {vOk === null
                    ? 'checking…'
                    : vOk
                      ? `the chains walked from the signature hash to the public key${vMs !== null ? ` (${fmtMs(vMs)})` : ''}`
                      : 'the chains walked from the signature no longer hash to the public key'}
                </p>
              ) : (
                <p className="ex-step-p">The verifier walks each revealed value the rest of its chain and compares the hash of the 67 ends with the public key.</p>
              )}
            </div>
          </div>

          <div className="ex-chains">
            <div className="ex-sub-h mono">
              <span>67 chains · top = secret start · bottom = public key</span>
              <span className="ex-legend">
                <i className="sw pub" /> computable from the first signature
                <i className="sw more" /> given away by signing again
                <i className="sw cs" /> checksum chains
              </span>
            </div>
            <ChainStrip
              first={first}
              lowest={lowest ? lowest.map((r) => r.step) : null}
              label={
                first
                  ? `Chain positions revealed: ${signed.length} signature${signed.length === 1 ? '' : 's'}${extra ? `, ${extra} more positions than the first signature` : ''}`
                  : 'No signature yet'
              }
            />
          </div>

          <div className="ex-reuse">
            <div className="ex-reuse-l">
              <h3>Why one key signs only once</h3>
              <p>
                One signature lets anyone hash each chain forward from its revealed digit. Forging another message would need every one of its 67 digits at or past (≥) what was
                revealed, but raising message digits lowers the checksum, so one signature never covers a second message. Sign a different message with the
                same key and each chain is revealed from the lower of the two digits: messages that were never signed start to fit.
              </p>
              <p className="dim">
                Hash-based wallets therefore use each key once. XMSS (RFC 8391) and SLH-DSA (FIPS 205) put many one-time keys under one public key with a
                Merkle tree.
              </p>
            </div>
            <dl className="ex-reuse-r">
              <div>
                <dt className="label">signatures with this key</dt>
                <dd className="num">{fmtInt(signed.length)}</dd>
              </div>
              <div className={chance > 0 ? 'hot' : ''}>
                <dt className="label">chance a random message is forgeable</dt>
                <dd className="num">{signed.length < 2 ? (signed.length ? 'none' : '—') : oneIn(chance)}</dd>
                <dd className="ex-reuse-s mono">
                  {signed.length < 2
                    ? 'one signature: only the signed message fits (anything else needs a SHA-256 preimage)'
                    : 'exact count over the revealed positions, the 64 message digits taken as uniform, checksum included'}
                </dd>
              </div>
              {signed.length >= 2 && chance > 0 && (
                <div>
                  <dt className="label">expected search in this tab</dt>
                  <dd className="num">{rate ? (expected / rate > 3600 * 24 * 365 ? '> 1 year' : fmtMs((expected / rate) * 1000)) : '—'}</dd>
                  <dd className="ex-reuse-s mono">{rate ? `at this tab’s measured ${fmtInt(rate)} SHA-256/s (key generation)` : ''}</dd>
                </div>
              )}
            </dl>
            <div className="ex-forge">
              {signed.length >= 2 && (
                <>
                  <button
                    className="btn primary"
                    onClick={() => (search.running ? stopRef.current?.abort() : void runSearch())}
                    disabled={!canSearch && !search.running}
                    title={canSearch ? 'Hash candidate messages until one fits the revealed positions' : 'Sign a few more messages with the same key first'}
                  >
                    {search.running ? `STOP · ${fmtInt(search.tries)} TRIED` : 'SEARCH FOR A FORGERY'}
                  </button>
                  {!canSearch && !search.running && (
                    <p className="ex-step-p mono">expected tries too many for a tab ({oneIn(chance)}); sign once or twice more with the same key</p>
                  )}
                </>
              )}
              {search.res && !search.running && (
                <div className={`ex-forged ${search.res.found ? 'hit' : ''}`}>
                  {search.res.found ? (
                    <>
                      <span className="label">forged without the private key</span>
                      <code className="mono">{search.res.found.message}</code>
                      <span className="mono">
                        {fmtInt(search.res.tries)} tries · {fmtMs(search.res.ms)} · verifies against the same public key:{' '}
                        <b className={search.verified ? 'hot' : ''}>{search.verified === null ? '—' : search.verified ? 'yes' : 'no'}</b>
                      </span>
                      <button
                        className="btn ghost"
                        onClick={() => {
                          const f = search.res?.found
                          if (!f) return
                          setVSig({ sig: f.signature, label: 'forged signature' })
                          setVMsg(f.message)
                        }}
                      >
                        CHECK IT IN THE VERIFY BOX
                      </button>
                    </>
                  ) : (
                    <span className="mono">
                      no forgery in {fmtInt(search.res.tries)} tries ({fmtMs(search.res.ms)}); the chance per try is {oneIn(chance)}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <table className="ex-table ex-sizes">
            <caption className="label">sizes</caption>
            <thead>
              <tr>
                <th scope="col">scheme</th>
                <th scope="col" className="r">
                  public key
                </th>
                <th scope="col" className="r">
                  signature
                </th>
                <th scope="col">basis</th>
              </tr>
            </thead>
            <tbody>
              <tr className="hot-row">
                <td>WOTS, this demo</td>
                <td className="r num">{fmtInt(kp ? kp.publicKey.length : WOTS.n)} B</td>
                <td className="r num">{fmtInt(sigLen)} B</td>
                <td className="dim">{last ? 'measured: the arrays above' : 'computed: 67 chains × 32 bytes'} · one signature per key</td>
              </tr>
              <tr>
                <td>Ed25519 · Solana</td>
                <td className="r num">32 B</td>
                <td className="r num">64 B</td>
                <td className="dim">RFC 8032</td>
              </tr>
              <tr>
                <td>ECDSA secp256k1 · EVM</td>
                <td className="r num">64 B</td>
                <td className="r num">65 B</td>
                <td className="dim">r, s and the recovery id v; the 64-byte key is what keccak256 hashes into the address</td>
              </tr>
              <tr>
                <td>SLH-DSA-SHA2-128s</td>
                <td className="r num">32 B</td>
                <td className="r num">7,856 B</td>
                <td className="dim">FIPS 205 · hash-based, many signatures per key</td>
              </tr>
            </tbody>
          </table>
          {err && <p className="ex-msg bad mono">{err}</p>}
        </>
      )}
    </section>
  )
}
