import { createElement, Fragment, type ReactElement, useEffect } from "react"
import { render } from "ink-testing-library"
import { Deferred, Effect, Layer, ManagedRuntime, Queue, Schema, Stream, SubscriptionRef } from "effect"
import { BackendUnavailable, ClientSession, type ConnectionStatus } from "@expand/client-ts"
import { ProjectClient, type ProjectClientApi } from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import {
  ProjectArchived,
  ProjectCreated,
  ProjectDeleted,
  ProjectDirectoryChanged,
  ProjectMetadataChanged,
  ProjectRenamed,
  ProjectRestored
} from "@expand/contracts/events/project"
import { Project } from "@expand/contracts/project"
import type { ProjectSnapshot } from "@expand/contracts/project-sync"
import { ProjectInvalidInput } from "@expand/contracts/rpc"
import { RuntimeContext, type ExpandRuntime } from "@expand/tui/runtime"

export interface RuntimeHarnessOptions {
  readonly snapshot?: ProjectSnapshot
  readonly client?: Partial<ProjectClientApi>
  readonly failure?: BackendUnavailable
  readonly transformEffect?: (
    effect: Parameters<ExpandRuntime["runFork"]>[0]
  ) => Parameters<ExpandRuntime["runFork"]>[0]
  readonly transformFiber?: (
    fiber: ReturnType<ExpandRuntime["runFork"]>
  ) => ReturnType<ExpandRuntime["runFork"]>
}

export const fakeProject = (
  n: number,
  name: string,
  patch: Partial<Project> = {}
): Project =>
  Schema.decodeUnknownSync(Project)({
    id: uid(n),
    name,
    directory: null,
    description: null,
    tags: [],
    archived: false,
    createdAt: "t",
    updatedAt: "t",
    ...patch
  })

export const makeRuntimeHarness = Effect.fn("TuiTest.makeRuntimeHarness")(function* (
  options: RuntimeHarnessOptions = {}
) {
  let authoritative = options.snapshot ?? { projects: [], seq: 0 }
  let nextId = authoritative.projects.length + 1
  const statusRef = yield* SubscriptionRef.make<ConnectionStatus>("connected")
  const eventQueue = yield* Queue.unbounded<SequencedEvent>()
  const callQueue = yield* Queue.unbounded<{ readonly method: keyof ProjectClientApi; readonly payload: unknown }>()
  const snapshotQueue = yield* Queue.unbounded<ProjectSnapshot>()
  const synchronizationStarted = yield* Deferred.make<void>()
  const synchronizationInterrupted = yield* Deferred.make<void>()
  const calls = {
    create: [] as Array<Parameters<ProjectClientApi["create"]>[0]>,
    rename: [] as Array<Parameters<ProjectClientApi["rename"]>[0]>,
    changeDirectory: [] as Array<Parameters<ProjectClientApi["changeDirectory"]>[0]>,
    archive: [] as Array<Parameters<ProjectClientApi["archive"]>[0]>,
    restore: [] as Array<Parameters<ProjectClientApi["restore"]>[0]>,
    setMetadata: [] as Array<Parameters<ProjectClientApi["setMetadata"]>[0]>,
    delete: [] as Array<Parameters<ProjectClientApi["delete"]>[0]>,
    list: [] as Array<Parameters<ProjectClientApi["list"]>[0]>,
    events: [] as Array<Parameters<ProjectClientApi["events"]>[0]>
  }

  const publish = (event: SequencedEvent["event"]) =>
    Effect.suspend(() => {
      const sequenced = { seq: authoritative.seq + 1, event }
      authoritative = {
        projects: Project.foldList(authoritative.projects, event),
        seq: sequenced.seq
      }
      Queue.offerUnsafe(snapshotQueue, authoritative)
      return Queue.offer(eventQueue, sequenced)
    })

  const defaults: ProjectClientApi = {
    create: (payload) =>
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(payload.name)
        ? Effect.gen(function* () {
            const existing = authoritative.projects.find((project) => project.name === payload.name)
            if (existing && payload.ensure) return { created: false, project: existing }
            const id = uid(nextId++)
            yield* publish(ProjectCreated.make({
              projectId: id,
              name: payload.name,
              ...(payload.directory !== undefined ? { directory: payload.directory } : {}),
              occurredAt: `t${authoritative.seq + 1}`
            }))
            return {
              created: true,
              project: authoritative.projects.find((project) => project.id === id)!
            }
          })
        : Effect.fail(new ProjectInvalidInput({
            field: "name",
            reason: "must match ^[a-z0-9][a-z0-9-]{0,63}$"
          })),
    rename: (payload) =>
      publish(ProjectRenamed.make({
        projectId: payload.id,
        name: payload.name,
        occurredAt: `t${authoritative.seq + 1}`
      })).pipe(
        Effect.andThen(Effect.sync(() => authoritative.projects.find((project) => project.id === payload.id)!))
      ),
    changeDirectory: (payload) =>
      publish(ProjectDirectoryChanged.make({
        projectId: payload.id,
        directory: payload.directory,
        occurredAt: `t${authoritative.seq + 1}`
      })).pipe(
        Effect.andThen(Effect.sync(() => authoritative.projects.find((project) => project.id === payload.id)!))
      ),
    archive: (payload) =>
      publish(ProjectArchived.make({
        projectId: payload.id,
        occurredAt: `t${authoritative.seq + 1}`
      })).pipe(
        Effect.andThen(Effect.sync(() => authoritative.projects.find((project) => project.id === payload.id)!))
      ),
    restore: (payload) =>
      publish(ProjectRestored.make({
        projectId: payload.id,
        occurredAt: `t${authoritative.seq + 1}`
      })).pipe(
        Effect.andThen(Effect.sync(() => authoritative.projects.find((project) => project.id === payload.id)!))
      ),
    setMetadata: (payload) =>
      publish(ProjectMetadataChanged.make({
        projectId: payload.id,
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
        occurredAt: `t${authoritative.seq + 1}`
      })).pipe(
        Effect.andThen(Effect.sync(() => authoritative.projects.find((project) => project.id === payload.id)!))
      ),
    delete: (payload) =>
      publish(ProjectDeleted.make({
        projectId: payload.id,
        occurredAt: `t${authoritative.seq + 1}`
      })).pipe(Effect.as({ id: payload.id, deleted: true })),
    list: () => Effect.sync(() => authoritative),
    events: () => Stream.fromQueue(eventQueue).pipe(
      Stream.ensuring(Deferred.succeed(synchronizationInterrupted, undefined))
    )
  }

  const observedCall = <K extends keyof typeof calls>(method: K, payload: Parameters<ProjectClientApi[K]>[0]) => {
    calls[method].push(payload as never)
    Queue.offerUnsafe(callQueue, { method, payload })
  }
  const client: ProjectClientApi = {
    create: (payload) => {
      observedCall("create", payload)
      return (options.client?.create ?? defaults.create)(payload)
    },
    rename: (payload) => {
      observedCall("rename", payload)
      return (options.client?.rename ?? defaults.rename)(payload)
    },
    changeDirectory: (payload) => {
      observedCall("changeDirectory", payload)
      return (options.client?.changeDirectory ?? defaults.changeDirectory)(payload)
    },
    archive: (payload) => {
      observedCall("archive", payload)
      return (options.client?.archive ?? defaults.archive)(payload)
    },
    restore: (payload) => {
      observedCall("restore", payload)
      return (options.client?.restore ?? defaults.restore)(payload)
    },
    setMetadata: (payload) => {
      observedCall("setMetadata", payload)
      return (options.client?.setMetadata ?? defaults.setMetadata)(payload)
    },
    delete: (payload) => {
      observedCall("delete", payload)
      return (options.client?.delete ?? defaults.delete)(payload)
    },
    list: (payload = {}) => {
      observedCall("list", payload)
      return (options.client?.list ?? defaults.list)(payload)
    },
    events: (payload = {}) => {
      observedCall("events", payload)
      Deferred.doneUnsafe(synchronizationStarted, Effect.void)
      return (options.client?.events ?? defaults.events)(payload)
    }
  }

  const managedRuntime = (
    options.failure
      ? ManagedRuntime.make(Layer.effect(ClientSession, Effect.fail(options.failure)))
      : ManagedRuntime.make(
          Layer.mergeAll(
            Layer.succeed(ClientSession, {
              status: statusRef,
              current: Effect.die("unused"),
              epochs: Stream.empty
            }),
            Layer.succeed(ProjectClient, client),
            Layer.succeed(ServerClient, { health: () => Effect.succeed("ok") })
          )
        )
  ) as ExpandRuntime
  const unmounts = new Set<() => void>()
  const lifecycle = { inkUnmounts: 0, runtimeDisposals: 0 }
  let disposed = false
  let synchronizationClaimed = false
  const runtime = new Proxy(managedRuntime, {
    get: (target, property) => {
      if (property !== "runFork") return Reflect.get(target, property)
      return ((effect: Parameters<ExpandRuntime["runFork"]>[0]) => {
        const transformed = options.transformEffect?.(effect) ?? effect
        const owned = synchronizationClaimed
          ? transformed
          : transformed.pipe(
              Effect.onInterrupt(() => Deferred.succeed(synchronizationInterrupted, undefined))
            )
        synchronizationClaimed = true
        const fiber = Reflect.apply(
          Reflect.get(target, property) as ExpandRuntime["runFork"],
          target,
          [owned]
        )
        return options.transformFiber?.(fiber) ?? fiber
      })
    }
  }) as ExpandRuntime

  const awaitCall = (method: keyof ProjectClientApi): Effect.Effect<unknown> =>
    Queue.take(callQueue).pipe(
      Effect.flatMap((call) => call.method === method ? Effect.succeed(call.payload) : awaitCall(method))
    )
  const awaitSnapshot = (predicate: (snapshot: ProjectSnapshot) => boolean): Effect.Effect<ProjectSnapshot> =>
    Effect.suspend(() => predicate(authoritative)
      ? Effect.succeed(authoritative)
      : Queue.take(snapshotQueue).pipe(
          Effect.flatMap((snapshot) => predicate(snapshot) ? Effect.succeed(snapshot) : awaitSnapshot(predicate))
        ))

  return {
    runtime,
    calls,
    observed: {
      call: awaitCall,
      snapshot: awaitSnapshot,
      synchronizationStarted: waitForDeferred(synchronizationStarted),
      synchronizationInterrupted: waitForDeferred(synchronizationInterrupted)
    },
    status: {
      set: (status: ConnectionStatus) => SubscriptionRef.set(statusRef, status)
    },
    authoritative: {
      get: () => authoritative,
      set: (snapshot: ProjectSnapshot) => {
        authoritative = snapshot
        Queue.offerUnsafe(snapshotQueue, snapshot)
      }
    },
    events: {
      publish
    },
    syncInterrupted: waitForDeferred(synchronizationInterrupted).pipe(Effect.as(true)),
    lifecycle,
    trackUnmount: (unmount: () => void) => { unmounts.add(unmount) },
    disposeEffect: Effect.suspend(() => {
      if (disposed) return Effect.void
      disposed = true
      return Effect.sync(() => {
        for (const unmount of [...unmounts]) unmount()
        lifecycle.runtimeDisposals += 1
      }).pipe(Effect.andThen(managedRuntime.disposeEffect))
    })
  }
})

export type RuntimeHarness = Effect.Success<ReturnType<typeof makeRuntimeHarness>>

export const makeRuntimeHarnessScoped = Effect.fn("TuiTest.makeRuntimeHarnessScoped")((
  options: RuntimeHarnessOptions = {}
) => Effect.acquireRelease(
  makeRuntimeHarness(options),
  (harness) => harness.disposeEffect
))

export const renderInkScoped = Effect.fn("TuiTest.renderInkScoped")((node: ReactElement) =>
  Effect.acquireRelease(
    renderObserved(node).pipe(
      Effect.map((rendered) => ({ rendered, release: rendered.unmount }))
    ),
    (owned) => Effect.sync(owned.release)
  ).pipe(Effect.map((owned) => owned.rendered)))

export const renderWithRuntimeScoped = Effect.fn("TuiTest.renderWithRuntimeScoped")((
  node: ReactElement,
  harness: RuntimeHarness
) => Effect.acquireRelease(
  renderObserved(createElement(RuntimeContext.Provider, { value: harness.runtime }, node)).pipe(
    Effect.map((rendered) => {
      const release = rendered.unmount
      let released = false
      const unmount = () => {
        if (released) return
        released = true
        harness.lifecycle.inkUnmounts += 1
        release()
      }
      harness.trackUnmount(unmount)
      return { rendered: { ...rendered, unmount }, release: unmount }
    })
  ),
  (owned) => Effect.sync(owned.release)
).pipe(Effect.map((owned) => owned.rendered)))

const LifecycleProbe = ({ mounted, unmounted }: {
  readonly mounted: Deferred.Deferred<void>
  readonly unmounted: Deferred.Deferred<void>
}) => {
  useEffect(() => {
    Deferred.doneUnsafe(mounted, Effect.void)
    return () => { Deferred.doneUnsafe(unmounted, Effect.void) }
  }, [mounted, unmounted])
  return null
}

const renderObserved = Effect.fn("TuiTest.renderObserved")(function* (node: ReactElement) {
  const mounted = yield* Deferred.make<void>()
  const unmounted = yield* Deferred.make<void>()
  const frames = yield* Queue.unbounded<string>()
  const rendered = render(createElement(
    Fragment,
    null,
    node,
    createElement(LifecycleProbe, { mounted, unmounted })
  ))
  const push = rendered.stdout.frames.push.bind(rendered.stdout.frames)
  rendered.stdout.frames.push = (...written: Array<string>) => {
    for (const frame of written) Queue.offerUnsafe(frames, frame)
    return push(...written)
  }
  let released = false
  const unmount = () => {
    if (released) return
    released = true
    rendered.unmount()
  }
  const awaitFrame = (predicate: string | ((frame: string) => boolean)): Effect.Effect<string> => {
    const matches = typeof predicate === "string"
      ? (frame: string) => frame.includes(predicate)
      : predicate
    return Effect.suspend(() => {
      const current = rendered.lastFrame()
      return current !== undefined && matches(current)
        ? Effect.yieldNow.pipe(Effect.as(current))
        : Queue.take(frames).pipe(
            Effect.flatMap((frame) => matches(frame)
              ? Effect.yieldNow.pipe(Effect.as(frame))
              : awaitFrame(matches))
          )
    })
  }
  return {
    ...rendered,
    unmount,
    mounted: waitForDeferred(mounted),
    unmounted: waitForDeferred(unmounted),
    awaitFrame,
    inputListeners: () => rendered.stdin.listenerCount("readable")
  }
})

const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const waitForDeferred = Deferred.await
