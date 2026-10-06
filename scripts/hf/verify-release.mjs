#!/usr/bin/env node
// Numerical check of a SEPIA-0 release folder against the LUSCA model code.
//
//   node scripts/hf/verify-release.mjs --dir <release folder> [--ckpt <sepia.ckpt>] [--contexts 256] [--python python]
//
//   1. model.safetensors holds exactly the checkpoint's float32 weights (bit for bit)
//   2. logits of the folder's inference.py (numpy) and sample.mjs (Node) match the
//      forward pass of shared/sepia/model.mjs within 1e-5 on random contexts
//      (uniform random ids and windows of real text)
//   3. encode() of inference.py and sample.mjs equals the corpus encoder on Unicode edge cases
//   4. same seed → same generated text from model.mjs, sample.mjs and inference.py
//   5. the safetensors Python package (if installed) reads the file to the same arrays
// Without --ckpt, step 1 is skipped and the reference model loads the folder's weights.
// Exits non-zero on any failure.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SepiaModel, encode as refEncode, generateText, mulberry32 } from '../../shared/sepia/model.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const TOL = 1e-5

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const dir = path.resolve(arg('dir', path.join(tmpdir(), 'lusca-hf', 'SEPIA-0')))
const ckptPath = arg('ckpt', null)
const K = Math.max(8, Number(arg('contexts', 256)))
const PY = arg('python', process.env.PYTHON || 'python')

let failures = 0
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`)
  if (!cond) failures++
}

const ex = await import(pathToFileURL(path.join(ROOT, 'server', 'model', 'export.ts')).href)
const weightsPath = path.join(dir, 'model.safetensors')
if (!existsSync(weightsPath)) throw new Error(`no model.safetensors in ${dir}`)
const parsed = ex.parseSafetensors(readFileSync(weightsPath))
const fileParams = new Float32Array(parsed.tensors.reduce((n, t) => n + t.data.length, 0))
{
  let o = 0
  for (const t of parsed.tensors) {
    fileParams.set(t.data, o)
    o += t.data.length
  }
}

// 1. reference weights
let refParams = fileParams
if (ckptPath) {
  const ck = await ex.readCheckpoint(path.resolve(ckptPath))
  refParams = ck.params
  const a = new Uint32Array(ck.params.buffer, ck.params.byteOffset, ck.params.length)
  const b = new Uint32Array(fileParams.buffer)
  let diff = a.length === b.length ? 0 : Infinity
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) diff++
  ok(diff === 0, `model.safetensors = checkpoint step ${ck.step} weights, bit for bit (${ck.params.length} values, ${diff} differ)`)
} else {
  console.log('note: no --ckpt; the reference model uses the folder weights')
}
const ref = new SepiaModel()
ref.load(refParams)
const ref64 = new SepiaModel({ Arr: Float64Array })
ref64.load(refParams)

// 2. contexts: uniform random ids + windows of real text
const rand = mulberry32(20261005)
const text = refEncode(readFileSync(path.join(ROOT, 'README.md'), 'utf8') + '\n' + readFileSync(path.join(ROOT, 'docs', 'SEPIA-1.md'), 'utf8'))
const contexts = []
contexts.push(Array(16).fill(0))
for (let k = 1; k < K; k++) {
  if (k % 2) contexts.push(Array.from({ length: 16 }, () => Math.floor(rand() * 96)))
  else {
    const s = Math.floor(rand() * (text.length - 16))
    contexts.push(Array.from(text.subarray(s, s + 16)))
  }
}
const refLogits = contexts.map((c) => Array.from(ref.logits(Uint8Array.from(c))))
let f64diff = 0
let maxLogit = 0
contexts.forEach((c, k) => {
  const l64 = ref64.logits(Uint8Array.from(c))
  for (let j = 0; j < 96; j++) {
    f64diff = Math.max(f64diff, Math.abs(l64[j] - refLogits[k][j]))
    maxLogit = Math.max(maxLogit, Math.abs(refLogits[k][j]))
  }
})

const s = await import(pathToFileURL(path.join(dir, 'sample.mjs')).href)
const nodeModel = s.loadSepia(weightsPath)
let nodeDiff = 0
contexts.forEach((c, k) => {
  const l = s.logits(nodeModel, c)
  for (let j = 0; j < 96; j++) nodeDiff = Math.max(nodeDiff, Math.abs(l[j] - refLogits[k][j]))
})

// Python side: one process does logits, encode, generation and the safetensors-package check.
const ENC_CASES = [
  'The validator signs an attestation.',
  '  leading spaces,\ttabs\r\nCRLF\n\n\n\nmany blank lines   ',
  'Café façade naïve — “smart quotes” ‘single’ – en dash … ellipsis',
  'ﬁ ligature, ＦＵＬＬＷＩＤＴＨ, NBSP here, ×2, • bullet, ·dot',
  'emoji 🚀 and 𝐁𝐨𝐥𝐝 math, zero​width, soft­hyphen, BOM﻿',
  '\u0085next-line line-sep para-sep\u000bvt\u000cff\u0007bell\u007fdel',
  'ΑΒΓ Ελληνικά, Кириллица, 中文, العربية',
  'prompt with trailing space ',
]
const GEN_CASES = [
  { prompt: 'The validator', n: 240, temperature: 0.8, seed: 7 },
  { prompt: 'Proposal: reduce the quorum', n: 200, temperature: 0.6, seed: 11 },
  { prompt: '', n: 120, temperature: 1.2, seed: 42 },
  { prompt: 'EIP-4844 introduces blob', n: 160, temperature: 0.3, seed: 2026 },
]
const tmp = mkdtempSync(path.join(tmpdir(), 'sepia-verify-'))
const job = path.join(tmp, 'job.json')
const result = path.join(tmp, 'result.json')
writeFileSync(job, JSON.stringify({ contexts, enc: ENC_CASES, gen: GEN_CASES }))
const driver = `
import json, sys
sys.path.insert(0, sys.argv[1])
import numpy as np
from inference import Sepia, encode, generate, mulberry32
job = json.load(open(sys.argv[2], encoding="utf-8"))
m = Sepia(sys.argv[3])
out = {"logits": [m.logits(c).tolist() for c in job["contexts"]],
       "enc": [encode(t, True) for t in job["enc"]] + [encode(t) for t in job["enc"]],
       "gen": [generate(m, g["prompt"], g["n"], g["temperature"], mulberry32(g["seed"])) for g in job["gen"]]}
try:
    from safetensors.numpy import load_file
    st = load_file(sys.argv[3])
    out["st"] = all(np.array_equal(st[k], getattr(m, k)) and st[k].dtype == np.float32 for k in ("emb", "W1", "b1", "W2", "b2"))
except ImportError:
    out["st"] = None
json.dump(out, open(sys.argv[4], "w", encoding="utf-8"))
`
const t0 = Date.now()
// PYTHONDONTWRITEBYTECODE: importing inference.py must not leave a __pycache__ in the release folder.
const py = spawnSync(PY, ['-c', driver, dir, job, weightsPath, result], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
const pyMs = Date.now() - t0
if (py.status !== 0) {
  console.error(py.stderr || py.error)
  ok(false, `python ${PY} ran inference.py`)
} else {
  const r = JSON.parse(readFileSync(result, 'utf8'))
  let pyDiff = 0
  contexts.forEach((_, k) => {
    for (let j = 0; j < 96; j++) pyDiff = Math.max(pyDiff, Math.abs(r.logits[k][j] - refLogits[k][j]))
  })
  ok(nodeDiff <= TOL, `sample.mjs logits vs shared/sepia/model.mjs: max |Δ| = ${nodeDiff.toExponential(2)} over ${K} contexts × 96`)
  ok(pyDiff <= TOL, `inference.py logits vs shared/sepia/model.mjs: max |Δ| = ${pyDiff.toExponential(2)} over ${K} contexts × 96 (python ${(pyMs / 1000).toFixed(1)} s incl. generation)`)
  console.log(`info: |logit| up to ${maxLogit.toFixed(1)}; float32 vs float64 forward differ by up to ${f64diff.toExponential(2)} (why the release files repeat the float32 order)`)

  // 3. encode
  const refEnc = [...ENC_CASES.map((t) => Array.from(refEncode(t, true))), ...ENC_CASES.map((t) => Array.from(refEncode(t)))]
  const nodeEnc = [...ENC_CASES.map((t) => Array.from(s.encode(t, true))), ...ENC_CASES.map((t) => Array.from(s.encode(t)))]
  const same = (a, b) => a.length === b.length && a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]))
  ok(same(nodeEnc, refEnc), `sample.mjs encode = corpus encoder on ${ENC_CASES.length} edge-case strings (both trailing modes)`)
  ok(same(r.enc, refEnc), `inference.py encode = corpus encoder on ${ENC_CASES.length} edge-case strings (both trailing modes)`)

  // 4. generation
  GEN_CASES.forEach((g, i) => {
    const a = generateText(ref, g.prompt, g.n, g.temperature, mulberry32(g.seed))
    const b = s.generate(nodeModel, g.prompt, { n: g.n, temperature: g.temperature, rand: s.mulberry32(g.seed) })
    const c = r.gen[i]
    ok(a === b && b === c, `seed ${g.seed}, T=${g.temperature}, n=${g.n}: model.mjs = sample.mjs = inference.py (${a.length} chars)`)
  })

  // 5. reference safetensors loader
  if (r.st === null) console.log('skip: safetensors Python package not installed')
  else ok(r.st === true, 'safetensors package (safetensors.numpy.load_file) reads identical float32 arrays')
}
rmSync(tmp, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nrelease verified')
process.exit(failures ? 1 : 0)
