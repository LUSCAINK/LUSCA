// Verified-source registries as discovery sources (endpoints checked against the live services):
//
//   Sourcify v2, recently verified contracts of one chain, newest first, ≤ 200 per page:
//     GET https://sourcify.dev/server/v2/contracts/{chainId}?sort=desc&limit=200[&afterMatchId=N]
//     → { results: [{ match: 'exact_match' | 'match', creationMatch, runtimeMatch, chainId, address,
//                     verifiedAt: ISO, matchId: "<decimal>" }] }        (limit > 200 → HTTP 400)
//     'exact_match' = full match (metadata hash too), 'match' = partial.
//   OtterSec verified Solana programs (verified builds), alphabetical, 20 per page:
//     GET https://verify.osec.io/verified-programs/{page}
//     → { meta: { total, page, total_pages, items_per_page, has_next_page }, verified_programs: [id…] }
//     (the per-program record is GET https://verify.osec.io/status/{programId}; the reader uses it.)
//
// Sourcify rows verified in one burst (the same 10-second window) are usually a factory's clones:
// the first few keep the full bonus, the rest get 30 % so a burst does not crowd out everything else.

import type { EvmChain } from '../rpc.ts'

export const SOURCIFY_CHAIN_IDS: Record<EvmChain, number> = { ethereum: 1, base: 8453, arbitrum: 42161 }
export const SOURCIFY_PAGE = 200

export const sourcifyListUrl = (chain: EvmChain, afterMatchId?: number): string =>
  `https://sourcify.dev/server/v2/contracts/${SOURCIFY_CHAIN_IDS[chain]}?sort=desc&limit=${SOURCIFY_PAGE}${afterMatchId ? `&afterMatchId=${afterMatchId}` : ''}`

export const osecListUrl = (page: number): string => `https://verify.osec.io/verified-programs/${Math.max(1, Math.floor(page))}`

export const REGISTRY_SCORE = { osec: 6, sourcifyFull: 5, sourcifyPartial: 4 } as const
const BURST_WINDOW_MS = 10_000
const BURST_FULL = 3
const BURST_FACTOR = 0.3

export interface SourcifyRow {
  address: string
  full: boolean
  matchId: number
  verifiedAt: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** Rows of a Sourcify v2 list response (malformed rows skipped), in response order. */
export function parseSourcifyList(j: unknown): SourcifyRow[] {
  if (!isObj(j) || !Array.isArray(j.results)) return []
  const out: SourcifyRow[] = []
  for (const r of j.results) {
    if (!isObj(r) || typeof r.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.address)) continue
    const id = typeof r.matchId === 'string' || typeof r.matchId === 'number' ? Number(r.matchId) : NaN
    if (!Number.isSafeInteger(id) || id <= 0) continue
    const t = typeof r.verifiedAt === 'string' ? Date.parse(r.verifiedAt) : NaN
    const match = typeof r.match === 'string' ? r.match : typeof r.runtimeMatch === 'string' ? r.runtimeMatch : ''
    out.push({ address: r.address, full: match === 'exact_match' || match === 'perfect', matchId: id, verifiedAt: Number.isFinite(t) ? t : 0 })
  }
  return out
}

/** Discovery score per row, with burst damping. */
export function sourcifyScores(rows: SourcifyRow[]): { address: string; score: number; hint: string }[] {
  const byWindow = new Map<number, number>()
  const out: { address: string; score: number; hint: string }[] = []
  // oldest first inside a window, so the first verified of a burst keeps the bonus
  const ordered = [...rows].sort((a, b) => a.matchId - b.matchId)
  for (const r of ordered) {
    const w = r.verifiedAt ? Math.floor(r.verifiedAt / BURST_WINDOW_MS) : -r.matchId
    const rank = byWindow.get(w) ?? 0
    byWindow.set(w, rank + 1)
    const base = r.full ? REGISTRY_SCORE.sourcifyFull : REGISTRY_SCORE.sourcifyPartial
    out.push({
      address: r.address,
      score: rank < BURST_FULL ? base : base * BURST_FACTOR,
      hint: `Sourcify ${r.full ? 'full' : 'partial'} match`,
    })
  }
  return out
}

/** One OtterSec list page, or null when the response is not one. */
export function parseOsecPage(j: unknown): { programs: string[]; page: number; totalPages: number } | null {
  if (!isObj(j) || !Array.isArray(j.verified_programs)) return null
  const meta = isObj(j.meta) ? j.meta : {}
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : d)
  return {
    programs: j.verified_programs.filter((p): p is string => typeof p === 'string'),
    page: num(meta.page, 1),
    totalPages: Math.min(10_000, num(meta.total_pages, 1)),
  }
}

export interface RegistryState {
  /** highest Sourcify matchId already taken, per chain */
  sourcify: Partial<Record<EvmChain, number>>
  /** next OtterSec list page to fetch, pages known, sweeps completed */
  osec: { nextPage: number; totalPages: number; sweeps: number }
  lastPollAt: number
}

export const emptyRegistryState = (): RegistryState => ({ sourcify: {}, osec: { nextPage: 1, totalPages: 0, sweeps: 0 }, lastPollAt: 0 })

export function sanitizeRegistryState(v: unknown): RegistryState {
  const st = emptyRegistryState()
  if (!isObj(v)) return st
  const pos = (x: unknown) => (typeof x === 'number' && Number.isSafeInteger(x) && x > 0 ? x : 0)
  if (isObj(v.sourcify)) for (const c of Object.keys(SOURCIFY_CHAIN_IDS) as EvmChain[]) if (pos(v.sourcify[c])) st.sourcify[c] = pos(v.sourcify[c])
  if (isObj(v.osec)) st.osec = { nextPage: pos(v.osec.nextPage) || 1, totalPages: pos(v.osec.totalPages), sweeps: pos(v.osec.sweeps) }
  st.lastPollAt = pos(v.lastPollAt)
  return st
}
