import { describe, expect, vi } from "vitest"
import { it as effectIt } from "@effect/vitest"
import { render as renderInk } from "ink-testing-library"
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Stream } from "effect"
import { BackendUnavailable } from "@expand/client-ts"
import { ProjectRenamed } from "@expand/contracts/events/project"
import { runProjectSync } from "@expand/contracts/project-sync"
import { makeEffectRunner } from "@expand/tui/effect-runner"
import { tuiProgram, type ExpandRuntime } from "@expand/tui/runtime"
import { useProjects } from "@expand/tui/use-projects"
import {
  fakeProject,
  makeRuntimeHarnessScoped,
  renderWithRuntimeScoped,
  type RuntimeHarness
} from "./_runtime-harness"

const alpha = fakeProject(1, "alpha")
const beta = fakeProject(2, "beta")
const waitForDeferred = Deferred["\u0061wait"]

const renderHookWithRuntime = (harness: RuntimeHarness) => {
  let observed: ReturnType<typeof useProjects> | undefined
  const Probe = () => {
    observed = useProjects()
    return null
  }
  return renderWithRuntimeScoped(<Probe />, harness).pipe(Effect.map((rendered) => {
  const result = () => {
    if (!observed) throw new Error("hook was not observed")
    return observed
  }
  return {
    ...rendered,
    result,
    projects: () => result().projects.map((project) => project.name),
    snapshot: () => result().snapshot,
    waitForProjects: (names: ReadonlyArray<string>) =>
      vi.waitFor(() => expect(result().projects.map((project) => project.name)).toEqual(names))
  }
  }))
}

describe("useProjects", () => {
  effectIt.effect("releases the Ink root and runtime after an assertion effect fails", () =>
    Effect.gen(function* () {
      let retainedWrite: ((value: string) => void) | undefined
      let frame: (() => string | undefined) | undefined
      let harness: RuntimeHarness | undefined
      const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
        harness = yield* makeRuntimeHarnessScoped()
        const rendered = yield* renderWithRuntimeScoped(<>0</>, harness)
        frame = rendered.lastFrame
        retainedWrite = rendered.stdin.write
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(frame?.()).toContain("0")))
        return yield* Effect.fail("expected assertion failure")
      })))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(harness?.lifecycle.inkUnmounts).toBe(1)
      expect(harness?.lifecycle.runtimeDisposals).toBe(1)
      const releasedFrame = frame?.()
      retainedWrite?.("x")
      yield* Effect.yieldNow
      expect(frame?.()).toBe(releasedFrame)
    }))

  effectIt.effect("publishes the initial synchronized snapshot", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({ snapshot: { projects: [alpha], seq: 1 } })
      const view = yield* renderHookWithRuntime(harness)
      yield* Effect.tryPromise(() => view.waitForProjects(["alpha"]))
      expect(view.snapshot()).toEqual({ projects: [alpha], seq: 1 })
    })))

  effectIt.effect("folds live events into React-owned state", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({ snapshot: { projects: [alpha], seq: 1 } })
      const view = yield* renderHookWithRuntime(harness)
      yield* Effect.tryPromise(() => view.waitForProjects(["alpha"]))
      yield* harness.events.publish(ProjectRenamed.make({
        projectId: alpha.id,
        name: "alpha-live",
        occurredAt: "t2"
      }))
      yield* Effect.tryPromise(() => view.waitForProjects(["alpha-live"]))
      expect(view.snapshot().seq).toBe(2)
    })))

  effectIt.effect("retains projects while reconnecting and replaces after resnapshot", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({ snapshot: { projects: [alpha], seq: 1 } })
      const view = yield* renderHookWithRuntime(harness)
      yield* Effect.tryPromise(() => view.waitForProjects(["alpha"]))
      yield* harness.status.set("reconnecting")
      harness.authoritative.set({ projects: [beta], seq: 5 })
      expect(view.projects()).toEqual(["alpha"])
      yield* harness.status.set("connected")
      yield* Effect.tryPromise(() => view.waitForProjects(["beta"]))
      expect(view.snapshot().seq).toBe(5)
    })))

  effectIt.effect("interrupts synchronization on unmount", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({ snapshot: { projects: [alpha], seq: 1 } })
      const view = yield* renderHookWithRuntime(harness)
      view.unmount()
      expect(yield* harness.syncInterrupted).toBe(true)
    })))

  effectIt.effect("surfaces an initial runtime build failure", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        failure: new BackendUnavailable({ reason: "offline" })
      })
      const view = yield* renderHookWithRuntime(harness)
      yield* Effect.tryPromise(() =>
        vi.waitFor(() => expect(view.result().error).toBe("backend unavailable: offline"))
      )
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
      yield* Effect.tryPromise(() => view.waitForProjects(["alpha"]))
      view.result().create("beta")
      yield* Effect.tryPromise(() =>
        vi.waitFor(() => expect(harness.calls.create).toEqual([{ name: "beta", ensure: true }]))
      )
      expect(view.projects()).toEqual(["alpha"])
    })))
})

effectIt.effect("owns overlapping mutations until React unmount interrupts each one", () =>
  Effect.scoped(Effect.gen(function* () {
    const interrupted = [false, false]
    let started = 0
    const harness = yield* makeRuntimeHarnessScoped({
      client: {
        create: () => {
          const index = started++
          return Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => { interrupted[index] = true }))
          )
        }
      }
    })
    const view = yield* renderHookWithRuntime(harness)
    view.result().create("alpha")
    view.result().create("beta")
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(harness.calls.create).toHaveLength(2)))
    view.unmount()
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(interrupted).toEqual([true, true])))
  })))

describe("TUI Effect runner", () => {
  effectIt.effect("logs a cancelled target defect without delivering it to React", () =>
    Effect.scoped(Effect.gen(function* () {
      const finalized = yield* Deferred.make<void>()
      const entries: Array<string> = []
      const logger = Logger.make((options) => {
        const messages = Array.isArray(options.message) ? options.message : [options.message]
        entries.push(messages.map(String).join(" "))
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
      yield* Effect.tryPromise(() =>
        vi.waitFor(() => expect(entries.some((entry) => entry.includes("cancelled effect died"))).toBe(true))
      )
      expect(onExit).not.toHaveBeenCalled()
    })))

  effectIt.effect("observes ProjectSync failure and suppresses failure delivery after disposal", () =>
    Effect.scoped(Effect.gen(function* () {
      const failure = new Error("sync failed")
      const release = yield* Deferred.make<void>()
      const harness = yield* makeRuntimeHarnessScoped()
      const onExit = vi.fn()
      const runner = makeEffectRunner(harness.runtime)
      const sink = { snapshot: () => Effect.void, status: () => Effect.void }

      runner.start(
        runProjectSync(
          { status: Stream.fail(failure), list: () => Effect.die("unused"), events: () => Stream.die("unused") },
          sink
        ),
        onExit
      )
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1)))
      const exit = onExit.mock.calls[0]?.[0]
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
      const exitRelease = yield* Deferred.make<void>()
      const events: Array<string> = []
      let unmount: ReturnType<typeof vi.spyOn> | undefined
      const runtime = {
        disposeEffect: Effect.sync(() => { events.push("runtime:dispose") })
      } as unknown as ExpandRuntime
      const program = yield* Effect.forkChild(tuiProgram({
        makeRuntime: () => runtime,
        render: () => {
          events.push("ink:render")
          const ink = Object.assign(renderInk(<></>), {
            waitUntilExit: vi.fn().mockReturnValue(
              vi.waitFor(() => expect(exitRelease.effect).toBeDefined())
            )
          })
          unmount = vi.spyOn(ink, "unmount")
          return ink
        }
      }))

      yield* Effect.yieldNow
      expect(events).toEqual(["ink:render"])
      expect(unmount).not.toHaveBeenCalled()

      yield* Deferred.succeed(exitRelease, undefined)
      yield* Fiber.join(program)

      expect(events).toEqual(["ink:render", "runtime:dispose"])
      expect(unmount).toHaveBeenCalledTimes(1)
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
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure)
      expect(disposals).toBe(1)
    }))
})
