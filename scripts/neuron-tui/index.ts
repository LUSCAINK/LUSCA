// Front-end factory for the LUSCA desktop neuron (owner: dashboard).
//
//   createUI({ mode: 'tui' | 'log', color, ascii }) → NeuronUI
//
// 'tui' opens the live dashboard (./dashboard.ts) on a TTY of at least 90×26; anything else — a
// pipe, a small window, mode 'log' — gets the plain log lines (./log.ts). If the dashboard's
// renderer ever fails, it restores the terminal at once and its next emit() throws, which
// neuron.ts answers by switching to plain output for the rest of the session.

import { Dashboard } from './dashboard.ts'
import { createLogUI } from './log.ts'
import { detectColorLevel, detectGlyphs, realTerm } from './term.ts'
import type { NeuronUI } from './types.ts'

export const MIN_COLS = 90
export const MIN_ROWS = 26

export function createUI(opts: { mode: 'tui' | 'log'; color: boolean; ascii: boolean }): NeuronUI {
  const out = process.stdout
  if (opts.mode === 'log' || !out.isTTY || (out.columns ?? 0) < MIN_COLS || (out.rows ?? 0) < MIN_ROWS) {
    return createLogUI({ color: opts.color })
  }
  const dash = new Dashboard({
    term: realTerm(),
    level: detectColorLevel(opts.color),
    ascii: opts.ascii,
    glyphs: detectGlyphs(opts.ascii),
  })
  dash.start()
  return dash
}

export { Dashboard } from './dashboard.ts'
export type { NeuronEvent, NeuronUI } from './types.ts'
