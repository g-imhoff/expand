import { Data, Runtime } from "effect"
import type { ErrorEnvelope } from "@expand/cli/contract/envelope"
import { makeEnvelope, tagOf } from "@expand/cli/errors/envelope"

export class BackendUnreachable extends Data.TaggedError("BackendUnreachable")<{ readonly reason: string }> {
  readonly [Runtime.errorExitCode] = 6
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return makeEnvelope("BACKEND_UNREACHABLE", `could not reach a Expand backend: ${this.reason}`, true, {
      hint: "retry; a backend will be auto-spawned"
    })
  }
}

export class Unexpected extends Data.TaggedError("Unexpected")<{ readonly detail: string }> {
  readonly [Runtime.errorExitCode] = 1
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return makeEnvelope("UNEXPECTED", this.detail, false)
  }
}

export type ServerCliError = BackendUnreachable | Unexpected

export const mapServerError = (e: unknown): ServerCliError | undefined => {
  switch (tagOf(e)) {
    case "BackendUnavailable":
      return new BackendUnreachable({ reason: (e as { reason: string }).reason })
    case "RpcClientError":
      return new BackendUnreachable({ reason: String((e as { message?: unknown }).message ?? "rpc transport error") })
    default:
      return undefined
  }
}

export const mapUnexpectedError = (e: unknown): Unexpected =>
  new Unexpected({ detail: e instanceof Error ? e.message : String(e) })
