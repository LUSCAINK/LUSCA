// robots.txt cache (per origin, 1 h TTL) built on robots-parser.
// Policy: 2xx → parse; 4xx (except 429) → allow all; 429 / 5xx / timeout /
// network failure → "unavailable" (the caller pauses the host for 10 minutes).
// Crawl-delay is honoured up to MAX_CRAWL_DELAY_MS; a delay above one hour is
// treated as "do not crawl" for that origin. Redirects of robots.txt itself are
// followed by hand (≤ 5 hops) so every hop goes through the public-address guard.
//
// AI-training opt-outs (accepted pages train SEPIA, so they bind LuscaBot):
//   • a group for any agent in AI_TRAINING_UAS (GPTBot, CCBot, ClaudeBot, …) that
//     disallows the URL — see trainingOptOut();
//   • Cloudflare's Content-Signal directive (contentsignals.org), e.g.
//       User-agent: *
//       Content-Signal: search=yes, ai-train=no
//     parsed here (robots-parser ignores it) — see aiTrainSignal(). A value may start
//     with a path ("Content-Signal: /blog/ ai-train=no") to scope it.
import robotsParser from 'robots-parser'
import { readCapped, decodeBody, describeFetchError } from './fetcher.ts'
import { MAX_CRAWL_DELAY_MS } from './hosts.ts'
import { assertPublicHost } from './netguard.ts'
import { AI_TRAINING_UAS, ROBOTS_UA, botHeaders } from './util.ts'

type Robot = ReturnType<typeof robotsParser>

export const ROBOTS_TTL_MS = 60 * 60_000
export const ROBOTS_UNAVAILABLE_PAUSE_MS = 10 * 60_000
/** A Crawl-delay above this means the site effectively does not want to be crawled. */
export const CRAWL_DELAY_DISALLOW_MS = 60 * 60_000
const ROBOTS_TIMEOUT_MS = 10_000
const ROBOTS_MAX_BYTES = 512 * 1024
const ROBOTS_MAX_REDIRECTS = 5
const REDIRECTS = new Set([301, 302, 303, 307, 308])

export type SignalValue = 'yes' | 'no'
/** Parsed Content-Signal: lowercased key → yes/no, e.g. { search: 'yes', 'ai-train': 'no' }. */
export type ContentSignals = Record<string, SignalValue>

/** One Content-Signal line of a robots.txt, with the group it sits in. */
export interface SignalRule {
  /** lowercased user-agent tokens of the enclosing group ('*' for lines before any group) */
  agents: string[]
  /** path prefix the line is scoped to ('' = whole site) */
  path: string
  signals: ContentSignals
  /** the directive value as written (for traces / provenance) */
  raw: string
}

/**
 * Parse a Content-Signal value ("search=yes, ai-train=no"). Keys are lowercased;
 * values other than yes/no (any case) are ignored. A header the server repeats
 * arrives comma-joined, which this handles too.
 */
export function parseContentSignal(value: string | null | undefined): ContentSignals {
  const out: ContentSignals = {}
  if (!value) return out
  for (const part of value.split(/[,;]/)) {
    const m = /^\s*([a-z0-9_-]+)\s*=\s*"?([a-z]+)"?\s*$/i.exec(part)
    if (!m) continue
    const v = m[2].toLowerCase()
    if (v !== 'yes' && v !== 'no') continue
    const k = m[1].toLowerCase()
    // A repeated key: "no" wins (the conservative reading).
    if (out[k] !== 'no') out[k] = v
  }
  return out
}

/** Same user-agent token robots-parser derives: lowercased, "/version" stripped. */
function uaToken(ua: string): string {
  const s = ua.toLowerCase()
  const i = s.indexOf('/')
  return (i >= 0 ? s.slice(0, i) : s).trim()
}

/**
 * Content-Signal lines and the user-agent groups of a robots.txt, tracking groups
 * the way robots-parser does (consecutive User-agent lines share one group).
 */
export function parseRobotsSignals(text: string): { rules: SignalRule[]; agents: Set<string> } {
  const rules: SignalRule[] = []
  const agents = new Set<string>()
  let current: string[] = []
  let lastWasAgent = false
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const hash = rawLine.indexOf('#')
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (key === 'user-agent') {
      if (!lastWasAgent) current = []
      const tok = uaToken(value)
      if (tok) {
        current.push(tok)
        agents.add(tok)
      }
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (key !== 'content-signal' || !value) continue
    let path = ''
    let body = value
    const sp = /^(\/\S*)\s+(.*)$/.exec(value)
    if (sp) {
      path = sp[1]
      body = sp[2]
    }
    const signals = parseContentSignal(body)
    if (Object.keys(signals).length === 0) continue
    rules.push({ agents: current.length ? [...current] : ['*'], path, signals, raw: value.slice(0, 200) })
  }
  return { rules, agents }
}

/**
 * The effective ai-train signal for a URL path. Inside each group the most specific
 * (longest path) line that sets ai-train counts. A LuscaBot group that sets one
 * decides alone; otherwise any group saying "no" makes it "no", whichever crawler
 * the group names, because the signal is about how the content may be used.
 */
export function aiTrainFrom(rules: readonly SignalRule[], urlPath: string): { value: SignalValue; raw: string } | null {
  const lusca = uaToken(ROBOTS_UA)
  const perGroup = new Map<string, SignalRule>()
  for (const r of rules) {
    if (!r.signals['ai-train']) continue
    if (r.path && !urlPath.startsWith(r.path)) continue
    const g = r.agents.join('\n')
    const prev = perGroup.get(g)
    if (!prev || r.path.length > prev.path.length || (r.path.length === prev.path.length && r.signals['ai-train'] === 'no')) perGroup.set(g, r)
  }
  if (perGroup.size === 0) return null
  const pick = (rs: SignalRule[]) => rs.find((r) => r.signals['ai-train'] === 'no') ?? rs[0]
  const own = [...perGroup.values()].filter((r) => r.agents.includes(lusca))
  const r = pick(own.length ? own : [...perGroup.values()])
  return { value: r.signals['ai-train'], raw: r.raw }
}

interface Entry {
  robot: Robot | null // null = allow all
  fetchedAt: number
  status: number
  crawlDelayMs: number
  disallowAll: boolean
  /** Content-Signal lines (empty when none / no robots.txt) */
  signals: SignalRule[]
  /**
   * AI-training agents to test with robot.isAllowed(): those with their own group,
   * plus '*' when LuscaBot has its own group (agents without a group then fall back
   * to '*' rules LuscaBot itself does not follow). Precomputed per origin so a page
   * with hundreds of links does not cost 11 rule lookups per link.
   */
  aiAgents: { test: string; label: string }[]
}

export type RobotsFetch =
  | { ok: true; status: number; allowAll: boolean; crawlDelayMs: number; ms: number; contentSignal: string | null }
  | { ok: false; status: number | null; reason: string; ms: number }

function aiAgentsFor(agents: Set<string>): { test: string; label: string }[] {
  const out: { test: string; label: string }[] = []
  const without: string[] = []
  for (const ua of AI_TRAINING_UAS) {
    if (agents.has(uaToken(ua))) out.push({ test: ua, label: ua })
    else without.push(ua)
  }
  if (without.length && agents.has(uaToken(ROBOTS_UA)) && agents.has('*')) out.push({ test: '*', label: without[0] })
  return out
}

export class RobotsCache {
  private cache = new Map<string, Entry>()
  private pending = new Map<string, Promise<RobotsFetch>>()

  /** Is there a fresh entry for this origin? */
  has(origin: string, now = Date.now()): boolean {
    const e = this.cache.get(origin)
    return !!e && now - e.fetchedAt < ROBOTS_TTL_MS
  }

  crawlDelayMs(origin: string): number {
    return this.cache.get(origin)?.crawlDelayMs ?? 0
  }

  private entryFor(url: string): Entry | null | undefined {
    let origin: string
    try {
      origin = new URL(url).origin
    } catch {
      return null
    }
    return this.cache.get(origin)
  }

  /**
   * Allowed by the cached rules? Unknown origins are treated as allowed — callers
   * always call `ensure()` first, this is only a defensive default.
   */
  isAllowed(url: string): boolean {
    const e = this.entryFor(url)
    if (e === null) return false
    if (!e) return true
    if (e.disallowAll) return false
    if (!e.robot) return true
    try {
      return e.robot.isAllowed(url, ROBOTS_UA) !== false
    } catch {
      return true
    }
  }

  /**
   * The AI-training crawler (AI_TRAINING_UAS: GPTBot, CCBot, Google-Extended,
   * ClaudeBot, …) whose robots.txt group disallows this URL, if any. Accepted pages
   * feed SEPIA's training, so such an opt-out also applies to LuscaBot's use of the text.
   */
  trainingOptOut(url: string): string | null {
    const e = this.entryFor(url)
    if (!e) return null
    if (e.disallowAll) return ROBOTS_UA
    if (!e.robot) return null
    for (const a of e.aiAgents) {
      try {
        if (e.robot.isAllowed(url, a.test) === false) return a.label
      } catch {
        /* ignore */
      }
    }
    return null
  }

  /** The robots.txt Content-Signal ai-train value that applies to this URL ('no' = training opt-out). */
  aiTrainSignal(url: string): { value: SignalValue; raw: string } | null {
    const e = this.entryFor(url)
    if (!e || e.signals.length === 0) return null
    let path = '/'
    try {
      path = new URL(url).pathname || '/'
    } catch {
      /* keep '/' */
    }
    return aiTrainFrom(e.signals, path)
  }

  /** HTTP status robots.txt was answered with for this URL's origin (null = not fetched yet). */
  statusFor(url: string): number | null {
    return this.entryFor(url)?.status ?? null
  }

  /** Fetch robots.txt for an origin unless a fresh copy is cached. Never throws. */
  ensure(origin: string, stop: AbortSignal): Promise<RobotsFetch | null> {
    if (this.has(origin)) return Promise.resolve(null)
    let p = this.pending.get(origin)
    if (!p) {
      p = this.fetchRobots(origin, stop).finally(() => this.pending.delete(origin))
      this.pending.set(origin, p)
    }
    return p
  }

  private async fetchRobots(origin: string, stop: AbortSignal): Promise<RobotsFetch> {
    const t0 = Date.now()
    const robotsUrl = `${origin}/robots.txt`
    try {
      const signal = AbortSignal.any([stop, AbortSignal.timeout(ROBOTS_TIMEOUT_MS)])
      let url = robotsUrl
      let res: Response
      for (let hop = 0; ; hop++) {
        await assertPublicHost(new URL(url).hostname)
        res = await fetch(url, {
          redirect: 'manual',
          signal,
          headers: botHeaders({ Accept: 'text/plain,*/*;q=0.5' }),
        })
        const loc = REDIRECTS.has(res.status) ? res.headers.get('location') : null
        if (!loc) break
        await res.body?.cancel().catch(() => {})
        if (hop >= ROBOTS_MAX_REDIRECTS) return { ok: false, status: res.status, reason: 'too many robots.txt redirects', ms: Date.now() - t0 }
        const next = new URL(loc, url)
        if (next.protocol !== 'http:' && next.protocol !== 'https:') return { ok: false, status: res.status, reason: 'robots.txt redirect to a non-http url', ms: Date.now() - t0 }
        url = next.toString()
      }
      const status = res.status
      if (status >= 200 && status < 300) {
        const { bytes } = await readCapped(res.body, ROBOTS_MAX_BYTES)
        const text = decodeBody(bytes, res.headers.get('content-type'))
        // A site that answers robots.txt with an HTML page has no rules for us.
        const looksHtml = /^\s*<(!doctype|html|head|body)/i.test(text)
        const robot = looksHtml ? null : robotsParser(robotsUrl, text)
        const delay = robot?.getCrawlDelay(ROBOTS_UA)
        const rawMs = typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? delay * 1000 : 0
        const disallowAll = rawMs > CRAWL_DELAY_DISALLOW_MS
        const crawlDelayMs = Math.round(Math.min(rawMs, MAX_CRAWL_DELAY_MS))
        const parsed = looksHtml ? { rules: [] as SignalRule[], agents: new Set<string>() } : parseRobotsSignals(text)
        this.cache.set(origin, { robot, fetchedAt: Date.now(), status, crawlDelayMs, disallowAll, signals: parsed.rules, aiAgents: aiAgentsFor(parsed.agents) })
        const contentSignal = parsed.rules.length ? [...new Set(parsed.rules.map((r) => r.raw))].join(' | ').slice(0, 160) : null
        return { ok: true, status, allowAll: !robot && !disallowAll, crawlDelayMs, ms: Date.now() - t0, contentSignal }
      }
      await res.body?.cancel().catch(() => {})
      if (status >= 400 && status < 500 && status !== 429) {
        this.cache.set(origin, { robot: null, fetchedAt: Date.now(), status, crawlDelayMs: 0, disallowAll: false, signals: [], aiAgents: [] })
        return { ok: true, status, allowAll: true, crawlDelayMs: 0, ms: Date.now() - t0, contentSignal: null }
      }
      return { ok: false, status, reason: `HTTP ${status}`, ms: Date.now() - t0 }
    } catch (e) {
      const info = describeFetchError(e, ROBOTS_TIMEOUT_MS)
      return { ok: false, status: null, reason: info.msg, ms: Date.now() - t0 }
    }
  }
}
