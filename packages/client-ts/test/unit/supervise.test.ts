import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Fiber, Logger } from "effect"
import { supervised } from "../../supervise"

const captureLogger = (entries: Array<string>) =>
  Logger.make((options) => {
    const parts = Array.isArray(options.message) ? options.message : [options.message]
    entries.push(parts.map(String).join(" "))
  })

describe("supervised", () => {
  it.effect("logs an error when a forked supervised effect fails", () => {
    const entries: Array<string> = []
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(supervised("supervise-test", Effect.fail("boom")))
      yield* Fiber.join(fiber).pipe(Effect.exit)
      expect(entries.some((line) => line.includes("[supervise-test] background fiber died"))).toBe(true)
    }).pipe(Effect.provide(Logger.layer([captureLogger(entries)])))
  })

  it.effect("does not log when a forked supervised effect is interrupted", () => {
    const entries: Array<string> = []
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(supervised("supervise-test", Effect.never))
      yield* Fiber.interrupt(fiber)
      expect(entries).toHaveLength(0)
    }).pipe(Effect.provide(Logger.layer([captureLogger(entries)])))
  })
})
