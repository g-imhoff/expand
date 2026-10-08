import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Context, Effect, Fiber, Layer, Schedule } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { buildGmailClassificationProcess, gmailTemplateReference } from "@expand/contracts/automation/gmail"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { getPollHistoryId, hasSeenMessage, makeGmailConnectorExtension } from "../../automation/gmail-connector.js"
import { pollGmailOnce } from "../../automation/gmail-polling.js"
import { startAutomationProcessing } from "../../automation/runtime.js"
import { DefaultAutomationWorkerOptions, processRun } from "../../automation/worker.js"
import type { AutomationWorkerEnvironment } from "../../automation/worker.js"
import { StorageError } from "../../automation/persistence-models.js"
import { makeAutomationDecide } from "../../composition/app.js"
import { startGmailStub } from "../fixtures/automation-gmail-stub.js"
import { startJevStub, stubChoiceBody } from "../fixtures/automation-jev-stub.js"

const scope = { ownerId: "poll-owner", projectId: "poll-project" }
const integration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "gmail",
  definition: { id: "gmail:integration", version: 1 },
  configuration: { mailbox: "me" },
  credentials: { oauth: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "gmail-oauth" } }
}
const classification = {
  categories: ["receipts"],
  labels: { receipts: "Label_receipts" },
  moves: { receipts: "Label_receipts" },
  notifications: { onMatch: true, onNoMatch: true }
}
const message = { threadId: "thread-1", historyId: "501", labelIds: ["INBOX"], from: "shop@example.com", subject: "Receipt 1", body: "Total €12", snippet: "Total €12" }
const withGmail = Effect.acquireRelease(startGmailStub(), (stub) => Effect.sync(() => stub.close()))
const withJev = Effect.acquireRelease(startJevStub(), (stub) => Effect.sync(() => stub.close()))

const setup = Effect.fn("GmailPollingTest.setup")(function*(gmailUrl: string, jevUrl: string) {
  const registry = new AutomationRegistry()
  const ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
  const configurations = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(ready))
  const credentials = CredentialRepositoryLayer.pipe(Layer.provideMerge(configurations))
  const live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(Layer.provideMerge(credentials))
  const context = yield* Layer.build(live)
  const services = {
    configurations: Context.get(context, ConfigurationRepository),
    credentials: Context.get(context, CredentialRepository),
    executions: Context.get(context, ExecutionRepository),
    sql: Context.get(context, SqlClient),
    http: Context.get(context, HttpClient.HttpClient)
  }
  const gmailOptions = { baseUrl: gmailUrl, timeoutMs: 2000, maxRetries: 0 }
  yield* registry.register(makeGmailConnectorExtension(gmailOptions, services).extension)
  const environment: AutomationWorkerEnvironment = {
    services,
    registry,
    routines: Context.get(context, RoutineService),
    decide: makeAutomationDecide(services.credentials, { endpoint: jevUrl, timeoutMs: 2000, maxRetries: 0 }),
    gmailOptions
  }
  yield* services.credentials.putCredential(scope, "gmail-oauth", new TextEncoder().encode("stub-gmail-token"), 0)
  yield* services.credentials.putCredential(scope, "zen-api-key", new TextEncoder().encode("stub-zen-key"), 0)
  const process = yield* buildGmailClassificationProcess("gmail", classification)
  yield* environment.routines.create(scope, { routineId: "inbox", template: gmailTemplateReference, configuration: classification, integrations: [integration], process })
  return environment
})

const pollStateLayer = (environment: AutomationWorkerEnvironment) => Layer.succeed(SqlClient, environment.services.sql)

describe("production Gmail receipt processing", () => {
  it.live("continues polling healthy integrations when another Gmail credential cannot resolve", () => Effect.gen(function*() {
    const gmail = yield* withGmail
    const jev = yield* withJev
    const environment = yield* setup(gmail.baseUrl, jev.url)
    yield* environment.services.credentials.putCredential(scope, "broken-oauth", new TextEncoder().encode("broken-token"), 0)
    const broken = { ...integration, id: "broken", credentials: { oauth: { ...integration.credentials.oauth, credentialId: "broken-oauth" } } }
    const process = yield* buildGmailClassificationProcess("broken", classification)
    yield* environment.routines.create(scope, { routineId: "broken-inbox", configuration: classification, integrations: [broken], process })
    const faulting: AutomationWorkerEnvironment = {
      ...environment,
      services: {
        ...environment.services,
        credentials: {
          ...environment.services.credentials,
          resolveSecret: (personalScope, id) => id === "broken-oauth"
            ? Effect.fail(new StorageError({ code: "storage", message: "Injected credential read failure" }))
            : environment.services.credentials.resolveSecret(personalScope, id)
        }
      }
    }
    gmail.setMessage("incoming-1", message)
    expect(yield* pollGmailOnce(faulting)).toBe(1)
    const runs = yield* environment.services.executions.listRuns(scope, { limit: 20 })
    expect(runs.items.map((record) => record.value.configuration.routineId)).toEqual(["inbox"])
    expect(yield* hasSeenMessage(scope, "broken", "incoming-1").pipe(Effect.provide(pollStateLayer(environment)))).toBe(false)
  }))

  it.live("discovers enabled mailboxes before any runs exist and classifies actual mail through the production starter", () => Effect.gen(function*() {
    const gmail = yield* withGmail
    const jev = yield* withJev
    jev.setReply(() => ({ status: 200, body: stubChoiceBody("receipts", { receipts: 1 }, 1) }))
    const environment = yield* setup(gmail.baseUrl, jev.url)
    const process = yield* buildGmailClassificationProcess("gmail", classification)
    yield* environment.routines.create(scope, { routineId: "paused-inbox", configuration: classification, integrations: [integration], process })
    yield* environment.routines.pause(scope, "paused-inbox", 1)
    expect((yield* environment.services.executions.listRuns(scope, { limit: 20 })).items).toHaveLength(0)
    gmail.setMessage("incoming-1", message)
    const fiber = yield* Effect.forkScoped(startAutomationProcessing(environment, DefaultAutomationWorkerOptions, { pollIntervalMs: 1000 }).pipe(
      Effect.provideService(HttpClient.HttpClient, environment.services.http)
    ))
    const completed = yield* environment.services.executions.listRuns(scope, { limit: 20 }).pipe(
      Effect.filterOrFail((page) => page.items.length === 1 && page.items[0]?.value.state.kind === "succeeded", () => "pending"),
      Effect.retry(Schedule.spaced("25 millis")),
      Effect.timeout("5 seconds")
    )
    expect(completed.items[0]?.value.configuration.routineId).toBe("inbox")
    expect(jev.calls).toHaveLength(1)
    expect(jev.calls[0]?.body).toMatchObject({ state: { messageId: "incoming-1", threadId: "thread-1", from: "shop@example.com", subject: "Receipt 1", body: "Total €12" } })
    expect(gmail.getMessageLabels("incoming-1")).toEqual(["Label_receipts"])
    expect(gmail.calls.filter((call) => call.method === "POST")).toHaveLength(1)
    yield* Fiber.interrupt(fiber)
    const callsAfterStop = gmail.calls.length
    yield* Effect.sleep("1100 millis")
    expect(gmail.calls).toHaveLength(callsAfterStop)
    yield* pollGmailOnce(environment)
    expect((yield* environment.services.executions.listRuns(scope, { limit: 20 })).items).toHaveLength(1)
    expect(gmail.calls.filter((call) => call.method === "POST")).toHaveLength(1)
  }))

  it.live("rolls back ingestion and acknowledgment together, then retries without losing or duplicating the receipt", () => Effect.gen(function*() {
    const gmail = yield* withGmail
    const jev = yield* withJev
    jev.setReply(() => ({ status: 200, body: stubChoiceBody("receipts", { receipts: 1 }, 1) }))
    const environment = yield* setup(gmail.baseUrl, jev.url)
    gmail.setMessage("incoming-1", message)
    let failures = 0
    const faulting: AutomationWorkerEnvironment = {
      ...environment,
      services: {
        ...environment.services,
        executions: {
          ...environment.services.executions,
          ingest: (input) => environment.services.executions.ingest(input).pipe(Effect.flatMap((accepted) => {
            if (failures++ === 0) return Effect.fail(new StorageError({ code: "storage", message: "Injected ingestion failure after insert" }))
            return Effect.succeed(accepted)
          }))
        }
      }
    }
    expect(yield* pollGmailOnce(faulting)).toBe(0)
    expect((yield* environment.services.executions.listRuns(scope, { limit: 20 })).items).toHaveLength(0)
    expect(yield* hasSeenMessage(scope, "gmail", "incoming-1").pipe(Effect.provide(pollStateLayer(environment)))).toBe(false)
    expect(yield* getPollHistoryId(scope, "gmail").pipe(Effect.provide(pollStateLayer(environment)))).toBeNull()
    expect(yield* pollGmailOnce(faulting)).toBe(1)
    const beforeRestart = yield* environment.services.executions.listRuns(scope, { limit: 20 })
    expect(beforeRestart.items).toHaveLength(1)
    yield* pollGmailOnce(environment)
    expect((yield* environment.services.executions.listRuns(scope, { limit: 20 })).items).toHaveLength(1)
    const run = beforeRestart.items[0]!
    expect(yield* processRun({ ...environment }, DefaultAutomationWorkerOptions, scope, run.value.id).pipe(
      Effect.provideService(HttpClient.HttpClient, environment.services.http)
    )).toBe("completed")
    expect(gmail.calls.filter((call) => call.method === "POST")).toHaveLength(1)
  }))

  it.live("fans a receipt out to enabled routines and runs an email action without a decision", () => Effect.gen(function*() {
    const gmail = yield* withGmail
    const jev = yield* withJev
    const environment = yield* setup(gmail.baseUrl, jev.url)
    const classified = yield* buildGmailClassificationProcess("gmail", classification)
    const process = { schemaVersion: classified.schemaVersion, kind: classified.kind, trigger: classified.trigger, actions: { triggered: classified.actions["receipts"]! } }
    yield* environment.routines.create(scope, { routineId: "always-organize", configuration: {}, integrations: [integration], process })
    gmail.setMessage("incoming-1", message)
    expect(yield* pollGmailOnce(environment)).toBe(1)
    const page = yield* environment.services.executions.listRuns(scope, { limit: 20 })
    expect(page.items).toHaveLength(2)
    const generic = page.items.find((record) => record.value.configuration.routineId === "always-organize")!
    expect(yield* processRun(environment, DefaultAutomationWorkerOptions, scope, generic.value.id).pipe(
      Effect.provideService(HttpClient.HttpClient, environment.services.http)
    )).toBe("completed")
    expect(jev.calls).toHaveLength(0)
    yield* environment.routines.pause(scope, "inbox", 1)
    const paused = page.items.find((record) => record.value.configuration.routineId === "inbox")!
    expect(yield* processRun(environment, DefaultAutomationWorkerOptions, scope, paused.value.id).pipe(
      Effect.provideService(HttpClient.HttpClient, environment.services.http)
    )).toBe("cancelled")
    expect(gmail.calls.filter((call) => call.method === "POST")).toHaveLength(1)
  }))
})
