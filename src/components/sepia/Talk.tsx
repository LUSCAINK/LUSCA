// TALK TO SEPIA — prompt the live model through POST /api/generate.
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { useMedia, useSampled } from '@/lib/hooks'
import { useLive } from '@/lib/store'
import { fmtCompact, fmtInt } from '@/lib/format'
import { fmtLoss, splitPrompt } from './model'

const PRESETS = ['The validator ', 'EIP-', 'Proposal: ', 'The bridge was exploited ', 'Bitcoin ']
const MAX_PROMPT = 200

interface Run {
  id: number
  prompt: string
  cont: string
  ms: number
  rtt: number
  temp: number
  n: number
  step: number
  loss: number
}

/** Time-based reveal: survives throttled timers (background tabs) by catching up. */
function useTypewriter(len: number, key: number, instant: boolean): number {
  const [shown, setShown] = useState(len)
  useEffect(() => {
    if (instant || len === 0) {
      setShown(len)
      return
    }
    const total = Math.min(2800, Math.max(600, len * 12))
    const t0 = performance.now()
    setShown(0)
    const id = window.setInterval(() => {
      const k = Math.min(len, Math.ceil(((performance.now() - t0) / total) * len))
      setShown(k)
      if (k >= len) window.clearInterval(id)
    }, 16)
    return () => window.clearInterval(id)
  }, [len, key, instant])
  return shown
}

/** Show trailing / leading spaces explicitly — they matter to a character model. */
function Visible({ text }: { text: string }) {
  const m = /^(.*?)(\s*)$/s.exec(text)
  const body = m ? m[1] : text
  const tail = m ? m[2] : ''
  return (
    <>
      {body}
      {tail && <span className="ws">{tail.replace(/ /g, '␣')}</span>}
    </>
  )
}

let seq = 0
const fill = (f: number) => ({ '--fill': `${(f * 100).toFixed(1)}%` }) as CSSProperties

export function Talk() {
  const conn = useSampled((s) => s.conn, 400)
  const latest = useSampled((s) => s.samples[0] ?? null, 1000)
  const still = useMedia('(prefers-reduced-motion: reduce)')
  const live = conn === 'live'

  const [prompt, setPrompt] = useState(PRESETS[0])
  const [temp, setTemp] = useState(0.8)
  const [len, setLen] = useState(240)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const abort = useRef<AbortController | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => () => abort.current?.abort(), [])

  const cur = runs[0] ?? null
  const shown = useTypewriter(cur?.cont.length ?? 0, cur?.id ?? 0, still)
  const typing = !!cur && shown < cur.cont.length

  async function generate(p: string) {
    if (!live || busy) return
    setBusy(true)
    setErr(null)
    const ctrl = new AbortController()
    abort.current = ctrl
    const t0 = performance.now()
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: p, n: len, temperature: temp }),
        signal: ctrl.signal,
      })
      const body = (await res.json().catch(() => null)) as { text?: unknown; ms?: unknown; error?: unknown } | null
      if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `the coordinator answered ${res.status}`)
      if (!body || typeof body.text !== 'string') throw new Error('the coordinator sent something that is not text')
      const split = splitPrompt(body.text, p)
      const m = useLive.getState().model
      const run: Run = {
        id: ++seq,
        prompt: split.prompt,
        cont: split.cont,
        ms: typeof body.ms === 'number' ? body.ms : 0,
        rtt: Math.round(performance.now() - t0),
        temp,
        n: len,
        step: m.step,
        loss: m.loss,
      }
      setRuns((r) => [run, ...r].slice(0, 6))
    } catch (e) {
      if (ctrl.signal.aborted) return
      setErr(e instanceof Error ? e.message : 'generation failed')
    } finally {
      if (abort.current === ctrl) abort.current = null
      setBusy(false)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void generate(prompt)
  }

  const choose = (p: string) => {
    setPrompt(p)
    if (live && !busy) void generate(p)
    else input.current?.focus()
  }

  const offNote =
    conn === 'unreachable'
      ? 'Can’t reach the LUSCA server — reconnecting… Generation runs on the server; the model weights are not in your browser.'
      : 'Connecting to the server… generation is available once it answers.'

  const tempWord = temp < 0.45 ? 'timid · repeats itself' : temp < 0.95 ? 'balanced' : temp < 1.25 ? 'adventurous' : 'feral · invents letters'

  return (
    <div className="tk">
      <form className="tk-form panel" onSubmit={onSubmit} aria-describedby={!live ? 'tk-off' : undefined}>
        <div className="panel-head">
          <span>
            <span className="hot">C</span>&nbsp;&nbsp;<b>Your prompt</b>
          </span>
          <span className="tk-state">
            <span className={`led ${live ? 'on pulse' : ''}`} /> {live ? 'model online' : 'model offline'}
          </span>
        </div>
        <div className="tk-body">
          <div className="tk-field">
            <div className="tk-lab">
              <label htmlFor="tk-prompt" className="label">
                start of a sentence
              </label>
              <span className="label dimmer num">
                {prompt.length}/{MAX_PROMPT}
              </span>
            </div>
            <div className="tk-input">
              <span className="tk-gt" aria-hidden="true">
                &gt;
              </span>
              <input
                id="tk-prompt"
                ref={input}
                type="text"
                value={prompt}
                maxLength={MAX_PROMPT}
                spellCheck={false}
                autoComplete="off"
                placeholder="type the start of a sentence"
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
          </div>

          <div className="tk-chips" role="group" aria-label="preset prompts">
            {PRESETS.map((p) => (
              <button key={p} type="button" className={`chip ${p === prompt ? 'on' : ''}`} onClick={() => choose(p)} aria-label={`use prompt “${p}”${live ? ' and generate' : ''}`}>
                <Visible text={p} />
              </button>
            ))}
          </div>

          <div className="tk-slider">
            <div className="tk-lab">
              <label htmlFor="tk-temp" className="label">
                randomness · temperature
              </label>
              <output htmlFor="tk-temp" className="tk-val num">
                {temp.toFixed(2)}
              </output>
            </div>
            <input id="tk-temp" type="range" min={0.2} max={1.5} step={0.05} value={temp} style={fill((temp - 0.2) / 1.3)} onChange={(e) => setTemp(Number(e.target.value))} aria-valuetext={`${temp.toFixed(2)}, ${tempWord}`} />
            <div className="tk-sl-s mono">
              <span>0.2</span>
              <span className="tk-word">{tempWord}</span>
              <span>1.5</span>
            </div>
          </div>

          <div className="tk-slider">
            <div className="tk-lab">
              <label htmlFor="tk-len" className="label">
                length
              </label>
              <output htmlFor="tk-len" className="tk-val num">
                {len} <span className="dim">chars</span>
              </output>
            </div>
            <input id="tk-len" type="range" min={60} max={600} step={20} value={len} style={fill((len - 60) / 540)} onChange={(e) => setLen(Number(e.target.value))} aria-valuetext={`${len} characters`} />
            <div className="tk-sl-s mono">
              <span>60</span>
              <span className="tk-word">one character at a time</span>
              <span>600</span>
            </div>
          </div>

          <button type="submit" className="btn primary lg tk-go" disabled={!live || busy || prompt.length === 0} aria-busy={busy}>
            {busy ? <span className="caret">sampling</span> : 'generate'}
            {!busy && <span className="tk-kbd" aria-hidden="true">↵</span>}
          </button>

          {!live && (
            <p id="tk-off" className="tk-note mono">
              <span className="tag">{conn === 'unreachable' ? 'offline' : 'connecting'}</span> {offNote}
            </p>
          )}
          {err && (
            <p className="tk-err mono" role="alert">
              <span className="tag err">error</span> {err}
            </p>
          )}
        </div>
      </form>

      <section className="tk-out panel" aria-labelledby="tk-out-h">
        <div className="panel-head">
          <span id="tk-out-h">
            <span className="hot">D</span>&nbsp;&nbsp;<b>SEPIA’s reply</b>
          </span>
          <span className="tk-meta-top">{cur ? `${fmtInt(cur.ms)} ms model · ${fmtInt(cur.rtt)} ms round trip` : live ? 'awaiting a seed' : 'read-only'}</span>
        </div>

        <div className="tk-screen" data-busy={busy || undefined}>
          {cur ? (
            <>
              <p className="tk-text mono" aria-hidden="true">
                <span className="tk-p">
                  <Visible text={cur.prompt} />
                </span>
                <span className="tk-c">{cur.cont.slice(0, shown)}</span>
                {typing && <span className="tk-cursor" />}
              </p>
              <p className="sr-only" aria-live="polite">
                SEPIA wrote: {cur.prompt}
                {cur.cont}
              </p>
            </>
          ) : (
            <div className="tk-idle">
              {latest ? (
                <>
                  <div className="label">
                    {live ? 'nothing asked yet — its latest training sample' : 'latest sample it wrote while training'} · step {fmtInt(latest.step)}
                  </div>
                  <SplitText text={latest.text} />
                </>
              ) : (
                <>
                  <div className="label">{live ? 'nothing asked yet' : 'no samples in this feed'}</div>
                  <p className="tk-idle-t">
                    {live
                      ? 'pick a seed or type one. SEPIA continues it one character at a time, remembering only the last 16. it has never been told what any word means.'
                      : 'when the coordinator is live, SEPIA answers here — your prompt in bone, its continuation in orange.'}
                  </p>
                </>
              )}
              <How prompt={prompt} n={len} temp={temp} />
            </div>
          )}
          {busy && (
            <div className="tk-busy mono" aria-hidden="true">
              sampling {len} characters at T {temp.toFixed(2)}
            </div>
          )}
        </div>

        {cur && (
          <dl className="tk-stats">
            <div>
              <dt className="label">latency</dt>
              <dd className="num hot">{fmtInt(cur.ms)} ms</dd>
            </div>
            <div>
              <dt className="label">chars</dt>
              <dd className="num">{fmtInt(cur.cont.length)}</dd>
            </div>
            <div>
              <dt className="label">temp</dt>
              <dd className="num">{cur.temp.toFixed(2)}</dd>
            </div>
            <div>
              <dt className="label">at step</dt>
              <dd className="num">
                {fmtCompact(cur.step)} <span className="dim">· {fmtLoss(cur.loss, 2)}</span>
              </dd>
            </div>
          </dl>
        )}

        {runs.length > 1 && (
          <ol className="tk-hist" aria-label="earlier generations">
            {runs.slice(1).map((r) => (
              <li key={r.id} className="tk-h">
                <span className="tk-h-m mono">
                  T {r.temp.toFixed(2)} · {r.n} ch · {fmtInt(r.ms)} ms
                </span>
                <span className="tk-h-t mono">
                  <span className="tk-p">
                    <Visible text={r.prompt} />
                  </span>
                  <span className="tk-c">{r.cont}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

function SplitText({ text }: { text: string }) {
  const { prompt, cont } = splitPrompt(text)
  return (
    <p className="tk-text mono">
      {prompt && (
        <span className="tk-p">
          <Visible text={prompt} />
        </span>
      )}
      <span className="tk-c">{cont}</span>
    </p>
  )
}

function How({ prompt, n, temp }: { prompt: string; n: number; temp: number }) {
  return (
    <div className="tk-how">
      <ol className="tk-steps">
        <li>
          <span className="num">01</span> map your text onto 96 symbols — newline + printable ascii
        </li>
        <li>
          <span className="num">02</span> keep the last 16. that is all the memory it has
        </li>
        <li>
          <span className="num">03</span> one forward pass → 96 scores
        </li>
        <li>
          <span className="num">04</span> divide by temperature, softmax, roll the dice
        </li>
        <li>
          <span className="num">05</span> append, slide the window, repeat ×{n}
        </li>
      </ol>
      <pre className="tk-api mono" aria-label="the request this form sends">
        <span className="dimmer">POST</span>
        {' /api/generate\n'}
        {`{ "prompt": ${JSON.stringify(prompt)}, "n": ${n}, "temperature": ${temp.toFixed(2)} }\n`}
        <span className="dimmer">→ </span>
        {'{ "text": prompt + continuation, "ms": model time }'}
      </pre>
    </div>
  )
}
