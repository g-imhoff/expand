import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { HttpClient } from "effect/http"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { AutomationWorker, AutomationWorkerLayer } from "../../automation/worker.js"
import { makeGithubServerExtension } from "../../automation/github-client.js"
import {
  buildGithubClassificationProcess,
  githubIntegrationReference,
  githubLabelActionReference,
  githubTemplateReference,
  githubTriggerReference
} from "@expand/contracts/automation/github"
import { makeSampleExtension } from "../fixtures/automation-sample-extension.js"
import { startGithubStub, githubIssueBody } from "../fixtures/automation-github-stub.js"
import { startJevStub, stubChoiceBody } from "../fixtures/automation-jev-stub.js"

const scope = { ownerId: "worker-owner", projectId: "worker-project" }
const fakeJevKey = "stub-zen-key-for-tests-only"
const fakeGithubToken = "stub-github-token-for-tests-only"
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
  notifications: { onMatch: true, onNoMatch: true }
}
const githubIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "github",
  definition: { id: "github:integration" as const, version: 1 as const },
  configuration: { owner: "octo", repo: "hello" },
  credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "github-token" } }
}
const issue = { issueNumber: 7, title: "Boom", body: "Details" }
const withJev = Effect.acquireRelease(startJevStub(), (stub) => Effect.sync(() => stub.close()))
const withGithub = Effect.acquireRelease(startGithubStub(), (stub) => Effect.sync(() => stub.close()))

const layersFor = (
  registry: AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>,
  jev: { apiKey: string; endpoint: string }
) => {
  const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
  const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
  const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
  const Execs = ExecutionRepositoryLayer.pipe(Layer.provideMerge(Configs))
  const Routines = RoutineServiceLayer(registry).pipe(Layer.provide(Layer.mergeAll(Configs, Creds)))
  const Worker = AutomationWorkerLayer(registry, {
    maxAttempts: 3,
    baseBackoffMs: 1,
    attemptTimeoutMs: 5000,
    pollBatchSize: 20,
    concurrency: 4,
    pollIntervalMs: 10,
    jev: { apiKey: jev.apiKey, endpoint: jev.endpoint, timeoutMs: 5000, maxRetries: 0 }
  }).pipe(Layer.provide(Layer.mergeAll(Execs, Configs, Creds, Routines, NodeHttpClient.layerFetch)))
  return Layer.mergeAll(Ready, Configs, Creds, Execs, Routines, Worker, NodeHttpClient.layerFetch)
}

const seedGithubRoutine = Effect.gen(function*() {
  const credentials = yield* CredentialRepository
  const routines = yield* RoutineService
  yield* credentials.putCredential(scope, "github-token", fakeGithubToken, 0)
  const process = yield* buildGithubClassificationProcess("github", classification)
  yield* routines.create(scope, {
    routineId: "triage",
    template: githubTemplateReference,
    configuration: classification,
    integrations: [githubIntegration],
    process
  })
})

const triageRun = (runId: string, jobId: string, mode: "live" | "preview" = "live") => ({
  schemaVersion: 1 as const,
  kind: "run" as const,
  id: runId,
  scope,
  configuration: { routineId: "triage", revision: 1 as const },
  input: { kind: "input-reference" as const, id: `delivery-${runId}` },
  mode,
  authority: {
    schemaVersion: 1 as const,
    kind: "invocation-authority" as const,
    scope,
    configuration: { routineId: "triage", revision: 1 as const },
    integrationIds: ["github"],
    actionGrants: [{ action: githubLabelActionReference, integrationId: "github", capabilities: ["label"] }]
  },
  state: { kind: "queued" as const },
  actions: []
})

const triageDelivery = (runId: string) => ({
  schemaVersion: 1 as const,
  id: `delivery-${runId}`,
  scope,
  integration: { id: "github", definition: githubIntegrationReference },
  externalId: `external-${runId}`,
  trigger: githubTriggerReference,
  payload: { issueNumber: issue.issueNumber, title: issue.title, body: issue.body }
})

describe("worker github end to end", () => {
  it.live("completes a queued run with zero clients through stubbed transports", () =>
    Effect.gen(function*() {
      const jev = yield* withJev
      const github = yield* withGithub
      let current: ReadonlyArray<string> = ["existing"]
      github.setReply((call) => {
        if (call.method === "GET") return { status: 200, body: githubIssueBody({ labels: current }) }
        if (call.method === "PATCH") {
          current = Schema.decodeUnknownSync(Schema.Struct({ labels: Schema.Array(Schema.String) }))(call.body).labels
          return { status: 200, body: githubIssueBody({ labels: current }) }
        }
        return { status: 404, body: { message: "Not Found" } }
      })
      jev.setReply(() => ({ status: 200, body: stubChoiceBody("bug", { bug: 0.88, question: 0.1, no_match: 0.02 }, 0.81) }))
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* registry.register(makeGithubServerExtension({ baseUrl: github.baseUrl, allowedRepos: [{ owner: "octo", repo: "hello" }] }).extension)
      const Services = layersFor(registry, { apiKey: fakeJevKey, endpoint: jev.url })
      yield* Effect.gen(function*() {
        yield* seedGithubRoutine
        const executions = yield* ExecutionRepository
        const worker = yield* AutomationWorker
        const run = triageRun("run-1", "job-1")
        yield* executions.ingest({ delivery: triageDelivery("run-1"), raw: new Uint8Array([1, 2, 3]), targets: [{ jobId: "job-1", run }] })
        expect((yield* executions.history(scope, "run-1"))!.run.value.state.kind).toBe("queued")
        yield* worker.processRun(scope, "run-1")
        const history = (yield* executions.history(scope, "run-1"))!
        expect(history.run.value.state.kind).toBe("succeeded")
        expect(history.run.value.decision).toMatchObject({ kind: "selected", outcomeId: "bug" })
        expect(history.run.value.actions).toHaveLength(1)
        expect(history.run.value.actions[0]?.kind).toBe("succeeded")
        expect(current).toEqual(["existing", "type: bug"])
        expect(github.calls.some((call) => call.method === "PATCH")).toBe(true)
        expect(jev.calls).toHaveLength(1)
      }).pipe(Effect.provide(Services))
    }))
  it.live("leaves unresolved outcomes without mutation", () =>
    Effect.gen(function*() {
      const jev = yield* withJev
      const github = yield* withGithub
      github.setReply((call) => {
        if (call.method === "GET") return { status: 200, body: githubIssueBody({ labels: [] }) }
        return { status: 404, body: { message: "Not Found" } }
      })
      jev.setReply(() => ({ status: 200, body: stubChoiceBody("no_match", { bug: 0.3, question: 0.3, no_match: 0.4 }, 0.2) }))
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* registry.register(makeGithubServerExtension({ baseUrl: github.baseUrl, allowedRepos: [{ owner: "octo", repo: "hello" }] }).extension)
      const Services = layersFor(registry, { apiKey: fakeJevKey, endpoint: jev.url })
      yield* Effect.gen(function*() {
        yield* seedGithubRoutine
        const executions = yield* ExecutionRepository
        const worker = yield* AutomationWorker
        const run = triageRun("run-unresolved", "job-unresolved")
        yield* executions.ingest({ delivery: triageDelivery("run-unresolved"), raw: new Uint8Array([4]), targets: [{ jobId: "job-unresolved", run }] })
        yield* worker.processRun(scope, "run-unresolved")
        const history = (yield* executions.history(scope, "run-unresolved"))!
        expect(history.run.value.state.kind).toBe("unresolved")
        expect(history.run.value.actions).toEqual([])
        expect(github.calls.filter((call) => call.method === "PATCH")).toHaveLength(0)
      }).pipe(Effect.provide(Services))
    }))
  it.live("keeps preview runs mutation free", () =>
    Effect.gen(function*() {
      const jev = yield* withJev
      const github = yield* withGithub
      github.setReply((call) => {
        if (call.method === "GET") return { status: 200, body: githubIssueBody({ labels: [] }) }
        return { status: 404, body: { message: "Not Found" } }
      })
      jev.setReply(() => ({ status: 200, body: stubChoiceBody("bug", { bug: 0.9, question: 0.08, no_match: 0.02 }, 0.84) }))
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* registry.register(makeGithubServerExtension({ baseUrl: github.baseUrl, allowedRepos: [{ owner: "octo", repo: "hello" }] }).extension)
      const Services = layersFor(registry, { apiKey: fakeJevKey, endpoint: jev.url })
      yield* Effect.gen(function*() {
        yield* seedGithubRoutine
        const executions = yield* ExecutionRepository
        const worker = yield* AutomationWorker
        const run = triageRun("run-preview", "job-preview", "preview")
        yield* executions.ingest({ delivery: triageDelivery("run-preview"), raw: new Uint8Array([5]), targets: [{ jobId: "job-preview", run }] })
        yield* worker.processRun(scope, "run-preview")
        const history = (yield* executions.history(scope, "run-preview"))!
        expect(history.run.value.state.kind).toBe("succeeded")
        expect(github.calls.filter((call) => call.method === "PATCH")).toHaveLength(0)
        expect(jev.calls).toHaveLength(1)
      }).pipe(Effect.provide(Services))
    }))
})

describe("worker crash recovery", () => {
  it.live("reclaims interrupted jobs on restart", () =>
    Effect.gen(function*() {
      const jev = yield* withJev
      const github = yield* withGithub
      let current: ReadonlyArray<string> = []
      github.setReply((call) => {
        if (call.method === "GET") return { status: 200, body: githubIssueBody({ labels: current }) }
        if (call.method === "PATCH") {
          current = Schema.decodeUnknownSync(Schema.Struct({ labels: Schema.Array(Schema.String) }))(call.body).labels
          return { status: 200, body: githubIssueBody({ labels: current }) }
        }
        return { status: 404, body: { message: "Not Found" } }
      })
      jev.setReply(() => ({ status: 200, body: stubChoiceBody("bug", { bug: 0.9, question: 0.08, no_match: 0.02 }, 0.84) }))
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* registry.register(makeGithubServerExtension({ baseUrl: github.baseUrl, allowedRepos: [{ owner: "octo", repo: "hello" }] }).extension)
      const Services = layersFor(registry, { apiKey: fakeJevKey, endpoint: jev.url })
      yield* Effect.gen(function*() {
        yield* seedGithubRoutine
        const executions = yield* ExecutionRepository
        const worker = yield* AutomationWorker
        const run = triageRun("run-crash", "job-crash")
        yield* executions.ingest({ delivery: triageDelivery("run-crash"), raw: new Uint8Array([6]), targets: [{ jobId: "job-crash", run }] })
        const history = (yield* executions.history(scope, "run-crash"))!
        const job = history.job.value
        const interrupted = {
          ...run,
          state: { kind: "running" as const },
          actions: []
        }
        yield* executions.update(scope, { expectedRunVersion: 1, expectedJobVersion: 1, run: interrupted, job: { ...job, state: interrupted.state } })
        expect((yield* executions.scanDue(10)).some((item) => item.runId === "run-crash" && item.state === "running")).toBe(true)
        const reclaimed = yield* worker.reclaim()
        expect(reclaimed).toBeGreaterThanOrEqual(1)
        const recovered = (yield* executions.history(scope, "run-crash"))!
        expect(recovered.run.value.state.kind).toBe("succeeded")
        expect(current).toEqual(["type: bug"])
      }).pipe(Effect.provide(Services))
    }))
  it.live("reconciles uncertain writes by reading then applying only missing labels", () =>
    Effect.gen(function*() {
      const jev = yield* withJev
      const github = yield* withGithub
      let current: ReadonlyArray<string> = ["type: bug"]
      let patches = 0
      github.setReply((call) => {
        if (call.method === "GET") return { status: 200, body: githubIssueBody({ labels: current }) }
        if (call.method === "PATCH") {
          patches += 1
          current = Schema.decodeUnknownSync(Schema.Struct({ labels: Schema.Array(Schema.String) }))(call.body).labels
          return { status: 200, body: githubIssueBody({ labels: current }) }
        }
        return { status: 404, body: { message: "Not Found" } }
      })
      jev.setReply(() => ({ status: 200, body: stubChoiceBody("bug", { bug: 0.9, question: 0.08, no_match: 0.02 }, 0.84) }))
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* registry.register(makeGithubServerExtension({ baseUrl: github.baseUrl, allowedRepos: [{ owner: "octo", repo: "hello" }] }).extension)
      const Services = layersFor(registry, { apiKey: fakeJevKey, endpoint: jev.url })
      yield* Effect.gen(function*() {
        yield* seedGithubRoutine
        const executions = yield* ExecutionRepository
        const worker = yield* AutomationWorker
        const run = triageRun("run-uncertain", "job-uncertain")
        yield* executions.ingest({ delivery: triageDelivery("run-uncertain"), raw: new Uint8Array([7]), targets: [{ jobId: "job-uncertain", run }] })
        const history = (yield* executions.history(scope, "run-uncertain"))!
        const job = history.job.value
        const decision = { schemaVersion: 1 as const, kind: "selected" as const, outcomeId: "bug", data: { choice: "bug", probabilities: { bug: 0.9 }, confidence: 0.8 } }
        const decisionRequest = {
          schemaVersion: 1 as const, kind: "jev-request" as const,
          provider: "opencode-zen" as const, model: "jev" as const, version: "1.13" as const,
          configuration: { routineId: "triage", revision: 1 as const },
          input: { kind: "input-reference" as const, id: `delivery-run-uncertain` },
          outcomes: ["bug", "question"],
          data: { issueNumber: 7, title: "Boom", body: "Details" }
        }
        const decisionStarted = {
          id: "uncertain-decision-1",
          scope,
          runId: "run-uncertain",
          jobId: "job-uncertain",
          stepId: "decision",
          attempt: 1,
          startedAt: "crash-t0",
          kind: "decision" as const,
          status: "started" as const,
          request: decisionRequest
        }
        yield* executions.recordAttempt(scope, decisionStarted)
        const decided = {
          ...run,
          state: { kind: "running" as const },
          decision,
          actions: [{ kind: "planned" as const, stepId: "label-bug", action: githubLabelActionReference, arguments: { issueNumber: 7, label: "type: bug" } }]
        }
        yield* executions.recordAttempt(scope, { ...decisionStarted, status: "completed" as const, finishedAt: "crash-t1", result: decision }, { expectedRunVersion: 1, expectedJobVersion: 1, run: decided, job: { ...job, state: decided.state } })
        const started = {
          id: "uncertain-action-1",
          scope,
          runId: "run-uncertain",
          jobId: "job-uncertain",
          stepId: "label-bug",
          attempt: 1,
          startedAt: "crash-t1",
          kind: "action" as const,
          status: "started" as const,
          integration: { id: "github", definition: githubIntegrationReference },
          action: githubLabelActionReference,
          arguments: { issueNumber: 7, label: "type: bug" }
        }
        yield* executions.recordAttempt(scope, started)
        const getsBefore = github.calls.filter((call) => call.method === "GET").length
        yield* worker.processRun(scope, "run-uncertain")
        const recovered = (yield* executions.history(scope, "run-uncertain"))!
        expect(recovered.run.value.state.kind).toBe("succeeded")
        expect(github.calls.filter((call) => call.method === "GET").length).toBeGreaterThan(getsBefore)
        expect(patches).toBe(0)
        const completed = recovered.attempts.filter((attempt) => attempt.kind === "action" && attempt.status === "completed")
        expect(completed.length).toBeGreaterThanOrEqual(1)
      }).pipe(Effect.provide(Services))
    }))
})

describe("worker generic engine", () => {
  it.live("executes custom process definitions through the same worker path", () =>
    Effect.gen(function*() {
      let handlerCalls = 0
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      const sample = makeSampleExtension((args, config) => Effect.sync(() => {
        handlerCalls += 1
        return { summary: `${config.mailbox}:${args.message}`, total: args.count }
      }))
      yield* registry.register(sample.extension)
      const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
      const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
      const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const Execs = ExecutionRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const Routines = RoutineServiceLayer(registry).pipe(Layer.provide(Layer.mergeAll(Configs, Creds)))
      const Worker = AutomationWorkerLayer(registry, {
        maxAttempts: 2, baseBackoffMs: 1, attemptTimeoutMs: 5000, pollBatchSize: 10, concurrency: 2, pollIntervalMs: 10, jev: {}
      }).pipe(Layer.provide(Layer.mergeAll(Execs, Configs, Creds, Routines, NodeHttpClient.layerFetch)))
      const Services = Layer.mergeAll(Ready, Configs, Creds, Execs, Routines, Worker, NodeHttpClient.layerFetch)
      yield* Effect.gen(function*() {
        const config = yield* ConfigurationRepository
        yield* config.putIntegration({ ownerId: "custom-owner", projectId: "custom-project" }, {
          schemaVersion: 1, kind: "integration-configuration", id: "mail",
          definition: { id: "sample:mail", version: 1 },
          configuration: { mailbox: "inbox" },
          credentials: {}
        }, 0)
        const scopeCustom = { ownerId: "custom-owner", projectId: "custom-project" }
        const routine = {
          schemaVersion: 1 as const, kind: "routine-configuration" as const,
          reference: { routineId: "custom", revision: 1 as const },
          scope: scopeCustom,
          configuration: { prefix: "Hello" },
          integrations: [{
            schemaVersion: 1 as const, kind: "integration-configuration" as const, id: "mail",
            definition: { id: "sample:mail" as const, version: 1 as const },
            configuration: { mailbox: "inbox" }, credentials: {}
          }],
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
        }
        yield* config.appendRoutineRevision(routine, 0, "enabled")
        const executions = yield* ExecutionRepository
        const worker = yield* AutomationWorker
        const delivery = {
          schemaVersion: 1 as const,
          id: "custom-input",
          scope: scopeCustom,
          integration: { id: "mail", definition: { id: "sample:mail" as const, version: 1 as const } },
          externalId: "custom-external",
          trigger: { id: "sample:received" as const, version: 1 as const },
          payload: { subject: "hello", count: "3" }
        }
        const run = {
          schemaVersion: 1 as const, kind: "run" as const, id: "custom-run", scope: scopeCustom,
          configuration: { routineId: "custom", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "custom-input" },
          mode: "live" as const,
          authority: {
            schemaVersion: 1 as const, kind: "invocation-authority" as const, scope: scopeCustom,
            configuration: { routineId: "custom", revision: 1 as const },
            integrationIds: ["mail"],
            actionGrants: [{ action: { id: "sample:send" as const, version: 1 as const }, integrationId: "mail", capabilities: ["send"] }]
          },
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([8]), targets: [{ jobId: "custom-job", run }] })
        yield* worker.processRun(scopeCustom, "custom-run")
        const history = (yield* executions.history(scopeCustom, "custom-run"))!
        expect(history.run.value.state.kind).toBe("succeeded")
        expect(handlerCalls).toBe(1)
      }).pipe(Effect.provide(Services))
    }))
})
