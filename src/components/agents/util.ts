// Shared helpers for the Agents page (roster table, spawn panel, dossier).
import type { AgentInfo, AgentState, Trace } from '@shared/protocol'

/** States in which an agent is actually working a page. */
export const WORKING: ReadonlySet<AgentState> = new Set<AgentState>(['seek', 'fetch', 'parse', 'taste', 'dedupe', 'store'])

/** Pipeline order, used for the state ladder and for sorting by state. */
export const LADDER: { key: AgentState; label: string; hint: string }[] = [
  { key: 'seek', label: 'SEEK', hint: 'pick a link' },
  { key: 'fetch', label: 'FETCH', hint: 'download' },
  { key: 'parse', label: 'PARSE', hint: 'read text' },
  { key: 'taste', label: 'TASTE', hint: 'score 0–1' },
  { key: 'dedupe', label: 'DEDUPE', hint: 'skip copies' },
  { key: 'store', label: 'STORE', hint: 'keep it' },
]

export const STAGE: Record<AgentState, number> = {
  seek: 0, fetch: 1, parse: 2, taste: 3, dedupe: 4, store: 5, reject: 6, error: 7, sleep: 8, idle: 9,
}

/** Accept threshold used by the taste stage. */
export const TASTE_MIN = 0.35

export const NAME_RE = /^[a-z0-9-]{2,16}$/

/** Server-side cap on total agents (MAX_AGENTS in the agent runtime, server/ingest). */
export const MAX_AGENTS = 64

export function acceptRate(a: { pages: number; rejected: number }): number | null {
  const n = a.pages + a.rejected
  return n > 0 ? a.pages / n : null
}

export function byCode(a: AgentInfo, b: AgentInfo): number {
  return a.sector - b.sector || a.slot - b.slot || a.id - b.id
}

/** Slot a newly spawned agent would take on an arm (mirrors the server). */
export function nextSlot(agents: AgentInfo[], sector: number): number {
  let m = 0
  for (const a of agents) if (a.sector === sector) m = Math.max(m, a.slot + 1)
  return m
}

export function traceKey(t: Trace): string {
  return `${t.ts}|${t.step}|${t.msg}`
}

/**
 * A page headline worth reading: the real title, else words recovered from the
 * url path ("/t/aave-v4-roadmap/18899" → "aave v4 roadmap"), else the host. A
 * "title" that is just a fragment of the url (no spaces, contained in it) does
 * not count as a title.
 */
export function readableTitle(title: string | null | undefined, url: string | null | undefined, host: string | null | undefined): string {
  const t = title?.trim()
  if (t && !(url && !/\s/.test(t) && url.includes(t))) return t
  if (url) {
    try {
      const segs = new URL(url).pathname.split('/').filter(Boolean)
      for (let i = segs.length - 1; i >= 0; i--) {
        let seg = segs[i]
        try {
          seg = decodeURIComponent(seg)
        } catch {
          /* keep raw */
        }
        if (/[a-z]{3,}/i.test(seg)) return seg.replace(/\.(html?|php|md)$/i, '').replace(/[-_+]+/g, ' ').trim()
      }
    } catch {
      /* not a url */
    }
  }
  return host ? cleanHost(host) : 'untitled page'
}

export function cleanHost(h: string | null | undefined): string {
  return h ? h.replace(/^www\./, '') : '—'
}
