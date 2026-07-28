import { it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import type { TestInfo } from "@playwright/test"
import { Cause, Data, Effect, Exit, FileSystem, Path, type Scope } from "effect"
import { describe, expect, vi } from "vitest"
import {
  makeTestEffect,
  type EffectTestFixtures,
  type EffectTestRegistration,
  type PlaywrightFixtures
} from "../../../e2e/effect-test"
import { launchApp, type LaunchAppDependencies } from "../../../e2e/helpers"

type RegisteredCallback = Parameters<EffectTestRegistration>[1]

const fakeFixtures = {} as PlaywrightFixtures

const fakeTestInfo = (timeout = 1_000, configFile = "/workspace/apps/desktop/e2e/playwright.config.ts") =>
  ({ timeout, config: { configFile } }) as TestInfo

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

class PlaywrightCallbackError extends Data.TaggedError("PlaywrightCallbackError")<{
  readonly cause: unknown
}> {}

const invoke = (
  callback: RegisteredCallback,
  testInfo = fakeTestInfo(),
  onPropagation?: () => void
) =>
  Effect.tryPromise({
    try: () => callback(fakeFixtures, testInfo) as never,
    catch: (cause) => {
      onPropagation?.()
      return new PlaywrightCallbackError({ cause })
    }
  }).pipe(Effect.mapError((error) => error.cause))

const observeCause = <E, R>(
  effect: Effect.Effect<void, E, R>,
  capture: (cause: Cause.Cause<E>) => void
): Effect.Effect<void, E, R> =>
  effect.pipe(Effect.onError((cause) => Effect.sync(() => capture(cause))))

const singleReason = (cause: Cause.Cause<unknown> | undefined) => {
  if (cause === undefined || cause.reasons.length !== 1) throw new Error("expected one captured failure reason")
  const reason = cause.reasons[0]
  if (reason === undefined) throw new Error("expected one captured failure reason")
  return reason
}

describe("Effect Playwright adapter", () => {
  it.effect("invokes the Effect body with Playwright fixtures and TestInfo", () =>
    Effect.gen(function* () {
      const harness = registrationHarness()
      const testEffect = makeTestEffect(harness.register)
      let receivedFixtures: EffectTestFixtures | undefined
      let receivedInfo: TestInfo | undefined
      const info = fakeTestInfo()

      testEffect("successful effect", (fixtures, testInfo) => Effect.sync(() => {
        receivedFixtures = fixtures
        receivedInfo = testInfo
      }))

      yield* invoke(harness.callback(), info)
      expect(harness.name()).toBe("successful effect")
      expect(receivedFixtures).toEqual({})
      expect(receivedInfo).toBe(info)
    }))

  it.effect("propagates an exact typed failure after finalization", () =>
    Effect.gen(function* () {
      const harness = registrationHarness()
      const testEffect = makeTestEffect(harness.register)
      const failure = { _tag: "TypedFailure", message: "typed failure" } as const
      const events: Array<string> = []
      let captured: Cause.Cause<typeof failure> | undefined
      testEffect("typed failure", () =>
        observeCause(
          Effect.fail(failure).pipe(Effect.ensuring(Effect.sync(() => events.push("finalize")))),
          (cause) => {
            captured = cause
          }
        ))

      const exit = yield* Effect.exit(invoke(harness.callback(), fakeTestInfo(), () => events.push("propagate")))
      if (Exit.isSuccess(exit)) throw new Error("typed failure unexpectedly succeeded")
      const reason = singleReason(captured)
      expect(Cause.isFailReason(reason)).toBe(true)
      if (!Cause.isFailReason(reason)) throw new Error("expected typed failure reason")
      expect(reason.error).toBe(failure)
      expect(Cause.squash(exit.cause)).toBe(failure)
      expect(events).toEqual(["finalize", "propagate"])
    }))

  it.effect("propagates an exact defect after finalization", () =>
    Effect.gen(function* () {
      const harness = registrationHarness()
      const testEffect = makeTestEffect(harness.register)
      const defect = new Error("defect")
      const events: Array<string> = []
      let captured: Cause.Cause<never> | undefined
      testEffect("defect", () =>
        observeCause(
          Effect.die(defect).pipe(Effect.ensuring(Effect.sync(() => events.push("finalize")))),
          (cause) => {
            captured = cause
          }
        ))

      const exit = yield* Effect.exit(invoke(harness.callback(), fakeTestInfo(), () => events.push("propagate")))
      if (Exit.isSuccess(exit)) throw new Error("defect unexpectedly succeeded")
      const reason = singleReason(captured)
      expect(Cause.isDieReason(reason)).toBe(true)
      if (!Cause.isDieReason(reason)) throw new Error("expected defect reason")
      expect(reason.defect).toBe(defect)
      expect(Cause.squash(exit.cause)).toBe(defect)
      expect(events).toEqual(["finalize", "propagate"])
    }))

  it.effect("propagates interruption after finalization", () =>
    Effect.gen(function* () {
      const harness = registrationHarness()
      const testEffect = makeTestEffect(harness.register)
      const events: Array<string> = []
      let captured: Cause.Cause<never> | undefined
      testEffect("interruption", () =>
        observeCause(
          Effect.interrupt.pipe(Effect.ensuring(Effect.sync(() => events.push("finalize")))),
          (cause) => {
            captured = cause
          }
        ))

      const exit = yield* Effect.exit(invoke(harness.callback(), fakeTestInfo(), () => events.push("propagate")))
      if (Exit.isSuccess(exit)) throw new Error("interruption unexpectedly succeeded")
      const reason = singleReason(captured)
      expect(Cause.isInterruptReason(reason)).toBe(true)
      expect(Cause.squash(exit.cause)).toEqual(new Error("All fibers interrupted without error"))
      expect(events).toEqual(["finalize", "propagate"])
    }))

  it.effect("interrupts and finalizes the Effect before the Playwright timeout", () =>
    Effect.gen(function* () {
      const harness = registrationHarness()
      const testEffect = makeTestEffect(harness.register)
      const events: Array<string> = []
      let captured: Cause.Cause<never> | undefined
      testEffect("timeout", () =>
        observeCause(
          Effect.never.pipe(Effect.ensuring(Effect.sync(() => events.push("finalize")))),
          (cause) => {
            captured = cause
          }
        ))

      const exit = yield* Effect.exit(invoke(harness.callback(), fakeTestInfo(40), () => events.push("propagate")))
      if (Exit.isSuccess(exit)) throw new Error("timeout unexpectedly succeeded")
      const reason = singleReason(captured)
      expect(Cause.isInterruptReason(reason)).toBe(true)
      const propagated = Cause.squash(exit.cause)
      expect(propagated).toBeInstanceOf(Cause.TimeoutError)
      if (!(propagated instanceof Cause.TimeoutError)) throw new Error("expected timeout error")
      expect(propagated._tag).toBe("TimeoutError")
      expect(events).toEqual(["finalize", "propagate"])
    }))

  it.effect("rejects a missing config path instead of resolving from cwd", () =>
    Effect.gen(function* () {
      const launch = vi.fn()
      const exit = yield* launchApp("", { launch }).pipe(Effect.scoped, Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(launch).not.toHaveBeenCalled()
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("recursively removes real backend artifacts from the E2E data directory", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      let dataHome = ""
      const waitFor = vi.fn().mockResolvedValue(undefined)
      const fakeApp = {
        close: vi.fn().mockResolvedValue(undefined),
        firstWindow: vi.fn().mockResolvedValue({ getByText: () => ({ waitFor }) })
      }
      const launch = vi.fn().mockResolvedValue(fakeApp)
      yield* Effect.scoped(
        launchApp("/workspace/apps/desktop/e2e/playwright.config.ts", { launch }).pipe(
          Effect.tap(() => {
            dataHome = launch.mock.calls[0]?.[0].args?.at(-1) ?? ""
            return fs.writeFileString(`${dataHome}/events.db`, "owned")
          })
        )
      )
      expect(yield* fs.exists(dataHome)).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("cleans every launch owner before propagating an assertion Promise failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const events: Array<string> = []
      const assertionFailure = new Error("assertion failed")
      const cleanups = {
        listener: vi.fn(() => events.push("listener")),
        cdp: vi.fn(() => events.push("cdp")),
        backend: vi.fn(() => events.push("backend")),
        app: vi.fn(() => events.push("app"))
      }
      let dataHome = ""
      const waitFor = vi.fn().mockResolvedValue(undefined)
      const fakeApp = {
        close: vi.fn().mockImplementation(() => {
          cleanups.listener()
          cleanups.cdp()
          cleanups.backend()
          cleanups.app()
          return waitFor() as never
        }),
        firstWindow: vi.fn().mockResolvedValue({
          getByText: () => ({ waitFor })
        })
      }
      const launch = vi.fn().mockResolvedValue(fakeApp)
      const dependencies: LaunchAppDependencies = { launch }
      const harness = registrationHarness()
      const testEffect = makeTestEffect(harness.register)
      const configFile = "/workspace/apps/desktop/e2e/playwright.config.ts"
      const assertion = vi.fn().mockRejectedValue(assertionFailure)
      testEffect("assertion failure", (_fixtures, testInfo) =>
        launchApp(testInfo.config.configFile ?? "", dependencies).pipe(
          Effect.andThen(Effect.tryPromise(() => assertion()))
        ))

      const exit = yield* Effect.exit(invoke(harness.callback(), fakeTestInfo(1_000, configFile), () => {
        events.push("propagate")
      }))
      dataHome = launch.mock.calls[0]?.[0].args?.at(-1) ?? ""
      if (Exit.isSuccess(exit)) throw new Error("assertion failure unexpectedly succeeded")
      if (!(yield* fs.exists(dataHome))) events.splice(events.indexOf("propagate"), 0, "temp")
      const propagated = Cause.squash(exit.cause)
      expect(propagated).toBeInstanceOf(Cause.UnknownError)
      if (!(propagated instanceof Cause.UnknownError)) throw new Error("expected unknown host error")
      expect(propagated.cause).toBe(assertionFailure)
      expect(cleanups.listener).toHaveBeenCalledOnce()
      expect(cleanups.cdp).toHaveBeenCalledOnce()
      expect(cleanups.backend).toHaveBeenCalledOnce()
      expect(cleanups.app).toHaveBeenCalledOnce()
      expect(fakeApp.close).toHaveBeenCalledOnce()
      expect(events).toEqual(["listener", "cdp", "backend", "app", "temp", "propagate"])
      expect(launch.mock.calls[0]?.[0].args?.[1]).toBe(path.resolve("/workspace/apps/desktop/out/main/index.mjs"))
      expect(launch.mock.calls[0]?.[0].cwd).toBe("/workspace")
    }).pipe(Effect.provide(NodeServices.layer)))
})
