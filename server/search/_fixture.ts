// Dev tool: grow a LOCAL chain store to production scale for Code Search QA (never run in production).
//
//   npx tsx server/search/_fixture.ts <dataDir> [maxEvm]
//
// Lists the items production keeps (lusca.ink /api/chain/items, ≤ 1 request/s), fetches the verified
// source files of the EVM ones from Sourcify (3 at a time) and appends them to <dataDir>/chain as kept
// records (same file format as server/chain/store.ts), next to whatever the local store already holds.
// Solana items with an IDL get their IDL summary from lusca.ink /api/chain/item (≤ 1 request/s).
// Nothing here is committed data: the records stay in the local data directory.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { ChainId, ChainIndexItem, ChainRead } from '../../shared/chain.ts'

process.on("uncaughtException", (e) => { console.error("uncaught", e); process.exit(2) })
process.on("unhandledRejection", (e) => { console.error("unhandled", e); process.exit(3) })
const dataDir = process.argv[2]
const maxEvm = Number(process.argv[3] ?? 100000)
if (!dataDir) throw new Error('usage: _fixture.ts <dataDir> [maxEvm]')
const dir = path.join(dataDir, 'chain')
const shardDir = path.join(dir, 'shards')
const SITE = 'https://lusca.ink'
const CHAIN_IDS: Record<string, number> = { ethereum: 1, base: 8453, arbitrum: 42161 }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function getJson<T>(url: string, tries = 3): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'lusca-dev-fixture' }, signal: AbortSignal.timeout(30_000) })
      if (r.status === 404) return null
      if (r.status === 429) {
        await sleep(5000)
        continue
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()) as T
    } catch (e) {
      if (i === tries - 1) {
        console.warn(`${url}: ${(e as Error).message}`)
        return null
      }
      await sleep(1500)
    }
  }
  return null
}

const idx = JSON.parse(fs.readFileSync(path.join(dir, 'items.json'), 'utf8'))
const have = new Set<string>(idx.items.map((it: { key: string }) => it.key))
const keyOf = (c: ChainId, a: string) => `${c}:${c === 'solana' ? a : a.toLowerCase()}`

// 1) production item list
const all: ChainIndexItem[] = []
let cursor: string | null = null
do {
  const page: { items: ChainIndexItem[]; next: string | null } | null = await getJson(`${SITE}/api/chain/items?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
  if (!page) break
  all.push(...page.items)
  cursor = page.next
  await sleep(1100)
} while (cursor)
console.log(`production lists ${all.length} kept items`)

let seq = Number(idx.seq) || 0
let shard = ''
let shardBytes = 0
const readsFile = path.join(dir, 'reads.gz')
let readsSize = fs.existsSync(readsFile) ? fs.statSync(readsFile).size : 0
function newShard() {
  seq++
  shard = `chain-${String(seq).padStart(6, '0')}.jsonl.gz`
  shardBytes = 0
}
newShard()
let added = 0
function save() {
  idx.seq = seq
  idx.shard = shard
  idx.updatedAt = Date.now()
  fs.writeFileSync(path.join(dir, 'items.json.tmp'), JSON.stringify(idx))
  fs.renameSync(path.join(dir, 'items.json.tmp'), path.join(dir, 'items.json'))
}
function keep(it: ChainIndexItem, sources: { path: string; lang: string; text: string }[], idl: unknown) {
  const read: ChainRead = {
    chain: it.chain, address: it.address, kind: it.kind, name: it.name, codeHash: it.codeHash, upgradeable: null, upgradeAuthority: null,
    lastDeploySlot: null, programBytes: null, loader: null, idl: null, securityTxt: null, bytecodeBytes: null, proxy: null, abi: null,
    verified: it.verifiedBy ? { by: it.verifiedBy, match: null, repo: null, commit: null, compiler: null } : null,
    sources: sources.map((s) => ({ path: s.path, lang: s.lang, bytes: Buffer.byteLength(s.text) })), notes: ['dev fixture'], readAt: it.readAt, rpcCalls: 0,
  }
  const rec = {
    v: 1, chain: it.chain, address: it.address, name: it.name, kind: it.kind, via: it.via, codeHash: it.codeHash, sourceBundleHash: null,
    verified: read.verified, idl, abi: null, sources, sourcesNote: null, securityTxt: null, proxy: null, upgradeable: null, upgradeAuthority: null,
    lastDeploySlot: null, loader: null, programBytes: null, bytecodeBytes: null, notes: ['dev fixture'], readAt: it.readAt,
  }
  const recGz = zlib.gzipSync(Buffer.from(`${JSON.stringify(rec)}\n`))
  const readGz = zlib.gzipSync(Buffer.from(`${JSON.stringify(read)}\n`))
  if (shardBytes + recGz.length > 8 * 1048576 && shardBytes > 0) newShard()
  fs.appendFileSync(path.join(shardDir, shard), recGz)
  fs.appendFileSync(readsFile, readGz)
  idx.items.push({ ...it, sourceFiles: sources.length, key: keyOf(it.chain, it.address), bundleHash: null, shard, off: shardBytes, len: recGz.length, rOff: readsSize, rLen: readGz.length })
  shardBytes += recGz.length
  readsSize += readGz.length
  have.add(keyOf(it.chain, it.address))
  added++
  if (added % 50 === 0) {
    save()
    console.log(`${added} added`)
  }
}

const langOf = (p: string) => ({ sol: 'solidity', vy: 'vyper', yul: 'yul', json: 'json' } as Record<string, string>)[p.split('.').pop()!.toLowerCase()] ?? 'text'

// 2) Solana IDL summaries (sequential, ≤ 1 rps) in the background of the EVM fetches
const sol = all.filter((it) => it.chain === 'solana' && it.idl && !have.has(keyOf(it.chain, it.address)))
const solTask = (async () => {
  for (const it of sol) {
    const got = await getJson<{ read: ChainRead }>(`${SITE}/api/chain/item/solana/${it.address}`)
    const s = got?.read.idl
    if (s) {
      const idl = {
        metadata: { name: s.name, version: s.version },
        instructions: s.instructions.map((i) => ({ name: i.name, accounts: [], args: [] })),
        accounts: s.accounts.map((name) => ({ name })),
        notes: 'dev fixture: IDL summary from lusca.ink (errors / events names not in the summary)',
      }
      keep(it, [], idl)
    }
    await sleep(1100)
  }
})()

// 3) EVM sources from Sourcify, 3 at a time
const evm = all.filter((it) => it.chain !== 'solana' && it.verifiedBy === 'sourcify' && it.sourceFiles > 0 && !have.has(keyOf(it.chain, it.address))).slice(0, maxEvm)
let next = 0
async function lane() {
  while (next < evm.length) {
    const it = evm[next++]
    const j = await getJson<{ sources?: Record<string, { content: string }> }>(`https://sourcify.dev/server/v2/contract/${CHAIN_IDS[it.chain]}/${it.address}?fields=sources`)
    if (j?.sources) {
      const sources = Object.entries(j.sources)
        .filter(([, v]) => typeof v?.content === 'string')
        .map(([p, v]) => ({ path: p, lang: langOf(p), text: v.content }))
      if (sources.length) keep(it, sources, null)
    }
    await sleep(250)
  }
}
await Promise.all([lane(), lane(), lane()])
await solTask
save()
console.log(`done: ${added} records added, ${idx.items.length} items`)
