// The neuron's real work: semantic near-duplicate search.
//
// Given `rows` new page vectors A (rows×dim) and a corpus block B (cols×dim),
// find for every row the column with the highest dot product (vectors are L2
// normalised, so dot = cosine similarity) — exactly shared/vectorize.ts
// bestMatchesCPU, including its tie rule: CPU scans columns in order with a
// strict '>', so among equal similarities the LOWEST column index wins.
//
// GPU kernel: one 256-invocation workgroup per row. The row is staged into
// workgroup memory, invocations stride over the columns (c = lid, lid+256, …)
// computing dot(a_row, b_col) with vec4 loads and keeping a private best
// (max sim, lowest idx) plus the runner-up similarity, then a shared-memory
// tree reduction produces the workgroup argmax. Output per row: best index
// (u32), sim and runner-up sim (f32 bits), read back through a MAP_READ buffer.
//
// Numerics: the GPU sums in f32 (vec4 lanes, fma); the CPU reference sums f32
// products in f64. Measured |Δsim| ≈ 6e-8 for dim-256 unit vectors — far inside
// the server's 2e-3 tolerance (SIM_TOLERANCE in server/neurons/coordinator.ts).
// Bit-identical columns give bit-identical GPU sums, so
// exact-duplicate ties resolve like the CPU. The only way the argmax can differ
// from the CPU is a near-tie (top-2 gap below f32 resolution, ~1e-7): rows whose
// GPU top-2 gap is < NEAR_TIE_EPS are re-scored on the CPU with bestMatchesCPU,
// so the returned indices match the reference exactly (capped per job).

import { bestMatchesCPU } from '@shared/vectorize'

export interface SimRun {
  /** Per row: index into cols of the best match (-1 when cols === 0). */
  best: number[]
  /** Per row: cosine similarity of that match (-Infinity when cols === 0). */
  sim: number[]
  /** Wall time: upload + compute + readback (GPU) or busy compute time (CPU). */
  ms: number
  /** GPU only: rows re-scored on the CPU because their top-2 gap was a near-tie. */
  refined?: number
}

/** Largest supported vector dimension (workgroup row cache = MAX_DIM4 vec4s). */
export const SIM_MAX_DIM = 1024
const MAX_DIM4 = SIM_MAX_DIM / 4
const WG = 256 // invocations per workgroup (one workgroup per row); must be a power of two
const NONE = 0xffffffff
/** Target GPU time per submit when the job is split into row chunks (TDR safety). */
const SUBMIT_TARGET_MS = 100
/** Top-2 gap below which f32 rounding could reorder the argmax (~10x the measured error). */
export const NEAR_TIE_EPS = 1e-6
/** Output words per row: best idx, bits(sim), bits(runner-up sim). */
const OUT_STRIDE = 3

export const SIM_WGSL = /* wgsl */ `
struct Params {
  rowStart : u32, // first row handled by this dispatch
  rowEnd : u32,   // one past the last row
  cols : u32,
  dim4 : u32,     // vector length in vec4s (dim padded to a multiple of 4)
}

@group(0) @binding(0) var<storage, read> A : array<vec4<f32>>;          // rows x dim4
@group(0) @binding(1) var<storage, read> B : array<vec4<f32>>;          // cols x dim4
@group(0) @binding(2) var<storage, read_write> OUT : array<u32>;        // [3r] best idx, [3r+1] bits(sim), [3r+2] bits(runner-up)
@group(0) @binding(3) var<uniform> P : Params;

const WG : u32 = ${WG}u;
const MAX_DIM4 : u32 = ${MAX_DIM4}u;
const NONE : u32 = 0xffffffffu;
const LOWEST : f32 = -3.0e38; // below any cosine; WGSL may assume no infinities

var<workgroup> aRow : array<vec4<f32>, MAX_DIM4>;
var<workgroup> redS : array<f32, WG>;
var<workgroup> redI : array<u32, WG>;
var<workgroup> red2 : array<f32, WG>;

@compute @workgroup_size(${WG}, 1, 1)
fn main(@builtin(workgroup_id) wid : vec3<u32>,
        @builtin(local_invocation_index) lid : u32) {
  let row = P.rowStart + wid.x;
  // Uniform early-out: depends only on workgroup_id and a uniform buffer.
  if (row >= P.rowEnd) {
    return;
  }
  let dim4 = P.dim4;
  let cols = P.cols;

  // Stage the query row in workgroup memory (shared by all 256 invocations).
  let aOff = row * dim4;
  for (var k = lid; k < dim4; k = k + WG) {
    aRow[k] = A[aOff + k];
  }
  workgroupBarrier();

  // Private scan: columns visited in increasing order with a strict '>' keeps
  // the lowest index among equal sims (same rule as bestMatchesCPU). sec is the
  // runner-up similarity (an exact tie lands there too, giving a zero gap).
  var bestS : f32 = LOWEST;
  var bestI : u32 = NONE;
  var sec : f32 = LOWEST;
  for (var c = lid; c < cols; c = c + WG) {
    let bOff = c * dim4;
    var acc = vec4<f32>(0.0);
    for (var k = 0u; k < dim4; k = k + 1u) {
      acc = fma(aRow[k], B[bOff + k], acc);
    }
    let d = (acc.x + acc.y) + (acc.z + acc.w);
    if (d > bestS) {
      sec = bestS;
      bestS = d;
      bestI = c;
    } else if (d > sec) {
      sec = d;
    }
  }

  // Workgroup argmax: higher sim wins; equal sims -> lower index; NONE never wins.
  // The losing side's best competes for the runner-up slot.
  redS[lid] = bestS;
  redI[lid] = bestI;
  red2[lid] = sec;
  workgroupBarrier();
  for (var s = WG / 2u; s > 0u; s = s >> 1u) {
    if (lid < s) {
      let os = redS[lid + s];
      let oi = redI[lid + s];
      let o2 = red2[lid + s];
      let ms = redS[lid];
      let mi = redI[lid];
      let m2 = red2[lid];
      if (oi != NONE && (mi == NONE || os > ms || (os == ms && oi < mi))) {
        redS[lid] = os;
        redI[lid] = oi;
        red2[lid] = max(o2, ms);
      } else {
        red2[lid] = max(m2, os);
      }
    }
    workgroupBarrier();
  }

  if (lid == 0u) {
    OUT[3u * row] = redI[0];
    OUT[3u * row + 1u] = bitcast<u32>(redS[0]);
    OUT[3u * row + 2u] = bitcast<u32>(red2[0]);
  }
}
`

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function checkArgs(a: Float32Array, b: Float32Array, rows: number, cols: number, dim: number) {
  const okInt = (x: number) => Number.isInteger(x) && x >= 0
  if (!okInt(rows) || !okInt(cols) || !okInt(dim) || dim === 0) {
    throw new Error(`invalid job shape ${rows}×${cols}×${dim}`)
  }
  if (a.length < rows * dim) throw new Error(`A has ${a.length} floats, need ${rows * dim}`)
  if (b.length < cols * dim) throw new Error(`B has ${b.length} floats, need ${cols * dim}`)
}

/** Copy `n` vectors of length `dim` into a vec4-aligned layout (zero padded); no copy when already aligned. */
function packVec4(src: Float32Array, n: number, dim: number, dim4: number): Float32Array {
  if (dim4 * 4 === dim) return src.length === n * dim ? src : src.subarray(0, n * dim)
  const stride = dim4 * 4
  const out = new Float32Array(n * stride)
  for (let i = 0; i < n; i++) out.set(src.subarray(i * dim, i * dim + dim), i * stride)
  return out
}

function emptyResult(rows: number, t0: number): SimRun {
  return { best: new Array<number>(rows).fill(-1), sim: new Array<number>(rows).fill(-Infinity), ms: performance.now() - t0 }
}

/**
 * Reusable WebGPU similarity kernel. Pipelines and buffers are created once and
 * grown on demand; concurrent run() calls are serialised.
 */
export class SimKernel {
  readonly device: GPUDevice
  private readonly module: GPUShaderModule
  private readonly ready: Promise<GPUComputePipeline>
  private pipeline: GPUComputePipeline | null = null
  private params: GPUBuffer | null = null
  private bufA: GPUBuffer | null = null
  private bufB: GPUBuffer | null = null
  private bufOut: GPUBuffer | null = null
  private bufRead: GPUBuffer | null = null
  private bindGroup: GPUBindGroup | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private destroyed = false
  private gflopsHint = 0
  /** Re-score near-tie rows on the CPU so indices match bestMatchesCPU exactly. */
  refineNearTies = true
  /** Upper bound on CPU-refined rows per job (keeps the main thread responsive). */
  maxRefineRows = 32

  constructor(device: GPUDevice) {
    this.device = device
    this.module = device.createShaderModule({ label: 'lusca-simmatrix', code: SIM_WGSL })
    this.ready = device.createComputePipelineAsync({
      label: 'lusca-simmatrix',
      layout: 'auto',
      compute: { module: this.module, entryPoint: 'main' },
    })
    // Mark the rejection handled here; run() re-awaits and reports it.
    this.ready.then(
      (p) => {
        this.pipeline = p
      },
      () => {},
    )
  }

  /**
   * Benchmarked matmul GFLOPS of this device. Used only to split very large
   * jobs into several submits so no single submit runs long enough to trip the
   * OS GPU watchdog (TDR) on slow GPUs.
   */
  setThroughputHint(gflops: number) {
    this.gflopsHint = Number.isFinite(gflops) && gflops > 0 ? gflops : 0
  }

  /** Whether a job of this shape fits the device's buffer limits. */
  fits(rows: number, cols: number, dim: number): boolean {
    const dim4 = Math.ceil(dim / 4)
    if (dim4 > MAX_DIM4) return false
    const maxBind = Math.min(this.device.limits.maxStorageBufferBindingSize, this.device.limits.maxBufferSize)
    return Math.max(rows, cols) * dim4 * 16 <= maxBind && rows * OUT_STRIDE * 4 <= maxBind
  }

  run(a: Float32Array, b: Float32Array, rows: number, cols: number, dim: number): Promise<SimRun> {
    const p = this.chain.then(() => this.runInner(a, b, rows, cols, dim))
    this.chain = p.catch(() => {})
    return p
  }

  destroy() {
    this.destroyed = true
    for (const buf of [this.params, this.bufA, this.bufB, this.bufOut, this.bufRead]) {
      try {
        buf?.destroy()
      } catch {
        /* ignore */
      }
    }
    this.params = this.bufA = this.bufB = this.bufOut = this.bufRead = null
    this.bindGroup = null
  }

  private async getPipeline(): Promise<GPUComputePipeline> {
    if (this.pipeline) return this.pipeline
    try {
      return await this.ready
    } catch (e) {
      let detail = ''
      try {
        const info = await this.module.getCompilationInfo()
        detail = info.messages.map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`).join('; ')
      } catch {
        /* ignore */
      }
      throw new Error(`similarity pipeline failed: ${errText(e)}${detail ? ` (${detail})` : ''}`)
    }
  }

  /** Return a buffer of at least `need` bytes, replacing (and invalidating the bind group) when too small. */
  private grow(cur: GPUBuffer | null, need: number, usage: number, label: string, maxBind: number): GPUBuffer {
    if (cur && cur.size >= need) return cur
    try {
      cur?.destroy()
    } catch {
      /* ignore */
    }
    const prev = cur?.size ?? 0
    const size = Math.min(maxBind, Math.max(need, Math.ceil((prev * 1.5) / 256) * 256, 256))
    this.bindGroup = null
    return this.device.createBuffer({ label, size: Math.max(size, need), usage })
  }

  /** Rows per submit so that each submit stays near SUBMIT_TARGET_MS on this device. */
  private rowsPerSubmit(cols: number, dim4: number): number {
    const hw = this.device.limits.maxComputeWorkgroupsPerDimension || 65535
    if (!this.gflopsHint) return hw
    // The kernel is bandwidth-bound; assume ~8% of matmul throughput (conservative).
    const effFlopPerMs = Math.max(1, this.gflopsHint * 0.08) * 1e6
    const flopPerRow = 2 * cols * dim4 * 4
    return Math.max(1, Math.min(hw, Math.floor((effFlopPerMs * SUBMIT_TARGET_MS) / flopPerRow)))
  }

  private async runInner(a: Float32Array, b: Float32Array, rows: number, cols: number, dim: number): Promise<SimRun> {
    if (this.destroyed) throw new Error('GPU kernel was destroyed')
    checkArgs(a, b, rows, cols, dim)
    const t0 = performance.now()
    if (rows === 0) return { best: [], sim: [], ms: 0 }
    if (cols === 0) return emptyResult(rows, t0)

    const dim4 = Math.ceil(dim / 4)
    if (dim4 > MAX_DIM4) throw new Error(`dim ${dim} exceeds GPU kernel maximum ${SIM_MAX_DIM}`)
    const device = this.device
    const maxBind = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize)
    const aBytes = rows * dim4 * 16
    const bBytes = cols * dim4 * 16
    const outBytes = rows * OUT_STRIDE * 4
    if (aBytes > maxBind || bBytes > maxBind) {
      throw new Error(`job ${rows}×${cols}×${dim} exceeds this GPU's storage binding limit (${maxBind} bytes)`)
    }

    const pipeline = await this.getPipeline()
    const aData = packVec4(a, rows, dim, dim4)
    const bData = packVec4(b, cols, dim, dim4)

    device.pushErrorScope('out-of-memory')
    device.pushErrorScope('validation')
    let valErr: GPUError | null = null
    let oomErr: GPUError | null = null
    try {
      const STORAGE_IN = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      this.params ??= device.createBuffer({ label: 'sim-params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      this.bufA = this.grow(this.bufA, aBytes, STORAGE_IN, 'sim-A', maxBind)
      this.bufB = this.grow(this.bufB, bBytes, STORAGE_IN, 'sim-B', maxBind)
      this.bufOut = this.grow(this.bufOut, outBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, 'sim-out', maxBind)
      this.bufRead = this.grow(this.bufRead, outBytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, 'sim-read', maxBind)
      if (!this.bindGroup) {
        this.bindGroup = device.createBindGroup({
          label: 'sim-bind',
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.bufA } },
            { binding: 1, resource: { buffer: this.bufB } },
            { binding: 2, resource: { buffer: this.bufOut } },
            { binding: 3, resource: { buffer: this.params } },
          ],
        })
      }

      device.queue.writeBuffer(this.bufA, 0, aData)
      device.queue.writeBuffer(this.bufB, 0, bData)

      // Usually a single dispatch; large jobs on slow GPUs are split into row
      // chunks, one submit each (writeBuffer between submits is queue-ordered).
      const chunk = this.rowsPerSubmit(cols, dim4)
      for (let r0 = 0; r0 < rows; r0 += chunk) {
        const r1 = Math.min(rows, r0 + chunk)
        device.queue.writeBuffer(this.params, 0, new Uint32Array([r0, r1, cols, dim4]))
        const enc = device.createCommandEncoder({ label: 'sim-job' })
        const pass = enc.beginComputePass({ label: 'sim-pass' })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, this.bindGroup)
        pass.dispatchWorkgroups(r1 - r0, 1, 1)
        pass.end()
        if (r1 === rows) enc.copyBufferToBuffer(this.bufOut, 0, this.bufRead, 0, outBytes)
        device.queue.submit([enc.finish()])
      }
    } finally {
      valErr = await device.popErrorScope()
      oomErr = await device.popErrorScope()
    }
    if (oomErr) throw new Error(`GPU out of memory: ${oomErr.message}`)
    if (valErr) throw new Error(`GPU validation error: ${valErr.message}`)

    const read = this.bufRead
    if (!read) throw new Error('staging buffer missing')
    await read.mapAsync(GPUMapMode.READ, 0, outBytes)
    let raw: ArrayBuffer
    try {
      raw = read.getMappedRange(0, outBytes).slice(0)
    } finally {
      read.unmap()
    }
    const u = new Uint32Array(raw)
    const f = new Float32Array(raw)
    const best = new Array<number>(rows)
    const sim = new Array<number>(rows)
    // Near-tie candidates: genuine near-ties (0 < gap < eps) first, since those are
    // the ones f32 rounding can flip; then exact ties (usually duplicate vectors,
    // which already resolve like the CPU).
    const near: { r: number; gap: number }[] = []
    for (let r = 0; r < rows; r++) {
      const o = OUT_STRIDE * r
      const idx = u[o]
      if (idx === NONE || idx >= cols) {
        // Only possible when every similarity was NaN: mirror the CPU (-1, -Infinity).
        best[r] = -1
        sim[r] = -Infinity
        continue
      }
      best[r] = idx
      sim[r] = f[o + 1]
      const gap = f[o + 1] - f[o + 2]
      if (this.refineNearTies && cols > 1 && gap < NEAR_TIE_EPS * Math.max(1, Math.abs(f[o + 1]))) near.push({ r, gap })
    }
    let refined = 0
    if (near.length && this.maxRefineRows > 0) {
      near.sort((x, y) => (x.gap > 0 ? 0 : 1) - (y.gap > 0 ? 0 : 1) || x.gap - y.gap)
      const which = near.slice(0, this.maxRefineRows).map((n) => n.r)
      const ref = bestMatchesCPU(a, b, rows, cols, dim, which)
      for (let i = 0; i < which.length; i++) {
        best[which[i]] = ref.best[i]
        sim[which[i]] = ref.sim[i]
      }
      refined = which.length
    }
    return { best, sim, ms: performance.now() - t0, refined }
  }
}

const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0))

/**
 * CPU fallback with bestMatchesCPU semantics, time-sliced (~12 ms slices) so
 * the page stays responsive. `ms` is busy compute time, excluding yields.
 * Throws 'aborted' if shouldAbort() turns true between slices.
 */
export async function simCPU(
  a: Float32Array,
  b: Float32Array,
  rows: number,
  cols: number,
  dim: number,
  shouldAbort?: () => boolean,
): Promise<SimRun> {
  checkArgs(a, b, rows, cols, dim)
  const best = new Array<number>(rows)
  const sim = new Array<number>(rows)
  let busy = 0
  let sliceStart = performance.now()
  for (let r = 0; r < rows; r++) {
    const one = bestMatchesCPU(a, b, rows, cols, dim, [r])
    best[r] = one.best[0]
    sim[r] = one.sim[0]
    const now = performance.now()
    if (now - sliceStart > 12 && r + 1 < rows) {
      busy += now - sliceStart
      await yieldToLoop()
      if (shouldAbort?.()) throw new Error('aborted')
      sliceStart = performance.now()
    }
  }
  busy += performance.now() - sliceStart
  return { best, sim, ms: busy }
}

export interface SpotCheck {
  checked: number
  passed: number
  /** Largest |sim_got - sim_cpu| over checked rows. */
  maxErr: number
  rows: number[]
}

function dotAt(a: Float32Array, r: number, b: Float32Array, c: number, dim: number): number {
  let d = 0
  const ao = r * dim
  const bo = c * dim
  for (let k = 0; k < dim; k++) d += a[ao + k] * b[bo + k]
  return d
}

/**
 * Re-compute `which` rows on the CPU and compare. A row passes when the sim is
 * within `tol` and the index matches — or, for a numerical near-tie, the
 * returned column's CPU similarity is itself within `tol` of the best.
 */
export function spotCheck(
  a: Float32Array,
  b: Float32Array,
  rows: number,
  cols: number,
  dim: number,
  got: Pick<SimRun, 'best' | 'sim'>,
  which: number[],
  tol = 1e-4,
): SpotCheck {
  const valid = which.filter((r) => Number.isInteger(r) && r >= 0 && r < rows)
  const ref = bestMatchesCPU(a, b, rows, cols, dim, valid)
  let passed = 0
  let maxErr = 0
  for (let i = 0; i < valid.length; i++) {
    const r = valid[i]
    const cb = ref.best[i]
    const cs = ref.sim[i]
    const gb = got.best[r]
    const gs = got.sim[r]
    if (cb === -1) {
      if (gb === -1) passed++
      continue
    }
    const err = Math.abs(gs - cs)
    if (Number.isFinite(err) && err > maxErr) maxErr = err
    const simOk = err <= tol
    const idxOk =
      gb === cb || (Number.isInteger(gb) && gb >= 0 && gb < cols && Math.abs(dotAt(a, r, b, gb, dim) - cs) <= tol)
    if (simOk && idxOk) passed++
  }
  return { checked: valid.length, passed, maxErr, rows: valid }
}

/** `n` distinct random row indices in [0, rows). */
export function pickRows(rows: number, n: number): number[] {
  const k = Math.max(0, Math.min(rows, Math.floor(n)))
  const picked = new Set<number>()
  while (picked.size < k) picked.add(Math.floor(Math.random() * rows))
  return [...picked]
}
