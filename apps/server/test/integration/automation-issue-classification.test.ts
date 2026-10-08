import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
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
import { runIssueClassification } from "../../automation/issue-classification.js"
import { classifyJev } from "../../automation/jev-client.js"
import { startJevStub, stubChoiceBody } from "../fixtures/automation-jev-stub.js"
import { startGithubStub } from "../fixtures/automation-github-stub.js"

const scope = { ownerId: "person", projectId: "project" }
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
const issue = { issueNumber: 7, title: "Boom", body: "Details" }
const withJev = Effect.acquireRelease(startJevStub(), (stub) => Effect.sync(() => stub.close()))
const withGithub = Effect.acquireRelease(startGithubStub(), (stub) => Effect.sync(() => stub.close()))
const makeStubSetup = () => {
  const mutations: Array<{ readonly args: unknown }> = []
  const registry = new AutomationRegistry()
  Effect.runSync(Effect.gen(function*() {
    const { extension } = makeGithubExtension((args) =>
      Effect.sync(() => {
        mutations.push({ args })
        return { applied: true }
      })
    )
    yield* registry.register(extension)
  }))
  const services = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
    Layer.provideMerge(Creds)
  )
  return { registry, mutations, services }
}
const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
const firstSetup = makeStubSetup()
const secondSetup = makeStubSetup()
const LiveBase = Layer.mergeAll(Creds, NodeHttpClient.layerFetch)
const servicesFor = Effect.gen(function*() {
  const context = yield* Layer.build(LiveBase)
  return {
    configurations: Context.get(context, ConfigurationRepository),
    credentials: Context.get(context, CredentialRepository),
    http: Context.get(context, HttpClient.HttpClient)
  } satisfies GithubConnectorServices
})
const providedFor = (services: GithubConnectorServices) => Layer.mergeAll(
  Layer.succeed(ConfigurationRepository, services.configurations),
  Layer.succeed(CredentialRepository, services.credentials),
  Layer.succeed(HttpClient.HttpClient, services.http)
)
const withServices = <A, E, R>(body: (services: GithubConnectorServices) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(servicesFor, (services) =>
    Effect.provide(providedFor(services))(body(services)))

describe("issue classification routine end to end", () => {
  it.live("matches through stubbed Jev transport to a validated label action with real history", () =>
    Effect.gen(function*() {
      const stub = yield* withJev
      const routines = yield* RoutineService
      const repository = yield* ExecutionRepository
      const credentials = yield* CredentialRepository
      yield* credentials.putCredential(scope, "github-token", new TextEncoder().encode("stub-github-token"), 0)
      const process = yield* buildGithubClassificationProcess("github", classification)
      yield* routines.create(scope, {
        routineId: "triage",
        template: githubTemplateReference,
        configuration: classification,
        integrations: [githubIntegration],
        process
      })
      const routine = (yield* routines.get(scope, "triage"))!
      stub.setReply(() => ({
        status: 200,
        body: stubChoiceBody("bug", { bug: 0.88, question: 0.1, no_match: 0.02 }, 0.81)
      }))
      const outcome = yield* runIssueClassification({
        configuration: routine.configuration,
        issue,
        mode: "live",
        decide: (input) => classifyJev(input.request, input.descriptions, fakeKey, { endpoint: stub.url, timeoutMs: 5000, maxRetries: 0 }),
        registry: firstSetup.registry
      })
      expect(outcome.kind).toBe("classified")
      if (outcome.kind !== "classified") return
      expect(outcome.outcomeId).toBe("bug")
      expect(outcome.label).toBe("type: bug")
      expect(outcome.executed).toBe(true)
      expect(outcome.actions.map((action) => action.arguments)).toEqual([{ issueNumber: 7, label: "type: bug" }])
      expect(outcome.decision).toEqual({
        schemaVersion: 1,
        kind: "selected",
        outcomeId: "bug",
        data: {
          choice: "bug",
          probabilities: { bug: 0.88, question: 0.1, no_match: 0.02 },
          confidence: 0.81
        }
      })
      expect(typeof outcome.latencyMs).toBe("number")
      expect(firstSetup.mutations).toHaveLength(1)
      expect(firstSetup.mutations[0]?.args).toEqual({ issueNumber: 7, label: "type: bug" })
      const delivery = {
        schemaVersion: 1 as const,
        id: "issue-7",
        scope,
        integration: { id: "github", definition: githubIntegrationReference },
        externalId: "ext-7",
        trigger: githubTriggerReference,
        payload: { issueNumber: 7, title: "Boom", body: "Details" }
      }
      const run = {
        schemaVersion: 1 as const,
        kind: "run" as const,
        id: "run-1",
        scope,
        configuration: { routineId: "triage", revision: 1 as const },
        input: { kind: "input-reference" as const, id: "issue-7" },
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
      yield* repository.ingest({ delivery, raw: new Uint8Array([1, 2, 3]), targets: [{ jobId: "job-1", run }] })
      const started = {
        id: "decision-1",
        scope,
        runId: "run-1",
        jobId: "job-1",
        stepId: "decision",
        attempt: 1,
        startedAt: "t1",
        kind: "decision" as const,
        status: "started" as const,
        request: outcome.request
      }
      yield* repository.recordAttempt(scope, started)
      const job = (yield* repository.getJob(scope, "job-1"))!.value
      const stepId = outcome.actions[0]!.stepId
      const planned = { kind: "planned" as const, stepId, action: githubLabelActionReference, arguments: outcome.actions[0]!.arguments }
      const next = {
        ...run,
        state: { kind: "running" as const },
        decision: outcome.decision,
        actions: [planned]
      }
      yield* repository.recordAttempt(
        scope,
        { ...started, status: "completed" as const, finishedAt: "t2", result: outcome.decision },
        { expectedRunVersion: 1, expectedJobVersion: 1, run: next, job: { ...job, state: next.state } }
      )
      const history = (yield* repository.history(scope, "run-1"))!
      expect(history.run.value.decision).toEqual(outcome.decision)
      expect(history.attempts).toHaveLength(1)
      expect(history.attempts[0]).toMatchObject({ kind: "decision", status: "completed", result: outcome.decision })
      expect(history.run.value.actions).toEqual([planned])
    }).pipe(Effect.provide(firstSetup.services))
  )
  it.live("leaves unmatched issues unresolved with zero mutations and real abstention history", () =>
    Effect.gen(function*() {
      const stub = yield* withJev
      const routines = yield* RoutineService
      const repository = yield* ExecutionRepository
      const credentials = yield* CredentialRepository
      yield* credentials.putCredential(scope, "github-token", new TextEncoder().encode("stub-github-token"), 0)
      const process = yield* buildGithubClassificationProcess("github", classification)
      yield* routines.create(scope, {
        routineId: "triage",
        template: githubTemplateReference,
        configuration: classification,
        integrations: [githubIntegration],
        process
      })
      const routine = (yield* routines.get(scope, "triage"))!
      stub.setReply(() => ({
        status: 200,
        body: stubChoiceBody("no_match", { bug: 0.3, question: 0.3, no_match: 0.4 }, 0.2)
      }))
      const outcome = yield* runIssueClassification({
        configuration: routine.configuration,
        issue,
        mode: "live",
        decide: (input) => classifyJev(input.request, input.descriptions, fakeKey, { endpoint: stub.url, timeoutMs: 5000, maxRetries: 0 }),
        registry: secondSetup.registry
      })
      expect(outcome.kind).toBe("unresolved")
      if (outcome.kind !== "unresolved") return
      expect(outcome.executed).toBe(false)
      expect(outcome.decision.kind).toBe("abstained")
      expect(typeof outcome.latencyMs).toBe("number")
      expect(secondSetup.mutations).toHaveLength(0)
      const delivery = {
        schemaVersion: 1 as const,
        id: "issue-7",
        scope,
        integration: { id: "github", definition: githubIntegrationReference },
        externalId: "ext-7",
        trigger: githubTriggerReference,
        payload: { issueNumber: 7, title: "Boom", body: "Details" }
      }
      const run = {
        schemaVersion: 1 as const,
        kind: "run" as const,
        id: "run-1",
        scope,
        configuration: { routineId: "triage", revision: 1 as const },
        input: { kind: "input-reference" as const, id: "issue-7" },
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
      yield* repository.ingest({ delivery, raw: new Uint8Array([1, 2, 3]), targets: [{ jobId: "job-1", run }] })
      const started = {
        id: "decision-1",
        scope,
        runId: "run-1",
        jobId: "job-1",
        stepId: "decision",
        attempt: 1,
        startedAt: "t1",
        kind: "decision" as const,
        status: "started" as const,
        request: outcome.request
      }
      yield* repository.recordAttempt(scope, started)
      const job = (yield* repository.getJob(scope, "job-1"))!.value
      const next = {
        ...run,
        state: { kind: "unresolved" as const, reason: outcome.reason },
        decision: outcome.decision,
        actions: []
      }
      yield* repository.recordAttempt(
        scope,
        { ...started, status: "completed" as const, finishedAt: "t2", result: outcome.decision },
        { expectedRunVersion: 1, expectedJobVersion: 1, run: next, job: { ...job, state: next.state } }
      )
      const history = (yield* repository.history(scope, "run-1"))!
      expect(history.run.value.state).toEqual({ kind: "unresolved", reason: outcome.reason })
      expect(history.run.value.decision).toEqual(outcome.decision)
      expect(history.attempts[0]).toMatchObject({ kind: "decision", result: outcome.decision })
      expect(secondSetup.mutations).toHaveLength(0)
    }).pipe(Effect.provide(secondSetup.services))
  )
})

describe("issue classification explicit github services", () => {
  it.live("applies validated labels through the T06 connector with explicit services", () =>
    withServices((services) => Effect.gen(function*() {
      const jevStub = yield* withJev
      const githubStub = yield* withGithub
      const secret = new TextEncoder().encode("stub-github-token-for-tests-only")
      yield* services.credentials.putCredential(scope, "github-token", secret, 0)
      yield* services.configurations.putIntegration(scope, githubIntegration, 0)
      githubStub.setIssue(7, { title: "Boom", body: "Details", labels: ["old"] })
      const options = { baseUrl: githubStub.baseUrl, timeoutMs: 5000, maxRetries: 0 }
      const connector = makeGithubConnectorExtension(options, services)
      const liveRegistry = new AutomationRegistry()
      yield* liveRegistry.register(connector.extension)
      const process = yield* buildGithubClassificationProcess("github", classification)
      const configuration = {
        schemaVersion: 1 as const,
        kind: "routine-configuration" as const,
        reference: { routineId: "triage", revision: 1 as const },
        scope,
        configuration: classification,
        integrations: [githubIntegration],
        process
      }
      jevStub.setReply(() => ({
        status: 200,
        body: stubChoiceBody("bug", { bug: 0.88, question: 0.1, no_match: 0.02 }, 0.81)
      }))
      const outcome = yield* runIssueClassification({
        configuration,
        issue,
        mode: "live",
        decide: (input) => classifyJev(input.request, input.descriptions, fakeKey, { endpoint: jevStub.url, timeoutMs: 5000, maxRetries: 0 }),
        registry: liveRegistry
      })
      expect(outcome.kind).toBe("classified")
      if (outcome.kind !== "classified") return
      expect(outcome.outcomeId).toBe("bug")
      expect(outcome.label).toBe("type: bug")
      expect(outcome.executed).toBe(true)
      expect(outcome.actions.map((action) => action.arguments)).toEqual([{ issueNumber: 7, label: "type: bug" }])
      expect(githubStub.getIssueLabels(7)).toEqual(["old", "type: bug"])
    }))
  )
})
