import { Data, Runtime } from "effect"
import type { ErrorEnvelope } from "@expand/cli/contract/envelope"
import { makeEnvelope, tagOf } from "@expand/cli/errors/envelope"

export class ProjectExists extends Data.TaggedError("ProjectExists")<{ readonly name: string }> {
  readonly [Runtime.errorExitCode] = 5
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return makeEnvelope("PROJECT_EXISTS", `project '${this.name}' already exists`, false, {
      input: { name: this.name },
      hint: "choose a different name, or re-run with --ensure to no-op"
    })
  }
}

export class ProjectNotFoundCli extends Data.TaggedError("ProjectNotFoundCli")<{ readonly id: string }> {
  readonly [Runtime.errorExitCode] = 7
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return makeEnvelope("PROJECT_NOT_FOUND", `project '${this.id}' not found`, false, {
      input: { id: this.id },
      hint: "check the project name or id (try `expand project list`)"
    })
  }
}

export type ProjectCliError = ProjectExists | ProjectNotFoundCli | NameConflictCli | DirectoryInvalidCli | DirectoryConflictCli | InvalidInputCli

export const mapProjectError = (e: unknown): ProjectCliError | undefined => {
  switch (tagOf(e)) {
    case "ProjectAlreadyExists":
      return new ProjectExists({ name: (e as { name: string }).name })
    case "ProjectInvalidInput":
      return new InvalidInputCli({ field: (e as { field: string }).field, reason: (e as { reason: string }).reason })
    case "ProjectNotFound":
      return new ProjectNotFoundCli({ id: (e as { id: string }).id })
    case "ProjectNameConflict":
      return new NameConflictCli({ name: (e as { name: string }).name })
    case "ProjectDirectoryInvalid":
      return new DirectoryInvalidCli({ directory: (e as { directory: string }).directory, reason: (e as { reason: string }).reason })
    case "ProjectDirectoryConflict":
      return new DirectoryConflictCli({ directory: (e as { directory: string }).directory })
    default:
      return undefined
  }
}

class NameConflictCli extends Data.TaggedError("NameConflictCli")<{ readonly name: string }> {
  readonly [Runtime.errorExitCode] = 8
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return makeEnvelope("NAME_CONFLICT", `project name '${this.name}' is already taken`, false, {
      input: { name: this.name },
      hint: "choose a different name"
    })
  }
}

class DirectoryInvalidCli extends Data.TaggedError("DirectoryInvalidCli")<{ readonly directory: string; readonly reason: string }> {
  readonly [Runtime.errorExitCode] = 9
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return makeEnvelope("DIRECTORY_INVALID", `directory '${this.directory}' is invalid: ${this.reason}`, false, {
      input: { directory: this.directory, reason: this.reason },
      hint: "pass an absolute path that exists on disk"
    })
  }
}

class DirectoryConflictCli extends Data.TaggedError("DirectoryConflictCli")<{ readonly directory: string }> {
  readonly [Runtime.errorExitCode] = 10
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return makeEnvelope("DIRECTORY_CONFLICT", `directory '${this.directory}' is already used by another project`, false, {
      input: { directory: this.directory },
      hint: "choose a different directory"
    })
  }
}

class InvalidInputCli extends Data.TaggedError("InvalidInputCli")<{ readonly field: string; readonly reason: string }> {
  readonly [Runtime.errorExitCode] = 2
  readonly [Runtime.errorReported] = false
  toEnvelope(): ErrorEnvelope {
    return makeEnvelope("INVALID_ARGUMENT", `invalid ${this.field}: ${this.reason}`, false, {
      input: { field: this.field, reason: this.reason },
      hint: "names and tags must match ^[a-z0-9][a-z0-9-]{0,63}$; descriptions are capped at 2048 chars"
    })
  }
}
