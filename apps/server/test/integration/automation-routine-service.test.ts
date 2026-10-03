import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { StorageError } from "../../automation/persistence-models.js"
import type { Delivery } from "../../automation/persistence-models.js"
import type { AutomationError, AutomationRun } from "@expand/contracts/automation"
import {
  buildGithubClassificationProcess, githubIntegrationReference, githubLabelActionReference,
  githubTemplateReference, githubTriggerReference, makeGithubExtension
} from "@expand/contracts/automation/github"
import { makeSampleExtension } from "../fixtures/automation-sample-extension.js"

const registry = new AutomationRegistry()
Effect.runSync(Effect.gen(function*() {
  yield* registry.register(makeGithubExtension().extension)
  yield* registry.register(makeSampleExtension().extension)
}))
const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Config = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const WithCredentials = CredentialRepositoryLayer.pipe(Layer.provideMerge(Config))
const All = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer).pipe(Layer.provideMerge(WithCredentials))
const scope = { ownerId: "person", projectId: "project" }
const secretText = "t05-classification-secret"
const secretBytes = new TextEncoder().encode(secretText)
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const githubIntegration = {
  schemaVersion: 1, kind: "integration-configuration", id: "github",
  definition: { id: "github:integration", version: 1 },
  configuration: { owner: "octo", repo: "hello" },
  credentials: { token: { schemaVersion: 1, kind: "credential-reference", credentialId: "github-token" } }
}
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
  notifications: { onMatch: true, onNoMatch: false }
}
const seedCredentials = Effect.gen(function*() {
  const credentials = yield* CredentialRepository
  yield* credentials.putCredential(scope, "github-token", secretBytes, 0)
})
const triageInput = Effect.gen(function*() {
  const process = yield* buildGithubClassificationProcess("github", classification)
  return { routineId: "triage", template: githubTemplateReference, configuration: classification, integrations: [githubIntegration], process }
})
const errorCode = (cause: unknown): string => {
  const value = cause as { code?: unknown; _tag?: unknown };
  if (typeof value?.code === "string") return value.code;
  return String(cause);
};
const expectFailure = (exit: Exit.Exit<unknown, unknown>, code: string) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(errorCode(Cause.squash(exit.cause))).toBe(code);
};
const revisionCount = Effect.gen(function*() {
  const sql = yield* SqlClient
  return yield* sql<{ n: number }>`SELECT count(*) n FROM automation_routine_revisions`
})

describe("routine lifecycle", () => {
  it.live("creates edits enables pauses and deletes routines with scoped CAS versions", () => Effect.gen(function*() {
    const routines = yield* RoutineService
    const config = yield* ConfigurationRepository
    yield* seedCredentials
    expect(yield* routines.create(scope, yield* triageInput)).toBe(1)
    const created = (yield* routines.get(scope, "triage"))!
    expect(created.head).toEqual({ revision: 1, version: 1, status: "enabled" })
    expect(created.configuration.template).toEqual(githubTemplateReference)
    expect(created.credentials).toEqual([{ credentialId: "github-token", version: 1, configured: true }])
    expectFailure(yield* Effect.exit(routines.create(scope, yield* triageInput)), "conflict")
    const edited = { ...classification, notifications: { onMatch: false, onNoMatch: true } }
    expect(yield* routines.edit(scope, "triage", { ...(yield* triageInput), configuration: edited, process: yield* buildGithubClassificationProcess("github", edited) })).toBe(2)
    expect((yield* routines.get(scope, "triage"))?.head).toEqual({ revision: 2, version: 2, status: "enabled" })
    expect(yield* config.getRevision(scope, "triage", 1)).toEqual(created.configuration)
    expectFailure(yield* Effect.exit(routines.pause(scope, "triage", 1)), "conflict")
    expectFailure(yield* Effect.exit(routines.enable(scope, "triage", 1)), "conflict")
    expect(yield* routines.pause(scope, "triage", 2)).toEqual({ revision: 2, status: "paused", version: 3 })
    expect((yield* routines.due(scope))).toEqual([])
    expect(yield* routines.enable(scope, "triage", 3)).toEqual({ revision: 2, status: "enabled", version: 4 })
    expect((yield* routines.due(scope)).map((routine) => routine.routineId)).toEqual(["triage"])
    expect((yield* routines.list(scope)).map((routine) => routine.routineId)).toEqual(["triage"])
    expect(yield* routines.remove(scope, "triage", 4)).toEqual({ revision: 2, status: "deleted", version: 5 })
    expect((yield* routines.due(scope))).toEqual([])
    expectFailure(yield* Effect.exit(routines.edit(scope, "triage", yield* triageInput)), "invalid-reference")
    expectFailure(yield* Effect.exit(routines.enable(scope, "triage", 5)), "invalid-reference")
    expectFailure(yield* Effect.exit(routines.pause(scope, "triage", 5)), "invalid-reference")
    expectFailure(yield* Effect.exit(routines.remove(scope, "triage", 5)), "invalid-reference")
    expectFailure(yield* Effect.exit(routines.assertDue(scope, "triage")), "invalid")
    expectFailure(yield* Effect.exit(routines.assertDue(scope, "missing")), "missing")
    expect(yield* routines.get(scope, "missing")).toBeNull()
    expect((yield* routines.get(scope, "triage"))?.head.status).toBe("deleted")
  }).pipe(Effect.provide(All)))
  it.live("keeps routines scoped to the owning personal project", () => Effect.gen(function*() {
    const routines = yield* RoutineService
    yield* seedCredentials
    yield* routines.create(scope, yield* triageInput)
    for (const other of [{ ...scope, ownerId: "other" }, { ...scope, projectId: "other" }]) {
      expect(yield* routines.get(other, "triage")).toBeNull()
      expect(yield* routines.list(other)).toEqual([])
      expect(yield* routines.due(other)).toEqual([])
    }
    expect((yield* routines.list(scope)).map((routine) => routine.routineId)).toEqual(["triage"])
  }).pipe(Effect.provide(All)))
})

describe("routine validation", () => {
  it.live("rejects invalid triggers actions loops and classification fields before any write", () => Effect.gen(function*() {
    const routines = yield* RoutineService
    const sql = yield* SqlClient
    yield* seedCredentials
    const base = yield* triageInput
    const mutateProcess = (mutate: (process: typeof base.process) => unknown) => ({ ...base, routineId: "invalid", process: mutate(structuredClone(base.process)) })
    const cases = [
      mutateProcess((process) => ({ ...process, trigger: { ...process.trigger, definition: { ...githubTriggerReference, version: 99 } } })),
      mutateProcess((process) => ({ ...process, actions: { bug: [{ ...process.actions["bug"]![0]!, action: { ...githubLabelActionReference, version: 99 } }], question: process.actions["question"] } })),
      mutateProcess((process) => ({ ...process, loops: [{ from: "bug", to: "bug" }] })),
      mutateProcess((process) => ({ ...process, actions: { ...process.actions, question: [{ ...process.actions["bug"]![0]! }] } })),
      { ...base, routineId: "invalid", configuration: { ...classification, categories: [] as ReadonlyArray<string> } },
      { ...base, routineId: "invalid", configuration: { ...classification, labels: { bug: "type: bug" } } },
      { ...base, routineId: "invalid", configuration: { ...classification, notifications: { onMatch: true, onNoMatch: "later" } } },
      { ...base, routineId: "invalid", template: githubTemplateReference, configuration: { custom: true }, integrations: [], process: { schemaVersion: 1, kind: "process", trigger: { definition: { id: "sample:received", version: 1 }, integration: { id: "mail", definition: { id: "sample:mail", version: 1 } }, configuration: {} }, actions: { triggered: [] } } }
    ]
    for (const input of cases) {
      const exit = yield* Effect.exit(routines.create(scope, input))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(errorCode(Cause.squash(exit.cause)).length).toBeGreaterThan(0)
        expect(String(Cause.squash(exit.cause))).not.toContain(secretText)
      }
    }
    const multiStep = mutateProcess((process) => ({ ...process, actions: { bug: [...process.actions["bug"]!, ...process.actions["bug"]!], question: process.actions["question"] } }))
    expectFailure(yield* Effect.exit(routines.create(scope, multiStep)), "invalid-reference")
    const fieldLabel = mutateProcess((process) => ({ ...process, actions: { bug: [{ ...process.actions["bug"]![0]!, bindings: { issueNumber: { kind: "literal", value: 7 }, label: { kind: "field", source: "trigger", path: ["issueNumber"] } } }], question: process.actions["question"] } }))
    expectFailure(yield* Effect.exit(routines.create(scope, fieldLabel)), "invalid-reference")
    const extraBinding = mutateProcess((process) => ({ ...process, actions: { bug: [{ ...process.actions["bug"]![0]!, bindings: { ...process.actions["bug"]![0]!.bindings, extra: { kind: "literal", value: "x" } } }], question: process.actions["question"] } }))
    expectFailure(yield* Effect.exit(routines.create(scope, extraBinding)), "invalid-reference")
    yield* routines.create(scope, { ...base, routineId: "stored" })
    const conflicting = { ...base, routineId: "invalid", integrations: [{ ...githubIntegration, configuration: { owner: "other", repo: "hello" } }] }
    expectFailure(yield* Effect.exit(routines.create(scope, conflicting)), "conflict")
    expect(yield* routines.get(scope, "invalid")).toBeNull()
    const missingCredential = { ...base, routineId: "invalid", integrations: [{ ...githubIntegration, credentials: { token: { schemaVersion: 1, kind: "credential-reference", credentialId: "absent" } } }] }
    const missing = yield* Effect.exit(routines.create(scope, missingCredential))
    expect(Exit.isFailure(missing)).toBe(true)
    if (Exit.isFailure(missing)) expect(Cause.squash(missing.cause)).toBeInstanceOf(StorageError)
    expect(yield* routines.get(scope, "invalid")).toBeNull()
    expect(yield* revisionCount).toEqual([{ n: 1 }])
    expect(yield* sql`SELECT count(*) n FROM automation_integrations`).toEqual([{ n: 1 }])
  }).pipe(Effect.provide(All)))
  it.live("accepts user-created custom processes through the same validated API", () => Effect.gen(function*() {
    const routines = yield* RoutineService
    const custom = {
      configuration: { message: "custom", count: "4" },
      integrations: [{ schemaVersion: 1, kind: "integration-configuration", id: "mail", definition: { id: "sample:mail", version: 1 }, configuration: { mailbox: "inbox" }, credentials: {} }],
      process: {
        schemaVersion: 1, kind: "process",
        trigger: { definition: { id: "sample:received", version: 1 }, integration: { id: "mail", definition: { id: "sample:mail", version: 1 } }, configuration: {} },
        actions: { triggered: [{ id: "send", action: { id: "sample:send", version: 1 }, integration: { id: "mail", definition: { id: "sample:mail", version: 1 } }, bindings: { message: { kind: "field", source: "configuration", path: ["message"] }, count: { kind: "field", source: "configuration", path: ["count"] } } }] }
      }
    }
    expect(yield* routines.create(scope, { routineId: "custom", ...custom })).toBe(1)
    expect((yield* routines.get(scope, "custom"))?.configuration.template).toBeUndefined()
    expect((yield* routines.due(scope)).map((routine) => routine.routineId)).toEqual(["custom"])
  }).pipe(Effect.provide(All)))
})

describe("routine revisions", () => {
  it.live("retains the exact revision on old runs while edits append new revisions", () => Effect.gen(function*() {
    const routines = yield* RoutineService
    const repository = yield* ExecutionRepository
    yield* seedCredentials
    const created = (yield* Effect.gen(function*() {
      yield* routines.create(scope, yield* triageInput)
      return (yield* routines.get(scope, "triage"))!
    }))
    const delivery: Delivery = { schemaVersion: 1, id: "delivery-1", scope, integration: { id: "github", definition: githubIntegrationReference }, externalId: "ext-1", trigger: githubTriggerReference, payload: { issueNumber: 7, title: "Boom" } }
    const run: AutomationRun = { schemaVersion: 1, kind: "run", id: "run-1", scope, configuration: { routineId: "triage", revision: 1 }, input: { kind: "input-reference", id: "delivery-1" }, mode: "live", authority: { schemaVersion: 1, kind: "invocation-authority", scope, configuration: { routineId: "triage", revision: 1 }, integrationIds: ["github"], actionGrants: [{ action: githubLabelActionReference, integrationId: "github", capabilities: ["label"] }] }, state: { kind: "queued" }, actions: [] }
    yield* repository.ingest({ delivery, raw: new Uint8Array([1, 2, 3]), targets: [{ jobId: "job-1", run }] })
    const extended = { ...classification, categories: ["bug", "question", "docs"], labels: { ...classification.labels, docs: "type: docs" } }
    expect(yield* routines.edit(scope, "triage", { template: githubTemplateReference, configuration: extended, integrations: [githubIntegration], process: yield* buildGithubClassificationProcess("github", extended) })).toBe(2)
    expect((yield* repository.history(scope, "run-1"))?.run.value.configuration).toEqual({ routineId: "triage", revision: 1 })
    expect((yield* repository.history(scope, "run-1"))?.run.value.state).toEqual({ kind: "queued" })
    const config = yield* ConfigurationRepository
    expect(yield* config.getRevision(scope, "triage", 1)).toEqual(created.configuration)
    expect((yield* config.getRevision(scope, "triage", 2))?.configuration).toEqual(extended)
  }).pipe(Effect.provide(All)))
})

describe("routine pause", () => {
  it.live("excludes paused routines immediately, including already queued events", () => Effect.gen(function*() {
    const routines = yield* RoutineService
    const repository = yield* ExecutionRepository
    yield* seedCredentials
    yield* routines.create(scope, yield* triageInput)
    const delivery: Delivery = { schemaVersion: 1, id: "delivery-1", scope, integration: { id: "github", definition: githubIntegrationReference }, externalId: "ext-1", trigger: githubTriggerReference, payload: { issueNumber: 7, title: "Boom" } }
    const run: AutomationRun = { schemaVersion: 1, kind: "run", id: "run-1", scope, configuration: { routineId: "triage", revision: 1 }, input: { kind: "input-reference", id: "delivery-1" }, mode: "live", authority: { schemaVersion: 1, kind: "invocation-authority", scope, configuration: { routineId: "triage", revision: 1 }, integrationIds: ["github"], actionGrants: [{ action: githubLabelActionReference, integrationId: "github", capabilities: ["label"] }] }, state: { kind: "queued" }, actions: [] }
    yield* repository.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-1", run }] })
    expect((yield* routines.assertDue(scope, "triage")).routineId).toBe("triage")
    yield* routines.pause(scope, "triage", 1)
    expect((yield* routines.due(scope))).toEqual([])
    expect(Exit.isFailure(yield* Effect.exit(routines.assertDue(scope, "triage")))).toBe(true)
    expect((yield* repository.history(scope, "run-1"))?.run.value.state).toEqual({ kind: "queued" })
    expect((yield* routines.get(scope, "triage"))?.head.status).toBe("paused")
    yield* routines.enable(scope, "triage", 2)
    expect((yield* routines.assertDue(scope, "triage")).head.status).toBe("enabled")
  }).pipe(Effect.provide(All)))
})

describe("routine template", () => {
  it.live("instantiates the issue-classification template and stays editable with match and unresolved outcomes", () => Effect.gen(function*() {
    const routines = yield* RoutineService
    yield* seedCredentials
    yield* routines.create(scope, yield* triageInput)
    const created = (yield* routines.get(scope, "triage"))!
    const payload = { issueNumber: 7, title: "Boom" }
    const matched = yield* registry.resolveSelectedActions(created.configuration, payload, { schemaVersion: 1, kind: "selected", outcomeId: "bug", data: {} })
    expect(matched.selection.kind).toBe("selected")
    expect(matched.actions.map((action) => action.arguments)).toEqual([{ issueNumber: 7, label: "type: bug" }])
    const unresolved = yield* registry.resolveSelectedActions(created.configuration, payload, { schemaVersion: 1, kind: "abstained", reason: "no match" })
    expect(unresolved).toEqual({ selection: { kind: "unresolved", reason: "no match", actions: [] }, actions: [] })
    const extended = { ...classification, categories: ["bug", "question", "docs"], labels: { ...classification.labels, docs: "type: docs" } }
    expect(yield* routines.edit(scope, "triage", { template: githubTemplateReference, configuration: extended, integrations: [githubIntegration], process: yield* buildGithubClassificationProcess("github", extended) })).toBe(2)
    const revised = (yield* routines.get(scope, "triage"))!
    const docs = yield* registry.resolveSelectedActions(revised.configuration, payload, { schemaVersion: 1, kind: "selected", outcomeId: "docs", data: {} })
    expect(docs.actions.map((action) => action.arguments)).toEqual([{ issueNumber: 7, label: "type: docs" }])
    const original = yield* registry.resolveSelectedActions(created.configuration, payload, { schemaVersion: 1, kind: "selected", outcomeId: "bug", data: {} })
    expect(original.actions.map((action) => action.arguments)).toEqual([{ issueNumber: 7, label: "type: bug" }])
  }).pipe(Effect.provide(All)))
})

describe("routine credential references", () => {
  it.live("resolves credentials by reference only and never exposes secrets in routine reads", () => Effect.gen(function*() {
    const routines = yield* RoutineService
    const sql = yield* SqlClient
    yield* seedCredentials
    yield* routines.create(scope, yield* triageInput)
    const routine = (yield* routines.get(scope, "triage"))!
    expect(routine.configuration.integrations[0]!.credentials).toEqual({ token: { schemaVersion: 1, kind: "credential-reference", credentialId: "github-token" } })
    expect(encode({ routine, listed: yield* routines.list(scope), due: yield* routines.due(scope) })).not.toContain(secretText)
    for (const table of ["automation_integrations", "automation_routine_revisions"]) {
      const rows = yield* sql<{ json: string }>`SELECT json FROM ${sql(table)}`
      for (const row of rows) expect(row.json).not.toContain(secretText)
    }
  }).pipe(Effect.provide(All)))
})
