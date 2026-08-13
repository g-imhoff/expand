import { useEffect } from "react"
import { describe, expect, vi } from "vitest"
import { it as effectIt } from "@effect/vitest"
import { render as renderInk, Text } from "ink"
import { render as renderTesting } from "ink-testing-library"
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Queue, Scope, Stream } from "effect"
import { BackendUnavailable } from "@expand/client-ts"
import { ProjectRenamed } from "@expand/contracts/events/project"
import { runProjectSync } from "@expand/contracts/project-sync"
import { App } from "@expand/tui/components/app"
import { makeEffectRunner } from "@expand/tui/runtime/effect-runner"
import { TuiHostError, tuiProgram, type ExpandRuntime } from "@expand/tui/runtime/tui-runtime"
import { useProjects } from "@expand/tui/features/projects/use-projects"
import {
  fakeProject,
  makeRuntimeHarnessScoped,
  renderWithRuntimeScoped,
  type RuntimeHarness
} from "./runtime-harness"

const alpha = fakeProject(1, "alpha")
const beta = fakeProject(2, "beta")
const boundedWait = <A, E, R,>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout("2 seconds"))
const waitForDeferred = <A,>(deferred: Deferred.Deferred<A>) =>
  boundedWait(Deferred.await(deferred))

const renderHookWithRuntime = Effect.fn("TuiTest.renderHookWithRuntime")(function* (harness: RuntimeHarness) {
  let observed: ReturnType<typeof useProjects> | undefined
  const updates = yield* Queue.unbounded<ReturnType<typeof useProjects>>()
  const Probe = () => {
    const value = useProjects()
    observed = value
    useEffect(() => {
      Queue.offerUnsafe(updates, value)
    }, [value.snapshot, value.error])
    return null
  }
  const rendered = yield* renderWithRuntimeScoped(<Probe />, harness)
  const result = () => {
    if (!observed) throw new Error("hook was not observed")
    return observed
  }
  const takeResult = (
    predicate: (value: ReturnType<typeof useProjects>) => boolean
  ): Effect.Effect<ReturnType<typeof useProjects>> => Effect.suspend(() => {
    const current = result()
    return predicate(current)
      ? Effect.succeed(current)
      : Queue.take(updates).pipe(
          Effect.flatMap((value) => predicate(value) ? Effect.succeed(value) : takeResult(predicate))
        )
  })
  const awaitResult = (predicate: (value: ReturnType<typeof useProjects>) => boolean) =>
    boundedWait(takeResult(predicate))
  return {
    ...rendered,
    result,
    projects: () => result().projects.map((project) => project.name),
    snapshot: () => result().snapshot,
    awaitResult,
    waitForProjects: (names: ReadonlyArray<string>) =>
      awaitResult((value) => value.projects.map((project) => project.name).join("\0") === names.join("\0"))
  }
})

describe("useProjects", () => {
  effectIt.effect("releases the Ink root and runtime after an assertion effect fails", () =>
    Effect.gen(function* () {
      let retainedWrite: ((value: string) => void) | undefined
      let retainedPublish: RuntimeHarness["events"]["publish"] | undefined
      let frame: (() => string | undefined) | undefined
      let inputListeners: (() => number) | undefined
      let harness: RuntimeHarness | undefined
      const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
        harness = yield* makeRuntimeHarnessScoped({ snapshot: { projects: [alpha], seq: 1 } })
        retainedPublish = harness.events.publish
        const rendered = yield* renderWithRuntimeScoped(<App />, harness)
        frame = rendered.lastFrame
        retainedWrite = rendered.stdin.write
        inputListeners = rendered.inputListeners
        yield* rendered.mounted
        yield* rendered.awaitFrame("▸ alpha")
        yield* harness.observed.synchronizationStarted
        expect(rendered.inputListeners()).toBeGreaterThan(0)
        return yield* Effect.fail("expected assertion failure")
      })))

      if (Exit.isFailure(exit) && !Cause.pretty(exit.cause).includes("expected assertion failure")) {
        throw new Error(Cause.pretty(exit.cause))
      }
      expect(harness?.lifecycle.inkUnmounts).toBe(1)
      expect(harness?.lifecycle.runtimeDisposals).toBe(1)
      expect(inputListeners?.()).toBe(0)
      yield* harness!.observed.synchronizationInterrupted
      const releasedFrame = frame?.()
      retainedWrite?.("x")
      if (retainedPublish !== undefined) {
        yield* retainedPublish(ProjectRenamed.make({
          projectId: alpha.id,
          name: "released",
          occurredAt: "t2"
        }))
      }
      yield* Effect.yieldNow
      expect(frame?.()).toBe(releasedFrame)
      expect(harness?.authoritative.get().projects[0]?.name).toBe("released")
    }))

  effectIt.effect("publishes the initial synchronized snapshot", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({ snapshot: { projects: [alpha], seq: 1 } })
      const view = yield* renderHookWithRuntime(harness)
      yield* view.waitForProjects(["alpha"])
      expect(view.snapshot()).toEqual({ projects: [alpha], seq: 1 })
    })))

  effectIt.effect("folds live events into React-owned state", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({ snapshot: { projects: [alpha], seq: 1 } })
      const view = yield* renderHookWithRuntime(harness)
      yield* view.waitForProjects(["alpha"])
      yield* harness.events.publish(ProjectRenamed.make({
        projectId: alpha.id,
        name: "alpha-live",
        occurredAt: "t2"
      }))
      yield* view.waitForProjects(["alpha-live"])
      expect(view.snapshot().seq).toBe(2)
    })))

  effectIt.effect("retains projects while reconnecting and replaces after resnapshot", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({ snapshot: { projects: [alpha], seq: 1 } })
      const view = yield* renderHookWithRuntime(harness)
      yield* view.waitForProjects(["alpha"])
      yield* harness.status.set("reconnecting")
      harness.authoritative.set({ projects: [beta], seq: 5 })
      expect(view.projects()).toEqual(["alpha"])
      yield* harness.status.set("connected")
      yield* view.waitForProjects(["beta"])
      expect(view.snapshot().seq).toBe(5)
    })))

  effectIt.effect("interrupts synchronization on unmount", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const harness = yield* makeRuntimeHarnessScoped({ snapshot: { projects: [alpha], seq: 1 } }).pipe(
        Scope.provide(scope)
      )
      const view = yield* renderHookWithRuntime(harness).pipe(Scope.provide(scope))
      yield* harness.observed.synchronizationStarted
      view.unmount()
      yield* harness.observed.synchronizationInterrupted
      yield* view.unmounted
      expect(harness.lifecycle.inkUnmounts).toBe(1)
      yield* Scope.close(scope, Exit.void)
      expect(harness.lifecycle.inkUnmounts).toBe(1)
      expect(harness.lifecycle.runtimeDisposals).toBe(1)
    }))

  effectIt.effect("surfaces an initial runtime build failure", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        failure: new BackendUnavailable({ reason: "offline" })
      })
      const view = yield* renderHookWithRuntime(harness)
      yield* view.awaitResult((value) => value.error === "backend unavailable: offline")
    })))

  effectIt.effect("calls ProjectClient with ensure create semantics without using the response as state", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [alpha], seq: 1 },
        client: {
          create: () => Effect.succeed({ created: true, project: beta })
        }
      })
      const view = yield* renderHookWithRuntime(harness)
      yield* view.waitForProjects(["alpha"])
      view.result().create("beta")
      expect(yield* harness.observed.call("create")).toEqual({ name: "beta", ensure: true })
      expect(view.projects()).toEqual(["alpha"])
    })))
})

effectIt.effect("owns overlapping mutations until React unmount interrupts each one", () =>
  Effect.scoped(Effect.gen(function* () {
    const interruptions = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
    let started = 0
    const harness = yield* makeRuntimeHarnessScoped({
      client: {
        create: () => {
          const index = started++
          return Effect.never.pipe(
            Effect.onInterrupt(() => Deferred.succeed(interruptions[index]!, undefined))
          )
        }
      }
    })
    const view = yield* renderHookWithRuntime(harness)
    view.result().create("alpha")
    view.result().create("beta")
    yield* Effect.all([harness.observed.call("create"), harness.observed.call("create")])
    view.unmount()
    yield* Effect.all(interruptions.map(waitForDeferred))
  })))

describe("TUI Effect runner", () => {
  effectIt.effect("logs a cancelled target defect without delivering it to React", () =>
    Effect.scoped(Effect.gen(function* () {
      const finalized = yield* Deferred.make<void>()
      const logged = yield* Deferred.make<void>()
      const entries: Array<string> = []
      const logger = Logger.make((options) => {
        const messages = Array.isArray(options.message) ? options.message : [options.message]
        const entry = messages.map(String).join(" ")
        entries.push(entry)
        if (entry.includes("cancelled effect died")) Deferred.doneUnsafe(logged, Effect.void)
      })
      const harness = yield* makeRuntimeHarnessScoped({
        transformEffect: (effect) => effect.pipe(Effect.provide(Logger.layer([logger])))
      })
      const onExit = vi.fn()
      const runner = makeEffectRunner(harness.runtime)

      runner.start(
        Effect.never.pipe(
          Effect.ensuring(
            Deferred.succeed(finalized, undefined).pipe(
              Effect.andThen(Effect.die("finalizer defect"))
            )
          )
        ),
        onExit
      )
      runner.dispose()

      yield* waitForDeferred(finalized)
      yield* waitForDeferred(logged)
      expect(entries.some((entry) => entry.includes("cancelled effect died"))).toBe(true)
      expect(onExit).not.toHaveBeenCalled()
    })))

  effectIt.effect("observes ProjectSync failure and suppresses failure delivery after disposal", () =>
    Effect.scoped(Effect.gen(function* () {
      const failure = new Error("sync failed")
      const release = yield* Deferred.make<void>()
      const delivered = yield* Deferred.make<Exit.Exit<never, Error>>()
      const harness = yield* makeRuntimeHarnessScoped()
      const onExit = vi.fn((exit: Exit.Exit<never, Error>) => {
        Deferred.doneUnsafe(delivered, Effect.succeed(exit))
      })
      const runner = makeEffectRunner(harness.runtime)
      const sink = { snapshot: () => Effect.void, status: () => Effect.void }

      runner.start(
        runProjectSync(
          { status: Stream.fail(failure), list: () => Effect.die("unused"), events: () => Stream.die("unused") },
          sink
        ),
        onExit
      )
      const exit = yield* waitForDeferred(delivered)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure)

      onExit.mockClear()
      runner.start(
        runProjectSync(
          {
            status: Stream.fromEffect(
              waitForDeferred(release).pipe(Effect.andThen(Effect.fail(failure)))
            ),
            list: () => Effect.die("unused"),
            events: () => Stream.die("unused")
          },
          sink
        ),
        onExit
      )
      runner.dispose()
      yield* Deferred.succeed(release, undefined)
      yield* Effect.yieldNow
      expect(onExit).not.toHaveBeenCalled()
    })))

  effectIt.effect("interrupts through the runtime and suppresses late callbacks after disposal", () =>
    Effect.scoped(Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>()
      const observed: Array<boolean> = []
      const harness = yield* makeRuntimeHarnessScoped({
        transformFiber: (fiber) => {
          const index = observed.push(false) - 1
          return new Proxy(fiber, {
            get: (fiberTarget, fiberProperty) => {
              if (fiberProperty !== "addObserver") return Reflect.get(fiberTarget, fiberProperty)
              return (observer: Parameters<typeof fiber.addObserver>[0]) => {
                observed[index] = true
                return fiber.addObserver(observer)
              }
            }
          })
        }
      })
      const onExit = vi.fn()
      const runner = makeEffectRunner(harness.runtime)

      runner.start(
        Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        onExit
      )
      runner.dispose()

      yield* waitForDeferred(interrupted)
      yield* Effect.yieldNow
      expect(observed).toEqual([true, true])
      expect(onExit).not.toHaveBeenCalled()
    })))
})

describe("tuiProgram", () => {
  effectIt.effect("waits for Ink exit and tears down Ink and the runtime exactly once", () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      let rawUnmount: (() => void) | undefined
      let unmount: (() => void) | undefined
      const runtime = {
        disposeEffect: Effect.sync(() => { events.push("runtime:dispose") })
      } as unknown as ExpandRuntime
      const program = yield* Effect.forkChild(tuiProgram({
        makeRuntime: () => runtime,
        render: () => {
          events.push("ink:render")
          const io = renderTesting(<></>)
          io.unmount()
          const instance = renderInk(<Text>ready</Text>, {
            stdin: io.stdin as unknown as NodeJS.ReadStream,
            stdout: io.stdout as unknown as NodeJS.WriteStream,
            stderr: io.stderr as unknown as NodeJS.WriteStream,
            exitOnCtrlC: false,
            patchConsole: false
          })
          rawUnmount = vi.fn(instance.unmount)
          let released = false
          unmount = () => {
            if (released) return
            released = true
            rawUnmount?.()
          }
          return { waitUntilExit: instance.waitUntilExit, unmount }
        }
      }))

      yield* Effect.yieldNow
      expect(events).toEqual(["ink:render"])
      expect(rawUnmount).not.toHaveBeenCalled()

      unmount?.()
      yield* Fiber.join(program)

      expect(events).toEqual(["ink:render", "runtime:dispose"])
      expect(rawUnmount).toHaveBeenCalledTimes(1)
    }))

  effectIt.effect("disposes the runtime when Ink rendering fails", () =>
    Effect.gen(function* () {
      let disposals = 0
      const failure = new Error("render failed")
      const runtime = {
        disposeEffect: Effect.sync(() => { disposals += 1 })
      } as unknown as ExpandRuntime

      const exit = yield* Effect.exit(tuiProgram({
        makeRuntime: () => runtime,
        render: () => { throw failure }
      }))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(TuiHostError)
        expect(Cause.squash(exit.cause)).toMatchObject({ operation: "render", cause: failure })
      }
      expect(disposals).toBe(1)
    }))
})
