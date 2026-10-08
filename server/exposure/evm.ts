// EXPOSURE, EVM: an address is the last 20 bytes of keccak256(public key); the key stays hidden until the address
// signs. Reads: nonce on every supported EVM chain (one key signs on all), code + balance on the asked chain;
// code 0xef0100 + 20 bytes = EIP-7702 delegation; a contract answering getThreshold() / getOwners() is a Safe,
// whose owners' nonces are read too (their ECDSA signatures are published at execTransaction).
import { decodeAddressArray } from '../control/resolve.ts'
import { EXPOSURE_EVM_CHAINS, type ExposureChain, type ExposureControl, type ExposureHolds, type ExposureKey, type ExposureSafe, type ExposureSafeOwner } from '../../src/lib/exposure-types.ts'
import { type KnownIndex, type LookupCtx, type LookupResult, controlFromEntry, formatUnits, pool, reasonOf, short } from './common.ts'

const GET_THRESHOLD = '0xe75235b8'
const GET_OWNERS = '0xa0e67e2b'
const MAX_OWNERS = 10

/** 0xef0100 + 20-byte address → the delegate, else null. */
export function delegationOf(code: string): string | null {
  const c = code.toLowerCase()
  return /^0xef0100[0-9a-f]{40}$/.test(c) ? `0x${c.slice(8)}` : null
}

export const hexInt = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v) ? BigInt(v === '0x' ? 0 : v) : null)

export function verdictOfNonce(n: number | null, chainsRead: number): Pick<ExposureKey, 'exposed' | 'verdict' | 'basis'> {
  if (n === null) return { exposed: null, verdict: 'Not read', basis: 'The nonce could not be read.' }
  if (n > 0) return { exposed: true, verdict: 'Exposed', basis: `This address has sent ${n} transaction${n > 1 ? 's' : ''} (account nonce${chainsRead > 1 ? 's summed over the EVM chains read' : ''}). Each carries an ECDSA signature from which the public key is recoverable.` }
  return {
    exposed: false,
    verdict: 'Not exposed by any transaction',
    basis: `Nonce 0 on every EVM chain read (${chainsRead}) and no code: no transaction from this address publishes its key. A signature published elsewhere (a Safe co-signature, a permit, a signed message) can still reveal it; this is not a statement that the key is safe.`,
  }
}

export async function lookupEvm(ctx: LookupCtx, chain: ExposureChain, address: string, known: KnownIndex): Promise<LookupResult> {
  const partial: string[] = []
  const notes: string[] = []
  const controls: ExposureControl[] = []
  const a = address.toLowerCase()

  const nonceOn = async (c: ExposureChain, who: string): Promise<number | null> => {
    try {
      const v = hexInt(await ctx.call(c, 'eth_getTransactionCount', [who, 'latest']))
      return v === null ? null : Number(v)
    } catch (e) {
      partial.push(reasonOf(`Nonce on ${c}${who === a ? '' : ` of ${short(who)}`}`, e))
      return null
    }
  }
  const chains = await Promise.all(EXPOSURE_EVM_CHAINS.map(async (c) => ({ chain: c, txCount: await nonceOn(c, a) })))
  let code = '0x'
  let codeRead = true
  try {
    const v = await ctx.call(chain, 'eth_getCode', [a, 'latest'])
    code = typeof v === 'string' ? v : '0x'
  } catch (e) {
    codeRead = false
    partial.push(reasonOf('Code', e))
  }
  let native: ExposureHolds['native'] = null
  try {
    const wei = hexInt(await ctx.call(chain, 'eth_getBalance', [a, 'latest']))
    if (wei !== null) native = { symbol: 'ETH', amount: formatUnits(wei, 18), raw: wei.toString() }
  } catch (e) {
    partial.push(reasonOf('ETH balance', e))
  }
  const holds: ExposureHolds = { native, tokens: [], tokenCount: 0, truncated: false }
  partial.push('ERC-20 balances: not read in this version')

  const read = chains.filter((c) => c.txCount !== null)
  const total = read.reduce((s, c) => s + (c.txCount as number), 0)
  const here = chains.find((c) => c.chain === chain)?.txCount ?? null
  let key: ExposureKey
  let safe: ExposureSafe | undefined
  const delegate = codeRead ? delegationOf(code) : null
  if (!codeRead) {
    key = { kind: 'unknown', curve: null, exposed: null, verdict: 'Not read', basis: 'The account code could not be read, so it is not known whether a key controls this address.', chains }
  } else if (delegate) {
    key = { kind: 'eoa-7702', curve: 'secp256k1', exposed: true, verdict: 'Exposed (EIP-7702 delegated)', basis: `The code is an EIP-7702 delegation (0xef0100…) to ${short(delegate)}. Setting it took a signed authorization, so the key is public, and the original key still controls the account.`, delegate, txCount: here ?? undefined, chains }
  } else if (code === '0x' || code === '0x0') {
    key = { kind: 'eoa', curve: 'secp256k1', ...(read.length ? verdictOfNonce(total, read.length) : verdictOfNonce(null, 0)), ...(here !== null ? { txCount: here } : {}), chains }
    if (read.length < EXPOSURE_EVM_CHAINS.length && total === 0) key.basis += ' Not every EVM chain answered.'
  } else {
    // a contract: Safe?
    let threshold: number | null = null
    let owners: string[] | null = null
    try {
      const t = hexInt(await ctx.call(chain, 'eth_call', [{ to: a, data: GET_THRESHOLD }, 'latest']))
      if (t !== null && t > 0n && t < 1000n) {
        threshold = Number(t)
        owners = decodeAddressArray(await ctx.call(chain, 'eth_call', [{ to: a, data: GET_OWNERS }, 'latest']))
      }
    } catch {
      /* not a Safe */
    }
    if (threshold !== null && owners && owners.length) {
      const list = owners.slice(0, MAX_OWNERS)
      const ownerRows: ExposureSafeOwner[] = await pool(list, 3, async (o) => {
        const n = await nonceOn(chain, o.toLowerCase())
        const v = verdictOfNonce(n, 1)
        return { address: o, exposed: v.exposed, basis: n === null ? v.basis : n > 0 ? `Nonce ${n} on ${chain}: its public key is recoverable from any sent transaction.` : `Nonce 0 on ${chain}. Its ECDSA signature is still published inside execTransaction whenever it signs for this Safe.`, ...(n !== null ? { txCount: n } : {}) }
      })
      if (owners.length > MAX_OWNERS) partial.push(`Safe owners: ${owners.length}, first ${MAX_OWNERS} read`)
      safe = { threshold, owners: ownerRows }
      const exposedN = ownerRows.filter((r) => r.exposed).length
      key = { kind: 'safe', curve: null, exposed: null, verdict: `Safe ${threshold} of ${owners.length}`, basis: `A Safe has no key of its own. ${exposedN} of ${ownerRows.length} owners read have sent transactions on ${chain} (key public). Owners' signatures are published in execTransaction calldata whenever the Safe executes, so every owner who has signed for it is exposed.`, chains }
      notes.push(`If the signature math breaks, ${threshold} exposed owner key${threshold > 1 ? 's' : ''} would be enough to move what this Safe holds.`)
    } else {
      key = { kind: 'contract', curve: null, exposed: null, verdict: 'Contract (no private key)', basis: `The address has code (${Math.max(0, (code.length - 2) / 2)} bytes). No key signs as it; whoever can change it is listed under controls when LUSCA knows it.`, chains }
    }
  }
  for (const e of known.controlledBy(a)) {
    const c = controlFromEntry(e, a, false)
    if (c) controls.push(c)
  }
  for (const s of known.safesOf(a))
    controls.push({ kind: 'safe-owner-of', chain: s.chain, target: s.address, label: `Owner of a Safe (${s.threshold} of ${s.owners})`, via: 'Safe getOwners()', evidence: `Safe ${short(s.address)} on ${s.chain} lists this address as an owner (read ${new Date(s.at).toISOString().slice(0, 10)})`, href: `/control?q=${s.address}` })
  if (key.kind === 'eoa' || key.kind === 'eoa-7702') notes.push('One secp256k1 key signs on every EVM chain: an exposure on one chain exposes the key on all of them.')
  if (key.kind === 'eoa' && controls.length === 0) partial.push('Controls: only contracts in LUSCA\'s Control Map are checked; contracts outside it that this key owns are not listed')
  return { key, holds, controls, ...(safe ? { safe } : {}), partial, notes }
}
