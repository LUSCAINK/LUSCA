// Checks every reviewed fix marker (server/advisory/data/oz-advisories.json, `fix`) against every published copy of
// its file: the marker must say "pre-fix code present" for every copy that ships only in affected releases, and must
// never say so for a copy that ships in a fixed release. Header matches rely on these markers (server/advisory/match.ts),
// so a wrong marker would turn a fixed file into a match. Exit code 1 on any disagreement.
//
// Data only: npm tarballs (registry sha512 integrity checked, cached), unpacked in memory; nothing is executed.
//
//   npx tsx scripts/advisory/check-fix-markers.ts [--cache <dir>]
import { cmpVer, fixCheck, inAnyRange, parseVer } from '../../server/advisory/core.ts'
import { loadDataset, preOfIntroduced, rangeVersion } from '../../server/advisory/dataset.ts'
import { cacheDir, packageMeta, solFiles, tarball, type Meta } from './npm-tarballs.ts'

const ds = loadDataset()
const cache = cacheDir()
const metas = new Map<string, Meta>()
const texts = new Map<string, Map<string, string>>()
const wanted = new Set(ds.affected.map((af) => af.path))

async function fileAt(pkg: string, ver: string, p: string): Promise<string | undefined> {
  const k = `${pkg}@${ver}`
  let files = texts.get(k)
  if (!files) {
    if (!metas.has(pkg)) metas.set(pkg, await packageMeta(pkg))
    const buf = await tarball(cache, pkg, ver, metas.get(pkg)!.versions[ver].dist)
    files = await solFiles(buf, (x) => wanted.has(x))
    texts.set(k, files)
  }
  return files.get(p)
}

let problems = 0, checked = 0, copies = 0
const say = (m: string) => { problems++; console.log(`  ! ${m}`) }
for (const af of ds.affected) {
  const def = af.def
  if (!def.fix) {
    if (!def.fixNote) say(`${af.adv.id} ${af.pkgName}/${af.path}: no fix marker and no fixNote`)
    else console.log(`  - ${af.adv.id} ${af.path}: no marker (${def.fixNote})`)
    continue
  }
  checked++
  const vers = ds.fp.packages[af.pkg].versions
  const lowest = af.ranges.map((r) => r.introduced).filter((v) => v !== '0').sort(cmpVer)[0]
  const kinds = { affected: 0, before: 0, fixed: 0 }
  for (const [hash, entries] of ds.byHash) {
    for (const e of entries) {
      if (e.pkg !== af.pkg || e.path !== af.path) continue
      copies++
      const vs = e.versions.map((i) => vers[i])
      const text = await fileAt(af.pkgName, vs[vs.length - 1], af.path)
      if (text == null) { say(`${af.path}: missing in ${af.pkgName}@${vs[vs.length - 1]}`); continue }
      const r = fixCheck(text, def.fix)
      const cls = (v: string) => inAnyRange(rangeVersion(v), af.ranges) ? 'affected'
        : preOfIntroduced(v, af.ranges) || (lowest && parseVer(rangeVersion(v)) && cmpVer(rangeVersion(v), lowest) < 0) ? 'before' : 'fixed'
      const c = vs.map(cls)
      for (const k of c) kinds[k as keyof typeof kinds]++
      const label = `${af.adv.id} ${af.pkgName.replace('@openzeppelin/', '')}/${af.path} copy ${hash.slice(0, 8)} (${vs[0]}${vs.length > 1 ? ` … ${vs[vs.length - 1]}` : ''})`
      const fixedVs = vs.filter((_, i) => c[i] === 'fixed')
      // a prerelease cut from the main branch before a patch release fixed the old line (4.4.0-rc.0 vs the 4.3.3 fix)
      // does carry the old code; it is never matched (its header is not an affected release), so it is only reported
      if (r.pre && fixedVs.length && fixedVs.every((v) => parseVer(rangeVersion(v))?.pre.length)) console.log(`  · ${label}: pre-fix code in a prerelease outside the published range (${fixedVs.join(', ')}); never matched`)
      else if (r.pre && fixedVs.length) say(`${label}: marker says pre-fix, but this copy ships in a fixed release`)
      if (!r.pre && af.hashes.has(hash)) say(`${label}: ships only in affected releases, but the marker does not find the pre-fix code`)
      if (r.pre && af.hashes.has(hash) && r.line == null) say(`${label}: no evidence line`)
    }
  }
  console.log(`  ok ${af.adv.id} ${af.pkgName.replace('@openzeppelin/', '')}/${af.path}  (${kinds.affected} affected, ${kinds.before} earlier, ${kinds.fixed} fixed release copies)`)
}
console.log(problems ? `${problems} problem(s)` : `${checked} markers agree with ${copies} published copies`)
process.exit(problems ? 1 : 0)
