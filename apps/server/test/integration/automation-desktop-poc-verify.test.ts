import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { createHmac } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
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
  githubTemplateReference,
} from "@expand/contracts/automation/github"
import { GithubWebhookCredentialSlot, makeGithubWebhookHandler } from "../../automation/github-webhook.js"
import { classifyJev } from "../../automation/jev-client.js"
import { runIssueClassification } from "../../automation/issue-classification.js"
import {
  DefaultAutomationWorkerOptions,
  processRun,
  reclaimInterruptedRuns,
  sweepOnce,
} from "../../automation/worker.js"
import { startJevStub, stubChoiceBody } from "../fixtures/automation-jev-stub.js"
import { startGithubStub } from "../fixtures/automation-github-stub.js"

const scope = { ownerId: "t20-owner", projectId: "t20-project" }
const webhookSecretText = "t20-webhook-secret"
const tokenSecretText = "t20-github-token"
const webhookSecretBytes = new TextEncoder().encode(webhookSecretText)
const tokenSecretBytes = new TextEncoder().encode(tokenSecretText)
const fakeKey = "stub-zen-key-for-tests-only"
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
  notifications: { onMatch: true, onNoMatch: false },
}
const githubIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "github" as const,
  definition: { id: "github:integration" as const, version: 1 as const },
  configuration: { owner: "octo", repo: "hello" },
  credentials: {
    token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "github-token" },
    [GithubWebhookCredentialSlot]: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "github-webhook" },
  },
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const sign = (secret: string, raw: Uint8Array): string =>
  `sha256=${createHmac("sha256", secret).update(Buffer.from(raw)).digest("hex")}`
const openedRaw = (issueNumber: number, title: string, body: string): Uint8Array =>
  new TextEncoder().encode(encodeJson({
    action: "opened",
    repository: { name: "hello", owner: { login: "octo" } },
    issue: { number: issueNumber, title, body },
  }))

const withJev = Effect.acquireRelease(startJevStub(), (stub) => Effect.sync(() => stub.close()))
const withGithub = Effect.acquireRelease(startGithubStub(), (stub) => Effect.sync(() => stub.close()))
const tempFile = Effect.tryPromise(() => mkdtemp(join(tmpdir(), "t20-poc-"))).pipe(
  Effect.map((dir) => join(dir, "state.sqlite")),
)

const buildLayers = (filename: string, registry: AutomationRegistry) => {
  const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename })))
  const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
  const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
  return Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
    Layer.provideMerge(Creds),
  )
}

describe("desktop PoC verification", () => {
  it.live("accepts a signed webhook, dedups redelivery, completes via worker with labels and stored history", () =>
    Effect.gen(function* () {
      const jev = yield* withJev
      const github = yield* withGithub
      github.setIssue(421, { title: "Checkout is broken", body: "Payments fail", labels: [] })
      const filename = yield* tempFile
      const registry = new AutomationRegistry()
      const Live = buildLayers(filename, registry)
      const program = Effect.gen(function* () {
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const executions = yield* ExecutionRepository
        const routines = yield* RoutineService
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const connectorServices: GithubConnectorServices = { configurations, credentials, http }
        yield* registry.register(makeGithubConnectorExtension({ baseUrl: github.baseUrl, timeoutMs: 5000, maxRetries: 0 }, connectorServices).extension)
        yield* credentials.putCredential(scope, "github-token", tokenSecretBytes, 0)
        yield* credentials.putCredential(scope, "github-webhook", webhookSecretBytes, 0)
        const process = yield* buildGithubClassificationProcess("github", classification)
        yield* routines.create(scope, {
          routineId: "triage",
          template: githubTemplateReference,
          configuration: classification,
          integrations: [githubIntegration],
          process,
        })
        const handler = makeGithubWebhookHandler({ configurations, credentials, executions, sql })
        const raw = openedRaw(421, "Checkout is broken", "Payments fail")
        const first = yield* handler.handle({ deliveryId: "t20-delivery-1", event: "issues", signature: sign(webhookSecretText, raw), raw })
        expect(first.status).toBe(200)
        expect(first.accepted).toBe(true)
        const runsBefore = yield* executions.listRuns(scope, { limit: 10 })
        expect(runsBefore.items).toHaveLength(1)
        const runId = runsBefore.items[0]!.value.id
        const second = yield* handler.handle({ deliveryId: "t20-delivery-1", event: "issues", signature: sign(webhookSecretText, raw), raw })
        expect(second.status).toBe(200)
        const runsAfter = yield* executions.listRuns(scope, { limit: 10 })
        expect(runsAfter.items).toHaveLength(1)
        expect(runsAfter.items[0]!.value.id).toBe(runId)
        jev.setReply(() => ({ status: 200, body: stubChoiceBody("bug", { bug: 0.9, question: 0.08, no_match: 0.02 }, 0.85) }))
        const environment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: (input: { request: unknown; descriptions: Record<string, string> }) =>
            classifyJev(input.request, input.descriptions, fakeKey, { endpoint: jev.url, timeoutMs: 5000, maxRetries: 0 }),
          githubOptions: { baseUrl: github.baseUrl, timeoutMs: 5000, maxRetries: 0 },
        }
        const processed = yield* sweepOnce(environment, { ...DefaultAutomationWorkerOptions, baseBackoffMs: 1 })
        expect(processed).toBeGreaterThanOrEqual(1)
        expect((yield* executions.getRun(scope, runId))?.value.state.kind).toBe("succeeded")
        expect(github.getIssueLabels(421)).toContain("type: bug")
        const history = (yield* executions.history(scope, runId))!
        expect(history.run.value.state.kind).toBe("succeeded")
        expect(history.attempts.length).toBeGreaterThanOrEqual(2)
        expect(jev.calls.length).toBeGreaterThanOrEqual(1)
        const decision = history.attempts.find((attempt) => attempt.kind === "decision")
        expect(decision?.kind).toBe("decision")
        if (decision?.kind === "decision") expect(decision.request.input.id).toBe("t20-delivery-1:github")
        const reopened = yield* Layer.build(buildLayers(filename, new AutomationRegistry()))
        const reopenedExecutions = Context.get(reopened, ExecutionRepository)
        expect((yield* reopenedExecutions.getRun(scope, runId))?.value.state.kind).toBe("succeeded")
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped),
  )

  it.live("rejects invalid signatures, records provider failures without labels, cancels paused routines, previews without mutation", () =>
    Effect.gen(function* () {
      const jev = yield* withJev
      const github = yield* withGithub
      github.setIssue(422, { title: "Login is broken", body: "SSO fails", labels: [] })
      github.setIssue(423, { title: "Export is broken", body: "CSV fails", labels: [] })
      github.setIssue(424, { title: "Search is broken", body: "Slow", labels: [] })
      const filename = yield* tempFile
      const registry = new AutomationRegistry()
      const Live = buildLayers(filename, registry)
      const program = Effect.gen(function* () {
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const executions = yield* ExecutionRepository
        const routines = yield* RoutineService
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const connectorServices: GithubConnectorServices = { configurations, credentials, http }
        yield* registry.register(makeGithubConnectorExtension({ baseUrl: github.baseUrl, timeoutMs: 5000, maxRetries: 0 }, connectorServices).extension)
        yield* credentials.putCredential(scope, "github-token", tokenSecretBytes, 0)
        yield* credentials.putCredential(scope, "github-webhook", webhookSecretBytes, 0)
        const process = yield* buildGithubClassificationProcess("github", classification)
        yield* routines.create(scope, {
          routineId: "triage",
          template: githubTemplateReference,
          configuration: classification,
          integrations: [githubIntegration],
          process,
        })
        const handler = makeGithubWebhookHandler({ configurations, credentials, executions, sql })
        const badRaw = openedRaw(422, "Login is broken", "SSO fails")
        const bad = yield* handler.handle({ deliveryId: "t20-bad-1", event: "issues", signature: sign("wrong-secret", badRaw), raw: badRaw })
        expect(bad).toEqual({ status: 401, accepted: false })
        expect((yield* executions.listRuns(scope, { limit: 10 })).items).toHaveLength(0)
        const rawFail = openedRaw(422, "Login is broken", "SSO fails")
        const acceptedFail = yield* handler.handle({ deliveryId: "t20-delivery-fail", event: "issues", signature: sign(webhookSecretText, rawFail), raw: rawFail })
        expect(acceptedFail.accepted).toBe(true)
        const failRunId = (yield* executions.listRuns(scope, { limit: 10 })).items[0]!.value.id
        jev.setReply(() => ({ status: 500, body: { error: "provider is down" } }))
        const failEnv = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: (input: { request: unknown; descriptions: Record<string, string> }) =>
            classifyJev(input.request, input.descriptions, fakeKey, { endpoint: jev.url, timeoutMs: 5000, maxRetries: 0 }),
          githubOptions: { baseUrl: github.baseUrl, timeoutMs: 5000, maxRetries: 0 },
        }
        const failOutcome = yield* processRun(failEnv, { ...DefaultAutomationWorkerOptions, maxAttempts: 1, baseBackoffMs: 1 }, scope, failRunId)
        expect(failOutcome).toBe("failed")
        expect((yield* executions.getRun(scope, failRunId))?.value.state.kind).toBe("failed")
        expect(github.getIssueLabels(422)).toEqual([])
        const rawPaused = openedRaw(423, "Export is broken", "CSV fails")
        const acceptedPaused = yield* handler.handle({ deliveryId: "t20-delivery-paused", event: "issues", signature: sign(webhookSecretText, rawPaused), raw: rawPaused })
        expect(acceptedPaused.accepted).toBe(true)
        const pausedRunId = (yield* executions.listRuns(scope, { limit: 10 })).items.find((item) => item.value.id.includes("t20-delivery-paused"))!.value.id
        const pausedHead = yield* routines.pause(scope, "triage", 1)
        expect(pausedHead.status).toBe("paused")
        const rawIgnored = openedRaw(423, "Export is broken", "CSV fails")
        const ignored = yield* handler.handle({ deliveryId: "t20-delivery-ignored", event: "issues", signature: sign(webhookSecretText, rawIgnored), raw: rawIgnored })
        expect(ignored.accepted).toBe(false)
        jev.setReply(() => ({ status: 200, body: stubChoiceBody("bug", { bug: 0.9, question: 0.08, no_match: 0.02 }, 0.85) }))
        const pausedOutcome = yield* processRun(failEnv, { ...DefaultAutomationWorkerOptions, maxAttempts: 1, baseBackoffMs: 1 }, scope, pausedRunId)
        expect(pausedOutcome).toBe("cancelled")
        expect((yield* executions.getRun(scope, pausedRunId))?.value.state.kind).toBe("cancelled")
        expect(github.getIssueLabels(423)).toEqual([])
        yield* routines.enable(scope, "triage", pausedHead.version)
        const routine = (yield* routines.get(scope, "triage"))!
        const callsBeforePreview = github.calls.length
        const preview = yield* runIssueClassification({
          configuration: routine.configuration,
          issue: { issueNumber: 424, title: "Search is broken", body: "Slow" },
          mode: "preview",
          decide: () => Effect.succeed({ schemaVersion: 1, kind: "selected", outcomeId: "bug", data: { choice: "bug", probabilities: { bug: 1 }, confidence: 1 } } as never),
          registry,
        })
        expect(preview.kind).toBe("classified")
        if (preview.kind === "classified") expect(preview.executed).toBe(false)
        expect(github.calls.length).toBe(callsBeforePreview)
        expect(github.getIssueLabels(424)).toEqual([])
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped),
  )

  it.live("reclaims an interrupted run after a crash and completes with zero clients attached", () =>
    Effect.gen(function* () {
      const jev = yield* withJev
      const github = yield* withGithub
      github.setIssue(425, { title: "Sync is broken", body: "Data lags", labels: [] })
      const filename = yield* tempFile
      const registry = new AutomationRegistry()
      const Live = buildLayers(filename, registry)
      const program = Effect.gen(function* () {
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const executions = yield* ExecutionRepository
        const routines = yield* RoutineService
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const connectorServices: GithubConnectorServices = { configurations, credentials, http }
        yield* registry.register(makeGithubConnectorExtension({ baseUrl: github.baseUrl, timeoutMs: 5000, maxRetries: 0 }, connectorServices).extension)
        yield* credentials.putCredential(scope, "github-token", tokenSecretBytes, 0)
        yield* credentials.putCredential(scope, "github-webhook", webhookSecretBytes, 0)
        const process = yield* buildGithubClassificationProcess("github", classification)
        yield* routines.create(scope, {
          routineId: "triage",
          template: githubTemplateReference,
          configuration: classification,
          integrations: [githubIntegration],
          process,
        })
        const handler = makeGithubWebhookHandler({ configurations, credentials, executions, sql })
        const raw = openedRaw(425, "Sync is broken", "Data lags")
        const accepted = yield* handler.handle({ deliveryId: "t20-delivery-crash", event: "issues", signature: sign(webhookSecretText, raw), raw })
        expect(accepted.accepted).toBe(true)
        const runId = (yield* executions.listRuns(scope, { limit: 10 })).items[0]!.value.id
        const storedRun = (yield* executions.getRun(scope, runId))!
        const jobId = accepted.accepted ? (accepted.jobIds[0] as string) : "missing"
        const storedJob = (yield* executions.getJob(scope, jobId))!
        yield* executions.update(scope, {
          expectedRunVersion: storedRun.version,
          expectedJobVersion: storedJob.version,
          run: { ...storedRun.value, state: { kind: "running" } },
          job: { ...storedJob.value, state: { kind: "running" } },
        })
        yield* executions.recordAttempt(scope, {
          id: "t20-crash-decision-1",
          scope,
          runId,
          jobId: storedJob.value.id,
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
            input: { kind: "input-reference", id: "t20-delivery-crash:github" },
            outcomes: ["bug", "question"],
            data: { issueNumber: 425, title: "Sync is broken", body: "Data lags" },
          },
        })
        jev.setReply(() => ({ status: 200, body: stubChoiceBody("question", { bug: 0.1, question: 0.88, no_match: 0.02 }, 0.87) }))
        const environment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: (input: { request: unknown; descriptions: Record<string, string> }) =>
            classifyJev(input.request, input.descriptions, fakeKey, { endpoint: jev.url, timeoutMs: 5000, maxRetries: 0 }),
          githubOptions: { baseUrl: github.baseUrl, timeoutMs: 5000, maxRetries: 0 },
        }
        const reclaimed = yield* reclaimInterruptedRuns(environment, DefaultAutomationWorkerOptions)
        expect(reclaimed).toBeGreaterThanOrEqual(1)
        expect((yield* executions.getRun(scope, runId))?.value.state.kind).toBe("queued")
        const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, baseBackoffMs: 1 }, scope, runId)
        expect(outcome).toBe("completed")
        expect(github.getIssueLabels(425)).toContain("type: question")
        const crashHistory = (yield* executions.history(scope, runId))!
        expect(crashHistory.run.value.state.kind).toBe("succeeded")
        const crashDecision = crashHistory.attempts.find((attempt) => attempt.kind === "decision")
        expect(crashDecision?.kind).toBe("decision")
        if (crashDecision?.kind === "decision") expect(crashDecision.request.input.id).toBe("t20-delivery-crash:github")
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped),
  )
})
