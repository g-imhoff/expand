import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { makeGithubConnectorExtension } from "../../automation/github-connector.js"
import type { GithubConnectorServices } from "../../automation/github-connector.js"
import {
  buildGithubClassificationProcess,
  githubIntegrationReference,
  githubLabelActionReference,
  githubTemplateReference,
  githubTriggerReference,
  makeGithubExtension
} from "@expand/contracts/automation/github"
import { classifyJev } from "../../automation/jev-client.js"
import {
  DefaultAutomationWorkerOptions,
  processRun,
  reclaimInterruptedRuns,
  sweepOnce
} from "../../automation/worker.js"
import type { AutomationWorkerEnvironment } from "../../automation/worker.js"
import { StorageError } from "../../automation/persistence-models.js"
import type { Attempt } from "../../automation/persistence-models.js"
import { startJevStub, stubChoiceBody } from "../fixtures/automation-jev-stub.js"
import { startGithubStub } from "../fixtures/automation-github-stub.js"
import { makeSampleExtension, sampleAuthority, sampleConfiguration } from "../fixtures/automation-sample-extension.js"

const scope = { ownerId: "worker-int-owner", projectId: "worker-int-project" }
const fakeKey = "stub-zen-key-for-tests-only"
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
  notifications: { onMatch: true, onNoMatch: true }
}
const githubIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "github" as const,
  definition: { id: "github:integration" as const, version: 1 as const },
  configuration: { owner: "octo", repo: "hello" },
  credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "github-token" } }
}
const withJev = Effect.acquireRelease(startJevStub(), (stub) => Effect.sync(() => stub.close()))
const withGithub = Effect.acquireRelease(startGithubStub(), (stub) => Effect.sync(() => stub.close()))

const ingestGithubRun = (runId: string, jobId: string, deliveryId: string, issueNumber: number) =>
  Effect.gen(function*() {
    const executions = yield* ExecutionRepository
    const delivery = {
      schemaVersion: 1 as const,
      id: deliveryId,
      scope,
      integration: { id: "github", definition: githubIntegrationReference },
      externalId: deliveryId,
      trigger: githubTriggerReference,
      payload: { issueNumber, title: "Boom", body: "Details" }
    }
    const run = {
      schemaVersion: 1 as const,
      kind: "run" as const,
      id: runId,
      scope,
      configuration: { routineId: "triage", revision: 1 as const },
      input: { kind: "input-reference" as const, id: deliveryId },
      mode: "live" as const,
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
    }
    yield* executions.ingest({ delivery, raw: new Uint8Array([1, 2, 3]), targets: [{ jobId, run }] })
  })

describe("automation worker integration", () => {
  for (const kind of ["generic", "classification"] as const) {
    it.live(`stops ${kind} actions when the durable attempt start fails and retries safely`, () =>
      Effect.gen(function*() {
        let calls = 0
        let startFailures = 0
        const registry = new AutomationRegistry()
        yield* registry.register(kind === "classification"
          ? makeGithubExtension(() => Effect.sync(() => { calls += 1; return { applied: true } })).extension
          : makeSampleExtension(() => Effect.sync(() => { calls += 1; return { summary: "sent", total: 2 } })).extension
        )
        const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
        const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
        const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
        const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
          Layer.provideMerge(Creds)
        )
        const program = Effect.gen(function*() {
          const routines = yield* RoutineService
          const executions = yield* ExecutionRepository
          const configurations = yield* ConfigurationRepository
          const credentials = yield* CredentialRepository
          const sql = yield* SqlClient
          const http = yield* HttpClient.HttpClient
          const routineId = kind === "classification" ? "triage" : "personal-mail"
          const configuration = { routineId, revision: 1 as const }
          const process = kind === "classification"
            ? yield* buildGithubClassificationProcess("github", classification)
            : sampleConfiguration.process
          yield* credentials.putCredential(scope, kind === "classification" ? "github-token" : "account-1", new TextEncoder().encode("secret"), 0)
          yield* routines.create(scope, {
            routineId,
            configuration: kind === "classification" ? classification : sampleConfiguration.configuration,
            integrations: kind === "classification" ? [githubIntegration] : sampleConfiguration.integrations,
            process
          })
          const delivery = {
            schemaVersion: 1 as const,
            id: "input-storage-failure",
            scope,
            integration: process.trigger.integration,
            externalId: "input-storage-failure",
            trigger: process.trigger.definition,
            payload: kind === "classification"
              ? { issueNumber: 7, title: "Boom", body: "Details" }
              : { subject: "hello", count: "2" }
          }
          const run = {
            schemaVersion: 1 as const,
            kind: "run" as const,
            id: "run-storage-failure",
            scope,
            configuration,
            input: { kind: "input-reference" as const, id: delivery.id },
            mode: "live" as const,
            authority: {
              ...sampleAuthority,
              scope,
              configuration,
              integrationIds: kind === "classification" ? ["github"] : sampleAuthority.integrationIds,
              actionGrants: kind === "classification"
                ? [{ action: githubLabelActionReference, integrationId: "github", capabilities: ["label"] }]
                : sampleAuthority.actionGrants
            },
            state: { kind: "queued" as const },
            actions: []
          }
          yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-storage-failure", run }] })
          const storageError = new StorageError({ code: "storage", message: "Injected action start failure" })
          const faultingExecutions: ExecutionRepository["Service"] = {
            ...executions,
            recordAttempt: (personalScope, attempt, summary) => {
              if (attempt.kind === "action" && attempt.status === "started" && startFailures === 0) {
                startFailures += 1
                return Effect.fail(storageError)
              }
              return executions.recordAttempt(personalScope, attempt, summary)
            }
          }
          const environment: AutomationWorkerEnvironment = {
            services: { configurations, credentials, executions: faultingExecutions, sql, http },
            registry,
            routines,
            decide: () => Effect.succeed({ schemaVersion: 1, kind: "selected", outcomeId: "bug", data: {} })
          }
          const options = { ...DefaultAutomationWorkerOptions, maxAttempts: 2, baseBackoffMs: 1 }
          const failure = yield* processRun(environment, options, scope, run.id).pipe(Effect.flip)
          expect(failure).toBe(storageError)
          expect(startFailures).toBe(1)
          expect(calls).toBe(0)
          const interrupted = (yield* executions.history(scope, run.id))!
          expect(interrupted.run.value.state.kind).toBe(kind === "classification" ? "running" : "queued")
          expect(interrupted.job.value.state).toEqual(interrupted.run.value.state)
          expect(interrupted.run.value.actions).toEqual([])
          expect(interrupted.attempts.filter((attempt) => attempt.kind === "action")).toEqual([])
          expect(yield* processRun(environment, options, scope, run.id)).toBe("completed")
          expect(calls).toBe(1)
          const recovered = (yield* executions.history(scope, run.id))!
          expect(recovered.run.value.state.kind).toBe("succeeded")
          const actionAttempts = recovered.attempts.filter((attempt) => attempt.kind === "action")
          expect(actionAttempts).toHaveLength(1)
          expect(actionAttempts[0]).toMatchObject({ attempt: 1, status: "completed", outcome: { kind: "succeeded" } })
          expect(yield* processRun(environment, options, scope, run.id)).toBe("completed")
          expect(calls).toBe(1)
        })
        yield* program.pipe(Effect.provide(Live))
      }).pipe(Effect.scoped)
    )
  }

  it.live("completes a queued run end to end via stubs with zero clients", () =>
    Effect.gen(function*() {
      const jev = yield* withJev
      const github = yield* withGithub
      github.setIssue(7, { title: "Boom", body: "Details", labels: [] })
      const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
      const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
      const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const registry = new AutomationRegistry()
      const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
        Layer.provideMerge(Creds)
      )
      const connectorOptions = { baseUrl: github.baseUrl, timeoutMs: 5000, maxRetries: 0 }
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const connectorServices: GithubConnectorServices = { configurations, credentials, http }
        yield* registry.register(makeGithubConnectorExtension(connectorOptions, connectorServices).extension)
        yield* credentials.putCredential(scope, "github-token", new TextEncoder().encode("stub-github-token"), 0)
        const process = yield* buildGithubClassificationProcess("github", classification)
        yield* routines.create(scope, {
          routineId: "triage",
          template: githubTemplateReference,
          configuration: classification,
          integrations: [githubIntegration],
          process
        })
        yield* ingestGithubRun("run-7", "job-7", "issue-7", 7)
        jev.setReply(() => ({ status: 200, body: stubChoiceBody("bug", { bug: 0.9, question: 0.08, no_match: 0.02 }, 0.85) }))
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: (input) => classifyJev(input.request, input.descriptions, fakeKey, { endpoint: jev.url, timeoutMs: 5000, maxRetries: 0 }),
          githubOptions: connectorOptions
        }
        const processed = yield* sweepOnce(environment, { ...DefaultAutomationWorkerOptions, baseBackoffMs: 1 })
        expect(processed).toBeGreaterThanOrEqual(1)
        expect((yield* executions.getRun(scope, "run-7"))?.value.state.kind).toBe("succeeded")
        expect(github.getIssueLabels(7)).toContain("type: bug")
        expect(jev.calls.length).toBeGreaterThanOrEqual(1)
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped)
  )

  it.live("leaves unresolved outcomes without mutation and zero patches", () =>
    Effect.gen(function*() {
      const jev = yield* withJev
      const github = yield* withGithub
      github.setIssue(8, { title: "Boom", body: "Details", labels: [] })
      const callsBefore = github.calls.length
      const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
      const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
      const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const registry = new AutomationRegistry()
      const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
        Layer.provideMerge(Creds)
      )
      const connectorOptions = { baseUrl: github.baseUrl, timeoutMs: 5000, maxRetries: 0 }
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const connectorServices: GithubConnectorServices = { configurations, credentials, http }
        yield* registry.register(makeGithubConnectorExtension(connectorOptions, connectorServices).extension)
        yield* credentials.putCredential(scope, "github-token", new TextEncoder().encode("stub-github-token"), 0)
        const process = yield* buildGithubClassificationProcess("github", classification)
        yield* routines.create(scope, {
          routineId: "triage",
          template: githubTemplateReference,
          configuration: classification,
          integrations: [githubIntegration],
          process
        })
        yield* ingestGithubRun("run-8", "job-8", "issue-8", 8)
        jev.setReply(() => ({ status: 200, body: stubChoiceBody("no_match", { bug: 0.3, question: 0.3, no_match: 0.4 }, 0.2) }))
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: (input) => classifyJev(input.request, input.descriptions, fakeKey, { endpoint: jev.url, timeoutMs: 5000, maxRetries: 0 }),
          githubOptions: connectorOptions
        }
        const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, baseBackoffMs: 1 }, scope, "run-8")
        expect(outcome).toBe("unresolved")
        expect((yield* executions.getRun(scope, "run-8"))?.value.state.kind).toBe("unresolved")
        expect(github.getIssueLabels(8)).toEqual([])
        const posts = github.calls.slice(callsBefore).filter((call) => call.method === "POST")
        expect(posts).toEqual([])
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped)
  )

  it.live("reclaims interrupted runs and reconciles uncertain writes with read-before-write", () =>
    Effect.gen(function*() {
      const jev = yield* withJev
      const github = yield* withGithub
      github.setIssue(9, { title: "Boom", body: "Details", labels: [] })
      const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
      const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
      const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const registry = new AutomationRegistry()
      const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
        Layer.provideMerge(Creds)
      )
      const connectorOptions = { baseUrl: github.baseUrl, timeoutMs: 5000, maxRetries: 0 }
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const connectorServices: GithubConnectorServices = { configurations, credentials, http }
        yield* registry.register(makeGithubConnectorExtension(connectorOptions, connectorServices).extension)
        yield* credentials.putCredential(scope, "github-token", new TextEncoder().encode("stub-github-token"), 0)
        const process = yield* buildGithubClassificationProcess("github", classification)
        yield* routines.create(scope, {
          routineId: "triage",
          template: githubTemplateReference,
          configuration: classification,
          integrations: [githubIntegration],
          process
        })
        yield* ingestGithubRun("run-9", "job-9", "issue-9", 9)
        const running = (yield* executions.getRun(scope, "run-9"))!
        const job = (yield* executions.getJob(scope, "job-9"))!
        yield* executions.update(scope, {
          expectedRunVersion: running.version,
          expectedJobVersion: job.version,
          run: { ...running.value, state: { kind: "running" } },
          job: { ...job.value, state: { kind: "running" } }
        })
        const interrupted = (yield* executions.getRun(scope, "run-9"))!
        yield* executions.recordAttempt(scope, {
          id: "decision-interrupted",
          scope,
          runId: "run-9",
          jobId: "job-9",
          stepId: "decision",
          attempt: 1,
          startedAt: "t-crash",
          kind: "decision",
          status: "started",
          request: {
            schemaVersion: 1,
            kind: "jev-request",
            provider: "opencode-zen",
            model: "jev",
            version: "1.13",
            configuration: { routineId: "triage", revision: 1 },
            input: { kind: "input-reference", id: "issue-9" },
            outcomes: ["bug", "question"],
            data: { issueNumber: 9, title: "Boom", body: "Details" }
          }
        })
        void interrupted
        github.setIssue(9, { title: "Boom", body: "Details", labels: ["type: bug"] })
        const callsBeforeReconcile = github.calls.length
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: (input) => classifyJev(input.request, input.descriptions, fakeKey, { endpoint: jev.url, timeoutMs: 5000, maxRetries: 0 }),
          githubOptions: connectorOptions
        }
        jev.setReply(() => ({ status: 200, body: stubChoiceBody("bug", { bug: 0.9, question: 0.08, no_match: 0.02 }, 0.85) }))
        const reclaimed = yield* reclaimInterruptedRuns(environment, DefaultAutomationWorkerOptions)
        expect(reclaimed).toBeGreaterThanOrEqual(1)
        expect((yield* executions.getRun(scope, "run-9"))?.value.state.kind).toBe("queued")
        const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, baseBackoffMs: 1 }, scope, "run-9")
        expect(outcome).toBe("completed")
        expect(github.getIssueLabels(9)).toEqual(["type: bug"])
        const recent = github.calls.slice(callsBeforeReconcile)
        expect(recent.some((call) => call.method === "GET")).toBe(true)
        const posts = recent.filter((call) => call.method === "POST")
        const history = (yield* executions.history(scope, "run-9"))!
        expect(history.attempts.length).toBeGreaterThanOrEqual(2)
        expect(posts.length).toBeLessThanOrEqual(1)
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped)
  )

  it.live("skips the duplicate write when reconciliation finds the label applied", () =>
    Effect.gen(function*() {
      const jev = yield* withJev
      const github = yield* withGithub
      github.setIssue(11, { title: "Boom", body: "Details", labels: ["type: bug"] })
      const callsBefore = github.calls.length
      const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
      const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
      const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const registry = new AutomationRegistry()
      const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
        Layer.provideMerge(Creds)
      )
      const connectorOptions = { baseUrl: github.baseUrl, timeoutMs: 5000, maxRetries: 0 }
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const connectorServices: GithubConnectorServices = { configurations, credentials, http }
        yield* registry.register(makeGithubConnectorExtension(connectorOptions, connectorServices).extension)
        yield* credentials.putCredential(scope, "github-token", new TextEncoder().encode("stub-github-token"), 0)
        const process = yield* buildGithubClassificationProcess("github", classification)
        yield* routines.create(scope, {
          routineId: "triage",
          template: githubTemplateReference,
          configuration: classification,
          integrations: [githubIntegration],
          process
        })
        yield* ingestGithubRun("run-11", "job-11", "issue-11", 11)
        yield* executions.recordAttempt(scope, {
          id: "action-interrupted-11",
          scope,
          runId: "run-11",
          jobId: "job-11",
          stepId: "label-bug",
          attempt: 1,
          startedAt: "t-crash-action",
          kind: "action",
          status: "started",
          integration: { id: "github", definition: githubIntegrationReference },
          action: { ...githubLabelActionReference },
          arguments: { issueNumber: 11, label: "type: bug" }
        })
        jev.setReply(() => ({ status: 200, body: stubChoiceBody("bug", { bug: 0.9, question: 0.08, no_match: 0.02 }, 0.85) }))
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: (input) => classifyJev(input.request, input.descriptions, fakeKey, { endpoint: jev.url, timeoutMs: 5000, maxRetries: 0 }),
          githubOptions: connectorOptions
        }
        const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, baseBackoffMs: 1 }, scope, "run-11")
        expect(outcome).toBe("completed")
        expect((yield* executions.getRun(scope, "run-11"))?.value.state.kind).toBe("succeeded")
        const posts = github.calls.slice(callsBefore).filter((call) => call.method === "POST")
        expect(posts).toEqual([])
        const history = (yield* executions.history(scope, "run-11"))!
        const completedActions = history.attempts.filter(
          (entry): entry is Extract<Attempt, { kind: "action"; status: "completed" }> =>
            entry.kind === "action" && entry.status === "completed"
        )
        expect(completedActions.length).toBeGreaterThanOrEqual(1)
        const reconciled = completedActions.some((entry) => {
          if (entry.outcome.kind !== "succeeded") return false
          const result = entry.outcome.result as unknown
          return typeof result === "object" && result !== null && (result as { reconciled?: unknown }).reconciled === true
        })
        expect(reconciled).toBe(true)
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped)
  )

  it.live("runs custom triggered routines through the same worker path", () =>
    Effect.gen(function*() {
      let calls = 0
      const registry = new AutomationRegistry()
      yield* registry.register(
        makeSampleExtension(() => Effect.sync(() => { calls += 1; return { summary: "mail ok", total: 2 } })).extension
      )
      yield* registry.register(makeGithubExtension().extension)
      const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
      const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
      const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
        Layer.provideMerge(Creds)
      )
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        yield* credentials.putCredential(scope, "account-1", new TextEncoder().encode("secret"), 0)
        const mailIntegration = {
          schemaVersion: 1 as const,
          kind: "integration-configuration" as const,
          id: "mail",
          definition: { id: "sample:mail" as const, version: 1 as const },
          configuration: { mailbox: "inbox" },
          credentials: {
            account: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "account-1" }
          }
        }
        const mailProcess = {
          schemaVersion: 1 as const,
          kind: "process" as const,
          trigger: {
            definition: { id: "sample:received" as const, version: 1 as const },
            integration: { id: "mail", definition: { id: "sample:mail" as const, version: 1 as const } },
            configuration: {}
          },
          actions: {
            triggered: [
              {
                id: "send",
                action: { id: "sample:send" as const, version: 1 as const },
                integration: { id: "mail", definition: { id: "sample:mail" as const, version: 1 as const } },
                bindings: {
                  message: { kind: "field" as const, source: "trigger" as const, path: ["subject"] },
                  count: { kind: "field" as const, source: "trigger" as const, path: ["count"] }
                }
              }
            ]
          }
        }
        yield* routines.create(scope, {
          routineId: "personal-mail",
          configuration: { prefix: "Hello" },
          integrations: [mailIntegration],
          process: mailProcess
        })
        const delivery = {
          schemaVersion: 1 as const,
          id: "mail-input",
          scope,
          integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
          externalId: "mail-input",
          trigger: { id: "sample:received", version: 1 },
          payload: { subject: "hello", count: "2" }
        }
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "mail-run",
          scope,
          configuration: { routineId: "personal-mail", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "mail-input" },
          mode: "live" as const,
          authority: {
            schemaVersion: 1 as const,
            kind: "invocation-authority" as const,
            scope,
            configuration: { routineId: "personal-mail", revision: 1 as const },
            integrationIds: ["mail"],
            actionGrants: [{ action: { id: "sample:send", version: 1 }, integrationId: "mail", capabilities: ["send"] }]
          },
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([9]), targets: [{ jobId: "mail-job", run }] })
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: (() => Effect.fail({ code: "unused", message: "unused" }) as never)
        }
        const processed = yield* sweepOnce(environment, { ...DefaultAutomationWorkerOptions, baseBackoffMs: 1 })
        expect(processed).toBeGreaterThanOrEqual(1)
        expect((yield* executions.getRun(scope, "mail-run"))?.value.state.kind).toBe("succeeded")
        expect(calls).toBe(1)
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped)
  )

  for (const testCase of [
    {
      decision: { schemaVersion: 1, kind: "selected", outcomeId: "bug", data: {} },
      outcome: "completed",
      state: "succeeded"
    },
    {
      decision: { schemaVersion: 1, kind: "abstained", reason: "Saved abstention" },
      outcome: "unresolved",
      state: "unresolved"
    }
  ] as const) {
    it.live(`reuses a saved ${testCase.decision.kind} decision after reclaiming an interrupted run`, () =>
      Effect.gen(function*() {
        const jev = yield* withJev
        const github = yield* withGithub
        const labels = testCase.decision.kind === "selected" ? ["type: bug"] : []
        github.setIssue(12, { title: "Boom", body: "Details", labels })
        const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
        const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
        const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
        const registry = new AutomationRegistry()
        const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
          Layer.provideMerge(Creds)
        )
        const connectorOptions = { baseUrl: github.baseUrl, timeoutMs: 5000, maxRetries: 0 }
        const program = Effect.gen(function*() {
          const routines = yield* RoutineService
          const executions = yield* ExecutionRepository
          const configurations = yield* ConfigurationRepository
          const credentials = yield* CredentialRepository
          const sql = yield* SqlClient
          const http = yield* HttpClient.HttpClient
          yield* registry.register(makeGithubConnectorExtension(connectorOptions, { configurations, credentials, http }).extension)
          yield* credentials.putCredential(scope, "github-token", new TextEncoder().encode("stub-github-token"), 0)
          const process = yield* buildGithubClassificationProcess("github", classification)
          yield* routines.create(scope, {
            routineId: "triage",
            template: githubTemplateReference,
            configuration: classification,
            integrations: [githubIntegration],
            process
          })
          yield* ingestGithubRun("run-12", "job-12", "issue-12", 12)
          const run = (yield* executions.getRun(scope, "run-12"))!
          const job = (yield* executions.getJob(scope, "job-12"))!
          const started: Extract<Attempt, { kind: "decision"; status: "started" }> = {
            id: "saved-decision-12",
            scope,
            runId: "run-12",
            jobId: "job-12",
            stepId: "decision",
            attempt: 1,
            startedAt: "1",
            kind: "decision",
            status: "started",
            request: {
              schemaVersion: 1,
              kind: "jev-request",
              provider: "opencode-zen",
              model: "jev",
              version: "1.13",
              configuration: run.value.configuration,
              input: run.value.input,
              outcomes: ["bug", "question"],
              data: { issueNumber: 12, title: "Boom", body: "Details" }
            }
          }
          yield* executions.recordAttempt(scope, started)
          const completed: Attempt = { ...started, status: "completed", finishedAt: "2", result: testCase.decision }
          yield* executions.recordAttempt(scope, completed, {
            expectedRunVersion: run.version,
            expectedJobVersion: job.version,
            run: { ...run.value, state: { kind: "running" }, decision: testCase.decision },
            job: { ...job.value, state: { kind: "running" } }
          })
          if (testCase.decision.kind === "selected") {
            yield* executions.recordAttempt(scope, {
              id: "unfinished-label-12",
              scope,
              runId: "run-12",
              jobId: "job-12",
              stepId: "label-bug",
              attempt: 1,
              startedAt: "3",
              kind: "action",
              status: "started",
              integration: { id: "github", definition: githubIntegrationReference },
              action: githubLabelActionReference,
              arguments: { issueNumber: 12, label: "type: bug" }
            })
          }
          jev.setReply(() => ({ status: 200, body: stubChoiceBody("question", { bug: 0.08, question: 0.9, no_match: 0.02 }, 0.85) }))
          const environment: AutomationWorkerEnvironment = {
            services: { configurations, credentials, executions, sql, http },
            registry,
            routines,
            decide: (input) => classifyJev(input.request, input.descriptions, fakeKey, { endpoint: jev.url, timeoutMs: 5000, maxRetries: 0 }),
            githubOptions: connectorOptions
          }
          expect(yield* reclaimInterruptedRuns(environment)).toBe(1)
          expect((yield* executions.getRun(scope, "run-12"))?.value.state.kind).toBe("queued")
          expect(yield* processRun(environment, DefaultAutomationWorkerOptions, scope, "run-12")).toBe(testCase.outcome)
          const history = (yield* executions.history(scope, "run-12"))!
          expect(history.run.value.state.kind).toBe(testCase.state)
          expect(history.run.value.decision).toEqual(testCase.decision)
          expect(history.attempts.filter((entry) => entry.kind === "decision")).toEqual([completed])
          expect(jev.calls).toEqual([])
          expect(github.getIssueLabels(12)).toEqual(labels)
          expect(github.calls.filter((call) => call.method === "POST")).toEqual([])
          if (testCase.decision.kind === "selected") {
            expect(github.calls.some((call) => call.method === "GET")).toBe(true)
            expect(history.run.value.actions).toEqual([{
              kind: "succeeded",
              stepId: "label-bug",
              action: githubLabelActionReference,
              result: { reconciled: true, label: "type: bug" }
            }])
            expect(history.attempts.filter((entry) => entry.kind === "action").map((entry) => entry.stepId)).toEqual(["label-bug", "label-bug"])
          } else {
            expect(history.run.value.actions).toEqual([])
            expect(history.attempts.filter((entry) => entry.kind === "action")).toEqual([])
          }
        })
        yield* program.pipe(Effect.provide(Live))
      }).pipe(Effect.scoped)
    )
  }
})
