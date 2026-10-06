// Live smoke of the EVM reader (frugal: ≤ 6 public-RPC calls and 1–2 Sourcify requests per address).
//   npx tsx server/chain/_evm_smoke.ts                     (the default set below)
//   npx tsx server/chain/_evm_smoke.ts base 0x4200000000000000000000000000000000000006
import { createRpc } from './rpc.ts'
import { readEvm, type EvmChain } from './evm.ts'

const DEFAULT: [EvmChain, string, string][] = [
  ['ethereum', '0x1F98431c8aD98523631AE4a59f267346ea31F984', 'Uniswap V3 Factory'],
  ['ethereum', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC (proxy)'],
  ['ethereum', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH9'],
  ['ethereum', '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', 'Aave v3 Pool (proxy)'],
  ['base', '0x4200000000000000000000000000000000000006', 'Base WETH'],
]
const args = process.argv.slice(2)
const targets: [EvmChain, string, string][] = args.length >= 2 ? [[args[0] as EvmChain, args[1], '']] : DEFAULT
const rpc = createRpc({
  evmRpcs: { ethereum: process.env.LUSCA_ETH_RPC, base: process.env.LUSCA_BASE_RPC, arbitrum: process.env.LUSCA_ARB_RPC },
  log: (l, m) => console.error(`[${l}] ${m}`),
})
for (const [chain, address, label] of targets) {
  const t = Date.now()
  try {
    const { read, abiJson, sources, sourceBundleHash, profile } = await readEvm(chain, address, rpc)
    console.log(
      JSON.stringify(
        {
          label,
          ms: Date.now() - t,
          chain: read.chain,
          address: read.address,
          kind: read.kind,
          name: read.name,
          codeHash: read.codeHash,
          bytecodeBytes: read.bytecodeBytes,
          proxy: read.proxy,
          upgradeable: read.upgradeable,
          upgradeAuthority: read.upgradeAuthority,
          verified: read.verified,
          abi: read.abi && { functions: read.abi.functions.length, events: read.abi.events.length, e_g: read.abi.functions.slice(0, 4) },
          abiJsonEntries: Array.isArray(abiJson) ? abiJson.length : 0,
          sourceFiles: sources.length,
          sourceBytes: sources.reduce((s, f) => s + Buffer.byteLength(f.text), 0),
          sourceBundleHash,
          profile: profile && { customLines: profile.customLines, libraryLines: profile.libraryLines, interfaceLines: profile.interfaceLines, token: profile.token, boilerplate: profile.boilerplate },
          rpcCalls: read.rpcCalls,
          notes: read.notes,
        },
        null,
        1,
      ),
    )
  } catch (e) {
    console.log(label || address, 'ERROR', (e as Error).name, (e as Error).message)
  }
}
console.log('usage', JSON.stringify(rpc.usage()))
await rpc.close()
