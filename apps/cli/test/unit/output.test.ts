import { it } from "@effect/vitest"
import { Console, Effect } from "effect"
import { describe, expect, expectTypeOf } from "vitest"
import { successLine, writeErr, writeOut } from "@expand/cli/output"

const capturingConsole = (stdout: Array<string>, stderr: Array<string>): Console.Console => ({
  log: (...values: ReadonlyArray<unknown>) => { stdout.push(values.map(String).join(" ")) },
  error: (...values: ReadonlyArray<unknown>) => { stderr.push(values.map(String).join(" ")) }
} as unknown as Console.Console)

describe("CLI output", () => {
  it("encodes JSON success output with exact compact bytes", () => {
    expect(successLine(
      { format: "json", quiet: false },
      {
        envelope: {
          apiVersion: "expand/v1",
          kind: "Thing",
          message: "quote \" slash \\ newline\n雪",
          nested: { z: 1, a: [true, null, "x"] }
        },
        text: "text",
        quiet: "quiet"
      }
    )).toBe('{"apiVersion":"expand/v1","kind":"Thing","message":"quote \\" slash \\\\ newline\\n雪","nested":{"z":1,"a":[true,null,"x"]}}')
  })

  it("preserves text and quiet bytes without evaluating the JSON encoder", () => {
    const parts = { envelope: { value: 1n }, text: "text\nline", quiet: "quiet\nline" }
    expect(successLine({ format: "json", quiet: true }, parts)).toBe("quiet\nline")
    expect(successLine({ format: "text", quiet: false }, parts)).toBe("text\nline")
  })

  it.effect("routes stdout and stderr through only their intended Console channels", () => {
    const stdout: Array<string> = []
    const stderr: Array<string> = []
    return Effect.all([writeOut("out"), writeErr("err")], { discard: true }).pipe(
      Effect.provideService(Console.Console, capturingConsole(stdout, stderr)),
      Effect.tap(() => Effect.sync(() => {
        expect(stdout).toEqual(["out"])
        expect(stderr).toEqual(["err"])
      }))
    )
  })

  it("keeps write effects infallible and service-free", () => {
    expectTypeOf(writeOut("out")).toEqualTypeOf<Effect.Effect<void>>()
    expectTypeOf(writeErr("err")).toEqualTypeOf<Effect.Effect<void>>()
  })
})
