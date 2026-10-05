# LUSCA — design system

**Vibe:** minimal · brutalist · supreme high-tech. Think instrument panel, flight recorder,
Teenage Engineering manual, lidar scan. Not "crypto neon". Not glassmorphism. Not rounded.

## Brand
- **LUSCA** — a legendary giant octopus said to live in the blue holes of the Bahamas. Our
  network is the creature; it reads the crypto web.
- **8 arms = 8 sectors**: I Governance · II Research · III Docs · IV Standards · V Markets ·
  VI Codex · VII Security · VIII Chronicle (`shared/sectors.ts`).
- **Agents** live on the arms like suckers. *Octopus suckers taste what they touch* → each agent
  "tastes" (relevance-scores) every page before swallowing it. Two-thirds of an octopus's
  neurons live in its arms — each arm thinks for itself. That is our agent story.
- **SEPIA-0** — the model trained live on what the arms bring back (sepia = cephalopod ink).
- **Credits** — points earned for verified work (your share of the SOL payout pool; never the
  **$INK** token, which funds the pool through its trading fees). **Neurons** — GPUs plugged in by users.
- **Zones** (GPU tiers by benchmark): EPI · MESO · BATHY · ABYSSO · HADAL (`ZONES` in
  `shared/protocol.ts`).
- Voice: terse, lowercase-friendly, precise, a little dry. Numbers over adjectives. Never hype.
  Never promise amounts. Credits are points for verified GPU work; each payout period the payout
  pool is split by credits and paid in SOL to verified wallets. Never call the points INK.

## Tokens (`src/styles/tokens.css` — always use the variables)
- Surfaces `--bg #050505`, `--bg-1..4`. Hairlines `--line..--line-4`. Text (bone) `--fg #ecebe6`,
  `--fg-1..4` progressively dimmer. Single accent **international orange** `--hot #ff4d00`
  (+ `--hot-a10/20/40`). Errors `--err`. Inverted paper sections `--paper #e8e6df` / `--ink`.
- Type: `--f-display` Archivo (use class `.display` = expanded 125% / 800 / uppercase / tight;
  `.display-cond` = condensed), `--f-sans` Geist for body, `--f-mono` Geist Mono for all data,
  labels, numbers. Scale `--t-3xs … --t-5xl`.
- Square corners everywhere (`--radius: 0`). 1px hairline borders. No drop shadows except the
  orange glow on live LEDs.

## Primitives (global classes in `src/index.css`)
`.display .display-cond .mono .label .num .hot .dim .dimmer .panel .panel-head .brackets .hatch
.hatch-hot .grid-bg .led(.on .white .pulse) .btn(.primary .ghost .lg) .tag(.hot .solid) .kv
.caret .scan .tick`

Components in `src/components/obs/parts.tsx` (+ `parts.css`, import it):
`Stat` (label + eased tabular number), `Count`, `Meter` (segmented bar w/ threshold tick),
`Spark` (sparkline), `Highlight` (term highlighting), `StateDot`, `StatePill`, `SectionHead`.

Hooks in `src/lib/hooks.ts`: `useSampled(selector, ms)` (throttled store subscription — USE THIS
for anything reading the live store; the firehose is ~100 msg/s), `useNow`, `useTween`, `useMedia`.
Formatting in `src/lib/format.ts`. Live data in `src/lib/store.ts` (`useLive`), event bus in
`src/lib/bus.ts`, wallet in `src/lib/wallet.ts`. The creature: `<Creature variant interactive labels />`
from `src/components/creature/Creature.tsx` (variants: `hero`, `observatory`, `mini`).

## Layout rules
- Pages live inside the shell (fixed 48px top bar, 28px status bar). Full-height app views use
  `height: calc(100dvh - var(--bar-h) - var(--status-h))`.
- Grids of panels separated by 1px gaps on a `--line-2` background (see `pages/observatory.css`).
- Every panel has a `.panel-head` with an index letter/number in orange + bold title + right meta.
- Section headers on long pages: big `.display` heading, a mono index like `[03]` or `03 /`,
  and a one-line mono kicker. Generous negative space. Hairline rules between sections.
- Use orange sparingly: one hot element per view region (active state, primary CTA, key number).
- Data is always mono + tabular. Labels are mono uppercase 10px with 0.12em tracking.
- Mobile: single column, 16px gutters, no horizontal scroll, tap targets ≥ 40px.

## Motion
- Ease `--ease-expo` for entrances, `--ease` for UI. 120/240/480ms.
- Numbers ease (`Count`). Live rows slide in (`row-in`). Never start critical content at
  `opacity: 0` (background tabs may not run animations) — animate transform/background instead.
- Respect `prefers-reduced-motion` (already global).

## Reference implementation
`src/pages/Observatory.tsx` + `src/pages/observatory.css` is the gold standard. Match its density,
borders, labels and type.
