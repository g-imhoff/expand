import { it } from "@effect/vitest"
import { Effect, Fiber, Option, PubSub, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { ProjectRenamed } from "@expand/contracts/events/project"
import { Project } from "@expand/contracts/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import {
  runProjectSync,
  type ProjectSnapshot,
  type ProjectSyncSource,
  type ProjectSyncStatus
} from "@expand/contracts/project-sync"
import {
  makeProjectsStore,
  makeProjectSyncSink,
  type ProjectsStore
} from "@expand/desktop/renderer/features/projects/data/project-store"
import {
  makeBackendConnectionStore,
  noteBackendSnapshot,
  rememberSelectedProject,
  switchBackendMode
} from "@expand/desktop/renderer/features/backend/backend-connection-store"

const alpha = Option.getOrThrow(Schema.decodeUnknownOption(Project)({
  id: "00000000-0000-4000-8000-000000000001",
  name: "alpha",
  directory: null,
  description: null,
  tags: [],
  archived: false,
  createdAt: "t1",
  updatedAt: "t1"
}))

const beta = Option.getOrThrow(Schema.decodeUnknownOption(Project)({
  id: "00000000-0000-4000-8000-000000000001",
  name: "alpha",
  directory: null,
  description: null,
  tags: [],
  archived: false,
  createdAt: "t5",
  updatedAt: "t5"
}))

const waitForStoreSeq = (store: ProjectsStore, seq: number) =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (store.getState().seq === seq) return
      yield* Effect.sleep("5 millis")
    }
    return yield* Effect.die(new Error(`store never reached seq ${seq}`))
  })

const statusStream = (status: PubSub.PubSub<ProjectSyncStatus>) =>
  Stream.unwrap(
    PubSub.subscribe(status).pipe(
      Effect.map((subscription) =>
        Stream.make("connected" as ProjectSyncStatus).pipe(
          Stream.concat(Stream.fromSubscription(subscription))
        )
      )
    )
  )

const switchScenario = () =>
  Effect.scoped(Effect.gen(function*() {
    const connections = makeBackendConnectionStore()
    rememberSelectedProject(connections, alpha.id)
    const store = makeProjectsStore()
    const sink = makeProjectSyncSink(store)
    const localRequests: Array<{ readonly fromSeq: number }> = []
    const remoteRequests: Array<{ readonly fromSeq: number }> = []
    const localStatus = yield* PubSub.unbounded<ProjectSyncStatus>()
    const remoteStatus = yield* PubSub.unbounded<ProjectSyncStatus>()
    const localEvents = yield* PubSub.unbounded<SequencedEvent>()
    const remoteEvents = yield* PubSub.unbounded<SequencedEvent>()
    const local: ProjectSyncSource = {
      status: statusStream(localStatus),
      list: () => Effect.succeed({ projects: [alpha], seq: 1 }),
      events: (payload) => {
        localRequests.push(payload)
        return Stream.fromPubSub(localEvents)
      }
    }
    const localFiber = yield* Effect.forkScoped(runProjectSync(local, sink))
    yield* waitForStoreSeq(store, 1)
    yield* PubSub.publish(localEvents, {
      seq: 2,
      event: ProjectRenamed.make({ projectId: alpha.id, name: "alpha-live", occurredAt: "t2" })
    })
    yield* waitForStoreSeq(store, 2)
    noteBackendSnapshot(connections, store.getState().seq)
    switchBackendMode(connections, "remote")
    yield* Fiber.interrupt(localFiber)
    const remote: ProjectSyncSource = {
      status: statusStream(remoteStatus),
      list: () => Effect.succeed({ projects: [beta], seq: 5 }),
      events: (payload) => {
        remoteRequests.push(payload)
        return Stream.fromPubSub(remoteEvents)
      }
    }
    const remoteFiber = yield* Effect.forkScoped(runProjectSync(remote, sink))
    yield* waitForStoreSeq(store, 5)
    yield* PubSub.publish(remoteEvents, {
      seq: 6,
      event: ProjectRenamed.make({ projectId: beta.id, name: "alpha-remote", occurredAt: "t6" })
    })
    yield* waitForStoreSeq(store, 6)
    yield* Fiber.interrupt(remoteFiber)
    return {
      connections: connections.getState(),
      projects: store.getState(),
      localRequests,
      remoteRequests
    }
  }))

const dropScenario = () =>
  Effect.scoped(Effect.gen(function*() {
    const connections = makeBackendConnectionStore({ mode: "remote" })
    rememberSelectedProject(connections, alpha.id)
    const store = makeProjectsStore()
    const sink = makeProjectSyncSink(store)
    const statuses = yield* PubSub.unbounded<ProjectSyncStatus>()
    let authoritative: ProjectSnapshot = { projects: [alpha], seq: 3 }
    const source: ProjectSyncSource = {
      status: statusStream(statuses),
      list: () => Effect.succeed(authoritative),
      events: () => Stream.never
    }
    const fiber = yield* Effect.forkScoped(runProjectSync(source, sink))
    yield* waitForStoreSeq(store, 3)
    noteBackendSnapshot(connections, store.getState().seq)
    yield* PubSub.publish(statuses, "reconnecting")
    yield* Effect.sleep("50 millis")
    authoritative = { projects: [beta], seq: 9 }
    yield* PubSub.publish(statuses, "connected")
    yield* waitForStoreSeq(store, 9)
    yield* Fiber.interrupt(fiber)
    return { connections: connections.getState(), projects: store.getState() }
  }))

describe("backend switching", () => {
  it.live("preserves selection and resubscribes from the last sequence across a backend switch", () =>
    switchScenario().pipe(Effect.tap((result) => Effect.sync(() => {
      expect(result.connections).toMatchObject({
        mode: "remote",
        selectedProjectId: alpha.id,
        lastSeq: 2
      })
      expect(result.projects).toMatchObject({ seq: 6 })
      expect(result.projects.projects.map((project) => project.name)).toEqual(["alpha-remote"])
      expect(result.localRequests).toEqual([{ fromSeq: 1 }])
      expect(result.remoteRequests).toEqual([{ fromSeq: 5 }])
    }))))

  it.live("keeps selection while a remote drop resnapshots from the latest sequence", () =>
    dropScenario().pipe(Effect.tap((result) => Effect.sync(() => {
      expect(result.connections).toMatchObject({ mode: "remote", selectedProjectId: alpha.id })
      expect(result.projects).toMatchObject({ seq: 9 })
    }))))
})
