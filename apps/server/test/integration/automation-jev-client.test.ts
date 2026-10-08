import { it } from "@effect/vitest"
import { afterEach, describe, expect, vi } from "vitest"
import { Config, ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { checkJevLive, classifyJevWithCredential, jevCredentialStatus } from "../../automation/jev-client.js"
import { makeAutomationDecide } from "../../composition/app.js"
import { startJevStub, stubChoiceBody } from "../fixtures/automation-jev-stub.js"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Configurations = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Credentials = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configurations))
const Live = Layer.mergeAll(Credentials, NodeHttpClient.layerFetch, NodeFileSystem.layer)
const BlockedConfig = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { EXPAND_ZEN_API_KEY_FILE: "/nonexistent-expand-zen-key-for-tests" } }))
const BlockedLayers = Layer.mergeAll(Live, BlockedConfig)

const fakeKey = "stub-zen-key-for-tests-only"
const encoder = new TextEncoder()
const fakeSecret = encoder.encode(fakeKey)
const scope = { ownerId: "jev-owner", projectId: "jev-project" }
const reference = { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "zen-key" }
const request = {
  schemaVersion: 1 as const, kind: "jev-request" as const,
  provider: "opencode-zen" as const, model: "jev" as const, version: "1.13" as const,
  configuration: { routineId: "routine", revision: 1 },
  input: { kind: "input-reference" as const, id: "input" },
  outcomes: ["billing", "technical"],
  data: "My payouts have been failing for three days and I am losing sales."
}
const descriptions = {
  billing: "Payments, invoicing, or refund problems",
  technical: "Bugs, outages, or integration failures"
}
const withStub = Effect.acquireRelease(startJevStub(), (stub) => Effect.sync(() => stub.close()))
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

afterEach(() => vi.unstubAllEnvs())

describe("production automation decision wiring", () => {
  it.live("uses the saved project Zen key without an environment key", () => Effect.gen(function*() {
    vi.stubEnv("OPENCODE_ZEN_API_KEY", undefined)
    vi.stubEnv("OPENCODE_API_KEY", undefined)
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "zen-api-key", fakeSecret, 0)
    stub.setReply(() => ({ status: 200, body: stubChoiceBody("billing", { billing: 0.91, technical: 0.09 }, 0.86) }))
    const decide = makeAutomationDecide(credentials, { endpoint: stub.url, timeoutMs: 5000, maxRetries: 0 })
    const result = yield* decide({ scope, request, descriptions })
    expect(result).toMatchObject({ kind: "selected", outcomeId: "billing" })
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.authorization).toBe(`Bearer ${fakeKey}`)
    expect(encode({ result, statuses: yield* credentials.listStatuses(scope), request: stub.calls[0]?.body })).not.toContain(fakeKey)
  }).pipe(Effect.provide(Live)))
  it.live("uses the owning scope's saved key before environment fallbacks", () => Effect.gen(function*() {
    vi.stubEnv("OPENCODE_ZEN_API_KEY", "environment-zen-key")
    vi.stubEnv("OPENCODE_API_KEY", "environment-opencode-key")
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    const otherOwner = { ...scope, ownerId: "other-owner" }
    const otherProject = { ...scope, projectId: "other-project" }
    yield* credentials.putCredential(scope, "zen-api-key", fakeSecret, 0)
    yield* credentials.putCredential(otherOwner, "zen-api-key", encoder.encode("other-owner-key"), 0)
    yield* credentials.putCredential(otherProject, "zen-api-key", encoder.encode("other-project-key"), 0)
    stub.setReply(() => ({ status: 200, body: stubChoiceBody("billing", { billing: 1, technical: 0 }, 1) }))
    const decide = makeAutomationDecide(credentials, { endpoint: stub.url, timeoutMs: 5000, maxRetries: 0 })
    yield* decide({ scope, request, descriptions })
    yield* decide({ scope: otherOwner, request, descriptions })
    yield* decide({ scope: otherProject, request, descriptions })
    expect(stub.calls.map((call) => call.authorization)).toEqual([
      `Bearer ${fakeKey}`, "Bearer other-owner-key", "Bearer other-project-key"
    ])
  }).pipe(Effect.provide(Live)))
  it.live("does not use a key saved under a different owner or project", () => Effect.gen(function*() {
    vi.stubEnv("OPENCODE_ZEN_API_KEY", undefined)
    vi.stubEnv("OPENCODE_API_KEY", undefined)
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential({ ...scope, ownerId: "other-owner" }, "zen-api-key", fakeSecret, 0)
    yield* credentials.putCredential({ ...scope, projectId: "other-project" }, "zen-api-key", fakeSecret, 0)
    const decide = makeAutomationDecide(credentials, { endpoint: stub.url })
    const error = yield* Effect.flip(decide({ scope, request, descriptions }))
    expect(error).toMatchObject({ code: "missing-credential" })
    expect(encode(error)).not.toContain(fakeKey)
    expect(stub.calls).toHaveLength(0)
  }).pipe(Effect.provide(Live)))
  it.live("retains both environment key fallbacks when the scoped key is absent", () => Effect.gen(function*() {
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    stub.setReply(() => ({ status: 200, body: stubChoiceBody("billing", { billing: 1, technical: 0 }, 1) }))
    const decide = makeAutomationDecide(credentials, { endpoint: stub.url, timeoutMs: 5000, maxRetries: 0 })
    vi.stubEnv("OPENCODE_ZEN_API_KEY", "environment-zen-key")
    vi.stubEnv("OPENCODE_API_KEY", "environment-opencode-key")
    yield* decide({ scope, request, descriptions })
    vi.stubEnv("OPENCODE_ZEN_API_KEY", "")
    yield* decide({ scope, request, descriptions })
    expect(stub.calls.map((call) => call.authorization)).toEqual([
      "Bearer environment-zen-key", "Bearer environment-opencode-key"
    ])
  }).pipe(Effect.provide(Live)))
  it.live("rejects an invalid saved key without using environment credentials", () => Effect.gen(function*() {
    vi.stubEnv("OPENCODE_ZEN_API_KEY", fakeKey)
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "zen-api-key", new Uint8Array([255, 254, 255]), 0)
    const decide = makeAutomationDecide(credentials, { endpoint: stub.url })
    const error = yield* Effect.flip(decide({ scope, request, descriptions }))
    expect(error).toMatchObject({ code: "invalid-credential" })
    expect(encode(error)).not.toContain(fakeKey)
    expect(stub.calls).toHaveLength(0)
  }).pipe(Effect.provide(Live)))
})

describe("jev credential wiring", () => {
  it.live("resolves the Zen key by reference and classifies without persisting secrets", () => Effect.gen(function*() {
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "zen-key", fakeSecret, 0)
    const status = yield* jevCredentialStatus(scope, "zen-key")
    expect(status).toEqual({ credentialId: "zen-key", version: 1, configured: true })
    expect(encode(status)).not.toContain(fakeKey)
    stub.setReply(() => ({ status: 200, body: stubChoiceBody("billing", { billing: 0.91, technical: 0.09 }, 0.86) }))
    const result = yield* classifyJevWithCredential(scope, reference, request, descriptions, { endpoint: stub.url, timeoutMs: 5000, maxRetries: 0 })
    expect(result).toEqual({
      schemaVersion: 1, kind: "selected", outcomeId: "billing",
      data: {
        choice: "billing",
        probabilities: { billing: 0.91, technical: 0.09 }, confidence: 0.86
      }
    })
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.authorization).toBe(`Bearer ${fakeKey}`)
    expect(encode(yield* credentials.listStatuses(scope))).not.toContain(fakeKey)
  }).pipe(Effect.provide(Live)))
  it.live("fails missing credentials before any network request", () => Effect.gen(function*() {
    const stub = yield* withStub
    const error = yield* Effect.flip(classifyJevWithCredential(scope, reference, request, descriptions, { endpoint: stub.url }))
    expect(error.code).toBe("missing-credential")
    expect(error.message).not.toContain("zen-key")
    expect(stub.calls).toHaveLength(0)
    expect(yield* jevCredentialStatus(scope, "zen-key")).toBeNull()
  }).pipe(Effect.provide(Live)))
  it.live("rejects undecodable credential secrets without leaking them", () => Effect.gen(function*() {
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "zen-key", new Uint8Array([255, 254, 255]), 0)
    const error = yield* Effect.flip(classifyJevWithCredential(scope, reference, request, descriptions, { endpoint: stub.url }))
    expect(error.code).toBe("invalid-credential")
    expect(encode(error)).not.toContain(fakeKey)
    expect(stub.calls).toHaveLength(0)
  }).pipe(Effect.provide(Live)))
})

describe("jev live verification", () => {
  it.live("reports blocked checks without credentials and without network", () => Effect.gen(function*() {
    const stub = yield* withStub
    const checked = yield* checkJevLive({ endpoint: stub.url, timeoutMs: 2000, maxRetries: 0 })
    expect(checked).toMatchObject({ ok: false, blocked: true, reason: expect.any(String) })
    expect(checked.reason).toContain("OPENCODE_ZEN_API_KEY")
    expect(stub.calls).toHaveLength(0)
  }).pipe(Effect.provide(BlockedLayers)))
  it.live("records the live Zen outcome once a key is available", () => Effect.gen(function*() {
    const key = yield* Config.option(Config.String("OPENCODE_ZEN_API_KEY"))
    if (Option.isNone(key)) {
      const checked = yield* checkJevLive()
      expect(checked.blocked).toBe(true)
      return
    }
    const checked = yield* checkJevLive({ timeoutMs: 15000, maxRetries: 0 })
    expect(checked.blocked).toBe(false)
    expect(checked.ok).toBe(true)
    expect(typeof checked.latencyMs).toBe("number")
    expect(encode(checked)).not.toContain(key.value)
  }).pipe(Effect.provide(Live)))
})
