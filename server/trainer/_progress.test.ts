// SEPIA-0 progress floor: the public step and work counters never go backwards after a restart,
// including a hard kill between two 90-s checkpoints.
// Run: npx tsx server/trainer/_progress.test.ts
//
// 1. progressFloor.ts on its own: step reservation, published counters = persisted, release on a
//    clean stop, the .bak copy when the main file is torn.
// 2. End to end with the real trainer in a child process: a clean run writes a checkpoint, a
//    second run trains past it and is killed with TerminateProcess / SIGKILL, and a third trainer
//    on the same directory must publish a step and counters at or above everything seen before
//    the kill, and continue numbering above it.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProgressFloor, STEP_BLOCK } from './progressFloor.ts'
import { createTrainer } from './trainer.ts'

const SELF = fileURLToPath(import.meta.url)

const TEXT = [
  'The validator signs an attestation for the head of the chain every epoch, and the beacon chain rewards honest participation.',
  'A rollup posts compressed transaction data to Ethereum and proves that the new state root follows from the old one.',
  'Liquidity providers deposit two tokens into a pool and earn a share of the swap fees in proportion to their stake.',
  'The bridge locks tokens on the source chain and mints a wrapped representation on the destination chain.',
  'Zero-knowledge proofs let a prover convince a verifier that a statement is true without revealing the witness.',
  'Slashing penalizes validators who sign conflicting blocks, which makes attacks on proof of stake expensive.',
]

function corpus(chars: number): string[] {
  const docs: string[] = []
  let seed = 11
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296
  let total = 0
  while (total < chars) {
    let d = ''
    while (d.length < 2000) d += TEXT[Math.floor(rnd() * TEXT.length)] + (rnd() < 0.2 ? '\n\n' : ' ')
    docs.push(d)
    total += d.length
  }
  return docs
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── child: one trainer process that reports what it publishes ──
async function child(dir: string, mode: string, until: number) {
  const trainer = createTrainer({ dataDir: dir, emit: () => {} })
  trainer.start()
  for (const d of corpus(80_000)) trainer.feed(d)
  const report = () => {
    const i = trainer.info()
    process.stdout.write(`P ${JSON.stringify({ step: i.step, version: i.version, serverSteps: i.serverSteps, gpuSteps: i.gpuSteps, gpuSamples: i.gpuSamples })}\n`)
    return i
  }
  for (;;) {
    const i = report()
    if (mode === 'clean' && i.step >= until) break
    await sleep(100)
  }
  await trainer.stop()
  report()
  process.stdout.write('STOPPED\n')
  process.exit(0)
}

interface Seen {
  step: number
  version: number
  serverSteps: number
  gpuSteps: number
  gpuSamples: number
}

/** Runs a child trainer; resolves when `done(max)` is true (then kills it hard) or when it exits. */
function runChild(dir: string, mode: 'clean' | 'run', until: number, done: (s: Seen) => boolean, timeoutMs: number): Promise<{ max: Seen; killed: boolean }> {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [...process.execArgv, SELF, '--child', dir, mode, String(until)], { stdio: ['ignore', 'pipe', 'pipe'] })
    const max: Seen = { step: 0, version: 0, serverSteps: 0, gpuSteps: 0, gpuSamples: 0 }
    let buf = ''
    let killed = false
    let err = ''
    const timer = setTimeout(() => {
      cp.kill('SIGKILL')
      reject(new Error(`child timed out (${mode}); max ${JSON.stringify(max)}\n${err.slice(-2000)}`))
    }, timeoutMs)
    cp.stderr.on('data', (d) => (err += String(d)))
    cp.stdout.on('data', (d) => {
      buf += String(d)
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.startsWith('P ')) continue
        const p = JSON.parse(line.slice(2)) as Seen
        for (const k of Object.keys(max) as (keyof Seen)[]) max[k] = Math.max(max[k], p[k])
        if (!killed && done(max)) {
          killed = true
          cp.kill('SIGKILL') // TerminateProcess on Windows: no shutdown hooks, no final checkpoint
        }
      }
    })
    cp.on('exit', (code) => {
      clearTimeout(timer)
      if (!killed && code !== 0) return reject(new Error(`child exited ${code}\n${err.slice(-2000)}`))
      resolve({ max, killed })
    })
  })
}

async function unit() {
  const dir = await mkdtemp(path.join(tmpdir(), 'lusca-progress-'))
  try {
    const a = createProgressFloor(dir)
    assert.deepEqual(a.floor(), { step: 0, gpuSteps: 0, serverSteps: 0, gpuSamples: 0, samplesSeen: 0 })
    a.reserveStep(10)
    assert.equal(a.floor().step, 10 + STEP_BLOCK, 'a block is reserved and on disk before step 10 is published')
    a.reserveStep(100)
    assert.equal(a.floor().step, 10 + STEP_BLOCK, 'no write while the step is well inside the reservation')
    a.reserveStep(10 + STEP_BLOCK - 1)
    assert.ok(a.floor().step >= 10 + STEP_BLOCK - 1 + STEP_BLOCK - 64, 'the reservation is extended before it runs out')
    // counters: published = persisted
    const c1 = a.observe({ gpuSteps: 5, serverSteps: 7, gpuSamples: 40, samplesSeen: 900 })
    assert.deepEqual(c1, { gpuSteps: 0, serverSteps: 0, gpuSamples: 0, samplesSeen: 0 }, 'new counts are published only once on disk')
    a.flushSync()
    assert.deepEqual(a.observe({ gpuSteps: 5, serverSteps: 7, gpuSamples: 40, samplesSeen: 900 }), { gpuSteps: 5, serverSteps: 7, gpuSamples: 40, samplesSeen: 900 })
    assert.deepEqual(a.observe({ gpuSteps: 1, serverSteps: 1, gpuSamples: 1, samplesSeen: 1 }), { gpuSteps: 5, serverSteps: 7, gpuSamples: 40, samplesSeen: 900 }, 'lower counts never lower the floor')
    // restart reads the same floor
    const reserved = a.floor().step
    const b = createProgressFloor(dir)
    assert.deepEqual(b.floor(), { step: reserved, gpuSteps: 5, serverSteps: 7, gpuSamples: 40, samplesSeen: 900 })
    // clean stop returns the unused block
    b.release(300)
    assert.equal(createProgressFloor(dir).floor().step, 300)
    // a torn main file falls back to the .bak copy (the previous save)
    b.observe({ gpuSteps: 6, serverSteps: 8, gpuSamples: 41, samplesSeen: 901 })
    b.flushSync()
    fs.writeFileSync(path.join(dir, 'progress.json'), '{"step":')
    const c = createProgressFloor(dir).floor()
    assert.equal(c.step, 300)
    assert.equal(c.serverSteps, 7, '.bak holds the save before the torn one')
    const facts = fs.readFileSync(path.join(path.dirname(SELF), '../../src/components/docs/facts.ts'), 'utf8')
    assert.equal(Number(/stepBlock: (\d+)/.exec(facts)?.[1]), STEP_BLOCK, 'docs facts stepBlock matches STEP_BLOCK')
    console.log('ok   progress floor: step reservation, published counters on disk first, release, .bak fallback')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function hardKill() {
  const dir = await mkdtemp(path.join(tmpdir(), 'lusca-progress-kill-'))
  try {
    // 1. clean run: checkpoint at step >= 100, reservation returned
    const first = await runChild(dir, 'clean', 100, () => false, 180_000)
    assert.ok(first.max.step >= 100, `clean run reached step ${first.max.step}`)
    const ckStep = createProgressFloor(dir).floor().step
    assert.ok(ckStep >= 100 && ckStep <= first.max.step + 60, `clean stop leaves the reservation at the checkpoint (${ckStep}, max seen ${first.max.step})`)

    // 2. train well past the checkpoint (more than one reservation block), then kill hard
    const target = ckStep + STEP_BLOCK + 150
    const second = await runChild(dir, 'run', 0, (m) => m.step >= target && m.serverSteps > 0, 240_000)
    assert.ok(second.killed, 'second run was killed')
    const seen = second.max
    assert.ok(seen.step >= target, `second run published step ${seen.step}`)
    await sleep(300)
    const reserved = createProgressFloor(dir).floor().step // on disk at the moment of the kill
    assert.ok(reserved >= seen.step, `reservation ${reserved} covers every step seen (${seen.step})`)

    // 3. a new trainer on the same directory: nothing below what was published, numbering continues above it
    const points: number[] = []
    const t = createTrainer({ dataDir: dir, emit: (m) => (m.t === 'loss' ? void points.push(m.point.step) : undefined) })
    t.start()
    for (const d of corpus(80_000)) t.feed(d) // the corpus is not on disk in this test
    // first published values once the checkpoint is loaded (before the worker has reported anything)
    let t0 = Date.now()
    while (Date.now() - t0 < 30_000 && t.info().step === 0) await sleep(10)
    const boot = t.info()
    assert.ok(boot.step >= seen.step, `step at boot ${boot.step} >= last published ${seen.step}`)
    assert.ok(boot.serverSteps >= seen.serverSteps, `serverSteps at boot ${boot.serverSteps} >= ${seen.serverSteps}`)
    t0 = Date.now()
    while (Date.now() - t0 < 120_000 && points.length === 0) await sleep(100)
    const i = t.info()
    assert.ok(i.step >= seen.step, `step after the kill ${i.step} >= last published ${seen.step}`)
    assert.ok(i.version >= seen.version, `version ${i.version} >= ${seen.version}`)
    assert.ok(i.serverSteps >= seen.serverSteps, `serverSteps ${i.serverSteps} >= ${seen.serverSteps}`)
    assert.ok(i.gpuSamples >= seen.gpuSamples && i.gpuSteps >= seen.gpuSteps, 'GPU counters did not go back')
    assert.ok(points.length > 0 && points[0] > seen.step, `first new loss point ${points[0]} is numbered above ${seen.step}`)
    assert.ok(points[0] > reserved && points[0] <= reserved + 25, `numbering resumes at the reservation (${reserved} → first point ${points[0]})`)
    await t.stop()
    console.log(`ok   hard kill: checkpoint ${ckStep}, ${seen.step} seen before the kill, reservation ${reserved}, first new loss point ${points[0]}; counters kept`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

const argv = process.argv.slice(2)
if (argv[0] === '--child') {
  await child(argv[1], argv[2], Number(argv[3]))
} else {
  await unit()
  await hardKill()
  console.log('progress: all passed')
  process.exit(0)
}
