import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, PubSub, Stream } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { HttpClient } from "effect/http"
import { EventBus, EventBusLayer } from "@expand/server/application/event-bus"
import { ReplayFeed, ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { AutomationEventStoreLayer } from "../../automation/event-store.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { makeGithubServerExtension } from "../../automation/github-client.js"
import { AutomationRegistry, AutomationRegistryService } from "../../automation/registry.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { automationHandlers } from "../../rpc/automation.js"
import {
  buildGithubClassificationProcess,
  githubIntegrationReference,
  githubLabelActionReference,
  githubTemplateReference,
  githubTriggerReference
} from "@expand/contracts/automation/github"

const scope = { ownerId: "person", projectId: "project" }
const otherProject = { ownerId: "person", projectId: "other" }
const otherOwner = { ownerId: "other", projectId: "project" }
const secret = "rpc-handler-secret-for-tests-only"
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
  notifications: { onMatch: true, onNoMatch: false }
}
const githubIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "github",
  definition: { id: "github:integration" as const, version: 1 as const },
  configuration: { owner: "octo", repo: "hello" },
  credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "github-token" } }
}

const registry = new AutomationRegistry<CredentialRepository | ConfigurationRepository | HttpClient.HttpClient>()
Effect.runSync(registry.register(makeGithubServerExtension({}).extension))
const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Config = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Config))
const Execs = ExecutionRepositoryLayer.pipe(Layer.provideMerge(Config))
const Routines = RoutineServiceLayer(registry).pipe(Layer.provideMerge(Creds))
const Events = AutomationEventStoreLayer.pipe(Layer.provideMerge(Ready))
const Feed = ReplayFeedLayer.pipe(Layer.provideMerge(Ready))
const All = Layer.mergeAll(
  Config,
  Creds,
  Execs,
  Routines,
  Events,
  Feed,
  EventBusLayer,
  Layer.succeed(AutomationRegistryService, registry),
  NodeHttpClient.layerFetch
)

const triageInput = Effect.gen(function*() {
  const process = yield* buildGithubClassificationProcess("github", classification)
  return {
    scope,
    routineId: "triage",
    template: githubTemplateReference,
    configuration: classification,
    integrations: [githubIntegration],
    process
  }
})

const seed = Effect.gen(function*() {
  const credentials = yield* CredentialRepository
  yield* credentials.putCredential(scope, "github-token", secret, 0)
  yield* automationHandlers.AutomationRoutineCreate(yield* triageInput)
})

const containsSecret = (value: unknown): boolean => {
  if (value === secret) return true
  if (Array.isArray(value)) return value.some(containsSecret)
  if (value !== null && typeof value === "object") return Object.values(value).some(containsSecret)
  return false
}

const ingestRun = Effect.fn("AutomationRpcTest.ingestRun")(function*(
  runId: string,
  routineId: string,
  mode: "preview" | "live"
) {
  const executions = yield* ExecutionRepository
  const delivery = {
    schemaVersion: 1 as const,
    id: `delivery-${runId}`,
    scope,
    integration: { id: "github", definition: githubIntegrationReference },
    externalId: `external-${runId}`,
    trigger: githubTriggerReference,
    payload: { issueNumber: 7, title: "Boom", body: "Details" }
  }
  const run = {
    schemaVersion: 1 as const,
    kind: "run" as const,
    id: runId,
    scope,
    configuration: { routineId, revision: 1 as const },
    input: { kind: "input-reference" as const, id: delivery.id },
    mode,
    authority: {
      schemaVersion: 1 as const,
      kind: "invocation-authority" as const,
      scope,
      configuration: { routineId, revision: 1 as const },
      integrationIds: ["github"],
      actionGrants: [{ action: githubLabelActionReference, integrationId: "github", capabilities: ["label"] }]
    },
    state: { kind: "queued" as const },
    actions: []
  }
  yield* executions.ingest({ delivery, raw: new Uint8Array([1, 2, 3]), targets: [{ jobId: `job-${runId}`, run }] })
})

const setRunState = Effect.fn("AutomationRpcTest.setRunState")(function*(
  runId: string,
  state: { readonly kind: "running" } | { readonly kind: "cancelled"; readonly reason: string }
) {
  const executions = yield* ExecutionRepository
  const run = (yield* executions.getRun(scope, runId))!
  const job = (yield* executions.getJob(scope, `job-${runId}`))!
  const nextRun = { ...run.value, state }
  const nextJob = { ...job.value, state }
  yield* executions.update(scope, {
    expectedRunVersion: run.version,
    expectedJobVersion: job.version,
    run: nextRun,
    job: nextJob
  })
})

describe("automation routine RPC lifecycle", () => {
  it.live("creates edits pauses enables lists and deletes through RPC handlers", () =>
    Effect.gen(function*() {
      yield* seed
      const created = yield* automationHandlers.AutomationRoutineGet({ scope, routineId: "triage" })
      expect(created.head).toEqual({ revision: 1, version: 1, status: "enabled" })
      expect(created.credentials).toEqual([{ credentialId: "github-token", version: 1, configured: true }])
      expect(containsSecret(created)).toBe(false)

      const edited = { ...classification, notifications: { onMatch: false, onNoMatch: true } }
      const process = yield* buildGithubClassificationProcess("github", edited)
      expect(yield* automationHandlers.AutomationRoutineEdit({
        scope,
        routineId: "triage",
        template: githubTemplateReference,
        configuration: edited,
        integrations: [githubIntegration],
        process
      })).toEqual({ revision: 2 })

      const stale = yield* Effect.flip(automationHandlers.AutomationRoutinePause({ scope, routineId: "triage", expectedVersion: 1 }))
      expect(stale._tag).toBe("AutomationConflict")
      expect(yield* automationHandlers.AutomationRoutinePause({ scope, routineId: "triage", expectedVersion: 2 })).toMatchObject({
        revision: 2,
        status: "paused",
        version: 3
      })
      expect(yield* automationHandlers.AutomationRoutineEnable({ scope, routineId: "triage", expectedVersion: 3 })).toMatchObject({
        status: "enabled",
        version: 4
      })
      expect((yield* automationHandlers.AutomationRoutineList({ scope })).routines.map((routine) => routine.routineId)).toEqual(["triage"])
      expect(yield* automationHandlers.AutomationRoutineDelete({ scope, routineId: "triage", expectedVersion: 4 })).toMatchObject({
        status: "deleted",
        version: 5
      })
      const missing = yield* Effect.flip(automationHandlers.AutomationRoutineGet({ scope, routineId: "absent" }))
      expect(missing._tag).toBe("AutomationNotFound")
      const duplicate = yield* Effect.flip(automationHandlers.AutomationRoutineCreate(yield* triageInput))
      expect(duplicate._tag).toBe("AutomationConflict")
    }).pipe(Effect.provide(All)))

  it.live("rejects cross-scope reads without leaking routines", () =>
    Effect.gen(function*() {
      yield* seed
      for (const other of [otherProject, otherOwner]) {
        expect((yield* Effect.flip(automationHandlers.AutomationRoutineGet({ scope: other, routineId: "triage" })))).toMatchObject({
          _tag: "AutomationNotFound"
        })
        expect((yield* automationHandlers.AutomationRoutineList({ scope: other })).routines).toEqual([])
        expect((yield* automationHandlers.AutomationCredentialList({ scope: other })).credentials).toEqual([])
        expect((yield* automationHandlers.AutomationRunList({ scope: other, limit: 10 })).runs).toEqual([])
      }
      expect((yield* automationHandlers.AutomationRoutineList({ scope })).routines).toHaveLength(1)
    }).pipe(Effect.provide(All)))
})

describe("automation credential and integration RPCs", () => {
  it.live("writes secrets by reference and never returns them", () =>
    Effect.gen(function*() {
      const credentials = yield* CredentialRepository
      yield* credentials.putCredential(scope, "github-token", secret, 0)
      const stored = yield* automationHandlers.AutomationCredentialPut({
        scope,
        credentialId: "github-token",
        secret: "rotated-secret",
        expectedVersion: 1
      })
      expect(stored).toEqual({ credentialId: "github-token", version: 2, configured: true })
      expect(containsSecret(stored)).toBe(false)
      const listed = yield* automationHandlers.AutomationCredentialList({ scope })
      expect(listed.credentials).toEqual([{ credentialId: "github-token", version: 2, configured: true }])
      expect(containsSecret(listed)).toBe(false)
      expect(yield* automationHandlers.AutomationCredentialRemove({ scope, credentialId: "github-token", expectedVersion: 2 })).toEqual({
        removed: true
      })
      expect((yield* automationHandlers.AutomationCredentialList({ scope })).credentials).toEqual([])
    }).pipe(Effect.provide(All)))

  it.live("stores GitHub integrations and reports redacted connection status", () =>
    Effect.gen(function*() {
      const credentials = yield* CredentialRepository
      yield* credentials.putCredential(scope, "github-token", secret, 0)
      expect(yield* automationHandlers.AutomationIntegrationPut({ scope, integration: githubIntegration })).toEqual({ version: 1 })
      const stored = yield* automationHandlers.AutomationIntegrationGet({ scope, integrationId: "github" })
      expect(stored.configuration).toEqual(githubIntegration)
      expect(containsSecret(stored)).toBe(false)
      const absent = yield* Effect.flip(automationHandlers.AutomationIntegrationGet({ scope, integrationId: "missing" }))
      expect(absent._tag).toBe("AutomationNotFound")
      const absentStatus = yield* Effect.flip(automationHandlers.AutomationIntegrationStatus({ scope, integrationId: "missing" }))
      expect(absentStatus._tag).toBe("AutomationNotFound")
    }).pipe(Effect.provide(All)))
})

describe("automation preview RPC", () => {
  it.live("classifies through the stored routine without mutating anything", () =>
    Effect.gen(function*() {
      yield* seed
      const routines = yield* RoutineService
      const executions = yield* ExecutionRepository
      const before = (yield* routines.get(scope, "triage"))!.head.revision
      const runsBefore = (yield* executions.listRuns(scope, { limit: 100 })).items.length
      const outcome = yield* automationHandlers.AutomationPreviewClassification({
        scope,
        routineId: "triage",
        issue: { issueNumber: 7, title: "Boom", body: "Details" },
        decision: { schemaVersion: 1, kind: "selected", outcomeId: "bug", data: { choice: "bug" } }
      })
      expect(outcome.kind).toBe("classified")
      if (outcome.kind !== "classified") return
      expect(outcome.outcomeId).toBe("bug")
      expect(outcome.label).toBe("type: bug")
      expect(outcome.executed).toBe(false)
      expect(outcome.actions.map((action) => action.arguments)).toEqual([{ issueNumber: 7, label: "type: bug" }])
      expect((yield* routines.get(scope, "triage"))!.head.revision).toBe(before)
      expect((yield* executions.listRuns(scope, { limit: 100 })).items.length).toBe(runsBefore)
    }).pipe(Effect.provide(All)))

  it.live("previews an inline process with the same decision logic", () =>
    Effect.gen(function*() {
      const process = yield* buildGithubClassificationProcess("github", classification)
      const outcome = yield* automationHandlers.AutomationPreviewClassification({
        scope,
        inline: { routineId: "draft", configuration: classification, integrations: [githubIntegration], process },
        issue: { issueNumber: 7, title: "Boom" },
        decision: { schemaVersion: 1, kind: "abstained", reason: "no match" }
      })
      expect(outcome.kind).toBe("unresolved")
    }).pipe(Effect.provide(All)))
})

describe("automation run history RPCs", () => {
  it.live("pages filters details and metrics over scoped runs", () =>
    Effect.gen(function*() {
      yield* seed
      const second = yield* triageInput
      const process = yield* buildGithubClassificationProcess("github", classification)
      yield* automationHandlers.AutomationRoutineCreate({ ...second, routineId: "triage-2", process })
      yield* ingestRun("run-a", "triage", "live")
      yield* ingestRun("run-b", "triage", "live")
      yield* ingestRun("run-c", "triage-2", "preview")
      yield* setRunState("run-b", { kind: "running" })
      yield* setRunState("run-c", { kind: "cancelled", reason: "caller cancelled" })

      const first = yield* automationHandlers.AutomationRunList({ scope, limit: 2 })
      expect(first.runs).toHaveLength(2)
      expect(first.cursor).not.toBeNull()
      const secondPage = yield* automationHandlers.AutomationRunList({ scope, limit: 2, cursor: first.cursor! })
      expect(secondPage.runs.map((item) => item.run.id)).toEqual(["run-c"])
      expect(secondPage.cursor).toBeNull()

      expect((yield* automationHandlers.AutomationRunList({ scope, limit: 10, routineId: "triage-2" })).runs.map((item) => item.run.id)).toEqual(["run-c"])
      expect((yield* automationHandlers.AutomationRunList({ scope, limit: 10, mode: "preview" })).runs.map((item) => item.run.id)).toEqual(["run-c"])
      expect((yield* automationHandlers.AutomationRunList({ scope, limit: 10, state: "running" })).runs.map((item) => item.run.id)).toEqual(["run-b"])

      const details = yield* automationHandlers.AutomationRunGet({ scope, runId: "run-a" })
      expect(details.run.run.id).toBe("run-a")
      expect(details.run.version).toBe(1)
      expect(details.job.job.runId).toBe("run-a")
      expect(containsSecret(details)).toBe(false)
      expect((yield* Effect.flip(automationHandlers.AutomationRunGet({ scope, runId: "absent" })))).toMatchObject({
        _tag: "AutomationNotFound"
      })

      expect(yield* automationHandlers.AutomationRunMetrics({ scope })).toEqual({
        total: 3,
        queued: 1,
        running: 1,
        succeeded: 0,
        unresolved: 0,
        failed: 0,
        cancelled: 1
      })
      expect((yield* automationHandlers.AutomationRunMetrics({ scope, routineId: "triage-2" })).total).toBe(1)
    }).pipe(Effect.provide(All)))
})

describe("automation live updates", () => {
  it.live("emits sequenced routine events to bus subscribers and the replay feed", () =>
    Effect.scoped(Effect.gen(function*() {
      const bus = yield* EventBus
      const feed = yield* ReplayFeed
      const sub = yield* bus.subscribe
      yield* seed
      const first = yield* PubSub.take(sub)
      expect(first.event._tag).toBe("AutomationRoutineChanged")
      if (first.event._tag !== "AutomationRoutineChanged") return
      expect(first.event.routineId).toBe("triage")
      expect(first.event.projectId).toBe(scope.projectId)
      const backlog = yield* Stream.runCollect(feed.read(first.seq - 1)).pipe(Effect.map((chunk) => Array.from(chunk)))
      expect(backlog.map((sequenced) => sequenced.seq)).toContain(first.seq)
      expect(backlog.find((sequenced) => sequenced.seq === first.seq)?.event).toEqual(first.event)
      const resubscribed = yield* Stream.runCollect(feed.read(first.seq)).pipe(Effect.map((chunk) => Array.from(chunk)))
      expect(resubscribed.every((sequenced) => sequenced.seq > first.seq)).toBe(true)
    }).pipe(Effect.provide(All))))

  it.live("emits credential events without secrets", () =>
    Effect.scoped(Effect.gen(function*() {
      const bus = yield* EventBus
      const sub = yield* bus.subscribe
      const credentials = yield* CredentialRepository
      yield* credentials.putCredential(scope, "github-token", secret, 0)
      yield* automationHandlers.AutomationCredentialPut({ scope, credentialId: "github-token", secret, expectedVersion: 1 })
      const taken = yield* PubSub.take(sub)
      expect(taken.event._tag).toBe("AutomationCredentialChanged")
      expect(containsSecret(taken)).toBe(false)
    }).pipe(Effect.provide(All))))

  it.live("discovers registered triggers actions and their schemas", () =>
    Effect.gen(function*() {
      const catalog = yield* automationHandlers.AutomationCatalog()
      const kinds = catalog.definitions.map((definition) => definition.kind)
      expect(kinds).toContain("trigger")
      expect(kinds).toContain("action")
      expect(kinds).toContain("integration")
      const trigger = catalog.definitions.find((definition) => definition.kind === "trigger")!
      expect(trigger.kind).toBe("trigger")
      if (trigger.kind !== "trigger") return
      expect(trigger.definition).toEqual({ id: "github:issue-opened", version: 1 })
      expect(trigger.configurationSchema.dialect).toBe("draft-2020-12")
    }).pipe(Effect.provide(All)))
})
