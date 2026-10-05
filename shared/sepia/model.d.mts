// Type declarations for shared/sepia/model.mjs (plain-JS SEPIA-0 core shared by
// the server training worker, the server main thread, browsers and the CLI).

export declare const CTX: number
export declare const EMB: number
export declare const HIDDEN: number
export declare const VOCAB_SIZE: number
/** id 0 = '\n', ids 1..95 = printable ASCII 32..126. */
export declare const VOCAB: string
export declare const NL: number
export declare const SP: number

export type ArrCtor = Float32ArrayConstructor | Float64ArrayConstructor
export type FArr = Float32Array | Float64Array

export interface ModelConfig {
  T?: number
  E?: number
  H?: number
  V?: number
  Arr?: ArrCtor
}

export interface Layout {
  emb: number
  W1: number
  b1: number
  W2: number
  b2: number
  total: number
}

export declare function encode(text: string, keepTrailing?: boolean): Uint8Array
export declare function decode(ids: ArrayLike<number>): string
export declare function mulberry32(seed: number): () => number
export declare function paramLayout(cfg?: ModelConfig): Layout
export declare function paramCount(cfg?: ModelConfig): number

export declare class SepiaModel {
  constructor(cfg?: ModelConfig)
  readonly T: number
  readonly E: number
  readonly H: number
  readonly V: number
  readonly Arr: ArrCtor
  readonly layout: Layout
  readonly size: number
  params: FArr
  grads: FArr
  init(rand: () => number): void
  load(src: ArrayLike<number>): void
  /** Mean cross-entropy over the batch; with backward=true overwrites `grads`. */
  forward(X: Uint8Array, Y: Uint8Array, B: number, backward: boolean): number
  logits(ctx: Uint8Array): FArr
}

export declare class Adam {
  constructor(n: number, Arr?: ArrCtor, o?: { beta1?: number; beta2?: number; eps?: number })
  beta1: number
  beta2: number
  eps: number
  m: FArr
  v: FArr
  t: number
  /** Returns the pre-clip global grad norm; a non-finite norm skips the update. */
  step(P: FArr, G: FArr, lr: number, clip: number): number
}

export declare const LR_MAX: number
export declare const LR_MIN: number
export declare const WARMUP_STEPS: number
export declare const DECAY_STEPS: number
export declare function lrAt(step: number): number

export declare function generateText(
  model: SepiaModel,
  prompt: string,
  n: number,
  temperature: number,
  rand: () => number,
): string

export interface Buffers {
  xe: FArr
  h: FArr
  dh: FArr
  lg: FArr
  dxe: FArr
}
export interface Dims {
  T: number
  E: number
  H: number
  V: number
  layout: Layout
}
/** Scratch for up to B rows (a larger set serves any smaller batch). */
export declare function makeBuffers(Arr: ArrCtor, B: number, T: number, E: number, H: number, V: number): Buffers
/**
 * The single forward(+backward) implementation. G = null → loss only; otherwise
 * G is OVERWRITTEN with d(mean loss)/d(params). Returns mean cross-entropy.
 */
export declare function batchPass(
  dims: Dims,
  P: FArr,
  G: FArr | null,
  X: Uint8Array,
  Y: Uint8Array,
  B: number,
  bufs: Buffers,
): number
