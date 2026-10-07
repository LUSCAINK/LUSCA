// ADVISORY CHECK matching: one contract's stored sources → OpenZeppelin files it contains, advisory-affected files
// (with file:line evidence) and the known bugs of its solc version. Pure (no I/O); cost is one sha256 per .sol file.
import type { AdvisoryEvidence, AdvisorySeverity } from '../../shared/advisory.ts'
import { cmpVer, fileHash, ozHeader, ozHeaders, solcVersionOf, type OzHeader } from './core.ts'
import { releasesLabel, type AffectedFile, type Dataset } from './dataset.ts'

export interface CheckResult {
  files: number
  ozFiles: number
  ozReleases: { pkg: string; label: string | null; files: number }[]
  advisories: { id: string; severity: AdvisorySeverity; files: AdvisoryEvidence[] }[]
  solc: { version: string; compiler: string; bugs: number[] } | null
  notes: string[]
}

/** 1-based line of the first anchor found in the text (anchors in order of preference), or line 1. */
export function anchorLine(text: string, anchors: string[]): { line: number; symbol: string | null } {
  for (const a of anchors) {
    const at = text.indexOf(a)
    if (at >= 0) {
      let line = 1
      for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) line++
      return { line, symbol: a.replace(/\($/, '').replace(/^(function|modifier|library|abstract contract|contract)\s+/, '').trim() }
    }
  }
  return { line: 1, symbol: null }
}

const base = (p: string) => p.split('/').pop() ?? p
/** 1-based line of a character offset. */
function lineAt(text: string, at: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) line++
  return line
}

export function checkSources(ds: Dataset, sources: { path: string; text: string }[], compiler: string | null): CheckResult {
  const notes: string[] = []
  const sol = sources.filter((s) => /\.sol$/i.test(s.path) && typeof s.text === 'string')
  const byAdv = new Map<string, { severity: AdvisorySeverity; files: AdvisoryEvidence[] }>()
  // releases consistent with every byte-identical OZ file, per package (intersection of version sets)
  const inter = new Map<number, { set: Set<number>; files: number }>()
  let ozFiles = 0
  const add = (af: AffectedFile, ev: AdvisoryEvidence) => {
    let a = byAdv.get(af.adv.id)
    if (!a) byAdv.set(af.adv.id, (a = { severity: af.adv.severity, files: [] }))
    if (!a.files.some((f) => f.path === ev.path)) a.files.push(ev)
  }
  for (const f of sol) {
    const h = fileHash(f.text)
    const entries = ds.byHash.get(h)
    const hd = ozHeader(f.text)
    if (entries) {
      ozFiles++
      for (const pi of new Set(entries.map((e) => e.pkg))) {
        const vs = new Set(entries.filter((e) => e.pkg === pi).flatMap((e) => e.versions))
        const cur = inter.get(pi)
        if (!cur) inter.set(pi, { set: vs, files: 1 })
        else { cur.set = new Set([...cur.set].filter((v) => vs.has(v))); cur.files++ }
      }
      for (const af of ds.hashAffected.get(h) ?? []) {
        const e = entries.find((x) => x.pkg === af.pkg && x.path === af.path)!
        const vers = ds.fp.packages[af.pkg].versions
        const rel = e.versions.map((i) => vers[i]).sort(cmpVer)
        add(af, { path: f.path, ...anchorLine(f.text, af.def.anchor), pkg: af.pkgName, pkgPath: af.path, method: 'hash', releases: releasesLabel(rel), header: hd?.version ?? null, release: rel[rel.length - 1] ?? null })
      }
      continue
    }
    // a flattened source (several OpenZeppelin files in one): flatteners do not always keep a header next to its code
    // (dependencies can sit between them, a header can be left behind), so a header there counts only when the
    // advisory's anchor (the affected function / contract) is inside its own segment, up to the next header
    const all = ozHeaders(f.text)
    if (all.length > 1 || (all.length === 1 && !hd)) {
      for (let i = 0; i < all.length; i++) {
        const seg = f.text.slice(all[i].at, i + 1 < all.length ? all[i + 1].at : f.text.length)
        byHeader(f.path, all[i], seg, lineAt(f.text, all[i].at) - 1, base(all[i].path), true)
      }
      continue
    }
    if (hd) byHeader(f.path, hd, f.text, 0, base(f.path), false)
  }
  // not a published copy, but its header names a release: count it only when every release carrying that header is affected
  function byHeader(filePath: string, hd: OzHeader, text: string, lineOffset: number, name: string, needAnchor: boolean) {
    const key = `${hd.version}|${hd.path}`
    let cands = ds.headerAffected.get(key) ?? []
    const same = cands.filter((af) => base(af.path) === name)
    if (same.length) cands = same
    const seen = new Set<string>()
    for (const af of cands) {
      if (seen.has(af.adv.id)) continue
      const at = anchorLine(text, af.def.anchor)
      if (needAnchor && !at.symbol) continue
      seen.add(af.adv.id)
      const vers = ds.fp.packages[af.pkg].versions
      const carrying: string[] = []
      for (const h2 of af.hashes) for (const e of ds.byHash.get(h2) ?? []) if (e.pkg === af.pkg && e.path === af.path && e.header === key) carrying.push(...e.versions.map((i) => vers[i]))
      add(af, { path: filePath, line: at.line + lineOffset, symbol: at.symbol, pkg: af.pkgName, pkgPath: af.path, method: 'header', releases: releasesLabel(carrying.length ? carrying : [hd.version]), header: hd.version, release: carrying.includes(hd.version) ? hd.version : (carrying.sort(cmpVer)[0] ?? null) })
    }
  }
  const ozReleases = [...inter.entries()].map(([pi, { set, files }]) => {
    const vers = ds.fp.packages[pi].versions
    return { pkg: ds.fp.packages[pi].name, label: set.size ? releasesLabel([...set].map((i) => vers[i])) : null, files }
  })
  const order: Record<string, number> = { critical: 0, high: 1, moderate: 2, low: 3 }
  const advisories = [...byAdv.entries()].map(([id, a]) => ({ id, ...a })).sort((x, y) => order[x.severity] - order[y.severity] || x.id.localeCompare(y.id))
  let solc: CheckResult['solc'] = null
  const v = solcVersionOf(compiler)
  if (v && ds.solc.versions[v]) solc = { version: v, compiler: compiler!, bugs: [...ds.solc.versions[v].bugs] }
  else if (compiler && /vyper/i.test(compiler)) notes.push('Vyper contract: the Solidity compiler bug list does not apply')
  else if (v) notes.push(`solc ${v} is not in the Solidity bug list`)
  else if (sol.length) notes.push(compiler ? `compiler version not recognised (${compiler.slice(0, 40)})` : 'compiler version not recorded')
  return { files: sol.length, ozFiles, ozReleases, advisories, solc, notes }
}

