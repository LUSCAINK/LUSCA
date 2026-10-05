import { Link } from 'react-router-dom'
import { HUB } from '../facts'
import { C, Callout, Code, H3, Src, Table } from '../ui'

type Row = [string, string, string, string]

const SERVER: Row[] = [
  ['hello', 'mode · serverTime · agents · stats · sectors · domains · recent (≤ 60) · traces (≤ 120) · loss · model · samples · neurons', 'on connect', 'that client'],
  ['agent', 'agent: AgentInfo', 'every agent state change', 'all · non-essential'],
  ['trace', 'trace: Trace', 'every agent decision', 'all · non-essential'],
  ['page', 'page: PageRecord', 'a page is stored', 'all'],
  ['reject', 'agentId · url · host · reason · score · ts', 'a page is dropped', 'all · non-essential'],
  ['discover', 'agentId · from · picks (≤ 6) · total · ts', 'after links are scored', 'all · non-essential'],
  ['domain', 'domain: DomainInfo', 'host counters change (≤ 1/s per host)', 'all'],
  ['stats', 'stats: Stats · sectors: SectorInfo[]', 'every 1 s', 'all'],
  ['loss', 'point: LossPoint · model: ModelInfo (incl. version, gpuSteps, serverSteps, gpuSamples, contributors24h, audits, gpuStepsPerMin)', 'every 25 training steps', 'all'],
  ['sample', 'step · text', 'every 600 training steps', 'all'],
  ['neurons', 'neurons: NeuronInfo[] (≤ 500)', 'on change (≤ 2/s) and every 5 s', 'all'],
  ['job', 'job: SimJob | TrainJob (discriminate on job.kind)', 'answer to job.request', 'the assigned neuron'],
  ['ink', 'event: InkEvent · kind: sim | train · status: confirmed | pending | forfeited', 'every verdict, pass or fail, and every escrow change', 'all'],
  ['neuron.ok', 'neuron: NeuronInfo · auth: verified | invalid | none', 'answer to neuron.register', 'that neuron'],
  ['payout', 'overview: PayoutsOverview', 'a payout period closes or a payout transaction confirms', 'all'],
  ['account', 'scope: wallet | device | null · account: AccountView | null · at', 'answer to account.watch, then whenever that ledger account or its escrow changes (≤ 1/s)', 'that client'],
  ['error', 'msg', 'a request could not be served', 'that client'],
]

const CLIENT: [string, string, string][] = [
  ['neuron.register', 'label · zone · gflops · kind · wallet · adapter · auth', 'join the pool (or update identity); auth = session token, the only way credits reach a wallet'],
  ['job.request', 'caps?: { train?: boolean, version?: number | null }', 'ask for one job; queued until a job is available. train: true = the neuron can take training jobs; version = the weights version it already holds (null = none)'],
  ['job.result', 'result: { id, best[], sim[] (cosine similarity), ms }', 'answer the outstanding dedupe job'],
  ['train.result', "result: { id, kind: 'train', grad (base64 encodeGrad), loss, ms }", 'answer the outstanding training job'],
  ['neuron.leave', '—', 'leave the pool; the socket stays open as a viewer'],
  ['account.watch', 'device: string | null · auth?: string | null', 'follow your own ledger account, no register needed: a valid session token (auth) → the wallet account, else the device id → the device account; one watch per socket, a new one replaces it'],
  ['ping', '—', 'accepted and ignored (keep-alive)'],
]

const REST: [string, string, string, string][] = [
  ['GET', '/api/hello', '—', 'Hello — the same snapshot the socket sends'],
  ['GET', '/api/health', '—', '{ ok, uptime, clients, stats, model, memory, node, ts }'],
  ['GET', '/api/stats', '—', '{ stats, sectors }'],
  ['GET', '/api/agents/:id/traces', 'n ≤ 200', 'Trace[] newest first'],
  ['GET', '/api/pages', 'sector 0–7 · q · n ≤ 200', 'PageRecord[] newest first; q matches title, url, terms, excerpt'],
  ['POST', '/api/generate', '{ prompt, n, temperature }', '{ text, ms } · 30/min/IP · 2 concurrent · 20 s timeout'],
  ['POST', '/api/spawn', '{ name, owner, sector }', 'AgentInfo · 1 per 10 s per IP · name 2–16 of [a-z0-9-]'],
  ['GET', '/api/ledger', 'wallet (optional)', '{ updatedAt, totals, leaderboard } or { wallet, account }'],
  ['GET', '/api/neurons', '—', 'NeuronInfo[]'],
  ['GET', '/api/auth/nonce', 'wallet', '{ nonce, message, expiresAt } · single-use nonce, 5 min TTL'],
  ['POST', '/api/auth/verify', '{ wallet, nonce, signature }', '{ token, wallet, expiresAt } · ed25519 over the exact message · 30-day token'],
  ['GET', '/api/payouts', '—', 'PayoutsOverview { mode, treasury, period, history, rules } · cached 5 s'],
  ['GET', '/api/payouts/wallet/:address', '—', 'WalletPayouts: periods paid with amounts and tx signatures, current-period credits and estimated share'],
]

export function Protocol() {
  return (
    <>
      <p className="dlead">
        One WebSocket at <C>/ws</C> carrying JSON text frames, plus a handful of REST routes under <C>/api</C>. The types live in{' '}
        <C>shared/protocol.ts</C> and are imported by both server and client, so the contract cannot drift silently.
      </p>

      <H3 id="protocol-server" n="9.1">
        Server → client
      </H3>
      <p>
        Every frame is an object with a discriminant <C>t</C>. A client that applies <C>hello</C> and then every following frame in order holds the same
        state the observatory renders. Frames marked non-essential are the first to be skipped for a slow client (<C>&gt; {HUB.softBufferMB} MB</C>{' '}
        buffered).
      </p>
      <Table label="ServerMsg">
        <thead>
          <tr>
            <th>t</th>
            <th>payload</th>
            <th>when</th>
            <th>to</th>
          </tr>
        </thead>
        <tbody>
          {SERVER.map(([t, p, w, to]) => (
            <tr key={t}>
              <td className="mono strong nowrap">{t}</td>
              <td className="mono small">{p}</td>
              <td>{w}</td>
              <td className="dim small">{to}</td>
            </tr>
          ))}
        </tbody>
      </Table>

      <H3 id="protocol-client" n="9.2">
        Client → server
      </H3>
      <p>
        Neurons send these; any page may also send <C>account.watch</C> to follow its own credits. Inbound frames are limited to{' '}
        {HUB.wsMaxPayloadMB} MB and {HUB.msgRate}/s sustained (burst {HUB.msgBurst}); binary frames and unknown types are ignored.
      </p>
      <Table label="ClientMsg">
        <thead>
          <tr>
            <th>t</th>
            <th>payload</th>
            <th>effect</th>
          </tr>
        </thead>
        <tbody>
          {CLIENT.map(([t, p, e]) => (
            <tr key={t}>
              <td className="mono strong nowrap">{t}</td>
              <td className="mono small">{p}</td>
              <td>{e}</td>
            </tr>
          ))}
        </tbody>
      </Table>

      <H3 id="protocol-rest" n="9.3">
        REST
      </H3>
      <Table label="REST routes">
        <thead>
          <tr>
            <th>method</th>
            <th>route</th>
            <th>input</th>
            <th>returns</th>
          </tr>
        </thead>
        <tbody>
          {REST.map(([m, r, i, o]) => (
            <tr key={r}>
              <td className={`mono strong ${m === 'POST' ? 'hot' : ''}`}>{m}</td>
              <td className="mono nowrap">{r}</td>
              <td className="mono small">{i}</td>
              <td className="small">{o}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p>
        JSON bodies are capped at {HUB.bodyLimitKB} KB. Errors come back as <C>{'{ "error": "…" }'}</C> with an HTTP status; rate limits answer 429
        with <C>Retry-After</C>. CORS allows
        localhost origins plus <C>LUSCA_CORS_ORIGINS</C>.
      </p>

      <H3 id="protocol-examples" n="9.4">
        Examples
      </H3>
      <Code lang="json" title="server → client · trace">{`{
  "t": "trace",
  "trace": {
    "agentId": 8,
    "ts": 1791115200000,
    "step": "taste",
    "msg": "tasted 0.94 — strong: temp check ×1, dao treasury ×1, grants program ×1",
    "data": { "score": 0.94, "hitsPer1000": 31.6, "words": 358, "tokens": 431, "terms": "temp check, dao treasury, grants program, voting power, token holders, onchain vote" }
  }
}`}</Code>
      <Code lang="json" title="server → client · page">{`{
  "t": "page",
  "page": {
    "id": "3f9c2a71e0b84d15",
    "url": "https://gov.uniswap.org/t/example-temp-check/12345",
    "host": "gov.uniswap.org",
    "title": "Temp check: example proposal",
    "sector": 0,
    "agentId": 8,
    "depth": 1,
    "score": 0.94,
    "tokens": 431,
    "bytes": 88213,
    "links": 143,
    "simhash": "9f3a51c2e07bc01e",
    "terms": ["temp check", "dao treasury", "grants program", "voting power", "token holders", "onchain vote"],
    "excerpt": "The delegate proposal passed the temp check. The DAO treasury will fund a grants program…",
    "ts": 1791115200412
  }
}`}</Code>
      <Code lang="json" title="client → server · neuron.register">{`{
  "t": "neuron.register",
  "label": "NVIDIA · ampere",
  "zone": "BATHY",
  "gflops": 2310.4,
  "kind": "browser",
  "wallet": null,
  "adapter": { "vendor": "nvidia", "architecture": "ampere", "deviceId": "web-3c9f0a1b2d4e5f60" }
}`}</Code>
      <Code lang="json" title="server → neuron · job (vectors truncated)">{`{
  "t": "job",
  "job": {
    "id": "j4f-1a2b3c",
    "kind": "simmatrix",
    "dim": 256,
    "rows": 64,
    "cols": 2048,
    "a": "zczMPQAAgD8K1yO9…",
    "b": "AACAPwrXIz3NzMw9…",
    "rowIds": ["3f9c2a71e0b84d15", "…"],
    "colIds": ["0b1e77c2d9a04f3e", "…"],
    "flops": 67108864,
    "issuedAt": 1791115201000
  }
}`}</Code>
      <p>
        <C>a</C> and <C>b</C> are base64 of little-endian <C>Float32Array</C>s, row-major: <C>rows × dim</C> and <C>cols × dim</C>.
      </p>
      <Code lang="json" title="neuron → server · job.request with training capability">{`{
  "t": "job.request",
  "caps": { "train": true, "version": 41873 }
}`}</Code>
      <Code lang="json" title="server → neuron · job (training; payloads truncated)">{`{
  "t": "job",
  "job": {
    "id": "t9c-4e1f07",
    "kind": "train",
    "version": 41874,
    "weights": "AFw/vAC4ADy…",
    "batch": 1024,
    "ctx": 16,
    "x": "VGhlIHZhbGlk…",
    "y": "ZXRoZXJldW0…",
    "flops": 1132462080,
    "issuedAt": 1791115260000
  }
}`}</Code>
      <p>
        <C>weights</C> is base64 of the model parameters as little-endian f16, in the layout of <C>SEPIA.layout</C> (<C>shared/sepia</C>); it is{' '}
        <C>null</C> when the neuron reported that it already holds <C>version</C>. <C>x</C> is base64 of a <C>Uint8Array</C> of <C>batch × ctx</C>{' '}
        character ids (row-major), <C>y</C> of <C>batch</C> next-character ids, both from <C>encodeChars</C>. <C>flops</C> is{' '}
        <C>trainFlops(batch)</C>, forward plus backward.
      </p>
      <Code lang="json" title="neuron → server · train.result (gradient truncated)">{`{
  "t": "train.result",
  "result": {
    "id": "t9c-4e1f07",
    "kind": "train",
    "grad": "AAAAPQrXozsAAIA7…",
    "loss": 2.3184,
    "ms": 41.7
  }
}`}</Code>
      <p>
        <C>grad</C> is base64 of <C>encodeGrad(g)</C>: a header of one f32 scale per layout tensor followed by each tensor as scaled f16, where{' '}
        <C>g</C> = d(mean cross-entropy over the batch)/d(params). <C>loss</C> is that mean cross-entropy. The server answers with an <C>ink</C>{' '}
        event whose <C>kind</C> is <C>train</C>; checks, audits and verdicts are described in <Link to="/docs/neurons">08.3</Link>.
      </p>
      <Code lang="json" title="neuron → server · job.result (arrays truncated)">{`{
  "t": "job.result",
  "result": {
    "id": "j4f-1a2b3c",
    "best": [812, 77, 1930],
    "sim": [0.6123, 0.9487, 0.441],
    "ms": 3.8
  }
}`}</Code>
      <Code lang="json" title="server → client · ink">{`{
  "t": "ink",
  "event": {
    "neuronId": "6f1d3c2a-9b7e-4f0a-8c55-2e4d1a0b9c7f",
    "jobId": "j4f-1a2b3c",
    "ink": 0.87,
    "verified": true,
    "reason": "verified 4/4 rows · 0.067 GFLOP · 4 ms",
    "ts": 1791115201006
  }
}`}</Code>
      <Code lang="json" title="server → client · ink (training, pending)">{`{
  "t": "ink",
  "event": {
    "neuronId": "6f1d3c2a-9b7e-4f0a-8c55-2e4d1a0b9c7f",
    "jobId": "t9c-4e1f07",
    "ink": 14.72,
    "verified": true,
    "kind": "train",
    "status": "pending",
    "reason": "applied · cosine checks passed · held until the next audit",
    "ts": 1791115260052
  }
}`}</Code>
      <Callout kind="note" title="field names">
        The units users earn are called credits. For compatibility the API keeps the older name: the <C>ink</C> message type and the{' '}
        <C>ink</C>, <C>periodInk</C>, <C>inkIssued</C> and <C>totalInk</C> fields all carry credits. Credits are a wallet’s share of the payout
        pool, not amounts of the $INK token; payouts are made in SOL.
      </Callout>
      <p>
        Values in these examples are illustrative of the shape only; the reason strings and numbers come from the running server.
      </p>
      <Code lang="bash" title="rest · generate">{`curl -s localhost:8787/api/generate \\
  -H 'content-type: application/json' \\
  -d '{"prompt":"The validator ","n":120,"temperature":0.8}'`}</Code>
      <Code lang="json" title="response">{`{ "text": "The validator set and the withdrawal credentials of the proposer are the stake of the blob fee in the cont", "ms": 38 }`}</Code>
      <Callout kind="note">
        Timestamps are milliseconds since the Unix epoch. Ids are opaque strings; page ids are stable across restarts (they derive from the normalized
        URL), neuron ids are per connection.
      </Callout>
      <Src path="shared/protocol.ts · shared/sepia · server/http.ts" />
    </>
  )
}
