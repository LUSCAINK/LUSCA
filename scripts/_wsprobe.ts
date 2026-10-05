// End-to-end probe for a running LUSCA server.
//
//   npx tsx scripts/_wsprobe.ts [ws://127.0.0.1:8787/ws] [--watch=8] [--loss=90] [--gflops=2000] [--no-http]
//
// 1. connects to /ws and validates the hello greeting,
// 2. watches the live stream for --watch seconds and counts message types,
// 3. registers as a test neuron, requests a job, solves it with the CPU
//    reference (bestMatchesCPU) and expects an `ink` event with verified=true,
// 4. requests a second job, returns a deliberately corrupted answer and
//    expects verified=false,
// 5. waits up to --loss seconds for a trainer `loss` message (skipped if one
//    already arrived),
// 6. checks the HTTP hardening (JSON-only POSTs, foreign Origin / Host refused,
//    foreign-Origin websocket refused) unless --no-http,
// then leaves cleanly. Exits 0 when every check passed, 1 otherwise.

import http from 'node:http'
import WebSocket from 'ws'
import { bestMatchesCPU, VEC_DIM } from '../shared/vectorize.ts'
import { b64ToF32 } from '../shared/b64.ts'
import { ZONES, zoneFor, type ClientMsg, type Hello, type InkEvent, type ServerMsg, type SimJob, type Zone } from '../shared/protocol.ts'

const args = process.argv.slice(2)
const url = args.find((a) => !a.startsWith('--')) ?? 'ws://127.0.0.1:8787/ws'
const flag = (name: string, def: number) => {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  const n = a ? Number(a.split('=')[1]) : def
  return Number.isFinite(n) ? n : def
}
const WATCH_S = flag('watch', 8)
const LOSS_S = flag('loss', 90)
const GFLOPS = flag('gflops', 2000)
const HTTP_CHECKS = !args.includes('--no-http')
const zIdx = (z: Zone) => Math.max(0, ZONES.findIndex((x) => x.zone === z))
/** The server caps an unmeasured neuron's INK zone at MESO. */
const expectedZone = (): Zone => ZONES[Math.min(zIdx(zoneFor(GFLOPS)), zIdx('MESO'))]?.zone ?? 'EPI'

/** Raw HTTP request (lets us set Host / Origin freely). Resolves with the status code. */
function rawStatus(method: string, pathName: string, headers: Record<string, string>, body?: string): Promise<number> {
  const base = new URL(url.replace(/^ws/, 'http'))
  return new Promise((resolve) => {
    const req = http.request({ host: base.hostname, port: base.port, path: pathName, method, headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', () => resolve(-1))
    req.setTimeout(8000, () => req.destroy())
    if (body) req.write(body)
    req.end()
  })
}

const results: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const counts: Record<string, number> = {}
const waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = []
let lastLoss: Extract<ServerMsg, { t: 'loss' }> | null = null
let samples = 0

/** Resolve with the first message matching `pred`, or null after `ms`. */
function waitFor<T extends ServerMsg>(pred: (m: ServerMsg) => boolean, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const w = {
      pred,
      resolve: (m: ServerMsg) => {
        clearTimeout(timer)
        resolve(m as T)
      },
    }
    const timer = setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) waiters.splice(i, 1)
      resolve(null)
    }, ms)
    waiters.push(w)
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 })
  const send = (m: ClientMsg) => ws.send(JSON.stringify(m))

  const helloP = new Promise<Hello>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no hello within 10 s')), 10_000)
    ws.on('message', (raw) => {
      let m: ServerMsg
      try {
        m = JSON.parse(raw.toString()) as ServerMsg
      } catch {
        return
      }
      counts[m.t] = (counts[m.t] ?? 0) + 1
      if (m.t === 'hello') {
        clearTimeout(t)
        resolve(m)
      }
      if (m.t === 'loss') lastLoss = m
      if (m.t === 'sample') samples++
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(m)
        }
      }
    })
    ws.on('error', (e) => reject(e))
  })

  const hello = await helloP
  check('hello received', hello.t === 'hello' && hello.mode === 'live')
  check('hello.agents present', hello.agents.length > 0, `${hello.agents.length} agents`)
  const working = hello.agents.filter((a) => a.state !== 'idle').length
  check('agents working', working > 0, `${working} not idle`)
  check('hello.stats.pages > 20', hello.stats.pages > 20, `${hello.stats.pages} pages · ${hello.stats.tokens} tokens · ${hello.stats.domains} domains`)
  const hosts = new Set(hello.recent.map((p) => p.host))
  check('several domains', hello.domains.length >= 5 && hosts.size >= 3, `${hello.domains.length} domains, ${hosts.size} hosts in recent`)
  check('hello.traces present', hello.traces.length > 0, `${hello.traces.length} traces`)
  check('hello.sectors = 8', hello.sectors.length === 8)
  check('hello.model', hello.model.name === 'SEPIA-0' && hello.model.params > 0, `${hello.model.params} params · step ${hello.model.step} · loss ${hello.model.loss.toFixed(3)}`)

  // ── live stream ──
  const before = { ...counts }
  await sleep(WATCH_S * 1000)
  const delta = (t: string) => (counts[t] ?? 0) - (before[t] ?? 0)
  console.log(`      stream over ${WATCH_S}s:`, Object.fromEntries(Object.keys(counts).map((k) => [k, delta(k)])))
  check('stream: agent', delta('agent') > 0, String(delta('agent')))
  check('stream: trace', delta('trace') > 0, String(delta('trace')))
  check('stream: stats ~1 Hz', delta('stats') >= WATCH_S - 2, String(delta('stats')))
  check('stream: page', delta('page') > 0, String(delta('page')))

  // ── neuron: honest job ──
  send({ t: 'neuron.register', label: 'probe · cpu', zone: 'HADAL', gflops: GFLOPS, kind: 'desktop', wallet: null, adapter: { deviceId: 'wsprobe-0001' } })
  const ok = await waitFor<Extract<ServerMsg, { t: 'neuron.ok' }>>((m) => m.t === 'neuron.ok', 5_000)
  check('neuron.ok', !!ok, ok ? `id ${ok.neuron.id.slice(0, 8)} zone ${ok.neuron.zone}` : 'timeout')
  if (!ok) return finish(ws)
  check('zone re-derived by server (MESO cap until measured)', ok.neuron.zone === expectedZone(), `claimed HADAL at ${GFLOPS} GFLOPS → ${ok.neuron.zone}`)
  const myId = ok.neuron.id

  async function getJob(): Promise<SimJob | null> {
    send({ t: 'job.request' })
    const m = await waitFor<Extract<ServerMsg, { t: 'job' }>>((x) => x.t === 'job', 15_000)
    const j = m?.job ?? null
    return j && j.kind !== 'train' ? j : null
  }
  const inkFor = (jobId: string) => waitFor<Extract<ServerMsg, { t: 'ink' }>>((m) => m.t === 'ink' && m.event.jobId === jobId, 10_000)

  const job1 = await getJob()
  check('job received', !!job1, job1 ? `${job1.rows}×${job1.cols}×${job1.dim} · ${(job1.flops / 1e6).toFixed(1)} MFLOP` : 'timeout')
  if (!job1) return finish(ws)
  const a = b64ToF32(job1.a)
  const b = b64ToF32(job1.b)
  check('job sized from EPI (ramp), not from the claim', job1.rows <= 16 && job1.cols <= 512, `${job1.rows}×${job1.cols}`)
  check('job shape', job1.dim === VEC_DIM && a.length === job1.rows * job1.dim && b.length === job1.cols * job1.dim && job1.rowIds.length === job1.rows && job1.colIds.length === job1.cols)
  const t0 = performance.now()
  const ref = bestMatchesCPU(a, b, job1.rows, job1.cols, job1.dim)
  const ms = performance.now() - t0
  const ink1P = inkFor(job1.id)
  send({ t: 'job.result', result: { id: job1.id, best: ref.best, sim: ref.sim, ms } })
  const ink1 = (await ink1P)?.event as InkEvent | undefined
  check('honest result → ink verified=true', !!ink1 && ink1.verified && ink1.ink > 0 && ink1.neuronId === myId, ink1 ? `${ink1.ink} INK · ${ink1.reason}` : 'timeout')
  const maxSim = Math.max(...ref.sim)
  console.log(`      best similarity in job: ${maxSim.toFixed(4)} (rows ≥ 0.92: ${ref.sim.filter((s) => s >= 0.92).length})`)

  // ── neuron: corrupted job ──
  const job2 = await getJob()
  check('second job received', !!job2, job2 ? `${job2.rows}×${job2.cols}` : 'timeout')
  if (job2) {
    const a2 = b64ToF32(job2.a)
    const b2 = b64ToF32(job2.b)
    const r2 = bestMatchesCPU(a2, b2, job2.rows, job2.cols, job2.dim)
    // Plausible-looking but wrong: shifted indices and similarities 0.25 off.
    const best = r2.best.map((i) => (i + 1) % job2.cols)
    const sim = r2.sim.map((s) => Math.max(-1, s - 0.25))
    const ink2P = inkFor(job2.id)
    send({ t: 'job.result', result: { id: job2.id, best, sim, ms: 1 } })
    const ink2 = (await ink2P)?.event as InkEvent | undefined
    check('corrupted result → ink verified=false', !!ink2 && !ink2.verified && ink2.ink === 0, ink2 ? ink2.reason : 'timeout')
  }

  // ── trainer ──
  if (!lastLoss) {
    console.log(`      waiting up to ${LOSS_S}s for a trainer loss message…`)
    await waitFor((m) => m.t === 'loss', LOSS_S * 1000)
  }
  const ll = lastLoss as Extract<ServerMsg, { t: 'loss' }> | null
  check('trainer loss stream', !!ll, ll ? `step ${ll.point.step} · loss ${ll.point.loss.toFixed(3)} · val ${ll.point.val?.toFixed(3) ?? '—'} · ${ll.model.corpusChars} corpus chars · ${ll.model.stepsPerSec} steps/s` : 'no loss message')
  if (samples) console.log(`      ${samples} sample message(s) seen`)

  // ── HTTP hardening ──
  if (HTTP_CHECKS) {
    const json = JSON.stringify({ prompt: 'rollup', n: 5 })
    check('POST without application/json → 415', (await rawStatus('POST', '/api/generate', { 'Content-Type': 'text/plain' }, json)) === 415)
    check('POST from a foreign Origin → 403', (await rawStatus('POST', '/api/generate', { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, json)) === 403)
    const hostStatus = await rawStatus('GET', '/api/health', { Host: 'rebind.attacker.example' })
    check('foreign Host header refused on a loopback bind', hostStatus === 421, `status ${hostStatus}`)
    const evil = await new Promise<string>((resolve) => {
      const s = new WebSocket(url, { headers: { Origin: 'https://evil.example' } })
      s.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)))
      s.on('error', () => resolve('error'))
      s.on('open', () => (s.close(), resolve('open')))
    })
    check('websocket from a foreign Origin refused', evil === '403', evil)
  }

  send({ t: 'neuron.leave' })
  await sleep(300)
  return finish(ws)
}

function finish(ws: WebSocket) {
  try {
    ws.close()
  } catch {
    /* ignore */
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  console.log('message totals:', counts)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('probe crashed:', e)
  process.exit(1)
})
