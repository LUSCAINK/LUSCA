// ADVISORY CHECK dataset: the vendored OpenZeppelin release fingerprints, the reviewed advisory → file mapping and the
// Solidity compiler bug list, indexed for matching. Built once at startup (a few MB resident).
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { AdvisoryInfo, AdvisoryRange, AdvisorySeverity, SolcBug } from '../../shared/advisory.ts'
import { cmpVer, inAnyRange, parseVer, rangeLabel, unpackIdx, type FixMarker, type VerRange } from './core.ts'

/** Bump when the matching rules change: persisted results are recomputed. */
export const MATCHER_VERSION = 6

export interface FingerprintDoc {
  v: 1
  generatedAt: string
  packages: { name: string; versions: string[]; published?: Record<string, string> }[]
  stats: { versions: number; solFiles: number; uniqueFiles: number; bytes: number }
  /** hash → [pkgIdx, path, "headerVersion|headerPath" | "", packed version indices] */
  files: Record<string, [number, string, string, string][]>
}
/**
 * One affected package file. `fix` names the code the fix changed (checked against every published copy of the file by
 * scripts/advisory/check-fix-markers.ts): a file that is not a published copy counts by its header only when it still
 * has that code; a file without `fix` is matched by byte-identical copies only.
 */
export interface AdvisoryFileDef { path: string; anchor: string[]; evidence: string; ref: string; ranges?: AdvisoryRange[]; fix?: FixMarker; fixNote?: string }
export interface AdvisoryDef { id: string; aliases: string[]; severity: AdvisorySeverity; title: string; url: string; note?: string; packages: { name: string; ranges: AdvisoryRange[]; files: AdvisoryFileDef[] }[] }
export interface AdvisoryDoc { v: 1; reviewedAt: string; advisories: AdvisoryDef[] }
export interface SolcDoc { v: 1; generatedAt: string; bugs: SolcBug[]; versions: Record<string, { released: string; bugs: number[] }> }

export interface FpEntry { pkg: number; path: string; header: string; versions: number[] }
/** One mapped advisory file, with the exact copies (hashes) and headers that only ever shipped in affected releases. */
export interface AffectedFile {
  adv: AdvisoryDef
  pkg: number
  pkgName: string
  path: string
  def: AdvisoryFileDef
  ranges: AdvisoryRange[]
  hashes: Set<string>
  headers: Set<string>
  /** Copies of this path that ship both in affected and in unaffected releases (not matched; diagnostics). */
  straddling: number
}

export interface Dataset {
  version: string
  fp: FingerprintDoc
  advisories: AdvisoryDoc
  solc: SolcDoc
  byHash: Map<string, FpEntry[]>
  /** hash → affected files it is a copy of. */
  hashAffected: Map<string, AffectedFile[]>
  /** "headerVersion|headerPath" → affected files whose affected releases carry it. */
  headerAffected: Map<string, AffectedFile[]>
  affected: AffectedFile[]
  info: AdvisoryInfo[]
}

/** "-solc-0.7" (and "-solc-0.7-2") builds are the same release for another compiler: compare them as the base version. */
export const rangeVersion = (v: string) => v.replace(/-solc-0\.\d+(?:-\d+)?$/, '')

/** A prerelease of a range's first affected version (4.0.0-beta.0 for "introduced 4.0.0"): published before the range starts, but a
 *  copy it shares with affected releases is still code from an affected release. */
export function preOfIntroduced(v: string, ranges: VerRange[]): boolean {
  const p = parseVer(rangeVersion(v))
  if (!p || !p.pre.length) return false
  return ranges.some((r) => { const q = parseVer(r.introduced); return !!q && !q.pre.length && q.major === p.major && q.minor === p.minor && q.patch === p.patch })
}

/**
 * A copy (or a header) counts as affected when it ships in at least one affected release and in no unaffected one,
 * prereleases of the first affected version aside. A copy that also ships in a fixed release is never counted.
 */
export function onlyAffected(versions: string[], ranges: VerRange[]): boolean {
  let inside = 0
  for (const v of versions) {
    if (inAnyRange(rangeVersion(v), ranges)) inside++
    else if (!preOfIntroduced(v, ranges)) return false
  }
  return inside > 0
}

/** "4.7.0 – 4.7.2 (3 releases)" | "4.9.4" */
export function releasesLabel(versions: string[]): string {
  const s = [...new Set(versions)].sort(cmpVer)
  if (!s.length) return ''
  if (s.length === 1) return s[0]
  return `${s[0]} – ${s[s.length - 1]} (${s.length} releases)`
}

export function buildDataset(fp: FingerprintDoc, advisories: AdvisoryDoc, solc: SolcDoc, version = 'test'): Dataset {
  const byHash = new Map<string, FpEntry[]>()
  const byPath = new Map<string, { hash: string; e: FpEntry }[]>() // "pkg|path" → copies
  for (const [h, list] of Object.entries(fp.files)) {
    const es: FpEntry[] = list.map(([pkg, p, header, packed]) => ({ pkg, path: p, header, versions: unpackIdx(packed) }))
    byHash.set(h, es)
    for (const e of es) {
      const k = `${e.pkg}|${e.path}`
      let l = byPath.get(k)
      if (!l) byPath.set(k, (l = []))
      l.push({ hash: h, e })
    }
  }
  const pkgIdx = new Map(fp.packages.map((p, i) => [p.name, i]))
  const affected: AffectedFile[] = []
  const hashAffected = new Map<string, AffectedFile[]>()
  const headerAffected = new Map<string, AffectedFile[]>()
  const info: AdvisoryInfo[] = []
  for (const adv of advisories.advisories) {
    const pk: AdvisoryInfo['packages'] = []
    for (const p of adv.packages) {
      const pi = pkgIdx.get(p.name)
      if (pi == null) throw new Error(`advisory ${adv.id}: unknown package ${p.name}`)
      const vers = fp.packages[pi].versions
      const files: AdvisoryInfo['packages'][number]['files'] = []
      for (const def of p.files) {
        const ranges = def.ranges ?? p.ranges
        const af: AffectedFile = { adv, pkg: pi, pkgName: p.name, path: def.path, def, ranges, hashes: new Set(), headers: new Set(), straddling: 0 }
        const copies = byPath.get(`${pi}|${def.path}`) ?? []
        const headerVers = new Map<string, string[]>()
        for (const { hash, e } of copies) {
          const vs = e.versions.map((i) => vers[i])
          if (onlyAffected(vs, ranges)) af.hashes.add(hash)
          else if (vs.some((v) => inAnyRange(rangeVersion(v), ranges))) af.straddling++
          if (e.header) headerVers.set(e.header, [...(headerVers.get(e.header) ?? []), ...vs])
        }
        for (const [hd, vs] of headerVers) if (onlyAffected(vs, ranges)) af.headers.add(hd)
        affected.push(af)
        for (const h of af.hashes) hashAffected.set(h, [...(hashAffected.get(h) ?? []), af])
        for (const hd of af.headers) headerAffected.set(hd, [...(headerAffected.get(hd) ?? []), af])
        files.push({ path: def.path, evidence: def.evidence, ref: def.ref, label: def.ranges ? def.ranges.map(rangeLabel).join(' or ') : undefined, copies: af.hashes.size })
      }
      pk.push({ name: p.name, ranges: p.ranges, label: p.ranges.map(rangeLabel).join(' or '), fixedIn: p.ranges.map((r) => r.fixed).filter((x): x is string => !!x), files })
    }
    info.push({ id: adv.id, aliases: adv.aliases, severity: adv.severity, title: adv.title, url: adv.url, ...(adv.note ? { note: adv.note } : {}), packages: pk })
  }
  return { version, fp, advisories, solc, byHash, hashAffected, headerAffected, affected, info }
}

const DATA_DIR = path.join(import.meta.dirname, 'data')

/** The vendored dataset (server/advisory/data/*.json); its version changes whenever a data file or the matcher changes. */
export function loadDataset(dir = DATA_DIR): Dataset {
  const raw = ['oz-fingerprints.json', 'oz-advisories.json', 'solc-bugs.json'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
  const h = createHash('sha256')
  for (const r of raw) h.update(r)
  h.update(`matcher:${MATCHER_VERSION}`)
  return buildDataset(JSON.parse(raw[0]), JSON.parse(raw[1]), JSON.parse(raw[2]), h.digest('hex').slice(0, 16))
}
