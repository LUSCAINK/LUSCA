// Inputs for the payout preview on /earn: the caller's period credits and the period snapshot the
// payout engine would split right now. The split itself runs in the browser with the same
// planPayout() the payout engine uses (shared/payoutPlan.ts); nothing here estimates anything.

import type { PayoutPreviewData } from '../../shared/proofs.ts'
import type { LuscaCoordinator } from '../neurons/coordinator.ts'
import type { PayoutConfig } from '../payouts/config.ts'
import type { PreviewSource } from './http.ts'

const round6 = (x: number) => Math.round(x * 1e6) / 1e6

export function payoutPreviewSource(coord: Pick<LuscaCoordinator, 'payouts' | 'balance'>, cfg: Pick<PayoutConfig, 'mode' | 'rules'>): PreviewSource {
  return (ids): PayoutPreviewData => {
    const snap = coord.payouts?.periodSnapshot() ?? []
    const last = coord.payouts?.lastClosed() ?? null
    let wallet: string | null = null
    let walletCredits = 0
    let deviceCredits = 0
    for (const r of ids) {
      if (r.scope === 'wallet' && r.wallet) {
        wallet = r.wallet
        walletCredits = coord.payouts?.periodInk(r.wallet) ?? 0
      } else if (r.scope === 'device') {
        deviceCredits = coord.balance(r.key)?.periodInk ?? 0
      }
    }
    let total = 0
    for (const row of snap) total += row.ink
    return {
      mode: cfg.mode,
      periodSince: last?.endsAt ?? null,
      lastClosedId: last?.id ?? null,
      you: { wallet, walletCredits: round6(walletCredits), deviceCredits: round6(deviceCredits) },
      totalCredits: round6(total),
      wallets: snap.length,
      rules: { maxWalletLamports: cfg.rules.maxWalletLamports, minLamports: cfg.rules.minLamports },
      at: Date.now(),
    }
  }
}
