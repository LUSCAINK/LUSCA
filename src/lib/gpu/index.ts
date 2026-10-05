// LUSCA browser neuron — public API.
//
//   import { useNeuron, detect, benchmark, start, pause, resume, stop } from '@/lib/gpu'
//
// Low-level pieces (detectGpu, runBenchmark, SimKernel, …) are exported too for
// pages that want to show raw capability info or run kernels directly.
export * from './detect'
export * from './bench'
export * from './simkernel'
export * from './neuron'
