// Ed25519 with node:crypto only (no third-party crypto): raw 32-byte keys as Solana uses them.
//
//   public key  → SPKI DER  302a300506032b6570032100 ‖ 32 raw bytes
//   seed        → PKCS8 DER 302e020100300506032b657004220420 ‖ 32-byte seed
//
// A Solana secret key (Phantom export / solana-keygen JSON) is 64 bytes: seed ‖ public key.

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** KeyObject for a raw 32-byte ed25519 public key (throws on a wrong length). */
export function publicKeyFromRaw32(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error('ed25519 public key must be 32 bytes')
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

/** KeyObject for a 32-byte ed25519 seed (the first half of a Solana secret key). */
export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error('ed25519 seed must be 32 bytes')
  const der = Buffer.concat([PKCS8_PREFIX, seed])
  try {
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  } finally {
    der.fill(0)
  }
}

/** Raw 32-byte public key of a private (or public) KeyObject. */
export function rawPublicKey(key: KeyObject): Uint8Array {
  const pub = key.type === 'private' ? createPublicKey(key) : key
  const der = pub.export({ format: 'der', type: 'spki' })
  return new Uint8Array(der.subarray(der.length - 32))
}

/** Detached ed25519 signature (64 bytes). */
export function signEd25519(message: Uint8Array, key: KeyObject): Uint8Array {
  return new Uint8Array(sign(null, message, key))
}

/** Verify a detached signature; false (never throws) on any malformed input. */
export function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey32: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey32.length !== 32) return false
  try {
    return verify(null, message, publicKeyFromRaw32(publicKey32), signature)
  } catch {
    return false
  }
}
