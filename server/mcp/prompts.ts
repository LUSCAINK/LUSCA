// LUSCA MCP prompts: ready-made questions that chain the tools. Clients list them with prompts/list and
// show them as commands (Claude Code: /mcp__lusca__who_can_change solana <address>).

import { isSolanaAddress } from '../../shared/base58.ts'
import { CHAINS } from './tools.ts'

export interface PromptArg {
  name: string
  description: string
  required: boolean
}

export interface McpPrompt {
  name: string
  title: string
  description: string
  arguments: PromptArg[]
  /** The user message; null + reason when an argument is not usable. */
  render(args: Record<string, string>): { text: string } | { error: string }
}

const FACTS = 'State facts only, with no judgment about any project, team or contract, and cite the lusca.ink links from the tool answers.'

function target(args: Record<string, string>): { chain: string; address: string } | { error: string } {
  const chain = (args.chain ?? '').trim().toLowerCase()
  const address = (args.address ?? '').trim()
  if (!(CHAINS as readonly string[]).includes(chain)) return { error: `chain must be one of ${CHAINS.join(', ')}` }
  if (chain === 'solana' ? !isSolanaAddress(address) : !/^0x[0-9a-fA-F]{40}$/.test(address)) return { error: `address is not ${chain === 'solana' ? 'a Solana' : 'an EVM'} address` }
  return { chain, address }
}

export const PROMPTS: McpPrompt[] = [
  {
    name: 'who_can_change',
    title: 'Who can change this code?',
    description: 'The custody chain of one program or contract, hop by hop, and every other kept program / contract the same controller can change.',
    arguments: [
      { name: 'chain', description: 'solana, ethereum, base or arbitrum', required: true },
      { name: 'address', description: 'Program id or contract address', required: true },
    ],
    render(args) {
      const t = target(args)
      if ('error' in t) return t
      return {
        text: `Using the LUSCA tools, call lusca_control for ${t.chain} ${t.address} (if it is not in the control map, call lusca_lens for it instead). Explain who can change this code: the custody chain hop by hop, and what kind of account holds the right — a single keypair, a program-derived address, a Safe with its threshold, a timelock with its delay, or another contract. Then list the other kept programs and contracts the same controller can change. ${FACTS}`,
      }
    },
  },
  {
    name: 'latest_upgrades',
    title: 'What changed on-chain?',
    description: 'The most recent confirmed code upgrades the radar caught, with what changed in each (surface, admin checks, source diff).',
    arguments: [{ name: 'chain', description: 'Optional: solana, ethereum, base or arbitrum', required: false }],
    render(args) {
      const chain = (args.chain ?? '').trim().toLowerCase()
      if (chain && !(CHAINS as readonly string[]).includes(chain)) return { error: `chain must be one of ${CHAINS.join(', ')}` }
      return {
        text: `Using the LUSCA tools, call lusca_radar with kind "upgrade"${chain ? ` and chain "${chain}"` : ''} and limit 10. Pick up to three of the most significant confirmed upgrades (known protocols and larger changes first) and call lusca_radar_event for each. For each one say when it landed, who sent or signed it, what was read before and after, which instructions or functions were added or removed, which admin checks changed, and the source diff summary when there is one. ${FACTS}`,
      }
    },
  },
  {
    name: 'explain_code',
    title: 'Explain a program or contract',
    description: 'A Lens read of one address, who can change it, and the kept code that shares the most names with it.',
    arguments: [
      { name: 'chain', description: 'solana, ethereum, base or arbitrum', required: true },
      { name: 'address', description: 'Program id or contract address', required: true },
    ],
    render(args) {
      const t = target(args)
      if ('error' in t) return t
      return {
        text: `Using the LUSCA tools, read ${t.chain} ${t.address} with lusca_lens, then call lusca_control and lusca_atlas_relatives for it (skip either if the address is not kept). Explain what the code exposes (instructions or functions, admin-only functions with file:line, cryptographic primitives), whether its source or build is verified, who can change it, and which kept programs or contracts are its closest relatives and what they share. ${FACTS}`,
      }
    },
  },
]
