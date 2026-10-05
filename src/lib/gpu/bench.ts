// FP32 GEMM benchmark used to place a neuron in an ocean-depth zone.
//
// Kernel: classic register-blocked tiled matmul. Each 16×16 workgroup owns a
// 64×64 tile of C; every invocation accumulates a 4×4 micro-tile in registers
// from 16-deep K slices staged in workgroup memory, using vec4 loads for both
// operands (one coalesced vec4 per invocation per operand per slice).
//
// A is stored K-major (i.e. we multiply Aᵀ·B with Aᵀ laid out row-major) — the
// usual GEMM-microbenchmark layout that lets both operand tiles be loaded as
// contiguous vec4 rows. The FLOP count is identical: 2·N³ per N×N×N product.
//
// Timing: batches of dispatches inside one compute pass per submit, sized to
// ~90 ms (well under Windows' 2 s TDR and our 150 ms per-submit budget).
// With the 'timestamp-query' feature the pass's GPU begin/end timestamps are
// used; otherwise wall clock around queue.onSubmittedWorkDone(). Result is the
// median GFLOPS of ≥5 timed batches at the best size (N=1024 and N=2048).

export type BenchPhase = 'validate' | 'warmup' | 'measure' | 'done'

export interface BenchProgress {
  phase: BenchPhase
  /** 0..100 */
  pct: number
  /** Latest measured / running-median GFLOPS, when known. */
  gflops?: number
  /** Matrix size being measured. */
  n?: number
}

export interface BenchSize {
  n: number
  /** Median GFLOPS at this size. */
  gflops: number
  /** GFLOPS of each timed batch. */
  runs: number[]
  /** Dispatches per timed batch. */
  reps: number
}

export interface BenchResult {
  /** Median GFLOPS at the best-performing size. */
  gflops: number
  /** GFLOPS of each timed batch at that size. */
  runs: number[]
  /** Matrix size the headline number comes from. */
  n: number
  /** Total benchmark wall time, ms. */
  ms: number
  sizes: BenchSize[]
  timing: 'timestamp-query' | 'wall-clock' | 'cpu'
  backend: 'webgpu' | 'cpu'
}

const TILE = 64 // C tile edge per workgroup (16 invocations × 4)
const SUBMIT_BUDGET_MS = 150 // never submit more than this much estimated GPU work at once
const TARGET_BATCH_MS = 90 // aim for this much GPU work per timed batch
const MAX_REPS = 512
const TIMED_RUNS = 7
const SIZES = [1024, 2048]

export const MATMUL_WGSL = /* wgsl */ `
struct Dims {
  M : u32,
  N : u32,
  K : u32,
  pad : u32,
}

// AT is K x M (A transposed, row-major), B is K x N, C is M x N. M and N are multiples of 4.
@group(0) @binding(0) var<storage, read> AT : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> B : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> C : array<vec4<f32>>;
@group(0) @binding(3) var<uniform> dims : Dims;

// One 16-deep K slice of each operand: [k][4-wide column group].
var<workgroup> As : array<array<vec4<f32>, 16>, 16>;
var<workgroup> Bs : array<array<vec4<f32>, 16>, 16>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(workgroup_id) wid : vec3<u32>,
        @builtin(local_invocation_id) lid : vec3<u32>) {
  let M4 = dims.M / 4u;
  let N4 = dims.N / 4u;
  let K = dims.K;
  let tx = lid.x;
  let ty = lid.y;
  let row4Base = wid.y * 16u; // tile origin, in units of 4 rows
  let col4Base = wid.x * 16u; // tile origin, in units of 4 columns

  var acc0 = vec4<f32>(0.0);
  var acc1 = vec4<f32>(0.0);
  var acc2 = vec4<f32>(0.0);
  var acc3 = vec4<f32>(0.0);

  let numTiles = (K + 15u) / 16u;
  for (var t = 0u; t < numTiles; t = t + 1u) {
    // Each invocation stages exactly one vec4 of A and one of B (coalesced rows).
    let k = t * 16u + ty;
    var av = vec4<f32>(0.0);
    var bv = vec4<f32>(0.0);
    if (k < K) {
      if (row4Base + tx < M4) { av = AT[k * M4 + row4Base + tx]; }
      if (col4Base + tx < N4) { bv = B[k * N4 + col4Base + tx]; }
    }
    As[ty][tx] = av;
    Bs[ty][tx] = bv;
    workgroupBarrier();

    for (var kk = 0u; kk < 16u; kk = kk + 1u) {
      let a = As[kk][ty]; // rows 4*(row4Base+ty) .. +3
      let b = Bs[kk][tx]; // cols 4*(col4Base+tx) .. +3
      acc0 = fma(vec4<f32>(a.x), b, acc0);
      acc1 = fma(vec4<f32>(a.y), b, acc1);
      acc2 = fma(vec4<f32>(a.z), b, acc2);
      acc3 = fma(vec4<f32>(a.w), b, acc3);
    }
    workgroupBarrier();
  }

  let col4 = col4Base + tx;
  let r0 = (row4Base + ty) * 4u;
  if (col4 < N4) {
    if (r0 < dims.M) { C[r0 * N4 + col4] = acc0; }
    if (r0 + 1u < dims.M) { C[(r0 + 1u) * N4 + col4] = acc1; }
    if (r0 + 2u < dims.M) { C[(r0 + 2u) * N4 + col4] = acc2; }
    if (r0 + 3u < dims.M) { C[(r0 + 3u) * N4 + col4] = acc3; }
  }
}
`

interface Operands {
  M: number
  N: number
  K: number
  at: GPUBuffer
  b: GPUBuffer
  c: GPUBuffer
  bind: GPUBindGroup
}

interface Ctx {
  device: GPUDevice
  pipeline: GPUComputePipeline
  params: GPUBuffer
  ts: { querySet: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer } | null
  owned: { destroy(): void }[]
  ops: Operands | null
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = xs.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function randomMatrix(len: number): Float32Array {
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) out[i] = Math.random() - 0.5
  return out
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function makePipeline(device: GPUDevice): Promise<GPUComputePipeline> {
  const module = device.createShaderModule({ label: 'lusca-bench-matmul', code: MATMUL_WGSL })
  try {
    return await device.createComputePipelineAsync({
      label: 'lusca-bench-matmul',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    })
  } catch (e) {
    let detail = ''
    try {
      const info = await module.getCompilationInfo()
      detail = info.messages.map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`).join('; ')
    } catch {
      /* ignore */
    }
    throw new Error(`matmul pipeline failed: ${errText(e)}${detail ? ` (${detail})` : ''}`)
  }
}

function freeOperands(ctx: Ctx) {
  if (!ctx.ops) return
  for (const b of [ctx.ops.at, ctx.ops.b, ctx.ops.c]) {
    try {
      b.destroy()
    } catch {
      /* ignore */
    }
  }
  ctx.ops = null
}

/** (Re)allocate operand buffers for an M×K · K×N product and upload data. */
function allocOperands(ctx: Ctx, M: number, N: number, K: number, at?: Float32Array, b?: Float32Array): Operands {
  freeOperands(ctx)
  const { device } = ctx
  const usageIn = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  const atBuf = device.createBuffer({ label: 'bench-AT', size: K * M * 4, usage: usageIn })
  const bBuf = device.createBuffer({ label: 'bench-B', size: K * N * 4, usage: usageIn })
  const cBuf = device.createBuffer({
    label: 'bench-C',
    size: M * N * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  device.queue.writeBuffer(atBuf, 0, at ?? randomMatrix(K * M))
  device.queue.writeBuffer(bBuf, 0, b ?? randomMatrix(K * N))
  device.queue.writeBuffer(ctx.params, 0, new Uint32Array([M, N, K, 0]))
  const bind = device.createBindGroup({
    label: 'bench-bind',
    layout: ctx.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: atBuf } },
      { binding: 1, resource: { buffer: bBuf } },
      { binding: 2, resource: { buffer: cBuf } },
      { binding: 3, resource: { buffer: ctx.params } },
    ],
  })
  ctx.ops = { M, N, K, at: atBuf, b: bBuf, c: cBuf, bind }
  return ctx.ops
}

/**
 * Submit `reps` back-to-back dispatches of the current operands in one pass and
 * return the elapsed milliseconds (GPU timestamps when available and sane).
 */
async function timeBatch(ctx: Ctx, reps: number): Promise<{ ms: number; source: 'timestamp-query' | 'wall-clock' }> {
  const ops = ctx.ops
  if (!ops) throw new Error('bench operands not allocated')
  const { device } = ctx
  const enc = device.createCommandEncoder({ label: 'bench-batch' })
  const pass = enc.beginComputePass(
    ctx.ts ? { timestampWrites: { querySet: ctx.ts.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {},
  )
  pass.setPipeline(ctx.pipeline)
  pass.setBindGroup(0, ops.bind)
  const gx = Math.ceil(ops.N / TILE)
  const gy = Math.ceil(ops.M / TILE)
  for (let i = 0; i < reps; i++) pass.dispatchWorkgroups(gx, gy, 1)
  pass.end()
  if (ctx.ts) {
    enc.resolveQuerySet(ctx.ts.querySet, 0, 2, ctx.ts.resolve, 0)
    enc.copyBufferToBuffer(ctx.ts.resolve, 0, ctx.ts.read, 0, 16)
  }
  const t0 = performance.now()
  device.queue.submit([enc.finish()])
  await device.queue.onSubmittedWorkDone()
  const wall = performance.now() - t0
  if (ctx.ts) {
    try {
      await ctx.ts.read.mapAsync(GPUMapMode.READ, 0, 16)
      const stamps = new BigUint64Array(ctx.ts.read.getMappedRange(0, 16).slice(0))
      ctx.ts.read.unmap()
      const gpuMs = Number(stamps[1] - stamps[0]) / 1e6
      // Timestamps can be quantized (100 µs in Chrome), zero, or garbage on some
      // drivers — only trust them when they are consistent with the wall clock.
      if (stamps[1] > stamps[0] && gpuMs > 0.05 && gpuMs <= wall + 1) return { ms: gpuMs, source: 'timestamp-query' }
    } catch {
      /* fall back to wall clock */
    }
  }
  return { ms: Math.max(wall, 0.001), source: 'wall-clock' }
}

/** Run one small, ragged product on the GPU and compare against the CPU. Throws on mismatch. */
async function validate(ctx: Ctx): Promise<void> {
  // Deliberately not multiples of the 64×64 tile / 16-deep K slice, to exercise every bounds check.
  const M = 132
  const N = 76
  const K = 40
  const at = randomMatrix(K * M)
  const b = randomMatrix(K * N)
  const ops = allocOperands(ctx, M, N, K, at, b)
  const { device } = ctx
  const read = device.createBuffer({ label: 'bench-validate-read', size: M * N * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  try {
    device.pushErrorScope('validation')
    let scopeErr: GPUError | null = null
    try {
      const enc = device.createCommandEncoder({ label: 'bench-validate' })
      const pass = enc.beginComputePass()
      pass.setPipeline(ctx.pipeline)
      pass.setBindGroup(0, ops.bind)
      pass.dispatchWorkgroups(Math.ceil(N / TILE), Math.ceil(M / TILE), 1)
      pass.end()
      enc.copyBufferToBuffer(ops.c, 0, read, 0, M * N * 4)
      device.queue.submit([enc.finish()])
    } finally {
      scopeErr = await device.popErrorScope()
    }
    if (scopeErr) throw new Error(`GPU validation error: ${scopeErr.message}`)
    await read.mapAsync(GPUMapMode.READ)
    const got = new Float32Array(read.getMappedRange().slice(0))
    read.unmap()
    for (let m = 0; m < M; m++) {
      for (let n = 0; n < N; n++) {
        let ref = 0
        for (let k = 0; k < K; k++) ref += at[k * M + m] * b[k * N + n]
        const g = got[m * N + n]
        // NaN-safe: a NaN fails the comparison and therefore the check.
        if (!(Math.abs(g - ref) <= 1e-3 * (1 + Math.abs(ref)))) {
          throw new Error(`GPU matmul is wrong at C[${m}][${n}]: got ${g}, expected ${ref.toFixed(6)} — refusing to benchmark this device`)
        }
      }
    }
  } finally {
    try {
      read.destroy()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Benchmark FP32 matmul throughput on `device`.
 * Throws if the kernel produces wrong results or the device fails.
 */
export async function runBenchmark(
  device: GPUDevice,
  onProgress?: (p: BenchProgress) => void,
): Promise<BenchResult> {
  const tStart = performance.now()
  const report = (p: BenchProgress) => {
    try {
      onProgress?.(p)
    } catch {
      /* UI callbacks must never break the benchmark */
    }
  }
  report({ phase: 'validate', pct: 0 })

  const pipeline = await makePipeline(device)
  const params = device.createBuffer({ label: 'bench-dims', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const ctx: Ctx = { device, pipeline, params, ts: null, owned: [params], ops: null }

  if (device.features.has('timestamp-query')) {
    try {
      const querySet = device.createQuerySet({ label: 'bench-ts', type: 'timestamp', count: 2 })
      const resolve = device.createBuffer({ label: 'bench-ts-resolve', size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
      const read = device.createBuffer({ label: 'bench-ts-read', size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
      ctx.ts = { querySet, resolve, read }
      ctx.owned.push(querySet, resolve, read)
    } catch {
      ctx.ts = null
    }
  }

  try {
    await validate(ctx)
    report({ phase: 'warmup', pct: 6 })

    // ── warm-up / rough throughput estimate on a small product ──────────
    allocOperands(ctx, 256, 256, 256)
    await timeBatch(ctx, 2) // first-dispatch costs (lazy driver init) land here
    let reps = 8
    let est = await timeBatch(ctx, reps)
    if (est.ms < 20) {
      reps = Math.min(MAX_REPS, Math.max(8, Math.floor((reps * 25) / Math.max(est.ms, 0.05))))
      est = await timeBatch(ctx, reps)
    }
    // GFLOPS = flop / (ms * 1e6). Small products under-utilise big GPUs, so this
    // under-estimates throughput — which keeps the TDR guard below conservative.
    let gflopsEst = (2 * 256 ** 3 * reps) / (est.ms * 1e6)
    report({ phase: 'warmup', pct: 14, gflops: gflopsEst })

    // ── choose sizes that fit buffer limits and the per-submit budget ────
    const maxBind = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize)
    let sizes = SIZES.filter((n) => n * n * 4 <= maxBind)
    const predictMs = (n: number) => (2 * n ** 3) / (gflopsEst * 1e6)
    if (!sizes.length || predictMs(sizes[0]) > SUBMIT_BUDGET_MS) {
      // Very slow (software) adapter: measure the largest size whose single dispatch fits the budget.
      const small = [512, 256].find((n) => predictMs(n) <= SUBMIT_BUDGET_MS) ?? 256
      sizes = [small]
    }

    const results: BenchSize[] = []
    let timing: 'timestamp-query' | 'wall-clock' = ctx.ts ? 'timestamp-query' : 'wall-clock'
    const span = 86 / sizes.length
    for (let si = 0; si < sizes.length; si++) {
      const n = sizes[si]
      const base = 14 + si * span
      if (si > 0 && predictMs(n) > SUBMIT_BUDGET_MS) break // e.g. skip 2048 on mid-range iGPUs
      try {
        allocOperands(ctx, n, n, n)
      } catch (e) {
        if (results.length) break // out of memory for the larger size — keep what we have
        throw e
      }
      report({ phase: 'warmup', pct: base, n, gflops: results.length ? results[results.length - 1].gflops : gflopsEst })

      // One warm single dispatch tells us how many fit in a batch.
      const single = await timeBatch(ctx, 1)
      if (si > 0 && single.ms > SUBMIT_BUDGET_MS) break
      let batchReps = Math.max(1, Math.min(MAX_REPS, Math.floor(TARGET_BATCH_MS / Math.max(single.ms, 0.01))))
      // Clock ramp: GPUs boost only after a few hundred ms of sustained load, so
      // keep running untimed batches until throughput settles (≥250 ms and two
      // consecutive batches within 4%), capped at 12 batches.
      {
        const rampStart = performance.now()
        let prev = 0
        for (let i = 0; i < 12; i++) {
          const t = await timeBatch(ctx, batchReps)
          const perDispatch = t.ms / batchReps
          const g = (2 * n ** 3) / (perDispatch * 1e6)
          report({ phase: 'warmup', pct: base, n, gflops: g })
          const settled = prev > 0 && Math.abs(g - prev) / g < 0.04 && performance.now() - rampStart >= 250
          prev = g
          // Re-size the batch for the (now faster) clocks.
          batchReps = Math.max(1, Math.min(MAX_REPS, Math.floor(TARGET_BATCH_MS / Math.max(perDispatch, 0.01))))
          if (settled) break
        }
      }
      const runs: number[] = []
      const flopPerBatch = 2 * n ** 3 * batchReps
      for (let r = 0; r < TIMED_RUNS; r++) {
        const t = await timeBatch(ctx, batchReps)
        if (t.source === 'wall-clock') timing = 'wall-clock'
        runs.push(flopPerBatch / (t.ms * 1e6))
        report({ phase: 'measure', pct: base + (span * (r + 1)) / TIMED_RUNS, n, gflops: median(runs) })
      }
      const g = median(runs)
      results.push({ n, gflops: g, runs, reps: batchReps })
      gflopsEst = Math.max(gflopsEst, g) // sharper TDR prediction for the next size
    }

    if (!results.length) throw new Error('benchmark produced no measurements')
    const best = results.reduce((a, b) => (b.gflops > a.gflops ? b : a))
    const out: BenchResult = {
      gflops: best.gflops,
      runs: best.runs,
      n: best.n,
      ms: performance.now() - tStart,
      sizes: results,
      timing,
      backend: 'webgpu',
    }
    report({ phase: 'done', pct: 100, gflops: out.gflops, n: out.n })
    return out
  } finally {
    freeOperands(ctx)
    for (const o of ctx.owned) {
      try {
        o.destroy()
      } catch {
        /* ignore */
      }
    }
  }
}

const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0))

/**
 * JS matmul (single thread, main thread) for browsers without WebGPU. Runs
 * short slices and yields between them so the page stays responsive.
 */
export async function cpuBenchmark(onProgress?: (p: BenchProgress) => void): Promise<BenchResult> {
  const tStart = performance.now()
  const report = (p: BenchProgress) => {
    try {
      onProgress?.(p)
    } catch {
      /* ignore */
    }
  }
  const N = 192
  const A = randomMatrix(N * N)
  const B = randomMatrix(N * N)
  const C = new Float32Array(N * N)
  const once = () => {
    C.fill(0)
    for (let i = 0; i < N; i++) {
      const co = i * N
      for (let k = 0; k < N; k++) {
        const aik = A[co + k]
        const bo = k * N
        for (let j = 0; j < N; j++) C[co + j] += aik * B[bo + j]
      }
    }
  }
  report({ phase: 'warmup', pct: 5 })
  once() // JIT warm-up
  await yieldToLoop()
  const runs: number[] = []
  const RUNS = 6
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now()
    once()
    const ms = Math.max(performance.now() - t0, 0.01)
    runs.push((2 * N ** 3) / (ms * 1e6))
    report({ phase: 'measure', pct: 10 + (90 * (r + 1)) / RUNS, n: N, gflops: median(runs) })
    await yieldToLoop()
  }
  // Touch C so the work cannot be optimised away.
  if (!Number.isFinite(C[(N * N) >> 1])) throw new Error('CPU matmul produced non-finite output')
  const gflops = median(runs)
  report({ phase: 'done', pct: 100, gflops, n: N })
  return {
    gflops,
    runs,
    n: N,
    ms: performance.now() - tStart,
    sizes: [{ n: N, gflops, runs, reps: 1 }],
    timing: 'cpu',
    backend: 'cpu',
  }
}
