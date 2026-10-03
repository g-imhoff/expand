import { Context, Effect, Layer } from "effect"
import { IntegrationConfiguration, LocalId, PersonalScope, PositiveVersion, RoutineConfiguration } from "@expand/contracts/automation"
import { SqlClient } from "effect/sql/SqlClient"
import { DatabaseReady } from "../migrations/sqlite.js"
import { encodeJson, decode, guard, readJson, RoutineStatus, same, protectStorage, StorageError, validateConfiguration } from "./persistence-models.js"

export interface RoutineHead { readonly revision: number; readonly version: number; readonly status: RoutineStatus }
export interface ListedRoutine { readonly routineId: string; readonly head: RoutineHead }

export class ConfigurationRepository extends Context.Service<ConfigurationRepository, {
  readonly putIntegration: (scope: PersonalScope, input: IntegrationConfiguration, expectedVersion: number) => Effect.Effect<number, StorageError>
  readonly appendRoutineRevision: (input: RoutineConfiguration, expectedRevision: number, status: RoutineStatus) => Effect.Effect<number, StorageError>
  readonly getIntegration: (scope: PersonalScope, id: string) => Effect.Effect<{ configuration: IntegrationConfiguration; version: number } | null, StorageError>
  readonly getRevision: (scope: PersonalScope, routineId: string, revision: number) => Effect.Effect<RoutineConfiguration | null, StorageError>
  readonly getHead: (scope: PersonalScope, routineId: string) => Effect.Effect<RoutineHead | null, StorageError>
  readonly listHeads: (scope: PersonalScope) => Effect.Effect<ReadonlyArray<ListedRoutine>, StorageError>
  readonly setStatus: (scope: PersonalScope, routineId: string, status: RoutineStatus, expectedVersion: number) => Effect.Effect<RoutineHead, StorageError>
}>()("expand/ConfigurationRepository", {
  make: Effect.gen(function* () {
    yield* DatabaseReady
    const sql = yield* SqlClient
    const getIntegration = Effect.fn("Configuration.getIntegration")(function*(scope: PersonalScope, id: string) {
      yield* decode(PersonalScope, scope); yield* decode(LocalId, id)
      const rows = yield* sql<IntegrationRow>`SELECT * FROM automation_integrations WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${id}`
      if (!rows[0]) return null
      const row = rows[0]; const configuration = yield* readJson(IntegrationConfiguration, row.json)
      yield* guard(configuration.id === id && configuration.definition.id === row.definition_id && configuration.definition.version === row.definition_version && Number.isSafeInteger(row.version) && row.version > 0)
      return { configuration, version: row.version }
    })
    const getRevision = Effect.fn("Configuration.getRevision")(function*(scope: PersonalScope, routineId: string, revision: number) {
      yield* decode(PersonalScope, scope); yield* decode(LocalId, routineId); yield* decode(PositiveVersion, revision)
      const rows = yield* sql<RevisionRow>`SELECT * FROM automation_routine_revisions WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND routine_id=${routineId} AND revision=${revision}`
      if (!rows[0]) return null
      const configuration = yield* readJson(RoutineConfiguration, rows[0].json).pipe(Effect.flatMap(validateConfiguration))
      yield* guard(same(configuration.scope, scope) && configuration.reference.routineId === routineId && configuration.reference.revision === revision)
      return configuration
    })
    const getHead = Effect.fn("Configuration.getHead")(function*(scope: PersonalScope, routineId: string) {
      yield* decode(PersonalScope, scope); yield* decode(LocalId, routineId)
      const rows = yield* sql<{ head_revision: number; version: number; status: string }>`SELECT head_revision, version, status FROM automation_routines WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${routineId}`
      if (!rows[0]) return null
      const row = rows[0]; const status = yield* decode(RoutineStatus, row.status)
      yield* decode(PositiveVersion, row.version); yield* decode(PositiveVersion, row.head_revision)
      return { revision: row.head_revision, version: row.version, status }
    })
    const putIntegration = (scope: PersonalScope, input: IntegrationConfiguration, expectedVersion: number) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      yield* decode(PersonalScope, scope); const value = yield* decode(IntegrationConfiguration, input)
      yield* guard(Number.isSafeInteger(expectedVersion) && expectedVersion >= 0)
      const existing = yield* getIntegration(scope, value.id)
      if (existing) {
        yield* guard(same(existing.configuration.definition, value.definition), "conflict")
        if (same(existing.configuration, value)) return existing.version
        yield* guard(existing.version === expectedVersion, "conflict")
        const updated = yield* sql<{ version: number }>`UPDATE automation_integrations SET json=${encodeJson(value)}, version=version+1 WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${value.id} AND version=${expectedVersion} RETURNING version`
        yield* guard(updated.length > 0, "conflict")
        return expectedVersion + 1
      }
      yield* guard(expectedVersion === 0, "conflict")
      yield* sql`INSERT INTO automation_integrations ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, id: value.id, definition_id: value.definition.id, definition_version: value.definition.version, version: 1, json: encodeJson(value) })}`
      return 1
    })))
    const appendRoutineRevision = (input: RoutineConfiguration, expectedRevision: number, status: RoutineStatus) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      const config = yield* validateConfiguration(input); yield* decode(RoutineStatus, status)
      yield* guard(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0)
      const { scope, reference } = config
      const existing = yield* getRevision(scope, reference.routineId, reference.revision)
      if (existing) { yield* guard(same(existing, config), "conflict"); return reference.revision }
      const head = yield* getHead(scope, reference.routineId)
      yield* guard((head?.revision ?? 0) === expectedRevision && reference.revision === expectedRevision + 1, "conflict")
      for (const integration of config.integrations) {
        const stored = yield* getIntegration(scope, integration.id)
        yield* guard(stored !== null && same(stored.configuration.definition, integration.definition), "missing")
      }
      if (head) { const moved = yield* sql<{ head_revision: number }>`UPDATE automation_routines SET head_revision=${reference.revision}, status=${status}, version=version+1 WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${reference.routineId} AND head_revision=${expectedRevision} RETURNING head_revision`; yield* guard(moved.length > 0, "conflict") }
      else yield* sql`INSERT INTO automation_routines ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, id: reference.routineId, head_revision: reference.revision, status, version: 1 })}`
      yield* sql`INSERT INTO automation_routine_revisions ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, routine_id: reference.routineId, revision: reference.revision, json: encodeJson(config) })}`
      return reference.revision
    })))
    const setStatus = (scope: PersonalScope, routineId: string, status: RoutineStatus, expectedVersion: number) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      yield* decode(RoutineStatus, status); yield* decode(PositiveVersion, expectedVersion)
      const head = yield* getHead(scope, routineId)
      yield* guard(head !== null, "missing")
      yield* guard(head!.version === expectedVersion, "conflict")
      const touched = yield* sql<{ version: number }>`UPDATE automation_routines SET status=${status}, version=version+1 WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${routineId} AND version=${expectedVersion} RETURNING version`
      yield* guard(touched.length > 0, "conflict")
      return { revision: head!.revision, status, version: expectedVersion + 1 }
    })))
    const listHeads = Effect.fn("Configuration.listHeads")(function*(scope: PersonalScope) {
      yield* decode(PersonalScope, scope)
      const rows = yield* sql<{ id: string; head_revision: number; version: number; status: string }>`SELECT id, head_revision, version, status FROM automation_routines WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} ORDER BY id`
      const heads: Array<ListedRoutine> = []
      for (const row of rows) {
        const status = yield* decode(RoutineStatus, row.status)
        yield* decode(LocalId, row.id)
        yield* decode(PositiveVersion, row.version); yield* decode(PositiveVersion, row.head_revision)
        heads.push({ routineId: row.id, head: { revision: row.head_revision, version: row.version, status } })
      }
      return heads as ReadonlyArray<ListedRoutine>
    })
    return { putIntegration, appendRoutineRevision, setStatus, listHeads: (scope) => protectStorage(listHeads(scope)), getIntegration: (scope, id) => protectStorage(getIntegration(scope, id)), getRevision: (scope, id, revision) => protectStorage(getRevision(scope, id, revision)), getHead: (scope, id) => protectStorage(getHead(scope, id)) }
  })
}) {}
export const ConfigurationRepositoryLayer = Layer.effect(ConfigurationRepository, ConfigurationRepository.make)

interface IntegrationRow { readonly json: string; readonly id: string; readonly definition_id: string; readonly definition_version: number; readonly version: number }
interface RevisionRow { readonly json: string; readonly routine_id: string; readonly revision: number }
