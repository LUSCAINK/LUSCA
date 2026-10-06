import { Link } from 'react-router-dom'
import { ZONES } from '@shared/protocol'
import { fmtInt } from '@/lib/format'
import { useSampled } from '@/lib/hooks'
import { CONN_TEXT } from '@/lib/store'
import { HUB, MODEL } from '../facts'
import { C, Callout, Formula, H3, Src, Table } from '../ui'

function LiveModel() {
  const m = useSampled((s) => s.model, 1000)
  const conn = useSampled((s) => s.conn, 1000)
  const live = conn === 'live'
  if (!live) {
    return (
      <div className="dlive mono" aria-live="off">
        <span className="led" />
        <span className="dlive-k">{CONN_TEXT[conn]}</span>
        <span>
          params <b>—</b>
        </span>
        <span>
          step <b>—</b>
        </span>
        <span>
          loss <b>—</b>
        </span>
        <span>
          val <b>—</b>
        </span>
      </div>
    )
  }
  return (
    <div className="dlive mono" aria-live="off">
      <span className="led on pulse" />
      <span className="dlive-k">reported by live server</span>
      <span>
        params <b>{m.params ? fmtInt(m.params) : '—'}</b>
      </span>
      <span>
        step <b>{m.step ? fmtInt(m.step) : '—'}</b>
      </span>
      <span>
        loss <b>{m.loss ? m.loss.toFixed(3) : '—'}</b>
      </span>
      <span>
        val <b>{m.val != null ? m.val.toFixed(3) : '—'}</b>
      </span>
      <span className="dlive-arch">{m.arch && m.arch !== '—' ? m.arch : ''}</span>
    </div>
  )
}

export function Sepia() {
  const bathy = ZONES.find((z) => z.zone === 'BATHY')!
  const hadal = ZONES.find((z) => z.zone === 'HADAL')!
  return (
    <>
      <p className="dlead">
        SEPIA-0 is a character-level multilayer perceptron — the Bengio et al. (2003) neural language model, in the shape Karpathy’s makemore teaches.
        It trains continuously, in public, on exactly the text the arms accept. Connected GPU neurons compute its training gradients on batches the
        server picks; the server audits them and applies the accepted ones with Adam, and keeps training on one CPU core when no GPU work arrives. It is
        small on purpose: a full gradient can be recomputed on the server to check a neuron, and its loss curve moves within minutes.
      </p>
      <LiveModel />

      <H3 id="sepia-arch" n="7.1">
        Architecture
      </H3>
      <Formula
        label="forward pass — server/trainer/model.mjs"
        rows={[
          ['x', 'concat( emb[id₁] … emb[id₁₆] )', '16 chars × 24 dims = 384'],
          ['h', 'tanh( x · W1 + b1 )', '384 → 384'],
          ['logits', 'h · W2 + b2', '384 → 96'],
          ['loss', 'mean over batch of −log softmax(logits)[target]', 'nats per character'],
        ]}
      />
      <Table label="SEPIA-0 specification">
        <thead>
          <tr>
            <th>property</th>
            <th>value</th>
            <th>notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>vocabulary</td>
            <td className="num strong">{MODEL.vocab}</td>
            <td>
              <C>\n</C> + printable ASCII 32–126. Text is NFKD-normalized; accents dropped, curly quotes and dashes folded to ASCII, anything else
              becomes a space; whitespace runs collapsed.
            </td>
          </tr>
          <tr>
            <td>context</td>
            <td className="num strong">{MODEL.ctx} chars</td>
            <td>Positions near a document start are left-padded with <C>\n</C>.</td>
          </tr>
          <tr>
            <td>embedding</td>
            <td className="num strong">{MODEL.emb}</td>
            <td>per character</td>
          </tr>
          <tr>
            <td>hidden</td>
            <td className="num strong">{MODEL.hidden}</td>
            <td>one layer, tanh</td>
          </tr>
          <tr>
            <td>parameters</td>
            <td className="num strong">{fmtInt(MODEL.params)}</td>
            <td className="mono small">
              emb {fmtInt(MODEL.pEmb)} · W1 {fmtInt(MODEL.pW1)} · b1 {fmtInt(MODEL.pB1)} · W2 {fmtInt(MODEL.pW2)} · b2 {fmtInt(MODEL.pB2)}
            </td>
          </tr>
          <tr>
            <td>precision</td>
            <td className="num strong">float32</td>
            <td>one flat typed array; hand-written backward pass, checked against finite differences</td>
          </tr>
          <tr>
            <td>init</td>
            <td className="mono">emb N(0,1) · W1 N(0, 1/384) · W2 N(0, (0.1/√384)²)</td>
            <td>initial loss ≈ ln 96 = 4.564</td>
          </tr>
        </tbody>
      </Table>

      <H3 id="sepia-training" n="7.2">
        Training
      </H3>
      <Table label="SEPIA-0 training configuration">
        <tbody>
          <tr>
            <td>optimizer</td>
            <td className="mono strong">
              Adam · β₁ {MODEL.beta1} · β₂ {MODEL.beta2} · ε 1e-8
            </td>
            <td>global grad-norm clip {MODEL.clip.toFixed(1)}; a non-finite loss or norm skips the step</td>
          </tr>
          <tr>
            <td>schedule</td>
            <td className="mono strong">
              warmup {MODEL.warmup} → {MODEL.lrMax.toExponential(0)} · cosine {fmtInt(MODEL.decay)} → {MODEL.lrMin.toExponential(0)}
            </td>
            <td>linear warmup, cosine decay, then hold at the floor</td>
          </tr>
          <tr>
            <td>batch</td>
            <td className="mono strong">{MODEL.batch}</td>
            <td>(context, next char) pairs drawn uniformly over every character position of the training split</td>
          </tr>
          <tr>
            <td>corpus</td>
            <td className="mono strong">
              {fmtInt(MODEL.minChars)} … {fmtInt(MODEL.maxChars)} chars
            </td>
            <td>
              training starts at the floor; beyond the cap the oldest documents are evicted. Documents under {MODEL.minDocChars} chars are ignored.
            </td>
          </tr>
          <tr>
            <td>validation</td>
            <td className="mono strong">every {MODEL.holdoutEvery}th document</td>
            <td>
              held out; val loss every {MODEL.valEvery} steps, averaged over {MODEL.valBatches} fixed-seed batches so the curve tracks the model, not
              sampling noise
            </td>
          </tr>
          <tr>
            <td>logging</td>
            <td className="mono strong">loss / {MODEL.lossEvery} steps</td>
            <td>
              mean train loss per {MODEL.lossEvery} steps; a {MODEL.sampleLen}-char sample at T = {MODEL.sampleTemp} every {MODEL.sampleEvery} steps from
              rotating prompts (<C>The validator </C>, <C>EIP-</C>, <C>Proposal: </C>…)
            </td>
          </tr>
          <tr>
            <td>compute</td>
            <td className="mono strong">1 worker thread · {Math.round(MODEL.duty * 100)}% duty</td>
            <td>
              {MODEL.chunkMs} ms of steps, then yield. The server’s own CPU steps continue alongside GPU training jobs and give way to audits while GPU
              results are arriving (<Link to="/docs/neurons">08.3</Link>)
            </td>
          </tr>
          <tr>
            <td>checkpoint</td>
            <td className="mono strong">sepia.ckpt · every {MODEL.ckptEveryS} s</td>
            <td>
              params + Adam moments + loss history; also on shutdown; restored on boot when the architecture matches. After a crash the weights resume
              from the last checkpoint and the step number from <C>progress.json</C>: up to {MODEL.stepBlock} step numbers are skipped, none is shown twice
            </td>
          </tr>
        </tbody>
      </Table>
      <p>
        Every applied update, from a neuron or from the server’s own worker, advances the weights version by one and goes through the same Adam state,
        gradient clip and learning-rate schedule. A neuron result computed against an older version is still applied if it is at most{' '}
        <C>LUSCA_TRAIN_MAX_STALE</C> (default 64) versions behind; older results are marked stale and not applied. The job flow, batch sizes and audits
        are in <Link to="/docs/neurons">08.3</Link>.
      </p>
      <p>
        <C>LossPoint.tokens</C> on the wire is <C>step × {MODEL.batch}</C>: characters predicted so far, which overcounts unique text because positions
        are sampled with replacement.
      </p>

      <H3 id="sepia-generate" n="7.3">
        Talking to it
      </H3>
      <p>
        <C>POST /api/generate</C> samples autoregressively from the latest weights: prompt ≤ 200 characters (only the last {MODEL.ctx} matter), up to
        600 characters out (default 240), temperature 0.05–2 (default 0.8). Limited to {HUB.generatePerMin} requests per minute per IP and{' '}
        {HUB.generateConcurrency} concurrent generations. The <Link to="/sepia">Model</Link> page is a client for this route.
      </p>
      <Callout kind="honest" title="size">
        {fmtInt(MODEL.params)} parameters and a {MODEL.ctx}-character window. GPT-2 small is 124M — about 660× larger, with a 1,024-token window.
        SEPIA-0 learns spelling, crypto vocabulary, punctuation and the rhythm of forum prose. It does not know facts, follow instructions or stay on a
        topic past a few words. Treat its samples as a live readout of the dataset’s texture, not as answers.
      </Callout>

      <H3 id="sepia-roadmap" n="7.4">
        Roadmap
      </H3>
      <Table label="SEPIA roadmap">
        <thead>
          <tr>
            <th>model</th>
            <th>status</th>
            <th>shape</th>
            <th>compute</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="mono strong">SEPIA-0</td>
            <td>
              <span className="tag hot">live</span>
            </td>
            <td>char-MLP · {fmtInt(MODEL.params)} params</td>
            <td>GPU neurons compute gradients on server-picked batches; the coordinator audits them, applies them with Adam and trains on one CPU worker</td>
          </tr>
          <tr>
            <td className="mono strong">SEPIA-1</td>
            <td>
              <span className="tag solid">next</span>
            </td>
            <td>
              GPT-style decoder, nanoGPT recipe, ~124M params, BPE tokens, trained on the LUSCA dataset and the protocol code index (listed on the <Link to="/sepia">Model</Link> page)
            </td>
            <td>
              {bathy.zone}+ neurons (≥ {fmtInt(bathy.minGflops)} GFLOPS, {bathy.vram})
            </td>
          </tr>
          <tr>
            <td className="mono strong">SEPIA-2</td>
            <td>
              <span className="tag">research</span>
            </td>
            <td>decentralized, low-communication training</td>
            <td>
              {hadal.zone} neurons (≥ {fmtInt(hadal.minGflops)} GFLOPS, {hadal.vram})
            </td>
          </tr>
        </tbody>
      </Table>
      <p>
        SEPIA-2 follows the DiLoCo pattern: each worker holds a model replica and runs hundreds of local optimizer steps on its own data shard, then
        workers exchange only the difference from the last synchronized weights (an outer “pseudo-gradient”), applied with an outer optimizer such as
        Nesterov momentum. Synchronizing every few hundred steps instead of every step is what makes training over home connections plausible.
      </p>
      <Callout kind="roadmap">
        SEPIA-1 is not started; it is gated on enough BATHY-class neuron capacity. SEPIA-2 is at the design stage with no code. Neither has a date.
      </Callout>
      <Src path="server/trainer/model.mjs · worker.mjs · trainer.ts" />
    </>
  )
}
