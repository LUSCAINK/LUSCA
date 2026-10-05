// Small helpers shared by the Node page panels.
import { ZONES } from '@shared/protocol'
import type { Zone } from '@shared/protocol'
import type { GpuDetect } from '@/lib/gpu'

/** Depth range of each zone in metres (matches ZONES[].depth). */
export const ZONE_DEPTH: Record<Zone, [number, number]> = {
  EPI: [0, 200],
  MESO: [200, 1000],
  BATHY: [1000, 4000],
  ABYSSO: [4000, 6000],
  HADAL: [6000, 11000],
}

export const FLOOR_M = 11000

export function zoneIdx(z: Zone | null | undefined): number {
  if (!z) return -1
  return ZONES.findIndex((t) => t.zone === z)
}

/**
 * Where a GFLOPS score sits inside its zone, 0..1 (log scale between the zone's
 * floor and the next zone's floor; HADAL tops out at 2× its floor).
 */
export function zoneFraction(gflops: number): { idx: number; frac: number } {
  let idx = 0
  for (let i = 0; i < ZONES.length; i++) if (gflops >= ZONES[i].minGflops) idx = i
  const lo = ZONES[idx].minGflops
  const hi = idx + 1 < ZONES.length ? ZONES[idx + 1].minGflops : lo * 2
  let frac: number
  if (lo <= 0) frac = Math.max(0, gflops) / hi
  else frac = Math.log(Math.max(gflops, lo) / lo) / Math.log(hi / lo)
  return { idx, frac: Math.max(0, Math.min(0.97, frac)) }
}

/** Depth in metres for a benchmark score. */
export function depthFor(gflops: number): number {
  const { idx, frac } = zoneFraction(gflops)
  const [lo, hi] = ZONE_DEPTH[ZONES[idx].zone]
  return lo + frac * (hi - lo)
}

/** Equal-height band position (0..1 from the surface) for a depth in metres. */
export function bandPos(depthM: number): number {
  const d = Math.max(0, Math.min(FLOOR_M, depthM))
  for (let i = 0; i < ZONES.length; i++) {
    const [lo, hi] = ZONE_DEPTH[ZONES[i].zone]
    if (d <= hi || i === ZONES.length - 1) return (i + (d - lo) / (hi - lo)) / ZONES.length
  }
  return 1
}

/** Zone for a depth in metres. */
export function zoneAtDepth(depthM: number): Zone {
  for (const z of ZONES) if (depthM < ZONE_DEPTH[z.zone][1]) return z.zone
  return 'HADAL'
}

/** 12.3 GFLOPS / 4,210 GFLOPS */
export function fmtG(g: number): string {
  if (!Number.isFinite(g) || g <= 0) return '0'
  if (g >= 100) return Math.round(g).toLocaleString('en-US')
  if (g >= 10) return g.toFixed(1)
  return g.toFixed(2)
}

/** Total work, e.g. "312 GFLOP", "1.24 TFLOP", "18.0 MFLOP". */
export function fmtFlop(flops: number): { v: string; u: string } {
  const a = Math.max(0, flops)
  if (a >= 1e15) return { v: (a / 1e15).toFixed(2), u: 'PFLOP' }
  if (a >= 1e12) return { v: (a / 1e12).toFixed(2), u: 'TFLOP' }
  if (a >= 1e9) return { v: (a / 1e9).toFixed(a >= 1e11 ? 0 : 1), u: 'GFLOP' }
  if (a >= 1e6) return { v: (a / 1e6).toFixed(1), u: 'MFLOP' }
  return { v: Math.round(a).toLocaleString('en-US'), u: 'FLOP' }
}

export function fmtInk(n: number): string {
  if (!Number.isFinite(n)) return '0.00'
  if (n >= 100000) return Math.round(n).toLocaleString('en-US')
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtM(m: number): string {
  return `${Math.round(m).toLocaleString('en-US')} m`
}

export function shortId(id: string | null | undefined): string {
  if (!id) return '—'
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || id.slice(0, 6)
}

/** Smooth-scroll to a stage, respecting reduced motion. */
export function scrollToId(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
}

/** Short human GPU name, e.g. "NVIDIA GeForce RTX 4070" (or "CPU" on the fallback path). */
export function deviceName(det: GpuDetect | null, cpu: boolean): string {
  if (cpu || !det || !det.supported) return 'CPU'
  const desc = det.info.description.trim()
  if (desc) return desc.replace(/\(R\)|\(TM\)/gi, '').replace(/\s+/g, ' ').trim()
  const vendor = det.label.split('·')[0].trim()
  const arch = det.info.architecture || det.info.device
  return arch ? `${vendor} ${arch}` : vendor
}
