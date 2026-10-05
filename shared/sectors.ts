// The eight arms of LUSCA. Each arm owns one sector of the crypto web.
// Seeds are server-rendered, crawler-friendly pages; host rules map any URL to an arm.

export interface Sector {
  id: number;
  roman: string;
  key: string;
  name: string;
  blurb: string;
  seeds: string[];
  hostRules: RegExp[];   // first sector whose rule matches a host wins
  prior: number;         // base relevance prior for hosts in this sector (0..1)
}

export const SECTORS: Sector[] = [
  {
    id: 0, roman: 'I', key: 'governance', name: 'Governance',
    blurb: 'DAO forums, delegate threads, votes and temp checks.',
    seeds: [
      'https://gov.uniswap.org/latest',
      'https://governance.aave.com/latest',
      'https://forum.arbitrum.foundation/latest',
      'https://gov.optimism.io/latest',
      'https://research.lido.fi/latest',
      'https://dao.rocketpool.net/latest',
      'https://forum.balancer.fi/latest',
      'https://www.comp.xyz/latest',
    ],
    hostRules: [/^(gov|governance|dao|forum|vote|snapshot)\./, /^research\.lido\.fi$/, /^www\.comp\.xyz$/, /forum/],
    prior: 0.85,
  },
  {
    id: 1, roman: 'II', key: 'research', name: 'Research',
    blurb: 'Protocol research, cryptography and long-form essays.',
    seeds: [
      'https://ethresear.ch/latest',
      'https://ethereum-magicians.org/latest',
      'https://vitalik.eth.limo/',
      'https://www.paradigm.xyz/writing',
      'https://a16zcrypto.com/posts/',
      'https://writings.flashbots.net/',
    ],
    hostRules: [/^ethresear\.ch$/, /^ethereum-magicians\.org$/, /^vitalik\.eth\.limo$/, /paradigm\.xyz$/, /a16zcrypto\.com$/, /flashbots\.net$/, /^eprint\.iacr\.org$/, /research/],
    prior: 0.9,
  },
  {
    id: 2, roman: 'III', key: 'docs', name: 'Docs',
    blurb: 'Developer documentation for chains, oracles and protocols.',
    seeds: [
      'https://docs.chain.link/',
      'https://docs.uniswap.org/',
      'https://ethereum.org/en/developers/docs/',
      'https://docs.arbitrum.io/',
      'https://docs.optimism.io/',
      'https://docs.soliditylang.org/en/latest/',
      'https://book.getfoundry.sh/',
      'https://solana.com/docs',
    ],
    hostRules: [/^docs\./, /^book\./, /^developers?\./, /^learn\./, /^wiki\./],
    prior: 0.8,
  },
  {
    id: 3, roman: 'IV', key: 'standards', name: 'Standards',
    blurb: 'EIPs, ERCs, BIPs and consensus specifications.',
    seeds: [
      'https://eips.ethereum.org/all',
      'https://ercs.ethereum.org/all',
      'https://bips.dev/',
    ],
    hostRules: [/^eips\.ethereum\.org$/, /^ercs\.ethereum\.org$/, /^bips\.dev$/, /^ethereum\.github\.io$/],
    prior: 0.9,
  },
  {
    id: 4, roman: 'V', key: 'markets', name: 'Markets',
    blurb: 'L2 risk, TVL, treasuries and on-chain data.',
    seeds: [
      'https://l2beat.com/scaling/summary',
      'https://defillama.com/',
      'https://bitcointreasuries.net/',
    ],
    hostRules: [/l2beat\.com$/, /defillama\.com$/, /bitcointreasuries\.net$/, /growthepie/, /ultrasound\.money$/, /dune\.com$/],
    prior: 0.7,
  },
  {
    id: 5, roman: 'VI', key: 'codex', name: 'Codex',
    blurb: 'Wikis and primers — the encyclopedic layer.',
    seeds: [
      'https://en.wikipedia.org/wiki/Cryptocurrency',
      'https://en.wikipedia.org/wiki/Ethereum',
      'https://en.wikipedia.org/wiki/Bitcoin',
      'https://en.bitcoin.it/wiki/Main_Page',
      'https://ethereum.org/en/learn/',
    ],
    hostRules: [/wikipedia\.org$/, /^en\.bitcoin\.it$/, /^ethereum\.org$/, /^bitcoin\.org$/, /^solana\.com$/],
    prior: 0.6,
  },
  {
    id: 6, roman: 'VII', key: 'security', name: 'Security',
    blurb: 'Exploits, audits, post-mortems and incident reports.',
    seeds: [
      'https://rekt.news/',
      'https://blog.trailofbits.com/',
      'https://samczsun.com/',
      'https://blog.sigmaprime.io/',
    ],
    hostRules: [/rekt\.news$/, /trailofbits\.com$/, /samczsun\.com$/, /sigmaprime\.io$/, /openzeppelin\.com$/, /immunefi\.com$/, /certik\.com$/, /security|audit/],
    prior: 0.85,
  },
  {
    id: 7, roman: 'VIII', key: 'chronicle', name: 'Chronicle',
    blurb: 'Core-dev blogs, newsletters and release notes.',
    seeds: [
      'https://blog.ethereum.org/',
      'https://bitcoinops.org/en/newsletters/',
      'https://weekinethereumnews.com/',
      'https://solana.com/news',
    ],
    hostRules: [/^blog\./, /newsletter|news/, /^bitcoinops\.org$/, /weekinethereumnews\.com$/, /substack\.com$/, /mirror\.xyz$/, /medium\.com$/],
    prior: 0.7,
  },
];

/** Map a hostname to an arm. Falls back to `fallback` (usually the linking page's sector). */
export function sectorForHost(host: string, fallback = 5): number {
  const h = host.toLowerCase();
  // exact-ish rules first (all non-generic), then the generic substring rules in order
  for (const s of SECTORS) for (const r of s.hostRules) if (r.test(h)) return s.id;
  return fallback;
}

/** Handles for agents — dark-water vocabulary. */
export const AGENT_NAMES = [
  'vesper', 'umbra', 'fathom', 'silt', 'brine', 'murk', 'drift', 'lumen',
  'trench', 'eddy', 'shoal', 'swell', 'tide', 'kelp', 'reef', 'coral',
  'nox', 'abyss', 'marrow', 'cinder', 'glint', 'hush', 'quill', 'rime',
  'sable', 'tallow', 'vellum', 'wisp', 'yarrow', 'zephyr', 'argo', 'bathys',
  'cirrus', 'delta', 'ember', 'flint', 'gyre', 'haze', 'inkwell', 'jetsam',
  'krill', 'lantern', 'mire', 'nadir', 'onyx', 'pelagic', 'quartz', 'riptide',
];

export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

export function agentCode(sector: number, slot: number): string {
  return `${ROMAN[sector]}·${String(slot + 1).padStart(2, '0')}`;
}
