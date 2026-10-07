// Regenerates server/advisory/data/oz-fingerprints.json: every .sol file of every published version of
// @openzeppelin/contracts and @openzeppelin/contracts-upgradeable, hashed after line-ending normalization
// (server/advisory/core.ts fileHash), deduplicated across versions: hash → [(package, path, header, versions)].
//
// Data only: tarballs come from the npm registry, are checked against the registry's own sha512 integrity,
// and are only unpacked in memory to hash the .sol files. Nothing downloaded is executed or written out.
//
//   npx tsx scripts/advisory/build-fingerprints.ts [--cache <dir>]
//
// Tarballs are cached in <cache> (default: <os tmp>/lusca-oz-tarballs) so a rerun only fetches new versions.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { readTar } from '../../server/codebase/tar.ts'
import { cmpVer, fileHash, ozHeader, packIdx } from '../../server/advisory/core.ts'

const PACKAGES = ['@openzeppelin/contracts', '@openzeppelin/contracts-upgradeable']
const REGISTRY = 'https://registry.npmjs.org'
const OUT = path.resolve(import.meta.dirname, '../../server/advisory/data/oz-fingerprints.json')
const argCache = process.argv.indexOf('--cache')
const CACHE = argCache > 0 ? process.argv[argCache + 1] : path.join(os.tmpdir(), 'lusca-oz-tarballs')
fs.mkdirSync(CACHE, { recursive: true })

interface Meta { versions: Record<string, { dist: { tarball: string; integrity?: string; shasum?: string } }>; time?: Record<string, string> }

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'lusca-advisory-builder' } })
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return (await r.json()) as T
}

async function tarball(pkg: string, ver: string, dist: Meta['versions'][string]['dist']): Promise<Buffer> {
  const file = path.join(CACHE, `${pkg.replace(/[@/]/g, '_')}-${ver}.tgz`)
  let buf: Buffer | null = fs.existsSync(file) ? fs.readFileSync(file) : null
  const check = (b: Buffer) => {
    if (dist.integrity?.startsWith('sha512-')) return createHash('sha512').update(b).digest('base64') === dist.integrity.slice(7)
    if (dist.shasum) return createHash('sha1').update(b).digest('hex') === dist.shasum
    return false
  }
  if (buf && !check(buf)) buf = null
  if (!buf) {
    for (let attempt = 0; attempt < 3 && !buf; attempt++) {
      try {
        const r = await fetch(dist.tarball, { headers: { 'user-agent': 'lusca-advisory-builder' } })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const b = Buffer.from(await r.arrayBuffer())
        if (!check(b)) throw new Error('integrity mismatch')
        fs.writeFileSync(file, b)
        buf = b
      } catch (e) {
        if (attempt === 2) throw new Error(`${pkg}@${ver}: ${(e as Error).message}`)
        await new Promise((res) => setTimeout(res, 1500))
      }
    }
  }
  return buf!
}

/** Path inside the package: drop the tarball's top folder ("package/") and a leading "contracts/" (2.x layout). */
function pkgPath(p: string): string {
  const s = p.replace(/^[^/]+\//, '')
  return s.startsWith('contracts/') ? s.slice('contracts/'.length) : s
}

async function main() {
  const t0 = Date.now()
  // hash → key "pkgIdx|path|header" → version indices
  const files = new Map<string, Map<string, number[]>>()
  const pkgs: { name: string; versions: string[]; published: Record<string, string> }[] = []
  let solFiles = 0, bytes = 0
  for (const [pi, name] of PACKAGES.entries()) {
    const meta = await getJson<Meta>(`${REGISTRY}/${name.replace('/', '%2F')}`)
    const versions = Object.keys(meta.versions).sort(cmpVer)
    const published: Record<string, string> = {}
    for (const v of versions) if (meta.time?.[v]) published[v] = meta.time[v].slice(0, 10)
    pkgs.push({ name, versions, published })
    let next = 0
    const worker = async () => {
      while (next < versions.length) {
        const vi = next++
        const v = versions[vi]
        const buf = await tarball(name, v, meta.versions[v].dist)
        await readTar(Readable.from(zlib.gunzipSync(buf), { objectMode: false }), {
          want: (e) => e.path.endsWith('.sol'),
          file: (e, body) => {
            const text = body.toString('utf8')
            const h = fileHash(text)
            const hd = ozHeader(text)
            const key = `${pi}|${pkgPath(e.path)}|${hd ? `${hd.version}|${hd.path}` : ''}`
            let m = files.get(h)
            if (!m) files.set(h, (m = new Map()))
            const l = m.get(key) ?? []
            l.push(vi)
            m.set(key, l)
            solFiles++
            bytes += body.length
          },
        }, 4 << 20)
        process.stdout.write(`\r${name}@${v}                    `)
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker))
  }
  const out: Record<string, (string | number)[][]> = {}
  for (const h of [...files.keys()].sort()) {
    out[h] = [...files.get(h)!.entries()].map(([k, vis]) => {
      const [pi, p, hv, hp] = k.split('|')
      return [Number(pi), p, hv ? `${hv}|${hp}` : '', packIdx(vis)]
    })
  }
  const doc = {
    v: 1,
    generatedAt: new Date().toISOString(),
    source: {
      registry: REGISTRY,
      packages: PACKAGES,
      method: 'every published version; tarball checked against the registry sha512 integrity; .sol files hashed with sha256 after BOM removal and CRLF/CR → LF (first 32 hex chars)',
      script: 'scripts/advisory/build-fingerprints.ts',
    },
    packages: pkgs,
    stats: { versions: pkgs.reduce((s, p) => s + p.versions.length, 0), solFiles, uniqueFiles: files.size, bytes },
    files: out,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(doc))
  console.log(`\n${doc.stats.versions} versions, ${solFiles} .sol files, ${files.size} unique → ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
}

main().catch((e) => { console.error(e); process.exit(1) })
