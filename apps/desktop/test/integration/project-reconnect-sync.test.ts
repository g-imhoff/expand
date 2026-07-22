import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, PubSub, Queue, Ref, Schema, Stream, SubscriptionRef } from "effect"
import { describe, expect } from "vitest"
import { ProjectRenamed } from "@expand/contracts/events/project"
import { Project } from "@expand/contracts/project"
import type { ProjectSnapshot } from "@expand/contracts/project-sync"
import { runProjectSync } from "@expand/contracts/project-sync"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { ClientSession, type ClientSessionApi, type ConnectionStatus } from "@expand/client-ts"
import { ProjectClient, type ProjectClientApi } from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { runRpcServer, type MainPortLike } from "@expand/desktop/main/rpc/server"
import { makeProjectSyncSink, makeProjectsStore, type ProjectsStore } from "@expand/desktop/renderer/features/projects/data/project-store"
import { ProjectRpc, ProjectRpcLayer } from "@expand/desktop/renderer/rpc/project-rpc"
import type { RendererPortLike } from "@expand/desktop/renderer/rpc/renderer-port"
import { buildRendererClient, RendererRpcClient } from "@expand/desktop/renderer/rpc/transport"

const alpha = Schema.decodeUnknownSync(Project)({
  id: "00000000-0000-4000-8000-000000000001",
  name: "alpha",
  directory: null,
  description: null,
  tags: [],
  archived: false,
  createdAt: "t1",
  updatedAt: "t1"
})

const beta = Schema.decodeUnknownSync(Project)({
  id: "00000000-0000-4000-8000-000000000002",
  name: "beta",
  directory: null,
  description: null,
  tags: [],
  archived: false,
  createdAt: "t5",
  updatedAt: "t5"
})

const makePortPair = Effect.fn("ProjectReconnectTest.makePortPair")(function* () {
  let serverListener: ((event: { data: unknown }) => void) | null = null
  let rendererListener: ((event: { data: unknown }) => void) | null = null
  const mainMessages = yield* Queue.unbounded<unknown>()
  const rendererMessages = yield* Queue.unbounded<unknown>()
  const mainStarted = yield* Queue.unbounded<void>()
  const rendererStarted = yield* Queue.unbounded<void>()
  yield* Effect.forever(
    Queue.take(mainMessages).pipe(
      Effect.tap((data) => Effect.sync(() => serverListener?.({ data: structuredClone(data) })))
    )
  ).pipe(Effect.forkScoped)
  yield* Effect.forever(
    Queue.take(rendererMessages).pipe(
      Effect.tap((data) => Effect.sync(() => rendererListener?.({ data: structuredClone(data) })))
    )
  ).pipe(Effect.forkScoped)
  const server: MainPortLike = {
    postMessage: (message) => { Queue.offerUnsafe(rendererMessages, message) },
    on: (_event, listener) => { serverListener = listener },
    start: () => { Queue.offerUnsafe(mainStarted, undefined) }
  }
  const renderer: RendererPortLike = {
    postMessage: (message) => { Queue.offerUnsafe(mainMessages, message) },
    get onmessage() { return rendererListener },
    set onmessage(listener) { rendererListener = listener },
    start: () => { Queue.offerUnsafe(rendererStarted, undefined) }
  }
  return { server, renderer, mainStarted, rendererStarted }
})

const awaitStoreSeq = (store: ProjectsStore, seq: number) =>
  Effect.suspend(() => {
    if (store.getState().seq === seq) return Effect.void
    return Effect.gen(function* () {
      const reached = yield* Deferred.make<void>()
      yield* Effect.acquireRelease(
        Effect.sync(() => store.subscribe((state) => {
          if (state.seq === seq) Deferred.doneUnsafe(reached, Effect.void)
        })),
        (unsubscribe) => Effect.sync(unsubscribe)
      )
      yield* Deferred["\u0061wait"](reached)
    }).pipe(Effect.scoped)
  })

const mainLayer = (
  status: SubscriptionRef.SubscriptionRef<ConnectionStatus>,
  authoritative: Ref.Ref<ProjectSnapshot>,
  events: PubSub.PubSub<SequencedEvent>,
  eventRequests: Queue.Queue<{ readonly fromSeq: number }>
) => {
  const session: ClientSessionApi = {
    status,
    current: Effect.die("unused"),
    epochs: Stream.empty
  }
  const projects: ProjectClientApi = {
    create: () => Effect.die("unused"),
    rename: () => Effect.die("unused"),
    changeDirectory: () => Effect.die("unused"),
    archive: () => Effect.die("unused"),
    restore: () => Effect.die("unused"),
    setMetadata: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    list: () => Ref.get(authoritative),
    events: (payload) => {
      Queue.offerUnsafe(eventRequests, { fromSeq: payload?.fromSeq ?? 0 })
      return Stream.fromPubSub(events)
    }
  }
  return Layer.mergeAll(
    Layer.succeed(ClientSession, session),
    Layer.succeed(ProjectClient, projects),
    Layer.succeed(ServerClient, { health: () => Effect.succeed("ok") })
  )
}

describe("renderer project synchronization", () => {
  it.live("resnapshots missed external changes after an upstream reconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
        const authoritative = yield* Ref.make<ProjectSnapshot>({ projects: [alpha], seq: 1 })
        const events = yield* PubSub.unbounded<SequencedEvent>()
        const eventRequests = yield* Queue.unbounded<{ readonly fromSeq: number }>()
        const { server, renderer, mainStarted, rendererStarted } = yield* makePortPair()
        yield* runRpcServer(server).pipe(
          Effect.provide(mainLayer(status, authoritative, events, eventRequests)),
          Effect.scoped,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Queue.take(mainStarted)
        const client = yield* buildRendererClient(renderer)
        yield* Queue.take(rendererStarted)
        const rpc = yield* ProjectRpc.pipe(
          Effect.provide(ProjectRpcLayer),
          Effect.provideService(RendererRpcClient, client)
        )
        const store = makeProjectsStore()
        const syncFiber = yield* Effect.forkScoped(
          runProjectSync({
            status: rpc.status,
            list: () => rpc.list({ includeArchived: true }),
            events: rpc.events
          }, makeProjectSyncSink(store))
        )
        yield* awaitStoreSeq(store, 1)
        expect(store.getState()).toMatchObject({ projects: [alpha], seq: 1 })
        yield* SubscriptionRef.set(status, "reconnecting")
        yield* Ref.set(authoritative, { projects: [beta], seq: 5 })
        expect(store.getState()).toMatchObject({ projects: [alpha], seq: 1 })
        yield* SubscriptionRef.set(status, "connected")
        yield* awaitStoreSeq(store, 5)
        expect(store.getState()).toMatchObject({ projects: [beta], seq: 5 })
        const firstRequest = yield* Queue.take(eventRequests)
        const secondRequest = yield* Queue.take(eventRequests)
        expect([firstRequest, secondRequest]).toEqual([{ fromSeq: 1 }, { fromSeq: 5 }])
        yield* Fiber.interrupt(syncFiber)
        yield* PubSub.publish(events, {
          seq: 6,
          event: ProjectRenamed.make({ projectId: beta.id, name: "beta-late", occurredAt: "t6" })
        })
        yield* Effect.yieldNow
        expect(store.getState()).toMatchObject({ projects: [beta], seq: 5 })
      })
    ))
})
