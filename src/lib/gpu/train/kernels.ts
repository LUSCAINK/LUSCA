// WGSL kernels for SEPIA-0 training (forward + full backward pass of the
// char-level MLP; see shared/sepia for the reference math).
//
//   ids[B,T] ─gather─▶ XE[B,TE] ─·W1+b1, tanh─▶ HB[B,H] ─·W2+b2─▶ LG[B,V]
//   softmax CE ─▶ LG ← dlogits = (softmax − onehot)/B
//   dW2 = HBᵀ·LG   db2 = colsum LG   DH = (LG·W2ᵀ) ⊙ (1 − HB²)
//   dW1 = XEᵀ·DH   db1 = colsum DH   DXE = DH·W1ᵀ   dEmb[v,e] = Σ_{X[b,t]=v} DXE[b,t·E+e]
//
// Every reduction is a plain sum in a fixed order: matmuls tile over K, the
// weight gradients (reduction over the batch) are split-K into per-chunk
// partials that a second kernel sums, and the embedding gradient is a
// per-(vocab, dim, chunk) scan followed by the same partial sum. No float
// atomics, so a given device produces the same bits for the same inputs.

/** Output tile per workgroup (TILE×TILE), K step per shared-memory stage. */
export const TILE = 64
export const TK = 16
/** Batch rows per split-K chunk for the weight / embedding gradients. */
export const KCHUNK = 256

export type Epilogue = 'store' | 'bias' | 'biasTanh' | 'dtanh'

/** Matmul uniform block: 16 u32 (64 bytes). */
export const MM_UNIFORM_WORDS = 16

/**
 * Tiled matmul C[m,n] = Σ_k A(m,k)·B(k,n) over the k range of this
 * workgroup's split (workgroup_id.z), with
 *   A(m,k) = transA ? A[aOff + k·lda + m] : A[aOff + m·lda + k]
 *   B(k,n) = transB ? B[bOff + n·ldb + k] : B[bOff + k·ldb + n]
 * and C written at C[cOff + z·cStrideZ + m·ldc + n] after the epilogue:
 *   store     c
 *   bias      c + AUX[auxOff + n]
 *   biasTanh  tanh(c + AUX[auxOff + n])
 *   dtanh     c · (1 − AUX[auxOff + m·ldc + n]²)
 * 256 invocations, each owning a 4×4 block of the 64×64 output tile.
 */
export function matmulWGSL(transA: boolean, transB: boolean, ep: Epilogue): string {
  const useAux = ep !== 'store'
  const loadA = transA
    ? `{ let ml = e % ${TILE}u; let kl = e / ${TILE}u; let m = m0 + ml; let k = k0 + kl;
         var v = 0.0; if (m < U.M && k < kEnd) { v = A[U.aOff + k * U.lda + m]; }
         As[kl * ${TILE}u + ml] = v; }`
    : `{ let kl = e % ${TK}u; let ml = e / ${TK}u; let m = m0 + ml; let k = k0 + kl;
         var v = 0.0; if (m < U.M && k < kEnd) { v = A[U.aOff + m * U.lda + k]; }
         As[kl * ${TILE}u + ml] = v; }`
  const loadB = transB
    ? `{ let kl = e % ${TK}u; let nl = e / ${TK}u; let n = n0 + nl; let k = k0 + kl;
         var v = 0.0; if (n < U.N && k < kEnd) { v = Bm[U.bOff + n * U.ldb + k]; }
         Bs[kl * ${TILE}u + nl] = v; }`
    : `{ let nl = e % ${TILE}u; let kl = e / ${TILE}u; let n = n0 + nl; let k = k0 + kl;
         var v = 0.0; if (n < U.N && k < kEnd) { v = Bm[U.bOff + k * U.ldb + n]; }
         Bs[kl * ${TILE}u + nl] = v; }`
  let epi: string
  switch (ep) {
    case 'store':
      epi = 'let o = acc[i][j];'
      break
    case 'bias':
      epi = 'let o = acc[i][j] + AUX[U.auxOff + n];'
      break
    case 'biasTanh':
      epi = 'let o = tanh(acc[i][j] + AUX[U.auxOff + n]);'
      break
    case 'dtanh':
      epi = 'let hv = AUX[U.auxOff + m * U.ldc + n]; let o = acc[i][j] * (1.0 - hv * hv);'
      break
  }
  return /* wgsl */ `
struct MM {
  M : u32, N : u32, K : u32, lda : u32,
  ldb : u32, ldc : u32, aOff : u32, bOff : u32,
  cOff : u32, auxOff : u32, kChunk : u32, cStrideZ : u32,
  _p0 : u32, _p1 : u32, _p2 : u32, _p3 : u32,
}
@group(0) @binding(0) var<uniform> U : MM;
@group(0) @binding(1) var<storage, read> A : array<f32>;
@group(0) @binding(2) var<storage, read> Bm : array<f32>;
@group(0) @binding(3) var<storage, read_write> C : array<f32>;
${useAux ? '@group(0) @binding(4) var<storage, read> AUX : array<f32>;' : ''}

var<workgroup> As : array<f32, ${TK * TILE}>; // [k][m]
var<workgroup> Bs : array<f32, ${TK * TILE}>; // [k][n]

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(workgroup_id) wid : vec3<u32>,
        @builtin(local_invocation_id) l : vec3<u32>,
        @builtin(local_invocation_index) lid : u32) {
  let m0 = wid.y * ${TILE}u;
  let n0 = wid.x * ${TILE}u;
  let kBegin = wid.z * U.kChunk;
  let kEnd = min(U.K, kBegin + U.kChunk);
  var acc : array<array<f32, 4>, 4>;
  for (var i = 0u; i < 4u; i++) { for (var j = 0u; j < 4u; j++) { acc[i][j] = 0.0; } }

  for (var k0 = kBegin; k0 < kEnd; k0 += ${TK}u) {
    for (var r = 0u; r < 4u; r++) {
      let e = lid + r * 256u;
      ${loadA}
      ${loadB}
    }
    workgroupBarrier();
    for (var kk = 0u; kk < ${TK}u; kk++) {
      let ab = kk * ${TILE}u + l.y * 4u;
      let bb = kk * ${TILE}u + l.x * 4u;
      let a = vec4<f32>(As[ab], As[ab + 1u], As[ab + 2u], As[ab + 3u]);
      let b = vec4<f32>(Bs[bb], Bs[bb + 1u], Bs[bb + 2u], Bs[bb + 3u]);
      for (var i = 0u; i < 4u; i++) {
        acc[i][0] = fma(a[i], b.x, acc[i][0]);
        acc[i][1] = fma(a[i], b.y, acc[i][1]);
        acc[i][2] = fma(a[i], b.z, acc[i][2]);
        acc[i][3] = fma(a[i], b.w, acc[i][3]);
      }
    }
    workgroupBarrier();
  }

  let cBase = U.cOff + wid.z * U.cStrideZ;
  for (var i = 0u; i < 4u; i++) {
    let m = m0 + l.y * 4u + i;
    if (m >= U.M) { continue; }
    for (var j = 0u; j < 4u; j++) {
      let n = n0 + l.x * 4u + j;
      if (n >= U.N) { continue; }
      ${epi}
      C[cBase + m * U.ldc + n] = o;
    }
  }
}
`
}

/** Small-kernel uniform block: 8 u32 (32 bytes). */
export const SMALL_UNIFORM_WORDS = 8

/** XE[b, t·E + e] = P[embOff + X[b·T + t]·E + e]. Uniform: B, T, E, embOff. */
export const GATHER_WGSL = /* wgsl */ `
struct G { B : u32, T : u32, E : u32, embOff : u32, _p0 : u32, _p1 : u32, _p2 : u32, _p3 : u32 }
@group(0) @binding(0) var<uniform> U : G;
@group(0) @binding(1) var<storage, read> P : array<f32>;
@group(0) @binding(2) var<storage, read> X : array<u32>;
@group(0) @binding(3) var<storage, read_write> XE : array<f32>;

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nw : vec3<u32>) {
  let idx = gid.x + gid.y * nw.x * 256u;
  let TE = U.T * U.E;
  if (idx >= U.B * TE) { return; }
  let b = idx / TE;
  let r = idx % TE;
  let t = r / U.E;
  let e = r % U.E;
  let c = X[b * U.T + t];
  XE[idx] = P[U.embOff + c * U.E + e];
}
`

/**
 * Row-wise softmax cross-entropy. LOSS[b] = logsumexp(LG[b]) − LG[b, y];
 * LG[b] ← (softmax(LG[b]) − onehot(y)) / B. Uniform: B, V.
 */
export const SOFTMAX_WGSL = /* wgsl */ `
struct S { B : u32, V : u32, _p0 : u32, _p1 : u32, _p2 : u32, _p3 : u32, _p4 : u32, _p5 : u32 }
@group(0) @binding(0) var<uniform> U : S;
@group(0) @binding(1) var<storage, read> Y : array<u32>;
@group(0) @binding(2) var<storage, read_write> LG : array<f32>;
@group(0) @binding(3) var<storage, read_write> LOSS : array<f32>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let b = gid.x;
  if (b >= U.B) { return; }
  let lo = b * U.V;
  var mx = LG[lo];
  for (var k = 1u; k < U.V; k++) { mx = max(mx, LG[lo + k]); }
  var sum = 0.0;
  for (var k = 0u; k < U.V; k++) { sum += exp(LG[lo + k] - mx); }
  let y = Y[b];
  LOSS[b] = log(sum) + mx - LG[lo + y];
  let invB = 1.0 / f32(U.B);
  let inv = invB / sum;
  for (var k = 0u; k < U.V; k++) { LG[lo + k] = exp(LG[lo + k] - mx) * inv; }
  LG[lo + y] = LG[lo + y] - invB;
}
`

/** G[gOff + j] = Σ_b SRC[b·N + j]  (bias gradients). Uniform: B, N, gOff. */
export const COLSUM_WGSL = /* wgsl */ `
struct C { B : u32, N : u32, gOff : u32, _p0 : u32, _p1 : u32, _p2 : u32, _p3 : u32, _p4 : u32 }
@group(0) @binding(0) var<uniform> U : C;
@group(0) @binding(1) var<storage, read> SRC : array<f32>;
@group(0) @binding(2) var<storage, read_write> G : array<f32>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let j = gid.x;
  if (j >= U.N) { return; }
  var s = 0.0;
  for (var b = 0u; b < U.B; b++) { s += SRC[b * U.N + j]; }
  G[U.gOff + j] = s;
}
`

/**
 * Embedding-gradient partials: one invocation per (v·E + e, chunk);
 * PART[pOff + z·V·E + v·E + e] = Σ over positions p of chunk z with X[p] = v
 * of DXE[(p / T)·TE + (p % T)·E + e]. Uniform: B, T, E, V, chunkRows, pOff.
 */
export const EMBGRAD_WGSL = /* wgsl */ `
struct EG { B : u32, T : u32, E : u32, V : u32, chunkRows : u32, pOff : u32, _p0 : u32, _p1 : u32 }
@group(0) @binding(0) var<uniform> U : EG;
@group(0) @binding(1) var<storage, read> X : array<u32>;
@group(0) @binding(2) var<storage, read> DXE : array<f32>;
@group(0) @binding(3) var<storage, read_write> PART : array<f32>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(workgroup_id) wid : vec3<u32>) {
  let i = gid.x;
  let VE = U.V * U.E;
  if (i >= VE) { return; }
  let v = i / U.E;
  let e = i % U.E;
  let z = wid.y;
  let pBegin = z * U.chunkRows * U.T;
  let pEnd = min(U.B, (z + 1u) * U.chunkRows) * U.T;
  let TE = U.T * U.E;
  var s = 0.0;
  for (var p = pBegin; p < pEnd; p++) {
    if (X[p] == v) {
      s += DXE[(p / U.T) * TE + (p % U.T) * U.E + e];
    }
  }
  PART[U.pOff + z * VE + i] = s;
}
`

/** G[gOff + i] = Σ_{z<nz} PART[pOff + z·size + i]. Uniform: size, nz, pOff, gOff. */
export const REDUCE_WGSL = /* wgsl */ `
struct R { size : u32, nz : u32, pOff : u32, gOff : u32, _p0 : u32, _p1 : u32, _p2 : u32, _p3 : u32 }
@group(0) @binding(0) var<uniform> U : R;
@group(0) @binding(1) var<storage, read> PART : array<f32>;
@group(0) @binding(2) var<storage, read_write> G : array<f32>;

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nw : vec3<u32>) {
  let i = gid.x + gid.y * nw.x * 256u;
  if (i >= U.size) { return; }
  var s = 0.0;
  for (var z = 0u; z < U.nz; z++) { s += PART[U.pOff + z * U.size + i]; }
  G[U.gOff + i] = s;
}
`
