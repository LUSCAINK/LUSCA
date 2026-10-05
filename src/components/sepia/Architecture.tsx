// ARCHITECTURE — a precise drawing of SEPIA-0 (Bengio 2003 / makemore-style char-MLP).
import type { ReactNode } from 'react'
import { useSampled } from '@/lib/hooks'
import { fmtInt } from '@/lib/format'
import { HP, VOCAB, dimsOf, fmtSci, layerParams, lrAt, splitPrompt } from './model'

const glyph = (c: string) => (c === '\n' ? '↵' : c === ' ' ? '␣' : c)

export function Architecture() {
  const model = useSampled((s) => s.model, 1000)
  const sample = useSampled((s) => s.samples[0]?.text ?? null, 2000)
  const d = dimsOf(model)
  const p = layerParams(d)
  const total = model.params > 0 ? model.params : p.total
  const concat = d.ctx * d.emb

  // a real 16-char window: the opening of SEPIA's latest sample (or a seed prompt)
  const src = sample ? splitPrompt(sample).cont.replace(/\s+/g, ' ').trim() : ''
  const win = (src.length >= d.ctx ? src.slice(0, d.ctx) : 'Proposal: the va'.slice(0, d.ctx)).padEnd(d.ctx, ' ')

  const share = (n: number) => (n / p.total) * 100
  const tanhPts = Array.from({ length: 41 }, (_, i) => {
    const x = -3 + (i / 40) * 6
    return `${(((x + 3) / 6) * 100).toFixed(1)},${(50 - Math.tanh(x) * 40).toFixed(1)}`
  }).join(' ')

  return (
    <div className="ar">
      <div className="ar-flow panel" role="group" aria-label={`SEPIA-0 forward pass: ${d.ctx} characters, embedding ${d.emb}, concatenated to ${concat}, hidden layer ${d.hidden} with tanh, ${d.vocab} logits, softmax.`}>
        <div className="panel-head">
          <span>
            <span className="hot">H</span>&nbsp;&nbsp;<b>Forward pass</b>
          </span>
          <span className="ar-arch">{model.arch !== '—' ? model.arch : `char-MLP · ctx ${d.ctx} · emb ${d.emb} · hidden ${d.hidden} · tanh`}</span>
        </div>
        <ol className="ar-stages">
          <Stage i="01" op="context" shape={`${d.ctx}`} unit="chars" note={`last ${d.ctx} symbols · ids 0–${d.vocab - 1}`} params={0}>
            <div className="ar-ctx" aria-hidden="true">
              {[...win].map((c, k) => (
                <span key={k}>{glyph(c)}</span>
              ))}
              <span className="ar-next">?</span>
            </div>
          </Stage>
          <Stage i="02" op="embed" shape={`${d.ctx}×${d.emb}`} unit="lookup" note={`table C · ${d.vocab}×${d.emb}`} params={p.emb}>
            <div className="ar-emb" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${d.ctx}, 1fr)` }}>
              {Array.from({ length: d.ctx }, (_, k) => (
                <span key={k} className="ar-emb-col" />
              ))}
            </div>
          </Stage>
          <Stage i="03" op="concat" shape={`${concat}`} unit="flat" note={`${d.ctx} vectors end to end`} params={0}>
            <div className="ar-cat" aria-hidden="true">
              {Array.from({ length: d.ctx }, (_, k) => (
                <span key={k} />
              ))}
            </div>
          </Stage>
          <Stage i="04" op="hidden" shape={`${d.hidden}`} unit="tanh" note={`W1 ${concat}×${d.hidden} + b1`} params={p.w1 + p.b1} hot>
            <svg className="ar-tanh" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <line x1="0" y1="50" x2="100" y2="50" className="ar-ax" />
              <line x1="50" y1="6" x2="50" y2="94" className="ar-ax" />
              <line x1="0" y1="10" x2="100" y2="10" className="ar-lim" />
              <line x1="0" y1="90" x2="100" y2="90" className="ar-lim" />
              <polyline points={tanhPts} className="ar-curve" />
            </svg>
          </Stage>
          <Stage i="05" op="logits" shape={`${d.vocab}`} unit="scores" note={`W2 ${d.hidden}×${d.vocab} + b2`} params={p.w2 + p.b2}>
            <div className="ar-logits" aria-hidden="true">
              {Array.from({ length: d.vocab }, (_, k) => (
                <span key={k} />
              ))}
            </div>
          </Stage>
          <Stage i="06" op="softmax" shape="p(·)" unit="next char" note="sample at temperature T" params={0}>
            <div className="ar-vocab" aria-hidden="true">
              {[...VOCAB].map((c, k) => (
                <span key={k}>{glyph(c)}</span>
              ))}
            </div>
          </Stage>
        </ol>
      </div>

      <div className="ar-side">
        <section className="ar-params panel" aria-labelledby="ar-params-h">
          <div className="panel-head">
            <span id="ar-params-h">
              <span className="hot">I</span>&nbsp;&nbsp;<b>Parameters</b>
            </span>
            <span>float32 · {fmtInt((total * 4) / 1024)} KB</span>
          </div>
          <div className="ar-total">
            <span className="ar-total-v num">{fmtInt(total)}</span>
            <span className="label">trainable parameters{model.params > 0 ? ' · reported by the trainer' : ' · from the architecture'}</span>
          </div>
          <div className="ar-stack" aria-hidden="true">
            <i className="s-emb" style={{ width: `${share(p.emb)}%` }} />
            <i className="s-w1" style={{ width: `${share(p.w1 + p.b1)}%` }} />
            <i className="s-w2" style={{ width: `${share(p.w2 + p.b2)}%` }} />
          </div>
          <table className="ar-ptable">
            <tbody>
              <PRow sw="s-emb" name="embedding C" shape={`${d.vocab} × ${d.emb}`} n={p.emb} pct={share(p.emb)} />
              <PRow sw="s-w1" name="hidden W1 + b1" shape={`${concat} × ${d.hidden} + ${d.hidden}`} n={p.w1 + p.b1} pct={share(p.w1 + p.b1)} />
              <PRow sw="s-w2" name="output W2 + b2" shape={`${d.hidden} × ${d.vocab} + ${d.vocab}`} n={p.w2 + p.b2} pct={share(p.w2 + p.b2)} />
            </tbody>
          </table>
          {model.params > 0 && model.params !== p.total && (
            <p className="ar-warn mono">layer sum {fmtInt(p.total)} differs from the reported {fmtInt(model.params)} — this feed's metadata is approximate.</p>
          )}
        </section>

        <section className="ar-train panel" aria-labelledby="ar-train-h">
          <div className="panel-head">
            <span id="ar-train-h">
              <span className="hot">J</span>&nbsp;&nbsp;<b>Training</b>
            </span>
            <span>lr now {fmtSci(lrAt(model.step))}</span>
          </div>
          <dl className="ar-kv">
            <KV k="objective">next-char cross-entropy · nats</KV>
            <KV k="optimizer">
              Adam · β {HP.beta1} / {HP.beta2}
            </KV>
            <KV k="batch">
              {HP.batch} windows × {d.ctx} chars
            </KV>
            <KV k="learning rate">
              {fmtSci(HP.lrMax)} → {fmtSci(HP.lrMin)} · warmup {HP.warmup} · cosine {fmtInt(HP.decay / 1000)}k
            </KV>
            <KV k="grad clip">global norm {HP.clip.toFixed(1)}</KV>
            <KV k="validation">
              every {HP.valEvery} steps · {HP.valBatches} batches · 1 in {HP.holdoutEvery} docs
            </KV>
            <KV k="samples">
              every {HP.sampleEvery} steps · {HP.sampleLen} chars · T {HP.sampleTemp}
            </KV>
            <KV k="vocab">{d.vocab} symbols · newline + printable ascii</KV>
            <KV k="compute">worker thread · ≤ {Math.round(HP.duty * 100)}% of one cpu core</KV>
            <KV k="checkpoint">every {HP.ckptSec} s · weights + adam moments</KV>
          </dl>
        </section>
      </div>
    </div>
  )
}

function Stage({ i, op, shape, unit, note, params, hot, children }: { i: string; op: string; shape: string; unit: string; note: string; params: number; hot?: boolean; children: ReactNode }) {
  return (
    <li className={`ar-st ${hot ? 'hot-st' : ''}`}>
      <div className="ar-st-h">
        <span className="ar-i num">{i}</span>
        <span className="ar-op">{op}</span>
      </div>
      <div className="ar-viz">{children}</div>
      <div className="ar-shape">
        <span className="ar-shape-v num">{shape}</span>
        <span className="ar-unit">{unit}</span>
      </div>
      <div className="ar-note mono">{note}</div>
      <div className="ar-p mono">
        <span className="label">params</span>
        <span className="num">{params ? fmtInt(params) : '0'}</span>
      </div>
    </li>
  )
}

function PRow({ sw, name, shape, n, pct }: { sw: string; name: string; shape: string; n: number; pct: number }) {
  return (
    <tr>
      <td className="ar-pt-n">
        <i className={`ar-sw ${sw}`} aria-hidden="true" />
        {name}
      </td>
      <td className="ar-pt-s mono">{shape}</td>
      <td className="ar-pt-v num">{fmtInt(n)}</td>
      <td className="ar-pt-p num">{pct.toFixed(1)}%</td>
    </tr>
  )
}

function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  )
}
