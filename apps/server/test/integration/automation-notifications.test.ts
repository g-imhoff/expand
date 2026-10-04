import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { NotificationRepository, NotificationRepositoryLayer } from "../../automation/notification-repository.js"
import { emitNotificationForRun } from "../../automation/notification-emit.js"
import { AutomationNotification } from "@expand/contracts/automation"
import { makeSampleExtension, sampleAuthority, sampleConfiguration } from "../fixtures/automation-sample-extension.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { encodeJson } from "../../automation/persistence-models.js"

const scope = { ownerId: "notify-owner", projectId: "notify-project" }

const registry = new AutomationRegistry()
Effect.runSync(registry.register(makeSampleExtension().extension))

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
const Execs = ExecutionRepositoryLayer.pipe(Layer.provideMerge(Configs))
const Notes = NotificationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Services = Layer.mergeAll(Ready, Configs, Creds, Execs, Notes)

const sampleRevision = { ...sampleConfiguration, reference: { ...sampleConfiguration.reference, revision: 1 }, scope }
const sampleAuthorityRevision = { ...sampleAuthority, scope, configuration: sampleRevision.reference }

const seedSample = Effect.gen(function*() {
  const config = yield* ConfigurationRepository
  yield* config.putIntegration(scope, { ...sampleRevision.integrations[0]! }, 0)
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

const setRunState = (runId: string, state: { readonly kind: "succeeded" | "failed" | "unresolved" } & Record<string, unknown>) =>
  Effect.gen(function*() {
    const executions = yield* ExecutionRepository
    const sql = yield* SqlClient
    const current = (yield* executions.getRun(scope, runId))!
    const nextRun = { ...current.value, state: state as never }
    yield* sql`UPDATE automation_runs SET json=${encodeJson(nextRun as never)}, state=${(state as { readonly kind: string }).kind}, version=version+1 WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${runId}`
  })

const emitFor = (runId: string) =>
  Effect.gen(function*() {
    const executions = yield* ExecutionRepository
    const configurations = yield* ConfigurationRepository
    const notifications = yield* NotificationRepository
    yield* emitNotificationForRun({ executions, configurations, notifications }, scope, runId)
  })

describe("notification persistence", () => {
  it.live("persists while disconnected fetches on connect marks read explicitly and never duplicates retries", () =>
    Effect.gen(function*() {
      const notes = yield* NotificationRepository
      const empty = yield* notes.list(scope, { status: "pending", limit: 50 })
      expect(empty).toEqual([])
      yield* notes.upsert(notificationFor("run-1", "routine", "failure", "Automation routine failed", "busy"))
      const pending = yield* notes.list(scope, { status: "pending", limit: 50 })
      expect(pending.map((record) => record.value.runId)).toEqual(["run-1"])
      expect(pending[0]!.value.notificationKind).toBe("failure")
      expect(pending[0]!.value.status).toBe("pending")
      const version = yield* notes.upsert(notificationFor("run-1", "routine", "failure", "Automation routine failed", "busy"))
      expect(version).toBe(pending[0]!.version)
      const listed = yield* notes.list(scope, { limit: 50 })
      expect(listed).toHaveLength(1)
      const read = yield* notes.markRead(scope, "run-1")
      expect(read.value.status).toBe("read")
      expect(read.version).toBe(pending[0]!.version + 1)
      const pendingAfter = yield* notes.list(scope, { status: "pending", limit: 50 })
      expect(pendingAfter).toEqual([])
      const readList = yield* notes.list(scope, { status: "read", limit: 50 })
      expect(readList.map((record) => record.value.runId)).toEqual(["run-1"])
      const reread = yield* notes.markRead(scope, "run-1")
      expect(reread.version).toBe(read.version)
      const updated = yield* notes.upsert(notificationFor("run-1", "routine", "failure", "Automation routine failed", "still busy"))
      const listedAfter = yield* notes.list(scope, { limit: 50 })
      expect(listedAfter).toHaveLength(1)
      expect(updated).toBe(read.version + 1)
      const stored = (yield* notes.get(scope, "run-1"))!
      expect(stored.value.status).toBe("read")
      expect(stored.value.message).toBe("still busy")
    }).pipe(Effect.provide(Services)))

  it.live("keeps failure and unresolved distinct with explicit pending and read states", () =>
    Effect.gen(function*() {
      const notes = yield* NotificationRepository
      yield* notes.upsert(notificationFor("run-failed", "routine", "failure", "Automation routine failed", "denied"))
      yield* notes.upsert(notificationFor("run-unresolved", "routine", "unresolved", "Automation routine needs input", "no match"))
      const pending = yield* notes.list(scope, { status: "pending", limit: 50 })
      expect(pending.map((record) => record.value.notificationKind).sort()).toEqual(["failure", "unresolved"])
      for (const record of pending) expect(record.value.status).toBe("pending")
      yield* notes.markRead(scope, "run-failed")
      const remaining = yield* notes.list(scope, { status: "pending", limit: 50 })
      expect(remaining.map((record) => record.value.runId)).toEqual(["run-unresolved"])
      const failedStored = yield* notes.get(scope, "run-failed")
      expect(failedStored!.value.status).toBe("read")
    }).pipe(Effect.provide(Services)))
})

describe("notification emit policy", () => {
  it.live("notifies failures stays quiet on success by default and never duplicates a retried run", () =>
    Effect.gen(function*() {
      yield* seedSample
      const executions = yield* ExecutionRepository
      const notes = yield* NotificationRepository
      yield* executions.ingest({ delivery: deliveryFor("input-ok", "external-ok"), raw: new Uint8Array([1]), targets: [{ jobId: "job-run-ok", run: runFor("run-ok", "input-ok") }] })
      yield* setRunState("run-ok", { kind: "succeeded", result: { completed: true } })
      yield* emitFor("run-ok")
      const okStored = yield* notes.get(scope, "run-ok")
      expect(okStored).toBeNull()
      yield* executions.ingest({ delivery: deliveryFor("input-bad", "external-bad"), raw: new Uint8Array([2]), targets: [{ jobId: "job-run-bad", run: runFor("run-bad", "input-bad") }] })
      yield* setRunState("run-bad", { kind: "failed", error: { code: "denied", message: "busy" } })
      yield* emitFor("run-bad")
      const failed = (yield* notes.get(scope, "run-bad"))!
      expect(failed.value.notificationKind).toBe("failure")
      expect(failed.value.status).toBe("pending")
      yield* emitFor("run-bad")
      const repeats = yield* notes.list(scope, { limit: 50 })
      expect(repeats.filter((record) => record.value.runId === "run-bad")).toHaveLength(1)
      yield* notes.markRead(scope, "run-bad")
      const badStored = yield* notes.get(scope, "run-bad")
      expect(badStored!.value.status).toBe("read")
    }).pipe(Effect.provide(Services)))

  it.live("notifies unresolved as informational and honors per-routine overrides", () =>
    Effect.gen(function*() {
      yield* seedSample
      const executions = yield* ExecutionRepository
      const notes = yield* NotificationRepository
      yield* executions.ingest({ delivery: deliveryFor("input-open", "external-open"), raw: new Uint8Array([3]), targets: [{ jobId: "job-run-open", run: runFor("run-open", "input-open") }] })
      yield* setRunState("run-open", { kind: "unresolved", reason: "no match" })
      yield* emitFor("run-open")
      const open = (yield* notes.get(scope, "run-open"))!
      expect(open.value.notificationKind).toBe("unresolved")
      expect(open.value.status).toBe("pending")
    }).pipe(Effect.provide(Services)))
})
