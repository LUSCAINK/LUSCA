// Throwaway live smoke test for the crawler.
//   npx tsx server/ingest/_smoke.ts [seconds=75] [dataDir=<tmp>] [agents=8] [pace=0]
// Crawls the real web, then prints stats + politeness audit (per-host request gaps
// and max concurrency measured by wrapping global fetch).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMsg } from '../../shared/protocol.ts'
import { createIngest } from './pipeline.ts'

const seconds = Number(process.argv[2] ?? 75)
const dataDir = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : mkdtempSync(join(tmpdir(), 'lusca-smoke-'))
const agentsN = Number(process.argv[4] ?? 8)
const pace = Number(process.argv[5] ?? 0)

// ── politeness audit: wrap fetch ─────────────────────────────────────────
interface Req { host: string; url: string; start: number; end: number; status: number | null }
const reqs: Req[] = []
const inflight = new Map<string, number>()
let maxInflightPerHost = 0
let maxInflightGlobal = 0
let globalInflight = 0
const origFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const host = new URL(url).hostname
  const r: Req = { host, url, start: Date.now(), end: 0, status: null }
  reqs.push(r)
  const c = (inflight.get(host) ?? 0) + 1
  inflight.set(host, c)
  maxInflightPerHost = Math.max(maxInflightPerHost, c)
  globalInflight++
  maxInflightGlobal = Math.max(maxInflightGlobal, globalInflight)
  try {
    const res = await origFetch(input, init)
    r.status = res.status
    return res
  } finally {
    r.end = Date.now()
    inflight.set(host, (inflight.get(host) ?? 1) - 1)
    globalInflight--
  }
}) as typeof fetch

// ── emit summary ─────────────────────────────────────────────────────────
const counts: Record<string, number> = {}
const rejectReasons = new Map<string, number>()
const errorTraces = new Map<string, number>()
let robotsBlocked = 0
let crashes = 0
process.on('uncaughtException', (e) => {
  crashes++
  console.error('UNCAUGHT', e)
})
process.on('unhandledRejection', (e) => {
  crashes++
  console.error('UNHANDLED', e)
})

const t0 = Date.now()
const el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5)
const emit = (m: ServerMsg) => {
  counts[m.t] = (counts[m.t] ?? 0) + 1
  if (m.t === 'page') {
    const p = m.page
    console.log(`${el()}s  + [${p.sector}] ${p.host.padEnd(28).slice(0, 28)} ${p.score.toFixed(2)} ${String(p.tokens).padStart(6)} tok  ${p.title.slice(0, 70)}`)
  } else if (m.t === 'reject') {
    const key = m.reason.replace(/'.*'/, "'…'").replace(/[\d.]+/g, '#').slice(0, 70)
    rejectReasons.set(key, (rejectReasons.get(key) ?? 0) + 1)
    if (m.reason.startsWith('blocked by robots')) robotsBlocked++
  } else if (m.t === 'trace' && m.trace.step === 'error') {
    const key = m.trace.msg.replace(/[\d.]+/g, '#').slice(0, 80)
    errorTraces.set(key, (errorTraces.get(key) ?? 0) + 1)
    console.log(`${el()}s  ! agent ${m.trace.agentId}: ${m.trace.msg} (${String(m.trace.data?.url ?? '').slice(0, 70)})`)
  } else if (m.t === 'trace' && process.env.SMOKE_TRACES) {
    console.log(`${el()}s    ${String(m.trace.agentId).padStart(2)} ${m.trace.step.padEnd(6)} ${m.trace.msg}`)
  }
}

const crawler = createIngest({
  agents: agentsN,
  dataDir,
  pace,
  emit,
  onText: () => {},
})
console.log(`smoke: ${seconds}s · ${agentsN} agents · pace ${pace} · dataDir ${dataDir}`)
crawler.start()

// Exercise the rest of the API mid-run.
setTimeout(() => {
  try {
    const a = crawler.spawn('Tester!', '0xabc', 2)
    console.log(`${el()}s  * spawned ${a.code} ${a.name} (origin ${a.origin}, owner ${a.owner}, slot ${a.slot})`)
  } catch (e) {
    console.log('spawn failed', e)
  }
}, Math.min(10, seconds / 3) * 1000)
setTimeout(() => {
  const v = crawler.newestVectors(2)
  if (v.ids.length === 2) {
    crawler.markSemanticDup(v.ids[0], v.ids[1], 0.963)
    crawler.markSemanticDup(v.ids[0], v.ids[1], 0.963) // second call must be a no-op
    const t = crawler.traces(50).find((x) => x.msg.startsWith('neurons flagged'))
    console.log(`${el()}s  * semantic dup trace: ${t ? `agent ${t.agentId}: ${t.msg}` : 'MISSING'}`)
  }
  const w = crawler.vectors(5, 3)
  console.log(`${el()}s  * vectors(5,3): ${w.ids.length} ids, dim ${w.vecs[0]?.length}`)
}, Math.min(20, (seconds * 2) / 3) * 1000)

const ticker = setInterval(() => {
  const s = crawler.stats()
  console.log(`${el()}s  ~ pages ${s.pages} · tokens ${s.tokens} · frontier ${s.frontier} · domains ${s.domains} · rej ${s.rejected} · err ${s.errors} · dupes ${s.dupes} · active ${s.agentsActive}/${s.agentsTotal}`)
}, 15_000)

setTimeout(async () => {
  clearInterval(ticker)
  const tStop = Date.now()
  await crawler.stop()
  const stopMs = Date.now() - tStop
  const s = crawler.stats()
  console.log('\n══ STATS ══')
  console.log(JSON.stringify(s, null, 1))
  console.log('stop took', stopMs, 'ms')
  console.log('msg counts', counts)
  console.log('\n══ SECTORS ══')
  for (const x of crawler.sectors()) console.log(JSON.stringify(x))
  console.log('\n══ TOP DOMAINS ══')
  for (const d of crawler.domains().slice(0, 25)) {
    console.log(`${d.host.padEnd(34)} arm ${d.sector} pages ${String(d.pages).padStart(3)} tokens ${String(d.tokens).padStart(7)} frontier ${String(d.frontier).padStart(4)} avg ${d.avgScore.toFixed(2)}${d.discovered ? ' (discovered)' : ''}`)
  }
  console.log('discovered domains:', crawler.domains().filter((d) => d.discovered).length)
  console.log('\n══ REJECT REASONS ══')
  for (const [k, v] of [...rejectReasons].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(4), k)
  console.log('\n══ ERRORS ══')
  for (const [k, v] of [...errorTraces].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(4), k)
  console.log('\n══ POLITENESS AUDIT ══')
  console.log('requests:', reqs.length, '· max in-flight per host:', maxInflightPerHost, '· max in-flight global:', maxInflightGlobal)
  const byHost = new Map<string, Req[]>()
  for (const r of reqs) {
    const l = byHost.get(r.host) ?? []
    l.push(r)
    byHost.set(r.host, l)
  }
  let violations = 0
  for (const [host, list] of byHost) {
    list.sort((a, b) => a.start - b.start)
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]
      const gap = list[i].start - prev.end
      const prevWasRedirect = prev.status !== null && prev.status >= 300 && prev.status < 400
      if (gap < 1450 && !prevWasRedirect) {
        violations++
        if (violations <= 10) console.log(`  gap ${gap} ms on ${host}: ${prev.url} (${prev.status}) → ${list[i].url}`)
      }
    }
  }
  console.log('interval violations (<1.45 s, excluding redirect hops):', violations)
  console.log('robots-blocked rejects:', robotsBlocked, '· robots.txt fetches:', reqs.filter((r) => r.url.endsWith('/robots.txt')).length)
  console.log('\n══ SAMPLE TRACES (agent 0, newest 15) ══')
  for (const t of crawler.agentTraces(0, 15).reverse()) console.log(`  ${t.step.padEnd(6)} ${t.msg}`)
  console.log('\nrecent:', crawler.recent(3).map((p) => p.title))
  console.log('vectors:', crawler.vectorCount(), '· newest ids', crawler.newestVectors(2).ids)
  console.log('search "rollup":', crawler.searchPages('rollup', null, 5).map((p) => p.title))
  console.log('crashes:', crashes)
  process.exit(0)
}, seconds * 1000)
