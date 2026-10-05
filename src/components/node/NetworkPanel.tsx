import type { NeuronInfo } from '@shared/protocol'
import { useNeuron } from '@/lib/gpu'
import { useNow, useSampled } from '@/lib/hooks'
import { DASH, fmtAgo, fmtGflops, fmtInt } from '@/lib/format'
import { shortAddr } from '@/lib/wallet'
import { SecHead } from './Stage'
import { UNREACHABLE_TEXT, serverState } from './flow'
import { fmtG, fmtInk, shortId } from './util'

interface Row extends NeuronInfo {
  you: boolean
}

export function NetworkPanel() {
  const conn = useSampled((s) => s.conn, 500)
  const neurons = useSampled((s) => s.neurons, 700)
  const inkEvents = useSampled((s) => s.ink.slice(0, 40), 500)
  const stats = useSampled((s) => s.stats, 800)
  const me = useNeuron((s) => s.neuronId)
  const now = useNow(1000)
  const srv = serverState(conn)
  const live = srv === 'live'

  // Only the server's list: without it there is nothing on this board to vouch for.
  const rows: Row[] = live ? neurons.map((n) => ({ ...n, you: n.id === me })) : []
  rows.sort((a, b) => b.ink - a.ink || b.gflops - a.gflops)

  const labelOf = (id: string) => {
    const n = neurons.find((x) => x.id === id)
    return n ? n.label : `gpu ${shortId(id)}`
  }

  // Feed: the server's INK events (verified or rejected jobs), newest first.
  const feed = live
    ? inkEvents.map((e) => ({ key: `${e.jobId}`, ts: e.ts, who: e.neuronId === me ? 'you' : labelOf(e.neuronId), ink: e.ink, ok: e.verified, reason: e.reason }))
    : []

  return (
    <section id="network" className="nd-sec" aria-labelledby="net-h">
      <SecHead id="net-h" kicker="network" title="Who’s connected" sub="Every GPU connected to LUSCA right now, ranked by credits earned." />
      <div className="net-sum">
        <div className="ns">
          <div className="label">gpus online</div>
          <div className="ns-v num">{live ? fmtInt(stats.neurons) : '—'}</div>
        </div>
        <div className="ns">
          <div className="label">pooled compute</div>
          <div className="ns-v num">{live ? fmtGflops(stats.gflops) : '—'}</div>
        </div>
        <div className="ns">
          <div className="label">jobs verified</div>
          <div className="ns-v num">{live ? `${fmtInt(stats.jobsVerified)} / ${fmtInt(stats.jobsDone)}` : '—'}</div>
        </div>
        <div className="ns">
          <div className="label">credits issued</div>
          <div className={`ns-v num ${live ? 'hot' : ''}`}>{live ? fmtInk(stats.inkIssued) : '—'}</div>
        </div>
      </div>
      {!live && (
        <p className="nd-note mono net-note" role="status">
          {srv === 'connecting' ? 'connecting to the LUSCA server… the leaderboard and the job feed come from it.' : `${UNREACHABLE_TEXT} the leaderboard and the job feed come from the server.`}
        </p>
      )}
      <div className="nd-grid net-grid">
        <div className="nd-cell net-board">
          <div className="panel-head">
            <span>
              <span className="hot">A</span>&nbsp;&nbsp;<b>Leaderboard</b>
            </span>
            <span className="nd-meta">{rows.length} shown</span>
          </div>
          <div className="lb-wrap" tabIndex={0} role="region" aria-label="GPU leaderboard">
            <table className="lb">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">gpu</th>
                  <th scope="col">tier</th>
                  <th scope="col" className="r">
                    gflops
                  </th>
                  <th scope="col" className="r lb-jobs">
                    jobs
                  </th>
                  <th scope="col" className="r lb-ver">
                    verified
                  </th>
                  <th scope="col" className="r">
                    credits
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="lb-empty">
                      {live ? 'no GPUs connected yet. press start earning to be the first.' : DASH}
                    </td>
                  </tr>
                ) : (
                  rows.slice(0, 50).map((r, i) => (
                    <tr key={r.id} className={r.you ? 'lb-you' : undefined}>
                      <td className="lb-rank num">{String(i + 1).padStart(2, '0')}</td>
                      <td className="lb-n">
                        <span className="lb-label">{r.label}</span>
                        <span className="lb-meta mono">
                          {r.you && <span className="tag hot">you</span>}
                          <span className="tag">{r.kind}</span>
                          {r.wallet ? shortAddr(r.wallet) : 'device'} · {fmtAgo(r.connectedAt, now)}
                        </span>
                      </td>
                      <td className="lb-z mono">{r.zone}</td>
                      <td className="r num">{fmtG(r.gflops)}</td>
                      <td className="r num lb-jobs">{fmtInt(r.jobs)}</td>
                      <td className="r num lb-ver">
                        {fmtInt(r.verified)}
                        {r.jobs > 0 && <span className="lb-pct"> {Math.round((r.verified / Math.max(1, r.verified + r.failed)) * 100)}%</span>}
                      </td>
                      <td className={`r num ${i === 0 ? 'hot' : ''}`}>{fmtInk(r.ink)}</td>
                    </tr>
                  ))
                )}
                {rows.length > 0 && rows.length < 6 && (
                  <tr className="lb-fill">
                    <td colSpan={7}>
                      {`${rows.length} gpu${rows.length === 1 ? '' : 's'} online · the board fills as more join`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="nd-cell net-feed">
          <div className="panel-head">
            <span>
              <span className="hot">B</span>&nbsp;&nbsp;<b>Latest jobs</b>
            </span>
            <span className="nd-meta">{live ? 'credits awarded · newest first' : DASH}</span>
          </div>
          <ol className="ink-feed mono" aria-label="Latest jobs and the credits they earned">
            {feed.length === 0 ? (
              <li className="ink-empty dimmer">{live ? 'waiting for the first verified job on the network.' : DASH}</li>
            ) : (
              feed.map((e) => (
                <li key={e.key} className={`ink-row ${e.ok ? '' : 'ink-bad'}`}>
                  <span className="ink-t">{fmtAgo(e.ts, now)}</span>
                  <span className="ink-who">{e.who}</span>
                  <span className={`ink-v num ${e.ok ? 'hot' : ''}`}>{e.ok ? `+${fmtInk(e.ink)}` : '✕ 0'}</span>
                  <span className="ink-r">{e.reason}</span>
                </li>
              ))
            )}
          </ol>
        </div>
      </div>
    </section>
  )
}
