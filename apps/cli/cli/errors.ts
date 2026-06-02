import { Data, Runtime } from "effect"
import { CliError, CliOutput } from "effect/unstable/cli"
import { API_VERSION, type ErrorCode, type ErrorEnvelope } from "@yodea/contracts/cli"

const make = (
  code: ErrorCode,
  message: string,
  retryable: boolean,
  extra?: { input?: unknown; hint?: string }
): ErrorEnvelope => ({
  apiVersion: API_VERSION,
  kind: "Error",
  code,
  message,
  retryable,
  ...(extra?.input !== undefined ? { input: extra.input } : {}),
  ...(extra?.hint !== undefined ? { hint: extra.hint } : {})
})

export class ProjectExists extends Data.TaggedError("ProjectExists")<{ readonly name: string }> {
  readonly [Runtime.errorExitCode] = 5
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return make("PROJECT_EXISTS", `project '${this.name}' already exists`, false, {
      input: { name: this.name },
      hint: "choose a different name, or re-run with --ensure to no-op"
    })
  }
}

export class ProjectNotFoundCli extends Data.TaggedError("ProjectNotFoundCli")<{ readonly id: string }> {
  readonly [Runtime.errorExitCode] = 7
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return make("PROJECT_NOT_FOUND", `project '${this.id}' not found`, false, {
      input: { id: this.id },
      hint: "check the project name or id (try `yodea project list`)"
    })
  }
}

export class NameConflictCli extends Data.TaggedError("NameConflictCli")<{ readonly name: string }> {
  readonly [Runtime.errorExitCode] = 8
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return make("NAME_CONFLICT", `project name '${this.name}' is already taken`, false, {
      input: { name: this.name },
      hint: "choose a different name"
    })
  }
}

export class DirectoryInvalidCli extends Data.TaggedError("DirectoryInvalidCli")<{ readonly directory: string; readonly reason: string }> {
  readonly [Runtime.errorExitCode] = 9
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return make("DIRECTORY_INVALID", `directory '${this.directory}' is invalid: ${this.reason}`, false, {
      input: { directory: this.directory, reason: this.reason },
      hint: "pass an absolute path that exists on disk"
    })
  }
}

export class DirectoryConflictCli extends Data.TaggedError("DirectoryConflictCli")<{ readonly directory: string }> {
  readonly [Runtime.errorExitCode] = 10
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return make("DIRECTORY_CONFLICT", `directory '${this.directory}' is already used by another project`, false, {
      input: { directory: this.directory },
      hint: "choose a different directory"
    })
  }
}

export class BackendUnreachable extends Data.TaggedError("BackendUnreachable")<{ readonly reason: string }> {
  readonly [Runtime.errorExitCode] = 6
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return make("BACKEND_UNREACHABLE", `could not reach a Yodea backend: ${this.reason}`, true, {
      hint: "retry; a backend will be auto-spawned"
    })
  }
}

export class Unexpected extends Data.TaggedError("Unexpected")<{ readonly detail: string }> {
  readonly [Runtime.errorExitCode] = 1
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return make("UNEXPECTED", this.detail, false)
  }
}

export type YodeaCliError = ProjectExists | ProjectNotFoundCli | NameConflictCli | DirectoryInvalidCli | DirectoryConflictCli | BackendUnreachable | Unexpected

const tagOf = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "_tag" in e ? (e as { _tag: string })._tag : undefined

export const mapContractError = (e: unknown): YodeaCliError => {
  switch (tagOf(e)) {
    case "ProjectAlreadyExists":
      return new ProjectExists({ name: (e as { name: string }).name })
    case "ProjectNotFound":
      return new ProjectNotFoundCli({ id: (e as { id: string }).id })
    case "ProjectNameConflict":
      return new NameConflictCli({ name: (e as { name: string }).name })
    case "ProjectDirectoryInvalid":
      return new DirectoryInvalidCli({ directory: (e as { directory: string }).directory, reason: (e as { reason: string }).reason })
    case "ProjectDirectoryConflict":
      return new DirectoryConflictCli({ directory: (e as { directory: string }).directory })
    case "BackendUnavailable":
      return new BackendUnreachable({ reason: (e as { reason: string }).reason })
    case "RpcClientError":
      return new BackendUnreachable({ reason: String((e as { message?: unknown }).message ?? "rpc transport error") })
    default:
      return new Unexpected({ detail: e instanceof Error ? e.message : String(e) })
  }
}

const cliErrorToEnvelope = (e: CliError.CliError): ErrorEnvelope => {
  switch (e._tag) {
    case "InvalidValue":
    case "MissingArgument":
      return make("INVALID_ARGUMENT", e.message, false)
    case "MissingOption":
    case "UnrecognizedOption":
    case "DuplicateOption":
      return make("INVALID_OPTION", e.message, false)
    case "UnknownSubcommand":
      return make("UNKNOWN_COMMAND", e.message, false)
    default:
      return make("INVALID_ARGUMENT", e.message, false)
  }
}

export const jsonCliErrorFormatter: CliOutput.Formatter = {
  ...CliOutput.defaultFormatter(),
  formatCliError: (e) => JSON.stringify(cliErrorToEnvelope(e)),
  formatError: (e) => JSON.stringify(cliErrorToEnvelope(e)),
  formatErrors: (errors) => errors.map((e) => JSON.stringify(cliErrorToEnvelope(e))).join("\n")
}
