import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { HttpClient } from "effect/http"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { AutomationRegistry, AutomationRegistryService } from "../../automation/registry.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { previewManual, startManual } from "../../automation/manual-trigger.js"
import { makeSampleExtension } from "../fixtures/automation-sample-extension.js"
import { AutomationError } from "@expand/contracts/automation"
import { StorageError } from "../../automation/persistence-models.js"

const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
Effect.runSync(registry.register(makeSampleExtension().extension))
const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Config = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Config))
const Execs = ExecutionRepositoryLayer.pipe(Layer.provideMerge(Config))
const Routines = RoutineServiceLayer(registry).pipe(Layer.provideMerge(Creds))
const RegistryLive = Layer.succeed(AutomationRegistryService, registry)
const All = Layer.mergeAll(Config, Creds, Execs, Routines, RegistryLive, NodeHttpClient.layerFetch)

const scope = { ownerId: "manual-owner", projectId: "manual-project" }
const mailIntegration = {
  schemaVersion: 1 as const, kind: "integration-configuration" as const, id: "mail",
  definition: { id: "sample:mail" as const, version: 1 as const },
  configuration: { mailbox: "inbox" }, credentials: {}
}
const seed = Effect.gen(function*() {
  const routines = yield* RoutineService
  yield* routines.create(scope, {
    routineId: "custom",
    configuration: { prefix: "Hello" },
    integrations: [mailIntegration],
    process: {
      schemaVersion: 1 as const, kind: "process" as const,
      trigger: {
        definition: { id: "sample:received" as const, version: 1 as const },
        integration: { id: "mail", definition: { id: "sample:mail" as const, version: 1 as const } },
        configuration: {}
      },
      actions: {
        triggered: [{
          id: "send",
          action: { id: "sample:send" as const, version: 1 as const },
          integration: { id: "mail", definition: { id: "sample:mail" as const, version: 1 as const } },
          bindings: {
            message: { kind: "field" as const, source: "trigger" as const, path: ["subject"] },
            count: { kind: "field" as const, source: "trigger" as const, path: ["count"] }
          }
        }]
      }
    }
  })
})
const runCount = Effect.gen(function*() {
  const executions = yield* ExecutionRepository
  return (yield* executions.listRuns(scope, { limit: 100 })).items.length
})
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("manual preview", () => {
  it.live("resolves actions without persisting anything", () => Effect.gen(function*() {
    yield* seed
    const routines = yield* RoutineService
    const executions = yield* ExecutionRepository
    const before = (yield* executions.listRuns(scope, { limit: 100 })).items.length
    const result = yield* previewManual(
      { scope, routineId: "custom", payload: { subject: "hello", count: "3" } },
      { routines, registry }
    )
    expect(result).toEqual({
      routineId: "custom", revision: 1,
      preview: { kind: "selected", outcomeId: "triggered", actions: [{ stepId: "send", arguments: { message: "hello", count: "3" } }] }
    })
    expect((yield* executions.listRuns(scope, { limit: 100 })).items.length).toBe(before)
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
  it.live("rejects invalid payloads with the failing field", () => Effect.gen(function*() {
    yield* seed
    const routines = yield* RoutineService
    const failure = yield* Effect.flip(previewManual(
      { scope, routineId: "custom", payload: { count: "3" } },
      { routines, registry }
    ))
    expect(failure).toBeInstanceOf(AutomationError)
    if (failure instanceof AutomationError) {
      expect(failure.code).toBe("invalid-contract")
      expect(failure.message).toContain("subject")
      expect(failure.message).toContain("custom")
    }
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
  it.live("rejects unknown routines without leaking state", () => Effect.gen(function*() {
    yield* seed
    const routines = yield* RoutineService
    const failure = yield* Effect.flip(previewManual(
      { scope, routineId: "missing", payload: { subject: "hello", count: "3" } },
      { routines, registry }
    ))
    expect(failure).toBeInstanceOf(StorageError)
    expect(encode(failure)).not.toContain("inbox")
  }).pipe(Effect.provide(All)))
})

describe("manual start", () => {
  it.live("ingests a durable live run through the worker path", () => Effect.gen(function*() {
    yield* seed
    const routines = yield* RoutineService
    const executions = yield* ExecutionRepository
    const started = yield* startManual(
      { scope, routineId: "custom", deliveryId: "manual-1", payload: { subject: "hello", count: "3" } },
      { routines, executions, registry }
    )
    expect(started).toEqual({ deliveryId: "manual-1", jobIds: ["manual-1:job:custom"], runIds: ["manual-1:run:custom"] })
    const history = (yield* executions.history(scope, "manual-1:run:custom"))!
    expect(history.run.value.state).toEqual({ kind: "queued" })
    expect(history.run.value.mode).toBe("live")
    expect(history.run.value.authority.integrationIds).toEqual(["mail"])
    expect(yield* startManual(
      { scope, routineId: "custom", deliveryId: "manual-1", payload: { subject: "hello", count: "3" } },
      { routines, executions, registry }
    )).toEqual(started)
    expect(yield* runCount).toBe(1)
  }).pipe(Effect.provide(All)))
  it.live("rejects conflicting payloads on the same idempotency key", () => Effect.gen(function*() {
    yield* seed
    const routines = yield* RoutineService
    const executions = yield* ExecutionRepository
    yield* startManual(
      { scope, routineId: "custom", deliveryId: "manual-1", payload: { subject: "hello", count: "3" } },
      { routines, executions, registry }
    )
    const failure = yield* Effect.flip(startManual(
      { scope, routineId: "custom", deliveryId: "manual-1", payload: { subject: "other", count: "2" } },
      { routines, executions, registry }
    ))
    expect(failure).toBeInstanceOf(StorageError)
    if (failure instanceof StorageError) expect(failure.code).toBe("conflict")
    expect(yield* runCount).toBe(1)
  }).pipe(Effect.provide(All)))
  it.live("refuses to start paused routines", () => Effect.gen(function*() {
    yield* seed
    const routines = yield* RoutineService
    const executions = yield* ExecutionRepository
    yield* routines.pause(scope, "custom", 1)
    const failure = yield* Effect.flip(startManual(
      { scope, routineId: "custom", deliveryId: "manual-1", payload: { subject: "hello", count: "3" } },
      { routines, executions, registry }
    ))
    expect(failure).toBeInstanceOf(StorageError)
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
  it.live("validates manual input with field details", () => Effect.gen(function*() {
    yield* seed
    const routines = yield* RoutineService
    const executions = yield* ExecutionRepository
    const failure = yield* Effect.flip(startManual(
      { scope, routineId: "custom", deliveryId: "manual-1", payload: { subject: "hello", count: "9" } },
      { routines, executions, registry }
    ))
    expect(failure).toBeInstanceOf(AutomationError)
    if (failure instanceof AutomationError) expect(failure.message).toContain("count")
    expect(yield* runCount).toBe(0)
  }).pipe(Effect.provide(All)))
})
