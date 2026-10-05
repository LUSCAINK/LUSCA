// Tiny typed pub/sub for imperative, high-frequency consumers (WebGL scenes,
// tickers) that should not re-render React on every event.
import type { ServerMsg } from '@shared/protocol'

type MsgOf<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>
type Handler<T extends ServerMsg['t']> = (msg: MsgOf<T>) => void

const handlers = new Map<string, Set<(m: ServerMsg) => void>>()

export const bus = {
  on<T extends ServerMsg['t']>(type: T, fn: Handler<T>): () => void {
    let set = handlers.get(type)
    if (!set) handlers.set(type, (set = new Set()))
    set.add(fn as (m: ServerMsg) => void)
    return () => set!.delete(fn as (m: ServerMsg) => void)
  },
  emit(msg: ServerMsg) {
    const set = handlers.get(msg.t)
    if (set) for (const fn of set) fn(msg)
    const all = handlers.get('*')
    if (all) for (const fn of all) fn(msg)
  },
  /** Subscribe to every message. */
  any(fn: (m: ServerMsg) => void): () => void {
    let set = handlers.get('*')
    if (!set) handlers.set('*', (set = new Set()))
    set.add(fn)
    return () => set!.delete(fn)
  },
}
