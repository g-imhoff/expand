import { it } from "@effect/vitest"
import { Cause, Data, Effect, Exit, PlatformError, Schema } from "effect"
import { describe, expect } from "vitest"
import { guard } from "@expand/server/rpc/guard"

class DomainError extends Data.TaggedError("DomainError")<{ readonly why: string }> {}

describe("guard", () => {
  it.effect("passes successes through", () =>
    Effect.exit(guard(Effect.succeed(42))).pipe(
      Effect.map((exit) => expect(exit).toStrictEqual(Exit.succeed(42)))
    ))

  it.effect("lets a declared domain error cross the wire (stays a failure)", () =>
    Effect.exit(guard(Effect.fail(new DomainError({ why: "nope" })))).pipe(
      Effect.map((exit) => {
        expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      })
    ))

  it.effect("turns an infra error (SchemaError) into a defect (dies)", () => {
    // A failed decode yields a Schema.SchemaError — one of the infra errors guard kills.
    return Effect.exit(guard(Schema.decodeUnknownEffect(Schema.Number)("not-a-number"))).pipe(
      Effect.map((exit) => {
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      })
    )
  })

  it.effect("turns a PlatformError into a defect", () => {
    const error = PlatformError.badArgument({
      module: "Crypto",
      method: "randomUUIDv4",
      description: "unavailable"
    })

    return Effect.exit(guard(Effect.fail(error))).pipe(
      Effect.map((exit) => {
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      })
    )
  })
})
