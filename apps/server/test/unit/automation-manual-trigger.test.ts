import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { EventBusLayer } from "../../application/event-bus.js"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { AutomationEventStoreLayer } from "../../automation/event-store.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { AutomationRegistryService } from "../../automation/registry-service.js"
import { RoutineServiceLayer } from "../../automation/routine-service.js"
import { encodeJson } from "../../automation/persistence-models.js"
import { automationHandlers } from "../../rpc/automation.js"
import { CustomWebhookCredentialSlot } from "@expand/contracts/automation/custom"
import { makeSampleExtension, sampleRoutine } from "../fixtures/automation-sample-extension.js"
import { NodeHttpClient } from "@effect/platform-node"

const makeLayers = () => {
  const registry = new AutomationRegistry()
  Effect.runSync(registry.register(makeSampleExtension().extension))
  const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
  const Config = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
  const WithCreds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Config))
  const Exec = ExecutionRepositoryLayer.pipe(Layer.provideMerge(WithCreds))
  const Routines = RoutineServiceLayer(registry).pipe(Layer.provideMerge(WithCreds))
  const AutoEvents = AutomationEventStoreLayer.pipe(Layer.provide(Ready))
  const RegistryService = Layer.succeed(AutomationRegistryService, registry)
  const Http = NodeHttpClient.layerFetch
  return Layer.mergeAll(Routines, Exec, WithCreds, EventBusLayer, AutoEvents, RegistryService, Http)
}

const scope = { ownerId: "manual-owner", projectId: "manual-project" } as const
const webhookSecret = "manual-webhook-secret-value"
const mailIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "mail",
  definition: { id: "sample:mail", version: 1 as const },
  configuration: { mailbox: "inbox" },
  credentials: {
    [CustomWebhookCredentialSlot]: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "webhook-secret" },
  },
} as const
const routineConfiguration = { prefix: "Hello" } as const
const validPayload = { subject: "hello", count: "2" } as const

const seedRoutine = Effect.gen(function* () {
  yield* automationHandlers.AutomationCredentialPut({ scope, credentialId: "webhook-secret", secret: webhookSecret })
  yield* automationHandlers.AutomationRoutineCreate({
    scope,
    routineId: "personal-mail",
    template: sampleRoutine.definition,
    configuration: routineConfiguration,
    integrations: [mailIntegration],
    process: sampleRoutine.process,
  })
})

const containsSecret = (value: unknown): boolean => encodeJson(value).includes(webhookSecret)

describe("manual routine start", () => {
  it.live("starts a routine through RPC then deduplicates redelivery with no additional run", () => Effect.gen(function* () {
    yield* seedRoutine
    const first = yield* automationHandlers.AutomationRoutineStart({
      scope,
      routineId: "personal-mail",
      payload: validPayload,
      idempotencyKey: "manual-key-1",
    })
    expect(first.jobIds).toHaveLength(1)
    expect(first.runIds).toHaveLength(1)
    expect(first.deliveryId).toBe("manual-key-1:mail")
    const listed = yield* automationHandlers.AutomationRunList({ scope, limit: 10 })
    expect(listed.runs).toHaveLength(1)
    expect(listed.runs[0]!.run.mode).toBe("live")
    expect(listed.runs[0]!.run.state.kind).toBe("queued")
    expect(listed.runs[0]!.run.authority.integrationIds).toEqual(["mail"])
    expect(containsSecret(first)).toBe(false)
    expect(containsSecret(listed)).toBe(false)
    const history = yield* automationHandlers.AutomationRunGet({ scope, runId: first.runIds[0]! })
    expect(history.run.run.id).toBe(first.runIds[0])
    expect(containsSecret(history)).toBe(false)
    const second = yield* automationHandlers.AutomationRoutineStart({
      scope,
      routineId: "personal-mail",
      payload: validPayload,
      idempotencyKey: "manual-key-1",
    })
    expect(second.jobIds).toEqual(first.jobIds)
    expect(second.runIds).toEqual(first.runIds)
    expect((yield* automationHandlers.AutomationRunList({ scope, limit: 10 })).runs).toHaveLength(1)
  }).pipe(Effect.provide(makeLayers())))

  it.live("rejects unknown routines and invalid payloads naming the failed field without leaking secrets", () => Effect.gen(function* () {
    yield* seedRoutine
    const missing = yield* automationHandlers.AutomationRoutineStart({
      scope,
      routineId: "missing",
      payload: validPayload,
      idempotencyKey: "manual-key-missing",
    }).pipe(Effect.flip)
    expect(missing._tag).toBe("AutomationNotFound")
    const invalid = yield* automationHandlers.AutomationRoutineStart({
      scope,
      routineId: "personal-mail",
      payload: { subject: "hello" },
      idempotencyKey: "manual-key-bad",
    }).pipe(Effect.flip)
    expect(invalid._tag).toBe("AutomationInvalid")
    if (invalid._tag === "AutomationInvalid") {
      expect(invalid.message.length).toBeGreaterThan(0)
      expect(invalid.message).not.toContain(webhookSecret)
    }
    expect((yield* automationHandlers.AutomationRunList({ scope, limit: 10 })).runs).toEqual([])
  }).pipe(Effect.provide(makeLayers())))

  it.live("refuses to start paused routines", () => Effect.gen(function* () {
    yield* seedRoutine
    yield* automationHandlers.AutomationRoutinePause({ scope, routineId: "personal-mail", expectedVersion: 1 })
    const paused = yield* automationHandlers.AutomationRoutineStart({
      scope,
      routineId: "personal-mail",
      payload: validPayload,
      idempotencyKey: "manual-key-paused",
    }).pipe(Effect.flip)
    expect(paused._tag).toBe("AutomationInvalid")
    expect((yield* automationHandlers.AutomationRunList({ scope, limit: 10 })).runs).toEqual([])
  }).pipe(Effect.provide(makeLayers())))
})
