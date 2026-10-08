import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { AutomationRegistry } from "../../automation/registry.js"
import {
  acknowledgeGmailPoll, checkGmailConnection, getPollHistoryId, hasSeenMessage, makeGmailConnectorExtension,
  organizeGmailMessage, pollGmailInbox, readGmailMessage
} from "../../automation/gmail-connector.js"
import type { GmailConnectorServices } from "../../automation/gmail-connector.js"
import { startGmailStub } from "../fixtures/automation-gmail-stub.js"
const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Configurations = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const WithCredentials = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configurations))
const Live = Layer.mergeAll(WithCredentials, NodeHttpClient.layerFetch)
const fakeToken = "stub-gmail-token-for-integration-only"
const secretBytes = new TextEncoder().encode(fakeToken)
const scope = { ownerId: "gmail-owner", projectId: "gmail-project" }
const integration = {
  schemaVersion: 1 as const, kind: "integration-configuration" as const, id: "gmail",
  definition: { id: "gmail:integration", version: 1 },
  configuration: { mailbox: "me" },
  credentials: { oauth: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "gmail-oauth" } }
}
const withStub = Effect.acquireRelease(startGmailStub(), (stub) => Effect.sync(() => stub.close()))
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const servicesFor = Effect.gen(function* () {
  const context = yield* Layer.build(Live)
  return {
    configurations: Context.get(context, ConfigurationRepository),
    credentials: Context.get(context, CredentialRepository),
    http: Context.get(context, HttpClient.HttpClient),
    sql: Context.get(context, SqlClient)
  } satisfies GmailConnectorServices
})
const providedFor = (services: GmailConnectorServices) => Layer.mergeAll(
  Layer.succeed(ConfigurationRepository, services.configurations),
  Layer.succeed(CredentialRepository, services.credentials),
  Layer.succeed(HttpClient.HttpClient, services.http),
  Layer.succeed(SqlClient, services.sql)
)
const seedWith = (services: GmailConnectorServices) => Effect.gen(function* () {
  yield* services.credentials.putCredential(scope, "gmail-oauth", secretBytes, 0)
  yield* services.configurations.putIntegration(scope, integration, 0)
})
const withServices = <A, E, R>(body: (services: GmailConnectorServices) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(servicesFor, (services) =>
    Effect.provide(providedFor(services))(body(services)))
describe("gmail connector integration", () => {
  it.live("polls new mail and applies labels with folder moves through credential references", () => withServices((services) => Effect.gen(function* () {
    const stub = yield* withStub
    yield* seedWith(services)
    stub.setHistoryId("500")
    stub.setMessage("msg-int-1", { threadId: "t-int-1", historyId: "501", labelIds: ["INBOX"], from: "shop@example.com", subject: "Receipt 1", body: "Total 1", snippet: "Total 1" })
    stub.setMessage("msg-int-2", { threadId: "t-int-2", historyId: "502", labelIds: ["INBOX"], from: "team@example.com", subject: "Action needed", body: "Please review", snippet: "Please" })
    const options = { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }
    const polled = yield* pollGmailInbox(scope, integration, options)
    expect(polled.fresh.map((entry) => entry.id).sort()).toEqual(["msg-int-1", "msg-int-2"])
    expect(polled.skippedSent).toBe(0)
    expect(encode(polled.fresh.map((entry) => entry.id))).not.toContain(fakeToken)
    expect(stub.calls.every((call) => call.authorization === `Bearer ${fakeToken}`)).toBe(true)
    const read = yield* readGmailMessage(scope, integration, "msg-int-1", options)
    expect(read.id).toBe("msg-int-1")
    expect(read.threadId).toBe("t-int-1")
    const organized = yield* organizeGmailMessage(scope, integration, "msg-int-1", "Label_receipts", "Label_receipts", options)
    expect(organized).toEqual({ applied: true, moved: true })
    expect(stub.getMessageLabels("msg-int-1")).toContain("Label_receipts")
    yield* acknowledgeGmailPoll(scope, "gmail", polled)
    const again = yield* pollGmailInbox(scope, integration, options)
    expect(again.fresh).toEqual([])
    expect(yield* hasSeenMessage(scope, "gmail", "msg-int-1")).toBe(true)
    expect(yield* getPollHistoryId(scope, "gmail")).not.toBeNull()
  })))
  it.live("registers the email template through the extension API and invokes organize", () => withServices((services) => Effect.gen(function* () {
    const connector = makeGmailConnectorExtension(undefined, services)
    const registry = new AutomationRegistry()
    yield* registry.register(connector.extension)
    const catalog = registry.catalog()
    expect(catalog.definitions.map((entry) => entry.definition.id).sort()).toContain("email:message-received")
    expect(catalog.definitions.map((entry) => entry.definition.id).sort()).toContain("email:organize-message")
    expect(catalog.definitions.map((entry) => entry.definition.id).sort()).toContain("gmail:email-classification")
    yield* seedWith(services)
    const stub = yield* withStub
    stub.setMessage("msg-reg", { threadId: "t-reg", historyId: "601", labelIds: ["INBOX"], from: "a@example.com", subject: "Hi", body: "Body", snippet: "Body" })
    const options = { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }
    const scoped = makeGmailConnectorExtension(options, services)
    const scopedRegistry = new AutomationRegistry()
    yield* scopedRegistry.register(scoped.extension)
    const routineConfiguration = {
      schemaVersion: 1, kind: "routine-configuration",
      reference: { routineId: "inbox", revision: 1 },
      scope, configuration: {},
      integrations: [integration],
      process: {
        schemaVersion: 1, kind: "process",
        trigger: {
          definition: { id: "email:message-received", version: 1 },
          integration: { id: "gmail", definition: { id: "gmail:integration", version: 1 } },
          configuration: {}
        },
        actions: {
          triggered: [{
            id: "organize-1",
            action: { id: "email:organize-message", version: 1 },
            integration: { id: "gmail", definition: { id: "gmail:integration", version: 1 } },
            bindings: {
              messageId: { kind: "field", source: "trigger", path: ["messageId"] },
              label: { kind: "literal", value: "Label_receipts" },
              moveTo: { kind: "literal", value: "Label_receipts" }
            }
          }]
        }
      }
    }
    const authority = {
      schemaVersion: 1, kind: "invocation-authority", scope,
      configuration: { routineId: "inbox", revision: 1 },
      integrationIds: ["gmail"],
      actionGrants: [{ action: { id: "email:organize-message", version: 1 }, integrationId: "gmail", capabilities: ["label", "move"] }]
    }
    const result = yield* scopedRegistry.invokeAction(
      { configuration: routineConfiguration, stepId: "organize-1", triggerPayload: { messageId: "msg-reg", threadId: "t-reg" }, mode: "live" },
      authority
    )
    expect(result).toEqual({ applied: true, moved: true })
    expect(stub.getMessageLabels("msg-reg")).toContain("Label_receipts")
    expect(encode(result)).not.toContain(fakeToken)
  })))
  it.live("checks connection without exposing secrets and keeps poll state durable", () => withServices((services) => Effect.gen(function* () {
    const stub = yield* withStub
    yield* seedWith(services)
    stub.setMessage("msg-conn", { threadId: "t-conn", historyId: "701", labelIds: ["INBOX"], from: "b@example.com", subject: "Ping", body: "Pong", snippet: "Pong" })
    const options = { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }
    const status = yield* checkGmailConnection(scope, integration, options)
    expect(status.ok).toBe(true)
    expect(status.configured).toBe(true)
    expect(status.mailbox).toBe("me")
    expect(encode(status)).not.toContain(fakeToken)
    expect(encode(status)).not.toContain("Ping")
    stub.setHistoryId("700")
    const first = yield* pollGmailInbox(scope, integration, options)
    expect(first.fresh.length).toBeGreaterThanOrEqual(1)
    const historyId = yield* getPollHistoryId(scope, "gmail")
    expect(typeof historyId === "string" || historyId === null).toBe(true)
  })))
})
