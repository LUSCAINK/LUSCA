// EXPOSURE (server/exposure): which keys are already public on-chain, and what each one holds and controls.
//   GET /api/exposure/:chain/:address   live reads (per-address cache 10 min; per-IP + global minute/day caps)
//   GET /api/exposure/summary           Exposure Map from the Control Map's stored entries (cached ≥ 1 h; EOA nonces
//                                       refreshed in a bounded background pass, never on the request path)
//   GET /api/exposure/status            limits and usage
// Env: LUSCA_EXPOSURE=0 off · LUSCA_EXPOSURE_IP_PER_MIN (4) · LUSCA_EXPOSURE_IP_PER_DAY (40)
//      LUSCA_EXPOSURE_PER_MIN (20) · LUSCA_EXPOSURE_PER_DAY (600)
//      LUSCA_EXPOSURE_SOL_CALLS / LUSCA_EXPOSURE_EVM_CALLS: Exposure's daily share of each chain budget, in budget
//      units (default 10 % of the shared limit), charged on top of the shared budget (which is never exceeded);
//      at most 25 % of a share in one clock hour. Persisted in <data>/exposure/budget.json (write-ahead).
//      At most 1 Exposure call in flight on Solana and 2 per EVM chain, so the chain agents always keep a slot;
//      the wait for a slot counts against the lookup deadline.
//      LUSCA_EXPOSURE_SUMMARY_CALLS (EVM nonce reads per summary pass, 40)
import fs from 'node:fs'
import path from 'node:path'
import type { ControlEntry } from '../../shared/control.ts'
import { isSolanaAddress } from '../../shared/base58.ts'
import { EXPOSURE_CHAINS, type ExposureBucket, type ExposureChain, type ExposureReport, type ExposureStatus, type ExposureSummary } from '../../src/lib/exposure-types.ts'
import { BudgetError, DEFAULT_LIMITS, type RpcCtx, redact } from '../chain/rpc.ts'
import { createWindow } from '../lens/index.ts'
import { DeadlineError, ExposureBudgetError, type KnownIndex, type LookupCtx, NO_KNOWN } from './common.ts'
import { lookupEvm, hexInt } from './evm.ts'
import { lookupSolana } from './solana.ts'

type Log = (l: 'info' | 'warn' | 'error', m: string) => void
export interface ControlLike {
  list(q: { chain?: never; controller?: string; limit?: number; cursor?: string }): { items: ControlEntry[]; next: string | null }
  get(chain: never, address: string): ControlEntry | null
}
export interface ExposureOptions {
  rpc: RpcCtx
  control?: { list(q: { controller?: string; limit?: number; cursor?: string }): { items: ControlEntry[]; next: string | null }; get(chain: ExposureChain, address: string): ControlEntry | null } | null
  dataDir?: string
  log?: Log
  now?: () => number
  limits?: { ipPerMin?: number; ipPerDay?: number; perMin?: number; perDay?: number; summaryCalls?: number; budget?: Partial<Record<ExposureChain, number>>; hourShare?: number }
  lookupTimeoutMs?: number
}
export interface Exposure {
  route(p: string, ip: string): Promise<{ status: number; json: string; headers?: Record<string, string> }>
  lookup(chain: ExposureChain, address: string): Promise<ExposureReport>
  summary(): ExposureSummary
  refreshSummary(): Promise<void>
  start(): void
  stop(): void
}

const env = (k: string, d: number) => {
  const v = Number(process.env[k])
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : d
}
const CACHE_MS = 10 * 60_000
const SUMMARY_MS = 60 * 60_000

/** Validated (chain, address) → canonical form, or a plain 400 reason. */
export function validate(chain: string, address: string): { chain: ExposureChain; address: string } | { error: string } {
  const c = chain.toLowerCase()
  if (!(EXPOSURE_CHAINS as readonly string[]).includes(c)) return { error: 'chain must be solana, ethereum, base or arbitrum' }
  const a = address.trim()
  if (c === 'solana') return isSolanaAddress(a) ? { chain: 'solana', address: a } : { error: 'not a Solana address (base58, 32 bytes)' }
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? { chain: c as ExposureChain, address: a.toLowerCase() } : { error: 'not an EVM address (0x + 40 hex characters)' }
}

export function createExposure(o: ExposureOptions): Exposure {
  const now = o.now ?? Date.now
  const log: Log = (l, m) => o.log?.(l, redact(m))
  const minLim = createWindow(60_000, o.limits?.perMin ?? env('LUSCA_EXPOSURE_PER_MIN', 20), now)
  const dayMax = o.limits?.perDay ?? env('LUSCA_EXPOSURE_PER_DAY', 600)
  const ipPerMin = o.limits?.ipPerMin ?? env('LUSCA_EXPOSURE_IP_PER_MIN', 4)
  const ipDayMax = o.limits?.ipPerDay ?? env('LUSCA_EXPOSURE_IP_PER_DAY', 40)
  let ipDay = new Map<string, number>()
  const summaryCalls = o.limits?.summaryCalls ?? env('LUSCA_EXPOSURE_SUMMARY_CALLS', 40)
  const ipLim = createWindow(60_000, ipPerMin, now)
  let day = { d: new Date(now()).toISOString().slice(0, 10), used: 0 }
  let minUsed: number[] = []
  const cache = new Map<string, { at: number; r: ExposureReport }>()
  const inflight = new Map<string, Promise<ExposureReport>>()
  const dir = o.dataDir ? path.join(o.dataDir, 'exposure') : null
  const nonceFile = dir ? path.join(dir, 'nonces.json') : null
  const nonces: Record<string, { n: number; at: number }> = (() => {
    try {
      return nonceFile ? (JSON.parse(fs.readFileSync(nonceFile, 'utf8')) as Record<string, { n: number; at: number }>) : {}
    } catch {
      return {}
    }
  })()
  let summary: ExposureSummary | null = null
  let summaryAt = 0
  let refreshing = false
  let timer: NodeJS.Timeout | null = null

  const allEntries = (): ControlEntry[] => {
    if (!o.control) return []
    const out: ControlEntry[] = []
    let cursor: string | undefined
    for (let i = 0; i < 200; i++) {
      const pg = o.control.list({ limit: 200, ...(cursor ? { cursor } : {}) })
      out.push(...pg.items)
      if (!pg.next) break
      cursor = pg.next
    }
    return out
  }
  const known: KnownIndex = o.control
    ? {
        controlledBy: (a) => {
          try {
            return o.control!.list({ controller: a, limit: 50 }).items
          } catch {
            return []
          }
        },
        entry: (c, a) => {
          try {
            return o.control!.get(c, a)
          } catch {
            return null
          }
        },
        safesOf: () => [],
      }
    : NO_KNOWN

  // ── Exposure's own share of each chain budget (on top of the shared one), per UTC day and per clock hour ──
  const DAY = 86_400_000
  const HOUR = 3_600_000
  const sharedLimit = (c: ExposureChain): number => {
    try {
      const u = o.rpc.usage()[c]
      if (u && Number.isFinite(u.limit)) return u.limit
    } catch {
      /* default */
    }
    return DEFAULT_LIMITS[c]
  }
  const share: Record<ExposureChain, number> = Object.fromEntries(
    EXPOSURE_CHAINS.map((c) => [c, o.limits?.budget?.[c] ?? env(c === 'solana' ? 'LUSCA_EXPOSURE_SOL_CALLS' : 'LUSCA_EXPOSURE_EVM_CALLS', Math.floor(sharedLimit(c) * 0.1))]),
  ) as Record<ExposureChain, number>
  const hourShare = o.limits?.hourShare ?? 0.25
  const budgetFile = dir ? path.join(dir, 'budget.json') : null
  let bDay = Math.floor(now() / DAY)
  let bHour = Math.floor(now() / HOUR)
  let used: Partial<Record<ExposureChain, number>> = {}
  let hourUsed: Partial<Record<ExposureChain, number>> = {}
  try {
    const j = budgetFile ? (JSON.parse(fs.readFileSync(budgetFile, 'utf8')) as { day?: number; used?: Record<string, number> }) : null
    if (j?.day === bDay && j.used) for (const c of EXPOSURE_CHAINS) if (Number.isFinite(j.used[c]) && j.used[c] > 0) used[c] = Math.floor(j.used[c])
  } catch {
    /* first day */
  }
  let onDisk: Partial<Record<ExposureChain, number>> = { ...used }
  const RESERVE = 40
  const rollBudget = () => {
    const d = Math.floor(now() / DAY)
    if (d !== bDay) {
      bDay = d
      used = {}
      onDisk = {}
    }
    const h = Math.floor(now() / HOUR)
    if (h !== bHour) {
      bHour = h
      hourUsed = {}
    }
  }
  /** Why `w` more units on `c` do not fit Exposure's share now, else null. */
  const shareWhy = (c: ExposureChain, w: number): 'day' | 'hour' | null => {
    rollBudget()
    if ((used[c] ?? 0) + w > share[c]) return 'day'
    if ((hourUsed[c] ?? 0) + w > Math.max(1, Math.ceil(share[c] * hourShare))) return 'hour'
    return null
  }
  const charge = (c: ExposureChain, w: number) => {
    const next = (used[c] ?? 0) + w
    if (budgetFile && dir && next > (onDisk[c] ?? 0)) {
      // write-ahead: the file always holds at least what was charged, so a restart never forgets spent units
      const ahead = { ...used, [c]: Math.min(share[c], next + RESERVE) }
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${budgetFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ day: bDay, used: ahead }))
      fs.renameSync(tmp, budgetFile)
      onDisk = ahead
    }
    used[c] = next
    hourUsed[c] = (hourUsed[c] ?? 0) + w
  }

  // ── at most 1 Exposure call in flight on Solana, 2 per EVM chain; the wait counts against the deadline ──
  const gates = new Map<ExposureChain, { active: number; q: { wake: () => void }[] }>()
  async function enter(c: ExposureChain, deadline: number) {
    let g = gates.get(c)
    if (!g) gates.set(c, (g = { active: 0, q: [] }))
    const max = c === 'solana' ? 1 : 2
    while (g.active >= max) {
      const left = deadline - now()
      if (left <= 0) throw new DeadlineError()
      await new Promise<void>((res) => {
        const w = { wake: () => (clearTimeout(t), res()) }
        const t = setTimeout(() => {
          const i = g!.q.indexOf(w)
          if (i >= 0) g!.q.splice(i, 1)
          res()
        }, left)
        g!.q.push(w)
      })
    }
    g.active++
  }
  const leave = (c: ExposureChain) => {
    const g = gates.get(c)
    if (!g) return
    g.active--
    g.q.shift()?.wake()
  }

  function ctxFor(deadline: number, counter: { n: number }): LookupCtx {
    return {
      async call(chain, method, params, opt) {
        if (now() > deadline) throw new DeadlineError()
        const w = Math.max(1, Math.floor(opt?.weight ?? 1))
        const pre = shareWhy(chain, w)
        if (pre) throw new ExposureBudgetError(chain, pre)
        if (!o.rpc.canSpend(chain, w)) throw new BudgetError(chain)
        await enter(chain, deadline)
        try {
          if (now() > deadline) throw new DeadlineError()
          const why = shareWhy(chain, w)
          if (why) throw new ExposureBudgetError(chain, why)
          if (!o.rpc.canSpend(chain, w)) throw new BudgetError(chain)
          charge(chain, w)
          counter.n++
          const left = Math.max(1000, deadline - now())
          return await o.rpc.call(chain, method, params as unknown[], { timeoutMs: Math.min(opt?.timeoutMs ?? 8000, left), ...(opt?.maxBytes ? { maxBytes: opt.maxBytes } : {}), weight: w })
        } finally {
          leave(chain)
        }
      },
      short(chain, w) {
        const why = shareWhy(chain, w)
        if (why === 'day') return `Exposure's daily share of LUSCA's ${chain} reads is used up (resets 00:00 UTC)`
        if (why === 'hour') return `Exposure has used this hour's share of its ${chain} reads (frees at the next full hour, UTC)`
        return o.rpc.canSpend(chain, w) ? null : `LUSCA's shared daily ${chain} read budget is used up (resets 00:00 UTC)`
      },
    }
  }

  async function lookup(chain: ExposureChain, address: string): Promise<ExposureReport> {
    const k = `${chain}:${address}`
    const hit = cache.get(k)
    if (hit && now() - hit.at < CACHE_MS) return { ...hit.r, cached: true, calls: 0 }
    const running = inflight.get(k)
    if (running) return running
    const p = (async () => {
      const counter = { n: 0 }
      const ctx = ctxFor(now() + (o.lookupTimeoutMs ?? 25_000), counter)
      const res = chain === 'solana' ? await lookupSolana(ctx, address, known) : await lookupEvm(ctx, chain, address, known)
      const r: ExposureReport = { v: 1, chain, address, readAt: now(), cached: false, ...res, calls: counter.n }
      cache.set(k, { at: r.readAt, r })
      if (cache.size > 2000) for (const [ck, v] of cache) if (now() - v.at > CACHE_MS || cache.size > 2000) cache.delete(ck)
      return r
    })().finally(() => inflight.delete(k))
    inflight.set(k, p)
    return p
  }

  function computeSummary(): ExposureSummary {
    const entries = allEntries()
    const sol = entries.filter((e) => e.chain === 'solana' && e.cls !== 'pending')
    const evm = entries.filter((e) => e.chain !== 'solana' && e.cls !== 'pending')
    const b = (id: string, label: string, n: number, basis: string, exposed?: boolean): ExposureBucket => ({ id, label, n, basis, ...(exposed !== undefined ? { exposed } : {}) })
    const cnt = (xs: ControlEntry[], f: (e: ControlEntry) => boolean) => xs.filter(f).length
    const finalKey = (e: ControlEntry) => {
      const h = e.hops[e.hops.length - 1]
      return h && (h.kind === 'eoa' || h.kind === 'key') && h.address ? h.address.toLowerCase() : null
    }
    let evmExposed = 0
    let evmZero = 0
    let evmUnread = 0
    for (const e of evm.filter((x) => x.cls === 'key')) {
      const a = finalKey(e)
      const n = a ? nonces[`${e.chain}:${a}`] : undefined
      if (!n) evmUnread++
      else if (n.n > 0) evmExposed++
      else evmZero++
    }
    const safeStats = new Map<string, number>()
    for (const e of evm.filter((x) => x.cls === 'safe')) {
      const h = e.hops.find((x) => x.kind === 'safe')
      const label = h?.threshold && h?.owners ? `${h.threshold} of ${h.owners}` : 'k of n not read'
      safeStats.set(label, (safeStats.get(label) ?? 0) + 1)
    }
    const partial: string[] = []
    if (evmUnread) partial.push(`${evmUnread} EVM contracts controlled by a single key: that key's nonce not read yet (bounded background reads)`)
    if (safeStats.size) partial.push('Safe owners: not read for the map in this version (look a Safe up above to read its owners)')
    return {
      v: 1,
      readAt: now(),
      groups: [
        {
          id: 'solana-programs',
          label: 'Solana programs',
          total: sol.length,
          basis: "Programs LUSCA keeps, by their upgrade authority from the stored ProgramData read (LUSCA's Control Map).",
          buckets: [
            b('single-key', 'Upgrade authority is a single key', cnt(sol, (e) => e.cls === 'key'), 'The upgrade authority is an Ed25519 wallet key: its public key is the address, so it is public.', true),
            b('pda-multisig', 'Upgrade authority is a PDA or multisig', cnt(sol, (e) => e.cls === 'pda' || e.cls === 'safe'), 'Off-curve authority: a program signs, so the exposure moves to its signers or upgrader.'),
            b('immutable', 'Immutable (no upgrade authority)', cnt(sol, (e) => e.cls === 'immutable'), 'The ProgramData upgrade authority is None: no key can change the code.'),
            b('unknown', 'Upgrade authority not resolved', cnt(sol, (e) => !['key', 'pda', 'safe', 'immutable'].includes(e.cls)), 'Not resolved from stored reads.'),
          ],
        },
        {
          id: 'evm-contracts',
          label: 'EVM contracts',
          total: evm.length,
          basis: "Contracts LUSCA keeps on Ethereum, Base and Arbitrum, by who can change their code (LUSCA's Control Map), with the controlling key's nonce where read.",
          buckets: [
            b('eoa-exposed', 'Single key, already exposed (nonce > 0)', evmExposed, 'The final controller is an EOA that has sent transactions: its public key is recoverable from any of them.', true),
            b('eoa-nonce0', 'Single key, nonce 0', evmZero, 'The final controller is an EOA with nonce 0: no transaction exposes it (published signatures still can).'),
            b('eoa-unread', 'Single key, nonce not read yet', evmUnread, 'Final controller is an EOA; its nonce is read in bounded background passes.'),
            b('safe', 'Safe multisig', cnt(evm, (e) => e.cls === 'safe'), 'A Safe controls the code; owners publish ECDSA signatures at every execution.'),
            b('timelock', 'Timelock', cnt(evm, (e) => e.cls === 'timelock'), 'A timelock sits in the control path; changes wait for its delay.'),
            b('immutable', 'Immutable', cnt(evm, (e) => e.cls === 'immutable'), 'Not a proxy and no upgrade path found: the code cannot be changed. Owner, admin, pause or mint roles held by keys are not counted here.'),
            b('other', 'Other contract or not resolved', cnt(evm, (e) => !['key', 'safe', 'timelock', 'immutable'].includes(e.cls)), 'Controlled by another contract, or not resolved.'),
          ],
        },
      ],
      ...(safeStats.size ? { safes: [...safeStats].sort((x, y) => y[1] - x[1]).map(([label, safes]) => ({ label, safes })) } : {}),
      basis: `${entries.length} kept programs and contracts from LUSCA's Control Map; counts are from stored reads, not estimates.`,
      refreshing,
      partial,
    }
  }

  function summaryNow(): ExposureSummary {
    if (!summary || now() - summaryAt > SUMMARY_MS) {
      try {
        summary = computeSummary()
        summaryAt = now()
      } catch (e) {
        log('warn', `exposure summary: ${(e as Error).message}`)
      }
    }
    return { ...(summary ?? { v: 1, readAt: now(), groups: [], basis: 'Control Map not available on this server.', partial: [] }), refreshing } as ExposureSummary
  }

  async function refreshSummary(): Promise<void> {
    if (refreshing || !o.control) return
    refreshing = true
    try {
      const want = new Set<string>()
      for (const e of allEntries()) {
        if (e.chain === 'solana' || e.cls !== 'key') continue
        const h = e.hops[e.hops.length - 1]
        if (!h?.address) continue
        const k = `${e.chain}:${h.address.toLowerCase()}`
        const n = nonces[k]
        if (!n || now() - n.at > 7 * 86_400_000) want.add(k)
      }
      let spent = 0
      for (const k of want) {
        if (spent >= summaryCalls) break
        const [chain, a] = k.split(':') as [ExposureChain, string]
        if (!o.rpc.canSpend(chain, 1)) continue
        spent++
        try {
          const v = hexInt(await o.rpc.call(chain, 'eth_getTransactionCount', [a, 'latest'], { timeoutMs: 8000 }))
          if (v !== null) nonces[k] = { n: Number(v), at: now() }
        } catch {
          /* next pass */
        }
      }
      if (spent && nonceFile && dir) {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(nonceFile, JSON.stringify(nonces))
      }
      summary = computeSummary()
      summaryAt = now()
    } finally {
      refreshing = false
    }
  }

  const json = (status: number, v: unknown, headers?: Record<string, string>) => ({ status, json: JSON.stringify(v), ...(headers ? { headers } : {}) })

  function status(): ExposureStatus {
    const t = now()
    minUsed = minUsed.filter((x) => x > t - 60_000)
    rollBudget()
    return { perIp: { perMinute: ipPerMin, perDay: ipDayMax }, budget: Object.fromEntries(EXPOSURE_CHAINS.map((c) => [c, { used: used[c] ?? 0, limit: share[c] }])), perMinute: { used: minUsed.length, limit: o.limits?.perMin ?? env('LUSCA_EXPOSURE_PER_MIN', 20) }, perDay: { used: day.used, limit: dayMax }, cacheTtlMs: CACHE_MS, chains: [...EXPOSURE_CHAINS] }
  }

  async function route(p: string, ip: string) {
    const segs = p.replace(/^\/api\/exposure\/?/, '').split('/').filter(Boolean)
    if (segs.length === 1 && segs[0] === 'summary') return json(200, summaryNow(), { 'cache-control': 'public, max-age=300' })
    if (segs.length === 1 && segs[0] === 'status') return json(200, status(), { 'cache-control': 'no-store' })
    if (segs.length !== 2) return json(404, { error: 'not found' })
    const v = validate(decodeURIComponent(segs[0]), decodeURIComponent(segs[1]))
    if ('error' in v) return json(400, { error: v.error })
    const k = `${v.chain}:${v.address}`
    const hit = cache.get(k)
    if (!(hit && now() - hit.at < CACHE_MS) && !inflight.has(k)) {
      const d = new Date(now()).toISOString().slice(0, 10)
      if (d !== day.d) {
        day = { d, used: 0 }
        ipDay = new Map()
      }
      if ((ipDay.get(ip) ?? 0) >= ipDayMax) return json(429, { error: `your connection has used today's ${ipDayMax} lookups (resets 00:00 UTC); answers already read stay free for 10 minutes` })
      const wIp = ipLim.take(ip)
      if (wIp > 0) return json(429, { error: `at most ${ipPerMin} new lookups per minute from your connection, retry shortly`, retryMs: wIp }, { 'retry-after': String(Math.ceil(wIp / 1000)) })
      const wAll = minLim.take('all')
      if (wAll > 0) {
        ipLim.refund(ip)
        return json(429, { error: 'Exposure is busy, retry in a minute', retryMs: wAll }, { 'retry-after': String(Math.ceil(wAll / 1000)) })
      }
      if (day.used >= dayMax) {
        ipLim.refund(ip)
        return json(429, { error: "today's Exposure lookups are used up (resets 00:00 UTC)" })
      }
      day.used++
      if (ipDay.size < 100_000) ipDay.set(ip, (ipDay.get(ip) ?? 0) + 1)
      minUsed.push(now())
    }
    try {
      const r = await lookup(v.chain, v.address)
      return json(200, r, { 'cache-control': 'public, max-age=60' })
    } catch (e) {
      log('warn', `exposure ${v.chain}: ${(e as Error).message}`)
      return json(502, { error: 'the lookup failed, retry later' })
    }
  }

  return {
    route,
    lookup,
    summary: summaryNow,
    refreshSummary,
    start() {
      if (timer) return
      const run = () => void refreshSummary().catch((e) => log('warn', `exposure summary refresh: ${(e as Error).message}`))
      const first = setTimeout(run, 90_000)
      first.unref?.()
      timer = setInterval(run, SUMMARY_MS)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
