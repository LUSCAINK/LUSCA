#!/usr/bin/env node
// Build the Hugging Face repository folder for the SEPIA-1 tokenizer (milestone M1). Nothing is
// uploaded here.
//
//   node scripts/hf/build-tokenizer-release.mjs [--out <dir>] [--repo LUSCAINK/SEPIA-1-tokenizer] [--src models/sepia-1-tokenizer]
//
// Every file is checked against models/sepia-1-tokenizer/manifest.json (sha256 and size) before it
// is copied; a mismatch stops the build. The model card is MODEL_CARD.md (generated from the
// measured results by scripts/tokenizer/finalize.py) with Hugging Face front matter added.
//
// Output folder (default <tmp>/lusca-hf/SEPIA-1-tokenizer):
//   tokenizer.json  vocab.json  merges.txt  tokenizer_config.json  special_tokens_map.json
//   eval.json  eval.md  manifest.json  data-manifest.json  README.md  LICENSE  .gitattributes
//
// Then: npx tsx scripts/hf/verify-tokenizer-release.mjs --dir <folder>
// Upload (owner, with a write token in HF_TOKEN; huggingface_hub installed):
//   huggingface-cli upload LUSCAINK/SEPIA-1-tokenizer <folder> . --repo-type model --commit-message "SEPIA-1 tokenizer v1 (M1)"
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const src = path.resolve(arg('src', path.join(ROOT, 'models', 'sepia-1-tokenizer')))
const out = path.resolve(arg('out', path.join(tmpdir(), 'lusca-hf', 'SEPIA-1-tokenizer')))
const repo = arg('repo', 'LUSCAINK/SEPIA-1-tokenizer')
if (!/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(repo)) throw new Error(`--repo must be <namespace>/<name>, got ${repo}`)

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const manifest = JSON.parse(readFileSync(path.join(src, 'manifest.json'), 'utf8'))
if (manifest.name !== 'SEPIA-1 tokenizer' || manifest.vocab_size !== 32768) throw new Error('manifest.json is not the SEPIA-1 tokenizer manifest')

mkdirSync(out, { recursive: true })
for (const [name, f] of Object.entries(manifest.files)) {
  const p = path.join(src, name)
  if (!existsSync(p)) throw new Error(`${name} is listed in manifest.json but missing`)
  const b = readFileSync(p)
  if (b.length !== f.bytes || sha(b) !== f.sha256) throw new Error(`${name}: sha256/size differs from manifest.json (run scripts/tokenizer/finalize.py)`)
  if (name !== 'MODEL_CARD.md') copyFileSync(p, path.join(out, name))
}
copyFileSync(path.join(src, 'manifest.json'), path.join(out, 'manifest.json'))
const dm = path.join(ROOT, manifest.data_manifest.path)
const dmBuf = readFileSync(dm)
if (sha(dmBuf) !== manifest.data_manifest.sha256) throw new Error('data-manifest.json sha256 differs from manifest.json')
writeFileSync(path.join(out, 'data-manifest.json'), dmBuf)
copyFileSync(path.join(ROOT, 'LICENSE'), path.join(out, 'LICENSE'))

const specials = Object.keys(manifest.special_tokens)
const extra = specials.filter((s) => s !== '<|endoftext|>' && s !== '<|pad|>')
writeFileSync(
  path.join(out, 'tokenizer_config.json'),
  JSON.stringify(
    {
      tokenizer_class: 'PreTrainedTokenizerFast',
      model_max_length: 2048,
      bos_token: null,
      eos_token: '<|endoftext|>',
      pad_token: '<|pad|>',
      unk_token: null,
      add_bos_token: false,
      add_eos_token: false,
      clean_up_tokenization_spaces: false,
      additional_special_tokens: extra,
    },
    null,
    2,
  ) + '\n',
)
writeFileSync(path.join(out, 'special_tokens_map.json'), JSON.stringify({ eos_token: '<|endoftext|>', pad_token: '<|pad|>', additional_special_tokens: extra }, null, 2) + '\n')
writeFileSync(path.join(out, '.gitattributes'), '*.json text eol=lf\n*.md text eol=lf\n*.txt text eol=lf\n')

const card = readFileSync(path.join(src, 'MODEL_CARD.md'), 'utf8')
const front = [
  '---',
  'license: mit',
  'library_name: tokenizers',
  'language:',
  '- en',
  '- code',
  'tags:',
  '- tokenizer',
  '- bpe',
  '- byte-level',
  '- code',
  '- solidity',
  '- rust',
  '- move',
  '- cairo',
  '- blockchain',
  '- lusca',
  '---',
  '',
].join('\n')
writeFileSync(path.join(out, 'README.md'), front + card)

console.log(`built ${out} for ${repo}`)
console.log(`tokenizer.json sha256 ${manifest.files['tokenizer.json'].sha256}`)
console.log(`next: npx tsx scripts/hf/verify-tokenizer-release.mjs --dir ${out}`)
