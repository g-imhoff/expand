import { Data } from "effect"

export class BackendCommandError extends Data.TaggedError("BackendCommandError")<{
  readonly reason: "invalid-override" | "source-check-failed" | "not-configured"
  readonly detail: string
  readonly cause?: unknown
}> {}

export class BackendUnavailable extends Data.TaggedError("BackendUnavailable")<{
  readonly reason: string
}> {}

export class SpawnLockError extends Data.TaggedError("SpawnLockError")<{
  readonly kind: "filesystem" | "crypto" | "digest" | "schema" | "probe"
  readonly operation: string
  readonly path: string
  readonly cause: unknown
}> {}
