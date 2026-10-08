// Page index numbers: the nav (src/components/shell/Shell.tsx) and each page's [NN] kicker read them here,
// so a page's kicker always matches its place in the nav.
//   01–08  in the top bar (Live … MCP)
//   09–17  in the More menu: Code (Atlas, Advisories, Binary, Exposure) · Network (Agents, Model, Start earning, Rewards) · Reference (Docs)
export const NAV_N = {
  live: '01',
  scan: '02',
  chain: '03',
  lens: '04',
  radar: '05',
  control: '06',
  search: '07',
  mcp: '08',
  atlas: '09',
  advisories: '10',
  binary: '11',
  exposure: '12',
  agents: '13',
  sepia: '14',
  node: '15',
  earn: '16',
  docs: '17',
} as const
