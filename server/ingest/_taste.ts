// Self-check for the taste gate (server/ingest/lexicon.ts).
//
//   npx tsx server/ingest/_taste.ts [dataset.jsonl]
//
// 1. every CORE label exists in the lexicon,
// 2. off-topic pages that share generic vocabulary with crypto are rejected,
// 3. on-topic pages are accepted,
// 4. optionally: how many pages of an existing dataset.jsonl would still pass.
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { CORE_MISSING, taste } from './lexicon.ts'

const ACCEPT = 0.35
const MIN_DISTINCT = 3
let failed = 0
function ok(cond: boolean, what: string) {
  if (!cond) failed++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}`)
}

const FILLER = 'the people of the city said that a report on the morning market was quite late and many readers wrote letters about it while others walked home'.split(' ')
/** ~1000-word page: filler with each term repeated `reps` times. */
function page(terms: string[], reps: number): string {
  const out: string[] = []
  for (let i = 0; out.length < 1000; i++) out.push(FILLER[i % FILLER.length])
  for (const t of terms) for (let r = 0; r < reps; r++) out.splice(Math.floor(((out.length * (r + 1)) / (reps + 1)) % out.length), 0, t)
  return out.join(' ')
}
const passes = (text: string, prior: number) => {
  const t = taste(text, prior)
  return { pass: t.score >= ACCEPT && t.distinct >= MIN_DISTINCT, t }
}

ok(CORE_MISSING.length === 0, `all CORE labels are lexicon entries${CORE_MISSING.length ? ` (missing: ${CORE_MISSING.join(', ')})` : ''}`)

const offTopic: [string, string[], number, number][] = [
  ['mining / bridge / block', ['mining', 'bridge', 'block'], 4, 0.5],
  ['NLP tokenizer doc', ['tokenization', 'tokenized', 'tokens'], 3, 0.5],
  ['CVE write-up (seed prior)', ['exploit', 'vulnerability', 'attacker'], 3, 0.85],
  ['city council minutes', ['proposal', 'vote', 'treasury', 'grant'], 3, 0.5],
  ['TLS doc', ['encryption', 'public key', 'node', 'client'], 3, 0.5],
  ['real-estate covenants', ['covenants', 'staking', 'finality'], 2, 0.5],
]
for (const [name, terms, reps, prior] of offTopic) {
  const { pass, t } = passes(page(terms, reps), prior)
  ok(!pass, `off-topic rejected: ${name} (score ${t.score.toFixed(3)}, core ${t.core}, distinct ${t.distinct})`)
}

const onTopic: [string, string[], number][] = [
  ['rollup research', ['rollup', 'calldata', 'EIP-4844', 'blob transactions', 'sequencer'], 3],
  ['bitcoin dev', ['taproot', 'covenants', 'OP_CTV', 'mempool', 'utxo'], 3],
  ['defi governance', ['uniswap', 'governance proposal', 'delegates', 'treasury', 'on-chain'], 3],
]
for (const [name, terms, reps] of onTopic) {
  const { pass, t } = passes(page(terms, reps), 0.5)
  ok(pass, `on-topic accepted: ${name} (score ${t.score.toFixed(3)}, core ${t.core}, distinct ${t.distinct})`)
}

const file = process.argv[2]
if (file) {
  let n = 0
  let keep = 0
  const dropped: string[] = []
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.startsWith('{')) continue
    try {
      const rec = JSON.parse(line) as { text?: string; url?: string }
      if (typeof rec.text !== 'string') continue
      n++
      if (passes(rec.text, 0.5).pass) keep++
      else if (dropped.length < 8) dropped.push(rec.url ?? '?')
    } catch {
      /* skip */
    }
  }
  console.log(`dataset: ${keep}/${n} stored pages still pass at prior 0.5 (${n ? ((100 * keep) / n).toFixed(1) : 0}%)`)
  for (const u of dropped) console.log(`  dropped e.g. ${u}`)
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall taste checks passed')
process.exit(failed ? 1 : 0)
