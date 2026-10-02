import { it } from "@effect/vitest"
import { Crypto, Effect, Layer, PlatformError, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, expectTypeOf } from "vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeServices } from "@effect/platform-node"
import { EventBus, EventBusLayer } from "@expand/server/application/event-bus"
import { ProjectProjectionLayer } from "@expand/server/application/projections"
import { ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { ReplayFeed, ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { ProjectUseCases, ProjectUseCasesLayer } from "@expand/server/application/projects/use-cases"
import { DatabaseReadyLayer } from "@expand/server/migrations/sqlite"

const layer = () => {
  const sql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
  const database = DatabaseReadyLayer.pipe(Layer.provideMerge(sql))
  const replay = ReplayFeedLayer.pipe(Layer.provide(database))
  const projectEvents = ProjectEventStoreLayer.pipe(Layer.provide(database))
  const states = ProjectionStateStoreLayer.pipe(Layer.provide(database))
  const projection = ProjectProjectionLayer.pipe(Layer.provide(projectEvents), Layer.provide(states))
  const useCases = ProjectUseCasesLayer.pipe(
    Layer.provide(projectEvents),
    Layer.provide(EventBusLayer),
    Layer.provide(projection)
  )
  return Layer.mergeAll(useCases, EventBusLayer, replay).pipe(Layer.provideMerge(NodeServices.layer))
}

const fixedCrypto = () => {
  let reads = 0
  const crypto = Crypto.make({
    randomBytes: (size) => {
      const value = reads
      reads += 1
      return new Uint8Array(size).fill(value)
    },
    digest: (_algorithm, data) => Effect.succeed(data)
  })
  return { crypto, reads: () => reads } as const
}

describe("ProjectUseCases.createProject", () => {
  it.effect("creates a new project with created:true", () =>
    Effect.gen(function*() {
      const useCases = yield* ProjectUseCases
      const result = yield* useCases.createProject("alpha", false)
      expect(result.created).toBe(true)
      expect(result.project.name).toBe("alpha")
    }).pipe(Effect.provide(layer())))

  it.effect("rejects a duplicate name (strict) with ProjectAlreadyExists", () =>
    Effect.gen(function*() {
      const useCases = yield* ProjectUseCases
      yield* useCases.createProject("dup", false)
      const result = yield* useCases.createProject("dup", false).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect((result as { failure: { _tag: string } }).failure._tag).toBe("ProjectAlreadyExists")
    }).pipe(Effect.provide(layer())))

  it.effect("--ensure returns the existing project with created:false (same id)", () =>
    Effect.gen(function*() {
      const useCases = yield* ProjectUseCases
      const first = yield* useCases.createProject("ens", false)
      const second = yield* useCases.createProject("ens", true)
      expect(second.created).toBe(false)
      expect(second.project.id).toBe(first.project.id)
    }).pipe(Effect.provide(layer())))

  it.live("uses injected identity and time for the returned, persisted, and broadcast project", () => {
    const deterministic = fixedCrypto()
    const create = Effect.flatMap(ProjectUseCases, (useCases) => useCases.createProject("clocked", false))
    expectTypeOf<Extract<Effect.Error<typeof create>, PlatformError.PlatformError>>()
      .toEqualTypeOf<PlatformError.PlatformError>()
    expectTypeOf<Extract<Effect.Services<typeof create>, Crypto.Crypto>>()
      .toEqualTypeOf<Crypto.Crypto>()

    return Effect.gen(function*() {
      yield* TestClock.setTime(1_735_689_600_000)
      const useCases = yield* ProjectUseCases
      const bus = yield* EventBus
      const replay = yield* ReplayFeed
      const subscription = yield* bus.subscribe
      const { project } = yield* useCases.createProject("clocked", false)
      const broadcast = yield* subscription.take
      const persisted = yield* Stream.runCollect(replay.read(0)).pipe(Effect.map((events) => Array.from(events)))

      expect(project.id).toBe("00000000-0000-4000-8000-000000000000")
      expect(project.createdAt).toBe("2025-01-01T00:00:00.000Z")
      expect(project.updatedAt).toBe(project.createdAt)
      expect(broadcast.event._tag).toBe("ProjectCreated")
      expect(broadcast.event.occurredAt).toBe(project.createdAt)
      expect(persisted[0]?.event.occurredAt).toBe(project.createdAt)
      expect(deterministic.reads()).toBe(1)
    }).pipe(
      Effect.scoped,
      Effect.provideService(Crypto.Crypto, deterministic.crypto),
      Effect.provide(Layer.mergeAll(layer(), TestClock.layer()))
    )
  })

  it.live("generates a fresh injected identity for sequential creates", () => {
    const deterministic = fixedCrypto()
    return Effect.gen(function*() {
      const useCases = yield* ProjectUseCases
      const first = yield* useCases.createProject("first", false)
      const second = yield* useCases.createProject("second", false)
      expect(first.project.id).toBe("00000000-0000-4000-8000-000000000000")
      expect(second.project.id).toBe("01010101-0101-4101-8101-010101010101")
      expect(deterministic.reads()).toBe(2)
    }).pipe(
      Effect.provideService(Crypto.Crypto, deterministic.crypto),
      Effect.provide(Layer.mergeAll(layer(), TestClock.layer()))
    )
  })
})
