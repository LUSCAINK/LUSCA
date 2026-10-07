// SCAN — /scan: watch the chain agents read programs and contracts, call by call. Nothing to type.
//
// Every read an agent makes arrives over the WebSocket ({ t: 'chain', event }; the page sends
// { t: 'chain.scan', on: true } so its events carry ChainEvent.trace — method, target, provider,
// start offset, wait, duration, result — and ChainEvent.scan, what the read decoded). The page plays
// one read at a time: a window opens on the read's Lens address, the call log runs the calls in their
// real order and relative timing (scaled to fit), each call lights the link between the LUSCA hub and
// the provider that answers it (Helius for Solana program reads in production), each decoded field
// appears when the call that produced it answers, a bounding box locks onto it and a wire runs to a
// detection chip or the hub. With no new read in the queue, recent reads from /api/chain/feed?scan=1
// are replayed, labelled with the time they were read. Nothing here is invented: an unknown field is
// not drawn.
//
// One requestAnimationFrame loop drives the playback: class flips at reveal times, then every
// rectangle it needs is read, then every style and attribute is written (one layout per frame). It
// sleeps while nothing moves (and between frames in reduced motion) and stops while the tab is hidden.
//
// Upgrade radar: a code change the radar caught and read ({ t: 'radar', event }) plays on the same stage,
// labelled "RADAR · UPGRADE CAUGHT", with the radar's own calls and the before → after it read.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Link } from 'react-router-dom'
import type { ChainEvent, ChainId, ScanCall } from '@shared/chain'
import type { RadarEvent } from '@shared/radar'
import { Kicker } from '@/components/docs/pagekit'
import { connLed } from '@/components/ui/conn'
import { bus } from '@/lib/bus'
import { CHAIN_LABEL, CHAIN_SHORT, KIND_LABEL, VERDICT_LABEL, isChainId, shortAddress, useChain, useChainLive } from '@/lib/chain'
import { useConn, useMedia } from '@/lib/hooks'
import { send } from '@/lib/live'
import { DASH, fmtInt } from '@/lib/format'
import { KIND_BADGE, VERIFIED_WORD } from '@/lib/radar'
import './scan.css'

/** Position of /scan in the primary navigation (src/components/shell/Shell.tsx NAV). */
const SCAN_NAV_N = '07'

// ─── plan: one read → rows, calls, sources and their times ─────────────────

type Tone = 'hot' | 'ice'

interface Row {
  id: string
  label: string
  value: string
  sub?: string
  /** Label of the bounding box that locks onto the value. */
  tag?: string
  tone?: Tone
  /** Chip by the hub. */
  chip?: { label: string; value: string }
  /** Small names listed under the row (instructions, functions, files): each gets a minor box. */
  minis?: string[]
  more?: number
  href?: string
  kind?: 'name' | 'kv' | 'note' | 'fail'
  /** The value is an address (shown as is, never uppercased). */
  addr?: boolean
  at: number
}

interface LogRow {
  id: string
  c: ScanCall
  /** Playback times (ms into the show): issued, request out (after LUSCA's own pacing wait), answered. */
  start: number
  sent: number
  end: number
}

/** Who answered calls of this read: one node per provider, linked to the hub. */
interface Src {
  id: string
  name: string
  kind: 'rpc' | 'registry'
  label: string
  hot: boolean
  calls: LogRow[]
}

/** A read to play: a chain agent's read, or a code change caught by the upgrade radar. */
type PlayEvent = ChainEvent & { radar?: RadarEvent }

/** Radar events worth the stage: read, and a real change (EVM proxy deployments are left to /radar). */
function playableRadar(r: RadarEvent): boolean {
  // caught live only: a backfilled change is history, not a catch
  if (r.state === 'pending' || r.backfill) return false
  return r.kind !== 'deploy' || r.chain === 'solana' || r.known
}

/** The radar event as a read the player understands; its trace is the calls the radar made for it. */
function radarToPlay(r: RadarEvent): PlayEvent {
  const sol = r.chain === 'solana'
  return {
    id: `radar-${r.id}`,
    ts: r.updatedAt,
    agent: 'radar',
    chain: r.chain,
    address: r.address,
    name: r.name,
    kind: sol ? 'program' : 'contract',
    via: 'block',
    verdict: 'kept',
    reason: r.headline,
    idl: false,
    verifiedBy: null,
    sourceFiles: 0,
    sourceBytes: 0,
    trace: r.trace ?? [],
    scan: {},
    radar: r,
  }
}

interface Show {
  seq: number
  ev: PlayEvent
  live: boolean
  rows: Row[]
  log: LogRow[]
  sources: Src[]
  dur: number
  stampAt: number
  closeAt: number
  /** Who answered this read's RPC calls ('Helius' …), from the trace. */
  rpcProvider: string | null
  /** Real time from the first call's start to the last call's end, ms. */
  realMs: number
  /** Seconds between the read and the start of its playback. */
  lag: number
}

const STD_LABEL: Record<string, string> = {
  eip1967: 'EIP-1967 proxy',
  eip1822: 'EIP-1822 proxy',
  beacon: 'EIP-1967 beacon proxy',
  eip1167: 'EIP-1167 clone',
  other: 'proxy',
}

const LOADER_WORDS: Record<string, string> = {
  'bpf-upgradeable': 'BPF upgradeable loader (v3)',
  'bpf-loader-2': 'BPF loader v2 · not upgradeable',
  'bpf-loader-1': 'BPF loader v1 · not upgradeable',
  'loader-v4': 'loader v4',
  native: 'native loader (built-in program)',
}

const VIA_WORDS: Record<string, string> = {
  block: 'found in a recent block',
  registry: 'found in a verified-source registry',
  web: 'found on a page the web agents kept',
  link: 'linked from another contract',
  lens: 'read on request (Lens)',
}

const REGISTRY_WHAT: Record<string, string> = {
  OtterSec: 'Registry · verified builds',
  Sourcify: 'Registry · verified source',
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const ease = (x: number) => 1 - Math.pow(1 - clamp(x, 0, 1), 3)
const base = (p: string) => p.split('/').pop() || p
const short = (a: string) => shortAddress(a, 4, 4)
const isHelius = (p: string | null | undefined) => !!p && /helius/i.test(p)

interface Draft extends Omit<Row, 'at'> {
  /** Index of the call whose answer produced this field; -1 = known before the read (the address), null = no trace. */
  after: number | null
}

function planShow(ev: ChainEvent, live: boolean, backlog: number, seq: number): Show {
  const s = ev.scan ?? {}
  const trace = ev.trace ?? []
  const sol = ev.chain === 'solana'
  const has = trace.length > 0
  const idx = (pred: (c: ScanCall, i: number) => boolean) => {
    const i = trace.findIndex(pred)
    return i >= 0 ? i : null
  }
  const anchor = (...xs: (number | null)[]) => {
    for (const x of xs) if (x !== null && x !== undefined) return x
    return has ? trace.length - 1 : null
  }
  const gma = idx((c) => c.method === 'getMultipleAccounts')
  const gma2 = gma === null ? null : idx((c, i) => i > gma && c.method === 'getMultipleAccounts')
  const osec = idx((c) => c.method === 'OtterSec')
  const code = idx((c) => c.method === 'eth_getCode')
  const impl = idx((c) => (c.method === 'eth_getStorageAt' || c.method === 'eth_call') && c.result.startsWith('→') && !/admin/i.test(c.target))
  const admin = idx((c) => c.method === 'eth_getStorageAt' && /admin/i.test(c.target) && c.result.startsWith('→'))
  const sfy = idx((c) => c.method === 'Sourcify')
  const failed = idx((c) => !c.ok)
  const decoded = sol ? anchor(gma2, gma) : anchor(code)
  const source = sol ? anchor(osec, decoded) : anchor(sfy, decoded)

  const d: Draft[] = []
  const radar = (ev as PlayEvent).radar
  if (radar) return planRadar(ev as PlayEvent, radar, live, backlog, seq)
  const nameAfter = sol ? decoded : anchor(sfy, code)
  const title = ev.name ?? s.project?.name ?? null
  d.push({ id: 'name', kind: 'name', label: KIND_LABEL[ev.kind] ?? ev.kind, value: title ?? short(ev.address), addr: !title, after: title ? nameAfter : -1, tag: title ? 'NAME' : undefined, tone: 'ice' })
  d.push({ id: 'addr', label: 'Address', value: ev.address, addr: true, after: -1 })
  d.push({ id: 'chain', label: 'Chain', value: `${CHAIN_LABEL[ev.chain] ?? ev.chain} · ${VIA_WORDS[ev.via] ?? ev.via}`, after: -1 })

  if (sol) {
    if (ev.kind === 'program' || s.loader) {
      const loader = s.loader ? (LOADER_WORDS[s.loader] ?? s.loader) : null
      d.push({ id: 'loader', label: 'Loader', value: loader ?? KIND_LABEL[ev.kind], after: decoded, tag: 'PROGRAM', tone: 'hot', chip: { label: 'Program', value: loader ?? 'executable' } })
    }
    if (s.programBytes != null || s.deploySlot != null) {
      const parts = [s.programBytes != null ? `${fmtInt(s.programBytes)} bytes` : null, s.deploySlot != null ? `last deploy slot ${fmtInt(s.deploySlot)}` : null].filter(Boolean)
      d.push({ id: 'bytes', label: 'Program data', value: parts.join(' · '), after: anchor(gma2, decoded), tag: 'ELF', tone: 'ice' })
    }
    if (s.authority) {
      d.push({ id: 'auth', label: 'Upgrade authority', value: s.authority, addr: true, sub: 'can replace the program', after: anchor(gma2, decoded), tag: 'AUTHORITY', tone: 'hot', chip: { label: 'Upgrade authority', value: short(s.authority) } })
    } else if (s.upgradeable === false && ev.kind === 'program') {
      d.push({ id: 'auth', label: 'Upgrade authority', value: 'none · immutable', after: anchor(gma2, decoded), tag: 'IMMUTABLE', tone: 'hot', chip: { label: 'Upgrade authority', value: 'none · immutable' } })
    }
    if (s.codeHash) d.push({ id: 'hash', label: 'Code hash', value: `sha256 ${s.codeHash.slice(0, 24)}…`, after: decoded, tag: 'HASH', tone: 'ice' })
    if (s.project?.url) d.push({ id: 'proj', label: 'security.txt', value: s.project.url, after: decoded, tag: 'SECURITY.TXT', tone: 'ice' })
    if (s.idl) {
      const n = s.idl.names.length + s.idl.more
      d.push({
        id: 'idl',
        label: 'On-chain IDL',
        value: `${s.idl.source ?? 'IDL'} · ${fmtInt(n)} instruction${n === 1 ? '' : 's'}`,
        sub: [s.idl.accounts ? `${s.idl.accounts} account types` : null, s.idl.errors ? `${s.idl.errors} errors` : null, s.idl.events ? `${s.idl.events} events` : null].filter(Boolean).join(' · ') || undefined,
        minis: s.idl.names,
        more: s.idl.more,
        after: decoded,
        tag: 'IDL',
        tone: 'hot',
        chip: { label: 'Interface (IDL)', value: `${fmtInt(n)} instruction${n === 1 ? '' : 's'}` },
      })
    }
    if (s.verified?.by === 'osec') {
      const repo = s.verified.repo ? s.verified.repo.replace(/^https?:\/\/(www\.)?/, '') : null
      d.push({ id: 'ver', label: 'Verified build', value: `OtterSec verified${repo ? ` · ${repo}` : ''}${s.verified.commit ? ` @ ${s.verified.commit.slice(0, 7)}` : ''}`, after: source, tag: 'VERIFIED', tone: 'hot', chip: { label: 'Verified build', value: repo ?? 'OtterSec' } })
    } else if (osec !== null) {
      d.push({ id: 'ver', label: 'Verified build', value: `OtterSec · ${trace[osec].result}`, after: osec })
    }
  } else {
    if (s.bytecodeBytes != null) d.push({ id: 'code', label: 'Bytecode', value: `${fmtInt(s.bytecodeBytes)} bytes`, after: decoded, tag: 'CODE', tone: 'ice' })
    if (s.codeHash) d.push({ id: 'hash', label: 'Code hash', value: `sha256 ${s.codeHash.slice(0, 24)}…`, sub: s.trailer === true ? 'metadata trailer excluded' : undefined, after: decoded, tag: 'HASH', tone: 'ice' })
    if (s.proxy) {
      d.push({
        id: 'proxy',
        label: STD_LABEL[s.proxy.standard] ?? 'Proxy',
        value: `→ ${s.proxy.implementation}`,
        addr: true,
        sub: 'implementation',
        href: `/lens/${ev.chain}/${s.proxy.implementation}`,
        after: anchor(impl, s.proxy.standard === 'eip1167' ? decoded : null, sfy, decoded),
        tag: 'PROXY',
        tone: 'hot',
        chip: { label: 'Proxy → implementation', value: short(s.proxy.implementation) },
      })
      if (s.proxy.admin) d.push({ id: 'admin', label: 'Admin', value: s.proxy.admin, addr: true, sub: 'can upgrade the implementation', after: anchor(admin, impl), tag: 'ADMIN', tone: 'hot', chip: { label: 'Admin · can upgrade', value: short(s.proxy.admin) } })
    }
    if (s.verified?.by === 'sourcify') {
      const m = s.verified.match === 'full' ? 'full match' : s.verified.match === 'partial' ? 'partial match' : 'match'
      d.push({ id: 'ver', label: 'Verified source', value: `Sourcify ${m}${s.verified.compiler ? ` · ${s.verified.compiler}` : ''}`, after: source, tag: 'VERIFIED', tone: 'hot', chip: { label: 'Verified source', value: `Sourcify ${m}` } })
    } else if (sfy !== null) {
      d.push({ id: 'ver', label: 'Verified source', value: `Sourcify · ${trace[sfy].result}`, after: sfy })
    }
    if (s.files) {
      const n = s.files.paths.length + s.files.more
      d.push({ id: 'files', label: 'Source files', value: `${fmtInt(n)} file${n === 1 ? '' : 's'}`, minis: s.files.paths.map(base), more: s.files.more, after: source, tag: 'SOURCE', tone: 'ice' })
    }
    if (s.abi) {
      const n = s.abi.names.length + s.abi.more
      d.push({ id: 'abi', label: 'Functions', value: `${fmtInt(n)} function${n === 1 ? '' : 's'}${s.abi.events ? ` · ${fmtInt(s.abi.events)} events` : ''}`, minis: s.abi.names, more: s.abi.more, after: source, tag: 'ABI', tone: 'hot', chip: { label: 'ABI', value: `${fmtInt(n)} function${n === 1 ? '' : 's'}` } })
    }
    for (const [i, p] of (s.privileged?.items ?? []).slice(0, 5).entries()) {
      d.push({ id: `guard${i}`, label: i === 0 ? 'Privileged' : '', value: p.fn, sub: `${p.guard} · ${p.at}`, after: source, tag: 'GUARD', tone: 'hot', chip: i < 2 ? { label: `Guard · ${p.guard}`, value: `${p.fn.split('(')[0]}() · ${p.at}` } : undefined })
    }
    if (s.privileged?.more) d.push({ id: 'guardmore', kind: 'note', label: '', value: `+ ${s.privileged.more} more guarded functions`, after: source })
  }
  if (s.primitives?.length) {
    d.push({ id: 'prim', label: 'Primitives', value: s.primitives.join(' · '), sub: sol ? 'from the program binary' : 'from the verified source', after: sol ? decoded : source, tag: 'PRIMITIVE', tone: 'ice', chip: { label: 'Primitives', value: s.primitives.slice(0, 3).join(' · ') } })
  }
  if (ev.verdict === 'error') d.push({ id: 'fail', kind: 'fail', label: 'Read failed', value: ev.reason, after: anchor(failed), tag: 'FAILED', tone: 'hot' })
  for (const [i, n] of (s.notes ?? []).entries()) d.push({ id: `note${i}`, kind: 'note', label: i === 0 ? 'Notes' : '', value: n, after: has ? trace.length - 1 : null })

  return finishShow(ev, d, live, backlog, seq)
}

/** Rows of a radar event: what changed, before → after, each after the call that read it. */
function planRadar(ev: PlayEvent, r: RadarEvent, live: boolean, backlog: number, seq: number): Show {
  const trace = ev.trace ?? []
  const sol = r.chain === 'solana'
  const readAt = trace.length ? trace.findIndex((c) => c.method === 'getMultipleAccounts' || c.method === 'eth_getCode') : -1
  const after: number | null = trace.length ? (readAt >= 0 ? readAt : trace.length - 1) : null
  const reg = trace.findIndex((c) => c.kind === 'registry')
  const regAt: number | null = reg >= 0 ? reg : after
  const b = r.before
  const a = r.after
  const dd = r.diff
  const d: Draft[] = []
  const arrow = (x: string | null | undefined, y: string | null | undefined) => (x != null ? `${x} → ${y ?? 'not read'}` : (y ?? 'not read'))
  const h = (x: string | null | undefined) => (x ? `${x.slice(0, 16)}…` : null)
  d.push({ id: 'name', kind: 'name', label: `${KIND_BADGE[r.kind]} · ${CHAIN_LABEL[r.chain]}`, value: r.name ?? short(r.address), addr: !r.name, after: -1, tag: 'RADAR', tone: 'hot', chip: { label: 'RADAR · UPGRADE CAUGHT', value: KIND_BADGE[r.kind] } })
  d.push({ id: 'addr', label: sol ? 'Program' : 'Proxy', value: r.address, addr: true, after: -1 })
  d.push({ id: 'what', label: 'Caught', value: r.headline, sub: `via ${r.via}${r.tx ? ` · tx ${r.tx.slice(0, 10)}…` : ''}`, after: -1, tag: 'CHANGE', tone: 'hot' })
  if ((sol || r.kind === 'upgrade') && (a?.codeHash || b?.codeHash)) {
    d.push({
      id: 'hash',
      label: 'Code hash',
      value: arrow(b ? (h(b.codeHash) ?? 'unknown') : null, h(a?.codeHash)),
      sub: dd?.code === 'same' ? 'same code' : dd?.code === 'changed' ? 'changed' : undefined,
      after,
      tag: 'HASH',
      tone: dd?.code === 'changed' ? 'hot' : 'ice',
      chip: dd?.code === 'changed' ? { label: 'Code hash', value: 'changed' } : undefined,
    })
  }
  if (!sol && (a?.implementation || b?.implementation)) {
    d.push({
      id: 'impl',
      label: 'Implementation',
      value: arrow(b?.implementation !== undefined ? short(b.implementation ?? 'none') : null, a?.implementation ? short(a.implementation) : null),
      href: a?.implementation ? `/lens/${r.chain}/${a.implementation}` : undefined,
      after: -1,
      tag: 'PROXY',
      tone: 'hot',
      chip: { label: 'Proxy → implementation', value: a?.implementation ? short(a.implementation) : DASH },
    })
  }
  if (a && (sol || r.kind === 'admin_change')) {
    const av = a.authority ? short(a.authority) : a.upgradeable === false ? 'none · immutable' : 'none'
    const bv = b && (b.from !== 'event' || !sol) ? (b.authority ? short(b.authority) : 'none') : null
    d.push({
      id: 'auth',
      label: sol ? 'Upgrade authority' : 'Admin',
      value: arrow(bv, av),
      sub: dd?.authority === 'same' ? 'unchanged' : dd?.authority === 'changed' ? 'changed' : undefined,
      after: sol ? after : -1,
      tag: 'AUTHORITY',
      tone: 'hot',
      chip: { label: sol ? 'Upgrade authority' : 'Admin', value: dd?.authority === 'changed' ? `changed → ${av}` : av },
    })
  }
  const unit = sol ? 'instruction' : 'function'
  if (dd?.added && dd.added.items.length + dd.added.more > 0) {
    const n = dd.added.items.length + dd.added.more
    d.push({ id: 'add', label: `${unit}s added`, value: `+ ${fmtInt(n)}`, minis: dd.added.items, more: dd.added.more, after: regAt, tag: 'ADDED', tone: 'ice', chip: { label: `${unit}s added`, value: `+${n}` } })
  }
  if (dd?.removed && dd.removed.items.length + dd.removed.more > 0) {
    const n = dd.removed.items.length + dd.removed.more
    d.push({ id: 'rem', label: `${unit}s removed`, value: `− ${fmtInt(n)}`, minis: dd.removed.items, more: dd.removed.more, after: regAt, tag: 'REMOVED', tone: 'hot' })
  }
  for (const [i, g] of (dd?.guardsAdded ?? []).slice(0, 4).entries()) {
    d.push({ id: `g${i}`, label: i === 0 ? 'New admin-only' : '', value: g.fn, sub: `${g.guard} · ${g.at}`, after: regAt, tag: 'GUARD', tone: 'hot', chip: i === 0 ? { label: 'New admin-only function', value: `${g.fn.split('(')[0]}() · ${g.at}` } : undefined })
  }
  if (a && a.from !== 'event') {
    d.push({ id: 'ver', label: 'Verified', value: arrow(b && b.verified !== 'unknown' ? VERIFIED_WORD[b.verified] : null, VERIFIED_WORD[a.verified]), after: regAt, tag: 'VERIFIED', tone: a.verified === 'none' || a.verified === 'unknown' ? 'ice' : 'hot' })
  }
  if (r.actor) {
    const who = r.actorRole === 'signer' ? 'Signed by' : r.actorRole === 'sender' ? 'Sent by' : r.actorRole === 'admin' ? 'Admin' : 'Authority'
    d.push({ id: 'actor', label: who, value: r.actor, addr: true, after: trace.length ? trace.length - 1 : -1 })
  }
  for (const [i, n] of r.notes.slice(0, 3).entries()) d.push({ id: `note${i}`, kind: 'note', label: i === 0 ? 'Notes' : '', value: n, after: trace.length ? trace.length - 1 : null })
  return finishShow(ev, d, live, backlog, seq)
}

function finishShow(ev: PlayEvent, d: Draft[], live: boolean, backlog: number, seq: number): Show {
  const trace = ev.trace ?? []
  const has = trace.length > 0
  // ── timing ──
  const chips = d.filter((r) => r.chip).length
  const minis = d.reduce((n, r) => n + Math.min(r.minis?.length ?? 0, 10), 0)
  let dur = clamp(7600 + d.length * 330 + chips * 150 + minis * 35, 9000, 14000)
  if (backlog > 7) dur = 6000
  else if (backlog > 3) dur = Math.max(6500, dur * 0.72)
  const stampAt = dur - 2500
  const closeAt = dur - 420
  const spanStart = 1250
  const spanEnd = stampAt - 650
  const callEnd = spanStart + (spanEnd - spanStart) * 0.62
  const realMs = has ? Math.max(1, ...trace.map((c) => c.t + (c.wait ?? 0) + c.ms)) : 0
  const at = (t: number) => spanStart + (t / realMs) * (callEnd - spanStart)
  const log: LogRow[] = []
  const sep = trace.length ? Math.min(300, (callEnd - spanStart) / trace.length) : 0
  for (const [i, c] of trace.entries()) {
    const st = Math.max(at(c.t), i ? log[i - 1].start + sep : spanStart)
    const en = Math.min(Math.max(st + 260, at(c.t + (c.wait ?? 0) + c.ms)), spanEnd)
    const sent = clamp(at(c.t + (c.wait ?? 0)), st, Math.max(st, en - 160))
    log.push({ id: `c${i}`, c, start: st, sent, end: en })
  }

  // providers, in the order the read first asked them
  const sources: Src[] = []
  for (const l of log) {
    let src = sources.find((x) => x.name === l.c.provider && x.kind === l.c.kind)
    if (!src) {
      if (sources.length >= 3) continue
      src = {
        id: `s${sources.length}`,
        name: l.c.provider,
        kind: l.c.kind,
        label: l.c.kind === 'rpc' ? `RPC · ${CHAIN_LABEL[ev.chain] ?? ev.chain}` : (REGISTRY_WHAT[l.c.method] ?? 'Registry'),
        hot: isHelius(l.c.provider),
        calls: [],
      }
      sources.push(src)
    }
    src.calls.push(l)
  }

  const step = 190
  const used = new Map<number, number>()
  let preAt = 520
  let evenAt = spanStart
  const evenStep = d.length ? (spanEnd - spanStart) / d.length : 0
  const rows: Row[] = d.map((r) => {
    let t: number
    if (r.after === -1) {
      t = preAt
      preAt += 160
    } else if (r.after === null || !log[r.after]) {
      t = evenAt
      evenAt += evenStep
    } else {
      const k = used.get(r.after) ?? 0
      used.set(r.after, k + 1)
      t = log[r.after].end + 140 + k * step
    }
    const { after: _after, ...rest } = r
    return { ...rest, at: t }
  })
  const last = Math.max(0, ...rows.map((r) => r.at + Math.min(r.minis?.length ?? 0, 10) * 60))
  if (last > stampAt - 250) {
    const k = (stampAt - 250 - spanStart) / Math.max(1, last - spanStart)
    for (const r of rows) if (r.at > spanStart) r.at = spanStart + (r.at - spanStart) * k
  }
  const rpc = trace.find((c) => c.kind === 'rpc')
  return { seq, ev, live, rows, log, sources, dur, stampAt, closeAt, rpcProvider: rpc?.provider ?? null, realMs, lag: Math.max(0, Math.round((Date.now() - (ev.radar ? ev.radar.seenAt : ev.ts)) / 1000)) }
}

// ─── data: live queue + replay ──────────────────────────────────────────────

const LIVE_MAX = 6
const HISTORY_MAX = 40
const REPLAY_POOL = 14
const RECENT_MAX = 8
const SEEN_MAX = 600
const POLL_MS = 20_000

async function fetchScanFeed(limit: number, signal?: AbortSignal): Promise<ChainEvent[]> {
  const res = await fetch(`/api/chain/feed?limit=${limit}&scan=1`, { headers: { Accept: 'application/json' }, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body: unknown = await res.json()
  if (!Array.isArray(body)) return []
  return body.filter((e): e is ChainEvent => !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.ts === 'number' && isChainId(e.chain) && typeof e.address === 'string')
}

const traced = (e: ChainEvent) => !!e.trace?.length || !!(e as PlayEvent).radar

/** How much there is to watch in a read (queue and replay order only; never shown). */
function interest(e: ChainEvent): number {
  let n = 0
  if ((e as PlayEvent).radar) return 30 // a code change caught by the radar plays before any read
  if (e.verdict === 'kept') n += 6
  else if (e.verdict === 'boilerplate') n -= 1
  else if (e.verdict === 'duplicate') n -= 2
  else if (e.verdict !== 'unverified') n -= 6 // error, token mint, not code
  const s = e.scan
  if (s?.idl) n += 3
  if (s?.privileged?.items.length) n += 3
  if (s?.proxy) n += 2
  if (s?.verified) n += 2
  if (s?.authority || s?.proxy?.admin) n += 1
  if (s?.files) n += 1
  if (e.chain === 'solana') n += 1
  if (!traced(e)) n -= 4
  return n
}

/**
 * Keys of what a read shows: its code (same bytecode or binary) and, for a proxy, its implementation.
 * Two reads sharing a key look the same on screen (clones of one proxy, copies of one binary).
 */
function lookalike(e: ChainEvent): string[] {
  const k: string[] = []
  if (e.scan?.codeHash) k.push(`code:${e.scan.codeHash}`)
  if (e.scan?.proxy?.implementation) k.push(`impl:${e.scan.proxy.implementation.toLowerCase()}`)
  return k.length ? k : [`addr:${e.chain}:${e.address.toLowerCase()}`]
}
const shares = (e: ChainEvent, keys: Iterable<string>) => {
  const set = keys instanceof Set ? keys : new Set(keys)
  return lookalike(e).some((k) => set.has(k))
}

/** A queued read older than this (server time, against the newest read seen) is left to the replay. */
const LIVE_MAX_AGE_MS = 75_000

interface Player {
  live: ChainEvent[]
  history: ChainEvent[]
  seen: Set<string>
  /** Look-alike keys of the last reads played. */
  recent: string[][]
  lastId: string | null
  replay: number
  seq: number
  newest: number
  loaded: boolean
}

/** A queued read's score: what it shows, less for repeating what is queued before it or just played, a little less with age. */
function queuedScore(p: Player, i: number): number {
  const e = p.live[i]
  const earlier = p.live.slice(0, i).flatMap(lookalike)
  const reps = (shares(e, earlier) ? 1 : 0) + (shares(e, p.recent.flat()) ? 1 : 0)
  return interest(e) - reps * 5 - Math.max(0, p.newest - e.ts) / 20_000
}

/** The live queue's least telling read; ties → the oldest. */
function worstQueued(p: Player): number {
  let worst = 0
  let low = Infinity
  for (let i = 0; i < p.live.length; i++) {
    const s = queuedScore(p, i)
    if (s < low) {
      low = s
      worst = i
    }
  }
  return worst
}

/** The live queue's most telling read; ties → the oldest. */
function bestQueued(p: Player): number {
  let best = 0
  let high = -Infinity
  for (let i = 0; i < p.live.length; i++) {
    const s = queuedScore(p, i)
    if (s > high) {
      high = s
      best = i
    }
  }
  return best
}

/** Replay material: the most telling recent reads, one per look-alike. */
function replayPool(history: ChainEvent[]): ChainEvent[] {
  const list = history.filter(traced)
  const from = list.length ? list : history
  const seen = new Set<string>()
  const out: ChainEvent[] = []
  for (const e of [...from].sort((a, b) => interest(b) - interest(a) || b.ts - a.ts)) {
    if (shares(e, seen)) continue
    for (const k of lookalike(e)) seen.add(k)
    out.push(e)
    if (out.length >= REPLAY_POOL) break
  }
  return out
}

// ─── page ───────────────────────────────────────────────────────────────────

const p2 = (n: number) => String(n).padStart(2, '0')
const clock = (ts: number) => {
  const d = new Date(ts)
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`
}

const PROVIDER_CHAINS: ChainId[] = ['solana', 'ethereum', 'base', 'arbitrum']

export default function Scan() {
  useChainLive()
  useEffect(() => {
    document.title = 'Scan — LUSCA'
  }, [])
  const stats = useChain((s) => s.stats)
  const conn = useConn()
  const reduced = useMedia('(prefers-reduced-motion: reduce)')
  const wide = useMedia('(min-width: 1000px)')

  const player = useRef<Player>({ live: [], history: [], seen: new Set(), recent: [], lastId: null, replay: 0, seq: 0, newest: 0, loaded: false })
  const [show, setShow] = useState<Show | null>(null)
  const [queued, setQueued] = useState(0)
  const [feedState, setFeedState] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading')
  const showRef = useRef<Show | null>(null)
  const skipRef = useRef(false)

  const nextShow = useCallback(() => {
    const p = player.current
    // reads queued too long ago are left to the replay; with a choice, the most telling read plays first
    // (each keeps its real age on screen), so a run of identical proxy clones does not fill the stage
    p.live = p.live.filter((e) => p.newest - e.ts < LIVE_MAX_AGE_MS)
    let ev: ChainEvent | undefined = p.live.length ? p.live.splice(bestQueued(p), 1)[0] : undefined
    let live = !!ev
    if (!ev) {
      const pool = replayPool(p.history)
      if (pool.length) {
        // the next in the pool that does not look like what just played
        const recent = p.recent.slice(-3).flat()
        let pick = pool[p.replay % pool.length]
        for (let k = 0; k < pool.length; k++) {
          const e = pool[(p.replay + k) % pool.length]
          if (e.id !== p.lastId && !shares(e, recent)) {
            pick = e
            p.replay += k
            break
          }
        }
        p.replay++
        ev = pick
        live = false
      }
    }
    if (ev) {
      p.lastId = ev.id
      p.recent.push(lookalike(ev))
      if (p.recent.length > RECENT_MAX) p.recent.shift()
    }
    setQueued(p.live.length)
    skipRef.current = false
    const s = ev ? planShow(ev, live, p.live.length, ++p.seq) : null
    showRef.current = s
    setShow(s)
  }, [])

  const accept = useCallback(
    (list: ChainEvent[], asLive: boolean) => {
      const p = player.current
      let added = 0
      for (const ev of [...list].sort((a, b) => a.ts - b.ts)) {
        if (p.seen.has(ev.id)) continue
        p.seen.add(ev.id)
        p.history.unshift(ev)
        if (asLive && traced(ev) && ev.ts >= p.newest - 60_000) {
          p.live.push(ev)
          added++
        }
        p.newest = Math.max(p.newest, ev.ts)
      }
      // ids seen: bounded (the page is meant to stay open); the oldest go first
      if (p.seen.size > SEEN_MAX) for (const id of [...p.seen].slice(0, p.seen.size - SEEN_MAX + 100)) p.seen.delete(id)
      p.history.sort((a, b) => b.ts - a.ts)
      if (p.history.length > HISTORY_MAX) p.history.length = HISTORY_MAX
      while (p.live.length > LIVE_MAX) p.live.splice(worstQueued(p), 1)
      if (added) {
        setQueued(p.live.length)
        // a new live read cuts a replay short
        if (showRef.current && !showRef.current.live) skipRef.current = true
      }
      if (!showRef.current && (p.live.length || p.history.length)) nextShow()
    },
    [nextShow],
  )

  // ask the server for the call traces on this socket (again after every reconnect), stop on leaving
  useEffect(() => {
    const on = () => void send({ t: 'chain.scan', on: true })
    on()
    const off = bus.on('hello', on)
    return () => {
      off()
      send({ t: 'chain.scan', on: false })
    }
  }, [])

  // the stored feed (replay material), then the stream; a poll fills gaps the stream dropped
  useEffect(() => {
    const ac = new AbortController()
    let timer = 0
    const load = async (first: boolean) => {
      try {
        const list = await fetchScanFeed(first ? 40 : 20, ac.signal)
        player.current.loaded = true
        accept(list, !first)
        setFeedState(player.current.history.length ? 'ok' : 'empty')
      } catch {
        if (!ac.signal.aborted) setFeedState((s) => (s === 'ok' ? s : 'error'))
      }
      if (!ac.signal.aborted) timer = window.setTimeout(() => void load(false), first && !player.current.loaded ? 5000 : POLL_MS)
    }
    void load(true)
    const off = bus.on('chain', (m) => {
      if (m.event && typeof m.event.id === 'string') accept([m.event], true)
    })
    const offRadar = bus.on('radar', (m) => {
      if (m.event && typeof m.event.id === 'string' && playableRadar(m.event)) accept([radarToPlay(m.event)], true)
    })
    return () => {
      ac.abort()
      window.clearTimeout(timer)
      off()
      offRadar()
    }
  }, [accept])

  const ev = show?.ev ?? null
  const agents = stats?.agents ?? []
  const counts: [string, number | null | undefined][] = [
    ['reads', stats?.reads],
    ['kept', stats?.kept],
    ['programs', stats?.programs],
    ['contracts', stats?.contracts],
  ]
  // who answers each chain's reads, chains with the same provider together: "SOL Helius · ETH · BASE · ARB PublicNode"
  const providers: { name: string; chains: ChainId[] }[] = []
  for (const c of PROVIDER_CHAINS) {
    const name = stats?.providers?.[c]
    if (!name || !agents.some((a) => a.chain === c)) continue
    const g = providers.find((x) => x.name === name)
    if (g) g.chains.push(c)
    else providers.push({ name, chains: [c] })
  }

  return (
    <div className={`sc ${reduced ? 'sc-still' : ''}`}>
      <header className="sc-hud">
        <div className="sc-hud-l">
          <Kicker n={SCAN_NAV_N} name="Scan" className="sc-kick" />
          <span className={`sc-mode mono ${show?.live ? 'is-live' : ''}`}>
            <span className={show?.live ? 'led on pulse' : conn === 'live' ? 'led white' : connLed(conn)} aria-hidden="true" />
            {show
              ? show.ev.radar
                ? `radar · upgrade caught ${show.lag < 2 ? 'just now' : `${show.lag} s ago`}`
                : show.live
                ? `live · read ${show.lag < 2 ? 'just now' : `${show.lag} s ago`}`
                : `replay · read at ${clock(show.ev.ts)}`
              : conn === 'live'
                ? 'waiting for a read'
                : 'connecting'}
          </span>
          {/* screen readers: only the switch between live and replay, not every read */}
          <span className="sr-only" role="status" aria-live="polite">
            {show ? (show.live ? 'Live reads' : 'Replaying recent reads') : ''}
          </span>
          {ev && (
            <span className="sc-cur mono">
              <b>{ev.agent}</b> · {CHAIN_LABEL[ev.chain]}
              {queued > 0 && <span className="dim"> · {queued} queued</span>}
            </span>
          )}
        </div>
        <dl className="sc-counts">
          {counts.map(([k, v]) => (
            <div key={k}>
              <dt className="mono">{k}</dt>
              <dd className="num">{v == null ? DASH : fmtInt(v)}</dd>
            </div>
          ))}
        </dl>
      </header>

      <Stage show={show} reduced={reduced} wide={wide} skipRef={skipRef} onDone={nextShow} feedState={feedState} conn={conn} />

      <footer className="sc-foot mono">
        <span className="sc-foot-t">Calls replayed in their real order. Nothing is typed in: the agents find the addresses themselves.</span>
        {providers.length > 0 && (
          <span className="sc-provs" aria-label="Who answers the chain agents' reads">
            <span className="dim">RPC</span>
            {providers.map((g) => (
              <span key={g.name} title={g.chains.map((c) => CHAIN_LABEL[c]).join(', ')}>
                {g.chains.map((c) => CHAIN_SHORT[c]).join(' · ')} <b className={isHelius(g.name) ? 'hot' : ''}>{g.name}</b>
              </span>
            ))}
          </span>
        )}
        <span className="sc-agents" aria-label="Chain agents">
          {agents.map((a) => (
            <span key={a.id} className={`sc-agent ${ev?.agent === a.id ? 'cur' : ''}`} title={`${a.id} · ${a.state}`}>
              <span className={a.state === 'reading' ? 'led on pulse' : a.state === 'error' ? 'led' : 'led white'} aria-hidden="true" />
              {a.id}
            </span>
          ))}
        </span>
      </footer>
    </div>
  )
}

// ─── stage ──────────────────────────────────────────────────────────────────

interface StageProps {
  show: Show | null
  reduced: boolean
  wide: boolean
  skipRef: MutableRefObject<boolean>
  onDone: () => void
  feedState: 'loading' | 'ok' | 'empty' | 'error'
  conn: string
}

const SVGNS = 'http://www.w3.org/2000/svg'
/** Most mini boxes (instruction / function / file names) drawn per read. */
const MINI_BOXES = 14

interface Rect {
  x: number
  y: number
  w: number
  h: number
}
const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const grow = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m })

function svgEl<K extends keyof SVGElementTagNameMap>(parent: SVGSVGElement, tag: K, cls: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVGNS, tag)
  el.setAttribute('class', cls)
  parent.appendChild(el)
  return el
}

/** Point on a quadratic curve. */
const qpt = (t: number, a: number, c: number, b: number) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b

function Stage({ show, reduced, wide, skipRef, onDone, feedState, conn }: StageProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<HTMLDivElement>(null)
  const docInRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLOListElement>(null)
  const coreRef = useRef<HTMLDivElement>(null)
  const capRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const backRef = useRef<SVGSVGElement>(null)
  const boxesRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const winRef = useRef<HTMLDivElement>(null)
  const stampRef = useRef<HTMLDivElement>(null)
  const doneRef = useRef(onDone)
  useEffect(() => {
    doneRef.current = onDone
  }, [onDone])

  // nothing to play yet: try again shortly (the feed may still be loading)
  useEffect(() => {
    if (show) return
    const t = window.setInterval(() => doneRef.current(), 3000)
    return () => window.clearInterval(t)
  }, [show])

  useEffect(() => {
    if (!show) return
    const stage = stageRef.current
    const right = rightRef.current
    const doc = docRef.current
    const docIn = docInRef.current
    const svg = svgRef.current
    const back = backRef.current
    const boxLayer = boxesRef.current
    const win = winRef.current
    const logList = logRef.current
    if (!stage || !right || !doc || !docIn || !svg || !back || !boxLayer || !win) return

    // timed elements in the order they appear
    const timed = [...stage.querySelectorAll<HTMLElement>('[data-at]')]
      .map((el) => ({ el, at: Number(el.dataset.at), end: el.dataset.end ? Number(el.dataset.end) : null, on: false, done: false }))
      .sort((a, b) => a.at - b.at)

    const srcEls = [...right.querySelectorAll<HTMLElement>('.sc-src')]

    // ── chips and sources: placed once per read (and on resize), around the hub, clear of its caption ──
    interface Chip {
      el: HTMLElement
      r: Rect
      side: 'l' | 'r'
      hidden: boolean
    }
    const chipOf = new Map<string, Chip>()
    let hub = { x: 0, y: 0 }
    let srcs: { el: HTMLElement; r: Rect; src: Src }[] = []
    const layout = () => {
      chipOf.clear()
      srcs = []
      const rr = right.getBoundingClientRect()
      const rel = (r: DOMRect): Rect => ({ x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height })
      const core = coreRef.current?.getBoundingClientRect()
      hub = core ? { x: core.left - rr.left, y: core.top - rr.top } : { x: rr.width * 0.54, y: rr.height * 0.46 }
      const chipEls = [...right.querySelectorAll<HTMLElement>('.sc-chip')]
      for (const el of chipEls) el.style.display = ''
      if (!wide) {
        for (const el of chipEls) {
          el.style.left = ''
          el.style.top = ''
        }
        return
      }
      srcs = srcEls.map((el, i) => ({ el, r: rel(el.getBoundingClientRect()), src: show.sources[i] })).filter((s) => !!s.src)
      const blocks: Rect[] = [{ x: hub.x - 74, y: hub.y - 74, w: 148, h: 148 }]
      if (capRef.current) blocks.push(grow(rel(capRef.current.getBoundingClientRect()), 12))
      for (const s of srcs) blocks.push(grow(s.r, 12))
      const stampR = stampRef.current ? rel(stampRef.current.getBoundingClientRect()) : null
      const W = rr.width
      const top = srcs.length ? Math.max(...srcs.map((s) => s.r.y + s.r.h)) + 22 : 18
      const bottom = stampR ? stampR.y - 14 : rr.height - 18
      const cw = chipEls[0]?.offsetWidth ?? 240
      const ch = Math.max(48, ...chipEls.map((el) => el.offsetHeight))
      const xs: [number, 'l' | 'r'][] = [
        [56, 'l'],
        [W - 28 - cw, 'r'],
      ]
      const cands: (Rect & { side: 'l' | 'r' })[] = []
      for (let y = top; y + ch <= bottom; y += ch + 14) for (const [x, side] of xs) cands.push({ x, y, w: cw, h: ch, side })
      const placed: Rect[] = []
      chipEls.forEach((el, i) => {
        const want: 'l' | 'r' = i % 2 === 0 ? 'l' : 'r'
        let best: (typeof cands)[number] | null = null
        let cost = Infinity
        for (const c of cands) {
          if (blocks.some((b) => hits(c, b)) || placed.some((p) => hits(c, grow(p, 6)))) continue
          const k = Math.abs(c.y + c.h / 2 - hub.y) + (c.side === want ? 0 : 70)
          if (k < cost) {
            cost = k
            best = c
          }
        }
        const id = el.dataset.chip ?? ''
        if (!best) {
          // no room clear of the caption and the other chips: the field's wire goes to the hub instead
          el.style.display = 'none'
          chipOf.set(id, { el, r: { x: 0, y: 0, w: 0, h: 0 }, side: 'l', hidden: true })
          return
        }
        el.style.display = ''
        el.style.left = `${best.x.toFixed(0)}px`
        el.style.top = `${best.y.toFixed(0)}px`
        placed.push(best)
        chipOf.set(id, { el, r: { x: best.x, y: best.y, w: best.w, h: best.h }, side: best.side, hidden: false })
      })
    }

    // ── overlay elements: built once per read ──
    interface Box {
      id: string
      target: HTMLElement
      at: number
      tone: Tone
      mini: boolean
      box: HTMLDivElement
      tag: HTMLSpanElement | null
      tagW: number
      chip: string | null
      lane: number
      run: SVGPathElement | null
      wire: SVGPathElement | null
      spoke: SVGPathElement | null
      dot: SVGCircleElement | null
    }
    boxLayer.replaceChildren()
    svg.replaceChildren()
    back.replaceChildren()
    const net = svgEl(back, 'path', 'sc-net')
    const boxes: Box[] = []
    let minis = 0
    let lanes = 0
    for (const el of stage.querySelectorAll<HTMLElement>('[data-box]')) {
      const mini = !!el.dataset.mini
      if (mini && ++minis > MINI_BOXES) continue
      const tone = (el.dataset.tone as Tone) || 'hot'
      const id = el.dataset.box!
      const box = document.createElement('div')
      box.className = `sc-box ${tone}${mini ? ' mini' : ''}`
      box.innerHTML = '<i class="a"></i><i class="b"></i><i class="c"></i><i class="d"></i>'
      let tag: HTMLSpanElement | null = null
      if (el.dataset.tag) {
        tag = document.createElement('span')
        tag.className = 'sc-tag'
        tag.textContent = el.dataset.tag
        box.appendChild(tag)
      }
      boxLayer.appendChild(box)
      const chip = stage.querySelector<HTMLElement>(`[data-chip="${id}"]`) ? id : null
      const b: Box = {
        id,
        target: el,
        at: Number(el.dataset.at ?? el.closest<HTMLElement>('[data-at]')?.dataset.at ?? 0),
        tone,
        mini,
        box,
        tag,
        tagW: 0,
        chip,
        lane: 0,
        run: null,
        wire: null,
        spoke: null,
        dot: null,
      }
      if (wide && !mini) {
        b.lane = lanes++
        b.run = svgEl(svg, 'path', `sc-run ${tone}`)
        b.dot = svgEl(svg, 'circle', `sc-dot ${tone}`)
        b.dot.setAttribute('r', tone === 'hot' ? '3.2' : '2.2')
        b.wire = svgEl(back, 'path', `sc-wire ${tone}`)
        b.wire.setAttribute('pathLength', '1')
        if (chip) {
          b.spoke = svgEl(back, 'path', 'sc-link')
          b.spoke.setAttribute('pathLength', '1')
        }
      }
      boxes.push(b)
    }
    // provider links: hub ↔ source node, a request packet out and an answer packet back per call
    const links = show.sources.map((src, i) => {
      const path = svgEl(back, 'path', `sc-src-link${src.hot ? ' hot' : ''}`)
      const out = svgEl(back, 'circle', `sc-pk out${src.hot ? ' hot' : ''}`)
      out.setAttribute('r', '3')
      const ret = svgEl(back, 'circle', `sc-pk ret${src.hot ? ' hot' : ''}`)
      ret.setAttribute('r', '3.6')
      return { src, node: srcEls[i] ?? null, path, out, ret, busy: false, hit: false }
    })

    // one layout for every measurement that holds for the whole read
    layout()
    for (const b of boxes) if (b.tag) b.tagW = b.tag.offsetWidth

    // the progress bar under the address: a compositor animation in step with the playback clock
    const bar = barRef.current?.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: show.stampAt, fill: 'forwards', easing: 'linear' })
    if (bar && (reduced || document.hidden)) bar.pause()

    let el = 0
    let last = performance.now()
    let raf = 0
    let timer = 0
    let scroll = 0
    let lastRevealed: HTMLElement | null = null
    let ended = false
    let geomDirty = false

    const frame = (now: number) => {
      raf = 0
      const dt = Math.max(0, Math.min(1000, now - last))
      el += dt
      last = now
      if (skipRef.current && el < show.closeAt - 900) el = Math.max(el, show.closeAt - 900)
      if (reduced) el = Math.max(el, show.stampAt + 1)
      if (bar && Math.abs(Number(bar.currentTime ?? 0) - Math.min(el, show.stampAt)) > 40) bar.currentTime = Math.min(el, show.stampAt)

      // 1. reveals (class flips only)
      let logGrew = false
      for (const t of timed) {
        if (!t.on && el >= t.at) {
          t.on = true
          t.el.classList.add('on')
          if (t.el.dataset.row) lastRevealed = t.el
          if (t.el.classList.contains('sc-call')) logGrew = true
        }
        if (t.end !== null && !t.done && el >= t.end) {
          t.done = true
          t.el.classList.add('done')
        }
      }
      for (const l of links) {
        // waiting for this provider's answer / its answer just arrived
        const busy = l.src.calls.some((c) => el >= c.sent && el < c.end)
        const hit = !busy && l.src.calls.some((c) => el >= c.end && el < c.end + 600)
        if (busy !== l.busy) {
          l.busy = busy
          l.path.classList.toggle('busy', busy)
          l.node?.classList.toggle('busy', busy)
        }
        if (hit !== l.hit) {
          l.hit = hit
          l.node?.classList.toggle('hit', hit)
        }
      }

      // 2. reads (one layout)
      const sr = stage.getBoundingClientRect()
      const dr = doc.getBoundingClientRect()
      const rr = right.getBoundingClientRect()
      const docH = doc.clientHeight
      const want = !reduced && lastRevealed ? Math.max(0, lastRevealed.offsetTop + lastRevealed.offsetHeight + 24 - docH) : scroll
      const logH = logGrew && logList ? logList.scrollHeight : 0
      const shown = boxes.filter((b) => el >= b.at)
      const rects = shown.map((b) => b.target.getBoundingClientRect())
      if (geomDirty) {
        layout()
        geomDirty = false
      }

      // 3. writes
      if (logGrew && logList) logList.scrollTop = logH
      const open = reduced ? 1 : ease(el / 520)
      const close = reduced ? 0 : ease((el - show.closeAt) / 380)
      win.style.setProperty('--open', String(open * (1 - close)))
      const prev = scroll
      if (!reduced) {
        scroll = Math.abs(want - scroll) < 0.4 ? want : scroll + (want - scroll) * Math.min(1, dt / 160)
        docIn.style.transform = `translateY(${-scroll.toFixed(1)}px)`
        doc.classList.toggle('scrolled', scroll > 2)
      }
      const shift = prev - scroll // rects were read before this frame's scroll
      const fade = 1 - close
      const ox = rr.left - sr.left
      const oy = rr.top - sr.top
      const visTop = dr.top + (scroll > 2 ? 16 : 0)
      const netPts: { x: number; y: number; side: 'l' | 'r' }[] = []
      let moving = !reduced && (el < 560 || el > show.closeAt - 40 || Math.abs(want - scroll) >= 0.4)
      shown.forEach((b, i) => {
        const r = rects[i]
        const top = r.top + shift
        const inView = r.height > 0 && top >= visTop - 2 && top + r.height <= dr.bottom + 2
        const p = reduced ? 1 : ease((el - b.at) / 360)
        if (!reduced && el - b.at < 460) moving = true // the row slides in under its box
        const pad = b.mini ? 2 : b.tone === 'hot' ? 5 : 3
        const x = r.left - sr.left - pad
        const y = top - sr.top - pad
        const w = r.width + pad * 2
        const h = r.height + pad * 2
        b.box.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
        b.box.style.width = `${w.toFixed(1)}px`
        b.box.style.height = `${h.toFixed(1)}px`
        b.box.style.opacity = String((inView ? p : 0) * fade)
        b.box.style.setProperty('--k', String(1 + 0.22 * (1 - p)))
        // tag beside the box when it fits inside the document, above its right end otherwise
        const flip = !!b.tag && x + w + 10 + b.tagW > dr.right - sr.left - 6
        if (b.tag) b.box.classList.toggle('flip', flip)
        if (!b.run || !b.wire || !b.dot) return
        // the wire leaves the document level with the field, then runs (under the chips) to its chip or the hub
        const bx = x + w + (b.tag && !flip ? 10 + b.tagW : 0) + 4
        const by = y + h / 2
        const wx = ox
        const alpha = (inView ? 1 : 0) * fade
        const age = clamp((el - b.at - 1400) / 900, 0, 1)
        const strength = (b.tone === 'hot' ? 0.95 : 0.6) * (1 - 0.45 * age)
        b.run.setAttribute('d', bx < wx ? `M${bx.toFixed(1)},${by.toFixed(1)} H${wx.toFixed(1)}` : '')
        b.run.style.opacity = String(alpha * strength * (reduced ? 1 : clamp(p * 2, 0, 1)))
        b.dot.setAttribute('cx', bx.toFixed(1))
        b.dot.setAttribute('cy', by.toFixed(1))
        b.dot.style.opacity = String(alpha * p)
        const sy = by - oy // in the hub column's coordinates
        const chip = b.chip ? chipOf.get(b.chip) : undefined
        let d: string
        if (chip && !chip.hidden && chip.side === 'l') {
          // a lane in the channel between the window and the left chips
          const lx = 12 + (b.lane % 6) * 6
          const ty = chip.r.y + chip.r.h / 2
          const rad = Math.min(7, Math.abs(ty - sy) / 2)
          const dir = ty >= sy ? 1 : -1
          d =
            Math.abs(ty - sy) < 1.5
              ? `M0,${sy.toFixed(1)} H${chip.r.x.toFixed(1)}`
              : `M0,${sy.toFixed(1)} H${(lx - rad).toFixed(1)} Q${lx},${sy.toFixed(1)} ${lx},${(sy + dir * rad).toFixed(1)} V${(ty - dir * rad).toFixed(1)} Q${lx},${ty.toFixed(1)} ${(lx + rad).toFixed(1)},${ty.toFixed(1)} H${chip.r.x.toFixed(1)}`
        } else {
          const dx = Math.max(60, hub.x * 0.45)
          d = `M0,${sy.toFixed(1)} C${dx.toFixed(1)},${sy.toFixed(1)} ${(hub.x - dx).toFixed(1)},${hub.y.toFixed(1)} ${hub.x.toFixed(1)},${hub.y.toFixed(1)}`
        }
        b.wire.setAttribute('d', d)
        const pw = reduced ? 1 : ease((el - b.at - 120) / 520)
        if (pw < 1) moving = true
        b.wire.style.strokeDashoffset = String(1 - pw)
        b.wire.style.opacity = String(alpha * strength)
        if (b.spoke && chip && !chip.hidden) {
          const cy = chip.r.y + chip.r.h / 2
          const cx = chip.side === 'l' ? chip.r.x + chip.r.w : chip.r.x
          const ps = reduced ? 1 : ease((el - b.at - 420) / 480)
          if (ps < 1) moving = true
          b.spoke.setAttribute('d', chip.side === 'l' ? `M${cx.toFixed(1)},${cy.toFixed(1)} L${hub.x.toFixed(1)},${hub.y.toFixed(1)}` : `M${hub.x.toFixed(1)},${hub.y.toFixed(1)} L${cx.toFixed(1)},${cy.toFixed(1)}`)
          b.spoke.style.strokeDashoffset = String(1 - ps)
          b.spoke.style.opacity = String(0.7 * fade)
          if (el >= b.at + 150) netPts.push({ x: chip.r.x + chip.r.w / 2, y: chip.r.y + chip.r.h / 2, side: chip.side })
        }
      })
      // thin lines between neighbouring chips of a column (under the chips)
      let nd = ''
      for (const side of ['l', 'r'] as const) {
        const pts = netPts.filter((q) => q.side === side).sort((a, b) => a.y - b.y)
        for (let i = 1; i < pts.length; i++) nd += `M${pts[i - 1].x.toFixed(1)},${pts[i - 1].y.toFixed(1)} L${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)} `
      }
      net.setAttribute('d', nd)
      net.style.opacity = String(fade)
      // provider links and their packets
      for (const l of links) {
        const s = srcs.find((x) => x.src === l.src)
        if (!s || !wide) {
          l.path.setAttribute('d', '')
          l.out.style.opacity = '0'
          l.ret.style.opacity = '0'
          continue
        }
        const sx = s.r.x + s.r.w / 2
        const sy = s.r.y + s.r.h
        const cx = (sx + hub.x) / 2 + (sx < hub.x ? -40 : 40)
        const cy = (sy + hub.y) / 2
        l.path.setAttribute('d', `M${hub.x.toFixed(1)},${hub.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${sx.toFixed(1)},${sy.toFixed(1)}`)
        l.path.style.opacity = String(fade)
        let po = 0
        let pr = 0
        let to = 0
        let tr = 0
        if (!reduced) {
          for (const c of l.src.calls) {
            if (el >= c.sent && el < c.end) {
              // the request on its way out, then waiting at the provider
              po = 1
              to = Math.min(1, (el - c.sent) / 380)
              if (to < 1) moving = true
            }
            if (el >= c.end && el < c.end + 460) {
              pr = 1
              tr = (el - c.end) / 460
              moving = true
            }
          }
        }
        l.out.setAttribute('cx', qpt(to, hub.x, cx, sx).toFixed(1))
        l.out.setAttribute('cy', qpt(to, hub.y, cy, sy).toFixed(1))
        l.out.style.opacity = String(po * fade)
        l.ret.setAttribute('cx', qpt(1 - tr, hub.x, cx, sx).toFixed(1))
        l.ret.setAttribute('cy', qpt(1 - tr, hub.y, cy, sy).toFixed(1))
        l.ret.style.opacity = String(pr * fade)
      }

      if (el >= show.dur && !ended) {
        ended = true
        doneRef.current()
        return
      }
      if (document.hidden) return
      if (moving) {
        raf = requestAnimationFrame(frame)
        return
      }
      // nothing moves: sleep until the next reveal (checking now and then for a skip)
      let next = show.dur
      for (const t of timed) {
        if (!t.on) next = Math.min(next, t.at)
        if (t.end !== null && !t.done) next = Math.min(next, t.end)
      }
      for (const b of boxes) if (el < b.at) next = Math.min(next, b.at)
      for (const l of links) for (const c of l.src.calls) if (el < c.sent) next = Math.min(next, c.sent)
      if (!reduced) next = Math.min(next, show.closeAt - 40)
      timer = window.setTimeout(kick, clamp(next - el, 16, 500))
    }
    const kick = () => {
      window.clearTimeout(timer)
      timer = 0
      if (!raf && !ended && !document.hidden) raf = requestAnimationFrame(frame)
    }
    const onVis = () => {
      if (document.hidden) {
        bar?.pause()
        return
      }
      last = performance.now() // the playback pauses while the tab is hidden
      if (bar && !reduced) bar.play()
      kick()
    }
    const onResize = () => {
      geomDirty = true
      kick()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('resize', onResize)
    // reduced motion: the document scrolls by hand; the boxes follow
    doc.addEventListener('scroll', kick, { passive: true })
    raf = requestAnimationFrame(frame)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      bar?.cancel()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('resize', onResize)
      doc.removeEventListener('scroll', kick)
      boxLayer.replaceChildren()
      svg.replaceChildren()
      back.replaceChildren()
    }
  }, [show, reduced, wide, skipRef])

  const ev = show?.ev
  const chips = show ? show.rows.filter((r) => r.chip) : []
  const lensPath = ev ? `/lens/${ev.chain}/${ev.address}` : '/lens'
  const kept = ev?.verdict === 'kept'

  return (
    <div className="sc-stage" ref={stageRef}>
      <div className="sc-bg" aria-hidden="true" />
      <div className="sc-left">
        <div className={`sc-win ${show ? '' : 'idle'}`} ref={winRef} key={`win-${show?.seq ?? 'idle'}`}>
          <div className="sc-win-bar">
            <span className="sc-win-btns" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="sc-win-title mono">{ev ? `${ev.radar ? 'RADAR · UPGRADE CAUGHT — ' : ''}${ev.name ?? short(ev.address)} — LUSCA Lens` : 'LUSCA Lens'}</span>
            {show?.rpcProvider && (
              <span className={`sc-via mono ${isHelius(show.rpcProvider) ? 'hot' : ''}`} title="Who answered this read's RPC calls">
                RPC · {show.rpcProvider}
              </span>
            )}
          </div>
          <div className="sc-url">
            {ev ? (
              <Link to={lensPath} className="sc-url-a mono" title="Open the full Lens report for this address">
                <span className="dim">https://</span>lusca.ink<span className="dim">/lens/{ev.chain}/</span>
                <span className="sc-url-addr">{ev.address}</span>
              </Link>
            ) : (
              <span className="sc-url-a mono dim">https://lusca.ink/lens</span>
            )}
            <div className="sc-url-bar" ref={barRef} aria-hidden="true" />
          </div>
          <div className={`sc-doc ${reduced ? 'by-hand' : ''}`} ref={docRef} tabIndex={reduced ? 0 : undefined}>
            <div className="sc-doc-in" ref={docInRef}>
              {show ? (
                show.rows.map((r) => <DocRow key={r.id} r={r} chain={show.ev.chain} />)
              ) : (
                <p className="sc-empty mono">
                  {feedState === 'error' || conn === 'unreachable'
                    ? 'Can’t reach the LUSCA server — retrying…'
                    : feedState === 'empty'
                      ? 'No read yet. The chain agents start reading about 20 s after the server starts; the first one plays here.'
                      : 'Loading the latest reads…'}
                </p>
              )}
            </div>
            {!reduced && show && <div className="sc-beam" aria-hidden="true" />}
          </div>
        </div>

        <section className="sc-log" aria-label="Calls made by this read">
          <div className="sc-log-h mono">
            <span>
              <span className="hot">C</span>&nbsp;&nbsp;<b>Calls made by this read</b>
            </span>
            <span className="dim">
              {show && show.log.length
                ? `${show.log.length} call${show.log.length === 1 ? '' : 's'} · ${fmtInt(show.realMs)} ms real time${show.ev.scan?.traceMore ? ` · +${show.ev.scan.traceMore} not listed` : ''}`
                : show
                  ? 'no call trace recorded for this read'
                  : DASH}
            </span>
          </div>
          <ol className="sc-log-l mono" ref={logRef} key={`log-${show?.seq ?? 'idle'}`}>
            {show?.log.map((l) => (
              <li key={l.id} className={`sc-call ${l.c.ok ? '' : 'fail'}`} data-at={l.start} data-end={l.end}>
                <span className="m">{l.c.method}</span>
                <span className="t">{l.c.target}</span>
                <span className={`p ${isHelius(l.c.provider) ? 'hot' : ''}`}>{l.c.provider}</span>
                <span
                  className="d num"
                  title={l.c.wait ? `${fmtInt(l.c.ms)} ms for the request; it waited ${fmtInt(l.c.wait)} ms for its turn in LUSCA's own pacing first` : `${fmtInt(l.c.ms)} ms for the request`}
                >
                  {fmtInt(l.c.ms)} ms{l.c.wait && l.c.wait >= 100 ? <span className="w">+{fmtInt(l.c.wait)} ms queued</span> : null}
                </span>
                <span className="r">{l.c.result}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="sc-right" ref={rightRef}>
        <div className="sc-hub" aria-hidden="true">
          <div className="sc-octo" />
          <div className="sc-core" ref={coreRef}>
            <i className="ring" />
            <i className="ring r2" />
            <i className="dot" />
          </div>
          {ev && (
            <div className="sc-hub-l mono" ref={capRef}>
              <b>{ev.radar ? 'LUSCA · RADAR · UPGRADE CAUGHT' : `LUSCA · ${ev.agent}`}</b>
              <span>
                {ev.radar ? 're-reading' : 'reading'} {CHAIN_LABEL[ev.chain]}
                {show?.rpcProvider && (
                  <>
                    {' '}
                    via <em className={isHelius(show.rpcProvider) ? 'hot' : ''}>{show.rpcProvider}</em>
                  </>
                )}
              </span>
            </div>
          )}
        </div>
        <svg className="sc-back" ref={backRef} aria-hidden="true" />
        <div className="sc-srcs" key={`srcs-${show?.seq ?? 'idle'}`} aria-label="Who answered this read's calls">
          {show?.sources.map((s) => (
            <div key={s.id} className={`sc-src ${s.hot ? 'hot' : ''}`} data-at={s.calls[0]?.start ?? 0}>
              <span className="k mono">{s.label}</span>
              <b className={`n ${s.name.length > 11 ? 'long' : ''}`}>{s.name}</b>
              <span className="c mono">
                {s.calls.map((l) => (
                  <span key={l.id} className={`sc-src-c ${l.c.ok ? '' : 'fail'}`} data-at={l.start} data-end={l.end}>
                    <span className="q">
                      {l.c.method} · {l.c.target}
                    </span>
                    <span className="a">
                      {l.c.result} · {fmtInt(l.c.ms)} ms
                    </span>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
        <div className="sc-chips" key={`chips-${show?.seq ?? 'idle'}`}>
          {chips.map((r) => (
            <div key={r.id} className={`sc-chip ${r.tone === 'hot' ? 'hot' : ''}`} data-chip={r.id} data-at={r.at + 150}>
              <span className="l mono">{r.chip!.label}</span>
              <span className="v mono">{r.chip!.value}</span>
            </div>
          ))}
        </div>
        {show && show.ev.radar ? (
          <div className="sc-stamp kept radar" data-at={show.stampAt} ref={stampRef} key={`stamp-${show.seq}`}>
            <b>Upgrade caught</b>
            <span className="mono">
              <em>RADAR · {KIND_BADGE[show.ev.radar.kind]}</em> · {show.ev.radar.headline}
            </span>
          </div>
        ) : show ? (
          <div className={`sc-stamp ${kept ? 'kept' : show.ev.verdict === 'error' ? 'err' : 'rej'}`} data-at={show.stampAt} ref={stampRef} key={`stamp-${show.seq}`}>
            <b>{kept ? 'Kept' : show.ev.verdict === 'error' ? 'Read failed' : 'Rejected'}</b>
            <span className="mono">
              <em>{kept ? 'in the SEPIA-1 dataset' : VERDICT_LABEL[show.ev.verdict]}</em> · {show.ev.reason}
            </span>
          </div>
        ) : null}
      </div>
      <svg className="sc-wires" ref={svgRef} aria-hidden="true" />
      <div className="sc-boxes" ref={boxesRef} aria-hidden="true" />
    </div>
  )
}

function DocRow({ r, chain }: { r: Row; chain: ChainId }) {
  const box = r.tag ? { 'data-box': r.id, 'data-tag': r.tag, 'data-tone': r.tone ?? 'hot', 'data-at': r.at } : {}
  if (r.kind === 'name') {
    return (
      <div className="sc-row sc-name" data-row="1" data-at={r.at}>
        <span className="sc-k mono">{r.label}</span>
        <h2 className={`sc-title ${r.addr ? 'addr' : r.value.length > 16 ? 'long' : ''}`}>
          <span {...box}>{r.value}</span>
        </h2>
      </div>
    )
  }
  return (
    <div className={`sc-row ${r.kind === 'note' ? 'note' : ''} ${r.kind === 'fail' ? 'fail' : ''}`} data-row="1" data-at={r.at}>
      <span className="sc-k mono">{r.label}</span>
      <span className="sc-v">
        <span className="sc-vv mono" {...box}>
          {r.href ? (
            <Link to={r.href} title={`Lens report on ${CHAIN_LABEL[chain]}`}>
              {r.value}
            </Link>
          ) : (
            r.value
          )}
        </span>
        {r.sub && <span className="sc-sub mono">{r.sub}</span>}
        {r.minis && r.minis.length > 0 && (
          <span className="sc-minis">
            {r.minis.map((m, i) => (
              <span key={`${m}-${i}`} className="sc-mini mono" data-at={r.at + 120 + i * 60} {...(i < 10 ? { 'data-box': `${r.id}-m${i}`, 'data-tone': 'ice', 'data-mini': '1' } : {})}>
                {m}
              </span>
            ))}
            {r.more ? <span className="sc-mini more mono" data-at={r.at + 120 + r.minis.length * 60}>+{fmtInt(r.more)}</span> : null}
          </span>
        )}
      </span>
    </div>
  )
}
