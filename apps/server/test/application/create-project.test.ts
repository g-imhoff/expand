import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { EventBusLayer } from "@expand/server/application/event-bus"
import { ProjectProjectionLayer } from "@expand/server/application/projections"
import { ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { ProjectUseCases, ProjectUseCasesLayer } from "@expand/server/application/projects/use-cases"

const layer = () => {
  const sql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
  const projectEvents = ProjectEventStoreLayer.pipe(Layer.provide(sql))
  const states = ProjectionStateStoreLayer.pipe(Layer.provide(sql))
  const projection = ProjectProjectionLayer.pipe(Layer.provide(projectEvents), Layer.provide(states))
  return ProjectUseCasesLayer.pipe(
    Layer.provide(projectEvents),
    Layer.provide(EventBusLayer),
    Layer.provide(projection),
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunServices.layer)
  )
}
const run = <A, E>(eff: Effect.Effect<A, E, ProjectUseCases>) => Effect.runPromise(Effect.provide(eff, layer()))

describe("ProjectUseCases.createProject", () => {
  it("creates a new project with created:true", async () => {
    const r = await run(Effect.flatMap(ProjectUseCases, (u) => u.createProject("alpha", false)))
    expect(r.created).toBe(true)
    expect(r.project.name).toBe("alpha")
  })

  it("rejects a duplicate name (strict) with ProjectAlreadyExists", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const u = yield* ProjectUseCases
        yield* u.createProject("dup", false)
        return yield* u.createProject("dup", false).pipe(Effect.result)
      })
    )
    expect(exit._tag).toBe("Failure")
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectAlreadyExists")
  })

  it("--ensure returns the existing project with created:false (same id)", async () => {
    const r = await run(
      Effect.gen(function* () {
        const u = yield* ProjectUseCases
        const first = yield* u.createProject("ens", false)
        const second = yield* u.createProject("ens", true)
        return { first, second }
      })
    )
    expect(r.second.created).toBe(false)
    expect(r.second.project.id).toBe(r.first.project.id)
  })
})
