import { Context, Effect, Layer } from "effect"
import { globalCredentialScope, IntegrationConfiguration, LocalId, PersonalScope } from "@expand/contracts/automation"
import { SqlClient } from "effect/sql/SqlClient"
import { DatabaseReady } from "../migrations/sqlite.js"
import { decode, guard, protectStorage, StorageError } from "./persistence-models.js"

export interface CredentialStatus {
  readonly credentialId: string
  readonly version: number
  readonly configured: true
}

export interface IntegrationCredentialStatus {
  readonly integrationId: string
  readonly configured: boolean
  readonly missing: ReadonlyArray<string>
  readonly credentials: Record<string, CredentialStatus>
}

export class CredentialRepository extends Context.Service<CredentialRepository, {
  readonly putCredential: (scope: PersonalScope, credentialId: string, secret: Uint8Array, expectedVersion: number) => Effect.Effect<number, StorageError>
  readonly removeCredential: (scope: PersonalScope, credentialId: string, expectedVersion: number) => Effect.Effect<void, StorageError>
  readonly getStatus: (scope: PersonalScope, credentialId: string) => Effect.Effect<CredentialStatus | null, StorageError>
  readonly listStatuses: (scope: PersonalScope) => Effect.Effect<ReadonlyArray<CredentialStatus>, StorageError>
  readonly resolveSecret: (scope: PersonalScope, credentialId: string) => Effect.Effect<Uint8Array | null, StorageError>
  readonly statusForIntegration: (scope: PersonalScope, integration: IntegrationConfiguration) => Effect.Effect<IntegrationCredentialStatus, StorageError>
  readonly requireIntegrationSecrets: (scope: PersonalScope, integration: IntegrationConfiguration) => Effect.Effect<Record<string, Uint8Array>, StorageError>
}>()("expand/CredentialRepository", {
  make: Effect.gen(function* () {
    yield* DatabaseReady
    const sql = yield* SqlClient
    const readRow = Effect.fn("Credentials.readRow")(function* (scope: PersonalScope, credentialId: string) {
      yield* decode(PersonalScope, scope)
      yield* decode(LocalId, credentialId)
      const rows = yield* sql<CredentialRow>`SELECT id, version, secret FROM automation_credentials WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${credentialId}`
      if (!rows[0]) return null
      const row = rows[0]
      yield* guard(row.id === credentialId && Number.isSafeInteger(row.version) && row.version > 0 && row.secret instanceof Uint8Array)
      return { id: row.id, version: row.version, secret: row.secret }
    })
    const readEffectiveRow = Effect.fn("Credentials.readEffectiveRow")(function* (scope: PersonalScope, credentialId: string) {
      yield* decode(PersonalScope, scope)
      const generalScope = globalCredentialScope(scope.ownerId)
      const shared = yield* readRow(generalScope, credentialId)
      if (shared !== null || scope.projectId === generalScope.projectId) return shared
      return yield* readRow(scope, credentialId)
    })
    const putCredential = (scope: PersonalScope, credentialId: string, secret: Uint8Array, expectedVersion: number) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      yield* decode(PersonalScope, scope)
      yield* decode(LocalId, credentialId)
      yield* guard(secret instanceof Uint8Array && secret.length > 0 && secret.length <= 64 * 1024)
      yield* guard(Number.isSafeInteger(expectedVersion) && expectedVersion >= 0)
      const existing = yield* readRow(scope, credentialId)
      if (existing) {
        yield* guard(existing.version === expectedVersion, "conflict")
        if (bytesEqual(existing.secret, secret)) {
          const confirmed = yield* sql<{ version: number }>`UPDATE automation_credentials SET version=version WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${credentialId} AND version=${expectedVersion} RETURNING version`
          yield* guard(confirmed.length > 0, "conflict")
          return existing.version
        }
        const moved = yield* sql<{ version: number }>`UPDATE automation_credentials SET secret=${secret}, version=version+1 WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${credentialId} AND version=${expectedVersion} RETURNING version`
        yield* guard(moved.length > 0, "conflict")
        return expectedVersion + 1
      }
      yield* guard(expectedVersion === 0, "conflict")
      const inserted = yield* sql<{ version: number }>`INSERT INTO automation_credentials ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, id: credentialId, version: 1, secret })} ON CONFLICT(owner_id, project_id, id) DO NOTHING RETURNING version`
      yield* guard(inserted.length > 0, "conflict")
      return 1
    })))
    const removeCredential = (scope: PersonalScope, credentialId: string, expectedVersion: number) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      yield* decode(PersonalScope, scope)
      yield* decode(LocalId, credentialId)
      yield* guard(Number.isSafeInteger(expectedVersion) && expectedVersion > 0)
      const existing = yield* readRow(scope, credentialId)
      yield* guard(existing !== null, "missing")
      yield* guard(existing!.version === expectedVersion, "conflict")
      const removed = yield* sql<{ id: string }>`DELETE FROM automation_credentials WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${credentialId} AND version=${expectedVersion} RETURNING id`
      yield* guard(removed.length > 0, "conflict")
    })))
    const getStatus = (scope: PersonalScope, credentialId: string) => protectStorage(Effect.gen(function* () {
      yield* decode(PersonalScope, scope)
      yield* decode(LocalId, credentialId)
      const generalScope = globalCredentialScope(scope.ownerId)
      const rows = yield* sql<{ id: string; version: number }>`SELECT id, version FROM automation_credentials WHERE owner_id=${scope.ownerId} AND (project_id=${generalScope.projectId} OR project_id=${scope.projectId}) AND id=${credentialId} ORDER BY CASE WHEN project_id=${generalScope.projectId} THEN 0 ELSE 1 END LIMIT 1`
      if (!rows[0]) return null
      yield* guard(rows[0].id === credentialId && Number.isSafeInteger(rows[0].version) && rows[0].version > 0)
      return { credentialId: rows[0].id, version: rows[0].version, configured: true as const }
    }))
    const listStatuses = (scope: PersonalScope) => protectStorage(Effect.gen(function* () {
      yield* decode(PersonalScope, scope)
      const generalScope = globalCredentialScope(scope.ownerId)
      const rows = yield* sql<{ id: string; version: number }>`SELECT id, version FROM automation_credentials WHERE owner_id=${scope.ownerId} AND (project_id=${generalScope.projectId} OR project_id=${scope.projectId}) ORDER BY id, CASE WHEN project_id=${generalScope.projectId} THEN 0 ELSE 1 END`
      const statuses: Array<CredentialStatus> = []
      const seen = new Set<string>()
      for (const row of rows) {
        yield* decode(LocalId, row.id)
        yield* guard(Number.isSafeInteger(row.version) && row.version > 0)
        if (seen.has(row.id)) continue
        seen.add(row.id)
        statuses.push({ credentialId: row.id, version: row.version, configured: true as const })
      }
      return statuses
    }))
    const resolveSecret = (scope: PersonalScope, credentialId: string) => protectStorage(Effect.gen(function* () {
      const row = yield* readEffectiveRow(scope, credentialId)
      if (!row) return null
      return new Uint8Array(row.secret)
    }))
    const statusForIntegration = (scope: PersonalScope, integration: IntegrationConfiguration) => protectStorage(Effect.gen(function* () {
      yield* decode(PersonalScope, scope)
      const value = yield* decode(IntegrationConfiguration, integration)
      const credentials: Record<string, CredentialStatus> = {}
      const missing: Array<string> = []
      for (const [slot, reference] of Object.entries(value.credentials)) {
        const status = yield* getStatus(scope, reference.credentialId)
        if (status === null) missing.push(slot)
        else credentials[slot] = status
      }
      return { integrationId: value.id, configured: missing.length === 0, missing, credentials }
    }))
    const requireIntegrationSecrets = (scope: PersonalScope, integration: IntegrationConfiguration) => protectStorage(Effect.gen(function* () {
      yield* decode(PersonalScope, scope)
      const value = yield* decode(IntegrationConfiguration, integration)
      const secrets: Record<string, Uint8Array> = {}
      for (const [slot, reference] of Object.entries(value.credentials)) {
        const row = yield* readEffectiveRow(scope, reference.credentialId)
        yield* guard(row !== null, "missing")
        secrets[slot] = new Uint8Array(row!.secret)
      }
      return secrets
    }))
    return { putCredential, removeCredential, getStatus, listStatuses, resolveSecret, statusForIntegration, requireIntegrationSecrets }
  })
}) {}

export const CredentialRepositoryLayer = Layer.effect(CredentialRepository, CredentialRepository.make)

interface CredentialRow {
  readonly id: string
  readonly version: number
  readonly secret: Uint8Array
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}
