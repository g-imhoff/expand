import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { createHmac } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { SqlClient } from "effect/sql/SqlClient"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { makeCustomWebhookHandler, verifyCustomSignature } from "../../automation/custom-webhook.js"
import { makeManualStartHandler } from "../../automation/manual-trigger.js"
import type { CustomWebhookServices } from "../../automation/custom-webhook.js"
import { CustomWebhookCredentialSlot } from "@expand/contracts/automation/custom"
import { makeSampleExtension, sampleRoutine } from "../fixtures/automation-sample-extension.js"

const registry = new AutomationRegistry()
Effect.runSync(registry.register(makeSampleExtension().extension))

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Config = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const WithCreds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Config))
const WithRoutines = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer).pipe(
  Layer.provideMerge(WithCreds),
)
const Live = WithRoutines

const scope = { ownerId: "custom-owner", projectId: "custom-project" }
const webhookSecretText = "custom-webhook-secret-value"
const webhookSecretBytes = new TextEncoder().encode(webhookSecretText)
const mailIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "mail",
  definition: { id: "sample:mail", version: 1 },
  configuration: { mailbox: "inbox" },
  credentials: {
    [CustomWebhookCredentialSlot]: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "webhook-secret" },
  },
}
const routineConfiguration = { prefix: "Hello" }

const servicesFor = Effect.gen(function* () {
  const context = yield* Layer.build(Live)
  return {
    services: {
      configurations: Context.get(context, ConfigurationRepository),
      credentials: Context.get(context, CredentialRepository),
      executions: Context.get(context, ExecutionRepository),
    } satisfies CustomWebhookServices,
    routines: Context.get(context, RoutineService),
  }
})

const seedRoutine = (services: CustomWebhookServices, routines: RoutineService["Service"]) =>
  Effect.gen(function* () {
    yield* services.credentials.putCredential(scope, "webhook-secret", webhookSecretBytes, 0)
    yield* routines.create(scope, {
      routineId: "personal-mail",
      template: sampleRoutine.definition,
      configuration: routineConfiguration,
      integrations: [mailIntegration],
      process: sampleRoutine.process,
    })
  })

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const sign = (secret: string, raw: Uint8Array): string => {
  const hex = createHmac("sha256", secret).update(Buffer.from(raw)).digest("hex")
  return `sha256=${hex}`
}

const rawOf = (value: unknown): Uint8Array => new TextEncoder().encode(encodeJson(value))

const validBody = { routineId: "personal-mail", payload: { subject: "hello", count: "2" } }

describe("custom webhook signature", () => {
  it.effect("accepts the correct secret and rejects wrong secrets tampered bodies and missing headers", () =>
    Effect.gen(function* () {
      const raw = new TextEncoder().encode("custom-raw-body")
      const secret = new TextEncoder().encode("correct-secret")
      const other = new TextEncoder().encode("wrong-secret")
      const good = sign("correct-secret", raw)
      expect(verifyCustomSignature(secret, raw, good)).toBe(true)
      expect(verifyCustomSignature(other, raw, good)).toBe(false)
      const tampered = new TextEncoder().encode("custom-raw-bodx")
      expect(verifyCustomSignature(secret, tampered, good)).toBe(false)
      expect(verifyCustomSignature(secret, raw, undefined)).toBe(false)
      expect(verifyCustomSignature(secret, raw, "")).toBe(false)
      expect(verifyCustomSignature(secret, raw, "sha256=xyz")).toBe(false)
      expect(verifyCustomSignature(secret, raw, "md5=abcdef")).toBe(false)
    }))
})

describe("custom webhook validation", () => {
  it.live("persists a valid delivery then deduplicates redelivery with no additional run", () =>
    servicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* seedRoutine(services, routines)
          const handler = makeCustomWebhookHandler(services, registry)
          const raw = rawOf(validBody)
          const first = yield* handler.handle({
            ownerId: scope.ownerId,
            projectId: scope.projectId,
            integrationId: "mail",
            deliveryId: "caller-key-1",
            signature: sign(webhookSecretText, raw),
            raw,
          })
          expect(first.status).toBe(200)
          expect(first.accepted).toBe(true)
          if (first.status === 200 && first.accepted) {
            expect(first.jobIds).toHaveLength(1)
            expect(first.runIds).toHaveLength(1)
          }
          const stored = yield* services.executions.getDelivery(scope, "custom:caller-key-1:mail")
          expect(stored !== null).toBe(true)
          expect(stored?.value.externalId).toBe("custom:caller-key-1")
          expect([...(stored?.raw ?? [])]).toEqual([...raw])
          const second = yield* handler.handle({
            ownerId: scope.ownerId,
            projectId: scope.projectId,
            integrationId: "mail",
            deliveryId: "caller-key-1",
            signature: sign(webhookSecretText, raw),
            raw,
          })
          expect(second.status).toBe(200)
          expect(second.accepted).toBe(true)
          if (first.status === 200 && first.accepted && second.status === 200 && second.accepted) {
            expect(second.jobIds).toEqual(first.jobIds)
            expect(second.runIds).toEqual(first.runIds)
          }
          const runs = yield* services.executions.listRuns(scope, { limit: 10 })
          expect(runs.items).toHaveLength(1)
          const run = runs.items[0]!.value
          expect(run.mode).toBe("live")
          expect(run.state.kind).toBe("queued")
          expect(run.authority.integrationIds).toEqual(["mail"])
          expect(run.authority.actionGrants).toHaveLength(1)
          expect(run.authority.actionGrants[0]!.capabilities).toEqual(["send"])
        }),
      ),
      Effect.provide(Live),
    ),
  )
  it.live("rejects invalid signatures with 401 and creates no jobs", () =>
    servicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* seedRoutine(services, routines)
          const handler = makeCustomWebhookHandler(services, registry)
          const raw = rawOf(validBody)
          const cases = [
            { deliveryId: "bad-1", signature: sign("wrong-secret", raw) },
            { deliveryId: "bad-2", signature: sign(webhookSecretText, new TextEncoder().encode("other")) },
            { deliveryId: "bad-3", signature: undefined },
            { deliveryId: "", signature: sign(webhookSecretText, raw) },
          ]
          for (const input of cases) {
            const outcome = yield* handler.handle({
              ownerId: scope.ownerId,
              projectId: scope.projectId,
              integrationId: "mail",
              deliveryId: input.deliveryId,
              signature: input.signature,
              raw,
            })
            expect(outcome.status).toBe(input.deliveryId === "" ? 400 : 401)
            expect(outcome.accepted).toBe(false)
          }
          const runs = yield* services.executions.listRuns(scope, { limit: 10 })
          expect(runs.items).toEqual([])
        }),
      ),
      Effect.provide(Live),
    ),
  )
  it.live("rejects delivery keys containing separators with 400 and creates no jobs", () =>
    servicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* seedRoutine(services, routines)
          const handler = makeCustomWebhookHandler(services, registry)
          const raw = rawOf(validBody)
          const outcome = yield* handler.handle({
            ownerId: scope.ownerId,
            projectId: scope.projectId,
            integrationId: "mail",
            deliveryId: "key:with-separator",
            signature: sign(webhookSecretText, raw),
            raw,
          })
          expect(outcome).toEqual({ status: 400, accepted: false, field: "deliveryId", message: "deliveryId is not usable" })
          const runs = yield* services.executions.listRuns(scope, { limit: 10 })
          expect(runs.items).toEqual([])
        }),
      ),
      Effect.provide(Live),
    ),
  )
  it.live("returns 404 for unknown integration and unknown routine", () =>
    servicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* seedRoutine(services, routines)
          const handler = makeCustomWebhookHandler(services, registry)
          const raw = rawOf(validBody)
          const unknownIntegration = yield* handler.handle({
            ownerId: scope.ownerId,
            projectId: scope.projectId,
            integrationId: "missing",
            deliveryId: "key-unknown-integration",
            signature: sign(webhookSecretText, raw),
            raw,
          })
          expect(unknownIntegration.status).toBe(404)
          const foreignBody = { routineId: "missing-routine", payload: { subject: "hello", count: "2" } }
          const foreignRaw = rawOf(foreignBody)
          const unknownRoutine = yield* handler.handle({
            ownerId: scope.ownerId,
            projectId: scope.projectId,
            integrationId: "mail",
            deliveryId: "key-unknown-routine",
            signature: sign(webhookSecretText, foreignRaw),
            raw: foreignRaw,
          })
          expect(unknownRoutine.status).toBe(404)
          const runs = yield* services.executions.listRuns(scope, { limit: 10 })
          expect(runs.items).toEqual([])
        }),
      ),
      Effect.provide(Live),
    ),
  )
  it.live("returns 400 naming the failed field without leaking secrets", () =>
    servicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* seedRoutine(services, routines)
          const handler = makeCustomWebhookHandler(services, registry)
          const badBody = { routineId: "personal-mail", payload: { subject: "hello" } }
          const badRaw = rawOf(badBody)
          const bad = yield* handler.handle({
            ownerId: scope.ownerId,
            projectId: scope.projectId,
            integrationId: "mail",
            deliveryId: "key-bad-payload",
            signature: sign(webhookSecretText, badRaw),
            raw: badRaw,
          })
          expect(bad.status).toBe(400)
          if (bad.status === 400) {
            expect(bad.field.length).toBeGreaterThan(0)
            expect(bad.message).toContain(bad.field)
            expect(bad.message).not.toContain(webhookSecretText)
            expect(encodeJson(bad)).not.toContain(webhookSecretText)
          }
          const missingRoutineBody = { payload: { subject: "hello", count: "2" } }
          const missingRaw = rawOf(missingRoutineBody)
          const missing = yield* handler.handle({
            ownerId: scope.ownerId,
            projectId: scope.projectId,
            integrationId: "mail",
            deliveryId: "key-missing-routine",
            signature: sign(webhookSecretText, missingRaw),
            raw: missingRaw,
          })
          expect(missing.status).toBe(400)
          if (missing.status === 400) expect(missing.field).toBe("routineId")
          const runs = yield* services.executions.listRuns(scope, { limit: 10 })
          expect(runs.items).toEqual([])
        }),
      ),
      Effect.provide(Live),
    ),
  )
  it.live("does not collide with manual starts using the same bare key", () =>
    servicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* seedRoutine(services, routines)
          const handler = makeCustomWebhookHandler(services, registry)
          const starter = makeManualStartHandler(
            { routines, executions: services.executions },
            registry,
          )
          const raw = rawOf(validBody)
          const webhook = yield* handler.handle({
            ownerId: scope.ownerId,
            projectId: scope.projectId,
            integrationId: "mail",
            deliveryId: "shared-key",
            signature: sign(webhookSecretText, raw),
            raw,
          })
          expect(webhook.accepted).toBe(true)
          const manual = yield* starter.start({
            scope,
            routineId: "personal-mail",
            payload: validBody.payload,
            idempotencyKey: "shared-key",
          })
          expect(manual.jobIds).toHaveLength(1)
          if (webhook.status === 200 && webhook.accepted) {
            expect(manual.jobIds).not.toEqual([...webhook.jobIds])
          }
          const runs = yield* services.executions.listRuns(scope, { limit: 10 })
          expect(runs.items).toHaveLength(2)
        }),
      ),
      Effect.provide(Live),
    ),
  )
  it.live("ignores paused routines with 200 and no job and conflicts on reused keys with different input", () =>
    servicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* seedRoutine(services, routines)
          const handler = makeCustomWebhookHandler(services, registry)
          yield* routines.pause(scope, "personal-mail", 1)
          const raw = rawOf(validBody)
          const paused = yield* handler.handle({
            ownerId: scope.ownerId,
            projectId: scope.projectId,
            integrationId: "mail",
            deliveryId: "key-paused",
            signature: sign(webhookSecretText, raw),
            raw,
          })
          expect(paused).toEqual({ status: 200, accepted: false })
          yield* routines.enable(scope, "personal-mail", 2)
          const firstRaw = rawOf(validBody)
          const first = yield* handler.handle({
            ownerId: scope.ownerId,
            projectId: scope.projectId,
            integrationId: "mail",
            deliveryId: "key-conflict",
            signature: sign(webhookSecretText, firstRaw),
            raw: firstRaw,
          })
          expect(first.accepted).toBe(true)
          const otherBody = { routineId: "personal-mail", payload: { subject: "other", count: "3" } }
          const otherRaw = rawOf(otherBody)
          const conflict = yield* handler.handle({
            ownerId: scope.ownerId,
            projectId: scope.projectId,
            integrationId: "mail",
            deliveryId: "key-conflict",
            signature: sign(webhookSecretText, otherRaw),
            raw: otherRaw,
          })
          expect(conflict.status).toBe(409)
          const runs = yield* services.executions.listRuns(scope, { limit: 10 })
          expect(runs.items).toHaveLength(1)
        }),
      ),
      Effect.provide(Live),
    ),
  )
})
