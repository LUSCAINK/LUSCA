// Internal contracts between server modules. Each module is built independently
// against these interfaces; server/index.ts wires them together.
import type {
  AgentInfo,
  DomainInfo,
  LossPoint,
  ModelInfo,
  NeuronInfo,
  PageRecord,
  SectorInfo,
  ServerMsg,
  SimJob,
  SimResult,
  Stats,
  TrainJob,
  Trace,
  ClientMsg,
} from '../shared/protocol.ts'

export type Emit = (msg: ServerMsg) => void

/** Spawned agents retire after this long (the hub's per-IP live-spawn limit uses the same window). */
export const SPAWN_TTL_MS = 3 * 60 * 60_000

/** Error codes CrawlerApi.spawn() attaches as `err.code`. */
export type SpawnErrorCode = 'name-taken' | 'cap'

/** server/ingest/pipeline.ts — `export function createIngest(opts): CrawlerApi` */
export interface CrawlerOptions {
  agents: number;             // genesis agent count (default 24 → 3 per arm)
  dataDir: string;            // where dataset.jsonl lives (server/data)
  pace: number;               // visual pacing multiplier for per-step min dwell (1 = default, 0 = none)
  emit: Emit;                 // broadcast to all clients: agent, trace, page, reject, discover, domain
  onText: (text: string, page: PageRecord) => void; // cleaned text of every ACCEPTED page → trainer
}

export interface CrawlerApi {
  start(): void;
  stop(): Promise<void>;
  agents(): AgentInfo[];
  /** Stats fields owned by the crawler (index.ts merges neuron/model fields). */
  stats(): Pick<Stats, 'pages' | 'tokens' | 'bytes' | 'domains' | 'frontier' | 'rejected' | 'dupes' | 'errors' | 'agentsActive' | 'agentsTotal' | 'pagesPerMin' | 'tokensPerMin' | 'uptime' | 'heldPages' | 'heldTokens' | 'heldBytes' | 'heldUncounted'>;
  sectors(): SectorInfo[];
  domains(): DomainInfo[];
  recent(n: number): PageRecord[];           // newest first
  traces(n: number): Trace[];                // newest first, global
  agentTraces(id: number, n: number): Trace[];
  searchPages(q: string, sector: number | null, n: number): PageRecord[];
  spawn(name: string, owner: string | null, sector: number): AgentInfo;
  /** Page vectors for neuron jobs (shared/vectorize.ts, VEC_DIM=256). */
  vectorCount(): number;
  /** Returns up to n [pageId, vector] pairs starting at `offset` (wraps around). */
  vectors(offset: number, n: number): { ids: string[]; vecs: Float32Array[] };
  /**
   * Newest page vectors (rows of a job), NEWEST FIRST: entry k is the page at
   * corpus index vectorCount()-1-k (the coordinator's coverage tracking relies on it).
   */
  newestVectors(n: number): { ids: string[]; vecs: Float32Array[] };
  /** Called by the coordinator when GPU neurons find a semantic near-duplicate. */
  markSemanticDup(pageId: string, dupOfId: string, sim: number): void;
}

/** server/trainer/trainer.ts — `export function createTrainer(opts): TrainerApi` */
export interface TrainerOptions {
  dataDir: string;            // checkpoint lives at <dataDir>/sepia.ckpt (binary)
  emit: Emit;                 // loss + sample messages
}

export interface TrainerApi {
  start(): void;
  stop(): Promise<void>;
  feed(text: string): void;   // append cleaned page text to the training corpus
  info(): ModelInfo;
  lossHistory(): LossPoint[]; // downsampled to <= 1000 points
  samples(): { step: number; text: string }[]; // newest first, <= 20
  generate(prompt: string, n: number, temperature: number): Promise<{ text: string; ms: number }>;
  /** Issue a SEPIA gradient job for a neuron (batch per its tier). null when the corpus is too small / training is paused. */
  issueTrainJob(req: { neuronKey: string; batch: number; haveVersion: number | null }): Promise<TrainJob | null>;
  /**
   * Check (and, when audited, fully recompute) a neuron's gradient, then apply it with the server's optimizer.
   * 'applied' = cheap checks passed, no full audit; 'audited' = full audit passed (and applied);
   * 'audit-failed' = full audit failed; 'rejected' = cheap checks failed; 'stale' = base too old to apply
   * (`audited` tells whether it was fully verified). `flops` = verified work of the job.
   */
  submitTrainResult(req: { neuronKey: string; jobId: string; grad: Uint8Array; loss: number; forceAudit: boolean }): Promise<{ verdict: 'applied' | 'audited' | 'audit-failed' | 'rejected' | 'stale'; reason: string; flops: number; audited: boolean }>;
  trainStats(): TrainStats;
}

/** Training-network counters (merged into ModelInfo). */
export interface TrainStats {
  version: number;
  gpuSteps: number;
  serverSteps: number;
  gpuSamples: number;
  contributors24h: number;
  audits: { ok: number; failed: number };
  gpuStepsPerMin: number;
}

/** server/neurons/coordinator.ts — `export function createCoordinator(opts): CoordinatorApi` */
export interface CoordinatorOptions {
  crawler: Pick<CrawlerApi, 'vectorCount' | 'vectors' | 'newestVectors' | 'markSemanticDup'>;
  emit: Emit;                 // broadcast: neurons, ink
  /** SEPIA gradient jobs (optional: without it neurons only get dedupe jobs). */
  trainer?: Pick<TrainerApi, 'issueTrainJob' | 'submitTrainResult' | 'trainStats'>;
}

/** Opaque per-connection handle; index.ts creates one per websocket. */
export interface NeuronConn {
  id: string;
  send: (msg: ServerMsg) => void;
  /** Remote client IP (normalized; IPv6 to its /64) — strikes, cooldowns and per-IP caps key on it. */
  ip?: string;
  /** Bytes queued on the socket but not yet written (jobs are not issued while it is backed up). */
  buffered?: () => number;
  /** Close the underlying socket (used when a neuron is kicked). */
  close?: (code: number, reason: string) => void;
}

export interface CoordinatorApi {
  handle(conn: NeuronConn, msg: ClientMsg): void;   // neuron.register / job.request / job.result / train.result / neuron.leave / account.watch
  disconnect(conn: NeuronConn): void;               // every closed socket (also drops its account watch)
  neurons(): NeuronInfo[];
  stats(): Pick<Stats, 'neurons' | 'gflops' | 'jobsDone' | 'jobsVerified' | 'inkIssued'>;
}

/** One verified wallet's INK in the current payout period. */
export interface PeriodSnapshotRow {
  wallet: string;
  ink: number;
}

/**
 * What the payout engine (server/payouts) needs from the INK ledger (server/neurons/coordinator.ts).
 * Period INK is INK earned since the last closed period, plus carry-over from it.
 */
export interface PayoutLedger {
  /** Current-period INK of every verified wallet holding some (largest first). */
  periodSnapshot(): PeriodSnapshotRow[];
  /**
   * Close a period atomically (one synchronous call): snapshot → `plan(snapshot)` → reset every
   * account's period INK, add `carry` (wallet → INK) back, record the period as closed, save the
   * ledger synchronously. `plan` must persist the period plan before it returns; if it throws,
   * nothing changes. Returns the snapshot.
   */
  closePeriod(periodId: string, endsAt: number, plan: (snapshot: PeriodSnapshotRow[]) => Record<string, number>): PeriodSnapshotRow[];
  /**
   * Restart recovery: the plan of `periodId` is on disk but the ledger reset was not saved.
   * Subtracts the planned INK and adds the carry. No-op (false) when the ledger already has it.
   */
  reconcileClose(periodId: string, endsAt: number, snapshot: PeriodSnapshotRow[], carry: Record<string, number>): boolean;
  /** Add INK back to a wallet's current period (a payout that failed on-chain). Saved synchronously. */
  carryBack(wallet: string, ink: number): void;
  /** Last period whose reset is applied to the ledger. */
  lastClosed(): { id: string; endsAt: number } | null;
  /** Lifetime INK credited to a wallet. */
  lifetimeInk(wallet: string): number;
  /** Current-period INK of a verified wallet (0 otherwise). */
  periodInk(wallet: string): number;
  /** The wallet proved ownership (signed message) and holds a ledger account. */
  isVerified(wallet: string): boolean;
}

export type { SimJob, SimResult, TrainJob }
