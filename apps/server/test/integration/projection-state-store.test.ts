import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { ProjectionStateStore, ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"

const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const TestLayer = ProjectionStateStoreLayer.pipe(Layer.provideMerge(TestSql))

const run = <A, E>(eff: Effect.Effect<A, E, ProjectionStateStore | SqlClient>) =>
  Effect.provide(eff, TestLayer)

describe("ProjectionStateStore", () => {
  it.live("returns null when no row exists for the name",  () => Effect.gen(function*() {
    const r = yield* run(Effect.flatMap(ProjectionStateStore, (s) => s.load("projects")))
    expect(r).toBe(null)
  }))

  it.live("round-trips a saved row (state, lastSeq, foldVersion)",  () => Effect.gen(function*() {
    const r = yield* run(
      Effect.gen(function* () {
        const s = yield* ProjectionStateStore
        yield* s.save("projects", { state: "[]", lastSeq: 7, foldVersion: "v1" })
        return yield* s.load("projects")
      })
    )
    expect(r).toEqual({ state: "[]", lastSeq: 7, foldVersion: "v1" })
  }))

  it.live("save upserts — latest row wins per name",  () => Effect.gen(function*() {
    const r = yield* run(
      Effect.gen(function* () {
        const s = yield* ProjectionStateStore
        yield* s.save("projects", { state: "[1]", lastSeq: 1, foldVersion: "v1" })
        yield* s.save("projects", { state: "[1,2]", lastSeq: 2, foldVersion: "v1" })
        return yield* s.load("projects")
      })
    )
    expect(r?.lastSeq).toBe(2)
    expect(r?.state).toBe("[1,2]")
  }))

  it.live("rows are independent per name",  () => Effect.gen(function*() {
    const r = yield* run(
      Effect.gen(function* () {
        const s = yield* ProjectionStateStore
        yield* s.save("projects", { state: "[]", lastSeq: 3, foldVersion: "v1" })
        yield* s.save("other", { state: "{}", lastSeq: 9, foldVersion: "v9" })
        return { projects: yield* s.load("projects"), other: yield* s.load("other") }
      })
    )
    expect(r.projects?.lastSeq).toBe(3)
    expect(r.other?.lastSeq).toBe(9)
  }))

  it.live("treats a NULL state column as absent (checkpoint-only rows are a future flavor)",  () => Effect.gen(function*() {
    const r = yield* run(
      Effect.gen(function* () {
        const s = yield* ProjectionStateStore
        const sql = yield* SqlClient
        yield* sql`INSERT INTO projection_state ${sql.insert({ name: "projects", state: null, last_seq: 4, fold_version: "v1" })}`
        return yield* s.load("projects")
      })
    )
    expect(r).toBe(null)
  }))
})
