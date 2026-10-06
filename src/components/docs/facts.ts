// Every number the manual quotes, transcribed from the implementation.
// Change a constant in the code → change it here. The source file is named on
// each block so a reviewer can diff the two in one sitting.
import type { Zone } from '@shared/protocol'
import { ZONES } from '@shared/protocol'

/** server/ingest/util.ts — USER_AGENT / ROBOTS_UA (default: no LUSCA_BOT_URL / LUSCA_BOT_CONTACT set) */
export const USER_AGENT = 'LuscaBot/0.1 (+https://lusca.ink/docs/ethics; data agent; respects robots.txt)'
export const ROBOTS_TOKEN = 'LuscaBot'

export const CRAWL = {
  // server/ingest/robots.ts
  robotsTtlMin: 60,
  robotsPauseMin: 10,
  robotsTimeoutS: 10,
  robotsMaxKB: 512,
  // server/ingest/hosts.ts
  minIntervalMs: 2000,
  errorsBeforeBackoff: 3,
  errorBackoffMin: 5,
  // server/ingest/fetcher.ts
  pageTimeoutS: 12,
  maxBodyMB: 2,
  // server/ingest/pipeline.ts
  maxRedirects: 5,
  redirectWaitS: 4,
  retryAfterMinS: 60,
  retryAfterMaxMin: 30,
  acceptScore: 0.35,
  minTokens: 80,
  minWords: 20,
  maxTextChars: 60_000,
  nearDupHamming: 3,
  maxLinksPerPage: 60,
  newHostMinPriority: 0.55,
  knownHostMinPriority: 0.15,
  maxAdmittedHosts: 250,
  admitBurst: 12,
  admitRefillS: 15,
  maxNewHostsPerPage: 3,
  maxDepth: 12,
  memoryPages: 20_000,
  reseedMin: 20,
  maxAgents: 64,
  defaultAgents: 24,
  // server/ingest/frontier.ts
  perHostCap: 400,
  globalCap: 60_000,
  // server/ingest/lexicon.ts (LEXICON_SIZE at runtime; singular + plural keys)
  lexiconEntries: 926,
} as const

/** GPU training jobs — shared/sepia (trainFlops), server/trainer, server/neurons/coordinator.ts.
 *  Batch per zone and the audit policy are the fixed protocol contract. */
export const TRAIN = {
  batch: { EPI: 256, MESO: 512, BATHY: 1024, ABYSSO: 2048, HADAL: 4096 } as Record<Zone, number>,
  cpuBatch: 128,
  firstAudits: 3,
  auditP: 0.2,
  maxStale: 64,
  auditCosine: 0.99,
} as const

/** shared/sepia trainFlops(B): 6 · B · (ctx·emb·hidden + hidden·vocab), forward + backward. */
export const trainFlops = (B: number) => 6 * B * (16 * 24 * 384 + 384 * 96)
/** INK for one verified training job in a zone — same inkFor() as dedupe jobs. */
export const trainInk = (zone: Zone) => {
  const i = ZONES.findIndex((z) => z.zone === zone)
  return Math.max(0.01, Math.round((trainFlops(TRAIN.batch[zone]) / 1e8) * (1 + 0.15 * i) * 100) / 100)
}

/** server/trainer/model.mjs + worker.mjs + trainer.ts */
export const MODEL = {
  name: 'SEPIA-0',
  vocab: 96,
  ctx: 16,
  emb: 24,
  hidden: 384,
  params: 187_104,
  pEmb: 96 * 24,
  pW1: 16 * 24 * 384,
  pB1: 384,
  pW2: 384 * 96,
  pB2: 96,
  batch: 64,
  lrMax: 3e-3,
  lrMin: 3e-4,
  warmup: 200,
  decay: 30_000,
  beta1: 0.9,
  beta2: 0.99,
  eps: 1e-8,
  clip: 1.0,
  lossEvery: 25,
  valEvery: 250,
  valBatches: 16,
  sampleEvery: 600,
  sampleLen: 260,
  sampleTemp: 0.8,
  minChars: 20_000,
  maxChars: 24_000_000,
  minDocChars: 48,
  holdoutEvery: 20,
  duty: 0.85,
  chunkMs: 40,
  ckptEveryS: 90,
  stepBlock: 256, // server/trainer/progressFloor.ts STEP_BLOCK
  reloadTailMB: 64,
} as const

/** server/neurons/coordinator.ts */
export const NEURON = {
  jobRows: { EPI: 16, MESO: 32, BATHY: 64, ABYSSO: 128, HADAL: 256 } as Record<Zone, number>,
  jobCols: { EPI: 512, MESO: 1024, BATHY: 2048, ABYSSO: 4096, HADAL: 8192 } as Record<Zone, number>,
  simTolerance: 2e-3,
  spotRows: 4,
  dupThreshold: 0.92,
  minJobGapMs: 120,
  jobTimeoutS: 20,
  maxConsecFails: 3,
  kickCooldownS: 30,
  gflopsMin: 1,
  gflopsMax: 200_000,
  ledgerSaveS: 30,
  maxNeurons: 1024,
}

/** server/http.ts */
export const HUB = {
  bodyLimitKB: 16,
  wsMaxPayloadMB: 1,
  softBufferMB: 4,
  hardBufferMB: 64,
  heartbeatS: 30,
  statsMs: 1000,
  maxClients: 4000,
  maxClientsPerIp: 64,
  msgRate: 30,
  msgBurst: 90,
  generatePerMin: 30,
  generateConcurrency: 2,
  generateTimeoutS: 20,
  spawnEveryS: 10,
}

/** INK for a verified job — mirrors coordinator.ts inkFor(). */
export function inkFor(flops: number, zoneIdx: number): number {
  return Math.max(0.01, Math.round((flops / 1e8) * (1 + 0.15 * zoneIdx) * 100) / 100)
}

/** Full-size job for a zone: rows × cols × 256-dim cosine block. */
export function zoneJob(zone: Zone, dim = 256) {
  const rows = NEURON.jobRows[zone]
  const cols = NEURON.jobCols[zone]
  const flops = 2 * rows * cols * dim
  const zi = Math.max(0, ZONES.findIndex((z) => z.zone === zone))
  return { rows, cols, flops, ink: inkFor(flops, zi), zi }
}

/** Minimum effective weighted hits / 1000 words for a page to clear the taste threshold at a given host prior. */
export function minRateFor(prior: number, accept: number = CRAWL.acceptScore): number {
  const need = (accept - 0.25 * prior) / 0.75
  if (need <= 0) return 0
  return -9 * Math.log(1 - need)
}
