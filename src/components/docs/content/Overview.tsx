import { Link } from 'react-router-dom'
import { SECTORS } from '@shared/sectors'
import { fmtInt } from '@/lib/format'
import { CRAWL, MODEL } from '../facts'
import { C, Callout, H3, Table } from '../ui'

const MAP: [string, string, string, string][] = [
  ['8 arms', 'sectors', 'Eight slices of the crypto web, each with its own seed pages, host rules and relevance prior.', 'shared/sectors.ts'],
  ['agents', 'fetch loops', 'Autonomous fetch loops assigned to an arm. Every page an agent fetches is relevance-scored before it enters the corpus.', 'server/ingest/pipeline.ts'],
  ['mantle', 'coordinator + hub', 'The central process: frontier, politeness tables, neuron jobs, the credit ledger and the socket that fans events out.', 'server/index.ts · server/http.ts · server/neurons/'],
  ['ink · sepia', 'SEPIA', 'The language model trained on what the arms bring back. Sepia is cephalopod ink.', 'server/trainer/'],
  ['neurons', 'GPUs', 'Browser tabs (WebGPU) or command-line clients that do verifiable work for the data pipeline and earn credits.', 'src/lib/gpu/ · server/neurons/'],
  ['depth', 'tiers (zones)', 'GPU classes from a 10-second matmul benchmark, named after ocean layers: EPI · MESO · BATHY · ABYSSO · HADAL.', 'ZONES in shared/protocol.ts'],
]

type Status = 'live' | 'built' | 'next' | 'research'
const STATUS: [string, Status, string][] = [
  [`${CRAWL.defaultAgents} genesis agents (3 per arm) fetching live pages, robots.txt honored, identified as LuscaBot`, 'live', 'server/ingest'],
  ['Relevance scoring against a weighted lexicon, exact-hash and 64-bit SimHash dedupe', 'live', 'lexicon.ts · simhash.ts'],
  ['Append-only dataset with url + host provenance on every line', 'live', 'server/data/dataset.jsonl'],
  [`${MODEL.name}: a ${fmtInt(MODEL.params)}-parameter character MLP, trained continuously, checkpointed`, 'live', 'server/trainer · shared/sepia'],
  ['GPU training jobs: neurons compute SEPIA-0 gradients on server-picked batches; the server checks every result, fully recomputes a share, applies accepted gradients with Adam; credits pending until audited', 'live', 'src/lib/gpu/train · server/trainer'],
  ['WebGPU detection, GEMM benchmark, zone assignment, near-duplicate jobs, CPU spot-check, credit ledger', 'live', 'src/lib/gpu · server/neurons'],
  ['Wallet verification by one signed plain-text message; credits go to a wallet only with a valid session token', 'live', 'server/auth'],
  ['SOL payouts every period: pool split by confirmed credits among verified wallets, capped, persisted before sending; off until the treasury is funded (LUSCA_PAYOUTS)', 'built', 'server/payouts'],
  ['No server reachable: the client says so, shows “—” for every number and reconnects with backoff', 'live', 'src/lib/live.ts'],
  ['License-aware dataset export: exclude non-commercial hosts from commercial licenses', 'next', 'not built'],
  ['SEPIA-1: GPT-style decoder (~124M params) trained by BATHY+ neurons', 'next', 'not started'],
  ['Stronger verification: redundancy, canaries, proof-of-inference, attestation', 'research', 'design only'],
  ['SEPIA-2: decentralized, low-communication training (DiLoCo-style)', 'research', 'design only'],
]

export function Overview() {
  return (
    <>
      <p className="dlead">
        LUSCA is a set of data agents, a corpus, a language model and a compute network, running in one Node process you can start on a laptop. It reads a
        narrow slice of the public web — DAO forums, protocol research, developer docs, standards, market dashboards, wikis, security write-ups and
        core-dev news — keeps the pages that score as crypto-relevant, and trains a small model on them while you watch.
      </p>
      <p>
        Users can attach a GPU from a browser tab or a desktop program. It trains SEPIA: the server sends the current weights and a batch of text, the
        GPU computes the gradient, and the server checks it, recomputes a share of jobs in full and applies accepted gradients with Adam. It also runs
        near-duplicate search over hashed word vectors for the data pipeline. Checked work earns <b>credits</b>: your share of the payout pool; training credits are
        pending until an audit confirms them. Each payout period, the pool is split by confirmed credits and paid in SOL to verified
        wallets. Every fetch, score, rejection,
        training step and verdict is broadcast as it happens. The Live page animates nothing that did not happen.
      </p>

      <H3 id="overview-octopus" n="0.1">
        The octopus, mapped
      </H3>
      <p>
        Lusca is the giant octopus of Bahamian blue-hole legend. The metaphor is load-bearing: two-thirds of an octopus’s neurons sit in its arms, and
        each arm tastes, decides and grabs on its own. LUSCA’s agents work the same way — each one picks its next URL, fetches, scores and keeps or
        drops a page without asking a central planner.
      </p>
      <Table label="Octopus to system mapping">
        <thead>
          <tr>
            <th>creature</th>
            <th>system</th>
            <th>what it does</th>
            <th>code</th>
          </tr>
        </thead>
        <tbody>
          {MAP.map(([a, b, c, d]) => (
            <tr key={a}>
              <td className="mono strong">{a}</td>
              <td className="mono">{b}</td>
              <td>{c}</td>
              <td className="mono dim small">{d}</td>
            </tr>
          ))}
        </tbody>
      </Table>

      <H3 id="overview-status" n="0.2">
        Real today vs roadmap
      </H3>
      <p>
        “Live” below means the code exists in this repository and runs when you start the server. Everything else is labelled
        for what it is.
      </p>
      <Table label="Implementation status">
        <thead>
          <tr>
            <th>capability</th>
            <th>status</th>
            <th>where</th>
          </tr>
        </thead>
        <tbody>
          {STATUS.map(([what, st, where]) => (
            <tr key={what}>
              <td>{what}</td>
              <td>
                <span className={`tag ${st === 'live' ? 'hot' : st === 'next' || st === 'built' ? 'solid' : ''}`}>{st}</span>
              </td>
              <td className="mono dim small">{where}</td>
            </tr>
          ))}
        </tbody>
      </Table>

      <H3 id="overview-not" n="0.3">
        What it is not
      </H3>
      <ul className="dlist">
        <li>
          <b>Not a general web index.</b> It starts from {SECTORS.reduce((n, s) => n + s.seeds.length, 0)} seed pages on 8 arms and admits at most{' '}
          {CRAWL.maxAdmittedHosts} new hosts per process. It does not render JavaScript.
        </li>
        <li>
          <b>Not a useful assistant.</b> {MODEL.name} has {fmtInt(MODEL.params)} parameters and a {MODEL.ctx}-character memory. It produces
          crypto-flavoured babble. That is the honest output of a model this size.
        </li>
        <li>
          <b>Credits are not a token.</b> They are a number in <C>ledger.json</C> on the operator’s server, separate from the $INK token. They are not transferable, not a security and carry no guaranteed
          amount. See <Link to="/docs/economics">10 · economics</Link>.
        </li>
        <li>
          <b>Not decentralized yet.</b> One coordinator issues jobs, verifies results and keeps the ledger. Users trust that operator.
        </li>
      </ul>

      <Callout kind="honest">
        SEPIA-0 exists to prove the loop closes in public — fetch → clean → train → sample, continuously, with the loss curve on screen. It is not the
        product. The dataset and the verification machinery are.
      </Callout>
    </>
  )
}
