import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Locks the production default: a file-backed client must run in WAL so the single
// writer's commits never block ProjectList readers. If someone passes disableWAL:true
// for the real DB, this fails.
describe("SQLite production config", () => {
  it("a file-backed client runs in WAL journal mode (matches composition/app.ts)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "expand-wal-"))
    const dbPath = join(dir, "events.db")
    const Sql = SqliteClient.layer({ filename: dbPath })
    const mode = await Effect.runPromise(
      Effect.flatMap(SqlClient, (sql) => sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`).pipe(
        Effect.map((rows) => rows[0]?.journal_mode),
        Effect.provide(Sql)
      )
    )
    rmSync(dir, { recursive: true, force: true })
    expect(mode).toBe("wal")
  })
})
