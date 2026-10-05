// Full-run loss history for the Sepia page.
// The live store keeps only the newest 2,000 loss points, so after a long
// session the start of training would scroll off the chart. This keeps an
// archive (oldest half merged pairwise when it grows) that survives the cap,
// and resets whenever a new hello / playback loop / restarted trainer arrives.
import { useMemo } from 'react'
import type { LossPoint } from '@shared/protocol'
import { useSampled } from '@/lib/hooks'
import { useLive } from '@/lib/store'

const MAX_POINTS = 2400

let kept: LossPoint[] = []
let seen: LossPoint[] | null = null

function compact(a: LossPoint[]): LossPoint[] {
  const half = Math.floor(a.length / 2)
  const out: LossPoint[] = []
  let i = 0
  for (; i + 1 < half; i += 2) {
    const p = a[i]
    const q = a[i + 1]
    out.push({ step: q.step, loss: (p.loss + q.loss) / 2, val: q.val ?? p.val, tokens: q.tokens, ts: q.ts })
  }
  for (; i < half; i++) out.push(a[i])
  return out.concat(a.slice(half))
}

function sync(): LossPoint[] {
  const src = useLive.getState().loss
  if (src === seen) return kept
  seen = src
  if (!src.length) return (kept = [])
  const head = kept[0]
  const tail = kept[kept.length - 1]
  if (!head || src[0].step <= head.step || src[src.length - 1].step < tail.step) {
    kept = src.slice()
  } else {
    let i = src.length
    while (i > 0 && src[i - 1].step > tail.step) i--
    if (i < src.length) kept = kept.concat(src.slice(i))
  }
  if (kept.length > MAX_POINTS) kept = compact(kept)
  return kept
}

/** Loss history from the first step, throttled like `useSampled`. */
export function useLossHistory(ms = 250): LossPoint[] {
  const src = useSampled((s) => s.loss, ms)
  // `src` is only the re-render trigger; sync() always reads the newest store state
  return useMemo(() => sync(), [src])
}
