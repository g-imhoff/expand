import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Exit, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { integration, scope } from "../fixtures/automation-persistence-fixture.js"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Repositories = CredentialRepositoryLayer.pipe(Layer.provideMerge(Ready))
const encoder = new TextEncoder()
const secret = encoder.encode("t03-unit-secret")

describe("credential redaction", () => {
  it.live("exposes only identifiers and versions while secrets resolve server-side", () => Effect.gen(function* () {
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "unit-account", secret, 0)
    const status = yield* credentials.getStatus(scope, "unit-account")
    expect(status).toEqual({ credentialId: "unit-account", version: 1, configured: true })
    expect(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(status).includes("t03-unit-secret")).toBe(false)
    expect(Object.keys(status ?? {}).sort()).toEqual(["configured", "credentialId", "version"])
    const resolved = yield* credentials.resolveSecret(scope, "unit-account")
    expect(resolved instanceof Uint8Array).toBe(true)
    expect(resolved).not.toBe(secret)
    const resolvedBytes = resolved ?? new Uint8Array()
    expect(Array.from(resolvedBytes)).toEqual(Array.from(secret))
  }).pipe(Effect.provide(Repositories)))

  it.live("rejects empty oversized and invalid credential inputs without storage", () => Effect.gen(function* () {
    const credentials = yield* CredentialRepository
    for (const invalid of [new Uint8Array(), new Uint8Array(65 * 1024)]) {
      expect(Exit.isFailure(yield* Effect.exit(credentials.putCredential(scope, "unit-input", invalid, 0)))).toBe(true)
    }
    expect(Exit.isFailure(yield* Effect.exit(credentials.putCredential(scope, "", secret, 0)))).toBe(true)
    expect(yield* credentials.getStatus(scope, "unit-input")).toBeNull()
    expect(yield* credentials.listStatuses(scope)).toEqual([])
  }).pipe(Effect.provide(Repositories)))

  it.effect("keeps routine configuration payloads free of secret bytes", () => Effect.gen(function* () {
    const encoded = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(integration)
    expect(encoded.includes("t03-unit-secret")).toBe(false)
    expect(integration.credentials["account"]).toEqual({ schemaVersion: 1, kind: "credential-reference", credentialId: "account-1" })
  }))
})
