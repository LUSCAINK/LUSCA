#!/usr/bin/env node
// Check a SEPIA-1 tokenizer release folder (scripts/hf/build-tokenizer-release.mjs) before upload.
//
//   npx tsx scripts/hf/verify-tokenizer-release.mjs --dir <folder> [--python python]
//
//   1. every file listed in the folder's manifest.json has the recorded sha256 and size;
//      data-manifest.json matches its recorded sha256
//   2. the TypeScript encoder (shared/sepia1/tokenizer.ts) loads the folder's tokenizer.json:
//      32,768 entries, 39 special tokens at ids 0-38, parity with the committed fixtures
//      (scripts/tokenizer/_fixtures.json.gz) and exact round trip
//   3. Python `tokenizers` loads the folder's tokenizer.json and gives the same ids on the fixtures;
//      if `transformers` is installed, AutoTokenizer.from_pretrained(<folder>) does too
//   4. README.md has front matter; no file contains a local absolute path
// Exits non-zero on any failure. Uploads nothing.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Sepia1Tokenizer } from '../../shared/sepia1/tokenizer.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const dir = path.resolve(arg('dir', path.join(tmpdir(), 'lusca-hf', 'SEPIA-1-tokenizer')))
const PY = arg('python', process.env.PYTHON || 'python')
let failures = 0
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`)
  if (!cond) failures++
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// 1. hashes
const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
for (const [name, f] of Object.entries(manifest.files)) {
  if (name === 'MODEL_CARD.md') continue // shipped as README.md with front matter
  const b = readFileSync(path.join(dir, name))
  ok(b.length === f.bytes && sha(b) === f.sha256, `${name} sha256 ${f.sha256.slice(0, 12)}… and ${f.bytes} bytes`)
}
ok(sha(readFileSync(path.join(dir, 'data-manifest.json'))) === manifest.data_manifest.sha256, 'data-manifest.json sha256')

// 2. TypeScript encoder
const tok = new Sepia1Tokenizer(JSON.parse(readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')))
ok(tok.vocabSize === 32768, `vocab ${tok.vocabSize}`)
ok(tok.specials.size === 39 && [...tok.specials.values()].every((id) => id >= 0 && id <= 38), '39 special tokens at ids 0-38')
const fx = JSON.parse(gunzipSync(readFileSync(path.join(ROOT, 'scripts', 'tokenizer', '_fixtures.json.gz'))).toString('utf8'))
ok(fx.tokenizer_sha256 === manifest.files['tokenizer.json'].sha256, 'fixtures belong to this tokenizer.json')
let bad = 0
let rt = 0
for (const f of fx.fixtures) {
  const ids = tok.encode(f.text)
  if (ids.length !== f.ids.length || ids.some((v, i) => v !== f.ids[i])) bad++
  if (tok.decode(ids) !== f.text) rt++
}
ok(bad === 0, `TypeScript encoder: ${fx.fixtures.length} fixtures, ${bad} mismatches`)
ok(rt === 0, `TypeScript round trip: ${rt} failures`)

// 3. Python
const work = mkdtempSync(path.join(tmpdir(), 'sepia1-verify-'))
const texts = path.join(work, 'texts.json')
writeFileSync(texts, JSON.stringify(fx.fixtures.map((f) => f.text)))
const py = `
import json, sys
from tokenizers import Tokenizer
d, texts = sys.argv[1], json.load(open(sys.argv[2], encoding="utf-8"))
tok = Tokenizer.from_file(d + "/tokenizer.json")
out = {"tokenizers": [e.ids for e in tok.encode_batch(texts, add_special_tokens=False)]}
try:
    from transformers import AutoTokenizer
    t = AutoTokenizer.from_pretrained(d)
    out["transformers"] = [t.encode(x, add_special_tokens=False) for x in texts]
except ImportError:
    out["transformers"] = None
json.dump(out, open(sys.argv[3], "w"))
`
const pyOut = path.join(work, 'out.json')
const r = spawnSync(PY, ['-c', py, dir, texts, pyOut], { encoding: 'utf8' })
if (r.status !== 0) ok(false, `python tokenizers: ${r.stderr.trim().split('\n').pop()}`)
else {
  const res = JSON.parse(readFileSync(pyOut, 'utf8'))
  const diff = (arr) => arr.reduce((n, ids, i) => n + (JSON.stringify(ids) === JSON.stringify(fx.fixtures[i].ids) ? 0 : 1), 0)
  ok(diff(res.tokenizers) === 0, `python tokenizers: ${fx.fixtures.length} fixtures, ${diff(res.tokenizers)} mismatches`)
  if (res.transformers) ok(diff(res.transformers) === 0, `transformers AutoTokenizer: ${diff(res.transformers)} mismatches`)
  else console.log('SKIP transformers is not installed')
}
rmSync(work, { recursive: true, force: true })

// 4. card and paths
const readme = readFileSync(path.join(dir, 'README.md'), 'utf8')
ok(readme.startsWith('---\n') && readme.includes('library_name: tokenizers'), 'README.md front matter')
ok(readme.includes('not trained yet'), 'README.md says the SEPIA-1 model is not trained yet')
const local = /[A-Za-z]:[\\/](?:Users|home)|\/home\/\w+\/|\/Users\/\w+\//
for (const name of readdirSync(dir)) {
  const t = readFileSync(path.join(dir, name), 'utf8')
  ok(!local.test(t), `${name} has no local absolute paths`)
}

if (failures) {
  console.error(`${failures} failure(s)`)
  process.exit(1)
}
console.log(`release folder ${dir} verified`)
