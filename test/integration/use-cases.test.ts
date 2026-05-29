import { describe, expect, it } from "vitest"
import { Effect, Layer, PubSub } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EventStore, EventStoreLayer } from "@yodea/db/event-store"
import { EventBus, EventBusLayer } from "@yodea/application/event-bus"
import { SessionProjection, SessionProjectionLayer } from "@yodea/application/projections"
import { UseCases, UseCasesLayer } from "@yodea/application/use-cases"

const Sql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
// ONE shared EventStore (same constant referenced everywhere -> memoized to one instance).
const Store = EventStoreLayer.pipe(Layer.provide(Sql))
const Projection = SessionProjectionLayer.pipe(Layer.provide(Store))
// Output UseCases + EventStore + EventBus so the test can inspect all three.
const TestLayer = UseCasesLayer.pipe(
  Layer.provide(Projection),
  Layer.provideMerge(Store),
  Layer.provideMerge(EventBusLayer)
)

describe("UseCases.createSession", () => {
  it("appends a durable event, broadcasts it live, and reflects it in the projection", async () => {
    const program = Effect.gen(function* () {
      const useCases = yield* UseCases
      const bus = yield* EventBus
      const store = yield* EventStore

      const sub = yield* bus.subscribe // subscribe before the command (deterministic)
      const session = yield* useCases.createSession("Hello")

      const broadcast = yield* PubSub.take(sub)
      const persisted = yield* store.readAll
      const listed = yield* useCases.listSessions

      return { session, broadcast, persisted, listed }
    }).pipe(Effect.scoped, Effect.provide(TestLayer))

    const r = await Effect.runPromise(program)
    expect(r.session.title).toBe("Hello")
    expect(r.broadcast._tag).toBe("SessionCreated")
    expect(r.broadcast.sessionId).toBe(r.session.id) // same event broadcast as committed
    expect(r.persisted).toHaveLength(1)
    expect(r.listed).toEqual([r.session]) // read-your-writes
  })

  it("health returns ok", async () => {
    const ok = await Effect.runPromise(
      Effect.provide(Effect.flatMap(UseCases, (u) => u.health), TestLayer)
    )
    expect(ok).toBe("ok")
  })
})
