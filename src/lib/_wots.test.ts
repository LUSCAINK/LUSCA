// Tests for the WOTS demo on /exposure (src/lib/wots.ts). Run: npx tsx src/lib/_wots.test.ts
// Uses only WebCrypto (globalThis.crypto, present in Node 22+ and browsers). Exits non-zero on any failure.
import {
  WOTS,
  coverChance,
  digitsOfDigest,
  forge,
  forgeChance,
  forgeFrom,
  generate,
  lowestRevealed,
  sign,
  signatureBytes,
  toHex,
  verify,
  type WotsSignature,
} from './wots'

let failed = 0
let passed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++
  else {
    failed++
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const seedA = new Uint8Array(32).map((_, i) => i + 1)
const seedB = new Uint8Array(32).map((_, i) => 200 - i)

// ─── digits and checksum ──────────────────────────────────────────────────
{
  const zero = digitsOfDigest(new Uint8Array(32))
  check('digits: 67 per message', zero.length === WOTS.len)
  check('digits: all-zero digest has checksum 960 = 0x3c0', zero.slice(64).join(',') === '3,12,0', zero.slice(64).join(','))
  const ff = digitsOfDigest(new Uint8Array(32).fill(0xff))
  check('digits: all-0xff digest has checksum 0', ff.slice(64).join(',') === '0,0,0')
  check('digits: high nibble first', digitsOfDigest(new Uint8Array(32).fill(0xa5)).slice(0, 2).join(',') === '10,5')
}

// ─── sign / verify round trip ─────────────────────────────────────────────
const kp = await generate(seedA)
const kp2 = await generate(seedA)
check('keygen: deterministic from the seed', toHex(kp.publicKey) === toHex(kp2.publicKey))
check('keygen: public key is 32 bytes', kp.publicKey.length === 32)
check('keygen: 67 chain ends', kp.ends.length === 67)
const other = await generate(seedB)
check('keygen: another seed, another key', toHex(other.publicKey) !== toHex(kp.publicKey))

const msg = 'LUSCA exposure demo: message 1'
const sig = await sign(kp, msg)
check('sign: 67 values of 32 bytes', sig.values.length === 67 && sig.values.every((v) => v.length === 32))
check('sign: signature is 2,144 bytes', signatureBytes(sig).length === 2144, String(signatureBytes(sig).length))
check('verify: genuine signature verifies', await verify(kp.publicKey, msg, sig.values))
check('verify: tampered message fails', !(await verify(kp.publicKey, msg.replace('1', '2'), sig.values)))
check('verify: one extra space fails', !(await verify(kp.publicKey, msg + ' ', sig.values)))
check('verify: wrong public key fails', !(await verify(other.publicKey, msg, sig.values)))
{
  const bad = sig.values.map((v) => v.slice())
  bad[10][0] ^= 1
  check('verify: one flipped signature bit fails', !(await verify(kp.publicKey, msg, bad)))
  check('verify: truncated signature fails', !(await verify(kp.publicKey, msg, sig.values.slice(0, 66))))
}
{
  const bytes = new TextEncoder().encode(msg)
  check('verify: bytes and string sign the same', await verify(kp.publicKey, bytes, sig.values))
}

// ─── one signature: nothing else can be signed ────────────────────────────
check('reuse: one signature gives a forge chance of exactly 0', forgeChance([sig]) === 0, String(forgeChance([sig])))
check('reuse: nothing revealed covers every message', Math.abs(coverChance(new Array(67).fill(0)) - 1) < 1e-12)
{
  const fromOne = await forgeFrom(lowestRevealed([sig]), 'some other message')
  check('reuse: one signature cannot be walked to another message', fromOne === null)
}

// ─── several signatures with one key: forgeries appear ───────────────────
{
  const sigs: WotsSignature[] = [sig]
  for (let k = 2; sigs.length < 8; k++) sigs.push(await sign(kp, `LUSCA exposure demo: message ${k}`))
  const p2 = forgeChance(sigs.slice(0, 2))
  const p8 = forgeChance(sigs)
  check('reuse: two signatures give a non-zero chance', p2 > 0, String(p2))
  check('reuse: more signatures, higher chance', p8 > p2, `${p2} → ${p8}`)
  const low = lowestRevealed(sigs)
  const res = await forge(low, 'forged message #', { maxTries: Math.min(400_000, Math.ceil(30 / p8)), deadlineMs: 120_000 })
  check('reuse: a forgery is found within ~30× the expected tries', !!res.found, `p=${p8} tries=${res.tries}`)
  if (res.found) {
    check('reuse: the forged message was never signed', !res.found.message.startsWith('LUSCA exposure demo'))
    check('reuse: the forged signature verifies against the same public key', await verify(kp.publicKey, res.found.message, res.found.signature.values))
    console.log(`  forged "${res.found.message}" after ${res.tries} tries (chance per try ${p8.toExponential(2)}) in ${Math.round(res.ms)} ms`)
  }
}

console.log(`wots: ${passed} passed, ${failed} failed`)
if (failed) throw new Error(`${failed} WOTS test(s) failed`)
