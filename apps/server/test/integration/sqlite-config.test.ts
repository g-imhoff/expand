import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, FileSystem, Path } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"

// Locks the production default: a file-backed client must run in WAL so the single
// writer's commits never block ProjectList readers. If someone passes disableWAL:true
// for the real DB, this fails.
describe("SQLite production config", () => {
  it.live("a file-backed client runs in WAL journal mode (matches composition/app.ts)",  () => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-wal-" })
    const dbPath = path.join(dir, "events.db")
    const Sql = SqliteClient.layer({ filename: dbPath })
    const mode = yield* (Effect.flatMap(SqlClient, (sql) => sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`).pipe(
        Effect.map((rows) => rows[0]?.journal_mode),
        Effect.provide(Sql)
      ))
    expect(mode).toBe("wal")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
