import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, PubSub, Queue, Schema, Stream, SubscriptionRef } from "effect"
import { Project as ProjectClass, ProjectCreateResult } from "@expand/contracts/project"
import type { Project } from "@expand/contracts/project"
import { ProjectCreated } from "@expand/contracts/events/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import {
  ClientSession,
  type ClientSessionApi,
  type ConnectionStatus
} from "@expand/client-ts"
import {
  ProjectClient,
  type ProjectClientApi
} from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { buildRendererClient } from "@expand/desktop/renderer/rpc/transport"
import type { RendererPortLike } from "@expand/desktop/renderer/rpc/renderer-port"
import { type MainPortLike, runRpcServer } from "@expand/desktop/main/rpc/server"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const fakeClientLayer = (
  status: SubscriptionRef.SubscriptionRef<ConnectionStatus>,
  ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>,
  hub: PubSub.PubSub<SequencedEvent>
) => {
  const session: ClientSessionApi = {
    status,
    current: Effect.die("unused"),
    epochs: Stream.empty
  }
  const project: ProjectClientApi = {
    create: ({ name, directory }) => {
      const value = Schema.decodeUnknownSync(ProjectClass)({
        id: uid(1),
        name,
        directory: directory ?? null,
        description: null,
        tags: [],
        archived: false,
        createdAt: "t",
        updatedAt: "t"
      })
      return Effect.andThen(
        PubSub.publish(hub, {
          seq: 1,
          event: ProjectCreated.make({
            projectId: value.id,
            name: value.name,
            directory: value.directory,
            occurredAt: "t"
          })
        }),
        SubscriptionRef.update(ref, (current) => [...current, value]).pipe(
          Effect.as(Schema.decodeUnknownSync(ProjectCreateResult)({ created: true, project: value }))
        )
      )
    },
    rename: () => Effect.die("unused"),
    changeDirectory: () => Effect.die("unused"),
    archive: () => Effect.die("unused"),
    restore: () => Effect.die("unused"),
    setMetadata: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    list: () => Effect.map(SubscriptionRef.get(ref), (projects) => ({ projects, seq: 0 })),
    events: () => Stream.fromPubSub(hub)
  }
  return Layer.mergeAll(
    Layer.succeed(ClientSession, session),
    Layer.succeed(ProjectClient, project),
    Layer.succeed(ServerClient, { health: () => Effect.succeed("ok") })
  )
}

const makePortPair = Effect.fn("DesktopRpcServerTest.makePortPair")(function* () {
  let serverListener: ((event: { data: unknown }) => void) | null = null
  let rendererListener: ((event: { data: unknown }) => void) | null = null
  const toServer = yield* Queue.unbounded<unknown>()
  const toRenderer = yield* Queue.unbounded<unknown>()
  const serverStarted = yield* Queue.unbounded<void>()
  const rendererStarted = yield* Queue.unbounded<void>()
  yield* Effect.forkScoped(Effect.forever(
    Queue.take(toServer).pipe(Effect.tap((message) => Effect.sync(() => {
      serverListener?.({ data: structuredClone(message) })
    })))
  ))
  yield* Effect.forkScoped(Effect.forever(
    Queue.take(toRenderer).pipe(Effect.tap((message) => Effect.sync(() => {
      rendererListener?.({ data: structuredClone(message) })
    })))
  ))
  const server: MainPortLike = {
    postMessage: (message) => { Queue.offerUnsafe(toRenderer, message) },
    on: (_event, callback) => { serverListener = callback },
    start: () => { Queue.offerUnsafe(serverStarted, undefined) }
  }
  const renderer: RendererPortLike = {
    postMessage: (message) => { Queue.offerUnsafe(toServer, message) },
    get onmessage() { return rendererListener },
    set onmessage(callback) { rendererListener = callback },
    start: () => { Queue.offerUnsafe(rendererStarted, undefined) }
  }
  return { server, renderer, serverStarted, rendererStarted }
})

describe("main RpcServer <-> renderer RpcClient round-trip (serialized over a cloning port)", () => {
  it.effect("ProjectList/ProjectCreate cross the seam and decode to typed values", () =>
    Effect.scoped(Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<ReadonlyArray<Project>>([])
      const hub = yield* PubSub.unbounded<SequencedEvent>()
      const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
      const { server, renderer, serverStarted, rendererStarted } = yield* makePortPair()
      yield* runRpcServer(server).pipe(
        Effect.provide(fakeClientLayer(status, ref, hub)),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Queue.take(serverStarted)
      const client = yield* buildRendererClient(renderer)
      yield* Queue.take(rendererStarted)

      const list0 = yield* client.ProjectList({})
      const created = yield* client.ProjectCreate({ name: "omega", ensure: false })
      const list1 = yield* client.ProjectList({})

      expect(list0).toEqual({ projects: [], seq: 0 })
      expect(created).toMatchObject({ created: true, project: { name: "omega" } })
      expect(list1.projects.map((project) => project.name)).toEqual(["omega"])
    })))
})
