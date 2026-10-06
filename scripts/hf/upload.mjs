#!/usr/bin/env node
// Upload a SEPIA-0 release folder (scripts/hf/build-release.mjs) to the Hugging Face Hub.
//
//   node scripts/hf/upload.mjs --dir <folder> [--user <name> | --org <name> | --repo <ns>/<name> [--namespace-kind user|org]]
//                              [--tag step-<N> | --tag auto] [--dry-run] [--plan-out plan.json] [--via http|python] [--message "…"]
//
// Default target: the user account LUSCAINK → https://huggingface.co/LUSCAINK/SEPIA-0.
//
// The token is read from the HF_TOKEN environment variable only and is never printed,
// logged or written to the plan (requests show "Bearer $HF_TOKEN").
//
// --via http (default, no dependencies) uses the Hub HTTP API:
//   1. GET  /api/whoami-v2                                   token valid, has write access, namespace allowed
//   2. POST /api/repos/create  {type, name, private:false}   409 = already exists (fine)
//      ("organization": <ns> is added only when the namespace is an organization; for a user
//      namespace the field is omitted and the Hub creates the repo under the token's account)
//   3. POST /api/models/<repo>/preupload/main                the Hub decides regular vs LFS per file
//   4. POST /<repo>.git/info/lfs/objects/batch               LFS upload actions (sha256 oid + size)
//      PUT  <upload href> (single part, or each part + completion for multipart), then POST <verify href>
//   5. POST /api/models/<repo>/commit/main  (application/x-ndjson: header, file, lfsFile lines)
//   6. POST /api/models/<repo>/tag/<commit>  {tag}           only with --tag
// --via python uses huggingface_hub (HfApi.create_repo / upload_folder / create_tag) when it is
// installed (python -c "import huggingface_hub"); the token reaches it through the environment.
//
// --dry-run sends nothing and prints the exact request plan (works without a token).
// --tag must be step-<N> with N = config.json "step" (--tag auto picks it), as the model card promises.
// Namespace: --repo <ns>/<name>, else --user <name> or --org <name> (or $HF_ORG) + "/SEPIA-0", else the
// user LUSCAINK. The kind (user or org) is --user/--org, or --namespace-kind with --repo (default user).
// A real upload re-derives it from whoami (ns = token user → user, ns in its orgs → org), so a wrong
// guess changes only the dry-run plan.
// HF_ENDPOINT (or --endpoint) overrides https://huggingface.co (tests use a local mock).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIRED = ['model.safetensors', 'config.json', 'README.md']
const LFS_HEADERS = { Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' }
const AUTH_SHOWN = 'Bearer $HF_TOKEN'
// Patterns the Hub's default .gitattributes stores in LFS (subset relevant here) + binary check.
const DEFAULT_LFS = ['*.safetensors', '*.bin', '*.pt', '*.pth', '*.ckpt', '*.h5', '*.onnx', '*.npy', '*.npz', '*.pkl', '*.zip', '*.gz', '*.tar']

// ─── args ───────────────────────────────────────────────────────────────────

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const k = a.slice(2)
    if (k === 'dry-run' || k === 'help' || k === 'private') {
      o[k] = true
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
const enc = encodeURIComponent

/** @param {string} pattern @param {string} file */
function globMatch(pattern, file) {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  return re.test(file)
}

/** LFS patterns from a .gitattributes text. @param {string} text */
function lfsPatterns(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && /\bfilter=lfs\b/.test(l))
    .map((l) => l.split(/\s+/)[0])
}

// ─── plan ───────────────────────────────────────────────────────────────────

/**
 * Everything the upload needs, computed from the folder alone (no network, no token).
 * @param {{ dir: string, repo: string, namespaceKind?: 'user' | 'org', tag?: string | null, message?: string, private?: boolean, endpoint?: string }} o
 */
export function loadRelease(o) {
  const dir = path.resolve(o.dir)
  const names = readdirSync(dir).filter((f) => statSync(path.join(dir, f)).isFile()).sort()
  for (const r of REQUIRED) if (!names.includes(r)) throw new Error(`${dir} has no ${r} (build it with scripts/hf/build-release.mjs)`)
  const config = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'))
  if (config.name !== 'SEPIA-0' || !Number.isInteger(config.step)) throw new Error('config.json is not a SEPIA-0 release config')
  const gitattributes = names.includes('.gitattributes') ? readFileSync(path.join(dir, '.gitattributes'), 'utf8') : ''
  const patterns = [...new Set([...lfsPatterns(gitattributes), ...DEFAULT_LFS])]
  const files = names.map((name) => {
    const bytes = readFileSync(path.join(dir, name))
    const binary = bytes.subarray(0, 8000).includes(0)
    return {
      path: name,
      bytes,
      size: bytes.length,
      sha256: sha256(bytes),
      sample: bytes.subarray(0, 512).toString('base64'),
      predictedMode: /** @type {'lfs' | 'regular'} */ (patterns.some((p) => globMatch(p, name)) || binary || bytes.length > 10 * 1024 * 1024 ? 'lfs' : 'regular'),
    }
  })
  const weights = files.find((f) => f.path === 'model.safetensors')
  if (!weights || config.sha256 !== weights.sha256) throw new Error(`model.safetensors sha256 ${weights?.sha256} ≠ config.json sha256 ${config.sha256}: rebuild the folder`)

  let tag = null
  if (o.tag) {
    tag = o.tag === 'auto' ? `step-${config.step}` : o.tag
    if (!/^step-\d+$/.test(tag)) throw new Error(`--tag ${tag}: tags are step-<N>`)
    if (tag !== `step-${config.step}`) throw new Error(`--tag ${tag} does not match config.json step ${config.step} (use --tag step-${config.step} or --tag auto)`)
  }
  const [namespace, name] = o.repo.split('/')
  if (!namespace || !name || o.repo.split('/').length !== 2 || !/^[\w.-]+$/.test(namespace) || !/^[\w.-]+$/.test(name)) throw new Error(`--repo ${o.repo} is not <namespace>/<name>`)
  const summary = o.message || `SEPIA-0 step-${config.step}`
  const description = [
    `SEPIA-0 checkpoint at optimizer step ${config.step} (saved ${config.saved_at}).`,
    `model.safetensors sha256 ${weights.sha256}, ${weights.size} bytes.`,
    `Train loss ${config.loss ?? 'not recorded'}, validation loss ${config.val ?? 'not recorded'} (nats per character).`,
    `Source: ${config.source}`,
  ].join('\n')
  const namespaceKind = /** @type {'user' | 'org'} */ (o.namespaceKind === 'org' ? 'org' : 'user')
  return { dir, repo: o.repo, namespace, namespaceKind, name, config, files, tag, summary, description, private: o.private === true, endpoint: (o.endpoint || 'https://huggingface.co').replace(/\/+$/, '') }
}

/**
 * POST /api/repos/create body. A user namespace has no "organization" field: the Hub creates
 * the repo under the token's own account. An organization namespace names it.
 * @param {{ name: string, namespace: string, private: boolean }} rel @param {'user' | 'org'} kind
 */
export function createRepoBody(rel, kind) {
  return kind === 'org' ? { type: 'model', name: rel.name, organization: rel.namespace, private: rel.private } : { type: 'model', name: rel.name, private: rel.private }
}

/** @typedef {ReturnType<typeof loadRelease>} Release */

/** NDJSON commit body. @param {Release} rel @param {Record<string, 'lfs' | 'regular'>} modes */
export function commitBody(rel, modes) {
  const lines = [{ key: 'header', value: { summary: rel.summary, description: rel.description } }]
  for (const f of rel.files) {
    if (modes[f.path] === 'lfs') lines.push({ key: 'lfsFile', value: { path: f.path, algo: 'sha256', oid: f.sha256, size: f.size } })
    else lines.push({ key: 'file', value: { content: f.bytes.toString('base64'), path: f.path, encoding: 'base64' } })
  }
  return lines.map((l) => JSON.stringify(l)).join('\n')
}

/**
 * The exact request sequence of an HTTP upload, with predicted upload modes. Bodies are
 * real except that base64 file contents are summarised; the token is never included.
 * @param {Release} rel
 */
export function buildPlan(rel) {
  const E = rel.endpoint
  const modes = Object.fromEntries(rel.files.map((f) => [f.path, f.predictedMode]))
  const lfs = rel.files.filter((f) => modes[f.path] === 'lfs')
  const auth = { Authorization: AUTH_SHOWN }
  /** @type {any[]} */
  const steps = [
    { step: 1, what: 'check the token and the namespace', method: 'GET', url: `${E}/api/whoami-v2`, headers: auth },
    {
      step: 2,
      what: `create the model repo in the ${rel.namespaceKind === 'org' ? 'organization' : 'user account'} ${rel.namespace} (409 = it already exists, continue)`,
      method: 'POST',
      url: `${E}/api/repos/create`,
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: createRepoBody(rel, rel.namespaceKind),
    },
    {
      step: 3,
      what: 'ask the Hub which files go to LFS',
      method: 'POST',
      url: `${E}/api/models/${rel.repo}/preupload/main`,
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: { files: rel.files.map((f) => ({ path: f.path, sample: `<base64 of the first ${Math.min(512, f.size)} bytes>`, size: f.size })) },
      expect: Object.fromEntries(rel.files.map((f) => [f.path, f.predictedMode])),
    },
  ]
  if (lfs.length) {
    steps.push({
      step: 4,
      what: 'LFS batch: get upload actions',
      method: 'POST',
      url: `${E}/${rel.repo}.git/info/lfs/objects/batch`,
      headers: { ...auth, ...LFS_HEADERS },
      body: { operation: 'upload', transfers: ['basic', 'multipart'], objects: lfs.map((f) => ({ oid: f.sha256, size: f.size })), hash_algo: 'sha256', ref: { name: 'main' } },
    })
    for (const f of lfs) {
      steps.push({ step: '4a', what: `upload ${f.path} (skipped if the Hub already has this oid)`, method: 'PUT', url: '<actions.upload.href from step 4: presigned; multipart if its header has chunk_size>', headers: {}, body: `<${f.path}: ${f.size} bytes, sha256 ${f.sha256}>` })
      steps.push({ step: '4b', what: `verify ${f.path}`, method: 'POST', url: '<actions.verify.href from step 4>', headers: { ...auth, ...LFS_HEADERS, '…': '<actions.verify.header>' }, body: { oid: f.sha256, size: f.size } })
    }
  }
  steps.push({
    step: 5,
    what: 'commit all files to main',
    method: 'POST',
    url: `${E}/api/models/${rel.repo}/commit/main`,
    headers: { ...auth, 'Content-Type': 'application/x-ndjson' },
    body: commitBody(rel, modes)
      .split('\n')
      .map((l) => {
        const j = JSON.parse(l)
        if (j.key === 'file') j.value.content = `<base64 of ${j.value.path}: ${rel.files.find((f) => f.path === j.value.path)?.size} bytes, sha256 ${rel.files.find((f) => f.path === j.value.path)?.sha256}>`
        return j
      }),
  })
  if (rel.tag) {
    steps.push({ step: 6, what: `tag the commit ${rel.tag}`, method: 'POST', url: `${E}/api/models/${rel.repo}/tag/<commitOid from step 5>`, headers: { ...auth, 'Content-Type': 'application/json' }, body: { tag: rel.tag, message: `SEPIA-0 optimizer step ${rel.config.step}` } })
  }
  return {
    repo: rel.repo,
    namespaceKind: rel.namespaceKind,
    url: `${E}/${rel.repo}`,
    tag: rel.tag,
    summary: rel.summary,
    files: rel.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, mode: f.predictedMode })),
    steps,
  }
}

// ─── HTTP execution ─────────────────────────────────────────────────────────

/**
 * fetch with retries on 429/5xx. Errors carry the status and a short body, never the token.
 * @param {string} what @param {string} url @param {RequestInit & { ok?: number[] }} init
 */
async function call(what, url, init) {
  const okStatus = init.ok ?? []
  let last = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    let res
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) })
    } catch (e) {
      last = e instanceof Error ? e.message : String(e)
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      continue
    }
    if (res.ok || okStatus.includes(res.status)) return res
    const text = (await res.text().catch(() => '')).slice(0, 300)
    last = `HTTP ${res.status} ${text}`
    if (res.status !== 429 && res.status < 500) break
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
  }
  throw new Error(`${what} failed: ${last}`)
}

/** @param {Release} rel @param {string} token @param {(s: string) => void} log */
export async function uploadHttp(rel, token, log) {
  const E = rel.endpoint
  const auth = { Authorization: `Bearer ${token}` }
  const json = { ...auth, 'Content-Type': 'application/json' }

  // 1. whoami
  const who = await (await call('whoami', `${E}/api/whoami-v2`, { headers: auth })).json()
  const allowed = [who.name, ...(Array.isArray(who.orgs) ? who.orgs.map((/** @type {any} */ o) => o.name) : [])].filter(Boolean)
  if (who?.auth?.accessToken?.role === 'read') throw new Error('HF_TOKEN is a read-only token; create a token with write access')
  if (!allowed.includes(rel.namespace)) throw new Error(`HF_TOKEN (user ${who.name}) cannot write to "${rel.namespace}"; namespaces available: ${allowed.join(', ') || 'none'}`)
  const kind = rel.namespace === who.name ? 'user' : 'org'
  log(`1/6 token ok (user ${who.name}); ${rel.namespace} is ${kind === 'user' ? 'the token user' : 'an organization of the token user'}`)
  if (kind !== rel.namespaceKind) log(`    note: the plan assumed a${rel.namespaceKind === 'org' ? 'n organization' : ' user'} namespace; using ${kind} (from whoami)`)

  // 2. create repo
  const cr = await call('create repo', `${E}/api/repos/create`, { method: 'POST', headers: json, body: JSON.stringify(createRepoBody(rel, kind)), ok: [409] })
  log(cr.status === 409 ? `2/6 repo ${rel.repo} exists` : `2/6 repo ${rel.repo} created`)

  // 3. preupload
  const pre = await (
    await call('preupload', `${E}/api/models/${rel.repo}/preupload/main`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ files: rel.files.map((f) => ({ path: f.path, sample: f.sample, size: f.size })) }),
    })
  ).json()
  /** @type {Record<string, 'lfs' | 'regular'>} */
  const modes = {}
  for (const f of pre.files ?? []) modes[f.path] = f.uploadMode === 'lfs' ? 'lfs' : 'regular'
  for (const f of rel.files) if (!modes[f.path]) throw new Error(`preupload did not answer for ${f.path}`)
  const lfs = rel.files.filter((f) => modes[f.path] === 'lfs')
  log(`3/6 upload modes: ${rel.files.map((f) => `${f.path}=${modes[f.path]}`).join(', ')}`)

  // 4. LFS
  if (lfs.length) {
    const batch = await (
      await call('LFS batch', `${E}/${rel.repo}.git/info/lfs/objects/batch`, {
        method: 'POST',
        headers: { ...auth, ...LFS_HEADERS },
        body: JSON.stringify({ operation: 'upload', transfers: ['basic', 'multipart'], objects: lfs.map((f) => ({ oid: f.sha256, size: f.size })), hash_algo: 'sha256', ref: { name: 'main' } }),
      })
    ).json()
    for (const f of lfs) {
      const obj = (batch.objects ?? []).find((/** @type {any} */ o) => o.oid === f.sha256)
      if (!obj) throw new Error(`LFS batch did not answer for ${f.path}`)
      if (obj.error) throw new Error(`LFS batch refused ${f.path}: ${obj.error.code} ${obj.error.message}`)
      const up = obj.actions?.upload
      if (!up) {
        log(`4/6 ${f.path}: already on the Hub`)
        continue
      }
      const header = up.header ?? {}
      if (header.chunk_size) {
        const chunk = Number(header.chunk_size)
        const partKeys = Object.keys(header).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b))
        const parts = []
        for (const k of partKeys) {
          const i = Number(k) - 1
          const r = await call(`upload part ${k}`, header[k], { method: 'PUT', body: f.bytes.subarray(i * chunk, (i + 1) * chunk) })
          parts.push({ partNumber: Number(k), etag: r.headers.get('etag') ?? '' })
        }
        await call('multipart completion', up.href, { method: 'POST', headers: LFS_HEADERS, body: JSON.stringify({ oid: f.sha256, parts }) })
      } else {
        // Single part: a presigned URL, sent without extra headers (as huggingface_hub does).
        await call(`upload ${f.path}`, up.href, { method: 'PUT', body: f.bytes })
      }
      const verify = obj.actions?.verify
      if (verify) await call(`verify ${f.path}`, verify.href, { method: 'POST', headers: { ...auth, ...LFS_HEADERS, ...(verify.header ?? {}) }, body: JSON.stringify({ oid: f.sha256, size: f.size }) })
      log(`4/6 ${f.path}: uploaded (${f.size} bytes)`)
    }
  } else {
    log('4/6 no LFS files')
  }

  // 5. commit
  const commit = await (
    await call('commit', `${E}/api/models/${rel.repo}/commit/main`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-ndjson' }, body: commitBody(rel, modes) })
  ).json()
  log(`5/6 commit ${commit.commitOid ?? '?'} ${commit.commitUrl ?? ''}`)

  // 6. tag
  if (rel.tag) {
    const rev = commit.commitOid || 'main'
    await call('tag', `${E}/api/models/${rel.repo}/tag/${enc(rev)}`, { method: 'POST', headers: json, body: JSON.stringify({ tag: rel.tag, message: `SEPIA-0 optimizer step ${rel.config.step}` }) })
    log(`6/6 tagged ${rel.tag}: ${E}/${rel.repo}/tree/${rel.tag}`)
  }
  return { commitOid: commit.commitOid ?? null, commitUrl: commit.commitUrl ?? null, url: `${E}/${rel.repo}`, namespaceKind: kind, modes }
}

// ─── huggingface_hub execution ──────────────────────────────────────────────

/** @param {string} py */
export function huggingfaceHubVersion(py = process.env.PYTHON || 'python') {
  const r = spawnSync(py, ['-c', 'import huggingface_hub; print(huggingface_hub.__version__)'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

const PY_UPLOAD = `
import json, sys
from huggingface_hub import HfApi
a = json.loads(sys.argv[1])
api = HfApi(endpoint=a["endpoint"])  # token: HF_TOKEN from the environment
api.create_repo(a["repo"], repo_type="model", private=a["private"], exist_ok=True)
info = api.upload_folder(repo_id=a["repo"], repo_type="model", folder_path=a["dir"], allow_patterns=a["files"],
                         commit_message=a["summary"], commit_description=a["description"])
oid = getattr(info, "oid", None)
if a["tag"]:
    api.create_tag(a["repo"], tag=a["tag"], revision=oid or "main", tag_message="SEPIA-0 optimizer step %d" % a["step"])
print(json.dumps({"commitOid": oid, "commitUrl": getattr(info, "commit_url", None)}))
`

/** @param {Release} rel */
function pythonArgs(rel) {
  return { endpoint: rel.endpoint, repo: rel.repo, private: rel.private, dir: rel.dir, files: rel.files.map((f) => f.path), summary: rel.summary, description: rel.description, tag: rel.tag, step: rel.config.step }
}

// ─── main ───────────────────────────────────────────────────────────────────

/** @param {string[]} argv @param {(s: string) => void} [log] */
export async function main(argv, log = (s) => console.log(s)) {
  const a = parseArgs(argv)
  if (a.help) {
    const lines = readFileSync(new URL(import.meta.url), 'utf8').split(/\r?\n/).slice(1) // after the shebang
    log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.slice(3)).join('\n'))
    return null
  }
  if (!a.dir) throw new Error('--dir <release folder> is required')
  if ([a.repo, a.user, a.org].filter((x) => typeof x === 'string').length > 1) throw new Error('use one of --repo, --user, --org')
  const nk = a['namespace-kind']
  if (nk !== undefined && nk !== 'user' && nk !== 'org') throw new Error('--namespace-kind is user or org')
  if (nk !== undefined && typeof a.repo !== 'string') throw new Error('--namespace-kind goes with --repo (--user and --org already say it)')
  const envOrg = process.env.HF_ORG?.trim()
  /** @type {string} */
  let repo
  /** @type {'user' | 'org'} */
  let namespaceKind
  if (typeof a.repo === 'string') [repo, namespaceKind] = [a.repo, nk === 'org' ? 'org' : 'user']
  else if (typeof a.user === 'string') [repo, namespaceKind] = [`${a.user}/SEPIA-0`, 'user']
  else if (typeof a.org === 'string') [repo, namespaceKind] = [`${a.org}/SEPIA-0`, 'org']
  else if (envOrg) [repo, namespaceKind] = [`${envOrg}/SEPIA-0`, 'org']
  else [repo, namespaceKind] = ['LUSCAINK/SEPIA-0', 'user']
  const via = a.via === 'python' ? 'python' : 'http'
  if (a.via && a.via !== 'python' && a.via !== 'http') throw new Error('--via is http or python')
  const rel = loadRelease({
    dir: String(a.dir),
    repo,
    namespaceKind,
    tag: typeof a.tag === 'string' ? a.tag : null,
    message: typeof a.message === 'string' ? a.message : undefined,
    private: a.private === true,
    endpoint: typeof a.endpoint === 'string' ? a.endpoint : process.env.HF_ENDPOINT,
  })
  const token = process.env.HF_TOKEN?.trim() || ''

  if (a['dry-run']) {
    const plan = buildPlan(rel)
    const hub = huggingfaceHubVersion()
    log(`DRY RUN: nothing is sent. HF_TOKEN ${token ? 'is set (not shown)' : 'is not set'}. huggingface_hub ${hub ?? 'not installed'}. via ${via}.`)
    log(`target ${plan.url} (${rel.namespaceKind === 'org' ? 'organization' : 'user account'} ${rel.namespace})${rel.tag ? `, tag ${rel.tag}` : ', no tag'}; commit "${rel.summary}"`)
    for (const f of plan.files) log(`  ${f.path.padEnd(18)} ${String(f.size).padStart(8)} B  ${f.mode.padEnd(7)}  sha256 ${f.sha256}`)
    if (via === 'python') {
      log('\nhuggingface_hub calls (token from the environment):')
      log(`  HfApi(endpoint="${rel.endpoint}").create_repo("${rel.repo}", repo_type="model", private=${rel.private ? 'True' : 'False'}, exist_ok=True)`)
      log(`  upload_folder(repo_id="${rel.repo}", folder_path="${rel.dir}", allow_patterns=${JSON.stringify(rel.files.map((f) => f.path))}, commit_message="${rel.summary}")`)
      if (rel.tag) log(`  create_tag("${rel.repo}", tag="${rel.tag}", revision=<commit oid>)`)
    } else {
      log('\nrequest plan:')
      for (const s of plan.steps) {
        log(`\n[${s.step}] ${s.what}\n    ${s.method} ${s.url}\n    headers ${JSON.stringify(s.headers)}`)
        if (s.body !== undefined) log(`    body ${typeof s.body === 'string' ? s.body : JSON.stringify(s.body, null, 2).replace(/\n/g, '\n    ')}`)
      }
    }
    if (typeof a['plan-out'] === 'string') {
      writeFileSync(a['plan-out'], JSON.stringify(plan, null, 2) + '\n')
      log(`\nplan written to ${path.resolve(a['plan-out'])}`)
    }
    return { dryRun: true, plan }
  }

  if (!token) throw new Error('HF_TOKEN is not set (export a write token as HF_TOKEN, or use --dry-run)')
  if (via === 'python') {
    const v = huggingfaceHubVersion()
    if (!v) throw new Error('huggingface_hub is not installed (pip install huggingface_hub) — or use --via http')
    log(`uploading ${rel.dir} → ${rel.repo} with huggingface_hub ${v}`)
    const r = spawnSync(process.env.PYTHON || 'python', ['-c', PY_UPLOAD, JSON.stringify(pythonArgs(rel))], { encoding: 'utf8', env: { ...process.env, HF_TOKEN: token } })
    if (r.status !== 0) throw new Error(`huggingface_hub upload failed: ${(r.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ').replaceAll(token, '<HF_TOKEN>')}`)
    const out = JSON.parse(r.stdout.trim().split('\n').pop() || '{}')
    log(`done: ${out.commitUrl ?? `${rel.endpoint}/${rel.repo}`}${rel.tag ? ` (tag ${rel.tag})` : ''}`)
    return out
  }
  log(`uploading ${rel.dir} → ${rel.endpoint}/${rel.repo}${rel.tag ? ` (tag ${rel.tag})` : ''}`)
  const out = await uploadHttp(rel, token, log)
  log(`done: ${out.url}`)
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    const token = process.env.HF_TOKEN?.trim()
    let msg = e instanceof Error ? e.message : String(e)
    if (token) msg = msg.replaceAll(token, '<HF_TOKEN>')
    console.error(`upload: ${msg}`)
    process.exit(1)
  })
}
