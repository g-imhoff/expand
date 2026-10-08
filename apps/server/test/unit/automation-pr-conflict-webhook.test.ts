import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { createHmac } from "node:crypto"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { SqlClient } from "effect/sql/SqlClient"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { decodePrConflictEvent, makePrConflictWebhookHandler, verifyPrConflictSignature } from "../../automation/pr-conflict-webhook.js"
import type { PrConflictWebhookServices } from "../../automation/pr-conflict-webhook.js"
import { buildPrConflictProcess, makeConflictExtension } from "@expand/contracts/automation/conflicts"

const scope = { ownerId: "conflict-owner", projectId: "conflict-project" }
const secretText = "conflict-webhook-secret"
const secretBytes = new TextEncoder().encode(secretText)
const conflictedBody = {
  action: "synchronize",
  repository: { name: "repo-a", owner: { login: "octo" } },
  pull_request: { number: 7, head: { ref: "feature/conflict-demo", sha: "abc123" }, base: { ref: "develop", sha: "def456" }, mergeable: false, mergeable_state: "dirty" }
}

const registry = new AutomationRegistry()
Effect.runSync(registry.register(makeConflictExtension().extension))
const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer).pipe(Layer.provideMerge(Creds))

const servicesFor = Effect.gen(function*() {
  return {
    services: {
      configurations: yield* ConfigurationRepository,
      credentials: yield* CredentialRepository,
      executions: yield* ExecutionRepository,
      sql: yield* SqlClient
    } satisfies PrConflictWebhookServices,
    routines: yield* RoutineService
  }
})

const seedRoutines = (services: PrConflictWebhookServices, routines: RoutineService["Service"]) =>
  Effect.gen(function*() {
    yield* services.credentials.putCredential(scope, "conflict-token", secretBytes, 0)
    for (const [routineId, repo] of [["resolve-a", "repo-a"], ["resolve-a-second", "repo-a"], ["resolve-b", "repo-b"]] as const) {
      const configuration = { owner: "octo", repo, permittedBranches: ["feature/"], protectedBranches: ["develop", "main"], defaultBranch: "develop" }
      const integration = {
        schemaVersion: 1 as const,
        kind: "integration-configuration" as const,
        id: `conflicts-${repo}`,
        definition: { id: "github:pr-conflict-integration", version: 1 },
        configuration,
        credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "conflict-token" } }
      }
      const process = yield* buildPrConflictProcess(integration.id, configuration)
      yield* routines.create(scope, { routineId, configuration, integrations: [integration], process })
    }
  })

const webhookInput = (deliveryId: string, body: unknown) => {
  const raw = new TextEncoder().encode(JSON.stringify(body))
  const signature = `sha256=${createHmac("sha256", secretBytes).update(raw).digest("hex")}`
  return { deliveryId, event: "pull_request", signature, raw }
}

describe("pr conflict webhook", () => {
  it.effect("parses only conflicted pull_request events", () =>
    Effect.gen(function*() {
      const conflicted = yield* decodePrConflictEvent(conflictedBody)
      expect(conflicted?.pullNumber).toBe(7)
      const clean = yield* decodePrConflictEvent({ ...conflictedBody, pull_request: { ...conflictedBody.pull_request, mergeable: true, mergeable_state: "clean" } })
      expect(clean).toBeNull()
      const ignored = yield* decodePrConflictEvent({ ...conflictedBody, action: "closed" })
      expect(ignored).toBeNull()
    }))
  it.effect("verifies signatures without leaking secrets", () =>
    Effect.gen(function*() {
      const raw = new TextEncoder().encode("{\"action\":\"synchronize\"}")
      const hex = createHmac("sha256", secretBytes).update(raw).digest("hex")
      expect(verifyPrConflictSignature(secretBytes, raw, `sha256=${hex}`)).toBe(true)
      expect(verifyPrConflictSignature(secretBytes, raw, "sha256=00")).toBe(false)
    }))
  it.live("queues only the signed repository despite shared credentials, fans out and deduplicates redelivery", () =>
    Effect.gen(function*() {
      const { services, routines } = yield* servicesFor
      yield* seedRoutines(services, routines)
      const handler = makePrConflictWebhookHandler(services)
      const input = webhookInput("repository-a", { ...conflictedBody, repository: { name: "Repo-A", owner: { login: "Octo" }, extra: true } })
      const first = yield* handler.handle(input)
      expect(first.accepted).toBe(true)
      if (first.accepted) {
        expect(first.jobIds).toHaveLength(2)
        expect(first.runIds).toEqual([
          "repository-a:conflicts-repo-a:resolve-a:run",
          "repository-a:conflicts-repo-a:resolve-a-second:run"
        ])
      }
      expect(yield* services.executions.getDelivery(scope, "repository-a:conflicts-repo-b")).toBeNull()
      const duplicate = yield* handler.handle(input)
      expect(duplicate).toEqual(first)
      const runs = yield* services.executions.listRuns(scope, { limit: 10 })
      expect(runs.items.map((run) => run.value.configuration.routineId).sort()).toEqual(["resolve-a", "resolve-a-second"])
    }).pipe(Effect.provide(Live)))
  it.live("ignores unknown repositories and rejects a bad signature for a matching repository", () =>
    Effect.gen(function*() {
      const { services, routines } = yield* servicesFor
      yield* seedRoutines(services, routines)
      const handler = makePrConflictWebhookHandler(services)
      for (const repository of [{ name: "repo-a", owner: { login: "other" } }, { name: "other", owner: { login: "octo" } }]) {
        expect(yield* handler.handle(webhookInput(`foreign-${repository.name}-${repository.owner.login}`, { ...conflictedBody, repository }))).toEqual({ status: 200, accepted: false })
      }
      expect(yield* handler.handle({ ...webhookInput("bad-signature", conflictedBody), signature: "sha256=00" })).toEqual({ status: 401, accepted: false })
      expect((yield* services.executions.listRuns(scope, { limit: 10 })).items).toEqual([])
    }).pipe(Effect.provide(Live)))
  it.live("requires a valid repository identity before queuing runs", () =>
    Effect.gen(function*() {
      const { services, routines } = yield* servicesFor
      yield* seedRoutines(services, routines)
      const handler = makePrConflictWebhookHandler(services)
      const bodies = [
        { action: conflictedBody.action, pull_request: conflictedBody.pull_request },
        { ...conflictedBody, repository: { name: "repo-a", owner: { login: "" } } },
        { ...conflictedBody, repository: { name: "", owner: { login: "octo" } } },
        { ...conflictedBody, repository: null }
      ]
      for (const [index, body] of bodies.entries()) {
        expect(yield* decodePrConflictEvent(body)).toBeNull()
        expect((yield* handler.handle(webhookInput(`missing-repository-${index}`, body))).accepted).toBe(false)
      }
      expect((yield* services.executions.listRuns(scope, { limit: 10 })).items).toEqual([])
    }).pipe(Effect.provide(Live)))
})
