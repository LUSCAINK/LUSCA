// Plain front-end for the desktop neuron (mode 'log'): the output the neuron has always printed — a
// boot header, then one timestamped line per event — with earnings shown as credits (the user's
// share of the SOL payout pool). Used for --plain / --quiet, LUSCA_NEURON_PLAIN, terminals smaller
// than the dashboard needs, and whenever stdout is not a TTY (pipes, services, log files).
//
// Verdict and escrow lines carry the credit totals, which come only from the server's ledger (the
// 'account' event): each such line is held until the next 'account' event (the server pushes one
// within about a second of every change), or HOLD_MS if none comes, and then printed with it.
// Lines after a held one wait behind it, so the log keeps the event order; every line keeps the
// time its event arrived.

import { ZONES } from '../../shared/protocol.ts'
import { SEPIA } from '../../shared/sepia/index.mjs'
import type { NeuronEvent, NeuronUI } from './types.ts'

type Totals = Extract<NeuronEvent, { t: 'totals' }>
type Account = Extract<NeuronEvent, { t: 'account' }>
/** How long a verdict line waits for the ledger update it caused. */
const HOLD_MS = 1600
type Boot = Extract<NeuronEvent, { t: 'boot' }>
type Job = Extract<NeuronEvent, { t: 'job' }>

// ─── formatting (shared with neuron.ts) ──────────────────────────────────────

export function fmtG(g: number): string {
  return g >= 100 ? Math.round(g).toLocaleString('en-US') : g >= 10 ? g.toFixed(1) : g.toFixed(2)
}
export function fmtFlop(f: number): string {
  if (f >= 1e12) return `${(f / 1e12).toFixed(2)} TFLOP`
  if (f >= 1e9) return `${(f / 1e9).toFixed(2)} GFLOP`
  return `${(f / 1e6).toFixed(1)} MFLOP`
}
export function fmtCredits(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id
}
export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a
}
export function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
function clock(): string {
  const d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

// ─── log UI ──────────────────────────────────────────────────────────────────

/**
 * `quiet`: only warnings, failures, a summary every 25 verified jobs and the shutdown reason.
 * `resumed`: skip the boot header (used when the dashboard fails mid-session and output falls back here).
 */
export function createLogUI(opts: { color: boolean; quiet?: boolean; resumed?: boolean }): NeuronUI {
  const paint = (code: string) => (s: string | number) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : String(s))
  const hot = paint('38;5;202')
  const dim = paint('2')
  const bold = paint('1')
  const red = paint('31')
  const bone = paint('97')
  const quiet = !!opts.quiet
  const tty = !!process.stdout.isTTY
  const RULE = '─'.repeat(44)
  const write = (s: string) => void process.stdout.write(s)

  const startedAt = Date.now()
  let header = !opts.resumed // boot block, until the first connection attempt
  let boot: Boot | null = null
  let whereShown = false // server + label lines printed
  let benchOpen = false // the "timing…" line awaiting its result (TTY only)
  let wallet: string | null = null
  let linked: boolean | null = null
  let attempts = 0
  let lastNetwork = 0
  let totals: Totals | null = null // this session's verdict counts
  let acct: Account | null = null // the server's ledger totals (null: no reply yet → "—")
  let forfeited = 0
  let trainJobs = 0
  let flops = 0
  let held: string | null = null // quiet: the last info notice, printed at stop (the shutdown reason)
  let stopped = false
  const jobs = new Map<string, Job>()
  // Lines waiting for the ledger update their verdict caused, and the lines queued behind them.
  // `counts` = the verdict counts right after that verdict (the 'totals' event neuron.ts emits
  // next); `at` = when the event arrived.
  let deferred: { fn: (a: Account | null, t: Totals | null) => void; counts: Totals | null; at: string }[] = []
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  let flushingAt: string | null = null // a held item being printed: its lines go out now, with its time

  const line = (mark: string, msg: string, force = false) => {
    if (quiet && !force) return
    if (flushingAt !== null) {
      write(`${dim(flushingAt)} ${mark} ${msg}\n`)
      return
    }
    const at = clock()
    if (deferred.length) deferred.push({ fn: () => write(`${dim(at)} ${mark} ${msg}\n`), counts: null, at })
    else write(`${dim(at)} ${mark} ${msg}\n`)
  }
  const info = (msg: string) => line(dim('·'), msg)
  const good = (msg: string) => line(bone('■'), msg)
  const warn = (msg: string) => line(hot('▲'), msg, true)
  const bad = (msg: string) => line(red('✕'), msg, true)

  const flush = () => {
    if (holdTimer) clearTimeout(holdTimer)
    holdTimer = null
    const items = deferred
    deferred = []
    for (const it of items) {
      flushingAt = it.at
      try {
        it.fn(acct, it.counts ?? totals)
      } finally {
        flushingAt = null
      }
    }
  }
  /** A line that shows the ledger totals: held for the 'account' update its event caused. */
  const later = (fn: (a: Account | null, t: Totals | null) => void) => {
    deferred.push({ fn, counts: null, at: clock() })
    if (!holdTimer) holdTimer = setTimeout(flush, HOLD_MS)
  }

  /** Server ledger totals ("—" until the first reply). */
  const creditLine = (a: Account | null) =>
    a
      ? `${hot(`${fmtCredits(a.confirmed)} credits confirmed`)}${a.pending > 0 ? ` · ${fmtCredits(a.pending)} pending` : ''}${forfeited > 0 ? ` · ${red(`${fmtCredits(forfeited)} forfeited`)}` : ''}`
      : hot('— credits')
  const tally = (t: Totals | null) => (t ? ` · ${t.verified}/${t.verified + t.failed}` : '')
  const summaryLine = (a: Account | null, t: Totals | null) =>
    `${fmtDur(Date.now() - startedAt)} · ${t?.jobs ?? 0} jobs (${trainJobs} train) · ${t?.verified ?? 0} verified · ${t?.failed ?? 0} failed · ${fmtFlop(flops)} · ${creditLine(a)}${a ? ` · +${fmtCredits(a.session)} this session` : ''}`

  const where = () => {
    if (whereShown || !boot) return
    whereShown = true
    write(`  ${dim('server ')} ${boot.server}\n`)
    write(`  ${dim('label  ')} ${boot.label}\n`)
  }
  const closeBench = () => {
    if (!benchOpen) return
    benchOpen = false
    write('\r\x1b[2K')
  }
  const endHeader = () => {
    if (!header) return
    closeBench()
    where()
    write(`  ${dim(RULE)}\n\n`)
    header = false
  }
  const payee = () => {
    const to = wallet ? shortAddr(wallet) : 'signed-in wallet'
    write(`  ${dim('credits')} to ${to} ${dim('(pending server check) · paid in SOL')}\n`)
  }

  const emit = (e: NeuronEvent) => {
    if (stopped) return
    switch (e.t) {
      case 'boot':
        boot = e
        write(`\n  ${hot('■')} ${bold('LUSCA')} ${dim('· desktop neuron')}\n  ${dim(RULE)}\n`)
        write(`  ${dim('cpu    ')} ${e.cpu} · ${e.threads} threads (1 used) · ${e.os}\n`)
        return
      case 'bench':
        if (e.phase === 'start') {
          if (tty && header) {
            write(`  ${dim('bench  ')} timing a 256×256 fp32 matmul…`)
            benchOpen = true
          }
          return
        }
        closeBench()
        if (e.gflops === undefined) return
        {
          const z = ZONES.find((x) => x.zone === e.zone)
          const bonus = e.bonus ?? z?.bonus
          write(
            `  ${dim('bench  ')} ${bold(fmtG(e.gflops))} GFLOPS ${dim('(256×256 fp32 matmul · median · 1 thread)')}${e.zone ? ` → ${hot(e.zone)}` : ''}${z || bonus !== undefined ? ` ${dim(`·${z ? ` ${z.name} ·` : ''}${bonus !== undefined ? ` credit bonus ×${bonus.toFixed(2)}` : ''}`)}` : ''}\n`,
          )
        }
        return
      case 'selftest':
        write(
          `  ${dim('sepia  ')} ${SEPIA.params.toLocaleString('en-US')} params · grad B=${e.batch} in ${e.ms.toFixed(0)} ms ${dim(`(${fmtG(e.gflops)} GFLOPS · f16 codec cos ${e.codecCos.toFixed(5)})`)}\n`,
        )
        return
      case 'wallet':
        if (e.address) wallet = e.address
        if (!header) return // later wallet changes show up in the registration / notice lines
        closeBench()
        where()
        switch (e.state) {
          case 'signing':
            write(`  ${dim('wallet ')} ${e.address ?? ''} ${dim('· signing in (plain-text message, no transaction)…')}\n`)
            return
          case 'verified':
            write(`  ${dim('wallet ')} ${bone('verified')}${e.until ? ` ${dim(`· sign-in valid until ${new Date(e.until).toISOString().slice(0, 10)}`)}` : ''}\n`)
            payee()
            return
          case 'token':
            payee()
            return
          case 'none':
            write(`  ${dim('credits')} to this device ${dim('(no wallet linked yet)')}\n`)
            return
          case 'failed':
            return // the neuron prints why on stderr after stopping
        }
        return
      case 'conn':
        endHeader()
        switch (e.state) {
          case 'connecting':
            info(`connecting to ${e.server}${attempts ? dim(` (attempt ${attempts + 1})`) : ''}`)
            attempts++
            return
          case 'connected':
            attempts = 0
            good('connected · registering')
            return
          case 'registered':
            good(
              `registered neuron ${bone(shortId(e.neuronId ?? '—'))} · ${hot(e.zone ?? '—')} · ${e.gflops !== undefined ? `${fmtG(e.gflops)} GFLOPS` : '— GFLOPS'} · desktop${wallet ? ` · ${shortAddr(wallet)}` : ''}`,
            )
            if (e.linked !== undefined && e.linked !== linked) {
              linked = e.linked
              if (linked) good(`credits linked to verified wallet ${bone(wallet ? shortAddr(wallet) : '')} · eligible for SOL payouts`)
              else info(dim('credits stay on this device account — sign in with --keypair or --auth to receive SOL payouts'))
            }
            return
          default:
            return // 'reconnecting' / 'closed': the accompanying notice carries the text
        }
      case 'network': {
        const now = Date.now()
        if (e.rank === undefined || now - lastNetwork < 60_000) return
        lastNetwork = now
        info(dim(`rank #${e.rank} of ${e.neurons} neurons · pool ${fmtG(e.poolGflops)} GFLOPS`))
        return
      }
      case 'job':
        jobs.set(e.id, e)
        if (jobs.size > 64) jobs.delete(jobs.keys().next().value as string)
        return
      case 'computed': {
        const j = jobs.get(e.id)
        jobs.delete(e.id)
        const f = j && j.flops > 0 ? j.flops : e.gflops * e.ms * 1e6
        flops += f
        if (e.kind === 'train') {
          trainJobs++
          info(
            `train ${bone(shortId(e.id))}${j?.version !== undefined ? ` · SEPIA v${j.version}` : ''}${j?.batch ? ` · B=${j.batch}` : ''}${e.loss !== undefined ? ` · loss ${e.loss.toFixed(3)}` : ''} · ${fmtFlop(f)} · ${e.ms.toFixed(0)} ms · ${fmtG(e.gflops)} GFLOPS`,
          )
        } else {
          info(`job ${bone(shortId(e.id))} · ${fmtFlop(f)} · ${e.ms.toFixed(e.ms < 10 ? 1 : 0)} ms · ${fmtG(e.gflops)} GFLOPS eff.`)
        }
        return
      }
      case 'verdict': {
        const why = e.reason ? ` ${dim(`· ${e.reason}`)}` : ''
        if (e.status === 'verified' || e.status === 'audited') {
          later((a, t) => {
            good(`${bone(e.status)} ${hot(`+${fmtCredits(e.credits)} credits`)} ${dim(e.pending ? 'pending' : 'confirmed')}${why} · ${creditLine(a)}${tally(t)}`)
            if (quiet && t && t.verified > 0 && t.verified % 25 === 0) line(dim('·'), summaryLine(a, t), true)
          })
        } else if (e.status === 'failed') {
          jobs.delete(e.id)
          bad(`${e.kind === 'train' ? 'train job' : 'job'} ${shortId(e.id)} rejected locally: ${e.reason ?? 'error'}`)
        } else if (e.status === 'stale') {
          warn(e.reason ?? 'gradient not scored (no strike)')
        } else {
          bad(`rejected · ${e.reason ?? 'no reason given'}`)
        }
        return
      }
      case 'escrow':
        if (e.forfeited && e.forfeited > 0) {
          const lost = e.forfeited
          forfeited += lost
          later(() => bad(`escrow forfeited · ${fmtCredits(lost)} pending credits lost (a full audit failed)`))
        }
        if (e.released > 0) {
          const amt = e.released
          later((a) => good(`${bone('audit passed')} · ${hot(`${fmtCredits(amt)} pending credits confirmed`)} ${dim('· escrow released')} · ${creditLine(a)}`))
        }
        return
      case 'totals':
        totals = e
        for (const it of deferred) it.counts = it.counts ?? e
        return
      case 'account':
        acct = e
        flush()
        return
      case 'notice': {
        if (header) {
          closeBench()
          const mark = e.level === 'error' ? red('■') : e.level === 'warn' ? hot('▲') : dim('·')
          write(`  ${mark} ${e.msg}\n`)
          return
        }
        if (e.level === 'error') {
          bad(e.msg)
        } else if (e.level === 'warn') {
          warn(e.msg)
        } else {
          if (quiet) held = e.msg
          info(dim(e.msg))
        }
        return
      }
    }
  }

  const stop = async (summary?: string): Promise<void> => {
    if (stopped) return
    flush()
    closeBench()
    stopped = true
    let tail = ''
    if (quiet && held) tail += `${dim(clock())} ${dim('·')} ${held}\n`
    held = null
    if (summary) {
      const lit = summary
        .replace(/([\d,]+\.\d+ credits confirmed)/, (m) => hot(m))
        .replace(/([\d,]+\.\d+ forfeited)/, (m) => red(m))
      tail += `\n  ${dim('session')} ${lit}\n\n`
    }
    if (!tail) return
    // Resolve once the text is handed to the OS, so a process.exit() right after does not cut it off.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1000).unref() // a closed pipe never calls back
      try {
        process.stdout.write(tail, () => resolve())
      } catch {
        resolve()
      }
    })
  }

  return { emit, stop }
}
