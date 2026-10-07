// Feed cards: validation, card values, player paths. Run: npx tsx server/share/_test.ts
import assert from 'node:assert/strict'
import type { RadarEvent } from '../../shared/radar.ts'
import { RADAR_FEED_CARD, isRadarId, lensCard, lensTarget, playerFile, radarCard, resolveShare, xIntent } from './cards.ts'

let n = 0
const t = (name: string, f: () => void) => {
  f()
  n++
  console.log(`ok ${n} ${name}`)
}

const VAULT = {
  id: 'eth-muxgfhjr1k',
  chain: 'ethereum',
  kind: 'upgrade',
  address: '0x936facdf10c8c36294e7b9d28345255539d81bc7',
  name: 'Vault',
  headline: 'Upgraded · → 0x8a…f92c · 1 function added · 1 new admin-only function · verified: Sourcify full',
  diff: { guardsAdded: [{ fn: 'cancelClosing()', guard: 'onlyOwner', at: 'Vault.sol:429' }] },
} as unknown as RadarEvent
const get = (id: string) => (id === VAULT.id ? VAULT : null)

t('radar ids', () => {
  assert.ok(isRadarId('eth-muxgfhjr1k'))
  assert.ok(isRadarId('sol-abc123'))
  for (const bad of ['', 'eth', 'ETH-muxgfhjr1k', 'eth-mux', 'eth-muxgfhjr1k/x', 'eth-mux<gfhjr1k', 'e-muxgfhjr1k', 'eth-' + 'a'.repeat(21)]) assert.ok(!isRadarId(bad), bad)
})

t('lens targets', () => {
  assert.deepEqual(lensTarget('ethereum', '0x936FACDF10c8c36294e7b9d28345255539d81bc7'), { chain: 'ethereum', address: '0x936facdf10c8c36294e7b9d28345255539d81bc7' })
  assert.deepEqual(lensTarget('solana', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), { chain: 'solana', address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' })
  assert.equal(lensTarget('polygon', '0x936facdf10c8c36294e7b9d28345255539d81bc7'), null)
  assert.equal(lensTarget('base', '0x936facdf10c8c36294e7b9d28345255539d81bc'), null)
  assert.equal(lensTarget('solana', '0x936facdf10c8c36294e7b9d28345255539d81bc7'), null)
  assert.equal(lensTarget('ethereum', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), null)
  assert.equal(lensTarget('solana', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTa0l'), null) // 0 and l are not base58
  assert.equal(lensTarget('__proto__', '0x936facdf10c8c36294e7b9d28345255539d81bc7'), null)
})

t('share resolution', () => {
  assert.equal(resolveShare('/r/radar', get), RADAR_FEED_CARD)
  assert.equal(resolveShare('/r/radar/', get), RADAR_FEED_CARD)
  const c = resolveShare('/r/radar/eth-muxgfhjr1k', get)!
  assert.equal(c.player, '/play/radar/eth-muxgfhjr1k')
  assert.match(c.title, /^Vault upgraded on Ethereum/)
  assert.match(c.description, /cancelClosing\(\) \(onlyOwner, Vault\.sol:429\)/)
  assert.equal(resolveShare('/r/radar/eth-unknown123', get), null)
  assert.equal(resolveShare('/r/radar/eth-muxgfhjr1k', null), null) // radar not running: nothing to name
  assert.equal(resolveShare('/r/radar/%22%3E%3Cscript%3E', get), null)
  assert.equal(resolveShare('/r/radar/%E0%A4%A', get), null) // bad escape
  const l = resolveShare('/r/lens/base/0x2D71993BE2AA5F2068304126224ECEFFFC58DDD3', get)!
  assert.equal(l.player, '/play/lens/base/0x2d71993be2aa5f2068304126224ecefffc58ddd3')
  assert.equal(l.page, '/lens/base/0x2d71993be2aa5f2068304126224ecefffc58ddd3')
  assert.equal(resolveShare('/r/lens/base/0xnope', get), null)
  assert.equal(resolveShare('/r/lens/base', get), null)
  assert.equal(resolveShare('/r/lens', get), null)
  assert.equal(resolveShare('/r/scan', get), undefined) // the caller's own table
})

t('player files', () => {
  assert.equal(playerFile('/play/radar', get), undefined)
  assert.equal(playerFile('/play/radar/', get), undefined)
  assert.equal(playerFile('/play/radar/index.html', get), undefined)
  assert.equal(playerFile('/play/radar/eth-muxgfhjr1k', get), '/play/radar/index.html')
  assert.equal(playerFile('/play/radar/eth-unknown123', get), null)
  assert.equal(playerFile('/play/radar/eth-muxgfhjr1k', null), '/play/radar/index.html') // radar off: the page says so
  assert.equal(playerFile('/play/radar/..%2f..%2fetc', get), null)
  assert.equal(playerFile('/play/radar/a/b', get), null)
  assert.equal(playerFile('/play/lens/ethereum/0x936facdf10c8c36294e7b9d28345255539d81bc7', get), '/play/lens/index.html')
  assert.equal(playerFile('/play/lens/ethereum/0x936f', get), null)
  assert.equal(playerFile('/play/lens/ethereum', get), null)
  assert.equal(playerFile('/play/lens/', get), undefined)
  assert.equal(playerFile('/play/scan', get), undefined)
  assert.equal(playerFile('/play/radar.js', get), undefined)
  assert.equal(playerFile('/play/fonts/archivo.woff2', get), undefined)
})

t('cards and intents', () => {
  const r = radarCard({ ...VAULT, name: null, diff: null } as unknown as RadarEvent)
  assert.match(r.title, /^0x936f…1bc7 upgraded on Ethereum/)
  assert.ok(r.title.length <= 70)
  const l = lensCard('solana', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')
  assert.match(l.title, /Solana program JUP6…TaV4$/)
  const x = xIntent('Vault & co: "a" #1', 'https://lusca.ink/r/radar/eth-muxgfhjr1k')
  assert.equal(x, 'https://x.com/intent/post?text=Vault%20%26%20co%3A%20%22a%22%20%231&url=https%3A%2F%2Flusca.ink%2Fr%2Fradar%2Feth-muxgfhjr1k')
})

console.log(`share: ${n} passed`)
