export interface SourceIdentity {
  readonly file: string
  readonly declaration: string
  readonly construct: string
  readonly occurrence: number
}

export interface BoundaryOccurrence {
  readonly messageId:
    | "nativeAsync"
    | "nativeAwait"
    | "nativePromise"
    | "promiseSignature"
    | "promiseChain"
    | "platformEffect"
    | "runnerOutsideBoundary"
    | "effectFunctionBoundary"
    | "syncSchemaInEffect"
  readonly identity: SourceIdentity
  readonly node: unknown
}

export interface EffectBoundaryAnalysis {
  readonly occurrences: ReadonlyArray<BoundaryOccurrence>
  readonly declarations: ReadonlySet<string>
  readonly identityOf: (node: unknown) => SourceIdentity
  readonly fallbackIdentityAtOffset: (offset: number, fallbackConstruct: string) => SourceIdentity
  readonly identityAtOffset: (offset: number, fallbackConstruct: string) => SourceIdentity
}

export declare const analyzeEffectBoundaryProgram: (input: {
  readonly filename: string
  readonly sourceCode: unknown
  readonly parserServices: unknown
}) => EffectBoundaryAnalysis
