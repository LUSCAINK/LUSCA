// Render smoke test for the /sepia tokenizer playground (src/components/sepia/tokenizer/Tokenizer.tsx).
// Run: npx tsx scripts/tokenizer/_render_test.ts
//
// Loads the real component through Vite's SSR loader (so its CSS, ?raw and JSON imports resolve as
// in the build), renders it with react-dom/server with the trained tokenizer injected, and checks
// what a visitor sees first: the milestone strip, the held-out label of the first example, the
// SEPIA-1 / o200k / cl100k counts for it, and one chip per token. Exits non-zero on any failure.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComponentType, ReactElement } from 'react'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { Sepia1Tokenizer, type TokenizerJsonLike } from '../../shared/sepia1/tokenizer.ts'
import { EXAMPLES } from '../../src/components/sepia/tokenizer/examples.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let failures = 0
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    failures++
    console.error(`FAIL ${msg}`)
  }
}

const tok = new Sepia1Tokenizer(JSON.parse(fs.readFileSync(path.join(root, 'models', 'sepia-1-tokenizer', 'tokenizer.json'), 'utf8')) as TokenizerJsonLike)
const vite = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  cacheDir: path.join(os.tmpdir(), 'lusca-tokenizer-render-test'),
  plugins: [react()],
  resolve: { alias: { '@shared': path.join(root, 'shared'), '@': path.join(root, 'src') } },
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
})
try {
  // one module graph for React, react-dom/server and the component (two copies of React break hooks)
  const mod = (await vite.ssrLoadModule('/scripts/tokenizer/_render_entry.mjs')) as {
    TokenizerLab: ComponentType<{ tokenizer?: Sepia1Tokenizer }>
    renderToString: (el: ReactElement) => string
    createElement: (c: ComponentType<{ tokenizer?: Sepia1Tokenizer }>, p: { tokenizer: Sepia1Tokenizer }) => ReactElement
  }
  const html = mod.renderToString(mod.createElement(mod.TokenizerLab, { tokenizer: tok }))
  const ex = EXAMPLES[0]
  const exGpt = JSON.parse(fs.readFileSync(path.join(root, 'src', 'components', 'sepia', 'tokenizer', 'examples-gpt.json'), 'utf8')) as Record<string, { o200k: unknown[]; cl100k: unknown[] }>
  const n = tok.encode(ex.code, { allowSpecial: false }).length
  const fmt = (x: number) => x.toLocaleString('en-US')
  ok(html.includes('SEPIA-1</b> model · not trained yet') || html.includes('model · not trained yet'), 'milestone strip says the model is not trained yet')
  ok(html.includes('held out · not in training'), 'first example is labelled as held out')
  ok(html.includes(ex.label.replace(/&/g, '&amp;')), 'first example is selected')
  ok(html.includes(`<span class="num">${fmt(n)}</span>`), `SEPIA-1 count ${n} shown`)
  ok(html.includes(`<span class="num">${fmt(exGpt[ex.id].o200k.length)}</span>`), 'o200k count shown from the precomputed tokens')
  ok(html.includes(`<span class="num">${fmt(exGpt[ex.id].cl100k.length)}</span>`), 'cl100k count shown from the precomputed tokens')
  const chips = html.match(/data-i="/g)?.length ?? 0
  ok(chips === n, `one chip per token (${chips} chips, ${n} tokens)`)
  ok(!html.includes('loading tokenizer'), 'no loading state with the tokenizer injected')
  ok(html.includes('/models/sepia-1-tokenizer/MODEL_CARD.md'), 'model card link points at the served release')
  console.log(`render: ${html.length} chars of HTML, ${chips} chips for ${ex.id}`)
} finally {
  await vite.close()
}
if (failures > 0) {
  console.error(`${failures} failure(s)`)
  process.exit(1)
}
console.log('sepia1 tokenizer playground: render test passed')
