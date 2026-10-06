// Precompute the o200k_base and cl100k_base tokens of the playground examples.
//
//   npx tsx scripts/tokenizer/examples-gpt.ts
//
// Writes src/components/sepia/tokenizer/examples-gpt.json so the /sepia playground can show the GPT
// comparison for its built-in examples without downloading gpt-tokenizer (about 1.5 MB gzipped);
// the encodings load only when a visitor edits the text. scripts/tokenizer/_test.ts re-encodes the
// examples and fails if this file is stale.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cl100k from 'gpt-tokenizer/encoding/cl100k_base'
import * as o200k from 'gpt-tokenizer/encoding/o200k_base'
import { EXAMPLES } from '../../src/components/sepia/tokenizer/examples.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const plain = { disallowedSpecial: new Set<string>() }
export type GptTokens = [id: number, text: string][]
const out: Record<string, { o200k: GptTokens; cl100k: GptTokens }> = {}
for (const e of EXAMPLES) {
  const row = (enc: typeof o200k): GptTokens => enc.encode(e.code, plain).map((id) => [id, enc.decode([id])])
  out[e.id] = { o200k: row(o200k), cl100k: row(cl100k as unknown as typeof o200k) }
  console.log(`${e.id}: o200k ${out[e.id].o200k.length} · cl100k ${out[e.id].cl100k.length}`)
}
fs.writeFileSync(path.join(root, 'src', 'components', 'sepia', 'tokenizer', 'examples-gpt.json'), JSON.stringify(out) + '\n')
