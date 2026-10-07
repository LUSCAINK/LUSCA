// HTML → { title, clean text, links } with node-html-parser.
import { parse, NodeType, type HTMLElement, type Node, type TextNode } from 'node-html-parser'

export interface RawLink {
  url: string // absolute http(s), fragment stripped
  text: string // anchor text (collapsed, ≤ 120 chars)
  /** every anchor to this url carries rel="nofollow" / "ugc" / "sponsored": never followed */
  nofollow: boolean
}

export interface Extracted {
  title: string
  text: string // paragraphs separated by \n
  words: number
  links: RawLink[]
  canonical: string | null
  noindex: boolean
  nofollow: boolean
  /** Text-and-data-mining / AI-training rights reserved (<meta name="tdm-reservation" content="1"> or robots "noai"). */
  tdmReserved: boolean
}

const PARSE_OPTS = {
  comment: false,
  // Keep elements whose closing tag is missing (e.g. an unclosed <div class="markdown-body">)
  // instead of dropping them and lifting their children — otherwise main-content selectors miss.
  parseNoneClosedTags: true,
  // An <a> opened while another is still open closes the previous one (as the HTML
  // spec does); otherwise every unclosed anchor contains the rest of the document.
  fixNestedATags: true,
  // false = drop the element's contents entirely (no raw text kept)
  blockTextElements: { script: false, style: false, noscript: false, template: false },
}

/** Chrome / boilerplate removed before text extraction (links are collected first). */
const JUNK = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'nav', 'header', 'footer', 'aside', 'form', 'iframe',
  'button', 'select', 'dialog', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[aria-hidden="true"]',
  '.navbox', '.vertical-navbox', '#toc', '.toc', '.mw-editsection', 'sup.reference', '.reflist', '.mw-references-wrap', 'ol.references',
  '.noprint', '.catlinks', '#catlinks', '.printfooter', '.mw-jump-link', '.hatnote', '.ambox', '.sistersitebox',
  '.sr-only', '.visually-hidden', '.screen-reader-text', '.skip-link', '.breadcrumb', '.breadcrumbs',
  '.cookie-banner', '#cookie-banner', '.crawler-post-meta', '.crawler-linkback-list',
  '.sidebar', '.share', '.social-share', '.newsletter-signup', '.theme-doc-toc-mobile', '.table-of-contents',
].join(', ')

/**
 * Main-content candidates in preference order. Each selector may match several
 * elements (Discourse posts, article cards) — their texts are joined.
 */
const MAIN = [
  '.cooked',
  '.crawler-post .post',
  '#mw-content-text',
  '.markdown-body',
  'article',
  'main',
  '[role="main"]',
  '.post-content',
  '.entry-content',
  '.article-content',
  '.theme-doc-markdown',
  '.rst-content',
  '#content',
  '#main-outlet',
  '.content',
]

/** Zero-width space (U+200B) or BOM (U+FEFF); built from char codes to keep the source ASCII. */
const ZERO_WIDTH = new RegExp(`[${String.fromCharCode(0x200b)}${String.fromCharCode(0xfeff)}]`, 'g')

function collapse(s: string): string {
  // JS \s already covers NBSP and the Unicode line/paragraph separators.
  return s.replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim()
}

/** structuredText → clean paragraphs: collapse runs of spaces, drop empty and repeated lines. */
function cleanText(raw: string): string {
  const out: string[] = []
  let prev = ''
  for (const line of raw.split(/\n+/)) {
    // Drop 160+ char unbroken runs (base64 blobs, minified code, giant URLs): they are
    // noise for the corpus and pathological for BPE tokenization.
    const l = collapse(line.replace(/\S{160,}/g, ' '))
    if (!l || l === prev) continue
    out.push(l)
    prev = l
  }
  return out.join('\n')
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])
const MAX_TEXT_WALK_NODES = 200_000
const NL = String.fromCharCode(10)

/**
 * Block-aware text without recursion: node-html-parser's structuredText / text
 * getters recurse per nesting level and overflow the stack on pages with
 * thousands of unclosed elements.
 */
function iterativeText(root: HTMLElement): string {
  const parts: string[] = []
  const stack: (Node | null)[] = [root] // null = end of a block element
  let visited = 0
  while (stack.length && visited < MAX_TEXT_WALK_NODES) {
    const n = stack.pop()
    if (n === null) {
      parts.push(NL)
      continue
    }
    if (!n) continue
    visited++
    if (n.nodeType === NodeType.TEXT_NODE) {
      parts.push((n as TextNode).text)
      continue
    }
    if (n.nodeType !== NodeType.ELEMENT_NODE) continue
    const block = BLOCK_TAGS.has(((n as HTMLElement).rawTagName ?? '').toLowerCase())
    if (block) {
      parts.push(NL)
      stack.push(null)
    }
    const kids = n.childNodes
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
  return parts.join('')
}

function textOf(el: HTMLElement): string {
  try {
    return cleanText(el.structuredText)
  } catch {
    return cleanText(iterativeText(el))
  }
}

/** Drop matches that are nested inside another match (avoid double text). */
function topLevel(els: HTMLElement[]): HTMLElement[] {
  if (els.length < 2) return els
  const set = new Set(els)
  return els.filter((el) => {
    let p = el.parentNode as HTMLElement | null
    while (p) {
      if (set.has(p)) return false
      p = p.parentNode as HTMLElement | null
    }
    return true
  })
}

const TITLE_SEP = /\s+[|\-–—·•»]\s+/g

/** Trim one trailing site suffix: "Ethereum - Wikipedia" → "Ethereum". */
export function cleanTitle(raw: string): string {
  let t = collapse(raw)
  const seps = [...t.matchAll(TITLE_SEP)]
  if (seps.length > 0) {
    const last = seps[seps.length - 1]
    const idx = last.index ?? -1
    const tail = t.slice(idx + last[0].length)
    const head = t.slice(0, idx)
    if (idx > 0 && tail.length <= 40 && head.length >= 6) t = head
  }
  return t.length > 160 ? t.slice(0, 159).trimEnd() + '…' : t
}

/** Iterative (no recursion-depth risk on pathological nesting) whitespace collapse of text nodes. */
function collapseTextNodes(root: Node): void {
  const stack: Node[] = [root]
  while (stack.length) {
    const n = stack.pop() as Node
    for (const c of n.childNodes) {
      if (c.nodeType === NodeType.TEXT_NODE) {
        const t = c as TextNode
        const raw = t.rawText
        if (/[\n\r\t\f]|\s\s/.test(raw)) t.rawText = raw.replace(/\s+/g, ' ')
      } else if (c.nodeType === NodeType.ELEMENT_NODE) {
        stack.push(c)
      }
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const ANCHOR_TEXT_MAX = 120
const ANCHOR_RAW_BUDGET = 1024 // raw characters gathered before collapsing whitespace

/**
 * Anchor text without walking the whole subtree: a depth-first walk that stops
 * once enough text is collected (an unclosed <a> can contain the rest of the page).
 */
function anchorText(a: HTMLElement): string {
  let raw = ''
  const stack: Node[] = [a]
  let visited = 0
  while (stack.length && raw.length < ANCHOR_RAW_BUDGET && visited < 4000) {
    const n = stack.pop() as Node
    visited++
    if (n.nodeType === NodeType.TEXT_NODE) {
      raw += (n as TextNode).text
      continue
    }
    const kids = n.childNodes
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
  return collapse(raw.length > ANCHOR_RAW_BUDGET ? raw.slice(0, ANCHOR_RAW_BUDGET) : raw)
}

function metaContent(root: HTMLElement, sel: string): string {
  const v = root.querySelector(sel)?.getAttribute('content')
  return v ? collapse(v) : ''
}

// Pathological nesting (thousands of unclosed elements) used to overflow the stack in
// the recursive text getters; text is now gathered iteratively when that happens.
// (Re-parsing with parseNoneClosedTags: false is NOT a fallback: that mode is
// quadratic on deep unclosed nesting — ~16 s for 5000 unclosed <div>.)
// Personal data never enters the dataset, the model or the live feed: emails and phone numbers
// are replaced before anything is scored, stored or broadcast.
const PHONE_RE = /(?<![\w.\/#-])\+?\(?\d{1,4}\)?[ .-]\d{2,4}[ .-]\d{3,4}(?:[ .-]\d{2,4})?(?![\w.\/-])/g
const isLocalChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45
const isDomainChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 45
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)

/**
 * text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'), in linear time. The regex itself is
 * quadratic on long runs of letters and digits (a page showing 40 KB of hex calldata took 1.3 s, 120 KB about
 * 12 s, all on the event loop); here each '@' is expanded once. server/ingest/_redact_test.ts checks the two
 * agree.
 */
function redactEmails(text: string): string {
  let out = ''
  let last = 0 // end of the previous match: the next one never starts before it
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    if (at < last) continue
    let s = at // local part: the longest run of local characters right before '@'
    while (s > last && isLocalChar(text.charCodeAt(s - 1))) s--
    if (s === at) continue
    let e = at + 1 // domain: the longest run of domain characters after '@'
    while (e < text.length && isDomainChar(text.charCodeAt(e))) e++
    // as the regex backtracks: the last '.' in that run, after at least one character, followed by ≥ 2 letters
    let end = -1
    for (let d = e - 1; d > at + 1; d--) {
      if (text.charCodeAt(d) !== 46) continue
      let k = d + 1
      while (k < text.length && isLetter(text.charCodeAt(k))) k++
      if (k - d - 1 >= 2) {
        end = k
        break
      }
    }
    if (end < 0) continue
    out += `${text.slice(last, s)}[email]`
    last = end
    at = end - 1
  }
  return last === 0 ? text : out + text.slice(last)
}

export function redactPII(text: string): string {
  return redactEmails(text).replace(PHONE_RE, '[phone]')
}

export function extract(rawHtml: string, baseUrl: string): Extracted {
  return extractWith(rawHtml, baseUrl, PARSE_OPTS)
}

function extractWith(rawHtml: string, baseUrl: string, opts: typeof PARSE_OPTS): Extracted {
  // node-html-parser keeps a doctype / XML prolog as a text node; drop them up front.
  const html = rawHtml.replace(/^\s*(<\?xml[^>]*>\s*)?(<!doctype[^>]*>)?/i, '')
  const root = parse(html, opts)

  // <base href> changes how relative links resolve.
  let base = baseUrl
  const baseHref = root.querySelector('base[href]')?.getAttribute('href')
  if (baseHref) {
    try {
      base = new URL(baseHref, baseUrl).toString()
    } catch {
      /* ignore bad base */
    }
  }

  // Meta robots (only the generic "robots" and our own bot name apply to us).
  let noindex = false
  let nofollow = false
  let tdmReserved = false
  for (const m of root.querySelectorAll('meta[name]')) {
    const name = (m.getAttribute('name') ?? '').toLowerCase()
    const c = (m.getAttribute('content') ?? '').toLowerCase()
    // TDMRep (W3C CG): machine-readable text-and-data-mining reservation (EU DSM Art. 4(3)).
    if (name === 'tdm-reservation') {
      if (c.trim() === '1') tdmReserved = true
      continue
    }
    if (name !== 'robots' && name !== 'luscabot') continue
    if (c.includes('noindex') || c.includes('none')) noindex = true
    if (c.includes('nofollow') || c.includes('none')) nofollow = true
    // "noai" opts the text out of AI training ("noimageai" only concerns images, which are never kept).
    if (/(^|[\s,])noai($|[\s,])/.test(c)) tdmReserved = true
  }

  let canonical: string | null = null
  const canonHref = root.querySelector('link[rel="canonical"]')?.getAttribute('href')
  if (canonHref) {
    try {
      canonical = new URL(canonHref, base).toString()
    } catch {
      canonical = null
    }
  }

  // Title: og:title → twitter:title → <title> → first <h1>.
  const og = metaContent(root, 'meta[property="og:title"]') || metaContent(root, 'meta[name="twitter:title"]')
  const docTitle = collapse(root.querySelector('title')?.text ?? '')
  let title = cleanTitle(og || docTitle)
  if (!title) title = cleanTitle(root.querySelector('h1')?.text ?? '')

  // Links are collected BEFORE chrome removal: docs sidebars and forum topic
  // lists live in <nav>/<aside>, and they are exactly what a crawler needs.
  const linkMap = new Map<string, { text: string; nofollow: boolean }>()
  for (const a of root.querySelectorAll('a[href]')) {
    if (linkMap.size >= 3000) break
    const href = (a.getAttribute('href') ?? '').trim()
    if (!href || href.startsWith('#') || /^(mailto|javascript|tel|data):/i.test(href)) continue
    let abs: URL
    try {
      abs = new URL(href, base)
    } catch {
      continue
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue
    abs.hash = ''
    const url = abs.toString()
    const rel = (a.getAttribute('rel') ?? '').toLowerCase().split(/\s+/)
    const nf = rel.some((r) => r === 'nofollow' || r === 'ugc' || r === 'sponsored')
    let text = anchorText(a)
    if (!text) text = collapse(a.getAttribute('title') ?? a.getAttribute('aria-label') ?? '')
    if (text.length > ANCHOR_TEXT_MAX) text = text.slice(0, ANCHOR_TEXT_MAX - 1).trimEnd() + '…'
    const prev = linkMap.get(url)
    // A url is followable if ANY anchor to it is (an editorial link next to a ugc one).
    if (prev === undefined) linkMap.set(url, { text, nofollow: nf })
    else {
      if (text.length > prev.text.length) prev.text = text
      if (!nf) prev.nofollow = false
    }
  }
  const links: RawLink[] = [...linkMap].map(([url, l]) => ({ url, text: l.text, nofollow: l.nofollow }))

  // Strip chrome, then pick the main content block.
  for (const el of root.querySelectorAll(JUNK)) {
    try {
      el.remove()
    } catch {
      /* already detached */
    }
  }
  // Code blocks: structuredText would fold a <pre> into one line. Re-emit each
  // source line as its own block so the corpus keeps code line structure.
  for (const pre of root.querySelectorAll('pre')) {
    try {
      const lines = pre.text.split('\n')
      if (lines.length > 1 && lines.length < 2000) pre.set_content(lines.map((l) => `<div>${escapeHtml(l)}</div>`).join(''))
    } catch {
      /* leave as is */
    }
  }
  // Source-level line breaks inside a paragraph are just whitespace: collapse every
  // text node so that only block boundaries become "\n" (pre blocks were split above).
  collapseTextNodes(root)
  const body = (root.querySelector('body') as HTMLElement | null) ?? root
  const bodyText = textOf(body)
  let text = ''
  for (const sel of MAIN) {
    let els: HTMLElement[]
    try {
      els = topLevel(root.querySelectorAll(sel))
    } catch {
      continue
    }
    if (els.length === 0) continue
    const t = els.map(textOf).filter(Boolean).join('\n')
    if (t.length >= Math.max(250, 0.25 * bodyText.length)) {
      text = t
      break
    }
  }
  if (!text) text = bodyText

  // Pages built entirely inside <header>/<form>/etc: fall back to a gentle pass.
  if (text.length < 200) {
    try {
      const light = parse(html, opts)
      for (const el of light.querySelectorAll('script, style, noscript, template, svg, iframe, nav')) el.remove()
      const lb = (light.querySelector('body') as HTMLElement | null) ?? light
      const t = textOf(lb)
      if (t.length > text.length) text = t
    } catch {
      /* keep what we have */
    }
  }

  text = redactPII(text)
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0
  return { title: redactPII(title), text, words, links, canonical, noindex, nofollow, tdmReserved }
}
