// URL hygiene for the frontier: normalization (identity), hard skips, soft
// penalties for low-value paths, the new-domain blocklist and the operator
// denylist (denylist.ts).
import { isDenylisted } from './denylist.ts'

export interface NormUrl {
  /** What we actually GET: absolute, no fragment, tracking params removed, original slash kept. */
  fetchUrl: string
  /** Identity used for the seen set / page ids: params sorted, trailing slash dropped (except root). */
  key: string
  host: string
  path: string
  search: string
}

/** Special-use / local-network-only DNS suffixes (RFC 6761, 6762, 8375 and common LAN conventions). */
const LOCAL_SUFFIX = /\.(localhost|local|internal|home\.arpa|localdomain|lan|intranet|corp|private|test|invalid|example|onion)$/

const TRACKING_PARAM = /^(utm_[a-z0-9_]*|ref|ref_src|ref_url|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|_ga|yclid)$/i

/** File extensions that are never HTML pages. */
const NON_PAGE_EXT =
  /\.(pdf|png|jpe?g|gif|svg|webp|avif|bmp|tiff?|ico|zip|tar|gz|tgz|bz2|xz|rar|7z|mp4|mp3|m4a|wav|ogg|webm|mov|avi|mkv|css|js|mjs|map|json|xml|rss|atom|woff2?|ttf|otf|eot|csv|xlsx?|docx?|pptx?|txt|md|mediawiki|rst|adoc|ipynb|sol|py|ts|rs|go|exe|dmg|apk|iso|bin|epub|wasm)$/i

/** MediaWiki namespaces that are never article content. */
const WIKI_NAMESPACE =
  /^\/wiki\/(special|file|image|media|talk|user|user_talk|wikipedia|wikipedia_talk|help|help_talk|template|template_talk|category|category_talk|portal|portal_talk|draft|module|mediawiki|book|timedtext|education_program|gadget)(:|%3a)/i

/** Social / auth / mega-platform hosts we never admit as new domains. */
const BLOCKED_HOSTS = [
  'twitter.com', 'x.com', 'facebook.com', 'fb.com', 'instagram.com', 't.me', 'telegram.org', 'telegram.me',
  'discord.gg', 'discord.com', 'discordapp.com', 'youtube.com', 'youtu.be', 'reddit.com', 'redd.it',
  'linkedin.com', 'lnkd.in', 'tiktok.com', 'apple.com', 'play.google.com', 'github.com', 'gitlab.com',
  'web.archive.org', 'archive.org', 'archive.ph', 'bit.ly', 'goo.gl', 'tinyurl.com', 't.co', 'ow.ly',
  'buff.ly', 'amazon.com', 'pinterest.com', 'whatsapp.com', 'wa.me', 'threads.net', 'bsky.app',
  'mastodon.social', 'warpcast.com', 'farcaster.xyz', 'twitch.tv', 'spotify.com', 'podcasts.apple.com',
  'docs.google.com', 'drive.google.com', 'forms.gle', 'typeform.com', 'calendly.com', 'zoom.us',
  'eventbrite.com', 'lu.ma', 'meetup.com', 'notion.so', 'notion.site', 'figma.com', 'vimeo.com',
  'stackoverflow.com', 'stackexchange.com', 'npmjs.com', 'pypi.org', 'crates.io', 'hub.docker.com',
]

/**
 * Forum boards whose threads are accusations against named people (scam reports,
 * trust disputes): never queued, and topic pages found anyway are not stored
 * (their breadcrumb names the board). `boards` match ?board=<id> on board index
 * URLs; `crumbs` match the "Forum > … > <board> >" breadcrumb in the page text.
 */
const ACCUSATION_BOARDS: { host: string; boards: string[]; crumb: RegExp }[] = [
  {
    host: 'bitcointalk.org',
    boards: ['83'], // Scam Accusations
    crumb: /^Bitcoin Forum > (?:[^\n]* > )?(Scam Accusations|Reputation)(?: >|[ \t]*$)/m,
  },
]

function accusationBoardRule(host: string) {
  const h = host.toLowerCase()
  return ACCUSATION_BOARDS.find((b) => h === b.host || h.endsWith('.' + b.host))
}

/** The accusation board a fetched page belongs to (by its breadcrumb), or null. */
export function accusationBoard(host: string, text: string): string | null {
  const rule = accusationBoardRule(host)
  if (!rule) return null
  const m = rule.crumb.exec(text.slice(0, 6000))
  return m ? m[1] : null
}

export function isBlockedHost(host: string, path = '/', search = ''): boolean {
  const h = host.toLowerCase()
  if (isDenylisted(h, path, search)) return true
  if (/(^|\.)google\.[a-z.]+$/.test(h) || h.startsWith('google.')) return true
  if (h.includes('telegram')) return true
  if (h.startsWith('accounts.') || h.startsWith('login.') || h.startsWith('auth.') || h.startsWith('signin.')) return true
  if ((h === 'medium.com' || h.endsWith('.medium.com')) && path.startsWith('/m/')) return true
  for (const d of BLOCKED_HOSTS) if (h === d || h.endsWith('.' + d)) return true
  return false
}

/**
 * Parse + normalize. Returns null for anything that is not a crawlable http(s) page URL.
 * Normalization: lowercase host, drop fragment, drop utm_* / ref / fbclid…, drop default port,
 * collapse Discourse post-number permalinks (/t/slug/123/45 → /t/slug/123), drop trailing
 * slash (identity only), sort query params (identity only).
 */
export function normalizeUrl(raw: string, base?: string): NormUrl | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed || /^(mailto|javascript|tel|data|ftp|sms|file|about|blob|irc|magnet):/i.test(trimmed)) return null
  let u: URL
  try {
    u = base ? new URL(trimmed, base) : new URL(trimmed)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  let host = u.hostname.toLowerCase()
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (!host || !host.includes('.') || host === 'localhost') return null
  // Never crawl raw IPs or private ranges (names that only resolve on a local
  // network are refused here; netguard.ts refuses public-looking names that
  // resolve to private addresses at fetch time).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return null
  if (LOCAL_SUFFIX.test(host)) return null
  u.hostname = host
  u.hash = ''
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = ''

  // Drop tracking params.
  const keep: [string, string][] = []
  for (const [k, v] of u.searchParams) if (!TRACKING_PARAM.test(k)) keep.push([k, v])
  if (keep.length !== [...u.searchParams].length) {
    u.search = ''
    for (const [k, v] of keep) u.searchParams.append(k, v)
  }

  // Discourse permalink to a post number renders the same topic page.
  const disc = /^(\/t\/[^/]+\/\d+)\/\d+\/?$/.exec(u.pathname)
  if (disc) u.pathname = disc[1]

  const fetchUrl = u.toString()
  if (fetchUrl.length > 400) return null

  // Identity key.
  let path = u.pathname || '/'
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '') || '/'
  const sorted = [...keep].sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
  const qs = sorted.length ? '?' + new URLSearchParams(sorted).toString() : ''
  const key = `${u.protocol}//${host}${u.port ? ':' + u.port : ''}${path}${qs}`
  return { fetchUrl, key, host, path: u.pathname || '/', search: u.search }
}

/** Hard skip: not worth even queueing. Returns a short reason or null. */
export function skipReason(n: NormUrl): string | null {
  const p = n.path.toLowerCase()
  const q = n.search.toLowerCase()
  if (NON_PAGE_EXT.test(p)) return 'non-page extension'
  if (p.includes('/cdn-cgi/')) return 'cdn-cgi'
  // Unexpanded templates like /[YYYY]/[MM]/ or {{slug}} (brackets stay literal in
  // WHATWG-parsed paths, braces get percent-encoded).
  if (/[[\]{}]|%5b|%5d|%7b|%7d/.test(p)) return 'template placeholder'
  if (p.includes('wp-json') || p.includes('/xmlrpc.php') || p.includes('/wp-admin') || p.includes('/wp-login')) return 'wordpress internals'
  if (WIKI_NAMESPACE.test(n.path)) return 'wiki namespace'
  if (/(^|[?&])(action|veaction)=(edit|history|raw|info|submit|purge|render|watch|unwatch|delete|protect)/.test(q)) return 'wiki action'
  if (/(^|[?&])(oldid|diff|curid|printable|replytocom|share|redlink|returnto|mobileaction)=/.test(q)) return 'non-canonical view'
  if (p.startsWith('/w/index.php') || p.startsWith('/w/api.php') || p.startsWith('/w/load.php')) return 'wiki internals'
  // Forum member profiles (SMF "?action=profile;u=123") are personal pages, not content.
  if (/(^|[?&;])action=profile([;&]|$)/.test(q)) return 'user profile'
  const acc = accusationBoardRule(n.host)
  if (acc) {
    const b = /(?:^|[?&;])board=(\d+)(?:[.;&]|$)/.exec(q)
    if (b && acc.boards.includes(b[1])) return 'accusation board'
  }
  if (isDenylisted(n.host, n.path, n.search)) return 'denylisted'
  if (isBlockedHost(n.host, n.path, n.search)) return 'blocked host'
  return null
}

export interface Penalty {
  amount: number
  label: string
}

/** Soft penalties for low-value paths (summed, capped at 0.6). */
export function pathPenalty(n: NormUrl): Penalty | null {
  const p = n.path.toLowerCase()
  const q = n.search.toLowerCase()
  let amount = 0
  const labels: string[] = []
  const hit = (a: number, l: string) => {
    amount += a
    labels.push(l)
  }
  if (/\/(u|user|users|members?|profile|profiles|author)\//.test(p + '/')) hit(0.25, 'user page')
  if (/\/(tag|tags)(\/|$)/.test(p)) hit(0.2, 'tag page')
  if (/\/search(\/|$)/.test(p) || /(^|[?&])(q|query|search|s)=/.test(q)) hit(0.35, 'search')
  if (/\/(login|log-in|signin|sign-in|signup|sign-up|register|session|logout|auth)(\/|$)/.test(p)) hit(0.4, 'auth')
  const pg = /(?:^|[?&])page=(\d+)/.exec(q)
  if (pg && Number(pg[1]) > 3) hit(0.2, `page ${pg[1]}`)
  const wpPage = /\/page\/(\d+)\/?$/.exec(p)
  if (wpPage && Number(wpPage[1]) > 3) hit(0.2, `page ${wpPage[1]}`)
  if (/\/print(\/|$)/.test(p) || /(^|[?&])print=/.test(q)) hit(0.3, 'print view')
  if (/\/(feed|rss|atom)(\/|$)/.test(p) || p.endsWith('.rss')) hit(0.35, 'feed')
  if (/(^|[?&])(sort|order|orderby|filter)=/.test(q)) hit(0.15, 'sorted view')
  if (/\/(privacy|terms|cookie|cookies|legal|careers|jobs|contact|press|brand|imprint)(-[a-z-]+)?\/?$/.test(p)) hit(0.2, 'boilerplate')
  if (/\/(\d{4})\/(\d{2})\/?$/.test(p) || /\/(archive|archives)(\/|$)/.test(p)) hit(0.1, 'archive index')
  if (amount <= 0) return null
  return { amount: Math.min(0.6, amount), label: labels.join(', ') }
}

/** Path → lexicon-friendly words: "/t/eip-4844-blob-fees/123" → "t eip 4844 blob fees 123". */
export function pathWords(path: string): string {
  let p = path
  try {
    p = decodeURIComponent(path)
  } catch {
    /* keep raw */
  }
  return p.replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase()
}
