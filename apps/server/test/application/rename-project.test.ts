import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventStoreLayer } from "@yodea/server/db/event-store"
import { EventBusLayer } from "@yodea/server/application/event-bus"
import { ProjectProjectionLayer } from "@yodea/server/application/projections"
import { SnapshotStoreLayer } from "@yodea/server/db/snapshot-store"
import { ProjectUseCases, ProjectUseCasesLayer } from "@yodea/server/application/projects/use-cases"

const layer = () => {
  const sql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
  const store = EventStoreLayer.pipe(Layer.provide(sql))
  const snapshots = SnapshotStoreLayer.pipe(Layer.provide(sql))
  const projection = ProjectProjectionLayer.pipe(Layer.provide(store), Layer.provide(snapshots))
  return ProjectUseCasesLayer.pipe(
    Layer.provide(store),
    Layer.provide(EventBusLayer),
    Layer.provide(projection),
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunServices.layer)
  )
}
const run = <A, E>(eff: Effect.Effect<A, E, ProjectUseCases>) => Effect.runPromise(Effect.provide(eff, layer()))

describe("ProjectUseCases.renameProject", () => {
  it("renames a project and bumps updatedAt", async () => {
    const r = await run(Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("alpha", false)
      const renamed = yield* u.renameProject(project.id, "alpha-2")
      return { project, renamed }
    }))
    expect(r.renamed.id).toBe(r.project.id)
    expect(r.renamed.name).toBe("alpha-2")
  })

  it("fails ProjectNotFound for an unknown id", async () => {
    const exit = await run(Effect.gen(function* () {
      const u = yield* ProjectUseCases
      return yield* u.renameProject("00000000-0000-4000-8000-000000000001", "renamed").pipe(Effect.result)
    }))
    expect(exit._tag).toBe("Failure")
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  })

  it("fails ProjectNameConflict when the new name is taken by another live project", async () => {
    const exit = await run(Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const a = yield* u.createProject("alpha", false)
      yield* u.createProject("beta", false)
      return yield* u.renameProject(a.project.id, "beta").pipe(Effect.result)
    }))
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNameConflict")
  })

  it("allows renaming a project to its own current name (no self-conflict)", async () => {
    const r = await run(Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const a = yield* u.createProject("alpha", false)
      return yield* u.renameProject(a.project.id, "alpha")
    }))
    expect(r.name).toBe("alpha")
  })

  it("an archived project's name stays reserved -> ProjectNameConflict", async () => {
    const exit = await run(Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const archived = yield* u.createProject("archived-name", false)
      yield* u.archiveProject(archived.project.id)
      const live = yield* u.createProject("live-name", false)
      return yield* u.renameProject(live.project.id, "archived-name").pipe(Effect.result)
    }))
    expect((exit as { failure: { _tag: string; name: string } }).failure._tag).toBe("ProjectNameConflict")
    expect((exit as { failure: { _tag: string; name: string } }).failure.name).toBe("archived-name")
  })

  it("an archived project's directory stays reserved -> ProjectDirectoryConflict", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "yodea-arch-dir-"))
    try {
      const exit = await run(Effect.gen(function* () {
        const u = yield* ProjectUseCases
        const a = yield* u.createProject("archived-dir", false)
        yield* u.changeDirectory(a.project.id, tmp)
        yield* u.archiveProject(a.project.id)
        const live = yield* u.createProject("live-dir", false)
        return yield* u.changeDirectory(live.project.id, tmp).pipe(Effect.result)
      }))
      expect((exit as { failure: { _tag: string; directory: string } }).failure._tag).toBe("ProjectDirectoryConflict")
      expect((exit as { failure: { _tag: string; directory: string } }).failure.directory).toBe(tmp)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
