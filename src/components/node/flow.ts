// The one-button "Start earning" flow shared by every control on the Node page:
// detect → benchmark → tier → start verified jobs. Also derives one plain
// phase (not started / starting / earning / waiting / paused / stopped / error)
// from the neuron store and the server connection so every panel says the same thing.
import { create } from 'zustand'
import { useNeuron } from '@/lib/gpu'
import { useLive } from '@/lib/store'

interface FlowState {
  /** true while startEarning() is walking the four steps */
  auto: boolean
  /** step startEarning() is on: 1 detect · 2 benchmark · 3 tier · 4 start jobs (0 = not running) */
  step: number
}

export const useFlow = create<FlowState>(() => ({ auto: false, step: 0 }))

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

/** Run every step that is still missing, then start verified jobs. Safe to call twice. */
export async function startEarning(): Promise<void> {
  if (useFlow.getState().auto) return
  const n = useNeuron.getState()
  if (n.status === 'running' || n.status === 'paused') return
  useFlow.setState({ auto: true, step: 1 })
  try {
    if (!n.bench) {
      if (!n.detect) await n.runDetect()
      useFlow.setState({ step: 2 })
      const b = await useNeuron.getState().benchmark()
      if (!b) return
      // let the tier land on screen before jobs start
      useFlow.setState({ step: 3 })
      await wait(1400)
    }
    useFlow.setState({ step: 4 })
    await useNeuron.getState().start()
  } finally {
    useFlow.setState({ auto: false, step: 0 })
  }
}

export type Phase = 'idle' | 'starting' | 'earning' | 'waiting' | 'paused' | 'stopped' | 'error'

export const PHASE_TEXT: Record<Phase, string> = {
  idle: 'not started',
  starting: 'starting',
  earning: 'earning',
  waiting: 'waiting for server',
  paused: 'paused',
  stopped: 'stopped',
  error: 'error',
}

export const STEP_NAMES = ['Detect your GPU', '10-second benchmark', 'Get your tier', 'Start verified jobs'] as const

/** One plain phase for the whole page, plus the step (1–4) while starting. */
export function usePhase(): { phase: Phase; step: number } {
  const status = useNeuron((s) => s.status)
  const jobs = useNeuron((s) => s.jobs)
  const auto = useFlow((s) => s.auto)
  const autoStep = useFlow((s) => s.step)
  const live = useLive((s) => s.conn === 'live')
  if (status === 'running') return { phase: live ? 'earning' : 'waiting', step: 4 }
  if (status === 'paused') return { phase: 'paused', step: 4 }
  if (auto) return { phase: 'starting', step: status === 'benchmarking' ? 2 : autoStep || 1 }
  if (status === 'detecting') return { phase: 'starting', step: 1 }
  if (status === 'benchmarking') return { phase: 'starting', step: 2 }
  if (status === 'error') return { phase: 'error', step: 0 }
  if (jobs > 0) return { phase: 'stopped', step: 0 }
  return { phase: 'idle', step: 0 }
}

/** Connection to the LUSCA server, in the three states the UI names. */
export type ServerState = 'live' | 'connecting' | 'unreachable'

export function serverState(conn: string): ServerState {
  if (conn === 'live') return 'live'
  if (conn === 'connecting') return 'connecting'
  return 'unreachable'
}

export const UNREACHABLE_TEXT = "Can't reach the LUSCA server — reconnecting…"
