// "Post to X": a plain intent link carrying the /r/ share link, whose player card X renders in the post.
import type { ChainId } from '@shared/chain'
import type { RadarEvent } from '@shared/radar'

const CHAIN_NAME: Record<ChainId, string> = { solana: 'Solana', ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum' }
const KIND_WORD: Record<RadarEvent['kind'], string> = {
  upgrade: 'upgraded',
  deploy: 'deployed',
  admin_change: 'admin changed',
  beacon_upgrade: 'beacon upgraded',
  authority_change: 'authority changed',
  close: 'closed',
}

const origin = () => (typeof location !== 'undefined' ? location.origin : 'https://lusca.ink')
const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, a.startsWith('0x') ? 6 : 4)}…${a.slice(-4)}` : a)

export function xIntent(text: string, url: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
}

/** Facts only: what changed, where, and the first new admin-only function with file:line. */
export function radarPostUrl(e: RadarEvent): string {
  const who = e.name || shortAddr(e.address)
  const g = e.diff?.guardsAdded?.[0]
  const text = `${who} ${KIND_WORD[e.kind] ?? e.kind} on ${CHAIN_NAME[e.chain]}${g ? ` · new admin-only ${g.fn} (${g.guard}, ${g.at})` : ''} · caught by LUSCA Radar`
  return xIntent(text, `${origin()}/r/radar/${e.id}`)
}

export function lensPostUrl(chain: ChainId, address: string, name: string | null): string {
  const text = `${name ?? shortAddr(address)} on ${CHAIN_NAME[chain]}, read by LUSCA Lens`
  return xIntent(text, `${origin()}/r/lens/${chain}/${address}`)
}
