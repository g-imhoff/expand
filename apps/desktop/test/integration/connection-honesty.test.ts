import { describe, expect, it } from "vitest"
import { Effect, Exit, Fiber, Layer, Stream, SubscriptionRef } from "effect"
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
import {
  ServerClient,
  type ServerClientApi
} from "@expand/client-ts/server"
import { connectionHandlers } from "@expand/desktop/main/rpc/connection-handlers"
import { healthHandlers } from "@expand/desktop/main/rpc/health-handlers"

const connect = connectionHandlers.Connect as () => Stream.Stream<boolean, never, ClientSession>
const events = connectionHandlers.Events as unknown as (
  payload: { readonly fromSeq?: number }
) => Stream.Stream<SequencedEvent, unknown, ProjectClient>
const health = healthHandlers.Health as () => Effect.Effect<string, never, ClientSession | ServerClient>

const makeClientLayer = (
  status: SubscriptionRef.SubscriptionRef<ConnectionStatus>,
  project: ProjectClientApi,
  server: ServerClientApi
) => {
  const session: ClientSessionApi = {
    status,
    current: Effect.die("unused"),
    epochs: Stream.empty
  }
  return Layer.mergeAll(
    Layer.succeed(ClientSession, session),
    Layer.succeed(ProjectClient, project),
    Layer.succeed(ServerClient, server)
  )
}

const unusedProjectClient = (events: ProjectClientApi["events"]): ProjectClientApi => ({
  create: () => Effect.die("unused"),
  rename: () => Effect.die("unused"),
  changeDirectory: () => Effect.die("unused"),
  archive: () => Effect.die("unused"),
  restore: () => Effect.die("unused"),
  setMetadata: () => Effect.die("unused"),
  delete: () => Effect.die("unused"),
  list: () => Effect.die("unused"),
  events
})

const collectEventRequest = (fromSeq: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
      let requested: { readonly fromSeq?: number } | undefined
      const layer = makeClientLayer(
        status,
        unusedProjectClient((payload = {}) => {
          requested = payload
          return Stream.empty
        }),
        { health: () => Effect.die("unused") }
      )
      yield* Stream.runDrain(events({ fromSeq })).pipe(Effect.provide(layer))
      return requested
    })
  )

const collectConnect = (statuses: ReadonlyArray<ConnectionStatus>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const status = yield* SubscriptionRef.make<ConnectionStatus>(statuses[0] ?? "disconnected")
      const layer = makeClientLayer(
        status,
        unusedProjectClient(() => Stream.empty),
        { health: () => Effect.die("unused") }
      )
      const fiber = yield* Stream.runCollect(Stream.take(connect(), statuses.length)).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      for (const next of statuses.slice(1)) {
        yield* SubscriptionRef.set(status, next)
        yield* Effect.yieldNow
      }
      return Array.from(yield* Fiber.join(fiber))
    })
  )

const runHealthStatusScenario = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
      let healthCalls = 0
      const layer = makeClientLayer(
        status,
        unusedProjectClient(() => Stream.empty),
        {
          health: () => Effect.sync(() => {
            healthCalls += 1
            return "ok"
          })
        }
      )
      const connected = yield* health().pipe(Effect.provide(layer))
      yield* SubscriptionRef.set(status, "reconnecting")
      const reconnecting = yield* Effect.exit(health().pipe(Effect.provide(layer)))
      return { connected, reconnecting, healthCalls }
    })
  )

describe("desktop seam honesty", () => {
  it("Events forwards fromSeq to the upstream epoch", async () => {
    const requested = await collectEventRequest(17)
    expect(requested).toEqual({ fromSeq: 17 })
  })

  it("Connect reflects ClientSession status transitions", async () => {
    const values = await collectConnect(["connected", "reconnecting", "connected"])
    expect(values).toEqual([true, false, true])
  })

  it("Health delegates only while connected", async () => {
    const result = await runHealthStatusScenario()
    expect(result.connected).toBe("ok")
    expect(Exit.isFailure(result.reconnecting)).toBe(true)
    expect(result.healthCalls).toBe(1)
  })
})
