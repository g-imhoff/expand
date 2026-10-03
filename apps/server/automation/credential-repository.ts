import { Context, Effect, Layer, Schema } from "effect"
import { CredentialReference, IntegrationConfiguration, JsonValue, LocalId, PersonalScope, PositiveVersion } from "@expand/contracts/automation"
import { SqlClient } from "effect/sql/SqlClient"
import { DatabaseReady } from "../migrations/sqlite.js"
import { CredentialStatus, StoredCredential, decode, encodeJson, guard, protectStorage, readJson, same, StorageError } from "./persistence-models.js"

export class CredentialRepository extends Context.Service<CredentialRepository, {
  readonly putCredential: (scope: PersonalScope, credentialId: string, secret: unknown, expectedVersion: number) => Effect.Effect<number, StorageError>
  readonly removeCredential: (scope: PersonalScope, credentialId: string, expectedVersion: number) => Effect.Effect<void, StorageError>
  readonly status: (scope: PersonalScope, credentialId: string) => Effect.Effect<CredentialStatus | null, StorageError>
  readonly list: (scope: PersonalScope) => Effect.Effect<ReadonlyArray<CredentialStatus>, StorageError>
  readonly resolveSecret: (scope: PersonalScope, credentialId: string) => Effect.Effect<Schema.Json, StorageError>
  readonly resolveReferences: (scope: PersonalScope, references: Record<string, CredentialReference>) => Effect.Effect<Record<string, Schema.Json>, StorageError>
  readonly resolveIntegrationCredentials: (scope: PersonalScope, integration: IntegrationConfiguration) => Effect.Effect<Record<string, Schema.Json>, StorageError>
}>()("expand/CredentialRepository", {
  make: Effect.gen(function* () {
    yield* DatabaseReady
    const sql = yield* SqlClient
    const readRow = Effect.fn("Credentials.readRow")(function*(scope: PersonalScope, credentialId: string) {
      yield* decode(PersonalScope, scope); yield* decode(LocalId, credentialId)
      const rows = yield* sql<CredentialRow>`SELECT id, version, json FROM automation_credentials WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${credentialId}`
      if (!rows[0]) return null
      const row = rows[0]; const stored = yield* readJson(StoredCredential, row.json)
      yield* guard(stored.credentialId === row.id && stored.credentialId === credentialId)
      yield* decode(PositiveVersion, row.version)
      return { id: row.id, version: row.version, stored }
    })
    const putCredential = (scope: PersonalScope, credentialId: string, secret: unknown, expectedVersion: number) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      yield* decode(PersonalScope, scope); yield* decode(LocalId, credentialId)
      const value = yield* decode(JsonValue, secret)
      yield* guard(Number.isSafeInteger(expectedVersion) && expectedVersion >= 0)
      const existing = yield* readRow(scope, credentialId)
      if (existing) {
        if (same(existing.stored.secret, value)) return existing.version
        yield* guard(existing.version === expectedVersion, "conflict")
        const stored: StoredCredential = { schemaVersion: 1, kind: "credential", credentialId, secret: value }
        yield* sql`UPDATE automation_credentials SET json=${encodeJson(stored)}, version=version+1 WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${credentialId} AND version=${expectedVersion}`
        return expectedVersion + 1
      }
      yield* guard(expectedVersion === 0, "conflict")
      const stored: StoredCredential = { schemaVersion: 1, kind: "credential", credentialId, secret: value }
      yield* sql`INSERT INTO automation_credentials ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, id: credentialId, version: 1, json: encodeJson(stored) })}`
      return 1
    })))
    const removeCredential = (scope: PersonalScope, credentialId: string, expectedVersion: number) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      yield* decode(PersonalScope, scope); yield* decode(LocalId, credentialId); yield* decode(PositiveVersion, expectedVersion)
      const existing = yield* readRow(scope, credentialId)
      yield* guard(existing !== null, "missing")
      yield* guard(existing!.version === expectedVersion, "conflict")
      yield* sql`DELETE FROM automation_credentials WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${credentialId} AND version=${expectedVersion}`
    })))
    const status = Effect.fn("Credentials.status")(function*(scope: PersonalScope, credentialId: string) {
      yield* decode(PersonalScope, scope); yield* decode(LocalId, credentialId)
      const rows = yield* sql<StatusRow>`SELECT id, version FROM automation_credentials WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${credentialId}`
      if (!rows[0]) return null
      const value = { credentialId: rows[0].id, version: rows[0].version, configured: true as const }
      yield* guard(value.credentialId === credentialId)
      return yield* decode(CredentialStatus, value)
    })
    const list = Effect.fn("Credentials.list")(function*(scope: PersonalScope) {
      yield* decode(PersonalScope, scope)
      const rows = yield* sql<StatusRow>`SELECT id, version FROM automation_credentials WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} ORDER BY id`
      const values: Array<CredentialStatus> = []
      for (const row of rows) values.push(yield* decode(CredentialStatus, { credentialId: row.id, version: row.version, configured: true as const }))
      return values as ReadonlyArray<CredentialStatus>
    })
    const resolveSecret = Effect.fn("Credentials.resolveSecret")(function*(scope: PersonalScope, credentialId: string) {
      const existing = yield* readRow(scope, credentialId)
      yield* guard(existing !== null, "missing")
      return existing!.stored.secret
    })
    const resolveReferences = Effect.fn("Credentials.resolveReferences")(function*(scope: PersonalScope, references: Record<string, CredentialReference>) {
      yield* decode(PersonalScope, scope)
      yield* guard(references !== null && typeof references === "object" && !Array.isArray(references))
      const resolved: Record<string, Schema.Json> = Object.create(null)
      for (const [slot, reference] of Object.entries(references)) {
        yield* decode(LocalId, slot)
        const parsed = yield* decode(CredentialReference, reference)
        resolved[slot] = yield* resolveSecret(scope, parsed.credentialId)
      }
      return resolved
    })
    const resolveIntegrationCredentials = Effect.fn("Credentials.resolveIntegrationCredentials")(function*(scope: PersonalScope, integration: IntegrationConfiguration) {
      const value = yield* decode(IntegrationConfiguration, integration)
      return yield* resolveReferences(scope, value.credentials)
    })
    return {
      putCredential, removeCredential,
      status: (scope, credentialId) => protectStorage(status(scope, credentialId)),
      list: (scope) => protectStorage(list(scope)),
      resolveSecret: (scope, credentialId) => protectStorage(resolveSecret(scope, credentialId)),
      resolveReferences: (scope, references) => protectStorage(resolveReferences(scope, references)),
      resolveIntegrationCredentials: (scope, integration) => protectStorage(resolveIntegrationCredentials(scope, integration))
    }
  })
}) {}
export const CredentialRepositoryLayer = Layer.effect(CredentialRepository, CredentialRepository.make)

interface CredentialRow { readonly id: string; readonly version: number; readonly json: string }
interface StatusRow { readonly id: string; readonly version: number }
