// SEPIA-1 TOKENIZER — milestone M1: the trained 32,768-entry byte-level BPE, live in the browser.
// The tokenizer (models/sepia-1-tokenizer/tokenizer.json) and the GPT encodings it is compared
// with load only when this section comes near the viewport. Every number on this panel is either
// computed here from the text in the editor or read from eval.json (the held-out evaluation).
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react'
import tokUrl from '../../../../models/sepia-1-tokenizer/tokenizer.json?url'
import evalRaw from '../../../../models/sepia-1-tokenizer/eval.json?raw'
import { Sepia1Tokenizer, type TokenizerJsonLike } from '@shared/sepia1/tokenizer'
import { EXAMPLES } from './examples'
import './tokenizer.css'

type Metric = { tokens: number; bytesPerToken: number; tokensPer1kLines: number; linesPer2048: number }
type TokKey = 'sepia1' | 'r50k' | 'cl100k' | 'o200k'
interface EvalJson {
  tokenizer: { vocabSize: number; sha256: string }
  heldOut: string
  compare: Record<TokKey, { name: string; vocab: number }>
  languages: { id: string; label: string; docs: number; sources: number; bytes: number; lines: number; tokenizers: Record<TokKey, Metric> }[]
  totals: { code: { bytes: number; lines: number; tokenizers: Record<TokKey, { tokens: number; bytesPerToken: number; tokensPer1kLines: number }>; relative: Record<'r50k' | 'cl100k' | 'o200k', number> } }
  roundTrip: { docs: number; exact: number; bytes: number }
  parity: { docs: number; tokens: number; mismatches: number }
  speed: { encoderMBps: number }
}
const EVAL = JSON.parse(evalRaw) as EvalJson
const KEYS: TokKey[] = ['sepia1', 'o200k', 'cl100k', 'r50k']
const SHORT: Record<TokKey, string> = { sepia1: 'SEPIA-1', r50k: 'GPT-2 r50k', cl100k: 'cl100k', o200k: 'o200k' }

type View = 'sepia1' | 'o200k' | 'cl100k'
interface Chip {
  id: number
  text: string
  bytes: number
  special?: boolean
}
interface GptEnc {
  encode: (t: string, o?: { disallowedSpecial?: Set<string> }) => number[]
  decode: (ids: Iterable<number>) => string
}

const MAX_CHIPS = 3000
const MAX_INPUT = 40_000
const enc8 = new TextEncoder()
const fmt = (n: number) => n.toLocaleString('en-US')

/** Loads once per page view. */
let tokPromise: Promise<Sepia1Tokenizer> | null = null
function loadTokenizer(): Promise<Sepia1Tokenizer> {
  tokPromise ??= fetch(tokUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json() as Promise<TokenizerJsonLike>
    })
    .then((j) => new Sepia1Tokenizer(j))
  tokPromise.catch(() => (tokPromise = null))
  return tokPromise
}
let gptPromise: Promise<{ o200k: GptEnc; cl100k: GptEnc }> | null = null
function loadGpt() {
  gptPromise ??= Promise.all([import('gpt-tokenizer/encoding/o200k_base'), import('gpt-tokenizer/encoding/cl100k_base')]).then(([o, c]) => ({
    o200k: o as unknown as GptEnc,
    cl100k: c as unknown as GptEnc,
  }))
  gptPromise.catch(() => (gptPromise = null))
  return gptPromise
}

function useNearViewport<T extends Element>(margin = '600px'): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || near) return
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: margin })
    io.observe(el)
    return () => io.disconnect()
  }, [near, margin])
  return [ref, near]
}

export default function TokenizerLab() {
  const [rootRef, near] = useNearViewport<HTMLDivElement>()
  const [tok, setTok] = useState<Sepia1Tokenizer | null>(null)
  const [tokErr, setTokErr] = useState<string | null>(null)
  const [gpt, setGpt] = useState<{ o200k: GptEnc; cl100k: GptEnc } | null>(null)
  const [exId, setExId] = useState<string>(EXAMPLES[0].id)
  const [text, setText] = useState<string>(EXAMPLES[0].code)
  const [view, setView] = useState<View>('sepia1')
  const [heat, setHeat] = useState(false)
  const [hover, setHover] = useState<Chip | null>(null)
  const deferred = useDeferredValue(text)

  useEffect(() => {
    if (!near) return
    let live = true
    loadTokenizer().then(
      (t) => live && setTok(t),
      (e: unknown) => live && setTokErr(e instanceof Error ? e.message : 'failed to load'),
    )
    loadGpt().then(
      (g) => live && setGpt(g),
      () => {},
    )
    return () => {
      live = false
    }
  }, [near])

  const example = EXAMPLES.find((e) => e.id === exId) ?? null

  const stats = useMemo(() => {
    const bytes = enc8.encode(deferred).length
    const lines = deferred.length === 0 ? 0 : deferred.split('\n').length - (deferred.endsWith('\n') ? 1 : 0)
    const sepia = tok ? tok.tokens(deferred) : null
    const plain = { disallowedSpecial: new Set<string>() }
    const o200k = gpt ? gpt.o200k.encode(deferred, plain) : null
    const cl100k = gpt ? gpt.cl100k.encode(deferred, plain) : null
    return { bytes, lines, sepia, o200k, cl100k }
  }, [deferred, tok, gpt])

  const chips: Chip[] | null = useMemo(() => {
    if (view === 'sepia1') return stats.sepia
    const ids = view === 'o200k' ? stats.o200k : stats.cl100k
    const enc = gpt?.[view]
    if (!ids || !enc) return null
    const out: Chip[] = []
    for (let i = 0; i < ids.length && i < MAX_CHIPS; i++) {
      const t = enc.decode([ids[i]])
      out.push({ id: ids[i], text: t, bytes: enc8.encode(t).length })
    }
    return out
  }, [view, stats, gpt])

  const counts: Record<View, number | null> = {
    sepia1: stats.sepia?.length ?? null,
    o200k: stats.o200k?.length ?? null,
    cl100k: stats.cl100k?.length ?? null,
  }

  const pick = (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id)
    setExId(id)
    if (ex) setText(ex.code)
    setHover(null)
  }

  const onEdit = (v: string) => {
    setText(v.slice(0, MAX_INPUT))
    if (exId !== 'custom') setExId('custom')
  }

  const code = EVAL.totals.code
  const pct = (r: number) => `${r < 1 ? '−' : '+'}${Math.abs((1 - r) * 100).toFixed(1)}%`

  return (
    <div className="tk" ref={rootRef}>
      {/* milestone strip */}
      <div className="tk-ms mono" role="list" aria-label="SEPIA-1 milestones">
        <span className="tk-ms-i on" role="listitem">
          <span className="led on" />
          <b>M1</b> tokenizer · trained and evaluated
        </span>
        <span className="tk-ms-i" role="listitem">
          <span className="led" />
          <b>M2</b> WebGPU transformer kernels · not started
        </span>
        <span className="tk-ms-i" role="listitem">
          <span className="led" />
          <b>SEPIA-1</b> model · not trained yet
        </span>
      </div>

      {/* measured headline numbers */}
      <div className="tk-stats">
        <Stat k="vocabulary" v={fmt(EVAL.tokenizer.vocabSize)} s="byte-level BPE · 39 special" />
        <Stat k="held-out code · bytes / token" v={code.tokenizers.sepia1.bytesPerToken.toFixed(2)} s={`o200k ${code.tokenizers.o200k.bytesPerToken.toFixed(2)} · cl100k ${code.tokenizers.cl100k.bytesPerToken.toFixed(2)}`} hot />
        <Stat k="tokens for the same code" v={pct(code.relative.o200k)} s={`vs o200k (200k vocab) · ${pct(code.relative.cl100k)} vs cl100k`} />
        <Stat k="vs GPT-2 r50k" v={pct(code.relative.r50k)} s="tokens on held-out code" />
        <Stat k="exact round trip" v={`${fmt(EVAL.roundTrip.exact)}/${fmt(EVAL.roundTrip.docs)}`} s="held-out files decode byte for byte" />
        <Stat k="browser encoder vs python" v={`${EVAL.parity.mismatches} diff`} s={`${fmt(EVAL.parity.tokens)} tokens compared`} />
      </div>

      {/* playground */}
      <div className="tk-play">
        <div className="tk-src panel">
          <div className="panel-head">
            <span>
              source · <b>{exId === 'custom' ? 'your code' : example?.label}</b>
            </span>
            <span className="tk-src-n num">{fmt(stats.bytes)} B · {fmt(stats.lines)} lines</span>
          </div>
          <div className="tk-ex" role="tablist" aria-label="examples">
            {EXAMPLES.map((e) => (
              <button key={e.id} type="button" role="tab" aria-selected={exId === e.id} className={`tk-ex-b ${exId === e.id ? 'on' : ''}`} onClick={() => pick(e.id)}>
                <span className="tk-ex-l">{e.lang}</span>
                {e.label}
              </button>
            ))}
            <button type="button" role="tab" aria-selected={exId === 'custom'} className={`tk-ex-b ${exId === 'custom' ? 'on' : ''}`} onClick={() => setExId('custom')}>
              <span className="tk-ex-l">paste</span>
              your code
            </button>
          </div>
          <textarea
            className="tk-ta mono"
            value={text}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="text to tokenize"
            onChange={(e) => onEdit(e.target.value)}
            placeholder="Paste a contract, a program or any text."
          />
          <div className="tk-attr mono">
            {exId !== 'custom' && example ? (
              <>
                <a href={`https://github.com/${example.repo}/blob/${example.commit}/${example.path}#L${example.lines[0]}-L${example.lines[1]}`} target="_blank" rel="noreferrer">
                  {example.repo}@{example.commit.slice(0, 7)} · {example.path} · L{example.lines[0]}–{example.lines[1]}
                </a>
                <span className="tk-attr-l">{example.license}</span>
              </>
            ) : (
              <span>Your text stays in this browser tab. Nothing is sent to the server.</span>
            )}
          </div>
        </div>

        <div className="tk-out panel">
          <div className="panel-head tk-out-h">
            <div className="tk-seg" role="tablist" aria-label="tokenizer">
              {(['sepia1', 'o200k', 'cl100k'] as View[]).map((v) => (
                <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)} disabled={v !== 'sepia1' && !gpt}>
                  {SHORT[v]}
                  <span className="num">{counts[v] === null ? '…' : fmt(counts[v] as number)}</span>
                </button>
              ))}
            </div>
            <button type="button" className={`tk-heat ${heat ? 'on' : ''}`} onClick={() => setHeat((h) => !h)} aria-pressed={heat} title="Color tokens by length in bytes">
              {heat ? 'length' : 'boundaries'}
            </button>
          </div>
          <div className="tk-chips-wrap">
            {chips === null ? (
              <div className="tk-loading mono">{tokErr ? `tokenizer did not load: ${tokErr}` : near ? 'loading tokenizer…' : ''}</div>
            ) : (
              <ChipView chips={chips} heat={heat} onHover={setHover} />
            )}
          </div>
          <div className="tk-insp mono" aria-live="polite">
            {hover ? (
              <>
                <span>
                  id <b className="num">{hover.id}</b>
                </span>
                <span>
                  <b className="num">{hover.bytes}</b> {hover.bytes === 1 ? 'byte' : 'bytes'}
                </span>
                <span className="tk-insp-t">{JSON.stringify(hover.text)}</span>
              </>
            ) : (
              <span className="dim">
                {chips && chips.length >= MAX_CHIPS && view !== 'sepia1' ? `first ${fmt(MAX_CHIPS)} tokens shown · ` : ''}
                {stats.sepia && view === 'sepia1' && stats.sepia.length > MAX_CHIPS ? `first ${fmt(MAX_CHIPS)} tokens shown · ` : ''}
                hover a token for its id and bytes · ↵ newline · · space · → tab
              </span>
            )}
          </div>
        </div>

        <Compare counts={counts} bytes={stats.bytes} lines={stats.lines} />
      </div>

      <EvalTable />

      <Rules />

      <div className="tk-foot mono">
        <span>
          tokenizer.json sha256 <b>{EVAL.tokenizer.sha256.slice(0, 16)}…</b>
        </span>
        <a href={tokUrl} download="sepia-1-tokenizer.json">
          download tokenizer.json
        </a>
        <a href="https://github.com/LUSCAINK/LUSCA/tree/main/models/sepia-1-tokenizer" target="_blank" rel="noreferrer">
          model card · eval · manifest
        </a>
        <a href="https://github.com/LUSCAINK/LUSCA/tree/main/scripts/tokenizer" target="_blank" rel="noreferrer">
          training scripts
        </a>
      </div>
    </div>
  )
}

function Stat({ k, v, s, hot }: { k: string; v: string; s: string; hot?: boolean }) {
  return (
    <div className={`tk-stat ${hot ? 'hot-stat' : ''}`}>
      <span className="label">{k}</span>
      <span className="tk-stat-v num">{v}</span>
      <span className="tk-stat-s mono">{s}</span>
    </div>
  )
}

/** Visible whitespace inside a chip: spaces as ·, tabs as →, newlines as ↵ plus a real line break. */
function visual(t: string): ReactNode {
  if (!/[\s]/.test(t)) return t
  const out: ReactNode[] = []
  let buf = ''
  let k = 0
  const flush = () => {
    if (buf) out.push(buf)
    buf = ''
  }
  for (const ch of t) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      flush()
      out.push(
        <i key={k++} className="ws">
          {ch === ' ' ? '·' : ch === '\t' ? '→' : ch === '\r' ? '␍' : '↵'}
        </i>,
      )
      if (ch === '\n') out.push('\n')
    } else buf += ch
  }
  flush()
  return out
}

const ChipView = memo(function ChipView({ chips, heat, onHover }: { chips: Chip[]; heat: boolean; onHover: (c: Chip | null) => void }) {
  const shown = chips.length > MAX_CHIPS ? chips.slice(0, MAX_CHIPS) : chips
  const over = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const el = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null
      if (!el) return
      const c = shown[Number(el.dataset.i)]
      if (c) onHover(c)
    },
    [shown, onHover],
  )
  return (
    <div className={`tk-chips mono ${heat ? 'heat' : ''}`} onMouseOver={over} onMouseLeave={() => onHover(null)}>
      {shown.map((c, i) => (
        <span key={i} data-i={i} className={c.special ? 'tk-c sp' : `tk-c c${i % 4}`} style={heat ? { ['--h' as string]: Math.min(1, (c.bytes - 1) / 9) } : undefined}>
          {visual(c.text)}
        </span>
      ))}
    </div>
  )
})

function Compare({ counts, bytes, lines }: { counts: Record<View, number | null>; bytes: number; lines: number }) {
  const max = Math.max(1, ...Object.values(counts).map((v) => v ?? 0))
  const s = counts.sepia1
  return (
    <div className="tk-cmp panel">
      <div className="panel-head">
        <span>
          this text · <b>tokens</b>
        </span>
        <span>fewer is better</span>
      </div>
      <div className="tk-cmp-rows">
        {(['sepia1', 'o200k', 'cl100k'] as View[]).map((k) => {
          const v = counts[k]
          const d = v !== null && s !== null && k !== 'sepia1' && v > 0 ? (s - v) / v : null
          return (
            <div key={k} className={`tk-cmp-r ${k === 'sepia1' ? 'me' : ''}`}>
              <span className="tk-cmp-k mono">{SHORT[k]}</span>
              <span className="tk-cmp-bar">
                <span style={{ width: `${v === null ? 0 : (v / max) * 100}%` }} />
              </span>
              <span className="tk-cmp-v num">{v === null ? '…' : fmt(v)}</span>
              <span className="tk-cmp-d num">{d === null ? (k === 'sepia1' && s !== null && s > 0 ? `${(bytes / s).toFixed(2)} B/tok` : '') : `${d <= 0 ? '−' : '+'}${Math.abs(d * 100).toFixed(1)}%`}</span>
            </div>
          )
        })}
      </div>
      <div className="tk-cmp-f mono">
        {s !== null && s > 0 && lines > 0 ? (
          <>
            At this rate a 2,048-token SEPIA-1 window holds <b className="num">{fmt(Math.floor((2048 * lines) / s))}</b> lines like these.
          </>
        ) : (
          <>Counts update as you type.</>
        )}
      </div>
    </div>
  )
}

type MetricKey = 'bytesPerToken' | 'tokensPer1kLines' | 'linesPer2048'
const METRICS: { k: MetricKey; label: string; better: 'high' | 'low'; d: number }[] = [
  { k: 'bytesPerToken', label: 'bytes / token', better: 'high', d: 2 },
  { k: 'tokensPer1kLines', label: 'tokens / 1,000 lines', better: 'low', d: 0 },
  { k: 'linesPer2048', label: 'lines / 2,048 window', better: 'high', d: 0 },
]

function EvalTable() {
  const [m, setM] = useState<MetricKey>('bytesPerToken')
  const meta = METRICS.find((x) => x.k === m) as (typeof METRICS)[number]
  const rows = EVAL.languages.filter((l) => m !== 'linesPer2048' || l.id !== 'web')
  return (
    <div className="tk-eval panel">
      <div className="panel-head tk-eval-h">
        <span>
          held-out evaluation · <b>{meta.label}</b> · {meta.better === 'high' ? 'higher' : 'lower'} is better
        </span>
        <div className="tk-seg" role="tablist" aria-label="metric">
          {METRICS.map((x) => (
            <button key={x.k} type="button" role="tab" aria-selected={m === x.k} className={m === x.k ? 'on' : ''} onClick={() => setM(x.k)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <div className="tk-tbl-scroll">
        <table className="tk-tbl">
          <thead>
            <tr>
              <th>language</th>
              <th className="r">files · MB</th>
              {KEYS.map((k) => (
                <th key={k} className={`r ${k === 'sepia1' ? 'me' : ''}`}>
                  {SHORT[k]}
                  <span className="tk-th-v">{fmt(EVAL.compare[k].vocab)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => {
              const vals = KEYS.map((k) => l.tokenizers[k][m])
              const best = meta.better === 'high' ? Math.max(...vals) : Math.min(...vals)
              const top = Math.max(...vals)
              return (
                <tr key={l.id}>
                  <td className="tk-tbl-l">{l.label}</td>
                  <td className="r num dim">
                    {l.docs} · {(l.bytes / 1e6).toFixed(2)}
                  </td>
                  {KEYS.map((k, i) => (
                    <td key={k} className={`r num ${k === 'sepia1' ? 'me' : ''} ${vals[i] === best ? 'best' : ''}`}>
                      <span className="tk-cell-bar" style={{ width: `${(vals[i] / top) * 100}%` }} />
                      <span className="tk-cell-v">{meta.d ? vals[i].toFixed(meta.d) : fmt(vals[i])}</span>
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="tk-eval-f">
        {EVAL.heldOut} Lines per window = 2,048 × lines ÷ tokens. GPT counts from <span className="mono">gpt-tokenizer</span>; o200k_base is the encoding the corpus counts tokens with at
        ingest. SEPIA-1 has a 32,768-entry vocabulary, 3–6× smaller than cl100k and o200k, so it gives up some ground on English prose and keeps the
        embedding table small for volunteer GPUs.
      </p>
    </div>
  )
}

const RULES: { k: string; ex: string[]; d: string }[] = [
  { k: 'indentation', ex: ['↵········'], d: 'A line break plus the next line’s indentation is one pre-token, so each indentation level becomes a single token.' },
  { k: 'operators', ex: ['=>', '->', '::', '==', '&&', '..=', '#['], d: 'Multi-character operators are atomic: never split, never glued to their neighbours.' },
  { k: 'identifiers', ex: ['msg.sender', 'invoke_signed', 'onlyOwner'], d: 'Identifiers and dotted member chains are units; BPE learns merges inside them.' },
  { k: 'digits', ex: ['1', '0', '0', '0'], d: 'Decimal numbers are split one digit per token, for numeric robustness.' },
  { k: 'hex', ex: ['0x', 'dAC1', '7F95', '8D2e', '…'], d: 'Hex literals over 8 digits are cut into 4-digit groups so addresses and hashes do not use up the vocabulary.' },
  { k: 'bytes', ex: ['256 byte tokens'], d: 'Byte-level: any file encodes losslessly, tabs, CRLF and Unicode in comments included.' },
]

function Rules() {
  return (
    <div className="tk-rules">
      {RULES.map((r) => (
        <div key={r.k} className="tk-rule">
          <span className="label">{r.k}</span>
          <div className="tk-rule-ex mono">
            {r.ex.map((x, i) => (
              <span key={i} className={`tk-c c${i % 4}`}>
                {x}
              </span>
            ))}
          </div>
          <p>{r.d}</p>
        </div>
      ))}
    </div>
  )
}
