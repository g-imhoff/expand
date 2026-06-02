import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { EventStoreLayer } from "@yodea/db/event-store"
import { EventBusLayer } from "@yodea/application/event-bus"
import { ProjectProjectionLayer } from "@yodea/application/projections"
import { UseCases, UseCasesLayer } from "@yodea/application/use-cases"

const layer = () => {
  const sql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
  const store = EventStoreLayer.pipe(Layer.provide(sql))
  const projection = ProjectProjectionLayer.pipe(Layer.provide(store))
  // UseCases.make yields FileSystem+Path (for changeDirectory); supply them.
  return UseCasesLayer.pipe(
    Layer.provide(store),
    Layer.provide(EventBusLayer),
    Layer.provide(projection),
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunServices.layer)
  )
}
const run = <A, E>(eff: Effect.Effect<A, E, UseCases>) => Effect.runPromise(Effect.provide(eff, layer()))

describe("UseCases.renameProject", () => {
  it("renames a project and bumps updatedAt", async () => {
    const r = await run(Effect.gen(function* () {
      const u = yield* UseCases
      const { project } = yield* u.createProject("alpha", false)
      const renamed = yield* u.renameProject(project.id, "alpha-2")
      return { project, renamed }
    }))
    expect(r.renamed.id).toBe(r.project.id)
    expect(r.renamed.name).toBe("alpha-2")
  })

  it("fails ProjectNotFound for an unknown id", async () => {
    const exit = await run(Effect.gen(function* () {
      const u = yield* UseCases
      return yield* u.renameProject("missing", "whatever").pipe(Effect.result)
    }))
    expect(exit._tag).toBe("Failure")
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  })

  it("fails ProjectNameConflict when the new name is taken by another live project", async () => {
    const exit = await run(Effect.gen(function* () {
      const u = yield* UseCases
      const a = yield* u.createProject("alpha", false)
      yield* u.createProject("beta", false)
      return yield* u.renameProject(a.project.id, "beta").pipe(Effect.result)
    }))
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNameConflict")
  })

  it("allows renaming a project to its own current name (no self-conflict)", async () => {
    const r = await run(Effect.gen(function* () {
      const u = yield* UseCases
      const a = yield* u.createProject("alpha", false)
      return yield* u.renameProject(a.project.id, "alpha")
    }))
    expect(r.name).toBe("alpha")
  })
})
