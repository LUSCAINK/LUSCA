// Outbound address guard: the crawler only talks to public internet hosts.
//
// normalizeUrl() already refuses literal IPs and local-only names, but a public
// looking hostname can still resolve to loopback / RFC 1918 / link-local space
// (127.0.0.1.nip.io, 169.254.169.254.nip.io, a hostile DNS record …). Every
// page and robots.txt request resolves its host here first and refuses private
// results. Node's built-in fetch does its own lookup afterwards, so a resolver
// that answers differently a moment later (DNS rebinding) is not fully covered;
// pinning the address would need an undici dispatcher, which is not a
// dependency of this project.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const CACHE_MS = 5 * 60_000
const CACHE_MAX = 20_000
const LOOKUP_TIMEOUT_MS = 10_000

const cache = new Map<string, { at: number; bad: string | null }>()

function v4Private(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 169 && b === 254) return true // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

function parseV4(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const p = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  return p.every((x) => x <= 255) ? (p as [number, number, number, number]) : null
}

/** IPv6 text → 8 hextets (handles '::' and a trailing dotted IPv4). */
export function parseV6(s: string): number[] | null {
  let str = s.toLowerCase().replace(/%.*$/, '')
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(str)
  if (v4) {
    const p = parseV4(v4[1])
    if (!p) return null
    str = str.slice(0, -v4[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`
  }
  const halves = str.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null
  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail]
  if (parts.length !== 8) return null
  const out = parts.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN))
  return out.some((x) => Number.isNaN(x)) ? null : out
}

/** Loopback, private, link-local, CGNAT, ULA, multicast, documentation or otherwise non-public address. */
export function isPrivateAddress(addr: string): boolean {
  const s = addr.replace(/^\[|\]$/g, '')
  const fam = isIP(s)
  if (fam === 4) {
    const p = parseV4(s)
    return !p || v4Private(p[0], p[1], p[2])
  }
  if (fam !== 6) return true
  const h = parseV6(s)
  if (!h) return true
  if (h.every((x) => x === 0)) return true // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true // ::1
  // IPv4-mapped / -compatible / NAT64 (64:ff9b::/96): judge the embedded IPv4.
  const mapped = h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)
  const nat64 = h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)
  if (mapped || nat64) return v4Private(h[6] >> 8, h[6] & 0xff, h[7] >> 8)
  if ((h[0] & 0xfe00) === 0xfc00) return true // ULA fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return true // site-local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true // documentation
  return false
}

function privateError(host: string, addr: string): Error {
  return new Error(`${host} resolves to a non-public address (${addr})`, { cause: { code: 'EPRIVATEADDR', message: `non-public address ${addr}` } })
}

/** Resolve `host` and throw (cause.code 'EPRIVATEADDR') if any address is not public. DNS failures propagate. */
export async function assertPublicHost(host: string): Promise<void> {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(h)) {
    if (isPrivateAddress(h)) throw privateError(h, h)
    return
  }
  const now = Date.now()
  const hit = cache.get(h)
  if (hit && now - hit.at < CACHE_MS) {
    if (hit.bad) throw privateError(h, hit.bad)
    return
  }
  let timer: NodeJS.Timeout | undefined
  const addrs = await Promise.race([
    lookup(h, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`DNS lookup timed out for ${h}`, { cause: { code: 'EDNSTIMEOUT' } })), LOOKUP_TIMEOUT_MS)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
  const bad = addrs.find((a) => isPrivateAddress(a.address))?.address ?? null
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(h, { at: now, bad })
  if (bad) throw privateError(h, bad)
}
