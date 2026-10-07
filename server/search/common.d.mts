// Types of common.mjs for the TypeScript side (index.ts, tests).
export declare const LIB_PATH_RE: RegExp
export declare function isLibPath(p: string): boolean
export declare const HOME_RE: RegExp
export declare function shownPath(p: string): string
export declare const LOWER: Uint8Array
export declare function sigBitsFor(distinct: number): number
export declare function sigBit(t: number, lg: number): number
export declare function trigramsOf(runs: string[]): number[]
export declare function requiredRuns(pattern: string): string[]
export declare function refuseRegex(pattern: string): string | null
export declare function escapeRe(s: string): string
export declare function pathMatcher(glob: string | null | undefined): ((p: string) => boolean) | null
