// ROADMAP — SEPIA-0 → SEPIA-1 → SEPIA-2, with honest status tags.
import { ZONES } from '@shared/protocol'
import { useSampled } from '@/lib/hooks'
import { fmtCompact, fmtInt } from '@/lib/format'
import { fmtLoss } from './model'

const zone = (z: string) => ZONES.find((x) => x.zone === z)!

export function Roadmap() {
  const model = useSampled((s) => s.model, 1000)
  const conn = useSampled((s) => s.conn, 500)
  const bathy = zone('BATHY')
  const hadal = zone('HADAL')

  const stages = [
    {
      name: 'SEPIA-0',
      status: 'live',
      tag: 'LIVE',
      line: 'char-MLP · trains as it reads',
      rows: [
        ['params', model.params ? fmtInt(model.params) : '—'],
        ['data', 'every page the agents keep'],
        ['compute', 'GPU neurons compute gradients · server audits, applies Adam and trains on its CPU'],
        ['state', model.step ? `step ${fmtInt(model.step)} · loss ${fmtLoss(model.loss, 2)}` : 'waiting for corpus'],
      ],
      body: 'Validates the full pipeline end to end: fetch → clean → train on volunteer GPUs → audit → sample, continuously and in public. Output quality is low by design at this size; the loss curve shows progress.',
    },
    {
      name: 'SEPIA-1',
      status: 'next',
      tag: 'NEXT',
      line: 'GPT-style decoder · nanoGPT recipe',
      rows: [
        ['params', '~124M'],
        ['data', 'the full LUSCA dataset, tokenized'],
        ['compute', `${bathy.zone}+ neurons · ≥ ${fmtCompact(bathy.minGflops, 1)} GFLOPS · ${bathy.vram}`],
        ['state', 'not started — gated on neuron capacity'],
      ],
      body: 'a real small language model: BPE tokens, attention, the GPT-2-small shape. trained by volunteers whose GPUs benchmark into the bathypelagic zone or deeper.',
    },
    {
      name: 'SEPIA-2',
      status: 'research',
      tag: 'RESEARCH',
      line: 'decentralized · low-communication',
      rows: [
        ['params', 'open question'],
        ['data', 'LUSCA dataset, versioned snapshots'],
        ['compute', `${hadal.zone} neurons · ≥ ${fmtCompact(hadal.minGflops, 1)} GFLOPS · ${hadal.vram}`],
        ['state', 'design stage · no code yet'],
      ],
      body: 'DiLoCo-style training: each neuron runs hundreds of local steps, then syncs a compressed outer update. weights published openly, every checkpoint.',
    },
  ]

  return (
    <div className="rm">
      <ol className="rm-track">
        {stages.map((s, i) => (
          <li key={s.name} className={`rm-card rm-${s.status}`}>
            <div className="rm-top">
              <span className="rm-i num">0{i}</span>
              <span className={`tag ${s.status === 'live' ? 'hot' : s.status === 'next' ? 'solid' : ''}`}>
                {s.status === 'live' && <span className={`led ${conn === 'live' ? 'on pulse' : 'white'}`} />}
                {s.tag}
              </span>
            </div>
            <h3 className="rm-name display">{s.name}</h3>
            <p className="rm-line mono">{s.line}</p>
            <dl className="rm-rows">
              {s.rows.map(([k, v]) => (
                <div className="kv" key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p className="rm-body">{s.body}</p>
            {i < stages.length - 1 && (
              <span className="rm-arrow" aria-hidden="true">
                →
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="rm-foot">
        <p className="mono">No dates. Each stage starts when the previous stage's loss curve justifies it. Credits are points for verified GPU work, not a stake in any model.</p>
      </div>
    </div>
  )
}
