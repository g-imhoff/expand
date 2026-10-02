import { Context, Data, Effect } from "effect"

export class ProcessProbeError extends Data.TaggedError("ProcessProbeError")<{
  readonly pid: number
  readonly cause: unknown
}> {}

export interface ProcessControlShape {
  readonly currentPid: number
  readonly probe: (pid: number) => Effect.Effect<ProcessStatus, ProcessProbeError>
  readonly currentIdentity: () => Effect.Effect<string | undefined, ProcessProbeError>
  readonly identify: (pid: number) => Effect.Effect<ProcessIdentity, ProcessProbeError>
}

export class ProcessControl extends Context.Service<ProcessControl, ProcessControlShape>()(
  "expand/ProcessControl"
) {}

export type ProcessStatus = "alive" | "dead" | "inaccessible"

export type ProcessIdentity =
  | { readonly status: "alive"; readonly identity: string | undefined }
  | { readonly status: "dead" }
  | { readonly status: "inaccessible"; readonly identity: string | undefined }
