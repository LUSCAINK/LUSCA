// SEPIA-1 TOKENIZER — milestone M1: the trained 32,768-entry byte-level BPE, live in the browser.
// The tokenizer (/models/sepia-1-tokenizer/tokenizer.json, ~400 kB gzipped) loads only when this
// section comes near the viewport. The GPT comparison for the built-in examples is precomputed
// (examples-gpt.json, checked by scripts/tokenizer/_test.ts); the GPT encodings themselves (~1.5 MB
// gzipped) load only once a visitor edits or pastes text. Every number on this panel is either
// computed here from the text in the editor or read from eval.json (the held-out evaluation).
import { Fragment, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react'
import evalRaw from '../../../../models/sepia-1-tokenizer/eval.json?raw'
import { Sepia1Tokenizer, type TokenizerJsonLike } from '@shared/sepia1/tokenizer'
import { EXAMPLES } from './examples'
import EX_GPT from './examples-gpt.json'
import './tokenizer.css'

/** Stable path of the release files (vite.config.ts copies models/sepia-1-tokenizer there). */
const RELEASE = '/models/sepia-1-tokenizer/'
const tokUrl = `${RELEASE}tokenizer.json`

type Metric = { tokens: number; bytesPerToken: number; tokensPer1kLines: number; linesPer2048: number }
type TokKey = 'sepia1' | 'r50k' | 'cl100k' | 'o200k'
interface EvalJson {
  tokenizer: { vocabSize: number; sha256: string }
  heldOut: string
  compare: Record<TokKey, { name: string; vocab: number }>
  languages: { id: string; label: string; docs: number; sources: number; bytes: number; lines: number; tokenizers: Record<TokKey, Metric> }[]
  totals: { code: { bytes: number; lines: number; tokenizers: Record<TokKey, { tokens: number; bytesPerToken: number; tokensPer1kLines: number }>; relative: Record<'r50k' | 'cl100k' | 'o200k', number> } }
  roundTrip: { docs: number; exact: number; bytes: number }
  parity: { docs: number; tokens: number; mismatches: number; fixtures: { strings: number; tokens: number; mismatches: number } }
  speed: { encoderMBps: number }
}
const EVAL = JSON.parse(evalRaw) as EvalJson
const KEYS: TokKey[] = ['sepia1', 'o200k', 'cl100k', 'r50k']
const SHORT: Record<TokKey, string> = { sepia1: 'SEPIA-1', r50k: 'GPT-2 r50k', cl100k: 'cl100k', o200k: 'o200k' }

type View = 'sepia1' | 'o200k' | 'cl100k'
interface Chip {
  id: number
  text: string
  /** null: the token is part of a multi-byte UTF-8 character (decodes to U+FFFD on its own). */
  bytes: number | null
  special?: boolean
}
type GptTokens = [number, string][]
const EXG = EX_GPT as unknown as Record<string, { o200k: GptTokens; cl100k: GptTokens }>
interface GptEnc {
  encode: (t: string, o?: { disallowedSpecial?: Set<string> }) => number[]
  decode: (ids: Iterable<number>) => string
}

const MAX_CHIPS = 3000
const MAX_INPUT = 100_000
/** gpt-tokenizer's BPE is quadratic in the length of one pre-token; skip GPT counts on such input. */
const GPT_MAX_RUN = /\S{5000,}/
const GPT_DEBOUNCE_MS = 250
const enc8 = new TextEncoder()
const fmt = (n: number) => n.toLocaleString('en-US')

/** Cuts pasted text to MAX_INPUT characters, at a line break when there is one, never inside a surrogate pair. */
function capInput(v: string): string {
  if (v.length <= MAX_INPUT) return v
  const nl = v.lastIndexOf('\n', MAX_INPUT - 1)
  if (nl > MAX_INPUT / 2) return v.slice(0, nl + 1)
  let end = MAX_INPUT
  const c = v.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return v.slice(0, end)
}

function gptChips(toks: GptTokens): Chip[] {
  const out: Chip[] = []
  for (let i = 0; i < toks.length && i < MAX_CHIPS; i++) {
    const [id, t] = toks[i]
    out.push({ id, text: t, bytes: t.includes('\uFFFD') ? null : enc8.encode(t).length })
  }
  return out
}

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
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (!el || near) return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: margin })
    io.observe(el)
    return () => io.disconnect()
  }, [near, margin])
  return [ref, near]
}

export default function TokenizerLab({ tokenizer }: { tokenizer?: Sepia1Tokenizer } = {}) {
  const [rootRef, near] = useNearViewport<HTMLDivElement>()
  const [tok, setTok] = useState<Sepia1Tokenizer | null>(tokenizer ?? null)
  const [tokErr, setTokErr] = useState<string | null>(null)
  const [gpt, setGpt] = useState<{ o200k: GptEnc; cl100k: GptEnc } | null>(null)
  const [exId, setExId] = useState<string>(EXAMPLES[0].id)
  const [text, setText] = useState<string>(EXAMPLES[0].code)
  const [cut, setCut] = useState<number | null>(null)
  const [wantGpt, setWantGpt] = useState(false)
  const [view, setView] = useState<View>('sepia1')
  const [heat, setHeat] = useState(false)
  const [hover, setHover] = useState<Chip | null>(null)
  const deferred = useDeferredValue(text)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!near || tok) return
    let live = true
    loadTokenizer().then(
      (t) => live && setTok(t),
      (e: unknown) => live && setTokErr(e instanceof Error ? e.message : 'failed to load'),
    )
    return () => {
      live = false
    }
  }, [near, tok])

  // GPT encodings: only once the visitor edits or pastes (the examples use precomputed tokens)
  useEffect(() => {
    if (!wantGpt || gpt) return
    let live = true
    loadGpt().then(
      (g) => live && setGpt(g),
      () => {},
    )
    return () => {
      live = false
    }
  }, [wantGpt, gpt])

  const example = EXAMPLES.find((e) => e.id === exId) ?? null
  const pre = example && deferred === example.code ? EXG[example.id] : null

  // GPT counts for edited text trail the editor by GPT_DEBOUNCE_MS so typing stays responsive
  const [gptText, setGptText] = useState(deferred)
  useEffect(() => {
    if (pre) return
    const t = setTimeout(() => setGptText(deferred), GPT_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [deferred, pre])

  const stats = useMemo(() => {
    const bytes = enc8.encode(deferred).length
    const lines = deferred.length === 0 ? 0 : deferred.split('\n').length - (deferred.endsWith('\n') ? 1 : 0)
    // special-token strings are counted as plain text, as for the GPT tokenizers and in eval.ts
    const sepia = tok ? tok.tokens(deferred, { allowSpecial: false }) : null
    return { bytes, lines, sepia }
  }, [deferred, tok])

  const gptRes = useMemo(() => {
    if (pre) return { o200k: pre.o200k, cl100k: pre.cl100k, stale: false, skipped: false }
    if (!gpt) return null
    if (GPT_MAX_RUN.test(gptText)) return { o200k: null, cl100k: null, stale: false, skipped: true }
    const plain = { disallowedSpecial: new Set<string>() }
    const row = (enc: GptEnc): GptTokens => enc.encode(gptText, plain).map((id) => [id, ''] as [number, string])
    return { o200k: row(gpt.o200k), cl100k: row(gpt.cl100k), stale: gptText !== deferred, skipped: false }
  }, [pre, gpt, gptText, deferred])

  const chips: Chip[] | null = useMemo(() => {
    if (view === 'sepia1') return stats.sepia
    const toks = gptRes?.[view]
    if (!toks) return null
    if (pre) return gptChips(toks)
    const enc = gpt?.[view]
    if (!enc) return null
    return gptChips(toks.slice(0, MAX_CHIPS).map(([id]) => [id, enc.decode([id])] as [number, string]))
  }, [view, stats, gptRes, gpt, pre])

  const counts: Record<View, number | null> = {
    sepia1: stats.sepia?.length ?? null,
    o200k: gptRes?.o200k?.length ?? null,
    cl100k: gptRes?.cl100k?.length ?? null,
  }
  const gptNote = gptRes?.skipped ? 'GPT counts skipped: one unbroken run over 5,000 characters.' : !pre && !gpt && wantGpt ? 'Loading the GPT encodings…' : null

  const pick = (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id)
    setExId(id)
    setCut(null)
    if (ex) setText(ex.code)
    setHover(null)
  }

  const onEdit = (v: string) => {
    const c = capInput(v)
    setCut(c.length < v.length ? v.length : null)
    setText(c)
    setWantGpt(true)
    if (exId !== 'custom') setExId('custom')
  }

  const code = EVAL.totals.code
  const pct = (r: number) => `${r < 1 ? '−' : '+'}${Math.abs((1 - r) * 100).toFixed(1)}%`

  return (
    <div className="s1k" ref={rootRef}>
      {/* milestone strip */}
      <div className="s1k-ms mono" role="list" aria-label="SEPIA-1 milestones">
        <span className="s1k-ms-i on" role="listitem">
          <span className="led on" />
          <b>M1</b> tokenizer · trained and evaluated
        </span>
        <span className="s1k-ms-i" role="listitem">
          <span className="led" />
          <b>M2</b> WebGPU transformer kernels · not started
        </span>
        <span className="s1k-ms-i" role="listitem">
          <span className="led" />
          <b>SEPIA-1</b> model · not trained yet
        </span>
      </div>

      {/* measured headline numbers */}
      <div className="s1k-stats">
        <Stat k="vocabulary" v={fmt(EVAL.tokenizer.vocabSize)} s="byte-level BPE · 39 special" />
        <Stat k="held-out code · bytes / token" v={code.tokenizers.sepia1.bytesPerToken.toFixed(2)} s={`o200k ${code.tokenizers.o200k.bytesPerToken.toFixed(2)} · cl100k ${code.tokenizers.cl100k.bytesPerToken.toFixed(2)}`} hot />
        <Stat k="tokens for the same code" v={pct(code.relative.o200k)} s={`vs o200k (200k vocab) · ${pct(code.relative.cl100k)} vs cl100k`} />
        <Stat k="vs GPT-2 r50k" v={pct(code.relative.r50k)} s="tokens on held-out code" />
        <Stat k="exact round trip" v={`${Math.floor((EVAL.roundTrip.exact / EVAL.roundTrip.docs) * 1000) / 10}%`} s={`${fmt(EVAL.roundTrip.exact)} of ${fmt(EVAL.roundTrip.docs)} held-out files, byte for byte`} />
        <Stat
          k="browser encoder vs python"
          v={`${EVAL.parity.mismatches} diff`}
          s={`${fmt(EVAL.parity.tokens)} held-out tokens + ${fmt(EVAL.parity.fixtures.strings)} test strings, Unicode 15/16 included`}
        />
      </div>

      {/* playground */}
      <div className="s1k-play">
        <div className="s1k-src panel">
          <div className="panel-head">
            <span>
              source · <b>{exId === 'custom' ? 'your code' : example?.label}</b>
            </span>
            <span className="s1k-src-n num">{fmt(stats.bytes)} B · {fmt(stats.lines)} lines</span>
          </div>
          <div className="s1k-ex" role="tablist" aria-label="examples">
            {EXAMPLES.map((e) => (
              <button key={e.id} type="button" role="tab" aria-selected={exId === e.id} className={`s1k-ex-b ${exId === e.id ? 'on' : ''}`} onClick={() => pick(e.id)}>
                <span className="s1k-ex-l">{e.lang}</span>
                {e.label}
              </button>
            ))}
            <button
              type="button"
              role="tab"
              aria-selected={exId === 'custom'}
              className={`s1k-ex-b ${exId === 'custom' ? 'on' : ''}`}
              onClick={() => {
                if (exId !== 'custom') setText('')
                setExId('custom')
                setCut(null)
                setHover(null)
                setWantGpt(true)
                taRef.current?.focus()
              }}
            >
              <span className="s1k-ex-l">paste</span>
              your code
            </button>
          </div>
          <textarea
            ref={taRef}
            className="s1k-ta mono"
            value={text}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="text to tokenize"
            onChange={(e) => onEdit(e.target.value)}
            onFocus={() => setWantGpt(true)}
            placeholder="Paste a contract, a program or any text."
          />
          {cut !== null && (
            <div className="s1k-cut mono" role="status">
              showing the first {fmt(text.length)} characters of {fmt(cut)} · the counts describe this part
            </div>
          )}
          <div className="s1k-attr mono">
            {exId !== 'custom' && example ? (
              <>
                <span className="s1k-held" title="This file was set aside before training (data-manifest.json, eval split). The tokenizer never saw it.">
                  held out · not in training
                </span>
                <a href={`https://github.com/${example.repo}/blob/${example.commit}/${example.path}#L${example.lines[0]}-L${example.lines[1]}`} target="_blank" rel="noreferrer">
                  {example.repo}@{example.commit.slice(0, 7)} · {example.path} · L{example.lines[0]}–{example.lines[1]}
                </a>
                <span className="s1k-attr-l">{example.license}</span>
              </>
            ) : (
              <span>Your text stays in this browser tab. Nothing is sent to the server.</span>
            )}
          </div>
        </div>

        <div className="s1k-out panel">
          <div className="panel-head s1k-out-h">
            <div className="s1k-seg" role="tablist" aria-label="tokenizer">
              {(['sepia1', 'o200k', 'cl100k'] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  className={`${view === v ? 'on' : ''} ${v !== 'sepia1' && gptRes?.stale ? 'stale' : ''}`}
                  onClick={() => setView(v)}
                  disabled={v !== 'sepia1' && counts[v] === null}
                >
                  {SHORT[v]}
                  <span className="num">{counts[v] === null ? (gptRes?.skipped ? '—' : '…') : fmt(counts[v] as number)}</span>
                </button>
              ))}
            </div>
            <button type="button" className={`s1k-heat ${heat ? 'on' : ''}`} onClick={() => setHeat((h) => !h)} aria-pressed={heat} title="Color tokens by length in bytes">
              color · {heat ? 'length' : 'tokens'}
            </button>
          </div>
          <div className="s1k-chips-wrap">
            {chips === null ? (
              <div className="s1k-loading mono">
                {view !== 'sepia1' ? (gptNote ?? 'Loading the GPT encodings…') : tokErr ? `tokenizer did not load: ${tokErr}` : near ? 'loading tokenizer…' : ''}
              </div>
            ) : (
              <ChipView chips={chips} heat={heat} onHover={setHover} />
            )}
          </div>
          <div className="s1k-insp mono" aria-live="polite">
            {hover ? (
              <>
                <span>
                  id <b className="num">{hover.id}</b>
                </span>
                <span>
                  {hover.bytes === null ? (
                    'part of a multi-byte character'
                  ) : (
                    <>
                      <b className="num">{hover.bytes}</b> {hover.bytes === 1 ? 'byte' : 'bytes'}
                    </>
                  )}
                </span>
                <span className="s1k-insp-t">{JSON.stringify(hover.text)}</span>
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

        <Compare counts={counts} bytes={stats.bytes} lines={stats.lines} stale={!!gptRes?.stale} note={gptNote} />
      </div>

      <EvalTable />

      <Rules />

      <div className="s1k-foot mono">
        <span>
          tokenizer.json sha256 <b>{EVAL.tokenizer.sha256.slice(0, 16)}…</b>
        </span>
        <a href={tokUrl} download="sepia-1-tokenizer.json">
          download tokenizer.json
        </a>
        <a href={`${RELEASE}MODEL_CARD.md`} target="_blank" rel="noreferrer">
          model card
        </a>
        <a href={`${RELEASE}eval.md`} target="_blank" rel="noreferrer">
          eval table
        </a>
        <a href={`${RELEASE}manifest.json`} target="_blank" rel="noreferrer">
          manifest · sha256
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
    <div className={`s1k-stat ${hot ? 'hot-stat' : ''}`}>
      <span className="label">{k}</span>
      <span className="s1k-stat-v num">{v}</span>
      <span className="s1k-stat-s mono">{s}</span>
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
    <div className={`s1k-chips mono ${heat ? 'heat' : ''}`} onMouseOver={over} onMouseLeave={() => onHover(null)}>
      {shown.map((c, i) => (
        <Fragment key={i}>
          <span data-i={i} className={c.special ? 's1k-c s1k-sp' : `s1k-c c${i % 4}`} style={heat ? { ['--h' as string]: Math.min(1, ((c.bytes ?? 1) - 1) / 9) } : undefined}>
            {visual(c.text)}
          </span>
          <wbr />
        </Fragment>
      ))}
    </div>
  )
})

function Compare({ counts, bytes, lines, stale, note }: { counts: Record<View, number | null>; bytes: number; lines: number; stale: boolean; note: string | null }) {
  const max = Math.max(1, ...Object.values(counts).map((v) => v ?? 0))
  const s = counts.sepia1
  return (
    <div className="s1k-cmp panel">
      <div className="panel-head">
        <span>
          this text · <b>tokens</b>
        </span>
        <span>fewer is better</span>
      </div>
      <div className="s1k-cmp-rows">
        {(['sepia1', 'o200k', 'cl100k'] as View[]).map((k) => {
          const v = counts[k]
          const d = v !== null && s !== null && k !== 'sepia1' && v > 0 ? (s - v) / v : null
          return (
            <div key={k} className={`s1k-cmp-r ${k === 'sepia1' ? 'me' : ''} ${k !== 'sepia1' && stale ? 'stale' : ''}`}>
              <span className="s1k-cmp-k mono">{SHORT[k]}</span>
              <span className="s1k-cmp-bar">
                <span style={{ width: `${v === null ? 0 : (v / max) * 100}%` }} />
              </span>
              <span className="s1k-cmp-v num">{v === null ? '…' : fmt(v)}</span>
              <span className="s1k-cmp-d num">{d === null ? (k === 'sepia1' && s !== null && s > 0 ? `${(bytes / s).toFixed(2)} B/tok` : '') : `${d <= 0 ? '−' : '+'}${Math.abs(d * 100).toFixed(1)}%`}</span>
            </div>
          )
        })}
      </div>
      <div className="s1k-cmp-f mono">
        {note ? (
          <>{note}</>
        ) : s !== null && s > 0 && lines > 0 ? (
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

const SMALL = 30

function EvalTable() {
  const [m, setM] = useState<MetricKey>('bytesPerToken')
  const meta = METRICS.find((x) => x.k === m) as (typeof METRICS)[number]
  const rows = EVAL.languages.filter((l) => m !== 'linesPer2048' || l.id !== 'web')
  return (
    <div className="s1k-eval panel">
      <div className="panel-head s1k-eval-h">
        <span>
          held-out evaluation · <b>{meta.label}</b> · {meta.better === 'high' ? 'higher' : 'lower'} is better
        </span>
        <div className="s1k-seg" role="tablist" aria-label="metric">
          {METRICS.map((x) => (
            <button key={x.k} type="button" role="tab" aria-selected={m === x.k} className={m === x.k ? 'on' : ''} onClick={() => setM(x.k)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <div className="s1k-tbl-scroll">
        <table className="s1k-tbl">
          <thead>
            <tr>
              <th>language</th>
              <th className="r">files · MB</th>
              {KEYS.map((k) => (
                <th key={k} className={`r col-${k} ${k === 'sepia1' ? 'me' : ''}`}>
                  {SHORT[k]}
                  <span className="s1k-th-v">{fmt(EVAL.compare[k].vocab)}</span>
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
                <tr key={l.id} className={l.docs < SMALL ? 'small' : ''}>
                  <td className="s1k-tbl-l">
                    {l.label}
                    {l.docs < SMALL && (
                      <sup className="s1k-small" title={`only ${l.docs} held-out files: indicative`}>
                        †
                      </sup>
                    )}
                  </td>
                  <td className="r num dim">
                    {l.docs} · {(l.bytes / 1e6).toFixed(2)}
                  </td>
                  {KEYS.map((k, i) => (
                    <td key={k} className={`r num col-${k} ${k === 'sepia1' ? 'me' : ''} ${vals[i] === best ? 'best' : ''}`}>
                      <span className="s1k-cell-bar" style={{ width: `${(vals[i] / top) * 100}%` }} />
                      <span className="s1k-cell-v">{meta.d ? vals[i].toFixed(meta.d) : fmt(vals[i])}</span>
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="s1k-eval-f">
        Code is held out by file: other files of the same repositories are in training, so the code numbers may be slightly optimistic. † fewer than {SMALL} held-out
        files, indicative only. <span className="s1k-mob-only">On a narrow screen the table shows SEPIA-1 and o200k; cl100k and r50k are in the eval table linked below. </span>
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
    <div className="s1k-rules">
      {RULES.map((r) => (
        <div key={r.k} className="s1k-rule">
          <span className="label">{r.k}</span>
          <div className="s1k-rule-ex mono">
            {r.ex.map((x, i) => (
              <span key={i} className={`s1k-c c${i % 4}`}>
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
