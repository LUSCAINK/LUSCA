// Compares the reviewed mapping (server/advisory/data/oz-advisories.json) with what osv.dev publishes today for
// @openzeppelin/contracts and @openzeppelin/contracts-upgradeable, and checks every mapped file against the
// fingerprint table (affected copies exist; the fix release changed the file). Exit code 1 on any difference:
// a new advisory needs a reviewed file mapping before it is matched.
//
//   npx tsx scripts/advisory/check-advisories.ts
import { loadDataset } from '../../server/advisory/dataset.ts'

const PACKAGES = ['@openzeppelin/contracts', '@openzeppelin/contracts-upgradeable']
interface Osv { id: string; aliases?: string[]; summary?: string; withdrawn?: string; affected: { package: { name: string }; ranges?: { type: string; events: Record<string, string>[] }[] }[] }

const ds = loadDataset()
const mapped = new Map(ds.advisories.advisories.map((a) => [a.id, a]))
const aliasOf = new Map<string, string>()
for (const a of ds.advisories.advisories) for (const al of a.aliases) aliasOf.set(al, a.id)
let problems = 0
const say = (m: string) => { problems++; console.log(`  ! ${m}`) }

for (const pkg of PACKAGES) {
  const r = await fetch('https://api.osv.dev/v1/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ package: { name: pkg, ecosystem: 'npm' } }) })
  if (!r.ok) throw new Error(`osv.dev: HTTP ${r.status}`)
  const { vulns = [] } = (await r.json()) as { vulns?: Osv[] }
  console.log(`${pkg}: ${vulns.length} advisories on osv.dev`)
  for (const v of vulns) {
    if (v.withdrawn) continue
    const id = mapped.has(v.id) ? v.id : aliasOf.get(v.id)
    if (!id) { say(`${v.id} (${v.summary ?? ''}) is not in the reviewed mapping`); continue }
    if (id !== v.id) continue // an alias of a mapped advisory (e.g. GHSA-88g8 → GHSA-9c22)
    const def = mapped.get(id)!
    const p = def.packages.find((x) => x.name === pkg)
    const osvRanges = v.affected.filter((a) => a.package.name === pkg).flatMap((a) => (a.ranges ?? []).filter((x) => x.type === 'SEMVER').map((x) => {
      const o: Record<string, string> = {}
      for (const e of x.events) Object.assign(o, e)
      return `${o.introduced ?? '0'}..${o.fixed ?? o.last_affected ?? ''}`
    })).sort()
    if (!p) {
      if (!def.note) say(`${id}: osv lists ${pkg}, the mapping has no files for it and no note`)
      continue
    }
    const ours = p.ranges.map((x) => `${x.introduced}..${x.fixed ?? x.lastAffected ?? ''}`).sort()
    if (ours.join(' ') !== osvRanges.join(' ')) say(`${id} ${pkg}: ranges differ (osv ${osvRanges.join(' ')} / mapping ${ours.join(' ')})`)
  }
}
for (const af of ds.affected) {
  if (!af.hashes.size) say(`${af.adv.id} ${af.pkgName}/${af.path}: no copy that only ships in affected releases`)
}
console.log(problems ? `${problems} difference(s)` : 'mapping matches osv.dev; every mapped file has affected copies')
process.exit(problems ? 1 : 0)
