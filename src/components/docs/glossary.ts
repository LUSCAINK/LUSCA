// Plain-language glossary — the exact definitions every page uses the first time a
// term appears (pagekit <Terms>) and the docs glossary leads with.
export type TermKey = 'agent' | 'arm' | 'taste' | 'sepia' | 'neuron' | 'tier' | 'ink'

export const TERMS: Record<TermKey, { term: string; def: string }> = {
  agent: { term: 'Agent', def: 'An automated process that fetches pages from crypto websites and decides which ones enter the corpus.' },
  arm: { term: 'Arm', def: 'One of 8 topic areas (governance, research, docs, standards, markets, wikis, security, news); each agent works one arm.' },
  taste: { term: 'Taste score', def: 'How relevant a page is to crypto, from 0 to 1. Pages under 0.35 are dropped.' },
  sepia: { term: 'SEPIA', def: 'An open character-level language model, trained live on the kept pages.' },
  neuron: { term: 'Neuron', def: 'A GPU or CPU connected to LUSCA, through a browser tab or the command-line client (scripts/neuron.ts).' },
  tier: { term: 'Tier', def: 'Your GPU’s class (EPI, MESO, BATHY, ABYSSO, HADAL), set by a 10-second benchmark. Deeper tier = bigger jobs + a bigger INK bonus.' },
  ink: { term: 'INK', def: 'Points for verified GPU work. Each payout period, the payout pool is split by INK and paid in SOL to verified wallets.' },
}

export const TERM_ORDER: TermKey[] = ['agent', 'arm', 'taste', 'sepia', 'neuron', 'tier', 'ink']
