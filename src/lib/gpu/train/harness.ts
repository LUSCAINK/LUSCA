// Dev-only harness (not routed in the app): open src/lib/gpu/train/harness.html
// through the Vite dev server (or an esbuild bundle) in a WebGPU browser. It
// runs selfTest() and times the gradient pass at the production batch sizes;
// results land in window.__sepiaGpu and in the page body as JSON.

import { compareGrads, createGpuTrainer, selfTest, selfTestCase } from './index'
import { lossAndGrad, SEPIA } from '@shared/sepia/index.mjs'

async function main() {
  const out: Record<string, unknown> = { ua: navigator.userAgent }
  const w = window as unknown as Record<string, unknown>
  try {
    if (!navigator.gpu) throw new Error('navigator.gpu unavailable')
    const fallback = new URLSearchParams(location.search).has('fallback')
    const adapter = await navigator.gpu.requestAdapter(fallback ? { forceFallbackAdapter: true } : { powerPreference: 'high-performance' })
    if (!adapter) throw new Error('no WebGPU adapter')
    out.adapter = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : null
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 256 * 1024 * 1024),
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 256 * 1024 * 1024),
      },
    })
    out.selfTest = await selfTest(device)
    const sizes = (new URLSearchParams(location.search).get('B') ?? '256,1024,4096').split(',').map(Number)
    const trainer = await createGpuTrainer(device)
    const bench: Record<string, unknown>[] = []
    for (const B of sizes) {
      const { params, x, y } = selfTestCase(B, 1234 + B)
      const first = await trainer.grad(params, x, y, B)
      const times: number[] = []
      let last = first
      for (let i = 0; i < 3; i++) {
        last = await trainer.grad(params, x, y, B)
        times.push(last.ms)
      }
      const ref = new Float32Array(SEPIA.params)
      const c0 = performance.now()
      const refLoss = lossAndGrad(params, x, y, B, ref)
      const cpuMs = performance.now() - c0
      const cmp = compareGrads(last.grad, ref)
      let same = true
      for (let i = 0; i < ref.length; i++) if (first.grad[i] !== last.grad[i]) { same = false; break }
      bench.push({ B, firstMs: +first.ms.toFixed(1), ms: times.map((t) => +t.toFixed(1)), cpuMs: +cpuMs.toFixed(1), cosine: cmp.cosine, relErr: cmp.relErr, maxAbsErr: cmp.maxAbsErr, lossDiff: Math.abs(last.loss - refLoss), loss: last.loss, deterministic: same })
      out.bench = bench
    }
    trainer.destroy()
  } catch (e) {
    out.error = e instanceof Error ? e.stack ?? e.message : String(e)
  }
  w.__sepiaGpu = out
  document.body.textContent = JSON.stringify(out, null, 1)
}
void main()
