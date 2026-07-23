import { it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem } from "effect"
import { describe, expect, vi } from "vitest"
import { makeTestEffect, type EffectTestRegistration } from "./effect-test"
import { launchApp, type LaunchAppDependencies } from "./helpers"

type RegisteredCallback = Parameters<EffectTestRegistration>[1]

const registrationHarness = () => {
  let callback: RegisteredCallback | undefined
  let registeredName: string | undefined
  const register: EffectTestRegistration = (name, body) => {
    registeredName = name
    callback = body
  }
  return {
    callback: () => {
      if (callback === undefined) throw new Error("test callback was not registered")
      return callback
    },
    name: () => registeredName,
    register
  }
}

const invoke = (
  callback: RegisteredCallback,
  signal?: AbortSignal,
  capture?: (running: ReturnType<RegisteredCallback>) => void
) =>
  Effect.tryPromise({
    try: (attemptSignal) => {
      const running = callback({}, { signal: signal ?? attemptSignal })
      capture?.(running)
      return running as never
    },
    catch: (cause) => cause
  })

describe("Effect Playwright adapter", () => {
  it.effect("registers the title and completes successful effects", () =>
    Effect.gen(function* () {
      const harness = registrationHarness()
      const testEffect = makeTestEffect(harness.register)
      let completed = false

      testEffect("successful effect", Effect.sync(() => {
        completed = true
      }))

      yield* invoke(harness.callback())
      expect(harness.name()).toBe("successful effect")
      expect(completed).toBe(true)
    }))

  it.effect("propagates typed failures", () =>
    Effect.gen(function* () {
      const harness = registrationHarness()
      const testEffect = makeTestEffect(harness.register)
      testEffect("typed failure", Effect.fail("typed failure"))

      const exit = yield* Effect.exit(invoke(harness.callback()))
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("propagates defects", () =>
    Effect.gen(function* () {
      const harness = registrationHarness()
      const testEffect = makeTestEffect(harness.register)
      testEffect("defect", Effect.die("defect"))

      const exit = yield* Effect.exit(invoke(harness.callback()))
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("propagates interruption", () =>
    Effect.gen(function* () {
      const harness = registrationHarness()
      const testEffect = makeTestEffect(harness.register)
      testEffect("interruption", Effect.interrupt)

      const exit = yield* Effect.exit(invoke(harness.callback()))
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("forwards cancellation signals to the Effect runner", () =>
    Effect.gen(function* () {
      const harness = registrationHarness()
      const testEffect = makeTestEffect(harness.register)
      const finalized = yield* Deferred.make<void>()
      testEffect(
        "cancelled",
        Effect.never.pipe(Effect.ensuring(Deferred.succeed(finalized, undefined)))
      )

      let running: ReturnType<RegisteredCallback> | undefined
      const fiber = yield* Effect.forkChild(invoke(harness.callback(), undefined, (promise) => {
        running = promise
      }))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      if (running === undefined) throw new Error("test callback did not start")
      const started = running
      yield* Effect.exit(Effect.tryPromise(() => started as never))
      expect(yield* Deferred.isDone(finalized)).toBe(true)
    }))

  it.effect("completes scoped finalizers before propagating failure", () =>
    Effect.gen(function* () {
      const harness = registrationHarness()
      const testEffect = makeTestEffect(harness.register)
      const events: Array<string> = []
      testEffect(
        "finalized",
        Effect.acquireRelease(
          Effect.sync(() => events.push("acquire")),
          () => Effect.sync(() => events.push("release"))
        ).pipe(Effect.andThen(Effect.fail("assertion failed")))
      )

      yield* Effect.exit(invoke(harness.callback()))
      expect(events).toEqual(["acquire", "release"])
    }))

  it.effect("closes the app and removes its temp directory after an assertion failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const close = vi.fn().mockResolvedValue(undefined)
      const waitFor = vi.fn().mockResolvedValue(undefined)
      const fakeApp = {
        close,
        firstWindow: vi.fn().mockResolvedValue({
          getByText: () => ({ waitFor })
        })
      }
      const launch = vi.fn().mockResolvedValue(fakeApp)
      const dependencies: LaunchAppDependencies = { launch }

      const exit = yield* launchApp(dependencies).pipe(
        Effect.andThen(Effect.fail("assertion failed")),
        Effect.scoped,
        Effect.exit
      )

      if (Exit.isSuccess(exit)) throw new Error("assertion failure unexpectedly succeeded")
      expect(Cause.squash(exit.cause)).toBe("assertion failed")
      expect(close).toHaveBeenCalledOnce()
      const dataHome = launch.mock.calls[0]?.[0].args?.at(-1) ?? ""
      expect(yield* fs.exists(dataHome)).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)))
})
