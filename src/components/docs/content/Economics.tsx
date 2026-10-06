import { Link } from 'react-router-dom'
import { NEURON } from '../facts'
import { INK_LINE, PayoutRulesList, payoutStatus, sentence, usePayoutRules } from '../payout'
import { C, Callout, Code, H3, Spec, Src } from '../ui'

const SIGN_IN_MESSAGE = `lusca.ink wants you to sign in with your Solana account:
<your wallet address>

Link this wallet to LUSCA to receive SOL payouts for verified GPU work. This is not a transaction and costs nothing.

URI: https://lusca.ink
Version: 1
Nonce: <32 hex characters, single use>
Issued At: <ISO 8601 time>
Expiration Time: <issued + 5 minutes>`

export function Economics() {
  const view = usePayoutRules()
  return (
    <>
      <p className="dlead">
        {INK_LINE} No amount is guaranteed: a wallet’s payout depends on the pool for that period and on its share of the period’s confirmed credits. Credits are not tokens and are never paid out as $INK; they only set how each period’s SOL is split.
      </p>
      <p>
        Status on this server: <b>{sentence(payoutStatus(view.mode, view.failed))}</b>
      </p>

      <H3 id="economics-today" n="10.1">
        What earns credits
      </H3>
      <p>
        One code path issues credits: a neuron job that the server has checked (<Link to="/docs/neurons">08.3–08.5</Link>). Training jobs compute SEPIA-0
        gradients on batches the server picks; their credits are recorded as <i>pending</i> and become <i>confirmed</i> when that identity’s next full audit
        (a server recompute of the gradient) passes, and a failed audit forfeits all of them. Dedupe jobs are confirmed when their CPU spot-check passes.
        Both use one credit per 100 MFLOP of verified work, +15% per depth zone, minimum 0.01 per verified job, zero for anything that fails. Only
        confirmed credits count toward payouts. Earning credits needs no wallet and no account.
      </p>
      <Spec
        rows={[
          ['issued by', 'server/neurons/coordinator.ts', 'pass() → ledger account += inkFor(flops, zone)'],
          ['keyed by', 'verified wallet → device id → label', 'a wallet only with a valid session token (10.3)'],
          ['pending credits', 'training credits awaiting an audit', 'confirmed by the next passed audit, forfeited by a failed one'],
          ['period credits', 'periodInk per account · confirmed credits only', 'reset with carry-over when a payout period closes'],
          ['persisted', `ledger.json every ${NEURON.ledgerSaveS} s`, 'and on shutdown and at each period close'],
          ['visible at', 'GET /api/ledger', 'totals, top-100 leaderboard, or one account with ?wallet='],
        ]}
      />
      <Callout kind="honest">
        Spawning agents, flagging duplicates and other contribution types are described on the <Link to="/earn">Rewards</Link> page as design. The
        current code awards credits only for checked neuron jobs: training and dedupe.
      </Callout>

      <H3 id="economics-payouts" n="10.2">
        SOL payouts
      </H3>
      <p>
        At the end of each payout period the server snapshots the confirmed period credits of every verified wallet, computes the pool and pays each wallet its share
        in SOL from the treasury wallet. The rules below are read from this server’s <C>GET /api/payouts</C> (<C>rules</C>).
      </p>
      <PayoutRulesList view={view} />
      <p>
        Per wallet: <C>amount = pool × walletInk / Σ periodInk</C>, then the per-wallet cap and the dust floor. Undistributed credits and capped excess carry
        over to the next period. A period is written to disk as <C>planned</C> before any transfer is sent; each transaction signature is stored before
        broadcast, so a restart re-checks sent rows instead of paying twice. Transfers are batched, at most 18 per transaction.
      </p>
      <Callout kind="note" title="Payouts off">
        When the payout engine is off (<C>LUSCA_PAYOUTS=off</C>, the default) the server reports: Payouts not started — the payout pool has not been
        funded yet. Credits are still earned and counted.
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
          The browser sends the token with <C>neuron.register</C> (<C>auth</C>). Credits go to the wallet only with a valid token; a bare wallet
          field is ignored for payouts.
        </li>
        <li>
          Right after sign-in (<C>POST /api/auth/link-device</C>) and on a device’s verified register, the credits that device earned earlier in the
          current period move to the wallet. A device is linked to one wallet per period; credits from earlier periods stay on the device.
        </li>
      </ol>
      <Src path="server/auth/auth.ts (signInMessage, createAuth) · server/neurons/coordinator.ts" />

      <H3 id="economics-funding" n="10.4">
        Funding and treasury
      </H3>
      <p>
        The pool is funded by the creator fees from $INK trading (the owner’s token), routed to the treasury wallet. Nobody is paid in $INK: payouts are made in SOL, split by confirmed credits. LUSCA itself does not issue a token. The treasury address,
        its live balance, the next payout time, the current pool estimate and every past payout with its transaction links are on the{' '}
        <Link to="/earn">Rewards</Link> page, read from <C>GET /api/payouts</C>; per-wallet history is at <C>GET /api/payouts/wallet/:address</C>.
      </p>
      <Callout kind="note">Nothing in this manual or on the Rewards page is financial advice. Payout amounts are not guaranteed.</Callout>

      <H3 id="economics-proofs" n="10.5">
        Proof of contribution
      </H3>
      <p>
        Every confirmed credit is committed to a public hash chain, so a contributor can prove what they earned and anyone can check that past epochs were not
        rewritten. Every <C>LUSCA_EPOCH_MIN</C> minutes (default 60, boundaries on the UTC clock) the server closes a contribution epoch:
      </p>
      <Spec
        rows={[
          ['leaf', <C key="l">sha256(0x00 ‖ u32be epoch ‖ identity[32] ‖ u64be credits ‖ u64be jobs ‖ u64be flops)</C>, 'credits in micro-credits (1 credit = 1 000 000), all integers'],
          ['inner node', <C key="n">sha256(0x01 ‖ left ‖ right)</C>, 'the 0x00 / 0x01 prefixes keep a leaf from ever passing as a node'],
          ['tree', 'leaf hashes sorted ascending, paired left to right', 'an odd last node moves up unchanged; one leaf = its own root; no leaves = 32 zero bytes'],
          ['header', <C key="h">{'{v, index, startedAt, endedAt, leafCount, totals, treeRoot, prevHeaderHash}'}</C>, 'canonical JSON in exactly this key order; totals = credits, jobs, flops, ledgerCredits'],
          ['headerHash', <C key="hh">sha256(utf8(canonical header))</C>, 'each header carries the previous headerHash: one chain back to epoch 0'],
          ['identity', 'wallet: sha256("lusca:id:v1:wallet:" + address)', 'device: HMAC-SHA256 under the server secret, so device ids never leave the server'],
        ]}
      />
      <ol className="dlist">
        <li>
          <b>What counts.</b> One leaf per ledger account that received <i>confirmed</i> credits in the epoch: verified dedupe jobs, and gradient jobs once a
          full audit confirms them. Credits held in escrow are not in any leaf until confirmed; forfeited escrow never is. A link from a device to a wallet
          moves period credits for payouts but is not new work, so it adds no leaf.
        </li>
        <li>
          <b>Genesis.</b> Epoch 0 commits the full confirmed balance of every account at the moment proofs started on this server, so earlier history is
          covered too.
        </li>
        <li>
          <b>Persistence.</b> The open epoch’s credits are saved inside <C>ledger.json</C> together with the balances; a closing epoch is written there first
          (write-ahead), then to <C>proofs/l-*.json</C> and <C>proofs/h-*.json</C> (fsync, rename). A closed epoch is never rewritten. Every start re-hashes
          the whole chain and reports a mismatch in <C>/api/health</C> (<C>proof-chain-broken</C>).
        </li>
        <li>
          <b>Check it yourself.</b> <C>GET /api/proofs</C> lists headers; <C>GET /api/proofs/:index/leaves.json</C> publishes every leaf so the root can be
          recomputed; <C>POST /api/proofs/:index/proof</C> with your wallet session token or device id returns your leaf and its Merkle path. The Rewards page
          runs all of it in your browser with WebCrypto.
        </li>
      </ol>
      <p>
        What it proves: the server committed to these credits at that time and has not changed them since. What it does not prove: that the server measured
        the work honestly in the first place. That rests on the spot checks and full audits in <Link to="/docs/neurons">08</Link>.
      </p>
      <Src path="shared/proofs.ts (format, browser verification) · server/proofs/index.ts (epochs, storage) · server/neurons/coordinator.ts (EpochLedger)" />
    </>
  )
}
