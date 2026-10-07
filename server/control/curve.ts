// Is a 32-byte Solana address a point on the ed25519 curve?
//
//   on the curve  → it can be an ed25519 public key: somebody may hold its secret key (a keypair)
//   off the curve → no secret key exists: a program-derived address (PDA), signable only by its program
//
// Point decompression per RFC 8032 §5.1.3: y from the low 255 bits (little-endian), the top bit is the
// sign of x; x² = (y² − 1) / (d·y² + 1) must have a square root mod p = 2^255 − 19. Like Solana's runtime
// (curve25519-dalek CompressedEdwardsY::decompress, behind Pubkey::is_on_curve and find_program_address),
// a y ≥ p is reduced mod p and x = 0 with the sign bit set is accepted, so the answer matches the chain's
// own PDA rule on every input.

import { base58Decode } from '../../shared/base58.ts'

const P = (1n << 255n) - 19n
const mod = (a: bigint) => {
  const r = a % P
  return r >= 0n ? r : r + P
}
function pow(b: bigint, e: bigint): bigint {
  let r = 1n
  b = mod(b)
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P
    b = (b * b) % P
    e >>= 1n
  }
  return r
}
const D = mod(-121665n * pow(121666n, P - 2n))
const SQRT_M1 = pow(2n, (P - 1n) / 4n)

/** ed25519 point decompression succeeds for these 32 bytes. */
export function isOnCurveBytes(b: Uint8Array): boolean {
  if (b.length !== 32) return false
  let y = 0n
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? b[i] & 0x7f : b[i])
  y = mod(y)
  const y2 = (y * y) % P
  const u = mod(y2 - 1n)
  const v = mod(D * y2 + 1n)
  // x = u·v³·(u·v⁷)^((p−5)/8)
  const v3 = (v * v % P) * v % P
  const v7 = (v3 * v3 % P) * v % P
  let x = (u * v3 % P) * pow(u * v7 % P, (P - 5n) / 8n) % P
  const vx2 = v * (x * x % P) % P
  if (vx2 === u) return true
  if (vx2 === mod(-u)) {
    x = (x * SQRT_M1) % P
    return true
  }
  return false
}

/** On-curve check of a base58 Solana address; null when it is not a 32-byte address. */
export function isOnCurve(address: string): boolean | null {
  const b = base58Decode(address)
  if (!b || b.length !== 32) return null
  return isOnCurveBytes(b)
}
