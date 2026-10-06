// Dev smoke test (not bundled): fakes a 160×45 TTY on the real process streams, runs createUI with
// real timers, presses keys through stdin and reports frames, bytes and the restore sequences.
import { createUI } from './index.ts'
const out = process.stdout as unknown as Record<string, unknown>
const inp = process.stdin as unknown as Record<string, unknown>
out.isTTY = true
out.columns = 160
out.rows = 45
inp.isTTY = true
let raw = false
inp.setRawMode = (on: boolean) => {
  raw = on
  return process.stdin
}
const realWrite = process.stdout.write.bind(process.stdout)
let frames = 0
let bytes = 0
const seen = new Set<string>()
;(process.stdout as unknown as { write: (s: string, cb?: () => void) => boolean }).write = (s: string, cb?: () => void) => {
  if (s.includes('\x1b[?2026h')) frames++
  bytes += s.length
  for (const k of ['\x1b[?1049h', '\x1b[?1049l', '\x1b[?25l', '\x1b[?25h', '\x1b[?7l', '\x1b[?7h']) if (s.includes(k)) seen.add(JSON.stringify(k))
  if (s.includes('session ended')) realWrite('[card printed]\n')
  if (cb) cb()
  return true
}
const ui = createUI({ mode: 'tui', color: true, ascii: false })
const log = (m: string) => realWrite(m + '\n')
log(`raw mode on: ${raw}`)
const server = 'wss://lusca.ink/ws'
ui.emit({ t: 'boot', build: 'smoke', cpu: 'Test CPU', threads: 8, os: 'win32 x64', server, label: 'Test CPU · desktop' })
ui.emit({ t: 'bench', phase: 'start' })
setTimeout(() => ui.emit({ t: 'bench', phase: 'done', gflops: 2.1, zone: 'EPI', bonus: 1 }), 300)
setTimeout(() => ui.emit({ t: 'conn', state: 'registered', server, neuronId: 'nrn_abcdef0123456789', zone: 'EPI', gflops: 2.1, linked: false }), 500)
let sigint = 0
process.on('SIGINT', () => {
  sigint++
  log(`SIGINT handler ran (from key) · frames ${frames} in ~2.0 s · ${(bytes / Math.max(1, frames) / 1024).toFixed(1)} KB/frame`)
  void ui.stop('smoke summary').then(() => {
    log(`after stop: raw ${raw} · sequences ${[...seen].join(' ')}`)
    process.exit(0)
  })
})
setTimeout(() => process.stdin.emit('data', Buffer.from('x')), 800) // skip boot
setTimeout(() => process.stdin.emit('data', Buffer.from('p')), 1200) // pause
setTimeout(() => process.stdin.emit('data', Buffer.from('p')), 1400) // resume
setTimeout(() => process.stdin.emit('data', Buffer.from('l')), 1500) // log view
setTimeout(() => process.stdin.emit('data', Buffer.from('l')), 1700)
setTimeout(() => process.stdin.emit('data', Buffer.from('q')), 2000) // quit → SIGINT handlers
