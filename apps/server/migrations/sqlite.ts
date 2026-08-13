import { Context, Data, Effect, Layer } from "effect"
import { Migrator, SqlClient } from "effect/unstable/sql"
import type { MigrationError } from "effect/unstable/sql/Migrator"
import type { SqlError } from "effect/unstable/sql/SqlError"

export class DatabaseVersionError extends Data.TaggedError("DatabaseVersionError")<{
  readonly current: number
  readonly found: number
}> {}

export class DatabaseReady extends Context.Service<DatabaseReady, {
  readonly ready: true
}>()("expand/DatabaseReady") {}

export const CURRENT_DATABASE_MIGRATION = 1

export const DATABASE_MIGRATIONS = {
  "1_initial": Effect.gen(initialMigration)
} as const

export const migrateDatabase: Effect.Effect<
  void,
  MigrationError | SqlError | DatabaseVersionError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* Migrator.make({})({ loader: Migrator.fromRecord(DATABASE_MIGRATIONS) })
  const rows = yield* sql<{ readonly found: number | null }>`
    SELECT MAX(migration_id) AS found FROM effect_sql_migrations
  `
  const found = rows[0]?.found ?? 0
  if (found > CURRENT_DATABASE_MIGRATION) {
    return yield* new DatabaseVersionError({ current: CURRENT_DATABASE_MIGRATION, found })
  }
})

export const DatabaseReadyLayer = Layer.effect(
  DatabaseReady,
  migrateDatabase.pipe(Effect.as({ ready: true as const }))
)

function* initialMigration() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_revision INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT
  `
  yield* sql`CREATE INDEX IF NOT EXISTS idx_events_stream ON events (stream_id, seq)`
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_state (
      name TEXT PRIMARY KEY,
      state TEXT,
      last_seq INTEGER NOT NULL,
      fold_version TEXT NOT NULL
    ) STRICT
  `
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(events)`
  if (!columns.some((column) => column.name === "event_revision")) {
    yield* sql`ALTER TABLE events ADD COLUMN event_revision INTEGER NOT NULL DEFAULT 1`
  }
}
