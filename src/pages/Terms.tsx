import { Link } from 'react-router-dom'
import { LegalContact, LegalDoc, type LegalFact, type LegalSection } from '@/components/shell/LegalDoc'
import './legal.css'

const REVISED = '2026-10-05'

const FACTS: LegalFact[] = [
  { k: 'minimum age', v: '18+' },
  { k: 'payouts', v: 'SOL' },
  { k: 'guaranteed amount', v: 'none' },
  { k: 'electricity', v: 'yours' },
  { k: 'taxes', v: 'yours' },
]

const SECTIONS: LegalSection[] = [
  {
    id: 't-what',
    title: 'What LUSCA is',
    body: (
      <>
        <p>
          LUSCA is a data pipeline and compute network: agents fetch public crypto web pages into a corpus, a small language model (SEPIA) trains on
          that corpus, and an optional network of browser GPUs (“neurons”) runs jobs the server can verify. Verified work earns credits — your share of each SOL payout.
        </p>
        <p>By using LUSCA you agree to these terms. If you do not agree, do not use it.</p>
      </>
    ),
  },
  {
    id: 't-age',
    title: 'Who can use it',
    body: (
      <ul>
        <li>
          You must be <b>18 or older</b>, or the age of majority where you live if that is higher, to connect a wallet, run a neuron, earn credits or
          receive payouts.
        </li>
        <li>Do not use LUSCA where the law that applies to you does not allow it.</li>
      </ul>
    ),
  },
  {
    id: 't-ink',
    title: 'Credits and payouts',
    body: (
      <ul>
        <li>
          <b>Credits are points for verified GPU work.</b> Credits are your share of the payout pool. Payouts are made in SOL: each payout period, the
          payout pool is split by credits and paid in SOL to verified wallets. Credits are not a token and cannot be bought, sold or transferred.
        </li>
        <li>
          The payout pool is funded from the treasury wallet, which receives the project owner’s token creator fees. The pool for a period is a
          capped share of the treasury balance after a reserve and fees; per-wallet caps and a minimum payout apply, and amounts above the cap or below
          the minimum carry over to later periods. The current schedule and parameters are shown on the <Link to="/earn">Rewards</Link> page.
        </li>
        <li>
          <b>No amount is guaranteed.</b> The pool depends on the treasury balance, which can be zero. If the pool has not been funded, no payout is
          made for that period.
        </li>
        <li>
          To receive SOL you verify a wallet by signing one plain-text message. Earning credits does not require a wallet. When you verify, the credits this
          device earned in the current payout period move to your wallet once. Credits earned in earlier periods without a verified wallet earn no payout.
        </li>
        <li>
          Payout parameters may change. Changes are announced on the <Link to="/earn">Rewards</Link> page before they apply.
        </li>
        <li>
          Credits earned through bugs, duplicate identities or invalid work may be removed, and payouts for them may be withheld.
        </li>
      </ul>
    ),
  },
  {
    id: 't-taxes',
    title: 'Taxes',
    body: (
      <p>
        SOL you receive may be taxable where you live. <b>Reporting and paying any taxes is your responsibility.</b> LUSCA does not withhold tax or
        issue tax documents.
      </p>
    ),
  },
  {
    id: 't-power',
    title: 'Your hardware and your electricity',
    body: (
      <ul>
        <li>
          Running a neuron uses your GPU or CPU. <b>You pay for your own electricity</b>, wear and any data costs, and nobody reimburses them. Payouts
          may be lower than those costs.
        </li>
        <li>Only run it on hardware you own or are allowed to use. Do not run it on work, school or shared machines without permission.</li>
        <li>
          You can stop at any time, and closing the tab stops it. Keep an eye on temperatures; LUSCA is not responsible for damage to your hardware.
        </li>
      </ul>
    ),
  },
  {
    id: 't-rules',
    title: 'Fair use',
    body: (
      <>
        <p>Do not:</p>
        <ul>
          <li>submit fake or copied job results, or run many identities to collect more credits;</li>
          <li>attack, overload, scrape at volume or try to break into the service, or bypass its limits;</li>
          <li>
            use neuron labels, agent names or owner fields for links, spam, phishing, impersonation, or anything unlawful, hateful or sexual.
          </li>
        </ul>
        <p>
          LUSCA may block IP addresses, wallets or devices, remove agents and names, and void credits, at its discretion and without notice.
        </p>
      </>
    ),
  },
  {
    id: 't-wallets',
    title: 'Wallets',
    body: (
      <ul>
        <li>
          LUSCA reads your wallet’s public address and asks it to sign one plain-text verification message. It never asks for a transaction and
          signing costs nothing.
        </li>
        <li>
          LUSCA will never ask for a private key or seed phrase. Anyone who does in LUSCA’s name is not LUSCA. Your wallet and its security are your
          responsibility.
        </li>
        <li>Payouts sent to the verified address are final. Check that you control the wallet you verify.</li>
      </ul>
    ),
  },
  {
    id: 't-content',
    title: 'Corpus and model output',
    body: (
      <ul>
        <li>
          The corpus holds public web pages fetched by LUSCA’s agents. Their authors keep their rights; LUSCA claims no ownership of them. Site owners
          can opt out, as described in the <Link to="/privacy">privacy</Link> page and the <Link to="/docs/ethics">data ethics</Link> docs.
        </li>
        <li>
          SEPIA is a small experimental model. Its output is often wrong and may repeat fragments of fetched text. It is not advice of any kind,
          financial or otherwise.
        </li>
      </ul>
    ),
  },
  {
    id: 't-warranty',
    title: 'No warranty',
    body: (
      <p>
        LUSCA is provided <b>“as is” and “as available”, without warranty of any kind</b>, express or implied, including fitness for a particular
        purpose. It may be slow, wrong, interrupted, changed or shut down at any time, and data, including the credit ledger, may be lost.
      </p>
    ),
  },
  {
    id: 't-liability',
    title: 'Limits on liability',
    body: (
      <p>
        As far as the law allows, the people who run LUSCA are not liable for any loss or damage from using it, including lost credits, missed or delayed
        payouts, hardware damage, electricity costs, lost data, or indirect or consequential losses. Where liability cannot be excluded, it is limited
        to the minimum the law allows.
      </p>
    ),
  },
  {
    id: 't-changes',
    title: 'Changes',
    body: (
      <p>
        These terms may change. The revision date at the top shows the latest version, and changes to payout parameters are announced on the{' '}
        <Link to="/earn">Rewards</Link> page before they apply. Using LUSCA after a change means you accept the new version.
      </p>
    ),
  },
  {
    id: 't-contact',
    title: 'Contact',
    body: (
      <>
        <LegalContact />
        <p>
          What LUSCA collects and why is in the <Link to="/privacy">privacy</Link> page.
        </p>
      </>
    ),
  },
]

export default function Terms() {
  return (
    <LegalDoc
      doc="terms"
      title="Terms"
      kicker="Rules for using LUSCA, earning credits and receiving SOL payouts."
      revised={REVISED}
      facts={FACTS}
      sections={SECTIONS}
    />
  )
}
