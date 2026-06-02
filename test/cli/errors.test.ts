import { describe, expect, it } from "vitest"
import { Runtime } from "effect"
import { BackendUnreachable, ProjectExists, ProjectNotFoundCli, Unexpected, mapContractError } from "@yodea/cli/errors"
import { ProjectAlreadyExists, ProjectNotFound } from "@yodea/contracts/rpc"
import { BackendUnavailable } from "@yodea/client-core"

describe("cli errors", () => {
  it("ProjectExists -> code/exit 5/non-retryable envelope", () => {
    const e = new ProjectExists({ name: "foo" })
    expect(Runtime.getErrorExitCode(e)).toBe(5)
    expect(e.toEnvelope()).toMatchObject({ kind: "Error", code: "PROJECT_EXISTS", retryable: false, input: { name: "foo" } })
  })

  it("BackendUnreachable -> exit 6, retryable", () => {
    const e = new BackendUnreachable({ reason: "boom" })
    expect(Runtime.getErrorExitCode(e)).toBe(6)
    expect(e.toEnvelope()).toMatchObject({ code: "BACKEND_UNREACHABLE", retryable: true })
  })

  it("Unexpected -> exit 1", () => {
    expect(Runtime.getErrorExitCode(new Unexpected({ detail: "x" }))).toBe(1)
  })

  it("ProjectNotFoundCli -> code/exit 7/non-retryable envelope", () => {
    const e = new ProjectNotFoundCli({ id: "x" })
    expect(Runtime.getErrorExitCode(e)).toBe(7)
    expect(e.toEnvelope()).toMatchObject({ kind: "Error", code: "PROJECT_NOT_FOUND", retryable: false, input: { id: "x" } })
  })

  it("maps contract errors by tag", () => {
    expect(mapContractError(new ProjectAlreadyExists({ name: "foo" }))).toBeInstanceOf(ProjectExists)
    expect(mapContractError(new ProjectNotFound({ id: "ghost" }))).toBeInstanceOf(ProjectNotFoundCli)
    expect(mapContractError(new BackendUnavailable({ reason: "down" }))).toBeInstanceOf(BackendUnreachable)
    expect(mapContractError(new Error("???"))).toBeInstanceOf(Unexpected)
  })
})
