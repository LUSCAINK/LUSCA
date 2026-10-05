// Browser GPU trainer for SEPIA-0: computes the full mean-loss gradient of one
// batch on WebGPU (forward + backward, kernels in ./kernels.ts). The server
// chooses the batch and the base weights, audits the result against
// shared/sepia lossAndGrad, and applies it with its Adam optimizer.
//
// One trainer owns its pipelines and buffers; buffers are sized for the batch
// size of the most recent call and reused while B stays the same. Calls are
// serialised. Per call: params (f32) and the batch are uploaded, ~16
// dispatches run in a single compute pass, and the gradient plus the per-row
// losses come back through one MAP_READ buffer.

import { lossAndGrad, SEPIA } from '@shared/sepia/index.mjs'
import {
  COLSUM_WGSL,
  EMBGRAD_WGSL,
  GATHER_WGSL,
  KCHUNK,
  MM_UNIFORM_WORDS,
  REDUCE_WGSL,
  SMALL_UNIFORM_WORDS,
  SOFTMAX_WGSL,
  TILE,
  matmulWGSL,
  type Epilogue,
} from './kernels'

export interface GpuGradResult {
  /** d(mean loss)/d(params), same layout as SEPIA.layout. */
  grad: Float32Array
  /** Mean cross-entropy over the batch (nats per character). */
  loss: number
  /** Wall time: upload + compute + readback. */
  ms: number
}

export interface GpuTrainer {
  grad(params: Float32Array, x: Uint8Array, y: Uint8Array, B: number): Promise<GpuGradResult>
  destroy(): void
}

export interface GpuTrainSelfTest {
  ok: boolean
  /** cosine(GPU gradient, CPU reference gradient) */
  cosine: number
  /** ‖g_gpu − g_cpu‖ / ‖g_cpu‖ */
  relErr: number
  /** |loss_gpu − loss_cpu| */
  lossDiff: number
  /** Extra measurements (not part of the contract). */
  B?: number
  gpuMs?: number
  cpuMs?: number
  maxAbsErr?: number
}

// Model dimensions and flat parameter offsets (checked against SEPIA.layout).
const T = 16
const E = 24
const H = 384
const V = 96
const TE = T * E
const OFF = { emb: 0, W1: V * E, b1: V * E + TE * H, W2: V * E + TE * H + H, b2: V * E + TE * H + H + H * V }
const NPARAM = OFF.b2 + V

function checkLayout() {
  if (SEPIA.ctx !== T || SEPIA.emb !== E || SEPIA.hidden !== H || SEPIA.vocab !== V || SEPIA.params !== NPARAM) {
    throw new Error(`SEPIA shape mismatch: ${JSON.stringify({ ctx: SEPIA.ctx, emb: SEPIA.emb, hidden: SEPIA.hidden, vocab: SEPIA.vocab, params: SEPIA.params })}`)
  }
  const want: Record<string, [number, number]> = {
    emb: [OFF.emb, V * E],
    W1: [OFF.W1, TE * H],
    b1: [OFF.b1, H],
    W2: [OFF.W2, H * V],
    b2: [OFF.b2, V],
  }
  for (const t of SEPIA.layout) {
    const w = want[t.name]
    if (!w || w[0] !== t.offset || w[1] !== t.length) throw new Error(`SEPIA layout mismatch at ${t.name}: ${t.offset}+${t.length}`)
  }
}

/** Largest dispatch dimension we use before folding into a second axis. */
const MAX_WG_X = 32768

interface Kernel {
  pipeline: GPUComputePipeline
}

interface Plan {
  B: number
  nz: number
  bufX: GPUBuffer
  bufY: GPUBuffer
  bufXE: GPUBuffer
  bufH: GPUBuffer
  bufLG: GPUBuffer
  bufDH: GPUBuffer
  bufDXE: GPUBuffer
  bufLoss: GPUBuffer
  bufPart: GPUBuffer
  bufRead: GPUBuffer
  uniforms: GPUBuffer[]
  steps: { pipeline: GPUComputePipeline; bind: GPUBindGroup; wg: [number, number, number] }[]
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function createGpuTrainer(device: GPUDevice): Promise<GpuTrainer> {
  checkLayout()
  device.pushErrorScope('validation')
  const mk = (label: string, code: string): Promise<Kernel> =>
    device
      .createComputePipelineAsync({ label, layout: 'auto', compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' } })
      .then((pipeline) => ({ pipeline }))
  const mm = (label: string, tA: boolean, tB: boolean, ep: Epilogue) => mk(`sepia-${label}`, matmulWGSL(tA, tB, ep))
  const [kF1, kF2, kDW, kDH, kDX, kGather, kSoftmax, kColsum, kEmbGrad, kReduce] = await Promise.all([
    mm('fwd1', false, false, 'biasTanh'),
    mm('fwd2', false, false, 'bias'),
    mm('dW', true, false, 'store'),
    mm('dh', false, true, 'dtanh'),
    mm('dx', false, true, 'store'),
    mk('sepia-gather', GATHER_WGSL),
    mk('sepia-softmax', SOFTMAX_WGSL),
    mk('sepia-colsum', COLSUM_WGSL),
    mk('sepia-embgrad', EMBGRAD_WGSL),
    mk('sepia-reduce', REDUCE_WGSL),
  ])
  const pipeErr = await device.popErrorScope()
  if (pipeErr) throw new Error(`SEPIA kernels failed to compile: ${pipeErr.message}`)

  const bufP = device.createBuffer({ label: 'sepia-params', size: NPARAM * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  const bufG = device.createBuffer({ label: 'sepia-grad', size: NPARAM * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
  let plan: Plan | null = null
  let chain: Promise<unknown> = Promise.resolve()
  let destroyed = false

  const storage = (label: string, floats: number, extra = 0) =>
    device.createBuffer({ label, size: Math.max(16, floats * 4), usage: GPUBufferUsage.STORAGE | extra })

  function destroyPlan(p: Plan) {
    for (const b of [p.bufX, p.bufY, p.bufXE, p.bufH, p.bufLG, p.bufDH, p.bufDXE, p.bufLoss, p.bufPart, p.bufRead, ...p.uniforms]) b.destroy()
  }

  function buildPlan(B: number): Plan {
    const nz = Math.ceil(B / KCHUNK)
    const sizeW1 = TE * H
    const sizeW2 = H * V
    const sizeEmb = V * E
    const partW1 = 0
    const partW2 = nz * sizeW1
    const partEmb = partW2 + nz * sizeW2
    const partTotal = partEmb + nz * sizeEmb
    const p: Plan = {
      B,
      nz,
      bufX: storage('sepia-x', B * T, GPUBufferUsage.COPY_DST),
      bufY: storage('sepia-y', B, GPUBufferUsage.COPY_DST),
      bufXE: storage('sepia-xe', B * TE),
      bufH: storage('sepia-h', B * H),
      bufLG: storage('sepia-logits', B * V),
      bufDH: storage('sepia-dh', B * H),
      bufDXE: storage('sepia-dxe', B * TE),
      bufLoss: storage('sepia-loss', B, GPUBufferUsage.COPY_SRC),
      bufPart: storage('sepia-partials', partTotal),
      bufRead: device.createBuffer({ label: 'sepia-read', size: (NPARAM + B) * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      uniforms: [],
      steps: [],
    }
    const uniform = (words: number[]) => {
      const u = device.createBuffer({ size: words.length * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(u, 0, new Uint32Array(words))
      p.uniforms.push(u)
      return u
    }
    const step = (k: Kernel, words: number[], bufs: GPUBuffer[], wg: [number, number, number]) => {
      const u = uniform(words)
      const bind = device.createBindGroup({
        layout: k.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: u } }, ...bufs.map((buffer, i) => ({ binding: i + 1, resource: { buffer } }))],
      })
      p.steps.push({ pipeline: k.pipeline, bind, wg })
    }
    const small = (...w: number[]) => {
      const out = new Array<number>(SMALL_UNIFORM_WORDS).fill(0)
      w.forEach((v, i) => (out[i] = v))
      return out
    }
    const grid1 = (n: number, wgSize: number): [number, number, number] => {
      const groups = Math.ceil(n / wgSize)
      return groups <= MAX_WG_X ? [groups, 1, 1] : [MAX_WG_X, Math.ceil(groups / MAX_WG_X), 1]
    }
    // M, N, K, lda, ldb, ldc, aOff, bOff, cOff, auxOff, kChunk, cStrideZ
    const mmStep = (
      k: Kernel,
      d: { M: number; N: number; K: number; lda: number; ldb: number; ldc: number; aOff?: number; bOff?: number; cOff?: number; auxOff?: number; split?: boolean },
      bufs: GPUBuffer[],
    ) => {
      const kChunk = d.split ? KCHUNK : d.K
      const zs = d.split ? Math.ceil(d.K / KCHUNK) : 1
      const w = new Array<number>(MM_UNIFORM_WORDS).fill(0)
      ;[d.M, d.N, d.K, d.lda, d.ldb, d.ldc, d.aOff ?? 0, d.bOff ?? 0, d.cOff ?? 0, d.auxOff ?? 0, kChunk, d.M * d.N].forEach((v, i) => (w[i] = v))
      step(k, w, bufs, [Math.ceil(d.N / TILE), Math.ceil(d.M / TILE), zs])
    }

    // ── forward ──
    step(kGather, small(B, T, E, OFF.emb), [bufP, p.bufX, p.bufXE], grid1(B * TE, 256))
    mmStep(kF1, { M: B, N: H, K: TE, lda: TE, ldb: H, ldc: H, bOff: OFF.W1, auxOff: OFF.b1 }, [p.bufXE, bufP, p.bufH, bufP])
    mmStep(kF2, { M: B, N: V, K: H, lda: H, ldb: V, ldc: V, bOff: OFF.W2, auxOff: OFF.b2 }, [p.bufH, bufP, p.bufLG, bufP])
    step(kSoftmax, small(B, V), [p.bufY, p.bufLG, p.bufLoss], [Math.ceil(B / 64), 1, 1])
    // ── output layer ──
    step(kColsum, small(B, V, OFF.b2), [p.bufLG, bufG], [Math.ceil(V / 64), 1, 1])
    mmStep(kDW, { M: H, N: V, K: B, lda: H, ldb: V, ldc: V, cOff: partW2, split: true }, [p.bufH, p.bufLG, p.bufPart])
    step(kReduce, small(sizeW2, nz, partW2, OFF.W2), [p.bufPart, bufG], grid1(sizeW2, 256))
    mmStep(kDH, { M: B, N: H, K: V, lda: V, ldb: V, ldc: H, bOff: OFF.W2, auxOff: 0 }, [p.bufLG, bufP, p.bufDH, p.bufH])
    // ── hidden layer ──
    step(kColsum, small(B, H, OFF.b1), [p.bufDH, bufG], [Math.ceil(H / 64), 1, 1])
    mmStep(kDW, { M: TE, N: H, K: B, lda: TE, ldb: H, ldc: H, cOff: partW1, split: true }, [p.bufXE, p.bufDH, p.bufPart])
    step(kReduce, small(sizeW1, nz, partW1, OFF.W1), [p.bufPart, bufG], grid1(sizeW1, 256))
    mmStep(kDX, { M: B, N: TE, K: H, lda: H, ldb: H, ldc: TE, bOff: OFF.W1 }, [p.bufDH, bufP, p.bufDXE])
    // ── embeddings ──
    step(kEmbGrad, small(B, T, E, V, KCHUNK, partEmb), [p.bufX, p.bufDXE, p.bufPart], [Math.ceil(sizeEmb / 64), nz, 1])
    step(kReduce, small(sizeEmb, nz, partEmb, OFF.emb), [p.bufPart, bufG], grid1(sizeEmb, 256))
    return p
  }

  async function run(params: Float32Array, x: Uint8Array, y: Uint8Array, B: number): Promise<GpuGradResult> {
    if (destroyed) throw new Error('GPU trainer destroyed')
    if (!Number.isInteger(B) || B <= 0) throw new Error(`invalid batch size ${B}`)
    if (params.length !== NPARAM) throw new Error(`params has ${params.length} floats, want ${NPARAM}`)
    if (x.length < B * T || y.length < B) throw new Error(`batch too short: x ${x.length}/${B * T}, y ${y.length}/${B}`)
    const t0 = performance.now()
    if (!plan || plan.B !== B) {
      if (plan) destroyPlan(plan)
      plan = null
      device.pushErrorScope('validation')
      const p = buildPlan(B)
      const err = await device.popErrorScope()
      if (err) {
        destroyPlan(p)
        throw new Error(`SEPIA plan for B=${B} invalid: ${err.message}`)
      }
      plan = p
    }
    const p = plan
    const xi = new Uint32Array(B * T)
    for (let i = 0; i < B * T; i++) {
      const c = x[i]
      if (c >= V) throw new Error(`token id ${c} out of range at ${i}`)
      xi[i] = c
    }
    const yi = new Uint32Array(B)
    for (let i = 0; i < B; i++) {
      const c = y[i]
      if (c >= V) throw new Error(`target id ${c} out of range at ${i}`)
      yi[i] = c
    }
    device.queue.writeBuffer(bufP, 0, params.buffer, params.byteOffset, params.byteLength)
    device.queue.writeBuffer(p.bufX, 0, xi)
    device.queue.writeBuffer(p.bufY, 0, yi)

    device.pushErrorScope('validation')
    const enc = device.createCommandEncoder({ label: 'sepia-grad' })
    const pass = enc.beginComputePass({ label: 'sepia-grad' })
    for (const s of p.steps) {
      pass.setPipeline(s.pipeline)
      pass.setBindGroup(0, s.bind)
      pass.dispatchWorkgroups(s.wg[0], s.wg[1], s.wg[2])
    }
    pass.end()
    enc.copyBufferToBuffer(bufG, 0, p.bufRead, 0, NPARAM * 4)
    enc.copyBufferToBuffer(p.bufLoss, 0, p.bufRead, NPARAM * 4, B * 4)
    device.queue.submit([enc.finish()])
    const err = await device.popErrorScope()
    if (err) throw new Error(`SEPIA gradient pass failed: ${err.message}`)
    await p.bufRead.mapAsync(GPUMapMode.READ)
    let grad: Float32Array
    let loss = 0
    try {
      const all = new Float32Array(p.bufRead.getMappedRange())
      grad = all.slice(0, NPARAM)
      for (let b = 0; b < B; b++) loss += all[NPARAM + b]
    } finally {
      p.bufRead.unmap()
    }
    loss /= B
    return { grad, loss, ms: performance.now() - t0 }
  }

  return {
    grad(params, x, y, B) {
      const r = chain.then(() => run(params, x, y, B))
      chain = r.catch(() => undefined)
      return r
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      if (plan) destroyPlan(plan)
      plan = null
      bufP.destroy()
      bufG.destroy()
    },
  }
}

// ─── Self test ──────────────────────────────────────────────────────────────

/** mulberry32 — seedable PRNG returning floats in [0, 1). */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gauss(rand: () => number) {
  let u = 0
  while (u <= 1e-12) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

/**
 * Fixed, seeded test case: weights at a non-trivial scale (so the softmax is
 * far from uniform and every tensor carries gradient) and a batch of B random
 * contexts/targets.
 */
export function selfTestCase(B = 256, seed = 0x5e91a) {
  const rand = prng(seed)
  const params = new Float32Array(NPARAM)
  for (let i = 0; i < V * E; i++) params[OFF.emb + i] = gauss(rand)
  const s1 = 1 / Math.sqrt(TE)
  for (let i = 0; i < TE * H; i++) params[OFF.W1 + i] = gauss(rand) * s1
  for (let i = 0; i < H; i++) params[OFF.b1 + i] = gauss(rand) * 0.1
  const s2 = 1 / Math.sqrt(H)
  for (let i = 0; i < H * V; i++) params[OFF.W2 + i] = gauss(rand) * s2
  for (let i = 0; i < V; i++) params[OFF.b2 + i] = gauss(rand) * 0.1
  const x = new Uint8Array(B * T)
  const y = new Uint8Array(B)
  for (let i = 0; i < x.length; i++) x[i] = Math.floor(rand() * V)
  for (let i = 0; i < B; i++) y[i] = Math.floor(rand() * V)
  return { params, x, y, B }
}

/** Compare two gradients: cosine, relative L2 error, max abs error (f64 sums). */
export function compareGrads(gpu: Float32Array, ref: Float32Array) {
  let dot = 0
  let na = 0
  let nb = 0
  let nd = 0
  let maxAbs = 0
  for (let i = 0; i < ref.length; i++) {
    const a = gpu[i]
    const b = ref[i]
    dot += a * b
    na += a * a
    nb += b * b
    const d = a - b
    nd += d * d
    const ad = Math.abs(d)
    if (!(ad <= maxAbs)) maxAbs = ad
  }
  const cosine = na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0
  const relErr = nb > 0 ? Math.sqrt(nd) / Math.sqrt(nb) : Infinity
  return { cosine, relErr, maxAbsErr: maxAbs }
}

/** Tolerances for selfTest().ok (f32 GPU vs f32/f64 CPU reference). */
export const SELFTEST_TOL = { cosine: 0.99999, relErr: 1e-3, lossDiff: 1e-4 }

/**
 * Run the GPU trainer and shared/sepia lossAndGrad on the same fixed batches and report
 * how closely they agree (the worst case). Without an explicit B it checks B = 256
 * (single split-K chunk), 512 (two-partial reduction, the MESO tier path) and 300
 * (a ragged last chunk / non-multiple of 64), so every reduction path a tier uses is covered.
 */
export async function selfTest(device: GPUDevice, B?: number): Promise<GpuTrainSelfTest> {
  if (B !== undefined) return selfTestAt(device, B, null)
  let shared: GpuTrainer | null = null
  try {
    shared = await createGpuTrainer(device)
  } catch (e) {
    console.warn('[lusca] SEPIA GPU self-test failed:', errText(e))
    return { ok: false, cosine: 0, relErr: Infinity, lossDiff: Infinity, B: 256 }
  }
  try {
    let worst: GpuTrainSelfTest | null = null
    for (const b of [256, 512, 300]) {
      const r = await selfTestAt(device, b, shared)
      if (!r.ok) return r
      if (!worst || r.cosine < worst.cosine || r.relErr > worst.relErr) worst = r
    }
    return worst as GpuTrainSelfTest
  } finally {
    shared.destroy()
  }
}

async function selfTestAt(device: GPUDevice, B: number, shared: GpuTrainer | null): Promise<GpuTrainSelfTest> {
  let trainer: GpuTrainer | null = null
  try {
    const { params, x, y } = selfTestCase(B)
    trainer = shared ?? (await createGpuTrainer(device))
    const g = await trainer.grad(params, x, y, B)
    const ref = new Float32Array(NPARAM)
    const c0 = performance.now()
    const refLoss = lossAndGrad(params, x, y, B, ref)
    const cpuMs = performance.now() - c0
    const cmp = compareGrads(g.grad, ref)
    const lossDiff = Math.abs(g.loss - refLoss)
    const ok =
      Number.isFinite(g.loss) &&
      cmp.cosine >= SELFTEST_TOL.cosine &&
      cmp.relErr <= SELFTEST_TOL.relErr &&
      lossDiff <= SELFTEST_TOL.lossDiff
    return { ok, cosine: cmp.cosine, relErr: cmp.relErr, lossDiff, B, gpuMs: g.ms, cpuMs, maxAbsErr: cmp.maxAbsErr }
  } catch (e) {
    console.warn('[lusca] SEPIA GPU self-test failed:', errText(e))
    return { ok: false, cosine: 0, relErr: Infinity, lossDiff: Infinity, B }
  } finally {
    if (!shared) trainer?.destroy()
  }
}
