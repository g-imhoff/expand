import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Cause, Effect, Exit, FileSystem, Layer, Logger, Path } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeServices } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { StorageError } from "../../automation/persistence-models.js"
import { configuration, delivery, integration, raw, run, scope } from "../fixtures/automation-persistence-fixture.js"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Config = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const WithCredentials = CredentialRepositoryLayer.pipe(Layer.provideMerge(Config))
const Repositories = ExecutionRepositoryLayer.pipe(Layer.provideMerge(WithCredentials))
const Credentials = WithCredentials

const secretA = "t03-backend-secret-alpha"
const secretB = "t03-backend-secret-beta"

describe("credential repository", () => {
  it.live("configures replaces and removes credentials with scoped CAS versions", () => Effect.gen(function* () {
    const credentials = yield* CredentialRepository
    expect(yield* credentials.putCredential(scope, "account-1", secretA, 0)).toBe(1)
    expect(yield* credentials.putCredential(scope, "account-1", secretA, 0)).toBe(1)
    expect(yield* credentials.status(scope, "account-1")).toEqual({ credentialId: "account-1", version: 1, configured: true })
    expect(yield* credentials.resolveSecret(scope, "account-1")).toBe(secretA)
    expect(yield* credentials.putCredential(scope, "account-1", secretB, 1)).toBe(2)
    expect(yield* credentials.resolveSecret(scope, "account-1")).toBe(secretB)
    expect(yield* credentials.list(scope)).toEqual([{ credentialId: "account-1", version: 2, configured: true }])
    yield* credentials.removeCredential(scope, "account-1", 2)
    expect(yield* credentials.status(scope, "account-1")).toBeNull()
    expect(yield* credentials.list(scope)).toEqual([])
  }).pipe(Effect.provide(Credentials)))
  it.live("rejects stale CAS invalid secrets and cross-scope access without writes", () => Effect.gen(function* () {
    const credentials = yield* CredentialRepository
    const sql = yield* SqlClient
    yield* credentials.putCredential(scope, "account-1", secretA, 0)
    for (const invalid of [
      credentials.putCredential(scope, "account-1", secretB, 0),
      credentials.putCredential(scope, "account-1", secretB, 99),
      credentials.putCredential(scope, "account-1", undefined, 1),
      credentials.removeCredential(scope, "account-1", 99),
      credentials.removeCredential(scope, "missing", 1)
    ]) {
      const exit = yield* Effect.exit(invalid)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(StorageError)
        expect(String(Cause.squash(exit.cause))).not.toContain(secretA)
        expect(String(Cause.squash(exit.cause))).not.toContain(secretB)
      }
    }
    expect(yield* credentials.resolveSecret(scope, "account-1")).toBe(secretA)
    for (const other of [{ ...scope, ownerId: "other" }, { ...scope, projectId: "other" }]) {
      expect(yield* credentials.status(other, "account-1")).toBeNull()
      expect(yield* credentials.list(other)).toEqual([])
      expect(Exit.isFailure(yield* Effect.exit(credentials.resolveSecret(other, "account-1")))).toBe(true)
    }
    expect(yield* sql`SELECT count(*) n FROM automation_credentials`).toEqual([{ n: 1 }])
  }).pipe(Effect.provide(WithCredentials)))
})

describe("missing and replaced credentials", () => {
  it.live("fails reference resolution when a credential is missing and resolves after configure", () => Effect.gen(function* () {
    const credentials = yield* CredentialRepository
    const references = { account: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "account-1" } }
    const missing = yield* Effect.exit(credentials.resolveReferences(scope, references))
    expect(Exit.isFailure(missing)).toBe(true)
    if (Exit.isFailure(missing)) {
      expect(Cause.squash(missing.cause)).toMatchObject({ code: "missing" })
      expect(String(Cause.squash(missing.cause))).not.toContain(secretA)
    }
    expect(Exit.isFailure(yield* Effect.exit(credentials.resolveIntegrationCredentials(scope, integration)))).toBe(true)
    yield* credentials.putCredential(scope, "account-1", secretA, 0)
    expect(yield* credentials.resolveReferences(scope, references)).toEqual({ account: secretA })
    expect(yield* credentials.resolveIntegrationCredentials(scope, integration)).toEqual({ account: secretA })
    yield* credentials.putCredential(scope, "account-1", secretB, 1)
    expect(yield* credentials.resolveReferences(scope, references)).toEqual({ account: secretB })
    yield* credentials.removeCredential(scope, "account-1", 2)
    expect(Exit.isFailure(yield* Effect.exit(credentials.resolveReferences(scope, references)))).toBe(true)
  }).pipe(Effect.provide(Credentials)))
})

describe("credential storage protection", () => {
  it.live("keeps secrets only in the credentials table and secures a file-backed database to 0600", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = mkdtempSync(join(tmpdir(), "automation-credentials-"))
    const filename = path.join(dir, "state.sqlite")
    const fileSql = SqliteClient.layer({ filename })
    const fileReady = DatabaseReadyLayer.pipe(Layer.provideMerge(fileSql))
    const fileCredentials = CredentialRepositoryLayer.pipe(Layer.provideMerge(fileReady))
    const fileConfig = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(fileReady))
    yield* Effect.gen(function* () {
      const credentials = yield* CredentialRepository
      const config = yield* ConfigurationRepository
      const sql = yield* SqlClient
      yield* credentials.putCredential(scope, "account-1", secretA, 0)
      yield* config.putIntegration(scope, integration, 0)
      yield* config.appendRoutineRevision(configuration, 0, "enabled")
      const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'automation_%'`
      expect(tables.map((row) => row.name).sort()).toContain("automation_credentials")
      const credentialRows = yield* sql<{ json: string }>`SELECT json FROM automation_credentials`
      expect(credentialRows).toHaveLength(1)
      expect(credentialRows[0]!.json).toContain(secretA)
      for (const table of ["automation_integrations", "automation_routine_revisions"]) {
        const rows = yield* sql<{ json: string }>`SELECT json FROM ${sql(table)}`
        for (const row of rows) expect(row.json).not.toContain(secretA)
      }
      const strict = yield* sql<{ strict: number }>`SELECT strict FROM pragma_table_list WHERE name='automation_credentials'`
      expect(strict[0]!.strict).toBe(1)
      yield* fs.chmod(filename, 0o600)
      yield* fs.chmod(dir, 0o700)
      expect(Number((yield* fs.stat(filename)).mode & 0o777)).toBe(0o600)
      expect(Number((yield* fs.stat(dir)).mode & 0o777)).toBe(0o700)
    }).pipe(Effect.provide(Layer.mergeAll(fileCredentials, fileConfig, fileReady)))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("credential redaction", () => {
  it.live("never exposes secrets in status reads logs or run history payloads", () => Effect.gen(function* () {
    const credentials = yield* CredentialRepository
    const config = yield* ConfigurationRepository
    const repository = yield* ExecutionRepository
    const messages: Array<string> = []
    const capture = Logger.make(({ message }) => {
      messages.push(String(message))
    })
    yield* Effect.gen(function* () {
      const inner = yield* CredentialRepository
      yield* inner.putCredential(scope, "account-1", secretA, 0)
      expect(JSON.stringify(yield* inner.status(scope, "account-1"))).not.toContain(secretA)
      expect(JSON.stringify(yield* inner.list(scope))).not.toContain(secretA)
      yield* Effect.logInfo("credential status read")
    }).pipe(Effect.provide(Logger.layer([capture])), Effect.provide(Credentials))
    yield* credentials.putCredential(scope, "account-1", secretA, 0)
    const statusValue = yield* credentials.status(scope, "account-1")
    const listed = yield* credentials.list(scope)
    expect(JSON.stringify({ statusValue, listed })).not.toContain(secretA)
    expect(messages.join("\n")).not.toContain(secretA)
    yield* config.putIntegration(scope, integration, 0)
    yield* config.appendRoutineRevision(configuration, 0, "enabled")
    yield* repository.ingest({ delivery, raw, targets: [{ jobId: "job", run }] })
    const history = yield* repository.history(scope, "run")
    const storedIntegration = yield* config.getIntegration(scope, integration.id)
    const storedRevision = yield* config.getRevision(scope, "routine", 1)
    const runs = yield* repository.listRuns(scope, { limit: 10 })
    expect(JSON.stringify({ history, storedIntegration, storedRevision, runs })).not.toContain(secretA)
    const sql = yield* SqlClient
    for (const table of ["automation_integrations", "automation_routine_revisions", "automation_deliveries", "automation_jobs", "automation_runs"]) {
      const rows = yield* sql<{ json: string }>`SELECT json FROM ${sql(table)}`
      for (const row of rows) expect(row.json).not.toContain(secretA)
    }
  }).pipe(Effect.provide(Repositories)))
})
