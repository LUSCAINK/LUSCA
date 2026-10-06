// Event contract between the desktop neuron (scripts/neuron.ts) and its terminal front-ends:
// the live dashboard (./index.ts, mode 'tui') and the plain log (./log.ts, mode 'log').
// neuron.ts emits every user-visible fact as one of these events; a front-end only renders them.
// Every number here comes from a real measurement or a server event — nothing is synthesized.
// Earnings are "credits" (the user's share of the SOL payout pool), never "INK".

export type NeuronEvent =
  | { t: 'boot'; build: string; cpu: string; threads: number; os: string; server: string; label: string }
  | { t: 'bench'; phase: 'start' | 'done'; gflops?: number; zone?: string; bonus?: number }
  | { t: 'selftest'; batch: number; ms: number; gflops: number; codecCos: number }
  | { t: 'wallet'; state: 'none' | 'signing' | 'verified' | 'token' | 'failed'; address?: string; until?: number; reason?: string }
  | { t: 'conn'; state: 'connecting' | 'connected' | 'registered' | 'reconnecting' | 'closed'; server: string; neuronId?: string; zone?: string; gflops?: number; linked?: boolean }
  | { t: 'network'; rank?: number; neurons: number; poolGflops: number }
  | { t: 'job'; id: string; kind: 'train' | 'sim'; version?: number; batch?: number; flops: number }
  | { t: 'computed'; id: string; kind: 'train' | 'sim'; ms: number; gflops: number; loss?: number }
  | { t: 'verdict'; id: string; kind: 'train' | 'sim'; status: 'verified' | 'audited' | 'rejected' | 'stale' | 'failed'; credits: number; pending: boolean; reason?: string }
  // One server ledger event (amounts as the server sent them): escrow released by a full audit, or
  // forfeited by a failed one. Feed lines only — totals come from the 'account' event.
  | { t: 'escrow'; released: number; forfeited?: number }
  // This session's verdict counts (jobs computed and sent · verdicts passed · verdicts failed).
  | { t: 'totals'; jobs: number; verified: number; failed: number }
  // The server's ledger account for this neuron's identity (reply to account.watch, pushed again
  // whenever it changes): confirmed = all-time confirmed credits, pending = credits in escrow,
  // session = confirmed gained since the first reply of this run. The only source of credit totals:
  // until the first one arrives, front-ends show "—". scope null = the server resolved no identity.
  | { t: 'account'; confirmed: number; pending: number; session: number; scope: 'wallet' | 'device' | null }
  | { t: 'notice'; level: 'info' | 'warn' | 'error'; msg: string }

export interface NeuronUI {
  emit(e: NeuronEvent): void
  stop(summary?: string): Promise<void>
}
