import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { createHmac } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { SqlClient } from "effect/sql/SqlClient"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import {
  GithubWebhookCredentialSlot,
  makeGithubWebhookHandler,
  verifyGithubSignature,
} from "../../automation/github-webhook.js"
import type { GithubWebhookServices } from "../../automation/github-webhook.js"
import {
  buildGithubClassificationProcess,
  githubTemplateReference,
  makeGithubExtension,
} from "@expand/contracts/automation/github"

const registry = new AutomationRegistry()
Effect.runSync(registry.register(makeGithubExtension().extension))

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Config = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const WithCreds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Config))
const WithRoutines = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer).pipe(
  Layer.provideMerge(WithCreds),
)

const Live = Layer.mergeAll(WithRoutines, NodeHttpClient.layerFetch)

const scope = { ownerId: "webhook-owner", projectId: "webhook-project" }
const webhookSecretText = "webhook-secret-for-unit-tests"
const tokenSecretText = "token-secret-for-unit-tests"
const webhookSecretBytes = new TextEncoder().encode(webhookSecretText)
const tokenSecretBytes = new TextEncoder().encode(tokenSecretText)
const githubIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "github",
  definition: { id: "github:integration", version: 1 },
  configuration: { owner: "octo", repo: "hello" },
  credentials: {
    token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "github-token" },
    [GithubWebhookCredentialSlot]: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "github-webhook" },
  },
}
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
  notifications: { onMatch: true, onNoMatch: false },
}

const servicesFor = Effect.gen(function* () {
  const context = yield* Layer.build(Live)
  return {
    services: {
      configurations: Context.get(context, ConfigurationRepository),
      credentials: Context.get(context, CredentialRepository),
      executions: Context.get(context, ExecutionRepository),
      sql: Context.get(context, SqlClient),
    } satisfies GithubWebhookServices,
    routines: Context.get(context, RoutineService),
  }
})

const seedRoutine = (services: GithubWebhookServices, routines: RoutineService["Service"]) =>
  Effect.gen(function* () {
    yield* services.credentials.putCredential(scope, "github-token", tokenSecretBytes, 0)
    yield* services.credentials.putCredential(scope, "github-webhook", webhookSecretBytes, 0)
    const process = yield* buildGithubClassificationProcess("github", classification)
    yield* routines.create(scope, {
      routineId: "triage",
      template: githubTemplateReference,
      configuration: classification,
      integrations: [githubIntegration],
      process,
    })
  })

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const sign = (secret: string, raw: Uint8Array): string => {
  const hex = createHmac("sha256", secret).update(Buffer.from(raw)).digest("hex")
  return `sha256=${hex}`
}

const openedBody = {
  action: "opened",
  repository: { name: "hello", owner: { login: "octo" }, extra: true },
  issue: { number: 7, title: "Boom", body: "Body text", labels: [] },
  extraTop: 1,
}

const rawOf = (value: unknown): Uint8Array => new TextEncoder().encode(encodeJson(value))

describe("github webhook signature", () => {
  it.effect("accepts the correct secret and rejects wrong secrets tampered bodies and missing headers", () =>
    Effect.gen(function* () {
      const raw = new TextEncoder().encode("hello-raw-body")
      const secret = new TextEncoder().encode("correct-secret")
      const other = new TextEncoder().encode("wrong-secret")
      const good = sign("correct-secret", raw)
      expect(verifyGithubSignature(secret, raw, good)).toBe(true)
      expect(verifyGithubSignature(other, raw, good)).toBe(false)
      const tampered = new TextEncoder().encode("hello-raw-bodx")
      expect(verifyGithubSignature(secret, tampered, good)).toBe(false)
      expect(verifyGithubSignature(secret, raw, undefined)).toBe(false)
      expect(verifyGithubSignature(secret, raw, "")).toBe(false)
      expect(verifyGithubSignature(secret, raw, "sha256=xyz")).toBe(false)
      expect(verifyGithubSignature(secret, raw, "md5=abcdef")).toBe(false)
    }))
})

describe("github webhook validation", () => {
  it.live("persists an opened issue then deduplicates redelivery with no additional run", () =>
    servicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* seedRoutine(services, routines)
          const handler = makeGithubWebhookHandler(services)
          const raw = rawOf(openedBody)
          const deliveryId = "delivery-1"
          const first = yield* handler.handle({
            deliveryId,
            event: "issues",
            signature: sign(webhookSecretText, raw),
            raw,
          })
          expect(first.status).toBe(200)
          expect(first.accepted).toBe(true)
          if (first.accepted) {
            expect(first.jobIds).toHaveLength(1)
            expect(first.runIds).toHaveLength(1)
          }
          const stored = yield* services.executions.getDelivery(scope, `${deliveryId}:github`)
          expect(stored !== null).toBe(true)
          expect(stored?.value.externalId).toBe(deliveryId)
          expect([...(stored?.raw ?? [])]).toEqual([...raw])
          const second = yield* handler.handle({
            deliveryId,
            event: "issues",
            signature: sign(webhookSecretText, raw),
            raw,
          })
          expect(second.status).toBe(200)
          expect(second.accepted).toBe(true)
          if (first.accepted && second.accepted) {
            expect(second.jobIds).toEqual(first.jobIds)
            expect(second.runIds).toEqual(first.runIds)
          }
          const runs = yield* services.executions.listRuns(scope, { limit: 10 })
          expect(runs.items).toHaveLength(1)
        }),
      ),
      Effect.provide(Live),
    ),
  )
  it.live("fans out to every routine on the same integration and deduplicates redelivery", () =>
    servicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* services.credentials.putCredential(scope, "github-token", tokenSecretBytes, 0)
          yield* services.credentials.putCredential(scope, "github-webhook", webhookSecretBytes, 0)
          for (const routineId of ["triage", "triage-second"]) {
            const process = yield* buildGithubClassificationProcess("github", classification)
            yield* routines.create(scope, {
              routineId,
              template: githubTemplateReference,
              configuration: classification,
              integrations: [githubIntegration],
              process,
            })
          }
          const handler = makeGithubWebhookHandler(services)
          const raw = rawOf(openedBody)
          const deliveryId = "delivery-fanout-1"
          const first = yield* handler.handle({
            deliveryId,
            event: "issues",
            signature: sign(webhookSecretText, raw),
            raw,
          })
          expect(first.status).toBe(200)
          expect(first.accepted).toBe(true)
          if (first.accepted) {
            expect(first.jobIds).toHaveLength(2)
            expect(first.runIds).toHaveLength(2)
          }
          const runsBefore = yield* services.executions.listRuns(scope, { limit: 10 })
          expect(runsBefore.items).toHaveLength(2)
          const second = yield* handler.handle({
            deliveryId,
            event: "issues",
            signature: sign(webhookSecretText, raw),
            raw,
          })
          expect(second.status).toBe(200)
          expect(second.accepted).toBe(true)
          if (first.accepted && second.accepted) {
            expect(second.jobIds).toEqual(first.jobIds)
            expect(second.runIds).toEqual(first.runIds)
          }
          const runsAfter = yield* services.executions.listRuns(scope, { limit: 10 })
          expect(runsAfter.items).toHaveLength(2)
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
          const handler = makeGithubWebhookHandler(services)
          const raw = rawOf(openedBody)
          const cases = [
            { deliveryId: "bad-1", signature: sign("wrong-secret", raw), raw },
            { deliveryId: "bad-2", signature: sign(webhookSecretText, new TextEncoder().encode("other")), raw },
            { deliveryId: "bad-3", signature: undefined, raw },
            { deliveryId: "", signature: sign(webhookSecretText, raw), raw },
          ]
          for (const input of cases) {
            const outcome = yield* handler.handle({ ...input, event: "issues" })
            expect(outcome).toEqual({ status: 401, accepted: false })
          }
          const runs = yield* services.executions.listRuns(scope, { limit: 10 })
          expect(runs.items).toEqual([])
        }),
      ),
      Effect.provide(Live),
    ),
  )
  it.live("ignores unsupported events and actions with 200 and no job", () =>
    servicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* seedRoutine(services, routines)
          const handler = makeGithubWebhookHandler(services)
          const pingRaw = rawOf({ zen: "hello", hook_id: 1 })
          const ping = yield* handler.handle({
            deliveryId: "ping-1",
            event: "ping",
            signature: sign(webhookSecretText, pingRaw),
            raw: pingRaw,
          })
          expect(ping).toEqual({ status: 200, accepted: false })
          const editedRaw = rawOf({ ...openedBody, action: "edited" })
          const edited = yield* handler.handle({
            deliveryId: "edited-1",
            event: "issues",
            signature: sign(webhookSecretText, editedRaw),
            raw: editedRaw,
          })
          expect(edited).toEqual({ status: 200, accepted: false })
          const malformedRaw = new TextEncoder().encode("not-json")
          const malformed = yield* handler.handle({
            deliveryId: "malformed-1",
            event: "issues",
            signature: sign(webhookSecretText, malformedRaw),
            raw: malformedRaw,
          })
          expect(malformed).toEqual({ status: 401, accepted: false })
          const runs = yield* services.executions.listRuns(scope, { limit: 10 })
          expect(runs.items).toEqual([])
        }),
      ),
      Effect.provide(Live),
    ),
  )
  it.live("ignores unknown repositories and routines without matching triggers with 200 and no job", () =>
    servicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* seedRoutine(services, routines)
          const handler = makeGithubWebhookHandler(services)
          const foreignBody = {
            ...openedBody,
            repository: { name: "other", owner: { login: "octo" } },
          }
          const foreignRaw = rawOf(foreignBody)
          const foreign = yield* handler.handle({
            deliveryId: "foreign-1",
            event: "issues",
            signature: sign(webhookSecretText, foreignRaw),
            raw: foreignRaw,
          })
          expect(foreign).toEqual({ status: 200, accepted: false })
          yield* routines.pause(scope, "triage", 1)
          const raw = rawOf(openedBody)
          const paused = yield* handler.handle({
            deliveryId: "paused-1",
            event: "issues",
            signature: sign(webhookSecretText, raw),
            raw,
          })
          expect(paused).toEqual({ status: 200, accepted: false })
          const runs = yield* services.executions.listRuns(scope, { limit: 10 })
          expect(runs.items).toEqual([])
        }),
      ),
      Effect.provide(Live),
    ),
  )
})
