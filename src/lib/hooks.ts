import { useEffect, useRef, useState } from 'react'
import { useLive, type ConnState, type LiveState } from './store'

/**
 * Subscribe to the live store but re-render at most every `ms` milliseconds.
 * The firehose (~100 msgs/s) would otherwise re-render panels constantly.
 */
export function useSampled<T>(selector: (s: LiveState) => T, ms = 120): T {
  const sel = useRef(selector)
  sel.current = selector
  const [v, setV] = useState(() => selector(useLive.getState()))
  useEffect(() => {
    let last = 0
    let timer = 0
    const flush = () => {
      timer = 0
      last = performance.now()
      setV(sel.current(useLive.getState()))
    }
    const unsub = useLive.subscribe(() => {
      const now = performance.now()
      if (now - last >= ms) flush()
      else if (!timer) timer = window.setTimeout(flush, ms - (now - last))
    })
    return () => {
      unsub()
      if (timer) window.clearTimeout(timer)
    }
  }, [ms])
  return v
}

/** Connection state, sampled. */
export function useConn(ms = 300): ConnState {
  return useSampled((s) => s.conn, ms)
}

/**
 * True only while the server link is up and its snapshot is applied. Every live
 * number is gated on this: when it is false the store holds no data and the
 * number renders "—".
 */
export function useIsLive(ms = 300): boolean {
  return useSampled((s) => s.conn === 'live', ms)
}

/** Re-render on an interval (clocks, "ago" labels). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}

/**
 * Smoothly eased value. For motion only (positions, depths, progress bars): the
 * intermediate values are not data, so never print its output as a number.
 */
export function useTween(target: number, k = 0.12): number {
  const [v, setV] = useState(target)
  const cur = useRef(target)
  useEffect(() => {
    let raf = 0
    const step = () => {
      const d = target - cur.current
      if (Math.abs(d) < Math.max(0.5, Math.abs(target) * 1e-4)) {
        cur.current = target
        setV(target)
        return
      }
      cur.current += d * k
      setV(cur.current)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, k])
  return v
}

export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return m
}
