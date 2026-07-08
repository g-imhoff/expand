import { describe, expect, it } from "vitest"
import { Cause, Data, Effect, Exit, Schema } from "effect"
import { guard } from "@expand/server/rpc/guard"

class DomainError extends Data.TaggedError("DomainError")<{ readonly why: string }> {}

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(Effect.exit(eff))

describe("guard", () => {
  it("passes successes through", async () => {
    const exit = await run(guard(Effect.succeed(42)))
    expect(exit).toStrictEqual(Exit.succeed(42))
  })

  it("lets a declared domain error cross the wire (stays a failure)", async () => {
    const exit = await run(guard(Effect.fail(new DomainError({ why: "nope" }))))
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
  })

  it("turns an infra error (SchemaError) into a defect (dies)", async () => {
    // A failed decode yields a Schema.SchemaError — one of the infra errors guard kills.
    const exit = await run(guard(Schema.decodeUnknownEffect(Schema.Number)("not-a-number")))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  })
})
