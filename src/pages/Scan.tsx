// SCAN — /scan: watch the chain agents read programs and contracts, call by call. Nothing to type.
//
// Every read an agent makes arrives over the WebSocket ({ t: 'chain', event }) with the calls it made
// (ChainEvent.trace: method, target, provider, start offset, duration, result) and what it decoded
// (ChainEvent.scan). The page plays one read at a time: a window opens on the read's Lens address, the
// call log runs the calls in their real order and relative timing (scaled to fit), each decoded field
// appears when the call that produced it answers, a bounding box locks onto it and a wire runs to the
// LUSCA hub. With no new read in the queue, the most recent reads from /api/chain/feed?scan=1 are
// replayed, labelled with the time they were read. Nothing here is invented: an unknown field is not
// drawn.
//
// One requestAnimationFrame loop drives the playback (class flips at reveal times, box and wire
// geometry for the few active boxes); it stops while the tab is hidden.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Link } from 'react-router-dom'
import type { ChainEvent, ChainId, ScanCall } from '@shared/chain'
import { Kicker } from '@/components/docs/pagekit'
import { connLed } from '@/components/ui/conn'
import { bus } from '@/lib/bus'
import { CHAIN_LABEL, KIND_LABEL, VERDICT_LABEL, isChainId, shortAddress, useChain, useChainLive } from '@/lib/chain'
import { useConn, useMedia } from '@/lib/hooks'
import { DASH, fmtInt } from '@/lib/format'
import './scan.css'

/** Position of /scan in the primary navigation (src/components/shell/Shell.tsx NAV). */
const SCAN_NAV_N = '07'

// ─── plan: one read → rows, calls and their times ───────────────────────────

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
  at: number
}

interface LogRow {
  id: string
  c: ScanCall
  start: number
  end: number
}

interface Show {
  seq: number
  ev: ChainEvent
  live: boolean
  rows: Row[]
  log: LogRow[]
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

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const ease = (x: number) => 1 - Math.pow(1 - clamp(x, 0, 1), 3)
const base = (p: string) => p.split('/').pop() || p
const short = (a: string) => shortAddress(a, 4, 4)

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
  const nameAfter = sol ? decoded : anchor(sfy, code)
  const title = ev.name ?? s.project?.name ?? null
  d.push({ id: 'name', kind: 'name', label: KIND_LABEL[ev.kind] ?? ev.kind, value: title ?? short(ev.address), after: title ? nameAfter : -1, tag: title ? 'NAME' : undefined, tone: 'ice' })
  d.push({ id: 'addr', label: 'Address', value: ev.address, after: -1 })
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
      d.push({ id: 'auth', label: 'Upgrade authority', value: s.authority, sub: 'can replace the program', after: anchor(gma2, decoded), tag: 'AUTHORITY', tone: 'hot', chip: { label: 'Upgrade authority', value: short(s.authority) } })
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
    if (s.codeHash) d.push({ id: 'hash', label: 'Code hash', value: `sha256 ${s.codeHash.slice(0, 24)}…`, sub: 'metadata trailer excluded', after: decoded, tag: 'HASH', tone: 'ice' })
    if (s.proxy) {
      d.push({
        id: 'proxy',
        label: STD_LABEL[s.proxy.standard] ?? 'Proxy',
        value: `→ ${s.proxy.implementation}`,
        sub: 'implementation',
        href: `/lens/${ev.chain}/${s.proxy.implementation}`,
        after: anchor(impl, s.proxy.standard === 'eip1167' ? decoded : null, sfy, decoded),
        tag: 'PROXY',
        tone: 'hot',
        chip: { label: 'Proxy → implementation', value: short(s.proxy.implementation) },
      })
      if (s.proxy.admin) d.push({ id: 'admin', label: 'Admin', value: s.proxy.admin, sub: 'can upgrade the implementation', after: anchor(admin, impl), tag: 'ADMIN', tone: 'hot', chip: { label: 'Admin · can upgrade', value: short(s.proxy.admin) } })
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
  const realMs = has ? Math.max(1, ...trace.map((c) => c.t + c.ms)) : 0
  const log: LogRow[] = []
  const sep = trace.length ? Math.min(300, (callEnd - spanStart) / trace.length) : 0
  for (const [i, c] of trace.entries()) {
    const st = Math.max(spanStart + (c.t / realMs) * (callEnd - spanStart), i ? log[i - 1].start + sep : spanStart)
    const en = Math.max(st + 240, spanStart + ((c.t + c.ms) / realMs) * (callEnd - spanStart))
    log.push({ id: `c${i}`, c, start: st, end: Math.min(en, spanEnd) })
  }
  const step = 190
  const used = new Map<number, number>()
  let preAt = 520
  let evenAt = spanStart
  const evenStep = d.length ? (spanEnd - spanStart) / d.length : 0
  const rows: Row[] = d.map((r) => {
    let at: number
    if (r.after === -1) {
      at = preAt
      preAt += 160
    } else if (r.after === null || !log[r.after]) {
      at = evenAt
      evenAt += evenStep
    } else {
      const k = used.get(r.after) ?? 0
      used.set(r.after, k + 1)
      at = log[r.after].end + 140 + k * step
    }
    const { after: _after, ...rest } = r
    return { ...rest, at }
  })
  const last = Math.max(0, ...rows.map((r) => r.at + Math.min(r.minis?.length ?? 0, 10) * 60))
  if (last > stampAt - 250) {
    const k = (stampAt - 250 - spanStart) / Math.max(1, last - spanStart)
    for (const r of rows) if (r.at > spanStart) r.at = spanStart + (r.at - spanStart) * k
  }
  const rpc = trace.find((c) => c.kind === 'rpc')
  return { seq, ev, live, rows, log, dur, stampAt, closeAt, rpcProvider: rpc?.provider ?? null, realMs, lag: Math.max(0, Math.round((Date.now() - ev.ts) / 1000)) }
}

// ─── data: live queue + replay ──────────────────────────────────────────────

const LIVE_MAX = 6
const HISTORY_MAX = 40
const REPLAY_POOL = 14
const POLL_MS = 20_000

async function fetchScanFeed(limit: number, signal?: AbortSignal): Promise<ChainEvent[]> {
  const res = await fetch(`/api/chain/feed?limit=${limit}&scan=1`, { headers: { Accept: 'application/json' }, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body: unknown = await res.json()
  if (!Array.isArray(body)) return []
  return body.filter((e): e is ChainEvent => !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.ts === 'number' && isChainId(e.chain) && typeof e.address === 'string')
}

const traced = (e: ChainEvent) => !!e.trace?.length

interface Player {
  live: ChainEvent[]
  history: ChainEvent[]
  seen: Set<string>
  replay: number
  seq: number
  newest: number
  loaded: boolean
}

// ─── page ───────────────────────────────────────────────────────────────────

const p2 = (n: number) => String(n).padStart(2, '0')
const clock = (ts: number) => {
  const d = new Date(ts)
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`
}

export default function Scan() {
  useChainLive()
  useEffect(() => {
    document.title = 'Scan — LUSCA'
  }, [])
  const stats = useChain((s) => s.stats)
  const conn = useConn()
  const reduced = useMedia('(prefers-reduced-motion: reduce)')
  const wide = useMedia('(min-width: 1000px)')

  const player = useRef<Player>({ live: [], history: [], seen: new Set(), replay: 0, seq: 0, newest: 0, loaded: false })
  const [show, setShow] = useState<Show | null>(null)
  const [queued, setQueued] = useState(0)
  const [feedState, setFeedState] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading')
  const showRef = useRef<Show | null>(null)
  const skipRef = useRef(false)

  const nextShow = useCallback(() => {
    const p = player.current
    let ev: ChainEvent | undefined = p.live.shift()
    let live = !!ev
    if (!ev) {
      const pool = p.history.filter(traced).slice(0, REPLAY_POOL)
      const from = pool.length ? pool : p.history.slice(0, REPLAY_POOL)
      if (from.length) {
        ev = from[p.replay % from.length]
        p.replay++
        live = false
      }
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
      p.history.sort((a, b) => b.ts - a.ts)
      if (p.history.length > HISTORY_MAX) p.history.length = HISTORY_MAX
      while (p.live.length > LIVE_MAX) {
        // the least to look at goes first; otherwise the oldest
        const i = p.live.findIndex((e) => e.verdict === 'error' || e.verdict === 'token-mint' || e.verdict === 'not-code' || e.verdict === 'duplicate')
        p.live.splice(i >= 0 ? i : 0, 1)
      }
      if (added) {
        setQueued(p.live.length)
        // a new live read cuts a replay short
        if (showRef.current && !showRef.current.live) skipRef.current = true
      }
      if (!showRef.current && (p.live.length || p.history.length)) nextShow()
    },
    [nextShow],
  )

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
    return () => {
      ac.abort()
      window.clearTimeout(timer)
      off()
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

  return (
    <div className={`sc ${reduced ? 'sc-still' : ''}`}>
      <header className="sc-hud">
        <div className="sc-hud-l">
          <Kicker n={SCAN_NAV_N} name="Scan" className="sc-kick" />
          <span className={`sc-mode mono ${show?.live ? 'is-live' : ''}`} role="status" aria-live="polite">
            <span className={show?.live ? 'led on pulse' : conn === 'live' ? 'led white' : connLed(conn)} aria-hidden="true" />
            {show
              ? show.live
                ? `live · read ${show.lag < 2 ? 'just now' : `${show.lag} s ago`}`
                : `replay · read at ${clock(show.ev.ts)}`
              : conn === 'live'
                ? 'waiting for a read'
                : 'connecting'}
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
        <span>
          Every line is a call a LUSCA chain agent just made, replayed in its real order. Nothing is typed in: the agents find the addresses themselves.
        </span>
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

/** Chip slots around the hub, as fractions of the hub column (left, top). */
const SLOTS: [number, number][] = [
  [0.03, 0.05],
  [0.6, 0.04],
  [0.0, 0.22],
  [0.64, 0.21],
  [0.02, 0.62],
  [0.64, 0.63],
  [0.05, 0.8],
  [0.6, 0.81],
]

const SVGNS = 'http://www.w3.org/2000/svg'

function Stage({ show, reduced, wide, skipRef, onDone, feedState, conn }: StageProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<HTMLDivElement>(null)
  const docInRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLOListElement>(null)
  const coreRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
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
    const doc = docRef.current
    const docIn = docInRef.current
    const svg = svgRef.current
    const boxLayer = boxesRef.current
    const win = winRef.current
    const logList = logRef.current
    if (!stage || !doc || !docIn || !svg || !boxLayer || !win) return

    // timed elements in the order they appear
    const timed = [...stage.querySelectorAll<HTMLElement>('[data-at]')]
      .map((el) => ({ el, at: Number(el.dataset.at), end: el.dataset.end ? Number(el.dataset.end) : null, on: false, done: false }))
      .sort((a, b) => a.at - b.at)

    interface Box {
      id: string
      target: HTMLElement
      at: number
      tone: Tone
      tag: string | null
      chip: HTMLElement | null
      box: HTMLDivElement | null
      wire: SVGPathElement | null
      link: SVGPathElement | null
      dot: SVGCircleElement | null
    }
    const boxes: Box[] = []
    let minis = 0
    for (const el of stage.querySelectorAll<HTMLElement>('[data-box]')) {
      const tone = (el.dataset.tone as Tone) || 'hot'
      if (el.dataset.mini && ++minis > 14) continue
      const id = el.dataset.box!
      boxes.push({ id, target: el, at: Number(el.dataset.at ?? el.closest<HTMLElement>('[data-at]')?.dataset.at ?? 0), tone, tag: el.dataset.tag ?? null, chip: stage.querySelector<HTMLElement>(`[data-chip="${id}"]`), box: null, wire: null, link: null, dot: null })
    }
    boxLayer.replaceChildren()
    svg.replaceChildren()
    const net = document.createElementNS(SVGNS, 'polyline')
    net.setAttribute('class', 'sc-net')
    svg.appendChild(net)

    const mkBox = (b: Box) => {
      const el = document.createElement('div')
      el.className = `sc-box ${b.tone}`
      el.innerHTML = '<i class="a"></i><i class="b"></i><i class="c"></i><i class="d"></i>'
      if (b.tag) {
        const t = document.createElement('span')
        t.className = 'sc-tag'
        t.textContent = b.tag
        el.appendChild(t)
      }
      boxLayer.appendChild(el)
      b.box = el
      if (wide) {
        b.wire = document.createElementNS(SVGNS, 'path')
        b.wire.setAttribute('class', `sc-wire ${b.tone}`)
        b.wire.setAttribute('pathLength', '1')
        svg.appendChild(b.wire)
        b.dot = document.createElementNS(SVGNS, 'circle')
        b.dot.setAttribute('class', `sc-dot ${b.tone}`)
        b.dot.setAttribute('r', b.tone === 'hot' ? '3.2' : '2.2')
        svg.appendChild(b.dot)
        if (b.chip) {
          b.link = document.createElementNS(SVGNS, 'path')
          b.link.setAttribute('class', 'sc-link')
          b.link.setAttribute('pathLength', '1')
          svg.appendChild(b.link)
        }
      }
    }

    let el = 0
    let last = performance.now()
    let raf = 0
    let scroll = 0
    let lastRevealed: HTMLElement | null = null
    let ended = false
    const visibleDoc = () => doc.getBoundingClientRect()

    const frame = (now: number) => {
      raf = 0
      const dt = Math.min(100, now - last)
      last = now
      el += dt
      if (skipRef.current && el < show.closeAt - 900) el = Math.max(el, show.closeAt - 900)
      if (reduced) el = Math.max(el, show.stampAt + 1)

      // reveals
      for (const t of timed) {
        if (!t.on && el >= t.at) {
          t.on = true
          t.el.classList.add('on')
          if (t.el.dataset.row) lastRevealed = t.el
          if (t.el.classList.contains('sc-call') && logList) logList.scrollTop = logList.scrollHeight
        }
        if (t.end !== null && !t.done && el >= t.end) {
          t.done = true
          t.el.classList.add('done')
        }
      }
      // window: opening, progress, closing
      const open = reduced ? 1 : ease(el / 520)
      const close = reduced ? 0 : ease((el - show.closeAt) / 380)
      win.style.setProperty('--open', String(open * (1 - close)))
      if (barRef.current) barRef.current.style.transform = `scaleX(${clamp(el / show.stampAt, 0, 1)})`

      // keep the newest revealed row in view
      if (lastRevealed) {
        const want = Math.max(0, lastRevealed.offsetTop + lastRevealed.offsetHeight + 24 - doc.clientHeight)
        scroll = reduced ? want : scroll + (want - scroll) * Math.min(1, dt / 160)
        docIn.style.transform = `translateY(${-scroll.toFixed(1)}px)`
      }

      // boxes, wires, chips
      const sr = stage.getBoundingClientRect()
      const dr = visibleDoc()
      const core = coreRef.current?.getBoundingClientRect()
      const hx = core ? core.left + core.width / 2 - sr.left : sr.width * 0.75
      const hy = core ? core.top + core.height / 2 - sr.top : sr.height * 0.45
      const fade = 1 - close
      const pts: string[] = []
      for (const b of boxes) {
        if (el < b.at) continue
        if (!b.box) mkBox(b)
        const r = b.target.getBoundingClientRect()
        const inView = r.height > 0 && r.top >= dr.top - 2 && r.bottom <= dr.bottom + 2
        const p = reduced ? 1 : ease((el - b.at) / 360)
        const pad = b.tone === 'hot' ? 5 : 3
        const x = r.left - sr.left - pad
        const y = r.top - sr.top - pad
        const w = r.width + pad * 2
        const h = r.height + pad * 2
        const box = b.box!
        box.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
        box.style.width = `${w.toFixed(1)}px`
        box.style.height = `${h.toFixed(1)}px`
        box.style.opacity = String((inView ? p : 0) * fade)
        box.style.setProperty('--k', String(1 + 0.22 * (1 - p)))
        if (!b.wire) continue
        const tagW = b.tag ? (box.lastElementChild as HTMLElement).offsetWidth + 10 : 0
        const bx = x + w + tagW + 4
        const by = y + h / 2
        let ex = hx
        let ey = hy
        if (b.chip) {
          const cr = b.chip.getBoundingClientRect()
          ex = cr.left - sr.left
          ey = cr.top - sr.top + cr.height / 2
          if (ex > hx) ex = cr.left - sr.left // chips right of the hub: wire to their left edge too
          const cx = cr.left - sr.left + (cr.left + cr.width / 2 - sr.left < hx ? cr.width : 0)
          const p2 = reduced ? 1 : ease((el - b.at - 160) / 420)
          b.link!.setAttribute('d', `M${cx.toFixed(1)},${ey.toFixed(1)} L${hx.toFixed(1)},${hy.toFixed(1)}`)
          b.link!.style.strokeDashoffset = String(1 - p2)
          b.link!.style.opacity = String(0.6 * fade)
          pts.push(`${(cr.left - sr.left + cr.width / 2).toFixed(1)},${ey.toFixed(1)}`)
        }
        const dx = Math.max(60, (ex - bx) * 0.45)
        b.wire.setAttribute('d', `M${bx.toFixed(1)},${by.toFixed(1)} C${(bx + dx).toFixed(1)},${by.toFixed(1)} ${(ex - dx).toFixed(1)},${ey.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`)
        b.wire.style.strokeDashoffset = String(1 - p)
        b.wire.style.opacity = String((inView ? (b.tone === 'hot' ? 0.9 : 0.55) : 0) * fade)
        b.dot!.setAttribute('cx', bx.toFixed(1))
        b.dot!.setAttribute('cy', by.toFixed(1))
        b.dot!.style.opacity = String((inView ? p : 0) * fade)
      }
      net.setAttribute('points', pts.join(' '))
      net.style.opacity = String(0.9 * fade)

      if (el >= show.dur && !ended) {
        ended = true
        doneRef.current()
        return
      }
      if (!document.hidden) raf = requestAnimationFrame(frame)
    }
    const onVis = () => {
      if (!document.hidden && !raf && !ended) {
        last = performance.now()
        raf = requestAnimationFrame(frame)
      }
    }
    const onResize = () => {
      if (!raf && !ended && !document.hidden) raf = requestAnimationFrame(frame)
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('resize', onResize)
    raf = requestAnimationFrame(frame)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('resize', onResize)
      boxLayer.replaceChildren()
      svg.replaceChildren()
    }
  }, [show, reduced, wide, skipRef])

  const ev = show?.ev
  const chips = show ? show.rows.filter((r) => r.chip).slice(0, SLOTS.length) : []
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
            <span className="sc-win-title mono">{ev ? `${ev.name ?? short(ev.address)} — LUSCA Lens` : 'LUSCA Lens'}</span>
            {show?.rpcProvider && (
              <span className={`sc-via mono ${/helius/i.test(show.rpcProvider) ? 'hot' : ''}`} title="Who answered this read's RPC calls">
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
          <div className="sc-doc" ref={docRef}>
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
                <span className={`p ${/helius/i.test(l.c.provider) ? 'hot' : ''}`}>{l.c.provider}</span>
                <span className="d num">{fmtInt(l.c.ms)} ms</span>
                <span className="r">{l.c.result}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="sc-right">
        <div className="sc-hub" aria-hidden="true">
          <div className="sc-octo" />
          <div className="sc-core" ref={coreRef}>
            <i className="ring" />
            <i className="ring r2" />
            <i className="dot" />
          </div>
          {ev && (
            <div className="sc-hub-l mono">
              <b>LUSCA · {ev.agent}</b>
              <span>{show?.rpcProvider ? `reading ${CHAIN_LABEL[ev.chain]} via ${show.rpcProvider}` : `reading ${CHAIN_LABEL[ev.chain]}`}</span>
            </div>
          )}
        </div>
        <div className="sc-chips" key={`chips-${show?.seq ?? 'idle'}`}>
          {chips.map((r, i) => (
            <div
              key={r.id}
              className={`sc-chip ${r.tone === 'hot' ? 'hot' : ''}`}
              data-chip={r.id}
              data-at={r.at + 150}
              style={{ ['--x' as string]: `${SLOTS[i][0] * 100}%`, ['--y' as string]: `${SLOTS[i][1] * 100}%` }}
            >
              <span className="l mono">{r.chip!.label}</span>
              <span className="v mono">{r.chip!.value}</span>
            </div>
          ))}
        </div>
        {show && (
          <div className={`sc-stamp ${kept ? 'kept' : show.ev.verdict === 'error' ? 'err' : 'rej'}`} data-at={show.stampAt} ref={stampRef} key={`stamp-${show.seq}`}>
            <b>{kept ? 'Kept' : show.ev.verdict === 'error' ? 'Read failed' : 'Rejected'}</b>
            <span className="mono">
              {kept ? 'in the SEPIA-1 dataset' : VERDICT_LABEL[show.ev.verdict]} · {show.ev.reason}
            </span>
          </div>
        )}
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
        <h2 className="sc-title">
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
