/*
 * SEPIA training on the browser neuron.
 * ─────────────────────────────────────────────────────────────────────────
 * The coordinator sends a TrainJob: the model weights for version V (base64
 * f16, omitted when we already hold V), a batch of B context windows x
 * (B·ctx character ids) and their next characters y (B ids). We compute the
 * mean cross-entropy loss and its gradient with respect to every parameter,
 * pack it with encodeGrad() (per-tensor scaled f16) and send it back. The
 * server checks it, audits it against its own recomputation from the same
 * base weights, and applies it with its Adam optimizer.
 *
 * Backends
 *   webgpu  createGpuTrainer() (src/lib/gpu/train), accepted only after its
 *           selfTest() matches shared/sepia lossAndGrad on a fixed batch.
 *   cpu     shared/sepia lossAndGrad — the exact reference implementation the
 *           server audits against.
 */
import { SEPIA, decodeGrad, encodeGrad, f16ToF32, lossAndGrad } from '@shared/sepia/index.mjs'
import { createGpuTrainer, selfTest } from './train'

export type TrainBackend = 'webgpu' | 'cpu'

export interface TrainSelfTest {
  ok: boolean
  cosine: number
  relErr: number
  lossDiff: number
}

/** What the coordinator sends (shared/protocol.ts TrainJob). Declared here so this file only depends on the wire shape. */
export interface TrainJobWire {
  id: string
  kind: 'train'
  version: number
  weights: string | null
  batch: number
  ctx: number
  x: string
  y: string
  flops: number
  issuedAt: number
}

export interface TrainOut {
  /** base64 encodeGrad() bytes, ready for train.result. */
  grad: string
  loss: number
  ms: number
  backend: TrainBackend
}

type GpuTrainer = Awaited<ReturnType<typeof createGpuTrainer>>

// ─── base64 ⇄ bytes ───────────────────────────────────────────────────────

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)))
  }
  return btoa(bin)
}

// ─── weights cache (one version) ──────────────────────────────────────────

let held: { version: number; params: Float32Array } | null = null

/** Weights version this neuron currently holds (sent as job.request caps.version). */
export function heldVersion(): number | null {
  return held ? held.version : null
}

export function dropWeights() {
  held = null
}

function weightsFor(job: TrainJobWire): Float32Array {
  if (job.weights) {
    const bytes = b64ToBytes(job.weights)
    if (bytes.length !== SEPIA.params * 2) throw new Error(`weights are ${bytes.length} bytes, expected ${SEPIA.params * 2}`)
    // Copy into an aligned buffer: Uint16Array needs an even byteOffset.
    const u16 = new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    const params = f16ToF32(u16)
    for (let i = 0; i < params.length; i++) {
      if (!Number.isFinite(params[i])) throw new Error(`weights v${job.version} contain a non-finite value at ${i}`)
    }
    held = { version: job.version, params }
    return params
  }
  if (held && held.version === job.version) return held.params
  throw new Error(`job references weights v${job.version}, this neuron holds ${held ? `v${held.version}` : 'none'}`)
}

/** Validate shapes and decode x/y (throws on anything malformed). */
export function decodeTrainJob(job: TrainJobWire): { params: Float32Array; x: Uint8Array; y: Uint8Array; B: number } {
  const B = job.batch
  if (!Number.isInteger(B) || B <= 0 || B > 65536) throw new Error(`bad batch size ${String(B)}`)
  if (job.ctx !== SEPIA.ctx) throw new Error(`job ctx ${String(job.ctx)} ≠ SEPIA ctx ${SEPIA.ctx}`)
  if (!Number.isInteger(job.version) || job.version < 0) throw new Error(`bad weights version ${String(job.version)}`)
  const x = b64ToBytes(job.x)
  const y = b64ToBytes(job.y)
  if (x.length !== B * SEPIA.ctx) throw new Error(`x has ${x.length} ids, expected ${B * SEPIA.ctx}`)
  if (y.length !== B) throw new Error(`y has ${y.length} ids, expected ${B}`)
  for (let i = 0; i < x.length; i++) if (x[i] >= SEPIA.vocab) throw new Error(`x id ${x[i]} out of vocab`)
  for (let i = 0; i < y.length; i++) if (y[i] >= SEPIA.vocab) throw new Error(`y id ${y[i]} out of vocab`)
  const params = weightsFor(job)
  return { params, x, y, B }
}

// ─── GPU trainer lifecycle ────────────────────────────────────────────────

let gpu: { device: GPUDevice; trainer: GpuTrainer } | null = null
let gpuPromise: Promise<GpuTrainer> | null = null

/** Run selfTest() on `device`, then build the trainer. Throws with the reason when the GPU does not match the reference. */
export async function prepareGpuTrainer(device: GPUDevice): Promise<{ test: TrainSelfTest }> {
  const test = await selfTest(device)
  if (!test.ok) {
    throw Object.assign(
      new Error(`self-test mismatch (cosine ${test.cosine.toFixed(5)}, rel. error ${test.relErr.toExponential(2)}, loss Δ ${test.lossDiff.toExponential(2)})`),
      { test },
    )
  }
  await getGpuTrainer(device)
  return { test }
}

async function getGpuTrainer(device: GPUDevice): Promise<GpuTrainer> {
  if (gpu && gpu.device === device) return gpu.trainer
  if (gpuPromise) return gpuPromise
  gpuPromise = (async () => {
    destroyGpuTrainer()
    const trainer = await createGpuTrainer(device)
    gpu = { device, trainer }
    return trainer
  })()
  try {
    return await gpuPromise
  } finally {
    gpuPromise = null
  }
}

export function destroyGpuTrainer() {
  if (!gpu) return
  try {
    gpu.trainer.destroy()
  } catch {
    /* ignore */
  }
  gpu = null
}

// ─── one job ──────────────────────────────────────────────────────────────

function finiteNorm(g: Float32Array): number {
  let s = 0
  for (let i = 0; i < g.length; i++) {
    const v = g[i]
    if (!Number.isFinite(v)) return NaN
    s += v * v
  }
  return Math.sqrt(s)
}

function cpuGrad(params: Float32Array, x: Uint8Array, y: Uint8Array, B: number): { grad: Float32Array; loss: number; ms: number } {
  const grad = new Float32Array(SEPIA.params)
  const t0 = performance.now()
  const loss = lossAndGrad(params, x, y, B, grad)
  return { grad, loss, ms: performance.now() - t0 }
}

/**
 * Compute the gradient for one decoded job. On the GPU path a non-finite result
 * is recomputed on the CPU (`gpuFault` reports it so the caller can count strikes).
 */
export async function computeGrad(
  backend: TrainBackend,
  device: GPUDevice | null,
  d: { params: Float32Array; x: Uint8Array; y: Uint8Array; B: number },
): Promise<TrainOut & { gpuFault: string | null }> {
  let gpuFault: string | null = null
  if (backend === 'webgpu' && device) {
    try {
      const t = await getGpuTrainer(device)
      const r = await t.grad(d.params, d.x, d.y, d.B)
      const n = finiteNorm(r.grad)
      if (r.grad.length === SEPIA.params && Number.isFinite(r.loss) && Number.isFinite(n)) {
        // Round-trip through the wire format once, so a pack bug can never ship silently.
        const bytes = encodeGrad(r.grad)
        if (decodeGrad(bytes).length !== SEPIA.params) throw new Error('gradient packing length mismatch')
        return { grad: bytesToB64(bytes), loss: r.loss, ms: r.ms, backend: 'webgpu', gpuFault: null }
      }
      gpuFault = r.grad.length !== SEPIA.params ? `GPU returned ${r.grad.length} values` : 'GPU returned a non-finite gradient'
    } catch (e) {
      gpuFault = e instanceof Error ? e.message : String(e)
    }
  }
  const r = cpuGrad(d.params, d.x, d.y, d.B)
  return { grad: bytesToB64(encodeGrad(r.grad)), loss: r.loss, ms: r.ms, backend: 'cpu', gpuFault }
}
