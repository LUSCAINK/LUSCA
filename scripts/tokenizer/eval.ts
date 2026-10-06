// Evaluate the SEPIA-1 tokenizer on the held-out split and compare it with GPT tokenizers.
//
//   npx tsx scripts/tokenizer/eval.ts <workdir>
//
// Reads <workdir>/eval/<lang>.jsonl (prepare.py; never trained on) and <workdir>/ids/<lang>.jsonl
// (export_ids.py, the Hugging Face tokenizer's ids for the same documents). For every document:
//   - encodes it with shared/sepia1/tokenizer.ts and checks the ids against Python, token for token;
//   - checks decode(encode(x)) === x (round trip);
//   - counts tokens with r50k_base (GPT-2), cl100k_base and o200k_base (gpt-tokenizer; o200k_base is
//     the encoding the corpus uses at ingest).
// Writes models/sepia-1-tokenizer/eval.json and eval.md. Exits non-zero on any parity or round-trip failure.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as r50k from 'gpt-tokenizer/encoding/r50k_base'
import * as cl100k from 'gpt-tokenizer/encoding/cl100k_base'
import * as o200k from 'gpt-tokenizer/encoding/o200k_base'
import { Sepia1Tokenizer, type TokenizerJsonLike } from '../../shared/sepia1/tokenizer.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const work = process.argv[2]
if (!work) throw new Error('usage: tsx scripts/tokenizer/eval.ts <workdir>')
const outDir = path.join(root, 'models', 'sepia-1-tokenizer')
const raw = fs.readFileSync(path.join(outDir, 'tokenizer.json'))
const sha = crypto.createHash('sha256').update(raw).digest('hex')
const tok = new Sepia1Tokenizer(JSON.parse(raw.toString('utf8')) as TokenizerJsonLike)

const LANGS: { id: string; label: string }[] = [
  { id: 'solidity', label: 'Solidity' },
  { id: 'vyper', label: 'Vyper' },
  { id: 'rust', label: 'Rust / Anchor' },
  { id: 'move', label: 'Move' },
  { id: 'cairo', label: 'Cairo' },
  { id: 'go', label: 'Go' },
  { id: 'cpp', label: 'C / C++' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'markdown', label: 'Markdown (EIPs, docs)' },
  { id: 'web', label: 'Web text (English, crypto)' },
]
const plain = { disallowedSpecial: new Set<string>() }
const OTHERS = {
  r50k: { name: 'r50k_base (GPT-2)', vocab: r50k.vocabularySize, count: (t: string) => r50k.encode(t, plain).length },
  cl100k: { name: 'cl100k_base', vocab: cl100k.vocabularySize, count: (t: string) => cl100k.encode(t, plain).length },
  o200k: { name: 'o200k_base', vocab: o200k.vocabularySize, count: (t: string) => o200k.encode(t, plain).length },
}
type Key = 'sepia1' | keyof typeof OTHERS
const KEYS: Key[] = ['sepia1', 'r50k', 'cl100k', 'o200k']

const lineCount = (t: string) => (t.length === 0 ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0))
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d

let parityDocs = 0
let parityTokens = 0
let mismatches = 0
let rtDocs = 0
let rtExact = 0
let rtBytes = 0
let encMs = 0
let encBytes = 0
interface Row {
  id: string
  label: string
  docs: number
  sources: number
  bytes: number
  lines: number
  tokenizers: Record<Key, { tokens: number; bytesPerToken: number; tokensPer1kLines: number; linesPer2048: number }>
}
const languages: Row[] = []
for (const { id, label } of LANGS) {
  const evalPath = path.join(work, 'eval', `${id}.jsonl`)
  if (!fs.existsSync(evalPath)) continue
  const docs = fs.readFileSync(evalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { text: string; repo?: string; host?: string })
  const pyIds = fs.readFileSync(path.join(work, 'ids', `${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as number[])
  if (docs.length !== pyIds.length) throw new Error(`${id}: ${docs.length} docs but ${pyIds.length} id rows`)
  const counts: Record<Key, number> = { sepia1: 0, r50k: 0, cl100k: 0, o200k: 0 }
  let bytes = 0
  let lines = 0
  docs.forEach((d, i) => {
    const b = Buffer.byteLength(d.text)
    bytes += b
    lines += lineCount(d.text)
    const t0 = performance.now()
    const ids = tok.encode(d.text, { allowSpecial: false })
    encMs += performance.now() - t0
    encBytes += b
    counts.sepia1 += ids.length
    parityDocs++
    parityTokens += ids.length
    const py = pyIds[i]
    if (ids.length !== py.length || ids.some((v, k) => v !== py[k])) {
      mismatches++
      console.error(`parity mismatch: ${id} doc ${i}`)
    }
    rtDocs++
    rtBytes += b
    if (tok.decode(ids) === d.text) rtExact++
    else console.error(`round trip failed: ${id} doc ${i}`)
    for (const k of Object.keys(OTHERS) as (keyof typeof OTHERS)[]) counts[k] += OTHERS[k].count(d.text)
  })
  const tokenizers = Object.fromEntries(
    KEYS.map((k) => [
      k,
      {
        tokens: counts[k],
        bytesPerToken: round(bytes / counts[k]),
        tokensPer1kLines: Math.round((counts[k] / lines) * 1000),
        linesPer2048: Math.round((2048 * lines) / counts[k]),
      },
    ]),
  ) as Row['tokenizers']
  const repos = new Set(docs.map((d) => d.repo ?? d.host ?? ''))
  languages.push({ id, label, docs: docs.length, sources: repos.size, bytes, lines, tokenizers })
  console.log(`${label.padEnd(28)} ${String(docs.length).padStart(4)} docs ${(bytes / 1e6).toFixed(2)} MB  ` + KEYS.map((k) => `${k} ${tokenizers[k].bytesPerToken}`).join('  '))
}

const code = languages.filter((l) => l.id !== 'web' && l.id !== 'markdown')
const sum = (rows: typeof languages, k: Key) => rows.reduce((s, l) => s + l.tokenizers[k].tokens, 0)
const codeBytes = code.reduce((s, l) => s + l.bytes, 0)
const codeLines = code.reduce((s, l) => s + l.lines, 0)
const totals = {
  code: {
    languages: code.map((l) => l.id),
    bytes: codeBytes,
    lines: codeLines,
    tokenizers: Object.fromEntries(KEYS.map((k) => [k, { tokens: sum(code, k), bytesPerToken: round(codeBytes / sum(code, k)), tokensPer1kLines: Math.round((sum(code, k) / codeLines) * 1000) }])),
    // tokens SEPIA-1 needs for the same code, relative to each tokenizer (lower is better)
    relative: Object.fromEntries(KEYS.filter((k) => k !== 'sepia1').map((k) => [k, round(sum(code, 'sepia1') / sum(code, k))])),
  },
}

const manifest = JSON.parse(fs.readFileSync(path.join(work, 'manifest.json'), 'utf8')) as { eval: Record<string, { sha256: string }> }
const evalJson = {
  tokenizer: { name: 'SEPIA-1 tokenizer', version: 'v1', vocabSize: tok.vocabSize, sha256: sha },
  created: new Date().toISOString(),
  heldOut: 'Files and pages chosen by hash before training and never trained on (scripts/tokenizer/prepare.py). Code: sha256(repo\\npath) mod 1000 < 80, up to 1.5 MB per language. Web: sha256(id) mod 1000 < 20, mostly-ASCII pages, up to 1.5 MB.',
  definitions: {
    bytesPerToken: 'UTF-8 bytes of the held-out text divided by its token count (higher is better)',
    tokensPer1kLines: 'tokens per 1,000 lines of the same text (lower is better)',
    linesPer2048: '2,048 × lines ÷ tokens: lines that fit in one SEPIA-1 context window at the measured rate',
  },
  compare: Object.fromEntries([['sepia1', { name: 'SEPIA-1 tokenizer', vocab: tok.vocabSize }], ...Object.entries(OTHERS).map(([k, v]) => [k, { name: v.name, vocab: v.vocab }])]),
  languages,
  totals,
  roundTrip: { docs: rtDocs, exact: rtExact, bytes: rtBytes },
  parity: { docs: parityDocs, tokens: parityTokens, mismatches, against: 'Hugging Face tokenizers 0.20.3 (Python)' },
  speed: { encoderMBps: round(encBytes / 1e6 / (encMs / 1000), 2), note: 'shared/sepia1/tokenizer.ts on Node, one core, cold piece cache per process' },
  evalSha256: Object.fromEntries(Object.entries(manifest.eval).map(([k, v]) => [k, v.sha256])),
}
fs.writeFileSync(path.join(outDir, 'eval.json'), JSON.stringify(evalJson, null, 1) + '\n')

// human-readable table
const f2 = (x: number) => x.toFixed(2)
const md: string[] = []
md.push('# SEPIA-1 tokenizer: held-out evaluation', '')
md.push(`Tokenizer sha256 \`${sha}\`. ${rtExact} of ${rtDocs} held-out documents round-trip exactly; the TypeScript encoder matches the Python tokenizer on ${parityTokens.toLocaleString('en-US')} tokens with ${mismatches} mismatches.`, '')
md.push('## Bytes per token (higher is better)', '')
md.push('| Language | Docs | MB | SEPIA-1 (32,768) | r50k (GPT-2) | cl100k | o200k |', '|---|---:|---:|---:|---:|---:|---:|')
for (const l of languages) md.push(`| ${l.label} | ${l.docs} | ${f2(l.bytes / 1e6)} | **${f2(l.tokenizers.sepia1.bytesPerToken)}** | ${f2(l.tokenizers.r50k.bytesPerToken)} | ${f2(l.tokenizers.cl100k.bytesPerToken)} | ${f2(l.tokenizers.o200k.bytesPerToken)} |`)
md.push(`| **All code** (no Markdown) | | ${f2(codeBytes / 1e6)} | **${f2(totals.code.tokenizers.sepia1.bytesPerToken)}** | ${f2(totals.code.tokenizers.r50k.bytesPerToken)} | ${f2(totals.code.tokenizers.cl100k.bytesPerToken)} | ${f2(totals.code.tokenizers.o200k.bytesPerToken)} |`, '')
md.push('## Tokens per 1,000 lines (lower is better)', '')
md.push('| Language | SEPIA-1 | r50k | cl100k | o200k |', '|---|---:|---:|---:|---:|')
for (const l of languages) md.push(`| ${l.label} | **${l.tokenizers.sepia1.tokensPer1kLines.toLocaleString('en-US')}** | ${l.tokenizers.r50k.tokensPer1kLines.toLocaleString('en-US')} | ${l.tokenizers.cl100k.tokensPer1kLines.toLocaleString('en-US')} | ${l.tokenizers.o200k.tokensPer1kLines.toLocaleString('en-US')} |`)
md.push('', '## Lines in one 2,048-token window', '')
md.push('| Language | SEPIA-1 | r50k | cl100k | o200k |', '|---|---:|---:|---:|---:|')
for (const l of languages.filter((x) => x.id !== 'web')) md.push(`| ${l.label} | **${l.tokenizers.sepia1.linesPer2048}** | ${l.tokenizers.r50k.linesPer2048} | ${l.tokenizers.cl100k.linesPer2048} | ${l.tokenizers.o200k.linesPer2048} |`)
md.push('', `Encoder speed (TypeScript, Node, one core): ${evalJson.speed.encoderMBps} MB/s.`, '')
fs.writeFileSync(path.join(outDir, 'eval.md'), md.join('\n'))
console.log(`parity ${parityDocs} docs / ${parityTokens} tokens / ${mismatches} mismatches · round trip ${rtExact}/${rtDocs} · ${evalJson.speed.encoderMBps} MB/s`)
console.log(`code: sepia1 ${totals.code.tokenizers.sepia1.bytesPerToken} B/tok, relative tokens vs r50k ${totals.code.relative.r50k}, cl100k ${totals.code.relative.cl100k}, o200k ${totals.code.relative.o200k}`)
if (mismatches > 0 || rtExact !== rtDocs) process.exit(1)
