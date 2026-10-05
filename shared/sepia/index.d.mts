// Type declarations for shared/sepia/index.mjs — the SEPIA-0 distributed
// training core (one implementation for the server, browsers and the CLI).

export * from './model.mjs'

export interface SepiaTensor {
  readonly name: 'emb' | 'W1' | 'b1' | 'W2' | 'b2'
  /** first index in the flat parameter vector */
  readonly offset: number
  readonly length: number
  /** row-major [in][out] for matrices */
  readonly shape: readonly number[]
}

export declare const SEPIA: {
  readonly ctx: 16
  readonly emb: 24
  readonly hidden: 384
  readonly vocab: 96
  readonly params: 187104
  readonly layout: readonly SepiaTensor[]
}

/** Text → vocabulary ids; identical to the server corpus ingest (worker.mjs encode()). */
export declare function encodeChars(text: string): Uint8Array

/**
 * Mean cross-entropy over the batch; gradOut (Float32Array(SEPIA.params)) is
 * OVERWRITTEN with d(mean loss)/d(params). Same arithmetic as SepiaModel.forward.
 * Throws on wrong sizes or ids ≥ vocab.
 */
export declare function lossAndGrad(
  params: Float32Array,
  x: Uint8Array,
  y: Uint8Array,
  B: number,
  gradOut: Float32Array,
): number
export declare function lossOnly(params: Float32Array, x: Uint8Array, y: Uint8Array, B: number): number
/** Free the shared scratch buffers (≈ 6.5 KB per batch row of the largest batch seen). */
export declare function releaseScratch(): void

/** Forward+backward FLOPs for one batch: 6·B·(T·E·H + H·V) = 1,105,920·B. */
export declare function trainFlops(B: number): number

/** IEEE binary16, round-to-nearest-even. */
export declare function f32ToF16(a: Float32Array): Uint16Array
export declare function f16ToF32(u: Uint16Array): Float32Array
/** f16ToF32(f32ToF16(params)) — the weights a client actually computes with. */
export declare function roundTripF16(params: Float32Array): Float32Array

/** Size of an encodeGrad() payload: 5·4 header + 187,104·2 = 374,228 bytes. */
export declare const GRAD_BYTES: number
/** Per-tensor power-of-two scale (f32 header) + f16 body; deterministic. */
export declare function encodeGrad(g: Float32Array): Uint8Array
/** Throws on a wrong length or a bad header; non-finite entries are preserved. */
export declare function decodeGrad(bytes: Uint8Array): Float32Array

/** float64-accumulated cosine; 0 if either is all-zero; NaN on non-finite input. */
export declare function cosine(a: Float32Array, b: Float32Array): number
export declare function l2(a: Float32Array): number
/** ‖a − b‖ / ‖b‖ with b the reference. */
export declare function relErr(a: Float32Array, b: Float32Array): number
