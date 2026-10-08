// EXPOSURE, EVM: an address is the last 20 bytes of keccak256(public key); the key stays hidden until the address
// signs. Reads: nonce on every supported EVM chain (one key signs on all), code on the asked chain and on every
// other chain whose nonce is > 0 (a contract starts at nonce 1 since EIP-161, so a contract nonce is not a
// signature), balance on the asked chain; code 0xef0100 + 20 bytes = EIP-7702 delegation; a contract answering
// getThreshold() / getOwners() is a Safe, whose nonce() and owners (nonce + code on every chain) are read too:
// owners' ECDSA signatures are published in execTransaction calldata whenever the Safe executes.
import { decodeAddressArray } from '../control/resolve.ts'
import { RpcError } from '../chain/rpc.ts'
import { EXPOSURE_EVM_CHAINS, type ExposureChain, type ExposureControl, type ExposureHolds, type ExposureKey, type ExposureSafe, type ExposureSafeOwner } from '../../src/lib/exposure-types.ts'
import { type KnownIndex, type LookupCtx, type LookupResult, controlFromEntry, formatUnits, pool, reasonOf, short } from './common.ts'

const GET_THRESHOLD = '0xe75235b8'
const GET_OWNERS = '0xa0e67e2b'
const SAFE_NONCE = '0xaffed0e0'
const MAX_OWNERS = 10

/** 0xef0100 + 20-byte address → the delegate, else null. */
export function delegationOf(code: string): string | null {
  const c = code.toLowerCase()
  return /^0xef0100[0-9a-f]{40}$/.test(c) ? `0x${c.slice(8)}` : null
}

export const hexInt = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v) ? BigInt(v === '0x' ? 0 : v) : null)

/** An eth_call that the node executed and that reverted (or the method answered with a plain error): "not a Safe". */
export const isRevert = (e: unknown) => e instanceof RpcError && e.kind === 'rpc' && !e.transient

export function verdictOfNonce(n: number | null, chainsRead: number): Pick<ExposureKey, 'exposed' | 'verdict' | 'basis'> {
  if (n === null) return { exposed: null, verdict: 'Not read', basis: 'The nonce could not be read.' }
  if (n > 0) return { exposed: true, verdict: 'Exposed', basis: `This address has sent ${n} transaction${n > 1 ? 's' : ''} (account nonce${chainsRead > 1 ? 's summed over the EVM chains read' : ''}). Each carries an ECDSA signature from which the public key is recoverable.` }
  return {
    exposed: false,
    verdict: 'Not exposed by any transaction',
    basis: `Nonce 0 on every EVM chain read (${chainsRead}) and no code: no transaction from this address publishes its key. A signature published elsewhere (a Safe co-signature, a permit, a signed message) can still reveal it; this is not a statement that the key is safe.`,
  }
}

type CodeState = 'none' | 'contract' | '7702' | null
export interface ChainFacts {
  chain: ExposureChain
  txCount: number | null
  /** null = not read (only read on the asked chain and where the nonce is > 0). */
  code: CodeState
  delegate?: string
  bytes?: number
}

const codeState = (v: unknown): { s: CodeState; delegate?: string; bytes: number } => {
  const c = typeof v === 'string' ? v : '0x'
  if (c === '0x' || c === '0x0') return { s: 'none', bytes: 0 }
  const d = delegationOf(c)
  return d ? { s: '7702', delegate: d, bytes: 23 } : { s: 'contract', bytes: Math.max(0, (c.length - 2) / 2) }
}

/** Nonce on every EVM chain; code on `home` and wherever the nonce is > 0. */
async function chainFacts(ctx: LookupCtx, partial: string[], who: string, home: ExposureChain, label: string): Promise<ChainFacts[]> {
  return Promise.all(
    EXPOSURE_EVM_CHAINS.map(async (c): Promise<ChainFacts> => {
      let txCount: number | null = null
      try {
        const v = hexInt(await ctx.call(c, 'eth_getTransactionCount', [who, 'latest']))
        txCount = v === null ? null : Number(v)
      } catch (e) {
        partial.push(reasonOf(`Nonce on ${c}${label}`, e))
      }
      const out: ChainFacts = { chain: c, txCount, code: null }
      if (c === home || (txCount ?? 0) > 0) {
        try {
          const k = codeState(await ctx.call(c, 'eth_getCode', [who, 'latest']))
          out.code = k.s
          out.bytes = k.bytes
          if (k.delegate) out.delegate = k.delegate
        } catch (e) {
          partial.push(reasonOf(`Code on ${c}${label}`, e))
        }
      }
      return out
    }),
  )
}

/** Transactions sent by a key: nonces of the chains where the address is not a contract (contract nonces count deployments). */
export function keyNonce(f: ChainFacts[]): { total: number; read: number } {
  const keyChains = f.filter((c) => c.txCount !== null && c.code !== 'contract' && !(c.code === null && (c.txCount ?? 0) > 0))
  return { total: keyChains.reduce((s, c) => s + (c.txCount as number), 0), read: keyChains.length }
}

export async function lookupEvm(ctx: LookupCtx, chain: ExposureChain, address: string, known: KnownIndex): Promise<LookupResult> {
  const partial: string[] = []
  const notes: string[] = []
  const controls: ExposureControl[] = []
  const a = address.toLowerCase()

  const facts = await chainFacts(ctx, partial, a, chain, '')
  let native: ExposureHolds['native'] = null
  try {
    const wei = hexInt(await ctx.call(chain, 'eth_getBalance', [a, 'latest']))
    if (wei !== null) native = { symbol: 'ETH', amount: formatUnits(wei, 18), raw: wei.toString() }
  } catch (e) {
    partial.push(reasonOf('ETH balance', e))
  }
  const holds: ExposureHolds = { native, tokens: [], tokenCount: 0, truncated: false }
  partial.push('ERC-20 balances: not read in this version')

  const chains = facts.map((c) => ({ chain: c.chain, txCount: c.txCount, ...(c.code === 'contract' ? { contract: true } : {}) }))
  const here = facts.find((c) => c.chain === chain) as ChainFacts
  const contractOn = facts.filter((c) => c.code === 'contract').map((c) => c.chain)
  const delegated = facts.find((c) => c.code === '7702')
  const { total, read } = keyNonce(facts)
  let key: ExposureKey
  let safe: ExposureSafe | undefined
  if (here.code === null) {
    key = { kind: 'unknown', curve: null, exposed: null, verdict: 'Not read', basis: 'The account code could not be read, so it is not known whether a key controls this address.', chains }
  } else if (here.code === 'none' && contractOn.length) {
    key = {
      kind: 'contract',
      curve: null,
      exposed: null,
      verdict: `Contract on ${contractOn.join(', ')} (no private key)`,
      basis: `No code on ${chain}, but the same address holds contract code on ${contractOn.join(', ')}. A contract address is derived from its deployer (CREATE / CREATE2), so no private key exists for it; the nonce there counts contracts it created, not signatures.`,
      chains,
    }
  } else if (here.code === '7702' || (here.code === 'none' && delegated)) {
    const d = delegated as ChainFacts
    key = { kind: 'eoa-7702', curve: 'secp256k1', exposed: true, verdict: 'Exposed (EIP-7702 delegated)', basis: `The code on ${d.chain} is an EIP-7702 delegation (0xef0100…) to ${short(d.delegate as string)}. Setting it took a signed authorization, so the key is public, and the original key still controls the account.`, delegate: d.delegate, ...(here.txCount !== null ? { txCount: here.txCount } : {}), chains }
  } else if (here.code === 'none') {
    const unknownOn = facts.filter((c) => c.code === null && (c.txCount ?? 0) > 0).map((c) => c.chain)
    key = { kind: 'eoa', curve: 'secp256k1', ...(read ? verdictOfNonce(total, read) : verdictOfNonce(null, 0)), ...(here.txCount !== null ? { txCount: here.txCount } : {}), chains }
    if (total === 0 && unknownOn.length) Object.assign(key, { exposed: null, verdict: 'Not read', basis: `Nonce 0 here, but the code on ${unknownOn.join(', ')} (where the nonce is above 0) could not be read, so it is not known whether those are sent transactions.` })
    else if (read < EXPOSURE_EVM_CHAINS.length && total === 0) key.basis += ' Not every EVM chain answered.'
  } else {
    // a contract here: Safe? Only an executed revert means "not a Safe"; any other failure is reported.
    let threshold: number | null = null
    let owners: string[] | null = null
    let checkFailed = false
    try {
      const t = hexInt(await ctx.call(chain, 'eth_call', [{ to: a, data: GET_THRESHOLD }, 'latest']))
      if (t !== null && t > 0n && t < 1000n) {
        threshold = Number(t)
        owners = decodeAddressArray(await ctx.call(chain, 'eth_call', [{ to: a, data: GET_OWNERS }, 'latest']))
      }
    } catch (e) {
      if (!isRevert(e)) {
        checkFailed = true
        partial.push(reasonOf('Safe check (getThreshold / getOwners)', e))
      }
    }
    if (threshold !== null && owners && owners.length) {
      let safeNonce: number | null = null
      try {
        const v = hexInt(await ctx.call(chain, 'eth_call', [{ to: a, data: SAFE_NONCE }, 'latest']))
        safeNonce = v === null ? null : Number(v)
      } catch (e) {
        partial.push(reasonOf('Safe nonce()', e))
      }
      const list = owners.slice(0, MAX_OWNERS)
      const ownerRows: ExposureSafeOwner[] = await pool(list, 3, async (o): Promise<ExposureSafeOwner> => {
        const f = await chainFacts(ctx, partial, o.toLowerCase(), chain, ` of owner ${short(o)}`)
        const cOn = f.filter((c) => c.code === 'contract').map((c) => c.chain)
        if (cOn.length) return { address: o, exposed: null, contract: true, basis: `Contract owner (code on ${cOn.join(', ')}): a nested Safe or EIP-1271 wallet has no key of its own; its own signers carry the exposure.` }
        const n = keyNonce(f)
        const sent = f.find((c) => c.chain === chain)?.txCount
        if (n.read === 0) return { address: o, exposed: null, basis: 'The owner\'s nonce could not be read.' }
        if (n.total > 0) return { address: o, exposed: true, txCount: n.total, basis: `Nonce ${n.total} summed over ${n.read} EVM chain${n.read > 1 ? 's' : ''} read${sent ? ` (${sent} on ${chain})` : ''}: its public key is recoverable from any sent transaction.` }
        if (safeNonce !== null && safeNonce > 0)
          return { address: o, exposed: null, txCount: 0, basis: `Nonce 0 on every EVM chain read, but this Safe has executed ${safeNonce} transaction${safeNonce > 1 ? 's' : ''}. Each execution publishes the ECDSA signatures of the owners who signed it, so this key may already be public.` }
        return { address: o, exposed: safeNonce === 0 ? false : null, txCount: 0, basis: safeNonce === 0 ? 'Nonce 0 on every EVM chain read and this Safe has not executed yet: not exposed by any transaction. Its signature is published when it signs a Safe execution.' : 'Nonce 0 on every EVM chain read; the Safe nonce was not read, so a published co-signature cannot be ruled out.' }
      })
      if (owners.length > MAX_OWNERS) partial.push(`Safe owners: ${owners.length}, first ${MAX_OWNERS} read`)
      safe = { threshold, owners: ownerRows, ...(safeNonce !== null ? { nonce: safeNonce } : {}) }
      const exposedN = ownerRows.filter((r) => r.exposed === true).length
      const mayN = ownerRows.filter((r) => r.exposed === null && !r.contract && r.txCount === 0).length
      key = {
        kind: 'safe',
        curve: null,
        exposed: null,
        verdict: `Safe ${threshold} of ${owners.length}`,
        basis: `A Safe has no key of its own. ${exposedN} of ${ownerRows.length} owners read have sent transactions on the EVM chains read (key public).${safeNonce !== null ? ` The Safe nonce is ${safeNonce}: ${safeNonce > 0 ? 'every execution published the signatures of the owners who signed it' : 'it has not executed a transaction yet'}.` : ''}`,
        chains,
      }
      notes.push(
        exposedN >= threshold
          ? `${threshold} owner signature${threshold > 1 ? 's are' : ' is'} needed and ${exposedN} owner key${exposedN > 1 ? 's are' : ' is'} already public: if the signature math breaks, those keys would be enough to sign for this Safe.`
          : `${threshold} owner signature${threshold > 1 ? 's are' : ' is'} needed; ${exposedN} of the ${ownerRows.length} owner keys read are public from sent transactions${mayN ? `, and ${mayN} more may be public from this Safe's own executions` : ''}.`,
      )
    } else {
      key = {
        kind: 'contract',
        curve: null,
        exposed: null,
        verdict: checkFailed ? 'Contract (Safe check not read)' : 'Contract (no private key)',
        basis: `The address has code (${here.bytes ?? 0} bytes). No key signs as it; whoever can change it is listed under controls when LUSCA knows it.${checkFailed ? ' Whether it is a Safe could not be read (see partial).' : ''}`,
        chains,
      }
    }
  }
  for (const e of known.controlledBy(a)) {
    const c = controlFromEntry(e, a, false)
    if (c) controls.push(c)
  }
  for (const s of known.safesOf(a))
    controls.push({ kind: 'safe-owner-of', chain: s.chain, target: s.address, label: `Owner of a Safe (${s.threshold} of ${s.owners})`, via: 'Safe getOwners()', evidence: `Safe ${short(s.address)} on ${s.chain} lists this address as an owner (read ${new Date(s.at).toISOString().slice(0, 10)})`, href: `/control?q=${s.address}` })
  if (key.kind === 'eoa' || key.kind === 'eoa-7702') notes.push('One secp256k1 key signs on every EVM chain: an exposure on one chain exposes the key on all of them.')
  if (key.kind === 'eoa' && controls.length === 0) partial.push("Controls: only contracts in LUSCA's Control Map are checked; contracts outside it that this key owns are not listed")
  return { key, holds, controls, ...(safe ? { safe } : {}), partial, notes }
}
