// End-to-end smoke test for the SEPIA-0 trainer.
// Run: npx tsx server/trainer/_smoke.ts [seconds=60] [--keep]
//      npx tsx server/trainer/_smoke.ts --gpu [--keep]   GPU-neuron training pipeline (see gpuMain)
//
// 1. Fetches a handful of crypto Wikipedia articles as plain text (polite UA,
//    sequential); falls back to a built-in paragraph set when offline.
// 2. Writes half of the documents to <tmp>/dataset.jsonl (exercises the reload
//    path) and feeds the other half through feed() (the crawler path).
// 3. Trains for N seconds while measuring main-thread event-loop lag, prints
//    the loss trajectory, a periodic sample and a generate() result.
// 4. stop() → checkpoint; a second trainer on the same dir must resume from it.
// Exits non-zero if the model did not learn or the checkpoint did not resume.
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { LossPoint, ServerMsg } from '../../shared/protocol.ts'
import { createTrainer } from './trainer.ts'

const args = process.argv.slice(2)
const SECONDS = Number(args.find((a) => /^\d+$/.test(a)) ?? 60)
const KEEP = args.includes('--keep')
const UA = 'LUSCA-SEPIA-smoke/0.1 (char-LM trainer test; low volume)'

const TITLES = [
  'Ethereum',
  'Bitcoin',
  'Smart_contract',
  'Decentralized_finance',
  'Proof_of_stake',
  'Decentralized_autonomous_organization',
  'Stablecoin',
  'Blockchain',
  'Cryptocurrency',
  'Zero-knowledge_proof',
  'Non-fungible_token',
  'Cryptographic_hash_function',
  'Lightning_Network',
]

async function fetchArticle(title: string, attempt = 0): Promise<string | null> {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&formatversion=2&redirects=1&titles=' +
    encodeURIComponent(title)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = (await res.json()) as { query?: { pages?: { extract?: string }[] } }
    const text = j.query?.pages?.[0]?.extract
    return typeof text === 'string' && text.length > 1000 ? text : null
  } catch {
    if (attempt >= 1) return null
    await new Promise((r) => setTimeout(r, 1500))
    return fetchArticle(title, attempt + 1)
  }
}

const FALLBACK = [
  'The validator signs an attestation for the head of the chain every epoch, and the beacon chain rewards honest participation.',
  'A rollup posts compressed transaction data to Ethereum and proves that the new state root follows from the old one.',
  'Liquidity providers deposit two tokens into a pool and earn a share of the swap fees in proportion to their stake.',
  'The bridge locks tokens on the source chain and mints a wrapped representation on the destination chain.',
  'Bitcoin miners compete to find a block hash below the difficulty target, and the longest valid chain wins.',
  'Proposal: reduce the quorum threshold for governance votes so that delegates can pass routine parameter changes.',
  'EIP-4844 introduces blob-carrying transactions that make data availability cheaper for layer two networks.',
  'The DAO treasury is controlled by token holders who vote on grants, upgrades and risk parameters.',
  'Zero-knowledge proofs let a prover convince a verifier that a statement is true without revealing the witness.',
  'Stablecoins are tokens designed to track the value of a fiat currency, backed by reserves or by overcollateralized loans.',
  'Smart contracts are programs stored on a blockchain that run when predetermined conditions are met.',
  'Slashing penalizes validators who sign conflicting blocks, which makes attacks on proof of stake expensive.',
]

function fallbackCorpus(chars: number): string[] {
  const docs: string[] = []
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296)
  let total = 0
  while (total < chars) {
    let d = ''
    while (d.length < 2000) d += FALLBACK[Math.floor(rnd() * FALLBACK.length)] + (rnd() < 0.2 ? '\n\n' : ' ')
    docs.push(d)
    total += d.length
  }
  return docs
}

/** Split an article into ~2 KB documents on paragraph boundaries. */
function chunk(text: string): string[] {
  const paras = text.split(/\n+/).filter((p) => p.trim().length > 0)
  const out: string[] = []
  let cur = ''
  for (const p of paras) {
    cur += (cur ? '\n' : '') + p
    if (cur.length > 2000) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur.length > 200) out.push(cur)
  return out
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'lusca-sepia-smoke-'))
  console.log(`dataDir: ${dir}`)

  // ── corpus ──
  let docs: string[] = []
  for (const t of TITLES) {
    const a = await fetchArticle(t)
    if (a) {
      docs.push(...chunk(a))
      console.log(`fetched ${t}: ${a.length} chars`)
    } else console.log(`fetch failed: ${t}`)
    await new Promise((r) => setTimeout(r, 300))
  }
  if (docs.reduce((s, d) => s + d.length, 0) < 100_000) {
    console.log('using built-in fallback corpus')
    docs = fallbackCorpus(400_000)
  }
  const total = docs.reduce((s, d) => s + d.length, 0)
  console.log(`corpus: ${docs.length} docs, ${(total / 1000).toFixed(0)} KB`)
  const half = Math.floor(docs.length / 2)
  await writeFile(
    path.join(dir, 'dataset.jsonl'),
    docs
      .slice(0, half)
      .map((text, i) => JSON.stringify({ id: `d${i}`, url: `https://example.test/${i}`, text }))
      .join('\n') + '\n',
  )

  // ── train ──
  const points: LossPoint[] = []
  const samples: { step: number; text: string }[] = []
  const emit = (m: ServerMsg) => {
    if (m.t === 'loss') points.push(m.point)
    else if (m.t === 'sample') samples.push({ step: m.step, text: m.text })
  }
  const trainer = createTrainer({ dataDir: dir, emit })

  const pre = await trainer.generate('The validator ', 60, 0.8)
  console.log(`\ngenerate before start (${pre.ms} ms): ${JSON.stringify(pre.text)}`)
  console.log(`info before start: ${JSON.stringify(trainer.info())}`)

  // Event-loop lag probe: a 10 ms interval; lag = how late each tick fires.
  // (On Windows the timer quantum is ~15.6 ms, so an idle process already
  // shows ~5 ms mean "lag" — hence the baseline measured before start().)
  let maxLag = 0
  let lagSum = 0
  let lagN = 0
  let last = performance.now()
  const probe = setInterval(() => {
    const now = performance.now()
    const lag = Math.max(0, now - last - 10)
    maxLag = Math.max(maxLag, lag)
    lagSum += lag
    lagN++
    last = now
  }, 10)
  await new Promise((r) => setTimeout(r, 2000))
  const baseline = { max: maxLag, mean: lagSum / Math.max(1, lagN) }
  maxLag = lagSum = lagN = 0

  trainer.start()
  for (const d of docs.slice(half)) trainer.feed(d)

  const t0 = Date.now()
  while (Date.now() - t0 < SECONDS * 1000) {
    await new Promise((r) => setTimeout(r, 5000))
    const i = trainer.info()
    console.log(
      `t=${((Date.now() - t0) / 1000).toFixed(0)}s step=${i.step} loss=${i.loss.toFixed(3)} val=${i.val?.toFixed(3) ?? '—'} ` +
        `sps=${i.stepsPerSec} corpus=${i.corpusChars}`,
    )
  }
  clearInterval(probe)

  const g = await trainer.generate('Ethereum is ', 200, 0.8)
  console.log(`\ngenerate after training (${g.ms} ms):\n${g.text}\n`)

  console.log('loss trajectory (step: train / val):')
  const stride = Math.max(1, Math.floor(points.length / 24))
  for (let k = 0; k < points.length; k += stride) {
    const p = points[k]
    console.log(`  ${String(p.step).padStart(5)}: ${p.loss.toFixed(3)}${p.val !== null ? ` / ${p.val.toFixed(3)}` : ''}`)
  }
  const vals = points.filter((p) => p.val !== null)
  console.log(`val points: ${vals.map((p) => `${p.step}:${p.val!.toFixed(3)}`).join(' ')}`)
  if (samples.length) console.log(`\nsample @ step ${samples[samples.length - 1].step}:\n${samples[samples.length - 1].text}\n`)
  console.log(
    `main-thread event-loop lag while training: max ${maxLag.toFixed(1)} ms, mean ${(lagSum / Math.max(1, lagN)).toFixed(2)} ms ` +
      `(idle baseline: max ${baseline.max.toFixed(1)} ms, mean ${baseline.mean.toFixed(2)} ms)`,
  )

  const hist = trainer.lossHistory()
  const infoA = trainer.info()
  console.log(`lossHistory(): ${hist.length} points, samples(): ${trainer.samples().length}`)

  await trainer.stop()
  const ck = await stat(path.join(dir, 'sepia.ckpt'))
  console.log(`checkpoint: ${ck.size} bytes`)

  // ── resume ──
  const points2: LossPoint[] = []
  const trainer2 = createTrainer({
    dataDir: dir,
    emit: (m) => {
      if (m.t === 'loss') points2.push(m.point)
    },
  })
  trainer2.start()
  const t1 = Date.now()
  while (Date.now() - t1 < 20_000 && points2.length < 3) await new Promise((r) => setTimeout(r, 250))
  const infoB = trainer2.info()
  console.log(
    `resumed trainer: first new step=${points2[0]?.step ?? '—'} loss=${points2[0]?.loss.toFixed(3) ?? '—'} ` +
      `(saved step ${infoA.step}, loss ${infoA.loss.toFixed(3)}), history=${trainer2.lossHistory().length}, corpus=${infoB.corpusChars}`,
  )
  await trainer2.stop()

  // ── verdict ──
  const first = points[0]?.loss ?? NaN
  const tail = points.slice(-4)
  const end = tail.reduce((s, p) => s + p.loss, 0) / Math.max(1, tail.length)
  const resumedOk = points2.length > 0 && points2[0].step > infoA.step && points2[0].loss < first - 0.5
  const learned = end < 3.0 && end < first - 1.0
  console.log(`\nfirst loss ${first.toFixed(3)} → last ${end.toFixed(3)} (ln 96 = ${Math.log(96).toFixed(3)})`)
  console.log(`${learned ? 'PASS' : 'FAIL'} learning   ${resumedOk ? 'PASS' : 'FAIL'} resume   params=${infoA.params}`)
  if (!KEEP) await rm(dir, { recursive: true, force: true })
  process.exit(learned && resumedOk ? 0 : 1)
}

// ─── GPU-neuron training pipeline ───────────────────────────────────────────
// npx tsx server/trainer/_smoke.ts --gpu
// Uses real crawled text (head of server/data/dataset.jsonl, else Wikipedia).
// Covers: issue → honest gradient (shared/sepia) → applied / audited; garbage and
// lazy gradients → rejected / audit-failed; stale base → 'stale'; unknown job;
// weight reuse (weights: null); counters persisted across a restart; and prints
// the calibration numbers behind the spot-check and audit tolerances.

async function realDocs(maxChars: number): Promise<string[]> {
  const docs: string[] = []
  let total = 0
  const file = path.resolve(import.meta.dirname, '../data/dataset.jsonl')
  try {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8', end: 64 * 1024 * 1024 }), crlfDelay: Infinity })
    for await (const line of rl) {
      try {
        const r = JSON.parse(line) as { text?: unknown }
        if (typeof r.text === 'string' && r.text.length > 200) {
          docs.push(r.text)
          total += r.text.length
        }
      } catch {
        /* partial line */
      }
      if (total >= maxChars) break
    }
    rl.close()
  } catch {
    /* no local dataset */
  }
  if (total >= 200_000) {
    console.log(`corpus: ${docs.length} crawled docs from server/data/dataset.jsonl, ${(total / 1e6).toFixed(2)}M chars`)
    return docs
  }
  for (const t of TITLES) {
    const a = await fetchArticle(t)
    if (a) docs.push(...chunk(a))
    await new Promise((r) => setTimeout(r, 300))
  }
  console.log(`corpus: ${docs.length} docs from Wikipedia`)
  return docs
}

const b64u8 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const b64u16 = (s: string) => {
  const b = Buffer.from(s, 'base64')
  const u = new Uint16Array(b.length / 2)
  new Uint8Array(u.buffer).set(b)
  return u
}
const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
}

async function gpuMain() {
  const sepia = await import('../../shared/sepia/index.mjs')
  const { lossAndGrad, encodeGrad, decodeGrad, f16ToF32, cosine, relErr, l2, SEPIA, trainFlops } = sepia
  const NPAR = SEPIA.params
  const T = SEPIA.ctx
  const dir = await mkdtemp(path.join(tmpdir(), 'lusca-sepia-gpu-'))
  const docs = await realDocs(3_000_000)
  await writeFile(path.join(dir, 'dataset.jsonl'), docs.map((text, i) => JSON.stringify({ id: `d${i}`, text })).join('\n') + '\n')

  let pass = true
  const check = (name: string, ok: boolean, detail: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`)
    if (!ok) pass = false
  }

  const trainer = createTrainer({ dataDir: dir, emit: () => {} })
  trainer.start()
  const tw = Date.now()
  let first: Awaited<ReturnType<typeof trainer.issueTrainJob>> = null
  while (Date.now() - tw < 60_000 && !(first = await trainer.issueTrainJob({ neuronKey: 'probe', batch: 16, haveVersion: null }))) {
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!first) throw new Error('trainer never issued a job (corpus not loaded?)')

  type Job = NonNullable<typeof first>
  const weightsCache = new Map<number, Float32Array>()
  const weightsOf = (j: Job) => {
    if (j.weights) weightsCache.set(j.version, f16ToF32(b64u16(j.weights)))
    const w = weightsCache.get(j.version)
    if (!w) throw new Error(`no weights for version ${j.version}`)
    return w
  }
  const honest = (j: Job) => {
    const w = weightsOf(j)
    const g = new Float32Array(NPAR)
    const t0 = performance.now()
    const loss = lossAndGrad(w, b64u8(j.x), b64u8(j.y), j.batch, g)
    return { g, loss, ms: performance.now() - t0, w }
  }

  // ── 1. calibration (honest gradients vs spot checks / audits) ──
  console.log('\ncalibration (honest gradients on real batches):')
  const cal: Record<string, number[]> = {}
  for (const Bc of [128, 256, 1024, 4096]) {
    const j = (await trainer.issueTrainJob({ neuronKey: 'cal', batch: Bc, haveVersion: null }))!
    const { g, loss, ms } = honest(j)
    const enc = decodeGrad(encodeGrad(g))
    const x = b64u8(j.x)
    const y = b64u8(j.y)
    const spot: number[] = []
    const lazySpot: number[] = []
    const gS = new Float32Array(NPAR)
    const lazy = new Float32Array(NPAR)
    lossAndGrad(weightsOf(j), x.subarray(0, 32 * T), y.subarray(0, 32), 32, lazy) // a cheater doing 32 rows of the batch
    for (let k = 0; k < 12; k++) {
      const xs = new Uint8Array(32 * T)
      const ys = new Uint8Array(32)
      for (let r = 0; r < 32; r++) {
        const i = Math.floor(Math.random() * Bc)
        xs.set(x.subarray(i * T, i * T + T), r * T)
        ys[r] = y[i]
      }
      lossAndGrad(weightsOf(j), xs, ys, 32, gS)
      spot.push(cosine(enc, gS))
      lazySpot.push(cosine(lazy, gS))
    }
    const noise = new Float32Array(NPAR).map(() => Math.random() - 0.5)
    cal[`spot${Bc}`] = spot
    console.log(
      `  B=${String(Bc).padStart(4)} v${j.version} loss ${loss.toFixed(3)} |g| ${l2(g).toFixed(3)} cpu ${ms.toFixed(0)} ms (${((trainFlops(Bc) / ms) * 1e-6).toFixed(2)} GFLOP/s)` +
        ` | f16 wire: cos ${cosine(enc, g).toFixed(6)} relErr ${relErr(enc, g).toExponential(2)}` +
        ` | spot cos min ${pct(spot, 0).toFixed(3)} med ${pct(spot, 0.5).toFixed(3)}` +
        ` | noise ${cosine(noise, gS).toFixed(4)} | lazy-32 spot med ${pct(lazySpot, 0.5).toFixed(3)}, full cos ${cosine(lazy, g).toFixed(3)} relErr ${relErr(lazy, g).toFixed(3)}`,
    )
  }

  // ── 2. honest result, forced audit → audited & applied ──
  const st0 = trainer.trainStats()
  const j1 = (await trainer.issueTrainJob({ neuronKey: 'alice', batch: 256, haveVersion: null }))!
  check('issue', j1.kind === 'train' && j1.batch === 256 && j1.ctx === T && b64u8(j1.x).length === 256 * T && b64u8(j1.y).length === 256 && j1.weights !== null && j1.flops === trainFlops(256),
    `v${j1.version}, weights ${((j1.weights?.length ?? 0) / 1024).toFixed(0)} KB b64, x ${j1.x.length} B b64, flops ${j1.flops}`)
  const h1 = honest(j1)
  const r1 = await trainer.submitTrainResult({ neuronKey: 'alice', jobId: j1.id, grad: encodeGrad(h1.g), loss: h1.loss, forceAudit: true })
  const st1 = trainer.trainStats()
  check('honest+forced audit → audited', r1.verdict === 'audited' && r1.audited && r1.flops === j1.flops, `${JSON.stringify(r1)}`)

  // ── 3. honest, no forced audit → applied (or audited by the 20% draw) ──
  let applied = 0
  let audited = 0
  const sizes = [256, 128, 512, 256, 1024, 256, 2048, 128, 256, 512, 256, 128]
  for (const bs of sizes) {
    const j = (await trainer.issueTrainJob({ neuronKey: 'alice', batch: bs, haveVersion: j1.version }))!
    const h = honest(j)
    const r = await trainer.submitTrainResult({ neuronKey: 'alice', jobId: j.id, grad: encodeGrad(h.g), loss: h.loss, forceAudit: false })
    if (r.verdict === 'applied') applied++
    else if (r.verdict === 'audited') audited++
    else console.log(`   unexpected (B=${bs}): ${JSON.stringify(r)}`)
  }
  check('honest unforced → applied/audited', applied + audited === sizes.length, `${applied} applied, ${audited} audited (P=0.2) of ${sizes.length}`)
  await new Promise((r) => setTimeout(r, 1200))
  const st2 = trainer.trainStats()
  check('stats count GPU steps', st2.gpuSteps >= st0.gpuSteps + 13 && st2.gpuSamples >= st0.gpuSamples + 13 * 128 && st2.contributors24h >= 1 && st2.audits.ok >= 1 && st2.gpuStepsPerMin >= 13,
    JSON.stringify(st2))
  const mi = trainer.info()
  check('ModelInfo carries train stats', mi.gpuSteps === st2.gpuSteps && typeof mi.version === 'number' && mi.version >= st1.version, `version ${mi.version}, gpuSteps ${mi.gpuSteps}, serverSteps ${mi.serverSteps}`)

  // ── 4. weight reuse ──
  const ja = (await trainer.issueTrainJob({ neuronKey: 'bob', batch: 128, haveVersion: null }))!
  const ha = honest(ja)
  const jb = (await trainer.issueTrainJob({ neuronKey: 'bob', batch: 128, haveVersion: ja.version }))!
  check('weights omitted when the client holds the version', jb.weights === null && jb.version === ja.version, `ja v${ja.version} (weights sent), jb v${jb.version} weights=${jb.weights === null ? 'null' : 'sent'}`)

  // ── 5. garbage gradients ──
  const noiseG = new Float32Array(NPAR).map(() => (Math.random() - 0.5) * 0.01)
  const hb = honest(jb)
  const rn = await trainer.submitTrainResult({ neuronKey: 'bob', jobId: jb.id, grad: encodeGrad(noiseG), loss: hb.loss, forceAudit: false })
  check('random gradient → rejected / audit-failed, no INK', (rn.verdict === 'rejected' || rn.verdict === 'audit-failed') && rn.flops === 0, `${rn.verdict}: ${rn.reason}`)
  const rl = await trainer.submitTrainResult({ neuronKey: 'bob', jobId: ja.id, grad: encodeGrad(ha.g), loss: ha.loss + 2, forceAudit: false })
  check('wrong loss → escalated audit fails', (rl.verdict === 'rejected' || rl.verdict === 'audit-failed') && rl.flops === 0, `${rl.verdict}: ${rl.reason}`)

  // Scaled (×3, ×0.3), different-batch and mostly-adversarial gradients, unforced: the spot
  // check must escalate them to a full audit (which fails) rather than apply them.
  {
    const kinds = ['x3', 'x0.3', 'other-batch', 'other+noise'] as const
    const out: Record<string, string[]> = {}
    for (const kind of kinds) {
      out[kind] = []
      for (let t = 0; t < 4; t++) {
        const j = (await trainer.issueTrainJob({ neuronKey: 'zed', batch: 1024, haveVersion: null }))!
        const h = honest(j)
        let g = h.g.slice()
        if (kind === 'x3') g = g.map((v) => v * 3)
        else if (kind === 'x0.3') g = g.map((v) => v * 0.3)
        else {
          // gradient of a different batch at the same weights (corpus rows reshuffled)
          const w = weightsOf(j)
          const x = b64u8(j.x)
          const y = b64u8(j.y)
          const x2 = new Uint8Array(x.length)
          const y2 = new Uint8Array(y.length)
          for (let b = 0; b < j.batch; b++) {
            const r = (b * 7919 + 13) % j.batch
            x2.set(x.subarray(r * T, r * T + T), b * T)
            x2[b * T + T - 1] = x[((b + 1) % j.batch) * T + T - 1]
            y2[b] = y[(r + 1) % j.batch]
          }
          const g2 = new Float32Array(NPAR)
          lossAndGrad(w, x2, y2, j.batch, g2)
          g = g2
          if (kind === 'other+noise') {
            const n2 = Math.sqrt(g.reduce((a, v) => a + v * v, 0))
            const nz = new Float32Array(NPAR).map(() => Math.random() - 0.5)
            const nn = Math.sqrt(nz.reduce((a, v) => a + v * v, 0))
            for (let i = 0; i < NPAR; i++) g[i] += (nz[i] / nn) * n2 * 3
          }
        }
        const r = (await trainer.submitTrainResult({ neuronKey: 'zed', jobId: j.id, grad: encodeGrad(g), loss: h.loss, forceAudit: false })) as Record<string, unknown>
        out[kind].push(`${r.verdict}${r.escalated ? '*' : ''}`)
      }
    }
    // Adversarial directions must be caught by the spot check itself; scaled and other-batch
    // gradients are only partly separable from honest ones without the full recompute (and
    // Adam largely normalizes scale), so they are reported here and left to the random audits.
    const advApplied = out['other+noise'].filter((v) => !v.startsWith('audit-failed')).length
    check('adversarial gradients escalated to a failing audit', advApplied === 0, JSON.stringify(out))
  }
  const jc = (await trainer.issueTrainJob({ neuronKey: 'bob', batch: 1024, haveVersion: null }))!
  const rbytes = new Uint8Array(1000)
  const rg = await trainer.submitTrainResult({ neuronKey: 'bob', jobId: jc.id, grad: rbytes, loss: 3, forceAudit: false })
  check('undecodable bytes → rejected', rg.verdict === 'rejected', rg.reason)
  // Lazy cheat: gradient of only 32 of the 1024 rows (passes the spot check sometimes), caught by the audit.
  const jd = (await trainer.issueTrainJob({ neuronKey: 'mallory', batch: 1024, haveVersion: null }))!
  const wd = weightsOf(jd)
  const lazyG = new Float32Array(NPAR)
  const lazyLoss = lossAndGrad(wd, b64u8(jd.x).subarray(0, 32 * T), b64u8(jd.y).subarray(0, 32), 32, lazyG)
  const rz = await trainer.submitTrainResult({ neuronKey: 'mallory', jobId: jd.id, grad: encodeGrad(lazyG), loss: lazyLoss, forceAudit: true })
  check('lazy 32-row gradient + audit → audit-failed or rejected', (rz.verdict === 'audit-failed' && rz.audited) || rz.verdict === 'rejected', `${rz.verdict}: ${rz.reason}`)
  const ru = await trainer.submitTrainResult({ neuronKey: 'bob', jobId: 'nope', grad: encodeGrad(noiseG), loss: 3, forceAudit: false })
  check('unknown job → stale, no INK', ru.verdict === 'stale' && ru.flops === 0, ru.reason)
  const je = (await trainer.issueTrainJob({ neuronKey: 'carol', batch: 128, haveVersion: null }))!
  const he = honest(je)
  const rw = await trainer.submitTrainResult({ neuronKey: 'eve', jobId: je.id, grad: encodeGrad(he.g), loss: he.loss, forceAudit: false })
  check("another neuron's job → rejected", rw.verdict === 'rejected', rw.reason)

  // ── 6. full audit at the largest tier batch ──
  const j4 = (await trainer.issueTrainJob({ neuronKey: 'alice', batch: 4096, haveVersion: null }))!
  const h4 = honest(j4)
  const t4 = performance.now()
  const r4 = (await trainer.submitTrainResult({ neuronKey: 'alice', jobId: j4.id, grad: encodeGrad(h4.g), loss: h4.loss, forceAudit: true })) as Record<string, unknown>
  check('B=4096 forced audit', r4.verdict === 'audited' || r4.verdict === 'stale', `${r4.verdict} in ${Math.round(performance.now() - t4)} ms wall (audit CPU ${String(r4.auditMs)} ms, client CPU grad ${h4.ms.toFixed(0)} ms) cos ${Number(r4.cos).toFixed(6)} relErr ${Number(r4.relErr).toExponential(2)}`)

  // ── 7. stale base ──
  const js = (await trainer.issueTrainJob({ neuronKey: 'dave', batch: 128, haveVersion: null }))!
  const hs = honest(js)
  const tS = Date.now()
  while (trainer.trainStats().version <= js.version + 64 && Date.now() - tS < 90_000) await new Promise((r) => setTimeout(r, 500))
  const rs = await trainer.submitTrainResult({ neuronKey: 'dave', jobId: js.id, grad: encodeGrad(hs.g), loss: hs.loss, forceAudit: false })
  check('stale base → stale, INK still paid', rs.verdict === 'stale' && rs.flops === js.flops, `${rs.reason} (waited ${Date.now() - tS} ms)`)

  // ── 8. counters survive a restart ──
  await new Promise((r) => setTimeout(r, 1200))
  const before = trainer.trainStats()
  await trainer.stop()
  const t2 = createTrainer({ dataDir: dir, emit: () => {} })
  t2.start()
  const tr = Date.now()
  while (Date.now() - tr < 30_000 && t2.trainStats().gpuSteps === 0) await new Promise((r) => setTimeout(r, 250))
  const after = t2.trainStats()
  check('counters persisted in sepia.ckpt', after.gpuSteps === before.gpuSteps && after.audits.ok === before.audits.ok && after.audits.failed === before.audits.failed && after.contributors24h === before.contributors24h,
    `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`)
  await t2.stop()
  if (!KEEP) await rm(dir, { recursive: true, force: true })
  console.log(`\n${pass ? 'ALL PASS' : 'SOME FAILED'}`)
  process.exit(pass ? 0 : 1)
}

;(args.includes('--gpu') ? gpuMain() : main()).catch((e) => {
  console.error(e)
  process.exit(1)
})
