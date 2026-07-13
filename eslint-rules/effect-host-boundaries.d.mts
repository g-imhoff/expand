export interface EffectHostBoundary {
  readonly file: string
  readonly declaration: string
  readonly host: string
  readonly construct: string
  readonly occurrence: number
}

export declare const effectHostBoundaries: ReadonlyArray<EffectHostBoundary>
