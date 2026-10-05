// The manual's index. Order = reading order; `n` is the printed section number.
export interface DocSectionMeta {
  n: string
  slug: string
  title: string
  kicker: string
}

export const DOC_SECTIONS: DocSectionMeta[] = [
  { n: '00', slug: 'overview', title: 'Overview', kicker: 'what lusca is · what runs today · what does not yet' },
  { n: '01', slug: 'quickstart', title: 'Run it yourself', kicker: 'for developers · clone, install, run — two processes' },
  { n: '02', slug: 'architecture', title: 'Architecture', kicker: 'one node process · four modules · one socket' },
  { n: '03', slug: 'arms', title: 'Arms', kicker: 'the 8 topic areas · seed pages · host priors' },
  { n: '04', slug: 'ethics', title: 'Fetch policy', kicker: 'robots.txt · politeness · opt-out · licenses' },
  { n: '05', slug: 'taste', title: 'Taste score', kicker: 'how relevance is scored, exactly as implemented' },
  { n: '06', slug: 'dedupe', title: 'Duplicates', kicker: 'exact hash · 64-bit simhash · gpu vector pass' },
  { n: '07', slug: 'sepia', title: 'SEPIA', kicker: 'the model the agents feed · honest about its size' },
  { n: '08', slug: 'neurons', title: 'Neurons & checking', kicker: 'webgpu → benchmark → tier → training & dedupe jobs → audit → credits' },
  { n: '09', slug: 'protocol', title: 'Protocol', kicker: 'websocket messages and rest routes' },
  { n: '10', slug: 'economics', title: 'Credits & SOL payouts', kicker: 'credits · payout rules · wallet verification · treasury' },
  { n: '11', slug: 'faq', title: 'Glossary & FAQ', kicker: 'every term in plain words · short answers' },
]

const SLUGS = new Set(DOC_SECTIONS.map((s) => s.slug))

export function isDocSlug(s: string | undefined): s is string {
  return !!s && SLUGS.has(s)
}

export const sectionId = (slug: string) => `docs-${slug}`
