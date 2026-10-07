// CONTROL MAP: who can change the code of every program / contract the chain agents kept (shared/control.ts).
//
//   sweep (every 10 min): page through the kept index → Solana programs classified from the stored read (no RPC);
//     EVM contracts without a proxy → immutable (no RPC); EVM proxies queued
//   resolver (one proxy at a time, paced): resolve.ts resolveEvm through the chain agents' network layer, charged
//     to this module's own small daily slice first (LUSCA_CONTROL_EVM_CALLS per chain, default 5 % of the agents'
//     EVM limit, hourly share 15 %), never below the 10 % floor kept for the agents; controllers cached a week
//   persisted: <data>/control/entries.json · controllers.json · budget.json
//
// Viewers never cause RPC: the REST routes read the stored entries only.

import path from 'node:path'
import type { ChainId, ChainIndexItem, ChainRead } from '../../shared/chain.ts'
import { CONTROL_CLASSES, type ControlClass, type ControlController, type ControlEntry, type ControlPage, type ControlSummary } from '../../shared/control.ts'
import { BudgetError, redact, type BudgetKey, type RpcCtx } from '../chain/rpc.ts'
import { readJson, writeJsonAtomic } from '../chain/store.ts'
import { createRadarBudget, type RadarBudget } from '../radar/budget.ts'
import { classifySolana, resolveEvm, type ControllerInfo, type EvmCall, type IdentifyCache } from './resolve.ts'

type Log = (lvl: 'info' | 'warn' | 'error', msg: string) => void
const EVM: ChainId[] = ['ethereum', 'base', 'arbitrum']
const WEEK = 7 * 86_400_000

export interface ControlStoreLike {
  items(q: { chain?: ChainId; limit?: number; cursor?: string }): { items: ChainIndexItem[]; next: string | null }
  item(chain: ChainId, address: string): { item: ChainIndexItem; read: ChainRead } | null
}

export interface Control {
  start(): void
  stop(): Promise<void>
  summary(): ControlSummary
  list(q: { chain?: ChainId; cls?: ControlClass; limit?: number; cursor?: string }): ControlPage
  get(chain: ChainId, address: string): ControlEntry | null
  /** One sweep + resolve pass now (tests). */
  tick(): Promise<void>
}

export interface ControlOptions {
  rpc: RpcCtx
  store: ControlStoreLike
  dataDir: string
  log: Log
  /** Daily EVM calls per chain (default 5 % of the shared limit, at least 100). */
  evmCalls?: number
  /** Pause between proxies, ms (default 4000). */
  gapMs?: number
  /** Sweep interval, ms (default 10 min). */
  sweepMs?: number
  now?: () => number
}

const key = (chain: ChainId, address: string) => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`

export function createControl(o: ControlOptions): Control {
  const now = o.now ?? Date.now
  const dir = path.join(o.dataDir, 'control')
  const entriesFile = path.join(dir, 'entries.json')
  const ctlFile = path.join(dir, 'controllers.json')
  const log: Log = (l, m) => o.log(l, redact(m))

  const entries = new Map<string, ControlEntry>()
  for (const e of readJson<ControlEntry[]>(entriesFile) ?? []) if (e && e.chain && e.address && (CONTROL_CLASSES as readonly string[]).includes(e.cls)) entries.set(key(e.chain, e.address), e)
  const controllers = new Map<string, ControllerInfo & { at: number }>(Object.entries(readJson<Record<string, ControllerInfo & { at: number }>>(ctlFile) ?? {}))

  const shared = o.rpc.usage()
  const limits: Record<string, number> = {}
  for (const c of EVM) limits[c] = o.evmCalls ?? Math.max(100, Math.floor((shared[c]?.limit ?? 0) * 0.05))
  const budget: RadarBudget = createRadarBudget(limits, path.join(dir, 'budget.json'), now, 0.15)

  const sharedRoom = (k: BudgetKey, n = 1) => {
    const u = o.rpc.usage()[k]
    return !u || u.limit - u.used - n >= Math.ceil(u.limit * 0.1)
  }

  let dirty = false
  let saveTimer: NodeJS.Timeout | null = null
  const save = () => {
    if (!dirty) return
    dirty = false
    try {
      writeJsonAtomic(entriesFile, [...entries.values()])
      writeJsonAtomic(ctlFile, Object.fromEntries(controllers))
    } catch (e) {
      log('warn', `control: save failed: ${(e as Error).message}`)
    }
  }
  const touch = () => {
    dirty = true
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      save()
    }, 5000)
    saveTimer.unref?.()
  }

  const cache: IdentifyCache = {
    get(chain, address) {
      const c = controllers.get(key(chain, address))
      return c && now() - c.at < WEEK ? c : null
    },
    set(chain, address, info) {
      controllers.set(key(chain, address), { ...info, at: now() })
    },
  }

  /** Index entries seen in the last sweep that still need an RPC resolve. */
  let queue: { chain: ChainId; address: string }[] = []
  let summaryCache: { at: number; v: ControlSummary } | null = null

  async function sweep(): Promise<void> {
    const pending: { chain: ChainId; address: string; at: number }[] = []
    let cursor: string | undefined
    do {
      const page = o.store.items({ limit: 200, cursor })
      for (const it of page.items) {
        if (it.kind !== 'program' && it.kind !== 'contract') continue
        const k = key(it.chain, it.address)
        const cur = entries.get(k)
        if (cur && cur.cls !== 'pending' && cur.at >= it.readAt) {
          if (it.chain !== 'solana' && cur.calls > 0 && now() - cur.at > 4 * WEEK) pending.push({ chain: it.chain, address: it.address, at: cur.at })
          continue
        }
        const got = o.store.item(it.chain, it.address)
        if (!got) continue
        const read = got.read
        if (it.chain === 'solana') {
          entries.set(k, { ...classifySolana(read), name: read.name ?? it.name, at: now(), calls: 0 })
          touch()
        } else if (!read.proxy || read.proxy.standard === 'eip1167') {
          // no network needed: the code is fixed (or a clone)
          entries.set(k, { ...(await resolveEvm(read, () => Promise.reject(new Error('no call needed')))), name: read.name ?? it.name, at: now(), calls: 0 })
          touch()
        } else {
          if (!cur) {
            entries.set(k, { chain: it.chain, address: it.address, name: read.name ?? it.name, cls: 'pending', hops: [], basis: 'proxy: controller not resolved yet', at: 0, calls: 0 })
            touch()
          }
          pending.push({ chain: it.chain, address: it.address, at: cur?.at ?? 0 })
        }
      }
      cursor = page.next ?? undefined
      // reads come off disk synchronously: yield between pages
      await new Promise((r) => setImmediate(r))
    } while (cursor && !stopped)
    pending.sort((a, b) => a.at - b.at)
    queue = pending.map(({ chain, address }) => ({ chain, address }))
    summaryCache = null
  }

  async function resolveOne(chain: ChainId, address: string): Promise<'ok' | 'budget' | 'skip'> {
    if (!budget.can(chain, 8) || !sharedRoom(chain as BudgetKey, 8)) return 'budget'
    const got = o.store.item(chain, address)
    if (!got) return 'skip'
    let calls = 0
    const call: EvmCall = (method, params) => {
      if (!sharedRoom(chain as BudgetKey)) return Promise.reject(new BudgetError(chain as BudgetKey))
      try {
        budget.charge(chain)
      } catch (e) {
        return Promise.reject(e)
      }
      calls++
      return o.rpc.call(chain, method, params, { timeoutMs: 8000, maxBytes: 64_000 })
    }
    try {
      const r = await resolveEvm(got.read, call, cache)
      entries.set(key(chain, address), { ...r, name: got.read.name ?? got.item.name, at: now(), calls })
      touch()
      summaryCache = null
      return 'ok'
    } catch (e) {
      if (e instanceof BudgetError) return 'budget'
      log('warn', `control: ${chain} ${address} not resolved: ${(e as Error)?.message ?? e}`)
      return 'skip'
    }
  }

  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let lastSweep = 0
  const sweepMs = o.sweepMs ?? 600_000
  const gapMs = o.gapMs ?? 4000

  async function tick(): Promise<void> {
    if (now() - lastSweep >= sweepMs || lastSweep === 0) {
      lastSweep = now()
      await sweep()
    }
    // one proxy per tick; skip chains out of budget for this pass
    const blocked = new Set<ChainId>()
    for (let i = 0; i < queue.length; i++) {
      const q = queue[i]
      if (blocked.has(q.chain)) continue
      const r = await resolveOne(q.chain, q.address)
      if (r === 'budget') {
        blocked.add(q.chain)
        continue
      }
      queue.splice(i, 1)
      return
    }
  }

  const loop = async () => {
    if (stopped) return
    try {
      await tick()
    } catch (e) {
      log('warn', `control: ${(e as Error)?.message ?? e}`)
    }
    if (!stopped) {
      timer = setTimeout(loop, queue.length ? gapMs : 60_000)
      timer.unref?.()
    }
  }

  function summary(): ControlSummary {
    if (summaryCache && now() - summaryCache.at < 5000) return summaryCache.v
    const byChain: ControlSummary['byChain'] = {}
    const byClass: ControlSummary['byClass'] = {}
    const ctl = new Map<string, ControlController>()
    let pending = 0
    for (const e of entries.values()) {
      ;(byChain[e.chain] ??= {})[e.cls] = (byChain[e.chain][e.cls] ?? 0) + 1
      byClass[e.cls] = (byClass[e.cls] ?? 0) + 1
      if (e.cls === 'pending') pending++
      const last = e.hops[e.hops.length - 1]
      if (e.hops.length > 1 && last?.address && e.cls !== 'immutable' && e.cls !== 'unknown') {
        const k = key(e.chain, last.address)
        const c = ctl.get(k) ?? { chain: e.chain, address: last.address, label: last.label, cls: e.cls, count: 0 }
        c.count++
        ctl.set(k, c)
      }
    }
    const topControllers = [...ctl.values()].filter((c) => c.count >= 2).sort((a, b) => b.count - a.count || a.address.localeCompare(b.address)).slice(0, 12)
    const v: ControlSummary = { total: entries.size, resolved: entries.size - pending, pending, byChain, byClass, topControllers, budget: budget.usage(), updatedAt: now() }
    summaryCache = { at: now(), v }
    return v
  }

  const ORDER: Record<ControlClass, number> = { key: 0, pda: 1, safe: 2, timelock: 3, contract: 4, unknown: 5, pending: 6, immutable: 7 }

  return {
    start() {
      if (timer || stopped) return
      timer = setTimeout(loop, 15_000)
      timer.unref?.()
      log('info', `control map: ${entries.size} entries stored; EVM resolver slice ${limits.ethereum}/day per chain`)
    },
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = null
      dirty = true
      save()
      budget.flush()
    },
    summary,
    list(q) {
      let all = [...entries.values()]
      if (q.chain) all = all.filter((e) => e.chain === q.chain)
      if (q.cls) all = all.filter((e) => e.cls === q.cls)
      all.sort((a, b) => ORDER[a.cls] - ORDER[b.cls] || b.hops.length - a.hops.length || (a.name ?? '~').localeCompare(b.name ?? '~') || a.address.localeCompare(b.address))
      const off = q.cursor ? Math.max(0, parseInt(q.cursor, 10) || 0) : 0
      const n = Math.min(100, Math.max(1, q.limit ?? 50))
      const items = all.slice(off, off + n)
      return { items, total: all.length, next: off + n < all.length ? String(off + n) : null }
    },
    get: (chain, address) => entries.get(key(chain, address)) ?? null,
    tick,
  }
}
