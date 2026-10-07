import { Suspense, lazy, useEffect, useMemo, type ReactNode } from 'react'
import { LossChart } from '@/components/sepia/LossChart'
import { Talk } from '@/components/sepia/Talk'
import { Samples } from '@/components/sepia/Samples'
import { Dataset } from '@/components/sepia/Dataset'
import { Architecture } from '@/components/sepia/Architecture'
import { Roadmap } from '@/components/sepia/Roadmap'
import { CodeIndex } from '@/components/sepia/CodeIndex'
import { Distributed } from '@/components/sepia/Distributed'
import { HP, LN_VOCAB, MIN_CORPUS, fmtSci, lrAt } from '@/components/sepia/model'
import { useLossHistory } from '@/components/sepia/history'
import { useSampled } from '@/lib/hooks'
import { fmtCompact, fmtInt } from '@/lib/format'
import { Kicker, NextStep, OnThisPage, Terms } from '@/components/docs/pagekit'
import '@/components/obs/parts.css'
import './sepia.css'

// SEPIA-1 tokenizer playground (milestone M1): its own chunk; the tokenizer loads near the viewport.
const TokenizerLab = lazy(() => import('@/components/sepia/tokenizer/Tokenizer'))

export default function Sepia() {
  useEffect(() => {
    document.title = 'Model — LUSCA'
  }, [])

  const model = useSampled((s) => s.model, 300)
  const conn = useSampled((s) => s.conn, 500)
  const loss = useLossHistory(600)
  const last = loss.length ? loss[loss.length - 1] : null
  const seen = last ? last.tokens : model.step * HP.batch
  const epochs = model.corpusChars > 0 ? seen / model.corpusChars : 0
  const lastVal = useMemo(() => {
    for (let i = loss.length - 1; i >= 0; i--) if (loss[i].val !== null) return loss[i].val
    return model.val
  }, [loss, model.val])
  const live = conn === 'live'
  const trained = live && model.step > 0 && model.loss > 0
  const ppl = trained ? Math.exp(model.loss) : null
  const params = model.params
  const gpuRate = (model as unknown as { gpuStepsPerMin?: number }).gpuStepsPerMin
  const gpuActive = typeof gpuRate === 'number' && gpuRate > 0

  const mode =
    conn === 'live'
      ? { tag: 'LIVE', text: model.step > 0 ? (gpuActive ? 'training now · connected GPUs and the server CPU' : 'training now on the LUSCA server CPU') : 'online · waiting for corpus', led: 'on pulse' }
      : conn === 'unreachable'
        ? { tag: 'OFFLINE', text: 'Can’t reach the LUSCA server — reconnecting…', led: '' }
        : { tag: 'CONNECTING', text: 'reaching the coordinator', led: 'white pulse' }

  return (
    <div className="sp">
      <header className="sp-hero">
        <HeroCurve />
        <div className="sp-hero-bar mono">
          <Kicker n="09" name="Model" />
          <span className="sp-mode" role="status">
            <span className={`led ${mode.led}`} />
            <b>{mode.tag}</b>
            <span className="sp-mode-t">· {mode.text}</span>
          </span>
        </div>

        <div className="sp-hero-main">
          <div className="sp-hero-l">
            <h1 className="display sp-title">
              SEPIA<span className="sp-dash">-</span>0
            </h1>
            <p className="sp-lede">
              SEPIA is a small character-level language model trained on every page the agents keep. Connected GPUs compute its training gradients;
              the server audits them and applies the accepted ones. Watch it train and try it.
            </p>
            <OnThisPage
              className="sp-otp"
              links={[
                { id: 'sp-progress', label: 'Training progress' },
                { id: 'sp-dist', label: 'Distributed training' },
                { id: 'sp-try', label: 'Try it' },
                { id: 'sp-data', label: 'What it has read' },
                { id: 'sp-arch', label: 'How it’s built' },
                { id: 'sp-tok', label: 'SEPIA-1 tokenizer' },
                { id: 'sp-code', label: 'What SEPIA-1 will read' },
              ]}
            />
          </div>
          <aside className="sp-hero-r" aria-label="how unsure SEPIA is right now">
            <div className="label">uncertainty · perplexity</div>
            <div className="sp-ppl">
              <span className="sp-ppl-v num">{ppl ? ppl.toFixed(1) : live ? '96' : '—'}</span>
              <span className="sp-ppl-of num">/ 96</span>
            </div>
            <p className="sp-ppl-t">
              {!live ? (
                <>No data until the server is reachable.</>
              ) : ppl ? (
                <>
                  Effective number of candidate symbols per character: about <b>{Math.max(1, Math.round(ppl))}</b> of 96. A uniform guess scores 96.
                </>
              ) : (
                <>Untrained: perplexity equals the vocabulary size (96). Training starts once the agents have ingested {fmtInt(MIN_CORPUS)} characters.</>
              )}
            </p>
          </aside>
        </div>

        <div className="sp-tiles">
          <Tile label="training step" value={live ? model.step : null} fmt={(v) => fmtInt(v)} sub={`lr ${fmtSci(lrAt(model.step))}`} />
          <Tile label="train loss" value={trained ? model.loss : null} fmt={(v) => v.toFixed(3)} sub={trained ? `${(model.loss / Math.LN2).toFixed(2)} bits/char` : `random = ${LN_VOCAB.toFixed(3)}`} hot />
          <Tile label="validation loss" value={live ? (lastVal ?? null) : null} fmt={(v) => v.toFixed(3)} sub={lastVal != null && trained ? `gap ${lastVal - model.loss >= 0 ? '+' : '−'}${Math.abs(lastVal - model.loss).toFixed(3)}` : `every ${HP.valEvery} steps`} />
          <Tile label="parameters" value={live ? params || null : null} fmt={(v) => fmtInt(v)} sub={params ? `${fmtInt((params * 4) / 1024)} KB of float32` : 'awaiting trainer'} />
          <Tile label="text collected" value={live ? model.corpusChars : null} fmt={(v) => fmtCompact(v)} unit="ch" sub={model.corpusChars >= MIN_CORPUS ? 'kept pages, as text' : !live ? 'server not connected' : model.step > 0 ? 'not reported by the server' : `needs ${fmtCompact(MIN_CORPUS, 0)} to start`} />
          <Tile label="steps / sec" value={live ? model.stepsPerSec || null : null} fmt={(v) => v.toFixed(1)} sub={`server CPU · batch ${HP.batch}`} />
          <Tile label="characters read" value={live ? seen : null} fmt={(v) => fmtCompact(v)} sub={epochs > 0 ? `${epochs < 10 ? epochs.toFixed(2) : epochs.toFixed(0)} passes over the text` : 'one prediction per char'} />
        </div>
      </header>

      <Terms keys={['sepia', 'agent', 'arm']} className="sp-terms" />

      <Section id="sp-progress" title="Training progress" kicker="Loss measures how wrong SEPIA’s next-character guesses are — lower is better. The dashed line is a random guess; everything below it is learning.">
        <LossChart />
        <div className="sp-sub">
          <Samples />
        </div>
      </Section>

      <Section
        id="sp-dist"
        title="Distributed training"
        kicker="Who computed the steps. GPU neurons send gradients for batches the server picks; the server CPU trains in between and audits."
      >
        <Distributed />
      </Section>

      <Section id="sp-try" title="Try it" kicker="SEPIA is a small character-level model with a 16-character context and no tokenizer. Enter a prompt and it continues it, one character at a time.">
        <Talk />
      </Section>

      <Section id="sp-data" title="What it has read" kicker="Every page an agent keeps becomes training text. This is SEPIA’s entire reading list.">
        <Dataset />
      </Section>

      <Section id="sp-arch" title="How it’s built" kicker="No attention, no tokenizer: a lookup table, one hidden layer and a choice between 96 symbols.">
        <Architecture />
      </Section>

      <Section id="sp-road" title="Roadmap" kicker="Three stages, each with its current status. No dates.">
        <Roadmap />
      </Section>

      <Section
        id="sp-tok"
        title="SEPIA-1 tokenizer"
        kicker="Milestone M1 of SEPIA-1: a 32,768-entry byte-level BPE trained on protocol code and crypto web text, evaluated on files set aside before training. The tokenizer runs in this tab. SEPIA-1 itself is not trained yet."
      >
        <Suspense fallback={<div className="s1k-loading mono">loading tokenizer…</div>}>
          <TokenizerLab />
        </Suspense>
      </Section>

      <Section
        id="sp-code"
        title="What SEPIA-1 will read"
        kicker="SEPIA-1, the next model, will learn to read real protocol code from public repositories. The list is live from the server; the indexed count rises as each repository is fetched."
      >
        <CodeIndex />
      </Section>

      <NextStep
        className="sp-next"
        text="Connect your GPU and it computes SEPIA training gradients on batches the server picks. Audited results are applied to the model and earn credits, your share of each SOL payout. No install, no account."
        secondary={{ to: '/earn', label: 'How rewards work' }}
      />
    </div>
  )
}

function Section({ id, title, kicker, children }: { id: string; title: string; kicker: string; children: ReactNode }) {
  return (
    <section id={id} className="sp-sec pk-anchor" aria-labelledby={`${id}-h`}>
      <div className="sp-sh">
        <h2 id={`${id}-h`} className="display sp-sh-t">
          {title}
        </h2>
        <p className="sp-sh-k">{kicker}</p>
      </div>
      {children}
    </section>
  )
}

function Tile({ label, value, fmt, sub, hot, unit }: { label: string; value: number | null; fmt: (v: number) => string; sub?: ReactNode; hot?: boolean; unit?: string }) {
  const v = value ?? 0
  return (
    <div className={`sp-tile ${hot ? 'hot-tile' : ''}`}>
      <span className="label">{label}</span>
      <span className="sp-tile-v num">
        {value === null ? '—' : fmt(v)}
        {unit && value !== null && <span className="sp-tile-u">{unit}</span>}
      </span>
      {sub && <span className="sp-tile-s mono">{sub}</span>}
    </div>
  )
}

/** The real loss curve, drawn huge and faint behind the title. */
function HeroCurve() {
  const loss = useLossHistory(1500)
  const d = useMemo(() => {
    if (loss.length < 2) return ''
    const step = Math.max(1, Math.floor(loss.length / 240))
    const pts = loss.filter((_, i) => i % step === 0 || i === loss.length - 1)
    const x0 = Math.log10(Math.max(1, pts[0].step))
    const x1 = Math.log10(Math.max(pts[0].step + 1, pts[pts.length - 1].step))
    let lo = Infinity
    let hi = -Infinity
    for (const p of pts) {
      lo = Math.min(lo, p.loss)
      hi = Math.max(hi, p.loss)
    }
    hi = Math.max(hi, LN_VOCAB)
    let v = pts[0].loss
    return pts
      .map((p, i) => {
        v += (i ? 0.25 : 1) * (p.loss - v)
        const x = ((Math.log10(Math.max(1, p.step)) - x0) / (x1 - x0 || 1)) * 1000
        const y = 40 + (1 - (v - lo) / (hi - lo || 1)) * 320
        return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join('')
  }, [loss])
  if (!d) return null
  return (
    <svg className="sp-hero-curve" viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

