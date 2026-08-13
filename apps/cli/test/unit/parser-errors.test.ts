import { Schema } from "effect"
import { CliError } from "effect/unstable/cli"
import { describe, expect, expectTypeOf, it } from "vitest"
import { makeEnvelope } from "@expand/cli/contract/envelope"
import { ErrorEnvelope, ErrorEnvelopeFromJson } from "@expand/cli/errors/envelope"
import { makeErrorEnvelope } from "@expand/cli/errors/envelope"
import { jsonCliErrorFormatter } from "@expand/cli/errors/parser-errors"

describe("Error envelope JSON", () => {
  it("constructs the shared envelope fields before the body fields", () => {
    expect(
      Schema.encodeSync(Schema.UnknownFromJsonString)(
        makeEnvelope("Project", { created: false, data: { id: "project-id" } })
      )
    )
      .toBe('{"apiVersion":"expand/v1","kind":"Project","created":false,"data":{"id":"project-id"}}')
  })

  it("keeps the typed envelope-to-string codec contract", () => {
    expectTypeOf<typeof ErrorEnvelopeFromJson.Type>().toEqualTypeOf<ErrorEnvelope>()
    expectTypeOf<typeof ErrorEnvelopeFromJson.Encoded>().toEqualTypeOf<string>()
  })

  it("encodes exact bytes without optional fields", () => {
    const encoded = Schema.encodeSync(ErrorEnvelopeFromJson)(
      makeErrorEnvelope("UNEXPECTED", "plain", false)
    )
    expect(encoded).toBe('{"apiVersion":"expand/v1","kind":"Error","code":"UNEXPECTED","message":"plain","retryable":false}')
  })

  it("encodes retryability before optional input and hint with JSON-compatible values", () => {
    const encoded = Schema.encodeSync(ErrorEnvelopeFromJson)(
      makeErrorEnvelope("INVALID_ARGUMENT", "quote \" slash \\ newline\n雪", true, {
        input: { z: null, a: ["quote\"", "slash\\", "line\n", "雪", { nested: [1, false] }] },
        hint: "try \"again\" \\ now\n雪"
      })
    )
    expect(encoded).toBe('{"apiVersion":"expand/v1","kind":"Error","code":"INVALID_ARGUMENT","message":"quote \\" slash \\\\ newline\\n雪","retryable":true,"input":{"z":null,"a":["quote\\\"","slash\\\\","line\\n","雪",{"nested":[1,false]}]},"hint":"try \\"again\\" \\\\ now\\n雪"}')
  })

  it("retains an explicit null input", () => {
    const encoded = Schema.encodeSync(ErrorEnvelopeFromJson)(
      makeErrorEnvelope("INVALID_ARGUMENT", "null input", false, { input: null })
    )
    expect(encoded).toBe('{"apiVersion":"expand/v1","kind":"Error","code":"INVALID_ARGUMENT","message":"null input","retryable":false,"input":null}')
  })
})

describe("JSON CLI error formatter", () => {
  const missing = new CliError.MissingArgument({ argument: "target" })
  const option = new CliError.MissingOption({ option: "name" })
  const missingJson = '{"apiVersion":"expand/v1","kind":"Error","code":"INVALID_ARGUMENT","message":"Missing required argument: target","retryable":false}'
  const optionJson = '{"apiVersion":"expand/v1","kind":"Error","code":"INVALID_OPTION","message":"Missing required flag: --name","retryable":false}'

  it("formats single parser errors with exact bytes", () => {
    expect(jsonCliErrorFormatter.formatCliError(missing)).toBe(missingJson)
    expect(jsonCliErrorFormatter.formatError(missing)).toBe(missingJson)
  })

  it("formats parser errors as newline-delimited JSON without a trailing newline", () => {
    expect(jsonCliErrorFormatter.formatErrors([missing, option])).toBe(`${missingJson}\n${optionJson}`)
    expect(jsonCliErrorFormatter.formatErrors([])).toBe("")
  })
})
