import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Cause, Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { StorageError } from "../../automation/persistence-models.js"
import { configuration, integration, scope } from "../fixtures/automation-persistence-fixture.js"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Repositories = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))

describe("configuration repository", () => {
  it.live("persists exact integration and immutable revision through native SQL", () => Effect.gen(function* () {
    const repository = yield* ConfigurationRepository
    const sql = yield* SqlClient
    const integrationExit = yield* Effect.exit(repository.putIntegration(scope, integration, 0))
    const revisionExit = yield* Effect.exit(repository.appendRoutineRevision(configuration, 0, "enabled"))
    const integrations = yield* sql<{ json: string }>`SELECT json FROM automation_integrations`
    const revisions = yield* sql<{ json: string }>`SELECT json FROM automation_routine_revisions`
    expect.soft(Exit.isSuccess(integrationExit)).toBe(true)
    expect.soft(Exit.isSuccess(revisionExit)).toBe(true)
    expect.soft(integrations.map((row) => JSON.parse(row.json))).toEqual([integration])
    expect.soft(revisions.map((row) => JSON.parse(row.json))).toEqual([configuration])
  }).pipe(Effect.provide(Repositories)))
})

describe("configuration invariants", () => {
  it.live("preserves old snapshots and exact replay through edits, pause, tombstone and scope-local IDs", () => Effect.gen(function* () {
    const repository = yield* ConfigurationRepository
    yield* repository.putIntegration(scope, integration, 0); yield* repository.appendRoutineRevision(configuration, 0, "enabled")
    yield* repository.putIntegration(scope, { ...integration, configuration: { mailbox: "edited" } }, 1)
    const revision2 = { ...configuration, reference: { ...configuration.reference, revision: 2 }, configuration: { edited: true } }
    yield* repository.appendRoutineRevision(revision2, 1, "paused")
    yield* repository.setStatus(scope, "routine", "deleted", 2)
    yield* repository.appendRoutineRevision(configuration, 0, "enabled")
    expect(yield* repository.getHead(scope, "routine")).toEqual({ revision: 2, status: "deleted", version: 3 })
    expect(yield* repository.getRevision(scope, "routine", 1)).toEqual(configuration)
    for (const other of [{ ...scope, ownerId: "other" }, { ...scope, projectId: "other" }]) {
      expect(yield* repository.getRevision(other, "routine", 1)).toBeNull()
      yield* repository.putIntegration(other, integration, 0); yield* repository.appendRoutineRevision({ ...configuration, scope: other }, 0, "enabled")
      expect((yield* repository.getRevision(other, "routine", 1))?.scope).toEqual(other)
    }
  }).pipe(Effect.provide(Repositories)))
  it.live("rejects immutable changes, stale CAS and missing/wrong-definition integration references without writes", () => Effect.gen(function* () {
    const repository = yield* ConfigurationRepository; const sql = yield* SqlClient
    yield* repository.putIntegration(scope, integration, 0); yield* repository.appendRoutineRevision(configuration, 0, "enabled")
    for (const invalid of [
      { ...configuration, configuration: { changed: true } },
      { ...configuration, reference: { ...configuration.reference, revision: 3 } },
      { ...configuration, reference: { ...configuration.reference, revision: 2 }, scope: { ...scope, ownerId: "missing" } },
      { ...configuration, reference: { ...configuration.reference, revision: 2 }, integrations: [{ ...integration, definition: { ...integration.definition, version: 2 } }], process: { ...configuration.process, trigger: { ...configuration.process.trigger, integration: { id: integration.id, definition: { ...integration.definition, version: 2 } } } } }
    ]) expect(Exit.isFailure(yield* Effect.exit(repository.appendRoutineRevision(invalid, 1, "enabled")))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(repository.putIntegration(scope, { ...integration, definition: { ...integration.definition, version: 2 } }, 1)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(repository.putIntegration(scope, { ...integration, configuration: { changed: true } }, 0)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(repository.setStatus(scope, "routine", "paused", 2)))).toBe(true)
    expect(yield* repository.getHead(scope, "routine")).toEqual({ revision: 1, status: "enabled", version: 1 })
    expect(yield* sql`SELECT count(*) n FROM automation_routine_revisions`).toEqual([{ n: 1 }])
  }).pipe(Effect.provide(Repositories)))
})

describe("configuration commit error", () => {
  it.live("reports a real deferred-FK commit failure as typed storage uncertainty", () => Effect.gen(function* () {
    const sql = yield* SqlClient
    const controlledSql = new Proxy(sql, { get(target, key) {
      if (key !== "withTransaction") return Reflect.get(target, key)
      return <A, E, R>(effect: Effect.Effect<A, E, R>) => target.withTransaction(effect.pipe(Effect.tap(() => sql`INSERT INTO automation_routines ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, id: "commit-probe", head_revision: 99, status: "enabled", version: 1 })}`)))
    } })
    const repository = yield* ConfigurationRepository.make.pipe(Effect.provideService(SqlClient, controlledSql))
    const exit = yield* Effect.exit(repository.putIntegration(scope, integration, 0))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect.soft(Cause.squash(exit.cause)).toBeInstanceOf(StorageError)
    expect(yield* sql`SELECT count(*) n FROM automation_integrations`).toEqual([{ n: 0 }])
  }).pipe(Effect.provide(Repositories)))
})
