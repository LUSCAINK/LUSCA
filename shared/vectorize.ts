// Hashed bag-of-words page vectors — identical on server and in the browser.
// Used for semantic near-duplicate detection, the work GPU neurons perform.

export const VEC_DIM = 256

const STOP = new Set(
  'the a an and or of to in on for is are was were be been by with as at from that this it its into not but if then than so such can will would should could may might do does did has have had which who whom what when where why how all any each more most other some no nor only own same too very just also there their they them we our you your he she his her i me my about over under after before above below up down out off again further once here both few through during'.split(' '),
)

/** FNV-1a 32-bit */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function words(text: string): string[] {
  const out: string[] = []
  const re = /[a-z0-9][a-z0-9\-']*[a-z0-9]|[a-z0-9]/g
  const lower = text.toLowerCase()
  let m: RegExpExecArray | null
  while ((m = re.exec(lower)) !== null) {
    const w = m[0]
    if (w.length < 2 || STOP.has(w)) continue
    out.push(w)
    if (out.length > 6000) break
  }
  return out
}

/** Unigrams + bigrams, signed feature hashing, log-tf, L2 normalized. */
export function vectorize(text: string, dim = VEC_DIM): Float32Array {
  const v = new Float32Array(dim)
  const ws = words(text)
  const add = (tok: string, w: number) => {
    const h = fnv1a(tok)
    const idx = h % dim
    const sign = (h >>> 31) & 1 ? -1 : 1
    v[idx] += sign * w
  }
  for (let i = 0; i < ws.length; i++) {
    add(ws[i], 1)
    if (i + 1 < ws.length) add(ws[i] + '_' + ws[i + 1], 0.5)
  }
  let norm = 0
  for (let i = 0; i < dim; i++) {
    const x = v[i]
    const s = Math.sign(x) * Math.log1p(Math.abs(x))
    v[i] = s
    norm += s * s
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i++) v[i] /= norm
  return v
}

/** Reference CPU implementation of the neuron job: per-row best cosine match. */
export function bestMatchesCPU(a: Float32Array, b: Float32Array, rows: number, cols: number, dim: number, onlyRows?: number[]) {
  const which = onlyRows ?? Array.from({ length: rows }, (_, i) => i)
  const best: number[] = []
  const sim: number[] = []
  for (const r of which) {
    let bi = -1
    let bs = -Infinity
    const ao = r * dim
    for (let c = 0; c < cols; c++) {
      const bo = c * dim
      let d = 0
      for (let k = 0; k < dim; k++) d += a[ao + k] * b[bo + k]
      if (d > bs) {
        bs = d
        bi = c
      }
    }
    best.push(bi)
    sim.push(bs)
  }
  return { rows: which, best, sim }
}
