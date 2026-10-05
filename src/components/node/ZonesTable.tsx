import { ZONES } from '@shared/protocol'
import { useNeuron } from '@/lib/gpu'
import { SecHead } from './Stage'

export function ZonesTable() {
  const zone = useNeuron((s) => s.zone)
  return (
    <section id="tiers" className="nd-sec" aria-labelledby="zones-h">
      <SecHead
        id="zones-h"
        kicker="reference"
        title="GPU tiers"
        sub="Set by your benchmark score. Deeper tier = bigger jobs + a bigger credit bonus. Named after ocean depths."
      />
      <div className="zt-wrap" tabIndex={0} role="region" aria-label="GPU tiers table">
        <table className="zt">
          <thead>
            <tr>
              <th scope="col">tier</th>
              <th scope="col" className="zt-name">
                ocean zone
              </th>
              <th scope="col" className="r">
                min score (gflops)
              </th>
              <th scope="col">typical gpu memory</th>
              <th scope="col" className="r zt-job">
                job size
              </th>
              <th scope="col" className="r">
                credit bonus
              </th>
            </tr>
          </thead>
          <tbody>
            {ZONES.map((z, i) => (
              <tr key={z.zone} className={z.zone === zone ? 'zt-you' : undefined} style={{ ['--zi' as string]: i }}>
                <th scope="row" className="zt-code display">
                  {z.zone}
                  {z.zone === zone && <span className="tag hot zt-tag">you</span>}
                </th>
                <td className="mono zt-name">
                  {z.name} · {z.depth}
                </td>
                <td className="r num">{z.minGflops.toLocaleString('en-US')}</td>
                <td className="mono">{z.vram}</td>
                <td className="r num zt-job">{z.job}</td>
                <td className="r num zt-w">×{z.bonus.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="zt-foot mono">each tier down: 4× bigger jobs and +0.15 on the credit multiplier</p>
    </section>
  )
}
