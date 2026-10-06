#!/usr/bin/env node
// Build the Hugging Face model repository folder for SEPIA-0 (nothing is uploaded here;
// scripts/hf/upload.mjs does that).
//
//   node scripts/hf/build-release.mjs [--ckpt <sepia.ckpt>] [--out <dir>] [--repo <org>/SEPIA-0] [--license MIT]
//   node scripts/hf/build-release.mjs --weights <model.safetensors> --manifest <manifest.json> [--out <dir>]
//   node scripts/hf/build-release.mjs --from https://lusca.ink [--out <dir>]
//   node scripts/hf/build-release.mjs --manifest-url https://lusca.ink/api/model/manifest.json
//                                     [--weights-url https://lusca.ink/api/model/weights.safetensors] [--out <dir>]
//
// Inputs (one of):
//   --ckpt      a trainer checkpoint (default: $LUSCA_DATA/sepia.ckpt, else server/data/sepia.ckpt);
//               converted with server/model/export.ts, so the file is byte-identical to what
//               GET /api/model/weights.safetensors serves for the same checkpoint
//   --weights + --manifest   files saved from GET /api/model/weights.safetensors and /manifest.json
//   --from      a LUSCA server: fetches /api/model/manifest.json and the weights it describes
//   --manifest-url [+ --weights-url]   the live manifest and weights by URL (publish time). Without
//               --weights-url the weights URL is the manifest's "weights" field, resolved against
//               the manifest URL. If the server rolls to a newer checkpoint between the two GETs
//               (sha256 differs), both are fetched again (3 attempts).
// Every input is checked: sha256 against the manifest, tensor names/shapes, finite values,
// and the 96-symbol vocabulary.
//
// Output folder (default <tmp>/lusca-hf/SEPIA-0):
//   model.safetensors  config.json  vocab.json  README.md  inference.py  sample.mjs  LICENSE  .gitattributes
// README numbers (steps, GPU samples, audits, contributors, losses) come from the manifest.
// --repo defaults to LUSCAINK/SEPIA-0 (huggingface.co/LUSCAINK/SEPIA-0).
//
// Node ≥ 22.18 runs this directly (it imports server/model/export.ts); on older Node use
//   npx tsx scripts/hf/build-release.mjs …
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Adam, CTX, DECAY_STEPS, EMB, HIDDEN, LR_MAX, LR_MIN, VOCAB, VOCAB_SIZE, WARMUP_STEPS, paramCount } from '../../shared/sepia/model.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const TEMPLATE = path.join(HERE, 'template')
const GITHUB = 'https://github.com/LUSCAINK/LUSCA'
const SITE = 'https://lusca.ink'
const GRAD_CLIP = 1.0 // HP.clip in server/trainer/worker.mjs
const SAMPLE_PROMPT = 'The validator'
const SAMPLE_SEED = 7
const SAMPLE_N = 240

// ─── args ───────────────────────────────────────────────────────────────────

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const k = a.slice(2)
    if (k === 'help') {
      o.help = '1'
      continue
    }
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`--${k} needs a value`)
    o[k] = v
    i++
  }
  return o
}

const sha256 = (/** @type {Uint8Array} */ b) => createHash('sha256').update(b).digest('hex')
const fmt = (/** @type {number} */ n) => n.toLocaleString('en-US')

async function loadExport() {
  try {
    return await import(pathToFileURL(path.join(ROOT, 'server', 'model', 'export.ts')).href)
  } catch (e) {
    throw new Error(`cannot load server/model/export.ts (${e instanceof Error ? e.message : e}); with Node < 22.18 run: npx tsx scripts/hf/build-release.mjs …`)
  }
}

// ─── inputs ─────────────────────────────────────────────────────────────────

/**
 * @param {Record<string, string>} args
 * @param {any} ex server/model/export.ts
 * @returns {Promise<{ weights: Buffer, manifest: any, source: string }>}
 */
async function loadInput(args, ex) {
  if (args.from || args['manifest-url'] || args['weights-url']) {
    if (args.license) throw new Error('--license only applies to --ckpt (the license is embedded in the served weights)')
    if (args.from && args['manifest-url']) throw new Error('use --from or --manifest-url, not both')
    if (!args.from && !args['manifest-url']) throw new Error('--weights-url needs --manifest-url (or --from)')
    const manifestUrl = args['manifest-url'] || `${args.from.replace(/\/+$/, '')}/api/model/manifest.json`
    return fetchLive(manifestUrl, args['weights-url'])
  }
  if (args.weights || args.manifest) {
    if (!args.weights || !args.manifest) throw new Error('--weights and --manifest go together')
    if (args.license) throw new Error('--license only applies to --ckpt (the license is embedded in the weights)')
    return { weights: readFileSync(args.weights), manifest: JSON.parse(readFileSync(args.manifest, 'utf8')), source: path.resolve(args.weights) }
  }
  const dataDir = process.env.LUSCA_DATA?.trim() || path.join(ROOT, 'server', 'data')
  const ckptPath = path.resolve(args.ckpt || path.join(dataDir, 'sepia.ckpt'))
  if (!existsSync(ckptPath)) throw new Error(`no checkpoint at ${ckptPath} (pass --ckpt, --weights/--manifest or --from)`)
  const ck = await ex.readCheckpoint(ckptPath)
  const bundle = ex.buildExport(ck, { license: args.license })
  return { weights: bundle.safetensors, manifest: bundle.manifest, source: ckptPath }
}

/**
 * GET the manifest, then the weights it describes. The server re-reads its checkpoint every
 * 10 min, so a new checkpoint can land between the two requests: on a sha256 mismatch both
 * are fetched again (up to 3 attempts) instead of building a folder that mixes two steps.
 * @param {string} manifestUrl @param {string} [weightsUrl]
 * @returns {Promise<{ weights: Buffer, manifest: any, source: string }>}
 */
export async function fetchLive(manifestUrl, weightsUrl) {
  const mUrl = new URL(manifestUrl)
  if (mUrl.protocol !== 'https:' && mUrl.protocol !== 'http:') throw new Error(`--manifest-url ${manifestUrl} is not http(s)`)
  let last = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    const mr = await fetch(mUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    if (!mr.ok) throw new Error(`GET ${mUrl.href} → HTTP ${mr.status}${mr.status === 503 ? ' (no checkpoint saved yet, or the export is not wired on that server)' : ''}`)
    const manifest = await mr.json()
    const wUrl = new URL(weightsUrl || manifest.weights || '/api/model/weights.safetensors', mUrl)
    const wr = await fetch(wUrl, { signal: AbortSignal.timeout(120_000) })
    if (!wr.ok) throw new Error(`GET ${wUrl.href} → HTTP ${wr.status}`)
    const weights = Buffer.from(await wr.arrayBuffer())
    const digest = sha256(weights)
    if (digest === manifest.sha256) return { weights, manifest, source: `${mUrl.href} + ${wUrl.href}` }
    last = `manifest step ${manifest.step} sha256 ${String(manifest.sha256).slice(0, 12)}…, weights sha256 ${digest.slice(0, 12)}…`
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`sha256 mismatch: the weights did not match the manifest in 3 attempts (${last})`)
}

/**
 * Checks the weights against the manifest and the SEPIA-0 architecture.
 * @param {Buffer} weights @param {any} manifest @param {any} ex
 */
export function validate(weights, manifest, ex) {
  const digest = sha256(weights)
  if (manifest.sha256 !== digest) throw new Error(`sha256 mismatch: manifest ${manifest.sha256}, file ${digest}`)
  if (manifest.bytes !== weights.length) throw new Error(`size mismatch: manifest ${manifest.bytes}, file ${weights.length}`)
  if (manifest.name !== 'SEPIA-0') throw new Error(`manifest name ${manifest.name} is not SEPIA-0`)
  if (manifest.chars !== VOCAB || manifest.vocab !== VOCAB_SIZE) throw new Error('vocabulary differs from shared/sepia/model.mjs')
  const { ctx: T, emb: E, hidden: H, vocab: V } = manifest
  const want = { emb: [V, E], W1: [T * E, H], b1: [H], W2: [H, V], b2: [V] }
  const st = ex.parseSafetensors(weights)
  const names = st.tensors.map((/** @type {any} */ t) => t.name).join(',')
  if (names !== 'emb,W1,b1,W2,b2') throw new Error(`tensors ${names}, want emb,W1,b1,W2,b2`)
  let total = 0
  for (const t of st.tensors) {
    if (t.shape.join() !== want[/** @type {keyof typeof want} */ (t.name)].join()) throw new Error(`${t.name} shape [${t.shape}] ≠ [${want[/** @type {keyof typeof want} */ (t.name)]}]`)
    for (let i = 0; i < t.data.length; i++) if (!Number.isFinite(t.data[i])) throw new Error(`${t.name}[${i}] is not finite`)
    total += t.data.length
  }
  if (total !== manifest.params) throw new Error(`parameter count ${total} ≠ manifest ${manifest.params}`)
  if (st.metadata.step !== String(manifest.step)) throw new Error(`weights metadata step ${st.metadata.step} ≠ manifest step ${manifest.step}`)
  return st
}

// ─── files ──────────────────────────────────────────────────────────────────

/** @param {any} m manifest */
export function buildConfig(m) {
  const adam = new Adam(1)
  return {
    model_type: 'sepia-char-mlp',
    architectures: ['SepiaCharMLP'],
    name: m.name,
    architecture: 'char-MLP',
    arch: m.arch,
    forward: 'logits = tanh(concat_t emb[ids_t] @ W1 + b1) @ W2 + b2',
    vocab_size: m.vocab,
    vocab: m.chars,
    context: m.ctx,
    context_padding_id: 0,
    embedding: m.emb,
    hidden: m.hidden,
    activation: m.activation,
    params: m.params,
    dtype: 'float32',
    weights_layout: `row-major; matrices are [in, out]; W1 input row t*${m.emb}+e is embedding component e of context position t (oldest first)`,
    tensors: Object.fromEntries(m.tensors.map((/** @type {any} */ t) => [t.name, t.shape])),
    init: {
      emb: 'normal(0, 1)',
      W1: `normal(0, 1/sqrt(${m.ctx * m.emb}))`,
      b1: 'zeros',
      W2: `normal(0, 0.1/sqrt(${m.hidden}))`,
      b2: 'zeros',
    },
    optimizer: {
      name: 'adam',
      beta1: adam.beta1,
      beta2: adam.beta2,
      eps: adam.eps,
      grad_clip_norm: GRAD_CLIP,
      lr_max: LR_MAX,
      lr_min: LR_MIN,
      warmup_steps: WARMUP_STEPS,
      cosine_decay_steps: DECAY_STEPS,
    },
    sampling: { temperature: 0.8, temperature_min: 0.05, temperature_max: 2, n_default: 240, n_max: 600, prompt_max_chars: 200 },
    version: m.version,
    step: m.step,
    saved_at: m.updatedAt,
    loss: m.loss,
    val: m.val,
    training: m.training,
    sha256: m.sha256,
    license: m.license,
    source: SITE,
    code: GITHUB,
  }
}

/**
 * vocab.json text: { symbol: id } in id order (written by hand: a JS object would
 * move the digit keys "0".."9" to the front).
 * @param {string} chars
 */
export function buildVocabJson(chars) {
  return '{\n' + [...chars].map((c, i) => `  ${JSON.stringify(c)}: ${i}`).join(',\n') + '\n}\n'
}

/** A code fence longer than any backtick run in the text. @param {string} text */
function fence(text) {
  const runs = text.match(/`+/g) ?? []
  const n = Math.max(3, ...runs.map((r) => r.length + 1))
  return '`'.repeat(n)
}

const r4 = (/** @type {number} */ x) => x.toFixed(4)
const LN96 = Math.log(96)

/**
 * The model card. Every number comes from the manifest.
 * @param {any} m manifest @param {{ repo: string, sample: string, sampleCmd: string }} o
 */
export function buildReadme(m, o) {
  const t = m.training
  const tag = `step-${m.step}`
  const lossRow = (/** @type {string} */ label, /** @type {number | null} */ x) =>
    x === null || x === undefined ? `| ${label} | not recorded | | |` : `| ${label} | ${r4(x)} | ${Math.exp(x).toFixed(2)} | ${(x / Math.LN2).toFixed(3)} |`
  const gpuLine = !t
    ? 'This checkpoint was saved by a server build that did not yet record the GPU pipeline counters, so GPU steps, GPU samples, audits and contributors are not available for it.'
    : t.gpuSteps > 0
      ? `Of the ${fmt(m.step)} optimizer steps in this checkpoint, ${fmt(t.gpuSteps)} were applied from gradients computed by volunteer GPUs and ${fmt(t.serverSteps)} by the server's own CPU loop.`
      : `No GPU gradients had been applied as of this checkpoint: all ${fmt(t.serverSteps)} steps came from the server's own CPU loop.`
  const counters = t
    ? [
        `| Optimizer steps (weights version) | ${fmt(m.step)} |`,
        `| Steps from the server CPU loop | ${fmt(t.serverSteps)} |`,
        `| Steps from GPU-neuron gradients | ${fmt(t.gpuSteps)} |`,
        `| Training samples processed (context → next character) | ${fmt(t.samplesSeen)} |`,
        `| Samples covered by GPU gradients | ${fmt(t.gpuSamples)} |`,
        `| Full audits passed / failed | ${fmt(t.audits.ok)} / ${fmt(t.audits.failed)} |`,
        `| Results rejected by the cheap checks | ${fmt(t.rejected)} |`,
        `| Verified but too stale to apply | ${fmt(t.stale)} |`,
        `| Distinct contributors in the 24 h before this checkpoint | ${fmt(t.contributors24h)} |`,
      ].join('\n')
    : [`| Optimizer steps (weights version) | ${fmt(m.step)} |`, '| GPU steps, GPU samples, audits, contributors | not recorded in this checkpoint |'].join('\n')
  const f = fence(o.sample)
  const gpuApplied = !!t && t.gpuSteps > 0
  const intro = gpuApplied
    ? 'It is trained live by the LUSCA network: the server and volunteer GPUs (WebGPU in the browser) compute gradients for one shared optimizer, and the server checks every GPU gradient before applying it.'
    : "It is trained live on the LUSCA server. The same optimizer accepts gradients from volunteer GPUs (WebGPU in the browser), which the server checks before applying; this checkpoint's numbers below show how many were applied."
  const proof = gpuApplied
    ? 'SEPIA-0 is a proof of the LUSCA training system. It shows that gradients computed by volunteer GPUs can be checked by a server and applied to one shared model while the corpus keeps growing.'
    : 'SEPIA-0 is the first model of the LUSCA training system, built so that gradients computed by volunteer GPUs can be checked by a server and applied to one shared model while the corpus keeps growing.'

  return `---
license: ${m.license.toLowerCase()}
language:
- en
pipeline_tag: text-generation
tags:
- character-level
- language-model
- crypto
- distributed-training
- webgpu
# datasets: none on the Hub. Trained on the LUSCA corpus (see "Data").
---

# SEPIA-0

SEPIA-0 is a ${fmt(m.params)}-parameter character-level language model trained on the LUSCA open crypto web corpus. ${intro} This upload is the checkpoint at optimizer step ${fmt(m.step)}, tagged \`${tag}\`.

## Summary

| | |
|---|---|
| Parameters | ${fmt(m.params)} |
| Architecture | ${m.arch} |
| Vocabulary | ${m.vocab} symbols: newline and printable ASCII |
| Context | ${m.ctx} characters |
| Weights | \`model.safetensors\`, float32, ${fmt(m.bytes)} bytes |
| Step | ${fmt(m.step)} (saved ${m.updatedAt}) |
| Train loss / validation loss | ${m.loss === null ? 'not recorded' : r4(m.loss)} / ${m.val === null ? 'not recorded' : r4(m.val)} nats per character |
| sha256 | \`${m.sha256}\` |

## What it is

${proof}

The model predicts the next character from the previous ${m.ctx}. It learns spelling, punctuation and short word sequences of crypto web text. It has no understanding of the text, follows no instructions, remembers nothing beyond ${m.ctx} characters and does not read code. It is not an assistant.

The next model, SEPIA-1, is a transformer that reads blockchain protocol code. It is in design and has no released weights: [docs/SEPIA-1.md](${GITHUB}/blob/main/docs/SEPIA-1.md).

## How it was trained

Training runs continuously on the LUSCA server while the corpus grows. There is no fixed number of epochs; each upload here is a snapshot of the live run.

- **One optimizer, two sources of steps.** The server's own CPU loop (batch 64) and gradients returned by neurons step the same Adam state. Neurons are browser tabs computing with WebGPU (no install) or a desktop program. Every optimizer step increments the weights version.
- **Every GPU gradient is checked.** The server decodes it, checks that it is finite, checks its norm, compares it with a server gradient on random rows of the same batch (cosine and projection screens) and checks the reported loss. A weak score triggers a full audit.
- **Full audits.** The server recomputes the whole gradient from the exact weights the job was issued with (kept as float16 snapshots). Defaults: always for a neuron's first 3 results, then 20% at random; a result passes at cosine ≥ 0.99 and relative error ≤ 0.05. Results computed on weights more than 64 versions old are verified but not applied.
- **Hyperparameters.** Adam (β1 0.9, β2 0.99, ε 1e-8), global gradient-norm clip ${GRAD_CLIP.toFixed(1)}, learning rate warmed up linearly over ${WARMUP_STEPS} steps to ${LR_MAX}, cosine decay to ${LR_MIN} over ${fmt(DECAY_STEPS)} steps, then constant. Initialisation: embeddings N(0, 1), W1 N(0, 1/${m.ctx * m.emb}), W2 N(0, (0.1/√${m.hidden})²), biases 0.
- **Precision.** The weights here are the float32 master copy. Neurons receive them rounded to float16 for transfer and return float16 gradients with one power-of-two scale per tensor.

Numbers for this checkpoint, taken from the server's manifest when this folder was built:

| | |
|---|---|
${counters}

${gpuLine}

## Data

The LUSCA open crypto web corpus: public pages fetched by 24 data agents across eight sectors (Governance, Research, Docs, Standards, Markets, Codex, Security, Chronicle), covering DAO forums, protocol research, developer documentation, standards and security write-ups. Only pages the agents keep enter the dataset: each page is scored for relevance and near-duplicates are dropped.

- \`robots.txt\` is honoured for LuscaBot and \`*\`.
- AI-training opt-outs are respected: the \`robots.txt\` groups of AI-training bots, \`Content-Signal: ai-train=no\`, TDMRep and \`noai\`. Links into opted-out pages are not followed.
- Every host is paced (one request in flight, at least 2 s apart).
- E-mail addresses and phone numbers are redacted before text reaches the dataset or the model.

Text is NFKD-normalised and mapped to the ${m.vocab}-symbol vocabulary: accents are removed, typographic quotes and dashes are folded to ASCII, other characters become a space or are dropped. Every 20th kept document is held out for validation. The training corpus in memory is a window of the most recent pages (24M characters by default; older documents are evicted). The corpus is not included in this repository.

## Architecture

\`\`\`
ids[${m.ctx}] ─ emb ─▶ x[${m.ctx * m.emb}] ─ W1, b1 ─▶ tanh ─▶ h[${m.hidden}] ─ W2, b2 ─▶ logits[${m.vocab}]
x = concat(emb[ids_1], …, emb[ids_${m.ctx}])     h = tanh(x·W1 + b1)     logits = h·W2 + b2
\`\`\`

| Tensor | Shape | Role |
|---|---|---|
| \`emb\` | [${m.vocab}, ${m.emb}] | character embeddings |
| \`W1\` | [${m.ctx * m.emb}, ${m.hidden}] | hidden layer; input row t·${m.emb} + e is component e of context position t (oldest first) |
| \`b1\` | [${m.hidden}] | hidden bias |
| \`W2\` | [${m.hidden}, ${m.vocab}] | output layer |
| \`b2\` | [${m.vocab}] | output bias |

Matrices are row-major [in, out] (\`x @ W\`); for \`torch.nn.Linear\` use the transpose. Contexts shorter than ${m.ctx} characters are left-padded with id 0 (newline). The vocabulary in id order is in \`config.json\` (\`vocab\`) and \`vocab.json\`. Total: ${m.vocab}·${m.emb} + ${m.ctx * m.emb}·${m.hidden} + ${m.hidden} + ${m.hidden}·${m.vocab} + ${m.vocab} = ${fmt(m.params)} parameters.

## Usage

\`\`\`bash
pip install numpy huggingface_hub
hf download ${o.repo} --local-dir SEPIA-0
cd SEPIA-0
python inference.py "${SAMPLE_PROMPT}" --n ${SAMPLE_N} --temperature 0.8 --seed ${SAMPLE_SEED}
node sample.mjs "${SAMPLE_PROMPT}" --n ${SAMPLE_N} --temperature 0.8 --seed ${SAMPLE_SEED}
\`\`\`

\`inference.py\` needs only numpy and reads \`model.safetensors\` with a built-in reader. \`sample.mjs\` needs only Node.js. Both sample exactly like \`POST ${SITE}/api/generate\`: the prompt is cut to 200 characters, \`--n\` is 1–600 (default 240), \`--temperature\` is 0.05–2 (default 0.8), and the output is the prompt followed by the continuation. With \`--seed\`, both use the same seeded generator and print the same text; without it, they use system randomness like the server.

Output of \`${o.sampleCmd}\` for this checkpoint:

${f}text
${o.sample}
${f}

From Python:

\`\`\`python
from inference import Sepia, encode, generate, mulberry32
model = Sepia("model.safetensors")
print(generate(model, "${SAMPLE_PROMPT}", n=200, temperature=0.8, rand=mulberry32(${SAMPLE_SEED})))
ctx = ([0] * ${m.ctx} + encode("The ", keep_trailing=True))[-${m.ctx}:]  # ${m.ctx} ids, oldest first
logits = model.logits(ctx)  # float32[${m.vocab}], next-character scores
\`\`\`

With the \`safetensors\` package: \`safetensors.numpy.load_file("model.safetensors")\` returns \`emb\`, \`W1\`, \`b1\`, \`W2\`, \`b2\` as float32 arrays.

## Evaluation

Cross-entropy in nats per character (lower is better), with perplexity and bits per character:

| | Loss | Perplexity | Bits/char |
|---|---|---|---|
| Uniform guess over ${m.vocab} symbols | ${r4(LN96)} (ln 96) | 96.00 | ${(LN96 / Math.LN2).toFixed(3)} |
${lossRow('Train (mean over the last 25 steps)', m.loss)}
${lossRow('Validation (held-out documents, 16 batches of 64)', m.val)}

The validation documents are every 20th kept document of the current corpus window, so the score follows the corpus as it changes. Character-level numbers are not comparable with token-level perplexities, and this is not a standard benchmark.

## Limitations

- ${m.ctx}-character context: no coherence beyond a few words.
- Output is plausible-looking character sequences, not facts. Do not rely on anything it writes.
- ${m.vocab}-symbol vocabulary: non-ASCII text is folded to ASCII or dropped.
- No instruction tuning and no safety tuning. It can reproduce fragments of public web text it was trained on (contact data is redacted at ingest).
- Training never stops, so the numbers above describe this snapshot only.
- It does not read or write code.

## Versions

Each upload is a snapshot of the live run, tagged \`step-<N>\` with N the optimizer step. This one is \`${tag}\`; \`main\` holds the newest. To pin one:

\`\`\`bash
hf download ${o.repo} --revision ${tag} --local-dir SEPIA-0-${tag}
\`\`\`

## License

\`inference.py\` and \`sample.mjs\` are MIT licensed, like the LUSCA repository. The weights in this snapshot are released under ${m.license.toUpperCase() === 'MIT' ? 'MIT as well' : m.license}. The project owner may choose a different license for the weights of later snapshots, so check the license of the revision you use.

## Links

- ${SITE}: live training, network and corpus
- [${GITHUB.replace('https://', '')}](${GITHUB}): source code (model: \`shared/sepia/model.mjs\`, trainer: \`server/trainer/\`, export: \`server/model/export.ts\`)
- [docs/SEPIA-1.md](${GITHUB}/blob/main/docs/SEPIA-1.md): what comes next

## Citation

\`\`\`bibtex
@misc{sepia0_2026,
  title        = {SEPIA-0: a character-level language model trained with server-checked volunteer GPU gradients},
  author       = {{LUSCA contributors}},
  year         = {2026},
  howpublished = {\\url{https://huggingface.co/${o.repo}}},
  note         = {Snapshot ${tag}}
}
\`\`\`
`
}

// ─── main ───────────────────────────────────────────────────────────────────

export async function build(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/).slice(1) // after the shebang
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.slice(3)).join('\n'))
    return null
  }
  const repo = args.repo || 'LUSCAINK/SEPIA-0'
  if (!/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(repo)) throw new Error(`--repo ${repo} is not <namespace>/<name>`)
  const out = path.resolve(args.out || path.join(tmpdir(), 'lusca-hf', 'SEPIA-0'))
  const ex = await loadExport()
  const { weights, manifest, source } = await loadInput(args, ex)
  validate(weights, manifest, ex)
  if (manifest.params !== paramCount() || manifest.ctx !== CTX || manifest.emb !== EMB || manifest.hidden !== HIDDEN) {
    throw new Error('the weights do not match the SEPIA-0 architecture in shared/sepia/model.mjs')
  }

  mkdirSync(out, { recursive: true })
  writeFileSync(path.join(out, 'model.safetensors'), weights)
  copyFileSync(path.join(TEMPLATE, 'inference.py'), path.join(out, 'inference.py'))
  copyFileSync(path.join(TEMPLATE, 'sample.mjs'), path.join(out, 'sample.mjs'))
  copyFileSync(path.join(ROOT, 'LICENSE'), path.join(out, 'LICENSE'))
  writeFileSync(path.join(out, '.gitattributes'), '*.safetensors filter=lfs diff=lfs merge=lfs -text\n')
  writeFileSync(path.join(out, 'config.json'), JSON.stringify(buildConfig(manifest), null, 2) + '\n')
  writeFileSync(path.join(out, 'vocab.json'), buildVocabJson(manifest.chars))

  // README example: real output of these weights (same code as the published sample.mjs).
  const s = await import(pathToFileURL(path.join(out, 'sample.mjs')).href + `?v=${manifest.sha256}`)
  const model = s.loadSepia(path.join(out, 'model.safetensors'))
  const sample = s.generate(model, SAMPLE_PROMPT, { n: SAMPLE_N, temperature: 0.8, rand: s.mulberry32(SAMPLE_SEED) })
  const sampleCmd = `python inference.py "${SAMPLE_PROMPT}" --n ${SAMPLE_N} --temperature 0.8 --seed ${SAMPLE_SEED}`
  writeFileSync(path.join(out, 'README.md'), buildReadme(manifest, { repo, sample, sampleCmd }))

  const files = ['model.safetensors', 'config.json', 'vocab.json', 'README.md', 'inference.py', 'sample.mjs', 'LICENSE', '.gitattributes']
  console.log(`SEPIA-0 release folder: ${out}`)
  console.log(`target: https://huggingface.co/${repo}`)
  console.log(`source: ${source}`)
  console.log(`step ${fmt(manifest.step)} · loss ${manifest.loss ?? '—'} · val ${manifest.val ?? '—'} · license ${manifest.license} · repo ${repo} · tag step-${manifest.step}`)
  for (const f of files) {
    const b = readFileSync(path.join(out, f))
    console.log(`  ${f.padEnd(18)} ${String(statSync(path.join(out, f)).size).padStart(8)} B  sha256 ${sha256(b).slice(0, 16)}…`)
  }
  console.log(`\nsample (${sampleCmd}):\n${sample}`)
  return { out, manifest, sample }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  build(process.argv.slice(2)).catch((e) => {
    console.error(`build-release: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  })
}
