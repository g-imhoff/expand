import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { StorageError } from "../../automation/persistence-models.js"
import { configuration, integration, scope } from "../fixtures/automation-persistence-fixture.js"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Repositories = Layer.mergeAll(ConfigurationRepositoryLayer, CredentialRepositoryLayer).pipe(Layer.provideMerge(Ready))
const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const encoder = new TextEncoder()
const secretA = encoder.encode("t03-secret-alpha")
const secretB = encoder.encode("t03-secret-beta")
const credentialId = integration.credentials["account"]!.credentialId

describe("credential repository", () => {
  it.live("configures replaces and removes credentials with CAS and scope isolation", () => Effect.gen(function* () {
    const credentials = yield* CredentialRepository
    expect(yield* credentials.resolveSecret(scope, credentialId)).toBeNull()
    expect(yield* credentials.getStatus(scope, credentialId)).toBeNull()
    expect(yield* credentials.putCredential(scope, credentialId, secretA, 0)).toBe(1)
    expect(yield* credentials.putCredential(scope, credentialId, secretA, 0)).toBe(1)
    expect(yield* credentials.getStatus(scope, credentialId)).toEqual({ credentialId, version: 1, configured: true })
    const first = yield* credentials.resolveSecret(scope, credentialId)
    expect(first instanceof Uint8Array).toBe(true)
    expect(Array.from(first ?? new Uint8Array())).toEqual(Array.from(secretA))
    expect(yield* credentials.putCredential(scope, credentialId, secretB, 1)).toBe(2)
    const second = yield* credentials.resolveSecret(scope, credentialId)
    expect(Array.from(second ?? new Uint8Array())).toEqual(Array.from(secretB))
    expect(Exit.isFailure(yield* Effect.exit(credentials.putCredential(scope, credentialId, secretA, 1)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(credentials.removeCredential(scope, credentialId, 1)))).toBe(true)
    yield* credentials.removeCredential(scope, credentialId, 2)
    expect(yield* credentials.resolveSecret(scope, credentialId)).toBeNull()
    expect(yield* credentials.getStatus(scope, credentialId)).toBeNull()
    expect(Exit.isFailure(yield* Effect.exit(credentials.removeCredential(scope, credentialId, 2)))).toBe(true)
    expect(yield* credentials.putCredential(scope, credentialId, secretA, 0)).toBe(1)
    const other = { ...scope, ownerId: "other-person" }
    expect(yield* credentials.getStatus(other, credentialId)).toBeNull()
    expect(yield* credentials.listStatuses(other)).toEqual([])
    expect(yield* credentials.putCredential(other, credentialId, secretB, 0)).toBe(1)
    expect(yield* credentials.listStatuses(scope)).toEqual([{ credentialId, version: 1, configured: true }])
  }).pipe(Effect.provide(Repositories)))

  it.live("resolves integration references server-side and reports redacted connection status", () => Effect.gen(function* () {
    const credentials = yield* CredentialRepository
    const repository = yield* ConfigurationRepository
    yield* repository.putIntegration(scope, integration, 0)
    const missing = yield* credentials.statusForIntegration(scope, integration)
    expect(missing.configured).toBe(false)
    expect(missing.missing).toEqual(["account"])
    expect(Exit.isFailure(yield* Effect.exit(credentials.requireIntegrationSecrets(scope, integration)))).toBe(true)
    yield* credentials.putCredential(scope, credentialId, secretA, 0)
    const ready = yield* credentials.statusForIntegration(scope, integration)
    expect(ready.configured).toBe(true)
    expect(ready.missing).toEqual([])
    expect(ready.credentials["account"]).toEqual({ credentialId, version: 1, configured: true })
    const secrets = yield* credentials.requireIntegrationSecrets(scope, integration)
    const accountSecret = secrets["account"] ?? new Uint8Array()
    expect(Array.from(accountSecret)).toEqual(Array.from(secretA))
    yield* credentials.putCredential(scope, credentialId, secretB, 1)
    const replaced = yield* credentials.requireIntegrationSecrets(scope, integration)
    const replacedSecret = replaced["account"] ?? new Uint8Array()
    expect(Array.from(replacedSecret)).toEqual(Array.from(secretB))
    yield* credentials.removeCredential(scope, credentialId, 2)
    expect((yield* credentials.statusForIntegration(scope, integration)).configured).toBe(false)
    expect(Exit.isFailure(yield* Effect.exit(credentials.requireIntegrationSecrets(scope, integration)))).toBe(true)
  }).pipe(Effect.provide(Repositories)))

  it.live("keeps secrets in BLOB storage and out of JSON history and redacted reads", () => Effect.gen(function* () {
    const credentials = yield* CredentialRepository
    const repository = yield* ConfigurationRepository
    const sql = yield* SqlClient
    yield* credentials.putCredential(scope, credentialId, secretA, 0)
    yield* repository.putIntegration(scope, integration, 0)
    yield* repository.appendRoutineRevision(configuration, 0, "enabled")
    const columns = yield* sql<{ name: string; type: string }>`PRAGMA table_info(automation_credentials)`
    expect(columns.find((column) => column.name === "secret")?.type).toBe("BLOB")
    const secrets = yield* sql<{ secret: Uint8Array }>`SELECT secret FROM automation_credentials`
    expect(secrets.length).toBe(1)
    const statuses = yield* credentials.listStatuses(scope)
    const encoded = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(statuses)
    expect(encoded.includes("t03-secret-alpha")).toBe(false)
    const integrations = yield* sql<{ json: string }>`SELECT json FROM automation_integrations`
    const revisions = yield* sql<{ json: string }>`SELECT json FROM automation_routine_revisions`
    expect(integrations.map((row) => decodeStored(row.json))).toEqual([integration])
    for (const row of [...integrations, ...revisions]) expect(row.json.includes("t03-secret-alpha")).toBe(false)
  }).pipe(Effect.provide(Repositories)))
})

describe("credential commit error", () => {
  it.live("reports a real commit failure as typed storage uncertainty without writes", () => Effect.gen(function* () {
    const sql = yield* SqlClient
    const controlled = new Proxy(sql, { get(target, key) {
      if (key !== "withTransaction") return Reflect.get(target, key)
      return <A, E, R>(effect: Effect.Effect<A, E, R>) => target.withTransaction(effect.pipe(Effect.tap(() => sql`INSERT INTO automation_routines ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, id: "credential-probe", head_revision: 99, status: "enabled", version: 1 })}`)))
    } })
    const credentials = yield* CredentialRepository.make.pipe(Effect.provideService(SqlClient, controlled))
    const exit = yield* Effect.exit(credentials.putCredential(scope, "probe", secretA, 0))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect.soft(Cause.squash(exit.cause)).toBeInstanceOf(StorageError)
    expect(yield* sql`SELECT count(*) n FROM automation_credentials`).toEqual([{ n: 0 }])
  }).pipe(Effect.provide(Repositories)))
})
