import { Link } from 'react-router-dom'
import { CRAWL, minRateFor } from '../facts'
import { C, Callout, Formula, H3, Src, Table } from '../ui'

const TIERS: [string, string, string][] = [
  ['1.3 – 1.5', 'unambiguous technical vocabulary', 'danksharding, reentrancy, zk-snark, mev-boost, taproot, impermanent loss, temp check'],
  ['0.9 – 1.2', 'strong crypto words', 'evm, mempool, calldata, dex, stablecoin, staking, finality'],
  ['0.5 – 0.8', 'crypto-leaning but polysemous', 'validator, liquidity, wallet, governance, quorum, audit'],
  ['0.2 – 0.4', 'generic — only count in aggregate', 'gas, block, token, bridge, mining, proposal, vote, oracle'],
]

const STD: [string, string][] = [
  ['EIP-n', '1.3'],
  ['ERC-n · BIP-n · SIMD-n', '1.2'],
  ['AIP-n', '0.9'],
  ['RIP-n', '0.8'],
  ['CIP-n', '0.6'],
  ['SIP-n', '0.5'],
]

// Worked example A — computed by running taste() on the text described.
const EX_A: [string, number, number][] = [
  ['temp check', 1, 1.3],
  ['dao treasury', 1, 1.3],
  ['grants program', 1, 1.3],
  ['voting power', 1, 1.3],
  ['token holders', 1, 1.3],
  ['onchain vote', 1, 1.3],
  ['timelock', 1, 1.3],
  ['proposal', 2, 0.4],
  ['delegate', 2, 0.4],
  ['quorum', 1, 0.6],
]

const PENALTIES: [string, string, string][] = [
  ['auth', '0.40', '/login /signin /signup /register /session /logout /auth'],
  ['search', '0.35', '/search, or ?q= ?query= ?search= ?s='],
  ['feed', '0.35', '/feed /rss /atom, *.rss'],
  ['print view', '0.30', '/print, ?print='],
  ['user page', '0.25', '/u/ /user/ /users/ /member(s)/ /profile(s)/ /author/'],
  ['tag page', '0.20', '/tag /tags'],
  ['deep pagination', '0.20', '?page=n or /page/n with n > 3'],
  ['boilerplate', '0.20', '/privacy /terms /cookies /legal /careers /jobs /contact /press /brand /imprint'],
  ['sorted view', '0.15', '?sort= ?order= ?orderby= ?filter='],
  ['archive index', '0.10', '/YYYY/MM, /archive(s)'],
]

const PRIORS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9]

export function Taste() {
  const sumA = EX_A.reduce((s, [, n, w]) => s + n * w, 0)
  return (
    <>
      <p className="dlead">
        Octopus suckers carry chemoreceptors: the arm tastes before it grabs. Every fetched page gets a crypto-relevance score in [0, 1]. Below{' '}
        {CRAWL.acceptScore.toFixed(2)} it is spat out. The score is a closed-form function of lexicon hits and the host prior — no model, no network
        call, deterministic, and printed in every taste trace.
      </p>

      <H3 id="taste-lexicon" n="5.1">
        The lexicon
      </H3>
      <p>
        {CRAWL.lexiconEntries} weighted entries (singular and plural forms counted separately), grouped by domain: core, bitcoin, ethereum, L2,
        cryptography, consensus, other chains, DeFi, MEV, governance, security, wallets, markets, tooling. Weights follow four tiers:
      </p>
      <Table label="Lexicon weight tiers">
        <thead>
          <tr>
            <th className="r">weight</th>
            <th>tier</th>
            <th>examples</th>
          </tr>
        </thead>
        <tbody>
          {TIERS.map(([w, t, e]) => (
            <tr key={w}>
              <td className="r num strong">{w}</td>
              <td>{t}</td>
              <td className="mono small">{e}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <ul className="dlist">
        <li>
          <b>Tokenization.</b> Lowercase, split on every non-alphanumeric character: <C>zk-SNARK</C>, <C>zk snark</C> and <C>ZK–SNARK</C> are all{' '}
          <C>[zk, snark]</C>. At most 40,000 tokens per page are scanned.
        </li>
        <li>
          <b>Longest match first.</b> Phrases of up to 5 tokens; <C>proof of stake</C> is one hit, not also <C>stake</C>.
        </li>
        <li>
          <b>Plural folding.</b> A trailing <C>s</C> folds onto the singular entry (<C>rollups → rollup</C>); plural entries are reported under the
          singular label.
        </li>
        <li>
          <b>Numbered standards</b> match as one term in fused or spaced form (<C>EIP-4844</C>, <C>eip4844</C>, <C>ERC 20</C>):{' '}
          {STD.map(([k, w], i) => (
            <span key={k}>
              <C>{k}</C> {w}
              {i < STD.length - 1 ? ' · ' : ''}
            </span>
          ))}
          . The fused form (<C>eip4844</C>) is recognized for EIP, ERC, BIP and SIMD only.
        </li>
      </ul>
      <Src path="server/ingest/lexicon.ts" />

      <H3 id="taste-formula" n="5.2">
        The score
      </H3>
      <Formula
        label="taste(text, hostPrior) — server/ingest/lexicon.ts"
        rows={[
          ['cap', 'max(4, words / 250)', 'per-term count cap'],
          ['weighted', 'Σ weight(t) · min(count(t), cap)', 'over matched terms t'],
          ['per1000', 'weighted / words · 1000', 'weighted hits per 1000 words'],
          ['lengthDamp', 'min(1, words / 150)', 'short pages damped'],
          ['diversity', 'min(1, distinctTerms / 3)', 'fewer than 3 terms damped'],
          ['r', 'per1000 · lengthDamp · diversity', ''],
          ['score', 'clamp₀₁( 0.75 · (1 − e^(−r / 9)) + 0.25 · hostPrior )', ''],
        ]}
      />
      <p>
        <C>hostPrior</C> is the arm prior (0.60–0.90) for seed hosts and <C>0.50</C> for every admitted host. The saturating exponential means the
        first few hits per thousand words matter most: at <C>r = 9</C> the lexicon half already contributes 0.47 of its 0.75; past <C>r ≈ 30</C> it is
        flat. The per-term cap stops one repeated word from carrying a page.
      </p>

      <H3 id="taste-gates" n="5.3">
        Acceptance gates
      </H3>
      <p>Checked in this order after parsing; the first failure rejects the page with that reason in the trace.</p>
      <Table label="Acceptance gates">
        <thead>
          <tr>
            <th className="r">#</th>
            <th>gate</th>
            <th>reject when</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="r num">1</td>
            <td className="strong">noindex</td>
            <td>meta robots / luscabot or X-Robots-Tag says noindex or none</td>
          </tr>
          <tr>
            <td className="r num">2</td>
            <td className="strong">readable text</td>
            <td>fewer than {CRAWL.minWords} words after boilerplate removal</td>
          </tr>
          <tr>
            <td className="r num">3</td>
            <td className="strong hot">taste</td>
            <td>
              score &lt; <span className="num">{CRAWL.acceptScore.toFixed(2)}</span>
            </td>
          </tr>
          <tr>
            <td className="r num">4</td>
            <td className="strong">substance</td>
            <td>
              fewer than {CRAWL.minTokens} tokens (o200k_base via <C>gpt-tokenizer</C>, over the first {CRAWL.maxTextChars.toLocaleString('en-US')}{' '}
              characters)
            </td>
          </tr>
          <tr>
            <td className="r num">5</td>
            <td className="strong">dedupe</td>
            <td>
              revisit, exact duplicate or SimHash near-duplicate — see <Link to="/docs/dedupe">06 · dedupe</Link>
            </td>
          </tr>
        </tbody>
      </Table>
      <p>
        Trace labels: <C>strong</C> ≥ 0.75 · <C>good</C> ≥ 0.55 · <C>fair</C> ≥ 0.35 · <C>weak</C> below. Links are harvested from a page even when the
        page itself is rejected.
      </p>
      <p>Because the prior alone contributes 0.25 × prior, the lexicon half has to supply the rest. Minimum effective rate <C>r</C> to pass:</p>
      <Table label="Minimum lexicon rate to clear the threshold" className="dt-compact">
        <thead>
          <tr>
            <th>host prior</th>
            {PRIORS.map((p) => (
              <th key={p} className="r">
                {p.toFixed(2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>score with zero hits</td>
            {PRIORS.map((p) => (
              <td key={p} className="r num">
                {(0.25 * p).toFixed(3)}
              </td>
            ))}
          </tr>
          <tr>
            <td>min r to reach {CRAWL.acceptScore.toFixed(2)}</td>
            {PRIORS.map((p) => (
              <td key={p} className="r num strong">
                {minRateFor(p).toFixed(2)}
              </td>
            ))}
          </tr>
        </tbody>
      </Table>

      <H3 id="taste-example" n="5.4">
        Worked example
      </H3>
      <p>
        <b>A · a governance post.</b> 358 words on a governance seed host (prior 0.85). Ten distinct lexicon terms match; the per-term cap is{' '}
        max(4, 358/250) = 4, so nothing is capped.
      </p>
      <Table label="Worked example A, matched terms" className="dt-compact">
        <thead>
          <tr>
            <th>term</th>
            <th className="r">count</th>
            <th className="r">weight</th>
            <th className="r">contribution</th>
          </tr>
        </thead>
        <tbody>
          {EX_A.map(([t, n, w]) => (
            <tr key={t}>
              <td className="mono">{t}</td>
              <td className="r num">{n}</td>
              <td className="r num">{w.toFixed(1)}</td>
              <td className="r num">{(n * w).toFixed(1)}</td>
            </tr>
          ))}
          <tr className="dt-total">
            <td>weighted</td>
            <td />
            <td />
            <td className="r num strong">{sumA.toFixed(1)}</td>
          </tr>
        </tbody>
      </Table>
      <Formula
        label="example A"
        rows={[
          ['per1000', '11.3 / 358 · 1000', '31.56'],
          ['r', '31.56 · 1 · 1', 'lengthDamp 1 (≥ 150 words) · diversity 1 (10 terms)'],
          ['score', '0.75 · (1 − e^(−3.507)) + 0.25 · 0.85', '0.7275 + 0.2125 = 0.940 → strong, accepted'],
        ]}
      />
      <p>
        <b>B · an off-topic page.</b> 398 words on an admitted host (prior 0.50) that mention <C>mining</C> 5 times and <C>bridge</C> 3 times — say, a
        civil-engineering article. Both weigh 0.4; <C>mining</C> is capped at 4.
      </p>
      <Formula
        label="example B"
        rows={[
          ['weighted', '0.4 · min(5, 4) + 0.4 · 3', '2.8'],
          ['per1000', '2.8 / 398 · 1000', '7.04'],
          ['r', '7.04 · 1 · (2 / 3)', '4.69 — only two distinct terms'],
          ['score', '0.75 · (1 − e^(−0.521)) + 0.25 · 0.50', '0.305 + 0.125 = 0.430 → fair, accepted'],
        ]}
      />
      <Callout kind="honest" title="false positives">
        Example B passes. The diversity damp shrinks a two-word page’s lexicon contribution by a third, but the 0.125 baseline from the neutral prior
        leaves only 0.225 to find, and two generic words repeated a few times find it. Pages like this do reach the dataset today. Changes under
        consideration: require at least one term of weight ≥ 1.0, or a higher threshold for admitted hosts.
      </Callout>

      <H3 id="taste-frontier" n="5.5">
        Frontier priority
      </H3>
      <p>
        Every harvested link gets a priority from its anchor text, its URL path, the page it came from, the host prior and its depth. The frontier keeps
        one max-heap per host per arm; an agent pops the best URL among hosts that are ready right now.
      </p>
      <Formula
        label="enqueueLinks() — server/ingest/pipeline.ts"
        rows={[
          ['anchorW', 'hits(anchor text) + 0.6 · hits(path words)', 'each term counted once'],
          ['anchorScore', '1 − e^(−anchorW / 1.2)', ''],
          ['priority', 'clamp₀₁( 0.45·anchorScore + 0.25·parentScore + 0.20·hostPrior + 0.10/(1 + depth) − penalty )', ''],
        ]}
      />
      <ul className="dlist">
        <li>
          Admission: priority ≥ {CRAWL.knownHostMinPriority} for a known host, ≥ {CRAWL.newHostMinPriority} for a new one (plus the budget in{' '}
          <Link to="/docs/ethics">04.5</Link>). The {CRAWL.maxLinksPerPage} best links per page are kept.
        </li>
        <li>Seeds enter at priority 1.00 and are re-queued every {CRAWL.reseedMin} minutes so hub pages are revisited for new threads.</li>
        <li>
          <C>parentScore</C> is the linking page’s taste score, so a strong page lends priority to its outlinks even when they have bare anchors.
        </li>
      </ul>
      <Table label="Path penalties (summed, capped at 0.60)" className="dt-compact">
        <thead>
          <tr>
            <th>penalty</th>
            <th className="r">amount</th>
            <th>matches</th>
          </tr>
        </thead>
        <tbody>
          {PENALTIES.map(([k, a, m]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="r num strong">−{a}</td>
              <td className="mono small">{m}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p>
        <b>Example.</b> On an ethresear.ch page that tasted 0.82, a link with anchor <C>EIP-4844 blob fee market</C> pointing to{' '}
        <C>/t/eip-4844-blob-fees/123</C>, two hops from a seed:
      </p>
      <Formula
        label="priority example"
        rows={[
          ['hits(anchor)', 'eip-4844 1.3 + blob 0.6 + fee market 1.5', '3.4'],
          ['hits(path)', 'eip-4844 1.3 + blob 0.6', '1.9'],
          ['anchorW', '3.4 + 0.6 · 1.9', '4.54'],
          ['anchorScore', '1 − e^(−4.54 / 1.2)', '0.977'],
          ['priority', '0.45·0.977 + 0.25·0.82 + 0.20·0.90 + 0.10/3', '0.440 + 0.205 + 0.180 + 0.033 = 0.858'],
        ]}
      />
      <p>
        The trace for that pick reads <C>priority 0.86 — anchor 'EIP-4844 blob fee market' · parent 0.82 · host prior 0.90 · depth 2</C>.
      </p>
    </>
  )
}
