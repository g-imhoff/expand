import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { HttpClient } from "effect/http"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { AutomationRegistry, AutomationRegistryService } from "../../automation/registry.js"
import { CustomWebhook, CustomWebhookLayer, signCustomDelivery, verifyCustomSignature } from "../../automation/custom-webhook.js"
import type { CustomWebhookInput } from "../../automation/custom-webhook.js"
import { makeSampleExtension } from "../fixtures/automation-sample-extension.js"
import type { IntegrationConfiguration } from "@expand/contracts/automation"

const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
Effect.runSync(registry.register(makeSampleExtension().extension))
const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Config = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const WithCreds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Config))
const WithExec = ExecutionRepositoryLayer.pipe(Layer.provideMerge(WithCreds))
const RegistryLive = Layer.succeed(AutomationRegistryService, registry)
const All = CustomWebhookLayer.pipe(Layer.provideMerge(Layer.mergeAll(WithExec, RegistryLive)))

const scope = { ownerId: "custom-owner", projectId: "custom-project" }
const webhookSecret = "custom-webhook-secret-for-tests-only"
const mailIntegration: IntegrationConfiguration = {
  schemaVersion: 1, kind: "integration-configuration", id: "mail",
  definition: { id: "sample:mail", version: 1 },
  configuration: { mailbox: "inbox" },
  credentials: { webhookSecret: { schemaVersion: 1, kind: "credential-reference", credentialId: "custom-webhook" } }
}
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const rawOf = (value: unknown): Uint8Array => new TextEncoder().encode(encode(value as Schema.Json))
const seed = Effect.gen(function*() {
  const credentials = yield* CredentialRepository
  const configurations = yield* ConfigurationRepository
  yield* credentials.putCredential(scope, "custom-webhook", webhookSecret, 0)
  yield* configurations.putIntegration(scope, mailIntegration, 0)
  yield* configurations.appendRoutineRevision({
    schemaVersion: 1, kind: "routine-configuration",
    reference: { routineId: "custom", revision: 1 },
    scope, configuration: { prefix: "Hello" }, integrations: [mailIntegration],
    process: {
      schemaVersion: 1, kind: "process",
      trigger: {
        definition: { id: "sample:received", version: 1 },
        integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
        configuration: {}
      },
      actions: {
        triggered: [{
          id: "send",
          action: { id: "sample:send", version: 1 },
          integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
          bindings: {
            message: { kind: "field", source: "trigger", path: ["subject"] },
            count: { kind: "field", source: "trigger", path: ["count"] }
          }
        }]
      }
    }
  }, 0, "enabled")
})
const runCount = Effect.gen(function*() {
  const executions = yield* ExecutionRepository
  return (yield* executions.listRuns(scope, { limit: 100 })).items.length
})
const baseInput = (payload: unknown, deliveryId: string, secret: string = webhookSecret): CustomWebhookInput => {
  const raw = rawOf(payload)
  return {
    raw, ownerId: scope.ownerId, projectId: scope.projectId,
    integrationId: "mail", deliveryId, signature: signCustomDelivery(raw, secret)
  }
}

describe("custom webhook signature", () => {
  it.effect("accepts the exact body with the configured secret", () =>
    Effect.sync(() => {
      const raw = rawOf({ subject: "hello", count: "3" })
      expect(verifyCustomSignature(raw, signCustomDelivery(raw, webhookSecret), webhookSecret)).toBe(true)
    }))
  it.effect("rejects tampered bodies and malformed headers", () =>
    Effect.sync(() => {
      const raw = rawOf({ subject: "hello", count: "3" })
      const signature = signCustomDelivery(raw, webhookSecret)
      const tampered = new Uint8Array(raw)
      tampered[5] = (tampered[5]! + 1) % 256
      expect(verifyCustomSignature(tampered, signature, webhookSecret)).toBe(false)
      expect(verifyCustomSignature(raw, signCustomDelivery(raw, "other"), webhookSecret)).toBe(false)
      expect(verifyCustomSignature(raw, undefined, webhookSecret)).toBe(false)
      expect(verifyCustomSignature(raw, "sha256=", webhookSecret)).toBe(false)
      expect(verifyCustomSignature(raw, "md5=deadbeef", webhookSecret)).toBe(false)
      expect(verifyCustomSignature(raw, `${signature}00`, webhookSecret)).toBe(false)
      expect(verifyCustomSignature(raw, signature, "")).toBe(false)
    }))
})

describe("custom webhook delivery", () => {
  it.live("accepts a valid delivery and persists one queued run", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* CustomWebhook
    const executions = yield* ExecutionRepository
    const input = baseInput({ subject: "hello", count: "3" }, "delivery-1")
    expect(yield* webhooks.handle(input)).toEqual({
      status: 200,
      body: { ok: true, deliveryId: "delivery-1", jobIds: ["delivery-1:job:custom"], runIds: ["delivery-1:run:custom"] }
    })
    const stored = yield* executions.getDelivery(scope, "delivery-1")
    expect(stored?.raw).toEqual(input.raw)
    expect(stored?.value).toMatchObject({
      scope, externalId: "delivery-1",
      integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
      trigger: { id: "sample:received", version: 1 },
      payload: { subject: "hello", count: "3" }
    })
    expect((yield* executions.getRun(scope, "delivery-1:run:custom"))?.value).toMatchObject({
      scope, mode: "live", state: { kind: "queued" },
      configuration: { routineId: "custom", revision: 1 },
      input: { kind: "input-reference", id: "delivery-1" }
    })
    expect(encode(yield* webhooks.handle(input))).not.toContain(webhookSecret)
  }).pipe(Effect.provide(All)))
  it.live("treats idempotency-key redeliveries as duplicates", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* CustomWebhook
    const first = baseInput({ subject: "hello", count: "3" }, "delivery-1")
    const accepted = yield* webhooks.handle(first)
    expect(accepted.status).toBe(200)
    expect(yield* webhooks.handle(first)).toEqual(accepted)
    expect(yield* webhooks.handle({ ...first })).toEqual(accepted)
    expect(yield* runCount).toBe(1)
    const second = baseInput({ subject: "again", count: "2" }, "delivery-2")
    expect((yield* webhooks.handle(second)).status).toBe(200)
    expect(yield* runCount).toBe(2)
  }).pipe(Effect.provide(All)))
  it.live("rejects invalid signatures with 401 and creates no jobs", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* CustomWebhook
    const executions = yield* ExecutionRepository
    const valid = baseInput({ subject: "hello", count: "3" }, "delivery-1")
    const tamperedText = encode({ subject: "hello", count: "3" } as Schema.Json).replace("hello", "jello")
    const tamperedRaw = new TextEncoder().encode(tamperedText)
    for (const input of [
      { ...valid, signature: signCustomDelivery(valid.raw, "another-secret") },
      { ...valid, raw: tamperedRaw },
      { ...valid, signature: undefined },
      { ...valid, signature: "sha256=" }
    ]) {
      const response = yield* webhooks.handle(input)
      expect(response.status).toBe(401)
      expect(response.body).toEqual({ ok: false, reason: expect.any(String) })
      expect(encode(response.body)).not.toContain(webhookSecret)
    }
    expect(yield* runCount).toBe(0)
    expect(yield* executions.getDelivery(scope, "delivery-1")).toBeNull()
  }).pipe(Effect.provide(All)))
  it.live("rejects integrations without a webhook secret with 401", () => Effect.gen(function*() {
    const credentials = yield* CredentialRepository
    const configurations = yield* ConfigurationRepository
    const webhooks = yield* CustomWebhook
    yield* credentials.putCredential(scope, "custom-webhook", webhookSecret, 0)
    yield* configurations.putIntegration(scope, { ...mailIntegration, credentials: {} }, 0)
    yield* configurations.appendRoutineRevision({
      schemaVersion: 1, kind: "routine-configuration",
      reference: { routineId: "custom", revision: 1 },
      scope, configuration: { prefix: "Hello" }, integrations: [{ ...mailIntegration, credentials: {} }],
      process: {
        schemaVersion: 1, kind: "process",
        trigger: {
          definition: { id: "sample:received", version: 1 },
          integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
          configuration: {}
        },
        actions: { triggered: [] }
      }
    }, 0, "enabled")
    const response = yield* webhooks.handle(baseInput({ subject: "hello", count: "3" }, "delivery-1"))
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ ok: false, reason: "missing-webhook-secret" })
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
  it.live("ignores unknown integrations and routines with 200 and no job", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* CustomWebhook
    const unknownIntegration = baseInput({ subject: "hello", count: "3" }, "delivery-unknown")
    expect(yield* webhooks.handle({ ...unknownIntegration, integrationId: "missing" })).toEqual({
      status: 200, body: { ok: true, deliveryId: "delivery-unknown", ignored: "unknown-integration" }
    })
    expect(yield* webhooks.handle({ ...unknownIntegration, routineId: "missing" })).toEqual({
      status: 200, body: { ok: true, deliveryId: "delivery-unknown", ignored: "unknown-routine" }
    })
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
  it.live("rejects payloads that fail the trigger schema with field details", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* CustomWebhook
    const missing = yield* webhooks.handle(baseInput({ count: "3" }, "delivery-bad"))
    expect(missing.status).toBe(400)
    expect(missing.body).toMatchObject({ ok: false, reason: "invalid-payload", routineId: "custom" })
    const errors = (missing.body as { errors: Array<{ path: string; message: string }> }).errors
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((entry) => entry.path.includes("subject"))).toBe(true)
    expect(encode(missing.body)).not.toContain(webhookSecret)
    const wrongType = yield* webhooks.handle(baseInput({ subject: "hello", count: "9" }, "delivery-bad-2"))
    expect(wrongType.status).toBe(400)
    expect((wrongType.body as { errors: Array<{ path: string }> }).errors.some((entry) => entry.path.includes("count"))).toBe(true)
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
  it.live("rejects malformed deliveries with 400 and creates no jobs", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* CustomWebhook
    const valid = baseInput({ subject: "hello", count: "3" }, "delivery-1")
    const cases: ReadonlyArray<CustomWebhookInput> = [
      { ...valid, deliveryId: undefined },
      { ...valid, deliveryId: "" },
      { ...valid, integrationId: undefined },
      { ...valid, ownerId: undefined },
      { ...valid, projectId: "" },
      { ...valid, raw: new TextEncoder().encode("not json") }
    ]
    for (const input of cases) expect((yield* webhooks.handle(input)).status).toBe(400)
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
  it.live("ignores paused routines with 200 and no job", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* CustomWebhook
    const configurations = yield* ConfigurationRepository
    yield* configurations.setStatus(scope, "custom", "paused", 1)
    expect(yield* webhooks.handle(baseInput({ subject: "hello", count: "3" }, "delivery-1"))).toEqual({
      status: 200, body: { ok: true, deliveryId: "delivery-1", ignored: "no-matching-routine" }
    })
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
})
