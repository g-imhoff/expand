import { createElement, type ReactElement } from "react"
import { render } from "ink-testing-library"
import { Effect, Layer, ManagedRuntime, Queue, Schema, Stream, SubscriptionRef } from "effect"
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

export const makeRuntimeHarness = (
  options: RuntimeHarnessOptions = {}
) => {
  let authoritative = options.snapshot ?? { projects: [], seq: 0 }
  let nextId = authoritative.projects.length + 1
  const statusRef = Effect.runSync(SubscriptionRef.make<ConnectionStatus>("connected"))
  const eventQueue = Effect.runSync(Queue.unbounded<SequencedEvent>())
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
    events: () => Stream.fromQueue(eventQueue)
  }

  const client: ProjectClientApi = {
    create: (payload) => {
      calls.create.push(payload)
      return (options.client?.create ?? defaults.create)(payload)
    },
    rename: (payload) => {
      calls.rename.push(payload)
      return (options.client?.rename ?? defaults.rename)(payload)
    },
    changeDirectory: (payload) => {
      calls.changeDirectory.push(payload)
      return (options.client?.changeDirectory ?? defaults.changeDirectory)(payload)
    },
    archive: (payload) => {
      calls.archive.push(payload)
      return (options.client?.archive ?? defaults.archive)(payload)
    },
    restore: (payload) => {
      calls.restore.push(payload)
      return (options.client?.restore ?? defaults.restore)(payload)
    },
    setMetadata: (payload) => {
      calls.setMetadata.push(payload)
      return (options.client?.setMetadata ?? defaults.setMetadata)(payload)
    },
    delete: (payload) => {
      calls.delete.push(payload)
      return (options.client?.delete ?? defaults.delete)(payload)
    },
    list: (payload = {}) => {
      calls.list.push(payload)
      return (options.client?.list ?? defaults.list)(payload)
    },
    events: (payload = {}) => {
      calls.events.push(payload)
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
  let synchronizationForked = false
  let synchronizationInterrupted = false
  const runtime = new Proxy(managedRuntime, {
    get: (target, property) => {
      if (property !== "runFork") return Reflect.get(target, property)
      return ((effect: Parameters<ExpandRuntime["runFork"]>[0]) => {
        if (synchronizationForked) synchronizationInterrupted = true
        synchronizationForked = true
        const fiber = target.runFork(options.transformEffect?.(effect) ?? effect)
        return options.transformFiber?.(fiber) ?? fiber
      })
    }
  }) as ExpandRuntime

  return {
    runtime,
    calls,
    status: {
      set: (status: ConnectionStatus) => Effect.runSync(SubscriptionRef.set(statusRef, status))
    },
    authoritative: {
      get: () => authoritative,
      set: (snapshot: ProjectSnapshot) => { authoritative = snapshot }
    },
    events: {
      publish: (event: SequencedEvent["event"]) => Effect.runSync(publish(event))
    },
    syncInterrupted: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return synchronizationForked && synchronizationInterrupted
    },
    trackUnmount: (unmount: () => void) => { unmounts.add(unmount) },
    dispose: () => {
      for (const unmount of [...unmounts]) unmount()
      return managedRuntime.dispose()
    }
  }
}

export type RuntimeHarness = ReturnType<typeof makeRuntimeHarness>

export const renderWithRuntime = (
  node: ReactElement,
  harness: RuntimeHarness
) => {
  const rendered = render(createElement(RuntimeContext.Provider, { value: harness.runtime }, node))
  const inkUnmount = rendered.unmount
  let unmounted = false
  const unmount = () => {
    if (unmounted) return
    unmounted = true
    inkUnmount()
  }
  harness.trackUnmount(unmount)
  return { ...rendered, unmount }
}

const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
