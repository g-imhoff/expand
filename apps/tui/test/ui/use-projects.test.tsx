import { describe, expect, vi } from "vitest"
import { it as effectIt } from "@effect/vitest"
import { render as renderInk } from "ink-testing-library"
import { Cause, Deferred, Effect, Exit } from "effect"
import { BackendUnavailable } from "@expand/client-ts"
import { ProjectRenamed } from "@expand/contracts/events/project"
import { makeEffectRunner } from "@expand/tui/effect-runner"
import { tuiProgram, type ExpandRuntime } from "@expand/tui/runtime"
import { useProjects } from "@expand/tui/use-projects"
import {
  fakeProject,
  makeRuntimeHarness,
  renderWithRuntime,
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
  const rendered = renderWithRuntime(<Probe />, harness)
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
}

describe("useProjects", () => {
  effectIt.effect("publishes the initial synchronized snapshot", () => {
    const harness = makeRuntimeHarness({ snapshot: { projects: [alpha], seq: 1 } })
    return Effect.gen(function* () {
      const view = renderHookWithRuntime(harness)
      yield* Effect.tryPromise(() => view.waitForProjects(["alpha"]))
      expect(view.snapshot()).toEqual({ projects: [alpha], seq: 1 })
    }).pipe(Effect.ensuring(Effect.tryPromise(() => harness.dispose())))
  })

  effectIt.effect("folds live events into React-owned state", () => {
    const harness = makeRuntimeHarness({ snapshot: { projects: [alpha], seq: 1 } })
    return Effect.gen(function* () {
      const view = renderHookWithRuntime(harness)
      yield* Effect.tryPromise(() => view.waitForProjects(["alpha"]))
      harness.events.publish(ProjectRenamed.make({
        projectId: alpha.id,
        name: "alpha-live",
        occurredAt: "t2"
      }))
      yield* Effect.tryPromise(() => view.waitForProjects(["alpha-live"]))
      expect(view.snapshot().seq).toBe(2)
    }).pipe(Effect.ensuring(Effect.tryPromise(() => harness.dispose())))
  })

  effectIt.effect("retains projects while reconnecting and replaces after resnapshot", () => {
    const harness = makeRuntimeHarness({ snapshot: { projects: [alpha], seq: 1 } })
    return Effect.gen(function* () {
      const view = renderHookWithRuntime(harness)
      yield* Effect.tryPromise(() => view.waitForProjects(["alpha"]))
      harness.status.set("reconnecting")
      harness.authoritative.set({ projects: [beta], seq: 5 })
      expect(view.projects()).toEqual(["alpha"])
      harness.status.set("connected")
      yield* Effect.tryPromise(() => view.waitForProjects(["beta"]))
      expect(view.snapshot().seq).toBe(5)
    }).pipe(Effect.ensuring(Effect.tryPromise(() => harness.dispose())))
  })

  effectIt.effect("interrupts synchronization on unmount", () => {
    const harness = makeRuntimeHarness({ snapshot: { projects: [alpha], seq: 1 } })
    return Effect.gen(function* () {
      const view = renderHookWithRuntime(harness)
      view.unmount()
      expect(yield* Effect.tryPromise(() => harness.syncInterrupted())).toBe(true)
    }).pipe(Effect.ensuring(Effect.tryPromise(() => harness.dispose())))
  })

  effectIt.effect("surfaces an initial runtime build failure", () => {
    const harness = makeRuntimeHarness({
      failure: new BackendUnavailable({ reason: "offline" })
    })
    return Effect.gen(function* () {
      const view = renderHookWithRuntime(harness)
      yield* Effect.tryPromise(() =>
        vi.waitFor(() => expect(view.result().error).toBe("backend unavailable: offline"))
      )
    }).pipe(Effect.ensuring(Effect.tryPromise(() => harness.dispose())))
  })

  effectIt.effect("calls ProjectClient with ensure create semantics without using the response as state", () => {
    const harness = makeRuntimeHarness({
      snapshot: { projects: [alpha], seq: 1 },
      client: {
        create: () => Effect.succeed({ created: true, project: beta })
      }
    })
    return Effect.gen(function* () {
      const view = renderHookWithRuntime(harness)
      yield* Effect.tryPromise(() => view.waitForProjects(["alpha"]))
      view.result().create("beta")
      yield* Effect.tryPromise(() =>
        vi.waitFor(() => expect(harness.calls.create).toEqual([{ name: "beta", ensure: true }]))
      )
      expect(view.projects()).toEqual(["alpha"])
    }).pipe(Effect.ensuring(Effect.tryPromise(() => harness.dispose())))
  })
})

effectIt.effect("owns overlapping mutations until React unmount interrupts each one", () =>
  Effect.gen(function* () {
    const interrupted = [false, false]
    let started = 0
    const harness = makeRuntimeHarness({
      client: {
        create: () => {
          const index = started++
          return Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => { interrupted[index] = true }))
          )
        }
      }
    })
    const view = renderHookWithRuntime(harness)
    view.result().create("alpha")
    view.result().create("beta")
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(harness.calls.create).toHaveLength(2)))
    view.unmount()
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(interrupted).toEqual([true, true])))
    yield* harness.runtime.disposeEffect
  }))

describe("TUI Effect runner", () => {
  effectIt.effect("interrupts through the runtime and suppresses late callbacks after disposal", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>()
      const harness = makeRuntimeHarness()
      const onExit = vi.fn()
      const runner = makeEffectRunner(harness.runtime)

      runner.start(
        Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        onExit
      )
      runner.dispose()

      yield* waitForDeferred(interrupted)
      expect(onExit).not.toHaveBeenCalled()
      yield* harness.runtime.disposeEffect
    }))
})

describe("tuiProgram", () => {
  effectIt.effect("waits for Ink exit and tears down Ink and the runtime exactly once", () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      let unmount: ReturnType<typeof vi.spyOn> | undefined
      const runtime = {
        disposeEffect: Effect.sync(() => { events.push("runtime:dispose") })
      } as unknown as ExpandRuntime
      yield* tuiProgram({
        makeRuntime: () => runtime,
        render: () => {
          events.push("ink:render")
          const ink = Object.assign(renderInk(<></>), {
            waitUntilExit: vi.fn().mockResolvedValue(undefined)
          })
          unmount = vi.spyOn(ink, "unmount")
          return ink
        }
      })

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
