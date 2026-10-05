// Test doubles for the crawler and trainer, used by server/neurons/_test.ts to
// exercise the coordinator and the HTTP/WS hub without touching the network.
// They implement the real contracts from server/contracts.ts with synthetic
// data (pages are generated text vectorized with the real shared/vectorize.ts,
// including deliberate near-duplicates so the GPU dedupe path is exercised).
//
// Run standalone for a local stub server:  npx tsx server/neurons/_stubs.ts [port]

import { SECTORS, AGENT_NAMES, agentCode } from '../../shared/sectors.ts'
import { vectorize } from '../../shared/vectorize.ts'
import type { AgentInfo, LossPoint, ModelInfo, PageRecord, Trace } from '../../shared/protocol.ts'
import type { CrawlerApi, CrawlerOptions, TrainerApi, TrainerOptions } from '../contracts.ts'

const LEX = 'rollup calldata blob validator staking restaking oracle bridge exploit audit governance delegate proposal quorum treasury liquidity amm orderbook mev builder relay sequencer prover zk snark stark merkle verkle eip erc bip consensus finality slashing fork mempool fee gas solidity vyper evm svm lightning taproot schnorr multisig custody stablecoin collateral liquidation vault yield'.split(' ')

function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

export interface StubCrawler extends CrawlerApi {
  /** Add n synthetic pages now (every 5th is a near-duplicate of an older page). */
  addPages(n: number): void
  dups: { pageId: string; dupOfId: string; sim: number }[]
}

export function createStubCrawler(opts: Partial<CrawlerOptions> & { initialPages?: number; seed?: number } = {}): StubCrawler {
  const emit = opts.emit ?? (() => undefined)
  const rand = rng(opts.seed ?? 7)
  const pages: PageRecord[] = []
  const texts: string[] = []
  const vecs: Float32Array[] = []
  const traces: Trace[] = []
  const dups: StubCrawler['dups'] = []
  const started = Date.now()
  const agents: AgentInfo[] = Array.from({ length: opts.agents ?? 8 }, (_, i) => ({
    id: i,
    code: agentCode(i % 8, Math.floor(i / 8)),
    name: AGENT_NAMES[i % AGENT_NAMES.length],
    sector: i % 8,
    slot: Math.floor(i / 8),
    state: 'idle',
    since: Date.now(),
    url: null,
    host: null,
    title: null,
    pages: 0,
    tokens: 0,
    rejected: 0,
    errors: 0,
    lastScore: null,
    origin: 'genesis',
    owner: null,
  }))
  let timer: NodeJS.Timeout | null = null

  function makeText(): string {
    const n = 120 + Math.floor(rand() * 200)
    const out: string[] = []
    for (let i = 0; i < n; i++) out.push(LEX[Math.floor(rand() * LEX.length)])
    return out.join(' ')
  }

  function addPage(text: string) {
    const i = pages.length
    const sector = i % 8
    const agent = agents[i % agents.length]
    const page: PageRecord = {
      id: `p${i.toString(16).padStart(6, '0')}`,
      url: `https://stub.example/${SECTORS[sector].key}/${i}`,
      host: 'stub.example',
      title: `stub page ${i}`,
      sector,
      agentId: agent.id,
      depth: 1,
      score: 0.8,
      tokens: Math.round(text.length / 4),
      bytes: text.length * 2,
      links: 3,
      simhash: '0'.repeat(16),
      terms: [],
      excerpt: text.slice(0, 420),
      ts: Date.now(),
    }
    pages.push(page)
    texts.push(text)
    vecs.push(vectorize(text))
    agent.pages++
    agent.tokens += page.tokens
    agent.state = 'store'
    agent.since = Date.now()
    const tr: Trace = { agentId: agent.id, ts: Date.now(), step: 'store', msg: `stored ${page.title}` }
    traces.unshift(tr)
    if (traces.length > 2000) traces.length = 2000
    emit({ t: 'page', page })
    emit({ t: 'trace', trace: tr })
    emit({ t: 'agent', agent: { ...agent } })
    opts.onText?.(text, page)
  }

  function addPages(n: number) {
    for (let k = 0; k < n; k++) {
      if (pages.length > 10 && pages.length % 5 === 0) {
        // near-duplicate: an older page with a couple of words appended
        const src = texts[Math.floor(rand() * (texts.length - 5))]
        addPage(`${src} ${LEX[Math.floor(rand() * LEX.length)]}`)
      } else addPage(makeText())
    }
  }

  for (let i = 0; i < (opts.initialPages ?? 0); i++) addPages(1)

  const slice = (from: number, n: number) => {
    const ids: string[] = []
    const out: Float32Array[] = []
    const total = pages.length
    if (!total) return { ids, vecs: out }
    for (let k = 0; k < Math.min(n, total); k++) {
      const j = (from + k) % total
      ids.push(pages[j].id)
      out.push(vecs[j])
    }
    return { ids, vecs: out }
  }

  return {
    dups,
    addPages,
    start() {
      if (timer) return
      timer = setInterval(() => addPages(1), 400)
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    agents: () => agents.map((a) => ({ ...a })),
    stats: () => ({
      pages: pages.length,
      tokens: pages.reduce((s, p) => s + p.tokens, 0),
      bytes: pages.reduce((s, p) => s + p.bytes, 0),
      domains: 1,
      frontier: 0,
      rejected: 0,
      dupes: dups.length,
      errors: 0,
      agentsActive: agents.length,
      agentsTotal: agents.length,
      pagesPerMin: 0,
      tokensPerMin: 0,
      uptime: Math.round((Date.now() - started) / 1000),
    }),
    sectors: () => SECTORS.map((s) => ({ id: s.id, pages: pages.filter((p) => p.sector === s.id).length, tokens: 0, frontier: 0, agents: agents.filter((a) => a.sector === s.id).length })),
    domains: () => [],
    recent: (n) => pages.slice(-n).reverse(),
    traces: (n) => traces.slice(0, n),
    agentTraces: (id, n) => traces.filter((t) => t.agentId === id).slice(0, n),
    searchPages: (q, sector, n) =>
      pages
        .filter((p) => (sector === null || p.sector === sector) && (!q || p.excerpt.includes(q)))
        .slice(-n)
        .reverse(),
    spawn(name, owner, sector) {
      if (agents.some((a) => a.name === name)) throw new Error(`agent "${name}" already exists`)
      const a: AgentInfo = { ...agents[0], id: agents.length, name, owner, sector, slot: 9, origin: 'spawned', pages: 0, tokens: 0, code: agentCode(sector, 9) }
      agents.push(a)
      emit({ t: 'agent', agent: a })
      return a
    },
    vectorCount: () => pages.length,
    vectors: (offset, n) => slice(offset, n),
    newestVectors: (n) => {
      // newest first (contract): entry k is page index length-1-k
      const k = Math.max(0, Math.min(n, pages.length))
      const s = slice(pages.length - k, k)
      return { ids: s.ids.reverse(), vecs: s.vecs.reverse() }
    },
    markSemanticDup(pageId, dupOfId, sim) {
      dups.push({ pageId, dupOfId, sim })
    },
  }
}

export function createStubTrainer(opts: Partial<TrainerOptions> = {}): TrainerApi {
  const emit = opts.emit ?? (() => undefined)
  const loss: LossPoint[] = []
  let chars = 0
  let step = 0
  let timer: NodeJS.Timeout | null = null
  const info = (): ModelInfo => ({
    name: 'SEPIA-0', params: 12345, arch: 'stub', vocab: 96, step, loss: loss.at(-1)?.loss ?? 0, val: null, corpusChars: chars, stepsPerSec: 10,
    ...trainStats(),
  })
  const trainStats = () => ({ version: step, gpuSteps: 0, serverSteps: step, gpuSamples: 0, contributors24h: 0, audits: { ok: 0, failed: 0 }, gpuStepsPerMin: 0 })
  return {
    start() {
      if (timer) return
      timer = setInterval(() => {
        step += 10
        const point: LossPoint = { step, loss: 4 / Math.log(step + 3), val: null, tokens: chars, ts: Date.now() }
        loss.push(point)
        emit({ t: 'loss', point, model: info() })
      }, 1000)
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    feed: (text) => {
      chars += text.length
    },
    info,
    lossHistory: () => loss.slice(-1000),
    samples: () => [],
    generate: async (prompt, n) => ({ text: (prompt + ' rollup blob validator').slice(0, n), ms: 1 }),
    // The stub has no model: neurons fall back to dedupe jobs.
    issueTrainJob: async () => null,
    submitTrainResult: async () => ({ verdict: 'rejected' as const, reason: 'no trainer', flops: 0, audited: false }),
    trainStats,
  }
}

// Standalone stub server: `npx tsx server/neurons/_stubs.ts [port]`
if (process.argv[1] && /_stubs\.ts$/.test(process.argv[1])) {
  const { createHub } = await import('../http.ts')
  const { createCoordinator } = await import('./coordinator.ts')
  const os = await import('node:os')
  const path = await import('node:path')
  const hub = createHub({ distDir: null })
  const trainer = createStubTrainer({ emit: hub.emit })
  const crawler = createStubCrawler({ emit: hub.emit, initialPages: 40, onText: (t) => trainer.feed(t) })
  const coordinator = createCoordinator({ crawler, emit: hub.emit, dataDir: path.join(os.tmpdir(), 'lusca-stub-data') })
  hub.bind({ crawler, trainer, coordinator })
  const port = await hub.listen(Number(process.argv[2] ?? 8790))
  crawler.start()
  trainer.start()
  console.log(`stub LUSCA server on http://localhost:${port} (ws /ws)`)
  process.on('SIGINT', () => {
    void Promise.all([hub.close(), crawler.stop(), trainer.stop(), coordinator.stop()]).then(() => process.exit(0))
  })
}
