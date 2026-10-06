// The full interface of a Solana program from its on-chain IDL (Anchor ≤ 0.29, Anchor ≥ 0.30, Codama):
// instructions with their accounts (signer / writable / optional) and typed args, account types,
// errors and events — for Lens. Pure; unknown shapes degrade to '?' instead of failing.

import type { LensIdl, LensIdlAccount, LensIdlInstruction } from '../../shared/lens.ts'
import { idlFormat } from '../chain/solana/idl.ts'

const MAX_INSTRUCTIONS = 400
const MAX_ACCOUNTS = 64
const MAX_ERRORS = 400
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const str = (v: unknown, max = 80): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** Anchor type JSON → 'u64', 'Vec<Pubkey>', 'Option<MyStruct>', '[u8; 32]'. */
export function anchorType(t: unknown, depth = 0): string {
  if (depth > 8) return '…'
  if (typeof t === 'string') return t === 'publicKey' ? 'Pubkey' : t === 'pubkey' ? 'Pubkey' : t
  const o = obj(t)
  if (!o) return '?'
  if ('vec' in o) return `Vec<${anchorType(o.vec, depth + 1)}>`
  if ('option' in o) return `Option<${anchorType(o.option, depth + 1)}>`
  if ('coption' in o) return `COption<${anchorType(o.coption, depth + 1)}>`
  if ('array' in o) {
    const a = arr(o.array)
    return `[${anchorType(a[0], depth + 1)}; ${typeof a[1] === 'number' ? a[1] : typeof a[1] === 'string' ? a[1] : obj(a[1])?.generic ?? '?'}]`
  }
  if ('defined' in o) {
    const d = o.defined
    return typeof d === 'string' ? d : (str(obj(d)?.name) ?? '?')
  }
  if ('generic' in o) return str(o.generic) ?? '?'
  return '?'
}

/** Codama type node → readable type. */
export function codamaType(t: unknown, depth = 0): string {
  if (depth > 8) return '…'
  const o = obj(t)
  if (!o) return '?'
  switch (o.kind) {
    case 'numberTypeNode':
      return str(o.format) ?? 'number'
    case 'publicKeyTypeNode':
      return 'Pubkey'
    case 'booleanTypeNode':
      return 'bool'
    case 'stringTypeNode':
      return 'string'
    case 'bytesTypeNode':
      return 'bytes'
    case 'sizePrefixTypeNode':
    case 'fixedSizeTypeNode':
      return codamaType(o.type, depth + 1)
    case 'arrayTypeNode':
      return `Vec<${codamaType(o.item, depth + 1)}>`
    case 'optionTypeNode':
    case 'zeroableOptionTypeNode':
    case 'remainderOptionTypeNode':
      return `Option<${codamaType(o.item, depth + 1)}>`
    case 'definedTypeLinkNode':
      return str(o.name) ?? '?'
    case 'tupleTypeNode':
      return `(${arr(o.items).map((x) => codamaType(x, depth + 1)).join(', ')})`
    case 'structTypeNode':
      return 'struct'
    case 'enumTypeNode':
      return 'enum'
    default:
      return typeof o.kind === 'string' ? o.kind.replace(/TypeNode$/, '') : '?'
  }
}

function anchorAccounts(list: unknown, legacy: boolean, out: LensIdlAccount[], prefix = '', depth = 0) {
  if (depth > 6) return
  for (const a of arr(list)) {
    if (out.length >= MAX_ACCOUNTS) return
    const o = obj(a)
    if (!o) continue
    const name = `${prefix}${str(o.name) ?? '?'}`
    if (Array.isArray(o.accounts)) {
      anchorAccounts(o.accounts, legacy, out, `${name}.`, depth + 1)
      continue
    }
    out.push({
      name,
      signer: legacy ? o.isSigner === true : o.signer === true,
      writable: legacy ? o.isMut === true : o.writable === true,
      optional: o.optional === true || o.isOptional === true,
    })
  }
}

/** LensIdl of an IDL JSON; null when the JSON is not a recognized IDL. */
export function idlDetail(json: unknown, source: string): LensIdl | null {
  const fmt = idlFormat(json)
  if (!fmt) return null
  const o = json as Record<string, unknown>
  if (fmt === 'codama') {
    const p = obj(o.program) ?? {}
    const instructions: LensIdlInstruction[] = arr(p.instructions)
      .slice(0, MAX_INSTRUCTIONS)
      .map((i) => {
        const io = obj(i) ?? {}
        return {
          name: str(io.name) ?? '?',
          docs: arr(io.docs).filter((d) => typeof d === 'string').join(' ').slice(0, 300) || null,
          accounts: arr(io.accounts)
            .slice(0, MAX_ACCOUNTS)
            .map((a) => {
              const ao = obj(a) ?? {}
              return { name: str(ao.name) ?? '?', signer: ao.isSigner === true || ao.isSigner === 'either', writable: ao.isWritable === true, optional: ao.isOptional === true }
            }),
          args: arr(io.arguments)
            .map((x) => obj(x) ?? {})
            .filter((x) => x.name !== 'discriminator')
            .map((x) => ({ name: str(x.name) ?? '?', type: codamaType(x.type) })),
        }
      })
    return {
      source,
      format: fmt,
      name: str(p.name),
      version: str(p.version, 40),
      instructions,
      accounts: arr(p.accounts).map((a) => str(obj(a)?.name) ?? '?').slice(0, 400),
      types: arr(p.definedTypes).length,
      errors: arr(p.errors)
        .slice(0, MAX_ERRORS)
        .map((e) => {
          const eo = obj(e) ?? {}
          return { code: typeof eo.code === 'number' ? eo.code : null, name: str(eo.name) ?? '?', msg: str(eo.message, 200) }
        }),
      events: [],
    }
  }
  const legacy = fmt === 'anchor-legacy'
  const meta = obj(o.metadata)
  const instructions: LensIdlInstruction[] = arr(o.instructions)
    .slice(0, MAX_INSTRUCTIONS)
    .map((i) => {
      const io = obj(i) ?? {}
      const accounts: LensIdlAccount[] = []
      anchorAccounts(io.accounts, legacy, accounts)
      return {
        name: str(io.name) ?? '?',
        docs: arr(io.docs).filter((d) => typeof d === 'string').join(' ').slice(0, 300) || null,
        accounts,
        args: arr(io.args).map((x) => {
          const xo = obj(x) ?? {}
          return { name: str(xo.name) ?? '?', type: anchorType(xo.type) }
        }),
      }
    })
  return {
    source,
    format: fmt,
    name: legacy ? (str(o.name) ?? str(meta?.name)) : (str(meta?.name) ?? str(o.name)),
    version: legacy ? (str(o.version, 40) ?? str(meta?.version, 40)) : (str(meta?.version, 40) ?? str(o.version, 40)),
    instructions,
    accounts: arr(o.accounts).map((a) => str(obj(a)?.name) ?? '?').slice(0, 400),
    types: arr(o.types).length,
    errors: arr(o.errors)
      .slice(0, MAX_ERRORS)
      .map((e) => {
        const eo = obj(e) ?? {}
        return { code: typeof eo.code === 'number' ? eo.code : null, name: str(eo.name) ?? '?', msg: str(eo.msg, 200) }
      }),
    events: arr(o.events).map((e) => str(obj(e)?.name) ?? '?').slice(0, 400),
  }
}

/** Signer accounts whose name says they hold authority (admin, authority, owner, governance…). */
const ROLE_RE = /(^|_)(admin|governance|governor|guardian|operator|manager|council|multisig|keeper|crank|super_?admin|(upgrade|config|fee|pause|admin|program|protocol|global|pool_?creator)_?authority)s?($|_)|^(Admin|Governance|Guardian|Operator|Manager)$/i
const NOT_ROLE_RE = /^(user|payer|signer|wallet|owner|trader|taker|maker|depositor|borrower|lender|staker|funder|creator)(_|$)/i

const snake = (n: string) => n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
const isRole = (n: string) => {
  const s = snake(n.split('.').pop() ?? n)
  return ROLE_RE.test(s) && !NOT_ROLE_RE.test(s)
}

export function signerRoles(idl: LensIdl | null): { instruction: string; account: string }[] {
  if (!idl) return []
  const out: { instruction: string; account: string }[] = []
  for (const ins of idl.instructions) for (const a of ins.accounts) if (a.signer && isRole(a.name)) out.push({ instruction: ins.name, account: a.name })
  return out
}
