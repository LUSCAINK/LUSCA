// Network side of the code index: the commit of a branch or tag (git smart-HTTP ref advertisement,
// no API quota) and the codeload tar.gz archive of a commit, streamed and size-capped.

import { Readable, Transform, pipeline, type TransformCallback } from 'node:stream'
import zlib from 'node:zlib'

export const USER_AGENT = 'LUSCA-code-index/1.0 (+https://lusca.ink)'

export class ArchiveTooLarge extends Error {
  constructor(
    public limit: number,
    public kind: 'compressed' | 'inflated' = 'compressed',
  ) {
    super(kind === 'compressed' ? `archive larger than ${Math.round(limit / 1048576)} MB` : `archive inflates past ${Math.round(limit / 1048576)} MB`)
  }
}

export class HttpStatusError extends Error {
  constructor(
    public status: number,
    /** Which request failed: the ref advertisement or the archive download. */
    public what: 'refs' | 'archive',
    /** Server-requested wait (Retry-After), ms. */
    public retryAfterMs?: number,
  ) {
    super(`${what}: HTTP ${status}`)
  }
}

/** Retry-After as ms (delta-seconds or an HTTP date), undefined when absent or unreadable; at most a day. */
export function parseRetryAfter(v: string | null, nowMs = Date.now()): number | undefined {
  if (!v) return undefined
  const t = v.trim()
  const ms = /^\d+$/.test(t) ? Number(t) * 1000 : Date.parse(t) - nowMs
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 86_400_000) : undefined
}

export interface ArchiveSource {
  /**
   * Commit sha of branch or tag `ref` (a full 40-hex commit is returned as is), or null when the ref
   * is not in the advertisement (the archive is then taken by ref). Fails with HttpStatusError
   * ('refs') on a non-2xx answer — 401 / 404 for a repository that does not exist or is not public,
   * 429 / 403 / 5xx when GitHub is limiting or unavailable — and with the fetch error on a network failure.
   */
  head(repo: string, ref: string, signal: AbortSignal): Promise<string | null>
  /** Decompressed tar bytes of `refOrCommit`. Fails with ArchiveTooLarge past `maxCompressed` gzip bytes or `maxInflated` tar bytes. */
  open(repo: string, refOrCommit: string, signal: AbortSignal, maxCompressed: number, maxInflated?: number): Promise<AsyncIterable<Buffer>>
}

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const REF_RE = /^[A-Za-z0-9._/-]+$/

/**
 * Parse git pkt-lines until the wanted ref is found: branch `refs/heads/<ref>` (or HEAD pointing at
 * it), else tag `refs/tags/<ref>` — the peeled `^{}` line (the commit) of an annotated tag, which
 * the advertisement lists right after the tag object.
 */
export function findRefInAdvertisement(buf: Buffer, ref: string): { sha: string | null; complete: boolean } {
  const tag = `refs/tags/${ref}`
  const peeled = `${tag}^{}`
  /** sha on the `refs/tags/<ref>` line: the commit of a lightweight tag, or an annotated tag object. */
  let tagSha: string | null = null
  let off = 0
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.toString('ascii', off, off + 4), 16)
    if (!Number.isFinite(len)) return { sha: null, complete: true }
    if (len === 0) {
      off += 4 // flush-pkt
      continue
    }
    if (off + len > buf.length) break
    const line = buf.toString('latin1', off + 4, off + len).replace(/\n$/, '')
    off += len
    if (line.startsWith('#')) continue
    const nul = line.indexOf('\0')
    const refPart = nul >= 0 ? line.slice(0, nul) : line
    const caps = nul >= 0 ? line.slice(nul + 1) : ''
    const [sha, name] = refPart.split(' ')
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) continue
    if (name === 'HEAD') {
      if (caps.includes(`symref=HEAD:refs/heads/${ref}`)) return { sha, complete: true }
      continue
    }
    if (name === `refs/heads/${ref}`) return { sha, complete: true }
    if (name === peeled) return { sha, complete: true }
    // the line after a tag that has no peeled line: a lightweight tag
    if (tagSha) return { sha: tagSha, complete: true }
    if (name === tag) {
      tagSha = sha
      continue
    }
    // refs are sorted (heads < pull < tags): past the tag, the ref is not there
    if (name > peeled) return { sha: null, complete: true }
  }
  return { sha: tagSha, complete: false }
}

async function resolveHead(repo: string, ref: string, signal: AbortSignal): Promise<string | null> {
  if (!REPO_RE.test(repo) || !REF_RE.test(ref)) return null
  // a pinned commit (e.g. a time-holdout repository fixed before an audited change) is its own head
  if (/^[0-9a-f]{40}$/.test(ref)) return ref
  const res = await fetch(`https://github.com/${repo}.git/info/refs?service=git-upload-pack`, {
    signal,
    headers: { 'User-Agent': `git/2.45.0 ${USER_AGENT}` },
    redirect: 'follow',
  })
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined)
    throw new HttpStatusError(res.status, 'refs', parseRetryAfter(res.headers.get('retry-after')))
  }
  const reader = res.body.getReader()
  let buf = Buffer.alloc(0)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf = Buffer.concat([buf, Buffer.from(value)])
      const r = findRefInAdvertisement(buf, ref)
      if (r.complete) return r.sha
      if (buf.length > 4 * 1048576) return null
    }
    return findRefInAdvertisement(buf, ref).sha
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

class ByteLimit extends Transform {
  n = 0
  constructor(private limit: number, private onTooLarge: () => Error) {
    super()
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.n += chunk.length
    if (this.n > this.limit) return cb(this.onTooLarge())
    cb(null, chunk)
  }
}

/** Decompressed tar bytes allowed per archive (a guard against gzip bombs; source trees inflate ~4-8x). */
export const MAX_INFLATED = 1024 * 1048576

async function openArchive(repo: string, refOrCommit: string, signal: AbortSignal, maxCompressed: number, maxInflated = MAX_INFLATED): Promise<AsyncIterable<Buffer>> {
  if (!REPO_RE.test(repo) || !REF_RE.test(refOrCommit)) throw new Error(`invalid repo / ref ${repo}@${refOrCommit}`)
  const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(refOrCommit).replace(/%2F/g, '/')}`, {
    signal,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/x-gzip, application/octet-stream' },
    redirect: 'follow',
  })
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined)
    throw new HttpStatusError(res.status, 'archive', parseRetryAfter(res.headers.get('retry-after')))
  }
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxCompressed) {
    await res.body.cancel().catch(() => undefined)
    throw new ArchiveTooLarge(maxCompressed)
  }
  return inflateArchive(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>), maxCompressed, signal, maxInflated)
}

/** gzip bytes → tar bytes, failing with ArchiveTooLarge past `maxCompressed` input or `maxInflated` output bytes. */
export function inflateArchive(src: Readable, maxCompressed: number, signal: AbortSignal, maxInflated = MAX_INFLATED): Readable {
  const limit = new ByteLimit(maxCompressed, () => new ArchiveTooLarge(maxCompressed))
  const gunzip = zlib.createGunzip()
  const inflated = new ByteLimit(maxInflated, () => new ArchiveTooLarge(maxInflated, 'inflated'))
  const onAbort = () => src.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  return pipeline(src, limit, gunzip, inflated, () => signal.removeEventListener('abort', onAbort))
}

export const githubSource: ArchiveSource = { head: resolveHead, open: openArchive }
