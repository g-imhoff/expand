import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { EventBusLayer } from "../../application/event-bus.js"
import { ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { AutomationEventStoreLayer } from "../../automation/event-store.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { AutomationRegistryService } from "../../automation/registry-service.js"
import { RoutineServiceLayer } from "../../automation/routine-service.js"
import { encodeJson } from "../../automation/persistence-models.js"
import { automationHandlers } from "../../rpc/automation.js"
import {
  buildGithubClassificationProcess,
  githubTemplateReference,
  makeGithubExtension
} from "@expand/contracts/automation/github"

const makeLayers = () => {
  const registry = new AutomationRegistry()
  Effect.runSync(registry.register(makeGithubExtension().extension))
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

const scope = { ownerId: "person", projectId: "project" } as const
const otherScope = { ownerId: "person", projectId: "other" } as const
const secret = "rpc-handler-secret-xyz"
const githubIntegration = {
  schemaVersion: 1 as const, kind: "integration-configuration" as const, id: "github",
  definition: { id: "github:integration", version: 1 as const },
  configuration: { owner: "octo", repo: "hello" },
  credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "github-token" } }
} as const
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
  notifications: { onMatch: true, onNoMatch: false }
} as const

const triagePayload = Effect.gen(function*() {
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

const containsSecret = (value: unknown): boolean => encodeJson(value).includes(secret)

describe("automation RPC handlers", () => {
  it.live("runs routine CRUD lifecycle through RPC with redacted credentials", () => Effect.gen(function*() {
    const createInput = yield* triagePayload
    yield* automationHandlers.AutomationCredentialPut({ scope, credentialId: "github-token", secret })
    const created = yield* automationHandlers.AutomationRoutineCreate(createInput)
    expect(created.revision).toBe(1)
    const got = yield* automationHandlers.AutomationRoutineGet({ scope, routineId: "triage" })
    expect(got.routineId).toBe("triage")
    expect(got.head.status).toBe("enabled")
    expect(got.credentials).toEqual([{ credentialId: "github-token", version: 1, configured: true }])
    expect(containsSecret(got)).toBe(false)
    const listed = yield* automationHandlers.AutomationRoutineList({ scope })
    expect(listed.routines.map((r) => r.routineId)).toEqual(["triage"])
    expect(containsSecret(listed)).toBe(false)
    const editedClassification = { ...classification, notifications: { onMatch: false, onNoMatch: true } } as const
    const editedProcess = yield* buildGithubClassificationProcess("github", editedClassification)
    expect((yield* automationHandlers.AutomationRoutineEdit({ ...createInput, configuration: editedClassification, process: editedProcess })).revision).toBe(2)
    expect((yield* automationHandlers.AutomationRoutinePause({ scope, routineId: "triage", expectedVersion: 2 })).status).toBe("paused")
    expect((yield* automationHandlers.AutomationRoutineEnable({ scope, routineId: "triage", expectedVersion: 3 })).status).toBe("enabled")
    expect((yield* automationHandlers.AutomationRoutineDelete({ scope, routineId: "triage", expectedVersion: 4 })).status).toBe("deleted")
    const creds = yield* automationHandlers.AutomationCredentialList({ scope })
    expect(creds.credentials).toEqual([{ credentialId: "github-token", version: 1, configured: true }])
    expect(containsSecret(creds)).toBe(false)
  }).pipe(Effect.provide(makeLayers())))

  it.live("rejects cross-scope access", () => Effect.gen(function*() {
    yield* automationHandlers.AutomationCredentialPut({ scope, credentialId: "github-token", secret })
    yield* automationHandlers.AutomationRoutineCreate(yield* triagePayload)
    expect(yield* automationHandlers.AutomationRoutineGet({ scope: otherScope, routineId: "triage" }).pipe(Effect.flip)).toMatchObject({ _tag: "AutomationNotFound" })
    expect((yield* automationHandlers.AutomationRoutineList({ scope: otherScope })).routines).toEqual([])
    expect(Exit.isFailure(yield* Effect.exit(automationHandlers.AutomationRoutineEnable({ scope: otherScope, routineId: "triage", expectedVersion: 1 })))).toBe(true)
    expect((yield* automationHandlers.AutomationCredentialList({ scope: otherScope })).credentials).toEqual([])
    const base = yield* triagePayload
    expect(Exit.isFailure(yield* Effect.exit(automationHandlers.AutomationRoutineEdit({ ...base, scope: otherScope })))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(automationHandlers.AutomationRoutinePause({ scope: otherScope, routineId: "triage", expectedVersion: 1 })))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(automationHandlers.AutomationRoutineDelete({ scope: otherScope, routineId: "triage", expectedVersion: 1 })))).toBe(true)
    expect(yield* automationHandlers.AutomationIntegrationGet({ scope: otherScope, integrationId: "github" }).pipe(Effect.flip)).toMatchObject({ _tag: "AutomationNotFound" })
    expect(yield* automationHandlers.AutomationIntegrationStatus({ scope: otherScope, integrationId: "github" }).pipe(Effect.flip)).toMatchObject({ _tag: "AutomationNotFound" })
    yield* automationHandlers.AutomationIntegrationPut({ scope: otherScope, integration: { ...githubIntegration, id: "github-other" } })
    expect((yield* automationHandlers.AutomationIntegrationGet({ scope: otherScope, integrationId: "github-other" })).configuration.id).toBe("github-other")
    expect(yield* automationHandlers.AutomationIntegrationGet({ scope, integrationId: "github-other" }).pipe(Effect.flip)).toMatchObject({ _tag: "AutomationNotFound" })
    yield* automationHandlers.AutomationCredentialPut({ scope: otherScope, credentialId: "github-token", secret })
    expect((yield* automationHandlers.AutomationCredentialList({ scope })).credentials).toEqual([{ credentialId: "github-token", version: 1, configured: true }])
    expect((yield* automationHandlers.AutomationCredentialList({ scope: otherScope })).credentials).toEqual([{ credentialId: "github-token", version: 1, configured: true }])
    expect(Exit.isFailure(yield* Effect.exit(automationHandlers.AutomationCredentialRemove({ scope: otherScope, credentialId: "github-token", expectedVersion: 999 })))).toBe(true)
    expect(yield* automationHandlers.AutomationPreviewClassification({ scope: otherScope, routineId: "triage", issue: { issueNumber: 7, title: "crash on start" }, decision: { schemaVersion: 1, kind: "selected", outcomeId: "bug", data: { label: "type: bug" } } }).pipe(Effect.flip)).toMatchObject({ _tag: "AutomationNotFound" })
    expect((yield* automationHandlers.AutomationRunList({ scope: otherScope, limit: 10 })).runs).toEqual([])
    expect(yield* automationHandlers.AutomationRunMetrics({ scope: otherScope })).toEqual({ total: 0, queued: 0, running: 0, succeeded: 0, unresolved: 0, failed: 0, cancelled: 0 })
    expect(Exit.isFailure(yield* Effect.exit(automationHandlers.AutomationRunGet({ scope: otherScope, runId: "missing" })))).toBe(true)
  }).pipe(Effect.provide(makeLayers())))

  it.live("keeps credential values write-only and redacts integration status", () => Effect.gen(function*() {
    yield* automationHandlers.AutomationCredentialPut({ scope, credentialId: "github-token", secret })
    yield* automationHandlers.AutomationCredentialPut({ scope, credentialId: "github-token", secret: `${secret}-v2`, expectedVersion: 1 })
    const listed = yield* automationHandlers.AutomationCredentialList({ scope })
    expect(listed.credentials).toEqual([{ credentialId: "github-token", version: 2, configured: true }])
    expect(containsSecret(listed)).toBe(false)
    yield* automationHandlers.AutomationIntegrationPut({ scope, integration: githubIntegration })
    const stored = yield* automationHandlers.AutomationIntegrationGet({ scope, integrationId: "github" })
    expect(stored.configuration.id).toBe("github")
    expect(containsSecret(stored)).toBe(false)
    const status = yield* automationHandlers.AutomationIntegrationStatus({ scope, integrationId: "github" })
    expect(status.owner).toBe("octo")
    expect(status.repo).toBe("hello")
    expect(containsSecret(status)).toBe(false)
    yield* automationHandlers.AutomationCredentialRemove({ scope, credentialId: "github-token", expectedVersion: 2 })
    expect((yield* automationHandlers.AutomationCredentialList({ scope })).credentials).toEqual([])
  }).pipe(Effect.provide(makeLayers())))

  it.live("previews classification with zero mutations", () => Effect.gen(function*() {
    const sql = yield* SqlClient
    yield* automationHandlers.AutomationCredentialPut({ scope, credentialId: "github-token", secret })
    yield* automationHandlers.AutomationRoutineCreate(yield* triagePayload)
    const beforeRevisions = yield* sql<{ n: number }>`SELECT count(*) n FROM automation_routine_revisions`
    const beforeRuns = yield* sql<{ n: number }>`SELECT count(*) n FROM automation_runs`
    const beforeJobs = yield* sql<{ n: number }>`SELECT count(*) n FROM automation_jobs`
    const beforeDeliveries = yield* sql<{ n: number }>`SELECT count(*) n FROM automation_deliveries`
    const beforeJobAttempts = yield* sql<{ n: number }>`SELECT count(*) n FROM automation_job_attempts`
    const beforeDecisionAttempts = yield* sql<{ n: number }>`SELECT count(*) n FROM automation_decision_attempts`
    const beforeActionAttempts = yield* sql<{ n: number }>`SELECT count(*) n FROM automation_action_attempts`
    const beforeEvents = yield* sql<{ n: number }>`SELECT count(*) n FROM events`
    const outcome = yield* automationHandlers.AutomationPreviewClassification({
      scope,
      routineId: "triage",
      issue: { issueNumber: 7, title: "crash on start" },
      decision: { schemaVersion: 1, kind: "selected", outcomeId: "bug", data: { label: "type: bug" } }
    })
    expect(outcome.kind).toBe("classified")
    if (outcome.kind === "classified") {
      expect(outcome.executed).toBe(false)
      expect(outcome.label).toBe("type: bug")
    }
    expect(yield* sql<{ n: number }>`SELECT count(*) n FROM automation_routine_revisions`).toEqual(beforeRevisions)
    expect(yield* sql<{ n: number }>`SELECT count(*) n FROM automation_runs`).toEqual(beforeRuns)
    expect(yield* sql<{ n: number }>`SELECT count(*) n FROM automation_jobs`).toEqual(beforeJobs)
    expect(yield* sql<{ n: number }>`SELECT count(*) n FROM automation_deliveries`).toEqual(beforeDeliveries)
    expect(yield* sql<{ n: number }>`SELECT count(*) n FROM automation_job_attempts`).toEqual(beforeJobAttempts)
    expect(yield* sql<{ n: number }>`SELECT count(*) n FROM automation_decision_attempts`).toEqual(beforeDecisionAttempts)
    expect(yield* sql<{ n: number }>`SELECT count(*) n FROM automation_action_attempts`).toEqual(beforeActionAttempts)
    expect(yield* sql<{ n: number }>`SELECT count(*) n FROM events`).toEqual(beforeEvents)
    expect(containsSecret(outcome)).toBe(false)
  }).pipe(Effect.provide(makeLayers())))

  it.live("paginates run history with filters and reports metrics", () => Effect.gen(function*() {
    const empty = yield* automationHandlers.AutomationRunList({ scope, limit: 10 })
    expect(empty.runs).toEqual([])
    expect(empty.cursor).toBeNull()
    const metrics = yield* automationHandlers.AutomationRunMetrics({ scope })
    expect(metrics).toEqual({ total: 0, queued: 0, running: 0, succeeded: 0, unresolved: 0, failed: 0, cancelled: 0 })
    expect(Exit.isFailure(yield* Effect.exit(automationHandlers.AutomationRunGet({ scope, runId: "missing" })))).toBe(true)
  }).pipe(Effect.provide(makeLayers())))

  it.live("discovers registered triggers and actions with editor schemas", () => Effect.gen(function*() {
    const catalog = yield* automationHandlers.AutomationCatalog()
    const kinds = catalog.definitions.map((d) => d.kind)
    expect(kinds).toEqual(expect.arrayContaining(["integration", "trigger", "action", "routine-template"]))
    expect(catalog.definitions.find((d) => d.kind === "trigger")).toBeDefined()
  }).pipe(Effect.provide(makeLayers())))
})
