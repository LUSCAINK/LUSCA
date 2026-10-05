// Sorting for the roster table.
import type { AgentInfo } from '@shared/protocol'
import { STAGE, acceptRate, byCode, cleanHost } from './util'

export type SortKey = 'code' | 'name' | 'state' | 'host' | 'pages' | 'tokens' | 'rejected' | 'accept' | 'taste' | 'origin'
export interface SortSpec {
  key: SortKey
  dir: 1 | -1
}

export const SORT_LABEL: Record<SortKey, string> = {
  code: 'code', name: 'name', state: 'doing now', host: 'website', pages: 'kept', tokens: 'tokens',
  rejected: 'dropped', accept: 'kept %', taste: 'taste score', origin: 'origin',
}

/** Numeric columns sort high→low on first click. */
export const DEFAULT_DIR: Record<SortKey, 1 | -1> = {
  code: 1, name: 1, state: 1, host: 1, pages: -1, tokens: -1, rejected: -1, accept: -1, taste: -1, origin: -1,
}

function cmpNullable(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0
  if (a === null) return 1 // nulls always last
  if (b === null) return -1
  return (a - b) * dir
}

export function sortAgents(list: AgentInfo[], s: SortSpec, scoreOf: (a: AgentInfo) => number | null = (a) => a.lastScore): AgentInfo[] {
  const out = list.slice()
  const d = s.dir
  out.sort((a, b) => {
    let r = 0
    switch (s.key) {
      case 'code': r = byCode(a, b) * d; break
      case 'name': r = a.name.localeCompare(b.name) * d; break
      case 'state': r = (STAGE[a.state] - STAGE[b.state]) * d || a.since - b.since; break
      case 'host':
        if (!a.host !== !b.host) r = a.host ? -1 : 1
        else r = cleanHost(a.host).localeCompare(cleanHost(b.host)) * d
        break
      case 'pages': r = (a.pages - b.pages) * d; break
      case 'tokens': r = (a.tokens - b.tokens) * d; break
      case 'rejected': r = (a.rejected - b.rejected) * d; break
      case 'accept': r = cmpNullable(acceptRate(a), acceptRate(b), d); break
      case 'taste': r = cmpNullable(scoreOf(a), scoreOf(b), d); break
      case 'origin': r = ((a.origin === 'spawned' ? 1 : 0) - (b.origin === 'spawned' ? 1 : 0)) * d; break
    }
    return r || byCode(a, b)
  })
  return out
}
