import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { GithubWebhook, GithubWebhookLayer, signGithubDelivery, verifyGithubSignature } from "../../automation/github-webhook.js"
import type { GithubWebhookInput } from "../../automation/github-webhook.js"
import { buildGithubClassificationProcess, githubTemplateReference } from "@expand/contracts/automation/github"
import type { IntegrationConfiguration } from "@expand/contracts/automation"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Config = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const WithCreds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Config))
const WithExec = ExecutionRepositoryLayer.pipe(Layer.provideMerge(WithCreds))
const All = GithubWebhookLayer().pipe(Layer.provideMerge(WithExec))
const Strict = GithubWebhookLayer({ allowedRepos: [{ owner: "elsewhere", repo: "other" }] }).pipe(Layer.provideMerge(WithExec))

const scope = { ownerId: "webhook-owner", projectId: "webhook-project" }
const webhookSecret = "webhook-secret-for-tests-only"
const githubToken = "github-token-for-tests-only"
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
  notifications: { onMatch: true, onNoMatch: false }
}
const githubIntegration: IntegrationConfiguration = {
  schemaVersion: 1, kind: "integration-configuration", id: "github",
  definition: { id: "github:integration", version: 1 },
  configuration: { owner: "octo", repo: "hello" },
  credentials: {
    token: { schemaVersion: 1, kind: "credential-reference", credentialId: "github-token" },
    webhookSecret: { schemaVersion: 1, kind: "credential-reference", credentialId: "github-webhook" }
  }
}
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const rawOf = (value: unknown): Uint8Array => new TextEncoder().encode(encode(value as Schema.Json))
const openedPayload = (issue?: unknown, repository?: unknown): unknown => ({
  action: "opened",
  issue: issue ?? { number: 7, title: "Boom", body: "Details" },
  repository: repository ?? { name: "hello", owner: { login: "octo" } }
})
const seed = Effect.gen(function*() {
  const credentials = yield* CredentialRepository
  const configurations = yield* ConfigurationRepository
  yield* credentials.putCredential(scope, "github-token", githubToken, 0)
  yield* credentials.putCredential(scope, "github-webhook", webhookSecret, 0)
  yield* configurations.putIntegration(scope, githubIntegration, 0)
  const process = yield* buildGithubClassificationProcess("github", classification)
  yield* configurations.appendRoutineRevision({
    schemaVersion: 1, kind: "routine-configuration",
    reference: { routineId: "triage", revision: 1 },
    template: githubTemplateReference, scope,
    configuration: classification, integrations: [githubIntegration], process
  }, 0, "enabled")
})
const runCount = Effect.gen(function*() {
  const executions = yield* ExecutionRepository
  return (yield* executions.listRuns(scope, { limit: 100 })).items.length
})
const signed = (payload: unknown, deliveryId: string, secret: string = webhookSecret): GithubWebhookInput => {
  const raw = rawOf(payload)
  return { raw, event: "issues", deliveryId, signature: signGithubDelivery(raw, secret) }
}

describe("github webhook signature", () => {
  it.effect("accepts the exact body with the configured secret", () =>
    Effect.sync(() => {
      const raw = rawOf(openedPayload())
      expect(verifyGithubSignature(raw, signGithubDelivery(raw, webhookSecret), webhookSecret)).toBe(true)
    }))
  it.effect("rejects a tampered body with the original signature", () =>
    Effect.sync(() => {
      const raw = rawOf(openedPayload())
      const signature = signGithubDelivery(raw, webhookSecret)
      const tampered = new Uint8Array(raw)
      tampered[10] = (tampered[10]! + 1) % 256
      expect(verifyGithubSignature(tampered, signature, webhookSecret)).toBe(false)
    }))
  it.effect("rejects the wrong secret", () =>
    Effect.sync(() => {
      const raw = rawOf(openedPayload())
      expect(verifyGithubSignature(raw, signGithubDelivery(raw, "another-secret"), webhookSecret)).toBe(false)
      expect(verifyGithubSignature(raw, signGithubDelivery(raw, webhookSecret), "another-secret")).toBe(false)
    }))
  it.effect("rejects missing and malformed signature headers", () =>
    Effect.sync(() => {
      const raw = rawOf(openedPayload())
      const valid = signGithubDelivery(raw, webhookSecret)
      expect(valid.startsWith("sha256=")).toBe(true)
      expect(verifyGithubSignature(raw, undefined, webhookSecret)).toBe(false)
      expect(verifyGithubSignature(raw, "", webhookSecret)).toBe(false)
      expect(verifyGithubSignature(raw, "sha256=", webhookSecret)).toBe(false)
      expect(verifyGithubSignature(raw, "md5=deadbeef", webhookSecret)).toBe(false)
      expect(verifyGithubSignature(raw, `${valid}00`, webhookSecret)).toBe(false)
      expect(verifyGithubSignature(raw, valid.slice(0, -1), webhookSecret)).toBe(false)
      expect(verifyGithubSignature(raw, valid, "")).toBe(false)
    }))
})

describe("github webhook delivery", () => {
  it.live("accepts a newly opened issue and persists the delivery plus one queued run", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* GithubWebhook
    const executions = yield* ExecutionRepository
    const input = signed(openedPayload(), "delivery-1")
    expect(yield* webhooks.handle(input)).toEqual({
      status: 200,
      body: { ok: true, deliveryId: "delivery-1", jobIds: ["delivery-1:job:triage"], runIds: ["delivery-1:run:triage"] }
    })
    const stored = yield* executions.getDelivery(scope, "delivery-1")
    expect(stored?.raw).toEqual(input.raw)
    expect(stored?.value).toMatchObject({
      scope, externalId: "delivery-1",
      integration: { id: "github", definition: { id: "github:integration", version: 1 } },
      trigger: { id: "github:issue-opened", version: 1 },
      payload: { issueNumber: 7, title: "Boom", body: "Details" }
    })
    expect((yield* executions.getRun(scope, "delivery-1:run:triage"))?.value).toMatchObject({
      scope, mode: "live", state: { kind: "queued" },
      configuration: { routineId: "triage", revision: 1 },
      input: { kind: "input-reference", id: "delivery-1" }
    })
    expect(yield* executions.getJob(scope, "delivery-1:job:triage")).not.toBeNull()
    expect(encode(yield* webhooks.handle(input))).not.toContain(webhookSecret)
  }).pipe(Effect.provide(All)))
  it.live("treats redeliveries as duplicates and creates no additional runs", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* GithubWebhook
    const first = signed(openedPayload(), "delivery-1")
    const accepted = yield* webhooks.handle(first)
    expect(accepted.status).toBe(200)
    expect(yield* webhooks.handle(first)).toEqual(accepted)
    expect(yield* webhooks.handle({ ...first })).toEqual(accepted)
    expect(yield* runCount).toBe(1)
    const second = signed(openedPayload({ number: 8, title: "Next" }), "delivery-2")
    expect(yield* webhooks.handle(second)).toEqual({
      status: 200,
      body: { ok: true, deliveryId: "delivery-2", jobIds: ["delivery-2:job:triage"], runIds: ["delivery-2:run:triage"] }
    })
    expect(yield* runCount).toBe(2)
  }).pipe(Effect.provide(All)))
  it.live("rejects invalid signatures with 401 and creates no jobs", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* GithubWebhook
    const executions = yield* ExecutionRepository
    const valid = signed(openedPayload(), "delivery-1")
    const tamperedText = encode(openedPayload() as Schema.Json).replace("Boom", "Coom")
    const tamperedRaw = new TextEncoder().encode(tamperedText)
    for (const input of [
      { ...valid, signature: signGithubDelivery(valid.raw, "another-secret") },
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
  it.live("rejects repositories without a configured webhook secret with 401", () => Effect.gen(function*() {
    const credentials = yield* CredentialRepository
    const configurations = yield* ConfigurationRepository
    const webhooks = yield* GithubWebhook
    yield* credentials.putCredential(scope, "github-token", githubToken, 0)
    const { webhookSecret: _removed, ...tokenOnly } = githubIntegration.credentials
    yield* configurations.putIntegration(scope, { ...githubIntegration, credentials: tokenOnly }, 0)
    const process = yield* buildGithubClassificationProcess("github", classification)
    yield* configurations.appendRoutineRevision({
      schemaVersion: 1, kind: "routine-configuration",
      reference: { routineId: "triage", revision: 1 },
      template: githubTemplateReference, scope,
      configuration: classification, integrations: [{ ...githubIntegration, credentials: tokenOnly }], process
    }, 0, "enabled")
    const response = yield* webhooks.handle(signed(openedPayload(), "delivery-1"))
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ ok: false, reason: "missing-webhook-secret" })
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
  it.live("ignores unsupported events and actions with 200 and no job", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* GithubWebhook
    const ping: GithubWebhookInput = { raw: rawOf({ zen: "Keep it logically awesome" }), event: "ping", deliveryId: "delivery-ping", signature: "sha256=unused" }
    expect(yield* webhooks.handle(ping)).toEqual({ status: 200, body: { ok: true, deliveryId: "delivery-ping", ignored: "unsupported-event" } })
    for (const [deliveryId, action] of [["delivery-closed", "closed"], ["delivery-edited", "edited"], ["delivery-labeled", "labeled"]] as const) {
      const input = signed({ ...(openedPayload() as Record<string, unknown>), action }, deliveryId)
      expect(yield* webhooks.handle(input)).toEqual({ status: 200, body: { ok: true, deliveryId, ignored: "unsupported-action" } })
    }
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
  it.live("handles unknown repositories with 200 and no job", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* GithubWebhook
    const input = signed(openedPayload(undefined, { name: "other", owner: { login: "stranger" } }), "delivery-unknown")
    expect(yield* webhooks.handle(input)).toEqual({ status: 200, body: { ok: true, deliveryId: "delivery-unknown", ignored: "unknown-repo" } })
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
  it.live("rejects malformed deliveries with 400 and creates no jobs", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* GithubWebhook
    const valid = signed(openedPayload(), "delivery-1")
    const cases: ReadonlyArray<GithubWebhookInput> = [
      { ...valid, deliveryId: undefined },
      { ...valid, deliveryId: "" },
      { ...valid, event: undefined },
      { ...valid, raw: new TextEncoder().encode("not json") },
      signed({ action: "opened", issue: { number: 7 }, repository: { name: "hello", owner: { login: "octo" } } }, "delivery-bad-shape")
    ]
    for (const input of cases) expect((yield* webhooks.handle(input)).status).toBe(400)
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
  it.live("ignores paused routines with 200 and no job", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* GithubWebhook
    const configurations = yield* ConfigurationRepository
    yield* configurations.setStatus(scope, "triage", "paused", 1)
    expect(yield* webhooks.handle(signed(openedPayload(), "delivery-1"))).toEqual({
      status: 200, body: { ok: true, deliveryId: "delivery-1", ignored: "no-matching-routine" }
    })
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
  it.live("honours the connector allow-list before touching storage", () => Effect.gen(function*() {
    yield* seed
    const webhooks = yield* GithubWebhook
    expect(yield* webhooks.handle(signed(openedPayload(), "delivery-1"))).toEqual({
      status: 200, body: { ok: true, deliveryId: "delivery-1", ignored: "unknown-repo" }
    })
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(Strict)))
})
