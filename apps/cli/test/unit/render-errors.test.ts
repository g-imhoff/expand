import { it } from "@effect/vitest"
import { Cause, Console, Context, Effect, Runtime, Schema } from "effect"
import { CliError } from "effect/unstable/cli"
import { describe, expect, expectTypeOf } from "vitest"
import { ProjectAlreadyExists } from "@expand/contracts/rpc"
import { renderErrors } from "@expand/cli/errors/render-errors"

class RenderService extends Context.Service<RenderService, string>()("expand/CliRenderErrorsTest") {}

const capturingConsole = (stdout: Array<string>, stderr: Array<string>): Console.Console => ({
  log: (...values: ReadonlyArray<unknown>) => { stdout.push(values.map(String).join(" ")) },
  error: (...values: ReadonlyArray<unknown>) => { stderr.push(values.map(String).join(" ")) }
} as unknown as Console.Console)

describe("renderErrors", () => {
  it.effect("emits exact parser-error bytes to stderr and exits 2", () => {
    const stdout: Array<string> = []
    const stderr: Array<string> = []
    return renderErrors(Effect.fail(new CliError.MissingArgument({ argument: "target" }))).pipe(
      Effect.provideService(Console.Console, capturingConsole(stdout, stderr)),
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => {
        expect(stdout).toEqual([])
        expect(stderr).toEqual(['{"apiVersion":"expand/v1","kind":"Error","code":"INVALID_ARGUMENT","message":"Missing required argument: target","retryable":false}'])
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(Runtime.getErrorExitCode(Cause.squash(exit.cause))).toBe(2)
        }
      }))
    )
  })

  it.effect("emits exact mapped contract-error bytes to stderr and retains exit 5", () => {
    const stdout: Array<string> = []
    const stderr: Array<string> = []
    return renderErrors(Effect.fail(new ProjectAlreadyExists({ name: "a\"\\\n雪" }))).pipe(
      Effect.provideService(Console.Console, capturingConsole(stdout, stderr)),
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => {
        expect(stdout).toEqual([])
        expect(stderr).toEqual(['{"apiVersion":"expand/v1","kind":"Error","code":"PROJECT_EXISTS","message":"project \'a\\"\\\\\\n雪\' already exists","retryable":false,"input":{"name":"a\\"\\\\\\n雪"},"hint":"choose a different name, or re-run with --ensure to no-op"}'])
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(Runtime.getErrorExitCode(Cause.squash(exit.cause))).toBe(5)
        }
      }))
    )
  })

  it.effect("maps help without errors to success", () =>
    renderErrors(Effect.fail(new CliError.ShowHelp({ commandPath: ["expand"], errors: [] }))).pipe(
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => {
        expect(exit._tag).toBe("Success")
      }))
    ))

  it.effect("maps help with errors to usage exit", () =>
    renderErrors(Effect.fail(new CliError.ShowHelp({
      commandPath: ["expand"],
      errors: [new CliError.MissingArgument({ argument: "target" })]
    }))).pipe(
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => {
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(Runtime.getErrorExitCode(Cause.squash(exit.cause))).toBe(2)
        }
      }))
    ))

  it("preserves generic success and services without exposing schema failures", () => {
    const rendered = renderErrors(Effect.map(RenderService, (value) => value))
    expectTypeOf<Effect.Success<typeof rendered>>().toEqualTypeOf<string | void>()
    expectTypeOf<Effect.Services<typeof rendered>>().toEqualTypeOf<RenderService>()
    expectTypeOf<Extract<Effect.Error<typeof rendered>, Schema.SchemaError>>().toEqualTypeOf<never>()
  })
})
