import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Scope } from "effect"
import { describe, expect } from "vitest"
import { makeRendererRunner, startRendererRoot } from "@expand/desktop/renderer/app/runner"

const waitForDeferred = Deferred["\u0061wait"]

const exitCallback = <A, E>(deferred: Deferred.Deferred<Exit.Exit<A, E>>) =>
  (exit: Exit.Exit<A, E>): void => {
    Deferred.doneUnsafe(deferred, Effect.succeed(exit))
  }

describe("renderer runner", () => {
  it.effect("exposes only the synchronous callback start operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* makeRendererRunner()
        expect(Object.keys(owner.runner)).toEqual(["start"])
        const cancel = owner.runner.start(Effect.never, () => {})
        expect(typeof cancel).toBe("function")
        expect(cancel()).toBeUndefined()
      })
    ))

  it.effect("delivers a successful inner Exit exactly once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* makeRendererRunner()
        const delivered = yield* Deferred.make<Exit.Exit<string>>()
        let calls = 0
        owner.runner.start(Effect.succeed("ready"), (exit) => {
          calls += 1
          exitCallback(delivered)(exit)
        })
        const exit = yield* waitForDeferred(delivered)
        expect(exit).toEqual(Exit.succeed("ready"))
        expect(calls).toBe(1)
      })
    ))

  it.effect("delivers a typed failure without failing the owner or interrupting a sibling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* makeRendererRunner()
        const siblingStarted = yield* Deferred.make<void>()
        const siblingInterrupted = yield* Deferred.make<void>()
        const siblingExit = yield* Deferred.make<Exit.Exit<never>>()
        const failed = yield* Deferred.make<Exit.Exit<never, "expected">>()
        const cancelSibling = owner.runner.start(
          Deferred.succeed(siblingStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(siblingInterrupted, undefined))
          ),
          exitCallback(siblingExit)
        )
        const ownerFailure = yield* Effect.forkChild(owner.failure)
        owner.runner.start(Effect.fail<"expected">("expected"), exitCallback(failed))
        yield* waitForDeferred(siblingStarted)
        expect(yield* waitForDeferred(failed)).toEqual(Exit.fail("expected"))
        expect(Option.isNone(yield* Deferred.poll(siblingInterrupted))).toBe(true)
        expect(ownerFailure.pollUnsafe()).toBeUndefined()
        cancelSibling()
        yield* waitForDeferred(siblingExit)
        yield* Fiber.interrupt(ownerFailure)
      })
    ))

  it.effect("delivers an ordinary defect without failing the owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const defect = new Error("task defect")
        const owner = yield* makeRendererRunner()
        const delivered = yield* Deferred.make<Exit.Exit<never>>()
        const ownerFailure = yield* Effect.forkChild(owner.failure)
        owner.runner.start(Effect.die(defect), exitCallback(delivered))
        const exit = yield* waitForDeferred(delivered)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect)
        expect(ownerFailure.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(ownerFailure)
      })
    ))

  it.effect("cancels idempotently and finalizes before delivering interruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* makeRendererRunner()
        const started = yield* Deferred.make<void>()
        const delivered = yield* Deferred.make<Exit.Exit<never>>()
        const order: Array<string> = []
        let calls = 0
        const cancel = owner.runner.start(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => order.push("finalize")))
          ),
          (exit) => {
            calls += 1
            order.push("callback")
            exitCallback(delivered)(exit)
          }
        )
        yield* waitForDeferred(started)
        cancel()
        cancel()
        const exit = yield* waitForDeferred(delivered)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(order).toEqual(["finalize", "callback"])
        expect(calls).toBe(1)
      })
    ))

  it.effect("scope close interrupts and awaits every active child", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const owner = yield* makeRendererRunner().pipe(Scope.provide(scope))
      const firstStarted = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const firstClosed = yield* Deferred.make<void>()
      const secondClosed = yield* Deferred.make<void>()
      const firstExit = yield* Deferred.make<Exit.Exit<never>>()
      const secondExit = yield* Deferred.make<Exit.Exit<never>>()
      owner.runner.start(
        Deferred.succeed(firstStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(firstClosed, undefined))
        ),
        exitCallback(firstExit)
      )
      owner.runner.start(
        Deferred.succeed(secondStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(secondClosed, undefined))
        ),
        exitCallback(secondExit)
      )
      yield* Effect.all([waitForDeferred(firstStarted), waitForDeferred(secondStarted)])
      yield* Scope.close(scope, Exit.void)
      yield* Effect.all([
        waitForDeferred(firstClosed),
        waitForDeferred(secondClosed),
        waitForDeferred(firstExit),
        waitForDeferred(secondExit)
      ])
    }))

  it.effect("reports interruption cleanup defects to the callback and owner failure wait", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cleanupDefect = new Error("cleanup defect")
        const owner = yield* makeRendererRunner()
        const started = yield* Deferred.make<void>()
        const delivered = yield* Deferred.make<Exit.Exit<never>>()
        const ownerFailure = yield* Effect.forkChild(Effect.exit(owner.failure))
        const cancel = owner.runner.start(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.die(cleanupDefect))
          ),
          exitCallback(delivered)
        )
        yield* waitForDeferred(started)
        cancel()
        const callbackExit = yield* waitForDeferred(delivered)
        const ownerExit = yield* Fiber.join(ownerFailure)
        expect(Exit.isFailure(callbackExit)).toBe(true)
        if (Exit.isFailure(callbackExit)) expect(Cause.squash(callbackExit.cause)).toBe(cleanupDefect)
        expect(Exit.isFailure(ownerExit)).toBe(true)
        if (Exit.isFailure(ownerExit)) expect(Cause.squash(ownerExit.cause)).toBe(cleanupDefect)
      })
    ))

  it.effect("turns callback throws into owner failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const callbackDefect = new Error("callback defect")
        const owner = yield* makeRendererRunner()
        const ownerFailure = yield* Effect.forkChild(Effect.exit(owner.failure))
        owner.runner.start(Effect.void, () => {
          throw callbackDefect
        })
        const exit = yield* Fiber.join(ownerFailure)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(callbackDefect)
      })
    ))

  it.effect("does not execute work started through a retained closed owner", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const owner = yield* makeRendererRunner().pipe(Scope.provide(scope))
      let executions = 0
      let callbacks = 0
      yield* Scope.close(scope, Exit.void)
      const cancel = owner.runner.start(
        Effect.sync(() => {
          executions += 1
        }),
        () => {
          callbacks += 1
        }
      )
      cancel()
      yield* Effect.yieldNow
      expect(executions).toBe(0)
      expect(callbacks).toBe(0)
    }))

  it.effect("rethrows a synchronous root exit observer defect", () =>
    Effect.sync(() => {
      const renderError = new Error("failure render failed")
      expect(() => startRendererRoot(Effect.void, () => {
        throw renderError
      })).toThrow(renderError)
    }))
})
