// Numeric gradient check for SEPIA-0's hand-written backward pass.
// Run: npx tsx server/trainer/_gradcheck.ts   (model math: shared/sepia/model.mjs;
// distributed-training API tests: npx tsx shared/sepia/_test.ts)
//
// Central finite differences in Float64 on randomly chosen parameters of every
// tensor (embeddings, W1, b1, W2, b2), on a small config and on the real
// config (T=16, E=24, H=384, V=96). Also checks the vocab mapping round-trips.
// Exits non-zero on failure.
import { SepiaModel, decode, encode, mulberry32, paramCount, type ModelConfig } from './model.mjs'

function check(name: string, cfg: ModelConfig, B: number, probesPerTensor: number): boolean {
  const rand = mulberry32(12345)
  const m = new SepiaModel({ ...cfg, Arr: Float64Array })
  m.init(rand)
  // Make W2/b1/b2 non-trivial so every gradient path carries signal.
  const L = m.layout
  for (let i = L.b1; i < L.total; i++) m.params[i] += (rand() - 0.5) * 0.4
  const X = new Uint8Array(B * m.T)
  const Y = new Uint8Array(B)
  for (let i = 0; i < X.length; i++) X[i] = Math.floor(rand() * m.V)
  for (let i = 0; i < B; i++) Y[i] = Math.floor(rand() * m.V)
  // Force embedding row reuse (same char at several positions) — the scatter-add path.
  X[0] = X[1] = X[m.T + 2] = 7

  m.forward(X, Y, B, true)
  const analytic = Float64Array.from(m.grads)

  const tensors: [string, number, number][] = [
    ['emb', L.emb, L.W1],
    ['W1', L.W1, L.b1],
    ['b1', L.b1, L.W2],
    ['W2', L.W2, L.b2],
    ['b2', L.b2, L.total],
  ]
  const eps = 1e-5
  let worst = 0
  let ok = true
  for (const [tn, a, b] of tensors) {
    let tw = 0
    let nonzero = 0
    const probes: number[] = []
    // Always include the embedding row of char 7 (reused) and random others.
    if (tn === 'emb') probes.push(7 * m.E, 7 * m.E + 3)
    while (probes.length < probesPerTensor) probes.push(a + Math.floor(rand() * (b - a)))
    for (const idx of probes) {
      const orig = m.params[idx]
      m.params[idx] = orig + eps
      const lp = m.forward(X, Y, B, false)
      m.params[idx] = orig - eps
      const lm = m.forward(X, Y, B, false)
      m.params[idx] = orig
      const num = (lp - lm) / (2 * eps)
      const an = analytic[idx]
      const mag = Math.abs(num) + Math.abs(an)
      // Exactly-zero gradients (e.g. an embedding row never looked up) must
      // match exactly-ish; everything else is judged by relative error.
      const rel = mag < 1e-10 ? 0 : Math.abs(num - an) / mag
      const bad = mag < 1e-10 ? Math.abs(num - an) > 1e-10 : rel > 1e-5
      if (bad) {
        ok = false
        console.log(`  ✗ ${tn}[${idx - a}] analytic=${an.toExponential(4)} numeric=${num.toExponential(4)} rel=${rel.toExponential(2)}`)
      }
      if (mag > 0) nonzero++
      tw = Math.max(tw, rel)
    }
    worst = Math.max(worst, tw)
    console.log(`  ${name} ${tn.padEnd(3)} probes=${probes.length} nonzero=${nonzero} max rel err=${tw.toExponential(2)}`)
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: worst relative error ${worst.toExponential(2)}`)
  return ok
}

let pass = true
pass = check('small', { T: 4, E: 3, H: 10, V: 96 }, 5, 40) && pass
pass = check('full ', {}, 8, 12) && pass

// Vocab sanity.
const s = 'The “bridge” — EIP‑4844 costs 0.5 ETH… café\tok\r\n\n\n\nend 🚀 x'
const round = decode(encode(s))
console.log(JSON.stringify(round))
const vocabOk = round === 'The "bridge" - EIP-4844 costs 0.5 ETH... cafe ok\n\nend x'
console.log(`${vocabOk ? 'PASS' : 'FAIL'} vocab mapping`)
pass = pass && vocabOk
console.log(`params (full config): ${paramCount()}`)
process.exit(pass ? 0 : 1)
