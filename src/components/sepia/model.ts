// SEPIA-0 facts + small helpers shared by the Sepia page components.
// Hyper-parameters mirror server/trainer (model.mjs + worker.mjs); dims are
// re-read from the live ModelInfo.arch string whenever the server sends one.
import type { LossPoint, ModelInfo } from '@shared/protocol'
import { fmtAgo, fmtCompact } from '@/lib/format'

export const VOCAB_SIZE = 96
/** Loss of a uniform guess over the 96-symbol vocabulary, in nats. */
export const LN_VOCAB = Math.log(VOCAB_SIZE)
export const MIN_CORPUS = 20_000
export const CORPUS_CAP = 24_000_000

export const HP = {
  batch: 64,
  lrMax: 3e-3,
  lrMin: 3e-4,
  warmup: 200,
  decay: 30_000,
  clip: 1.0,
  beta1: 0.9,
  beta2: 0.99,
  lossEvery: 25,
  valEvery: 250,
  valBatches: 16,
  sampleEvery: 600,
  sampleLen: 260,
  sampleTemp: 0.8,
  holdoutEvery: 20,
  duty: 0.85,
  ckptSec: 90,
}

/** The 96 symbols: newline, then printable ASCII 32..126. */
export const VOCAB = '\n' + Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')

/** Prompts the trainer seeds its periodic samples with (worker.mjs). */
export const SAMPLE_PROMPTS = [
  'The validator ', 'EIP-', 'Proposal: ', 'The bridge ', 'Liquidity ', 'Bitcoin ', 'zk', 'The DAO ',
  'Ethereum ', 'The protocol ', 'Staking ', 'A rollup ',
]

export interface Dims {
  ctx: number
  emb: number
  hidden: number
  vocab: number
}

export function dimsOf(model: ModelInfo): Dims {
  const grab = (k: string, d: number) => {
    const m = new RegExp(`${k}\\s+(\\d+)`).exec(model.arch)
    return m ? Number(m[1]) : d
  }
  return { ctx: grab('ctx', 16), emb: grab('emb', 24), hidden: grab('hidden', 384), vocab: model.vocab || VOCAB_SIZE }
}

export function layerParams(d: Dims) {
  const emb = d.vocab * d.emb
  const w1 = d.ctx * d.emb * d.hidden
  const b1 = d.hidden
  const w2 = d.hidden * d.vocab
  const b2 = d.vocab
  return { emb, w1, b1, w2, b2, total: emb + w1 + b1 + w2 + b2 }
}

/** Learning rate at `step` (linear warmup, cosine decay, then hold). */
export function lrAt(step: number): number {
  if (step < HP.warmup) return (HP.lrMax * (step + 1)) / HP.warmup
  const p = (step - HP.warmup) / HP.decay
  if (p >= 1) return HP.lrMin
  return HP.lrMin + 0.5 * (HP.lrMax - HP.lrMin) * (1 + Math.cos(Math.PI * p))
}

/** Index of the last point with step <= `step` (-1 if none). `pts` sorted by step. */
export function idxAtOrBefore(pts: LossPoint[], step: number): number {
  let lo = 0
  let hi = pts.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pts[mid].step <= step) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/** Index of the point whose step is nearest `step`. */
export function idxNearest(pts: LossPoint[], step: number): number {
  if (!pts.length) return -1
  const i = idxAtOrBefore(pts, step)
  if (i < 0) return 0
  if (i >= pts.length - 1) return pts.length - 1
  return step - pts[i].step <= pts[i + 1].step - step ? i : i + 1
}

/** Most recent validation reading at or before `step`. */
export function valAtOrBefore(pts: LossPoint[], step: number, from = idxAtOrBefore(pts, step)): LossPoint | null {
  for (let i = from; i >= 0; i--) if (pts[i].val !== null) return pts[i]
  return null
}

/** Split a generation into the prompt it was seeded with and the model's continuation. */
export function splitPrompt(text: string, prompt?: string): { prompt: string; cont: string } {
  if (prompt !== undefined && text.startsWith(prompt)) return { prompt, cont: text.slice(prompt.length) }
  if (prompt === undefined) {
    for (const p of SAMPLE_PROMPTS) if (text.startsWith(p)) return { prompt: p, cont: text.slice(p.length) }
  }
  return { prompt: '', cont: text }
}

/** Words SEPIA gets credit for spelling — the crypto-speak it is slowly picking up. */
export const LEXICON = [
  'validator', 'validators', 'block', 'blocks', 'chain', 'chains', 'token', 'tokens', 'protocol', 'protocols',
  'proposal', 'proposals', 'governance', 'staking', 'stake', 'staked', 'bridge', 'bridges', 'rollup', 'rollups',
  'ethereum', 'bitcoin', 'transaction', 'transactions', 'contract', 'contracts', 'network', 'consensus', 'layer',
  'liquidity', 'pool', 'pools', 'vote', 'votes', 'voting', 'delegate', 'delegates', 'dao', 'eip', 'erc', 'bip',
  'gas', 'fee', 'fees', 'wallet', 'address', 'hash', 'proof', 'proofs', 'zk', 'oracle', 'oracles', 'mev',
  'sequencer', 'blob', 'blobs', 'calldata', 'slashing', 'epoch', 'slot', 'node', 'nodes', 'miner', 'miners',
  'mining', 'defi', 'swap', 'yield', 'lending', 'collateral', 'price', 'market', 'markets', 'exploit', 'exploited',
  'attack', 'audit', 'security', 'upgrade', 'fork', 'mainnet', 'solana', 'uniswap', 'aave', 'arbitrum',
  'optimism', 'lido', 'treasury', 'deposit', 'withdrawal', 'signature', 'key', 'keys', 'merkle', 'state', 'execution',
  'finality', 'stablecoin', 'issuance', 'reward', 'rewards', 'forum', 'temp', 'check', 'snapshot', 'onchain',
]
const LEX = new Set(LEXICON)
const WORD_RE = /[A-Za-z][A-Za-z0-9]*/g

/** Distinct lexicon words spelled correctly (whole-word) in `text`. */
export function lexiconHits(text: string): string[] {
  const hits = new Set<string>()
  for (const m of text.matchAll(WORD_RE)) {
    const w = m[0].toLowerCase()
    if (LEX.has(w)) hits.add(w)
  }
  return [...hits]
}

/** Render-ready segments: whole lexicon words flagged so they can be marked. */
export function lexiconSegments(text: string): { s: string; hit: boolean }[] {
  const out: { s: string; hit: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(WORD_RE)) {
    if (!LEX.has(m[0].toLowerCase())) continue
    const i = m.index ?? 0
    if (i > last) out.push({ s: text.slice(last, i), hit: false })
    out.push({ s: m[0], hit: true })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ s: text.slice(last), hit: false })
  return out
}

export function fmtLoss(x: number | null | undefined, digits = 3): string {
  return x === null || x === undefined || !Number.isFinite(x) || x <= 0 ? '—' : x.toFixed(digits)
}

export function fmtSci(x: number): string {
  const [m, e] = x.toExponential(1).split('e')
  return `${m}e${Number(e)}`
}

/** Compact count without a trailing ".0" (900k, 1.2M). */
export function fmtC(n: number): string {
  return fmtCompact(n).replace(/\.0(?=[kMBT])/, '')
}

/** Axis-style step label: 500 · 2k · 12.5k · 1.2M */
export function fmtStep(v: number): string {
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`
  if (v >= 1000) return `${+(v / 1000).toFixed(1)}k`
  return String(Math.round(v))
}

/** "12s ago" / "now". */
export function ago(ts: number, now: number): string {
  const a = fmtAgo(ts, now)
  return a === 'now' ? 'now' : `${a} ago`
}
