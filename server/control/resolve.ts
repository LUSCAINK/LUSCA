// Who can change the code: the classification rules of the CONTROL MAP (shared/control.ts).
//
// Solana — zero RPC, from the stored read (loader, upgradeable, upgrade authority):
//   no authority / non-upgradeable loader → immutable · authority on the ed25519 curve → single key ·
//   authority off the curve → program-derived address (PDA)
// EVM — non-proxy → immutable; proxies are resolved over RPC (resolveEvm, a few eth_getStorageAt / eth_getCode /
//   eth_call per proxy, cached per controller):
//   EIP-1967 admin slot (ZeppelinOS admin slot for those proxies; beacon slot → beacon) or, when the slot is
//   empty, owner() through the proxy (UUPS) → the controller: no code = single key · getThreshold() + getOwners()
//   = Safe N of M · getMinDelay() = timelock · ProxyAdmin (getProxyAdmin(proxy) names it, or
//   UPGRADE_INTERFACE_VERSION() answers) → its owner(), one hop · anything else = other contract.

import type { ChainId, ChainRead } from '../../shared/chain.ts'
import type { ControlClass, ControlEntry, ControlHop } from '../../shared/control.ts'
import { isOnCurve } from './curve.ts'

export const SLOT = {
  eip1967Admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  eip1967Beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  zeppelinosAdmin: '0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b',
} as const

export const SEL = {
  owner: '0x8da5cb5b',
  getThreshold: '0xe75235b8',
  getOwners: '0xa0e67e2b',
  getMinDelay: '0xf27a0c92',
  getProxyAdmin: '0xf3b7dead',
  upgradeInterfaceVersion: '0xad3cb1cc',
} as const

const PROXY_LABEL: Record<string, string> = { eip1967: 'EIP-1967 proxy', eip1822: 'EIP-1822 proxy', beacon: 'beacon proxy', eip1167: 'EIP-1167 clone', other: 'proxy' }

// ─── Solana ──────────────────────────────────────────────────────────────────

export function classifySolana(read: ChainRead): Omit<ControlEntry, 'at' | 'calls'> {
  const base = { chain: read.chain, address: read.address, name: read.name }
  const prog: ControlHop = { kind: 'program', address: read.address, label: read.loader ? `program · ${read.loader}` : 'program' }
  if (read.loader === 'native') return { ...base, cls: 'immutable', hops: [prog], basis: 'built-in program (native loader)' }
  if (read.loader === 'bpf-loader-1' || read.loader === 'bpf-loader-2')
    return { ...base, cls: 'immutable', hops: [prog], basis: `${read.loader}: not upgradeable` }
  const auth = read.upgradeAuthority
  if (read.upgradeable === false || (read.upgradeable !== true && !auth))
    return { ...base, cls: 'immutable', hops: [prog], basis: read.loader === 'loader-v4' ? 'loader-v4 program, finalized' : 'no upgrade authority' }
  if (!auth) return { ...base, cls: 'unknown', hops: [prog], basis: 'upgradeable; authority not in the stored read' }
  const on = isOnCurve(auth)
  if (on === null) return { ...base, cls: 'unknown', hops: [prog], basis: 'upgrade authority is not a 32-byte address' }
  const hop: ControlHop = on
    ? { kind: 'key', address: auth, label: 'single key', via: 'upgrade authority' }
    : { kind: 'pda', address: auth, label: 'program-derived address', via: 'upgrade authority' }
  return {
    ...base,
    cls: on ? 'key' : 'pda',
    hops: [prog, hop],
    basis: on ? 'upgrade authority is an ed25519 point (a keypair)' : 'upgrade authority is off the ed25519 curve (a PDA)',
  }
}

// ─── EVM ─────────────────────────────────────────────────────────────────────

/** eth_call / eth_getStorageAt / eth_getCode on one chain. Rejects with RpcError (kind 'rpc' = the node answered with an error). */
export type EvmCall = (method: string, params: unknown[]) => Promise<unknown>

/** A call the node answered with an error (revert, unknown selector): "no answer", not a failure to retry. */
const answeredNo = (e: unknown) => e instanceof Error && e.name === 'RpcError' && (e as { kind?: string }).kind === 'rpc'

/** A 32-byte word holding an address (12 zero bytes, then 20 non-zero bytes), or null. */
export function wordToAddress(v: unknown): string | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) return null
  const raw = v.slice(2).toLowerCase()
  if (raw.length > 64) return null
  const h = raw.padStart(64, '0')
  if (!/^0{24}/.test(h)) return null
  const a = h.slice(24)
  return /^0+$/.test(a) ? null : `0x${a}`
}

function wordToUint(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v)) return null
  return BigInt(v)
}

/** ABI-decoded address[] return value (getOwners()), or null. */
export function decodeAddressArray(v: unknown): string[] | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v) || v.length < 2 + 128) return null
  const h = v.slice(2)
  const off = Number(BigInt(`0x${h.slice(0, 64)}`))
  if (off !== 32) return null
  const n = Number(BigInt(`0x${h.slice(64, 128)}`))
  if (!Number.isInteger(n) || n < 1 || n > 500 || h.length < 128 + n * 64) return null
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const a = wordToAddress(`0x${h.slice(128 + i * 64, 192 + i * 64)}`)
    if (!a) return null
    out.push(a)
  }
  return out
}

export const fmtDelay = (s: number) =>
  s >= 86400 && s % 86400 === 0 ? `${s / 86400}d` : s >= 3600 ? `${+(s / 3600).toFixed(1)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`

/** What one controller address is (no further hops). */
export interface ControllerInfo {
  kind: 'eoa' | 'safe' | 'timelock' | 'proxyadmin' | 'contract'
  label: string
  threshold?: number
  owners?: number
  delay?: number
  /** owner() of the controller, when it answered (ProxyAdmin and other owned contracts). */
  owner?: string | null
}

async function tryCall(call: EvmCall, to: string, data: string): Promise<unknown> {
  try {
    const r = await call('eth_call', [{ to, data }, 'latest'])
    return typeof r === 'string' && r.length > 2 ? r : null
  } catch (e) {
    if (answeredNo(e)) return null
    throw e
  }
}

/** Identify one address. `proxy`: the proxy it administers (for the ProxyAdmin check). */
export async function identify(call: EvmCall, address: string, proxy: string | null): Promise<ControllerInfo> {
  const code = await call('eth_getCode', [address, 'latest'])
  if (typeof code !== 'string' || code === '0x' || code === '0x0' || code === '') return { kind: 'eoa', label: 'single key' }
  const t = wordToUint(await tryCall(call, address, SEL.getThreshold))
  if (t !== null && t >= 1n && t <= 500n) {
    const owners = decodeAddressArray(await tryCall(call, address, SEL.getOwners))
    if (owners && owners.length >= Number(t)) return { kind: 'safe', label: `Safe ${t} of ${owners.length}`, threshold: Number(t), owners: owners.length }
  }
  const d = wordToUint(await tryCall(call, address, SEL.getMinDelay))
  if (d !== null && d < 10n * 365n * 86400n) return { kind: 'timelock', label: `timelock ${fmtDelay(Number(d))}`, delay: Number(d) }
  const owner = wordToAddress(await tryCall(call, address, SEL.owner))
  if (owner) {
    let pa = false
    if (proxy) {
      const named = wordToAddress(await tryCall(call, address, SEL.getProxyAdmin + proxy.slice(2).toLowerCase().padStart(64, '0')))
      pa = named === address.toLowerCase()
      if (!pa) pa = (await tryCall(call, address, SEL.upgradeInterfaceVersion)) !== null
    }
    return { kind: pa ? 'proxyadmin' : 'contract', label: pa ? 'ProxyAdmin' : 'contract with owner()', owner }
  }
  return { kind: 'contract', label: 'contract' }
}

const CLS_OF: Record<ControllerInfo['kind'], ControlClass> = { eoa: 'key', safe: 'safe', timelock: 'timelock', proxyadmin: 'contract', contract: 'contract' }

const hopOf = (address: string, info: ControllerInfo, via: string): ControlHop => ({
  kind: info.kind,
  address,
  label: info.label,
  via,
  ...(info.threshold ? { threshold: info.threshold, owners: info.owners } : {}),
  ...(info.delay !== undefined ? { delay: info.delay } : {}),
})

/** Cache of identify() by address (a ProxyAdmin or Safe often controls many proxies). */
export interface IdentifyCache {
  get(chain: ChainId, address: string): ControllerInfo | null
  set(chain: ChainId, address: string, info: ControllerInfo): void
}

/** EVM: non-proxy → immutable; a proxy → its controller chain. Throws on budget / network errors (retry later). */
export async function resolveEvm(read: ChainRead, call: EvmCall, cache?: IdentifyCache): Promise<Omit<ControlEntry, 'at' | 'calls'>> {
  const base = { chain: read.chain, address: read.address, name: read.name }
  const addr = read.address.toLowerCase()
  if (!read.proxy) return { ...base, cls: 'immutable', hops: [{ kind: 'contract', address: read.address, label: 'contract' }], basis: 'not a proxy: the deployed code is fixed' }
  const std = read.proxy.standard
  const proxyHop: ControlHop = { kind: std === 'eip1167' ? 'clone' : 'proxy', address: read.address, label: PROXY_LABEL[std] ?? 'proxy' }
  if (std === 'eip1167') return { ...base, cls: 'immutable', hops: [proxyHop], basis: 'EIP-1167 clone: the implementation address is part of the code' }

  const ident = async (a: string, proxy: string | null) => {
    const hit = cache?.get(read.chain, a)
    if (hit) return hit
    const info = await identify(call, a, proxy)
    cache?.set(read.chain, a, info)
    return info
  }
  const slot = async (s: string) => wordToAddress(await call('eth_getStorageAt', [read.address, s, 'latest']))
  const hops: ControlHop[] = [proxyHop]

  // a Safe wallet proxy: its own owners upgrade it
  if (read.notes.some((n) => /Gnosis Safe proxy/i.test(n))) {
    const info = await ident(addr, null)
    if (info.kind === 'safe') return { ...base, cls: 'safe', hops: [{ ...proxyHop, label: 'Safe proxy' }, hopOf(addr, info, 'its own owners')], basis: 'a Safe: its owners can change the singleton' }
  }

  let controller: string | null = null
  let via = 'admin slot'
  if (std === 'beacon') {
    const beacon = await slot(SLOT.eip1967Beacon)
    if (beacon) {
      hops.push({ kind: 'beacon', address: beacon, label: 'beacon', via: 'beacon slot' })
      controller = wordToAddress(await tryCall(call, beacon, SEL.owner))
      via = 'owner()'
    }
  } else {
    controller = await slot(std === 'other' ? SLOT.zeppelinosAdmin : SLOT.eip1967Admin)
    if (!controller && std === 'other') controller = await slot(SLOT.eip1967Admin)
    if (!controller) {
      // UUPS / custom: the implementation's owner(), read through the proxy
      controller = wordToAddress(await tryCall(call, read.address, SEL.owner))
      via = 'owner()'
    }
  }
  if (!controller) return { ...base, cls: 'unknown', hops, basis: std === 'beacon' ? 'beacon owner() did not answer' : 'admin slot empty; owner() did not answer' }

  const info = await ident(controller, std === 'beacon' ? null : read.address)
  hops.push(hopOf(controller, info, via))
  let cls = CLS_OF[info.kind]
  let basis = `${via} → ${info.label}`
  // one hop further: who owns the ProxyAdmin (or the owned contract)
  if ((info.kind === 'proxyadmin' || info.kind === 'contract') && info.owner && info.owner !== controller.toLowerCase()) {
    const o = await ident(info.owner, null)
    hops.push(hopOf(info.owner, { ...o, owner: undefined }, 'owner()'))
    cls = CLS_OF[o.kind]
    basis += ` → owner() → ${o.label}`
  }
  return { ...base, cls, hops, basis }
}
