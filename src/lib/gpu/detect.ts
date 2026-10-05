// WebGPU capability detection for LUSCA neurons.
//
// detectGpu() never throws: on browsers without WebGPU (older Safari, Firefox
// outside Windows, locked-down Chrome, insecure origins) it resolves with
// `supported: false` and a human-readable `reason`, plus CPU facts so the UI can
// offer the CPU fallback. acquireDevice() turns a detection into a GPUDevice
// with the limits/features the neuron kernels want.
//
// IMPORTANT: nothing here touches WebGPU globals (GPUBufferUsage, …) at module
// top level, so importing this file is safe on browsers without WebGPU.

export interface GpuAdapterSummary {
  vendor: string
  architecture: string
  device: string
  description: string
}

export interface GpuLimitsSummary {
  maxBufferSize: number
  maxStorageBufferBindingSize: number
  maxComputeWorkgroupSizeX: number
  maxComputeInvocationsPerWorkgroup: number
  maxComputeWorkgroupStorageSize: number
  maxComputeWorkgroupsPerDimension: number
}

export interface CpuSummary {
  /** navigator.hardwareConcurrency (logical threads), 1 when unknown. */
  cores: number
  /** navigator.deviceMemory in GB (Chromium only, capped at 8 by the browser on some builds), null when unknown. */
  memoryGB: number | null
  /** e.g. "CPU · 16 threads · 8 GB" */
  label: string
}

export interface GpuDetect {
  supported: boolean
  /** Why WebGPU cannot be used (only when supported === false). */
  reason?: string
  adapter?: GPUAdapter
  info: GpuAdapterSummary
  features: string[]
  limits: GpuLimitsSummary
  /** True for software adapters (SwiftShader / WARP): works, but slow. */
  isFallback: boolean
  /** e.g. "NVIDIA · ampere" (or the CPU label when unsupported). */
  label: string
  cpu: CpuSummary
  /** Coarse browser family, used for the reason text: chrome | edge | opera | firefox | safari | other */
  browser: string
}

const EMPTY_INFO: GpuAdapterSummary = { vendor: '', architecture: '', device: '', description: '' }

const EMPTY_LIMITS: GpuLimitsSummary = {
  maxBufferSize: 0,
  maxStorageBufferBindingSize: 0,
  maxComputeWorkgroupSizeX: 0,
  maxComputeInvocationsPerWorkgroup: 0,
  maxComputeWorkgroupStorageSize: 0,
  maxComputeWorkgroupsPerDimension: 0,
}

const VENDOR_NAMES: Record<string, string> = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  ati: 'AMD',
  intel: 'Intel',
  apple: 'Apple',
  qualcomm: 'Qualcomm',
  arm: 'Arm',
  google: 'Google',
  microsoft: 'Microsoft',
  mesa: 'Mesa',
  imagination: 'Imagination',
  'imagination technologies': 'Imagination',
  samsung: 'Samsung',
  broadcom: 'Broadcom',
  'img-tec': 'Imagination',
}

function hasNavigator(): boolean {
  return typeof navigator !== 'undefined'
}

/** Coarse browser family from the UA string (order matters: Edge/Opera contain "Chrome"). */
export function browserFamily(): string {
  if (!hasNavigator()) return 'other'
  const ua = navigator.userAgent || ''
  if (/Edg\//.test(ua)) return 'edge'
  if (/OPR\//.test(ua)) return 'opera'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrome\/|Chromium\/|CriOS\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'safari'
  return 'other'
}

export function cpuSummary(): CpuSummary {
  let cores = 1
  let memoryGB: number | null = null
  try {
    if (hasNavigator()) {
      cores = Math.max(1, Math.floor(navigator.hardwareConcurrency || 1))
      const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
      memoryGB = typeof dm === 'number' && dm > 0 ? dm : null
    }
  } catch {
    /* privacy-hardened browsers may throw on access */
  }
  const label = `CPU · ${cores} thread${cores === 1 ? '' : 's'}${memoryGB ? ` · ${memoryGB} GB` : ''}`
  return { cores, memoryGB, label }
}

function noWebGpuReason(browser: string): string {
  switch (browser) {
    case 'safari':
      return 'This Safari does not expose WebGPU. It ships on by default in Safari 26 (macOS / iOS / iPadOS 26); on older versions enable Develop → Feature Flags → WebGPU, or use Chrome / Edge.'
    case 'firefox':
      return 'This Firefox build does not expose WebGPU. It is on by default in Firefox 141+ on Windows; on other platforms set dom.webgpu.enabled = true in about:config, or use Chrome / Edge.'
    case 'chrome':
    case 'edge':
    case 'opera':
      return 'WebGPU is turned off in this browser. Check chrome://gpu — it can be disabled by enterprise policy, a flag, an outdated OS, or a blocklisted driver.'
    default:
      return 'This browser does not support WebGPU. Use a recent Chrome or Edge, Safari 26+, or Firefox 141+ on Windows.'
  }
}

function prettyVendor(vendor: string, description: string): string {
  const v = vendor.trim().toLowerCase()
  if (v && VENDOR_NAMES[v]) return VENDOR_NAMES[v]
  if (v) return v.charAt(0).toUpperCase() + v.slice(1)
  // Some browsers leave `vendor` empty but fill `description`.
  const d = description.toLowerCase()
  for (const key of Object.keys(VENDOR_NAMES)) if (d.includes(key)) return VENDOR_NAMES[key]
  return 'GPU'
}

/** "NVIDIA · ampere"-style label; falls back through architecture → device → description. */
export function gpuLabel(info: GpuAdapterSummary, isFallback: boolean): string {
  const vendor = prettyVendor(info.vendor, info.description)
  const detail = (info.architecture || info.device || info.description || '').trim()
  if (isFallback) return `Software · ${detail || vendor.toLowerCase()}`
  return detail ? `${vendor} · ${detail}` : vendor
}

function readLimits(adapter: GPUAdapter): GpuLimitsSummary {
  const l = adapter.limits
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  return {
    maxBufferSize: num(l.maxBufferSize),
    maxStorageBufferBindingSize: num(l.maxStorageBufferBindingSize),
    maxComputeWorkgroupSizeX: num(l.maxComputeWorkgroupSizeX),
    maxComputeInvocationsPerWorkgroup: num(l.maxComputeInvocationsPerWorkgroup),
    maxComputeWorkgroupStorageSize: num(l.maxComputeWorkgroupStorageSize),
    maxComputeWorkgroupsPerDimension: num(l.maxComputeWorkgroupsPerDimension),
  }
}

/** adapter.info (sync, current spec) with a fallback to the removed requestAdapterInfo(). */
async function readInfo(adapter: GPUAdapter): Promise<{ info: GpuAdapterSummary; isFallback: boolean }> {
  type LegacyAdapter = GPUAdapter & {
    requestAdapterInfo?: () => Promise<Partial<GPUAdapterInfo>>
    isFallbackAdapter?: boolean
  }
  const legacy = adapter as LegacyAdapter
  let raw: Partial<GPUAdapterInfo> | undefined
  try {
    raw = adapter.info
  } catch {
    raw = undefined
  }
  if (!raw && typeof legacy.requestAdapterInfo === 'function') {
    try {
      raw = await legacy.requestAdapterInfo()
    } catch {
      raw = undefined
    }
  }
  const s = (x: unknown) => (typeof x === 'string' ? x : '')
  const info: GpuAdapterSummary = raw
    ? { vendor: s(raw.vendor), architecture: s(raw.architecture), device: s(raw.device), description: s(raw.description) }
    : { ...EMPTY_INFO }
  const isFallback = Boolean(raw?.isFallbackAdapter ?? legacy.isFallbackAdapter ?? false)
  return { info, isFallback }
}

/** High-performance adapter first, then any adapter. Never throws. */
export async function requestBestAdapter(): Promise<GPUAdapter | null> {
  if (!hasNavigator() || !navigator.gpu) return null
  for (const opts of [{ powerPreference: 'high-performance' } as GPURequestAdapterOptions, undefined]) {
    try {
      const a = await navigator.gpu.requestAdapter(opts)
      if (a) return a
    } catch {
      /* try the next option */
    }
  }
  return null
}

function unsupported(reason: string, browser: string, cpu: CpuSummary): GpuDetect {
  return {
    supported: false,
    reason,
    info: { ...EMPTY_INFO },
    features: [],
    limits: { ...EMPTY_LIMITS },
    isFallback: false,
    label: cpu.label,
    cpu,
    browser,
  }
}

/** Probe WebGPU. Always resolves (never rejects). */
export async function detectGpu(): Promise<GpuDetect> {
  const browser = browserFamily()
  const cpu = cpuSummary()
  try {
    if (!hasNavigator()) return unsupported('No browser environment.', browser, cpu)
    if (typeof isSecureContext !== 'undefined' && !isSecureContext) {
      return unsupported('WebGPU needs a secure context — open LUSCA over HTTPS (or on localhost).', browser, cpu)
    }
    if (!navigator.gpu) return unsupported(noWebGpuReason(browser), browser, cpu)

    const adapter = await requestBestAdapter()
    if (!adapter) {
      return unsupported(
        'WebGPU is available but no GPU adapter was granted — hardware acceleration may be off, or the GPU / driver is blocklisted (see chrome://gpu).',
        browser,
        cpu,
      )
    }
    const { info, isFallback } = await readInfo(adapter)
    const features: string[] = []
    try {
      adapter.features.forEach((f) => features.push(f))
    } catch {
      /* ignore */
    }
    features.sort()
    return {
      supported: true,
      adapter,
      info,
      features,
      limits: readLimits(adapter),
      isFallback,
      label: gpuLabel(info, isFallback),
      cpu,
      browser,
    }
  } catch (e) {
    return unsupported(`WebGPU probe failed: ${e instanceof Error ? e.message : String(e)}`, browser, cpu)
  }
}

/** Ask for the adapter's maxima on the limits the neuron kernels care about. */
function wantedLimits(adapter: GPUAdapter): Record<string, number> {
  const l = adapter.limits
  const out: Record<string, number> = {}
  const take = (k: 'maxStorageBufferBindingSize' | 'maxBufferSize' | 'maxComputeWorkgroupStorageSize' | 'maxComputeWorkgroupsPerDimension') => {
    const v = l[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
  }
  take('maxStorageBufferBindingSize')
  take('maxBufferSize')
  take('maxComputeWorkgroupStorageSize')
  take('maxComputeWorkgroupsPerDimension')
  return out
}

async function requestFrom(adapter: GPUAdapter): Promise<GPUDevice> {
  const features: GPUFeatureName[] = []
  if (adapter.features.has('timestamp-query')) features.push('timestamp-query')
  try {
    return await adapter.requestDevice({
      label: 'lusca-neuron',
      requiredFeatures: features,
      requiredLimits: wantedLimits(adapter),
    })
  } catch {
    // Some implementations reject optional limits/features — retry with defaults.
    return await adapter.requestDevice({ label: 'lusca-neuron' })
  }
}

/**
 * Create a GPUDevice for the neuron. Uses the detected adapter when it has not
 * been consumed yet; otherwise (or on failure) requests a fresh adapter. An
 * adapter can only produce one device, so pass `null` after a device loss.
 */
export async function acquireDevice(det?: GpuDetect | null): Promise<GPUDevice> {
  if (!hasNavigator() || !navigator.gpu) throw new Error('WebGPU is not available in this browser')
  let adapter: GPUAdapter | null = det?.adapter ?? null
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!adapter) adapter = await requestBestAdapter()
    if (!adapter) break
    try {
      const dev = await requestFrom(adapter)
      // A consumed adapter may hand back a device that is already lost.
      let lost = false
      dev.lost.then(
        () => {
          lost = true
        },
        () => {
          lost = true
        },
      )
      await new Promise((r) => setTimeout(r, 0))
      if (!lost) return dev
      lastErr = new Error('GPU device was lost immediately after creation')
    } catch (e) {
      lastErr = e
    }
    adapter = null // retry once with a fresh adapter
  }
  if (lastErr instanceof Error) throw lastErr
  throw new Error('Could not create a GPU device')
}
