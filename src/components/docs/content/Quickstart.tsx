import { Link } from 'react-router-dom'
import { CRAWL, MODEL } from '../facts'
import { C, Callout, Code, H3, Table } from '../ui'

export function Quickstart() {
  return (
    <>
      <p className="dlead">
        Requires Node 20 or newer (tested on Node 24). No database, no GPU, no API keys. The server writes everything it learns to a single data
        directory.
      </p>

      <H3 id="quickstart-dev" n="1.1">
        Run it
      </H3>
      <Code title="terminal">{`npm install
npm run dev`}</Code>
      <p>
        <C>npm run dev</C> starts two processes with <C>concurrently</C>. Open <C>http://localhost:5173</C>. Agents start staggered over the first 6 s; each
        fetches a host’s robots.txt before its first page there, so the first accepted pages typically land within a minute. SEPIA waits for {MODEL.minChars.toLocaleString('en-US')}{' '}
        characters of accepted text before its first training step.
      </p>
      <Table label="Processes and ports">
        <thead>
          <tr>
            <th>process</th>
            <th className="r">port</th>
            <th>command</th>
            <th>what</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="mono strong">server</td>
            <td className="r num">8787</td>
            <td className="mono small">tsx watch server/index.ts</td>
            <td>data agents, SEPIA trainer (worker thread), neuron coordinator, payout engine, REST + WebSocket</td>
          </tr>
          <tr>
            <td className="mono strong">web</td>
            <td className="r num">5173</td>
            <td className="mono small">vite</td>
            <td>
              the app; proxies <C>/api</C> and <C>/ws</C> to <C>8787</C> (override the target with <C>LUSCA_API</C>)
            </td>
          </tr>
        </tbody>
      </Table>

      <H3 id="quickstart-prod" n="1.2">
        Single process
      </H3>
      <Code title="terminal">{`npm start            # vite build, then serve dist/ from the API server
# → http://localhost:8787`}</Code>
      <p>
        <C>npm start</C> builds the client and serves it from the same port as the API. Useful behind a reverse proxy; set{' '}
        <C>LUSCA_TRUST_PROXY=1</C> so rate limits key on <C>X-Forwarded-For</C>.
      </p>

      <H3 id="quickstart-env" n="1.3">
        Environment
      </H3>
      <Table label="Environment variables">
        <thead>
          <tr>
            <th>variable</th>
            <th>default</th>
            <th>range</th>
            <th>effect</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="mono strong">PORT</td>
            <td className="num">8787</td>
            <td className="num dim">0–65535</td>
            <td>API + WebSocket port.</td>
          </tr>
          <tr>
            <td className="mono strong">LUSCA_AGENTS</td>
            <td className="num">{CRAWL.defaultAgents}</td>
            <td className="num dim">1–{CRAWL.maxAgents}</td>
            <td>
              Genesis agents, dealt round-robin over the 8 arms (agent <i>i</i> → arm <i>i</i> mod 8). The env parser accepts up to 512; the agent pool
              clamps to {CRAWL.maxAgents}.
            </td>
          </tr>
          <tr>
            <td className="mono strong">LUSCA_PACE</td>
            <td className="num">1</td>
            <td className="num dim">0–20</td>
            <td>
              Multiplier on each state’s minimum on-screen dwell (seek 120 ms … error 400 ms) so humans can follow a sucker. <C>0</C> = full speed. It
              never shortens politeness intervals.
            </td>
          </tr>
          <tr>
            <td className="mono strong">LUSCA_DATA</td>
            <td className="mono">server/data</td>
            <td className="dim">path</td>
            <td>Dataset, ingest counters, model checkpoint, INK ledger, payout periods.</td>
          </tr>
          <tr>
            <td className="mono">HOST</td>
            <td className="dim">all interfaces</td>
            <td className="dim">address</td>
            <td>Bind address.</td>
          </tr>
          <tr>
            <td className="mono">LUSCA_CORS_ORIGINS</td>
            <td className="dim">—</td>
            <td className="dim">comma list</td>
            <td>Extra allowed origins (localhost origins are always allowed).</td>
          </tr>
        </tbody>
      </Table>
      <Code title="example">{`LUSCA_AGENTS=40 LUSCA_PACE=0 LUSCA_DATA=/var/lib/lusca npm start`}</Code>

      <H3 id="quickstart-data" n="1.4">
        What lands on disk
      </H3>
      <Table label="Files in the data directory">
        <thead>
          <tr>
            <th>file</th>
            <th>written by</th>
            <th>contents</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="mono strong">dataset.jsonl</td>
            <td className="mono small">agents</td>
            <td>
              One accepted page per line: <C>id url host title sector score tokens terms ts text</C> plus <C>simhash hash vec</C> for cheap reloads.
              Append-only.
            </td>
          </tr>
          <tr>
            <td className="mono strong">ingest-state.json</td>
            <td className="mono small">agents</td>
            <td>Counters that cannot be derived from the dataset (rejected, errors, dupes) and near-duplicate flags from GPU jobs. Saved every 30 s.</td>
          </tr>
          <tr>
            <td className="mono strong">sepia.ckpt</td>
            <td className="mono small">trainer</td>
            <td>Binary checkpoint: params, Adam moments, loss history. Every {MODEL.ckptEveryS} s and on shutdown.</td>
          </tr>
          <tr>
            <td className="mono strong">ledger.json</td>
            <td className="mono small">coordinator</td>
            <td>INK accounts (by verified wallet, device id or label), period INK and lifetime totals. Every 30 s, on shutdown and at each period close.</td>
          </tr>
        </tbody>
      </Table>

      <H3 id="quickstart-tools" n="1.5">
        Neurons, payouts, checks
      </H3>
      <Code title="payout engine (env)">{`LUSCA_PAYOUTS=off            # off (default) | dryrun | live
LUSCA_SOLANA_RPC=https://api.mainnet-beta.solana.com
LUSCA_TREASURY_SECRET=...    # treasury key; secret env only, never logged or written to disk
LUSCA_AUTH_SECRET=...        # session-token HMAC key (generated into the data dir when unset)
LUSCA_PAYOUT_EVERY_H=12  LUSCA_PAYOUT_SHARE=0.5  LUSCA_PAYOUT_RESERVE_SOL=0.05
LUSCA_PAYOUT_MAX_SOL=5   LUSCA_PAYOUT_MAX_WALLET_SOL=1  LUSCA_PAYOUT_MIN_SOL=0.001`}</Code>
      <p>
        <C>dryrun</C> plans and persists each period without signing or sending. Rules and status are served at <C>GET /api/payouts</C>; see{' '}
        <Link to="/docs/economics">10.2</Link>.
      </p>
      <Code title="command-line neuron · published build">{`curl -O https://lusca.ink/neuron.mjs
node neuron.mjs --label name --auth <token>                              # joins lusca.ink
node neuron.mjs --server ws://localhost:8787/ws --label name             # joins your local server`}</Code>
      <Code title="command-line neuron · from source">{`npx tsx scripts/neuron.ts --server ws://localhost:8787/ws --label name --auth <token>`}</Code>
      <p>
        A command-line neuron joins the same LUSCA server over the same socket as a browser neuron, with <C>kind: "desktop"</C>. It needs Node 20+ and
        nothing else. It computes SEPIA-0 training gradients on the CPU (batch 128) with the same code the server audits against (<C>shared/sepia</C>),
        also takes dedupe jobs, is verified the same way and earns by the same formula. INK is kept on the machine’s device account; a wallet receives INK only through a
        verified session (one signed message, <Link to="/docs/economics">10.3</Link>), so <C>--wallet</C> alone does not route INK to a wallet. To receive SOL, pass <C>--auth &lt;token&gt;</C> (a sign-in token from the
        Node page, signed in your browser wallet) or <C>--keypair &lt;file&gt;</C> (a dedicated payout-only keypair, never a wallet that holds
        funds; it signs the sign-in message locally).
      </p>
      <Code title="sanity checks">{`curl http://localhost:8787/api/health     # ok, uptime, clients, stats, model
npm run typecheck                          # client + server`}</Code>

      <Callout kind="note" title="stopping">
        <C>Ctrl+C</C> triggers a graceful shutdown: the hub closes sockets, agents finish their current step (≤ 15 s), the dataset is flushed, SEPIA
        writes a final checkpoint and the ledger is saved. A second <C>Ctrl+C</C> forces exit after a synchronous ledger flush.
      </Callout>
    </>
  )
}
