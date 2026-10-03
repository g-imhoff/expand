import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { HttpClient } from "effect/http"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { NotificationRepository, NotificationRepositoryLayer } from "../../automation/notification-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { AutomationWorker, AutomationWorkerLayer } from "../../automation/worker.js"
import { AutomationNotification } from "@expand/contracts/automation"
import { makeSampleExtension, sampleAuthority, sampleConfiguration } from "../fixtures/automation-sample-extension.js"

const scope = { ownerId: "notify-owner", projectId: "notify-project" }

const layersFor = (registry: AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>) => {
  const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
  const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
  const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
  const Execs = ExecutionRepositoryLayer.pipe(Layer.provideMerge(Configs))
  const Notes = NotificationRepositoryLayer.pipe(Layer.provideMerge(Ready))
  const Routines = RoutineServiceLayer(registry).pipe(Layer.provide(Layer.mergeAll(Configs, Creds)))
  const Worker = AutomationWorkerLayer(registry, {
    maxAttempts: 2,
    baseBackoffMs: 1,
    attemptTimeoutMs: 5000,
    pollBatchSize: 10,
    concurrency: 2,
    pollIntervalMs: 10,
    jev: {}
  }).pipe(Layer.provide(Layer.mergeAll(Execs, Configs, Creds, Routines, NodeHttpClient.layerFetch)))
  return Layer.mergeAll(Ready, Configs, Creds, Execs, Notes, Routines, Worker, NodeHttpClient.layerFetch)
}

const sampleRevision = { ...sampleConfiguration, reference: { ...sampleConfiguration.reference, revision: 1 }, scope }
const sampleAuthorityRevision = { ...sampleAuthority, scope, configuration: sampleRevision.reference }

const seedSample = Effect.gen(function* () {
  const config = yield* ConfigurationRepository
  yield* config.putIntegration(scope, { ...sampleRevision.integrations[0]!, }, 0)
  yield* config.appendRoutineRevision(sampleRevision, 0, "enabled")
})

const notificationFor = (runId: string, routineId: string, kind: "failure" | "unresolved" | "success", title: string, message: string) =>
  AutomationNotification.make({
    schemaVersion: 1,
    kind: "notification",
    runId,
    routineId,
    scope,
    notificationKind: kind,
    status: "pending",
    title,
    message,
    occurredAt: "2026-10-03T00:00:00.000Z"
  })

describe("notification persistence", () => {
  it.live("persists while disconnected fetches on connect marks read explicitly and never duplicates retries", () =>
    Effect.gen(function* () {
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* registry.register(makeSampleExtension().extension)
      const Services = layersFor(registry)
      yield* Effect.gen(function* () {
        const notes = yield* NotificationRepository
        expect(yield* notes.list(scope, { status: "pending", limit: 50 })).toEqual([])
        yield* notes.upsert(notificationFor("run-1", "routine", "failure", "Automation routine failed", "busy"))
        const pending = yield* notes.list(scope, { status: "pending", limit: 50 })
        expect(pending.map((record) => record.value.runId)).toEqual(["run-1"])
        expect(pending[0]!.value.notificationKind).toBe("failure")
        expect(pending[0]!.value.status).toBe("pending")
        const version = yield* notes.upsert(notificationFor("run-1", "routine", "failure", "Automation routine failed", "busy"))
        expect(version).toBe(pending[0]!.version)
        expect((yield* notes.list(scope, { limit: 50 }))).toHaveLength(1)
        const read = yield* notes.markRead(scope, "run-1")
        expect(read.value.status).toBe("read")
        expect(read.version).toBe(pending[0]!.version + 1)
        expect(yield* notes.list(scope, { status: "pending", limit: 50 })).toEqual([])
        expect((yield* notes.list(scope, { status: "read", limit: 50 })).map((record) => record.value.runId)).toEqual(["run-1"])
        const reread = yield* notes.markRead(scope, "run-1")
        expect(reread.version).toBe(read.version)
        const updated = yield* notes.upsert(notificationFor("run-1", "routine", "failure", "Automation routine failed", "still busy"))
        expect((yield* notes.list(scope, { limit: 50 }))).toHaveLength(1)
        expect(updated).toBe(read.version + 1)
        const stored = (yield* notes.get(scope, "run-1"))!
        expect(stored.value.status).toBe("read")
        expect(stored.value.message).toBe("still busy")
      }).pipe(Effect.provide(Services))
    }))
  it.live("keeps failure and unresolved distinct with explicit pending and read states", () =>
    Effect.gen(function* () {
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* registry.register(makeSampleExtension().extension)
      const Services = layersFor(registry)
      yield* Effect.gen(function* () {
        const notes = yield* NotificationRepository
        yield* notes.upsert(notificationFor("run-failed", "routine", "failure", "Automation routine failed", "denied"))
        yield* notes.upsert(notificationFor("run-unresolved", "routine", "unresolved", "Automation routine needs input", "no match"))
        const pending = yield* notes.list(scope, { status: "pending", limit: 50 })
        expect(pending.map((record) => record.value.notificationKind).sort()).toEqual(["failure", "unresolved"])
        for (const record of pending) expect(record.value.status).toBe("pending")
        yield* notes.markRead(scope, "run-failed")
        expect((yield* notes.list(scope, { status: "pending", limit: 50 })).map((record) => record.value.runId)).toEqual(["run-unresolved"])
        expect((yield* notes.get(scope, "run-failed"))!.value.status).toBe("read")
      }).pipe(Effect.provide(Services))
    }))
})

describe("worker notifications", () => {
  it.live("notifies failures stays quiet on success by default and never duplicates a retried run", () =>
    Effect.gen(function* () {
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* registry.register(makeSampleExtension().extension)
      const Services = layersFor(registry)
      yield* Effect.gen(function* () {
        yield* seedSample
        const executions = yield* ExecutionRepository
        const worker = yield* AutomationWorker
        const notes = yield* NotificationRepository
        const deliveryFor = (id: string, external: string) => ({
          schemaVersion: 1 as const,
          id,
          scope,
          integration: { id: "mail", definition: sampleRevision.integrations[0]!.definition },
          externalId: external,
          trigger: sampleRevision.process.trigger.definition,
          payload: { subject: "hello", count: "3" }
        })
        const runFor = (id: string, deliveryId: string, authority = sampleAuthorityRevision) => ({
          schemaVersion: 1 as const,
          kind: "run" as const,
          id,
          scope,
          configuration: sampleRevision.reference,
          input: { kind: "input-reference" as const, id: deliveryId },
          mode: "live" as const,
          authority,
          state: { kind: "queued" as const },
          actions: []
        })
        yield* executions.ingest({ delivery: deliveryFor("input-ok", "external-ok"), raw: new Uint8Array([1]), targets: [{ jobId: "job-ok", run: runFor("run-ok", "input-ok") }] })
        yield* worker.processRun(scope, "run-ok")
        expect((yield* executions.history(scope, "run-ok"))!.run.value.state.kind).toBe("succeeded")
        expect(yield* notes.get(scope, "run-ok")).toBeNull()
        const denied = { ...sampleAuthorityRevision, actionGrants: [] }
        yield* executions.ingest({ delivery: deliveryFor("input-bad", "external-bad"), raw: new Uint8Array([2]), targets: [{ jobId: "job-bad", run: runFor("run-bad", "input-bad", denied) }] })
        yield* worker.processRun(scope, "run-bad")
        expect((yield* executions.history(scope, "run-bad"))!.run.value.state.kind).toBe("failed")
        const failed = (yield* notes.get(scope, "run-bad"))!
        expect(failed.value.notificationKind).toBe("failure")
        expect(failed.value.status).toBe("pending")
        yield* worker.processRun(scope, "run-bad")
        expect((yield* notes.list(scope, { limit: 50 })).filter((record) => record.value.runId === "run-bad")).toHaveLength(1)
        yield* notes.markRead(scope, "run-bad")
        expect((yield* notes.get(scope, "run-bad"))!.value.status).toBe("read")
      }).pipe(Effect.provide(Services))
    }))
})
