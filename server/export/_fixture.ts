// Shared fixtures for the export tests: a data dir with rotated archives, a code index and a real chain store.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'
import type { ChainId, ChainRead } from '../../shared/chain.ts'
import { createChainStore } from '../chain/store.ts'

export const quiet = () => {}

export function mkRead(chain: ChainId, address: string, o: Partial<ChainRead> = {}): ChainRead {
  return {
    chain,
    address,
    kind: chain === 'solana' ? 'program' : 'contract',
    name: null,
    codeHash: null,
    upgradeable: null,
    upgradeAuthority: null,
    lastDeploySlot: null,
    programBytes: null,
    loader: null,
    idl: null,
    securityTxt: null,
    bytecodeBytes: null,
    proxy: null,
    abi: null,
    verified: null,
    sources: [],
    notes: [],
    readAt: Date.now(),
    rpcCalls: 1,
    ...o,
  }
}

export const SHARED = '// SPDX-License-Identifier: Apache-2.0\n// shared math, author dev@example.com\npub fn mul_div(a: u64, b: u64, c: u64) -> u64 { a * b / c }\n'
export const big = (tag: string) => `// SPDX-License-Identifier: BUSL-1.1\n// ${tag}\n${randomBytes(60 * 1024).toString('hex')}\n` // ~120 KB, ~65 KB gzipped
export const IDL = { name: 'amm', version: '0.1.0', instructions: [{ name: 'swap', args: 2, accounts: 7 }], accounts: ['Pool'], types: 3, errors: 4, events: 1 }
export const P1 = 'Prog1111111111111111111111111111111111111A'
export const P2 = 'Prog2222222222222222222222222222222222222B'
export const P3 = 'Prog3333333333333333333333333333333333333C'
export const OSEC = { by: 'osec' as const, match: null, repo: 'https://github.com/example/amm', commit: 'abc123', compiler: null }

export function solKeep(addr: string, codeHash: string, files: { path: string; text: string }[], at: number) {
  return {
    agent: 'sol-1',
    via: 'block' as const,
    read: mkRead('solana', addr, { codeHash, name: `amm-${addr.slice(4, 5)}`, idl: IDL, verified: OSEC, readAt: at, sources: files.map((f) => ({ path: f.path, lang: 'rust', bytes: Buffer.byteLength(f.text) })) }),
    idlJson: { version: '0.1.0', name: 'amm', instructions: [{ name: 'swap', accounts: [], args: [] }] },
    sources: files,
    sourceBundleHash: `bundle-${codeHash}`,
  }
}

/** A data dir with two rotated archives, the active dataset, a code index and a chain store over 3+ shards. */
export async function makeData(dir: string): Promise<{ dir: string; archives: string[] }> {
  fs.mkdirSync(dir, { recursive: true })
  const line = (i: number) => JSON.stringify({ id: `p${i}`, url: `https://docs.example/${i}`, host: 'docs.example', title: `t${i}`, sector: 1, score: 0.9, tokens: 120, terms: [], ts: 1, text: `page ${i} [email] `.repeat(40) }) + '\n'
  const archives = ['dataset-20261007T010000000Z.jsonl', 'dataset-20261007T050000000Z.jsonl']
  fs.writeFileSync(path.join(dir, archives[0]), Array.from({ length: 50 }, (_, i) => line(i)).join(''))
  fs.writeFileSync(path.join(dir, archives[1]), Array.from({ length: 70 }, (_, i) => line(100 + i)).join(''))
  fs.writeFileSync(path.join(dir, 'dataset-archives.json'), JSON.stringify({ [archives[0]]: { pages: 50, tokens: 6000, bytes: 1 } }))
  fs.writeFileSync(path.join(dir, 'dataset.jsonl'), line(999)) // active: never exported
  // files that must never leave the server
  fs.writeFileSync(path.join(dir, 'auth.secret'), 'SECRET-SHOULD-NOT-LEAK')
  fs.writeFileSync(path.join(dir, 'hash.salt'), 'salt')
  fs.writeFileSync(path.join(dir, 'ledger.json'), '{}')
  // code index: one listed shard, one stray file
  const code = path.join(dir, 'code')
  fs.mkdirSync(code)
  const codeShard = 'Uniswap__v2-core.1.0.jsonl.gz'
  fs.writeFileSync(path.join(code, codeShard), zlib.gzipSync(JSON.stringify({ repo: 'Uniswap/v2-core', path: 'a.sol', text: 'contract A {}' }) + '\n'))
  fs.writeFileSync(path.join(code, 'stray.0.0.jsonl.gz'), zlib.gzipSync('{}\n'))
  fs.writeFileSync(
    path.join(code, 'index.json'),
    JSON.stringify({ version: 2, gen: 1, updatedAt: 1, repos: { 'Uniswap/v2-core': { repo: 'Uniswap/v2-core', commit: 'c0ffee', license: 'GPL-3.0', gen: 1, status: 'ok', fetchedAt: 1, shards: [codeShard, '../auth.secret'] } } }),
  )
  // chain store: small shards so a few records span several of them
  const st = createChainStore({ dataDir: dir, log: quiet, saveDelayMs: 0, maxShardBytes: 64 * 1024, diskReserveBytes: 0 })
  const t0 = Date.UTC(2026, 9, 7, 8, 0, 0)
  for (const [i, k] of [
    solKeep(P1, 'c1', [{ path: 'src/math.rs', text: SHARED }, { path: 'src/big1.rs', text: big('one') }], t0),
    solKeep(P2, 'c2', [{ path: 'programs/amm/src/util.rs', text: SHARED }, { path: 'src/big2.rs', text: big('two') }], t0 + 1000),
  ].entries()) {
    const r = await st.process(k)
    assert.equal(r.verdict, 'kept', `record ${i}: ${r.reason}`)
  }
  st.flush()
  await st.close()
  return { dir, archives }
}

