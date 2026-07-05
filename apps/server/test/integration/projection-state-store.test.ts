import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { ProjectionStateStore, ProjectionStateStoreLayer } from "@yodea/server/db/projection-state-store"

const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const TestLayer = ProjectionStateStoreLayer.pipe(Layer.provideMerge(TestSql))

const run = <A, E>(eff: Effect.Effect<A, E, ProjectionStateStore | SqlClient>) =>
  Effect.runPromise(Effect.provide(eff, TestLayer))

describe("ProjectionStateStore", () => {
  it("returns null when no row exists for the name", async () => {
    const r = await run(Effect.flatMap(ProjectionStateStore, (s) => s.load("projects")))
    expect(r).toBe(null)
  })

  it("round-trips a saved row (state, lastSeq, foldVersion)", async () => {
    const r = await run(
      Effect.gen(function* () {
        const s = yield* ProjectionStateStore
        yield* s.save("projects", { state: "[]", lastSeq: 7, foldVersion: "v1" })
        return yield* s.load("projects")
      })
    )
    expect(r).toEqual({ state: "[]", lastSeq: 7, foldVersion: "v1" })
  })

  it("save upserts — latest row wins per name", async () => {
    const r = await run(
      Effect.gen(function* () {
        const s = yield* ProjectionStateStore
        yield* s.save("projects", { state: "[1]", lastSeq: 1, foldVersion: "v1" })
        yield* s.save("projects", { state: "[1,2]", lastSeq: 2, foldVersion: "v1" })
        return yield* s.load("projects")
      })
    )
    expect(r?.lastSeq).toBe(2)
    expect(r?.state).toBe("[1,2]")
  })

  it("rows are independent per name", async () => {
    const r = await run(
      Effect.gen(function* () {
        const s = yield* ProjectionStateStore
        yield* s.save("projects", { state: "[]", lastSeq: 3, foldVersion: "v1" })
        yield* s.save("other", { state: "{}", lastSeq: 9, foldVersion: "v9" })
        return { projects: yield* s.load("projects"), other: yield* s.load("other") }
      })
    )
    expect(r.projects?.lastSeq).toBe(3)
    expect(r.other?.lastSeq).toBe(9)
  })

  it("treats a NULL state column as absent (checkpoint-only rows are a future flavor)", async () => {
    const r = await run(
      Effect.gen(function* () {
        const s = yield* ProjectionStateStore
        const sql = yield* SqlClient
        yield* sql`INSERT INTO projection_state ${sql.insert({ name: "projects", state: null, last_seq: 4, fold_version: "v1" })}`
        return yield* s.load("projects")
      })
    )
    expect(r).toBe(null)
  })

  it("drops the legacy snapshot table at build (disposable cache, D7)", async () => {
    const r = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        return yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='snapshot'`
      })
    )
    expect(r[0]?.n).toBe(0)
  })
})
