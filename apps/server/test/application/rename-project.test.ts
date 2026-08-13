import { it } from "@effect/vitest"
import { Crypto, Effect, FileSystem, Layer } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeServices } from "@effect/platform-node"
import { EventBusLayer } from "@expand/server/application/event-bus"
import { ProjectProjectionLayer } from "@expand/server/application/projections"
import { ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { ProjectUseCases, ProjectUseCasesLayer } from "@expand/server/application/projects/use-cases"
import { DatabaseReadyLayer } from "@expand/server/migrations/sqlite"

const layer = () => {
  const sql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
  const database = DatabaseReadyLayer.pipe(Layer.provideMerge(sql))
  const projectEvents = ProjectEventStoreLayer.pipe(Layer.provide(database))
  const states = ProjectionStateStoreLayer.pipe(Layer.provide(database))
  const projection = ProjectProjectionLayer.pipe(Layer.provide(projectEvents), Layer.provide(states))
  const useCases = ProjectUseCasesLayer.pipe(
    Layer.provide(projectEvents),
    Layer.provide(EventBusLayer),
    Layer.provide(projection)
  )
  return useCases.pipe(Layer.provideMerge(NodeServices.layer))
}

describe("ProjectUseCases.renameProject", () => {
  it.live("renames a project using the later injected clock instant", () => {
    const crypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: (_algorithm, data) => Effect.succeed(data)
    })
    return Effect.gen(function*() {
      yield* TestClock.setTime(1_735_689_600_000)
      const useCases = yield* ProjectUseCases
      const { project } = yield* useCases.createProject("alpha", false)
      yield* TestClock.setTime(1_735_693_200_000)
      const renamed = yield* useCases.renameProject(project.id, "alpha-2")
      expect(renamed.id).toBe(project.id)
      expect(renamed.name).toBe("alpha-2")
      expect(renamed.createdAt).toBe("2025-01-01T00:00:00.000Z")
      expect(renamed.updatedAt).toBe("2025-01-01T01:00:00.000Z")
    }).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provide(Layer.mergeAll(layer(), TestClock.layer()))
    )
  })

  it.effect("fails ProjectNotFound for an unknown id", () =>
    Effect.gen(function*() {
      const useCases = yield* ProjectUseCases
      const result = yield* useCases.renameProject("00000000-0000-4000-8000-000000000001", "renamed").pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect((result as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
    }).pipe(Effect.provide(layer())))

  it.effect("fails ProjectNameConflict when the new name is taken by another live project", () =>
    Effect.gen(function*() {
      const useCases = yield* ProjectUseCases
      const alpha = yield* useCases.createProject("alpha", false)
      yield* useCases.createProject("beta", false)
      const result = yield* useCases.renameProject(alpha.project.id, "beta").pipe(Effect.result)
      expect((result as { failure: { _tag: string } }).failure._tag).toBe("ProjectNameConflict")
    }).pipe(Effect.provide(layer())))

  it.effect("allows renaming a project to its own current name (no self-conflict)", () =>
    Effect.gen(function*() {
      const useCases = yield* ProjectUseCases
      const alpha = yield* useCases.createProject("alpha", false)
      const renamed = yield* useCases.renameProject(alpha.project.id, "alpha")
      expect(renamed.name).toBe("alpha")
    }).pipe(Effect.provide(layer())))

  it.effect("an archived project's name stays reserved -> ProjectNameConflict", () =>
    Effect.gen(function*() {
      const useCases = yield* ProjectUseCases
      const archived = yield* useCases.createProject("archived-name", false)
      yield* useCases.archiveProject(archived.project.id)
      const live = yield* useCases.createProject("live-name", false)
      const result = yield* useCases.renameProject(live.project.id, "archived-name").pipe(Effect.result)
      const failure = (result as { failure: { _tag: string; name: string } }).failure
      expect(failure._tag).toBe("ProjectNameConflict")
      expect(failure.name).toBe("archived-name")
    }).pipe(Effect.provide(layer())))

  it.effect("an archived project's directory stays reserved -> ProjectDirectoryConflict", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "expand-arch-dir-" })
      const useCases = yield* ProjectUseCases
      const archived = yield* useCases.createProject("archived-dir", false)
      yield* useCases.changeDirectory(archived.project.id, directory)
      yield* useCases.archiveProject(archived.project.id)
      const live = yield* useCases.createProject("live-dir", false)
      const result = yield* useCases.changeDirectory(live.project.id, directory).pipe(Effect.result)
      const failure = (result as { failure: { _tag: string; directory: string } }).failure
      expect(failure._tag).toBe("ProjectDirectoryConflict")
      expect(failure.directory).toBe(directory)
    }).pipe(Effect.provide(layer())))
})
