import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { checkGithubConnection, unionLabels } from "../../automation/github-connector.js"
import { listIssueLabels, listRepositoryLabels } from "../../automation/github-transport.js"
import { startGithubStub } from "../fixtures/automation-github-stub.js"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Configurations = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Credentials = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configurations))
const Live = Layer.mergeAll(Credentials, NodeHttpClient.layerFetch)
const fakeToken = "stub-github-token-for-tests-only"
const scope = { ownerId: "github-owner", projectId: "github-project" }
const integration = {
  schemaVersion: 1, kind: "integration-configuration", id: "github",
  definition: { id: "github:integration", version: 1 },
  configuration: { owner: "octo", repo: "hello" },
  credentials: { token: { schemaVersion: 1, kind: "credential-reference", credentialId: "github-token" } }
}
const withStub = Effect.acquireRelease(startGithubStub(), (stub) => Effect.sync(() => stub.close()))
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const secretBytes = new TextEncoder().encode(fakeToken)

describe("github label union", () => {
  it.effect("preserves existing labels and adds only configured labels idempotently", () =>
    Effect.gen(function* () {
      expect(unionLabels(["bug"], ["type: bug"])).toEqual(["bug", "type: bug"])
      expect(unionLabels(["bug", "type: bug"], ["type: bug"])).toEqual(["bug", "type: bug"])
      expect(unionLabels([], ["a", "b"])).toEqual(["a", "b"])
      expect(unionLabels(["a", "b"], [])).toEqual(["a", "b"])
      expect(unionLabels(["a", "a"], ["a", "b", "b"])).toEqual(["a", "b"])
      const once = unionLabels(["old"], ["new"])
      expect(unionLabels(once, ["new"])).toEqual(once)
      expect(unionLabels(once, [])).toEqual(once)
    }))
})

describe("github transport errors", () => {
  it.live("maps authentication permission and missing failures without retry", () => Effect.gen(function* () {
    const stub = yield* withStub
    const cases = [
      { status: 401, code: "auth" },
      { status: 403, code: "forbidden" },
      { status: 404, code: "not-found" }
    ] as const
    for (const entry of cases) {
      stub.setReply(() => ({ status: entry.status, body: { message: "stub" } }))
      const callsBefore = stub.calls.length
      const error = yield* Effect.flip(listRepositoryLabels("octo", "hello", fakeToken, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 2 }))
      expect(error.code).toBe(entry.code)
      expect(error.status).toBe(entry.status)
      expect(error.message).not.toContain(fakeToken)
      expect(encode(error)).not.toContain(fakeToken)
      expect(stub.calls.length - callsBefore).toBe(1)
    }
  }).pipe(Effect.provide(NodeHttpClient.layerFetch)))
  it.live("retries rate limits and server failures with backoff instead of hot retry", () => Effect.gen(function* () {
    const stub = yield* withStub
    let limited = 0
    stub.setReply(() => {
      limited += 1
      if (limited === 1) return { status: 429, body: { message: "slow down" } }
      return { status: 200, body: [{ name: "bug" }] }
    })
    const labels = yield* listRepositoryLabels("octo", "hello", fakeToken, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 2 })
    expect(labels).toEqual(["bug"])
    expect(limited).toBe(2)
    let failed = 0
    stub.setReply(() => {
      failed += 1
      if (failed < 3) return { status: 500, body: { message: "overloaded" } }
      return { status: 200, body: [{ name: "bug" }] }
    })
    const recovered = yield* listRepositoryLabels("octo", "hello", fakeToken, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 2 })
    expect(recovered).toEqual(["bug"])
    expect(failed).toBe(3)
    stub.setReply(() => ({ status: 500, body: { message: "overloaded" } }))
    const callsBefore = stub.calls.length
    const error = yield* Effect.flip(listIssueLabels("octo", "hello", 7, fakeToken, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 1 }))
    expect(error.code).toBe("api")
    expect(error.status).toBe(500)
    expect(stub.calls.length - callsBefore).toBe(2)
  }).pipe(Effect.provide(NodeHttpClient.layerFetch)))
})

describe("github redacted status", () => {
  it.live("reports connection status without exposing the token", () => Effect.gen(function* () {
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "github-token", secretBytes, 0)
    stub.setLabels(["bug", "question"])
    const ok = yield* checkGithubConnection(scope, integration, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 })
    expect(ok).toEqual({ ok: true, configured: true, owner: "octo", repo: "hello", labels: 2 })
    expect(encode(ok)).not.toContain(fakeToken)
    stub.setReply(() => ({ status: 403, body: { message: "denied" } }))
    const denied = yield* checkGithubConnection(scope, integration, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 })
    expect(denied.ok).toBe(false)
    expect(denied.configured).toBe(true)
    expect(denied.code).toBe("forbidden")
    expect(denied.status).toBe(403)
    expect(encode(denied)).not.toContain(fakeToken)
    expect(stub.calls[0]?.authorization).toBe(`Bearer ${fakeToken}`)
  }).pipe(Effect.provide(Live)))
  it.live("reports missing credentials without exposing the token", () => Effect.gen(function* () {
    const stub = yield* withStub
    stub.setLabels(["bug"])
    const options = { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }
    const missing = yield* checkGithubConnection(scope, integration, options)
    expect(missing.ok).toBe(false)
    expect(missing.configured).toBe(false)
    expect(missing.code).toBe("missing-credential")
    expect(encode(missing)).not.toContain(fakeToken)
  }).pipe(Effect.provide(Live)))
})
