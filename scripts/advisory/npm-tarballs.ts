// Shared by the advisory regeneration scripts: npm registry metadata and tarballs (data only). Each tarball is checked
// against the registry's sha512 integrity, cached on disk, and only unpacked in memory. Nothing downloaded is executed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { readTar } from '../../server/codebase/tar.ts'

export const REGISTRY = 'https://registry.npmjs.org'
export interface Dist { tarball: string; integrity?: string; shasum?: string }
export interface Meta { versions: Record<string, { dist: Dist }>; time?: Record<string, string> }

export function cacheDir(): string {
  const i = process.argv.indexOf('--cache')
  const dir = i > 0 ? process.argv[i + 1] : path.join(os.tmpdir(), 'lusca-oz-tarballs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'lusca-advisory-builder' } })
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return (await r.json()) as T
}

export const packageMeta = (name: string) => getJson<Meta>(`${REGISTRY}/${name.replace('/', '%2F')}`)

export async function tarball(cache: string, pkg: string, ver: string, dist: Dist): Promise<Buffer> {
  const file = path.join(cache, `${pkg.replace(/[@/]/g, '_')}-${ver}.tgz`)
  let buf: Buffer | null = fs.existsSync(file) ? fs.readFileSync(file) : null
  const check = (b: Buffer) => {
    if (dist.integrity?.startsWith('sha512-')) return createHash('sha512').update(b).digest('base64') === dist.integrity.slice(7)
    if (dist.shasum) return createHash('sha1').update(b).digest('hex') === dist.shasum
    return false
  }
  if (buf && !check(buf)) buf = null
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
  return buf!
}

/** Path inside the package: drop the tarball's top folder ("package/") and a leading "contracts/" (2.x layout). */
export function pkgPath(p: string): string {
  const s = p.replace(/^[^/]+\//, '')
  return s.startsWith('contracts/') ? s.slice('contracts/'.length) : s
}

/** The .sol files of one tarball (package paths) accepted by `want`. */
export async function solFiles(buf: Buffer, want: (p: string) => boolean = () => true): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await readTar(Readable.from(zlib.gunzipSync(buf), { objectMode: false }), {
    want: (e) => e.path.endsWith('.sol') && want(pkgPath(e.path)),
    file: (e, body) => { out.set(pkgPath(e.path), body.toString('utf8')) },
  }, 4 << 20)
  return out
}
