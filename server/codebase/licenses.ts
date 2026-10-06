// Licenses in the protocol code index: recorded for every repository and file, never used to
// exclude anything (SEPIA-1 learns from the code; it does not redistribute it).
//
//   permissive        MIT, Apache-2.0, BSD-2/3/4-Clause, ISC, 0BSD, Unlicense, CC0, Zlib, BSL-1.0, …
//   copyleft          GPL / LGPL / AGPL (-only / -or-later / +), MPL, EPL, EUPL, CDDL, CC-BY-SA
//   source-available  BUSL, SSPL, Elastic-2.0, PolyForm, Commons Clause, project licenses
//                     (Metaplex NFT, Orca, Aptos, Gyro), "all rights reserved"
//   unknown           NOASSERTION, none, UNLICENSED (no license granted), anything not recognised
//
// A file's license is its own SPDX header when it has one, else the nearest LICENSE file above it,
// else the repository license. The one reason a repository is left out on license grounds is a
// license or README that explicitly forbids machine-learning / AI training (forbidsMachineLearning).

import type { LicenseTier } from '../../shared/codebase.ts'

const RANK: Record<LicenseTier, number> = { permissive: 0, copyleft: 1, 'source-available': 2, unknown: 3 }
const BY_RANK: LicenseTier[] = ['permissive', 'copyleft', 'source-available', 'unknown']

const PERMISSIVE_IDS = new Set([
  'MIT',
  'MIT-0',
  'APACHE-2.0',
  'BSD-2-CLAUSE',
  'BSD-3-CLAUSE',
  'BSD-3-CLAUSE-CLEAR',
  'BSD-4-CLAUSE',
  'ISC',
  '0BSD',
  'UNLICENSE',
  'CC0-1.0',
  'CC0',
  'ZLIB',
  'BSL-1.0',
  'WTFPL',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'BLUEOAK-1.0.0',
  'PSF-2.0',
  'PYTHON-2.0',
  'UPL-1.0',
  'NCSA',
  'X11',
  'POSTGRESQL',
])
const COPYLEFT_IDS = new Set([
  'GPL-1.0',
  'GPL-2.0',
  'GPL-3.0',
  'LGPL-2.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'AGPL-1.0',
  'AGPL-3.0',
  'MPL-1.1',
  'MPL-2.0',
  'EPL-1.0',
  'EPL-2.0',
  'EUPL-1.1',
  'EUPL-1.2',
  'CDDL-1.0',
  'CDDL-1.1',
  'CC-BY-SA-3.0',
  'CC-BY-SA-4.0',
  'OSL-3.0',
])
const SOURCE_AVAILABLE_IDS = new Set(['BUSL-1.0', 'BUSL-1.1', 'BUSL', 'SSPL-1.0', 'ELASTIC-2.0'])
const SOURCE_AVAILABLE_REF = /^LICENSEREF-.*(?:BUSL|BUSINESS|METAPLEX|ORCA|APTOS|INNOVATION|RIGHTS-RESERVED|PROPRIETARY|COMMONS-CLAUSE|NON-?COMMERCIAL|GYRO)/

/** Common spellings seen in SPDX headers that are not the canonical id. */
const ALIASES: Record<string, string> = {
  'APACHE2.0': 'APACHE-2.0',
  'APACHE-2': 'APACHE-2.0',
  APACHE2: 'APACHE-2.0',
  'MIT-LICENSE': 'MIT',
  GPL3: 'GPL-3.0',
  GPLV3: 'GPL-3.0',
  'GPL-3': 'GPL-3.0',
  GPL2: 'GPL-2.0',
  GPLV2: 'GPL-2.0',
  'GPL-2': 'GPL-2.0',
  AGPL3: 'AGPL-3.0',
  'AGPL-3': 'AGPL-3.0',
  AGPLV3: 'AGPL-3.0',
  LGPL3: 'LGPL-3.0',
  'LGPL-3': 'LGPL-3.0',
  'BSD-3': 'BSD-3-CLAUSE',
  'BSD-2': 'BSD-2-CLAUSE',
  UNLICENCE: 'UNLICENSE',
  'BUSL1.1': 'BUSL-1.1',
  'BSL-1.1': 'BUSL-1.1', // Business Source License written with the Boost prefix (BSL-1.0 is Boost)
}

/** Canonical spelling of the ids above (upper-case key → SPDX spelling). */
const CANONICAL: Record<string, string> = {}
for (const id of [
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-3-Clause-Clear',
  'BSD-4-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'Zlib',
  'BSL-1.0',
  'WTFPL',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'BlueOak-1.0.0',
  'PSF-2.0',
  'Python-2.0',
  'UPL-1.0',
  'NCSA',
  'X11',
  'PostgreSQL',
  'GPL-1.0',
  'GPL-2.0',
  'GPL-3.0',
  'LGPL-2.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'AGPL-1.0',
  'AGPL-3.0',
  'MPL-1.1',
  'MPL-2.0',
  'EPL-1.0',
  'EPL-2.0',
  'EUPL-1.1',
  'EUPL-1.2',
  'CDDL-1.0',
  'CDDL-1.1',
  'CC-BY-SA-3.0',
  'CC-BY-SA-4.0',
  'OSL-3.0',
  'BUSL-1.0',
  'BUSL-1.1',
  'SSPL-1.0',
  'Elastic-2.0',
  'UNLICENSED',
  'NOASSERTION',
])
  CANONICAL[id.toUpperCase()] = id

const OPERATOR = /^(AND|OR|WITH)$/i

/** Upper-case id without -only / -or-later / + (for comparisons and tiers). */
function baseId(raw: string): string {
  let id = raw.trim().toUpperCase()
  id = ALIASES[id] ?? id
  id = id.replace(/\+$/, '').replace(/-(ONLY|OR-LATER)$/, '')
  return ALIASES[id] ?? id
}

/** Display tier of one SPDX license id (no operators). */
export function idTier(raw: string): LicenseTier {
  const id = baseId(raw)
  if (!id) return 'unknown'
  if (PERMISSIVE_IDS.has(id)) return 'permissive'
  if (COPYLEFT_IDS.has(id)) return 'copyleft'
  if (SOURCE_AVAILABLE_IDS.has(id) || id.startsWith('POLYFORM-') || id.startsWith('CC-BY-NC') || SOURCE_AVAILABLE_REF.test(id)) return 'source-available'
  return 'unknown'
}

function tokens(expr: string): string[] {
  return expr.replace(/[()]/g, (m) => ` ${m} `).split(/\s+/).filter(Boolean)
}

/** License ids named in an SPDX expression (operators, parentheses and exception ids dropped). */
export function exprIds(expr: string): string[] {
  const out: string[] = []
  const t = tokens(expr)
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(' || t[i] === ')' || OPERATOR.test(t[i])) {
      if (/^WITH$/i.test(t[i])) i++ // skip the exception id
      continue
    }
    out.push(t[i])
  }
  return out
}

/**
 * Display tier of an SPDX expression: `A OR B` is the more open side (the licensee may choose),
 * `A AND B` the less open one, `A WITH exception` counts as A. Unparseable → 'unknown'.
 */
export function exprTier(expr: string): LicenseTier {
  const toks = tokens(expr)
  let i = 0
  const peek = () => toks[i]?.toUpperCase()
  const factor = (): number => {
    const t = toks[i++]
    if (t === undefined) throw new Error('eof')
    if (t === '(') {
      const v = orExpr()
      if (toks[i++] !== ')') throw new Error('paren')
      return v
    }
    if (t === ')' || OPERATOR.test(t)) throw new Error('operator')
    const v = RANK[idTier(t)]
    if (peek() === 'WITH') {
      if (toks[i + 1] === undefined || toks[i + 1] === '(' || toks[i + 1] === ')') throw new Error('with')
      i += 2
    }
    return v
  }
  const andExpr = (): number => {
    let v = factor()
    while (peek() === 'AND') {
      i++
      v = Math.max(v, factor())
    }
    return v
  }
  const orExpr = (): number => {
    let v = andExpr()
    while (peek() === 'OR') {
      i++
      v = Math.min(v, andExpr())
    }
    return v
  }
  try {
    if (!toks.length) return 'unknown'
    const v = orExpr()
    return i === toks.length ? BY_RANK[v] : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Canonical spelling of an SPDX expression (known ids re-cased, operators upper-case, spaces normalised). */
export function canonicalExpr(expr: string): string {
  const out: string[] = []
  for (const t of tokens(expr)) {
    if (OPERATOR.test(t)) {
      out.push(t.toUpperCase())
      continue
    }
    if (t === '(' || t === ')') {
      out.push(t)
      continue
    }
    const m = /^(.*?)(\+|-only|-or-later)?$/i.exec(t)!
    const up = ALIASES[m[1].toUpperCase()] ?? m[1].toUpperCase()
    const canon = CANONICAL[up]
    out.push(canon ? canon + (m[2] ? m[2].toLowerCase() : '') : t)
  }
  return out.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')')
}

/** Header values that point elsewhere or assert nothing: the directory / repository license applies. */
const HEADER_NO_LICENSE = /^(?:SEE\s+LICEN[CS]E\s+IN\b.*|NONE|NOASSERTION|UNKNOWN|TBD|-)$/i

/**
 * The SPDX expression of a file's `SPDX-License-Identifier:` header (first 4 KB), canonicalised, or
 * null when there is none or it defers to a license file ('SEE LICENSE IN LICENSE', 'None', 'NOASSERTION').
 */
export function spdxHeader(text: string): string | null {
  const head = text.length > 4096 ? text.slice(0, 4096) : text
  const m = /SPDX-License-Identifier:[ \t]*([^\r\n]*)/.exec(head)
  if (!m) return null
  let v = m[1]
    .replace(/\*\/.*$/, '') // /* SPDX-License-Identifier: MIT */
    .replace(/-->.*$/, '') // <!-- SPDX-License-Identifier: MIT -->
    .replace(/["'`;,.]+\s*$/, '') // trailing quotes / punctuation, incl. a full stop ("Apache-2.0.")
    .trim()
    .slice(0, 160)
  if (!v || HEADER_NO_LICENSE.test(v)) return null
  // "Apache 2", "Apache 2.0", "Apache License 2.0", "Apache License, Version 2.0"
  if (/^apache(?:[ -]license)?,?[ -]?(?:version[ -])?2(?:\.0)?$/i.test(v)) v = 'Apache-2.0'
  return canonicalExpr(v)
}

/** Basename (case-insensitive) of a license file: LICENSE, LICENSE.md, LICENSE-MIT, COPYING, … (not license.rs). */
const LICENSE_FILE =
  /^(?:(?:un)?licen[cs]es?|copying)(?:[-_.](?:mit|apache(?:-?2(?:\.0)?)?|bsd(?:-[23]-clause)?|gpl(?:-?[23](?:\.0)?)?|lgpl(?:-?[23](?:\.[01])?)?|agpl(?:-?3(?:\.0)?)?|mpl(?:-?2(?:\.0)?)?|cc0|isc|0bsd|unlicense|lesser|busl(?:-?1\.1)?))*(?:\.(?:md|txt|rst|markdown))?$/i
export function isLicenseFile(name: string): boolean {
  return LICENSE_FILE.test(name)
}

/** LICENSE-MIT / LICENSE.APACHE / LICENSE_BSD: one of several alternative license files (dual licensing). */
function isAlternativeLicenseFile(name: string): boolean {
  return /^licen[cs]e[-_.](?!md$|txt$|rst$|markdown$)/i.test(name)
}

/** Root README basename (README, README.md, readme.txt, …). */
export function isReadme(name: string): boolean {
  return /^readme(?:\.(?:md|mdx|txt|rst|markdown))?$/i.test(name)
}

/** Whitespace-tolerant phrase (license texts wrap lines anywhere). Case-insensitive unless flags = ''. */
function phrase(s: string, flags = 'i'): RegExp {
  const words = s
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(words.join('\\s+'), flags)
}

const TXT = {
  busl: phrase('Business Source License'),
  sspl: phrase('Server Side Public License'),
  elastic: /Elastic\s+License\s+(?:Version\s+)?2\.0/i,
  polyform: /PolyForm\s+(Noncommercial|Shield|Small\s+Business|Strict|Internal\s+Use|Perimeter|Free\s+Trial)\s+License\s+1\.0\.0/i,
  commonsClause: phrase('Commons Clause'),
  metaplex: /METAPLEX(?:\(TM\)|™)?\s+NFT\s+OPEN\s+SOURCE\s+LICENSE/i,
  orca: /\bOrca\s+License\b/,
  aptos: phrase('Innovation-Enabling Source Code License'),
  // Full texts carry an upper-case title (case-sensitive: the GPL text mentions the Affero and Lesser
  // licenses in mixed case); short notices say "under the terms of the GNU … License as published".
  agpl: [phrase('GNU AFFERO GENERAL PUBLIC LICENSE', ''), phrase('terms of the GNU Affero General Public License as published')],
  lgpl: [/GNU\s+(?:LESSER|LIBRARY)\s+GENERAL\s+PUBLIC\s+LICENSE/, /terms\s+of\s+the\s+GNU\s+(?:Lesser|Library)\s+General\s+Public\s+License\s+as\s+published/i],
  gpl: [phrase('GNU GENERAL PUBLIC LICENSE', ''), phrase('terms of the GNU General Public License as published')],
  mpl: /Mozilla\s+Public\s+License,?\s+(?:Version|v\.?)\s*2\.0/i,
  epl: /Eclipse\s+Public\s+License\s+-?\s*v(?:ersion)?\s*2\.0/i,
  apache: /Apache\s+License,?\s+Version\s+2\.0/i,
  boost: phrase('Boost Software License - Version 1.0'),
  ccBySa: phrase('Attribution-ShareAlike 4.0 International'),
  ccBy: /\bAttribution\s+4\.0\s+International\b/i,
  mit: phrase('Permission is hereby granted, free of charge, to any person obtaining a copy'),
  isc: /Permission\s+to\s+use,\s+copy,\s+modify,\s+and(?:\/or)?\s+distribute\s+this\s+software\s+for\s+any\s+purpose\s+with\s+or\s+without\s+fee\s+is\s+hereby\s+granted/i,
  iscNotice: phrase('copyright notice and this permission notice appear in all copies'),
  bsd: phrase('Redistribution and use in source and binary forms, with or without modification, are permitted'),
  bsd3: /Neither\s+the\s+name|endorse\s+or\s+promote\s+products/i,
  unlicense: phrase('This is free and unencumbered software released into the public domain'),
  cc0: /CC0\s+1\.0\s+Universal|Creative\s+Commons\s+Zero|\bCC0-1\.0\b/i,
  reserved: /\ball\s+rights\s+(?:are\s+)?(?:hereby\s+)?reserved\b|\bno\s+license,?\s+right\s+of\s+reproduction/i,
}

interface Detected {
  ids: string[]
  /** SPDX expression for the file: the pointer expression itself, or the ids joined with AND. */
  expr: string | null
}

function detect(text: string): Detected {
  const t = text.length > 200_000 ? text.slice(0, 200_000) : text
  const out = new Set<string>()
  const any = (res: RegExp[]) => res.some((re) => re.test(t))
  if (TXT.busl.test(t)) out.add('BUSL-1.1')
  if (TXT.sspl.test(t)) out.add('SSPL-1.0')
  if (TXT.elastic.test(t)) out.add('Elastic-2.0')
  const pf = TXT.polyform.exec(t)
  if (pf) out.add(`PolyForm-${pf[1].replace(/\s+/g, '-')}-1.0.0`)
  if (TXT.commonsClause.test(t)) out.add('LicenseRef-Commons-Clause')
  if (TXT.metaplex.test(t)) out.add('LicenseRef-Metaplex-NFT-1.0')
  if (TXT.orca.test(t)) out.add('LicenseRef-Orca')
  if (TXT.aptos.test(t)) out.add('LicenseRef-Aptos-Innovation-Enabling')
  if (any(TXT.agpl)) out.add('AGPL-3.0')
  if (any(TXT.lgpl)) out.add(/Version\s+2\.1\b/i.test(t) ? 'LGPL-2.1' : /Version\s+2\b/i.test(t) && !/Version\s+3\b/i.test(t) ? 'LGPL-2.0' : 'LGPL-3.0')
  if (any(TXT.gpl)) {
    const m = /(?:Version|either\s+version)\s+([23])\b/i.exec(t)
    out.add(m && m[1] === '2' ? 'GPL-2.0' : 'GPL-3.0')
  }
  if (TXT.mpl.test(t)) out.add('MPL-2.0')
  if (TXT.epl.test(t)) out.add('EPL-2.0')
  if (TXT.apache.test(t)) out.add('Apache-2.0')
  if (TXT.boost.test(t)) out.add('BSL-1.0')
  if (TXT.ccBySa.test(t)) out.add('CC-BY-SA-4.0')
  else if (TXT.ccBy.test(t)) out.add('CC-BY-4.0')
  if (TXT.mit.test(t)) out.add('MIT')
  if (TXT.isc.test(t)) out.add(TXT.iscNotice.test(t) ? 'ISC' : '0BSD')
  if (TXT.bsd.test(t)) out.add(TXT.bsd3.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause')
  if (TXT.unlicense.test(t)) out.add('Unlicense')
  if (TXT.cc0.test(t)) out.add('CC0-1.0')
  if (out.size) return { ids: [...out], expr: [...out].join(' AND ') }

  if (t.trim().length <= 300) {
    // a short pointer file: 'MIT', 'MIT OR Apache-2.0', 'SPDX-License-Identifier: Apache-2.0'
    const expr = spdxHeader(t) ?? canonicalExpr(t.trim())
    if (exprTier(expr) !== 'unknown') return { ids: exprIds(expr), expr }
  }
  if (TXT.reserved.test(t)) return { ids: ['LicenseRef-All-Rights-Reserved'], expr: 'LicenseRef-All-Rights-Reserved' }
  return { ids: [], expr: null }
}

/**
 * SPDX ids recognised in the text of a license file (a file may hold several, e.g. MIT with an
 * LGPL portion, or a dual-license notice). Empty when nothing is recognised.
 */
export function detectLicenseText(text: string): string[] {
  return detect(text).ids
}

/** SPDX expression of one license file, or null when it is not recognised. */
export function detectLicenseExpr(text: string): string | null {
  return detect(text).expr
}

export interface LicenseFileFound {
  /** Basename of the license file (LICENSE, LICENSE-MIT, COPYING, …). */
  name: string
  /** detectLicenseExpr of its text (null = not recognised). */
  expr: string | null
}

const wrap = (e: string) => (/\s/.test(e) ? `(${e})` : e)

/**
 * Expression for the license files of one directory: several alternative files (LICENSE-MIT +
 * LICENSE-APACHE) are a choice (OR); anything else applies together (AND). 'NOASSERTION' when
 * license files exist but none is recognised; null when there are none.
 */
export function combineLicenseFiles(files: LicenseFileFound[]): string | null {
  if (!files.length) return null
  const known = files.filter((f): f is { name: string; expr: string } => f.expr !== null)
  if (!known.length) return 'NOASSERTION'
  const exprs = [...new Set(known.map((f) => f.expr))]
  if (exprs.length === 1) return exprs[0]
  const alt = known.length >= 2 && known.every((f) => isAlternativeLicenseFile(f.name))
  return exprs.map(wrap).join(alt ? ' OR ' : ' AND ')
}

/** Does any license id of `declared` appear among `found` (versions compared without -only / -or-later)? */
export function licenseMatches(declared: string, found: string[]): boolean {
  const have = new Set(found.map(baseId))
  return exprIds(declared).some((id) => have.has(baseId(id)))
}

const PLACEHOLDER = /^\s*(?:|NOASSERTION|NONE|UNKNOWN|OTHER)\s*$/i

/**
 * The license recorded for a repository: what its root license file(s) at the fetched commit say,
 * falling back to the allowlist entry ("none" without any license file, "NOASSERTION" when the file
 * is not recognised). A disagreement with the allowlist is reported in `note`.
 */
export function resolveRepoLicense(declared: string, rootFiles: LicenseFileFound[]): { license: string; note?: string } {
  const decl = (declared ?? '').trim()
  const found = combineLicenseFiles(rootFiles)
  if (found === null) return { license: PLACEHOLDER.test(decl) ? 'none' : canonicalExpr(decl) }
  if (found === 'NOASSERTION') return { license: PLACEHOLDER.test(decl) ? 'NOASSERTION' : canonicalExpr(decl) }
  if (PLACEHOLDER.test(decl)) return { license: found }
  const ids = rootFiles.flatMap((f) => (f.expr ? exprIds(f.expr) : []))
  if (licenseMatches(decl, ids)) return { license: canonicalExpr(decl) }
  return { license: found, note: `LICENSE file reads ${found}; allowlist lists ${decl}` }
}

// ─── machine-learning prohibitions ──────────────────────────────────────────

const ML = String.raw`(?:AI|ML|LLMs?|machine[\s-]+learning|artificial[\s-]+intelligence|neural[\s-]+networks?|(?:large\s+)?language\s+models?|generative\s+models?)`
const AI_FORBID: RegExp[] = [
  // "may not be used to train …", "shall not be used for (the purpose of) training / machine learning"
  new RegExp(
    String.raw`\b(?:may|must|shall|will|can)\s*not\s+(?:be\s+)?(?:used|reproduced|copied|included|ingested|incorporated|scraped)\b[^.]{0,80}?\b(?:to\s+train\b|for\s+(?:the\s+)?(?:purposes?\s+of\s+)?(?:training\b|${ML}\b)|as\s+training\s+data|in\s+(?:any\s+)?training\s+(?:data|sets?|corpus))`,
    'i',
  ),
  // "AI training is prohibited", "use for machine learning training is not permitted"
  new RegExp(String.raw`\b${ML}\b[^.]{0,40}?\btraining\b[^.]{0,60}?\b(?:is|are)\s+(?:strictly\s+|expressly\s+)?(?:prohibited|forbidden|not\s+(?:permitted|allowed))`, 'i'),
  // "prohibits … training … AI models", "you are not permitted to train machine-learning models"
  new RegExp(String.raw`\b(?:prohibit(?:s|ed)?|forbid(?:s|den)?|not\s+permitted|not\s+allowed|no\s+permission)\b[^.]{0,60}?\btrain(?:ing)?\b[^.]{0,40}?\b${ML}`, 'i'),
  new RegExp(String.raw`\bno\s+${ML}\s+training\b`, 'i'),
]

/** The sentence of a license / README that forbids machine-learning use, or null. */
export function forbidsMachineLearning(text: string): string | null {
  const t = text.length > 400_000 ? text.slice(0, 400_000) : text
  for (const re of AI_FORBID) {
    const m = re.exec(t)
    if (m) return m[0].replace(/\s+/g, ' ').trim().slice(0, 120)
  }
  return null
}
