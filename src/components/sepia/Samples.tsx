// SAMPLES OVER TIME — what SEPIA wrote at each checkpoint, so the learning is visible.
import { useEffect, useMemo, useState } from 'react'
import { bus } from '@/lib/bus'
import { useNow, useSampled } from '@/lib/hooks'
import { fmtInt } from '@/lib/format'
import { useLossHistory } from './history'
import { HP, ago, fmtLoss, idxAtOrBefore, lexiconHits, lexiconSegments, splitPrompt, valAtOrBefore } from './model'

const PAGE = 8

export function Samples() {
  const samples = useSampled((s) => s.samples, 500) // newest first
  const loss = useLossHistory(1500)
  const conn = useSampled((s) => s.conn, 500)
  const now = useNow(5000)
  const [oldestFirst, setOldestFirst] = useState(false)
  const [all, setAll] = useState(false)
  const [fresh, setFresh] = useState<number | null>(null)

  useEffect(() => bus.on('sample', (m) => setFresh(m.step)), [])

  const rows = useMemo(() => {
    const out = samples.map((s) => {
      const i = idxAtOrBefore(loss, s.step)
      const p = i >= 0 ? loss[i] : null
      const v = i >= 0 ? valAtOrBefore(loss, s.step, i) : null
      const split = splitPrompt(s.text)
      return { ...s, ...split, loss: p?.loss ?? null, val: v?.val ?? null, ts: p?.ts ?? null, hits: lexiconHits(split.cont) }
    })
    return oldestFirst ? out.slice().reverse() : out
  }, [samples, loss, oldestFirst])

  const visible = all ? rows : rows.slice(0, PAGE)
  const newestStep = samples[0]?.step ?? -1

  if (!samples.length) {
    return (
      <div className="smp panel">
        <SampleHead count={0} oldestFirst={oldestFirst} setOldestFirst={setOldestFirst} />
        <div className="smp-empty">
          <div className="label">no samples yet</div>
          <p>
            {conn !== 'live'
              ? 'No data until the server is reachable. Samples are generated on the server during training.'
              : `SEPIA writes its first ${HP.sampleLen} characters at step ${fmtInt(HP.sampleEvery)}, then again every ${fmtInt(HP.sampleEvery)} steps.`}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="smp panel">
      <SampleHead count={samples.length} oldestFirst={oldestFirst} setOldestFirst={setOldestFirst} />
      <ol className="smp-list">
        {visible.map((r) => {
          const isNew = r.step === newestStep
          return (
            <li key={r.step} className={`smp-row ${isNew ? 'newest' : ''} ${r.step === fresh ? 'fresh' : ''}`}>
              <div className="smp-rail">
                <span className="smp-dot" aria-hidden="true" />
              </div>
              <div className="smp-meta">
                <span className="smp-step num">
                  <span className="dimmer">#</span>
                  {fmtInt(r.step)}
                </span>
                <span className="smp-loss mono">
                  loss <b>{fmtLoss(r.loss, 2)}</b>
                  {r.val !== null && (
                    <>
                      {' '}
                      · val <b>{fmtLoss(r.val, 2)}</b>
                    </>
                  )}
                </span>
                <span className="smp-sub mono">
                  {r.ts ? ago(r.ts, now) : 'from history'}
                  {isNew && <span className="tag hot smp-tag">latest</span>}
                </span>
              </div>
              <div className="smp-body">
                <p className="smp-text mono">
                  {r.prompt && <span className="smp-p">{r.prompt}</span>}
                  {lexiconSegments(r.cont).map((seg, i) =>
                    seg.hit ? (
                      <mark key={i} className="smp-hit">
                        {seg.s}
                      </mark>
                    ) : (
                      <span key={i}>{seg.s}</span>
                    ),
                  )}
                </p>
                <div className="smp-words mono">
                  <span className="label">crypto words spelled</span>
                  <span className="smp-wc num">{r.hits.length}</span>
                  <span className="smp-wl">{r.hits.length ? r.hits.slice(0, 8).join(' · ') : 'No recognizable words yet'}</span>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      {rows.length > PAGE && (
        <button type="button" className="smp-more btn ghost" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          {all ? 'show fewer' : `show all ${rows.length} samples`}
        </button>
      )}
    </div>
  )
}

function SampleHead({ count, oldestFirst, setOldestFirst }: { count: number; oldestFirst: boolean; setOldestFirst: (v: boolean) => void }) {
  return (
    <div className="panel-head">
      <span>
        <span className="hot">B</span>&nbsp;&nbsp;<b>Its own writing</b>
        <span className="lc-unit">&nbsp;&nbsp;written every {HP.sampleEvery} steps · {count} so far</span>
      </span>
      <span className="seg" role="group" aria-label="sample order">
        <button type="button" aria-pressed={!oldestFirst} className={!oldestFirst ? 'on' : ''} onClick={() => setOldestFirst(false)}>
          newest
        </button>
        <button type="button" aria-pressed={oldestFirst} className={oldestFirst ? 'on' : ''} onClick={() => setOldestFirst(true)}>
          oldest
        </button>
      </span>
    </div>
  )
}
