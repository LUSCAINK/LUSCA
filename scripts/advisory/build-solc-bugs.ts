// Regenerates server/advisory/data/solc-bugs.json from the Solidity team's official lists:
//   docs/bugs.json            every known compiler bug (name, summary, severity, conditions, introduced / fixed)
//   docs/bugs_by_version.json which bugs each released solc version has
// Compact copy: descriptions are left out (each bug keeps its link to the full write-up).
//
//   npx tsx scripts/advisory/build-solc-bugs.ts
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'https://raw.githubusercontent.com/ethereum/solidity/develop/docs'
const OUT = path.resolve(import.meta.dirname, '../../server/advisory/data/solc-bugs.json')

interface Bug { uid: string; name: string; summary: string; link?: string; introduced?: string; fixed?: string; severity: string; conditions?: Record<string, unknown> }

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { 'user-agent': 'lusca-advisory-builder' } })
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return (await r.json()) as T
}

const bugs = await get<Bug[]>(`${BASE}/bugs.json`)
const byVersion = await get<Record<string, { bugs: string[]; released: string }>>(`${BASE}/bugs_by_version.json`)
const index = new Map(bugs.map((b, i) => [b.name, i]))
const versions: Record<string, { released: string; bugs: number[] }> = {}
for (const [v, e] of Object.entries(byVersion)) {
  versions[v] = { released: e.released, bugs: e.bugs.map((n) => { const i = index.get(n); if (i == null) throw new Error(`unknown bug ${n} in ${v}`); return i }) }
}
const doc = {
  v: 1,
  generatedAt: new Date().toISOString(),
  source: { bugs: `${BASE}/bugs.json`, bugsByVersion: `${BASE}/bugs_by_version.json`, script: 'scripts/advisory/build-solc-bugs.ts' },
  bugs: bugs.map((b) => ({ uid: b.uid, name: b.name, summary: b.summary, severity: b.severity, link: b.link ?? null, introduced: b.introduced ?? null, fixed: b.fixed ?? null, conditions: b.conditions ?? {} })),
  versions,
}
fs.writeFileSync(OUT, JSON.stringify(doc))
console.log(`${bugs.length} bugs, ${Object.keys(versions).length} versions → ${OUT} (${(fs.statSync(OUT).size / 1e3).toFixed(0)} kB)`)
