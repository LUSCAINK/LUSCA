import { Link } from 'react-router-dom'
import { ArchDiagram } from '../ArchDiagram'
import { CRAWL, HUB, MODEL } from '../facts'
import { C, Callout, H3, Table } from '../ui'

export function Architecture() {
  return (
    <>
      <p className="dlead">
        One Node process hosts four modules that never call each other’s internals. They are wired together in <C>server/index.ts</C> against the
        interfaces in <C>server/contracts.ts</C>; every module receives the same <C>emit()</C> and the hub turns emits into WebSocket frames.
      </p>

      <ArchDiagram />

      <H3 id="architecture-path" n="2.1">
        The data path
      </H3>
      <ol className="dsteps">
        <li>
          <b>A → W.</b> An agent picks the highest-priority URL whose host is ready right now, preferring its own arm and stealing from the others when
          its arm is empty or cooling. It fetches under the politeness rules in <Link to="/docs/ethics">04 · fetch policy</Link>.
        </li>
        <li>
          <b>A.</b> The page is parsed, tasted, deduped. Outlinks are scored and pushed into the frontier whether or not the page itself is kept, unless
          the page says <C>nofollow</C>.
        </li>
        <li>
          <b>A → D, T.</b> An accepted page is appended to <C>dataset.jsonl</C> and its cleaned text goes to the trainer via <C>onText()</C>. A
          256-dim vector is kept in memory for the newest {CRAWL.memoryPages.toLocaleString('en-US')} pages.
        </li>
        <li>
          <b>E ⇄ N.</b> The coordinator builds cosine-similarity jobs from those vectors, sends each to one neuron, re-computes random rows on the CPU,
          credits INK and reports verified duplicates back to the ingest pipeline.
        </li>
        <li>
          <b>A, T, E → H → K.</b> Every event is serialized once and written to every connected socket. Clients reconstruct the whole system from the{' '}
          <C>hello</C> snapshot plus the event stream.
        </li>
        <li>
          <b>P → K.</b> The payout engine broadcasts <C>{"{ t: 'payout' }"}</C> when a period closes or a transfer confirms.
        </li>
      </ol>

      <H3 id="architecture-modules" n="2.2">
        Modules
      </H3>
      <Table label="Server modules">
        <thead>
          <tr>
            <th>module</th>
            <th>entry</th>
            <th>owns</th>
            <th>emits</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="mono strong">agents</td>
            <td className="mono small">createIngest()</td>
            <td>agents, frontier, host politeness, robots cache, SimHash index, page vectors, dataset writer</td>
            <td className="mono small">agent trace page reject discover domain</td>
          </tr>
          <tr>
            <td className="mono strong">trainer</td>
            <td className="mono small">createTrainer()</td>
            <td>a worker thread with the model, optimizer and corpus; checkpointing; generation</td>
            <td className="mono small">loss sample</td>
          </tr>
          <tr>
            <td className="mono strong">coordinator</td>
            <td className="mono small">createCoordinator()</td>
            <td>neuron registry, job issue and verification, INK ledger</td>
            <td className="mono small">neurons ink job neuron.ok error</td>
          </tr>
          <tr>
            <td className="mono strong">hub</td>
            <td className="mono small">createHub()</td>
            <td>REST routes, the <C>/ws</C> socket, static hosting of <C>dist/</C>, rate limits, back-pressure</td>
            <td className="mono small">hello stats</td>
          </tr>
        </tbody>
      </Table>
      <p>
        The trainer runs in <C>worker_threads</C> so backprop never blocks the agents’ event loop. It uses at most {Math.round(MODEL.duty * 100)}% of
        one core, training in {MODEL.chunkMs} ms chunks and yielding between them.
      </p>

      <H3 id="architecture-fanout" n="2.3">
        Fan-out and back-pressure
      </H3>
      <ul className="dlist">
        <li>
          Each broadcast is <C>JSON.stringify</C>-ed once and written to every socket. <C>stats</C> goes out every {HUB.statsMs / 1000} s while any client
          is connected.
        </li>
        <li>
          When a client’s send buffer exceeds {HUB.softBufferMB} MB, non-essential frames (<C>trace</C>, <C>agent</C>, <C>discover</C>, <C>reject</C>)
          are skipped for that client. Above {HUB.hardBufferMB} MB the socket is terminated.
        </li>
        <li>
          Server pings every {HUB.heartbeatS} s; a client that has not answered by the next ping is dropped.
        </li>
        <li>
          Limits: {HUB.maxClients.toLocaleString('en-US')} sockets total, {HUB.maxClientsPerIp} per IP, {HUB.wsMaxPayloadMB} MB per inbound frame,{' '}
          {HUB.msgRate} inbound messages/s sustained (burst {HUB.msgBurst}). A client far past the burst is closed with code 1008.
        </li>
        <li>
          <C>job</C> and <C>neuron.ok</C> are never broadcast; they go only to the neuron they concern.
        </li>
      </ul>

      <H3 id="architecture-restart" n="2.4">
        Persistence and restart
      </H3>
      <p>
        On boot the ingest pipeline re-reads <C>dataset.jsonl</C> and rebuilds its id set, content hashes, SimHash index and page vectors, so nothing already
        stored is fetched or stored twice. The trainer restores <C>sepia.ckpt</C> if the architecture matches and re-feeds the last{' '}
        {MODEL.reloadTailMB} MB of the dataset into its corpus. The coordinator restores <C>ledger.json</C>. The frontier itself is not persisted: it is
        rebuilt from the seeds, which are also re-queued every {CRAWL.reseedMin} minutes.
      </p>

      <H3 id="architecture-offline" n="2.5">
        When the server is unreachable
      </H3>
      <p>
        The client opens <C>/ws</C> and, when the connection fails or drops, reconnects in the background with exponential backoff (2 → 16 s, with
        jitter). Until a <C>hello</C> arrives it shows the connection state and “—” in place of every number.
      </p>
      <Callout kind="note" title="labels">
        Every number on the site comes from the server, over <C>/ws</C> or REST. When none is reachable the status bar reads: Can’t reach the LUSCA
        server — reconnecting…. Nothing is estimated or animated in its place.
      </Callout>
    </>
  )
}
