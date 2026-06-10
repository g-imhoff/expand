import { describe, expect, it } from "vitest"
import { Effect, Fiber, Logger } from "effect"
import { supervised } from "@yodea/client-core/supervise"

const captureLogger = (entries: Array<string>) =>
  Logger.make((options) => {
    const parts = Array.isArray(options.message) ? options.message : [options.message]
    entries.push(parts.map(String).join(" "))
  })

describe("supervised", () => {
  it("logs an error when a forked supervised effect fails", async () => {
    const entries: Array<string> = []
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(supervised("supervise-test", Effect.fail("boom")))
      yield* Fiber.await(fiber)
    }).pipe(Effect.provide(Logger.layer([captureLogger(entries)])))
    await Effect.runPromise(program)
    expect(entries.some((line) => line.includes("[supervise-test] background fiber died"))).toBe(true)
  })

  it("does not log when a forked supervised effect is interrupted", async () => {
    const entries: Array<string> = []
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(supervised("supervise-test", Effect.never))
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provide(Logger.layer([captureLogger(entries)])))
    await Effect.runPromise(program)
    expect(entries).toHaveLength(0)
  })
})
