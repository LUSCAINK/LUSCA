// Unit test for dataset rotation + state persistence (no network):
//   npx tsx server/ingest/_rotate.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatasetWriter, loadState, saveState, loadDataset, type RotateInfo } from './store.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusca-rot-'))
let fails = 0
const ok = (c: boolean, m: string) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${m}`)
  if (!c) fails++
}

const rotations: RotateInfo[] = []
const line = (i: number) => ({
  id: `id${i}`, url: `https://x.test/${i}`, host: 'x.test', title: `t${i}`, sector: i % 8, score: 0.9, tokens: 100, terms: [], ts: Date.now(),
  text: 'lorem ipsum '.repeat(80), bytes: 1000,
})
const w = new DatasetWriter(dir, { maxBytes: 10_000, keepArchives: 2, sectors: 8, onRotate: (r) => void rotations.push(r) })
for (let i = 0; i < 60; i++) void w.append(line(i))
await w.flush()
const files = fs.readdirSync(dir).sort()
console.log(files)
const lineBytes = Buffer.byteLength(JSON.stringify(line(0)) + '\n')
const perFile = Math.floor(10_000 / lineBytes)
ok(rotations.length > 3, `rotated ${rotations.length} times (≈${perFile} lines per file of ${lineBytes} B)`)
ok(rotations.every((r) => r.totals.pages === perFile && r.totals.tokens === perFile * 100), 'each archive reports its own page/token totals')
const archives = files.filter((f) => /^dataset-\d{8}T\d{9}Z\.jsonl$/.test(f))
ok(archives.length === 2, `kept 2 archives (found ${archives.length})`)
// the two newest archives survive (together with the active file they hold the last pages written)
const kept = archives.flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id as string))
ok(kept.includes('id55') && kept.includes(`id${56 - 2 * perFile}`) && !kept.includes(`id${55 - 2 * perFile}`), `newest archives kept (${kept[0]}…${kept.at(-1)})`)
let active = 0
await loadDataset(path.join(dir, 'dataset.jsonl'), () => active++)
const archivedPages = rotations.reduce((n, r) => n + r.totals.pages, 0)
ok(archivedPages + active === 60, `archived ${archivedPages} + active ${active} = 60`)
ok(fs.statSync(path.join(dir, 'dataset.jsonl')).size <= 10_000, 'active file within cap')

// writer re-opened on an existing file: size is picked up, noteExisting seeds totals
const w2rot: RotateInfo[] = []
const w2 = new DatasetWriter(dir, { maxBytes: 10_000, sectors: 8, onRotate: (r) => void w2rot.push(r) })
await loadDataset(path.join(dir, 'dataset.jsonl'), (l) => w2.noteExisting(l))
for (let i = 100; i < 100 + perFile; i++) void w2.append(line(i))
await w2.flush()
ok(w2rot.length === 1 && w2rot[0].totals.pages === perFile, `re-opened writer rotates with seeded totals (${w2rot[0]?.totals.pages})`)

// state round trip incl. archived + concurrent saves
await Promise.all(
  Array.from({ length: 20 }, (_, i) =>
    saveState(dir, { rejected: i, errors: 1, dupes: 2, semanticDups: ['a'], archived: { pages: 5, tokens: 6, bytes: 7, sectorPages: [1, 2], sectorTokens: [3, 4], files: 1 } }),
  ),
)
const st = await loadState(dir)
ok(st?.rejected === 19 && st.archived?.pages === 5 && st.archived.sectorPages[1] === 2, 'state round trip (last concurrent save wins)')
ok(!fs.existsSync(path.join(dir, 'ingest-state.json.tmp')), 'no stray tmp file')

fs.rmSync(dir, { recursive: true, force: true })
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exit(fails ? 1 : 0)
