// Optional sonar: tiny synthesized sounds for live events. Off by default.
// page swallowed → soft ping · rejected → dry click · new host → two-tone chirp.
import { create } from 'zustand'
import { bus } from './bus'

interface SonarState {
  on: boolean
  toggle: () => void
}

let ctx: AudioContext | null = null
let master: GainNode | null = null
let unsub: (() => void)[] = []
let budget = 0
let lastRefill = 0

function ensure(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext()
      master = ctx.createGain()
      master.gain.value = 0.18
      master.connect(ctx.destination)
    } catch {
      return null
    }
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function allow(): boolean {
  const now = performance.now()
  budget = Math.min(6, budget + ((now - lastRefill) / 1000) * 5)
  lastRefill = now
  if (budget < 1) return false
  budget -= 1
  return true
}

function tone(freq: number, to: number, dur: number, type: OscillatorType, gain: number, delay = 0) {
  const c = ensure()
  if (!c || !master) return
  const t0 = c.currentTime + delay
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, t0)
  o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  o.connect(g).connect(master)
  o.start(t0)
  o.stop(t0 + dur + 0.02)
}

function click() {
  const c = ensure()
  if (!c || !master) return
  const len = Math.floor(c.sampleRate * 0.03)
  const buf = c.createBuffer(1, len, c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3)
  const src = c.createBufferSource()
  const f = c.createBiquadFilter()
  const g = c.createGain()
  f.type = 'highpass'
  f.frequency.value = 2400
  g.gain.value = 0.25
  src.buffer = buf
  src.connect(f).connect(g).connect(master)
  src.start()
}

function attach() {
  const seen = new Set<string>()
  unsub = [
    bus.on('page', (m) => {
      if (!allow()) return
      const base = 520 + (m.page.sector % 8) * 60
      tone(base * 1.6, base, 0.32, 'sine', 0.5)
    }),
    bus.on('reject', () => {
      if (allow()) click()
    }),
    bus.on('domain', (m) => {
      if (!m.domain.discovered || seen.has(m.domain.host)) return
      seen.add(m.domain.host)
      tone(660, 660, 0.12, 'triangle', 0.35)
      tone(990, 990, 0.18, 'triangle', 0.35, 0.11)
    }),
    bus.on('ink', (m) => {
      if (m.event.verified && allow()) tone(1320, 1760, 0.08, 'square', 0.08)
    }),
  ]
}

function detach() {
  unsub.forEach((f) => f())
  unsub = []
}

export const useSonar = create<SonarState>((set, get) => ({
  on: false,
  toggle: () => {
    const on = !get().on
    if (on) {
      ensure()
      attach()
      tone(440, 880, 0.18, 'sine', 0.4)
    } else detach()
    set({ on })
  },
}))
