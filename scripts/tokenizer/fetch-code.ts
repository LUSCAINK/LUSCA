// Runs the protocol code index (server/codebase) once over the whole allowlist and exits when the
// queue is idle. Same module, filters, license recording and shard format as the server.
//
//   LUSCA_DATA=<dir> npx tsx scripts/tokenizer/fetch-code.ts
//
// Shards land in <dir>/code/*.jsonl.gz with <dir>/code/index.json. Re-running only fetches what is
// missing or changed (the index is restart-safe).
import path from 'node:path'
import { createCodeIndexWith } from '../../server/codebase/index.ts'

const dataDir = path.resolve(process.env.LUSCA_DATA ?? 'server/data')
let idleTimer: NodeJS.Timeout | null = null
const idx = createCodeIndexWith({
  dataDir,
  maxMb: Number(process.env.LUSCA_CODE_MAX_MB) || 150,
  startDelayMs: 0,
  gapMs: 2_000,
  log: (lvl, msg) => console.log(`${new Date().toISOString()} ${lvl} ${msg}`),
  onIdle: () => {
    if (idleTimer) return
    idleTimer = setTimeout(async () => {
      const s = idx.stats()
      console.log(JSON.stringify({ repos: s.repos.length, ok: s.repos.filter((r) => r.status === 'ok').length, files: s.files, bytes: s.bytes, byLang: s.byLang }))
      await idx.stop()
      process.exit(0)
    }, 3_000)
  },
})
// The index unrefs its timers (the server keeps the process alive); a script needs a keep-alive.
setInterval(() => {}, 60_000)
idx.start()
