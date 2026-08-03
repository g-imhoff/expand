import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Cause, Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import {
  DatabaseReadyLayer,
  DatabaseVersionError,
  migrateDatabase
} from "@expand/server/migrations/sqlite"

const Sql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(Sql))

describe("database migrations", () => {
  it.live("creates the canonical schema and records migration 1", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const eventColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(events)`
      const migrations = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id
      `
      expect(eventColumns.map((column) => column.name)).toContain("event_revision")
      expect(migrations.map((migration) => migration.migration_id)).toEqual([1])
    }).pipe(Effect.provide(Ready)))

  it.live("upgrades legacy tables without changing stored bytes and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const payload = '{"_tag":"ProjectCreated","projectId":"p1","name":"alpha","occurredAt":"t1"}'
      const state = '[{"id":"p1","name":"alpha"}]'
      yield* sql`
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          stream_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT
      `
      yield* sql`
        CREATE TABLE projection_state (
          name TEXT PRIMARY KEY,
          state TEXT,
          last_seq INTEGER NOT NULL,
          fold_version TEXT NOT NULL
        ) STRICT
      `
      yield* sql`INSERT INTO events ${sql.insert({
        seq: 1,
        stream_id: "p1",
        event_type: "ProjectCreated",
        payload,
        created_at: "t1"
      })}`
      yield* sql`INSERT INTO projection_state ${sql.insert({
        name: "projects",
        state,
        last_seq: 1,
        fold_version: "v1"
      })}`

      yield* migrateDatabase
      yield* migrateDatabase

      const events = yield* sql<{
        readonly payload: string
        readonly event_revision: number
      }>`SELECT payload, event_revision FROM events`
      const projections = yield* sql<{ readonly state: string }>`SELECT state FROM projection_state`
      const migrations = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id
      `
      expect(events).toEqual([{ payload, event_revision: 1 }])
      expect(projections).toEqual([{ state }])
      expect(migrations.map((migration) => migration.migration_id)).toEqual([1])
    }).pipe(Effect.provide(Sql)))

  it.live("rolls back migration 1 when its transaction cannot complete", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          payload TEXT NOT NULL
        ) STRICT
      `

      const exit = yield* Effect.exit(migrateDatabase)
      const migrations = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 1
      `
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(events)`
      expect(Exit.isFailure(exit)).toBe(true)
      expect(migrations).toEqual([])
      expect(columns.map((column) => column.name)).not.toContain("event_revision")
    }).pipe(Effect.provide(Sql)))

  it.live("rejects a database ledger newer than this server", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* migrateDatabase
      yield* sql`INSERT INTO effect_sql_migrations ${sql.insert({ migration_id: 2, name: "future" })}`

      const exit = yield* Effect.exit(migrateDatabase)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(DatabaseVersionError)
        expect(error).toMatchObject({ current: 1, found: 2 })
      }
    }).pipe(Effect.provide(Sql)))
})
