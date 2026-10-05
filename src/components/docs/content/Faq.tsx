import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CRAWL, MODEL, NEURON } from '../facts'
import { C, H3 } from '../ui'
import { TERMS, TERM_ORDER } from '../glossary'

const FAQ: [string, ReactNode][] = [
  [
    'How do I start earning?',
    <>
      Open <Link to="/node">Start earning</Link> in a browser with WebGPU and follow the steps. LUSCA detects your GPU, runs a 10-second benchmark that
      sets your tier, then sends it jobs. Every job the server checks and accepts earns credits. No install, no account and no wallet are needed to earn credits; a wallet is only needed to
      receive SOL payouts.
    </>,
  ],
  [
    'Are the agents really fetching pages?',
    <>
      Yes. Every agent trace is a real HTTP request to a real host, and every stored page is in <C>dataset.jsonl</C> with its URL. Every number on the
      site comes from the server; when it cannot be reached the status bar says so and numbers show “—”.
    </>,
  ],
  [
    'Why an octopus?',
    <>
      Two-thirds of an octopus’s nerve cells are in its arms; each arm tastes and acts with little central control. That is the agent design: eight
      arms, independent loops, a thin coordinator. Lusca is the giant octopus of Bahamian blue-hole folklore.
    </>,
  ],
  [
    'Does it respect robots.txt?',
    <>
      Yes — fetched per origin before any page, cached {CRAWL.robotsTtlMin} minutes, re-checked on every cross-origin redirect, the robots.txt delay directive honored,
      meta robots and X-Robots-Tag honored. If robots.txt cannot be fetched (5xx, 429, timeout) the host is skipped for {CRAWL.robotsPauseMin} minutes
      rather than assumed open. Details in <Link to="/docs/ethics">04</Link>.
    </>,
  ],
  [
    'How do I keep it off my site?',
    <>
      <C>User-agent: LuscaBot</C> + <C>Disallow: /</C> in robots.txt. Effective within an hour on a running server.
    </>,
  ],
  [
    'Can I run it on a laptop?',
    <>
      Yes. Node 20+, no database, no GPU. The trainer is capped at {Math.round(MODEL.duty * 100)}% of one core; the agents are mostly network wait.
      Everything lands in <C>server/data</C>.
    </>,
  ],
  [
    'Can my laptop be a neuron?',
    <>
      Yes. Open <Link to="/node">Start earning</Link> in a browser with WebGPU. Integrated GPUs usually land in the EPI tier; without WebGPU the CPU
      fallback does the same jobs, slower. The loop pauses when the tab is hidden.
    </>,
  ],
  [
    'Is my wallet safe?',
    <>
      LUSCA asks for one thing: a signature over one plain-text sign-in message, which proves you control the address. It is not a transaction,
      costs nothing and moves no funds. LUSCA never asks for a transaction, a private key or a seed phrase. A wallet is only needed to receive SOL;
      earning credits needs none. See <Link to="/docs/economics">10.3</Link>.
    </>,
  ],
  [
    'What happens offline?',
    <>
      The site says “Can’t reach the LUSCA server — reconnecting…”, shows “—” for every number and reconnects in the background. A neuron does no
      work and earns nothing until the server is back.
    </>,
  ],
  [
    'Do I lose credits when I reload or close the page?',
    <>
      No. Credits are kept on the server’s ledger, not in the page: per verified wallet, otherwise per anonymous device id that this browser keeps in local
      storage. When <Link to="/node">Start earning</Link> opens, the earnings panel reads your saved total from the server; figures marked “this session”
      count only since the page loaded. Clearing this browser’s site data creates a new device id, and credits saved under the old one are no longer
      shown here; credits on a verified wallet show in any browser signed in with that wallet.
    </>,
  ],
  [
    'What does my GPU actually compute?',
    <>
      Mostly SEPIA-0 training: the forward and backward pass of the model on a batch of text the server picks, returning the gradient. The server
      checks it, fully recomputes a share of jobs and applies accepted gradients with Adam. The second job type is dedupe: cosine similarity
      between the newest page vectors and a block of the corpus — <C>2 · rows · cols · 256</C> FLOPs per job; matches ≥ {NEURON.dupThreshold} become
      duplicate flags.
    </>,
  ],
  [
    'Can I cheat?',
    <>
      Random, zero or partial answers fail the checks and three failures drop the neuron. Training credits stay pending until a full audit of your
      gradients passes; a failed audit forfeits all pending credits. Several weaker points are open and listed plainly in{' '}
      <Link to="/docs/neurons">08.8</Link>. Payouts go only to verified wallets and are split by confirmed credits, so extra wallets earn nothing extra.
    </>,
  ],
  [
    'How are credits paid out?',
    <>
      Credits are your share of the payout pool, earned by verified GPU work. Payouts are made in SOL: each payout period, the pool is split by confirmed credits and paid to verified wallets. Credits are not $INK and are never paid out as a token. No amount is
      guaranteed. Rules, treasury and history: <Link to="/docs/economics">10</Link> and <Link to="/earn">Rewards</Link>.
    </>,
  ],
  [
    'Why are SEPIA’s samples gibberish?',
    <>
      {MODEL.params.toLocaleString('en-US')} parameters and a {MODEL.ctx}-character memory. It learns spelling and vocabulary, not facts. Watching the
      gibberish improve is the point of SEPIA-0.
    </>,
  ],
  [
    'Does it render JavaScript?',
    <>
      No. It reads server-rendered HTML. Pages with fewer than {CRAWL.minWords} readable words are dropped as probably client-rendered, which is why the
      seeds are forum, docs and wiki pages.
    </>,
  ],
  [
    'Where is the data and can I use it?',
    <>
      <C>server/data/dataset.jsonl</C>, one JSON object per accepted page with its URL and host. You can read your own instance’s file. Reuse is subject
      to each source’s license — some sources forbid commercial use (<Link to="/docs/ethics">04.7</Link>).
    </>,
  ],
]

// Plain terms first (the same wording every page uses), then the technical vocabulary.
const PLAIN: [string, ReactNode][] = TERM_ORDER.map((k) => [TERMS[k].term, TERMS[k].def])

const TECHNICAL: [string, ReactNode][] = [
  ['zone', 'API field name for the tier (ZONES in shared/protocol.ts). Sets job size and the credit multiplier: +15% per tier.'],
  ['credit rate', '1 credit per 100 MFLOP of checked work, +15% per tier, at least 0.01 per accepted job.'],
  ['frontier', 'The queue of URLs to visit: one max-heap per host per arm, ordered by link priority, capped at 60,000.'],
  ['host prior', 'A fixed per-arm number (0.60–0.90) for seed hosts; 0.50 for admitted hosts. 25% of the taste score, 20% of link priority.'],
  ['mantle', 'The central process: hub, frontier, coordinator and ledger.'],
  ['spot-check', 'Re-computing 4 random rows of a dedupe result on the CPU before awarding credits.'],
  ['audit', 'The server recomputing a training gradient in full from the same weights and batch. Confirms pending credits, or forfeits them.'],
  ['pending credits', 'Credits from training jobs held until the next audit of that identity passes. It does not count toward payouts until then.'],
  ['simhash', 'A 64-bit fingerprint of a page’s word 3-shingles. Within 3 bits = near-duplicate.'],
  ['payout period', 'The interval (default 12 h, 00:00 and 12:00 UTC) after which the pool is split by confirmed period credits and paid in SOL.'],
  ['verified wallet', 'A wallet that signed the plain-text sign-in message. Only verified wallets receive SOL.'],
  ['treasury', 'The wallet that funds payouts, filled by creator fees from $INK trading (the owner’s token). Address and balance are on the Rewards page.'],
]

export function Faq() {
  return (
    <>
      <H3 id="faq-glossary" n="11.1">
        Glossary
      </H3>
      <p>The seven terms every page uses, in plain words:</p>
      <dl className="dgloss dgloss-plain">
        {PLAIN.map(([k, v]) => (
          <div className="dgloss-row" key={k}>
            <dt className="mono">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p>Technical vocabulary used in this manual and the code:</p>
      <dl className="dgloss">
        {TECHNICAL.map(([k, v]) => (
          <div className="dgloss-row" key={k}>
            <dt className="mono">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      <H3 id="faq-questions" n="11.2">
        Questions
      </H3>
      <dl className="dfaq">
        {FAQ.map(([q, a], i) => (
          <div className="dfaq-row" key={q}>
            <dt>
              <span className="num dfaq-n">Q{String(i + 1).padStart(2, '0')}</span>
              {q}
            </dt>
            <dd>{a}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}
