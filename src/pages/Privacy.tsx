import { Link } from 'react-router-dom'
import { LegalContact, LegalDoc, type LegalFact, type LegalSection } from '@/components/shell/LegalDoc'
import './legal.css'

const REVISED = '2026-10-05'

const FACTS: LegalFact[] = [
  { k: 'cookies set', v: '0' },
  { k: 'messages to sign', v: '1, optional' },
  { k: 'transactions requested', v: 'never' },
  { k: 'private keys asked for', v: 'never' },
]

const COLLECT: { what: string; when: string; why: string; where: string }[] = [
  {
    what: 'IP address',
    when: 'Every page load, API call and live connection.',
    why: 'Per-IP rate limits, connection caps and blocking abuse.',
    where: 'Server memory only; not written to the INK ledger. The hosting provider may keep its own request logs.',
  },
  {
    what: 'Device id',
    when: 'When you run a neuron.',
    why: 'A random id generated in your browser, so INK can accrue without a wallet.',
    where: 'Your browser (local storage) and the INK ledger.',
  },
  {
    what: 'GPU name and benchmark',
    when: 'When you run a neuron.',
    why: 'To place your hardware in a zone and size its jobs.',
    where: 'Sent when the neuron registers. The GPU name is the neuron’s public label.',
  },
  {
    what: 'Job results',
    when: 'While your neuron works.',
    why: 'Spot-checked on the server to award INK; used to flag duplicate pages in the corpus.',
    where: 'Per-account totals in the INK ledger; duplicate flags in the corpus.',
  },
  {
    what: 'Wallet address (optional)',
    when: 'Only if you connect a Solana wallet.',
    why: 'To attribute INK to the wallet and to send SOL payouts to it.',
    where: 'Your browser (local storage), the INK ledger and the payout records on the server.',
  },
  {
    what: 'Verification signature (optional)',
    when: 'Once, when you verify a wallet to receive SOL.',
    why: 'Proves you control the address. It signs a plain-text message: no transaction, no cost.',
    where: 'Checked on the server and discarded. Only the result is kept, plus a session token in your browser.',
  },
  {
    what: 'Payout records',
    when: 'Each payout period in which your verified wallet is paid.',
    why: 'To track amounts owed, paid and carried over.',
    where: 'The server’s payout records. Each SOL transfer is also public on the Solana blockchain.',
  },
  {
    what: 'What you type',
    when: 'When you prompt SEPIA or add an agent.',
    why: 'To generate a reply; to name and place the agent.',
    where: 'Prompts are used for the reply and not saved. Agent names and owner fields are public.',
  },
]

const SECTIONS: LegalSection[] = [
  {
    id: 'p-short',
    title: 'Summary',
    body: (
      <ul>
        <li>There are no accounts and no cookies.</li>
        <li>Your IP address is used for rate limits and abuse protection.</li>
        <li>
          If you run a neuron, the server receives a random device id, your GPU’s name and benchmark, and the results of the jobs you run. Earning INK
          needs no wallet.
        </li>
        <li>
          To receive SOL payouts you connect a Solana wallet and sign one plain-text message to verify it. The server keeps the verification result,
          not the signature; your browser keeps a session token.
        </li>
        <li>LUSCA never asks for a transaction, a private key or a seed phrase.</li>
        <li>
          INK is points for verified GPU work. Each payout period, the payout pool is split by INK and paid in SOL to verified wallets. See{' '}
          <Link to="/earn">Rewards</Link>.
        </li>
      </ul>
    ),
  },
  {
    id: 'p-collect',
    title: 'What LUSCA collects',
    body: (
      <>
        <table className="lg-table">
          <thead>
            <tr>
              <th scope="col">data</th>
              <th scope="col">when</th>
              <th scope="col">why</th>
              <th scope="col">where it lives</th>
            </tr>
          </thead>
          <tbody>
            {COLLECT.map((r) => (
              <tr key={r.what}>
                <th scope="row" data-k="data">
                  {r.what}
                </th>
                <td data-k="when">{r.when}</td>
                <td data-k="why">{r.why}</td>
                <td data-k="where it lives">{r.where}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>Viewing the site without a wallet and without running a neuron uses only your IP address, for rate limits.</p>
      </>
    ),
  },
  {
    id: 'p-not',
    title: 'What LUSCA does not collect',
    body: (
      <ul>
        <li>
          <b>No transactions, private keys or seed phrases.</b> The only thing LUSCA asks a wallet to sign is one plain-text verification message.
          Anyone asking for more in LUSCA’s name is not LUSCA.
        </li>
        <li>
          <b>No cookies, ad trackers or third-party analytics.</b> The app, its fonts and its data are served from LUSCA’s own server.
        </li>
        <li>
          <b>No name, email address or phone number.</b> There is nothing to sign up for.
        </li>
        <li>
          <b>Nothing from your files.</b> Your GPU only processes number vectors derived from public web pages the agents fetched.
        </li>
      </ul>
    ),
  },
  {
    id: 'p-storage',
    title: 'What is stored in your browser',
    body: (
      <>
        <p>A few values sit in your browser’s local and session storage. They are not cookies, and nothing reads them except this site.</p>
        <dl className="lg-keys">
          <div className="kv">
            <dt>
              <code>lusca.wallet</code>
            </dt>
            <dd>the wallet address you connected · removed when you disconnect</dd>
          </div>
          <div className="kv">
            <dt>
              <code>lusca.walletAuth</code>
            </dt>
            <dd>session token from wallet verification · expires after 30 days · removed when you disconnect</dd>
          </div>
          <div className="kv">
            <dt>
              <code>lusca.deviceId</code>
            </dt>
            <dd>your random device id · reset by clearing this site’s data</dd>
          </div>
          <div className="kv">
            <dt>
              <code>lusca.booted</code>
            </dt>
            <dd>session only · skips the intro animation</dd>
          </div>
          <div className="kv">
            <dt>
              <code>lusca.reloadAt</code>
            </dt>
            <dd>session only · stops reload loops after an update</dd>
          </div>
        </dl>
        <p>
          The wallet address, session token and device id are sent to the server only when you verify a wallet, run a neuron, view your
          payouts, or add an agent (the agent's public owner field is your connected wallet address). INK earned under an
          old device id stays with that id if you reset it.
        </p>
      </>
    ),
  },
  {
    id: 'p-public',
    title: 'What is public',
    body: (
      <ul>
        <li>
          The leaderboard and the live view show each neuron’s label (by default its GPU name), zone, speed, jobs and INK, together with the wallet
          address it earns under, usually shortened.
        </li>
        <li>
          Payout history shows wallet addresses, amounts and transaction signatures. SOL transfers are permanently public on the Solana blockchain.
        </li>
        <li>Agent names and the owner field you type when adding an agent are shown to everyone.</li>
        <li>Do not put personal information in labels, agent names or owner fields.</li>
      </ul>
    ),
  },
  {
    id: 'p-keep',
    title: 'How long it is kept',
    body: (
      <ul>
        <li>Rate-limit state lives in memory and is gone when the server restarts.</li>
        <li>The INK ledger, payout records and the corpus live on the server’s disk until they are removed.</li>
        <li>On-chain payout transactions cannot be removed by anyone.</li>
        <li>The host that runs LUSCA keeps its own logs under its own policy.</li>
      </ul>
    ),
  },
  {
    id: 'p-agents',
    title: 'Data agents and site owners',
    body: (
      <>
        <p>
          LUSCA’s data agents identify themselves as <code>LuscaBot</code>, fetch public pages only, and follow robots.txt (rules for LuscaBot and for{' '}
          <code>*</code>), its per-host delay directive, and page-level <code>noindex</code>. Because fetched pages train SEPIA, the agents also treat
          opt-outs aimed at AI-training bots (such as GPTBot, CCBot and Google-Extended) as binding on themselves.
        </p>
        <p>To keep LUSCA off a whole site, add this to its robots.txt:</p>
        <pre className="lg-code mono">
          <span className="lg-code-h">robots.txt</span>
          {'User-agent: LuscaBot\nDisallow: /'}
        </pre>
        <p>
          robots.txt is cached for up to an hour, so a change applies within the hour. Fetched pages can contain names or text that people posted
          publicly; to ask for pages to be removed from the corpus, use the contact below. The full rules are in{' '}
          <Link to="/docs/ethics">data ethics</Link>.
        </p>
      </>
    ),
  },
  {
    id: 'p-choices',
    title: 'Your choices',
    body: (
      <ul>
        <li>Use the site without connecting a wallet or running a neuron.</li>
        <li>Earn INK without a wallet; connect and verify one only if you want SOL payouts.</li>
        <li>Disconnect your wallet at any time from the wallet button or the menu. This clears the stored address and session token.</li>
        <li>Stop the neuron at any time. Closing the tab stops it too.</li>
        <li>Clear this site’s data in your browser to remove everything listed above.</li>
        <li>Ask for your ledger entries to be removed through the contact below. On-chain transactions cannot be removed.</li>
      </ul>
    ),
  },
  {
    id: 'p-contact',
    title: 'Contact',
    body: (
      <>
        <LegalContact />
        <p>
          The rules for using LUSCA are in the <Link to="/terms">terms</Link>.
        </p>
      </>
    ),
  },
]

export default function Privacy() {
  return (
    <LegalDoc
      doc="privacy"
      title="Privacy"
      kicker="What LUSCA collects, what it does not, and where it is stored."
      revised={REVISED}
      facts={FACTS}
      sections={SECTIONS}
    />
  )
}
