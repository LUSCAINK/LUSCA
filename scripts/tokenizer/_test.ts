// Tests for the SEPIA-1 tokenizer's TypeScript encoder (shared/sepia1/tokenizer.ts).
// (Kept under scripts/ so it typechecks with Node types; shared/ is also part of the browser build.)
// Run: npx tsx scripts/tokenizer/_test.ts
//
// 1. Parity: every fixture in _fixtures.json.gz (seeded synthetic strings that hit each
//    pre-tokenizer rule and its edges, plus the playground examples and slices of them) is encoded
//    and compared token for token with the ids Hugging Face `tokenizers` 0.20.3 produced
//    (scripts/tokenizer/export_ids.py). Any mismatch fails.
// 2. Round trip: decode(encode(x)) === x for every fixture.
// 3. Special tokens: ids, splitting, allowSpecial: false.
// 4. Artifacts: tokenizer.json sha256 matches manifest.json and the fixtures; vocab is 32,768.
// 5. Playground smoke: the examples load, tokenize, and the eval table the page renders is complete.
// Exits non-zero on any failure.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Sepia1Tokenizer, type TokenizerJsonLike } from '../../shared/sepia1/tokenizer.ts'
import { EXAMPLES } from '../../src/components/sepia/tokenizer/examples.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const dir = path.join(root, 'models', 'sepia-1-tokenizer')
let failures = 0
const fail = (msg: string) => {
  failures++
  console.error(`FAIL ${msg}`)
}
const ok = (cond: boolean, msg: string) => {
  if (!cond) fail(msg)
}

const raw = fs.readFileSync(path.join(dir, 'tokenizer.json'))
const sha = crypto.createHash('sha256').update(raw).digest('hex')
const tok = new Sepia1Tokenizer(JSON.parse(raw.toString('utf8')) as TokenizerJsonLike)

// ── artifacts ──
ok(tok.vocabSize === 32768, `vocab size ${tok.vocabSize} !== 32768`)
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { files: Record<string, { sha256: string; bytes: number }> }
ok(manifest.files['tokenizer.json']?.sha256 === sha, 'tokenizer.json sha256 does not match manifest.json')
for (const [name, f] of Object.entries(manifest.files)) {
  const p = path.join(dir, name)
  if (!fs.existsSync(p)) {
    fail(`manifest lists missing file ${name}`)
    continue
  }
  const b = fs.readFileSync(p)
  ok(b.length === f.bytes, `${name}: ${b.length} bytes, manifest says ${f.bytes}`)
  ok(crypto.createHash('sha256').update(b).digest('hex') === f.sha256, `${name}: sha256 differs from manifest`)
}

// ── parity + round trip ──
const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, '_fixtures.json.gz'))).toString('utf8')) as {
  tokenizer_sha256: string
  fixtures: { text: string; ids: number[] }[]
}
ok(fx.tokenizer_sha256 === sha, 'fixtures were generated from a different tokenizer.json (run scripts/tokenizer/export_ids.py)')
let mismatches = 0
let tokens = 0
let rt = 0
for (const [i, f] of fx.fixtures.entries()) {
  const ids = tok.encode(f.text)
  tokens += ids.length
  if (ids.length !== f.ids.length || ids.some((v, k) => v !== f.ids[k])) {
    mismatches++
    if (mismatches <= 5) {
      const k = ids.findIndex((v, j) => v !== f.ids[j])
      fail(`fixture ${i}: first difference at token ${k}: ts ${JSON.stringify(ids.slice(Math.max(0, k - 2), k + 3))} py ${JSON.stringify(f.ids.slice(Math.max(0, k - 2), k + 3))} text ${JSON.stringify(f.text.slice(0, 120))}`)
    }
  }
  if (tok.decode(ids) !== f.text) {
    rt++
    if (rt <= 3) fail(`fixture ${i}: round trip differs`)
  }
}
ok(mismatches === 0, `${mismatches} of ${fx.fixtures.length} fixtures differ from the Python tokenizer`)
ok(fx.fixtures.length >= 2000, `only ${fx.fixtures.length} fixtures`)
console.log(`parity: ${fx.fixtures.length} fixtures, ${tokens} tokens, ${mismatches} mismatches, ${rt} round-trip failures`)

// ── special tokens ──
const specials = ['<|endoftext|>', '<|pad|>', '<|repo|>', '<|file|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>']
specials.forEach((s, i) => ok(tok.specials.get(s) === i, `${s} should be id ${i}`))
ok(tok.specials.get('<|reserved_0|>') === 7 && tok.specials.get('<|reserved_31|>') === 38, 'reserved tokens should be ids 7..38')
ok(tok.specials.size === 39, `39 special tokens expected, got ${tok.specials.size}`)
const doc = tok.encode('<|repo|>Uniswap/v2-core@6a9e7c9<|file|>contracts/UniswapV2Pair.sol\npragma solidity =0.5.16;<|endoftext|>')
ok(doc[0] === 2 && doc.includes(3) && doc[doc.length - 1] === 0, 'document markers should encode to their ids')
const plain = tok.encode('<|endoftext|>', { allowSpecial: false })
ok(!plain.includes(0) && plain.length > 1 && tok.decode(plain) === '<|endoftext|>', 'allowSpecial: false encodes the marker as text')
ok(tok.decode([0]) === '<|endoftext|>', 'special token decodes to its text')

// ── pre-tokenizer rules (docs/SEPIA-1.md §2.3) ──
const pt = (s: string) => tok.preTokenize(s)
ok(JSON.stringify(pt('x\n        y')) === JSON.stringify(['x', '\n        ', 'y']), 'newline + indentation is one pre-token')
ok(pt('a => b').includes(' =>') && pt('a::b').includes('::') && pt(')=>{').includes('=>'), 'operators are atomic')
ok(pt('msg.sender').length === 1, 'dotted identifier is one pre-token')
ok(JSON.stringify(pt('1000')) === JSON.stringify(['1', '0', '0', '0']), 'digits split one per token')
ok(JSON.stringify(pt('0xdAC17F958D2ee523a2206206994597C13D831ec7').slice(0, 3)) === JSON.stringify(['0x', 'dAC1', '7F95']), 'long hex split into 4-digit groups')
ok(JSON.stringify(pt('0x01ffc9a7')) === JSON.stringify(['0x01ffc9a7']), 'short hex stays whole')

// ── playground smoke ──
ok(EXAMPLES.length >= 4, 'playground has its examples')
for (const e of EXAMPLES) {
  const t = tok.tokens(e.code)
  ok(t.length > 0 && t.reduce((s, x) => s + x.bytes, 0) === Buffer.byteLength(e.code), `${e.id}: token bytes add up to the text`)
  ok(tok.decode(t.map((x) => x.id)) === e.code, `${e.id}: round trip`)
  ok(/^[0-9a-f]{40}$/.test(e.commit) && e.license.length > 0, `${e.id}: attribution recorded`)
}
const evalJson = JSON.parse(fs.readFileSync(path.join(dir, 'eval.json'), 'utf8')) as {
  languages: { id: string; bytes: number; tokenizers: Record<string, { tokens: number; bytesPerToken: number }> }[]
  roundTrip: { exact: number; docs: number }
  parity: { mismatches: number; docs: number }
}
const want = ['solidity', 'vyper', 'rust', 'move', 'cairo', 'go', 'cpp', 'typescript', 'python', 'web']
for (const id of want) {
  const row = evalJson.languages.find((l) => l.id === id)
  ok(!!row && row.bytes > 0, `eval.json has ${id}`)
  if (row) for (const k of ['sepia1', 'r50k', 'cl100k', 'o200k']) ok(row.tokenizers[k]?.tokens > 0, `eval.json ${id} has ${k}`)
}
ok(evalJson.roundTrip.exact === evalJson.roundTrip.docs, 'eval round trip must be 100%')
ok(evalJson.parity.mismatches === 0, 'eval parity must have no mismatches')

if (failures > 0) {
  console.error(`${failures} failure(s)`)
  process.exit(1)
}
console.log('sepia1 tokenizer: all tests passed')
