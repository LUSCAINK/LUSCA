// LUSCA wire protocol — the single contract between server (ingestion agents, trainer,
// neuron coordinator, payouts) and client (observatory, node, model pages).
// Transport: one WebSocket at /ws carrying JSON messages, plus a few REST routes.

import type { PayoutsOverview } from './payouts.ts'
import type { ChainEvent } from './chain.ts'
import type { RadarEvent } from './radar.ts'

/** Lifecycle of one agent ("sucker") as it works a page. */
export type AgentState =
  | 'idle'    // waiting for a frontier slot
  | 'seek'    // choosing the next URL from the frontier
  | 'fetch'   // HTTP GET in flight
  | 'parse'   // extracting text + links
  | 'taste'   // scoring crypto relevance (octopus suckers taste what they touch)
  | 'dedupe'  // simhash near-duplicate check
  | 'store'   // tokenized and appended to the dataset
  | 'reject'  // page dropped (low score / dup / robots / non-html)
  | 'error'   // fetch failed
  | 'sleep';  // politeness backoff

export interface AgentInfo {
  id: number;            // global index 0..N-1
  code: string;          // display id, e.g. "II·07" (sector roman · slot)
  name: string;          // lowercase handle, e.g. "vesper"
  sector: number;        // 0..7 — which of the 8 arms it lives on
  slot: number;          // position along the arm (0 = near the mantle)
  state: AgentState;
  since: number;         // ms epoch when `state` began
  url: string | null;    // current target
  host: string | null;
  title: string | null;
  pages: number;         // accepted pages
  tokens: number;        // tokens contributed
  rejected: number;
  errors: number;
  lastScore: number | null;
  origin: 'genesis' | 'spawned';
  owner: string | null;  // wallet/handle for spawned agents
}

export interface PageRecord {
  id: string;            // stable hash of the normalized url
  url: string;
  host: string;
  title: string;
  sector: number;
  agentId: number;
  depth: number;         // hops from a seed
  score: number;         // crypto relevance 0..1
  tokens: number;        // GPT-style token count of cleaned text
  bytes: number;         // raw html bytes
  links: number;         // outlinks discovered on the page
  simhash: string;       // 64-bit hex
  terms: string[];       // top matched lexicon terms (for highlighting)
  excerpt: string;       // first ~420 chars of cleaned text
  ts: number;
}

/** One step of an agent's reasoning — rendered as a live decision trace. */
export interface Trace {
  agentId: number;
  ts: number;
  step: AgentState;
  msg: string;                       // human sentence, e.g. "tasted 0.91 — strong: zk-rollup, calldata"
  data?: Record<string, string | number | boolean | null>;
}

export interface FrontierPick {
  url: string;
  score: number;         // priority used by the frontier
  why: string;           // short reason, e.g. "anchor 'EIP-4844' · host prior 0.9 · depth 2"
}

export interface DomainInfo {
  host: string;
  sector: number;
  pages: number;
  tokens: number;
  frontier: number;      // queued urls on this host
  avgScore: number;
  firstSeen: number;
  discovered: boolean;   // true if admitted by an agent (not a seed host)
}

export interface SectorInfo {
  id: number;
  pages: number;
  tokens: number;
  frontier: number;
  agents: number;
}

export interface LossPoint {
  step: number;
  loss: number;          // train loss (nats/char)
  val: number | null;    // validation loss
  tokens: number;        // characters predicted so far (steps × batch)
  ts: number;
}

export interface ModelInfo {
  name: string;          // "SEPIA-0"
  params: number;
  arch: string;          // e.g. "char-MLP · ctx 16 · emb 24 · hidden 384"
  vocab: number;
  step: number;
  loss: number;
  val: number | null;
  corpusChars: number;
  stepsPerSec: number;
  /** Weights version: increments on every optimizer step (server CPU step or applied GPU gradient). */
  version: number;
  /** Optimizer steps applied from gradients computed by GPU neurons. */
  gpuSteps: number;
  /** Optimizer steps computed by the server's own CPU trainer. */
  serverSteps: number;
  /** Training samples (sequences) whose gradients came from GPU neurons. */
  gpuSamples: number;
  /** Distinct neuron identities that submitted an accepted gradient in the last 24 h. */
  contributors24h: number;
  /** Full server-side gradient audits of neuron results. */
  audits: { ok: number; failed: number };
  /** GPU gradient steps applied in the last minute. */
  gpuStepsPerMin: number;
}

export interface Stats {
  /** Pages accepted into the corpus, lifetime (includes rotated archives that were since deleted). */
  pages: number;
  /** Tokens of those pages, lifetime. */
  tokens: number;
  /** Pages held on disk now: dataset.jsonl + kept archives (absent on older servers). */
  heldPages?: number;
  heldTokens?: number;
  heldBytes?: number;
  /** Bytes of dataset.jsonl + the counted archives (what heldPages / heldTokens describe). */
  /** Kept archive files whose totals were never recorded (not in heldPages / heldTokens / heldBytes). */
  heldUncounted?: number;
  /** Bytes of those uncounted archive files. */
  heldUncountedBytes?: number;
  bytes: number;
  domains: number;
  frontier: number;
  rejected: number;
  dupes: number;
  errors: number;
  agentsActive: number;
  agentsTotal: number;
  pagesPerMin: number;
  tokensPerMin: number;
  uptime: number;        // seconds
  neurons: number;       // connected GPU nodes
  gflops: number;        // summed benchmarked GFLOPS of connected neurons
  jobsDone: number;
  jobsVerified: number;
  inkIssued: number;     // total credits issued
}

/** GPU neuron (a browser or desktop node contributing compute). */
export type Zone = 'EPI' | 'MESO' | 'BATHY' | 'ABYSSO' | 'HADAL';

export interface NeuronInfo {
  id: string;
  label: string;         // e.g. "NVIDIA · ampere"
  zone: Zone;
  gflops: number;
  jobs: number;
  verified: number;
  failed: number;
  ink: number;
  wallet: string | null;
  connectedAt: number;
  kind: 'browser' | 'desktop';
}

/**
 * Semantic dedupe job: cosine similarity between `rows` new page vectors and a
 * corpus block of `cols` vectors (hashed bag-of-words, L2 normalized, `dim` dims).
 * Neuron returns, per row, the best match index + similarity.
 */
export interface SimJob {
  id: string;
  kind: 'simmatrix';
  dim: number;
  rows: number;
  cols: number;
  a: string;             // base64 Float32Array rows*dim (row-major)
  b: string;             // base64 Float32Array cols*dim (row-major)
  rowIds: string[];      // page ids for rows
  colIds: string[];      // page ids for cols
  flops: number;         // 2*rows*cols*dim
  issuedAt: number;
}

export interface SimResult {
  id: string;
  best: number[];        // per row: index into cols
  sim: number[];         // per row: cosine similarity
  ms: number;            // kernel wall time
}

/**
 * SEPIA training job: compute d(mean cross-entropy)/d(params) of SEPIA at weights `version`
 * on the server-chosen batch (x: B×ctx context bytes, y: B next-char targets), using
 * shared/sepia lossAndGrad. Weights are sent as base64 f16 (shared/sepia f32ToF16) only when
 * the neuron does not already hold `version` (job.request caps.version).
 */
export interface TrainJob {
  id: string;
  kind: 'train';
  version: number;
  weights: string | null; // base64 f16 params for `version`; null = the client already holds that version
  batch: number;          // B
  ctx: number;
  x: string;              // base64 Uint8Array B*ctx
  y: string;              // base64 Uint8Array B
  flops: number;          // trainFlops(B)
  issuedAt: number;
}

export interface TrainResult {
  id: string;
  kind: 'train';
  grad: string;           // base64 of shared/sepia encodeGrad(grad)
  loss: number;           // mean cross-entropy of the batch at `version`
  ms: number;             // compute wall time
}

export interface InkEvent {
  neuronId: string;
  jobId: string;
  ink: number;
  verified: boolean;     // spot-check passed
  reason: string;
  ts: number;
  /** Job type ('sim' when absent). */
  kind?: 'sim' | 'train';
  /**
   * 'confirmed' = in the ledger (dedupe jobs, and train credits after a passed full audit);
   * 'pending' = train credits held in escrow until the identity's next passed full audit;
   * 'forfeited' = escrowed credits cancelled by a failed audit. Absent = 'confirmed'.
   */
  status?: 'confirmed' | 'pending' | 'forfeited';
}

/** The caller's own ledger account (credits; JSON fields keep the legacy `ink` names). */
export interface AccountView {
  kind: 'wallet' | 'device';
  wallet: string | null;     // verified wallet for kind 'wallet', else null
  ink: number;               // confirmed credits, all-time (rounded to 2 dp)
  pendingInk: number;        // training credits in escrow awaiting a full audit (0 if none)
  periodInk: number;         // confirmed credits in the current payout period (0 if none)
  jobs: number;
  verified: number;
  failed: number;
  flops: number;
  firstSeen: number;
  lastSeen: number;
}

export interface Hello {
  t: 'hello';
  /** Always 'live': every number comes from the running server. */
  mode: 'live';
  serverTime: number;
  agents: AgentInfo[];
  stats: Stats;
  sectors: SectorInfo[];
  domains: DomainInfo[];
  recent: PageRecord[];          // newest first, up to 60
  traces: Trace[];               // newest first, up to 120
  loss: LossPoint[];             // full (downsampled) history
  model: ModelInfo;
  samples: { step: number; text: string }[];
  neurons: NeuronInfo[];
}

export type ServerMsg =
  | Hello
  | { t: 'agent'; agent: AgentInfo }
  | { t: 'trace'; trace: Trace }
  | { t: 'page'; page: PageRecord }
  | { t: 'reject'; agentId: number; url: string; host: string; reason: string; score: number | null; ts: number }
  | { t: 'discover'; agentId: number; from: string; picks: FrontierPick[]; total: number; ts: number }
  | { t: 'domain'; domain: DomainInfo }
  | { t: 'stats'; stats: Stats; sectors: SectorInfo[] }
  | { t: 'loss'; point: LossPoint; model: ModelInfo }
  | { t: 'sample'; step: number; text: string }
  | { t: 'neurons'; neurons: NeuronInfo[] }
  | { t: 'job'; job: SimJob | TrainJob }            // sent only to the neuron it is assigned to (discriminate on job.kind)
  | { t: 'ink'; event: InkEvent }                   // broadcast
  // reply to register; `auth`: 'verified' = credits go to neuron.wallet, 'invalid' = the token was
  // rejected (expired / tampered) and credits stay on the device account, 'none' = no token sent
  | { t: 'neuron.ok'; neuron: NeuronInfo; auth?: 'verified' | 'invalid' | 'none' }
  | { t: 'payout'; overview: PayoutsOverview }      // broadcast when a payout period closes or a payout tx confirms
  // reply to account.watch (sent only to the watching connection), then again whenever the watched
  // account or its escrow changes (coalesced, ≤ 1/s). scope null = no wallet token and no valid device
  // id; account null = no ledger account yet (0 credits). `device`: wallet scope only, when the watch
  // also named a valid device id: that device's own account (credits earned there before the wallet
  // was verified, which stay on it), null = none; absent otherwise
  | { t: 'account'; scope: 'wallet' | 'device' | null; account: AccountView | null; at: number; device?: AccountView | null }
  // one read by a chain agent (shared/chain.ts), broadcast, throttled ≤ 4/s
  | { t: 'chain'; event: ChainEvent }
  // a code change caught by the upgrade radar (shared/radar.ts); an update re-sends the same id
  | { t: 'radar'; event: RadarEvent }
  | { t: 'error'; msg: string };

export type ClientMsg =
  // `auth`: session token from POST /api/auth/verify. Only a valid token links credits to a wallet
  // (NeuronInfo.wallet); a bare `wallet` field is ignored for payouts.
  | { t: 'neuron.register'; label: string; zone: Zone; gflops: number; kind: 'browser' | 'desktop'; wallet: string | null; adapter: Record<string, string>; auth?: string | null }
  // caps.train: the neuron can compute SEPIA gradients; caps.version: weights version it holds (null = none);
  // caps.cpu: gradients run on the CPU path (the server then sends the CPU batch size)
  | { t: 'job.request'; caps?: { train?: boolean; version?: number | null; cpu?: boolean } }
  | { t: 'job.result'; result: SimResult }
  | { t: 'train.result'; result: TrainResult }
  | { t: 'neuron.leave' }
  // Follow the caller's own ledger account (any connection, no register needed). Scope resolves like
  // neuron.register: a valid session token (`auth`) → wallet:<w>, else `device` → device:<id>. One
  // watch per connection; a new watch replaces the previous one.
  | { t: 'account.watch'; device: string | null; auth?: string | null }
  // The /scan page: on = chain events on this connection carry their call trace and decoded fields
  // (ChainEvent.trace / .scan); every other connection gets the lean event. Send again after a reconnect.
  | { t: 'chain.scan'; on: boolean }
  | { t: 'ping' };

// REST
// GET  /api/hello                 -> Hello (same payload as the ws greeting)
// GET  /api/agents/:id/traces     -> Trace[] (newest first, up to 200)
// GET  /api/pages?sector=&q=      -> PageRecord[] (newest first, up to 200)
// POST /api/generate {prompt, n}  -> { text: string, ms: number }   (sample from SEPIA)
// POST /api/spawn {name, owner, sector} -> AgentInfo                (adds an agent to an arm)
// POST /api/auth/link-device {token, deviceId} -> { wallet, ink }   (move the device's current-period credits to the verified wallet)

/**
 * GPU depth zones. A zone sets (a) the job size the coordinator issues — 4× the FLOPs per
 * zone step — and (b) the credit bonus per verified GFLOP: 1 + 0.15 · zone index.
 * Credits per job = GFLOP × 10 × bonus (server/neurons/coordinator.ts).
 */
export const ZONES: { zone: Zone; name: string; depth: string; minGflops: number; vram: string; bonus: number; job: string; jobScale: number }[] = [
  { zone: 'EPI',    name: 'Epipelagic',    depth: '0–200 m',        minGflops: 0,    vram: 'integrated / ≤6 GB', bonus: 1.0,  job: '16×512',   jobScale: 1 },
  { zone: 'MESO',   name: 'Mesopelagic',   depth: '200–1,000 m',    minGflops: 400,  vram: '8 GB',              bonus: 1.15, job: '32×1024',  jobScale: 4 },
  { zone: 'BATHY',  name: 'Bathypelagic',  depth: '1,000–4,000 m',  minGflops: 1500, vram: '12–16 GB',          bonus: 1.3,  job: '64×2048',  jobScale: 16 },
  { zone: 'ABYSSO', name: 'Abyssopelagic', depth: '4,000–6,000 m',  minGflops: 4000, vram: '24 GB',             bonus: 1.45, job: '128×4096', jobScale: 64 },
  { zone: 'HADAL',  name: 'Hadal',         depth: '6,000–11,000 m', minGflops: 9000, vram: '48 GB+',            bonus: 1.6,  job: '256×8192', jobScale: 256 },
];

export function zoneFor(gflops: number): Zone {
  let z: Zone = 'EPI';
  for (const t of ZONES) if (gflops >= t.minGflops) z = t.zone;
  return z;
}
