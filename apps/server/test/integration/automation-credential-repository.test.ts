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

const storageCode = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause)
    if (error instanceof StorageError) return error.code
  }
  return null
}

describe("credential repository", () => {
  it.live("configures replaces and removes credentials with CAS and scope isolation", () => Effect.gen(function* () {
    const credentials = yield* CredentialRepository
    expect(yield* credentials.resolveSecret(scope, credentialId)).toBeNull()
    expect(yield* credentials.getStatus(scope, credentialId)).toBeNull()
    expect(yield* credentials.putCredential(scope, credentialId, secretA, 0)).toBe(1)
    expect(yield* credentials.putCredential(scope, credentialId, secretA, 1)).toBe(1)
    expect(storageCode(yield* Effect.exit(credentials.putCredential(scope, credentialId, secretA, 0)))).toBe("conflict")
    expect(yield* credentials.getStatus(scope, credentialId)).toEqual({ credentialId, version: 1, configured: true })
    const first = yield* credentials.resolveSecret(scope, credentialId)
    expect(first instanceof Uint8Array).toBe(true)
    expect(Array.from(first ?? new Uint8Array())).toEqual(Array.from(secretA))
    if (first) first[0] = 0
    const reread = yield* credentials.resolveSecret(scope, credentialId)
    expect(Array.from(reread ?? new Uint8Array())).toEqual(Array.from(secretA))
    expect(yield* credentials.putCredential(scope, credentialId, secretB, 1)).toBe(2)
    const second = yield* credentials.resolveSecret(scope, credentialId)
    expect(Array.from(second ?? new Uint8Array())).toEqual(Array.from(secretB))
    expect(storageCode(yield* Effect.exit(credentials.putCredential(scope, credentialId, secretA, 1)))).toBe("conflict")
    expect(storageCode(yield* Effect.exit(credentials.removeCredential(scope, credentialId, 1)))).toBe("conflict")
    expect(storageCode(yield* Effect.exit(credentials.putCredential(scope, credentialId, secretA, 99)))).toBe("conflict")
    yield* credentials.removeCredential(scope, credentialId, 2)
    expect(yield* credentials.resolveSecret(scope, credentialId)).toBeNull()
    expect(yield* credentials.getStatus(scope, credentialId)).toBeNull()
    expect(storageCode(yield* Effect.exit(credentials.removeCredential(scope, credentialId, 2)))).toBe("missing")
    expect(yield* credentials.putCredential(scope, credentialId, secretA, 0)).toBe(1)
    const other = { ...scope, ownerId: "other-person" }
    expect(yield* credentials.getStatus(other, credentialId)).toBeNull()
    expect(yield* credentials.listStatuses(other)).toEqual([])
    expect(yield* credentials.resolveSecret(other, credentialId)).toBeNull()
    expect(yield* credentials.putCredential(other, credentialId, secretB, 0)).toBe(1)
    expect((yield* credentials.resolveSecret(other, credentialId)) instanceof Uint8Array).toBe(true)
    expect(yield* credentials.listStatuses(scope)).toEqual([{ credentialId, version: 1, configured: true }])
    const otherProject = { ...scope, projectId: "other-project" }
    expect(yield* credentials.getStatus(otherProject, credentialId)).toBeNull()
    expect(yield* credentials.listStatuses(otherProject)).toEqual([])
    expect(yield* credentials.resolveSecret(otherProject, credentialId)).toBeNull()
    expect(yield* credentials.putCredential(otherProject, credentialId, secretB, 0)).toBe(1)
    expect(yield* credentials.listStatuses(scope)).toEqual([{ credentialId, version: 1, configured: true }])
    expect(yield* credentials.listStatuses(otherProject)).toEqual([{ credentialId, version: 1, configured: true }])
  }).pipe(Effect.provide(Repositories)))

  it.live("resolves integration references server-side and reports redacted connection status", () => Effect.gen(function* () {
    const credentials = yield* CredentialRepository
    const repository = yield* ConfigurationRepository
    yield* repository.putIntegration(scope, integration, 0)
    const missing = yield* credentials.statusForIntegration(scope, integration)
    expect(missing.configured).toBe(false)
    expect(missing.missing).toEqual(["account"])
    expect(storageCode(yield* Effect.exit(credentials.requireIntegrationSecrets(scope, integration)))).toBe("missing")
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
    const otherProject = { ...scope, projectId: "other-project" }
    expect((yield* credentials.statusForIntegration(otherProject, integration)).configured).toBe(false)
    expect(storageCode(yield* Effect.exit(credentials.requireIntegrationSecrets(otherProject, integration)))).toBe("missing")
    const otherOwner = { ...scope, ownerId: "other-person" }
    expect((yield* credentials.statusForIntegration(otherOwner, integration)).configured).toBe(false)
    expect(storageCode(yield* Effect.exit(credentials.requireIntegrationSecrets(otherOwner, integration)))).toBe("missing")
    expect(yield* credentials.resolveSecret(otherOwner, credentialId)).toBeNull()
    const mutable = yield* credentials.requireIntegrationSecrets(scope, integration)
    mutable["account"]![0] = 0
    const refetched = yield* credentials.requireIntegrationSecrets(scope, integration)
    expect(Array.from(refetched["account"] ?? new Uint8Array())).toEqual(Array.from(secretB))
    yield* credentials.removeCredential(scope, credentialId, 2)
    expect((yield* credentials.statusForIntegration(scope, integration)).configured).toBe(false)
    expect(storageCode(yield* Effect.exit(credentials.requireIntegrationSecrets(scope, integration)))).toBe("missing")
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
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(StorageError)
      expect(storageCode(exit)).toBe("storage")
    }
    expect(yield* sql`SELECT count(*) n FROM automation_credentials`).toEqual([{ n: 0 }])
  }).pipe(Effect.provide(Repositories)))
})

describe("credential racing creates", () => {
  it.live("maps a concurrent insert to conflict with no partial writes", () => Effect.gen(function* () {
    const sql = yield* SqlClient
    let armed = true
    const controlled = new Proxy(sql, {
      apply(target, thisArg, args) {
        const head = String((args[0] as unknown as ArrayLike<string>)?.[0] ?? "")
        if (armed && head.includes("INSERT INTO automation_credentials")) {
          armed = false
          const landed = (target as unknown as (...parts: Array<unknown>) => Effect.Effect<unknown>)`INSERT INTO automation_credentials (owner_id, project_id, id, version, secret) VALUES (${scope.ownerId}, ${scope.projectId}, ${"racer"}, ${1}, ${new Uint8Array([0])})`
          return Effect.andThen(landed, Reflect.apply(target, thisArg, args as Array<unknown>))
        }
        return Reflect.apply(target, thisArg, args as Array<unknown>)
      }
    })
    const credentials = yield* CredentialRepository.make.pipe(Effect.provideService(SqlClient, controlled))
    const exit = yield* Effect.exit(credentials.putCredential(scope, "racer", secretA, 0))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(storageCode(exit)).toBe("conflict")
    const rows = yield* sql<{ secret: Uint8Array }>`SELECT secret FROM automation_credentials WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id='racer'`
    expect(rows.length).toBe(0)
  }).pipe(Effect.provide(Repositories)))
})
