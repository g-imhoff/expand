import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import type { ProjectSnapshot, ProjectSyncSink } from "@expand/contracts/project-sync"
import {
  boot,
  type RendererBootDependencies,
  type RendererBootResources
} from "@expand/desktop/renderer/app/runtime"
import type { RendererRunner } from "@expand/desktop/renderer/app/runner"
import type { ProjectContextValue } from "@expand/desktop/renderer/features/projects/data/project-context"
import { makeProjectSyncSink, makeProjectsStore } from "@expand/desktop/renderer/features/projects/data/project-store"
import type { ProjectRpcApi } from "@expand/desktop/renderer/rpc/project-rpc"
import type { MakeIpcClientOptions } from "@expand/electron-ipc/renderer"

const waitForDeferred = Deferred["\u0061wait"]
const emptySnapshot: ProjectSnapshot = { projects: [], seq: 0 }

const unavailable = Effect.fn("RendererBootTest.unavailable")(() => Effect.never)

const rpc: ProjectRpcApi = {
  create: unavailable,
  rename: unavailable,
  changeDirectory: unavailable,
  archive: unavailable,
  restore: unavailable,
  setMetadata: unavailable,
  delete: unavailable,
  list: unavailable,
  status: Stream.never,
  events: () => Stream.never
}

const ipcOptions = (): MakeIpcClientOptions => {
  const win = {
    addEventListener: () => {},
    removeEventListener: () => {}
  }
  return { bridge: () => ({ rpcPort: () => {} }), win }
}

interface BootHarnessOptions {
  readonly synchronize: (sink: ProjectSyncSink) => Effect.Effect<never>
  readonly sink?: ProjectSyncSink
  readonly onMount?: (runner: RendererRunner, events: Array<string>) => void
}

const makeBootHarness = Effect.fn("RendererBootTest.makeHarness")(function* (
  options: BootHarnessOptions
) {
  const events: Array<string> = []
  const acquired = yield* Deferred.make<void>()
  const transportReleased = yield* Deferred.make<void>()
  const mounted = yield* Deferred.make<void>()
  const store = makeProjectsStore()
  const resources: RendererBootResources = {
    value: { store, rpc },
    sink: options.sink ?? makeProjectSyncSink(store)
  }
  const acquireResources = Effect.fn("RendererBootTest.acquireResources")(() =>
    Effect.acquireRelease(
      Deferred.succeed(acquired, undefined).pipe(Effect.as(resources)),
      () =>
        Effect.sync(() => events.push("transport:release")).pipe(
          Effect.andThen(Deferred.succeed(transportReleased, undefined)),
          Effect.asVoid
        )
    ))
  const synchronize = Effect.fn("RendererBootTest.synchronize")((_value: ProjectContextValue, sink: ProjectSyncSink) =>
    options.synchronize(sink).pipe(
      Effect.ensuring(Effect.sync(() => events.push("sync:release")))
    ))
  const dependencies: RendererBootDependencies = { acquireResources, synchronize }
  let mountCount = 0
  const mount = (value: ProjectContextValue, activeRunner: RendererRunner): void => {
    mountCount += 1
    events.push("mount")
    expect(Object.keys(value)).toEqual(["store", "rpc"])
    expect(Object.keys(activeRunner)).toEqual(["start"])
    Deferred.doneUnsafe(mounted, Effect.void)
    options.onMount?.(activeRunner, events)
  }
  return {
    acquired,
    dependencies,
    events,
    mount,
    mounted,
    mountCount: () => mountCount,
    store,
    transportReleased
  }
})

describe("renderer project synchronization supervision", () => {
  it.effect("mounts only after the first sink snapshot succeeds", () =>
    Effect.gen(function* () {
      const sinkStarted = yield* Deferred.make<void>()
      const releaseSink = yield* Deferred.make<void>()
      const store = makeProjectsStore()
      const sink: ProjectSyncSink = {
        snapshot: Effect.fn("RendererBootTest.delayedSnapshot")((snapshot) =>
          Deferred.succeed(sinkStarted, undefined).pipe(
            Effect.andThen(waitForDeferred(releaseSink)),
            Effect.andThen(makeProjectSyncSink(store).snapshot(snapshot))
          )),
        status: makeProjectSyncSink(store).status
      }
      const synchronize = Effect.fn("RendererBootTest.firstSnapshot")((target: ProjectSyncSink) =>
        target.snapshot(emptySnapshot).pipe(Effect.andThen(Effect.never)))
      const harness = yield* makeBootHarness({ synchronize, sink })
      const fiber = yield* Effect.forkChild(boot(ipcOptions(), harness.mount, harness.dependencies))
      yield* waitForDeferred(sinkStarted)
      expect(Option.isNone(yield* Deferred.poll(harness.mounted))).toBe(true)
      yield* Deferred.succeed(releaseSink, undefined)
      yield* waitForDeferred(harness.mounted)
      expect(harness.mountCount()).toBe(1)
      yield* Fiber.interrupt(fiber)
      yield* waitForDeferred(harness.transportReleased)
    }))

  it.effect("mounts once across repeated snapshots", () =>
    Effect.gen(function* () {
      const synchronize = Effect.fn("RendererBootTest.repeatedSnapshots")((sink: ProjectSyncSink) =>
        sink.snapshot(emptySnapshot).pipe(
          Effect.andThen(sink.snapshot({ projects: [], seq: 1 })),
          Effect.andThen(Effect.never)
        ))
      const harness = yield* makeBootHarness({ synchronize })
      const fiber = yield* Effect.forkChild(boot(ipcOptions(), harness.mount, harness.dependencies))
      yield* waitForDeferred(harness.mounted)
      yield* Effect.yieldNow
      expect(harness.mountCount()).toBe(1)
      yield* Fiber.interrupt(fiber)
    }))

  it.effect("fails before mounting when synchronization fails before a snapshot", () =>
    Effect.gen(function* () {
      const syncFailure = new Error("sync failed before snapshot")
      const synchronize = Effect.fn("RendererBootTest.earlyFailure")((_sink: ProjectSyncSink) =>
        Effect.die(syncFailure))
      const harness = yield* makeBootHarness({ synchronize })
      const exit = yield* Effect.exit(boot(ipcOptions(), harness.mount, harness.dependencies))
      expect(harness.mountCount()).toBe(0)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(syncFailure)
      yield* waitForDeferred(harness.transportReleased)
    }))

  it.effect("propagates synchronization failure after mounting", () =>
    Effect.gen(function* () {
      const failSync = yield* Deferred.make<void>()
      const syncFailure = new Error("sync failed after mount")
      const synchronize = Effect.fn("RendererBootTest.lateFailure")((sink: ProjectSyncSink) =>
        sink.snapshot(emptySnapshot).pipe(
          Effect.andThen(waitForDeferred(failSync)),
          Effect.andThen(Effect.die(syncFailure))
        ))
      const harness = yield* makeBootHarness({ synchronize })
      const fiber = yield* Effect.forkChild(boot(ipcOptions(), harness.mount, harness.dependencies))
      yield* waitForDeferred(harness.mounted)
      yield* Deferred.succeed(failSync, undefined)
      const exit = yield* Effect.exit(Fiber.join(fiber))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(syncFailure)
      expect(harness.mountCount()).toBe(1)
    }))

  it.effect("times out initialization at ten seconds and closes owned work", () =>
    Effect.gen(function* () {
      const syncStarted = yield* Deferred.make<void>()
      const synchronize = Effect.fn("RendererBootTest.timeout")((_sink: ProjectSyncSink) =>
        Deferred.succeed(syncStarted, undefined).pipe(Effect.andThen(Effect.never)))
      const harness = yield* makeBootHarness({ synchronize })
      const fiber = yield* Effect.forkChild(boot(ipcOptions(), harness.mount, harness.dependencies))
      yield* waitForDeferred(syncStarted)
      yield* TestClock.adjust("10 seconds")
      const exit = yield* Effect.exit(Fiber.join(fiber))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("TimeoutError")
      expect(harness.mountCount()).toBe(0)
      yield* waitForDeferred(harness.transportReleased)
    }))

  it.effect("times out resource acquisition before synchronization starts", () =>
    Effect.gen(function* () {
      const acquireStarted = yield* Deferred.make<void>()
      const acquireResources = Effect.fn("RendererBootTest.pendingResources")(() =>
        Deferred.succeed(acquireStarted, undefined).pipe(Effect.andThen(Effect.never)))
      const synchronize = Effect.fn("RendererBootTest.unreachedSync")((_value: ProjectContextValue, _sink: ProjectSyncSink) =>
        Effect.never)
      const dependencies: RendererBootDependencies = { acquireResources, synchronize }
      let mountCount = 0
      const fiber = yield* Effect.forkChild(boot(
        ipcOptions(),
        () => {
          mountCount += 1
        },
        dependencies
      ))
      yield* waitForDeferred(acquireStarted)
      yield* TestClock.adjust("10 seconds")
      yield* Effect.yieldNow
      const exit = fiber.pollUnsafe()
      expect(exit).toBeDefined()
      if (exit !== undefined) {
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("TimeoutError")
      }
      expect(mountCount).toBe(0)
      yield* Fiber.interrupt(fiber)
    }))

  it.effect("interrupts before initialization without mounting and ignores retained coordination", () =>
    Effect.gen(function* () {
      const syncStarted = yield* Deferred.make<void>()
      let retainedSink: ProjectSyncSink | undefined
      const synchronize = Effect.fn("RendererBootTest.interrupted")((sink: ProjectSyncSink) =>
        Effect.sync(() => {
          retainedSink = sink
        }).pipe(
          Effect.andThen(Deferred.succeed(syncStarted, undefined)),
          Effect.andThen(Effect.never),
          Effect.ensuring(sink.snapshot({ projects: [], seq: 77 }))
        ))
      const harness = yield* makeBootHarness({ synchronize })
      const fiber = yield* Effect.forkChild(boot(ipcOptions(), harness.mount, harness.dependencies))
      yield* waitForDeferred(syncStarted)
      yield* Fiber.interrupt(fiber)
      expect(harness.mountCount()).toBe(0)
      yield* waitForDeferred(harness.transportReleased)
      expect(harness.store.getState().seq).toBe(0)
      if (retainedSink === undefined) throw new Error("synchronization did not retain its sink")
      yield* retainedSink.snapshot({ projects: [], seq: 99 })
      yield* Effect.yieldNow
      expect(harness.mountCount()).toBe(0)
      expect(harness.store.getState().seq).toBe(0)
    }))

  it.effect("closes runner work before synchronization and transport when mount throws", () =>
    Effect.gen(function* () {
      const mountFailure = new Error("mount failed")
      const synchronize = Effect.fn("RendererBootTest.mountFailure")((sink: ProjectSyncSink) =>
        sink.snapshot(emptySnapshot).pipe(Effect.andThen(Effect.never)))
      const harness = yield* makeBootHarness({
        synchronize,
        onMount: (activeRunner, events) => {
          activeRunner.start(
            Effect.never.pipe(
              Effect.ensuring(Effect.sync(() => events.push("runner:release")))
            ),
            () => {}
          )
          throw mountFailure
        }
      })
      const exit = yield* Effect.exit(boot(ipcOptions(), harness.mount, harness.dependencies))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(mountFailure)
      expect(harness.events.slice(-3)).toEqual([
        "runner:release",
        "sync:release",
        "transport:release"
      ])
    }))
})
