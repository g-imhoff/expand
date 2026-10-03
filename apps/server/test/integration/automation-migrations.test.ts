import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { Migrator } from "effect/sql"
import { DATABASE_MIGRATIONS, migrateDatabase } from "../../migrations/sqlite.js"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const tables = ["integrations", "routines", "routine_revisions", "deliveries", "jobs", "runs", "job_attempts", "decision_attempts", "action_attempts"].map((name) => `automation_${name}`)

describe("automation migrations", () => {
  it.live("adds nine STRICT scoped tables and ledger 2 through native readiness", () => Effect.gen(function* () {
    const sql = yield* SqlClient
    const actual = yield* sql<{ name: string; strict: number }>`SELECT name, strict FROM pragma_table_list WHERE name LIKE 'automation_%'`
    const ledger = yield* sql<{ migration_id: number }>`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`
    expect.soft(actual.map((row) => row.name).sort()).toEqual([...tables].sort())
    expect.soft(actual.every((row) => row.strict === 1)).toBe(true)
    expect.soft(ledger.map((row) => row.migration_id)).toEqual([1, 2])
  }).pipe(Effect.provide(Ready)))
  it.live("rolls back partial later DDL and retries migration 2", () => Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "automation-ddl-"))
    const filename = join(dir, "database.sqlite")
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* Migrator.make({})({ loader: Migrator.fromRecord({ "1_initial": DATABASE_MIGRATIONS["1_initial"] }) })
      yield* sql`CREATE TABLE automation_runs (sentinel TEXT) STRICT`
      const exit = yield* Effect.exit(migrateDatabase)
      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* sql`SELECT name FROM sqlite_master WHERE name IN ('automation_integrations','automation_jobs')`)).toEqual([])
      expect((yield* sql`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`)).toEqual([{ migration_id: 1 }])
    }).pipe(Effect.provide(SqliteClient.layer({ filename })))
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`DROP TABLE automation_runs`
      yield* migrateDatabase
      expect((yield* sql`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`)).toEqual([{ migration_id: 1 }, { migration_id: 2 }])
    }).pipe(Effect.provide(SqliteClient.layer({ filename })))
  }))
})

describe("automation SQL constraints", () => {
  it.live("enforces scope-local uniqueness, FK links, valid modes/versions and STRICT storage", () => Effect.gen(function* () {
    const sql = yield* SqlClient
    const integration = { owner_id: "owner", project_id: "project", id: "mail", definition_id: "sample:mail", definition_version: 1, version: 1, json: "{}" }
    yield* sql`INSERT INTO automation_integrations ${sql.insert(integration)}`
    expect(Exit.isFailure(yield* Effect.exit(sql`INSERT INTO automation_integrations ${sql.insert(integration)}`))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(sql`INSERT INTO automation_integrations ${sql.insert({ ...integration, id: "bad-version", version: 0 })}`))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(sql`INSERT INTO automation_integrations ${sql.insert({ ...integration, id: "bad-json", json: "not JSON" })}`))).toBe(true)
    yield* sql`INSERT INTO automation_integrations ${sql.insert({ ...integration, owner_id: "other" })}`
    expect(Exit.isFailure(yield* Effect.exit(sql`INSERT INTO automation_deliveries ${sql.insert({ owner_id: "third", project_id: "project", id: "input", integration_id: "mail", external_id: "external", raw: new Uint8Array([1]), json: "{}" })}`))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(sql`INSERT INTO automation_deliveries ${sql.insert({ owner_id: "owner", project_id: "project", id: "input", integration_id: "mail", external_id: "external", raw: "wrong BLOB", json: "{}" })}`))).toBe(true)
    expect(yield* sql`SELECT count(*) n FROM automation_deliveries`).toEqual([{ n: 0 }])
  }).pipe(Effect.provide(Ready)))
})
