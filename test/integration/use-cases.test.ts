import { describe, expect, it } from "vitest"
import { Effect, Layer, PubSub } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { EventStore, EventStoreLayer } from "@yodea/db/event-store"
import { EventBus, EventBusLayer } from "@yodea/application/event-bus"
import { ProjectProjection, ProjectProjectionLayer } from "@yodea/application/projections"
import { UseCases, UseCasesLayer } from "@yodea/application/use-cases"

const Sql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
// ONE shared EventStore (same constant referenced everywhere -> memoized to one instance).
const Store = EventStoreLayer.pipe(Layer.provide(Sql))
const Projection = ProjectProjectionLayer.pipe(Layer.provide(Store))
// Output UseCases + EventStore + EventBus so the test can inspect all three.
const TestLayer = UseCasesLayer.pipe(
  Layer.provide(Projection),
  Layer.provideMerge(Store),
  Layer.provideMerge(EventBusLayer)
)

describe("UseCases.createProject", () => {
  it("appends a durable event, broadcasts it live, and reflects it in the projection", async () => {
    const program = Effect.gen(function* () {
      const useCases = yield* UseCases
      const bus = yield* EventBus
      const store = yield* EventStore

      const sub = yield* bus.subscribe // subscribe before the command (deterministic)
      const { project } = yield* useCases.createProject("Hello", false)

      const broadcast = yield* PubSub.take(sub)
      const persisted = yield* store.readAll
      const listed = yield* useCases.listProjects()

      return { project, broadcast, persisted, listed }
    }).pipe(Effect.scoped, Effect.provide(TestLayer))

    const r = await Effect.runPromise(program)
    expect(r.project.name).toBe("Hello")
    expect(r.broadcast._tag).toBe("ProjectCreated")
    expect(r.broadcast.projectId).toBe(r.project.id) // same event broadcast as committed
    expect(r.persisted).toHaveLength(1)
    expect(r.listed).toEqual([r.project]) // read-your-writes
  })

  it("health returns ok", async () => {
    const ok = await Effect.runPromise(
      Effect.provide(Effect.flatMap(UseCases, (u) => u.health), TestLayer)
    )
    expect(ok).toBe("ok")
  })

  it("listProjects(includeArchived) accepts the flag and returns non-deleted projects", async () => {
    const r = await Effect.runPromise(Effect.gen(function* () {
      const u = yield* UseCases
      yield* u.createProject("alpha", false)
      return { def: yield* u.listProjects(false), all: yield* u.listProjects(true) }
    }).pipe(Effect.provide(TestLayer)))
    expect(r.def.map((p) => p.name)).toEqual(["alpha"])
    expect(r.all.map((p) => p.name)).toEqual(["alpha"])
  })

  // Locks the layer-composition shape the change-directory slice reuses:
  // BunFileSystem supplies FileSystem, BunServices supplies Path. UseCases
  // still resolves (it does not yield FS yet) — proving the wiring is additive.
  it("UseCases resolves with FileSystem+Path provided", async () => {
    const FsTestLayer = TestLayer.pipe(Layer.provide(BunFileSystem.layer), Layer.provide(BunServices.layer))
    const ok = await Effect.runPromise(Effect.provide(Effect.flatMap(UseCases, (u) => u.health), FsTestLayer))
    expect(ok).toBe("ok")
  })
})
