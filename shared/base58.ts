// Base58 (Bitcoin / Solana alphabet) for wallet addresses, signatures and secret keys.
// Dependency-free so the server, the desktop neuron and the client share one implementation.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const INDEX = new Int16Array(128).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET.charCodeAt(i)] = i

/** Bytes → base58 text. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  // base-256 → base-58, digits little-endian
  const digits: number[] = []
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]]
  return out
}

/** base58 text → bytes, or null when the text holds a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array | null {
  if (typeof text !== 'string') return null
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros++
  const bytes: number[] = [] // little-endian base-256
  for (let i = zeros; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const v = c < 128 ? INDEX[c] : -1
    if (v < 0) return null
    let carry = v
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  const out = new Uint8Array(zeros + bytes.length)
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i]
  return out
}

/** A Solana address: base58 that decodes to exactly 32 bytes. Returns the bytes or null. */
export function solanaAddressBytes(addr: unknown): Uint8Array | null {
  if (typeof addr !== 'string' || addr.length < 32 || addr.length > 44) return null
  const b = base58Decode(addr)
  return b && b.length === 32 ? b : null
}

/** True when `addr` is a canonical Solana address (base58 of exactly 32 bytes, no stray leading '1's). */
export function isSolanaAddress(addr: unknown): addr is string {
  const b = solanaAddressBytes(addr)
  return !!b && base58Encode(b) === addr
}
