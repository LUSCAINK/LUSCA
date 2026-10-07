// Feed cards: X player cards for radar catches and Lens reports (the /r/scan + /play/scan pattern).
//
//   /r/radar                     → player card for the live radar feed     → player /play/radar
//   /r/radar/:id                 → player card for one catch               → player /play/radar/:id
//   /r/lens/:chain/:address      → player card for one Lens report         → player /play/lens/:chain/:address
//
// Pure functions only: strict validation of ids / chains / addresses, the tag values of each card, and
// which static player page a dynamic /play/* path is served from. No RPC, no registry: a radar card reads
// the stored event (radar.get), a Lens card names the target only (the player asks the existing, cached
// and limited /api/lens endpoint itself).

import { isSolanaAddress } from '../../shared/base58.ts'
import type { ChainId } from '../../shared/chain.ts'
import type { RadarEvent, RadarKind } from '../../shared/radar.ts'

export interface ShareCard {
  title: string
  description: string
  player: string
  image: string
  page: string
}

/** Same format as the ids server/radar issues (and /api/radar/:id accepts). */
export const RADAR_EVENT_ID_RE = /^[a-z]{3}-[a-z0-9]{6,20}$/
const EVM_RE = /^0x[0-9a-fA-F]{40}$/
const CHAINS: readonly ChainId[] = ['solana', 'ethereum', 'base', 'arbitrum']
const CHAIN_NAME: Record<ChainId, string> = { solana: 'Solana', ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum' }
const KIND_WORD: Record<RadarKind, string> = {
  upgrade: 'upgraded',
  deploy: 'deployed',
  admin_change: 'admin changed',
  beacon_upgrade: 'beacon upgraded',
  authority_change: 'authority changed',
  close: 'closed',
}

export const RADAR_FEED_CARD: ShareCard = {
  title: 'LUSCA Radar · live',
  description: 'Code changes on Solana, Ethereum, Base and Arbitrum, caught live: before → after, new admin-only functions with file:line.',
  player: '/play/radar',
  image: '/play/radar-card.jpg',
  page: '/radar',
}

export const isRadarId = (id: string): boolean => RADAR_EVENT_ID_RE.test(id)

/** A Lens target in its canonical form (EVM lowercased), or null when chain or address is not valid. */
export function lensTarget(chain: string, address: string): { chain: ChainId; address: string } | null {
  if (!(CHAINS as readonly string[]).includes(chain)) return null
  if (chain === 'solana') return isSolanaAddress(address) ? { chain: 'solana', address } : null
  return EVM_RE.test(address) ? { chain: chain as ChainId, address: address.toLowerCase() } : null
}

const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, a.startsWith('0x') ? 6 : 4)}…${a.slice(-4)}` : a)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function radarCard(e: RadarEvent): ShareCard {
  const who = e.name || shortAddr(e.address)
  const g = e.diff?.guardsAdded?.[0]
  const guard = g ? ` · new admin-only ${g.fn} (${clip(g.guard, 40)}, ${g.at})` : ''
  return {
    title: clip(`${who} ${KIND_WORD[e.kind] ?? e.kind} on ${CHAIN_NAME[e.chain]} · LUSCA Radar`, 70),
    description: clip(`${e.headline}${guard}`, 200),
    player: `/play/radar/${e.id}`,
    image: '/play/radar-card.jpg',
    page: '/radar',
  }
}

export function lensCard(chain: ChainId, address: string): ShareCard {
  const what = chain === 'solana' ? 'program' : 'contract'
  return {
    title: `LUSCA Lens · ${CHAIN_NAME[chain]} ${what} ${shortAddr(address)}`,
    description: `A cited on-chain readout of ${address}: verification, upgrade authority, admin-only functions, SEPIA-1 verdict.`,
    player: `/play/lens/${chain}/${address}`,
    image: '/play/lens-card.jpg',
    page: `/lens/${chain}/${address}`,
  }
}

function seg(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/**
 * The card for a dynamic /r/ path. undefined: not a feed-card path (the caller's own table applies);
 * null: a feed-card path that is not valid or names nothing stored (404).
 */
export function resolveShare(pathname: string, radarGet: ((id: string) => RadarEvent | null) | null): ShareCard | null | undefined {
  const p = pathname.replace(/\/+$/, '')
  if (p === '/r/radar') return RADAR_FEED_CARD
  let m = /^\/r\/radar\/([^/]+)$/.exec(p)
  if (m) {
    const id = seg(m[1])
    if (!id || !isRadarId(id) || !radarGet) return null
    const e = radarGet(id)
    return e ? radarCard(e) : null
  }
  m = /^\/r\/lens\/([^/]+)\/([^/]+)$/.exec(p)
  if (m) {
    const t = lensTarget(seg(m[1]) ?? '', seg(m[2]) ?? '')
    return t ? lensCard(t.chain, t.address) : null
  }
  if (p.startsWith('/r/radar/') || p.startsWith('/r/lens')) return null
  return undefined
}

/**
 * Static file a dynamic player path is served from. undefined: not a dynamic player path (serve as usual);
 * null: a player path whose id / chain / address is not valid, or names no stored radar event (404).
 */
export function playerFile(pathname: string, radarGet: ((id: string) => RadarEvent | null) | null): string | null | undefined {
  const p = pathname.replace(/\/+$/, '')
  let m = /^\/play\/radar\/([^/]+)$/.exec(p)
  if (m) {
    if (m[1] === 'index.html') return undefined
    const id = seg(m[1])
    if (!id || !isRadarId(id)) return null
    if (radarGet && !radarGet(id)) return null
    return '/play/radar/index.html'
  }
  m = /^\/play\/lens\/([^/]+)\/([^/]+)$/.exec(p)
  if (m) return lensTarget(seg(m[1]) ?? '', seg(m[2]) ?? '') ? '/play/lens/index.html' : null
  if (/^\/play\/(radar|lens)\/./.test(p) && !/^\/play\/(radar|lens)\/index\.html$/.test(p)) return null
  return undefined
}

/** https://x.com/intent/post link (plain link, no SDK). */
export function xIntent(text: string, url: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
}
