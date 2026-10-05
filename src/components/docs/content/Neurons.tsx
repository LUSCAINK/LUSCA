import { Link } from 'react-router-dom'
import { ZONES } from '@shared/protocol'
import { fmtInt } from '@/lib/format'
import { MODEL, NEURON, TRAIN, trainFlops, trainInk, zoneJob } from '../facts'
import { C, Callout, Formula, H3, Src, Table } from '../ui'

const STEPS: [string, string, string][] = [
  [
    'detect',
    'src/lib/gpu/detect.ts',
    'navigator.gpu → adapter: vendor, architecture, limits, features. No WebGPU (older Safari, Firefox outside Windows, insecure origins) → a human-readable reason and the CPU fallback. Software adapters (SwiftShader, WARP) are flagged as slow.',
  ],
  [
    'validate',
    'src/lib/gpu/bench.ts',
    'The matmul kernel first runs a small odd-shaped problem (132 × 76 × 40) and is compared against a CPU result. A GPU that gets it wrong is not trusted and the neuron falls back to the CPU backend.',
  ],
  [
    'benchmark',
    'src/lib/gpu/bench.ts',
    'Register-blocked tiled FP32 GEMM in WGSL: 16 × 16 workgroups, each owning a 64 × 64 tile of C; every invocation accumulates a 4 × 4 micro-tile from 16-deep K slices staged in workgroup memory, vec4 loads. N = 1024 and 2048 (if buffer limits allow), batches sized to ~90 ms of GPU work and never more than 150 ms per submit (well under the 2 s Windows TDR). Seven timed batches; GPU timestamps when the timestamp-query feature exists, wall clock otherwise. Result: median GFLOPS at the best size, counting 2N³ FLOPs per product.',
  ],
  ['zone', 'shared/protocol.ts', 'zoneFor(gflops): the deepest zone whose minimum the score meets (table below).'],
  [
    'register',
    'neuron.register',
    'label, zone, gflops, kind, wallet and auth (optional; credits go to the wallet only with a valid session token), adapter info including an anonymous persistent device id. The coordinator clamps gflops to 1–200,000, recomputes the zone itself and ignores the client’s claim, then answers neuron.ok.',
  ],
  [
    'train',
    'src/lib/gpu/train · shared/sepia',
    'job.request with caps { train: true, version } → a TrainJob: the SEPIA-0 weights for one version (omitted when the neuron already holds it) and a batch of (context, next character) pairs the server picked. WebGPU kernels run the forward and backward pass and return the gradient of the mean cross-entropy as scaled f16 in train.result. Without WebGPU the same math runs on the CPU (shared/sepia lossAndGrad).',
  ],
  [
    'dedupe',
    'src/lib/gpu/simkernel.ts',
    'job.request → job. One 256-invocation workgroup per row: the row is staged in workgroup memory, invocations stride over the columns computing dot products with vec4 loads, then a shared-memory tree reduction yields the argmax (lowest index on ties, like the CPU reference). Rows whose top-2 gap is below 1e-6 are re-scored on the CPU so indices match exactly. → job.result.',
  ],
  [
    'verify',
    'server/neurons/coordinator.ts · server/trainer',
    'Training: cheap checks on every gradient, a full server recompute on a share of jobs, accepted gradients applied with Adam; credits are pending until an audit confirms them. Dedupe: shape check, then random rows recomputed on the CPU. Pass → credits. Fail → a strike.',
  ],
]

export function Neurons() {
  return (
    <>
      <p className="dlead">
        A neuron is a GPU — or a CPU, slowly — attached to the coordinator over the same WebSocket the Live page uses. It does two kinds of work.{' '}
        <b>Training jobs</b> compute gradients for SEPIA-0 on batches the server picks; the server audits a share of them by recomputing them and
        applies accepted gradients with its Adam optimizer. <b>Dedupe jobs</b> compute blocks of cosine similarity for near-duplicate detection and
        remain as a second job type.
      </p>

      <H3 id="neurons-pipeline" n="8.1">
        From tab to verified work
      </H3>
      <ol className="dsteps dsteps-k">
        {STEPS.map(([k, where, body]) => (
          <li key={k}>
            <div className="dstep-head">
              <b className="mono">{k}</b>
              <span className="mono dim small">{where}</span>
            </div>
            <p>{body}</p>
          </li>
        ))}
      </ol>
      <p>
        Without WebGPU the neuron benchmarks a JavaScript matmul (N = 192, six runs) and does the same jobs on the CPU, with a training batch of{' '}
        {TRAIN.cpuBatch}. It earns by the same formula; it simply lands in EPI and finishes fewer jobs. The desktop neuron (<C>node neuron.mjs</C>) uses
        the same CPU path.
      </p>

      <H3 id="neurons-zones" n="8.2">
        Zones and job sizes
      </H3>
      <Table label="Depth zones, job sizes and credits per full job">
        <thead>
          <tr>
            <th>zone</th>
            <th>name</th>
            <th>depth</th>
            <th className="r">min GFLOPS</th>
            <th>VRAM guidance</th>
            <th className="r">credit bonus</th>
            <th className="r">train batch</th>
            <th className="r">dedupe rows × cols</th>
            <th className="r">FLOPs / job</th>
            <th className="r">credits / job</th>
          </tr>
        </thead>
        <tbody>
          {ZONES.map((z) => {
            const j = zoneJob(z.zone)
            return (
              <tr key={z.zone}>
                <td className="mono strong">{z.zone}</td>
                <td>{z.name}</td>
                <td className="mono small">{z.depth}</td>
                <td className="r num">{fmtInt(z.minGflops)}</td>
                <td className="mono small">{z.vram}</td>
                <td className="r num">×{z.bonus.toFixed(2)}</td>
                <td className="r num">{fmtInt(TRAIN.batch[z.zone])}</td>
                <td className="r num">
                  {j.rows} × {fmtInt(j.cols)}
                </td>
                <td className="r num">{fmtInt(j.flops)}</td>
                <td className="r num strong">{j.ink.toFixed(2)}</td>
              </tr>
            )
          })}
        </tbody>
      </Table>
      <p>
        A training job’s batch doubles per zone, from {fmtInt(TRAIN.batch.EPI)} pairs in EPI to {fmtInt(TRAIN.batch.HADAL)} in HADAL ({TRAIN.cpuBatch}{' '}
        on the CPU path); its FLOPs are <C>trainFlops(B) = 6 · B · (ctx · emb · hidden + hidden · vocab)</C> = {fmtInt(trainFlops(1))} · B, forward plus
        backward. A BATHY training job is {fmtInt(trainFlops(TRAIN.batch.BATHY))} FLOPs → <b>{trainInk('BATHY').toFixed(2)} credits</b> once confirmed. The FLOPs and credits columns describe dedupe jobs. Every dedupe job is{' '}
        <C>{'rows × cols × 256'}</C>: rows double and columns double per zone, so FLOPs grow 4× per zone. Sizes shrink while the corpus is small (rows
        ≤ half the vectors in memory, columns ≤ all of them, minus the row pages). The largest dedupe job (HADAL) is 8.65 MB of float32 vectors, about
        11.5 MB as base64 on the wire. VRAM guidance is advice for the larger models on the roadmap; SEPIA-0 fits in any zone.
      </p>
      <Callout kind="note" title="what depth buys you">
        Two things scale with depth, both enforced by the coordinator: the job size (4× FLOPs per zone) and the credit bonus per verified GFLOP
        (<C>1 + 0.15 · zone</C>, the “credit bonus” column). Jobs start small and grow with every verified job. A benchmark deeper than MESO is paid
        the MESO bonus until your neuron proves GPU-class speed: at least two large jobs (≥ 0.25 GFLOP) answered at ≥ 3 GFLOPS end to end, which a
        browser GPU clears easily and the JavaScript CPU path does not. So claiming a GPU you do not have does not pay.
      </Callout>

      <H3 id="neurons-train" n="8.3">
        Training jobs
      </H3>
      <p>
        A training job asks a neuron for one gradient of SEPIA-0’s loss. The server samples <i>B</i> (context, next character) pairs from the training
        split, sends them with the weights version they must be computed against, and the neuron returns d(mean cross-entropy)/d(params) for all{' '}
        {fmtInt(MODEL.params)} parameters. Weights travel as f16 ({fmtInt(MODEL.params * 2)} bytes before base64) and only when the neuron does not
        already hold that version.
      </p>
      <Formula
        label="checks on every train.result — server/trainer"
        rows={[
          ['decode', 'decodeGrad(grad) → exactly params values', 'per-tensor scaled f16'],
          ['finite', 'every value finite', 'NaN or ±∞ → rejected'],
          ['norm', '‖g‖₂ within the range honest runs produce', 'catches zero, tiny and inflated gradients'],
          ['sub-batch', 'cosine(g, ∇ on a random sub-batch of the same x, y) ≥ threshold', 'rows chosen after the result arrives'],
          ['loss', 'reported loss close to the server’s loss on that sub-batch', 'plausibility, not proof'],
        ]}
      />
      <Formula
        label="full audit — server/trainer"
        rows={[
          ['when', `the first ${TRAIN.firstAudits} train jobs of an identity, then with probability LUSCA_TRAIN_AUDIT_P (default ${TRAIN.auditP})`, 'bounded by a CPU budget'],
          ['reference', 'lossAndGrad(weights of that version, x, y, B)', 'shared/sepia, same math as the neuron'],
          ['passes', `cosine ≥ ${TRAIN.auditCosine} ∧ small relative error`, 'tolerances calibrated from GPU-vs-CPU runs'],
        ]}
      />
      <p>
        The server keeps a ring of recent weight snapshots, so an audit recomputes against the exact weights the neuron was given. An accepted gradient
        goes through the server’s Adam optimizer (same clipping and learning-rate schedule as its own steps) and advances the weights version by one. A
        result whose base version is more than <C>LUSCA_TRAIN_MAX_STALE</C> (default {TRAIN.maxStale}) versions old is <i>stale</i>: it is still checked
        and paid if honest, but the gradient is not applied. The server’s own CPU training continues and yields to audits while GPU results are arriving.
      </p>
      <Table label="Training verdicts">
        <thead>
          <tr>
            <th>verdict</th>
            <th>gradient</th>
            <th>credits</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="mono strong">applied</td>
            <td>passed the cheap checks; applied with Adam</td>
            <td>credited as pending</td>
          </tr>
          <tr>
            <td className="mono strong">audited</td>
            <td>passed a full recompute; applied</td>
            <td>credited, and this identity’s pending credits become confirmed</td>
          </tr>
          <tr>
            <td className="mono strong">stale</td>
            <td>honest but too far behind; not applied</td>
            <td>credited as pending</td>
          </tr>
          <tr>
            <td className="mono strong">rejected</td>
            <td>failed a cheap check; discarded</td>
            <td>0, counts as a failure</td>
          </tr>
          <tr>
            <td className="mono strong">audit-failed</td>
            <td>failed the full recompute; discarded</td>
            <td>0; all of this identity’s pending credits are forfeited and a strike is recorded</td>
          </tr>
        </tbody>
      </Table>
      <Callout kind="note" title="pending credits">
        Training credits are held in escrow. They become confirmed when the identity’s next full audit passes and are forfeited if that audit fails. Only
        confirmed credits count toward a payout period and toward payable leaderboard totals; <C>ink</C> events carry <C>kind: 'train'</C> and{' '}
        <C>status: pending | confirmed | forfeited</C>.
      </Callout>

      <H3 id="neurons-verify" n="8.4">
        Dedupe spot-check verification
      </H3>
      <Formula
        label="result verification — server/neurons/coordinator.ts"
        rows={[
          ['checked rows', `${NEURON.spotRows} distinct rows, crypto.randomInt`, 'all rows if the job has ≤ 4'],
          ['reference', 'bestMatchesCPU(a, b, rows, cols, 256, checked)', 'shared/vectorize.ts'],
          ['row passes', `|sim − refSim| < ${NEURON.simTolerance} ∧ (best = refBest ∨ |dot(best) − refSim| < ${NEURON.simTolerance})`, 'ties accepted'],
          ['job passes', 'every checked row passes', 'after a structural shape check'],
        ]}
      />
      <p>
        The shape check rejects wrong lengths, out-of-range indices and non-finite or out-of-range cosines before any arithmetic. The rows to check are
        chosen after the result arrives, with a CSPRNG, so a neuron cannot know which rows matter. The browser kernel’s measured error is about 6e-8;
        the tolerance is roughly 30,000× that.
      </p>

      <H3 id="neurons-ink" n="8.5">
        Credits
      </H3>
      <Formula
        label="inkFor() — server/neurons/coordinator.ts"
        rows={[
          ['flops', 'dedupe: 2 · rows · cols · 256 · train: trainFlops(B)', 'one multiply-add = 2 FLOPs'],
          ['credits', 'max(0.01, round₂( flops / 10⁸ · (1 + 0.15 · zoneIndex) ))', 'EPI 0 · MESO 1 · BATHY 2 · ABYSSO 3 · HADAL 4'],
        ]}
      />
      <p>
        One credit per 100 MFLOP of verified work, plus 15% per tier below EPI, for both job types; training credits are pending until an audit confirms them
        (8.3). A failed job earns 0. A BATHY dedupe job at full size: 2 · 64 · 2048 · 256 ={' '}
        {fmtInt(zoneJob('BATHY').flops)} FLOPs → 0.671 · 1.30 = <b>{zoneJob('BATHY').ink.toFixed(2)} credits</b>. Balances are kept per verified wallet (valid session
        token, <Link to="/docs/economics">10.3</Link>), otherwise per anonymous device id, otherwise per label.
      </p>

      <H3 id="neurons-failure" n="8.6">
        Failure handling
      </H3>
      <Table label="Neuron failure handling">
        <thead>
          <tr>
            <th>event</th>
            <th>consequence</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>no result within {NEURON.jobTimeoutS} s</td>
            <td>job failed, 0 credits</td>
          </tr>
          <tr>
            <td>malformed result</td>
            <td>job failed, 0 credits</td>
          </tr>
          <tr>
            <td>spot-check mismatch</td>
            <td>
              job failed, 0 credits, <C>ink</C> event with the failing row and Δ
            </td>
          </tr>
          <tr>
            <td className="strong">{NEURON.maxConsecFails} consecutive failures</td>
            <td>neuron removed from the pool; that connection may not re-register for {NEURON.kickCooldownS} s</td>
          </tr>
          <tr>
            <td>a verified job</td>
            <td>strike count reset to 0</td>
          </tr>
          <tr>
            <td>stale result (unknown or expired job id)</td>
            <td>ignored with an error reply; not counted either way</td>
          </tr>
        </tbody>
      </Table>
      <p>
        One job is outstanding per neuron, at least {NEURON.minJobGapMs} ms apart. While the corpus has fewer than 2 vectors the coordinator answers{' '}
        <C>corpus warming up</C> and keeps the request queued. In the browser, three failed GPU self-checks switch the neuron to its CPU backend, the loop
        pauses while the tab is hidden, and without a server the neuron does no work and shows no credits.
      </p>

      <H3 id="neurons-use" n="8.7">
        What the results are for
      </H3>
      <p>
        Applied training gradients are SEPIA-0’s training steps: the weights version, GPU and server step counts and audit totals are on the{' '}
        <Link to="/sepia">Model</Link> page. Verified dedupe rows with cosine ≥ {NEURON.dupThreshold} become near-duplicate flags in the ingest pipeline (<Link to="/docs/dedupe">06.3</Link>).
        Before marking, the coordinator recomputes the cosine of each candidate pair on the CPU — one 256-dim dot product — so a neuron that passed the
        spot-check still cannot fabricate duplicates on rows that were not checked.
      </p>

      <H3 id="neurons-threats" n="8.8">
        Threat model
      </H3>
      <p>
        Spot-checks and audits catch lazy cheating. They do not stop a determined adversary. This is the honest list for the code as it stands.
      </p>
      <Table label="Threat model">
        <thead>
          <tr>
            <th>attack</th>
            <th>today</th>
            <th>why</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="strong">random or zero answers</td>
            <td>
              <span className="tag hot">caught</span>
            </td>
            <td>Any checked row fails. Three in a row and the neuron is dropped.</td>
          </tr>
          <tr>
            <td className="strong">random, zero or scaled gradients</td>
            <td>
              <span className="tag hot">caught</span>
            </td>
            <td>The norm check and the sub-batch cosine reject them before they reach Adam.</td>
          </tr>
          <tr>
            <td className="strong">gradient on part of the batch</td>
            <td>
              <span className="tag hot">mostly caught</span>
            </td>
            <td>
              The sub-batch is chosen after the result arrives, and every identity is fully audited on its first {TRAIN.firstAudits} jobs and then on about{' '}
              {Math.round(TRAIN.auditP * 100)}% of them. A failed audit forfeits all pending credits, so the expected value of cutting corners is negative.
            </td>
          </tr>
          <tr>
            <td className="strong">plausible but poisoned gradients</td>
            <td>
              <span className="tag">partly open</span>
            </td>
            <td>
              A gradient close enough to the honest one to pass the sub-batch cosine can still be applied between audits. Clipping and Adam bound the
              effect of one step; audits and escrow make sustained manipulation costly, not impossible.
            </td>
          </tr>
          <tr>
            <td className="strong">compute only some rows</td>
            <td>
              <span className="tag hot">mostly caught</span>
            </td>
            <td>
              With a fraction <i>f</i> of rows correct, a job passes with probability ≈ <i>f</i>⁴ (exactly C(fn,4)/C(n,4)): half the rows of an EPI
              job → 3.8%. The expected payout of partial work is far below honest work.
            </td>
          </tr>
          <tr>
            <td className="strong">fabricated duplicates</td>
            <td>
              <span className="tag hot">prevented</span>
            </td>
            <td>Every reported pair is re-scored on the CPU before it is marked.</td>
          </tr>
          <tr>
            <td className="strong">resubmitting old results</td>
            <td>
              <span className="tag hot">prevented</span>
            </td>
            <td>Job ids are unique per issue; results for unknown or expired jobs are ignored.</td>
          </tr>
          <tr>
            <td className="strong">inflated benchmark</td>
            <td>
              <span className="tag">open</span>
            </td>
            <td>
              GFLOPS are self-reported. Claiming HADAL buys bigger jobs and the ×1.60 multiplier. The only check is the {NEURON.jobTimeoutS} s deadline,
              and a CPU can finish a HADAL job (~1.07 GFLOP) inside it.
            </td>
          </tr>
          <tr>
            <td className="strong">sybils / many identities</td>
            <td>
              <span className="tag">open</span>
            </td>
            <td>
              A wallet must prove control with a signed message before it is credited, but device ids are unverified and one person can run many
              neurons or wallets. Payouts are split by confirmed credits, so extra identities earn nothing extra for the same work.
            </td>
          </tr>
          <tr>
            <td className="strong">evading the cooldown</td>
            <td>
              <span className="tag">open</span>
            </td>
            <td>The {NEURON.kickCooldownS} s cooldown is per WebSocket connection; a new connection gets a new id.</td>
          </tr>
          <tr>
            <td className="strong">a dishonest operator</td>
            <td>
              <span className="tag">open</span>
            </td>
            <td>One coordinator issues jobs, judges results and keeps the ledger. Neurons have to trust it.</td>
          </tr>
        </tbody>
      </Table>
      <Callout kind="roadmap" title="verification">
        <ul className="dlist tight">
          <li>
            <b>Redundancy:</b> issue a fraction of jobs to two or more neurons and compare.
          </li>
          <li>
            <b>Canaries:</b> plant rows with known answers that are indistinguishable from real ones.
          </li>
          <li>
            <b>Benchmark audit:</b> derive a neuron’s effective GFLOPS from timed real jobs and re-zone it.
          </li>
          <li>
            <b>Proofs for inference:</b> TOPLOC-style locality-sensitive commitments over activations, so served model outputs can be checked without
            re-running them in full.
          </li>
          <li>
            <b>Hardware attestation</b> where the platform offers it.
          </li>
        </ul>
      </Callout>
      <Src path="server/neurons/coordinator.ts · server/trainer · shared/sepia · src/lib/gpu/{detect,bench,simkernel,neuron}.ts · src/lib/gpu/train" />
    </>
  )
}
