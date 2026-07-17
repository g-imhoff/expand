import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { RpcClient } from "effect/unstable/rpc"
import { describe, expect, vi } from "vitest"
import { ProcessServices } from "../process-services"
import { AppContext } from "@expand/contracts/app-context"
import { ProjectCreated } from "@expand/contracts/events/project"
import type { RuntimeAdapter } from "../../adapter"
import { ClientLayer } from "../../client-layer"
import { ClientSession, type ClientSessionApi } from "../../client-session"
import { ProjectClient, ProjectClientLive } from "../../project/client"
import type { ExpandRpcClientApi } from "../../rpc-client"
import { ServerClient } from "../../server/client"

const acquisition = vi.hoisted(() => ({
  count: 0,
  client: undefined as unknown
}))

vi.mock("../../rpc-client", () => ({
  acquireClient: (adapter: RuntimeAdapter) =>
    Layer.build(adapter.protocolLayer("ws://127.0.0.1:1/rpc?token=client-layer-test")).pipe(
      Effect.andThen(Effect.sync(() => {
        acquisition.count += 1
        return {
          client: acquisition.client,
          endpoint: {
            url: "ws://127.0.0.1:1/rpc",
            token: "client-layer-test",
            pid: 1,
            protocolVersion: 1
          }
        }
      }))
    )
}))

const adapter: RuntimeAdapter = {
  protocolLayer: () => Layer.empty as Layer.Layer<RpcClient.Protocol>,
  spawnBackend: () => Effect.die("unused")
}

const makeEvent = (epoch: number): SequencedEvent => ({
  seq: epoch,
  event: ProjectCreated.make({
    projectId: `epoch-${epoch}`,
    name: `epoch-${epoch}`,
    occurredAt: `t${epoch}`
  })
}) as SequencedEvent

const makeClient = (
  epoch: number,
  onEvents: (payload: { readonly fromSeq?: number }) => void = () => undefined
): ExpandRpcClientApi => ({
  Health: () => Effect.succeed(String(epoch)),
  ProjectCreate: () => Effect.die("unused"),
  ProjectRename: () => Effect.die("unused"),
  ProjectChangeDirectory: () => Effect.die("unused"),
  ProjectArchive: () => Effect.die("unused"),
  ProjectRestore: () => Effect.die("unused"),
  ProjectSetMetadata: () => Effect.die("unused"),
  ProjectDelete: () => Effect.die("unused"),
  ProjectList: () => Effect.succeed({ projects: [], seq: epoch }),
  Connect: () => Stream.make(true),
  Events: (payload = {}) => {
    onEvents(payload)
    return Stream.make(makeEvent(epoch))
  }
}) as unknown as ExpandRpcClientApi

const makeSession = (current: Effect.Effect<ExpandRpcClientApi>): ClientSessionApi => ({
  status: undefined as never,
  current,
  epochs: Stream.empty
})

const projectLayer = (session: ClientSessionApi) =>
  ProjectClientLive.pipe(Layer.provide(Layer.succeed(ClientSession, session)))

const runProjectEvents = (payload: { readonly fromSeq?: number }) => Effect.gen(function*() {
  let requested: { readonly fromSeq?: number } | undefined
  const session = makeSession(Effect.succeed(makeClient(1, (received) => {
    requested = received
  })))
  yield* ProjectClient.pipe(
    Effect.flatMap((client) => Stream.runDrain(client.events(payload))),
    Effect.provide(projectLayer(session))
  )
  return requested
})

const runBoundEpochScenario = () => Effect.gen(function*() {
  const current = yield* Ref.make(makeClient(1))
  const session = makeSession(Ref.get(current))
  return yield* Effect.gen(function*() {
    const client = yield* ProjectClient
    const first = yield* Stream.runCollect(client.events())
    yield* Ref.set(current, makeClient(2))
    const second = yield* Stream.runCollect(client.events())
    return {
      firstStreamEpochs: Array.from(first, (event) => event.seq),
      secondStreamEpochs: Array.from(second, (event) => event.seq)
    }
  }).pipe(Effect.provide(projectLayer(session)))
})

const runCommandDuringReconnect = () => Effect.gen(function*() {
  const next = yield* Deferred.make<ExpandRpcClientApi>()
  const session = makeSession(Deferred.await(next))
  return yield* Effect.gen(function*() {
    const client = yield* ProjectClient
    const command = yield* Effect.forkChild(client.list({ includeArchived: true }))
    yield* Effect.yieldNow
    yield* Deferred.succeed(next, makeClient(2))
    const result = yield* Fiber.join(command)
    return { epoch: result.seq }
  }).pipe(Effect.provide(projectLayer(session)))
})

const runSharedLayerScenario = () => {
  acquisition.count = 0
  acquisition.client = makeClient(7)
  return Effect.gen(function*() {
    const session = yield* ClientSession
    const project = yield* ProjectClient
    const server = yield* ServerClient
    const sessionClient = yield* session.current
    const sessionHealth = yield* sessionClient.Health()
    const projectHealth = yield* project.list({ includeArchived: true })
    const serverHealth = yield* server.health()
    return {
      acquisitions: acquisition.count,
      sessionHealthEpoch: sessionHealth,
      projectHealthEpoch: String(projectHealth.seq),
      serverHealthEpoch: serverHealth
    }
  }).pipe(
    Effect.provide(clientLayer(adapter)),
    Effect.provide(ProcessServices.layer)
  )
}

describe("client layer", () => {
  it.effect("ProjectClient events delegates the requested fromSeq", () =>
    runProjectEvents({ fromSeq: 41 }).pipe(
      Effect.tap((requested) => Effect.sync(() => expect(requested).toEqual({ fromSeq: 41 })))
    ))

  it.effect("ProjectClient events remains bound to one connection epoch", () =>
    runBoundEpochScenario().pipe(
      Effect.tap((result) => Effect.sync(() => {
        expect(result.firstStreamEpochs).toEqual([1])
        expect(result.secondStreamEpochs).toEqual([2])
      }))
    ))

  it.effect("a command started during reconnect uses the reacquired epoch", () =>
    runCommandDuringReconnect().pipe(
      Effect.tap((result) => Effect.sync(() => expect(result.epoch).toBe(2)))
    ))

  it.effect("ClientLayer shares one ClientSession", () =>
    runSharedLayerScenario().pipe(
      Effect.tap((result) => Effect.sync(() => {
        expect(result.acquisitions).toBe(1)
        expect(result.projectHealthEpoch).toBe(result.serverHealthEpoch)
        expect(result.sessionHealthEpoch).toBe(result.serverHealthEpoch)
      }))
    ))
})

const clientLayer = (runtimeAdapter: RuntimeAdapter) =>
  ClientLayer(runtimeAdapter).pipe(
    Layer.provide(Layer.succeed(AppContext, {
      channel: "dev",
      paths: {
        dataDir: "/work/state",
        dbPath: "/work/state/events.db",
        endpointFile: "/work/state/server.json",
        logDir: "/work/state/logs",
        spawnLockFile: "/work/state/server.json.lock"
      }
    }))
  )

type SequencedEvent = import("@expand/contracts/events/domain").SequencedEvent
