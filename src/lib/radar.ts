// Upgrade radar on the client: GET /api/radar (pages + status), GET /api/radar/:id (detail), and the
// WebSocket { t: 'radar', event } stream (an update of an event re-sends its id). Real data only:
// every event was caught and read by the server; nothing is filled in here.
import type { ChainId } from '@shared/chain'
import { isOtherEvent, type RadarEvent, type RadarKind, type RadarPage, type RadarVerified } from '@shared/radar'

export { isOtherEvent }

export const KIND_BADGE: Record<RadarKind, string> = {
  upgrade: 'UPGRADED',
  deploy: 'DEPLOYED',
  authority_change: 'AUTHORITY CHANGED',
  admin_change: 'ADMIN CHANGED',
  beacon_upgrade: 'BEACON CHANGED',
  close: 'CLOSED',
}

/** 'other': folded Upgraded events that are not confirmed upgrades (proxies not checked, or the same implementation set again). */
export const KIND_FILTER: { k: RadarKind | '' | 'other'; label: string; title?: string }[] = [
  { k: '', label: 'All' },
  { k: 'upgrade', label: 'Upgraded' },
  { k: 'deploy', label: 'Deployed' },
  { k: 'authority_change', label: 'Authority' },
  { k: 'admin_change', label: 'Admin' },
  { k: 'beacon_upgrade', label: 'Beacon' },
  { k: 'close', label: 'Closed' },
  { k: 'other', label: 'Other events', title: 'Upgraded events that are not confirmed upgrades: proxies not checked, or the same implementation set again' },
]

/** What the badge of a change says. */
export function badgeOf(e: Pick<RadarEvent, 'kind' | 'proxies' | 'sameImpl'>): string {
  return isOtherEvent(e) ? `${KIND_BADGE[e.kind]} EVENT` : KIND_BADGE[e.kind]
}

/** /scan: the label of a caught change, by kind ("RADAR · CLOSE CAUGHT"). */
export const CAUGHT_WORD: Record<RadarKind, string> = {
  upgrade: 'Upgrade',
  deploy: 'Deploy',
  authority_change: 'Authority change',
  admin_change: 'Admin change',
  beacon_upgrade: 'Beacon change',
  close: 'Close',
}

/** Radar budget slices, named for the page. */
export const BUDGET_LABEL: Record<string, string> = {
  solana: 'Solana reads',
  'solana-discovery': 'Solana gap checks',
  ethereum: 'Ethereum implementation reads',
  base: 'Base implementation reads',
  arbitrum: 'Arbitrum implementation reads',
  sourcify: 'Sourcify',
  osec: 'OtterSec',
  'logs-ethereum': 'Ethereum log queries',
  'logs-base': 'Base log queries',
  'logs-arbitrum': 'Arbitrum log queries',
  'ws-solana': 'Helius websocket',
}

export const VERIFIED_WORD: Record<RadarVerified, string> = {
  osec: 'OtterSec verified build',
  'sourcify-full': 'Sourcify full match',
  'sourcify-partial': 'Sourcify partial match',
  none: 'not verified',
  unknown: 'unknown',
}

const TX_BASE: Record<ChainId, string> = {
  solana: 'https://solscan.io/tx/',
  ethereum: 'https://etherscan.io/tx/',
  base: 'https://basescan.org/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
}

export function txUrl(chain: ChainId, tx: string | null): string | null {
  if (!tx) return null
  if (chain === 'solana' ? !/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(tx) : !/^0x[0-9a-fA-F]{64}$/.test(tx)) return null
  return `${TX_BASE[chain]}${tx}`
}

export function isRadarEvent(v: unknown): v is RadarEvent {
  const e = v as RadarEvent | null
  return !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.ts === 'number' && typeof e.kind === 'string' && typeof e.address === 'string' && typeof e.chain === 'string'
}

export interface RadarQuery {
  chain?: ChainId | ''
  /** upgrade / beacon_upgrade: confirmed changes only. */
  kind?: RadarKind | ''
  /** Folded Upgraded events that are not confirmed upgrades. */
  other?: boolean
  known?: boolean
  /** 'priority': most significant first. */
  sort?: 'new' | 'priority'
  cursor?: string | null
  limit?: number
}

export async function fetchRadar(q: RadarQuery, signal?: AbortSignal): Promise<RadarPage> {
  const p = new URLSearchParams()
  if (q.chain) p.set('chain', q.chain)
  if (q.kind) p.set('kind', q.kind)
  if (q.other) p.set('other', '1')
  if (q.known) p.set('known', '1')
  if (q.sort === 'priority') p.set('sort', 'priority')
  if (q.cursor) p.set('cursor', q.cursor)
  p.set('limit', String(q.limit ?? 40))
  const res = await fetch(`/api/radar?${p}`, { headers: { Accept: 'application/json' }, signal })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const j = (await res.json()) as { error?: string }
      if (j.error) msg = j.error
    } catch {
      /* keep the status */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as RadarPage
  return { items: Array.isArray(body.items) ? body.items.filter(isRadarEvent) : [], next: typeof body.next === 'string' ? body.next : null, status: body.status }
}

export async function fetchRadarEvent(id: string, signal?: AbortSignal): Promise<RadarEvent | null> {
  const res = await fetch(`/api/radar/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' }, signal })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j: unknown = await res.json()
  return isRadarEvent(j) ? j : null
}

/** Does an event pass the page's filters? (The server's rules: GET /api/radar.) */
export function matches(e: RadarEvent, q: RadarQuery): boolean {
  const other = isOtherEvent(e)
  const kindOk = !q.kind || (e.kind === q.kind && ((q.kind !== 'upgrade' && q.kind !== 'beacon_upgrade') || !other))
  return (!q.chain || e.chain === q.chain) && kindOk && (!q.other || other) && (!q.known || e.known)
}
