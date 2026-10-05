import { Link } from 'react-router-dom'
import { NEURON } from '../facts'
import { INK_LINE, PayoutRulesList, payoutStatus, sentence, usePayoutRules } from '../payout'
import { C, Callout, Code, H3, Spec, Src } from '../ui'

const SIGN_IN_MESSAGE = `lusca.ink wants you to sign in with your Solana account:
<your wallet address>

Link this wallet to LUSCA to receive SOL payouts for verified GPU work.
This is not a transaction and costs nothing.

Nonce: <32 hex characters, single use, valid 5 minutes>
Issued At: <ISO 8601 time>`

export function Economics() {
  const view = usePayoutRules()
  return (
    <>
      <p className="dlead">
        {INK_LINE} No amount is guaranteed: a wallet’s payout depends on the pool for that period and on its share of the period’s INK.
      </p>
      <p>
        Status on this server: <b>{sentence(payoutStatus(view.mode, view.failed))}</b>
      </p>

      <H3 id="economics-today" n="10.1">
        What earns INK
      </H3>
      <p>
        One code path issues INK: a neuron job that the server has checked (<Link to="/docs/neurons">08.3–08.5</Link>). Training jobs compute SEPIA-0
        gradients on batches the server picks; their INK is credited as <i>pending</i> and becomes <i>confirmed</i> when that identity’s next full audit
        (a server recompute of the gradient) passes, and a failed audit forfeits all of it. Dedupe jobs are confirmed when their CPU spot-check passes.
        Both use one INK per 100 MFLOP of verified work, +15% per depth zone, minimum 0.01 per verified job, zero for anything that fails. Only
        confirmed INK counts toward payouts. Earning INK needs no wallet and no account.
      </p>
      <Spec
        rows={[
          ['issued by', 'server/neurons/coordinator.ts', 'pass() → ledger account += inkFor(flops, zone)'],
          ['keyed by', 'verified wallet → device id → label', 'a wallet only with a valid session token (10.3)'],
          ['pending INK', 'training INK awaiting an audit', 'confirmed by the next passed audit, forfeited by a failed one'],
          ['period INK', 'periodInk per account · confirmed INK only', 'reset with carry-over when a payout period closes'],
          ['persisted', `ledger.json every ${NEURON.ledgerSaveS} s`, 'and on shutdown and at each period close'],
          ['visible at', 'GET /api/ledger', 'totals, top-100 leaderboard, or one account with ?wallet='],
        ]}
      />
      <Callout kind="honest">
        Spawning agents, flagging duplicates and other contribution types are described on the <Link to="/earn">Rewards</Link> page as design. The
        current code credits INK only for checked neuron jobs: training and dedupe.
      </Callout>

      <H3 id="economics-payouts" n="10.2">
        SOL payouts
      </H3>
      <p>
        At the end of each payout period the server snapshots the period INK of every verified wallet, computes the pool and pays each wallet its share
        in SOL from the treasury wallet. The rules below are read from this server’s <C>GET /api/payouts</C> (<C>rules</C>).
      </p>
      <PayoutRulesList view={view} />
      <p>
        Per wallet: <C>amount = pool × walletInk / Σ periodInk</C>, then the per-wallet cap and the dust floor. Undistributed INK and capped excess carry
        over to the next period. A period is written to disk as <C>planned</C> before any transfer is sent; each transaction signature is stored before
        broadcast, so a restart re-checks sent rows instead of paying twice. Transfers are batched, at most 18 per transaction.
      </p>
      <Callout kind="note" title="Payouts off">
        When the payout engine is off (<C>LUSCA_PAYOUTS=off</C>, the default) the server reports: Payouts not started — the payout pool has not been
        funded yet. INK is still earned and counted.
      </Callout>
      <Src path="server/payouts/ (config.ts · plan.ts) · shared/payouts.ts" />

      <H3 id="economics-wallet" n="10.3">
        Wallet verification
      </H3>
      <p>
        A wallet is only needed to receive SOL. To link one, the wallet signs one plain-text message. It is not a transaction, it costs nothing and it
        moves no funds. LUSCA never asks for a transaction, a private key or a seed phrase.
      </p>
      <Code title="sign-in message (exact text)" lang="text">
        {SIGN_IN_MESSAGE}
      </Code>
      <ol className="dlist">
        <li>
          <C>GET /api/auth/nonce?wallet=&lt;address&gt;</C> returns the nonce and the exact message.
        </li>
        <li>The wallet signs the message (Phantom <C>signMessage</C>).</li>
        <li>
          <C>POST /api/auth/verify</C> checks the ed25519 signature against the address and returns a session token valid for 30 days.
        </li>
        <li>
          The browser sends the token with <C>neuron.register</C> (<C>auth</C>). INK is credited to the wallet only with a valid token; a bare wallet
          field is ignored for payouts.
        </li>
        <li>On a device’s first verified register in a period, the INK that device earned earlier in that period moves to the wallet, once.</li>
      </ol>
      <Src path="server/auth/auth.ts (signInMessage, createAuth) · server/neurons/coordinator.ts" />

      <H3 id="economics-funding" n="10.4">
        Funding and treasury
      </H3>
      <p>
        The pool is funded by the owner’s token creator fees, routed to the treasury wallet. LUSCA itself does not issue a token. The treasury address,
        its live balance, the next payout time, the current pool estimate and every past payout with its transaction links are on the{' '}
        <Link to="/earn">Rewards</Link> page, read from <C>GET /api/payouts</C>; per-wallet history is at <C>GET /api/payouts/wallet/:address</C>.
      </p>
      <Callout kind="note">Nothing in this manual or on the Rewards page is financial advice. Payout amounts are not guaranteed.</Callout>
    </>
  )
}
