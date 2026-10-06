// Small pieces shared by /chain and /chain/:chain/:address.
import type { ChainId, FoundVia, Verdict } from '@shared/chain'
import { CHAIN_LABEL, CHAIN_SHORT, VERDICT_LABEL, VERDICT_TEXT, VIA_LABEL, VIA_TEXT, isChainId } from '@/lib/chain'

export function VerdictTag({ v }: { v: Verdict | string }) {
  const known = v in VERDICT_LABEL
  const key = v as Verdict
  return (
    <span className={`ch-vd ch-vd-${known ? key : 'other'}`} title={known ? VERDICT_TEXT[key] : undefined}>
      {known ? VERDICT_LABEL[key] : String(v || '—')}
    </span>
  )
}

export function ViaTag({ via }: { via: FoundVia | string }) {
  const known = via in VIA_LABEL
  return (
    <span className="ch-via" title={known ? VIA_TEXT[via as FoundVia] : undefined}>
      {known ? VIA_LABEL[via as FoundVia] : String(via || '—')}
    </span>
  )
}

export function ChainTag({ chain, long }: { chain: ChainId | string; long?: boolean }) {
  const ok = isChainId(chain)
  return (
    <span className="ch-chain" title={ok ? CHAIN_LABEL[chain] : undefined}>
      {ok ? (long ? CHAIN_LABEL[chain] : CHAIN_SHORT[chain]) : String(chain || '—')}
    </span>
  )
}
