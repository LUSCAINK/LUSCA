// Keccak-256 (the Ethereum hash, i.e. Keccak with the original 0x01 padding, not FIPS SHA3-256) and
// the two EVM address helpers discovery needs:
//   - EIP-55 checksums: an address written in mixed case whose checksum does not hold is a typo or a
//     made-up example (common in generated docs), so the web extractor drops it;
//   - CREATE addresses: a contract deployed by a top-level transaction (to = null) lives at
//     keccak256(rlp([sender, nonce]))[12:], so block sampling learns new contracts without a receipt.
// Dependency-free; 64-bit lanes are kept as (lo, hi) uint32 pairs.

const RC_LO = new Uint32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001, 0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009, 0x8000000a,
  0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080, 0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
])
const RC_HI = new Uint32Array([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
])
// rho rotation of lane x + 5y
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]
// pi: lane x + 5y moves to lane y + 5((2x + 3y) mod 5)
const PI = new Array<number>(25)
for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) PI[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5)

function keccakF(s: Uint32Array): void {
  const bLo = new Uint32Array(25)
  const bHi = new Uint32Array(25)
  const cLo = new Uint32Array(5)
  const cHi = new Uint32Array(5)
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      cLo[x] = s[2 * x] ^ s[2 * (x + 5)] ^ s[2 * (x + 10)] ^ s[2 * (x + 15)] ^ s[2 * (x + 20)]
      cHi[x] = s[2 * x + 1] ^ s[2 * (x + 5) + 1] ^ s[2 * (x + 10) + 1] ^ s[2 * (x + 15) + 1] ^ s[2 * (x + 20) + 1]
    }
    for (let x = 0; x < 5; x++) {
      const l1 = cLo[(x + 1) % 5]
      const h1 = cHi[(x + 1) % 5]
      const dLo = cLo[(x + 4) % 5] ^ ((l1 << 1) | (h1 >>> 31))
      const dHi = cHi[(x + 4) % 5] ^ ((h1 << 1) | (l1 >>> 31))
      for (let y = 0; y < 25; y += 5) {
        s[2 * (x + y)] ^= dLo
        s[2 * (x + y) + 1] ^= dHi
      }
    }
    // rho + pi
    for (let i = 0; i < 25; i++) {
      const lo = s[2 * i]
      const hi = s[2 * i + 1]
      const n = ROT[i]
      const j = PI[i]
      if (n === 0) {
        bLo[j] = lo
        bHi[j] = hi
      } else if (n < 32) {
        bLo[j] = (lo << n) | (hi >>> (32 - n))
        bHi[j] = (hi << n) | (lo >>> (32 - n))
      } else if (n === 32) {
        bLo[j] = hi
        bHi[j] = lo
      } else {
        const m = n - 32
        bLo[j] = (hi << m) | (lo >>> (32 - m))
        bHi[j] = (lo << m) | (hi >>> (32 - m))
      }
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = x + y
        const i1 = ((x + 1) % 5) + y
        const i2 = ((x + 2) % 5) + y
        s[2 * i] = bLo[i] ^ (~bLo[i1] & bLo[i2])
        s[2 * i + 1] = bHi[i] ^ (~bHi[i1] & bHi[i2])
      }
    }
    // iota
    s[0] ^= RC_LO[round]
    s[1] ^= RC_HI[round]
  }
}

/** Keccak sponge with a 256-bit output. `pad` = 0x01 (Keccak / Ethereum) or 0x06 (FIPS SHA3-256). */
export function keccakSponge256(data: Uint8Array, pad = 0x01): Uint8Array {
  const rate = 136
  const s = new Uint32Array(50)
  const absorb = (block: Uint8Array) => {
    for (let i = 0; i < rate; i += 4) {
      const w = block[i] | (block[i + 1] << 8) | (block[i + 2] << 16) | (block[i + 3] << 24)
      s[i >> 2] ^= w
    }
    keccakF(s)
  }
  let off = 0
  for (; off + rate <= data.length; off += rate) absorb(data.subarray(off, off + rate))
  const last = new Uint8Array(rate)
  last.set(data.subarray(off))
  last[data.length - off] ^= pad
  last[rate - 1] ^= 0x80
  absorb(last)
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = (s[i >> 2] >>> (8 * (i & 3))) & 0xff
  return out
}

export function keccak256(data: Uint8Array | string): Uint8Array {
  return keccakSponge256(typeof data === 'string' ? new TextEncoder().encode(data) : data, 0x01)
}

export const toHex = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex')

const HEX40 = /^0x[0-9a-fA-F]{40}$/

/** True for 0x + 40 hex digits (any case). */
export const isEvmAddress = (s: unknown): s is string => typeof s === 'string' && HEX40.test(s)

/** EIP-55 mixed-case checksum form of a 0x address. */
export function toChecksumAddress(addr: string): string {
  const lower = addr.slice(2).toLowerCase()
  const h = toHex(keccak256(lower))
  let out = '0x'
  for (let i = 0; i < 40; i++) {
    const c = lower[i]
    out += c >= 'a' && c <= 'f' && parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c
  }
  return out
}

/**
 * Checksum verdict of an address as written: all-lower / all-upper hex carries no checksum ('none');
 * mixed case must match EIP-55 exactly ('valid' / 'invalid').
 */
export function checksumStatus(addr: string): 'none' | 'valid' | 'invalid' {
  const body = addr.slice(2)
  if (body === body.toLowerCase() || body === body.toUpperCase()) return 'none'
  return toChecksumAddress(addr) === `0x${body}` ? 'valid' : 'invalid'
}

/** Minimal big-endian bytes of a non-negative integer (0 → empty). */
function intBytes(n: bigint): Uint8Array {
  const out: number[] = []
  while (n > 0n) {
    out.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  return Uint8Array.from(out)
}

/** Address of the contract that `sender` creates with CREATE at `nonce` (EIP-55 checksummed). */
export function createAddress(sender: string, nonce: bigint | number): string {
  if (!isEvmAddress(sender)) throw new Error('bad sender')
  const from = Buffer.from(sender.slice(2), 'hex')
  const nb = intBytes(BigInt(nonce))
  // rlp(nonce): 0 → 0x80, a single byte < 0x80 → itself, else 0x80+len ‖ bytes
  const rlpNonce = nb.length === 0 ? Uint8Array.of(0x80) : nb.length === 1 && nb[0] < 0x80 ? nb : Uint8Array.from([0x80 + nb.length, ...nb])
  const payload = 21 + rlpNonce.length // 0x94 ‖ 20-byte sender, then the nonce
  const rlp = new Uint8Array(1 + payload)
  rlp[0] = 0xc0 + payload
  rlp[1] = 0x94
  rlp.set(from, 2)
  rlp.set(rlpNonce, 22)
  return toChecksumAddress(`0x${toHex(keccak256(rlp)).slice(24)}`)
}
