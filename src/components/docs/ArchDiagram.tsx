// System diagram, drawn by hand in SVG so every box and arrow maps to a module.
// Letters (W, A, D, T, H, N, E, R, K) are referenced by the prose below it.

interface BoxProps {
  x: number
  y: number
  w: number
  h: number
  i: string
  title: string
  meta?: string
  lines: string[]
  hot?: boolean
}

function Box({ x, y, w, h, i, title, meta, lines, hot }: BoxProps) {
  return (
    <g className={`ad-box${hot ? ' hot' : ''}`}>
      <rect x={x} y={y} width={w} height={h} className="ad-rect" />
      <rect x={x} y={y} width={w} height={22} className="ad-headbg" />
      <line x1={x} y1={y + 22} x2={x + w} y2={y + 22} className="ad-sep" />
      <text x={x + 10} y={y + 15} className="ad-i">
        {i}
      </text>
      <text x={x + 24} y={y + 15} className="ad-t">
        {title.toUpperCase()}
      </text>
      {meta && (
        <text x={x + w - 10} y={y + 15} className="ad-m" textAnchor="end">
          {meta}
        </text>
      )}
      {lines.map((l, k) =>
        l ? (
          <text key={k} x={x + 10} y={y + 40 + k * 15} className="ad-s">
            {l}
          </text>
        ) : null,
      )}
    </g>
  )
}

function Label({ x, y, children, anchor = 'middle' }: { x: number; y: number; children: string; anchor?: 'start' | 'middle' | 'end' }) {
  return (
    <text x={x} y={y} className="ad-lab" textAnchor={anchor}>
      {children}
    </text>
  )
}

const STAGES = ['seek', 'fetch', 'parse', 'taste', 'dedupe', 'store']

export function ArchDiagram() {
  return (
    <figure className="adiag">
      <div className="adiag-scroll" role="region" aria-label="Architecture diagram (scrolls horizontally on small screens)" tabIndex={0}>
        <svg viewBox="0 0 1040 590" className="adiag-svg" role="img" aria-labelledby="adiag-title adiag-desc">
          <title id="adiag-title">LUSCA architecture</title>
          <desc id="adiag-desc">
            Data agents fetch from the web and exchange URLs with the frontier. Accepted pages are appended to dataset.jsonl and streamed to the
            trainer worker. The coordinator builds jobs from page vectors, sends them to neurons over the WebSocket, verifies results and reports
            duplicates back to the ingest pipeline. All modules emit events to the hub, which fans them out to clients. The payout engine closes each
            payout period, splits the pool by confirmed credits and sends SOL to verified wallets.
          </desc>
          <defs>
            <marker id="docs-arr" viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="ad-arrhead" />
            </marker>
            <marker id="docs-arr-hot" viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="ad-arrhead hot" />
            </marker>
            <pattern id="docs-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" className="ad-hatch" />
            </pattern>
          </defs>

          {/* ── boxes ── */}
          <Box
            x={20}
            y={40}
            w={170}
            h={150}
            i="W"
            title="the web"
            lines={['41 seed pages · 8 arms', '≤ 250 admitted hosts', 'robots.txt per origin', 'html only · ≤ 2 MB', '12 s per request']}
          />

          <g className="ad-box">
            <rect x={250} y={40} width={360} height={230} className="ad-rect" />
            <rect x={250} y={40} width={360} height={22} className="ad-headbg" />
            <line x1={250} y1={62} x2={610} y2={62} className="ad-sep" />
            <text x={260} y={55} className="ad-i">
              A
            </text>
            <text x={274} y={55} className="ad-t">
              AGENTS · INGEST
            </text>
            <text x={600} y={55} className="ad-m" textAnchor="end">
              server/ingest
            </text>

            <rect x={266} y={76} width={140} height={66} className="ad-sub" />
            <text x={276} y={93} className="ad-t2">
              AGENTS × 24
            </text>
            <text x={276} y={111} className="ad-s">
              8 arms · 3 per arm
            </text>
            <text x={276} y={126} className="ad-s">
              one loop each
            </text>

            <rect x={454} y={76} width={140} height={66} className="ad-sub" />
            <text x={464} y={93} className="ad-t2">
              FRONTIER
            </text>
            <text x={464} y={111} className="ad-s">
              per-host heaps
            </text>
            <text x={464} y={126} className="ad-s">
              ≤ 60k · ≤ 400/host
            </text>

            {STAGES.map((s, k) => {
              const x = 266 + k * 55.2
              const hot = s === 'taste'
              return (
                <g key={s}>
                  <rect x={x} y={158} width={52} height={24} className={hot ? 'ad-cell hot' : 'ad-cell'} />
                  <text x={x + 26} y={174} className={hot ? 'ad-cellt hot' : 'ad-cellt'} textAnchor="middle">
                    {s}
                  </text>
                </g>
              )
            })}
            <text x={266} y={206} className="ad-s">
              HostTable · RobotsCache · SimIndex
            </text>
            <text x={266} y={222} className="ad-s">
              vectors of the newest 20,000 pages
            </text>
            <text x={266} y={238} className="ad-s dimmer">
              reject · error · sleep → seek again
            </text>
          </g>

          <Box x={670} y={40} w={170} h={70} i="D" title="dataset" lines={['dataset.jsonl', 'append · 1 page / line']} />
          <Box
            x={670}
            y={150}
            w={170}
            h={120}
            i="T"
            title="trainer"
            meta="worker"
            lines={['SEPIA-0 · 187,104 p', 'Adam · batch 64', '85% of one core', 'sepia.ckpt / 90 s']}
          />
          <Box
            x={880}
            y={40}
            w={140}
            h={400}
            i="H"
            title="hub"
            meta="http.ts"
            lines={[
              'GET /api/*',
              'WS  /ws',
              '',
              'hello on connect',
              'broadcast fan-out',
              'stats every 1 s',
              'ping every 30 s',
              '',
              'drop non-essential',
              'at 4 MB backlog',
              'cut at 64 MB',
              '',
              '≤ 4,000 clients',
              '≤ 64 per ip',
              '30 msg/s inbound',
              '',
              'one JSON frame',
              'per event,',
              'serialized once',
            ]}
          />
          <Box
            x={20}
            y={330}
            w={170}
            h={130}
            i="N"
            title="neurons"
            lines={['browser · WebGPU', 'command line · CPU', 'benchmark → zone', 'one job at a time', 'over the /ws socket']}
          />
          <Box
            x={250}
            y={330}
            w={360}
            h={130}
            i="E"
            title="coordinator"
            meta="server/neurons"
            lines={[
              'job = newest rows × corpus block × 256 dims',
              'verify 4 random rows on CPU · |Δsim| < 2e-3',
              'pass → credits = flops/1e8 · (1 + 0.15·zone)',
              '3 consecutive failures → kicked',
              'ledger.json every 30 s',
            ]}
          />
          <g className="ad-box ad-fallback">
            <rect x={670} y={480} width={160} height={90} className="ad-rect" />
            <rect x={670} y={480} width={160} height={90} fill="url(#docs-hatch)" className="ad-hatchfill" />
            <rect x={670} y={480} width={160} height={22} className="ad-headbg" />
            <line x1={670} y1={502} x2={830} y2={502} className="ad-sep" />
            <text x={680} y={495} className="ad-i">
              P
            </text>
            <text x={694} y={495} className="ad-t">
              PAYOUTS
            </text>
            <text x={820} y={495} className="ad-m" textAnchor="end">
              server/payouts
            </text>
            <text x={680} y={520} className="ad-s">
              period end · split by credits
            </text>
            <text x={680} y={535} className="ad-s">
              SOL → verified wallets
            </text>
            <text x={680} y={550} className="ad-s">
              LUSCA_PAYOUTS off|dryrun|live
            </text>
          </g>
          <Box x={880} y={480} w={140} h={90} i="K" title="clients" lines={['observatory · node', 'agents · sepia', 'docs (this page)']} />

          {/* ── connections ── */}
          {/* W ⇄ agents */}
          <path d="M190,109 L266,109" className="ad-l" markerStart="url(#docs-arr)" markerEnd="url(#docs-arr)" />
          <Label x={228} y={102}>
            GET
          </Label>
          <Label x={228} y={123}>
            1/host
          </Label>
          {/* agents ⇄ frontier */}
          <path d="M406,98 L454,98" className="ad-l" markerEnd="url(#docs-arr)" />
          <Label x={430} y={92}>
            links
          </Label>
          <path d="M454,122 L406,122" className="ad-l" markerEnd="url(#docs-arr)" />
          <Label x={430} y={136}>
            pick
          </Label>
          {/* A → D, A → T */}
          <path d="M610,75 L670,75" className="ad-l" markerEnd="url(#docs-arr)" />
          <Label x={640} y={69}>
            append
          </Label>
          <path d="M610,210 L670,210" className="ad-l" markerEnd="url(#docs-arr)" />
          <Label x={640} y={204}>
            onText()
          </Label>
          {/* D ⇢ T */}
          <path d="M755,110 L755,150" className="ad-l dash" markerEnd="url(#docs-arr)" />
          <Label x={762} y={134} anchor="start">
            re-fed on boot
          </Label>
          {/* A ⇄ E */}
          <path d="M380,270 L380,330" className="ad-l" markerEnd="url(#docs-arr)" />
          <Label x={388} y={304} anchor="start">
            vectors
          </Label>
          <path d="M500,330 L500,270" className="ad-l hot" markerEnd="url(#docs-arr-hot)" />
          <Label x={508} y={304} anchor="start">
            markSemanticDup
          </Label>
          {/* E ⇄ N */}
          <path d="M250,380 L190,380" className="ad-l" markerEnd="url(#docs-arr)" />
          <Label x={220} y={373}>
            job
          </Label>
          <path d="M190,410 L250,410" className="ad-l" markerEnd="url(#docs-arr)" />
          <Label x={220} y={425}>
            result
          </Label>
          {/* emits → H */}
          <path d="M560,40 L560,20 L950,20 L950,40" className="ad-l" markerEnd="url(#docs-arr)" />
          <Label x={755} y={14}>
            emit · agent · trace · page · reject · discover · domain
          </Label>
          <path d="M840,210 L880,210" className="ad-l" markerEnd="url(#docs-arr)" />
          <Label x={860} y={204}>
            emit
          </Label>
          <path d="M610,420 L880,420" className="ad-l" markerEnd="url(#docs-arr)" />
          <Label x={745} y={413}>
            emit · neurons · ink · job (direct)
          </Label>
          {/* H → K, P ⇢ K */}
          <path d="M950,440 L950,480" className="ad-l" markerEnd="url(#docs-arr)" />
          <Label x={958} y={464} anchor="start">
            ws / http
          </Label>
          <path d="M830,525 L880,525" className="ad-l dash" markerEnd="url(#docs-arr)" />
          <Label x={855} y={518}>
            fallback
          </Label>
        </svg>
      </div>
      <figcaption className="adiag-cap mono">
        <span>
          <i className="ad-key solid" /> in-process call or socket frame
        </span>
        <span>
          <i className="ad-key dash" /> fallback / reload path
        </span>
        <span>
          <i className="ad-key hot" /> the gate: taste, and duplicate flags fed back
        </span>
      </figcaption>
    </figure>
  )
}
