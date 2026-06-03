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
  return UseCasesLayer.pipe(
    Layer.provide(store),
    Layer.provide(EventBusLayer),
    Layer.provide(projection),
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunServices.layer)
  )
}
const run = <A, E>(eff: Effect.Effect<A, E, UseCases>) => Effect.runPromise(Effect.provide(eff, layer()))

describe("UseCases.createProject", () => {
  it("creates a new project with created:true", async () => {
    const r = await run(Effect.flatMap(UseCases, (u) => u.createProject("alpha", false)))
    expect(r.created).toBe(true)
    expect(r.project.name).toBe("alpha")
  })

  it("rejects a duplicate name (strict) with ProjectAlreadyExists", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const u = yield* UseCases
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
        const u = yield* UseCases
        const first = yield* u.createProject("ens", false)
        const second = yield* u.createProject("ens", true)
        return { first, second }
      })
    )
    expect(r.second.created).toBe(false)
    expect(r.second.project.id).toBe(r.first.project.id)
  })
})
