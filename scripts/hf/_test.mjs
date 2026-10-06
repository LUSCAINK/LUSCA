#!/usr/bin/env node
// Tests for the Hugging Face release scripts (no network: the Hub is a local stand-in server).
// Run: node scripts/hf/_test.mjs        (Node ≥ 22.18, or: npx tsx scripts/hf/_test.mjs)
//
//   1. build-release.mjs from --weights/--manifest, --from, --manifest-url/--weights-url (and a checkpoint
//      that rolls over between the two GETs): files, config, vocab order, README numbers,
//      copy rules; a tampered manifest is refused
//   2. upload.mjs --dry-run without a token: exact request plan (user namespace LUSCAINK: no organization field)
//   3. upload.mjs over HTTP against a local Hub stand-in: whoami → create → preupload → LFS batch →
//      PUT → verify → commit (NDJSON decodes to the exact files) → tag; repo exists + LFS object
//      already present; wrong namespace and read-only token refused; the token never printed
import { createHash } from 'node:crypto'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SepiaModel, VOCAB, mulberry32 } from '../../shared/sepia/model.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
let failures = 0
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`)
  if (!cond) failures++
}
const sha = (b) => createHash('sha256').update(b).digest('hex')
const ex = await import(pathToFileURL(path.join(ROOT, 'server', 'model', 'export.ts')).href)
const { build } = await import(pathToFileURL(path.join(HERE, 'build-release.mjs')).href)
const up = await import(pathToFileURL(path.join(HERE, 'upload.mjs')).href)

const tmp = mkdtempSync(path.join(tmpdir(), 'lusca-hf-test-'))
const quiet = async (fn) => {
  const orig = console.log
  const lines = []
  console.log = (...a) => lines.push(a.join(' '))
  try {
    return { value: await fn(), lines }
  } finally {
    console.log = orig
  }
}

try {
  // ─── 1. build ──────────────────────────────────────────────────────────────
  const m = new SepiaModel()
  m.init(mulberry32(5))
  const N = m.size
  const params = Float32Array.from(m.params)
  const ck = {
    format: 1,
    version: 12_345,
    step: 12_345,
    adamT: 12_345,
    savedAt: Date.UTC(2026, 9, 5, 18, 30),
    dims: { T: 16, E: 24, H: 384, V: 96 },
    nParams: N,
    params,
    tensors: ex.sepiaTensors(params),
    counters: { serverSteps: 12_000, gpuSteps: 345, gpuSamples: 1_234_560, samplesSeen: 2_002_560, auditsOk: 97, auditsFailed: 4, rejected: 2, stale: 1, contributors24h: 6 },
    loss: 2.3456,
    val: 2.4567,
    historyCount: 493,
  }
  const bundle = ex.buildExport(ck)
  const wPath = path.join(tmp, 'weights.safetensors')
  const mPath = path.join(tmp, 'manifest.json')
  writeFileSync(wPath, bundle.safetensors)
  writeFileSync(mPath, bundle.manifestJson)
  const out = path.join(tmp, 'release')
  const { value: res } = await quiet(() => build(['--weights', wPath, '--manifest', mPath, '--out', out, '--repo', 'example-org/SEPIA-0']))
  const read = (f) => readFileSync(path.join(out, f))
  ok(sha(read('model.safetensors')) === bundle.sha256, 'model.safetensors = the served weights (same sha256)')
  const cfg = JSON.parse(read('config.json').toString())
  ok(cfg.vocab === VOCAB && cfg.vocab.length === 96 && cfg.context === 16 && cfg.embedding === 24 && cfg.hidden === 384 && cfg.activation === 'tanh', 'config.json: vocab (96, in order), context, embedding, hidden, activation')
  ok(cfg.step === 12_345 && cfg.version === 12_345 && cfg.init.W1 === 'normal(0, 1/sqrt(384))' && cfg.optimizer.beta2 === 0.99 && cfg.sha256 === bundle.sha256, 'config.json: step, version, init, optimizer, sha256')
  const vocabText = read('vocab.json').toString()
  const vocab = JSON.parse(vocabText)
  const order = [...vocabText.matchAll(/^ {2}"((?:[^"\\]|\\.)*)": (\d+)/gm)].map((x) => Number(x[2]))
  ok(Object.keys(vocab).length === 96 && order.every((v, i) => v === i) && vocab['\n'] === 0 && vocab['~'] === 95 && vocab['0'] === 17, 'vocab.json: 96 symbols written in id order')
  const readme = read('README.md').toString()
  ok(/^---\nlicense: mit\n[\s\S]*?tags:\n- character-level\n- language-model\n- crypto\n- distributed-training\n- webgpu\n[\s\S]*?---\n/.test(readme), 'README front matter: license + the five tags')
  for (const s of ['## Summary', '## What it is', '## How it was trained', '## Data', '## Architecture', '## Usage', '## Evaluation', '## Limitations', '## Versions', '## License', '## Links', '## Citation']) {
    if (!readme.includes(s)) ok(false, `README section ${s}`)
  }
  ok(true, 'README has all twelve sections')
  ok(
    readme.includes('| Steps from GPU-neuron gradients | 345 |') && readme.includes('| Samples covered by GPU gradients | 1,234,560 |') && readme.includes('| Full audits passed / failed | 97 / 4 |') && readme.includes('| Distinct contributors in the 24 h before this checkpoint | 6 |'),
    'README numbers come from the manifest (GPU steps, GPU samples, audits, contributors)',
  )
  ok(readme.includes('| Train (mean over the last 25 steps) | 2.3456 | 10.44 | 3.384 |') && readme.includes('4.5643 (ln 96)'), 'README evaluation: loss, perplexity, bits/char, uniform baseline')
  ok(readme.includes('`step-12345`') && readme.includes('hf download example-org/SEPIA-0 --revision step-12345'), 'README versions: tag step-<N> and repo id')
  ok(readme.includes(res.sample) && res.sample.startsWith('The validator'), 'README shows the real sample of these weights')
  ok(readme.includes('github.com/LUSCAINK/LUSCA') && readme.includes('docs/SEPIA-1.md') && readme.includes('https://lusca.ink'), 'README links')
  const banned = /crawl|testnet|\bdemo\b|simulat|\bmock|revolution|cutting-edge|game-?chang|unleash|empower/i
  const copy = readme + JSON.stringify(cfg)
  const hit = copy.match(banned) ?? copy.match(/\bINK\b/) // case-sensitive: lusca.ink is fine, INK as a unit is not
  ok(!hit, `README/config copy rules (no banned words${hit ? `: found "${hit[0]}"` : ''})`)
  ok(read('.gitattributes').toString() === '*.safetensors filter=lfs diff=lfs merge=lfs -text\n' && read('LICENSE').toString().startsWith('MIT License'), '.gitattributes and LICENSE')

  // --from: a LUSCA server serving the export routes (handleModelRoute, as wired in server/http.ts)
  const exporter = ex.createWeightsExporter({ ckptPath: 'unused', stat: async () => ({ mtimeMs: 1, size: 1 }), read: async () => ck })
  const lusca = http.createServer((req, res) => {
    void ex.handleModelRoute(new URL(req.url, 'http://x').pathname, req, res, { exporter }).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  await new Promise((r) => lusca.listen(0, '127.0.0.1', r))
  try {
    const outFrom = path.join(tmp, 'release-from')
    await quiet(() => build(['--from', `http://127.0.0.1:${lusca.address().port}`, '--out', outFrom, '--repo', 'example-org/SEPIA-0']))
    const same = ['model.safetensors', 'config.json', 'vocab.json', 'README.md'].every((f) => readFileSync(path.join(outFrom, f)).equals(read(f)))
    ok(same, '--from <server>: fetched manifest + weights build the identical folder')
    const lb = `http://127.0.0.1:${lusca.address().port}`
    const outUrl = path.join(tmp, 'release-url')
    await quiet(() => build(['--manifest-url', `${lb}/api/model/manifest.json`, '--weights-url', `${lb}/api/model/weights.safetensors`, '--out', outUrl, '--repo', 'example-org/SEPIA-0']))
    const sameUrl = ['model.safetensors', 'config.json', 'vocab.json', 'README.md'].every((f) => readFileSync(path.join(outUrl, f)).equals(read(f)))
    ok(sameUrl, '--manifest-url + --weights-url (live URLs): identical folder')
    const outUrl2 = path.join(tmp, 'release-url2')
    await quiet(() => build(['--manifest-url', `${lb}/api/model/manifest.json`, '--out', outUrl2]))
    const readme2 = readFileSync(path.join(outUrl2, 'README.md'), 'utf8')
    ok(readFileSync(path.join(outUrl2, 'model.safetensors')).equals(read('model.safetensors')) && readme2.includes('hf download LUSCAINK/SEPIA-0 --local-dir SEPIA-0') && readme2.includes('https://huggingface.co/LUSCAINK/SEPIA-0'), '--manifest-url alone: weights from the manifest "weights" field; default repo LUSCAINK/SEPIA-0')
  } finally {
    await new Promise((r) => lusca.close(r))
  }

  // A checkpoint rolls over between the manifest GET and the weights GET: the build refetches.
  {
    const ck2 = { ...ck, step: 12_346, version: 12_346, params: Float32Array.from(params, (x) => x * 0.5) }
    ck2.tensors = ex.sepiaTensors(ck2.params)
    const b2 = ex.buildExport(ck2)
    let manifestHits = 0
    const rolling = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://x').pathname
      if (p === '/api/model/manifest.json') {
        manifestHits++
        const body = manifestHits === 1 ? bundle.manifestJson : b2.manifestJson // first answer is the old step
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(body)
      }
      if (p === '/api/model/weights.safetensors') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        return res.end(b2.safetensors) // already the new step
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((r) => rolling.listen(0, '127.0.0.1', r))
    try {
      const outRoll = path.join(tmp, 'release-roll')
      await quiet(() => build(['--manifest-url', `http://127.0.0.1:${rolling.address().port}/api/model/manifest.json`, '--out', outRoll]))
      const cfgRoll = JSON.parse(readFileSync(path.join(outRoll, 'config.json'), 'utf8'))
      ok(manifestHits === 2 && cfgRoll.step === 12_346 && sha(readFileSync(path.join(outRoll, 'model.safetensors'))) === b2.sha256, 'checkpoint rolled between the two GETs: refetched, folder is one consistent step (12346)')
    } finally {
      await new Promise((r) => rolling.close(r))
    }
  }

  const badManifest = { ...JSON.parse(bundle.manifestJson), sha256: '0'.repeat(64) }
  writeFileSync(mPath, JSON.stringify(badManifest))
  let refused = ''
  try {
    await quiet(() => build(['--weights', wPath, '--manifest', mPath, '--out', path.join(tmp, 'bad')]))
  } catch (e) {
    refused = e.message
  }
  ok(/sha256 mismatch/.test(refused), `manifest/weights mismatch refused (${refused.slice(0, 40)}…)`)

  // ─── 2. dry run ────────────────────────────────────────────────────────────
  delete process.env.HF_TOKEN
  delete process.env.HF_ENDPOINT
  const dry = await quiet(() => up.main(['--dir', out, '--org', 'example-org', '--tag', 'auto', '--dry-run']))
  const plan = dry.value.plan
  const seq = plan.steps.map((s) => `${s.method} ${s.url.replace('https://huggingface.co', '')}`)
  ok(
    JSON.stringify(seq) ===
      JSON.stringify([
        'GET /api/whoami-v2',
        'POST /api/repos/create',
        'POST /api/models/example-org/SEPIA-0/preupload/main',
        'POST /example-org/SEPIA-0.git/info/lfs/objects/batch',
        'PUT <actions.upload.href from step 4: presigned; multipart if its header has chunk_size>',
        'POST <actions.verify.href from step 4>',
        'POST /api/models/example-org/SEPIA-0/commit/main',
        'POST /api/models/example-org/SEPIA-0/tag/<commitOid from step 5>',
      ]),
    'dry run (no token): request sequence whoami → create → preupload → LFS batch → PUT → verify → commit → tag',
  )
  ok(JSON.stringify(plan.steps[1].body) === JSON.stringify({ type: 'model', name: 'SEPIA-0', organization: 'example-org', private: false }), 'create body {type, name, organization, private:false}')
  ok(plan.steps[3].body.objects[0].oid === bundle.sha256 && plan.steps[3].body.objects[0].size === bundle.bytes && plan.steps[3].body.hash_algo === 'sha256', 'LFS batch object = sha256 + size of model.safetensors')
  const commitLines = plan.steps[6].body
  ok(commitLines[0].key === 'header' && commitLines[0].value.summary === 'SEPIA-0 step-12345' && commitLines.filter((l) => l.key === 'lfsFile').map((l) => l.value.path).join() === 'model.safetensors' && commitLines.filter((l) => l.key === 'file').length === 7, 'commit: header + 7 regular files + model.safetensors as lfsFile')
  ok(plan.steps[7].body.tag === 'step-12345', 'tag step-12345')
  ok(dry.lines.join('\n').includes('HF_TOKEN is not set') && dry.lines.every((l) => !/Bearer hf_/.test(l)), 'dry run works without a token')
  let tagErr = ''
  try {
    await quiet(() => up.main(['--dir', out, '--tag', 'step-999', '--dry-run']))
  } catch (e) {
    tagErr = e.message
  }
  ok(/does not match config.json step 12345/.test(tagErr), 'a tag that is not step-<config step> is refused')
  // user namespace (the default, LUSCAINK): no "organization" in the create body
  delete process.env.HF_ORG
  const dryU = await quiet(() => up.main(['--dir', out, '--tag', 'step-12345', '--dry-run']))
  const planU = dryU.value.plan
  ok(
    planU.url === 'https://huggingface.co/LUSCAINK/SEPIA-0' && planU.namespaceKind === 'user' && JSON.stringify(planU.steps[1].body) === JSON.stringify({ type: 'model', name: 'SEPIA-0', private: false }),
    'default target LUSCAINK/SEPIA-0 (user): create body {type, name, private:false}, no organization field',
  )
  ok(
    planU.steps[2].url.endsWith('/api/models/LUSCAINK/SEPIA-0/preupload/main') && planU.steps[3].url.endsWith('/LUSCAINK/SEPIA-0.git/info/lfs/objects/batch') && planU.steps[6].url.endsWith('/api/models/LUSCAINK/SEPIA-0/commit/main') && planU.steps[7].body.tag === 'step-12345',
    'user plan: preupload, LFS batch, commit and tag step-12345 on LUSCAINK/SEPIA-0',
  )
  const dryU2 = await quiet(() => up.main(['--dir', out, '--user', 'LUSCAINK', '--tag', 'step-12345', '--dry-run']))
  ok(JSON.stringify(dryU2.value.plan.steps[1].body) === JSON.stringify(planU.steps[1].body) && dryU2.lines.some((l) => l.includes('(user account LUSCAINK), tag step-12345')), '--user LUSCAINK: same plan, printed as a user account')
  const dryR = await quiet(() => up.main(['--dir', out, '--repo', 'example-org/SEPIA-0', '--namespace-kind', 'org', '--dry-run']))
  ok(dryR.value.plan.steps[1].body.organization === 'example-org', '--repo + --namespace-kind org: organization field present')
  process.env.HF_TOKEN = 'hf_localtest_dryrun_0123456789'
  const dry2 = await quiet(() => up.main(['--dir', out, '--dry-run', '--tag', 'step-12345']))
  ok(dry2.lines.join('\n').includes('is set (not shown)') && !dry2.lines.join('\n').includes('hf_localtest_dryrun'), 'dry run with a token set: token not printed')

  // ─── 3. HTTP upload against a local Hub stand-in ───────────────────────────
  const TOKEN = 'hf_localtest_write_9876543210'
  const hub = { reqs: [], exists: false, lfsPresent: false, role: 'write', user: 'someone', commits: [] }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const u = new URL(req.url, 'http://x')
      hub.reqs.push({ method: req.method, path: u.pathname, auth: req.headers.authorization ?? null, type: req.headers['content-type'] ?? null, body })
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      const authed = req.headers.authorization === `Bearer ${TOKEN}`
      if (u.pathname.startsWith('/s3/')) {
        if (req.method === 'PUT') {
          hub.uploaded = body
          return json(200, {})
        }
        return json(200, {})
      }
      if (!authed) return json(401, { error: 'Invalid credentials' })
      if (u.pathname === '/api/whoami-v2') return json(200, { type: 'user', name: hub.user, orgs: [{ name: 'example-org' }], auth: { accessToken: { role: hub.role } } })
      if (u.pathname === '/api/repos/create') return hub.exists ? json(409, { error: 'You already created this model repo' }) : json(200, { url: `${base}/${JSON.parse(body.toString()).organization ?? hub.user}/SEPIA-0` })
      if (/^\/api\/models\/[\w.-]+\/SEPIA-0\/preupload\/main$/.test(u.pathname)) {
        const files = JSON.parse(body.toString()).files
        return json(200, { files: files.map((f) => ({ path: f.path, uploadMode: f.path.endsWith('.safetensors') ? 'lfs' : 'regular', shouldIgnore: false })) })
      }
      if (/^\/[\w.-]+\/SEPIA-0\.git\/info\/lfs\/objects\/batch$/.test(u.pathname)) {
        const b = JSON.parse(body.toString())
        return json(200, {
          transfer: 'basic',
          objects: b.objects.map((o) => (hub.lfsPresent ? { oid: o.oid, size: o.size } : { oid: o.oid, size: o.size, actions: { upload: { href: `${base}/s3/upload/${o.oid}` }, verify: { href: `${base}/s3/verify`, header: { 'X-Verify': '1' } } } })),
        })
      }
      if (/^\/api\/models\/[\w.-]+\/SEPIA-0\/commit\/main$/.test(u.pathname)) {
        hub.commits.push(body.toString())
        return json(200, { commitOid: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00', commitUrl: `${base}/example-org/SEPIA-0/commit/c0ffee00` })
      }
      if (/^\/api\/models\/[\w.-]+\/SEPIA-0\/tag\//.test(u.pathname)) return json(200, {})
      json(404, { error: 'not found' })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    process.env.HF_TOKEN = TOKEN
    const run1 = await quiet(() => up.main(['--dir', out, '--org', 'example-org', '--tag', 'auto', '--endpoint', base]))
    const paths = hub.reqs.map((r) => `${r.method} ${r.path}`)
    ok(
      JSON.stringify(paths) ===
        JSON.stringify([
          'GET /api/whoami-v2',
          'POST /api/repos/create',
          'POST /api/models/example-org/SEPIA-0/preupload/main',
          'POST /example-org/SEPIA-0.git/info/lfs/objects/batch',
          `PUT /s3/upload/${bundle.sha256}`,
          'POST /s3/verify',
          'POST /api/models/example-org/SEPIA-0/commit/main',
          'POST /api/models/example-org/SEPIA-0/tag/c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
        ]),
      `HTTP upload: ${paths.length} requests in the planned order`,
    )
    ok(hub.reqs.filter((r) => !r.path.startsWith('/s3/upload')).every((r) => r.auth === `Bearer ${TOKEN}`) && hub.reqs.find((r) => r.method === 'PUT').auth === null, 'Bearer token on Hub calls; none on the presigned PUT')
    ok(sha(hub.uploaded) === bundle.sha256, 'LFS PUT body is exactly model.safetensors')
    const pre = JSON.parse(hub.reqs[2].body.toString()).files.find((f) => f.path === 'model.safetensors')
    ok(Buffer.from(pre.sample, 'base64').equals(read('model.safetensors').subarray(0, 512)) && pre.size === bundle.bytes, 'preupload sample = first 512 bytes, size')
    ok(hub.reqs[6].type === 'application/x-ndjson', 'commit is application/x-ndjson')
    const lines = hub.commits[0].split('\n').map((l) => JSON.parse(l))
    const filesOk = lines
      .filter((l) => l.key === 'file')
      .every((l) => Buffer.from(l.value.content, 'base64').equals(read(l.value.path)))
    const lfsLine = lines.find((l) => l.key === 'lfsFile')
    ok(filesOk && lines.filter((l) => l.key === 'file').length === 7, 'every regular file in the commit decodes to the exact folder bytes')
    ok(lfsLine.value.oid === bundle.sha256 && lfsLine.value.size === bundle.bytes && lfsLine.value.algo === 'sha256', 'lfsFile line: sha256 oid + size')
    ok(JSON.parse(hub.reqs[7].body.toString()).tag === 'step-12345', 'tag step-12345 created on the commit oid')
    ok(!run1.lines.join('\n').includes(TOKEN), 'upload output never contains the token')
    ok(JSON.parse(hub.reqs[1].body.toString()).organization === 'example-org', 'organization namespace: create body names the organization')

    // user namespace: the token user is LUSCAINK, default target → no organization field
    hub.reqs = []
    hub.user = 'LUSCAINK'
    const runU = await quiet(() => up.main(['--dir', out, '--tag', 'step-12345', '--endpoint', base]))
    const createU = JSON.parse(hub.reqs[1].body.toString())
    ok(
      JSON.stringify(createU) === JSON.stringify({ type: 'model', name: 'SEPIA-0', private: false }) && hub.reqs.some((r) => r.path === '/api/models/LUSCAINK/SEPIA-0/commit/main') && hub.reqs.some((r) => r.path.startsWith('/api/models/LUSCAINK/SEPIA-0/tag/')) && runU.value.namespaceKind === 'user',
      'HTTP upload to the user LUSCAINK: create without organization, commit + tag step-12345 on LUSCAINK/SEPIA-0',
    )
    // a --repo guess that says org is corrected by whoami
    hub.reqs = []
    const runU2 = await quiet(() => up.main(['--dir', out, '--repo', 'LUSCAINK/SEPIA-0', '--namespace-kind', 'org', '--endpoint', base]))
    ok(!('organization' in JSON.parse(hub.reqs[1].body.toString())) && runU2.lines.some((l) => l.includes('using user (from whoami)')), 'whoami overrides a wrong namespace-kind guess (user → no organization field)')
    hub.user = 'someone'
    hub.exists = false
    hub.lfsPresent = false

    // second run: repo exists, LFS object already on the Hub → no PUT
    hub.reqs = []
    hub.exists = true
    hub.lfsPresent = true
    await quiet(() => up.main(['--dir', out, '--org', 'example-org', '--endpoint', base]))
    ok(!hub.reqs.some((r) => r.method === 'PUT') && hub.reqs.some((r) => r.path.endsWith('/commit/main')) && !hub.reqs.some((r) => r.path.includes('/tag/')), 'repo exists (409) + object present: no PUT, commit, no tag without --tag')

    // refusals before anything is created
    hub.reqs = []
    let err = ''
    try {
      await quiet(() => up.main(['--dir', out, '--org', 'not-mine', '--endpoint', base]))
    } catch (e) {
      err = e.message
    }
    ok(/cannot write to "not-mine"/.test(err) && hub.reqs.length === 1, 'namespace the token cannot write to: refused after whoami only')
    hub.reqs = []
    hub.role = 'read'
    err = ''
    try {
      await quiet(() => up.main(['--dir', out, '--org', 'example-org', '--endpoint', base]))
    } catch (e) {
      err = e.message
    }
    ok(/read-only token/.test(err) && hub.reqs.length === 1, 'read-only token: refused after whoami only')
    delete process.env.HF_TOKEN
    err = ''
    try {
      await quiet(() => up.main(['--dir', out, '--endpoint', base]))
    } catch (e) {
      err = e.message
    }
    ok(/HF_TOKEN is not set/.test(err), 'real upload without HF_TOKEN refused')
  } finally {
    await new Promise((r) => server.close(r))
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0 // not process.exit(): see server/model/_test.ts (libuv assertion on Windows)
